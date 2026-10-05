/**
 * Connection configuration. Development defaults match docker-compose.yml and are refused in
 * production (NODE_ENV=production requires explicit environment variables).
 */
/**
 * One URL per login (BRT-03R role graph):
 *   admin        bootstrap only (roles, grants, database creation)
 *   owner        migrations only
 *   api          request processing: may SET ROLE br_authority | br_results | br_identity |
 *                br_organizations | br_public_read | br_competition (never br_catalog)
 *   vault        PII vault repository only: may SET ROLE br_identity_private
 *   operator     (optional; see operatorDatabaseUrl) INTERNAL catalog mutation: br_catalog only
 *   worker       background processing: may SET ROLE br_worker
 *   maintenance  projection rebuilds: may SET ROLE br_rebuild
 *   probe        development/test only: unprivileged
 */
export interface DatabaseUrls {
  readonly admin: string;
  readonly owner: string;
  readonly api: string;
  readonly vault: string;
  readonly worker: string;
  readonly maintenance: string;
  readonly probe: string;
}

export type LoginRole =
  | 'br_owner'
  | 'br_api'
  | 'br_api_vault'
  | 'br_operator_app'
  | 'br_verification_operator_app'
  | 'br_achievement_operator_app'
  | 'br_achievement_worker_app'
  | 'br_record_operator_app'
  | 'br_record_worker_app'
  | 'br_ranking_operator_app'
  | 'br_ranking_worker_app'
  | 'br_worker_app'
  | 'br_maintenance'
  | 'br_probe';

const DEV_HOST = 'localhost:55432';

function devUrl(user: string, password: string, database: string): string {
  return `postgres://${user}:${password}@${DEV_HOST}/${database}`;
}

export function databaseUrls(database?: string): DatabaseUrls {
  const production = process.env.NODE_ENV === 'production';
  const db = database ?? process.env.BR_DATABASE_NAME ?? 'bragging_rights';
  const pick = (name: string, fallback: string): string => {
    const value = process.env[name];
    if (value !== undefined && value !== '')
      return database === undefined ? value : withDatabase(value, db);
    if (production) throw new Error(`${name} must be set in production`);
    return fallback;
  };
  return {
    admin: pick('BR_ADMIN_DATABASE_URL', devUrl('br_admin', 'br_admin_dev_only', db)),
    owner: pick('BR_OWNER_DATABASE_URL', devUrl('br_owner', 'br_owner_dev_only', db)),
    api: pick('BR_API_DATABASE_URL', devUrl('br_api', 'br_api_dev_only', db)),
    vault: pick('BR_VAULT_DATABASE_URL', devUrl('br_api_vault', 'br_api_vault_dev_only', db)),
    worker: pick('BR_WORKER_DATABASE_URL', devUrl('br_worker_app', 'br_worker_app_dev_only', db)),
    maintenance: pick(
      'BR_MAINTENANCE_DATABASE_URL',
      devUrl('br_maintenance', 'br_maintenance_dev_only', db),
    ),
    probe: pick('BR_PROBE_DATABASE_URL', devUrl('br_probe', 'br_probe_dev_only', db)),
  };
}

/**
 * BRT-05R · Operator login (`br_operator_app` → `br_catalog` only): INTERNAL sport-catalog
 * mutation. Deliberately NOT part of `databaseUrls()` and optional: without it the catalog stays
 * readable and catalog mutation fails closed. Production uses only an explicitly configured
 * BR_OPERATOR_DATABASE_URL (returns undefined otherwise — never a development credential);
 * development/test tooling falls back to the local development login.
 */
export function operatorDatabaseUrl(database?: string): string | undefined {
  const db = database ?? process.env.BR_DATABASE_NAME ?? 'bragging_rights';
  const value = process.env.BR_OPERATOR_DATABASE_URL;
  if (value !== undefined && value !== '')
    return database === undefined ? value : withDatabase(value, db);
  if (process.env.NODE_ENV === 'production') return undefined;
  return devUrl('br_operator_app', 'br_operator_app_dev_only', db);
}

/**
 * BRT-07 · Verification-policy operator login (`br_verification_operator_app` →
 * `br_verification_policy` only): INTERNAL policy creation, publication and binding. Optional and
 * never part of `databaseUrls()`: without it verification reads and evaluations keep working and
 * policy mutation fails closed (503). Production uses only an explicitly configured
 * BR_VERIFICATION_OPERATOR_DATABASE_URL; development/test tooling falls back to the local login.
 * There is no fallback to the normal API connection (which cannot assume the policy role anyway).
 */
export function verificationOperatorDatabaseUrl(database?: string): string | undefined {
  const db = database ?? process.env.BR_DATABASE_NAME ?? 'bragging_rights';
  const value = process.env.BR_VERIFICATION_OPERATOR_DATABASE_URL;
  if (value !== undefined && value !== '')
    return database === undefined ? value : withDatabase(value, db);
  if (process.env.NODE_ENV === 'production') return undefined;
  return devUrl('br_verification_operator_app', 'br_verification_operator_app_dev_only', db);
}

/**
 * BRT-08 · AchievementRule operator login (`br_achievement_operator_app` → `br_achievement_rules`
 * only): INTERNAL rule creation, versioning, publication and binding. Optional and never part of
 * `databaseUrls()`: without it public reads and canonical derivation keep working and rule mutation
 * fails closed (503). Production uses only an explicitly configured
 * BR_ACHIEVEMENT_OPERATOR_DATABASE_URL; development/test tooling falls back to the local login. There
 * is no fallback to the normal API connection (which cannot assume the rule role anyway).
 */
export function achievementOperatorDatabaseUrl(database?: string): string | undefined {
  const db = database ?? process.env.BR_DATABASE_NAME ?? 'bragging_rights';
  const value = process.env.BR_ACHIEVEMENT_OPERATOR_DATABASE_URL;
  if (value !== undefined && value !== '')
    return database === undefined ? value : withDatabase(value, db);
  if (process.env.NODE_ENV === 'production') return undefined;
  return devUrl('br_achievement_operator_app', 'br_achievement_operator_app_dev_only', db);
}

/**
 * BRT-08 · Achievement worker login (`br_achievement_worker_app` → `br_achievements`,
 * `br_verification`): the worker's idempotent derivation reacting to canonical events. Optional:
 * without it the worker consumes events as before and skips achievement reactions (logged).
 */
export function achievementWorkerDatabaseUrl(database?: string): string | undefined {
  const db = database ?? process.env.BR_DATABASE_NAME ?? 'bragging_rights';
  const value = process.env.BR_ACHIEVEMENT_WORKER_DATABASE_URL;
  if (value !== undefined && value !== '')
    return database === undefined ? value : withDatabase(value, db);
  if (process.env.NODE_ENV === 'production') return undefined;
  return devUrl('br_achievement_worker_app', 'br_achievement_worker_app_dev_only', db);
}

/**
 * BRT-09 · RecordCategory operator login (`br_record_operator_app` → `br_record_rules` only):
 * INTERNAL category creation, versioning, publication and retirement. Optional and never part of
 * `databaseUrls()`: without it public record reads and canonical record evaluation keep working and
 * category mutation fails closed (503). Production uses only an explicitly configured
 * BR_RECORD_OPERATOR_DATABASE_URL; development/test tooling falls back to the local login. There is
 * no fallback to the normal API connection (which cannot assume the category role anyway).
 */
export function recordOperatorDatabaseUrl(database?: string): string | undefined {
  const db = database ?? process.env.BR_DATABASE_NAME ?? 'bragging_rights';
  const value = process.env.BR_RECORD_OPERATOR_DATABASE_URL;
  if (value !== undefined && value !== '')
    return database === undefined ? value : withDatabase(value, db);
  if (process.env.NODE_ENV === 'production') return undefined;
  return devUrl('br_record_operator_app', 'br_record_operator_app_dev_only', db);
}

/**
 * BRT-09 · Record worker login (`br_record_worker_app` → `br_records`, `br_verification_reader`):
 * idempotent record evaluation / current-support reassessment reacting to canonical events.
 * Optional: without it the worker skips record reactions (logged).
 */
export function recordWorkerDatabaseUrl(database?: string): string | undefined {
  const db = database ?? process.env.BR_DATABASE_NAME ?? 'bragging_rights';
  const value = process.env.BR_RECORD_WORKER_DATABASE_URL;
  if (value !== undefined && value !== '')
    return database === undefined ? value : withDatabase(value, db);
  if (process.env.NODE_ENV === 'production') return undefined;
  return devUrl('br_record_worker_app', 'br_record_worker_app_dev_only', db);
}

/**
 * BRT-10 · Ranking-definition operator login (`br_ranking_operator_app` → `br_ranking_rules` only):
 * INTERNAL RankingSystem / ClassificationPolicy creation, versioning, publication and retirement.
 * Optional and never part of `databaseUrls()`; production uses only an explicitly configured
 * BR_RANKING_OPERATOR_DATABASE_URL (no fallback to the normal API connection).
 */
export function rankingOperatorDatabaseUrl(database?: string): string | undefined {
  const db = database ?? process.env.BR_DATABASE_NAME ?? 'bragging_rights';
  const value = process.env.BR_RANKING_OPERATOR_DATABASE_URL;
  if (value !== undefined && value !== '')
    return database === undefined ? value : withDatabase(value, db);
  if (process.env.NODE_ENV === 'production') return undefined;
  return devUrl('br_ranking_operator_app', 'br_ranking_operator_app_dev_only', db);
}

/**
 * BRT-10 · Ranking worker login (`br_ranking_worker_app` → `br_rankings`, `br_verification_reader`):
 * ranking runs / snapshots reacting to canonical events. Optional: without it ranking reactions are
 * skipped.
 */
export function rankingWorkerDatabaseUrl(database?: string): string | undefined {
  const db = database ?? process.env.BR_DATABASE_NAME ?? 'bragging_rights';
  const value = process.env.BR_RANKING_WORKER_DATABASE_URL;
  if (value !== undefined && value !== '')
    return database === undefined ? value : withDatabase(value, db);
  if (process.env.NODE_ENV === 'production') return undefined;
  return devUrl('br_ranking_worker_app', 'br_ranking_worker_app_dev_only', db);
}

export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/** Development role passwords used by `pnpm db:bootstrap` (never in production). */
export function devRolePasswords(): Record<LoginRole, string> {
  if (process.env.NODE_ENV === 'production')
    throw new Error('development passwords are not available in production');
  return {
    br_owner: process.env.BR_OWNER_PASSWORD ?? 'br_owner_dev_only',
    br_api: process.env.BR_API_PASSWORD ?? 'br_api_dev_only',
    br_api_vault: process.env.BR_VAULT_PASSWORD ?? 'br_api_vault_dev_only',
    br_operator_app: process.env.BR_OPERATOR_PASSWORD ?? 'br_operator_app_dev_only',
    br_verification_operator_app:
      process.env.BR_VERIFICATION_OPERATOR_PASSWORD ?? 'br_verification_operator_app_dev_only',
    br_achievement_operator_app:
      process.env.BR_ACHIEVEMENT_OPERATOR_PASSWORD ?? 'br_achievement_operator_app_dev_only',
    br_achievement_worker_app:
      process.env.BR_ACHIEVEMENT_WORKER_PASSWORD ?? 'br_achievement_worker_app_dev_only',
    br_record_operator_app:
      process.env.BR_RECORD_OPERATOR_PASSWORD ?? 'br_record_operator_app_dev_only',
    br_record_worker_app: process.env.BR_RECORD_WORKER_PASSWORD ?? 'br_record_worker_app_dev_only',
    br_ranking_operator_app:
      process.env.BR_RANKING_OPERATOR_PASSWORD ?? 'br_ranking_operator_app_dev_only',
    br_ranking_worker_app:
      process.env.BR_RANKING_WORKER_PASSWORD ?? 'br_ranking_worker_app_dev_only',
    br_worker_app: process.env.BR_WORKER_PASSWORD ?? 'br_worker_app_dev_only',
    br_maintenance: process.env.BR_MAINTENANCE_PASSWORD ?? 'br_maintenance_dev_only',
    br_probe: process.env.BR_PROBE_PASSWORD ?? 'br_probe_dev_only',
  };
}
