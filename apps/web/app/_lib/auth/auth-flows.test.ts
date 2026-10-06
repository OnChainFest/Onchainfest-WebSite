import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ONCF-01 auth + onboarding flows, run against a fake Supabase client and a fake platform API.
// No real Supabase project or database is needed (see docs/implementation/ONCF-01-AUTH-UX.md).

const h = vi.hoisted(() => {
  const auth = {
    signInWithPassword: vi.fn(),
    signUp: vi.fn(),
    resend: vi.fn(),
    resetPasswordForEmail: vi.fn(),
    getClaims: vi.fn(),
    getSession: vi.fn(),
    updateUser: vi.fn(),
    signOut: vi.fn(),
    exchangeCodeForSession: vi.fn(),
    verifyOtp: vi.fn(),
  };
  return { auth, cookies: new Map<string, string>(), ip: { value: '10.0.0.1' } };
});

vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth: h.auth }) }));
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      getAll: () => [...h.cookies].map(([name, value]) => ({ name, value })),
      set: (name: string, value: string) => h.cookies.set(name, value),
    }),
  headers: () => Promise.resolve(new Headers({ 'x-forwarded-for': `${h.ip.value}, 10.9.9.9` })),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), {
      digest: `NEXT_REDIRECT;replace;${url};307;`,
    });
  },
}));

const { signInAction, signUpAction, forgotPasswordAction, resetPasswordAction } =
  await import('./actions');
const { GET: callback } = await import('../../auth/callback/route');
const { GET: confirm } = await import('../../auth/confirm/route');
const signout = await import('../../auth/signout/route');
const { createAthleteProfileAction, createOrganizationAction } =
  await import('../../app/onboarding/actions');
const { appContext } = await import('../app-context');

// ───────────────────────────── helpers ─────────────────────────────

async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    const digest = (err as { digest?: string }).digest;
    if (typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT'))
      return digest.split(';')[2] ?? '';
    throw err;
  }
  throw new Error('expected a redirect');
}

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

const authError = (code: string, status = 400) =>
  Object.assign(new Error('provider message that must never reach the page'), {
    code,
    status,
    name: 'AuthApiError',
  });

interface ApiCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}
let apiCalls: ApiCall[] = [];
let apiRoutes: Record<string, (call: ApiCall) => Response> = {};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function me(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acc-1',
    accountActive: true,
    selfPersonId: null,
    athletes: [],
    guardianRelationships: [],
    ...overrides,
  };
}

let seq = 0;
beforeEach(() => {
  seq += 1;
  h.ip.value = `10.0.${seq}.1`;
  h.cookies.clear();
  for (const fn of Object.values(h.auth)) fn.mockReset();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefghijklmnop.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-test-key';
  process.env.NEXT_PUBLIC_SITE_URL = 'https://app.onchainfest.test';
  apiCalls = [];
  apiRoutes = {
    'GET /v1/me': () => json(200, me()),
    'GET /v1/me/organizations': () => json(200, { items: [] }),
  };
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const call: ApiCall = {
      method: init.method ?? 'GET',
      path: u.pathname,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    apiCalls.push(call);
    const handler = apiRoutes[`${call.method} ${call.path}`];
    return Promise.resolve(handler === undefined ? json(404, {}) : handler(call));
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const session = (token = 'access-token-1') => ({
  data: { session: { access_token: token }, user: { id: 'u1' } },
  error: null,
});
const nowS = () => Math.floor(Date.now() / 1000);
function signedIn(
  amr: { method: string; timestamp: number }[] = [{ method: 'password', timestamp: nowS() }],
) {
  h.auth.getClaims.mockResolvedValue({
    data: { claims: { sub: 'u1', role: 'authenticated', email: 'a@b.co', amr } },
    error: null,
  });
  h.auth.getSession.mockResolvedValue({ data: { session: { access_token: 'access-token-1' } } });
}

// ───────────────────────────── sign in ─────────────────────────────

describe('sign in', () => {
  it('a new account goes to onboarding — decided from platform rows with the new token', async () => {
    h.auth.signInWithPassword.mockResolvedValue(session('fresh-token'));
    const to = await redirectOf(() =>
      signInAction(form({ email: 'a@b.co', password: 'secret123', next: '/app/orgs' })),
    );
    expect(to).toBe('/app/onboarding');
    expect(h.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'a@b.co',
      password: 'secret123',
    });
    expect(apiCalls.map((c) => c.headers.authorization)).toEqual([
      'Bearer fresh-token',
      'Bearer fresh-token',
    ]);
  });

  it('an onboarded account honours a safe next= and drops an unsafe one', async () => {
    apiRoutes['GET /v1/me'] = () =>
      json(
        200,
        me({ selfPersonId: 'p1', athletes: [{ athleteId: 'a1', personId: 'p1', slug: 'ana' }] }),
      );
    h.auth.signInWithPassword.mockResolvedValue(session());
    expect(
      await redirectOf(() =>
        signInAction(form({ email: 'a@b.co', password: 'secret123', next: '/app/registrations' })),
      ),
    ).toBe('/app/registrations');
    expect(
      await redirectOf(() =>
        signInAction(
          form({ email: 'a@b.co', password: 'secret123', next: 'https://evil.example/' }),
        ),
      ),
    ).toBe('/app');
  });

  it.each([
    ['invalid_credentials', 'invalid_credentials'],
    ['email_not_confirmed', 'email_not_confirmed'],
    ['over_request_rate_limit', 'rate_limited'],
  ])('provider error %s → fixed code %s (no raw message)', async (code, expected) => {
    h.auth.signInWithPassword.mockResolvedValue({
      data: { session: null },
      error: authError(code),
    });
    const to = await redirectOf(() =>
      signInAction(form({ email: 'a@b.co', password: 'wrong-pass1', next: '/app/x' })),
    );
    expect(to).toBe(`/signin?error=${expected}&next=%2Fapp%2Fx`);
    expect(to).not.toMatch(/provider/);
  });

  it('network failure → network error code', async () => {
    h.auth.signInWithPassword.mockRejectedValue(
      Object.assign(new Error('fetch failed'), { name: 'AuthRetryableFetchError' }),
    );
    expect(await redirectOf(() => signInAction(form({ email: 'a@b.co', password: 'x' })))).toBe(
      '/signin?error=network',
    );
  });

  it('is rate limited per IP + email before reaching Supabase', async () => {
    h.auth.signInWithPassword.mockResolvedValue({
      data: { session: null },
      error: authError('invalid_credentials'),
    });
    for (let i = 0; i < 8; i += 1)
      await redirectOf(() => signInAction(form({ email: 'victim@b.co', password: `guess${i}` })));
    expect(h.auth.signInWithPassword).toHaveBeenCalledTimes(8);
    expect(
      await redirectOf(() => signInAction(form({ email: 'victim@b.co', password: 'guess9' }))),
    ).toBe('/signin?error=rate_limited');
    expect(h.auth.signInWithPassword).toHaveBeenCalledTimes(8);
  });

  it('fails closed when Supabase is not configured', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(await redirectOf(() => signInAction(form({ email: 'a@b.co', password: 'x' })))).toBe(
      '/signin?error=not_configured',
    );
  });
});

// ───────────────────────────── sign up ─────────────────────────────

describe('sign up', () => {
  it('never writes account type or profile data to Supabase metadata', async () => {
    h.auth.signUp.mockResolvedValue({ data: { session: null, user: { id: 'u' } }, error: null });
    const to = await redirectOf(() =>
      signUpAction(form({ email: 'new@b.co', password: 'secret123', path: 'organization' })),
    );
    expect(to).toBe('/signup/confirm-email?path=organization');
    const [args] = h.auth.signUp.mock.calls[0] as [{ options: Record<string, unknown> }];
    expect(Object.keys(args.options)).toEqual(['emailRedirectTo']);
    expect(args.options.emailRedirectTo).toBe(
      'https://app.onchainfest.test/auth/callback?flow=signup&path=organization',
    );
  });

  it('duplicate email reported by the provider → email_taken', async () => {
    h.auth.signUp.mockResolvedValue({
      data: { session: null },
      error: authError('user_already_exists', 422),
    });
    expect(
      await redirectOf(() =>
        signUpAction(form({ email: 'dup@b.co', password: 'secret123', path: 'athlete' })),
      ),
    ).toBe('/signup?path=athlete&error=email_taken');
  });

  it('weak passwords and invalid emails are refused before Supabase', async () => {
    expect(
      await redirectOf(() =>
        signUpAction(form({ email: 'x@b.co', password: 'short', path: 'athlete' })),
      ),
    ).toBe('/signup?path=athlete&error=weak_password');
    expect(
      await redirectOf(() => signUpAction(form({ email: 'nope', password: 'secret123' }))),
    ).toBe('/signup?error=invalid_email');
    expect(h.auth.signUp).not.toHaveBeenCalled();
  });

  it('without confirmation (local stack) the session goes straight to onboarding with the hint', async () => {
    h.auth.signUp.mockResolvedValue(session());
    expect(
      await redirectOf(() =>
        signUpAction(form({ email: 'n@b.co', password: 'secret123', path: 'athlete' })),
      ),
    ).toBe('/app/onboarding?path=athlete');
  });

  it('production without NEXT_PUBLIC_SITE_URL fails closed (no Host-derived email links)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    delete process.env.NEXT_PUBLIC_SITE_URL;
    expect(
      await redirectOf(() => signUpAction(form({ email: 'n@b.co', password: 'secret123' }))),
    ).toBe('/signup?error=not_configured');
    expect(h.auth.signUp).not.toHaveBeenCalled();
  });
});

// ───────────────────────────── password reset ─────────────────────────────

describe('password reset', () => {
  it('forgot password never reveals whether the account exists', async () => {
    h.auth.resetPasswordForEmail.mockResolvedValue({ error: authError('user_not_found', 404) });
    expect(await redirectOf(() => forgotPasswordAction(form({ email: 'ghost@b.co' })))).toBe(
      '/forgot-password?notice=reset_sent',
    );
    expect(h.auth.resetPasswordForEmail).toHaveBeenCalledWith('ghost@b.co', {
      redirectTo: 'https://app.onchainfest.test/auth/callback?flow=recovery',
    });
  });

  it('an ordinary signed-in session cannot change the password', async () => {
    signedIn();
    expect(
      await redirectOf(() =>
        resetPasswordAction(form({ password: 'newpass123', confirm: 'newpass123' })),
      ),
    ).toBe('/reset-password?error=reset_session_invalid');
    expect(h.auth.updateUser).not.toHaveBeenCalled();
  });

  it('an expired recovery session is refused', async () => {
    signedIn([{ method: 'recovery', timestamp: nowS() - 2 * 3600 }]);
    expect(
      await redirectOf(() =>
        resetPasswordAction(form({ password: 'newpass123', confirm: 'newpass123' })),
      ),
    ).toBe('/reset-password?error=reset_session_invalid');
  });

  it('a valid recovery session updates the password and signs out everywhere', async () => {
    signedIn([{ method: 'recovery', timestamp: nowS() - 30 }]);
    h.auth.updateUser.mockResolvedValue({ data: {}, error: null });
    h.auth.signOut.mockResolvedValue({ error: null });
    expect(
      await redirectOf(() =>
        resetPasswordAction(form({ password: 'newpass123', confirm: 'newpass123' })),
      ),
    ).toBe('/signin?notice=password_updated');
    expect(h.auth.updateUser).toHaveBeenCalledWith({ password: 'newpass123' });
    expect(h.auth.signOut).toHaveBeenCalledWith({ scope: 'global' });
  });

  it('mismatched and reused passwords are reported', async () => {
    signedIn([{ method: 'recovery', timestamp: nowS() }]);
    expect(
      await redirectOf(() =>
        resetPasswordAction(form({ password: 'newpass123', confirm: 'other1234' })),
      ),
    ).toBe('/reset-password?error=password_mismatch');
    h.auth.updateUser.mockResolvedValue({ data: {}, error: authError('same_password', 422) });
    expect(
      await redirectOf(() =>
        resetPasswordAction(form({ password: 'oldpass123', confirm: 'oldpass123' })),
      ),
    ).toBe('/reset-password?error=same_password');
  });
});

// ───────────────────────────── email links ─────────────────────────────

const location = (res: Response) => res.headers.get('location');

describe('email link landing (callback / confirm)', () => {
  it('expired recovery link → forgot-password with link_expired', async () => {
    const res = await callback(
      new Request(
        'https://app.test/auth/callback?flow=recovery&error=access_denied&error_code=otp_expired',
      ),
    );
    expect(location(res)).toBe('https://app.test/forgot-password?error=link_expired');
    expect(h.auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('recovery code → reset screen only', async () => {
    h.auth.exchangeCodeForSession.mockResolvedValue(session());
    const res = await callback(
      new Request('https://app.test/auth/callback?flow=recovery&code=abc'),
    );
    expect(location(res)).toBe('https://app.test/reset-password');
  });

  it('verified sign-up → data-derived onboarding with the lane hint and a success notice', async () => {
    h.auth.exchangeCodeForSession.mockResolvedValue(session('new-user-token'));
    const res = await callback(
      new Request('https://app.test/auth/callback?flow=signup&path=organization&code=abc'),
    );
    expect(location(res)).toBe(
      'https://app.test/app/onboarding?path=organization&notice=email_verified',
    );
    expect(apiCalls.every((c) => c.headers.authorization === 'Bearer new-user-token')).toBe(true);
  });

  it('missing code, foreign-browser code and junk are rejected with fixed codes', async () => {
    expect(location(await callback(new Request('https://app.test/auth/callback')))).toBe(
      'https://app.test/signin?error=link_invalid',
    );
    h.auth.exchangeCodeForSession.mockResolvedValue({
      data: { session: null },
      error: authError('bad_code_verifier'),
    });
    expect(location(await callback(new Request('https://app.test/auth/callback?code=x')))).toBe(
      'https://app.test/signin?error=link_other_browser',
    );
  });

  it('token-hash recovery links verify the OTP and go to the reset screen', async () => {
    h.auth.verifyOtp.mockResolvedValue(session());
    const res = await confirm(
      new Request('https://app.test/auth/confirm?type=recovery&token_hash=th'),
    );
    expect(h.auth.verifyOtp).toHaveBeenCalledWith({ type: 'recovery', token_hash: 'th' });
    expect(location(res)).toBe('https://app.test/reset-password');
    const bad = await confirm(
      new Request('https://app.test/auth/confirm?type=magic&token_hash=th'),
    );
    expect(location(bad)).toBe('https://app.test/signin?error=link_invalid');
  });
});

// ───────────────────────────── sign out ─────────────────────────────

describe('sign out is POST-only', () => {
  it('GET and HEAD are 405', () => {
    const res = signout.GET();
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expect(signout.HEAD().status).toBe(405);
  });

  it('cross-origin POST is refused', async () => {
    const res = await signout.POST(
      new Request('https://app.test/auth/signout', {
        method: 'POST',
        headers: { origin: 'https://evil.example' },
      }),
    );
    expect(res.status).toBe(403);
    expect(h.auth.signOut).not.toHaveBeenCalled();
  });

  it('same-origin POST signs out and clears auth cookies even if Supabase fails', async () => {
    h.cookies.set('sb-abcdefghijklmnop-auth-token.0', 'chunk');
    h.cookies.set('unrelated', 'keep');
    h.auth.signOut.mockRejectedValue(new Error('down'));
    const res = await signout.POST(
      new Request('https://app.test/auth/signout', {
        method: 'POST',
        headers: { origin: 'https://app.test' },
      }),
    );
    expect(res.status).toBe(303);
    expect(location(res)).toBe('https://app.test/signin?notice=signed_out');
    const cleared = res.headers.getSetCookie().join('\n');
    expect(cleared).toMatch(/sb-abcdefghijklmnop-auth-token\.0=;/);
    expect(cleared).not.toMatch(/unrelated/);
  });
});

// ───────────────────────────── onboarding persistence ─────────────────────────────

describe('onboarding persists through the real platform API', () => {
  it('athlete: creates the SELF person, then the athlete — idempotently, with the session token', async () => {
    signedIn();
    apiRoutes['POST /v1/persons'] = () => json(201, { personId: 'p-new' });
    apiRoutes['POST /v1/athletes'] = () => json(201, { athleteId: 'a-new', slug: 'ana-runner' });
    const to = await redirectOf(() =>
      createAthleteProfileAction(
        form({
          displayName: 'Ana Runner',
          slug: 'Ana-Runner',
          country: 'cr',
          sport: 'Padel',
          personKey: 'oc-person-key-1',
          profileKey: 'oc-profile-key-1',
        }),
      ),
    );
    expect(to).toBe('/app?notice=athlete_created');
    const writes = apiCalls.filter((c) => c.method === 'POST');
    expect(writes).toEqual([
      expect.objectContaining({ path: '/v1/persons', body: { relation: 'SELF' } }),
      expect.objectContaining({
        path: '/v1/athletes',
        body: {
          personId: 'p-new',
          slug: 'ana-runner',
          profile: { displayName: 'Ana Runner', homeCountry: 'CR', preferredSports: ['Padel'] },
        },
      }),
    ]);
    expect(writes.map((c) => c.headers['idempotency-key'])).toEqual([
      'oc-person-key-1',
      'oc-profile-key-1',
    ]);
    expect(writes.every((c) => c.headers.authorization === 'Bearer access-token-1')).toBe(true);
    expect(h.auth.updateUser).not.toHaveBeenCalled();
  });

  it('organization: reuses an existing person; slug conflicts are reported', async () => {
    signedIn();
    apiRoutes['GET /v1/me'] = () => json(200, me({ selfPersonId: 'p1' }));
    apiRoutes['POST /v1/organizations'] = () =>
      json(409, { error: { code: 'SLUG_TAKEN', message: 'slug is not available' } });
    const to = await redirectOf(() =>
      createOrganizationAction(
        form({
          displayName: 'Club Uno',
          orgType: 'CLUB',
          slug: 'club-uno',
          profileKey: 'oc-k-12345',
        }),
      ),
    );
    expect(to).toBe('/app/onboarding?path=organization&error=profile_address_taken');
    const writes = apiCalls.filter((c) => c.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toEqual({
      orgType: 'CLUB',
      slug: 'club-uno',
      profile: { displayName: 'Club Uno' },
    });
  });

  it('Sponsor (and any unsupported type) is refused before the API', async () => {
    signedIn();
    expect(
      await redirectOf(() =>
        createOrganizationAction(form({ displayName: 'Brand', orgType: 'SPONSOR' })),
      ),
    ).toBe('/app/onboarding?path=organization&error=profile_invalid');
    expect(apiCalls).toHaveLength(0);
  });

  it('API rejection → sign in again; API outage → retryable error', async () => {
    signedIn();
    apiRoutes['GET /v1/me'] = () => json(401, {});
    expect(await redirectOf(() => createAthleteProfileAction(form({ displayName: 'Ana' })))).toBe(
      '/signin?error=session_expired&next=%2Fapp',
    );
    apiRoutes['GET /v1/me'] = () => json(503, {});
    expect(await redirectOf(() => createAthleteProfileAction(form({ displayName: 'Ana' })))).toBe(
      '/app/onboarding?path=athlete&error=platform_unavailable',
    );
  });

  it('without a verified session nothing is written', async () => {
    h.auth.getClaims.mockResolvedValue({ data: null, error: authError('session_not_found') });
    expect(await redirectOf(() => createAthleteProfileAction(form({ displayName: 'Ana' })))).toBe(
      '/signin?error=session_expired&next=%2Fapp%2Fonboarding',
    );
    expect(apiCalls).toHaveLength(0);
  });
});

// ───────────────────────────── /app context ─────────────────────────────

describe('/app context fails closed', () => {
  it('signed out, API-rejected and API-down sessions never yield app content', async () => {
    h.auth.getClaims.mockResolvedValue({ data: null, error: authError('session_not_found') });
    expect((await appContext()).kind).toBe('signed_out');
    signedIn();
    apiRoutes['GET /v1/me'] = () => json(401, {});
    expect((await appContext()).kind).toBe('rejected');
    apiRoutes['GET /v1/me'] = () => json(500, {});
    expect((await appContext()).kind).toBe('unavailable');
  });

  it('an anonymous Supabase session is not a signed-in user', async () => {
    h.auth.getClaims.mockResolvedValue({
      data: { claims: { sub: 'u', role: 'authenticated', is_anonymous: true } },
      error: null,
    });
    expect((await appContext()).kind).toBe('signed_out');
  });

  it('onboarding state comes from /v1/me and /v1/me/organizations', async () => {
    signedIn();
    apiRoutes['GET /v1/me'] = () => json(200, me({ selfPersonId: 'p1' }));
    let ctx = await appContext();
    expect(ctx.kind === 'ok' && ctx.onboarding).toBe('needs_role');
    apiRoutes['GET /v1/me/organizations'] = () =>
      json(200, {
        items: [
          {
            membershipId: 'm',
            organizationId: 'o',
            role: 'OWNER',
            orgType: 'CLUB',
            slug: 'c',
            displayName: 'C',
          },
        ],
      });
    ctx = await appContext();
    expect(ctx.kind === 'ok' && ctx.onboarding).toBe('active');
  });
});
