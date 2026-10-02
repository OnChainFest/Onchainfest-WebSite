import { DomainEventType, type DomainEvent } from '@br/domain';
import { sql } from 'kysely';
import { ClassificationStalenessService } from './classification-staleness';
import type { Db } from './db';
import { RankingService } from './ranking-store';
import { inTransaction, ModuleRole } from './tx';

/**
 * BRT-10 Step 10 — the ranking worker reaction (login br_ranking_worker_app → br_rankings +
 * br_verification_reader). An ORCHESTRATOR only: every semantic decision stays in the pure engines and
 * the existing validated services.
 *
 *   classification staleness   a ResultVersion status change ⇒ ClassificationStalenessService.affectedBy
 *                              resolves the classification versions it can affect ⇒ emitStale for each.
 *                              The only output is the ClassificationStale outbox event, at most once per
 *                              (version, staleDigest). A stale classification is NEVER re-derived,
 *                              re-submitted or replaced (ADR-0047 §3, §6: the platform asserts no result
 *                              claim; replacement needs a T7 correction, which has no producer).
 *   canonical ranking runs     a change of a ranking candidate's facts (new version, status, verification)
 *                              ⇒ RankingService.evaluate for every PUBLISHED system version whose universe
 *                              can contain that ResultVersion, at the sporting cutoff `asOf = the event's
 *                              occurredAt`. The cutoff is part of the hashed run input, so a redelivered
 *                              event reproduces the same input and the run's natural key (system version,
 *                              input hash) collapses it. Runs are NEVER published here (no auto-publish).
 *
 * Never consumed: ClassificationStale, Ranking*, Achievement*, Record* or any other event (a ranking
 * handler never reacts to ranking events, so no loop exists). No QUALIFIED, record, prize, trophy, entry,
 * seeding, classification or verification write; no read-model write beyond the run writer's own
 * run_card refresh. Delivery is at least once (consumeOutbox); exactly-once LOGICAL effects come from
 * the natural keys above, not from the receipt.
 */
export const RANKING_WORKER_CONSUMER = 'rankings.react';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** ResultLedger status transitions: the only facts that change a classification's admissible set or pins. */
const STALENESS_EVENTS: ReadonlySet<string> = new Set([
  DomainEventType.ResultProvisional,
  DomainEventType.ResultRejected,
]);
/** Facts a canonical ranking-run assembly reads per candidate: versions, statuses, verification. */
const RUN_EVENTS: ReadonlySet<string> = new Set([
  DomainEventType.ResultSubmitted,
  DomainEventType.ResultProvisional,
  DomainEventType.ResultRejected,
  DomainEventType.VerificationEvaluated,
  DomainEventType.CurrentVerificationChanged,
]);

export interface RankingWorkerReaction {
  readonly eventId: string;
  readonly eventType: string;
  /** Present when the event was of a consumed type but its identity could not be validated. */
  readonly invalid?: 'INVALID_EVENT_IDENTITY';
  readonly resultVersionId?: string;
  readonly staleness: { readonly checked: number; readonly emitted: number };
  readonly runs: { readonly evaluated: number; readonly created: number };
}

/**
 * The exact ResultVersion an event is about, from its canonical identity only. Each consumed type has
 * exactly one shape; anything else is invalid (never guessed):
 *   Result* / CurrentVerificationChanged   aggregate RESULT_VERSION; a payload.resultVersionId, when
 *                                          present, must equal the aggregate id
 *   VerificationEvaluated                  aggregate VERIFICATION_RUN; payload.resultVersionId
 */
export function rankingWorkerTarget(event: DomainEvent): string | undefined {
  const payloadRv = event.payload.resultVersionId;
  if (event.eventType === DomainEventType.VerificationEvaluated) {
    if (event.aggregateType !== 'VERIFICATION_RUN') return undefined;
    return typeof payloadRv === 'string' && UUID.test(payloadRv) ? payloadRv : undefined;
  }
  if (event.aggregateType !== 'RESULT_VERSION' || !UUID.test(event.aggregateId)) return undefined;
  if (payloadRv !== undefined && payloadRv !== event.aggregateId) return undefined;
  return event.aggregateId;
}

/**
 * PUBLISHED system versions whose universe can contain `resultVersionId` at `asOf`: a CONTEST version of
 * an event of the universe's DisciplineVersion carrying a Performance with the universe Mark metric,
 * the version being in force (`effective_from ≤ asOf`). This only chooses WHICH runs to evaluate; the
 * engine still decides every admission, blocker and rank from the full canonical assembly.
 */
async function affectedSystemVersions(
  db: Db,
  resultVersionId: string,
  asOf: Date,
): Promise<readonly string[]> {
  return inTransaction(db, ModuleRole.rankings, async (ctx) => {
    const { rows } = await sql<{ id: string }>`
      SELECT DISTINCT sv.id::text AS id
      FROM results.result_version v
      JOIN results.result r ON r.id = v.result_id AND r.scope_type = 'CONTEST'
      JOIN competition.contest c ON c.id = r.scope_target_id
      JOIN competition.event e ON e.id = c.event_id
      JOIN ranking.system_version sv ON sv.discipline_version_id = e.discipline_version_id
      JOIN ranking.v_system_version_current cur ON cur.system_version_id = sv.id AND cur.status = 'PUBLISHED'
      WHERE v.id = ${resultVersionId}
        AND sv.effective_from <= ${asOf}
        AND v.content @> jsonb_build_object('performances',
              jsonb_build_array(jsonb_build_object('mark', jsonb_build_object('metricId', sv.mark_metric_id))))
      ORDER BY 1`.execute(ctx.trx);
    return rows.map((r) => r.id);
  });
}

export class RankingWorkerService {
  private readonly db: Db;
  private readonly staleness: ClassificationStalenessService;
  private readonly rankings: RankingService;

  /** `db` must be a br_ranking_worker_app connection (br_rankings + br_verification_reader). */
  constructor(db: Db) {
    this.db = db;
    this.staleness = new ClassificationStalenessService(db, { role: ModuleRole.rankings });
    this.rankings = new RankingService(db);
  }

  /**
   * Reacts to one outbox event. Returns undefined for every event type it does not consume. A consumed
   * type with an invalid identity is acknowledged as invalid (deterministic: a retry cannot fix it) and
   * causes no effect. Any other failure propagates, so the receipt rolls back and the event is
   * redelivered on a later round; every effect is idempotent, so a partial attempt is safe to repeat.
   */
  async react(event: DomainEvent): Promise<RankingWorkerReaction | undefined> {
    const stale = STALENESS_EVENTS.has(event.eventType);
    const run = RUN_EVENTS.has(event.eventType);
    if (!stale && !run) return undefined;
    const base = { eventId: event.eventId, eventType: event.eventType };
    const none = { staleness: { checked: 0, emitted: 0 }, runs: { evaluated: 0, created: 0 } };
    const rv = rankingWorkerTarget(event);
    const asOf = event.occurredAt instanceof Date ? event.occurredAt : new Date(NaN);
    if (rv === undefined || Number.isNaN(asOf.getTime()))
      return { ...base, invalid: 'INVALID_EVENT_IDENTITY', ...none };

    let checked = 0;
    let emitted = 0;
    if (stale)
      for (const versionId of await this.staleness.affectedBy(rv)) {
        checked++;
        if ((await this.staleness.emitStale(versionId)).emitted) emitted++;
      }

    let evaluated = 0;
    let created = 0;
    if (run)
      for (const systemVersionId of await affectedSystemVersions(this.db, rv, asOf)) {
        const r = await this.rankings.evaluate({
          systemVersionId,
          asOf,
          trigger: 'UPSTREAM_FACT_CHANGED',
        });
        evaluated++;
        if (r.created) created++;
      }

    return {
      ...base,
      resultVersionId: rv,
      staleness: { checked, emitted },
      runs: { evaluated, created },
    };
  }
}
