import { describe, expect, it } from 'vitest';
import { blockingReasons, deriveAchievements, identityOf } from './engine';
import { FIXTURE_RULES, FX, fixtureId, recordSetFixture } from './fixtures';
import { referenceRecordSetRule, validateAchievementRuleSpec } from './rule';
import { assessSupport } from './support';

/**
 * BRT-09 RECORD_SET through the SAME validated Achievement engine (achievement-engine/2 adds only the
 * RECORD_MARK_RATIFIED criterion). REFERENCE ENGINE FIXTURES — NOT PERSISTED SPORTING TRUTH.
 */
describe('RECORD_SET derivation (ADR-0045)', () => {
  it('a validly RATIFIED mark yields ONE RECORD_SET pinning the mark, category version and ratification', () => {
    const d = deriveAchievements(recordSetFixture({ level: 'V3' }));
    expect(d.outcome.state).toBe('ISSUABLE');
    const [c] = d.outcome.candidates ?? [];
    expect(d.outcome.candidates).toHaveLength(1);
    expect(c?.candidate.achievementType).toBe('RECORD_SET');
    expect(c?.candidate.engineVersion).toBe('achievement-engine/2');
    expect(c?.candidate.scope).toEqual({
      scopeType: 'RECORD_CATEGORY',
      scopeId: fixtureId('record-category:running-platform'),
    });
    expect(c?.candidate.qualifyingValue?.value).toBe('598000');
    expect(c?.candidate.record?.standing).toBe('RATIFIED');
    expect(c?.candidate.record?.ratificationHash).toMatch(/^sha256:/);
    expect(c?.candidate.holder).toEqual({ holderType: 'ATHLETE', holderId: FX.runner });
  });

  it('a PENDING mark never produces a RECORD_SET (no Achievement claims a pending record)', () => {
    const d = deriveAchievements(
      recordSetFixture({ level: 'V3', record: { currentStatus: 'PENDING_RATIFICATION' } }),
    );
    expect(d.outcome.state).toBe('BLOCKED');
    expect(blockingReasons(d.outcome)).toContain('RECORD_MARK_NOT_RATIFIED');
    expect(d.outcome.candidates ?? []).toHaveLength(0);
  });

  it('a RESCINDED mark, a missing mark or the unproduced kind block issuance', () => {
    expect(
      blockingReasons(
        deriveAchievements(
          recordSetFixture({ level: 'V3', record: { currentStatus: 'RESCINDED' } }),
        ).outcome,
      ),
    ).toContain('RECORD_MARK_RESCINDED');
    expect(
      blockingReasons(deriveAchievements(recordSetFixture({ level: 'V3', record: null })).outcome),
    ).toContain('RECORD_MARK_UNAVAILABLE');
    expect(
      blockingReasons(
        deriveAchievements(recordSetFixture({ level: 'V3', unsupported: ['RECORD_RATIFICATION'] }))
          .outcome,
      ),
    ).toContain('RECORD_RATIFICATION_UNAVAILABLE');
  });

  it('the rule floor (V2) is raised to the pinned category floor (V3 / V4)', () => {
    expect(
      blockingReasons(deriveAchievements(recordSetFixture({ level: 'V2' })).outcome),
    ).toContain('VERIFICATION_LEVEL_BELOW_REQUIRED');
    expect(
      blockingReasons(
        deriveAchievements(recordSetFixture({ level: 'V3', record: { requiredLevel: 'V4' } }))
          .outcome,
      ),
    ).toContain('VERIFICATION_LEVEL_BELOW_REQUIRED');
    expect(
      deriveAchievements(recordSetFixture({ level: 'V4', record: { requiredLevel: 'V4' } })).outcome
        .state,
    ).toBe('ISSUABLE');
  });

  it('value or holder substitution never qualifies', () => {
    const wrongValue = deriveAchievements(
      recordSetFixture({
        level: 'V3',
        record: {
          value: { metricId: 'elapsed_time_ms', value: '500000', unit: 'ms', precision: 0 },
        },
      }),
    );
    expect(wrongValue.outcome.state).toBe('NO_QUALIFYING_FACTS');
    expect(JSON.stringify(wrongValue.outcome.subjects)).toContain('RECORD_VALUE_MISMATCH');
    const wrongHolder = deriveAchievements(
      recordSetFixture({
        level: 'V3',
        record: { holder: { holderType: 'ATHLETE', holderId: FX.bowler } },
      }),
    );
    expect(JSON.stringify(wrongHolder.outcome.subjects)).toContain('RECORD_HOLDER_MISMATCH');
  });

  it('identity is stable per mark (idempotent replays) and differs per mark', () => {
    const a = deriveAchievements(recordSetFixture({ level: 'V3' })).outcome.candidates?.[0];
    const b = deriveAchievements(recordSetFixture({ level: 'V3' })).outcome.candidates?.[0];
    const other = deriveAchievements(
      recordSetFixture({ level: 'V3', record: { categoryId: fixtureId('other-category') } }),
    ).outcome.candidates?.[0];
    expect(a && b && identityOf(a.candidate).identityHash).toBe(
      b && identityOf(b.candidate).identityHash,
    );
    expect(a?.identityHash).not.toBe(other?.identityHash);
  });

  it('RECORD_SET requires achievement-engine/2; /1 keeps its semantics', () => {
    const onV1 = validateAchievementRuleSpec({
      ...referenceRecordSetRule(FX.runningDv),
      targetEngine: 'achievement-engine/1',
    });
    expect(onV1.ok).toBe(false);
    expect(validateAchievementRuleSpec(FIXTURE_RULES.runningRecordSet).ok).toBe(true);
    // "National record set" still claims a recognition level the rule cannot give.
    const national = validateAchievementRuleSpec({
      ...referenceRecordSetRule(FX.runningDv),
      displayName: 'National record set',
    });
    expect(national.ok).toBe(false);
  });

  it('a rescinded mark revokes the RECORD_SET; a superseded record still WAS set', () => {
    const base = {
      provenance: 'REFERENCE_FIXTURE' as const,
      achievementId: fixtureId('rs-achievement'),
      requiredLevel: 'V3' as const,
      basis: [
        {
          resultVersionId: fixtureId('rv'),
          pinnedRunId: fixtureId('run'),
          status: 'FINAL' as const,
          verification: {
            state: 'CURRENT' as const,
            runId: fixtureId('run'),
            level: 'V3' as const,
          },
        },
      ],
    };
    expect(assessSupport({ ...base, recordMarkStatus: 'RESCINDED' }).status).toBe('REVOKED');
    expect(assessSupport({ ...base, recordMarkStatus: 'SUPERSEDED' }).status).toBe('ACTIVE');
  });
});
