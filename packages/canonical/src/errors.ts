/**
 * Rule identifiers are part of the protocol surface: golden test vectors reference them.
 * See docs/architecture/BRT-02-SIGNATURES-AND-HASHING.md §2.2a.
 */
export const CanonicalErrorCode = {
  /** Rule 1: duplicate member names in JSON text. */
  DUPLICATE_KEY: 'BRJ_DUPLICATE_KEY',
  /** Rule 2: null is forbidden. */
  NULL: 'BRJ_NULL',
  /** Rule 11: unknown member in a closed schema. */
  UNKNOWN_FIELD: 'BRJ_UNKNOWN_FIELD',
  REQUIRED_MISSING: 'BRJ_REQUIRED_MISSING',
  TYPE: 'BRJ_TYPE',
  /** Rule 4. */
  SET_DUPLICATE: 'BRJ_SET_DUPLICATE',
  SET_DUPLICATE_KEY: 'BRJ_SET_DUPLICATE_KEY',
  /** Rule 5. */
  INTEGER_RANGE: 'BRJ_INTEGER_RANGE',
  NON_INTEGER_NUMBER: 'BRJ_NON_INTEGER_NUMBER',
  /** Rule 6. */
  DECIMAL_SYNTAX: 'BRJ_DECIMAL_SYNTAX',
  DECIMAL_EXPONENT: 'BRJ_DECIMAL_EXPONENT',
  DECIMAL_TOO_LONG: 'BRJ_DECIMAL_TOO_LONG',
  /** Rule 7. */
  MARK_PRECISION: 'BRJ_MARK_PRECISION',
  /** Rule 8. */
  TIMESTAMP_SYNTAX: 'BRJ_TIMESTAMP_SYNTAX',
  TIMESTAMP_PRECISION: 'BRJ_TIMESTAMP_PRECISION',
  TIMESTAMP_LEAP_SECOND: 'BRJ_TIMESTAMP_LEAP_SECOND',
  TIMESTAMP_RANGE: 'BRJ_TIMESTAMP_RANGE',
  DATE_SYNTAX: 'BRJ_DATE_SYNTAX',
  /** Rule 9. */
  UUID_SYNTAX: 'BRJ_UUID_SYNTAX',
  HASH_SYNTAX: 'BRJ_HASH_SYNTAX',
  /** Rule 10. */
  LONE_SURROGATE: 'BRJ_LONE_SURROGATE',
  CONTROL_CHARACTER: 'BRJ_CONTROL_CHARACTER',
  ENUM: 'BRJ_ENUM',
  /** Standard JSON Schema constraint (minItems, maximum, pattern…) reported by Ajv. */
  SCHEMA_CONSTRAINT: 'BRJ_SCHEMA_CONSTRAINT',
  JSON_SYNTAX: 'BRJ_JSON_SYNTAX',
  SCHEMA_DEFINITION: 'BRJ_SCHEMA_DEFINITION',
  UNKNOWN_SCHEMA: 'BRJ_UNKNOWN_SCHEMA',
  DOMAIN_TAG: 'BRJ_DOMAIN_TAG',
} as const;

export type CanonicalErrorCode = (typeof CanonicalErrorCode)[keyof typeof CanonicalErrorCode];

export class CanonicalError extends Error {
  readonly code: CanonicalErrorCode;
  readonly path: string;

  constructor(code: CanonicalErrorCode, path: string, message: string) {
    super(`${code} at ${path === '' ? '/' : path}: ${message}`);
    this.name = 'CanonicalError';
    this.code = code;
    this.path = path;
  }
}
