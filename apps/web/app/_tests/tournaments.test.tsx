import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ONCF-03B organizer Tournament Builder, rendered and exercised against a fake session + fake
// platform API. The API stays the authority: these tests prove the web layer reflects its
// `editable`, `nextStatuses`, permissions and catalog, and sends the canonical commands.

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

const OrgLayout = (await import('../app/orgs/[slug]/layout')).default;
const Dashboard = (await import('../app/orgs/[slug]/page')).default;
const Hub = (await import('../app/orgs/[slug]/tournaments/page')).default;
const NewTournament = (await import('../app/orgs/[slug]/tournaments/new/page')).default;
const Builder = (await import('../app/orgs/[slug]/tournaments/[competitionId]/page')).default;
const EditTournament = (await import('../app/orgs/[slug]/tournaments/[competitionId]/edit/page'))
  .default;
const AddCategory = (
  await import('../app/orgs/[slug]/tournaments/[competitionId]/categories/new/page')
).default;
const Category = (
  await import('../app/orgs/[slug]/tournaments/[competitionId]/categories/[eventId]/page')
).default;
const actions = await import('../app/orgs/[slug]/tournaments/actions');
const builder = await import('../_lib/tournament-builder');

// ───────────────────────────── fake platform ─────────────────────────────

const ORG = '0b9b4b8e-6f0a-4f3e-9d6a-1c2b3c4d5e6f';
const OTHER_ORG = '9b9b4b8e-6f0a-4f3e-9d6a-1c2b3c4d5e6f';
const COMP = '22222222-2222-4222-8222-222222222222';
const EVENT = '33333333-3333-4333-8333-333333333333';
const DV_PADEL = '44444444-4444-4444-8444-444444444444';
const DV_SINGLES = '45444444-4444-4444-8444-444444444444';
const DV_RUN = '46444444-4444-4444-8444-444444444444';
const FV_SE = '55555555-5555-4555-8555-555555555555';
const FV_RR = '56555555-5555-4555-8555-555555555555';
const FV_HEATS = '57555555-5555-4555-8555-555555555555';
const ALL = [
  'ORG_CONFIRM_EXTERNAL_ID',
  'ORG_EDIT_PROFILE',
  'ORG_INVITE_MEMBER',
  'ORG_MANAGE_COMPETITIONS',
  'ORG_MANAGE_ROLES',
  'ORG_REMOVE_MEMBER',
  'ORG_VIEW_PRIVATE',
];
const COMP_ALL = [
  'COMP_CANCEL',
  'COMP_CLOSE_REGISTRATION',
  'COMP_EDIT',
  'COMP_OPEN_REGISTRATION',
  'COMP_PUBLISH',
  'COMP_VIEW_PRIVATE',
];

const CATALOG = {
  disciplineVersions: [
    {
      disciplineVersionId: DV_PADEL,
      sport: { code: 'padel', name: 'Padel' },
      discipline: { code: 'padel.doubles', name: 'Padel doubles' },
      version: 1,
      specHash: 'h1',
      participantKinds: ['TEAM'],
      lineupSize: { min: 2, max: 2 },
      allowedContestTypes: ['MATCH'],
      compatibleFormatVersionIds: [FV_SE, FV_RR],
    },
    {
      disciplineVersionId: DV_SINGLES,
      sport: { code: 'tennis', name: 'Tennis' },
      discipline: { code: 'tennis.singles', name: 'Tennis singles' },
      version: 1,
      specHash: 'h2',
      participantKinds: ['INDIVIDUAL'],
      lineupSize: { min: 1, max: 1 },
      allowedContestTypes: ['MATCH'],
      compatibleFormatVersionIds: [FV_SE],
    },
    {
      // Listed against a format with no engine in this build: never runnable, never offered.
      disciplineVersionId: DV_RUN,
      sport: { code: 'running', name: 'Running' },
      discipline: { code: 'running.5k', name: '5K' },
      version: 1,
      specHash: 'h3',
      participantKinds: ['INDIVIDUAL'],
      lineupSize: { min: 1, max: 1 },
      allowedContestTypes: ['HEAT'],
      compatibleFormatVersionIds: [FV_HEATS],
    },
  ],
  formatVersions: [
    {
      formatVersionId: FV_SE,
      format: { code: 'single-elimination', name: 'Single elimination' },
      version: 1,
      engine: 'single-elimination/1',
      contestType: 'MATCH',
      configurationSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      formatVersionId: FV_RR,
      format: { code: 'round-robin', name: 'Round robin' },
      version: 1,
      engine: 'round-robin/1',
      contestType: 'MATCH',
      configurationSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      formatVersionId: FV_HEATS,
      format: { code: 'heats', name: 'Heats' },
      version: 1,
      engine: 'heats/1',
      contestType: null,
      configurationSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ],
};

type EventOverrides = Partial<{
  status: string;
  nextStatuses: string[];
  editable: { settings: boolean; capacityAndRegistrationMode: boolean };
  category: Record<string, unknown>;
}>;

function managedEvent(o: EventOverrides = {}) {
  return {
    id: EVENT,
    slug: 'men-open',
    status: o.status ?? 'DRAFT',
    entrantKind: 'TEAM',
    discipline: {
      versionId: DV_PADEL,
      sport: { code: 'padel', name: 'Padel' },
      code: 'padel.doubles',
      name: 'Padel doubles',
      version: 1,
    },
    format: {
      versionId: FV_SE,
      code: 'single-elimination',
      name: 'Single elimination',
      version: 1,
      engine: 'single-elimination/1',
    },
    formatConfig: {},
    settings: {
      name: 'Men Open',
      category: o.category ?? { genderCategory: 'MEN', skillClass: 'A' },
      capacity: 16,
      registrationMode: 'ORGANIZER_APPROVAL',
      registrationOpensAt: '2026-11-01T15:00:00.000Z',
      registrationClosesAt: null,
      startsAt: null,
      endsAt: null,
      timezone: 'America/Costa_Rica',
    },
    counts: { confirmed: 4, waitlisted: 1, participants: 0 },
    editable: o.editable ?? { settings: true, capacityAndRegistrationMode: true },
    nextStatuses: o.nextStatuses ?? ['REGISTRATION_OPEN', 'CANCELLED'],
    createdAt: '2026-10-06T00:00:00Z',
    updatedAt: '2026-10-06T00:00:00Z',
    statusChangedAt: '2026-10-06T00:00:00Z',
  };
}

type CompOverrides = Partial<{
  status: string;
  nextStatuses: string[];
  editable: { profile: boolean; addEvents: boolean };
  events: unknown[];
  permissions: string[];
  organizer: string;
}>;

function managed(o: CompOverrides = {}) {
  return {
    competition: {
      id: COMP,
      slug: 'autumn-open',
      organizerOrganizationId: o.organizer ?? ORG,
      status: o.status ?? 'DRAFT',
      profile: {
        name: 'Autumn Open',
        description: null,
        locationLabel: 'Club Uno courts',
        regionCode: 'CR',
        timezone: 'America/Costa_Rica',
        startsAt: '2026-11-14T14:00:00.000Z',
        endsAt: '2026-11-16T02:00:00.000Z',
        website: null,
      },
      editable: o.editable ?? { profile: true, addEvents: true },
      nextStatuses: o.nextStatuses ?? ['PUBLISHED', 'CANCELLED'],
      createdAt: '2026-10-06T00:00:00Z',
      updatedAt: '2026-10-06T00:00:00Z',
      statusChangedAt: '2026-10-06T00:00:00Z',
    },
    events: o.events ?? [managedEvent()],
    access: { staffRoles: ['OWNER'], permissions: o.permissions ?? COMP_ALL },
  };
}

function card(id: string, name: string, status: string) {
  return {
    id,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    status,
    startsAt: '2026-11-14T14:00:00.000Z',
    endsAt: '2026-11-16T02:00:00.000Z',
    timezone: 'America/Costa_Rica',
    locationLabel: 'Club Uno courts',
    regionCode: 'CR',
    eventCount: 3,
    cancelledEventCount: 1,
    createdAt: '2026-10-06T00:00:00Z',
    updatedAt: '2026-10-06T00:00:00Z',
    statusChangedAt: '2026-10-06T00:00:00Z',
  };
}

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

function platform(role: 'OWNER' | 'ATHLETE', perms: string[], detail = managed()) {
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
            membershipId: '11111111-1111-4111-8111-111111111111',
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
            description: null,
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
        affiliations: { status: 'AVAILABLE', items: [] },
        canonicalSlug: 'club-uno',
        redirected: false,
      }),
    'GET /v1/organizations/club-uno/competitions': () =>
      json(200, {
        items: [
          {
            id: 'pub-1',
            slug: 'spring-cup',
            name: 'Spring Cup',
            status: 'PUBLISHED',
            startsAt: null,
            endsAt: null,
            locationLabel: null,
          },
        ],
      }),
    [`GET /v1/organizations/${ORG}/members`]: () => json(200, { items: [] }),
    [`GET /v1/organizations/${ORG}/competitions/manage`]: () =>
      json(200, {
        items: [
          card(COMP, 'Autumn Open', 'DRAFT'),
          card('c-2', 'Summer Slam', 'PUBLISHED'),
          card('c-3', 'Winter Classic', 'CANCELLED'),
        ],
      }),
    [`GET /v1/competitions/${COMP}/manage`]: () => json(200, detail),
    'GET /v1/catalog': () => json(200, CATALOG),
  };
}

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
const pc = (competitionId = COMP) => ({
  params: Promise.resolve({ slug: 'club-uno', competitionId }),
});
const pe = (eventId = EVENT) => ({
  params: Promise.resolve({ slug: 'club-uno', competitionId: COMP, eventId }),
});
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
const TB = '/app/orgs/club-uno/tournaments';

// ───────────────────────────── navigation & access ─────────────────────────────

describe('Tournaments tab and access', () => {
  it('the tab appears only with ORG_MANAGE_COMPETITIONS', async () => {
    platform('ATHLETE', ['ORG_VIEW_PRIVATE']);
    expect(html(await OrgLayout({ children: null, ...p() }))).not.toContain(`href="${TB}"`);
    platform('OWNER', ALL);
    expect(html(await OrgLayout({ children: null, ...p() }))).toContain(`href="${TB}"`);
  });

  it('members without the permission get a 404 for the hub and the create form, and no manage read', async () => {
    platform('ATHLETE', ['ORG_VIEW_PRIVATE']);
    expect(await outcome(() => Hub({ ...p(), ...sp() }))).toBe('404');
    expect(await outcome(() => NewTournament({ ...p(), ...sp() }))).toBe('404');
    expect(calls.some((c) => c.path.endsWith('/competitions/manage'))).toBe(false);
  });

  it('a tournament the API refuses, or that another organization runs, is a 404', async () => {
    platform('OWNER', ALL);
    routes[`GET /v1/competitions/${COMP}/manage`] = () =>
      json(403, { error: { code: 'FORBIDDEN' } });
    expect(await outcome(() => Builder({ ...pc(), ...sp() }))).toBe('404');
    platform('OWNER', ALL, managed({ organizer: OTHER_ORG }));
    expect(await outcome(() => Builder({ ...pc(), ...sp() }))).toBe('404');
    calls = [];
    expect(await outcome(() => Builder({ ...pc('not-a-uuid'), ...sp() }))).toBe('404');
    expect(calls.some((c) => c.path.includes('not-a-uuid'))).toBe(false);
  });

  it('tournament actions for an organization the caller does not belong to never reach a mutation', async () => {
    platform('OWNER', ALL);
    const to = await outcome(() =>
      actions.tournamentTransitionAction(
        form({ slug: 'other-club', competitionId: COMP, command: 'publish' }),
      ),
    );
    expect(to).toBe('/app');
    expect(writes()).toEqual([]);
  });
});

// ───────────────────────────── hub & dashboard ─────────────────────────────

describe('Tournament Hub', () => {
  it('lists every managed tournament, drafts included, grouped by lifecycle, with a create action', async () => {
    platform('OWNER', ALL);
    const out = html(await Hub({ ...p(), ...sp() }));
    expect(out).toContain('Autumn Open');
    expect(out).toContain('Summer Slam');
    expect(out).toContain('Winter Classic');
    expect(out).toMatch(/Drafts · 1/);
    expect(out).toMatch(/Live &amp; upcoming · 1/);
    expect(out).toMatch(/Past · 1/);
    expect(out).toContain('data-status="DRAFT"');
    expect(out).toContain('Continue →');
    expect(out).toContain(`href="${TB}/new"`);
    expect(out).toContain(`href="${TB}/${COMP}"`);
    // eventCount − cancelledEventCount, and the cancelled ones said as such.
    expect(out).toContain('2 categories');
    expect(out).toContain('1 cancelled category');
    expect(out).toContain('14–15 Nov 2026');
  });

  it('an empty hub guides straight into creating a tournament', async () => {
    platform('OWNER', ALL);
    routes[`GET /v1/organizations/${ORG}/competitions/manage`] = () => json(200, { items: [] });
    const out = html(await Hub({ ...p(), ...sp() }));
    expect(out).toContain('Build your first tournament');
    expect(out.match(new RegExp(`href="${TB}/new"`, 'g'))?.length).toBeGreaterThanOrEqual(2);
  });

  it('the dashboard counts drafts for organizers and keeps the public list for everyone else', async () => {
    platform('OWNER', ALL);
    const owner = html(await Dashboard({ ...p(), ...sp() }));
    expect(owner).toMatch(/Tournaments<\/span><strong>3<\/strong>/);
    expect(owner).toContain('1 draft');
    expect(owner).toContain(`href="${TB}/${COMP}"`);
    platform('ATHLETE', []);
    calls = [];
    const member = html(await Dashboard({ ...p(), ...sp() }));
    expect(member).toMatch(/Tournaments<\/span><strong>1<\/strong>/);
    expect(member).toContain('href="/competitions/spring-cup"');
    expect(calls.some((c) => c.path.endsWith('/competitions/manage'))).toBe(false);
  });
});

// ───────────────────────────── create ─────────────────────────────

describe('create tournament', () => {
  it('renders the identity form with the canonical slug bound and the organization’s country', async () => {
    platform('OWNER', ALL);
    const out = html(await NewTournament({ ...p(), ...sp() }));
    for (const name of [
      'name',
      'address',
      'startsAt',
      'endsAt',
      'timezone',
      'locationLabel',
      'regionCode',
      'description',
      'website',
    ])
      expect(out).toContain(`name="${name}"`);
    expect(out).toMatch(/minLength="3" maxLength="50"[^>]*name="address"/);
    expect(out).toMatch(/name="regionCode"[^>]*value="CR"/);
    expect(out).toMatch(/name="key" value="oc-[0-9a-f]{32}"/);
  });

  it('posts the canonical command with instants in the chosen timezone and lands in the builder', async () => {
    platform('OWNER', ALL);
    routes['POST /v1/competitions'] = () =>
      json(201, { competitionId: COMP, slug: 'autumn-open', created: true });
    const to = await outcome(() =>
      actions.createTournamentAction(
        form({
          slug: 'club-uno',
          key: 'oc-key-create-1',
          name: '  Autumn Open ',
          address: 'Autumn-Open',
          timezone: 'America/Costa_Rica',
          startsAt: '2026-11-14T08:00',
          endsAt: '2026-11-15T20:00',
          locationLabel: 'Club Uno courts',
          regionCode: 'cr-sj',
          description: '',
          website: '',
        }),
      ),
    );
    expect(to).toBe(`${TB}/${COMP}?notice=tournament_created`);
    expect(writes()).toEqual([
      {
        method: 'POST',
        path: '/v1/competitions',
        auth: 'Bearer tok',
        key: 'oc-key-create-1',
        body: {
          organizerOrganizationId: ORG,
          slug: 'autumn-open',
          profile: {
            name: 'Autumn Open',
            description: null,
            locationLabel: 'Club Uno courts',
            regionCode: 'CR-SJ',
            timezone: 'America/Costa_Rica',
            startsAt: '2026-11-14T14:00:00.000Z',
            endsAt: '2026-11-16T02:00:00.000Z',
            website: null,
          },
        },
      },
    ]);
  });

  it('a blank address is generated from the name', async () => {
    platform('OWNER', ALL);
    routes['POST /v1/competitions'] = () =>
      json(201, { competitionId: COMP, slug: 'x', created: true });
    await outcome(() =>
      actions.createTournamentAction(
        form({ slug: 'club-uno', name: 'Copa Café', address: '', timezone: 'UTC' }),
      ),
    );
    expect((writes()[0]?.body as { slug: string }).slug).toMatch(/^copa-cafe-[0-9a-f]{4}$/);
  });

  it.each([
    [409, 'SLUG_TAKEN', 'tournament_address_taken'],
    [400, 'INVALID_INPUT', 'tournament_invalid'],
    [403, 'FORBIDDEN', 'not_permitted'],
  ])('maps a %i %s refusal to %s', async (status, code, expected) => {
    platform('OWNER', ALL);
    routes['POST /v1/competitions'] = () => json(status, { error: { code } });
    const to = await outcome(() =>
      actions.createTournamentAction(
        form({ slug: 'club-uno', name: 'Autumn Open', timezone: 'UTC' }),
      ),
    );
    expect(to).toBe(`${TB}/new?error=${expected}`);
  });

  it('refuses invalid input locally without calling the API', async () => {
    platform('OWNER', ALL);
    const cases: [Record<string, string>, string][] = [
      [{ name: '', timezone: 'UTC' }, 'missing_fields'],
      [{ name: 'X Cup', timezone: 'Mars/Olympus' }, 'tournament_invalid'],
      [{ name: 'X Cup', timezone: 'UTC', startsAt: 'tomorrow' }, 'tournament_invalid'],
      [{ name: 'X Cup', timezone: 'UTC', address: 'a' }, 'profile_address_invalid'],
      [{ name: 'X Cup', timezone: 'UTC', address: 'x'.repeat(51) }, 'profile_address_invalid'],
    ];
    for (const [fields, code] of cases)
      expect(
        await outcome(() => actions.createTournamentAction(form({ slug: 'club-uno', ...fields }))),
      ).toBe(`${TB}/new?error=${code}`);
    expect(writes()).toEqual([]);
  });
});

// ───────────────────────────── builder / detail ─────────────────────────────

describe('tournament builder', () => {
  it('shows the tournament, its categories and the builder progress from real data', async () => {
    platform('OWNER', ALL);
    const out = html(await Builder({ ...pc(), ...sp() }));
    expect(out).toContain('Autumn Open');
    expect(out).toContain('Club Uno courts · CR');
    expect(out).toContain('aria-label="Tournament builder"');
    // Category card facts.
    expect(out).toContain('Men Open');
    expect(out).toContain('Padel · Padel doubles');
    expect(out).toContain('Single elimination');
    expect(out).toContain('Teams');
    expect(out).toContain('Approval');
    expect(out).toContain('of 16');
    expect(out).toContain('>Men<');
    expect(out).toContain(`href="${TB}/${COMP}/categories/${EVENT}"`);
    // Review: the one category has no closing date yet.
    expect(out).toMatch(/data-done="false"[^>]*>.*Every category has a registration window/);
  });

  it('renders lifecycle buttons only for advertised transitions the caller may perform', async () => {
    platform('OWNER', ALL);
    const draft = html(await Builder({ ...pc(), ...sp() }));
    expect(draft).toContain('value="publish"');
    expect(draft).toContain('Cancel tournament');
    expect(draft).not.toContain('value="activate"');
    expect(draft).not.toContain('value="complete"');

    platform('OWNER', ALL, managed({ status: 'PUBLISHED', nextStatuses: ['ACTIVE', 'CANCELLED'] }));
    const published = html(await Builder({ ...pc(), ...sp() }));
    expect(published).toContain('value="activate"');
    expect(published).not.toContain('value="publish"');
    expect(published).toContain('href="/competitions/autumn-open"');

    platform(
      'OWNER',
      ALL,
      managed({
        status: 'COMPLETED',
        nextStatuses: [],
        editable: { profile: false, addEvents: false },
      }),
    );
    const done = html(await Builder({ ...pc(), ...sp() }));
    expect(done).not.toContain('name="command"');
    expect(done).not.toContain('+ Add category');
    expect(done).not.toContain('Edit details');
    expect(done).toContain('This tournament is completed.');

    platform(
      'OWNER',
      ALL,
      managed({ permissions: ['COMP_VIEW_PRIVATE', 'COMP_OPEN_REGISTRATION'] }),
    );
    const staff = html(await Builder({ ...pc(), ...sp() }));
    expect(staff).not.toContain('value="publish"');
    expect(staff).not.toContain('+ Add category');
    expect(staff).toContain('Your role can’t change this tournament’s status.');
  });

  it('an empty tournament offers its first category slot only while events can be added', async () => {
    platform('OWNER', ALL, managed({ events: [] }));
    expect(html(await Builder({ ...pc(), ...sp() }))).toContain('Add your first category');
    platform('OWNER', ALL, managed({ events: [], editable: { profile: true, addEvents: false } }));
    expect(html(await Builder({ ...pc(), ...sp() }))).not.toContain('Add your first category');
  });
});

describe('tournament profile', () => {
  it('editable → the form, prefilled in the tournament timezone; not editable → read only', async () => {
    platform('OWNER', ALL);
    const out = html(await EditTournament({ ...pc(), ...sp() }));
    expect(out).toMatch(/name="startsAt" value="2026-11-14T08:00"/);
    expect(out).toMatch(/name="address"[^>]*value="autumn-open"/);
    expect(out).toContain('name="currentAddress" value="autumn-open"');
    platform(
      'OWNER',
      ALL,
      managed({
        status: 'CANCELLED',
        nextStatuses: [],
        editable: { profile: false, addEvents: false },
      }),
    );
    const ro = html(await EditTournament({ ...pc(), ...sp() }));
    expect(ro).not.toContain('<form');
    expect(ro).toContain('Details are final for this tournament');
  });

  it('saves the whole profile and changes the address only when it changed', async () => {
    platform('OWNER', ALL);
    routes[`PUT /v1/competitions/${COMP}/profile`] = () => json(200, { competitionId: COMP });
    routes[`PUT /v1/competitions/${COMP}/slug`] = () => json(200, { slug: 'autumn-open-2026' });
    const base = {
      slug: 'club-uno',
      competitionId: COMP,
      name: 'Autumn Open',
      timezone: 'UTC',
      currentAddress: 'autumn-open',
    };
    expect(
      await outcome(() =>
        actions.updateTournamentAction(form({ ...base, address: 'autumn-open' })),
      ),
    ).toBe(`${TB}/${COMP}?notice=tournament_updated`);
    expect(writes().map((c) => c.path)).toEqual([`/v1/competitions/${COMP}/profile`]);
    calls = [];
    await outcome(() =>
      actions.updateTournamentAction(form({ ...base, address: 'autumn-open-2026' })),
    );
    expect(writes().map((c) => `${c.method} ${c.path}`)).toEqual([
      `PUT /v1/competitions/${COMP}/profile`,
      `PUT /v1/competitions/${COMP}/slug`,
    ]);
    expect(writes()[1]?.body).toEqual({ slug: 'autumn-open-2026' });
  });

  it('a profile the server has frozen surfaces as tournament_transition', async () => {
    platform('OWNER', ALL);
    routes[`PUT /v1/competitions/${COMP}/profile`] = () =>
      json(409, { error: { code: 'INVALID_TRANSITION' } });
    expect(
      await outcome(() =>
        actions.updateTournamentAction(
          form({ slug: 'club-uno', competitionId: COMP, name: 'X Cup', timezone: 'UTC' }),
        ),
      ),
    ).toBe(`${TB}/${COMP}/edit?error=tournament_transition`);
  });
});

describe('tournament lifecycle', () => {
  it('publish calls the canonical command; INVALID_TRANSITION is reported, not hidden', async () => {
    platform('OWNER', ALL);
    routes[`POST /v1/competitions/${COMP}/publish`] = () =>
      json(200, { competitionId: COMP, status: 'PUBLISHED' });
    const f = { slug: 'club-uno', competitionId: COMP, command: 'publish' };
    expect(await outcome(() => actions.tournamentTransitionAction(form(f)))).toBe(
      `${TB}/${COMP}?notice=published`,
    );
    expect(writes()[0]).toMatchObject({
      method: 'POST',
      path: `/v1/competitions/${COMP}/publish`,
      body: undefined,
    });
    routes[`POST /v1/competitions/${COMP}/publish`] = () =>
      json(409, { error: { code: 'INVALID_TRANSITION' } });
    expect(await outcome(() => actions.tournamentTransitionAction(form(f)))).toBe(
      `${TB}/${COMP}?error=tournament_transition`,
    );
  });

  it('cancellation requires a reason and sends it', async () => {
    platform('OWNER', ALL);
    routes[`POST /v1/competitions/${COMP}/cancel`] = () =>
      json(200, { competitionId: COMP, status: 'CANCELLED' });
    const f = { slug: 'club-uno', competitionId: COMP, command: 'cancel' };
    expect(
      await outcome(() => actions.tournamentTransitionAction(form({ ...f, reason: '  ' }))),
    ).toBe(`${TB}/${COMP}?error=reason_required`);
    expect(writes()).toEqual([]);
    expect(
      await outcome(() =>
        actions.tournamentTransitionAction(form({ ...f, reason: 'Venue flooded' })),
      ),
    ).toBe(`${TB}/${COMP}?notice=tournament_cancelled`);
    expect(writes()[0]?.body).toEqual({ reason: 'Venue flooded' });
  });

  it('an unknown command never reaches the API', async () => {
    platform('OWNER', ALL);
    expect(
      await outcome(() =>
        actions.tournamentTransitionAction(
          form({ slug: 'club-uno', competitionId: COMP, command: 'delete' }),
        ),
      ),
    ).toBe(`${TB}/${COMP}?error=tournament_transition`);
    expect(writes()).toEqual([]);
  });

  it('the builder page shows a cancellation form with a required reason', async () => {
    platform('OWNER', ALL);
    const out = html(await Builder({ ...pc(), ...sp() }));
    expect(out).toMatch(/<textarea name="reason" required=""/);
    expect(out).toContain('Confirm cancellation');
  });
});

// ───────────────────────────── categories ─────────────────────────────

describe('catalog filtering', () => {
  it('offers only sports and formats the catalog says can run', () => {
    expect(builder.catalogSports(CATALOG as never).map((s) => s.code)).toEqual(['padel', 'tennis']);
    expect(
      builder.compatibleFormats(CATALOG as never, DV_PADEL).map((f) => f.formatVersionId),
    ).toEqual([FV_SE, FV_RR]);
    expect(
      builder.compatibleFormats(CATALOG as never, DV_SINGLES).map((f) => f.formatVersionId),
    ).toEqual([FV_SE]);
    expect(builder.compatibleFormats(CATALOG as never, DV_RUN)).toEqual([]);
  });

  it('rejects incompatible formats and entrant kinds', () => {
    const ok = {
      disciplineVersionId: DV_SINGLES,
      formatVersionId: FV_SE,
      entrantKind: 'INDIVIDUAL',
    };
    expect(builder.validCombination(CATALOG as never, ok)).toBe(true);
    expect(builder.validCombination(CATALOG as never, { ...ok, formatVersionId: FV_RR })).toBe(
      false,
    );
    expect(builder.validCombination(CATALOG as never, { ...ok, entrantKind: 'TEAM' })).toBe(false);
    expect(
      builder.validCombination(CATALOG as never, {
        ...ok,
        disciplineVersionId: DV_RUN,
        formatVersionId: FV_HEATS,
      }),
    ).toBe(false);
  });

  it('reads format configuration schemas without inventing controls', () => {
    expect(
      builder.configFields({ type: 'object', properties: {}, additionalProperties: false }),
    ).toEqual({ kind: 'fields', fields: [] });
    const schema = {
      type: 'object',
      properties: {
        bestOf: { type: 'integer', minimum: 1, maximum: 5, default: 3 },
        thirdPlace: { type: 'boolean' },
        seeding: { type: 'string', enum: ['RANDOM', 'RANKED'] },
      },
      required: ['bestOf'],
      additionalProperties: false,
    };
    const r = builder.configFields(schema);
    expect(r.kind === 'fields' && r.fields.map((f) => `${f.kind}:${f.name}:${f.required}`)).toEqual(
      ['integer:bestOf:true', 'boolean:thirdPlace:false', 'enum:seeding:false'],
    );
    expect(
      builder.configFields({ type: 'object', properties: { rounds: { type: 'array' } } }),
    ).toEqual({ kind: 'unsupported' });
    if (r.kind !== 'fields') throw new Error('expected fields');
    expect(
      builder.configFromForm(r.fields, form({ 'cfg.bestOf': '5', 'cfg.seeding': '' })),
    ).toEqual({
      bestOf: 5,
      thirdPlace: false,
    });
  });

  it('converts wall-clock times in a zone to instants and back (including summer time)', () => {
    expect(builder.zonedToInstant('2026-11-14T08:00', 'America/Costa_Rica')).toBe(
      '2026-11-14T14:00:00.000Z',
    );
    expect(builder.zonedToInstant('2026-07-01T10:00', 'Europe/Madrid')).toBe(
      '2026-07-01T08:00:00.000Z',
    );
    expect(builder.zonedToInstant('2026-01-15T10:00', 'Europe/Madrid')).toBe(
      '2026-01-15T09:00:00.000Z',
    );
    expect(builder.instantToZoned('2026-07-01T08:00:00.000Z', 'Europe/Madrid')).toBe(
      '2026-07-01T10:00',
    );
    expect(builder.zonedToInstant('', 'UTC')).toBeNull();
    expect(builder.zonedToInstant('soon', 'UTC')).toBeUndefined();
  });
});

describe('add category', () => {
  it('the builder only offers runnable sports and is unavailable once events can no longer be added', async () => {
    platform('OWNER', ALL);
    const out = html(await AddCategory({ ...pc(), ...sp() }));
    expect(out).toContain('value="padel"');
    expect(out).toContain('value="tennis"');
    expect(out).not.toContain('value="running"');
    expect(out).toContain('Choose sport, discipline, entrants and format');
    platform('OWNER', ALL, managed({ editable: { profile: true, addEvents: false } }));
    expect(await outcome(() => AddCategory({ ...pc(), ...sp() }))).toBe(
      `${TB}/${COMP}?error=tournament_transition`,
    );
  });

  const category = {
    slug: 'club-uno',
    competitionId: COMP,
    key: 'oc-key-cat-1',
    disciplineVersionId: DV_PADEL,
    formatVersionId: FV_RR,
    entrantKind: 'TEAM',
    name: 'Women A',
    address: 'women-a',
    genderCategory: 'WOMEN',
    skillClass: 'A',
    ageLabel: '',
    capacity: '12',
    registrationMode: 'AUTO_CONFIRM',
    registrationOpensAt: '2026-11-01T09:00',
    registrationClosesAt: '2026-11-10T18:00',
    startsAt: '',
    endsAt: '',
    timezone: 'America/Costa_Rica',
  };

  it('creates the event with the catalog pins, the empty format configuration and an idempotency key', async () => {
    platform('OWNER', ALL);
    routes[`POST /v1/competitions/${COMP}/events`] = () =>
      json(201, { eventId: EVENT, slug: 'women-a', created: true });
    expect(await outcome(() => actions.addCategoryAction(form(category)))).toBe(
      `${TB}/${COMP}?notice=category_added`,
    );
    expect(writes()).toEqual([
      {
        method: 'POST',
        path: `/v1/competitions/${COMP}/events`,
        auth: 'Bearer tok',
        key: 'oc-key-cat-1',
        body: {
          slug: 'women-a',
          disciplineVersionId: DV_PADEL,
          formatVersionId: FV_RR,
          entrantKind: 'TEAM',
          formatConfig: {},
          settings: {
            name: 'Women A',
            category: { genderCategory: 'WOMEN', skillClass: 'A' },
            capacity: 12,
            registrationMode: 'AUTO_CONFIRM',
            registrationOpensAt: '2026-11-01T15:00:00.000Z',
            registrationClosesAt: '2026-11-11T00:00:00.000Z',
            startsAt: null,
            endsAt: null,
            timezone: 'America/Costa_Rica',
          },
        },
      },
    ]);
  });

  it('never sends a combination the catalog does not offer', async () => {
    platform('OWNER', ALL);
    for (const bad of [
      { disciplineVersionId: DV_SINGLES, formatVersionId: FV_RR, entrantKind: 'INDIVIDUAL' },
      { disciplineVersionId: DV_PADEL, formatVersionId: FV_SE, entrantKind: 'INDIVIDUAL' },
      { disciplineVersionId: DV_RUN, formatVersionId: FV_HEATS, entrantKind: 'INDIVIDUAL' },
    ])
      expect(await outcome(() => actions.addCategoryAction(form({ ...category, ...bad })))).toBe(
        `${TB}/${COMP}/categories/new?error=catalog_combination`,
      );
    expect(writes()).toEqual([]);
  });

  it('maps API refusals (dates outside the tournament, taken address)', async () => {
    platform('OWNER', ALL);
    routes[`POST /v1/competitions/${COMP}/events`] = () =>
      json(400, { error: { code: 'INVALID_INPUT' } });
    expect(await outcome(() => actions.addCategoryAction(form(category)))).toBe(
      `${TB}/${COMP}/categories/new?error=tournament_invalid`,
    );
    routes[`POST /v1/competitions/${COMP}/events`] = () =>
      json(409, { error: { code: 'SLUG_TAKEN' } });
    expect(await outcome(() => actions.addCategoryAction(form(category)))).toBe(
      `${TB}/${COMP}/categories/new?error=tournament_address_taken`,
    );
  });
});

describe('category settings', () => {
  it('capacity and entry mode are offered only while the API allows it', async () => {
    platform('OWNER', ALL);
    const draft = html(await Category({ ...pe(), ...sp() }));
    expect(draft).toContain('name="capacity"');
    expect(draft).toContain('name="registrationMode"');
    expect(draft).toMatch(/name="registrationOpensAt" value="2026-11-01T09:00"/);
    platform(
      'OWNER',
      ALL,
      managed({
        events: [
          managedEvent({
            status: 'REGISTRATION_OPEN',
            nextStatuses: ['REGISTRATION_CLOSED', 'CANCELLED'],
            editable: { settings: true, capacityAndRegistrationMode: false },
          }),
        ],
      }),
    );
    const open = html(await Category({ ...pe(), ...sp() }));
    expect(open).not.toContain('name="capacity"');
    expect(open).not.toContain('name="registrationMode"');
    expect(open).toContain('Locked after draft');
    expect(open).toContain('name="name"');
  });

  it('settings that are locked are shown read only', async () => {
    platform(
      'OWNER',
      ALL,
      managed({
        events: [
          managedEvent({
            status: 'FIELD_LOCKED',
            nextStatuses: ['IN_PROGRESS', 'CANCELLED'],
            editable: { settings: false, capacityAndRegistrationMode: false },
          }),
        ],
      }),
    );
    const out = html(await Category({ ...pe(), ...sp() }));
    expect(out).toContain('Settings are locked for this category');
    expect(out).not.toContain('name="capacity"');
    // Starting play belongs to operations: never offered here even though it is advertised.
    expect(out).not.toContain('value="start"');
    expect(out).toContain('Cancel category');
  });

  it('a frozen capacity and mode are resent as stored; unedited labels are kept', async () => {
    platform(
      'OWNER',
      ALL,
      managed({
        events: [
          managedEvent({
            status: 'REGISTRATION_OPEN',
            editable: { settings: true, capacityAndRegistrationMode: false },
            category: { genderCategory: 'MEN', weightClass: 'Heavy' },
          }),
        ],
      }),
    );
    routes[`PUT /v1/events/${EVENT}/settings`] = () => json(200, { eventId: EVENT });
    const to = await outcome(() =>
      actions.updateCategoryAction(
        form({
          slug: 'club-uno',
          competitionId: COMP,
          eventId: EVENT,
          name: 'Men Open A',
          genderCategory: 'MEN',
          skillClass: 'A',
          capacity: '999',
          registrationMode: 'AUTO_CONFIRM',
          timezone: 'America/Costa_Rica',
        }),
      ),
    );
    expect(to).toBe(`${TB}/${COMP}/categories/${EVENT}?notice=category_updated`);
    expect(writes()[0]).toMatchObject({
      method: 'PUT',
      path: `/v1/events/${EVENT}/settings`,
      body: {
        name: 'Men Open A',
        category: { genderCategory: 'MEN', weightClass: 'Heavy', skillClass: 'A' },
        capacity: 16,
        registrationMode: 'ORGANIZER_APPROVAL',
      },
    });
  });
});

describe('category lifecycle', () => {
  it('renders open registration and cancel from nextStatuses', async () => {
    platform('OWNER', ALL);
    const out = html(await Category({ ...pe(), ...sp() }));
    expect(out).toContain('value="open-registration"');
    expect(out).not.toContain('value="close-registration"');
    expect(out).toContain('Cancel category');
  });

  it('open, close and cancel call the canonical event commands', async () => {
    platform('OWNER', ALL);
    for (const cmd of ['open-registration', 'close-registration', 'cancel'])
      routes[`POST /v1/events/${EVENT}/${cmd}`] = () => json(200, { eventId: EVENT });
    const f = { slug: 'club-uno', competitionId: COMP, eventId: EVENT };
    const back = `${TB}/${COMP}/categories/${EVENT}`;
    expect(
      await outcome(() =>
        actions.categoryTransitionAction(form({ ...f, command: 'open-registration' })),
      ),
    ).toBe(`${back}?notice=registration_opened`);
    expect(
      await outcome(() =>
        actions.categoryTransitionAction(form({ ...f, command: 'close-registration' })),
      ),
    ).toBe(`${back}?notice=registration_closed`);
    expect(
      await outcome(() => actions.categoryTransitionAction(form({ ...f, command: 'cancel' }))),
    ).toBe(`${back}?error=reason_required`);
    expect(
      await outcome(() =>
        actions.categoryTransitionAction(
          form({ ...f, command: 'cancel', reason: 'Too few pairs' }),
        ),
      ),
    ).toBe(`${back}?notice=category_cancelled`);
    expect(
      await outcome(() => actions.categoryTransitionAction(form({ ...f, command: 'start' }))),
    ).toBe(`${back}?error=tournament_transition`);
    expect(writes().map((c) => c.path)).toEqual([
      `/v1/events/${EVENT}/open-registration`,
      `/v1/events/${EVENT}/close-registration`,
      `/v1/events/${EVENT}/cancel`,
    ]);
  });

  it('a transition the server refuses is reported as such', async () => {
    platform('OWNER', ALL);
    routes[`POST /v1/events/${EVENT}/open-registration`] = () =>
      json(409, { error: { code: 'INVALID_TRANSITION' } });
    expect(
      await outcome(() =>
        actions.categoryTransitionAction(
          form({
            slug: 'club-uno',
            competitionId: COMP,
            eventId: EVENT,
            command: 'open-registration',
          }),
        ),
      ),
    ).toBe(`${TB}/${COMP}/categories/${EVENT}?error=tournament_transition`);
  });
});
