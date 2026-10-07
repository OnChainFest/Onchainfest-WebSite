import type { BrObjectSchema } from '@br/canonical';
import type { FormatRequirements } from '../capabilities';
import {
  assertEngineInput,
  chooseContestType,
  FormatEngineError,
  type CompetitionFormatEngineV2,
  type FormatEngineInput,
} from './engine';
import { PlanBuilder, type PlanContestV2, type PlanDocumentV2 } from './plan-v2';
import {
  blocks,
  centreOutLanes,
  composeHeats,
  crossoverEntrants,
  evenGroupSizes,
  fieldEntries,
  knockoutStage,
  laneSlots,
  nextPowerOfTwo,
  participantRef,
  roundRobinStage,
  serpentineGroups,
  stepladderStage,
  type SlotRef,
} from './stages';

/**
 * ONCF-05B format engines (ADR-0024 versioned, ADR-0053 capability-declared, ADR-0054 plan v2).
 *
 * Each engine is a sport-neutral FORMAT template composed from the four stage primitives. It
 * declares the capabilities it requires; it never reads a sport code. Configuration is flat
 * (integer / boolean / enum) so the organizer builder renders it generically, and default-valued
 * members are dropped by canonicalization — engines therefore apply their own defaults.
 */

type Config = Readonly<Record<string, unknown>>;
const int = (c: Config, key: string, def: number): number =>
  typeof c[key] === 'number' ? (c[key] as number) : def;
const bool = (c: Config, key: string, def: boolean): boolean =>
  typeof c[key] === 'boolean' ? (c[key] as boolean) : def;
const str = <T extends string>(c: Config, key: string, def: T): T =>
  typeof c[key] === 'string' ? (c[key] as T) : def;

const schema = (properties: BrObjectSchema['properties']): BrObjectSchema => ({
  type: 'object',
  properties,
  additionalProperties: false,
});
const intProp = (minimum: number, maximum: number, def?: number, description?: string) => ({
  type: 'integer' as const,
  minimum,
  maximum,
  ...(def === undefined ? {} : { default: def }),
  ...(description === undefined ? {} : { description }),
});
const boolProp = (def: boolean, description?: string) => ({
  type: 'boolean' as const,
  default: def,
  ...(description === undefined ? {} : { description }),
});
const enumProp = (values: readonly string[], def: string, description?: string) => ({
  type: 'string' as const,
  enum: values,
  default: def,
  ...(description === undefined ? {} : { description }),
});

function v2Engine(
  e: Omit<CompetitionFormatEngineV2, 'generate' | 'planVersion'> & {
    readonly requires: FormatRequirements;
    build(input: FormatEngineInput, b: PlanBuilder): void;
  },
): CompetitionFormatEngineV2 {
  const { build, ...rest } = e;
  const engine: CompetitionFormatEngineV2 = {
    ...rest,
    planVersion: 2,
    generate(input: FormatEngineInput): PlanDocumentV2 {
      assertEngineInput(engine, input);
      const b = new PlanBuilder();
      build(input, b);
      return b.build(engine.id, engine.version);
    },
  };
  return engine;
}

// ───────────────────────────── head-to-head ─────────────────────────────

const KO_PROPS = {
  drawSize: intProp(0, 256, 0, 'Bracket size (power of two); 0 = next power of two'),
  thirdPlace: boolProp(false, 'Play-off between the semifinal losers'),
};
const drawSizeFor = (c: Config, n: number) => {
  const d = int(c, 'drawSize', 0);
  return d === 0 ? nextPowerOfTwo(n) : d;
};

/** SINGLE_ELIMINATION v2: explicit draw size (ITF 24/48 draws sit in 32/64), optional third place. */
export const singleEliminationV2 = v2Engine({
  id: 'single-elimination',
  version: 2,
  displayName: 'Single elimination',
  configurationSchema: schema(KO_PROPS),
  contestType: 'MATCH',
  minParticipants: 2,
  maxParticipants: 256,
  requires: { contestTypes: { allOf: ['MATCH'] } },
  build(input, b) {
    const s = b.stage('KNOCKOUT', 'Main draw');
    knockoutStage(b, s, input.seedOrder.map(participantRef), {
      drawSize: drawSizeFor(input.config, input.seedOrder.length),
      thirdPlace: bool(input.config, 'thirdPlace', false),
      contestType: 'MATCH',
    });
  },
});

const GROUP_PROPS = {
  groupCount: intProp(1, 32, 1, 'Number of groups'),
  repeatTwoEntrantGroups: boolProp(true, 'A group of two plays each other twice'),
  higherSeedsToSmallerGroups: boolProp(
    true,
    'With uneven groups, higher seeds go to the smaller groups',
  ),
};

function buildGroups(
  input: FormatEngineInput,
  b: PlanBuilder,
  label: string,
): { stageKey: string; groupCount: number } {
  const groupCount = int(input.config, 'groupCount', 1);
  const sizes = evenGroupSizes(input.seedOrder.length, groupCount);
  const groups = serpentineGroups(
    input.seedOrder,
    sizes,
    bool(input.config, 'higherSeedsToSmallerGroups', true),
  );
  const stageKey = b.stage(
    'ROUND_ROBIN',
    label,
    groupCount > 1 ? { kind: 'COMPETITIVE', method: 'GROUPS' } : undefined,
  );
  roundRobinStage(b, stageKey, groups, {
    contestType: 'MATCH',
    repeatTwoEntrantGroups: bool(input.config, 'repeatTwoEntrantGroups', true),
  });
  return { stageKey, groupCount };
}

/** ROUND_ROBIN v2: one table or several competitive groups (serpentine). */
export const roundRobinV2 = v2Engine({
  id: 'round-robin',
  version: 2,
  displayName: 'Round robin',
  configurationSchema: schema(GROUP_PROPS),
  contestType: 'MATCH',
  minParticipants: 2,
  maxParticipants: 256,
  requires: { contestTypes: { allOf: ['MATCH'] }, partitionKinds: ['COMPETITIVE'] },
  build(input, b) {
    buildGroups(input, b, 'Round robin');
  },
});

/** Groups → knockout: group ranks fill a seeded knockout by fixed crossover (no same-group R1 tie). */
export const groupsKnockoutV1 = v2Engine({
  id: 'groups-knockout',
  version: 1,
  displayName: 'Groups → knockout',
  configurationSchema: schema({
    ...GROUP_PROPS,
    groupCount: intProp(2, 32, 2, 'Number of groups'),
    qualifiersPerGroup: intProp(1, 8, 2, 'Qualifiers per group'),
    bestRankedExtra: intProp(0, 16, 0, 'Extra qualifiers: best of the next rank across groups'),
    thirdPlace: KO_PROPS.thirdPlace,
  }),
  contestType: 'MATCH',
  minParticipants: 3,
  maxParticipants: 256,
  requires: { contestTypes: { allOf: ['MATCH'] }, partitionKinds: ['COMPETITIVE'] },
  build(input, b) {
    const config = { ...input.config, groupCount: int(input.config, 'groupCount', 2) };
    const { stageKey, groupCount } = buildGroups({ ...input, config }, b, 'Group stage');
    const q = int(input.config, 'qualifiersPerGroup', 2);
    const extra = int(input.config, 'bestRankedExtra', 0);
    const smallest = Math.min(...evenGroupSizes(input.seedOrder.length, groupCount));
    if (q > smallest || (extra > 0 && q + 1 > smallest) || extra >= groupCount)
      throw new FormatEngineError('QUALIFIERS', 'more qualifiers than the groups can provide');
    const entrants = crossoverEntrants(stageKey, groupCount, q, extra);
    if (entrants.length < 2)
      throw new FormatEngineError('QUALIFIERS', 'at least two qualifiers are needed');
    const ko = b.stage('KNOCKOUT', 'Knockout');
    b.transition({
      kind: 'RANK_FROM_GROUP',
      fromStage: stageKey,
      toStage: ko,
      params: { qualifiersPerGroup: q, bestRankedExtra: extra },
    });
    knockoutStage(b, ko, entrants, {
      drawSize: nextPowerOfTwo(entrants.length),
      thirdPlace: bool(input.config, 'thirdPlace', false),
      contestType: 'MATCH',
    });
  },
});

// ───────────────────────────── race / field ─────────────────────────────

/** Mass start: one race, one start, every entrant ranked together. */
export const massStartV1 = v2Engine({
  id: 'mass-start',
  version: 1,
  displayName: 'Mass-start timed race',
  configurationSchema: schema({}),
  contestType: 'HEAT',
  minParticipants: 1,
  maxParticipants: 20000,
  requires: { contestTypes: { anyOf: ['HEAT'] }, startMethods: { anyOf: ['SINGLE_START'] } },
  build(input, b) {
    const s = b.stage('FIELD', 'Race', { kind: 'LOGISTIC', method: 'SINGLE_START' });
    b.round({
      key: `${s}-r1`,
      roundType: 'FINAL',
      label: 'Race',
      stageKey: s,
      byes: [],
      contests: [
        {
          key: `${s}-r1-c1`,
          sequence: b.nextContestSequence(),
          contestType: 'HEAT',
          slots: [],
          entries: fieldEntries(input.seedOrder),
        },
      ],
    });
  },
});

/** Wave start: consecutive start waves (logistic); one classification across all waves. */
export const waveStartV1 = v2Engine({
  id: 'wave-start',
  version: 1,
  displayName: 'Wave-start timed race',
  configurationSchema: schema({ waveCapacity: intProp(1, 20000, 500, 'Entrants per start wave') }),
  contestType: 'HEAT',
  minParticipants: 1,
  maxParticipants: 20000,
  requires: {
    contestTypes: { anyOf: ['HEAT'] },
    startMethods: { anyOf: ['WAVE_START'] },
    partitionKinds: ['LOGISTIC'],
  },
  build(input, b) {
    const s = b.stage('FIELD', 'Race', { kind: 'LOGISTIC', method: 'WAVE_START' });
    const waves = blocks(input.seedOrder, int(input.config, 'waveCapacity', 500));
    b.round({
      key: `${s}-r1`,
      roundType: 'FINAL',
      label: 'Race',
      stageKey: s,
      byes: [],
      contests: waves.map((wave, i) => ({
        key: `${s}-r1-c${i + 1}`,
        sequence: b.nextContestSequence(),
        contestType: 'HEAT' as const,
        partitionKey: `w${i + 1}`,
        slots: [],
        entries: fieldEntries(wave),
      })),
    });
  },
});

const LANE_PROPS = {
  lanes: intProp(3, 10, 8, 'Lanes'),
  circleSeededHeats: intProp(1, 3, 3, 'Number of final heats seeded in circle'),
  minPerHeat: intProp(1, 10, 3, 'Minimum entrants in the first heat'),
};

function laneHeatContests(
  b: PlanBuilder,
  roundKey: string,
  heats: readonly (readonly string[])[],
  lanes: number,
): PlanContestV2[] {
  const order = centreOutLanes(lanes);
  return heats.map((heat, i) => ({
    key: `${roundKey}-c${i + 1}`,
    sequence: b.nextContestSequence(),
    contestType: 'HEAT' as const,
    partitionKey: `h${i + 1}`,
    slots: laneSlots(heat, order),
  }));
}

/** Timed finals: heats seeded by entry time are logistic; one classification across all heats. */
export const timedFinalsV1 = v2Engine({
  id: 'timed-finals',
  version: 1,
  displayName: 'Timed finals',
  configurationSchema: schema(LANE_PROPS),
  contestType: 'HEAT',
  minParticipants: 1,
  maxParticipants: 2000,
  requires: {
    contestTypes: { anyOf: ['HEAT'] },
    startMethods: { anyOf: ['LANE_HEATS'] },
    partitionKinds: ['LOGISTIC'],
    entryAttributes: [{ key: 'entryTimeMs', valueType: 'DURATION_MS' }],
  },
  build(input, b) {
    const lanes = int(input.config, 'lanes', 8);
    const s = b.stage('FIELD', 'Timed final', { kind: 'LOGISTIC', method: 'LANE_HEATS' });
    const heats = composeHeats(
      input.seedOrder,
      lanes,
      'CIRCLE',
      int(input.config, 'circleSeededHeats', 3),
      int(input.config, 'minPerHeat', 3),
    );
    b.round({
      key: `${s}-r1`,
      roundType: 'FINAL',
      label: 'Timed final',
      stageKey: s,
      byes: [],
      contests: laneHeatContests(b, `${s}-r1`, heats, lanes),
    });
  },
});

/** Heats → final: competitive heats; Q by place per heat + q fastest; the final is laned by rank. */
export const heatsFinalV1 = v2Engine({
  id: 'heats-final',
  version: 1,
  displayName: 'Heats → final',
  configurationSchema: schema({
    ...LANE_PROPS,
    composition: enumProp(
      ['CIRCLE', 'ZIGZAG'],
      'CIRCLE',
      'Heat composition (CIRCLE: pool; ZIGZAG: track)',
    ),
    qualifyByPlace: intProp(0, 8, 0, 'Qualifiers by place per heat (Q)'),
    qualifyByTime: intProp(0, 10, 8, 'Further qualifiers by time across heats (q)'),
  }),
  contestType: 'HEAT',
  minParticipants: 2,
  maxParticipants: 2000,
  requires: {
    contestTypes: { anyOf: ['HEAT'] },
    startMethods: { anyOf: ['LANE_HEATS'] },
    partitionKinds: ['COMPETITIVE'],
    entryAttributes: [{ key: 'entryTimeMs', valueType: 'DURATION_MS' }],
  },
  build(input, b) {
    const lanes = int(input.config, 'lanes', 8);
    const order = centreOutLanes(lanes);
    if (input.seedOrder.length <= lanes) {
      // A single heat is a direct final (World Aquatics Art. 3.2).
      const s = b.stage('FIELD', 'Final');
      b.round({
        key: `${s}-r1`,
        roundType: 'FINAL',
        label: 'Final',
        stageKey: s,
        byes: [],
        contests: laneHeatContests(b, `${s}-r1`, [input.seedOrder], lanes),
      });
      return;
    }
    const heats = composeHeats(
      input.seedOrder,
      lanes,
      str(input.config, 'composition', 'CIRCLE'),
      int(input.config, 'circleSeededHeats', 3),
      int(input.config, 'minPerHeat', 3),
    );
    const qPlace = int(input.config, 'qualifyByPlace', 0);
    const qTime = int(input.config, 'qualifyByTime', 8);
    const finalists = qPlace * heats.length + qTime;
    if (finalists < 2 || finalists > lanes)
      throw new FormatEngineError(
        'QUALIFIERS',
        `Q × heats + q must fit the ${lanes} final lanes (got ${finalists})`,
      );
    const h = b.stage('HEATS', 'Heats', { kind: 'COMPETITIVE', method: 'LANE_HEATS' });
    b.round({
      key: `${h}-r1`,
      roundType: 'HEAT',
      label: 'Heats',
      stageKey: h,
      byes: [],
      contests: laneHeatContests(b, `${h}-r1`, heats, lanes),
    });
    const f = b.stage('FIELD', 'Final');
    const t = b.transition({
      kind: 'QUALIFY_BY_PLACE_AND_TIME',
      fromStage: h,
      toStage: f,
      params: { qualifyByPlace: qPlace, qualifyByTime: qTime, heats: heats.length },
    });
    b.round({
      key: `${f}-r1`,
      roundType: 'FINAL',
      label: 'Final',
      stageKey: f,
      byes: [],
      contests: [
        {
          key: `${f}-r1-c1`,
          sequence: b.nextContestSequence(),
          contestType: 'HEAT',
          slots: Array.from({ length: finalists }, (_, i) => ({
            slot: order[i] as number,
            source: 'QUALIFIER' as const,
            transitionKey: t,
            ordinal: i + 1,
          })).sort((x, y) => x.slot - y.slot),
        },
      ],
    });
  },
});

/** Interval start (time trial): one entrant every `intervalSeconds`, in seeding (start) order. */
export const intervalStartV1 = v2Engine({
  id: 'interval-start',
  version: 1,
  displayName: 'Interval-start time trial',
  configurationSchema: schema({
    intervalSeconds: intProp(10, 600, 60, 'Seconds between starters'),
  }),
  contestType: 'SESSION',
  minParticipants: 1,
  maxParticipants: 2000,
  requires: { contestTypes: { anyOf: ['SESSION'] }, startMethods: { anyOf: ['INTERVAL_START'] } },
  build(input, b) {
    const s = b.stage('FIELD', 'Time trial', { kind: 'LOGISTIC', method: 'INTERVAL_START' });
    b.round({
      key: `${s}-r1`,
      roundType: 'FINAL',
      label: 'Time trial',
      stageKey: s,
      byes: [],
      contests: [
        {
          key: `${s}-r1-c1`,
          sequence: b.nextContestSequence(),
          contestType: 'SESSION',
          slots: [],
          entries: fieldEntries(input.seedOrder, int(input.config, 'intervalSeconds', 60)),
        },
      ],
    });
  },
});

const MULTI_ROUND_PROPS = {
  rounds: intProp(1, 10, 1, 'Rounds (golf rounds, cycling stages, bowling blocks)'),
  groupSize: intProp(
    1,
    64,
    4,
    'Entrants per scheduling group (tee group, squad) for per-entrant contests',
  ),
  cutAfterRound: intProp(0, 9, 0, 'Cut after this round (0 = no cut)'),
  cutTopN: intProp(1, 2000, 70, 'Entrants who survive the cut'),
  cutIncludesTies: boolProp(true, 'Entrants tied at the cut line continue'),
  eliminateNonFinishers: boolProp(false, 'Non-finishers of a round leave the classification'),
};

/**
 * Multi-round field (cumulative classification). Per-entrant contests (SERIES: a golf round, a
 * bowling block) are grouped into logistic scheduling groups in round 1; HEAT/SESSION disciplines
 * get one contest per round (a cycling stage). Rounds after a cut or a non-finisher elimination are
 * DYNAMIC: their field is only known once the transition resolves (ONCF-05D).
 */
function buildMultiRound(
  input: FormatEngineInput,
  b: PlanBuilder,
  label: string,
  contestType: 'SERIES' | 'HEAT' | 'SESSION',
): void {
  const c = input.config;
  const rounds = int(c, 'rounds', 1);
  const cutAfter = int(c, 'cutAfterRound', 0);
  const eliminate = bool(c, 'eliminateNonFinishers', false);
  if (cutAfter >= rounds && cutAfter !== 0)
    throw new FormatEngineError('CONFIG', 'the cut must come before the last round');
  const perEntrant = contestType === 'SERIES';
  const s = b.stage(
    'FIELD',
    label,
    perEntrant
      ? { kind: 'LOGISTIC', method: 'GROUPED_ENTRANTS' }
      : { kind: 'LOGISTIC', method: contestType === 'SESSION' ? 'INTERVAL_START' : 'SINGLE_START' },
  );
  let dynamicFrom: string | undefined;
  for (let r = 1; r <= rounds; r++) {
    const roundKey = `${s}-r${r}`;
    const isLast = r === rounds;
    const roundLabel = rounds === 1 ? label : `Round ${r}`;
    if (dynamicFrom !== undefined) {
      b.round({
        key: roundKey,
        roundType: isLast ? 'FINAL' : 'SESSION',
        label: roundLabel,
        stageKey: s,
        byes: [],
        dynamicEntry: { transitionKey: dynamicFrom },
        contests: [],
      });
    } else {
      const contests: PlanContestV2[] = perEntrant
        ? (r === 1 ? blocks(input.seedOrder, int(c, 'groupSize', 4)) : [input.seedOrder]).flatMap(
            (group, gi) =>
              group.map((participantId) => ({
                key: `${roundKey}-c${input.seedOrder.indexOf(participantId) + 1}`,
                sequence: 0,
                contestType,
                ...(r === 1 ? { partitionKey: `t${gi + 1}` } : {}),
                slots: [{ slot: 1, source: 'PARTICIPANT' as const, participantId }],
              })),
          )
        : [
            {
              key: `${roundKey}-c1`,
              sequence: 0,
              contestType,
              slots: [],
              entries: fieldEntries(input.seedOrder),
            },
          ];
      b.round({
        key: roundKey,
        roundType: isLast ? 'FINAL' : 'SESSION',
        label: roundLabel,
        stageKey: s,
        byes: [],
        contests: contests.map((ct) => ({ ...ct, sequence: b.nextContestSequence() })),
      });
    }
    if (isLast) break;
    if (cutAfter === r)
      dynamicFrom = b.transition({
        kind: 'CUT',
        fromStage: s,
        toStage: s,
        afterRound: roundKey,
        params: { topN: int(c, 'cutTopN', 70), includeTies: bool(c, 'cutIncludesTies', true) },
      });
    else if (eliminate)
      dynamicFrom = b.transition({
        kind: 'ELIMINATE_NON_FINISHERS',
        fromStage: s,
        toStage: s,
        afterRound: roundKey,
        params: {},
      });
  }
}

/** Multi-round leaderboard / aggregate / stage race (cumulative classification; optional cut). */
export const multiRoundV1 = v2Engine({
  id: 'multi-round',
  version: 1,
  displayName: 'Multi-round cumulative classification',
  configurationSchema: schema(MULTI_ROUND_PROPS),
  contestType: 'SERIES',
  contestTypes: ['SERIES', 'HEAT', 'SESSION'],
  minParticipants: 1,
  maxParticipants: 2000,
  requires: { contestTypes: { anyOf: ['SERIES', 'HEAT', 'SESSION'] }, multiRound: true },
  build(input, b) {
    const t = chooseContestType(multiRoundV1, input.allowedContestTypes) as
      'SERIES' | 'HEAT' | 'SESSION';
    buildMultiRound(input, b, 'Leaderboard', t);
  },
});

/** Stableford points leaderboard (Rules of Golf 21.1): per-entrant rounds; optional cut. */
export const stablefordV1 = v2Engine({
  id: 'stableford',
  version: 1,
  displayName: 'Stableford',
  configurationSchema: schema(MULTI_ROUND_PROPS),
  contestType: 'SERIES',
  minParticipants: 1,
  maxParticipants: 2000,
  requires: {
    contestTypes: { allOf: ['SERIES'] },
    rulesetFamilies: { anyOf: ['STABLEFORD'] },
  },
  build(input, b) {
    buildMultiRound(input, b, 'Stableford', 'SERIES');
  },
});

/** Qualifying (per-entrant field) → stepladder or seeded knockout of the top K. */
export const qualifyingKnockoutV1 = v2Engine({
  id: 'qualifying-knockout',
  version: 1,
  displayName: 'Qualifying → final',
  configurationSchema: schema({
    qualifyingRounds: intProp(1, 4, 1, 'Qualifying rounds / blocks'),
    groupSize: MULTI_ROUND_PROPS.groupSize,
    qualifiers: intProp(2, 64, 4, 'Qualifiers for the finals'),
    ladder: enumProp(['STEPLADDER', 'BRACKET'], 'STEPLADDER', 'Finals shape'),
    thirdPlace: KO_PROPS.thirdPlace,
  }),
  contestType: 'SERIES',
  minParticipants: 2,
  maxParticipants: 2000,
  requires: { contestTypes: { allOf: ['SERIES', 'MATCH'] } },
  build(input, b) {
    const k = int(input.config, 'qualifiers', 4);
    if (k > input.seedOrder.length)
      throw new FormatEngineError('QUALIFIERS', 'more qualifiers than entrants');
    buildMultiRound(
      {
        ...input,
        config: {
          rounds: int(input.config, 'qualifyingRounds', 1),
          groupSize: int(input.config, 'groupSize', 4),
        },
      },
      b,
      'Qualifying',
      'SERIES',
    );
    const q = b.stages[0]?.key as string;
    const ladder = str(input.config, 'ladder', 'STEPLADDER');
    const f = b.stage('KNOCKOUT', ladder === 'STEPLADDER' ? 'Stepladder finals' : 'Finals');
    b.transition({
      kind: ladder === 'STEPLADDER' ? 'STEPLADDER' : 'RANK_TO_BRACKET',
      fromStage: q,
      toStage: f,
      params: { qualifiers: k },
    });
    const seats: SlotRef[] = Array.from({ length: k }, (_, i) => ({
      source: 'RANK_FROM_STAGE',
      stageKey: q,
      rank: i + 1,
    }));
    if (ladder === 'STEPLADDER') stepladderStage(b, f, seats, 'MATCH');
    else
      knockoutStage(b, f, seats, {
        drawSize: nextPowerOfTwo(k),
        thirdPlace: bool(input.config, 'thirdPlace', false),
        contestType: 'MATCH',
      });
  },
});

export const V2_ENGINES: readonly CompetitionFormatEngineV2[] = [
  singleEliminationV2,
  roundRobinV2,
  groupsKnockoutV1,
  massStartV1,
  waveStartV1,
  timedFinalsV1,
  heatsFinalV1,
  intervalStartV1,
  multiRoundV1,
  stablefordV1,
  qualifyingKnockoutV1,
];
