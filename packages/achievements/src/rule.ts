import { CanonicalError, type ContentHash } from '@br/canonical';
import type { ComparatorOrder, DisciplineVersionSpec, MetricValueType } from '@br/competition';
import {
  ACHIEVEMENT_PLATFORM_FLOOR,
  ACHIEVEMENT_TYPES,
  verificationLevelIndex,
  type AchievementType,
  type QualificationBasisKind,
  type RequiredResultStatus,
  type ResultScopeType,
  type VerificationLevel,
} from '@br/domain';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';
import { operatorFitsOrder, thresholdFits, type ThresholdOperator } from './marks';

/**
 * Declarative AchievementRule (`br:achievement-rule@1`, BRT-08 §20–26).
 *
 * A rule is DATA: one criterion from a closed vocabulary with bounded parameters — no JavaScript,
 * SQL, eval, expression strings, plugins or boolean trees. A rule may RAISE the BRT-01 platform floor
 * (e.g. require V3 for a title) but never lower it; publication re-validates. Changing semantics
 * requires a new AchievementRuleVersion; published versions are immutable.
 */
export const ACHIEVEMENT_ENGINE_ID = 'bragging-rights-achievement-engine';
export const ACHIEVEMENT_ENGINE_VERSION = 'achievement-engine/1';
/**
 * BRT-09 (ADR-0045): achievement-engine/2 = achievement-engine/1 for EVERY /1 criterion (identical
 * derivations, hashes and vectors) + the RECORD_MARK_RATIFIED criterion of RECORD_SET. A /1 rule is
 * still derived by /1 semantics and its candidates carry engineVersion achievement-engine/1.
 */
export const ACHIEVEMENT_ENGINE_VERSION_2 = 'achievement-engine/2';
/**
 * BRT-10 (ADR-0050): achievement-engine/3 = achievement-engine/2 for EVERY /1 and /2 criterion
 * (identical derivations, hashes and vectors) + the QUALIFYING_POSITION criterion of QUALIFIED. A /1
 * or /2 rule is still derived by its own semantics and its candidates carry its own engineVersion.
 */
export const ACHIEVEMENT_ENGINE_VERSION_3 = 'achievement-engine/3';
export const SUPPORTED_ACHIEVEMENT_ENGINES: readonly string[] = [
  ACHIEVEMENT_ENGINE_VERSION,
  ACHIEVEMENT_ENGINE_VERSION_2,
  ACHIEVEMENT_ENGINE_VERSION_3,
];

export type CriterionKind =
  | 'CLASSIFICATION_POSITION'
  | 'CLASSIFICATION_COMPLETION'
  | 'CONTEST_OUTCOME'
  | 'PERFORMANCE_THRESHOLD'
  | 'PERSONAL_BEST'
  | 'RECORD_MARK_RATIFIED'
  | 'QUALIFYING_POSITION';

export type HolderStrategy = 'ENTRY_PARTICIPANT' | 'PERFORMER';

export interface RuleCriterion {
  readonly kind: CriterionKind;
  readonly resultScope: ResultScopeType;
  readonly rank?: { readonly min: number; readonly max: number };
  readonly outcomes?: readonly ('WIN' | 'WALKOVER_WIN')[];
  readonly metric?: { readonly key: string; readonly markMetricId: string };
  readonly operator?: ThresholdOperator;
  readonly threshold?: string;
  readonly firstEligibleEstablishesBest?: boolean;
  /** AC-4: the recognition scope a TITLE / PLACEMENT name claims (requires V3+, never PLATFORM). */
  readonly recognitionClaim?: RecognitionClaim;
  /** QUALIFYING_POSITION only (ADR-0050 §2): target, N and the exact pinned source. */
  readonly qualification?: QualificationCriterion;
}

/**
 * The QUALIFIED rule's declaration (ADR-0050 §2). The source is pinned exactly: one ranking system
 * VERSION (never "the latest"), or one classification scope (event / competition) under one exact
 * classification policy version. Every holder whose (shared) rank is ≤ `qualifyingRanks` qualifies
 * (ADR-0049 §5) — no other tie rule exists in v1.
 */
export interface QualificationCriterion {
  readonly targetCompetitionId: string;
  readonly qualifyingRanks: number;
  readonly source: {
    readonly kind: QualificationBasisKind;
    readonly rankingSystemId?: string;
    readonly rankingSystemVersionId?: string;
    readonly scopeType?: 'EVENT_CLASSIFICATION' | 'COMPETITION_CLASSIFICATION';
    readonly scopeId?: string;
    readonly policyVersionId?: string;
  };
}

export type ClaimedRecognition = 'REGIONAL' | 'NATIONAL' | 'CONTINENTAL' | 'WORLD';
/**
 * AC-4 structural recognition claim: the recognition LEVEL and (except WORLD) the REGION it claims,
 * in the BRT-03 authority-scope vocabulary (ISO 3166-1 alpha-2 / ISO 3166-2). A continental claim is
 * the explicit set of its countries. Checked by scope containment against the pinned governing
 * recognition; the free-text label can never widen it.
 */
export interface RecognitionClaim {
  readonly level: ClaimedRecognition;
  readonly region?: readonly string[];
}
/** Federation ladder ranks (PLATFORM and CLUB never back a recognition claim). */
export const RECOGNITION_RANK: Readonly<Record<string, number>> = {
  CLUB: 1,
  REGIONAL: 2,
  NATIONAL: 3,
  CONTINENTAL: 4,
  WORLD: 5,
};

export interface AchievementRuleSpec {
  readonly targetEngine: string;
  readonly achievementType: AchievementType;
  readonly displayName: string;
  readonly disciplineVersionId: string;
  readonly holder: HolderStrategy;
  readonly requirements: {
    readonly minimumVerificationLevel: VerificationLevel;
    readonly minimumResultStatus: RequiredResultStatus;
  };
  readonly criterion: RuleCriterion;
}

/** Type ↔ criterion kind ↔ holder strategy ↔ admissible result scopes (BRT-01 §8.2). */
export const TYPE_SHAPE: Readonly<
  Record<
    AchievementType,
    {
      readonly kind: CriterionKind;
      readonly holder: HolderStrategy;
      readonly scopes: readonly ResultScopeType[];
    }
  >
> = {
  EVENT_COMPLETED: {
    kind: 'CLASSIFICATION_COMPLETION',
    holder: 'ENTRY_PARTICIPANT',
    scopes: ['EVENT_CLASSIFICATION'],
  },
  CONTEST_WON: { kind: 'CONTEST_OUTCOME', holder: 'ENTRY_PARTICIPANT', scopes: ['CONTEST'] },
  PLACEMENT: {
    kind: 'CLASSIFICATION_POSITION',
    holder: 'ENTRY_PARTICIPANT',
    scopes: ['ROUND_CLASSIFICATION', 'EVENT_CLASSIFICATION', 'COMPETITION_CLASSIFICATION'],
  },
  TITLE: {
    kind: 'CLASSIFICATION_POSITION',
    holder: 'ENTRY_PARTICIPANT',
    scopes: ['EVENT_CLASSIFICATION', 'COMPETITION_CLASSIFICATION'],
  },
  PERFORMANCE_THRESHOLD: {
    kind: 'PERFORMANCE_THRESHOLD',
    holder: 'PERFORMER',
    scopes: ['CONTEST'],
  },
  PERSONAL_BEST: { kind: 'PERSONAL_BEST', holder: 'PERFORMER', scopes: ['CONTEST'] },
  RECORD_SET: { kind: 'RECORD_MARK_RATIFIED', holder: 'PERFORMER', scopes: ['CONTEST'] },
  // resultScope = the scope of the ResultVersions the basis pins: the CONTEST results under a ranking
  // snapshot's entries, or the classification itself (checked against the declared source).
  QUALIFIED: {
    kind: 'QUALIFYING_POSITION',
    holder: 'ENTRY_PARTICIPANT',
    scopes: ['CONTEST', 'EVENT_CLASSIFICATION', 'COMPETITION_CLASSIFICATION'],
  },
};

/** Parameters each criterion kind takes (anything else is rejected). */
const KIND_PARAMS: Readonly<Record<CriterionKind, readonly (keyof RuleCriterion)[]>> = {
  CLASSIFICATION_POSITION: ['rank', 'recognitionClaim'],
  CLASSIFICATION_COMPLETION: [],
  CONTEST_OUTCOME: ['outcomes'],
  PERFORMANCE_THRESHOLD: ['metric', 'operator', 'threshold'],
  PERSONAL_BEST: ['metric', 'firstEligibleEstablishesBest'],
  RECORD_MARK_RATIFIED: [],
  QUALIFYING_POSITION: ['qualification'],
};
const REQUIRED_PARAMS: Readonly<Record<CriterionKind, readonly (keyof RuleCriterion)[]>> = {
  CLASSIFICATION_POSITION: ['rank'],
  CLASSIFICATION_COMPLETION: [],
  CONTEST_OUTCOME: ['outcomes'],
  PERFORMANCE_THRESHOLD: ['metric', 'operator', 'threshold'],
  PERSONAL_BEST: ['metric', 'firstEligibleEstablishesBest'],
  RECORD_MARK_RATIFIED: [],
  QUALIFYING_POSITION: ['qualification'],
};

/**
 * AC-4: a title / recognition label may only claim a scope its governing authority's anchor
 * recognizes. Level words (regional / national / continental / world) are allowed ONLY when the rule
 * declares a matching `claimedRecognition` — which the engine then enforces against the recognition
 * pinned from the basis run's immutable trace. Words claiming other standing (official, record,
 * federation, olympic, verified, certified, …) are always refused.
 */
const ALWAYS_FORBIDDEN_CLAIM =
  /\b(international|olympic|federation|federaci[oó]n|official|oficial|record|r[eé]cord|ratified|sanctioned|verified|certified)\b/i;
const LEVEL_WORDS: readonly [RegExp, ClaimedRecognition][] = [
  [/\b(world|mundial)\b/i, 'WORLD'],
  [/\b(continental)\b/i, 'CONTINENTAL'],
  [/\b(national|nacional)\b/i, 'NATIONAL'],
  [/\b(regional)\b/i, 'REGIONAL'],
];

export const MAX_RULE_CANONICAL_BYTES = 8 * 1024;

export interface RuleIssue {
  readonly path: string;
  readonly code: string;
}

export type RuleValidation =
  | {
      readonly ok: true;
      readonly spec: AchievementRuleSpec;
      readonly specHash: ContentHash;
      readonly canonicalText: string;
    }
  | { readonly ok: false; readonly issues: readonly RuleIssue[] };

/** The exact DisciplineVersion facts a rule is checked against (catalog data, PUBLISHED). */
export interface RuleDisciplineContext {
  readonly disciplineVersionId: string;
  readonly status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  readonly spec: Pick<DisciplineVersionSpec, 'metrics' | 'comparator'>;
}

/** Comparator order per metric key, from the DisciplineVersion comparator (undefined = not ordered). */
export function metricOrders(
  spec: Pick<DisciplineVersionSpec, 'comparator'>,
): ReadonlyMap<string, ComparatorOrder> {
  const m = new Map<string, ComparatorOrder>();
  if (spec.comparator.primary === 'METRICS')
    for (const k of spec.comparator.keys) if (!m.has(k.metric)) m.set(k.metric, k.order);
  return m;
}

/**
 * Validates a rule spec: closed BR-JSON schema (unknown members, nulls, floats, unknown enum values
 * rejected), size bound, then the semantic rules. With `discipline`, the metric references are
 * checked against the exact DisciplineVersion (required before a version row can exist).
 *   specHash = H("achievement-rule", br:achievement-rule@1, JCS(spec))
 */
export function validateAchievementRuleSpec(
  input: unknown,
  discipline?: RuleDisciplineContext,
): RuleValidation {
  let spec: AchievementRuleSpec;
  let specHash: ContentHash;
  let canonicalText: string;
  try {
    const r = platformCanonicalizer().hashCanonical(
      DomainTag.achievementRule,
      SchemaRef.achievementRule.id,
      SchemaRef.achievementRule.version,
      input,
    );
    spec = r.normalized as unknown as AchievementRuleSpec;
    specHash = r.contentHash;
    canonicalText = r.canonicalText;
  } catch (err) {
    if (err instanceof CanonicalError)
      return { ok: false, issues: [{ path: err.path || '/', code: err.code }] };
    throw err;
  }
  if (Buffer.byteLength(canonicalText, 'utf8') > MAX_RULE_CANONICAL_BYTES)
    return { ok: false, issues: [{ path: '/', code: 'RULE_TOO_LARGE' }] };

  const issues: RuleIssue[] = [];
  const issue = (path: string, code: string) => issues.push({ path, code });
  if (!SUPPORTED_ACHIEVEMENT_ENGINES.includes(spec.targetEngine))
    issue('/targetEngine', 'ENGINE_VERSION_UNSUPPORTED');
  if (!ACHIEVEMENT_TYPES.includes(spec.achievementType))
    issue('/achievementType', 'ACHIEVEMENT_TYPE_UNSUPPORTED');
  // RECORD_SET exists only on achievement-engine/2; every other type keeps its /1 semantics.
  if (spec.achievementType === 'RECORD_SET' && spec.targetEngine !== ACHIEVEMENT_ENGINE_VERSION_2)
    issue('/targetEngine', 'RECORD_SET_REQUIRES_ACHIEVEMENT_ENGINE_2');
  // QUALIFIED exists only on achievement-engine/3 (ADR-0050 §1).
  if (spec.achievementType === 'QUALIFIED' && spec.targetEngine !== ACHIEVEMENT_ENGINE_VERSION_3)
    issue('/targetEngine', 'QUALIFIED_REQUIRES_ACHIEVEMENT_ENGINE_3');
  // The word "record" is admissible ONLY for RECORD_SET, whose recognition is structurally backed by
  // a ratified RecordMark; recognition-level words stay refused (labels come from the RecordMark).
  const nameForClaims =
    spec.achievementType === 'RECORD_SET'
      ? spec.displayName.replace(/\b(record|r[eé]cord)s?\b/gi, '')
      : spec.displayName;
  if (ALWAYS_FORBIDDEN_CLAIM.test(nameForClaims))
    issue('/displayName', 'DISPLAY_NAME_CLAIMS_RECOGNITION');
  const claimObj = spec.criterion.recognitionClaim;
  const claimed = claimObj?.level;
  for (const [re, lvl] of LEVEL_WORDS)
    if (
      re.test(spec.displayName) &&
      (claimed === undefined || (RECOGNITION_RANK[claimed] ?? 0) < (RECOGNITION_RANK[lvl] ?? 0))
    )
      issue('/displayName', 'DISPLAY_NAME_CLAIMS_RECOGNITION');
  if (claimObj !== undefined) {
    if (spec.achievementType !== 'TITLE' && spec.achievementType !== 'PLACEMENT')
      issue('/criterion/recognitionClaim', 'RECOGNITION_CLAIM_NOT_ALLOWED_FOR_TYPE');
    const region = claimObj.region ?? [];
    const alpha2 = region.every((r) => /^[A-Z]{2}$/.test(r));
    if (claimObj.level === 'WORLD' && region.length > 0)
      issue('/criterion/recognitionClaim/region', 'WORLD_CLAIM_HAS_NO_REGION');
    if (claimObj.level !== 'WORLD' && region.length === 0)
      issue('/criterion/recognitionClaim/region', 'RECOGNITION_CLAIM_REGION_REQUIRED');
    if (claimObj.level === 'NATIONAL' && (region.length !== 1 || !alpha2))
      issue('/criterion/recognitionClaim/region', 'NATIONAL_CLAIM_NEEDS_ONE_COUNTRY');
    if (claimObj.level === 'REGIONAL' && region.length !== 1)
      issue('/criterion/recognitionClaim/region', 'REGIONAL_CLAIM_NEEDS_ONE_REGION');
    if (claimObj.level === 'CONTINENTAL' && !alpha2)
      issue('/criterion/recognitionClaim/region', 'CONTINENTAL_CLAIM_NEEDS_COUNTRIES');
    // BRT-01 §8.2: titles named after a sanctioning body's scope need V3 (SANCTIONED).
    if (
      verificationLevelIndex(spec.requirements.minimumVerificationLevel) <
      verificationLevelIndex('V3')
    )
      issue('/requirements/minimumVerificationLevel', 'RECOGNITION_CLAIM_REQUIRES_V3');
  }
  if (
    spec.displayName.trim() !== spec.displayName ||
    [...spec.displayName].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20)
  )
    issue('/displayName', 'DISPLAY_NAME_INVALID');

  const shape = TYPE_SHAPE[spec.achievementType];
  const c = spec.criterion;
  if (shape !== undefined) {
    if (c.kind !== shape.kind) issue('/criterion/kind', 'CRITERION_KIND_NOT_ALLOWED_FOR_TYPE');
    if (spec.holder !== shape.holder) issue('/holder', 'HOLDER_STRATEGY_NOT_ALLOWED_FOR_TYPE');
    if (!shape.scopes.includes(c.resultScope))
      issue('/criterion/resultScope', 'RESULT_SCOPE_NOT_ALLOWED_FOR_TYPE');
    // Platform floors (BRT-01 §7): a rule may raise them, never lower them.
    const floor = ACHIEVEMENT_PLATFORM_FLOOR[spec.achievementType];
    if (
      verificationLevelIndex(spec.requirements.minimumVerificationLevel) <
      verificationLevelIndex(floor.minimumVerificationLevel)
    )
      issue('/requirements/minimumVerificationLevel', 'BELOW_PLATFORM_FLOOR');
    if (floor.minimumResultStatus === 'FINAL' && spec.requirements.minimumResultStatus !== 'FINAL')
      issue('/requirements/minimumResultStatus', 'BELOW_PLATFORM_FLOOR');
  }
  for (const p of Object.keys(c) as (keyof RuleCriterion)[]) {
    if (p === 'kind' || p === 'resultScope') continue;
    if (!(KIND_PARAMS[c.kind] ?? []).includes(p)) issue(`/criterion/${p}`, 'PARAM_NOT_ALLOWED');
  }
  for (const p of REQUIRED_PARAMS[c.kind] ?? [])
    if (c[p] === undefined) issue(`/criterion/${p}`, 'PARAM_REQUIRED');
  const q = c.qualification;
  if (q !== undefined && c.kind === 'QUALIFYING_POSITION') {
    const src = q.source;
    const ranking = src.kind === 'RANKING_SNAPSHOT_POSITION';
    const has = (k: keyof QualificationCriterion['source']) => src[k] !== undefined;
    // Exactly the members of the declared source kind — never a partially pinned source.
    for (const k of ['rankingSystemId', 'rankingSystemVersionId'] as const)
      if (has(k) !== ranking)
        issue(
          `/criterion/qualification/source/${k}`,
          ranking ? 'PARAM_REQUIRED' : 'PARAM_NOT_ALLOWED',
        );
    for (const k of ['scopeType', 'scopeId', 'policyVersionId'] as const)
      if (has(k) === ranking)
        issue(
          `/criterion/qualification/source/${k}`,
          ranking ? 'PARAM_NOT_ALLOWED' : 'PARAM_REQUIRED',
        );
    // resultScope names the basis ResultVersions: CONTEST under a snapshot, else the classification.
    if (ranking ? c.resultScope !== 'CONTEST' : c.resultScope !== src.scopeType)
      issue('/criterion/resultScope', 'RESULT_SCOPE_NOT_ALLOWED_FOR_TYPE');
  }
  if (c.rank !== undefined) {
    if (c.rank.min > c.rank.max) issue('/criterion/rank', 'RANK_RANGE_INVALID');
    if (spec.achievementType === 'TITLE' && (c.rank.min !== 1 || c.rank.max !== 1))
      issue('/criterion/rank', 'TITLE_REQUIRES_RANK_1');
    if (spec.achievementType === 'PLACEMENT' && c.rank.max > 64)
      issue('/criterion/rank', 'RANK_RANGE_TOO_WIDE');
  }

  if (discipline !== undefined) {
    if (discipline.disciplineVersionId !== spec.disciplineVersionId)
      issue('/disciplineVersionId', 'DISCIPLINE_VERSION_MISMATCH');
    if (discipline.status !== 'PUBLISHED')
      issue('/disciplineVersionId', 'DISCIPLINE_VERSION_NOT_PUBLISHED');
    if (c.metric !== undefined) {
      const metric = discipline.spec.metrics.find((m) => m.key === c.metric?.key);
      const order = metricOrders(discipline.spec).get(c.metric.key);
      if (metric === undefined) issue('/criterion/metric/key', 'METRIC_UNKNOWN');
      else {
        if (c.threshold !== undefined && !thresholdFits(metric.valueType, c.threshold))
          issue('/criterion/threshold', 'THRESHOLD_TYPE_MISMATCH');
        if (c.operator !== undefined && !operatorFitsOrder(c.operator, order))
          issue('/criterion/operator', 'OPERATOR_CONTRADICTS_COMPARATOR');
        if (c.kind === 'PERSONAL_BEST' && order === undefined)
          issue('/criterion/metric/key', 'PB_METRIC_ORDER_UNDEFINED');
      }
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, spec, specHash, canonicalText };
}

/** The effective requirement: the stricter of the rule and the platform floor (defence in depth). */
export function effectiveRequirements(spec: AchievementRuleSpec): {
  readonly level: VerificationLevel;
  readonly status: RequiredResultStatus;
} {
  const floor = ACHIEVEMENT_PLATFORM_FLOOR[spec.achievementType];
  const level =
    verificationLevelIndex(spec.requirements.minimumVerificationLevel) >=
    verificationLevelIndex(floor.minimumVerificationLevel)
      ? spec.requirements.minimumVerificationLevel
      : floor.minimumVerificationLevel;
  const status =
    floor.minimumResultStatus === 'FINAL' ? 'FINAL' : spec.requirements.minimumResultStatus;
  return { level, status };
}

// ───────────────────────── fictional development reference rules ─────────────────────────

/**
 * Fictional DEVELOPMENT reference rules (not universal standards). Every one meets the BRT-01 floor
 * exactly; they are bound to one exact DisciplineVersion by the seed.
 */
export function referenceTitleRule(disciplineVersionId: string): AchievementRuleSpec {
  return {
    targetEngine: ACHIEVEMENT_ENGINE_VERSION,
    achievementType: 'TITLE',
    displayName: 'Event Champion',
    disciplineVersionId,
    holder: 'ENTRY_PARTICIPANT',
    requirements: { minimumVerificationLevel: 'V2', minimumResultStatus: 'FINAL' },
    criterion: {
      kind: 'CLASSIFICATION_POSITION',
      resultScope: 'EVENT_CLASSIFICATION',
      rank: { min: 1, max: 1 },
    },
  };
}

export function referenceThresholdRule(
  disciplineVersionId: string,
  metric: { key: string; markMetricId: string },
  operator: ThresholdOperator,
  threshold: string,
  displayName = 'Threshold Performance',
): AchievementRuleSpec {
  return {
    targetEngine: ACHIEVEMENT_ENGINE_VERSION,
    achievementType: 'PERFORMANCE_THRESHOLD',
    displayName,
    disciplineVersionId,
    holder: 'PERFORMER',
    requirements: { minimumVerificationLevel: 'V2', minimumResultStatus: 'FINAL' },
    criterion: {
      kind: 'PERFORMANCE_THRESHOLD',
      resultScope: 'CONTEST',
      metric,
      operator,
      threshold,
    },
  };
}

/** The development RECORD_SET rule of one DisciplineVersion (the floor is raised per mark). */
export function referenceRecordSetRule(
  disciplineVersionId: string,
  displayName = 'Record set',
): AchievementRuleSpec {
  return {
    targetEngine: ACHIEVEMENT_ENGINE_VERSION_2,
    achievementType: 'RECORD_SET',
    displayName,
    disciplineVersionId,
    holder: 'PERFORMER',
    requirements: { minimumVerificationLevel: 'V2', minimumResultStatus: 'FINAL' },
    criterion: { kind: 'RECORD_MARK_RATIFIED', resultScope: 'CONTEST' },
  };
}

/** The development QUALIFIED rule (FINAL · V3 floor; source pinned exactly). */
export function referenceQualifiedRule(
  disciplineVersionId: string,
  qualification: QualificationCriterion,
  displayName = 'Qualified',
): AchievementRuleSpec {
  return {
    targetEngine: ACHIEVEMENT_ENGINE_VERSION_3,
    achievementType: 'QUALIFIED',
    displayName,
    disciplineVersionId,
    holder: 'ENTRY_PARTICIPANT',
    requirements: { minimumVerificationLevel: 'V3', minimumResultStatus: 'FINAL' },
    criterion: {
      kind: 'QUALIFYING_POSITION',
      resultScope:
        qualification.source.kind === 'RANKING_SNAPSHOT_POSITION'
          ? 'CONTEST'
          : (qualification.source.scopeType ?? 'EVENT_CLASSIFICATION'),
      qualification,
    },
  };
}

export function referencePersonalBestRule(
  disciplineVersionId: string,
  metric: { key: string; markMetricId: string },
  displayName = 'Personal Best',
): AchievementRuleSpec {
  return {
    targetEngine: ACHIEVEMENT_ENGINE_VERSION,
    achievementType: 'PERSONAL_BEST',
    displayName,
    disciplineVersionId,
    holder: 'PERFORMER',
    requirements: { minimumVerificationLevel: 'V2', minimumResultStatus: 'OFFICIAL' },
    criterion: {
      kind: 'PERSONAL_BEST',
      resultScope: 'CONTEST',
      metric,
      firstEligibleEstablishesBest: true,
    },
  };
}

export type { MetricValueType };
