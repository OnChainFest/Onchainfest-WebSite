import type { NormalizedContestResult, NormalizedEntry } from '@br/competition';
import type { ContentHash } from '@br/canonical';
import { platformCanonicalizer, SchemaRef } from '@br/schemas';
import {
  CLASSIFICATION_ENGINE_V2,
  validateClassificationPolicyV2,
  type ClassificationPolicyV2Spec,
  type MetricPolicySpec,
  type MetricTieBreak,
  type StandingsCriterion,
  type StandingsPolicySpec,
} from './classification-policy-v2';

/**
 * classification-engine/2 — ONCF-05C (ADR-0060, ADR-0063). Pure and deterministic:
 *
 *   classifyStage(input) → ClassificationV2Document (+ its canonical hash)
 *
 * It orders the entrants of ONE scope (a group, a heat round, a stage after round k, a race) from
 * NORMALIZED contest results (already validated by their ruleset), under a published policy:
 *   STANDINGS  match points, then the policy's criteria in order — head-to-head mini tables,
 *              tied-subset criteria, differences, exact ratios, capped averages, seed, organizer lot;
 *   METRIC     aggregate (SUM / MIN / MAX / BEST_N) of ordered keys, then the declared tie-breaks
 *              (count-back, finer precision, place sum, last round place, highest single), with
 *              non-finishers placed after finishers in the declared status order.
 * Rules it never breaks:
 *   · no hidden tie-break — entrants equal on every declared criterion SHARE a position (1, 1, 3);
 *     ORGANIZER_LOT separates only with an explicit, supplied lot order;
 *   · every separation is explained (criterion index, kind, compared values);
 *   · nothing is persisted, published or submitted here (ADR-0047: the engine proposes).
 * Arithmetic is exact: integers as BigInt, ratios / averages compared by cross-multiplication.
 */

export interface ClassificationV2Contest {
  readonly contestId: string;
  /** Order of the round this contest belongs to (multi-round, count-back, last round place). */
  readonly roundSequence: number;
  readonly resultVersionId?: string;
  readonly contentHash?: string;
  readonly result: NormalizedContestResult;
}

export interface ClassificationV2Input {
  readonly policy: ClassificationPolicyV2Spec;
  readonly policyRef: {
    readonly code: string;
    readonly version: number;
    readonly specHash: string;
  };
  readonly scope: {
    readonly eventId: string;
    readonly stageKey: string;
    readonly groupKey?: string;
    /** Rounds included (multi-round classification after round k). */
    readonly throughRound?: number;
  };
  readonly participants: readonly string[];
  readonly contests: readonly ClassificationV2Contest[];
  /** Contests in scope that have no admissible result yet (the classification is then incomplete). */
  readonly pendingContests?: readonly string[];
  readonly seedOrder?: readonly string[];
  /** An explicit organizer lot (only used by ORGANIZER_LOT). */
  readonly lotOrder?: readonly string[];
  /** Declared attributes used by subsets / team-derived scores (never published by this engine). */
  readonly attributes?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface ClassificationV2Entry {
  readonly participantId: string;
  readonly position: number;
  readonly tied: boolean;
  /** CLASSIFIED, or the non-finisher status that placed the entrant after the finishers. */
  readonly status: string;
  readonly values: readonly { readonly key: string; readonly value: string }[];
  /** The criterion that separated this entrant from the next (absent when tied or last). */
  readonly decidedBy?: { readonly criterion: number; readonly kind: string };
}

export interface ClassificationV2Document {
  readonly engine: typeof CLASSIFICATION_ENGINE_V2;
  readonly policy: ClassificationV2Input['policyRef'];
  readonly scope: ClassificationV2Input['scope'];
  readonly complete: boolean;
  readonly inputs: readonly {
    readonly contestId: string;
    readonly resultVersionId?: string;
    readonly contentHash?: string;
  }[];
  readonly entries: readonly ClassificationV2Entry[];
  readonly explanations: readonly {
    readonly participants: readonly string[];
    readonly criterion: number;
    readonly kind: string;
    readonly values: readonly { readonly participantId: string; readonly value: string }[];
  }[];
  readonly subsets?: readonly {
    readonly attribute: string;
    readonly value: string;
    readonly entries: readonly {
      readonly participantId: string;
      readonly position: number;
      readonly tied: boolean;
    }[];
  }[];
  readonly teams?: readonly {
    readonly label: string;
    readonly position: number;
    readonly tied: boolean;
    readonly score: string;
    readonly scorers: readonly string[];
  }[];
}

export type ClassificationV2Outcome =
  | { readonly ok: true; readonly document: ClassificationV2Document; readonly hash: ContentHash }
  | {
      readonly ok: false;
      readonly issues: readonly {
        readonly path: string;
        readonly code: string;
        readonly message: string;
      }[];
    };

// ───────────────────────────── exact values ─────────────────────────────

/** A comparable value: a rational num/den (den > 0), or ±∞ for x/0 ratios. Higher is better. */
interface Q {
  readonly num: bigint;
  readonly den: bigint;
}
const q = (num: bigint, den = 1n): Q => (den < 0n ? { num: -num, den: -den } : { num, den });
const cmpQ = (a: Q, b: Q): number => {
  if (a.den === 0n || b.den === 0n) {
    const sa = a.den === 0n ? (a.num > 0n ? 1 : a.num < 0n ? -1 : 0) * 2 : 0;
    const sb = b.den === 0n ? (b.num > 0n ? 1 : b.num < 0n ? -1 : 0) * 2 : 0;
    if (sa !== sb) return sa - sb > 0 ? 1 : -1;
    if (sa !== 0) return 0;
  }
  const l = a.num * b.den;
  const r = b.num * a.den;
  return l > r ? 1 : l < r ? -1 : 0;
};
const gcd = (a: bigint, b: bigint): bigint => {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
};
/** Canonical display: reduced fraction, integer when whole, ±Infinity for x/0. */
const showQ = (v: Q): string => {
  if (v.den === 0n) return v.num > 0n ? 'Infinity' : v.num < 0n ? '-Infinity' : 'NaN';
  const g = gcd(v.num, v.den) || 1n;
  const num = v.num / g;
  const den = v.den / g;
  return den === 1n ? num.toString() : `${num}/${den}`;
};
const big = (s: string | undefined): bigint => (s === undefined ? 0n : BigInt(s));

const WIN_LIKE = new Set(['WIN', 'WALKOVER_WIN']);
const FORFEIT_LIKE = new Set(['WALKOVER', 'FORFEIT']);

// ───────────────────────────── generic ordering machinery ─────────────────────────────

interface Separation {
  readonly participants: readonly string[];
  readonly criterion: number;
  readonly kind: string;
  readonly values: readonly { readonly participantId: string; readonly value: string }[];
}

/**
 * Orders `ids` into tiers of equals using a value function per criterion index. Criteria that
 * cannot apply return undefined and are skipped; a criterion splitting a block records an
 * explanation. With `restart`, any block a criterion splits is re-ordered from criterion 0.
 */
function orderBlocks(
  ids: readonly string[],
  criteria: number,
  value: (criterion: number, block: readonly string[]) => Map<string, Q> | undefined,
  kindOf: (criterion: number) => string,
  restart: boolean,
  out: Separation[],
  from = 0,
): string[][] {
  if (ids.length <= 1) return ids.length === 0 ? [] : [[...ids]];
  for (let c = from; c < criteria; c++) {
    const values = value(c, ids);
    if (values === undefined) continue;
    const sorted = [...ids].sort((a, b) => cmpQ(values.get(b) as Q, values.get(a) as Q));
    const tiers: string[][] = [];
    for (const id of sorted) {
      const last = tiers.at(-1);
      if (last !== undefined && cmpQ(values.get(last[0] as string) as Q, values.get(id) as Q) === 0)
        last.push(id);
      else tiers.push([id]);
    }
    if (tiers.length === 1) continue;
    out.push({
      participants: [...ids],
      criterion: c,
      kind: kindOf(c),
      values: sorted.map((id) => ({ participantId: id, value: showQ(values.get(id) as Q) })),
    });
    return tiers.flatMap((t) =>
      orderBlocks(t, criteria, value, kindOf, restart, out, restart ? 0 : c + 1),
    );
  }
  return [[...ids]];
}

function positionsOf(
  tiers: readonly (readonly string[])[],
  offset = 0,
): Map<string, { position: number; tied: boolean }> {
  const m = new Map<string, { position: number; tied: boolean }>();
  let pos = offset + 1;
  for (const t of tiers) {
    for (const id of t) m.set(id, { position: pos, tied: t.length > 1 });
    pos += t.length;
  }
  return m;
}

// ───────────────────────────── STANDINGS ─────────────────────────────

interface Stats {
  played: number;
  wins: number;
  points: bigint;
  sums: Map<string, bigint>;
  avg: Map<string, { sum: bigint; n: bigint }>;
}

function pointsFor(policy: StandingsPolicySpec, outcome: string): bigint {
  const rule = (o: string) => policy.matchPoints.find((m) => m.outcome === o);
  const fallback: Record<string, string> = {
    WALKOVER_WIN: 'WIN',
    WALKOVER_LOSS: 'LOSS',
    RETIRED: 'LOSS',
  };
  const r =
    rule(outcome) ??
    (fallback[outcome] === undefined ? undefined : rule(fallback[outcome] as string));
  return BigInt(r?.points ?? 0);
}

/** Metric keys a criterion list reads (sums with caps, averages). */
function metricNeeds(
  criteria: readonly StandingsCriterion[],
  acc = new Map<string, number | undefined>(),
) {
  for (const c of criteria) {
    if (c.kind === 'DIFFERENCE' || c.kind === 'RATIO_PERCENT') {
      acc.set(`${c.forMetric}@`, undefined);
      acc.set(`${c.againstMetric}@`, undefined);
    } else if (c.kind === 'SUM' || c.kind === 'AVERAGE')
      acc.set(`${c.metric}@${c.capPerContest ?? ''}`, c.capPerContest);
    else if (c.kind === 'HEAD_TO_HEAD' || c.kind === 'TIED_SUBSET') metricNeeds(c.sub, acc);
  }
  return acc;
}

function standingsStats(
  policy: StandingsPolicySpec,
  ids: readonly string[],
  games: readonly { readonly e: NormalizedEntry; readonly contestId: string }[],
): Map<string, Stats> {
  const needs = metricNeeds([...policy.criteria, ...(policy.crossGroup ?? [])]);
  const stats = new Map<string, Stats>(
    ids.map((id) => [id, { played: 0, wins: 0, points: 0n, sums: new Map(), avg: new Map() }]),
  );
  for (const { e } of games) {
    const s = stats.get(e.participantId);
    if (s === undefined) continue;
    s.played += 1;
    if (WIN_LIKE.has(e.outcome)) s.wins += 1;
    s.points += pointsFor(policy, e.outcome);
    const forfeit = e.decidedBy !== undefined && FORFEIT_LIKE.has(e.decidedBy);
    for (const [key, cap] of needs) {
      const metric = key.split('@')[0] as string;
      let v = big(e.metrics[metric]);
      if (cap !== undefined && v > BigInt(cap)) v = BigInt(cap);
      s.sums.set(key, (s.sums.get(key) ?? 0n) + v);
      if (!forfeit) {
        const a = s.avg.get(key) ?? { sum: 0n, n: 0n };
        s.avg.set(key, { sum: a.sum + v, n: a.n + 1n });
      }
    }
  }
  return stats;
}

function criterionValue(
  c: StandingsCriterion,
  ids: readonly string[],
  stats: Map<string, Stats>,
  ctx: {
    policy: StandingsPolicySpec;
    games: readonly { readonly e: NormalizedEntry; readonly contestId: string }[];
    seedOrder?: readonly string[];
    lotOrder?: readonly string[];
  },
): Map<string, Q> | undefined {
  const per = (f: (s: Stats, id: string) => Q) =>
    new Map(ids.map((id) => [id, f(stats.get(id) as Stats, id)]));
  const sum = (s: Stats, metric: string, cap?: number) =>
    s.sums.get(`${metric}@${cap ?? ''}`) ?? 0n;
  switch (c.kind) {
    case 'POINTS':
      return per((s) => q(s.points));
    case 'WINS':
      return per((s) => q(BigInt(s.wins)));
    case 'WIN_RATIO':
      return per((s) => (s.played === 0 ? q(0n) : q(BigInt(s.wins), BigInt(s.played))));
    case 'MATCHES_PLAYED':
      return per((s) => q(BigInt(c.order === 'DESC' ? s.played : -s.played)));
    case 'DIFFERENCE':
      return per((s) =>
        q((s.sums.get(`${c.forMetric}@`) ?? 0n) - (s.sums.get(`${c.againstMetric}@`) ?? 0n)),
      );
    case 'RATIO_PERCENT':
      return per((s) => {
        const f = s.sums.get(`${c.forMetric}@`) ?? 0n;
        const a = s.sums.get(`${c.againstMetric}@`) ?? 0n;
        return f + a === 0n ? q(0n) : q(f, f + a);
      });
    case 'SUM':
      return per((s) => q(sum(s, c.metric, c.capPerContest)));
    case 'AVERAGE':
      return per((s) => {
        const a = s.avg.get(`${c.metric}@${c.capPerContest ?? ''}`);
        return a === undefined || a.n === 0n ? q(0n) : q(a.sum, a.n);
      });
    case 'SEED': {
      const seeds = ctx.seedOrder;
      if (seeds === undefined) return undefined;
      // Better seed (lower index) ⇒ higher value; an unseeded entrant is worst.
      return per((_, id) => q(-BigInt(seeds.includes(id) ? seeds.indexOf(id) : 1_000_000)));
    }
    case 'ORGANIZER_LOT':
      return ctx.lotOrder === undefined || !ids.every((id) => ctx.lotOrder?.includes(id))
        ? undefined
        : per((_, id) => q(BigInt(-(ctx.lotOrder?.indexOf(id) ?? 0))));
    default:
      return undefined;
  }
}

/** Mini-table among `ids` only (head-to-head / tied subset), ordered by `sub` lexicographically. */
function subTableRank(
  sub: readonly StandingsCriterion[],
  ids: readonly string[],
  ctx: {
    policy: StandingsPolicySpec;
    games: readonly { readonly e: NormalizedEntry; readonly contestId: string }[];
  },
): Map<string, Q> {
  const set = new Set(ids);
  const among = ctx.games.filter(
    ({ e }) => set.has(e.participantId) && e.opponentId !== undefined && set.has(e.opponentId),
  );
  const stats = standingsStats({ ...ctx.policy, criteria: sub, crossGroup: [] }, ids, among);
  const tiers = orderBlocks(
    ids,
    sub.length,
    (c, block) => criterionValue(sub[c] as StandingsCriterion, block, stats, ctx),
    (c) => (sub[c] as StandingsCriterion).kind,
    false,
    [],
  );
  const m = new Map<string, Q>();
  tiers.forEach((t, i) => t.forEach((id) => m.set(id, q(BigInt(-i)))));
  return m;
}

function classifyStandings(input: ClassificationV2Input, policy: StandingsPolicySpec) {
  const games = input.contests.flatMap((c) =>
    c.result.mode === 'HEAD_TO_HEAD'
      ? c.result.entries.map((e) => ({ e, contestId: c.contestId }))
      : [],
  );
  // ITF-style exclusions: a walkover giver's matches leave everyone's statistics.
  const givers = new Set(
    policy.exclusions?.walkoverGiverAllMatches === true
      ? games.filter((g) => g.e.outcome === 'WALKOVER_LOSS').map((g) => g.e.participantId)
      : [],
  );
  const counted =
    givers.size === 0
      ? games
      : games.filter(
          (g) =>
            !givers.has(g.e.participantId) &&
            !(g.e.opponentId !== undefined && givers.has(g.e.opponentId)),
        );
  const ids = [...input.participants].sort();
  const stats = standingsStats(policy, ids, counted);
  const incomplete = new Set<string>();
  if (policy.exclusions?.onlyEntrantsWhoCompletedAll === true) {
    const retiredOk = policy.exclusions.retiredCountsAsCompleted === true;
    for (const g of games)
      if (g.e.outcome === 'WALKOVER_LOSS' || (!retiredOk && g.e.outcome === 'RETIRED'))
        incomplete.add(g.e.participantId);
  }
  const ctx = {
    policy,
    games: counted,
    ...(input.seedOrder === undefined ? {} : { seedOrder: input.seedOrder }),
    ...(input.lotOrder === undefined ? {} : { lotOrder: input.lotOrder }),
  };
  const crit = policy.criteria;
  const value = (c: number, block: readonly string[]): Map<string, Q> | undefined => {
    const k = crit[c] as StandingsCriterion;
    if (k.kind === 'HEAD_TO_HEAD') {
      if (k.maxTied !== undefined && block.length > k.maxTied) return undefined;
      return subTableRank(k.sub, block, ctx);
    }
    if (k.kind === 'TIED_SUBSET') {
      if (block.length < k.minTied) return undefined;
      return subTableRank(k.sub, block, ctx);
    }
    return criterionValue(k, block, stats, ctx);
  };
  const explanations: Separation[] = [];
  const order = (group: readonly string[]) =>
    orderBlocks(
      group,
      crit.length,
      value,
      (c) => (crit[c] as StandingsCriterion).kind,
      policy.restartOnSeparation,
      explanations,
    );
  const tiers = [
    ...order(ids.filter((id) => !incomplete.has(id) && !givers.has(id))),
    ...order(ids.filter((id) => incomplete.has(id) || givers.has(id))),
  ];
  const values = (id: string) => {
    const s = stats.get(id) as Stats;
    const base = [
      { key: 'played', value: String(s.played) },
      { key: 'wins', value: String(s.wins) },
      { key: 'points', value: s.points.toString() },
    ];
    return [
      ...base,
      ...[...s.sums.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => ({ key: k.replace(/@$/, ''), value: v.toString() })),
    ];
  };
  return {
    tiers,
    explanations,
    values,
    status: (id: string) => (incomplete.has(id) || givers.has(id) ? 'INCOMPLETE' : 'CLASSIFIED'),
  };
}

// ───────────────────────────── METRIC ─────────────────────────────

const NON_FINISHER: Record<string, string> = {
  DNF: 'DNF',
  DNS: 'DNS',
  DQ: 'DQ',
  NOT_PLACED: 'NOT_PLACED',
  PULLED: 'PULLED',
};

function classifyMetric(input: ClassificationV2Input, policy: MetricPolicySpec) {
  const ids = [...input.participants].sort();
  const contests = [...input.contests].filter(
    (c) => input.scope.throughRound === undefined || c.roundSequence <= input.scope.throughRound,
  );
  const rounds = [...new Set(contests.map((c) => c.roundSequence))].sort((a, b) => a - b);
  const entriesOf = (id: string) =>
    contests.flatMap((c) =>
      c.result.entries
        .filter((e) => e.participantId === id)
        .map((e) => ({ e, round: c.roundSequence })),
    );
  // Status: a finisher finished every round in scope; otherwise the first non-finisher status met.
  const status = new Map<string, string>();
  for (const id of ids) {
    const es = entriesOf(id);
    const nf = es.find((x) => NON_FINISHER[x.e.outcome] !== undefined);
    const missing = rounds.some((r) => !es.some((x) => x.round === r));
    // Missing from an admitted round: DNS when the scope is complete, PENDING while results are still
    // outstanding (an unreported result is never a non-start).
    const pending = (input.pendingContests ?? []).length > 0;
    status.set(
      id,
      nf !== undefined
        ? (NON_FINISHER[nf.e.outcome] as string)
        : missing || es.length === 0
          ? pending
            ? 'PENDING'
            : 'DNS'
          : 'CLASSIFIED',
    );
  }
  const higher = (k: number) => policy.keys[k]?.order === 'HIGHER_IS_BETTER';
  const agg = (id: string, metric: string, better: boolean): bigint | undefined => {
    const vs = entriesOf(id)
      .map((x) => x.e.metrics[metric])
      .filter((v): v is string => v !== undefined)
      .map((v) => BigInt(v));
    if (vs.length === 0) return undefined;
    const a = policy.aggregate;
    if (a.fn === 'SUM') return vs.reduce((t, v) => t + v, 0n);
    if (a.fn === 'MIN') return vs.reduce((t, v) => (v < t ? v : t));
    if (a.fn === 'MAX') return vs.reduce((t, v) => (v > t ? v : t));
    const sorted = [...vs].sort((x, y) =>
      better ? (y > x ? 1 : y < x ? -1 : 0) : x > y ? 1 : x < y ? -1 : 0,
    );
    return sorted.slice(0, a.n ?? 1).reduce((t, v) => t + v, 0n);
  };
  const signed = (v: bigint | undefined, hi: boolean): Q =>
    v === undefined ? q(-1n, 0n) : q(hi ? v : -v);
  const lastSeries = (id: string, key: string): number[] => {
    const last = entriesOf(id).sort((x, y) => y.round - x.round)[0];
    return [...(last?.e.series[key] ?? [])];
  };
  /** Place within one round: the contest's own finish position when recorded, else the key metric. */
  const placeIn = (round: number, keyMetric: string, keyHi: boolean) => {
    const rows = contests
      .filter((c) => c.roundSequence === round)
      .flatMap((c) => c.result.entries)
      .filter((e) => NON_FINISHER[e.outcome] === undefined);
    const byPosition =
      rows.length > 0 && rows.every((e) => e.metrics['finishPosition'] !== undefined);
    const metric = byPosition ? 'finishPosition' : keyMetric;
    const hi = byPosition ? false : keyHi;
    const vals = rows
      .filter((e) => e.metrics[metric] !== undefined)
      .map((e) => ({ id: e.participantId, v: BigInt(e.metrics[metric] as string) }));

    const m = new Map<string, bigint>();
    for (const r of vals)
      m.set(r.id, BigInt(1 + vals.filter((o) => (hi ? o.v > r.v : o.v < r.v)).length));
    return m;
  };
  const keyCount = policy.keys.length;
  const tb = policy.tieBreak;
  const kinds = [...policy.keys.map((k) => `KEY:${k.metric}`), ...tb.map((t) => t.kind)];
  const firstHi = higher(0);
  const firstMetric = policy.keys[0]?.metric as string;
  const value = (c: number, block: readonly string[]): Map<string, Q> | undefined => {
    if (c < keyCount) {
      const k = policy.keys[c] as MetricPolicySpec['keys'][number];
      return new Map(block.map((id) => [id, signed(agg(id, k.metric, higher(c)), higher(c))]));
    }
    const t = tb[c - keyCount] as MetricTieBreak;
    switch (t.kind) {
      case 'COUNT_BACK': {
        // Lower holes values are better for strokes (series hold net/gross per hole); higher for points.
        const segs = t.segments;
        return new Map(
          block.map((id) => {
            const holes = lastSeries(id, 'holes');
            // Encode the segment sums lexicographically into one comparable value.
            let acc = 0n;
            for (const s of segs) {
              const v = BigInt(holes.slice(-s).reduce((x, y) => x + y, 0));
              acc = acc * 1_000_000n + (firstHi ? v : 999_999n - v);
            }
            return [id, q(acc)];
          }),
        );
      }
      case 'FINER_PRECISION':
        return new Map(block.map((id) => [id, signed(agg(id, 'rawTimeMs', false), false)]));
      case 'PLACE_SUM': {
        const sums = new Map<string, bigint>(block.map((id) => [id, 0n]));
        for (const r of rounds) {
          const p = placeIn(r, firstMetric, firstHi);
          for (const id of block)
            sums.set(id, (sums.get(id) as bigint) + (p.get(id) ?? 1_000_000n));
        }
        return new Map(block.map((id) => [id, q(-(sums.get(id) as bigint))]));
      }
      case 'LAST_ROUND_PLACE': {
        const last = rounds.at(-1);
        if (last === undefined) return undefined;
        const p = placeIn(last, firstMetric, firstHi);
        return new Map(block.map((id) => [id, q(-(p.get(id) ?? 1_000_000n))]));
      }
      case 'HIGHEST_SINGLE':
        return new Map(
          block.map((id) => [
            id,
            q(BigInt(Math.max(0, ...entriesOf(id).flatMap((x) => x.e.series['games'] ?? [])))),
          ]),
        );
      case 'ORGANIZER_LOT':
        return input.lotOrder === undefined || !block.every((id) => input.lotOrder?.includes(id))
          ? undefined
          : new Map(block.map((id) => [id, q(BigInt(-(input.lotOrder?.indexOf(id) ?? 0)))]));
      case 'SHARED':
      default:
        return undefined;
    }
  };
  const explanations: Separation[] = [];
  const finishers = ids.filter((id) => status.get(id) === 'CLASSIFIED');
  const tiers = orderBlocks(
    finishers,
    keyCount + tb.length,
    value,
    (c) => kinds[c] as string,
    false,
    explanations,
  );
  // Non-finishers after finishers, in the declared status order; PULLED by laps down then pull order.
  for (const st of policy.statusOrder) {
    const group = ids.filter((id) => status.get(id) === st);
    if (group.length === 0) continue;
    if (st === 'PULLED' || st === 'NOT_PLACED') {
      const v = (id: string) =>
        st === 'PULLED'
          ? q(
              -(agg(id, 'lapsDown', false) ?? 0n) * 1_000_000n -
                (agg(id, 'pullOrder', false) ?? 0n),
            )
          : signed(agg(id, firstMetric, firstHi), firstHi);
      tiers.push(
        ...orderBlocks(
          group,
          1,
          () => new Map(group.map((id) => [id, v(id)])),
          () => `STATUS:${st}`,
          false,
          explanations,
        ),
      );
    } else tiers.push(group);
  }
  const unlisted = ids.filter(
    (id) =>
      status.get(id) !== 'CLASSIFIED' && !policy.statusOrder.includes(status.get(id) as never),
  );
  if (unlisted.length > 0) tiers.push(unlisted);
  const values = (id: string) => {
    const vs = policy.keys
      .map((k, i) => ({ key: k.metric, value: agg(id, k.metric, higher(i))?.toString() ?? '' }))
      .filter((x) => x.value !== '');
    return vs;
  };
  return { tiers, explanations, values, status: (id: string) => status.get(id) as string };
}

// ───────────────────────────── entry point ─────────────────────────────

export function classifyStage(input: ClassificationV2Input): ClassificationV2Outcome {
  const issues = validateClassificationPolicyV2(input.policy).map((i) => ({
    path: `/policy${i.path}`,
    code: 'POLICY_INVALID',
    message: i.message,
  }));
  if (
    input.policy.family === 'STANDINGS' &&
    input.contests.some((c) => c.result.mode !== 'HEAD_TO_HEAD')
  )
    issues.push({
      path: '/contests',
      code: 'POLICY_FAMILY_MISMATCH',
      message: 'standings need head-to-head results',
    });
  if (input.policy.family === 'METRIC' && input.contests.some((c) => c.result.mode !== 'FIELD'))
    issues.push({
      path: '/contests',
      code: 'POLICY_FAMILY_MISMATCH',
      message: 'a metric classification needs field results',
    });
  const known = new Set(input.participants);
  for (const c of input.contests)
    for (const e of c.result.entries)
      if (!known.has(e.participantId))
        issues.push({
          path: `/contests/${c.contestId}`,
          code: 'PARTICIPANT_OUT_OF_SCOPE',
          message: 'a result names an entrant outside the scope',
        });
  if (issues.length > 0) return { ok: false, issues };

  const r =
    input.policy.family === 'STANDINGS'
      ? classifyStandings(input, input.policy)
      : classifyMetric(input, input.policy);
  const pos = positionsOf(r.tiers);
  const order = r.tiers.flat();
  const entries: ClassificationV2Entry[] = order.map((id, i) => {
    const p = pos.get(id) as { position: number; tied: boolean };
    const next = order[i + 1];
    const split =
      next === undefined || p.tied
        ? undefined
        : r.explanations
            .filter((e) => e.participants.includes(id) && e.participants.includes(next))
            .at(-1);
    return {
      participantId: id,
      position: p.position,
      tied: p.tied,
      status: r.status(id),
      values: r.values(id),
      ...(split === undefined
        ? {}
        : { decidedBy: { criterion: split.criterion, kind: split.kind } }),
    };
  });

  let subsets: ClassificationV2Document['subsets'];
  let teams: ClassificationV2Document['teams'];
  if (input.policy.family === 'METRIC') {
    const p = input.policy;
    const attrs = input.attributes ?? {};
    if ((p.subsetsByAttribute ?? []).length > 0) {
      const list: {
        attribute: string;
        value: string;
        entries: { participantId: string; position: number; tied: boolean }[];
      }[] = [];
      for (const attribute of p.subsetsByAttribute ?? []) {
        const values = [
          ...new Set(
            order.map((id) => attrs[id]?.[attribute]).filter((v): v is string => v !== undefined),
          ),
        ].sort();
        for (const value of values) {
          const members = r.tiers
            .map((t) => t.filter((id) => attrs[id]?.[attribute] === value))
            .filter((t) => t.length > 0);
          const sp = positionsOf(members);
          list.push({
            attribute,
            value,
            entries: members.flat().map((id) => ({
              participantId: id,
              ...(sp.get(id) as { position: number; tied: boolean }),
            })),
          });
        }
      }
      subsets = list;
    }
    const td = p.teamDerived;
    if (td !== undefined) {
      const labels = [
        ...new Set(
          order
            .map((id) => attrs[id]?.[td.groupByAttribute])
            .filter((v): v is string => v !== undefined),
        ),
      ].sort();
      const scored = labels
        .map((label) => {
          const members = entries.filter(
            (e) =>
              e.status === 'CLASSIFIED' && attrs[e.participantId]?.[td.groupByAttribute] === label,
          );
          if (members.length < td.scorers) return undefined;
          const scorers = members.slice(0, td.scorers);
          const score =
            td.fn === 'SUM_OF_PLACES'
              ? scorers.reduce((t, e) => t + BigInt(e.position), 0n)
              : scorers.reduce(
                  (t, e) => t + big(e.values.find((v) => v.key === p.keys[0]?.metric)?.value),
                  0n,
                );
          // World Athletics cross-country: ties go to the team whose last scorer finished closer to first.
          return {
            label,
            score,
            last: BigInt((scorers.at(-1) as ClassificationV2Entry).position),
            scorers: scorers.map((e) => e.participantId),
          };
        })
        .filter(
          (t): t is { label: string; score: bigint; last: bigint; scorers: string[] } =>
            t !== undefined,
        );
      const tiers = orderBlocks(
        scored.map((t) => t.label),
        2,
        (c) => new Map(scored.map((t) => [t.label, q(-(c === 0 ? t.score : t.last))])),
        (c) => (c === 0 ? 'TEAM_SCORE' : 'LAST_SCORER'),
        false,
        [],
      );
      const tp = positionsOf(tiers);
      teams = tiers.flat().map((label) => {
        const t = scored.find((x) => x.label === label) as (typeof scored)[number];
        return {
          label,
          ...(tp.get(label) as { position: number; tied: boolean }),
          score: t.score.toString(),
          scorers: t.scorers,
        };
      });
    }
  }

  const document: ClassificationV2Document = {
    engine: CLASSIFICATION_ENGINE_V2,
    policy: input.policyRef,
    scope: input.scope,
    complete: (input.pendingContests ?? []).length === 0,
    inputs: [...input.contests]
      .map((c) => ({
        contestId: c.contestId,
        ...(c.resultVersionId === undefined ? {} : { resultVersionId: c.resultVersionId }),
        ...(c.contentHash === undefined ? {} : { contentHash: c.contentHash }),
      }))
      .sort((a, b) => (a.contestId < b.contestId ? -1 : 1)),
    entries,
    explanations: r.explanations.map((e) => ({
      participants: [...e.participants].sort(),
      criterion: e.criterion,
      kind: e.kind,
      values: e.values,
    })),
    ...(subsets === undefined ? {} : { subsets }),
    ...(teams === undefined ? {} : { teams }),
  };
  const hash = platformCanonicalizer().hashCanonical(
    'ledger-fact',
    SchemaRef.stageClassification.id,
    1,
    document,
  ).contentHash;
  return { ok: true, document, hash };
}
