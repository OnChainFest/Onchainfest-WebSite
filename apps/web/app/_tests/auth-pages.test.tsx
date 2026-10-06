import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ONCF-01 screens rendered as server components against a fake Supabase session and platform API.

const h = vi.hoisted(() => ({
  auth: { getClaims: vi.fn(), getSession: vi.fn() },
}));
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth: h.auth }) }));
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ getAll: () => [], set: () => undefined }),
  headers: () => Promise.resolve(new Headers()),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), {
      digest: `NEXT_REDIRECT;replace;${url};307;`,
    });
  },
}));
// The client-only pending button renders as a plain button on the server.
vi.mock('../_product/submit-button', () => ({
  SubmitButton: ({ children }: { children: ReactNode }) => (
    <button type="submit">{children}</button>
  ),
}));

const SignIn = (await import('../(auth)/signin/page')).default;
const SignUp = (await import('../(auth)/signup/page')).default;
const Reset = (await import('../(auth)/reset-password/page')).default;
const AppLayout = (await import('../app/layout')).default;

const sp = (q: Record<string, string>) => ({ searchParams: Promise.resolve(q) });
const html = (el: ReactElement | null) => (el === null ? '' : renderToStaticMarkup(el));

beforeEach(() => {
  h.auth.getClaims.mockReset();
  h.auth.getSession.mockReset();
  h.auth.getClaims.mockResolvedValue({ data: null, error: { code: 'session_not_found' } });
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefghijklmnop.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  vi.unstubAllGlobals();
});

describe('sign in screen', () => {
  it('shows fixed error copy and carries only a safe continuation', async () => {
    const out = html(await SignIn(sp({ error: 'invalid_credentials', next: '/app/orgs' })));
    expect(out).toContain('That email and password don’t match an account.');
    expect(out).toContain('name="next" value="/app/orgs"');
    const unsafe = html(await SignIn(sp({ next: '//evil.example' })));
    expect(unsafe).not.toContain('name="next"');
  });

  it('unknown error codes render nothing (no reflected text)', async () => {
    const out = html(await SignIn(sp({ error: '<b>pwned</b>' })));
    expect(out).not.toContain('pwned');
    expect(out).not.toContain('role="alert"');
  });

  it('unverified email offers the resend path', async () => {
    expect(html(await SignIn(sp({ error: 'email_not_confirmed' })))).toContain(
      'href="/signup/confirm-email"',
    );
  });
});

describe('sign up screen', () => {
  it('starts with the Athlete / Organization chooser — no Sponsor lane', async () => {
    const out = html(await SignUp(sp({})));
    expect(out).toContain('href="/signup?path=athlete"');
    expect(out).toContain('href="/signup?path=organization"');
    expect(out.toLowerCase()).not.toContain('sponsor');
  });

  it('the form collects only email and password; the lane is a hidden hint', async () => {
    const out = html(await SignUp(sp({ path: 'organization' })));
    expect(out).toContain('name="path" value="organization"');
    const names = [...out.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
    expect(names.sort()).toEqual(['email', 'password', 'path']);
  });
});

describe('reset password screen', () => {
  it('without a recovery session shows the invalid state and no password form', async () => {
    const out = html(await Reset(sp({})));
    expect(out).toContain('Request a fresh link');
    expect(out).toContain('href="/forgot-password"');
    expect(out).not.toContain('name="password"');
  });

  it('with a fresh recovery session shows the form', async () => {
    h.auth.getClaims.mockResolvedValue({
      data: {
        claims: {
          sub: 'u',
          role: 'authenticated',
          amr: [{ method: 'recovery', timestamp: Math.floor(Date.now() / 1000) }],
        },
      },
      error: null,
    });
    h.auth.getSession.mockResolvedValue({ data: { session: { access_token: 't' } } });
    expect(html(await Reset(sp({})))).toContain('name="confirm"');
  });
});

describe('/app shell', () => {
  const signedIn = () => {
    h.auth.getClaims.mockResolvedValue({
      data: { claims: { sub: 'u', role: 'authenticated', email: 'ana@example.com' } },
      error: null,
    });
    h.auth.getSession.mockResolvedValue({ data: { session: { access_token: 't' } } });
  };
  const api = (routes: Record<string, () => Response>) =>
    vi.stubGlobal('fetch', (url: string) => {
      const r = routes[new URL(url).pathname];
      return Promise.resolve(r === undefined ? new Response('{}', { status: 404 }) : r());
    });
  const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });

  it('API unavailable → blocked state, no app navigation', async () => {
    signedIn();
    api({ '/v1/me': () => new Response('', { status: 503 }) });
    const out = html(await AppLayout({ children: <p>secret app content</p> }));
    expect(out).toContain('Temporarily unavailable');
    expect(out).not.toContain('secret app content');
  });

  it('session rejected by the platform → sign-out only (POST form)', async () => {
    signedIn();
    api({ '/v1/me': () => new Response('', { status: 401 }) });
    const out = html(await AppLayout({ children: <p>secret app content</p> }));
    expect(out).toContain('Session not accepted');
    expect(out).toContain('action="/auth/signout" method="post"');
    expect(out).not.toContain('secret app content');
  });

  it('role-aware navigation comes from platform rows; sign-out is a POST form', async () => {
    signedIn();
    api({
      '/v1/me': ok({
        accountId: 'a',
        accountActive: true,
        selfPersonId: 'p',
        athletes: [{ athleteId: 'x', personId: 'p', slug: 'ana' }],
        guardianRelationships: [],
      }),
      '/v1/me/organizations': ok({
        items: [
          {
            membershipId: 'm',
            organizationId: 'o',
            role: 'OWNER',
            orgType: 'CLUB',
            slug: 'club-uno',
            displayName: 'Club Uno',
          },
        ],
      }),
    });
    const out = html(await AppLayout({ children: <p>content</p> }));
    expect(out).toContain('href="/athletes/ana"');
    expect(out).toContain('href="/app/orgs/club-uno"');
    expect(out).toContain('href="/app/account"');
    expect(out).not.toContain('Finish setup');
    expect(out).toContain('action="/auth/signout" method="post"');
    expect(out).not.toMatch(/href="\/auth\/signout"/);
  });

  it('an account without a profile sees the real setup step in navigation', async () => {
    signedIn();
    api({
      '/v1/me': ok({
        accountId: 'a',
        accountActive: true,
        selfPersonId: null,
        athletes: [],
        guardianRelationships: [],
      }),
      '/v1/me/organizations': ok({ items: [] }),
    });
    expect(html(await AppLayout({ children: <p>content</p> }))).toContain('href="/app/onboarding"');
  });
});
