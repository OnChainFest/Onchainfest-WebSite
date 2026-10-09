import { CanonicalError, type ContentHash } from '@br/canonical';
import { metricOrders, thresholdFits } from '@br/achievements';
import type { DisciplineVersionSpec } from '@br/competition';
import {
  RECORD_PLATFORM_FLOOR,
  RECORD_SCOPE_LABEL,
  verificationLevelIndex,
  type RecordMarkStatus,
  type RecordScopeType,
  type TiePolicy,
  type VerificationLevel,
} from '@br/domain';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';

/**
 * Declarative RecordCategoryVersion (`br:record-category-version@1`, ADR-0043).
 *
 * A stable RecordCategory identity owns immutable, published versions. A version is DATA drawn from
 * a closed vocabulary — exact metric, exact DisciplineVersion, structural scope, bounded population
 * and conditions, tie policy — plus a recognition policy (floor, recognizing authority scope,
 * explicit canonical keeper, effectiveFrom). No JavaScript, SQL, eval, JSONPath or plugins. A version
 * may RAISE the BRT-01 §7 platform floor, never lower it; publication re-validates. Versions of one
 * category share one comparison universe (a different universe is a different category), so
 * historical marks are never reinterpreted and all marks of a category stay comparable.
 */
export const RECORD_ENGINE_ID = 'bragging-rights-record-engine';
export const RECORD_ENGINE_VERSION = 'record-engine/1';
export const SUPPORTED_RECORD_ENGINES: readonly string[] = [RECORD_ENGINE_VERSION];

export type RecognitionLevelValue =
  'PLATFORM' | 'CLUB' | 'REGIONAL' | 'NATIONAL' | 'CONTINENTAL' | 'WORLD';

export type ConditionAspect =
  | 'WIND'
  | 'TEMPERATURE'
  | 'HUMIDITY'
  | 'ALTITUDE'
  | 'SURFACE'
  | 'LIGHTING'
  | 'EQUIPMENT'
  | 'TIMING_SYSTEM'
  | 'COURSE_CONFIGURATION'
  | 'OTHER';

export interface ConditionRequirement {
  readonly aspect: ConditionAspect;
  /** COMPLIANT: an authority-evaluated compliance fact; MAXIMUM / MINIMUM: plus a bounded value. */
  readonly requirement: 'COMPLIANT' | 'MAXIMUM' | 'MINIMUM';
  readonly limit?: string;
  readonly unit?: string;
}

export interface RecordPopulation {
  readonly handicapMode?: 'SCRATCH' | 'HANDICAP';
  readonly genderCategory?: 'OPEN' | 'MEN' | 'WOMEN' | 'MIXED';
  readonly ageGroup?: string;
  readonly weightClass?: string;
  readonly equipmentClass?: string;
}

export interface RecordCategorySpec {
  readonly targetEngine: string;
  readonly displayName: string;
  readonly scope: {
    readonly scopeType: RecordScopeType;
    readonly competitionIds?: readonly string[];
    readonly venueOrganizationId?: string;
    readonly leagueOrganizationId?: string;
    readonly region?: readonly string[];
  };
  readonly universe: {
    readonly disciplineVersionId: string;
    readonly metric: { readonly key: string; readonly markMetricId: string };
    readonly resultScope: 'CONTEST';
    readonly holderType: 'ATHLETE' | 'TEAM';
  };
  readonly tiePolicy: TiePolicy;
  readonly population: RecordPopulation;
  readonly conditions: readonly ConditionRequirement[];
  readonly requirements: {
    readonly minimumVerificationLevel: VerificationLevel;
    readonly minimumResultStatus: 'OFFICIAL' | 'FINAL';
  };
  /** The structural recognition scope the ratifying authority must be anchored for. */
  readonly recognition: {
    readonly level: RecognitionLevelValue;
    readonly sport: readonly string[];
    readonly discipline?: readonly string[];
    readonly region?: readonly string[];
  };
  readonly platformReview?: boolean;
  readonly canonicalKeeper?: { readonly principalId: string; readonly registryRef: string };
  readonly effectiveFrom: string;
}

export const MAX_CATEGORY_CANONICAL_BYTES = 8 * 1024;

export interface CategoryIssue {
  readonly path: string;
  readonly code: string;
}

export type CategoryValidation =
  | {
      readonly ok: true;
      readonly spec: RecordCategorySpec;
      readonly specHash: ContentHash;
      readonly universeHash: ContentHash;
      readonly canonicalText: string;
    }
  | { readonly ok: false; readonly issues: readonly CategoryIssue[] };

/** The exact catalog facts a category is checked against (PUBLISHED DisciplineVersion + codes). */
export interface CategoryDisciplineContext {
  readonly disciplineVersionId: string;
  readonly status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  readonly sport: string;
  readonly discipline: string;
  readonly spec: Pick<DisciplineVersionSpec, 'metrics' | 'comparator' | 'participation'>;
}

/**
 * Recognition words a category name may never carry: level words come ONLY from the structural
 * scope + a ratified status (BRT-01 §9.3 "enforced by the model, not by copywriting").
 */
const RECOGNITION_WORDS =
  /\b(world|mundial|national|nacional|continental|regional|international|olympic|federation|federaci[oó]n|official|oficial|ratified|ratificad[oa]|sanctioned|verified|certified|canonical)\b/i;
const RECORD_WORD = /\b(record|r[eé]cord)s?\b/i;

/** H("record-category-universe", …): the comparison universe every version of a category shares. */
export function universeOf(spec: RecordCategorySpec) {
  return {
    scopeType: spec.scope.scopeType,
    ...(spec.scope.venueOrganizationId === undefined
      ? {}
      : { venueOrganizationId: spec.scope.venueOrganizationId }),
    ...(spec.scope.leagueOrganizationId === undefined
      ? {}
      : { leagueOrganizationId: spec.scope.leagueOrganizationId }),
    ...(spec.scope.region === undefined ? {} : { region: spec.scope.region }),
    universe: spec.universe,
    tiePolicy: spec.tiePolicy,
    population: spec.population,
    conditions: spec.conditions,
  };
}

export function universeHash(spec: RecordCategorySpec): ContentHash {
  return platformCanonicalizer().hashCanonical(
    DomainTag.recordCategoryUniverse,
    SchemaRef.recordCategoryUniverse.id,
    SchemaRef.recordCategoryUniverse.version,
    universeOf(spec),
  ).contentHash;
}

/** The effective floor of a category: max(platform floor of its scope, its own requirement). */
export function categoryFloor(spec: RecordCategorySpec): VerificationLevel {
  const floor = RECORD_PLATFORM_FLOOR[spec.scope.scopeType].minimumVerificationLevel;
  const own = spec.requirements.minimumVerificationLevel;
  return verificationLevelIndex(own) >= verificationLevelIndex(floor) ? own : floor;
}

/** Floors whose level can only exist after a human ratification (BRT-01 V4). */
export const requiresV4 = (spec: RecordCategorySpec) => categoryFloor(spec) === 'V4';

/**
 * Validates a category spec: closed BR-JSON schema (unknown members, nulls, floats, unknown enum
 * values rejected), size bound, then the semantic rules. With `discipline`, metric / sport /
 * participation references are checked against the exact PUBLISHED DisciplineVersion (required
 * before a version row can exist, and again at publication).
 */
export function validateRecordCategorySpec(
  input: unknown,
  discipline?: CategoryDisciplineContext,
): CategoryValidation {
  let spec: RecordCategorySpec;
  let specHash: ContentHash;
  let canonicalText: string;
  try {
    const r = platformCanonicalizer().hashCanonical(
      DomainTag.recordCategoryVersion,
      SchemaRef.recordCategoryVersion.id,
      SchemaRef.recordCategoryVersion.version,
      input,
    );
    spec = r.normalized as unknown as RecordCategorySpec;
    specHash = r.contentHash;
    canonicalText = r.canonicalText;
  } catch (err) {
    if (err instanceof CanonicalError)
      return { ok: false, issues: [{ path: err.path || '/', code: err.code }] };
    throw err;
  }
  if (Buffer.byteLength(canonicalText, 'utf8') > MAX_CATEGORY_CANONICAL_BYTES)
    return { ok: false, issues: [{ path: '/', code: 'CATEGORY_TOO_LARGE' }] };

  const issues: CategoryIssue[] = [];
  const issue = (path: string, code: string) => issues.push({ path, code });
  const st = spec.scope.scopeType;
  if (!SUPPORTED_RECORD_ENGINES.includes(spec.targetEngine))
    issue('/targetEngine', 'ENGINE_VERSION_UNSUPPORTED');

  // BRT-09 v1 boundary: PERSONAL records ARE the BRT-08 PERSONAL_BEST Achievement.
  if (st === 'PERSONAL') issue('/scope/scopeType', 'PERSONAL_RECORDS_ARE_PERSONAL_BEST');

  // ── name: the model computes recognition wording; a name can never widen recognition.
  const name = spec.displayName;
  if (name.trim() !== name || [...name].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20))
    issue('/displayName', 'DISPLAY_NAME_INVALID');
  if (RECOGNITION_WORDS.test(name)) issue('/displayName', 'DISPLAY_NAME_CLAIMS_RECOGNITION');
  if (st === 'PLATFORM' && RECORD_WORD.test(name))
    issue('/displayName', 'PLATFORM_NAME_CANNOT_CLAIM_RECORD');

  // ── structural scope references (exactly the ones the scope type takes).
  const sc = spec.scope;
  const allowedRefs: Readonly<Record<RecordScopeType, readonly string[]>> = {
    PERSONAL: [],
    VENUE: ['venueOrganizationId'],
    COMPETITION: ['competitionIds'],
    LEAGUE: ['leagueOrganizationId'],
    PLATFORM: [],
    NATIONAL: ['region'],
    CONTINENTAL: ['region'],
    WORLD: [],
  };
  for (const ref of ['competitionIds', 'venueOrganizationId', 'leagueOrganizationId', 'region']) {
    const present = (sc as Record<string, unknown>)[ref] !== undefined;
    const allowed = allowedRefs[st].includes(ref);
    if (present && !allowed) issue(`/scope/${ref}`, 'SCOPE_REF_NOT_ALLOWED');
    if (!present && allowed) issue(`/scope/${ref}`, 'SCOPE_REF_REQUIRED');
  }
  const alpha2 = (xs: readonly string[] | undefined) =>
    (xs ?? []).every((r) => /^[A-Z]{2}$/.test(r));
  if (st === 'NATIONAL' && ((sc.region?.length ?? 0) !== 1 || !alpha2(sc.region)))
    issue('/scope/region', 'NATIONAL_SCOPE_NEEDS_ONE_COUNTRY');
  if (st === 'CONTINENTAL' && ((sc.region?.length ?? 0) < 2 || !alpha2(sc.region)))
    issue('/scope/region', 'CONTINENTAL_SCOPE_NEEDS_COUNTRIES');

  // ── BRT-01 §7 floors: raise, never lower.
  const floor = RECORD_PLATFORM_FLOOR[st];
  if (
    verificationLevelIndex(spec.requirements.minimumVerificationLevel) <
    verificationLevelIndex(floor.minimumVerificationLevel)
  )
    issue('/requirements/minimumVerificationLevel', 'BELOW_PLATFORM_FLOOR');
  if (floor.minimumResultStatus === 'FINAL' && spec.requirements.minimumResultStatus !== 'FINAL')
    issue('/requirements/minimumResultStatus', 'BELOW_PLATFORM_FLOOR');
  // The "V2 + platform review" alternative is PLATFORM-only, and cannot undercut a raised floor.
  if (spec.platformReview !== undefined) {
    if (st !== 'PLATFORM') issue('/platformReview', 'PLATFORM_REVIEW_ONLY_FOR_PLATFORM_SCOPE');
    else if (spec.requirements.minimumVerificationLevel !== 'V3')
      issue('/platformReview', 'PLATFORM_REVIEW_CANNOT_UNDERCUT_RAISED_FLOOR');
  }

  // ── recognizing authority: structural, coherent with the scope (AC-4 / BRT-01 §9.3).
  const rec = spec.recognition;
  if (st === 'PLATFORM') {
    if (rec.level !== 'PLATFORM') issue('/recognition/level', 'PLATFORM_SCOPE_RECOGNITION_ONLY');
    if (rec.region !== undefined)
      issue('/recognition/region', 'PLATFORM_RECOGNITION_HAS_NO_REGION');
  } else if (st === 'NATIONAL' || st === 'CONTINENTAL' || st === 'WORLD') {
    if (rec.level !== st) issue('/recognition/level', 'RECOGNITION_LEVEL_MUST_MATCH_SCOPE');
    const same =
      JSON.stringify([...(rec.region ?? [])].sort()) ===
      JSON.stringify([...(sc.region ?? [])].sort());
    if (!same) issue('/recognition/region', 'RECOGNITION_REGION_MUST_MATCH_SCOPE');
  } else if (rec.level === 'PLATFORM' && rec.region !== undefined) {
    issue('/recognition/region', 'PLATFORM_RECOGNITION_HAS_NO_REGION');
  }
  // CANONICAL is a status only an explicitly designated canonical keeper can give — never PLATFORM.
  if (spec.canonicalKeeper !== undefined && (st === 'PLATFORM' || rec.level === 'PLATFORM'))
    issue('/canonicalKeeper', 'PLATFORM_CANNOT_BE_CANONICAL_KEEPER');

  // ── conditions: bounded, declarative.
  spec.conditions.forEach((c, i) => {
    const p = `/conditions/${i}`;
    if (c.requirement === 'COMPLIANT') {
      if (c.limit !== undefined || c.unit !== undefined) issue(p, 'COMPLIANT_TAKES_NO_LIMIT');
    } else {
      if (c.limit === undefined || c.unit === undefined) issue(p, 'LIMIT_AND_UNIT_REQUIRED');
      else if (!thresholdFits('DECIMAL', c.limit)) issue(`${p}/limit`, 'LIMIT_INVALID');
    }
  });

  if (discipline !== undefined) {
    if (discipline.disciplineVersionId !== spec.universe.disciplineVersionId)
      issue('/universe/disciplineVersionId', 'DISCIPLINE_VERSION_MISMATCH');
    if (discipline.status !== 'PUBLISHED')
      issue('/universe/disciplineVersionId', 'DISCIPLINE_VERSION_NOT_PUBLISHED');
    const metric = discipline.spec.metrics.find((m) => m.key === spec.universe.metric.key);
    const order = metricOrders(discipline.spec).get(spec.universe.metric.key);
    if (metric === undefined) issue('/universe/metric/key', 'METRIC_UNKNOWN');
    else if (order !== 'HIGHER_IS_BETTER' && order !== 'LOWER_IS_BETTER')
      issue('/universe/metric/key', 'METRIC_NOT_COMPARABLE');
    if (JSON.stringify(rec.sport) !== JSON.stringify([discipline.sport]))
      issue('/recognition/sport', 'RECOGNITION_SPORT_MUST_BE_DISCIPLINE_SPORT');
    if (
      rec.discipline !== undefined &&
      JSON.stringify(rec.discipline) !== JSON.stringify([discipline.discipline])
    )
      issue('/recognition/discipline', 'RECOGNITION_DISCIPLINE_MISMATCH');
    const kinds = discipline.spec.participation.participantKinds;
    if (spec.universe.holderType === 'TEAM' && !kinds.includes('TEAM'))
      issue('/universe/holderType', 'HOLDER_TYPE_NOT_IN_DISCIPLINE');
    if (spec.universe.holderType === 'ATHLETE' && !kinds.includes('INDIVIDUAL'))
      issue('/universe/holderType', 'HOLDER_TYPE_NOT_IN_DISCIPLINE');
  }
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, spec, specHash, universeHash: universeHash(spec), canonicalText };
}

/**
 * A new version of a category must keep its comparison universe (a different universe is a
 * different category, ADR-0043). A COMPETITION series may only GROW (a new edition), never drop an
 * edition whose marks already count.
 */
export function versionContinues(
  previous: RecordCategorySpec,
  next: RecordCategorySpec,
): { readonly ok: boolean; readonly code?: string } {
  if (universeHash(previous) !== universeHash(next))
    return { ok: false, code: 'UNIVERSE_CHANGE_REQUIRES_NEW_CATEGORY' };
  const before = previous.scope.competitionIds ?? [];
  const after = new Set(next.scope.competitionIds ?? []);
  if (before.some((c) => !after.has(c)))
    return { ok: false, code: 'COMPETITION_SERIES_CANNOT_SHRINK' };
  return { ok: true };
}

/**
 * BRT-01 §9.3 naming rule, enforced by the model: "National record", "World record"… are produced
 * ONLY for categories whose STRUCTURAL scope claims that level and whose mark is RATIFIED /
 * CANONICAL (the ratification having been authorized by an anchor covering the level and region).
 * Everything else is labelled by its actual universe; PLATFORM is always a Bragging Rights platform
 * best. No free-text can widen it.
 */
export function recordLabel(input: {
  readonly scopeType: RecordScopeType;
  readonly displayName: string;
  readonly region?: readonly string[];
  readonly status: RecordMarkStatus;
}): string {
  const { scopeType, displayName, status } = input;
  const region =
    input.region === undefined || input.region.length === 0
      ? ''
      : ` (${[...input.region].sort().join(', ')})`;
  const recognized = status === 'RATIFIED' || status === 'CANONICAL' || status === 'SUPERSEDED';
  let base: string;
  if (scopeType === 'PLATFORM') base = `${RECORD_SCOPE_LABEL.PLATFORM} — ${displayName}`;
  else if (scopeType === 'NATIONAL' || scopeType === 'CONTINENTAL' || scopeType === 'WORLD')
    base = recognized
      ? `${RECORD_SCOPE_LABEL[scopeType]}${region} — ${displayName}`
      : `Record claim${region} — ${displayName}`;
  else base = displayName;
  switch (status) {
    case 'PENDING_RATIFICATION':
      return `${base} (pending ratification — not a record)`;
    case 'SUPERSEDED':
      return `Former: ${base}`;
    case 'RESCINDED':
      return `${base} (rescinded — not a record)`;
    default:
      return base;
  }
}

// ───────────────────────── fictional development reference categories ─────────────────────────

/** Fictional DEVELOPMENT reference category (bowling-walkthrough shaped; not a real standard). */
export function referenceCompetitionCategory(input: {
  disciplineVersionId: string;
  competitionIds: readonly string[];
  metric: { key: string; markMetricId: string };
  sport: string;
  effectiveFrom: string;
  displayName?: string;
  handicapMode?: 'SCRATCH' | 'HANDICAP';
}): RecordCategorySpec {
  return {
    targetEngine: RECORD_ENGINE_VERSION,
    displayName: input.displayName ?? 'Fictional tournament series record',
    scope: { scopeType: 'COMPETITION', competitionIds: input.competitionIds },
    universe: {
      disciplineVersionId: input.disciplineVersionId,
      metric: input.metric,
      resultScope: 'CONTEST',
      holderType: 'ATHLETE',
    },
    tiePolicy: 'SHARED',
    population: input.handicapMode === undefined ? {} : { handicapMode: input.handicapMode },
    conditions: [],
    requirements: { minimumVerificationLevel: 'V3', minimumResultStatus: 'FINAL' },
    recognition: { level: 'PLATFORM', sport: [input.sport] },
    effectiveFrom: input.effectiveFrom,
  };
}

export type { TiePolicy };
