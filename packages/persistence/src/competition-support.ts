import {
  compPermissionsFor,
  ORGANIZER_ROLE_TO_STAFF_ROLE,
  type CompPermission,
  type CompetitionStatus,
  type EventStatus,
  type StaffRole,
} from '@br/competition';
import { DomainError, DomainErrorCode } from '@br/domain';
import { hasControlCharacters, normalizeSlug } from '@br/identity';
import { sql } from 'kysely';
import { activeOrgRoles, loadControlFacts, recordAudit } from './identity-support';
import type { TxContext } from './tx';

// ───────────────────────────── input safety ─────────────────────────────

export function text(
  value: string,
  max: number,
  what: string,
  options: { multiline?: boolean } = {},
): string {
  const v = value.normalize('NFC').trim();
  if (v.length === 0 || v.length > max)
    throw new DomainError(DomainErrorCode.INVALID_INPUT, `${what} must be 1–${max} characters`);
  if (hasControlCharacters(v, { allowNewline: options.multiline === true })) {
    throw new DomainError(DomainErrorCode.INVALID_INPUT, `${what} contains control characters`);
  }
  return v;
}

export function optionalText(
  value: string | null | undefined,
  max: number,
  what: string,
  options: { multiline?: boolean } = {},
): string | null {
  return value === null || value === undefined ? null : text(value, max, what, options);
}

export function slugOrThrow(input: string): string {
  const r = normalizeSlug(input);
  if (!r.ok)
    throw new DomainError(
      DomainErrorCode.SLUG_INVALID,
      r.reason === 'RESERVED' ? 'slug is reserved' : 'slug is invalid',
    );
  return r.slug;
}

/** IANA timezone identifier (validated by the runtime's tz database). */
export function timezoneOrThrow(tz: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(tz))
    throw new DomainError(DomainErrorCode.INVALID_INPUT, 'timezone must be an IANA identifier');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new DomainError(DomainErrorCode.INVALID_INPUT, 'unknown IANA timezone');
  }
  return tz;
}

/** Accepts Date or ISO-8601 with an explicit offset/Z (never a naive local timestamp). */
export function instantOrThrow(value: Date | string, what: string): Date {
  if (
    typeof value === 'string' &&
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    throw new DomainError(
      DomainErrorCode.INVALID_INPUT,
      `${what} must be an ISO-8601 instant with a UTC offset`,
    );
  }
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 2000 || d.getUTCFullYear() > 2200) {
    throw new DomainError(DomainErrorCode.INVALID_INPUT, `${what} is not a valid instant`);
  }
  return d;
}

export function httpsUrl(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!/^https:\/\/[^\s<>"]{3,250}$/.test(value))
    throw new DomainError(DomainErrorCode.INVALID_INPUT, 'website must be an https URL');
  return value;
}

// ───────────────────────────── status helpers ─────────────────────────────

export async function currentStatus(
  ctx: TxContext,
  view: string,
  idColumn: string,
  id: string,
): Promise<string | undefined> {
  const { rows } = await sql<{
    status: string;
  }>`SELECT status FROM ${sql.raw(view)} WHERE ${sql.ref(idColumn)} = ${id}`.execute(ctx.trx);
  return rows[0]?.status;
}

export interface CompetitionRow {
  readonly id: string;
  readonly organizerOrganizationId: string;
  readonly status: CompetitionStatus;
}

export async function loadCompetition(
  ctx: TxContext,
  competitionId: string,
): Promise<CompetitionRow> {
  const { rows } = await sql<{
    id: string;
    organizer_organization_id: string;
    status: CompetitionStatus;
  }>`
    SELECT c.id, c.organizer_organization_id, s.status
    FROM competition.competition c JOIN competition.v_competition_current s ON s.competition_id = c.id
    WHERE c.id = ${competitionId}`.execute(ctx.trx);
  const r = rows[0];
  if (r === undefined) throw new DomainError(DomainErrorCode.NOT_FOUND, 'competition not found');
  return { id: r.id, organizerOrganizationId: r.organizer_organization_id, status: r.status };
}

export interface EventRow {
  readonly id: string;
  readonly competitionId: string;
  readonly status: EventStatus;
  readonly entrantKind: 'INDIVIDUAL' | 'TEAM';
  readonly disciplineVersionId: string;
  readonly formatVersionId: string;
  readonly formatConfig: Record<string, unknown>;
  readonly formatConfigHash: string;
  readonly capacity: number | null;
  readonly registrationMode: 'AUTO_CONFIRM' | 'ORGANIZER_APPROVAL';
  readonly registrationOpensAt: Date | null;
  readonly registrationClosesAt: Date | null;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
}

export async function loadEvent(ctx: TxContext, eventId: string): Promise<EventRow> {
  const { rows } = await sql<{
    id: string;
    competition_id: string;
    status: EventStatus;
    entrant_kind: 'INDIVIDUAL' | 'TEAM';
    discipline_version_id: string;
    format_version_id: string;
    format_config: Record<string, unknown>;
    format_config_hash: string;
    capacity: number | null;
    registration_mode: 'AUTO_CONFIRM' | 'ORGANIZER_APPROVAL';
    registration_opens_at: Date | null;
    registration_closes_at: Date | null;
    starts_at: Date | null;
    ends_at: Date | null;
  }>`
    SELECT e.id, e.competition_id, s.status, e.entrant_kind, e.discipline_version_id, e.format_version_id, e.format_config,
           e.format_config_hash, p.capacity, p.registration_mode, p.registration_opens_at, p.registration_closes_at, p.starts_at, p.ends_at
    FROM competition.event e
    JOIN competition.v_event_current s ON s.event_id = e.id
    JOIN competition.event_profile p ON p.event_id = e.id
    WHERE e.id = ${eventId}`.execute(ctx.trx);
  const r = rows[0];
  if (r === undefined) throw new DomainError(DomainErrorCode.NOT_FOUND, 'event not found');
  return {
    id: r.id,
    competitionId: r.competition_id,
    status: r.status,
    entrantKind: r.entrant_kind,
    disciplineVersionId: r.discipline_version_id,
    formatVersionId: r.format_version_id,
    formatConfig: r.format_config,
    formatConfigHash: r.format_config_hash,
    capacity: r.capacity,
    registrationMode: r.registration_mode,
    registrationOpensAt: r.registration_opens_at,
    registrationClosesAt: r.registration_closes_at,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
  };
}

// ───────────────────────────── operational permissions ─────────────────────────────

/**
 * Application permissions of an account on a competition: explicit ACTIVE staff roles of the
 * account's SELF person, plus OWNER/ADMIN of the (ACTIVE) organizer organization. Never derived
 * from, and never producing, Authority capabilities.
 */
export async function competitionPermissions(
  ctx: TxContext,
  accountId: string,
  competition: Pick<CompetitionRow, 'id' | 'organizerOrganizationId'>,
): Promise<{ staffRoles: StaffRole[]; permissions: ReadonlySet<CompPermission> }> {
  const facts = await loadControlFacts(ctx, accountId);
  if (!facts.accountActive || facts.selfPersonId === undefined)
    return { staffRoles: [], permissions: new Set() };
  const orgRoles = await activeOrgRoles(ctx, accountId, competition.organizerOrganizationId);
  const fromOrg = orgRoles.flatMap((r) => {
    const mapped = ORGANIZER_ROLE_TO_STAFF_ROLE[r];
    return mapped === undefined ? [] : [mapped];
  });
  const { rows } = await sql<{ staff_role: StaffRole }>`
    SELECT s.staff_role FROM competition.competition_staff s
    JOIN competition.v_staff_current v ON v.staff_id = s.id
    WHERE s.competition_id = ${competition.id} AND s.person_id = ${facts.selfPersonId} AND v.status = 'ACTIVE'`.execute(
    ctx.trx,
  );
  const staffRoles = [
    ...new Set([...fromOrg, ...rows.map((r) => r.staff_role)]),
  ].sort() as StaffRole[];
  return { staffRoles, permissions: compPermissionsFor(staffRoles) };
}

export async function requireCompPermission(
  ctx: TxContext,
  accountId: string,
  competition: Pick<CompetitionRow, 'id' | 'organizerOrganizationId'>,
  permission: CompPermission,
): Promise<void> {
  const { permissions } = await competitionPermissions(ctx, accountId, competition);
  if (!permissions.has(permission)) {
    await recordAudit(ctx, {
      actorAccountId: accountId,
      action: `competition.${permission}`,
      targetType: 'COMPETITION',
      targetId: competition.id,
      outcome: 'DENIED',
    });
    throw new DomainError(DomainErrorCode.FORBIDDEN, 'not permitted');
  }
}

/** Throws INVALID_TRANSITION with a stable message. */
export function transitionError(kind: string, from: string | undefined, to: string): DomainError {
  return new DomainError(
    DomainErrorCode.INVALID_TRANSITION,
    `cannot move a ${from ?? 'missing'} ${kind} to ${to}`,
  );
}
