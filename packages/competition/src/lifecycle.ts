/**
 * Operational lifecycles (BRT-05). Every status here is OPERATIONAL: none of them states that a
 * sporting result is final, verified, recorded or prize-bearing. In particular:
 *  - Competition COMPLETED ⇏ every Result FINAL/VERIFIED;
 *  - Event IN_PROGRESS / COMPLETED ⇏ official results;
 *  - Contest COMPLETED means the activity ended operationally — nothing about its Result.
 * Status histories are append-only; a transition not listed here is rejected.
 */
export interface Lifecycle<S extends string> {
  readonly name: string;
  readonly states: readonly S[];
  /** Statuses a new aggregate may start in. */
  readonly initial: readonly S[];
  readonly transitions: Readonly<Record<S, readonly S[]>>;
}

export function canTransition<S extends string>(lc: Lifecycle<S>, from: S, to: S): boolean {
  return lc.transitions[from]?.includes(to) ?? false;
}

export function isTerminal<S extends string>(lc: Lifecycle<S>, s: S): boolean {
  return (lc.transitions[s]?.length ?? 0) === 0;
}

const lifecycle = <S extends string>(
  name: string,
  initial: readonly S[],
  transitions: Record<S, readonly S[]>,
): Lifecycle<S> => ({
  name,
  states: Object.keys(transitions) as S[],
  initial,
  transitions,
});

export type CompetitionStatus = 'DRAFT' | 'PUBLISHED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
export const CompetitionLifecycle = lifecycle<CompetitionStatus>('competition', ['DRAFT'], {
  DRAFT: ['PUBLISHED', 'CANCELLED'],
  PUBLISHED: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
});

export type EventStatus =
  | 'DRAFT'
  | 'REGISTRATION_OPEN'
  | 'REGISTRATION_CLOSED'
  | 'FIELD_LOCKED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED';
export const EventLifecycle = lifecycle<EventStatus>('event', ['DRAFT'], {
  DRAFT: ['REGISTRATION_OPEN', 'CANCELLED'],
  REGISTRATION_OPEN: ['REGISTRATION_CLOSED', 'CANCELLED'],
  // Re-opening is allowed before the field is locked.
  REGISTRATION_CLOSED: ['REGISTRATION_OPEN', 'FIELD_LOCKED', 'CANCELLED'],
  // FIELD_LOCKED: the participant field is frozen; no path back to registration.
  FIELD_LOCKED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
});

export type RegistrationStatus =
  'REQUESTED' | 'WAITLISTED' | 'CONFIRMED' | 'DECLINED' | 'WITHDRAWN' | 'CANCELLED';
export const RegistrationLifecycle = lifecycle<RegistrationStatus>('registration', ['REQUESTED'], {
  REQUESTED: ['CONFIRMED', 'WAITLISTED', 'DECLINED', 'WITHDRAWN'],
  WAITLISTED: ['CONFIRMED', 'DECLINED', 'WITHDRAWN'],
  CONFIRMED: ['WITHDRAWN', 'CANCELLED'],
  DECLINED: [],
  WITHDRAWN: [],
  CANCELLED: [],
});

/** Registration statuses that hold (or compete for) a place in the field. */
export const ACTIVE_REGISTRATION_STATUSES: readonly RegistrationStatus[] = [
  'REQUESTED',
  'WAITLISTED',
  'CONFIRMED',
];

export type ContestStatus =
  'PLANNED' | 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'VOID';
export const ContestLifecycle = lifecycle<ContestStatus>('contest', ['PLANNED'], {
  PLANNED: ['SCHEDULED', 'CANCELLED'],
  // Re-scheduling keeps SCHEDULED (a schedule update, not a transition).
  SCHEDULED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'VOID'],
  // VOID: operational annulment of a played contest; decides no result.
  COMPLETED: ['VOID'],
  CANCELLED: [],
  VOID: [],
});

export type ParticipantStatus = 'ACTIVE' | 'WITHDRAWN' | 'DISQUALIFIED';
export const ParticipantLifecycle = lifecycle<ParticipantStatus>('participant', ['ACTIVE'], {
  ACTIVE: ['WITHDRAWN', 'DISQUALIFIED'],
  WITHDRAWN: [],
  // Operational exclusion with a mandatory reason/reference — NOT a verified sporting sanction.
  DISQUALIFIED: [],
});

export type TeamMembershipStatus = 'PROPOSED' | 'ACTIVE' | 'DECLINED' | 'ENDED';
export const TeamMembershipLifecycle = lifecycle<TeamMembershipStatus>(
  'team-membership',
  ['PROPOSED', 'ACTIVE'],
  {
    PROPOSED: ['ACTIVE', 'DECLINED'],
    ACTIVE: ['ENDED'],
    DECLINED: [],
    ENDED: [],
  },
);

export type StaffStatus = 'ACTIVE' | 'ENDED';
export const StaffLifecycle = lifecycle<StaffStatus>('competition-staff', ['ACTIVE'], {
  ACTIVE: ['ENDED'],
  ENDED: [],
});

export type CatalogVersionStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED';
/** Catalog versions: content is immutable from creation; PUBLISHED versions may be pinned. */
export const CatalogVersionLifecycle = lifecycle<CatalogVersionStatus>(
  'catalog-version',
  ['DRAFT'],
  {
    DRAFT: ['PUBLISHED', 'RETIRED'],
    // Retiring a published version stops new events from pinning it; pinned events are unaffected.
    PUBLISHED: ['RETIRED'],
    RETIRED: [],
  },
);
