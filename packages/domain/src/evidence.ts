/**
 * BRT-06 Evidence & Attestation vocabulary. The terms are the ACCEPTED ones from BRT-01
 * (verification model §2–3), BRT-02 (signatures §4, ingestion §2.4) and ADR-0018; the BRT-06
 * ticket's illustrative names map onto them (see docs/implementation/BRT-06-EVIDENCE-MODEL.md §2).
 *
 *   Evidence ≠ Attestation ≠ Result ≠ Verification.
 *   None of these values means "true", "trusted" or "verified": source identity is data, and
 *   trust is decided later (BRT-07) from authority, policy and independence.
 */

/** BRT-01 §2.2 evidence types. */
export const EvidenceType = {
  SCORING_SYSTEM_EXPORT: 'SCORING_SYSTEM_EXPORT',
  TIMING_SYSTEM_EXPORT: 'TIMING_SYSTEM_EXPORT',
  SIGNED_SCORESHEET: 'SIGNED_SCORESHEET',
  OFFICIAL_REPORT: 'OFFICIAL_REPORT',
  FEDERATION_RECORD: 'FEDERATION_RECORD',
  PROVIDER_FEED: 'PROVIDER_FEED',
  SENSOR_DATA: 'SENSOR_DATA',
  VIDEO: 'VIDEO',
  IMAGE: 'IMAGE',
  AUDIO: 'AUDIO',
  DOCUMENT: 'DOCUMENT',
  HISTORICAL_ARCHIVE: 'HISTORICAL_ARCHIVE',
  OFFICIATING_SYSTEM_OUTPUT: 'OFFICIATING_SYSTEM_OUTPUT',
  AI_DERIVED: 'AI_DERIVED',
  MANUAL_ENTRY: 'MANUAL_ENTRY',
} as const;
export type EvidenceType = (typeof EvidenceType)[keyof typeof EvidenceType];

/**
 * BRT-01 §2.1 source kinds. Deliberately no TRUSTED / VERIFIED / OFFICIAL kind: the kind says
 * where bytes came from, never how much they are worth.
 */
export const EvidenceSourceKind = {
  HUMAN: 'HUMAN',
  ORGANIZATION: 'ORGANIZATION',
  DEVICE: 'DEVICE',
  SCORING_SYSTEM: 'SCORING_SYSTEM',
  TIMING_SYSTEM: 'TIMING_SYSTEM',
  EXTERNAL_API: 'EXTERNAL_API',
  HISTORICAL_ARCHIVE: 'HISTORICAL_ARCHIVE',
  AI_PIPELINE: 'AI_PIPELINE',
} as const;
export type EvidenceSourceKind = (typeof EvidenceSourceKind)[keyof typeof EvidenceSourceKind];

/**
 * BRT-01 §2.1 / BRT-02 §5.1. `capturedAt` is always a source assertion. BRT-06 accepts only
 * SOURCE_CLAIMED: DEVICE_SIGNED / TRUSTED_TIMESTAMP need device registration and timestamp-token
 * verification, which do not exist yet, so they are refused rather than recorded unproven.
 */
export const CapturedAtAssurance = {
  SOURCE_CLAIMED: 'SOURCE_CLAIMED',
  DEVICE_SIGNED: 'DEVICE_SIGNED',
  TRUSTED_TIMESTAMP: 'TRUSTED_TIMESTAMP',
} as const;
export type CapturedAtAssurance = (typeof CapturedAtAssurance)[keyof typeof CapturedAtAssurance];
export const ACCEPTED_CAPTURED_AT_ASSURANCE: readonly CapturedAtAssurance[] = ['SOURCE_CLAIMED'];

/**
 * Bounded media-type allow-list of the BRT-06 reference ingestion path. Active content
 * (text/html, image/svg+xml, scripts, executables, archives) is never accepted: there is no safe
 * rendering/scanning strategy yet. The bytes are never parsed, rendered or executed.
 */
export const EVIDENCE_MEDIA_TYPES = [
  'application/json',
  'application/pdf',
  'image/jpeg',
  'image/png',
  'text/csv',
  'text/plain',
  'video/mp4',
] as const;
export type EvidenceMediaType = (typeof EVIDENCE_MEDIA_TYPES)[number];

/** How the platform acquired the bytes (platform-observed, not a source claim). */
export const AcquisitionMethod = {
  /** Uploaded through the bounded reference API (BRT-06). */
  REFERENCE_UPLOAD: 'REFERENCE_UPLOAD',
  /** Produced inside the platform from other evidence (derivation / redaction / transform). */
  PLATFORM_DERIVATION: 'PLATFORM_DERIVATION',
} as const;
export type AcquisitionMethod = (typeof AcquisitionMethod)[keyof typeof AcquisitionMethod];

/**
 * BRT-01 privacy classes (data boundaries §2; DB-5: can only be RAISED without the rights holder).
 * BRT-06 accepts PLATFORM_PRIVATE (default) and AUTHORITY_ONLY. PUBLIC release of raw evidence is
 * deferred: there is no rights-holder release workflow yet, so it cannot be chosen.
 */
export const EvidencePrivacyClass = {
  PLATFORM_PRIVATE: 'PLATFORM_PRIVATE',
  AUTHORITY_ONLY: 'AUTHORITY_ONLY',
} as const;
export type EvidencePrivacyClass = (typeof EvidencePrivacyClass)[keyof typeof EvidencePrivacyClass];
export const PRIVACY_RANK: Readonly<Record<EvidencePrivacyClass, number>> = {
  PLATFORM_PRIVATE: 1,
  AUTHORITY_ONLY: 2,
};

/** ADR-0018 / BRT-02 ingestion §2.4 availability (append-only status). */
export const EvidenceAvailability = {
  AVAILABLE: 'AVAILABLE',
  ARCHIVED: 'ARCHIVED',
  RESTRICTED: 'RESTRICTED',
  EXPIRED: 'EXPIRED',
  DELETED_BY_RETENTION: 'DELETED_BY_RETENTION',
  DELETED_BY_ERASURE: 'DELETED_BY_ERASURE',
} as const;
export type EvidenceAvailability = (typeof EvidenceAvailability)[keyof typeof EvidenceAvailability];

/** Availability states whose bytes may be served to an authorized party. */
export const INSPECTABLE_AVAILABILITY: readonly EvidenceAvailability[] = ['AVAILABLE'];
/** Terminal: the bytes are intentionally gone; descriptor and hash remain forever. */
export const DELETED_AVAILABILITY: readonly EvidenceAvailability[] = [
  'DELETED_BY_RETENTION',
  'DELETED_BY_ERASURE',
];

/**
 * Transitions implemented in BRT-06. ARCHIVED / EXPIRED exist in the vocabulary (and the database
 * CHECK) but have no command yet (cold tiers and retention schedules are deferred).
 */
export const AVAILABILITY_TRANSITIONS: Readonly<
  Record<EvidenceAvailability, readonly EvidenceAvailability[]>
> = {
  AVAILABLE: ['RESTRICTED', 'DELETED_BY_RETENTION', 'DELETED_BY_ERASURE'],
  RESTRICTED: ['AVAILABLE', 'DELETED_BY_RETENTION', 'DELETED_BY_ERASURE'],
  ARCHIVED: [],
  EXPIRED: [],
  DELETED_BY_RETENTION: [],
  DELETED_BY_ERASURE: [],
};

export function canChangeAvailability(
  from: EvidenceAvailability,
  to: EvidenceAvailability,
): boolean {
  return AVAILABILITY_TRANSITIONS[from].includes(to);
}

/** Immutable evidence lineage edges (child → parent). Originals are never modified (E-1). */
export const EvidenceRelationKind = {
  DERIVED_FROM: 'DERIVED_FROM',
  REDACTED_FROM: 'REDACTED_FROM',
  TRANSFORMED_FROM: 'TRANSFORMED_FROM',
  SUPERSEDES: 'SUPERSEDES',
} as const;
export type EvidenceRelationKind = (typeof EvidenceRelationKind)[keyof typeof EvidenceRelationKind];

/**
 * Sporting objects evidence can be ASSOCIATED with. An attachment means "associated with", never
 * "proves". Result-related evidence should target the exact immutable RESULT_VERSION.
 */
export const EvidenceAttachmentTarget = {
  RESULT_VERSION: 'RESULT_VERSION',
  CONTEST: 'CONTEST',
  EVENT: 'EVENT',
} as const;
export type EvidenceAttachmentTarget =
  (typeof EvidenceAttachmentTarget)[keyof typeof EvidenceAttachmentTarget];

/** BRT-01 §2.1 subject link roles. */
export const EvidenceAttachmentRole = {
  PRIMARY: 'PRIMARY',
  SUPPORTING: 'SUPPORTING',
  CONTEXT: 'CONTEXT',
} as const;
export type EvidenceAttachmentRole =
  (typeof EvidenceAttachmentRole)[keyof typeof EvidenceAttachmentRole];

/** Machine generator kinds for derived evidence (BRT-01 §2.6: machine-generated ≠ true). */
export const GeneratorKind = {
  AI_PIPELINE: 'AI_PIPELINE',
  OCR: 'OCR',
  TRANSCODER: 'TRANSCODER',
  REDACTION_TOOL: 'REDACTION_TOOL',
  CERTIFIED_SYSTEM: 'CERTIFIED_SYSTEM',
  OTHER: 'OTHER',
} as const;
export type GeneratorKind = (typeof GeneratorKind)[keyof typeof GeneratorKind];

// ───────────────────────────── attestations ─────────────────────────────

/**
 * BRT-01 §3.2 claim types implemented in BRT-06 (bounded; no executable claim language):
 *   RESULT_ACCURATE + AFFIRM  "this exact ResultVersion records what I observed" (confirmation)
 *   RESULT_ACCURATE + DENY    "this exact ResultVersion is inaccurate" (dispute CLAIM — not a
 *                              Dispute entity, which remains ADR-0007's separate concept)
 *   CONDITIONS_COMPLIANT      an observation of conditions (wind, surface, equipment, timing…)
 *                              under which this exact ResultVersion was produced, AFFIRM/DENY
 * None of them means "BRT has verified this result".
 */
export const AttestationClaimType = {
  RESULT_ACCURATE: 'RESULT_ACCURATE',
  CONDITIONS_COMPLIANT: 'CONDITIONS_COMPLIANT',
} as const;
export type AttestationClaimType = (typeof AttestationClaimType)[keyof typeof AttestationClaimType];

export const ClaimPolarity = { AFFIRM: 'AFFIRM', DENY: 'DENY' } as const;
export type ClaimPolarity = (typeof ClaimPolarity)[keyof typeof ClaimPolarity];

/** Subjects an attestation can bind to in BRT-06 (always an exact content hash, A-1 / R-5). */
export const AttestationSubjectType = { RESULT_VERSION: 'RESULT_VERSION' } as const;
export type AttestationSubjectType =
  (typeof AttestationSubjectType)[keyof typeof AttestationSubjectType];

/**
 * BRT-01 §3.1 acting roles. DECLARED by the signer inside the signed statement — an input for
 * BRT-07's authority evaluation, never evaluated or trusted here.
 */
export const ActingRole = {
  PARTICIPANT: 'PARTICIPANT',
  OPPONENT: 'OPPONENT',
  OFFICIAL: 'OFFICIAL',
  ORGANIZER: 'ORGANIZER',
  SANCTIONING_BODY: 'SANCTIONING_BODY',
  ACCREDITED_PROVIDER: 'ACCREDITED_PROVIDER',
  SYSTEM: 'SYSTEM',
} as const;
export type ActingRole = (typeof ActingRole)[keyof typeof ActingRole];

/** Bounded retraction reasons (free text could carry PII). Retracted ≠ false (BRT-06 §49). */
export const RetractionReason = {
  ISSUER_ERROR: 'ISSUER_ERROR',
  SUPERSEDED_BY_CORRECTION: 'SUPERSEDED_BY_CORRECTION',
  WITHDRAWN: 'WITHDRAWN',
  OTHER: 'OTHER',
} as const;
export type RetractionReason = (typeof RetractionReason)[keyof typeof RetractionReason];

/** Signed-statement purposes (BRT-02 §4.1 `purpose`), each with its own domain tag. */
export const StatementPurpose = {
  ATTESTATION: 'attestation',
  ATTESTATION_RETRACTION: 'attestation-retraction',
  KEY_REGISTRATION: 'key-registration',
} as const;
export type StatementPurpose = (typeof StatementPurpose)[keyof typeof StatementPurpose];

/** BRT-02 §4.3 proof types; BRT-06 implements DIRECT_SIGNATURE / JWS_DETACHED only. */
export const ProofType = { DIRECT_SIGNATURE: 'DIRECT_SIGNATURE' } as const;
export type ProofType = (typeof ProofType)[keyof typeof ProofType];
export const ProofScheme = { JWS_DETACHED: 'JWS_DETACHED' } as const;
export type ProofScheme = (typeof ProofScheme)[keyof typeof ProofScheme];
/** BRT-01 §3.3 — derived by the verifier from the key kind, never trusted from input. */
export const SignatureAssurance = {
  HOLDER_KEY: 'HOLDER_KEY',
  DEVICE_KEY: 'DEVICE_KEY',
  PLATFORM_WITNESSED: 'PLATFORM_WITNESSED',
} as const;
export type SignatureAssurance = (typeof SignatureAssurance)[keyof typeof SignatureAssurance];
