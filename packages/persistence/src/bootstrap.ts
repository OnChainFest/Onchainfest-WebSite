import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const BOOTSTRAP_DIR = fileURLToPath(new URL('../../../db/bootstrap/', import.meta.url));

/**
 * Administrator bootstrap: cluster roles (idempotent), role passwords, and per-database
 * hardening (no PUBLIC access). Never run by applications.
 */
export async function bootstrapDatabase(
  adminUrl: string,
  databases: readonly string[],
  passwords: Readonly<Record<string, string>>,
): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(readFileSync(`${BOOTSTRAP_DIR}roles.sql`, 'utf8'));
    for (const [role, password] of Object.entries(passwords)) {
      await admin.query(
        `ALTER ROLE ${admin.escapeIdentifier(role)} PASSWORD ${admin.escapeLiteral(password)}`,
      );
    }
    for (const db of databases) {
      const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [db]);
      if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(db)}`);
      const sqlText = readFileSync(`${BOOTSTRAP_DIR}database.sql`, 'utf8').replaceAll(
        ':"dbname"',
        admin.escapeIdentifier(db),
      );
      const perDb = new pg.Client({ connectionString: withDb(adminUrl, db) });
      await perDb.connect();
      try {
        await perDb.query(sqlText);
      } finally {
        await perDb.end();
      }
    }
  } finally {
    await admin.end();
  }
}

/** Drops and recreates the canonical schemas of one database (development/test only). */
export async function resetDatabase(adminUrl: string, database: string): Promise<void> {
  if (process.env.NODE_ENV === 'production')
    throw new Error('reset is not available in production');
  const client = new pg.Client({ connectionString: withDb(adminUrl, database) });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS results, authority, platform, br_migrations CASCADE');
  } finally {
    await client.end();
  }
}

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}
