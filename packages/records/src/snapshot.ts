import { CanonicalError, type ContentHash } from '@br/canonical';
import type { GoverningRecognition, VerificationSummary } from '@br/achievements';
import {
  DomainError,
  DomainErrorCode,
  type Capability,
  type AuthorityScope,
  type HolderType,
  type Mark,
  type PopulationDimension,
  type PrincipalType,
  type RatificationKind,
  type RatificationProvenance,
  type RecognitionScope,
  type RecordFactKind,
  type RecordProvenance,
  type RecordStanding,
  type ResultScopeType,
  type ResultVersionStatus,
} from '@br/domain';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';
import type { ConditionAspect, RecordCategorySpec } from './category';

/**
 * RecordEvaluationSnapshot (`br:record-evaluation-snapshot@1`) — the ONLY input of the pure record
 * engine. Assembled from canonical facts (or, in tests only, built as a REFERENCE ENGINE FIXTURE):
 * one exact verified Performance, one exact RecordCategoryVersion, the record standing at the
 * performance's sporting time, and — to ratify a pending mark — the ratification fact plus the
 * authority facts that authorize it. No PII (no DOB, legal sex, nationality document), no evidence.
 */
export type Timestamp = string;

export interface RecordVerificationSummary extends VerificationSummary {
  /** BRT-07 V4 is per record category (never present in production today). */
  readonly ratifiedRecordCategoryIds?: readonly string[];
}

export interface StandingMark {
  readonly recordMarkId: string;
  readonly markHash: string;
  readonly holder: { readonly holderType: HolderType; readonly holderId: string };
  readonly value: Mark;
  readonly effectiveFrom: Timestamp;
  readonly standing: RecordStanding;
}

export interface RatificationFact {
  readonly provenance: RatificationProvenance;
  readonly kind: RatificationKind;
  /** The attestation id (CANONICAL_ATTESTATION) or the fixture ratification id. */
  readonly ref: string;
  readonly polarity: 'AFFIRM' | 'DENY';
  readonly status: 'ACTIVE' | 'RETRACTED' | 'SUSPECT';
  readonly subject: {
    readonly subjectType: 'RECORD_MARK';
    readonly subjectId: string;
    readonly subjectHash: string;
  };
  readonly issuerPrincipalId: string;
  readonly issuerPrincipalType: PrincipalType;
  readonly keyId: string;
  readonly assurance: 'HOLDER_KEY' | 'DEVICE_KEY' | 'PLATFORM_WITNESSED';
  readonly issuedAt: Timestamp;
  readonly signedAt?: Timestamp;
}

/** BRT-07 snapshot authority / key vocabulary (reused verbatim). */
export interface SnapshotKeyFact {
  readonly keyId: string;
  readonly principalId: string;
  readonly keyKind: 'WALLET' | 'PASSKEY' | 'JWK' | 'DEVICE' | 'KMS';
  readonly algorithm: 'ES256' | 'ES256K' | 'EdDSA' | 'RS256';
  readonly factHash: string;
  readonly effectiveFrom: Timestamp;
  readonly effectiveTo?: Timestamp;
  readonly recordedAt: Timestamp;
  readonly statusChanges?: readonly {
    readonly statusChangeId: string;
    readonly kind: 'ROTATED' | 'REVOKED' | 'COMPROMISED';
    readonly effectiveFrom: Timestamp;
    readonly compromisedSince?: Timestamp;
    readonly recordedAt: Timestamp;
  }[];
}

export interface SnapshotAuthorityFacts {
  readonly principals?: readonly {
    readonly principalId: string;
    readonly principalType: PrincipalType;
    readonly recordedAt: Timestamp;
  }[];
  readonly anchors?: readonly {
    readonly anchorId: string;
    readonly principalId: string;
    readonly recognitionScope: RecognitionScope;
    readonly factHash: string;
    readonly effectiveFrom: Timestamp;
    readonly effectiveTo?: Timestamp;
    readonly recordedAt: Timestamp;
  }[];
  readonly anchorStatusChanges?: readonly {
    readonly statusChangeId: string;
    readonly anchorId: string;
    readonly effectiveFrom: Timestamp;
    readonly recordedAt: Timestamp;
  }[];
  readonly grants?: readonly {
    readonly grantId: string;
    readonly grantorPrincipalId: string;
    readonly granteePrincipalId: string;
    readonly parentGrantId?: string;
    readonly capabilities: readonly Capability[];
    readonly scope: AuthorityScope;
    readonly delegation: {
      readonly allowed: boolean;
      readonly maxDepth: number;
      readonly capabilitiesDelegable?: readonly Capability[];
    };
    readonly grantHash: string;
    readonly effectiveFrom: Timestamp;
    readonly effectiveTo?: Timestamp;
    readonly recordedAt: Timestamp;
  }[];
  readonly grantStatusChanges?: readonly {
    readonly statusChangeId: string;
    readonly grantId: string;
    readonly compromise: boolean;
    readonly effectiveFrom: Timestamp;
    readonly recordedAt: Timestamp;
  }[];
}

export interface RecordEvaluationSnapshot {
  readonly provenance: RecordProvenance;
  readonly assembler: string;
  readonly supportedFactKinds: readonly RecordFactKind[];
  readonly category: {
    readonly categoryId: string;
    readonly code: string;
    readonly categoryVersionId: string;
    readonly version: number;
    readonly specHash: string;
    readonly spec: RecordCategorySpec;
    readonly lifecycle: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  };
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
  readonly performance: {
    readonly resultVersionId: string;
    readonly resultId: string;
    readonly contentHash: string;
    readonly scopeType: ResultScopeType;
    readonly status: Exclude<ResultVersionStatus, 'DRAFT'>;
    /** The upstream ResultVersion this version corrects (BRT-03 fact; absent ⇒ not a correction). */
    readonly supersedesVersionId?: string;
    readonly supersededByVersionId?: string;
    readonly competitionId: string;
    readonly eventId?: string;
    readonly contestId?: string;
    readonly participantId: string;
    readonly participantKind: 'INDIVIDUAL' | 'TEAM';
    readonly athleteId?: string;
    readonly teamId?: string;
    readonly performanceAthleteId?: string;
    readonly ordinal: number;
    readonly mark: Mark;
    readonly valid: boolean;
    readonly occurredAt?: Timestamp;
  };
  readonly verification: RecordVerificationSummary;
  readonly hold?: { readonly active: boolean };
  readonly memberships?: {
    readonly venueOrganizationId?: string;
    readonly leagueOrganizationId?: string;
    readonly regionEligibility?: readonly string[];
  };
  readonly population?: readonly {
    readonly dimension: PopulationDimension;
    readonly value: string;
  }[];
  readonly conditions?: readonly {
    readonly aspect: ConditionAspect;
    readonly compliant: boolean;
    readonly value?: string;
    readonly unit?: string;
  }[];
  readonly creditedLineup?: { readonly athleteIds: readonly string[] };
  /** The record standing at the performance's sporting time (replayed; RC-1). */
  readonly currentMarks: readonly StandingMark[];
  readonly pendingMark?: {
    readonly recordMarkId: string;
    readonly markHash: string;
    readonly identityHash: string;
    readonly effectiveFrom: Timestamp;
  };
  readonly ratification?: RatificationFact;
  readonly keys?: readonly SnapshotKeyFact[];
  readonly authority?: SnapshotAuthorityFacts;
  readonly participation?: { readonly conflictedPrincipalIds: readonly string[] };
}

export interface SealedRecordSnapshot {
  readonly snapshot: RecordEvaluationSnapshot;
  readonly snapshotHash: ContentHash;
  readonly canonicalText: string;
}

export const recordIntegrity = (reason: string, message: string) =>
  new DomainError(DomainErrorCode.RECORD_INTEGRITY_FAILURE, message, { reason });

/** Normalizes (sets sorted, closed schema) and hashes a snapshot; invalid input is an integrity failure. */
export function sealRecordSnapshot(input: unknown): SealedRecordSnapshot {
  try {
    const r = platformCanonicalizer().hashCanonical(
      DomainTag.recordEvaluationSnapshot,
      SchemaRef.recordEvaluationSnapshot.id,
      SchemaRef.recordEvaluationSnapshot.version,
      input,
    );
    return {
      snapshot: r.normalized as unknown as RecordEvaluationSnapshot,
      snapshotHash: r.contentHash,
      canonicalText: r.canonicalText,
    };
  } catch (err) {
    if (err instanceof CanonicalError)
      throw new DomainError(
        DomainErrorCode.RECORD_INTEGRITY_FAILURE,
        'record evaluation snapshot is not canonical',
        { reason: 'SNAPSHOT_NOT_CANONICAL', path: err.path, code: err.code },
      );
    throw err;
  }
}

export type { GoverningRecognition };
