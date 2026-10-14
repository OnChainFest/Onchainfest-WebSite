import type { Uuid } from '@br/domain';
import { describe, expect, it } from 'vitest';
import {
  COMPETITION_PARTICIPATION_CHECKER_ID,
  competitionParticipationChecker,
  platformGrantorChecker,
} from './competition-participation';

// ADR-0077 §2.5: the per-action conflict checker answers for one principal and one competition
// only; everything else is UNAVAILABLE (fail closed).
const P = '0192b7a0-0000-7000-8000-000000000001' as Uuid;
const OTHER = '0192b7a0-0000-7000-8000-000000000002' as Uuid;
const C = '0192b7a0-0000-7000-8000-0000000000c1';
const C2 = '0192b7a0-0000-7000-8000-0000000000c2';
const at = new Date('2026-10-14T00:00:00.000Z');
const contestScope = {
  recognitionLevel: ['PLATFORM' as const],
  competition: [C as Uuid],
  event: ['0192b7a0-0000-7000-8000-0000000000e1' as Uuid],
  contest: ['0192b7a0-0000-7000-8000-0000000000a1' as Uuid],
};

describe('competition-participation/1 checker', () => {
  it('is CLEAR for a non-participating actor and CONFLICTED for a participant', () => {
    const clear = competitionParticipationChecker({
      principalId: P,
      competitionId: C,
      participates: false,
    });
    const conflicted = competitionParticipationChecker({
      principalId: P,
      competitionId: C,
      participates: true,
    });
    expect(clear.id).toBe(COMPETITION_PARTICIPATION_CHECKER_ID);
    expect(clear.check(P, contestScope, at)).toBe('CLEAR');
    expect(conflicted.check(P, contestScope, at)).toBe('CONFLICTED');
  });

  it('never answers for another principal or another competition', () => {
    const c = competitionParticipationChecker({
      principalId: P,
      competitionId: C,
      participates: false,
    });
    expect(c.check(OTHER, contestScope, at)).toBe('UNAVAILABLE');
    expect(c.check(P, { ...contestScope, competition: [C2 as Uuid] }, at)).toBe('UNAVAILABLE');
    expect(c.check(P, { recognitionLevel: ['PLATFORM'] }, at)).toBe('UNAVAILABLE');
    expect(c.check(P, { competition: [C as Uuid, C2 as Uuid] }, at)).toBe('UNAVAILABLE');
  });

  it('the platform grantor checker clears only the platform principal', () => {
    const c = platformGrantorChecker(P);
    expect(c.check(P, contestScope, at)).toBe('CLEAR');
    expect(c.check(OTHER, contestScope, at)).toBe('UNAVAILABLE');
  });
});
