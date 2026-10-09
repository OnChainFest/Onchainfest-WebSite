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
  capabilityIssues,
  computeSeeding,
  engineRequirements,
  fieldHashV2,
  planHashV2,
  planInputHashV2,
  providedCapabilities,
  SeedingError,
  seedingHashV2,
  validEntryAttributeValue,
  type SeedingMethodV2,
  type SeedingOverride,
  type SeedSource,
} from '@br/competition';
import { DomainError, DomainErrorCode, newId, type DomainEventType, type Uuid } from '@br/domain';
import { sql } from 'kysely';
import { refreshEventReadModels } from './competition-projection';
import { activeTeamMembers, canActForAthlete, isTeamManager } from './competition-store';
import {
  disciplineSpec,
  frozenAttribute,
  frozenRoster,
  materializePlanV2,
  snapshotFieldV2,
} from './competition-structure-v2';
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
/**
 * ONCF-05D: reports the dependent places of a contest whose occupant no longer follows from
 * current official results (STALE). Injected by the composition root (AdvancementStore) so the
 * structure store never reads results itself.
 */
export type ContestStartGuard = (contestId: string) => Promise<readonly string[]>;

export class StructureStore {
  private readonly db: Db;
  private readonly startGuard: ContestStartGuard | undefined;

  constructor(db: Db, options: { startGuard?: ContestStartGuard } = {}) {
    this.db = db;
    this.startGuard = options.startGuard;
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
      // ONCF-05B: a v2 discipline freezes the roster and declared entry attributes into the field
      // (br:competition-field@2). v1 disciplines keep the exact BRT-05 field document.
      const spec = await disciplineSpec(ctx, e.disciplineVersionId);
      const v2 = spec.specVersion === 2;
      const fieldHash = v2
        ? fieldHashV2(await snapshotFieldV2(ctx, e.id, participants, spec))
        : computeFieldHash(snapshotOf(e.id, participants));
      await sql`INSERT INTO competition.event_field (event_id, field_hash, participant_count, locked_by_account_id, field_version, recorded_at)
        VALUES (${e.id}, ${fieldHash}, ${participants.length}, ${input.actorAccountId}, ${v2 ? 2 : 1}, ${ctx.txTime})`.execute(
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
   * Seeds the locked field once (immutable; tied to the field hash).
   *  - v1 (BRT-05, unchanged): MANUAL (a full permutation) or DETERMINISTIC_DRAW (`br-draw/1`).
   *  - v2 (ONCF-05B, ADR-0058): + RANKED_THEN_DRAWN (declared seeds, banded, the rest drawn) and
   *    BY_ENTRY_ATTRIBUTE (frozen declared values, e.g. entry time); a declared source; audited
   *    overrides with reasons. Used whenever a v2 feature is requested or the field is v2.
   * Every draw uses a server CSPRNG seed that is persisted (reproducible, not provably fair).
   */
  async seedField(input: {
    actorAccountId: string;
    eventId: string;
    method: SeedingMethodV2;
    order?: readonly string[];
    seeds?: readonly string[];
    banded?: boolean;
    attributeKey?: string;
    direction?: 'ASC' | 'DESC';
    source?: SeedSource;
    overrides?: readonly SeedingOverride[];
    idempotencyKey: string;
  }): Promise<{
    method: string;
    seedOrder: string[];
    drawSeed: string | null;
    seedingHash: string;
    seedingVersion: 1 | 2;
    created: boolean;
  }> {
    if (
      !['MANUAL', 'DETERMINISTIC_DRAW', 'RANKED_THEN_DRAWN', 'BY_ENTRY_ATTRIBUTE'].includes(
        input.method,
      )
    )
      throw new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid seeding method');
    if (input.method === 'MANUAL' && input.order === undefined)
      throw new DomainError(DomainErrorCode.INVALID_INPUT, 'manual seeding needs an order');
    if (input.method !== 'MANUAL' && input.order !== undefined)
      throw new DomainError(DomainErrorCode.INVALID_INPUT, 'only manual seeding takes an order');
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{
        method: string;
        seedOrder: string[];
        drawSeed: string | null;
        seedingHash: string;
        seedingVersion: 1 | 2;
      }>(ctx, {
        command: 'SeedEventField',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: {
          eventId: input.eventId,
          method: input.method,
          order: input.order,
          seeds: input.seeds,
          banded: input.banded,
          attributeKey: input.attributeKey,
          direction: input.direction,
          source: input.source,
          overrides: input.overrides,
        },
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
        field_version: number;
      }>`SELECT field_hash, field_version FROM competition.event_field WHERE event_id = ${e.id}`.execute(
        ctx.trx,
      );
      const fieldHash = field[0]?.field_hash as string;
      const ids = (await fieldParticipants(ctx, e.id)).map((p) => p.participantId);
      const v2 =
        field[0]?.field_version === 2 ||
        input.method === 'RANKED_THEN_DRAWN' ||
        input.method === 'BY_ENTRY_ATTRIBUTE' ||
        (input.overrides ?? []).length > 0 ||
        input.source !== undefined;
      let order: string[];
      let drawSeed: string | null = null;
      let seedingHash: string;
      let document: Record<string, unknown> | null = null;
      if (v2) {
        drawSeed = input.method === 'MANUAL' ? null : randomBytes(32).toString('hex');
        let attributeValues: Map<string, string> | undefined;
        let attributeType: ReturnType<typeof attributeTypeOf> = undefined;
        if (input.method === 'BY_ENTRY_ATTRIBUTE') {
          const spec = await disciplineSpec(ctx, e.disciplineVersionId);
          attributeType = attributeTypeOf(spec, input.attributeKey);
          if (attributeType === undefined || attributeType === 'TEXT')
            throw new DomainError(
              DomainErrorCode.INVALID_INPUT,
              'seed by a numeric PARTICIPANT entry attribute the discipline declares',
            );
          attributeValues = await frozenAttribute(ctx, e.id, input.attributeKey as string);
        }
        let doc;
        try {
          doc = computeSeeding({
            eventId: e.id,
            fieldHash,
            participantIds: ids,
            request: {
              method: input.method,
              ...(input.order === undefined ? {} : { order: input.order }),
              ...(input.seeds === undefined ? {} : { seeds: input.seeds }),
              ...(input.banded === undefined ? {} : { banded: input.banded }),
              ...(input.attributeKey === undefined ? {} : { attributeKey: input.attributeKey }),
              ...(input.direction === undefined ? {} : { direction: input.direction }),
              ...(input.source === undefined ? {} : { source: input.source }),
              ...(input.overrides === undefined ? {} : { overrides: input.overrides }),
            },
            ...(drawSeed === null ? {} : { drawSeed }),
            ...(attributeValues === undefined ? {} : { attributeValues }),
            ...(attributeType === undefined ? {} : { attributeType }),
          });
        } catch (err) {
          if (err instanceof SeedingError)
            throw new DomainError(DomainErrorCode.INVALID_INPUT, err.message, {
              reason: err.reason,
            });
          throw err;
        }
        order = [...doc.order];
        try {
          seedingHash = seedingHashV2(doc);
        } catch {
          throw new DomainError(
            DomainErrorCode.INVALID_INPUT,
            'invalid seeding document (check labels and dates)',
          );
        }
        document = doc as unknown as Record<string, unknown>;
      } else {
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
          method: input.method as 'MANUAL' | 'DETERMINISTIC_DRAW',
          ...(drawSeed === null ? {} : { drawAlgorithm: DRAW_ALGORITHM, drawSeed }),
          order,
        };
        seedingHash = computeSeedingHash(doc);
      }
      await sql`INSERT INTO competition.event_seeding (event_id, field_hash, method, draw_algorithm, draw_seed, seed_order, seeding_hash,
                  seeded_by_account_id, seeding_version, seeding_document, recorded_at)
        VALUES (${e.id}, ${fieldHash}, ${input.method}, ${drawSeed === null ? null : DRAW_ALGORITHM}, ${drawSeed}, ${order}::uuid[], ${seedingHash},
                ${input.actorAccountId}, ${v2 ? 2 : 1}, ${document === null ? null : JSON.stringify(document)}::jsonb, ${ctx.txTime})`.execute(
        ctx.trx,
      );
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
        details: {
          method: input.method,
          ...(v2 ? { seedingVersion: 2, overrides: (input.overrides ?? []).length } : {}),
        },
      });
      for (const o of input.overrides ?? [])
        await recordAudit(ctx, {
          actorAccountId: input.actorAccountId,
          action: 'event.seeding.override',
          targetType: 'EVENT',
          targetId: e.id,
          details: { participantId: o.participantId, toPosition: o.toPosition, reason: o.reason },
        });
      const response = {
        method: input.method,
        seedOrder: order,
        drawSeed,
        seedingHash,
        seedingVersion: (v2 ? 2 : 1) as 1 | 2,
      };
      await idem.record(response);
      return { ...response, created: true };
    });
  }

  // ───────────────────────────── entry attributes (ONCF-05B) ─────────────────────────────

  /**
   * Declares entry attributes on a registration before the field locks (ADR-0056): entry time,
   * average, handicap index, bib, classification points… Only keys the pinned v2 DisciplineVersion
   * declares, typed and bounded by it; MEMBER-scope values name an ACTIVE team member. A NULL value
   * clears a key. The entrant (athlete controller / team manager) or an organizer with
   * COMP_MANAGE_REGISTRATIONS may declare. Values are DECLARED, never verified; the field lock
   * freezes and hashes them. Audit records keys only, never values.
   */
  async declareEntryAttributes(input: {
    actorAccountId: string;
    registrationId: string;
    attributes: readonly { key: string; value: string | null; athleteId?: string }[];
    idempotencyKey: string;
  }): Promise<{ registrationId: string; declared: number; created: boolean }> {
    if (input.attributes.length === 0 || input.attributes.length > 64)
      throw new DomainError(DomainErrorCode.INVALID_INPUT, 'declare 1–64 attribute values');
    const attrs = input.attributes.map((a) => ({
      key: a.key,
      value: a.value,
      athleteId: a.athleteId === undefined ? null : a.athleteId.toLowerCase(),
    }));
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ registrationId: string; declared: number }>(ctx, {
        command: 'DeclareEntryAttributes',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { registrationId: input.registrationId, attrs },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      await lockKeys(ctx, `registration:${input.registrationId}`);
      const { rows } = await sql<{
        event_id: string;
        athlete_id: string | null;
        team_id: string | null;
        status: string;
      }>`
        SELECT r.event_id, r.athlete_id, r.team_id, v.status FROM competition.registration r
        JOIN competition.v_registration_current v ON v.registration_id = r.id WHERE r.id = ${input.registrationId}`.execute(
        ctx.trx,
      );
      const r = rows[0];
      if (r === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'registration not found');
      const e = await loadEvent(ctx, r.event_id);
      if (!(await this.entrantControl(ctx, input.actorAccountId, r)))
        await requireCompPermission(
          ctx,
          input.actorAccountId,
          await loadCompetition(ctx, e.competitionId),
          'COMP_MANAGE_REGISTRATIONS',
        );
      if (!['DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED'].includes(e.status))
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          'entry attributes are frozen once the field is locked',
        );
      if (!['REQUESTED', 'WAITLISTED', 'CONFIRMED'].includes(r.status))
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          `the registration is ${r.status}`,
        );
      const spec = await disciplineSpec(ctx, e.disciplineVersionId);
      const declared = new Map((spec.entryAttributes ?? []).map((a) => [a.key, a]));
      const members = r.team_id === null ? [] : await activeTeamMembers(ctx, r.team_id, ctx.txTime);
      for (const a of attrs) {
        const d = declared.get(a.key);
        if (d === undefined)
          throw new DomainError(
            DomainErrorCode.INVALID_INPUT,
            `this discipline does not declare ${a.key}`,
          );
        if (d.scope === 'MEMBER' && (a.athleteId === null || !members.includes(a.athleteId)))
          throw new DomainError(
            DomainErrorCode.INVALID_INPUT,
            `${a.key} is declared per active team member`,
          );
        if (d.scope === 'PARTICIPANT' && a.athleteId !== null)
          throw new DomainError(DomainErrorCode.INVALID_INPUT, `${a.key} is declared per entrant`);
        if (
          a.value !== null &&
          !validEntryAttributeValue(d.valueType, a.value, {
            ...(d.min === undefined ? {} : { min: d.min }),
            ...(d.max === undefined ? {} : { max: d.max }),
          })
        )
          throw new DomainError(DomainErrorCode.INVALID_INPUT, `invalid value for ${a.key}`);
      }
      for (const a of attrs)
        await sql`INSERT INTO competition.registration_entry_attribute (id, registration_id, event_id, attribute_key, athlete_id, value, declared_by_account_id, recorded_at)
          VALUES (${newId()}, ${input.registrationId}, ${r.event_id}, ${a.key}, ${a.athleteId}, ${a.value}, ${input.actorAccountId}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'registration.entry-attributes',
        targetType: 'REGISTRATION',
        targetId: input.registrationId,
        details: { keys: [...new Set(attrs.map((a) => a.key))].sort() },
      });
      const response = { registrationId: input.registrationId, declared: attrs.length };
      await idem.record(response);
      return { ...response, created: true };
    });
  }

  /** Current declared entry attributes of a registration (entrant or COMP_VIEW_PRIVATE staff). */
  async entryAttributes(input: { actorAccountId: string; registrationId: string }) {
    return this.tx(async (ctx) => {
      const { rows } = await sql<{
        event_id: string;
        athlete_id: string | null;
        team_id: string | null;
      }>`
        SELECT event_id, athlete_id, team_id FROM competition.registration WHERE id = ${input.registrationId}`.execute(
        ctx.trx,
      );
      const r = rows[0];
      if (r === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'registration not found');
      if (!(await this.entrantControl(ctx, input.actorAccountId, r))) {
        const e = await loadEvent(ctx, r.event_id);
        await requireCompPermission(
          ctx,
          input.actorAccountId,
          await loadCompetition(ctx, e.competitionId),
          'COMP_VIEW_PRIVATE',
        );
      }
      const { rows: values } = await sql<{
        attribute_key: string;
        athlete_id: string | null;
        value: string;
      }>`
        SELECT attribute_key, athlete_id, value FROM competition.v_registration_entry_attribute_current
        WHERE registration_id = ${input.registrationId} ORDER BY attribute_key, athlete_id NULLS FIRST`.execute(
        ctx.trx,
      );
      return values.map((v) => ({
        key: v.attribute_key,
        value: v.value,
        ...(v.athlete_id === null ? {} : { athleteId: v.athlete_id }),
      }));
    });
  }

  // ───────────────────────────── organizer structure reads (ONCF-05B) ─────────────────────────────

  /**
   * Readiness checklist (ONCF-05A §16.2): DERIVED from facts, never a lifecycle state. Reports what
   * exists (field, roster snapshot, seeding, plan, schedule) and what blocks the next step. The
   * `IN_PROGRESS` precondition is unchanged (a plan exists); a complete schedule is only a warning.
   */
  readiness(input: { actorAccountId: string; eventId: string }) {
    return this.tx(async (ctx) => {
      const e = await loadEvent(ctx, input.eventId);
      await requireCompPermission(
        ctx,
        input.actorAccountId,
        await loadCompetition(ctx, e.competitionId),
        'COMP_VIEW_PRIVATE',
      );
      const { rows } = await sql<{
        field_version: number | null;
        participants: number | null;
        seeding_method: string | null;
        seeding_version: number | null;
        overrides: number | null;
        engine: string | null;
        plan_version: number | null;
        stages: number;
        contests: number;
        scheduled: number;
        dynamic_rounds: number;
        rosters: number;
        team_participants: number;
        attributes: number;
      }>`
        SELECT f.field_version, f.participant_count AS participants,
               sd.method AS seeding_method, sd.seeding_version,
               coalesce(jsonb_array_length(sd.seeding_document -> 'overrides'), 0) AS overrides,
               CASE WHEN pl.event_id IS NULL THEN NULL ELSE pl.engine_id || '/' || pl.engine_version END AS engine,
               pl.plan_version,
               (SELECT count(*)::int FROM competition.stage s WHERE s.event_id = e.id) AS stages,
               (SELECT count(*)::int FROM competition.contest c WHERE c.event_id = e.id) AS contests,
               (SELECT count(*)::int FROM competition.contest c JOIN competition.contest_schedule cs ON cs.contest_id = c.id WHERE c.event_id = e.id) AS scheduled,
               (SELECT count(*)::int FROM competition.round r WHERE r.event_id = e.id AND r.dynamic_transition_key IS NOT NULL) AS dynamic_rounds,
               (SELECT count(DISTINCT m.participant_id)::int FROM competition.participant_roster_member m JOIN competition.participant p ON p.id = m.participant_id WHERE p.event_id = e.id) AS rosters,
               (SELECT count(*)::int FROM competition.participant p WHERE p.event_id = e.id AND p.participant_kind = 'TEAM') AS team_participants,
               (SELECT count(*)::int FROM competition.participant_entry_attribute a JOIN competition.participant p ON p.id = a.participant_id WHERE p.event_id = e.id) AS attributes
        FROM competition.event e
        LEFT JOIN competition.event_field f ON f.event_id = e.id
        LEFT JOIN competition.event_seeding sd ON sd.event_id = e.id
        LEFT JOIN competition.event_plan pl ON pl.event_id = e.id
        WHERE e.id = ${e.id}`.execute(ctx.trx);
      const r = rows[0];
      if (r === undefined) throw new DomainError(DomainErrorCode.NOT_FOUND, 'event not found');
      const blockers: string[] = [];
      const warnings: string[] = [];
      if (r.field_version === null) blockers.push('FIELD_NOT_LOCKED');
      else if (r.seeding_method === null) blockers.push('NOT_SEEDED');
      else if (r.engine === null) blockers.push('NO_PLAN');
      if (r.engine !== null && r.scheduled < r.contests) warnings.push('CONTESTS_UNSCHEDULED');
      if (r.dynamic_rounds > 0) warnings.push('ROUNDS_AWAIT_ADVANCEMENT');
      // ONCF-05C: the generated stages and their groups (for per-stage classification views).
      const { rows: stageRows } = await sql<{
        key: string;
        label: string;
        primitive: string;
        groups: string[] | null;
      }>`
        SELECT st.plan_key AS key, st.label, st.primitive,
               (SELECT array_agg(DISTINCT r.group_key ORDER BY r.group_key) FROM competition.round r
                 WHERE r.stage_id = st.id AND r.group_key IS NOT NULL) AS groups
        FROM competition.stage st WHERE st.event_id = ${e.id} ORDER BY st.sequence`.execute(
        ctx.trx,
      );
      return {
        stageList: stageRows.map((x) => ({
          key: x.key,
          label: x.label,
          primitive: x.primitive,
          groups: x.groups ?? [],
        })),
        eventId: e.id,
        status: e.status,
        fieldLocked: r.field_version !== null,
        fieldVersion: r.field_version,
        participants: r.participants ?? 0,
        rosterSnapshot:
          r.field_version === 2 ? { teams: r.team_participants, snapshotted: r.rosters } : null,
        entryAttributesFrozen: r.attributes,
        seeded: r.seeding_method !== null,
        seeding:
          r.seeding_method === null
            ? null
            : { method: r.seeding_method, version: r.seeding_version, overrides: r.overrides ?? 0 },
        planGenerated: r.engine !== null,
        plan:
          r.engine === null
            ? null
            : {
                engine: r.engine,
                planVersion: r.plan_version,
                stages: r.stages,
                contests: r.contests,
                dynamicRounds: r.dynamic_rounds,
              },
        contestsScheduled: { scheduled: r.scheduled, total: r.contests },
        blockers,
        warnings,
      };
    });
  }

  /**
   * The locked field for organizers (COMP_VIEW_PRIVATE): participants with their entrant ids, seed
   * position, roster size and FROZEN entry attributes (seeding inputs). Never public — declared
   * values such as classification points or handicaps are not published by ONCF-05B.
   */
  lockedField(input: { actorAccountId: string; eventId: string }) {
    return this.tx(async (ctx) => {
      const e = await loadEvent(ctx, input.eventId);
      await requireCompPermission(
        ctx,
        input.actorAccountId,
        await loadCompetition(ctx, e.competitionId),
        'COMP_VIEW_PRIVATE',
      );
      const { rows } = await sql<{
        id: string;
        registration_id: string;
        participant_kind: 'INDIVIDUAL' | 'TEAM';
        athlete_id: string | null;
        team_id: string | null;
        team_name: string | null;
        status: string;
        seed: number | null;
        roster: number;
      }>`
        SELECT p.id, p.registration_id, p.participant_kind, p.athlete_id, p.team_id, tp.display_name AS team_name, v.status,
               (SELECT array_position(sd.seed_order, p.id) FROM competition.event_seeding sd WHERE sd.event_id = p.event_id) AS seed,
               (SELECT count(*)::int FROM competition.participant_roster_member m WHERE m.participant_id = p.id) AS roster
        FROM competition.participant p
        JOIN competition.v_participant_current v ON v.participant_id = p.id
        LEFT JOIN competition.team_profile tp ON tp.team_id = p.team_id
        WHERE p.event_id = ${e.id} ORDER BY seed NULLS LAST, p.id`.execute(ctx.trx);
      const { rows: attrs } = await sql<{
        participant_id: string;
        attribute_key: string;
        athlete_id: string | null;
        value: string;
      }>`
        SELECT a.participant_id, a.attribute_key, a.athlete_id, a.value FROM competition.participant_entry_attribute a
        JOIN competition.participant p ON p.id = a.participant_id WHERE p.event_id = ${e.id}
        ORDER BY a.attribute_key, a.athlete_id NULLS FIRST`.execute(ctx.trx);
      return rows.map((p) => ({
        participantId: p.id,
        registrationId: p.registration_id,
        kind: p.participant_kind,
        athleteId: p.athlete_id,
        teamId: p.team_id,
        teamName: p.team_name,
        status: p.status,
        seed: p.seed,
        rosterSize: p.participant_kind === 'TEAM' ? p.roster : null,
        attributes: attrs
          .filter((a) => a.participant_id === p.id)
          .map((a) => ({
            key: a.attribute_key,
            value: a.value,
            ...(a.athlete_id === null ? {} : { athleteId: a.athlete_id }),
          })),
      }));
    });
  }

  /**
   * Preview of the plan the pinned engine WOULD generate from the current seeding (COMP_VIEW_PRIVATE).
   * Pure: nothing is persisted, hashed into the event or audited; generation stays the single,
   * immutable command. Returns a structural summary (stages, rounds, counts), not the document.
   */
  previewPlan(input: { actorAccountId: string; eventId: string }) {
    return this.tx(async (ctx) => {
      const e = await loadEvent(ctx, input.eventId);
      await requireCompPermission(
        ctx,
        input.actorAccountId,
        await loadCompetition(ctx, e.competitionId),
        'COMP_VIEW_PRIVATE',
      );
      const { rows: sd } = await sql<{ seed_order: string[] }>`
        SELECT seed_order FROM competition.event_seeding WHERE event_id = ${e.id}`.execute(ctx.trx);
      if (sd[0] === undefined)
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          'seed the field before previewing the plan',
        );
      const spec = await disciplineSpec(ctx, e.disciplineVersionId);
      const { rows: fv } = await sql<{ engine_id: string; engine_version: number }>`
        SELECT engine_id, engine_version FROM sports.format_version WHERE id = ${e.formatVersionId}`.execute(
        ctx.trx,
      );
      const engine =
        fv[0] === undefined ? undefined : formatEngine(fv[0].engine_id, fv[0].engine_version);
      if (engine === undefined)
        throw new DomainError(DomainErrorCode.INVALID_INPUT, 'format engine is not available');
      const participants = await fieldParticipants(ctx, e.id);
      const engineInput = {
        eventId: e.id,
        participants: participants.map((p) => ({ participantId: p.participantId, kind: p.kind })),
        seedOrder: sd[0].seed_order,
        config: e.formatConfig,
        allowedContestTypes: spec.allowedContestTypes,
      };
      try {
        if (engine.planVersion === 2) {
          const plan = engine.generate(engineInput);
          return {
            engine: `${engine.id}/${engine.version}`,
            planVersion: 2 as const,
            stages: plan.stages.map((s) => ({
              key: s.key,
              label: s.label,
              primitive: s.primitive,
              partitionKind: s.partition?.kind ?? null,
            })),
            transitions: plan.transitions.map((t) => ({
              key: t.key,
              kind: t.kind,
              fromStage: t.fromStage,
              toStage: t.toStage,
            })),
            rounds: plan.rounds.map((r) => ({
              key: r.key,
              label: r.label,
              roundType: r.roundType,
              stageKey: r.stageKey,
              groupKey: r.groupKey ?? null,
              dynamic: r.dynamicEntry !== undefined,
              contests: r.contests.length,
              entries: r.contests.reduce((n, c) => n + (c.entries?.length ?? 0), 0),
            })),
            contests: plan.rounds.reduce((n, r) => n + r.contests.length, 0),
          };
        }
        const plan = engine.generate(engineInput);
        return {
          engine: `${engine.id}/${engine.version}`,
          planVersion: 1 as const,
          stages: [],
          transitions: [],
          rounds: plan.rounds.map((r) => ({
            key: r.key,
            label: r.label,
            roundType: r.roundType,
            stageKey: null,
            groupKey: null,
            dynamic: false,
            contests: r.contests.length,
            entries: 0,
          })),
          contests: plan.rounds.reduce((n, r) => n + r.contests.length, 0),
        };
      } catch (err) {
        if (err instanceof FormatEngineError)
          throw new DomainError(DomainErrorCode.INVALID_INPUT, err.message, { reason: err.reason });
        throw err;
      }
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
      if (engine.planVersion === 2) {
        const gaps = capabilityIssues(providedCapabilities(dv.spec), engineRequirements(engine));
        if (gaps.length > 0)
          throw new DomainError(
            DomainErrorCode.INVALID_INPUT,
            `the discipline does not provide what this format requires: ${gaps.map((g) => g.message).join('; ')}`,
            { reason: 'CAPABILITY_MISMATCH' },
          );
      }
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
      const inputHash =
        engine.planVersion === 2 ? planInputHashV2(inputDoc) : computePlanInputHash(inputDoc);
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

      if (engine.planVersion === 2) {
        let planV2;
        try {
          planV2 = engine.generate({
            eventId: e.id,
            participants: participants.map((p) => ({
              participantId: p.participantId,
              kind: p.kind,
            })),
            seedOrder: sd.seed_order,
            config: e.formatConfig,
            allowedContestTypes: dv.spec.allowedContestTypes,
          });
        } catch (err) {
          if (err instanceof FormatEngineError)
            throw new DomainError(DomainErrorCode.INVALID_INPUT, err.message, {
              reason: err.reason,
            });
          throw err;
        }
        const planHash = planHashV2(planV2);
        await sql`INSERT INTO competition.event_plan (event_id, engine_id, engine_version, input_hash, plan_hash, plan_document, generated_by_account_id, plan_version, recorded_at)
          VALUES (${e.id}, ${engine.id}, ${engine.version}, ${inputHash}, ${planHash}, ${JSON.stringify(planV2)}::jsonb, ${input.actorAccountId}, 2, ${ctx.txTime})`.execute(
          ctx.trx,
        );
        const contests = await materializePlanV2(ctx, e.id, input.actorAccountId, planV2);
        await refreshEventReadModels(ctx, e.id);
        await emitEvent(ctx, {
          eventType: 'EventPlanGenerated',
          aggregateType: 'EVENT',
          aggregateId: e.id as Uuid,
          payload: {
            engine: engineRef,
            inputHash,
            planHash,
            rounds: planV2.rounds.length,
            contests,
          },
        });
        await recordAudit(ctx, {
          actorAccountId: input.actorAccountId,
          action: 'event.plan-generated',
          targetType: 'EVENT',
          targetId: e.id,
          details: { engine: engineRef, planVersion: 2 },
        });
        const response = {
          planHash,
          inputHash,
          engine: engineRef,
          rounds: planV2.rounds.length,
          contests,
        };
        await idem.record(response);
        return { ...response, created: true };
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
  async startContest(input: { actorAccountId: string; contestId: string }): Promise<void> {
    const stale = this.startGuard === undefined ? [] : await this.startGuard(input.contestId);
    if (stale.length > 0)
      throw new DomainError(
        DomainErrorCode.INVALID_TRANSITION,
        'an entrant of this contest no longer follows from the current official results; re-resolve advancement first',
        { reason: 'ADVANCEMENT_STALE', targets: stale.slice(0, 20) },
      );
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
        // ONCF-05D: a dependent place counts once a committed advancement fact fills it; a dynamic
        // round's contest needs its committed field.
        const { rows } = await sql<{ unready: number; places: number }>`
          SELECT count(*) FILTER (WHERE pv.status IS DISTINCT FROM 'ACTIVE')::int AS unready, count(*)::int AS places
          FROM competition.v_contest_occupant o
          LEFT JOIN competition.v_participant_current pv ON pv.participant_id = o.participant_id
          WHERE o.contest_id = ${contestId}`.execute(ctx.trx);
        const { rows: dyn } = await sql<{ dynamic: boolean; entries: number }>`
          SELECT r.dynamic_transition_key IS NOT NULL AS dynamic,
                 (SELECT count(*)::int FROM competition.contest_entry ce WHERE ce.contest_id = c.id) AS entries
          FROM competition.contest c JOIN competition.round r ON r.id = c.round_id WHERE c.id = ${contestId}`.execute(
          ctx.trx,
        );
        const emptyDynamic =
          dyn[0]?.dynamic === true && (rows[0]?.places ?? 0) === 0 && (dyn[0]?.entries ?? 0) === 0;
        if ((rows[0]?.unready ?? 1) > 0 || emptyDynamic) {
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
      const participation = dv[0]?.spec.participation;
      const size = participation?.lineupSize ?? { min: 1, max: 1 };
      if (athletes.length < size.min || athletes.length > size.max) {
        throw new DomainError(
          DomainErrorCode.INVALID_INPUT,
          `a lineup must field ${size.min}–${size.max} athletes`,
        );
      }
      // ONCF-05B (ADR-0057): a v2 field validates against the roster frozen at lock; v1 fields keep
      // the BRT-05 rule (ACTIVE members at submission time).
      const eligible =
        p.athlete_id !== null
          ? [p.athlete_id]
          : ((await frozenRoster(ctx, input.participantId)) ??
            (await activeTeamMembers(ctx, p.team_id as string, ctx.txTime)));
      const ineligible = athletes.filter((a) => !eligible.includes(a.athleteId));
      if (ineligible.length > 0) {
        throw new DomainError(
          DomainErrorCode.INVALID_INPUT,
          p.athlete_id !== null
            ? 'an individual participant fields exactly its own athlete'
            : 'every lineup athlete must be on the team roster',
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
      for (const [i, a] of athletes.entries()) {
        await sql`INSERT INTO competition.lineup_member (lineup_id, athlete_id, member_role, ordinal, recorded_at)
          VALUES (${lineupId}, ${a.athleteId}, ${a.role}, ${participation?.lineupOrdered === true ? i + 1 : null}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
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

function attributeTypeOf(spec: DisciplineVersionSpec, key: string | undefined) {
  const a = (spec.entryAttributes ?? []).find((x) => x.key === key && x.scope === 'PARTICIPANT');
  return a?.valueType;
}

function isFinished(status: string): boolean {
  return status === 'COMPLETED' || status === 'CANCELLED';
}
