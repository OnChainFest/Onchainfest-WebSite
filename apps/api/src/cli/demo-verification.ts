import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId, type Uuid } from '@br/domain';
import { createDevelopmentEvidenceCipher, FilesystemEvidenceBlobStore } from '@br/evidence';
import { createDevelopmentPiiCipher } from '@br/identity';
import {
  AttestationStore,
  AuthorityStore,
  CatalogStore,
  CompetitionHierarchyResolver,
  CompetitionStore,
  createCompetitionResultLedger,
  createDb,
  databaseUrls,
  IdentityStore,
  inTransaction,
  loadRawVerificationFacts,
  ModuleRole,
  operatorDatabaseUrl,
  OrganizationStore,
  PrincipalKeyCeremony,
  rebuildVerificationReadModels,
  resolveApplicablePolicy,
  resolveResultVersion,
  snapshotVerificationReadModels,
  StructureStore,
  verificationOperatorDatabaseUrl,
  VerificationService,
} from '@br/persistence';
import {
  awaitDbTimePast,
  declaredNoParticipation,
  newAthlete,
  newContestResult,
  personSigner,
  seedTestCatalog,
  uniqueSlug,
} from '@br/testkit';
import {
  assembleSnapshot,
  evaluateVerification,
  REFERENCE_POLICY_SPEC,
  type RawVerificationFacts,
} from '@br/verification';
import { FIXTURE_LABEL, referenceCases, produce, referenceWorld } from '@br/verification/fixtures';
import { sql } from 'kysely';
import { createDevTokenAuth, mintDevToken } from '../auth';
import { buildServer } from '../server';

/**
 * BRT-07 acceptance walkthrough (60 steps) through the real /v1 surface (in-process inject) plus
 * database-level proofs. ALL DATA IS FICTIONAL. Development only. No built-in secrets.
 *
 *   Part A — REAL CANONICAL FLOW: real ResultVersion, evidence, attestations, authority and
 *            participation → the highest level GENUINELY reachable today (V1), and exactly why V2
 *            is blocked (no RESULT_OFFICIAL / T5 producer).
 *   Part B — REFERENCE ENGINE FIXTURES — NOT PERSISTED SPORTING TRUTH: in-memory synthetic
 *            snapshots proving the exact V2 / V3 / V4 rules. Never written anywhere.
 *   Then   — real-data semantics: disputes, retraction, key compromise, policy change,
 *            determinism, integrity, privacy, rebuild, authority boundaries.
 * Run: pnpm db:up && pnpm db:bootstrap && pnpm db:migrate && pnpm demo:verification
 */
if (process.env.NODE_ENV === 'production') throw new Error('the demo refuses production');
const devAuthSecret = randomBytes(32).toString('hex');
const vaultKey = randomBytes(32).toString('hex');
const AUD = 'bragging-rights:development';
const urls = databaseUrls();
const db = createDb(urls.api);
const owner = createDb(urls.owner, { max: 2 });
const maintenanceDb = createDb(urls.maintenance, { max: 2 });
const catalogUrl = operatorDatabaseUrl();
const policyUrl = verificationOperatorDatabaseUrl();
if (catalogUrl === undefined || policyUrl === undefined)
  throw new Error('the demo needs the operator database URLs');
const catalogDb = createDb(catalogUrl, { max: 2 });
const policyDb = createDb(policyUrl, { max: 2 });
const vaultDb = createDb(urls.vault, { max: 2 });
const logLines: string[] = [];
const root = mkdtempSync(join(tmpdir(), 'br-verification-demo-'));
const app = buildServer({
  db,
  vaultDb,
  verificationOperatorDb: policyDb,
  piiCipher: createDevelopmentPiiCipher({ keyMaterial: vaultKey }),
  auth: (identity) => createDevTokenAuth(identity, { secret: devAuthSecret }),
  evidenceBlobStore: new FilesystemEvidenceBlobStore({
    root,
    cipher: createDevelopmentEvidenceCipher({ keyMaterial: randomBytes(32).toString('hex') }),
  }),
  signatureAudience: AUD,
  logStream: { write: (l: string) => void logLines.push(l) },
});

const run = newId().replace(/-/g, '').slice(-8);
const S = {
  legalName: `Demo Legal V${run}`,
  email: `demo.v${run}@example.test`,
  phone: '+15550107777',
  dateOfBirth: '1911-11-11',
};
let step = 0;
const show = (title: string, detail: unknown) =>
  console.log(
    `\n▶ ${String(++step).padStart(2, '0')}. ${title}\n   ${typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2).replaceAll('\n', '\n   ')}`,
  );
const tokens: string[] = [];
const bearer = (s: string, operator = false) => {
  const t = mintDevToken(`demo7-${run}-${s}`, { secret: devAuthSecret, operator });
  tokens.push(t);
  return { authorization: `Bearer ${t}` };
};
const idem = () => ({ 'idempotency-key': `demo7-${newId()}` });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form navigation of JSON responses
type Json = Record<string, any>;
async function call(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  headers: Record<string, string> = {},
  payload?: unknown,
) {
  const res = await app.inject({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return {
    status: res.statusCode,
    text: res.body,
    body: (res.headers['content-type']?.toString().includes('json') ? res.json() : null) as Json,
  };
}
async function ok(p: ReturnType<typeof call>, status = 200): Promise<Json> {
  const r = await p;
  if (r.status !== status) throw new Error(`expected HTTP ${status}, got ${r.status}: ${r.text}`);
  return r.body;
}
const failures: string[] = [];
const check = (what: string, condition: boolean) => {
  if (!condition) failures.push(what);
  return condition;
};
/**
 * Demo HARNESS only: the WSL/Docker VM clock steps back ~1 s every ~30 s, which makes the unchanged
 * BRT-03/06 admission checks (key admissibility, principal visibility at DB now()) refuse a fact
 * created a moment earlier. Retry those specific symptoms after the clock catches up; never clamp.
 */
async function clockTolerant<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const e = err as { code?: string; details?: { reason?: string }; message?: string };
      const clockStep =
        e.details?.reason === 'KEY_NOT_VALID_AT_TIME' ||
        e.code === 'VERIFICATION_TIME_INCONSISTENT' ||
        /PRINCIPAL_UNKNOWN|UNKNOWN_PRINCIPAL/.test(e.message ?? '');
      if (!clockStep || attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, 700 * attempt));
    }
  }
}
const count = async (q: string) =>
  Number(((await sql.raw(q).execute(owner)).rows[0] as { n: number }).n);

try {
  // ═════════════════════════════ PART A — REAL CANONICAL FLOW ═════════════════════════════
  console.log('\n══════ PART A — REAL CANONICAL FLOW (persisted, fictional data) ══════');
  show('Service health and readiness', {
    health: (await call('GET', '/health')).body,
    ready: (await call('GET', '/ready')).body,
  });

  const orgH = bearer('organizer');
  const opH = bearer('policy-operator', true);
  const orgAccountId = (await ok(call('GET', '/v1/me', orgH))).accountId as string;
  const personId = (
    await ok(call('POST', '/v1/persons', { ...orgH, ...idem() }, { relation: 'SELF' }), 201)
  ).personId as string;
  await call('PUT', `/v1/persons/${personId}/private`, orgH, S);
  const org = await ok(
    call(
      'POST',
      '/v1/organizations',
      { ...orgH, ...idem() },
      {
        orgType: 'CLUB',
        slug: uniqueSlug('demo7'),
        profile: { displayName: 'Fictional Verification Club' },
      },
    ),
    201,
  );
  const identity = new IdentityStore(db);
  const catalog = await seedTestCatalog(identity, new CatalogStore(catalogDb));
  const authority = new AuthorityStore(db, { conflictChecker: declaredNoParticipation });
  const w = await newContestResult({
    db,
    identity,
    orgs: new OrganizationStore(db),
    comps: new CompetitionStore(db),
    structure: new StructureStore(db),
    authority,
    ledger: createCompetitionResultLedger(db, { conflictChecker: declaredNoParticipation }),
    resolver: new CompetitionHierarchyResolver(db),
    catalog,
    submitAs: 'ATHLETE_A',
    organizer: {
      ownerAccountId: orgAccountId,
      ownerPersonId: personId,
      organizationId: org.organizationId,
      slug: org.slug,
    },
  });
  show('Fictional Competition → Event → Contest (BRT-05)', {
    competitionId: w.competitionId,
    eventId: w.eventId,
    contestId: w.contestId,
    participants: w.participantIds,
  });
  show("Exact ResultVersion (submitted by athlete A's explicit PERSON principal)", {
    resultVersionId: w.resultVersionId,
    contentHash: w.contentHash,
  });

  const upload = await ok(
    call(
      'POST',
      '/v1/evidence',
      { ...orgH, ...idem() },
      {
        content: {
          base64: Buffer.from(JSON.stringify({ fictional: true, sets: ['6-4', '6-3'] })).toString(
            'base64',
          ),
          mediaType: 'application/json',
        },
        evidenceType: 'SIGNED_SCORESHEET',
        source: { kind: 'HUMAN' },
        attachTo: { targetType: 'RESULT_VERSION', targetId: w.resultVersionId, role: 'PRIMARY' },
      },
    ),
    201,
  );
  const bundle = await ok(
    call('GET', `/v1/result-versions/${w.resultVersionId}/evidence-bundle`, orgH),
  );
  show('Evidence (PRIMARY scoresheet) and the BRT-06 Evidence Bundle hash', {
    evidenceId: upload.evidenceId,
    bundleHash: bundle.bundleHash,
  });

  const policy = await ok(
    call(
      'POST',
      '/v1/internal/verification-policies',
      { ...opH, ...idem() },
      { code: `demo-${run}`, name: 'Fictional demo reference policy' },
    ),
    201,
  );
  const v1 = await ok(
    call(
      'POST',
      `/v1/internal/verification-policies/${policy.policyId}/versions`,
      { ...opH, ...idem() },
      { spec: REFERENCE_POLICY_SPEC },
    ),
    201,
  );
  await ok(
    call(
      'POST',
      `/v1/internal/verification-policy-versions/${v1.policyVersionId}/publish`,
      opH,
      {},
    ),
  );
  show('Reference policy created and PUBLISHED on the dedicated operator connection', {
    code: `demo-${run}`,
    version: v1.version,
    specHash: v1.specHash,
  });
  const binding = await ok(
    call(
      'POST',
      `/v1/internal/discipline-versions/${catalog.tennisSingles}/verification-policy-bindings`,
      { ...opH, ...idem() },
      { policyVersionId: v1.policyVersionId },
    ),
    201,
  );
  show('Policy bound to the EXACT DisciplineVersion the event pins (no backdating)', binding);

  // Same bounded retry as the service: the WSL/Docker DB clock may step back ~1 s (fail closed otherwise).
  const snapshotOf = async (asOf?: Date) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await snapshotOnce(asOf);
      } catch (err) {
        if ((err as { code?: string }).code !== 'VERIFICATION_TIME_INCONSISTENT' || attempt >= 3)
          throw err;
        await new Promise((r) => setTimeout(r, attempt * 600));
      }
    }
  };
  const snapshotOnce = (asOf?: Date) =>
    inTransaction(
      db,
      ModuleRole.verification,
      async (ctx) => {
        const rv = (await resolveResultVersion(ctx, w.resultVersionId))!;
        const p = await resolveApplicablePolicy(ctx, catalog.tennisSingles, ctx.txTime);
        if (!p.ok) throw new Error('no policy');
        const raw = await loadRawVerificationFacts(ctx, rv, p.policy);
        return {
          raw,
          envelope: assembleSnapshot(
            raw,
            asOf ?? ctx.txTime,
            asOf === undefined ? 'CURRENT' : 'HISTORICAL',
          ),
          txTime: ctx.txTime,
        };
      },
      4,
      { isolation: 'repeatable read' },
    );
  const s0 = await snapshotOf();
  show(
    'Real VerificationSnapshot assembled from canonical facts (hashes + signatures re-verified)',
    {
      provenance: s0.envelope.snapshot.provenance,
      supportedFactKinds: s0.envelope.snapshot.supportedFactKinds,
      participationSides: s0.envelope.snapshot.participation.sides?.length,
    },
  );
  show('Snapshot hash (the cutoff is metadata, not hashed)', {
    snapshotHash: s0.envelope.snapshotHash,
    asOf: s0.envelope.asOf,
  });

  const evaluate = () =>
    ok(call('POST', `/v1/result-versions/${w.resultVersionId}/verification-runs`, orgH, {}), 201);
  const rA = await evaluate();
  show('Evaluate the initial claim (organizer requests; the outcome is not chosen by anyone)', {
    runId: rA.runId,
    level: rA.highestSatisfiedLevel,
    label: rA.label,
  });
  check('initial claim is V0', rA.highestSatisfiedLevel === 'V0');
  show('V0 CLAIMED — a submitted, hash-bound claim with a known submitter', rA.public.levels);

  const ceremony = new PrincipalKeyCeremony(db, { audience: AUD });
  const attestations = new AttestationStore(db, { audience: AUD });
  const A = await personSigner({ db, ceremony, attestations }, w.athletes[0]!);
  const B = await personSigner({ db, ceremony, attestations }, w.athletes[1]!);
  const AFFIRM = { type: 'RESULT_ACCURATE', polarity: 'AFFIRM' } as const;
  await clockTolerant(() => A.attest(w.resultVersionId, AFFIRM));
  const rSelf = await evaluate();
  show('Insufficient corroboration: the submitter affirms its own claim', {
    level: rSelf.highestSatisfiedLevel,
  });
  check('self-affirmation stays V0', rSelf.highestSatisfiedLevel === 'V0');
  show('Still V0 (SUBMITTER_SELF never corroborates)', rSelf.outcome.levels[1].criteria);

  const bAff = await clockTolerant(() => B.attest(w.resultVersionId, AFFIRM));
  const rB = await evaluate();
  show('The opponent (another participant side) affirms through the real signing ceremony', {
    attestationId: bAff,
  });
  check('opponent corroboration reaches V1', rB.highestSatisfiedLevel === 'V1');
  show('V1 CORROBORATED', { level: rB.highestSatisfiedLevel, label: rB.label, runId: rB.runId });

  const B2 = await clockTolerant(() => B.addKey());
  await clockTolerant(() => B.attest(w.resultVersionId, AFFIRM, B2));
  const rB2 = await evaluate();
  const detailB2 = await ok(call('GET', `/v1/verification-runs/${rB2.runId}`, orgH));
  const corro = detailB2.trace.criteria.find((c: Json) => c.kind === 'INDEPENDENT_CORROBORATION');
  show('Two keys of the SAME principal count once (issuer groups)', corro.issuerGroups);
  check(
    'B counted once',
    corro.observed === 1 &&
      corro.issuerGroups.find((g: Json) => g.principalId === B.principalId).attestationIds
        .length === 2,
  );
  show(
    'Participation / conflict facts used (structural relations, never PII)',
    corro.participation,
  );
  show('Persisted real VerificationRuns (immutable, append-only)', {
    runs: await count(
      `SELECT count(*)::int AS n FROM verification.run WHERE result_version_id = '${w.resultVersionId}'`,
    ),
  });
  show("Highest level genuinely reachable from today's producible facts", {
    level: rB2.highestSatisfiedLevel,
    label: rB2.label,
  });
  const v2 = rB2.outcome.levels.find((l: Json) => l.level === 'V2');
  show(
    'V2 EVENT_CERTIFIED is blocked honestly (no RESULT_OFFICIAL / T5 producer exists)',
    v2.criteria.filter((c: Json) => c.status !== 'PASS'),
  );
  check(
    'V2 blocked by INPUT_NOT_SUPPORTED',
    v2.criteria.find((c: Json) => c.kind === 'OFFICIAL_DECLARATION').status ===
      'INPUT_NOT_SUPPORTED',
  );
  show(
    'Trace reasons for the missing canonical input',
    detailB2.trace.criteria.find((c: Json) => c.kind === 'OFFICIAL_DECLARATION').reasons,
  );
  const status = await count(
    `SELECT count(*)::int AS n FROM results.result_status_transition WHERE result_version_id = '${w.resultVersionId}'`,
  );
  show('Result lifecycle status unchanged by verification', {
    transitions: status,
    status: (
      await sql`SELECT current_status FROM results.result_version_state WHERE result_version_id = ${w.resultVersionId}`.execute(
        owner,
      )
    ).rows[0],
  });
  check('no lifecycle transition', status === 1);
  const unresolved = await count(
    `SELECT count(*)::int AS n FROM competition.contestant WHERE contest_id IN (SELECT id FROM competition.contest WHERE event_id = '${w.eventId}') AND source_kind <> 'PARTICIPANT'`,
  );
  show(
    'Bracket unchanged (dependent slots remain unresolved; verification never advances anyone)',
    { unresolvedDependencySlots: unresolved },
  );
  const consequences = await count(
    // BRT-08: AchievementRule administration events are not consequences; verification derives none.
    `SELECT count(*)::int AS n FROM platform.outbox_event WHERE event_type ~ '(AchievementDerived|AchievementCurrentStateChanged|Record|Ranking|Prize|Trophy)'`,
  );
  show('No Achievement / Record / Ranking / Prize / Trophy events exist', {
    consequenceEvents: consequences,
  });
  check('no consequence events', consequences === 0);

  // ═════════════════ PART B — REFERENCE ENGINE FIXTURES — NOT PERSISTED SPORTING TRUTH ═════════════════
  console.log(`\n══════ PART B — ${FIXTURE_LABEL.toUpperCase()} ══════`);
  const cases = referenceCases();
  const fixtureHashes: string[] = [];
  for (const name of [
    'v2-result-official',
    'v2-blocked-accurate-without-t5',
    'v3-sanctioned',
    'v3-blocked-missing-identity',
    'v4-ratified',
    'v4-blocked-missing-ratification',
  ]) {
    const c = cases.find((x) => x.name === name)!;
    const e = evaluateVerification(c.snapshot);
    fixtureHashes.push(e.snapshotHash);
    const blocked = e.outcome.levels.find((l) => l.status === 'BLOCKED');
    show(`${FIXTURE_LABEL} · ${c.name}`, {
      description: c.description,
      provenance: c.snapshot.provenance,
      highestSatisfiedLevel: e.outcome.highestSatisfiedLevel,
      blocked:
        blocked === undefined
          ? null
          : {
              level: blocked.level,
              failing: (blocked.criteria ?? [])
                .filter((x) => x.status !== 'PASS')
                .map((x) => `${x.kind}:${x.status}`),
            },
    });
    check(`${c.name} → ${c.expectedLevel}`, e.outcome.highestSatisfiedLevel === c.expectedLevel);
  }
  const persistedFixtures = await count(
    `SELECT count(*)::int AS n FROM verification.run WHERE snapshot_hash IN (${fixtureHashes.map((h) => `'${h}'`).join(',')}) OR snapshot_provenance <> 'CANONICAL_ASSEMBLY'`,
  );
  show(
    'Fixture snapshots were never written to verification.run (DB CHECK: CANONICAL_ASSEMBLY only)',
    { persistedFixtureRuns: persistedFixtures },
  );
  check('fixtures not persisted', persistedFixtures === 0);

  // ═════════════════════════════ real-data semantics ═════════════════════════════
  console.log('\n══════ REAL-DATA SEMANTICS (persisted, fictional data) ══════');
  const deny = await clockTolerant(() =>
    B.attest(w.resultVersionId, {
      type: 'RESULT_ACCURATE',
      polarity: 'DENY',
      payload: { reasonCode: 'SCORE_INCORRECT' },
    } as never),
  );
  show('The opponent files a dispute claim (RESULT_ACCURATE / DENY)', { attestationId: deny });
  const cur1 = await ok(call('GET', `/v1/result-versions/${w.resultVersionId}/verification`));
  show(
    'Latest run is STALE (hash-based, not time-based); the stale level is NOT shown as current',
    { freshness: cur1.freshness, level: cur1.level ?? null, lastEvaluated: cur1.lastEvaluated },
  );
  check('stale after dispute', cur1.freshness === 'STALE' && cur1.level === undefined);
  const rD = await evaluate();
  show('Re-evaluation under the dispute', {
    level: rD.highestSatisfiedLevel,
    activeDispute: rD.public.activeDispute,
  });
  check('dispute drops to V0', rD.highestSatisfiedLevel === 'V0');
  await clockTolerant(() => B.retract(deny));
  show('The dispute claim is retracted (signed retraction; the attestation is never deleted)', {
    retracted: deny,
  });
  const rR = await evaluate();
  show('Re-evaluation after retraction', { level: rR.highestSatisfiedLevel });
  check('retraction recovers V1', rR.highestSatisfiedLevel === 'V1');

  const bAffIssued = (
    await sql<{
      t: Date;
    }>`SELECT issued_at AS t FROM attestation.attestation WHERE id = ${bAff}`.execute(owner)
  ).rows[0]!.t;
  await clockTolerant(() =>
    ceremony.changeKeyStatus({
      actorAccountId: B.accountId,
      principalId: B.principalId,
      keyId: B.key.keyId,
      kind: 'COMPROMISED',
      compromisedSince: bAffIssued,
      idempotencyKey: `demo7-${newId()}`,
    }),
  );
  show("Opponent key declared COMPROMISED retroactively (t₀ = the affirmation's issuedAt)", {
    keyId: '(internal)',
    compromisedSince: bAffIssued.toISOString(),
  });
  const cur2 = await ok(call('GET', `/v1/result-versions/${w.resultVersionId}/verification`));
  show('Prior run becomes STALE', { freshness: cur2.freshness });
  check('stale after compromise', cur2.freshness === 'STALE');
  await awaitDbTimePast(owner, rR.evaluatedAsOf);
  const then = await ok(
    call('POST', `/v1/result-versions/${w.resultVersionId}/verification-replays`, orgH, {
      asOf: rR.evaluatedAsOf,
    }),
  );
  const oldRun = await ok(call('GET', `/v1/verification-runs/${rR.runId}`, orgH));
  show('Historical run unchanged; "as known then" replay reproduces it exactly (not persisted)', {
    oldLevel: oldRun.highestSatisfiedLevel,
    oldSnapshot: oldRun.snapshotHash,
    replayLevel: then.highestSatisfiedLevel,
    matchingRunId: then.matchingRunId,
  });
  check(
    'replay reproduces run',
    then.matchingRunId === rR.runId && then.snapshotHash === rR.snapshotHash,
  );

  const stricter = {
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
  const v2p = await ok(
    call(
      'POST',
      `/v1/internal/verification-policies/${policy.policyId}/versions`,
      { ...opH, ...idem() },
      { spec: stricter },
    ),
    201,
  );
  await ok(
    call(
      'POST',
      `/v1/internal/verification-policy-versions/${v2p.policyVersionId}/publish`,
      opH,
      {},
    ),
  );
  await ok(
    call(
      'POST',
      `/v1/internal/discipline-versions/${catalog.tennisSingles}/verification-policy-bindings`,
      { ...opH, ...idem() },
      { policyVersionId: v2p.policyVersionId },
    ),
    201,
  );
  show('Policy v2 (stricter: two independent corroborators) published and bound', {
    version: v2p.version,
  });
  const cur3 = await ok(call('GET', `/v1/result-versions/${w.resultVersionId}/verification`));
  show('Previous run is historical under v1 and STALE for the current policy', {
    freshness: cur3.freshness,
    lastEvaluated: cur3.lastEvaluated,
  });
  const rP2 = await evaluate();
  show('Evaluation under policy v2', { level: rP2.highestSatisfiedLevel, policy: rP2.policy });
  check('policy change creates a new run', rP2.policy.version === 2);

  const x1 = await snapshotOf();
  const x2 = await snapshotOf();
  show('Build the same current snapshot twice', {
    first: x1.envelope.snapshotHash,
    second: x2.envelope.snapshotHash,
  });
  check('same snapshot hash', x1.envelope.snapshotHash === x2.envelope.snapshotHash);
  show('Same hash', x1.envelope.snapshotHash === x2.envelope.snapshotHash);
  const reversed: RawVerificationFacts = {
    ...x1.raw,
    storedAttestations: [...x1.raw.storedAttestations].reverse(),
    keys: [...x1.raw.keys].reverse(),
    authority: {
      ...x1.raw.authority,
      grants: [...x1.raw.authority.grants].reverse(),
      principals: [...x1.raw.authority.principals].reverse(),
    },
    bundleFacts: {
      ...x1.raw.bundleFacts,
      attestations: [...x1.raw.bundleFacts.attestations].reverse(),
      evidence: [...x1.raw.bundleFacts.evidence].reverse(),
    },
  };
  const e1 = evaluateVerification(assembleSnapshot(x1.raw, x1.txTime, 'CURRENT').snapshot);
  const e2 = evaluateVerification(assembleSnapshot(reversed, x1.txTime, 'CURRENT').snapshot);
  show('Reorder every input collection', {
    reorderedCollections: ['attestations', 'keys', 'grants', 'principals', 'evidence'],
  });
  show('Same outcome and trace hashes', {
    outcome: [e1.outcomeHash === e2.outcomeHash],
    trace: [e1.traceHash === e2.traceHash],
  });
  check('order independent', e1.outcomeHash === e2.outcomeHash && e1.traceHash === e2.traceHash);
  const a0 = x1.raw.storedAttestations[0]!;
  const st = a0.statement as Json;
  const tampered = {
    ...x1.raw,
    storedAttestations: [
      {
        ...a0,
        statement: {
          ...st,
          claim: { ...st.claim, polarity: st.claim.polarity === 'AFFIRM' ? 'DENY' : 'AFFIRM' },
        },
      },
      ...x1.raw.storedAttestations.slice(1),
    ],
  };
  show("Tamper a stored canonical fact in memory (flip a signed claim's polarity)", {
    attestationId: a0.attestationId,
  });
  let integrity = 'NOT RAISED';
  try {
    assembleSnapshot(tampered, x1.txTime, 'CURRENT');
  } catch (err) {
    integrity = `${(err as { code?: string }).code} / ${(err as { details?: { reason?: string } }).details?.reason}`;
  }
  show('Integrity protection triggers (a system failure, never a criterion failure)', integrity);
  check('integrity failure raised', integrity.startsWith('VERIFICATION_INTEGRITY_FAILURE'));

  const pub = await ok(call('GET', `/v1/result-versions/${w.resultVersionId}/verification`));
  show('Public-safe verification DTO', pub);
  const pubText = JSON.stringify(pub);
  const leaked = [
    ...Object.values(S),
    personId,
    orgAccountId,
    A.principalId,
    B.principalId,
    vaultKey,
    devAuthSecret,
    ...tokens,
  ].filter((v) => pubText.includes(v));
  show('No PII, account/person/principal ids, secrets or tokens in the public DTO', {
    leaked: leaked.length,
  });
  check('public DTO clean', leaked.length === 0);
  show('Freshness is separate from the level', {
    freshness: pub.freshness,
    level: pub.level ?? null,
    lastEvaluated: pub.lastEvaluated ?? null,
  });

  const before = await snapshotVerificationReadModels(db);
  const rebuilt = await rebuildVerificationReadModels(maintenanceDb);
  show('Rebuild the verification read models (maintenance login; metadata only)', rebuilt);
  const identical =
    JSON.stringify(await snapshotVerificationReadModels(db)) === JSON.stringify(before);
  show('Identical public read model after rebuild', identical);
  check('rebuild identical', identical);

  const w2 = await newContestResult({
    db,
    identity,
    orgs: new OrganizationStore(db),
    comps: new CompetitionStore(db),
    structure: new StructureStore(db),
    authority,
    ledger: createCompetitionResultLedger(db, { conflictChecker: declaredNoParticipation }),
    resolver: new CompetitionHierarchyResolver(db),
    catalog,
    submitAs: 'REFEREE',
  });
  const officialPerson = await newAthlete(identity, 'demo-official', 'Fictional Official');
  const official = await personSigner({ db, ceremony, attestations }, officialPerson);
  await authority.issueGrant({
    actorPrincipalId: w.platformPrincipalId as Uuid,
    grantorPrincipalId: w.platformPrincipalId as Uuid,
    granteePrincipalId: official.principalId as Uuid,
    capabilities: ['ATTEST_RESULT'],
    scope: { recognitionLevel: ['PLATFORM'], competition: [w.competitionId as Uuid] },
    delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
  });
  await clockTolerant(() => official.attest(w2.resultVersionId, AFFIRM));
  const verifier = new VerificationService(db);
  const sibEval = await verifier.evaluate({
    actor: { internal: true },
    resultVersionId: w2.resultVersionId,
  });
  const sibRun = sibEval.kind === 'RUN' ? sibEval.run : undefined;
  const sibCriteria = (await verifier.runDetail({ internal: true }, sibRun!.runId)).trace.criteria;
  const sibV1 = sibCriteria.find((c) => c.kind === 'INDEPENDENT_CORROBORATION')!;
  const sibV2 = sibCriteria.find((c) => c.kind === 'OFFICIAL_DECLARATION')!;
  show(
    'An ATTEST_RESULT grant is NOT a registered official: V1 needs no authority, and the registered-official path has no producer',
    {
      level: sibRun?.highestSatisfiedLevel,
      v1Reasons: sibV1.reasons,
      issuer: sibV1.issuerGroups?.map((g) => ({
        classification: g.classification,
        reasons: g.reasons,
      })),
      v1AuthorityDecisions: (sibV1.authority ?? []).length,
    },
  );
  check(
    'ATTEST_RESULT does not create a registered official',
    sibRun?.highestSatisfiedLevel === 'V0' &&
      sibV1.reasons.includes('NOT_SUPPORTED_REGISTERED_OFFICIAL') &&
      (sibV1.authority ?? []).length === 0,
  );
  show(
    'Sibling authority does not cross: an official granted for competition #1 attests in competition #2 (V2 authority trace)',
    {
      decisions: (sibV2.authority ?? []).map(
        (a) => `${a.capability}@${a.recognitionLevel}: ${a.reason}`,
      ),
    },
  );
  check(
    'sibling grant not honoured',
    (sibV2.authority ?? []).length > 0 && (sibV2.authority ?? []).every((a) => !a.authorized),
  );
  show(
    'Source / issuer independence: principals, not keys or accounts',
    corro.issuerGroups.map((g: Json) => ({
      classification: g.classification,
      attestations: g.attestationIds.length,
    })),
  );
  const aiOnly = evaluateVerification(
    produce(referenceWorld(), (d) => {
      d.sanctions = [];
      d.ratifications = [];
      d.discipline.primaryEvidenceTypes = ['AI_DERIVED'];
      d.evidence = [
        {
          ...d.evidence![0]!,
          evidenceType: 'AI_DERIVED',
          sourceKind: 'AI_PIPELINE',
          generatorKind: 'AI_PIPELINE',
        },
      ];
    }),
  );
  show(`AI-only support cannot establish V2+ (E-4) — ${FIXTURE_LABEL}`, {
    level: aiOnly.outcome.highestSatisfiedLevel,
    flags: aiOnly.outcome.flags,
  });
  check('AI-only capped', aiOnly.outcome.highestSatisfiedLevel === 'V1');
  show('Web verification surface (Next.js, public API only)', {
    pages: [`/result-versions/${w.resultVersionId}/verification`, `/verifications/${rB.runId}`],
    summary: (await ok(call('GET', `/v1/verification-runs/${rB.runId}/summary`))).statement,
  });
  const outbox = (
    await sql<{
      event_type: string;
      n: number;
    }>`SELECT event_type, count(*)::int AS n FROM platform.outbox_event WHERE event_type ~ '^(Verification|CurrentVerification)' GROUP BY 1 ORDER BY 1`.execute(
      owner,
    )
  ).rows;
  const audit = (
    await sql<{
      action: string;
      outcome: string;
      n: number;
    }>`SELECT action, outcome, count(*)::int AS n FROM platform.audit_event WHERE action ~ '^verification\\.' GROUP BY 1, 2 ORDER BY 1, 2`.execute(
      owner,
    )
  ).rows;
  show('Outbox events and audit telemetry (ids, hashes, levels, statuses only)', { outbox, audit });
  const scoreText = JSON.stringify([rB.outcome, detailB2.trace, pub]);
  const scores = /"(confidence|trustScore|score|probability|weight)"\s*:/.test(scoreText);
  show('No confidence, trust score, probability or weight anywhere', { found: scores });
  check('no scores', !scores);
  show('Synthetic fixtures remain unpersisted', {
    runsWithFixtureProvenance: await count(
      `SELECT count(*)::int AS n FROM verification.run WHERE snapshot_provenance <> 'CANONICAL_ASSEMBLY'`,
    ),
  });
  const logLeak = [...Object.values(S), vaultKey, devAuthSecret, ...tokens].filter((v) =>
    logLines.join('\n').includes(v),
  );
  check('logs clean', logLeak.length === 0);
  show('Finish', failures.length === 0 ? 'ALL CHECKS GREEN' : `FAILED: ${failures.join('; ')}`);
  if (failures.length > 0) process.exitCode = 1;
} finally {
  await app.close();
  await Promise.all(
    [db, owner, maintenanceDb, catalogDb, policyDb, vaultDb].map((d) => d.destroy()),
  );
}
