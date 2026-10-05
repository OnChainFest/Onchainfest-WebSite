import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DomainError } from '@br/domain';
import { blockingReasons, deriveAchievements, hashCandidate, identityOf } from './engine';
import {
  FIXTURE_RULES,
  FX,
  fixtureHash,
  fixtureId,
  fixtureRule,
  padelTitleFixture,
  personalBestFixture,
  thresholdFixture,
} from './fixtures';
import { referenceThresholdRule } from './rule';
import type { AchievementDerivationSnapshot } from './snapshot';

// REFERENCE ENGINE FIXTURE — NOT PERSISTED SPORTING TRUTH (in memory only).
const derive = (s: AchievementDerivationSnapshot) => deriveAchievements(s);
const candidates = (s: AchievementDerivationSnapshot) => derive(s).outcome.candidates ?? [];
const shuffle = <T>(xs: readonly T[]) => [...xs].reverse();

describe('title / classification (BRT-01 padel walkthrough §6, AC-5)', () => {
  it('one TEAM Achievement for Pair A with immutable memberCredits from the exact credited lineup', () => {
    const d = derive(padelTitleFixture());
    expect(d.outcome.state).toBe('ISSUABLE');
    const cs = d.outcome.candidates ?? [];
    expect(cs).toHaveLength(1); // ONE canonical Achievement — never one per athlete
    const c = cs[0]?.candidate;
    expect(c?.achievementType).toBe('TITLE');
    expect(c?.holder).toEqual({ holderType: 'TEAM', holderId: FX.teamA });
    expect(c?.memberCreditBasis).toBe('CREDITED_LINEUP');
    expect(c?.memberCredits).toEqual(
      [FX.athleteA1, FX.athleteA2]
        .sort()
        .map((athleteId) => ({ athleteId, creditRole: 'LINEUP_MEMBER' })),
    );
    expect(c?.scope).toEqual({ scopeType: 'EVENT', scopeId: FX.event });
    expect(c?.qualifyingValue).toBeUndefined(); // a title is not about a value
    const credited = (c?.memberCredits ?? []).map((m) => m.athleteId);
    for (const never of [FX.athleteB1, FX.athleteB2, FX.unusedRosterAthlete])
      expect(credited).not.toContain(never);
    expect(JSON.stringify(cs)).not.toContain(FX.teamB);
  });

  it('basis pins the exact ResultVersion, content hash, VerificationRun and credited lineup', () => {
    const b = candidates(padelTitleFixture())[0]?.candidate.basis[0];
    expect(b?.resultVersionId).toBe(fixtureId('result-version:rv1'));
    expect(b?.contentHash).toBe(fixtureHash('content:rv1'));
    expect(b?.verificationRunId).toBe(fixtureId('run:rv1:run1'));
    expect(b?.verificationSnapshotHash).toBe(fixtureHash('verification-snapshot:rv1:run1'));
    expect(b?.participantId).toBe(FX.participantA);
    expect(b?.creditedLineupHash).toMatch(/^sha256:/);
  });

  it('no winner inference: the explicit rank decides, never entry order', () => {
    const d = derive(padelTitleFixture({ ranks: { a: 2, b: 1 } }));
    expect(d.outcome.candidates?.[0]?.candidate.holder.holderId).toBe(FX.teamB);
  });

  it('CURRENT V1 → zero title Achievements, VERIFICATION_LEVEL_BELOW_REQUIRED, facts still traced', () => {
    const d = derive(padelTitleFixture({ level: 'V1' }));
    expect(d.outcome.state).toBe('BLOCKED');
    expect(d.outcome.candidates ?? []).toEqual([]);
    expect(blockingReasons(d.outcome)).toEqual(['VERIFICATION_LEVEL_BELOW_REQUIRED']);
    expect(d.outcome.subjects?.find((x) => x.participantId === FX.participantA)?.qualifies).toBe(
      true,
    );
  });

  it('STALE V2 → no new Achievement (VERIFICATION_STALE)', () => {
    const d = derive(padelTitleFixture({ verificationState: 'STALE' }));
    expect(d.outcome.candidates ?? []).toEqual([]);
    expect(blockingReasons(d.outcome)).toEqual(['VERIFICATION_STALE']);
  });

  it('OFFICIAL is not enough for a title (FINAL floor); status and level stay orthogonal', () => {
    expect(
      blockingReasons(derive(padelTitleFixture({ status: 'OFFICIAL', level: 'V4' })).outcome),
    ).toEqual(['RESULT_STATUS_BELOW_REQUIRED']);
    expect(blockingReasons(derive(padelTitleFixture({ status: 'PROVISIONAL' })).outcome)).toEqual([
      'RESULT_STATUS_BELOW_REQUIRED',
    ]);
  });

  it('admitted hold blocks; unknown hold state blocks (never "no hold")', () => {
    expect(blockingReasons(derive(padelTitleFixture({ hold: true })).outcome)).toEqual([
      'HOLD_ACTIVE',
    ]);
    expect(
      blockingReasons(derive(padelTitleFixture({ unsupported: ['HOLD_STATE'] })).outcome),
    ).toEqual(['HOLD_STATE_UNAVAILABLE']);
  });

  it('superseded / revoked / rejected basis never issues', () => {
    expect(blockingReasons(derive(padelTitleFixture({ supersededBy: 'rv2' })).outcome)).toEqual([
      'RESULT_SUPERSEDED',
    ]);
    expect(blockingReasons(derive(padelTitleFixture({ status: 'REVOKED' })).outcome)).toEqual([
      'RESULT_REVOKED',
    ]);
  });

  it('credited lineup unavailable → TEAM title only, no athlete credit (fail closed)', () => {
    const c = candidates(padelTitleFixture({ unsupported: ['CREDITED_LINEUP'] }))[0]?.candidate;
    expect(c?.holder.holderType).toBe('TEAM');
    expect(c?.memberCreditBasis).toBe('CREDITED_LINEUP_UNAVAILABLE');
    expect(c?.memberCredits).toBeUndefined();
  });

  it('a changed credited lineup is different content AND a different logical Achievement', () => {
    const a = candidates(padelTitleFixture())[0];
    const b = candidates(padelTitleFixture({ lineupA: [FX.athleteA1, FX.unusedRosterAthlete] }))[0];
    expect(a?.candidateHash).not.toBe(b?.candidateHash);
    expect(a?.identityHash).not.toBe(b?.identityHash);
  });

  it('rule applies only to its exact DisciplineVersion and result scope', () => {
    const s = padelTitleFixture();
    const other = { ...s, discipline: { ...s.discipline, disciplineVersionId: FX.otherDv } };
    expect(blockingReasons(derive(other).outcome)).toContain('RULE_DISCIPLINE_VERSION_MISMATCH');
    const contest = { ...s, resultVersion: { ...s.resultVersion, scopeType: 'CONTEST' as const } };
    expect(blockingReasons(derive(contest).outcome)).toContain('RESULT_SCOPE_MISMATCH');
  });
});

describe('performance threshold (sport-neutral; bowling-like fixture)', () => {
  it('300 ≥ 300 → Achievement; qualifyingValue equals the exact source Performance mark', () => {
    const cs = candidates(thresholdFixture());
    expect(cs).toHaveLength(1);
    const c = cs[0]?.candidate;
    expect(c?.holder).toEqual({ holderType: 'ATHLETE', holderId: FX.bowler });
    expect(c?.qualifyingValue).toEqual({
      metricId: 'score',
      value: '300',
      unit: 'pins',
      precision: 0,
    });
    expect(c?.basis[0]?.performanceOrdinal).toBe(2);
    expect(c?.scope).toEqual({ scopeType: 'CONTEST', scopeId: FX.contest });
  });

  it('boundaries: 299 no; 301 yes (above); wrong metric / DV / invalid / stale / V1 / superseded no', () => {
    expect(candidates(thresholdFixture({ value: '299' }))).toHaveLength(0);
    expect(
      derive(thresholdFixture({ value: '299' })).outcome.subjects?.find(
        (x) => x.performanceOrdinal === 2,
      )?.reasons,
    ).toEqual(['THRESHOLD_NOT_MET']);
    expect(candidates(thresholdFixture({ value: '301' }))).toHaveLength(1);
    expect(candidates(thresholdFixture({ metricId: 'lane_oil' }))).toHaveLength(0);
    expect(blockingReasons(derive(thresholdFixture({ dv: FX.otherDv })).outcome)).toContain(
      'RULE_DISCIPLINE_VERSION_MISMATCH',
    );
    expect(candidates(thresholdFixture({ valid: false }))).toHaveLength(0);
    expect(candidates(thresholdFixture({ verificationState: 'STALE' }))).toHaveLength(0);
    expect(candidates(thresholdFixture({ level: 'V1' }))).toHaveLength(0);
    expect(candidates(thresholdFixture({ supersededBy: 'rv2' }))).toHaveLength(0);
  });

  it('exact decimal semantics (no float): 299.999 vs 300 with a DECIMAL fixture metric', () => {
    const s = thresholdFixture();
    const dec: AchievementDerivationSnapshot = {
      ...s,
      discipline: {
        ...s.discipline,
        metrics: [{ key: 'score', valueType: 'DECIMAL', unit: 'pins' }],
      },
      performances: [
        {
          participantId: FX.bowlerParticipant,
          ordinal: 1,
          mark: { metricId: 'score', value: '299.999', unit: 'pins', precision: 3 },
          valid: true,
        },
      ],
    };
    expect(candidates(dec)).toHaveLength(0);
  });

  it('unit mismatch fails closed (no silent unit conversion)', () => {
    const s = thresholdFixture();
    const wrongUnit: AchievementDerivationSnapshot = {
      ...s,
      performances: (s.performances ?? []).map((p) => ({
        ...p,
        mark: { ...p.mark, unit: 'points' },
      })),
    };
    expect(candidates(wrongUnit)).toHaveLength(0);
  });

  it('wrong holder / performance: an athlete performance inside a team entry needs the credited lineup', () => {
    const s = thresholdFixture();
    const team: AchievementDerivationSnapshot = {
      ...s,
      participants: [{ participantId: FX.bowlerParticipant, kind: 'TEAM', teamId: FX.teamA }],
      performances: [
        {
          participantId: FX.bowlerParticipant,
          athleteId: FX.unusedRosterAthlete,
          ordinal: 1,
          mark: { metricId: 'score', value: '300', unit: 'pins', precision: 0 },
          valid: true,
        },
      ],
      creditedLineups: [{ participantId: FX.bowlerParticipant, athleteIds: [FX.athleteA1] }],
    };
    const d = derive(team);
    expect(d.outcome.candidates ?? []).toEqual([]);
    expect(d.outcome.subjects?.[0]?.reasons).toContain('PERFORMANCE_ATHLETE_NOT_CREDITED');
  });

  it('property: adding unrelated performances never alters the threshold candidates', () => {
    const baseline = candidates(thresholdFixture()).map((c) => c.candidateHash);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 400 }),
        fc.integer({ min: 4, max: 40 }),
        (v, ordinal) => {
          const s = thresholdFixture({
            extraPerformances: [
              {
                participantId: FX.bowlerParticipant,
                ordinal,
                mark: { metricId: 'lane_temperature', value: String(v), unit: 'c', precision: 0 },
                valid: true,
              },
            ],
          });
          expect(candidates(s).map((c) => c.candidateHash)).toEqual(baseline);
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe('personal best (athlete-local; DisciplineVersion comparator; reproducible set)', () => {
  it('first eligible performance establishes a PB only when the rule says so', () => {
    expect(candidates(personalBestFixture({ kind: 'BOWLING_SERIES', value: '650' }))).toHaveLength(
      1,
    );
    const d = derive(
      personalBestFixture({ kind: 'BOWLING_SERIES', value: '650', firstEstablishes: false }),
    );
    expect(d.outcome.candidates ?? []).toEqual([]);
    expect(d.outcome.subjects?.[0]?.reasons).toEqual(['PB_FIRST_DOES_NOT_ESTABLISH']);
  });

  it('higher-is-better: better → PB; equal → not (strict tie policy); worse → not', () => {
    const priors = [
      { value: '640', minute: 100 },
      { value: '610', minute: 200 },
    ];
    expect(
      candidates(personalBestFixture({ kind: 'BOWLING_SERIES', value: '641', priors })),
    ).toHaveLength(1);
    const eq = derive(personalBestFixture({ kind: 'BOWLING_SERIES', value: '640', priors }));
    expect(eq.outcome.subjects?.[0]?.reasons).toEqual(['PB_EQUALS_CURRENT_BEST']);
    const worse = derive(personalBestFixture({ kind: 'BOWLING_SERIES', value: '639', priors }));
    expect(worse.outcome.subjects?.[0]?.reasons).toEqual(['PB_NOT_IMPROVED']);
  });

  it('lower-is-better (elapsed time): a SMALLER time is the PB', () => {
    const priors = [{ value: '1200000', minute: 100 }];
    expect(
      candidates(personalBestFixture({ kind: 'RUNNING', value: '1199999', priors })),
    ).toHaveLength(1);
    expect(
      candidates(personalBestFixture({ kind: 'RUNNING', value: '1200001', priors })),
    ).toHaveLength(0);
  });

  it('only eligible comparisons count: V1, stale, other DV, or later performances are excluded', () => {
    const ineligible = [
      { value: '900', minute: 100, level: 'V1' as const },
      { value: '900', minute: 100, state: 'STALE' as const },
      { value: '900', minute: 100, dv: FX.otherDv },
      { value: '900', minute: 5000 }, // after this contest's occurrence
    ];
    const c = candidates(
      personalBestFixture({ kind: 'BOWLING_SERIES', value: '650', priors: ineligible }),
    );
    expect(c).toHaveLength(1);
  });

  it('comparisonSetHash pins exactly the eligible prior set; qualifyingValue = source mark', () => {
    const a = candidates(
      personalBestFixture({
        kind: 'BOWLING_SERIES',
        value: '700',
        priors: [{ value: '600', minute: 1 }],
      }),
    )[0];
    const b = candidates(
      personalBestFixture({
        kind: 'BOWLING_SERIES',
        value: '700',
        priors: [{ value: '650', minute: 1 }],
      }),
    )[0];
    expect(a?.candidate.comparisonSetHash).toMatch(/^sha256:/);
    expect(a?.candidate.comparisonSetHash).not.toBe(b?.candidate.comparisonSetHash);
    expect(a?.candidate.qualifyingValue?.value).toBe('700');
    expect(a?.candidate.scope.scopeType).toBe('CAREER');
  });

  it('PB is never a record: no record vocabulary anywhere in the outcome', () => {
    const text = JSON.stringify(
      derive(personalBestFixture({ kind: 'RUNNING', value: '1' })).outcome,
    );
    expect(text).not.toMatch(/RECORD|WORLD|NATIONAL|VENUE/);
  });
});

describe('determinism, integrity and properties', () => {
  it('same snapshot ⇒ identical candidates, hashes and trace', () => {
    expect(derive(padelTitleFixture())).toEqual(derive(padelTitleFixture()));
  });

  it('reordering entries, participants, lineup athletes and performances never changes the output', () => {
    const s = padelTitleFixture();
    const reordered: AchievementDerivationSnapshot = {
      ...s,
      entries: shuffle(s.entries),
      participants: shuffle(s.participants),
      creditedLineups: shuffle(s.creditedLineups ?? []).map((l) => ({
        ...l,
        athleteIds: shuffle(l.athleteIds),
      })),
      supportedFactKinds: shuffle(s.supportedFactKinds),
    };
    expect(derive(reordered)).toEqual(derive(s));
    const t = thresholdFixture();
    expect(derive({ ...t, performances: shuffle(t.performances ?? []) })).toEqual(derive(t));
  });

  it('different ResultVersion hash / VerificationRun ⇒ different basis and candidate hashes', () => {
    const a = candidates(padelTitleFixture())[0];
    const rv = candidates(padelTitleFixture({ rv: 'rv9' }))[0];
    const run = candidates(padelTitleFixture({ run: 'rv1:run2' }))[0];
    expect(new Set([a?.candidateHash, rv?.candidateHash, run?.candidateHash]).size).toBe(3);
    expect(new Set([a?.identityHash, rv?.identityHash, run?.identityHash]).size).toBe(3);
  });

  it('duplicate facts are rejected, never duplicated into Achievements', () => {
    const s = padelTitleFixture();
    const dup = { ...s, entries: [...s.entries, s.entries[0]] };
    expect(() => derive(dup as AchievementDerivationSnapshot)).toThrow(DomainError);
  });

  it('tampered rule spec (hash mismatch) is an integrity failure, not a derivation', () => {
    const s = padelTitleFixture();
    const tampered = {
      ...s,
      rule: {
        ...s.rule,
        spec: {
          ...s.rule.spec,
          requirements: { minimumVerificationLevel: 'V2', minimumResultStatus: 'FINAL' },
          displayName: 'Changed',
        },
      },
    };
    expect(() => derive(tampered as AchievementDerivationSnapshot)).toThrow(
      /ACHIEVEMENT_INTEGRITY_FAILURE/,
    );
  });

  it('candidate hash / identity are recomputable from the candidate alone', () => {
    const e = candidates(padelTitleFixture())[0];
    if (e === undefined) throw new Error('no candidate');
    expect(hashCandidate(e.candidate)).toBe(e.candidateHash);
    expect(identityOf(e.candidate).identityHash).toBe(e.identityHash);
  });

  it('property: the rule version is pinned — a new version is a different logical Achievement', () => {
    const v2 = fixtureRule(FIXTURE_RULES.padelTitle, 'padel-title', 2);
    expect(v2.specHash).toBe(fixtureRule(FIXTURE_RULES.padelTitle, 'padel-title', 1).specHash);
    const a = candidates(padelTitleFixture())[0];
    const b = candidates(padelTitleFixture({ ruleVersion: 2 }))[0];
    expect(a?.identityHash).not.toBe(b?.identityHash);
  });

  it('property: arbitrary rank pairs credit exactly the rank-1 pair (or nobody)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 4 }), (a, b) => {
        const cs = candidates(padelTitleFixture({ ranks: { a, b } }));
        const expected = [a === 1 ? FX.teamA : undefined, b === 1 ? FX.teamB : undefined]
          .filter(Boolean)
          .sort();
        expect(cs.map((c) => c.candidate.holder.holderId).sort()).toEqual(expected);
      }),
      { numRuns: 30 },
    );
  });

  it('a threshold rule with a sport-specific constant is just data (engine has no sport code)', () => {
    const spec = referenceThresholdRule(
      FX.bowlingDv,
      { key: 'score', markMetricId: 'score' },
      'GTE',
      '250',
      'High Game',
    );
    expect(
      candidates(thresholdFixture({ ruleSpec: spec, ruleLabel: 'high-game', value: '251' })),
    ).toHaveLength(1);
  });
});
