import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RESOURCE_TYPE_ATTRIBUTES as DOMAIN_ATTRIBUTES,
  RESOURCE_TYPE_DEFAULT_OCCUPANCY_MODE as DOMAIN_DEFAULT_MODE,
  RESOURCE_TYPES as DOMAIN_TYPES,
} from '../../../../packages/competition/src/resources/resource';
import {
  expandAvailability,
  type AvailabilityFact,
} from '../../../../packages/competition/src/resources/availability';
import {
  categoryResourceTypes,
  layerDeclares,
  offeredTypes,
  parseAvailabilityForm,
  parseResourceForm,
  previewDays,
  readinessOf,
  RESOURCE_TYPE_ATTRIBUTES,
  RESOURCE_TYPE_DEFAULT_OCCUPANCY_MODE,
  RESOURCE_TYPES,
  resourceSummary,
  strictLocalInstant,
  weeklyLine,
  weeklySummary,
  windowText,
  type AvailabilityFactView,
  type ResourceView,
} from '../_lib/resources';
import type { Catalog, ManagedEvent } from '../_lib/tournaments';

// ONCF-L2 resources and availability: the web surface over the ONCF-05E-A API, rendered and
// exercised against a fake session + fake platform API. The API stays the authority; these tests
// prove the presentation (hours, readiness, the 7-day preview), the strict local-time conversion,
// the complete PUT body, the actions' commands and keys, and parity with the domain's data.

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
  notFound: () => {
    throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
  },
}));
vi.mock('../_product/submit-button', () => ({
  SubmitButton: ({ children }: { children: ReactNode }) => (
    <button type="submit">{children}</button>
  ),
}));

const Page = (await import('../app/orgs/[slug]/tournaments/[competitionId]/resources/page'))
  .default;
const actions = await import('../app/orgs/[slug]/tournaments/[competitionId]/resources/actions');

// ───────────────────────────── fixtures ─────────────────────────────

const ORG = '0b9b4b8e-6f0a-4f3e-9d6a-1c2b3c4d5e6f';
const COMP = '22222222-2222-4222-8222-222222222222';
const EVENT = '33333333-3333-4333-8333-333333333333';
const C1 = '99999999-9999-4999-8999-999999999991';
const C2 = '99999999-9999-4999-8999-999999999992';
const C3 = '99999999-9999-4999-8999-999999999993';
const C4 = '99999999-9999-4999-8999-999999999994';
const C5 = '99999999-9999-4999-8999-999999999995';
const AV = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const KEY = 'oc-0123456789abcdef0123456789abcdef';
const OWNER = ['COMP_EDIT', 'COMP_VIEW_PRIVATE', 'COMP_MANAGE_SCHEDULE', 'COMP_MANAGE_STAFF'];
const SCHEDULER = ['COMP_VIEW_PRIVATE', 'COMP_MANAGE_SCHEDULE', 'COMP_MANAGE_LINEUPS'];
const REG_MANAGER = [
  'COMP_VIEW_PRIVATE',
  'COMP_OPEN_REGISTRATION',
  'COMP_CLOSE_REGISTRATION',
  'COMP_MANAGE_REGISTRATIONS',
];

function event(o: Partial<{ code: string; name: string; status: string }> = {}) {
  return {
    id: EVENT,
    slug: 'men-open',
    status: o.status ?? 'REGISTRATION_OPEN',
    entrantKind: 'TEAM',
    discipline: {
      versionId: 'dv',
      sport: { code: 'padel', name: 'Padel' },
      code: o.code ?? 'padel.doubles',
      name: 'Padel doubles',
      version: 1,
    },
    format: { versionId: 'fv', code: 'se', name: 'Single elimination', version: 1, engine: 'x' },
    formatConfig: {},
    settings: {
      name: o.name ?? 'Men Open',
      category: {},
      capacity: 16,
      registrationMode: 'AUTO_CONFIRM',
      registrationOpensAt: null,
      registrationClosesAt: null,
      startsAt: null,
      endsAt: null,
      timezone: 'America/Costa_Rica',
    },
    counts: { confirmed: 0, waitlisted: 0, participants: 0 },
    editable: { settings: true, capacityAndRegistrationMode: true },
    nextStatuses: [],
    createdAt: '2026-10-06T00:00:00Z',
    updatedAt: '2026-10-06T00:00:00Z',
    statusChangedAt: '2026-10-06T00:00:00Z',
  };
}

function managed(o: Partial<{ status: string; permissions: string[]; events: unknown[] }> = {}) {
  return {
    competition: {
      id: COMP,
      slug: 'club-open',
      organizerOrganizationId: ORG,
      status: o.status ?? 'PUBLISHED',
      profile: {
        name: 'Club Padel Open',
        description: null,
        locationLabel: 'Club Uno',
        regionCode: 'CR',
        timezone: 'America/Costa_Rica',
        // Sat 14 Nov 2026, 08:00 local (UTC−6).
        startsAt: '2026-11-14T14:00:00.000Z',
        endsAt: '2026-11-16T02:00:00.000Z',
        website: null,
      },
      editable: { profile: true, addEvents: true },
      nextStatuses: [],
      createdAt: '2026-10-06T00:00:00Z',
      updatedAt: '2026-10-06T00:00:00Z',
      statusChangedAt: '2026-10-06T00:00:00Z',
    },
    events: o.events ?? [event()],
    access: { staffRoles: ['OWNER'], permissions: o.permissions ?? OWNER },
  };
}

function court(id: string, label: string, o: Partial<ResourceView> = {}): ResourceView {
  return {
    resourceId: id,
    competitionId: COMP,
    typeCode: 'PADEL_COURT',
    revision: 1,
    label,
    attributes: {},
    capacity: 1,
    occupancyMode: 'EXCLUSIVE',
    exclusivityKeys: [],
    venueOrganizationId: null,
    locationLabel: null,
    timezone: null,
    status: 'ACTIVE',
    updatedAt: '2026-10-08T00:00:00.000Z',
    ...o,
  };
}

const base = { recordedAt: '2026-10-08T00:00:00.000Z' };
const scope = (resourceId: string | null) => ({
  scope: resourceId === null ? ('COMPETITION' as const) : ('RESOURCE' as const),
  resourceId,
});
const wk = (n: number, resourceId: string | null, weekday: number, start: string, end: string) =>
  ({
    availabilityId: AV(n),
    ...scope(resourceId),
    kind: 'WEEKLY',
    weekday,
    start,
    end,
    ...base,
  }) as AvailabilityFactView;

// The padel-club scenario: four courts, weekday hours on three, Court 4 without hours, a closed
// day and a maintenance period on Court 1, and a retired court.
const CLUB_COURTS: ResourceView[] = [
  court(C1, 'Court 1', { attributes: { indoor: true, lights: true }, locationLabel: 'Main hall' }),
  court(C2, 'Court 2', { attributes: { indoor: false } }),
  court(C3, 'Court 3'),
  court(C4, 'Court 4'),
  court(C5, 'Old court', { status: 'RETIRED' }),
];
const CLUB_FACTS: AvailabilityFactView[] = [
  ...[1, 2, 3, 4, 5].map((d) => wk(d, C1, d, '08:00', '22:00')),
  ...[1, 2, 3, 4, 5].map((d) => wk(10 + d, C2, d, '08:00', '22:00')),
  wk(16, C1, 6, '08:00', '20:00'),
  wk(17, C3, 6, '09:00', '18:00'),
  { availabilityId: AV(20), ...scope(C1), kind: 'DATE_CLOSED', date: '2026-11-15', ...base },
  {
    availabilityId: AV(21),
    ...scope(C1),
    kind: 'MAINTENANCE',
    startsAt: '2026-11-14T20:00:00.000Z',
    endsAt: '2026-11-14T22:00:00.000Z',
    reason: 'Net replacement',
    ...base,
  },
];

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
    {
      disciplineVersionId: 'dv-run',
      sport: { code: 'running', name: 'Running' },
      discipline: { code: 'running.10k', name: '10K' },
      version: 1,
      specHash: 'h2',
      participantKinds: ['INDIVIDUAL'],
      lineupSize: { min: 1, max: 1 },
      allowedContestTypes: ['RACE'],
      compatibleFormatVersionIds: [],
      capabilities: {
        contestTypes: ['RACE'],
        participantKinds: ['INDIVIDUAL'],
        rulesetFamilies: [],
        partitionKinds: [],
        startMethods: [],
        multiRound: false,
        resourceTypes: ['ROAD_COURSE', 'TRACK'],
        entryAttributes: [],
      },
    },
  ],
  formatVersions: [],
} as unknown as Catalog;

// ───────────────────────────── fake platform ─────────────────────────────

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

/** Effective intervals for a resource: Sat 14 Nov 08:00–20:00 local, nothing else. */
const SAT_OPEN = { start: '2026-11-14T14:00:00.000Z', end: '2026-11-15T02:00:00.000Z' };

function platform(
  o: {
    detail?: ReturnType<typeof managed> | null;
    resources?: ResourceView[] | null;
    facts?: AvailabilityFactView[] | null;
    catalog?: unknown;
  } = {},
) {
  const detail = o.detail === undefined ? managed() : o.detail;
  const resources = o.resources === undefined ? CLUB_COURTS : o.resources;
  const facts = o.facts === undefined ? CLUB_FACTS : o.facts;
  const catalog = o.catalog === undefined ? CATALOG : o.catalog;
  routes = {
    'GET /v1/me': () =>
      json(200, {
        accountId: 'acc',
        accountActive: true,
        selfPersonId: 'p',
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
      json(200, { roles: ['OWNER'], permissions: ['ORG_MANAGE_COMPETITIONS'] }),
    [`GET /v1/competitions/${COMP}/manage`]: () =>
      detail === null ? json(503, {}) : json(200, detail),
    [`GET /v1/competitions/${COMP}/resources`]: () =>
      resources === null ? json(503, {}) : json(200, { items: resources }),
    [`GET /v1/competitions/${COMP}/availability`]: () =>
      facts === null ? json(503, {}) : json(200, { items: facts }),
    'GET /v1/catalog': () => (catalog === null ? json(503, {}) : json(200, catalog)),
  };
  for (const r of resources ?? []) {
    routes[`GET /v1/resources/${r.resourceId}`] = () => json(200, r);
    routes[`GET /v1/resources/${r.resourceId}/availability`] = () =>
      json(200, {
        resourceId: r.resourceId,
        timezone: 'America/Costa_Rica',
        status: r.status,
        intervals: r.resourceId === C4 ? [] : [SAT_OPEN],
      });
  }
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
const form = (fields: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields))
    for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return f;
};
const writes = () => calls.filter((c) => c.method !== 'GET');
const BACK = `/app/orgs/club-uno/tournaments/${COMP}/resources`;
/** The `<li>` of one resource (its readiness and contents). */
const row = (out: string, label: string) =>
  new RegExp(
    `<li data-readiness="([a-z-]+)"><details class="res-item"><summary><span class="res-item-id"><strong>${label}</strong>(.*?)</details></li>`,
  ).exec(out);

// ───────────────────────────── domain parity ─────────────────────────────

describe('parity with @br/competition', () => {
  it('mirrors the resource types, the closed attribute schema and the default occupancy modes', () => {
    expect([...RESOURCE_TYPES].sort()).toEqual([...DOMAIN_TYPES].sort());
    expect(RESOURCE_TYPE_ATTRIBUTES).toEqual(DOMAIN_ATTRIBUTES);
    expect(RESOURCE_TYPE_DEFAULT_OCCUPANCY_MODE).toEqual(DOMAIN_DEFAULT_MODE);
  });

  it('declares time exactly when the domain layer declares time (ADR-0074 D8)', () => {
    const horizon = [Date.parse('2026-01-01T00:00:00Z'), Date.parse('2027-01-01T00:00:00Z')];
    const cases: AvailabilityFact[][] = [
      [],
      [{ kind: 'WEEKLY', weekday: 1, start: '08:00', end: '18:00' }],
      [{ kind: 'DATE_OPEN', date: '2026-11-14', start: '09:00', end: '17:00' }],
      [{ kind: 'DATE_CLOSED', date: '2026-11-15' }],
      [
        {
          kind: 'BLACKOUT',
          startsAt: horizon[0] as number,
          endsAt: (horizon[0] as number) + 3_600_000,
          reason: 'x',
        },
      ],
      [
        { kind: 'DATE_CLOSED', date: '2026-11-15' },
        {
          kind: 'MAINTENANCE',
          startsAt: horizon[0] as number,
          endsAt: (horizon[0] as number) + 1,
          reason: 'y',
        },
      ],
      [
        { kind: 'WEEKLY', weekday: 6, start: '22:00', end: '02:00' },
        { kind: 'DATE_CLOSED', date: '2026-11-14' },
      ],
    ];
    for (const facts of cases) {
      const domain = expandAvailability(
        {
          status: 'ACTIVE',
          resource: { zone: 'America/Costa_Rica', facts },
          competition: { zone: 'America/Costa_Rica', facts: [] },
        },
        horizon[0] as number,
        horizon[1] as number,
      ).declared;
      expect(layerDeclares(facts)).toBe(domain.length > 0);
    }
  });
});

// ───────────────────────────── hours presentation ─────────────────────────────

describe('hours summary', () => {
  it('merges identical windows on consecutive weekdays', () => {
    const facts = [1, 2, 3, 4, 5].map((d) => wk(d, C1, d, '08:00', '18:00'));
    facts.push(wk(6, C1, 6, '09:00', '14:00'), wk(7, C1, 7, '09:00', '14:00'));
    expect(weeklyLine(facts)).toBe('Mon–Fri 08:00–18:00 · Sat, Sun 09:00–14:00');
  });

  it('keeps gaps and several windows per day apart', () => {
    const facts = [
      wk(1, C1, 1, '08:00', '12:00'),
      wk(2, C1, 1, '14:00', '20:00'),
      wk(3, C1, 3, '08:00', '12:00'),
      wk(4, C1, 3, '14:00', '20:00'),
    ];
    expect(weeklySummary(facts)).toEqual([
      { days: 'Mon', windows: ['08:00–12:00', '14:00–20:00'], validity: null },
      { days: 'Wed', windows: ['08:00–12:00', '14:00–20:00'], validity: null },
    ]);
  });

  it('shows windows that cross midnight and 24:00 as declared', () => {
    expect(windowText('22:00', '02:00')).toBe('22:00–02:00 next day');
    expect(windowText('18:00', '24:00')).toBe('18:00–24:00');
    expect(windowText('00:00', '24:00')).toBe('00:00–24:00');
    expect(weeklyLine([wk(1, C1, 5, '20:00', '01:00')])).toBe('Fri 20:00–01:00 next day');
  });

  it('keeps validity ranges in their own rows', () => {
    const facts = [{ ...wk(1, C1, 1, '08:00', '18:00'), validFrom: '2026-11-01' }];
    expect(weeklySummary(facts)[0]?.validity).toBe('from Sun 1 Nov 2026');
  });

  it('regroups effective intervals per local day for the preview', () => {
    const days = previewDays(
      [SAT_OPEN, { start: '2026-11-15T22:00:00.000Z', end: '2026-11-16T07:00:00.000Z' }],
      '2026-11-14',
      'America/Costa_Rica',
      3,
    );
    expect(days.map((d) => [d.label, d.windows])).toEqual([
      ['Sat 14 Nov', ['08:00–20:00']],
      ['Sun 15 Nov', ['16:00–24:00']],
      ['Mon 16 Nov', ['00:00–01:00']],
    ]);
  });
});

// ───────────────────────────── readiness ─────────────────────────────

describe('readiness', () => {
  const needs = (types: string[]) =>
    categoryResourceTypes(
      [
        event({ code: types[0] === 'ROAD_COURSE' ? 'running.10k' : 'padel.doubles' }),
      ] as unknown as ManagedEvent[],
      CATALOG,
    );

  it('only WEEKLY or DATE_OPEN declare hours — "no rules" is not ready', () => {
    const r = court(C1, 'Court 1');
    expect(readinessOf(r, [])).toBe('no-hours');
    expect(readinessOf(r, [wk(1, C1, 1, '08:00', '18:00')])).toBe('ready');
    expect(
      readinessOf(r, [
        {
          availabilityId: AV(1),
          ...scope(C1),
          kind: 'DATE_OPEN',
          date: '2026-11-14',
          start: '09:00',
          end: '17:00',
          ...base,
        },
      ]),
    ).toBe('ready');
    expect(
      readinessOf(r, [
        { availabilityId: AV(2), ...scope(C1), kind: 'DATE_CLOSED', date: '2026-11-14', ...base },
      ]),
    ).toBe('no-hours');
    // Another resource's hours never count; tournament-wide hours always do.
    expect(readinessOf(r, [wk(3, C2, 1, '08:00', '18:00')])).toBe('no-hours');
    expect(readinessOf(r, [wk(4, null, 1, '08:00', '18:00')])).toBe('ready');
    expect(
      readinessOf(court(C1, 'Court 1', { status: 'RETIRED' }), [wk(5, C1, 1, '08:00', '18:00')]),
    ).toBe('retired');
  });

  it('summarizes active, retired, without hours and missing types', () => {
    const s = resourceSummary(CLUB_COURTS, CLUB_FACTS, needs(['PADEL_COURT']));
    expect(s).toEqual({ active: 4, retired: 1, ready: 3, needHours: ['Court 4'], missing: [] });
  });

  it('no resources, or retired-only, leaves every category without a resource', () => {
    expect(resourceSummary([], [], needs(['PADEL_COURT']))).toEqual({
      active: 0,
      retired: 0,
      ready: 0,
      needHours: [],
      missing: [{ category: 'Men Open', types: ['PADEL_COURT'] }],
    });
    const retiredOnly = resourceSummary(
      [court(C5, 'Old', { status: 'RETIRED' })],
      [],
      needs(['PADEL_COURT']),
    );
    expect(retiredOnly.active).toBe(0);
    expect(retiredOnly.missing).toHaveLength(1);
  });

  it('a category is covered by any type its discipline can use', () => {
    const run = needs(['ROAD_COURSE']);
    expect(run[0]?.types).toEqual(['ROAD_COURSE', 'TRACK']);
    expect(resourceSummary([court(C1, 'Track', { typeCode: 'TRACK' })], [], run).missing).toEqual(
      [],
    );
    expect(offeredTypes(run)).toEqual({ types: ['TRACK', 'ROAD_COURSE'], restricted: true });
    expect(offeredTypes([])).toEqual({ types: [...RESOURCE_TYPES], restricted: false });
  });
});

// ───────────────────────────── strict local time (R1) ─────────────────────────────

describe('strict local time → instant', () => {
  it('converts a normal Costa Rica time (fixed UTC−6)', () => {
    expect(strictLocalInstant('2026-11-14', '14:00', 'America/Costa_Rica')).toEqual({
      kind: 'ok',
      instant: '2026-11-14T20:00:00.000Z',
    });
  });

  it('refuses a New York time inside the spring-forward gap', () => {
    expect(strictLocalInstant('2026-03-08', '02:30', 'America/New_York')).toEqual({
      kind: 'skipped',
    });
    // Either side of the gap is fine.
    expect(strictLocalInstant('2026-03-08', '01:59', 'America/New_York')).toEqual({
      kind: 'ok',
      instant: '2026-03-08T06:59:00.000Z',
    });
    expect(strictLocalInstant('2026-03-08', '03:00', 'America/New_York')).toEqual({
      kind: 'ok',
      instant: '2026-03-08T07:00:00.000Z',
    });
  });

  it('refuses a New York time repeated by the fall-back fold', () => {
    expect(strictLocalInstant('2026-11-01', '01:30', 'America/New_York')).toEqual({
      kind: 'ambiguous',
    });
    expect(strictLocalInstant('2026-11-01', '02:00', 'America/New_York')).toEqual({
      kind: 'ok',
      instant: '2026-11-01T07:00:00.000Z',
    });
  });

  it('refuses malformed dates, times and zones', () => {
    expect(strictLocalInstant('2026-02-30', '10:00', 'UTC').kind).toBe('invalid');
    expect(strictLocalInstant('2026-02-10', '24:00', 'UTC').kind).toBe('invalid');
    expect(strictLocalInstant('2026-02-10', '10:00', 'CST').kind).toBe('invalid');
  });
});

// ───────────────────────────── form parsing ─────────────────────────────

describe('form parsing', () => {
  it('always produces the COMPLETE resource body (PUT replaces every field)', () => {
    const r = parseResourceForm(form({ label: 'Court 1' }), 'PADEL_COURT');
    expect(r).toEqual({
      ok: true,
      value: {
        label: 'Court 1',
        attributes: {},
        capacity: 1,
        occupancyMode: 'EXCLUSIVE',
        exclusivityKeys: [],
        venueOrganizationId: null,
        locationLabel: null,
        timezone: null,
      },
    });
  });

  it('reads booleans as tri-state (not specified / yes / no) and validates every attribute', () => {
    const p = (fields: Record<string, string>) =>
      parseResourceForm(form({ label: 'C', ...fields }), 'TENNIS_COURT');
    expect(p({ 'attr.indoor': 'false', 'attr.lights': '', 'attr.surface': 'CLAY' })).toMatchObject({
      ok: true,
      value: { attributes: { indoor: false, surface: 'CLAY' } },
    });
    expect(p({ 'attr.indoor': 'true' })).toMatchObject({ value: { attributes: { indoor: true } } });
    expect(p({ 'attr.indoor': 'yes' })).toEqual({ ok: false, error: 'resource_attribute' });
    expect(p({ 'attr.surface': 'ICE' })).toEqual({ ok: false, error: 'resource_attribute' });
    const golf = parseResourceForm(
      form({ label: 'G', 'attr.startingTees': '1, 10', 'attr.holes': '18' }),
      'GOLF_COURSE',
    );
    expect(golf).toMatchObject({ value: { attributes: { startingTees: [1, 10], holes: '18' } } });
    const pool = parseResourceForm(form({ label: 'P', 'attr.lanes': '13' }), 'POOL');
    expect(pool).toEqual({ ok: false, error: 'resource_attribute' });
  });

  it('refuses names, capacities, keys and zones the API would refuse', () => {
    const p = (fields: Record<string, string>) =>
      parseResourceForm(form({ label: 'Court', ...fields }), 'PADEL_COURT');
    expect(parseResourceForm(form({ label: '  ' }), 'PADEL_COURT')).toEqual({
      ok: false,
      error: 'resource_label',
    });
    expect(p({ capacity: '0' })).toEqual({ ok: false, error: 'resource_invalid' });
    expect(p({ capacity: '2.5' })).toEqual({ ok: false, error: 'resource_invalid' });
    expect(p({ exclusivityKeys: 'Main A' })).toMatchObject({
      ok: true,
      value: { exclusivityKeys: ['a', 'main'] },
    });
    expect(p({ exclusivityKeys: 'main_a' })).toEqual({ ok: false, error: 'resource_invalid' });
    expect(p({ timezone: 'EST' })).toEqual({ ok: false, error: 'resource_timezone' });
    expect(p({ timezone: 'America/New_York' })).toMatchObject({
      value: { timezone: 'America/New_York' },
    });
  });

  it('turns several weekdays into one weekly fact each, keeping crossing-midnight and 24:00', () => {
    const r = parseAvailabilityForm(
      form({ kind: 'WEEKLY', weekday: ['5', '1', '5'], start: '22:00', end: '02:00' }),
      'UTC',
    );
    expect(r).toEqual({
      ok: true,
      value: [
        { kind: 'WEEKLY', weekday: 1, start: '22:00', end: '02:00' },
        { kind: 'WEEKLY', weekday: 5, start: '22:00', end: '02:00' },
      ],
    });
    expect(
      parseAvailabilityForm(
        form({ kind: 'WEEKLY', weekday: '6', start: '18:00', untilMidnight: 'on' }),
        'UTC',
      ),
    ).toMatchObject({ value: [{ end: '24:00' }] });
  });

  it('refuses empty windows, missing days and reversed validity', () => {
    const p = (fields: Record<string, string | string[]>) =>
      parseAvailabilityForm(form(fields), 'UTC');
    expect(p({ kind: 'WEEKLY', weekday: '1', start: '08:00', end: '08:00' })).toEqual({
      ok: false,
      error: 'availability_window_empty',
    });
    expect(p({ kind: 'WEEKLY', start: '08:00', end: '18:00' })).toEqual({
      ok: false,
      error: 'availability_weekday',
    });
    expect(p({ kind: 'WEEKLY', weekday: '1', start: '8', end: '18:00' })).toEqual({
      ok: false,
      error: 'availability_time',
    });
    expect(
      p({
        kind: 'WEEKLY',
        weekday: '1',
        start: '08:00',
        end: '18:00',
        validFrom: '2026-12-01',
        validTo: '2026-11-01',
      }),
    ).toEqual({ ok: false, error: 'availability_dates' });
    expect(p({ kind: 'DATE_CLOSED', date: '2026-11-31' })).toEqual({
      ok: false,
      error: 'availability_invalid',
    });
    expect(p({ kind: 'DATE_CLOSED', date: '2026-10-25' })).toEqual({
      ok: true,
      value: [{ kind: 'DATE_CLOSED', date: '2026-10-25' }],
    });
  });

  it('converts maintenance strictly in the layer’s zone and requires a reason', () => {
    const m = (fields: Record<string, string>, zone = 'America/Costa_Rica') =>
      parseAvailabilityForm(
        form({
          kind: 'MAINTENANCE',
          startDate: '2026-11-14',
          startTime: '14:00',
          endTime: '16:00',
          reason: 'Resurfacing',
          ...fields,
        }),
        zone,
      );
    expect(m({})).toEqual({
      ok: true,
      value: [
        {
          kind: 'MAINTENANCE',
          startsAt: '2026-11-14T20:00:00.000Z',
          endsAt: '2026-11-14T22:00:00.000Z',
          reason: 'Resurfacing',
        },
      ],
    });
    expect(m({ reason: ' ' })).toEqual({ ok: false, error: 'reason_required' });
    expect(m({ endTime: '13:00' })).toEqual({ ok: false, error: 'availability_period_order' });
    expect(
      m(
        { startDate: '2026-03-08', startTime: '02:30', endDate: '2026-03-08', endTime: '05:00' },
        'America/New_York',
      ),
    ).toEqual({
      ok: false,
      error: 'availability_time_skipped',
    });
    expect(
      m(
        { startDate: '2026-11-01', startTime: '00:30', endDate: '2026-11-01', endTime: '01:30' },
        'America/New_York',
      ),
    ).toEqual({
      ok: false,
      error: 'availability_time_ambiguous',
    });
  });
});

// ───────────────────────────── page ─────────────────────────────

describe('resources page', () => {
  it('answers which courts can be scheduled, with hours, closures and maintenance', async () => {
    platform();
    const out = html(await Page({ ...pc(), ...sp() }));
    expect(out).toContain('3 of 4 active resources have declared hours');
    expect(out).toContain('<strong>No declared hours:</strong> Court 4.');
    expect(out).toMatch(/aria-label="Padel courts"><h4 class="mono muted">Padel courts · 4<\/h4>/);
    expect(row(out, 'Court 1')?.[1]).toBe('ready');
    expect(row(out, 'Court 1')?.[2]).toContain('Mon–Fri 08:00–22:00 · Sat 08:00–20:00');
    expect(row(out, 'Court 1')?.[2]).toContain('Main hall');
    expect(row(out, 'Court 1')?.[2]).toContain('<dd>Indoor</dd>');
    expect(row(out, 'Court 1')?.[2]).toContain(
      '<strong>Sun 15 Nov 2026</strong> · <span class="res-closed">Closed</span>',
    );
    expect(row(out, 'Court 1')?.[2]).toContain('Maintenance');
    expect(row(out, 'Court 1')?.[2]).toContain('Sat 14 Nov 14:00 – 16:00');
    expect(row(out, 'Court 1')?.[2]).toContain('Net replacement');
    expect(row(out, 'Court 4')?.[1]).toBe('no-hours');
    expect(row(out, 'Court 4')?.[2]).toContain(
      'This resource will not be used by scheduling until hours are declared.',
    );
    expect(out).not.toContain('No availability restrictions');
    // The 7-day preview, in the resource's zone, from the tournament's first day.
    expect(row(out, 'Court 2')?.[2]).toContain('Tournament’s first 7 days');
    expect(row(out, 'Court 2')?.[2]).toContain(
      '<span class="mono">Sat 14 Nov</span><span>08:00–20:00</span>',
    );
    expect(row(out, 'Court 2')?.[2]).toContain(
      '<span class="mono">Sun 15 Nov</span><span>Not available</span>',
    );
    // No technical identifiers or the legacy capacity-derived label as primary content.
    expect(out).not.toMatch(/>\s*SHARED_CAPACITY\s*</);
    expect(out).not.toContain('>Revision');
  });

  it('keeps retired resources in a collapsed group', async () => {
    platform();
    const out = html(await Page({ ...pc(), ...sp() }));
    expect(out).toMatch(
      /<details class="res-retired"><summary>Retired resources <span class="tb-count">1<\/span>/,
    );
    expect(row(out, 'Old court')?.[1]).toBe('retired');
    expect(row(out, 'Old court')?.[2]).toContain('Reactivate');
    expect(out).not.toMatch(/res-retired" open/);
  });

  it('an owner gets every change: add, edit (all fields), hours, retire', async () => {
    platform();
    const out = html(await Page({ ...pc(), ...sp({ add: 'PADEL_COURT' }) }));
    expect(out).toContain('Add a resource');
    expect(out).toContain('name="typeCode" value="PADEL_COURT"');
    expect(out).toContain('Add padel court');
    expect(row(out, 'Court 1')?.[2]).toContain('Edit details');
    expect(row(out, 'Court 1')?.[2]).toContain('Confirm retirement');
    expect(row(out, 'Court 1')?.[2]).toContain('+ Hours or closures');
    expect(row(out, 'Court 1')?.[2]).toContain('Times are in <strong>America/Costa Rica</strong>');
    for (const f of [
      'label',
      'capacity',
      'occupancyMode',
      'exclusivityKeys',
      'locationLabel',
      'timezone',
      'venueOrganizationId',
    ])
      expect(row(out, 'Court 1')?.[2]).toContain(`name="${f}"`);
    expect(out).toContain('Tournament-wide hours');
    expect(out).toMatch(/name="key" value="[^"]+"/);
  });

  it('offers only the types its categories use', async () => {
    platform();
    let out = html(await Page({ ...pc(), ...sp() }));
    expect(out).toContain('+ Padel court');
    expect(out).not.toContain('+ Tennis court');
    expect(out).toContain('Types your categories can be played on.');
    // An unknown type in the URL is not offered.
    out = html(await Page({ ...pc(), ...sp({ add: 'GOLF_COURSE' }) }));
    expect(out).not.toContain('name="typeCode" value="GOLF_COURSE"');
    // Without categories every type is offered.
    platform({ detail: managed({ events: [] }) });
    out = html(await Page({ ...pc(), ...sp() }));
    expect(out).toContain('+ Golf course');
  });

  for (const [role, permissions] of [
    ['scheduler', SCHEDULER],
    ['registration manager', REG_MANAGER],
  ] as const)
    it(`a ${role} sees resources and hours but no change`, async () => {
      platform({ detail: managed({ permissions: [...permissions] }) });
      const out = html(await Page({ ...pc(), ...sp({ add: 'PADEL_COURT' }) }));
      expect(out).toContain('View only');
      expect(row(out, 'Court 1')?.[2]).toContain('Mon–Fri 08:00–22:00');
      for (const control of [
        'Add a resource',
        'Edit details',
        'Confirm retirement',
        'Confirm removal',
        '+ Hours or closures',
        'name="typeCode"',
      ])
        expect(out).not.toContain(control);
    });

  it('a completed tournament is view only', async () => {
    platform({ detail: managed({ status: 'COMPLETED' }) });
    const out = html(await Page({ ...pc(), ...sp() }));
    expect(out).toContain('This tournament has ended');
    expect(out).not.toContain('Confirm removal');
  });

  it('an empty tournament explains what to do', async () => {
    platform({ resources: [], facts: [] });
    const out = html(await Page({ ...pc(), ...sp() }));
    expect(out).toContain('No resources yet');
    expect(out).toContain('Scheduling only uses resources with declared hours.');
    expect(out).toContain('No active resources yet');
    expect(out).toContain('<strong>Men Open:</strong> no active padel courts yet.');
  });

  it('resources that cannot be loaded show an error with a way back', async () => {
    platform({ resources: null });
    const out = html(await Page({ ...pc(), ...sp() }));
    expect(out).toContain('Resources can’t be loaded right now.');
    expect(out).toContain(`href="/app/orgs/club-uno/tournaments/${COMP}">tournament overview`);
    expect(out).not.toContain('No resources yet');
  });

  it('marks the nav and renders outcomes from the fixed vocabulary', async () => {
    platform();
    let out = html(await Page({ ...pc(), ...sp({ notice: 'resource_created' }) }));
    expect(out).toMatch(/data-key="resources" aria-current="page"/);
    expect(out).toContain('Resource added. Declare its hours so scheduling can use it.');
    out = html(await Page({ ...pc(), ...sp({ error: 'availability_time_skipped' }) }));
    expect(out).toContain('clocks move forward');
  });

  it('a tournament the API refuses is a 404', async () => {
    platform();
    routes[`GET /v1/competitions/${COMP}/manage`] = () => err(403, 'FORBIDDEN');
    expect(await outcome(() => Page({ ...pc(), ...sp() }))).toBe('404');
  });
});

// ───────────────────────────── actions ─────────────────────────────

const hidden = { slug: 'club-uno', competitionId: COMP, key: KEY };

describe('resource actions', () => {
  it('creates with the complete body and the form’s idempotency key', async () => {
    platform();
    routes[`POST /v1/competitions/${COMP}/resources`] = () =>
      json(201, { resourceId: C1, created: true });
    expect(
      await outcome(() =>
        actions.createResourceAction(
          form({ ...hidden, typeCode: 'PADEL_COURT', label: 'Court 5', 'attr.indoor': 'true' }),
        ),
      ),
    ).toBe(`${BACK}?notice=resource_created`);
    expect(writes()).toEqual([
      {
        method: 'POST',
        path: `/v1/competitions/${COMP}/resources`,
        key: KEY,
        body: {
          typeCode: 'PADEL_COURT',
          label: 'Court 5',
          attributes: { indoor: true },
          capacity: 1,
          occupancyMode: 'EXCLUSIVE',
          exclusivityKeys: [],
          venueOrganizationId: null,
          locationLabel: null,
          timezone: null,
        },
      },
    ]);
  });

  it('an edit always PUTs every field, keeping the venue it does not show', async () => {
    platform();
    const VENUE = '12121212-1212-4121-8121-121212121212';
    routes[`PUT /v1/resources/${C1}`] = () => json(200, { resourceId: C1, revision: 2 });
    expect(
      await outcome(() =>
        actions.updateResourceAction(
          form({
            ...hidden,
            resourceId: C1,
            typeCode: 'PADEL_COURT',
            venueOrganizationId: VENUE,
            label: 'Court 1',
            capacity: '1',
            occupancyMode: 'EXCLUSIVE',
            locationLabel: 'Main hall',
            timezone: '',
            exclusivityKeys: '',
            'attr.indoor': 'true',
            'attr.lights': '',
          }),
        ),
      ),
    ).toBe(`${BACK}?notice=resource_updated`);
    const [put] = writes();
    expect(put?.method).toBe('PUT');
    expect(Object.keys(put?.body as object).sort()).toEqual([
      'attributes',
      'capacity',
      'exclusivityKeys',
      'label',
      'locationLabel',
      'occupancyMode',
      'timezone',
      'venueOrganizationId',
    ]);
    expect(put?.body).toMatchObject({ venueOrganizationId: VENUE, locationLabel: 'Main hall' });
  });

  it('maps resource refusals and never sends invalid input', async () => {
    platform();
    const create = () =>
      actions.createResourceAction(form({ ...hidden, typeCode: 'PADEL_COURT', label: 'Court 1' }));
    for (const [code, status, expected] of [
      ['ALREADY_EXISTS', 409, 'resource_duplicate_label'],
      ['FORBIDDEN', 403, 'resource_not_permitted'],
      ['INVALID_TRANSITION', 409, 'resource_transition'],
      ['INVALID_INPUT', 400, 'resource_invalid'],
      ['IDEMPOTENCY_KEY_REUSED', 409, 'form_resubmitted'],
      ['NOT_FOUND', 404, 'resource_not_found'],
    ] as const) {
      routes[`POST /v1/competitions/${COMP}/resources`] = () => err(status, code);
      expect(await outcome(create)).toBe(`${BACK}?error=${expected}`);
    }
    routes[`POST /v1/competitions/${COMP}/resources`] = () => json(503, {});
    expect(await outcome(create)).toBe(`${BACK}?error=platform_unavailable`);

    calls = [];
    expect(
      await outcome(() =>
        actions.createResourceAction(form({ ...hidden, typeCode: 'SQUASH_COURT', label: 'S' })),
      ),
    ).toBe(`${BACK}?error=resource_type`);
    expect(
      await outcome(() =>
        actions.createResourceAction(form({ ...hidden, typeCode: 'PADEL_COURT', label: '' })),
      ),
    ).toBe(`${BACK}?error=resource_label`);
    expect(
      await outcome(() =>
        actions.updateResourceAction(
          form({ ...hidden, resourceId: '../x', typeCode: 'PADEL_COURT', label: 'C' }),
        ),
      ),
    ).toBe(`${BACK}?error=resource_not_found`);
    expect(writes()).toEqual([]);
  });

  it('retires and reactivates with a required reason', async () => {
    platform();
    routes[`POST /v1/resources/${C1}/retire`] = () =>
      json(200, { resourceId: C1, status: 'RETIRED' });
    routes[`POST /v1/resources/${C5}/reactivate`] = () =>
      json(200, { resourceId: C5, status: 'ACTIVE' });
    expect(
      await outcome(() =>
        actions.resourceStatusAction(
          form({ ...hidden, resourceId: C1, command: 'retire', reason: 'Closed for works' }),
        ),
      ),
    ).toBe(`${BACK}?notice=resource_retired`);
    expect(
      await outcome(() =>
        actions.resourceStatusAction(
          form({ ...hidden, resourceId: C5, command: 'reactivate', reason: 'Reopened' }),
        ),
      ),
    ).toBe(`${BACK}?notice=resource_reactivated`);
    expect(writes().map((w) => [w.path, w.key, w.body])).toEqual([
      [`/v1/resources/${C1}/retire`, KEY, { reason: 'Closed for works' }],
      [`/v1/resources/${C5}/reactivate`, KEY, { reason: 'Reopened' }],
    ]);

    calls = [];
    expect(
      await outcome(() =>
        actions.resourceStatusAction(
          form({ ...hidden, resourceId: C1, command: 'retire', reason: '  ' }),
        ),
      ),
    ).toBe(`${BACK}?error=reason_required`);
    expect(
      await outcome(() =>
        actions.resourceStatusAction(
          form({ ...hidden, resourceId: C1, command: 'delete', reason: 'x' }),
        ),
      ),
    ).toBe(`${BACK}?error=resource_invalid`);
    expect(writes()).toEqual([]);
  });
});

describe('availability actions', () => {
  it('several weekdays send one POST each, each with its own key', async () => {
    platform();
    routes[`POST /v1/competitions/${COMP}/availability`] = () =>
      json(201, { availabilityId: AV(99), created: true });
    expect(
      await outcome(() =>
        actions.addAvailabilityAction(
          form({
            ...hidden,
            resourceId: C4,
            kind: 'WEEKLY',
            weekday: ['1', '2', '3', '4', '5'],
            start: '08:00',
            end: '18:00',
          }),
        ),
      ),
    ).toBe(`${BACK}?notice=availability_added`);
    const posts = writes();
    expect(posts).toHaveLength(5);
    expect(new Set(posts.map((p) => p.key)).size).toBe(5);
    expect(posts.map((p) => p.key)).toEqual([1, 2, 3, 4, 5].map((d) => `${KEY}.d${d}`));
    expect(posts[0]?.body).toEqual({
      resourceId: C4,
      fact: { kind: 'WEEKLY', weekday: 1, start: '08:00', end: '18:00' },
    });
  });

  it('tournament-wide hours are sent with resourceId null', async () => {
    platform();
    routes[`POST /v1/competitions/${COMP}/availability`] = () =>
      json(201, { availabilityId: AV(99), created: true });
    await outcome(() =>
      actions.addAvailabilityAction(
        form({
          ...hidden,
          resourceId: '',
          kind: 'DATE_OPEN',
          date: '2026-11-14',
          start: '09:00',
          end: '18:00',
        }),
      ),
    );
    expect(writes()).toEqual([
      {
        method: 'POST',
        path: `/v1/competitions/${COMP}/availability`,
        key: KEY,
        body: {
          resourceId: null,
          fact: { kind: 'DATE_OPEN', date: '2026-11-14', start: '09:00', end: '18:00' },
        },
      },
    ]);
  });

  it('maintenance is converted in the resource’s own zone, read from the API', async () => {
    platform({
      resources: [court(C1, 'Court 1', { timezone: 'America/New_York' })],
      facts: [],
    });
    routes[`POST /v1/competitions/${COMP}/availability`] = () =>
      json(201, { availabilityId: AV(99), created: true });
    await outcome(() =>
      actions.addAvailabilityAction(
        form({
          ...hidden,
          resourceId: C1,
          kind: 'MAINTENANCE',
          startDate: '2026-11-14',
          startTime: '14:00',
          endTime: '16:00',
          reason: 'Resurfacing',
        }),
      ),
    );
    expect(writes()[0]?.body).toEqual({
      resourceId: C1,
      fact: {
        kind: 'MAINTENANCE',
        startsAt: '2026-11-14T19:00:00.000Z',
        endsAt: '2026-11-14T21:00:00.000Z',
        reason: 'Resurfacing',
      },
    });

    // A DST-gap time is refused before any write.
    calls = [];
    expect(
      await outcome(() =>
        actions.addAvailabilityAction(
          form({
            ...hidden,
            resourceId: C1,
            kind: 'BLACKOUT',
            startDate: '2026-03-08',
            startTime: '02:30',
            endTime: '04:00',
            reason: 'x',
          }),
        ),
      ),
    ).toBe(`${BACK}?error=availability_time_skipped`);
    expect(writes()).toEqual([]);
  });

  it('a resource of another tournament is refused before any write', async () => {
    platform();
    routes[`GET /v1/resources/${C1}`] = () =>
      json(200, { ...court(C1, 'Court 1'), competitionId: 'other' });
    expect(
      await outcome(() =>
        actions.addAvailabilityAction(
          form({ ...hidden, resourceId: C1, kind: 'DATE_CLOSED', date: '2026-11-15' }),
        ),
      ),
    ).toBe(`${BACK}?error=resource_not_found`);
    expect(writes()).toEqual([]);
  });

  it('maps availability refusals and reports partial multi-day saves', async () => {
    platform();
    const add = (weekday: string | string[]) =>
      actions.addAvailabilityAction(
        form({ ...hidden, resourceId: C4, kind: 'WEEKLY', weekday, start: '08:00', end: '18:00' }),
      );
    for (const [code, status, expected] of [
      ['ALREADY_EXISTS', 409, 'availability_duplicate'],
      ['FORBIDDEN', 403, 'availability_not_permitted'],
      ['INVALID_TRANSITION', 409, 'availability_transition'],
      ['INVALID_INPUT', 400, 'availability_invalid'],
    ] as const) {
      routes[`POST /v1/competitions/${COMP}/availability`] = () => err(status, code);
      expect(await outcome(() => add('1'))).toBe(`${BACK}?error=${expected}`);
    }
    let n = 0;
    routes[`POST /v1/competitions/${COMP}/availability`] = () =>
      (n += 1) === 2
        ? err(409, 'ALREADY_EXISTS')
        : json(201, { availabilityId: AV(n), created: true });
    expect(await outcome(() => add(['1', '2', '3']))).toBe(`${BACK}?error=availability_partial`);
  });

  it('removal is a revoke with a required reason', async () => {
    platform();
    routes[`POST /v1/availability/${AV(1)}/revoke`] = () =>
      json(200, { availabilityId: AV(1), created: true });
    expect(
      await outcome(() =>
        actions.revokeAvailabilityAction(
          form({ ...hidden, availabilityId: AV(1), reason: 'Wrong day' }),
        ),
      ),
    ).toBe(`${BACK}?notice=availability_removed`);
    expect(writes()).toEqual([
      {
        method: 'POST',
        path: `/v1/availability/${AV(1)}/revoke`,
        key: KEY,
        body: { reason: 'Wrong day' },
      },
    ]);

    calls = [];
    expect(
      await outcome(() =>
        actions.revokeAvailabilityAction(form({ ...hidden, availabilityId: AV(1), reason: '' })),
      ),
    ).toBe(`${BACK}?error=reason_required`);
    expect(
      await outcome(() =>
        actions.revokeAvailabilityAction(form({ ...hidden, availabilityId: 'x', reason: 'r' })),
      ),
    ).toBe(`${BACK}?error=availability_not_found`);
    expect(writes()).toEqual([]);
    routes[`POST /v1/availability/${AV(1)}/revoke`] = () => err(409, 'INVALID_TRANSITION');
    expect(
      await outcome(() =>
        actions.revokeAvailabilityAction(form({ ...hidden, availabilityId: AV(1), reason: 'r' })),
      ),
    ).toBe(`${BACK}?error=availability_transition`);
  });

  it('changing hours revokes then adds, and says so when only the revoke succeeded', async () => {
    platform();
    const change = () =>
      actions.replaceAvailabilityAction(
        form({
          ...hidden,
          availabilityId: AV(1),
          resourceId: C1,
          kind: 'WEEKLY',
          weekday: '1',
          start: '09:00',
          end: '17:00',
          reason: 'New hours',
        }),
      );
    routes[`POST /v1/availability/${AV(1)}/revoke`] = () =>
      json(200, { availabilityId: AV(1), created: true });
    routes[`POST /v1/competitions/${COMP}/availability`] = () =>
      json(201, { availabilityId: AV(2), created: true });
    expect(await outcome(change)).toBe(`${BACK}?notice=availability_replaced`);
    expect(writes().map((w) => [w.path, w.key, w.body])).toEqual([
      [`/v1/availability/${AV(1)}/revoke`, `${KEY}.revoke`, { reason: 'New hours' }],
      [
        `/v1/competitions/${COMP}/availability`,
        `${KEY}.add`,
        { resourceId: C1, fact: { kind: 'WEEKLY', weekday: 1, start: '09:00', end: '17:00' } },
      ],
    ]);

    routes[`POST /v1/competitions/${COMP}/availability`] = () => err(409, 'ALREADY_EXISTS');
    expect(await outcome(change)).toBe(`${BACK}?error=availability_replace_partial`);

    // A failed revoke adds nothing.
    calls = [];
    routes[`POST /v1/availability/${AV(1)}/revoke`] = () => err(409, 'INVALID_TRANSITION');
    expect(await outcome(change)).toBe(`${BACK}?error=availability_transition`);
    expect(writes().map((w) => w.path)).toEqual([`/v1/availability/${AV(1)}/revoke`]);
  });
});
