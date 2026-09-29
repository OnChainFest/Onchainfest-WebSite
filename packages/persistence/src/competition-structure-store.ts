import { randomBytes } from 'node:crypto';
import {
  canTransition,
  ContestLifecycle,
  deterministicDraw,
  DRAW_ALGORITHM,
  EventLifecycle,
  fieldHash as computeFieldHash,
  FormatEngineError,
  formatEngine,
  ParticipantLifecycle,
  planHash as computePlanHash,
  planInputHash as computePlanInputHash,
  seedingHash as computeSeedingHash,
  type ContestStatus,
  type DisciplineVersionSpec,
  type FieldSnapshot,
  type ParticipantStatus,
  type PlanDocument,
  type SeedingDocument,
} from '@br/competition';
import { DomainError, DomainErrorCode, newId, type DomainEventType, type Uuid } from '@br/domain';
import { sql } from 'kysely';
import { refreshEventReadModels } from './competition-projection';
import { activeTeamMembers, canActForAthlete, isTeamManager } from './competition-store';
import {
  competitionPermissions,
  currentStatus,
  instantOrThrow,
  loadCompetition,
  loadEvent,
  optionalText,
  requireCompPermission,
  text,
  transitionError,
} from './competition-support';
import type { Db } from './db';
import { identityIdempotency, lockKeys, recordAudit } from './identity-support';
import { emitEvent } from './outbox';
import { inTransaction, ModuleRole, type TxContext } from './tx';

interface FieldParticipant {
  readonly participantId: string;
  readonly registrationId: string;
  readonly kind: 'INDIVIDUAL' | 'TEAM';
  readonly athleteId: string | null;
  readonly teamId: string | null;
}

async function fieldParticipants(ctx: TxContext, eventId: string): Promise<FieldParticipant[]> {
  const { rows } = await sql<{
    id: string;
    registration_id: string;
    participant_kind: 'INDIVIDUAL' | 'TEAM';
    athlete_id: string | null;
    team_id: string | null;
  }>`
    SELECT id, registration_id, participant_kind, athlete_id, team_id FROM competition.participant WHERE event_id = ${eventId} ORDER BY id`.execute(
    ctx.trx,
  );
  return rows.map((r) => ({
    participantId: r.id,
    registrationId: r.registration_id,
    kind: r.participant_kind,
    athleteId: r.athlete_id,
    teamId: r.team_id,
  }));
}

function snapshotOf(eventId: string, participants: readonly FieldParticipant[]): FieldSnapshot {
  return {
    eventId,
    participants: participants.map((p) => ({
      participantId: p.participantId,
      registrationId: p.registrationId,
      kind: p.kind,
      ...(p.athleteId === null ? {} : { athleteId: p.athleteId }),
      ...(p.teamId === null ? {} : { teamId: p.teamId }),
    })),
  };
}

/**
 * Event structure operations (br_competition): field lock → seeding → plan → contests →
 * scheduling → lineups. The field, the seeding and the plan are immutable historical facts:
 * nothing here regenerates or overwrites them, and nothing resolves a dependent slot.
 */
export class StructureStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private tx<T>(fn: (ctx: TxContext) => Promise<T>): Promise<T> {
    return inTransaction(this.db, ModuleRole.competition, fn);
  }

  // ───────────────────────────── field lock ─────────────────────────────

  /**
   * REGISTRATION_CLOSED → FIELD_LOCKED. Every CONFIRMED registration becomes a Participant in the
   * same transaction; the canonical participant set is hashed and stored. Waitlisted or pending
   * requests never enter the field. No path leads back to registration afterwards.
   */
  async lockField(input: {
    actorAccountId: string;
    eventId: string;
    idempotencyKey: string;
  }): Promise<{ fieldHash: string; participantCount: number; created: boolean }> {
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ fieldHash: string; participantCount: number }>(ctx, {
        command: 'LockEventField',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { eventId: input.eventId },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      await lockKeys(ctx, `event-capacity:${input.eventId}`, `event-structure:${input.eventId}`);
      const e = await loadEvent(ctx, input.eventId);
      await requireCompPermission(
        ctx,
        input.actorAccountId,
        await loadCompetition(ctx, e.competitionId),
        'COMP_LOCK_FIELD',
      );
      if (!canTransition(EventLifecycle, e.status, 'FIELD_LOCKED'))
        throw transitionError('event', e.status, 'FIELD_LOCKED');
      const { rows: confirmed } = await sql<{
        id: string;
        entrant_type: 'INDIVIDUAL' | 'TEAM';
        athlete_id: string | null;
        team_id: string | null;
      }>`
        SELECT r.id, r.entrant_type, r.athlete_id, r.team_id FROM competition.registration r
        JOIN competition.v_registration_current v ON v.registration_id = r.id
        WHERE r.event_id = ${e.id} AND v.status = 'CONFIRMED' ORDER BY r.id`.execute(ctx.trx);
      const participants: FieldParticipant[] = [];
      for (const r of confirmed) {
        const participantId = newId();
        await sql`INSERT INTO competition.participant (id, event_id, participant_kind, athlete_id, team_id, registration_id, recorded_at)
          VALUES (${participantId}, ${e.id}, ${r.entrant_type}, ${r.athlete_id}, ${r.team_id}, ${r.id}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
        await sql`INSERT INTO competition.participant_status_change (id, participant_id, status, actor_account_id, recorded_at)
          VALUES (${newId()}, ${participantId}, 'ACTIVE', ${input.actorAccountId}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
        participants.push({
          participantId,
          registrationId: r.id,
          kind: r.entrant_type,
          athleteId: r.athlete_id,
          teamId: r.team_id,
        });
      }
      participants.sort((a, b) => (a.participantId < b.participantId ? -1 : 1));
      const fieldHash = computeFieldHash(snapshotOf(e.id, participants));
      await sql`INSERT INTO competition.event_field (event_id, field_hash, participant_count, locked_by_account_id, recorded_at)
        VALUES (${e.id}, ${fieldHash}, ${participants.length}, ${input.actorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await sql`INSERT INTO competition.event_status_change (id, event_id, status, actor_account_id, recorded_at)
        VALUES (${newId()}, ${e.id}, 'FIELD_LOCKED', ${input.actorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await refreshEventReadModels(ctx, e.id);
      await emitEvent(ctx, {
        eventType: 'EventFieldLocked',
        aggregateType: 'EVENT',
        aggregateId: e.id as Uuid,
        payload: { fieldHash, participantCount: participants.length },
      });
      await emitEvent(ctx, {
        eventType: 'ParticipantsMaterialized',
        aggregateType: 'EVENT',
        aggregateId: e.id as Uuid,
        payload: { participantIds: participants.map((p) => p.participantId) },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'event.field-locked',
        targetType: 'EVENT',
        targetId: e.id,
        details: { participantCount: participants.length },
      });
      const response = { fieldHash, participantCount: participants.length };
      await idem.record(response);
      return { ...response, created: true };
    });
  }

  // ───────────────────────────── seeding ─────────────────────────────

  /**
   * Seeds the locked field once: MANUAL (a full permutation) or DETERMINISTIC_DRAW (server CSPRNG
   * seed, persisted, `br-draw/1`). The seeding records the field hash it applies to.
   */
  async seedField(input: {
    actorAccountId: string;
    eventId: string;
    method: 'MANUAL' | 'DETERMINISTIC_DRAW';
    order?: readonly string[];
    idempotencyKey: string;
  }): Promise<{
    method: string;
    seedOrder: string[];
    drawSeed: string | null;
    seedingHash: string;
    created: boolean;
  }> {
    if (input.method !== 'MANUAL' && input.method !== 'DETERMINISTIC_DRAW')
      throw new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid seeding method');
    if (input.method === 'MANUAL' && input.order === undefined)
      throw new DomainError(DomainErrorCode.INVALID_INPUT, 'manual seeding needs an order');
    if (input.method === 'DETERMINISTIC_DRAW' && input.order !== undefined)
      throw new DomainError(DomainErrorCode.INVALID_INPUT, 'a draw takes no order');
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{
        method: string;
        seedOrder: string[];
        drawSeed: string | null;
        seedingHash: string;
      }>(ctx, {
        command: 'SeedEventField',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { eventId: input.eventId, method: input.method, order: input.order },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      await lockKeys(ctx, `event-structure:${input.eventId}`);
      const e = await loadEvent(ctx, input.eventId);
      await requireCompPermission(
        ctx,
        input.actorAccountId,
        await loadCompetition(ctx, e.competitionId),
        'COMP_GENERATE_STRUCTURE',
      );
      if (e.status !== 'FIELD_LOCKED')
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          'seeding requires a locked field',
        );
      const { rows: existing } = await sql<{
        n: number;
      }>`SELECT count(*)::int AS n FROM competition.event_seeding WHERE event_id = ${e.id}`.execute(
        ctx.trx,
      );
      if ((existing[0]?.n ?? 0) > 0)
        throw new DomainError(
          DomainErrorCode.ALREADY_EXISTS,
          'the field is already seeded (seeding is immutable)',
        );
      const { rows: field } = await sql<{
        field_hash: string;
      }>`SELECT field_hash FROM competition.event_field WHERE event_id = ${e.id}`.execute(ctx.trx);
      const fieldHash = field[0]?.field_hash as string;
      const ids = (await fieldParticipants(ctx, e.id)).map((p) => p.participantId);
      let order: string[];
      let drawSeed: string | null = null;
      if (input.method === 'MANUAL') {
        order = [...(input.order as readonly string[])].map((x) => x.toLowerCase());
        if (
          order.length !== ids.length ||
          new Set(order).size !== order.length ||
          !order.every((x) => ids.includes(x))
        ) {
          throw new DomainError(
            DomainErrorCode.INVALID_INPUT,
            'manual order must list every participant of the locked field exactly once',
          );
        }
      } else {
        drawSeed = randomBytes(32).toString('hex');
        order = deterministicDraw(ids, drawSeed);
      }
      const doc: SeedingDocument = {
        eventId: e.id,
        fieldHash,
        method: input.method,
        ...(drawSeed === null ? {} : { drawAlgorithm: DRAW_ALGORITHM, drawSeed }),
        order,
      };
      const seedingHash = computeSeedingHash(doc);
      await sql`INSERT INTO competition.event_seeding (event_id, field_hash, method, draw_algorithm, draw_seed, seed_order, seeding_hash, seeded_by_account_id, recorded_at)
        VALUES (${e.id}, ${fieldHash}, ${input.method}, ${drawSeed === null ? null : DRAW_ALGORITHM}, ${drawSeed}, ${order}::uuid[], ${seedingHash},
                ${input.actorAccountId}, ${ctx.txTime})`.execute(ctx.trx);
      await refreshEventReadModels(ctx, e.id);
      await emitEvent(ctx, {
        eventType: 'EventSeeded',
        aggregateType: 'EVENT',
        aggregateId: e.id as Uuid,
        payload: { method: input.method, seedingHash, fieldHash },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'event.seeded',
        targetType: 'EVENT',
        targetId: e.id,
        details: { method: input.method },
      });
      const response = { method: input.method, seedOrder: order, drawSeed, seedingHash };
      await idem.record(response);
      return { ...response, created: true };
    });
  }

  // ───────────────────────────── plan generation ─────────────────────────────

  /**
   * Generates the immutable EventPlan from (pinned DisciplineVersion, pinned FormatVersion + exact
   * engine version, locked field, seeding, canonical config). Repeating with the same canonical
   * input returns the existing plan; nothing ever overwrites a plan.
   */
  async generatePlan(input: {
    actorAccountId: string;
    eventId: string;
    idempotencyKey: string;
  }): Promise<{
    planHash: string;
    inputHash: string;
    engine: string;
    rounds: number;
    contests: number;
    created: boolean;
  }> {
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{
        planHash: string;
        inputHash: string;
        engine: string;
        rounds: number;
        contests: number;
      }>(ctx, {
        command: 'GenerateEventPlan',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { eventId: input.eventId },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      await lockKeys(ctx, `event-structure:${input.eventId}`);
      const e = await loadEvent(ctx, input.eventId);
      await requireCompPermission(
        ctx,
        input.actorAccountId,
        await loadCompetition(ctx, e.competitionId),
        'COMP_GENERATE_STRUCTURE',
      );
      if (e.status !== 'FIELD_LOCKED')
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          'plan generation requires a locked field',
        );
      const { rows: seeding } = await sql<{
        field_hash: string;
        seeding_hash: string;
        seed_order: string[];
      }>`
        SELECT field_hash, seeding_hash, seed_order FROM competition.event_seeding WHERE event_id = ${e.id}`.execute(
        ctx.trx,
      );
      const sd = seeding[0];
      if (sd === undefined)
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          'the field must be seeded before plan generation',
        );
      const { rows: dvRows } = await sql<{ spec: DisciplineVersionSpec; spec_hash: string }>`
        SELECT spec, spec_hash FROM sports.discipline_version WHERE id = ${e.disciplineVersionId}`.execute(
        ctx.trx,
      );
      const { rows: fvRows } = await sql<{
        engine_id: string;
        engine_version: number;
        spec_hash: string;
      }>`
        SELECT engine_id, engine_version, spec_hash FROM sports.format_version WHERE id = ${e.formatVersionId}`.execute(
        ctx.trx,
      );
      const dv = dvRows[0];
      const fv = fvRows[0];
      if (dv === undefined || fv === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'pinned catalog version not found');
      const engine = formatEngine(fv.engine_id, fv.engine_version);
      if (engine === undefined)
        throw new DomainError(
          DomainErrorCode.INVALID_INPUT,
          `format engine ${fv.engine_id}/${fv.engine_version} is not available`,
        );
      const participants = await fieldParticipants(ctx, e.id);
      const inputDoc = {
        eventId: e.id,
        disciplineVersionId: e.disciplineVersionId,
        disciplineVersionHash: dv.spec_hash,
        formatVersionId: e.formatVersionId,
        formatVersionHash: fv.spec_hash,
        engineId: engine.id,
        engineVersion: engine.version,
        fieldHash: sd.field_hash,
        seedingHash: sd.seeding_hash,
        configHash: e.formatConfigHash,
        seedOrder: sd.seed_order,
      };
      const inputHash = computePlanInputHash(inputDoc);
      const engineRef = `${engine.id}/${engine.version}`;

      const { rows: existing } = await sql<{
        input_hash: string;
        plan_hash: string;
        plan_document: PlanDocument;
      }>`
        SELECT input_hash, plan_hash, plan_document FROM competition.event_plan WHERE event_id = ${e.id}`.execute(
        ctx.trx,
      );
      if (existing[0] !== undefined) {
        if (existing[0].input_hash !== inputHash)
          throw new DomainError(
            DomainErrorCode.ALREADY_EXISTS,
            'a plan already exists for different inputs; plans are never overwritten',
          );
        const plan = existing[0].plan_document;
        const response = {
          planHash: existing[0].plan_hash,
          inputHash,
          engine: engineRef,
          rounds: plan.rounds.length,
          contests: plan.rounds.reduce((n, r) => n + r.contests.length, 0),
        };
        await idem.record(response);
        return { ...response, created: false };
      }

      let plan: PlanDocument;
      try {
        plan = engine.generate({
          eventId: e.id,
          participants: participants.map((p) => ({ participantId: p.participantId, kind: p.kind })),
          seedOrder: sd.seed_order,
          config: e.formatConfig,
          allowedContestTypes: dv.spec.allowedContestTypes,
        });
      } catch (err) {
        if (err instanceof FormatEngineError)
          throw new DomainError(DomainErrorCode.INVALID_INPUT, err.message, { reason: err.reason });
        throw err;
      }
      const planHash = computePlanHash(plan);
      await sql`INSERT INTO competition.event_plan (event_id, engine_id, engine_version, input_hash, plan_hash, plan_document, generated_by_account_id, recorded_at)
        VALUES (${e.id}, ${engine.id}, ${engine.version}, ${inputHash}, ${planHash}, ${JSON.stringify(plan)}::jsonb, ${input.actorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      const contestIds = new Map<string, string>();
      let contests = 0;
      for (const round of plan.rounds) {
        const roundId = newId();
        await sql`INSERT INTO competition.round (id, event_id, plan_key, sequence, round_type, label, byes, recorded_at)
          VALUES (${roundId}, ${e.id}, ${round.key}, ${round.sequence}, ${round.roundType}, ${round.label}, ${[...round.byes]}::uuid[], ${ctx.txTime})`.execute(
          ctx.trx,
        );
        for (const c of round.contests) {
          const contestId = newId();
          contestIds.set(c.key, contestId);
          contests += 1;
          await sql`INSERT INTO competition.contest (id, event_id, round_id, plan_key, sequence, contest_type, recorded_at)
            VALUES (${contestId}, ${e.id}, ${roundId}, ${c.key}, ${c.sequence}, ${c.contestType}, ${ctx.txTime})`.execute(
            ctx.trx,
          );
          await sql`INSERT INTO competition.contest_status_change (id, contest_id, status, actor_account_id, recorded_at)
            VALUES (${newId()}, ${contestId}, 'PLANNED', ${input.actorAccountId}, ${ctx.txTime})`.execute(
            ctx.trx,
          );
          for (const s of c.slots) {
            const sourceContest = s.contestKey === undefined ? null : contestIds.get(s.contestKey);
            if (s.contestKey !== undefined && sourceContest === undefined)
              throw new Error(`plan dependency ${s.contestKey} precedes its source`);
            await sql`INSERT INTO competition.contestant (id, contest_id, slot, source_kind, participant_id, source_contest_id, source_rank, recorded_at)
              VALUES (${newId()}, ${contestId}, ${s.slot}, ${s.source}, ${s.participantId ?? null}, ${sourceContest ?? null}, NULL, ${ctx.txTime})`.execute(
              ctx.trx,
            );
          }
        }
      }
      await refreshEventReadModels(ctx, e.id);
      await emitEvent(ctx, {
        eventType: 'EventPlanGenerated',
        aggregateType: 'EVENT',
        aggregateId: e.id as Uuid,
        payload: { engine: engineRef, inputHash, planHash, rounds: plan.rounds.length, contests },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'event.plan-generated',
        targetType: 'EVENT',
        targetId: e.id,
        details: { engine: engineRef },
      });
      const response = {
        planHash,
        inputHash,
        engine: engineRef,
        rounds: plan.rounds.length,
        contests,
      };
      await idem.record(response);
      return { ...response, created: true };
    });
  }

  // ───────────────────────────── contests ─────────────────────────────

  private async loadContest(ctx: TxContext, contestId: string) {
    const { rows } = await sql<{ event_id: string; status: ContestStatus }>`
      SELECT c.event_id, s.status FROM competition.contest c JOIN competition.v_contest_current s ON s.contest_id = c.id WHERE c.id = ${contestId}`.execute(
      ctx.trx,
    );
    if (rows[0] === undefined)
      throw new DomainError(DomainErrorCode.NOT_FOUND, 'contest not found');
    return { eventId: rows[0].event_id, status: rows[0].status };
  }

  /**
   * Schedules (or re-schedules) a contest: UTC instants, validated against the event window (or
   * the competition window when the event has none). Venue organizations are optional; changes
   * are audited. No authority effect is ever backdated through scheduling.
   */
  async scheduleContest(input: {
    actorAccountId: string;
    contestId: string;
    scheduledStart: Date | string;
    scheduledEnd?: Date | string | null;
    venueOrganizationId?: string | null;
    locationLabel?: string | null;
    courtLabel?: string | null;
    idempotencyKey: string;
  }): Promise<{ contestId: string; status: ContestStatus; created: boolean }> {
    const start = instantOrThrow(input.scheduledStart, 'scheduledStart');
    const end =
      input.scheduledEnd === undefined || input.scheduledEnd === null
        ? null
        : instantOrThrow(input.scheduledEnd, 'scheduledEnd');
    if (end !== null && end <= start)
      throw new DomainError(
        DomainErrorCode.INVALID_INPUT,
        'scheduledEnd must follow scheduledStart',
      );
    const location = optionalText(input.locationLabel, 120, 'locationLabel');
    const court = optionalText(input.courtLabel, 40, 'courtLabel');
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ contestId: string; status: ContestStatus }>(ctx, {
        command: 'ScheduleContest',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: {
          contestId: input.contestId,
          start: start.toISOString(),
          end: end?.toISOString(),
          venue: input.venueOrganizationId,
          location,
          court,
        },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      await lockKeys(ctx, `contest:${input.contestId}`);
      const c = await this.loadContest(ctx, input.contestId);
      const e = await loadEvent(ctx, c.eventId);
      await requireCompPermission(
        ctx,
        input.actorAccountId,
        await loadCompetition(ctx, e.competitionId),
        'COMP_MANAGE_SCHEDULE',
      );
      if (!['FIELD_LOCKED', 'IN_PROGRESS'].includes(e.status))
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          `cannot schedule contests of a ${e.status} event`,
        );
      if (c.status !== 'PLANNED' && c.status !== 'SCHEDULED')
        throw transitionError('contest', c.status, 'SCHEDULED');
      const { rows: cw } = await sql<{ starts_at: Date | null; ends_at: Date | null }>`
        SELECT starts_at, ends_at FROM competition.competition_profile WHERE competition_id = ${e.competitionId}`.execute(
        ctx.trx,
      );
      const windowStart = e.startsAt ?? cw[0]?.starts_at ?? null;
      const windowEnd = e.endsAt ?? cw[0]?.ends_at ?? null;
      if (
        (windowStart !== null && start < windowStart) ||
        (windowEnd !== null && (end ?? start) > windowEnd)
      ) {
        throw new DomainError(
          DomainErrorCode.INVALID_INPUT,
          'the contest must be scheduled within the event window',
        );
      }
      if (input.venueOrganizationId !== null && input.venueOrganizationId !== undefined) {
        const { rows } = await sql<{ status: string }>`
          SELECT status FROM organizations.v_organization_current WHERE organization_id = ${input.venueOrganizationId}`.execute(
          ctx.trx,
        );
        if (rows[0]?.status !== 'ACTIVE')
          throw new DomainError(
            DomainErrorCode.INVALID_INPUT,
            'venue organization not found or not active',
          );
      }
      const { rows: prev } = await sql<{
        scheduled_start: Date;
      }>`SELECT scheduled_start FROM competition.contest_schedule WHERE contest_id = ${input.contestId}`.execute(
        ctx.trx,
      );
      await sql`INSERT INTO competition.contest_schedule (contest_id, scheduled_start, scheduled_end, venue_organization_id, location_label, court_label, updated_at, updated_by_account_id)
        VALUES (${input.contestId}, ${start}, ${end}, ${input.venueOrganizationId ?? null}, ${location}, ${court}, ${ctx.txTime}, ${input.actorAccountId})
        ON CONFLICT (contest_id) DO UPDATE SET scheduled_start = EXCLUDED.scheduled_start, scheduled_end = EXCLUDED.scheduled_end,
          venue_organization_id = EXCLUDED.venue_organization_id, location_label = EXCLUDED.location_label, court_label = EXCLUDED.court_label,
          updated_at = EXCLUDED.updated_at, updated_by_account_id = EXCLUDED.updated_by_account_id`.execute(
        ctx.trx,
      );
      if (c.status === 'PLANNED') {
        await sql`INSERT INTO competition.contest_status_change (id, contest_id, status, actor_account_id, recorded_at)
          VALUES (${newId()}, ${input.contestId}, 'SCHEDULED', ${input.actorAccountId}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
      }
      await refreshEventReadModels(ctx, e.id);
      await emitEvent(ctx, {
        eventType: 'ContestScheduled',
        aggregateType: 'CONTEST',
        aggregateId: input.contestId as Uuid,
        payload: { eventId: e.id, scheduledStart: start.toISOString() },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: prev[0] === undefined ? 'contest.scheduled' : 'contest.rescheduled',
        targetType: 'CONTEST',
        targetId: input.contestId,
        details: {
          scheduledStart: start.toISOString(),
          ...(prev[0] === undefined
            ? {}
            : { previousStart: prev[0].scheduled_start.toISOString() }),
        },
      });
      const response = { contestId: input.contestId, status: 'SCHEDULED' as const };
      await idem.record(response);
      return { ...response, created: true };
    });
  }

  /** SCHEDULED → IN_PROGRESS. Every slot must hold an ACTIVE participant (no unresolved dependency). */
  startContest(input: { actorAccountId: string; contestId: string }): Promise<void> {
    return this.setContestStatus(
      input.actorAccountId,
      input.contestId,
      'IN_PROGRESS',
      'ContestStarted',
    );
  }

  /** IN_PROGRESS → COMPLETED: the activity ended. Creates no Result and resolves no dependency. */
  completeContest(input: { actorAccountId: string; contestId: string }): Promise<void> {
    return this.setContestStatus(
      input.actorAccountId,
      input.contestId,
      'COMPLETED',
      'ContestCompleted',
    );
  }

  cancelContest(input: {
    actorAccountId: string;
    contestId: string;
    reason: string;
  }): Promise<void> {
    return this.setContestStatus(
      input.actorAccountId,
      input.contestId,
      'CANCELLED',
      'ContestCancelled',
      text(input.reason, 500, 'reason'),
    );
  }

  voidContest(input: { actorAccountId: string; contestId: string; reason: string }): Promise<void> {
    return this.setContestStatus(
      input.actorAccountId,
      input.contestId,
      'VOID',
      'ContestVoided',
      text(input.reason, 500, 'reason'),
    );
  }

  private setContestStatus(
    actor: string,
    contestId: string,
    to: ContestStatus,
    eventType: DomainEventType,
    reason?: string,
  ): Promise<void> {
    return this.tx(async (ctx) => {
      await lockKeys(ctx, `contest:${contestId}`);
      const c = await this.loadContest(ctx, contestId);
      const e = await loadEvent(ctx, c.eventId);
      const permission =
        to === 'CANCELLED' || to === 'VOID' ? 'COMP_CANCEL' : 'COMP_MANAGE_SCHEDULE';
      await requireCompPermission(
        ctx,
        actor,
        await loadCompetition(ctx, e.competitionId),
        permission,
      );
      if (!canTransition(ContestLifecycle, c.status, to))
        throw transitionError('contest', c.status, to);
      if (to === 'IN_PROGRESS') {
        if (e.status !== 'IN_PROGRESS')
          throw new DomainError(
            DomainErrorCode.INVALID_TRANSITION,
            'the event must be IN_PROGRESS',
          );
        const { rows } = await sql<{ unready: number }>`
          SELECT count(*)::int AS unready FROM competition.contestant ct
          LEFT JOIN competition.v_participant_current pv ON pv.participant_id = ct.participant_id
          WHERE ct.contest_id = ${contestId} AND (ct.source_kind <> 'PARTICIPANT' OR pv.status IS DISTINCT FROM 'ACTIVE')`.execute(
          ctx.trx,
        );
        if ((rows[0]?.unready ?? 1) > 0) {
          throw new DomainError(
            DomainErrorCode.INVALID_TRANSITION,
            'the contest has unresolved or inactive slots and cannot start',
          );
        }
      }
      await sql`INSERT INTO competition.contest_status_change (id, contest_id, status, reason, actor_account_id, recorded_at)
        VALUES (${newId()}, ${contestId}, ${to}, ${reason ?? null}, ${actor}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await refreshEventReadModels(ctx, e.id);
      await emitEvent(ctx, {
        eventType,
        aggregateType: 'CONTEST',
        aggregateId: contestId as Uuid,
        payload: { eventId: e.id, status: to },
      });
      await recordAudit(ctx, {
        actorAccountId: actor,
        action: `contest.${to.toLowerCase().replace(/_/g, '-')}`,
        targetType: 'CONTEST',
        targetId: contestId,
      });
    });
  }

  // ───────────────────────────── participants ─────────────────────────────

  private async entrantControl(
    ctx: TxContext,
    accountId: string,
    p: { athlete_id: string | null; team_id: string | null },
  ): Promise<boolean> {
    return p.athlete_id !== null
      ? canActForAthlete(ctx, accountId, p.athlete_id)
      : isTeamManager(ctx, accountId, p.team_id as string);
  }

  /**
   * Post-lock withdrawal (entrant or organizer). Conservative: the participant keeps their bracket
   * slot and history; no walkover, forfeit or result is created and the plan is not rewritten.
   */
  withdrawParticipant(input: {
    actorAccountId: string;
    participantId: string;
    reason?: string;
  }): Promise<void> {
    return this.setParticipantStatus(
      input.actorAccountId,
      input.participantId,
      'WITHDRAWN',
      optionalText(input.reason, 500, 'reason'),
      null,
    );
  }

  /** Operational exclusion with mandatory reason + reference. NOT a verified sporting sanction. */
  disqualifyParticipant(input: {
    actorAccountId: string;
    participantId: string;
    reason: string;
    reference: string;
  }): Promise<void> {
    return this.setParticipantStatus(
      input.actorAccountId,
      input.participantId,
      'DISQUALIFIED',
      text(input.reason, 500, 'reason'),
      text(input.reference, 200, 'reference'),
    );
  }

  private setParticipantStatus(
    actor: string,
    participantId: string,
    to: ParticipantStatus,
    reason: string | null,
    reference: string | null,
  ): Promise<void> {
    return this.tx(async (ctx) => {
      await lockKeys(ctx, `participant:${participantId}`);
      const { rows } = await sql<{
        event_id: string;
        athlete_id: string | null;
        team_id: string | null;
      }>`
        SELECT event_id, athlete_id, team_id FROM competition.participant WHERE id = ${participantId}`.execute(
        ctx.trx,
      );
      const p = rows[0];
      if (p === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'participant not found');
      const e = await loadEvent(ctx, p.event_id);
      const competition = await loadCompetition(ctx, e.competitionId);
      const byEntrant = to === 'WITHDRAWN' && (await this.entrantControl(ctx, actor, p));
      if (!byEntrant)
        await requireCompPermission(ctx, actor, competition, 'COMP_MANAGE_REGISTRATIONS');
      const from = (await currentStatus(
        ctx,
        'competition.v_participant_current',
        'participant_id',
        participantId,
      )) as ParticipantStatus;
      if (!canTransition(ParticipantLifecycle, from, to))
        throw transitionError('participant', from, to);
      if (isFinished(e.status))
        throw new DomainError(DomainErrorCode.INVALID_TRANSITION, `the event is ${e.status}`);
      await sql`INSERT INTO competition.participant_status_change (id, participant_id, status, reason, reference, actor_account_id, recorded_at)
        VALUES (${newId()}, ${participantId}, ${to}, ${reason}, ${reference}, ${actor}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await refreshEventReadModels(ctx, e.id);
      await emitEvent(ctx, {
        eventType: to === 'WITHDRAWN' ? 'ParticipantWithdrawn' : 'ParticipantDisqualified',
        aggregateType: 'PARTICIPANT',
        aggregateId: participantId as Uuid,
        payload: { eventId: e.id, status: to },
      });
      await recordAudit(ctx, {
        actorAccountId: actor,
        action: byEntrant
          ? 'participant.withdrawn'
          : `participant.${to.toLowerCase()}-by-organizer`,
        targetType: 'PARTICIPANT',
        targetId: participantId,
      });
    });
  }

  // ───────────────────────────── lineups ─────────────────────────────

  /**
   * Declares who a Participant fields in a Contest. Validated against the Participant (individual:
   * exactly its athlete; team: ACTIVE team members now) and the discipline's lineup size. A new
   * declaration replaces the previous one (audited); TeamMembership is never changed by a lineup.
   */
  async submitLineup(input: {
    actorAccountId: string;
    contestId: string;
    participantId: string;
    athletes: readonly { readonly athleteId: string; readonly role?: string }[];
    idempotencyKey: string;
  }): Promise<{ lineupId: string; replaced: boolean; created: boolean }> {
    const athletes = input.athletes.map((a) => ({
      athleteId: a.athleteId.toLowerCase(),
      role: a.role ?? null,
    }));
    if (
      athletes.length === 0 ||
      athletes.length > 100 ||
      new Set(athletes.map((a) => a.athleteId)).size !== athletes.length
    ) {
      throw new DomainError(
        DomainErrorCode.INVALID_INPUT,
        'a lineup lists 1–100 distinct athletes',
      );
    }
    for (const a of athletes)
      if (a.role !== null && !/^[A-Z][A-Z_]{1,31}$/.test(a.role))
        throw new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid lineup role');
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ lineupId: string; replaced: boolean }>(ctx, {
        command: 'SubmitLineup',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { contestId: input.contestId, participantId: input.participantId, athletes },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      await lockKeys(ctx, `lineup:${input.contestId}:${input.participantId}`);
      const c = await this.loadContest(ctx, input.contestId);
      const e = await loadEvent(ctx, c.eventId);
      if (!['FIELD_LOCKED', 'IN_PROGRESS'].includes(e.status))
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          `cannot submit lineups for a ${e.status} event`,
        );
      if (c.status !== 'PLANNED' && c.status !== 'SCHEDULED')
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          'lineups close when the contest starts',
        );
      const { rows: ps } = await sql<{
        athlete_id: string | null;
        team_id: string | null;
        status: ParticipantStatus;
      }>`
        SELECT p.athlete_id, p.team_id, v.status FROM competition.contestant ct
        JOIN competition.participant p ON p.id = ct.participant_id
        JOIN competition.v_participant_current v ON v.participant_id = p.id
        WHERE ct.contest_id = ${input.contestId} AND ct.participant_id = ${input.participantId}`.execute(
        ctx.trx,
      );
      const p = ps[0];
      if (p === undefined)
        throw new DomainError(
          DomainErrorCode.INVALID_INPUT,
          'the participant does not occupy a resolved slot of this contest',
        );
      if (p.status !== 'ACTIVE')
        throw new DomainError(DomainErrorCode.INVALID_TRANSITION, 'the participant is not active');
      if (!(await this.entrantControl(ctx, input.actorAccountId, p))) {
        const { permissions } = await competitionPermissions(
          ctx,
          input.actorAccountId,
          await loadCompetition(ctx, e.competitionId),
        );
        if (!permissions.has('COMP_MANAGE_LINEUPS'))
          throw new DomainError(DomainErrorCode.FORBIDDEN, 'not permitted');
      }
      const { rows: dv } = await sql<{
        spec: DisciplineVersionSpec;
      }>`SELECT spec FROM sports.discipline_version WHERE id = ${e.disciplineVersionId}`.execute(
        ctx.trx,
      );
      const size = dv[0]?.spec.participation.lineupSize ?? { min: 1, max: 1 };
      if (athletes.length < size.min || athletes.length > size.max) {
        throw new DomainError(
          DomainErrorCode.INVALID_INPUT,
          `a lineup must field ${size.min}–${size.max} athletes`,
        );
      }
      const eligible =
        p.athlete_id !== null
          ? [p.athlete_id]
          : await activeTeamMembers(ctx, p.team_id as string, ctx.txTime);
      const ineligible = athletes.filter((a) => !eligible.includes(a.athleteId));
      if (ineligible.length > 0) {
        throw new DomainError(
          DomainErrorCode.INVALID_INPUT,
          p.athlete_id !== null
            ? 'an individual participant fields exactly its own athlete'
            : 'every lineup athlete must be an active member of the team',
        );
      }
      const { rows: prev } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM competition.lineup WHERE contest_id = ${input.contestId} AND participant_id = ${input.participantId}`.execute(
        ctx.trx,
      );
      const lineupId = newId();
      await sql`INSERT INTO competition.lineup (id, contest_id, participant_id, submitted_by_account_id, recorded_at)
        VALUES (${lineupId}, ${input.contestId}, ${input.participantId}, ${input.actorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      for (const a of athletes) {
        await sql`INSERT INTO competition.lineup_member (lineup_id, athlete_id, member_role, recorded_at)
          VALUES (${lineupId}, ${a.athleteId}, ${a.role}, ${ctx.txTime})`.execute(ctx.trx);
      }
      const replaced = (prev[0]?.n ?? 0) > 0;
      await emitEvent(ctx, {
        eventType: 'LineupSubmitted',
        aggregateType: 'CONTEST',
        aggregateId: input.contestId as Uuid,
        payload: { participantId: input.participantId, size: athletes.length, replaced },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: replaced ? 'lineup.replaced' : 'lineup.submitted',
        targetType: 'CONTEST',
        targetId: input.contestId,
      });
      const response = { lineupId, replaced };
      await idem.record(response);
      return { ...response, created: true };
    });
  }
}

function isFinished(status: string): boolean {
  return status === 'COMPLETED' || status === 'CANCELLED';
}
