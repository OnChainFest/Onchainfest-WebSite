import {
  ACHIEVEMENT_TYPE_LABEL,
  QUALIFICATION_LABEL_PREFIX,
  QUALIFICATION_LABEL_SUFFIX,
  VERIFICATION_LEVEL_LABEL,
  type AchievementStatus,
  type AchievementType,
  type VerificationLevel,
} from '@br/domain';

/**
 * Public-safe Achievement wording (BRT-08 §86–87). Fixed sentences per status / reason; no
 * identifier is ever interpolated except public rule codes. An Achievement is never "V2": the level
 * belongs to the verification of the basis result — "Derived from a V2 Event Certified result".
 * A non-current Achievement is never shown as simply "Verified ✓".
 */
export const PUBLIC_ACHIEVEMENT_NOTICE =
  'An achievement is a recognition derived by a published, versioned rule from exact verified sporting facts. It is not a manual award, a record, a ranking or a prize.';

export function derivedFromStatement(level: VerificationLevel): string {
  return `Derived from a ${level} ${VERIFICATION_LEVEL_LABEL[level]} result.`;
}

export function currentSupportStatement(status: AchievementStatus): string {
  switch (status) {
    case 'ACTIVE':
      return 'Currently supported: the pinned basis still satisfies its rule.';
    case 'SUSPENDED':
      return 'Historical recognition — current support is suspended pending re-evaluation of its basis.';
    case 'SUPERSEDED':
      return 'Historical recognition — replaced by a newer recognition derived from a corrected basis.';
    case 'REVOKED':
      return 'Historical recognition — revoked: its basis no longer supports it.';
  }
}

const REASON_TEXT: Readonly<Record<string, string>> = {
  BASIS_RESULT_REVOKED: 'The basis result was revoked.',
  RECORD_MARK_RESCINDED: 'The record mark this recognition was derived from was rescinded.',
  REPLACED_BY_NEWER_BASIS: 'A newer recognition with a corrected or re-verified basis replaced it.',
  BASIS_RESULT_SUPERSEDED: 'The basis result was superseded by a corrected version.',
  AWAITING_REDERIVATION: 'The corrected version has not (yet) produced a replacement recognition.',
  HOLDER_NO_LONGER_QUALIFIES: 'Under the corrected result this holder no longer qualifies.',
  RANKING_SNAPSHOT_CORRECTED:
    'The ranking snapshot this qualification was derived from was corrected by a newer snapshot.',
  VERIFICATION_STALE: 'The verification the recognition relied on is no longer current.',
  VERIFICATION_NOT_EVALUATED: 'The basis result has no current verification.',
  VERIFICATION_POLICY_UNAVAILABLE: 'No verification policy currently applies to the basis result.',
  VERIFICATION_RUN_NO_LONGER_CURRENT: 'A newer verification of the basis result exists.',
  VERIFICATION_LEVEL_BELOW_REQUIRED:
    'The current verification of the basis result is below the level the rule requires.',
  UNDER_DISPUTE: 'The basis is under an admitted dispute.',
  CURRENT_SUPPORT_UNASSESSABLE:
    'Current support could not be assessed right now; it is not presented as current.',
  VERIFICATION_NOT_ASSESSED: 'The verification of the basis was not assessed.',
};

export function publicReason(reason: string): string {
  return REASON_TEXT[reason] ?? 'The basis of this recognition changed.';
}

/** Fixed public explanations of derivation blockers (no identifiers). */
const BLOCKER_TEXT: Readonly<Record<string, string>> = {
  RESULT_STATUS_BELOW_REQUIRED:
    'The basis result has not reached the lifecycle status the rule requires (OFFICIAL/FINAL declarations are not yet produced on the platform).',
  RESULT_SUPERSEDED: 'The result version was superseded by a correction.',
  RESULT_REVOKED: 'The result version was revoked.',
  RESULT_REJECTED: 'The result version was rejected.',
  VERIFICATION_LEVEL_BELOW_REQUIRED:
    'The current verification level of the result is below the level the rule requires.',
  VERIFICATION_STALE: 'The latest verification is no longer current; re-evaluation is required.',
  VERIFICATION_NOT_EVALUATED: 'The result has not been verified yet.',
  VERIFICATION_POLICY_UNAVAILABLE: 'No verification policy applies to the result.',
  HOLD_STATE_UNAVAILABLE:
    'Dispute/hold facts are not yet produced on the platform, so the absence of a hold cannot be established.',
  HOLD_ACTIVE: 'The result is under an admitted dispute (hold).',
  RESULT_SCOPE_MISMATCH: 'The rule applies to another kind of result.',
  RULE_DISCIPLINE_VERSION_MISMATCH: 'The rule applies to another discipline version.',
  OCCURRENCE_TIME_UNKNOWN: 'The contest occurrence time is not known.',
  RECORD_RATIFICATION_UNAVAILABLE:
    'Record ratification attestations are not yet produced on the platform (deferred producer).',
  RECORD_MARK_UNAVAILABLE: 'No ratified record mark exists for this performance.',
  RECORD_MARK_NOT_RATIFIED: 'The record mark is pending ratification — not a record.',
  RECORD_MARK_RESCINDED: 'The record mark was rescinded.',
  TARGET_QUALIFICATION_AUTHORITY_UNAVAILABLE:
    "The target competition authority's adoption of this qualification rule is not produced on the platform; the platform never decides another competition's qualification.",
  TARGET_QUALIFICATION_AUTHORITY_INVALID:
    "The target competition authority's adoption is withdrawn or does not adopt this exact rule version.",
  TARGET_QUALIFICATION_AUTHORITY_OUT_OF_SCOPE:
    "The adoption belongs to another target competition's authority.",
  QUALIFYING_SOURCE_MISMATCH:
    'The ranking or classification is not the exact source the qualification rule pins.',
  RANKING_SNAPSHOT_NOT_PUBLISHED: 'The ranking was not published as a snapshot.',
  RANKING_SNAPSHOT_STALE: 'The ranking snapshot rests on a basis that is no longer current.',
  RANKING_SNAPSHOT_CORRECTED: 'The ranking snapshot was corrected by a newer snapshot.',
  POSITION_OUTSIDE_QUALIFYING_RANKS: 'The position is outside the qualifying ranks.',
  CLASSIFICATION_PROVENANCE_UNAVAILABLE:
    'The classification has no derivation provenance, so it cannot qualify anyone.',
  RANK_MISSING: 'No rank is recorded for this holder.',
};

export function publicBlocker(reason: string): string {
  return BLOCKER_TEXT[reason] ?? 'A required canonical fact is not currently available.';
}

export function achievementLabel(type: AchievementType, displayName: string): string {
  return `${displayName} (${ACHIEVEMENT_TYPE_LABEL[type]})`;
}

/**
 * ADR-0050 §8 / ADR-0008: "Qualified for ⟨target⟩ (cross-competition)" — never in-competition
 * advancement, never an entry or a registration. The target name is a public competition name.
 */
export function qualificationLabel(targetCompetitionName: string): string {
  return `${QUALIFICATION_LABEL_PREFIX} ${targetCompetitionName} ${QUALIFICATION_LABEL_SUFFIX}`;
}
