import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { CanonicalError, CanonicalErrorCode } from './errors';
import { buildPreimage, sha256, toContentHash, type ContentHash } from './hash';
import { canonicalBytes, serializeJcs, type CanonicalValue } from './jcs';
import { parseStrictJson } from './json-parse';
import { prune, walk } from './normalize';
import { assertValidSchemaDefinition, schemaKey, type BrRootSchema } from './schema';

export interface CanonicalResult {
  readonly schemaId: string;
  readonly schemaVersion: number;
  readonly normalized: CanonicalValue;
  readonly canonicalText: string;
  readonly canonicalBytes: Uint8Array;
}

export interface HashResult extends CanonicalResult {
  readonly domainTag: string;
  readonly contentHash: ContentHash;
}

export interface Canonicalizer {
  /** Registered schema lookup (throws BRJ_UNKNOWN_SCHEMA). */
  schema(schemaId: string, version: number): BrRootSchema;
  /** Validate + normalize an in-memory value. Throws CanonicalError on any rule violation. */
  normalize(schemaId: string, version: number, value: unknown): CanonicalValue;
  /** Normalize and serialize with JCS. */
  canonicalize(schemaId: string, version: number, value: unknown): CanonicalResult;
  /** Normalize, serialize and hash with domain separation (ADR-0014). */
  hashCanonical(domainTag: string, schemaId: string, version: number, value: unknown): HashResult;
  /** Same as hashCanonical but from JSON text parsed strictly (duplicate keys, exact numbers). */
  hashCanonicalJson(
    domainTag: string,
    schemaId: string,
    version: number,
    jsonText: string,
  ): HashResult;
}

/**
 * Creates a canonicalizer over an immutable set of schemas. A schema version, once registered,
 * can never change: changing a schema means a new version (BRT-02 §2.2a rule 12).
 */
export function createCanonicalizer(schemas: readonly BrRootSchema[]): Canonicalizer {
  const ajv = new Ajv2020({ strict: true, allErrors: false, validateFormats: false });
  ajv.addVocabulary(['x-br-type', 'x-br-set', 'x-br-version', 'x-br-precisionField']);

  const registry = new Map<string, { schema: BrRootSchema; validate: ValidateFunction }>();
  for (const schema of schemas) {
    assertValidSchemaDefinition(schema);
    const key = schemaKey(schema.$id, schema['x-br-version']);
    if (registry.has(key)) {
      throw new CanonicalError(
        CanonicalErrorCode.SCHEMA_DEFINITION,
        '',
        `schema ${key} registered twice`,
      );
    }
    // Ajv needs a unique $id per compiled schema; the BR identity is (id, version).
    const validate = ajv.compile({ ...schema, $id: `${schema.$id}@${schema['x-br-version']}` });
    registry.set(key, { schema, validate });
  }

  const lookup = (
    schemaId: string,
    version: number,
  ): { schema: BrRootSchema; validate: ValidateFunction } => {
    const entry = registry.get(schemaKey(schemaId, version));
    if (entry === undefined) {
      throw new CanonicalError(
        CanonicalErrorCode.UNKNOWN_SCHEMA,
        '',
        `schema ${schemaKey(schemaId, version)} is not registered`,
      );
    }
    return entry;
  };

  const normalize = (schemaId: string, version: number, value: unknown): CanonicalValue => {
    const { schema, validate } = lookup(schemaId, version);
    const walked = walk(schema, value, '');
    if (!validate(walked)) {
      const err = validate.errors?.[0];
      throw new CanonicalError(
        CanonicalErrorCode.SCHEMA_CONSTRAINT,
        err?.instancePath ?? '',
        `${err?.keyword ?? 'schema'}: ${err?.message ?? 'constraint violated'}`,
      );
    }
    return prune(schema, walked);
  };

  const canonicalize = (schemaId: string, version: number, value: unknown): CanonicalResult => {
    const normalized = normalize(schemaId, version, value);
    return {
      schemaId,
      schemaVersion: version,
      normalized,
      canonicalText: serializeJcs(normalized),
      canonicalBytes: canonicalBytes(normalized),
    };
  };

  const hashCanonical = (
    domainTag: string,
    schemaId: string,
    version: number,
    value: unknown,
  ): HashResult => {
    const result = canonicalize(schemaId, version, value);
    const digest = sha256(buildPreimage(domainTag, schemaId, version, result.canonicalBytes));
    return { ...result, domainTag, contentHash: toContentHash(digest) };
  };

  return {
    schema: (id, version) => lookup(id, version).schema,
    normalize,
    canonicalize,
    hashCanonical,
    hashCanonicalJson: (domainTag, schemaId, version, jsonText) =>
      hashCanonical(domainTag, schemaId, version, parseStrictJson(jsonText)),
  };
}
