import { DomainError, DomainErrorCode } from '@br/domain';
import { sql, type Transaction } from 'kysely';
import type { Database, Db } from './db';

/**
 * Module roles (BRT-02 data access model §2). Logins hold none of them implicitly (NOINHERIT,
 * INHERIT FALSE) and may SET only the module roles granted to them:
 *   br_api → br_authority, br_results, br_identity, br_organizations, br_public_read
 *   br_api_vault → br_identity_private · br_worker_app → br_worker · br_maintenance → br_rebuild
 * A transaction on a connection whose login is not a member of `role` fails at SET ROLE.
 */
export const ModuleRole = {
  authority: 'br_authority',
  results: 'br_results',
  worker: 'br_worker',
  rebuild: 'br_rebuild',
  identity: 'br_identity',
  identityPrivate: 'br_identity_private',
  organizations: 'br_organizations',
  publicRead: 'br_public_read',
  catalog: 'br_catalog',
  competition: 'br_competition',
} as const;
export type ModuleRole = (typeof ModuleRole)[keyof typeof ModuleRole];

export type Tx = Transaction<Database>;

export interface TxContext {
  readonly trx: Tx;
  readonly role: ModuleRole;
  /** Platform time: DB transaction time truncated to ms. Used as recordedAt and issuedAt. */
  readonly txTime: Date;
}

/** Constraints whose violation indicates a lost race that is safe to retry. */
const RETRYABLE_CONSTRAINTS = new Set([
  'ledger_entry_stream_id_sequence_key',
  'stream_head_pkey',
  'command_idempotency_pkey',
  // Natural-key races: on retry the command finds the committed row and returns it.
  'authority_grant_grant_hash_key',
  'result_scope_type_scope_target_id_key',
]);

function pgError(err: unknown): { code?: string; constraint?: string } {
  return typeof err === 'object' && err !== null
    ? (err as { code?: string; constraint?: string })
    : {};
}

export function isRetryable(err: unknown): boolean {
  const { code, constraint } = pgError(err);
  if (code === '40001' || code === '40P01') return true; // serialization failure, deadlock
  return code === '23505' && constraint !== undefined && RETRYABLE_CONSTRAINTS.has(constraint);
}

/**
 * Runs `fn` in one PostgreSQL transaction under `SET LOCAL ROLE <module role>`.
 * Ledger facts, projection updates, outbox events and idempotency records written inside `fn`
 * commit or roll back together (BRT-02 persistence §5.4). Lost races are retried with jitter;
 * commands are idempotent, so a retry re-evaluates from scratch.
 */
export async function inTransaction<T>(
  db: Db,
  role: ModuleRole,
  fn: (ctx: TxContext) => Promise<T>,
  maxAttempts = 4,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction().execute(async (trx) => {
        await sql`SET LOCAL ROLE ${sql.id(role)}`.execute(trx);
        const { rows } = await sql<{ t: Date }>`SELECT platform.tx_time_ms() AS t`.execute(trx);
        const txTime = rows[0]?.t;
        if (txTime === undefined) throw new Error('could not read transaction time');
        return fn({ trx, role, txTime });
      });
    } catch (err) {
      if (attempt < maxAttempts && isRetryable(err)) {
        await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20 * attempt));
        continue;
      }
      if (isRetryable(err)) {
        throw new DomainError(
          DomainErrorCode.CONCURRENCY_CONFLICT,
          'transaction lost a concurrency race too many times',
          { cause: String(err) },
        );
      }
      throw err;
    }
  }
}
