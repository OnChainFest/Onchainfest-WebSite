import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ONCF-02 organization area, rendered and exercised against a fake session + fake platform API.
// The API remains the authority; these tests prove the web layer asks it and reflects its answers.

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
  permanentRedirect: (url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), {
      digest: `NEXT_REDIRECT;replace;${url};308;`,
    });
  },
  notFound: () => {
    throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
  },
}));
vi.mock('../_product/submit-button', () => ({
  SubmitButton: ({ children }: { children: ReactNode }) => (
    <button type="submit">{children}</button>
  ),
}));
vi.mock('../_product/invite-form', () => ({
  InviteForm: ({ roles }: { roles: string[] }) => <form data-invite-roles={roles.join(',')} />,
}));

const OrgLayout = (await import('../app/orgs/[slug]/layout')).default;
const Dashboard = (await import('../app/orgs/[slug]/page')).default;
const Members = (await import('../app/orgs/[slug]/members/page')).default;
const Invitations = (await import('../app/orgs/[slug]/invitations/page')).default;
const Profile = (await import('../app/orgs/[slug]/profile/page')).default;
const InvitationPage = (await import('../app/invitations/page')).default;
const PublicOrg = (await import('../(public)/organizations/[slug]/page')).default;
const actions = await import('../app/orgs/[slug]/actions');
const invitationActions = await import('../app/invitations/actions');

// ───────────────────────────── fake platform ─────────────────────────────

const ORG = '0b9b4b8e-6f0a-4f3e-9d6a-1c2b3c4d5e6f';
const M_SELF = '11111111-1111-4111-8111-111111111111';
const M_OTHER = '22222222-2222-4222-8222-222222222222';
const M_OWNER2 = '33333333-3333-4333-8333-333333333333';

interface Call {
  method: string;
  path: string;
  auth: string | undefined;
  body: unknown;
  key: string | undefined;
}
let calls: Call[] = [];
let routes: Record<string, (c: Call) => Response> = {};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function platform(role: 'OWNER' | 'ADMIN' | 'ATHLETE', perms: string[]) {
  routes = {
    'GET /v1/me': () =>
      json(200, {
        accountId: 'acc',
        accountActive: true,
        selfPersonId: 'p-self',
        athletes: [],
        guardianRelationships: [],
      }),
    'GET /v1/me/organizations': () =>
      json(200, {
        items: [
          {
            membershipId: M_SELF,
            organizationId: ORG,
            role,
            orgType: 'CLUB',
            slug: 'club-uno',
            displayName: 'Club Uno',
          },
        ],
      }),
    [`GET /v1/organizations/${ORG}/permissions`]: () =>
      json(200, { roles: [role], permissions: perms }),
    'GET /v1/organizations/club-uno': () =>
      json(200, {
        organization: {
          organizationId: ORG,
          slug: 'club-uno',
          orgType: 'CLUB',
          status: 'ACTIVE',
          profile: {
            displayName: 'Club Uno',
            description: 'Padel club.',
            website: null,
            country: 'CR',
            region: null,
            publicContact: null,
            logoUrl: null,
            accentColor: '#ff2da4',
            sports: ['Padel'],
            provenance: 'SELF_DECLARED',
          },
          authority: { status: 'NOT_AVAILABLE', reason: 'SOURCE_NOT_IMPLEMENTED' },
        },
        affiliations: {
          status: 'AVAILABLE',
          items: [
            {
              athleteSlug: 'ana',
              displayName: 'Ana',
              role: 'ATHLETE',
              since: '2026-10-01',
              provenance: 'ORGANIZATION_CONFIRMED',
            },
          ],
        },
        canonicalSlug: 'club-uno',
        redirected: false,
      }),
    'GET /v1/organizations/club-uno/competitions': () => json(200, { items: [] }),
    [`GET /v1/organizations/${ORG}/members`]: () =>
      json(200, {
        items: [
          {
            membershipId: M_SELF,
            personId: 'p-self',
            role,
            visibility: 'MEMBERS',
            status: 'ACTIVE',
            since: '2026-10-01T00:00:00Z',
            invitationExpiresAt: null,
            athlete: null,
          },
          {
            membershipId: M_OTHER,
            personId: 'p-ana',
            role: 'ATHLETE',
            visibility: 'PUBLIC',
            status: 'ACTIVE',
            since: '2026-10-02T00:00:00Z',
            invitationExpiresAt: null,
            athlete: { slug: 'ana', displayName: 'Ana Pérez' },
          },
          {
            membershipId: M_OWNER2,
            personId: 'p-own',
            role: 'OWNER',
            visibility: 'MEMBERS',
            status: 'ACTIVE',
            since: '2026-10-01T00:00:00Z',
            invitationExpiresAt: null,
            athlete: null,
          },
          ...(perms.includes('ORG_VIEW_PRIVATE')
            ? [
                {
                  membershipId: '44444444-4444-4444-8444-444444444444',
                  personId: 'p-inv',
                  role: 'ATHLETE',
                  visibility: 'MEMBERS',
                  status: 'INVITED',
                  since: '2026-10-05T00:00:00Z',
                  invitationExpiresAt: '2099-01-01T00:00:00Z',
                  athlete: { slug: 'luis', displayName: 'Luis' },
                },
              ]
            : []),
        ],
      }),
  };
}

const ALL = [
  'ORG_CONFIRM_EXTERNAL_ID',
  'ORG_EDIT_PROFILE',
  'ORG_INVITE_MEMBER',
  'ORG_MANAGE_COMPETITIONS',
  'ORG_MANAGE_ROLES',
  'ORG_REMOVE_MEMBER',
  'ORG_VIEW_PRIVATE',
];

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefghijklmnop.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.NEXT_PUBLIC_SITE_URL = 'https://app.onchainfest.test';
  h.auth.getClaims.mockResolvedValue({
    data: { claims: { sub: 'u', role: 'authenticated', email: 'o@club.test' } },
    error: null,
  });
  h.auth.getSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } });
  calls = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const c: Call = {
      method: init.method ?? 'GET',
      path: u.pathname,
      auth: headers.authorization,
      key: headers['idempotency-key'],
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(c);
    const r = routes[`${c.method} ${c.path}`];
    return Promise.resolve(r === undefined ? json(404, {}) : r(c));
  });
});

const p = (slug = 'club-uno') => ({ params: Promise.resolve({ slug }) });
const sp = (q: Record<string, string> = {}) => ({ searchParams: Promise.resolve(q) });
const html = (el: ReactElement | null) => (el === null ? '' : renderToStaticMarkup(el));
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    const d = (err as { digest?: string }).digest ?? '';
    if (d.startsWith('NEXT_REDIRECT')) return d.split(';')[2] ?? '';
    if (d.includes('404')) return '404';
    throw err;
  }
  return 'rendered';
}
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const writes = () => calls.filter((c) => c.method !== 'GET');

// ───────────────────────────── access ─────────────────────────────

describe('organization access', () => {
  it('a non-member gets a plain 404 (nothing about the organization is revealed)', async () => {
    platform('OWNER', ALL);
    expect(await outcome(() => OrgLayout({ children: null, ...p('someone-elses-club') }))).toBe(
      '404',
    );
    expect(calls.some((c) => c.path.includes('/permissions'))).toBe(false);
  });

  it('members see the branded header and tabs filtered by their API permissions', async () => {
    platform('ATHLETE', []);
    const out = html(await OrgLayout({ children: <p>body</p>, ...p() }));
    expect(out).toContain('Club Uno');
    expect(out).toContain('--brand:#ff2da4');
    expect(out).toContain('href="/app/orgs/club-uno/members"');
    expect(out).not.toContain('href="/app/orgs/club-uno/invitations"');
    platform('OWNER', ALL);
    expect(html(await OrgLayout({ children: <p>body</p>, ...p() }))).toContain(
      'href="/app/orgs/club-uno/invitations"',
    );
  });
});

// ───────────────────────────── dashboard ─────────────────────────────

describe('dashboard uses real data only', () => {
  it('counts members from the roster, shows pending to admins and a real empty tournament state', async () => {
    platform('OWNER', ALL);
    const out = html(await Dashboard({ ...p(), ...sp() }));
    expect(out).toMatch(/Active members<\/span><strong>3<\/strong>/);
    expect(out).toMatch(/Pending invitations<\/span><strong>1<\/strong>/);
    expect(out).toMatch(/Tournaments<\/span><strong>0<\/strong>/);
    expect(out).toContain('No published tournaments yet');
    expect(out.toLowerCase()).not.toContain('coming soon');
  });

  it('plain members do not see pending invitations or setup actions', async () => {
    platform('ATHLETE', []);
    const out = html(await Dashboard({ ...p(), ...sp() }));
    expect(out).not.toContain('Pending invitations');
    expect(out).not.toContain('Add logo');
  });
});

// ───────────────────────────── members & roles UI ─────────────────────────────

describe('members screen reflects server permissions', () => {
  it('a plain member sees the roster without any management controls', async () => {
    platform('ATHLETE', []);
    const out = html(await Members({ ...p(), ...sp() }));
    expect(out).toContain('Ana Pérez');
    expect(out).not.toContain('Suspend');
    expect(out).not.toContain('Remove');
    expect(out).not.toContain('name="role"');
    expect(out).not.toContain('Invited');
  });

  it('an admin manages others but not themselves and not owners; OWNER is not assignable', async () => {
    platform('ADMIN', ALL);
    const out = html(await Members({ ...p(), ...sp() }));
    const rows = out.split('<li ').slice(1);
    const self = rows.find((r) => r.includes('· you')) ?? '';
    const owner = rows.find((r) => r.includes('>Owner<')) ?? '';
    const ana = rows.find((r) => r.includes('Ana Pérez')) ?? '';
    expect(self).not.toContain('Suspend');
    expect(owner).not.toContain('Suspend');
    expect(ana).toContain('Suspend');
    expect(ana).toContain('Confirm removal');
    expect(ana).not.toContain('value="OWNER"');
  });

  it('an owner may assign OWNER', async () => {
    platform('OWNER', ALL);
    const out = html(await Members({ ...p(), ...sp() }));
    expect(out).toContain('value="OWNER"');
  });

  it('members without public athlete profiles are not named', async () => {
    platform('OWNER', ALL);
    const out = html(await Members({ ...p(), ...sp() }));
    expect(out).toContain('No public athlete profile');
    expect(out).not.toContain('p-own');
    expect(out).not.toContain('o@club.test');
  });
});

describe('invitations screen', () => {
  it('is a 404 for members without invite or private-view permissions', async () => {
    platform('ATHLETE', []);
    expect(await outcome(() => Invitations({ ...p(), ...sp() }))).toBe('404');
  });

  it('admins see pending invitations and the invite form with assignable roles', async () => {
    platform('ADMIN', ALL);
    const out = html(await Invitations({ ...p(), ...sp() }));
    expect(out).toContain('Luis');
    expect(out).toContain('Revoke');
    expect(out).toContain('data-invite-roles="ADMIN,STAFF,COACH,OFFICIAL,ATHLETE,MEMBER"');
  });
});

describe('profile screen', () => {
  it('editors get the form; plain members get a read-only preview', async () => {
    platform('OWNER', ALL);
    expect(html(await Profile({ ...p(), ...sp() }))).toContain('name="logoUrl"');
    platform('ATHLETE', []);
    const ro = html(await Profile({ ...p(), ...sp() }));
    expect(ro).not.toContain('<form');
    expect(ro).toContain('Only owners and admins can edit the profile');
  });
});

// ───────────────────────────── actions ─────────────────────────────

describe('organization actions call the canonical API', () => {
  it('profile save sends the patch; a 403 from the API surfaces as not_permitted', async () => {
    platform('ATHLETE', []);
    routes[`PATCH /v1/organizations/${ORG}/profile`] = () =>
      json(403, { error: { code: 'FORBIDDEN' } });
    const to = await outcome(() =>
      actions.updateProfileAction(
        form({
          slug: 'club-uno',
          displayName: 'Club Uno',
          sports: 'Padel, Tennis, Padel',
          accentColor: '#FF2DA4',
          country: 'cr',
          logoUrl: 'https://cdn.test/logo.png',
        }),
      ),
    );
    expect(to).toBe('/app/orgs/club-uno/profile?error=not_permitted');
    expect(writes()[0]).toMatchObject({
      method: 'PATCH',
      auth: 'Bearer tok',
      body: {
        displayName: 'Club Uno',
        sports: ['Padel', 'Tennis'],
        accentColor: '#ff2da4',
        country: 'CR',
        logoUrl: 'https://cdn.test/logo.png',
      },
    });
  });

  it('actions on an organization the caller does not belong to never reach a mutation', async () => {
    platform('OWNER', ALL);
    const to = await outcome(() =>
      actions.updateProfileAction(form({ slug: 'other-club', displayName: 'Hijack' })),
    );
    expect(to).toBe('/app');
    expect(writes()).toEqual([]);
  });

  it('invite: resolves a profile URL to its address and returns the one-time link', async () => {
    platform('OWNER', ALL);
    routes[`POST /v1/organizations/${ORG}/invitations`] = () =>
      json(201, { token: 'tok_abcdefghijklmnopqrstuvwxyz', expiresAt: '2026-10-13T00:00:00Z' });
    const state = await actions.inviteAction(
      { kind: 'idle', nextKey: 'oc-key-1' },
      form({
        slug: 'club-uno',
        key: 'oc-key-1',
        athleteSlug: 'https://app.onchainfest.test/athletes/Ana-Perez',
        role: 'ATHLETE',
        visibility: 'MEMBERS',
      }),
    );
    expect(state).toMatchObject({
      kind: 'ok',
      link: 'https://app.onchainfest.test/app/invitations?token=tok_abcdefghijklmnopqrstuvwxyz',
    });
    expect(writes()[0]).toMatchObject({
      key: 'oc-key-1',
      body: { athleteSlug: 'ana-perez', role: 'ATHLETE', visibility: 'MEMBERS' },
    });
  });

  it('invite: API errors map to fixed codes; replays never fabricate a link', async () => {
    platform('ATHLETE', []);
    routes[`POST /v1/organizations/${ORG}/invitations`] = () =>
      json(403, { error: { code: 'FORBIDDEN' } });
    const denied = await actions.inviteAction(
      { kind: 'idle', nextKey: 'k-12345678' },
      form({ slug: 'club-uno', athleteSlug: 'ana', role: 'ATHLETE', visibility: 'MEMBERS' }),
    );
    expect(denied).toMatchObject({ kind: 'error', error: 'not_permitted' });
    routes[`POST /v1/organizations/${ORG}/invitations`] = () =>
      json(200, { token: null, expiresAt: '2026-10-13T00:00:00Z' });
    const replay = await actions.inviteAction(
      { kind: 'idle', nextKey: 'k-12345678' },
      form({ slug: 'club-uno', athleteSlug: 'ana', role: 'ATHLETE', visibility: 'MEMBERS' }),
    );
    expect(replay.kind).toBe('error');
    expect(replay.link).toBeUndefined();
  });

  it('role change and revoke go to the membership routes', async () => {
    platform('OWNER', ALL);
    routes[`POST /v1/memberships/${M_OTHER}/role`] = () => json(200, {});
    routes[`PUT /v1/memberships/${M_OTHER}/status`] = () => json(200, {});
    expect(
      await outcome(() =>
        actions.changeRoleAction(
          form({ slug: 'club-uno', membershipId: M_OTHER, role: 'STAFF', key: 'oc-role-123' }),
        ),
      ),
    ).toBe('/app/orgs/club-uno/members?notice=role_changed');
    expect(
      await outcome(() =>
        actions.memberStatusAction(
          form({ slug: 'club-uno', from: 'invitations', membershipId: M_OTHER, status: 'ENDED' }),
        ),
      ),
    ).toBe('/app/orgs/club-uno/invitations?notice=invitation_revoked');
    expect(writes().map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST /v1/memberships/${M_OTHER}/role`,
      `PUT /v1/memberships/${M_OTHER}/status`,
    ]);
    // Invented roles never reach the API.
    expect(
      await outcome(() =>
        actions.changeRoleAction(
          form({ slug: 'club-uno', membershipId: M_OTHER, role: 'SPONSOR' }),
        ),
      ),
    ).toBe('/app/orgs/club-uno/members?error=profile_invalid');
    expect(writes()).toHaveLength(2);
  });

  it('leaving as the last owner reports last_owner', async () => {
    platform('OWNER', ALL);
    routes[`PUT /v1/memberships/${M_SELF}/status`] = () =>
      json(409, { error: { code: 'INVALID_TRANSITION' } });
    expect(await outcome(() => actions.leaveAction(form({ slug: 'club-uno' })))).toBe(
      '/app/orgs/club-uno/settings?error=last_owner',
    );
  });
});

// ───────────────────────────── invitee ─────────────────────────────

describe('invitee flow', () => {
  it('a valid token previews the organization; an invalid one shows the invalid state', async () => {
    platform('ATHLETE', []);
    routes['POST /v1/invitations/inspect'] = (c) =>
      (c.body as { token: string }).token === 'tok_validvalidvalidvalid'
        ? json(200, {
            role: 'ATHLETE',
            expiresAt: '2099-01-01T00:00:00Z',
            organization: { slug: 'club-uno', displayName: 'Club Uno', orgType: 'CLUB' },
          })
        : json(422, { error: { code: 'INVITATION_INVALID' } });
    const ok = html(await InvitationPage(sp({ token: 'tok_validvalidvalidvalid' })));
    expect(ok).toContain('Club Uno');
    expect(ok).toContain('Accept and join');
    const bad = html(await InvitationPage(sp({ token: 'tok_wrongwrongwrongwrong' })));
    expect(bad).toContain('Not valid');
    expect(bad).not.toContain('Accept and join');
  });

  it('accept and decline post the token to the canonical routes', async () => {
    platform('ATHLETE', []);
    routes['POST /v1/invitations/accept'] = () => json(200, { status: 'ACTIVE' });
    routes['POST /v1/invitations/decline'] = () => json(200, { status: 'DECLINED' });
    expect(
      await outcome(() =>
        invitationActions.acceptInvitationAction(
          form({ token: 'tok_validvalidvalidvalid', orgSlug: 'club-uno' }),
        ),
      ),
    ).toBe('/app/orgs/club-uno?notice=joined');
    expect(
      await outcome(() =>
        invitationActions.declineInvitationAction(form({ token: 'tok_validvalidvalidvalid' })),
      ),
    ).toBe('/app?notice=invitation_declined');
    expect(writes().map((c) => c.path)).toEqual([
      '/v1/invitations/accept',
      '/v1/invitations/decline',
    ]);
    expect(
      await outcome(() => invitationActions.acceptInvitationAction(form({ token: 'x' }))),
    ).toBe('/app/invitations?error=invitation_invalid');
  });
});

// ───────────────────────────── public page ─────────────────────────────

describe('public organization page', () => {
  it('uses only public endpoints, without credentials, and shows no member data', async () => {
    platform('OWNER', ALL);
    const out = html(await PublicOrg(p()));
    expect(out).toContain('Club Uno');
    expect(out).toContain('Padel');
    expect(out).toContain('href="/athletes/ana"');
    expect(out).toContain('not make an organization a recognized sporting authority');
    expect(calls.map((c) => c.path)).toEqual([
      '/v1/organizations/club-uno',
      '/v1/organizations/club-uno/competitions',
    ]);
    expect(calls.every((c) => c.auth === undefined)).toBe(true);
    expect(out).not.toContain(M_OWNER2);
  });
});
