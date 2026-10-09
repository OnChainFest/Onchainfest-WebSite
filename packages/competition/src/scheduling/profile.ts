import { catalogSpecHash, ContestType } from '../catalog';
import { ResourceType } from '../capabilities';
import {
  chooseContestType,
  engineRequirements,
  RoundType,
  type AnyFormatEngine,
} from '../format/engine';
import { StagePrimitive } from '../format/plan-v2';

/**
 * SchedulingProfile spec v1 (ONCF-05E-B, ADR-0069 + ADR-0072): HOW a contest is operationally
 * scheduled — expected duration, changeover, start spacing, rest, dependency lead and the resource
 * type it needs — as closed, bounded catalog data. One generic profile type for every sport: sports
 * differ only in parameter VALUES (templates), never in code.
 *
 * It is not a scheduler: nothing here assigns a resource or an instant, detects a conflict or
 * proposes a schedule (05E-C/D/E). It never repeats what other axes own: the plan's structure and
 * grouping (format), playing time (ruleset), resource capacity and attributes (resource),
 * availability windows and zones (availability), the dependency graph and occupants (05D).
 *
 * The scheduling UNIT is a contest, or — where a stage's logistic partition method is
 * GROUPED_ENTRANTS — all contests sharing a partition key within a round (one common start). That
 * is derived from plan data by the later engines, never a profile field (ADR-0072 §5).
 *
 * All durations are integer SECONDS (05B's operational timing unit; ADR-0072 alternatives).
 */

export const SCHEDULING_PROFILE_SPEC_VERSION = 1;

/** What one scheduling unit consumes of a resource's capacity value (the value is the resource's). */
export const CapacityUnit = {
  /** 1 per scheduled contest (courts, a pool booked for heats, a track, stepladder matches). */
  CONTEST: 'CONTEST',
  /** 1 per entrant of the unit (entrants on a course, entrants per lane pair in a block). */
  ENTRANT: 'ENTRANT',
} as const;
export type CapacityUnit = (typeof CapacityUnit)[keyof typeof CapacityUnit];

/** HARD limits block publication; SOFT ones are acknowledged warnings (ADR-0071). */
export const SchedulingEnforcement = { HARD: 'HARD', SOFT: 'SOFT' } as const;
export type SchedulingEnforcement =
  (typeof SchedulingEnforcement)[keyof typeof SchedulingEnforcement];

export const RegroupingOrder = {
  FIELD_ORDINAL_ASC: 'FIELD_ORDINAL_ASC',
  FIELD_ORDINAL_DESC: 'FIELD_ORDINAL_DESC',
} as const;
export type RegroupingOrder = (typeof RegroupingOrder)[keyof typeof RegroupingOrder];

/**
 * Which contests a requirement applies to, over 05B vocabulary only. An empty selector is the
 * default requirement; each specified field makes it more specific.
 */
export interface SchedulingSelector {
  readonly contestType?: ContestType;
  readonly roundType?: RoundType;
  readonly stagePrimitive?: StagePrimitive;
}

export interface SchedulingRequirement {
  readonly selector: SchedulingSelector;
  /** Catalog ResourceType the unit needs (one resource per unit). */
  readonly resourceType: ResourceType;
  readonly capacityUnit: CapacityUnit;
  /** > 0. Time from EACH start to that start's finish. */
  readonly expectedDurationSeconds: number;
  /** ≥ 0. Time after a unit before the next unit on the same resource. */
  readonly changeoverSeconds: number;
  /** > 0. Minimum gap between consecutive unit starts on a shared-capacity resource. */
  readonly startSpacingSeconds?: number;
  /** ≥ 1 (default 1). Units allowed to start at the same instant on one resource. */
  readonly concurrentStarts?: number;
  /** Minimum gap between an entrant's consecutive units (also across dependency edges). */
  readonly rest?: { readonly minimumSeconds: number; readonly enforcement: SchedulingEnforcement };
  /** ≥ 0. Minimum time after feeder units end (result and advancement processing). */
  readonly dependencyLeadSeconds?: number;
  readonly maxUnitsPerEntrantPerDay?: {
    readonly value: number;
    readonly enforcement: SchedulingEnforcement;
  };
}

export interface SchedulingProfileSpec {
  readonly specVersion: typeof SCHEDULING_PROFILE_SPEC_VERSION;
  readonly requirements: readonly SchedulingRequirement[];
  /**
   * Result-dependent fields 05D committed without groups (e.g. a post-cut round): group size and
   * the order of 05D's field ordinals. It orders entrants; it never selects them.
   */
  readonly regrouping?: { readonly groupSize: number; readonly order: RegroupingOrder };
}

export interface SchedulingProfileIssue {
  readonly path: string;
  readonly message: string;
}

/** Bounds. Durations are seconds; a single unit never spans more than a day. */
export const SCHEDULING_BOUNDS = {
  maxRequirements: 32,
  maxDurationSeconds: 86_400,
  maxRestSeconds: 604_800,
  maxDependencyLeadSeconds: 604_800,
  maxConcurrentStarts: 64,
  maxUnitsPerDay: 100,
  maxGroupSize: 64,
} as const;

const SELECTOR_DIMENSIONS = ['contestType', 'roundType', 'stagePrimitive'] as const;
const SELECTOR_VALUES: Record<(typeof SELECTOR_DIMENSIONS)[number], readonly string[]> = {
  contestType: Object.values(ContestType),
  roundType: Object.values(RoundType),
  stagePrimitive: Object.values(StagePrimitive),
};
const REQUIREMENT_KEYS = new Set([
  'selector',
  'resourceType',
  'capacityUnit',
  'expectedDurationSeconds',
  'changeoverSeconds',
  'startSpacingSeconds',
  'concurrentStarts',
  'rest',
  'dependencyLeadSeconds',
  'maxUnitsPerEntrantPerDay',
]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;

/** Number of specified selector fields (0 = the default requirement). */
export function selectorSpecificity(selector: SchedulingSelector): number {
  return SELECTOR_DIMENSIONS.filter((d) => selector[d] !== undefined).length;
}

/**
 * True when some contest could match both selectors: no dimension is specified by both with
 * different values. Combinations are treated as possible (conservative: refusal, never guessing).
 */
export function selectorsOverlap(a: SchedulingSelector, b: SchedulingSelector): boolean {
  return SELECTOR_DIMENSIONS.every(
    (d) => a[d] === undefined || b[d] === undefined || a[d] === b[d],
  );
}

function selectorLabel(s: SchedulingSelector): string {
  const parts = SELECTOR_DIMENSIONS.flatMap((d) => (s[d] === undefined ? [] : [`${d}=${s[d]}`]));
  return parts.length === 0 ? '{default}' : `{${parts.join(', ')}}`;
}

function validateRequirement(raw: unknown, path: string, out: SchedulingProfileIssue[]): void {
  if (!isObject(raw)) return void out.push({ path, message: 'an object' });
  for (const k of Object.keys(raw))
    if (!REQUIREMENT_KEYS.has(k)) out.push({ path: `${path}/${k}`, message: 'unknown property' });
  const sel = raw['selector'];
  if (!isObject(sel)) out.push({ path: `${path}/selector`, message: 'an object' });
  else
    for (const [k, v] of Object.entries(sel)) {
      const allowed = SELECTOR_VALUES[k as (typeof SELECTOR_DIMENSIONS)[number]];
      if (allowed === undefined)
        out.push({
          path: `${path}/selector/${k}`,
          message: 'unknown dimension (contestType | roundType | stagePrimitive)',
        });
      else if (!allowed.includes(v as string))
        out.push({ path: `${path}/selector/${k}`, message: allowed.join(' | ') });
    }
  if (!(Object.values(ResourceType) as unknown[]).includes(raw['resourceType']))
    out.push({ path: `${path}/resourceType`, message: 'a catalog ResourceType' });
  if (!(Object.values(CapacityUnit) as unknown[]).includes(raw['capacityUnit']))
    out.push({ path: `${path}/capacityUnit`, message: 'CONTEST | ENTRANT' });
  const B = SCHEDULING_BOUNDS;
  if (!isInt(raw['expectedDurationSeconds'], 1, B.maxDurationSeconds))
    out.push({
      path: `${path}/expectedDurationSeconds`,
      message: `integer seconds, 1–${B.maxDurationSeconds}`,
    });
  if (!isInt(raw['changeoverSeconds'], 0, B.maxDurationSeconds))
    out.push({
      path: `${path}/changeoverSeconds`,
      message: `integer seconds, 0–${B.maxDurationSeconds}`,
    });
  if (
    raw['startSpacingSeconds'] !== undefined &&
    !isInt(raw['startSpacingSeconds'], 1, B.maxDurationSeconds)
  )
    out.push({
      path: `${path}/startSpacingSeconds`,
      message: `integer seconds, 1–${B.maxDurationSeconds}`,
    });
  if (
    raw['concurrentStarts'] !== undefined &&
    !isInt(raw['concurrentStarts'], 1, B.maxConcurrentStarts)
  )
    out.push({ path: `${path}/concurrentStarts`, message: `integer, 1–${B.maxConcurrentStarts}` });
  if (
    raw['dependencyLeadSeconds'] !== undefined &&
    !isInt(raw['dependencyLeadSeconds'], 0, B.maxDependencyLeadSeconds)
  )
    out.push({
      path: `${path}/dependencyLeadSeconds`,
      message: `integer seconds, 0–${B.maxDependencyLeadSeconds}`,
    });
  const limit = (
    key: 'rest' | 'maxUnitsPerEntrantPerDay',
    valueKey: string,
    min: number,
    max: number,
  ) => {
    const v = raw[key];
    if (v === undefined) return;
    if (
      !isObject(v) ||
      Object.keys(v).sort().join() !== [valueKey, 'enforcement'].sort().join() ||
      !isInt(v[valueKey], min, max) ||
      (v['enforcement'] !== 'HARD' && v['enforcement'] !== 'SOFT')
    )
      out.push({
        path: `${path}/${key}`,
        message: `{${valueKey}: integer ${min}–${max}, enforcement: HARD | SOFT}`,
      });
  };
  limit('rest', 'minimumSeconds', 0, B.maxRestSeconds);
  limit('maxUnitsPerEntrantPerDay', 'value', 1, B.maxUnitsPerDay);
}

/**
 * Generic validation only (ADR-0072 §7): closed keys, types, signs, bounds, `concurrentStarts ≥ 1`,
 * exactly one default requirement, and no two requirements of equal specificity that some contest
 * could match together (refused, never resolved by declaration order). Cross-entity feasibility
 * (spacing versus a concrete resource's capacity) belongs to the conflict and proposal engines.
 */
export function validateSchedulingProfileSpec(spec: unknown): SchedulingProfileIssue[] {
  const out: SchedulingProfileIssue[] = [];
  if (!isObject(spec)) return [{ path: '', message: 'an object' }];
  for (const k of Object.keys(spec))
    if (k !== 'specVersion' && k !== 'requirements' && k !== 'regrouping')
      out.push({ path: `/${k}`, message: 'unknown property' });
  if (spec['specVersion'] !== SCHEDULING_PROFILE_SPEC_VERSION)
    out.push({ path: '/specVersion', message: `${SCHEDULING_PROFILE_SPEC_VERSION}` });
  const reqs = spec['requirements'];
  if (!Array.isArray(reqs) || reqs.length < 1 || reqs.length > SCHEDULING_BOUNDS.maxRequirements) {
    out.push({
      path: '/requirements',
      message: `1–${SCHEDULING_BOUNDS.maxRequirements} requirements`,
    });
  } else {
    reqs.forEach((r, i) => validateRequirement(r, `/requirements/${i}`, out));
    // Only well-formed selectors take part in the default / overlap analysis (others are reported).
    const selectors = reqs.map((r) =>
      isObject(r) &&
      isObject(r['selector']) &&
      Object.entries(r['selector']).every(([k, v]) =>
        SELECTOR_VALUES[k as (typeof SELECTOR_DIMENSIONS)[number]]?.includes(v as string),
      )
        ? (r['selector'] as SchedulingSelector)
        : undefined,
    );
    const defaults = selectors.filter((s) => s !== undefined && selectorSpecificity(s) === 0);
    if (defaults.length !== 1)
      out.push({
        path: '/requirements',
        message: `exactly one default requirement (empty selector) is required, found ${defaults.length}`,
      });
    for (let i = 0; i < selectors.length; i++)
      for (let j = i + 1; j < selectors.length; j++) {
        const a = selectors[i];
        const b = selectors[j];
        if (a === undefined || b === undefined) continue;
        if (selectorSpecificity(a) === 0 && selectorSpecificity(b) === 0) continue; // reported above
        if (selectorSpecificity(a) === selectorSpecificity(b) && selectorsOverlap(a, b))
          out.push({
            path: `/requirements/${j}/selector`,
            message: `ambiguous: ${selectorLabel(b)} and requirement ${i} ${selectorLabel(a)} have equal specificity and can match the same contest`,
          });
      }
  }
  const rg = spec['regrouping'];
  if (
    rg !== undefined &&
    (!isObject(rg) ||
      Object.keys(rg).sort().join() !== 'groupSize,order' ||
      !isInt(rg['groupSize'], 1, SCHEDULING_BOUNDS.maxGroupSize) ||
      !(Object.values(RegroupingOrder) as unknown[]).includes(rg['order']))
  )
    out.push({
      path: '/regrouping',
      message: `{groupSize: 1–${SCHEDULING_BOUNDS.maxGroupSize}, order: FIELD_ORDINAL_ASC | FIELD_ORDINAL_DESC}`,
    });
  return out;
}

/** Total, content-only order of selectors: specificity, then each dimension's value. */
function selectorSortKey(s: SchedulingSelector): string {
  return [String(selectorSpecificity(s)), ...SELECTOR_DIMENSIONS.map((d) => s[d] ?? '')].join('|');
}

/**
 * The canonical form of a VALID spec: requirements in a content-derived order (never declaration or
 * database order), absent optional values omitted, the `concurrentStarts` default made explicit,
 * so that equivalent profiles serialize — and hash — identically. Key order is irrelevant (JCS).
 * Throws on an invalid spec: only validated profiles are canonicalized, hashed and stored.
 */
export function canonicalSchedulingProfileSpec(spec: SchedulingProfileSpec): SchedulingProfileSpec {
  const issues = validateSchedulingProfileSpec(spec);
  if (issues.length > 0)
    throw new Error(
      `invalid scheduling profile: ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`,
    );
  const requirements = spec.requirements
    .map((r): SchedulingRequirement => {
      const selector: { -readonly [K in keyof SchedulingSelector]: SchedulingSelector[K] } = {};
      for (const d of SELECTOR_DIMENSIONS)
        if (r.selector[d] !== undefined) (selector as Record<string, string>)[d] = r.selector[d];
      return {
        selector,
        resourceType: r.resourceType,
        capacityUnit: r.capacityUnit,
        expectedDurationSeconds: r.expectedDurationSeconds,
        changeoverSeconds: r.changeoverSeconds,
        ...(r.startSpacingSeconds === undefined
          ? {}
          : { startSpacingSeconds: r.startSpacingSeconds }),
        concurrentStarts: r.concurrentStarts ?? 1,
        ...(r.rest === undefined
          ? {}
          : { rest: { minimumSeconds: r.rest.minimumSeconds, enforcement: r.rest.enforcement } }),
        ...(r.dependencyLeadSeconds === undefined
          ? {}
          : { dependencyLeadSeconds: r.dependencyLeadSeconds }),
        ...(r.maxUnitsPerEntrantPerDay === undefined
          ? {}
          : {
              maxUnitsPerEntrantPerDay: {
                value: r.maxUnitsPerEntrantPerDay.value,
                enforcement: r.maxUnitsPerEntrantPerDay.enforcement,
              },
            }),
      };
    })
    .sort((a, b) => {
      const ka = selectorSortKey(a.selector);
      const kb = selectorSortKey(b.selector);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  return {
    specVersion: SCHEDULING_PROFILE_SPEC_VERSION,
    requirements,
    ...(spec.regrouping === undefined
      ? {}
      : { regrouping: { groupSize: spec.regrouping.groupSize, order: spec.regrouping.order } }),
  };
}

/** `spec_hash` of a profile version: the catalog spec hash of its canonical form (ADR-0072 §1). */
export function schedulingProfileSpecHash(spec: SchedulingProfileSpec): string {
  return catalogSpecHash('br:scheduling-profile-spec', canonicalSchedulingProfileSpec(spec));
}

/** The 05B facts of one contest that a selector can match. */
export interface SchedulingContestFacts {
  readonly contestType: ContestType;
  readonly roundType?: RoundType;
  /** Absent for v1 (single-stage) plans. */
  readonly stagePrimitive?: StagePrimitive;
}

export type RequirementResolution =
  | { readonly ok: true; readonly requirement: SchedulingRequirement; readonly index: number }
  | { readonly ok: false; readonly reason: 'NO_MATCH' | 'AMBIGUOUS'; readonly indexes: number[] };

/**
 * The requirement a contest uses: the matching requirement with the most specified selector fields.
 * Deterministic and independent of declaration order — an equal-specificity tie is reported as
 * AMBIGUOUS (validation already refuses such specs), never broken by position.
 */
export function resolveRequirement(
  spec: SchedulingProfileSpec,
  contest: SchedulingContestFacts,
): RequirementResolution {
  const matching = spec.requirements
    .map((requirement, index) => ({ requirement, index }))
    .filter(({ requirement }) =>
      SELECTOR_DIMENSIONS.every(
        (d) => requirement.selector[d] === undefined || requirement.selector[d] === contest[d],
      ),
    );
  if (matching.length === 0) return { ok: false, reason: 'NO_MATCH', indexes: [] };
  const best = Math.max(...matching.map((m) => selectorSpecificity(m.requirement.selector)));
  const top = matching.filter((m) => selectorSpecificity(m.requirement.selector) === best);
  if (top.length > 1)
    return {
      ok: false,
      reason: 'AMBIGUOUS',
      indexes: top.map((m) => m.index).sort((a, b) => a - b),
    };
  const only = top[0] as (typeof top)[number];
  return { ok: true, requirement: only.requirement, index: only.index };
}

export interface SchedulingCompatibilityIssue {
  readonly capability: 'resourceType' | 'contestTypeCoverage' | 'spec';
  readonly message: string;
}

/**
 * Pin-time compatibility (ADR-0069 §4, ADR-0072 §6), from data only:
 *  · every requirement's resource type is one the discipline declares in its capabilities (a v1
 *    discipline declares none, so it cannot pin a profile);
 *  · every contest type the format produces resolves to a requirement (the default covers it).
 * Empty result = compatible. Never consults a sport code.
 */
export function schedulingProfileCompatibility(
  spec: SchedulingProfileSpec,
  provided: { readonly resourceTypes: readonly ResourceType[] },
  producedContestTypes: readonly ContestType[],
): SchedulingCompatibilityIssue[] {
  const issues: SchedulingCompatibilityIssue[] = validateSchedulingProfileSpec(spec).map((i) => ({
    capability: 'spec' as const,
    message: `${i.path} ${i.message}`,
  }));
  if (issues.length > 0) return issues;
  for (const t of [...new Set(spec.requirements.map((r) => r.resourceType))].sort())
    if (!provided.resourceTypes.includes(t))
      issues.push({
        capability: 'resourceType',
        message: `requires resource type ${t}, which the discipline does not declare`,
      });
  for (const ct of [...new Set(producedContestTypes)].sort()) {
    const r = resolveRequirement(spec, { contestType: ct });
    if (!r.ok)
      issues.push({
        capability: 'contestTypeCoverage',
        message: `no requirement covers ${ct} contests`,
      });
  }
  return issues;
}

/**
 * The contest types an event's plan can contain, from the FormatVersion's engine and the
 * discipline's allowed types: every type the engine requires, plus the type it chooses for this
 * discipline (05B `chooseContestType`). Data only.
 */
export function producedContestTypes(
  engine: Pick<AnyFormatEngine, 'requires' | 'contestType' | 'contestTypes'>,
  allowed: readonly ContestType[],
): ContestType[] {
  const out = new Set<ContestType>(engineRequirements(engine).contestTypes?.allOf ?? []);
  const prefs = engine.contestTypes ?? [engine.contestType];
  if (prefs.some((t) => allowed.includes(t))) out.add(chooseContestType(engine, allowed));
  return [...out].sort();
}
