import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ONCF-05B web: organizer structure (readiness → lock → seed → preview → generate), pairs and
// squads (teams page, team entry), declared entry values, and the public stage-graph structure.
// Rendered against a fake session + fake platform API; the API stays the authority.

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

const Structure = (
  await import('../app/orgs/[slug]/tournaments/[competitionId]/categories/[eventId]/structure/page')
).default;
const structureActions =
  await import('../app/orgs/[slug]/tournaments/[competitionId]/categories/[eventId]/structure/actions');
const Category = (
  await import('../app/orgs/[slug]/tournaments/[competitionId]/categories/[eventId]/page')
).default;
const Teams = (await import('../app/teams/page')).default;
const teamActions = await import('../app/teams/actions');
const Register = (await import('../app/register/[slug]/[eventSlug]/page')).default;
const registerActions = await import('../app/register/actions');
const Result = (await import('../app/registrations/[registrationId]/page')).default;
const PublicEventPage = (await import('../(explorer)/competitions/[slug]/events/[eventSlug]/page'))
  .default;
const attrs = await import('../_lib/entry-attributes');
const structure = await import('../_lib/structure');
const teams = await import('../_lib/teams');
const competition = await import('../_lib/competition');

// ───────────────────────────── fake platform ─────────────────────────────

const ORG = '0b9b4b8e-6f0a-4f3e-9d6a-1c2b3c4d5e6f';
const COMP = '22222222-2222-4222-8222-222222222222';
const EVENT = '33333333-3333-4333-8333-333333333333';
const ATHLETE = '66666666-6666-4666-8666-666666666666';
const PARTNER = '68666666-6666-4666-8666-666666666666';
const TEAM = '44444444-4444-4444-8444-444444444444';
const TEAM_SMALL = '45444444-4444-4444-8444-444444444444';
const REG = '77777777-7777-4777-8777-777777777777';
const P1 = 'a1111111-1111-4111-8111-111111111111';
const P2 = 'a2222222-2222-4222-8222-222222222222';
const P3 = 'a3333333-3333-4333-8333-333333333333';
const DV = 'd0000000-0000-4000-8000-000000000001';

const catalog = (entrantKind: 'INDIVIDUAL' | 'TEAM' = 'INDIVIDUAL') => ({
  disciplineVersions: [
    {
      disciplineVersionId: DV,
      sport: { code: 'swimming', name: 'Swimming' },
      discipline: { code: 'swimming.pool', name: 'Individual pool event' },
      version: 1,
      specHash: 'sha256:x',
      participantKinds: [entrantKind],
      lineupSize: entrantKind === 'TEAM' ? { min: 2, max: 2 } : { min: 1, max: 1 },
      allowedContestTypes: ['HEAT'],
      compatibleFormatVersionIds: [],
      roster: entrantKind === 'TEAM' ? { min: 2, max: 2 } : null,
      entryAttributes:
        entrantKind === 'TEAM'
          ? [
              {
                key: 'memberHandicapIndex',
                valueType: 'DECIMAL',
                scope: 'MEMBER',
                required: false,
                min: '-10',
                max: '54',
              },
            ]
          : [
              {
                key: 'entryTimeMs',
                valueType: 'DURATION_MS',
                scope: 'PARTICIPANT',
                required: false,
                min: '0',
              },
              { key: 'ageBand', valueType: 'TEXT', scope: 'PARTICIPANT', required: false },
            ],
    },
  ],
  formatVersions: [],
});

function managedEvent(status: string, entrantKind: 'INDIVIDUAL' | 'TEAM' = 'INDIVIDUAL') {
  return {
    id: EVENT,
    slug: 'free-100',
    status,
    entrantKind,
    discipline: {
      versionId: DV,
      sport: { code: 'swimming', name: 'Swimming' },
      code: 'swimming.pool',
      name: 'Individual pool event',
      version: 1,
    },
    format: {
      versionId: 'fv',
      code: 'heats-final',
      name: 'Heats → final',
      version: 1,
      engine: 'heats-final/1',
    },
    formatConfig: {},
    settings: {
      name: '100 Free',
      category: {},
      capacity: null,
      registrationMode: 'AUTO_CONFIRM',
      registrationOpensAt: null,
      registrationClosesAt: null,
      startsAt: null,
      endsAt: null,
      timezone: 'America/Costa_Rica',
    },
    counts: { confirmed: 3, waitlisted: 0, participants: 0 },
    editable: { settings: false, capacityAndRegistrationMode: false },
    nextStatuses:
      status === 'REGISTRATION_CLOSED'
        ? ['REGISTRATION_OPEN', 'FIELD_LOCKED', 'CANCELLED']
        : ['IN_PROGRESS', 'CANCELLED'],
    createdAt: '2026-10-06T00:00:00Z',
    updatedAt: '2026-10-06T00:00:00Z',
    statusChangedAt: '2026-10-06T00:00:00Z',
  };
}

function managed(
  status: string,
  permissions = ['COMP_VIEW_PRIVATE', 'COMP_LOCK_FIELD', 'COMP_GENERATE_STRUCTURE'],
) {
  return {
    competition: {
      id: COMP,
      slug: 'fest',
      organizerOrganizationId: ORG,
      status: 'ACTIVE',
      profile: {
        name: 'Fest',
        description: null,
        locationLabel: null,
        regionCode: 'CR',
        timezone: 'America/Costa_Rica',
        startsAt: null,
        endsAt: null,
        website: null,
      },
      editable: { profile: true, addEvents: true },
      nextStatuses: ['COMPLETED', 'CANCELLED'],
      createdAt: '2026-10-06T00:00:00Z',
      updatedAt: '2026-10-06T00:00:00Z',
      statusChangedAt: '2026-10-06T00:00:00Z',
    },
    events: [managedEvent(status)],
    access: { staffRoles: ['OWNER'], permissions },
  };
}

function readiness(o: Partial<{ locked: boolean; seeded: boolean; planned: boolean }> = {}) {
  return {
    eventId: EVENT,
    status: o.locked ? 'FIELD_LOCKED' : 'REGISTRATION_CLOSED',
    fieldLocked: o.locked ?? false,
    fieldVersion: o.locked ? 2 : null,
    participants: o.locked ? 3 : 0,
    rosterSnapshot: o.locked ? { teams: 0, snapshotted: 0 } : null,
    entryAttributesFrozen: o.locked ? 2 : 0,
    seeded: o.seeded ?? false,
    seeding: o.seeded ? { method: 'BY_ENTRY_ATTRIBUTE', version: 2, overrides: 1 } : null,
    planGenerated: o.planned ?? false,
    plan: o.planned
      ? { engine: 'heats-final/1', planVersion: 2, stages: 2, contests: 4, dynamicRounds: 0 }
      : null,
    contestsScheduled: { scheduled: 0, total: o.planned ? 4 : 0 },
    blockers: !o.locked
      ? ['FIELD_NOT_LOCKED']
      : !o.seeded
        ? ['NOT_SEEDED']
        : !o.planned
          ? ['NO_PLAN']
          : [],
    warnings: o.planned ? ['CONTESTS_UNSCHEDULED'] : [],
  };
}

const FIELD = {
  items: [
    {
      participantId: P1,
      registrationId: REG,
      kind: 'INDIVIDUAL',
      athleteId: ATHLETE,
      teamId: null,
      teamName: null,
      status: 'ACTIVE',
      seed: null,
      rosterSize: null,
      attributes: [{ key: 'entryTimeMs', value: '62450' }],
      athlete: { slug: 'ana-rojas', displayName: 'Ana Rojas' },
    },
    {
      participantId: P2,
      registrationId: REG,
      kind: 'INDIVIDUAL',
      athleteId: PARTNER,
      teamId: null,
      teamName: null,
      status: 'ACTIVE',
      seed: null,
      rosterSize: null,
      attributes: [],
      athlete: null,
    },
    {
      participantId: P3,
      registrationId: REG,
      kind: 'INDIVIDUAL',
      athleteId: null,
      teamId: null,
      teamName: null,
      status: 'ACTIVE',
      seed: null,
      rosterSize: null,
      attributes: [],
      athlete: { slug: 'bo-mora', displayName: 'Bo Mora' },
    },
  ],
};

const PREVIEW = {
  engine: 'multi-round/1',
  planVersion: 2,
  stages: [{ key: 's1', label: 'Leaderboard', primitive: 'FIELD', partitionKind: 'LOGISTIC' }],
  transitions: [{ key: 't1', kind: 'CUT', fromStage: 's1', toStage: 's1' }],
  rounds: [
    {
      key: 's1-r1',
      label: 'Round 1',
      roundType: 'SESSION',
      stageKey: 's1',
      groupKey: null,
      dynamic: false,
      contests: 12,
      entries: 0,
    },
    {
      key: 's1-r2',
      label: 'Round 2',
      roundType: 'FINAL',
      stageKey: 's1',
      groupKey: null,
      dynamic: true,
      contests: 0,
      entries: 0,
    },
  ],
  contests: 12,
};

function publicEvent(entrantKind: 'INDIVIDUAL' | 'TEAM' = 'INDIVIDUAL') {
  return {
    competition: { id: COMP, slug: 'fest', name: 'Fest', status: 'ACTIVE' },
    event: {
      id: EVENT,
      slug: 'free-100',
      name: '100 Free',
      status: 'REGISTRATION_OPEN',
      entrantKind,
      sport: { code: 'swimming', name: 'Swimming' },
      discipline: { code: 'swimming.pool', name: 'Individual pool event', version: 1 },
      format: { code: 'heats-final', name: 'Heats → final', version: 1, engine: 'heats-final/1' },
      category: {},
      capacity: null,
      confirmedCount: 3,
      waitlistCount: 0,
      participantCount: 0,
      registration: { opensAt: null, closesAt: null },
      startsAt: null,
      endsAt: null,
      timezone: 'America/Costa_Rica',
    },
    field: { locked: false, fieldHash: null },
    seeding: null,
    plan: null,
    canonical: { competitionSlug: 'fest', eventSlug: 'free-100' },
    redirected: false,
  };
}

function registration(o: Partial<{ eventStatus: string; team: boolean }> = {}) {
  return {
    id: REG,
    status: 'CONFIRMED',
    entrantType: o.team ? 'TEAM' : 'INDIVIDUAL',
    athleteId: o.team ? null : ATHLETE,
    athlete: o.team ? null : { slug: 'ana-rojas', displayName: 'Ana Rojas' },
    team: o.team ? { id: TEAM, name: 'Rojas & Mora' } : null,
    eligibilityBasis: 'DECLARED',
    reason: null,
    requestedAt: '2026-10-01T15:00:00.000Z',
    statusChangedAt: '2026-10-02T15:00:00.000Z',
    event: {
      id: EVENT,
      slug: 'free-100',
      name: '100 Free',
      status: o.eventStatus ?? 'REGISTRATION_OPEN',
      entrantKind: o.team ? 'TEAM' : 'INDIVIDUAL',
      sport: { code: 'swimming', name: 'Swimming' },
      discipline: { code: 'swimming.pool', name: 'Individual pool event' },
      format: { code: 'heats-final', name: 'Heats → final' },
      capacity: null,
      registrationMode: 'AUTO_CONFIRM',
      registrationClosesAt: null,
      startsAt: null,
      endsAt: null,
      timezone: 'America/Costa_Rica',
    },
    competition: {
      id: COMP,
      slug: 'fest',
      name: 'Fest',
      status: 'ACTIVE',
      startsAt: null,
      endsAt: null,
      timezone: 'America/Costa_Rica',
      locationLabel: null,
    },
    actions: { decisions: [], withdraw: true },
    history: [{ status: 'CONFIRMED', reason: null, recordedAt: '2026-10-01T15:00:00.000Z' }],
    viewer: { entrant: true, staff: false },
  };
}

const MY_TEAMS = {
  items: [
    {
      teamId: TEAM,
      teamKind: 'EVENT_PAIR',
      displayName: 'Rojas & Mora',
      createdAt: '2026-10-01T00:00:00Z',
      members: [
        {
          membershipId: 'm1111111-1111-4111-8111-111111111111',
          athleteId: ATHLETE,
          status: 'ACTIVE',
          athlete: { slug: 'ana-rojas', displayName: 'Ana Rojas' },
        },
        {
          membershipId: 'm2222222-1111-4111-8111-111111111111',
          athleteId: PARTNER,
          status: 'ACTIVE',
          athlete: { slug: 'bo-mora', displayName: 'Bo Mora' },
        },
      ],
    },
    {
      teamId: TEAM_SMALL,
      teamKind: 'EVENT_PAIR',
      displayName: 'Solo Pair',
      createdAt: '2026-10-01T00:00:00Z',
      members: [
        {
          membershipId: 'm3333333-1111-4111-8111-111111111111',
          athleteId: ATHLETE,
          status: 'ACTIVE',
          athlete: null,
        },
      ],
    },
  ],
};

interface Call {
  method: string;
  path: string;
  body: unknown;
  key: string | undefined;
}
let calls: Call[] = [];
let routes: Record<string, (c: Call) => Response> = {};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const refused = (status: number, code: string) => () => json(status, { error: { code } });

function platform(
  o: {
    status?: string;
    locked?: boolean;
    seeded?: boolean;
    planned?: boolean;
    entrantKind?: 'INDIVIDUAL' | 'TEAM';
    regStatus?: string;
    team?: boolean;
  } = {},
) {
  routes = {
    'GET /v1/me': () =>
      json(200, {
        accountId: 'acc',
        accountActive: true,
        selfPersonId: 'p-self',
        athletes: [{ athleteId: ATHLETE, personId: 'p-self', slug: 'ana-rojas' }],
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
    [`GET /v1/competitions/${COMP}/manage`]: () =>
      json(200, managed(o.status ?? 'REGISTRATION_CLOSED')),
    [`GET /v1/events/${EVENT}/readiness`]: () =>
      json(
        200,
        readiness({
          locked: o.locked ?? false,
          seeded: o.seeded ?? false,
          planned: o.planned ?? false,
        }),
      ),
    [`GET /v1/events/${EVENT}/field`]: () => json(200, FIELD),
    [`GET /v1/events/${EVENT}/plan-preview`]: () => json(200, PREVIEW),
    [`POST /v1/events/${EVENT}/lock-field`]: () =>
      json(200, { fieldHash: 'sha256:x', participantCount: 3 }),
    [`POST /v1/events/${EVENT}/seed`]: () =>
      json(200, { method: 'RANKED_THEN_DRAWN', seedingVersion: 2 }),
    [`POST /v1/events/${EVENT}/generate-plan`]: () => json(200, { planHash: 'sha256:y' }),
    'GET /v1/catalog': () => json(200, catalog(o.entrantKind)),
    'GET /v1/me/teams': () => json(200, MY_TEAMS),
    'GET /v1/me/team-memberships': () =>
      json(200, {
        items: [
          {
            membershipId: '99999999-1111-4111-8111-111111111111',
            teamId: '55555555-5555-4555-8555-555555555555',
            teamName: 'Relay Four',
            teamKind: 'EVENT_SQUAD',
            athleteId: ATHLETE,
            status: 'PROPOSED',
          },
        ],
      }),
    'POST /v1/teams': () => json(201, { teamId: TEAM }),
    [`POST /v1/teams/${TEAM}/members`]: () => json(201, { membershipId: 'mm', status: 'PROPOSED' }),
    'GET /v1/athletes/bo-mora': () =>
      json(200, { passport: { athlete: { id: PARTNER, slug: 'bo-mora' } } }),
    'GET /v1/competitions/fest': () =>
      json(200, {
        competition: {
          id: COMP,
          slug: 'fest',
          name: 'Fest',
          description: null,
          status: 'ACTIVE',
          timezone: 'America/Costa_Rica',
          startsAt: null,
          endsAt: null,
          locationLabel: null,
          organizer: { organizationId: ORG, slug: null, displayName: null },
        },
        events: [publicEvent(o.entrantKind).event],
        canonicalSlug: 'fest',
        redirected: false,
      }),
    'GET /v1/competitions/fest/events/free-100': () => json(200, publicEvent(o.entrantKind)),
    'GET /v1/me/registrations': () => json(200, { items: [] }),
    [`GET /v1/registrations/${REG}`]: () =>
      json(
        200,
        registration({ eventStatus: o.regStatus ?? 'REGISTRATION_OPEN', team: o.team ?? false }),
      ),
    [`GET /v1/registrations/${REG}/entry-attributes`]: () =>
      json(200, { items: [{ key: 'entryTimeMs', value: '62450' }] }),
    [`POST /v1/registrations/${REG}/entry-attributes`]: () =>
      json(200, { registrationId: REG, declared: 1 }),
    [`POST /v1/events/${EVENT}/registrations`]: () =>
      json(201, { registrationId: REG, status: 'CONFIRMED' }),
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
const cat = (q: Record<string, string> = {}) => ({
  params: Promise.resolve({ slug: 'club-uno', competitionId: COMP, eventId: EVENT }),
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
const STRUCT = `/app/orgs/club-uno/tournaments/${COMP}/categories/${EVENT}/structure`;
const base = { slug: 'club-uno', competitionId: COMP, eventId: EVENT, key: 'oc-key-12345678' };

// ───────────────────────────── pure helpers ─────────────────────────────

describe('ONCF-05B web helpers', () => {
  it('durations convert between what people type and canonical milliseconds', () => {
    expect(attrs.parseDuration('1:02.45')).toBe('62450');
    expect(attrs.parseDuration('62.45')).toBe('62450');
    expect(attrs.parseDuration('1:00:05')).toBe('3605000');
    expect(attrs.parseDuration('1:75.0')).toBeNull();
    expect(attrs.parseDuration('fast')).toBeNull();
    expect(attrs.formatDuration('62450')).toBe('1:02.45');
    expect(attrs.formatDuration(3605000)).toBe('1:00:05.00');
  });

  it('normalizes typed values by type and bounds; only changed values are sent', () => {
    const dec = { valueType: 'DECIMAL' as const, min: '1.0', max: '4.5' };
    expect(attrs.normalizeAttributeInput(dec, '3.5')).toBe('3.5');
    expect(attrs.normalizeAttributeInput(dec, '5')).toBe('invalid');
    expect(attrs.normalizeAttributeInput(dec, '')).toBeNull();
    const specs = catalog().disciplineVersions[0]?.entryAttributes as Parameters<
      typeof attrs.changedAttributes
    >[2];
    const values: Record<string, string> = {
      'attr.entryTimeMs': '1:02.45',
      'prev.attr.entryTimeMs': '62450',
      'attr.ageBand': 'M40',
      'prev.attr.ageBand': '',
      'attr.unknownKey': 'x',
    };
    const r = attrs.changedAttributes((n) => values[n] ?? '', Object.keys(values), specs);
    expect(r).toEqual({ kind: 'ok', attributes: [{ key: 'ageBand', value: 'M40' }] });
    expect(
      attrs.changedAttributes(
        (n) => (n === 'attr.entryTimeMs' ? 'soon' : ''),
        ['attr.entryTimeMs'],
        specs,
      ),
    ).toEqual({ kind: 'invalid' });
  });

  it('builds the seeding request from the form and refuses gaps, unknown values and reasonless overrides', () => {
    const get = (v: Record<string, string>) => (n: string) => v[n] ?? '';
    const field = FIELD.items;
    const seedable = [{ key: 'entryTimeMs' }];
    expect(
      structure.seedingRequest(
        get({
          method: 'RANKED_THEN_DRAWN',
          [`seed.${P2}`]: '1',
          [`seed.${P1}`]: '2',
          banded: 'on',
          sourceLabel: 'Club ranking',
          sourceAsOf: '2026-10-01',
        }),
        field,
        seedable,
      ),
    ).toEqual({
      kind: 'ok',
      body: {
        method: 'RANKED_THEN_DRAWN',
        seeds: [P2, P1],
        banded: true,
        source: { kind: 'DECLARED_EXTERNAL', label: 'Club ranking', asOf: '2026-10-01' },
      },
    });
    expect(
      structure.seedingRequest(
        get({ method: 'RANKED_THEN_DRAWN', [`seed.${P1}`]: '1', [`seed.${P2}`]: '3' }),
        field,
        seedable,
      ).kind,
    ).toBe('error');
    expect(
      structure.seedingRequest(
        get({ method: 'BY_ENTRY_ATTRIBUTE', attributeKey: 'ageBand' }),
        field,
        seedable,
      ).kind,
    ).toBe('error');
    expect(
      structure.seedingRequest(
        get({ method: 'BY_ENTRY_ATTRIBUTE', attributeKey: 'entryTimeMs', direction: 'ASC' }),
        field,
        seedable,
      ),
    ).toEqual({
      kind: 'ok',
      body: { method: 'BY_ENTRY_ATTRIBUTE', attributeKey: 'entryTimeMs', direction: 'ASC' },
    });
    expect(
      structure.seedingRequest(
        get({
          method: 'DETERMINISTIC_DRAW',
          'override.1.participant': P3,
          'override.1.position': '1',
        }),
        field,
        seedable,
      ),
    ).toEqual({
      kind: 'error',
      code: 'reason_required',
    });
    expect(structure.seedingRequest(get({ method: 'TELEPATHY' }), field, seedable).kind).toBe(
      'error',
    );
  });

  it('team eligibility follows the discipline roster, not a sport', () => {
    const pair = { lineupSize: { min: 2, max: 2 }, roster: { min: 2, max: 2 } };
    expect(teams.teamMinimum(pair)).toBe(2);
    expect(teams.eligibleTeams(MY_TEAMS.items as never, pair).map((t) => t.teamId)).toEqual([TEAM]);
    expect(teams.suggestedKind(pair)).toBe('EVENT_PAIR');
    expect(
      teams.suggestedKind({ lineupSize: { min: 3, max: 4 }, roster: { min: 3, max: 4 } }),
    ).toBe('EVENT_SQUAD');
  });

  it('labels dependencies and partitions without naming anyone', () => {
    expect(competition.groupName('g1')).toBe('A');
    expect(competition.ordinalLabel(2)).toBe('2nd');
    expect(competition.ordinalLabel(13)).toBe('13th');
    expect(competition.partitionLabel('w3')).toBe('Wave 3');
    expect(competition.partitionLabel('g2')).toBe('Group B');
    expect(
      competition.dependencyLabel({
        slot: 1,
        kind: 'RANK_FROM_STAGE',
        stageKey: 's1',
        groupKey: 'g1',
        rank: 1,
        resolved: false,
      }),
    ).toBe('Group A · 1st');
    expect(
      competition.dependencyLabel({
        slot: 1,
        kind: 'BEST_RANKED_FROM_STAGE',
        stageKey: 's1',
        rank: 3,
        ordinal: 1,
        resolved: false,
      }),
    ).toBe('Best 3rd #1');
    expect(
      competition.dependencyLabel({
        slot: 4,
        kind: 'QUALIFIER',
        transitionKey: 't1',
        ordinal: 3,
        resolved: false,
      }),
    ).toBe('Qualifier #3');
  });
});

// ───────────────────────────── organizer structure ─────────────────────────────

describe('organizer structure page', () => {
  it('the category page links to Field & structure once registration closes', async () => {
    expect(html(await Category(cat()))).toContain(`${STRUCT}`);
  });

  it('offers the field lock after registration closes', async () => {
    const page = html(await Structure(cat()));
    expect(page).toContain('Lock the field');
    expect(page).toContain('Readiness');
    expect(page).not.toContain('Seed the field');
  });

  it('a locked, unseeded field offers seeding with the field table (private entrants stay unnamed)', async () => {
    platform({ status: 'FIELD_LOCKED', locked: true });
    const page = html(await Structure(cat()));
    expect(page).toContain('Seed the field');
    expect(page).toContain('By a declared value');
    expect(page).toContain('Entry time');
    expect(page).not.toContain('Age band</option>'); // text attributes can't seed
    expect(page).toContain('Private entrant');
    expect(page).toContain('Entry time 1:02.45');
    expect(page).toContain('Declared · not verified');
    expect(page).not.toContain('Lock the field (');
  });

  it('a seeded field shows the preview (dynamic rounds explained) and a permanent generate step', async () => {
    platform({ status: 'FIELD_LOCKED', locked: true, seeded: true });
    const page = html(await Structure(cat()));
    expect(page).toContain('Structure preview');
    expect(page).toContain('field set by the cut');
    expect(page).toContain('12 contests');
    expect(page).toContain('Generate the structure');
    expect(page).toContain('permanent');
  });

  it('after generation it links to the public category page', async () => {
    platform({ status: 'FIELD_LOCKED', locked: true, seeded: true, planned: true });
    const page = html(await Structure(cat()));
    expect(page).toContain('/competitions/fest/events/free-100');
    expect(page).not.toContain('Generate the structure');
    expect(page).toContain('Some contests have no time or court yet');
  });

  it('view-only staff see the checklist but no commands', async () => {
    routes[`GET /v1/competitions/${COMP}/manage`] = () =>
      json(200, managed('FIELD_LOCKED', ['COMP_VIEW_PRIVATE']));
    platform({ status: 'FIELD_LOCKED', locked: true });
    routes[`GET /v1/competitions/${COMP}/manage`] = () =>
      json(200, managed('FIELD_LOCKED', ['COMP_VIEW_PRIVATE']));
    const page = html(await Structure(cat()));
    expect(page).toContain('Readiness');
    expect(page).not.toContain('name="method"');
    expect(page).not.toContain('Generate the structure');
  });

  it('a readiness refusal is a 404', async () => {
    routes[`GET /v1/events/${EVENT}/readiness`] = refused(403, 'FORBIDDEN');
    expect(await outcome(() => Structure(cat()))).toBe('404');
  });
});

describe('structure actions', () => {
  it('locks with the form’s idempotency key; a roster problem maps to field_incomplete', async () => {
    expect(await outcome(() => structureActions.lockFieldAction(form(base)))).toBe(
      `${STRUCT}?notice=field_locked`,
    );
    expect(writes()[0]).toMatchObject({
      method: 'POST',
      path: `/v1/events/${EVENT}/lock-field`,
      key: 'oc-key-12345678',
    });
    routes[`POST /v1/events/${EVENT}/lock-field`] = refused(400, 'INVALID_INPUT');
    expect(await outcome(() => structureActions.lockFieldAction(form(base)))).toBe(
      `${STRUCT}?error=field_incomplete`,
    );
  });

  it('seeds with the request built from the field; malformed seeds never reach the API', async () => {
    platform({ status: 'FIELD_LOCKED', locked: true });
    expect(
      await outcome(() =>
        structureActions.seedFieldAction(
          form({ ...base, method: 'RANKED_THEN_DRAWN', [`seed.${P3}`]: '1', banded: 'on' }),
        ),
      ),
    ).toBe(`${STRUCT}?notice=field_seeded`);
    expect(writes()[0]?.body).toEqual({ method: 'RANKED_THEN_DRAWN', seeds: [P3], banded: true });
    calls = [];
    expect(
      await outcome(() =>
        structureActions.seedFieldAction(
          form({ ...base, method: 'RANKED_THEN_DRAWN', [`seed.${P3}`]: '2' }),
        ),
      ),
    ).toBe(`${STRUCT}?error=seeding_invalid`);
    expect(writes()).toEqual([]);
    routes[`POST /v1/events/${EVENT}/seed`] = refused(409, 'ALREADY_EXISTS');
    expect(
      await outcome(() =>
        structureActions.seedFieldAction(form({ ...base, method: 'DETERMINISTIC_DRAW' })),
      ),
    ).toBe(`${STRUCT}?error=structure_done`);
  });

  it('generation needs the explicit confirmation', async () => {
    expect(await outcome(() => structureActions.generatePlanAction(form(base)))).toBe(
      `${STRUCT}?error=missing_fields`,
    );
    expect(writes()).toEqual([]);
    expect(
      await outcome(() => structureActions.generatePlanAction(form({ ...base, confirm: 'yes' }))),
    ).toBe(`${STRUCT}?notice=plan_generated`);
    routes[`POST /v1/events/${EVENT}/generate-plan`] = refused(400, 'INVALID_INPUT');
    expect(
      await outcome(() => structureActions.generatePlanAction(form({ ...base, confirm: 'yes' }))),
    ).toBe(`${STRUCT}?error=plan_invalid`);
  });
});

// ───────────────────────────── teams ─────────────────────────────

describe('teams page and actions', () => {
  it('lists managed teams with member consent status and pending invitations', async () => {
    const page = html(await Teams(sp()));
    expect(page).toContain('Rojas &amp; Mora');
    expect(page).toContain('Bo Mora');
    expect(page).toContain('Private athlete');
    expect(page).toContain('Relay Four');
    expect(page).toContain('Accept');
    expect(page).toContain('Create team');
  });

  it('creates a team and adds the caller’s athlete', async () => {
    expect(
      await outcome(() =>
        teamActions.createTeamAction(
          form({
            displayName: 'Rojas & Mora',
            teamKind: 'EVENT_PAIR',
            athleteId: ATHLETE,
            key: 'oc-key-12345678',
          }),
        ),
      ),
    ).toBe('/app/teams?notice=team_created');
    expect(writes().map((c) => [c.path, c.body])).toEqual([
      ['/v1/teams', { teamKind: 'EVENT_PAIR', displayName: 'Rojas & Mora' }],
      [`/v1/teams/${TEAM}/members`, { athleteId: ATHLETE }],
    ]);
    calls = [];
    expect(
      await outcome(() =>
        teamActions.createTeamAction(form({ displayName: '', teamKind: 'EVENT_PAIR' })),
      ),
    ).toBe('/app/teams?error=team_invalid');
    expect(writes()).toEqual([]);
  });

  it('invites by public athlete address and keeps a safe continuation', async () => {
    const next = '/app/register/fest/free-100';
    expect(
      await outcome(() =>
        teamActions.inviteMemberAction(form({ teamId: TEAM, athleteSlug: '@bo-mora', next })),
      ),
    ).toBe(`/app/teams?notice=member_invited&next=${encodeURIComponent(next)}`);
    expect(writes()[0]).toMatchObject({
      path: `/v1/teams/${TEAM}/members`,
      body: { athleteId: PARTNER },
    });
    expect(
      await outcome(() =>
        teamActions.inviteMemberAction(
          form({ teamId: TEAM, athleteSlug: 'nobody-here', next: 'https://evil.test' }),
        ),
      ),
    ).toBe('/app/teams?error=athlete_not_found');
  });

  it('answers invitations through the canonical command', async () => {
    routes['POST /v1/team-memberships/99999999-1111-4111-8111-111111111111/accept'] = () =>
      json(200, { status: 'ACTIVE' });
    expect(
      await outcome(() =>
        teamActions.respondMembershipAction(
          form({ membershipId: '99999999-1111-4111-8111-111111111111', answer: 'accept' }),
        ),
      ),
    ).toBe('/app/teams?notice=membership_accepted');
    expect(
      await outcome(() =>
        teamActions.respondMembershipAction(form({ membershipId: 'x', answer: 'accept' })),
      ),
    ).toBe('/app/teams?error=team_member_invalid');
  });
});

describe('team entry in the registration flow', () => {
  const reg = (q: Record<string, string> = {}) => ({
    params: Promise.resolve({ slug: 'fest', eventSlug: 'free-100' }),
    ...sp(q),
  });

  it('a team category lists the caller’s teams; teams below the roster minimum cannot enter', async () => {
    platform({ entrantKind: 'TEAM' });
    const page = html(await Register(reg()));
    expect(page).toContain('Which team is entering?');
    expect(page).toContain('at least 2 active members');
    expect(page).toContain('Rojas &amp; Mora');
    const small = /<input[^>]*value="45444444-4444-4444-8444-444444444444"[^>]*>/.exec(page)?.[0];
    expect(small).toContain('disabled');
    expect(page).toContain('/app/teams?next=');
  });

  it('the review submits the team entry', async () => {
    platform({ entrantKind: 'TEAM' });
    const page = html(await Register(reg({ step: 'review', team: TEAM })));
    expect(page).toContain(`name="teamId" value="${TEAM}"`);
    expect(page).toContain('Bo Mora');
    expect(
      await outcome(() =>
        registerActions.registerAction(
          form({
            competitionSlug: 'fest',
            eventSlug: 'free-100',
            eventId: EVENT,
            teamId: TEAM,
            eligibility: 'yes',
            key: 'oc-key-12345678',
          }),
        ),
      ),
    ).toBe(`/app/registrations/${REG}?notice=registration_received`);
    expect(writes()[0]?.body).toEqual({ teamId: TEAM, eligibilityDeclared: true });
  });
});

// ───────────────────────────── entry attributes ─────────────────────────────

describe('declared entry values', () => {
  const res = (q: Record<string, string> = {}) => ({
    params: Promise.resolve({ registrationId: REG }),
    ...sp(q),
  });

  it('the entrant can declare values before the lock, labelled as not verified', async () => {
    const page = html(await Result(res()));
    expect(page).toContain('Declared · not verified');
    expect(page).toContain('Entry time');
    expect(page).toContain('value="1:02.45"');
    expect(page).toContain('Save entry details');
  });

  it('after the lock the values are read-only', async () => {
    platform({ regStatus: 'FIELD_LOCKED' });
    const page = html(await Result(res()));
    expect(page).toContain('Frozen');
    expect(page).not.toContain('Save entry details');
  });

  it('sends only changed values, converted to canonical form', async () => {
    expect(
      await outcome(() =>
        registerActions.declareAttributesAction(
          form({
            registrationId: REG,
            key: 'oc-key-12345678',
            'attr.entryTimeMs': '1:01.00',
            'prev.attr.entryTimeMs': '62450',
            'attr.ageBand': '',
            'prev.attr.ageBand': '',
          }),
        ),
      ),
    ).toBe(`/app/registrations/${REG}?notice=attributes_saved`);
    expect(writes()[0]?.body).toEqual({ attributes: [{ key: 'entryTimeMs', value: '61000' }] });
    calls = [];
    expect(
      await outcome(() =>
        registerActions.declareAttributesAction(
          form({ registrationId: REG, 'attr.entryTimeMs': 'soon', 'prev.attr.entryTimeMs': '' }),
        ),
      ),
    ).toBe(`/app/registrations/${REG}?error=attribute_invalid`);
    expect(writes()).toEqual([]);
    routes[`POST /v1/registrations/${REG}/entry-attributes`] = refused(409, 'INVALID_TRANSITION');
    expect(
      await outcome(() =>
        registerActions.declareAttributesAction(
          form({ registrationId: REG, 'attr.ageBand': 'M40', 'prev.attr.ageBand': '' }),
        ),
      ),
    ).toBe(`/app/registrations/${REG}?error=attributes_frozen`);
  });
});

// ───────────────────────────── public stage graph ─────────────────────────────

describe('public stage-graph structure', () => {
  const display = (n: number) => ({
    kind: 'ATHLETE',
    athleteSlug: `r${n}`,
    displayName: `Runner ${n}`,
  });
  const contest = (o: Record<string, unknown>) => ({
    contestId: `c-${Math.random()}`,
    sequence: 1,
    contestType: 'HEAT',
    status: 'PLANNED',
    round: { sequence: 1, label: 'Heats', roundType: 'HEAT' },
    scheduledStart: null,
    scheduledEnd: null,
    locationLabel: null,
    courtLabel: null,
    slots: [],
    partitionKey: null,
    entryCount: 0,
    entries: [],
    ...o,
  });

  it('renders stages, waves with entries, qualifier and group dependencies, and dynamic rounds', async () => {
    const entries = Array.from({ length: 60 }, (_, i) => ({
      participantId: `p${i}`,
      position: i + 1,
      startOffsetSeconds: null,
      display: display(i),
    }));
    routes['GET /v1/competitions/fest/events/free-100/bracket'] = () =>
      json(200, {
        rounds: [
          {
            sequence: 1,
            label: 'Race',
            roundType: 'FINAL',
            stage: { key: 's1', label: 'Race', primitive: 'FIELD', partitionKind: 'LOGISTIC' },
            groupKey: null,
            dynamicEntry: null,
            byes: [],
            contests: [contest({ partitionKey: 'w1', entryCount: 60, entries })],
          },
          {
            sequence: 2,
            label: 'Final',
            roundType: 'FINAL',
            stage: { key: 's2', label: 'Final', primitive: 'FIELD', partitionKind: null },
            groupKey: null,
            dynamicEntry: null,
            byes: [],
            contests: [
              contest({
                slots: [
                  { slot: 4, kind: 'QUALIFIER', transitionKey: 't1', ordinal: 1, resolved: false },
                ],
              }),
            ],
          },
          {
            sequence: 3,
            label: 'Semifinal',
            roundType: 'KNOCKOUT',
            stage: { key: 's3', label: 'Knockout', primitive: 'KNOCKOUT', partitionKind: null },
            groupKey: null,
            dynamicEntry: null,
            byes: [],
            contests: [
              contest({
                slots: [
                  {
                    slot: 1,
                    kind: 'RANK_FROM_STAGE',
                    stageKey: 's0',
                    groupKey: 'g1',
                    rank: 1,
                    resolved: false,
                  },
                ],
              }),
            ],
          },
          {
            sequence: 4,
            label: 'Round 3',
            roundType: 'SESSION',
            stage: {
              key: 's4',
              label: 'Leaderboard',
              primitive: 'FIELD',
              partitionKind: 'LOGISTIC',
            },
            groupKey: null,
            dynamicEntry: { transitionKey: 't2' },
            byes: [],
            contests: [],
          },
        ],
        results: { status: 'NOT_AVAILABLE' },
      });
    const page = html(
      await PublicEventPage({ params: Promise.resolve({ slug: 'fest', eventSlug: 'free-100' }) }),
    );
    expect(page).toContain('one classification across all groups');
    expect(page).toContain('Wave 1');
    expect(page).toContain('Runner 49');
    expect(page).not.toContain('Runner 50<');
    expect(page).toContain('and 10 more');
    expect(page).toContain('Qualifier #1');
    expect(page).toContain('Group A · 1st');
    expect(page).toContain('Field set after the previous round’s results');
  });

  it('keeps the BRT-05 rendering for single-stage plans', async () => {
    routes['GET /v1/competitions/fest/events/free-100/bracket'] = () =>
      json(200, {
        rounds: [
          {
            sequence: 1,
            label: 'Final',
            roundType: 'FINAL',
            byes: [],
            contests: [
              contest({
                contestType: 'MATCH',
                slots: [
                  {
                    slot: 1,
                    kind: 'WINNER_OF_CONTEST',
                    contestId: 'x',
                    contestSequence: 2,
                    resolved: false,
                  },
                ],
              }),
            ],
          },
        ],
      });
    const page = html(
      await PublicEventPage({ params: Promise.resolve({ slug: 'fest', eventSlug: 'free-100' }) }),
    );
    expect(page).toContain('winner of contest #2');
    expect(page).not.toContain('one classification');
  });
});
