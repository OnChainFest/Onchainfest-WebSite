import { pendingMigrations, type Db } from '@br/persistence';
import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'kysely';

export interface ApiOptions {
  readonly db: Db;
  readonly logger?: boolean;
}

/**
 * BRT-03 API scaffold. Only liveness and readiness are exposed; the trust domain remains
 * callable through packages (no mutation endpoints until authentication and signatures exist).
 */
export function buildServer(options: ApiOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'bragging-rights-api',
    phase: 'BRT-03',
  }));

  app.get('/ready', async (_request, reply) => {
    try {
      // Runs as the api login itself (no module role): it may only read the migration ledger.
      const pending = await options.db.transaction().execute(async (trx) => {
        await sql`SELECT 1`.execute(trx);
        return pendingMigrations(async (text) => {
          const { rows } = await sql.raw<{ version: string }>(text).execute(trx);
          return { rows };
        });
      });
      if (pending.length > 0)
        return reply.code(503).send({ status: 'not_ready', reason: 'pending_migrations', pending });
      return { status: 'ready' };
    } catch (err) {
      return reply
        .code(503)
        .send({ status: 'not_ready', reason: 'database_unavailable', detail: String(err) });
    }
  });

  return app;
}
