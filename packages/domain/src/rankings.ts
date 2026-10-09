import type { VerificationLevel } from './verification';

/**
 * BRT-10 Rankings & Qualification vocabulary (BRT-01 result domain §6.1, verification model §7, §8.2,
 * §10; disputes §5.1–5.2; BRT-02 persistence §6; ADR-0047…0050).
 *
 *   Result ≠ Classification (a derived ResultVersion) ≠ RankingSnapshot ≠ Achievement ≠ Record
 *
 * A RankingSnapshot is a separate, immutable, derived artefact: it is NEVER a ResultVersion and asserts
 * no sporting outcome, so it has no Result lifecycle (no SUBMITTED / PROVISIONAL / OFFICIAL / FINAL /
 * SUPERSEDED / REVOKED). Cross-competition qualification is the BRT-08 QUALIFIED Achievement — there is
 * no qualification entity. Every value here is a closed enum; nothing is a score or probability.
 */

/**
 * Who owns a ranking system (ADR-0048 §1, §6). PLATFORM: a Bragging Rights platform ranking (PLATFORM
 * recognition only). OFFICIAL: owned by an anchored authority whose recognition covers the declared
 * scope; its snapshots are never published without the owner's publication act (no producer yet).
 */
export const RankingSystemKind = { PLATFORM: 'PLATFORM', OFFICIAL: 'OFFICIAL' } as const;
export type RankingSystemKind = (typeof RankingSystemKind)[keyof typeof RankingSystemKind];
export const RANKING_SYSTEM_KINDS = Object.values(RankingSystemKind);

/**
 * Ranking methods. BRT-10 v1 implements ONLY `BEST_MARK`: each holder's best admissible verified
 * Performance Mark under the DisciplineVersion metric order (ADR-0048 §2, ADR-0049 §6). It ranks
 * marks, not placements, and is not PERSONAL_BEST.
 */
export const RankingMethod = { BEST_MARK: 'BEST_MARK' } as const;
export type RankingMethod = (typeof RankingMethod)[keyof typeof RankingMethod];
export const RANKING_METHODS = Object.values(RankingMethod);
/** Named so validators can refuse them explicitly (POLICY_UNSUPPORTED), never silently. */
export const DEFERRED_RANKING_METHODS = ['POINTS_TABLE'] as const;

/** Classification aggregation (ADR-0049 §2): closed; AVERAGE deferred until a rounding policy exists. */
export const ClassificationAggregation = { SUM: 'SUM', MAX: 'MAX', MIN: 'MIN' } as const;
export type ClassificationAggregation =
  (typeof ClassificationAggregation)[keyof typeof ClassificationAggregation];
export const CLASSIFICATION_AGGREGATIONS = Object.values(ClassificationAggregation);
export const DEFERRED_AGGREGATIONS = ['AVERAGE'] as const;

/** Where a classification key's per-contest value comes from (ADR-0049 §2). */
export const ClassificationKeySource = {
  ENTRY_PRIMARY_MARK: 'ENTRY_PRIMARY_MARK',
  PERFORMANCE: 'PERFORMANCE',
} as const;
export type ClassificationKeySource =
  (typeof ClassificationKeySource)[keyof typeof ClassificationKeySource];

/** Lifecycle of an immutable RankingSystemVersion / ClassificationPolicyVersion (no row = DRAFT). */
export const RankingDefinitionLifecycle = {
  DRAFT: 'DRAFT',
  PUBLISHED: 'PUBLISHED',
  RETIRED: 'RETIRED',
} as const;
export type RankingDefinitionLifecycle =
  (typeof RankingDefinitionLifecycle)[keyof typeof RankingDefinitionLifecycle];

/** Where the facts of a ranking evaluation came from. Only CANONICAL_ASSEMBLY reaches a normal DB. */
export const RankingProvenance = {
  CANONICAL_ASSEMBLY: 'CANONICAL_ASSEMBLY',
  REFERENCE_FIXTURE: 'REFERENCE_FIXTURE',
} as const;
export type RankingProvenance = (typeof RankingProvenance)[keyof typeof RankingProvenance];

/**
 * Canonical input kinds of a ranking run. A run input declares which kinds its producer supports;
 * anything required but unsupported is PENDING_REQUIRED_FACTS (never defaulted, never inferred):
 *   RESULT_STATUS           append-only lifecycle transitions                         (produced)
 *   VERIFICATION            BRT-07 current run + hash-based freshness                 (produced)
 *   CONTEST_OCCURRENCE      contest start = the sporting time                         (produced)
 *   COMPETITION_MEMBERSHIP  the immutable Result → Contest → Event → Competition path (produced)
 *   HOLD_STATE              admitted-dispute holds                                    (NO producer)
 *   POPULATION              typed population facts (handicap mode, gender category…)  (NO producer)
 *   RANKING_PUBLICATION     an OFFICIAL owner's publication act                       (NO producer)
 */
export const RankingFactKind = {
  RESULT_STATUS: 'RESULT_STATUS',
  VERIFICATION: 'VERIFICATION',
  CONTEST_OCCURRENCE: 'CONTEST_OCCURRENCE',
  COMPETITION_MEMBERSHIP: 'COMPETITION_MEMBERSHIP',
  HOLD_STATE: 'HOLD_STATE',
  POPULATION: 'POPULATION',
  RANKING_PUBLICATION: 'RANKING_PUBLICATION',
} as const;
export type RankingFactKind = (typeof RankingFactKind)[keyof typeof RankingFactKind];
export const ALL_RANKING_FACT_KINDS = Object.values(RankingFactKind);

/** Kinds today's canonical producers emit (the honest production ceiling, ADR-0035 / ADR-0048). */
export const PRODUCTION_SUPPORTED_RANKING_FACT_KINDS: readonly RankingFactKind[] = [
  'RESULT_STATUS',
  'VERIFICATION',
  'CONTEST_OCCURRENCE',
  'COMPETITION_MEMBERSHIP',
];

export interface RankingConsequenceFloor {
  readonly minimumVerificationLevel: VerificationLevel;
  readonly minimumResultStatus: 'FINAL';
  readonly holdBlocks: true;
}

/**
 * BRT-01 §7 permission matrix — the PLATFORM FLOOR per ranking kind. A version may raise it, never
 * lower it:  "Platform rankings" FINAL · V2 · hold blocks;  "Official rankings of a sanctioning body"
 * FINAL · V3 · hold blocks.
 */
export const RANKING_PLATFORM_FLOOR: Readonly<Record<RankingSystemKind, RankingConsequenceFloor>> =
  {
    PLATFORM: { minimumVerificationLevel: 'V2', minimumResultStatus: 'FINAL', holdBlocks: true },
    OFFICIAL: { minimumVerificationLevel: 'V3', minimumResultStatus: 'FINAL', holdBlocks: true },
  };

/**
 * State of ONE candidate Performance in a ranking run (precedence INTEGRITY_FAILURE > INELIGIBLE >
 * PENDING_REQUIRED_FACTS > NOT_HOLDER_BEST > INCLUDED). NOT_HOLDER_BEST: admissible, but the same holder
 * has a STRICTLY better mark in the run — reported, never silently dropped. Equal best marks of one
 * holder are ALL pinned on that holder's single entry (no hidden choice between them).
 */
export const RankingCandidateState = {
  INCLUDED: 'INCLUDED',
  NOT_HOLDER_BEST: 'NOT_HOLDER_BEST',
  PENDING_REQUIRED_FACTS: 'PENDING_REQUIRED_FACTS',
  INELIGIBLE: 'INELIGIBLE',
  INTEGRITY_FAILURE: 'INTEGRITY_FAILURE',
} as const;
export type RankingCandidateState =
  (typeof RankingCandidateState)[keyof typeof RankingCandidateState];

/** Whether a run's outcome may become a published RankingSnapshot (ADR-0048 §5–6). */
export const RankingPublicationState = { PUBLISHABLE: 'PUBLISHABLE', BLOCKED: 'BLOCKED' } as const;
export type RankingPublicationState =
  (typeof RankingPublicationState)[keyof typeof RankingPublicationState];

/**
 * How a published snapshot relates to the previous one of the same system version (ADR-0048 §8;
 * BRT-01 disputes §5.2). CORRECTS: a pinned basis of the prior snapshot was superseded, revoked or lost
 * CURRENT support. FOLLOWS: new admissible inputs only. Prior snapshots are never rewritten.
 */
export const RankingSnapshotLineageKind = {
  INITIAL: 'INITIAL',
  FOLLOWS: 'FOLLOWS',
  CORRECTS: 'CORRECTS',
} as const;
export type RankingSnapshotLineageKind =
  (typeof RankingSnapshotLineageKind)[keyof typeof RankingSnapshotLineageKind];

/**
 * Why a run was requested (recorded on the persisted run, NEVER part of the hashed engine input, so
 * the same inputs always hash identically whatever triggered them).
 */
export const RankingRunTrigger = {
  SYSTEM_VERSION_PUBLISHED: 'SYSTEM_VERSION_PUBLISHED',
  UPSTREAM_FACT_CHANGED: 'UPSTREAM_FACT_CHANGED',
  STAFF_REQUEST: 'STAFF_REQUEST',
  SCHEDULED_SWEEP: 'SCHEDULED_SWEEP',
} as const;
export type RankingRunTrigger = (typeof RankingRunTrigger)[keyof typeof RankingRunTrigger];

/**
 * Machine-readable BRT-10 blockers. Codes already used by BRT-08 / BRT-09 for the same meaning are
 * REUSED verbatim (e.g. RESULT_STATUS_BELOW_REQUIRED = "not FINAL", VERIFICATION_LEVEL_BELOW_REQUIRED =
 * "insufficient verification", POPULATION_FACT_UNAVAILABLE = "population unknown"); only genuinely new
 * meanings get new codes. Each code belongs to exactly one candidate state.
 */
export const RANKING_BLOCKERS = {
  // integrity (the input contradicts itself or its pins)
  SPEC_HASH_MISMATCH: 'INTEGRITY_FAILURE',
  DISCIPLINE_VERSION_MISMATCH: 'INTEGRITY_FAILURE',
  METRIC_UNKNOWN: 'INTEGRITY_FAILURE',
  METRIC_NOT_COMPARABLE: 'INTEGRITY_FAILURE',
  COMPARATOR_UNDEFINED: 'INTEGRITY_FAILURE',
  HOLDER_UNRESOLVED: 'INTEGRITY_FAILURE',
  // ineligible (permanent for this run)
  RESULT_SUPERSEDED: 'INELIGIBLE',
  RESULT_REVOKED: 'INELIGIBLE',
  RESULT_REJECTED: 'INELIGIBLE',
  RESULT_SCOPE_MISMATCH: 'INELIGIBLE',
  OUTSIDE_COMPETITION_SCOPE: 'INELIGIBLE',
  PERFORMANCE_OUTSIDE_WINDOW: 'INELIGIBLE',
  PERFORMANCE_AFTER_AS_OF: 'INELIGIBLE',
  PERFORMANCE_INVALID: 'INELIGIBLE',
  METRIC_MISMATCH: 'INELIGIBLE',
  METRIC_UNIT_MISMATCH: 'INELIGIBLE',
  METRIC_PRECISION_MISMATCH: 'INELIGIBLE',
  HOLDER_TYPE_NOT_IN_UNIVERSE: 'INELIGIBLE',
  POPULATION_MISMATCH: 'INELIGIBLE',
  RECOGNITION_LEVEL_NOT_COVERED: 'INELIGIBLE',
  RECOGNITION_SPORT_NOT_COVERED: 'INELIGIBLE',
  RECOGNITION_DISCIPLINE_NOT_COVERED: 'INELIGIBLE',
  RECOGNITION_REGION_NOT_COVERED: 'INELIGIBLE',
  RECOGNITION_PLATFORM_CANNOT_BACK_CLAIM: 'INELIGIBLE',
  // pending required facts (may change when upstream facts arrive)
  RESULT_STATUS_UNAVAILABLE: 'PENDING_REQUIRED_FACTS',
  RESULT_STATUS_BELOW_REQUIRED: 'PENDING_REQUIRED_FACTS',
  VERIFICATION_UNAVAILABLE: 'PENDING_REQUIRED_FACTS',
  VERIFICATION_STALE: 'PENDING_REQUIRED_FACTS',
  VERIFICATION_NOT_EVALUATED: 'PENDING_REQUIRED_FACTS',
  VERIFICATION_POLICY_UNAVAILABLE: 'PENDING_REQUIRED_FACTS',
  VERIFICATION_RUN_INCOMPLETE: 'PENDING_REQUIRED_FACTS',
  VERIFICATION_LEVEL_BELOW_REQUIRED: 'PENDING_REQUIRED_FACTS',
  GOVERNING_RECOGNITION_UNAVAILABLE: 'PENDING_REQUIRED_FACTS',
  HOLD_STATE_UNAVAILABLE: 'PENDING_REQUIRED_FACTS',
  HOLD_ACTIVE: 'PENDING_REQUIRED_FACTS',
  OCCURRENCE_TIME_UNKNOWN: 'PENDING_REQUIRED_FACTS',
  COMPETITION_MEMBERSHIP_UNAVAILABLE: 'PENDING_REQUIRED_FACTS',
  POPULATION_FACT_UNAVAILABLE: 'PENDING_REQUIRED_FACTS',
} as const satisfies Readonly<
  Record<string, Exclude<RankingCandidateState, 'INCLUDED' | 'NOT_HOLDER_BEST'>>
>;
export type RankingBlocker = keyof typeof RANKING_BLOCKERS;
export const ALL_RANKING_BLOCKERS = Object.keys(RANKING_BLOCKERS) as RankingBlocker[];

/**
 * Run-level publication blockers (ADR-0048 §5–6) — never a candidate blocker. NO_RANKED_ENTRIES: the
 * run ranked nobody, and a RankingSnapshot always has at least one entry.
 */
export const RANKING_PUBLICATION_BLOCKERS = [
  'NO_RANKED_ENTRIES',
  'OWNER_PUBLICATION_UNAVAILABLE',
  'SYSTEM_VERSION_NOT_PUBLISHED',
  'SYSTEM_VERSION_RETIRED',
] as const;
export type RankingPublicationBlocker = (typeof RANKING_PUBLICATION_BLOCKERS)[number];

/** Definition-validation code for an unsupported method / aggregation (never silently mapped). */
export const POLICY_UNSUPPORTED = 'POLICY_UNSUPPORTED';

/**
 * Classification blockers (ADR-0047). Used by the classification engine (Step 3) and the ledger
 * submission check (Step 6); listed here so the vocabulary is closed from the start.
 */
export const CLASSIFICATION_BLOCKERS = [
  'CLASSIFICATION_INPUT_MISSING',
  'CLASSIFICATION_INPUT_INADMISSIBLE',
  'COMPARATOR_UNDEFINED',
  'COMPARATOR_INPUT_MISSING',
  'POLICY_UNSUPPORTED',
  'CLASSIFICATION_PROVENANCE_UNAVAILABLE',
  'CLASSIFICATION_DERIVATION_MISMATCH',
  'CLASSIFICATION_REPLACEMENT_REQUIRES_CORRECTION',
] as const;
export type ClassificationBlocker = (typeof CLASSIFICATION_BLOCKERS)[number];

/**
 * Why a classification ResultVersion is STALE (ADR-0047 §5). Computed at read time / by the worker,
 * never stored on the version (R-1):
 *   PINNED_INPUT_NOT_CURRENT      a pinned input is no longer the current version of its Result
 *                                 (superseded, revoked, rejected) — or its current state is unknown;
 *   ADMISSIBLE_INPUT_SET_CHANGED  the scope's current admissible inputs (under the PINNED policy) differ
 *                                 from the pinned set;
 *   ADMISSIBLE_INPUT_SET_UNKNOWN  the scope could not be re-assembled under the pinned policy (fail
 *                                 closed: unknown never counts as fresh).
 */
export const CLASSIFICATION_STALE_REASONS = [
  'PINNED_INPUT_NOT_CURRENT',
  'ADMISSIBLE_INPUT_SET_CHANGED',
  'ADMISSIBLE_INPUT_SET_UNKNOWN',
] as const;
export type ClassificationStaleReason = (typeof CLASSIFICATION_STALE_REASONS)[number];

/**
 * Why a published RankingSnapshot reads STALE (ADR-0048 §8), computed from its basis pins at read time
 * and never stored on the snapshot: a pinned ResultVersion is no longer the current FINAL version of its
 * Result, or its pinned VerificationRun is no longer the CURRENT run (unknown counts as affected).
 */
export const RANKING_SNAPSHOT_STALE_REASONS = [
  'BASIS_RESULT_NOT_CURRENT',
  'BASIS_VERIFICATION_NOT_CURRENT',
] as const;
export type RankingSnapshotStaleReason = (typeof RANKING_SNAPSHOT_STALE_REASONS)[number];

// ───────────────────────────── qualification (QUALIFIED Achievement inputs) ─────────────────────────────

/**
 * What a QUALIFIED Achievement's qualifying fact is (ADR-0050 §2). Either a position in a PUBLISHED,
 * non-stale RankingSnapshot, or a position in a FINAL EVENT / COMPETITION classification ResultVersion.
 * The Achievement itself is derived later by the BRT-08 engine (achievement-engine/3, Step 9).
 */
export const QualificationBasisKind = {
  RANKING_SNAPSHOT_POSITION: 'RANKING_SNAPSHOT_POSITION',
  CLASSIFICATION_POSITION: 'CLASSIFICATION_POSITION',
} as const;
export type QualificationBasisKind =
  (typeof QualificationBasisKind)[keyof typeof QualificationBasisKind];

/**
 * BRT-01 §7 "Qualification / eligibility for another sanctioned competition": FINAL · V3 · hold blocks.
 * The matrix's "target may set V2" alternative is NOT available (no target-governance fact exists).
 */
export const QUALIFICATION_PLATFORM_FLOOR: RankingConsequenceFloor = {
  minimumVerificationLevel: 'V3',
  minimumResultStatus: 'FINAL',
  holdBlocks: true,
};

/**
 * Qualification-specific blockers (ADR-0050 §4–5); the target authority fact has NO producer.
 * Step 9 additions (by decision):
 *   QUALIFYING_SOURCE_MISMATCH                  the snapshot / classification is not the rule's pinned
 *                                               source (system version, scope, policy version)
 *   RANKING_SNAPSHOT_CORRECTED                  a correcting snapshot replaces the pinned one
 *   TARGET_QUALIFICATION_AUTHORITY_INVALID      the adoption is withdrawn or adopts another rule version
 *   TARGET_QUALIFICATION_AUTHORITY_OUT_OF_SCOPE the adoption is for another target competition
 */
export const QUALIFICATION_BLOCKERS = [
  'TARGET_QUALIFICATION_AUTHORITY_UNAVAILABLE',
  'TARGET_QUALIFICATION_AUTHORITY_INVALID',
  'TARGET_QUALIFICATION_AUTHORITY_OUT_OF_SCOPE',
  'ELIGIBILITY_UNKNOWN',
  'QUALIFYING_SOURCE_MISMATCH',
  'RANKING_SNAPSHOT_NOT_PUBLISHED',
  'RANKING_SNAPSHOT_STALE',
  'RANKING_SNAPSHOT_CORRECTED',
  'POSITION_OUTSIDE_QUALIFYING_RANKS',
] as const;
export type QualificationBlocker = (typeof QUALIFICATION_BLOCKERS)[number];

/** Public wording: the model names the two notions of "qualified" distinctly (ADR-0008). */
export const QUALIFICATION_LABEL_PREFIX = 'Qualified for';
export const QUALIFICATION_LABEL_SUFFIX = '(cross-competition)';

/** PLATFORM ranking systems are always labelled as such (ADR-0048 §7). */
export const PLATFORM_RANKING_LABEL = 'Bragging Rights platform ranking';
