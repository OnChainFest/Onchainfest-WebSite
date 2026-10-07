import type { BrObjectSchema } from '@br/canonical';
import type { EventCategory } from './category';
import type {
  DisciplineVersionSpec,
  EntryAttributeSpec,
  MetricSpec,
  ParticipationSpec,
} from './catalog';
import type { DisciplineCapabilitiesSpec } from './capabilities';

/**
 * The canonical OnChainFest sport catalog (ONCF-03A; eight sports since ONCF-05B). Catalog rows
 * stay DATA in `sports.*`; this manifest is only the operator's declared input, applied
 * lookup-first by `CatalogStore.provision`. Each discipline and format lists its version HISTORY
 * (oldest first): existing versions must match the history, and missing later versions are created
 * and published — a deliberate operator step (`pnpm db:catalog:provision`), never a side effect.
 * Changing an existing version is refused as a conflict; a change is always a new version.
 *
 * Sports are represented only through this data (specs, capabilities, entry attributes) — no
 * engine, store or UI branches on a sport code (ADR-0053).
 */
export interface CatalogManifest {
  readonly sports: readonly {
    readonly code: string;
    readonly name: string;
    readonly disciplines: readonly {
      readonly code: string;
      readonly name: string;
      /** Version history, oldest first. The last entry is the current version. */
      readonly specs: readonly DisciplineVersionSpec[];
    }[];
  }[];
  readonly formats: readonly {
    readonly code: string;
    readonly name: string;
    /** Version history, oldest first: the engine each FormatVersion pins. */
    readonly versions: readonly { readonly engineId: string; readonly engineVersion: number }[];
  }[];
}

// ───────────────────────────── v1 specs (ONCF-03A; unchanged, hashes pinned) ─────────────────────────────

/** Head-to-head racket match scored in sets and games (the score is recorded, not decided here). */
const RACKET_MATCH: Omit<DisciplineVersionSpec, 'participation'> = {
  resultSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['setsWon', 'gamesWon'],
    properties: {
      setsWon: { type: 'integer', minimum: 0, maximum: 5 },
      gamesWon: { type: 'integer', minimum: 0, maximum: 99 },
    },
  },
  metrics: [
    { key: 'setsWon', valueType: 'INTEGER', unit: 'sets' },
    { key: 'gamesWon', valueType: 'INTEGER', unit: 'games' },
  ],
  comparator: {
    outcomeModel: 'WIN_LOSS_DRAW',
    primary: 'HEAD_TO_HEAD_WINNER',
    keys: [
      { metric: 'setsWon', order: 'HIGHER_IS_BETTER' },
      { metric: 'gamesWon', order: 'HIGHER_IS_BETTER' },
    ],
  },
  validation: { bounds: [{ metric: 'setsWon', min: '0', max: '3' }] },
  allowedContestTypes: ['MATCH'],
  evidenceExpectations: ['SIGNED_SCORESHEET'],
};

export const PADEL_DOUBLES_V1: DisciplineVersionSpec = {
  ...RACKET_MATCH,
  participation: { participantKinds: ['TEAM'], lineupSize: { min: 2, max: 2 } },
};

export const TENNIS_SINGLES_V1: DisciplineVersionSpec = {
  ...RACKET_MATCH,
  participation: { participantKinds: ['INDIVIDUAL'], lineupSize: { min: 1, max: 1 } },
};

export const TENNIS_DOUBLES_V1: DisciplineVersionSpec = {
  ...RACKET_MATCH,
  participation: { participantKinds: ['TEAM'], lineupSize: { min: 2, max: 2 } },
};

// ───────────────────────────── v2 building blocks (ONCF-05B) ─────────────────────────────

const intProp = (minimum: number, maximum: number) => ({
  type: 'integer' as const,
  minimum,
  maximum,
});

function metricsSpec(
  metrics: readonly (MetricSpec & { readonly min: number; readonly max: number })[],
): Pick<DisciplineVersionSpec, 'resultSchema' | 'metrics'> {
  const resultSchema: BrObjectSchema = {
    type: 'object',
    additionalProperties: false,
    required: metrics.map((m) => m.key),
    properties: Object.fromEntries(metrics.map((m) => [m.key, intProp(m.min, m.max)])),
  };
  return {
    resultSchema,
    metrics: metrics.map(({ key, valueType, unit }) => ({ key, valueType, unit })),
  };
}

const ATTR = {
  bib: { key: 'bib', valueType: 'TEXT', scope: 'PARTICIPANT', required: false },
  ageBand: { key: 'ageBand', valueType: 'TEXT', scope: 'PARTICIPANT', required: false },
  teamAffiliation: {
    key: 'teamAffiliation',
    valueType: 'TEXT',
    scope: 'PARTICIPANT',
    required: false,
  },
  predictedTimeMs: {
    key: 'predictedTimeMs',
    valueType: 'DURATION_MS',
    scope: 'PARTICIPANT',
    required: false,
    min: '0',
  },
  entryTimeMs: {
    key: 'entryTimeMs',
    valueType: 'DURATION_MS',
    scope: 'PARTICIPANT',
    required: false,
    min: '0',
  },
  seedPoints: {
    key: 'seedPoints',
    valueType: 'INTEGER',
    scope: 'PARTICIPANT',
    required: false,
    min: '0',
  },
  memberSeedPoints: {
    key: 'memberSeedPoints',
    valueType: 'INTEGER',
    scope: 'MEMBER',
    required: false,
    min: '0',
  },
  average: {
    key: 'average',
    valueType: 'INTEGER',
    scope: 'PARTICIPANT',
    required: false,
    min: '0',
    max: '300',
  },
  memberAverage: {
    key: 'memberAverage',
    valueType: 'INTEGER',
    scope: 'MEMBER',
    required: false,
    min: '0',
    max: '300',
  },
  handicapIndex: {
    key: 'handicapIndex',
    valueType: 'DECIMAL',
    scope: 'PARTICIPANT',
    required: false,
    min: '-10',
    max: '54',
  },
  memberHandicapIndex: {
    key: 'memberHandicapIndex',
    valueType: 'DECIMAL',
    scope: 'MEMBER',
    required: false,
    min: '-10',
    max: '54',
  },
  classificationPoints: {
    key: 'classificationPoints',
    valueType: 'DECIMAL',
    scope: 'MEMBER',
    required: false,
    min: '1.0',
    max: '4.5',
  },
} as const satisfies Record<string, EntryAttributeSpec>;

const caps = (c: DisciplineCapabilitiesSpec): DisciplineCapabilitiesSpec => c;
const individual: ParticipationSpec = {
  participantKinds: ['INDIVIDUAL'],
  lineupSize: { min: 1, max: 1 },
};
const pair: ParticipationSpec = {
  participantKinds: ['TEAM'],
  lineupSize: { min: 2, max: 2 },
  roster: { min: 2, max: 2 },
  substitution: 'NONE',
};

function racketV2(
  participation: ParticipationSpec,
  resource: 'TENNIS_COURT' | 'PADEL_COURT',
): DisciplineVersionSpec {
  return {
    specVersion: 2,
    ...RACKET_MATCH,
    participation,
    capabilities: caps({
      rulesetFamilies: ['SETS_OF_GAMES'],
      partitionKinds: ['COMPETITIVE'],
      startMethods: [],
      multiRound: false,
      resourceTypes: [resource],
    }),
    entryAttributes: [ATTR.seedPoints],
  };
}

const ELAPSED = metricsSpec([
  { key: 'elapsedTimeMs', valueType: 'DURATION_MS', unit: 'ms', min: 0, max: 2_000_000_000 },
]);
const TIME_COMPARATOR: DisciplineVersionSpec['comparator'] = {
  outcomeModel: 'RANKED',
  primary: 'METRICS',
  keys: [{ metric: 'elapsedTimeMs', order: 'LOWER_IS_BETTER' }],
};

function timed(
  participation: ParticipationSpec,
  contestTypes: DisciplineVersionSpec['allowedContestTypes'],
  capabilities: DisciplineCapabilitiesSpec,
  entryAttributes: readonly EntryAttributeSpec[],
  evidence: readonly string[],
): DisciplineVersionSpec {
  return {
    specVersion: 2,
    ...ELAPSED,
    comparator: TIME_COMPARATOR,
    validation: { bounds: [] },
    allowedContestTypes: contestTypes,
    participation,
    capabilities,
    entryAttributes,
    evidenceExpectations: evidence,
  };
}

const relayTeam = (rosterMax: number): ParticipationSpec => ({
  participantKinds: ['TEAM'],
  lineupSize: { min: 4, max: 4 },
  roster: { min: 4, max: rosterMax },
  lineupOrdered: true,
  substitution: 'BETWEEN_STAGES',
});

// Running (World Athletics): gun time official; waves are COMMON PRACTICE.
export const RUNNING_ROAD_V2 = timed(
  individual,
  ['HEAT'],
  caps({
    rulesetFamilies: ['ELAPSED_TIME'],
    partitionKinds: ['LOGISTIC'],
    startMethods: ['SINGLE_START', 'WAVE_START'],
    multiRound: false,
    resourceTypes: ['ROAD_COURSE'],
  }),
  [ATTR.bib, ATTR.ageBand, ATTR.teamAffiliation, ATTR.predictedTimeMs],
  ['TIMING_SYSTEM_EXPORT'],
);
export const RUNNING_TRACK_V2 = timed(
  individual,
  ['HEAT'],
  caps({
    rulesetFamilies: ['ELAPSED_TIME'],
    partitionKinds: ['LOGISTIC', 'COMPETITIVE'],
    startMethods: ['SINGLE_START', 'LANE_HEATS'],
    multiRound: false,
    resourceTypes: ['TRACK'],
  }),
  [ATTR.bib, ATTR.ageBand, ATTR.entryTimeMs],
  ['TIMING_SYSTEM_EXPORT'],
);
export const RUNNING_RELAY_V2 = timed(
  relayTeam(6),
  ['HEAT'],
  caps({
    rulesetFamilies: ['ELAPSED_TIME'],
    partitionKinds: ['LOGISTIC', 'COMPETITIVE'],
    startMethods: ['SINGLE_START', 'WAVE_START', 'LANE_HEATS'],
    multiRound: false,
    resourceTypes: ['ROAD_COURSE', 'TRACK'],
  }),
  [ATTR.bib, ATTR.entryTimeMs, ATTR.predictedTimeMs],
  ['TIMING_SYSTEM_EXPORT'],
);

// Swimming (World Aquatics).
const POOL_CAPS = caps({
  rulesetFamilies: ['ELAPSED_TIME'],
  partitionKinds: ['LOGISTIC', 'COMPETITIVE'],
  startMethods: ['LANE_HEATS'],
  multiRound: false,
  resourceTypes: ['POOL'],
});
export const SWIMMING_POOL_V2 = timed(
  individual,
  ['HEAT'],
  POOL_CAPS,
  [ATTR.entryTimeMs, ATTR.ageBand],
  ['TIMING_SYSTEM_EXPORT'],
);
export const SWIMMING_RELAY_V2 = timed(
  relayTeam(8),
  ['HEAT'],
  POOL_CAPS,
  [ATTR.entryTimeMs, ATTR.ageBand],
  ['TIMING_SYSTEM_EXPORT'],
);
export const SWIMMING_OPEN_WATER_V2 = timed(
  individual,
  ['HEAT'],
  caps({
    rulesetFamilies: ['ELAPSED_TIME'],
    partitionKinds: ['LOGISTIC'],
    startMethods: ['SINGLE_START', 'WAVE_START'],
    multiRound: false,
    resourceTypes: ['OPEN_WATER_COURSE'],
  }),
  [ATTR.bib, ATTR.ageBand],
  ['TIMING_SYSTEM_EXPORT'],
);

// Cycling (UCI).
export const CYCLING_ROAD_V2: DisciplineVersionSpec = {
  specVersion: 2,
  ...metricsSpec([
    { key: 'finishPosition', valueType: 'INTEGER', unit: 'place', min: 1, max: 20000 },
    { key: 'elapsedTimeMs', valueType: 'DURATION_MS', unit: 'ms', min: 0, max: 2_000_000_000 },
  ]),
  comparator: {
    outcomeModel: 'RANKED',
    primary: 'METRICS',
    keys: [{ metric: 'finishPosition', order: 'ORDINAL' }],
  },
  validation: { bounds: [] },
  allowedContestTypes: ['HEAT'],
  participation: individual,
  capabilities: caps({
    rulesetFamilies: ['FINISH_ORDER_WITH_TIME'],
    partitionKinds: ['LOGISTIC'],
    startMethods: ['SINGLE_START', 'WAVE_START'],
    multiRound: true,
    resourceTypes: ['CYCLING_COURSE'],
  }),
  entryAttributes: [ATTR.bib, ATTR.ageBand, ATTR.teamAffiliation],
  evidenceExpectations: ['TIMING_SYSTEM_EXPORT'],
};
export const CYCLING_ITT_V2 = timed(
  individual,
  ['SESSION'],
  caps({
    rulesetFamilies: ['ELAPSED_TIME'],
    partitionKinds: ['LOGISTIC'],
    startMethods: ['INTERVAL_START'],
    multiRound: true,
    resourceTypes: ['CYCLING_COURSE'],
  }),
  [ATTR.bib, ATTR.ageBand],
  ['TIMING_SYSTEM_EXPORT'],
);
export const CYCLING_MTB_XC_V2: DisciplineVersionSpec = {
  specVersion: 2,
  ...metricsSpec([
    { key: 'lapsCompleted', valueType: 'INTEGER', unit: 'laps', min: 0, max: 100 },
    { key: 'elapsedTimeMs', valueType: 'DURATION_MS', unit: 'ms', min: 0, max: 2_000_000_000 },
  ]),
  comparator: {
    outcomeModel: 'RANKED',
    primary: 'METRICS',
    keys: [
      { metric: 'lapsCompleted', order: 'HIGHER_IS_BETTER' },
      { metric: 'elapsedTimeMs', order: 'LOWER_IS_BETTER' },
    ],
  },
  validation: { bounds: [] },
  allowedContestTypes: ['HEAT'],
  participation: individual,
  capabilities: caps({
    rulesetFamilies: ['LAPS_AND_TIME'],
    partitionKinds: ['LOGISTIC'],
    startMethods: ['SINGLE_START', 'WAVE_START'],
    multiRound: true,
    resourceTypes: ['CYCLING_COURSE'],
  }),
  entryAttributes: [ATTR.bib, ATTR.ageBand, ATTR.seedPoints],
  evidenceExpectations: ['TIMING_SYSTEM_EXPORT'],
};

// Bowling (IBF / ABF; handicap per USBC formula).
function bowling(
  participation: ParticipationSpec,
  attrs: readonly EntryAttributeSpec[],
): DisciplineVersionSpec {
  return {
    specVersion: 2,
    ...metricsSpec([{ key: 'pins', valueType: 'INTEGER', unit: 'pins', min: 0, max: 7200 }]),
    comparator: {
      outcomeModel: 'RANKED',
      primary: 'METRICS',
      keys: [{ metric: 'pins', order: 'HIGHER_IS_BETTER' }],
    },
    validation: { bounds: [] },
    allowedContestTypes: ['SERIES', 'MATCH'],
    participation,
    capabilities: caps({
      rulesetFamilies: ['FRAMES_PINFALL'],
      partitionKinds: ['LOGISTIC', 'COMPETITIVE'],
      startMethods: ['GROUPED_ENTRANTS'],
      multiRound: true,
      resourceTypes: ['BOWLING_LANE_PAIR'],
    }),
    entryAttributes: attrs,
    evidenceExpectations: ['SCORING_SYSTEM_EXPORT', 'SIGNED_SCORESHEET'],
  };
}
export const BOWLING_SINGLES_V2 = bowling(individual, [ATTR.average]);
export const BOWLING_DOUBLES_V2 = bowling({ ...pair, lineupOrdered: true }, [ATTR.memberAverage]);
export const BOWLING_TEAM_V2 = bowling(
  {
    participantKinds: ['TEAM'],
    lineupSize: { min: 3, max: 5 },
    roster: { min: 3, max: 6 },
    lineupOrdered: true,
    substitution: 'BETWEEN_GAMES',
  },
  [ATTR.memberAverage],
);

// Basketball (FIBA; wheelchair: IWBF).
function basketball(
  participation: ParticipationSpec,
  family: 'TIMED_PERIODS' | 'TIMED_OR_TARGET',
  resource: 'BASKETBALL_COURT' | 'BASKETBALL_HALF_COURT',
  attrs: readonly EntryAttributeSpec[],
): DisciplineVersionSpec {
  return {
    specVersion: 2,
    ...metricsSpec([{ key: 'points', valueType: 'INTEGER', unit: 'pts', min: 0, max: 300 }]),
    comparator: {
      outcomeModel: 'WIN_LOSS_DRAW',
      primary: 'HEAD_TO_HEAD_WINNER',
      keys: [{ metric: 'points', order: 'HIGHER_IS_BETTER' }],
    },
    validation: { bounds: [] },
    allowedContestTypes: ['MATCH'],
    participation,
    capabilities: caps({
      rulesetFamilies: [family],
      partitionKinds: ['COMPETITIVE'],
      startMethods: [],
      multiRound: false,
      resourceTypes: [resource],
    }),
    entryAttributes: attrs,
    evidenceExpectations: ['SIGNED_SCORESHEET'],
  };
}
export const BASKETBALL_5X5_V2 = basketball(
  {
    participantKinds: ['TEAM'],
    lineupSize: { min: 5, max: 12 },
    roster: { min: 5, max: 15 },
    onCourt: { count: 5, minToContinue: 2 },
    substitution: 'ROLLING',
  },
  'TIMED_PERIODS',
  'BASKETBALL_COURT',
  [ATTR.seedPoints],
);
export const BASKETBALL_3X3_V2 = basketball(
  {
    participantKinds: ['TEAM'],
    lineupSize: { min: 3, max: 4 },
    roster: { min: 3, max: 4 },
    onCourt: { count: 3, minToContinue: 1 },
    substitution: 'ROLLING',
  },
  'TIMED_OR_TARGET',
  'BASKETBALL_HALF_COURT',
  [ATTR.seedPoints, ATTR.memberSeedPoints],
);
export const BASKETBALL_WHEELCHAIR_V2 = basketball(
  {
    participantKinds: ['TEAM'],
    lineupSize: { min: 5, max: 12 },
    roster: { min: 5, max: 15 },
    // IWBF: five on court; the minimum to continue is not verified (FIBA value mirrored).
    onCourt: { count: 5, minToContinue: 2 },
    substitution: 'ROLLING',
    // IWBF: Σ classification points of the five on court ≤ 14.0 (recorded, not validated in v1).
    lineupConstraint: { sumOf: 'classificationPoints', max: '14.0' },
  },
  'TIMED_PERIODS',
  'BASKETBALL_COURT',
  [ATTR.classificationPoints],
);

// Golf (R&A / USGA; scramble is COMMON PRACTICE, not a Rules of Golf form of play).
function golf(
  participation: ParticipationSpec,
  families: DisciplineCapabilitiesSpec['rulesetFamilies'],
  contestTypes: DisciplineVersionSpec['allowedContestTypes'],
  attrs: readonly EntryAttributeSpec[],
): DisciplineVersionSpec {
  return {
    specVersion: 2,
    ...metricsSpec([
      { key: 'strokes', valueType: 'INTEGER', unit: 'strokes', min: 1, max: 1000 },
      { key: 'stablefordPoints', valueType: 'INTEGER', unit: 'pts', min: 0, max: 600 },
    ]),
    comparator: {
      outcomeModel: 'RANKED',
      primary: 'METRICS',
      keys: [{ metric: 'strokes', order: 'LOWER_IS_BETTER' }],
    },
    validation: { bounds: [] },
    allowedContestTypes: contestTypes,
    participation,
    capabilities: caps({
      rulesetFamilies: families,
      partitionKinds: ['LOGISTIC'],
      startMethods: ['GROUPED_ENTRANTS'],
      multiRound: true,
      resourceTypes: ['GOLF_COURSE'],
    }),
    entryAttributes: attrs,
    evidenceExpectations: ['SIGNED_SCORESHEET'],
  };
}
export const GOLF_INDIVIDUAL_V2 = golf(
  individual,
  ['STROKES', 'STABLEFORD', 'MATCH_PLAY_HOLES'],
  ['SERIES', 'MATCH'],
  [ATTR.handicapIndex],
);
export const GOLF_FOURBALL_V2 = golf(
  pair,
  ['STROKES', 'STABLEFORD', 'MATCH_PLAY_HOLES'],
  ['SERIES', 'MATCH'],
  [ATTR.memberHandicapIndex],
);
export const GOLF_SCRAMBLE_V2 = golf(
  {
    participantKinds: ['TEAM'],
    lineupSize: { min: 2, max: 4 },
    roster: { min: 2, max: 4 },
    substitution: 'NONE',
  },
  ['STROKES'],
  ['SERIES'],
  [ATTR.memberHandicapIndex],
);

export const CANONICAL_CATALOG: CatalogManifest = {
  sports: [
    {
      code: 'padel',
      name: 'Padel',
      disciplines: [
        {
          code: 'padel.doubles',
          name: 'Padel doubles',
          specs: [PADEL_DOUBLES_V1, racketV2(pair, 'PADEL_COURT')],
        },
      ],
    },
    {
      code: 'tennis',
      name: 'Tennis',
      disciplines: [
        {
          code: 'tennis.singles',
          name: 'Tennis singles',
          specs: [TENNIS_SINGLES_V1, racketV2(individual, 'TENNIS_COURT')],
        },
        {
          code: 'tennis.doubles',
          name: 'Tennis doubles',
          specs: [TENNIS_DOUBLES_V1, racketV2(pair, 'TENNIS_COURT')],
        },
      ],
    },
    {
      code: 'running',
      name: 'Running',
      disciplines: [
        { code: 'running.road', name: 'Road race', specs: [RUNNING_ROAD_V2] },
        { code: 'running.track', name: 'Track race', specs: [RUNNING_TRACK_V2] },
        { code: 'running.relay', name: 'Relay', specs: [RUNNING_RELAY_V2] },
      ],
    },
    {
      code: 'swimming',
      name: 'Swimming',
      disciplines: [
        { code: 'swimming.pool', name: 'Individual pool event', specs: [SWIMMING_POOL_V2] },
        { code: 'swimming.relay', name: 'Relay', specs: [SWIMMING_RELAY_V2] },
        { code: 'swimming.open_water', name: 'Open water', specs: [SWIMMING_OPEN_WATER_V2] },
      ],
    },
    {
      code: 'cycling',
      name: 'Cycling',
      disciplines: [
        { code: 'cycling.road', name: 'Road race / Gran Fondo', specs: [CYCLING_ROAD_V2] },
        { code: 'cycling.itt', name: 'Individual time trial', specs: [CYCLING_ITT_V2] },
        { code: 'cycling.mtb_xc', name: 'MTB cross-country', specs: [CYCLING_MTB_XC_V2] },
      ],
    },
    {
      code: 'bowling',
      name: 'Bowling',
      disciplines: [
        { code: 'bowling.tenpin.singles', name: 'Bowling singles', specs: [BOWLING_SINGLES_V2] },
        { code: 'bowling.tenpin.doubles', name: 'Bowling doubles', specs: [BOWLING_DOUBLES_V2] },
        { code: 'bowling.tenpin.team', name: 'Bowling team', specs: [BOWLING_TEAM_V2] },
      ],
    },
    {
      code: 'basketball',
      name: 'Basketball',
      disciplines: [
        { code: 'basketball.5x5', name: 'Basketball 5v5', specs: [BASKETBALL_5X5_V2] },
        { code: 'basketball.3x3', name: 'Basketball 3x3', specs: [BASKETBALL_3X3_V2] },
        {
          code: 'basketball.wheelchair',
          name: 'Wheelchair basketball',
          specs: [BASKETBALL_WHEELCHAIR_V2],
        },
      ],
    },
    {
      code: 'golf',
      name: 'Golf',
      disciplines: [
        { code: 'golf.individual', name: 'Individual stroke play', specs: [GOLF_INDIVIDUAL_V2] },
        { code: 'golf.fourball', name: 'Four-ball', specs: [GOLF_FOURBALL_V2] },
        { code: 'golf.scramble', name: 'Scramble (common practice)', specs: [GOLF_SCRAMBLE_V2] },
      ],
    },
  ],
  formats: [
    {
      code: 'single-elimination',
      name: 'Single elimination',
      versions: [
        { engineId: 'single-elimination', engineVersion: 1 },
        { engineId: 'single-elimination', engineVersion: 2 },
      ],
    },
    {
      code: 'round-robin',
      name: 'Round robin',
      versions: [
        { engineId: 'round-robin', engineVersion: 1 },
        { engineId: 'round-robin', engineVersion: 2 },
      ],
    },
    {
      code: 'groups-knockout',
      name: 'Groups → knockout',
      versions: [{ engineId: 'groups-knockout', engineVersion: 1 }],
    },
    {
      code: 'mass-start',
      name: 'Mass-start timed race',
      versions: [{ engineId: 'mass-start', engineVersion: 1 }],
    },
    {
      code: 'wave-start',
      name: 'Wave-start timed race',
      versions: [{ engineId: 'wave-start', engineVersion: 1 }],
    },
    {
      code: 'timed-finals',
      name: 'Timed finals',
      versions: [{ engineId: 'timed-finals', engineVersion: 1 }],
    },
    {
      code: 'heats-final',
      name: 'Heats → final',
      versions: [{ engineId: 'heats-final', engineVersion: 1 }],
    },
    {
      code: 'interval-start',
      name: 'Interval-start time trial',
      versions: [{ engineId: 'interval-start', engineVersion: 1 }],
    },
    {
      code: 'multi-round',
      name: 'Multi-round cumulative (leaderboard, aggregate, stage race)',
      versions: [{ engineId: 'multi-round', engineVersion: 1 }],
    },
    {
      code: 'stableford',
      name: 'Stableford',
      versions: [{ engineId: 'stableford', engineVersion: 1 }],
    },
    {
      code: 'qualifying-knockout',
      name: 'Qualifying → final (stepladder / bracket)',
      versions: [{ engineId: 'qualifying-knockout', engineVersion: 1 }],
    },
  ],
};

/**
 * The ONCF-05A design matrix as data: for each canonical sport, exactly three modalities
 * (discipline + category) and three formats (format template codes). A modality may select ANY
 * compatible format; compatibility is computed from catalog capabilities, never stored here.
 */
export interface DesignMatrixSport {
  readonly sport: string;
  readonly modalities: readonly {
    readonly name: string;
    readonly discipline: string;
    readonly category?: EventCategory;
    /** True when the modality is organizer practice rather than a governing-body form. */
    readonly commonPractice?: true;
  }[];
  readonly formats: readonly { readonly name: string; readonly format: string }[];
}

export const CANONICAL_DESIGN_MATRIX: readonly DesignMatrixSport[] = [
  {
    sport: 'tennis',
    modalities: [
      { name: 'Singles', discipline: 'tennis.singles' },
      { name: 'Doubles', discipline: 'tennis.doubles' },
      {
        name: 'Mixed doubles',
        discipline: 'tennis.doubles',
        category: { genderCategory: 'MIXED' },
      },
    ],
    formats: [
      { name: 'Single elimination', format: 'single-elimination' },
      { name: 'Round robin', format: 'round-robin' },
      { name: 'Round robin → knockout', format: 'groups-knockout' },
    ],
  },
  {
    sport: 'padel',
    modalities: [
      { name: "Men's doubles", discipline: 'padel.doubles', category: { genderCategory: 'MEN' } },
      {
        name: "Women's doubles",
        discipline: 'padel.doubles',
        category: { genderCategory: 'WOMEN' },
      },
      { name: 'Mixed doubles', discipline: 'padel.doubles', category: { genderCategory: 'MIXED' } },
    ],
    formats: [
      { name: 'Single elimination', format: 'single-elimination' },
      { name: 'Groups → knockout', format: 'groups-knockout' },
      { name: 'Round robin', format: 'round-robin' },
    ],
  },
  {
    sport: 'running',
    modalities: [
      { name: 'Road race', discipline: 'running.road' },
      { name: 'Track race', discipline: 'running.track' },
      { name: 'Relay', discipline: 'running.relay' },
    ],
    formats: [
      { name: 'Mass-start timed race', format: 'mass-start' },
      { name: 'Wave-start timed race', format: 'wave-start' },
      { name: 'Heats → final', format: 'heats-final' },
    ],
  },
  {
    sport: 'swimming',
    modalities: [
      { name: 'Individual pool event', discipline: 'swimming.pool' },
      { name: 'Relay', discipline: 'swimming.relay' },
      { name: 'Open water', discipline: 'swimming.open_water' },
    ],
    formats: [
      { name: 'Timed finals', format: 'timed-finals' },
      { name: 'Heats → final', format: 'heats-final' },
      { name: 'Open-water mass start', format: 'mass-start' },
    ],
  },
  {
    sport: 'cycling',
    modalities: [
      { name: 'Road race / Gran Fondo', discipline: 'cycling.road' },
      { name: 'Individual time trial', discipline: 'cycling.itt' },
      { name: 'MTB cross-country', discipline: 'cycling.mtb_xc' },
    ],
    formats: [
      { name: 'Mass-start race', format: 'mass-start' },
      { name: 'Interval-start time trial', format: 'interval-start' },
      { name: 'Multi-stage cumulative (GC)', format: 'multi-round' },
    ],
  },
  {
    sport: 'bowling',
    modalities: [
      { name: 'Singles', discipline: 'bowling.tenpin.singles' },
      { name: 'Doubles', discipline: 'bowling.tenpin.doubles' },
      { name: 'Team', discipline: 'bowling.tenpin.team' },
    ],
    formats: [
      { name: 'Aggregate pinfall', format: 'multi-round' },
      { name: 'Qualifying → stepladder', format: 'qualifying-knockout' },
      { name: 'Round-robin match play', format: 'round-robin' },
    ],
  },
  {
    sport: 'basketball',
    modalities: [
      { name: '5v5', discipline: 'basketball.5x5' },
      { name: '3x3', discipline: 'basketball.3x3' },
      { name: 'Wheelchair basketball', discipline: 'basketball.wheelchair' },
    ],
    formats: [
      { name: 'Pool play → knockout', format: 'groups-knockout' },
      { name: 'Round robin / league', format: 'round-robin' },
      { name: 'Single elimination', format: 'single-elimination' },
    ],
  },
  {
    sport: 'golf',
    modalities: [
      { name: 'Individual stroke play', discipline: 'golf.individual' },
      { name: 'Four-ball', discipline: 'golf.fourball' },
      { name: 'Scramble', discipline: 'golf.scramble', commonPractice: true },
    ],
    formats: [
      { name: 'Multi-round stroke-play leaderboard', format: 'multi-round' },
      { name: 'Stableford', format: 'stableford' },
      { name: 'Match-play bracket (from qualifying)', format: 'qualifying-knockout' },
    ],
  },
];
