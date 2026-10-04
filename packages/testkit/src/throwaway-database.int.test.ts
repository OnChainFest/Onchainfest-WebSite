import { randomBytes } from 'node:crypto';
import { databaseUrls } from '@br/persistence';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { RECORD_FIXTURE_DATABASE_PATTERN } from './records';
import { dropThrowawayFixtureDatabase } from './throwaway-database';

/**
 * Regression: dropping a throwaway fixture database must not race pool clients that are still closing.
 * `pg.Pool#end()` resolves while its clients are `_ending` (pg-pool does not await `client.end()`);
 * terminating their backends at that instant used to surface FATAL 57P01 as unhandled pool errors
 * after the suite had passed (Node 22 CI). The slow close is simulated deterministically by delaying
 * each client's Terminate message; the control case proves the simulation reproduces the failure.
 */
const SLOW_CLOSE_MS = 500;
const admin = new pg.Client({ connectionString: databaseUrls().admin });
const created: string[] = [];
afterAll(async () => {
  for (const d of created)
    await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(d)} WITH (FORCE)`);
  await admin.end();
});

const urlOf = (database: string) => {
  const u = new URL(databaseUrls().admin);
  u.pathname = `/${database}`;
  return u.toString();
};

async function throwawayDatabase(): Promise<string> {
  if (created.length === 0) await admin.connect();
  const database = `br_recfx_${randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(database)}`);
  created.push(database);
  return database;
}

/** A pool whose idle clients close slowly: pool.end() resolves while they are still `_ending`. */
async function slowClosingPool(database: string) {
  const pool = new pg.Pool({ connectionString: urlOf(database), max: 3 });
  const errors: string[] = [];
  // Observes (does not hide) what reaches the pool: without the fix these would be unhandled.
  pool.on('error', (err) => errors.push((err as { code?: string }).code ?? err.message));
  const clients = await Promise.all([1, 2, 3].map(() => pool.connect()));
  for (const c of clients) {
    await c.query('SELECT 1');
    const con = (c as unknown as { connection: { end: () => void } }).connection;
    const end = con.end.bind(con);
    con.end = () => void setTimeout(end, SLOW_CLOSE_MS);
    c.release();
  }
  return { pool, errors, clients };
}

const exists = async (database: string) =>
  (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database])).rowCount === 1;
const settle = () => new Promise((resolve) => setTimeout(resolve, SLOW_CLOSE_MS + 300));

describe('dropThrowawayFixtureDatabase (teardown race)', () => {
  it('control: terminating right after pool.end() hits clients mid-close with 57P01', async () => {
    const database = await throwawayDatabase();
    const { pool, errors, clients } = await slowClosingPool(database);
    await pool.end();
    expect(clients.every((c) => (c as unknown as { _ending: boolean })._ending)).toBe(true);
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [database],
    );
    await settle();
    expect(errors).toEqual(['57P01', '57P01', '57P01']);
  });

  it('waits for closing clients: no termination, no pool error, database dropped', async () => {
    const database = await throwawayDatabase();
    const { pool, errors } = await slowClosingPool(database);
    await pool.end();
    const r = await dropThrowawayFixtureDatabase(database, RECORD_FIXTURE_DATABASE_PATTERN);
    await settle();
    expect(r).toEqual({ terminated: 0 });
    expect(errors).toEqual([]);
    expect(await exists(database)).toBe(false);
  });

  it('a genuinely stuck (leaked) session is terminated after the grace period, then dropped', async () => {
    const database = await throwawayDatabase();
    const leaked = new pg.Client({ connectionString: urlOf(database) });
    const leakErrors: string[] = [];
    leaked.on('error', (err) => leakErrors.push((err as { code?: string }).code ?? err.message));
    await leaked.connect();
    const r = await dropThrowawayFixtureDatabase(database, RECORD_FIXTURE_DATABASE_PATTERN, {
      graceMs: 200,
    });
    await settle();
    expect(r).toEqual({ terminated: 1 });
    expect(leakErrors[0]).toBe('57P01'); // then the socket closes ("terminated unexpectedly")
    expect(await exists(database)).toBe(false);
  });

  it('refuses anything that is not a throwaway fixture database of the declared kind', async () => {
    const database = await throwawayDatabase();
    for (const [name, pattern] of [
      ['bragging_rights_test', RECORD_FIXTURE_DATABASE_PATTERN],
      ['br_recfx_zz', RECORD_FIXTURE_DATABASE_PATTERN],
      // a real throwaway database, but not of the kind the caller declared
      [database, /^br_rkfx_[0-9a-f]{12}$/],
      // a permissive caller pattern never widens the throwaway allow-list
      ['postgres', /.*/],
      ['bragging_rights_test', /.*/],
    ] as const)
      await expect(dropThrowawayFixtureDatabase(name, pattern)).rejects.toThrow(/refusing to drop/);
    expect(await exists(database)).toBe(true);
  });
});
