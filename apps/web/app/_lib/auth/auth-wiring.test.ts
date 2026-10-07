import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';
import { validateContinuationRoute } from './continuation';
import { resolveOnboardingState, resolvePostAuthDestination } from './onboarding';
import { gateRequest } from './proxy-session';
import { routeAccess, signInRedirectPath } from './route-policy';

describe('continuation (`next=`) accepts only same-origin paths inside /app', () => {
  it.each(['/app', '/app/onboarding', '/app/orgs/club-a?tab=members', '/app/x#y'])(
    'accepts %s',
    (value) => expect(validateContinuationRoute(value)).toBe(value),
  );

  it.each([
    ['absolute URL', 'https://evil.example/app'],
    ['protocol-relative', '//evil.example/app'],
    ['backslash', '/\\evil.example'],
    ['control character', '/app/\n'],
    ['outside /app', '/athletes/someone'],
    ['prefix lookalike', '/application'],
    ['auth route', '/signin'],
    ['api route', '/api/x'],
    ['dot-segment escape', '/app/../api/x'],
    ['encoded dot-segment', '/app/%2e%2e/signin'],
    ['empty', ''],
    ['non-string', 42],
    ['too long', `/app/${'a'.repeat(3000)}`],
  ])('rejects %s', (_label, value) => expect(validateContinuationRoute(value)).toBeNull());
});

describe('route policy: /app is protected by default, everything else stays public', () => {
  it('classifies routes', () => {
    expect(routeAccess('/app')).toBe('protected');
    expect(routeAccess('/app/anything/new')).toBe('protected');
    expect(routeAccess('/application')).toBe('public');
    expect(routeAccess('/signin')).toBe('auth');
    expect(routeAccess('/signup/athlete')).toBe('auth');
    expect(routeAccess('/auth/callback')).toBe('auth');
    expect(routeAccess('/athletes/x')).toBe('public');
    expect(routeAccess('/')).toBe('public');
  });

  it('builds the sign-in redirect with an encoded continuation', () => {
    expect(signInRedirectPath('/app/orgs', '?tab=1')).toBe('/signin?next=%2Fapp%2Forgs%3Ftab%3D1');
  });
});

describe('onboarding is derived from platform rows, never from metadata', () => {
  const none = { selfPersonId: null, athleteCount: 0, membershipCount: 0 };
  const person = { selfPersonId: 'p1', athleteCount: 0, membershipCount: 0 };

  it('derives the state', () => {
    expect(resolveOnboardingState(none)).toBe('needs_person');
    expect(resolveOnboardingState(person)).toBe('needs_role');
    expect(resolveOnboardingState({ ...person, athleteCount: 1 })).toBe('active');
    expect(resolveOnboardingState({ ...person, membershipCount: 1 })).toBe('active');
  });

  it('unfinished onboarding overrides `next`; the sign-up hint only pre-selects a path', () => {
    // ONCF-04: a valid continuation rides along so onboarding can resume it afterwards.
    expect(resolvePostAuthDestination({ facts: none, requested: '/app/orgs' })).toBe(
      '/app/onboarding?next=%2Fapp%2Forgs',
    );
    expect(resolvePostAuthDestination({ facts: none, requested: 'https://evil.example' })).toBe(
      '/app/onboarding',
    );
    expect(resolvePostAuthDestination({ facts: none })).toBe('/app/onboarding');
    expect(resolvePostAuthDestination({ facts: person, hint: 'organization' })).toBe(
      '/app/onboarding?path=organization',
    );
    expect(resolvePostAuthDestination({ facts: person, hint: 'admin' })).toBe('/app/onboarding');
  });

  it('active users go to a validated continuation or /app', () => {
    const active = { ...person, athleteCount: 1 };
    expect(resolvePostAuthDestination({ facts: active, requested: '/app/registrations' })).toBe(
      '/app/registrations',
    );
    expect(resolvePostAuthDestination({ facts: active, requested: 'https://evil.example' })).toBe(
      '/app',
    );
    expect(resolvePostAuthDestination({ facts: active })).toBe('/app');
  });
});

describe('proxy gate fails closed', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('public routes pass through untouched', async () => {
    const res = await gateRequest(new NextRequest('https://app.example/athletes/x'));
    expect(res.headers.get('location')).toBeNull();
  });

  it('without Supabase configuration, /app redirects to sign-in with the continuation', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const res = await gateRequest(new NextRequest('https://app.example/app/orgs?tab=1'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      'https://app.example/signin?next=%2Fapp%2Forgs%3Ftab%3D1',
    );
  });

  it('with no session cookie, /app redirects to sign-in', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefghijklmnop.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
    const res = await gateRequest(new NextRequest('https://app.example/app'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://app.example/signin?next=%2Fapp');
  });
});
