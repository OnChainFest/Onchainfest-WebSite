import { publicBody, type VerificationOutcome } from '@br/verification';
import { sql } from 'kysely';
import type { Db } from './db';
import { resolveResultVersion, resultVersionPath } from './evidence-support';
import { inTransaction, ModuleRole, type TxContext } from './tx';

/**
 * BRT-07 read models (class B). Maintained by the evaluating transaction (br_verification) and
 * fully rebuildable by the maintenance login (br_rebuild) with the SAME functions, from
 * verification.run + policy identity + the immutable hierarchy only — never PII, evidence bytes,
 * the evidence cipher or the internal trace. Freshness is not stored (it is hash-based at read).
 */

interface RunRow {
  id: string;
  result_version_id: string;
  policy_version_id: string;
  engine_version: string;
  evaluation_state: string;
  highest_level: string | null;
  snapshot_hash: string;
  evaluated_as_of: Date;
  outcome: VerificationOutcome;
  policy_code: string;
  policy_version: number;
}

async function runRow(ctx: TxContext, runId: string): Promise<RunRow | undefined> {
  const { rows } = await sql<RunRow>`
    SELECT r.id, r.result_version_id, r.policy_version_id, r.engine_version, r.evaluation_state, r.highest_level,
           r.snapshot_hash, r.evaluated_as_of, r.outcome, p.code AS policy_code, v.version AS policy_version
    FROM verification.run r
    JOIN verification.policy_version v ON v.id = r.policy_version_id
    JOIN verification.policy p ON p.id = v.policy_id
    WHERE r.id = ${runId}`.execute(ctx.trx);
  return rows[0];
}

async function hierarchyOf(ctx: TxContext, resultVersionId: string) {
  const rv = await resolveResultVersion(ctx, resultVersionId);
  const path = rv === undefined ? undefined : await resultVersionPath(ctx, rv);
  if (path?.competitionId === undefined) throw new Error('run result version has no hierarchy');
  return path;
}

/** Inserts (or replaces) the public-safe summary of one run. */
export async function refreshRunSummary(ctx: TxContext, runId: string): Promise<void> {
  const r = await runRow(ctx, runId);
  await sql`DELETE FROM verification_read.run_summary WHERE run_id = ${runId}`.execute(ctx.trx);
  if (r === undefined) return;
  const path = await hierarchyOf(ctx, r.result_version_id);
  await sql`
    INSERT INTO verification_read.run_summary
      (run_id, result_version_id, competition_id, event_id, contest_id, policy_code, policy_version, engine_version,
       evaluation_state, highest_level, evaluated_as_of, public_body)
    VALUES (${r.id}, ${r.result_version_id}, ${path.competitionId}, ${path.eventId ?? null}, ${path.contestId ?? null},
            ${r.policy_code}, ${r.policy_version}, ${r.engine_version}, ${r.evaluation_state}, ${r.highest_level},
            ${r.evaluated_as_of}, ${JSON.stringify(publicBody(r.outcome))})`.execute(ctx.trx);
}

/** Points the current-verification row of a ResultVersion at its latest run. */
export async function refreshCurrentVerification(
  ctx: TxContext,
  resultVersionId: string,
): Promise<{
  previous?: { runId: string; level: string | null; state: string };
  current?: { runId: string; level: string | null; state: string };
}> {
  const { rows: before } = await sql<{
    run_id: string;
    highest_level: string | null;
    evaluation_state: string;
  }>`
    SELECT run_id, highest_level, evaluation_state FROM verification_read.current_verification
    WHERE result_version_id = ${resultVersionId}`.execute(ctx.trx);
  const { rows: latest } = await sql<{ id: string }>`
    SELECT id FROM verification.run WHERE result_version_id = ${resultVersionId}
    ORDER BY recorded_at DESC, id DESC LIMIT 1`.execute(ctx.trx);
  await sql`DELETE FROM verification_read.current_verification WHERE result_version_id = ${resultVersionId}`.execute(
    ctx.trx,
  );
  const runId = latest[0]?.id;
  const prev = before[0];
  const previous =
    prev === undefined
      ? undefined
      : { runId: prev.run_id, level: prev.highest_level, state: prev.evaluation_state };
  if (runId === undefined) return previous === undefined ? {} : { previous };
  const r = (await runRow(ctx, runId)) as RunRow;
  const path = await hierarchyOf(ctx, resultVersionId);
  await sql`
    INSERT INTO verification_read.current_verification
      (result_version_id, run_id, policy_version_id, policy_code, policy_version, engine_version, evaluation_state,
       highest_level, snapshot_hash, evaluated_as_of, active_dispute, competition_id, event_id, contest_id)
    VALUES (${resultVersionId}, ${r.id}, ${r.policy_version_id}, ${r.policy_code}, ${r.policy_version}, ${r.engine_version},
            ${r.evaluation_state}, ${r.highest_level}, ${r.snapshot_hash}, ${r.evaluated_as_of},
            ${publicBody(r.outcome).activeDispute}, ${path.competitionId}, ${path.eventId ?? null}, ${path.contestId ?? null})`.execute(
    ctx.trx,
  );
  const current = { runId: r.id, level: r.highest_level, state: r.evaluation_state };
  return previous === undefined ? { current } : { previous, current };
}

/** Full rebuild through the maintenance login (br_rebuild). Idempotent. */
export async function rebuildVerificationReadModels(
  maintenanceDb: Db,
): Promise<{ runs: number; resultVersions: number }> {
  return inTransaction(maintenanceDb, ModuleRole.rebuild, async (ctx) => {
    await sql`TRUNCATE verification_read.current_verification, verification_read.run_summary`.execute(
      ctx.trx,
    );
    const { rows: runs } = await sql<{
      id: string;
    }>`SELECT id FROM verification.run ORDER BY recorded_at, id`.execute(ctx.trx);
    for (const r of runs) await refreshRunSummary(ctx, r.id);
    const { rows: rvs } = await sql<{ result_version_id: string }>`
      SELECT DISTINCT result_version_id FROM verification.run ORDER BY result_version_id`.execute(
      ctx.trx,
    );
    for (const rv of rvs) await refreshCurrentVerification(ctx, rv.result_version_id);
    return { runs: runs.length, resultVersions: rvs.length };
  });
}

/** Deterministic snapshot of both read models (incremental-vs-rebuild comparisons). */
export async function snapshotVerificationReadModels(db: Db): Promise<unknown> {
  return inTransaction(db, ModuleRole.verification, async (ctx) => ({
    current: (
      await sql`SELECT * FROM verification_read.current_verification ORDER BY result_version_id`.execute(
        ctx.trx,
      )
    ).rows,
    runs: (await sql`SELECT * FROM verification_read.run_summary ORDER BY run_id`.execute(ctx.trx))
      .rows,
  }));
}
