import { newId } from '@br/domain';
import {
  achievementWorkerDatabaseUrl,
  AchievementService,
  consumeOutbox,
  createDb,
  databaseReadiness,
  RANKING_WORKER_CONSUMER,
  RankingWorkerService,
  rankingWorkerDatabaseUrl,
  RecordService,
  recordWorkerDatabaseUrl,
  runOneJob,
  workerDatabaseUrl,
} from '@br/persistence';
import { assertRequiredConsumers, type WorkerConsumerState } from './config';

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
 *   records.evaluate       BRT-09: idempotent CANONICAL record evaluation (pending claims, logged blockers)
 *                          and standing-mark support reassessment (rescission only on basis
 *                          invalidation — never on temporary staleness), reacting to canonical events.
 *                          Runs on the dedicated br_record_worker_app login (br_records +
 *                          SELECT-only br_verification_reader); skipped (logged) when not configured.
 *                          RECORD_SET derivation stays in achievements.derive (RecordMarkRatified).
 *
 *   rankings.react         BRT-10 Step 10: on ResultVersion status changes, emits ClassificationStale
 *                          (idempotent per classification version + staleDigest) for the classifications
 *                          the change can affect; on candidate fact changes, evaluates the CANONICAL
 *                          ranking runs of the affected PUBLISHED system versions (natural-key
 *                          idempotent, cutoff = the event's occurredAt). Never re-submits or replaces a
 *                          classification, never publishes a snapshot, never consumes ranking events.
 *                          Runs on the dedicated br_ranking_worker_app login (br_rankings + SELECT-only
 *                          br_verification_reader); skipped (logged) when not configured.
 *                          No qualification / prize / trophy consumer exists (QUALIFIED is not wired).
 *
 *   --once   process one polling round and exit (used by the demos / CI smoke test)
 *   --check  LAUNCH-02 preflight: validate configuration, reach the database with the worker login,
 *            refuse pending migrations, print the consumer table as JSON and exit (0 ready, 1 not)
 *
 * BR_WORKER_REQUIRED_CONSUMERS (comma-separated) makes the named consumers mandatory: the worker
 * refuses to start (and --check fails) when one of them is disabled.
 */
const CONSUMER = 'dev.event-log';
const ACHIEVEMENT_CONSUMER = 'achievements.derive';
const workerId = `worker-${newId()}`;
const once = process.argv.includes('--once');
const check = process.argv.includes('--check');
// LAUNCH-02: only the worker login is resolved (production requires BR_WORKER_DATABASE_URL alone).
const db = createDb(workerDatabaseUrl(), { max: 3 });
const achievementUrl = achievementWorkerDatabaseUrl();
const achievementDb =
  achievementUrl === undefined ? undefined : createDb(achievementUrl, { max: 3 });
const achievements =
  achievementDb === undefined ? undefined : new AchievementService(achievementDb);
const RECORD_CONSUMER = 'records.evaluate';
const recordUrl = recordWorkerDatabaseUrl();
const recordDb = recordUrl === undefined ? undefined : createDb(recordUrl, { max: 3 });
const records = recordDb === undefined ? undefined : new RecordService(recordDb);
const rankingUrl = rankingWorkerDatabaseUrl();
const rankingDb = rankingUrl === undefined ? undefined : createDb(rankingUrl, { max: 3 });
const rankings = rankingDb === undefined ? undefined : new RankingWorkerService(rankingDb);

const consumers: WorkerConsumerState[] = [
  { name: CONSUMER, enabled: true },
  achievements === undefined
    ? {
        name: ACHIEVEMENT_CONSUMER,
        enabled: false,
        disabledReason: 'BR_ACHIEVEMENT_WORKER_DATABASE_URL not set',
      }
    : { name: ACHIEVEMENT_CONSUMER, enabled: true },
  records === undefined
    ? {
        name: RECORD_CONSUMER,
        enabled: false,
        disabledReason: 'BR_RECORD_WORKER_DATABASE_URL not set',
      }
    : { name: RECORD_CONSUMER, enabled: true },
  rankings === undefined
    ? {
        name: RANKING_WORKER_CONSUMER,
        enabled: false,
        disabledReason: 'BR_RANKING_WORKER_DATABASE_URL not set',
      }
    : { name: RANKING_WORKER_CONSUMER, enabled: true },
];

async function destroyPools() {
  await Promise.all([
    db.destroy(),
    achievementDb?.destroy(),
    recordDb?.destroy(),
    rankingDb?.destroy(),
  ]);
}

try {
  assertRequiredConsumers(consumers, process.env.BR_WORKER_REQUIRED_CONSUMERS);
} catch (err) {
  await destroyPools();
  throw err;
}

if (check) {
  const readiness = await databaseReadiness(db);
  console.log(JSON.stringify({ ...readiness, consumers }));
  await destroyPools();
  process.exit(readiness.status === 'ready' ? 0 : 1);
}

async function round(): Promise<{
  events: number;
  achievementEvents: number;
  recordEvents: number;
  rankingEvents: number;
  job?: string;
}> {
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
  let recordEvents = 0;
  if (records !== undefined)
    recordEvents = await consumeOutbox(db, RECORD_CONSUMER, async (event) => {
      const r = await records.react(event);
      if (r !== undefined)
        console.log(
          `[${RECORD_CONSUMER}] ${event.eventType}: evaluated=${r.evaluated} rescinded=${r.rescinded}`,
        );
    });
  let rankingEvents = 0;
  if (rankings !== undefined)
    rankingEvents = await consumeOutbox(db, RANKING_WORKER_CONSUMER, async (event) => {
      const r = await rankings.react(event);
      if (r === undefined) return;
      if (r.invalid !== undefined)
        console.log(
          `[${RANKING_WORKER_CONSUMER}] ${event.eventType} ${event.eventId}: ${r.invalid}`,
        );
      else
        console.log(
          `[${RANKING_WORKER_CONSUMER}] ${event.eventType}: stale checked=${r.staleness.checked} emitted=${r.staleness.emitted} runs evaluated=${r.runs.evaluated} created=${r.runs.created}`,
        );
    });
  const job = await runOneJob(db, workerId, {
    noop: async () => undefined,
  });
  return job === undefined
    ? { events, achievementEvents, recordEvents, rankingEvents }
    : {
        events,
        achievementEvents,
        recordEvents,
        rankingEvents,
        job: `${job.kind}:${job.status}`,
      };
}

let stopping = false;
const stop = () => {
  stopping = true;
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

console.log(
  `worker ${workerId} started (consumers ${CONSUMER}${achievements === undefined ? '; achievements.derive DISABLED: no achievement worker login' : `, ${ACHIEVEMENT_CONSUMER}`}${records === undefined ? '; records.evaluate DISABLED: no record worker login' : `, ${RECORD_CONSUMER}`}${rankings === undefined ? `; ${RANKING_WORKER_CONSUMER} DISABLED: no ranking worker login` : `, ${RANKING_WORKER_CONSUMER}`})`,
);
try {
  do {
    const r = await round();
    if (
      r.events > 0 ||
      r.achievementEvents > 0 ||
      r.recordEvents > 0 ||
      r.rankingEvents > 0 ||
      r.job !== undefined
    )
      console.log(
        `round: ${r.events} event(s), ${r.achievementEvents} achievement reaction(s), ${r.recordEvents} record reaction(s), ${r.rankingEvents} ranking reaction(s)${r.job === undefined ? '' : `, job ${r.job}`}`,
      );
    if (!once && !stopping) await new Promise((resolve) => setTimeout(resolve, 1000));
  } while (!once && !stopping);
} finally {
  await destroyPools();
}
