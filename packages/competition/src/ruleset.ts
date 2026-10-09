/**
 * Ruleset (scoring model) vocabulary — ONCF-05B (ADR-0059).
 *
 * A Ruleset says HOW ONE CONTEST is decided or measured; it is a separate versioned axis from the
 * DisciplineVersion (what is played, by whom) and the FormatVersion (how the event is organized).
 * ONCF-05B ships the closed family vocabulary and parameter validation only: no score is validated
 * or normalized here yet (ONCF-05C). Families are sport-neutral; a sport is represented only by
 * which families its DisciplineVersion allows and by parameter values (never by code branches).
 */

export const RulesetFamily = {
  /** Tennis, padel: sets of games, tie-breaks, deciding-point modes. */
  SETS_OF_GAMES: 'SETS_OF_GAMES',
  /** Basketball 5v5, wheelchair basketball: timed periods + overtime. */
  TIMED_PERIODS: 'TIMED_PERIODS',
  /** Basketball 3x3: time limit or target score, whichever first. */
  TIMED_OR_TARGET: 'TIMED_OR_TARGET',
  /** Running, swimming, cycling time trial, open water. */
  ELAPSED_TIME: 'ELAPSED_TIME',
  /** Cycling mass start: place by finish order, time with same-time bunches. */
  FINISH_ORDER_WITH_TIME: 'FINISH_ORDER_WITH_TIME',
  /** MTB cross-country (laps completed, then time). */
  LAPS_AND_TIME: 'LAPS_AND_TIME',
  /** Bowling: 10 frames, ≤ 300 per game, optional handicap / Baker. */
  FRAMES_PINFALL: 'FRAMES_PINFALL',
  /** Golf stroke play (gross / net). */
  STROKES: 'STROKES',
  /** Golf Stableford points (Rules of Golf 21.1). */
  STABLEFORD: 'STABLEFORD',
  /** Golf match play (holes up). */
  MATCH_PLAY_HOLES: 'MATCH_PLAY_HOLES',
} as const;
export type RulesetFamily = (typeof RulesetFamily)[keyof typeof RulesetFamily];
export const RULESET_FAMILIES: readonly RulesetFamily[] = Object.values(RulesetFamily);

/** Whether a template's rule comes from a governing body or from organizer practice. */
export type RuleBasis =
  | { readonly kind: 'GOVERNING_RULE'; readonly source: string }
  | { readonly kind: 'COMMON_PRACTICE'; readonly note: string };

export interface RulesetSpec {
  readonly family: RulesetFamily;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface RulesetIssue {
  readonly path: string;
  readonly message: string;
}

type ParamRule =
  | { readonly kind: 'int'; readonly min: number; readonly max: number; readonly optional?: true }
  | { readonly kind: 'enum'; readonly values: readonly string[]; readonly optional?: true }
  | { readonly kind: 'bool'; readonly optional?: true }
  | { readonly kind: 'decimal'; readonly optional?: true }
  | {
      readonly kind: 'intList';
      readonly min: number;
      readonly max: number;
      readonly optional?: true;
    }
  /** Names a declared entry attribute of the discipline (data, never a sport). */
  | { readonly kind: 'attributeKey'; readonly optional?: true };

const int = (min: number, max: number, optional?: true): ParamRule => ({
  kind: 'int',
  min,
  max,
  ...(optional ? { optional } : {}),
});
const oneOf = (values: readonly string[], optional?: true): ParamRule => ({
  kind: 'enum',
  values,
  ...(optional ? { optional } : {}),
});

const TIMING = {
  officialReference: oneOf(['GUN', 'WAVE_GUN', 'INDIVIDUAL_START', 'CHIP_START']),
  informationalReference: oneOf(['CHIP_START'], true),
  precisionMs: oneOf(['1000', '100', '10', '1']),
  rounding: oneOf(['UP', 'DOWN', 'TRUNCATE']),
  tieRule: oneOf([
    'EQUAL_PLACE',
    'FINER_PRECISION_THEN_LOTS',
    'SWIM_OFF_BY_DECISION',
    'JUDGES_ORDER',
  ]),
} as const satisfies Record<string, ParamRule>;

/** Closed parameter vocabulary per family (unknown parameters are refused). */
export const RULESET_PARAMETERS: Readonly<
  Record<RulesetFamily, Readonly<Record<string, ParamRule>>>
> = {
  SETS_OF_GAMES: {
    setsToWin: int(1, 3),
    gamesPerSet: int(4, 8),
    tiebreakAt: int(3, 8, true),
    tiebreakTo: int(5, 10, true),
    finalSet: oneOf(['FULL', 'MATCH_TIEBREAK_7', 'MATCH_TIEBREAK_10', 'ADVANTAGE']),
    deuce: oneOf(['ADVANTAGE', 'NO_AD', 'GOLDEN_POINT', 'STAR_POINT']),
    decidingPointReceiver: oneOf(['RECEIVER_CHOICE', 'SAME_GENDER_AS_SERVER'], true),
  },
  TIMED_PERIODS: {
    periods: int(1, 8),
    periodMinutes: int(1, 60),
    overtimeMinutes: int(1, 30, true),
    drawAllowed: { kind: 'bool' },
    forfeitScoreFor: int(0, 100, true),
    /** Score kept for the non-defaulting side when it was not ahead at the default (FIBA Art. 21: 2). */
    defaultScoreFor: int(0, 100, true),
  },
  TIMED_OR_TARGET: {
    minutes: int(1, 60),
    targetScore: int(1, 100),
    overtimeTargetMargin: int(1, 10),
    standingsPointCap: int(1, 100, true),
  },
  ELAPSED_TIME: {
    ...TIMING,
    /** TEAM entrants (relays): the official time is the team finish, or the sum of its legs. */
    teamTime: oneOf(['TEAM_FINISH', 'SUM_OF_LEGS'], true),
  },
  FINISH_ORDER_WITH_TIME: {
    ...TIMING,
    sameTimeGroups: { kind: 'bool' },
    notPlacedBeyondPercent: int(1, 100, true),
  },
  LAPS_AND_TIME: {
    ...TIMING,
    pulledRulePercent: int(1, 100, true),
  },
  FRAMES_PINFALL: {
    gamesPerBlock: int(1, 24),
    handicapPercent: int(0, 100, true),
    handicapBasis: int(100, 300, true),
    /** Team game bowled in frame rotation (one team score per game) vs. members' games summed. */
    baker: { kind: 'bool' },
    /** The declared entry attribute holding the entering average (PARTICIPANT or MEMBER scope). */
    handicapAverageAttribute: { kind: 'attributeKey', optional: true },
  },
  STROKES: {
    holes: oneOf(['9', '18']),
    scoring: oneOf(['GROSS', 'NET']),
    allowancePercent: int(0, 100, true),
    maxScorePerHole: oneOf(['NONE', 'NET_DOUBLE_BOGEY'], true),
    /** INDIVIDUAL; BETTER_BALL (four-ball: best member score per hole); TEAM_BALL (one team ball). */
    teamFormat: oneOf(['INDIVIDUAL', 'BETTER_BALL', 'TEAM_BALL'], true),
    /** TEAM_BALL team handicap: members' course handicaps, lowest first, × these percentages. */
    teamAllowancePercents: { kind: 'intList', min: 0, max: 100, optional: true },
  },
  STABLEFORD: {
    holes: oneOf(['9', '18']),
    allowancePercent: int(0, 100),
    teamFormat: oneOf(['INDIVIDUAL', 'BETTER_BALL'], true),
  },
  MATCH_PLAY_HOLES: {
    holes: oneOf(['9', '18']),
    allowancePercent: int(0, 100),
    extraHoles: oneOf(['SUDDEN_DEATH', 'NONE']),
  },
};

function checkParam(rule: ParamRule, value: unknown, path: string, issues: RulesetIssue[]): void {
  switch (rule.kind) {
    case 'int':
      if (
        !Number.isSafeInteger(value) ||
        (value as number) < rule.min ||
        (value as number) > rule.max
      )
        issues.push({ path, message: `must be an integer in ${rule.min}..${rule.max}` });
      return;
    case 'enum':
      if (typeof value !== 'string' || !rule.values.includes(value))
        issues.push({ path, message: `must be one of ${rule.values.join(', ')}` });
      return;
    case 'bool':
      if (typeof value !== 'boolean') issues.push({ path, message: 'must be a boolean' });
      return;
    case 'decimal':
      if (typeof value !== 'string' || !/^-?(0|[1-9][0-9]{0,17})(\.[0-9]{1,9})?$/.test(value))
        issues.push({ path, message: 'must be a decimal string' });
      return;
    case 'attributeKey':
      if (typeof value !== 'string' || !/^[a-z][A-Za-z0-9]{0,31}$/.test(value))
        issues.push({ path, message: 'must name an entry attribute' });
      return;
    case 'intList':
      if (
        !Array.isArray(value) ||
        !value.every((v) => Number.isSafeInteger(v) && v >= rule.min && v <= rule.max)
      )
        issues.push({ path, message: `must be a list of integers in ${rule.min}..${rule.max}` });
  }
}

/** Validates a Ruleset spec: a known family and exactly its closed parameter vocabulary. */
export function validateRulesetSpec(spec: RulesetSpec): RulesetIssue[] {
  const issues: RulesetIssue[] = [];
  if (typeof spec !== 'object' || spec === null) return [{ path: '', message: 'required' }];
  for (const k of Object.keys(spec))
    if (k !== 'family' && k !== 'parameters')
      issues.push({ path: `/${k}`, message: 'unknown field' });
  const rules = RULESET_PARAMETERS[spec.family];
  if (rules === undefined)
    return [...issues, { path: '/family', message: 'unknown ruleset family' }];
  const params = spec.parameters;
  if (typeof params !== 'object' || params === null || Array.isArray(params))
    return [...issues, { path: '/parameters', message: 'must be an object' }];
  for (const k of Object.keys(params))
    if (rules[k] === undefined)
      issues.push({ path: `/parameters/${k}`, message: 'unknown parameter' });
  for (const [k, rule] of Object.entries(rules)) {
    const v = params[k];
    if (v === undefined) {
      if (rule.optional !== true) issues.push({ path: `/parameters/${k}`, message: 'required' });
      continue;
    }
    checkParam(rule, v, `/parameters/${k}`, issues);
  }
  // Cross-field coherence (family-generic; no sport identity involved).
  if (spec.family === 'SETS_OF_GAMES') {
    const p = params as { tiebreakAt?: number; gamesPerSet?: number };
    if (p.tiebreakAt !== undefined && p.gamesPerSet !== undefined && p.tiebreakAt > p.gamesPerSet)
      issues.push({ path: '/parameters/tiebreakAt', message: 'cannot exceed gamesPerSet' });
  }
  return issues;
}

/**
 * Published ruleset templates (data). Each carries its basis: a governing-body source, or an
 * explicit COMMON_PRACTICE label. Provisioned as catalog RulesetVersions (ONCF-05C) and pinned per
 * event; executed by `scoring/` (ONCF-05C).
 */
export interface RulesetTemplate {
  readonly code: string;
  readonly name: string;
  readonly spec: RulesetSpec;
  readonly basis: RuleBasis;
}

export const RULESET_TEMPLATES: readonly RulesetTemplate[] = [
  {
    code: 'sets-bo3-tiebreak',
    name: 'Best of 3 tie-break sets',
    spec: {
      family: 'SETS_OF_GAMES',
      parameters: {
        setsToWin: 2,
        gamesPerSet: 6,
        tiebreakAt: 6,
        tiebreakTo: 7,
        finalSet: 'FULL',
        deuce: 'ADVANTAGE',
      },
    },
    basis: { kind: 'GOVERNING_RULE', source: 'ITF Rules of Tennis 2026, Rules 6–7' },
  },
  {
    code: 'sets-2-plus-match-tiebreak-no-ad',
    name: '2 sets + 10-point match tie-break, No-Ad',
    spec: {
      family: 'SETS_OF_GAMES',
      parameters: {
        setsToWin: 2,
        gamesPerSet: 6,
        tiebreakAt: 6,
        tiebreakTo: 7,
        finalSet: 'MATCH_TIEBREAK_10',
        deuce: 'NO_AD',
      },
    },
    basis: { kind: 'GOVERNING_RULE', source: 'ITF Rules of Tennis 2026, Appendix VI; ITF J §35' },
  },
  {
    code: 'padel-bo3-star-point',
    name: 'Padel best of 3, tie-break sets, Star Point',
    spec: {
      family: 'SETS_OF_GAMES',
      parameters: {
        setsToWin: 2,
        gamesPerSet: 6,
        tiebreakAt: 6,
        tiebreakTo: 7,
        finalSet: 'FULL',
        deuce: 'STAR_POINT',
      },
    },
    basis: {
      kind: 'GOVERNING_RULE',
      source: 'FIP Rules of Padel (Dec 2025) Rule 1; Cupra FIP Tour §11.1.9',
    },
  },
  {
    code: 'padel-bo3-golden-point-super-tiebreak',
    name: 'Padel 2 sets + super tie-break, Golden Point',
    spec: {
      family: 'SETS_OF_GAMES',
      parameters: {
        setsToWin: 2,
        gamesPerSet: 6,
        tiebreakAt: 6,
        tiebreakTo: 7,
        finalSet: 'MATCH_TIEBREAK_10',
        deuce: 'GOLDEN_POINT',
      },
    },
    basis: { kind: 'GOVERNING_RULE', source: 'FIP Rules of Padel (Dec 2025), alternative methods' },
  },
  {
    code: 'basketball-4x10',
    name: 'Basketball 4 × 10 min, 5-min overtime',
    spec: {
      family: 'TIMED_PERIODS',
      parameters: {
        periods: 4,
        periodMinutes: 10,
        overtimeMinutes: 5,
        drawAllowed: false,
        forfeitScoreFor: 20,
      },
    },
    basis: { kind: 'GOVERNING_RULE', source: 'FIBA Official Basketball Rules 2026, Art. 8, 20' },
  },
  {
    code: 'wheelchair-basketball-4x10',
    name: 'Wheelchair basketball 4 × 10 min, extra periods',
    spec: {
      family: 'TIMED_PERIODS',
      parameters: { periods: 4, periodMinutes: 10, overtimeMinutes: 5, drawAllowed: false },
    },
    basis: {
      kind: 'GOVERNING_RULE',
      source: 'IWBF Quick Rule Guide (iwbf.org/our-sport/rules); overtime length UNVERIFIED',
    },
  },
  {
    code: '3x3-10min-21',
    name: '3x3: 10 min or first to 21, overtime first to +2',
    spec: {
      family: 'TIMED_OR_TARGET',
      parameters: { minutes: 10, targetScore: 21, overtimeTargetMargin: 2, standingsPointCap: 21 },
    },
    basis: {
      kind: 'GOVERNING_RULE',
      source: 'FIBA 3x3 Rules 2026 (KBA edition), Art. 8, App. D.1',
    },
  },
  {
    code: 'road-gun-time',
    name: 'Road race: gun time official, net informational, whole second up',
    spec: {
      family: 'ELAPSED_TIME',
      parameters: {
        officialReference: 'WAVE_GUN',
        informationalReference: 'CHIP_START',
        precisionMs: '1000',
        rounding: 'UP',
        tieRule: 'JUDGES_ORDER',
      },
    },
    basis: { kind: 'GOVERNING_RULE', source: 'World Athletics TR 19 (transponders), TR 55' },
  },
  {
    code: 'track-fat',
    name: 'Track: fully automatic timing to 0.01 s',
    spec: {
      family: 'ELAPSED_TIME',
      parameters: {
        officialReference: 'GUN',
        precisionMs: '10',
        rounding: 'UP',
        tieRule: 'FINER_PRECISION_THEN_LOTS',
      },
    },
    basis: { kind: 'GOVERNING_RULE', source: 'World Athletics TR 19, TR 21' },
  },
  {
    code: 'swim-hundredths',
    name: 'Swimming: 1/100 s, equal times share places',
    spec: {
      family: 'ELAPSED_TIME',
      parameters: {
        officialReference: 'GUN',
        precisionMs: '10',
        rounding: 'TRUNCATE',
        tieRule: 'EQUAL_PLACE',
      },
    },
    basis: { kind: 'GOVERNING_RULE', source: 'World Aquatics CR Part Two (2026), Art. 11' },
  },
  {
    code: 'cycling-itt',
    name: 'Cycling time trial: 0.1 s',
    spec: {
      family: 'ELAPSED_TIME',
      parameters: {
        officialReference: 'INDIVIDUAL_START',
        precisionMs: '100',
        rounding: 'DOWN',
        tieRule: 'FINER_PRECISION_THEN_LOTS',
      },
    },
    basis: { kind: 'GOVERNING_RULE', source: 'UCI Regulations Part 2, 2.4.015' },
  },
  {
    code: 'cycling-road-same-time',
    name: 'Cycling mass start: finish order, same time per bunch',
    spec: {
      family: 'FINISH_ORDER_WITH_TIME',
      parameters: {
        officialReference: 'GUN',
        precisionMs: '1000',
        rounding: 'DOWN',
        tieRule: 'JUDGES_ORDER',
        sameTimeGroups: true,
        notPlacedBeyondPercent: 8,
      },
    },
    basis: { kind: 'GOVERNING_RULE', source: 'UCI Regulations Part 2, 2.3.037–2.3.041' },
  },
  {
    code: 'mtb-laps',
    name: 'MTB XC: laps then time (80% rule)',
    spec: {
      family: 'LAPS_AND_TIME',
      parameters: {
        officialReference: 'GUN',
        precisionMs: '1000',
        rounding: 'DOWN',
        tieRule: 'JUDGES_ORDER',
        pulledRulePercent: 80,
      },
    },
    basis: {
      kind: 'COMMON_PRACTICE',
      note: 'UCI Part 4 not verified; 80% rule from secondary sources',
    },
  },
  {
    code: 'bowling-6-games-scratch',
    name: 'Bowling: 6-game block, scratch',
    spec: { family: 'FRAMES_PINFALL', parameters: { gamesPerBlock: 6, baker: false } },
    basis: { kind: 'GOVERNING_RULE', source: 'ABF championship rules (IBF Asia zone)' },
  },
  {
    code: 'bowling-handicap-90-220',
    name: 'Bowling: handicap 90% of 220',
    spec: {
      family: 'FRAMES_PINFALL',
      parameters: {
        gamesPerBlock: 3,
        handicapPercent: 90,
        handicapBasis: 220,
        baker: false,
        handicapAverageAttribute: 'average',
      },
    },
    basis: { kind: 'COMMON_PRACTICE', note: 'league default; USBC formula % × (basis − average)' },
  },
  {
    code: 'bowling-team-baker-5',
    name: 'Bowling team, Baker format, 5 games',
    spec: { family: 'FRAMES_PINFALL', parameters: { gamesPerBlock: 5, baker: true } },
    basis: { kind: 'GOVERNING_RULE', source: 'IBF World Championships 2023 Rules & Regulations' },
  },
  {
    code: 'golf-stroke-gross',
    name: 'Golf stroke play, gross',
    spec: { family: 'STROKES', parameters: { holes: '18', scoring: 'GROSS' } },
    basis: { kind: 'GOVERNING_RULE', source: 'Rules of Golf 3.3' },
  },
  {
    code: 'golf-fourball-net-85',
    name: 'Golf four-ball stroke play, net, 85%',
    spec: {
      family: 'STROKES',
      parameters: { holes: '18', scoring: 'NET', allowancePercent: 85, teamFormat: 'BETTER_BALL' },
    },
    basis: { kind: 'GOVERNING_RULE', source: 'Rules of Golf 23; WHS Appendix C (allowance [S])' },
  },
  {
    code: 'golf-scramble-4-net',
    name: 'Golf scramble (4), net, 25/20/15/10%',
    spec: {
      family: 'STROKES',
      parameters: {
        holes: '18',
        scoring: 'NET',
        teamFormat: 'TEAM_BALL',
        teamAllowancePercents: [25, 20, 15, 10],
      },
    },
    basis: {
      kind: 'COMMON_PRACTICE',
      note: 'scramble is not a Rules of Golf form; WHS allowances [S]',
    },
  },
  {
    code: 'relay-team-finish',
    name: 'Relay: team finish time, 1/100 s',
    spec: {
      family: 'ELAPSED_TIME',
      parameters: {
        officialReference: 'GUN',
        precisionMs: '10',
        rounding: 'UP',
        tieRule: 'FINER_PRECISION_THEN_LOTS',
        teamTime: 'TEAM_FINISH',
      },
    },
    basis: { kind: 'GOVERNING_RULE', source: 'World Athletics TR 24; World Aquatics Art. 10.4' },
  },
  {
    code: 'golf-stroke-net-95',
    name: 'Golf stroke play, net, 95% allowance',
    spec: {
      family: 'STROKES',
      parameters: { holes: '18', scoring: 'NET', allowancePercent: 95, maxScorePerHole: 'NONE' },
    },
    basis: { kind: 'GOVERNING_RULE', source: 'Rules of Golf 3.3; WHS Appendix C' },
  },
  {
    code: 'golf-stableford-95',
    name: 'Golf Stableford, 95% allowance',
    spec: { family: 'STABLEFORD', parameters: { holes: '18', allowancePercent: 95 } },
    basis: { kind: 'GOVERNING_RULE', source: 'Rules of Golf 21.1; WHS Appendix C' },
  },
  {
    code: 'golf-match-play-100',
    name: 'Golf match play, 100% allowance',
    spec: {
      family: 'MATCH_PLAY_HOLES',
      parameters: { holes: '18', allowancePercent: 100, extraHoles: 'SUDDEN_DEATH' },
    },
    basis: { kind: 'GOVERNING_RULE', source: 'Rules of Golf 3.2; WHS Appendix C' },
  },
];
