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
