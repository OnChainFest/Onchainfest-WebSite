import { CanonicalError, type ContentHash } from '@br/canonical';
import {
  DomainError,
  DomainErrorCode,
  type DerivationFactKind,
  type DerivationProvenance,
  type Mark,
  type ResultOutcome,
  type ResultScopeType,
  type ResultVersionStatus,
  type VerificationLevel,
} from '@br/domain';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';
import type { AchievementRuleSpec } from './rule';

/**
 * AchievementDerivationSnapshot (`br:achievement-derivation-snapshot@1`) — the ONLY input of the
 * pure Achievement engine. Assembled BEFORE derivation from canonical facts (or, in tests only,
 * built as a REFERENCE ENGINE FIXTURE). Ids, codes, hashes and platform timestamps only: no names,
 * slugs, PII, evidence or private authority topology. The cutoff is metadata, never a member.
 */
export type Timestamp = string;

export type VerificationState = 'CURRENT' | 'STALE' | 'NOT_EVALUATED' | 'POLICY_UNAVAILABLE';

/** Recognition levels (BRT-01 §4.3; PLATFORM is incomparable with the federation ladder). */
export type RecognitionLevelValue =
  'PLATFORM' | 'CLUB' | 'REGIONAL' | 'NATIONAL' | 'CONTINENTAL' | 'WORLD';

/**
 * BRT-01 §8.1 governingAuthority as pinned from the IMMUTABLE trace of a VerificationRun: the trust
 * anchor behind the passing V2 certification (or V3 sanction) and the recognition level it gives.
 */
export interface GoverningRecognitionScope {
  readonly recognitionLevel: readonly RecognitionLevelValue[];
  readonly sport?: readonly string[];
  readonly discipline?: readonly string[];
  readonly region?: readonly string[];
}

export interface GoverningRecognition {
  readonly recognitionLevel: RecognitionLevelValue;
  readonly anchorId: string;
  readonly source: 'CERTIFICATION' | 'SANCTION';
  /** fact_hash of the immutable trust-anchor fact the pinned trace names (re-verified). */
  readonly anchorFactHash: string;
  /** That anchor's recognition scope (BRT-03 vocabulary). Absent ⇒ unknown ⇒ claims fail closed. */
  readonly recognitionScope?: GoverningRecognitionScope;
}

export interface VerificationSummary {
  readonly state: VerificationState;
  readonly runId?: string;
  readonly policyVersionId?: string;
  readonly snapshotHash?: string;
  readonly outcomeHash?: string;
  /** The latest run's highest satisfied level (only meaningful when CURRENT). */
  readonly level?: VerificationLevel;
  /** BRT-06 Evidence Bundle hash evaluated by the run, and the run's cutoff (the bundle asOf). */
  readonly evidenceBundleHash?: string;
  readonly evaluatedAsOf?: Timestamp;
  readonly governingRecognition?: GoverningRecognition;
}

export interface SnapshotPerformance {
  readonly participantId: string;
  readonly athleteId?: string;
  readonly ordinal: number;
  readonly mark: Mark;
  readonly valid: boolean;
}

export interface SnapshotComparison extends SnapshotPerformance {
  readonly resultVersionId: string;
  readonly contentHash: string;
  readonly disciplineVersionId: string;
  readonly athleteId: string;
  readonly occurredAt?: Timestamp;
  readonly status: Exclude<ResultVersionStatus, 'DRAFT'>;
  readonly verification: VerificationSummary;
}

export interface AchievementDerivationSnapshot {
  readonly provenance: DerivationProvenance;
  readonly assembler: string;
  readonly rule: {
    readonly ruleId: string;
    readonly ruleVersionId: string;
    readonly code: string;
    readonly version: number;
    readonly specHash: string;
    readonly spec: AchievementRuleSpec;
    readonly bindingId: string;
  };
  readonly supportedFactKinds: readonly DerivationFactKind[];
  readonly discipline: {
    readonly disciplineVersionId: string;
    readonly sport?: string;
    readonly discipline?: string;
    readonly metrics: readonly {
      readonly key: string;
      readonly valueType: 'INTEGER' | 'DECIMAL' | 'DURATION_MS';
      readonly unit: string;
      readonly order?: 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER' | 'ORDINAL';
    }[];
  };
  readonly hierarchy: {
    readonly competitionId: string;
    readonly eventId?: string;
    readonly roundId?: string;
    readonly contestId?: string;
  };
  readonly resultVersion: {
    readonly resultVersionId: string;
    readonly resultId: string;
    readonly versionNumber: number;
    readonly contentHash: string;
    readonly scopeType: ResultScopeType;
    readonly scopeTargetId: string;
    readonly submittedAt: Timestamp;
    readonly status: Exclude<ResultVersionStatus, 'DRAFT'>;
    readonly supersedesVersionId?: string;
    readonly supersededByVersionId?: string;
  };
  readonly verification: VerificationSummary;
  readonly hold?: { readonly active: boolean };
  readonly entries: readonly {
    readonly participantId: string;
    readonly outcome: ResultOutcome;
    readonly rank?: number;
  }[];
  readonly performances?: readonly SnapshotPerformance[];
  readonly participants: readonly {
    readonly participantId: string;
    readonly kind: 'INDIVIDUAL' | 'TEAM';
    readonly athleteId?: string;
    readonly teamId?: string;
  }[];
  readonly creditedLineups?: readonly {
    readonly participantId: string;
    readonly athleteIds: readonly string[];
  }[];
  readonly occurrence?: { readonly startedAt: Timestamp };
  readonly comparisons?: readonly SnapshotComparison[];
}

export interface SealedDerivationSnapshot {
  readonly snapshot: AchievementDerivationSnapshot;
  readonly snapshotHash: ContentHash;
  readonly canonicalText: string;
}

/** Normalizes (sets sorted, closed schema) and hashes a snapshot; invalid input is an integrity failure. */
export function sealDerivationSnapshot(input: unknown): SealedDerivationSnapshot {
  try {
    const r = platformCanonicalizer().hashCanonical(
      DomainTag.achievementDerivationSnapshot,
      SchemaRef.achievementDerivationSnapshot.id,
      SchemaRef.achievementDerivationSnapshot.version,
      input,
    );
    return {
      snapshot: r.normalized as unknown as AchievementDerivationSnapshot,
      snapshotHash: r.contentHash,
      canonicalText: r.canonicalText,
    };
  } catch (err) {
    if (err instanceof CanonicalError)
      throw new DomainError(
        DomainErrorCode.ACHIEVEMENT_INTEGRITY_FAILURE,
        'derivation snapshot is not canonical',
        { reason: 'SNAPSHOT_NOT_CANONICAL', path: err.path, code: err.code },
      );
    throw err;
  }
}

export function hashDerivationSnapshot(input: unknown): ContentHash {
  return sealDerivationSnapshot(input).snapshotHash;
}

/** H("achievement-credited-lineup", …) — the basis commitment to a participant's credited lineup. */
export function creditedLineupHash(
  resultVersionId: string,
  participantId: string,
  athleteIds: readonly string[],
): ContentHash {
  return platformCanonicalizer().hashCanonical(
    DomainTag.achievementLineup,
    SchemaRef.achievementCreditedLineup.id,
    SchemaRef.achievementCreditedLineup.version,
    { resultVersionId, participantId, athleteIds },
  ).contentHash;
}
