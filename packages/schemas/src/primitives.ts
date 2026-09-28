import type { BrArraySchema, BrObjectSchema, BrSchema, BrStringSchema } from '@br/canonical';
import { ALL_CAPABILITIES, RecognitionLevel, type SCOPE_DIMENSIONS } from '@br/domain';

export const uuid: BrStringSchema = { type: 'string', 'x-br-type': 'uuid' };
export const timestamp: BrStringSchema = { type: 'string', 'x-br-type': 'timestamp' };
export const hashRef: BrStringSchema = { type: 'string', 'x-br-type': 'hash' };
export const shortText: BrStringSchema = { type: 'string', minLength: 1, maxLength: 500 };

export function enumOf(values: readonly string[]): BrStringSchema {
  return { type: 'string', enum: values };
}

export function setOf(
  items: BrSchema,
  options: { minItems?: number; sortBy?: readonly string[]; keyUnique?: boolean } = {},
): BrArraySchema {
  const set =
    options.keyUnique === undefined
      ? { sortBy: options.sortBy ?? [] }
      : { sortBy: options.sortBy ?? [], keyUnique: options.keyUnique };
  return options.minItems === undefined
    ? { type: 'array', items, 'x-br-set': set }
    : { type: 'array', items, minItems: options.minItems, 'x-br-set': set };
}

export const capability = enumOf(ALL_CAPABILITIES);
export const recognitionLevel = enumOf(Object.values(RecognitionLevel));

const sportId: BrStringSchema = {
  type: 'string',
  pattern: '^[a-z0-9]+(?:[-_][a-z0-9]+)*$',
  maxLength: 64,
};
/** Exact discipline id or namespace ending in ".*". */
const disciplinePattern: BrStringSchema = {
  type: 'string',
  pattern: '^[a-z0-9_-]+(?:\\.[a-z0-9_-]+)*(?:\\.\\*)?$',
  maxLength: 128,
};
/** ISO 3166-1 alpha-2 or ISO 3166-2 subdivision. */
const region: BrStringSchema = { type: 'string', pattern: '^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$' };

const dimensionSchemas: Record<(typeof SCOPE_DIMENSIONS)[number], BrSchema> = {
  sport: setOf(sportId, { minItems: 1 }),
  discipline: setOf(disciplinePattern, { minItems: 1 }),
  region: setOf(region, { minItems: 1 }),
  recognitionLevel: setOf(recognitionLevel, { minItems: 1 }),
  competition: setOf(uuid, { minItems: 1 }),
  event: setOf(uuid, { minItems: 1 }),
  round: setOf(uuid, { minItems: 1 }),
  contest: setOf(uuid, { minItems: 1 }),
};

/**
 * Authority scope: every constrained dimension is a non-empty set (minItems 1 is enforced
 * before pruning, so an empty array can never silently become "unconstrained").
 */
export const authorityScope: BrObjectSchema = {
  type: 'object',
  additionalProperties: false,
  properties: dimensionSchemas,
};

export const recognitionScope: BrObjectSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['recognitionLevel'],
  properties: {
    sport: dimensionSchemas.sport,
    discipline: dimensionSchemas.discipline,
    region: dimensionSchemas.region,
    recognitionLevel: dimensionSchemas.recognitionLevel,
  },
};

export const mark: BrObjectSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['metricId', 'value', 'unit', 'precision'],
  properties: {
    metricId: { type: 'string', pattern: '^[a-z0-9_]+(?:\\.[a-z0-9_]+)*$', maxLength: 128 },
    value: { type: 'string', 'x-br-type': 'mark-value', 'x-br-precisionField': 'precision' },
    unit: { type: 'string', minLength: 1, maxLength: 32 },
    precision: { type: 'integer', minimum: 0, maximum: 9 },
  },
};
