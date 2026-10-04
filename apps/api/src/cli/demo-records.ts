import { randomBytes } from 'node:crypto';
import { referenceRecordSetRule } from '@br/achievements';
import { newId, type RecordScopeType } from '@br/domain';
import { createDevelopmentPiiCipher } from '@br/identity';
import { evaluateRecord, recordBlockingReasons, replayRecordHistory } from '@br/records';
import {
  authorityWorld,
  categorySpec,
  fixtureCategory,
  RECORD_FIXTURE_LABEL,
  recordSnapshot,
  rfxHash,
  rfxId,
  rfxTime,
  standingMark,
  type AuthorityWorldOptions,
  type CategoryFixtureOptions,
  type PerformanceFixture,
} from '@br/records/fixtures';
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
  ModuleRole,
  operatorDatabaseUrl,
  OrganizationStore,
  PrincipalKeyCeremony,
  rebuildRecordReadModels,
  recordDependencyIndex,
  recordOperatorDatabaseUrl,
  snapshotRecordReadModels,
  StructureStore,
  verificationOperatorDatabaseUrl,
  VerificationPolicyStore,
} from '@br/persistence';
import { persistDerivation } from '@br/persistence/achievement-lanes';
import {
  persistRecordEvaluation,
  recordMarkSupportAssessment,
  standingMarksAt,
} from '@br/persistence/record-lanes';
import {
  awaitDbTimePast,
  brt10ConsequenceFootprint,
  declaredNoParticipation,
  newContestResult,
  personSigner,
  publishPolicy,
  retryOnClockStep,
  seedTestCatalog,
} from '@br/testkit';
import { publishAchievementRule } from '@br/testkit/achievements';
import {
  createRecordFixtureEnvironment,
  futureInstant,
  plusMinutes,
  publishRecordCategory,
  RECORD_FIXTURE_ENVIRONMENT_BANNER,
  recordSetSnapshotFor,
} from '@br/testkit/records';
import { sql } from 'kysely';
import { createDevTokenAuth, mintDevToken } from '../auth';
import { buildServer } from '../server';

/**
 * BRT-09 acceptance walkthrough. ALL DATA IS FICTIONAL. Development only. No built-in secrets.
 *
 *   PART A — REAL CANONICAL FLOW (development database, real /v1 surface): a published RecordCategory,
 *            a real ResultVersion with real Performances, a real VerificationRun (V1 at best) → the
 *            performance is evaluated against the category but FINAL / V3 / hold facts are unmet →
 *            ZERO RecordMarks, ZERO ratifications, exact blockers. No fake V3 / V4 / RECORD_RATIFIED.
 *   PART B — REFERENCE ENGINE FIXTURE — NOT PERSISTED SPORTING TRUTH (in memory only).
 *   PART C — REFERENCE FIXTURE PERSISTENCE ENVIRONMENT (a THROWAWAY database with the test-only
 *            overlays, destroyed at the end): BRT-09's own persistence mechanics. Never the dev DB.
 * Run: pnpm db:up && pnpm db:bootstrap && pnpm db:migrate && pnpm demo:records
 */
if (process.env.NODE_ENV === 'production') throw new Error('the demo refuses production');
const devAuthSecret = randomBytes(32).toString('hex');
const AUD = 'bragging-rights:development';
const urls = databaseUrls();
const db = createDb(urls.api);
const owner = createDb(urls.owner, { max: 2 });
const catalogUrl = operatorDatabaseUrl();
const policyUrl = verificationOperatorDatabaseUrl();
const recordUrl = recordOperatorDatabaseUrl();
if (catalogUrl === undefined || policyUrl === undefined || recordUrl === undefined)
  throw new Error('the demo needs the operator database URLs');
const catalogDb = createDb(catalogUrl, { max: 2 });
const policyDb = createDb(policyUrl, { max: 2 });
const recordOpDb = createDb(recordUrl, { max: 2 });
const vaultDb = createDb(urls.vault, { max: 2 });
const serverOptions = {
  db,
  vaultDb,
  piiCipher: createDevelopmentPiiCipher({ keyMaterial: randomBytes(32).toString('hex') }),
  auth: (identity: IdentityStore) => createDevTokenAuth(identity, { secret: devAuthSecret }),
  signatureAudience: AUD,
  logStream: { write: () => undefined },
};
const app = buildServer({
  ...serverOptions,
  verificationOperatorDb: policyDb,
  recordOperatorDb: recordOpDb,
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
  authorization: `Bearer ${mintDevToken(`demo9-${run}-${s}`, { secret: devAuthSecret, operator })}`,
});
const idem = () => ({ 'idempotency-key': `demo9-${newId()}` });
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
    body: (res.headers['content-type']?.toString().includes('json') ? res.json() : null) as Json,
  };
}
const failures: string[] = [];
const expectThat = (cond: boolean, what: string) => {
  if (!cond) failures.push(what);
  console.log(`   ${cond ? '✔' : '✘'} ${what}`);
};

try {
  // ═══════════════════════════════ PART A ═══════════════════════════════
  banner(['PART A — REAL CANONICAL FLOW (development database, real /v1 surface)']);
  const brt10Before = await brt10ConsequenceFootprint(owner);
  const health = await call(app, 'GET', '/health');
  const ready = await call(app, 'GET', '/ready');
  show('health / readiness', { health: health.body, ready: ready.body });

  const identity = new IdentityStore(db);
  const catalog = await seedTestCatalog(identity, new CatalogStore(catalogDb));
  const policy = await publishPolicy(
    new VerificationPolicyStore(policyDb),
    catalog.operatorAccountId,
    catalog.timedSingles,
  );
  const { rows: dvRows } = await sql<{ sport: string }>`
    SELECT s.code AS sport FROM sports.discipline_version v JOIN sports.discipline d ON d.id = v.discipline_id
    JOIN sports.sport s ON s.id = d.sport_id WHERE v.id = ${catalog.timedSingles}`.execute(owner);
  const sport = dvRows[0]?.sport as string;

  const op = bearer('record-operator', true);
  const code = `demo9-platform-${run}`;
  const effectiveFrom = futureInstant(4);
  const spec = categorySpec({
    scopeType: 'PLATFORM',
    disciplineVersionId: catalog.timedSingles,
    sportCode: sport,
    effectiveFrom,
  });
  const created = await call(
    app,
    'POST',
    '/v1/internal/record-categories',
    { ...op, ...idem() },
    { code, name: 'Fictional platform best (timed duel)', scopeType: 'PLATFORM' },
  );
  const version = await call(
    app,
    'POST',
    `/v1/internal/record-categories/${created.body.categoryId}/versions`,
    { ...op, ...idem() },
    { spec },
  );
  const published = await call(
    app,
    'POST',
    `/v1/internal/record-category-versions/${version.body.categoryVersionId}/publish`,
    op,
    {},
  );
  show('published RecordCategory (declarative universe, PLATFORM · V3 · FINAL floor)', {
    code,
    create: created.status,
    version: { status: version.status, specHash: version.body.specHash },
    lifecycle: published.body.status,
    effectiveFrom,
  });
  const lowFloor = await call(
    app,
    'POST',
    `/v1/internal/record-categories/${created.body.categoryId}/versions`,
    { ...op, ...idem() },
    {
      spec: {
        ...spec,
        requirements: { minimumVerificationLevel: 'V2', minimumResultStatus: 'FINAL' },
      },
    },
  );
  expectThat(
    lowFloor.status === 400 && JSON.stringify(lowFloor.body).includes('BELOW_PLATFORM_FLOOR'),
    'a category below the BRT-01 floor (V2 PLATFORM without review) is rejected',
  );
  const noConn = await call(
    appNoOperator,
    'POST',
    '/v1/internal/record-categories',
    { ...op, ...idem() },
    { code: `x-${run}`, name: 'x', scopeType: 'PLATFORM' },
  );
  const notOp = await call(
    app,
    'POST',
    '/v1/internal/record-categories',
    { ...bearer('not-op'), ...idem() },
    { code: `y-${run}`, name: 'y', scopeType: 'PLATFORM' },
  );
  expectThat(
    noConn.status === 503 && notOp.status === 403,
    'category mutation: no operator connection → 503; non-operator → 403',
  );

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
        slug: `demo9-club-${run}`,
        profile: { displayName: 'Fictional Record Club' },
      },
    )
  ).body;
  const w = await newContestResult({
    db,
    identity,
    orgs: new OrganizationStore(db),
    comps: new CompetitionStore(db),
    structure: new StructureStore(db),
    authority: new AuthorityStore(db, { conflictChecker: declaredNoParticipation }),
    ledger: createCompetitionResultLedger(db, { conflictChecker: declaredNoParticipation }),
    resolver: new CompetitionHierarchyResolver(db),
    catalog,
    submitAs: 'ATHLETE_A',
    organizer: {
      ownerAccountId: orgAccountId,
      ownerPersonId: orgPersonId,
      organizationId: org.organizationId,
      slug: org.slug,
    },
    timed: { winnerMs: '10870', loserMs: '11020', startAfter: effectiveFrom },
  });
  show(
    'real Competition / Event / Contest (started after the category took effect) / ResultVersion with real Performances',
    {
      competitionId: w.competitionId,
      resultVersionId: w.resultVersionId,
      performances: ['10870 ms', '11020 ms'],
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
  await awaitDbTimePast(db, effectiveFrom);
  await retryOnClockStep(async () => {
    const r = await call(
      app,
      'POST',
      `/v1/result-versions/${w.resultVersionId}/verification-runs`,
      orgH,
      {},
    );
    if (r.status === 503)
      throw Object.assign(new Error('clock step'), { code: 'VERIFICATION_TIME_INCONSISTENT' });
    return r;
  });
  const current = await call(app, 'GET', `/v1/result-versions/${w.resultVersionId}/verification`);
  show('exact current Verification (real, counterparty-corroborated)', {
    level: current.body.level,
    label: current.body.label,
    policy: policy.code,
  });
  show('category floor', {
    scope: 'PLATFORM',
    minimumVerificationLevel: 'V3',
    minimumResultStatus: 'FINAL',
    holdBlocks: true,
  });
  const evaluation = await call(
    app,
    'POST',
    `/v1/result-versions/${w.resultVersionId}/record-evaluations`,
    orgH,
    {},
  );
  const mine = (evaluation.body.evaluations as Json[]).filter((e) => e.categoryCode === code);
  show(
    'canonical record evaluation of every performance (logged, idempotent)',
    mine.map((e) => ({
      state: e.state,
      blockedBy: e.blockedBy,
      recordMarkId: e.recordMarkId ?? null,
    })),
  );
  expectThat(
    mine.length === 2 && mine.every((e) => e.state === 'PENDING_REQUIRED_FACTS'),
    'both performances: PENDING_REQUIRED_FACTS (the facts match the universe, the floors do not)',
  );
  expectThat(
    mine.every((e) =>
      [
        'VERIFICATION_LEVEL_BELOW_REQUIRED',
        'RESULT_STATUS_BELOW_REQUIRED',
        'HOLD_STATE_UNAVAILABLE',
      ].every((b) => e.blockedBy.includes(b)),
    ),
    'exact blockers: V1 < V3, SUBMITTED < FINAL, hold facts unavailable',
  );
  const forced = await call(
    app,
    'POST',
    `/v1/result-versions/${w.resultVersionId}/record-evaluations`,
    orgH,
    { value: '1', ratified: true, force: true },
  );
  expectThat(
    forced.status === 400,
    'no manual record path: a body naming value / ratified / force is rejected (400)',
  );
  const { rows: marks } = await sql<{
    n: number;
  }>`SELECT count(*)::int AS n FROM record.record_mark m JOIN record.category c ON c.id = m.category_id WHERE c.code = ${code}`.execute(
    owner,
  );
  expectThat(marks[0]?.n === 0, 'no high-scope (or any) RecordMark is falsely persisted: 0 marks');
  const { rows: ratRows } = await sql<{
    n: number;
  }>`SELECT count(*)::int AS n FROM record.mark_status_entry WHERE ratification_ref IS NOT NULL`.execute(
    owner,
  );
  const { rows: fx } = await sql<{
    n: number;
  }>`SELECT (SELECT count(*) FROM record.record_mark WHERE provenance <> 'CANONICAL_ASSEMBLY') + (SELECT count(*) FROM record.evaluation WHERE provenance <> 'CANONICAL_ASSEMBLY')::int AS n`.execute(
    owner,
  );
  let attestationRefused = false;
  try {
    await sql`INSERT INTO attestation.attestation (claim_type) VALUES ('RECORD_RATIFIED')`.execute(
      owner,
    );
  } catch {
    attestationRefused = true;
  }
  expectThat(
    ratRows[0]?.n === 0 && attestationRefused,
    'no fake ratification: 0 ratifications, and BRT-06 admits no RECORD_RATIFIED claim (producer deferred)',
  );
  expectThat(Number(fx[0]?.n) === 0, 'no fixture row exists in the development database');
  const cur = await call(app, 'GET', `/v1/record-categories/${code}/current`);
  const hof = await call(app, 'GET', `/v1/hall-of-fame/records?category=${code}`);
  expectThat(
    cur.body.status === 'NO_CURRENT_RECORD' && hof.body.items.length === 0,
    'public: no current record, empty Record Hall of Fame for the category',
  );
  // BRT-10 schemas exist (0023–0030): the evidence is the footprint of Part A, not a missing schema.
  const brt10After = await brt10ConsequenceFootprint(owner);
  show('BRT-10 / consequence footprint of Part A', { before: brt10Before, after: brt10After });
  expectThat(
    JSON.stringify(brt10After) === JSON.stringify(brt10Before) &&
      brt10After.consequenceSchemas === 0,
    'no Ranking / Qualification / Prize / Trophy side effect: Part A created no snapshot, classification, QUALIFIED, qualification link or consequence event (and no prize / trophy / payout schema exists)',
  );

  // ═══════════════════════════════ PART B ═══════════════════════════════
  banner([
    'PART B — REFERENCE ENGINE FIXTURE — NOT PERSISTED SPORTING TRUTH',
    RECORD_FIXTURE_LABEL,
  ]);
  const cat = (o: CategoryFixtureOptions, label: string) => fixtureCategory(categorySpec(o), label);
  const est = (
    c: ReturnType<typeof cat>,
    p: PerformanceFixture,
    extra: Record<string, unknown> = {},
  ) => evaluateRecord(recordSnapshot({ category: c, performance: p, ...extra } as never)).outcome;
  const rat = (
    c: ReturnType<typeof cat>,
    p: PerformanceFixture,
    r: PerformanceFixture,
    world: AuthorityWorldOptions = {},
    extra: Record<string, unknown> = {},
  ) => {
    const hash =
      evaluateRecord(recordSnapshot({ category: c, performance: p })).outcome.candidate
        ?.candidateHash ?? rfxHash('none');
    return evaluateRecord(
      recordSnapshot({
        category: c,
        performance: r,
        pending: { recordMarkId: rfxId(`p:${p.rv}`), markHash: hash },
        world: authorityWorld(c.spec, world),
        ...extra,
      } as never),
    ).outcome;
  };
  const line = (
    label: string,
    o: {
      state: string;
      markStatus?: string;
      gates: readonly { status: string; reasons?: readonly string[] }[];
    },
  ) =>
    console.log(
      `   · ${label.padEnd(58)} ${o.state}${o.markStatus === undefined ? '' : ` (${o.markStatus})`}${
        o.state === 'QUALIFIES'
          ? ''
          : ` — ${recordBlockingReasons(o as never)
              .slice(0, 3)
              .join(', ')}`
      }`,
    );
  const running = cat({}, 'b-comp');
  const bowling = cat({ sport: 'bowling', population: { handicapMode: 'SCRATCH' } }, 'b-scratch');
  line(
    'LOWER_IS_BETTER 10.95 vs record 10.90',
    est(
      running,
      { rv: 'b1', value: '10950', minute: 30 },
      { currentMarks: [standingMark(running.spec, 'r', '10900', 20)] },
    ),
  );
  line(
    'LOWER_IS_BETTER 10.80 vs record 10.90',
    est(
      running,
      { rv: 'b2', value: '10800', minute: 30 },
      { currentMarks: [standingMark(running.spec, 'r', '10900', 20)] },
    ),
  );
  line(
    'HIGHER_IS_BETTER 720 pins (SCRATCH fact)',
    est(
      bowling,
      { rv: 'b3', value: '720', minute: 3 },
      { population: { HANDICAP_MODE: 'SCRATCH' } },
    ),
  );
  line(
    'HANDICAP value into SCRATCH category',
    est(
      bowling,
      { rv: 'b4', value: '760', minute: 3 },
      { population: { HANDICAP_MODE: 'HANDICAP' } },
    ),
  );
  line(
    'unknown handicap state (never assumed scratch)',
    est(bowling, { rv: 'b5', value: '760', minute: 3 }),
  );
  const first = cat({ scopeType: 'PLATFORM', tiePolicy: 'FIRST_ACHIEVED' }, 'b-first');
  line(
    'FIRST_ACHIEVED: equal later 10.90',
    est(
      first,
      { rv: 'b6', value: '10900', minute: 30 },
      { currentMarks: [standingMark(first.spec, 'f', '10900', 20)] },
    ),
  );
  line(
    'SHARED: equal later 10.90',
    est(
      running,
      { rv: 'b7', value: '10900', minute: 30 },
      { currentMarks: [standingMark(running.spec, 's', '10900', 20)] },
    ),
  );
  for (const st of [
    'VENUE',
    'COMPETITION',
    'LEAGUE',
    'PLATFORM',
    'NATIONAL',
    'CONTINENTAL',
    'WORLD',
  ] as RecordScopeType[]) {
    const c = cat({ scopeType: st }, `b-${st.toLowerCase()}`);
    const v4 = st === 'NATIONAL' || st === 'CONTINENTAL' || st === 'WORLD';
    const p = { rv: `s-${st}`, value: '10000', minute: 3, level: 'V3' as const };
    line(`${st}: establish (claim)`, est(c, p));
    line(
      `${st}: ratify by an authority covering the scope${v4 ? ' at CURRENT V4' : ''}`,
      rat(c, p, { ...p, ...(v4 ? { level: 'V4' as const } : {}) }),
    );
  }
  const nat = cat({ scopeType: 'NATIONAL', region: ['CR'], canonicalKeeper: true }, 'b-nat');
  const np = { rv: 'n', value: '10000', minute: 3, level: 'V3' as const };
  line(
    'NATIONAL(CR) ratified by NATIONAL(PE) authority',
    rat(nat, np, { ...np, level: 'V4' }, { anchorRegion: ['PE'], grantRegion: ['PE'] }),
  );
  line(
    'NATIONAL(CR) ratified by a wrong-sport authority',
    rat(nat, np, { ...np, level: 'V4' }, { anchorSport: ['padel'], grantSport: ['padel'] }),
  );
  line(
    'NATIONAL(CR) ratified by a PLATFORM authority',
    rat(nat, np, { ...np, level: 'V4' }, { anchorLevel: 'PLATFORM', platformAnchor: true }),
  );
  line('NATIONAL(CR) ratification at V3 (V4 not established)', rat(nat, np, np));
  line(
    'NATIONAL(CR) by the designated canonical keeper at V4',
    rat(nat, np, { ...np, level: 'V4' }, { ratifierIsKeeper: true }),
  );
  line(
    'conditions: wind 2.1 > 2.0 m/s',
    est(
      cat(
        { conditions: [{ aspect: 'WIND', requirement: 'MAXIMUM', limit: '2.0', unit: 'm/s' }] },
        'b-wind',
      ),
      { rv: 'w', value: '10000', minute: 3 },
      { conditions: [{ aspect: 'WIND', compliant: true, value: '2.1', unit: 'm/s' }] },
    ),
  );
  line('admitted hold', est(running, { rv: 'h', value: '10000', minute: 3 }, { hold: true }));
  line(
    'verification floor: V2 into a V3 category',
    est(running, { rv: 'v', value: '10000', minute: 3, level: 'V2' }),
  );
  const replay = replayRecordHistory({
    categoryId: rfxId('b-replay'),
    tiePolicy: 'SHARED',
    comparator: 'LOWER_IS_BETTER',
    marks: ['A:10000:1', 'B:9900:2:x', 'C:9800:3', 'D:9700:4:x'].map((s) => {
      const [l, v, m, x] = s.split(':');
      return {
        recordMarkId: rfxId(`m:${l}`),
        value: { metricId: 'athletics.100m.time', value: v as string, unit: 'ms', precision: 0 },
        effectiveFrom: rfxTime(Number(m)),
        ratifiedSeq: Number(m),
        standing: 'RATIFIED' as const,
        valid: x === undefined,
      };
    }),
  });
  expectThat(
    JSON.stringify(replay.current) === JSON.stringify([rfxId('m:C')]),
    'chronological replay: A, B, C, D with B and D invalid ⇒ C current',
  );

  // ═══════════════════════════════ PART C ═══════════════════════════════
  banner([...RECORD_FIXTURE_ENVIRONMENT_BANNER]);
  const env = await createRecordFixtureEnvironment({ overlay: true });
  try {
    show('throwaway database', { database: env.database, overlay: env.overlay });
    const rsRule = await publishAchievementRule(
      env.rules,
      env.operatorAccountId,
      referenceRecordSetRule(env.dv.running.id),
    );
    const newCat = async (o: CategoryFixtureOptions) => {
      const s = categorySpec({
        scopeType: 'PLATFORM',
        ...o,
        disciplineVersionId: env.dv.running.id,
        sportCode: env.dv.running.sport,
        effectiveFrom: futureInstant(20),
      });
      const c = await publishRecordCategory(env.categories, env.operatorAccountId, s);
      return { spec: s, category: { ...c, spec: s, lifecycle: 'PUBLISHED' as const } };
    };
    type Cat = Awaited<ReturnType<typeof newCat>>;
    const snapshot = async (
      c: Cat,
      p: PerformanceFixture,
      extra: Record<string, unknown> = {},
      exclude?: string,
    ) => {
      const occurredAt = plusMinutes(c.spec.effectiveFrom, p.minute);
      const currentMarks = await standingMarksAt(env.api, {
        categoryId: c.category.categoryId,
        tiePolicy: c.spec.tiePolicy,
        comparator: 'LOWER_IS_BETTER',
        at: occurredAt,
        provenance: 'REFERENCE_FIXTURE',
        ...(exclude === undefined ? {} : { excludeMarkId: exclude }),
      });
      return recordSnapshot({
        category: c.category,
        performance: { ...p, occurredAt },
        discipline: { sport: env.dv.running.sport, discipline: env.dv.running.discipline },
        currentMarks,
        ...extra,
      } as never);
    };
    const hashOf = async (id: string) =>
      (
        await sql<{
          h: string;
        }>`SELECT mark_hash AS h FROM record.record_mark WHERE id = ${id}`.execute(env.owner)
      ).rows[0]?.h as string;
    const establish = async (c: Cat, p: PerformanceFixture) =>
      persistRecordEvaluation(env.api, { snapshot: await snapshot(c, p) });
    const ratify = async (c: Cat, p: PerformanceFixture, id: string) =>
      persistRecordEvaluation(env.api, {
        snapshot: await snapshot(
          c,
          p,
          {
            pending: { recordMarkId: id, markHash: await hashOf(id) },
            world: authorityWorld(c.spec, {}, `demo${c.category.code}`),
          },
          id,
        ),
      });
    const both = async (c: Cat, p: PerformanceFixture) => {
      const e = await establish(c, p);
      await ratify(c, p, e.recordMarkId as string);
      return e.recordMarkId as string;
    };
    const status = async (id: string) =>
      (
        await sql<{
          s: string;
        }>`SELECT status AS s FROM record.mark_status_entry WHERE record_mark_id = ${id} ORDER BY seq DESC LIMIT 1`.execute(
          env.owner,
        )
      ).rows[0]?.s;
    const currentOf = async (c: Cat) =>
      (
        await sql<{
          id: string;
        }>`SELECT record_mark_id AS id FROM record_read.mark_card WHERE category_id = ${c.category.categoryId} AND is_current ORDER BY 1`.execute(
          env.owner,
        )
      ).rows.map((r) => r.id);

    const c1 = await newCat({});
    const pA = { rv: 'demo-a', athlete: 'a', value: '11000', minute: 1 };
    const e1 = await establish(c1, pA);
    const e2 = await establish(c1, pA);
    expectThat(
      e1.state === 'QUALIFIES' &&
        (await status(e1.recordMarkId as string)) === 'PENDING_RATIFICATION' &&
        e2.recordMarkId === e1.recordMarkId &&
        !e2.created,
      'pending candidate + idempotent persistence (one logical mark)',
    );
    const rs0 = await persistDerivation(env.api, {
      snapshot: await recordSetSnapshotFor(env.owner, {
        recordMarkId: e1.recordMarkId as string,
        recordSnapshot: await snapshot(c1, pA),
        ruleSpec: referenceRecordSetRule(env.dv.running.id),
        ruleIdentity: rsRule,
      }),
    });
    expectThat(rs0.achievements.length === 0, 'a PENDING mark produces no RECORD_SET');
    await ratify(c1, pA, e1.recordMarkId as string);
    await ratify(c1, pA, e1.recordMarkId as string);
    expectThat(
      (await status(e1.recordMarkId as string)) === 'RATIFIED',
      'ratification (fixture RATIFY_RECORD authority) ⇒ RATIFIED; replayed delivery ⇒ no second transition',
    );
    const rsSnap = await recordSetSnapshotFor(env.owner, {
      recordMarkId: e1.recordMarkId as string,
      recordSnapshot: await snapshot(c1, pA),
      ruleSpec: referenceRecordSetRule(env.dv.running.id),
      ruleIdentity: rsRule,
    });
    const rs1 = await persistDerivation(env.api, { snapshot: rsSnap });
    const rs2 = await persistDerivation(env.api, { snapshot: rsSnap });
    expectThat(
      rs1.achievements.length === 1 &&
        rs2.achievements[0]?.achievementId === rs1.achievements[0]?.achievementId,
      'exactly ONE RECORD_SET Achievement via the validated derivation path',
    );
    expectThat(
      JSON.stringify(await currentOf(c1)) === JSON.stringify([e1.recordMarkId]),
      'current-record projection',
    );
    const b = await both(c1, { rv: 'demo-b', athlete: 'b', value: '10900', minute: 5 });
    expectThat(
      (await status(e1.recordMarkId as string)) === 'SUPERSEDED' &&
        JSON.stringify(await currentOf(c1)) === JSON.stringify([b]),
      'better record supersedes (effectiveTo = successor sporting time)',
    );
    const c2 = await both(c1, { rv: 'demo-c', athlete: 'c', value: '10900', minute: 6 });
    expectThat(
      JSON.stringify(await currentOf(c1)) === JSON.stringify([b, c2].sort()),
      'SHARED tie: both co-current',
    );
    const cf = await newCat({ tiePolicy: 'FIRST_ACHIEVED' });
    await both(cf, { rv: 'demo-f1', athlete: 'f1', value: '10900', minute: 1 });
    const f2 = await establish(cf, { rv: 'demo-f2', athlete: 'f2', value: '10900', minute: 2 });
    expectThat(
      f2.state === 'DOES_NOT_QUALIFY',
      'FIRST_ACHIEVED tie: the later equal mark is not a record',
    );
    const d = await both(c1, { rv: 'demo-d', athlete: 'd', value: '10800', minute: 7 });
    await recordMarkSupportAssessment(env.api, {
      provenance: 'REFERENCE_FIXTURE',
      recordMarkId: d,
      requiredLevel: 'V3',
      basisStatus: 'REVOKED',
    });
    expectThat(
      (await status(d)) === 'RESCINDED' &&
        JSON.stringify(await currentOf(c1)) === JSON.stringify([b, c2].sort()),
      'rescission ⇒ prior SHARED holders restored',
    );
    await recordMarkSupportAssessment(env.api, {
      provenance: 'REFERENCE_FIXTURE',
      recordMarkId: b,
      requiredLevel: 'V3',
      basisStatus: 'REVOKED',
    });
    await recordMarkSupportAssessment(env.api, {
      provenance: 'REFERENCE_FIXTURE',
      recordMarkId: c2,
      requiredLevel: 'V3',
      basisStatus: 'REVOKED',
    });
    expectThat(
      JSON.stringify(await currentOf(c1)) === JSON.stringify([e1.recordMarkId]),
      'chronological replay after multiple rescissions ⇒ A restored',
    );
    const deps = await inTransaction(env.api, ModuleRole.records, (ctx) =>
      recordDependencyIndex(ctx, { recordMarkId: e1.recordMarkId as string }),
    );
    show(
      'dependency index of mark A',
      deps.map((x) => ({ type: x.dependencyType, recordSet: x.recordSetAchievementId ?? null })),
    );
    const hof = await sql<{
      holding: string;
      status: string;
    }>`SELECT holding, status FROM record_read.hall_of_fame_entry WHERE category_id = ${c1.category.categoryId} ORDER BY sort_key`.execute(
      env.owner,
    );
    show('Record Hall of Fame (category 1)', hof.rows);
    expectThat(
      hof.rows.every((r) => r.status !== 'RESCINDED'),
      'Hall of Fame never presents a RESCINDED or PENDING mark as an honour',
    );
    const before = await snapshotRecordReadModels(env.api);
    await rebuildRecordReadModels(env.maintenance);
    expectThat(
      JSON.stringify(await snapshotRecordReadModels(env.api)) === JSON.stringify(before),
      'read models + Hall of Fame rebuild identically (maintenance login)',
    );
  } finally {
    await env.destroy();
    show('throwaway database destroyed', env.database);
  }
} finally {
  await Promise.all([app.close(), appNoOperator.close()]);
  await Promise.all([db, owner, catalogDb, policyDb, recordOpDb, vaultDb].map((d) => d.destroy()));
}
if (failures.length > 0) {
  console.error(`\n✘ ${failures.length} expectation(s) failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(
  '\n✔ BRT-09 demo complete: records & Record Hall of Fame only — no ranking, qualification, prize or trophy.',
);
