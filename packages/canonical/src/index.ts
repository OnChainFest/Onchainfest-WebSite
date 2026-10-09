export { CanonicalError, CanonicalErrorCode } from './errors';
export {
  assertValidSchemaDefinition,
  schemaKey,
  SCHEMA_ID_PATTERN,
  type BrArraySchema,
  type BrBooleanSchema,
  type BrIntegerSchema,
  type BrObjectSchema,
  type BrRootSchema,
  type BrSchema,
  type BrStringSchema,
  type BrStringType,
} from './schema';
export { parseStrictJson, type JsonValue } from './json-parse';
export { serializeJcs, canonicalBytes, compareUtf16, type CanonicalValue } from './jcs';
export {
  normalizeDecimal,
  normalizeMarkValue,
  normalizeTimestamp,
  normalizeDate,
  normalizeUuid,
  normalizeHashRef,
  normalizeText,
  MAX_DECIMAL_DIGITS,
} from './scalars';
export {
  buildPreimage,
  hashEvidenceBytes,
  sha256,
  toContentHash,
  isContentHash,
  CONTENT_HASH_PATTERN,
  DOMAIN_TAG_PATTERN,
  PROFILE_ID,
  type ContentHash,
} from './hash';
export {
  createCanonicalizer,
  type Canonicalizer,
  type CanonicalResult,
  type HashResult,
} from './canonicalizer';
