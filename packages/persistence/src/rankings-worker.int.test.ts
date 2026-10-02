import { newId, type AuthorityScope, type DomainEvent, type Uuid } from '@br/domain';
import { evaluateRankingRun, hashRankingRunInput } from '@br/rankings';
import { rankingSpec } from '@br/rankings/fixtures';
import {
  apiDb,
  awaitDbTimePast,
  declaredNoParticipation,
  maintenanceDb,
  newContestResult,
  operatorDb,
  ownerDb,
  seedTestCatalog,
  workerDb,
  type TestCatalog,
} from '@br/testkit';
import { rankingOperatorDb, rankingWorkerDb } from '@br/testkit/rankings';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthorityStore } from './authority-store';
import { CatalogStore } from './catalog-store';
import { ClassificationStalenessService } from './classification-staleness';
import {
  CompetitionHierarchyResolver,
  createCompetitionResultLedger,
} from './competition-hierarchy';
import { CompetitionStore } from './competition-store';
import { StructureStore } from './competition-structure-store';
import type { Db } from './db';
import { IdentityStore } from './identity-store';
import { OrganizationStore } from './organization-store';
import { toDomainEvent } from './outbox';
import { RankingDefinitionStore } from './ranking-definition-store';
import { assembleRankingRunInput } from './ranking-loader';
import { rebuildRankingReadModels, snapshotRankingReadModels } from './ranking-projection';
import {
  RANKING_WORKER_CONSUMER,
  RankingWorkerService,
  rankingWorkerTarget,
} from './ranking-worker';
import { inTransaction, ModuleRole } from './tx';
import { consumeOutbox } from './worker-queue';

/**
 * BRT-10 Step 10 — the ranking worker reaction (br_ranking_worker_app → br_rankings).
 *
 * Canonical facts only, on the shared integration database: every outbox assertion is scoped to this
 * file's own aggregates or to the ids that appeared after a baseline taken immediately before the
 * reaction (other files leave their own events behind; nothing here assumes an empty outbox).
 *
 * What is proven: the worker emits ClassificationStale (never consumes it) for exactly the affected
 * classifications, under the PINNED policy; it never re-submits, replaces or mutates a classification;
 * it evaluates canonical ranking runs (BLOCKED in production) and never publishes; duplicate,
 * concurrent and retried deliveries collapse to one logical effect; unrelated or malformed events do
 * nothing; and no QUALIFIED / record / prize / trophy / snapshot side effect exists.
 */
const DENIED = { code: '42501' };
const k = (p = 'k') => `${p}-${newId()}`;
const futureIso = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
const countOf = async (db: Db, q: ReturnType<typeof sql<{ n: string }>>) =>
  Number((await q.execute(db)).rows[0]?.n ?? -1);

const api = apiDb();
const owner = ownerDb();
const rop = rankingOperatorDb();
const rw = rankingWorkerDb();
const op = operatorDb();
const worker = workerDb();
const maintenance = maintenanceDb();
afterAll(async () => {
  await Promise.all([api, owner, rop, rw, op, worker, maintenance].map((d) => d.destroy()));
});

const identity = new IdentityStore(api);
const authority = new AuthorityStore(api, { conflictChecker: declaredNoParticipation });
const ledger = createCompetitionResultLedger(api, { conflictChecker: declaredNoParticipation });
const resolver = new CompetitionHierarchyResolver(api);
const definitions = new RankingDefinitionStore(rop);
const reactor = new RankingWorkerService(rw);
const staleness = new ClassificationStalenessService(api); // the API login's br_results reader
let catalog: TestCatalog;

const scopeOf = async (level: 'CONTEST' | 'ROUND' | 'EVENT' | 'COMPETITION', id: string) =>
  ({ ...(await resolver.scopeOf(level, id)), recognitionLevel: ['PLATFORM'] }) as AuthorityScope;

/** A real timed contest (optionally a new event of an existing competition) + an ACCEPT_RESULT holder. */
async function contestWorld(
  timed: { winnerMs: string; loserMs: string },
  into?: {
    organizer: Awaited<ReturnType<typeof newContestResult>>['organizer'];
    competitionId: string;
  },
  acceptNow = true,
) {
  const w = await newContestResult({
    db: api,
    identity,
    orgs: new OrganizationStore(api),
    comps: new CompetitionStore(api),
    structure: new StructureStore(api),
    authority,
    ledger,
    resolver,
    catalog,
    timed,
    ...(into === undefined ? {} : into),
  });
  const acceptor = await authority.registerPrincipal({
    principalType: 'PERSON',
    label: 'fictional chief judge (fixture)',
  });
  await authority.issueGrant({
    actorPrincipalId: w.platformPrincipalId,
    grantorPrincipalId: w.platformPrincipalId,
    granteePrincipalId: acceptor.id,
    capabilities: ['ACCEPT_RESULT'],
    scope: { recognitionLevel: ['PLATFORM'], competition: [w.competitionId as Uuid] },
    delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
  });
  const accept = async () =>
    ledger.transition({
      resultVersionId: w.resultVersionId,
      toStatus: 'PROVISIONAL',
      actorPrincipalId: acceptor.id,
      scope: await scopeOf('CONTEST', w.contestId),
      idempotencyKey: k('accept'),
    });
  if (acceptNow) await accept();
  const { rows } = await sql<{ round_id: string }>`
    SELECT round_id::text FROM competition.contest WHERE id = ${w.contestId}`.execute(owner);
  return { ...w, roundId: rows[0]?.round_id as string, accept, acceptorId: acceptor.id };
}

type ClassificationScopeType =
  'ROUND_CLASSIFICATION' | 'EVENT_CLASSIFICATION' | 'COMPETITION_CLASSIFICATION';

/** A `@2` classification submitted through the ResultLedger T2 by a SUBMIT_RESULT holder (unchanged path). */
async function submitClassification(
  w: { submitterPrincipalId: string },
  scopeType: ClassificationScopeType,
  targetId: string,
  scope: AuthorityScope,
) {
  const { id: resultId } = await ledger.createResult({
    scopeType,
    scopeTargetId: targetId as Uuid,
  });
  const p = await ledger.proposeClassification(resultId);
  if (p.state !== 'PROPOSED' || p.outcome.proposal === undefined)
    throw new Error(`no proposal: ${JSON.stringify(p)}`);
  const { draftId } = await ledger.saveDraft({
    resultId,
    authorPrincipalId: w.submitterPrincipalId as Uuid,
    disciplineVersionRef: 'timed.singles@1',
    content: p.outcome.proposal.content,
  });
  const s = await ledger.submitDraft({
    draftId,
    actorPrincipalId: w.submitterPrincipalId as Uuid,
    scope,
    idempotencyKey: k('submit'),
  });
  return { resultId, versionId: s.resultVersionId as string, contentHash: s.contentHash };
}

const policySpec = (scopeType: string, displayName: string) => ({
  targetEngine: 'classification-engine/1',
  displayName,
  scopeType,
  disciplineVersionId: catalog.timedSingles,
  minimumInputStatus: 'PROVISIONAL',
  primary: 'METRICS',
  keys: [
    {
      metric: 'elapsedTimeMs',
      markMetricId: 'athletics.100m.time',
      order: 'LOWER_IS_BETTER',
      source: 'PERFORMANCE',
      aggregation: 'MIN',
    },
  ],
});

async function publishedPolicyVersions(scopeType: string) {
  const { rows } = await sql<{ id: string }>`
    SELECT v.id::text AS id FROM ranking.classification_policy_version v
    JOIN ranking.v_classification_policy_version_current s ON s.policy_version_id = v.id
    WHERE v.scope_type = ${scopeType} AND v.discipline_version_id = ${catalog.timedSingles}
      AND s.status = 'PUBLISHED'`.execute(owner);
  return rows.map((r) => r.id);
}
const retire = (policyVersionId: string) =>
  definitions.changeClassificationPolicyVersionStatus({
    operatorAccountId: catalog.operatorAccountId,
    policyVersionId,
    status: 'RETIRED',
  });

/** Publishes the ONLY policy of the scope type (retiring any other: the binding is unique-or-fail). */
async function soleBinding(scopeType: string, displayName: string) {
  for (const id of await publishedPolicyVersions(scopeType)) await retire(id);
  const { policyId } = await definitions.createClassificationPolicy({
    operatorAccountId: catalog.operatorAccountId,
    code: `cp-${newId().slice(-12)}`,
    name: 'Fictional table',
    scopeType,
    idempotencyKey: k('cp'),
  });
  const v = await definitions.createClassificationPolicyVersion({
    operatorAccountId: catalog.operatorAccountId,
    policyId,
    spec: policySpec(scopeType, displayName),
    idempotencyKey: k('cpv'),
  });
  await definitions.changeClassificationPolicyVersionStatus({
    operatorAccountId: catalog.operatorAccountId,
    policyVersionId: v.policyVersionId,
    status: 'PUBLISHED',
  });
  return v.policyVersionId;
}

/** The committed outbox event of (aggregate, type), as the worker would receive it. */
async function outboxEvent(aggregateId: string, eventType: string): Promise<DomainEvent> {
  const { rows } = await sql<Parameters<typeof toDomainEvent>[0]>`
    SELECT * FROM platform.outbox_event WHERE aggregate_id = ${aggregateId} AND event_type = ${eventType}
    ORDER BY recorded_at DESC, id DESC LIMIT 1`.execute(owner);
  const row = rows[0];
  if (row === undefined) throw new Error(`no ${eventType} for ${aggregateId}`);
  return toDomainEvent(row);
}

const staleEventsOf = async (classificationVersionId: string) =>
  (
    await sql<{ id: string; payload: Record<string, unknown> }>`
      SELECT id::text AS id, payload FROM platform.outbox_event
      WHERE event_type = 'ClassificationStale' AND aggregate_type = 'RESULT_VERSION'
        AND aggregate_id = ${classificationVersionId} ORDER BY recorded_at, id`.execute(owner)
  ).rows;

/** Outbox ids present now — the baseline that scopes "what did this reaction emit". */
const outboxIds = async () =>
  new Set(
    (
      await sql<{ id: string }>`SELECT id::text AS id FROM platform.outbox_event`.execute(owner)
    ).rows.map((r) => r.id),
  );
const emittedSince = async (baseline: ReadonlySet<string>) =>
  (
    await sql<{ id: string; event_type: string; aggregate_id: string }>`
      SELECT id::text AS id, event_type, aggregate_id::text FROM platform.outbox_event
      ORDER BY recorded_at, id`.execute(owner)
  ).rows.filter((r) => !baseline.has(r.id));

/** Row counts of every table the worker must never write. */
const forbiddenFootprint = async () =>
  Promise.all(
    [
      'results.result',
      'results.result_version',
      'results.result_status_transition',
      'results.classification_derivation',
      'results.classification_input',
      'verification.run',
      'achievement.achievement',
      'achievement.qualification_basis',
      'record.record_mark',
      'record.evaluation',
      'ranking.snapshot',
      'ranking.snapshot_entry',
    ].map(async (t) => [
      t,
      await countOf(owner, sql<{ n: string }>`SELECT count(*)::text AS n FROM ${sql.raw(t)}`),
    ]),
  );

const runsOf = async (systemVersionId: string, asOf: Date) =>
  (
    await sql<{
      id: string;
      input_hash: string;
      outcome_hash: string;
      trigger: string;
      publication_state: string;
      publication_reasons: string[];
      entry_count: number;
      outcome: { candidates: { reasons: string[] }[] };
    }>`
      SELECT id::text AS id, input_hash, outcome_hash, trigger, publication_state, publication_reasons,
             entry_count, outcome
      FROM ranking.run WHERE system_version_id = ${systemVersionId} AND as_of = ${asOf}`.execute(
      owner,
    )
  ).rows;

beforeAll(async () => {
  catalog = await seedTestCatalog(identity, new CatalogStore(op));
}, 120_000);

// ═════════════════════════════ event filtering and identity ═════════════════════════════

describe('consumed events and payload validation', () => {
  const synthetic = (eventType: string, aggregateType: string, aggregateId: string, payload = {}) =>
    ({
      eventId: newId(),
      eventType,
      eventVersion: 1,
      aggregateType,
      aggregateId,
      occurredAt: new Date(),
      payload,
    }) as unknown as DomainEvent;

  it('12. unrelated events — including ranking / classification / achievement / record events — are ignored', async () => {
    const baseline = await outboxIds();
    const before = await forbiddenFootprint();
    for (const t of [
      'ClassificationStale',
      'RankingRunEvaluated',
      'RankingSnapshotPublished',
      'RankingSystemVersionPublished',
      'ClassificationPolicyVersionPublished',
      'AchievementDerived',
      'AchievementCurrentStateChanged',
      'RecordMarkRatified',
      'ResultCreated',
      'AthleteCreated',
    ])
      expect(await reactor.react(synthetic(t, 'RESULT_VERSION', newId()))).toBeUndefined();
    expect(await emittedSince(baseline)).toEqual([]);
    expect(await forbiddenFootprint()).toEqual(before);
  });

  it('payload validation: a consumed type with an invalid identity is acknowledged as invalid, with no effect', async () => {
    const baseline = await outboxIds();
    const invalid = [
      synthetic('ResultProvisional', 'RESULT', newId()),
      synthetic('ResultProvisional', 'RESULT_VERSION', 'not-a-uuid'),
      synthetic('ResultSubmitted', 'RESULT_VERSION', newId(), { resultVersionId: newId() }),
      synthetic('VerificationEvaluated', 'VERIFICATION_RUN', newId()),
      synthetic('VerificationEvaluated', 'RESULT_VERSION', newId(), { resultVersionId: newId() }),
      { ...synthetic('ResultProvisional', 'RESULT_VERSION', newId()), occurredAt: new Date(NaN) },
    ];
    for (const e of invalid)
      expect(await reactor.react(e)).toMatchObject({
        invalid: 'INVALID_EVENT_IDENTITY',
        staleness: { checked: 0, emitted: 0 },
        runs: { evaluated: 0, created: 0 },
      });
    // An unknown (well-formed) ResultVersion resolves to nothing: no guess, no effect.
    expect(
      await reactor.react(synthetic('ResultProvisional', 'RESULT_VERSION', newId())),
    ).toMatchObject({
      staleness: { checked: 0, emitted: 0 },
      runs: { evaluated: 0, created: 0 },
    });
    expect(await emittedSince(baseline)).toEqual([]);
    const rv = newId();
    expect(
      rankingWorkerTarget(
        synthetic('VerificationEvaluated', 'VERIFICATION_RUN', newId(), { resultVersionId: rv }),
      ),
    ).toBe(rv);
    expect(
      rankingWorkerTarget(
        synthetic('CurrentVerificationChanged', 'RESULT_VERSION', rv, { resultVersionId: rv }),
      ),
    ).toBe(rv);
  });
});

// ═════════════════════════════ classification staleness (canonical lane) ═════════════════════════════

describe('ClassificationStale production: affected classifications, pinned policy, idempotency', () => {
  let w: Awaited<ReturnType<typeof contestWorld>>;
  let other: Awaited<ReturnType<typeof contestWorld>>;
  let comp: Awaited<ReturnType<typeof submitClassification>>;
  let evt: Awaited<ReturnType<typeof submitClassification>>;
  let round: Awaited<ReturnType<typeof submitClassification>>;
  let unrelated: Awaited<ReturnType<typeof submitClassification>>;
  let compPolicy: string;
  let frozen: Map<string, string>;
  let second: Awaited<ReturnType<typeof contestWorld>>;
  let secondAccepted: DomainEvent;

  const contentOf = async (versionId: string) =>
    JSON.stringify(
      (
        await sql<{ content: unknown }>`
          SELECT content FROM results.result_version WHERE id = ${versionId}`.execute(owner)
      ).rows[0]?.content,
    );

  beforeAll(async () => {
    compPolicy = await soleBinding('COMPETITION_CLASSIFICATION', 'Fictional competition table');
    await soleBinding('EVENT_CLASSIFICATION', 'Fictional event table');
    await soleBinding('ROUND_CLASSIFICATION', 'Fictional round table');
    w = await contestWorld({ winnerMs: '10870', loserMs: '11020' });
    other = await contestWorld({ winnerMs: '10900', loserMs: '11000' });
    comp = await submitClassification(
      w,
      'COMPETITION_CLASSIFICATION',
      w.competitionId,
      await scopeOf('COMPETITION', w.competitionId),
    );
    evt = await submitClassification(
      w,
      'EVENT_CLASSIFICATION',
      w.eventId,
      await scopeOf('EVENT', w.eventId),
    );
    round = await submitClassification(
      w,
      'ROUND_CLASSIFICATION',
      w.roundId,
      await scopeOf('ROUND', w.roundId),
    );
    unrelated = await submitClassification(
      other,
      'EVENT_CLASSIFICATION',
      other.eventId,
      await scopeOf('EVENT', other.eventId),
    );
    frozen = new Map();
    for (const v of [comp, evt, round, unrelated])
      frozen.set(v.versionId, await contentOf(v.versionId));
  }, 300_000);
  afterAll(async () => {
    // Leave no binding behind for other files (the binding is global per scope type + DV).
    for (const s of ['COMPETITION_CLASSIFICATION', 'EVENT_CLASSIFICATION', 'ROUND_CLASSIFICATION'])
      for (const id of await publishedPolicyVersions(s)) await retire(id);
  });

  it('2. scope resolution: a contest status change reaches its round, event and competition classifications only', async () => {
    const rs = new ClassificationStalenessService(rw, { role: ModuleRole.rankings });
    expect(await rs.affectedBy(w.resultVersionId)).toEqual(
      [comp.versionId, evt.versionId, round.versionId].sort(),
    );
    expect(await rs.affectedBy(other.resultVersionId)).toEqual([unrelated.versionId]);
    // A classification version is its own scope; an unknown or malformed id resolves to nothing.
    expect(await rs.affectedBy(comp.versionId)).toEqual([comp.versionId]);
    expect(await rs.affectedBy(newId())).toEqual([]);
    expect(await rs.affectedBy('nope')).toEqual([]);
  });

  it('0029: the worker login computes the same staleness as the API login, for every scope (round included)', async () => {
    const rs = new ClassificationStalenessService(rw, { role: ModuleRole.rankings });
    for (const v of [comp, evt, round, unrelated])
      expect(JSON.stringify(await rs.read(v.versionId))).toBe(
        JSON.stringify(await staleness.read(v.versionId)),
      );
    // The worker login can never become br_results (the default role of the service).
    await expect(new ClassificationStalenessService(rw).read(comp.versionId)).rejects.toThrow();
    const { rows } = await sql<{ col: string; ok: boolean }>`
      SELECT c.column_name AS col, has_column_privilege('br_rankings', 'competition.round', c.column_name, 'SELECT') AS ok
      FROM information_schema.columns c WHERE c.table_schema = 'competition' AND c.table_name = 'round'
      ORDER BY 1`.execute(owner);
    expect(rows.filter((r) => r.ok).map((r) => r.col)).toEqual(['event_id', 'id']);
    const { rows: w2 } = await sql<{ priv: string; ok: boolean }>`
      SELECT p.priv, has_table_privilege('br_rankings', 'competition.round', p.priv) AS ok
      FROM (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)`.execute(owner);
    expect(w2.filter((r) => r.ok)).toEqual([]);
  });

  it('3 & 7. CURRENT classifications: the reaction checks them and emits nothing', async () => {
    const baseline = await outboxIds();
    const r = await reactor.react(await outboxEvent(w.resultVersionId, 'ResultProvisional'));
    expect(r).toMatchObject({
      resultVersionId: w.resultVersionId,
      staleness: { checked: 3, emitted: 0 },
    });
    expect(
      (await emittedSince(baseline)).filter((e) => e.event_type === 'ClassificationStale'),
    ).toEqual([]);
  });

  it('1, 2, 3, 4 & 5. a new admissible contest ⇒ ClassificationStale for the competition classification only, under its PINNED policy', async () => {
    // Rebinding the scope's policy is not a stale condition: staleness is evaluated under the pin.
    await soleBinding('COMPETITION_CLASSIFICATION', 'Fictional competition table two');
    second = await contestWorld(
      { winnerMs: '10950', loserMs: '11050' },
      { organizer: w.organizer, competitionId: w.competitionId },
      false,
    );
    // SUBMITTED only: not admissible. The submission event is a run trigger, not a staleness trigger.
    const submitted = await reactor.react(
      await outboxEvent(second.resultVersionId, 'ResultSubmitted'),
    );
    expect(submitted?.staleness).toEqual({ checked: 0, emitted: 0 });
    expect(await staleEventsOf(comp.versionId)).toEqual([]);

    await second.accept();
    secondAccepted = await outboxEvent(second.resultVersionId, 'ResultProvisional');
    const baseline = await outboxIds();
    const r = await reactor.react(secondAccepted);
    expect(r).toMatchObject({ staleness: { checked: 1, emitted: 1 } });

    const events = await staleEventsOf(comp.versionId);
    expect(events).toHaveLength(1);
    const read = await staleness.read(comp.versionId);
    if (read.staleness.state !== 'STALE') throw new Error('must be stale');
    expect(read.derivation?.policy.policyVersionId).toBe(compPolicy); // the pin, not the rebinding
    expect(events[0]?.payload).toMatchObject({
      resultId: comp.resultId,
      classificationVersionId: comp.versionId,
      contentHash: comp.contentHash,
      staleDigest: read.staleness.staleDigest,
      reasons: ['ADMISSIBLE_INPUT_SET_CHANGED'],
      notCurrent: [],
      added: [second.resultVersionId],
      removed: [],
    });
    // Other scopes: the first contest's event and round, and the unrelated competition, stay CURRENT.
    for (const v of [evt, round, unrelated]) {
      expect(await staleEventsOf(v.versionId)).toEqual([]);
      expect((await staleness.read(v.versionId)).staleness.state).toBe('CURRENT');
    }
    // The only classification-side output is that one event.
    expect(
      (await emittedSince(baseline)).filter((e) => e.event_type !== 'RankingRunEvaluated'),
    ).toEqual([
      expect.objectContaining({ event_type: 'ClassificationStale', aggregate_id: comp.versionId }),
    ]);
  });

  it('5 & 6. history is immutable: no re-derivation, no new version, no replacement; the stale version stays current', async () => {
    for (const v of [comp, evt, round, unrelated])
      expect(await contentOf(v.versionId)).toBe(frozen.get(v.versionId));
    expect(
      await countOf(
        owner,
        sql`SELECT count(*)::text AS n FROM results.result_version WHERE result_id = ${comp.resultId}`,
      ),
    ).toBe(1);
    expect((await staleness.read(comp.versionId)).staleness.state).toBe('STALE');
  });

  it('9 & E. redelivery of the same event is a semantic no-op', async () => {
    const before = await forbiddenFootprint();
    const baseline = await outboxIds();
    for (let i = 0; i < 3; i++)
      expect(await reactor.react(secondAccepted)).toMatchObject({
        staleness: { checked: 1, emitted: 0 },
        runs: { created: 0 },
      });
    expect(await staleEventsOf(comp.versionId)).toHaveLength(1);
    expect(await emittedSince(baseline)).toEqual([]);
    expect(await forbiddenFootprint()).toEqual(before);
  });

  it('10. concurrent duplicate deliveries (reactions and outbox consumers) produce one logical effect', async () => {
    const baseline = await outboxIds();
    const outs = await Promise.all([1, 2, 3, 4].map(() => reactor.react(secondAccepted)));
    expect(outs.every((o) => o?.staleness.emitted === 0)).toBe(true);
    // Through the real consumer: four concurrent rounds of a fresh consumer, restricted to our event.
    const consumer = `${RANKING_WORKER_CONSUMER}.test-${newId()}`;
    const handled: string[] = [];
    const roundOf = () =>
      consumeOutbox(
        worker,
        consumer,
        async (event) => {
          if (event.eventId !== secondAccepted.eventId) return;
          handled.push(event.eventId);
          await reactor.react(event);
        },
        100_000,
      );
    await Promise.all([1, 2, 3, 4].map(roundOf));
    await roundOf();
    expect(handled).toEqual([secondAccepted.eventId]); // the receipt: delivered and acknowledged once
    expect(await staleEventsOf(comp.versionId)).toHaveLength(1);
    expect(await emittedSince(baseline)).toEqual([]);
  });

  it('11 & D. a failed attempt (effects committed, receipt rolled back) is retried safely', async () => {
    const third = await contestWorld(
      { winnerMs: '10990', loserMs: '11090' },
      { organizer: w.organizer, competitionId: w.competitionId },
    );
    const accepted = await outboxEvent(third.resultVersionId, 'ResultProvisional');
    const consumer = `${RANKING_WORKER_CONSUMER}.test-${newId()}`;
    const results: Awaited<ReturnType<RankingWorkerService['react']>>[] = [];
    let fail = true;
    const roundOf = () =>
      consumeOutbox(
        worker,
        consumer,
        async (event) => {
          if (event.eventId !== accepted.eventId) return;
          results.push(await reactor.react(event));
          if (fail) throw new Error('transient failure after the reaction committed');
        },
        100_000,
      );
    await expect(roundOf()).rejects.toThrow('transient failure');
    fail = false;
    await roundOf();
    await roundOf();
    expect(results).toHaveLength(2); // redelivered once, then acknowledged
    expect(results[0]?.staleness.emitted).toBe(1); // a NEW stale state (new digest) ⇒ a new event
    expect(results[1]?.staleness.emitted).toBe(0);
    expect(results[1]?.runs.created).toBe(0);
    const events = await staleEventsOf(comp.versionId);
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.payload.staleDigest)).size).toBe(2);
    expect(events[1]?.payload.added).toEqual(
      [second.resultVersionId, third.resultVersionId].sort(),
    );
  });

  it('13 & 14. no QUALIFIED, record, prize, trophy, snapshot or result side effect; no consequence events', async () => {
    const fourth = await contestWorld(
      { winnerMs: '11100', loserMs: '11200' },
      { organizer: w.organizer, competitionId: w.competitionId },
    );
    const accepted = await outboxEvent(fourth.resultVersionId, 'ResultProvisional');
    const before = await forbiddenFootprint();
    const baseline = await outboxIds();
    await reactor.react(accepted);
    await reactor.react(await outboxEvent(fourth.resultVersionId, 'ResultSubmitted'));
    expect(await forbiddenFootprint()).toEqual(before);
    const types = new Set((await emittedSince(baseline)).map((e) => e.event_type));
    for (const t of types) expect(['ClassificationStale', 'RankingRunEvaluated']).toContain(t);
    expect(types.has('ClassificationStale')).toBe(true);
  });
});

// ═════════════════════════════ canonical ranking runs ═════════════════════════════

describe('canonical ranking runs reacting to candidate fact changes (never published)', () => {
  let systemVersionId: string;
  let w: Awaited<ReturnType<typeof contestWorld>>;
  let submitted: DomainEvent;

  beforeAll(async () => {
    const { rows } = await sql<{ sport: string }>`
      SELECT s.code AS sport FROM sports.discipline_version v
      JOIN sports.discipline d ON d.id = v.discipline_id JOIN sports.sport s ON s.id = d.sport_id
      WHERE v.id = ${catalog.timedSingles}`.execute(owner);
    const eff = futureIso(3);
    const { systemId } = await definitions.createRankingSystem({
      operatorAccountId: catalog.operatorAccountId,
      code: `rk-${newId().slice(-12)}`,
      name: 'Fictional best marks',
      kind: 'PLATFORM',
      idempotencyKey: k('rs'),
    });
    const v = await definitions.createRankingSystemVersion({
      operatorAccountId: catalog.operatorAccountId,
      systemId,
      spec: rankingSpec({
        universe: {
          disciplineVersionId: catalog.timedSingles,
          metric: { key: 'elapsedTimeMs', markMetricId: 'athletics.100m.time' },
          resultScope: 'CONTEST',
          holderType: 'ATHLETE',
          population: {},
        },
        recognition: { level: 'PLATFORM', sport: [rows[0]?.sport as string] },
        effectiveFrom: eff,
      }),
      idempotencyKey: k('rsv'),
    });
    await definitions.changeRankingSystemVersionStatus({
      operatorAccountId: catalog.operatorAccountId,
      systemVersionId: v.systemVersionId,
      status: 'PUBLISHED',
    });
    systemVersionId = v.systemVersionId;
    await awaitDbTimePast(api, eff);
    w = await contestWorld({ winnerMs: '10400', loserMs: '10500' }, undefined, false);
    submitted = await outboxEvent(w.resultVersionId, 'ResultSubmitted');
  }, 180_000);

  it('6, 7 & 8. a candidate change ⇒ one canonical run at the event cutoff: re-assembled, BLOCKED with exact blockers, never published', async () => {
    const baseline = await outboxIds();
    const r = await reactor.react(submitted);
    expect(r?.runs.evaluated).toBeGreaterThanOrEqual(1);
    const runs = await runsOf(systemVersionId, submitted.occurredAt);
    expect(runs).toHaveLength(1);
    const run = runs[0];
    if (run === undefined) throw new Error('run');
    expect(run).toMatchObject({
      trigger: 'UPSTREAM_FACT_CHANGED',
      publication_state: 'BLOCKED',
      publication_reasons: ['NO_RANKED_ENTRIES'],
      entry_count: 0,
    });
    // Missing facts never become publishable: every candidate carries its blockers (hold unknown).
    expect(run.outcome.candidates.length).toBeGreaterThanOrEqual(2);
    expect(run.outcome.candidates.every((c) => c.reasons.includes('HOLD_STATE_UNAVAILABLE'))).toBe(
      true,
    );
    // 3. The stored input is exactly the canonical re-assembly at that cutoff (pure engine re-run).
    const input = await inTransaction(rw, ModuleRole.rankings, (ctx) =>
      assembleRankingRunInput(ctx, { systemVersionId, asOf: submitted.occurredAt }),
    );
    const h = hashRankingRunInput(input);
    const ev = evaluateRankingRun(input);
    if (!h.ok || !ev.ok) throw new Error('canonical input');
    expect(run.input_hash).toBe(h.hash);
    expect(run.outcome_hash).toBe(ev.outcomeHash);
    // One RankingRunEvaluated for our run; no snapshot, no publication event.
    const emitted = await emittedSince(baseline);
    expect(emitted.filter((e) => e.aggregate_id === run.id).map((e) => e.event_type)).toEqual([
      'RankingRunEvaluated',
    ]);
    expect(emitted.some((e) => e.event_type === 'RankingSnapshotPublished')).toBe(false);
    expect(
      await countOf(
        owner,
        sql`SELECT count(*)::text AS n FROM ranking.snapshot s
        JOIN ranking.run r ON r.id = s.run_id WHERE r.system_version_id = ${systemVersionId}`,
      ),
    ).toBe(0);
  });

  it('9 & 10. redelivered and concurrent deliveries collapse on the run natural key', async () => {
    const baseline = await outboxIds();
    const outs = await Promise.all([1, 2, 3, 4].map(() => reactor.react(submitted)));
    expect(outs.every((o) => o?.runs.created === 0)).toBe(true);
    expect(await runsOf(systemVersionId, submitted.occurredAt)).toHaveLength(1);
    expect(await emittedSince(baseline)).toEqual([]);
  });

  it('a later status change is a new cutoff and a new honest run; the earlier run is unchanged', async () => {
    const [prior] = await runsOf(systemVersionId, submitted.occurredAt);
    await w.accept();
    const accepted = await outboxEvent(w.resultVersionId, 'ResultProvisional');
    await reactor.react(accepted);
    const runs = await runsOf(systemVersionId, accepted.occurredAt);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.input_hash).not.toBe(prior?.input_hash);
    expect(await runsOf(systemVersionId, submitted.occurredAt)).toEqual([prior]);
  });

  it('15. read models stay rebuildable and deterministic: incremental == full rebuild == second rebuild', async () => {
    // Baseline: earlier files may hold raw (owner-written) foundation rows that no writer projected.
    await rebuildRankingReadModels(maintenance);
    // A new candidate change: the worker's run is projected by the run writer itself (run_card), in
    // the same transaction — the worker writes no projection of its own.
    const fresh = await contestWorld({ winnerMs: '10350', loserMs: '10450' }, undefined, false);
    const event = await outboxEvent(fresh.resultVersionId, 'ResultSubmitted');
    await reactor.react(event);
    const [run] = await runsOf(systemVersionId, event.occurredAt);
    if (run === undefined) throw new Error('run');
    const { rows } = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM ranking_read.run_card WHERE run_id = ${run.id}`.execute(
      owner,
    );
    expect(rows[0]?.n).toBe('1');
    const incremental = await snapshotRankingReadModels(maintenance);
    await rebuildRankingReadModels(maintenance);
    const full = await snapshotRankingReadModels(maintenance);
    await rebuildRankingReadModels(maintenance);
    expect(full).toEqual(incremental);
    expect(await snapshotRankingReadModels(maintenance)).toEqual(full);
  });

  it('a RETIRED / unrelated system version is not evaluated (selection only; the engine decides the rest)', async () => {
    const { rows } = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM ranking.run WHERE system_version_id = ${systemVersionId}`.execute(
      owner,
    );
    const n = Number(rows[0]?.n);
    await definitions.changeRankingSystemVersionStatus({
      operatorAccountId: catalog.operatorAccountId,
      systemVersionId,
      status: 'RETIRED',
    });
    const later = await contestWorld({ winnerMs: '10300', loserMs: '10450' }, undefined, false);
    await reactor.react(await outboxEvent(later.resultVersionId, 'ResultSubmitted'));
    expect(
      await countOf(
        owner,
        sql`SELECT count(*)::text AS n FROM ranking.run WHERE system_version_id = ${systemVersionId}`,
      ),
    ).toBe(n);
  });

  it('least privilege: the worker login cannot write results, classifications, achievements or records', async () => {
    await expect(inTransaction(rw, ModuleRole.results, async () => undefined)).rejects.toThrow();
    for (const t of [
      'results.result_version',
      'results.classification_derivation',
      'achievement.achievement',
      'record.record_mark',
    ])
      await expect(
        inTransaction(rw, ModuleRole.rankings, (ctx) =>
          sql`INSERT INTO ${sql.raw(t)} DEFAULT VALUES`.execute(ctx.trx),
        ),
      ).rejects.toMatchObject(DENIED);
  });
});
