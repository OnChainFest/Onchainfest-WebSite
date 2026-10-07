import {
  buildPreimage,
  createCanonicalizer,
  serializeJcs,
  sha256,
  toContentHash,
  type BrObjectSchema,
  type BrRootSchema,
  type CanonicalValue,
  type ContentHash,
} from '@br/canonical';
import {
  EntryAttributeValueType,
  PartitionKind,
  ResourceType,
  StartMethod,
  type DisciplineCapabilitiesSpec,
} from './capabilities';
import { RULESET_FAMILIES } from './ruleset';

/**
 * Sport catalog (BRT-01 result domain §4). Sports, disciplines and formats are DATA, never
 * columns. A DisciplineVersion pins the sporting semantics an Event is played under; a
 * FormatVersion pins the competition structure. Both are immutable once created, and only
 * PUBLISHED versions can be pinned by an Event.
 */

/** Sport code: same shape as the authority `sport` scope dimension (e.g. "padel"). */
export const SPORT_CODE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
/** Discipline code: sport-namespaced, dotted (e.g. "padel.doubles"), matching authority scopes. */
export const DISCIPLINE_CODE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)+$/;
/** Format template code (e.g. "single-elimination"). */
export const FORMAT_CODE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function disciplineBelongsToSport(disciplineCode: string, sportCode: string): boolean {
  return DISCIPLINE_CODE.test(disciplineCode) && disciplineCode.startsWith(`${sportCode}.`);
}

/** BRT-01 §5.4 contest types. A "match" is a Contest of type MATCH, nothing more. */
export const ContestType = {
  MATCH: 'MATCH',
  HEAT: 'HEAT',
  SERIES: 'SERIES',
  ATTEMPT_SET: 'ATTEMPT_SET',
  ROUTINE: 'ROUTINE',
  SESSION: 'SESSION',
} as const;
export type ContestType = (typeof ContestType)[keyof typeof ContestType];

/** BRT-01 §4.2 outcome models. */
export const OutcomeModel = {
  WIN_LOSS_DRAW: 'WIN_LOSS_DRAW',
  RANKED: 'RANKED',
  SCORED_RANKED: 'SCORED_RANKED',
  JUDGED_RANKED: 'JUDGED_RANKED',
} as const;
export type OutcomeModel = (typeof OutcomeModel)[keyof typeof OutcomeModel];

export const ParticipantKind = { INDIVIDUAL: 'INDIVIDUAL', TEAM: 'TEAM' } as const;
export type ParticipantKind = (typeof ParticipantKind)[keyof typeof ParticipantKind];

export const MetricValueType = {
  INTEGER: 'INTEGER',
  DECIMAL: 'DECIMAL',
  DURATION_MS: 'DURATION_MS',
} as const;
export type MetricValueType = (typeof MetricValueType)[keyof typeof MetricValueType];

/** Bounded comparator primitives (no scripting). */
export const ComparatorOrder = {
  HIGHER_IS_BETTER: 'HIGHER_IS_BETTER',
  LOWER_IS_BETTER: 'LOWER_IS_BETTER',
  /** Ordinal placement (1 is best). Integer metrics only. */
  ORDINAL: 'ORDINAL',
} as const;
export type ComparatorOrder = (typeof ComparatorOrder)[keyof typeof ComparatorOrder];

export interface MetricSpec {
  /** Property name in the result schema (e.g. "totalPins", "elapsedTimeMs"). */
  readonly key: string;
  readonly valueType: MetricValueType;
  readonly unit: string;
}

/**
 * Comparator: `HEAD_TO_HEAD_WINNER` (the contest outcome decides; keys, if any, break ties in
 * derived tables) or `METRICS` (ordered keys = LEXICOGRAPHIC_TIEBREAK: the first key decides,
 * later keys only break ties).
 */
export interface ComparatorSpec {
  readonly outcomeModel: OutcomeModel;
  readonly primary: 'HEAD_TO_HEAD_WINNER' | 'METRICS';
  readonly keys: readonly { readonly metric: string; readonly order: ComparatorOrder }[];
}

export interface ValidationSpec {
  /** Inclusive bounds as decimal strings (no floats in canonical data). */
  readonly bounds: readonly {
    readonly metric: string;
    readonly min?: string;
    readonly max?: string;
  }[];
}

export interface ParticipationSpec {
  readonly participantKinds: readonly ParticipantKind[];
  /** Athletes fielded per participant in one contest (padel doubles: 2..2). The declared lineup. */
  readonly lineupSize: { readonly min: number; readonly max: number };
  // ── v2 only (ONCF-05B, ADR-0057): roster ≠ lineup ≠ on court ──
  /** Athletes a TEAM entrant may field, frozen at field lock (relay 4..6; 3x3 4..4). */
  readonly roster?: { readonly min: number; readonly max: number };
  /** Lineup order matters (relay legs, Baker frame order). */
  readonly lineupOrdered?: boolean;
  /** Rule data only, never stored per contest (5v5: 5, minimum 2 to continue). */
  readonly onCourt?: { readonly count: number; readonly minToContinue: number };
  readonly substitution?: 'NONE' | 'ROLLING' | 'BETWEEN_GAMES' | 'BETWEEN_STAGES' | 'MEDICAL_ONLY';
  /** Declared composition pattern (mixed relays); never inferred from identity data. */
  readonly composition?: 'MIXED_ALTERNATING' | 'MIXED_EQUAL' | 'MIXED_ONE_EACH';
  /** Sum of a declared MEMBER entry attribute over the players on court (wheelchair: ≤ 14.0). Recorded, not validated in v1. */
  readonly lineupConstraint?: { readonly sumOf: string; readonly max: string };
}

/** A per-participant (or per-member) value declared at entry: seeding, handicap, start lists. */
export interface EntryAttributeSpec {
  readonly key: string;
  readonly valueType: EntryAttributeValueType;
  /** PARTICIPANT: one value per entrant; MEMBER: one value per team member. */
  readonly scope: 'PARTICIPANT' | 'MEMBER';
  readonly required: boolean;
  /** Inclusive bounds as decimal strings (INTEGER / DECIMAL / DURATION_MS). */
  readonly min?: string;
  readonly max?: string;
}

/** Everything a DisciplineVersion pins. */
export interface DisciplineVersionSpec {
  /** Absent = v1 (BRT-05 / ONCF-03A). 2 = capabilities, entry attributes and extended participation. */
  readonly specVersion?: 2;
  readonly capabilities?: DisciplineCapabilitiesSpec;
  readonly entryAttributes?: readonly EntryAttributeSpec[];
  /** BR-JSON object schema for ResultEntry components (the accepted schema mechanism). */
  readonly resultSchema: BrObjectSchema;
  readonly metrics: readonly MetricSpec[];
  readonly comparator: ComparatorSpec;
  readonly validation: ValidationSpec;
  readonly allowedContestTypes: readonly ContestType[];
  readonly participation: ParticipationSpec;
  /** Evidence type codes the verification policy may treat as primary (hints only). */
  readonly evidenceExpectations?: readonly string[];
}

export interface CatalogIssue {
  readonly path: string;
  readonly message: string;
}

const MAX_SPEC_BYTES = 64 * 1024;
const METRIC_KEY = /^[a-z][A-Za-z0-9]{0,63}$/;
const UNIT = /^[a-z0-9%/_-]{1,24}$/;
const DECIMAL = /^-?(0|[1-9][0-9]{0,17})(\.[0-9]{1,9})?$/;
const EVIDENCE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

/** Rejects anything that is not BR-JSON safe: null, floats, unsafe integers, exotic objects. */
function brJsonSafe(value: unknown, path: string, issues: CatalogIssue[], depth = 0): void {
  if (depth > 12) {
    issues.push({ path, message: 'nesting too deep' });
    return;
  }
  if (value === null || value === undefined)
    issues.push({ path, message: 'null/undefined is not allowed' });
  else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value))
      issues.push({ path, message: 'only safe integers are allowed (use decimal strings)' });
  } else if (typeof value === 'string' || typeof value === 'boolean') return;
  else if (Array.isArray(value))
    value.forEach((v, i) => brJsonSafe(v, `${path}/${i}`, issues, depth + 1));
  else if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [k, v] of Object.entries(value)) brJsonSafe(v, `${path}/${k}`, issues, depth + 1);
  } else issues.push({ path, message: 'unsupported value type' });
}

function sizeOk(value: unknown, issues: CatalogIssue[]): void {
  try {
    if (serializeJcs(value as CanonicalValue).length > MAX_SPEC_BYTES)
      issues.push({ path: '', message: 'specification too large' });
  } catch {
    issues.push({ path: '', message: 'specification is not canonical JSON' });
  }
}

/** Validates a BR-JSON object schema by registering it with a throwaway canonicalizer. */
export function validateBrObjectSchema(
  schema: unknown,
  id: string,
  path: string,
  issues: CatalogIssue[],
): void {
  if (
    typeof schema !== 'object' ||
    schema === null ||
    (schema as { type?: unknown }).type !== 'object'
  ) {
    issues.push({ path, message: 'must be a BR-JSON object schema' });
    return;
  }
  try {
    createCanonicalizer([
      { ...(schema as BrObjectSchema), $id: id, 'x-br-version': 1 } as BrRootSchema,
    ]);
  } catch (err) {
    issues.push({ path, message: `invalid BR-JSON schema: ${(err as Error).message}` });
  }
}

const exactKeys = (
  value: object,
  allowed: readonly string[],
  path: string,
  issues: CatalogIssue[],
) => {
  for (const k of Object.keys(value))
    if (!allowed.includes(k)) issues.push({ path: `${path}/${k}`, message: 'unknown field' });
};

export function validateDisciplineVersionSpec(spec: DisciplineVersionSpec): CatalogIssue[] {
  const issues: CatalogIssue[] = [];
  brJsonSafe(spec, '', issues);
  if (issues.length > 0) return issues;
  sizeOk(spec, issues);
  const v2 = spec.specVersion === 2;
  if (spec.specVersion !== undefined && !v2)
    issues.push({ path: '/specVersion', message: 'unsupported spec version' });
  exactKeys(
    spec,
    [
      'resultSchema',
      'metrics',
      'comparator',
      'validation',
      'allowedContestTypes',
      'participation',
      'evidenceExpectations',
      ...(v2 ? ['specVersion', 'capabilities', 'entryAttributes'] : []),
    ],
    '',
    issues,
  );

  validateBrObjectSchema(
    spec.resultSchema,
    'br:discipline-result-components',
    '/resultSchema',
    issues,
  );
  const props = (spec.resultSchema?.properties ?? {}) as Record<
    string,
    { type?: string; 'x-br-type'?: string }
  >;

  const metrics = new Map<string, MetricSpec>();
  if (!Array.isArray(spec.metrics) || spec.metrics.length > 32)
    issues.push({ path: '/metrics', message: 'must be an array of at most 32 metrics' });
  (spec.metrics ?? []).forEach((m, i) => {
    const p = `/metrics/${i}`;
    exactKeys(m, ['key', 'valueType', 'unit'], p, issues);
    if (!METRIC_KEY.test(m.key)) issues.push({ path: `${p}/key`, message: 'invalid metric key' });
    if (metrics.has(m.key)) issues.push({ path: `${p}/key`, message: 'duplicate metric' });
    if (!Object.values(MetricValueType).includes(m.valueType))
      issues.push({ path: `${p}/valueType`, message: 'invalid value type' });
    if (!UNIT.test(m.unit)) issues.push({ path: `${p}/unit`, message: 'invalid unit' });
    const prop = props[m.key];
    if (prop === undefined)
      issues.push({ path: `${p}/key`, message: 'metric is not a property of the result schema' });
    else if (
      m.valueType === 'DECIMAL'
        ? !(prop.type === 'string' && prop['x-br-type'] === 'decimal')
        : prop.type !== 'integer'
    )
      issues.push({
        path: `${p}/key`,
        message: `result schema property type does not match ${m.valueType}`,
      });
    metrics.set(m.key, m);
  });

  const allowedContestTypes = spec.allowedContestTypes ?? [];
  if (
    allowedContestTypes.length === 0 ||
    new Set(allowedContestTypes).size !== allowedContestTypes.length ||
    !allowedContestTypes.every((t) => Object.values(ContestType).includes(t))
  )
    issues.push({
      path: '/allowedContestTypes',
      message: 'must be a non-empty set of contest types',
    });

  const c = spec.comparator;
  if (typeof c !== 'object' || c === null)
    issues.push({ path: '/comparator', message: 'required' });
  else {
    exactKeys(c, ['outcomeModel', 'primary', 'keys'], '/comparator', issues);
    if (!Object.values(OutcomeModel).includes(c.outcomeModel))
      issues.push({ path: '/comparator/outcomeModel', message: 'invalid outcome model' });
    if (c.primary !== 'HEAD_TO_HEAD_WINNER' && c.primary !== 'METRICS')
      issues.push({ path: '/comparator/primary', message: 'invalid comparator primitive' });
    if (
      c.primary === 'HEAD_TO_HEAD_WINNER' &&
      (c.outcomeModel !== 'WIN_LOSS_DRAW' || !allowedContestTypes.includes('MATCH'))
    )
      issues.push({
        path: '/comparator/primary',
        message: 'HEAD_TO_HEAD_WINNER requires outcome model WIN_LOSS_DRAW and contest type MATCH',
      });
    if (c.primary === 'METRICS' && (c.keys ?? []).length === 0)
      issues.push({
        path: '/comparator/keys',
        message: 'METRICS comparator needs at least one key',
      });
    if (!Array.isArray(c.keys) || c.keys.length > 8)
      issues.push({ path: '/comparator/keys', message: 'at most 8 keys' });
    const seen = new Set<string>();
    (c.keys ?? []).forEach((k, i) => {
      const p = `/comparator/keys/${i}`;
      exactKeys(k, ['metric', 'order'], p, issues);
      const m = metrics.get(k.metric);
      if (m === undefined) issues.push({ path: `${p}/metric`, message: 'unknown metric' });
      if (seen.has(k.metric))
        issues.push({ path: `${p}/metric`, message: 'duplicate comparator key' });
      seen.add(k.metric);
      if (!Object.values(ComparatorOrder).includes(k.order))
        issues.push({ path: `${p}/order`, message: 'invalid order' });
      if (k.order === 'ORDINAL' && m !== undefined && m.valueType !== 'INTEGER')
        issues.push({ path: `${p}/order`, message: 'ORDINAL requires an INTEGER metric' });
    });
  }

  const v = spec.validation;
  if (typeof v !== 'object' || v === null || !Array.isArray(v.bounds) || v.bounds.length > 32)
    issues.push({ path: '/validation', message: 'must have at most 32 bounds' });
  else {
    exactKeys(v, ['bounds'], '/validation', issues);
    v.bounds.forEach((b, i) => {
      const p = `/validation/bounds/${i}`;
      exactKeys(b, ['metric', 'min', 'max'], p, issues);
      if (!metrics.has(b.metric)) issues.push({ path: `${p}/metric`, message: 'unknown metric' });
      if (b.min !== undefined && !DECIMAL.test(b.min))
        issues.push({ path: `${p}/min`, message: 'must be a decimal string' });
      if (b.max !== undefined && !DECIMAL.test(b.max))
        issues.push({ path: `${p}/max`, message: 'must be a decimal string' });
      if (
        b.min !== undefined &&
        b.max !== undefined &&
        DECIMAL.test(b.min) &&
        DECIMAL.test(b.max) &&
        Number(b.min) > Number(b.max)
      )
        issues.push({ path: p, message: 'min > max' });
    });
  }

  const pa = spec.participation;
  if (typeof pa !== 'object' || pa === null)
    issues.push({ path: '/participation', message: 'required' });
  else {
    exactKeys(
      pa,
      [
        'participantKinds',
        'lineupSize',
        ...(v2
          ? [
              'roster',
              'lineupOrdered',
              'onCourt',
              'substitution',
              'composition',
              'lineupConstraint',
            ]
          : []),
      ],
      '/participation',
      issues,
    );
    const kinds = pa.participantKinds ?? [];
    if (
      kinds.length === 0 ||
      new Set(kinds).size !== kinds.length ||
      !kinds.every((k) => k === 'INDIVIDUAL' || k === 'TEAM')
    )
      issues.push({
        path: '/participation/participantKinds',
        message: 'must be a non-empty set of INDIVIDUAL/TEAM',
      });
    const ls = pa.lineupSize;
    if (
      typeof ls !== 'object' ||
      ls === null ||
      !Number.isInteger(ls.min) ||
      !Number.isInteger(ls.max) ||
      ls.min < 1 ||
      ls.max < ls.min ||
      ls.max > 100
    )
      issues.push({
        path: '/participation/lineupSize',
        message: 'must satisfy 1 ≤ min ≤ max ≤ 100',
      });
    else if (kinds.length === 1 && kinds[0] === 'INDIVIDUAL' && ls.max !== 1)
      issues.push({
        path: '/participation/lineupSize',
        message: 'individual-only disciplines field exactly one athlete',
      });
  }

  if (v2) validateV2(spec, issues);

  if (spec.evidenceExpectations !== undefined) {
    const e = spec.evidenceExpectations;
    if (
      !Array.isArray(e) ||
      e.length > 16 ||
      new Set(e).size !== e.length ||
      !e.every((x) => EVIDENCE_CODE.test(x))
    )
      issues.push({
        path: '/evidenceExpectations',
        message: 'must be at most 16 unique evidence type codes',
      });
  }
  return issues;
}

const ATTRIBUTE_KEY = /^[a-z][A-Za-z0-9]{0,31}$/;
const COUNT = (n: unknown, max: number) =>
  Number.isInteger(n) && (n as number) >= 0 && (n as number) <= max;
const setOfKnown = (value: unknown, known: readonly string[]) =>
  Array.isArray(value) &&
  new Set(value).size === value.length &&
  value.every((v) => known.includes(v as string));

/** v2 additions (ONCF-05B): capabilities, entry attributes, extended participation. */
function validateV2(spec: DisciplineVersionSpec, issues: CatalogIssue[]): void {
  const c = spec.capabilities as DisciplineCapabilitiesSpec | undefined;
  if (typeof c !== 'object' || c === null)
    issues.push({ path: '/capabilities', message: 'required in a v2 spec' });
  else {
    exactKeys(
      c,
      ['rulesetFamilies', 'partitionKinds', 'startMethods', 'multiRound', 'resourceTypes'],
      '/capabilities',
      issues,
    );
    if (!setOfKnown(c.rulesetFamilies, RULESET_FAMILIES) || c.rulesetFamilies.length === 0)
      issues.push({
        path: '/capabilities/rulesetFamilies',
        message: 'must be a non-empty set of ruleset families',
      });
    if (!setOfKnown(c.partitionKinds, Object.values(PartitionKind)))
      issues.push({
        path: '/capabilities/partitionKinds',
        message: 'must be a set of partition kinds',
      });
    if (!setOfKnown(c.startMethods, Object.values(StartMethod)))
      issues.push({
        path: '/capabilities/startMethods',
        message: 'must be a set of start methods',
      });
    if (typeof c.multiRound !== 'boolean')
      issues.push({ path: '/capabilities/multiRound', message: 'must be a boolean' });
    if (!setOfKnown(c.resourceTypes, Object.values(ResourceType)) || c.resourceTypes.length === 0)
      issues.push({
        path: '/capabilities/resourceTypes',
        message: 'must be a non-empty set of resource types',
      });
    if (
      Array.isArray(c.startMethods) &&
      c.startMethods.length > 0 &&
      !spec.allowedContestTypes.some((t) => t !== 'MATCH')
    )
      issues.push({
        path: '/capabilities/startMethods',
        message: 'start methods need a field contest type',
      });
  }
  const attrs = spec.entryAttributes ?? [];
  if (!Array.isArray(attrs) || attrs.length > 16)
    issues.push({ path: '/entryAttributes', message: 'at most 16 entry attributes' });
  const seen = new Set<string>();
  (Array.isArray(attrs) ? attrs : []).forEach((a, i) => {
    const p = `/entryAttributes/${i}`;
    exactKeys(a, ['key', 'valueType', 'scope', 'required', 'min', 'max'], p, issues);
    if (!ATTRIBUTE_KEY.test(a.key))
      issues.push({ path: `${p}/key`, message: 'invalid attribute key' });
    if (seen.has(a.key)) issues.push({ path: `${p}/key`, message: 'duplicate attribute' });
    seen.add(a.key);
    if (!Object.values(EntryAttributeValueType).includes(a.valueType))
      issues.push({ path: `${p}/valueType`, message: 'invalid value type' });
    if (a.scope !== 'PARTICIPANT' && a.scope !== 'MEMBER')
      issues.push({ path: `${p}/scope`, message: 'must be PARTICIPANT or MEMBER' });
    if (typeof a.required !== 'boolean')
      issues.push({ path: `${p}/required`, message: 'must be a boolean' });
    for (const b of ['min', 'max'] as const) {
      const v = a[b];
      if (v !== undefined && (a.valueType === 'TEXT' || !DECIMAL.test(v)))
        issues.push({
          path: `${p}/${b}`,
          message: 'bounds are decimal strings on numeric attributes',
        });
    }
  });
  const pa = spec.participation;
  if (typeof pa !== 'object' || pa === null) return;
  const ls = pa.lineupSize;
  if (pa.roster !== undefined) {
    const r = pa.roster;
    if (!COUNT(r.min, 100) || !COUNT(r.max, 100) || r.min < 1 || r.max < r.min)
      issues.push({ path: '/participation/roster', message: 'must satisfy 1 ≤ min ≤ max ≤ 100' });
    else if (ls !== undefined && (ls.max > r.max || ls.min > r.max))
      issues.push({
        path: '/participation/roster',
        message: 'the lineup cannot exceed the roster',
      });
  }
  if (pa.lineupOrdered !== undefined && typeof pa.lineupOrdered !== 'boolean')
    issues.push({ path: '/participation/lineupOrdered', message: 'must be a boolean' });
  if (pa.onCourt !== undefined) {
    const o = pa.onCourt;
    if (
      !COUNT(o.count, 100) ||
      !COUNT(o.minToContinue, 100) ||
      o.count < 1 ||
      o.minToContinue > o.count
    )
      issues.push({
        path: '/participation/onCourt',
        message: 'must satisfy 0 ≤ minToContinue ≤ count',
      });
  }
  if (
    pa.substitution !== undefined &&
    !['NONE', 'ROLLING', 'BETWEEN_GAMES', 'BETWEEN_STAGES', 'MEDICAL_ONLY'].includes(
      pa.substitution,
    )
  )
    issues.push({ path: '/participation/substitution', message: 'invalid substitution rule' });
  if (
    pa.composition !== undefined &&
    !['MIXED_ALTERNATING', 'MIXED_EQUAL', 'MIXED_ONE_EACH'].includes(pa.composition)
  )
    issues.push({ path: '/participation/composition', message: 'invalid composition' });
  if (pa.lineupConstraint !== undefined) {
    const lc = pa.lineupConstraint;
    const attr = attrs.find((a) => a.key === lc.sumOf);
    if (attr === undefined || attr.scope !== 'MEMBER' || attr.valueType === 'TEXT')
      issues.push({
        path: '/participation/lineupConstraint/sumOf',
        message: 'must name a numeric MEMBER entry attribute',
      });
    if (!DECIMAL.test(lc.max))
      issues.push({
        path: '/participation/lineupConstraint/max',
        message: 'must be a decimal string',
      });
  }
}

/** Content hash of a catalog specification document (free-form but BR-JSON safe; JCS). */
export function catalogSpecHash(
  schemaId: 'br:discipline-version-spec' | 'br:format-version-spec',
  spec: unknown,
): ContentHash {
  return toContentHash(
    sha256(
      buildPreimage(
        'ledger-fact',
        schemaId,
        1,
        new TextEncoder().encode(serializeJcs(spec as CanonicalValue)),
      ),
    ),
  );
}
