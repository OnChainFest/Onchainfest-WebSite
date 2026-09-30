import { CanonicalError, type ContentHash } from '@br/canonical';
import {
  DomainError,
  DomainErrorCode,
  type AuthorityScope,
  type CanonicalFactKind,
  type Capability,
  type EvidenceAttachmentRole,
  type EvidenceAvailability,
  type EvidenceSourceKind,
  type EvidenceType,
  type GeneratorKind,
  type ParticipationRelation,
  type ParticipationResolution,
  type PrincipalType,
  type RecognitionLevel,
  type RecognitionScope,
  type RelationTiming,
  type ResultScopeType,
  type ResultVersionStatus,
  type SignatureAssurance,
  type SnapshotProvenance,
} from '@br/domain';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';
import type { PolicySpec } from './policy';

/**
 * VerificationSnapshot (`br:verification-snapshot@1`) — the ONLY input of the pure engine.
 *
 * It is assembled from canonical facts BEFORE evaluation (the engine never queries anything) and
 * holds only stable ids, codes, hashes and platform/effective timestamps: no display labels, no PII,
 * no evidence bytes. Timestamps are canonical RFC 3339 strings with millisecond precision.
 *
 * The knowledge cutoff `asOf` is NOT part of the snapshot: the snapshot is the set of facts known at
 * the cutoff, so identical facts assembled at two cutoffs are the same input (same `snapshotHash`).
 * Hash-based freshness depends on exactly that. The cutoff is recorded next to the snapshot as
 * evaluation metadata (`SnapshotEnvelope.asOf`, `VerificationRun.evaluatedAsOf`).
 */
export type Timestamp = string;

export interface SnapshotPolicy {
  readonly policyId: string;
  readonly policyVersionId: string;
  readonly code: string;
  readonly version: number;
  readonly specHash: string;
  readonly spec: PolicySpec;
}

export interface SnapshotResultVersion {
  readonly resultVersionId: string;
  readonly resultId: string;
  readonly versionNumber: number;
  readonly contentHash: string;
  readonly contentSchema: string;
  readonly submittedByPrincipalId: string;
  readonly submittedAt: Timestamp;
  /** Lifecycle status as of the cutoff — read only, orthogonal to the level. */
  readonly status: Exclude<ResultVersionStatus, 'DRAFT'>;
  readonly supersededByVersionId?: string;
  readonly scopeType: ResultScopeType;
  readonly scopeTargetId: string;
  readonly entryParticipantIds?: readonly string[];
}

export interface SnapshotHierarchy {
  readonly level: 'COMPETITION' | 'EVENT' | 'ROUND' | 'CONTEST';
  readonly competitionId: string;
  readonly eventId?: string;
  readonly roundId?: string;
  readonly contestId?: string;
  readonly sport?: string;
  readonly discipline?: string;
  readonly region?: string;
}

export interface SnapshotEvidence {
  readonly evidenceId: string;
  readonly evidenceType: EvidenceType;
  readonly contentHash: string;
  readonly descriptorHash: string;
  readonly sourceKind: EvidenceSourceKind;
  readonly sourcePrincipalId?: string;
  readonly generatorKind?: GeneratorKind;
  readonly availability: EvidenceAvailability;
  readonly versionRoles?: readonly EvidenceAttachmentRole[];
  readonly provenanceRootId: string;
  readonly integrity: 'VERIFIED';
}

export type SignedFactStatus = 'ACTIVE' | 'RETRACTED' | 'SUPERSEDED';

/** Common shape of every signed claim the engine may count (proof re-verified by the assembler). */
export interface SignedFact {
  readonly attestationId: string;
  readonly statementHash: string;
  readonly issuerPrincipalId: string;
  readonly issuerPrincipalType: PrincipalType;
  readonly keyId: string;
  readonly assurance: SignatureAssurance;
  readonly issuedAt: Timestamp;
  readonly signedAt?: Timestamp;
  readonly proof: 'VERIFIED';
  readonly polarity: 'AFFIRM' | 'DENY';
  readonly status: SignedFactStatus;
}

export type ConditionAspect =
  | 'WIND'
  | 'TEMPERATURE'
  | 'HUMIDITY'
  | 'ALTITUDE'
  | 'SURFACE'
  | 'LIGHTING'
  | 'EQUIPMENT'
  | 'TIMING_SYSTEM'
  | 'COURSE_CONFIGURATION'
  | 'OTHER';

export interface SnapshotAttestation extends SignedFact {
  readonly claimType: 'RESULT_ACCURATE' | 'CONDITIONS_COMPLIANT' | 'RESULT_OFFICIAL';
  readonly actingRole?:
    | 'PARTICIPANT'
    | 'OPPONENT'
    | 'OFFICIAL'
    | 'ORGANIZER'
    | 'SANCTIONING_BODY'
    | 'ACCREDITED_PROVIDER'
    | 'SYSTEM';
  readonly evidenceIds?: readonly string[];
  readonly conditionAspects?: readonly ConditionAspect[];
}

/** COMPETITION_SANCTIONED (future producer): subject is the competition or event. */
export interface SnapshotSanction extends SignedFact {
  readonly subjectLevel: 'COMPETITION' | 'EVENT';
  readonly subjectId: string;
  readonly recognitionLevel: RecognitionLevel;
}

/** IDENTITY_CONFIRMED (future producer). */
export interface SnapshotIdentityConfirmation extends SignedFact {
  readonly athleteId: string;
}

/** RECORD_RATIFIED / REVIEW_COMPLETED (future producers; Records domain). */
export interface SnapshotRatification extends SignedFact {
  readonly kind: 'RECORD_RATIFIED' | 'REVIEW_COMPLETED';
  readonly recordCategoryId: string;
}

/**
 * A principal registered as an official of the competition / event / contest during
 * [effectiveFrom, effectiveTo). BRT-01 V1's "registered official" — a structural fact, distinct
 * from any AuthorityGrant: V1 requires no authority, and ATTEST_RESULT never implies registration.
 */
export interface SnapshotRegisteredOfficial {
  readonly registrationId: string;
  readonly principalId: string;
  readonly subjectLevel: 'COMPETITION' | 'EVENT' | 'CONTEST';
  readonly subjectId: string;
  readonly effectiveFrom: Timestamp;
  readonly effectiveTo?: Timestamp;
  readonly recordedAt: Timestamp;
}

export interface SnapshotKey {
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

export interface SnapshotAuthority {
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

export interface SnapshotRelation {
  readonly kind: ParticipationRelation;
  readonly participantId?: string;
  readonly timing: RelationTiming;
}

export interface SnapshotParticipation {
  /** False when some contestant slot is unresolved: "not on any side" cannot then be proven. */
  readonly sidesComplete: boolean;
  /** Contest occurrence window time-bounded relations were sliced at (see the assembler). */
  readonly occurrenceWindow?: { readonly from?: Timestamp; readonly to: Timestamp };
  readonly sides?: readonly {
    readonly participantId: string;
    readonly participantKind: 'INDIVIDUAL' | 'TEAM';
    readonly athleteIds?: readonly string[];
    readonly principalIds?: readonly string[];
  }[];
  readonly principals?: readonly {
    readonly principalId: string;
    readonly principalType: PrincipalType;
    readonly resolution: ParticipationResolution;
    readonly relations?: readonly SnapshotRelation[];
  }[];
}

export interface VerificationSnapshot {
  readonly provenance: SnapshotProvenance;
  readonly assembler: string;
  readonly policy: SnapshotPolicy;
  readonly resultVersion: SnapshotResultVersion;
  readonly hierarchy: SnapshotHierarchy;
  readonly discipline: {
    readonly disciplineVersionId?: string;
    readonly primaryEvidenceTypes?: readonly EvidenceType[];
  };
  readonly evidence?: readonly SnapshotEvidence[];
  readonly attestations?: readonly SnapshotAttestation[];
  readonly sanctions?: readonly SnapshotSanction[];
  readonly identityConfirmations?: readonly SnapshotIdentityConfirmation[];
  readonly ratifications?: readonly SnapshotRatification[];
  readonly t5Transitions?: readonly {
    readonly transitionId: string;
    readonly actorPrincipalId: string;
    readonly recordedAt: Timestamp;
  }[];
  /** REGISTERED_OFFICIAL facts (no production producer): structural, never sporting authority. */
  readonly registeredOfficials?: readonly SnapshotRegisteredOfficial[];
  readonly officialEvidenceSet?: { readonly evidenceTypes: readonly EvidenceType[] };
  readonly recordCategory?: {
    readonly recordCategoryId: string;
    readonly recognitionLevel: RecognitionLevel;
    readonly requiredConditionAspects?: readonly ConditionAspect[];
  };
  readonly evidenceAssessments?: readonly {
    readonly assessmentId: string;
    readonly evidenceId: string;
    readonly finding:
      | 'AUTHENTIC'
      | 'INTEGRITY_FAILED'
      | 'WRONG_SUBJECT'
      | 'MANIPULATED'
      | 'INCONCLUSIVE'
      | 'SUPERSEDED_SOURCE';
  }[];
  readonly supportedFactKinds: readonly CanonicalFactKind[];
  readonly keys?: readonly SnapshotKey[];
  readonly authority: SnapshotAuthority;
  readonly participation: SnapshotParticipation;
}

/** A snapshot with its identity and the knowledge cutoff it was assembled at. */
export interface SnapshotEnvelope {
  readonly snapshot: VerificationSnapshot;
  readonly snapshotHash: ContentHash;
  /** Knowledge cutoff (transaction-time horizon) — evaluation metadata, not hashed. */
  readonly asOf: Timestamp;
}

/**
 * Canonicalizes (BR-JSON: closed schema, sets sorted, scalars normalized, empty optionals pruned)
 * and hashes a snapshot:  snapshotHash = H("verification-snapshot", br:verification-snapshot@1, JCS).
 * Unknown members, nulls, floats or unbounded collections are rejected — as an INPUT integrity
 * failure, never a criterion failure.
 */
export function canonicalizeSnapshot(snapshot: unknown): {
  readonly snapshot: VerificationSnapshot;
  readonly snapshotHash: ContentHash;
  readonly canonicalText: string;
} {
  try {
    const r = platformCanonicalizer().hashCanonical(
      DomainTag.verificationSnapshot,
      SchemaRef.verificationSnapshot.id,
      SchemaRef.verificationSnapshot.version,
      snapshot,
    );
    return {
      snapshot: r.normalized as unknown as VerificationSnapshot,
      snapshotHash: r.contentHash,
      canonicalText: r.canonicalText,
    };
  } catch (err) {
    if (err instanceof CanonicalError)
      throw new DomainError(
        DomainErrorCode.VERIFICATION_INTEGRITY_FAILURE,
        `verification snapshot rejected: ${err.code} at ${err.path || '/'}`,
        { reason: 'SNAPSHOT_NOT_CANONICAL' },
      );
    throw err;
  }
}

/** Seals a snapshot with its hash and cutoff. */
export function sealSnapshot(snapshot: unknown, asOf: Timestamp): SnapshotEnvelope {
  const c = canonicalizeSnapshot(snapshot);
  return { snapshot: c.snapshot, snapshotHash: c.snapshotHash, asOf };
}
