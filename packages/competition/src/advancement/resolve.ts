import type { ResultOutcome } from '@br/domain';
import type { NormalizedContestResult } from '../scoring';
import type { AdvancementFamily, AdvancementPolicySpec, CrossGroupKey } from './policy';

/**
 * ONCF-05D advancement engine (pure, deterministic, sport-neutral — ADR-0065).
 *
 * Input: ONE advancement unit — the evidence that decides a set of dependent targets — plus the
 * pinned policy. Output: one assignment per target, each with its state and structured provenance
 * (which result version / classification hash / heat place / cross-group comparison put that
 * entrant there, under which family). Persistence assembles units from the immutable plan, the
 * ResultLedger and classification-engine/2, and records committed assignments as append-only facts.
 *
 * Units:
 *   CONTEST  — WINNER_OF_CONTEST / LOSER_OF_CONTEST slots fed by one contest
 *   RANK     — RANK_FROM_STAGE slots fed by one stage (or one group of it)
 *   BEST     — BEST_RANKED_FROM_STAGE slots (k-th best rank-r entrant across the stage's groups)
 *   FIELD    — the ordered field selected by a transition (heats → final, cut, finishers only)
 *
 * Never: a hidden tie-break, an entrant twice, an unofficial (below-policy) result, a guess.
 */

export type AdvancementTarget =
  | { readonly kind: 'SLOT'; readonly contestId: string; readonly slot: number }
  | { readonly kind: 'FIELD'; readonly transitionKey: string; readonly ordinal: number };

/** RESOLVED (an entrant) · VACANT (decided: nobody) · PENDING (evidence missing) · HELD (tie). */
export type AssignmentState = 'RESOLVED' | 'VACANT' | 'PENDING' | 'HELD';

export interface AdvancementProvenance {
  readonly family: AdvancementFamily;
  readonly source: {
    readonly kind: string;
    readonly contestId?: string;
    readonly stageKey?: string;
    readonly groupKey?: string;
    readonly rank?: number;
    readonly ordinal?: number;
    readonly transitionKey?: string;
  };
  readonly result?: {
    readonly contestId: string;
    readonly resultVersionId: string;
    readonly contentHash: string;
    readonly status: string;
    readonly outcome: string;
    readonly opponentId?: string;
  };
  readonly classification?: {
    readonly stageKey: string;
    readonly groupKey?: string;
    readonly throughRound?: number;
    readonly hash: string;
    readonly position?: number;
    readonly tied?: boolean;
  };
  readonly heat?: { readonly contestId: string; readonly place: number };
  /** Cross-group candidates in decided order, with the values compared. */
  readonly comparison?: readonly {
    readonly participantId: string;
    readonly groupKey: string;
    readonly values: readonly { readonly key: string; readonly value: string }[];
  }[];
  /** Entrants tied for this target (HELD), or the tie the better seed broke (decidedBy SEED). */
  readonly candidates?: readonly string[];
  readonly decidedBy?: 'SEED';
}

export interface AdvancementAssignment {
  readonly target: AdvancementTarget;
  readonly state: AssignmentState;
  readonly participantId?: string;
  readonly reason?: string;
  readonly provenance: AdvancementProvenance;
}

export interface EntrantEligibility {
  readonly status: string;
  /** Seed number (1 = best) when the field was seeded. */
  readonly seed?: number;
}

export interface ClassificationEvidence {
  readonly stageKey: string;
  readonly groupKey?: string;
  readonly throughRound?: number;
  readonly hash: string;
  readonly document: {
    readonly complete: boolean;
    readonly entries: readonly {
      readonly participantId: string;
      readonly position: number;
      readonly tied: boolean;
      readonly status: string;
      readonly values: readonly { readonly key: string; readonly value: string }[];
    }[];
  };
}

export interface ContestEvidence {
  readonly resultVersionId: string;
  readonly contentHash: string;
  readonly status: string;
  readonly result: NormalizedContestResult;
}

export type AdvancementUnit =
  | {
      readonly kind: 'CONTEST';
      readonly contestId: string;
      readonly contestStatus: string;
      /** Current occupants of the source contest (null: unresolved slot). */
      readonly occupants: readonly (string | null)[];
      /** A slot of the source contest is stale (its own source changed after it was resolved). */
      readonly upstreamStale: boolean;
      readonly evidence?: ContestEvidence;
      /** Status of the current version when it is below the policy's minimum (not consumed). */
      readonly belowPolicyStatus?: string;
      readonly targets: readonly {
        readonly target: AdvancementTarget;
        readonly family: 'DIRECT_WINNER' | 'DIRECT_LOSER';
      }[];
    }
  | {
      readonly kind: 'RANK';
      readonly stageKey: string;
      readonly groupKey?: string;
      readonly multiRound: boolean;
      readonly classification?: ClassificationEvidence;
      readonly pendingReason?: string;
      readonly targets: readonly { readonly target: AdvancementTarget; readonly rank: number }[];
    }
  | {
      readonly kind: 'BEST';
      readonly stageKey: string;
      readonly rank: number;
      readonly groups: readonly {
        readonly groupKey: string;
        readonly classification?: ClassificationEvidence;
        readonly pendingReason?: string;
      }[];
      readonly targets: readonly { readonly target: AdvancementTarget; readonly ordinal: number }[];
    }
  | {
      readonly kind: 'FIELD';
      readonly transition: {
        readonly key: string;
        readonly kind: string;
        readonly params: Readonly<Record<string, number | boolean>>;
      };
      readonly classification?: ClassificationEvidence;
      readonly pendingReason?: string;
      /** Heats → final: contest → its entrants (heat membership). */
      readonly heats?: readonly {
        readonly contestId: string;
        readonly members: readonly string[];
      }[];
      /** Heats → final: the number of final places (the plan's QUALIFIER slots). */
      readonly capacity?: number;
      /** Ordinals already recorded for this field (a smaller new field vacates the excess). */
      readonly recordedOrdinals: number;
    };

export interface AdvancementResolution {
  readonly families: readonly AdvancementFamily[];
  readonly assignments: readonly AdvancementAssignment[];
  /** Every target RESOLVED or VACANT. */
  readonly complete: boolean;
}

const WIN: readonly ResultOutcome[] = ['WIN', 'WALKOVER_WIN'];
const CANCELLED = new Set(['CANCELLED', 'VOID']);

interface Ranked {
  readonly participantId: string;
  readonly position: number;
  readonly values: readonly { readonly key: string; readonly value: string }[];
  readonly tied: boolean;
}

type Pick =
  | {
      readonly state: 'RESOLVED';
      readonly entrant: Ranked;
      readonly seedBroken?: readonly string[];
    }
  | { readonly state: 'VACANT'; readonly reason: string; readonly entrant?: Ranked }
  | { readonly state: 'HELD'; readonly candidates: readonly string[] };

export function resolveAdvancementUnit(
  policy: AdvancementPolicySpec,
  entrants: Readonly<Record<string, EntrantEligibility>>,
  unit: AdvancementUnit,
): AdvancementResolution {
  const ctx = new Ctx(policy, entrants);
  const assignments =
    unit.kind === 'CONTEST'
      ? ctx.contest(unit)
      : unit.kind === 'RANK'
        ? ctx.rank(unit)
        : unit.kind === 'BEST'
          ? ctx.best(unit)
          : ctx.field(unit);
  return {
    families: [...new Set(assignments.map((a) => a.provenance.family))].sort(),
    assignments,
    complete: assignments.every((a) => a.state === 'RESOLVED' || a.state === 'VACANT'),
  };
}

class Ctx {
  private readonly policy: AdvancementPolicySpec;
  private readonly entrants: Readonly<Record<string, EntrantEligibility>>;

  constructor(
    policy: AdvancementPolicySpec,
    entrants: Readonly<Record<string, EntrantEligibility>>,
  ) {
    this.policy = policy;
    this.entrants = entrants;
  }

  private eligible(id: string): boolean {
    return this.entrants[id]?.status === 'ACTIVE';
  }

  private seed(id: string): number {
    return this.entrants[id]?.seed ?? Number.MAX_SAFE_INTEGER;
  }

  /** Better seed first, then participant id: a total, data-independent order inside a tie. */
  private bySeed = (a: Ranked, b: Ranked) =>
    this.seed(a.participantId) - this.seed(b.participantId) ||
    (a.participantId < b.participantId ? -1 : a.participantId > b.participantId ? 1 : 0);

  /** Finishers in classification order (non-finishers never advance). */
  private finishers(c: ClassificationEvidence): Ranked[] {
    return c.document.entries
      .filter((e) => e.status === 'CLASSIFIED')
      .map((e) => ({
        participantId: e.participantId,
        position: e.position,
        values: e.values,
        tied: e.tied,
      }))
      .sort((a, b) => a.position - b.position || this.bySeed(a, b));
  }

  /** NEXT_BEST: ineligible entrants are skipped before picking; VACATE: picked, then vacated. */
  private pool(list: readonly Ranked[]): Ranked[] {
    return this.policy.withdrawn === 'NEXT_BEST'
      ? list.filter((e) => this.eligible(e.participantId))
      : [...list];
  }

  /** The tie block (equal `key`) that contains index i of `list`. */
  private static block<T>(list: readonly T[], i: number, key: (x: T) => string | number) {
    let from = i;
    let to = i;
    const k = key(list[i] as T);
    while (from > 0 && key(list[from - 1] as T) === k) from -= 1;
    while (to < list.length - 1 && key(list[to + 1] as T) === k) to += 1;
    return { from, to };
  }

  /** The entrant at 1-based place `n` of an ordered list, honouring ties and the policy. */
  private pickAt(list: readonly Ranked[], n: number, key: (x: Ranked) => string | number): Pick {
    if (n > list.length) return { state: 'VACANT', reason: 'NO_ENTRANT_AT_PLACE' };
    const { from, to } = Ctx.block(list, n - 1, key);
    let entrant = list[n - 1] as Ranked;
    let seedBroken: string[] | undefined;
    if (to > from) {
      const block = list.slice(from, to + 1);
      if (this.policy.boundaryTies === 'HOLD')
        return { state: 'HELD', candidates: block.map((e) => e.participantId).sort() };
      const ordered = [...block].sort(this.bySeed);
      entrant = ordered[n - 1 - from] as Ranked;
      seedBroken = block.map((e) => e.participantId).sort();
    }
    if (!this.eligible(entrant.participantId))
      return { state: 'VACANT', reason: 'ENTRANT_WITHDRAWN', entrant };
    return { state: 'RESOLVED', entrant, ...(seedBroken === undefined ? {} : { seedBroken }) };
  }

  private fromPick(
    target: AdvancementTarget,
    pick: Pick,
    provenance: (e?: Ranked) => AdvancementProvenance,
  ): AdvancementAssignment {
    if (pick.state === 'HELD')
      return {
        target,
        state: 'HELD',
        reason: 'TIE_AT_BOUNDARY',
        provenance: { ...provenance(), candidates: pick.candidates },
      };
    if (pick.state === 'VACANT')
      return { target, state: 'VACANT', reason: pick.reason, provenance: provenance(pick.entrant) };
    return {
      target,
      state: 'RESOLVED',
      participantId: pick.entrant.participantId,
      provenance: {
        ...provenance(pick.entrant),
        ...(pick.seedBroken === undefined
          ? {}
          : { candidates: pick.seedBroken, decidedBy: 'SEED' as const }),
      },
    };
  }

  private static classificationRef(c: ClassificationEvidence, e?: Ranked) {
    return {
      stageKey: c.stageKey,
      ...(c.groupKey === undefined ? {} : { groupKey: c.groupKey }),
      ...(c.throughRound === undefined ? {} : { throughRound: c.throughRound }),
      hash: c.hash,
      ...(e === undefined ? {} : { position: e.position, tied: e.tied }),
    };
  }

  // ── CONTEST: winner / loser ──
  contest(u: Extract<AdvancementUnit, { kind: 'CONTEST' }>): AdvancementAssignment[] {
    const pending = (reason: string) =>
      u.targets.map((t) => ({
        target: t.target,
        state: 'PENDING' as const,
        reason,
        provenance: {
          family: t.family,
          source: { kind: sourceKind(t.family), contestId: u.contestId },
        },
      }));
    if (CANCELLED.has(u.contestStatus)) return pending('SOURCE_CANCELLED');
    if (u.upstreamStale) return pending('UPSTREAM_STALE');
    if (u.evidence === undefined)
      return pending(u.belowPolicyStatus === undefined ? 'RESULT_MISSING' : 'RESULT_NOT_OFFICIAL');
    const ev = u.evidence;
    const occupants = u.occupants.flatMap((o) => (o === null ? [] : [o])).sort();
    const inResult = ev.result.entries.map((e) => e.participantId).sort();
    if (occupants.length !== u.occupants.length || occupants.join() !== inResult.join())
      return pending('SOURCE_OCCUPANTS_CHANGED');
    const winner = ev.result.entries.find((e) => WIN.includes(e.outcome));
    const loser = ev.result.entries.find((e) => e !== winner);
    if (winner === undefined || loser === undefined || ev.result.entries.length !== 2)
      return pending('NO_WINNER');
    return u.targets.map((t) => {
      const e = t.family === 'DIRECT_WINNER' ? winner : loser;
      const provenance: AdvancementProvenance = {
        family: t.family,
        source: { kind: sourceKind(t.family), contestId: u.contestId },
        result: {
          contestId: u.contestId,
          resultVersionId: ev.resultVersionId,
          contentHash: ev.contentHash,
          status: ev.status,
          outcome: e.outcome,
          ...(e.opponentId === undefined ? {} : { opponentId: e.opponentId }),
        },
      };
      // A direct slot is never back-filled: the source contest decided exactly this entrant.
      return this.eligible(e.participantId)
        ? {
            target: t.target,
            state: 'RESOLVED' as const,
            participantId: e.participantId,
            provenance,
          }
        : { target: t.target, state: 'VACANT' as const, reason: 'ENTRANT_WITHDRAWN', provenance };
    });
  }

  // ── RANK: rank r of a stage / group ──
  rank(u: Extract<AdvancementUnit, { kind: 'RANK' }>): AdvancementAssignment[] {
    const family: AdvancementFamily =
      u.groupKey !== undefined ? 'GROUP_RANK' : u.multiRound ? 'STAGE_TOTAL' : 'TOP_N';
    const source = (rank: number) => ({
      kind: 'RANK_FROM_STAGE',
      stageKey: u.stageKey,
      ...(u.groupKey === undefined ? {} : { groupKey: u.groupKey }),
      rank,
    });
    const c = u.classification;
    if (c === undefined || !c.document.complete)
      return u.targets.map((t) => ({
        target: t.target,
        state: 'PENDING' as const,
        reason:
          c === undefined
            ? (u.pendingReason ?? 'CLASSIFICATION_UNAVAILABLE')
            : 'CLASSIFICATION_INCOMPLETE',
        provenance: { family, source: source(t.rank) },
      }));
    const list = this.pool(this.finishers(c));
    return u.targets.map((t) =>
      this.fromPick(
        t.target,
        this.pickAt(list, t.rank, (e) => e.position),
        (e) => ({
          family,
          source: source(t.rank),
          classification: Ctx.classificationRef(c, e),
        }),
      ),
    );
  }

  // ── BEST: k-th best rank-r entrant across groups ──
  best(u: Extract<AdvancementUnit, { kind: 'BEST' }>): AdvancementAssignment[] {
    const family: AdvancementFamily = 'BEST_N_ACROSS_GROUPS';
    const source = (ordinal: number) => ({
      kind: 'BEST_RANKED_FROM_STAGE',
      stageKey: u.stageKey,
      rank: u.rank,
      ordinal,
    });
    const pending = (reason: string, extra: Partial<AdvancementProvenance> = {}) =>
      u.targets.map((t) => ({
        target: t.target,
        state: reason === 'TIE_AT_BOUNDARY' ? ('HELD' as const) : ('PENDING' as const),
        reason,
        provenance: { family, source: source(t.ordinal), ...extra },
      }));
    if (this.policy.crossGroupOrder.length === 0) return pending('CROSS_GROUP_ORDER_MISSING');
    const candidates: (Ranked & { groupKey: string })[] = [];
    for (const g of [...u.groups].sort((a, b) => (a.groupKey < b.groupKey ? -1 : 1))) {
      const c = g.classification;
      if (c === undefined) return pending(g.pendingReason ?? 'CLASSIFICATION_UNAVAILABLE');
      if (!c.document.complete) return pending('CLASSIFICATION_INCOMPLETE');
      const list = this.pool(this.finishers(c));
      if (list.length < u.rank) continue;
      const pick = this.pickAt(list, u.rank, (e) => e.position);
      // A group whose rank-r place is itself tied cannot name its rank-r entrant.
      if (pick.state === 'HELD') return pending('TIE_AT_BOUNDARY', { candidates: pick.candidates });
      if (pick.entrant !== undefined) candidates.push({ ...pick.entrant, groupKey: g.groupKey });
    }
    const keyOf = (e: Ranked) => crossGroupKey(this.policy.crossGroupOrder, e.values);
    if (candidates.some((e) => keyOf(e) === undefined)) return pending('CROSS_GROUP_VALUE_MISSING');
    const ordered = [...candidates].sort(
      (a, b) =>
        compareCrossGroup(this.policy.crossGroupOrder, a.values, b.values) || this.bySeed(a, b),
    );
    const comparison = ordered.map((e) => ({
      participantId: e.participantId,
      groupKey: e.groupKey,
      values: e.values
        .filter((v) => crossGroupValueKeys(this.policy.crossGroupOrder).has(v.key))
        .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0)),
    }));
    return u.targets.map((t) =>
      this.fromPick(
        t.target,
        this.pickAt(ordered, t.ordinal, (e) => keyOf(e) as string),
        () => ({
          family,
          source: source(t.ordinal),
          comparison,
        }),
      ),
    );
  }

  // ── FIELD: heats → final, cut, finishers only ──
  field(u: Extract<AdvancementUnit, { kind: 'FIELD' }>): AdvancementAssignment[] {
    const t = u.transition;
    const family: AdvancementFamily = t.kind === 'QUALIFY_BY_PLACE_AND_TIME' ? 'TOP_N' : 'CUT';
    const source = (ordinal: number) => ({
      kind: 'QUALIFIER',
      transitionKey: t.key,
      ordinal,
    });
    const size = Math.max(u.capacity ?? 0, u.recordedOrdinals, 1);
    const all = (
      state: 'PENDING' | 'HELD',
      reason: string,
      extra: Partial<AdvancementProvenance> = {},
    ) =>
      Array.from({ length: size }, (_, i) => ({
        target: { kind: 'FIELD' as const, transitionKey: t.key, ordinal: i + 1 },
        state,
        reason,
        provenance: { family, source: source(i + 1), ...extra },
      }));
    const c = u.classification;
    if (c === undefined) return all('PENDING', u.pendingReason ?? 'CLASSIFICATION_UNAVAILABLE');
    if (!c.document.complete) return all('PENDING', 'CLASSIFICATION_INCOMPLETE');
    const list = this.finishers(c);
    const selected = new Map<
      string,
      { entrant: Ranked; heat?: { contestId: string; place: number } }
    >();
    const take = (
      pool: readonly Ranked[],
      n: number,
      includeTies: boolean,
    ): string[] | undefined => {
      // Returns the HELD candidates when a tie straddles the boundary and cannot be decided.
      if (n <= 0) return undefined;
      const eligible = pool.filter((e) => !selected.has(e.participantId));
      if (eligible.length <= n)
        return void eligible.forEach((e) => selected.set(e.participantId, { entrant: e }));
      const { from, to } = Ctx.block(eligible, n - 1, (e) => e.position);
      if (to <= n - 1) {
        eligible.slice(0, n).forEach((e) => selected.set(e.participantId, { entrant: e }));
        return undefined;
      }
      if (includeTies) {
        eligible.slice(0, to + 1).forEach((e) => selected.set(e.participantId, { entrant: e }));
        return undefined;
      }
      eligible.slice(0, from).forEach((e) => selected.set(e.participantId, { entrant: e }));
      if (this.policy.boundaryTies === 'HOLD')
        return eligible
          .slice(from, to + 1)
          .map((e) => e.participantId)
          .sort();
      [...eligible.slice(from, to + 1)]
        .sort(this.bySeed)
        .slice(0, n - from)
        .forEach((e) => selected.set(e.participantId, { entrant: e }));
      return undefined;
    };
    const base = this.pool(list);
    let held: string[] | undefined;
    /** Places a boundary tie leaves open (the clear places above it are still decided). */
    let heldPlaces = 0;
    if (t.kind === 'QUALIFY_BY_PLACE_AND_TIME') {
      const capacity = u.capacity ?? 0;
      if (this.policy.heatSemantics === 'OVERALL') {
        held = take(base, capacity, false);
        if (held !== undefined) heldPlaces = capacity - selected.size;
      } else {
        const q = Number(t.params['qualifyByPlace'] ?? 0);
        for (const h of [...(u.heats ?? [])].sort((a, b) => (a.contestId < b.contestId ? -1 : 1))) {
          const members = new Set(h.members);
          const inHeat = base.filter((e) => members.has(e.participantId));
          const before = new Set(selected.keys());
          held ??= take(inHeat, q, false);
          inHeat.forEach((e, i) => {
            const s = selected.get(e.participantId);
            if (s !== undefined && !before.has(e.participantId))
              selected.set(e.participantId, {
                ...s,
                heat: { contestId: h.contestId, place: i + 1 },
              });
          });
        }
        held ??= take(base, capacity - selected.size, false);
        // A tie inside a heat's Q places changes who is left for q: nothing in the field is certain.
        if (held !== undefined) return all('HELD', 'TIE_AT_BOUNDARY', { candidates: held });
      }
    } else if (t.kind === 'CUT') {
      const topN = Number(t.params['topN'] ?? 0);
      held = take(base, topN, t.params['includeTies'] === true);
      if (held !== undefined) heldPlaces = topN - selected.size;
    } else {
      // ELIMINATE_NON_FINISHERS: every finisher continues.
      base.forEach((e) => selected.set(e.participantId, { entrant: e }));
    }
    const chosen = [...selected.values()]
      .filter(
        (s) => this.policy.withdrawn === 'NEXT_BEST' || this.eligible(s.entrant.participantId),
      )
      .sort((a, b) => a.entrant.position - b.entrant.position || this.bySeed(a.entrant, b.entrant));
    const total = Math.max(chosen.length + heldPlaces, u.capacity ?? 0, u.recordedOrdinals);
    return Array.from({ length: total }, (_, i) => {
      const target = { kind: 'FIELD' as const, transitionKey: t.key, ordinal: i + 1 };
      const s = chosen[i];
      if (s === undefined && held !== undefined && i < chosen.length + heldPlaces)
        return {
          target,
          state: 'HELD' as const,
          reason: 'TIE_AT_BOUNDARY',
          provenance: {
            family,
            source: source(i + 1),
            classification: Ctx.classificationRef(c),
            candidates: held,
          },
        };
      if (s === undefined)
        return {
          target,
          state: 'VACANT' as const,
          reason: i < (u.capacity ?? 0) ? 'NO_ENTRANT_AT_PLACE' : 'NOT_SELECTED',
          provenance: { family, source: source(i + 1), classification: Ctx.classificationRef(c) },
        };
      return {
        target,
        state: 'RESOLVED' as const,
        participantId: s.entrant.participantId,
        provenance: {
          family,
          source: source(i + 1),
          classification: Ctx.classificationRef(c, s.entrant),
          ...(s.heat === undefined ? {} : { heat: s.heat }),
        },
      };
    });
  }
}

function sourceKind(family: 'DIRECT_WINNER' | 'DIRECT_LOSER'): string {
  return family === 'DIRECT_WINNER' ? 'WINNER_OF_CONTEST' : 'LOSER_OF_CONTEST';
}

function crossGroupValueKeys(order: readonly CrossGroupKey[]): Set<string> {
  return new Set(order.flatMap((k) => (k.kind === 'VALUE' ? [k.key] : [k.forKey, k.againstKey])));
}

function valueOf(
  values: readonly { key: string; value: string }[],
  key: string,
): bigint | undefined {
  const v = values.find((x) => x.key === key)?.value;
  return v !== undefined && /^-?[0-9]+$/.test(v) ? BigInt(v) : undefined;
}

/** Equality key over the declared order (undefined when a value is missing). */
function crossGroupKey(
  order: readonly CrossGroupKey[],
  values: readonly { key: string; value: string }[],
): string | undefined {
  const parts: string[] = [];
  for (const k of order) {
    if (k.kind === 'VALUE') {
      const v = valueOf(values, k.key);
      if (v === undefined) return undefined;
      parts.push(v.toString());
    } else {
      const f = valueOf(values, k.forKey);
      const a = valueOf(values, k.againstKey);
      if (f === undefined || a === undefined) return undefined;
      if (k.kind === 'DIFFERENCE') parts.push((f - a).toString());
      else {
        // Reduced fraction: equal ratios get equal keys (a/0 is "infinite"; 0/0 is 0).
        const g = gcd(f < 0n ? -f : f, a < 0n ? -a : a) || 1n;
        parts.push(a === 0n ? (f === 0n ? '0/1' : '1/0') : `${f / g}/${a / g}`);
      }
    }
  }
  return parts.join('|');
}

function gcd(a: bigint, b: bigint): bigint {
  return b === 0n ? a : gcd(b, a % b);
}

/** Negative when `a` is better. Exact (ratios by cross-multiplication). */
export function compareCrossGroup(
  order: readonly CrossGroupKey[],
  a: readonly { key: string; value: string }[],
  b: readonly { key: string; value: string }[],
): number {
  for (const k of order) {
    let cmp: number;
    if (k.kind === 'VALUE') {
      const x = valueOf(a, k.key) ?? 0n;
      const y = valueOf(b, k.key) ?? 0n;
      cmp = x === y ? 0 : x > y ? -1 : 1;
      if (k.order === 'LOWER_IS_BETTER') cmp = -cmp;
    } else if (k.kind === 'DIFFERENCE') {
      const x = (valueOf(a, k.forKey) ?? 0n) - (valueOf(a, k.againstKey) ?? 0n);
      const y = (valueOf(b, k.forKey) ?? 0n) - (valueOf(b, k.againstKey) ?? 0n);
      cmp = x === y ? 0 : x > y ? -1 : 1;
    } else {
      const [fa, aa] = [valueOf(a, k.forKey) ?? 0n, valueOf(a, k.againstKey) ?? 0n];
      const [fb, ab] = [valueOf(b, k.forKey) ?? 0n, valueOf(b, k.againstKey) ?? 0n];
      const inf = (f: bigint, d: bigint) => d === 0n && f > 0n;
      if (inf(fa, aa) || inf(fb, ab)) cmp = inf(fa, aa) === inf(fb, ab) ? 0 : inf(fa, aa) ? -1 : 1;
      else {
        const x = aa === 0n ? 0n : fa * ab;
        const y = ab === 0n ? 0n : fb * aa;
        cmp = x === y ? 0 : x > y ? -1 : 1;
      }
    }
    if (cmp !== 0) return cmp;
  }
  return 0;
}
