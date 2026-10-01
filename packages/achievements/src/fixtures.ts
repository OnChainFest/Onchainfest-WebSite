import { createHash } from 'node:crypto';
import {
  ALL_DERIVATION_FACT_KINDS,
  type DerivationFactKind,
  type ResultVersionStatus,
  type VerificationLevel,
} from '@br/domain';
import {
  referencePersonalBestRule,
  referenceRecordSetRule,
  referenceThresholdRule,
  referenceTitleRule,
  validateAchievementRuleSpec,
  type AchievementRuleSpec,
} from './rule';
import type {
  AchievementDerivationSnapshot,
  SnapshotRecordMark,
  GoverningRecognitionScope,
  RecognitionLevelValue,
  SnapshotComparison,
  SnapshotPerformance,
  VerificationState,
} from './snapshot';

/**
 * REFERENCE ENGINE FIXTURE — NOT PERSISTED SPORTING TRUTH.
 *
 * Typed, in-memory, fully synthetic AchievementDerivationSnapshots. They carry facts the platform
 * cannot produce yet (CURRENT V2 verification, FINAL / OFFICIAL status, hold state, credited Result
 * lineups) solely to prove the engine's semantics. Every fixture snapshot has
 * `provenance: REFERENCE_FIXTURE`; the normal database schema refuses to store anything derived from
 * one (CHECK snapshot_provenance = 'CANONICAL_ASSEMBLY'). Only the throwaway fixture-persistence
 * databases of the test harness (a test-only DDL overlay) accept them — never verification.run,
 * never results tables, never seeds, the API, the worker or the web.
 *
 * Deterministic ids (from labels): no clock, randomness, database or environment. Import explicitly
 * from `@br/achievements/fixtures` (tests, vectors, demo Part B/C only).
 */
export const FIXTURE_LABEL = 'REFERENCE ENGINE FIXTURE — NOT PERSISTED SPORTING TRUTH';

/** Deterministic UUID (v8 layout) from a label. */
export function fixtureId(label: string): string {
  const h = createHash('sha256').update(`br-achievement-fixture:${label}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export const fixtureHash = (label: string) =>
  `sha256:${createHash('sha256').update(`br-achievement-fixture-hash:${label}`).digest('hex')}`;
const T0 = Date.parse('2026-04-01T09:00:00.000Z');
export const fixtureTime = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

export const FX = {
  competition: fixtureId('competition'),
  event: fixtureId('event'),
  round: fixtureId('round-final'),
  contest: fixtureId('contest-final'),
  padelDv: fixtureId('dv-padel-doubles'),
  bowlingDv: fixtureId('dv-bowling-singles'),
  runningDv: fixtureId('dv-running-5k'),
  otherDv: fixtureId('dv-other'),
  teamA: fixtureId('team-pair-a'),
  teamB: fixtureId('team-pair-b'),
  participantA: fixtureId('participant-pair-a'),
  participantB: fixtureId('participant-pair-b'),
  athleteA1: fixtureId('athlete-a1'),
  athleteA2: fixtureId('athlete-a2'),
  athleteB1: fixtureId('athlete-b1'),
  athleteB2: fixtureId('athlete-b2'),
  /** On Pair A's roster but NOT in the credited lineup (must never be credited). */
  unusedRosterAthlete: fixtureId('athlete-a-unused-roster'),
  /** Former / future team members and the team manager are never in the snapshot at all. */
  bowler: fixtureId('athlete-bowler'),
  bowlerParticipant: fixtureId('participant-bowler'),
  runner: fixtureId('athlete-runner'),
  runnerParticipant: fixtureId('participant-runner'),
} as const;

export const PADEL_METRICS = [
  { key: 'setsWon', valueType: 'INTEGER', unit: 'sets', order: 'HIGHER_IS_BETTER' },
  { key: 'gamesWon', valueType: 'INTEGER', unit: 'games', order: 'HIGHER_IS_BETTER' },
] as const;
/** Fictional bowling-like metric set (game pins has no comparator order in this fictional DV). */
export const BOWLING_METRICS = [
  { key: 'score', valueType: 'INTEGER', unit: 'pins' },
  { key: 'seriesPins', valueType: 'INTEGER', unit: 'pins', order: 'HIGHER_IS_BETTER' },
] as const;
export const RUNNING_METRICS = [
  { key: 'elapsedTimeMs', valueType: 'DURATION_MS', unit: 'ms', order: 'LOWER_IS_BETTER' },
] as const;

export const FIXTURE_RULES = {
  padelTitle: referenceTitleRule(FX.padelDv),
  perfectGame: referenceThresholdRule(
    FX.bowlingDv,
    { key: 'score', markMetricId: 'score' },
    'GTE',
    '300',
    'Perfect Game',
  ),
  bowlingSeriesPb: referencePersonalBestRule(FX.bowlingDv, {
    key: 'seriesPins',
    markMetricId: 'series_pins',
  }),
  runningPb: referencePersonalBestRule(FX.runningDv, {
    key: 'elapsedTimeMs',
    markMetricId: 'elapsed_time_ms',
  }),
  runningRecordSet: referenceRecordSetRule(FX.runningDv),
} satisfies Record<string, AchievementRuleSpec>;

/** Snapshot `rule` member for a fixture rule spec (ids from labels, real spec hash). */
/** Real rule identity (persistence fixture lane: rules are real, published rows). */
export interface FixtureRuleIdentity {
  readonly ruleId: string;
  readonly ruleVersionId: string;
  readonly code: string;
  readonly version: number;
  readonly bindingId: string;
}

export function fixtureRule(
  spec: AchievementRuleSpec,
  label: string,
  version = 1,
  identity?: FixtureRuleIdentity,
) {
  const v = validateAchievementRuleSpec(spec);
  if (!v.ok) throw new Error(`invalid fixture rule ${label}: ${JSON.stringify(v.issues)}`);
  return {
    ruleId: identity?.ruleId ?? fixtureId(`rule:${label}`),
    ruleVersionId: identity?.ruleVersionId ?? fixtureId(`rule:${label}:v${version}`),
    code: identity?.code ?? `fixture-${label}`,
    version: identity?.version ?? version,
    specHash: v.specHash,
    spec: v.spec,
    bindingId: identity?.bindingId ?? fixtureId(`binding:${label}:v${version}`),
  };
}

export interface FixtureOptions {
  /** Result version label (distinct labels ⇒ distinct versions / hashes). */
  readonly rv?: string;
  readonly status?: Exclude<ResultVersionStatus, 'DRAFT'>;
  readonly verificationState?: VerificationState;
  readonly level?: VerificationLevel;
  readonly run?: string;
  readonly hold?: boolean;
  /** Omit HOLD_STATE / CREDITED_LINEUP from supportedFactKinds (production-like). */
  readonly unsupported?: readonly DerivationFactKind[];
  readonly supersedes?: string;
  readonly supersededBy?: string;
  readonly ruleLabel?: string;
  readonly ruleVersion?: number;
  readonly ruleSpec?: AchievementRuleSpec;
  /** Sport code of the fixture event (default "padel"; discipline "<sport>.doubles"). */
  readonly sport?: string;
  /** Governing recognition pinned from the synthetic run (default PLATFORM certification; null = none). */
  readonly recognition?: {
    readonly level: RecognitionLevelValue;
    readonly source?: 'CERTIFICATION' | 'SANCTION';
    /** Anchor recognition scope (BRT-03 vocabulary); null = unknown (claims fail closed). */
    readonly scope?: GoverningRecognitionScope | null;
  } | null;
  /** Persistence fixture lane: the real (published, bound) rule the snapshot names. */
  readonly ruleIdentity?: FixtureRuleIdentity;
  /** Persistence fixture lane: the real DisciplineVersion (must equal ruleSpec.disciplineVersionId). */
  readonly disciplineVersionId?: string;
}

function base(o: FixtureOptions, dv0: string, metrics: readonly unknown[]) {
  const dv = o.disciplineVersionId ?? dv0;
  const rvLabel = o.rv ?? 'rv1';
  const run = o.run ?? `${rvLabel}:run1`;
  const state = o.verificationState ?? 'CURRENT';
  return {
    provenance: 'REFERENCE_FIXTURE' as const,
    assembler: 'reference-fixture/1',
    // RECORD_RATIFICATION (BRT-09) is declared only by RECORD_SET fixtures (recordSetFixture), so
    // every BRT-08 reference snapshot — and its committed vector — is byte-identical.
    supportedFactKinds: ALL_DERIVATION_FACT_KINDS.filter(
      (k) => k !== 'RECORD_RATIFICATION' && !(o.unsupported ?? []).includes(k),
    ),
    discipline: {
      disciplineVersionId: dv,
      sport: o.sport ?? 'fixture',
      discipline: o.sport === undefined ? 'fixture.discipline' : `${o.sport}.doubles`,
      metrics,
    },
    hierarchy: {
      competitionId: FX.competition,
      eventId: FX.event,
      roundId: FX.round,
      contestId: FX.contest,
    },
    verification: {
      state,
      runId: fixtureId(`run:${run}`),
      policyVersionId: fixtureId('policy-v1'),
      snapshotHash: fixtureHash(`verification-snapshot:${run}`),
      outcomeHash: fixtureHash(`verification-outcome:${run}`),
      level: o.level ?? 'V2',
      evidenceBundleHash: fixtureHash(`evidence-bundle:${run}`),
      evaluatedAsOf: fixtureTime(90),
      // Governing recognition pinned from the (synthetic) run trace: platform-anchored by default.
      ...((o.level ?? 'V2') === 'V0' || (o.level ?? 'V2') === 'V1' || o.recognition === null
        ? {}
        : {
            governingRecognition: {
              recognitionLevel: o.recognition?.level ?? 'PLATFORM',
              anchorId: fixtureId(`anchor:${o.recognition?.level ?? 'PLATFORM'}`),
              source: o.recognition?.source ?? 'CERTIFICATION',
              anchorFactHash: fixtureHash(
                `anchor-fact:${o.recognition?.level ?? 'PLATFORM'}:${JSON.stringify(o.recognition?.scope ?? null)}`,
              ),
              // Synthetic anchor recognition scope (default: the level only, unconstrained elsewhere).
              ...(o.recognition?.scope === null
                ? {}
                : {
                    recognitionScope: o.recognition?.scope ?? {
                      recognitionLevel: [o.recognition?.level ?? 'PLATFORM'],
                    },
                  }),
            },
          }),
    },
    ...((o.unsupported ?? []).includes('HOLD_STATE') ? {} : { hold: { active: o.hold ?? false } }),
    rvLabel,
  };
}

function resultVersion(o: FixtureOptions, rvLabel: string, scopeType: string, target: string) {
  return {
    resultVersionId: fixtureId(`result-version:${rvLabel}`),
    resultId: fixtureId(`result:${scopeType}`),
    versionNumber: Number(/\d+$/.exec(rvLabel)?.[0] ?? '1'),
    contentHash: fixtureHash(`content:${rvLabel}`),
    scopeType,
    scopeTargetId: target,
    submittedAt: fixtureTime(120),
    status: o.status ?? 'FINAL',
    ...(o.supersedes === undefined
      ? {}
      : { supersedesVersionId: fixtureId(`result-version:${o.supersedes}`) }),
    ...(o.supersededBy === undefined
      ? {}
      : { supersededByVersionId: fixtureId(`result-version:${o.supersededBy}`) }),
  };
}

/**
 * Padel pair final classification (BRT-01 padel walkthrough §5–6): Pair A rank 1, Pair B rank 2.
 * Credited lineups (fixture Result-content facts): A → A1, A2; B → B1, B2. Pair A's roster also has
 * an unused member who is NOT in the credited lineup.
 */
export function padelTitleFixture(
  o: FixtureOptions & {
    readonly lineupA?: readonly string[];
    readonly ranks?: { readonly a: number; readonly b: number };
  } = {},
): AchievementDerivationSnapshot {
  const b = base(o, FX.padelDv, PADEL_METRICS);
  const { rvLabel, ...rest } = b;
  const ranks = o.ranks ?? { a: 1, b: 2 };
  return {
    ...rest,
    rule: fixtureRule(
      o.ruleSpec ?? FIXTURE_RULES.padelTitle,
      o.ruleLabel ?? 'padel-title',
      o.ruleVersion,
      o.ruleIdentity,
    ),
    resultVersion: resultVersion(o, rvLabel, 'EVENT_CLASSIFICATION', FX.event),
    entries: [
      { participantId: FX.participantB, outcome: 'RANKED', rank: ranks.b },
      { participantId: FX.participantA, outcome: 'RANKED', rank: ranks.a },
    ],
    participants: [
      { participantId: FX.participantB, kind: 'TEAM', teamId: FX.teamB },
      { participantId: FX.participantA, kind: 'TEAM', teamId: FX.teamA },
    ],
    ...((o.unsupported ?? []).includes('CREDITED_LINEUP')
      ? {}
      : {
          creditedLineups: [
            {
              participantId: FX.participantA,
              athleteIds: o.lineupA ?? [FX.athleteA2, FX.athleteA1],
            },
            { participantId: FX.participantB, athleteIds: [FX.athleteB1, FX.athleteB2] },
          ],
        }),
  } as AchievementDerivationSnapshot;
}

/** Fictional bowling-like series: three games, one of them `value` (e.g. a perfect 300). */
export function thresholdFixture(
  o: FixtureOptions & {
    readonly value?: string;
    readonly metricId?: string;
    readonly extraPerformances?: readonly SnapshotPerformance[];
    readonly dv?: string;
    readonly valid?: boolean;
  } = {},
): AchievementDerivationSnapshot {
  const b = base(o, o.dv ?? FX.bowlingDv, BOWLING_METRICS);
  const { rvLabel, ...rest } = b;
  const mark = (value: string, metricId = o.metricId ?? 'score') => ({
    metricId,
    value,
    unit: 'pins',
    precision: 0,
  });
  return {
    ...rest,
    rule: fixtureRule(
      o.ruleSpec ?? FIXTURE_RULES.perfectGame,
      o.ruleLabel ?? 'perfect-game',
      o.ruleVersion,
      o.ruleIdentity,
    ),
    resultVersion: resultVersion(o, rvLabel, 'CONTEST', FX.contest),
    entries: [{ participantId: FX.bowlerParticipant, outcome: 'RANKED', rank: 1 }],
    participants: [
      { participantId: FX.bowlerParticipant, kind: 'INDIVIDUAL', athleteId: FX.bowler },
    ],
    performances: [
      { participantId: FX.bowlerParticipant, ordinal: 1, mark: mark('212'), valid: true },
      {
        participantId: FX.bowlerParticipant,
        ordinal: 2,
        mark: mark(o.value ?? '300'),
        valid: o.valid ?? true,
      },
      { participantId: FX.bowlerParticipant, ordinal: 3, mark: mark('100'), valid: true },
      ...(o.extraPerformances ?? []),
    ],
    occurrence: { startedAt: fixtureTime(60) },
  } as AchievementDerivationSnapshot;
}

/** A prior performance of the same athlete for PB comparison sets. */
export function priorPerformance(input: {
  readonly label: string;
  readonly athleteId: string;
  readonly participantId?: string;
  readonly dv: string;
  readonly metricId: string;
  readonly unit: string;
  readonly value: string;
  readonly occurredAtMinute: number;
  readonly level?: VerificationLevel;
  readonly state?: VerificationState;
  readonly status?: Exclude<ResultVersionStatus, 'DRAFT'>;
}): SnapshotComparison {
  return {
    resultVersionId: fixtureId(`prior:${input.label}`),
    contentHash: fixtureHash(`prior-content:${input.label}`),
    disciplineVersionId: input.dv,
    participantId: input.participantId ?? fixtureId(`prior-participant:${input.label}`),
    athleteId: input.athleteId,
    ordinal: 1,
    mark: { metricId: input.metricId, value: input.value, unit: input.unit, precision: 0 },
    valid: true,
    occurredAt: fixtureTime(input.occurredAtMinute),
    status: input.status ?? 'OFFICIAL',
    verification: {
      state: input.state ?? 'CURRENT',
      runId: fixtureId(`prior-run:${input.label}`),
      snapshotHash: fixtureHash(`prior-vs:${input.label}`),
      outcomeHash: fixtureHash(`prior-vo:${input.label}`),
      level: input.level ?? 'V2',
    },
  };
}

/** PB fixture: one performance `value` of `metric`, plus prior comparison performances. */
export function personalBestFixture(
  o: FixtureOptions & {
    readonly kind: 'BOWLING_SERIES' | 'RUNNING';
    readonly value: string;
    readonly priors?: readonly {
      value: string;
      minute: number;
      level?: VerificationLevel;
      dv?: string;
      state?: VerificationState;
    }[];
    readonly firstEstablishes?: boolean;
  },
): AchievementDerivationSnapshot {
  const running = o.kind === 'RUNNING';
  const dv = running ? FX.runningDv : FX.bowlingDv;
  const b = base(o, dv, running ? RUNNING_METRICS : BOWLING_METRICS);
  const { rvLabel, ...rest } = b;
  const athlete = running ? FX.runner : FX.bowler;
  const participant = running ? FX.runnerParticipant : FX.bowlerParticipant;
  const metricId = running ? 'elapsed_time_ms' : 'series_pins';
  const unit = running ? 'ms' : 'pins';
  const spec0 = running ? FIXTURE_RULES.runningPb : FIXTURE_RULES.bowlingSeriesPb;
  const spec: AchievementRuleSpec =
    o.firstEstablishes === false
      ? { ...spec0, criterion: { ...spec0.criterion, firstEligibleEstablishesBest: false } }
      : spec0;
  return {
    ...rest,
    rule: fixtureRule(
      o.ruleSpec ?? spec,
      o.ruleLabel ?? (running ? 'running-pb' : 'bowling-pb'),
      o.ruleVersion,
      o.ruleIdentity,
    ),
    resultVersion: resultVersion(o, rvLabel, 'CONTEST', FX.contest),
    entries: [{ participantId: participant, outcome: 'RANKED', rank: 1 }],
    participants: [{ participantId: participant, kind: 'INDIVIDUAL', athleteId: athlete }],
    performances: [
      {
        participantId: participant,
        ordinal: 1,
        mark: { metricId, value: o.value, unit, precision: 0 },
        valid: true,
      },
    ],
    occurrence: { startedAt: fixtureTime(1000) },
    comparisons: (o.priors ?? []).map((p, i) =>
      priorPerformance({
        label: `${o.kind}:${i}:${p.value}:${p.minute}`,
        athleteId: athlete,
        dv: p.dv ?? dv,
        metricId,
        unit,
        value: p.value,
        occurredAtMinute: p.minute,
        ...(p.level === undefined ? {} : { level: p.level }),
        ...(p.state === undefined ? {} : { state: p.state }),
      }),
    ),
  } as AchievementDerivationSnapshot;
}

/**
 * BRT-09 RECORD_SET fixture: one running performance (elapsed time, lower is better) that a
 * synthetic, validly ratified RecordMark pins. REFERENCE ENGINE FIXTURE — NOT PERSISTED SPORTING
 * TRUTH: the ratification it assumes has no canonical producer (deferred BRT-06R).
 */
export function recordSetFixture(
  o: FixtureOptions & {
    readonly value?: string;
    readonly record?: Partial<SnapshotRecordMark> | null;
  } = {},
): AchievementDerivationSnapshot {
  const b = base(o, FX.runningDv, RUNNING_METRICS);
  const { rvLabel, ...rest } = b;
  const value = o.value ?? '598000';
  const mark = { metricId: 'elapsed_time_ms', value, unit: 'ms', precision: 0 };
  const record: SnapshotRecordMark = {
    recordMarkId: fixtureId(`record-mark:${rvLabel}`),
    markHash: fixtureHash(`record-mark:${rvLabel}`),
    categoryId: fixtureId('record-category:running-platform'),
    categoryVersionId: fixtureId('record-category:running-platform:v1'),
    categoryVersionHash: fixtureHash('record-category:running-platform:v1'),
    scopeType: 'COMPETITION',
    standing: 'RATIFIED',
    ratificationEntryId: fixtureId(`record-ratification-entry:${rvLabel}`),
    ratificationHash: fixtureHash(`record-ratification:${rvLabel}`),
    recognitionLevel: 'PLATFORM',
    currentStatus: 'RATIFIED',
    requiredLevel: 'V3',
    holder: { holderType: 'ATHLETE', holderId: FX.runner },
    participantId: FX.runnerParticipant,
    performanceOrdinal: 1,
    value: mark,
    ...(o.record ?? {}),
  };
  return {
    ...rest,
    supportedFactKinds: [
      ...rest.supportedFactKinds,
      ...((o.unsupported ?? []).includes('RECORD_RATIFICATION')
        ? []
        : (['RECORD_RATIFICATION'] as const)),
    ],
    rule: fixtureRule(
      o.ruleSpec ?? FIXTURE_RULES.runningRecordSet,
      o.ruleLabel ?? 'running-record-set',
      o.ruleVersion,
      o.ruleIdentity,
    ),
    resultVersion: resultVersion(o, rvLabel, 'CONTEST', FX.contest),
    entries: [{ participantId: FX.runnerParticipant, outcome: 'RANKED', rank: 1 }],
    participants: [
      { participantId: FX.runnerParticipant, kind: 'INDIVIDUAL', athleteId: FX.runner },
    ],
    performances: [{ participantId: FX.runnerParticipant, ordinal: 1, mark, valid: true }],
    occurrence: { startedAt: fixtureTime(60) },
    ...(o.record === null ? {} : { record }),
  } as AchievementDerivationSnapshot;
}
