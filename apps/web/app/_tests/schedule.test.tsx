import type { ReactElement } from 'react';
import type * as ReactDom from 'react-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFLICT_CODES } from '../../../../packages/competition/src/scheduling/report';
import type {
  ProposalStatus as DomainProposalStatus,
  ProposalUnplacedReason,
} from '../../../../packages/competition/src/scheduling/proposal';
import {
  CONFLICT_TEXT,
  durationText,
  laneDays,
  PROPOSAL_STATUS,
  scheduleDays,
  timeText,
  UNPLACED_REASON,
  zonesOf,
  type ScheduleRow,
} from '../_lib/schedule';

// ONCF-L3 scheduling workspace: the web surface over the ONCF-05E-C/D/E/F API, rendered and
// exercised against a fake session + fake platform API. The API stays the authority (it computes
// proposals, judges conflicts and decides every transition); these tests prove the organizer view
// of it — readiness, the proposal review, the draft vs official schedule, conflicts, times in the
// category's zone — and that the actions send exactly the canonical commands with their keys.

const h = vi.hoisted(() => ({
  auth: { getClaims: vi.fn(), getSession: vi.fn() },
  pending: false,
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
// The real SubmitButton is rendered: its pending state comes from React's form status.
vi.mock('react-dom', async (original) => ({
  ...(await original<typeof ReactDom>()),
  useFormStatus: () => ({ pending: h.pending }),
}));

const Page = (await import('../app/orgs/[slug]/tournaments/[competitionId]/schedule/page')).default;
const actions = await import('../app/orgs/[slug]/tournaments/[competitionId]/schedule/actions');
const { CommitForm } = await import('../_product/schedule-ui');

// ───────────────────────────── fixtures: a padel club open ─────────────────────────────

const ORG = '0b9b4b8e-6f0a-4f3e-9d6a-1c2b3c4d5e6f';
const COMP = '22222222-2222-4222-8222-222222222222';
const MEN = '33333333-3333-4333-8333-333333333331';
const WOMEN = '33333333-3333-4333-8333-333333333332';
const MIXED = '33333333-3333-4333-8333-333333333333';
const PROFILE = '44444444-4444-4444-8444-444444444444';
const V1 = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001';
const V2 = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002';
const COURT = (n: number) => `99999999-9999-4999-8999-99999999999${n}`;
const K = (n: number) => `cccccccc-cccc-4ccc-8ccc-00000000000${n}`;
const P = (n: number) => `dddddddd-dddd-4ddd-8ddd-00000000000${n}`;
const HASH = `sha256:${'a'.repeat(64)}`;
const REPORT = `sha256:${'b'.repeat(64)}`;
const SOFT_KEY = `sha256:${'c'.repeat(64)}`;
const HARD_KEY = `sha256:${'d'.repeat(64)}`;
const KEY = 'oc-0123456789abcdef0123456789abcdef';
const ZONE = 'America/Costa_Rica';
const OWNER = ['COMP_EDIT', 'COMP_VIEW_PRIVATE', 'COMP_MANAGE_SCHEDULE', 'COMP_MANAGE_STAFF'];
const SCHEDULER = ['COMP_VIEW_PRIVATE', 'COMP_MANAGE_SCHEDULE', 'COMP_MANAGE_LINEUPS'];
const REG_MANAGER = [
  'COMP_VIEW_PRIVATE',
  'COMP_OPEN_REGISTRATION',
  'COMP_CLOSE_REGISTRATION',
  'COMP_MANAGE_REGISTRATIONS',
];
const TEAMS = [
  'Los Tigres',
  'Bandeja Bros',
  'Vibora Club',
  'Smash Sisters',
  'Red Rackets',
  'Net Ninjas',
  'Pared Power',
  'Golpe Final',
];

function event(id: string, slug: string, name: string, status: string) {
  return {
    id,
    slug,
    status,
    entrantKind: 'TEAM',
    discipline: {
      versionId: 'dv',
      sport: { code: 'padel', name: 'Padel' },
      code: 'padel.doubles',
      name: 'Padel doubles',
      version: 1,
    },
    format: { versionId: 'fv', code: 'se', name: 'Single elimination', version: 1, engine: 'x' },
    formatConfig: {},
    settings: {
      name,
      category: {},
      capacity: 8,
      registrationMode: 'AUTO_CONFIRM',
      registrationOpensAt: null,
      registrationClosesAt: null,
      startsAt: null,
      endsAt: null,
      timezone: ZONE,
    },
    counts: { confirmed: 8, waitlisted: 0, participants: 8 },
    editable: { settings: false, capacityAndRegistrationMode: false },
    nextStatuses: [],
    createdAt: '2026-10-06T00:00:00Z',
    updatedAt: '2026-10-06T00:00:00Z',
    statusChangedAt: '2026-10-06T00:00:00Z',
  };
}

const EVENTS = [
  event(MEN, 'men-open', 'Men Open', 'FIELD_LOCKED'),
  event(WOMEN, 'women-open', 'Women Open', 'REGISTRATION_CLOSED'),
  event(MIXED, 'mixed-open', 'Mixed Open', 'FIELD_LOCKED'),
];

function managed(o: Partial<{ status: string; permissions: string[]; events: unknown[] }> = {}) {
  return {
    competition: {
      id: COMP,
      slug: 'club-open',
      organizerOrganizationId: ORG,
      status: o.status ?? 'ACTIVE',
      profile: {
        name: 'Club Padel Open',
        description: null,
        locationLabel: 'Club Uno',
        regionCode: 'CR',
        timezone: ZONE,
        // Sat 14 Nov 2026 08:00 → Sun 15 Nov 20:00, Costa Rica (UTC−6, no DST).
        startsAt: '2026-11-14T14:00:00.000Z',
        endsAt: '2026-11-16T02:00:00.000Z',
        website: null,
      },
      editable: { profile: true, addEvents: false },
      nextStatuses: [],
      createdAt: '2026-10-06T00:00:00Z',
      updatedAt: '2026-10-06T00:00:00Z',
      statusChangedAt: '2026-10-06T00:00:00Z',
    },
    events: o.events ?? EVENTS,
    access: { staffRoles: [], permissions: o.permissions ?? OWNER },
  };
}

const court = (n: number) => ({
  resourceId: COURT(n),
  competitionId: COMP,
  typeCode: 'PADEL_COURT',
  revision: 1,
  label: `Court ${n}`,
  attributes: {},
  capacity: 1,
  occupancyMode: 'EXCLUSIVE',
  exclusivityKeys: [],
  venueOrganizationId: null,
  locationLabel: null,
  timezone: null,
  status: 'ACTIVE',
  updatedAt: '2026-10-08T00:00:00.000Z',
});
const COURTS = [1, 2, 3, 4].map(court);
const weekly = (weekday: number, n: number) => ({
  availabilityId: `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${n}`,
  scope: 'COMPETITION',
  resourceId: null,
  kind: 'WEEKLY',
  weekday,
  start: '08:00',
  end: '20:00',
  recordedAt: '2026-10-08T00:00:00.000Z',
});
const FACTS = [weekly(6, 1), weekly(7, 2)];

const PROFILE_VIEW = {
  versionId: PROFILE,
  code: 'padel-court-match',
  name: 'Padel court match',
  version: 1,
  basis: { kind: 'COMMON_PRACTICE', note: 'club play' },
  spec: {
    specVersion: 1,
    requirements: [
      {
        selector: {},
        resourceType: 'PADEL_COURT',
        capacityUnit: 'CONTEST',
        expectedDurationSeconds: 5400,
        changeoverSeconds: 600,
      },
    ],
  },
};

const team = (n: number) => ({
  slot: n % 2 === 1 ? 1 : 2,
  kind: 'PARTICIPANT',
  participantId: P(n),
  display: { kind: 'TEAM', teamName: TEAMS[n - 1] },
});
const contest = (n: number, label: string, slots: unknown[]) => ({
  contestId: K(n),
  sequence: n,
  contestType: 'MATCH',
  status: 'PLANNED',
  round: { sequence: 1, label, roundType: 'ELIMINATION' },
  scheduledStart: null,
  scheduledEnd: null,
  locationLabel: null,
  courtLabel: null,
  slots,
});
const winner = (slot: number, of: number) => ({
  slot,
  kind: 'WINNER_OF_CONTEST',
  contestId: K(of),
  contestSequence: of,
  resolved: false,
});
const BRACKET = {
  rounds: [
    {
      sequence: 1,
      label: 'Quarter-finals',
      roundType: 'ELIMINATION',
      contests: [1, 2, 3, 4].map((m) =>
        contest(m, 'Quarter-finals', [team(2 * m - 1), team(2 * m)]),
      ),
    },
    {
      sequence: 2,
      label: 'Semi-finals',
      roundType: 'ELIMINATION',
      contests: [
        contest(5, 'Semi-finals', [winner(1, 1), winner(2, 2)]),
        contest(6, 'Semi-finals', [winner(1, 3), winner(2, 4)]),
      ],
    },
    {
      sequence: 3,
      label: 'Final',
      roundType: 'ELIMINATION',
      contests: [contest(7, 'Final', [winner(1, 5), winner(2, 6)])],
    },
  ],
};
const FIELD = TEAMS.map((name, i) => ({
  participantId: P(i + 1),
  registrationId: `r-${i}`,
  kind: 'TEAM',
  athleteId: null,
  teamId: `t-${i}`,
  teamName: name,
  status: 'ACTIVE',
  seed: null,
  rosterSize: 2,
  attributes: [],
  athlete: null,
}));

/** The club's plan: quarter-finals Saturday 09:00 on four courts, semis 11:30, final Sunday 10:00. */
const PLAN: [number, number, string, string][] = [
  [1, 1, '2026-11-14T15:00:00.000Z', '2026-11-14T16:30:00.000Z'],
  [2, 2, '2026-11-14T15:00:00.000Z', '2026-11-14T16:30:00.000Z'],
  [3, 3, '2026-11-14T15:00:00.000Z', '2026-11-14T16:30:00.000Z'],
  [4, 4, '2026-11-14T15:00:00.000Z', '2026-11-14T16:30:00.000Z'],
  [5, 1, '2026-11-14T17:30:00.000Z', '2026-11-14T19:00:00.000Z'],
  [6, 2, '2026-11-14T17:30:00.000Z', '2026-11-14T19:00:00.000Z'],
  [7, 1, '2026-11-15T16:00:00.000Z', '2026-11-15T17:30:00.000Z'],
];
const assignment = ([m, c, start, end]: (typeof PLAN)[number], versionId: string) => ({
  assignmentId: `eeeeeeee-eeee-4eee-8eee-00000000000${m}`,
  versionId,
  contestId: K(m),
  resourceId: COURT(c),
  startsAt: start,
  expectedEnd: end,
  changeoverSeconds: 600,
  zone: ZONE,
  unitKey: `contest:${K(m)}`,
  provisional: m > 4,
  locked: false,
  removed: false,
  venueOrganizationId: null,
  locationLabel: null,
  courtLabel: null,
  reason: null,
  replacesAssignmentId: null,
  source: 'MANUAL',
  actorAccountId: 'acc',
  recordedAt: '2026-10-10T00:00:00.000Z',
});
const placement = ([m, c, start, end]: (typeof PLAN)[number]) => ({
  contestId: K(m),
  unitKey: `contest:${K(m)}`,
  resourceId: COURT(c),
  start: Date.parse(start) / 1000,
  expectedEnd: Date.parse(end) / 1000,
  changeoverSeconds: 600,
  zone: ZONE,
  provisional: m > 4,
  softConflictKeys: [],
});

const version = (id: string, n: number, status: string, baseVersionId: string | null = null) => ({
  versionId: id,
  competitionId: COMP,
  versionNumber: n,
  baseVersionId,
  status,
  createdByAccountId: 'acc',
  createdAt: '2026-10-10T00:00:00.000Z',
  statusChangedAt: '2026-10-10T12:00:00.000Z',
});
const detail = (v: ReturnType<typeof version>, plan: typeof PLAN) => ({
  ...v,
  statusHistory: [],
  assignments: plan.map((p) => assignment(p, v.versionId)),
  history: [],
  publication: null,
});
const proposal = (
  o: Partial<{ status: string; placed: typeof PLAN; unplaced: unknown[] }> = {},
) => {
  const placed = o.placed ?? PLAN;
  return {
    versionId: V1,
    competitionId: COMP,
    proposal: {
      proposalVersion: 1,
      strategy: { id: 'br:schedule-proposal-greedy', version: 1 },
      budget: { maxEvaluations: 10000, maxEvaluationsPerUnit: 500 },
      baseStateIdentity: `sha256:${'e'.repeat(64)}`,
      scope: { eventIds: null, roundIds: null },
      from: null,
      placements: placed.map(placement),
      unplaced: o.unplaced ?? [],
      status: o.status ?? 'SUCCESS',
      report: {
        reportHash: REPORT,
        validator: { id: 'x', version: 1 },
        coverage: [],
        hardConflicts: 0,
      },
      metrics: {
        placedUnits: placed.length,
        placedContests: placed.length,
        unplacedUnits: (o.unplaced ?? []).length,
        placementsWithSoftConflicts: 0,
        earliestStart: null,
        latestEnd: null,
        makespanSeconds: 0,
        busySeconds: [],
        baseHardConflicts: 0,
      },
      proposalHash: HASH,
    },
    diagnostics: {
      judgeCalls: 0,
      totalEvaluations: 0,
      skips: { unit: 0, time: 0, resource: 0 },
      packingRebuilds: 0,
    },
  };
};
const conflict = (key: string, code: string, severity: string, contests: number[]) => ({
  conflictKey: key,
  code,
  severity,
  certainty: 'CERTAIN',
  interval: { start: 0, end: 1 },
  unitKeys: [],
  contestIds: contests.map(K),
  assignmentIds: [],
  resourceIds: [COURT(1)],
});

// ───────────────────────────── fake platform ─────────────────────────────

interface Call {
  method: string;
  path: string;
  key: string | undefined;
  body: unknown;
}
let calls: Call[] = [];
let routes: Record<string, (c: Call) => Response> = {};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const err = (status: number, code: string) => json(status, { error: { code } });

function platform(
  o: {
    detail?: ReturnType<typeof managed> | null;
    versions?: ReturnType<typeof version>[] | null;
    details?: Record<string, unknown>;
    validation?: unknown;
    preview?: () => Response;
  } = {},
) {
  const m = o.detail === undefined ? managed() : o.detail;
  const versions = o.versions === undefined ? [] : o.versions;
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
    [`GET /v1/competitions/${COMP}/manage`]: () => (m === null ? json(503, {}) : json(200, m)),
    [`GET /v1/competitions/${COMP}/schedule/versions`]: () =>
      versions === null ? json(503, {}) : json(200, { items: versions }),
    [`GET /v1/competitions/${COMP}/resources`]: () => json(200, { items: COURTS }),
    [`GET /v1/competitions/${COMP}/availability`]: () => json(200, { items: FACTS }),
    [`GET /v1/events/${MEN}/scoring`]: () =>
      json(200, { eventId: MEN, pinned: true, frozen: true, schedulingProfile: PROFILE_VIEW }),
    [`GET /v1/events/${WOMEN}/scoring`]: () =>
      json(200, { eventId: WOMEN, pinned: true, frozen: false, schedulingProfile: null }),
    [`GET /v1/events/${MIXED}/scoring`]: () =>
      json(200, { eventId: MIXED, pinned: true, frozen: true, schedulingProfile: null }),
    [`GET /v1/events/${MEN}/readiness`]: () =>
      json(200, { planGenerated: true, plan: { contests: 7 } }),
    [`GET /v1/events/${WOMEN}/readiness`]: () => json(200, { planGenerated: false, plan: null }),
    [`GET /v1/events/${MIXED}/readiness`]: () => json(200, { planGenerated: false, plan: null }),
    'GET /v1/competitions/club-open/events/men-open/bracket': () => json(200, BRACKET),
    'GET /v1/competitions/club-open/events/mixed-open/bracket': () => json(200, { rounds: [] }),
    [`GET /v1/events/${MEN}/field`]: () => json(200, { items: FIELD }),
    [`GET /v1/events/${MIXED}/field`]: () => json(200, { items: [] }),
    [`POST /v1/schedule-versions/${V1}/validate`]: () =>
      json(200, o.validation ?? { reportHash: REPORT, hardConflicts: 0, conflicts: [] }),
    [`POST /v1/schedule-versions/${V2}/validate`]: () =>
      json(200, o.validation ?? { reportHash: REPORT, hardConflicts: 0, conflicts: [] }),
    [`POST /v1/schedule-versions/${V1}/proposals/preview`]:
      o.preview ?? (() => json(200, proposal())),
  };
  for (const [id, d] of Object.entries(o.details ?? {}))
    routes[`GET /v1/schedule-versions/${id}`] = () => json(200, d);
  for (const c of COURTS)
    routes[`GET /v1/resources/${c.resourceId}/availability`] = () =>
      json(200, {
        resourceId: c.resourceId,
        timezone: ZONE,
        status: 'ACTIVE',
        intervals: [
          { start: '2026-11-14T14:00:00.000Z', end: '2026-11-15T02:00:00.000Z' },
          { start: '2026-11-15T14:00:00.000Z', end: '2026-11-16T02:00:00.000Z' },
        ],
      });
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
  h.pending = false;
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
const posts = (suffix: string) =>
  calls.filter((c) => c.method === 'POST' && c.path.endsWith(suffix));
const BACK = `/app/orgs/club-uno/tournaments/${COMP}/schedule`;
const hidden = { slug: 'club-uno', competitionId: COMP, key: KEY };
/** The agenda row of one match (its state and contents). */
const agendaRow = (out: string, title: string) =>
  new RegExp(
    `<tr data-state="([a-z]+)"><td data-label="Time" class="mono"><span>([^<]*)(?:<span[^>]*>[^<]*</span>)?</span></td><td data-label="Court">([^<]*)</td><td data-label="Match"><span><strong>${title}</strong>(.*?)</tr>`,
  ).exec(out);
const category = (out: string, name: string) =>
  new RegExp(
    `<li data-state="([a-z]+)"><div class="sch-cat-head"><strong>${name}</strong>(.*?)</ul></li>`,
  ).exec(out);

// ───────────────────────────── parity with the domain ─────────────────────────────

describe('parity with @br/competition', () => {
  it('words every conflict code the engine can report', () => {
    for (const code of CONFLICT_CODES) expect(CONFLICT_TEXT[code], code).toBeTruthy();
  });

  it('words every unplaced reason and every proposal status', () => {
    const reasons: Record<ProposalUnplacedReason, true> = {
      NO_PROFILE: true,
      EVENT_NOT_SCHEDULABLE: true,
      PARTIALLY_PLACED: true,
      ALL_VACANT: true,
      STALE_OCCUPANT: true,
      NO_COMPATIBLE_RESOURCE: true,
      NO_HORIZON: true,
      NO_DECLARED_TIME: true,
      FEEDER_UNPLACED: true,
      NO_FEASIBLE_CANDIDATE: true,
      BUDGET_EXHAUSTED: true,
    };
    for (const r of Object.keys(reasons)) expect(UNPLACED_REASON[r], r).toBeTruthy();
    const statuses: Record<DomainProposalStatus, true> = {
      SUCCESS: true,
      NOTHING_TO_PLACE: true,
      INFEASIBLE: true,
      NO_CANDIDATES: true,
      SEARCH_EXHAUSTED: true,
    };
    expect(Object.keys(PROPOSAL_STATUS).sort()).toEqual(Object.keys(statuses).sort());
  });
});

// ───────────────────────────── times and lanes ─────────────────────────────

describe('times, days and lanes', () => {
  const row = (
    start: string,
    end: string | null,
    zone = ZONE,
    resourceId = COURT(1),
  ): ScheduleRow => ({
    contestId: K(1),
    resourceId,
    start,
    end,
    zone,
    locked: false,
  });

  it('shows times in the category’s zone, never raw UTC', () => {
    expect(timeText(row('2026-11-14T15:00:00.000Z', '2026-11-14T16:30:00.000Z'))).toBe(
      '09:00–10:30',
    );
    expect(timeText(row('2026-11-15T05:00:00.000Z', '2026-11-15T06:30:00.000Z'))).toBe(
      '23:00–00:30 next day',
    );
    expect(timeText(row('2026-11-14T15:00:00.000Z', null, 'Europe/Madrid'))).toBe('16:00');
    expect(durationText(5400)).toBe('1 h 30 min');
    expect(durationText(600)).toBe('10 min');
  });

  it('groups by local day and reports more than one zone', () => {
    const days = scheduleDays([
      row('2026-11-15T16:00:00.000Z', null),
      row('2026-11-15T05:00:00.000Z', null),
      row('2026-11-14T15:00:00.000Z', null),
    ]);
    expect(days.map((d) => d.label)).toEqual(['Sat 14 Nov', 'Sun 15 Nov']);
    // 05:00Z on the 15th is 23:00 on Saturday in Costa Rica.
    expect(days[0]?.rows).toHaveLength(2);
    expect(
      zonesOf([
        row('2026-11-14T15:00:00.000Z', null),
        row('2026-11-14T15:00:00.000Z', null, 'Europe/Madrid'),
      ]),
    ).toHaveLength(2);
  });

  it('places blocks by local time with the court’s open hours behind them', () => {
    const [day] = laneDays(
      scheduleDays([row('2026-11-14T15:00:00.000Z', '2026-11-14T16:30:00.000Z')]),
      [
        { resourceId: COURT(1), label: 'Court 1' },
        { resourceId: COURT(2), label: 'Court 2' },
      ],
      new Map([
        [COURT(1), [{ start: '2026-11-14T14:00:00.000Z', end: '2026-11-15T02:00:00.000Z' }]],
      ]),
    );
    // 08:00–12:00 local (an hour either side of 09:00–10:30): a quarter in, 90 of 240 minutes wide.
    expect(day?.hours).toEqual([8, 9, 10, 11, 12]);
    expect(day?.lanes[0]?.blocks[0]?.left).toBeCloseTo(25);
    expect(day?.lanes[0]?.blocks[0]?.width).toBeCloseTo(37.5);
    expect(day?.lanes[0]?.open).toEqual([{ left: 0, width: 100 }]);
    // A court with no match is still drawn (free), and unknown hours stay unknown.
    expect(day?.lanes[1]?.blocks).toEqual([]);
    expect(day?.lanes[1]?.open).toBeNull();
  });
});

// ───────────────────────────── the page ─────────────────────────────

describe('schedule page', () => {
  it('is in the tournament navigation', async () => {
    platform();
    const out = html(await Page({ ...pc(), ...sp() }));
    expect(out).toMatch(/href="[^"]*\/schedule" data-key="schedule" aria-current="page"/);
    expect(out).toContain('<h2 class="tb-h">Schedule</h2>');
  });

  it('shows readiness per category without claiming the tournament is ready', async () => {
    platform();
    const out = html(await Page({ ...pc(), ...sp() }));
    expect(out).toContain('1 of 3 categories have everything scheduling needs');
    expect(out).toContain('A proposal shows whether every match fits');
    const men = category(out, 'Men Open');
    expect(men?.[1]).toBe('complete');
    expect(men?.[2]).toContain('Scheduling profile: Padel court match');
    expect(men?.[2]).toContain('Padel court · 1 h 30 min matches + 10 min changeover');
    expect(men?.[2]).toContain('7 matches generated');
    expect(men?.[2]).toContain('Dates set');
    expect(men?.[2]).toContain('4 courts with declared hours');
    expect(out).not.toMatch(/ready (for|to) schedul/i);
  });

  it('explains a missing scheduling profile, and when it can no longer be added', async () => {
    platform();
    const out = html(await Page({ ...pc(), ...sp() }));
    const women = category(out, 'Women Open');
    expect(women?.[1]).toBe('incomplete');
    expect(women?.[2]).toContain(
      `href="/app/orgs/club-uno/tournaments/${COMP}/categories/${WOMEN}/structure#sc-h">Choose a scheduling profile</a>`,
    );
    expect(women?.[2]).toContain('It must be chosen before the field is locked.');
    const mixed = category(out, 'Mixed Open');
    expect(mixed?.[1]).toBe('blocked');
    expect(mixed?.[2]).toContain('Can’t be scheduled');
    expect(mixed?.[2]).toContain('a profile can’t be added after that');
  });

  it('starts empty: no schedule yet, with the way to generate one', async () => {
    platform();
    const out = html(await Page({ ...pc(), ...sp() }));
    expect(out).toContain('No schedule yet');
    expect(out).toContain('Not published yet');
    expect(out).toContain('No draft open');
    expect(out).toContain('Generate a proposal');
    expect(out).toContain('name="scope"');
    expect(out).toContain(`<option value="${MEN}">Men Open</option>`);
    // Women Open isn't locked: it can't be offered.
    expect(out).not.toContain(`<option value="${WOMEN}">`);
    // The seven matches wait for a time, named the organizer's way.
    expect(out).toContain('Without a time <span class="tb-count">7</span>');
    expect(out).toContain('Los Tigres vs Bandeja Bros');
    expect(out).toContain('Winner of match 1 vs Winner of match 2');
    expect(writes()).toEqual([]);
  });

  it('says nothing can be scheduled before a field is locked', async () => {
    platform({ detail: managed({ events: [EVENTS[1]] }) });
    const out = html(await Page({ ...pc(), ...sp() }));
    expect(out).toContain('Matches are scheduled once a category’s field is locked');
    expect(out).toContain('No category can be scheduled yet');
    expect(out).not.toContain('name="scope"');
  });

  it('reviews a proposal where every match fits, ready to commit', async () => {
    platform({
      versions: [version(V1, 1, 'DRAFT')],
      details: { [V1]: detail(version(V1, 1, 'DRAFT'), []) },
    });
    const out = html(await Page({ ...pc(), ...sp({ review: 'all' }) }));
    expect(posts('/proposals/preview')).toHaveLength(1);
    expect(posts('/proposals/preview')[0]?.body).toEqual({});
    expect(out).toContain('id="proposal"');
    expect(out).toContain('Not saved');
    expect(out).toContain('Every match fits');
    expect(out).toContain('7 placed · 0 without a time');
    const qf = agendaRow(out, 'Match 1');
    expect(qf?.[1]).toBe('proposed');
    expect(qf?.[2]).toBe('09:00–10:30');
    expect(qf?.[3]).toBe('Court 1');
    expect(qf?.[4]).toContain('Men Open · Quarter-finals');
    expect(qf?.[4]).toContain('Los Tigres vs Bandeja Bros');
    expect(agendaRow(out, 'Match 7')?.[2]).toBe('10:00–11:30');
    expect(out).toContain('Sun 15 Nov');
    // Commit carries the hash and scope only, with a key; nothing was written by reviewing.
    expect(out).toContain(`name="proposalHash" value="${HASH}"`);
    expect(out).toContain('name="scope" value="all"');
    expect(out).toContain('Commit to draft');
    expect(
      writes().filter((c) => !c.path.endsWith('/preview') && !c.path.endsWith('/validate')),
    ).toEqual([]);
  });

  it('scopes the proposal to one category when asked', async () => {
    platform({
      versions: [version(V1, 1, 'DRAFT')],
      details: { [V1]: detail(version(V1, 1, 'DRAFT'), []) },
    });
    await Page({ ...pc(), ...sp({ review: MEN }) });
    expect(posts('/proposals/preview')[0]?.body).toEqual({ scope: { eventIds: [MEN] } });
  });

  it('ignores a review request for a category that can’t be scheduled', async () => {
    platform({
      versions: [version(V1, 1, 'DRAFT')],
      details: { [V1]: detail(version(V1, 1, 'DRAFT'), []) },
    });
    const out = html(await Page({ ...pc(), ...sp({ review: WOMEN }) }));
    expect(posts('/proposals/preview')).toEqual([]);
    expect(out).not.toContain('id="proposal"');
  });

  it('shows what didn’t fit and offers no commit', async () => {
    platform({
      versions: [version(V1, 1, 'DRAFT')],
      details: { [V1]: detail(version(V1, 1, 'DRAFT'), []) },
      preview: () =>
        json(
          200,
          proposal({
            status: 'INFEASIBLE',
            placed: PLAN.slice(0, 4),
            unplaced: [
              {
                unitKey: 'u5',
                contestIds: [K(5), K(6)],
                reason: 'NO_FEASIBLE_CANDIDATE',
                blockingConflictKeys: [],
              },
              {
                unitKey: 'u7',
                contestIds: [K(7)],
                reason: 'FEEDER_UNPLACED',
                blockingConflictKeys: [],
              },
            ],
          }),
        ),
    });
    const out = html(await Page({ ...pc(), ...sp({ review: 'all' }) }));
    expect(out).toContain('Not every match fits');
    expect(out).toContain('3 matches couldn’t be placed');
    expect(out).toContain('No free court and time avoids a conflict.');
    expect(out).toContain('Match 5 (Men Open), Match 6 (Men Open)');
    expect(out).toContain('It depends on a match that isn’t scheduled yet.');
    expect(out).toContain('This proposal can’t be committed.');
    expect(out).not.toContain('Commit to draft');
    expect(out).not.toContain('name="proposalHash"');
  });

  it('explains a schedule with no feasible courts or time', async () => {
    platform({
      versions: [version(V1, 1, 'DRAFT')],
      details: { [V1]: detail(version(V1, 1, 'DRAFT'), []) },
      preview: () =>
        json(
          200,
          proposal({
            status: 'NO_CANDIDATES',
            placed: [],
            unplaced: [
              {
                unitKey: 'u1',
                contestIds: [K(1)],
                reason: 'NO_DECLARED_TIME',
                blockingConflictKeys: [],
              },
            ],
          }),
        ),
    });
    const out = html(await Page({ ...pc(), ...sp({ review: 'all' }) }));
    expect(out).toContain('No courts or time to use');
    expect(out).toContain('No suitable court has declared hours within the category’s dates.');
    expect(out).not.toContain('Commit to draft');
  });

  it('says so when the proposal can’t be generated', async () => {
    platform({
      versions: [version(V1, 1, 'DRAFT')],
      details: { [V1]: detail(version(V1, 1, 'DRAFT'), []) },
      preview: () => err(409, 'INVALID_TRANSITION'),
    });
    let out = html(await Page({ ...pc(), ...sp({ review: 'all' }) }));
    expect(out).toContain('The proposal couldn’t be generated right now.');
    expect(out).toContain('The draft is no longer open.');
    expect(out).not.toContain('Commit to draft');

    platform({
      versions: [version(V1, 1, 'DRAFT')],
      details: { [V1]: detail(version(V1, 1, 'DRAFT'), []) },
      preview: () => json(503, {}),
    });
    out = html(await Page({ ...pc(), ...sp({ review: 'all' }) }));
    expect(out).toContain('Nothing was changed. Try again in a moment.');
  });

  it('shows the committed draft, distinct from the official schedule, ready to publish', async () => {
    platform({
      versions: [version(V1, 1, 'DRAFT')],
      details: { [V1]: detail(version(V1, 1, 'DRAFT'), PLAN) },
    });
    const out = html(await Page({ ...pc(), ...sp() }));
    expect(out).toContain('Draft · version 1');
    expect(out).toContain('<span class="sch-chip" data-state="draft">Not published</span>');
    expect(out).toContain('Version 1 · not published');
    expect(out).toContain('7 matches placed');
    expect(out).toContain('Only staff see the draft.');
    expect(agendaRow(out, 'Match 1')?.[1]).toBe('draft');
    expect(agendaRow(out, 'Match 1')?.[2]).toBe('09:00–10:30');
    expect(out).toContain('No conflicts');
    expect(posts('/validate')).toHaveLength(1);
    // Publish carries the reviewed report and the draft's base; discard needs a reason.
    expect(out).toContain('Publish schedule');
    expect(out).toContain(`name="reportHash" value="${REPORT}"`);
    expect(out).toContain('name="baseVersionId" value=""');
    expect(out).not.toContain('name="acknowledge"');
    expect(out).toContain('Discard draft');
    expect(out).toMatch(/<input required=""[^>]*name="reason"\/>/);
    // Everything is placed: nothing waits for a time; lanes show the courts.
    expect(out).not.toContain('Without a time');
    expect(out).toContain('class="sch-lanes-wrap"');
    expect(out).toContain('<span class="sch-lane-label">Court 4</span>');
  });

  it('marks conflicts, blocks publishing on them, and asks to confirm warnings', async () => {
    platform({
      versions: [version(V1, 1, 'DRAFT')],
      details: { [V1]: detail(version(V1, 1, 'DRAFT'), PLAN) },
      validation: {
        reportHash: REPORT,
        hardConflicts: 1,
        conflicts: [
          conflict(HARD_KEY, 'RESOURCE_UNAVAILABLE', 'HARD', [7]),
          conflict(SOFT_KEY, 'SHORT_REST', 'SOFT', [5]),
        ],
      },
    });
    let out = html(await Page({ ...pc(), ...sp() }));
    expect(out).toContain('1 conflict to fix before publishing');
    expect(out).toContain('The court is closed or unavailable then');
    expect(out).toContain('1 warning to review');
    expect(out).toContain('Players get less rest than the profile asks for');
    expect(agendaRow(out, 'Match 7')?.[1]).toBe('conflict');
    expect(agendaRow(out, 'Match 7')?.[4]).toContain('>Conflict<');
    expect(agendaRow(out, 'Match 5')?.[1]).toBe('warning');
    expect(out).toContain('Publishing is blocked until the conflicts above are fixed.');
    expect(out).not.toContain('Publish schedule');

    platform({
      versions: [version(V1, 1, 'DRAFT')],
      details: { [V1]: detail(version(V1, 1, 'DRAFT'), PLAN) },
      validation: {
        reportHash: REPORT,
        hardConflicts: 0,
        conflicts: [conflict(SOFT_KEY, 'SHORT_REST', 'SOFT', [5])],
      },
    });
    out = html(await Page({ ...pc(), ...sp() }));
    expect(out).toContain('Publish schedule');
    expect(out).toContain(`name="warning" value="${SOFT_KEY}"`);
    expect(out).toMatch(/<input type="checkbox" required=""[^>]*name="acknowledge" value="yes"\/>/);
    expect(out).toContain('I have reviewed the 1 warning and want to publish anyway');
  });

  it('shows the official schedule as authoritative, with nothing to edit', async () => {
    platform({
      versions: [version(V1, 1, 'PUBLISHED')],
      details: { [V1]: detail(version(V1, 1, 'PUBLISHED'), PLAN) },
    });
    const out = html(await Page({ ...pc(), ...sp() }));
    expect(out).toContain('Official schedule · version 1');
    expect(out).toContain('<span class="sch-chip" data-state="official">Published</span>');
    expect(out).toContain('Published · version 1');
    expect(out).toContain('This is the schedule players and the public see.');
    expect(agendaRow(out, 'Match 1')?.[1]).toBe('official');
    expect(out).not.toContain('Publish schedule');
    expect(out).not.toContain('Discard draft');
    expect(posts('/validate')).toEqual([]);
    // Changes start from a new draft.
    expect(out).toContain('A new draft is opened from the official schedule.');
    expect(out).toContain('Open a new draft');
  });

  it('switches between the open draft and the official schedule', async () => {
    const pub = version(V1, 1, 'PUBLISHED');
    const draft = version(V2, 2, 'DRAFT', V1);
    platform({
      versions: [draft, pub],
      details: { [V1]: detail(pub, PLAN), [V2]: detail(draft, PLAN.slice(0, 6)) },
    });
    let out = html(await Page({ ...pc(), ...sp() }));
    expect(out).toContain('Draft · version 2');
    expect(out).toContain(`name="baseVersionId" value="${V1}"`);
    expect(out).toContain('It replaces published version 1.');
    expect(out).toContain('aria-label="Schedule version"');
    out = html(await Page({ ...pc(), ...sp({ view: 'published' }) }));
    expect(out).toContain('Official schedule · version 1');
    expect(out).toContain('A draft with changes is open.');
  });

  it('is view-only for a registration manager: no forms, no proposal, no checks', async () => {
    platform({
      detail: managed({ permissions: REG_MANAGER }),
      versions: [version(V1, 1, 'DRAFT')],
      details: { [V1]: detail(version(V1, 1, 'DRAFT'), PLAN) },
    });
    const out = html(await Page({ ...pc(), ...sp({ review: 'all' }) }));
    expect(out).toContain('View only');
    expect(out).toContain(
      'Only a tournament owner, admin or scheduler can generate, commit or publish',
    );
    expect(out).toContain('Draft · version 1');
    expect(out).not.toContain('<form');
    expect(writes()).toEqual([]);
  });

  it('lets a scheduler run the schedule', async () => {
    platform({
      detail: managed({ permissions: SCHEDULER }),
      versions: [version(V1, 1, 'DRAFT')],
      details: { [V1]: detail(version(V1, 1, 'DRAFT'), PLAN) },
    });
    const out = html(await Page({ ...pc(), ...sp() }));
    expect(out).toContain('Publish schedule');
    expect(out).toContain('Generate proposal');
  });

  it('is view-only once the tournament has ended', async () => {
    platform({
      detail: managed({ status: 'COMPLETED' }),
      versions: [version(V1, 1, 'PUBLISHED')],
      details: { [V1]: detail(version(V1, 1, 'PUBLISHED'), PLAN) },
    });
    const out = html(await Page({ ...pc(), ...sp() }));
    expect(out).toContain('This tournament has ended, so its schedule can’t change.');
    expect(out).not.toContain('<form');
  });

  it('shows an error state when the schedule can’t be loaded', async () => {
    platform({ versions: null });
    const out = html(await Page({ ...pc(), ...sp() }));
    expect(out).toContain('The schedule can’t be loaded right now.');
    expect(out).toContain('tournament overview');
    expect(out).not.toContain('<form');
  });

  it('shows the flash message and 404s for another organization’s tournament', async () => {
    platform();
    const out = html(await Page({ ...pc(), ...sp({ notice: 'schedule_published' }) }));
    expect(out).toContain('Schedule published. It is now the official schedule.');
    routes[`GET /v1/competitions/${COMP}/manage`] = () => json(404, {});
    expect(await outcome(() => Page({ ...pc(), ...sp() }))).toBe('404');
  });

  it('disables the commit button while the commit is pending (no double submit)', () => {
    const p = proposal().proposal as never;
    h.pending = false;
    let out = html(
      <CommitForm
        hidden={hidden}
        action={actions.commitProposalAction}
        versionId={V1}
        proposal={p}
        scope="all"
      />,
    );
    expect(out).not.toContain('disabled=""');
    expect(out.match(/name="key"/g)).toHaveLength(1);
    h.pending = true;
    out = html(
      <CommitForm
        hidden={hidden}
        action={actions.commitProposalAction}
        versionId={V1}
        proposal={p}
        scope="all"
      />,
    );
    expect(out).toContain('disabled=""');
    expect(out).toContain('Committing');
  });
});

// ───────────────────────────── actions ─────────────────────────────

describe('schedule actions', () => {
  it('generate opens a draft when there is none, then shows the proposal', async () => {
    platform();
    routes[`POST /v1/competitions/${COMP}/schedule/drafts`] = () =>
      json(201, { versionId: V1, versionNumber: 1, baseVersionId: null, created: true });
    const r = await outcome(() => actions.generateAction(form({ ...hidden, scope: 'all' })));
    expect(r).toBe(`${BACK}?review=all#proposal`);
    expect(writes()).toEqual([
      {
        method: 'POST',
        path: `/v1/competitions/${COMP}/schedule/drafts`,
        key: KEY,
        body: undefined,
      },
    ]);
  });

  it('generate reuses the open draft and passes the category scope', async () => {
    platform({ versions: [version(V1, 1, 'DRAFT')] });
    const r = await outcome(() => actions.generateAction(form({ ...hidden, scope: MEN })));
    expect(r).toBe(`${BACK}?review=${MEN}#proposal`);
    expect(writes()).toEqual([]);
  });

  it('generate refuses an invalid scope before any call, and maps refusals', async () => {
    platform();
    expect(await outcome(() => actions.generateAction(form({ ...hidden, scope: 'x' })))).toBe(
      `${BACK}?error=schedule_invalid`,
    );
    expect(calls.filter((c) => c.path.includes('/schedule'))).toEqual([]);
    routes[`POST /v1/competitions/${COMP}/schedule/drafts`] = () => err(403, 'FORBIDDEN');
    expect(await outcome(() => actions.generateAction(form({ ...hidden, scope: 'all' })))).toBe(
      `${BACK}?error=schedule_not_permitted`,
    );
    routes[`POST /v1/competitions/${COMP}/schedule/drafts`] = () => err(409, 'ALREADY_EXISTS');
    expect(await outcome(() => actions.generateAction(form({ ...hidden, scope: 'all' })))).toBe(
      `${BACK}?review=all#proposal`,
    );
  });

  it('commit sends the hash and scope with the key to the commit endpoint', async () => {
    platform();
    routes[`POST /v1/schedule-versions/${V1}/proposals/commit`] = () =>
      json(200, { versionId: V1, placedContests: 7, created: true });
    const r = await outcome(() =>
      actions.commitProposalAction(
        form({ ...hidden, versionId: V1, proposalHash: HASH, scope: 'all' }),
      ),
    );
    expect(r).toBe(`${BACK}?notice=schedule_committed`);
    expect(writes()).toEqual([
      {
        method: 'POST',
        path: `/v1/schedule-versions/${V1}/proposals/commit`,
        key: KEY,
        body: { proposalHash: HASH },
      },
    ]);
    calls = [];
    await outcome(() =>
      actions.commitProposalAction(
        form({ ...hidden, versionId: V1, proposalHash: HASH, scope: MEN }),
      ),
    );
    expect(writes()[0]?.body).toEqual({ proposalHash: HASH, scope: { eventIds: [MEN] } });
  });

  it('commit maps a stale or uncommittable proposal, and never calls with bad input', async () => {
    platform();
    const commit = (f: Record<string, string>) =>
      outcome(() =>
        actions.commitProposalAction(form({ ...hidden, versionId: V1, scope: 'all', ...f })),
      );
    routes[`POST /v1/schedule-versions/${V1}/proposals/commit`] = () =>
      err(409, 'CONCURRENCY_CONFLICT');
    expect(await commit({ proposalHash: HASH })).toBe(`${BACK}?error=schedule_proposal_stale`);
    routes[`POST /v1/schedule-versions/${V1}/proposals/commit`] = () =>
      err(409, 'INVALID_TRANSITION');
    expect(await commit({ proposalHash: HASH })).toBe(`${BACK}?error=schedule_not_committable`);
    routes[`POST /v1/schedule-versions/${V1}/proposals/commit`] = () =>
      err(409, 'IDEMPOTENCY_KEY_REUSED');
    expect(await commit({ proposalHash: HASH })).toBe(`${BACK}?error=form_resubmitted`);
    calls = [];
    expect(await commit({ proposalHash: 'sha256:short' })).toBe(`${BACK}?error=schedule_invalid`);
    expect(await commit({ proposalHash: HASH, versionId: 'nope' })).toBe(
      `${BACK}?error=schedule_not_found`,
    );
    expect(writes()).toEqual([]);
  });

  it('publish sends the report, the base and the confirmed warnings', async () => {
    platform();
    routes[`POST /v1/schedule-versions/${V2}/publish`] = () =>
      json(200, {
        versionId: V2,
        supersededVersionId: V1,
        reportHash: REPORT,
        scheduledContests: 7,
        created: true,
      });
    const r = await outcome(() =>
      actions.publishAction(
        form({
          ...hidden,
          versionId: V2,
          baseVersionId: V1,
          reportHash: REPORT,
          warning: [SOFT_KEY],
          acknowledge: 'yes',
        }),
      ),
    );
    expect(r).toBe(`${BACK}?notice=schedule_published`);
    expect(writes()).toEqual([
      {
        method: 'POST',
        path: `/v1/schedule-versions/${V2}/publish`,
        key: KEY,
        body: { baseVersionId: V1, reportHash: REPORT, acknowledgedConflictKeys: [SOFT_KEY] },
      },
    ]);
    calls = [];
    await outcome(() =>
      actions.publishAction(
        form({ ...hidden, versionId: V1, baseVersionId: '', reportHash: REPORT }),
      ),
    );
    expect(writes()[0]?.body).toEqual({
      baseVersionId: null,
      reportHash: REPORT,
      acknowledgedConflictKeys: [],
    });
  });

  it('publish needs the warnings confirmed and maps refusals', async () => {
    platform();
    const publish = (f: Record<string, string | string[]> = {}) =>
      outcome(() =>
        actions.publishAction(
          form({ ...hidden, versionId: V1, baseVersionId: '', reportHash: REPORT, ...f }),
        ),
      );
    expect(await publish({ warning: [SOFT_KEY] })).toBe(
      `${BACK}?error=schedule_acknowledge_required`,
    );
    expect(await publish({ reportHash: 'nope' })).toBe(`${BACK}?error=schedule_invalid`);
    expect(writes()).toEqual([]);
    routes[`POST /v1/schedule-versions/${V1}/publish`] = () => err(409, 'CONCURRENCY_CONFLICT');
    expect(await publish()).toBe(`${BACK}?error=schedule_report_stale`);
    routes[`POST /v1/schedule-versions/${V1}/publish`] = () => err(409, 'INVALID_TRANSITION');
    expect(await publish()).toBe(`${BACK}?error=schedule_publish_blocked`);
    routes[`POST /v1/schedule-versions/${V1}/publish`] = () => err(400, 'INVALID_INPUT');
    expect(await publish()).toBe(`${BACK}?error=schedule_acknowledge_mismatch`);
    routes[`POST /v1/schedule-versions/${V1}/publish`] = () => json(503, {});
    expect(await publish()).toBe(`${BACK}?error=platform_unavailable`);
  });

  it('discard needs a reason and sends it with a key', async () => {
    platform();
    routes[`POST /v1/schedule-versions/${V1}/discard`] = () =>
      json(200, { versionId: V1, created: true });
    expect(
      await outcome(() => actions.discardAction(form({ ...hidden, versionId: V1, reason: '  ' }))),
    ).toBe(`${BACK}?error=reason_required`);
    expect(writes()).toEqual([]);
    expect(
      await outcome(() =>
        actions.discardAction(form({ ...hidden, versionId: V1, reason: 'Courts changed' })),
      ),
    ).toBe(`${BACK}?notice=schedule_discarded`);
    expect(writes()).toEqual([
      {
        method: 'POST',
        path: `/v1/schedule-versions/${V1}/discard`,
        key: KEY,
        body: { reason: 'Courts changed' },
      },
    ]);
  });

  it('opens a draft from the official schedule', async () => {
    platform();
    routes[`POST /v1/competitions/${COMP}/schedule/drafts`] = () => err(409, 'ALREADY_EXISTS');
    expect(await outcome(() => actions.openDraftAction(form(hidden)))).toBe(
      `${BACK}?error=schedule_draft_exists`,
    );
    routes[`POST /v1/competitions/${COMP}/schedule/drafts`] = () =>
      json(201, { versionId: V2, versionNumber: 2, baseVersionId: V1, created: true });
    expect(await outcome(() => actions.openDraftAction(form(hidden)))).toBe(
      `${BACK}?notice=schedule_draft_opened`,
    );
    expect(writes().at(-1)).toEqual({
      method: 'POST',
      path: `/v1/competitions/${COMP}/schedule/drafts`,
      key: KEY,
      body: undefined,
    });
  });
});
