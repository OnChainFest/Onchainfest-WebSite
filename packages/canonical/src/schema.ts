import { CanonicalError, CanonicalErrorCode } from './errors';

/**
 * BR-JSON schemas are a closed subset of JSON Schema 2020-12 plus `x-br-*` annotation keywords.
 * The subset is intentionally small: every construct must have exactly one canonical form.
 */
export type BrStringType =
  'decimal' | 'mark-value' | 'timestamp' | 'date' | 'uuid' | 'hash' | 'text';

export interface BrStringSchema {
  readonly type: 'string';
  readonly 'x-br-type'?: BrStringType;
  /** For `mark-value`: name of the sibling integer property holding the declared precision. */
  readonly 'x-br-precisionField'?: string;
  readonly enum?: readonly string[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly default?: string;
  readonly description?: string;
}

export interface BrIntegerSchema {
  readonly type: 'integer';
  readonly minimum?: number;
  readonly maximum?: number;
  readonly default?: number;
  readonly description?: string;
}

export interface BrBooleanSchema {
  readonly type: 'boolean';
  readonly default?: boolean;
  readonly description?: string;
}

export interface BrSetAnnotation {
  /** JSON Pointers (relative to the element) of the sort key; empty = sort by whole element. */
  readonly sortBy: readonly string[];
  /** When true, two elements with equal sort keys are rejected. */
  readonly keyUnique?: boolean;
}

export interface BrArraySchema {
  readonly type: 'array';
  readonly items: BrSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly 'x-br-set'?: BrSetAnnotation;
  readonly description?: string;
}

export interface BrObjectSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, BrSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
  readonly description?: string;
}

export type BrSchema =
  BrStringSchema | BrIntegerSchema | BrBooleanSchema | BrArraySchema | BrObjectSchema;

/** A root schema carries its identity; the pair (id, version) is bound into every hash preimage. */
export interface BrRootSchema extends BrObjectSchema {
  readonly $id: string;
  readonly 'x-br-version': number;
  readonly $schema?: string;
  readonly title?: string;
}

export const SCHEMA_ID_PATTERN = /^br:[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

export function schemaKey(schemaId: string, version: number): string {
  return `${schemaId}@${version}`;
}

/**
 * Lints a schema definition so that ambiguous constructs cannot enter the registry:
 * closed objects only, set sort keys must point at required scalar members, defaults
 * only on optional scalars.
 */
export function assertValidSchemaDefinition(root: BrRootSchema): void {
  if (!SCHEMA_ID_PATTERN.test(root.$id)) {
    throw defErr('', `invalid schema $id ${JSON.stringify(root.$id)}`);
  }
  if (!Number.isSafeInteger(root['x-br-version']) || root['x-br-version'] < 1) {
    throw defErr('', 'x-br-version must be a positive integer');
  }
  lint(root, '');
}

function lint(schema: BrSchema, path: string): void {
  switch (schema.type) {
    case 'object': {
      if (schema.additionalProperties !== false) {
        throw defErr(path, 'objects must declare additionalProperties: false');
      }
      for (const req of schema.required ?? []) {
        if (!(req in schema.properties))
          throw defErr(path, `required member ${req} is not declared`);
      }
      for (const [name, prop] of Object.entries(schema.properties)) {
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name))
          throw defErr(path, `member name ${name} must be an ASCII identifier`);
        if (
          'default' in prop &&
          prop.default !== undefined &&
          (schema.required ?? []).includes(name)
        ) {
          throw defErr(`${path}/${name}`, 'required members must not declare a default');
        }
        if (prop.type === 'string' && prop['x-br-type'] === 'mark-value') {
          const field = prop['x-br-precisionField'];
          const sibling = field === undefined ? undefined : schema.properties[field];
          if (
            sibling === undefined ||
            sibling.type !== 'integer' ||
            !(schema.required ?? []).includes(field ?? '')
          ) {
            throw defErr(
              `${path}/${name}`,
              'mark-value requires x-br-precisionField naming a required integer sibling',
            );
          }
        }
        if ((prop.type === 'array' || prop.type === 'object') && 'default' in prop) {
          throw defErr(`${path}/${name}`, 'defaults are only allowed on scalar members');
        }
        lint(prop, `${path}/${name}`);
      }
      return;
    }
    case 'array': {
      const set = schema['x-br-set'];
      if (set !== undefined) {
        for (const pointer of set.sortBy) {
          const target = resolvePointerSchema(schema.items, pointer);
          if (target === undefined)
            throw defErr(path, `sortBy pointer ${pointer} does not resolve to a required scalar`);
        }
        if (set.keyUnique === true && set.sortBy.length === 0) {
          throw defErr(path, 'keyUnique requires a non-empty sortBy');
        }
      }
      lint(schema.items, `${path}/items`);
      return;
    }
    case 'string':
      if (schema['x-br-precisionField'] !== undefined && schema['x-br-type'] !== 'mark-value') {
        throw defErr(path, 'x-br-precisionField is only valid on mark-value strings');
      }
      if (schema.enum !== undefined && schema['x-br-type'] !== undefined) {
        throw defErr(path, 'enum strings must not declare x-br-type');
      }
      return;
    case 'integer':
    case 'boolean':
      return;
  }
}

/** Resolves a JSON Pointer inside an item schema; only required members along the path are allowed. */
function resolvePointerSchema(schema: BrSchema, pointer: string): BrSchema | undefined {
  if (!pointer.startsWith('/')) return undefined;
  let current: BrSchema = schema;
  for (const token of pointer.slice(1).split('/')) {
    if (current.type !== 'object') return undefined;
    if (!(current.required ?? []).includes(token)) return undefined;
    const next: BrSchema | undefined = current.properties[token];
    if (next === undefined) return undefined;
    current = next;
  }
  return current.type === 'object' || current.type === 'array' ? undefined : current;
}

function defErr(path: string, message: string): CanonicalError {
  return new CanonicalError(CanonicalErrorCode.SCHEMA_DEFINITION, path, message);
}
