import type { ReactElement } from 'react';
import type * as ReactDom from 'react-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompPermission } from '../../../../packages/competition/src/permissions';
import { ERROR_MESSAGES, NOTICE_MESSAGES } from '../_lib/auth/messages';
import { nextAction } from '../_lib/competition-hub';
import { categoryOps, competitionOps, completionBlock, OPERATIONS } from '../_lib/operations';
import { podiumGroups, type StaffOutcome } from '../_lib/results';
import { OutcomeSummary } from '../_product/competition-hub-ui';

// ONCF-L6 (ADR-0078) web surface: the category outcome on the results workspace (standings so far,
// readiness, blocking matches; the final podium and frozen rows once completed), operations
// pre-blocking completion on the API's real readiness, the hub's completed summary, and the
// public event / tournament pages showing OFFICIAL results only — the podium only once completed.
// The API stays the authority; these tests prove what the organizer and the public see.

const h = vi.hoisted(() => ({ auth: { getClaims: vi.fn(), getSession: vi.fn() }, pending: false }));
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
vi.mock('react-dom', async (original) => ({
  ...(await original<typeof ReactDom>()),
  useFormStatus: () => ({ pending: h.pending }),
}));

const ResultsPage = (await import('../app/orgs/[slug]/tournaments/[competitionId]/results/page'))
  .default;
const PublicEventPage = (await import('../(explorer)/competitions/[slug]/events/[eventSlug]/page'))
  .default;
const PublicCompetitionPage = (await import('../(explorer)/competitions/[slug]/page')).default;

// ───────────────────────────── fixtures ─────────────────────────────

const ORG = '0b9b4b8e-6f0a-4f3e-9d6a-1c2b3c4d5e6f';
const COMP = '22222222-2222-4222-8222-222222222222';
const LIVE = '33333333-3333-4333-8333-333333333331';
const DONE = '33333333-3333-4333-8333-333333333332';
const C = (n: number) => `cccccccc-cccc-4ccc-8ccc-00000000000${n}`;
const P = (n: number) => `dddddddd-dddd-4ddd-8ddd-00000000000${n}`;
const NAMES = ['Ana Rojas', 'Bea Solís', 'Caro Mena', 'Dani Vega'];
const ZONE = 'America/Costa_Rica';
const OWNER = Object.values(CompPermission);
const BASE = `/app/orgs/club-uno/tournaments/${COMP}`;

function event(id: string, slug: string, name: string, status: string) {
  return {
    id,
    slug,
    status,
    entrantKind: 'INDIVIDUAL',
    discipline: {
      versionId: 'dv',
      sport: { code: 'tennis', name: 'Tennis' },
      code: 'tennis',
      name: 'Tennis',
      version: 1,
    },
    format: { versionId: 'fv', code: 'rr', name: 'Round robin', version: 2, engine: 'x' },
    formatConfig: {},
    settings: {
      name,
      category: {},
      capacity: 4,
      registrationMode: 'AUTO_CONFIRM',
      registrationOpensAt: null,
      registrationClosesAt: null,
      startsAt: null,
      endsAt: null,
      timezone: ZONE,
    },
    counts: { confirmed: 4, waitlisted: 0, participants: 4 },
    editable: { settings: false, capacityAndRegistrationMode: false },
    nextStatuses: status === 'IN_PROGRESS' ? ['COMPLETED', 'CANCELLED'] : [],
    createdAt: '2026-10-06T00:00:00Z',
    updatedAt: '2026-10-06T00:00:00Z',
    statusChangedAt: '2026-11-14T14:30:00.000Z',
  };
}

function managed(o: { status?: string; events?: ReturnType<typeof event>[] } = {}) {
  return {
    competition: {
      id: COMP,
      slug: 'club-open',
      organizerOrganizationId: ORG,
      status: o.status ?? 'ACTIVE',
      profile: {
        name: 'Club Open',
        description: null,
        locationLabel: 'Club Uno',
        regionCode: 'CR',
        timezone: ZONE,
        startsAt: '2026-11-14T14:00:00.000Z',
        endsAt: '2026-11-16T02:00:00.000Z',
        website: null,
      },
      editable: { profile: true, addEvents: false },
      nextStatuses: o.status === 'COMPLETED' ? [] : ['COMPLETED', 'CANCELLED'],
      createdAt: '2026-10-06T00:00:00Z',
      updatedAt: '2026-10-06T00:00:00Z',
      statusChangedAt: '2026-11-14T14:00:00.000Z',
    },
    events: o.events ?? [
      event(LIVE, 'women-open', 'Women Open', 'IN_PROGRESS'),
      event(DONE, 'men-open', 'Men Open', 'COMPLETED'),
    ],
    access: { staffRoles: ['OWNER'], permissions: OWNER },
  };
}

const side = (slot: number, n: number) => ({
  slot,
  kind: 'PARTICIPANT',
  participantId: P(n),
  display: { kind: 'ATHLETE', athleteSlug: `p${n}`, displayName: NAMES[n - 1] },
});
const match = (id: string, n: number, status: string, a: number, b: number) => ({
  contestId: id,
  sequence: n,
  contestType: 'MATCH',
  status,
  round: { sequence: 1, label: 'Round 1', roundType: 'GROUP' },
  scheduledStart: null,
  scheduledEnd: null,
  locationLabel: null,
  courtLabel: null,
  slots: [side(1, a), side(2, b)],
});
const bracket = (contests: unknown[]) => ({
  rounds: [
    {
      sequence: 1,
      label: 'Round 1',
      roundType: 'GROUP',
      stage: { key: 's1', label: 'Round robin', primitive: 'ROUND_ROBIN', partitionKind: null },
      byes: [],
      contests,
    },
  ],
});
const field = () =>
  NAMES.map((name, i) => ({
    participantId: P(i + 1),
    registrationId: `r-${i}`,
    kind: 'INDIVIDUAL',
    athleteId: `a-${i}`,
    teamId: null,
    teamName: null,
    status: 'ACTIVE',
    seed: null,
    rosterSize: 1,
    attributes: [],
    athlete: { athleteId: `a-${i}`, slug: `p${i + 1}`, displayName: name },
  }));
const scoring = () => ({
  eventId: 'x',
  pinned: true,
  frozen: true,
  ruleset: {
    versionId: 'rs',
    code: 'sets-bo3',
    name: 'Best of three sets',
    version: 1,
    family: 'SETS_OF_GAMES',
    specHash: 'sha256:0',
    spec: { family: 'SETS_OF_GAMES', parameters: { bestOf: 3 } },
    basis: { kind: 'COMMON_PRACTICE', note: 'x' },
  },
  classificationTemplate: null,
  advancementPolicy: null,
  schedulingProfile: null,
  stageOverrides: {},
});
const entry = (n: number, position: number, tied = false, wins = '0') => ({
  participantId: P(n),
  position,
  tied,
  status: 'CLASSIFIED',
  values: [{ key: 'wins', value: wins }],
});

/** Women Open, in play: 1 of 3 matches official, one still in play, one finished without a result. */
const liveOutcome = (o: Partial<StaffOutcome['readiness']> = {}): StaffOutcome => ({
  eventId: LIVE,
  eventStatus: 'IN_PROGRESS',
  final: false,
  outcome: {
    kind: 'STANDINGS',
    status: 'PENDING',
    reasons: [{ code: 'CLASSIFICATION_INCOMPLETE', contestIds: [C(2), C(3)] }],
    placements: [],
    standings: [
      {
        document: {
          complete: false,
          policy: { code: 'itf_rr', version: 1 },
          entries: [entry(1, 1, false, '1'), entry(2, 2), entry(3, 2)],
        },
      },
    ],
  },
  hash: 'sha256:live',
  readiness: {
    ready: false,
    contestsOpen: [C(2)],
    resultsNotOfficial: [C(3)],
    required: 3,
    official: 1,
    ...o,
  },
});
/** Men Open, completed: Ana champion, Bea and Caro joint third (1, 2? no: 1, 3, 3 shared). */
const doneOutcome = (): StaffOutcome => ({
  eventId: DONE,
  eventStatus: 'COMPLETED',
  final: true,
  outcome: {
    kind: 'STANDINGS',
    status: 'DECIDED',
    reasons: [{ code: 'TIE_UNBROKEN_LOT' }],
    placements: [
      { participantId: P(1), position: 1, tied: false },
      { participantId: P(2), position: 2, tied: true },
      { participantId: P(3), position: 2, tied: true },
      { participantId: P(4), position: 4, tied: false },
    ],
    standings: [
      {
        document: {
          complete: true,
          policy: { code: 'itf_rr', version: 1 },
          entries: [
            entry(1, 1, false, '3'),
            entry(2, 2, true, '1'),
            entry(3, 2, true, '1'),
            entry(4, 4),
          ],
        },
      },
    ],
  },
  hash: 'sha256:done',
  readiness: { ready: false, contestsOpen: [], resultsNotOfficial: [], required: 6, official: 6 },
});

const official = (n: number, w: string) => ({
  resultVersionId: `eeeeeeee-eeee-4eee-8eee-00000000000${n}`,
  versionNumber: 1,
  contentHash: `sha256:${n}`,
  status: 'OFFICIAL',
  current: true,
  supersedesVersionId: null,
  content: {
    entries: [
      { participantId: w, outcome: 'WIN' },
      { participantId: w === P(1) ? P(2) : P(1), outcome: 'LOSS' },
    ],
  },
  recordedAt: '2026-11-14T16:40:00.000Z',
});

// ───────────────────────────── fake platform ─────────────────────────────

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
let routes: Record<string, () => Response> = {};
let calls: { method: string; path: string }[] = [];

function platform(o: { live?: StaffOutcome | null; detail?: ReturnType<typeof managed> } = {}) {
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
    [`GET /v1/competitions/${COMP}/manage`]: () => json(200, o.detail ?? managed()),
    'GET /v1/competitions/club-open/events/women-open/bracket': () =>
      json(
        200,
        bracket([
          match(C(1), 1, 'COMPLETED', 1, 2),
          match(C(2), 2, 'IN_PROGRESS', 1, 3),
          match(C(3), 3, 'COMPLETED', 2, 3),
        ]),
      ),
    'GET /v1/competitions/club-open/events/men-open/bracket': () =>
      json(200, bracket([match(C(4), 4, 'COMPLETED', 1, 2)])),
    [`GET /v1/events/${LIVE}/field`]: () => json(200, { items: field() }),
    [`GET /v1/events/${DONE}/field`]: () => json(200, { items: field() }),
    [`GET /v1/events/${LIVE}/scoring`]: () => json(200, scoring()),
    [`GET /v1/events/${DONE}/scoring`]: () => json(200, scoring()),
    [`GET /v1/contests/${C(1)}/results`]: () =>
      json(200, { contestId: C(1), versions: [official(1, P(1))] }),
    [`GET /v1/contests/${C(2)}/results`]: () => json(200, { contestId: C(2), versions: [] }),
    [`GET /v1/contests/${C(3)}/results`]: () => json(200, { contestId: C(3), versions: [] }),
    [`GET /v1/contests/${C(4)}/results`]: () =>
      json(200, { contestId: C(4), versions: [official(4, P(1))] }),
    [`GET /v1/events/${LIVE}/outcome`]: () =>
      o.live === null ? json(503, {}) : json(200, o.live ?? liveOutcome()),
    [`GET /v1/events/${DONE}/outcome`]: () => json(200, doneOutcome()),
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
  platform();
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const c = { method: init.method ?? 'GET', path: u.pathname };
    calls.push(c);
    const r = routes[`${c.method} ${c.path}`];
    return Promise.resolve(r === undefined ? json(404, {}) : r());
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const html = (el: ReactElement | null) => (el === null ? '' : renderToStaticMarkup(el));
const results = async () =>
  html(
    await ResultsPage({
      params: Promise.resolve({ slug: 'club-uno', competitionId: COMP }),
      searchParams: Promise.resolve({}),
    }),
  );
/** One category's outcome panel. */
const panel = (out: string, name: string) => {
  const at = out.indexOf(`aria-label="${name} outcome"`);
  if (at < 0) return '';
  return out.slice(at, out.indexOf('</section>', at));
};
const row = (out: string, id: string) => {
  const at = out.indexOf(`<li id="r-${id}"`);
  if (at < 0) return '';
  return out.slice(at, out.indexOf('</li>', out.indexOf('rs-body', at)) + 5);
};

// ───────────────────────────── organizer results ─────────────────────────────

describe('results workspace · category outcome', () => {
  it('in play: standings so far from official results only, readiness and what blocks — no podium', async () => {
    const out = await results();
    const p = panel(out, 'Women Open');
    expect(p).toContain('Standings so far — official results only');
    expect(p).toContain('Official results: 1 / 3');
    expect(p).toContain(`href="#r-${C(2)}"`);
    expect(p).toContain(`href="#r-${C(3)}"`);
    expect(p).toContain('Some matches still need an official result.');
    expect(p).toContain('Ana Rojas');
    expect(p).not.toContain('Champion');
    expect(p).not.toContain('Complete the category in operations');
    // The live category's rows still offer their actions.
    expect(row(out, C(3))).toContain('Enter result');
  });

  it('ready: links to operations to complete (completion itself stays there)', async () => {
    platform({
      live: liveOutcome({ ready: true, contestsOpen: [], resultsNotOfficial: [], official: 3 }),
    });
    const p = panel(await results(), 'Women Open');
    expect(p).toContain(`href="${BASE}/operations#cat-${LIVE}"`);
    expect(p).toContain('Ready · complete the category in operations');
    expect(p).not.toContain('<form');
  });

  it('empty and unreadable states', async () => {
    platform({ live: liveOutcome({ official: 0 }) });
    expect(panel(await results(), 'Women Open')).toContain('No official results yet.');
    platform({ live: null });
    expect(panel(await results(), 'Women Open')).toContain('The outcome can’t be read right now');
  });

  it('completed: the final podium with ties shared, the authority note, frozen rows without actions', async () => {
    const out = await results();
    const p = panel(out, 'Men Open');
    expect(p).toContain('Final · Official (organizer-declared), not independently verified');
    expect(p).toContain('Champion');
    expect(p).toContain('Joint runner-up');
    expect(p).toContain('Bea Solís · Caro Mena');
    // Positions ≤ 3 only: 4th is never on the podium.
    expect(p.slice(0, p.indexOf('rs-standings'))).not.toContain('Dani Vega');
    expect(p).toContain('Results frozen');
    expect(p).toContain('A tie that only an organizer lot could separate stays shared.');
    const frozen = row(out, C(4));
    expect(frozen).toContain('Results frozen: the category is completed.');
    expect(frozen).not.toContain('Correct result');
    expect(frozen).not.toContain('Declare official');
  });

  it('podium groups never invent a place (1, 1, 3 has no runner-up)', () => {
    const g = podiumGroups([
      { participantId: P(1), position: 1, tied: true },
      { participantId: P(2), position: 1, tied: true },
      { participantId: P(3), position: 3, tied: false },
      { participantId: P(4), position: 4, tied: false },
    ]);
    expect(g.map((x) => [x.position, x.label, x.entrants.length])).toEqual([
      [1, 'Joint champions', 2],
      [3, 'Third', 1],
    ]);
  });
});

// ───────────────────────────── operations ─────────────────────────────

describe('operations · completion settles the outcome', () => {
  it('the copy says what completion does now (no "later release", no "doesn’t make results official")', () => {
    const consequence = (key: keyof typeof OPERATIONS) => OPERATIONS[key].consequence;
    expect(consequence('category:complete')).toContain('frozen');
    expect(consequence('category:complete')).not.toContain('doesn’t make any result official');
    expect(consequence('competition:complete')).not.toContain('doesn’t make any result official');
    for (const k of [
      'result_frozen',
      'operation_contests_open',
      'operation_results_not_official',
      'operation_outcome_undecided',
      'operation_no_completed_category',
    ] as const)
      expect(ERROR_MESSAGES[k]).toContain('Nothing was changed');
    expect(NOTICE_MESSAGES.operation_category_completed).toContain('frozen');
  });

  it('pre-blocks Complete category on the API’s readiness, with the reason', () => {
    const data = managed() as never;
    const block = (o: StaffOutcome | null) =>
      categoryOps(data, BASE, [], new Set([LIVE]), new Map([[LIVE, o]])).find(
        (x) => x.event.id === LIVE,
      );
    const open = block(liveOutcome());
    expect(open?.operations.some((o) => o.command === 'complete')).toBe(false);
    expect(open?.blocked).toMatchObject({
      label: 'Complete category',
      reason: '1 match is still open — finish it, or cancel what won’t be played',
      href: `${BASE}/results#res-outcome`,
    });
    expect(completionBlock(liveOutcome({ contestsOpen: [] }))).toBe(
      '1 finished match needs an official result',
    );
    const ready = block(
      liveOutcome({ ready: true, contestsOpen: [], resultsNotOfficial: [], official: 3 }),
    );
    expect(ready?.operations.some((o) => o.command === 'complete')).toBe(true);
    // Unknown readiness: offered, the API decides.
    expect(block(null)?.operations.some((o) => o.command === 'complete')).toBe(true);
  });

  it('the tournament can’t complete with no completed category', () => {
    const allCancelled = managed({
      events: [event(LIVE, 'women-open', 'Women Open', 'CANCELLED')],
    }) as never;
    expect(competitionOps(allCancelled).blocked?.reason).toContain('No category was completed');
    const settled = managed({
      events: [
        event(LIVE, 'women-open', 'Women Open', 'CANCELLED'),
        event(DONE, 'men-open', 'Men Open', 'COMPLETED'),
      ],
    }) as never;
    expect(competitionOps(settled).operations.some((o) => o.command === 'complete')).toBe(true);
  });
});

// ───────────────────────────── hub ─────────────────────────────

describe('competition hub · completed outcome', () => {
  it('a completed tournament points to its final results, not to a later release', () => {
    const next = nextAction(managed({ status: 'COMPLETED' }) as never, BASE);
    expect(next.label).toBe('Tournament completed');
    expect(next.detail).not.toContain('later release');
    expect(next.detail).toContain('1 category settled');
    expect(next.href).toBe(`${BASE}/results`);
  });

  it('summarizes completed categories with champions (joint when tied) and links', () => {
    const display = (n: number) => ({
      kind: 'ATHLETE' as const,
      athleteSlug: `p${n}`,
      displayName: NAMES[n - 1] as string,
    });
    const out = html(
      OutcomeSummary({
        base: BASE,
        publicHref: '/competitions/club-open',
        outcome: {
          competition: { id: COMP, status: 'ACTIVE' },
          authority: 'ORGANIZER_DECLARED',
          events: [
            {
              id: DONE,
              slug: 'men-open',
              name: 'Men Open',
              status: 'COMPLETED',
              final: true,
              kind: 'KNOCKOUT',
              champions: [{ participantId: P(1), display: display(1), position: 1, tied: false }],
            },
            {
              id: LIVE,
              slug: 'women-open',
              name: 'Women Open',
              status: 'COMPLETED',
              final: true,
              kind: 'STANDINGS',
              champions: [
                { participantId: P(2), display: display(2), position: 1, tied: true },
                { participantId: P(3), display: display(3), position: 1, tied: true },
              ],
            },
          ],
        },
      }),
    );
    expect(out).toContain('Champion:');
    expect(out).toContain('Joint champions:');
    expect(out).toContain(`href="${BASE}/results"`);
    expect(out).toContain('href="/competitions/club-open"');
    expect(out).toContain('not independently verified');
    expect(html(OutcomeSummary({ base: BASE, publicHref: '/x', outcome: null }))).toBe('');
  });
});

// ───────────────────────────── public pages ─────────────────────────────

const pubEvent = (status: string) => ({
  competition: { id: COMP, slug: 'club-open', name: 'Club Open', status: 'ACTIVE' },
  event: {
    id: LIVE,
    slug: 'women-open',
    name: 'Women Open',
    status,
    entrantKind: 'INDIVIDUAL',
    sport: { code: 'tennis', name: 'Tennis' },
    discipline: { code: 'tennis', name: 'Tennis', version: 2 },
    format: { code: 'rr', name: 'Round robin', version: 2, engine: 'round-robin/2' },
    category: {},
    capacity: 4,
    confirmedCount: 4,
    waitlistCount: 0,
    participantCount: 4,
    registration: { opensAt: null, closesAt: null },
    startsAt: null,
    endsAt: null,
    timezone: ZONE,
  },
  field: { locked: true, fieldHash: null },
  seeding: null,
  plan: null,
  canonical: { competitionSlug: 'club-open', eventSlug: 'women-open' },
  redirected: false,
});
const athlete = (n: number) => ({
  kind: 'ATHLETE',
  athleteSlug: `p${n}`,
  displayName: NAMES[n - 1],
});
const pubOutcome = (final: boolean, status = final ? 'COMPLETED' : 'IN_PROGRESS') => ({
  schema: 'br:public-event-outcome@1',
  event: { id: LIVE, status },
  final,
  authority: 'ORGANIZER_DECLARED',
  kind: 'KNOCKOUT',
  podium: final
    ? {
        status: 'AVAILABLE',
        placements: [
          { participantId: P(1), display: athlete(1), position: 1, tied: false },
          { participantId: P(2), display: athlete(2), position: 2, tied: false },
          { participantId: P(3), display: athlete(3), position: 3, tied: true },
          { participantId: P(4), display: athlete(4), position: 3, tied: true },
        ],
      }
    : {
        status: 'NOT_AVAILABLE',
        reason: status === 'CANCELLED' ? 'EVENT_CANCELLED' : 'EVENT_NOT_COMPLETED',
      },
  standings: [],
  matches: [
    {
      contestId: C(1),
      sequence: 1,
      roundLabel: 'Final',
      roundSequence: 2,
      groupKey: null,
      status: 'COMPLETED',
      official: true,
      entrants: [
        {
          participantId: P(1),
          display: athlete(1),
          outcome: 'WIN',
          score: [{ key: 'setsWon', value: '2' }],
        },
        {
          participantId: P(2),
          display: athlete(2),
          outcome: 'LOSS',
          score: [{ key: 'setsWon', value: '0' }],
        },
      ],
    },
    {
      contestId: C(2),
      sequence: 2,
      roundLabel: 'Semifinal',
      roundSequence: 1,
      groupKey: null,
      status: 'COMPLETED',
      official: false,
      entrants: [
        { participantId: P(3), display: athlete(3), outcome: null, score: [] },
        { participantId: P(4), display: athlete(4), outcome: null, score: [] },
      ],
    },
  ],
  notes: [],
});
function publicPlatform(status: string, outcome: unknown) {
  const base = '/v1/competitions/club-open/events/women-open';
  routes = {
    [`GET ${base}`]: () => json(200, pubEvent(status)),
    [`GET ${base}/participants`]: () => json(200, { items: [] }),
    [`GET ${base}/schedule`]: () => json(200, { items: [] }),
    [`GET ${base}/bracket`]: () => json(200, { rounds: [] }),
    [`GET ${base}/outcome`]: () => json(200, outcome),
  };
}
const eventPage = async () =>
  html(
    await PublicEventPage({
      params: Promise.resolve({ slug: 'club-open', eventSlug: 'women-open' }),
    }),
  );

describe('public pages · official outcome only', () => {
  it('in play: official results so far, the podium withheld', async () => {
    publicPlatform('IN_PROGRESS', pubOutcome(false));
    const out = await eventPage();
    expect(out).toContain('Results &amp; standings');
    expect(out).toContain('Standings so far — official results only');
    expect(out).toContain('The podium is shown once the category is completed.');
    expect(out).not.toContain('aria-label="Podium"');
    expect(out).not.toContain('Champion');
    expect(out).toContain('Official results');
    expect(out).toContain('win');
    // The match without an official result is not listed as a result at all.
    expect(out.match(/Semifinal ·/g)).toBeNull();
  });

  it('completed: final result, podium with joint third, authority note', async () => {
    publicPlatform('COMPLETED', pubOutcome(true));
    const out = await eventPage();
    expect(out).toContain('Final result');
    expect(out).toContain('aria-label="Podium"');
    expect(out).toContain('Champion:');
    expect(out).toContain('Runner-up:');
    expect(out).toContain('Joint third:');
    expect(out).toContain('Official (organizer-declared) · not independently verified');
    expect(out).not.toContain('Not available yet');
  });

  it('D-P4: an official tennis result reads as its set score, winner first, tie-break included', async () => {
    const outcome = pubOutcome(true);
    const sets = (id: string, games: number[], tb: number) => [
      ...games.map((g, i) => ({
        participantId: id,
        ordinal: i + 1,
        mark: { metricId: 'sog.set_games', value: String(g), unit: 'games', precision: 0 },
      })),
      {
        participantId: id,
        ordinal: 13,
        mark: { metricId: 'sog.tiebreak_points', value: String(tb), unit: 'points', precision: 0 },
      },
    ];
    // The loser is listed first: the line still reads from the winner's side.
    outcome.matches[0] = {
      ...outcome.matches[0]!,
      entrants: [...outcome.matches[0]!.entrants].reverse(),
      scoring: {
        family: 'SETS_OF_GAMES',
        content: {
          entries: [
            { participantId: P(1), outcome: 'WIN' },
            { participantId: P(2), outcome: 'LOSS' },
          ],
          performances: [...sets(P(1), [6, 4, 7], 7), ...sets(P(2), [3, 6, 6], 5)],
        },
      },
    } as unknown as (typeof outcome.matches)[number];
    publicPlatform('COMPLETED', outcome);
    const out = await eventPage();
    expect(out).toMatch(
      new RegExp(
        `${NAMES[0]}</a> d\\. <a[^>]*>${NAMES[1]}</a> <small[^>]*>· 6–3 4–6 7–6 \\(7–5\\)`,
      ),
    );
    expect(out).not.toContain('setsWon');
  });

  it('D-P4: without score marks (older API, other families) the generic values stay', async () => {
    publicPlatform('COMPLETED', pubOutcome(true));
    expect(await eventPage()).toContain('(setsWon 2)');
  });

  it('cancelled: no outcome is fabricated; recorded official results are kept as history', async () => {
    publicPlatform('CANCELLED', pubOutcome(false, 'CANCELLED'));
    const out = await eventPage();
    expect(out).toContain('Category cancelled — no outcome is decided.');
    expect(out).not.toContain('aria-label="Podium"');
  });

  it('before play: results appear once matches are played', async () => {
    publicPlatform('REGISTRATION_OPEN', pubOutcome(false, 'REGISTRATION_OPEN'));
    expect(await eventPage()).toContain('Results appear here once matches are played.');
  });

  it('the tournament page shows each completed category’s champion(s)', async () => {
    routes = {
      'GET /v1/competitions/club-open': () =>
        json(200, {
          competition: {
            id: COMP,
            slug: 'club-open',
            name: 'Club Open',
            description: null,
            status: 'COMPLETED',
            timezone: ZONE,
            startsAt: null,
            endsAt: null,
            locationLabel: null,
            organizer: { organizationId: ORG, slug: 'club-uno', displayName: 'Club Uno' },
          },
          events: [{ ...pubEvent('COMPLETED').event }],
          authority: { status: 'NOT_AVAILABLE', reason: 'SOURCE_NOT_IMPLEMENTED' },
          canonicalSlug: 'club-open',
          redirected: false,
        }),
      'GET /v1/competitions/club-open/outcome': () =>
        json(200, {
          schema: 'br:public-competition-outcome@1',
          competition: { id: COMP, status: 'COMPLETED' },
          authority: 'ORGANIZER_DECLARED',
          events: [
            {
              id: LIVE,
              slug: 'women-open',
              name: 'Women Open',
              status: 'COMPLETED',
              final: true,
              kind: 'STANDINGS',
              champions: [
                { participantId: P(1), display: athlete(1), position: 1, tied: true },
                { participantId: P(2), display: athlete(2), position: 1, tied: true },
              ],
            },
          ],
        }),
    };
    const out = html(
      await PublicCompetitionPage({ params: Promise.resolve({ slug: 'club-open' }) }),
    );
    expect(out).toContain('Joint champions:');
    expect(out).toContain('Ana Rojas');
    expect(out).toContain('Competition completed · 1 category with a final result.');
    expect(out).not.toContain('Not available yet');
  });
});
