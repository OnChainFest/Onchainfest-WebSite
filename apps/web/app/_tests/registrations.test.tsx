import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ONCF-04 athlete registration and organizer registration management, rendered and exercised
// against a fake session + fake platform API. The API stays the authority: these tests prove the
// web layer shows what it reports (status, actions, privacy) and sends the canonical commands.

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

const PublicEventPage = (await import('../(explorer)/competitions/[slug]/events/[eventSlug]/page'))
  .default;
const PublicCompetitionPage = (await import('../(explorer)/competitions/[slug]/page')).default;
const Register = (await import('../app/register/[slug]/[eventSlug]/page')).default;
const Result = (await import('../app/registrations/[registrationId]/page')).default;
const History = (await import('../app/registrations/page')).default;
const Hub = (await import('../app/orgs/[slug]/tournaments/[competitionId]/registrations/page'))
  .default;
const Detail = (
  await import('../app/orgs/[slug]/tournaments/[competitionId]/registrations/[registrationId]/page')
).default;
const athleteActions = await import('../app/register/actions');
const orgActions =
  await import('../app/orgs/[slug]/tournaments/[competitionId]/registrations/actions');
const onboardingActions = await import('../app/onboarding/actions');
const lib = await import('../_lib/registrations');
const policy = await import('../_lib/auth/route-policy');
const continuation = await import('../_lib/auth/continuation');

// ───────────────────────────── fake platform ─────────────────────────────

const ORG = '0b9b4b8e-6f0a-4f3e-9d6a-1c2b3c4d5e6f';
const COMP = '22222222-2222-4222-8222-222222222222';
const OTHER_COMP = '29999999-2222-4222-8222-222222222222';
const EVENT = '33333333-3333-4333-8333-333333333333';
const EVENT_2 = '34333333-3333-4333-8333-333333333333';
const ATHLETE = '66666666-6666-4666-8666-666666666666';
const KID = '67666666-6666-4666-8666-666666666666';
const REG = '77777777-7777-4777-8777-777777777777';
const REG_PRIVATE = '78777777-7777-4777-8777-777777777777';

function publicEvent(
  o: Partial<{
    status: string;
    entrantKind: string;
    opensAt: string | null;
    closesAt: string | null;
    competitionStatus: string;
  }> = {},
) {
  return {
    competition: {
      id: COMP,
      slug: 'autumn-open',
      name: 'Autumn Open',
      status: o.competitionStatus ?? 'PUBLISHED',
    },
    event: {
      id: EVENT,
      slug: 'men-singles',
      name: 'Men Singles',
      status: o.status ?? 'REGISTRATION_OPEN',
      entrantKind: (o.entrantKind ?? 'INDIVIDUAL') as 'INDIVIDUAL' | 'TEAM',
      sport: { code: 'tennis', name: 'Tennis' },
      discipline: { code: 'tennis.singles', name: 'Tennis singles', version: 1 },
      format: {
        code: 'single-elimination',
        name: 'Single elimination',
        version: 1,
        engine: 'se/1',
      },
      category: { genderCategory: 'MEN', skillClass: 'A' },
      capacity: 16,
      confirmedCount: 4,
      waitlistCount: 0,
      participantCount: 0,
      registration: {
        opensAt: o.opensAt === undefined ? '2026-01-01T00:00:00.000Z' : o.opensAt,
        closesAt: o.closesAt === undefined ? '2099-01-01T00:00:00.000Z' : o.closesAt,
      },
      startsAt: '2099-11-14T14:00:00.000Z',
      endsAt: '2099-11-16T02:00:00.000Z',
      timezone: 'America/Costa_Rica',
    },
    field: { locked: false, fieldHash: null },
    seeding: null,
    plan: null,
    canonical: { competitionSlug: 'autumn-open', eventSlug: 'men-singles' },
    redirected: false,
  };
}

function publicCompetition(ev = publicEvent()) {
  return {
    competition: {
      id: COMP,
      slug: 'autumn-open',
      name: 'Autumn Open',
      description: null,
      status: ev.competition.status,
      timezone: 'America/Costa_Rica',
      startsAt: '2099-11-14T14:00:00.000Z',
      endsAt: '2099-11-16T02:00:00.000Z',
      locationLabel: 'Club Uno courts',
      organizer: { organizationId: ORG, slug: 'club-uno', displayName: 'Club Uno' },
    },
    events: [ev.event],
    canonicalSlug: 'autumn-open',
    redirected: false,
  };
}

type RegOverrides = Partial<{
  id: string;
  status: string;
  athlete: { slug: string; displayName: string } | null;
  athleteId: string;
  actions: { decisions: string[]; withdraw: boolean };
  reason: string | null;
  eventId: string;
  eventStatus: string;
  competitionId: string;
  entrant: boolean;
  staff: boolean;
}>;

function registration(o: RegOverrides = {}) {
  const status = o.status ?? 'REQUESTED';
  return {
    id: o.id ?? REG,
    status,
    entrantType: 'INDIVIDUAL',
    athleteId: o.athleteId ?? ATHLETE,
    athlete: o.athlete === undefined ? { slug: 'ana-rojas', displayName: 'Ana Rojas' } : o.athlete,
    team: null,
    eligibilityBasis: status === 'CONFIRMED' ? 'ORGANIZER_ACCEPTED' : null,
    reason: o.reason ?? null,
    requestedAt: '2026-10-01T15:00:00.000Z',
    statusChangedAt: '2026-10-02T15:00:00.000Z',
    event: {
      id: o.eventId ?? EVENT,
      slug: 'men-singles',
      name: 'Men Singles',
      status: o.eventStatus ?? 'REGISTRATION_OPEN',
      entrantKind: 'INDIVIDUAL',
      sport: { code: 'tennis', name: 'Tennis' },
      discipline: { code: 'tennis.singles', name: 'Tennis singles' },
      format: { code: 'single-elimination', name: 'Single elimination' },
      capacity: 16,
      registrationMode: 'ORGANIZER_APPROVAL',
      registrationClosesAt: null,
      startsAt: '2099-11-14T14:00:00.000Z',
      endsAt: '2099-11-16T02:00:00.000Z',
      timezone: 'America/Costa_Rica',
    },
    competition: {
      id: o.competitionId ?? COMP,
      slug: 'autumn-open',
      name: 'Autumn Open',
      status: 'PUBLISHED',
      startsAt: null,
      endsAt: null,
      timezone: 'America/Costa_Rica',
      locationLabel: 'Club Uno courts',
    },
    actions: o.actions ?? { decisions: [], withdraw: true },
    history: [
      { status: 'REQUESTED', reason: null, recordedAt: '2026-10-01T15:00:00.000Z' },
      ...(status === 'REQUESTED'
        ? []
        : [{ status, reason: o.reason ?? null, recordedAt: '2026-10-02T15:00:00.000Z' }]),
    ],
    viewer: { entrant: o.entrant ?? true, staff: o.staff ?? false },
  };
}

function managedEvent(id: string, name: string, status = 'REGISTRATION_OPEN') {
  return {
    id,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    status,
    entrantKind: 'INDIVIDUAL',
    discipline: {
      versionId: 'dv',
      sport: { code: 'tennis', name: 'Tennis' },
      code: 'tennis.singles',
      name: 'Tennis singles',
      version: 1,
    },
    format: { versionId: 'fv', code: 'se', name: 'Single elimination', version: 1, engine: 'se/1' },
    formatConfig: {},
    settings: {
      name,
      category: {},
      capacity: 1,
      registrationMode: 'ORGANIZER_APPROVAL',
      registrationOpensAt: null,
      registrationClosesAt: null,
      startsAt: null,
      endsAt: null,
      timezone: 'America/Costa_Rica',
    },
    counts: { confirmed: 1, waitlisted: 0, participants: 0 },
    editable: { settings: true, capacityAndRegistrationMode: false },
    nextStatuses: ['REGISTRATION_CLOSED', 'CANCELLED'],
    createdAt: '2026-10-06T00:00:00Z',
    updatedAt: '2026-10-06T00:00:00Z',
    statusChangedAt: '2026-10-06T00:00:00Z',
  };
}

function managed(organizer = ORG) {
  return {
    competition: {
      id: COMP,
      slug: 'autumn-open',
      organizerOrganizationId: organizer,
      status: 'PUBLISHED',
      profile: {
        name: 'Autumn Open',
        description: null,
        locationLabel: 'Club Uno courts',
        regionCode: 'CR',
        timezone: 'America/Costa_Rica',
        startsAt: null,
        endsAt: null,
        website: null,
      },
      editable: { profile: true, addEvents: true },
      nextStatuses: ['ACTIVE', 'CANCELLED'],
      createdAt: '2026-10-06T00:00:00Z',
      updatedAt: '2026-10-06T00:00:00Z',
      statusChangedAt: '2026-10-06T00:00:00Z',
    },
    events: [managedEvent(EVENT, 'Men Singles'), managedEvent(EVENT_2, 'Women Singles')],
    access: {
      staffRoles: ['OWNER'],
      permissions: ['COMP_VIEW_PRIVATE', 'COMP_MANAGE_REGISTRATIONS'],
    },
  };
}

const COUNTS = {
  REQUESTED: 1,
  WAITLISTED: 0,
  CONFIRMED: 1,
  DECLINED: 0,
  WITHDRAWN: 0,
  CANCELLED: 0,
};

interface Call {
  method: string;
  path: string;
  query: string;
  auth: string | undefined;
  body: unknown;
  key: string | undefined;
}
let calls: Call[] = [];
let routes: Record<string, (c: Call) => Response> = {};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const refused = (status: number, code: string) => () => json(status, { error: { code } });

function platform(
  o: {
    athletes?: { athleteId: string; personId: string; slug: string }[];
    mine?: unknown[];
    event?: ReturnType<typeof publicEvent>;
  } = {},
) {
  const ev = o.event ?? publicEvent();
  routes = {
    'GET /v1/me': () =>
      json(200, {
        accountId: 'acc',
        accountActive: true,
        selfPersonId: 'p-self',
        athletes: o.athletes ?? [{ athleteId: ATHLETE, personId: 'p-self', slug: 'ana-rojas' }],
        guardianRelationships: [],
      }),
    'GET /v1/me/organizations': () =>
      json(200, {
        items: [
          {
            membershipId: '11111111-1111-4111-8111-111111111111',
            organizationId: ORG,
            role: 'OWNER',
            orgType: 'CLUB',
            slug: 'club-uno',
            displayName: 'Club Uno',
          },
        ],
      }),
    [`GET /v1/organizations/${ORG}/permissions`]: () =>
      json(200, { roles: ['OWNER'], permissions: ['ORG_MANAGE_COMPETITIONS', 'ORG_VIEW_PRIVATE'] }),
    'GET /v1/organizations/club-uno': () =>
      json(200, {
        organization: {
          organizationId: ORG,
          slug: 'club-uno',
          orgType: 'CLUB',
          status: 'ACTIVE',
          profile: {
            displayName: 'Club Uno',
            description: null,
            website: null,
            country: 'CR',
            region: null,
            publicContact: null,
            logoUrl: null,
            accentColor: '#ff2da4',
            sports: [],
            provenance: 'SELF_DECLARED',
          },
          authority: { status: 'NOT_AVAILABLE', reason: 'SOURCE_NOT_IMPLEMENTED' },
        },
        affiliations: { status: 'AVAILABLE', items: [] },
        canonicalSlug: 'club-uno',
        redirected: false,
      }),
    'GET /v1/competitions/autumn-open': () => json(200, publicCompetition(ev)),
    'GET /v1/competitions/autumn-open/events/men-singles': () => json(200, ev),
    'GET /v1/competitions/autumn-open/events/men-singles/participants': () =>
      json(200, { items: [] }),
    'GET /v1/competitions/autumn-open/events/men-singles/schedule': () => json(200, { items: [] }),
    'GET /v1/competitions/autumn-open/events/men-singles/bracket': () => json(200, { rounds: [] }),
    'GET /v1/me/registrations': () => json(200, { items: o.mine ?? [] }),
    [`GET /v1/registrations/${REG}`]: () => json(200, registration()),
    [`GET /v1/competitions/${COMP}/manage`]: () => json(200, managed()),
    [`GET /v1/competitions/${COMP}/registrations`]: () =>
      json(200, {
        items: [
          registration({
            status: 'REQUESTED',
            actions: { decisions: ['CONFIRM', 'WAITLIST', 'DECLINE'], withdraw: true },
            entrant: false,
            staff: true,
          }),
          registration({
            id: REG_PRIVATE,
            status: 'CONFIRMED',
            athlete: null,
            athleteId: KID,
            actions: { decisions: ['CANCEL'], withdraw: true },
          }),
        ],
        counts: COUNTS,
        nextCursor: null,
        access: { permissions: ['COMP_MANAGE_REGISTRATIONS', 'COMP_VIEW_PRIVATE'] },
      }),
  };
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefghijklmnop.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.NEXT_PUBLIC_SITE_URL = 'https://app.onchainfest.test';
  h.auth.getClaims.mockResolvedValue({
    data: { claims: { sub: 'u', role: 'authenticated', email: 'ana@club.test' } },
    error: null,
  });
  h.auth.getSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } });
  calls = [];
  platform();
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const c: Call = {
      method: init.method ?? 'GET',
      path: u.pathname,
      query: u.search,
      auth: headers.authorization,
      key: headers['idempotency-key'],
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(c);
    const r = routes[`${c.method} ${c.path}`];
    return Promise.resolve(r === undefined ? json(404, {}) : r(c));
  });
});

const html = (el: ReactElement | null) => (el === null ? '' : renderToStaticMarkup(el));
const sp = (q: Record<string, string> = {}) => ({ searchParams: Promise.resolve(q) });
const reg = (q: Record<string, string> = {}) => ({
  params: Promise.resolve({ slug: 'autumn-open', eventSlug: 'men-singles' }),
  ...sp(q),
});
const hub = (q: Record<string, string> = {}, competitionId = COMP) => ({
  params: Promise.resolve({ slug: 'club-uno', competitionId }),
  ...sp(q),
});
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
const REGISTER = '/app/register/autumn-open/men-singles';

// ───────────────────────────── public entry point ─────────────────────────────

describe('registration call-to-action', () => {
  const now = new Date('2026-10-06T12:00:00Z');
  const ev = (o: Parameters<typeof publicEvent>[0] = {}) => publicEvent(o).event;

  it('follows the public lifecycle status and window', () => {
    expect(lib.registrationCta(ev(), 'PUBLISHED', now).kind).toBe('open');
    expect(lib.registrationCta(ev({ opensAt: '2026-12-01T00:00:00Z' }), 'PUBLISHED', now)).toEqual({
      kind: 'opens',
      at: '2026-12-01T00:00:00Z',
    });
    expect(
      lib.registrationCta(ev({ closesAt: '2026-10-01T00:00:00Z' }), 'PUBLISHED', now).kind,
    ).toBe('closed');
    expect(lib.registrationCta(ev({ status: 'REGISTRATION_CLOSED' }), 'PUBLISHED', now).kind).toBe(
      'closed',
    );
    expect(lib.registrationCta(ev({ status: 'DRAFT' }), 'PUBLISHED', now).kind).toBe('not_open');
    expect(lib.registrationCta(ev({ status: 'FIELD_LOCKED' }), 'PUBLISHED', now).kind).toBe(
      'locked',
    );
    expect(lib.registrationCta(ev({ status: 'COMPLETED' }), 'COMPLETED', now).kind).toBe(
      'completed',
    );
    expect(lib.registrationCta(ev({ status: 'CANCELLED' }), 'PUBLISHED', now).kind).toBe(
      'cancelled',
    );
    expect(lib.registrationCta(ev(), 'CANCELLED', now).kind).toBe('cancelled');
    // ONCF-05B: team categories are entered by a team the caller manages.
    expect(lib.registrationCta(ev({ entrantKind: 'TEAM' }), 'PUBLISHED', now).kind).toBe('open');
  });

  it('the public category page links to the registration flow only while open', async () => {
    const open = html(
      await PublicEventPage({
        params: Promise.resolve({ slug: 'autumn-open', eventSlug: 'men-singles' }),
      }),
    );
    expect(open).toContain(`href="${REGISTER}"`);
    expect(open).toContain('Registration open');

    platform({ event: publicEvent({ status: 'REGISTRATION_CLOSED' }) });
    const closed = html(
      await PublicEventPage({
        params: Promise.resolve({ slug: 'autumn-open', eventSlug: 'men-singles' }),
      }),
    );
    expect(closed).not.toContain(REGISTER);
    expect(closed).toContain('Registration closed');

    platform({ event: publicEvent({ status: 'CANCELLED' }) });
    const cancelled = html(
      await PublicEventPage({
        params: Promise.resolve({ slug: 'autumn-open', eventSlug: 'men-singles' }),
      }),
    );
    expect(cancelled).not.toContain(REGISTER);
    expect(cancelled).toContain('Cancelled');
  });

  it('the public tournament page offers Register per open category', async () => {
    const page = html(
      await PublicCompetitionPage({ params: Promise.resolve({ slug: 'autumn-open' }) }),
    );
    expect(page).toContain(`href="${REGISTER}"`);
    platform({ event: publicEvent({ status: 'REGISTRATION_CLOSED' }) });
    const closed = html(
      await PublicCompetitionPage({ params: Promise.resolve({ slug: 'autumn-open' }) }),
    );
    expect(closed).not.toContain(REGISTER);
  });

  it('signed-out visitors go through sign-in and come back (safe continuation)', () => {
    expect(policy.routeAccess(REGISTER)).toBe('protected');
    const to = policy.signInRedirectPath(REGISTER, '');
    expect(to).toBe('/signin?next=%2Fapp%2Fregister%2Fautumn-open%2Fmen-singles');
    expect(continuation.validateContinuationRoute(REGISTER)).toBe(REGISTER);
    expect(continuation.validateContinuationRoute('//evil.example/app/register/x/y')).toBeNull();
    expect(continuation.validateContinuationRoute('/app/../api/x')).toBeNull();
  });
});

// ───────────────────────────── athlete registration ─────────────────────────────

describe('athlete registration page', () => {
  it('shows the tournament and asks who is entering', async () => {
    platform({
      athletes: [
        { athleteId: ATHLETE, personId: 'p-self', slug: 'ana-rojas' },
        { athleteId: KID, personId: 'p-kid', slug: 'leo-rojas' },
      ],
    });
    const page = html(await Register(reg()));
    expect(page).toContain('Men Singles');
    expect(page).toContain('Autumn Open');
    expect(page).toContain('Tennis singles');
    expect(page).toContain('4 of 16 confirmed');
    expect(page).toContain('Club Uno');
    expect(page).toContain('--brand:#ff2da4');
    expect(page).toContain('@ana-rojas');
    expect(page).toContain('@leo-rojas');
    expect(page).toContain('Athlete you manage');
    expect(page).toContain('Review entry');
    expect(page).not.toContain('Confirm registration');
  });

  it('the review lists tournament, category, participant and dates, and requires the eligibility declaration', async () => {
    const page = html(await Register(reg({ step: 'review', athlete: ATHLETE })));
    expect(page).toContain('Review your entry');
    expect(page).toContain('@ana-rojas');
    expect(page).toContain('Confirm registration');
    expect(page).toMatch(/<input type="checkbox" required="" name="eligibility"/);
    expect(page).toContain(`name="eventId" value="${EVENT}"`);
    expect(page).toMatch(/name="key" value="oc-reg-[0-9a-f-]{36}"/);
    expect(page).toContain('Men · A');
  });

  it('an athlete already entered sees the existing entry instead of a second form', async () => {
    platform({ mine: [registration({ status: 'WAITLISTED' })] });
    const page = html(await Register(reg({ step: 'review', athlete: ATHLETE })));
    expect(page).toContain('Already entered');
    expect(page).toContain(`href="/app/registrations/${REG}"`);
    expect(page).not.toContain('Confirm registration');
  });

  it('without an athlete profile, sends the user through onboarding and back', async () => {
    platform({ athletes: [] });
    const page = html(await Register(reg()));
    expect(page).toContain(
      `/app/onboarding?path=athlete&amp;add=1&amp;next=${encodeURIComponent(REGISTER)}`,
    );
    expect(page).not.toContain('Review entry');
  });

  it('offers no registration when the category is closed, cancelled or not yet open', async () => {
    for (const [ev, text] of [
      [publicEvent({ status: 'REGISTRATION_CLOSED' }), 'Registration closed'],
      [publicEvent({ status: 'CANCELLED' }), 'cancelled by the organizer'],
      [publicEvent({ opensAt: '2099-01-01T00:00:00.000Z', closesAt: null }), 'Entries open'],
    ] as const) {
      platform({ event: ev });
      const page = html(await Register(reg({ step: 'review', athlete: ATHLETE })));
      expect(page).toContain(text);
      expect(page).not.toContain('Confirm registration');
      expect(page).not.toContain('Review entry');
    }
  });

  it('an unknown tournament or category is a 404', async () => {
    routes['GET /v1/competitions/autumn-open/events/men-singles'] = () => json(404, {});
    expect(await outcome(() => Register(reg()))).toBe('404');
  });
});

describe('registerAction', () => {
  const submit = (extra: Record<string, string> = {}) =>
    form({
      competitionSlug: 'autumn-open',
      eventSlug: 'men-singles',
      eventId: EVENT,
      athleteId: ATHLETE,
      eligibility: 'yes',
      key: 'oc-reg-11111111-2222-4333-8444-555555555555',
      ...extra,
    });

  it('submits the canonical registration with the form’s idempotency key and shows the result', async () => {
    routes[`POST /v1/events/${EVENT}/registrations`] = () =>
      json(201, { registrationId: REG, status: 'REQUESTED', created: true });
    expect(await outcome(() => athleteActions.registerAction(submit()))).toBe(
      `/app/registrations/${REG}?notice=registration_received`,
    );
    expect(writes()).toEqual([
      expect.objectContaining({
        path: `/v1/events/${EVENT}/registrations`,
        auth: 'Bearer tok',
        key: 'oc-reg-11111111-2222-4333-8444-555555555555',
        body: { athleteId: ATHLETE, eligibilityDeclared: true },
      }),
    ]);
  });

  it('a double submit reuses the same key, so the API returns the same registration', async () => {
    routes[`POST /v1/events/${EVENT}/registrations`] = (c) =>
      json(c.key === 'oc-reg-11111111-2222-4333-8444-555555555555' ? 200 : 201, {
        registrationId: REG,
        status: 'REQUESTED',
        created: false,
      });
    await outcome(() => athleteActions.registerAction(submit()));
    await outcome(() => athleteActions.registerAction(submit()));
    expect(new Set(writes().map((c) => c.key)).size).toBe(1);
  });

  it('maps the API refusals to the registration vocabulary', async () => {
    const review = `${REGISTER}?step=review&athlete=${ATHLETE}`;
    for (const [status, code, msg] of [
      [409, 'ALREADY_EXISTS', 'registration_duplicate'],
      [409, 'INVALID_TRANSITION', 'registration_closed'],
      [409, 'CAPACITY_REACHED', 'registration_full'],
      [400, 'INVALID_INPUT', 'registration_invalid'],
      [403, 'FORBIDDEN', 'registration_not_permitted'],
      [404, 'NOT_FOUND', 'tournament_not_found'],
    ] as const) {
      routes[`POST /v1/events/${EVENT}/registrations`] = refused(status, code);
      expect(await outcome(() => athleteActions.registerAction(submit()))).toBe(
        `${review}&error=${msg}`,
      );
    }
    routes[`POST /v1/events/${EVENT}/registrations`] = () => json(503, {});
    expect(await outcome(() => athleteActions.registerAction(submit()))).toBe(
      `${review}&error=platform_unavailable`,
    );
  });

  it('requires the eligibility declaration and well-formed ids before calling the API', async () => {
    expect(await outcome(() => athleteActions.registerAction(submit({ eligibility: '' })))).toBe(
      `${REGISTER}?step=review&athlete=${ATHLETE}&error=eligibility_required`,
    );
    expect(await outcome(() => athleteActions.registerAction(submit({ athleteId: 'x' })))).toBe(
      `${REGISTER}?error=missing_fields`,
    );
    expect(
      await outcome(() => athleteActions.registerAction(submit({ competitionSlug: '//evil' }))),
    ).toBe('/app/registrations');
    expect(writes()).toEqual([]);
  });

  it('an expired session goes back through sign-in to the review', async () => {
    h.auth.getClaims.mockResolvedValue({ data: null, error: new Error('expired') });
    expect(await outcome(() => athleteActions.registerAction(submit()))).toBe(
      `/signin?error=session_expired&next=${encodeURIComponent(`${REGISTER}?step=review&athlete=${ATHLETE}`)}`,
    );
    expect(writes()).toEqual([]);
  });
});

describe('registration result and history', () => {
  it('shows the persisted status from the API on every load', async () => {
    const page = html(await Result({ params: Promise.resolve({ registrationId: REG }), ...sp() }));
    expect(page).toContain('Pending review');
    expect(page).toContain('Men Singles');
    expect(page).toContain('Ref #77777777');
    expect(page).toContain('Withdraw entry');
    routes[`GET /v1/registrations/${REG}`] = () =>
      json(
        200,
        registration({
          status: 'DECLINED',
          reason: 'Category is full',
          actions: { decisions: [], withdraw: false },
        }),
      );
    const later = html(await Result({ params: Promise.resolve({ registrationId: REG }), ...sp() }));
    expect(later).toContain('Declined');
    expect(later).toContain('Category is full');
    expect(later).not.toContain('Withdraw entry');
  });

  it('someone else’s registration (API 403 / not the entrant) is a 404', async () => {
    routes[`GET /v1/registrations/${REG}`] = refused(403, 'FORBIDDEN');
    expect(
      await outcome(() => Result({ params: Promise.resolve({ registrationId: REG }), ...sp() })),
    ).toBe('404');
    routes[`GET /v1/registrations/${REG}`] = () =>
      json(200, registration({ entrant: false, staff: true }));
    expect(
      await outcome(() => Result({ params: Promise.resolve({ registrationId: REG }), ...sp() })),
    ).toBe('404');
    expect(
      await outcome(() => Result({ params: Promise.resolve({ registrationId: 'nope' }), ...sp() })),
    ).toBe('404');
  });

  it('groups the athlete’s entries by real status', async () => {
    platform({
      mine: [
        registration({ id: 'a1', status: 'REQUESTED' }),
        registration({ id: 'a2', status: 'CONFIRMED' }),
        registration({ id: 'a3', status: 'CONFIRMED', eventStatus: 'COMPLETED' }),
        registration({ id: 'a4', status: 'DECLINED' }),
      ],
    });
    const page = html(await History(sp()));
    expect(page).toMatch(/Pending.*Upcoming.*Completed.*Other statuses/s);
    expect(page).toContain('href="/app/registrations/a1"');
    const groups = lib.groupRegistrations([
      registration({ status: 'WAITLISTED' }),
      registration({ status: 'CONFIRMED', eventStatus: 'CANCELLED' }),
    ] as never);
    expect(groups.pending).toHaveLength(1);
    expect(groups.closed).toHaveLength(1);
  });

  it('an athlete with no entries gets an empty state', async () => {
    const page = html(await History(sp()));
    expect(page).toContain('No entries yet');
  });

  it('withdraws through the canonical command with an idempotency key', async () => {
    routes[`POST /v1/registrations/${REG}/withdraw`] = () =>
      json(200, { registrationId: REG, status: 'WITHDRAWN', promotedRegistrationId: null });
    expect(
      await outcome(() =>
        athleteActions.withdrawRegistrationAction(
          form({ registrationId: REG, key: 'oc-wd-123456789' }),
        ),
      ),
    ).toBe(`/app/registrations/${REG}?notice=registration_withdrawn`);
    expect(writes()[0]).toMatchObject({ key: 'oc-wd-123456789', body: undefined });
    routes[`POST /v1/registrations/${REG}/withdraw`] = refused(409, 'INVALID_TRANSITION');
    expect(
      await outcome(() => athleteActions.withdrawRegistrationAction(form({ registrationId: REG }))),
    ).toBe(`/app/registrations/${REG}?error=registration_transition`);
  });
});

describe('onboarding continuation', () => {
  it('returns to the registration after the athlete profile is created; foreign targets are ignored', async () => {
    routes['POST /v1/athletes'] = () => json(201, { athleteId: ATHLETE, slug: 'ana-rojas' });
    const base = {
      displayName: 'Ana Rojas',
      personKey: 'oc-person-12345678',
      profileKey: 'oc-profile-12345678',
    };
    expect(
      await outcome(() =>
        onboardingActions.createAthleteProfileAction(form({ ...base, next: REGISTER })),
      ),
    ).toBe(`${REGISTER}?notice=athlete_created`);
    expect(
      await outcome(() =>
        onboardingActions.createAthleteProfileAction(
          form({ ...base, next: 'https://evil.example' }),
        ),
      ),
    ).toBe('/app?notice=athlete_created');
    expect(
      await outcome(() =>
        onboardingActions.createAthleteProfileAction(
          form({ ...base, displayName: '', next: REGISTER }),
        ),
      ),
    ).toBe(
      `/app/onboarding?path=athlete&error=missing_fields&next=${encodeURIComponent(REGISTER)}`,
    );
  });
});

// ───────────────────────────── organizer management ─────────────────────────────

describe('organizer registration console', () => {
  it('lists entries with status, counts and the API’s decisions; private athletes stay unnamed', async () => {
    const page = html(await Hub(hub()));
    expect(page).toContain('Registrations');
    expect(page).toContain('Ana Rojas');
    expect(page).toContain('Private athlete');
    expect(page).toContain('Profile not public');
    expect(page).not.toContain(KID);
    // Row 1 (REQUESTED): confirm / waitlist / decline; row 2 (CONFIRMED): cancel + withdraw only.
    expect(page.match(/name="command" value="CONFIRM"/g)).toHaveLength(1);
    expect(page.match(/name="command" value="WAITLIST"/g)).toHaveLength(1);
    expect(page.match(/name="command" value="DECLINE"/g)).toHaveLength(1);
    expect(page.match(/name="command" value="CANCEL"/g)).toHaveLength(1);
    expect(page.match(/name="command" value="WITHDRAW"/g)).toHaveLength(2);
    expect(page).toContain('Women Singles');
    expect(page).toMatch(/Pending review<\/span><strong>1</);
  });

  it('forwards only well-formed filters to the API (server-side filtering)', async () => {
    await Hub(hub({ category: EVENT, status: 'WAITLISTED', after: REG }));
    const list = calls.find((c) => c.path === `/v1/competitions/${COMP}/registrations`);
    expect(new URLSearchParams(list?.query)).toEqual(
      new URLSearchParams({ eventId: EVENT, status: 'WAITLISTED', after: REG, limit: '50' }),
    );
    calls = [];
    await Hub(hub({ category: 'x', status: 'PENDING', after: "'; drop" }));
    const plain = calls.find((c) => c.path === `/v1/competitions/${COMP}/registrations`);
    expect(new URLSearchParams(plain?.query)).toEqual(new URLSearchParams({ limit: '50' }));
  });

  it('shows no decision forms when the API offers none (view-only staff, frozen entries)', async () => {
    routes[`GET /v1/competitions/${COMP}/registrations`] = () =>
      json(200, {
        items: [registration({ actions: { decisions: [], withdraw: false } })],
        counts: COUNTS,
        nextCursor: null,
        access: { permissions: ['COMP_VIEW_PRIVATE'] },
      });
    const page = html(await Hub(hub()));
    expect(page).not.toContain('name="command"');
    expect(page).toContain('can view entries but not decide');
  });

  it('empty states', async () => {
    routes[`GET /v1/competitions/${COMP}/registrations`] = () =>
      json(200, {
        items: [],
        counts: { ...COUNTS, REQUESTED: 0, CONFIRMED: 0 },
        nextCursor: null,
        access: { permissions: [] },
      });
    expect(html(await Hub(hub()))).toContain('No registrations yet');
  });

  it('another organization’s tournament, or a list the API refuses, is a 404', async () => {
    routes[`GET /v1/competitions/${COMP}/manage`] = () =>
      json(200, managed('ffffffff-6f0a-4f3e-9d6a-1c2b3c4d5e6f'));
    expect(await outcome(() => Hub(hub()))).toBe('404');
    expect(calls.some((c) => c.path.endsWith('/registrations'))).toBe(false);
    platform();
    routes[`GET /v1/competitions/${COMP}/registrations`] = refused(403, 'FORBIDDEN');
    expect(await outcome(() => Hub(hub()))).toBe('404');
    platform();
    routes[`GET /v1/competitions/${COMP}/manage`] = refused(403, 'FORBIDDEN');
    expect(await outcome(() => Hub(hub()))).toBe('404');
  });

  it('a non-member of the organization gets a 404', async () => {
    expect(
      await outcome(() =>
        Hub({ params: Promise.resolve({ slug: 'other-club', competitionId: COMP }), ...sp() }),
      ),
    ).toBe('404');
  });

  it('the detail page shows history and decisions; a registration of another tournament is a 404', async () => {
    routes[`GET /v1/registrations/${REG}`] = () =>
      json(
        200,
        registration({
          status: 'WAITLISTED',
          entrant: false,
          staff: true,
          actions: { decisions: ['CONFIRM', 'DECLINE'], withdraw: true },
        }),
      );
    const page = html(
      await Detail({
        params: Promise.resolve({ slug: 'club-uno', competitionId: COMP, registrationId: REG }),
        ...sp(),
      }),
    );
    expect(page).toContain('Waitlisted');
    expect(page).toContain('History');
    expect(page).toContain('name="return" value="detail"');
    expect(page).toContain('at capacity');
    routes[`GET /v1/registrations/${REG}`] = () =>
      json(200, registration({ competitionId: OTHER_COMP, entrant: false, staff: true }));
    expect(
      await outcome(() =>
        Detail({
          params: Promise.resolve({ slug: 'club-uno', competitionId: COMP, registrationId: REG }),
          ...sp(),
        }),
      ),
    ).toBe('404');
  });
});

describe('registrationDecisionAction', () => {
  const decide = (extra: Record<string, string>) =>
    orgActions.registrationDecisionAction(
      form({
        slug: 'club-uno',
        competitionId: COMP,
        registrationId: REG,
        key: 'oc-dec-123456789',
        ...extra,
      }),
    );
  const HUB = `/app/orgs/club-uno/tournaments/${COMP}/registrations`;

  it('sends each supported decision to the canonical command, with the reason when given', async () => {
    routes[`POST /v1/registrations/${REG}/decision`] = (c) =>
      json(200, { registrationId: REG, status: 'X', body: c.body });
    for (const [command, notice] of [
      ['CONFIRM', 'registration_confirmed'],
      ['WAITLIST', 'registration_waitlisted'],
      ['DECLINE', 'registration_declined'],
      ['CANCEL', 'registration_cancelled'],
    ] as const) {
      expect(
        await outcome(() => decide({ command, reason: command === 'DECLINE' ? ' Full ' : '' })),
      ).toBe(`${HUB}?notice=${notice}`);
    }
    expect(writes().map((c) => c.body)).toEqual([
      { decision: 'CONFIRM' },
      { decision: 'WAITLIST' },
      { decision: 'DECLINE', reason: 'Full' },
      { decision: 'CANCEL' },
    ]);
    expect(writes().every((c) => c.key === 'oc-dec-123456789')).toBe(true);
  });

  it('withdraws through the withdraw command (no reason), and keeps the list filters', async () => {
    routes[`POST /v1/registrations/${REG}/withdraw`] = () => json(200, {});
    expect(
      await outcome(() =>
        decide({ command: 'WITHDRAW', reason: 'ignored', category: EVENT, status: 'CONFIRMED' }),
      ),
    ).toBe(`${HUB}?category=${EVENT}&status=CONFIRMED&notice=registration_withdrawn`);
    expect(writes()[0]).toMatchObject({
      path: `/v1/registrations/${REG}/withdraw`,
      body: undefined,
    });
  });

  it('maps refusals: invalid transition, capacity, permission, unknown registration', async () => {
    for (const [status, code, msg] of [
      [409, 'INVALID_TRANSITION', 'registration_transition'],
      [409, 'CAPACITY_REACHED', 'registration_full'],
      [403, 'FORBIDDEN', 'not_permitted'],
      [404, 'NOT_FOUND', 'registration_not_found'],
    ] as const) {
      routes[`POST /v1/registrations/${REG}/decision`] = refused(status, code);
      expect(await outcome(() => decide({ command: 'CONFIRM', return: 'detail' }))).toBe(
        `${HUB}/${REG}?error=${msg}`,
      );
    }
  });

  it('refuses unknown commands and malformed ids without calling the API', async () => {
    expect(await outcome(() => decide({ command: 'PROMOTE' }))).toBe(
      `${HUB}?error=registration_transition`,
    );
    expect(await outcome(() => decide({ command: 'CONFIRM', registrationId: '../x' }))).toBe(
      `${HUB}?error=registration_not_found`,
    );
    expect(writes()).toEqual([]);
  });

  it('a non-member cannot use the action', async () => {
    expect(
      await outcome(() =>
        orgActions.registrationDecisionAction(
          form({
            slug: 'other-club',
            competitionId: COMP,
            registrationId: REG,
            command: 'CONFIRM',
          }),
        ),
      ),
    ).toBe('/app');
    expect(writes()).toEqual([]);
  });
});
