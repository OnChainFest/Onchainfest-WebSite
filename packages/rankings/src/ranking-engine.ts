import type { ContentHash } from '@br/canonical';
import {
  evidenceCommitmentOf,
  precisionFits,
  RECOGNITION_RANK,
  type BasisItem,
} from '@br/achievements';
import { scopeContains, wideningDimensions } from '@br/authority';
import { compareUnder, sameMark } from '@br/records';
import {
  RANKING_BLOCKERS,
  verificationLevelIndex,
  type AuthorityScope,
  type RankingBlocker,
  type RankingCandidateState,
  type RankingRunTrigger,
} from '@br/domain';
import {
  checkCompetitionRanking,
  hashRankingRunInput,
  hashRankingRunOutcome,
  type RankingBasis,
  type RankingCandidateResult,
  type RankingEntry,
  type RankingRunCandidate,
  type RankingRunInput,
  type RankingRunOutcome,
} from './documents';
import {
  RANKING_ENGINE_VERSION,
  rankingSystemFloor,
  validateRankingSystemSpec,
  type SpecIssue,
} from './system';

/**
 * The pure, deterministic BEST_MARK ranking engine (ADR-0048 §2, §4–6; ADR-0049 §5–7):
 *
 *   evaluateRankingRun(RankingRunInput) → { inputHash, outcome, outcomeHash }
 *
 * No database, network, filesystem, clock, randomness or environment; it writes nothing (no snapshot,
 * no achievement, no read model). It consumes the Step 2 `br:ranking-run-input@1` only, and accounts
 * for EVERY candidate in the outcome:
 *
 *   1. run integrity      the pinned spec re-validates and re-hashes to `specHash`; its DisciplineVersion,
 *                         sport and metric equal the pinned DV facts; the DV declares a comparable order
 *                         equal to the spec's single key. A failure makes every candidate
 *                         INTEGRITY_FAILURE (with the definition codes) and the run BLOCKED.
 *   2. admissibility      per candidate, every gate of ADR-0048 §4.2 (table in BRT-10-RANKING-ENGINE.md);
 *                         anything unavailable fails closed, never defaulted.
 *   3. holder best        per holder, the best admissible value under the pinned comparator; EVERY
 *                         candidate equal to it is pinned on the holder's single entry (no hidden
 *                         choice); strictly worse ones are NOT_HOLDER_BEST.
 *   4. global ranking     competition-style shared ranks: rank = 1 + number of strictly better holders;
 *                         equal values share the rank (1, 1, 3). Asserted with checkCompetitionRanking.
 *   5. publication        PUBLISHABLE unless the run is integrity-failed, ranked nobody
 *                         (NO_RANKED_ENTRIES), the version is not PUBLISHED, or an OFFICIAL owner
 *                         publication act is unavailable (no producer).
 *
 * Candidate state precedence: INTEGRITY_FAILURE > INELIGIBLE > PENDING_REQUIRED_FACTS >
 * NOT_HOLDER_BEST > INCLUDED. Changing ANY semantics requires a new engine version (ranking-engine/2).
 */
export interface RankingRunMeta {
  /** Why the run was requested. Recorded on the persisted run only — NEVER hashed, never in the outcome. */
  readonly trigger?: RankingRunTrigger;
}

export type RankingRunEvaluation =
  | {
      readonly ok: true;
      readonly inputHash: ContentHash;
      readonly outcome: RankingRunOutcome;
      readonly outcomeHash: ContentHash;
      readonly meta: RankingRunMeta;
    }
  | { readonly ok: false; readonly issues: readonly SpecIssue[] };

type Comparable = 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER';
const STATE_RANK: Readonly<Record<RankingCandidateState, number>> = {
  INCLUDED: 0,
  NOT_HOLDER_BEST: 1,
  PENDING_REQUIRED_FACTS: 2,
  INELIGIBLE: 3,
  INTEGRITY_FAILURE: 4,
};
const dedupe = (xs: readonly string[]) => [...new Set(xs)].sort();
const ms = (t: string) => Date.parse(t);
const holderKey = (c: RankingRunCandidate) =>
  c.holder === undefined ? '' : `${c.holder.holderType}:${c.holder.holderId}`;

/** Definition-level contradictions of the run input (the pins disagree with each other). */
function runIntegrity(r: RankingRunInput): { reasons: string[]; order?: Comparable } {
  const spec = r.system.spec;
  const reasons: string[] = [];
  const v = validateRankingSystemSpec(spec);
  if (!v.ok) reasons.push(...v.issues.map((i) => i.code));
  else if (v.specHash !== r.system.specHash) reasons.push('SPEC_HASH_MISMATCH');
  if (r.system.kind !== spec.kind) reasons.push('SPEC_HASH_MISMATCH');
  if (spec.universe.disciplineVersionId !== r.discipline.disciplineVersionId)
    reasons.push('DISCIPLINE_VERSION_MISMATCH');
  if (JSON.stringify(spec.recognition.sport) !== JSON.stringify([r.discipline.sport]))
    reasons.push('RECOGNITION_SPORT_MUST_BE_DISCIPLINE_SPORT');
  if (
    spec.recognition.discipline !== undefined &&
    JSON.stringify(spec.recognition.discipline) !== JSON.stringify([r.discipline.discipline])
  )
    reasons.push('RECOGNITION_DISCIPLINE_MISMATCH');
  const dv = r.discipline.metric;
  if (dv.key !== spec.universe.metric.key) reasons.push('METRIC_UNKNOWN');
  if (dv.order !== 'HIGHER_IS_BETTER' && dv.order !== 'LOWER_IS_BETTER') {
    reasons.push('METRIC_NOT_COMPARABLE');
    return { reasons };
  }
  const key = spec.comparator.keys[0];
  if (key === undefined || key.metric !== dv.key || key.order !== dv.order) {
    reasons.push('COMPARATOR_MISMATCH');
    return { reasons };
  }
  return reasons.length > 0 ? { reasons } : { reasons, order: dv.order };
}

/** Every admissibility gate of one candidate (ADR-0048 §4.2–4.3). Empty ⇒ admissible. */
function candidateBlockers(r: RankingRunInput, c: RankingRunCandidate): RankingBlocker[] {
  const spec = r.system.spec;
  const u = spec.universe;
  const dv = r.discipline.metric;
  const supported = new Set(r.supportedFactKinds);
  const out: RankingBlocker[] = [];

  // holder: the durable public sporting identity, resolved by the assembler — never inferred here.
  if (c.holder === undefined) out.push('HOLDER_UNRESOLVED');
  else if (c.holder.holderType !== u.holderType) out.push('HOLDER_TYPE_NOT_IN_UNIVERSE');
  else if (u.holderType === 'ATHLETE') {
    if (c.performanceAthleteId !== undefined && c.performanceAthleteId !== c.holder.holderId)
      out.push('HOLDER_UNRESOLVED');
  } else if (c.performanceAthleteId !== undefined) out.push('HOLDER_TYPE_NOT_IN_UNIVERSE');

  // result lifecycle: FINAL, current (not superseded / revoked / rejected).
  if (!supported.has('RESULT_STATUS')) out.push('RESULT_STATUS_UNAVAILABLE');
  else if (c.supersededByVersionId !== undefined || c.status === 'SUPERSEDED')
    out.push('RESULT_SUPERSEDED');
  else if (c.status === 'REVOKED') out.push('RESULT_REVOKED');
  else if (c.status === 'REJECTED') out.push('RESULT_REJECTED');
  else if (c.status !== spec.requirements.minimumResultStatus)
    out.push('RESULT_STATUS_BELOW_REQUIRED');

  // Performance + exact metric semantics (DV MetricSpec; no unit / precision coercion).
  if (!c.valid) out.push('PERFORMANCE_INVALID');
  if (c.mark.metricId !== u.metric.markMetricId) out.push('METRIC_MISMATCH');
  if (c.mark.unit !== dv.unit) out.push('METRIC_UNIT_MISMATCH');
  if (!precisionFits(dv.valueType, c.mark.precision)) out.push('METRIC_PRECISION_MISMATCH');

  // sporting time: known, inside [max(window.from, effectiveFrom), window.to), not after asOf.
  if (!supported.has('CONTEST_OCCURRENCE') || c.occurredAt === undefined)
    out.push('OCCURRENCE_TIME_UNKNOWN');
  else {
    const t = ms(c.occurredAt);
    if (
      t < ms(spec.effectiveFrom) ||
      (u.window !== undefined && t < ms(u.window.from)) ||
      (u.window?.to !== undefined && t >= ms(u.window.to))
    )
      out.push('PERFORMANCE_OUTSIDE_WINDOW');
    if (t > ms(r.asOf)) out.push('PERFORMANCE_AFTER_AS_OF');
  }

  // Result → Contest → Event → Competition membership.
  if (
    !supported.has('COMPETITION_MEMBERSHIP') ||
    c.competitionId === undefined ||
    c.eventId === undefined ||
    c.contestId === undefined
  )
    out.push('COMPETITION_MEMBERSHIP_UNAVAILABLE');
  else if (u.competitionIds !== undefined && !u.competitionIds.includes(c.competitionId))
    out.push('OUTSIDE_COMPETITION_SCOPE');

  // declared population: typed facts only; absence is never a default value.
  const facts = supported.has('POPULATION')
    ? new Map((c.population ?? []).map((p) => [p.dimension, p.value]))
    : undefined;
  const declared: [string, string | undefined][] = [
    ['HANDICAP_MODE', u.population.handicapMode],
    ['GENDER_CATEGORY', u.population.genderCategory],
    ['AGE_GROUP', u.population.ageGroup],
    ['WEIGHT_CLASS', u.population.weightClass],
    ['EQUIPMENT_CLASS', u.population.equipmentClass],
  ];
  for (const [dimension, want] of declared) {
    if (want === undefined) continue;
    const got = facts?.get(dimension as never);
    if (got === undefined) out.push('POPULATION_FACT_UNAVAILABLE');
    else if (got !== want) out.push('POPULATION_MISMATCH');
  }

  // hold: absence of hold facts is never "no hold".
  if (!supported.has('HOLD_STATE') || c.hold === undefined) out.push('HOLD_STATE_UNAVAILABLE');
  else if (c.hold.active) out.push('HOLD_ACTIVE');

  // BRT-07 verification: CURRENT (hash-fresh), complete, at or above the effective floor.
  const vs = c.verification;
  if (!supported.has('VERIFICATION')) out.push('VERIFICATION_UNAVAILABLE');
  else if (vs.state === 'STALE') out.push('VERIFICATION_STALE');
  else if (vs.state === 'NOT_EVALUATED') out.push('VERIFICATION_NOT_EVALUATED');
  else if (vs.state === 'POLICY_UNAVAILABLE') out.push('VERIFICATION_POLICY_UNAVAILABLE');
  else if (
    vs.runId === undefined ||
    vs.snapshotHash === undefined ||
    vs.outcomeHash === undefined ||
    vs.level === undefined ||
    vs.evidenceBundleHash === undefined ||
    vs.evaluatedAsOf === undefined
  )
    out.push('VERIFICATION_RUN_INCOMPLETE');
  else if (verificationLevelIndex(vs.level) < verificationLevelIndex(rankingSystemFloor(spec)))
    out.push('VERIFICATION_LEVEL_BELOW_REQUIRED');

  // OFFICIAL: the governing recognition pinned from the basis run must cover the owner's declared
  // scope (ADR-0048 §3; BRT-03 scope algebra). Unknown fails closed; PLATFORM never backs it.
  if (spec.kind === 'OFFICIAL') {
    const g = vs.governingRecognition;
    const rec = spec.recognition;
    if (g === undefined || g.recognitionScope === undefined)
      out.push('GOVERNING_RECOGNITION_UNAVAILABLE');
    else if (g.recognitionLevel === 'PLATFORM') out.push('RECOGNITION_PLATFORM_CANNOT_BACK_CLAIM');
    else {
      const requested = {
        recognitionLevel: [rec.level],
        sport: [...rec.sport],
        discipline: [...(rec.discipline ?? [r.discipline.discipline])],
        ...(rec.region === undefined ? {} : { region: [...rec.region] }),
      } as unknown as AuthorityScope;
      const allowed = g.recognitionScope as unknown as AuthorityScope;
      if (!scopeContains(allowed, requested))
        for (const d of wideningDimensions(allowed, requested))
          out.push(
            `RECOGNITION_${d === 'recognitionLevel' ? 'LEVEL' : d.toUpperCase()}_NOT_COVERED` as RankingBlocker,
          );
      if ((RECOGNITION_RANK[g.recognitionLevel] ?? 0) < (RECOGNITION_RANK[rec.level] ?? 99))
        out.push('RECOGNITION_LEVEL_NOT_COVERED');
    }
  }
  return out;
}

function stateOf(reasons: readonly RankingBlocker[]): RankingCandidateState {
  let state: RankingCandidateState = 'INCLUDED';
  for (const code of reasons) {
    // A code outside the closed vocabulary can only be an engine defect: fail closed as integrity.
    const s =
      (RANKING_BLOCKERS as Readonly<Record<string, RankingCandidateState>>)[code] ??
      'INTEGRITY_FAILURE';
    if (STATE_RANK[s] > STATE_RANK[state]) state = s;
  }
  return state;
}

/** The pinned basis of one admissible candidate (all members proven present by the gates). */
function basisOf(c: RankingRunCandidate): RankingBasis {
  const vs = c.verification;
  const need = <T>(v: T | undefined): T => {
    if (v === undefined) throw new Error('ranking-engine invariant: admissible basis incomplete');
    return v;
  };
  const item: BasisItem = {
    resultVersionId: c.resultVersionId,
    contentHash: c.contentHash,
    resultStatus: c.status,
    verificationRunId: need(vs.runId),
    verificationSnapshotHash: need(vs.snapshotHash),
    verificationOutcomeHash: need(vs.outcomeHash),
    verificationLevel: need(vs.level),
    participantId: c.participantId,
    performanceOrdinal: c.ordinal,
    evidenceBundleHash: need(vs.evidenceBundleHash),
    evidenceBundleAsOf: need(vs.evaluatedAsOf),
  };
  return {
    resultId: c.resultId,
    resultVersionId: c.resultVersionId,
    contentHash: c.contentHash,
    resultStatus: 'FINAL',
    competitionId: need(c.competitionId),
    eventId: need(c.eventId),
    contestId: need(c.contestId),
    participantId: c.participantId,
    performanceOrdinal: c.ordinal,
    ...(c.performanceAthleteId === undefined
      ? {}
      : { performanceAthleteId: c.performanceAthleteId }),
    verificationRunId: item.verificationRunId,
    verificationSnapshotHash: item.verificationSnapshotHash,
    verificationOutcomeHash: item.verificationOutcomeHash,
    verificationLevel: item.verificationLevel,
    evidenceBundleHash: item.evidenceBundleHash,
    evidenceBundleAsOf: item.evidenceBundleAsOf,
    evidenceCommitment: evidenceCommitmentOf([item]),
    ...(vs.governingRecognition === undefined
      ? {}
      : { governingRecognition: vs.governingRecognition }),
    hold: 'ABSENT',
    occurredAt: need(c.occurredAt),
  };
}

/** Evaluates one ranking run. Pure and deterministic; `meta` never influences the outcome. */
export function evaluateRankingRun(
  input: unknown,
  meta: RankingRunMeta = {},
): RankingRunEvaluation {
  const sealed = hashRankingRunInput(input);
  if (!sealed.ok) return { ok: false, issues: sealed.issues };
  const r = sealed.value;
  const spec = r.system.spec;
  const integrity = runIntegrity(r);
  const order = integrity.order;

  // ── 1–2. run integrity + per-candidate admissibility.
  const results = new Map<
    RankingRunCandidate,
    { state: RankingCandidateState; reasons: string[] }
  >();
  const admissible: RankingRunCandidate[] = [];
  for (const c of r.candidates) {
    if (integrity.reasons.length > 0) {
      results.set(c, { state: 'INTEGRITY_FAILURE', reasons: dedupe(integrity.reasons) });
      continue;
    }
    const reasons = candidateBlockers(r, c);
    const state = stateOf(reasons);
    results.set(c, { state, reasons: dedupe(reasons) });
    if (state === 'INCLUDED') admissible.push(c);
  }

  // ── 3. holder best: all candidates equal to the holder's best value are kept; none is chosen.
  const entries: Omit<RankingEntry, 'rank' | 'tied'>[] = [];
  if (order !== undefined) {
    const byHolder = new Map<string, RankingRunCandidate[]>();
    for (const c of admissible)
      byHolder.set(holderKey(c), [...(byHolder.get(holderKey(c)) ?? []), c]);
    for (const group of byHolder.values()) {
      const best = group.reduce((b, c) =>
        compareUnder(order, c.mark.value, b.mark.value) > 0 ? c : b,
      );
      const bestSet = group.filter((c) => compareUnder(order, c.mark.value, best.mark.value) === 0);
      for (const c of group)
        if (!bestSet.includes(c))
          results.set(c, { state: 'NOT_HOLDER_BEST', reasons: ['NOT_HOLDER_BEST'] });
      // Equal values in different canonical spellings (precision) cannot yield ONE byte-equal entry
      // value without choosing between them, so the holder is not ranked (fail closed, no choice).
      if (bestSet.some((c) => !sameMark(c.mark, best.mark))) {
        for (const c of bestSet)
          results.set(c, { state: 'INELIGIBLE', reasons: ['METRIC_PRECISION_MISMATCH'] });
        continue;
      }
      const holder = best.holder;
      if (holder === undefined) throw new Error('ranking-engine invariant: admissible holder');
      entries.push({
        holder,
        value: best.mark,
        comparatorTrace: [{ key: spec.universe.metric.key, order, value: best.mark.value }],
        basis: bestSet.map(basisOf),
      });
    }
  }

  // ── 4. competition-style shared ranks; no identifier / order of appearance ever breaks a tie.
  const ranked: RankingEntry[] =
    order === undefined
      ? []
      : entries.map((e) => {
          const better = entries.filter(
            (o) => compareUnder(order, o.value.value, e.value.value) > 0,
          ).length;
          const equal = entries.filter(
            (o) => compareUnder(order, o.value.value, e.value.value) === 0,
          ).length;
          return { ...e, rank: better + 1, tied: equal > 1 };
        });
  if (order !== undefined) {
    const issues = checkCompetitionRanking(ranked, order);
    if (issues.length > 0)
      throw new Error(`ranking-engine invariant: ${issues.map((i) => i.code).join(',')}`);
  }

  // ── 5. publication gates (ADR-0048 §5–6). The platform never publishes on an owner's behalf.
  const publication: string[] = [...integrity.reasons];
  if (r.system.lifecycle === 'DRAFT') publication.push('SYSTEM_VERSION_NOT_PUBLISHED');
  if (r.system.lifecycle === 'RETIRED') publication.push('SYSTEM_VERSION_RETIRED');
  // A RankingSnapshot always ranks someone: an empty run is never publishable (run-level only).
  if (ranked.length === 0) publication.push('NO_RANKED_ENTRIES');
  if (
    spec.kind === 'OFFICIAL' &&
    (!r.supportedFactKinds.includes('RANKING_PUBLICATION') ||
      r.publication === undefined ||
      r.publication.ownerPrincipalId !== spec.owner?.principalId)
  )
    publication.push('OWNER_PUBLICATION_UNAVAILABLE');

  const candidates: RankingCandidateResult[] = r.candidates.map((c) => {
    const res = results.get(c) ?? { state: 'INTEGRITY_FAILURE' as const, reasons: [] };
    return {
      resultVersionId: c.resultVersionId,
      participantId: c.participantId,
      ordinal: c.ordinal,
      state: res.state,
      reasons: res.reasons,
    };
  });
  const outcome: RankingRunOutcome = {
    engineVersion: RANKING_ENGINE_VERSION,
    provenance: r.provenance,
    inputHash: sealed.hash,
    systemVersionId: r.system.systemVersionId,
    specHash: r.system.specHash,
    asOf: r.asOf,
    publication: {
      state: publication.length > 0 ? 'BLOCKED' : 'PUBLISHABLE',
      reasons: dedupe(publication),
    },
    entries: ranked,
    candidates,
  };
  const o = hashRankingRunOutcome(outcome);
  if (!o.ok)
    throw new Error(
      `ranking-engine invariant: outcome not canonical (${o.issues[0]?.code ?? '?'})`,
    );
  return { ok: true, inputHash: sealed.hash, outcome: o.value, outcomeHash: o.hash, meta };
}

/** Excluded candidates with their blockers (everything not INCLUDED), for audit / explanations. */
export function excludedCandidates(outcome: RankingRunOutcome): readonly RankingCandidateResult[] {
  return outcome.candidates.filter((c) => c.state !== 'INCLUDED');
}
