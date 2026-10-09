import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../db/migrations/', import.meta.url));

export interface MigrationFile {
  readonly version: string;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export function listMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const sqlText = readFileSync(`${dir}${file}`, 'utf8');
      return {
        version: file.slice(0, 4),
        name: file,
        sql: sqlText,
        checksum: createHash('sha256').update(sqlText).digest('hex'),
      };
    });
}

/**
 * Plain-SQL migration runner (BRT-02 stack: SQL-first). Runs as the owner role, each migration
 * in its own transaction, serialized by an advisory lock. Applied migrations are immutable:
 * a checksum mismatch aborts.
 */
export async function migrate(ownerUrl: string, dir = MIGRATIONS_DIR): Promise<string[]> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['br_migrations']);
    await client.query('CREATE SCHEMA IF NOT EXISTS br_migrations');
    await client.query('REVOKE ALL ON SCHEMA br_migrations FROM PUBLIC');
    await client.query(`CREATE TABLE IF NOT EXISTS br_migrations.applied (
      version text PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    // Readiness probes of the api/worker logins may read which migrations are applied
    // (a direct grant to the login, not to any module role).
    await client.query('REVOKE ALL ON br_migrations.applied FROM PUBLIC');
    await client.query('GRANT USAGE ON SCHEMA br_migrations TO br_api, br_worker_app');
    await client.query('GRANT SELECT ON br_migrations.applied TO br_api, br_worker_app');
    const { rows } = await client.query<{ version: string; checksum: string; name: string }>(
      'SELECT version, checksum, name FROM br_migrations.applied',
    );
    const done = new Map(rows.map((r) => [r.version, r]));
    for (const m of listMigrations(dir)) {
      const prior = done.get(m.version);
      if (prior !== undefined) {
        if (prior.checksum !== m.checksum)
          throw new Error(`migration ${m.name} was modified after being applied`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query(
          'INSERT INTO br_migrations.applied (version, name, checksum) VALUES ($1, $2, $3)',
          [m.version, m.name, m.checksum],
        );
        await client.query('COMMIT');
        applied.push(m.name);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${m.name} failed: ${String(err)}`, { cause: err });
      }
    }
  } finally {
    await client
      .query('SELECT pg_advisory_unlock(hashtext($1))', ['br_migrations'])
      .catch(() => undefined);
    await client.end();
  }
  return applied;
}

/** Returns true when every migration on disk is applied (used by /ready). */
export async function pendingMigrations(
  query: (sql: string) => Promise<{ rows: { version: string }[] }>,
): Promise<string[]> {
  const { rows } = await query('SELECT version FROM br_migrations.applied').catch(() => ({
    rows: [] as { version: string }[],
  }));
  const applied = new Set(rows.map((r) => r.version));
  return listMigrations()
    .filter((m) => !applied.has(m.version))
    .map((m) => m.name);
}
