import { RECORD_STATUS_LABEL, type RecordMarkStatus } from '@br/domain';
import type { RecordSupport } from './support';

/**
 * Public-safe record wording (fixed sentences; no identifier is ever interpolated). A record is
 * never "V4": the level belongs to the verification of its basis result. PENDING and RESCINDED
 * marks are never presented as records; SUPERSEDED marks are former records.
 */
export const PUBLIC_RECORD_NOTICE =
  'A record mark states that a verified performance held record standing in one exactly defined comparison universe, as recognized by the ratifying authority. It is not a ranking, a prize or a trophy.';

export const HALL_OF_FAME_NOTICE =
  'The Record Hall of Fame is a rebuildable view of legitimate record history (current and former holders). It is not a greatness ranking, an editorial award or a manual induction.';

export function recordStatusStatement(status: RecordMarkStatus): string {
  switch (status) {
    case 'PENDING_RATIFICATION':
      return 'Record claim pending ratification — not a record.';
    case 'RATIFIED':
      return 'Ratified by the category’s recognizing authority.';
    case 'CANONICAL':
      return 'Ratified by the canonical keeper of this record universe (official registry).';
    case 'SUPERSEDED':
      return 'Former record — a better (or corrected) mark superseded it.';
    case 'RESCINDED':
      return 'Rescinded — its basis was invalidated. Kept in history; not a record.';
  }
}

export const recordStatusLabel = (status: RecordMarkStatus) => RECORD_STATUS_LABEL[status];

export function recordSupportStatement(support: RecordSupport): string {
  switch (support) {
    case 'SUPPORTED':
      return 'Currently supported: its verified basis still satisfies the category floor.';
    case 'SUSPENDED':
      return 'Current support is suspended pending re-evaluation of its basis (history is unchanged).';
    case 'INVALIDATED':
      return 'Its basis was invalidated; rescission follows.';
  }
}

const REASON_TEXT: Readonly<Record<string, string>> = {
  BASIS_RESULT_REVOKED: 'The basis result was revoked.',
  BASIS_RESULT_SUPERSEDED: 'The basis result was superseded by a corrected version.',
  BASIS_CORRECTED_NO_LONGER_QUALIFIES:
    'Under the corrected result the performance no longer qualifies.',
  CORRECTED_MARK_AWAITING_RATIFICATION:
    'The corrected performance still qualifies; its new mark awaits ratification.',
  AWAITING_REEVALUATION: 'The corrected result has not (yet) been re-evaluated.',
  VERIFICATION_STALE: 'The verification the record relied on is no longer current.',
  VERIFICATION_NOT_EVALUATED: 'The basis result has no current verification.',
  VERIFICATION_POLICY_UNAVAILABLE: 'No verification policy currently applies to the basis result.',
  VERIFICATION_LEVEL_BELOW_REQUIRED:
    'The current verification of the basis result is below the category floor.',
  V4_NOT_ESTABLISHED_FOR_CATEGORY: 'The current verification is not V4 for this record category.',
  VERIFICATION_NOT_ASSESSED: 'The verification of the basis was not assessed.',
  UNDER_DISPUTE: 'The basis is under an admitted dispute.',
  CURRENT_SUPPORT_UNASSESSABLE:
    'Current support could not be assessed right now; it is not presented as current.',
};

export function publicRecordReason(reason: string): string {
  return REASON_TEXT[reason] ?? 'The basis of this record changed.';
}

const BLOCKER_TEXT: Readonly<Record<string, string>> = {
  VERIFICATION_LEVEL_BELOW_REQUIRED:
    'The current verification level of the performance is below the category floor (V3 / V4 are not yet produced on the platform).',
  RESULT_STATUS_BELOW_REQUIRED:
    'The result has not reached FINAL (OFFICIAL / FINAL declarations are not yet produced on the platform).',
  HOLD_STATE_UNAVAILABLE:
    'Dispute/hold facts are not yet produced on the platform, so the absence of a hold cannot be established.',
  HOLD_ACTIVE: 'The result is under an admitted dispute (hold).',
  POPULATION_FACT_UNAVAILABLE:
    'The category restricts its population and no canonical population fact exists for this performance.',
  HANDICAP_MODE_UNKNOWN: 'Whether the value is scratch or handicap-adjusted is not established.',
  HANDICAP_VALUE_IN_SCRATCH_CATEGORY: 'A handicap-adjusted value never enters a SCRATCH category.',
  POPULATION_MISMATCH: 'The performance is outside the category population.',
  CONDITIONS_FACT_UNAVAILABLE: 'Required record conditions are not established by canonical facts.',
  CONDITION_NOT_MET: 'A required record condition was not met.',
  CONDITION_LIMIT_EXCEEDED: 'A record condition limit was exceeded.',
  RATIFICATION_UNAVAILABLE:
    'Record ratification attestations are not yet produced on the platform (deferred producer).',
  RATIFICATION_MISSING: 'No ratification by the recognizing authority exists.',
  RATIFICATION_NOT_AUTHORIZED:
    'The ratifying principal is not authorized for this record scope (sport, region, level).',
  NOT_BETTER_THAN_CURRENT_RECORD: 'The mark is not better than the record at its time.',
  EQUALS_CURRENT_RECORD_FIRST_ACHIEVED:
    'The mark equals the record; under this category the first achiever keeps it.',
  PERFORMANCE_BEFORE_CATEGORY_EFFECTIVE_FROM:
    'The performance happened before the category took effect.',
  OUTSIDE_COMPETITION_SCOPE: 'The performance is outside the category’s competition series.',
  VENUE_MEMBERSHIP_UNAVAILABLE: 'No canonical venue fact exists for this contest.',
  LEAGUE_MEMBERSHIP_UNAVAILABLE: 'No canonical league fact exists for this competition.',
  REGION_ELIGIBILITY_UNAVAILABLE:
    'No canonical regional-eligibility fact exists for this performer (private identity data is never used).',
  CATEGORY_VERSION_RETIRED: 'The category version is retired.',
  OCCURRENCE_TIME_UNKNOWN: 'The contest occurrence time is not known.',
};

export function publicRecordBlocker(reason: string): string {
  return BLOCKER_TEXT[reason] ?? 'A required canonical fact is not currently available.';
}
