import type { ContentHash } from '@br/canonical';
import {
  verificationLevelIndex,
  type RecordProvenance,
  type ResultVersionStatus,
  type VerificationLevel,
} from '@br/domain';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';
import type { RecordVerificationSummary } from './snapshot';

/**
 * Current support of a STANDING RecordMark (BRT-01 disputes §4.1–4.2, §5.3). The mark and its
 * history never change here; this pure function says whether the record is currently supported
 * and whether an append-only consequence is due:
 *
 *   basis ResultVersion REVOKED                           → INVALIDATED  RESCIND   BASIS_RESULT_REVOKED
 *   basis superseded; corrected performance no longer
 *     qualifies in the category                           → INVALIDATED  RESCIND   BASIS_CORRECTED_NO_LONGER_QUALIFIES
 *   basis superseded; corrected performance qualifies     → SUSPENDED    AWAIT_REPLACEMENT (new mark,
 *                                                           ratified again; then the old one is SUPERSEDED)
 *   basis superseded; successor not (yet) evaluable        → SUSPENDED
 *   verification not CURRENT / below the category floor   → SUSPENDED   (temporary — NEVER rescinded)
 *   otherwise                                              → SUPPORTED
 *
 * An admitted hold adds the UNDER_DISPUTE marker (it blocks new consequences, not existing ones).
 */
export interface RecordSupportFacts {
  readonly provenance: RecordProvenance;
  readonly recordMarkId: string;
  readonly requiredLevel: VerificationLevel;
  readonly v4CategoryId?: string;
  readonly pinnedRunId?: string;
  readonly basisStatus: Exclude<ResultVersionStatus, 'DRAFT'>;
  readonly supersededByVersionId?: string;
  readonly verification?: RecordVerificationSummary;
  readonly holdSupported?: boolean;
  readonly holdActive?: boolean;
  readonly successor?: 'QUALIFIES' | 'NO_LONGER_QUALIFIES' | 'PENDING';
}

export type RecordSupport = 'SUPPORTED' | 'SUSPENDED' | 'INVALIDATED';
export type SupportAction = 'NONE' | 'RESCIND' | 'AWAIT_REPLACEMENT';

export interface RecordSupportAssessment {
  readonly support: RecordSupport;
  readonly action: SupportAction;
  readonly reasons: readonly string[];
  readonly supportFactsHash: ContentHash;
  readonly facts: RecordSupportFacts;
}

export function assessRecordSupport(input: RecordSupportFacts): RecordSupportAssessment {
  const r = platformCanonicalizer().hashCanonical(
    DomainTag.recordSupport,
    SchemaRef.recordSupportFacts.id,
    SchemaRef.recordSupportFacts.version,
    input,
  );
  const f = r.normalized as unknown as RecordSupportFacts;
  const done = (support: RecordSupport, action: SupportAction, reasons: string[]) => ({
    support,
    action,
    reasons: [...new Set(reasons)].sort(),
    supportFactsHash: r.contentHash,
    facts: f,
  });
  const marker = f.holdSupported === true && f.holdActive === true ? ['UNDER_DISPUTE'] : [];
  if (f.basisStatus === 'REVOKED') return done('INVALIDATED', 'RESCIND', ['BASIS_RESULT_REVOKED']);
  if (f.basisStatus === 'SUPERSEDED' || f.supersededByVersionId !== undefined) {
    if (f.successor === 'NO_LONGER_QUALIFIES')
      return done('INVALIDATED', 'RESCIND', [
        'BASIS_RESULT_SUPERSEDED',
        'BASIS_CORRECTED_NO_LONGER_QUALIFIES',
      ]);
    if (f.successor === 'QUALIFIES')
      return done('SUSPENDED', 'AWAIT_REPLACEMENT', [
        'BASIS_RESULT_SUPERSEDED',
        'CORRECTED_MARK_AWAITING_RATIFICATION',
        ...marker,
      ]);
    return done('SUSPENDED', 'NONE', [
      'BASIS_RESULT_SUPERSEDED',
      'AWAITING_REEVALUATION',
      ...marker,
    ]);
  }
  const v = f.verification;
  const reasons: string[] = [];
  if (v === undefined) reasons.push('VERIFICATION_NOT_ASSESSED');
  else if (v.state !== 'CURRENT') reasons.push(`VERIFICATION_${v.state}`);
  else if (
    v.level === undefined ||
    verificationLevelIndex(v.level) < verificationLevelIndex(f.requiredLevel)
  )
    reasons.push('VERIFICATION_LEVEL_BELOW_REQUIRED');
  else if (
    f.v4CategoryId !== undefined &&
    !(v.ratifiedRecordCategoryIds ?? []).includes(f.v4CategoryId)
  )
    reasons.push('V4_NOT_ESTABLISHED_FOR_CATEGORY');
  if (reasons.length > 0) return done('SUSPENDED', 'NONE', [...reasons, ...marker]);
  return done('SUPPORTED', 'NONE', marker);
}
