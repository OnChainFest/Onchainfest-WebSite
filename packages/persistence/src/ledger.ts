import { DomainError, DomainErrorCode, newId, toCanonicalTimestamp, type Uuid } from '@br/domain';
import { DomainTag, SchemaRef } from '@br/schemas';
import { canonicalHash } from './hashing';
import type { LedgerEntryTable } from './db';
import type { TxContext } from './tx';

/** Stream types (BRT-02 persistence §5.2). BRT-03 writes RESULT, PRINCIPAL_KEY, AUTHORITY_GRANT, TRUST_ANCHOR. */
export const StreamType = {
  RESULT: 'RESULT',
  VERIFICATION: 'VERIFICATION',
  ATTESTATION: 'ATTESTATION',
  EVIDENCE_ITEM: 'EVIDENCE_ITEM',
  PRINCIPAL_KEY: 'PRINCIPAL_KEY',
  AUTHORITY_GRANT: 'AUTHORITY_GRANT',
  TRUST_ANCHOR: 'TRUST_ANCHOR',
  DISPUTE: 'DISPUTE',
  ACHIEVEMENT: 'ACHIEVEMENT',
  RECORD_CATEGORY: 'RECORD_CATEGORY',
  PRIZE_ENTITLEMENT: 'PRIZE_ENTITLEMENT',
  TROPHY: 'TROPHY',
} as const;
export type StreamType = (typeof StreamType)[keyof typeof StreamType];

export interface FactToAppend {
  readonly eventType: string;
  readonly factTable: string;
  readonly factRowId: Uuid;
  /** Ledger payload hash: domain-separated hash of the fact document. */
  readonly payloadHash: string;
}

export function genesisHash(streamType: StreamType, streamId: Uuid): string {
  return canonicalHash(DomainTag.ledgerGenesis, SchemaRef.ledgerGenesis, { streamType, streamId })
    .contentHash;
}

export function entryHash(entry: Omit<LedgerEntryTable, 'id' | 'entry_hash'>): string {
  return canonicalHash(DomainTag.ledgerRow, SchemaRef.ledgerEntry, {
    streamType: entry.stream_type,
    streamId: entry.stream_id,
    sequence: entry.sequence,
    previousHash: entry.previous_hash,
    entryType: entry.event_type,
    factTable: entry.fact_table,
    factRowId: entry.fact_row_id,
    factHash: entry.payload_hash,
    recordedAt: toCanonicalTimestamp(entry.recorded_at),
  }).contentHash;
}

/**
 * An open, locked aggregate stream (BRT-02 persistence §5.2).
 *
 *  1. `openStream` locks the stream head row (creating it at sequence 0 / genesis if new);
 *     same-stream writers serialize here, different streams never contend;
 *  2. `append` inserts ledger entries with consecutive sequences and chained hashes;
 *  3. `close` advances the head with a guarded update (expected previous sequence).
 *
 * UNIQUE(stream_id, sequence) is the safety net; a violation rolls back the whole transaction
 * and is retried by `inTransaction`.
 */
export class StreamAppender {
  readonly streamId: Uuid;
  readonly streamType: StreamType;
  readonly openedAtSequence: number;
  private sequence: number;
  private lastHash: string;
  private readonly ctx: TxContext;
  private readonly appended: LedgerEntryTable[] = [];
  private closed = false;

  constructor(
    ctx: TxContext,
    streamId: Uuid,
    streamType: StreamType,
    lastSequence: number,
    lastHash: string,
  ) {
    this.ctx = ctx;
    this.streamId = streamId;
    this.streamType = streamType;
    this.openedAtSequence = lastSequence;
    this.sequence = lastSequence;
    this.lastHash = lastHash;
  }

  get entries(): readonly LedgerEntryTable[] {
    return this.appended;
  }

  async append(fact: FactToAppend): Promise<LedgerEntryTable> {
    if (this.closed) throw new Error('stream already closed');
    const base = {
      stream_id: this.streamId,
      stream_type: this.streamType,
      sequence: this.sequence + 1,
      previous_hash: this.lastHash,
      payload_hash: fact.payloadHash,
      event_type: fact.eventType,
      fact_table: fact.factTable,
      fact_row_id: fact.factRowId,
      recorded_at: this.ctx.txTime,
    };
    const row: LedgerEntryTable = { id: newId(), ...base, entry_hash: entryHash(base) };
    await this.ctx.trx.insertInto('platform.ledger_entry').values(row).execute();
    this.sequence = row.sequence;
    this.lastHash = row.entry_hash;
    this.appended.push(row);
    return row;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.sequence === this.openedAtSequence) return;
    const result = await this.ctx.trx
      .updateTable('platform.stream_head')
      .set({ last_sequence: this.sequence, last_hash: this.lastHash, updated_at: this.ctx.txTime })
      .where('stream_id', '=', this.streamId)
      .where('last_sequence', '=', this.openedAtSequence)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) {
      throw new DomainError(
        DomainErrorCode.CONCURRENCY_CONFLICT,
        `stream ${this.streamId} head moved concurrently`,
      );
    }
  }
}

export async function openStream(
  ctx: TxContext,
  streamId: Uuid,
  streamType: StreamType,
  options: { expectedSequence?: number } = {},
): Promise<StreamAppender> {
  const lock = () =>
    ctx.trx
      .selectFrom('platform.stream_head')
      .selectAll()
      .where('stream_id', '=', streamId)
      .forUpdate()
      .executeTakeFirst();
  let head = await lock();
  if (head === undefined) {
    await ctx.trx
      .insertInto('platform.stream_head')
      .values({
        stream_id: streamId,
        stream_type: streamType,
        last_sequence: 0,
        last_hash: genesisHash(streamType, streamId),
        updated_at: ctx.txTime,
      })
      .onConflict((oc) => oc.column('stream_id').doNothing())
      .execute();
    head = await lock();
  }
  if (head === undefined) throw new Error(`stream head ${streamId} could not be locked`);
  if (head.stream_type !== streamType) {
    throw new DomainError(
      DomainErrorCode.INVALID_INPUT,
      `stream ${streamId} is a ${head.stream_type} stream, not ${streamType}`,
    );
  }
  if (options.expectedSequence !== undefined && head.last_sequence !== options.expectedSequence) {
    throw new DomainError(
      DomainErrorCode.CONCURRENCY_CONFLICT,
      `expected stream ${streamId} at sequence ${options.expectedSequence}, found ${head.last_sequence}`,
    );
  }
  return new StreamAppender(ctx, streamId, streamType, head.last_sequence, head.last_hash);
}

export interface ChainVerification {
  readonly streamId: Uuid;
  readonly entries: number;
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/** Recomputes every entry hash and previous-hash link of a stream and compares with its head. */
export async function verifyStreamChain(
  ctx: TxContext,
  streamId: Uuid,
): Promise<ChainVerification> {
  const rows = await ctx.trx
    .selectFrom('platform.ledger_entry')
    .selectAll()
    .where('stream_id', '=', streamId)
    .orderBy('sequence')
    .execute();
  const problems: string[] = [];
  let expectedPrev =
    rows[0] === undefined ? undefined : genesisHash(rows[0].stream_type as StreamType, streamId);
  rows.forEach((row, i) => {
    if (row.sequence !== i + 1) problems.push(`gap before sequence ${row.sequence}`);
    if (row.previous_hash !== expectedPrev)
      problems.push(`sequence ${row.sequence}: previous_hash does not link`);
    const { id: _id, entry_hash, ...rest } = row;
    if (entryHash(rest) !== entry_hash)
      problems.push(`sequence ${row.sequence}: entry_hash mismatch`);
    expectedPrev = entry_hash;
  });
  const head = await ctx.trx
    .selectFrom('platform.stream_head')
    .selectAll()
    .where('stream_id', '=', streamId)
    .executeTakeFirst();
  const last = rows.at(-1);
  if (
    last !== undefined &&
    (head?.last_sequence !== last.sequence || head.last_hash !== last.entry_hash)
  ) {
    problems.push('stream head does not match the last entry');
  }
  return { streamId, entries: rows.length, ok: problems.length === 0, problems };
}
