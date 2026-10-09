import { sql } from 'kysely';
import type { Db } from './db';
import { inTransaction, ModuleRole, type TxContext } from './tx';

/**
 * BRT-10 read-model reader (ADR-0048 §9): reads ONLY the ranking_read.* projections (migration 0028).
 *
 *   public (br_public_read)   system cards, snapshot history (as-published / as-corrected), leaderboards,
 *                             classification cards + their ranked rows
 *   staff  (br_rankings)      run cards + every candidate with its state and blockers
 *
 * It never reads a canonical table and never computes or stores staleness: the API (Step 11) composes
 * these rows with the Step 7 readers (ClassificationStalenessService, RankingHistoryReader), which
 * compute it from the exact pins at read time. Writes nothing.
 */

export type SnapshotView = 'as-published' | 'as-corrected';

export interface SnapshotCardRow {
  readonly snapshot_id: string;
  readonly system_id: string;
  readonly system_version_id: string;
  readonly system_version: number;
  readonly spec_hash: string;
  readonly run_id: string;
  readonly run_input_hash: string;
  readonly run_outcome_hash: string;
  readonly snapshot_hash: string;
  readonly kind: string;
  readonly method: string;
  readonly engine_version: string;
  readonly provenance: string;
  readonly as_of: Date;
  readonly lineage_kind: 'INITIAL' | 'FOLLOWS' | 'CORRECTS';
  readonly prior_snapshot_id: string | null;
  readonly prior_snapshot_hash: string | null;
  readonly lineage_reasons: string[];
  readonly chain_position: number;
  readonly corrected_by_snapshot_id: string | null;
  readonly entry_count: number;
  readonly published_at: Date;
}

/** A history item; `corrects` lists (as-corrected only) every snapshot this one stands in for. */
export type SnapshotHistoryRow = SnapshotCardRow & { readonly corrects?: readonly string[] };

/**
 * As-published / as-corrected over the projected lineage (pure): as-published is chain order;
 * as-corrected replaces each corrected snapshot by its final correction (ADR-0048 §8). Nothing is
 * hidden from as-published and nothing is rewritten — a correction never appears to have always existed:
 * it keeps its own publication time, position and the ids it corrects.
 */
export function snapshotHistory(
  cards: readonly SnapshotCardRow[],
  view: SnapshotView,
): readonly SnapshotHistoryRow[] {
  const chain = [...cards].sort((a, b) => a.chain_position - b.chain_position);
  if (view === 'as-published') return chain;
  const out: SnapshotHistoryRow[] = [];
  let replaced: string[] = [];
  for (const c of chain) {
    if (c.corrected_by_snapshot_id !== null) {
      replaced.push(c.snapshot_id);
      continue;
    }
    out.push(replaced.length === 0 ? c : { ...c, corrects: replaced });
    replaced = [];
  }
  return out;
}

export interface ClassificationRead {
  readonly card: Record<string, unknown>;
  readonly entries: readonly Record<string, unknown>[];
}

export interface StaffRunRead {
  readonly card: Record<string, unknown>;
  readonly candidates: readonly Record<string, unknown>[];
}

export class RankingReadModelReader {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private read<T>(fn: (ctx: TxContext) => Promise<T>) {
    return inTransaction(this.db, ModuleRole.publicRead, fn, 4, { isolation: 'repeatable read' });
  }

  /** Every system card, by code. */
  systems(): Promise<readonly Record<string, unknown>[]> {
    return this.read(
      async (ctx) =>
        (
          await sql<
            Record<string, unknown>
          >`SELECT * FROM ranking_read.system_card ORDER BY code`.execute(ctx.trx)
        ).rows,
    );
  }

  /** The snapshot history of one system in the requested view (projection rows only). */
  snapshots(systemId: string, view: SnapshotView): Promise<readonly SnapshotHistoryRow[]> {
    return this.read(async (ctx) => {
      const { rows } = await sql<SnapshotCardRow>`
        SELECT * FROM ranking_read.snapshot_card WHERE system_id = ${systemId} ORDER BY chain_position`.execute(
        ctx.trx,
      );
      return snapshotHistory(rows, view);
    });
  }

  /** The leaderboard of one snapshot: rank order, ties shared, holder ids only (display is later). */
  leaderboard(snapshotId: string): Promise<readonly Record<string, unknown>[]> {
    return this.read(
      async (ctx) =>
        (
          await sql<Record<string, unknown>>`
            SELECT holder_type, holder_id, rank, tied, value, comparator_trace, basis_count
            FROM ranking_read.leaderboard_entry WHERE snapshot_id = ${snapshotId}
            ORDER BY rank, holder_type, holder_id`.execute(ctx.trx)
        ).rows,
    );
  }

  /** One derived classification card and its ranked rows (rank order, then participant id). */
  classification(classificationVersionId: string): Promise<ClassificationRead | undefined> {
    return this.read(async (ctx) => {
      const { rows } = await sql<Record<string, unknown>>`
        SELECT * FROM ranking_read.classification_card WHERE classification_version_id = ${classificationVersionId}`.execute(
        ctx.trx,
      );
      const card = rows[0];
      if (card === undefined) return undefined;
      const { rows: entries } = await sql<Record<string, unknown>>`
        SELECT participant_id, rank, tied, tie_break_keys FROM ranking_read.classification_entry
        WHERE classification_version_id = ${classificationVersionId} ORDER BY rank, participant_id`.execute(
        ctx.trx,
      );
      return { card, entries };
    });
  }

  /**
   * STAFF ONLY: a run card with every candidate (state + blockers). Runs as br_rankings — br_public_read
   * holds no grant on run projections; the COMP_STAFF exposure is decided by the API step.
   */
  runForStaff(runId: string): Promise<StaffRunRead | undefined> {
    return inTransaction(this.db, ModuleRole.rankings, async (ctx) => {
      const { rows } = await sql<Record<string, unknown>>`
        SELECT * FROM ranking_read.run_card WHERE run_id = ${runId}`.execute(ctx.trx);
      const card = rows[0];
      if (card === undefined) return undefined;
      const { rows: candidates } = await sql<Record<string, unknown>>`
        SELECT result_version_id, participant_id, ordinal, state, reasons FROM ranking_read.run_candidate
        WHERE run_id = ${runId} ORDER BY result_version_id, participant_id, ordinal`.execute(
        ctx.trx,
      );
      return { card, candidates };
    });
  }
}
