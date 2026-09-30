import { DomainError, DomainErrorCode } from '@br/domain';
import { sql, type Transaction } from 'kysely';
import type { Database, Db } from './db';

/**
 * Module roles (BRT-02 data access model §2). Logins hold none of them implicitly (NOINHERIT,
 * INHERIT FALSE) and may SET only the module roles granted to them:
 *   br_api → br_authority, br_results, br_identity, br_organizations, br_public_read,
 *            br_competition, br_evidence, br_verification, br_achievements, br_verification_reader
 *   br_verification_operator_app → br_verification_policy (BRT-07 policy mutation only)
 *   br_achievement_operator_app → br_achievement_rules (BRT-08 rule mutation only)
 *   br_api_vault → br_identity_private · br_worker_app → br_worker · br_maintenance → br_rebuild
 *   br_achievement_worker_app → br_achievements, br_verification_reader (BRT-08 worker derivation;
 *                                never br_verification)
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
  /** BRT-06 evidence + attestation module. */
  evidence: 'br_evidence',
  /** BRT-07 verification runtime (reads canonical facts; writes runs + its read model only). */
  verification: 'br_verification',
  /** BRT-07 verification-policy writer (reachable only from br_verification_operator_app). */
  verificationPolicy: 'br_verification_policy',
  /** BRT-08 achievement runtime (reads exact sporting facts; writes achievement facts + read model). */
  achievements: 'br_achievements',
  /** BRT-08 AchievementRule writer (reachable only from br_achievement_operator_app). */
  achievementRules: 'br_achievement_rules',
  /**
   * BRT-08 read-only interface to Verification (SELECT only: freshness inputs, runs, traces). Used by
   * the achievement runtime so Achievement consumes Verification without ever holding a role that can
   * write VerificationRuns, traces or policies.
   */
  verificationReader: 'br_verification_reader',
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
  // BRT-06: same provenance / same attachment / same statement raced — the retry replays it.
  'item_provenance_key_key',
  'attachment_evidence_id_target_type_target_id_role_key',
  'person_principal_pkey',
  // BRT-07: identical concurrent evaluations collapse to one logical run; version-number races.
  'run_identity_key',
  'policy_version_number_key',
  // BRT-08: identical concurrent derivations collapse to one logical Achievement.
  'achievement_identity_key',
  'rule_version_number_key',
  'supersession_pkey',
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
/**
 * BRT-08: runs `fn` under another module role of the SAME login inside the caller's transaction
 * (SET LOCAL ROLE, restored afterwards). Used by the achievement runtime to compute BRT-07 hash-based
 * verification freshness under the SELECT-only br_verification_reader in the derivation's own
 * REPEATABLE READ snapshot. The login must hold SET on both roles (never widens any grant).
 */
export async function withModuleRole<T>(
  ctx: TxContext,
  role: ModuleRole,
  fn: (ctx: TxContext) => Promise<T>,
): Promise<T> {
  await sql`SET LOCAL ROLE ${sql.id(role)}`.execute(ctx.trx);
  // On failure the transaction is rolled back as a whole; only a success restores the caller's role.
  const result = await fn({ ...ctx, role });
  await sql`SET LOCAL ROLE ${sql.id(ctx.role)}`.execute(ctx.trx);
  return result;
}

export async function inTransaction<T>(
  db: Db,
  role: ModuleRole,
  fn: (ctx: TxContext) => Promise<T>,
  maxAttempts = 4,
  options: {
    /**
     * BRT-07: REPEATABLE READ gives multi-statement readers (verification snapshots) one consistent
     * snapshot. Default: the database default (READ COMMITTED).
     */
    readonly isolation?: 'repeatable read';
  } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      const builder =
        options.isolation === undefined
          ? db.transaction()
          : db.transaction().setIsolationLevel(options.isolation);
      return await builder.execute(async (trx) => {
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
