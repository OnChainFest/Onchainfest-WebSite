import { CanonicalError, type ContentHash } from '@br/canonical';
import {
  compareDecimal,
  type GoverningRecognition,
  type VerificationSummary,
} from '@br/achievements';
import type { ComparatorOrder, MetricValueType } from '@br/competition';
import {
  RANKING_PLATFORM_FLOOR,
  verificationLevelIndex,
  type HolderType,
  type Mark,
  type PopulationDimension,
  type RankingCandidateState,
  type RankingDefinitionLifecycle,
  type RankingFactKind,
  type RankingMethod,
  type RankingProvenance,
  type RankingPublicationState,
  type RankingRunTrigger,
  type RankingSnapshotLineageKind,
  type RankingSystemKind,
  type ResultVersionStatus,
  type VerificationLevel,
} from '@br/domain';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';
import type { RankingSystemSpec, SpecIssue } from './system';

/**
 * BRT-10 ranking documents (ADR-0048). Three distinct things, deliberately named apart:
 *
 *   RankingRunInput     the pure engine's ONLY input (`br:ranking-run-input@1`) — NOT a snapshot
 *   RankingRunOutcome   its deterministic output: every candidate accounted for + ordered entries
 *   RankingSnapshot     the published, immutable artefact (`br:ranking-snapshot@1`) — NOT a Result:
 *                       it has no lifecycle status and asserts no sporting outcome
 *
 * Persisted run / snapshot records add only persistence attributes (ids, trigger, recorded time) that
 * are never part of the hashed content, so equal semantic inputs always hash identically.
 */
export type Timestamp = string;
export interface Holder {
  readonly holderType: HolderType;
  readonly holderId: string;
}

/** One comparator value, in comparator order (BRT-01 §6.2 tieBreakKeys). */
export interface ComparatorTraceItem {
  readonly key: string;
  readonly order: ComparatorOrder;
  readonly value: string;
}

/** The verified immutable Performance basis of one ranked mark (ADR-0044 / ADR-0048 §4.2). */
export interface RankingBasis {
  readonly resultId: string;
  readonly resultVersionId: string;
  readonly contentHash: string;
  readonly resultStatus: 'FINAL';
  readonly competitionId: string;
  readonly eventId: string;
  readonly contestId: string;
  readonly participantId: string;
  readonly performanceOrdinal: number;
  readonly performanceAthleteId?: string;
  readonly verificationRunId: string;
  readonly verificationSnapshotHash: string;
  readonly verificationOutcomeHash: string;
  readonly verificationLevel: VerificationLevel;
  readonly evidenceBundleHash: string;
  readonly evidenceBundleAsOf: Timestamp;
  readonly evidenceCommitment: string;
  readonly governingRecognition?: GoverningRecognition;
  /** Hold state was KNOWN and absent (never assumed). */
  readonly hold: 'ABSENT';
  readonly occurredAt: Timestamp;
}

/** A holder's rank inside ONE immutable snapshot. Never stored on an athlete / passport row. */
export interface RankingEntry {
  readonly rank: number;
  readonly tied: boolean;
  readonly holder: Holder;
  /** Byte-equal to the canonical Performance Mark. */
  readonly value: Mark;
  readonly comparatorTrace: readonly ComparatorTraceItem[];
  /** Every Performance achieving the holder's best value (no hidden choice between equal marks). */
  readonly basis: readonly RankingBasis[];
}

/** One candidate Performance with the canonical facts the engine gates on. */
export interface RankingRunCandidate {
  readonly resultId: string;
  readonly resultVersionId: string;
  readonly contentHash: string;
  /** CONTEST only (schema): a classification ResultVersion is never a BEST_MARK candidate. */
  readonly scopeType: 'CONTEST';
  readonly status: Exclude<ResultVersionStatus, 'DRAFT'>;
  readonly supersededByVersionId?: string;
  readonly competitionId?: string;
  readonly eventId?: string;
  readonly contestId?: string;
  readonly participantId: string;
  readonly holder?: Holder;
  readonly performanceAthleteId?: string;
  readonly ordinal: number;
  readonly mark: Mark;
  readonly valid: boolean;
  readonly occurredAt?: Timestamp;
  readonly verification: VerificationSummary;
  /** Absent ⇒ HOLD_STATE_UNAVAILABLE (never "no hold"). */
  readonly hold?: { readonly active: boolean };
  readonly population?: readonly {
    readonly dimension: PopulationDimension;
    readonly value: string;
  }[];
}

export interface RankingRunInput {
  readonly provenance: RankingProvenance;
  readonly assembler: string;
  readonly supportedFactKinds: readonly RankingFactKind[];
  readonly system: {
    readonly systemId: string;
    readonly code: string;
    readonly kind: RankingSystemKind;
    readonly systemVersionId: string;
    readonly version: number;
    readonly specHash: string;
    readonly spec: RankingSystemSpec;
    readonly lifecycle: RankingDefinitionLifecycle;
  };
  readonly discipline: {
    readonly disciplineVersionId: string;
    readonly sport: string;
    readonly discipline: string;
    /** The DV MetricSpec of the universe metric + the order its comparator declares (if any). */
    readonly metric: {
      readonly key: string;
      readonly valueType: MetricValueType;
      readonly unit: string;
      readonly order?: ComparatorOrder;
    };
  };
  /** Sporting cutoff. */
  readonly asOf: Timestamp;
  readonly candidates: readonly RankingRunCandidate[];
  /** OFFICIAL owner publication act — NO producer; never present canonically. */
  readonly publication?: {
    readonly provenance: 'REFERENCE_FIXTURE';
    readonly ref: string;
    readonly ownerPrincipalId: string;
  };
}

export interface RankingCandidateResult {
  readonly resultVersionId: string;
  readonly participantId: string;
  readonly ordinal: number;
  readonly state: RankingCandidateState;
  readonly reasons: readonly string[];
}

export interface RankingRunOutcome {
  readonly engineVersion: string;
  readonly provenance: RankingProvenance;
  readonly inputHash: string;
  readonly systemVersionId: string;
  readonly specHash: string;
  readonly asOf: Timestamp;
  readonly publication: {
    readonly state: RankingPublicationState;
    readonly reasons: readonly string[];
  };
  readonly entries: readonly RankingEntry[];
  readonly candidates: readonly RankingCandidateResult[];
}

/** The published snapshot content. No `status`: a snapshot has no Result lifecycle. */
export interface RankingSnapshotContent {
  readonly systemId: string;
  readonly systemVersionId: string;
  readonly specHash: string;
  readonly kind: RankingSystemKind;
  readonly method: RankingMethod;
  readonly engineVersion: string;
  readonly provenance: RankingProvenance;
  readonly runInputHash: string;
  readonly runOutcomeHash: string;
  readonly asOf: Timestamp;
  readonly lineage: {
    readonly kind: RankingSnapshotLineageKind;
    readonly priorSnapshotId?: string;
    readonly priorSnapshotHash?: string;
    readonly reasons?: readonly string[];
  };
  readonly entries: readonly RankingEntry[];
}

/** Persistence-agnostic shapes of the stored facts (tables arrive in Step 5). */
export interface RankingRunRecord {
  readonly runId: string;
  readonly systemVersionId: string;
  readonly inputHash: string;
  readonly outcomeHash: string;
  readonly trigger: RankingRunTrigger;
  readonly provenance: RankingProvenance;
  readonly recordedAt: Timestamp;
}
export interface RankingSnapshotRecord {
  readonly snapshotId: string;
  readonly runId: string;
  readonly snapshotHash: string;
  readonly content: RankingSnapshotContent;
  readonly publishedAt: Timestamp;
}

type Hashed<T> =
  | { readonly ok: true; readonly value: T; readonly hash: ContentHash }
  | {
      readonly ok: false;
      readonly issues: readonly SpecIssue[];
    };

function hashDoc<T>(
  tag: string,
  ref: { readonly id: string; readonly version: number },
  input: unknown,
): Hashed<T> {
  try {
    const r = platformCanonicalizer().hashCanonical(tag, ref.id, ref.version, input);
    return { ok: true, value: r.normalized as unknown as T, hash: r.contentHash };
  } catch (err) {
    if (err instanceof CanonicalError)
      return { ok: false, issues: [{ path: err.path || '/', code: err.code }] };
    throw err;
  }
}

/** H(ranking-run-input, …) — the run's inputs digest; schema-closed. */
export const hashRankingRunInput = (input: unknown) =>
  hashDoc<RankingRunInput>(DomainTag.rankingRunInput, SchemaRef.rankingRunInput, input);

/** H(ranking-run-outcome, …). */
export const hashRankingRunOutcome = (input: unknown) =>
  hashDoc<RankingRunOutcome>(DomainTag.rankingRunOutcome, SchemaRef.rankingRunOutcome, input);

/**
 * Competition-style shared ranks (ADR-0049 §5), checked against a total preorder `compare` (> 0: the
 * first item is strictly better): ranks start at 1; a group of k equal items shares rank r and the
 * next group is r + k; `tied` iff the group has more than one item; a strictly better item never has a
 * worse rank; items equal under `compare` never have different ranks (that would be a hidden
 * tie-break). No identifier, name or order of appearance ever breaks a tie. Used by the snapshot
 * validator and asserted on every engine output (ranking and classification).
 */
export function checkSharedRanks<T extends { readonly rank: number; readonly tied: boolean }>(
  items: readonly T[],
  compare: (a: T, b: T) => number,
): readonly SpecIssue[] {
  const issues: SpecIssue[] = [];
  const byRank = new Map<number, T[]>();
  for (const e of items) byRank.set(e.rank, [...(byRank.get(e.rank) ?? []), e]);
  let expected = 1;
  for (const r of [...byRank.keys()].sort((a, b) => a - b)) {
    const group = byRank.get(r) ?? [];
    if (r !== expected) issues.push({ path: `/entries/rank/${r}`, code: 'RANK_SEQUENCE_INVALID' });
    const first = group[0];
    if (first !== undefined && group.some((e) => compare(e, first) !== 0))
      issues.push({ path: `/entries/rank/${r}`, code: 'RANK_GROUP_VALUES_DIFFER' });
    if (group.some((e) => e.tied !== group.length > 1))
      issues.push({ path: `/entries/rank/${r}`, code: 'TIED_FLAG_INCONSISTENT' });
    expected = r + group.length;
  }
  for (const a of items)
    for (const b of items) {
      const c = compare(a, b);
      if (c > 0 && !(a.rank < b.rank)) {
        issues.push({ path: `/entries/rank/${a.rank}`, code: 'RANK_ORDER_CONTRADICTS_VALUES' });
        return issues;
      }
      // Equal on every key MUST share the rank: anything else is a hidden tie-break.
      if (c === 0 && a.rank !== b.rank) {
        issues.push({ path: `/entries/rank/${a.rank}`, code: 'HIDDEN_TIE_BREAK' });
        return issues;
      }
    }
  return issues;
}

/** Shared competition-style ranks of single-value entries under one comparable order. */
export function checkCompetitionRanking(
  entries: readonly Pick<RankingEntry, 'rank' | 'tied' | 'value'>[],
  order: ComparatorOrder,
): readonly SpecIssue[] {
  if (order !== 'HIGHER_IS_BETTER' && order !== 'LOWER_IS_BETTER')
    return [{ path: '/entries', code: 'COMPARATOR_UNDEFINED' }];
  const sign = order === 'HIGHER_IS_BETTER' ? 1 : -1;
  return checkSharedRanks(entries, (a, b) => sign * compareDecimal(a.value.value, b.value.value));
}

/**
 * Validates published snapshot content: closed schema (a lifecycle `status` or any unknown member is
 * refused), lineage coherence, entry/trace coherence, basis floors and competition-style ranks.
 */
export function validateRankingSnapshot(input: unknown): Hashed<RankingSnapshotContent> {
  const r = hashDoc<RankingSnapshotContent>(
    DomainTag.rankingSnapshot,
    SchemaRef.rankingSnapshot,
    input,
  );
  if (!r.ok) return r;
  const s = r.value;
  const issues: SpecIssue[] = [];
  const l = s.lineage;
  const hasPrior = l.priorSnapshotId !== undefined && l.priorSnapshotHash !== undefined;
  const anyPrior = l.priorSnapshotId !== undefined || l.priorSnapshotHash !== undefined;
  if (l.kind === 'INITIAL' && (anyPrior || l.reasons !== undefined))
    issues.push({ path: '/lineage', code: 'LINEAGE_INITIAL_HAS_NO_PRIOR' });
  if (l.kind !== 'INITIAL' && !hasPrior)
    issues.push({ path: '/lineage', code: 'LINEAGE_PRIOR_REQUIRED' });
  if (l.kind === 'CORRECTS' && (l.reasons ?? []).length === 0)
    issues.push({ path: '/lineage/reasons', code: 'CORRECTION_REASONS_REQUIRED' });
  if (l.kind === 'FOLLOWS' && l.reasons !== undefined)
    issues.push({ path: '/lineage/reasons', code: 'LINEAGE_FOLLOWS_HAS_NO_REASONS' });

  const floor = RANKING_PLATFORM_FLOOR[s.kind].minimumVerificationLevel;
  const orders = new Set<ComparatorOrder>();
  s.entries.forEach((e, i) => {
    const t = e.comparatorTrace[0];
    // The trace value is a canonical decimal (trailing zeros dropped); the Mark keeps its precision.
    if (
      t === undefined ||
      e.comparatorTrace.length !== 1 ||
      compareDecimal(t.value, e.value.value) !== 0
    )
      issues.push({ path: `/entries/${i}/comparatorTrace`, code: 'TRACE_VALUE_MISMATCH' });
    else orders.add(t.order);
    if (
      e.basis.some(
        (b) => verificationLevelIndex(b.verificationLevel) < verificationLevelIndex(floor),
      )
    )
      issues.push({ path: `/entries/${i}/basis`, code: 'VERIFICATION_LEVEL_BELOW_REQUIRED' });
  });
  if (orders.size > 1) issues.push({ path: '/entries', code: 'COMPARATOR_MISMATCH' });
  const metricIds = new Set(s.entries.map((e) => e.value.metricId));
  if (metricIds.size > 1) issues.push({ path: '/entries', code: 'METRIC_MISMATCH' });
  const [order] = [...orders];
  if (order !== undefined && issues.length === 0)
    issues.push(...checkCompetitionRanking(s.entries, order));
  return issues.length > 0 ? { ok: false, issues } : r;
}
