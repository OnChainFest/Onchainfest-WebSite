import {
  VERIFICATION_LEVEL_LABEL,
  type CriterionStatus,
  type EvaluationState,
  type VerificationFreshness,
  type VerificationLevel,
} from '@br/domain';
import type { LevelStatus, VerificationOutcome } from './engine';

/**
 * Public-safe verification presentation (BRT-07 §87–93). Built ONLY from an outcome's level and
 * criterion KINDS/STATUSES — never from the internal trace — so it can carry no principal, account,
 * person, grant, key, evidence or attestation identifier, no hash of private evidence and no
 * authority topology. Levels are always shown with their exact name; there is no "Verified ✓",
 * no percentage and no score.
 */
export const PUBLIC_VERIFICATION_NOTICE =
  'Verification is a deterministic assessment of canonical facts under a published policy — not a probability, score or guarantee.';

export interface PublicLevelLine {
  readonly level: VerificationLevel;
  readonly label: string;
  readonly status: LevelStatus;
}

export interface PublicBlockedCriterion {
  readonly criterion: string;
  readonly status: CriterionStatus;
  readonly explanation: string;
}

export interface PublicVerificationBody {
  readonly evaluationState: EvaluationState;
  readonly level?: VerificationLevel;
  readonly label?: string;
  readonly levels: readonly PublicLevelLine[];
  readonly next?: {
    readonly level: VerificationLevel;
    readonly label: string;
    readonly blocked: readonly PublicBlockedCriterion[];
  };
  readonly activeDispute: boolean;
}

const ACTIVE_DISPUTE_KINDS = new Set([
  'NO_COUNTERPARTY_DENY',
  'NO_ACTIVE_DISPUTE',
  'NO_AUTHORIZED_DENY',
]);

/** Fixed public wording per criterion kind × status (no identifiers are ever interpolated). */
export function publicExplanation(kind: string, status: CriterionStatus): string {
  if (status === 'INPUT_NOT_SUPPORTED') {
    switch (kind) {
      case 'OFFICIAL_DECLARATION':
        return 'Required canonical event-certification fact (RESULT_OFFICIAL, or RESULT_ACCURATE with an official T5 declaration) is not currently available on the platform.';
      case 'NO_INVALIDATING_ASSESSMENT':
        return 'Evidence assessments are not yet produced on the platform, so the absence of an invalidating assessment cannot be established.';
      case 'COMPETITION_SANCTIONED':
      case 'CERTIFICATION_ROOTED_IN_SANCTION':
        return 'Competition sanctioning facts are not currently available on the platform.';
      case 'OFFICIAL_EVIDENCE_SET':
        return 'Discipline official evidence-set declarations are not currently available on the platform.';
      case 'IDENTITY_CONFIRMED':
        return 'Identity confirmation facts are not currently available on the platform.';
      case 'CONDITIONS_COMPLIANT':
      case 'RECORD_RATIFIED':
        return 'Record-category and ratification facts are not currently available on the platform.';
      case 'DERIVED_INPUT_LEVELS':
        return 'Classification inputs are not yet linked to their verified contest results.';
      default:
        return 'A required canonical fact is not currently available on the platform.';
    }
  }
  if (status === 'UNKNOWN')
    return 'Participation or authority facts needed with certainty are incomplete.';
  switch (kind) {
    case 'CLAIM_BOUND':
      return 'The submitted claim could not be bound to a known submitter.';
    case 'INDEPENDENT_CORROBORATION':
      return 'No sufficient corroboration from a counterparty or a registered official independent of the submitter’s side.';
    case 'NO_COUNTERPARTY_DENY':
      return 'A participant disputes this result.';
    case 'NO_ACTIVE_DISPUTE':
      return 'An active dispute claim exists.';
    case 'PRIMARY_EVIDENCE':
      return 'Required primary evidence is missing, unavailable or machine-derived only.';
    case 'PRIMARY_EVIDENCE_INTEGRITY':
      return 'Primary evidence integrity could not be established.';
    case 'NO_INVALIDATING_ASSESSMENT':
      return 'Primary evidence has an invalidating assessment.';
    case 'OFFICIAL_DECLARATION':
      return 'No official declaration by an authorized, independent result authority.';
    case 'NO_AUTHORIZED_DENY':
      return 'An authorized result authority disputes this result.';
    case 'COMPETITION_SANCTIONED':
      return 'No sanction by a recognized body at the required recognition level.';
    case 'CERTIFICATION_ROOTED_IN_SANCTION':
      return 'The certifying authority is not rooted in the sanctioning recognition.';
    case 'OFFICIAL_EVIDENCE_SET':
      return 'The discipline’s official evidence set is incomplete.';
    case 'IDENTITY_CONFIRMED':
      return 'Athlete identities are not confirmed by an authorized principal.';
    case 'CONDITIONS_COMPLIANT':
      return 'Conditions compliance is not attested by an authorized principal.';
    case 'INDEPENDENT_PRIMARY_SOURCES':
      return 'Fewer independent primary sources than required.';
    case 'NON_WITNESSED_SIGNATURES':
      return 'A counted signature was platform-witnessed rather than held-key or device-signed.';
    case 'RECORD_RATIFIED':
      return 'No ratification by the recognizing authority for the record category.';
    default:
      return 'A required criterion is not met.';
  }
}

export function publicBody(outcome: VerificationOutcome): PublicVerificationBody {
  const levels = outcome.levels.map((l) => ({
    level: l.level,
    label: VERIFICATION_LEVEL_LABEL[l.level],
    status: l.status,
  }));
  const blockedLevel = outcome.levels.find((l) => l.status === 'BLOCKED');
  const activeDispute =
    outcome.levels.some((l) =>
      (l.criteria ?? []).some(
        (c) =>
          ACTIVE_DISPUTE_KINDS.has(c.kind) &&
          (c.reasons ?? []).some((r) =>
            [
              'COUNTERPARTY_DENY',
              'ACTIVE_DISPUTE_CLAIM',
              'AUTHORIZED_DENY',
              'COUNTERPARTY_DENY_OUTRANKED_BY_CERTIFICATION',
            ].includes(r),
          ),
      ),
    ) || (outcome.flags ?? []).includes('CONTRADICTING_ATTESTATION');
  const level = outcome.highestSatisfiedLevel;
  return {
    evaluationState: outcome.evaluationState,
    ...(level === undefined ? {} : { level, label: VERIFICATION_LEVEL_LABEL[level] }),
    levels,
    ...(blockedLevel === undefined
      ? {}
      : {
          next: {
            level: blockedLevel.level,
            label: VERIFICATION_LEVEL_LABEL[blockedLevel.level],
            blocked: (blockedLevel.criteria ?? [])
              .filter((c) => c.status !== 'PASS')
              .map((c) => ({
                criterion: c.kind,
                status: c.status,
                explanation: publicExplanation(c.kind, c.status),
              })),
          },
        }),
    activeDispute,
  };
}

/** "Corroborated (V1)" — exact label with the level, never a bare "Verified". */
export function levelDisplay(level: VerificationLevel): string {
  return `${VERIFICATION_LEVEL_LABEL[level]} (${level})`;
}

/** One-line public statement for a current / stale / missing assessment. */
export function publicStatement(input: {
  readonly freshness: VerificationFreshness;
  readonly evaluationState: EvaluationState;
  readonly level?: VerificationLevel;
  readonly policy?: { readonly code: string; readonly version: number };
}): string {
  if (input.evaluationState === 'POLICY_UNAVAILABLE')
    return 'No published verification policy applies to this discipline version; the result is not assessed.';
  if (input.freshness === 'NOT_EVALUATED') return 'This result version has not been assessed yet.';
  if (input.freshness === 'STALE')
    return 'Canonical facts or the applicable policy changed since the last assessment; re-evaluation is required.';
  if (input.evaluationState === 'INSUFFICIENT_INPUT' || input.level === undefined)
    return 'The claim prerequisites of V0 could not be established from canonical facts.';
  const p = input.policy === undefined ? '' : ` ${input.policy.code} v${input.policy.version}`;
  return `${levelDisplay(input.level)}: current canonical facts satisfy policy${p} up to this level.`;
}
