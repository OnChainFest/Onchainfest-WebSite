import { CanonicalError, type ContentHash } from '@br/canonical';
import { compareDecimal, precisionFits } from '@br/achievements';
import type { ComparatorOrder, MetricValueType, OutcomeModel } from '@br/competition';
import {
  POLICY_UNSUPPORTED,
  type Mark,
  type RankingProvenance,
  type ResultOutcome,
  type ResultScopeType,
  type ResultVersionStatus,
} from '@br/domain';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';
import {
  CLASSIFICATION_ENGINE_VERSION,
  classificationPolicyDisciplineIssues,
  validateClassificationPolicySpec,
  type ClassificationKey,
  type ClassificationPolicySpec,
} from './classification-policy';
import { checkSharedRanks, type ComparatorTraceItem } from './documents';
import { deferredVocabularyIssues, type SpecIssue } from './system';

/**
 * The pure, deterministic classification engine (ADR-0047, ADR-0049):
 *
 *   deriveClassification(ClassificationDerivationInput) → { inputsDigest, outcome, outcomeHash }
 *
 * It PROPOSES the `br:result-version-content@2` content of a classification ResultVersion; it never
 * submits, persists or publishes it. Submission is the existing ResultLedger T2 by a principal holding
 * SUBMIT_RESULT; the ledger re-assembles the same input, re-runs this engine and refuses any byte
 * difference (Step 6). A classification is a ResultVersion — never a RankingSnapshot.
 *
 *   1. definition   the embedded policy re-validates and re-hashes to `specHash`; it is coherent with the
 *                   pinned DisciplineVersion (keys in order and direction) and with the scope type.
 *                   ORDINAL keys and undeclared outcomes are POLICY_UNSUPPORTED (AVERAGE cannot even be
 *                   represented: refused before sealing).
 *   2. inputs       every input is a current CONTEST ResultVersion of a contest in scope, at or above
 *                   the policy minimum, whose `@1` content re-hashes to its pinned contentHash. Every
 *                   contest in scope needs exactly one admitted input. Anything else blocks the whole
 *                   derivation (no partial tables).
 *   3. values       per participant and key: the values of the declared source in EVERY contest the
 *                   participant appears in (missing ⇒ COMPARATOR_INPUT_MISSING, never 0 or worst); same
 *                   Mark metric, DV unit, DV value-type precision, one precision per key (no coercion).
 *   4. aggregation  SUM (exact decimal addition) | MAX | MIN (numeric, exact decimal comparison). No
 *                   rounding exists because no division exists. HEAD_TO_HEAD_WINNER adds the leading
 *                   key `outcomePoints` = SUM of the declared points, HIGHER_IS_BETTER.
 *   5. ordering     lexicographic over the keys in declared order; participants equal on every key share
 *                   a competition-style rank (1, 1, 3). No hidden tie-break. Asserted with
 *                   checkSharedRanks.
 *
 * Changing ANY semantics requires a new engine version (classification-engine/2).
 */

/** The trace key of the policy-derived points value. Positional (always first for HEAD_TO_HEAD). */
export const OUTCOME_POINTS_TRACE_KEY = 'outcomePoints';

export interface ClassificationInputContent {
  readonly entries: readonly {
    readonly participantId: string;
    readonly outcome: ResultOutcome;
    readonly rank?: number;
    readonly primaryMark?: Mark;
  }[];
  readonly performances?: readonly {
    readonly participantId: string;
    readonly athleteId?: string;
    readonly ordinal: number;
    readonly mark: Mark;
    readonly valid?: boolean;
  }[];
}

export interface ClassificationDerivationInput {
  readonly provenance: RankingProvenance;
  readonly assembler: string;
  readonly policy: {
    readonly policyId: string;
    readonly policyVersionId: string;
    readonly specHash: string;
    readonly spec: ClassificationPolicySpec;
  };
  readonly discipline: {
    readonly disciplineVersionId: string;
    readonly specHash: string;
    readonly metrics: readonly {
      readonly key: string;
      readonly valueType: MetricValueType;
      readonly unit: string;
    }[];
    readonly comparator: {
      readonly outcomeModel: OutcomeModel;
      readonly primary: 'HEAD_TO_HEAD_WINNER' | 'METRICS';
      readonly keys: readonly { readonly metric: string; readonly order: ComparatorOrder }[];
    };
  };
  readonly scope: {
    readonly scopeType: Exclude<ResultScopeType, 'CONTEST'>;
    readonly scopeId: string;
    readonly contestIds: readonly string[];
  };
  readonly inputs: readonly {
    readonly resultId: string;
    readonly resultVersionId: string;
    readonly contentHash: string;
    readonly scopeType: ResultScopeType;
    readonly contestId: string;
    readonly status: Exclude<ResultVersionStatus, 'DRAFT'>;
    readonly supersededByVersionId?: string;
    readonly content: ClassificationInputContent;
  }[];
}

/** ADR-0047 §2 derivation: exact pins, never copied source content. */
export interface ClassificationDerivation {
  readonly derivedFrom: readonly {
    readonly resultVersionId: string;
    readonly contentHash: string;
    readonly status: 'PROVISIONAL' | 'OFFICIAL' | 'FINAL';
  }[];
  readonly policy: {
    readonly policyId: string;
    readonly policyVersionId: string;
    readonly specHash: string;
  };
  readonly disciplineVersionId: string;
  readonly engineVersion: string;
  readonly inputsDigest: string;
}

/** `br:result-version-content@2`: the proposed classification ResultVersion content. */
export interface ClassificationContent {
  readonly entries: readonly {
    readonly participantId: string;
    readonly outcome: 'RANKED';
    readonly rank: number;
    readonly tied: boolean;
    readonly tieBreakKeys: readonly ComparatorTraceItem[];
  }[];
  readonly derivation: ClassificationDerivation;
}

export interface ClassificationDerivationOutcome {
  readonly engineVersion: string;
  readonly provenance: RankingProvenance;
  readonly inputsDigest: string;
  readonly policy: ClassificationDerivation['policy'];
  readonly disciplineVersionId: string;
  readonly state: 'PROPOSED' | 'BLOCKED';
  readonly blockers: readonly string[];
  readonly inputs: readonly {
    readonly resultVersionId: string;
    readonly state: 'ADMITTED' | 'EXCLUDED';
    readonly reasons: readonly string[];
  }[];
  readonly missingContestIds: readonly string[];
  readonly participants: readonly {
    readonly participantId: string;
    readonly reasons: readonly string[];
  }[];
  /** Present iff PROPOSED. A proposal, not a submission. */
  readonly proposal?: { readonly contentHash: string; readonly content: ClassificationContent };
}

export interface ClassificationDerivationMeta {
  /** Why the derivation was requested. NEVER hashed, never part of the outcome or the proposal. */
  readonly trigger?: string;
}

export type ClassificationDerivationResult =
  | {
      readonly ok: true;
      readonly inputsDigest: ContentHash;
      readonly outcome: ClassificationDerivationOutcome;
      readonly outcomeHash: ContentHash;
      readonly meta: ClassificationDerivationMeta;
    }
  | { readonly ok: false; readonly issues: readonly SpecIssue[] };

type Hashed<T> =
  | { readonly ok: true; readonly value: T; readonly hash: ContentHash }
  | { readonly ok: false; readonly issues: readonly SpecIssue[] };

function hashDoc<T>(
  tag: string,
  ref: { readonly id: string; readonly version: number },
  doc: unknown,
): Hashed<T> {
  try {
    const r = platformCanonicalizer().hashCanonical(tag, ref.id, ref.version, doc);
    return { ok: true, value: r.normalized as unknown as T, hash: r.contentHash };
  } catch (err) {
    if (err instanceof CanonicalError)
      return { ok: false, issues: [{ path: err.path || '/', code: err.code }] };
    throw err;
  }
}

/** H(classification-derivation-input, …) — the `inputsDigest` a classification pins. */
export const hashClassificationDerivationInput = (input: unknown) =>
  hashDoc<ClassificationDerivationInput>(
    DomainTag.classificationDerivationInput,
    SchemaRef.classificationDerivationInput,
    input,
  );

/** H(result-version-content, br:result-version-content@2, …) — the proposal's content hash. */
export const hashClassificationContent = (content: unknown) =>
  hashDoc<ClassificationContent>(
    DomainTag.resultVersionContent,
    SchemaRef.resultVersionContentV2,
    content,
  );

const STATUS_RANK: Readonly<Record<string, number>> = { PROVISIONAL: 1, OFFICIAL: 2, FINAL: 3 };
const dedupe = (xs: Iterable<string>) => [...new Set(xs)].sort();

/** Exact decimal SUM of canonical decimals sharing one precision (no rounding, no floats). */
function sumDecimals(values: readonly string[], precision: number): string {
  let total = 0n;
  for (const v of values) {
    const negative = v.startsWith('-');
    const [int = '0', frac = ''] = (negative ? v.slice(1) : v).split('.');
    const digits = BigInt(`${int}${frac.padEnd(precision, '0')}`);
    total += negative ? -digits : digits;
  }
  const negative = total < 0n;
  const text = (negative ? -total : total).toString().padStart(precision + 1, '0');
  const body =
    precision === 0 ? text : `${text.slice(0, -precision)}.${text.slice(text.length - precision)}`;
  return negative ? `-${body}` : body;
}

function aggregate(
  aggregation: ClassificationKey['aggregation'],
  values: readonly string[],
  precision: number,
): string {
  if (aggregation === 'SUM') return sumDecimals(values, precision);
  const pick = aggregation === 'MAX' ? 1 : -1;
  return values.reduce((a, b) => (compareDecimal(b, a) === pick ? b : a));
}

/** Derives one classification proposal. Pure and deterministic; `meta` never influences it. */
export function deriveClassification(
  input: unknown,
  meta: ClassificationDerivationMeta = {},
): ClassificationDerivationResult {
  // AVERAGE (or any deferred aggregation) is refused by name, never as a typo or approximation.
  const deferred = deferredVocabularyIssues(input, [
    ['policy', 'spec', 'keys', '*', 'aggregation'],
  ]);
  if (deferred.length > 0) return { ok: false, issues: deferred };
  const sealed = hashClassificationDerivationInput(input);
  if (!sealed.ok) return { ok: false, issues: sealed.issues };
  const d = sealed.value;
  const spec = d.policy.spec;
  const blockers = new Set<string>();

  // ── 1. definition.
  const v = validateClassificationPolicySpec(spec);
  if (!v.ok) for (const i of v.issues) blockers.add(i.code);
  else if (v.specHash !== d.policy.specHash) blockers.add('SPEC_HASH_MISMATCH');
  if (spec.keys.some((k) => k.order === 'ORDINAL')) blockers.add(POLICY_UNSUPPORTED);
  for (const i of classificationPolicyDisciplineIssues(spec, {
    disciplineVersionId: d.discipline.disciplineVersionId,
    spec: d.discipline,
  }))
    blockers.add(i.code);
  if (spec.scopeType !== d.scope.scopeType) blockers.add('RESULT_SCOPE_MISMATCH');

  // ── 2. inputs: current, admissible, exactly one per contest in scope.
  const inputs: ClassificationDerivationOutcome['inputs'][number][] = [];
  const admittedByContest = new Map<string, (typeof d.inputs)[number][]>();
  for (const i of d.inputs) {
    const reasons: string[] = [];
    const rehash = hashDoc(
      DomainTag.resultVersionContent,
      SchemaRef.resultVersionContent,
      i.content,
    );
    if (!rehash.ok || rehash.hash !== i.contentHash) reasons.push('CONTENT_HASH_MISMATCH');
    if (i.scopeType !== 'CONTEST') reasons.push('RESULT_SCOPE_MISMATCH');
    if (!d.scope.contestIds.includes(i.contestId)) reasons.push('OUTSIDE_COMPETITION_SCOPE');
    if (i.supersededByVersionId !== undefined || i.status === 'SUPERSEDED')
      reasons.push('RESULT_SUPERSEDED');
    else if (i.status === 'REVOKED') reasons.push('RESULT_REVOKED');
    else if (i.status === 'REJECTED') reasons.push('RESULT_REJECTED');
    else if ((STATUS_RANK[i.status] ?? 0) < (STATUS_RANK[spec.minimumInputStatus] ?? 99))
      reasons.push('RESULT_STATUS_BELOW_REQUIRED');
    if (reasons.length === 0)
      admittedByContest.set(i.contestId, [...(admittedByContest.get(i.contestId) ?? []), i]);
    inputs.push({
      resultVersionId: i.resultVersionId,
      state: reasons.length === 0 ? 'ADMITTED' : 'EXCLUDED',
      reasons:
        reasons.length === 0 ? [] : dedupe([...reasons, 'CLASSIFICATION_INPUT_INADMISSIBLE']),
    });
  }
  // Two admissible "current" versions of one contest contradict each other: neither is chosen.
  for (const group of admittedByContest.values())
    if (group.length > 1)
      for (const g of group) {
        const at = inputs.findIndex((x) => x.resultVersionId === g.resultVersionId);
        inputs[at] = {
          resultVersionId: g.resultVersionId,
          state: 'EXCLUDED',
          reasons: ['CLASSIFICATION_INPUT_INADMISSIBLE'],
        };
      }
  for (const i of inputs) for (const r of i.reasons) blockers.add(r);
  const admitted = d.inputs.filter(
    (i) => inputs.find((x) => x.resultVersionId === i.resultVersionId)?.state === 'ADMITTED',
  );
  const missingContestIds = d.scope.contestIds.filter(
    (c) => !admitted.some((i) => i.contestId === c),
  );
  if (missingContestIds.length > 0) blockers.add('CLASSIFICATION_INPUT_MISSING');

  // ── 3–4. per-participant values and aggregation.
  const participantIds = dedupe(
    admitted.flatMap((i) => i.content.entries.map((e) => e.participantId)),
  );
  const participantReasons = new Map<string, Set<string>>(
    participantIds.map((p) => [p, new Set()]),
  );
  const block = (p: string, code: string) => participantReasons.get(p)?.add(code);
  const traces = new Map<string, ComparatorTraceItem[]>(participantIds.map((p) => [p, []]));

  if (spec.primary === 'HEAD_TO_HEAD_WINNER') {
    const points = new Map((spec.outcomePoints ?? []).map((o) => [o.outcome, o.points]));
    for (const p of participantIds) {
      let total = 0n;
      for (const i of admitted)
        for (const e of i.content.entries.filter((x) => x.participantId === p)) {
          const pts = points.get(e.outcome);
          if (pts === undefined) block(p, POLICY_UNSUPPORTED);
          else total += BigInt(pts);
        }
      traces.get(p)?.push({
        key: OUTCOME_POINTS_TRACE_KEY,
        order: 'HIGHER_IS_BETTER',
        value: total.toString(),
      });
    }
  }

  for (const k of spec.keys) {
    const dvMetric = d.discipline.metrics.find((m) => m.key === k.metric);
    if (dvMetric === undefined || k.order === 'ORDINAL') continue; // definition already blocked
    const perParticipant = new Map<string, Mark[]>();
    for (const p of participantIds) {
      const values: Mark[] = [];
      for (const i of admitted) {
        if (!i.content.entries.some((e) => e.participantId === p)) continue;
        let found: Mark[];
        if (k.source === 'ENTRY_PRIMARY_MARK') {
          const m = i.content.entries.find((e) => e.participantId === p)?.primaryMark;
          found = m === undefined ? [] : [m];
          if (m !== undefined && m.metricId !== k.markMetricId) block(p, 'METRIC_MISMATCH');
        } else
          found = (i.content.performances ?? [])
            .filter((x) => x.participantId === p && x.mark.metricId === k.markMetricId)
            .filter((x) => x.valid !== false)
            .map((x) => x.mark);
        if (found.length === 0) block(p, 'COMPARATOR_INPUT_MISSING');
        values.push(...found.filter((m) => m.metricId === k.markMetricId));
      }
      for (const m of values) {
        if (m.unit !== dvMetric.unit) block(p, 'METRIC_UNIT_MISMATCH');
        if (!precisionFits(dvMetric.valueType, m.precision)) block(p, 'METRIC_PRECISION_MISMATCH');
      }
      perParticipant.set(p, values);
    }
    // One precision per key across the whole table: values are never re-scaled or coerced.
    const precisions = new Set([...perParticipant.values()].flat().map((m) => m.precision));
    if (precisions.size > 1) blockers.add('METRIC_PRECISION_MISMATCH');
    const [precision = 0] = [...precisions];
    for (const [p, values] of perParticipant)
      if (values.length > 0)
        traces.get(p)?.push({
          key: k.metric,
          order: k.order,
          value: aggregate(
            k.aggregation,
            values.map((m) => m.value),
            precision,
          ),
        });
  }
  for (const reasons of participantReasons.values()) for (const r of reasons) blockers.add(r);

  const outcomeBase = {
    engineVersion: CLASSIFICATION_ENGINE_VERSION,
    provenance: d.provenance,
    inputsDigest: sealed.hash,
    policy: {
      policyId: d.policy.policyId,
      policyVersionId: d.policy.policyVersionId,
      specHash: d.policy.specHash,
    },
    disciplineVersionId: d.discipline.disciplineVersionId,
    inputs,
    missingContestIds,
    participants: [...participantReasons]
      .filter(([, r]) => r.size > 0)
      .map(([participantId, r]) => ({ participantId, reasons: dedupe(r) })),
  };

  let proposal: ClassificationDerivationOutcome['proposal'];
  if (blockers.size === 0) {
    // ── 5. lexicographic ordering + competition-style shared ranks.
    const compare = (a: readonly ComparatorTraceItem[], b: readonly ComparatorTraceItem[]) => {
      for (let n = 0; n < a.length; n++) {
        const x = a[n];
        const y = b[n];
        if (x === undefined || y === undefined) break;
        const c = compareDecimal(x.value, y.value) * (x.order === 'HIGHER_IS_BETTER' ? 1 : -1);
        if (c !== 0) return c;
      }
      return 0;
    };
    const entries = participantIds.map((participantId) => {
      const t = traces.get(participantId) ?? [];
      const all = participantIds.map((o) => compare(traces.get(o) ?? [], t));
      return {
        participantId,
        outcome: 'RANKED' as const,
        rank: all.filter((c) => c > 0).length + 1,
        tied: all.filter((c) => c === 0).length > 1,
        tieBreakKeys: t,
      };
    });
    const issues = checkSharedRanks(entries, (a, b) => compare(a.tieBreakKeys, b.tieBreakKeys));
    if (issues.length > 0)
      throw new Error(`classification-engine invariant: ${issues.map((i) => i.code).join(',')}`);
    const content: ClassificationContent = {
      entries,
      derivation: {
        derivedFrom: admitted.map((i) => ({
          resultVersionId: i.resultVersionId,
          contentHash: i.contentHash,
          status: i.status as 'PROVISIONAL' | 'OFFICIAL' | 'FINAL',
        })),
        policy: outcomeBase.policy,
        disciplineVersionId: d.discipline.disciplineVersionId,
        engineVersion: CLASSIFICATION_ENGINE_VERSION,
        inputsDigest: sealed.hash,
      },
    };
    const h = hashClassificationContent(content);
    if (!h.ok)
      throw new Error(
        `classification-engine invariant: content not canonical (${h.issues[0]?.code})`,
      );
    proposal = { contentHash: h.hash, content: h.value };
  }

  const outcome: ClassificationDerivationOutcome = {
    ...outcomeBase,
    state: proposal === undefined ? 'BLOCKED' : 'PROPOSED',
    blockers: dedupe(blockers),
    ...(proposal === undefined ? {} : { proposal }),
  };
  const o = hashDoc<ClassificationDerivationOutcome>(
    DomainTag.classificationDerivationOutcome,
    SchemaRef.classificationDerivationOutcome,
    outcome,
  );
  if (!o.ok)
    throw new Error(
      `classification-engine invariant: outcome not canonical (${o.issues[0]?.code})`,
    );
  return { ok: true, inputsDigest: sealed.hash, outcome: o.value, outcomeHash: o.hash, meta };
}

// ───────────────────────────── dependencies, correction impact, replacement ─────────────────────────────

/**
 * The authoritative dependencies of a classification version (ADR-0047 §2, §5): exactly what its
 * content pins. `@1` classification content has no derivation ⇒ CLASSIFICATION_PROVENANCE_UNAVAILABLE
 * (never treated as derived). So is any content that is not valid `@2` (malformed or incomplete
 * provenance, a repeated pin — `derivedFrom` is a key-unique set): provenance is never guessed or
 * partially read. The pins come only from the canonical content (sorted by the canonicalizer); no
 * database state, timestamp or status lookup is involved.
 */
export function classificationDependencies(
  content: unknown,
):
  | { readonly ok: true; readonly derivation: ClassificationDerivation }
  | { readonly ok: false; readonly code: 'CLASSIFICATION_PROVENANCE_UNAVAILABLE' } {
  const h = hashClassificationContent(content);
  return h.ok
    ? { ok: true, derivation: h.value.derivation }
    : { ok: false, code: 'CLASSIFICATION_PROVENANCE_UNAVAILABLE' };
}

/**
 * Correction impact, computed — never stored (no `isStale` state anywhere): the pinned inputs of a
 * classification that are no longer the current admissible version of their Result. `current` maps a
 * pinned resultVersionId to whether it is still current and admissible (absent ⇒ unknown ⇒ affected:
 * unknown never counts as fresh). Status upgrades of the same version (PROVISIONAL → OFFICIAL) do not
 * change content and are not impact. Deterministic: one entry per affected resultVersionId (a repeated
 * reference never yields a repeated impact), ordered by resultVersionId whatever the pin order.
 * Analytical only: it never creates a correction, a replacement or a new version.
 */
export function classificationCorrectionImpact(
  derivation: ClassificationDerivation,
  current: ReadonlyMap<string, boolean>,
): readonly ClassificationDerivation['derivedFrom'][number][] {
  const affected = new Map<string, ClassificationDerivation['derivedFrom'][number]>();
  for (const p of derivation.derivedFrom)
    if (current.get(p.resultVersionId) !== true && !affected.has(p.resultVersionId))
      affected.set(p.resultVersionId, p);
  return [...affected.values()].sort((a, b) =>
    a.resultVersionId < b.resultVersionId ? -1 : a.resultVersionId > b.resultVersionId ? 1 : 0,
  );
}

/**
 * Whether a re-derived proposal may enter the ledger. A classification Result that already has a current
 * version can only be replaced through a T7 correction, which has no producer (ADR-0047 §6): the new
 * proposal is a new derived ResultVersion content, but it stays BLOCKED; the existing version is never
 * mutated.
 */
export function assessClassificationReplacement(
  proposalContentHash: string,
  current?: { readonly resultVersionId: string; readonly contentHash: string },
):
  | { readonly state: 'NO_CURRENT_VERSION' | 'IDENTICAL_TO_CURRENT' }
  | {
      readonly state: 'REPLACEMENT_BLOCKED';
      readonly reasons: readonly ['CLASSIFICATION_REPLACEMENT_REQUIRES_CORRECTION'];
      readonly replaces: string;
    } {
  if (current === undefined) return { state: 'NO_CURRENT_VERSION' };
  if (current.contentHash === proposalContentHash) return { state: 'IDENTICAL_TO_CURRENT' };
  return {
    state: 'REPLACEMENT_BLOCKED',
    reasons: ['CLASSIFICATION_REPLACEMENT_REQUIRES_CORRECTION'],
    replaces: current.resultVersionId,
  };
}
