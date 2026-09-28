import { DomainError, DomainErrorCode } from '@br/domain';
import { DomainTag } from '@br/schemas';
import { sql } from 'kysely';
import { canonicalHash } from './hashing';
import type { TxContext } from './tx';

export interface IdempotencySpec {
  /** Namespace for the key — the acting principal id. */
  readonly scope: string;
  readonly key: string;
  readonly commandType: string;
  readonly requestSchema: { readonly id: string; readonly version: number };
  readonly request: unknown;
}

export type IdempotencyLookup<R> =
  | { readonly replay: true; readonly response: R }
  | { readonly replay: false; readonly requestHash: string };

/**
 * Command idempotency (BRT-02 persistence §7):
 *   same key + same request  → the stored response is replayed, no new effects;
 *   same key + different request → IDEMPOTENCY_KEY_REUSED.
 * The request fingerprint is a BR-JSON hash, so semantically identical requests match.
 *
 * Concurrency (BRT-03R): the check first takes a transaction-scoped advisory lock on
 * (scope, key). Concurrent requests with the same key therefore run one after another; each
 * later one reads the committed record of the first and replays or rejects it, before it
 * performs any side effect. Call this BEFORE any write in the command. The primary key on
 * (scope, idempotency_key) remains the database-level safety net: a violation rolls the whole
 * transaction back and `inTransaction` retries it, landing in the replay/reject path.
 */
export async function checkIdempotency<R>(
  ctx: TxContext,
  spec: IdempotencySpec,
): Promise<IdempotencyLookup<R>> {
  const requestHash = canonicalHash(
    DomainTag.commandRequest,
    spec.requestSchema,
    spec.request,
  ).contentHash;
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`idem:${spec.scope}:${spec.key}`}, 0))`.execute(
    ctx.trx,
  );
  const existing = await ctx.trx
    .selectFrom('platform.command_idempotency')
    .selectAll()
    .where('scope', '=', spec.scope)
    .where('idempotency_key', '=', spec.key)
    .executeTakeFirst();
  if (existing === undefined) return { replay: false, requestHash };
  if (existing.request_hash !== requestHash || existing.command_type !== spec.commandType) {
    throw new DomainError(
      DomainErrorCode.IDEMPOTENCY_KEY_REUSED,
      'idempotency key was already used for a different request',
      {
        key: spec.key,
      },
    );
  }
  return { replay: true, response: existing.response as R };
}

/** Records the response in the same transaction as the command's effects. */
export async function recordIdempotency(
  ctx: TxContext,
  spec: IdempotencySpec,
  requestHash: string,
  response: unknown,
): Promise<void> {
  await ctx.trx
    .insertInto('platform.command_idempotency')
    .values({
      scope: spec.scope,
      idempotency_key: spec.key,
      command_type: spec.commandType,
      request_hash: requestHash,
      response: JSON.stringify(response),
      recorded_at: ctx.txTime,
    })
    .execute();
}
