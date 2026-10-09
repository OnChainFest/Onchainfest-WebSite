import type { RuleBasis } from '../ruleset';

/**
 * AdvancementPolicy (ONCF-05D, ADR-0065): the fifth pinned axis next to Format, Ruleset,
 * ClassificationPolicy and (05E) SchedulingProfile.
 *
 * WHO goes WHERE is already declared, as data, by the immutable plan (05B): every dependent slot
 * names its source (winner of contest X, rank r of group g, the k-th best rank-r entrant across the
 * groups of a stage, the k-th entrant selected by transition t) and every cross-stage transition is
 * typed with its parameters (Q/q, top N and ties, finishers only). The policy declares HOW those
 * declarations are interpreted: which result status is trustworthy enough, how heats are read, how
 * entrants of different groups are compared, what happens to ties at a boundary and to withdrawn
 * entrants, and whether a resolution needs an organizer's confirmation. Nothing here knows a sport.
 */

/** Selector families: the interpretation of each plan source / transition kind (never a sport). */
export const AdvancementFamily = {
  /** WINNER_OF_CONTEST: the contest's winner occupies the slot. */
  DIRECT_WINNER: 'DIRECT_WINNER',
  /** LOSER_OF_CONTEST: the contest's loser (third-place match, consolation). */
  DIRECT_LOSER: 'DIRECT_LOSER',
  /** RANK_FROM_STAGE with a group: rank r of group g. */
  GROUP_RANK: 'GROUP_RANK',
  /** RANK_FROM_STAGE of a single-round stage, or QUALIFY_BY_PLACE_AND_TIME: the top N. */
  TOP_N: 'TOP_N',
  /** BEST_RANKED_FROM_STAGE: the k-th best rank-r entrant across groups, by the declared order. */
  BEST_N_ACROSS_GROUPS: 'BEST_N_ACROSS_GROUPS',
  /** CUT / ELIMINATE_NON_FINISHERS: who continues in a multi-round stage. */
  CUT: 'CUT',
  /** RANK_FROM_STAGE of a multi-round stage: rank in the cumulative classification. */
  STAGE_TOTAL: 'STAGE_TOTAL',
  /** An organizer's explicit, reasoned assignment (never silent, always reversible). */
  MANUAL_OVERRIDE: 'MANUAL_OVERRIDE',
} as const;
export type AdvancementFamily = (typeof AdvancementFamily)[keyof typeof AdvancementFamily];

/**
 * Order used to compare entrants of DIFFERENT groups (best third places): a declared sequence over
 * the values each group's classification document carries. Head-to-head and tied-subset criteria
 * have no meaning across groups and cannot be named here.
 */
export type CrossGroupKey =
  | {
      readonly kind: 'VALUE';
      readonly key: string;
      readonly order: 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER';
    }
  | { readonly kind: 'DIFFERENCE'; readonly forKey: string; readonly againstKey: string }
  | { readonly kind: 'RATIO'; readonly forKey: string; readonly againstKey: string };

export interface AdvancementPolicySpec {
  readonly family: 'ADVANCEMENT';
  /** Lowest result status a source result must have to be consumed (default OFFICIAL). */
  readonly minimumResultStatus: 'OFFICIAL' | 'PROVISIONAL';
  /**
   * CONFIRM: a resolution is committed only with the hash of the preview the organizer saw.
   * AUTOMATIC: an authorized resolve command commits every unit that resolves (still explicit,
   * still audited — nothing changes merely because a classification can be computed).
   */
  readonly commit: 'CONFIRM' | 'AUTOMATIC';
  /**
   * How heats feed a final. PLACE_THEN_TIME: heats are competitive — Q by place in each heat, then
   * q by time. OVERALL: heats are logistic — one classification across all heats (Q must be 0).
   */
  readonly heatSemantics: 'PLACE_THEN_TIME' | 'OVERALL';
  /**
   * Entrants tied (equal on every declared criterion) across a capacity boundary or for an ordered
   * slot. HOLD: the slot stays unresolved until an explicit override (a lot, a swim-off, a play-off);
   * SEED: the better (lower) seed takes it. Ties inside a CUT follow the transition's includeTies.
   */
  readonly boundaryTies: 'HOLD' | 'SEED';
  /** Withdrawn / disqualified entrants: VACATE the slot, or take the NEXT_BEST eligible entrant. */
  readonly withdrawn: 'VACATE' | 'NEXT_BEST';
  /** Cross-group comparison (BEST_N_ACROSS_GROUPS); required when the plan has such slots. */
  readonly crossGroupOrder: readonly CrossGroupKey[];
}

export interface AdvancementPolicyTemplate {
  readonly code: string;
  readonly name: string;
  readonly spec: AdvancementPolicySpec;
  readonly basis: RuleBasis;
}

const VALUE_KEY = /^[a-z][A-Za-z0-9]{0,31}$/;
const ENUMS = {
  minimumResultStatus: ['OFFICIAL', 'PROVISIONAL'],
  commit: ['CONFIRM', 'AUTOMATIC'],
  heatSemantics: ['PLACE_THEN_TIME', 'OVERALL'],
  boundaryTies: ['HOLD', 'SEED'],
  withdrawn: ['VACATE', 'NEXT_BEST'],
} as const;

export function validateAdvancementPolicy(spec: unknown): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec))
    return [{ path: '', message: 'an object' }];
  const s = spec as Record<string, unknown>;
  const allowed = new Set(['family', 'crossGroupOrder', ...Object.keys(ENUMS)]);
  for (const k of Object.keys(s))
    if (!allowed.has(k)) out.push({ path: `/${k}`, message: 'unknown property' });
  if (s['family'] !== 'ADVANCEMENT') out.push({ path: '/family', message: 'ADVANCEMENT' });
  for (const [k, values] of Object.entries(ENUMS))
    if (!(values as readonly unknown[]).includes(s[k]))
      out.push({ path: `/${k}`, message: values.join(' | ') });
  const order = s['crossGroupOrder'];
  if (!Array.isArray(order) || order.length > 8) {
    out.push({ path: '/crossGroupOrder', message: '0–8 keys' });
    return out;
  }
  order.forEach((raw, i) => {
    const path = `/crossGroupOrder/${i}`;
    const k = raw as Record<string, unknown>;
    if (typeof k !== 'object' || k === null) return void out.push({ path, message: 'an object' });
    const keys = Object.keys(k).sort().join();
    if (k['kind'] === 'VALUE') {
      if (keys !== 'key,kind,order' || !VALUE_KEY.test(String(k['key'])))
        out.push({ path, message: '{kind, key, order}' });
      if (k['order'] !== 'HIGHER_IS_BETTER' && k['order'] !== 'LOWER_IS_BETTER')
        out.push({ path: `${path}/order`, message: 'HIGHER_IS_BETTER | LOWER_IS_BETTER' });
    } else if (k['kind'] === 'DIFFERENCE' || k['kind'] === 'RATIO') {
      if (
        keys !== 'againstKey,forKey,kind' ||
        !VALUE_KEY.test(String(k['forKey'])) ||
        !VALUE_KEY.test(String(k['againstKey']))
      )
        out.push({ path, message: '{kind, forKey, againstKey}' });
    } else out.push({ path: `${path}/kind`, message: 'VALUE | DIFFERENCE | RATIO' });
  });
  return out;
}

/** Value keys a cross-group order reads (checked against the pinned template at pin time). */
export function crossGroupKeysUsed(spec: AdvancementPolicySpec): string[] {
  return [
    ...new Set(
      spec.crossGroupOrder.flatMap((k) =>
        k.kind === 'VALUE' ? [k.key] : [k.forKey, k.againstKey],
      ),
    ),
  ].sort();
}

const base = {
  family: 'ADVANCEMENT',
  minimumResultStatus: 'OFFICIAL',
  commit: 'CONFIRM',
  heatSemantics: 'PLACE_THEN_TIME',
  boundaryTies: 'HOLD',
  withdrawn: 'VACATE',
  crossGroupOrder: [],
} as const satisfies AdvancementPolicySpec;

/**
 * Canonical policy versions. Templates are interpretations, not sports: the same template serves
 * every discipline whose plan has the shape. Where no governing rule fixes a choice, the basis says
 * COMMON_PRACTICE and names the choice.
 */
export const ADVANCEMENT_POLICY_TEMPLATES: readonly AdvancementPolicyTemplate[] = [
  {
    code: 'official-confirmed',
    name: 'Official results, organizer-confirmed',
    spec: base,
    basis: {
      kind: 'COMMON_PRACTICE',
      note: 'only OFFICIAL results advance anyone; ties at a boundary wait for an explicit decision; a withdrawn entrant vacates the slot',
    },
  },
  {
    code: 'groups-wins-games',
    name: 'Groups → knockout (wins, then sets / games difference across groups)',
    spec: {
      ...base,
      crossGroupOrder: [
        { kind: 'VALUE', key: 'wins', order: 'HIGHER_IS_BETTER' },
        { kind: 'DIFFERENCE', forKey: 'setsWon', againstKey: 'setsLost' },
        { kind: 'DIFFERENCE', forKey: 'gamesWon', againstKey: 'gamesLost' },
      ],
    },
    basis: {
      kind: 'COMMON_PRACTICE',
      note: 'best-ranked entrants of different groups compared by wins, then set and game difference; head-to-head does not exist across groups',
    },
  },
  {
    code: 'pools-wins-points',
    name: 'Pools → knockout (wins, then points scored across pools)',
    spec: {
      ...base,
      crossGroupOrder: [
        { kind: 'VALUE', key: 'wins', order: 'HIGHER_IS_BETTER' },
        { kind: 'VALUE', key: 'pointsFor', order: 'HIGHER_IS_BETTER' },
      ],
    },
    basis: {
      kind: 'COMMON_PRACTICE',
      note: 'best-ranked teams of different pools compared by wins, then points scored',
    },
  },
  {
    code: 'heats-place-then-time',
    name: 'Heats → final: Q by place in each heat, then q by time',
    spec: { ...base, heatSemantics: 'PLACE_THEN_TIME' },
    basis: {
      kind: 'GOVERNING_RULE',
      source: 'World Athletics Technical Rules, TR 20 (rounds and heats)',
    },
  },
  {
    code: 'heats-overall-time',
    name: 'Heats → final by overall time (heats are logistic)',
    spec: { ...base, heatSemantics: 'OVERALL' },
    basis: {
      kind: 'GOVERNING_RULE',
      source: 'World Aquatics Swimming Rules, SW 3 (seeding of heats, semi-finals and finals)',
    },
  },
  {
    code: 'field-cut-official',
    name: 'Multi-round field: cut / continue on official totals',
    spec: base,
    basis: {
      kind: 'COMMON_PRACTICE',
      note: 'the cut is applied to the cumulative classification of official rounds; ties at the line follow the format’s includeTies setting',
    },
  },
];
