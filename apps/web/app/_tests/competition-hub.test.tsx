import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ONCF-L1 Competition Hub and tournament staff, rendered and exercised against a fake session +
// fake platform API. The API stays the authority: these tests prove the web layer reflects
// GET /v1/competitions/:id/manage and /staff, offers staff changes only with COMP_MANAGE_STAFF,
// sends the canonical commands and never links to workflow stages that have no web surface yet.
// ONCF-L2: the Resources stage is linked and reflects resources, declared hours and the catalog.

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

const Hub = (await import('../app/orgs/[slug]/tournaments/[competitionId]/page')).default;
const Staff = (await import('../app/orgs/[slug]/tournaments/[competitionId]/staff/page')).default;
const Registrations = (
  await import('../app/orgs/[slug]/tournaments/[competitionId]/registrations/page')
).default;
const actions = await import('../app/orgs/[slug]/tournaments/[competitionId]/staff/actions');
const staffLib = await import('../_lib/staff');

// ───────────────────────────── fake platform ─────────────────────────────

const ORG = '0b9b4b8e-6f0a-4f3e-9d6a-1c2b3c4d5e6f';
const COMP = '22222222-2222-4222-8222-222222222222';
const EVENT = '33333333-3333-4333-8333-333333333333';
const SELF = '44444444-4444-4444-8444-444444444444';
const ANA = '55555555-5555-4555-8555-555555555555';
const BEN = '66666666-6666-4666-8666-666666666666';
const S_ANA = '77777777-7777-4777-8777-777777777777';
const S_BEN = '88888888-8888-4888-8888-888888888888';
const ORG_PERMS = ['ORG_MANAGE_COMPETITIONS', 'ORG_VIEW_PRIVATE', 'ORG_INVITE_MEMBER'];
const COMP_OWNER = [
  'COMP_CANCEL',
  'COMP_CLOSE_REGISTRATION',
  'COMP_EDIT',
  'COMP_GENERATE_STRUCTURE',
  'COMP_LOCK_FIELD',
  'COMP_MANAGE_LINEUPS',
  'COMP_MANAGE_REGISTRATIONS',
  'COMP_MANAGE_SCHEDULE',
  'COMP_MANAGE_STAFF',
  'COMP_OPEN_REGISTRATION',
  'COMP_PUBLISH',
  'COMP_VIEW_PRIVATE',
];
const COMP_ADMIN = COMP_OWNER.filter((p) => p !== 'COMP_MANAGE_STAFF');

function event(o: Partial<{ id: string; name: string; status: string; closes: string | null }>) {
  return {
    id: o.id ?? EVENT,
    slug: 'men-open',
    status: o.status ?? 'DRAFT',
    entrantKind: 'TEAM',
    discipline: {
      versionId: 'dv',
      sport: { code: 'padel', name: 'Padel' },
      code: 'padel.doubles',
      name: 'Padel doubles',
      version: 1,
    },
    format: {
      versionId: 'fv',
      code: 'single-elimination',
      name: 'Single elimination',
      version: 1,
      engine: 'single-elimination/1',
    },
    formatConfig: {},
    settings: {
      name: o.name ?? 'Men Open',
      category: { genderCategory: 'MEN' },
      capacity: 16,
      registrationMode: 'ORGANIZER_APPROVAL',
      registrationOpensAt: '2026-11-01T15:00:00.000Z',
      registrationClosesAt: o.closes === undefined ? null : o.closes,
      startsAt: null,
      endsAt: null,
      timezone: 'America/Costa_Rica',
    },
    counts: { confirmed: 4, waitlisted: 1, participants: 0 },
    editable: { settings: true, capacityAndRegistrationMode: true },
    nextStatuses: ['REGISTRATION_OPEN', 'CANCELLED'],
    createdAt: '2026-10-06T00:00:00Z',
    updatedAt: '2026-10-06T00:00:00Z',
    statusChangedAt: '2026-10-06T00:00:00Z',
  };
}

type CompOverrides = Partial<{
  status: string;
  nextStatuses: string[];
  events: unknown[];
  permissions: string[];
  staffRoles: string[];
}>;

function managed(o: CompOverrides = {}) {
  return {
    competition: {
      id: COMP,
      slug: 'autumn-open',
      organizerOrganizationId: ORG,
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
      editable: { profile: true, addEvents: true },
      nextStatuses: o.nextStatuses ?? ['PUBLISHED', 'CANCELLED'],
      createdAt: '2026-10-06T00:00:00Z',
      updatedAt: '2026-10-06T00:00:00Z',
      statusChangedAt: '2026-10-06T00:00:00Z',
    },
    events: o.events ?? [event({})],
    access: { staffRoles: o.staffRoles ?? ['OWNER'], permissions: o.permissions ?? COMP_OWNER },
  };
}

const STAFF = [
  {
    staffId: S_ANA,
    personId: ANA,
    role: 'REGISTRATION_MANAGER',
    since: '2026-10-07T00:00:00.000Z',
    athlete: { slug: 'ana-rojas', displayName: 'Ana Rojas' },
  },
  {
    staffId: S_BEN,
    personId: BEN,
    role: 'SCHEDULER',
    since: '2026-10-08T00:00:00.000Z',
    athlete: null,
  },
];

function rosterEntry(id: string, personId: string, role: string, name: string | null) {
  return {
    membershipId: id,
    personId,
    role,
    visibility: 'PUBLIC',
    status: 'ACTIVE',
    since: '2026-01-01T00:00:00.000Z',
    invitationExpiresAt: null,
    athlete:
      name === null ? null : { slug: name.toLowerCase().replace(' ', '-'), displayName: name },
  };
}
const ROSTER = [
  rosterEntry('m-1', SELF, 'OWNER', 'Olga Owner'),
  rosterEntry('m-2', ANA, 'MEMBER', 'Ana Rojas'),
  rosterEntry('m-3', BEN, 'COACH', null),
  { ...rosterEntry('m-4', 'p-gone', 'MEMBER', 'Gone Person'), status: 'ENDED' },
];

interface Call {
  method: string;
  path: string;
  body: unknown;
  key: string | undefined;
}
let calls: Call[] = [];
let routes: Record<string, (c: Call) => Response> = {};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const err = (status: number, code: string) => json(status, { error: { code } });

const COURT_1 = '99999999-9999-4999-8999-999999999991';
const COURT_2 = '99999999-9999-4999-8999-999999999992';
function court(id: string, label: string, status = 'ACTIVE') {
  return {
    resourceId: id,
    competitionId: COMP,
    typeCode: 'PADEL_COURT',
    revision: 1,
    label,
    attributes: {},
    capacity: 1,
    occupancyMode: 'EXCLUSIVE',
    occupancy: 'EXCLUSIVE',
    exclusivityKeys: [],
    venueOrganizationId: null,
    locationLabel: null,
    timezone: null,
    status,
    updatedAt: '2026-10-08T00:00:00.000Z',
  };
}
const weekly = (resourceId: string | null, n: string) => ({
  availabilityId: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa${n}`,
  scope: resourceId === null ? 'COMPETITION' : 'RESOURCE',
  resourceId,
  kind: 'WEEKLY',
  weekday: 6,
  start: '08:00',
  end: '20:00',
  recordedAt: '2026-10-08T00:00:00.000Z',
});
const version = (n: number, status: string) => ({
  versionId: `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, '0')}`,
  competitionId: COMP,
  versionNumber: n,
  baseVersionId: null,
  status,
  createdByAccountId: null,
  createdAt: '2026-10-10T00:00:00.000Z',
  statusChangedAt: '2026-10-10T00:00:00.000Z',
});
const CATALOG = {
  disciplineVersions: [
    {
      disciplineVersionId: 'dv',
      sport: { code: 'padel', name: 'Padel' },
      discipline: { code: 'padel.doubles', name: 'Padel doubles' },
      version: 1,
      specHash: 'h',
      participantKinds: ['TEAM'],
      lineupSize: { min: 2, max: 2 },
      allowedContestTypes: ['MATCH'],
      compatibleFormatVersionIds: ['fv'],
      capabilities: {
        contestTypes: ['MATCH'],
        participantKinds: ['TEAM'],
        rulesetFamilies: [],
        partitionKinds: [],
        startMethods: [],
        multiRound: true,
        resourceTypes: ['PADEL_COURT'],
        entryAttributes: [],
      },
    },
  ],
  formatVersions: [],
};

function platform(
  o: {
    detail?: ReturnType<typeof managed> | null;
    staff?: unknown[] | null;
    roster?: unknown[] | null;
    resources?: unknown[] | null;
    facts?: unknown[] | null;
    versions?: unknown[] | null;
  } = {},
) {
  const detail = o.detail === undefined ? managed() : o.detail;
  const staff = o.staff === undefined ? STAFF : o.staff;
  const roster = o.roster === undefined ? ROSTER : o.roster;
  const resources = o.resources === undefined ? [] : o.resources;
  const facts = o.facts === undefined ? [] : o.facts;
  const versions = o.versions === undefined ? [] : o.versions;
  routes = {
    'GET /v1/me': () =>
      json(200, {
        accountId: 'acc',
        accountActive: true,
        selfPersonId: SELF,
        athletes: [],
        guardianRelationships: [],
      }),
    'GET /v1/me/organizations': () =>
      json(200, {
        items: [
          {
            membershipId: 'm-1',
            organizationId: ORG,
            role: 'OWNER',
            orgType: 'CLUB',
            slug: 'club-uno',
            displayName: 'Club Uno',
          },
        ],
      }),
    [`GET /v1/organizations/${ORG}/permissions`]: () =>
      json(200, { roles: ['OWNER'], permissions: ORG_PERMS }),
    'GET /v1/organizations/club-uno': () => json(404, {}),
    [`GET /v1/organizations/${ORG}/members`]: () =>
      roster === null ? json(503, {}) : json(200, { items: roster }),
    [`GET /v1/competitions/${COMP}/manage`]: () =>
      detail === null ? json(503, {}) : json(200, detail),
    [`GET /v1/competitions/${COMP}/staff`]: () =>
      staff === null ? json(503, {}) : json(200, { items: staff }),
    [`GET /v1/competitions/${COMP}/resources`]: () =>
      resources === null ? json(503, {}) : json(200, { items: resources }),
    [`GET /v1/competitions/${COMP}/availability`]: () =>
      facts === null ? json(503, {}) : json(200, { items: facts }),
    'GET /v1/catalog': () => json(200, CATALOG),
    [`GET /v1/competitions/${COMP}/schedule/versions`]: () =>
      versions === null ? json(503, {}) : json(200, { items: versions }),
    [`GET /v1/competitions/${COMP}/registrations`]: () =>
      json(200, {
        items: [],
        counts: {
          REQUESTED: 0,
          CONFIRMED: 0,
          WAITLISTED: 0,
          DECLINED: 0,
          WITHDRAWN: 0,
          CANCELLED: 0,
        },
        nextCursor: null,
        access: { permissions: COMP_OWNER },
      }),
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
      key: headers['idempotency-key'],
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(c);
    const r = routes[`${c.method} ${c.path}`];
    return Promise.resolve(r === undefined ? json(404, {}) : r(c));
  });
});

const pc = () => ({ params: Promise.resolve({ slug: 'club-uno', competitionId: COMP }) });
const sp = (q: Record<string, string> = {}) => ({ searchParams: Promise.resolve(q) });
const html = (el: ReactElement | null) => (el === null ? '' : renderToStaticMarkup(el));
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    const d = (e as { digest?: string }).digest ?? '';
    if (d.startsWith('NEXT_REDIRECT')) return d.split(';')[2] ?? '';
    if (d.includes('404')) return '404';
    throw e;
  }
  return 'rendered';
}
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const writes = () => calls.filter((c) => c.method !== 'GET');
const BASE = `/app/orgs/club-uno/tournaments/${COMP}`;
const STAFF_PAGE = `${BASE}/staff`;
/** The `<li>` of one hub stage. */
const stage = (out: string, key: string) =>
  new RegExp(`<li data-state="([a-z]+)" data-key="${key}">(.*?)</li>`).exec(out);

// ───────────────────────────── hub ─────────────────────────────

describe('Competition Hub', () => {
  it('renders the competition identity, organizer, lifecycle and the caller’s role', async () => {
    platform();
    const out = html(await Hub({ ...pc(), ...sp() }));
    expect(out).toContain('Autumn Open');
    expect(out).toContain('Club Uno');
    expect(out).toContain('Club Uno courts · CR');
    expect(out).toMatch(/class="tb-status mono" data-status="DRAFT"/);
    expect(out).toContain('aria-label="Lifecycle"');
    expect(out).toMatch(/Your role<\/span><span>Owner</);
  });

  it('shows each workflow stage from real data, and unbuilt stages as not available', async () => {
    platform();
    const out = html(await Hub({ ...pc(), ...sp() }));
    expect(stage(out, 'categories')?.[1]).toBe('ready');
    expect(stage(out, 'categories')?.[2]).toContain('1 category');
    expect(stage(out, 'registrations')?.[1]).toBe('todo');
    expect(stage(out, 'registrations')?.[2]).toContain('Not opened yet');
    expect(stage(out, 'structure')?.[2]).toContain('0/1 field locked');
    expect(stage(out, 'structure')?.[2]).toContain(`href="${BASE}/categories/${EVENT}/structure"`);
    expect(stage(out, 'staff')?.[2]).toContain('2 people assigned');
    expect(stage(out, 'public')?.[2]).toContain('Available after publishing');
    // ONCF-L2: no resources yet, and the padel category needs a padel court.
    expect(stage(out, 'resources')?.[1]).toBe('attention');
    expect(stage(out, 'resources')?.[2]).toContain('None yet · needed for Men Open');
    expect(stage(out, 'resources')?.[2]).toContain(`href="${BASE}/resources"`);
    // ONCF-L3: the schedule stage is real and linked; nothing can be scheduled before field lock.
    expect(stage(out, 'schedule')?.[1]).toBe('todo');
    expect(stage(out, 'schedule')?.[2]).toContain('After a field is locked');
    expect(stage(out, 'schedule')?.[2]).toContain(`href="${BASE}/schedule"`);
    expect(stage(out, 'operations')?.[1]).toBe('planned');
    expect(stage(out, 'operations')?.[2]).toContain('Not available yet');
    expect(stage(out, 'operations')?.[2]).not.toContain('href=');
  });

  it('reflects open, closed and locked categories after publication', async () => {
    platform({
      detail: managed({
        status: 'PUBLISHED',
        nextStatuses: ['ACTIVE', 'CANCELLED'],
        events: [
          event({ status: 'REGISTRATION_OPEN' }),
          event({ id: 'e-2', name: 'Women Open', status: 'FIELD_LOCKED' }),
        ],
      }),
    });
    const out = html(await Hub({ ...pc(), ...sp() }));
    expect(stage(out, 'registrations')?.[1]).toBe('open');
    expect(stage(out, 'registrations')?.[2]).toContain(
      '1 category open · 8 confirmed · 2 waitlisted',
    );
    expect(stage(out, 'structure')?.[1]).toBe('progress');
    expect(stage(out, 'structure')?.[2]).toContain('1/2 fields locked');
    expect(stage(out, 'public')?.[1]).toBe('ready');
    expect(stage(out, 'public')?.[2]).toContain('href="/competitions/autumn-open"');
  });

  it('surfaces the next useful step with a real destination', async () => {
    platform();
    let out = html(await Hub({ ...pc(), ...sp() }));
    // The one category has no closing date yet.
    expect(out).toContain('Finish the review');
    expect(out).toContain('Every category has a registration window');

    platform({ detail: managed({ events: [] }) });
    out = html(await Hub({ ...pc(), ...sp() }));
    expect(out).toMatch(/Add your first category.*href="[^"]*\/categories\/new"/);

    platform({
      detail: managed({ status: 'PUBLISHED', events: [event({ status: 'REGISTRATION_OPEN' })] }),
    });
    out = html(await Hub({ ...pc(), ...sp() }));
    expect(out).toMatch(/Manage registrations.*href="[^"]*\/registrations"[^>]*>Go/);

    platform({
      detail: managed({ status: 'PUBLISHED', events: [event({ status: 'REGISTRATION_CLOSED' })] }),
    });
    out = html(await Hub({ ...pc(), ...sp() }));
    expect(out).toContain('Lock the field for Men Open');
    expect(out).toContain(
      `class="btn btn-cyan btn-sm" href="${BASE}/categories/${EVENT}/structure">Go`,
    );

    platform({
      detail: managed({ status: 'ACTIVE', events: [event({ status: 'IN_PROGRESS' })] }),
      resources: [court(COURT_1, 'Court 1')],
      facts: [weekly(null, '01')],
    });
    out = html(await Hub({ ...pc(), ...sp() }));
    expect(out).toMatch(/Build the schedule.*href="[^"]*\/schedule"[^>]*>Go/);
    expect(out).toContain('Generate a proposal, review it, then commit and publish it.');

    platform({
      detail: managed({ status: 'ACTIVE', events: [event({ status: 'IN_PROGRESS' })] }),
      resources: [court(COURT_1, 'Court 1')],
      facts: [weekly(null, '01')],
      versions: [version(1, 'PUBLISHED')],
    });
    out = html(await Hub({ ...pc(), ...sp() }));
    expect(out).toContain('Schedule published');
    expect(out).toContain('Match operations and results come to the web app in a later release.');
  });

  it('keeps the existing builder navigation and adds the tournament nav', async () => {
    platform();
    const out = html(await Hub({ ...pc(), ...sp() }));
    expect(out).toContain(`href="${BASE}/edit"`);
    expect(out).toContain(`href="${BASE}/registrations"`);
    expect(out).toContain(`href="${BASE}/categories/new"`);
    expect(out).toContain(`href="${BASE}/categories/${EVENT}"`);
    expect(out).toContain('aria-label="Tournament builder"');
    expect(out).toContain('value="publish"');
    expect(out).toContain('aria-label="Tournament"');
    expect(out).toMatch(/href="[^"]*" data-key="overview" aria-current="page"/);
    expect(out).toContain(`href="${STAFF_PAGE}" data-key="staff"`);
  });

  it('never links to workflow slices that have no route yet', async () => {
    platform({ detail: managed({ status: 'PUBLISHED' }) });
    for (const out of [
      html(await Hub({ ...pc(), ...sp() })),
      html(await Staff({ ...pc(), ...sp() })),
    ]) {
      expect(out).not.toMatch(/href="[^"]*\/(operations|results)["/?#]/);
      expect(out).toContain(`href="${BASE}/resources" data-key="resources"`);
      expect(out).not.toMatch(/aria-disabled="true" data-key="resources"/);
      // ONCF-L3: the schedule has its page now.
      expect(out).toContain(`href="${BASE}/schedule" data-key="schedule"`);
      expect(out).not.toMatch(/aria-disabled="true" data-key="schedule"/);
      expect(out).toMatch(/aria-disabled="true" data-key="operations"/);
    }
  });

  it('a draft has no public link; registrations stay unavailable until a category exists', async () => {
    platform({ detail: managed({ events: [] }) });
    const out = html(await Hub({ ...pc(), ...sp() }));
    expect(out).toMatch(/aria-disabled="true" data-key="public"/);
    expect(out).toMatch(/aria-disabled="true" data-key="registrations"/);
    expect(out).not.toContain('href="/competitions/autumn-open"');
  });

  it('the Hub still renders when the staff list is unavailable', async () => {
    platform({ staff: null });
    const out = html(await Hub({ ...pc(), ...sp() }));
    expect(stage(out, 'staff')?.[2]).toContain('Organization owners &amp; admins');
  });

  it('a tournament that cannot be loaded shows an error state, not a fake hub', async () => {
    platform({ detail: null });
    const out = html(await Hub({ ...pc(), ...sp() }));
    expect(out).toContain('This tournament can’t be loaded right now.');
    expect(out).not.toContain('Tournament workflow');
  });

  it('the registrations page carries the same tournament nav', async () => {
    platform();
    const out = html(await Registrations({ ...pc(), ...sp() }));
    expect(out).toMatch(/data-key="registrations" aria-current="page"/);
  });
});

// ───────────────────────────── hub · resources (ONCF-L2) ─────────────────────────────

describe('Competition Hub resources stage', () => {
  const live = () => managed({ status: 'ACTIVE', events: [event({ status: 'IN_PROGRESS' })] });

  it('is ready only when every active resource has declared hours (resource or tournament-wide)', async () => {
    platform({
      resources: [court(COURT_1, 'Court 1'), court(COURT_2, 'Court 2', 'RETIRED')],
      facts: [weekly(COURT_1, '01')],
    });
    let out = html(await Hub({ ...pc(), ...sp() }));
    expect(stage(out, 'resources')?.[1]).toBe('ready');
    expect(stage(out, 'resources')?.[2]).toContain('1 active · all have declared hours');

    // Tournament-wide hours declare time for every resource.
    platform({
      resources: [court(COURT_1, 'Court 1'), court(COURT_2, 'Court 2')],
      facts: [weekly(null, '01')],
    });
    out = html(await Hub({ ...pc(), ...sp() }));
    expect(stage(out, 'resources')?.[1]).toBe('ready');
    expect(stage(out, 'resources')?.[2]).toContain('2 active');
  });

  it('flags resources without declared hours and points the next step at them', async () => {
    platform({
      detail: live(),
      resources: [court(COURT_1, 'Court 1'), court(COURT_2, 'Court 2')],
      facts: [weekly(COURT_1, '01')],
    });
    const out = html(await Hub({ ...pc(), ...sp() }));
    expect(stage(out, 'resources')?.[1]).toBe('attention');
    expect(stage(out, 'resources')?.[2]).toContain('2 active · 1 without hours');
    expect(out).toContain('Declare resource hours');
    expect(out).toContain('Scheduling won’t use Court 2 until hours are declared.');
    expect(out).toContain(`class="btn btn-cyan btn-sm" href="${BASE}/resources">Go`);
  });

  it('a closure or blackout alone declares no hours', async () => {
    platform({
      resources: [court(COURT_1, 'Court 1')],
      facts: [
        {
          availabilityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa09',
          scope: 'RESOURCE',
          resourceId: COURT_1,
          kind: 'DATE_CLOSED',
          date: '2026-11-15',
          recordedAt: '2026-10-08T00:00:00.000Z',
        },
      ],
    });
    const out = html(await Hub({ ...pc(), ...sp() }));
    expect(stage(out, 'resources')?.[1]).toBe('attention');
    expect(stage(out, 'resources')?.[2]).toContain('1 without hours');
  });

  it('names categories without a resource of a type their sport uses', async () => {
    platform({
      detail: live(),
      resources: [{ ...court(COURT_1, 'Centre court'), typeCode: 'TENNIS_COURT' }],
      facts: [weekly(null, '01')],
    });
    const out = html(await Hub({ ...pc(), ...sp() }));
    expect(stage(out, 'resources')?.[1]).toBe('attention');
    expect(stage(out, 'resources')?.[2]).toContain('none for Men Open');
    expect(out).toContain('Add your resources');
  });

  it('a view-only role sees the stage but gets no resource next step', async () => {
    platform({
      detail: managed({
        status: 'ACTIVE',
        events: [event({ status: 'IN_PROGRESS' })],
        permissions: ['COMP_VIEW_PRIVATE', 'COMP_MANAGE_SCHEDULE', 'COMP_MANAGE_LINEUPS'],
        staffRoles: ['SCHEDULER'],
      }),
    });
    const out = html(await Hub({ ...pc(), ...sp() }));
    expect(stage(out, 'resources')?.[1]).toBe('attention');
    // A scheduler can't add courts; its own next step is the schedule (which lists what's missing).
    expect(out).toContain('Build the schedule');
    expect(out).not.toContain('Add your resources');
  });

  it('still renders, linked, when resources cannot be loaded', async () => {
    platform({ resources: null });
    const out = html(await Hub({ ...pc(), ...sp() }));
    expect(stage(out, 'resources')?.[1]).toBe('todo');
    expect(stage(out, 'resources')?.[2]).toContain('Can’t be loaded right now');
    expect(stage(out, 'resources')?.[2]).toContain(`href="${BASE}/resources"`);
  });
});

// ───────────────────────────── schedule stage (ONCF-L3) ─────────────────────────────

describe('Competition Hub schedule stage', () => {
  const locked = () => managed({ status: 'ACTIVE', events: [event({ status: 'FIELD_LOCKED' })] });
  const ready = { resources: [court(COURT_1, 'Court 1')], facts: [weekly(null, '01')] };

  it('is not started, linked, once a field is locked and nothing is scheduled', async () => {
    platform({ detail: locked(), ...ready });
    const out = html(await Hub({ ...pc(), ...sp() }));
    expect(stage(out, 'schedule')?.[1]).toBe('todo');
    expect(stage(out, 'schedule')?.[2]).toContain('Not started');
    expect(stage(out, 'schedule')?.[2]).toContain(`href="${BASE}/schedule"`);
    expect(out).toContain('Build the schedule');
  });

  it('shows a private draft as in progress and asks to finish it', async () => {
    platform({ detail: locked(), ...ready, versions: [version(1, 'DRAFT')] });
    const out = html(await Hub({ ...pc(), ...sp() }));
    expect(stage(out, 'schedule')?.[1]).toBe('progress');
    expect(stage(out, 'schedule')?.[2]).toContain('Draft · not published');
    expect(out).toContain('Finish the draft schedule');
    expect(out).toContain('Review its conflicts and publish it to make it official.');
  });

  it('is ready once published, and says when a new draft is open', async () => {
    platform({ detail: locked(), ...ready, versions: [version(1, 'PUBLISHED')] });
    let out = html(await Hub({ ...pc(), ...sp() }));
    expect(stage(out, 'schedule')?.[1]).toBe('ready');
    expect(stage(out, 'schedule')?.[2]).toContain('Published · version 1');

    platform({
      detail: locked(),
      ...ready,
      versions: [version(2, 'DRAFT'), version(1, 'PUBLISHED')],
    });
    out = html(await Hub({ ...pc(), ...sp() }));
    expect(stage(out, 'schedule')?.[1]).toBe('progress');
    expect(stage(out, 'schedule')?.[2]).toContain('Version 1 published · draft open');
  });

  it('never asks a role without schedule permission to build it', async () => {
    platform({
      detail: managed({
        status: 'ACTIVE',
        events: [event({ status: 'FIELD_LOCKED' })],
        permissions: ['COMP_VIEW_PRIVATE', 'COMP_OPEN_REGISTRATION', 'COMP_MANAGE_REGISTRATIONS'],
        staffRoles: ['REGISTRATION_MANAGER'],
      }),
      ...ready,
    });
    const out = html(await Hub({ ...pc(), ...sp() }));
    expect(stage(out, 'schedule')?.[2]).toContain(`href="${BASE}/schedule"`);
    expect(out).not.toContain('Build the schedule');
    expect(out).toContain('Structure is set');
  });

  it('still renders, linked, when the schedule cannot be loaded', async () => {
    platform({ detail: locked(), ...ready, versions: null });
    const out = html(await Hub({ ...pc(), ...sp() }));
    expect(stage(out, 'schedule')?.[1]).toBe('todo');
    expect(stage(out, 'schedule')?.[2]).toContain('Can’t be loaded right now');
    expect(stage(out, 'schedule')?.[2]).toContain(`href="${BASE}/schedule"`);
    expect(out).not.toContain('Build the schedule');
  });
});

// ───────────────────────────── staff page ─────────────────────────────

describe('tournament staff page', () => {
  it('lists the current staff with names, role labels and duties', async () => {
    platform();
    const out = html(await Staff({ ...pc(), ...sp() }));
    expect(out).toContain('Ana Rojas');
    expect(out).toContain('href="/athletes/ana-rojas"');
    expect(out).toContain('Person without a public profile');
    expect(out).toContain('>Registration manager<');
    expect(out).toContain('>Scheduler<');
    expect(out).toContain('Registration and participants');
    expect(out).toContain('Since Oct 7, 2026');
    expect(out).toMatch(/class="tb-count">2</);
    // Organizer owners/admins appear as implicit tournament owners/admins.
    expect(out).toContain('Through the organization');
    expect(out).toMatch(/Olga Owner<span class="muted"> · you<\/span>/);
  });

  it('renders every role label and the role guide', () => {
    expect(staffLib.STAFF_ROLES.map((r) => staffLib.STAFF_ROLE_LABEL[r])).toEqual([
      'Owner',
      'Admin',
      'Registration manager',
      'Scheduler',
    ]);
    expect(staffLib.STAFF_ROLE_DUTY.OWNER.summary).toBe('Full tournament control');
    expect(staffLib.STAFF_ROLE_DUTY.ADMIN.detail).toContain('Cannot change staff');
  });

  it('an owner gets the add form (active members, one per person) and remove confirmations', async () => {
    platform();
    const out = html(await Staff({ ...pc(), ...sp() }));
    expect(out).toContain('Add staff');
    expect(out).toContain(`<option value="${ANA}">Ana Rojas · /athletes/ana-rojas</option>`);
    expect(out).toContain(
      `<option value="${BEN}">Member without a public profile (66666666)</option>`,
    );
    expect(out).not.toContain('Gone Person');
    for (const r of ['OWNER', 'ADMIN', 'REGISTRATION_MANAGER', 'SCHEDULER'])
      expect(out).toContain(`value="${r}"`);
    expect(out).toMatch(/name="key" value="[^"]+"/);
    expect(out.match(/Confirm removal/g)?.length).toBe(2);
    expect(out).toContain(`name="staffId" value="${S_ANA}"`);
    expect(out).toContain('Remove Ana Rojas as Registration manager?');
  });

  it('a caller without COMP_MANAGE_STAFF sees the staff but no management actions', async () => {
    platform({ detail: managed({ permissions: COMP_ADMIN, staffRoles: ['ADMIN'] }) });
    const out = html(await Staff({ ...pc(), ...sp() }));
    expect(out).toContain('Ana Rojas');
    expect(out).toContain('View only');
    expect(out).not.toContain('Add to staff');
    expect(out).not.toContain('name="personId"');
    expect(out).not.toContain('Confirm removal');
  });

  it('an empty staff list explains who already has access', async () => {
    platform({ staff: [] });
    const out = html(await Staff({ ...pc(), ...sp() }));
    expect(out).toContain('No staff assigned yet');
    expect(out).toContain('Organization owners and admins already run this tournament.');
    expect(out).not.toContain('Confirm removal');
  });

  it('a staff list the API cannot return shows an error state', async () => {
    platform({ staff: null });
    const out = html(await Staff({ ...pc(), ...sp() }));
    expect(out).toContain('Staff can’t be loaded right now.');
    expect(out).not.toContain('No staff assigned yet');
  });

  it('with no roster nobody can be picked, and the page says so', async () => {
    platform({ roster: null });
    const out = html(await Staff({ ...pc(), ...sp() }));
    expect(out).toContain('The organization roster is unavailable');
    expect(out).not.toContain('name="personId"');
  });

  it('renders action outcomes from the fixed vocabulary', async () => {
    platform();
    expect(html(await Staff({ ...pc(), ...sp({ notice: 'staff_added' }) }))).toContain(
      'Staff member added.',
    );
    expect(html(await Staff({ ...pc(), ...sp({ error: 'staff_duplicate' }) }))).toContain(
      'That person already has this role in the tournament.',
    );
  });

  it('a tournament the API refuses is a 404', async () => {
    platform();
    routes[`GET /v1/competitions/${COMP}/manage`] = () => err(403, 'FORBIDDEN');
    expect(await outcome(() => Staff({ ...pc(), ...sp() }))).toBe('404');
  });
});

// ───────────────────────────── staff actions ─────────────────────────────

describe('staff actions', () => {
  const add = (o: Record<string, string> = {}) =>
    form({
      slug: 'club-uno',
      competitionId: COMP,
      personId: ANA,
      role: 'SCHEDULER',
      key: 'oc-0123456789abcdef0123456789abcdef',
      ...o,
    });

  it('adds staff through the canonical command with the form’s idempotency key', async () => {
    platform();
    routes[`POST /v1/competitions/${COMP}/staff`] = () =>
      json(201, { staffId: S_ANA, created: true });
    expect(await outcome(() => actions.addStaffAction(add()))).toBe(
      `${STAFF_PAGE}?notice=staff_added`,
    );
    expect(writes()).toEqual([
      {
        method: 'POST',
        path: `/v1/competitions/${COMP}/staff`,
        key: 'oc-0123456789abcdef0123456789abcdef',
        body: { personId: ANA, role: 'SCHEDULER' },
      },
    ]);
  });

  it('maps API refusals and never sends invalid input', async () => {
    platform();
    for (const [code, status, expected] of [
      ['ALREADY_EXISTS', 409, 'staff_duplicate'],
      ['FORBIDDEN', 403, 'staff_not_permitted'],
      ['NOT_FOUND', 404, 'staff_not_found'],
      ['INVALID_INPUT', 400, 'staff_invalid'],
    ] as const) {
      routes[`POST /v1/competitions/${COMP}/staff`] = () => err(status, code);
      expect(await outcome(() => actions.addStaffAction(add()))).toBe(
        `${STAFF_PAGE}?error=${expected}`,
      );
    }
    routes[`POST /v1/competitions/${COMP}/staff`] = () => json(503, {});
    expect(await outcome(() => actions.addStaffAction(add()))).toBe(
      `${STAFF_PAGE}?error=platform_unavailable`,
    );

    calls = [];
    expect(await outcome(() => actions.addStaffAction(add({ role: 'REFEREE' })))).toBe(
      `${STAFF_PAGE}?error=staff_invalid`,
    );
    expect(await outcome(() => actions.addStaffAction(add({ personId: 'nope' })))).toBe(
      `${STAFF_PAGE}?error=staff_invalid`,
    );
    expect(writes()).toEqual([]);
  });

  it('removes staff with DELETE /v1/competition-staff/:id (204)', async () => {
    platform();
    routes[`DELETE /v1/competition-staff/${S_ANA}`] = () => new Response(null, { status: 204 });
    expect(
      await outcome(() =>
        actions.removeStaffAction(form({ slug: 'club-uno', competitionId: COMP, staffId: S_ANA })),
      ),
    ).toBe(`${STAFF_PAGE}?notice=staff_removed`);
    expect(writes()).toEqual([
      {
        method: 'DELETE',
        path: `/v1/competition-staff/${S_ANA}`,
        key: undefined,
        body: undefined,
      },
    ]);
  });

  it('reports removal failures and never sends a malformed id', async () => {
    platform();
    const remove = () =>
      actions.removeStaffAction(form({ slug: 'club-uno', competitionId: COMP, staffId: S_ANA }));
    routes[`DELETE /v1/competition-staff/${S_ANA}`] = () => err(409, 'INVALID_TRANSITION');
    expect(await outcome(remove)).toBe(`${STAFF_PAGE}?error=staff_already_removed`);
    routes[`DELETE /v1/competition-staff/${S_ANA}`] = () => err(403, 'FORBIDDEN');
    expect(await outcome(remove)).toBe(`${STAFF_PAGE}?error=staff_not_permitted`);

    calls = [];
    expect(
      await outcome(() =>
        actions.removeStaffAction(
          form({ slug: 'club-uno', competitionId: COMP, staffId: '../competitions' }),
        ),
      ),
    ).toBe(`${STAFF_PAGE}?error=staff_not_found`);
    expect(writes()).toEqual([]);
  });
});
