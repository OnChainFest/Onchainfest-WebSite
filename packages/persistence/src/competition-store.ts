import {
  ACTIVE_REGISTRATION_STATUSES,
  canonicalFormatConfig,
  canTransition,
  competitionAcceptsEvents,
  CompetitionLifecycle,
  competitionProfileEditable,
  eventCapacityEditable,
  EventLifecycle,
  eventSettingsEditable,
  formatEngine,
  isTerminal,
  RegistrationLifecycle,
  validateCategory,
  type CompetitionStatus,
  type CompPermission,
  type DisciplineVersionSpec,
  type EventCategory,
  type EventStatus,
  type RegistrationStatus,
  type StaffRole,
} from '@br/competition';
import { DomainError, DomainErrorCode, newId, type DomainEventType, type Uuid } from '@br/domain';
import { canOperateOnPerson } from '@br/identity';
import { sql } from 'kysely';
import {
  competitionPermissions,
  currentStatus,
  httpsUrl,
  instantOrThrow,
  loadCompetition,
  loadEvent,
  optionalText,
  requireCompPermission,
  slugOrThrow,
  text,
  timezoneOrThrow,
  transitionError,
  type EventRow,
} from './competition-support';
import {
  refreshCompetitionCard,
  refreshCompetitionEvents,
  refreshEventReadModels,
} from './competition-projection';
import type { Db } from './db';
import {
  hasOrgPermission,
  identityIdempotency,
  loadControlFacts,
  lockKeys,
  recordAudit,
} from './identity-support';
import { emitEvent } from './outbox';
import { inTransaction, ModuleRole, type TxContext } from './tx';

export interface CompetitionProfileInput {
  readonly name: string;
  readonly description?: string | null;
  readonly locationLabel?: string | null;
  /** ISO 3166-1/2 region (used in authority scope paths when set). */
  readonly regionCode?: string | null;
  readonly timezone: string;
  readonly startsAt?: Date | string | null;
  readonly endsAt?: Date | string | null;
  readonly website?: string | null;
}

export interface EventSettingsInput {
  readonly name: string;
  readonly category?: EventCategory;
  readonly capacity?: number | null;
  readonly registrationMode?: 'AUTO_CONFIRM' | 'ORGANIZER_APPROVAL';
  readonly registrationOpensAt?: Date | string | null;
  readonly registrationClosesAt?: Date | string | null;
  readonly startsAt?: Date | string | null;
  readonly endsAt?: Date | string | null;
  /** Defaults to the competition timezone. */
  readonly timezone?: string;
}

/** Maps database guard violations to domain errors (no SQL detail leaks). */
export function mapCompetitionPgError(err: unknown): never {
  const e = err as { code?: string };
  if (e?.code === 'BR003')
    throw new DomainError(DomainErrorCode.CAPACITY_REACHED, 'event capacity reached');
  if (e?.code === 'BR004')
    throw new DomainError(
      DomainErrorCode.ALREADY_EXISTS,
      'this entrant already has an active registration in the event',
    );
  throw err;
}

const nullableInstant = (v: Date | string | null | undefined, what: string): Date | null =>
  v === null || v === undefined ? null : instantOrThrow(v, what);

function ordered(a: Date | null, b: Date | null, what: string): void {
  if (a !== null && b !== null && b.getTime() < a.getTime())
    throw new DomainError(DomainErrorCode.INVALID_INPUT, `${what}: end must not precede start`);
}

async function loadDisciplineSpec(
  ctx: TxContext,
  disciplineVersionId: string,
): Promise<{ spec: DisciplineVersionSpec; status: string; specHash: string }> {
  const { rows } = await sql<{ spec: DisciplineVersionSpec; status: string; spec_hash: string }>`
    SELECT dv.spec, c.status, dv.spec_hash FROM sports.discipline_version dv
    JOIN sports.v_discipline_version_current c ON c.discipline_version_id = dv.id WHERE dv.id = ${disciplineVersionId}`.execute(
    ctx.trx,
  );
  if (rows[0] === undefined)
    throw new DomainError(DomainErrorCode.NOT_FOUND, 'discipline version not found');
  return { spec: rows[0].spec, status: rows[0].status, specHash: rows[0].spec_hash };
}

/** Can the account enter / act for this athlete (SELF or confirmed GUARDIAN; athlete ACTIVE)? */
export async function canActForAthlete(
  ctx: TxContext,
  accountId: string,
  athleteId: string,
): Promise<boolean> {
  const { rows } = await sql<{ person_id: string; status: string }>`
    SELECT a.person_id, s.status FROM identity.athlete a JOIN identity.v_athlete_current s ON s.athlete_id = a.id
    WHERE a.id = ${athleteId}`.execute(ctx.trx);
  const a = rows[0];
  if (a === undefined || a.status !== 'ACTIVE') return false;
  return canOperateOnPerson(
    await loadControlFacts(ctx, accountId),
    a.person_id,
    'REGISTER_FOR_EVENT',
  );
}

export async function isTeamManager(
  ctx: TxContext,
  accountId: string,
  teamId: string,
): Promise<boolean> {
  const facts = await loadControlFacts(ctx, accountId);
  if (!facts.accountActive || facts.selfPersonId === undefined) return false;
  const { rows } = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM competition.team_manager WHERE team_id = ${teamId} AND person_id = ${facts.selfPersonId}`.execute(
    ctx.trx,
  );
  return (rows[0]?.n ?? 0) > 0;
}

/** Athletes with an ACTIVE membership of the team at time `at` (temporal: latest status ≤ at). */
export async function activeTeamMembers(
  ctx: TxContext,
  teamId: string,
  at: Date,
): Promise<string[]> {
  const { rows } = await sql<{ athlete_id: string }>`
    SELECT m.athlete_id FROM competition.team_membership m
    WHERE m.team_id = ${teamId}
      AND (SELECT sc.status FROM competition.team_membership_status_change sc
           WHERE sc.team_membership_id = m.id AND sc.recorded_at <= ${at}
           ORDER BY sc.seq DESC LIMIT 1) = 'ACTIVE'
    ORDER BY m.athlete_id`.execute(ctx.trx);
  return rows.map((r) => r.athlete_id);
}

const isoOrNull = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** ONCF-03A organizer list row (DRAFT included; never served publicly). */
export interface ManagedCompetitionCard {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: CompetitionStatus;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly timezone: string;
  readonly locationLabel: string | null;
  readonly regionCode: string | null;
  /** All events (categories), cancelled ones included; `cancelledEventCount` of them are CANCELLED. */
  readonly eventCount: number;
  readonly cancelledEventCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly statusChangedAt: string;
}

/** ONCF-03A organizer detail: the competition and its events in editable form. */
export interface ManagedCompetition {
  readonly competition: {
    readonly id: string;
    readonly slug: string;
    readonly organizerOrganizationId: string;
    readonly status: CompetitionStatus;
    readonly profile: {
      readonly name: string;
      readonly description: string | null;
      readonly locationLabel: string | null;
      readonly regionCode: string | null;
      readonly timezone: string;
      readonly startsAt: string | null;
      readonly endsAt: string | null;
      readonly website: string | null;
    };
    readonly editable: { readonly profile: boolean; readonly addEvents: boolean };
    readonly nextStatuses: CompetitionStatus[];
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly statusChangedAt: string;
  };
  readonly events: {
    readonly id: string;
    readonly slug: string;
    readonly status: EventStatus;
    /** Fixed at creation, like the pinned discipline and format versions. */
    readonly entrantKind: 'INDIVIDUAL' | 'TEAM';
    readonly discipline: {
      readonly versionId: string;
      readonly sport: { readonly code: string; readonly name: string };
      readonly code: string;
      readonly name: string;
      readonly version: number;
    };
    readonly format: {
      readonly versionId: string;
      readonly code: string;
      readonly name: string;
      readonly version: number;
      readonly engine: string;
    };
    readonly formatConfig: Record<string, unknown>;
    readonly settings: {
      readonly name: string;
      readonly category: EventCategory;
      readonly capacity: number | null;
      readonly registrationMode: 'AUTO_CONFIRM' | 'ORGANIZER_APPROVAL';
      readonly registrationOpensAt: string | null;
      readonly registrationClosesAt: string | null;
      readonly startsAt: string | null;
      readonly endsAt: string | null;
      readonly timezone: string;
    };
    readonly counts: {
      readonly confirmed: number;
      readonly waitlisted: number;
      readonly participants: number;
    };
    readonly editable: {
      readonly settings: boolean;
      readonly capacityAndRegistrationMode: boolean;
    };
    readonly nextStatuses: EventStatus[];
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly statusChangedAt: string;
  }[];
  readonly access: { readonly staffRoles: StaffRole[]; readonly permissions: CompPermission[] };
}

/**
 * Competition operations (br_competition): competitions, staff, events, registration.
 * Application permissions only — nothing here issues, reads or implies an Authority capability,
 * and no status here states a sporting result.
 */
export class CompetitionStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private tx<T>(fn: (ctx: TxContext) => Promise<T>): Promise<T> {
    return inTransaction(this.db, ModuleRole.competition, fn);
  }

  // ───────────────────────────── competitions ─────────────────────────────

  private profile(p: CompetitionProfileInput) {
    const startsAt = nullableInstant(p.startsAt, 'startsAt');
    const endsAt = nullableInstant(p.endsAt, 'endsAt');
    ordered(startsAt, endsAt, 'competition dates');
    if (
      p.regionCode !== null &&
      p.regionCode !== undefined &&
      !/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(p.regionCode)
    )
      throw new DomainError(DomainErrorCode.INVALID_INPUT, 'regionCode must be ISO 3166');
    return {
      name: text(p.name, 120, 'name'),
      description: optionalText(p.description, 2000, 'description', { multiline: true }),
      locationLabel: optionalText(p.locationLabel, 120, 'locationLabel'),
      regionCode: p.regionCode ?? null,
      timezone: timezoneOrThrow(p.timezone),
      startsAt,
      endsAt,
      website: httpsUrl(p.website),
    };
  }

  /** Requires ORG_MANAGE_COMPETITIONS (OWNER/ADMIN) in an ACTIVE organizer organization. */
  async createCompetition(input: {
    actorAccountId: string;
    organizerOrganizationId: string;
    slug: string;
    profile: CompetitionProfileInput;
    idempotencyKey: string;
  }): Promise<{ competitionId: string; slug: string; created: boolean }> {
    const slug = slugOrThrow(input.slug);
    const p = this.profile(input.profile);
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ competitionId: string; slug: string }>(ctx, {
        command: 'CreateCompetition',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: {
          organizerOrganizationId: input.organizerOrganizationId,
          slug,
          profile: { ...p, startsAt: p.startsAt?.toISOString(), endsAt: p.endsAt?.toISOString() },
        },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      if (
        !(await hasOrgPermission(
          ctx,
          input.actorAccountId,
          input.organizerOrganizationId,
          'ORG_MANAGE_COMPETITIONS',
        ))
      ) {
        await recordAudit(ctx, {
          actorAccountId: input.actorAccountId,
          action: 'competition.create',
          targetType: 'ORGANIZATION',
          targetId: input.organizerOrganizationId,
          outcome: 'DENIED',
        });
        throw new DomainError(DomainErrorCode.FORBIDDEN, 'not permitted');
      }
      await lockKeys(ctx, `competition-slug:${slug}`);
      const { rows: taken } = await sql<{
        n: number;
      }>`SELECT count(*)::int AS n FROM competition.competition_slug WHERE slug = ${slug}`.execute(
        ctx.trx,
      );
      if ((taken[0]?.n ?? 0) > 0)
        throw new DomainError(DomainErrorCode.SLUG_TAKEN, 'slug is not available');
      const id = newId();
      await sql`INSERT INTO competition.competition (id, organizer_organization_id, created_by_account_id, recorded_at)
        VALUES (${id}, ${input.organizerOrganizationId}, ${input.actorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await sql`INSERT INTO competition.competition_profile (competition_id, name, description, location_label, region_code, timezone, starts_at, ends_at, website, updated_at, updated_by_account_id)
        VALUES (${id}, ${p.name}, ${p.description}, ${p.locationLabel}, ${p.regionCode}, ${p.timezone}, ${p.startsAt}, ${p.endsAt}, ${p.website}, ${ctx.txTime}, ${input.actorAccountId})`.execute(
        ctx.trx,
      );
      await sql`INSERT INTO competition.competition_slug (slug, competition_id, recorded_at) VALUES (${slug}, ${id}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await sql`INSERT INTO competition.competition_status_change (id, competition_id, status, actor_account_id, recorded_at)
        VALUES (${newId()}, ${id}, 'DRAFT', ${input.actorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await refreshCompetitionCard(ctx, id);
      await emitEvent(ctx, {
        eventType: 'CompetitionCreated',
        aggregateType: 'COMPETITION',
        aggregateId: id as Uuid,
        payload: { organizerOrganizationId: input.organizerOrganizationId, slug },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'competition.created',
        targetType: 'COMPETITION',
        targetId: id,
      });
      await idem.record({ competitionId: id, slug });
      return { competitionId: id, slug, created: true };
    });
  }

  async updateCompetitionProfile(input: {
    actorAccountId: string;
    competitionId: string;
    profile: CompetitionProfileInput;
  }): Promise<void> {
    const p = this.profile(input.profile);
    await this.tx(async (ctx) => {
      const c = await loadCompetition(ctx, input.competitionId);
      await requireCompPermission(ctx, input.actorAccountId, c, 'COMP_EDIT');
      if (!competitionProfileEditable(c.status))
        throw transitionError('competition', c.status, 'edited');
      await sql`UPDATE competition.competition_profile SET name = ${p.name}, description = ${p.description}, location_label = ${p.locationLabel},
          region_code = ${p.regionCode}, timezone = ${p.timezone}, starts_at = ${p.startsAt}, ends_at = ${p.endsAt}, website = ${p.website},
          updated_at = ${ctx.txTime}, updated_by_account_id = ${input.actorAccountId}
        WHERE competition_id = ${c.id}`.execute(ctx.trx);
      await refreshCompetitionCard(ctx, c.id);
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'competition.profile-updated',
        targetType: 'COMPETITION',
        targetId: c.id,
      });
    });
  }

  /** New slug claim; former slugs keep redirecting and can never be re-claimed. */
  async changeCompetitionSlug(input: {
    actorAccountId: string;
    competitionId: string;
    slug: string;
  }): Promise<{ slug: string }> {
    const slug = slugOrThrow(input.slug);
    return this.tx(async (ctx) => {
      const c = await loadCompetition(ctx, input.competitionId);
      await requireCompPermission(ctx, input.actorAccountId, c, 'COMP_EDIT');
      await lockKeys(ctx, `competition-slug:${slug}`);
      const { rows } = await sql<{
        n: number;
      }>`SELECT count(*)::int AS n FROM competition.competition_slug WHERE slug = ${slug}`.execute(
        ctx.trx,
      );
      if ((rows[0]?.n ?? 0) > 0)
        throw new DomainError(DomainErrorCode.SLUG_TAKEN, 'slug is not available');
      await sql`INSERT INTO competition.competition_slug (slug, competition_id, recorded_at) VALUES (${slug}, ${c.id}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await refreshCompetitionCard(ctx, c.id);
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'competition.slug-changed',
        targetType: 'COMPETITION',
        targetId: c.id,
      });
      return { slug };
    });
  }

  publishCompetition(input: { actorAccountId: string; competitionId: string }): Promise<void> {
    return this.setCompetitionStatus(
      input.actorAccountId,
      input.competitionId,
      'PUBLISHED',
      'COMP_PUBLISH',
    );
  }

  activateCompetition(input: { actorAccountId: string; competitionId: string }): Promise<void> {
    return this.setCompetitionStatus(
      input.actorAccountId,
      input.competitionId,
      'ACTIVE',
      'COMP_EDIT',
    );
  }

  /** Operational completion only (never "all results final"); requires every event to be terminal. */
  completeCompetition(input: { actorAccountId: string; competitionId: string }): Promise<void> {
    return this.setCompetitionStatus(
      input.actorAccountId,
      input.competitionId,
      'COMPLETED',
      'COMP_EDIT',
    );
  }

  /** Cancellation is a status fact; non-terminal events and contests get CANCELLED facts too. */
  cancelCompetition(input: {
    actorAccountId: string;
    competitionId: string;
    reason: string;
  }): Promise<void> {
    return this.setCompetitionStatus(
      input.actorAccountId,
      input.competitionId,
      'CANCELLED',
      'COMP_CANCEL',
      text(input.reason, 500, 'reason'),
    );
  }

  private setCompetitionStatus(
    actor: string,
    competitionId: string,
    to: CompetitionStatus,
    permission: CompPermission,
    reason?: string,
  ): Promise<void> {
    return this.tx(async (ctx) => {
      await lockKeys(ctx, `competition:${competitionId}`);
      const c = await loadCompetition(ctx, competitionId);
      await requireCompPermission(ctx, actor, c, permission);
      if (!canTransition(CompetitionLifecycle, c.status, to))
        throw transitionError('competition', c.status, to);
      const { rows: events } = await sql<{ id: string; status: EventStatus }>`
        SELECT e.id, s.status FROM competition.event e JOIN competition.v_event_current s ON s.event_id = e.id
        WHERE e.competition_id = ${c.id} ORDER BY e.id`.execute(ctx.trx);
      const open = events.filter((e) => !isTerminal(EventLifecycle, e.status));
      if (to === 'COMPLETED' && open.length > 0) {
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          'every event must be COMPLETED or CANCELLED before the competition completes',
        );
      }
      await sql`INSERT INTO competition.competition_status_change (id, competition_id, status, reason, actor_account_id, recorded_at)
        VALUES (${newId()}, ${c.id}, ${to}, ${reason ?? null}, ${actor}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      if (to === 'CANCELLED') {
        for (const e of open) await cancelEventFacts(ctx, e.id, actor, 'competition cancelled');
      }
      await refreshCompetitionCard(ctx, c.id);
      await refreshCompetitionEvents(ctx, c.id);
      await emitEvent(ctx, {
        eventType: to === 'PUBLISHED' ? 'CompetitionPublished' : 'CompetitionStatusChanged',
        aggregateType: 'COMPETITION',
        aggregateId: c.id as Uuid,
        payload: { status: to },
      });
      await recordAudit(ctx, {
        actorAccountId: actor,
        action: `competition.${to.toLowerCase()}`,
        targetType: 'COMPETITION',
        targetId: c.id,
      });
    });
  }

  // ───────────────────────────── staff ─────────────────────────────

  async assignStaff(input: {
    actorAccountId: string;
    competitionId: string;
    personId: string;
    role: StaffRole;
    idempotencyKey: string;
  }): Promise<{ staffId: string; created: boolean }> {
    if (!['OWNER', 'ADMIN', 'REGISTRATION_MANAGER', 'SCHEDULER'].includes(input.role))
      throw new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid staff role');
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ staffId: string }>(ctx, {
        command: 'AssignCompetitionStaff',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { competitionId: input.competitionId, personId: input.personId, role: input.role },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      const c = await loadCompetition(ctx, input.competitionId);
      await requireCompPermission(ctx, input.actorAccountId, c, 'COMP_MANAGE_STAFF');
      await lockKeys(ctx, `competition-staff:${c.id}:${input.personId}`);
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM competition.competition_staff s JOIN competition.v_staff_current v ON v.staff_id = s.id
        WHERE s.competition_id = ${c.id} AND s.person_id = ${input.personId} AND s.staff_role = ${input.role} AND v.status = 'ACTIVE'`.execute(
        ctx.trx,
      );
      if ((rows[0]?.n ?? 0) > 0)
        throw new DomainError(
          DomainErrorCode.ALREADY_EXISTS,
          'the person already has this staff role',
        );
      const staffId = newId();
      try {
        await sql`INSERT INTO competition.competition_staff (id, competition_id, person_id, staff_role, assigned_by_account_id, recorded_at)
          VALUES (${staffId}, ${c.id}, ${input.personId}, ${input.role}, ${input.actorAccountId}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
      } catch (err) {
        if ((err as { code?: string }).code === '23503')
          throw new DomainError(DomainErrorCode.NOT_FOUND, 'person not found');
        throw err;
      }
      await sql`INSERT INTO competition.competition_staff_status_change (id, staff_id, status, actor_account_id, recorded_at)
        VALUES (${newId()}, ${staffId}, 'ACTIVE', ${input.actorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await emitEvent(ctx, {
        eventType: 'CompetitionStaffAssigned',
        aggregateType: 'COMPETITION',
        aggregateId: c.id as Uuid,
        payload: { staffId, role: input.role },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'competition.staff-assigned',
        targetType: 'COMPETITION',
        targetId: c.id,
        details: { role: input.role },
      });
      await idem.record({ staffId });
      return { staffId, created: true };
    });
  }

  async endStaff(input: { actorAccountId: string; staffId: string }): Promise<void> {
    await this.tx(async (ctx) => {
      const { rows } = await sql<{
        competition_id: string;
      }>`SELECT competition_id FROM competition.competition_staff WHERE id = ${input.staffId}`.execute(
        ctx.trx,
      );
      if (rows[0] === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'staff assignment not found');
      const c = await loadCompetition(ctx, rows[0].competition_id);
      await requireCompPermission(ctx, input.actorAccountId, c, 'COMP_MANAGE_STAFF');
      if (
        (await currentStatus(ctx, 'competition.v_staff_current', 'staff_id', input.staffId)) !==
        'ACTIVE'
      )
        throw transitionError('staff assignment', 'ENDED', 'ENDED');
      await sql`INSERT INTO competition.competition_staff_status_change (id, staff_id, status, actor_account_id, recorded_at)
        VALUES (${newId()}, ${input.staffId}, 'ENDED', ${input.actorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await emitEvent(ctx, {
        eventType: 'CompetitionStaffEnded',
        aggregateType: 'COMPETITION',
        aggregateId: c.id as Uuid,
        payload: { staffId: input.staffId },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'competition.staff-ended',
        targetType: 'COMPETITION',
        targetId: c.id,
      });
    });
  }

  /** The caller's operational roles/permissions on a competition. */
  permissions(accountId: string, competitionId: string) {
    return this.tx(async (ctx) => {
      const c = await loadCompetition(ctx, competitionId);
      const r = await competitionPermissions(ctx, accountId, c);
      return { staffRoles: r.staffRoles, permissions: [...r.permissions].sort() };
    });
  }

  // ───────────────────────────── organizer reads (ONCF-03A) ─────────────────────────────

  /**
   * Every competition an organization organizes, DRAFT included, for its organizer area.
   * Requires ORG_MANAGE_COMPETITIONS in that organization (ACTIVE OWNER/ADMIN); anyone else —
   * including members of other organizations — gets FORBIDDEN, whether or not the id exists.
   */
  organizationCompetitions(input: {
    actorAccountId: string;
    organizationId: string;
  }): Promise<ManagedCompetitionCard[]> {
    return this.tx(async (ctx) => {
      if (
        !(await hasOrgPermission(
          ctx,
          input.actorAccountId,
          input.organizationId,
          'ORG_MANAGE_COMPETITIONS',
        ))
      ) {
        await recordAudit(ctx, {
          actorAccountId: input.actorAccountId,
          action: 'competition.manage-list',
          targetType: 'ORGANIZATION',
          targetId: input.organizationId,
          outcome: 'DENIED',
        });
        throw new DomainError(DomainErrorCode.FORBIDDEN, 'not permitted');
      }
      const { rows } = await sql<{
        id: string;
        slug: string;
        name: string;
        status: CompetitionStatus;
        status_changed_at: Date;
        starts_at: Date | null;
        ends_at: Date | null;
        timezone: string;
        location_label: string | null;
        region_code: string | null;
        created_at: Date;
        updated_at: Date;
        event_count: number;
        cancelled_event_count: number;
      }>`
        SELECT c.id, sl.slug, p.name, st.status, st.recorded_at AS status_changed_at, p.starts_at, p.ends_at, p.timezone,
               p.location_label, p.region_code, c.recorded_at AS created_at, p.updated_at,
               (SELECT count(*)::int FROM competition.event e WHERE e.competition_id = c.id) AS event_count,
               (SELECT count(*)::int FROM competition.event e JOIN competition.v_event_current es ON es.event_id = e.id
                 WHERE e.competition_id = c.id AND es.status = 'CANCELLED') AS cancelled_event_count
        FROM competition.competition c
        JOIN competition.competition_profile p ON p.competition_id = c.id
        JOIN competition.v_competition_current st ON st.competition_id = c.id
        JOIN competition.v_competition_slug_current sl ON sl.competition_id = c.id
        WHERE c.organizer_organization_id = ${input.organizationId}
        ORDER BY c.recorded_at DESC, c.id
        LIMIT 200`.execute(ctx.trx);
      return rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        status: r.status,
        startsAt: isoOrNull(r.starts_at),
        endsAt: isoOrNull(r.ends_at),
        timezone: r.timezone,
        locationLabel: r.location_label,
        regionCode: r.region_code,
        eventCount: r.event_count,
        cancelledEventCount: r.cancelled_event_count,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
        statusChangedAt: r.status_changed_at.toISOString(),
      }));
    });
  }

  /**
   * One competition with all of its events (DRAFT included) in editable form. Requires
   * COMP_VIEW_PRIVATE: organizer OWNER/ADMIN or ACTIVE competition staff. The `editable` flags and
   * `nextStatuses` restate the lifecycle rules the commands enforce; the caller's own permissions
   * are in `access` (the commands still decide).
   */
  managedCompetition(input: {
    actorAccountId: string;
    competitionId: string;
  }): Promise<ManagedCompetition> {
    return this.tx(async (ctx) => {
      const c = await loadCompetition(ctx, input.competitionId);
      await requireCompPermission(ctx, input.actorAccountId, c, 'COMP_VIEW_PRIVATE');
      const access = await competitionPermissions(ctx, input.actorAccountId, c);
      const { rows: comp } = await sql<{
        slug: string;
        name: string;
        description: string | null;
        location_label: string | null;
        region_code: string | null;
        timezone: string;
        starts_at: Date | null;
        ends_at: Date | null;
        website: string | null;
        created_at: Date;
        updated_at: Date;
        status_changed_at: Date;
      }>`
        SELECT sl.slug, p.name, p.description, p.location_label, p.region_code, p.timezone, p.starts_at, p.ends_at, p.website,
               c.recorded_at AS created_at, p.updated_at, st.recorded_at AS status_changed_at
        FROM competition.competition c
        JOIN competition.competition_profile p ON p.competition_id = c.id
        JOIN competition.v_competition_current st ON st.competition_id = c.id
        JOIN competition.v_competition_slug_current sl ON sl.competition_id = c.id
        WHERE c.id = ${c.id}`.execute(ctx.trx);
      const r = comp[0] as (typeof comp)[number];
      const { rows: events } = await sql<{
        id: string;
        slug: string;
        status: EventStatus;
        status_changed_at: Date;
        entrant_kind: 'INDIVIDUAL' | 'TEAM';
        discipline_version_id: string;
        sport_code: string;
        sport_name: string;
        discipline_code: string;
        discipline_name: string;
        discipline_version: number;
        format_version_id: string;
        format_code: string;
        format_name: string;
        format_version: number;
        engine_id: string;
        engine_version: number;
        format_config: Record<string, unknown>;
        name: string;
        category: EventCategory;
        capacity: number | null;
        registration_mode: 'AUTO_CONFIRM' | 'ORGANIZER_APPROVAL';
        registration_opens_at: Date | null;
        registration_closes_at: Date | null;
        starts_at: Date | null;
        ends_at: Date | null;
        timezone: string;
        created_at: Date;
        updated_at: Date;
        confirmed_count: number | null;
        waitlist_count: number | null;
        participant_count: number | null;
      }>`
        SELECT e.id, sl.slug, st.status, st.recorded_at AS status_changed_at, e.entrant_kind,
               e.discipline_version_id, s.code AS sport_code, s.name AS sport_name, d.code AS discipline_code,
               d.name AS discipline_name, dv.version AS discipline_version,
               e.format_version_id, t.code AS format_code, t.name AS format_name, fv.version AS format_version,
               fv.engine_id, fv.engine_version, e.format_config,
               p.name, p.category, p.capacity, p.registration_mode, p.registration_opens_at, p.registration_closes_at,
               p.starts_at, p.ends_at, p.timezone, e.recorded_at AS created_at, p.updated_at,
               es.confirmed_count, es.waitlist_count, es.participant_count
        FROM competition.event e
        JOIN competition.event_profile p ON p.event_id = e.id
        JOIN competition.v_event_current st ON st.event_id = e.id
        JOIN competition.v_event_slug_current sl ON sl.event_id = e.id
        JOIN sports.discipline_version dv ON dv.id = e.discipline_version_id
        JOIN sports.discipline d ON d.id = dv.discipline_id
        JOIN sports.sport s ON s.id = d.sport_id
        JOIN sports.format_version fv ON fv.id = e.format_version_id
        JOIN sports.format_template t ON t.id = fv.template_id
        LEFT JOIN competition_read.event_summary es ON es.event_id = e.id
        WHERE e.competition_id = ${c.id}
        ORDER BY e.recorded_at, e.id`.execute(ctx.trx);
      return {
        competition: {
          id: c.id,
          slug: r.slug,
          organizerOrganizationId: c.organizerOrganizationId,
          status: c.status,
          profile: {
            name: r.name,
            description: r.description,
            locationLabel: r.location_label,
            regionCode: r.region_code,
            timezone: r.timezone,
            startsAt: isoOrNull(r.starts_at),
            endsAt: isoOrNull(r.ends_at),
            website: r.website,
          },
          editable: {
            profile: competitionProfileEditable(c.status),
            addEvents: competitionAcceptsEvents(c.status),
          },
          nextStatuses: [...CompetitionLifecycle.transitions[c.status]],
          createdAt: r.created_at.toISOString(),
          updatedAt: r.updated_at.toISOString(),
          statusChangedAt: r.status_changed_at.toISOString(),
        },
        events: events.map((e) => ({
          id: e.id,
          slug: e.slug,
          status: e.status,
          entrantKind: e.entrant_kind,
          discipline: {
            versionId: e.discipline_version_id,
            sport: { code: e.sport_code, name: e.sport_name },
            code: e.discipline_code,
            name: e.discipline_name,
            version: e.discipline_version,
          },
          format: {
            versionId: e.format_version_id,
            code: e.format_code,
            name: e.format_name,
            version: e.format_version,
            engine: `${e.engine_id}/${e.engine_version}`,
          },
          formatConfig: e.format_config,
          settings: {
            name: e.name,
            category: e.category,
            capacity: e.capacity,
            registrationMode: e.registration_mode,
            registrationOpensAt: isoOrNull(e.registration_opens_at),
            registrationClosesAt: isoOrNull(e.registration_closes_at),
            startsAt: isoOrNull(e.starts_at),
            endsAt: isoOrNull(e.ends_at),
            timezone: e.timezone,
          },
          counts: {
            confirmed: e.confirmed_count ?? 0,
            waitlisted: e.waitlist_count ?? 0,
            participants: e.participant_count ?? 0,
          },
          editable: {
            settings: eventSettingsEditable(e.status),
            capacityAndRegistrationMode: eventCapacityEditable(e.status),
          },
          nextStatuses: [...EventLifecycle.transitions[e.status]],
          createdAt: e.created_at.toISOString(),
          updatedAt: e.updated_at.toISOString(),
          statusChangedAt: e.status_changed_at.toISOString(),
        })),
        access: { staffRoles: access.staffRoles, permissions: [...access.permissions].sort() },
      };
    });
  }

  // ───────────────────────────── events ─────────────────────────────

  private settings(s: EventSettingsInput, competitionTimezone: string) {
    const issues = s.category === undefined ? [] : validateCategory(s.category);
    if (issues.length > 0)
      throw new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid category', { issues });
    if (
      s.capacity !== null &&
      s.capacity !== undefined &&
      (!Number.isInteger(s.capacity) || s.capacity < 1 || s.capacity > 4096)
    ) {
      throw new DomainError(DomainErrorCode.INVALID_INPUT, 'capacity must be 1–4096');
    }
    const r = {
      name: text(s.name, 120, 'name'),
      category: s.category ?? {},
      capacity: s.capacity ?? null,
      registrationMode: s.registrationMode ?? 'AUTO_CONFIRM',
      registrationOpensAt: nullableInstant(s.registrationOpensAt, 'registrationOpensAt'),
      registrationClosesAt: nullableInstant(s.registrationClosesAt, 'registrationClosesAt'),
      startsAt: nullableInstant(s.startsAt, 'startsAt'),
      endsAt: nullableInstant(s.endsAt, 'endsAt'),
      timezone: timezoneOrThrow(s.timezone ?? competitionTimezone),
    };
    if (!['AUTO_CONFIRM', 'ORGANIZER_APPROVAL'].includes(r.registrationMode))
      throw new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid registration mode');
    ordered(r.registrationOpensAt, r.registrationClosesAt, 'registration window');
    ordered(r.startsAt, r.endsAt, 'event dates');
    return r;
  }

  private async assertWithinCompetition(
    ctx: TxContext,
    competitionId: string,
    startsAt: Date | null,
    endsAt: Date | null,
  ): Promise<string> {
    const { rows } = await sql<{ timezone: string; starts_at: Date | null; ends_at: Date | null }>`
      SELECT timezone, starts_at, ends_at FROM competition.competition_profile WHERE competition_id = ${competitionId}`.execute(
      ctx.trx,
    );
    const p = rows[0];
    if (p === undefined) throw new DomainError(DomainErrorCode.NOT_FOUND, 'competition not found');
    if (
      (startsAt !== null && p.starts_at !== null && startsAt < p.starts_at) ||
      (endsAt !== null && p.ends_at !== null && endsAt > p.ends_at)
    ) {
      throw new DomainError(
        DomainErrorCode.INVALID_INPUT,
        'event dates must fall within the competition dates',
      );
    }
    return p.timezone;
  }

  /**
   * Creates an Event pinned to EXACT, PUBLISHED DisciplineVersion and FormatVersion; the format
   * configuration is canonicalized against the FormatVersion schema and frozen with the event.
   */
  async createEvent(input: {
    actorAccountId: string;
    competitionId: string;
    slug: string;
    disciplineVersionId: string;
    formatVersionId: string;
    entrantKind?: 'INDIVIDUAL' | 'TEAM';
    formatConfig?: Record<string, unknown>;
    settings: EventSettingsInput;
    idempotencyKey: string;
  }): Promise<{ eventId: string; slug: string; created: boolean }> {
    const slug = slugOrThrow(input.slug);
    return this.tx(async (ctx) => {
      const c = await loadCompetition(ctx, input.competitionId);
      const s = this.settings(input.settings, 'UTC');
      const idem = await identityIdempotency<{ eventId: string; slug: string }>(ctx, {
        command: 'CreateEvent',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: {
          competitionId: c.id,
          slug,
          disciplineVersionId: input.disciplineVersionId,
          formatVersionId: input.formatVersionId,
          entrantKind: input.entrantKind,
          formatConfig: input.formatConfig ?? {},
          settings: input.settings,
        },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      await requireCompPermission(ctx, input.actorAccountId, c, 'COMP_EDIT');
      if (!competitionAcceptsEvents(c.status))
        throw transitionError('competition', c.status, 'add events to');
      const compTz = await this.assertWithinCompetition(ctx, c.id, s.startsAt, s.endsAt);
      const timezone = input.settings.timezone === undefined ? compTz : s.timezone;

      const dv = await loadDisciplineSpec(ctx, input.disciplineVersionId);
      if (dv.status !== 'PUBLISHED')
        throw new DomainError(DomainErrorCode.INVALID_INPUT, 'discipline version is not published');
      const { rows: fvRows } = await sql<{
        engine_id: string;
        engine_version: number;
        configuration_schema: Record<string, unknown>;
        status: string;
      }>`
        SELECT fv.engine_id, fv.engine_version, fv.configuration_schema, c.status FROM sports.format_version fv
        JOIN sports.v_format_version_current c ON c.format_version_id = fv.id WHERE fv.id = ${input.formatVersionId}`.execute(
        ctx.trx,
      );
      const fv = fvRows[0];
      if (fv === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'format version not found');
      if (fv.status !== 'PUBLISHED')
        throw new DomainError(DomainErrorCode.INVALID_INPUT, 'format version is not published');
      const engine = formatEngine(fv.engine_id, fv.engine_version);
      if (engine === undefined)
        throw new DomainError(
          DomainErrorCode.INVALID_INPUT,
          'format engine version is not available',
        );
      if (!dv.spec.allowedContestTypes.includes(engine.contestType)) {
        throw new DomainError(
          DomainErrorCode.INVALID_INPUT,
          `format produces ${engine.contestType} contests, which the discipline does not allow`,
        );
      }
      const kinds = dv.spec.participation.participantKinds;
      const entrantKind = input.entrantKind ?? (kinds.length === 1 ? kinds[0] : undefined);
      if (entrantKind === undefined || !kinds.includes(entrantKind)) {
        throw new DomainError(
          DomainErrorCode.INVALID_INPUT,
          `entrantKind must be one of ${kinds.join(', ')}`,
        );
      }
      let config: { config: Record<string, unknown>; configHash: string };
      try {
        config = canonicalFormatConfig(
          input.formatVersionId,
          fv.configuration_schema as never,
          input.formatConfig ?? {},
        );
      } catch (err) {
        throw new DomainError(
          DomainErrorCode.INVALID_INPUT,
          `invalid format configuration: ${(err as Error).message}`,
        );
      }

      await lockKeys(ctx, `event-slug:${c.id}:${slug}`);
      const { rows: taken } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM competition.event_slug WHERE competition_id = ${c.id} AND slug = ${slug}`.execute(
        ctx.trx,
      );
      if ((taken[0]?.n ?? 0) > 0)
        throw new DomainError(
          DomainErrorCode.SLUG_TAKEN,
          'slug is not available in this competition',
        );
      const id = newId();
      await sql`INSERT INTO competition.event (id, competition_id, discipline_version_id, format_version_id, entrant_kind, format_config, format_config_hash, created_by_account_id, recorded_at)
        VALUES (${id}, ${c.id}, ${input.disciplineVersionId}, ${input.formatVersionId}, ${entrantKind}, ${JSON.stringify(config.config)}::jsonb,
                ${config.configHash}, ${input.actorAccountId}, ${ctx.txTime})`.execute(ctx.trx);
      await sql`INSERT INTO competition.event_profile (event_id, name, category, capacity, registration_mode, registration_opens_at, registration_closes_at, starts_at, ends_at, timezone, updated_at, updated_by_account_id)
        VALUES (${id}, ${s.name}, ${JSON.stringify(s.category)}::jsonb, ${s.capacity}, ${s.registrationMode}, ${s.registrationOpensAt}, ${s.registrationClosesAt},
                ${s.startsAt}, ${s.endsAt}, ${timezone}, ${ctx.txTime}, ${input.actorAccountId})`.execute(
        ctx.trx,
      );
      await sql`INSERT INTO competition.event_slug (competition_id, slug, event_id, recorded_at) VALUES (${c.id}, ${slug}, ${id}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await sql`INSERT INTO competition.event_status_change (id, event_id, status, actor_account_id, recorded_at)
        VALUES (${newId()}, ${id}, 'DRAFT', ${input.actorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await refreshEventReadModels(ctx, id);
      await emitEvent(ctx, {
        eventType: 'EventCreated',
        aggregateType: 'EVENT',
        aggregateId: id as Uuid,
        payload: {
          competitionId: c.id,
          disciplineVersionId: input.disciplineVersionId,
          formatVersionId: input.formatVersionId,
          slug,
        },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'event.created',
        targetType: 'EVENT',
        targetId: id,
      });
      await idem.record({ eventId: id, slug });
      return { eventId: id, slug, created: true };
    });
  }

  /** Settings may change until the field is locked; capacity and mode only while DRAFT. */
  async updateEventSettings(input: {
    actorAccountId: string;
    eventId: string;
    settings: EventSettingsInput;
  }): Promise<void> {
    await this.tx(async (ctx) => {
      const e = await loadEvent(ctx, input.eventId);
      const c = await loadCompetition(ctx, e.competitionId);
      await requireCompPermission(ctx, input.actorAccountId, c, 'COMP_EDIT');
      if (!eventSettingsEditable(e.status)) throw transitionError('event', e.status, 'edited');
      const compTz = await this.assertWithinCompetition(ctx, c.id, null, null);
      const s = this.settings(input.settings, compTz);
      await this.assertWithinCompetition(ctx, c.id, s.startsAt, s.endsAt);
      if (
        !eventCapacityEditable(e.status) &&
        (s.capacity !== e.capacity || s.registrationMode !== e.registrationMode)
      ) {
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          'capacity and registration mode can only change while the event is DRAFT',
        );
      }
      await sql`UPDATE competition.event_profile SET name = ${s.name}, category = ${JSON.stringify(s.category)}::jsonb, capacity = ${s.capacity},
          registration_mode = ${s.registrationMode}, registration_opens_at = ${s.registrationOpensAt}, registration_closes_at = ${s.registrationClosesAt},
          starts_at = ${s.startsAt}, ends_at = ${s.endsAt}, timezone = ${s.timezone}, updated_at = ${ctx.txTime}, updated_by_account_id = ${input.actorAccountId}
        WHERE event_id = ${e.id}`.execute(ctx.trx);
      await refreshEventReadModels(ctx, e.id);
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'event.settings-updated',
        targetType: 'EVENT',
        targetId: e.id,
      });
    });
  }

  openRegistration(input: { actorAccountId: string; eventId: string }): Promise<void> {
    return this.setEventStatus(
      input.actorAccountId,
      input.eventId,
      'REGISTRATION_OPEN',
      'COMP_OPEN_REGISTRATION',
      'RegistrationOpened',
    );
  }

  closeRegistration(input: { actorAccountId: string; eventId: string }): Promise<void> {
    return this.setEventStatus(
      input.actorAccountId,
      input.eventId,
      'REGISTRATION_CLOSED',
      'COMP_CLOSE_REGISTRATION',
      'RegistrationClosed',
    );
  }

  /** Requires a generated plan and an ACTIVE competition. IN_PROGRESS ≠ official results. */
  startEvent(input: { actorAccountId: string; eventId: string }): Promise<void> {
    return this.setEventStatus(
      input.actorAccountId,
      input.eventId,
      'IN_PROGRESS',
      'COMP_EDIT',
      'EventStatusChanged',
    );
  }

  /** Organizer operation; never automatic. Completion does not mean results are final/verified. */
  completeEvent(input: { actorAccountId: string; eventId: string }): Promise<void> {
    return this.setEventStatus(
      input.actorAccountId,
      input.eventId,
      'COMPLETED',
      'COMP_EDIT',
      'EventStatusChanged',
    );
  }

  cancelEvent(input: { actorAccountId: string; eventId: string; reason: string }): Promise<void> {
    return this.setEventStatus(
      input.actorAccountId,
      input.eventId,
      'CANCELLED',
      'COMP_CANCEL',
      'EventStatusChanged',
      text(input.reason, 500, 'reason'),
    );
  }

  private setEventStatus(
    actor: string,
    eventId: string,
    to: EventStatus,
    permission: CompPermission,
    eventType: DomainEventType,
    reason?: string,
  ): Promise<void> {
    return this.tx(async (ctx) => {
      await lockKeys(ctx, `event-capacity:${eventId}`, `event-structure:${eventId}`);
      const e = await loadEvent(ctx, eventId);
      const c = await loadCompetition(ctx, e.competitionId);
      await requireCompPermission(ctx, actor, c, permission);
      if (!canTransition(EventLifecycle, e.status, to))
        throw transitionError('event', e.status, to);
      if (to === 'REGISTRATION_OPEN' && !['PUBLISHED', 'ACTIVE'].includes(c.status)) {
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          'the competition must be PUBLISHED or ACTIVE to open registration',
        );
      }
      if (to === 'IN_PROGRESS') {
        if (c.status !== 'ACTIVE')
          throw new DomainError(
            DomainErrorCode.INVALID_TRANSITION,
            'the competition must be ACTIVE to start an event',
          );
        const { rows } = await sql<{
          n: number;
        }>`SELECT count(*)::int AS n FROM competition.event_plan WHERE event_id = ${e.id}`.execute(
          ctx.trx,
        );
        if ((rows[0]?.n ?? 0) === 0)
          throw new DomainError(
            DomainErrorCode.INVALID_TRANSITION,
            'the event plan must be generated before the event starts',
          );
      }
      if (to === 'CANCELLED') await cancelEventFacts(ctx, e.id, actor, reason ?? 'event cancelled');
      else {
        await sql`INSERT INTO competition.event_status_change (id, event_id, status, reason, actor_account_id, recorded_at)
          VALUES (${newId()}, ${e.id}, ${to}, ${reason ?? null}, ${actor}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
      }
      await refreshEventReadModels(ctx, e.id);
      await emitEvent(ctx, {
        eventType,
        aggregateType: 'EVENT',
        aggregateId: e.id as Uuid,
        payload: { status: to },
      });
      await recordAudit(ctx, {
        actorAccountId: actor,
        action: `event.${to.toLowerCase().replace(/_/g, '-')}`,
        targetType: 'EVENT',
        targetId: e.id,
      });
    });
  }

  // ───────────────────────────── registration ─────────────────────────────

  private async assertEntrantControl(
    ctx: TxContext,
    accountId: string,
    r: { athleteId: string | null; teamId: string | null },
  ): Promise<void> {
    const ok =
      r.athleteId !== null
        ? await canActForAthlete(ctx, accountId, r.athleteId)
        : await isTeamManager(ctx, accountId, r.teamId as string);
    if (!ok) throw new DomainError(DomainErrorCode.FORBIDDEN, 'not permitted');
  }

  /**
   * Registers an Athlete (INDIVIDUAL) or a Team (TEAM) — never both. Capacity decisions are made
   * under the per-event lock the database capacity trigger also takes; AUTO_CONFIRM confirms while
   * capacity lasts and waitlists after, ORGANIZER_APPROVAL leaves the request REQUESTED.
   */
  async register(input: {
    actorAccountId: string;
    eventId: string;
    athleteId?: string;
    teamId?: string;
    eligibilityDeclared: boolean;
    idempotencyKey: string;
  }): Promise<{ registrationId: string; status: RegistrationStatus; created: boolean }> {
    if ((input.athleteId === undefined) === (input.teamId === undefined)) {
      throw new DomainError(
        DomainErrorCode.INVALID_INPUT,
        'register exactly one entrant: an athlete or a team',
      );
    }
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{
        registrationId: string;
        status: RegistrationStatus;
      }>(ctx, {
        command: 'Register',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: {
          eventId: input.eventId,
          athleteId: input.athleteId,
          teamId: input.teamId,
          eligibilityDeclared: input.eligibilityDeclared,
        },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      await lockKeys(ctx, `event-capacity:${input.eventId}`);
      const e = await loadEvent(ctx, input.eventId);
      if (e.status !== 'REGISTRATION_OPEN')
        throw new DomainError(DomainErrorCode.INVALID_TRANSITION, 'registration is not open');
      if (
        (e.registrationOpensAt !== null && ctx.txTime < e.registrationOpensAt) ||
        (e.registrationClosesAt !== null && ctx.txTime >= e.registrationClosesAt)
      ) {
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          'outside the registration window',
        );
      }
      const entrantType = input.athleteId !== undefined ? 'INDIVIDUAL' : 'TEAM';
      if (entrantType !== e.entrantKind)
        throw new DomainError(
          DomainErrorCode.INVALID_INPUT,
          `this event takes ${e.entrantKind} entrants`,
        );
      if (!input.eligibilityDeclared)
        throw new DomainError(
          DomainErrorCode.INVALID_INPUT,
          'the entrant must declare category eligibility',
        );
      await this.assertEntrantControl(ctx, input.actorAccountId, {
        athleteId: input.athleteId ?? null,
        teamId: input.teamId ?? null,
      });
      await this.assertNoOverlap(ctx, e, {
        athleteId: input.athleteId ?? null,
        teamId: input.teamId ?? null,
      });

      const registrationId = newId();
      try {
        await sql`INSERT INTO competition.registration (id, event_id, entrant_type, athlete_id, team_id, requested_by_account_id, eligibility_declared, recorded_at)
          VALUES (${registrationId}, ${e.id}, ${entrantType}, ${input.athleteId ?? null}, ${input.teamId ?? null}, ${input.actorAccountId}, true, ${ctx.txTime})`.execute(
          ctx.trx,
        );
      } catch (err) {
        mapCompetitionPgError(err);
      }
      await this.appendRegistrationStatus(
        ctx,
        registrationId,
        e.id,
        'REQUESTED',
        input.actorAccountId,
      );
      await emitEvent(ctx, {
        eventType: 'RegistrationRequested',
        aggregateType: 'REGISTRATION',
        aggregateId: registrationId as Uuid,
        payload: { eventId: e.id, entrantType },
      });
      let status: RegistrationStatus = 'REQUESTED';
      if (e.registrationMode === 'AUTO_CONFIRM') {
        status = (await this.hasCapacity(ctx, e)) ? 'CONFIRMED' : 'WAITLISTED';
        await this.appendRegistrationStatus(
          ctx,
          registrationId,
          e.id,
          status,
          input.actorAccountId,
          status === 'CONFIRMED' ? 'DECLARED' : null,
        );
        await emitEvent(ctx, {
          eventType: status === 'CONFIRMED' ? 'RegistrationConfirmed' : 'RegistrationWaitlisted',
          aggregateType: 'REGISTRATION',
          aggregateId: registrationId as Uuid,
          payload: { eventId: e.id },
        });
      }
      await refreshEventReadModels(ctx, e.id);
      const response = { registrationId, status };
      await idem.record(response);
      return { ...response, created: true };
    });
  }

  /** An athlete may hold only one active entry per event: individually or through one team. */
  private async assertNoOverlap(
    ctx: TxContext,
    e: EventRow,
    entrant: { athleteId: string | null; teamId: string | null },
  ): Promise<void> {
    const athletes =
      entrant.athleteId !== null
        ? [entrant.athleteId]
        : await activeTeamMembers(ctx, entrant.teamId as string, ctx.txTime);
    if (entrant.teamId !== null) {
      const { rows } = await sql<{
        spec: DisciplineVersionSpec;
      }>`SELECT spec FROM sports.discipline_version WHERE id = ${e.disciplineVersionId}`.execute(
        ctx.trx,
      );
      const min = rows[0]?.spec.participation.lineupSize.min ?? 1;
      if (athletes.length < min)
        throw new DomainError(
          DomainErrorCode.INVALID_INPUT,
          `the team needs at least ${min} active members`,
        );
    }
    if (athletes.length === 0) return;
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM competition.registration r
      JOIN competition.v_registration_current v ON v.registration_id = r.id
      WHERE r.event_id = ${e.id} AND v.status IN ('REQUESTED', 'WAITLISTED', 'CONFIRMED')
        AND (r.athlete_id IN (${sql.join(athletes)})
          OR (r.team_id IS NOT NULL AND r.team_id IS DISTINCT FROM ${entrant.teamId}
              AND EXISTS (SELECT 1 FROM competition.team_membership m
                          JOIN competition.v_team_membership_current mc ON mc.team_membership_id = m.id
                          WHERE m.team_id = r.team_id AND mc.status = 'ACTIVE' AND m.athlete_id IN (${sql.join(athletes)}))))`.execute(
      ctx.trx,
    );
    if ((rows[0]?.n ?? 0) > 0)
      throw new DomainError(
        DomainErrorCode.ALREADY_EXISTS,
        'an athlete of this entry is already entered in the event',
      );
  }

  private async hasCapacity(ctx: TxContext, e: EventRow): Promise<boolean> {
    if (e.capacity === null) return true;
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM competition.v_registration_current WHERE event_id = ${e.id} AND status = 'CONFIRMED'`.execute(
      ctx.trx,
    );
    return (rows[0]?.n ?? 0) < e.capacity;
  }

  private async appendRegistrationStatus(
    ctx: TxContext,
    registrationId: string,
    eventId: string,
    status: RegistrationStatus,
    actor: string,
    eligibilityBasis: 'DECLARED' | 'ORGANIZER_ACCEPTED' | null = null,
    reason: string | null = null,
  ): Promise<void> {
    try {
      await sql`INSERT INTO competition.registration_status_change (id, registration_id, event_id, status, eligibility_basis, reason, actor_account_id, recorded_at)
        VALUES (${newId()}, ${registrationId}, ${eventId}, ${status}, ${eligibilityBasis}, ${reason}, ${actor}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
    } catch (err) {
      mapCompetitionPgError(err);
    }
  }

  private async loadRegistration(ctx: TxContext, registrationId: string) {
    const { rows } = await sql<{
      event_id: string;
      athlete_id: string | null;
      team_id: string | null;
      status: RegistrationStatus;
    }>`
      SELECT r.event_id, r.athlete_id, r.team_id, v.status FROM competition.registration r
      JOIN competition.v_registration_current v ON v.registration_id = r.id WHERE r.id = ${registrationId}`.execute(
      ctx.trx,
    );
    if (rows[0] === undefined)
      throw new DomainError(DomainErrorCode.NOT_FOUND, 'registration not found');
    return {
      eventId: rows[0].event_id,
      athleteId: rows[0].athlete_id,
      teamId: rows[0].team_id,
      status: rows[0].status,
    };
  }

  /** Organizer decisions on a registration (COMP_MANAGE_REGISTRATIONS); only before the lock. */
  async decideRegistration(input: {
    actorAccountId: string;
    registrationId: string;
    decision: 'CONFIRM' | 'WAITLIST' | 'DECLINE' | 'CANCEL';
    reason?: string;
    idempotencyKey: string;
  }): Promise<{ registrationId: string; status: RegistrationStatus; created: boolean }> {
    const to: RegistrationStatus = (
      {
        CONFIRM: 'CONFIRMED',
        WAITLIST: 'WAITLISTED',
        DECLINE: 'DECLINED',
        CANCEL: 'CANCELLED',
      } as const
    )[input.decision];
    if (to === undefined) throw new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid decision');
    const reason = optionalText(input.reason, 500, 'reason');
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{
        registrationId: string;
        status: RegistrationStatus;
      }>(ctx, {
        command: 'DecideRegistration',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { registrationId: input.registrationId, decision: input.decision, reason },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      const pre = await this.loadRegistration(ctx, input.registrationId);
      await lockKeys(ctx, `event-capacity:${pre.eventId}`);
      const r = await this.loadRegistration(ctx, input.registrationId);
      const e = await loadEvent(ctx, r.eventId);
      await requireCompPermission(
        ctx,
        input.actorAccountId,
        await loadCompetition(ctx, e.competitionId),
        'COMP_MANAGE_REGISTRATIONS',
      );
      if (!['REGISTRATION_OPEN', 'REGISTRATION_CLOSED'].includes(e.status))
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          'registrations are frozen once the field is locked',
        );
      if (!canTransition(RegistrationLifecycle, r.status, to))
        throw transitionError('registration', r.status, to);
      if (to === 'CONFIRMED' && !(await this.hasCapacity(ctx, e)))
        throw new DomainError(DomainErrorCode.CAPACITY_REACHED, 'event capacity reached');
      await this.appendRegistrationStatus(
        ctx,
        input.registrationId,
        e.id,
        to,
        input.actorAccountId,
        to === 'CONFIRMED' ? 'ORGANIZER_ACCEPTED' : null,
        reason,
      );
      if (r.status === 'CONFIRMED') await this.promoteWaitlist(ctx, e, input.actorAccountId);
      await refreshEventReadModels(ctx, e.id);
      const eventType = (
        {
          CONFIRMED: 'RegistrationConfirmed',
          WAITLISTED: 'RegistrationWaitlisted',
          DECLINED: 'RegistrationDeclined',
          CANCELLED: 'RegistrationCancelled',
        } as const
      )[to as 'CONFIRMED'];
      await emitEvent(ctx, {
        eventType,
        aggregateType: 'REGISTRATION',
        aggregateId: input.registrationId as Uuid,
        payload: { eventId: e.id },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: `registration.${input.decision.toLowerCase()}`,
        targetType: 'REGISTRATION',
        targetId: input.registrationId,
      });
      const response = { registrationId: input.registrationId, status: to };
      await idem.record(response);
      return { ...response, created: true };
    });
  }

  /**
   * The entrant (or an organizer) withdraws before the field lock. A freed place is offered to the
   * earliest WAITLISTED entry automatically in AUTO_CONFIRM events. After the lock, registrations
   * are frozen — withdrawal is a Participant operation that never rewrites the bracket.
   */
  async withdrawRegistration(input: {
    actorAccountId: string;
    registrationId: string;
    idempotencyKey: string;
  }): Promise<{
    registrationId: string;
    status: RegistrationStatus;
    promotedRegistrationId: string | null;
    created: boolean;
  }> {
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{
        registrationId: string;
        status: RegistrationStatus;
        promotedRegistrationId: string | null;
      }>(ctx, {
        command: 'WithdrawRegistration',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { registrationId: input.registrationId },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      const pre = await this.loadRegistration(ctx, input.registrationId);
      await lockKeys(ctx, `event-capacity:${pre.eventId}`);
      const r = await this.loadRegistration(ctx, input.registrationId);
      const e = await loadEvent(ctx, r.eventId);
      const entrantControl =
        r.athleteId !== null
          ? await canActForAthlete(ctx, input.actorAccountId, r.athleteId)
          : await isTeamManager(ctx, input.actorAccountId, r.teamId as string);
      if (!entrantControl) {
        await requireCompPermission(
          ctx,
          input.actorAccountId,
          await loadCompetition(ctx, e.competitionId),
          'COMP_MANAGE_REGISTRATIONS',
        );
        await recordAudit(ctx, {
          actorAccountId: input.actorAccountId,
          action: 'registration.withdrawn-by-organizer',
          targetType: 'REGISTRATION',
          targetId: input.registrationId,
        });
      }
      if (!['REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'DRAFT'].includes(e.status)) {
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          'the field is locked: withdraw the participant instead',
        );
      }
      if (!canTransition(RegistrationLifecycle, r.status, 'WITHDRAWN'))
        throw transitionError('registration', r.status, 'WITHDRAWN');
      await this.appendRegistrationStatus(
        ctx,
        input.registrationId,
        e.id,
        'WITHDRAWN',
        input.actorAccountId,
      );
      await emitEvent(ctx, {
        eventType: 'RegistrationWithdrawn',
        aggregateType: 'REGISTRATION',
        aggregateId: input.registrationId as Uuid,
        payload: { eventId: e.id },
      });
      const promotedRegistrationId =
        r.status === 'CONFIRMED' ? await this.promoteWaitlist(ctx, e, input.actorAccountId) : null;
      await refreshEventReadModels(ctx, e.id);
      const response = {
        registrationId: input.registrationId,
        status: 'WITHDRAWN' as const,
        promotedRegistrationId,
      };
      await idem.record(response);
      return { ...response, created: true };
    });
  }

  /** FIFO promotion of the earliest waitlisted entry when a confirmed place frees (AUTO_CONFIRM). */
  private async promoteWaitlist(
    ctx: TxContext,
    e: EventRow,
    actor: string,
  ): Promise<string | null> {
    if (e.registrationMode !== 'AUTO_CONFIRM' || !(await this.hasCapacity(ctx, e))) return null;
    const { rows } = await sql<{ id: string }>`
      SELECT r.id FROM competition.registration r JOIN competition.v_registration_current v ON v.registration_id = r.id
      WHERE r.event_id = ${e.id} AND v.status = 'WAITLISTED' ORDER BY r.recorded_at, r.id LIMIT 1`.execute(
      ctx.trx,
    );
    const next = rows[0]?.id;
    if (next === undefined) return null;
    await this.appendRegistrationStatus(
      ctx,
      next,
      e.id,
      'CONFIRMED',
      actor,
      'DECLARED',
      'promoted from waitlist',
    );
    await emitEvent(ctx, {
      eventType: 'RegistrationConfirmed',
      aggregateType: 'REGISTRATION',
      aggregateId: next as Uuid,
      payload: { eventId: e.id, promotedFromWaitlist: true },
    });
    return next;
  }
}

/** Appends CANCELLED to an event and to its non-terminal contests (history is never deleted). */
async function cancelEventFacts(
  ctx: TxContext,
  eventId: string,
  actor: string,
  reason: string,
): Promise<void> {
  await sql`INSERT INTO competition.event_status_change (id, event_id, status, reason, actor_account_id, recorded_at)
    VALUES (${newId()}, ${eventId}, 'CANCELLED', ${reason}, ${actor}, ${ctx.txTime})`.execute(
    ctx.trx,
  );
  const { rows } = await sql<{ contest_id: string }>`
    SELECT c.id AS contest_id FROM competition.contest c JOIN competition.v_contest_current s ON s.contest_id = c.id
    WHERE c.event_id = ${eventId} AND s.status IN ('PLANNED', 'SCHEDULED') ORDER BY c.sequence`.execute(
    ctx.trx,
  );
  for (const r of rows) {
    await sql`INSERT INTO competition.contest_status_change (id, contest_id, status, reason, actor_account_id, recorded_at)
      VALUES (${newId()}, ${r.contest_id}, 'CANCELLED', ${reason}, ${actor}, ${ctx.txTime})`.execute(
      ctx.trx,
    );
  }
}

/** Active registration statuses (re-exported for callers). */
export const ACTIVE_ENTRY_STATUSES = ACTIVE_REGISTRATION_STATUSES;
