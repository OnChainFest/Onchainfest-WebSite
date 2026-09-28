import { newId } from '@br/domain';
import { consumeOutbox, createDb, databaseUrls, runOneJob } from '@br/persistence';

/**
 * BRT-03 worker skeleton: polls the transactional outbox for the development log consumer and
 * claims background jobs. No production integrations, no external brokers.
 *
 *   --once   process one polling round and exit (used by the foundation demo / CI smoke test)
 */
const CONSUMER = 'dev.event-log';
const workerId = `worker-${newId()}`;
const once = process.argv.includes('--once');
const db = createDb(databaseUrls().worker, { max: 3 });

async function round(): Promise<{ events: number; job?: string }> {
  const events = await consumeOutbox(db, CONSUMER, async (event) => {
    console.log(`[${CONSUMER}] ${event.eventType} ${event.aggregateType}/${event.aggregateId}`);
  });
  const job = await runOneJob(db, workerId, {
    noop: async () => undefined,
  });
  return job === undefined ? { events } : { events, job: `${job.kind}:${job.status}` };
}

let stopping = false;
const stop = () => {
  stopping = true;
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

console.log(`worker ${workerId} started (consumer ${CONSUMER})`);
try {
  do {
    const r = await round();
    if (r.events > 0 || r.job !== undefined)
      console.log(`round: ${r.events} event(s)${r.job === undefined ? '' : `, job ${r.job}`}`);
    if (!once && !stopping) await new Promise((resolve) => setTimeout(resolve, 1000));
  } while (!once && !stopping);
} finally {
  await db.destroy();
}
