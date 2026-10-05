import { CanonicalError, type ContentHash } from '@br/canonical';
import {
  DomainError,
  DomainErrorCode,
  type ClassificationStaleReason,
  type DerivationFactKind,
  type DerivationProvenance,
  type HolderType,
  type Mark,
  type RankingSnapshotStaleReason,
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

/**
 * BRT-09 RECORD_SET (RECORD_RATIFICATION kind): the exact RecordMark facts — its pin, current status,
 * the category floor, holder and Performance basis + value. Never present in production today (no
 * canonical ratification producer, ADR-0045).
 */
export interface SnapshotRecordMark {
  readonly recordMarkId: string;
  readonly markHash: string;
  readonly categoryId: string;
  readonly categoryVersionId: string;
  readonly categoryVersionHash: string;
  readonly scopeType:
    | 'PERSONAL'
    | 'VENUE'
    | 'COMPETITION'
    | 'LEAGUE'
    | 'PLATFORM'
    | 'NATIONAL'
    | 'CONTINENTAL'
    | 'WORLD';
  readonly standing: 'RATIFIED' | 'CANONICAL';
  readonly ratificationEntryId: string;
  readonly ratificationHash: string;
  readonly recognitionLevel: RecognitionLevelValue;
  readonly currentStatus:
    'PENDING_RATIFICATION' | 'RATIFIED' | 'CANONICAL' | 'SUPERSEDED' | 'RESCINDED';
  readonly requiredLevel: VerificationLevel;
  readonly holder: { readonly holderType: 'ATHLETE' | 'TEAM'; readonly holderId: string };
  readonly participantId: string;
  readonly performanceOrdinal: number;
  readonly value: Mark;
}

/** BRT-10 QUALIFIED: one ranked holder's pinned verified basis, copied from the snapshot entry. */
export interface SnapshotRankingBasisPin {
  readonly resultVersionId: string;
  readonly contentHash: string;
  readonly participantId: string;
  readonly verificationRunId: string;
  readonly verificationSnapshotHash: string;
  readonly verificationOutcomeHash: string;
  readonly verificationLevel: VerificationLevel;
  readonly evidenceBundleHash: string;
  readonly evidenceBundleAsOf: Timestamp;
}

/**
 * BRT-10 QUALIFIED facts (ADR-0050): the qualifying source — a ranking run (with its PUBLISHED
 * snapshot when one exists) OR a `@2` classification ResultVersion — plus hold and the target
 * authority's adoption (TARGET_QUALIFICATION_AUTHORITY: no producer; REFERENCE_FIXTURE only).
 * Staleness is the Step 7 read-time computation, as observed by the assembler.
 */
export interface SnapshotQualification {
  readonly ranking?: {
    readonly systemId: string;
    readonly systemVersionId: string;
    readonly specHash: string;
    readonly runId: string;
    readonly runOutcomeHash: string;
    readonly published?: {
      readonly snapshotId: string;
      readonly snapshotHash: string;
      readonly lineageKind: 'INITIAL' | 'FOLLOWS' | 'CORRECTS';
      readonly priorSnapshotId?: string;
      readonly priorSnapshotHash?: string;
    };
    readonly correctedBySnapshotId?: string;
    readonly staleness: {
      readonly state: 'CURRENT' | 'STALE';
      readonly reasons?: readonly RankingSnapshotStaleReason[];
    };
    readonly entries: readonly {
      readonly holder: { readonly holderType: HolderType; readonly holderId: string };
      readonly rank: number;
      readonly tied: boolean;
      readonly basis: readonly SnapshotRankingBasisPin[];
    }[];
  };
  readonly classification?: {
    readonly resultId: string;
    readonly resultVersionId: string;
    readonly contentHash: string;
    readonly scopeType: 'EVENT_CLASSIFICATION' | 'COMPETITION_CLASSIFICATION';
    readonly scopeTargetId: string;
    readonly status: Exclude<ResultVersionStatus, 'DRAFT'>;
    readonly supersedesVersionId?: string;
    readonly supersededByVersionId?: string;
    readonly policyId: string;
    readonly policyVersionId: string;
    readonly policySpecHash: string;
    readonly disciplineVersionId: string;
    readonly inputsDigest: string;
    readonly staleness: {
      readonly state: 'CURRENT' | 'STALE';
      readonly reasons?: readonly ClassificationStaleReason[];
    };
    readonly verification: VerificationSummary;
    readonly entries: readonly {
      readonly participantId: string;
      readonly rank?: number;
      readonly tied: boolean;
    }[];
    readonly participants: readonly {
      readonly participantId: string;
      readonly kind: 'INDIVIDUAL' | 'TEAM';
      readonly athleteId?: string;
      readonly teamId?: string;
    }[];
  };
  readonly hold?: { readonly active: boolean };
  readonly targetAuthority?: {
    readonly targetCompetitionId: string;
    readonly ruleVersionId: string;
    readonly ruleSpecHash: string;
    readonly adoptionId: string;
    readonly adoptionHash: string;
    readonly status: 'ADOPTED' | 'WITHDRAWN';
  };
}

interface DerivationSnapshotBase {
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
  readonly discipline: SnapshotDiscipline;
}

/**
 * A QUALIFYING_POSITION derivation (BRT-10): no single ResultVersion — every fact is in
 * `qualification`. Exactly one of the two snapshot shapes is ever sealed.
 */
export interface QualificationDerivationSnapshot extends DerivationSnapshotBase {
  readonly qualification: SnapshotQualification;
}

/** One exact ResultVersion under one rule version (every BRT-08 / BRT-09 criterion). */
export interface AchievementDerivationSnapshot extends DerivationSnapshotBase {
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
  readonly record?: SnapshotRecordMark;
}

export type DerivationSnapshot = AchievementDerivationSnapshot | QualificationDerivationSnapshot;

export const isQualificationSnapshot = (
  s: DerivationSnapshot,
): s is QualificationDerivationSnapshot => 'qualification' in s;

export interface SnapshotDiscipline {
  readonly disciplineVersionId: string;
  readonly sport?: string;
  readonly discipline?: string;
  readonly metrics: readonly {
    readonly key: string;
    readonly valueType: 'INTEGER' | 'DECIMAL' | 'DURATION_MS';
    readonly unit: string;
    readonly order?: 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER' | 'ORDINAL';
  }[];
}

export interface SealedDerivationSnapshot<S extends DerivationSnapshot = DerivationSnapshot> {
  readonly snapshot: S;
  readonly snapshotHash: ContentHash;
  readonly canonicalText: string;
}

const RESULT_VERSION_MEMBERS = [
  'hierarchy',
  'resultVersion',
  'verification',
  'entries',
  'participants',
] as const;
/** Members that only a ResultVersion derivation may carry (never mixed with `qualification`). */
const RESULT_VERSION_ONLY = [
  ...RESULT_VERSION_MEMBERS,
  'hold',
  'performances',
  'creditedLineups',
  'occurrence',
  'comparisons',
  'record',
] as const;

/**
 * Normalizes (sets sorted, closed schema) and hashes a snapshot; invalid input is an integrity failure.
 * Exactly one shape is admitted: a ResultVersion derivation (every result-version member present, no
 * `qualification`) or a QUALIFIED derivation (`qualification` and no result-version member).
 */
export function sealDerivationSnapshot(input: unknown): SealedDerivationSnapshot {
  try {
    const r = platformCanonicalizer().hashCanonical(
      DomainTag.achievementDerivationSnapshot,
      SchemaRef.achievementDerivationSnapshot.id,
      SchemaRef.achievementDerivationSnapshot.version,
      input,
    );
    const doc = r.normalized as Record<string, unknown>;
    const shapeOk =
      'qualification' in doc
        ? RESULT_VERSION_ONLY.every((k) => !(k in doc))
        : RESULT_VERSION_MEMBERS.every((k) => k in doc);
    if (!shapeOk)
      throw new DomainError(
        DomainErrorCode.ACHIEVEMENT_INTEGRITY_FAILURE,
        'derivation snapshot mixes or lacks the ResultVersion / qualification shapes',
        { reason: 'SNAPSHOT_NOT_CANONICAL', code: 'SNAPSHOT_SHAPE_INVALID' },
      );
    return {
      snapshot: r.normalized as unknown as DerivationSnapshot,
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
