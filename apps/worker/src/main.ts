import { newId } from '@br/domain';
import {
  achievementWorkerDatabaseUrl,
  AchievementService,
  consumeOutbox,
  createDb,
  databaseUrls,
  runOneJob,
} from '@br/persistence';

/**
 * Worker: polls the transactional outbox and claims background jobs. No external brokers.
 *
 *   dev.event-log          development log consumer (BRT-03)
 *   achievements.derive    BRT-08: idempotent CANONICAL Achievement derivation / current-support
 *                          re-assessment reacting to canonical events (VerificationEvaluated, …).
 *                          Runs on the dedicated br_achievement_worker_app login; skipped (logged)
 *                          when that login is not configured. At-least-once delivery ⇒ exactly-once
 *                          logical effects through the Achievement natural identity. There is no
 *                          fixture job, flag or event: only canonical assembly is ever used.
 *
 *   --once   process one polling round and exit (used by the demos / CI smoke test)
 */
const CONSUMER = 'dev.event-log';
const ACHIEVEMENT_CONSUMER = 'achievements.derive';
const workerId = `worker-${newId()}`;
const once = process.argv.includes('--once');
const db = createDb(databaseUrls().worker, { max: 3 });
const achievementUrl = achievementWorkerDatabaseUrl();
const achievementDb =
  achievementUrl === undefined ? undefined : createDb(achievementUrl, { max: 3 });
const achievements =
  achievementDb === undefined ? undefined : new AchievementService(achievementDb);

async function round(): Promise<{ events: number; achievementEvents: number; job?: string }> {
  const events = await consumeOutbox(db, CONSUMER, async (event) => {
    console.log(`[${CONSUMER}] ${event.eventType} ${event.aggregateType}/${event.aggregateId}`);
  });
  let achievementEvents = 0;
  if (achievements !== undefined)
    achievementEvents = await consumeOutbox(db, ACHIEVEMENT_CONSUMER, async (event) => {
      const r = await achievements.react(event);
      if (r !== undefined)
        console.log(
          `[${ACHIEVEMENT_CONSUMER}] ${event.eventType}: derived=${r.derived} reassessed=${r.reassessed}`,
        );
    });
  const job = await runOneJob(db, workerId, {
    noop: async () => undefined,
  });
  return job === undefined
    ? { events, achievementEvents }
    : { events, achievementEvents, job: `${job.kind}:${job.status}` };
}

let stopping = false;
const stop = () => {
  stopping = true;
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

console.log(
  `worker ${workerId} started (consumers ${CONSUMER}${achievements === undefined ? '; achievements.derive DISABLED: no achievement worker login' : `, ${ACHIEVEMENT_CONSUMER}`})`,
);
try {
  do {
    const r = await round();
    if (r.events > 0 || r.achievementEvents > 0 || r.job !== undefined)
      console.log(
        `round: ${r.events} event(s), ${r.achievementEvents} achievement reaction(s)${r.job === undefined ? '' : `, job ${r.job}`}`,
      );
    if (!once && !stopping) await new Promise((resolve) => setTimeout(resolve, 1000));
  } while (!once && !stopping);
} finally {
  await Promise.all([db.destroy(), achievementDb?.destroy()]);
}
