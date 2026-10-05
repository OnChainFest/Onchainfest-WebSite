import { newId, type AuthorityScope, type DomainEvent, type Uuid } from '@br/domain';
import {
  AuthorityStore,
  CatalogStore,
  CompetitionHierarchyResolver,
  CompetitionStore,
  consumeOutbox,
  createCompetitionResultLedger,
  IdentityStore,
  OrganizationStore,
  RANKING_WORKER_CONSUMER,
  RankingDefinitionStore,
  RankingStaffReader,
  RankingWorkerService,
  rebuildRankingReadModels,
  snapshotRankingReadModels,
  StructureStore,
  type Db,
} from '@br/persistence';
import { forbiddenMembers } from '@br/rankings';
import { rankingSpec } from '@br/rankings/fixtures';
import {
  apiDb,
  awaitDbTimePast,
  brt10ConsequenceFootprint,
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
import { createDevTokenAuth, mintDevToken } from './auth';
import { buildServer } from './server';

/**
 * BRT-10 Step 15 — ONE integrated story across every real boundary, on the canonical lane:
 *
 *   RankingDefinitionStore (br_ranking_operator_app → br_ranking_rules)  definitions + policy
 *   ResultLedger (br_api → br_results)                                   contest, `@2` classification, second contest
 *   platform.outbox_event → consumeOutbox → RankingWorkerService         (br_ranking_worker_app → br_rankings)
 *   /v1 (br_api: br_public_read / br_results / br_ranking_staff_reader)  what the public and staff then see
 *   rebuildRankingReadModels (br_maintenance → br_rebuild)               projections are not a source of truth
 *
 * The worker's effects are exactly ClassificationStale + BLOCKED canonical runs; it never touches the
 * ResultLedger, never publishes, never derives QUALIFIED. The public API then shows the classification
 * STALE (computed at read time, no staleDigest or pins), an empty snapshot history, and the staff
 * route shows the worker-created run with every candidate blocker. ALL DATA IS FICTIONAL.
 *
 * Other files leave their own events in the shared outbox: the consumer here is a dedicated test
 * consumer (the real `consumeOutbox` + the real reaction) that reacts only to this story's events.
 */
const SECRET = `ranking-flow-auth-secret-${newId()}`;
const tag = newId().replace(/-/g, '').slice(-10);
const logLines: string[] = [];
const db = apiDb();
const owner = ownerDb();
const maintenance = maintenanceDb();
const catalogOperator = operatorDb();
const worker = workerDb();
const rop = rankingOperatorDb();
const rw = rankingWorkerDb();
const app = buildServer({
  db,
  auth: (identity: IdentityStore) => createDevTokenAuth(identity, { secret: SECRET }),
  logStream: { write: (line: string) => void logLines.push(line) },
});
afterAll(async () => {
  await app.close();
  await Promise.all(
    [db, owner, maintenance, catalogOperator, worker, rop, rw].map((d) => d.destroy()),
  );
});

const k = (p = 'k') => `${p}-${newId()}`;
const futureIso = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
const bearer = (sub: string, operator = false) => ({
  authorization: `Bearer ${mintDevToken(sub, { secret: SECRET, operator })}`,
});
const orgH = bearer(`rk-flow-org-${tag}`);
const opH = bearer(`rk-flow-operator-${tag}`, true);
const publicBodies: string[] = [];
const staffBodies: string[] = [];

async function call(url: string, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: 'GET', url, headers });
  if (url.includes('/internal/')) staffBodies.push(res.body);
  else if (/ranking|classification/.test(url)) publicBodies.push(res.body);
  return {
    status: res.statusCode,
    headers: res.headers,
    text: res.body,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form JSON navigation in tests
    json: res.json() as any,
  };
}

const identity = new IdentityStore(db);
const authority = new AuthorityStore(db, { conflictChecker: declaredNoParticipation });
const ledger = createCompetitionResultLedger(db, { conflictChecker: declaredNoParticipation });
const resolver = new CompetitionHierarchyResolver(db);
const definitions = new RankingDefinitionStore(rop);
const reactor = new RankingWorkerService(rw);
let catalog: TestCatalog;

const scopeOf = async (level: 'CONTEST' | 'COMPETITION', id: string) =>
  ({ ...(await resolver.scopeOf(level, id)), recognitionLevel: ['PLATFORM'] }) as AuthorityScope;

/** A real timed contest result through the ledger (SUBMITTED), plus an ACCEPT_RESULT holder. */
async function contest(
  timed: { winnerMs: string; loserMs: string },
  into?: {
    organizer: Awaited<ReturnType<typeof newContestResult>>['organizer'];
    competitionId: string;
  },
) {
  const w = await newContestResult({
    db,
    identity,
    orgs: new OrganizationStore(db),
    comps: new CompetitionStore(db),
    structure: new StructureStore(db),
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
  const accept = async (versionId: string, level: 'CONTEST' | 'COMPETITION', target: string) =>
    ledger.transition({
      resultVersionId: versionId as Uuid,
      toStatus: 'PROVISIONAL',
      actorPrincipalId: acceptor.id,
      scope: await scopeOf(level, target),
      idempotencyKey: k('accept'),
    });
  await accept(w.resultVersionId, 'CONTEST', w.contestId);
  return { ...w, accept };
}

/** Every ResultLedger fact (rows + content fingerprint): the worker must leave all of it untouched. */
async function ledgerFingerprint(d: Db) {
  const out: Record<string, unknown> = {};
  for (const t of [
    'results.result',
    'results.result_version',
    'results.result_status_transition',
    'results.result_draft',
    'results.classification_derivation',
    'results.classification_input',
    'ranking_read.classification_card',
    'ranking_read.classification_entry',
    'verification.run',
    'achievement.achievement',
    'achievement.qualification_basis',
    'record.record_mark',
    'ranking.system',
    'ranking.system_version',
    'ranking.system_version_status_change',
    'ranking.snapshot',
    'ranking.snapshot_entry',
    'platform.audit_event',
    'platform.ledger_entry',
  ])
    out[t] = (
      await sql
        .raw<{ n: string; h: string }>(
          `SELECT count(*)::text AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`,
        )
        .execute(d)
    ).rows[0];
  return out;
}

const outboxIds = async () =>
  new Set(
    (
      await sql<{ id: string }>`SELECT id::text AS id FROM platform.outbox_event`.execute(owner)
    ).rows.map((r) => r.id),
  );
const emittedSince = async (baseline: ReadonlySet<string>) =>
  (
    await sql<{ id: string; event_type: string; aggregate_id: string; payload: unknown }>`
      SELECT id::text AS id, event_type, aggregate_id::text, payload FROM platform.outbox_event
      ORDER BY recorded_at, id`.execute(owner)
  ).rows.filter((r) => !baseline.has(r.id));

describe('BRT-10 Step 15 — definitions → ledger → outbox → worker → /v1 (canonical lane, one story)', () => {
  let code: string;
  let systemId: string;
  let systemVersionId: string;
  let policyVersionId: string;
  let first: Awaited<ReturnType<typeof contest>>;
  let second: Awaited<ReturnType<typeof contest>>;
  let cls: { resultId: string; versionId: string; contentHash: string };
  const reactions: NonNullable<Awaited<ReturnType<RankingWorkerService['react']>>>[] = [];
  const consumed: DomainEvent[] = [];
  let workerRuns: {
    id: string;
    as_of: Date;
    trigger: string;
    publication_state: string;
    publication_reasons: string[];
    candidate_count: number;
  }[] = [];

  beforeAll(async () => {
    catalog = await seedTestCatalog(identity, new CatalogStore(catalogOperator));
    // First authentication provisions an account (a write): before any footprint is taken.
    for (const h of [orgH, opH]) expect((await call('/v1/me', h)).status).toBe(200);

    // ── 1. definitions, through the dedicated operator login only.
    for (const r of (
      await sql<{ id: string }>`
        SELECT v.id::text AS id FROM ranking.classification_policy_version v
        JOIN ranking.v_classification_policy_version_current s ON s.policy_version_id = v.id
        WHERE v.scope_type = 'COMPETITION_CLASSIFICATION' AND v.discipline_version_id = ${catalog.timedSingles}
          AND s.status = 'PUBLISHED'`.execute(owner)
    ).rows)
      await definitions.changeClassificationPolicyVersionStatus({
        operatorAccountId: catalog.operatorAccountId,
        policyVersionId: r.id,
        status: 'RETIRED',
      });
    const { policyId } = await definitions.createClassificationPolicy({
      operatorAccountId: catalog.operatorAccountId,
      code: `cp-${newId().slice(-12)}`,
      name: 'Fictional competition table',
      scopeType: 'COMPETITION_CLASSIFICATION',
      idempotencyKey: k('cp'),
    });
    policyVersionId = (
      await definitions.createClassificationPolicyVersion({
        operatorAccountId: catalog.operatorAccountId,
        policyId,
        spec: {
          targetEngine: 'classification-engine/1',
          displayName: 'Fictional competition table',
          scopeType: 'COMPETITION_CLASSIFICATION',
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
        },
        idempotencyKey: k('cpv'),
      })
    ).policyVersionId;
    await definitions.changeClassificationPolicyVersionStatus({
      operatorAccountId: catalog.operatorAccountId,
      policyVersionId,
      status: 'PUBLISHED',
    });
    const { rows } = await sql<{ sport: string }>`
      SELECT s.code AS sport FROM sports.discipline_version v JOIN sports.discipline d ON d.id = v.discipline_id
      JOIN sports.sport s ON s.id = d.sport_id WHERE v.id = ${catalog.timedSingles}`.execute(owner);
    const effectiveFrom = futureIso(3);
    code = `rk-flow-${tag}`;
    systemId = (
      await definitions.createRankingSystem({
        operatorAccountId: catalog.operatorAccountId,
        code,
        name: 'Fictional best marks',
        kind: 'PLATFORM',
        idempotencyKey: k('rs'),
      })
    ).systemId;
    systemVersionId = (
      await definitions.createRankingSystemVersion({
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
          effectiveFrom,
        }),
        idempotencyKey: k('rsv'),
      })
    ).systemVersionId;
    await definitions.changeRankingSystemVersionStatus({
      operatorAccountId: catalog.operatorAccountId,
      systemVersionId,
      status: 'PUBLISHED',
    });
    await awaitDbTimePast(db, effectiveFrom);

    // ── 2. the ResultLedger: a contest, its `@2` competition classification (T2 + T3), a second contest.
    first = await contest({ winnerMs: '10870', loserMs: '11020' });
    const { id: resultId } = await ledger.createResult({
      scopeType: 'COMPETITION_CLASSIFICATION',
      scopeTargetId: first.competitionId as Uuid,
    });
    const p = await ledger.proposeClassification(resultId);
    if (p.state !== 'PROPOSED' || p.outcome.proposal === undefined)
      throw new Error(`no proposal: ${JSON.stringify(p)}`);
    const { draftId } = await ledger.saveDraft({
      resultId,
      authorPrincipalId: first.submitterPrincipalId as Uuid,
      disciplineVersionRef: 'timed.singles@1',
      content: p.outcome.proposal.content,
    });
    const s = await ledger.submitDraft({
      draftId,
      actorPrincipalId: first.submitterPrincipalId as Uuid,
      scope: await scopeOf('COMPETITION', first.competitionId),
      idempotencyKey: k('submit'),
    });
    cls = {
      resultId,
      versionId: s.resultVersionId as string,
      contentHash: s.contentHash as string,
    };
    await first.accept(cls.versionId, 'COMPETITION', first.competitionId);
    second = await contest(
      { winnerMs: '10950', loserMs: '11050' },
      { organizer: first.organizer, competitionId: first.competitionId },
    );
  }, 300_000);
  afterAll(async () => {
    // The (scope type, DisciplineVersion) policy binding is global: leave none behind.
    await definitions.changeClassificationPolicyVersionStatus({
      operatorAccountId: catalog.operatorAccountId,
      policyVersionId,
      status: 'RETIRED',
    });
  });

  it('the operator definitions are public as a computed PLATFORM system with an empty snapshot history', async () => {
    const r = await call(`/v1/ranking-systems/${code}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      schema: 'br:public-ranking-system@1',
      systemId,
      code,
      kind: 'PLATFORM',
      label: 'Bragging Rights platform ranking',
      method: 'BEST_MARK',
      version: { latest: 1, lifecycle: 'PUBLISHED' },
    });
    for (const view of ['as-published', 'as-corrected']) {
      const h = await call(`/v1/ranking-systems/${code}/snapshots?view=${view}`);
      expect(h.status).toBe(200);
      expect(h.json).toEqual({
        schema: 'br:public-ranking-snapshot-history@1',
        systemId,
        view,
        items: [],
      });
    }
  });

  it('the REAL outbox → RankingWorkerService: ClassificationStale + BLOCKED canonical runs, and nothing else', async () => {
    // The story's own events (both contests, both classification transitions), as the worker sees them.
    const ours = new Set([first.resultVersionId, second.resultVersionId, cls.versionId]);
    const ledgerBefore = await ledgerFingerprint(owner);
    const footprintBefore = await brt10ConsequenceFootprint(owner);
    const baseline = await outboxIds();
    const consumer = `${RANKING_WORKER_CONSUMER}.flow-${newId()}`;
    const round = () =>
      consumeOutbox(
        worker,
        consumer,
        async (event) => {
          if (!ours.has(event.aggregateId)) return;
          consumed.push(event);
          const r = await reactor.react(event);
          if (r !== undefined) reactions.push(r);
        },
        100_000,
      );
    await round();
    // Delivered once: a second polling round of the same consumer redelivers none of them. What it
    // newly delivers about our ResultVersions is only the worker's OWN ClassificationStale (aggregate:
    // the classification version) — which the worker does not consume, so no loop exists.
    const n = consumed.length;
    const reacted = reactions.length;
    await round();
    expect(consumed.slice(n).map((e) => `${e.eventType}:${e.aggregateId}`)).toEqual([
      `ClassificationStale:${cls.versionId}`,
    ]);
    expect(reactions).toHaveLength(reacted);
    consumed.splice(n);

    const types = consumed.map((e) => `${e.eventType}:${e.aggregateId}`).sort();
    expect(types).toEqual(
      [
        `ResultSubmitted:${first.resultVersionId}`,
        `ResultProvisional:${first.resultVersionId}`,
        `ResultSubmitted:${cls.versionId}`,
        `ResultProvisional:${cls.versionId}`,
        `ResultSubmitted:${second.resultVersionId}`,
        `ResultProvisional:${second.resultVersionId}`,
      ].sort(),
    );
    expect(reactions.every((r) => r.invalid === undefined)).toBe(true);

    // Staleness: only the second contest's acceptance changes the classification's admissible set.
    const stale = (await emittedSince(baseline)).filter(
      (e) => e.event_type === 'ClassificationStale',
    );
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({
      aggregate_id: cls.versionId,
      payload: {
        classificationVersionId: cls.versionId,
        contentHash: cls.contentHash,
        reasons: ['ADMISSIBLE_INPUT_SET_CHANGED'],
        added: [second.resultVersionId],
        notCurrent: [],
        removed: [],
      },
    });

    // Runs: one per CONTEST event cutoff (the classification's own events select no system), every
    // one BLOCKED with the honest blockers; never a snapshot.
    workerRuns = (
      await sql<(typeof workerRuns)[number]>`
        SELECT id::text AS id, as_of, trigger, publication_state, publication_reasons, candidate_count
        FROM ranking.run WHERE system_version_id = ${systemVersionId} ORDER BY as_of, id`.execute(
        owner,
      )
    ).rows;
    const contestCutoffs = consumed
      .filter((e) => e.aggregateId !== cls.versionId)
      .map((e) => e.occurredAt.getTime())
      .sort((a, b) => a - b);
    expect(workerRuns.map((r) => r.as_of.getTime())).toEqual(contestCutoffs);
    for (const r of workerRuns)
      expect(r).toMatchObject({
        trigger: 'UPSTREAM_FACT_CHANGED',
        publication_state: 'BLOCKED',
        publication_reasons: ['NO_RANKED_ENTRIES'],
      });
    // The last cutoff sees both contests (two entrants each).
    expect(workerRuns.at(-1)?.candidate_count).toBe(4);

    // The worker's whole output: ClassificationStale + RankingRunEvaluated. No ledger, verification,
    // classification, snapshot, QUALIFIED, record or audit write; an unchanged consequence footprint.
    const emitted = await emittedSince(baseline);
    expect([...new Set(emitted.map((e) => e.event_type))].sort()).toEqual([
      'ClassificationStale',
      'RankingRunEvaluated',
    ]);
    expect(emitted.filter((e) => e.event_type === 'RankingRunEvaluated')).toHaveLength(
      workerRuns.length,
    );
    expect(await ledgerFingerprint(owner)).toEqual(ledgerBefore);
    expect(await brt10ConsequenceFootprint(owner)).toEqual(footprintBefore);

    // Replaying the whole story through another consumer is a semantic no-op (natural keys).
    const replay = `${RANKING_WORKER_CONSUMER}.flow-replay-${newId()}`;
    const again = new Set(await outboxIds());
    await consumeOutbox(
      worker,
      replay,
      async (event) => {
        if (consumed.some((e) => e.eventId === event.eventId)) await reactor.react(event);
      },
      100_000,
    );
    expect(await emittedSince(again)).toEqual([]);
    expect(await ledgerFingerprint(owner)).toEqual(ledgerBefore);
  });

  it('/v1: the classification is STALE at read time, its stored facts unchanged, no staleDigest or pins exposed', async () => {
    const before = await ledgerFingerprint(owner);
    const r = await call(`/v1/result-versions/${cls.versionId}/classification`);
    expect(r.status).toBe(200);
    expect(r.json.schema).toBe('br:public-classification@1');
    expect(r.json.classification).toMatchObject({
      resultVersionId: cls.versionId,
      resultId: cls.resultId,
      status: 'PROVISIONAL',
      contentHash: cls.contentHash,
      provenance: { available: true, policy: { policyVersionId } },
    });
    expect(r.json.readTime).toEqual({
      staleness: { state: 'STALE', reasons: ['ADMISSIBLE_INPUT_SET_CHANGED'] },
    });
    const [stale] = (
      await sql<{ payload: { staleDigest: string } }>`
        SELECT payload FROM platform.outbox_event
        WHERE event_type = 'ClassificationStale' AND aggregate_id = ${cls.versionId}`.execute(owner)
    ).rows;
    expect(stale?.payload.staleDigest).toMatch(/^sha256:/);
    expect(r.text).not.toContain(stale?.payload.staleDigest as string);
    expect(r.text).not.toMatch(/staleDigest|notCurrent|added|removed|derivedFrom/);
    for (const pin of [first.resultVersionId, second.resultVersionId])
      expect(r.text).not.toContain(pin);
    expect(forbiddenMembers(r.json)).toEqual([]);
    const e = await call(`/v1/result-versions/${cls.versionId}/classification/entries`);
    expect(e.status).toBe(200);
    expect(e.json.contentHash).toBe(cls.contentHash);
    expect(e.json.entries).toHaveLength(2);
    // Reading staleness wrote nothing.
    expect(await ledgerFingerprint(owner)).toEqual(before);
  });

  it('INTERNAL: the worker-created run through the staff route — BLOCKED, every candidate blocked; never public', async () => {
    const last = workerRuns.at(-1);
    if (last === undefined) throw new Error('no worker run');
    const url = `/v1/internal/ranking-runs/${last.id}`;
    expect((await call(url)).status).toBe(401);
    expect((await call(url, orgH)).status).toBe(403);
    const r = await call(url, opH);
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json).toMatchObject({
      schema: 'br:staff-ranking-run@1',
      run: {
        runId: last.id,
        systemId,
        systemVersionId,
        provenance: 'CANONICAL_ASSEMBLY',
        trigger: 'UPSTREAM_FACT_CHANGED',
        asOf: last.as_of.toISOString(),
        publicationState: 'BLOCKED',
        publicationReasons: ['NO_RANKED_ENTRIES'],
        entryCount: 0,
        candidateCount: 4,
      },
    });
    expect(
      [
        ...new Set(r.json.candidates.map((c: { resultVersionId: string }) => c.resultVersionId)),
      ].sort(),
    ).toEqual([first.resultVersionId, second.resultVersionId].sort());
    for (const c of r.json.candidates)
      expect(c.reasons).toEqual(
        expect.arrayContaining(['HOLD_STATE_UNAVAILABLE', 'RESULT_STATUS_BELOW_REQUIRED']),
      );
    expect(await new RankingStaffReader(db).run(last.id)).toEqual(r.json);
    // Nothing public serves the run: no snapshot, no history, no run id on any public surface.
    expect((await call(`/v1/ranking-snapshots/${last.id}`)).status).toBe(404);
    for (const view of ['as-published', 'as-corrected'])
      expect((await call(`/v1/ranking-systems/${code}/snapshots?view=${view}`)).json.items).toEqual(
        [],
      );
  });

  it('read models: incremental == full rebuild == second rebuild; the rebuild touches no canonical fact', async () => {
    const before = await ledgerFingerprint(owner);
    const incremental = await snapshotRankingReadModels(maintenance);
    await rebuildRankingReadModels(maintenance);
    const full = await snapshotRankingReadModels(maintenance);
    await rebuildRankingReadModels(maintenance);
    expect(full).toEqual(incremental);
    expect(await snapshotRankingReadModels(maintenance)).toEqual(full);
    expect(await ledgerFingerprint(owner)).toEqual(before);
    // The served surfaces are the same after the rebuild.
    expect(
      (await call(`/v1/result-versions/${cls.versionId}/classification`)).json.readTime,
    ).toEqual({ staleness: { state: 'STALE', reasons: ['ADMISSIBLE_INPUT_SET_CHANGED'] } });
  });

  it('leak scan: no public body names a run, pin, staleDigest, role, SQL or PostgreSQL detail', () => {
    const pub = publicBodies.join('\n');
    expect(pub).not.toMatch(
      /staleDigest|evidenceCommitment|verificationRunId|"basis"|derivedFrom|accountId|ownerPrincipal|anchorId|"runId"|runInputHash|runOutcomeHash/,
    );
    for (const r of workerRuns) expect(pub).not.toContain(r.id);
    for (const text of [pub, staffBodies.join('\n'), logLines.join('\n')])
      expect(text).not.toMatch(
        /\bbr_[a-z_]+\b|SELECT |INSERT INTO|ranking_read\.|pg_|\b42501\b|duplicate key/,
      );
  });
});
