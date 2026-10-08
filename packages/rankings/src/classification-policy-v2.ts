import type { RuleBasis } from '@br/competition';

/**
 * ClassificationPolicy v2 vocabulary — ONCF-05B (ADR-0060; engine in ONCF-05C).
 *
 * `classification-engine/1` (ADR-0049) orders only by the DisciplineVersion comparator keys with
 * SUM/MAX/MIN. Real group tables and leaderboards need more, and they differ by COMPETITION, not
 * by discipline: head-to-head among tied entrants, tied-subset differences (FIP three-way ties),
 * differences, ratios, capped averages (3x3), count-back (golf), status ordering (DNF/DQ), team
 * scores derived from individuals. This module is the closed vocabulary and its validation only:
 * nothing here computes a classification, writes a standing, or submits a Result (ADR-0047 holds —
 * the engine proposes, an authority submits). Templates are DATA citing their source.
 */

export const CLASSIFICATION_ENGINE_V2 = 'classification-engine/2';

export type PolicyFamily = 'STANDINGS' | 'METRIC';

/** Ordered criteria. A criterion only separates entrants still tied by the previous ones. */
export type StandingsCriterion =
  | { readonly kind: 'POINTS' }
  | { readonly kind: 'WINS' }
  | { readonly kind: 'WIN_RATIO' }
  | { readonly kind: 'MATCHES_PLAYED'; readonly order: 'ASC' | 'DESC' }
  | { readonly kind: 'DIFFERENCE'; readonly forMetric: string; readonly againstMetric: string }
  | { readonly kind: 'RATIO_PERCENT'; readonly forMetric: string; readonly againstMetric: string }
  | { readonly kind: 'SUM'; readonly metric: string; readonly capPerContest?: number }
  | {
      readonly kind: 'AVERAGE';
      readonly metric: string;
      readonly capPerContest?: number;
      readonly excludeForfeits: boolean;
    }
  | {
      readonly kind: 'HEAD_TO_HEAD';
      readonly sub: readonly StandingsCriterion[];
      /** ITF RR: head-to-head only between exactly two tied entrants. */
      readonly maxTied?: number;
    }
  | {
      readonly kind: 'TIED_SUBSET';
      readonly sub: readonly StandingsCriterion[];
      /** FIP: three or more tied → set difference, then game difference among them. */
      readonly minTied: number;
    }
  | { readonly kind: 'SEED' }
  | { readonly kind: 'ORGANIZER_LOT' };

export interface StandingsPolicySpec {
  readonly family: 'STANDINGS';
  readonly targetEngine: typeof CLASSIFICATION_ENGINE_V2;
  /** Match points by outcome (FIBA: win 2, loss 1, forfeit 0; IBF bowling 3/1/0). */
  readonly matchPoints: readonly {
    readonly outcome: 'WIN' | 'DRAW' | 'LOSS' | 'WALKOVER_WIN' | 'WALKOVER_LOSS' | 'RETIRED';
    readonly points: number;
  }[];
  readonly criteria: readonly StandingsCriterion[];
  /** FIBA D.1.4: restart from the first criterion once any entrant is separated. */
  readonly restartOnSeparation: boolean;
  readonly exclusions?: {
    /** ITF J §57: drop every match of an entrant who gave a walkover. */
    readonly walkoverGiverAllMatches?: boolean;
    readonly onlyEntrantsWhoCompletedAll?: boolean;
    readonly retiredCountsAsCompleted?: boolean;
  };
  /** FIBA D.4: comparing same-rank entrants across groups (e.g. best third). */
  readonly crossGroup?: readonly StandingsCriterion[];
  readonly minimumInputStatus: 'PROVISIONAL' | 'OFFICIAL' | 'FINAL';
}

export type MetricTieBreak =
  | { readonly kind: 'COUNT_BACK'; readonly segments: readonly number[] }
  | { readonly kind: 'PLACE_SUM' }
  | { readonly kind: 'LAST_ROUND_PLACE' }
  | { readonly kind: 'FINER_PRECISION' }
  | { readonly kind: 'HIGHEST_SINGLE' }
  | { readonly kind: 'ORGANIZER_LOT' }
  | { readonly kind: 'SHARED' };

export interface MetricPolicySpec {
  readonly family: 'METRIC';
  readonly targetEngine: typeof CLASSIFICATION_ENGINE_V2;
  /** Aggregate over rounds/contests before ordering (golf: SUM strokes; GC: SUM adjusted time). */
  readonly aggregate: { readonly fn: 'SUM' | 'MIN' | 'MAX' | 'BEST_N'; readonly n?: number };
  readonly keys: readonly {
    readonly metric: string;
    readonly order: 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER';
    readonly source: 'PRIMARY_MARK' | 'PERFORMANCE' | 'ADJUSTED_MARK';
  }[];
  readonly tieBreak: readonly MetricTieBreak[];
  /** Finishers first; then non-finishers in this order. */
  readonly statusOrder: readonly ('NOT_PLACED' | 'PULLED' | 'DNF' | 'DQ' | 'DNS')[];
  /**
   * Sub-classifications of the same contests by a DECLARED entry attribute (e.g. ageBand). Gender
   * or age is never inferred from identity data, so subsets group by declared values only.
   */
  readonly subsetsByAttribute?: readonly string[];
  /** Team score derived from INDIVIDUAL results grouped by a declared team affiliation. */
  readonly teamDerived?: {
    readonly groupByAttribute: string;
    readonly scorers: number;
    readonly fn: 'SUM_OF_PLACES' | 'SUM_OF_TIMES';
    readonly incompleteTeam: 'EXCLUDE';
  };
  readonly minimumInputStatus: 'PROVISIONAL' | 'OFFICIAL' | 'FINAL';
}

export type ClassificationPolicyV2Spec = StandingsPolicySpec | MetricPolicySpec;

export interface PolicyIssueV2 {
  readonly path: string;
  readonly message: string;
}

const METRIC = /^[a-z][A-Za-z0-9]{0,63}$/;
const STATUSES = ['PROVISIONAL', 'OFFICIAL', 'FINAL'];

function criterionIssues(
  c: StandingsCriterion,
  path: string,
  depth: number,
  out: PolicyIssueV2[],
): void {
  if (depth > 3) {
    out.push({ path, message: 'criteria nest at most three levels' });
    return;
  }
  switch (c.kind) {
    case 'POINTS':
    case 'WINS':
    case 'WIN_RATIO':
    case 'SEED':
    case 'ORGANIZER_LOT':
      return;
    case 'MATCHES_PLAYED':
      if (c.order !== 'ASC' && c.order !== 'DESC')
        out.push({ path: `${path}/order`, message: 'ASC or DESC' });
      return;
    case 'DIFFERENCE':
    case 'RATIO_PERCENT':
      if (!METRIC.test(c.forMetric) || !METRIC.test(c.againstMetric))
        out.push({ path, message: 'needs a for and an against metric' });
      return;
    case 'SUM':
    case 'AVERAGE':
      if (!METRIC.test(c.metric)) out.push({ path: `${path}/metric`, message: 'invalid metric' });
      if (
        c.capPerContest !== undefined &&
        (!Number.isSafeInteger(c.capPerContest) || c.capPerContest < 1)
      )
        out.push({ path: `${path}/capPerContest`, message: 'positive integer' });
      return;
    case 'HEAD_TO_HEAD':
    case 'TIED_SUBSET':
      if (c.sub.length === 0) out.push({ path: `${path}/sub`, message: 'needs sub-criteria' });
      c.sub.forEach((s, i) => criterionIssues(s, `${path}/sub/${i}`, depth + 1, out));
      if (c.kind === 'TIED_SUBSET' && (!Number.isInteger(c.minTied) || c.minTied < 2))
        out.push({ path: `${path}/minTied`, message: 'at least 2' });
      return;
    default:
      out.push({ path, message: 'unknown criterion' });
  }
}

/** Closed-vocabulary validation of a v2 policy (no floats, no scripting, terminal tie rule). */
export function validateClassificationPolicyV2(spec: ClassificationPolicyV2Spec): PolicyIssueV2[] {
  const out: PolicyIssueV2[] = [];
  if (spec.targetEngine !== CLASSIFICATION_ENGINE_V2)
    out.push({ path: '/targetEngine', message: 'unsupported engine' });
  if (!STATUSES.includes(spec.minimumInputStatus))
    out.push({ path: '/minimumInputStatus', message: 'invalid status' });
  if (spec.family === 'STANDINGS') {
    if (spec.matchPoints.length === 0) out.push({ path: '/matchPoints', message: 'required' });
    spec.matchPoints.forEach((m, i) => {
      if (!Number.isSafeInteger(m.points) || m.points < 0 || m.points > 10)
        out.push({ path: `/matchPoints/${i}/points`, message: 'integer 0..10' });
    });
    if (spec.criteria.length === 0 || spec.criteria.length > 12)
      out.push({ path: '/criteria', message: '1–12 criteria' });
    spec.criteria.forEach((c, i) => criterionIssues(c, `/criteria/${i}`, 0, out));
    (spec.crossGroup ?? []).forEach((c, i) => criterionIssues(c, `/crossGroup/${i}`, 0, out));
    const last = spec.criteria.at(-1)?.kind;
    if (last !== 'ORGANIZER_LOT' && last !== 'SEED')
      out.push({
        path: '/criteria',
        message: 'must end with SEED or ORGANIZER_LOT (never an implicit order)',
      });
  } else if (spec.family === 'METRIC') {
    if (spec.keys.length === 0 || spec.keys.length > 8)
      out.push({ path: '/keys', message: '1–8 keys' });
    spec.keys.forEach((k, i) => {
      if (!METRIC.test(k.metric))
        out.push({ path: `/keys/${i}/metric`, message: 'invalid metric' });
    });
    if (spec.aggregate.fn === 'BEST_N' && (spec.aggregate.n === undefined || spec.aggregate.n < 1))
      out.push({ path: '/aggregate/n', message: 'BEST_N needs n ≥ 1' });
    spec.tieBreak.forEach((t, i) => {
      if (
        t.kind === 'COUNT_BACK' &&
        (t.segments.length === 0 || !t.segments.every((s) => Number.isInteger(s) && s > 0))
      )
        out.push({ path: `/tieBreak/${i}/segments`, message: 'positive hole/segment counts' });
    });
    const last = spec.tieBreak.at(-1)?.kind;
    if (last !== 'SHARED' && last !== 'ORGANIZER_LOT')
      out.push({ path: '/tieBreak', message: 'must end with SHARED or ORGANIZER_LOT' });
    (spec.subsetsByAttribute ?? []).forEach((a, i) => {
      if (!/^[a-z][A-Za-z0-9]{0,31}$/.test(a))
        out.push({ path: `/subsetsByAttribute/${i}`, message: 'names a declared entry attribute' });
    });
    if (
      spec.teamDerived !== undefined &&
      (spec.teamDerived.scorers < 1 || spec.teamDerived.scorers > 20)
    )
      out.push({ path: '/teamDerived/scorers', message: '1..20' });
  } else out.push({ path: '/family', message: 'STANDINGS or METRIC' });
  return out;
}

export interface ClassificationTemplate {
  readonly code: string;
  readonly name: string;
  readonly spec: ClassificationPolicyV2Spec;
  readonly basis: RuleBasis;
}

const h2h2 = (sub: readonly StandingsCriterion[]): StandingsCriterion => ({
  kind: 'HEAD_TO_HEAD',
  sub,
  maxTied: 2,
});

/** Published templates (data, each citing its source). Executed by classification-engine/2 in ONCF-05C. */
export const CLASSIFICATION_TEMPLATES: readonly ClassificationTemplate[] = [
  {
    code: 'itf_rr',
    name: 'ITF round robin',
    basis: { kind: 'GOVERNING_RULE', source: 'ITF World Tennis Tour Juniors Regulations 2026 §57' },
    spec: {
      family: 'STANDINGS',
      targetEngine: CLASSIFICATION_ENGINE_V2,
      matchPoints: [{ outcome: 'WIN', points: 1 }],
      criteria: [
        { kind: 'WINS' },
        h2h2([{ kind: 'WINS' }]),
        { kind: 'RATIO_PERCENT', forMetric: 'setsWon', againstMetric: 'setsLost' },
        { kind: 'RATIO_PERCENT', forMetric: 'gamesWon', againstMetric: 'gamesLost' },
        { kind: 'ORGANIZER_LOT' },
      ],
      restartOnSeparation: false,
      exclusions: {
        walkoverGiverAllMatches: true,
        onlyEntrantsWhoCompletedAll: true,
        retiredCountsAsCompleted: true,
      },
      minimumInputStatus: 'PROVISIONAL',
    },
  },
  {
    code: 'fip_groups',
    name: 'FIP group table (pairs)',
    basis: { kind: 'GOVERNING_RULE', source: 'FIP Promises Tour Rulebook (2026), group tie-break' },
    spec: {
      family: 'STANDINGS',
      targetEngine: CLASSIFICATION_ENGINE_V2,
      matchPoints: [{ outcome: 'WIN', points: 1 }],
      criteria: [
        { kind: 'WINS' },
        {
          kind: 'TIED_SUBSET',
          minTied: 3,
          sub: [
            { kind: 'DIFFERENCE', forMetric: 'setsWon', againstMetric: 'setsLost' },
            { kind: 'DIFFERENCE', forMetric: 'gamesWon', againstMetric: 'gamesLost' },
          ],
        },
        h2h2([{ kind: 'WINS' }]),
        { kind: 'ORGANIZER_LOT' },
      ],
      restartOnSeparation: true,
      minimumInputStatus: 'PROVISIONAL',
    },
  },
  {
    code: 'fiba_5x5',
    name: 'FIBA classification (Appendix D)',
    basis: { kind: 'GOVERNING_RULE', source: 'FIBA Official Basketball Rules 2026, Appendix D' },
    spec: {
      family: 'STANDINGS',
      targetEngine: CLASSIFICATION_ENGINE_V2,
      matchPoints: [
        { outcome: 'WIN', points: 2 },
        { outcome: 'LOSS', points: 1 },
        { outcome: 'WALKOVER_WIN', points: 2 },
        { outcome: 'WALKOVER_LOSS', points: 0 },
      ],
      criteria: [
        { kind: 'POINTS' },
        {
          kind: 'HEAD_TO_HEAD',
          sub: [
            { kind: 'POINTS' },
            { kind: 'DIFFERENCE', forMetric: 'pointsFor', againstMetric: 'pointsAgainst' },
            { kind: 'SUM', metric: 'pointsFor' },
          ],
        },
        { kind: 'DIFFERENCE', forMetric: 'pointsFor', againstMetric: 'pointsAgainst' },
        { kind: 'SUM', metric: 'pointsFor' },
        { kind: 'ORGANIZER_LOT' },
      ],
      restartOnSeparation: true,
      crossGroup: [
        { kind: 'WIN_RATIO' },
        { kind: 'DIFFERENCE', forMetric: 'pointsFor', againstMetric: 'pointsAgainst' },
        { kind: 'SUM', metric: 'pointsFor' },
      ],
      minimumInputStatus: 'PROVISIONAL',
    },
  },
  {
    code: 'fiba_3x3',
    name: 'FIBA 3x3 pool standings',
    basis: { kind: 'GOVERNING_RULE', source: 'FIBA 3x3 Rules 2026 (KBA edition), Appendix D.1' },
    spec: {
      family: 'STANDINGS',
      targetEngine: CLASSIFICATION_ENGINE_V2,
      matchPoints: [{ outcome: 'WIN', points: 1 }],
      criteria: [
        { kind: 'WIN_RATIO' },
        h2h2([{ kind: 'WINS' }]),
        { kind: 'AVERAGE', metric: 'pointsFor', capPerContest: 21, excludeForfeits: true },
        { kind: 'SEED' },
      ],
      restartOnSeparation: false,
      minimumInputStatus: 'PROVISIONAL',
    },
  },
  {
    code: 'ibf_bowling_rr',
    name: 'Bowling round-robin match play (3/1/0)',
    basis: { kind: 'GOVERNING_RULE', source: 'IBF World Championships 2023 Rules & Regulations' },
    spec: {
      family: 'STANDINGS',
      targetEngine: CLASSIFICATION_ENGINE_V2,
      matchPoints: [
        { outcome: 'WIN', points: 3 },
        { outcome: 'DRAW', points: 1 },
      ],
      criteria: [{ kind: 'POINTS' }, { kind: 'SUM', metric: 'pins' }, { kind: 'ORGANIZER_LOT' }],
      restartOnSeparation: false,
      minimumInputStatus: 'PROVISIONAL',
    },
  },
  {
    code: 'road_race',
    name: 'Road race (gun time; category subsets)',
    basis: { kind: 'GOVERNING_RULE', source: 'World Athletics TR 19, TR 55' },
    spec: {
      family: 'METRIC',
      targetEngine: CLASSIFICATION_ENGINE_V2,
      aggregate: { fn: 'SUM' },
      keys: [{ metric: 'elapsedTimeMs', order: 'LOWER_IS_BETTER', source: 'PRIMARY_MARK' }],
      tieBreak: [{ kind: 'SHARED' }],
      statusOrder: ['DNF', 'DQ', 'DNS'],
      subsetsByAttribute: ['ageBand'],
      minimumInputStatus: 'PROVISIONAL',
    },
  },
  {
    code: 'swim_time',
    name: 'Swimming (equal times share places)',
    basis: { kind: 'GOVERNING_RULE', source: 'World Aquatics CR Part Two (2026), Art. 11' },
    spec: {
      family: 'METRIC',
      targetEngine: CLASSIFICATION_ENGINE_V2,
      aggregate: { fn: 'MIN' },
      keys: [{ metric: 'elapsedTimeMs', order: 'LOWER_IS_BETTER', source: 'PRIMARY_MARK' }],
      tieBreak: [{ kind: 'SHARED' }],
      statusOrder: ['DQ', 'DNS'],
      subsetsByAttribute: ['ageBand'],
      minimumInputStatus: 'PROVISIONAL',
    },
  },
  {
    code: 'golf_stroke',
    name: 'Golf stroke play leaderboard (count-back)',
    basis: { kind: 'GOVERNING_RULE', source: 'Rules of Golf 3.3; Committee Procedures 5A(6)' },
    spec: {
      family: 'METRIC',
      targetEngine: CLASSIFICATION_ENGINE_V2,
      aggregate: { fn: 'SUM' },
      keys: [{ metric: 'strokes', order: 'LOWER_IS_BETTER', source: 'PRIMARY_MARK' }],
      tieBreak: [{ kind: 'COUNT_BACK', segments: [9, 6, 3, 1] }, { kind: 'ORGANIZER_LOT' }],
      statusOrder: ['DQ', 'DNF', 'DNS'],
      minimumInputStatus: 'PROVISIONAL',
    },
  },
  {
    code: 'golf_stableford',
    name: 'Golf Stableford leaderboard',
    basis: { kind: 'GOVERNING_RULE', source: 'Rules of Golf 21.1' },
    spec: {
      family: 'METRIC',
      targetEngine: CLASSIFICATION_ENGINE_V2,
      aggregate: { fn: 'SUM' },
      keys: [{ metric: 'stablefordPoints', order: 'HIGHER_IS_BETTER', source: 'PRIMARY_MARK' }],
      tieBreak: [{ kind: 'COUNT_BACK', segments: [9, 6, 3, 1] }, { kind: 'ORGANIZER_LOT' }],
      statusOrder: ['DQ', 'DNS'],
      minimumInputStatus: 'PROVISIONAL',
    },
  },
  {
    code: 'bowling_pinfall',
    name: 'Bowling aggregate pinfall',
    basis: { kind: 'GOVERNING_RULE', source: 'ABF championship rules (IBF Asia zone), Rule 403' },
    spec: {
      family: 'METRIC',
      targetEngine: CLASSIFICATION_ENGINE_V2,
      aggregate: { fn: 'SUM' },
      keys: [{ metric: 'pins', order: 'HIGHER_IS_BETTER', source: 'PRIMARY_MARK' }],
      tieBreak: [{ kind: 'HIGHEST_SINGLE' }, { kind: 'SHARED' }],
      statusOrder: ['DQ', 'DNS'],
      minimumInputStatus: 'PROVISIONAL',
    },
  },
  {
    code: 'cycling_gc',
    name: 'Cycling general classification',
    basis: { kind: 'GOVERNING_RULE', source: 'UCI Regulations Part 2, 2.6.014–2.6.015' },
    spec: {
      family: 'METRIC',
      targetEngine: CLASSIFICATION_ENGINE_V2,
      aggregate: { fn: 'SUM' },
      keys: [{ metric: 'elapsedTimeMs', order: 'LOWER_IS_BETTER', source: 'ADJUSTED_MARK' }],
      tieBreak: [
        { kind: 'FINER_PRECISION' },
        { kind: 'PLACE_SUM' },
        { kind: 'LAST_ROUND_PLACE' },
        { kind: 'SHARED' },
      ],
      statusOrder: ['NOT_PLACED', 'DNF', 'DQ', 'DNS'],
      subsetsByAttribute: ['ageBand'],
      minimumInputStatus: 'PROVISIONAL',
    },
  },
];

/** The canonical classification templates as a provisioning manifest (version histories). */
export const CANONICAL_CLASSIFICATION_TEMPLATES: readonly {
  readonly code: string;
  readonly name: string;
  readonly versions: readonly {
    readonly spec: ClassificationPolicyV2Spec;
    readonly basis: RuleBasis;
  }[];
}[] = CLASSIFICATION_TEMPLATES.map((t) => ({
  code: t.code,
  name: t.name,
  versions: [{ spec: t.spec, basis: t.basis }],
}));
