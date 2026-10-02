import { describe, expect, it } from 'vitest';
import {
  checkCompetitionRanking,
  evaluateRankingRun,
  excludedCandidates,
  RANKING_ENGINE_VERSION,
  validateRankingSnapshot,
  type RankingRunOutcome,
} from './index';
import { RK, rankCandidate, rankingRunInput, rkId, timeMark } from './fixtures';

/**
 * BRT-10 Step 3 — BEST_MARK ranking engine.
 * REFERENCE ENGINE FIXTURES — NOT PERSISTED SPORTING TRUTH (fictional ids and values).
 */
const run = (candidates: unknown[], patch: Parameters<typeof rankingRunInput>[1] = {}) => {
  const r = evaluateRankingRun(rankingRunInput(candidates, patch));
  if (!r.ok) throw new Error(`run input refused: ${JSON.stringify(r.issues)}`);
  return r;
};
const stateOf = (o: RankingRunOutcome, n: number) =>
  o.candidates.find((c) => c.resultVersionId === rkId(200 + n));
const rankOf = (o: RankingRunOutcome, holder: number) =>
  o.entries.find((e) => e.holder.holderId === rkId(700 + holder));
/** One candidate's [state, reasons]. */
const only = (patch: object, n = 1) => {
  const o = run([rankCandidate(n, 1, '900000', patch)]).outcome;
  const c = stateOf(o, n);
  return [c?.state, c?.reasons];
};

describe('BEST_MARK selection and ranking', () => {
  it('1. a single holder with a single admissible mark is ranked 1 with its exact basis', () => {
    const { outcome } = run([rankCandidate(1, 1, '900000')]);
    expect(outcome.entries).toHaveLength(1);
    const e = outcome.entries[0];
    expect(e?.rank).toBe(1);
    expect(e?.tied).toBe(false);
    expect(e?.value).toEqual(timeMark('900000'));
    expect(e?.comparatorTrace).toEqual([
      { key: 'elapsedTimeMs', order: 'LOWER_IS_BETTER', value: '900000' },
    ]);
    expect(e?.basis.map((b) => [b.resultVersionId, b.verificationRunId, b.hold])).toEqual([
      [rkId(201), rkId(601), 'ABSENT'],
    ]);
    expect(outcome.candidates.map((c) => c.state)).toEqual(['INCLUDED']);
    expect(outcome.publication).toEqual({ state: 'PUBLISHABLE', reasons: [] });
  });

  it('2. multiple holders are each ranked under the pinned comparator (lower time is better)', () => {
    const { outcome } = run([
      rankCandidate(1, 1, '910000'),
      rankCandidate(2, 2, '900000'),
      rankCandidate(3, 3, '920000'),
    ]);
    expect([1, 2, 3].map((h) => rankOf(outcome, h)?.rank)).toEqual([2, 1, 3]);
  });

  it("3. the holder's best mark is the entry value", () => {
    const { outcome } = run([
      rankCandidate(1, 1, '910000'),
      rankCandidate(2, 1, '899000'),
      rankCandidate(3, 1, '930000'),
    ]);
    expect(outcome.entries).toHaveLength(1);
    expect(rankOf(outcome, 1)?.value.value).toBe('899000');
    expect(rankOf(outcome, 1)?.basis.map((b) => b.resultVersionId)).toEqual([rkId(202)]);
  });

  it('4. equal best marks of one holder are ALL retained as basis (no hidden choice)', () => {
    const a = run([rankCandidate(1, 1, '900000'), rankCandidate(2, 1, '900000')]).outcome;
    const b = run([rankCandidate(2, 1, '900000'), rankCandidate(1, 1, '900000')]).outcome;
    expect(rankOf(a, 1)?.basis.map((x) => x.resultVersionId)).toEqual([rkId(201), rkId(202)]);
    expect(a.candidates.map((c) => c.state)).toEqual(['INCLUDED', 'INCLUDED']);
    expect(a).toEqual(b);
  });

  it('5. a strictly worse mark of the same holder is NOT_HOLDER_BEST (reported, not dropped)', () => {
    const { outcome } = run([rankCandidate(1, 1, '900000'), rankCandidate(2, 1, '905000')]);
    expect(stateOf(outcome, 2)).toEqual({
      resultVersionId: rkId(202),
      participantId: rkId(502),
      ordinal: 1,
      state: 'NOT_HOLDER_BEST',
      reasons: ['NOT_HOLDER_BEST'],
    });
    expect(excludedCandidates(outcome).map((c) => c.resultVersionId)).toEqual([rkId(202)]);
  });

  it('6–8. global competition ranking: equal values share the rank, the next rank skips (1, 1, 3, 4)', () => {
    const { outcome } = run([
      rankCandidate(1, 1, '900000'),
      rankCandidate(2, 2, '900000'),
      rankCandidate(3, 3, '905000'),
      rankCandidate(4, 4, '910000'),
    ]);
    expect([1, 2, 3, 4].map((h) => [rankOf(outcome, h)?.rank, rankOf(outcome, h)?.tied])).toEqual([
      [1, true],
      [1, true],
      [3, false],
      [4, false],
    ]);
    expect(checkCompetitionRanking(outcome.entries, 'LOWER_IS_BETTER')).toEqual([]);
    // The output is valid published snapshot content (Step 2 validator).
    const snapshot = {
      systemId: RK.SYSTEM,
      systemVersionId: RK.SYSTEM_VERSION,
      specHash: outcome.specHash,
      kind: 'PLATFORM',
      method: 'BEST_MARK',
      engineVersion: outcome.engineVersion,
      provenance: outcome.provenance,
      runInputHash: outcome.inputHash,
      runOutcomeHash: outcome.inputHash,
      asOf: outcome.asOf,
      lineage: { kind: 'INITIAL' },
      entries: outcome.entries,
    };
    expect(validateRankingSnapshot(snapshot).ok).toBe(true);
  });

  it('9. an exact tie is never broken by identifier or input order (hidden tie-break rejected)', () => {
    const fwd = run([rankCandidate(1, 1, '900000'), rankCandidate(2, 2, '900000')]);
    const rev = run([rankCandidate(2, 2, '900000'), rankCandidate(1, 1, '900000')]);
    expect(fwd.outcome.entries.map((e) => e.rank)).toEqual([1, 1]);
    expect(fwd.outcomeHash).toBe(rev.outcomeHash);
    // Any output that broke the tie (1, 2) would be refused by the shared tie validator.
    const broken = fwd.outcome.entries.map((e, i) => ({ ...e, rank: i + 1, tied: false }));
    expect(checkCompetitionRanking(broken, 'LOWER_IS_BETTER').map((i) => i.code)).toEqual([
      'HIDDEN_TIE_BREAK',
    ]);
  });
});

describe('BEST_MARK admissibility (fail closed, every candidate accounted for)', () => {
  it('10. FINAL is required', () => {
    for (const status of ['SUBMITTED', 'PROVISIONAL', 'OFFICIAL'])
      expect(only({ status })).toEqual([
        'PENDING_REQUIRED_FACTS',
        ['RESULT_STATUS_BELOW_REQUIRED'],
      ]);
  });

  it('11. insufficient verification is rejected (below the effective floor)', () => {
    const v1 = rankCandidate(1, 1, '900000').verification;
    expect(only({ verification: { ...v1, level: 'V1' } })).toEqual([
      'PENDING_REQUIRED_FACTS',
      ['VERIFICATION_LEVEL_BELOW_REQUIRED'],
    ]);
    // A raised floor (V3) is honoured.
    const raised = run([rankCandidate(1, 1, '900000')], {
      spec: { requirements: { minimumVerificationLevel: 'V3', minimumResultStatus: 'FINAL' } },
    }).outcome;
    expect(stateOf(raised, 1)?.reasons).toEqual(['VERIFICATION_LEVEL_BELOW_REQUIRED']);
    const { runId: _r, ...incomplete } = v1;
    expect(only({ verification: incomplete })).toEqual([
      'PENDING_REQUIRED_FACTS',
      ['VERIFICATION_RUN_INCOMPLETE'],
    ]);
  });

  it('12. stale / not evaluated / policy-unavailable verification is rejected', () => {
    for (const [state, code] of [
      ['STALE', 'VERIFICATION_STALE'],
      ['NOT_EVALUATED', 'VERIFICATION_NOT_EVALUATED'],
      ['POLICY_UNAVAILABLE', 'VERIFICATION_POLICY_UNAVAILABLE'],
    ] as const)
      expect(only({ verification: { state } })).toEqual(['PENDING_REQUIRED_FACTS', [code]]);
  });

  it('13. an active hold is rejected', () => {
    expect(only({ hold: { active: true } })).toEqual(['PENDING_REQUIRED_FACTS', ['HOLD_ACTIVE']]);
  });

  it('14. an unknown hold is rejected (absence is never "no hold"); production has no producer', () => {
    expect(only({ hold: undefined })).toEqual([
      'PENDING_REQUIRED_FACTS',
      ['HOLD_STATE_UNAVAILABLE'],
    ]);
    const production = run([rankCandidate(1, 1, '900000')], {
      supportedFactKinds: [
        'RESULT_STATUS',
        'VERIFICATION',
        'CONTEST_OCCURRENCE',
        'COMPETITION_MEMBERSHIP',
      ],
    }).outcome;
    expect(stateOf(production, 1)?.reasons).toEqual(['HOLD_STATE_UNAVAILABLE']);
    expect(production.entries).toEqual([]);
  });

  it('15. an invalid Performance is rejected', () => {
    expect(only({ valid: false })).toEqual(['INELIGIBLE', ['PERFORMANCE_INVALID']]);
  });

  it('16. a wrong metric / unit / precision is rejected (no coercion)', () => {
    expect(only({ mark: timeMark('900000', { metricId: 'running.pace' }) })).toEqual([
      'INELIGIBLE',
      ['METRIC_MISMATCH'],
    ]);
    expect(only({ mark: timeMark('900', { unit: 's' }) })).toEqual([
      'INELIGIBLE',
      ['METRIC_UNIT_MISMATCH'],
    ]);
    expect(only({ mark: timeMark('900000.5', { precision: 1 }) })).toEqual([
      'INELIGIBLE',
      ['METRIC_PRECISION_MISMATCH'],
    ]);
  });

  it('17. a wrong DisciplineVersion (or non-comparable DV metric) is a run integrity failure', () => {
    const wrongDv = run([rankCandidate(1, 1, '900000'), rankCandidate(2, 2, '905000')], {
      discipline: { disciplineVersionId: rkId(2) },
    }).outcome;
    expect(wrongDv.candidates.map((c) => [c.state, c.reasons])).toEqual([
      ['INTEGRITY_FAILURE', ['DISCIPLINE_VERSION_MISMATCH']],
      ['INTEGRITY_FAILURE', ['DISCIPLINE_VERSION_MISMATCH']],
    ]);
    expect(wrongDv.entries).toEqual([]);
    expect(wrongDv.publication).toEqual({
      state: 'BLOCKED',
      reasons: ['DISCIPLINE_VERSION_MISMATCH', 'NO_RANKED_ENTRIES'],
    });
    const flipped = run([rankCandidate(1, 1, '900000')], {
      discipline: {
        metric: {
          key: 'elapsedTimeMs',
          valueType: 'DURATION_MS',
          unit: 'ms',
          order: 'HIGHER_IS_BETTER',
        },
      },
    }).outcome;
    expect(stateOf(flipped, 1)?.reasons).toEqual(['COMPARATOR_MISMATCH']);
    const noOrder = run([rankCandidate(1, 1, '900000')], {
      discipline: { metric: { key: 'elapsedTimeMs', valueType: 'DURATION_MS', unit: 'ms' } },
    }).outcome;
    expect(stateOf(noOrder, 1)?.reasons).toEqual(['METRIC_NOT_COMPARABLE']);
    const tampered = run([rankCandidate(1, 1, '900000')], {
      system: { specHash: `sha256:${'0'.repeat(64)}` },
    }).outcome;
    expect(stateOf(tampered, 1)?.reasons).toEqual(['SPEC_HASH_MISMATCH']);
  });

  it('18. a performance outside the window (or before effectiveFrom) is rejected', () => {
    expect(only({ occurredAt: '2026-12-31T23:59:59.999Z' })).toEqual([
      'INELIGIBLE',
      ['PERFORMANCE_OUTSIDE_WINDOW'],
    ]);
    // [from, to): `to` itself is outside.
    const late = run([rankCandidate(1, 1, '900000', { occurredAt: '2028-01-01T00:00:00.000Z' })], {
      asOf: '2028-06-01T00:00:00.000Z',
    }).outcome;
    expect(stateOf(late, 1)?.reasons).toEqual(['PERFORMANCE_OUTSIDE_WINDOW']);
    expect(only({ occurredAt: undefined })).toEqual([
      'PENDING_REQUIRED_FACTS',
      ['OCCURRENCE_TIME_UNKNOWN'],
    ]);
  });

  it('19. a performance after asOf is rejected (asOf itself is admitted)', () => {
    expect(only({ occurredAt: '2027-06-01T00:00:00.001Z' })).toEqual([
      'INELIGIBLE',
      ['PERFORMANCE_AFTER_AS_OF'],
    ]);
    expect(only({ occurredAt: RK.AS_OF })).toEqual(['INCLUDED', []]);
  });

  it('20. missing competition membership is rejected; an explicit competition set is enforced', () => {
    expect(only({ eventId: undefined })).toEqual([
      'PENDING_REQUIRED_FACTS',
      ['COMPETITION_MEMBERSHIP_UNAVAILABLE'],
    ]);
    const scoped = run([rankCandidate(1, 1, '900000')], {
      spec: {
        universe: { ...rankingRunInput([]).system.spec.universe, competitionIds: [rkId(999)] },
      },
    }).outcome;
    expect(stateOf(scoped, 1)?.reasons).toEqual(['OUTSIDE_COMPETITION_SCOPE']);
  });

  it('21. a declared population requires typed facts (missing ⇒ pending, different ⇒ ineligible)', () => {
    const universe = {
      ...rankingRunInput([]).system.spec.universe,
      population: { handicapMode: 'SCRATCH' },
    };
    const o = run(
      [
        rankCandidate(1, 1, '900000'),
        rankCandidate(2, 2, '900000', {
          population: [{ dimension: 'HANDICAP_MODE', value: 'HANDICAP' }],
        }),
        rankCandidate(3, 3, '900000', {
          population: [{ dimension: 'HANDICAP_MODE', value: 'SCRATCH' }],
        }),
      ],
      { spec: { universe } },
    ).outcome;
    expect([1, 2, 3].map((n) => [stateOf(o, n)?.state, stateOf(o, n)?.reasons])).toEqual([
      ['PENDING_REQUIRED_FACTS', ['POPULATION_FACT_UNAVAILABLE']],
      ['INELIGIBLE', ['POPULATION_MISMATCH']],
      ['INCLUDED', []],
    ]);
  });

  it('24. a superseded result is rejected (by status or successor pointer)', () => {
    expect(only({ status: 'SUPERSEDED' })).toEqual(['INELIGIBLE', ['RESULT_SUPERSEDED']]);
    expect(only({ supersededByVersionId: rkId(299) })).toEqual([
      'INELIGIBLE',
      ['RESULT_SUPERSEDED'],
    ]);
  });

  it('25. a revoked (or rejected) result is rejected', () => {
    expect(only({ status: 'REVOKED' })).toEqual(['INELIGIBLE', ['RESULT_REVOKED']]);
    expect(only({ status: 'REJECTED' })).toEqual(['INELIGIBLE', ['RESULT_REJECTED']]);
  });

  it('holder: unresolved is integrity; a different holder type is outside the universe', () => {
    expect(only({ holder: undefined })).toEqual(['INTEGRITY_FAILURE', ['HOLDER_UNRESOLVED']]);
    expect(only({ holder: { holderType: 'TEAM', holderId: rkId(701) } })).toEqual([
      'INELIGIBLE',
      ['HOLDER_TYPE_NOT_IN_UNIVERSE'],
    ]);
    expect(only({ performanceAthleteId: rkId(799) })).toEqual([
      'INTEGRITY_FAILURE',
      ['HOLDER_UNRESOLVED'],
    ]);
  });

  it('precedence: integrity > ineligible > pending > not-holder-best; all reasons reported', () => {
    expect(only({ valid: false, hold: { active: true }, holder: undefined })).toEqual([
      'INTEGRITY_FAILURE',
      ['HOLDER_UNRESOLVED', 'HOLD_ACTIVE', 'PERFORMANCE_INVALID'],
    ]);
  });

  it('OFFICIAL: governing recognition must cover the owner scope; publication fails closed', () => {
    const official = {
      kind: 'OFFICIAL',
      requirements: { minimumVerificationLevel: 'V3', minimumResultStatus: 'FINAL' },
      recognition: { level: 'NATIONAL', sport: ['running'], region: ['CR'] },
      owner: { principalId: RK.OWNER, anchorId: RK.ANCHOR },
    };
    const gov = (scope: object | undefined, level = 'NATIONAL') => ({
      ...rankCandidate(1, 1, '900000').verification,
      level: 'V3',
      governingRecognition: {
        recognitionLevel: level,
        anchorId: RK.ANCHOR,
        source: 'SANCTION',
        anchorFactHash: rankCandidate(1, 1, '900000').verification.snapshotHash,
        ...(scope === undefined ? {} : { recognitionScope: scope }),
      },
    });
    const covered = { recognitionLevel: ['NATIONAL'], sport: ['running'], region: ['CR'] };
    const o = run(
      [
        rankCandidate(1, 1, '900000', { verification: gov(covered) }),
        rankCandidate(2, 2, '900000', { verification: gov({ ...covered, region: ['PA'] }) }),
        rankCandidate(3, 3, '900000', { verification: gov(undefined) }),
        rankCandidate(4, 4, '900000', { verification: gov(covered, 'PLATFORM') }),
      ],
      { spec: official },
    ).outcome;
    expect([1, 2, 3, 4].map((n) => stateOf(o, n)?.reasons)).toEqual([
      [],
      ['RECOGNITION_REGION_NOT_COVERED'],
      ['GOVERNING_RECOGNITION_UNAVAILABLE'],
      ['RECOGNITION_PLATFORM_CANNOT_BACK_CLAIM'],
    ]);
    // No RANKING_PUBLICATION producer: evaluated, never publishable.
    expect(o.publication).toEqual({ state: 'BLOCKED', reasons: ['OWNER_PUBLICATION_UNAVAILABLE'] });
    const retired = run([rankCandidate(1, 1, '900000')], { system: { lifecycle: 'RETIRED' } });
    expect(retired.outcome.publication.reasons).toEqual(['SYSTEM_VERSION_RETIRED']);
  });
});

describe('BEST_MARK publication: a snapshot always ranks someone (NO_RANKED_ENTRIES)', () => {
  const blockedRun = () =>
    run([
      rankCandidate(1, 1, '900000', { status: 'PROVISIONAL' }),
      rankCandidate(2, 2, '901000', { hold: { active: true } }),
      rankCandidate(3, 3, '902000', { valid: false }),
    ]).outcome;

  it('A. all candidates blocked ⇒ zero entries ⇒ publication BLOCKED with NO_RANKED_ENTRIES', () => {
    const o = blockedRun();
    expect(o.candidates.every((c) => c.state !== 'INCLUDED' && c.reasons.length > 0)).toBe(true);
    expect(o.entries).toEqual([]);
    expect(o.publication).toEqual({ state: 'BLOCKED', reasons: ['NO_RANKED_ENTRIES'] });
    // A run with no candidates at all is blocked the same way.
    expect(run([]).outcome.publication).toEqual({
      state: 'BLOCKED',
      reasons: ['NO_RANKED_ENTRIES'],
    });
  });

  it('B. NO_RANKED_ENTRIES is run-level only: never a candidate reason', () => {
    const o = blockedRun();
    expect(o.candidates.flatMap((c) => c.reasons)).not.toContain('NO_RANKED_ENTRIES');
    expect(o.candidates.map((c) => [c.state, c.reasons])).toEqual([
      ['PENDING_REQUIRED_FACTS', ['RESULT_STATUS_BELOW_REQUIRED']],
      ['PENDING_REQUIRED_FACTS', ['HOLD_ACTIVE']],
      ['INELIGIBLE', ['PERFORMANCE_INVALID']],
    ]);
  });

  it('C. a RankingSnapshot with zero entries is not representable', () => {
    const o = run([rankCandidate(1, 1, '900000')]).outcome;
    const snapshot = {
      systemId: RK.SYSTEM,
      systemVersionId: RK.SYSTEM_VERSION,
      specHash: o.specHash,
      kind: 'PLATFORM',
      method: 'BEST_MARK',
      engineVersion: o.engineVersion,
      provenance: o.provenance,
      runInputHash: o.inputHash,
      runOutcomeHash: o.inputHash,
      asOf: o.asOf,
      lineage: { kind: 'INITIAL' },
      entries: o.entries,
    };
    expect(validateRankingSnapshot(snapshot).ok).toBe(true);
    const empty = validateRankingSnapshot({ ...snapshot, entries: [] });
    expect(empty.ok).toBe(false);
    expect(empty.ok ? [] : empty.issues.map((i) => i.path)).toEqual(['/entries']);
  });

  it('D. positive control: one admissible ranked entry keeps the run PUBLISHABLE', () => {
    const o = run([
      rankCandidate(1, 1, '900000'),
      rankCandidate(2, 2, '901000', { valid: false }),
    ]).outcome;
    expect(o.entries).toHaveLength(1);
    expect(o.publication).toEqual({ state: 'PUBLISHABLE', reasons: [] });
  });
});

describe('BEST_MARK determinism', () => {
  it('22. the same semantic input always yields the same canonical outcome and hash', () => {
    const cs = [
      rankCandidate(1, 1, '900000'),
      rankCandidate(2, 2, '905000'),
      rankCandidate(3, 1, '899000'),
    ];
    const a = run(cs);
    const b = run([...cs].reverse());
    expect(a.inputHash).toBe(b.inputHash);
    expect(a.outcomeHash).toBe(b.outcomeHash);
    expect(JSON.stringify(a.outcome)).toBe(JSON.stringify(b.outcome));
    expect(a.outcome.engineVersion).toBe(RANKING_ENGINE_VERSION);
    expect(a.outcome.inputHash).toBe(a.inputHash);
    expect(a.outcomeHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('23. the trigger never affects the semantic outcome or hash (and is not an input member)', () => {
    const input = rankingRunInput([rankCandidate(1, 1, '900000')]);
    const a = evaluateRankingRun(input, { trigger: 'STAFF_REQUEST' });
    const b = evaluateRankingRun(input, { trigger: 'SCHEDULED_SWEEP' });
    if (!a.ok || !b.ok) throw new Error('fixture must evaluate');
    expect(a.outcomeHash).toBe(b.outcomeHash);
    expect(a.outcome).toEqual(b.outcome);
    expect(a.meta).toEqual({ trigger: 'STAFF_REQUEST' });
    expect(JSON.stringify(a.outcome)).not.toContain('STAFF_REQUEST');
    // Smuggling a trigger into the canonical input is refused, not ignored.
    expect(evaluateRankingRun({ ...input, trigger: 'STAFF_REQUEST' })).toEqual({
      ok: false,
      issues: [{ path: '/trigger', code: 'BRJ_UNKNOWN_FIELD' }],
    });
  });

  it('equal-valued best marks spelled at different precisions are never silently reconciled', () => {
    const decimal = {
      metric: { key: 'elapsedTimeMs', valueType: 'DECIMAL', unit: 'ms', order: 'LOWER_IS_BETTER' },
    };
    const o = run(
      [
        rankCandidate(1, 1, '900.5', { mark: timeMark('900.5', { precision: 1 }) }),
        rankCandidate(2, 1, '900.50', { mark: timeMark('900.50', { precision: 2 }) }),
      ],
      { discipline: decimal },
    ).outcome;
    expect(o.entries).toEqual([]);
    expect([1, 2].map((n) => stateOf(o, n)?.reasons)).toEqual([
      ['METRIC_PRECISION_MISMATCH'],
      ['METRIC_PRECISION_MISMATCH'],
    ]);
  });
});
