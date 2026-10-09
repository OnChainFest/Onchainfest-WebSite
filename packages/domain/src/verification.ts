/**
 * BRT-07 Verification Engine / Sports Oracle vocabulary (BRT-01 verification model §5–6,
 * ADR-0005). Every value here is a closed enum: there is no score, confidence, probability or
 * weight anywhere in the verification vocabulary.
 *
 *   Result ≠ Verification · ResultStatus ≠ VerificationLevel · VerificationLevel ≠ RecognitionLevel
 *   Freshness ≠ VerificationLevel · EvaluationState ≠ VerificationLevel
 */

/**
 * BRT-01 §6 canonical verification levels — ONLY these five. Failing to establish V0 is an
 * EvaluationState (outside this type), never a sixth level. Values are deliberately prefixed
 * strings ("V0"…) that share no member with RecognitionLevel (CLUB…PLATFORM): the two types can
 * never be compared, assigned or ranked against each other (compile-time guard below).
 */
export const VerificationLevel = {
  V0: 'V0',
  V1: 'V1',
  V2: 'V2',
  V3: 'V3',
  V4: 'V4',
} as const;
export type VerificationLevel = (typeof VerificationLevel)[keyof typeof VerificationLevel];
export const VERIFICATION_LEVELS: readonly VerificationLevel[] = ['V0', 'V1', 'V2', 'V3', 'V4'];

/** BRT-01 §6 level names (accepted terminology). */
export const VERIFICATION_LEVEL_NAME: Readonly<Record<VerificationLevel, string>> = {
  V0: 'CLAIMED',
  V1: 'CORROBORATED',
  V2: 'EVENT_CERTIFIED',
  V3: 'SANCTIONED',
  V4: 'RATIFIED',
};

/** Public labels (exact trust language; never "Verified ✓" without the level). */
export const VERIFICATION_LEVEL_LABEL: Readonly<Record<VerificationLevel, string>> = {
  V0: 'Claimed',
  V1: 'Corroborated',
  V2: 'Event Certified',
  V3: 'Sanctioned',
  V4: 'Ratified',
};

/** Position of a verification level in ITS OWN order (never mixed with recognition ranks). */
export function verificationLevelIndex(level: VerificationLevel): number {
  return VERIFICATION_LEVELS.indexOf(level);
}

/** Compile-time guard: VerificationLevel ∩ RecognitionLevel = ∅. */
type RecognitionLevelValue =
  'CLUB' | 'REGIONAL' | 'NATIONAL' | 'CONTINENTAL' | 'WORLD' | 'PLATFORM';
type LevelOverlap = Extract<VerificationLevel, RecognitionLevelValue>;
export const VERIFICATION_LEVEL_IS_NOT_RECOGNITION_LEVEL: [LevelOverlap] extends [never]
  ? true
  : never = true;

/**
 * Outcome of one deterministic evaluation (outside VerificationLevel):
 *   EVALUATED           V0's claim prerequisites hold; the highest satisfied level is reported
 *   INSUFFICIENT_INPUT  V0's claim prerequisites cannot be established from the snapshot
 * Service-level states (never produced by the pure engine):
 *   POLICY_UNAVAILABLE  no PUBLISHED policy version is bound to the exact DisciplineVersion
 *   NOT_EVALUATED       no VerificationRun exists yet
 * Integrity failures of stored canonical facts are NOT evaluation states: they are system errors
 * (VERIFICATION_INTEGRITY_FAILURE) and never produce a run.
 */
export const EvaluationState = {
  EVALUATED: 'EVALUATED',
  INSUFFICIENT_INPUT: 'INSUFFICIENT_INPUT',
  POLICY_UNAVAILABLE: 'POLICY_UNAVAILABLE',
  NOT_EVALUATED: 'NOT_EVALUATED',
} as const;
export type EvaluationState = (typeof EvaluationState)[keyof typeof EvaluationState];

/** Hash-based freshness of the latest run (BRT-07 §65). Freshness is not a level; STALE ≠ FAILED. */
export const VerificationFreshness = {
  NOT_EVALUATED: 'NOT_EVALUATED',
  CURRENT: 'CURRENT',
  STALE: 'STALE',
} as const;
export type VerificationFreshness =
  (typeof VerificationFreshness)[keyof typeof VerificationFreshness];

/**
 * Criterion trace status. UNKNOWN / INSUFFICIENT / INPUT_NOT_SUPPORTED never pass.
 *   PASS                 the criterion holds on the snapshot's facts
 *   FAIL                 the facts show it does not hold
 *   INSUFFICIENT         the relevant facts exist but are not enough to decide (e.g. a count gap)
 *   UNKNOWN              a fact needed with certainty is structurally unknown (e.g. participation)
 *   INPUT_NOT_SUPPORTED  a BRT-01 canonical fact kind the engine understands has NO producer in
 *                        the platform yet (e.g. RESULT_OFFICIAL, T5) — an ordinary insufficiency,
 *                        never an engine-integrity failure
 *   NOT_APPLICABLE       the criterion does not apply to this subject
 */
export const CriterionStatus = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  INSUFFICIENT: 'INSUFFICIENT',
  UNKNOWN: 'UNKNOWN',
  INPUT_NOT_SUPPORTED: 'INPUT_NOT_SUPPORTED',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
} as const;
export type CriterionStatus = (typeof CriterionStatus)[keyof typeof CriterionStatus];

/**
 * Closed, bounded criterion vocabulary (BRT-07 §15). Each kind is a named BRT-01/BRT-02 predicate;
 * there is no expression language, script or plugin. The level each kind belongs to is fixed
 * (`CRITERION_LEVEL`); NO_ACTIVE_DISPUTE is an optional stricter criterion for V1–V4.
 */
export const CriterionKind = {
  // V0 CLAIMED
  CLAIM_BOUND: 'CLAIM_BOUND',
  // V1 CORROBORATED
  INDEPENDENT_CORROBORATION: 'INDEPENDENT_CORROBORATION',
  NO_COUNTERPARTY_DENY: 'NO_COUNTERPARTY_DENY',
  // V2 EVENT_CERTIFIED
  PRIMARY_EVIDENCE: 'PRIMARY_EVIDENCE',
  PRIMARY_EVIDENCE_INTEGRITY: 'PRIMARY_EVIDENCE_INTEGRITY',
  NO_INVALIDATING_ASSESSMENT: 'NO_INVALIDATING_ASSESSMENT',
  OFFICIAL_DECLARATION: 'OFFICIAL_DECLARATION',
  NO_AUTHORIZED_DENY: 'NO_AUTHORIZED_DENY',
  // V3 SANCTIONED
  COMPETITION_SANCTIONED: 'COMPETITION_SANCTIONED',
  CERTIFICATION_ROOTED_IN_SANCTION: 'CERTIFICATION_ROOTED_IN_SANCTION',
  OFFICIAL_EVIDENCE_SET: 'OFFICIAL_EVIDENCE_SET',
  IDENTITY_CONFIRMED: 'IDENTITY_CONFIRMED',
  // V4 RATIFIED
  CONDITIONS_COMPLIANT: 'CONDITIONS_COMPLIANT',
  INDEPENDENT_PRIMARY_SOURCES: 'INDEPENDENT_PRIMARY_SOURCES',
  NON_WITNESSED_SIGNATURES: 'NON_WITNESSED_SIGNATURES',
  RECORD_RATIFIED: 'RECORD_RATIFIED',
  // Optional, stricter (V1–V4)
  NO_ACTIVE_DISPUTE: 'NO_ACTIVE_DISPUTE',
} as const;
export type CriterionKind = (typeof CriterionKind)[keyof typeof CriterionKind];
export const ALL_CRITERION_KINDS = Object.values(CriterionKind);

/**
 * Canonical fact kinds the engine understands. `supportedFactKinds` in a snapshot declares which of
 * them the snapshot's producer can emit; a criterion needing an unsupported kind reports
 * INPUT_NOT_SUPPORTED. The production assembler (BRT-07) supports only the kinds whose canonical
 * producers exist in the repository (RESULT_ACCURATE and CONDITIONS_COMPLIANT attestations).
 */
export const CanonicalFactKind = {
  RESULT_ACCURATE_ATTESTATION: 'RESULT_ACCURATE_ATTESTATION',
  CONDITIONS_COMPLIANT_ATTESTATION: 'CONDITIONS_COMPLIANT_ATTESTATION',
  RESULT_OFFICIAL_ATTESTATION: 'RESULT_OFFICIAL_ATTESTATION',
  T5_OFFICIAL_TRANSITION: 'T5_OFFICIAL_TRANSITION',
  COMPETITION_SANCTIONED_ATTESTATION: 'COMPETITION_SANCTIONED_ATTESTATION',
  IDENTITY_CONFIRMED_ATTESTATION: 'IDENTITY_CONFIRMED_ATTESTATION',
  OFFICIAL_EVIDENCE_SET: 'OFFICIAL_EVIDENCE_SET',
  EVIDENCE_ASSESSMENT: 'EVIDENCE_ASSESSMENT',
  RECORD_CATEGORY: 'RECORD_CATEGORY',
  RECORD_RATIFIED_ATTESTATION: 'RECORD_RATIFIED_ATTESTATION',
  REVIEW_COMPLETED_ATTESTATION: 'REVIEW_COMPLETED_ATTESTATION',
  DERIVED_INPUT_LEVELS: 'DERIVED_INPUT_LEVELS',
  /**
   * BRT-01 V1 "registered official": a STRUCTURAL fact that a principal is registered as an
   * official of the competition / event / contest during an interval. It is NOT sporting authority
   * (an ATTEST_RESULT grant never creates it) and has no canonical producer in the repository yet.
   */
  REGISTERED_OFFICIAL: 'REGISTERED_OFFICIAL',
} as const;
export type CanonicalFactKind = (typeof CanonicalFactKind)[keyof typeof CanonicalFactKind];
export const ALL_CANONICAL_FACT_KINDS = Object.values(CanonicalFactKind);

/** The kinds today's canonical producers can emit (BRT-06 attestation protocol). */
export const PRODUCTION_SUPPORTED_FACT_KINDS: readonly CanonicalFactKind[] = [
  'RESULT_ACCURATE_ATTESTATION',
  'CONDITIONS_COMPLIANT_ATTESTATION',
];

/**
 * Structural participation relations (BRT-07 §46). A relation is a FACT; whether it disqualifies
 * an issuer is decided by the conflict rule (BRT-01 §4.5 rule 7) plus policy — never here.
 */
export const ParticipationRelation = {
  /** The issuer's Person is the Athlete of an INDIVIDUAL Participant. */
  SELF_PARTICIPANT: 'SELF_PARTICIPANT',
  /** The issuer's Person's Athlete is (or was) a member of a participating Team. */
  TEAM_MEMBER_OF_PARTICIPANT: 'TEAM_MEMBER_OF_PARTICIPANT',
  /** The issuer's Person's Athlete was declared in a Participant's lineup for this contest. */
  LINEUP_MEMBER_OF_PARTICIPANT: 'LINEUP_MEMBER_OF_PARTICIPANT',
  /** The issuer's Person manages a participating Team (operational role). */
  TEAM_MANAGER_OF_PARTICIPANT: 'TEAM_MANAGER_OF_PARTICIPANT',
  /** The issuer's Person is a guardian of a participating Athlete's Person. */
  GUARDIAN_OF_PARTICIPANT: 'GUARDIAN_OF_PARTICIPANT',
  /** The issuer Organization is the affiliation label of a participating Team. */
  TEAM_AFFILIATED_ORGANIZATION: 'TEAM_AFFILIATED_ORGANIZATION',
  /** The issuer Organization organizes the Competition. */
  ORGANIZER_ORGANIZATION: 'ORGANIZER_ORGANIZATION',
  /** The issuer's Person is (or was) OWNER/ADMIN of the organizer Organization. */
  ORGANIZER_ORGANIZATION_ADMIN: 'ORGANIZER_ORGANIZATION_ADMIN',
  /** The issuer's Person holds (or held) an operational competition staff role. */
  COMPETITION_STAFF: 'COMPETITION_STAFF',
} as const;
export type ParticipationRelation =
  (typeof ParticipationRelation)[keyof typeof ParticipationRelation];
export const ALL_PARTICIPATION_RELATIONS = Object.values(ParticipationRelation);

/** Relations that put a principal on a participant's SIDE (they carry a participantId). */
export const SIDE_RELATIONS: readonly ParticipationRelation[] = [
  'SELF_PARTICIPANT',
  'TEAM_MEMBER_OF_PARTICIPANT',
  'LINEUP_MEMBER_OF_PARTICIPANT',
  'TEAM_MANAGER_OF_PARTICIPANT',
  'GUARDIAN_OF_PARTICIPANT',
  'TEAM_AFFILIATED_ORGANIZATION',
];

/**
 * BRT-01 §4.5 rule 7 / A-5: "P is not a Participant, Team member or Lineup member in S". These
 * relations ALWAYS make a principal conflicted for conflict-sensitive capabilities; a policy may add
 * more (never remove these).
 */
export const STRUCTURAL_CONFLICT_RELATIONS: readonly ParticipationRelation[] = [
  'SELF_PARTICIPANT',
  'TEAM_MEMBER_OF_PARTICIPANT',
  'LINEUP_MEMBER_OF_PARTICIPANT',
];

/** Whether the participation of a principal could be resolved from canonical facts. */
export const ParticipationResolution = {
  RESOLVED: 'RESOLVED',
  /** The principal's identity is not mappable to structural facts (Person / Organization). */
  UNRESOLVED: 'UNRESOLVED',
  /**
   * The identity is mapped, but whether a time-bounded relation (membership, staff role, guardian,
   * admin, manager) held during the contest occurrence cannot be decided from the facts known at
   * the cutoff. Never "conflict-free", never "conflicted forever": the answer is UNKNOWN.
   */
  TEMPORALLY_UNDETERMINED: 'TEMPORALLY_UNDETERMINED',
} as const;
export type ParticipationResolution =
  (typeof ParticipationResolution)[keyof typeof ParticipationResolution];

/**
 * How a participation relation was established (BRT-07R temporal slicing):
 *   STRUCTURAL         timeless for this subject — a direct Participant, or a member of the EXACT
 *                      lineup declared for this contest (the lineup takes precedence over
 *                      membership inference), or an Organization ↔ team / organizer label
 *   DURING_OCCURRENCE  a time-bounded relation whose interval certainly overlaps the contest
 *                      occurrence window
 *   UNDETERMINED       a time-bounded relation whose overlap with the window cannot be decided
 * A relation certainly outside the window is not a relation at all (it is not emitted).
 */
export const RelationTiming = {
  STRUCTURAL: 'STRUCTURAL',
  DURING_OCCURRENCE: 'DURING_OCCURRENCE',
  UNDETERMINED: 'UNDETERMINED',
} as const;
export type RelationTiming = (typeof RelationTiming)[keyof typeof RelationTiming];

/** Verification policy version lifecycle (BRT-07 §9). */
export const PolicyLifecycle = {
  DRAFT: 'DRAFT',
  PUBLISHED: 'PUBLISHED',
  RETIRED: 'RETIRED',
} as const;
export type PolicyLifecycle = (typeof PolicyLifecycle)[keyof typeof PolicyLifecycle];

/** Anomaly flags (BRT-01 §5.1). Flags describe, they never score. */
export const VerificationFlag = {
  CONTRADICTING_ATTESTATION: 'CONTRADICTING_ATTESTATION',
  AI_ONLY_EVIDENCE: 'AI_ONLY_EVIDENCE',
  SUSPECT_ATTESTER: 'SUSPECT_ATTESTER',
  EVIDENCE_UNAVAILABLE: 'EVIDENCE_UNAVAILABLE',
  PARTICIPATION_INCOMPLETE: 'PARTICIPATION_INCOMPLETE',
} as const;
export type VerificationFlag = (typeof VerificationFlag)[keyof typeof VerificationFlag];

/** Where a snapshot came from. Only CANONICAL_ASSEMBLY snapshots may ever be persisted. */
export const SnapshotProvenance = {
  CANONICAL_ASSEMBLY: 'CANONICAL_ASSEMBLY',
  REFERENCE_FIXTURE: 'REFERENCE_FIXTURE',
} as const;
export type SnapshotProvenance = (typeof SnapshotProvenance)[keyof typeof SnapshotProvenance];
