import type { ResultVersionStatus } from './results';
import type { VerificationLevel } from './verification';

/**
 * BRT-08 Verified Achievement vocabulary (BRT-01 verification model §8, disputes §5.1, ADR-0001).
 *
 *   Result ≠ Verification ≠ Achievement
 *
 * An Achievement is a DERIVED recognition: "according to AchievementRuleVersion X, these exact
 * verified sporting facts qualify holder H for recognition Y". It is never a flag on a Result, never
 * a level on a Verification and never a manual award. Every value here is a closed enum.
 */

/**
 * BRT-01 §8.2 initial registry — the types BRT-08 derives. The remaining BRT-01 types are deferred
 * (see DEFERRED_ACHIEVEMENT_TYPES) because their inputs belong to later tickets.
 */
export const AchievementType = {
  EVENT_COMPLETED: 'EVENT_COMPLETED',
  CONTEST_WON: 'CONTEST_WON',
  PLACEMENT: 'PLACEMENT',
  TITLE: 'TITLE',
  PERFORMANCE_THRESHOLD: 'PERFORMANCE_THRESHOLD',
  PERSONAL_BEST: 'PERSONAL_BEST',
  /**
   * BRT-09 (ADR-0045): created ONLY after a RecordMark is validly RATIFIED / CANONICAL, derived by
   * the same validated engine path from the mark's exact performance basis + its ratification.
   */
  RECORD_SET: 'RECORD_SET',
  /**
   * BRT-10 (ADR-0050): cross-competition qualification — a holder's position ≤ N in a PUBLISHED,
   * non-stale RankingSnapshot or a FINAL classification, adopted by the TARGET competition's authority.
   * Derived by achievement-engine/3 only; never an entry, registration, seeding or prize.
   */
  QUALIFIED: 'QUALIFIED',
} as const;
export type AchievementType = (typeof AchievementType)[keyof typeof AchievementType];
export const ACHIEVEMENT_TYPES = Object.values(AchievementType);

/**
 * BRT-01 §8.2 types NOT derived by BRT-08: STREAK (needs a sequence of achievements), SEASON_TITLE
 * (no season/league entity), RANKING_MILESTONE (rankings). Rule validation rejects them. RECORD_SET
 * is derived since BRT-09 (from a ratified RecordMark), QUALIFIED since BRT-10 (achievement-engine/3).
 */
export const DEFERRED_ACHIEVEMENT_TYPES = ['STREAK', 'SEASON_TITLE', 'RANKING_MILESTONE'] as const;

/**
 * Stable holders (BRT-01 §8.1). A TEAM Achievement credits its athletes through immutable
 * `memberCredits` taken from the exact credited lineup of the basis ResultVersion (AC-5) — it is ONE
 * Achievement, never one per athlete. Participant is a derivation reference, never the holder.
 */
export const HolderType = { ATHLETE: 'ATHLETE', TEAM: 'TEAM' } as const;
export type HolderType = (typeof HolderType)[keyof typeof HolderType];

/** How a member is credited on a TEAM Achievement (BRT-01 §8.1 `creditRole`). */
export const MemberCreditRole = { LINEUP_MEMBER: 'LINEUP_MEMBER' } as const;
export type MemberCreditRole = (typeof MemberCreditRole)[keyof typeof MemberCreditRole];

/**
 * BRT-01 §8.1 / disputes §5.1 Achievement status. The Achievement fact itself is immutable; status is
 * an append-only status history (class A) whose latest entry is projected (class B):
 *   ACTIVE      the pinned basis still supports the recognition under its rule
 *   SUSPENDED   support temporarily lost (verification stale / below the rule's level, basis awaiting
 *               re-derivation after a correction) — reactivated by a later entry, never deleted
 *   SUPERSEDED  replaced by a newer Achievement (new basis, same type/rule/holder/scope)
 *   REVOKED     the basis is invalidated with no replacement for this holder
 */
export const AchievementStatus = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  SUPERSEDED: 'SUPERSEDED',
  REVOKED: 'REVOKED',
} as const;
export type AchievementStatus = (typeof AchievementStatus)[keyof typeof AchievementStatus];
export const TERMINAL_ACHIEVEMENT_STATUSES: readonly AchievementStatus[] = [
  'SUPERSEDED',
  'REVOKED',
];

/** Where the facts of a derivation came from. Only CANONICAL_ASSEMBLY may reach a normal database. */
export const DerivationProvenance = {
  CANONICAL_ASSEMBLY: 'CANONICAL_ASSEMBLY',
  REFERENCE_FIXTURE: 'REFERENCE_FIXTURE',
} as const;
export type DerivationProvenance = (typeof DerivationProvenance)[keyof typeof DerivationProvenance];

/**
 * Canonical input kinds of an Achievement derivation. A snapshot declares which kinds its producer
 * supports; a rule that needs an unsupported kind is blocked (never defaulted, never inferred):
 *   RESULT_STATUS       lifecycle status from append-only status transitions        (produced)
 *   VERIFICATION        BRT-07 VerificationRun + hash-based freshness               (produced)
 *   CONTEST_OCCURRENCE  contest start from contest status facts                     (produced)
 *   HOLD_STATE          admitted-dispute holds (BRT-01 §1.3)                        (NO producer)
 *   CREDITED_LINEUP     the lineup inside Result content (ADR-0026)                 (NO producer)
 *   RECORD_RATIFICATION a RecordMark's valid ratification (BRT-09; RECORD_RATIFIED /
 *                       REVIEW_COMPLETED producer deferred to BRT-06R)              (NO producer)
 *   TARGET_QUALIFICATION_AUTHORITY  the target competition's authority adopting a QUALIFIED rule
 *                       (BRT-10, ADR-0050 §4) — the platform never decides another
 *                       authority's qualification                                    (NO producer)
 */
export const DerivationFactKind = {
  RESULT_STATUS: 'RESULT_STATUS',
  VERIFICATION: 'VERIFICATION',
  CONTEST_OCCURRENCE: 'CONTEST_OCCURRENCE',
  HOLD_STATE: 'HOLD_STATE',
  CREDITED_LINEUP: 'CREDITED_LINEUP',
  RECORD_RATIFICATION: 'RECORD_RATIFICATION',
  TARGET_QUALIFICATION_AUTHORITY: 'TARGET_QUALIFICATION_AUTHORITY',
} as const;
export type DerivationFactKind = (typeof DerivationFactKind)[keyof typeof DerivationFactKind];
export const ALL_DERIVATION_FACT_KINDS = Object.values(DerivationFactKind);

/**
 * The kinds today's canonical producers emit. HOLD_STATE and CREDITED_LINEUP are deliberately
 * absent: no Dispute/hold producer exists and the BRT-05 declared lineup is NOT the credited lineup
 * (ADR-0026) — the production assembler never reads `competition.lineup` as sporting truth.
 */
export const PRODUCTION_SUPPORTED_DERIVATION_FACT_KINDS: readonly DerivationFactKind[] = [
  'RESULT_STATUS',
  'VERIFICATION',
  'CONTEST_OCCURRENCE',
];

export const AchievementRuleLifecycle = {
  DRAFT: 'DRAFT',
  PUBLISHED: 'PUBLISHED',
  RETIRED: 'RETIRED',
} as const;
export type AchievementRuleLifecycle =
  (typeof AchievementRuleLifecycle)[keyof typeof AchievementRuleLifecycle];

/** Statuses an Achievement basis may require (BRT-01 §7 columns). */
export type RequiredResultStatus = Extract<ResultVersionStatus, 'OFFICIAL' | 'FINAL'>;

/** Order of the statuses a basis may satisfy (SUPERSEDED / REVOKED / REJECTED never satisfy). */
export function resultStatusSatisfies(
  status: ResultVersionStatus,
  required: RequiredResultStatus,
): boolean {
  if (required === 'OFFICIAL') return status === 'OFFICIAL' || status === 'FINAL';
  return status === 'FINAL';
}

export interface ConsequenceFloor {
  readonly minimumVerificationLevel: VerificationLevel;
  readonly minimumResultStatus: RequiredResultStatus;
  /** An admitted hold blocks new issuance (BRT-01 §7 "Hold blocks?" = Yes for every type here). */
  readonly holdBlocks: true;
}

/**
 * BRT-01 §7 downstream permission matrix — the PLATFORM FLOOR per achievement type. A rule may raise
 * it (e.g. V3 for a title), never lower it; publication rejects a lower requirement.
 *   Participation / completion        OFFICIAL · V1
 *   Contest-win, placement, title     FINAL    · V2
 *   Performance threshold             FINAL    · V2   (bowling walkthrough §8 "V2 + FINAL")
 *   Personal best                     OFFICIAL · V2   (matrix row "Records: PERSONAL best")
 */
export const ACHIEVEMENT_PLATFORM_FLOOR: Readonly<Record<AchievementType, ConsequenceFloor>> = {
  EVENT_COMPLETED: {
    minimumVerificationLevel: 'V1',
    minimumResultStatus: 'OFFICIAL',
    holdBlocks: true,
  },
  CONTEST_WON: { minimumVerificationLevel: 'V2', minimumResultStatus: 'FINAL', holdBlocks: true },
  PLACEMENT: { minimumVerificationLevel: 'V2', minimumResultStatus: 'FINAL', holdBlocks: true },
  TITLE: { minimumVerificationLevel: 'V2', minimumResultStatus: 'FINAL', holdBlocks: true },
  PERFORMANCE_THRESHOLD: {
    minimumVerificationLevel: 'V2',
    minimumResultStatus: 'FINAL',
    holdBlocks: true,
  },
  PERSONAL_BEST: {
    minimumVerificationLevel: 'V2',
    minimumResultStatus: 'OFFICIAL',
    holdBlocks: true,
  },
  // BRT-01 §8.2 "per record category": V2 · FINAL is the lowest record floor (PLATFORM V2 + review);
  // the engine raises it to the pinned RecordMark's category floor (V3 / V4) at derivation.
  RECORD_SET: { minimumVerificationLevel: 'V2', minimumResultStatus: 'FINAL', holdBlocks: true },
  // BRT-01 §7 "Qualification / eligibility for another sanctioned competition": FINAL · V3 · hold
  // blocks (ADR-0050 §3). The "target may set V2" alternative is unavailable (no governance fact).
  QUALIFIED: { minimumVerificationLevel: 'V3', minimumResultStatus: 'FINAL', holdBlocks: true },
};

/** Public labels per type (never "Verified ✓"). */
export const ACHIEVEMENT_TYPE_LABEL: Readonly<Record<AchievementType, string>> = {
  EVENT_COMPLETED: 'Event completed',
  CONTEST_WON: 'Contest won',
  PLACEMENT: 'Placement',
  TITLE: 'Title',
  PERFORMANCE_THRESHOLD: 'Performance threshold',
  PERSONAL_BEST: 'Personal best',
  RECORD_SET: 'Record set',
  QUALIFIED: 'Qualified (cross-competition)',
};
