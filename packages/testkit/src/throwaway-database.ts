import { databaseUrls } from '@br/persistence';
import pg from 'pg';

/** The only databases this module may ever terminate or drop: throwaway fixture databases. */
export const THROWAWAY_DATABASE_PATTERN = /^br_(achfx|rkfx|recfx)_[0-9a-f]{12}$/;

/** How long the database's own sessions get to finish closing before any of them is terminated. */
export const THROWAWAY_CLOSE_GRACE_MS = 10_000;
const POLL_MS = 25;

/**
 * Drops a throwaway fixture database WITHOUT racing the connections that are still closing.
 *
 * Why it waits: `Kysely#destroy()` → `pg.Pool#end()` resolves as soon as the pool has *asked* its idle
 * clients to end — pg-pool removes each one synchronously and does not await `client.end()` — so their
 * sockets may still be open (`_ending: true`, `_ended: false`) when the caller continues. Terminating
 * those backends at that instant makes the server send FATAL 57P01 ("terminating connection due to
 * administrator command") to a client that is mid-close; the client emits it as an `error`, its
 * still-attached pool idle listener re-emits it on the pool, and a pool without an `error` listener
 * turns it into an unhandled error AFTER every test has passed (seen on Node 22 CI).
 *
 * So: wait (bounded) until every session of the database has ended on its own; only sessions still
 * present after the grace period are genuinely stuck (a leaked client), and only those are terminated
 * — a leak still surfaces instead of being hidden. Nothing here listens to or swallows pool errors.
 */
export async function dropThrowawayFixtureDatabase(
  database: string,
  pattern: RegExp,
  options: { readonly graceMs?: number } = {},
): Promise<{ readonly terminated: number }> {
  if (!pattern.test(database) || !THROWAWAY_DATABASE_PATTERN.test(database))
    throw new Error(`refusing to drop ${database}: not a throwaway fixture database`);
  const admin = new pg.Client({ connectionString: databaseUrls().admin });
  await admin.connect();
  try {
    const sessions = async () =>
      (
        await admin.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
          [database],
        )
      ).rows[0]?.n ?? 0;
    const deadline = Date.now() + (options.graceMs ?? THROWAWAY_CLOSE_GRACE_MS);
    while ((await sessions()) > 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const { rows } = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM (
         SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()
       ) t`,
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(database)}`);
    return { terminated: rows[0]?.n ?? 0 };
  } finally {
    await admin.end();
  }
}
