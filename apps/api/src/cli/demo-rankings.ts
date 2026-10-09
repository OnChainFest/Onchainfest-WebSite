import { randomBytes } from 'node:crypto';
import { DomainError, PLATFORM_RANKING_LABEL, RANKING_PLATFORM_FLOOR } from '@br/domain';
import {
  CatalogStore,
  createDb,
  databaseUrls,
  IdentityStore,
  operatorDatabaseUrl,
  RankingDefinitionStore,
  RankingPublicReader,
  RankingService,
  RankingStaffReader,
  rankingOperatorDatabaseUrl,
  rankingWorkerDatabaseUrl,
  rebuildRankingReadModels,
  snapshotRankingReadModels,
  type Db,
} from '@br/persistence';
import {
  persistRankingRun,
  publishRankingSnapshot,
  rankingFixturePublicReader,
  type SnapshotCorrection,
} from '@br/persistence/ranking-lanes';
import type { RankingRunOutcome, RankingSystemSpec } from '@br/rankings';
import { rankCandidate, rankingRunInput, rankingSpec, rkId } from '@br/rankings/fixtures';
import { brt10ConsequenceFootprint, newTestAccount, seedTestCatalog } from '@br/testkit';
import {
  createRankingFixtureDatabase,
  RANKING_FIXTURE_DATABASE_PATTERN,
} from '@br/testkit/rankings';
import { sql } from 'kysely';
import { createDevTokenAuth, mintDevToken } from '../auth';
import { buildServer } from '../server';

/**
 * BRT-10 acceptance walkthrough (Step 14). ALL DATA IS FICTIONAL. Development only. No built-in secrets.
 *
 *   PART A — CANONICAL PRODUCTION-ASSEMBLY LANE (development database, real writers, readers and
 *            roles): the seeded fictional PLATFORM system (`pnpm db:seed:rankings`) is read through the
 *            real /v1 surface and evaluated by the real RankingService from canonical facts only.
 *            Production has no FINAL, V2 or hold producer, and running.5k has no events (no heat
 *            format), so the run is BLOCKED with its exact blockers and no snapshot exists. No FINAL
 *            result, verification, hold clearance or authority is faked. Footprint: ranking runs only.
 *   PART B — REFERENCE FIXTURE LANE — NOT CANONICAL SPORTING TRUTH (a THROWAWAY br_rkfx_ database with
 *            the test-only overlay, destroyed at the end): the positive BEST_MARK mechanics through
 *            the same validated writers — holder best, a shared tie (1, 1, 3), INITIAL → FOLLOWS →
 *            CORRECTS, history, leaderboard, idempotent replay, rebuild equality — and proof that the
 *            production reader never shows a fixture snapshot. Never the development database.
 * Run: pnpm db:up && pnpm db:bootstrap && pnpm db:migrate && pnpm db:seed:competition &&
 *      pnpm db:seed:rankings && pnpm demo:rankings
 */
if (process.env.NODE_ENV === 'production') throw new Error('the demo refuses production');
const SYSTEM_CODE = 'br-dev-5k-best-marks';
const devAuthSecret = randomBytes(32).toString('hex');
const urls = databaseUrls();
const workerUrl = rankingWorkerDatabaseUrl();
if (workerUrl === undefined) throw new Error('the demo needs the ranking worker database URL');
const db = createDb(urls.api, { max: 4 });
const owner = createDb(urls.owner, { max: 2 });
const worker = createDb(workerUrl, { max: 2 });
const app = buildServer({
  db,
  auth: (identity: IdentityStore) => createDevTokenAuth(identity, { secret: devAuthSecret }),
  logStream: { write: () => undefined },
});

const run = randomBytes(4).toString('hex');
let step = 0;
const show = (title: string, detail: unknown) =>
  console.log(
    `\n▶ ${String(++step).padStart(2, '0')}. ${title}\n   ${typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2).replaceAll('\n', '\n   ')}`,
  );
const banner = (lines: readonly string[]) => {
  const w = Math.max(...lines.map((l) => l.length)) + 4;
  console.log(`\n${'═'.repeat(w)}\n${lines.map((l) => `  ${l}`).join('\n')}\n${'═'.repeat(w)}`);
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form navigation of JSON responses
type Json = Record<string, any>;
async function call(
  target: { inject: typeof app.inject },
  url: string,
  headers: Record<string, string> = {},
) {
  const res = await target.inject({ method: 'GET', url, headers });
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
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const refusalOf = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return 'NOT REFUSED';
  } catch (err) {
    if (err instanceof DomainError) return String(err.details.reason ?? err.code);
    throw err;
  }
};
/** Development-database facts Part B must never change (and Part A only adds runs to). */
const canonicalFacts = async (target: Db) =>
  (
    await sql<{
      systems: number;
      versions: number;
      statusChanges: number;
      runs: number;
      snapshots: number;
      fixtureRows: number;
    }>`
      SELECT (SELECT count(*) FROM ranking.system)::int AS systems,
             (SELECT count(*) FROM ranking.system_version)::int AS versions,
             (SELECT count(*) FROM ranking.system_version_status_change)::int AS "statusChanges",
             (SELECT count(*) FROM ranking.run)::int AS runs,
             (SELECT count(*) FROM ranking.snapshot)::int AS snapshots,
             ((SELECT count(*) FROM ranking.run WHERE provenance <> 'CANONICAL_ASSEMBLY')
               + (SELECT count(*) FROM ranking.snapshot WHERE provenance <> 'CANONICAL_ASSEMBLY'))::int AS "fixtureRows"`.execute(
      target,
    )
  ).rows[0];

try {
  // ═══════════════════════════════ PART A ═══════════════════════════════
  banner([
    'PART A — CANONICAL PRODUCTION-ASSEMBLY LANE',
    'development database · real writers / readers / roles · fictional development definitions · no fixture provenance',
  ]);
  const footprintBefore = await brt10ConsequenceFootprint(owner);
  const factsBefore = await canonicalFacts(owner);

  const sys = await call(app, `/v1/ranking-systems/${SYSTEM_CODE}`);
  if (sys.status !== 200)
    throw new Error(
      `run \`pnpm db:seed:rankings\` first (ranking system ${SYSTEM_CODE} is not public: ${sys.status})`,
    );
  const { rows: versions } = await sql<{
    id: string;
    version: number;
    status: string;
    spec: RankingSystemSpec;
    dv_comparator: RankingSystemSpec['comparator'];
    events: number;
  }>`
    SELECT v.id, v.version, c.status, v.spec, dv.spec->'comparator' AS dv_comparator,
           (SELECT count(*) FROM competition.event e WHERE e.discipline_version_id = v.discipline_version_id)::int AS events
    FROM ranking.system_version v JOIN ranking.system s ON s.id = v.system_id
    JOIN ranking.v_system_version_current c ON c.system_version_id = v.id
    JOIN sports.discipline_version dv ON dv.id = v.discipline_version_id
    WHERE s.code = ${SYSTEM_CODE} ORDER BY v.version DESC LIMIT 1`.execute(owner);
  const version = versions[0];
  if (version === undefined) throw new Error(`run \`pnpm db:seed:rankings\` first`);
  const spec = version.spec;
  show('seeded fictional ranking system (public /v1 + the immutable version it pins)', {
    code: sys.body.code,
    kind: sys.body.kind,
    label: sys.body.label,
    version: version.version,
    lifecycle: version.status,
    method: spec.method,
    universe: spec.universe,
    comparator: spec.comparator.keys,
    requirements: {
      ...spec.requirements,
      holdBlocks: RANKING_PLATFORM_FLOOR[spec.kind].holdBlocks,
    },
    effectiveFrom: spec.effectiveFrom,
  });
  expectThat(
    sys.body.kind === 'PLATFORM' &&
      sys.body.label === PLATFORM_RANKING_LABEL &&
      version.status === 'PUBLISHED' &&
      spec.method === 'BEST_MARK' &&
      spec.requirements.minimumResultStatus === 'FINAL' &&
      spec.requirements.minimumVerificationLevel === 'V2',
    'PLATFORM · BEST_MARK · PUBLISHED · platform floor FINAL / V2; the label is computed, never free text',
  );
  expectThat(
    version.dv_comparator.keys.some((k) => same(k, spec.comparator.keys[0])),
    'the comparator is the pinned DisciplineVersion’s own key (direction included), not a ranking choice',
  );

  const { rows: now } = await sql<{ t: Date }>`SELECT date_trunc('second', now()) AS t`.execute(
    owner,
  );
  const asOf = now[0]?.t as Date;
  const rankings = new RankingService(worker);
  const r1 = await rankings.evaluate({
    systemVersionId: version.id,
    asOf,
    trigger: 'STAFF_REQUEST',
  });
  const r2 = await rankings.evaluate({
    systemVersionId: version.id,
    asOf,
    trigger: 'STAFF_REQUEST',
  });
  const { rows: stored } = await sql<{
    provenance: string;
    publication_state: string;
    publication_reasons: string[];
    candidate_count: number;
    entry_count: number;
    outcome: RankingRunOutcome;
  }>`
    SELECT provenance, publication_state, publication_reasons, candidate_count, entry_count, outcome
    FROM ranking.run WHERE id = ${r1.runId}`.execute(owner);
  const dbRun = stored[0];
  if (dbRun === undefined) throw new Error('the canonical run was not persisted');
  const candidates = dbRun.outcome.candidates;
  show(
    'canonical evaluation (RankingService.evaluate: canonical re-assembly, pure engine, validated writer)',
    {
      asOf: asOf.toISOString(),
      runId: r1.runId,
      provenance: dbRun.provenance,
      candidateCount: dbRun.candidate_count,
      rankedEntryCount: dbRun.entry_count,
      publicationState: dbRun.publication_state,
      publicationBlockers: dbRun.publication_reasons,
      candidateBlockers: candidates.map((c) => ({ state: c.state, reasons: c.reasons })),
      eventsInUniverse: version.events,
    },
  );
  expectThat(
    r2.runId === r1.runId && !r2.created,
    'same system version + sporting cutoff ⇒ the same run (natural key); the repeat created nothing',
  );
  expectThat(
    dbRun.provenance === 'CANONICAL_ASSEMBLY' &&
      dbRun.publication_state === r1.publicationState &&
      same(dbRun.publication_reasons, r1.publicationReasons) &&
      dbRun.candidate_count === r1.candidateCount &&
      dbRun.entry_count === r1.entryCount,
    'the stored run is exactly the reported run (CANONICAL_ASSEMBLY)',
  );
  expectThat(
    dbRun.publication_state === 'BLOCKED' &&
      dbRun.entry_count === 0 &&
      same(dbRun.publication_reasons, ['NO_RANKED_ENTRIES']),
    'BLOCKED with the honest blocker NO_RANKED_ENTRIES only (no integrity / lifecycle reason)',
  );
  expectThat(
    candidates.every((c) => c.state !== 'INCLUDED' && c.reasons.includes('HOLD_STATE_UNAVAILABLE')),
    candidates.length === 0
      ? `no candidate exists: running.5k has ${version.events} events (no heat format), so nothing is ranked or faked`
      : 'every candidate is excluded with its exact blockers (HOLD_STATE_UNAVAILABLE at least)',
  );
  const staff = await call(app, `/v1/internal/ranking-runs/${r1.runId}`, {
    authorization: `Bearer ${mintDevToken(`demo10-${run}-op`, { secret: devAuthSecret, operator: true })}`,
  });
  expectThat(
    staff.status === 200 &&
      staff.body.run.publicationState === 'BLOCKED' &&
      staff.body.candidates.length === dbRun.candidate_count,
    'INTERNAL run read (operator, SELECT-only staff reader) shows the same BLOCKED run and every candidate',
  );
  const refusal = await refusalOf(() => rankings.publish({ runId: r1.runId }));
  expectThat(
    refusal === 'RUN_NOT_PUBLISHABLE',
    `the validated writer refuses to publish a BLOCKED run (${refusal})`,
  );
  const history = await Promise.all(
    ['as-published', 'as-corrected'].map((view) =>
      call(app, `/v1/ranking-systems/${SYSTEM_CODE}/snapshots?view=${view}`),
    ),
  );
  const factsAfterA = await canonicalFacts(owner);
  expectThat(
    history.every((h) => h.status === 200 && h.body.items.length === 0) &&
      factsAfterA?.snapshots === 0,
    'no snapshot is falsely published: both public history views are empty, 0 snapshots in the database',
  );
  expectThat(
    factsAfterA?.fixtureRows === 0,
    'the development database holds no REFERENCE_FIXTURE ranking row',
  );
  const footprintAfterA = await brt10ConsequenceFootprint(owner);
  show('development-database footprint of Part A', {
    before: factsBefore,
    after: factsAfterA,
    consequenceFootprint: footprintAfterA,
  });
  expectThat(
    same(footprintAfterA, footprintBefore) &&
      factsAfterA?.systems === factsBefore?.systems &&
      factsAfterA?.versions === factsBefore?.versions &&
      factsAfterA?.statusChanges === factsBefore?.statusChanges &&
      (factsAfterA?.runs ?? 0) - (factsBefore?.runs ?? 0) === (r1.created ? 1 : 0),
    'Part A added only the canonical run itself: no definition, snapshot, classification, QUALIFIED, prize or trophy',
  );

  // ═══════════════════════════════ PART B ═══════════════════════════════
  banner([
    'PART B — REFERENCE FIXTURE LANE — NOT CANONICAL SPORTING TRUTH',
    'throwaway br_rkfx_ database + test-only overlay (run / snapshot provenance CHECKs only), destroyed at the end',
    'FINAL / V2 / hold facts are synthetic and in memory; the development database is never touched',
  ]);
  const fx = await createRankingFixtureDatabase();
  const fdbs: Db[] = [];
  let productionApp: ReturnType<typeof buildServer> | undefined;
  try {
    const furls = databaseUrls(fx.database);
    const mk = (u: string | undefined) => {
      const d = createDb(u as string, { max: 3 });
      fdbs.push(d);
      return d;
    };
    const fapi = mk(furls.api);
    const fowner = mk(furls.owner);
    const fmaint = mk(furls.maintenance);
    const fw = mk(rankingWorkerDatabaseUrl(fx.database));
    const fop = new RankingDefinitionStore(mk(rankingOperatorDatabaseUrl(fx.database)));
    const fidentity = new IdentityStore(fapi);
    show('throwaway fixture database', {
      database: fx.database,
      overlay: 'packages/testkit/sql/ranking-fixture-overlay.sql',
    });
    expectThat(
      RANKING_FIXTURE_DATABASE_PATTERN.test(fx.database),
      'the fixture lane runs only in a br_rkfx_<12 hex> database',
    );

    // The same validated definition writer as production, inside the throwaway database.
    const fcat = await seedTestCatalog(
      fidentity,
      new CatalogStore(mk(operatorDatabaseUrl(fx.database))),
    );
    const operatorAccountId = (
      await newTestAccount(fidentity, { withPerson: false, label: 'demo-rk-op' })
    ).accountId;
    const dv = fcat.running5k;
    const { rows: dvRows } = await sql<{ sport: string; discipline: string; eff: Date }>`
      SELECT s.code AS sport, d.code AS discipline, now() + interval '10 seconds' AS eff
      FROM sports.discipline_version v
      JOIN sports.discipline d ON d.id = v.discipline_id JOIN sports.sport s ON s.id = d.sport_id
      WHERE v.id = ${dv}`.execute(fowner);
    const codes = dvRows[0] as { sport: string; discipline: string; eff: Date };
    const eff = codes.eff.toISOString();
    const { systemId } = await fop.createRankingSystem({
      operatorAccountId,
      code: `demo-rk-fx-${run}`,
      name: 'Fictional 5K best marks (fixture)',
      kind: 'PLATFORM',
      idempotencyKey: `demo10:${run}:system`,
    });
    const sv = await fop.createRankingSystemVersion({
      operatorAccountId,
      systemId,
      spec: rankingSpec({
        universe: {
          disciplineVersionId: dv,
          metric: { key: 'elapsedTimeMs', markMetricId: 'running.elapsed_time' },
          resultScope: 'CONTEST',
          holderType: 'ATHLETE',
          population: {},
        },
        recognition: { level: 'PLATFORM', sport: [codes.sport] },
        effectiveFrom: eff,
      }),
      idempotencyKey: `demo10:${run}:system:v1`,
    });
    await fop.changeRankingSystemVersionStatus({
      operatorAccountId,
      systemVersionId: sv.systemVersionId,
      status: 'PUBLISHED',
    });
    const { rows: svRows } = await sql<{ spec: Record<string, unknown>; code: string }>`
      SELECT v.spec, s.code FROM ranking.system_version v JOIN ranking.system s ON s.id = v.system_id
      WHERE v.id = ${sv.systemVersionId}`.execute(fowner);
    const svRow = svRows[0] as { spec: Record<string, unknown>; code: string };

    // Fictional athletes A–D; LOWER_IS_BETTER elapsed times in exact milliseconds.
    const HOLDER = { A: 1, B: 2, C: 3, D: 4 } as const;
    const letter = new Map(Object.entries(HOLDER).map(([l, n]) => [rkId(700 + n), l]));
    const later = (m: number) => new Date(Date.parse(eff) + m * 60_000).toISOString();
    const cand = (n: number, holder: keyof typeof HOLDER, value: string, patch: object = {}) =>
      rankCandidate(n, HOLDER[holder], value, { occurredAt: later(60), ...patch });
    const evaluate = (candidates: readonly unknown[], asOfMinute: number) =>
      persistRankingRun(fw, {
        input: rankingRunInput(candidates, {
          spec: svRow.spec,
          system: {
            systemId,
            systemVersionId: sv.systemVersionId,
            code: svRow.code,
            version: sv.version,
            specHash: sv.specHash,
            lifecycle: 'PUBLISHED',
          },
          discipline: { disciplineVersionId: dv, sport: codes.sport, discipline: codes.discipline },
          asOf: later(asOfMinute),
        }),
        trigger: 'STAFF_REQUEST',
      });
    const publish = (runId: string, correction?: SnapshotCorrection) =>
      publishRankingSnapshot(fw, { runId, ...(correction === undefined ? {} : { correction }) });
    const entries = async (snapshotId: string) =>
      (
        await sql<{ holder_id: string; rank: number; tied: boolean; value: string; basis: number }>`
          SELECT holder_id::text AS holder_id, rank, tied, value->>'value' AS value,
                 jsonb_array_length(basis)::int AS basis
          FROM ranking.snapshot_entry WHERE snapshot_id = ${snapshotId}
          ORDER BY rank, holder_id`.execute(fowner)
      ).rows.map((e) => ({
        holder: letter.get(e.holder_id) ?? '?',
        rank: e.rank,
        tied: e.tied,
        value: `${e.value} ms`,
        basis: e.basis,
      }));
    const ranks = (es: readonly { holder: string; rank: number; tied: boolean }[]) =>
      es.map((e) => `${e.holder}:${e.rank}${e.tied ? '=' : ''}`).join(' ');

    // Snapshot 1 — A has two equal bests and a slower run; B equals A; D is fastest but only PROVISIONAL.
    const first = [
      cand(1, 'A', '1140000'),
      cand(2, 'A', '1140000'),
      cand(3, 'A', '1152000'),
      cand(4, 'B', '1140000'),
      cand(5, 'C', '1155000'),
      cand(6, 'D', '1130000', { status: 'PROVISIONAL' }),
    ];
    const run1 = await evaluate(first, 120);
    const s1 = await publish(run1.runId);
    const e1 = await entries(s1.snapshotId);
    const staffRun = await new RankingStaffReader(fapi).run(run1.runId);
    show('run 1 → snapshot 1 (INITIAL)', {
      publicationState: run1.publicationState,
      candidates: staffRun?.candidates.map((c) => ({
        resultVersion: `rv${Number.parseInt(c.resultVersionId.slice(-12), 16) - 200}`,
        state: c.state,
        reasons: c.reasons,
      })),
      leaderboard: e1,
      snapshotHash: s1.snapshotHash,
    });
    expectThat(
      ranks(e1) === 'A:1= B:1= C:3',
      'deterministic BEST_MARK ranking with a shared tie: A 1=, B 1=, C 3 (competition ranks 1, 1, 3; no hidden tie-break)',
    );
    expectThat(
      e1.find((e) => e.holder === 'A')?.basis === 2 &&
        staffRun?.candidates.find((c) => c.resultVersionId === rkId(203))?.state ===
          'NOT_HOLDER_BEST',
      'holder best: both of A’s equal 1140000 ms marks are pinned (none chosen); the 1152000 ms run is NOT_HOLDER_BEST',
    );
    const dState = staffRun?.candidates.find((c) => c.resultVersionId === rkId(206));
    expectThat(
      dState?.state === 'PENDING_REQUIRED_FACTS' &&
        dState.reasons.includes('RESULT_STATUS_BELOW_REQUIRED') &&
        !e1.some((e) => e.holder === 'D'),
      'D’s faster 1130000 ms mark is only PROVISIONAL: excluded with RESULT_STATUS_BELOW_REQUIRED, never ranked',
    );
    expectThat(
      s1.lineageKind === 'INITIAL' && /^sha256:[0-9a-f]{64}$/.test(s1.snapshotHash),
      'snapshot 1 is INITIAL with a content hash',
    );

    // Idempotent replay: the same input is the same run; republishing it is the same snapshot.
    const count = async () =>
      (
        await sql<{ runs: number; snapshots: number; entries: number; events: number }>`
          SELECT (SELECT count(*) FROM ranking.run)::int AS runs,
                 (SELECT count(*) FROM ranking.snapshot)::int AS snapshots,
                 (SELECT count(*) FROM ranking.snapshot_entry)::int AS entries,
                 (SELECT count(*) FROM platform.outbox_event WHERE event_type ~ '^Ranking(Run|Snapshot)')::int AS events`.execute(
          fowner,
        )
      ).rows[0];
    const beforeReplay = await count();
    const replayRun = await evaluate(first, 120);
    const replaySnap = await publish(replayRun.runId);
    expectThat(
      replayRun.runId === run1.runId &&
        !replayRun.created &&
        replaySnap.snapshotId === s1.snapshotId &&
        !replaySnap.created &&
        same(await count(), beforeReplay),
      'idempotent replay: same run, same snapshot, no new run / snapshot / entry / event',
    );

    // Snapshot 2 — C improves to 1135000 ms (new admissible input): FOLLOWS snapshot 1.
    const second = [...first, cand(7, 'C', '1135000')];
    const run2 = await evaluate(second, 130);
    const s2 = await publish(run2.runId);
    const e2 = await entries(s2.snapshotId);
    show('run 2 → snapshot 2 (FOLLOWS)', { leaderboard: e2, prior: s2.priorSnapshotId });
    expectThat(
      s2.lineageKind === 'FOLLOWS' &&
        s2.priorSnapshotId === s1.snapshotId &&
        ranks(e2) === 'C:1 A:2= B:2=',
      'snapshot 2 FOLLOWS snapshot 1: C 1, A 2=, B 2=',
    );

    // Snapshot 3 — C's improved result was superseded: CORRECTS snapshot 2 (fixture-only producer).
    const third = [...first, cand(7, 'C', '1135000', { supersededByVersionId: rkId(299) })];
    const run3 = await evaluate(third, 140);
    const s3 = await publish(run3.runId, {
      correctsSnapshotId: s2.snapshotId,
      reasons: ['RESULT_SUPERSEDED'],
    });
    const e3 = await entries(s3.snapshotId);
    show('run 3 → snapshot 3 (CORRECTS snapshot 2)', {
      leaderboard: e3,
      corrects: s3.priorSnapshotId,
    });
    expectThat(
      s3.lineageKind === 'CORRECTS' &&
        s3.priorSnapshotId === s2.snapshotId &&
        ranks(e3) === 'A:1= B:1= C:3',
      'snapshot 3 CORRECTS snapshot 2: the superseded mark leaves the table (A 1=, B 1=, C 3)',
    );

    // History, leaderboard and staleness through the Step 11 reader on the fixture lane.
    const fixtureReader = rankingFixturePublicReader(fapi);
    const asPublished = await fixtureReader.history(systemId, 'as-published');
    const asCorrected = await fixtureReader.history(systemId, 'as-corrected');
    show('history', {
      asPublished: asPublished?.items.map((i) => ({
        position: i.lineage.chainPosition,
        kind: i.lineage.kind,
        correctedBy: i.lineage.correctedBy === undefined ? null : 'snapshot 3',
      })),
      asCorrected: asCorrected?.items.map((i) => ({
        position: i.lineage.chainPosition,
        kind: i.lineage.kind,
        corrects: i.corrects?.length ?? 0,
      })),
    });
    expectThat(
      same(
        asPublished?.items.map((i) => i.snapshotId),
        [s1.snapshotId, s2.snapshotId, s3.snapshotId],
      ) && asPublished?.items[1]?.lineage.correctedBy === s3.snapshotId,
      'as-published keeps every snapshot in chain order; snapshot 2 is marked corrected by snapshot 3',
    );
    expectThat(
      same(
        asCorrected?.items.map((i) => i.snapshotId),
        [s1.snapshotId, s3.snapshotId],
      ) && same(asCorrected?.items[1]?.corrects, [s2.snapshotId]),
      'as-corrected replaces snapshot 2 by its correction, which lists what it corrects',
    );
    const board = await fixtureReader.leaderboard(s3.snapshotId);
    const detail = await fixtureReader.snapshot(s3.snapshotId);
    show('leaderboard of snapshot 3 (public DTO, fixture lane)', {
      entries: board?.entries.map((e) => ({
        rank: e.rank,
        tied: e.tied,
        holder: e.holder.display,
        value: e.value.display,
        basisCount: e.basisCount,
      })),
      readTimeStaleness: detail?.readTime.staleness,
    });
    expectThat(
      same(
        board?.entries.map((e) => [e.rank, e.tied, e.value.display]),
        [
          [1, true, '1140000 ms'],
          [1, true, '1140000 ms'],
          [3, false, '1155000 ms'],
        ],
      ) && detail?.snapshot.snapshotHash === s3.snapshotHash,
      'leaderboard in canonical rank order with exact marks; the snapshot hash matches the writer’s',
    );
    expectThat(
      detail?.readTime.staleness.state === 'STALE',
      'read-time staleness is computed, never stored: STALE here, because the synthetic pins are unknown to the canonical tables (fail closed)',
    );

    // Read models are projections: a full rebuild reproduces them exactly.
    const projected = await snapshotRankingReadModels(fmaint);
    await rebuildRankingReadModels(fmaint);
    expectThat(
      same(await snapshotRankingReadModels(fmaint), projected),
      'ranking_read.* rebuild (maintenance login) equals the incremental projections',
    );
    const { rows: prov } = await sql<{ n: number }>`
      SELECT ((SELECT count(*) FROM ranking.run WHERE provenance <> 'REFERENCE_FIXTURE')
        + (SELECT count(*) FROM ranking.snapshot WHERE provenance <> 'REFERENCE_FIXTURE'))::int AS n`.execute(
      fowner,
    );
    expectThat(prov[0]?.n === 0, 'every fixture run and snapshot is REFERENCE_FIXTURE');

    // The production reader and the real /v1 server never show a fixture snapshot.
    const productionReader = new RankingPublicReader(fapi);
    productionApp = buildServer({
      db: fapi,
      auth: (identity: IdentityStore) => createDevTokenAuth(identity, { secret: devAuthSecret }),
      logStream: { write: () => undefined },
    });
    const prodApp = productionApp;
    const invisible =
      (await productionReader.history(systemId, 'as-published'))?.items.length === 0 &&
      (await productionReader.history(systemId, 'as-corrected'))?.items.length === 0 &&
      (
        await Promise.all(
          [s1, s2, s3].map(async (s) => [
            await productionReader.snapshot(s.snapshotId),
            await productionReader.leaderboard(s.snapshotId),
            (await call(prodApp, `/v1/ranking-snapshots/${s.snapshotId}`)).status,
            (await call(prodApp, `/v1/ranking-snapshots/${s.snapshotId}/leaderboard`)).status,
          ]),
        )
      ).every(
        ([snap, lb, st, lst]) =>
          snap === undefined && lb === undefined && st === 404 && lst === 404,
      );
    expectThat(
      invisible,
      'fixture snapshots are invisible to the production reader and the real /v1 server (empty history, 404)',
    );
  } finally {
    await productionApp?.close();
    await Promise.all(fdbs.map((d) => d.destroy()));
    await fx.destroy();
    const { rows: left } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_database WHERE datname = ${fx.database}`.execute(owner);
    show('throwaway database destroyed', { database: fx.database, stillExists: left[0]?.n !== 0 });
    expectThat(left[0]?.n === 0, 'the throwaway fixture database no longer exists');
  }
  const factsAfterB = await canonicalFacts(owner);
  expectThat(
    same(factsAfterB, factsAfterA) && same(await brt10ConsequenceFootprint(owner), footprintAfterA),
    'Part B left the development database exactly as Part A did (no fixture row, run or snapshot)',
  );
} finally {
  await app.close();
  await Promise.all([db, owner, worker].map((d) => d.destroy()));
}
if (failures.length > 0) {
  console.error(`\n✘ ${failures.length} expectation(s) failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(
  '\n✔ BRT-10 demo complete: canonical runs stay honestly BLOCKED; positive snapshots exist only in the destroyed fixture lane — no QUALIFIED, prize or trophy.',
);
