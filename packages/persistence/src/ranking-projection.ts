import { PLATFORM_RANKING_LABEL } from '@br/domain';
import type { RankingRunOutcome, RankingSystemSpec } from '@br/rankings';
import { sql } from 'kysely';
import type { Db } from './db';
import { inTransaction, ModuleRole, type TxContext } from './tx';

/**
 * BRT-10 read models (class B, ADR-0048 §9 / ADR-0046 pattern; migration 0028). Each writer refreshes
 * the projections of the facts it just wrote, inside its own transaction, and the maintenance login
 * (br_rebuild) truncates and re-derives everything with the SAME functions. Inputs are the immutable
 * class-A facts only (+ the ResultLedger's append-only status transitions); hashes are copied, never
 * recomputed. Nothing here writes a canonical table, emits an event or creates a classification,
 * run, snapshot, achievement or record.
 *
 *   refreshSystemCard          br_ranking_rules   on system / version create and status change
 *   refreshRunCard             br_rankings        on run persistence (card + every candidate)
 *   refreshSnapshotCard        br_rankings        on publication: the new snapshot AND its prior (whose
 *                                                 corrected_by may change); leaderboard rows included
 *   refreshClassificationCard  br_results         on `@2` submission (T2) and every status transition
 *
 * Staleness is never stored: it is computed at read time (ClassificationStalenessService,
 * RankingHistoryReader). There is no is_current flag: as-published / as-corrected are queries over
 * chain_position and corrected_by_snapshot_id, both derived from the immutable lineage.
 */

export async function refreshSystemCard(ctx: TxContext, systemId: string): Promise<void> {
  await sql`DELETE FROM ranking_read.system_card WHERE system_id = ${systemId}`.execute(ctx.trx);
  const { rows } = await sql<{
    id: string;
    code: string;
    name: string;
    kind: 'PLATFORM' | 'OFFICIAL';
    created_at: Date;
    version_id: string;
    version: number;
    lifecycle: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
    spec_hash: string;
    spec: RankingSystemSpec;
    method: string;
    discipline_version_id: string;
    metric_key: string;
    mark_metric_id: string;
    holder_type: string;
    recognition_level: string;
    minimum_verification_level: string;
    effective_from: Date;
  }>`
    SELECT s.id, s.code, s.name, s.kind, s.recorded_at AS created_at, v.id AS version_id, v.version,
           c.status AS lifecycle, v.spec_hash, v.spec, v.method, v.discipline_version_id, v.metric_key,
           v.mark_metric_id, v.holder_type, v.recognition_level, v.minimum_verification_level, v.effective_from
    FROM ranking.system s
    JOIN LATERAL (SELECT * FROM ranking.system_version x WHERE x.system_id = s.id ORDER BY x.version DESC LIMIT 1) v ON true
    JOIN ranking.v_system_version_current c ON c.system_version_id = v.id
    WHERE s.id = ${systemId}`.execute(ctx.trx);
  const s = rows[0];
  // A system without any version has no card yet (nothing to display; the next version creates it).
  if (s === undefined) return;
  const { rows: pub } = await sql<{ id: string; version: number }>`
    SELECT v.id, v.version FROM ranking.system_version v
    JOIN ranking.v_system_version_current c ON c.system_version_id = v.id
    WHERE v.system_id = ${systemId} AND c.status = 'PUBLISHED'
    ORDER BY v.version DESC LIMIT 1`.execute(ctx.trx);
  const published = pub[0];
  await sql`
    INSERT INTO ranking_read.system_card
      (system_id, code, name, kind, label, latest_version_id, latest_version, latest_lifecycle, latest_spec_hash,
       published_version_id, published_version, display_name, method, discipline_version_id, metric_key,
       mark_metric_id, holder_type, recognition_level, minimum_verification_level, effective_from, created_at)
    VALUES (${s.id}, ${s.code}, ${s.name}, ${s.kind}, ${s.kind === 'PLATFORM' ? PLATFORM_RANKING_LABEL : null},
            ${s.version_id}, ${s.version}, ${s.lifecycle}, ${s.spec_hash}, ${published?.id ?? null},
            ${published?.version ?? null}, ${s.spec.displayName}, ${s.method}, ${s.discipline_version_id},
            ${s.metric_key}, ${s.mark_metric_id}, ${s.holder_type}, ${s.recognition_level},
            ${s.minimum_verification_level}, ${s.effective_from}, ${s.created_at})`.execute(
    ctx.trx,
  );
}

export async function refreshRunCard(ctx: TxContext, runId: string): Promise<void> {
  await sql`DELETE FROM ranking_read.run_candidate WHERE run_id = ${runId}`.execute(ctx.trx);
  await sql`DELETE FROM ranking_read.run_card WHERE run_id = ${runId}`.execute(ctx.trx);
  const { rows } = await sql<{
    id: string;
    system_id: string;
    system_version_id: string;
    version: number;
    spec_hash: string;
    engine_version: string;
    provenance: string;
    input_hash: string;
    outcome_hash: string;
    outcome: RankingRunOutcome;
    as_of: Date;
    publication_state: string;
    publication_reasons: string[];
    entry_count: number;
    candidate_count: number;
    trigger: string;
    recorded_at: Date;
  }>`
    SELECT r.id, r.system_id, r.system_version_id, v.version, r.spec_hash, r.engine_version, r.provenance,
           r.input_hash, r.outcome_hash, r.outcome, r.as_of, r.publication_state, r.publication_reasons,
           r.entry_count, r.candidate_count, r.trigger, r.recorded_at
    FROM ranking.run r JOIN ranking.system_version v ON v.id = r.system_version_id
    WHERE r.id = ${runId}`.execute(ctx.trx);
  const r = rows[0];
  if (r === undefined) return;
  await sql`
    INSERT INTO ranking_read.run_card
      (run_id, system_id, system_version_id, system_version, spec_hash, engine_version, provenance, input_hash,
       outcome_hash, as_of, publication_state, publication_reasons, entry_count, candidate_count, trigger, recorded_at)
    VALUES (${r.id}, ${r.system_id}, ${r.system_version_id}, ${r.version}, ${r.spec_hash}, ${r.engine_version},
            ${r.provenance}, ${r.input_hash}, ${r.outcome_hash}, ${r.as_of}, ${r.publication_state},
            ${[...r.publication_reasons].sort()}, ${r.entry_count}, ${r.candidate_count}, ${r.trigger},
            ${r.recorded_at})`.execute(ctx.trx);
  for (const c of r.outcome.candidates)
    await sql`
      INSERT INTO ranking_read.run_candidate (run_id, result_version_id, participant_id, ordinal, state, reasons)
      VALUES (${r.id}, ${c.resultVersionId}, ${c.participantId}, ${c.ordinal}, ${c.state},
              ${[...c.reasons].sort()})`.execute(ctx.trx);
}

export async function refreshSnapshotCard(ctx: TxContext, snapshotId: string): Promise<void> {
  await sql`DELETE FROM ranking_read.leaderboard_entry WHERE snapshot_id = ${snapshotId}`.execute(
    ctx.trx,
  );
  await sql`DELETE FROM ranking_read.snapshot_card WHERE snapshot_id = ${snapshotId}`.execute(
    ctx.trx,
  );
  const { rows } = await sql<{
    id: string;
    system_id: string;
    system_version_id: string;
    version: number;
    spec_hash: string;
    run_id: string;
    run_input_hash: string;
    run_outcome_hash: string;
    snapshot_hash: string;
    kind: string;
    method: string;
    engine_version: string;
    provenance: string;
    as_of: Date;
    lineage_kind: string;
    prior: string | null;
    prior_snapshot_hash: string | null;
    lineage_reasons: string[];
    chain_position: number;
    corrected_by: string | null;
    entry_count: number;
    recorded_at: Date;
  }>`
    WITH RECURSIVE chain AS (
      SELECT s.id, COALESCE(s.previous_snapshot_id, s.corrects_snapshot_id) AS prior, 1 AS depth
      FROM ranking.snapshot s WHERE s.id = ${snapshotId}
      UNION ALL
      SELECT p.id, COALESCE(p.previous_snapshot_id, p.corrects_snapshot_id), c.depth + 1
      FROM chain c JOIN ranking.snapshot p ON p.id = c.prior
    )
    SELECT s.id, s.system_id, s.system_version_id, v.version, s.spec_hash, s.run_id, s.run_input_hash,
           s.run_outcome_hash, s.snapshot_hash, s.kind, s.method, s.engine_version, s.provenance, s.as_of,
           s.lineage_kind, COALESCE(s.previous_snapshot_id, s.corrects_snapshot_id) AS prior,
           s.prior_snapshot_hash, s.lineage_reasons, (SELECT max(depth) FROM chain)::int AS chain_position,
           (SELECT n.id FROM ranking.snapshot n WHERE n.corrects_snapshot_id = s.id) AS corrected_by,
           s.entry_count, s.recorded_at
    FROM ranking.snapshot s JOIN ranking.system_version v ON v.id = s.system_version_id
    WHERE s.id = ${snapshotId}`.execute(ctx.trx);
  const s = rows[0];
  if (s === undefined) return;
  await sql`
    INSERT INTO ranking_read.snapshot_card
      (snapshot_id, system_id, system_version_id, system_version, spec_hash, run_id, run_input_hash,
       run_outcome_hash, snapshot_hash, kind, method, engine_version, provenance, as_of, lineage_kind,
       prior_snapshot_id, prior_snapshot_hash, lineage_reasons, chain_position, corrected_by_snapshot_id,
       entry_count, published_at)
    VALUES (${s.id}, ${s.system_id}, ${s.system_version_id}, ${s.version}, ${s.spec_hash}, ${s.run_id},
            ${s.run_input_hash}, ${s.run_outcome_hash}, ${s.snapshot_hash}, ${s.kind}, ${s.method},
            ${s.engine_version}, ${s.provenance}, ${s.as_of}, ${s.lineage_kind}, ${s.prior},
            ${s.prior_snapshot_hash}, ${[...s.lineage_reasons].sort()}, ${s.chain_position},
            ${s.corrected_by}, ${s.entry_count}, ${s.recorded_at})`.execute(ctx.trx);
  // Leaderboard rows: the ranked value and trace only — never the basis topology (result / run ids,
  // evidence commitments, hold), which stays in the immutable snapshot.
  await sql`
    INSERT INTO ranking_read.leaderboard_entry
      (snapshot_id, holder_type, holder_id, rank, tied, value, comparator_trace, basis_count)
    SELECT e.snapshot_id, e.holder_type, e.holder_id, e.rank, e.tied, e.value, e.comparator_trace,
           jsonb_array_length(e.basis)
    FROM ranking.snapshot_entry e WHERE e.snapshot_id = ${snapshotId}`.execute(ctx.trx);
}

/** One card per derived (`@2`) classification version; a version without a derivation has none. */
export async function refreshClassificationCard(ctx: TxContext, versionId: string): Promise<void> {
  await sql`DELETE FROM ranking_read.classification_entry WHERE classification_version_id = ${versionId}`.execute(
    ctx.trx,
  );
  await sql`DELETE FROM ranking_read.classification_card WHERE classification_version_id = ${versionId}`.execute(
    ctx.trx,
  );
  const { rows } = await sql<{
    id: string;
    result_id: string;
    scope_type: string;
    scope_target_id: string;
    version_number: number;
    content_schema: string;
    content_hash: string;
    content: {
      entries: { participantId: string; rank: number; tied: boolean; tieBreakKeys: unknown[] }[];
    };
    policy_id: string;
    policy_version_id: string;
    policy_spec_hash: string;
    discipline_version_id: string;
    engine_version: string;
    inputs_digest: string;
    input_count: number;
    pinned_input_ids: string[];
    status: string;
    status_since: Date;
    submitted_at: Date;
  }>`
    SELECT v.id, v.result_id, r.scope_type, r.scope_target_id, v.version_number, v.content_schema, v.content_hash,
           v.content, d.policy_id, d.policy_version_id, d.policy_spec_hash, d.discipline_version_id, d.engine_version,
           d.inputs_digest, d.input_count,
           (SELECT array_agg(i.input_result_version_id ORDER BY i.input_result_version_id)
            FROM results.classification_input i WHERE i.classification_version_id = v.id) AS pinned_input_ids,
           t.to_status AS status, t.recorded_at AS status_since, v.recorded_at AS submitted_at
    FROM results.classification_derivation d
    JOIN results.result_version v ON v.id = d.result_version_id
    JOIN results.result r ON r.id = v.result_id
    JOIN LATERAL (SELECT x.to_status, x.recorded_at FROM results.result_status_transition x
                  WHERE x.result_version_id = v.id ORDER BY x.recorded_at DESC, x.id DESC LIMIT 1) t ON true
    WHERE d.result_version_id = ${versionId}`.execute(ctx.trx);
  const c = rows[0];
  if (c === undefined) return;
  await sql`
    INSERT INTO ranking_read.classification_card
      (classification_version_id, result_id, scope_type, scope_target_id, version_number, content_schema,
       content_hash, policy_id, policy_version_id, policy_spec_hash, discipline_version_id, engine_version,
       inputs_digest, input_count, pinned_input_ids, status, status_since, submitted_at)
    VALUES (${c.id}, ${c.result_id}, ${c.scope_type}, ${c.scope_target_id}, ${c.version_number},
            ${c.content_schema}, ${c.content_hash}, ${c.policy_id}, ${c.policy_version_id},
            ${c.policy_spec_hash}, ${c.discipline_version_id}, ${c.engine_version}, ${c.inputs_digest},
            ${c.input_count}, ${c.pinned_input_ids}, ${c.status}, ${c.status_since},
            ${c.submitted_at})`.execute(ctx.trx);
  // Ranks, ties and the trace are copied byte for byte from the immutable content (never re-ranked).
  for (const e of c.content.entries)
    await sql`
      INSERT INTO ranking_read.classification_entry
        (classification_version_id, participant_id, rank, tied, tie_break_keys)
      VALUES (${c.id}, ${e.participantId}, ${e.rank}, ${e.tied}, ${JSON.stringify(e.tieBreakKeys)})`.execute(
      ctx.trx,
    );
}

const READ_MODEL_TABLES = [
  'system_card',
  'run_card',
  'run_candidate',
  'snapshot_card',
  'leaderboard_entry',
  'classification_card',
  'classification_entry',
] as const;

/**
 * Full rebuild through the maintenance login (br_rebuild): truncates ONLY ranking_read.* and re-derives
 * it from the canonical facts with the incremental functions. Idempotent; writes nothing else.
 */
export function rebuildRankingReadModels(maintenanceDb: Db): Promise<{
  systems: number;
  runs: number;
  snapshots: number;
  classifications: number;
}> {
  return inTransaction(maintenanceDb, ModuleRole.rebuild, async (ctx) => {
    await sql`TRUNCATE ${sql.join(READ_MODEL_TABLES.map((t) => sql.table(`ranking_read.${t}`)))}`.execute(
      ctx.trx,
    );
    const ids = async (q: ReturnType<typeof sql<{ id: string }>>) =>
      (await q.execute(ctx.trx)).rows.map((r) => r.id);
    const systems = await ids(sql`SELECT id FROM ranking.system ORDER BY recorded_at, id`);
    for (const id of systems) await refreshSystemCard(ctx, id);
    const runs = await ids(sql`SELECT id FROM ranking.run ORDER BY recorded_at, id`);
    for (const id of runs) await refreshRunCard(ctx, id);
    const snapshots = await ids(sql`SELECT id FROM ranking.snapshot ORDER BY recorded_at, id`);
    for (const id of snapshots) await refreshSnapshotCard(ctx, id);
    const classifications = await ids(
      sql`SELECT result_version_id AS id FROM results.classification_derivation ORDER BY recorded_at, result_version_id`,
    );
    for (const id of classifications) await refreshClassificationCard(ctx, id);
    return {
      systems: systems.length,
      runs: runs.length,
      snapshots: snapshots.length,
      classifications: classifications.length,
    };
  });
}

/** Deterministic snapshot of every ranking read model (incremental-vs-rebuild comparisons). */
export function snapshotRankingReadModels(
  db: Db,
  role: ModuleRole = ModuleRole.rebuild,
): Promise<Readonly<Record<(typeof READ_MODEL_TABLES)[number], readonly unknown[]>>> {
  const order: Record<(typeof READ_MODEL_TABLES)[number], string> = {
    system_card: 'system_id',
    run_card: 'run_id',
    run_candidate: 'run_id, result_version_id, participant_id, ordinal',
    snapshot_card: 'snapshot_id',
    leaderboard_entry: 'snapshot_id, holder_type, holder_id',
    classification_card: 'classification_version_id',
    classification_entry: 'classification_version_id, participant_id',
  };
  return inTransaction(db, role, async (ctx) => {
    const out = {} as Record<(typeof READ_MODEL_TABLES)[number], readonly unknown[]>;
    for (const t of READ_MODEL_TABLES)
      out[t] = (
        await sql`SELECT * FROM ${sql.table(`ranking_read.${t}`)} ORDER BY ${sql.raw(order[t])}`.execute(
          ctx.trx,
        )
      ).rows;
    return out;
  });
}
