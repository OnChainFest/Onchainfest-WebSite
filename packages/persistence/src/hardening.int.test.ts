import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainErrorCode, newId } from '@br/domain';
import {
  createDevelopmentEvidenceCipher,
  createEphemeralSigner,
  detachedJwsHash,
  FilesystemEvidenceBlobStore,
  hashDescriptorDocument,
  jwsDetachedVerifier,
  verifyStoredProof,
} from '@br/evidence';
import {
  apiDb,
  declaredNoParticipation,
  maintenanceDb,
  newContestResult,
  newTestAccount,
  operatorDb,
  ownerDb,
  probeDb,
  registerSigningKey,
  seedTestCatalog,
  signPrepared,
  vaultDb,
  workerDb,
} from '@br/testkit';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { es256VectorKey, vectorKey } from '../../evidence/scripts/vectors';
import { AttestationStore } from './attestation-store';
import { AuthorityStore } from './authority-store';
import { CatalogStore } from './catalog-store';
import {
  CompetitionHierarchyResolver,
  createCompetitionResultLedger,
} from './competition-hierarchy';
import { CompetitionStore } from './competition-store';
import { StructureStore } from './competition-structure-store';
import type { Db } from './db';
import { AttestationPublicReader, EvidenceBundleService } from './evidence-reader';
import { EvidenceStore } from './evidence-store';
import { keyMaterialHash } from './hashing';
import { IdentityStore } from './identity-store';
import { PersonPrincipalService, PrincipalKeyCeremony } from './key-ceremony-store';
import { OrganizationStore } from './organization-store';
import { inTransaction, ModuleRole, type ModuleRole as Role } from './tx';

/** BRT-06R — final trust-boundary & cryptographic hardening proofs (PostgreSQL). */
const api = apiDb();
const owner = ownerDb();
const operator = operatorDb();
const maintenance = maintenanceDb();
const vault = vaultDb();
const worker = workerDb();
const probe = probeDb();
afterAll(async () => {
  await Promise.all(
    [api, owner, operator, maintenance, vault, worker, probe].map((d) => d.destroy()),
  );
});

const AUD = 'bragging-rights:test';
const identity = new IdentityStore(api);
const orgs = new OrganizationStore(api);
const authority = new AuthorityStore(api, { conflictChecker: declaredNoParticipation });
const ledger = createCompetitionResultLedger(api, { conflictChecker: declaredNoParticipation });
const blobStore = new FilesystemEvidenceBlobStore({
  root: mkdtempSync(join(tmpdir(), 'br-hardening-')),
  cipher: createDevelopmentEvidenceCipher({ ephemeral: true }),
});
const attestations = new AttestationStore(api, { audience: AUD });
const ceremony = new PrincipalKeyCeremony(api, { audience: AUD });
const persons = new PersonPrincipalService(api);
const bundles = new EvidenceBundleService(api);
const reader = new AttestationPublicReader(api);
const k = () => `k-${newId()}`;
const q = async <T = Record<string, unknown>>(text: string) =>
  (await sql.raw<T>(text).execute(owner)).rows;
const DENIED = { code: '42501' };
const asRole = (db: Db, role: Role, query: string) =>
  inTransaction(db, role, (ctx) => sql.raw(query).execute(ctx.trx));

let w: Awaited<ReturnType<typeof newContestResult>>;
let orgPrincipalId: string;

beforeAll(async () => {
  const catalog = await seedTestCatalog(identity, new CatalogStore(operator));
  w = await newContestResult({
    db: api,
    identity,
    orgs,
    comps: new CompetitionStore(api),
    structure: new StructureStore(api),
    authority,
    ledger,
    resolver: new CompetitionHierarchyResolver(api),
    catalog,
  });
  orgPrincipalId = (
    await q<{ principal_id: string }>(
      `SELECT principal_id FROM organizations.organization_principal WHERE organization_id = '${w.organizer.organizationId}'`,
    )
  )[0]!.principal_id;
});

// ───────────────────────────── §1 time semantics ─────────────────────────────

/** Simulates a database clock that stepped BACKWARDS between the receipt and the recording. */
class SteppedClockEvidenceStore extends EvidenceStore {
  observed?: Date;
  protected override async observeReceipt(): Promise<Date> {
    const real = await super.observeReceipt();
    this.observed = new Date(real.getTime() + 60 * 60 * 1000); // the receipt reading is 1 h "later"
    return this.observed;
  }
}

describe('§1 receipt time is stored verbatim; no ordering between two clock readings is assumed', () => {
  it('a backwards clock step cannot corrupt or backdate the evidence facts', async () => {
    const store = new SteppedClockEvidenceStore(api, { blobStore });
    const r = await store.ingest({
      actorAccountId: w.organizer.ownerAccountId,
      idempotencyKey: k(),
      bytes: new TextEncoder().encode('{"clock":"stepped"}'),
      mediaType: 'application/json',
      evidenceType: 'DOCUMENT',
      source: { kind: 'HUMAN' },
    });
    const [row] = await q<{
      received_at: Date;
      recorded_at: Date;
      descriptor: { acquisition: { receivedAt: string } };
      descriptor_hash: string;
    }>(
      `SELECT received_at, recorded_at, descriptor, descriptor_hash FROM evidence.item WHERE id = '${r.evidenceId}'`,
    );
    // exactly what was observed — never clamped, never rewritten
    expect(row!.received_at.toISOString()).toBe(store.observed!.toISOString());
    expect(row!.descriptor.acquisition.receivedAt).toBe(store.observed!.toISOString());
    expect(row!.recorded_at.getTime()).toBeLessThan(row!.received_at.getTime());
    expect(hashDescriptorDocument(row!.descriptor).descriptorHash).toBe(row!.descriptor_hash);
    // the availability/privacy facts use the recording transaction's clock only
    const [av] = await q<{ recorded_at: Date }>(
      `SELECT recorded_at FROM evidence.availability_change WHERE evidence_id = '${r.evidenceId}'`,
    );
    expect(av!.recorded_at.toISOString()).toBe(row!.recorded_at.toISOString());
  });

  it('attestation receipt/acceptance/recording are ONE reading (equality enforced by the database)', async () => {
    const rows = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid IN ('attestation.attestation'::regclass, 'attestation.retraction'::regclass)
        AND pg_get_constraintdef(oid) LIKE '%(received_at = issued_at) AND (issued_at = recorded_at)%'`,
    );
    expect(rows[0]?.n).toBe(2);
  });
});

// ───────────────────────────── §2 Person ↔ Principal ─────────────────────────────

describe('§2 Person ↔ PERSON Principal structural invariant', () => {
  it('20 concurrent ensure calls converge: one principal, one mapping, zero orphans', async () => {
    const a = await newTestAccount(identity, { label: 'pp' });
    const before = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM authority.principal WHERE label = 'person-principal'`,
    );
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        persons.ensure({ actorAccountId: a.accountId, personId: a.personId as string }),
      ),
    );
    expect(new Set(results.map((r) => r.principalId)).size).toBe(1);
    expect(
      await q(
        `SELECT count(*)::int AS n FROM identity.person_principal WHERE person_id = '${a.personId}'`,
      ),
    ).toEqual([{ n: 1 }]);
    const after = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM authority.principal WHERE label = 'person-principal'`,
    );
    expect(after[0]!.n - before[0]!.n).toBe(1);
    expect(
      await q(`SELECT count(*)::int AS n FROM authority.principal p WHERE p.label = 'person-principal'
               AND NOT EXISTS (SELECT 1 FROM identity.person_principal m WHERE m.principal_id = p.id)`),
    ).toEqual([{ n: 0 }]);
    expect(results[0]!.principalId).not.toBe(a.personId);
  });

  it('the database rejects PERSON→ORGANIZATION, shared principals, second principals and dangling ids', async () => {
    const a = await newTestAccount(identity, { label: 'pp2' });
    const b = await newTestAccount(identity, { label: 'pp3' });
    const pa = (
      await persons.ensure({ actorAccountId: a.accountId, personId: a.personId as string })
    ).principalId;
    const insert = (person: string, principal: string) =>
      sql`INSERT INTO identity.person_principal (person_id, principal_id, recorded_at) VALUES (${person}::uuid, ${principal}::uuid, platform.tx_time_ms())`.execute(
        owner,
      );
    await expect(insert(b.personId as string, orgPrincipalId)).rejects.toMatchObject({
      code: '23503',
    }); // not a PERSON principal
    await expect(insert(b.personId as string, pa)).rejects.toMatchObject({ code: '23505' }); // two people → one principal
    const spare = await authority.registerPrincipal({
      principalType: 'PERSON',
      label: 'spare person principal',
    });
    await expect(insert(a.personId as string, spare.id)).rejects.toMatchObject({ code: '23505' }); // one person → two principals
    await expect(insert(newId(), spare.id)).rejects.toMatchObject({ code: '23503' }); // no such person
    await expect(insert(b.personId as string, newId())).rejects.toMatchObject({ code: '23503' }); // no such principal
    for (const stmt of [
      `UPDATE identity.person_principal SET principal_id = '${spare.id}' WHERE person_id = '${a.personId}'`,
      `DELETE FROM identity.person_principal WHERE person_id = '${a.personId}'`,
    ])
      await expect(sql.raw(stmt).execute(owner)).rejects.toMatchObject({ code: 'BR001' });
  });

  it('br_identity has no direct authority writes; creation happens only through the narrow function', async () => {
    await expect(
      asRole(
        api,
        ModuleRole.identity,
        `INSERT INTO authority.principal (id, principal_type, label, fact_hash, recorded_at) VALUES ('${newId()}', 'PERSON', 'x', 'sha256:${'0'.repeat(64)}', now())`,
      ),
    ).rejects.toMatchObject(DENIED);
    await expect(
      asRole(
        api,
        ModuleRole.identity,
        `INSERT INTO identity.person_principal (person_id, principal_id, recorded_at) VALUES ('${newId()}', '${newId()}', now())`,
      ),
    ).rejects.toMatchObject(DENIED);
    // a mismatched account/person (or garbage) yields NULL — never a principal
    const a = await newTestAccount(identity, { label: 'pp4' });
    const other = await newTestAccount(identity, { label: 'pp5' });
    const r = await asRole(
      api,
      ModuleRole.identity,
      `SELECT identity.ensure_person_principal('${a.accountId}', '${other.personId}') AS p`,
    );
    expect((r.rows[0] as { p: unknown }).p).toBeNull();
  });
});

// ───────────────────────────── §3 SECURITY DEFINER inventory ─────────────────────────────

const INVENTORY = [
  {
    fn: 'results.resolve_result_version(uuid)',
    // BRT-08: br_achievements resolves exact basis versions (EXECUTE only).
    grantees: [
      'br_achievements',
      'br_evidence',
      'br_rebuild',
      'br_verification',
      'br_verification_reader',
    ],
    readOnly: true,
  },
  {
    fn: 'competition.resolve_scope_path(text, uuid)',
    grantees: [
      'br_achievements',
      'br_authority',
      'br_competition',
      'br_evidence',
      'br_rebuild',
      'br_results',
      'br_verification',
      'br_verification_reader',
    ],
    readOnly: true,
  },
  {
    fn: 'competition.account_competition_roles(uuid, uuid)',
    grantees: ['br_achievements', 'br_evidence', 'br_verification', 'br_verification_reader'],
    readOnly: true,
  },
  {
    fn: 'authority.account_principal_representation(uuid, uuid)',
    grantees: ['br_authority', 'br_evidence'],
    readOnly: true,
  },
  {
    fn: 'identity.ensure_person_principal(uuid, uuid)',
    grantees: ['br_identity'],
    readOnly: false,
  },
  { fn: 'evidence.assert_attachment_target()', grantees: [], readOnly: true },
  { fn: 'attestation.assert_attestation_binding()', grantees: [], readOnly: true },
] as const;

describe('§3 cross-module SECURITY DEFINER helpers are narrow', () => {
  it('owner, SECURITY DEFINER, fixed search_path and the EXACT EXECUTE grantees (never PUBLIC)', async () => {
    for (const f of INVENTORY) {
      const [p] = await q<{
        owner: string;
        secdef: boolean;
        config: string[];
        vol: string;
        src: string;
      }>(
        `SELECT pg_get_userbyid(proowner) AS owner, prosecdef AS secdef, proconfig AS config, provolatile AS vol, prosrc AS src
         FROM pg_proc WHERE oid = '${f.fn}'::regprocedure`,
      );
      expect(p, f.fn).toMatchObject({
        owner: 'br_owner',
        secdef: true,
        config: ['search_path=pg_catalog, pg_temp'],
      });
      const acl = await q<{ grantee: string }>(
        `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee
         FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
         WHERE p.oid = '${f.fn}'::regprocedure AND a.privilege_type = 'EXECUTE' ORDER BY 1`,
      );
      expect(
        acl.map((r) => r.grantee).filter((g) => g !== 'br_owner'),
        f.fn,
      ).toEqual([...f.grantees]);
      if (f.readOnly) {
        // STABLE functions cannot write; the VOLATILE representation helper takes locks only.
        const src = p!.src.replace(/--[^\n]*/g, '');
        expect(src, f.fn).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|EXECUTE|COPY)\b/i);
      }
    }
    const [rv] = await q<{ vol: string }>(
      `SELECT provolatile AS vol FROM pg_proc WHERE oid = 'results.resolve_result_version(uuid)'::regprocedure`,
    );
    const [sp] = await q<{ vol: string }>(
      `SELECT provolatile AS vol FROM pg_proc WHERE oid = 'competition.resolve_scope_path(text, uuid)'::regprocedure`,
    );
    expect([rv!.vol, sp!.vol]).toEqual(['s', 's']);
    // ensure_person_principal writes exactly its three bounded targets
    const [ens] = await q<{ src: string }>(
      `SELECT prosrc AS src FROM pg_proc WHERE oid = 'identity.ensure_person_principal(uuid, uuid)'::regprocedure`,
    );
    expect([...ens!.src.matchAll(/INSERT INTO ([a-z_.]+)/g)].map((m) => m[1]).sort()).toEqual([
      'authority.principal',
      'identity.person_principal',
      'platform.outbox_event',
    ]);
    expect(ens!.src).not.toMatch(/\b(UPDATE|DELETE|EXECUTE)\b/);
  });

  it('no BRT-06 function (definer or invoker) is executable by PUBLIC', async () => {
    const rows = await q<{ fn: string }>(`
      SELECT p.oid::regprocedure::text AS fn
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
           aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
        AND (n.nspname IN ('evidence', 'attestation', 'evidence_read')
             OR p.oid IN ('results.resolve_result_version(uuid)'::regprocedure,
                          'competition.account_competition_roles(uuid, uuid)'::regprocedure,
                          'authority.account_principal_representation(uuid, uuid)'::regprocedure,
                          'identity.ensure_person_principal(uuid, uuid)'::regprocedure))`);
    expect(rows).toEqual([]);
  });

  it('direct SQL per role: only the intended roles can call each helper', async () => {
    const u = () => `'${newId()}'::uuid`;
    const calls: Record<string, string> = {
      rv: `SELECT results.resolve_result_version(${u()})`,
      path: `SELECT competition.resolve_scope_path('CONTEST', ${u()})`,
      roles: `SELECT competition.account_competition_roles(${u()}, ${u()})`,
      repr: `SELECT authority.account_principal_representation(${u()}, ${u()})`,
      ensure: `SELECT identity.ensure_person_principal(${u()}, ${u()})`,
    };
    const allowed: [Db, Role, (keyof typeof calls)[]][] = [
      [api, ModuleRole.evidence, ['rv', 'path', 'roles', 'repr']],
      // BRT-07: the verification runtime resolves exact versions, hierarchy and staff roles only.
      [api, ModuleRole.verification, ['rv', 'path', 'roles']],
      [maintenance, ModuleRole.rebuild, ['rv', 'path']],
      [api, ModuleRole.authority, ['path', 'repr']],
      [api, ModuleRole.identity, ['ensure']],
      [api, ModuleRole.publicRead, []],
      [api, ModuleRole.organizations, []],
      [vault, ModuleRole.identityPrivate, []],
      [operator, ModuleRole.catalog, []],
      [worker, ModuleRole.worker, []],
    ];
    for (const [db, role, ok] of allowed) {
      for (const [name, stmt] of Object.entries(calls)) {
        const p = asRole(db, role, stmt);
        if (ok.includes(name)) await expect(p, `${role} ${name}`).resolves.toBeDefined();
        else await expect(p, `${role} ${name}`).rejects.toMatchObject(DENIED);
      }
    }
    for (const stmt of Object.values(calls))
      await expect(sql.raw(stmt).execute(probe)).rejects.toMatchObject(DENIED);
    // trigger functions cannot be invoked directly at all
    await expect(
      asRole(api, ModuleRole.evidence, 'SELECT evidence.assert_attachment_target()'),
    ).rejects.toBeDefined();
  });

  it('neither br_evidence nor br_rebuild can mutate canonical facts, with or without helpers', async () => {
    const x = `'${newId()}'`;
    for (const stmt of [
      `INSERT INTO results.result_status_transition (id) VALUES (${x})`,
      `INSERT INTO competition.contest_status_change (id) VALUES (${x})`,
      `INSERT INTO authority.principal_key (id) VALUES (${x})`,
      `INSERT INTO authority.authority_grant (id) VALUES (${x})`,
      `UPDATE competition.competition_profile SET name = 'x'`,
    ]) {
      await expect(asRole(api, ModuleRole.evidence, stmt), stmt).rejects.toMatchObject(DENIED);
      await expect(asRole(maintenance, ModuleRole.rebuild, stmt), stmt).rejects.toMatchObject(
        DENIED,
      );
    }
    for (const stmt of [
      `INSERT INTO evidence.item (id) VALUES (${x})`,
      `INSERT INTO attestation.attestation (id) VALUES (${x})`,
      `INSERT INTO evidence.availability_change (id) VALUES (${x})`,
    ])
      await expect(asRole(maintenance, ModuleRole.rebuild, stmt), stmt).rejects.toMatchObject(
        DENIED,
      );
  });
});

// ───────────────────────────── §5 fixture keys ─────────────────────────────

describe('§5 published fixture keys are blocked by RFC 7638 identity through the real ceremony', () => {
  it('equivalent representations are refused; a different key (with metadata) is accepted and stored minimal', async () => {
    for (const key of [vectorKey(), es256VectorKey()]) {
      const reordered = Object.fromEntries(Object.entries(key.publicJwk).reverse());
      for (const jwk of [
        key.publicJwk,
        reordered,
        { ...reordered, alg: key.alg, use: 'sig', kid: 'fixture' },
      ]) {
        await expect(
          ceremony.prepareKeyRegistration({
            actorAccountId: w.organizer.ownerAccountId,
            idempotencyKey: k(),
            principalId: orgPrincipalId,
            algorithm: key.alg,
            publicJwk: jwk,
          }),
        ).rejects.toMatchObject({ code: DomainErrorCode.INVALID_INPUT });
      }
    }
    const fresh = createEphemeralSigner('ES256');
    const withMeta = {
      ...fresh.publicJwk,
      alg: 'ES256',
      use: 'sig',
      key_ops: ['verify'],
      kid: 'client-label',
    };
    const prep = await ceremony.prepareKeyRegistration({
      actorAccountId: w.organizer.ownerAccountId,
      idempotencyKey: k(),
      principalId: orgPrincipalId,
      algorithm: 'ES256',
      publicJwk: withMeta,
    });
    const { keyId } = await ceremony.submitKeyRegistration({
      actorAccountId: w.organizer.ownerAccountId,
      idempotencyKey: k(),
      principalId: orgPrincipalId,
      ...signPrepared(fresh, prep),
    });
    const [row] = await q<{ verification_material: Record<string, string> }>(
      `SELECT verification_material FROM authority.principal_key WHERE id = '${keyId}'`,
    );
    expect(Object.keys(row!.verification_material).sort()).toEqual(['crv', 'kty', 'x', 'y']);
  });
});

// ───────────────────────────── §6 validity ≠ key trust ≠ authority ≠ verification ─────────────────────────────

describe('§6 cryptographic validity, key trust, authority and verification stay separate', () => {
  let attestationId: string;
  let keyId: string;
  let signer: ReturnType<typeof createEphemeralSigner>;

  it('valid signature + no AuthorityGrant → stored, authority NOT_EVALUATED, no Verification', async () => {
    signer = createEphemeralSigner('ES256');
    keyId = await registerSigningKey(ceremony, w.organizer.ownerAccountId, orgPrincipalId, signer);
    expect(
      await q(
        `SELECT count(*)::int AS n FROM authority.authority_grant WHERE grantee_principal_id = '${orgPrincipalId}'`,
      ),
    ).toEqual([{ n: 0 }]);
    const p = await attestations.prepare({
      actorAccountId: w.organizer.ownerAccountId,
      idempotencyKey: k(),
      issuerPrincipalId: orgPrincipalId,
      keyId,
      subject: { type: 'RESULT_VERSION', id: w.resultVersionId },
      claim: { type: 'RESULT_ACCURATE', polarity: 'AFFIRM' },
    });
    const r = await attestations.submit({
      actorAccountId: w.organizer.ownerAccountId,
      idempotencyKey: k(),
      ...signPrepared(signer, p),
    });
    attestationId = r.attestationId;
    expect(r).toMatchObject({
      signature: 'VALID',
      authority: 'NOT_EVALUATED',
      verification: 'EVALUATED_SEPARATELY',
    });
    // BRT-07: accepting an attestation never creates a verification (runs exist only when an
    // evaluation is explicitly requested, and only from assembled canonical snapshots).
    expect(
      await q(
        `SELECT count(*)::int AS n FROM verification.run WHERE result_version_id = '${w.resultVersionId}'`,
      ),
    ).toEqual([{ n: 0 }]);
  });

  it('key compromised afterwards → immutable facts, card never claims trust, bundle carries key history; new use refused', async () => {
    const [before] = await q(
      `SELECT statement, statement_hash, proof FROM attestation.attestation WHERE id = '${attestationId}'`,
    );
    await ceremony.changeKeyStatus({
      actorAccountId: w.organizer.ownerAccountId,
      principalId: orgPrincipalId,
      keyId,
      kind: 'COMPROMISED',
      compromisedSince: new Date(Date.now() - 3_600_000),
      idempotencyKey: k(),
    });
    expect(
      (
        await q(
          `SELECT statement, statement_hash, proof FROM attestation.attestation WHERE id = '${attestationId}'`,
        )
      )[0],
    ).toEqual(before);
    const card = await reader.attestation(attestationId);
    expect(card?.trust).toEqual({
      signature: 'VALID_AT_ACCEPTANCE',
      claim: 'ACTIVE',
      superseded: false,
      keyTrust: 'NOT_EVALUATED',
      authority: 'NOT_EVALUATED',
      sportingVerification: 'EVALUATED_SEPARATELY',
      verificationResource: expect.stringMatching(
        /^\/v1\/result-versions\/[0-9a-f-]{36}\/verification$/,
      ),
    });
    expect(JSON.stringify(card)).not.toMatch(/verified|trusted|TRUSTED|VERIFIED|NOT_IMPLEMENTED/);
    const bundle = await bundles.build({
      actor: { internal: true },
      resultVersionId: w.resultVersionId,
    });
    const key = (
      bundle.bundle as {
        keys: {
          keyId: string;
          statusChanges?: { kind: string; effectiveFrom: string; recordedAt: string }[];
        }[];
      }
    ).keys.find((x) => x.keyId === keyId);
    expect(key?.statusChanges?.map((s) => s.kind)).toEqual(['COMPROMISED']);
    expect(new Date(key!.statusChanges![0]!.effectiveFrom).getTime()).toBeLessThan(
      new Date(key!.statusChanges![0]!.recordedAt).getTime(),
    );
    await expect(
      attestations.prepare({
        actorAccountId: w.organizer.ownerAccountId,
        idempotencyKey: k(),
        issuerPrincipalId: orgPrincipalId,
        keyId,
        subject: { type: 'RESULT_VERSION', id: w.resultVersionId },
        claim: { type: 'RESULT_ACCURATE', polarity: 'AFFIRM' },
      }),
    ).rejects.toMatchObject({
      code: DomainErrorCode.KEY_NOT_VALID,
      details: { reason: 'KEY_COMPROMISED' },
    });
  });

  it('revoked between prepare and submit → the new attestation is rejected', async () => {
    const s = createEphemeralSigner();
    const kid = await registerSigningKey(ceremony, w.organizer.ownerAccountId, orgPrincipalId, s);
    const p = await attestations.prepare({
      actorAccountId: w.organizer.ownerAccountId,
      idempotencyKey: k(),
      issuerPrincipalId: orgPrincipalId,
      keyId: kid,
      subject: { type: 'RESULT_VERSION', id: w.resultVersionId },
      claim: { type: 'RESULT_ACCURATE', polarity: 'DENY' },
    });
    await ceremony.changeKeyStatus({
      actorAccountId: w.organizer.ownerAccountId,
      principalId: orgPrincipalId,
      keyId: kid,
      kind: 'REVOKED',
      idempotencyKey: k(),
    });
    await expect(
      attestations.submit({
        actorAccountId: w.organizer.ownerAccountId,
        idempotencyKey: k(),
        ...signPrepared(s, p),
      }),
    ).rejects.toMatchObject({
      code: DomainErrorCode.KEY_NOT_VALID,
      details: { reason: 'KEY_REVOKED' },
    });
  });
});

// ───────────────────────────── §7 bundle crypto handoff ─────────────────────────────

describe('§7 Evidence Bundle carries enough immutable material to re-verify, and no verdict', () => {
  it('proofHash / verifierId / verificationMaterialHash bind the stored proof and key; forbidden fields are absent', async () => {
    const bundle = await bundles.build({
      actor: { internal: true },
      resultVersionId: w.resultVersionId,
    });
    const doc = bundle.bundle as {
      resultVersion: {
        resultVersionId: string;
        contentHash: string;
        scope: { competitionId: string; contestId: string };
      };
      attestations: {
        attestationId: string;
        statementHash: string;
        issuer: { principalId: string; keyId: string };
        proof: { proofHash: string; verifierId: string; algorithm: string };
      }[];
      keys: { keyId: string; verificationMaterialHash: string; factHash: string }[];
    };
    expect(doc.resultVersion).toMatchObject({
      resultVersionId: w.resultVersionId,
      contentHash: w.contentHash,
      scope: { competitionId: w.competitionId, contestId: w.contestId },
    });
    expect(doc.attestations.length).toBeGreaterThan(0);
    for (const a of doc.attestations) {
      const [row] = await q<{
        proof: { protected: string; signature: string };
        verifier_id: string;
        key_id: string;
        statement_hash: string;
      }>(
        `SELECT proof, verifier_id, key_id, statement_hash FROM attestation.attestation WHERE id = '${a.attestationId}'`,
      );
      expect(a.proof.proofHash).toBe(detachedJwsHash(row!.proof));
      expect(a.proof.verifierId).toBe(row!.verifier_id);
      const [key] = await q<{
        id: string;
        key_kind: string;
        algorithm: string;
        verification_material: Record<string, string>;
      }>(
        `SELECT id, key_kind, algorithm, verification_material FROM authority.principal_key WHERE id = '${row!.key_id}'`,
      );
      const bk = doc.keys.find((x) => x.keyId === row!.key_id);
      expect(bk?.verificationMaterialHash).toBe(keyMaterialHash(key!.verification_material));
      // BRT-07 can re-verify from immutable stored facts that the bundle identifies exactly
      expect(
        verifyStoredProof(jwsDetachedVerifier, {
          statementHash: row!.statement_hash,
          key: {
            id: key!.id,
            keyKind: key!.key_kind,
            algorithm: key!.algorithm,
            verificationMaterial: key!.verification_material,
          },
          proof: row!.proof,
        }),
      ).toBe(true);
    }
    const names = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === 'object')
        for (const [key, val] of Object.entries(v)) {
          names.add(key);
          walk(val);
        }
    };
    walk(doc);
    for (const forbidden of [
      'level',
      'verificationLevel',
      'verdict',
      'verified',
      'authorized',
      'authorityDecision',
      'trustScore',
      'confidence',
      'score',
      'ranking',
      'rank',
      'achievement',
      'record',
      'prize',
      'displayName',
      'label',
    ])
      expect(names.has(forbidden), forbidden).toBe(false);
  });
});
