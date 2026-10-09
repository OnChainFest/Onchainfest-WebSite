import { newId, type DomainEvent } from '@br/domain';
import { apiDb, workerDb } from '@br/testkit';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { emitEvent } from './outbox';
import { inTransaction, ModuleRole, type TxContext } from './tx';
import { consumeOutbox, enqueueJob, runOneJob } from './worker-queue';

const api = apiDb(); // domain writes (events are emitted by br_results)
const worker = workerDb(); // consumption (br_worker)
afterAll(async () => {
  await api.destroy();
  await worker.destroy();
});

async function emitBatch(n: number): Promise<string> {
  const aggregateId = newId();
  await inTransaction(api, ModuleRole.results, async (ctx) => {
    for (let i = 0; i < n; i++) {
      await emitEvent(ctx, {
        eventType: 'ResultSubmitted',
        aggregateType: 'RESULT_VERSION',
        aggregateId,
        payload: { i },
      });
    }
  });
  return aggregateId;
}

/** A handler whose only effect is a DB row written in the consumer's transaction (a job). */
const recordEffect =
  (consumer: string, aggregateId: string) => async (event: DomainEvent, ctx: TxContext) => {
    if (event.aggregateId !== aggregateId) return;
    await sql`INSERT INTO platform.job (id, kind, payload) VALUES (${newId()}, ${`effect:${consumer}`}, ${JSON.stringify({ eventId: event.eventId })})`.execute(
      ctx.trx,
    );
  };

async function effectCount(consumer: string): Promise<{ total: number; distinct: number }> {
  return inTransaction(worker, ModuleRole.worker, async (ctx) => {
    const { rows } = await sql<{ total: number; distinct: number }>`
      SELECT count(*)::int AS total, count(DISTINCT payload->>'eventId')::int AS distinct
      FROM platform.job WHERE kind = ${`effect:${consumer}`}`.execute(ctx.trx);
    return rows[0] ?? { total: 0, distinct: 0 };
  });
}

describe('outbox delivery semantics (ADR-0012, BRT-03R)', () => {
  it('concurrent consumers produce exactly-once COMMITTED DATABASE EFFECTS per consumer', async () => {
    const aggregateId = await emitBatch(5);
    const consumer = `test-consumer-${newId()}`;
    const handler = recordEffect(consumer, aggregateId);
    await Promise.all(
      Array.from({ length: 4 }, () => consumeOutbox(worker, consumer, handler, 10_000)),
    );
    await consumeOutbox(worker, consumer, handler, 10_000);
    expect(await effectCount(consumer)).toEqual({ total: 5, distinct: 5 });
  });

  it('delivery is at least once: a failing handler rolls back its receipt and effects, and the event is redelivered', async () => {
    const aggregateId = await emitBatch(1);
    const consumer = `test-consumer-${newId()}`;
    const deliveries: string[] = [];
    let fail = true;
    const handler = async (event: DomainEvent, ctx: TxContext) => {
      if (event.aggregateId !== aggregateId) return;
      deliveries.push(event.eventId);
      await recordEffect(consumer, aggregateId)(event, ctx);
      if (fail) throw new Error('transient failure');
    };
    await expect(consumeOutbox(worker, consumer, handler, 10_000)).rejects.toThrow(
      'transient failure',
    );
    expect(await effectCount(consumer)).toEqual({ total: 0, distinct: 0 }); // effects rolled back with the receipt
    fail = false;
    await consumeOutbox(worker, consumer, handler, 10_000);
    expect(deliveries).toHaveLength(2); // delivered twice
    expect(new Set(deliveries).size).toBe(1);
    expect(await effectCount(consumer)).toEqual({ total: 1, distinct: 1 }); // committed once
  });

  it('claims, runs and completes a background job (worker login only)', async () => {
    const id = await enqueueJob(worker, 'noop', { hello: 'world' });
    let job;
    do {
      job = await runOneJob(worker, 'test-worker', { noop: async () => undefined });
    } while (job !== undefined && job.id !== id);
    expect(job?.status).toBe('DONE');
  });
});
