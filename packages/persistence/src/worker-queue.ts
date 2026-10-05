import { newId, type DomainEvent } from '@br/domain';
import { sql } from 'kysely';
import type { Db, JobTable } from './db';
import { toDomainEvent } from './outbox';
import { inTransaction, ModuleRole, type TxContext } from './tx';

/**
 * Outbox consumption (ADR-0012), development skeleton.
 *
 * Delivery semantics (BRT-03R — stated precisely):
 *  - DELIVERY IS AT LEAST ONCE. An event is handed to a handler until a consumption receipt for
 *    (consumer, event_id) commits. If the handler throws or the transaction fails, the receipt
 *    rolls back and the event is delivered again on a later round.
 *  - EXACTLY-ONCE COMMITTED DATABASE EFFECTS, and only for effects the handler writes through
 *    `ctx.trx`. The receipt and those effects commit or roll back together, and the receipt's
 *    primary key makes a concurrent worker block, then skip (ON CONFLICT DO NOTHING) the event
 *    the first worker committed.
 *  - NO exactly-once guarantee for anything outside this PostgreSQL transaction (HTTP calls,
 *    email, chains, files). Handlers must be idempotent, and future external integrations need
 *    their own idempotency key, transactional boundary or delivery protocol.
 */
export async function consumeOutbox(
  db: Db,
  consumer: string,
  handler: (event: DomainEvent, ctx: TxContext) => Promise<void>,
  limit = 50,
): Promise<number> {
  return inTransaction(db, ModuleRole.worker, async (ctx) => {
    const pending = await ctx.trx
      .selectFrom('platform.outbox_event as e')
      .selectAll('e')
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('platform.outbox_consumption as c')
              .select('c.event_id')
              .where('c.consumer', '=', consumer)
              .whereRef('c.event_id', '=', 'e.id'),
          ),
        ),
      )
      .orderBy('e.id')
      .limit(limit)
      .execute();
    let processed = 0;
    for (const row of pending) {
      const claimed = await ctx.trx
        .insertInto('platform.outbox_consumption')
        .values({ consumer, event_id: row.id })
        .onConflict((oc) => oc.columns(['consumer', 'event_id']).doNothing())
        .returning('event_id')
        .executeTakeFirst();
      if (claimed === undefined) continue;
      await handler(toDomainEvent(row), ctx);
      processed++;
    }
    return processed;
  });
}

export function enqueueJob(
  db: Db,
  kind: string,
  payload: Record<string, unknown> = {},
): Promise<string> {
  return inTransaction(db, ModuleRole.worker, async (ctx) => {
    const id = newId();
    await ctx.trx
      .insertInto('platform.job')
      .values({
        id,
        kind,
        payload: JSON.stringify(payload),
        status: 'PENDING',
        attempts: 0,
        run_after: ctx.txTime,
        locked_by: null,
        locked_at: null,
        created_at: ctx.txTime,
        finished_at: null,
      })
      .execute();
    return id;
  });
}

/** Claims one due job with FOR UPDATE SKIP LOCKED, runs it, and records the outcome. */
export async function runOneJob(
  db: Db,
  workerId: string,
  handlers: Readonly<Record<string, (job: JobTable) => Promise<void>>>,
): Promise<JobTable | undefined> {
  const job = await inTransaction(db, ModuleRole.worker, async (ctx) => {
    const { rows } = await sql<JobTable>`
      UPDATE platform.job SET status = 'RUNNING', attempts = attempts + 1, locked_by = ${workerId}, locked_at = now()
      WHERE id = (
        SELECT id FROM platform.job WHERE status = 'PENDING' AND run_after <= now()
        ORDER BY run_after, id FOR UPDATE SKIP LOCKED LIMIT 1
      )
      RETURNING *`.execute(ctx.trx);
    return rows[0];
  });
  if (job === undefined) return undefined;
  const handler = handlers[job.kind];
  let status: 'DONE' | 'FAILED' = 'DONE';
  try {
    if (handler === undefined) throw new Error(`no handler for job kind ${job.kind}`);
    await handler(job);
  } catch {
    status = 'FAILED';
  }
  return inTransaction(db, ModuleRole.worker, async (ctx) => {
    const { rows } = await sql<JobTable>`
      UPDATE platform.job SET status = ${status}, finished_at = now() WHERE id = ${job.id} RETURNING *`.execute(
      ctx.trx,
    );
    return rows[0];
  });
}
