import { DomainError, DomainErrorCode } from '@br/domain';
import {
  rankingSnapshotDependencies,
  rankingSnapshotStaleness,
  validateRankingSnapshot,
  type RankingSnapshotStaleness,
} from '@br/rankings';
import { sql } from 'kysely';
import { verificationSummary } from './achievement-loader';
import type { Db } from './db';
import { inTransaction, ModuleRole, type TxContext } from './tx';

/**
 * BRT-10 Step 7 — ranking snapshot history as QUERIES over the immutable class-A facts (ADR-0048 §8,
 * BRT-01 disputes §5.2, BRT-02 persistence §6). Nothing here writes; there are no copies and no
 * projections (ranking_read.* is Step 8).
 *
 *   asPublished(system)   the chronological lineage: what was believed at each publication.
 *   asCorrected(system)   at each point of the lineage, the latest snapshot not itself corrected (a
 *                         corrected snapshot is replaced by its correction, which lists what it corrects).
 *   read(snapshot)        one snapshot with read-time STALE computed from its basis pins (never stored).
 *   dependents(type, id)  runs and snapshots depending on a ResultVersion / VerificationRun / system
 *                         version — the run dependency index (run_dependency_target_idx).
 *
 * Runs under br_rankings (+ the SELECT-only br_verification_reader for run currency): the worker login.
 * br_api reaches none of this (API routes are a later step).
 */

const integrity = (reason: string, message: string, details: Record<string, unknown> = {}) =>
  new DomainError(DomainErrorCode.RANKING_INTEGRITY_FAILURE, message, { reason, ...details });

export interface SnapshotHistoryItem {
  readonly snapshotId: string;
  readonly snapshotHash: string;
  readonly systemVersionId: string;
  readonly runId: string;
  readonly provenance: string;
  readonly lineageKind: 'INITIAL' | 'FOLLOWS' | 'CORRECTS';
  readonly priorSnapshotId?: string;
  readonly lineageReasons: readonly string[];
  readonly asOf: Date;
  readonly publishedAt: Date;
  readonly entryCount: number;
  /** as-published: the snapshot that corrects this one, if any. */
  readonly correctedBy?: string;
  /** as-corrected: every published snapshot this one stands in for (direct correction chain). */
  readonly corrects?: readonly string[];
}

interface SnapshotRow {
  id: string;
  snapshot_hash: string;
  system_version_id: string;
  run_id: string;
  provenance: string;
  lineage_kind: 'INITIAL' | 'FOLLOWS' | 'CORRECTS';
  previous_snapshot_id: string | null;
  corrects_snapshot_id: string | null;
  lineage_reasons: string[];
  as_of: Date;
  recorded_at: Date;
  entry_count: number;
}

/** The system's lineage in chain order (INITIAL → successors). Any fork or gap is an integrity failure. */
async function lineage(ctx: TxContext, systemId: string): Promise<SnapshotRow[]> {
  const { rows } = await sql<SnapshotRow>`
    SELECT id::text AS id, snapshot_hash, system_version_id::text AS system_version_id, run_id::text AS run_id,
           provenance, lineage_kind, previous_snapshot_id::text AS previous_snapshot_id,
           corrects_snapshot_id::text AS corrects_snapshot_id, lineage_reasons, as_of, recorded_at, entry_count
    FROM ranking.snapshot WHERE system_id = ${systemId} ORDER BY recorded_at, id`.execute(ctx.trx);
  if (rows.length === 0) return [];
  const next = new Map<string, SnapshotRow>();
  const initial = rows.filter((r) => r.lineage_kind === 'INITIAL');
  for (const r of rows) {
    const prior = r.previous_snapshot_id ?? r.corrects_snapshot_id;
    if (prior === null) continue;
    if (next.has(prior))
      throw integrity('SNAPSHOT_LINEAGE_FORK', 'a snapshot has more than one successor', { prior });
    next.set(prior, r);
  }
  const chain: SnapshotRow[] = [];
  for (
    let at = initial.length === 1 ? initial[0] : undefined;
    at !== undefined;
    at = next.get(at.id)
  )
    chain.push(at);
  if (initial.length !== 1 || chain.length !== rows.length)
    throw integrity('SNAPSHOT_LINEAGE_BROKEN', 'the snapshot lineage is not one chain', {
      systemId,
    });
  return chain;
}

const item = (r: SnapshotRow): SnapshotHistoryItem => ({
  snapshotId: r.id,
  snapshotHash: r.snapshot_hash,
  systemVersionId: r.system_version_id,
  runId: r.run_id,
  provenance: r.provenance,
  lineageKind: r.lineage_kind,
  ...(r.previous_snapshot_id === null && r.corrects_snapshot_id === null
    ? {}
    : { priorSnapshotId: (r.previous_snapshot_id ?? r.corrects_snapshot_id) as string }),
  lineageReasons: [...r.lineage_reasons].sort(),
  asOf: r.as_of,
  publishedAt: r.recorded_at,
  entryCount: r.entry_count,
});

/** Pinned basis ResultVersion → still the current FINAL version with its pinned hash; plus its run. */
async function observe(
  ctx: TxContext,
  pins: readonly { readonly resultVersionId: string; readonly contentHash: string }[],
) {
  const ids = [...new Set(pins.map((p) => p.resultVersionId))];
  const { rows } = await sql<{
    id: string;
    content_hash: string;
    status: string | null;
    superseded: boolean;
  }>`
    SELECT v.id::text AS id, v.content_hash,
           (SELECT x.to_status FROM results.result_status_transition x WHERE x.result_version_id = v.id
            ORDER BY x.recorded_at DESC, x.id DESC LIMIT 1) AS status,
           EXISTS (SELECT 1 FROM results.result_version s WHERE s.supersedes_version_id = v.id) AS superseded
    FROM results.result_version v WHERE v.id = ANY(${ids}::uuid[])`.execute(ctx.trx);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const result = new Map<string, boolean>();
  const verification = new Map<string, string | undefined>();
  for (const p of pins) {
    const r = byId.get(p.resultVersionId);
    if (r === undefined) continue; // unknown (e.g. a REFERENCE_FIXTURE pin) ⇒ absent ⇒ affected
    result.set(
      p.resultVersionId,
      r.status === 'FINAL' && !r.superseded && r.content_hash === p.contentHash,
    );
    if (!verification.has(p.resultVersionId)) {
      const v = await verificationSummary(ctx, p.resultVersionId);
      verification.set(p.resultVersionId, v.state === 'CURRENT' ? v.runId : undefined);
    }
  }
  return { result, verification };
}

/**
 * Read-time STALE of one snapshot's content, inside the caller's transaction (Step 7 semantics,
 * unchanged). Used by `read` and by the QUALIFIED assembler (Step 9), which must consume the same
 * staleness rather than re-implement it. Reads only; the caller's role needs SELECT on the results
 * tables (br_verification_reader is used for run currency).
 */
export async function snapshotStalenessIn(
  ctx: TxContext,
  snapshot: Parameters<typeof rankingSnapshotDependencies>[0],
): Promise<RankingSnapshotStaleness> {
  const observed = await observe(ctx, rankingSnapshotDependencies(snapshot));
  return rankingSnapshotStaleness(snapshot, observed);
}

export class RankingHistoryReader {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private tx<T>(fn: (ctx: TxContext) => Promise<T>) {
    return inTransaction(this.db, ModuleRole.rankings, fn, 4, { isolation: 'repeatable read' });
  }

  /** As-published: every snapshot of the system, in lineage (publication) order. */
  asPublished(systemId: string): Promise<readonly SnapshotHistoryItem[]> {
    return this.tx(async (ctx) => {
      const chain = await lineage(ctx, systemId);
      const correctedBy = new Map(
        chain
          .filter((r) => r.corrects_snapshot_id !== null)
          .map((r) => [r.corrects_snapshot_id, r.id]),
      );
      return chain.map((r) => {
        const by = correctedBy.get(r.id);
        return by === undefined ? item(r) : { ...item(r), correctedBy: by };
      });
    });
  }

  /**
   * As-corrected: the lineage with every corrected snapshot replaced by its (final) correction. The
   * last item is the current as-corrected snapshot. Same facts, different query — nothing is copied.
   */
  asCorrected(systemId: string): Promise<readonly SnapshotHistoryItem[]> {
    return this.tx(async (ctx) => {
      const chain = await lineage(ctx, systemId);
      const out: SnapshotHistoryItem[] = [];
      let replaced: string[] = [];
      for (const [i, r] of chain.entries()) {
        const corrected = chain[i + 1]?.corrects_snapshot_id === r.id;
        if (corrected) {
          replaced.push(r.id);
          continue;
        }
        out.push(replaced.length === 0 ? item(r) : { ...item(r), corrects: replaced });
        replaced = [];
      }
      return out;
    });
  }

  /** One snapshot, its stored content re-hashed, with read-time STALE from its basis pins. */
  read(snapshotId: string): Promise<{
    readonly snapshot: SnapshotHistoryItem;
    readonly staleness: RankingSnapshotStaleness;
  }> {
    return this.tx(async (ctx) => {
      const { rows } = await sql<SnapshotRow & { content: unknown }>`
        SELECT id::text AS id, snapshot_hash, system_version_id::text AS system_version_id, run_id::text AS run_id,
               provenance, lineage_kind, previous_snapshot_id::text AS previous_snapshot_id,
               corrects_snapshot_id::text AS corrects_snapshot_id, lineage_reasons, as_of, recorded_at,
               entry_count, content
        FROM ranking.snapshot WHERE id = ${snapshotId}`.execute(ctx.trx);
      const row = rows[0];
      if (row === undefined) throw new DomainError(DomainErrorCode.NOT_FOUND, 'snapshot not found');
      const v = validateRankingSnapshot(row.content);
      if (!v.ok || v.hash !== row.snapshot_hash)
        throw integrity(
          'SNAPSHOT_HASH_MISMATCH',
          'stored snapshot content does not match its hash',
        );
      return { snapshot: item(row), staleness: await snapshotStalenessIn(ctx, v.value) };
    });
  }

  /** Runs (and their snapshots) that depend on one exact fact, via the run dependency index. */
  dependents(
    dependencyType: 'RESULT_VERSION' | 'VERIFICATION_RUN' | 'SYSTEM_VERSION',
    dependencyId: string,
  ): Promise<readonly { readonly runId: string; readonly snapshotId?: string }[]> {
    return this.tx(async (ctx) => {
      const { rows } = await sql<{ run_id: string; snapshot_id: string | null }>`
        SELECT d.run_id::text AS run_id, s.id::text AS snapshot_id
        FROM ranking.run_dependency d LEFT JOIN ranking.snapshot s ON s.run_id = d.run_id
        WHERE d.dependency_type = ${dependencyType} AND d.dependency_id = ${dependencyId}
        ORDER BY d.run_id`.execute(ctx.trx);
      return rows.map((r) =>
        r.snapshot_id === null
          ? { runId: r.run_id }
          : { runId: r.run_id, snapshotId: r.snapshot_id },
      );
    });
  }
}
