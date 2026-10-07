import type { AuthErrorCode } from './auth/messages';
import type { EventSummary } from './competition';
import { apiRequest, type ApiResult } from './platform';
import type { EventStatus, ManagedEvent } from './tournaments';

/**
 * ONCF-04 registration data. Shapes mirror the API (`RegistrationEntry` in @br/persistence); every
 * rule — who may register, window, capacity, duplicates, decisions — is decided by the API. The
 * helpers here only choose what to show: offered actions come from the API's `actions`, and the
 * public call-to-action is a display hint the registration command re-checks.
 */
export type RegistrationStatus =
  'REQUESTED' | 'WAITLISTED' | 'CONFIRMED' | 'DECLINED' | 'WITHDRAWN' | 'CANCELLED';
export type RegistrationDecision = 'CONFIRM' | 'WAITLIST' | 'DECLINE' | 'CANCEL';

export const REGISTRATION_STATUSES: readonly RegistrationStatus[] = [
  'REQUESTED',
  'WAITLISTED',
  'CONFIRMED',
  'DECLINED',
  'WITHDRAWN',
  'CANCELLED',
];

export interface Registration {
  id: string;
  status: RegistrationStatus;
  entrantType: 'INDIVIDUAL' | 'TEAM';
  athleteId: string | null;
  /** Named only when the athlete's profile is PUBLIC or AUTHENTICATED (else a private athlete). */
  athlete: { slug: string; displayName: string } | null;
  team: { id: string; name: string } | null;
  eligibilityBasis: 'DECLARED' | 'ORGANIZER_ACCEPTED' | null;
  reason: string | null;
  requestedAt: string;
  statusChangedAt: string;
  event: {
    id: string;
    slug: string;
    name: string;
    status: EventStatus;
    entrantKind: 'INDIVIDUAL' | 'TEAM';
    sport: { code: string; name: string };
    discipline: { code: string; name: string };
    format: { code: string; name: string };
    capacity: number | null;
    registrationMode: 'AUTO_CONFIRM' | 'ORGANIZER_APPROVAL';
    registrationClosesAt: string | null;
    startsAt: string | null;
    endsAt: string | null;
    timezone: string;
  };
  competition: {
    id: string;
    slug: string;
    name: string;
    status: string;
    startsAt: string | null;
    endsAt: string | null;
    timezone: string;
    locationLabel: string | null;
  };
  actions: { decisions: RegistrationDecision[]; withdraw: boolean };
}

export interface RegistrationDetail extends Registration {
  history: { status: RegistrationStatus; reason: string | null; recordedAt: string }[];
  viewer: { entrant: boolean; staff: boolean };
}

export interface RegistrationPage {
  items: Registration[];
  counts: Record<RegistrationStatus, number>;
  nextCursor: string | null;
  access: { permissions: string[] };
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ───────────────────────────── API ─────────────────────────────

export function myRegistrations(token: string): Promise<ApiResult<{ items: Registration[] }>> {
  return apiRequest(token, 'GET', '/v1/me/registrations');
}

export function registrationById(
  token: string,
  registrationId: string,
): Promise<ApiResult<RegistrationDetail>> {
  return apiRequest(token, 'GET', `/v1/registrations/${registrationId}`);
}

export interface RegistrationFilter {
  eventId?: string;
  status?: RegistrationStatus;
  after?: string;
}

/** Only well-formed filters are forwarded; anything else is dropped rather than echoed. */
export function registrationFilter(params: {
  category?: string | undefined;
  status?: string | undefined;
  after?: string | undefined;
}): RegistrationFilter {
  return {
    ...(params.category !== undefined && UUID_RE.test(params.category)
      ? { eventId: params.category }
      : {}),
    ...(params.status !== undefined &&
    (REGISTRATION_STATUSES as readonly string[]).includes(params.status)
      ? { status: params.status as RegistrationStatus }
      : {}),
    ...(params.after !== undefined && UUID_RE.test(params.after) ? { after: params.after } : {}),
  };
}

export function competitionRegistrations(
  token: string,
  competitionId: string,
  filter: RegistrationFilter = {},
): Promise<ApiResult<RegistrationPage>> {
  const q = new URLSearchParams();
  if (filter.eventId !== undefined) q.set('eventId', filter.eventId);
  if (filter.status !== undefined) q.set('status', filter.status);
  if (filter.after !== undefined) q.set('after', filter.after);
  q.set('limit', '50');
  return apiRequest(token, 'GET', `/v1/competitions/${competitionId}/registrations?${q}`);
}

// ───────────────────────────── vocabulary ─────────────────────────────

export const REGISTRATION_STATUS_LABEL: Record<RegistrationStatus, string> = {
  REQUESTED: 'Pending review',
  WAITLISTED: 'Waitlisted',
  CONFIRMED: 'Confirmed',
  DECLINED: 'Declined',
  WITHDRAWN: 'Withdrawn',
  CANCELLED: 'Cancelled',
};

/** What the status means for the athlete, and what happens next. */
export const REGISTRATION_STATUS_COPY: Record<RegistrationStatus, string> = {
  REQUESTED: 'The organizer reviews entries for this category. Your status updates here.',
  WAITLISTED: 'The category is full for now. If a place frees up, you can be moved into the field.',
  CONFIRMED: 'You’re in. Your place in this category is confirmed.',
  DECLINED: 'The organizer didn’t accept this entry.',
  WITHDRAWN: 'This entry was withdrawn.',
  CANCELLED: 'This entry was cancelled by the organizer.',
};

export const DECISION_LABEL: Record<RegistrationDecision, string> = {
  CONFIRM: 'Confirm',
  WAITLIST: 'Waitlist',
  DECLINE: 'Decline',
  CANCEL: 'Cancel entry',
};

/** Display hint: the category's confirmed entries reached its capacity (the API decides). */
export function categoryLooksFull(e: ManagedEvent | undefined): boolean {
  const cap = e?.settings.capacity;
  return e !== undefined && cap !== null && cap !== undefined && e.counts.confirmed >= cap;
}

/** Decisions that end an entry: asked to confirm, with an optional reason the athlete sees. */
export const FINAL_DECISIONS: readonly RegistrationDecision[] = ['DECLINE', 'CANCEL'];

// ───────────────────────────── public call-to-action ─────────────────────────────

export type RegistrationCta =
  | { kind: 'open' }
  | { kind: 'opens'; at: string }
  | { kind: 'closed' }
  | { kind: 'not_open' }
  | { kind: 'locked' }
  | { kind: 'in_progress' }
  | { kind: 'completed' }
  | { kind: 'cancelled' }
  | { kind: 'team' };

/**
 * The registration state a public page shows for a category, from its public lifecycle status and
 * window. A display hint only: the registration command re-checks status and window.
 */
export function registrationCta(
  event: Pick<EventSummary, 'status' | 'registration' | 'entrantKind'>,
  competitionStatus: string,
  now: Date,
): RegistrationCta {
  if (competitionStatus === 'CANCELLED' || event.status === 'CANCELLED')
    return { kind: 'cancelled' };
  switch (event.status) {
    case 'COMPLETED':
      return { kind: 'completed' };
    case 'IN_PROGRESS':
      return { kind: 'in_progress' };
    case 'FIELD_LOCKED':
      return { kind: 'locked' };
    case 'REGISTRATION_CLOSED':
      return { kind: 'closed' };
    case 'REGISTRATION_OPEN': {
      const { opensAt, closesAt } = event.registration;
      if (opensAt !== null && now < new Date(opensAt)) return { kind: 'opens', at: opensAt };
      if (closesAt !== null && now >= new Date(closesAt)) return { kind: 'closed' };
      // Team entry needs team formation, which this web app doesn't offer yet (ONCF-04 scope).
      if (event.entrantKind === 'TEAM') return { kind: 'team' };
      return { kind: 'open' };
    }
    default:
      return { kind: 'not_open' };
  }
}

export const CTA_COPY: Record<RegistrationCta['kind'], string> = {
  open: 'Registration open',
  opens: 'Registration opens soon',
  closed: 'Registration closed',
  not_open: 'Registration not open yet',
  locked: 'Entries closed · field set',
  in_progress: 'In play',
  completed: 'Completed',
  cancelled: 'Cancelled',
  team: 'Team entries',
};

/** `/app/register/<competition>/<category>`: the only registration entry point (auth-gated). */
export function registerPath(competitionSlug: string, eventSlug: string): string {
  return `/app/register/${competitionSlug}/${eventSlug}`;
}

// ───────────────────────────── athlete history ─────────────────────────────

export type RegistrationGroup = 'pending' | 'upcoming' | 'past' | 'closed';

export const GROUP_LABEL: Record<RegistrationGroup, string> = {
  pending: 'Pending',
  upcoming: 'Upcoming',
  past: 'Completed',
  closed: 'Other statuses',
};

/**
 * Groups by real status only: pending = REQUESTED / WAITLISTED; upcoming = CONFIRMED in a category
 * that hasn't completed (or been cancelled); completed = CONFIRMED in a completed category;
 * other statuses = DECLINED, WITHDRAWN, CANCELLED, or a confirmed entry whose category was cancelled.
 */
export function groupRegistrations(
  items: readonly Registration[],
): Record<RegistrationGroup, Registration[]> {
  const out: Record<RegistrationGroup, Registration[]> = {
    pending: [],
    upcoming: [],
    past: [],
    closed: [],
  };
  for (const r of items) {
    if (r.status === 'REQUESTED' || r.status === 'WAITLISTED') out.pending.push(r);
    else if (r.status === 'CONFIRMED' && r.event.status === 'COMPLETED') out.past.push(r);
    else if (r.status === 'CONFIRMED' && r.event.status !== 'CANCELLED') out.upcoming.push(r);
    else out.closed.push(r);
  }
  return out;
}

/** The active entry (REQUESTED / WAITLISTED / CONFIRMED) an athlete already holds in a category. */
export function activeEntry(
  items: readonly Registration[],
  eventId: string,
  athleteId: string,
): Registration | undefined {
  return items.find(
    (r) =>
      r.event.id === eventId &&
      r.athleteId === athleteId &&
      (r.status === 'REQUESTED' || r.status === 'WAITLISTED' || r.status === 'CONFIRMED'),
  );
}

/** Short registration reference for people (the full id stays in the URL). */
export function registrationRef(id: string): string {
  return id.replaceAll('-', '').slice(0, 8).toUpperCase();
}

// ───────────────────────────── errors ─────────────────────────────

/**
 * API refusal → message code for registration commands. Only codes the registration routes
 * actually return are mapped (BRT-05 store + DomainError → HTTP table); anything else falls back.
 *  - register: INVALID_TRANSITION = not open / outside the window; ALREADY_EXISTS = duplicate entry;
 *    INVALID_INPUT = wrong entrant kind or eligibility not declared; CAPACITY_REACHED (DB guard).
 *  - decide / withdraw: INVALID_TRANSITION = already decided, or frozen after the field lock;
 *    CAPACITY_REACHED = confirming into a full category.
 */
export function registrationErrorCode(
  result: Exclude<ApiResult<unknown>, { kind: 'ok' }>,
  command: 'register' | 'decide' | 'withdraw',
): AuthErrorCode {
  if (result.kind === 'unavailable' || result.kind === 'unauthenticated')
    return 'platform_unavailable';
  switch (result.code) {
    case 'ALREADY_EXISTS':
      return 'registration_duplicate';
    case 'CAPACITY_REACHED':
      return 'registration_full';
    case 'INVALID_TRANSITION':
      return command === 'register' ? 'registration_closed' : 'registration_transition';
    case 'INVALID_INPUT':
      return command === 'register' ? 'registration_invalid' : 'profile_invalid';
    case 'NOT_FOUND':
      return command === 'register' ? 'tournament_not_found' : 'registration_not_found';
    case 'FORBIDDEN':
      return command === 'register' ? 'registration_not_permitted' : 'not_permitted';
    default:
      if (result.status === 403)
        return command === 'register' ? 'registration_not_permitted' : 'not_permitted';
      return 'unknown';
  }
}
