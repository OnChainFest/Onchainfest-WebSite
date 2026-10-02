import { CanonicalError, type ContentHash } from '@br/canonical';
import {
  QUALIFICATION_PLATFORM_FLOOR,
  verificationLevelIndex,
  type QualificationBasisKind,
  type VerificationLevel,
} from '@br/domain';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';
import type { Holder } from './documents';
import type { SpecIssue } from './system';

/**
 * The qualifying fact a QUALIFIED Achievement pins (`br:qualification-basis@1`, ADR-0050). Vocabulary
 * only: the QUALIFIED derivation itself is the BRT-08 engine (achievement-engine/3, Step 9). There is
 * no qualification entity, status table or flag.
 */
export interface QualificationBasis {
  readonly kind: QualificationBasisKind;
  readonly targetCompetitionId: string;
  readonly qualifyingRanks: number;
  readonly holder: Holder;
  readonly ranking?: {
    readonly systemId: string;
    readonly systemVersionId: string;
    readonly snapshotId: string;
    readonly snapshotHash: string;
    readonly rank: number;
    readonly tied: boolean;
  };
  readonly classification?: {
    readonly resultId: string;
    readonly resultVersionId: string;
    readonly contentHash: string;
    readonly scopeType: 'EVENT_CLASSIFICATION' | 'COMPETITION_CLASSIFICATION';
    readonly status: 'FINAL';
    readonly participantId: string;
    readonly rank: number;
    readonly tied: boolean;
  };
  /** The underlying verified result versions + runs (AC-1); FINAL by schema. */
  readonly underlying: readonly {
    readonly resultVersionId: string;
    readonly contentHash: string;
    readonly resultStatus: 'FINAL';
    readonly verificationRunId: string;
    readonly verificationOutcomeHash: string;
    readonly verificationLevel: VerificationLevel;
  }[];
}

export type QualificationBasisValidation =
  | { readonly ok: true; readonly basis: QualificationBasis; readonly hash: ContentHash }
  | { readonly ok: false; readonly issues: readonly SpecIssue[] };

/**
 * Shape + coherence of a qualification basis: exactly the position member its kind names, a position
 * within the qualifying ranks, every underlying version at or above FINAL · V3 (no V2 alternative),
 * and — for a classification position — the classification version itself among the underlying pins.
 * Target authority, hold and eligibility are FACTS checked at derivation (Step 9), never here.
 */
export function validateQualificationBasis(input: unknown): QualificationBasisValidation {
  let basis: QualificationBasis;
  let hash: ContentHash;
  try {
    const r = platformCanonicalizer().hashCanonical(
      DomainTag.qualificationBasis,
      SchemaRef.qualificationBasis.id,
      SchemaRef.qualificationBasis.version,
      input,
    );
    basis = r.normalized as unknown as QualificationBasis;
    hash = r.contentHash;
  } catch (err) {
    if (err instanceof CanonicalError)
      return { ok: false, issues: [{ path: err.path || '/', code: err.code }] };
    throw err;
  }
  const issues: SpecIssue[] = [];
  const issue = (path: string, code: string) => issues.push({ path, code });
  const position =
    basis.kind === 'RANKING_SNAPSHOT_POSITION' ? basis.ranking : basis.classification;
  if (basis.kind === 'RANKING_SNAPSHOT_POSITION') {
    if (basis.ranking === undefined) issue('/ranking', 'QUALIFICATION_BASIS_KIND_MISMATCH');
    if (basis.classification !== undefined)
      issue('/classification', 'QUALIFICATION_BASIS_KIND_MISMATCH');
  } else {
    if (basis.classification === undefined)
      issue('/classification', 'QUALIFICATION_BASIS_KIND_MISMATCH');
    if (basis.ranking !== undefined) issue('/ranking', 'QUALIFICATION_BASIS_KIND_MISMATCH');
    const c = basis.classification;
    if (
      c !== undefined &&
      !basis.underlying.some(
        (u) => u.resultVersionId === c.resultVersionId && u.contentHash === c.contentHash,
      )
    )
      issue('/underlying', 'UNDERLYING_MISSING_CLASSIFICATION');
  }
  if (position !== undefined && position.rank > basis.qualifyingRanks)
    issue('/qualifyingRanks', 'POSITION_OUTSIDE_QUALIFYING_RANKS');
  const floor = QUALIFICATION_PLATFORM_FLOOR.minimumVerificationLevel;
  basis.underlying.forEach((u, i) => {
    if (verificationLevelIndex(u.verificationLevel) < verificationLevelIndex(floor))
      issue(`/underlying/${i}/verificationLevel`, 'VERIFICATION_LEVEL_BELOW_REQUIRED');
  });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, basis, hash };
}
