import { CanonicalError, type ContentHash } from '@br/canonical';
import type { ComparatorOrder } from '@br/competition';
import type {
  ClassificationAggregation,
  ClassificationKeySource,
  ResultOutcome,
  ResultScopeType,
} from '@br/domain';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';
import {
  deferredVocabularyIssues,
  RECOGNITION_WORDS,
  type RankingDisciplineContext,
  type SpecIssue,
} from './system';

/**
 * Declarative ClassificationPolicy (`br:classification-policy@1`, ADR-0049).
 *
 * Orders an in-competition classification ONLY by the pinned DisciplineVersion comparator keys, in
 * declared order and direction (never added / removed / reordered / re-directed), each with an explicit
 * source and closed aggregation (SUM | MAX | MIN — AVERAGE is refused until a rounding policy exists),
 * plus integer outcome points for HEAD_TO_HEAD_WINNER disciplines. Exhausted keys ⇒ shared ranks.
 */
export const CLASSIFICATION_ENGINE_VERSION = 'classification-engine/1';
export const SUPPORTED_CLASSIFICATION_ENGINES: readonly string[] = [CLASSIFICATION_ENGINE_VERSION];

export interface ClassificationKey {
  readonly metric: string;
  /** The canonical Mark.metricId the DV key is recorded under. */
  readonly markMetricId: string;
  readonly order: ComparatorOrder;
  readonly source: ClassificationKeySource;
  readonly aggregation: ClassificationAggregation;
}

export interface ClassificationPolicySpec {
  readonly targetEngine: string;
  readonly displayName: string;
  readonly scopeType: Exclude<ResultScopeType, 'CONTEST'>;
  readonly disciplineVersionId: string;
  readonly minimumInputStatus: 'PROVISIONAL' | 'OFFICIAL' | 'FINAL';
  readonly primary: 'HEAD_TO_HEAD_WINNER' | 'METRICS';
  readonly keys: readonly ClassificationKey[];
  readonly outcomePoints?: readonly { readonly outcome: ResultOutcome; readonly points: number }[];
}

export const MAX_POLICY_CANONICAL_BYTES = 8 * 1024;

export type ClassificationPolicyValidation =
  | {
      readonly ok: true;
      readonly spec: ClassificationPolicySpec;
      readonly specHash: ContentHash;
      readonly canonicalText: string;
    }
  | { readonly ok: false; readonly issues: readonly SpecIssue[] };

export function validateClassificationPolicySpec(
  input: unknown,
  discipline?: RankingDisciplineContext,
): ClassificationPolicyValidation {
  const deferred = deferredVocabularyIssues(input, [['keys', '*', 'aggregation']]);
  if (deferred.length > 0) return { ok: false, issues: deferred };
  let spec: ClassificationPolicySpec;
  let specHash: ContentHash;
  let canonicalText: string;
  try {
    const r = platformCanonicalizer().hashCanonical(
      DomainTag.classificationPolicy,
      SchemaRef.classificationPolicy.id,
      SchemaRef.classificationPolicy.version,
      input,
    );
    spec = r.normalized as unknown as ClassificationPolicySpec;
    specHash = r.contentHash;
    canonicalText = r.canonicalText;
  } catch (err) {
    if (err instanceof CanonicalError)
      return { ok: false, issues: [{ path: err.path || '/', code: err.code }] };
    throw err;
  }
  if (Buffer.byteLength(canonicalText, 'utf8') > MAX_POLICY_CANONICAL_BYTES)
    return { ok: false, issues: [{ path: '/', code: 'POLICY_TOO_LARGE' }] };

  const issues: SpecIssue[] = [];
  const issue = (path: string, code: string) => issues.push({ path, code });

  if (!SUPPORTED_CLASSIFICATION_ENGINES.includes(spec.targetEngine))
    issue('/targetEngine', 'ENGINE_VERSION_UNSUPPORTED');
  const name = spec.displayName;
  if (name.trim() !== name || [...name].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20))
    issue('/displayName', 'DISPLAY_NAME_INVALID');
  if (RECOGNITION_WORDS.test(name)) issue('/displayName', 'DISPLAY_NAME_CLAIMS_RECOGNITION');

  const seen = new Set<string>();
  spec.keys.forEach((k, i) => {
    if (seen.has(k.metric)) issue(`/keys/${i}/metric`, 'DUPLICATE_COMPARATOR_KEY');
    seen.add(k.metric);
    if (k.order === 'ORDINAL') issue(`/keys/${i}/order`, 'COMPARATOR_UNDEFINED');
  });
  if (spec.primary === 'METRICS') {
    if (spec.keys.length === 0) issue('/keys', 'COMPARATOR_UNDEFINED');
    if (spec.outcomePoints !== undefined) issue('/outcomePoints', 'OUTCOME_POINTS_NOT_ALLOWED');
  } else if (spec.outcomePoints === undefined) issue('/outcomePoints', 'OUTCOME_POINTS_REQUIRED');

  if (discipline !== undefined) {
    if (discipline.status !== 'PUBLISHED')
      issue('/disciplineVersionId', 'DISCIPLINE_VERSION_NOT_PUBLISHED');
    issues.push(...classificationPolicyDisciplineIssues(spec, discipline));
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, spec, specHash, canonicalText };
}

/**
 * Coherence of a policy with the exact DisciplineVersion it pins: same DV, same comparator primitive,
 * the DV comparator keys in declared order and direction, every key a DV metric. Shared by policy
 * publication (above) and every derivation (the engine re-checks against the pinned DV facts).
 */
export function classificationPolicyDisciplineIssues(
  spec: ClassificationPolicySpec,
  discipline: {
    readonly disciplineVersionId: string;
    readonly spec: Pick<RankingDisciplineContext['spec'], 'metrics' | 'comparator'>;
  },
): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const issue = (path: string, code: string) => issues.push({ path, code });
  if (discipline.disciplineVersionId !== spec.disciplineVersionId)
    issue('/disciplineVersionId', 'DISCIPLINE_VERSION_MISMATCH');
  const c = discipline.spec.comparator;
  if (c.primary !== spec.primary) issue('/primary', 'COMPARATOR_MISMATCH');
  const pinned = spec.keys.map((k) => `${k.metric}:${k.order}`);
  const declared = c.keys.map((k) => `${k.metric}:${k.order}`);
  if (JSON.stringify(pinned) !== JSON.stringify(declared)) issue('/keys', 'COMPARATOR_MISMATCH');
  spec.keys.forEach((k, i) => {
    if (!discipline.spec.metrics.some((m) => m.key === k.metric))
      issue(`/keys/${i}/metric`, 'METRIC_UNKNOWN');
  });
  return issues;
}
