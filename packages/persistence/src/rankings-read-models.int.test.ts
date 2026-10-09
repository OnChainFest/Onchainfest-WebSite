import { newId, PLATFORM_RANKING_LABEL, type AuthorityScope, type Uuid } from '@br/domain';
import { rankCandidate, rankingRunInput, rankingSpec } from '@br/rankings/fixtures';
import {
  apiDb,
  declaredNoParticipation,
  maintenanceDb,
  newContestResult,
  newTestAccount,
  operatorDb,
  ownerDb,
  seedTestCatalog,
  type TestCatalog,
} from '@br/testkit';
import {
  createRankingFixtureDatabase,
  rankingOperatorDb,
  rankingWorkerDb,
  type RankingFixtureDatabase,
} from '@br/testkit/rankings';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthorityStore } from './authority-store';
import { CatalogStore } from './catalog-store';
import {
  CompetitionHierarchyResolver,
  createCompetitionResultLedger,
} from './competition-hierarchy';
import { CompetitionStore } from './competition-store';
import { StructureStore } from './competition-structure-store';
import {
  databaseUrls,
  operatorDatabaseUrl,
  rankingOperatorDatabaseUrl,
  rankingWorkerDatabaseUrl,
} from './config';
import { createDb, type Db } from './db';
import { IdentityStore } from './identity-store';
import { OrganizationStore } from './organization-store';
import { RankingDefinitionStore } from './ranking-definition-store';
import { RankingHistoryReader } from './ranking-history';
import { persistRankingRun, publishRankingSnapshot } from './ranking-lanes';
import { rebuildRankingReadModels, snapshotRankingReadModels } from './ranking-projection';
import { RankingReadModelReader } from './ranking-read-model';
import { RankingService } from './ranking-store';
import { inTransaction, ModuleRole } from './tx';

/**
 * BRT-10 Step 8 — ranking_read.* read models (class B, ADR-0048 §9): refreshed in each writer's own
 * transaction, rebuilt by br_rebuild with the same functions, byte-equal between incremental and full
 * rebuild, never authoritative, never storing staleness. Canonical lane on the normal schema; snapshot
 * lineage in the THROWAWAY br_rkfx_ lane with REFERENCE FIXTURES — NOT SPORTING TRUTH.
 */
const DENIED = { code: '42501' };
const k = (p = 'k') => `${p}-${newId()}`;
const futureIso = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

const api = apiDb();
const owner = ownerDb();
const maintenance = maintenanceDb();
const rop = rankingOperatorDb();
const rw = rankingWorkerDb();
const op = operatorDb();
afterAll(async () => {
  await Promise.all([api, owner, maintenance, rop, rw, op].map((d) => d.destroy()));
});

const identity = new IdentityStore(api);
const authority = new AuthorityStore(api, { conflictChecker: declaredNoParticipation });
const ledger = createCompetitionResultLedger(api, { conflictChecker: declaredNoParticipation });
const resolver = new CompetitionHierarchyResolver(api);
const definitions = new RankingDefinitionStore(rop);
const reader = new RankingReadModelReader(api);
let catalog: TestCatalog;

const scopeOf = async (level: 'CONTEST' | 'EVENT' | 'COMPETITION', id: string) =>
  ({ ...(await resolver.scopeOf(level, id)), recognitionLevel: ['PLATFORM'] }) as AuthorityScope;

/** Canonical row counts + content fingerprints of every source a projection reads (must never move). */
async function canonicalFingerprint(db: Db) {
  const q = (text: string) => sql.raw(text).execute(db);
  const tables = [
    'results.result_version',
    'results.result_status_transition',
    'results.result_version_state',
    'results.classification_derivation',
    'results.classification_input',
    'ranking.system',
    'ranking.system_version',
    'ranking.system_version_status_change',
    'ranking.run',
    'ranking.run_dependency',
    'ranking.snapshot',
    'ranking.snapshot_entry',
    'platform.outbox_event',
    'platform.audit_event',
    'platform.ledger_entry',
  ];
  const out: Record<string, unknown> = {};
  for (const t of tables)
    out[t] = (
      await q(
        `SELECT count(*)::text AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`,
      )
    ).rows[0];
  return out;
}

const rebuildAndSnapshot = async (m: Db) => {
  await rebuildRankingReadModels(m);
  return snapshotRankingReadModels(m);
};

beforeAll(async () => {
  catalog = await seedTestCatalog(identity, new CatalogStore(op));
}, 120_000);

// ═════════════════════════════ canonical lane ═════════════════════════════

describe('canonical lane: classification, system and run projections', () => {
  let w: Awaited<ReturnType<typeof newContestResult>>;
  let acceptorId: Uuid;
  let classification: { resultId: string; versionId: string; contentHash: string };
  let content: {
    entries: { participantId: string; rank: number; tied: boolean; tieBreakKeys: unknown[] }[];
  };
  let system: { systemId: string; systemVersionId: string };
  let runId: string;
  let policyVersionId: string;

  beforeAll(async () => {
    // Baseline: earlier files may hold raw (owner-written) foundation rows that no writer projected.
    // From here on, every fact enters through a writer, so the projections are incremental.
    await rebuildRankingReadModels(maintenance);
    for (const id of (
      await sql<{ id: string }>`
        SELECT v.id::text AS id FROM ranking.classification_policy_version v
        JOIN ranking.v_classification_policy_version_current s ON s.policy_version_id = v.id
        WHERE v.scope_type = 'EVENT_CLASSIFICATION' AND v.discipline_version_id = ${catalog.timedSingles}
          AND s.status = 'PUBLISHED'`.execute(owner)
    ).rows)
      await definitions.changeClassificationPolicyVersionStatus({
        operatorAccountId: catalog.operatorAccountId,
        policyVersionId: id.id,
        status: 'RETIRED',
      });
    const { policyId } = await definitions.createClassificationPolicy({
      operatorAccountId: catalog.operatorAccountId,
      code: `cp-${newId().slice(-12)}`,
      name: 'Fictional table',
      scopeType: 'EVENT_CLASSIFICATION',
      idempotencyKey: k('cp'),
    });
    const pv = await definitions.createClassificationPolicyVersion({
      operatorAccountId: catalog.operatorAccountId,
      policyId,
      spec: {
        targetEngine: 'classification-engine/1',
        displayName: 'Fictional event table',
        scopeType: 'EVENT_CLASSIFICATION',
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
    });
    policyVersionId = pv.policyVersionId;
    await definitions.changeClassificationPolicyVersionStatus({
      operatorAccountId: catalog.operatorAccountId,
      policyVersionId,
      status: 'PUBLISHED',
    });
    w = await newContestResult({
      db: api,
      identity,
      orgs: new OrganizationStore(api),
      comps: new CompetitionStore(api),
      structure: new StructureStore(api),
      authority,
      ledger,
      resolver,
      catalog,
      timed: { winnerMs: '10870', loserMs: '11020' },
    });
    const acceptor = await authority.registerPrincipal({
      principalType: 'PERSON',
      label: 'judge (fixture)',
    });
    acceptorId = acceptor.id;
    await authority.issueGrant({
      actorPrincipalId: w.platformPrincipalId,
      grantorPrincipalId: w.platformPrincipalId,
      granteePrincipalId: acceptor.id,
      capabilities: ['ACCEPT_RESULT'],
      scope: { recognitionLevel: ['PLATFORM'], competition: [w.competitionId as Uuid] },
      delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
    });
    await ledger.transition({
      resultVersionId: w.resultVersionId,
      toStatus: 'PROVISIONAL',
      actorPrincipalId: acceptorId,
      scope: await scopeOf('CONTEST', w.contestId),
      idempotencyKey: k('accept'),
    });
    const { id: resultId } = await ledger.createResult({
      scopeType: 'EVENT_CLASSIFICATION',
      scopeTargetId: w.eventId as Uuid,
    });
    const p = await ledger.proposeClassification(resultId);
    if (p.state !== 'PROPOSED' || p.outcome.proposal === undefined) throw new Error('no proposal');
    content = p.outcome.proposal.content as unknown as typeof content;
    const { draftId } = await ledger.saveDraft({
      resultId,
      authorPrincipalId: w.submitterPrincipalId,
      disciplineVersionRef: 'timed.singles@1',
      content: p.outcome.proposal.content,
    });
    const s = await ledger.submitDraft({
      draftId,
      actorPrincipalId: w.submitterPrincipalId,
      scope: await scopeOf('EVENT', w.eventId),
      idempotencyKey: k('submit'),
    });
    classification = { resultId, versionId: s.resultVersionId, contentHash: s.contentHash };

    const { systemId } = await definitions.createRankingSystem({
      operatorAccountId: catalog.operatorAccountId,
      code: `rk-${newId().slice(-12)}`,
      name: 'Fictional best marks',
      kind: 'PLATFORM',
      idempotencyKey: k('rs'),
    });
    const { rows } = await sql<{ sport: string }>`
      SELECT s.code AS sport FROM sports.discipline_version v JOIN sports.discipline d ON d.id = v.discipline_id
      JOIN sports.sport s ON s.id = d.sport_id WHERE v.id = ${catalog.timedSingles}`.execute(owner);
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
        recognition: { level: 'PLATFORM', sport: [rows[0]?.sport] },
        effectiveFrom: futureIso(3),
      }),
      idempotencyKey: k('rsv'),
    });
    system = { systemId, systemVersionId: v.systemVersionId };
  }, 300_000);
  afterAll(async () => {
    await definitions.changeClassificationPolicyVersionStatus({
      operatorAccountId: catalog.operatorAccountId,
      policyVersionId,
      status: 'RETIRED',
    });
  });

  it('a derived classification has a card refreshed at T2: exact pins, hashes and ranks copied, never re-ranked', async () => {
    const r = await reader.classification(classification.versionId);
    expect(r?.card).toMatchObject({
      classification_version_id: classification.versionId,
      result_id: classification.resultId,
      scope_type: 'EVENT_CLASSIFICATION',
      scope_target_id: w.eventId,
      version_number: 1,
      content_schema: 'br:result-version-content@2',
      content_hash: classification.contentHash,
      policy_version_id: policyVersionId,
      discipline_version_id: catalog.timedSingles,
      engine_version: 'classification-engine/1',
      input_count: 1,
      pinned_input_ids: [w.resultVersionId],
      status: 'SUBMITTED',
    });
    const { rows } = await sql<{ inputs_digest: string }>`
      SELECT inputs_digest FROM results.classification_derivation WHERE result_version_id = ${classification.versionId}`.execute(
      owner,
    );
    expect(r?.card.inputs_digest).toBe(rows[0]?.inputs_digest);
    const expected = [...content.entries]
      .sort((a, b) => a.rank - b.rank || (a.participantId < b.participantId ? -1 : 1))
      .map((e) => ({
        participant_id: e.participantId,
        rank: e.rank,
        tied: e.tied,
        tie_break_keys: e.tieBreakKeys,
      }));
    expect(r?.entries).toEqual(expected);
    // No staleness, no current flag is stored anywhere in the projection.
    expect(Object.keys(r?.card ?? {}).some((c) => /stale|is_current/.test(c))).toBe(false);
  });

  it('a status transition refreshes the card in the ledger transaction (T3)', async () => {
    await ledger.transition({
      resultVersionId: classification.versionId as Uuid,
      toStatus: 'PROVISIONAL',
      actorPrincipalId: acceptorId,
      scope: await scopeOf('EVENT', w.eventId),
      idempotencyKey: k('accept-c'),
    });
    expect((await reader.classification(classification.versionId))?.card.status).toBe(
      'PROVISIONAL',
    );
  });

  it('contest results and legacy `@1` classifications get no classification card', async () => {
    expect(await reader.classification(w.resultVersionId)).toBeUndefined();
    const { rows } = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM ranking_read.classification_card c
      LEFT JOIN results.classification_derivation d ON d.result_version_id = c.classification_version_id
      WHERE d.result_version_id IS NULL`.execute(owner);
    expect(rows[0]?.n).toBe('0');
  });

  it('system card: lifecycle follows the definition facts; PLATFORM label computed; no owner ids', async () => {
    const card = async () =>
      (await reader.systems()).find((s) => s.system_id === system.systemId) as Record<
        string,
        unknown
      >;
    expect(await card()).toMatchObject({
      kind: 'PLATFORM',
      label: PLATFORM_RANKING_LABEL,
      latest_version_id: system.systemVersionId,
      latest_version: 1,
      latest_lifecycle: 'DRAFT',
      published_version_id: null,
    });
    await definitions.changeRankingSystemVersionStatus({
      operatorAccountId: catalog.operatorAccountId,
      systemVersionId: system.systemVersionId,
      status: 'PUBLISHED',
    });
    expect(await card()).toMatchObject({
      latest_lifecycle: 'PUBLISHED',
      published_version_id: system.systemVersionId,
      published_version: 1,
    });
    expect(Object.keys(await card()).some((c) => /owner|principal|anchor|account/.test(c))).toBe(
      false,
    );
  });

  it('run card + candidates (STAFF ONLY): BLOCKED canonical run projected with every blocker', async () => {
    const run = await new RankingService(rw).evaluate({
      systemVersionId: system.systemVersionId,
      trigger: 'STAFF_REQUEST',
    });
    runId = run.runId;
    const staff = await new RankingReadModelReader(rw).runForStaff(runId);
    const { rows } = await sql<{
      outcome: { candidates: { resultVersionId: string; state: string; reasons: string[] }[] };
      outcome_hash: string;
      publication_reasons: string[];
    }>`
      SELECT outcome, outcome_hash, publication_reasons FROM ranking.run WHERE id = ${runId}`.execute(
      owner,
    );
    const canonical = rows[0];
    expect(staff?.card).toMatchObject({
      run_id: runId,
      system_id: system.systemId,
      publication_state: 'BLOCKED',
      outcome_hash: canonical?.outcome_hash,
      publication_reasons: [...(canonical?.publication_reasons ?? [])].sort(),
    });
    expect(staff?.candidates).toHaveLength(canonical?.outcome.candidates.length ?? -1);
    for (const c of staff?.candidates ?? [])
      expect((c.reasons as string[]).length).toBeGreaterThan(0);
    // br_public_read has no grant on run projections.
    await expect(
      inTransaction(api, ModuleRole.publicRead, (ctx) =>
        sql`SELECT 1 FROM ranking_read.run_card`.execute(ctx.trx),
      ),
    ).rejects.toMatchObject(DENIED);
    await expect(
      inTransaction(api, ModuleRole.publicRead, (ctx) =>
        sql`SELECT 1 FROM ranking_read.run_candidate`.execute(ctx.trx),
      ),
    ).rejects.toMatchObject(DENIED);
  });

  it('rebuild: incremental == full, twice identical; canonical facts, events and audit untouched', async () => {
    const incremental = await snapshotRankingReadModels(maintenance);
    const before = await canonicalFingerprint(owner);
    const first = await rebuildAndSnapshot(maintenance);
    const second = await rebuildAndSnapshot(maintenance);
    expect(first).toEqual(incremental);
    expect(second).toEqual(first);
    expect(await canonicalFingerprint(owner)).toEqual(before);
    expect(first.classification_card.length).toBeGreaterThan(0);
    expect(first.system_card.length).toBeGreaterThan(0);
    expect(first.run_card.length).toBeGreaterThan(0);
    expect(first.snapshot_card).toEqual([]); // no FINAL producer: zero canonical snapshots
  });

  it('concurrent rebuilds serialize and converge on the same state', async () => {
    const ref = await snapshotRankingReadModels(maintenance);
    await Promise.all([
      rebuildRankingReadModels(maintenance),
      rebuildRankingReadModels(maintenance),
    ]);
    expect(await snapshotRankingReadModels(maintenance)).toEqual(ref);
  });

  it('a projection is never authoritative: a hand-edited rank is reverted by the rebuild, the fact unchanged', async () => {
    const ref = await snapshotRankingReadModels(maintenance);
    await sql`UPDATE ranking_read.classification_entry SET rank = 99 WHERE classification_version_id = ${classification.versionId}`.execute(
      owner,
    );
    const { rows } = await sql<{ content: unknown }>`
      SELECT content FROM results.result_version WHERE id = ${classification.versionId}`.execute(
      owner,
    );
    expect(rows[0]?.content).toEqual(content); // jsonb: structural equality
    expect(await rebuildAndSnapshot(maintenance)).toEqual(ref);
  });

  it('least privilege: read-model writers cannot write canonical facts; no PUBLIC; no DEFINER; public read only', async () => {
    const { rows } = await sql<{ role: string; t: string; priv: string }>`
      SELECT r.role, t.t, p.priv FROM
        (VALUES ('br_rebuild'), ('br_public_read'), ('br_ranking_rules'), ('br_rankings')) r(role),
        (VALUES ('results.result_version'), ('results.classification_derivation'), ('results.classification_input'),
                ('ranking.run'), ('ranking.snapshot'), ('ranking.snapshot_entry'), ('ranking.run_dependency'),
                ('ranking.system_version')) t(t),
        (VALUES ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)
      WHERE has_table_privilege(r.role, t.t, p.priv)`.execute(owner);
    expect(rows).toEqual([]);
    const { rows: ins } = await sql<{ role: string; t: string }>`
      SELECT r.role, t.t FROM (VALUES ('br_rebuild'), ('br_public_read')) r(role),
        (VALUES ('results.result_version'), ('ranking.run'), ('ranking.snapshot'), ('ranking.snapshot_entry'),
                ('results.classification_input'), ('platform.outbox_event')) t(t)
      WHERE has_table_privilege(r.role, t.t, 'INSERT')`.execute(owner);
    expect(ins).toEqual([]);
    const { rows: pub } = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM information_schema.role_table_grants
      WHERE grantee = 'PUBLIC' AND table_schema = 'ranking_read'`.execute(owner);
    expect(pub[0]?.n).toBe('0');
    const { rows: definer } = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'ranking_read'`.execute(owner);
    expect(definer[0]?.n).toBe('0');
    const { rows: pr } = await sql<{ t: string; priv: string }>`
      SELECT t.t, p.priv FROM (VALUES ('system_card'), ('snapshot_card'), ('leaderboard_entry'),
          ('classification_card'), ('classification_entry'), ('run_card'), ('run_candidate')) t(t),
        (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)
      WHERE has_table_privilege('br_public_read', 'ranking_read.' || t.t, p.priv)`.execute(owner);
    expect(pr).toEqual([]);
    // Each writer only maintains its own projections.
    const own = async (role: string, table: string) =>
      (
        await sql<{
          ok: boolean;
        }>`SELECT has_table_privilege(${role}, ${`ranking_read.${table}`}, 'INSERT') AS ok`.execute(
          owner,
        )
      ).rows[0]?.ok;
    expect(await own('br_results', 'snapshot_card')).toBe(false);
    expect(await own('br_rankings', 'classification_card')).toBe(false);
    expect(await own('br_ranking_rules', 'run_card')).toBe(false);
    expect(await own('br_results', 'classification_card')).toBe(true);
  });
});

// ═════════════════════════════ fixture lane: snapshot lineage projections ═════════════════════════════

describe('REFERENCE FIXTURE lane (br_rkfx_*): snapshot cards, leaderboards, history views', () => {
  let fx: RankingFixtureDatabase;
  const fdbs: Db[] = [];
  let fowner: Db;
  let fmaint: Db;
  let freader: RankingReadModelReader;
  let history: RankingHistoryReader;
  let systemId: string;
  const snaps: Record<string, string> = {};

  beforeAll(async () => {
    fx = await createRankingFixtureDatabase();
    const urls = databaseUrls(fx.database);
    const mk = (u: string | undefined) => {
      const d = createDb(u as string, { max: 3 });
      fdbs.push(d);
      return d;
    };
    const fapi = mk(urls.api);
    fowner = mk(urls.owner);
    fmaint = mk(urls.maintenance);
    const fw = mk(rankingWorkerDatabaseUrl(fx.database));
    freader = new RankingReadModelReader(fapi);
    history = new RankingHistoryReader(fw);
    const fop = new RankingDefinitionStore(mk(rankingOperatorDatabaseUrl(fx.database)));
    const fidentity = new IdentityStore(fapi);
    const fcat = await seedTestCatalog(
      fidentity,
      new CatalogStore(mk(operatorDatabaseUrl(fx.database))),
    );
    const operatorAccountId = (
      await newTestAccount(fidentity, { withPerson: false, label: 'rk-op' })
    ).accountId;
    const dv = fcat.running5k;
    const { rows } = await sql<{ sport: string; discipline: string }>`
      SELECT s.code AS sport, d.code AS discipline FROM sports.discipline_version v
      JOIN sports.discipline d ON d.id = v.discipline_id JOIN sports.sport s ON s.id = d.sport_id
      WHERE v.id = ${dv}`.execute(fowner);
    const codes = rows[0] as { sport: string; discipline: string };
    const eff = futureIso(3);
    const { systemId: sid } = await fop.createRankingSystem({
      operatorAccountId,
      code: `rk-${newId().slice(-12)}`,
      name: 'Fictional best marks',
      kind: 'PLATFORM',
      idempotencyKey: k('rs'),
    });
    const v = await fop.createRankingSystemVersion({
      operatorAccountId,
      systemId: sid,
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
      idempotencyKey: k('rsv'),
    });
    await fop.changeRankingSystemVersionStatus({
      operatorAccountId,
      systemVersionId: v.systemVersionId,
      status: 'PUBLISHED',
    });
    systemId = sid;
    const { rows: sv } = await sql<{ spec: Record<string, unknown>; code: string }>`
      SELECT v.spec, s.code FROM ranking.system_version v JOIN ranking.system s ON s.id = v.system_id
      WHERE v.id = ${v.systemVersionId}`.execute(fowner);
    const row = sv[0] as { spec: Record<string, unknown>; code: string };
    const later = (m: number) => new Date(Date.parse(eff) + m * 60_000).toISOString();
    const cand = (n: number, holder: number, value: string) =>
      rankCandidate(n, holder, value, { occurredAt: later(60) });
    const publish = async (candidates: unknown[], asOfMin: number, correction?: string) => {
      const r = await persistRankingRun(fw, {
        input: rankingRunInput(candidates, {
          spec: row.spec,
          system: {
            systemId: sid,
            systemVersionId: v.systemVersionId,
            code: row.code,
            version: v.version,
            specHash: v.specHash,
            lifecycle: 'PUBLISHED',
          },
          discipline: { disciplineVersionId: dv, sport: codes.sport, discipline: codes.discipline },
          asOf: later(asOfMin),
        }),
        trigger: 'STAFF_REQUEST',
      });
      return (
        await publishRankingSnapshot(fw, {
          runId: r.runId,
          ...(correction === undefined
            ? {}
            : { correction: { correctsSnapshotId: correction, reasons: ['RESULT_SUPERSEDED'] } }),
        })
      ).snapshotId;
    };
    // INITIAL a → FOLLOWS b → CORRECTS b (c) → CORRECTS c (d) → FOLLOWS d (e)
    snaps.a = await publish(
      [cand(1, 1, '900000'), cand(2, 2, '900000'), cand(3, 3, '905000')],
      120,
    );
    snaps.b = await publish([cand(1, 1, '900000'), cand(2, 2, '901000')], 130);
    snaps.c = await publish([cand(2, 2, '901000')], 140, snaps.b);
    snaps.d = await publish([cand(2, 2, '902000')], 150, snaps.c);
    snaps.e = await publish([cand(2, 2, '902000'), cand(3, 3, '903000')], 160);
  }, 300_000);
  afterAll(async () => {
    await Promise.all(fdbs.map((d) => d.destroy()));
    await fx.destroy();
  }, 60_000);

  const ids = (rows: readonly { snapshot_id: string }[]) => rows.map((r) => r.snapshot_id);

  it('snapshot cards carry the canonical hashes and lineage; correctedBy follows the corrections', async () => {
    const cards = await freader.snapshots(systemId, 'as-published');
    expect(ids(cards)).toEqual([snaps.a, snaps.b, snaps.c, snaps.d, snaps.e]);
    expect(cards.map((c) => c.chain_position)).toEqual([1, 2, 3, 4, 5]);
    expect(cards.map((c) => c.lineage_kind)).toEqual([
      'INITIAL',
      'FOLLOWS',
      'CORRECTS',
      'CORRECTS',
      'FOLLOWS',
    ]);
    expect(cards.map((c) => c.corrected_by_snapshot_id)).toEqual([
      null,
      snaps.c,
      snaps.d,
      null,
      null,
    ]);
    const { rows } = await sql<{
      id: string;
      snapshot_hash: string;
      run_outcome_hash: string;
      prior: string | null;
    }>`
      SELECT id::text AS id, snapshot_hash, run_outcome_hash,
             COALESCE(previous_snapshot_id, corrects_snapshot_id)::text AS prior
      FROM ranking.snapshot ORDER BY recorded_at, id`.execute(fowner);
    expect(
      cards.map((c) => [c.snapshot_id, c.snapshot_hash, c.run_outcome_hash, c.prior_snapshot_id]),
    ).toEqual(rows.map((r) => [r.id, r.snapshot_hash, r.run_outcome_hash, r.prior]));
    // A correction keeps its own publication time and position: it never appears to have always existed.
    const [, b, c] = cards;
    expect(c && b && c.published_at.getTime() >= b.published_at.getTime()).toBe(true);
  });

  it('as-published keeps every snapshot; as-corrected resolves corrections — both equal the Step 7 canonical queries', async () => {
    const corrected = await freader.snapshots(systemId, 'as-corrected');
    expect(ids(corrected)).toEqual([snaps.a, snaps.d, snaps.e]);
    expect(corrected[1]?.corrects).toEqual([snaps.b, snaps.c]);
    const canonPublished = await history.asPublished(systemId);
    const canonCorrected = await history.asCorrected(systemId);
    expect(ids(await freader.snapshots(systemId, 'as-published'))).toEqual(
      canonPublished.map((s) => s.snapshotId),
    );
    expect(ids(corrected)).toEqual(canonCorrected.map((s) => s.snapshotId));
    expect(corrected.map((s) => s.corrects)).toEqual(canonCorrected.map((s) => s.corrects));
  });

  it('leaderboard rows equal the immutable entries (rank, tie, value, trace) without basis topology', async () => {
    const board = await freader.leaderboard(snaps.a as string);
    const { rows } = await sql<{
      holder_type: string;
      holder_id: string;
      rank: number;
      tied: boolean;
      value: unknown;
      comparator_trace: unknown;
      basis: unknown[];
    }>`
      SELECT holder_type, holder_id::text AS holder_id, rank, tied, value, comparator_trace, basis
      FROM ranking.snapshot_entry WHERE snapshot_id = ${snaps.a} ORDER BY rank, holder_type, holder_id`.execute(
      fowner,
    );
    expect(board).toEqual(rows.map(({ basis, ...e }) => ({ ...e, basis_count: basis.length })));
    expect(board.map((e) => [e.rank, e.tied])).toEqual([
      [1, true],
      [1, true],
      [3, false],
    ]);
    expect(JSON.stringify(board)).not.toMatch(
      /resultVersionId|verificationRunId|evidenceCommitment|"hold"/,
    );
  });

  it('rebuild in the fixture database: incremental == full, twice identical, lineage and snapshots untouched', async () => {
    const incremental = await snapshotRankingReadModels(fmaint);
    const before = await canonicalFingerprint(fowner);
    const first = await rebuildAndSnapshot(fmaint);
    expect(first).toEqual(incremental);
    expect(await rebuildAndSnapshot(fmaint)).toEqual(first);
    expect(await canonicalFingerprint(fowner)).toEqual(before);
    expect(first.snapshot_card).toHaveLength(5);
  });
});
