import { describe, expect, it } from 'vitest';
import { blockingReasons, deriveAchievements, identityOf, type DerivationOutcome } from './engine';
import {
  FX,
  QFX,
  fixtureHash,
  fixtureId,
  qualifiedClassificationFixture,
  qualifiedClassificationRule,
  qualifiedRankingFixture,
  qualifiedRankingRule,
  qualifier,
} from './fixtures';
import { ACHIEVEMENT_ENGINE_VERSION_2, validateAchievementRuleSpec } from './rule';
import { sealDerivationSnapshot } from './snapshot';
import { assessSupport } from './support';

/**
 * BRT-10 QUALIFIED through the SAME validated Achievement engine (achievement-engine/3 adds only the
 * QUALIFYING_POSITION criterion, ADR-0050). REFERENCE ENGINE FIXTURES — NOT PERSISTED SPORTING TRUTH:
 * FINAL, V3, hold and above all the target authority's adoption have no canonical producer.
 */
const holders = (o: DerivationOutcome) =>
  (o.candidates ?? []).map((c) => c.candidate.holder.holderId).sort();
const athletes = (...ks: number[]) => ks.map((k) => qualifier(k).athleteId).sort();
const subjectReasons = (o: DerivationOutcome, key: string) =>
  (o.subjects ?? []).find((x) => x.subjectKey === key)?.reasons ?? [];

describe('QUALIFIED rule (achievement-engine/3)', () => {
  it('a valid ranking / classification rule; QUALIFIED only on engine/3, floor FINAL · V3', () => {
    expect(validateAchievementRuleSpec(qualifiedRankingRule()).ok).toBe(true);
    expect(validateAchievementRuleSpec(qualifiedClassificationRule()).ok).toBe(true);
    const codes = (spec: unknown) => {
      const v = validateAchievementRuleSpec(spec);
      return v.ok ? [] : v.issues.map((i) => i.code);
    };
    const r = qualifiedRankingRule();
    expect(codes({ ...r, targetEngine: ACHIEVEMENT_ENGINE_VERSION_2 })).toContain(
      'QUALIFIED_REQUIRES_ACHIEVEMENT_ENGINE_3',
    );
    // The threshold / floor can never be silently lowered.
    expect(
      codes({
        ...r,
        requirements: { minimumVerificationLevel: 'V2', minimumResultStatus: 'FINAL' },
      }),
    ).toContain('BELOW_PLATFORM_FLOOR');
    expect(
      codes({
        ...r,
        requirements: { minimumVerificationLevel: 'V3', minimumResultStatus: 'OFFICIAL' },
      }),
    ).toContain('BELOW_PLATFORM_FLOOR');
    // Raise-only: V4 is admissible.
    expect(
      codes({
        ...r,
        requirements: { minimumVerificationLevel: 'V4', minimumResultStatus: 'FINAL' },
      }),
    ).toEqual([]);
  });

  it('invalid N, partially pinned or mixed sources and a wrong result scope are refused', () => {
    const r = qualifiedRankingRule();
    const q = r.criterion.qualification!;
    const codes = (spec: unknown) => {
      const v = validateAchievementRuleSpec(spec);
      return v.ok ? [] : v.issues.map((i) => i.code);
    };
    const withQ = (qualification: unknown, resultScope = 'CONTEST') => ({
      ...r,
      criterion: { kind: 'QUALIFYING_POSITION', resultScope, qualification },
    });
    expect(codes(withQ({ ...q, qualifyingRanks: 0 }))).not.toEqual([]);
    expect(codes(withQ({ ...q, qualifyingRanks: 1.5 }))).not.toEqual([]);
    expect(codes(withQ({ ...q, qualifyingRanks: '3' }))).not.toEqual([]);
    expect(
      codes(
        withQ({ ...q, source: { kind: 'RANKING_SNAPSHOT_POSITION', rankingSystemId: QFX.system } }),
      ),
    ).toContain('PARAM_REQUIRED');
    expect(codes(withQ({ ...q, source: { ...q.source, scopeId: FX.event } }))).toContain(
      'PARAM_NOT_ALLOWED',
    );
    expect(codes(withQ(q, 'EVENT_CLASSIFICATION'))).toContain('RESULT_SCOPE_NOT_ALLOWED_FOR_TYPE');
    const c = qualifiedClassificationRule();
    expect(codes({ ...c, criterion: { ...c.criterion, resultScope: 'CONTEST' } })).toContain(
      'RESULT_SCOPE_NOT_ALLOWED_FOR_TYPE',
    );
    // QUALIFIED without its declaration, and a declaration on another type, are refused.
    expect(
      codes({ ...r, criterion: { kind: 'QUALIFYING_POSITION', resultScope: 'CONTEST' } }),
    ).toContain('PARAM_REQUIRED');
  });

  it('a QUALIFIED rule needs a qualification snapshot and vice versa (no shape mixing)', () => {
    const s = qualifiedRankingFixture();
    expect(() =>
      deriveAchievements({ ...s, hierarchy: { competitionId: FX.competition } }),
    ).toThrow(/mixes or lacks/);
  });
});

describe('QUALIFIED via a published ranking snapshot', () => {
  it('rank 1, rank exactly N and shared rank N qualify; rank N+1 does not', () => {
    const d = deriveAchievements(qualifiedRankingFixture());
    expect(d.outcome.state).toBe('ISSUABLE');
    expect(holders(d.outcome)).toEqual(athletes(1, 2, 3, 4));
    expect(subjectReasons(d.outcome, qualifier(5).athleteId)).toEqual([
      'POSITION_OUTSIDE_QUALIFYING_RANKS',
    ]);
    const shared = (d.outcome.candidates ?? []).filter(
      (c) => c.candidate.qualification?.ranking?.tied,
    );
    expect(shared.map((c) => c.candidate.qualification?.ranking?.rank)).toEqual([3, 3]);
  });

  it('N = 1 qualifies only rank 1; N + 1 is excluded with an explicit reason', () => {
    const d = deriveAchievements(qualifiedRankingFixture({ n: 1 }));
    expect(holders(d.outcome)).toEqual(athletes(1));
    expect(subjectReasons(d.outcome, qualifier(2).athleteId)).toContain(
      'POSITION_OUTSIDE_QUALIFYING_RANKS',
    );
  });

  it('the candidate pins target, snapshot id + hash, rank, tie, basis hash and adoption', () => {
    const d = deriveAchievements(qualifiedRankingFixture());
    const c = (d.outcome.candidates ?? []).find(
      (x) => x.candidate.holder.holderId === qualifier(1).athleteId,
    )!.candidate;
    expect(c.achievementType).toBe('QUALIFIED');
    expect(c.engineVersion).toBe('achievement-engine/3');
    expect(c.scope).toEqual({ scopeType: 'COMPETITION', scopeId: QFX.target });
    expect(c.context.competitionId).toBe(QFX.target);
    expect(c.memberCreditBasis).toBe('NOT_APPLICABLE');
    expect(c.basisLevel).toBe('V3');
    expect(c.qualifyingValue).toBeUndefined();
    expect(c.qualification).toMatchObject({
      kind: 'RANKING_SNAPSHOT_POSITION',
      targetCompetitionId: QFX.target,
      qualifyingRanks: 3,
      ranking: {
        systemId: QFX.system,
        systemVersionId: QFX.systemVersion,
        snapshotId: QFX.snapshot,
        snapshotHash: fixtureHash('qualified:ranking-snapshot-1'),
        rank: 1,
        tied: false,
      },
      targetAuthority: { adoptionId: QFX.adoption },
    });
    expect(c.basis.map((b) => b.resultStatus)).toEqual(['FINAL']);
    expect(d.outcome.source).toEqual({
      kind: 'RANKING_SNAPSHOT_POSITION',
      sourceId: QFX.snapshot,
      sourceHash: fixtureHash('qualified:ranking-snapshot-1'),
    });
    expect(d.outcome.resultVersionId).toBeUndefined();
  });

  it('every equal best mark is pinned (multi-basis entries), one basis item per version', () => {
    const d = deriveAchievements(
      qualifiedRankingFixture({ entries: [{ k: 1, rank: 1, levels: ['V3', 'V4'] }] }),
    );
    const [c] = d.outcome.candidates ?? [];
    expect(c?.candidate.basis).toHaveLength(2);
    expect(c?.candidate.basisLevel).toBe('V3');
  });

  it('an unpublished run, another system version, a corrected or a stale snapshot never qualify', () => {
    const blocked = (o: Parameters<typeof qualifiedRankingFixture>[0]) => {
      const d = deriveAchievements(qualifiedRankingFixture(o));
      expect(d.outcome.state).toBe('BLOCKED');
      expect(d.outcome.candidates ?? []).toHaveLength(0);
      return blockingReasons(d.outcome);
    };
    expect(blocked({ published: false })).toEqual(['RANKING_SNAPSHOT_NOT_PUBLISHED']);
    expect(blocked({ systemVersionId: QFX.otherSystemVersion })).toEqual([
      'QUALIFYING_SOURCE_MISMATCH',
    ]);
    expect(blocked({ correctedBy: QFX.correctingSnapshot })).toEqual([
      'RANKING_SNAPSHOT_CORRECTED',
    ]);
    expect(blocked({ stale: ['BASIS_VERIFICATION_NOT_CURRENT'] })).toEqual([
      'BASIS_VERIFICATION_NOT_CURRENT',
      'RANKING_SNAPSHOT_STALE',
    ]);
  });

  it('a snapshot-hash change is a different source (different candidate and identity)', () => {
    const a = deriveAchievements(qualifiedRankingFixture());
    const b = deriveAchievements(
      qualifiedRankingFixture({ published: { snapshotHash: fixtureHash('other-snapshot') } }),
    );
    expect(a.outcome.candidates?.[0]?.candidateHash).not.toBe(
      b.outcome.candidates?.[0]?.candidateHash,
    );
  });

  it('a classification snapshot under a ranking rule is a source mismatch', () => {
    const s = qualifiedClassificationFixture({ ruleSpec: qualifiedRankingRule(), ruleLabel: 'x' });
    expect(blockingReasons(deriveAchievements(s).outcome)).toContain('QUALIFYING_SOURCE_MISMATCH');
  });
});

describe('QUALIFIED via a FINAL classification', () => {
  it('rank exactly N (shared) qualifies, N+1 does not; the classification itself is the basis', () => {
    const d = deriveAchievements(qualifiedClassificationFixture());
    expect(d.outcome.state).toBe('ISSUABLE');
    expect(holders(d.outcome)).toEqual(athletes(1, 2, 3, 4));
    expect(subjectReasons(d.outcome, qualifier(5).participantId)).toEqual([
      'POSITION_OUTSIDE_QUALIFYING_RANKS',
    ]);
    const c = d.outcome.candidates![0]!.candidate;
    expect(c.basis).toHaveLength(1);
    expect(c.basis[0]?.resultVersionId).toBe(fixtureId('qualified:classification-c1'));
    expect(c.qualification?.classification?.policyVersionId).toBe(QFX.policyVersion);
    expect(d.outcome.resultVersionId).toBe(fixtureId('qualified:classification-c1'));
  });

  it('a missing rank fails closed for that holder', () => {
    const d = deriveAchievements(
      qualifiedClassificationFixture({ entries: [{ k: 1, rank: 1 }, { k: 2 }] }),
    );
    expect(holders(d.outcome)).toEqual(athletes(1));
    expect(subjectReasons(d.outcome, qualifier(2).participantId)).toEqual(['RANK_MISSING']);
  });

  it('non-FINAL, superseded and revoked classifications never qualify', () => {
    for (const [status, reason] of [
      ['PROVISIONAL', 'RESULT_STATUS_BELOW_REQUIRED'],
      ['OFFICIAL', 'RESULT_STATUS_BELOW_REQUIRED'],
      ['REVOKED', 'RESULT_REVOKED'],
    ] as const) {
      const d = deriveAchievements(qualifiedClassificationFixture({ status }));
      expect(d.outcome.state).toBe('BLOCKED');
      expect(blockingReasons(d.outcome)).toEqual([reason]);
    }
    expect(
      blockingReasons(
        deriveAchievements(qualifiedClassificationFixture({ supersededBy: 'c2' })).outcome,
      ),
    ).toEqual(['RESULT_SUPERSEDED']);
  });

  it('a missing classification (no provenance), wrong policy, wrong DV or wrong scope block', () => {
    const s = qualifiedClassificationFixture();
    const { classification: _c, ...rest } = s.qualification;
    expect(blockingReasons(deriveAchievements({ ...s, qualification: rest }).outcome)).toEqual([
      'CLASSIFICATION_PROVENANCE_UNAVAILABLE',
    ]);
    expect(
      blockingReasons(
        deriveAchievements(
          qualifiedClassificationFixture({ policyVersionId: QFX.otherPolicyVersion }),
        ).outcome,
      ),
    ).toEqual(['QUALIFYING_SOURCE_MISMATCH']);
    expect(
      blockingReasons(
        deriveAchievements(qualifiedClassificationFixture({ classificationDv: FX.otherDv }))
          .outcome,
      ),
    ).toEqual(['RULE_DISCIPLINE_VERSION_MISMATCH']);
    expect(
      blockingReasons(
        deriveAchievements(
          qualifiedClassificationFixture({ scopeType: 'COMPETITION_CLASSIFICATION' }),
        ).outcome,
      ),
    ).toEqual(['QUALIFYING_SOURCE_MISMATCH', 'RESULT_SCOPE_MISMATCH']);
  });

  it('a STALE classification never qualifies (Step 7 reasons are kept explicit)', () => {
    expect(
      blockingReasons(
        deriveAchievements(qualifiedClassificationFixture({ stale: ['PINNED_INPUT_NOT_CURRENT'] }))
          .outcome,
      ),
    ).toEqual(['PINNED_INPUT_NOT_CURRENT']);
  });

  it('a malformed basis (non-integer / zero rank) is an integrity failure, never a guess', () => {
    const s = qualifiedClassificationFixture();
    const bad = (rank: unknown) => ({
      ...s,
      qualification: {
        ...s.qualification,
        classification: {
          ...s.qualification.classification!,
          entries: [{ participantId: qualifier(1).participantId, rank, tied: false }],
        },
      },
    });
    expect(() => deriveAchievements(bad(0))).toThrow();
    expect(() => deriveAchievements(bad(1.5))).toThrow();
    expect(() => deriveAchievements(bad('1'))).toThrow();
  });
});

describe('QUALIFIED verification floor (V3, raise-only)', () => {
  it('ranking: V0 / V1 / V2 bases never qualify; V3 and V4 do', () => {
    for (const level of ['V0', 'V1', 'V2'] as const) {
      const d = deriveAchievements(
        qualifiedRankingFixture({ entries: [{ k: 1, rank: 1, levels: [level] }] }),
      );
      expect(d.outcome.candidates ?? []).toHaveLength(0);
      expect(subjectReasons(d.outcome, qualifier(1).athleteId)).toEqual([
        'VERIFICATION_LEVEL_BELOW_REQUIRED',
      ]);
    }
    for (const level of ['V3', 'V4'] as const)
      expect(
        holders(
          deriveAchievements(
            qualifiedRankingFixture({ entries: [{ k: 1, rank: 1, levels: [level] }] }),
          ).outcome,
        ),
      ).toEqual(athletes(1));
    // A holder with one V2 equal mark among V3 marks does not qualify (no silent filtering).
    const mixed = deriveAchievements(
      qualifiedRankingFixture({ entries: [{ k: 1, rank: 1, levels: ['V3', 'V2'] }] }),
    );
    expect(mixed.outcome.candidates ?? []).toHaveLength(0);
  });

  it('classification: V0 / V1 / V2 block; V3 and V4 pass; a raised V4 floor blocks V3', () => {
    for (const level of ['V0', 'V1', 'V2'] as const)
      expect(
        blockingReasons(deriveAchievements(qualifiedClassificationFixture({ level })).outcome),
      ).toEqual(['VERIFICATION_LEVEL_BELOW_REQUIRED']);
    for (const level of ['V3', 'V4'] as const)
      expect(deriveAchievements(qualifiedClassificationFixture({ level })).outcome.state).toBe(
        'ISSUABLE',
      );
    const v4 = qualifiedClassificationRule();
    expect(
      blockingReasons(
        deriveAchievements(
          qualifiedClassificationFixture({
            ruleSpec: {
              ...v4,
              requirements: { minimumVerificationLevel: 'V4', minimumResultStatus: 'FINAL' },
            },
            ruleLabel: 'v4',
          }),
        ).outcome,
      ),
    ).toEqual(['VERIFICATION_LEVEL_BELOW_REQUIRED']);
    expect(
      blockingReasons(
        deriveAchievements(qualifiedClassificationFixture({ verificationState: 'STALE' })).outcome,
      ),
    ).toEqual(['VERIFICATION_STALE']);
  });
});

describe('QUALIFIED hold and target authority', () => {
  it('an admitted hold blocks; unknown hold state is never "no hold"', () => {
    expect(
      blockingReasons(deriveAchievements(qualifiedRankingFixture({ hold: true })).outcome),
    ).toEqual(['HOLD_ACTIVE']);
    expect(
      blockingReasons(
        deriveAchievements(qualifiedRankingFixture({ unsupported: ['HOLD_STATE'] })).outcome,
      ),
    ).toEqual(['HOLD_STATE_UNAVAILABLE']);
  });

  it('missing, invalid, out-of-scope or unproduced target authority blocks', () => {
    const reasons = (o: Parameters<typeof qualifiedRankingFixture>[0]) =>
      blockingReasons(deriveAchievements(qualifiedRankingFixture(o)).outcome);
    expect(reasons({ targetAuthority: null })).toEqual([
      'TARGET_QUALIFICATION_AUTHORITY_UNAVAILABLE',
    ]);
    expect(reasons({ unsupported: ['TARGET_QUALIFICATION_AUTHORITY'] })).toEqual([
      'TARGET_QUALIFICATION_AUTHORITY_UNAVAILABLE',
    ]);
    expect(reasons({ targetAuthority: { status: 'WITHDRAWN' } })).toEqual([
      'TARGET_QUALIFICATION_AUTHORITY_INVALID',
    ]);
    expect(
      reasons({ targetAuthority: { ruleVersionId: fixtureId('other-rule-version') } }),
    ).toEqual(['TARGET_QUALIFICATION_AUTHORITY_INVALID']);
    expect(reasons({ targetAuthority: { targetCompetitionId: QFX.otherTarget } })).toEqual([
      'TARGET_QUALIFICATION_AUTHORITY_OUT_OF_SCOPE',
    ]);
  });

  it('a CANONICAL_ASSEMBLY snapshot can never declare the unproduced authority kind', () => {
    const s = qualifiedRankingFixture();
    const d = deriveAchievements({ ...s, provenance: 'CANONICAL_ASSEMBLY' });
    expect(d.outcome.state).toBe('BLOCKED');
    expect(blockingReasons(d.outcome)).toEqual(
      expect.arrayContaining([
        'TARGET_QUALIFICATION_AUTHORITY_UNAVAILABLE',
        'HOLD_STATE_UNAVAILABLE',
      ]),
    );
  });
});

describe('QUALIFIED determinism and immutability', () => {
  it('identical input ⇒ identical decision, content, hashes and identity (order-independent)', () => {
    const a = deriveAchievements(qualifiedRankingFixture());
    const s = qualifiedRankingFixture();
    const reversed = {
      ...s,
      qualification: {
        ...s.qualification,
        ranking: {
          ...s.qualification.ranking!,
          entries: [...s.qualification.ranking!.entries].reverse(),
        },
      },
    };
    const b = deriveAchievements(reversed);
    expect(b.snapshotHash).toBe(a.snapshotHash);
    expect(b.outcomeHash).toBe(a.outcomeHash);
    expect(b.outcome.candidates?.map((c) => c.identityHash)).toEqual(
      a.outcome.candidates?.map((c) => c.identityHash),
    );
  });

  it('a later snapshot or classification yields NEW candidates; the earlier pins are unchanged', () => {
    const first = deriveAchievements(qualifiedRankingFixture());
    const later = deriveAchievements(
      qualifiedRankingFixture({
        published: {
          snapshotId: QFX.correctingSnapshot,
          snapshotHash: fixtureHash('qualified:ranking-snapshot-2'),
          lineageKind: 'FOLLOWS',
          priorSnapshotId: QFX.snapshot,
          priorSnapshotHash: fixtureHash('qualified:ranking-snapshot-1'),
        },
      }),
    );
    const pin = (d: typeof first) => d.outcome.candidates?.[0]?.candidate.qualification?.ranking;
    expect(pin(first)?.snapshotId).toBe(QFX.snapshot);
    expect(pin(later)?.snapshotId).toBe(QFX.correctingSnapshot);
    const c1 = deriveAchievements(qualifiedClassificationFixture({ version: 'c1' }));
    const c2 = deriveAchievements(
      qualifiedClassificationFixture({ version: 'c2', supersedes: 'c1' }),
    );
    expect(c1.outcome.candidates?.[0]?.identityHash).not.toBe(
      c2.outcome.candidates?.[0]?.identityHash,
    );
    expect(
      c1.outcome.candidates?.[0]?.candidate.qualification?.classification?.resultVersionId,
    ).toBe(fixtureId('qualified:classification-c1'));
  });

  it('identity names the qualifying source: same basis under another snapshot is another fact', () => {
    const a = deriveAchievements(qualifiedRankingFixture());
    const b = deriveAchievements(
      qualifiedRankingFixture({
        published: {
          snapshotId: QFX.correctingSnapshot,
          snapshotHash: fixtureHash('qualified:ranking-snapshot-2'),
          lineageKind: 'CORRECTS',
          priorSnapshotId: QFX.snapshot,
          priorSnapshotHash: fixtureHash('qualified:ranking-snapshot-1'),
        },
      }),
    );
    const of1 = (d: typeof a) =>
      (d.outcome.candidates ?? []).find(
        (c) => c.candidate.holder.holderId === qualifier(1).athleteId,
      );
    expect(of1(a)?.candidate.basis).toEqual(of1(b)?.candidate.basis);
    expect(of1(a)?.identityHash).not.toBe(of1(b)?.identityHash);
  });

  it('a new rule (policy) version never rewrites an old basis: it is another identity', () => {
    const v1 = deriveAchievements(qualifiedRankingFixture());
    const v2 = deriveAchievements(qualifiedRankingFixture({ ruleVersion: 2 }));
    const id = (d: typeof v1) => identityOf(d.outcome.candidates![0]!.candidate).identityHash;
    expect(id(v1)).not.toBe(id(v2));
    expect(v1.outcome.candidates?.[0]?.candidate.rule.version).toBe(1);
  });

  it('the snapshot is sealed with the new optional members only — existing shapes unaffected', () => {
    expect(sealDerivationSnapshot(qualifiedRankingFixture()).snapshotHash).toMatch(/^sha256:/);
  });
});

describe('QUALIFIED correction / revocation (disputes §5.1, ADR-0050 §7)', () => {
  const base = {
    provenance: 'REFERENCE_FIXTURE' as const,
    achievementId: fixtureId('qualified-achievement'),
    requiredLevel: 'V3' as const,
    basis: [
      {
        resultVersionId: fixtureId('qualified:rv-1-1'),
        pinnedRunId: fixtureId('run:qualified:rv-1-1'),
        status: 'FINAL' as const,
        verification: {
          state: 'CURRENT' as const,
          runId: fixtureId('run:qualified:rv-1-1'),
          level: 'V3' as const,
        },
      },
    ],
    holdSupported: true,
    holdActive: false,
  };

  it('pinned snapshot corrected: still qualifies ⇒ SUPERSEDED by the new Achievement', () => {
    const a = assessSupport({
      ...base,
      qualifyingSnapshotCorrected: true,
      replacementAchievementId: fixtureId('new-qualified'),
    });
    expect(a.status).toBe('SUPERSEDED');
  });

  it('pinned snapshot corrected: holder no longer qualifies ⇒ REVOKED (history kept)', () => {
    const a = assessSupport({
      ...base,
      qualifyingSnapshotCorrected: true,
      successorDerivation: 'HOLDER_DOES_NOT_QUALIFY',
    });
    expect(a.status).toBe('REVOKED');
    expect(a.reasons).toEqual(['HOLDER_NO_LONGER_QUALIFIES', 'RANKING_SNAPSHOT_CORRECTED']);
  });

  it('pinned snapshot corrected, not (yet) re-derived ⇒ SUSPENDED, never revoked', () => {
    const a = assessSupport({
      ...base,
      qualifyingSnapshotCorrected: true,
      successorDerivation: 'BLOCKED',
    });
    expect(a.status).toBe('SUSPENDED');
    expect(a.reasons).toEqual(['AWAITING_REDERIVATION', 'RANKING_SNAPSHOT_CORRECTED']);
  });

  it('support below V3 (run no longer current / lower level) ⇒ SUSPENDED; revoked basis ⇒ REVOKED', () => {
    expect(
      assessSupport({
        ...base,
        basis: [
          {
            ...base.basis[0]!,
            verification: { state: 'CURRENT', runId: fixtureId('x'), level: 'V3' },
          },
        ],
      }).status,
    ).toBe('SUSPENDED');
    expect(
      assessSupport({
        ...base,
        basis: [
          { ...base.basis[0]!, verification: { ...base.basis[0]!.verification, level: 'V2' } },
        ],
      }).reasons,
    ).toEqual(['VERIFICATION_LEVEL_BELOW_REQUIRED']);
    expect(
      assessSupport({ ...base, basis: [{ ...base.basis[0]!, status: 'REVOKED' }] }).status,
    ).toBe('REVOKED');
    expect(assessSupport(base).status).toBe('ACTIVE');
  });

  it('a superseded classification basis follows the same rule (no correction producer: fixture only)', () => {
    expect(
      assessSupport({
        ...base,
        basis: [
          { ...base.basis[0]!, supersededByVersionId: fixtureId('qualified:classification-c2') },
        ],
        successorDerivation: 'HOLDER_DOES_NOT_QUALIFY',
      }).reasons,
    ).toEqual(['BASIS_RESULT_SUPERSEDED', 'HOLDER_NO_LONGER_QUALIFIES']);
  });
});
