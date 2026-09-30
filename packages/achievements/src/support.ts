import type { ContentHash } from '@br/canonical';
import {
  verificationLevelIndex,
  type AchievementStatus,
  type DerivationProvenance,
  type ResultVersionStatus,
  type VerificationLevel,
} from '@br/domain';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';
import type { VerificationSummary } from './snapshot';

/**
 * Current support of an IMMUTABLE Achievement (BRT-01 disputes §5.1). The Achievement fact never
 * changes; this pure function decides which status entry its history should now carry, from the
 * current state of its exact basis:
 *
 *   basis ResultVersion REVOKED                                   → REVOKED    BASIS_RESULT_REVOKED
 *   a newer Achievement (same type/rule/holder/scope) replaced it → SUPERSEDED REPLACED_BY_NEWER_BASIS
 *   basis superseded; the successor was derived with every gate
 *     passing and this holder no longer qualifies                → REVOKED    HOLDER_NO_LONGER_QUALIFIES
 *   basis superseded; successor not (yet) issuable                → SUSPENDED  BASIS_RESULT_SUPERSEDED
 *   pinned VerificationRun no longer the CURRENT one, or the
 *     current level is below the rule's level                     → SUSPENDED  VERIFICATION_…
 *   otherwise                                                     → ACTIVE
 *
 * An admitted hold does not change status (BRT-01 §1.3: holds block NEW consequences; existing
 * displays show an "under dispute" marker) — it adds the UNDER_DISPUTE marker. SUSPENDED is never a
 * deletion: a later assessment may return ACTIVE, appended as a new status entry.
 */
export interface SupportBasisFact {
  readonly resultVersionId: string;
  readonly pinnedRunId: string;
  readonly status: Exclude<ResultVersionStatus, 'DRAFT'>;
  readonly supersededByVersionId?: string;
  /**
   * BRT-07 current verification of the basis version, freshness computed now. Absent only when it
   * is irrelevant to the decision (e.g. the basis was already replaced by a newer Achievement).
   */
  readonly verification?: VerificationSummary;
}

export interface SupportFacts {
  readonly provenance: DerivationProvenance;
  readonly achievementId: string;
  readonly requiredLevel: VerificationLevel;
  readonly basis: readonly SupportBasisFact[];
  readonly holdSupported?: boolean;
  readonly holdActive?: boolean;
  readonly replacementAchievementId?: string;
  readonly successorDerivation?: 'HOLDER_QUALIFIES' | 'HOLDER_DOES_NOT_QUALIFY' | 'BLOCKED';
}

export interface SupportAssessment {
  readonly status: AchievementStatus;
  readonly reasons: readonly string[];
  readonly supersededBy?: string;
  readonly supportFactsHash: ContentHash;
  readonly facts: SupportFacts;
}

export function hashSupportFacts(facts: SupportFacts): {
  hash: ContentHash;
  normalized: SupportFacts;
} {
  const r = platformCanonicalizer().hashCanonical(
    DomainTag.achievementSupport,
    SchemaRef.achievementSupportFacts.id,
    SchemaRef.achievementSupportFacts.version,
    facts,
  );
  return { hash: r.contentHash, normalized: r.normalized as unknown as SupportFacts };
}

export function assessSupport(input: SupportFacts): SupportAssessment {
  const { hash, normalized: f } = hashSupportFacts(input);
  const done = (status: AchievementStatus, reasons: string[], supersededBy?: string) => ({
    status,
    reasons: [...new Set(reasons)].sort(),
    ...(supersededBy === undefined ? {} : { supersededBy }),
    supportFactsHash: hash,
    facts: f,
  });
  const marker = f.holdSupported === true && f.holdActive === true ? ['UNDER_DISPUTE'] : [];
  if (f.basis.some((b) => b.status === 'REVOKED')) return done('REVOKED', ['BASIS_RESULT_REVOKED']);
  if (f.replacementAchievementId !== undefined)
    return done('SUPERSEDED', ['REPLACED_BY_NEWER_BASIS'], f.replacementAchievementId);
  const superseded = f.basis.some(
    (b) => b.status === 'SUPERSEDED' || b.supersededByVersionId !== undefined,
  );
  if (superseded)
    return f.successorDerivation === 'HOLDER_DOES_NOT_QUALIFY'
      ? done('REVOKED', ['BASIS_RESULT_SUPERSEDED', 'HOLDER_NO_LONGER_QUALIFIES'])
      : done('SUSPENDED', ['BASIS_RESULT_SUPERSEDED', 'AWAITING_REDERIVATION', ...marker]);
  const reasons: string[] = [];
  for (const b of f.basis) {
    const v = b.verification;
    if (v === undefined) reasons.push('VERIFICATION_NOT_ASSESSED');
    else if (v.state !== 'CURRENT') reasons.push(`VERIFICATION_${v.state}`);
    else if (v.runId !== b.pinnedRunId) reasons.push('VERIFICATION_RUN_NO_LONGER_CURRENT');
    else if (
      v.level === undefined ||
      verificationLevelIndex(v.level) < verificationLevelIndex(f.requiredLevel)
    )
      reasons.push('VERIFICATION_LEVEL_BELOW_REQUIRED');
  }
  if (reasons.length > 0) return done('SUSPENDED', [...reasons, ...marker]);
  return done('ACTIVE', marker);
}
