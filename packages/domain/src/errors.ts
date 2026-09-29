export const DomainErrorCode = {
  NOT_FOUND: 'NOT_FOUND',
  INVALID_INPUT: 'INVALID_INPUT',
  AUTHORITY_DENIED: 'AUTHORITY_DENIED',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  CONCURRENCY_CONFLICT: 'CONCURRENCY_CONFLICT',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  BACKDATING_REJECTED: 'BACKDATING_REJECTED',
  GRANT_INVALID: 'GRANT_INVALID',
  ANCHOR_INVALID: 'ANCHOR_INVALID',
  IMMUTABLE: 'IMMUTABLE',
  CURRENT_VERSION_CONFLICT: 'CURRENT_VERSION_CONFLICT',
  // BRT-04 identity / organizations
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  SLUG_INVALID: 'SLUG_INVALID',
  SLUG_TAKEN: 'SLUG_TAKEN',
  INVITATION_INVALID: 'INVITATION_INVALID',
  CHALLENGE_INVALID: 'CHALLENGE_INVALID',
  PROOF_INVALID: 'PROOF_INVALID',
  PRIVATE_DATA_UNAVAILABLE: 'PRIVATE_DATA_UNAVAILABLE',
  // BRT-05 competition operations
  CAPACITY_REACHED: 'CAPACITY_REACHED',
  /** BRT-05R: an INTERNAL capability (e.g. catalog mutation) has no configured credential. */
  INTERNAL_CAPABILITY_UNAVAILABLE: 'INTERNAL_CAPABILITY_UNAVAILABLE',
  // BRT-06 evidence & attestation (never truth, authority or verification outcomes)
  /** No evidence blob backend is configured (e.g. production without object storage + KMS). */
  EVIDENCE_STORAGE_UNAVAILABLE: 'EVIDENCE_STORAGE_UNAVAILABLE',
  /** The evidence item exists but its bytes are not inspectable (restricted, deleted, missing). */
  EVIDENCE_NOT_AVAILABLE: 'EVIDENCE_NOT_AVAILABLE',
  EVIDENCE_TOO_LARGE: 'EVIDENCE_TOO_LARGE',
  EVIDENCE_TYPE_NOT_ALLOWED: 'EVIDENCE_TYPE_NOT_ALLOWED',
  ATTESTATION_CHALLENGE_EXPIRED: 'ATTESTATION_CHALLENGE_EXPIRED',
  ATTESTATION_CHALLENGE_USED: 'ATTESTATION_CHALLENGE_USED',
  ATTESTATION_PROOF_INVALID: 'ATTESTATION_PROOF_INVALID',
  /** The authenticated account cannot represent the named issuer Principal (≠ sporting authority). */
  ISSUER_NOT_CONTROLLED: 'ISSUER_NOT_CONTROLLED',
  /** The PrincipalKey is unknown, not the issuer's, or not admissible at the platform-observed time. */
  KEY_NOT_VALID: 'KEY_NOT_VALID',
} as const;
export type DomainErrorCode = (typeof DomainErrorCode)[keyof typeof DomainErrorCode];

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: DomainErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(`${code}: ${message}`);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}
