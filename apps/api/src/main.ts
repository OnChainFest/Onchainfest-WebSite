import { createDb, databaseUrls } from '@br/persistence';
import { buildServer } from './server';

const db = createDb(databaseUrls().api, { max: 5 });
const app = buildServer({ db, logger: true });
const port = Number(process.env.PORT ?? 4000);

const shutdown = async () => {
  await app.close();
  await db.destroy();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: process.env.HOST ?? '127.0.0.1', port });
