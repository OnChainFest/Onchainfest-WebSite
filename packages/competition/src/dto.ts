import type { EventCategory } from './category';
import type { ContestType, ParticipantKind } from './catalog';
import type { RoundType } from './format/engine';
import type {
  CompetitionStatus,
  ContestStatus,
  EventStatus,
  ParticipantStatus,
  RegistrationStatus,
} from './lifecycle';

/**
 * Public DTOs (BRT-05). Built only from public-safe projections plus the Athlete Passport's public
 * card. They never contain account ids, auth subjects, person ids, legal names, DOB, contact data,
 * guardian data, private wallets or private external identifiers.
 *
 * Everything here is OPERATIONAL. Sporting truth (results, standings, champions, records) is not
 * part of these DTOs: `results` is always NOT_AVAILABLE in BRT-05 — never an empty podium.
 */
export const PUBLIC_COMPETITION_SCHEMA = 'br:public-competition@1';
export const PUBLIC_EVENT_SCHEMA = 'br:public-event@1';

export interface NotAvailable {
  readonly status: 'NOT_AVAILABLE';
  readonly reason: 'SOURCE_NOT_IMPLEMENTED';
}

/** How an entrant is displayed publicly. Private/restricted athletes are never named. */
export type PublicEntrantDisplay =
  | { readonly kind: 'ATHLETE'; readonly athleteSlug: string; readonly displayName: string }
  | { readonly kind: 'TEAM'; readonly teamName: string }
  | { readonly kind: 'PRIVATE_ENTRANT' };

export interface PublicEventSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: EventStatus;
  readonly sport: { readonly code: string; readonly name: string };
  readonly discipline: { readonly code: string; readonly name: string; readonly version: number };
  readonly format: {
    readonly code: string;
    readonly name: string;
    readonly version: number;
    readonly engine: string;
  };
  readonly category: EventCategory;
  readonly capacity: number | null;
  readonly confirmedCount: number;
  readonly waitlistCount: number;
  readonly participantCount: number;
  readonly registration: { readonly opensAt: string | null; readonly closesAt: string | null };
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly timezone: string;
}

export interface PublicCompetitionV1 {
  readonly schema: typeof PUBLIC_COMPETITION_SCHEMA;
  readonly competition: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly description: string | null;
    readonly status: CompetitionStatus;
    readonly timezone: string;
    readonly startsAt: string | null;
    readonly endsAt: string | null;
    readonly locationLabel: string | null;
    readonly organizer: {
      readonly organizationId: string;
      readonly slug: string | null;
      readonly displayName: string | null;
    };
  };
  readonly events: readonly PublicEventSummary[];
  /** Organizing a competition confers no sports authority. */
  readonly authority: NotAvailable;
}

export interface PublicEntry {
  readonly participantId: string | null;
  readonly kind: ParticipantKind;
  readonly registrationStatus: RegistrationStatus;
  readonly participantStatus: ParticipantStatus | null;
  readonly seed: number | null;
  readonly display: PublicEntrantDisplay;
}

export type PublicSlot =
  | {
      readonly slot: number;
      readonly kind: 'PARTICIPANT';
      readonly participantId: string;
      readonly display: PublicEntrantDisplay;
    }
  | {
      readonly slot: number;
      readonly kind: 'WINNER_OF_CONTEST' | 'LOSER_OF_CONTEST';
      /** Unresolved dependency: shown as "TBD" by presentation layers; never a fabricated name. */
      readonly contestId: string;
      readonly contestSequence: number;
      readonly resolved: false;
    };

export interface PublicContest {
  readonly contestId: string;
  readonly sequence: number;
  readonly contestType: ContestType;
  readonly status: ContestStatus;
  readonly round: {
    readonly sequence: number;
    readonly label: string;
    readonly roundType: RoundType;
  };
  readonly scheduledStart: string | null;
  readonly scheduledEnd: string | null;
  readonly locationLabel: string | null;
  readonly courtLabel: string | null;
  readonly venue: {
    readonly organizationId: string;
    readonly slug: string | null;
    readonly displayName: string | null;
  } | null;
  readonly slots: readonly PublicSlot[];
  /** Contest status is operational; results are a separate (not yet implemented) domain. */
  readonly result: NotAvailable;
}

export interface PublicStructureRound {
  readonly sequence: number;
  readonly label: string;
  readonly roundType: RoundType;
  readonly byes: readonly {
    readonly participantId: string;
    readonly display: PublicEntrantDisplay;
  }[];
  readonly contests: readonly PublicContest[];
}

export interface PublicEventV1 {
  readonly schema: typeof PUBLIC_EVENT_SCHEMA;
  readonly competition: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly status: CompetitionStatus;
  };
  readonly event: PublicEventSummary;
  readonly field: { readonly locked: boolean; readonly fieldHash: string | null };
  readonly seeding: {
    readonly method: 'MANUAL' | 'DETERMINISTIC_DRAW';
    readonly drawAlgorithm: string | null;
    readonly drawSeed: string | null;
    readonly seedingHash: string;
  } | null;
  readonly plan: {
    readonly engine: string;
    readonly inputHash: string;
    readonly planHash: string;
    readonly generatedAt: string;
  } | null;
  readonly results: NotAvailable;
  readonly standings: NotAvailable;
}
