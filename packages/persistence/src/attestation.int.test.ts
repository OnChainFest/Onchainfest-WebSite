import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainErrorCode, newId, type Uuid } from '@br/domain';
import {
  createDevelopmentEvidenceCipher,
  createEphemeralSigner,
  FilesystemEvidenceBlobStore,
  hashStatement,
} from '@br/evidence';
import { SchemaRef } from '@br/schemas';
import {
  apiDb,
  declaredNoParticipation,
  maintenanceDb,
  newContestResult,
  newTestAccount,
  operatorDb,
  ownerDb,
  registerSigningKey,
  seedTestCatalog,
  signPrepared,
  sleep,
  uniqueSlug,
} from '@br/testkit';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AttestationStore } from './attestation-store';
import { AuthorityStore } from './authority-store';
import { CatalogStore } from './catalog-store';
import {
  authorizeInHierarchy,
  CompetitionHierarchyResolver,
  createCompetitionResultLedger,
} from './competition-hierarchy';
import { CompetitionStore } from './competition-store';
import { StructureStore } from './competition-structure-store';
import { rebuildEvidenceReadModels, snapshotEvidenceReadModels } from './evidence-projection';
import { AttestationPublicReader, EvidenceBundleService } from './evidence-reader';
import { EvidenceStore } from './evidence-store';
import { factHash } from './hashing';
import { IdentityStore } from './identity-store';
import { PersonPrincipalService, PrincipalKeyCeremony } from './key-ceremony-store';
import { OrganizationStore } from './organization-store';
import { inTransaction, ModuleRole } from './tx';

const api = apiDb();
const owner = ownerDb();
const operator = operatorDb();
const maintenance = maintenanceDb();
afterAll(async () => {
  await Promise.all([api, owner, operator, maintenance].map((d) => d.destroy()));
});

const AUD = 'bragging-rights:test';
const identity = new IdentityStore(api);
const orgs = new OrganizationStore(api);
const comps = new CompetitionStore(api);
const structure = new StructureStore(api);
const authority = new AuthorityStore(api, { conflictChecker: declaredNoParticipation });
const ledger = createCompetitionResultLedger(api, { conflictChecker: declaredNoParticipation });
const resolver = new CompetitionHierarchyResolver(api);
const evidence = new EvidenceStore(api, {
  blobStore: new FilesystemEvidenceBlobStore({
    root: mkdtempSync(join(tmpdir(), 'br-att-int-')),
    cipher: createDevelopmentEvidenceCipher({ ephemeral: true }),
  }),
});
const attestations = new AttestationStore(api, { audience: AUD });
const ceremony = new PrincipalKeyCeremony(api, { audience: AUD });
const persons = new PersonPrincipalService(api);
const bundles = new EvidenceBundleService(api);
const reader = new AttestationPublicReader(api);
const k = () => `k-${newId()}`;

let w: Awaited<ReturnType<typeof newContestResult>>;
let orgPrincipalId: string;
const orgSigner = createEphemeralSigner('EdDSA');
let orgKeyId: string;
let evidenceId: string;
const q = async <T = Record<string, unknown>>(text: string) =>
  (await sql.raw<T>(text).execute(owner)).rows;

beforeAll(async () => {
  const catalog = await seedTestCatalog(identity, new CatalogStore(operator));
  w = await newContestResult({
    db: api,
    identity,
    orgs,
    comps,
    structure,
    authority,
    ledger,
    resolver,
    catalog,
  });
  orgPrincipalId = (
    await q<{ principal_id: string }>(
      `SELECT principal_id FROM organizations.organization_principal WHERE organization_id = '${w.organizer.organizationId}'`,
    )
  )[0]!.principal_id;
  orgKeyId = await registerSigningKey(
    ceremony,
    w.organizer.ownerAccountId,
    orgPrincipalId,
    orgSigner,
  );
  evidenceId = (
    await evidence.ingest({
      actorAccountId: w.organizer.ownerAccountId,
      idempotencyKey: k(),
      bytes: new TextEncoder().encode('{"scoresheet":"fictional 6-4 6-3"}'),
      mediaType: 'application/json',
      evidenceType: 'SIGNED_SCORESHEET',
      source: { kind: 'ORGANIZATION', principalId: orgPrincipalId as Uuid },
      attachTo: { targetType: 'RESULT_VERSION', targetId: w.resultVersionId, role: 'PRIMARY' },
    })
  ).evidenceId;
});

const prepareOrg = (
  over: Partial<Parameters<AttestationStore['prepare']>[0]> = {},
  store = attestations,
) =>
  store.prepare({
    actorAccountId: w.organizer.ownerAccountId,
    idempotencyKey: k(),
    issuerPrincipalId: orgPrincipalId,
    keyId: orgKeyId,
    subject: { type: 'RESULT_VERSION', id: w.resultVersionId },
    claim: { type: 'RESULT_ACCURATE', polarity: 'AFFIRM' },
    evidenceIds: [evidenceId],
    ...over,
  });
const submitOrg = (
  p: { challengeId: string; statementHash: string; signing: { kid: string } },
  signer = orgSigner,
  store = attestations,
) =>
  store.submit({
    actorAccountId: w.organizer.ownerAccountId,
    idempotencyKey: k(),
    ...signPrepared(signer, p),
  });

describe('Person ↔ PERSON Principal mapping (narrow SECURITY DEFINER creation)', () => {
  it('SELF only, stable, idempotent, typed PERSON, hash equals the TypeScript canonical fact hash', async () => {
    const a = w.athletes[0]!;
    const first = await persons.ensure({ actorAccountId: a.accountId, personId: a.personId });
    const again = await persons.ensure({ actorAccountId: a.accountId, personId: a.personId });
    expect(again.principalId).toBe(first.principalId);
    expect(first.principalId).not.toBe(a.personId);
    const [p] = await q<{ principal_type: string; label: string; fact_hash: string }>(
      `SELECT principal_type, label, fact_hash FROM authority.principal WHERE id = '${first.principalId}'`,
    );
    expect(p!.principal_type).toBe('PERSON');
    expect(p!.fact_hash).toBe(
      factHash(SchemaRef.principal, {
        principalId: first.principalId,
        principalType: 'PERSON',
        label: p!.label,
      }),
    );
    await expect(
      persons.ensure({ actorAccountId: w.athletes[1]!.accountId, personId: a.personId }),
    ).rejects.toMatchObject({ code: DomainErrorCode.FORBIDDEN });
    await expect(
      sql`DELETE FROM identity.person_principal WHERE person_id = ${a.personId}`.execute(owner),
    ).rejects.toMatchObject({ code: 'BR001' });
  });

  it('a guardian (even ACTIVE) cannot create or register keys for a dependent’s signing principal', async () => {
    const guardian = await newTestAccount(identity, { label: 'guardian' });
    const dep = await identity.createPerson({
      actorAccountId: guardian.accountId,
      relation: 'DEPENDENT',
      relationshipKind: 'PARENT',
      idempotencyKey: k(),
    });
    const op = await newTestAccount(identity, { withPerson: false, label: 'op' });
    await identity.confirmGuardianRelationship({
      operatorAccountId: op.accountId,
      guardianRelationshipId: dep.guardianRelationshipId as string,
      basis: 'PLATFORM_REVIEW',
    });
    await expect(
      persons.ensure({ actorAccountId: guardian.accountId, personId: dep.personId }),
    ).rejects.toMatchObject({ code: DomainErrorCode.FORBIDDEN });
    // the guardian may only register a key for their OWN person principal
    const own = await persons.ensure({
      actorAccountId: guardian.accountId,
      personId: guardian.personId as string,
    });
    await expect(
      registerSigningKey(ceremony, guardian.accountId, orgPrincipalId, createEphemeralSigner()),
    ).rejects.toMatchObject({ code: DomainErrorCode.ISSUER_NOT_CONTROLLED });
    expect(
      await registerSigningKey(
        ceremony,
        guardian.accountId,
        own.principalId,
        createEphemeralSigner(),
      ),
    ).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('public-key registration ceremony (proof of possession, public keys only)', () => {
  it('refuses non-representatives, private members, wrong-key proofs and replays', async () => {
    const stranger = await newTestAccount(identity);
    const signer = createEphemeralSigner();
    await expect(
      registerSigningKey(ceremony, stranger.accountId, orgPrincipalId, signer),
    ).rejects.toMatchObject({ code: DomainErrorCode.ISSUER_NOT_CONTROLLED });
    await expect(
      ceremony.prepareKeyRegistration({
        actorAccountId: w.organizer.ownerAccountId,
        idempotencyKey: k(),
        principalId: orgPrincipalId,
        algorithm: 'EdDSA',
        publicJwk: { ...signer.publicJwk, d: 'A'.repeat(43) },
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.INVALID_INPUT });
    const prepared = await ceremony.prepareKeyRegistration({
      actorAccountId: w.organizer.ownerAccountId,
      idempotencyKey: k(),
      principalId: orgPrincipalId,
      algorithm: 'EdDSA',
      publicJwk: signer.publicJwk,
    });
    const wrong = signPrepared(createEphemeralSigner(), prepared);
    await expect(
      ceremony.submitKeyRegistration({
        actorAccountId: w.organizer.ownerAccountId,
        idempotencyKey: k(),
        principalId: orgPrincipalId,
        ...wrong,
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.ATTESTATION_PROOF_INVALID });
    await expect(
      ceremony.submitKeyRegistration({
        actorAccountId: w.organizer.ownerAccountId,
        idempotencyKey: k(),
        principalId: orgPrincipalId,
        ...signPrepared(signer, prepared),
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.ATTESTATION_CHALLENGE_USED });
    // a key registered to one principal cannot be registered to another (no key substitution)
    const a = w.athletes[1]!;
    const pp = await persons.ensure({ actorAccountId: a.accountId, personId: a.personId });
    await expect(
      registerSigningKey(ceremony, a.accountId, pp.principalId, orgSigner),
    ).rejects.toMatchObject({ code: DomainErrorCode.INVALID_INPUT });
    // the registered key row holds public material only
    const [row] = await q<{ verification_material: Record<string, string> }>(
      `SELECT verification_material FROM authority.principal_key WHERE id = '${orgKeyId}'`,
    );
    expect(Object.keys(row!.verification_material).sort()).toEqual(['crv', 'kty', 'x']);
  });
});

describe('attestation ceremony: exact statement, single-use challenge, production proof', () => {
  it('stores an immutable signed claim that pins the exact ResultVersion and evidence hashes', async () => {
    const statusBefore = await q(
      `SELECT * FROM results.result_version_state WHERE result_id = '${w.resultId}' ORDER BY result_version_id`,
    );
    const transitions = await q(`SELECT count(*)::int AS n FROM results.result_status_transition`);
    const contestants = await q(`SELECT * FROM competition.contestant ORDER BY id`);
    const cards = await q(
      `SELECT * FROM competition_read.contest_card WHERE event_id = '${w.eventId}' ORDER BY contest_id`,
    );
    const p = await prepareOrg();
    expect(p.statement.subject).toEqual({
      type: 'RESULT_VERSION',
      id: w.resultVersionId,
      hash: w.contentHash,
    });
    expect(p.statement.audience).toBe(AUD);
    expect(p.signing.signingInput).toBe(
      `${p.signing.protected}.bragging-rights/sig/v1:${p.statementHash.slice(7)}`,
    );
    const r = await submitOrg(p);
    expect(r).toMatchObject({
      signature: 'VALID',
      authority: 'NOT_EVALUATED',
      verification: 'EVALUATED_SEPARATELY',
      created: true,
    });
    const [row] = await q<{
      statement: unknown;
      statement_hash: string;
      subject_id: string;
      issued_at: Date;
    }>(`SELECT * FROM attestation.attestation WHERE id = '${r.attestationId}'`);
    expect(hashStatement('attestation', row!.statement).statementHash).toBe(row!.statement_hash);
    expect(row!.subject_id).toBe(w.resultVersionId);
    const detail = await attestations.detail(w.organizer.ownerAccountId, r.attestationId);
    expect(detail.trust).toMatchObject({
      signature: 'VALID',
      claim: 'ACTIVE',
      authority: 'NOT_EVALUATED',
      sportingVerification: 'EVALUATED_SEPARATELY',
    });
    // no lifecycle movement, no verification / achievement / record / prize anything
    expect(
      await q(
        `SELECT * FROM results.result_version_state WHERE result_id = '${w.resultId}' ORDER BY result_version_id`,
      ),
    ).toEqual(statusBefore);
    expect(await q(`SELECT count(*)::int AS n FROM results.result_status_transition`)).toEqual(
      transitions,
    );
    expect(
      await q(
        // BRT-08 / BRT-09: achievement and record tables now exist; an attestation still derives no
        // Achievement and no RecordMark (and no prize table exists).
        `SELECT ((SELECT count(*) FROM information_schema.tables WHERE table_name ~ 'prize') + (SELECT count(*) FROM verification.run WHERE result_version_id = '${w.resultVersionId}') + (SELECT count(*) FROM achievement.basis_item WHERE result_version_id = '${w.resultVersionId}') + (SELECT count(*) FROM record.record_mark WHERE result_version_id = '${w.resultVersionId}'))::int AS n`,
      ),
    ).toEqual([{ n: 0 }]);
    expect(
      await q(
        // BRT-08 rule administration events are not consequences; an attestation derives nothing.
        `SELECT count(*)::int AS n FROM platform.outbox_event WHERE event_type ~ '(Verified|AchievementDerived|AchievementCurrentStateChanged|RecordMark|CurrentRecordChanged|Prize)'`,
      ),
    ).toEqual([{ n: 0 }]);
    // no dependency resolution (WINNER_OF…) and no bracket change: contestants and cards identical
    expect(await q(`SELECT * FROM competition.contestant ORDER BY id`)).toEqual(contestants);
    expect(
      await q(
        `SELECT * FROM competition_read.contest_card WHERE event_id = '${w.eventId}' ORDER BY contest_id`,
      ),
    ).toEqual(cards);
    const card = await reader.attestation(r.attestationId);
    expect(card).toMatchObject({
      kind: 'CRYPTOGRAPHICALLY_SIGNED_CLAIM',
      trust: {
        signature: 'VALID_AT_ACCEPTANCE',
        authority: 'NOT_EVALUATED',
        sportingVerification: 'EVALUATED_SEPARATELY',
        verificationResource: `/v1/result-versions/${w.resultVersionId}/verification`,
      },
      evidence: { count: 1, available: 1 },
    });
    expect(JSON.stringify(card)).not.toMatch(/verified result|"VERIFIED"/i);
    expect(JSON.stringify(card)).not.toMatch(/NOT_IMPLEMENTED|highestSatisfiedLevel|"V[0-4]"/);
  });

  it('replay, tampering, cross-challenge reuse, wrong audience and expiry all fail closed', async () => {
    const p = await prepareOrg();
    const good = signPrepared(orgSigner, p);
    // tampered echo of the statement (subject changed) → rejected and the challenge is burnt
    await expect(
      attestations.submit({
        actorAccountId: w.organizer.ownerAccountId,
        idempotencyKey: k(),
        ...good,
        statement: { ...p.statement, claim: { type: 'RESULT_ACCURATE', polarity: 'DENY' } },
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.ATTESTATION_PROOF_INVALID });
    await expect(
      attestations.submit({
        actorAccountId: w.organizer.ownerAccountId,
        idempotencyKey: k(),
        ...good,
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.ATTESTATION_CHALLENGE_USED });
    // a valid signature for statement A cannot be used for statement B
    const a = await prepareOrg();
    const b = await prepareOrg({ claim: { type: 'RESULT_ACCURATE', polarity: 'DENY' } });
    await expect(
      attestations.submit({
        actorAccountId: w.organizer.ownerAccountId,
        idempotencyKey: k(),
        challengeId: b.challengeId,
        proof: signPrepared(orgSigner, a).proof,
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.ATTESTATION_PROOF_INVALID });
    // statementHash mismatch / wrong key / malformed signature
    const c = await prepareOrg();
    await expect(
      attestations.submit({
        actorAccountId: w.organizer.ownerAccountId,
        idempotencyKey: k(),
        ...signPrepared(orgSigner, c),
        statementHash: a.statementHash,
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.ATTESTATION_PROOF_INVALID });
    const d = await prepareOrg();
    await expect(submitOrg(d, createEphemeralSigner())).rejects.toMatchObject({
      code: DomainErrorCode.ATTESTATION_PROOF_INVALID,
    });
    // wrong audience: prepared for another environment, submitted here
    const other = new AttestationStore(api, { audience: 'bragging-rights:staging' });
    const e = await prepareOrg({}, other);
    await expect(submitOrg(e)).rejects.toMatchObject({
      code: DomainErrorCode.ATTESTATION_PROOF_INVALID,
    });
    // another account cannot submit someone else's challenge
    const f = await prepareOrg();
    await expect(
      attestations.submit({
        actorAccountId: w.athletes[0]!.accountId,
        idempotencyKey: k(),
        ...signPrepared(orgSigner, f),
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.CHALLENGE_INVALID });
    // expired challenge (no clock slack)
    const quick = new AttestationStore(api, { audience: AUD, challengeTtlMs: 5 });
    const g = await prepareOrg({}, quick);
    await sleep(30);
    await expect(submitOrg(g, orgSigner, quick)).rejects.toMatchObject({
      code: DomainErrorCode.ATTESTATION_CHALLENGE_EXPIRED,
    });
    const rejected = await q<{ reason_code: string }>(
      `SELECT reason_code FROM attestation.challenge_consumption WHERE challenge_id IN ('${p.challengeId}', '${b.challengeId}', '${e.challengeId}', '${g.challengeId}') ORDER BY reason_code`,
    );
    expect(rejected.map((r) => r.reason_code)).toEqual([
      'EXPIRED',
      'PROOF_INVALID',
      'STATEMENT_MISMATCH',
      'WRONG_AUDIENCE',
    ]);
  });

  it('issuer representation ≠ account; unknown / foreign / revoked / compromised keys are refused', async () => {
    const stranger = await newTestAccount(identity);
    await expect(
      attestations.prepare({
        actorAccountId: stranger.accountId,
        idempotencyKey: k(),
        issuerPrincipalId: orgPrincipalId,
        keyId: orgKeyId,
        subject: { type: 'RESULT_VERSION', id: w.resultVersionId },
        claim: { type: 'RESULT_ACCURATE', polarity: 'AFFIRM' },
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.ISSUER_NOT_CONTROLLED });
    await expect(prepareOrg({ keyId: newId() })).rejects.toMatchObject({
      code: DomainErrorCode.KEY_NOT_VALID,
      details: { reason: 'KEY_UNKNOWN' },
    });
    const a = w.athletes[0]!;
    const personPrincipal = (
      await persons.ensure({ actorAccountId: a.accountId, personId: a.personId })
    ).principalId;
    const personSigner = createEphemeralSigner('ES256');
    const personKey = await registerSigningKey(
      ceremony,
      a.accountId,
      personPrincipal,
      personSigner,
    );
    await expect(prepareOrg({ keyId: personKey })).rejects.toMatchObject({
      code: DomainErrorCode.KEY_NOT_VALID,
      details: { reason: 'KEY_NOT_OWNED' },
    });
    // key revoked between prepare and submit: the signer's earlier signedAt cannot resurrect it
    const signer = createEphemeralSigner();
    const keyId = await registerSigningKey(
      ceremony,
      w.organizer.ownerAccountId,
      orgPrincipalId,
      signer,
    );
    const p = await prepareOrg({ keyId });
    await ceremony.changeKeyStatus({
      actorAccountId: w.organizer.ownerAccountId,
      principalId: orgPrincipalId,
      keyId,
      kind: 'REVOKED',
      idempotencyKey: k(),
    });
    await expect(submitOrg(p, signer)).rejects.toMatchObject({
      code: DomainErrorCode.KEY_NOT_VALID,
      details: { reason: 'KEY_REVOKED' },
    });
    await expect(prepareOrg({ keyId })).rejects.toMatchObject({
      code: DomainErrorCode.KEY_NOT_VALID,
    });
    const s2 = createEphemeralSigner();
    const k2 = await registerSigningKey(ceremony, w.organizer.ownerAccountId, orgPrincipalId, s2);
    await ceremony.changeKeyStatus({
      actorAccountId: w.organizer.ownerAccountId,
      principalId: orgPrincipalId,
      keyId: k2,
      kind: 'COMPROMISED',
      compromisedSince: new Date(Date.now() - 60_000),
      idempotencyKey: k(),
    });
    await expect(prepareOrg({ keyId: k2 })).rejects.toMatchObject({
      code: DomainErrorCode.KEY_NOT_VALID,
      details: { reason: 'KEY_COMPROMISED' },
    });
    // a person signs as themselves (athlete, no grant at all) — stored, AUTHORITY_UNASSESSED
    const pp = await attestations.prepare({
      actorAccountId: a.accountId,
      idempotencyKey: k(),
      issuerPrincipalId: personPrincipal,
      keyId: personKey,
      subject: { type: 'RESULT_VERSION', id: w.resultVersionId },
      claim: {
        type: 'RESULT_ACCURATE',
        polarity: 'DENY',
        payload: { reasonCode: 'SCORE_INCORRECT' },
      },
      authorityContext: { actingRole: 'PARTICIPANT' },
    });
    const r = await attestations.submit({
      actorAccountId: a.accountId,
      idempotencyKey: k(),
      ...signPrepared(personSigner, pp),
    });
    expect(r.authority).toBe('NOT_EVALUATED');
    expect((await reader.attestation(r.attestationId))?.issuer).toEqual({
      type: 'INDIVIDUAL',
      label: 'Individual signer',
    });
  });

  it('conflicting attestations coexist; retraction is signed, append-only and ≠ false; supersession pins versions', async () => {
    const affirm = await submitOrg(await prepareOrg());
    const [before] = await q(
      `SELECT * FROM attestation.attestation WHERE id = '${affirm.attestationId}'`,
    );
    const stranger = await newTestAccount(identity);
    await expect(
      attestations.prepareRetraction({
        actorAccountId: stranger.accountId,
        idempotencyKey: k(),
        attestationId: affirm.attestationId,
        keyId: orgKeyId,
        reasonCode: 'WITHDRAWN',
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.ISSUER_NOT_CONTROLLED });
    const rp = await attestations.prepareRetraction({
      actorAccountId: w.organizer.ownerAccountId,
      idempotencyKey: k(),
      attestationId: affirm.attestationId,
      keyId: orgKeyId,
      reasonCode: 'ISSUER_ERROR',
    });
    expect(rp.statement.subject).toEqual({
      type: 'ATTESTATION',
      id: affirm.attestationId,
      hash: affirm.statementHash,
    });
    const ret = await attestations.submitRetraction({
      actorAccountId: w.organizer.ownerAccountId,
      idempotencyKey: k(),
      ...signPrepared(orgSigner, rp),
    });
    expect(ret.created).toBe(true);
    expect(
      (await q(`SELECT * FROM attestation.attestation WHERE id = '${affirm.attestationId}'`))[0],
    ).toEqual(before);
    expect((await reader.attestation(affirm.attestationId))?.trust.claim).toBe('RETRACTED');
    await expect(
      attestations.prepareRetraction({
        actorAccountId: w.organizer.ownerAccountId,
        idempotencyKey: k(),
        attestationId: affirm.attestationId,
        keyId: orgKeyId,
        reasonCode: 'WITHDRAWN',
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.INVALID_TRANSITION });
    // correction: the issuer attests a NEW version and supersedes its earlier claim; v1 stays v1
    const v2 = await w.submitNextVersion();
    const corrected = await submitOrg(
      await prepareOrg({
        subject: { type: 'RESULT_VERSION', id: v2.resultVersionId },
        supersedesAttestationId: affirm.attestationId,
        evidenceIds: [],
      }),
    );
    expect(
      (
        await q<{ subject_id: string }>(
          `SELECT subject_id FROM attestation.attestation WHERE id = '${affirm.attestationId}'`,
        )
      )[0]!.subject_id,
    ).toBe(w.resultVersionId);
    expect((await reader.attestation(affirm.attestationId))?.trust.superseded).toBe(true);
    expect((await reader.attestation(corrected.attestationId))?.supersedesAttestationId).toBe(
      affirm.attestationId,
    );
    for (const stmt of [
      `UPDATE attestation.attestation SET polarity = 'DENY' WHERE id = '${affirm.attestationId}'`,
      `DELETE FROM attestation.retraction`,
      `TRUNCATE attestation.attestation CASCADE`,
      `DELETE FROM attestation.challenge_consumption`,
    ]) {
      await expect(sql.raw(stmt).execute(owner), stmt).rejects.toMatchObject({ code: 'BR001' });
    }
  });

  it('organization representation and FEDERATION org_type manufacture no sporting authority', async () => {
    const fedOwner = await newTestAccount(identity, { label: 'fed' });
    const fed = await orgs.createOrganization({
      actorAccountId: fedOwner.accountId,
      orgType: 'FEDERATION',
      slug: uniqueSlug('fed'),
      profile: { displayName: 'Fictional Federation' },
      idempotencyKey: k(),
    });
    const fedSigner = createEphemeralSigner();
    const fedKey = await registerSigningKey(
      ceremony,
      fedOwner.accountId,
      fed.principalId,
      fedSigner,
    );
    const p = await attestations.prepare({
      actorAccountId: fedOwner.accountId,
      idempotencyKey: k(),
      issuerPrincipalId: fed.principalId,
      keyId: fedKey,
      subject: { type: 'RESULT_VERSION', id: w.resultVersionId },
      claim: {
        type: 'CONDITIONS_COMPLIANT',
        polarity: 'AFFIRM',
        payload: {
          conditions: [{ aspect: 'SURFACE', key: 'court.surface', code: 'ARTIFICIAL_GRASS' }],
        },
      },
      authorityContext: {
        actingRole: 'SANCTIONING_BODY',
        scopeRef: { level: 'COMPETITION', id: w.competitionId },
      },
    });
    await attestations.submit({
      actorAccountId: fedOwner.accountId,
      idempotencyKey: k(),
      ...signPrepared(fedSigner, p),
    });
    for (const principalId of [fed.principalId, orgPrincipalId]) {
      expect(
        await q(
          `SELECT count(*)::int AS n FROM authority.authority_grant WHERE grantee_principal_id = '${principalId}'`,
        ),
      ).toEqual([{ n: 0 }]);
      expect(
        await q(
          `SELECT count(*)::int AS n FROM authority.trust_anchor WHERE principal_id = '${principalId}'`,
        ),
      ).toEqual([{ n: 0 }]);
      const decision = await inTransaction(api, ModuleRole.authority, (ctx) =>
        authorizeInHierarchy(
          ctx,
          {
            principalId: principalId as Uuid,
            capability: 'ATTEST_RESULT',
            target: { level: 'CONTEST', id: w.contestId },
            recognitionLevel: 'PLATFORM',
            atTime: ctx.txTime,
            asOf: ctx.txTime,
          },
          declaredNoParticipation,
        ),
      );
      expect(decision.authorized).toBe(false);
    }
    // scopeRef must lie in the subject's hierarchy
    await expect(
      attestations.prepare({
        actorAccountId: fedOwner.accountId,
        idempotencyKey: k(),
        issuerPrincipalId: fed.principalId,
        keyId: fedKey,
        subject: { type: 'RESULT_VERSION', id: w.resultVersionId },
        claim: { type: 'RESULT_ACCURATE', polarity: 'AFFIRM' },
        authorityContext: {
          actingRole: 'OFFICIAL',
          scopeRef: { level: 'COMPETITION', id: newId() },
        },
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.INVALID_INPUT });
  });

  it('a later compromise never rewrites history; the bundle carries the key facts for BRT-07', async () => {
    const signer = createEphemeralSigner();
    const keyId = await registerSigningKey(
      ceremony,
      w.organizer.ownerAccountId,
      orgPrincipalId,
      signer,
    );
    const r = await submitOrg(await prepareOrg({ keyId }), signer);
    const [before] = await q(
      `SELECT * FROM attestation.attestation WHERE id = '${r.attestationId}'`,
    );
    const beforeBundle = await bundles.build({
      actor: { internal: true },
      resultVersionId: w.resultVersionId,
    });
    await ceremony.changeKeyStatus({
      actorAccountId: w.organizer.ownerAccountId,
      principalId: orgPrincipalId,
      keyId,
      kind: 'COMPROMISED',
      compromisedSince: new Date(Date.now() - 3_600_000),
      idempotencyKey: k(),
    });
    expect(
      (await q(`SELECT * FROM attestation.attestation WHERE id = '${r.attestationId}'`))[0],
    ).toEqual(before);
    const now = await bundles.build({
      actor: { internal: true },
      resultVersionId: w.resultVersionId,
    });
    const then = await bundles.build({
      actor: { internal: true },
      resultVersionId: w.resultVersionId,
      asOf: new Date(beforeBundle.asOf),
    });
    expect(then.bundleHash).toBe(beforeBundle.bundleHash); // as known then
    expect(now.bundleHash).not.toBe(beforeBundle.bundleHash); // as known now
    const key = (
      now.bundle as { keys: { keyId: string; statusChanges?: { kind: string }[] }[] }
    ).keys.find((x) => x.keyId === keyId);
    expect(key?.statusChanges?.map((s) => s.kind)).toEqual(['COMPROMISED']);
    expect(
      (await attestations.detail(w.organizer.ownerAccountId, r.attestationId)).trust.signature,
    ).toBe('VALID');
  });
});

describe('Evidence Bundle and read-model rebuild', () => {
  it('is reproducible, access-controlled, as-of aware and changes with one logical fact', async () => {
    const a = await bundles.build({
      actor: { accountId: w.organizer.ownerAccountId },
      resultVersionId: w.resultVersionId,
    });
    const b = await bundles.build({
      actor: { internal: true },
      resultVersionId: w.resultVersionId,
      asOf: new Date(a.asOf),
    });
    expect(b.canonicalText).toBe(a.canonicalText);
    expect(a.canonicalText).not.toMatch(/"(verdict|verificationLevel|verified|trustScore|V[0-4])"/);
    await expect(
      bundles.build({
        actor: { accountId: w.athletes[0]!.accountId },
        resultVersionId: w.resultVersionId,
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.NOT_FOUND });
    await expect(
      bundles.build({
        actor: { internal: true },
        resultVersionId: w.resultVersionId,
        asOf: new Date(Date.now() + 3_600_000),
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.INVALID_INPUT });

    const snapshot = await snapshotEvidenceReadModels(api);
    const rebuilt = await rebuildEvidenceReadModels(maintenance);
    expect(rebuilt.attestations).toBeGreaterThan(0);
    expect(await snapshotEvidenceReadModels(api)).toEqual(snapshot);
    const c = await bundles.build({
      actor: { internal: true },
      resultVersionId: w.resultVersionId,
      asOf: new Date(a.asOf),
    });
    expect(c.bundleHash).toBe(a.bundleHash);

    await evidence.ingest({
      actorAccountId: w.organizer.ownerAccountId,
      idempotencyKey: k(),
      bytes: new TextEncoder().encode('{"photo":"fictional"}'),
      mediaType: 'application/json',
      evidenceType: 'IMAGE',
      source: { kind: 'HUMAN' },
      attachTo: { targetType: 'RESULT_VERSION', targetId: w.resultVersionId, role: 'SUPPORTING' },
    });
    const d = await bundles.build({
      actor: { internal: true },
      resultVersionId: w.resultVersionId,
    });
    expect(d.bundleHash).not.toBe(a.bundleHash);
    expect(
      (
        await bundles.build({
          actor: { internal: true },
          resultVersionId: w.resultVersionId,
          asOf: new Date(a.asOf),
        })
      ).bundleHash,
    ).toBe(a.bundleHash);
  });
});

describe('concurrency on challenges and retractions', () => {
  it('20 concurrent submissions of one valid challenge → exactly one accepted attestation', async () => {
    const p = await prepareOrg();
    const signed = signPrepared(orgSigner, p);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        attestations.submit({
          actorAccountId: w.organizer.ownerAccountId,
          idempotencyKey: k(),
          ...signed,
        }),
      ),
    );
    const ok = outcomes.filter((o) => o.status === 'fulfilled');
    const codes = outcomes.flatMap((o) =>
      o.status === 'rejected' ? [(o.reason as { code?: string }).code] : [],
    );
    expect(ok).toHaveLength(1);
    expect(new Set(codes)).toEqual(new Set([DomainErrorCode.ATTESTATION_CHALLENGE_USED]));
    expect(
      await q(
        `SELECT count(*)::int AS n FROM attestation.attestation WHERE challenge_id = '${p.challengeId}'`,
      ),
    ).toEqual([{ n: 1 }]);
  });

  it('20 concurrent retractions → one logical retraction', async () => {
    const target = await submitOrg(await prepareOrg());
    const prepared = await Promise.all(
      Array.from({ length: 20 }, () =>
        attestations.prepareRetraction({
          actorAccountId: w.organizer.ownerAccountId,
          idempotencyKey: k(),
          attestationId: target.attestationId,
          keyId: orgKeyId,
          reasonCode: 'WITHDRAWN',
        }),
      ),
    );
    const results = await Promise.all(
      prepared.map((p) =>
        attestations.submitRetraction({
          actorAccountId: w.organizer.ownerAccountId,
          idempotencyKey: k(),
          ...signPrepared(orgSigner, p),
        }),
      ),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.retractionId)).size).toBe(1);
    expect(
      await q(
        `SELECT count(*)::int AS n FROM attestation.retraction WHERE attestation_id = '${target.attestationId}'`,
      ),
    ).toEqual([{ n: 1 }]);
  });
});
