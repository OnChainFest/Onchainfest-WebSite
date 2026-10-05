import { CURRENT_ELIGIBLE_STATUSES, type ResultVersionStatus } from '@br/domain';
import type { Db, ResultStateTable, ResultVersionStateTable } from './db';
import { inTransaction, ModuleRole } from './tx';

export interface ResultProjectionSnapshot {
  readonly resultState: readonly ResultStateTable[];
  readonly versionState: readonly ResultVersionStateTable[];
}

/** Reads the result projections in a deterministic order (for comparison in tests/tools). */
export function snapshotResultProjections(
  db: Db,
  role: ModuleRole = ModuleRole.results,
): Promise<ResultProjectionSnapshot> {
  return inTransaction(db, role, async (ctx) => ({
    resultState: await ctx.trx
      .selectFrom('results.result_state')
      .selectAll()
      .orderBy('result_id')
      .execute(),
    versionState: await ctx.trx
      .selectFrom('results.result_version_state')
      .selectAll()
      .orderBy('result_version_id')
      .execute(),
  }));
}

/**
 * Rebuilds the class B result projections from authoritative history (BRT-02 persistence §3.0 B):
 * truncates results.result_state / results.result_version_state, then replays every RESULT
 * ledger stream in sequence order, joining each entry to its class A fact row.
 * Runs as br_rebuild, which can write projections but never ledger tables. `db` must be a
 * maintenance connection (login br_maintenance); api/worker logins cannot assume br_rebuild.
 */
export function rebuildResultProjections(db: Db): Promise<{ streams: number; entries: number }> {
  return inTransaction(db, ModuleRole.rebuild, async (ctx) => {
    await ctx.trx.deleteFrom('results.result_version_state').execute();
    await ctx.trx.deleteFrom('results.result_state').execute();

    const entries = await ctx.trx
      .selectFrom('platform.ledger_entry')
      .selectAll()
      .where('stream_type', '=', 'RESULT')
      .orderBy('stream_id')
      .orderBy('sequence')
      .execute();
    const versions = new Map(
      (
        await ctx.trx
          .selectFrom('results.result_version')
          .select(['id', 'result_id', 'version_number'])
          .execute()
      ).map((v) => [v.id, v]),
    );
    const transitions = new Map(
      (
        await ctx.trx
          .selectFrom('results.result_status_transition')
          .select(['id', 'result_version_id', 'to_status'])
          .execute()
      ).map((t) => [t.id, t]),
    );

    const resultState = new Map<string, ResultStateTable>();
    const versionState = new Map<string, ResultVersionStateTable>();
    for (const entry of entries) {
      switch (entry.event_type) {
        case 'RESULT_CREATED':
          resultState.set(entry.stream_id, {
            result_id: entry.stream_id,
            current_version_id: null,
            latest_version_number: 0,
            updated_at: entry.recorded_at,
          });
          break;
        case 'RESULT_VERSION_SUBMITTED': {
          const v = versions.get(entry.fact_row_id);
          const rs = resultState.get(entry.stream_id);
          if (v === undefined || rs === undefined)
            throw new Error(`ledger entry ${entry.id} references a missing fact`);
          resultState.set(entry.stream_id, {
            ...rs,
            latest_version_number: v.version_number,
            updated_at: entry.recorded_at,
          });
          break;
        }
        case 'STATUS_TRANSITION': {
          const t = transitions.get(entry.fact_row_id);
          const rs = resultState.get(entry.stream_id);
          if (t === undefined || rs === undefined)
            throw new Error(`ledger entry ${entry.id} references a missing fact`);
          const to = t.to_status as ResultVersionStatus;
          const prev = versionState.get(t.result_version_id);
          versionState.set(t.result_version_id, {
            result_version_id: t.result_version_id,
            result_id: entry.stream_id,
            current_status: to,
            hold: prev?.hold ?? false,
            updated_at: entry.recorded_at,
          });
          if (CURRENT_ELIGIBLE_STATUSES.includes(to)) {
            resultState.set(entry.stream_id, {
              ...rs,
              current_version_id: t.result_version_id,
              updated_at: entry.recorded_at,
            });
          } else if (rs.current_version_id === t.result_version_id) {
            resultState.set(entry.stream_id, {
              ...rs,
              current_version_id: null,
              updated_at: entry.recorded_at,
            });
          }
          break;
        }
        default:
          throw new Error(`unknown RESULT ledger event ${entry.event_type}`);
      }
    }
    if (resultState.size > 0)
      await ctx.trx
        .insertInto('results.result_state')
        .values([...resultState.values()])
        .execute();
    if (versionState.size > 0)
      await ctx.trx
        .insertInto('results.result_version_state')
        .values([...versionState.values()])
        .execute();
    return { streams: resultState.size, entries: entries.length };
  });
}
