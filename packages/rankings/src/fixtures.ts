import type { Mark, RankingFactKind } from '@br/domain';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';

/**
 * REFERENCE ENGINE FIXTURES — NOT PERSISTED SPORTING TRUTH (BRT-10 Step 3).
 * Fictional ids, people and values used by the engine tests and the BRT-10 vectors. Provenance is
 * always REFERENCE_FIXTURE; nothing here may be imported by application code.
 */
export const rkId = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const rkHash = (c: string) => `sha256:${c.repeat(64).slice(0, 64)}`;
const hash = (tag: string, ref: { id: string; version: number }, doc: unknown): string =>
  platformCanonicalizer().hashCanonical(tag, ref.id, ref.version, doc).contentHash;

export const RK = {
  DV: rkId(1),
  SYSTEM: rkId(10),
  SYSTEM_VERSION: rkId(11),
  COMPETITION: rkId(300),
  EVENT: rkId(301),
  OWNER: rkId(50),
  ANCHOR: rkId(51),
  T0: '2027-01-01T00:00:00.000Z',
  AS_OF: '2027-06-01T00:00:00.000Z',
} as const;

// ───────────────────────────── BEST_MARK ranking runs ─────────────────────────────

export const FIXTURE_FACT_KINDS: readonly RankingFactKind[] = [
  'RESULT_STATUS',
  'VERIFICATION',
  'CONTEST_OCCURRENCE',
  'COMPETITION_MEMBERSHIP',
  'HOLD_STATE',
  'POPULATION',
];

export const timeMark = (value: string, patch: Partial<Mark> = {}): Mark => ({
  metricId: 'running.elapsed_time',
  value,
  unit: 'ms',
  precision: 0,
  ...patch,
});

export const rankingSpec = (patch: Record<string, unknown> = {}) => ({
  targetEngine: 'ranking-engine/1',
  displayName: 'Fictional 5K best marks',
  kind: 'PLATFORM',
  method: 'BEST_MARK',
  universe: {
    disciplineVersionId: RK.DV,
    metric: { key: 'elapsedTimeMs', markMetricId: 'running.elapsed_time' },
    resultScope: 'CONTEST',
    holderType: 'ATHLETE',
    window: { from: RK.T0, to: '2028-01-01T00:00:00.000Z' },
    population: {},
  },
  comparator: { keys: [{ metric: 'elapsedTimeMs', order: 'LOWER_IS_BETTER' }] },
  requirements: { minimumVerificationLevel: 'V2', minimumResultStatus: 'FINAL' },
  recognition: { level: 'PLATFORM', sport: ['running'] },
  effectiveFrom: RK.T0,
  ...patch,
});

/** One candidate Performance: athlete `holder`, result version `n`, all canonical facts present. */
export const rankCandidate = (n: number, holder: number, value: string, patch: object = {}) => ({
  resultId: rkId(100 + n),
  resultVersionId: rkId(200 + n),
  contentHash: rkHash('a'),
  scopeType: 'CONTEST',
  status: 'FINAL',
  competitionId: RK.COMPETITION,
  eventId: RK.EVENT,
  contestId: rkId(400 + n),
  participantId: rkId(500 + n),
  holder: { holderType: 'ATHLETE', holderId: rkId(700 + holder) },
  ordinal: 1,
  mark: timeMark(value),
  valid: true,
  occurredAt: '2027-03-01T10:00:00.000Z',
  verification: {
    state: 'CURRENT',
    runId: rkId(600 + n),
    policyVersionId: rkId(60),
    snapshotHash: rkHash('b'),
    outcomeHash: rkHash('c'),
    level: 'V2',
    evidenceBundleHash: rkHash('d'),
    evaluatedAsOf: '2027-03-02T00:00:00.000Z',
  },
  hold: { active: false },
  ...patch,
});

export const rankingRunInput = (
  candidates: readonly unknown[],
  patch: { spec?: object; system?: object; discipline?: object; [k: string]: unknown } = {},
) => {
  const { spec: specPatch, system: systemPatch, discipline: disciplinePatch, ...rest } = patch;
  const spec = { ...rankingSpec(), ...(specPatch ?? {}) };
  return {
    provenance: 'REFERENCE_FIXTURE',
    assembler: 'reference-fixture',
    supportedFactKinds: FIXTURE_FACT_KINDS,
    system: {
      systemId: RK.SYSTEM,
      code: 'fictional-5k',
      kind: spec.kind,
      systemVersionId: RK.SYSTEM_VERSION,
      version: 1,
      specHash: hash(DomainTag.rankingSystemVersion, SchemaRef.rankingSystemVersion, spec),
      spec,
      lifecycle: 'PUBLISHED',
      ...(systemPatch ?? {}),
    },
    discipline: {
      disciplineVersionId: RK.DV,
      sport: 'running',
      discipline: 'running.5k',
      metric: {
        key: 'elapsedTimeMs',
        valueType: 'DURATION_MS',
        unit: 'ms',
        order: 'LOWER_IS_BETTER',
      },
      ...(disciplinePatch ?? {}),
    },
    asOf: RK.AS_OF,
    candidates,
    ...rest,
  };
};

// ───────────────────────────── classifications ─────────────────────────────

export interface FixtureDiscipline {
  readonly metrics: readonly { key: string; valueType: string; unit: string }[];
  readonly comparator: {
    readonly outcomeModel: string;
    readonly primary: 'HEAD_TO_HEAD_WINNER' | 'METRICS';
    readonly keys: readonly { metric: string; order: string }[];
  };
  /** Mark.metricId per DV key (declared by the policy). */
  readonly markMetricIds: Readonly<Record<string, string>>;
}

/** Fictional bowling-like METRICS discipline: total pins, then best game. */
export const PINS_DV: FixtureDiscipline = {
  metrics: [
    { key: 'totalPins', valueType: 'INTEGER', unit: 'pins' },
    { key: 'highGame', valueType: 'INTEGER', unit: 'pins' },
  ],
  comparator: {
    outcomeModel: 'SCORED_RANKED',
    primary: 'METRICS',
    keys: [
      { metric: 'totalPins', order: 'HIGHER_IS_BETTER' },
      { metric: 'highGame', order: 'HIGHER_IS_BETTER' },
    ],
  },
  markMetricIds: { totalPins: 'bowling.total_pins', highGame: 'bowling.high_game' },
};

/** Fictional heats discipline: lower time is better (MIN = best heat). */
export const HEATS_DV: FixtureDiscipline = {
  metrics: [{ key: 'elapsedTimeMs', valueType: 'DURATION_MS', unit: 'ms' }],
  comparator: {
    outcomeModel: 'RANKED',
    primary: 'METRICS',
    keys: [{ metric: 'elapsedTimeMs', order: 'LOWER_IS_BETTER' }],
  },
  markMetricIds: { elapsedTimeMs: 'running.elapsed_time' },
};

/** Fictional throws discipline: DECIMAL metres (exact decimal SUM). */
export const THROWS_DV: FixtureDiscipline = {
  metrics: [{ key: 'distanceM', valueType: 'DECIMAL', unit: 'm' }],
  comparator: {
    outcomeModel: 'RANKED',
    primary: 'METRICS',
    keys: [{ metric: 'distanceM', order: 'HIGHER_IS_BETTER' }],
  },
  markMetricIds: { distanceM: 'throws.distance' },
};

/** Fictional padel group: head-to-head with sets / games as later keys. */
export const PADEL_DV: FixtureDiscipline = {
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
  markMetricIds: { setsWon: 'padel.sets_won', gamesWon: 'padel.games_won' },
};

export const policySpec = (
  dv: FixtureDiscipline,
  aggregations: readonly string[],
  sources: readonly string[] = dv.comparator.keys.map(() => 'PERFORMANCE'),
  patch: Record<string, unknown> = {},
) => ({
  targetEngine: 'classification-engine/1',
  displayName: 'Fictional group table',
  scopeType: 'ROUND_CLASSIFICATION',
  disciplineVersionId: RK.DV,
  minimumInputStatus: 'PROVISIONAL',
  primary: dv.comparator.primary,
  keys: dv.comparator.keys.map((k, i) => ({
    metric: k.metric,
    markMetricId: dv.markMetricIds[k.metric] ?? 'unknown.metric',
    order: k.order,
    source: sources[i] ?? 'PERFORMANCE',
    aggregation: aggregations[i] ?? 'SUM',
  })),
  ...(dv.comparator.primary === 'HEAD_TO_HEAD_WINNER'
    ? {
        outcomePoints: [
          { outcome: 'WIN', points: 3 },
          { outcome: 'DRAW', points: 1 },
          { outcome: 'LOSS', points: 0 },
        ],
      }
    : {}),
  ...patch,
});

export const participant = (n: number) => rkId(500 + n);

export const markOf = (dv: FixtureDiscipline, key: string, value: string, precision = 0): Mark => ({
  metricId: dv.markMetricIds[key] ?? 'unknown.metric',
  value,
  unit: dv.metrics.find((m) => m.key === key)?.unit ?? '?',
  precision,
});

/** One contest's `@1` result content + its current-version facts (content hash computed). */
export const contestInput = (
  n: number,
  content: { entries: readonly object[]; performances?: readonly object[] },
  patch: Record<string, unknown> = {},
) => ({
  resultId: rkId(1000 + n),
  resultVersionId: rkId(1100 + n),
  contentHash: hash(DomainTag.resultVersionContent, SchemaRef.resultVersionContent, content),
  scopeType: 'CONTEST',
  contestId: rkId(1200 + n),
  status: 'PROVISIONAL',
  content,
  ...patch,
});

/** A spec outside the closed vocabulary (e.g. AVERAGE) has no hash: a placeholder pins it. */
const specHashOrPlaceholder = (spec: object) => {
  try {
    return hash(DomainTag.classificationPolicy, SchemaRef.classificationPolicy, spec);
  } catch {
    return rkHash('0');
  }
};

export const classificationInput = (
  dv: FixtureDiscipline,
  spec: object,
  inputs: readonly { contestId: string }[],
  patch: Record<string, unknown> = {},
) => ({
  provenance: 'REFERENCE_FIXTURE',
  assembler: 'reference-fixture',
  policy: {
    policyId: rkId(20),
    policyVersionId: rkId(21),
    specHash: specHashOrPlaceholder(spec),
    spec,
  },
  discipline: {
    disciplineVersionId: RK.DV,
    specHash: rkHash('d'),
    metrics: dv.metrics,
    comparator: dv.comparator,
  },
  scope: {
    scopeType: 'ROUND_CLASSIFICATION',
    scopeId: rkId(30),
    contestIds: [...new Set(inputs.map((i) => i.contestId))],
  },
  inputs,
  ...patch,
});

/** A padel match between participants a and b with the given sets / games (outcome derived). */
export const padelMatch = (
  n: number,
  a: number,
  b: number,
  [setsA, setsB, gamesA, gamesB]: readonly [number, number, number, number],
  patch: Record<string, unknown> = {},
) => {
  const outcome = (x: number, y: number) => (x > y ? 'WIN' : x < y ? 'LOSS' : 'DRAW');
  const perf = (p: number, games: number) => [
    { participantId: participant(p), ordinal: 1, mark: markOf(PADEL_DV, 'gamesWon', `${games}`) },
  ];
  return contestInput(
    n,
    {
      entries: [
        {
          participantId: participant(a),
          outcome: outcome(setsA, setsB),
          primaryMark: markOf(PADEL_DV, 'setsWon', `${setsA}`),
        },
        {
          participantId: participant(b),
          outcome: outcome(setsB, setsA),
          primaryMark: markOf(PADEL_DV, 'setsWon', `${setsB}`),
        },
      ],
      performances: [...perf(a, gamesA), ...perf(b, gamesB)],
    },
    patch,
  );
};

/** A four-match padel group (participants 1–4), shared by staleness tests and vectors. */
export const padelGroup = () => [
  padelMatch(1, 1, 2, [2, 0, 12, 5]),
  padelMatch(2, 3, 4, [1, 1, 9, 9]),
  padelMatch(3, 1, 3, [0, 2, 6, 12]),
  padelMatch(4, 2, 4, [2, 1, 13, 10]),
];
