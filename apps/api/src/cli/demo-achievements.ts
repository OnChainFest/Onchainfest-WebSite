import { randomBytes } from 'node:crypto';
import {
  deriveAchievements,
  referenceTitleRule,
  type AchievementDerivationSnapshot,
  type AchievementRuleSpec,
} from '@br/achievements';
import {
  FIXTURE_LABEL,
  FX,
  fixtureHash,
  fixtureId,
  padelTitleFixture,
  personalBestFixture,
  thresholdFixture,
} from '@br/achievements/fixtures';
import { newId } from '@br/domain';
import { createDevelopmentPiiCipher } from '@br/identity';
import {
  achievementOperatorDatabaseUrl,
  AttestationStore,
  AuthorityStore,
  CatalogStore,
  CompetitionHierarchyResolver,
  CompetitionStore,
  createCompetitionResultLedger,
  createDb,
  databaseUrls,
  dependencyIndex,
  IdentityStore,
  inTransaction,
  ModuleRole,
  operatorDatabaseUrl,
  OrganizationStore,
  PrincipalKeyCeremony,
  rebuildAchievementReadModels,
  snapshotAchievementReadModels,
  StructureStore,
  verificationOperatorDatabaseUrl,
  VerificationPolicyStore,
} from '@br/persistence';
import { persistDerivation, recordSupportAssessment } from '@br/persistence/achievement-lanes';
import {
  declaredNoParticipation,
  newContestResult,
  personSigner,
  publishPolicy,
  seedTestCatalog,
} from '@br/testkit';
import {
  createFixturePersistenceEnvironment,
  FIXTURE_ENVIRONMENT_BANNER,
  publishAchievementRule,
} from '@br/testkit/achievements';
import { sql } from 'kysely';
import { createDevTokenAuth, mintDevToken } from '../auth';
import { buildServer } from '../server';

/**
 * BRT-08 acceptance walkthrough. ALL DATA IS FICTIONAL. Development only. No built-in secrets.
 *
 *   PART A — REAL CANONICAL FLOW (development database, real /v1 surface): real ResultVersion, real
 *            VerificationRun (V0/V1), published rules → the rule MATCHES the sporting facts but the
 *            BRT-01 floors are unmet → ZERO Achievements, with exact blockers. No manual bypass.
 *   PART B — REFERENCE ENGINE FIXTURE — NOT PERSISTED SPORTING TRUTH (in memory only).
 *   PART C — REFERENCE FIXTURE PERSISTENCE ENVIRONMENT (a THROWAWAY database with the test-only
 *            overlay, destroyed at the end): BRT-08's own persistence mechanics. Never the dev DB.
 * Run: pnpm db:up && pnpm db:bootstrap && pnpm db:migrate && pnpm demo:achievements
 */
if (process.env.NODE_ENV === 'production') throw new Error('the demo refuses production');
const devAuthSecret = randomBytes(32).toString('hex');
const AUD = 'bragging-rights:development';
const urls = databaseUrls();
const db = createDb(urls.api);
const owner = createDb(urls.owner, { max: 2 });
const catalogUrl = operatorDatabaseUrl();
const policyUrl = verificationOperatorDatabaseUrl();
const ruleUrl = achievementOperatorDatabaseUrl();
if (catalogUrl === undefined || policyUrl === undefined || ruleUrl === undefined)
  throw new Error('the demo needs the operator database URLs');
const catalogDb = createDb(catalogUrl, { max: 2 });
const policyDb = createDb(policyUrl, { max: 2 });
const ruleDb = createDb(ruleUrl, { max: 2 });
const vaultDb = createDb(urls.vault, { max: 2 });
const logLines: string[] = [];
const serverOptions = {
  db,
  vaultDb,
  piiCipher: createDevelopmentPiiCipher({ keyMaterial: randomBytes(32).toString('hex') }),
  auth: (identity: IdentityStore) => createDevTokenAuth(identity, { secret: devAuthSecret }),
  signatureAudience: AUD,
  logStream: { write: (l: string) => void logLines.push(l) },
};
const app = buildServer({
  ...serverOptions,
  verificationOperatorDb: policyDb,
  achievementOperatorDb: ruleDb,
});
const appNoOperator = buildServer(serverOptions);

const run = newId().replace(/-/g, '').slice(-8);
let step = 0;
const show = (title: string, detail: unknown) =>
  console.log(
    `\n▶ ${String(++step).padStart(2, '0')}. ${title}\n   ${typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2).replaceAll('\n', '\n   ')}`,
  );
const banner = (lines: readonly string[]) => {
  const w = Math.max(...lines.map((l) => l.length)) + 4;
  console.log(`\n${'═'.repeat(w)}\n${lines.map((l) => `  ${l}`).join('\n')}\n${'═'.repeat(w)}`);
};
const bearer = (s: string, operator = false) => ({
  authorization: `Bearer ${mintDevToken(`demo8-${run}-${s}`, { secret: devAuthSecret, operator })}`,
});
const idem = () => ({ 'idempotency-key': `demo8-${newId()}` });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form navigation of JSON responses
type Json = Record<string, any>;
async function call(
  target: typeof app,
  method: 'GET' | 'POST',
  url: string,
  headers: Record<string, string> = {},
  payload?: unknown,
) {
  const res = await target.inject({
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
const failures: string[] = [];
const expectThat = (cond: boolean, what: string) => {
  if (!cond) failures.push(what);
  console.log(`   ${cond ? '✔' : '✘'} ${what}`);
};

try {
  banner(['PART A — REAL CANONICAL FLOW (development database, real /v1 surface)']);
  const health = await call(app, 'GET', '/health');
  const ready = await call(app, 'GET', '/ready');
  show('health / readiness', { health: health.body, ready: ready.body });

  const identity = new IdentityStore(db);
  const catalog = await seedTestCatalog(identity, new CatalogStore(catalogDb));
  show('real (fictional) sport catalog: exact DisciplineVersions', {
    tennisSingles: catalog.tennisSingles,
    padelDoubles: catalog.padelDoubles,
  });
  const policy = await publishPolicy(
    new VerificationPolicyStore(policyDb),
    catalog.operatorAccountId,
    catalog.tennisSingles,
  );

  // Rules through the INTERNAL API (operator flag + dedicated operator connection).
  const op = bearer('rule-operator', true);
  const winSpec: AchievementRuleSpec = {
    ...referenceTitleRule(catalog.tennisSingles),
    achievementType: 'CONTEST_WON',
    displayName: 'Match Winner',
    criterion: { kind: 'CONTEST_OUTCOME', resultScope: 'CONTEST', outcomes: ['WIN'] },
  };
  const code = `demo8-winner-${run}`;
  const created = await call(
    app,
    'POST',
    '/v1/internal/achievement-rules',
    { ...op, ...idem() },
    { code, name: 'Fictional demo match-winner rule', achievementType: 'CONTEST_WON' },
  );
  const version = await call(
    app,
    'POST',
    `/v1/internal/achievement-rules/${created.body.ruleId}/versions`,
    { ...op, ...idem() },
    { spec: winSpec },
  );
  const published = await call(
    app,
    'POST',
    `/v1/internal/achievement-rule-versions/${version.body.ruleVersionId}/publish`,
    op,
    {},
  );
  const bound = await call(
    app,
    'POST',
    `/v1/internal/achievement-rule-versions/${version.body.ruleVersionId}/bindings`,
    { ...op, ...idem() },
    {},
  );
  show('published rule (declarative, V2 · FINAL floor) bound to the exact DisciplineVersion', {
    create: created.status,
    version: { status: version.status, specHash: version.body.specHash },
    publish: published.body.status,
    binding: bound.status,
  });
  const lowFloor = await call(
    app,
    'POST',
    `/v1/internal/achievement-rules/${created.body.ruleId}/versions`,
    { ...op, ...idem() },
    {
      spec: {
        ...winSpec,
        requirements: { minimumVerificationLevel: 'V1', minimumResultStatus: 'FINAL' },
      },
    },
  );
  expectThat(
    lowFloor.status === 400 && JSON.stringify(lowFloor.body).includes('BELOW_PLATFORM_FLOOR'),
    'a rule below the BRT-01 floor (V1 contest win) is rejected (400 BELOW_PLATFORM_FLOOR)',
  );
  const noOperatorConn = await call(
    appNoOperator,
    'POST',
    '/v1/internal/achievement-rules',
    { ...op, ...idem() },
    { code: `x-${run}`, name: 'x', achievementType: 'TITLE' },
  );
  const notOperator = await call(
    app,
    'POST',
    '/v1/internal/achievement-rules',
    { ...bearer('not-operator'), ...idem() },
    { code: `y-${run}`, name: 'y', achievementType: 'TITLE' },
  );
  const forged = await call(
    app,
    'POST',
    '/v1/internal/achievement-rules',
    { authorization: 'Bearer forged.token.value', ...idem() },
    { code: `z-${run}`, name: 'z', achievementType: 'TITLE' },
  );
  expectThat(
    noOperatorConn.status === 503 && notOperator.status === 403 && forged.status === 401,
    'rule mutation: no operator connection → 503; non-operator → 403; forged auth → 401',
  );

  // Competition staff: an organizer account that owns the fictional club running the competition.
  const orgH = bearer('organizer');
  const orgAccountId = (await call(app, 'GET', '/v1/me', orgH)).body.accountId as string;
  const orgPersonId = (
    await call(app, 'POST', '/v1/persons', { ...orgH, ...idem() }, { relation: 'SELF' })
  ).body.personId as string;
  const org = (
    await call(
      app,
      'POST',
      '/v1/organizations',
      { ...orgH, ...idem() },
      {
        orgType: 'CLUB',
        slug: `demo8-club-${run}`,
        profile: { displayName: 'Fictional Achievement Club' },
      },
    )
  ).body;
  const deps = {
    db,
    identity,
    orgs: new OrganizationStore(db),
    comps: new CompetitionStore(db),
    structure: new StructureStore(db),
    authority: new AuthorityStore(db, { conflictChecker: declaredNoParticipation }),
    ledger: createCompetitionResultLedger(db, { conflictChecker: declaredNoParticipation }),
    resolver: new CompetitionHierarchyResolver(db),
    catalog,
  };
  const w = await newContestResult({
    ...deps,
    submitAs: 'ATHLETE_A',
    organizer: {
      ownerAccountId: orgAccountId,
      ownerPersonId: orgPersonId,
      organizationId: org.organizationId,
      slug: org.slug,
    },
  });
  show(
    'real Competition / Event / Contest / ResultVersion (submitted AFTER the rule took effect)',
    {
      competitionId: w.competitionId,
      resultVersionId: w.resultVersionId,
      contentHash: w.contentHash,
    },
  );
  const attestations = new AttestationStore(db, { audience: AUD });
  const ceremony = new PrincipalKeyCeremony(db, { audience: AUD });
  const B = await personSigner(
    { db, ceremony, attestations },
    w.athletes[1] as NonNullable<(typeof w.athletes)[1]>,
  );
  for (let i = 1; ; i++) {
    try {
      await B.attest(w.resultVersionId, { type: 'RESULT_ACCURATE', polarity: 'AFFIRM' });
      break;
    } catch (err) {
      if ((err as { code?: string }).code !== 'KEY_NOT_VALID' || i >= 4) throw err;
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
  const evalRun = await call(
    app,
    'POST',
    `/v1/result-versions/${w.resultVersionId}/verification-runs`,
    orgH,
    {},
  );
  const current = await call(app, 'GET', `/v1/result-versions/${w.resultVersionId}/verification`);
  show('current VerificationRun (real, counterparty-corroborated)', {
    runId: evalRun.body.runId,
    level: current.body.level,
    label: current.body.label,
    freshness: current.body.freshness,
    policy: policy.code,
  });
  const publicRule = await call(app, 'GET', `/v1/achievement-rules/${code}`);
  show('published Achievement rule (public, declarative)', {
    code,
    versions: publicRule.body.versions?.length,
    status: publicRule.body.versions?.[0]?.status,
  });

  const derivation = await call(
    app,
    'POST',
    `/v1/result-versions/${w.resultVersionId}/achievement-derivations`,
    orgH,
    {},
  );
  const mine = (derivation.body.rules as Json[]).find((r) => r.ruleCode === code);
  show('real AchievementDerivationSnapshot → pure engine → outcome', {
    provenance: derivation.body.provenance,
    snapshotHash: mine?.snapshotHash,
    outcomeHash: mine?.outcomeHash,
    wouldQualifyOnSportingFacts: mine?.wouldQualify,
    state: mine?.state,
    blockedBy: mine?.blockedBy,
  });
  expectThat(mine?.wouldQualify === 1, 'the rule MATCHES the sporting facts (the winner exists)');
  expectThat(
    mine?.state === 'BLOCKED' &&
      (mine?.blockedBy as string[]).includes('VERIFICATION_LEVEL_BELOW_REQUIRED'),
    'verification floor: real V1 < required V2 → VERIFICATION_LEVEL_BELOW_REQUIRED',
  );
  expectThat(
    (mine?.blockedBy as string[]).includes('RESULT_STATUS_BELOW_REQUIRED'),
    'status floor: SUBMITTED < FINAL (no T5/T6 producer) → RESULT_STATUS_BELOW_REQUIRED',
  );
  expectThat(
    (mine?.blockedBy as string[]).includes('HOLD_STATE_UNAVAILABLE'),
    'hold facts have no producer → HOLD_STATE_UNAVAILABLE (never assumed "no hold")',
  );
  const { rows: persisted } = await sql<{
    n: number;
  }>`SELECT count(*)::int AS n FROM achievement.achievement WHERE competition_id = ${w.competitionId}`.execute(
    owner,
  );
  expectThat(
    persisted[0]?.n === 0,
    'ZERO V2-gated Achievements persisted from real production facts (honest ceiling)',
  );

  // Stale verification: a new real fact after the run makes the pinned run STALE → derivation blocked.
  await B.attest(w.resultVersionId, { type: 'RESULT_ACCURATE', polarity: 'AFFIRM' });
  const freshness = (
    await call(app, 'GET', `/v1/result-versions/${w.resultVersionId}/verification`)
  ).body.freshness;
  const stale = await call(
    app,
    'POST',
    `/v1/result-versions/${w.resultVersionId}/achievement-derivations`,
    orgH,
    {},
  );
  const staleMine = (stale.body.rules as Json[]).find((r) => r.ruleCode === code);
  show('a newer real attestation after the run → BRT-07 freshness STALE → no new Achievement', {
    freshness,
    blockedBy: staleMine?.blockedBy,
  });
  expectThat(
    freshness === 'STALE' && (staleMine?.blockedBy as string[]).includes('VERIFICATION_STALE'),
    'STALE verification blocks issuance (VERIFICATION_STALE)',
  );

  const bypass = [
    await call(
      app,
      'POST',
      `/v1/result-versions/${w.resultVersionId}/achievement-derivations`,
      orgH,
      { achievementType: 'TITLE', holderId: newId(), force: true },
    ),
    await call(
      app,
      'POST',
      `/v1/result-versions/${w.resultVersionId}/achievement-derivations`,
      orgH,
      { qualifyingValue: '300', desiredVerificationLevel: 'V2', override: true },
    ),
    await call(app, 'POST', '/v1/achievements', op, { achievementType: 'TITLE' }),
    await call(app, 'POST', '/v1/internal/achievements', op, { holderId: newId() }),
  ];
  show(
    'manual bypass attempts',
    bypass.map((b) => b.status),
  );
  expectThat(
    bypass[0]?.status === 400 &&
      bypass[1]?.status === 400 &&
      bypass[2]?.status === 404 &&
      bypass[3]?.status === 404,
    'no manual Achievement path: closed bodies → 400, no award route → 404',
  );
  const { rows: events } = await sql<{ event_type: string }>`
    SELECT DISTINCT event_type FROM platform.outbox_event
    WHERE event_type ~* '(recordmark|currentrecordchanged|trophy|prize|ranking|qualif|mint)'`.execute(
    owner,
  );
  expectThat(
    events.length === 0,
    'no RecordMark / Trophy / Prize / Ranking / Qualification / Mint consequence event exists',
  );

  // ───────────────────────────── PART B ─────────────────────────────
  banner([`PART B — ${FIXTURE_LABEL}`, 'in memory only; never written to any database']);
  const titleD = deriveAchievements(padelTitleFixture());
  const titleC = titleD.outcome.candidates?.[0]?.candidate;
  show('synthetic CURRENT V2 · FINAL pair classification → ONE TEAM title candidate', {
    state: titleD.outcome.state,
    candidates: titleD.outcome.candidates?.length,
    holder: titleC?.holder,
    memberCredits: titleC?.memberCredits,
  });
  expectThat(
    titleD.outcome.candidates?.length === 1 && titleC?.holder.holderId === FX.teamA,
    'exactly one TEAM Achievement candidate (Pair A); no athlete copies',
  );
  const credited = (titleC?.memberCredits ?? []).map((m) => m.athleteId);
  expectThat(
    credited.length === 2 && !credited.includes(FX.unusedRosterAthlete),
    'member credits = exact credited lineup (A1, A2); the unused roster member is not credited',
  );
  const pg = deriveAchievements(thresholdFixture());
  const pg299 = deriveAchievements(thresholdFixture({ value: '299' }));
  show('synthetic threshold fixture (sport-neutral engine; fictional bowling-like data)', {
    perfect: {
      state: pg.outcome.state,
      qualifyingValue: pg.outcome.candidates?.[0]?.candidate.qualifyingValue,
    },
    '299': { state: pg299.outcome.state },
  });
  expectThat(
    pg.outcome.candidates?.length === 1 && (pg299.outcome.candidates ?? []).length === 0,
    '300 ≥ 300 passes; 299 does not',
  );
  const pb = deriveAchievements(
    personalBestFixture({
      kind: 'RUNNING',
      value: '1190000',
      priors: [{ value: '1200000', minute: 1 }],
    }),
  );
  show('synthetic personal best (lower is better; comparison-set hash pinned)', {
    state: pb.outcome.state,
    comparisonSetHash: pb.outcome.candidates?.[0]?.candidate.comparisonSetHash,
  });
  const again = deriveAchievements(padelTitleFixture());
  const reordered = padelTitleFixture();
  const rev: AchievementDerivationSnapshot = {
    ...reordered,
    entries: [...reordered.entries].reverse(),
    participants: [...reordered.participants].reverse(),
    creditedLineups: [...(reordered.creditedLineups ?? [])]
      .reverse()
      .map((l) => ({ ...l, athleteIds: [...l.athleteIds].reverse() })),
  };
  expectThat(
    again.outcomeHash === titleD.outcomeHash &&
      deriveAchievements(rev).outcomeHash === titleD.outcomeHash,
    'deterministic: same / reordered inputs ⇒ identical candidate hashes and trace',
  );
  const v1 = deriveAchievements(padelTitleFixture({ level: 'V1' }));
  const st = deriveAchievements(padelTitleFixture({ verificationState: 'STALE' }));
  show('lower verification to V1 / mark it STALE', {
    v1: v1.outcome.gates.filter((g) => g.status === 'FAIL'),
    stale: st.outcome.gates.filter((g) => g.status === 'FAIL'),
  });
  const { rows: fx } = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM achievement.achievement WHERE snapshot_provenance <> 'CANONICAL_ASSEMBLY'
       OR holder_id IN (${FX.teamA}, ${FX.teamB}, ${FX.bowler}, ${FX.runner})`.execute(owner);
  expectThat(
    fx[0]?.n === 0,
    'fixture candidates never enter canonical Achievement storage (development DB)',
  );

  // ───────────────────────────── PART C ─────────────────────────────
  banner([
    ...FIXTURE_ENVIRONMENT_BANNER,
    'separate throwaway database — the development DB is never touched',
  ]);
  const normal = await createFixturePersistenceEnvironment({ overlay: false });
  try {
    const r = await publishAchievementRule(
      normal.rules,
      normal.operatorAccountId,
      referenceTitleRule(normal.dv.padel),
    );
    const rejected = await persistDerivation(normal.api, {
      snapshot: padelTitleFixture({
        disciplineVersionId: normal.dv.padel,
        ruleSpec: referenceTitleRule(normal.dv.padel),
        ruleIdentity: r,
      }),
    }).then(
      () => 'ACCEPTED',
      (err: { code?: string; constraint?: string }) => `${err.code} ${err.constraint}`,
    );
    show(`normal migrated schema (${normal.database}): REFERENCE_FIXTURE persistence`, rejected);
    expectThat(
      rejected.startsWith('23514 achievement_canonical_provenance_only'),
      'the NORMAL schema rejects REFERENCE_FIXTURE at the database boundary',
    );
  } finally {
    await normal.destroy();
  }
  const env = await createFixturePersistenceEnvironment({ overlay: true });
  try {
    show('throwaway database with the TEST-ONLY overlay', env.database);
    const rule = await publishAchievementRule(
      env.rules,
      env.operatorAccountId,
      referenceTitleRule(env.dv.padel),
    );
    const title = (o: Parameters<typeof padelTitleFixture>[0] = {}) =>
      padelTitleFixture({
        ...o,
        disciplineVersionId: env.dv.padel,
        ruleSpec: referenceTitleRule(env.dv.padel),
        ruleIdentity: rule,
      });
    const first = await persistDerivation(env.api, { snapshot: title({ rv: 'demo1' }) });
    const a = first.achievements[0];
    show('persist through the validated BRT-08 path', {
      created: a?.created,
      holder: a?.holder,
      memberCredits: a?.memberCredits,
    });
    const repeat = await persistDerivation(env.api, { snapshot: title({ rv: 'demo1' }) });
    expectThat(
      repeat.achievements[0]?.achievementId === a?.achievementId &&
        repeat.achievements[0]?.created === false,
      'repeat → the same logical Achievement',
    );
    const conc = await Promise.all(
      Array.from({ length: 20 }, () =>
        persistDerivation(env.api, { snapshot: title({ rv: 'demo-conc' }) }),
      ),
    );
    const ids = new Set(conc.flatMap((c) => c.achievements.map((x) => x.achievementId)));
    const [cid] = [...ids];
    const { rows: n } = await sql<{ c: number; m: number }>`
      SELECT (SELECT count(*)::int FROM achievement.achievement WHERE id = ${cid}) AS c,
             (SELECT count(*)::int FROM achievement.member_credit WHERE achievement_id = ${cid}) AS m`.execute(
      env.owner,
    );
    expectThat(
      ids.size === 1 && n[0]?.c === 1 && n[0]?.m === 2,
      '20 concurrent derivations → 1 TEAM Achievement + 2 immutable member credits',
    );
    const basis =
      await sql`SELECT result_version_id, content_hash, verification_run_id, pinned_run_level, participant_id FROM achievement.basis_item WHERE achievement_id = ${a?.achievementId}`.execute(
        env.owner,
      );
    show('exact basis', basis.rows);
    const dep = await inTransaction(env.api, ModuleRole.achievements, (ctx) =>
      dependencyIndex(ctx, { resultVersionId: fixtureId('result-version:demo1') }),
    );
    show('dependency index: Achievements depending on ResultVersion demo1', dep);
    const before =
      await sql`SELECT candidate_hash, candidate FROM achievement.achievement WHERE id = ${a?.achievementId}`.execute(
        env.owner,
      );
    const corrected = await persistDerivation(env.api, {
      snapshot: title({ rv: 'demo2', supersedes: 'demo1' }),
    });
    const cardA = await sql<{
      status: string;
    }>`SELECT status FROM achievement_read.achievement_card WHERE achievement_id = ${a?.achievementId}`.execute(
      env.owner,
    );
    const after =
      await sql`SELECT candidate_hash, candidate FROM achievement.achievement WHERE id = ${a?.achievementId}`.execute(
        env.owner,
      );
    show('corrected basis (fixture: demo2 supersedes demo1)', {
      newAchievement: corrected.achievements[0]?.achievementId,
      supersedes: corrected.achievements[0]?.supersedes,
      oldStatus: cardA.rows[0]?.status,
    });
    expectThat(
      cardA.rows[0]?.status === 'SUPERSEDED' &&
        JSON.stringify(before.rows) === JSON.stringify(after.rows),
      'old Achievement unchanged; its current projection is SUPERSEDED; the new one has the new basis',
    );
    const revoked = await persistDerivation(env.api, { snapshot: title({ rv: 'demo-rev' }) });
    const rid = revoked.achievements[0]?.achievementId as string;
    const rs = await recordSupportAssessment(env.api, {
      provenance: 'REFERENCE_FIXTURE',
      achievementId: rid,
      requiredLevel: 'V2',
      basis: [
        {
          resultVersionId: fixtureId('result-version:demo-rev'),
          pinnedRunId: fixtureId('run:demo-rev:run1'),
          status: 'REVOKED',
          verification: {
            state: 'CURRENT',
            runId: fixtureId('run:demo-rev:run1'),
            level: 'V2',
            snapshotHash: fixtureHash('verification-snapshot:demo-rev:run1'),
            outcomeHash: fixtureHash('verification-outcome:demo-rev:run1'),
          },
        },
      ],
      holdSupported: true,
      holdActive: false,
    });
    expectThat(
      rs.status === 'REVOKED',
      'revoked basis (fixture state) → current support REVOKED; the row stays',
    );
    const rm1 = await snapshotAchievementReadModels(env.api);
    await rebuildAchievementReadModels(env.maintenance);
    const rm2 = await snapshotAchievementReadModels(env.api);
    expectThat(
      JSON.stringify(rm1) === JSON.stringify(rm2),
      'read models rebuilt through the maintenance login → identical output',
    );
  } finally {
    await env.destroy();
    show('throwaway database destroyed', env.database);
  }

  // ───────────────────────────── privacy / leak scan ─────────────────────────────
  const { rows: outbox } = await sql<{
    payload: unknown;
  }>`SELECT payload FROM platform.outbox_event WHERE event_type LIKE 'Achievement%'`.execute(owner);
  const blob = JSON.stringify({ outbox, logLines, rules: publicRule.body });
  const leaks = [
    /@example\.test/,
    /Bearer [A-Za-z0-9._-]{20,}/,
    /dateOfBirth/,
    /legalName/,
    /privateKey|"d":/,
  ].filter((re) => re.test(blob));
  expectThat(
    leaks.length === 0,
    'leak scan (outbox, logs, public DTOs): no email, token, DOB, legal name or key material',
  );
} finally {
  await Promise.all([app.close(), appNoOperator.close()]);
  await Promise.all([db, owner, catalogDb, policyDb, ruleDb, vaultDb].map((d) => d.destroy()));
}
console.log(
  failures.length === 0
    ? '\nBRT-08 demo: all checks passed.'
    : `\nBRT-08 demo: ${failures.length} check(s) FAILED:\n  ${failures.join('\n  ')}`,
);
if (failures.length > 0) process.exit(1);
