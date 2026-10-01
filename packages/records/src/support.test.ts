import { describe, expect, it } from 'vitest';
import { assessRecordSupport, type RecordSupportFacts } from './support';
import { rfxId } from './fixtures';

const base: RecordSupportFacts = {
  provenance: 'REFERENCE_FIXTURE',
  recordMarkId: rfxId('mark'),
  requiredLevel: 'V3',
  basisStatus: 'FINAL',
  verification: { state: 'CURRENT', runId: rfxId('run'), level: 'V3' },
};

describe('record current support (temporary suspension ≠ rescission)', () => {
  it('CURRENT verification at the floor ⇒ SUPPORTED', () => {
    expect(assessRecordSupport(base).support).toBe('SUPPORTED');
  });

  it('stale / below-floor verification ⇒ SUSPENDED, never RESCIND', () => {
    const stale = assessRecordSupport({ ...base, verification: { state: 'STALE' } });
    expect(stale).toMatchObject({ support: 'SUSPENDED', action: 'NONE' });
    const low = assessRecordSupport({
      ...base,
      verification: { ...base.verification, level: 'V2' } as never,
    });
    expect(low).toMatchObject({ support: 'SUSPENDED', action: 'NONE' });
  });

  it('revoked basis ⇒ RESCIND; corrected basis ⇒ RESCIND only when it no longer qualifies', () => {
    expect(assessRecordSupport({ ...base, basisStatus: 'REVOKED' }).action).toBe('RESCIND');
    const sup = {
      ...base,
      basisStatus: 'SUPERSEDED' as const,
      supersededByVersionId: rfxId('rv2'),
    };
    expect(assessRecordSupport({ ...sup, successor: 'NO_LONGER_QUALIFIES' }).action).toBe(
      'RESCIND',
    );
    expect(assessRecordSupport({ ...sup, successor: 'QUALIFIES' }).action).toBe(
      'AWAIT_REPLACEMENT',
    );
    expect(assessRecordSupport(sup)).toMatchObject({ support: 'SUSPENDED', action: 'NONE' });
  });

  it('V4 records need a current V4 that counted THIS category', () => {
    const v4 = { ...base, requiredLevel: 'V4' as const, v4CategoryId: rfxId('cat') };
    expect(
      assessRecordSupport({
        ...v4,
        verification: { state: 'CURRENT', level: 'V4', ratifiedRecordCategoryIds: [rfxId('cat')] },
      }).support,
    ).toBe('SUPPORTED');
    expect(
      assessRecordSupport({
        ...v4,
        verification: { state: 'CURRENT', level: 'V4', ratifiedRecordCategoryIds: [rfxId('x')] },
      }).reasons,
    ).toContain('V4_NOT_ESTABLISHED_FOR_CATEGORY');
  });

  it('an admitted hold marks, but does not remove, an existing record', () => {
    const r = assessRecordSupport({ ...base, holdSupported: true, holdActive: true });
    expect(r.support).toBe('SUPPORTED');
    expect(r.reasons).toContain('UNDER_DISPUTE');
  });
});
