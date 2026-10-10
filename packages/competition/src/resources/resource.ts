import { ResourceType } from '../capabilities';
import { ianaZoneIssue } from './zoned';

/**
 * Generic, competition-scoped resources (ONCF-05E-A, ADR-0067). One model for every sport: the
 * type is the catalog `ResourceType` vocabulary (data), attributes are validated against a closed
 * per-type schema (data), and occupancy semantics are generic:
 *
 *   · capacity     → an amount; what one unit consumes comes from the SchedulingProfile (05E-B)
 *   · occupancyMode → declared simultaneous occupancy, EXCLUSIVE or SHARED (05E-C, ADR-0073 B2);
 *                    capacity never decides it
 *   · exclusivity keys → physical overlap: two resources share space iff their key sets intersect.
 *     A full court {c1-a, c1-b} overlaps each half court {c1-a} / {c1-b}; the halves don't overlap
 *     each other. (ADR-0067's "exclusivity group" represented as a key set: a single key cannot
 *     express overlapping siblings that are not mutually exclusive.)
 * Occupancy itself is derived from schedules (05E-C) — never stored on a resource. Lanes inside a
 * heat are slots (05B), not resources. No code here knows a sport.
 */

export type AttributeSpec =
  | { readonly kind: 'INT'; readonly min: number; readonly max: number }
  | { readonly kind: 'BOOL' }
  | { readonly kind: 'ENUM'; readonly values: readonly string[] }
  | {
      readonly kind: 'INT_LIST';
      readonly min: number;
      readonly max: number;
      readonly maxItems: number;
    }
  | { readonly kind: 'TEXT'; readonly maxLength: number };

/** Per-type attribute schema (closed: unknown attributes are refused). Data, keyed by type code. */
export const RESOURCE_TYPE_ATTRIBUTES: Readonly<
  Record<ResourceType, Readonly<Record<string, AttributeSpec>>>
> = {
  TENNIS_COURT: {
    surface: { kind: 'ENUM', values: ['HARD', 'CLAY', 'GRASS', 'CARPET', 'OTHER'] },
    indoor: { kind: 'BOOL' },
    lights: { kind: 'BOOL' },
  },
  PADEL_COURT: { indoor: { kind: 'BOOL' }, lights: { kind: 'BOOL' } },
  BASKETBALL_COURT: { indoor: { kind: 'BOOL' } },
  BASKETBALL_HALF_COURT: { indoor: { kind: 'BOOL' } },
  BOWLING_LANE_PAIR: {
    firstLane: { kind: 'INT', min: 1, max: 199 },
    centerLabel: { kind: 'TEXT', maxLength: 60 },
  },
  POOL: {
    lanes: { kind: 'INT', min: 1, max: 12 },
    lengthMeters: { kind: 'ENUM', values: ['25', '50'] },
    indoor: { kind: 'BOOL' },
  },
  TRACK: {
    lanes: { kind: 'INT', min: 4, max: 10 },
    lengthMeters: { kind: 'ENUM', values: ['200', '400'] },
  },
  ROAD_COURSE: {
    distanceMeters: { kind: 'INT', min: 100, max: 500_000 },
    certified: { kind: 'BOOL' },
  },
  OPEN_WATER_COURSE: { distanceMeters: { kind: 'INT', min: 100, max: 100_000 } },
  CYCLING_COURSE: {
    distanceMeters: { kind: 'INT', min: 100, max: 500_000 },
    lapLengthMeters: { kind: 'INT', min: 100, max: 100_000 },
  },
  GOLF_COURSE: {
    holes: { kind: 'ENUM', values: ['9', '18'] },
    startingTees: { kind: 'INT_LIST', min: 1, max: 18, maxItems: 2 },
  },
};

export const RESOURCE_TYPES: readonly ResourceType[] = Object.values(ResourceType);
export const RESOURCE_STATUSES = ['ACTIVE', 'RETIRED'] as const;
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const MAX_CAPACITY = 100_000;

export interface ResourceSpec {
  readonly typeCode: string;
  readonly label: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly capacity: number;
  readonly exclusivityKeys: readonly string[];
  /** IANA zone; absent = the competition's zone. */
  readonly timezone?: string;
}

export interface ResourceIssue {
  readonly path: string;
  readonly message: string;
}

export function validateResource(spec: ResourceSpec): ResourceIssue[] {
  const out: ResourceIssue[] = [];
  const schema = (
    RESOURCE_TYPE_ATTRIBUTES as Record<string, Record<string, AttributeSpec> | undefined>
  )[spec.typeCode];
  if (schema === undefined)
    out.push({ path: '/typeCode', message: `one of ${RESOURCE_TYPES.join(', ')}` });
  const label = spec.label.trim();
  if (label.length === 0 || label.length > 80 || label !== spec.label)
    out.push({ path: '/label', message: '1–80 characters without surrounding spaces' });
  if (!Number.isInteger(spec.capacity) || spec.capacity < 1 || spec.capacity > MAX_CAPACITY)
    out.push({ path: '/capacity', message: `an integer 1–${MAX_CAPACITY}` });
  if (
    spec.exclusivityKeys.length > 8 ||
    new Set(spec.exclusivityKeys).size !== spec.exclusivityKeys.length
  )
    out.push({ path: '/exclusivityKeys', message: 'at most 8 distinct keys' });
  spec.exclusivityKeys.forEach((k, i) => {
    if (!KEY_RE.test(k))
      out.push({
        path: `/exclusivityKeys/${i}`,
        message: 'lowercase letters, digits and hyphens (≤ 40)',
      });
  });
  if (spec.timezone !== undefined) {
    const z = ianaZoneIssue(spec.timezone);
    if (z !== undefined) out.push({ path: '/timezone', message: z });
  }
  if (
    typeof spec.attributes !== 'object' ||
    spec.attributes === null ||
    Array.isArray(spec.attributes)
  ) {
    out.push({ path: '/attributes', message: 'an object' });
    return out;
  }
  for (const [key, value] of Object.entries(spec.attributes)) {
    const a = schema?.[key];
    const path = `/attributes/${key}`;
    if (a === undefined) {
      if (schema !== undefined)
        out.push({ path, message: 'not an attribute of this resource type' });
      continue;
    }
    if (!attributeOk(a, value)) out.push({ path, message: describe(a) });
  }
  return out;
}

function attributeOk(a: AttributeSpec, v: unknown): boolean {
  switch (a.kind) {
    case 'INT':
      return Number.isInteger(v) && (v as number) >= a.min && (v as number) <= a.max;
    case 'BOOL':
      return typeof v === 'boolean';
    case 'ENUM':
      return typeof v === 'string' && a.values.includes(v);
    case 'TEXT':
      return typeof v === 'string' && v.trim().length > 0 && v.length <= a.maxLength;
    case 'INT_LIST':
      return (
        Array.isArray(v) &&
        v.length >= 1 &&
        v.length <= a.maxItems &&
        new Set(v).size === v.length &&
        v.every((x) => Number.isInteger(x) && x >= a.min && x <= a.max)
      );
  }
}

function describe(a: AttributeSpec): string {
  switch (a.kind) {
    case 'INT':
      return `an integer ${a.min}–${a.max}`;
    case 'BOOL':
      return 'true or false';
    case 'ENUM':
      return `one of ${a.values.join(', ')}`;
    case 'TEXT':
      return `text up to ${a.maxLength}`;
    case 'INT_LIST':
      return `1–${a.maxItems} distinct integers ${a.min}–${a.max}`;
  }
}

/**
 * Simultaneous occupancy, a declared physical fact of a resource revision (ONCF-05E-C, ADR-0073 B2):
 * EXCLUSIVE = one scheduling unit at a time (plus changeover); SHARED = concurrent units while the
 * summed consumption fits the capacity. Capacity is only an amount and never decides this.
 */
export const OccupancyMode = { EXCLUSIVE: 'EXCLUSIVE', SHARED: 'SHARED' } as const;
export type OccupancyMode = (typeof OccupancyMode)[keyof typeof OccupancyMode];
export const OCCUPANCY_MODES: readonly OccupancyMode[] = Object.values(OccupancyMode);

/**
 * Write-time default when a caller omits `occupancyMode` (catalog vocabulary data, like the attribute
 * schemas; also the deterministic backfill of migration 0037). Engines never read this table: they
 * read the mode stored on the resource revision.
 */
export const RESOURCE_TYPE_DEFAULT_OCCUPANCY_MODE: Readonly<Record<ResourceType, OccupancyMode>> = {
  TENNIS_COURT: 'EXCLUSIVE',
  PADEL_COURT: 'EXCLUSIVE',
  BASKETBALL_COURT: 'EXCLUSIVE',
  BASKETBALL_HALF_COURT: 'EXCLUSIVE',
  BOWLING_LANE_PAIR: 'EXCLUSIVE',
  POOL: 'EXCLUSIVE',
  TRACK: 'EXCLUSIVE',
  ROAD_COURSE: 'SHARED',
  OPEN_WATER_COURSE: 'SHARED',
  CYCLING_COURSE: 'SHARED',
  GOLF_COURSE: 'SHARED',
};

/**
 * Legacy, descriptive label (05E-A read API compatibility): EXCLUSIVE (capacity 1) or
 * SHARED_CAPACITY (capacity > 1). NOT a scheduling semantic — conflict and proposal engines use the
 * stored `occupancyMode` only (ADR-0073 I-B2.1).
 */
export function occupancyOf(r: { readonly capacity: number }): 'EXCLUSIVE' | 'SHARED_CAPACITY' {
  return r.capacity === 1 ? 'EXCLUSIVE' : 'SHARED_CAPACITY';
}

/** Two resources share physical space (later: cannot be occupied at once) — same id or a common key. */
export function sharesSpace(
  a: { readonly id: string; readonly exclusivityKeys: readonly string[] },
  b: { readonly id: string; readonly exclusivityKeys: readonly string[] },
): boolean {
  return a.id === b.id || a.exclusivityKeys.some((k) => b.exclusivityKeys.includes(k));
}
