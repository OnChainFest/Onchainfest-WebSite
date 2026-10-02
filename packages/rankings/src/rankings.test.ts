import { describe, expect, it } from 'vitest';
import {
  ALL_RANKING_BLOCKERS,
  PRODUCTION_SUPPORTED_RANKING_FACT_KINDS,
  RANKING_BLOCKERS,
  RANKING_PLATFORM_FLOOR,
} from '@br/domain';
import { platformCanonicalizer, SchemaRef } from '@br/schemas';
import {
  checkCompetitionRanking,
  hashRankingRunInput,
  rankingSystemVersionContinues,
  rankingUniverseHash,
  requiredRankingFactKinds,
  unsupportedRequiredFactKinds,
  validateClassificationPolicySpec,
  validateQualificationBasis,
  validateRankingSnapshot,
  validateRankingSystemSpec,
  type RankingDisciplineContext,
  type RankingSystemSpec,
} from './index';

/**
 * BRT-10 Step 2 — domain vocabulary, schema and validator tests.
 * REFERENCE ENGINE FIXTURES — NOT PERSISTED SPORTING TRUTH (fictional ids and values).
 */
const id = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const h = (c: string) => `sha256:${c.repeat(64).slice(0, 64)}`;
const DV = id(1);
const T0 = '2027-01-01T00:00:00.000Z';

const RUNNING: RankingDisciplineContext = {
  disciplineVersionId: DV,
  status: 'PUBLISHED',
  sport: 'running',
  discipline: 'running.5k',
  spec: {
    metrics: [{ key: 'elapsedTimeMs', valueType: 'DURATION_MS', unit: 'ms' }],
    comparator: {
      outcomeModel: 'RANKED',
      primary: 'METRICS',
      keys: [{ metric: 'elapsedTimeMs', order: 'LOWER_IS_BETTER' }],
    },
    participation: { participantKinds: ['INDIVIDUAL'], lineupSize: { min: 1, max: 1 } },
  },
};

const UNIVERSE = {
  disciplineVersionId: DV,
  metric: { key: 'elapsedTimeMs', markMetricId: 'running.elapsed_time' },
  resultScope: 'CONTEST',
  holderType: 'ATHLETE',
  window: { from: T0, to: '2028-01-01T00:00:00.000Z' },
  population: {},
};

const platformSystem = (patch: Partial<Record<keyof RankingSystemSpec, unknown>> = {}) => ({
  targetEngine: 'ranking-engine/1',
  displayName: 'Fictional 5K best marks',
  kind: 'PLATFORM',
  method: 'BEST_MARK',
  universe: UNIVERSE,
  comparator: { keys: [{ metric: 'elapsedTimeMs', order: 'LOWER_IS_BETTER' }] },
  requirements: { minimumVerificationLevel: 'V2', minimumResultStatus: 'FINAL' },
  recognition: { level: 'PLATFORM', sport: ['running'] },
  effectiveFrom: T0,
  ...patch,
});
const officialSystem = (patch: Record<string, unknown> = {}) =>
  platformSystem({
    kind: 'OFFICIAL',
    requirements: { minimumVerificationLevel: 'V3', minimumResultStatus: 'FINAL' },
    recognition: { level: 'NATIONAL', sport: ['running'], region: ['CR'] },
    owner: { principalId: id(50), anchorId: id(51) },
    ...patch,
  });

const codes = (v: { ok: boolean; issues?: readonly { code: string }[] }) =>
  v.ok ? [] : (v.issues ?? []).map((i) => i.code);

const basis = (n: number, level = 'V2') => ({
  resultId: id(100 + n),
  resultVersionId: id(200 + n),
  contentHash: h('a'),
  resultStatus: 'FINAL',
  competitionId: id(300),
  eventId: id(301),
  contestId: id(400 + n),
  participantId: id(500 + n),
  performanceOrdinal: 1,
  verificationRunId: id(600 + n),
  verificationSnapshotHash: h('b'),
  verificationOutcomeHash: h('c'),
  verificationLevel: level,
  evidenceBundleHash: h('d'),
  evidenceBundleAsOf: T0,
  evidenceCommitment: h('e'),
  hold: 'ABSENT',
  occurredAt: '2027-03-01T10:00:00.000Z',
});
const markOf = (value: string) => ({
  metricId: 'running.elapsed_time',
  value,
  unit: 'ms',
  precision: 0,
});
const entry = (n: number, rank: number, tied: boolean, value: string, level = 'V2') => ({
  rank,
  tied,
  holder: { holderType: 'ATHLETE', holderId: id(700 + n) },
  value: markOf(value),
  comparatorTrace: [{ key: 'elapsedTimeMs', order: 'LOWER_IS_BETTER', value }],
  basis: [basis(n, level)],
});
const snapshot = (patch: Record<string, unknown> = {}) => ({
  systemId: id(10),
  systemVersionId: id(11),
  specHash: h('f'),
  kind: 'PLATFORM',
  method: 'BEST_MARK',
  engineVersion: 'ranking-engine/1',
  provenance: 'REFERENCE_FIXTURE',
  runInputHash: h('1'),
  runOutcomeHash: h('2'),
  asOf: '2027-06-01T00:00:00.000Z',
  lineage: { kind: 'INITIAL' },
  entries: [entry(1, 1, true, '900000'), entry(2, 1, true, '900000'), entry(3, 3, false, '905000')],
  ...patch,
});
const candidate = (patch: Record<string, unknown> = {}) => ({
  resultId: id(101),
  resultVersionId: id(201),
  contentHash: h('a'),
  scopeType: 'CONTEST',
  status: 'FINAL',
  competitionId: id(300),
  eventId: id(301),
  contestId: id(401),
  participantId: id(501),
  holder: { holderType: 'ATHLETE', holderId: id(701) },
  ordinal: 1,
  mark: markOf('900000'),
  valid: true,
  occurredAt: '2027-03-01T10:00:00.000Z',
  verification: { state: 'CURRENT', runId: id(601), level: 'V2' },
  ...patch,
});
const runInput = (candidates: unknown[]) => ({
  provenance: 'REFERENCE_FIXTURE',
  assembler: 'test-fixture',
  supportedFactKinds: ['RESULT_STATUS', 'VERIFICATION'],
  system: {
    systemId: id(10),
    code: 'fictional-5k',
    kind: 'PLATFORM',
    systemVersionId: id(11),
    version: 1,
    specHash: h('f'),
    spec: platformSystem(),
    lifecycle: 'PUBLISHED',
  },
  discipline: {
    disciplineVersionId: DV,
    sport: 'running',
    discipline: 'running.5k',
    metric: {
      key: 'elapsedTimeMs',
      valueType: 'DURATION_MS',
      unit: 'ms',
      order: 'LOWER_IS_BETTER',
    },
  },
  asOf: '2027-06-01T00:00:00.000Z',
  candidates,
});

describe('RankingSystemVersion (BEST_MARK, floors raise-only, platform never masquerades)', () => {
  it('1. accepts a valid PLATFORM BEST_MARK system (with the exact DV) and hashes deterministically', () => {
    const a = validateRankingSystemSpec(platformSystem(), { discipline: RUNNING });
    expect(codes(a)).toEqual([]);
    const b = validateRankingSystemSpec(
      Object.fromEntries(Object.entries(platformSystem()).reverse()),
      { discipline: RUNNING },
    );
    expect(a.ok && b.ok && a.specHash === b.specHash && a.universeHash === b.universeHash).toBe(
      true,
    );
  });

  it('2. rejects an unknown ranking type / kind, and names a deferred method POLICY_UNSUPPORTED', () => {
    expect(codes(validateRankingSystemSpec(platformSystem({ method: 'ELO' })))).toEqual([
      'BRJ_ENUM',
    ]);
    expect(codes(validateRankingSystemSpec(platformSystem({ kind: 'FEDERATION' })))).toEqual([
      'BRJ_ENUM',
    ]);
    expect(codes(validateRankingSystemSpec(platformSystem({ method: 'POINTS_TABLE' })))).toEqual([
      'POLICY_UNSUPPORTED',
    ]);
  });

  it('3. rejects an invalid verification floor / non-FINAL status', () => {
    const bad = (req: unknown) =>
      codes(validateRankingSystemSpec(platformSystem({ requirements: req })));
    expect(bad({ minimumVerificationLevel: 'V5', minimumResultStatus: 'FINAL' })).toEqual([
      'BRJ_ENUM',
    ]);
    expect(bad({ minimumVerificationLevel: 'V2', minimumResultStatus: 'OFFICIAL' })).toEqual([
      'BRJ_ENUM',
    ]);
  });

  it('4. the platform floor can be raised, never lowered (PLATFORM V2, OFFICIAL V3)', () => {
    expect(RANKING_PLATFORM_FLOOR.PLATFORM.minimumVerificationLevel).toBe('V2');
    expect(RANKING_PLATFORM_FLOOR.OFFICIAL.minimumVerificationLevel).toBe('V3');
    const req = (lvl: string) => ({ minimumVerificationLevel: lvl, minimumResultStatus: 'FINAL' });
    expect(codes(validateRankingSystemSpec(platformSystem({ requirements: req('V1') })))).toEqual([
      'BELOW_PLATFORM_FLOOR',
    ]);
    expect(codes(validateRankingSystemSpec(platformSystem({ requirements: req('V3') })))).toEqual(
      [],
    );
    expect(codes(validateRankingSystemSpec(officialSystem({ requirements: req('V2') })))).toEqual([
      'BELOW_PLATFORM_FLOOR',
    ]);
  });

  it('5. OFFICIAL requires an anchored owner and a non-PLATFORM recognition scope it covers', () => {
    expect(codes(validateRankingSystemSpec(officialSystem()))).toEqual([]);
    expect(codes(validateRankingSystemSpec(officialSystem({ owner: undefined })))).toEqual([
      'OFFICIAL_OWNER_REQUIRED',
    ]);
    expect(
      codes(
        validateRankingSystemSpec(
          officialSystem({ recognition: { level: 'PLATFORM', sport: ['running'] } }),
        ),
      ),
    ).toEqual(['OFFICIAL_RECOGNITION_CANNOT_BE_PLATFORM']);
    expect(
      codes(
        validateRankingSystemSpec(
          officialSystem({ recognition: { level: 'NATIONAL', sport: ['running'] } }),
        ),
      ),
    ).toEqual(['RECOGNITION_REGION_REQUIRED']);
    // PLATFORM cannot claim a NATIONAL scope or carry an owner.
    expect(
      codes(
        validateRankingSystemSpec(
          platformSystem({
            recognition: { level: 'NATIONAL', sport: ['running'], region: ['CR'] },
            owner: { principalId: id(50), anchorId: id(51) },
          }),
        ),
      ),
    ).toEqual([
      'PLATFORM_KIND_RECOGNITION_ONLY',
      'PLATFORM_RECOGNITION_HAS_NO_REGION',
      'OWNER_NOT_ALLOWED_FOR_PLATFORM',
    ]);
    // The owner's anchor must recognize the declared scope (anchored fact, never asserted).
    const owner = { anchorId: id(51), principalId: id(50) };
    expect(
      codes(
        validateRankingSystemSpec(officialSystem(), {
          owner: {
            ...owner,
            recognitionScope: {
              recognitionLevel: ['NATIONAL'],
              sport: ['running'],
              region: ['CR'],
            },
          },
        }),
      ),
    ).toEqual([]);
    expect(
      codes(
        validateRankingSystemSpec(officialSystem(), {
          owner: {
            ...owner,
            recognitionScope: {
              recognitionLevel: ['REGIONAL'],
              sport: ['running'],
              region: ['CR'],
            },
          },
        }),
      ),
    ).toEqual(['OWNER_RECOGNITION_NOT_COVERED']);
    // A recognition word in a name never widens recognition.
    expect(
      codes(validateRankingSystemSpec(platformSystem({ displayName: 'National 5K ranking' }))),
    ).toEqual(['DISPLAY_NAME_CLAIMS_RECOGNITION']);
  });

  it('10. preserves the exact comparator key and direction (checked against the DisciplineVersion)', () => {
    const v = validateRankingSystemSpec(platformSystem(), { discipline: RUNNING });
    expect(v.ok && v.spec.comparator.keys).toEqual([
      { metric: 'elapsedTimeMs', order: 'LOWER_IS_BETTER' },
    ]);
    const flipped = platformSystem({
      comparator: { keys: [{ metric: 'elapsedTimeMs', order: 'HIGHER_IS_BETTER' }] },
    });
    expect(codes(validateRankingSystemSpec(flipped, { discipline: RUNNING }))).toEqual([
      'COMPARATOR_MISMATCH',
    ]);
    const ordinal = platformSystem({
      comparator: { keys: [{ metric: 'elapsedTimeMs', order: 'ORDINAL' }] },
    });
    expect(codes(validateRankingSystemSpec(ordinal))).toEqual(['COMPARATOR_UNDEFINED']);
    const twoKeys = platformSystem({
      comparator: {
        keys: [
          { metric: 'elapsedTimeMs', order: 'LOWER_IS_BETTER' },
          { metric: 'elapsedTimeMs', order: 'LOWER_IS_BETTER' },
        ],
      },
    });
    expect(codes(validateRankingSystemSpec(twoKeys))).toEqual([
      'DUPLICATE_COMPARATOR_KEY',
      'BEST_MARK_SINGLE_KEY',
    ]);
  });

  it('versions keep one universe, kind and owner; a different universe is a different system', () => {
    const a = validateRankingSystemSpec(platformSystem());
    const raised = validateRankingSystemSpec(
      platformSystem({
        requirements: { minimumVerificationLevel: 'V3', minimumResultStatus: 'FINAL' },
      }),
    );
    const otherWindow = validateRankingSystemSpec(
      platformSystem({
        universe: { ...UNIVERSE, window: { from: '2028-01-01T00:00:00.000Z' } },
      }),
    );
    if (!a.ok || !raised.ok || !otherWindow.ok) throw new Error('fixtures must validate');
    expect(rankingSystemVersionContinues(a.spec, raised.spec)).toEqual({ ok: true });
    expect(rankingSystemVersionContinues(a.spec, otherWindow.spec).code).toBe(
      'UNIVERSE_CHANGE_REQUIRES_NEW_SYSTEM',
    );
    expect(rankingUniverseHash(a.spec)).toBe(rankingUniverseHash(raised.spec));
  });

  it('19. a declared population is representable but fails closed (no producer); never invented', () => {
    const v = validateRankingSystemSpec(
      platformSystem({
        universe: { ...UNIVERSE, population: { handicapMode: 'SCRATCH' } },
      }),
    );
    if (!v.ok) throw new Error('population declaration must validate');
    expect(requiredRankingFactKinds(v.spec)).toContain('POPULATION');
    expect(unsupportedRequiredFactKinds(v.spec)).toEqual(['HOLD_STATE', 'POPULATION']);
    expect(PRODUCTION_SUPPORTED_RANKING_FACT_KINDS).not.toContain('POPULATION');
    // Only the bounded BRT-09 dimensions exist: no invented eligibility / season / federation member.
    for (const invented of [{ season: '2027' }, { federationMember: 'YES' }, { ageGroup: 'u23' }])
      expect(
        validateRankingSystemSpec(
          platformSystem({ universe: { ...UNIVERSE, population: invented } }),
        ).ok,
      ).toBe(false);
    // OFFICIAL additionally needs the owner publication act, which has no producer.
    const o = validateRankingSystemSpec(officialSystem());
    if (!o.ok) throw new Error('official fixture must validate');
    expect(unsupportedRequiredFactKinds(o.spec)).toEqual(['HOLD_STATE', 'RANKING_PUBLICATION']);
  });
});

describe('ClassificationPolicy (DV keys only, closed aggregation)', () => {
  const PADEL: RankingDisciplineContext = {
    disciplineVersionId: DV,
    status: 'PUBLISHED',
    sport: 'padel',
    discipline: 'padel.doubles',
    spec: {
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
      participation: { participantKinds: ['TEAM'], lineupSize: { min: 2, max: 2 } },
    },
  };
  const policy = (aggregation: string, patch: Record<string, unknown> = {}) => ({
    targetEngine: 'classification-engine/1',
    displayName: 'Fictional group table',
    scopeType: 'ROUND_CLASSIFICATION',
    disciplineVersionId: DV,
    minimumInputStatus: 'PROVISIONAL',
    primary: 'HEAD_TO_HEAD_WINNER',
    keys: [
      {
        metric: 'setsWon',
        markMetricId: 'padel.sets_won',
        order: 'HIGHER_IS_BETTER',
        source: 'ENTRY_PRIMARY_MARK',
        aggregation,
      },
      {
        metric: 'gamesWon',
        markMetricId: 'padel.games_won',
        order: 'HIGHER_IS_BETTER',
        source: 'PERFORMANCE',
        aggregation,
      },
    ],
    outcomePoints: [
      { outcome: 'WIN', points: 3 },
      { outcome: 'DRAW', points: 1 },
      { outcome: 'LOSS', points: 0 },
    ],
    ...patch,
  });

  it('6. AVERAGE is refused as POLICY_UNSUPPORTED (no rounding policy exists)', () => {
    expect(codes(validateClassificationPolicySpec(policy('AVERAGE'), PADEL))).toEqual([
      'POLICY_UNSUPPORTED',
      'POLICY_UNSUPPORTED',
    ]);
  });

  it('7–9. SUM, MAX and MIN are accepted', () => {
    for (const agg of ['SUM', 'MAX', 'MIN'])
      expect(codes(validateClassificationPolicySpec(policy(agg), PADEL))).toEqual([]);
  });

  it('10b. keys must equal the DV comparator keys in order and direction; points rules enforced', () => {
    const reordered = policy('SUM', {
      keys: [...policy('SUM').keys].reverse(),
    });
    expect(codes(validateClassificationPolicySpec(reordered, PADEL))).toEqual([
      'COMPARATOR_MISMATCH',
    ]);
    const v = validateClassificationPolicySpec(policy('SUM'), PADEL);
    expect(v.ok && v.spec.keys.map((k) => k.metric)).toEqual(['setsWon', 'gamesWon']);
    expect(
      codes(validateClassificationPolicySpec(policy('SUM', { outcomePoints: undefined }), PADEL)),
    ).toEqual(['OUTCOME_POINTS_REQUIRED']);
    expect(
      codes(
        validateClassificationPolicySpec(
          policy('SUM', { keys: [policy('SUM').keys[0], policy('SUM').keys[0]] }),
        ),
      ),
    ).toEqual(['DUPLICATE_COMPARATOR_KEY']);
  });
});

describe('Ranking entries, snapshots and run inputs', () => {
  it('11. competition-style shared ties (1, 1, 3) are valid; no hidden tie-break exists', () => {
    expect(codes(validateRankingSnapshot(snapshot()))).toEqual([]);
    const e = snapshot().entries;
    expect(checkCompetitionRanking(e, 'LOWER_IS_BETTER')).toEqual([]);
    // Dense ranks (1, 1, 2) or an unflagged tie are refused.
    expect(
      checkCompetitionRanking(
        [entry(1, 1, true, '900000'), entry(2, 1, true, '900000'), entry(3, 2, false, '905000')],
        'LOWER_IS_BETTER',
      ).map((i) => i.code),
    ).toEqual(['RANK_SEQUENCE_INVALID']);
    expect(
      checkCompetitionRanking(
        [entry(1, 1, false, '900000'), entry(2, 1, false, '900000')],
        'LOWER_IS_BETTER',
      ).map((i) => i.code),
    ).toEqual(['TIED_FLAG_INCONSISTENT']);
    // Breaking an exact tie by identifier is refused: equal values must share the rank.
    expect(
      checkCompetitionRanking(
        [entry(1, 1, false, '900000'), entry(2, 2, false, '900000')],
        'LOWER_IS_BETTER',
      ).map((i) => i.code),
    ).toEqual(['HIDDEN_TIE_BREAK']);
    // Ranks must follow the declared direction.
    expect(
      checkCompetitionRanking(
        [entry(1, 1, false, '905000'), entry(2, 2, false, '900000')],
        'LOWER_IS_BETTER',
      ).map((i) => i.code),
    ).toEqual(['RANK_ORDER_CONTRADICTS_VALUES']);
  });

  it('12. zero / negative / fractional ranks are rejected', () => {
    for (const rank of [0, -1, 1.5])
      expect(
        validateRankingSnapshot(snapshot({ entries: [entry(1, rank, false, '900000')] })).ok,
      ).toBe(false);
  });

  it('13. malformed hashes are rejected', () => {
    for (const bad of ['sha256:XYZ', h('a').toUpperCase(), 'md5:abc', ''])
      expect(validateRankingSnapshot(snapshot({ specHash: bad })).ok).toBe(false);
  });

  it('14. a RankingSnapshot can never carry a Result lifecycle status', () => {
    for (const status of ['SUBMITTED', 'PROVISIONAL', 'OFFICIAL', 'FINAL', 'SUPERSEDED', 'REVOKED'])
      expect(codes(validateRankingSnapshot(snapshot({ status })))).toEqual(['BRJ_UNKNOWN_FIELD']);
    expect(validateRankingSnapshot(snapshot({ lifecycle: 'FINAL' })).ok).toBe(false);
  });

  it('15. a RankingEntry requires its source provenance (exact verified basis, FINAL, hold known)', () => {
    const noBasis = { ...entry(1, 1, false, '900000'), basis: [] };
    expect(validateRankingSnapshot(snapshot({ entries: [noBasis] })).ok).toBe(false);
    const { verificationRunId: _drop, ...partial } = basis(1);
    expect(
      validateRankingSnapshot(
        snapshot({ entries: [{ ...entry(1, 1, false, '900000'), basis: [partial] }] }),
      ).ok,
    ).toBe(false);
    const provisional = { ...basis(1), resultStatus: 'PROVISIONAL' };
    expect(
      validateRankingSnapshot(
        snapshot({ entries: [{ ...entry(1, 1, false, '900000'), basis: [provisional] }] }),
      ).ok,
    ).toBe(false);
    const holdUnknown = { ...basis(1), hold: 'UNKNOWN' };
    expect(
      validateRankingSnapshot(
        snapshot({ entries: [{ ...entry(1, 1, false, '900000'), basis: [holdUnknown] }] }),
      ).ok,
    ).toBe(false);
    // Below the kind's floor (PLATFORM V2) is refused.
    expect(
      codes(validateRankingSnapshot(snapshot({ entries: [entry(1, 1, false, '900000', 'V1')] }))),
    ).toEqual(['VERIFICATION_LEVEL_BELOW_REQUIRED']);
    // The trace value must equal the ranked mark.
    const drift = { ...entry(1, 1, false, '900000'), value: markOf('899999') };
    expect(codes(validateRankingSnapshot(snapshot({ entries: [drift] })))).toEqual([
      'TRACE_VALUE_MISMATCH',
    ]);
  });

  it('16. a classification ResultVersion can never be a BEST_MARK candidate', () => {
    for (const scopeType of [
      'ROUND_CLASSIFICATION',
      'EVENT_CLASSIFICATION',
      'COMPETITION_CLASSIFICATION',
    ])
      expect(codes(hashRankingRunInput(runInput([candidate({ scopeType })])))).toEqual([
        'BRJ_ENUM',
      ]);
    expect(
      validateRankingSystemSpec(
        platformSystem({
          universe: { ...UNIVERSE, resultScope: 'EVENT_CLASSIFICATION' },
        }),
      ).ok,
    ).toBe(false);
  });

  it('17. an exact Performance basis is accepted; the run input hash is order-independent', () => {
    const c1 = candidate();
    const c2 = candidate({
      resultVersionId: id(202),
      participantId: id(502),
      mark: markOf('905000'),
    });
    const a = hashRankingRunInput(runInput([c1, c2]));
    const b = hashRankingRunInput(runInput([c2, c1]));
    expect(a.ok && b.ok && a.hash === b.hash).toBe(true);
    // The trigger / transaction time are not members of the engine input.
    expect(hashRankingRunInput({ ...runInput([c1]), trigger: 'STAFF_REQUEST' }).ok).toBe(false);
    // A raw-submission candidate is representable as an input (so it can be REPORTED), never a basis.
    expect(hashRankingRunInput(runInput([candidate({ status: 'SUBMITTED' })])).ok).toBe(true);
  });

  it('18. correction linkage: CORRECTS pins the prior snapshot by id + hash with reasons', () => {
    const corrects = {
      kind: 'CORRECTS',
      priorSnapshotId: id(900),
      priorSnapshotHash: h('9'),
      reasons: ['RESULT_SUPERSEDED'],
    };
    expect(codes(validateRankingSnapshot(snapshot({ lineage: corrects })))).toEqual([]);
    expect(
      codes(validateRankingSnapshot(snapshot({ lineage: { ...corrects, reasons: undefined } }))),
    ).toEqual(['CORRECTION_REASONS_REQUIRED']);
    expect(
      codes(validateRankingSnapshot(snapshot({ lineage: { kind: 'CORRECTS', reasons: ['X'] } }))),
    ).toEqual(['LINEAGE_PRIOR_REQUIRED']);
    expect(
      codes(
        validateRankingSnapshot(
          snapshot({ lineage: { kind: 'INITIAL', priorSnapshotId: id(900) } }),
        ),
      ),
    ).toEqual(['LINEAGE_INITIAL_HAS_NO_PRIOR']);
    expect(
      codes(
        validateRankingSnapshot(
          snapshot({
            lineage: { kind: 'FOLLOWS', priorSnapshotId: id(900), priorSnapshotHash: h('9') },
          }),
        ),
      ),
    ).toEqual([]);
  });
});

describe('Qualification basis (vocabulary for the QUALIFIED Achievement)', () => {
  const underlying = (level = 'V3') => ({
    resultVersionId: id(201),
    contentHash: h('a'),
    resultStatus: 'FINAL',
    verificationRunId: id(601),
    verificationOutcomeHash: h('c'),
    verificationLevel: level,
  });
  const fromRanking = (patch: Record<string, unknown> = {}) => ({
    kind: 'RANKING_SNAPSHOT_POSITION',
    targetCompetitionId: id(800),
    qualifyingRanks: 8,
    holder: { holderType: 'ATHLETE', holderId: id(701) },
    ranking: {
      systemId: id(10),
      systemVersionId: id(11),
      snapshotId: id(900),
      snapshotHash: h('9'),
      rank: 3,
      tied: false,
    },
    underlying: [underlying()],
    ...patch,
  });

  it('20. a valid snapshot-position or FINAL-classification basis is accepted', () => {
    expect(codes(validateQualificationBasis(fromRanking()))).toEqual([]);
    const fromClassification = {
      kind: 'CLASSIFICATION_POSITION',
      targetCompetitionId: id(800),
      qualifyingRanks: 3,
      holder: { holderType: 'TEAM', holderId: id(702) },
      classification: {
        resultId: id(101),
        resultVersionId: id(201),
        contentHash: h('a'),
        scopeType: 'EVENT_CLASSIFICATION',
        status: 'FINAL',
        participantId: id(501),
        rank: 1,
        tied: true,
      },
      underlying: [underlying()],
    };
    expect(codes(validateQualificationBasis(fromClassification))).toEqual([]);
    // Not FINAL, a ROUND classification, or below V3: refused.
    expect(
      validateQualificationBasis({
        ...fromClassification,
        classification: { ...fromClassification.classification, status: 'OFFICIAL' },
      }).ok,
    ).toBe(false);
    expect(
      validateQualificationBasis({
        ...fromClassification,
        classification: { ...fromClassification.classification, scopeType: 'ROUND_CLASSIFICATION' },
      }).ok,
    ).toBe(false);
    expect(
      codes(validateQualificationBasis(fromRanking({ underlying: [underlying('V2')] }))),
    ).toEqual(['VERIFICATION_LEVEL_BELOW_REQUIRED']);
  });

  it('qualification coherence: kind ↔ position member; position within the qualifying ranks', () => {
    expect(codes(validateQualificationBasis(fromRanking({ qualifyingRanks: 2 })))).toEqual([
      'POSITION_OUTSIDE_QUALIFYING_RANKS',
    ]);
    expect(
      codes(validateQualificationBasis(fromRanking({ kind: 'CLASSIFICATION_POSITION' }))),
    ).toEqual(['QUALIFICATION_BASIS_KIND_MISMATCH', 'QUALIFICATION_BASIS_KIND_MISMATCH']);
    // No status / decision member exists: qualification is never an entity or a flag.
    expect(validateQualificationBasis(fromRanking({ qualified: true })).ok).toBe(false);
  });
});

describe('Vocabulary closure', () => {
  it('reuses BRT-08/09 blocker codes and classifies each blocker into exactly one state', () => {
    for (const reused of [
      'RESULT_STATUS_BELOW_REQUIRED',
      'VERIFICATION_LEVEL_BELOW_REQUIRED',
      'POPULATION_FACT_UNAVAILABLE',
      'HOLD_STATE_UNAVAILABLE',
      'HOLD_ACTIVE',
      'RESULT_SUPERSEDED',
      'RESULT_REVOKED',
    ])
      expect(ALL_RANKING_BLOCKERS).toContain(reused);
    expect(new Set(Object.values(RANKING_BLOCKERS))).toEqual(
      new Set(['INTEGRITY_FAILURE', 'INELIGIBLE', 'PENDING_REQUIRED_FACTS']),
    );
  });

  it('registers every BRT-10 schema in the platform canonicalizer', () => {
    const c = platformCanonicalizer();
    for (const ref of [
      SchemaRef.resultVersionContentV2,
      SchemaRef.classificationPolicy,
      SchemaRef.rankingSystemVersion,
      SchemaRef.rankingUniverse,
      SchemaRef.rankingRunInput,
      SchemaRef.rankingRunOutcome,
      SchemaRef.rankingSnapshot,
      SchemaRef.qualificationBasis,
    ])
      expect(c.schema(ref.id, ref.version).$id).toBe(ref.id);
  });
});
