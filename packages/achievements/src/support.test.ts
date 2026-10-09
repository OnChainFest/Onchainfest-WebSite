import { describe, expect, it } from 'vitest';
import { fixtureHash, fixtureId } from './fixtures';
import { assessSupport, type SupportFacts } from './support';
import { currentSupportStatement, derivedFromStatement } from './public';

// REFERENCE ENGINE FIXTURE — NOT PERSISTED SPORTING TRUTH.
const run = fixtureId('run:1');
const current = {
  state: 'CURRENT' as const,
  runId: run,
  snapshotHash: fixtureHash('vs'),
  outcomeHash: fixtureHash('vo'),
  level: 'V2' as const,
};
const facts = (
  over: Partial<SupportFacts> = {},
  basis: Partial<SupportFacts['basis'][number]> = {},
): SupportFacts => ({
  provenance: 'REFERENCE_FIXTURE',
  achievementId: fixtureId('achievement:1'),
  requiredLevel: 'V2',
  basis: [
    {
      resultVersionId: fixtureId('rv1'),
      pinnedRunId: run,
      status: 'FINAL',
      verification: current,
      ...basis,
    },
  ],
  holdSupported: true,
  holdActive: false,
  ...over,
});

describe('current support (BRT-01 disputes §5.1) — history is never rewritten', () => {
  it('ACTIVE while the pinned basis still satisfies the rule', () => {
    expect(assessSupport(facts()).status).toBe('ACTIVE');
  });

  it('verification downgrade (e.g. key compromise → V1) → SUSPENDED, not deleted', () => {
    const a = assessSupport(
      facts({}, { verification: { ...current, runId: fixtureId('run:2'), level: 'V1' } }),
    );
    expect(a.status).toBe('SUSPENDED');
    expect(a.reasons).toEqual(['VERIFICATION_RUN_NO_LONGER_CURRENT']);
    const b = assessSupport(facts({}, { verification: { ...current, level: 'V1' } }));
    expect(b.reasons).toEqual(['VERIFICATION_LEVEL_BELOW_REQUIRED']);
    expect(
      assessSupport(facts({}, { verification: { ...current, state: 'STALE' } })).reasons,
    ).toEqual(['VERIFICATION_STALE']);
  });

  it('supersession: SUSPENDED awaiting re-derivation, SUPERSEDED when replaced, REVOKED if holder lost', () => {
    const sup = { supersededByVersionId: fixtureId('rv2'), status: 'SUPERSEDED' as const };
    expect(assessSupport(facts({}, sup)).status).toBe('SUSPENDED');
    const replaced = assessSupport(
      facts({ replacementAchievementId: fixtureId('achievement:2') }, sup),
    );
    expect(replaced.status).toBe('SUPERSEDED');
    expect(replaced.supersededBy).toBe(fixtureId('achievement:2'));
    expect(
      assessSupport(facts({ successorDerivation: 'HOLDER_DOES_NOT_QUALIFY' }, sup)).status,
    ).toBe('REVOKED');
    expect(assessSupport(facts({ successorDerivation: 'BLOCKED' }, sup)).status).toBe('SUSPENDED');
  });

  it('revoked basis → REVOKED; hold only adds a marker', () => {
    expect(assessSupport(facts({}, { status: 'REVOKED' })).status).toBe('REVOKED');
    const held = assessSupport(facts({ holdActive: true }));
    expect(held.status).toBe('ACTIVE');
    expect(held.reasons).toEqual(['UNDER_DISPUTE']);
  });

  it('the assessment commits to its inputs (hash) deterministically', () => {
    expect(assessSupport(facts()).supportFactsHash).toBe(assessSupport(facts()).supportFactsHash);
    expect(assessSupport(facts({ holdActive: true })).supportFactsHash).not.toBe(
      assessSupport(facts()).supportFactsHash,
    );
  });

  it('public wording never calls an Achievement "V2" nor a stale one "Verified"', () => {
    expect(derivedFromStatement('V2')).toBe('Derived from a V2 Event Certified result.');
    expect(currentSupportStatement('SUSPENDED')).not.toMatch(/verified/i);
    expect(currentSupportStatement('SUSPENDED')).toMatch(/Historical/);
  });
});
