import type { VerificationLevel } from './verification';

/**
 * BRT-09 Records vocabulary (BRT-01 verification model §7, §9; disputes §5.3; ADR-0043…0046).
 *
 *   Result ≠ Verification ≠ Achievement ≠ RecordCategory ≠ RecordMark ≠ Ranking ≠ Trophy
 *
 * A RecordCategory defines an exact comparison universe; a RecordMark is the append-only historical
 * fact that a qualifying mark held record standing in that universe. Record status is NEVER a
 * verification level: CANONICAL is a RecordMark status, not "V5". Every value here is a closed enum.
 */

/** BRT-01 §9.1 population.scopeType — structural; never derived from a label. */
export const RecordScopeType = {
  PERSONAL: 'PERSONAL',
  VENUE: 'VENUE',
  COMPETITION: 'COMPETITION',
  LEAGUE: 'LEAGUE',
  PLATFORM: 'PLATFORM',
  NATIONAL: 'NATIONAL',
  CONTINENTAL: 'CONTINENTAL',
  WORLD: 'WORLD',
} as const;
export type RecordScopeType = (typeof RecordScopeType)[keyof typeof RecordScopeType];
export const RECORD_SCOPE_TYPES = Object.values(RecordScopeType);

/**
 * BRT-09 v1 boundary (ADR-0043): PERSONAL records are the BRT-08 PERSONAL_BEST Achievement — no
 * PERSONAL RecordCategory / RecordMark exists (no second PB engine, no invented PERSONAL ratifier).
 */
export const RECORD_CATEGORY_SCOPE_TYPES: readonly RecordScopeType[] = RECORD_SCOPE_TYPES.filter(
  (s) => s !== 'PERSONAL',
);

/** Scopes whose record labels claim a geographic recognition level (BRT-01 §9.3). */
export const RECOGNIZED_LEVEL_SCOPES: readonly RecordScopeType[] = [
  'NATIONAL',
  'CONTINENTAL',
  'WORLD',
];

/** BRT-01 §9.2 RecordMark status. CANONICAL ≠ a verification level. */
export const RecordMarkStatus = {
  PENDING_RATIFICATION: 'PENDING_RATIFICATION',
  RATIFIED: 'RATIFIED',
  CANONICAL: 'CANONICAL',
  SUPERSEDED: 'SUPERSEDED',
  RESCINDED: 'RESCINDED',
} as const;
export type RecordMarkStatus = (typeof RecordMarkStatus)[keyof typeof RecordMarkStatus];
export const RECORD_MARK_STATUSES = Object.values(RecordMarkStatus);

/** Standing a validly ratified mark holds while it is (or is restored as) current. */
export type RecordStanding = Extract<RecordMarkStatus, 'RATIFIED' | 'CANONICAL'>;

/** Statuses presented as legitimate record honours (Record Hall of Fame, ADR-0046). */
export const LEGITIMATE_RECORD_STATUSES: readonly RecordMarkStatus[] = [
  'RATIFIED',
  'CANONICAL',
  'SUPERSEDED',
];

/** BRT-01 §9.1 comparator tie policy. */
export const TiePolicy = { SHARED: 'SHARED', FIRST_ACHIEVED: 'FIRST_ACHIEVED' } as const;
export type TiePolicy = (typeof TiePolicy)[keyof typeof TiePolicy];

/** Lifecycle of an immutable RecordCategoryVersion (no row = DRAFT). */
export const RecordCategoryLifecycle = {
  DRAFT: 'DRAFT',
  PUBLISHED: 'PUBLISHED',
  RETIRED: 'RETIRED',
} as const;
export type RecordCategoryLifecycle =
  (typeof RecordCategoryLifecycle)[keyof typeof RecordCategoryLifecycle];

/** The five outcome states of the pure record engine (never a probability or score). */
export const RecordEvaluationState = {
  QUALIFIES: 'QUALIFIES',
  DOES_NOT_QUALIFY: 'DOES_NOT_QUALIFY',
  PENDING_REQUIRED_FACTS: 'PENDING_REQUIRED_FACTS',
  INELIGIBLE: 'INELIGIBLE',
  INTEGRITY_FAILURE: 'INTEGRITY_FAILURE',
} as const;
export type RecordEvaluationState =
  (typeof RecordEvaluationState)[keyof typeof RecordEvaluationState];

/** Where the facts of a record evaluation came from. Only CANONICAL_ASSEMBLY reaches a normal DB. */
export const RecordProvenance = {
  CANONICAL_ASSEMBLY: 'CANONICAL_ASSEMBLY',
  REFERENCE_FIXTURE: 'REFERENCE_FIXTURE',
} as const;
export type RecordProvenance = (typeof RecordProvenance)[keyof typeof RecordProvenance];

/**
 * Where a ratification fact came from. CANONICAL_ATTESTATION would be a BRT-06 RECORD_RATIFIED /
 * REVIEW_COMPLETED attestation — whose producer does NOT exist yet (deferred BRT-06R; the BRT-06
 * schema admits neither claim type). REFERENCE_FIXTURE ratifications exist only in engine fixtures
 * and throwaway persistence databases.
 */
export const RatificationProvenance = {
  CANONICAL_ATTESTATION: 'CANONICAL_ATTESTATION',
  REFERENCE_FIXTURE: 'REFERENCE_FIXTURE',
} as const;
export type RatificationProvenance =
  (typeof RatificationProvenance)[keyof typeof RatificationProvenance];

/** BRT-01 V4 attestation kinds a recognizing authority ratifies with. */
export const RatificationKind = {
  RECORD_RATIFIED: 'RECORD_RATIFIED',
  REVIEW_COMPLETED: 'REVIEW_COMPLETED',
} as const;
export type RatificationKind = (typeof RatificationKind)[keyof typeof RatificationKind];

/**
 * Canonical input kinds of a record evaluation. A snapshot declares which kinds its producer
 * supports; anything required but unsupported is PENDING_REQUIRED_FACTS (never defaulted, never
 * inferred — absence of handicap data is NOT "scratch", absence of hold facts is NOT "no hold").
 *   RESULT_STATUS          append-only lifecycle transitions                           (produced)
 *   VERIFICATION           BRT-07 current run + hash-based freshness                   (produced)
 *   CONTEST_OCCURRENCE     contest start = the sporting effective time                 (produced)
 *   COMPETITION_MEMBERSHIP the immutable Result → Contest → Event → Competition path   (produced)
 *   HOLD_STATE             admitted-dispute holds                                      (NO producer)
 *   POPULATION             typed population category facts (handicap mode, gender…)  (NO producer)
 *   CONDITIONS             authority-evaluated condition facts (wind, lane…)           (NO producer)
 *   VENUE_MEMBERSHIP       canonical venue of the contest (schedule venue is operational) (NO producer)
 *   LEAGUE_MEMBERSHIP      canonical league of the competition                         (NO producer)
 *   REGION_ELIGIBILITY     eligibility for a national / continental record population  (NO producer)
 *   CREDITED_LINEUP        credited lineup inside Result content (ADR-0026)            (NO producer)
 *   RATIFICATION           RECORD_RATIFIED / REVIEW_COMPLETED facts (deferred BRT-06R) (NO producer)
 *   PARTICIPATION          ratifier conflict-of-interest facts                         (NO producer)
 */
export const RecordFactKind = {
  RESULT_STATUS: 'RESULT_STATUS',
  VERIFICATION: 'VERIFICATION',
  CONTEST_OCCURRENCE: 'CONTEST_OCCURRENCE',
  COMPETITION_MEMBERSHIP: 'COMPETITION_MEMBERSHIP',
  HOLD_STATE: 'HOLD_STATE',
  POPULATION: 'POPULATION',
  CONDITIONS: 'CONDITIONS',
  VENUE_MEMBERSHIP: 'VENUE_MEMBERSHIP',
  LEAGUE_MEMBERSHIP: 'LEAGUE_MEMBERSHIP',
  REGION_ELIGIBILITY: 'REGION_ELIGIBILITY',
  CREDITED_LINEUP: 'CREDITED_LINEUP',
  RATIFICATION: 'RATIFICATION',
  PARTICIPATION: 'PARTICIPATION',
} as const;
export type RecordFactKind = (typeof RecordFactKind)[keyof typeof RecordFactKind];
export const ALL_RECORD_FACT_KINDS = Object.values(RecordFactKind);

/** Kinds today's canonical producers emit (the honest production ceiling, ADR-0035 / ADR-0044). */
export const PRODUCTION_SUPPORTED_RECORD_FACT_KINDS: readonly RecordFactKind[] = [
  'RESULT_STATUS',
  'VERIFICATION',
  'CONTEST_OCCURRENCE',
  'COMPETITION_MEMBERSHIP',
];

/** Bounded population dimensions (BRT-01 §9.1 population.category) — never free JSON. */
export const PopulationDimension = {
  HANDICAP_MODE: 'HANDICAP_MODE',
  GENDER_CATEGORY: 'GENDER_CATEGORY',
  AGE_GROUP: 'AGE_GROUP',
  WEIGHT_CLASS: 'WEIGHT_CLASS',
  EQUIPMENT_CLASS: 'EQUIPMENT_CLASS',
} as const;
export type PopulationDimension = (typeof PopulationDimension)[keyof typeof PopulationDimension];

export const HandicapMode = { SCRATCH: 'SCRATCH', HANDICAP: 'HANDICAP' } as const;
export type HandicapMode = (typeof HandicapMode)[keyof typeof HandicapMode];

export interface RecordConsequenceFloor {
  readonly minimumVerificationLevel: VerificationLevel;
  readonly minimumResultStatus: 'OFFICIAL' | 'FINAL';
  readonly holdBlocks: true;
  /**
   * BRT-01 §7 PLATFORM alternative: "V3, or V2 + platform review". The ONLY scope where a lower
   * level is admissible, and only together with a REVIEW_COMPLETED by the platform review panel.
   */
  readonly reviewAlternative?: VerificationLevel;
}

/**
 * BRT-01 §7 downstream permission matrix — the PLATFORM FLOOR per record scope. A category may raise
 * it, never lower it (publication and the engine both enforce this).
 */
export const RECORD_PLATFORM_FLOOR: Readonly<Record<RecordScopeType, RecordConsequenceFloor>> = {
  PERSONAL: { minimumVerificationLevel: 'V2', minimumResultStatus: 'OFFICIAL', holdBlocks: true },
  VENUE: { minimumVerificationLevel: 'V3', minimumResultStatus: 'FINAL', holdBlocks: true },
  COMPETITION: { minimumVerificationLevel: 'V3', minimumResultStatus: 'FINAL', holdBlocks: true },
  LEAGUE: { minimumVerificationLevel: 'V3', minimumResultStatus: 'FINAL', holdBlocks: true },
  PLATFORM: {
    minimumVerificationLevel: 'V3',
    minimumResultStatus: 'FINAL',
    holdBlocks: true,
    reviewAlternative: 'V2',
  },
  NATIONAL: { minimumVerificationLevel: 'V4', minimumResultStatus: 'FINAL', holdBlocks: true },
  CONTINENTAL: { minimumVerificationLevel: 'V4', minimumResultStatus: 'FINAL', holdBlocks: true },
  WORLD: { minimumVerificationLevel: 'V4', minimumResultStatus: 'FINAL', holdBlocks: true },
};

/** Public scope wording (the model — not copywriting — decides every record label, BRT-01 §9.3). */
export const RECORD_SCOPE_LABEL: Readonly<Record<RecordScopeType, string>> = {
  PERSONAL: 'Personal best',
  VENUE: 'Venue record',
  COMPETITION: 'Competition record',
  LEAGUE: 'League record',
  PLATFORM: 'Bragging Rights platform best',
  NATIONAL: 'National record',
  CONTINENTAL: 'Continental record',
  WORLD: 'World record',
};

export const RECORD_STATUS_LABEL: Readonly<Record<RecordMarkStatus, string>> = {
  PENDING_RATIFICATION: 'Pending ratification',
  RATIFIED: 'Ratified',
  CANONICAL: 'Canonical (official registry)',
  SUPERSEDED: 'Former record',
  RESCINDED: 'Rescinded',
};
