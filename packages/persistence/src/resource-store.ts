import {
  effectiveAvailability,
  isResourceAvailable,
  occupancyOf,
  OCCUPANCY_MODES,
  RESOURCE_TYPE_DEFAULT_OCCUPANCY_MODE,
  validateAvailabilityFact,
  validateResource,
  type AvailabilityFact,
  type AvailabilityLayer,
  type OccupancyMode,
  type ResourceType,
} from '@br/competition';
import { DomainError, DomainErrorCode, newId, type Uuid } from '@br/domain';
import { sql } from 'kysely';
import {
  instantOrThrow,
  loadCompetition,
  requireCompPermission,
  text,
} from './competition-support';
import type { Db } from './db';
import { identityIdempotency, lockKeys, recordAudit } from './identity-support';
import { emitEvent } from './outbox';
import { inTransaction, ModuleRole, type TxContext } from './tx';

/**
 * ONCF-05E-A resources and availability (ADR-0067, ADR-0068). Competition-scoped, generic, data-typed
 * resources with append-only revisions, and append-only availability facts with explicit
 * revocation. Reads need COMP_VIEW_PRIVATE; every change needs COMP_EDIT (never a scheduling
 * permission). Evaluation answers only "is the resource intrinsically available?" — schedules,
 * participants and dependencies are later 05E phases. Domain rules (validation, precedence, time
 * conversion, intervals) live in @br/competition; this store only persists and authorizes.
 */

const CLOSED_COMPETITION = ['COMPLETED', 'CANCELLED'];
const MAX_RANGE_DAYS = 400;
const DAY = 86_400_000;

export interface ResourceInput {
  readonly label: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly capacity?: number;
  /** Declared simultaneous occupancy (ADR-0073 B2). Omitted: the type default on create, the current value on revise. */
  readonly occupancyMode?: OccupancyMode;
  readonly exclusivityKeys?: readonly string[];
  readonly venueOrganizationId?: string | null;
  readonly locationLabel?: string | null;
  readonly timezone?: string | null;
}

export type AvailabilityInputFact =
  | {
      kind: 'WEEKLY';
      weekday: number;
      start: string;
      end: string;
      validFrom?: string;
      validTo?: string;
    }
  | { kind: 'DATE_OPEN'; date: string; start: string; end: string }
  | { kind: 'DATE_CLOSED'; date: string }
  | { kind: 'BLACKOUT' | 'MAINTENANCE'; startsAt: string; endsAt: string; reason: string };

interface CurrentRow {
  resource_id: string;
  competition_id: string;
  type_code: string;
  revision: number;
  label: string;
  attributes: Record<string, unknown>;
  capacity: number;
  exclusivity_keys: string[];
  venue_organization_id: string | null;
  location_label: string | null;
  timezone: string | null;
  status: 'ACTIVE' | 'RETIRED';
  recorded_at: Date;
  occupancy_mode: OccupancyMode;
  revision_id: string;
}

interface FactRow {
  id: string;
  resource_id: string | null;
  kind: AvailabilityFact['kind'];
  weekday: number | null;
  local_date: string | null;
  local_start: string | null;
  local_end: string | null;
  valid_from: string | null;
  valid_to: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  reason: string | null;
  recorded_at: Date;
}

const view = (r: CurrentRow) => ({
  resourceId: r.resource_id,
  competitionId: r.competition_id,
  typeCode: r.type_code,
  revision: r.revision,
  label: r.label,
  attributes: r.attributes,
  capacity: r.capacity,
  // The scheduling semantic (ADR-0073 B2): declared, stored, never derived from capacity.
  occupancyMode: r.occupancy_mode,
  // Legacy 05E-A label kept for compatibility: descriptive only, derived from capacity. Conflict and
  // proposal engines must never read it.
  occupancy: occupancyOf(r),
  exclusivityKeys: r.exclusivity_keys,
  venueOrganizationId: r.venue_organization_id,
  locationLabel: r.location_label,
  timezone: r.timezone,
  status: r.status,
  updatedAt: r.recorded_at.toISOString(),
});

function toFact(r: FactRow): AvailabilityFact {
  switch (r.kind) {
    case 'WEEKLY':
      return {
        kind: 'WEEKLY',
        weekday: r.weekday as number,
        start: r.local_start as string,
        end: r.local_end as string,
        ...(r.valid_from === null ? {} : { validFrom: r.valid_from }),
        ...(r.valid_to === null ? {} : { validTo: r.valid_to }),
      };
    case 'DATE_OPEN':
      return {
        kind: 'DATE_OPEN',
        date: r.local_date as string,
        start: r.local_start as string,
        end: r.local_end as string,
      };
    case 'DATE_CLOSED':
      return { kind: 'DATE_CLOSED', date: r.local_date as string };
    default:
      return {
        kind: r.kind,
        startsAt: (r.starts_at as Date).getTime(),
        endsAt: (r.ends_at as Date).getTime(),
        reason: r.reason as string,
      };
  }
}

const factView = (r: FactRow) => ({
  availabilityId: r.id,
  scope: r.resource_id === null ? ('COMPETITION' as const) : ('RESOURCE' as const),
  resourceId: r.resource_id,
  kind: r.kind,
  ...(r.weekday === null ? {} : { weekday: r.weekday }),
  ...(r.local_date === null ? {} : { date: r.local_date }),
  ...(r.local_start === null ? {} : { start: r.local_start, end: r.local_end }),
  ...(r.valid_from === null ? {} : { validFrom: r.valid_from }),
  ...(r.valid_to === null ? {} : { validTo: r.valid_to }),
  ...(r.starts_at === null
    ? {}
    : { startsAt: r.starts_at.toISOString(), endsAt: (r.ends_at as Date).toISOString() }),
  ...(r.reason === null ? {} : { reason: r.reason }),
  recordedAt: r.recorded_at.toISOString(),
});

function issuesError(
  message: string,
  issues: readonly { path: string; message: string }[],
): DomainError {
  return new DomainError(DomainErrorCode.INVALID_INPUT, message, { issues: issues.slice(0, 20) });
}

export class ResourceStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private tx<T>(fn: (ctx: TxContext) => Promise<T>): Promise<T> {
    return inTransaction(this.db, ModuleRole.competition, fn);
  }

  private async competition(
    ctx: TxContext,
    actor: string,
    competitionId: string,
    permission: 'COMP_VIEW_PRIVATE' | 'COMP_EDIT',
  ) {
    if (!/^[0-9a-f-]{36}$/.test(competitionId))
      throw new DomainError(DomainErrorCode.NOT_FOUND, 'competition not found');
    const c = await loadCompetition(ctx, competitionId);
    await requireCompPermission(ctx, actor, c, permission);
    if (permission === 'COMP_EDIT' && CLOSED_COMPETITION.includes(c.status))
      throw new DomainError(
        DomainErrorCode.INVALID_TRANSITION,
        `resources are closed for a ${c.status} competition`,
      );
    return c;
  }

  private async current(ctx: TxContext, resourceId: string): Promise<CurrentRow> {
    if (!/^[0-9a-f-]{36}$/.test(resourceId))
      throw new DomainError(DomainErrorCode.NOT_FOUND, 'resource not found');
    const { rows } =
      await sql<CurrentRow>`SELECT * FROM competition.v_resource_current WHERE resource_id = ${resourceId}`.execute(
        ctx.trx,
      );
    const r = rows[0];
    if (r === undefined) throw new DomainError(DomainErrorCode.NOT_FOUND, 'resource not found');
    return r;
  }

  /** Validated resource fields (domain rules) + venue check; labels unique among ACTIVE resources. */
  private async checked(
    ctx: TxContext,
    competitionId: string,
    typeCode: string,
    input: ResourceInput,
    except?: string,
    currentMode?: OccupancyMode,
  ) {
    if (input.occupancyMode !== undefined && !OCCUPANCY_MODES.includes(input.occupancyMode))
      throw issuesError('the resource is not valid', [
        { path: '/occupancyMode', message: `one of ${OCCUPANCY_MODES.join(', ')}` },
      ]);
    const spec = {
      typeCode,
      label: input.label,
      attributes: input.attributes ?? {},
      capacity: input.capacity ?? 1,
      exclusivityKeys: [...(input.exclusivityKeys ?? [])].sort(),
      ...(input.timezone === undefined || input.timezone === null
        ? {}
        : { timezone: input.timezone }),
    };
    const issues = validateResource(spec);
    if (issues.length > 0) throw issuesError('the resource is not valid', issues);
    const location =
      input.locationLabel === undefined || input.locationLabel === null
        ? null
        : text(input.locationLabel, 120, 'locationLabel');
    if (input.venueOrganizationId !== undefined && input.venueOrganizationId !== null) {
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
    const { rows: dup } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM competition.v_resource_current
      WHERE competition_id = ${competitionId} AND status = 'ACTIVE' AND lower(label) = lower(${spec.label})
        AND resource_id IS DISTINCT FROM ${except ?? null}::uuid`.execute(ctx.trx);
    if ((dup[0]?.n ?? 0) > 0)
      throw new DomainError(
        DomainErrorCode.ALREADY_EXISTS,
        'another active resource of this competition has that label',
        { reason: 'DUPLICATE_LABEL' },
      );
    const occupancyMode =
      input.occupancyMode ??
      currentMode ??
      RESOURCE_TYPE_DEFAULT_OCCUPANCY_MODE[typeCode as ResourceType];
    return {
      ...spec,
      occupancyMode,
      location,
      venue: input.venueOrganizationId ?? null,
      timezone: input.timezone ?? null,
    };
  }

  private async insertRevision(
    ctx: TxContext,
    resourceId: string,
    revision: number,
    f: Awaited<ReturnType<ResourceStore['checked']>>,
    status: 'ACTIVE' | 'RETIRED',
    reason: string | null,
    actor: string,
  ) {
    await sql`INSERT INTO competition.resource_revision
        (id, resource_id, revision, label, attributes, capacity, occupancy_mode, exclusivity_keys, venue_organization_id,
         location_label, timezone, status, reason, actor_account_id, recorded_at)
      VALUES (${newId()}, ${resourceId}, ${revision}, ${f.label}, ${JSON.stringify(f.attributes)}::jsonb, ${f.capacity},
              ${f.occupancyMode}, ${f.exclusivityKeys}::text[], ${f.venue}, ${f.location}, ${f.timezone}, ${status}, ${reason},
              ${actor}, ${ctx.txTime})`.execute(ctx.trx);
  }

  // ───────────────────────────── resources ─────────────────────────────

  async createResource(input: {
    actorAccountId: string;
    competitionId: string;
    typeCode: string;
    resource: ResourceInput;
    idempotencyKey: string;
  }) {
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ resourceId: string }>(ctx, {
        command: 'CreateResource',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: {
          competitionId: input.competitionId,
          typeCode: input.typeCode,
          resource: input.resource,
        },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      await this.competition(ctx, input.actorAccountId, input.competitionId, 'COMP_EDIT');
      await lockKeys(ctx, `competition-resources:${input.competitionId}`);
      const f = await this.checked(ctx, input.competitionId, input.typeCode, input.resource);
      const resourceId = newId();
      await sql`INSERT INTO competition.resource (id, competition_id, type_code, created_by_account_id, recorded_at)
        VALUES (${resourceId}, ${input.competitionId}, ${input.typeCode}, ${input.actorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await this.insertRevision(ctx, resourceId, 1, f, 'ACTIVE', null, input.actorAccountId);
      await emitEvent(ctx, {
        eventType: 'ResourceCreated',
        aggregateType: 'RESOURCE',
        aggregateId: resourceId as Uuid,
        payload: { competitionId: input.competitionId, typeCode: input.typeCode },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'resource.created',
        targetType: 'RESOURCE',
        targetId: resourceId,
        details: {
          competitionId: input.competitionId,
          typeCode: input.typeCode,
          capacity: f.capacity,
          occupancyMode: f.occupancyMode,
        },
      });
      await idem.record({ resourceId });
      return { resourceId, created: true };
    });
  }

  /** A new revision with the given fields (the type never changes; status is unchanged). */
  async reviseResource(input: {
    actorAccountId: string;
    resourceId: string;
    resource: ResourceInput;
    idempotencyKey: string;
  }) {
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ resourceId: string; revision: number }>(ctx, {
        command: 'ReviseResource',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { resourceId: input.resourceId, resource: input.resource },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      const before = await this.current(ctx, input.resourceId);
      await this.competition(ctx, input.actorAccountId, before.competition_id, 'COMP_EDIT');
      await lockKeys(ctx, `competition-resources:${before.competition_id}`);
      const now = await this.current(ctx, input.resourceId);
      const f = await this.checked(
        ctx,
        now.competition_id,
        now.type_code,
        input.resource,
        now.resource_id,
        now.occupancy_mode,
      );
      await this.insertRevision(
        ctx,
        now.resource_id,
        now.revision + 1,
        f,
        now.status,
        null,
        input.actorAccountId,
      );
      const changed: string[] = (['label', 'capacity'] as const).filter((k) => f[k] !== now[k]);
      if (f.occupancyMode !== now.occupancy_mode) changed.push('occupancyMode');
      if (JSON.stringify(f.attributes) !== JSON.stringify(now.attributes))
        changed.push('attributes');
      if (f.exclusivityKeys.join() !== [...now.exclusivity_keys].sort().join())
        changed.push('exclusivityKeys');
      await emitEvent(ctx, {
        eventType: 'ResourceRevised',
        aggregateType: 'RESOURCE',
        aggregateId: now.resource_id as Uuid,
        payload: { revision: now.revision + 1 },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'resource.revised',
        targetType: 'RESOURCE',
        targetId: now.resource_id,
        details: { revision: now.revision + 1, changed },
      });
      const response = { resourceId: now.resource_id, revision: now.revision + 1 };
      await idem.record(response);
      return { ...response, created: true };
    });
  }

  /** ACTIVE ↔ RETIRED with a reason. Lifecycle is not availability: a maintenance blackout keeps it ACTIVE. */
  async setResourceStatus(input: {
    actorAccountId: string;
    resourceId: string;
    status: 'ACTIVE' | 'RETIRED';
    reason: string;
    idempotencyKey: string;
  }) {
    const reason = text(input.reason, 500, 'reason');
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ resourceId: string; status: string }>(ctx, {
        command: 'SetResourceStatus',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { resourceId: input.resourceId, status: input.status, reason },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      const before = await this.current(ctx, input.resourceId);
      await this.competition(ctx, input.actorAccountId, before.competition_id, 'COMP_EDIT');
      await lockKeys(ctx, `competition-resources:${before.competition_id}`);
      const now = await this.current(ctx, input.resourceId);
      if (now.status === input.status)
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          `the resource is already ${input.status}`,
        );
      if (input.status === 'ACTIVE') {
        // Reactivating must not create two ACTIVE resources with one label.
        const { rows: dup } = await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM competition.v_resource_current
          WHERE competition_id = ${now.competition_id} AND status = 'ACTIVE' AND lower(label) = lower(${now.label})`.execute(
          ctx.trx,
        );
        if ((dup[0]?.n ?? 0) > 0)
          throw new DomainError(
            DomainErrorCode.ALREADY_EXISTS,
            'another active resource of this competition has that label',
            { reason: 'DUPLICATE_LABEL' },
          );
      }
      await sql`INSERT INTO competition.resource_revision
          (id, resource_id, revision, label, attributes, capacity, occupancy_mode, exclusivity_keys, venue_organization_id,
           location_label, timezone, status, reason, actor_account_id, recorded_at)
        SELECT ${newId()}, resource_id, revision + 1, label, attributes, capacity, occupancy_mode, exclusivity_keys,
               venue_organization_id, location_label, timezone, ${input.status}, ${reason}, ${input.actorAccountId}, ${ctx.txTime}
        FROM competition.resource_revision WHERE resource_id = ${now.resource_id} ORDER BY seq DESC LIMIT 1`.execute(
        ctx.trx,
      );
      const eventType = input.status === 'RETIRED' ? 'ResourceRetired' : 'ResourceReactivated';
      await emitEvent(ctx, {
        eventType,
        aggregateType: 'RESOURCE',
        aggregateId: now.resource_id as Uuid,
        payload: { status: input.status },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: input.status === 'RETIRED' ? 'resource.retired' : 'resource.reactivated',
        targetType: 'RESOURCE',
        targetId: now.resource_id,
        details: { revision: now.revision + 1 },
      });
      const response = { resourceId: now.resource_id, status: input.status };
      await idem.record(response);
      return { ...response, created: true };
    });
  }

  listResources(input: { actorAccountId: string; competitionId: string }) {
    return this.tx(async (ctx) => {
      await this.competition(ctx, input.actorAccountId, input.competitionId, 'COMP_VIEW_PRIVATE');
      const { rows } = await sql<CurrentRow>`
        SELECT * FROM competition.v_resource_current WHERE competition_id = ${input.competitionId}
        ORDER BY status, type_code, lower(label), resource_id`.execute(ctx.trx);
      return { items: rows.map(view) };
    });
  }

  /** One resource with its full revision history (who, when, why). */
  getResource(input: { actorAccountId: string; resourceId: string }) {
    return this.tx(async (ctx) => {
      const r = await this.current(ctx, input.resourceId);
      await this.competition(ctx, input.actorAccountId, r.competition_id, 'COMP_VIEW_PRIVATE');
      const { rows } = await sql<{
        revision: number;
        label: string;
        capacity: number;
        occupancy_mode: string;
        status: string;
        reason: string | null;
        actor_account_id: string;
        recorded_at: Date;
      }>`
        SELECT revision, label, capacity, occupancy_mode, status, reason, actor_account_id, recorded_at FROM competition.resource_revision
        WHERE resource_id = ${r.resource_id} ORDER BY seq DESC`.execute(ctx.trx);
      return {
        ...view(r),
        history: rows.map((x) => ({
          revision: x.revision,
          label: x.label,
          capacity: x.capacity,
          occupancyMode: x.occupancy_mode,
          status: x.status,
          reason: x.reason,
          actorAccountId: x.actor_account_id,
          recordedAt: x.recorded_at.toISOString(),
        })),
      };
    });
  }

  // ───────────────────────────── availability ─────────────────────────────

  /** Adds an availability fact for one resource, or competition-wide (`resourceId` null). */
  async addAvailability(input: {
    actorAccountId: string;
    competitionId: string;
    resourceId: string | null;
    fact: AvailabilityInputFact;
    idempotencyKey: string;
  }) {
    const fact = this.parseFact(input.fact);
    const issues = validateAvailabilityFact(fact);
    if (issues.length > 0) throw issuesError('the availability rule is not valid', issues);
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ availabilityId: string }>(ctx, {
        command: 'AddAvailability',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: {
          competitionId: input.competitionId,
          resourceId: input.resourceId,
          fact: input.fact,
        },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      await this.competition(ctx, input.actorAccountId, input.competitionId, 'COMP_EDIT');
      if (input.resourceId !== null) {
        const r = await this.current(ctx, input.resourceId);
        if (r.competition_id !== input.competitionId)
          throw new DomainError(DomainErrorCode.NOT_FOUND, 'resource not found');
      }
      await lockKeys(ctx, `competition-resources:${input.competitionId}`);
      const v = this.columns(fact);
      const { rows: dup } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM competition.v_resource_availability_current
        WHERE competition_id = ${input.competitionId} AND resource_id IS NOT DISTINCT FROM ${input.resourceId}::uuid
          AND kind = ${fact.kind} AND weekday IS NOT DISTINCT FROM ${v.weekday}::smallint
          AND local_date IS NOT DISTINCT FROM ${v.date}::date AND local_start IS NOT DISTINCT FROM ${v.start}
          AND local_end IS NOT DISTINCT FROM ${v.end} AND valid_from IS NOT DISTINCT FROM ${v.validFrom}::date
          AND valid_to IS NOT DISTINCT FROM ${v.validTo}::date AND starts_at IS NOT DISTINCT FROM ${v.startsAt}::timestamptz
          AND ends_at IS NOT DISTINCT FROM ${v.endsAt}::timestamptz`.execute(ctx.trx);
      if ((dup[0]?.n ?? 0) > 0)
        throw new DomainError(
          DomainErrorCode.ALREADY_EXISTS,
          'that availability rule already applies',
          { reason: 'DUPLICATE_AVAILABILITY' },
        );
      const availabilityId = newId();
      await sql`INSERT INTO competition.resource_availability
          (id, competition_id, resource_id, kind, weekday, local_date, local_start, local_end, valid_from, valid_to,
           starts_at, ends_at, reason, created_by_account_id, recorded_at)
        VALUES (${availabilityId}, ${input.competitionId}, ${input.resourceId}, ${fact.kind}, ${v.weekday}, ${v.date}::date,
                ${v.start}, ${v.end}, ${v.validFrom}::date, ${v.validTo}::date, ${v.startsAt}::timestamptz, ${v.endsAt}::timestamptz,
                ${v.reason}, ${input.actorAccountId}, ${ctx.txTime})`.execute(ctx.trx);
      await emitEvent(ctx, {
        eventType: 'AvailabilityAdded',
        aggregateType: 'RESOURCE',
        aggregateId: (input.resourceId ?? input.competitionId) as Uuid,
        payload: { competitionId: input.competitionId, kind: fact.kind },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'availability.added',
        targetType: input.resourceId === null ? 'COMPETITION' : 'RESOURCE',
        targetId: input.resourceId ?? input.competitionId,
        details: { availabilityId, kind: fact.kind },
      });
      await idem.record({ availabilityId });
      return { availabilityId, created: true };
    });
  }

  /** A fact stops applying (append-only revocation with a reason; nothing is deleted). */
  async revokeAvailability(input: {
    actorAccountId: string;
    availabilityId: string;
    reason: string;
    idempotencyKey: string;
  }) {
    const reason = text(input.reason, 500, 'reason');
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ availabilityId: string }>(ctx, {
        command: 'RevokeAvailability',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { availabilityId: input.availabilityId, reason },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      if (!/^[0-9a-f-]{36}$/.test(input.availabilityId))
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'availability not found');
      const { rows } = await sql<{
        competition_id: string;
        resource_id: string | null;
        revoked: boolean;
      }>`
        SELECT a.competition_id, a.resource_id,
               EXISTS (SELECT 1 FROM competition.resource_availability_revocation x WHERE x.availability_id = a.id) AS revoked
        FROM competition.resource_availability a WHERE a.id = ${input.availabilityId}`.execute(
        ctx.trx,
      );
      const a = rows[0];
      if (a === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'availability not found');
      await this.competition(ctx, input.actorAccountId, a.competition_id, 'COMP_EDIT');
      if (a.revoked)
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          'the availability rule was already revoked',
        );
      await sql`INSERT INTO competition.resource_availability_revocation (availability_id, reason, actor_account_id, recorded_at)
        VALUES (${input.availabilityId}, ${reason}, ${input.actorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await emitEvent(ctx, {
        eventType: 'AvailabilityRevoked',
        aggregateType: 'RESOURCE',
        aggregateId: (a.resource_id ?? a.competition_id) as Uuid,
        payload: { availabilityId: input.availabilityId },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'availability.revoked',
        targetType: a.resource_id === null ? 'COMPETITION' : 'RESOURCE',
        targetId: a.resource_id ?? a.competition_id,
        details: { availabilityId: input.availabilityId },
      });
      await idem.record({ availabilityId: input.availabilityId });
      return { availabilityId: input.availabilityId, created: true };
    });
  }

  /** Current facts of a competition (optionally of one resource plus the competition-wide layer). */
  listAvailability(input: { actorAccountId: string; competitionId: string; resourceId?: string }) {
    return this.tx(async (ctx) => {
      await this.competition(ctx, input.actorAccountId, input.competitionId, 'COMP_VIEW_PRIVATE');
      const rows = await this.facts(ctx, input.competitionId, input.resourceId);
      return { items: rows.map(factView) };
    });
  }

  /** Effective available intervals of a resource over [from, to) (≤ 400 days). */
  async availability(input: {
    actorAccountId: string;
    resourceId: string;
    from: string;
    to: string;
  }) {
    const from = instantOrThrow(input.from, 'from').getTime();
    const to = instantOrThrow(input.to, 'to').getTime();
    if (to <= from || to - from > MAX_RANGE_DAYS * DAY)
      throw new DomainError(
        DomainErrorCode.INVALID_INPUT,
        `a range of up to ${MAX_RANGE_DAYS} days, from before to`,
      );
    return this.tx(async (ctx) => {
      const { r, evaluation } = await this.evaluation(ctx, input.actorAccountId, input.resourceId);
      return {
        resourceId: r.resource_id,
        timezone: evaluation.resource.zone,
        status: r.status,
        intervals: effectiveAvailability(evaluation, from, to).map((i) => ({
          start: new Date(i.start).toISOString(),
          end: new Date(i.end).toISOString(),
        })),
      };
    });
  }

  /** Is the resource intrinsically available for all of [start, end)? (resource availability only) */
  async check(input: { actorAccountId: string; resourceId: string; start: string; end: string }) {
    const start = instantOrThrow(input.start, 'start').getTime();
    const end = instantOrThrow(input.end, 'end').getTime();
    if (end <= start || end - start > MAX_RANGE_DAYS * DAY)
      throw new DomainError(DomainErrorCode.INVALID_INPUT, 'end must follow start (≤ 400 days)');
    return this.tx(async (ctx) => {
      const { r, evaluation } = await this.evaluation(ctx, input.actorAccountId, input.resourceId);
      const out = isResourceAvailable(evaluation, { start, end });
      return {
        resourceId: r.resource_id,
        available: out.available,
        gaps: out.gaps.map((i) => ({
          start: new Date(i.start).toISOString(),
          end: new Date(i.end).toISOString(),
        })),
      };
    });
  }

  private async evaluation(ctx: TxContext, actor: string, resourceId: string) {
    const r = await this.current(ctx, resourceId);
    await this.competition(ctx, actor, r.competition_id, 'COMP_VIEW_PRIVATE');
    const { rows: tz } = await sql<{ timezone: string }>`
      SELECT timezone FROM competition.competition_profile WHERE competition_id = ${r.competition_id}`.execute(
      ctx.trx,
    );
    const competitionZone = tz[0]?.timezone ?? 'UTC';
    const rows = await this.facts(ctx, r.competition_id, r.resource_id);
    const layer = (scope: string | null, zone: string): AvailabilityLayer => ({
      zone,
      facts: rows.filter((x) => x.resource_id === scope).map(toFact),
    });
    return {
      r,
      evaluation: {
        status: r.status,
        resource: layer(r.resource_id, r.timezone ?? competitionZone),
        competition: layer(null, competitionZone),
      },
    };
  }

  private async facts(
    ctx: TxContext,
    competitionId: string,
    resourceId?: string,
  ): Promise<FactRow[]> {
    const { rows } = await sql<FactRow>`
      SELECT id, resource_id, kind, weekday, to_char(local_date, 'YYYY-MM-DD') AS local_date, local_start, local_end,
             to_char(valid_from, 'YYYY-MM-DD') AS valid_from, to_char(valid_to, 'YYYY-MM-DD') AS valid_to,
             starts_at, ends_at, reason, recorded_at
      FROM competition.v_resource_availability_current
      WHERE competition_id = ${competitionId}
        AND (${resourceId ?? null}::uuid IS NULL OR resource_id IS NULL OR resource_id = ${resourceId ?? null}::uuid)
      ORDER BY resource_id NULLS FIRST, kind, weekday, local_date, local_start, starts_at, id`.execute(
      ctx.trx,
    );
    return rows;
  }

  private parseFact(f: AvailabilityInputFact): AvailabilityFact {
    switch (f.kind) {
      case 'BLACKOUT':
      case 'MAINTENANCE':
        return {
          kind: f.kind,
          startsAt: instantOrThrow(f.startsAt, 'startsAt').getTime(),
          endsAt: instantOrThrow(f.endsAt, 'endsAt').getTime(),
          reason: f.reason,
        };
      default:
        return f;
    }
  }

  private columns(f: AvailabilityFact) {
    return {
      weekday: f.kind === 'WEEKLY' ? f.weekday : null,
      date: f.kind === 'DATE_OPEN' || f.kind === 'DATE_CLOSED' ? f.date : null,
      start: f.kind === 'WEEKLY' || f.kind === 'DATE_OPEN' ? f.start : null,
      end: f.kind === 'WEEKLY' || f.kind === 'DATE_OPEN' ? f.end : null,
      validFrom: f.kind === 'WEEKLY' ? (f.validFrom ?? null) : null,
      validTo: f.kind === 'WEEKLY' ? (f.validTo ?? null) : null,
      startsAt: f.kind === 'BLACKOUT' || f.kind === 'MAINTENANCE' ? new Date(f.startsAt) : null,
      endsAt: f.kind === 'BLACKOUT' || f.kind === 'MAINTENANCE' ? new Date(f.endsAt) : null,
      reason: f.kind === 'BLACKOUT' || f.kind === 'MAINTENANCE' ? f.reason.trim() : null,
    };
  }
}
