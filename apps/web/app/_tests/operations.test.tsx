import { readFileSync } from 'node:fs';
import type { ReactElement } from 'react';
import type * as ReactDom from 'react-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CompetitionLifecycle,
  ContestLifecycle,
  EventLifecycle,
} from '../../../../packages/competition/src/lifecycle';
import { CompPermission } from '../../../../packages/competition/src/permissions';
import { CONTEST_NEXT, OPERATIONS, dayContext, operationPath } from '../_lib/operations';

// ONCF-L4 operations workspace: the web surface over the existing lifecycle commands, rendered and
// exercised against a fake session + fake platform API. The API stays the authority (permission,
// transition, H-2 serialization); these tests prove the organizer view of it — what is in play and
// up next, which commands are offered to whom, why the others are waiting — and that each command
// is confirmed, sent once to its canonical route, and that refusals come back as plain words.

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
vi.mock('react-dom', async (original) => ({
  ...(await original<typeof ReactDom>()),
  useFormStatus: () => ({ pending: h.pending }),
}));

const Page = (await import('../app/orgs/[slug]/tournaments/[competitionId]/operations/page'))
  .default;
const { operateAction } =
  await import('../app/orgs/[slug]/tournaments/[competitionId]/operations/actions');
const Hub = (await import('../app/orgs/[slug]/tournaments/[competitionId]/page')).default;

// ───────────────────────────── fixtures: a padel club open, Saturday morning ─────────────────────────────

const ORG = '0b9b4b8e-6f0a-4f3e-9d6a-1c2b3c4d5e6f';
const COMP = '22222222-2222-4222-8222-222222222222';
const MEN = '33333333-3333-4333-8333-333333333331';
const WOMEN = '33333333-3333-4333-8333-333333333332';
const MIXED = '33333333-3333-4333-8333-333333333333';
const V1 = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001';
const COURT = (n: number) => `99999999-9999-4999-8999-99999999999${n}`;
const K = (n: number) => `cccccccc-cccc-4ccc-8ccc-00000000000${n}`;
const W = (n: number) => `cccccccc-cccc-4ccc-8ccc-0000000000a${n}`;
const P = (n: number) => `dddddddd-dddd-4ddd-8ddd-00000000000${n}`;
const ZONE = 'America/Costa_Rica';
const OWNER = Object.values(CompPermission);
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

function event(id: string, slug: string, name: string, status: string, nextStatuses: string[]) {
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
    nextStatuses,
    createdAt: '2026-10-06T00:00:00Z',
    updatedAt: '2026-10-06T00:00:00Z',
    statusChangedAt: '2026-11-14T14:30:00.000Z',
  };
}

const men = (status = 'IN_PROGRESS', next = ['COMPLETED', 'CANCELLED']) =>
  event(MEN, 'men-open', 'Men Open', status, next);
const women = (status = 'FIELD_LOCKED', next = ['IN_PROGRESS', 'CANCELLED']) =>
  event(WOMEN, 'women-open', 'Women Open', status, next);
const mixed = () =>
  event(MIXED, 'mixed-open', 'Mixed Open', 'REGISTRATION_CLOSED', [
    'REGISTRATION_OPEN',
    'FIELD_LOCKED',
    'CANCELLED',
  ]);

function managed(
  o: Partial<{
    status: string;
    next: string[];
    permissions: string[];
    roles: string[];
    events: unknown[];
  }> = {},
) {
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
        // Sat 14 Nov 2026 08:00 → Sun 15 Nov 20:00, Costa Rica (UTC−6).
        startsAt: '2026-11-14T14:00:00.000Z',
        endsAt: '2026-11-16T02:00:00.000Z',
        website: null,
      },
      editable: { profile: true, addEvents: false },
      nextStatuses: o.next ?? ['COMPLETED', 'CANCELLED'],
      createdAt: '2026-10-06T00:00:00Z',
      updatedAt: '2026-10-06T00:00:00Z',
      statusChangedAt: '2026-11-14T14:00:00.000Z',
    },
    events: o.events ?? [men(), women(), mixed()],
    access: { staffRoles: o.roles ?? ['OWNER'], permissions: o.permissions ?? OWNER },
  };
}

const team = (n: number) => ({
  slot: n % 2 === 1 ? 1 : 2,
  kind: 'PARTICIPANT',
  participantId: P(n),
  display: { kind: 'TEAM', teamName: TEAMS[n - 1] },
});
const winner = (slot: number, of: number) => ({
  slot,
  kind: 'WINNER_OF_CONTEST',
  contestId: K(of),
  contestSequence: of,
  resolved: false,
});
const contest = (id: string, n: number, label: string, status: string, slots: unknown[]) => ({
  contestId: id,
  sequence: n,
  contestType: 'MATCH',
  status,
  round: { sequence: 1, label, roundType: 'ELIMINATION' },
  scheduledStart: null,
  scheduledEnd: null,
  locationLabel: null,
  courtLabel: null,
  slots,
});

/** QF1 in play, QF2 due, QF3 done, QF4 has a withdrawn team, SF5 waits on QF1/QF2, SF6 + F not scheduled. */
function menBracket(o: Partial<Record<number, string>> = {}) {
  const s = (n: number, d: string) => o[n] ?? d;
  return {
    rounds: [
      {
        sequence: 1,
        label: 'Quarter-finals',
        roundType: 'ELIMINATION',
        contests: [
          contest(K(1), 1, 'Quarter-finals', s(1, 'IN_PROGRESS'), [team(1), team(2)]),
          contest(K(2), 2, 'Quarter-finals', s(2, 'SCHEDULED'), [team(3), team(4)]),
          contest(K(3), 3, 'Quarter-finals', s(3, 'COMPLETED'), [team(5), team(6)]),
          contest(K(4), 4, 'Quarter-finals', s(4, 'SCHEDULED'), [team(7), team(8)]),
        ],
      },
      {
        sequence: 2,
        label: 'Semi-finals',
        roundType: 'ELIMINATION',
        contests: [
          contest(K(5), 5, 'Semi-finals', s(5, 'SCHEDULED'), [winner(1, 1), winner(2, 2)]),
          contest(K(6), 6, 'Semi-finals', s(6, 'PLANNED'), [winner(1, 3), winner(2, 4)]),
        ],
      },
      {
        sequence: 3,
        label: 'Final',
        roundType: 'ELIMINATION',
        contests: [contest(K(7), 7, 'Final', s(7, 'PLANNED'), [winner(1, 5), winner(2, 6)])],
      },
    ],
  };
}
const womenBracket = () => ({
  rounds: [
    {
      sequence: 1,
      label: 'Final',
      roundType: 'ELIMINATION',
      contests: [contest(W(1), 1, 'Final', 'SCHEDULED', [team(1), team(2)])],
    },
  ],
});
const field = (withdrawn: number[] = [8]) =>
  TEAMS.map((name, i) => ({
    participantId: P(i + 1),
    registrationId: `r-${i}`,
    kind: 'TEAM',
    athleteId: null,
    teamId: `t-${i}`,
    teamName: name,
    status: withdrawn.includes(i + 1) ? 'WITHDRAWN' : 'ACTIVE',
    seed: null,
    rosterSize: 2,
    attributes: [],
    athlete: null,
  }));

const assignment = (contestId: string, court: number, start: string, end: string) => ({
  assignmentId: `eeeeeeee-eeee-4eee-8eee-${contestId.slice(-12)}`,
  contestId,
  resourceId: COURT(court),
  startsAt: start,
  expectedEnd: end,
  changeoverSeconds: 600,
  zone: ZONE,
  unitKey: `contest:${contestId}`,
  provisional: false,
  locked: false,
  locationLabel: null,
  courtLabel: null,
  source: 'MANUAL',
});
/** Official schedule: QFs Saturday 09:00, SF5 11:30, the women's final Sunday 10:00. */
const OFFICIAL = [
  assignment(K(1), 1, '2026-11-14T15:00:00.000Z', '2026-11-14T16:30:00.000Z'),
  assignment(K(2), 2, '2026-11-14T15:00:00.000Z', '2026-11-14T16:30:00.000Z'),
  assignment(K(3), 3, '2026-11-14T15:00:00.000Z', '2026-11-14T16:30:00.000Z'),
  assignment(K(4), 4, '2026-11-14T15:00:00.000Z', '2026-11-14T16:30:00.000Z'),
  assignment(K(5), 1, '2026-11-14T17:30:00.000Z', '2026-11-14T19:00:00.000Z'),
  assignment(W(1), 2, '2026-11-15T16:00:00.000Z', '2026-11-15T17:30:00.000Z'),
];
const COURTS = [1, 2, 3, 4].map((n) => ({
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
}));
const STAFF = [
  {
    staffId: 's-1',
    personId: 'p-1',
    role: 'SCHEDULER',
    since: '2026-10-01T00:00:00Z',
    athlete: { slug: 'ana', displayName: 'Ana Mora' },
  },
];

// ───────────────────────────── fake platform ─────────────────────────────

interface Call {
  method: string;
  path: string;
  body: unknown;
}
let calls: Call[] = [];
let routes: Record<string, (c: Call) => Response> = {};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const err = (status: number, code: string) => json(status, { error: { code } });

function platform(
  o: {
    detail?: ReturnType<typeof managed> | null;
    men?: ReturnType<typeof menBracket>;
    published?: boolean;
    staff?: unknown[] | null;
  } = {},
) {
  const m = o.detail === undefined ? managed() : o.detail;
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
    [`GET /v1/competitions/${COMP}/staff`]: () =>
      o.staff === null ? json(503, {}) : json(200, { items: o.staff ?? STAFF }),
    [`GET /v1/competitions/${COMP}/schedule/versions`]: () =>
      json(200, {
        items:
          o.published === false
            ? []
            : [
                {
                  versionId: V1,
                  competitionId: COMP,
                  versionNumber: 1,
                  baseVersionId: null,
                  status: 'PUBLISHED',
                  createdAt: '2026-11-01T00:00:00.000Z',
                  statusChangedAt: '2026-11-01T00:00:00.000Z',
                },
              ],
      }),
    [`GET /v1/schedule-versions/${V1}`]: () =>
      json(200, {
        versionId: V1,
        competitionId: COMP,
        versionNumber: 1,
        baseVersionId: null,
        status: 'PUBLISHED',
        createdAt: '2026-11-01T00:00:00.000Z',
        statusChangedAt: '2026-11-01T00:00:00.000Z',
        assignments: OFFICIAL,
        publication: null,
      }),
    [`GET /v1/competitions/${COMP}/resources`]: () => json(200, { items: COURTS }),
    'GET /v1/competitions/club-open/events/men-open/bracket': () =>
      json(200, o.men ?? menBracket()),
    'GET /v1/competitions/club-open/events/women-open/bracket': () => json(200, womenBracket()),
    [`GET /v1/events/${MEN}/field`]: () => json(200, { items: field() }),
    [`GET /v1/events/${WOMEN}/field`]: () => json(200, { items: field([]) }),
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
  h.pending = false;
  calls = [];
  // Saturday 14 Nov 2026, 09:45 in Costa Rica: QF2 (09:00) is late, QF1 (until 10:30) isn't over.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-14T15:45:00.000Z'));
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const c: Call = {
      method: init.method ?? 'GET',
      path: u.pathname,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(c);
    const r = routes[`${c.method} ${c.path}`];
    return Promise.resolve(r === undefined ? json(404, {}) : r(c));
  });
});
afterEach(() => {
  vi.useRealTimers();
});

const pc = () => ({ params: Promise.resolve({ slug: 'club-uno', competitionId: COMP }) });
const sp = (q: Record<string, string> = {}) => ({ searchParams: Promise.resolve(q) });
const html = (el: ReactElement | null) => (el === null ? '' : renderToStaticMarkup(el));
const render = async (q: Record<string, string> = {}) => html(await Page({ ...pc(), ...sp(q) }));
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
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
};
const writes = () => calls.filter((c) => c.method !== 'GET');
const BASE = `/app/orgs/club-uno/tournaments/${COMP}`;
const BACK = `${BASE}/operations`;
const base = { slug: 'club-uno', competitionId: COMP };
/** One match row (its whole <li>). */
const row = (out: string, id: string) =>
  new RegExp(`<li id="m-${id}" class="ops-row"[^>]*>(.*?)</li>(?=<li id="m-|</ol>)`).exec(
    out,
  )?.[1] ?? '';
const cat = (out: string, id: string) =>
  new RegExp(`<li id="cat-${id}"[^>]*>(.*?)</li>(?=<li id="cat-|</ol>)`).exec(out)?.[1] ?? '';
/** The command buttons a fragment offers ("Start match", "Void match", …). */
const offeredIn = (fragment: string) =>
  [...fragment.matchAll(/<span class="ops-when-closed">([^<]+)<\/span>/g)].map((m) => m[1]);

// ───────────────────────────── parity with the domain ─────────────────────────────

describe('parity with @br/competition', () => {
  it('mirrors the contest lifecycle exactly (the API advertises no next statuses for matches)', () => {
    expect(CONTEST_NEXT).toEqual(ContestLifecycle.transitions);
  });

  it('only requests results each lifecycle can reach, under real permissions', () => {
    const states = {
      competition: CompetitionLifecycle.states,
      category: EventLifecycle.states,
      match: ContestLifecycle.states,
    } as Record<string, readonly string[]>;
    const perms = Object.values(CompPermission) as string[];
    for (const o of Object.values(OPERATIONS)) {
      expect(states[o.target], `${o.target}:${o.command}`).toContain(o.result);
      expect(perms).toContain(o.permission);
    }
  });

  it('sends each command to its existing route, a reason only where the API requires one', () => {
    const paths = Object.values(OPERATIONS).map((o) => operationPath(o, 'X'));
    expect(paths).toEqual([
      '/v1/competitions/X/activate',
      '/v1/competitions/X/complete',
      '/v1/competitions/X/cancel',
      '/v1/events/X/start',
      '/v1/events/X/complete',
      '/v1/events/X/cancel',
      '/v1/contests/X/start',
      '/v1/contests/X/complete',
      '/v1/contests/X/cancel',
      '/v1/contests/X/void',
    ]);
    expect(
      Object.values(OPERATIONS)
        .filter((o) => o.reason)
        .map((o) => `${o.target}:${o.command}`),
    ).toEqual(['competition:cancel', 'category:cancel', 'match:cancel', 'match:void']);
    // Every reason-bearing and every closing operation needs an explicit acknowledgement.
    for (const o of Object.values(OPERATIONS))
      if (o.reason || o.command === 'complete')
        expect(o.final || o.target === 'match', o.command).toBe(true);
  });
});

// ───────────────────────────── the workspace ─────────────────────────────

describe('operations workspace', () => {
  it('says what tournament this is, its state, and where the day stands', async () => {
    platform();
    const out = await render();
    expect(out).toContain('<h2 class="tb-h">Operations</h2>');
    expect(out).toContain('Club Padel Open');
    expect(out).toMatch(
      /class="tb-status mono" data-status="ACTIVE"><span aria-hidden="true"><\/span>Live/,
    );
    expect(out).toContain('Today Sat 14 Nov · Day 1 of 2');
    expect(out).toContain('Times in America/Costa Rica');
    expect(out).toContain(
      'Owner. You can start and complete the tournament and its categories, start and finish matches and cancel or void.',
    );
    // The tournament nav marks Operations as the current page.
    expect(out).toMatch(/<a href="[^"]*\/operations" data-key="operations" aria-current="page">/);
  });

  it('shows what is in play, what is up next on the official schedule, and the counts', async () => {
    platform();
    const out = await render();
    const live = row(out, K(1));
    expect(live).toContain('09:00–10:30');
    expect(live).toContain('Court 1');
    expect(live).toContain('<strong>Los Tigres vs Bandeja Bros</strong>');
    expect(live).toContain('Men Open · Quarter-finals · Match 1');
    expect(live).toContain('data-status="IN_PROGRESS">In play');
    // In play: one; up next: QF2, QF4, SF5 (men) + the women's final (Sunday, labelled as such).
    expect(out).toMatch(
      /data-key="live" data-zero="false"><span class="mono muted">In play<\/span><strong>1/,
    );
    expect(out).toMatch(
      /data-key="next" data-zero="false"><span class="mono muted">Up next<\/span><strong>4/,
    );
    expect(out).toMatch(
      /data-key="done" data-zero="false"><span class="mono muted">Done<\/span><strong>1<span class="muted small"> of 8/,
    );
    expect(row(out, W(1))).toContain('Sun 15 Nov · Court 2');
    expect(out.indexOf(`id="m-${K(2)}"`)).toBeLessThan(out.indexOf(`id="m-${K(5)}"`));
    expect(out.indexOf(`id="m-${K(5)}"`)).toBeLessThan(out.indexOf(`id="m-${W(1)}"`));
    // Not-yet-scheduled and finished matches are folded away, still counted.
    expect(out).toMatch(/Not on the schedule <span class="tb-count">2<\/span>/);
    expect(row(out, K(3))).toContain('Finished');
  });

  it('offers each match only the commands its state allows, and says why a start is waiting', async () => {
    platform();
    const out = await render();
    expect(offeredIn(row(out, K(1)))).toEqual(['Finish match', 'Void match']);
    expect(offeredIn(row(out, K(2)))).toEqual(['Start match', 'Cancel match']);
    expect(offeredIn(row(out, K(3)))).toEqual(['Void match']);
    // SF5 waits for the quarter-final winners: no start, only cancel.
    expect(row(out, K(5))).toContain('Waiting for Winner of match 1 and Winner of match 2');
    expect(offeredIn(row(out, K(5)))).toEqual(['Cancel match']);
    // QF4: a team withdrew — it can't start, and it's flagged.
    expect(row(out, K(4))).toContain('Golpe Final withdrew');
    expect(offeredIn(row(out, K(4)))).toEqual(['Cancel match']);
    // The women's category hasn't started, so its final can't either.
    expect(row(out, W(1))).toContain('Start the category first');
    expect(offeredIn(row(out, W(1)))).toEqual(['Cancel match']);
    // PLANNED matches can't start from here (they need the schedule first).
    expect(offeredIn(row(out, K(7)))).toEqual(['Cancel match']);
    // Terminal matches offer nothing.
    platform({ men: menBracket({ 2: 'CANCELLED', 3: 'VOID' }) });
    const after = await render();
    expect(offeredIn(row(after, K(2)))).toEqual([]);
    expect(offeredIn(row(after, K(3)))).toEqual([]);
  });

  it('shows the categories with progress and the commands their advertised next statuses allow', async () => {
    platform();
    const out = await render();
    const m = cat(out, MEN);
    expect(m).toContain('1/7 done · 1 in play');
    expect(offeredIn(m)).toEqual(['Complete category', 'Cancel category']);
    // ONCF-L6: completing settles the outcome and freezes the results — the warning says so.
    // (Readiness isn't stubbed here, so the API decides; the pre-block is in outcome.test.tsx.)
    expect(m).toContain(
      'Its official results and standings become final and are frozen: no result can be entered, accepted or corrected afterwards.',
    );
    expect(m).toContain('1 match is in play: cancelling the category doesn’t stop it.');
    const w = cat(out, WOMEN);
    expect(offeredIn(w)).toEqual(['Start category', 'Cancel category']);
    // Registration-stage categories stay in the overview.
    expect(out).not.toContain(`id="cat-${MIXED}"`);
    expect(out).toContain('1 other category is still in setup or cancelled');
  });

  it('blocks starting a category until the tournament is live or its matches exist, and says why', async () => {
    platform({ detail: managed({ status: 'PUBLISHED', next: ['ACTIVE', 'CANCELLED'] }) });
    let out = await render();
    expect(offeredIn(cat(out, WOMEN))).toEqual(['Cancel category']);
    expect(cat(out, WOMEN)).toContain(
      '<span class="mono">Start category</span> Start the tournament first',
    );
    expect(
      offeredIn(out.slice(out.indexOf('id="ops-lifecycle"'), out.indexOf('</header>'))),
    ).toEqual(['Start tournament', 'Cancel tournament']);
    expect(out).toContain('Start the tournament</strong>');

    platform();
    routes['GET /v1/competitions/club-open/events/women-open/bracket'] = () =>
      json(200, { rounds: [] });
    out = await render();
    expect(cat(out, WOMEN)).toContain('Generate its matches first');
    expect(cat(out, WOMEN)).toContain(`href="${BASE}/categories/${WOMEN}/structure">Go there`);
  });

  it('blocks completing the tournament while categories are open, then offers it', async () => {
    platform();
    let out = await render();
    const head = (o: string) => o.slice(o.indexOf('id="ops-lifecycle"'), o.indexOf('</header>'));
    expect(offeredIn(head(out))).toEqual(['Cancel tournament']);
    expect(head(out)).toContain(
      '<span class="mono">Complete tournament</span> 3 categories are still open — complete or cancel them first',
    );
    platform({
      detail: managed({
        events: [
          men('COMPLETED', []),
          women('CANCELLED', []),
          { ...mixed(), status: 'CANCELLED', nextStatuses: [] },
        ],
      }),
      men: menBracket({
        1: 'COMPLETED',
        2: 'COMPLETED',
        4: 'CANCELLED',
        5: 'COMPLETED',
        6: 'COMPLETED',
        7: 'COMPLETED',
      }),
    });
    out = await render();
    expect(offeredIn(head(out))).toEqual(['Complete tournament', 'Cancel tournament']);
    expect(out).toContain('Every category is closed');
  });

  it('points out what needs attention: late starts, stuck matches, categories ready to start', async () => {
    platform();
    const out = await render();
    const att = out.slice(
      out.indexOf('class="ops-attention"'),
      out.indexOf('</section>', out.indexOf('class="ops-attention"')),
    );
    expect(att).toContain('Women Open is ready to start');
    expect(att).toContain('Men Open · Match 2 was due at 09:00');
    expect(att).toContain(`href="#m-${K(2)}"`);
    expect(att).toContain('Men Open · Match 4 can’t start');
    expect(att).toContain('Golpe Final withdrew. Decide whether to cancel it.');
    // QF1 runs until 10:30; it's 09:45 — not running over.
    expect(att).not.toContain('running over');
    vi.setSystemTime(new Date('2026-11-14T16:45:00.000Z'));
    expect(await render()).toContain('Men Open · Match 1 is running over');
  });

  it('respects permissions: schedulers run matches, registration managers only follow', async () => {
    platform({ detail: managed({ permissions: SCHEDULER, roles: ['SCHEDULER'] }) });
    let out = await render();
    expect(offeredIn(row(out, K(1)))).toEqual(['Finish match']);
    expect(offeredIn(row(out, K(2)))).toEqual(['Start match']);
    expect(offeredIn(cat(out, MEN))).toEqual([]);
    expect(
      offeredIn(out.slice(out.indexOf('id="ops-lifecycle"'), out.indexOf('</header>'))),
    ).toEqual([]);
    expect(out).toContain('Scheduler. You can start and finish matches.');

    platform({ detail: managed({ permissions: REG_MANAGER, roles: ['REGISTRATION_MANAGER'] }) });
    out = await render();
    expect(offeredIn(out)).toEqual([]);
    expect(out).toContain('You can follow play here, but your role can’t change it.');
    // Still a full read-only view of the day.
    expect(row(out, K(1))).toContain('In play');
  });

  it('puts every command behind a confirmation naming the target, its state and the outcome', async () => {
    platform();
    const out = await render();
    const start = row(out, K(2));
    expect(start).toContain(
      '<details class="confirm ops-confirm" data-tone="go" data-command="start">',
    );
    expect(start).toContain(
      '<strong>Start match?</strong> <span>Men Open · Quarter-finals · Match 2 (Vibora Club vs Smash Sisters)</span>',
    );
    expect(start).toMatch(
      /<span>Scheduled<\/span><span aria-hidden="true">→<\/span><span class="sr-only"> becomes <\/span><span data-to="IN_PROGRESS">In play<\/span>/,
    );
    // Starting needs no reason or acknowledgement; cancelling needs both.
    const startForm = start.slice(0, start.indexOf('data-command="cancel"'));
    expect(startForm).not.toContain('name="reason"');
    expect(startForm).not.toContain('name="confirm"');
    const cancel = start.slice(start.indexOf('data-command="cancel"'));
    expect(cancel).toContain('<textarea name="reason" required="" minLength="1" maxLength="500"');
    expect(cancel).toMatch(/<input type="checkbox"[^>]*name="confirm" value="yes"/);
    expect(cancel).toMatch(/<input type="checkbox" required=""/);
    expect(cancel).toContain('class="btn btn-sm btn-danger"');
    expect(cancel).toContain('This can’t be undone.');
    // Void and the tournament's own closing commands too.
    expect(row(out, K(1))).toMatch(/data-command="void">.*name="reason".*name="confirm"/);
    expect(cat(out, MEN)).toMatch(/data-command="complete">.*name="confirm"/);
    // The form carries the state it was shown in, for the stale check.
    expect(start).toContain('<input type="hidden" name="from" value="SCHEDULED"/>');
    expect(start).toContain(`<input type="hidden" name="eventId" value="${MEN}"/>`);
  });

  it('keeps loading, empty and failure states honest', async () => {
    platform({
      detail: managed({ status: 'DRAFT', next: ['PUBLISHED', 'CANCELLED'], events: [] }),
    });
    let out = await render();
    expect(out).toContain('Not running yet');
    expect(offeredIn(out)).toEqual(['Cancel tournament']);

    platform({ detail: managed({ events: [mixed()] }) });
    out = await render();
    expect(out).toContain('No category is ready to run');

    // Without a published schedule nothing is SCHEDULED: every match is still to place.
    platform({
      published: false,
      men: menBracket({ 1: 'PLANNED', 2: 'PLANNED', 3: 'PLANNED', 4: 'PLANNED', 5: 'PLANNED' }),
    });
    routes['GET /v1/competitions/club-open/events/women-open/bracket'] = () =>
      json(200, { rounds: [] });
    out = await render();
    expect(out).toContain('No schedule is published yet');

    platform({ staff: null });
    routes['GET /v1/competitions/club-open/events/men-open/bracket'] = () => json(503, {});
    out = await render();
    expect(out).toContain('Some matches can’t be loaded right now: Men Open.');
    expect(out).toContain('The staff list can’t be loaded right now.');

    platform({ detail: null });
    out = await render();
    expect(out).toContain('This tournament can’t be loaded right now.');

    platform({
      detail: managed({ status: 'COMPLETED', next: [], events: [men('COMPLETED', [])] }),
    });
    out = await render();
    expect(out).toContain('This tournament is completed. Nothing here can change any more');
  });

  it('shows the staff on the tournament and the latest lifecycle changes', async () => {
    platform();
    const out = await render();
    expect(out).toContain(
      '<strong>Ana Mora</strong><span class="muted small">Scheduler · schedule and lineups</span>',
    );
    expect(out).toContain(`href="${BASE}/staff">Manage staff`);
    const recent = out.slice(out.indexOf('Latest changes'));
    expect(recent.indexOf('Men Open')).toBeLessThan(recent.indexOf('Tournament'));
    expect(recent).toContain('14 Nov, 08:30');
  });

  it('renders a 404 for a tournament of another organization', async () => {
    platform({
      detail: {
        ...managed(),
        competition: { ...managed().competition, organizerOrganizationId: 'other' },
      },
    });
    expect(await outcome(() => Page({ ...pc(), ...sp() }))).toBe('404');
  });
});

// ───────────────────────────── commands ─────────────────────────────

describe('operation commands', () => {
  const run = (fields: Record<string, string>) =>
    outcome(() => operateAction(form({ ...base, ...fields })));

  it('sends each command once to its canonical route and comes back to the refreshed workspace', async () => {
    platform();
    routes[`POST /v1/contests/${K(2)}/start`] = () =>
      json(200, { contestId: K(2), status: 'IN_PROGRESS' });
    expect(
      await run({
        target: 'match',
        command: 'start',
        targetId: K(2),
        eventId: MEN,
        from: 'SCHEDULED',
      }),
    ).toBe(`${BACK}?notice=operation_match_started`);
    expect(writes()).toEqual([
      { method: 'POST', path: `/v1/contests/${K(2)}/start`, body: undefined },
    ]);

    // The redirect target re-reads everything: the match now shows in play.
    platform({ men: menBracket({ 2: 'IN_PROGRESS' }) });
    const out = await render({ notice: 'operation_match_started' });
    expect(out).toContain('<p class="flash ok" role="status">Match started.</p>');
    expect(offeredIn(row(out, K(2)))).toEqual(['Finish match', 'Void match']);

    calls = [];
    routes[`POST /v1/events/${WOMEN}/start`] = () => json(200, {});
    expect(
      await run({ target: 'category', command: 'start', targetId: WOMEN, from: 'FIELD_LOCKED' }),
    ).toBe(`${BACK}?notice=operation_category_started`);
    calls = [];
    routes[`POST /v1/competitions/${COMP}/activate`] = () => json(200, {});
    expect(
      await run({ target: 'competition', command: 'activate', targetId: COMP, from: 'PUBLISHED' }),
    ).toBe(`${BACK}?notice=tournament_started`);
    expect(writes().map((c) => c.path)).toEqual([`/v1/competitions/${COMP}/activate`]);
  });

  it('requires the reason the API requires, and the acknowledgement of final operations', async () => {
    platform();
    routes[`POST /v1/contests/${K(1)}/void`] = () => json(200, {});
    expect(
      await run({
        target: 'match',
        command: 'void',
        targetId: K(1),
        eventId: MEN,
        from: 'IN_PROGRESS',
        reason: '  ',
        confirm: 'yes',
      }),
    ).toBe(`${BACK}?error=reason_required`);
    expect(
      await run({
        target: 'match',
        command: 'void',
        targetId: K(1),
        eventId: MEN,
        from: 'IN_PROGRESS',
        reason: 'Wrong court',
      }),
    ).toBe(`${BACK}?error=operation_confirm_required`);
    expect(
      await run({ target: 'category', command: 'complete', targetId: MEN, from: 'IN_PROGRESS' }),
    ).toBe(`${BACK}?error=operation_confirm_required`);
    expect(
      await run({
        target: 'match',
        command: 'void',
        targetId: K(1),
        eventId: MEN,
        from: 'IN_PROGRESS',
        reason: 'x'.repeat(501),
        confirm: 'yes',
      }),
    ).toBe(`${BACK}?error=operation_invalid`);
    expect(writes()).toEqual([]);
    expect(
      await run({
        target: 'match',
        command: 'void',
        targetId: K(1),
        eventId: MEN,
        from: 'IN_PROGRESS',
        reason: ' Played on the wrong court ',
        confirm: 'yes',
      }),
    ).toBe(`${BACK}?notice=operation_match_voided`);
    expect(writes()).toEqual([
      {
        method: 'POST',
        path: `/v1/contests/${K(1)}/void`,
        body: { reason: 'Played on the wrong court' },
      },
    ]);
  });

  it('refuses commands the workspace never offers, before calling the API', async () => {
    platform();
    for (const f of [
      { target: 'match', command: 'publish', targetId: K(1), eventId: MEN },
      { target: 'competition', command: 'publish', targetId: COMP },
      { target: 'category', command: 'void', targetId: MEN },
      { target: 'competition', command: 'activate', targetId: MEN },
      { target: 'match', command: 'start', targetId: 'not-a-uuid', eventId: MEN },
      { target: 'match', command: 'start', targetId: K(2) },
    ])
      expect(await run(f), JSON.stringify(f)).toBe(`${BACK}?error=operation_invalid`);
    expect(writes()).toEqual([]);
  });

  it('turns API refusals into organizer language', async () => {
    platform();
    const cases: [Response | null, string][] = [
      [err(403, 'FORBIDDEN'), 'operation_not_permitted'],
      [err(404, 'NOT_FOUND'), 'operation_not_found'],
      [err(400, 'INVALID_INPUT'), 'operation_invalid'],
      [json(503, {}), 'platform_unavailable'],
    ];
    for (const [res, code] of cases) {
      routes[`POST /v1/contests/${K(2)}/start`] = () => res as Response;
      expect(
        await run({
          target: 'match',
          command: 'start',
          targetId: K(2),
          eventId: MEN,
          from: 'SCHEDULED',
        }),
      ).toBe(`${BACK}?error=${code}`);
    }
    // Session gone: back to sign-in, nothing sent.
    calls = [];
    h.auth.getClaims.mockResolvedValue({ data: null, error: { message: 'x' } });
    expect(
      await run({
        target: 'match',
        command: 'start',
        targetId: K(2),
        eventId: MEN,
        from: 'SCHEDULED',
      }),
    ).toMatch(/^\/signin\?error=session_expired/);
    expect(writes()).toEqual([]);
  });

  it('explains a stale screen without retrying: someone else changed it, it was already done, or it is blocked', async () => {
    // Staff A saw QF2 scheduled; staff B already started it. The action only reads the state the
    // API now reports — the screen staff A submitted from travels in the form (`from`).
    platform({ men: menBracket({ 2: 'IN_PROGRESS' }) });
    routes[`POST /v1/contests/${K(2)}/start`] = () => err(409, 'INVALID_TRANSITION');
    expect(
      await run({
        target: 'match',
        command: 'start',
        targetId: K(2),
        eventId: MEN,
        from: 'SCHEDULED',
      }),
    ).toBe(`${BACK}?error=operation_already_done`);
    expect(writes()).toHaveLength(1);

    // Staff B cancelled it instead.
    calls = [];
    platform({ men: menBracket({ 2: 'CANCELLED' }) });
    routes[`POST /v1/contests/${K(2)}/start`] = () => err(409, 'INVALID_TRANSITION');
    expect(
      await run({
        target: 'match',
        command: 'start',
        targetId: K(2),
        eventId: MEN,
        from: 'SCHEDULED',
      }),
    ).toBe(`${BACK}?error=operation_stale`);
    expect(writes()).toHaveLength(1);

    // Nothing changed: the start is waiting on something (here, a team withdrew).
    calls = [];
    platform();
    routes[`POST /v1/contests/${K(4)}/start`] = () => err(409, 'INVALID_TRANSITION');
    expect(
      await run({
        target: 'match',
        command: 'start',
        targetId: K(4),
        eventId: MEN,
        from: 'SCHEDULED',
      }),
    ).toBe(`${BACK}?error=operation_blocked`);

    // Categories and the tournament read their state from the manage read.
    calls = [];
    platform({
      detail: managed({
        events: [men(), women('IN_PROGRESS', ['COMPLETED', 'CANCELLED']), mixed()],
      }),
    });
    routes[`POST /v1/events/${WOMEN}/start`] = () => err(409, 'INVALID_TRANSITION');
    expect(
      await run({ target: 'category', command: 'start', targetId: WOMEN, from: 'FIELD_LOCKED' }),
    ).toBe(`${BACK}?error=operation_already_done`);
    calls = [];
    platform({ detail: managed({ status: 'CANCELLED', next: [] }) });
    routes[`POST /v1/competitions/${COMP}/complete`] = () => err(409, 'INVALID_TRANSITION');
    expect(
      await run({
        target: 'competition',
        command: 'complete',
        targetId: COMP,
        from: 'ACTIVE',
        confirm: 'yes',
      }),
    ).toBe(`${BACK}?error=operation_stale`);
    expect(writes()).toHaveLength(1);

    // A screen state the form doesn't carry, or a failed re-read: the generic wording.
    calls = [];
    platform();
    routes[`POST /v1/contests/${K(2)}/start`] = () => err(409, 'INVALID_TRANSITION');
    expect(await run({ target: 'match', command: 'start', targetId: K(2), eventId: MEN })).toBe(
      `${BACK}?error=tournament_transition`,
    );
  });

  it('words every result and refusal it can redirect with', async () => {
    const { ERROR_MESSAGES, NOTICE_MESSAGES } = await import('../_lib/auth/messages');
    for (const o of Object.values(OPERATIONS)) expect(NOTICE_MESSAGES[o.notice]).toBeTruthy();
    for (const code of [
      'operation_not_permitted',
      'operation_not_found',
      'operation_invalid',
      'operation_confirm_required',
      'operation_stale',
      'operation_already_done',
      'operation_blocked',
    ] as const)
      expect(ERROR_MESSAGES[code]).toBeTruthy();
  });

  it('completing the tournament while a category is open says exactly that (EVENTS_OPEN)', async () => {
    const { ERROR_MESSAGES } = await import('../_lib/auth/messages');
    platform();
    routes[`POST /v1/competitions/${COMP}/complete`] = () =>
      json(409, { error: { code: 'INVALID_TRANSITION', reason: 'EVENTS_OPEN' } });
    expect(
      await run({
        target: 'competition',
        command: 'complete',
        targetId: COMP,
        from: 'ACTIVE',
        confirm: 'yes',
      }),
    ).toBe(`${BACK}?error=operation_events_open`);
    expect(writes()).toHaveLength(1);
    expect(ERROR_MESSAGES.operation_events_open).toContain('a category is still open');
    expect(ERROR_MESSAGES.operation_events_open).toContain('Nothing was changed');
  });
});

// ───────────────────────────── navigation, dates, layout ─────────────────────────────

describe('navigation and context', () => {
  it('reaches Operations from the hub without losing the tournament', async () => {
    platform({ detail: managed({ events: [men()] }) });
    routes[`GET /v1/competitions/${COMP}/availability`] = () =>
      json(200, {
        items: [6, 7].map((weekday) => ({
          availabilityId: `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${weekday}`,
          scope: 'COMPETITION',
          resourceId: null,
          kind: 'WEEKLY',
          weekday,
          start: '08:00',
          end: '20:00',
          recordedAt: '2026-10-08T00:00:00.000Z',
        })),
      });
    routes['GET /v1/catalog'] = () => json(200, { disciplineVersions: [], formatVersions: [] });
    const out = html(await Hub({ ...pc(), ...sp() }));
    expect(out).toContain(`<a href="${BACK}" data-key="operations">Operations</a>`);
    expect(out).toMatch(
      /data-key="operations"><a href="[^"]*\/operations">.*Live · 1 category in play/,
    );
    expect(out).toContain('Run the tournament');
  });

  it('places today against the tournament’s dates in its own zone', () => {
    const c = managed().competition;
    const at = (iso: string) => dayContext(c, Date.parse(iso));
    expect(at('2026-11-14T15:45:00.000Z')).toEqual({ today: 'Sat 14 Nov', day: 'Day 1 of 2' });
    // 23:30 Sunday in Costa Rica is still day 2 although it's Monday in UTC.
    expect(at('2026-11-16T05:30:00.000Z')).toEqual({ today: 'Sun 15 Nov', day: 'Day 2 of 2' });
    expect(at('2026-11-13T15:00:00.000Z').day).toBe('Starts tomorrow');
    expect(at('2026-11-10T15:00:00.000Z').day).toBe('Starts in 4 days');
    expect(at('2026-11-17T15:00:00.000Z').day).toBe('After the last scheduled day');
  });

  it('keeps rows readable on phones (stacked grid, no fixed widths that overflow)', () => {
    const css = readFileSync(new URL('../_product/product.css', import.meta.url), 'utf8');
    const block = css.slice(css.indexOf('/* ── Operations workspace (ONCF-L4)'));
    expect(block).toMatch(
      /@media \(max-width: 520px\) \{[^@]*\.ops-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/,
    );
    expect(block).toMatch(/\.ops-pulse \{[^}]*repeat\(2, minmax\(0, 1fr\)\)/);
    expect(block).not.toMatch(/min-width: \d{3,}px/);
  });
});
