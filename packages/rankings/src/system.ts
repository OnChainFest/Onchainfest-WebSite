import { CanonicalError, type ContentHash } from '@br/canonical';
import { metricOrders } from '@br/achievements';
import { coversValue } from '@br/authority';
import type { ComparatorOrder, DisciplineVersionSpec } from '@br/competition';
import {
  DEFERRED_AGGREGATIONS,
  DEFERRED_RANKING_METHODS,
  POLICY_UNSUPPORTED,
  PRODUCTION_SUPPORTED_RANKING_FACT_KINDS,
  RANKING_PLATFORM_FLOOR,
  verificationLevelIndex,
  type HolderType,
  type RankingFactKind,
  type RankingMethod,
  type RankingSystemKind,
  type RecognitionScope,
  type VerificationLevel,
} from '@br/domain';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';

/**
 * Declarative RankingSystemVersion (`br:ranking-system-version@1`, ADR-0048).
 *
 * A stable RankingSystem identity owns immutable versions. A version is DATA from a closed vocabulary:
 * kind (PLATFORM | OFFICIAL), method (BEST_MARK only in v1), universe (exact DisciplineVersion and
 * metric, CONTEST scope, holder type, optional competition set, sporting window, declared population),
 * the pinned DisciplineVersion comparator key(s), a raise-only floor, the structural recognition scope
 * and — OFFICIAL only — the anchored owner. Every version of one system shares one universe hash; a
 * different universe is a different system, so no version can reinterpret a historical snapshot.
 */
export const RANKING_ENGINE_ID = 'bragging-rights-ranking-engine';
export const RANKING_ENGINE_VERSION = 'ranking-engine/1';
export const SUPPORTED_RANKING_ENGINES: readonly string[] = [RANKING_ENGINE_VERSION];

export type RecognitionLevelValue =
  'PLATFORM' | 'CLUB' | 'REGIONAL' | 'NATIONAL' | 'CONTINENTAL' | 'WORLD';

/** One DisciplineVersion comparator key, reused verbatim from BRT-05 (`ComparatorSpec.keys[n]`). */
export type ComparatorKey = DisciplineVersionSpec['comparator']['keys'][number];

export interface RankingPopulation {
  readonly handicapMode?: 'SCRATCH' | 'HANDICAP';
  readonly genderCategory?: 'OPEN' | 'MEN' | 'WOMEN' | 'MIXED';
  readonly ageGroup?: string;
  readonly weightClass?: string;
  readonly equipmentClass?: string;
}

/** The explicit ranking universe (never implicit in a SQL WHERE clause). */
export interface RankingUniverse {
  readonly disciplineVersionId: string;
  readonly metric: { readonly key: string; readonly markMetricId: string };
  readonly resultScope: 'CONTEST';
  readonly holderType: HolderType;
  readonly competitionIds?: readonly string[];
  /** Sporting-time window [from, to); there is no season entity. */
  readonly window?: { readonly from: string; readonly to?: string };
  readonly population: RankingPopulation;
}

export interface RankingSystemSpec {
  readonly targetEngine: string;
  readonly displayName: string;
  readonly kind: RankingSystemKind;
  readonly method: RankingMethod;
  readonly universe: RankingUniverse;
  /** The DisciplineVersion comparator keys this ranking applies, in order (validated equal to the DV). */
  readonly comparator: { readonly keys: readonly ComparatorKey[] };
  readonly requirements: {
    readonly minimumVerificationLevel: VerificationLevel;
    readonly minimumResultStatus: 'FINAL';
  };
  readonly recognition: {
    readonly level: RecognitionLevelValue;
    readonly sport: readonly string[];
    readonly discipline?: readonly string[];
    readonly region?: readonly string[];
  };
  /** OFFICIAL only: the anchored owner authority. */
  readonly owner?: { readonly principalId: string; readonly anchorId: string };
  readonly effectiveFrom: string;
}

export const MAX_SYSTEM_CANONICAL_BYTES = 8 * 1024;

export interface SpecIssue {
  readonly path: string;
  readonly code: string;
}

export type RankingSystemValidation =
  | {
      readonly ok: true;
      readonly spec: RankingSystemSpec;
      readonly specHash: ContentHash;
      readonly universeHash: ContentHash;
      readonly canonicalText: string;
    }
  | { readonly ok: false; readonly issues: readonly SpecIssue[] };

/** The exact catalog facts a ranking system is checked against (PUBLISHED DisciplineVersion). */
export interface RankingDisciplineContext {
  readonly disciplineVersionId: string;
  readonly status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  readonly sport: string;
  readonly discipline: string;
  readonly spec: Pick<DisciplineVersionSpec, 'metrics' | 'comparator' | 'participation'>;
}

/** The owner's immutable trust-anchor fact (OFFICIAL systems; loaded canonically, never asserted). */
export interface RankingOwnerContext {
  readonly anchorId: string;
  readonly principalId: string;
  readonly recognitionScope: RecognitionScope;
}

/** Recognition words a free-text name may never carry (labels come from the model, ADR-0048 §7). */
export const RECOGNITION_WORDS =
  /\b(world|mundial|national|nacional|continental|regional|international|olympic|federation|federaci[oó]n|official|oficial|ratified|ratificad[oa]|sanctioned|verified|certified|canonical)\b/i;

const COMPARABLE: readonly ComparatorOrder[] = ['HIGHER_IS_BETTER', 'LOWER_IS_BETTER'];

/** H("ranking-universe", …): the universe every version of a ranking system shares. */
export function rankingUniverseOf(spec: RankingSystemSpec) {
  return { method: spec.method, universe: spec.universe, comparator: spec.comparator };
}

export function rankingUniverseHash(spec: RankingSystemSpec): ContentHash {
  return platformCanonicalizer().hashCanonical(
    DomainTag.rankingUniverse,
    SchemaRef.rankingUniverse.id,
    SchemaRef.rankingUniverse.version,
    rankingUniverseOf(spec),
  ).contentHash;
}

/** The effective floor of a system: max(platform floor of its kind, its own requirement). */
export function rankingSystemFloor(spec: RankingSystemSpec): VerificationLevel {
  const floor = RANKING_PLATFORM_FLOOR[spec.kind].minimumVerificationLevel;
  const own = spec.requirements.minimumVerificationLevel;
  return verificationLevelIndex(own) >= verificationLevelIndex(floor) ? own : floor;
}

/**
 * Canonical fact kinds a version REQUIRES: status, verification, occurrence and membership always;
 * HOLD_STATE always (every floor holds-blocks); POPULATION when a population is declared;
 * RANKING_PUBLICATION for OFFICIAL systems.
 */
export function requiredRankingFactKinds(spec: RankingSystemSpec): readonly RankingFactKind[] {
  const kinds: RankingFactKind[] = [
    'RESULT_STATUS',
    'VERIFICATION',
    'CONTEST_OCCURRENCE',
    'COMPETITION_MEMBERSHIP',
    'HOLD_STATE',
  ];
  if (Object.keys(spec.universe.population).length > 0) kinds.push('POPULATION');
  if (spec.kind === 'OFFICIAL') kinds.push('RANKING_PUBLICATION');
  return kinds;
}

/** Required kinds with NO producer in `supported` (production default) — they fail closed. */
export function unsupportedRequiredFactKinds(
  spec: RankingSystemSpec,
  supported: readonly RankingFactKind[] = PRODUCTION_SUPPORTED_RANKING_FACT_KINDS,
): readonly RankingFactKind[] {
  return requiredRankingFactKinds(spec).filter((k) => !supported.includes(k));
}

/** Members naming a deferred method / aggregation are refused as POLICY_UNSUPPORTED (not as a typo). */
export function deferredVocabularyIssues(input: unknown, paths: readonly string[][]): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const deferred: readonly string[] = [...DEFERRED_RANKING_METHODS, ...DEFERRED_AGGREGATIONS];
  const visit = (value: unknown, path: readonly string[], at: string) => {
    if (path.length === 0) {
      if (typeof value === 'string' && deferred.includes(value))
        issues.push({ path: at, code: POLICY_UNSUPPORTED });
      return;
    }
    const [head, ...rest] = path;
    if (head === '*') {
      if (Array.isArray(value)) value.forEach((v, i) => visit(v, rest, `${at}/${i}`));
      return;
    }
    if (typeof value === 'object' && value !== null && head !== undefined)
      visit((value as Record<string, unknown>)[head], rest, `${at}/${head}`);
  };
  for (const p of paths) visit(input, p, '');
  return issues;
}

function nameIssues(name: string, issue: (path: string, code: string) => void) {
  if (name.trim() !== name || [...name].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20))
    issue('/displayName', 'DISPLAY_NAME_INVALID');
  if (RECOGNITION_WORDS.test(name)) issue('/displayName', 'DISPLAY_NAME_CLAIMS_RECOGNITION');
}

/**
 * Validates a ranking system spec: deferred vocabulary (POLICY_UNSUPPORTED), the closed BR-JSON schema
 * (unknown members / enum values, nulls, floats rejected), size bound, then the semantic rules. With
 * `discipline`, the pinned comparator is checked against the exact PUBLISHED DisciplineVersion; with
 * `owner`, an OFFICIAL owner's anchor must recognize the declared scope.
 */
export function validateRankingSystemSpec(
  input: unknown,
  context: {
    readonly discipline?: RankingDisciplineContext;
    readonly owner?: RankingOwnerContext;
  } = {},
): RankingSystemValidation {
  const deferred = deferredVocabularyIssues(input, [['method']]);
  if (deferred.length > 0) return { ok: false, issues: deferred };
  let spec: RankingSystemSpec;
  let specHash: ContentHash;
  let canonicalText: string;
  try {
    const r = platformCanonicalizer().hashCanonical(
      DomainTag.rankingSystemVersion,
      SchemaRef.rankingSystemVersion.id,
      SchemaRef.rankingSystemVersion.version,
      input,
    );
    spec = r.normalized as unknown as RankingSystemSpec;
    specHash = r.contentHash;
    canonicalText = r.canonicalText;
  } catch (err) {
    if (err instanceof CanonicalError)
      return { ok: false, issues: [{ path: err.path || '/', code: err.code }] };
    throw err;
  }
  if (Buffer.byteLength(canonicalText, 'utf8') > MAX_SYSTEM_CANONICAL_BYTES)
    return { ok: false, issues: [{ path: '/', code: 'SYSTEM_TOO_LARGE' }] };

  const issues: SpecIssue[] = [];
  const issue = (path: string, code: string) => issues.push({ path, code });

  if (!SUPPORTED_RANKING_ENGINES.includes(spec.targetEngine))
    issue('/targetEngine', 'ENGINE_VERSION_UNSUPPORTED');
  nameIssues(spec.displayName, issue);

  // ── BRT-01 §7 floors: raise, never lower (status is FINAL by schema).
  if (
    verificationLevelIndex(spec.requirements.minimumVerificationLevel) <
    verificationLevelIndex(RANKING_PLATFORM_FLOOR[spec.kind].minimumVerificationLevel)
  )
    issue('/requirements/minimumVerificationLevel', 'BELOW_PLATFORM_FLOOR');

  // ── kind ↔ recognition ↔ owner (the platform never masquerades as a federation, ADR-0048 §3, §6).
  const rec = spec.recognition;
  if (spec.kind === 'PLATFORM') {
    if (rec.level !== 'PLATFORM') issue('/recognition/level', 'PLATFORM_KIND_RECOGNITION_ONLY');
    if (rec.region !== undefined)
      issue('/recognition/region', 'PLATFORM_RECOGNITION_HAS_NO_REGION');
    if (spec.owner !== undefined) issue('/owner', 'OWNER_NOT_ALLOWED_FOR_PLATFORM');
  } else {
    if (spec.owner === undefined) issue('/owner', 'OFFICIAL_OWNER_REQUIRED');
    if (rec.level === 'PLATFORM')
      issue('/recognition/level', 'OFFICIAL_RECOGNITION_CANNOT_BE_PLATFORM');
    else if (rec.level === 'WORLD') {
      if (rec.region !== undefined) issue('/recognition/region', 'WORLD_RECOGNITION_HAS_NO_REGION');
    } else if (rec.region === undefined)
      issue('/recognition/region', 'RECOGNITION_REGION_REQUIRED');
  }

  // ── BEST_MARK: exactly the universe metric, comparable order (ADR-0049 §6).
  const keys = spec.comparator.keys;
  const seen = new Set<string>();
  keys.forEach((k, i) => {
    if (seen.has(k.metric)) issue(`/comparator/keys/${i}/metric`, 'DUPLICATE_COMPARATOR_KEY');
    seen.add(k.metric);
  });
  if (spec.method === 'BEST_MARK') {
    if (keys.length !== 1) issue('/comparator/keys', 'BEST_MARK_SINGLE_KEY');
    const k = keys[0];
    if (k !== undefined) {
      if (k.metric !== spec.universe.metric.key)
        issue('/comparator/keys/0/metric', 'COMPARATOR_METRIC_MISMATCH');
      if (!COMPARABLE.includes(k.order)) issue('/comparator/keys/0/order', 'COMPARATOR_UNDEFINED');
    }
  }

  // ── sporting window [from, to).
  const w = spec.universe.window;
  if (w?.to !== undefined && !(Date.parse(w.to) > Date.parse(w.from)))
    issue('/universe/window', 'WINDOW_INVALID');

  const dv = context.discipline;
  if (dv !== undefined) {
    if (dv.disciplineVersionId !== spec.universe.disciplineVersionId)
      issue('/universe/disciplineVersionId', 'DISCIPLINE_VERSION_MISMATCH');
    if (dv.status !== 'PUBLISHED')
      issue('/universe/disciplineVersionId', 'DISCIPLINE_VERSION_NOT_PUBLISHED');
    if (!dv.spec.metrics.some((m) => m.key === spec.universe.metric.key))
      issue('/universe/metric/key', 'METRIC_UNKNOWN');
    const dvOrder = metricOrders(dv.spec).get(spec.universe.metric.key);
    if (dvOrder === undefined || !COMPARABLE.includes(dvOrder))
      issue('/universe/metric/key', 'METRIC_NOT_COMPARABLE');
    else if (keys[0] !== undefined && keys[0].order !== dvOrder)
      issue('/comparator/keys/0/order', 'COMPARATOR_MISMATCH');
    if (JSON.stringify(rec.sport) !== JSON.stringify([dv.sport]))
      issue('/recognition/sport', 'RECOGNITION_SPORT_MUST_BE_DISCIPLINE_SPORT');
    if (
      rec.discipline !== undefined &&
      JSON.stringify(rec.discipline) !== JSON.stringify([dv.discipline])
    )
      issue('/recognition/discipline', 'RECOGNITION_DISCIPLINE_MISMATCH');
    const kinds = dv.spec.participation.participantKinds;
    if (spec.universe.holderType === 'TEAM' && !kinds.includes('TEAM'))
      issue('/universe/holderType', 'HOLDER_TYPE_NOT_IN_DISCIPLINE');
    if (spec.universe.holderType === 'ATHLETE' && !kinds.includes('INDIVIDUAL'))
      issue('/universe/holderType', 'HOLDER_TYPE_NOT_IN_DISCIPLINE');
  }

  const owner = context.owner;
  if (owner !== undefined && spec.owner !== undefined) {
    if (owner.anchorId !== spec.owner.anchorId || owner.principalId !== spec.owner.principalId)
      issue('/owner', 'OWNER_ANCHOR_MISMATCH');
    else if (!anchorRecognizes(owner.recognitionScope, rec))
      issue('/recognition', 'OWNER_RECOGNITION_NOT_COVERED');
  }

  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, spec, specHash, universeHash: rankingUniverseHash(spec), canonicalText };
}

/** Whether an anchor's recognition scope covers a system's declared recognition (BRT-03 semantics). */
export function anchorRecognizes(
  scope: RecognitionScope,
  rec: RankingSystemSpec['recognition'],
): boolean {
  if (!(scope.recognitionLevel as readonly string[]).includes(rec.level)) return false;
  const covers = (
    dimension: 'sport' | 'discipline' | 'region',
    allowed: readonly string[] | undefined,
    requested: readonly string[] | undefined,
  ) =>
    allowed === undefined ||
    (requested !== undefined &&
      requested.every((v) => allowed.some((a) => coversValue(dimension, a, v))));
  return (
    covers('sport', scope.sport, rec.sport) &&
    covers('discipline', scope.discipline, rec.discipline) &&
    covers('region', scope.region, rec.region)
  );
}

/**
 * A new version of a ranking system keeps its universe, kind and owner (a different universe or owner
 * is a different system, ADR-0048 §1). Only name, raised floor, recognition wording within the same
 * owner, and effectiveFrom may change.
 */
export function rankingSystemVersionContinues(
  previous: RankingSystemSpec,
  next: RankingSystemSpec,
): { readonly ok: boolean; readonly code?: string } {
  if (rankingUniverseHash(previous) !== rankingUniverseHash(next))
    return { ok: false, code: 'UNIVERSE_CHANGE_REQUIRES_NEW_SYSTEM' };
  if (previous.kind !== next.kind) return { ok: false, code: 'KIND_CHANGE_REQUIRES_NEW_SYSTEM' };
  if (JSON.stringify(previous.owner) !== JSON.stringify(next.owner))
    return { ok: false, code: 'OWNER_CHANGE_REQUIRES_NEW_SYSTEM' };
  return { ok: true };
}
