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
