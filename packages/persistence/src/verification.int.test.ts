import { newId, type Uuid } from '@br/domain';
import {
  assembleSnapshot,
  evaluateVerification,
  ParticipationIndex,
  REFERENCE_POLICY_SPEC,
  type TraceCriterion,
} from '@br/verification';
import { referenceCases } from '@br/verification/fixtures';
import {
  apiDb,
  awaitDbTimePast,
  declaredNoParticipation,
  maintenanceDb,
  newAthlete,
  newContestResult,
  newOrganizer,
  operatorDb,
  ownerDb,
  personSigner,
  principalSigner,
  publishPolicy,
  retryOnClockStep,
  seedTestCatalog,
  verificationOperatorDb,
  type TestCatalog,
} from '@br/testkit';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AttestationStore } from './attestation-store';
import { AuthorityStore } from './authority-store';
import { CatalogStore } from './catalog-store';
import {
  CompetitionHierarchyResolver,
  createCompetitionResultLedger,
} from './competition-hierarchy';
import { CompetitionStore } from './competition-store';
import { StructureStore } from './competition-structure-store';
import { resolveResultVersion } from './evidence-support';
import { IdentityStore } from './identity-store';
import { PrincipalKeyCeremony } from './key-ceremony-store';
import { OrganizationStore } from './organization-store';
import { inTransaction, ModuleRole } from './tx';
import { loadRawVerificationFacts, resolveApplicablePolicy } from './verification-loader';
import {
  rebuildVerificationReadModels,
  snapshotVerificationReadModels,
} from './verification-projection';
import {
  VerificationPolicyStore,
  VerificationService,
  type VerificationRunView,
} from './verification-store';

const AUD = 'bragging-rights:test';
const db = apiDb();
const opDb = operatorDb();
const vopDb = verificationOperatorDb();
const maint = maintenanceDb();
const owner = ownerDb();
afterAll(async () => {
  await Promise.all([db, opDb, vopDb, maint, owner].map((d) => d.destroy()));
});

const identity = new IdentityStore(db);
const orgs = new OrganizationStore(db);
const comps = new CompetitionStore(db);
const structure = new StructureStore(db);
const authority = new AuthorityStore(db, { conflictChecker: declaredNoParticipation });
const ledger = createCompetitionResultLedger(db, { conflictChecker: declaredNoParticipation });
const resolver = new CompetitionHierarchyResolver(db);
const attestations = new AttestationStore(db, { audience: AUD });
const ceremony = new PrincipalKeyCeremony(db, { audience: AUD });
const policies = new VerificationPolicyStore(vopDb);
const verification = new VerificationService(db);
const INTERNAL = { internal: true } as const;
const AFFIRM = { type: 'RESULT_ACCURATE', polarity: 'AFFIRM' } as const;
const DENY = {
  type: 'RESULT_ACCURATE',
  polarity: 'DENY',
  payload: { reasonCode: 'SCORE_INCORRECT' },
} as const;

let catalog: TestCatalog;
beforeAll(async () => {
  catalog = await seedTestCatalog(identity, new CatalogStore(opDb));
  await publishPolicy(policies, catalog.operatorAccountId, catalog.tennisSingles);
});

async function world(submitAs: 'ATHLETE_A' | 'REFEREE' = 'ATHLETE_A') {
  const w = await newContestResult({
    db,
    identity,
    orgs,
    comps,
    structure,
    authority,
    ledger,
    resolver,
    catalog,
    submitAs,
  });
  const [a, b] = w.athletes;
  if (a === undefined || b === undefined) throw new Error('athletes');
  const A = await personSigner({ db, ceremony, attestations }, a);
  const B = await personSigner({ db, ceremony, attestations }, b);
  return { ...w, A, B };
}

async function run(resultVersionId: string): Promise<VerificationRunView> {
  const r = await verification.evaluate({ actor: INTERNAL, resultVersionId });
  if (r.kind !== 'RUN') throw new Error(`no run: ${r.reason}`);
  return r.run;
}

async function traceOf(runId: string): Promise<readonly TraceCriterion[]> {
  return (await verification.runDetail(INTERNAL, runId)).trace.criteria;
}

/**
 * A non-participating person holding a real ATTEST_RESULT grant (platform anchor) — optionally for
 * another competition. Sporting AUTHORITY only: this never makes the person a REGISTERED official.
 */
async function official(
  competitionId: string,
  platformPrincipalId: string,
  opts: { grant?: boolean } = {},
) {
  const person = await newAthlete(identity, 'official', 'Fictional Official');
  const signer = await personSigner({ db, ceremony, attestations }, person);
  let grantId: string | undefined;
  if (opts.grant !== false) {
    const g = await authority.issueGrant({
      actorPrincipalId: platformPrincipalId as Uuid,
      grantorPrincipalId: platformPrincipalId as Uuid,
      granteePrincipalId: signer.principalId as Uuid,
      capabilities: ['ATTEST_RESULT'],
      scope: { recognitionLevel: ['PLATFORM'], competition: [competitionId as Uuid] },
      delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
    });
    grantId = g.grant.id;
  }
  return { ...signer, grantId };
}

/** Authority decisions recorded for one principal by the V2 OFFICIAL_DECLARATION criterion. */
async function officialAuthority(runId: string, principalId: string) {
  const c = (await traceOf(runId)).find((x) => x.kind === 'OFFICIAL_DECLARATION')!;
  return (c.authority ?? []).filter((a) => a.principalId === principalId);
}

async function issuedAt(attestationId: string): Promise<Date> {
  const { rows } = await sql<{
    t: Date;
  }>`SELECT issued_at AS t FROM attestation.attestation WHERE id = ${attestationId}`.execute(owner);
  return rows[0]!.t;
}

describe('V0 CLAIMED / V1 CORROBORATED from real canonical facts', () => {
  it('a submitted, hash-bound claim is V0; the submitter (any key) never corroborates itself', async () => {
    const w = await world();
    const r0 = await run(w.resultVersionId);
    expect(r0).toMatchObject({
      evaluationState: 'EVALUATED',
      highestSatisfiedLevel: 'V0',
      label: 'Claimed',
      created: true,
    });
    await w.A.attest(w.resultVersionId, AFFIRM);
    const A2 = await w.A.addKey();
    await w.A.attest(w.resultVersionId, AFFIRM, A2);
    const r1 = await run(w.resultVersionId);
    expect(r1.highestSatisfiedLevel).toBe('V0');
    const v1 = (await traceOf(r1.runId)).find((c) => c.kind === 'INDEPENDENT_CORROBORATION')!;
    expect(v1).toMatchObject({ status: 'FAIL', observed: 0 });
    expect(v1.issuerGroups).toEqual([
      expect.objectContaining({ principalId: w.A.principalId, classification: 'SUBMITTER_SELF' }),
    ]);
    expect(v1.issuerGroups![0]!.attestationIds).toHaveLength(2);
  });

  it('the opponent (a different participant side) corroborates → V1; two keys of one principal count once', async () => {
    const w = await world();
    const B2 = await w.B.addKey();
    await w.B.attest(w.resultVersionId, AFFIRM);
    await w.B.attest(w.resultVersionId, AFFIRM, B2);
    const r = await run(w.resultVersionId);
    expect(r).toMatchObject({ highestSatisfiedLevel: 'V1', label: 'Corroborated' });
    const v1 = (await traceOf(r.runId)).find((c) => c.kind === 'INDEPENDENT_CORROBORATION')!;
    expect(v1).toMatchObject({ status: 'PASS', observed: 1, required: 1 });
    expect(v1.issuerGroups).toEqual([
      expect.objectContaining({ principalId: w.B.principalId, classification: 'COUNTERPARTY' }),
    ]);
    expect(v1.issuerGroups![0]!.attestationIds).toHaveLength(2);
    expect(v1.participation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ principalId: w.B.principalId, relation: 'SELF_PARTICIPANT' }),
      ]),
    );
  });

  it('V2 is blocked honestly: the RESULT_OFFICIAL / T5 producers do not exist (INPUT_NOT_SUPPORTED, never inferred)', async () => {
    const w = await world();
    await w.B.attest(w.resultVersionId, AFFIRM);
    const r = await run(w.resultVersionId);
    expect(r.highestSatisfiedLevel).toBe('V1');
    const v2 = r.outcome.levels.find((l) => l.level === 'V2')!;
    expect(v2.status).toBe('BLOCKED');
    const official = v2.criteria!.find((c) => c.kind === 'OFFICIAL_DECLARATION')!;
    expect(official.status).toBe('INPUT_NOT_SUPPORTED');
    expect(official.reasons).toEqual(
      expect.arrayContaining([
        'NOT_SUPPORTED_RESULT_OFFICIAL_ATTESTATION',
        'NOT_SUPPORTED_T5_OFFICIAL_TRANSITION',
      ]),
    );
    expect(v2.criteria!.find((c) => c.kind === 'NO_INVALIDATING_ASSESSMENT')!.status).toBe(
      'INPUT_NOT_SUPPORTED',
    );
    expect(r.public.next).toMatchObject({ level: 'V2', label: 'Event Certified' });
    expect(['V3', 'V4'].map((l) => r.outcome.levels.find((x) => x.level === l)!.status)).toEqual([
      'NOT_REACHED',
      'NOT_REACHED',
    ]);
  });

  it('an ATTEST_RESULT grant is not a registered official: the official V1 path is reported unavailable', async () => {
    const w = await world('REFEREE');
    const o = await official(w.competitionId, w.platformPrincipalId);
    await w.B.attest(w.resultVersionId, AFFIRM);
    const beforeOfficial = await run(w.resultVersionId);
    // B is a participant, but the unmapped submitter's side is unknown → cannot prove independence.
    expect(beforeOfficial.highestSatisfiedLevel).toBe('V0');
    const g = (await traceOf(beforeOfficial.runId)).find(
      (c) => c.kind === 'INDEPENDENT_CORROBORATION',
    )!;
    expect(g.status).toBe('UNKNOWN');
    expect(g.issuerGroups![0]!.classification).toBe('SUBMITTER_SIDE_UNKNOWN');
    await o.attest(w.resultVersionId, AFFIRM);
    const r = await run(w.resultVersionId);
    expect(r.highestSatisfiedLevel).toBe('V0');
    const t = (await traceOf(r.runId)).find((c) => c.kind === 'INDEPENDENT_CORROBORATION')!;
    expect(t.reasons).toEqual(
      expect.arrayContaining(['COUNTERPARTY_PATH_EVALUATED', 'NOT_SUPPORTED_REGISTERED_OFFICIAL']),
    );
    expect(t.issuerGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          principalId: o.principalId,
          classification: 'NO_STANDING',
          reasons: ['NOT_SUPPORTED_REGISTERED_OFFICIAL'],
        }),
      ]),
    );
    // V1 consults no authority at all; the grant is only visible to the (unsupported) V2 criterion.
    expect(t.authority ?? []).toEqual([]);
    expect(await officialAuthority(r.runId, o.principalId)).toEqual([
      expect.objectContaining({
        capability: 'ATTEST_RESULT',
        authorized: true,
        recognitionLevel: 'PLATFORM',
        conflictCheck: 'CLEAR',
      }),
    ]);
    const v2 = r.outcome.levels.find((l) => l.level === 'V2')!;
    expect(v2.criteria!.find((c) => c.kind === 'OFFICIAL_DECLARATION')!.status).toBe(
      'INPUT_NOT_SUPPORTED',
    );
  });

  it('counterparty corroboration keeps V1 reachable next to an unavailable official path', async () => {
    const w = await world();
    const o = await official(w.competitionId, w.platformPrincipalId);
    await o.attest(w.resultVersionId, AFFIRM);
    await w.B.attest(w.resultVersionId, AFFIRM);
    const r = await run(w.resultVersionId);
    expect(r.highestSatisfiedLevel).toBe('V1');
    const t = (await traceOf(r.runId)).find((c) => c.kind === 'INDEPENDENT_CORROBORATION')!;
    expect(t).toMatchObject({ status: 'PASS', observed: 1 });
    expect(t.reasons).toContain('NOT_SUPPORTED_REGISTERED_OFFICIAL');
  });
});

describe('authority is temporal, hierarchical and never manufactured by roles', () => {
  it('a grant recorded AFTER the attestation never authorizes it (no back-authorization)', async () => {
    const w = await world('REFEREE');
    const o = await official(w.competitionId, w.platformPrincipalId, { grant: false });
    await o.attest(w.resultVersionId, AFFIRM);
    await authority.issueGrant({
      actorPrincipalId: w.platformPrincipalId as Uuid,
      grantorPrincipalId: w.platformPrincipalId as Uuid,
      granteePrincipalId: o.principalId as Uuid,
      capabilities: ['ATTEST_RESULT'],
      scope: { recognitionLevel: ['PLATFORM'], competition: [w.competitionId as Uuid] },
      delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
    });
    const r = await run(w.resultVersionId);
    expect(r.highestSatisfiedLevel).toBe('V0');
    const decisions = await officialAuthority(r.runId, o.principalId);
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.every((a) => !a.authorized)).toBe(true);
    expect(decisions.some((a) => a.reason === 'GRANT_NOT_VALID_AT_TIME')).toBe(true);
  });

  it('a sibling-competition grant never crosses the boundary', async () => {
    const w = await world('REFEREE');
    const other = await world('REFEREE');
    const o = await official(other.competitionId, w.platformPrincipalId);
    await o.attest(w.resultVersionId, AFFIRM);
    const r = await run(w.resultVersionId);
    expect(r.highestSatisfiedLevel).toBe('V0');
    const decisions = await officialAuthority(r.runId, o.principalId);
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.every((a) => !a.authorized)).toBe(true);
    expect(decisions.some((a) => a.reason === 'SCOPE_NOT_COVERED')).toBe(true);
  });

  it('organizer admins, competition staff and FEDERATION organizations hold no sporting authority', async () => {
    const organizer = await newOrganizer(identity, orgs);
    const fed = await newOrganizer(identity, orgs);
    const fedOrg = await orgs.createOrganization({
      actorAccountId: fed.ownerAccountId,
      orgType: 'FEDERATION',
      slug: `fed-${newId().slice(-8)}`,
      profile: { displayName: 'Fictional Federation' },
      idempotencyKey: `fed-${newId()}`,
    });
    const w = await newContestResult({
      db,
      identity,
      orgs,
      comps,
      structure,
      authority,
      ledger,
      resolver,
      catalog,
      organizer,
      submitAs: 'ATHLETE_A',
    });
    const admin = await personSigner(
      { db, ceremony, attestations },
      { accountId: organizer.ownerAccountId, personId: organizer.ownerPersonId },
    );
    const federation = await principalSigner(
      { ceremony, attestations },
      { accountId: fed.ownerAccountId, principalId: fedOrg.principalId },
    );
    await admin.attest(w.resultVersionId, AFFIRM);
    await federation.attest(w.resultVersionId, AFFIRM);
    const r = await run(w.resultVersionId);
    expect(r.highestSatisfiedLevel).toBe('V0');
    const t = (await traceOf(r.runId)).find((c) => c.kind === 'INDEPENDENT_CORROBORATION')!;
    expect(t.issuerGroups!.map((g) => g.classification).sort()).toEqual([
      'NO_STANDING',
      'NO_STANDING',
    ]);
    expect(t.participation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          principalId: admin.principalId,
          relation: 'ORGANIZER_ORGANIZATION_ADMIN',
        }),
      ]),
    );
  });

  it('a participant holding ATTEST_RESULT is conflicted: it counts only as a participant (A-5)', async () => {
    const w = await world('REFEREE');
    await authority.issueGrant({
      actorPrincipalId: w.platformPrincipalId as Uuid,
      grantorPrincipalId: w.platformPrincipalId as Uuid,
      granteePrincipalId: w.B.principalId as Uuid,
      capabilities: ['ATTEST_RESULT'],
      scope: { recognitionLevel: ['PLATFORM'], competition: [w.competitionId as Uuid] },
      delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
    });
    await w.B.attest(w.resultVersionId, AFFIRM);
    const r = await run(w.resultVersionId);
    // Submitter (unmapped referee) side unknown → B cannot be proven independent; B's grant is ignored.
    expect(r.highestSatisfiedLevel).toBe('V0');
    const t = (await traceOf(r.runId)).find((c) => c.kind === 'INDEPENDENT_CORROBORATION')!;
    expect(t.issuerGroups![0]!.classification).toBe('SUBMITTER_SIDE_UNKNOWN');
  });
});

describe('freshness, disputes, retraction, key compromise, revocation, policy change', () => {
  it('a dispute claim stales the run; re-evaluation drops to V0; retracting the dispute recovers V1', async () => {
    const w = await world();
    await w.B.attest(w.resultVersionId, AFFIRM);
    const r1 = await run(w.resultVersionId);
    expect((await verification.publicCurrent(w.resultVersionId)).freshness).toBe('CURRENT');
    const d = await w.B.attest(w.resultVersionId, DENY);
    const stale = await verification.publicCurrent(w.resultVersionId);
    expect(stale).toMatchObject({
      freshness: 'STALE',
      reEvaluationRequired: true,
      lastEvaluated: { level: 'V1' },
    });
    expect(stale.level).toBeUndefined();
    const r2 = await run(w.resultVersionId);
    expect(r2.highestSatisfiedLevel).toBe('V0');
    expect(r2.public.activeDispute).toBe(true);
    await w.B.retract(d);
    const r3 = await run(w.resultVersionId);
    expect(r3.highestSatisfiedLevel).toBe('V1');
    // History is immutable.
    const again = await verification.runDetail(INTERNAL, r1.runId);
    expect(again).toMatchObject({
      highestSatisfiedLevel: 'V1',
      snapshotHash: r1.snapshotHash,
      outcomeHash: r1.outcomeHash,
      freshness: 'STALE',
    });
    expect(
      (await verification.history(INTERNAL, w.resultVersionId)).runs.map((x) => x.runId),
    ).toEqual([r3.runId, r2.runId, r1.runId]);
  });

  it('retroactive key compromise stales the run and removes the support; the old run is untouched', async () => {
    const w = await world();
    const att = await w.B.attest(w.resultVersionId, AFFIRM);
    const r1 = await run(w.resultVersionId);
    await ceremony.changeKeyStatus({
      actorAccountId: w.B.accountId,
      principalId: w.B.principalId,
      keyId: w.B.key.keyId,
      kind: 'COMPROMISED',
      compromisedSince: await issuedAt(att),
      idempotencyKey: `kc-${newId()}`,
    });
    expect((await verification.publicCurrent(w.resultVersionId)).freshness).toBe('STALE');
    const r2 = await run(w.resultVersionId);
    expect(r2.highestSatisfiedLevel).toBe('V0');
    expect(r2.outcome.flags).toContain('SUSPECT_ATTESTER');
    const detail = await verification.runDetail(INTERNAL, r2.runId);
    expect(detail.trace.signedFacts).toEqual([
      expect.objectContaining({
        attestationId: att,
        keyTrust: 'SUSPECT',
        keyReason: 'KEY_COMPROMISED',
        counts: false,
      }),
    ]);
    const old = await verification.runDetail(INTERNAL, r1.runId);
    expect(old).toMatchObject({
      highestSatisfiedLevel: 'V1',
      snapshotHash: r1.snapshotHash,
      traceHash: r1.traceHash,
    });
    // As known then: a historical evaluation before the compromise was recorded still sees V1.
    await awaitDbTimePast(owner, r1.evaluatedAsOf);
    const then = await verification.evaluateAsOf({
      actor: INTERNAL,
      resultVersionId: w.resultVersionId,
      asOf: new Date(r1.evaluatedAsOf),
    });
    expect(then).toMatchObject({
      kind: 'HISTORICAL',
      persisted: false,
      highestSatisfiedLevel: 'V1',
      matchingRunId: r1.runId,
      snapshotHash: r1.snapshotHash,
    });
  });

  it('ordinary grant revocation is prospective; compromise revocation is retroactive (both stale, history kept)', async () => {
    const w = await world('REFEREE');
    const o = await official(w.competitionId, w.platformPrincipalId);
    // (Authority is read by the V2 OFFICIAL_DECLARATION criterion; V1 needs none.)
    const att = await o.attest(w.resultVersionId, AFFIRM);
    const r1 = await run(w.resultVersionId);
    expect((await officialAuthority(r1.runId, o.principalId))[0]).toMatchObject({
      authorized: true,
    });
    await authority.revokeGrant({
      grantId: o.grantId as Uuid,
      actorPrincipalId: w.platformPrincipalId as Uuid,
      reason: 'role ended',
    });
    const r2 = await run(w.resultVersionId);
    expect(r2.snapshotHash).not.toBe(r1.snapshotHash);
    // the attestation predates the (prospective) revocation
    expect((await officialAuthority(r2.runId, o.principalId))[0]).toMatchObject({
      authorized: true,
    });
    const w2 = await world('REFEREE');
    const o2 = await official(w2.competitionId, w2.platformPrincipalId);
    const att2 = await o2.attest(w2.resultVersionId, AFFIRM);
    const before = await run(w2.resultVersionId);
    expect((await officialAuthority(before.runId, o2.principalId))[0]).toMatchObject({
      authorized: true,
    });
    await authority.revokeGrant({
      grantId: o2.grantId as Uuid,
      actorPrincipalId: w2.platformPrincipalId as Uuid,
      reason: 'fraud',
      compromise: true,
      effectiveFrom: await issuedAt(att2),
    });
    const r3 = await run(w2.resultVersionId);
    expect(r3.snapshotHash).not.toBe(before.snapshotHash);
    const revoked = await officialAuthority(r3.runId, o2.principalId);
    expect(revoked.every((a) => !a.authorized)).toBe(true);
    expect(revoked.some((a) => a.reason === 'GRANT_REVOKED')).toBe(true);
    void att;
  });

  it('a new policy binding stales runs of the previous policy; both runs stay queryable', async () => {
    const cat = await seedTestCatalog(identity, new CatalogStore(opDb));
    await publishPolicy(policies, cat.operatorAccountId, cat.tennisSingles);
    const w0 = await newContestResult({
      db,
      identity,
      orgs,
      comps,
      structure,
      authority,
      ledger,
      resolver,
      catalog: cat,
      submitAs: 'ATHLETE_A',
    });
    const B = await personSigner({ db, ceremony, attestations }, w0.athletes[1]!);
    await B.attest(w0.resultVersionId, AFFIRM);
    const r1 = await run(w0.resultVersionId);
    const strict = {
      ...REFERENCE_POLICY_SPEC,
      levels: REFERENCE_POLICY_SPEC.levels.map((l) =>
        l.level === 'V1'
          ? {
              ...l,
              criteria: l.criteria.map((c) =>
                c.kind === 'INDEPENDENT_CORROBORATION' ? { ...c, params: { minIssuers: 2 } } : c,
              ),
            }
          : l,
      ),
    };
    const p2 = await publishPolicy(policies, cat.operatorAccountId, cat.tennisSingles, strict);
    expect((await verification.publicCurrent(w0.resultVersionId)).freshness).toBe('STALE');
    const r2 = await run(w0.resultVersionId);
    expect(r2.policy.policyVersionId).toBe(p2.policyVersionId);
    expect(r2.highestSatisfiedLevel).toBe('V0'); // stricter policy: 1 of 2 independent issuers
    expect((await verification.runDetail(INTERNAL, r1.runId)).highestSatisfiedLevel).toBe('V1');
  });
});

describe('policy fail-closed, determinism, concurrency, integrity, time consistency', () => {
  it('no applicable published policy → POLICY_UNAVAILABLE (no fallback, no run)', async () => {
    const cat = await seedTestCatalog(identity, new CatalogStore(opDb));
    const w0 = await newContestResult({
      db,
      identity,
      orgs,
      comps,
      structure,
      authority,
      ledger,
      resolver,
      catalog: cat,
    });
    const r = await verification.evaluate({ actor: INTERNAL, resultVersionId: w0.resultVersionId });
    expect(r).toEqual({
      kind: 'POLICY_UNAVAILABLE',
      evaluationState: 'POLICY_UNAVAILABLE',
      reason: 'NO_BINDING',
    });
    const { rows } = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM verification.run WHERE result_version_id = ${w0.resultVersionId}`.execute(
      owner,
    );
    expect(rows[0]!.n).toBe(0);
    expect((await verification.publicCurrent(w0.resultVersionId)).evaluationState).toBe(
      'POLICY_UNAVAILABLE',
    );
  });

  it('20 concurrent identical evaluations → one logical run; re-evaluation with unchanged facts is a no-op', async () => {
    const w = await world();
    await w.B.attest(w.resultVersionId, AFFIRM);
    const runs = await Promise.all(Array.from({ length: 20 }, () => run(w.resultVersionId)));
    expect(new Set(runs.map((r) => r.runId)).size).toBe(1);
    expect(runs.filter((r) => r.created)).toHaveLength(1);
    const { rows } = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM verification.run WHERE result_version_id = ${w.resultVersionId}`.execute(
      owner,
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('participation is sliced at the contest occurrence window from real status histories (no PII)', async () => {
    const organizer = await newOrganizer(identity, orgs);
    const w = await newContestResult({
      db,
      identity,
      orgs,
      comps,
      structure,
      authority,
      ledger,
      resolver,
      catalog,
      organizer,
      submitAs: 'ATHLETE_A',
    });
    // The organizer OWNER gets an explicit Person ↔ PERSON principal (a real mapping, not Person.id).
    await personSigner(
      { db, ceremony, attestations },
      { accountId: organizer.ownerAccountId, personId: organizer.ownerPersonId },
    );
    const B = await personSigner({ db, ceremony, attestations }, w.athletes[1]!);
    await B.attest(w.resultVersionId, AFFIRM);
    await retryOnClockStep(() =>
      inTransaction(
        db,
        ModuleRole.verification,
        async (ctx) => {
          const rv = (await resolveResultVersion(ctx, w.resultVersionId))!;
          const p = await resolveApplicablePolicy(ctx, catalog.tennisSingles, ctx.txTime);
          if (!p.ok) throw new Error('policy');
          const raw = await loadRawVerificationFacts(ctx, rv, p.policy);
          // Full histories are loaded (status + time only), never a pre-collapsed "ever active".
          expect(Array.isArray(raw.participation.contestStatusChanges)).toBe(true);
          expect(raw.participation.organizerAdmins.length).toBeGreaterThan(0);
          for (const a of raw.participation.organizerAdmins)
            expect(a.statusChanges.map((c) => c.status)).toContain('ACTIVE');
          const { snapshot } = assembleSnapshot(raw, ctx.txTime, 'CURRENT');
          const window = snapshot.participation.occurrenceWindow!;
          expect(Date.parse(window.to)).toBeLessThanOrEqual(
            Date.parse(snapshot.resultVersion.submittedAt),
          );
          const b = snapshot.participation.principals!.find(
            (x) => x.principalId === B.principalId,
          )!;
          expect(b).toMatchObject({ resolution: 'RESOLVED' });
          expect(b.relations).toEqual([
            expect.objectContaining({ kind: 'SELF_PARTICIPANT', timing: 'STRUCTURAL' }),
          ]);
          // The organizer admin (explicit Person ↔ Principal mapping) is sliced at the window: an
          // admin membership that ENDED before play began is no relation at all.
          const adminPerson = raw.participation.organizerAdmins[0]!.personId;
          const adminPrincipal = raw.participation.personPrincipals.find(
            (m) => m.personId === adminPerson,
          )!.principalId;
          const now = new ParticipationIndex(
            raw.participation,
            ctx.txTime,
            'CONTEST',
            raw.resultVersion.recordedAt,
          );
          expect(now.relationsOf(adminPrincipal)).toEqual([
            { kind: 'ORGANIZER_ORGANIZATION_ADMIN', timing: 'DURING_OCCURRENCE' },
          ]);
          const past = new ParticipationIndex(
            {
              ...raw.participation,
              organizerAdmins: [
                {
                  personId: adminPerson,
                  statusChanges: [
                    { status: 'ACTIVE', recordedAt: new Date(0) },
                    { status: 'ENDED', recordedAt: new Date(1) },
                  ],
                },
              ],
              contestStatusChanges: [{ status: 'IN_PROGRESS', recordedAt: new Date(2) }],
            },
            ctx.txTime,
            'CONTEST',
            raw.resultVersion.recordedAt,
          );
          expect(past.relationsOf(adminPrincipal)).toEqual([]);
          expect(JSON.stringify(snapshot)).not.toMatch(
            /Fictional|[\w.+-]+@[\w-]+\.[a-z]{2,}|displayName|legalName|dateOfBirth/,
          );
        },
        1,
        { isolation: 'repeatable read' },
      ),
    );
  });

  it('tampered canonical facts are an integrity failure, never a criterion failure', async () => {
    const w = await world();
    await w.B.attest(w.resultVersionId, AFFIRM);
    await retryOnClockStep(() =>
      inTransaction(
        db,
        ModuleRole.verification,
        async (ctx) => {
          const rv = (await resolveResultVersion(ctx, w.resultVersionId))!;
          const p = await resolveApplicablePolicy(ctx, catalog.tennisSingles, ctx.txTime);
          if (!p.ok) throw new Error('policy');
          const raw = await loadRawVerificationFacts(ctx, rv, p.policy);
          const ok = assembleSnapshot(raw, ctx.txTime, 'CURRENT');
          expect(evaluateVerification(ok.snapshot).outcome.highestSatisfiedLevel).toBe('V1');
          const tamper = (mut: (r: typeof raw) => typeof raw, reason: string) => {
            expect(() => assembleSnapshot(mut(raw), ctx.txTime, 'CURRENT')).toThrow(
              expect.objectContaining({
                code: 'VERIFICATION_INTEGRITY_FAILURE',
                details: { reason },
              }),
            );
          };
          const a0 = raw.storedAttestations[0]!;
          const st = a0.statement as { claim: { polarity: string } };
          tamper(
            (r) => ({
              ...r,
              storedAttestations: [
                { ...a0, statement: { ...st, claim: { ...st.claim, polarity: 'DENY' } } },
              ],
            }),
            'STATEMENT_HASH_MISMATCH',
          );
          const proof = a0.proof as { protected: string; signature: string };
          // Flip a MIDDLE character: the last base64url char carries padding bits and may not change bytes.
          const flipped = `${proof.signature.slice(0, 10)}${proof.signature[10] === 'A' ? 'B' : 'A'}${proof.signature.slice(11)}`;
          tamper(
            (r) => ({
              ...r,
              storedAttestations: [{ ...a0, proof: { ...proof, signature: flipped } }],
            }),
            'SIGNATURE_INVALID',
          );
          tamper(
            (r) => ({ ...r, resultVersion: { ...r.resultVersion, content: { entries: [] } } }),
            'CONTENT_NOT_CANONICAL',
          );
          tamper(
            (r) => ({ ...r, policy: { ...r.policy, specHash: `sha256:${'0'.repeat(64)}` } }),
            'POLICY_HASH_MISMATCH',
          );
          // Clock regression: a CURRENT cutoff earlier than already-recorded facts fails closed.
          expect(() =>
            assembleSnapshot(raw, new Date(ctx.txTime.getTime() - 3_600_000), 'CURRENT'),
          ).toThrow(expect.objectContaining({ code: 'VERIFICATION_TIME_INCONSISTENT' }));
        },
        4,
        { isolation: 'repeatable read' },
      ),
    );
  });

  it('synthetic reference fixtures can never be persisted as sporting truth', async () => {
    const hashes = referenceCases().map((c) => evaluateVerification(c.snapshot).snapshotHash);
    const { rows } = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM verification.run WHERE snapshot_hash = ANY(${hashes})`.execute(
      owner,
    );
    expect(rows[0]!.n).toBe(0);
    // Even a direct insert by the runtime role is refused by the provenance CHECK.
    const w = await world();
    await w.B.attest(w.resultVersionId, AFFIRM);
    const real = await run(w.resultVersionId);
    await expect(
      inTransaction(db, ModuleRole.verification, (ctx) =>
        sql`INSERT INTO verification.run (id, result_version_id, policy_version_id, policy_binding_id, engine_id, engine_version,
              assembler_version, snapshot_provenance, evaluated_as_of, snapshot_hash, policy_spec_hash, evidence_bundle_hash, outcome,
              outcome_hash, trace_hash, evaluation_state, highest_level, recorded_at)
            SELECT ${newId()}, result_version_id, policy_version_id, policy_binding_id, engine_id, engine_version, assembler_version,
                   'REFERENCE_FIXTURE', ${ctx.txTime}, snapshot_hash, policy_spec_hash, evidence_bundle_hash, outcome, outcome_hash,
                   trace_hash, evaluation_state, highest_level, ${ctx.txTime}
            FROM verification.run WHERE id = ${real.runId}`.execute(ctx.trx),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('verification never changes Result lifecycle, never advances brackets, never emits consequence events', async () => {
    const w = await world();
    await w.B.attest(w.resultVersionId, AFFIRM);
    const count = async () =>
      (
        await sql<{ t: number; s: string; c: number }>`
          SELECT (SELECT count(*)::int FROM results.result_status_transition WHERE result_version_id = ${w.resultVersionId}) AS t,
                 (SELECT current_status FROM results.result_version_state WHERE result_version_id = ${w.resultVersionId}) AS s,
                 (SELECT count(*)::int FROM competition.contestant WHERE contest_id IN (SELECT id FROM competition.contest WHERE event_id = ${w.eventId})) AS c`.execute(
          owner,
        )
      ).rows[0];
    const before = await count();
    await run(w.resultVersionId);
    expect(await count()).toEqual(before);
    const { rows } = await sql<{
      event_type: string;
      // BRT-08: AchievementRule administration events are not consequences; verification derives none.
    }>`SELECT DISTINCT event_type FROM platform.outbox_event WHERE event_type ~ '(AchievementDerived|AchievementCurrentStateChanged|Record|Ranking|Prize|Trophy)'`.execute(
      owner,
    );
    expect(rows).toEqual([]);
  });

  it('read models rebuild from verification metadata to the identical state', async () => {
    const before = await snapshotVerificationReadModels(db);
    await rebuildVerificationReadModels(maint);
    expect(await snapshotVerificationReadModels(db)).toEqual(before);
  });
});
