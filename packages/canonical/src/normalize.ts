import { CanonicalError, CanonicalErrorCode } from './errors';
import { escapePointer } from './json-parse';
import { canonicalBytes, type CanonicalValue } from './jcs';
import {
  normalizeDate,
  normalizeDecimal,
  normalizeHashRef,
  normalizeMarkValue,
  normalizeText,
  normalizeTimestamp,
  normalizeUuid,
} from './scalars';
import type { BrArraySchema, BrObjectSchema, BrSchema, BrStringSchema } from './schema';

/**
 * Phase 1 of normalization: enforce BR-JSON rules and rewrite every scalar into canonical form,
 * sort set arrays. Empty optional collections and default-valued members are kept here (so that
 * standard constraints such as minItems still see them) and removed by `prune`.
 */
export function walk(
  schema: BrSchema,
  value: unknown,
  path: string,
  siblings?: Readonly<Record<string, unknown>>,
): CanonicalValue {
  if (value === null)
    throw new CanonicalError(
      CanonicalErrorCode.NULL,
      path,
      'null is not allowed; omit the member instead',
    );
  switch (schema.type) {
    case 'object':
      return walkObject(schema, value, path);
    case 'array':
      return walkArray(schema, value, path);
    case 'string':
      return walkString(schema, value, path, siblings);
    case 'integer':
      return walkInteger(value, path);
    case 'boolean':
      if (typeof value !== 'boolean') throw typeErr(path, 'boolean', value);
      return value;
  }
}

function typeErr(path: string, expected: string, value: unknown): CanonicalError {
  const actual = Array.isArray(value) ? 'array' : typeof value;
  return new CanonicalError(CanonicalErrorCode.TYPE, path, `expected ${expected}, got ${actual}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function walkObject(
  schema: BrObjectSchema,
  value: unknown,
  path: string,
): { [key: string]: CanonicalValue } {
  if (!isPlainObject(value)) throw typeErr(path, 'object', value);
  const out: { [key: string]: CanonicalValue } = {};
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(schema.properties, key)) {
      throw new CanonicalError(
        CanonicalErrorCode.UNKNOWN_FIELD,
        `${path}/${escapePointer(key)}`,
        `unknown member ${JSON.stringify(key)}`,
      );
    }
  }
  for (const [key, propSchema] of Object.entries(schema.properties)) {
    const memberPath = `${path}/${escapePointer(key)}`;
    const raw = value[key];
    if (raw === undefined || !Object.hasOwn(value, key)) {
      if ((schema.required ?? []).includes(key)) {
        throw new CanonicalError(
          CanonicalErrorCode.REQUIRED_MISSING,
          memberPath,
          `required member ${JSON.stringify(key)} is absent`,
        );
      }
      continue;
    }
    out[key] = walk(propSchema, raw, memberPath, value);
  }
  return out;
}

function walkArray(schema: BrArraySchema, value: unknown, path: string): CanonicalValue[] {
  if (!Array.isArray(value)) throw typeErr(path, 'array', value);
  const items = value.map((item, i) => walk(schema.items, item, `${path}/${i}`));
  const set = schema['x-br-set'];
  if (set === undefined) return items;

  const keyed = items.map((item) => ({
    item,
    sortKey: canonicalBytes(set.sortBy.map((p) => resolvePointer(item, p))),
    full: canonicalBytes(item),
  }));
  keyed.sort((a, b) => compareBytes(a.sortKey, b.sortKey) || compareBytes(a.full, b.full));
  for (let i = 1; i < keyed.length; i++) {
    const prev = keyed[i - 1];
    const cur = keyed[i];
    if (prev === undefined || cur === undefined) continue;
    if (compareBytes(prev.full, cur.full) === 0) {
      throw new CanonicalError(
        CanonicalErrorCode.SET_DUPLICATE,
        path,
        'set array contains duplicate elements',
      );
    }
    if (
      set.keyUnique === true &&
      set.sortBy.length > 0 &&
      compareBytes(prev.sortKey, cur.sortKey) === 0
    ) {
      throw new CanonicalError(
        CanonicalErrorCode.SET_DUPLICATE_KEY,
        path,
        'set array contains two elements with the same key',
      );
    }
  }
  return keyed.map((k) => k.item);
}

function resolvePointer(value: CanonicalValue, pointer: string): CanonicalValue {
  let current: CanonicalValue = value;
  for (const token of pointer.slice(1).split('/')) {
    const next = (current as { readonly [key: string]: CanonicalValue })[
      token.replace(/~1/g, '/').replace(/~0/g, '~')
    ];
    if (next === undefined)
      throw new Error(`sort pointer ${pointer} did not resolve (schema lint should prevent this)`);
    current = next;
  }
  return current;
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

function walkString(
  schema: BrStringSchema,
  value: unknown,
  path: string,
  siblings: Readonly<Record<string, unknown>> | undefined,
): string {
  if (typeof value !== 'string') throw typeErr(path, 'string', value);
  const brType = schema['x-br-type'];
  // Every string is checked for lone surrogates / control characters and NFC-normalized first.
  const text = normalizeText(value, path, brType === 'text');
  switch (brType) {
    case 'decimal':
      return normalizeDecimal(text, path);
    case 'mark-value': {
      const field = schema['x-br-precisionField'] ?? '';
      const precision = siblings?.[field];
      if (typeof precision !== 'number' || !Number.isSafeInteger(precision) || precision < 0) {
        throw new CanonicalError(
          CanonicalErrorCode.TYPE,
          path,
          `sibling precision field ${JSON.stringify(field)} must be a non-negative integer`,
        );
      }
      return normalizeMarkValue(text, precision, path);
    }
    case 'timestamp':
      return normalizeTimestamp(text, path);
    case 'date':
      return normalizeDate(text, path);
    case 'uuid':
      return normalizeUuid(text, path);
    case 'hash':
      return normalizeHashRef(text, path);
    case 'text':
    case undefined:
      if (schema.enum !== undefined && !schema.enum.includes(text)) {
        throw new CanonicalError(
          CanonicalErrorCode.ENUM,
          path,
          `${JSON.stringify(text)} is not one of ${schema.enum.join(', ')}`,
        );
      }
      return text;
  }
  throw new CanonicalError(
    CanonicalErrorCode.SCHEMA_DEFINITION,
    path,
    `unsupported x-br-type ${String(brType)}`,
  );
}

function walkInteger(value: unknown, path: string): number {
  if (typeof value !== 'number') throw typeErr(path, 'integer', value);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new CanonicalError(
      CanonicalErrorCode.NON_INTEGER_NUMBER,
      path,
      `${String(value)} is not an integer`,
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new CanonicalError(
      CanonicalErrorCode.INTEGER_RANGE,
      path,
      `${String(value)} exceeds ±(2^53−1)`,
    );
  }
  return value === 0 ? 0 : value;
}

/**
 * Phase 2: remove optional members that are empty collections or equal to their schema default
 * (rule 2). Applied bottom-up, so an optional object emptied by pruning is itself removed.
 */
export function prune(schema: BrSchema, value: CanonicalValue): CanonicalValue {
  if (schema.type === 'array') {
    return (value as readonly CanonicalValue[]).map((v) => prune(schema.items, v));
  }
  if (schema.type !== 'object') return value;
  const obj = value as { readonly [key: string]: CanonicalValue };
  const out: { [key: string]: CanonicalValue } = {};
  const required = schema.required ?? [];
  for (const [key, member] of Object.entries(obj)) {
    const propSchema = schema.properties[key];
    if (propSchema === undefined) continue;
    const pruned = prune(propSchema, member);
    if (!required.includes(key)) {
      if (Array.isArray(pruned) && pruned.length === 0) continue;
      if (isPlainObject(pruned) && Object.keys(pruned).length === 0) continue;
      if (
        (propSchema.type === 'string' ||
          propSchema.type === 'integer' ||
          propSchema.type === 'boolean') &&
        propSchema.default !== undefined
      ) {
        const def = walk(propSchema, propSchema.default, `${key}#default`);
        if (def === pruned) continue;
      }
    }
    out[key] = pruned;
  }
  return out;
}
