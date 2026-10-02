import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  bootstrapDatabase,
  createDb,
  databaseUrls,
  devRolePasswords,
  migrate,
  rankingOperatorDatabaseUrl,
  rankingWorkerDatabaseUrl,
  type Db,
} from '@br/persistence';
import pg from 'pg';
import { TEST_DATABASE } from './index';

/**
 * BRT-10 test logins and the REFERENCE PERSISTENCE FIXTURE lane (persistence foundation, Step 4).
 *
 *   ┌──────────────────────────────────────────────────────────────────────────────────────┐
 *   │ REFERENCE FIXTURE PERSISTENCE ENVIRONMENT — NOT CANONICAL SPORTING TRUTH              │
 *   │ A THROWAWAY database (br_rkfx_<hex>) is created, migrated with the NORMAL migrations, │
 *   │ then given the test-only overlay that relaxes ONLY the ranking run / snapshot         │
 *   │ provenance CHECKs. It is dropped after use. The API, web, worker and seeds never      │
 *   │ connect to it; no upstream canonical table ever receives a synthetic fact.            │
 *   └──────────────────────────────────────────────────────────────────────────────────────┘
 */
export const RANKING_FIXTURE_DATABASE_PATTERN = /^br_rkfx_[0-9a-f]{12}$/;
const OVERLAY = fileURLToPath(new URL('../sql/ranking-fixture-overlay.sql', import.meta.url));

/** Login br_ranking_operator_app (→ br_ranking_rules only). */
export function rankingOperatorDb(database = TEST_DATABASE): Db {
  const url = rankingOperatorDatabaseUrl(database);
  if (url === undefined) throw new Error('no ranking operator database URL');
  return createDb(url, { max: 2 });
}

/** Login br_ranking_worker_app (→ br_rankings, br_verification_reader). */
export function rankingWorkerDb(database = TEST_DATABASE): Db {
  const url = rankingWorkerDatabaseUrl(database);
  if (url === undefined) throw new Error('no ranking worker database URL');
  return createDb(url, { max: 2 });
}

function withDb(base: string, database: string) {
  const u = new URL(base);
  u.pathname = `/${database}`;
  return u.toString();
}

export interface RankingFixtureDatabase {
  readonly database: string;
  readonly destroy: () => Promise<void>;
}

/** Creates a THROWAWAY database with the normal bootstrap + migrations + the test-only overlay. */
export async function createRankingFixtureDatabase(): Promise<RankingFixtureDatabase> {
  const database = `br_rkfx_${randomBytes(6).toString('hex')}`;
  await bootstrapDatabase(databaseUrls().admin, [database], devRolePasswords());
  await migrate(withDb(databaseUrls().owner, database));
  const client = new pg.Client({ connectionString: withDb(databaseUrls().owner, database) });
  await client.connect();
  try {
    await client.query(readFileSync(OVERLAY, 'utf8'));
  } finally {
    await client.end();
  }
  return { database, destroy: () => dropRankingFixtureDatabase(database) };
}

export async function dropRankingFixtureDatabase(database: string): Promise<void> {
  if (!RANKING_FIXTURE_DATABASE_PATTERN.test(database))
    throw new Error(`refusing to drop ${database}: not a throwaway ranking fixture database`);
  const admin = new pg.Client({ connectionString: databaseUrls().admin });
  await admin.connect();
  try {
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(database)}`);
  } finally {
    await admin.end();
  }
}
