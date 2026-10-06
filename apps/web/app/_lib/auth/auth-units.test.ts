import { describe, expect, it } from 'vitest';
import {
  countryInput,
  idempotencyKey,
  isOrganizationType,
  normalizeSlugInput,
  slugFromName,
  SLUG_RE,
} from '../onboarding-input';
import { authErrorCode, errorMessage, noticeMessage } from './messages';
import { RateLimiter } from './rate-limit';
import { isRecoverySession } from './recovery';

describe('rate limiter', () => {
  it('allows `limit` attempts per window, then blocks until the window resets', () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    const rule = { limit: 3, windowMs: 1000 };
    expect([1, 2, 3, 4].map(() => rl.attempt('k', rule))).toEqual([true, true, true, false]);
    expect(rl.attempt('other', rule)).toBe(true);
    t = 1000;
    expect(rl.attempt('k', rule)).toBe(true);
    rl.reset('k');
    expect([1, 2, 3].every(() => rl.attempt('k', rule))).toBe(true);
  });
});

describe('recovery session', () => {
  const now = 1_800_000_000;
  const claims = (amr: unknown, extra: Record<string, unknown> = {}) => ({
    role: 'authenticated',
    amr,
    ...extra,
  });

  it('requires a recent `recovery` amr entry on an authenticated, non-anonymous session', () => {
    expect(isRecoverySession(claims([{ method: 'recovery', timestamp: now - 60 }]), now)).toBe(
      true,
    );
    expect(isRecoverySession(claims([{ method: 'password', timestamp: now }]), now)).toBe(false);
    expect(isRecoverySession(claims([{ method: 'recovery', timestamp: now - 7200 }]), now)).toBe(
      false,
    );
    expect(isRecoverySession(claims([{ method: 'recovery', timestamp: now + 3600 }]), now)).toBe(
      false,
    );
    expect(isRecoverySession(claims([{ method: 'recovery' }]), now)).toBe(false);
    expect(
      isRecoverySession(
        claims([{ method: 'recovery', timestamp: now }], { is_anonymous: true }),
        now,
      ),
    ).toBe(false);
    expect(isRecoverySession({ ...claims([]), role: 'anon' }, now)).toBe(false);
    expect(isRecoverySession(null, now)).toBe(false);
  });
});

describe('fixed message vocabulary', () => {
  it('only known codes render; prototype keys and raw text never do', () => {
    expect(errorMessage('invalid_credentials')).toMatch(/don’t match/);
    for (const bad of ['__proto__', 'constructor', 'toString', '<script>', undefined, 42])
      expect(errorMessage(bad)).toBeNull();
    expect(noticeMessage('signed_out')).toMatch(/signed out/);
    expect(noticeMessage('hasOwnProperty')).toBeNull();
  });

  it('maps provider errors to codes', () => {
    expect(authErrorCode({ code: 'email_exists' })).toBe('email_taken');
    expect(authErrorCode({ code: 'flow_state_expired' })).toBe('link_expired');
    expect(authErrorCode({ code: 'whatever', status: 429 })).toBe('rate_limited');
    expect(authErrorCode({ name: 'AuthRetryableFetchError' })).toBe('network');
    expect(authErrorCode('x')).toBe('unknown');
  });
});

describe('onboarding input shaping', () => {
  it('generates valid profile addresses from names', () => {
    for (const name of ['Ana Pérez', 'Club Atlético San José', '!!', 'A'.repeat(200)])
      expect(slugFromName(name)).toMatch(SLUG_RE);
    expect(slugFromName('Ana Pérez')).toMatch(/^ana-perez-[0-9a-f]{4}$/);
  });

  it('normalizes user addresses, countries and keys', () => {
    expect(normalizeSlugInput('  Club-Uno ')).toBe('club-uno');
    expect(normalizeSlugInput('')).toBe('');
    for (const bad of ['a', 'a--b', '-ab', 'ab-', 'a b', 'ñandu'])
      expect(normalizeSlugInput(bad)).toBeNull();
    expect(countryInput('cr')).toBe('CR');
    expect(countryInput('')).toBeUndefined();
    expect(countryInput('CRI')).toBeNull();
    expect(idempotencyKey('oc-person-1234')).toBe('oc-person-1234');
    expect(idempotencyKey('bad key!')).toMatch(/^oc-[0-9a-f]{32}$/);
  });

  it('Sponsor is not an onboarding organization type (separate later phase)', () => {
    expect(isOrganizationType('CLUB')).toBe(true);
    expect(isOrganizationType('SPONSOR')).toBe(false);
  });
});
