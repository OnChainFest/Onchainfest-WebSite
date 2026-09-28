import { newId, type Uuid } from '@br/domain';
import { apiDb } from '@br/testkit';
import { afterAll, describe, expect, it } from 'vitest';
import { hashEvidenceBytes } from './hashing';
import { openStream, StreamType, verifyStreamChain } from './ledger';
import { inTransaction, ModuleRole } from './tx';

const db = apiDb();
afterAll(() => db.destroy());

// Synthetic facts use VERIFICATION streams, which have no BRT-03 projection consumer.
const fakeFact = () => ({
  eventType: 'TEST_FACT',
  factTable: 'test.fact',
  factRowId: newId(),
  payloadHash: hashEvidenceBytes(new TextEncoder().encode(newId())),
});

async function appendOne(streamId: Uuid) {
  return inTransaction(db, ModuleRole.results, async (ctx) => {
    const stream = await openStream(ctx, streamId, StreamType.VERIFICATION);
    const entry = await stream.append(fakeFact());
    await stream.close();
    return entry;
  });
}

describe('append-only aggregate ledger (BRT-02 persistence §5.2)', () => {
  it('same-stream writers serialize into a gap-free, correctly chained sequence', async () => {
    const streamId = newId();
    const entries = await Promise.all(Array.from({ length: 20 }, () => appendOne(streamId)));
    expect(entries.map((e) => e.sequence).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    const verification = await inTransaction(db, ModuleRole.results, (ctx) =>
      verifyStreamChain(ctx, streamId),
    );
    expect(verification).toMatchObject({ ok: true, entries: 20 });
  });

  it('different streams append independently and concurrently', async () => {
    const streams = Array.from({ length: 10 }, () => newId());
    const entries = await Promise.all(streams.map((s) => appendOne(s)));
    expect(entries.every((e) => e.sequence === 1)).toBe(true);
  });

  it('the expected-head guard rejects a stale writer and rolls the transaction back', async () => {
    const streamId = newId();
    await appendOne(streamId);
    await expect(
      inTransaction(db, ModuleRole.results, async (ctx) => {
        const stream = await openStream(ctx, streamId, StreamType.VERIFICATION, {
          expectedSequence: 0,
        });
        await stream.append(fakeFact());
      }),
    ).rejects.toThrow(/CONCURRENCY_CONFLICT/);
    const verification = await inTransaction(db, ModuleRole.results, (ctx) =>
      verifyStreamChain(ctx, streamId),
    );
    expect(verification.entries).toBe(1);
  });

  it('a failure inside the transaction leaves no ledger trace', async () => {
    const streamId = newId();
    await expect(
      inTransaction(db, ModuleRole.results, async (ctx) => {
        const stream = await openStream(ctx, streamId, StreamType.VERIFICATION);
        await stream.append(fakeFact());
        await stream.close();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const verification = await inTransaction(db, ModuleRole.results, (ctx) =>
      verifyStreamChain(ctx, streamId),
    );
    expect(verification.entries).toBe(0);
  });
});
