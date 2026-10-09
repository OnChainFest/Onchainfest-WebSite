import type { ContentHash } from '@br/canonical';
import { platformCanonicalizer, SchemaRef } from '@br/schemas';
import type { EntryAttributeValueType } from './capabilities';
import { deterministicDraw, DRAW_ALGORITHM } from './draw';

/**
 * Seeding v2 — ONCF-05B (ADR-0058). Pure: (locked field, request, declared entry attributes,
 * persisted draw seed) → ordered seed list + the hashed seeding document.
 *
 * Methods:
 *  - MANUAL: an exact permutation of the field (BRT-05).
 *  - DETERMINISTIC_DRAW: a reproducible random order (`br-draw/1`, BRT-05).
 *  - RANKED_THEN_DRAWN: the organizer's seeded entrants in seed order (optionally drawn within
 *    bands 3–4, 5–8, 9–12, … as ITF and FIP draws do), then every unseeded entrant drawn.
 *  - BY_ENTRY_ATTRIBUTE: order by a declared entry attribute (swimming entry time ASC, bowling
 *    average DESC); missing values last; ties and missing values ordered by draw.
 * Overrides move one entrant to a position after the computed order; each carries a reason and is
 * part of the hashed document (audited, publicly flagged). Seed values are DECLARED, never verified.
 */

export type SeedingMethodV2 =
  'MANUAL' | 'DETERMINISTIC_DRAW' | 'RANKED_THEN_DRAWN' | 'BY_ENTRY_ATTRIBUTE';

export interface SeedSource {
  readonly kind: 'ORGANIZER' | 'DECLARED_EXTERNAL' | 'ENTRY_ATTRIBUTE';
  /** e.g. "FIP ranking", "DUPR", "club ladder". */
  readonly label?: string;
  /** ISO date (YYYY-MM-DD) the external ranking refers to. */
  readonly asOf?: string;
}

export interface SeedingOverride {
  readonly participantId: string;
  /** 1-based position in the final order. */
  readonly toPosition: number;
  readonly reason: string;
}

export interface SeedingRequestV2 {
  readonly method: SeedingMethodV2;
  readonly order?: readonly string[];
  readonly seeds?: readonly string[];
  readonly banded?: boolean;
  readonly attributeKey?: string;
  readonly direction?: 'ASC' | 'DESC';
  readonly source?: SeedSource;
  readonly overrides?: readonly SeedingOverride[];
}

export interface SeedingDocumentV2 {
  readonly eventId: string;
  readonly fieldHash: string;
  readonly method: SeedingMethodV2;
  readonly drawAlgorithm?: string;
  readonly drawSeed?: string;
  readonly seeds?: readonly string[];
  readonly banded?: boolean;
  readonly attributeKey?: string;
  readonly direction?: 'ASC' | 'DESC';
  readonly source?: SeedSource;
  readonly overrides?: readonly SeedingOverride[];
  readonly order: readonly string[];
}

export class SeedingError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'SeedingError';
    this.reason = reason;
  }
}

/** Seed bands: [1], [2], [3–4], [5–8], [9–12], [13–16], … (groups of four after eight). */
export function seedBands(count: number): number[][] {
  const bands: number[][] = [];
  let start = 1;
  while (start <= count) {
    const size = start <= 2 ? 1 : start === 3 ? 2 : 4;
    const end = Math.min(count, start + size - 1);
    bands.push(Array.from({ length: end - start + 1 }, (_, i) => start + i));
    start = end + 1;
  }
  return bands;
}

const DECIMAL = /^-?(0|[1-9][0-9]{0,17})(\.[0-9]{1,9})?$/;

/** Exact comparison of canonical decimal strings (no floats). */
export function compareDecimal(a: string, b: string): number {
  const scale = (s: string): bigint => {
    const neg = s.startsWith('-');
    const [i, f = ''] = (neg ? s.slice(1) : s).split('.');
    const v = BigInt(`${i}${f.padEnd(9, '0')}`);
    return neg ? -v : v;
  };
  const x = scale(a);
  const y = scale(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Validates a declared entry-attribute value against its type and optional bounds. */
export function validEntryAttributeValue(
  valueType: EntryAttributeValueType,
  value: string,
  bounds: { readonly min?: string; readonly max?: string } = {},
): boolean {
  if (valueType === 'TEXT')
    return value.length >= 1 && value.length <= 64 && value.trim() === value;
  const ok =
    valueType === 'DECIMAL'
      ? DECIMAL.test(value)
      : /^(0|[1-9][0-9]{0,15})$/.test(value) ||
        (valueType === 'INTEGER' && /^-[1-9][0-9]{0,15}$/.test(value));
  if (!ok) return false;
  if (bounds.min !== undefined && compareDecimal(value, bounds.min) < 0) return false;
  if (bounds.max !== undefined && compareDecimal(value, bounds.max) > 0) return false;
  return true;
}

function applyOverrides(order: string[], overrides: readonly SeedingOverride[]): string[] {
  const out = [...order];
  for (const o of overrides) {
    const from = out.indexOf(o.participantId);
    if (from < 0)
      throw new SeedingError('OVERRIDE', 'an override names a participant outside the field');
    if (!Number.isInteger(o.toPosition) || o.toPosition < 1 || o.toPosition > out.length)
      throw new SeedingError('OVERRIDE', 'override position is outside the field');
    if (o.reason.trim().length === 0 || o.reason.length > 300)
      throw new SeedingError('OVERRIDE', 'every override needs a reason (≤ 300 characters)');
    out.splice(from, 1);
    out.splice(o.toPosition - 1, 0, o.participantId);
  }
  return out;
}

/**
 * Computes the seed order. `drawSeed` is required whenever the method draws (everything except
 * MANUAL); the caller generates it with a CSPRNG and persists it (reproducible, not provably fair).
 */
export function computeSeeding(input: {
  readonly eventId: string;
  readonly fieldHash: string;
  readonly participantIds: readonly string[];
  readonly request: SeedingRequestV2;
  readonly drawSeed?: string;
  /** participantId → declared value (BY_ENTRY_ATTRIBUTE). */
  readonly attributeValues?: ReadonlyMap<string, string>;
  readonly attributeType?: EntryAttributeValueType;
}): SeedingDocumentV2 {
  const ids = [...input.participantIds];
  const idSet = new Set(ids);
  const r = input.request;
  const needDraw = r.method !== 'MANUAL';
  if (needDraw && input.drawSeed === undefined)
    throw new SeedingError('DRAW_SEED', 'this method needs a draw seed');
  const draw = (subset: readonly string[]) =>
    subset.length <= 1 ? [...subset] : deterministicDraw(subset, input.drawSeed as string);
  let order: string[];
  const extra: { -readonly [K in keyof SeedingDocumentV2]?: SeedingDocumentV2[K] } = {};
  switch (r.method) {
    case 'MANUAL': {
      const o = (r.order ?? []).map((x) => x.toLowerCase());
      if (o.length !== ids.length || new Set(o).size !== o.length || !o.every((x) => idSet.has(x)))
        throw new SeedingError(
          'ORDER',
          'manual order must list every participant of the locked field exactly once',
        );
      order = o;
      break;
    }
    case 'DETERMINISTIC_DRAW':
      order = draw(ids);
      break;
    case 'RANKED_THEN_DRAWN': {
      const seeds = (r.seeds ?? []).map((x) => x.toLowerCase());
      if (seeds.length === 0 || seeds.length > 64 || seeds.length > ids.length)
        throw new SeedingError('SEEDS', 'list between 1 and 64 seeded participants');
      if (new Set(seeds).size !== seeds.length || !seeds.every((x) => idSet.has(x)))
        throw new SeedingError('SEEDS', 'seeds must be distinct participants of the locked field');
      const banded = r.banded ?? true;
      const seeded = banded
        ? seedBands(seeds.length).flatMap((band) => {
            const members = band.map((n) => seeds[n - 1] as string);
            // Each band is shuffled by `br-draw/1` over its own (sorted) member set.
            return members.length <= 1
              ? members
              : deterministicDraw(members, input.drawSeed as string);
          })
        : seeds;
      order = [...seeded, ...draw(ids.filter((x) => !seeds.includes(x)))];
      extra.seeds = seeds;
      extra.banded = banded;
      break;
    }
    case 'BY_ENTRY_ATTRIBUTE': {
      const key = r.attributeKey;
      const values = input.attributeValues;
      const type = input.attributeType;
      if (key === undefined || values === undefined || type === undefined || type === 'TEXT')
        throw new SeedingError('ATTRIBUTE', 'a numeric entry attribute is required');
      const dir = r.direction ?? 'ASC';
      const drawn = draw(ids); // tie-break and missing-value order
      const rank = new Map(drawn.map((id, i) => [id, i]));
      const withValue = drawn.filter((id) => values.has(id));
      const missing = drawn.filter((id) => !values.has(id));
      withValue.sort((a, b) => {
        const c = compareDecimal(values.get(a) as string, values.get(b) as string);
        return (dir === 'ASC' ? c : -c) || (rank.get(a) as number) - (rank.get(b) as number);
      });
      order = [...withValue, ...missing];
      extra.attributeKey = key;
      extra.direction = dir;
      break;
    }
    default:
      throw new SeedingError('METHOD', 'invalid seeding method');
  }
  const overrides = r.overrides ?? [];
  if (overrides.length > 256) throw new SeedingError('OVERRIDE', 'at most 256 overrides');
  order = applyOverrides(order, overrides);
  return {
    eventId: input.eventId,
    fieldHash: input.fieldHash,
    method: r.method,
    ...(needDraw ? { drawAlgorithm: DRAW_ALGORITHM, drawSeed: input.drawSeed as string } : {}),
    ...extra,
    ...(r.source === undefined ? {} : { source: r.source }),
    ...(overrides.length === 0 ? {} : { overrides }),
    order,
  };
}

export function seedingHashV2(doc: SeedingDocumentV2): ContentHash {
  return platformCanonicalizer().hashCanonical(
    'ledger-fact',
    SchemaRef.competitionSeedingV2.id,
    2,
    doc,
  ).contentHash;
}
