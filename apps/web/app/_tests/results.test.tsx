import { readFileSync } from 'node:fs';
import type { ReactElement } from 'react';
import type * as ReactDom from 'react-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompPermission } from '../../../../packages/competition/src/permissions';
import { RULESET_FAMILIES, RULESET_TEMPLATES } from '../../../../packages/competition/src/ruleset';
import { scoreContest } from '../../../../packages/competition/src/scoring/execute';
import type { ScoreSheet } from '../../../../packages/competition/src/scoring/types';
import { IMPLEMENTED_TRANSITIONS } from '../../../../packages/domain/src/results';
import { ERROR_MESSAGES, NOTICE_MESSAGES } from '../_lib/auth/messages';
import { RESULT_STAFF_ROLES, TRANSITIONS, type ResultContent } from '../_lib/results';
import {
  ENTRY_FAMILIES,
  formValues,
  officialScore,
  scoreLine,
  sheetFromForm,
  sheetLayout,
  type EntryFamily,
} from '../_lib/score-sheet';
import type { EntryState } from '../app/orgs/[slug]/tournaments/[competitionId]/results/actions';

// ONCF-L5 results workspace: the web surface over the existing ResultLedger (enter, accept, declare
// official, correct), rendered and exercised against a fake session + fake platform API. The API
// stays the authority (sheet validation under the pinned ruleset, result authority, ledger
// serialization); these tests prove the organizer view of it — which matches need what, the score
// sheet each ruleset family takes, that a score is checked before it is recorded and recorded
// exactly as checked, and that refusals and stale screens come back as plain words. Stored results
// in the fixtures are produced by the real ruleset executor, so reading them back is tested
// against genuine `@1` content.

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

const Page = (await import('../app/orgs/[slug]/tournaments/[competitionId]/results/page')).default;
const { entryAction, transitionAction } =
  await import('../app/orgs/[slug]/tournaments/[competitionId]/results/actions');
const Hub = (await import('../app/orgs/[slug]/tournaments/[competitionId]/page')).default;

// ───────────────────────────── fixtures: a padel and basketball open, Saturday ─────────────────────────────

const ORG = '0b9b4b8e-6f0a-4f3e-9d6a-1c2b3c4d5e6f';
const COMP = '22222222-2222-4222-8222-222222222222';
const MEN = '33333333-3333-4333-8333-333333333331';
const HOOPS = '33333333-3333-4333-8333-333333333332';
const RUN = '33333333-3333-4333-8333-333333333333';
const K = (n: number) => `cccccccc-cccc-4ccc-8ccc-00000000000${n}`;
const B1 = 'cccccccc-cccc-4ccc-8ccc-0000000000b1';
const P = (n: number) => `dddddddd-dddd-4ddd-8ddd-00000000000${n}`;
const H = (n: number) => `dddddddd-dddd-4ddd-8ddd-0000000000b${n}`;
const V = (n: number) => `eeeeeeee-eeee-4eee-8eee-00000000000${n}`;
const RS_PADEL = 'ffffffff-ffff-4fff-8fff-000000000001';
const RS_MTB = 'ffffffff-ffff-4fff-8fff-000000000002';
const RS_HOOPS = 'ffffffff-ffff-4fff-8fff-000000000003';
const ZONE = 'America/Costa_Rica';
const OWNER = Object.values(CompPermission);
const SCHEDULER = ['COMP_VIEW_PRIVATE', 'COMP_MANAGE_SCHEDULE', 'COMP_MANAGE_LINEUPS'];
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
const HASH = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;

const template = (code: string) => {
  const t = RULESET_TEMPLATES.find((x) => x.code === code);
  if (t === undefined) throw new Error(code);
  return t;
};
const PADEL = template('padel-bo3-star-point');
const MTB = template('sets-2-plus-match-tiebreak-no-ad');
const BASKET = template('basketball-4x10');

/** Stored content exactly as the API would store it: the real executor's `@1` output. */
function stored(
  spec: (typeof PADEL)['spec'],
  sides: [string, string],
  sheet: ScoreSheet,
): ResultContent {
  const out = scoreContest({ ruleset: spec, mode: 'HEAD_TO_HEAD', participants: sides }, sheet);
  if (!out.ok) throw new Error(JSON.stringify(out.issues));
  return out.content as unknown as ResultContent;
}
const sets = (...s: [number, number][]): ScoreSheet => ({
  family: 'SETS_OF_GAMES',
  sets: s.map((games) => ({ games })),
});

function version(
  n: number,
  status: string,
  content: ResultContent,
  o: { current?: boolean; supersedes?: string | null; hash?: string } = {},
) {
  return {
    resultVersionId: V(n),
    versionNumber: n,
    contentHash: o.hash ?? HASH(n),
    status,
    current: o.current ?? ['PROVISIONAL', 'OFFICIAL'].includes(status),
    supersedesVersionId: o.supersedes ?? null,
    content,
    recordedAt: '2026-11-14T16:40:00.000Z',
  };
}

const QF3 = stored(PADEL.spec, [P(5), P(6)], sets([6, 3], [6, 4]));
const QF4 = stored(PADEL.spec, [P(7), P(8)], sets([4, 6], [6, 2], [7, 5]));
const QF4B = stored(PADEL.spec, [P(7), P(8)], sets([4, 6], [6, 2], [5, 7]));
const QF5 = stored(PADEL.spec, [P(1), P(3)], sets([6, 0], [6, 1]));

function event(id: string, slug: string, name: string, status: string, sport: string) {
  return {
    id,
    slug,
    status,
    entrantKind: 'TEAM',
    discipline: {
      versionId: 'dv',
      sport: { code: sport, name: sport },
      code: sport,
      name: sport,
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
    nextStatuses: ['COMPLETED', 'CANCELLED'],
    createdAt: '2026-10-06T00:00:00Z',
    updatedAt: '2026-10-06T00:00:00Z',
    statusChangedAt: '2026-11-14T14:30:00.000Z',
  };
}

function managed(
  o: Partial<{ status: string; permissions: string[]; roles: string[]; events: unknown[] }> = {},
) {
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
      nextStatuses: ['COMPLETED', 'CANCELLED'],
      createdAt: '2026-10-06T00:00:00Z',
      updatedAt: '2026-10-06T00:00:00Z',
      statusChangedAt: '2026-11-14T14:00:00.000Z',
    },
    events: o.events ?? [
      event(MEN, 'men-open', 'Men Open', 'IN_PROGRESS', 'padel'),
      event(HOOPS, 'hoops', 'Hoops', 'IN_PROGRESS', 'basketball'),
      event(RUN, 'fun-run', 'Fun Run', 'IN_PROGRESS', 'running'),
    ],
    access: { staffRoles: o.roles ?? ['OWNER'], permissions: o.permissions ?? OWNER },
  };
}

const side = (slot: number, id: string, name: string) => ({
  slot,
  kind: 'PARTICIPANT',
  participantId: id,
  display: { kind: 'TEAM', teamName: name },
});
const team = (n: number, slot: number) => side(slot, P(n), TEAMS[n - 1] as string);
const winnerOf = (slot: number, of: number, resolved?: number) =>
  resolved === undefined
    ? { slot, kind: 'WINNER_OF_CONTEST', contestId: K(of), contestSequence: of, resolved: false }
    : {
        slot,
        kind: 'WINNER_OF_CONTEST',
        contestId: K(of),
        contestSequence: of,
        resolved: true,
        participantId: P(resolved),
        display: { kind: 'TEAM', teamName: TEAMS[resolved - 1] },
      };
const contest = (id: string, n: number, status: string, slots: unknown[]) => ({
  contestId: id,
  sequence: n,
  contestType: 'MATCH',
  status,
  round: { sequence: 1, label: 'x', roundType: 'ELIMINATION' },
  scheduledStart: null,
  scheduledEnd: null,
  locationLabel: null,
  courtLabel: null,
  slots,
});
const stage = (key: string, label: string) => ({
  key,
  label,
  primitive: 'KNOCKOUT',
  partitionKind: null,
});

/**
 * Men Open: QF1 finished without a result, QF2 in play, QF3 official, QF4 entered, QF5 two different
 * scores entered, QF6 voided before any result. Semi-final 7 (stage s2, scored under a match
 * tie-break override) is in play, semi-final 8 still waits for its sides, the final is scheduled.
 */
const menBracket = (o: Partial<Record<number, string>> = {}) => ({
  rounds: [
    {
      sequence: 1,
      label: 'Quarter-finals',
      roundType: 'ELIMINATION',
      stage: stage('s1', 'Main draw'),
      contests: [
        contest(K(1), 1, o[1] ?? 'COMPLETED', [team(1, 1), team(2, 2)]),
        contest(K(2), 2, o[2] ?? 'IN_PROGRESS', [team(3, 1), team(4, 2)]),
        contest(K(3), 3, 'COMPLETED', [team(5, 1), team(6, 2)]),
        contest(K(4), 4, 'COMPLETED', [team(7, 1), team(8, 2)]),
        contest(K(5), 5, 'COMPLETED', [team(1, 1), team(3, 2)]),
        contest(K(6), 6, 'VOID', [team(2, 1), team(4, 2)]),
      ],
    },
    {
      sequence: 2,
      label: 'Semi-finals',
      roundType: 'ELIMINATION',
      stage: stage('s2', 'Finals'),
      contests: [
        contest(K(7), 7, 'IN_PROGRESS', [winnerOf(1, 3, 5), winnerOf(2, 4, 7)]),
        contest(K(8), 8, 'IN_PROGRESS', [winnerOf(1, 1), winnerOf(2, 2)]),
      ],
    },
    {
      sequence: 3,
      label: 'Final',
      roundType: 'ELIMINATION',
      stage: stage('s2', 'Finals'),
      contests: [contest(K(9), 9, 'SCHEDULED', [winnerOf(1, 7), winnerOf(2, 8)])],
    },
  ],
});
const hoopsBracket = () => ({
  rounds: [
    {
      sequence: 1,
      label: 'Final',
      roundType: 'ELIMINATION',
      contests: [contest(B1, 1, 'COMPLETED', [side(1, H(1), 'Hoopers'), side(2, H(2), 'Dunkers')])],
    },
  ],
});
const runBracket = () => ({
  rounds: [
    {
      sequence: 1,
      label: 'Race',
      roundType: 'FIELD',
      contests: [
        { ...contest('cccccccc-cccc-4ccc-8ccc-0000000000c1', 1, 'COMPLETED', []), entryCount: 40 },
      ],
    },
  ],
});
const field = () =>
  TEAMS.map((name, i) => ({
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
const view = (id: string, code: string, t: typeof PADEL) => ({
  versionId: id,
  code,
  name: t.name,
  version: 1,
  family: t.spec.family,
  specHash: HASH(9),
  spec: t.spec,
  basis: t.basis,
});
const scoring = (ruleset: unknown, overrides: Record<string, unknown> = {}) => ({
  eventId: 'x',
  pinned: true,
  frozen: true,
  ruleset,
  classificationTemplate: null,
  advancementPolicy: null,
  schedulingProfile: null,
  stageOverrides: overrides,
});

// ───────────────────────────── fake platform ─────────────────────────────

interface Call {
  method: string;
  path: string;
  body: unknown;
  key: string | null;
}
let calls: Call[] = [];
let routes: Record<string, (c: Call) => Response> = {};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const err = (status: number, code: string) => json(status, { error: { code } });

let results: Record<string, unknown[] | null> = {};
function platform(
  o: { detail?: ReturnType<typeof managed> | null; men?: ReturnType<typeof menBracket> } = {},
) {
  const m = o.detail === undefined ? managed() : o.detail;
  results = {
    [K(1)]: [],
    [K(2)]: [],
    [K(3)]: [version(1, 'OFFICIAL', QF3)],
    [K(4)]: [version(1, 'SUBMITTED', QF4)],
    [K(5)]: [version(2, 'SUBMITTED', QF5, { hash: HASH(5) }), version(1, 'SUBMITTED', QF5)],
    [K(6)]: [],
    [K(7)]: [],
    [K(8)]: [],
    [B1]: [],
  };
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
    'GET /v1/competitions/club-open/events/men-open/bracket': () =>
      json(200, o.men ?? menBracket()),
    'GET /v1/competitions/club-open/events/hoops/bracket': () => json(200, hoopsBracket()),
    'GET /v1/competitions/club-open/events/fun-run/bracket': () => json(200, runBracket()),
    [`GET /v1/events/${MEN}/field`]: () => json(200, { items: field() }),
    [`GET /v1/events/${HOOPS}/field`]: () => json(200, { items: [] }),
    [`GET /v1/events/${RUN}/field`]: () => json(200, { items: [] }),
    [`GET /v1/events/${MEN}/scoring`]: () =>
      json(200, scoring(view(RS_PADEL, PADEL.code, PADEL), { s2: { rulesetVersionId: RS_MTB } })),
    [`GET /v1/events/${HOOPS}/scoring`]: () =>
      json(200, scoring(view(RS_HOOPS, BASKET.code, BASKET))),
    [`GET /v1/events/${RUN}/scoring`]: () =>
      json(200, scoring({ ...view(RS_HOOPS, 'road', BASKET), family: 'ELAPSED_TIME' })),
    'GET /v1/catalog': () =>
      json(200, {
        rulesetVersions: [view(RS_MTB, MTB.code, MTB)],
        disciplineVersions: [],
        formatVersions: [],
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
  h.pending = false;
  calls = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const c: Call = {
      method: init.method ?? 'GET',
      path: u.pathname,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      key: headers['idempotency-key'] ?? null,
    };
    calls.push(c);
    const results_ = /^\/v1\/contests\/([0-9a-f-]{36})\/results$/.exec(c.path);
    if (c.method === 'GET' && results_ !== null && routes[`GET ${c.path}`] === undefined) {
      const v = results[results_[1] as string];
      return Promise.resolve(
        v === undefined
          ? json(404, {})
          : v === null
            ? json(503, {})
            : json(200, { contestId: results_[1], versions: v }),
      );
    }
    const r = routes[`${c.method} ${c.path}`];
    return Promise.resolve(r === undefined ? json(404, {}) : r(c));
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const pc = () => ({ params: Promise.resolve({ slug: 'club-uno', competitionId: COMP }) });
const sp = (q: Record<string, string> = {}) => ({ searchParams: Promise.resolve(q) });
const html = (el: ReactElement | null) => (el === null ? '' : renderToStaticMarkup(el));
const render = async (q: Record<string, string> = {}) => html(await Page({ ...pc(), ...sp(q) }));
async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (e) {
    const d = (e as { digest?: string }).digest ?? '';
    if (d.startsWith('NEXT_REDIRECT')) return d.split(';')[2] ?? '';
    if (d.includes('404')) return '404';
    throw e;
  }
}
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
};
const writes = () => calls.filter((c) => c.method !== 'GET');
const BASE = `/app/orgs/club-uno/tournaments/${COMP}`;
const BACK = `${BASE}/results`;
const base = { slug: 'club-uno', competitionId: COMP };
/** One match row: from its <li> to the next match row or the end of its section. */
const row = (out: string, id: string) => {
  const at = out.indexOf(`<li id="r-${id}"`);
  if (at < 0) return '';
  const rest = out.slice(at + 1);
  const end = Math.min(
    ...[rest.indexOf('<li id="r-'), rest.indexOf('</section>')].filter((x) => x >= 0),
  );
  return out.slice(at, at + 1 + end);
};
/** The section a match row is listed in (`res-needs`, `res-entered`, …). */
const sectionOf = (out: string, id: string) => {
  const at = out.indexOf(`<li id="r-${id}"`);
  const before = out.slice(0, at);
  return [...before.matchAll(/<section id="(res-[a-z-]+)"/g)].pop()?.[1] ?? null;
};
const buttons = (fragment: string) =>
  [...fragment.matchAll(/<span class="ops-when-closed">([^<]+)<\/span>/g)].map((m) => m[1]);
const idle = (key = 'oc-key-0000000001'): EntryState => ({
  kind: 'idle',
  values: {},
  nextKey: key,
  seq: 0,
});

// ───────────────────────────── parity with the domain ─────────────────────────────

describe('parity with the result domain', () => {
  it('offers exactly the ledger transitions the API implements after entry (T3, T5)', () => {
    for (const t of Object.values(TRANSITIONS))
      expect(IMPLEMENTED_TRANSITIONS.some((x) => x.from === t.from && x.to === t.to)).toBe(true);
    expect(TRANSITIONS.accept).toMatchObject({
      from: 'SUBMITTED',
      to: 'PROVISIONAL',
      path: 'accept',
    });
    expect(TRANSITIONS.official).toMatchObject({
      from: 'PROVISIONAL',
      to: 'OFFICIAL',
      path: 'declare-official',
    });
  });

  it('only offers result actions to the staff roles ADR-0077 makes eligible for result authority', () => {
    // Read from source: importing the persistence module would pull in its database stack.
    const src = readFileSync(
      new URL('../../../../packages/persistence/src/result-authority.ts', import.meta.url),
      'utf8',
    );
    const m = /RESULT_AUTHORITY_STAFF_ROLES = \[([^\]]*)\] as const/.exec(src);
    const roles = [...(m?.[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
    expect(roles.length).toBeGreaterThan(0);
    expect([...RESULT_STAFF_ROLES].sort()).toEqual(roles.sort());
  });

  it('enters only head-to-head families, all real ruleset families', () => {
    for (const f of ENTRY_FAMILIES) expect(RULESET_FAMILIES).toContain(f);
    expect([...ENTRY_FAMILIES].sort()).toEqual(
      ['MATCH_PLAY_HOLES', 'SETS_OF_GAMES', 'TIMED_OR_TARGET', 'TIMED_PERIODS'].sort(),
    );
  });
});

// ───────────────────────────── score sheets against the real executor ─────────────────────────────

describe('score sheets', () => {
  const A = P(1);
  const B = P(2);
  /** Form → sheet → the real executor → stored content → score line, and back into the form. */
  function roundTrip(code: string, fields: Record<string, string>) {
    const t = template(code);
    const family = t.spec.family as EntryFamily;
    const parsed = sheetFromForm(family, (n) => fields[n] ?? '');
    if (!('sheet' in parsed)) throw new Error(JSON.stringify(parsed.issues));
    const out = scoreContest(
      { ruleset: t.spec, mode: 'HEAD_TO_HEAD', participants: [A, B] },
      parsed.sheet as unknown as ScoreSheet,
    );
    if (!out.ok) throw new Error(JSON.stringify(out.issues));
    const content = out.content as unknown as ResultContent;
    const back = formValues(family, content, [A, B]);
    const again = sheetFromForm(family, (n) => back[n] ?? '');
    return {
      sheet: parsed.sheet,
      again: 'sheet' in again ? again.sheet : again,
      line: scoreLine(family, content, [A, B]),
      content,
    };
  }

  it('D-P4: the public line reads from the winner, keeps tie-breaks, and declines unknown families', () => {
    const t = roundTrip('sets-bo3-tiebreak', {
      set0a: '6',
      set0b: '7',
      tb0a: '5',
      tb0b: '7',
      set1a: '4',
      set1b: '6',
    });
    const scoring = { family: 'SETS_OF_GAMES', content: t.content };
    // B won: whichever order the sides come in, the line starts with B's games.
    expect(officialScore(scoring, [A, B])).toEqual({
      order: [B, A],
      line: { winner: 0, score: '7–6 (7–5) 6–4', how: null },
    });
    expect(officialScore(scoring, [B, A])?.order).toEqual([B, A]);
    expect(officialScore(undefined, [A, B])).toBeNull();
    expect(officialScore({ family: 'STROKES', content: t.content }, [A, B])).toBeNull();
    expect(officialScore(scoring, [A])).toBeNull();
  });

  it('sets of games: sets, tie-breaks, a match tie-break, retirement and walkover', () => {
    const tb = roundTrip('sets-bo3-tiebreak', {
      set0a: '7',
      set0b: '6',
      tb0a: '7',
      tb0b: '5',
      set1a: '6',
      set1b: '4',
    });
    expect(tb.sheet).toEqual({
      family: 'SETS_OF_GAMES',
      sets: [{ games: [7, 6], tiebreak: [7, 5] }, { games: [6, 4] }],
    });
    expect(tb.again).toEqual(tb.sheet);
    expect(tb.line).toEqual({ winner: 0, score: '7–6 (7–5) 6–4', how: null });

    const mtb = roundTrip('sets-2-plus-match-tiebreak-no-ad', {
      set0a: '6',
      set0b: '4',
      set1a: '3',
      set1b: '6',
      mtba: '8',
      mtbb: '10',
    });
    expect(mtb.again).toEqual(mtb.sheet);
    expect(mtb.line).toEqual({ winner: 1, score: '6–4 3–6 [8–10]', how: null });

    const ret = roundTrip('sets-bo3-tiebreak', {
      set0a: '6',
      set0b: '2',
      set1a: '2',
      set1b: '1',
      ending: 'RETIRED:1',
    });
    expect(ret.again).toEqual(ret.sheet);
    expect(ret.line).toEqual({ winner: 0, score: '6–2 2–1', how: 'Retired' });

    const wo = roundTrip('sets-bo3-tiebreak', { ending: 'WALKOVER:0' });
    expect(wo.sheet).toEqual({
      family: 'SETS_OF_GAMES',
      sets: [],
      termination: { kind: 'WALKOVER', side: 0 },
    });
    expect(wo.again).toEqual(wo.sheet);
    expect(wo.line).toEqual({ winner: 1, score: '—', how: 'Walkover' });
  });

  it('timed periods: periods, overtime, forfeit and default', () => {
    // 81–80 in regulation; with 25 in the third period it is level at 81 and goes to overtime.
    const p = {
      per0a: '20',
      per0b: '18',
      per1a: '22',
      per1b: '20',
      per2a: '19',
      per2b: '24',
      per3a: '20',
      per3b: '18',
    };
    const reg = roundTrip('basketball-4x10', p);
    expect(reg.again).toEqual(reg.sheet);
    expect(reg.line).toEqual({ winner: 0, score: '81–80', how: null });
    const ot = roundTrip('basketball-4x10', { ...p, per2b: '25', ot0a: '10', ot0b: '8' });
    expect(ot.again).toEqual(ot.sheet);
    expect(ot.line).toEqual({ winner: 0, score: '91–89', how: 'Overtime' });
    const ff = roundTrip('basketball-4x10', { ending: 'FORFEIT:1' });
    expect(ff.again).toEqual(ff.sheet);
    expect(ff.line).toEqual({ winner: 0, score: '—', how: 'Forfeit' });
    const df = roundTrip('basketball-4x10', { per0a: '10', per0b: '12', ending: 'DEFAULT:0' });
    expect(df.again).toEqual(df.sheet);
    expect(df.line).toMatchObject({ winner: 1, how: 'Default' });
  });

  it('time or target: target finish, timed finish with overtime, forfeit', () => {
    const target = roundTrip('3x3-10min-21', { rega: '21', regb: '15', endedBy: 'TARGET' });
    expect(target.again).toEqual(target.sheet);
    expect(target.line).toEqual({ winner: 0, score: '21–15', how: 'Target reached' });
    const ot = roundTrip('3x3-10min-21', {
      rega: '17',
      regb: '17',
      endedBy: 'TIME',
      tota: '1',
      totb: '2',
    });
    expect(ot.again).toEqual(ot.sheet);
    expect(ot.line).toEqual({ winner: 1, score: '18–19', how: 'Overtime' });
    const ff = roundTrip('3x3-10min-21', { ending: 'FORFEIT:0' });
    expect(ff.again).toEqual(ff.sheet);
  });

  it('match play: hole by hole, concession', () => {
    // Thirteen halved holes, then side A wins three in a row: 3 up with 2 to play (3 & 2).
    const holes = Object.fromEntries(
      [...Array<string>(13).fill('HALVED'), 'A', 'A', 'A'].map((v, i) => [`hole${i}`, v]),
    );
    const mp = roundTrip('golf-match-play-100', holes);
    expect(mp.again).toEqual(mp.sheet);
    expect(mp.line).toEqual({ winner: 0, score: '3 up · 16 holes', how: null });
    const c = roundTrip('golf-match-play-100', { hole0: 'A', ending: 'CONCEDED:1' });
    expect(c.again).toEqual(c.sheet);
    expect(c.line).toMatchObject({ winner: 0, how: 'Conceded' });
  });

  it('catches only the obvious locally: missing, malformed, half-filled and gaps', () => {
    const issues = (fields: Record<string, string>) => {
      const r = sheetFromForm('SETS_OF_GAMES', (n) => fields[n] ?? '');
      return 'issues' in r ? r.issues.map((i) => `${i.path}:${i.code}`) : [];
    };
    expect(issues({})).toEqual([':MISSING']);
    expect(issues({ set0a: '6', set0b: 'x' })).toEqual(['/sets/0:MALFORMED']);
    expect(issues({ set0a: '6' })).toEqual(['/sets/0:INCOMPLETE']);
    expect(issues({ set0a: '6', set0b: '1', set2a: '6', set2b: '2' })).toEqual(['/sets/1:GAP']);
    expect(issues({ ending: 'RETIRED:7' })).toEqual(['/termination:MALFORMED']);
    // An impossible score is the ruleset's question: it reaches the API untouched.
    expect(sheetFromForm('SETS_OF_GAMES', (n) => ({ set0a: '6', set0b: '5' })[n] ?? '')).toEqual({
      sheet: { family: 'SETS_OF_GAMES', sets: [{ games: [6, 5] }] },
    });
  });

  it('lays the sheet out from the pinned ruleset’s parameters', () => {
    expect(sheetLayout('SETS_OF_GAMES', PADEL.spec.parameters)).toMatchObject({
      sets: 3,
      tiebreaks: true,
      matchTiebreak: null,
    });
    expect(sheetLayout('SETS_OF_GAMES', MTB.spec.parameters)).toMatchObject({
      sets: 2,
      matchTiebreak: 10,
    });
    expect(sheetLayout('TIMED_PERIODS', BASKET.spec.parameters)).toMatchObject({
      periods: 4,
      overtimes: 3,
    });
    expect(
      sheetLayout('MATCH_PLAY_HOLES', template('golf-match-play-100').spec.parameters),
    ).toMatchObject({ holes: 18, extra: 6 });
  });
});

// ───────────────────────────── the workspace ─────────────────────────────

describe('results workspace', () => {
  it('says which tournament this is and where its results stand', async () => {
    platform();
    const out = await render();
    expect(out).toContain('<h2 class="tb-h">Results</h2>');
    expect(out).toContain('<span class="mono muted">Club Open</span>');
    expect(out).toContain(`<a href="${BACK}" data-key="results" aria-current="page">Results</a>`);
    expect(out).toMatch(/data-key="needs"[^>]*>.*?Needs result.*?<strong>5<\/strong>/);
    expect(out).toMatch(/data-key="entered"[^>]*>.*?<strong>2<\/strong>/);
    expect(out).toMatch(/data-key="official"[^>]*>.*?<strong>1<\/strong>/);
    expect(out).toContain('result authority');
  });

  it('lists what needs a result — finished first — with who played, and skips what isn’t played', async () => {
    platform();
    const out = await render();
    const needs = out.slice(out.indexOf('id="res-needs"'), out.indexOf('id="res-entered"'));
    const order = [...needs.matchAll(/<li id="r-([0-9a-f-]{36})"/g)].map((m) => m[1]);
    expect(order).toEqual([B1, K(1), K(2), K(7), K(8)]);
    expect(row(out, K(1))).toContain('Los Tigres');
    expect(row(out, K(1))).toContain('Bandeja Bros');
    expect(row(out, K(1))).toContain('Finished');
    expect(row(out, K(7))).toContain('Red Rackets');
    expect(row(out, K(7))).toContain('Pared Power');
    // Scheduled matches and a void match with no result aren't results work.
    expect(out).not.toContain(`id="r-${K(9)}"`);
    expect(out).not.toContain(`id="r-${K(6)}"`);
    expect(calls.some((c) => c.path === `/v1/contests/${K(9)}/results`)).toBe(false);
  });

  it('shows each result’s state and score as stored, side by side', async () => {
    platform();
    const out = await render();
    expect(sectionOf(out, K(3))).toBe('res-official-list');
    expect(row(out, K(3))).toContain('Red Rackets won · 6–3 6–4');
    expect(row(out, K(3))).toContain('<span data-won="true">Red Rackets</span>');
    expect(sectionOf(out, K(4))).toBe('res-entered');
    expect(row(out, K(4))).toContain('Pared Power won · 4–6 6–2 7–5');
    expect(row(out, K(4))).toContain('Entered — awaiting acceptance');
  });

  it('renders the score sheet each match’s ruleset takes, stage overrides included', async () => {
    platform();
    const out = await render();
    const qf = row(out, K(1));
    expect(qf).toContain('Best of 3 sets of 6 games');
    expect(qf).toContain('name="set2a"');
    expect(qf).toContain('name="tb0a"');
    expect(qf).not.toContain('name="mtba"');
    expect(qf).toContain('value="SETS_OF_GAMES"');
    expect(qf).toContain('aria-label="Set 1, Los Tigres"');
    // Semi-final stage s2 is scored under its override: two sets + a 10-point match tie-break.
    const sf = row(out, K(7));
    expect(sf).toContain('name="mtba"');
    expect(sf).not.toContain('name="set2a"');
    expect(sf).toContain('Match tie-break (to 10)');
    // Basketball: four periods and overtime rows.
    const hoops = row(out, B1);
    expect(hoops).toContain('name="per3a"');
    expect(hoops).toContain('name="ot0a"');
    expect(hoops).toContain('Forfeit — Dunkers didn’t play');
  });

  it('never invents entry it can’t do: unknown sides, unsupported families', async () => {
    platform();
    const out = await render();
    expect(row(out, K(8))).toContain('Both sides must be known before its result can be entered.');
    expect(buttons(row(out, K(8)))).toEqual([]);
    expect(out).toContain('Fun Run is scored by elapsed time');
    expect(out).toContain('isn’t available in this workspace yet');
  });

  it('offers accepting an entered score and flags two different scores for one match', async () => {
    platform();
    const out = await render();
    expect(buttons(row(out, K(4)))).toEqual(['Accept result']);
    expect(row(out, K(4))).toContain(`name="versionId" value="${V(1)}"`);
    expect(row(out, K(4))).toContain(
      'Entered</span><span aria-hidden="true">→</span><span class="sr-only"> becomes </span><span data-to="PROVISIONAL">Provisional',
    );
    expect(buttons(row(out, K(5)))).toEqual(['Accept result', 'Accept result']);
    expect(row(out, K(5))).toContain('2 different scores were entered');
    expect(out).toContain('has 2 different scores entered');
  });

  it('offers declaring official (with an acknowledgement) and correcting, prefilled with the recorded score', async () => {
    platform();
    results[K(4)] = [version(1, 'PROVISIONAL', QF4)];
    const out = await render();
    expect(sectionOf(out, K(4))).toBe('res-provisional');
    const r = row(out, K(4));
    expect(buttons(r)).toEqual(['Declare official', 'Correct result']);
    expect(r).toMatch(/<input type="checkbox"[^>]*name="confirm" value="yes"/);
    expect(r).toContain('name="mode" value="correct"');
    expect(r).toContain(`name="supersedes" value="${V(1)}"`);
    expect(r).toContain('name="set2a" value="7"');
    expect(r).toContain('name="set2b" value="5"');
    expect(r).toContain('Reason for the correction');
    // Official results can still be corrected, never declared again.
    expect(buttons(row(out, K(3)))).toEqual(['Correct result']);
  });

  it('a voided match keeps its record but offers nothing: its result no longer counts', async () => {
    platform();
    const QF6 = stored(PADEL.spec, [P(2), P(4)], sets([6, 3], [6, 4]));
    // An official result, and two different scores entered for another voided match.
    results[K(6)] = [version(6, 'OFFICIAL', QF6)];
    let out = await render();
    expect(out).toContain(`id="r-${K(6)}"`);
    expect(buttons(row(out, K(6)))).toEqual([]);
    expect(row(out, K(6))).toContain('data-void="true"');
    expect(row(out, K(6))).toContain('Match voided: its result doesn’t count');
    expect(row(out, K(6))).not.toContain('name="mode" value="correct"');

    results[K(6)] = [
      version(6, 'SUBMITTED', QF6),
      version(7, 'SUBMITTED', stored(PADEL.spec, [P(2), P(4)], sets([3, 6], [4, 6]))),
    ];
    out = await render();
    expect(buttons(row(out, K(6)))).toEqual([]);
    // Two scores on a voided match need no decision: only the live match with two (K5) is flagged.
    expect(out.match(/has 2 different scores entered/g)).toHaveLength(1);
    expect(row(out, K(5))).toContain('2 different scores were entered');
  });

  it('keeps the record: every version, replaced ones included', async () => {
    platform();
    results[K(3)] = [
      version(2, 'OFFICIAL', QF3, { supersedes: V(1) }),
      version(1, 'SUPERSEDED', QF3, { current: false, hash: HASH(7) }),
    ];
    const out = await render();
    const r = row(out, K(3));
    expect(r).toContain('Record · 2 versions');
    expect(r).toMatch(/v2<\/span><span class="rs-chip" data-version="OFFICIAL">Official · current/);
    expect(r).toMatch(/v1<\/span><span class="rs-chip" data-version="SUPERSEDED">Replaced/);
  });

  it('respects roles: schedulers follow results but are never offered result actions', async () => {
    platform({ detail: managed({ roles: ['SCHEDULER'], permissions: SCHEDULER }) });
    const out = await render();
    expect(out).toContain('You can follow results here. Owners and admins record them');
    expect(out).not.toContain('name="intent"');
    expect(out).not.toContain('Accept result');
    expect(out).not.toContain('Correct result');
    expect(row(out, K(3))).toContain('Red Rackets won · 6–3 6–4');
  });

  it('keeps loading, empty and failure states honest', async () => {
    platform({ detail: managed({ status: 'DRAFT', events: [] }) });
    expect(await render()).toContain('No results yet');
    platform({
      detail: managed({
        events: [event(MEN, 'men-open', 'Men Open', 'REGISTRATION_OPEN', 'padel')],
      }),
    });
    expect(await render()).toContain('No category is being played');
    platform({ detail: null });
    expect(await render()).toContain('This tournament can’t be loaded right now.');
    platform();
    results[K(1)] = null;
    const out = await render();
    expect(row(out, K(1))).toContain('This match’s result can’t be read right now.');
    expect(out).toContain('1 result can’t be read right now');
    platform();
    routes['GET /v1/competitions/club-open/events/men-open/bracket'] = () => json(503, {});
    expect(await render()).toContain('Some matches can’t be loaded right now: Men Open.');
  });

  it('renders a 404 for a tournament of another organization', async () => {
    platform({
      detail: {
        ...managed(),
        competition: { ...managed().competition, organizerOrganizationId: 'other' },
      },
    });
    expect(await outcome(() => render())).toBe('404');
  });
});

// ───────────────────────────── entering and correcting ─────────────────────────────

describe('entering a result', () => {
  const sheet = { set0a: '6', set0b: '1', set1a: '6', set1b: '2' };
  const enter = (fields: Record<string, string>, prev = idle()) =>
    outcome(() =>
      entryAction(
        prev,
        form({
          ...base,
          contestId: K(1),
          family: 'SETS_OF_GAMES',
          mode: 'enter',
          key: prev.nextKey,
          ...fields,
        }),
      ),
    ) as Promise<EntryState | string>;
  const valid = (content = stored(PADEL.spec, [P(1), P(2)], sets([6, 1], [6, 2]))) => ({
    ok: true,
    ruleset: { versionId: RS_PADEL },
    content,
    contentHash: HASH(3),
    result: {},
  });

  it('checks the score with the API first, and shows exactly what would be recorded', async () => {
    platform();
    routes[`POST /v1/contests/${K(1)}/score-sheets/validate`] = () => json(200, valid());
    const s = (await enter({ ...sheet, intent: 'check' })) as EntryState;
    expect(s.kind).toBe('review');
    expect(s.hash).toBe(HASH(3));
    expect(scoreLine('SETS_OF_GAMES', s.content, [P(1), P(2)])).toEqual({
      winner: 0,
      score: '6–1 6–2',
      how: null,
    });
    expect(s.values).toMatchObject(sheet);
    expect(writes()).toEqual([
      {
        method: 'POST',
        path: `/v1/contests/${K(1)}/score-sheets/validate`,
        body: { sheet: { family: 'SETS_OF_GAMES', sets: [{ games: [6, 1] }, { games: [6, 2] }] } },
        key: null,
      },
    ]);
  });

  it('records exactly the checked score, once, at platform recognition, then shows the refreshed workspace', async () => {
    platform();
    routes[`POST /v1/contests/${K(1)}/score-sheets/validate`] = () => json(200, valid());
    routes[`POST /v1/contests/${K(1)}/results`] = () =>
      json(200, { resultVersionId: V(1), status: 'SUBMITTED', contentHash: HASH(3) });
    expect(await enter({ ...sheet, intent: 'record', hash: HASH(3) })).toBe(
      `${BACK}?notice=result_entered`,
    );
    const post = writes().filter((c) => c.path.endsWith('/results'));
    expect(post).toEqual([
      {
        method: 'POST',
        path: `/v1/contests/${K(1)}/results`,
        body: {
          sheet: { family: 'SETS_OF_GAMES', sets: [{ games: [6, 1] }, { games: [6, 2] }] },
          recognitionLevel: 'PLATFORM',
        },
        key: 'oc-key-0000000001',
      },
    ]);
    // The redirect target re-reads everything: the match now waits to be accepted.
    platform();
    results[K(1)] = [version(1, 'SUBMITTED', valid().content)];
    const out = await render({ notice: 'result_entered' });
    expect(out).toContain(
      '<p class="flash ok" role="status">Result entered. It counts once it is accepted.</p>',
    );
    expect(sectionOf(out, K(1))).toBe('res-entered');
    expect(row(out, K(1))).toContain('Los Tigres won · 6–1 6–2');
  });

  it('a repeated submission reuses its key, so the API records it once', async () => {
    platform();
    routes[`POST /v1/contests/${K(1)}/score-sheets/validate`] = () => json(200, valid());
    routes[`POST /v1/contests/${K(1)}/results`] = () =>
      json(200, { resultVersionId: V(1), status: 'SUBMITTED' });
    await enter({ ...sheet, intent: 'record', hash: HASH(3) });
    await enter({ ...sheet, intent: 'record', hash: HASH(3) });
    const keys = writes()
      .filter((c) => c.path.endsWith('/results'))
      .map((c) => c.key);
    expect(keys).toEqual(['oc-key-0000000001', 'oc-key-0000000001']);
  });

  it('a score that changed after checking is checked again, never recorded unseen', async () => {
    platform();
    routes[`POST /v1/contests/${K(1)}/score-sheets/validate`] = () => json(200, valid());
    const s = (await enter({ ...sheet, intent: 'record', hash: HASH(8) })) as EntryState;
    expect(s).toMatchObject({ kind: 'review', error: 'result_review_changed', hash: HASH(3) });
    expect(writes().some((c) => c.path.endsWith('/results'))).toBe(false);
  });

  it('obvious mistakes are caught before any call; the rest is the API’s validation, in plain words', async () => {
    platform();
    const local = (await enter({ set0a: '6', set0b: '', intent: 'check' })) as EntryState;
    expect(local).toMatchObject({ kind: 'error', issues: ['Set 1: fill in both sides'] });
    expect(writes()).toEqual([]);
    routes[`POST /v1/contests/${K(1)}/score-sheets/validate`] = () =>
      json(200, {
        ok: false,
        issues: [
          { path: '/sets/1', code: 'SET_SCORE_INVALID', message: 'impossible set score 6–5' },
        ],
      });
    const api = (await enter({
      set0a: '6',
      set0b: '1',
      set1a: '6',
      set1b: '5',
      intent: 'check',
    })) as EntryState;
    expect(api).toMatchObject({ kind: 'error', issues: ['Set 2: impossible set score 6–5'] });
    expect(api.values).toMatchObject({ set1b: '5' });
    expect(writes().some((c) => c.path.endsWith('/results'))).toBe(false);
  });

  it('a result entered by someone else meanwhile stops the entry before anything is written', async () => {
    platform();
    results[K(1)] = [version(1, 'SUBMITTED', QF3)];
    const s = (await enter({ ...sheet, intent: 'record', hash: HASH(3) })) as EntryState;
    expect(s).toMatchObject({ kind: 'error', error: 'result_entered_meanwhile' });
    expect(writes()).toEqual([]);
  });

  it('turns refusals into organizer language, with a fresh key for the next try', async () => {
    platform();
    routes[`POST /v1/contests/${K(1)}/score-sheets/validate`] = () => json(200, valid());
    for (const [status, code, want] of [
      [403, 'AUTHORITY_DENIED', 'result_no_authority'],
      [403, 'FORBIDDEN', 'result_not_permitted'],
      [400, 'INVALID_INPUT', 'result_invalid'],
      [409, 'CURRENT_VERSION_CONFLICT', 'result_changed'],
      [409, 'INVALID_TRANSITION', 'result_blocked'],
      [404, 'NOT_FOUND', 'result_not_found'],
    ] as const) {
      routes[`POST /v1/contests/${K(1)}/results`] = () => err(status, code);
      const s = (await enter({ ...sheet, intent: 'record', hash: HASH(3) })) as EntryState;
      expect(s.error).toBe(want);
      expect(s.nextKey).not.toBe('oc-key-0000000001');
    }
    routes[`POST /v1/contests/${K(1)}/results`] = () => {
      throw new TypeError('fetch failed');
    };
    expect(((await enter({ ...sheet, intent: 'record', hash: HASH(3) })) as EntryState).error).toBe(
      'platform_unavailable',
    );
  });

  it('refuses what the workspace never offers, before calling the API', async () => {
    platform();
    expect(
      ((await enter({ ...sheet, family: 'ELAPSED_TIME', intent: 'check' })) as EntryState).error,
    ).toBe('result_unsupported');
    expect(
      ((await enter({ ...sheet, contestId: 'nope', intent: 'check' })) as EntryState).error,
    ).toBe('result_not_found');
    expect(writes()).toEqual([]);
  });
});

describe('correcting a result', () => {
  const fields = { set0a: '4', set0b: '6', set1a: '6', set1b: '2', set2a: '6', set2b: '4' };
  const correct = (more: Record<string, string>) =>
    outcome(() =>
      entryAction(
        idle(),
        form({
          ...base,
          contestId: K(3),
          family: 'SETS_OF_GAMES',
          mode: 'correct',
          supersedes: V(1),
          key: 'oc-key-0000000001',
          ...fields,
          ...more,
        }),
      ),
    ) as Promise<EntryState | string>;
  const check = (hash: string) => () =>
    json(200, {
      ok: true,
      content: stored(PADEL.spec, [P(5), P(6)], sets([4, 6], [6, 2], [6, 4])),
      contentHash: hash,
    });

  it('needs a reason, names the version it replaces and records an atomic correction', async () => {
    platform();
    expect(((await correct({ reason: ' ', intent: 'record' })) as EntryState).error).toBe(
      'result_reason_required',
    );
    routes[`POST /v1/contests/${K(3)}/score-sheets/validate`] = check(HASH(4));
    routes[`POST /v1/contests/${K(3)}/results/corrections`] = () =>
      json(200, { resultVersionId: V(2), supersededVersionId: V(1), status: 'PROVISIONAL' });
    expect(await correct({ reason: 'score entry error', intent: 'record', hash: HASH(4) })).toBe(
      `${BACK}?notice=result_corrected`,
    );
    expect(writes().filter((c) => c.path.endsWith('/corrections'))).toEqual([
      {
        method: 'POST',
        path: `/v1/contests/${K(3)}/results/corrections`,
        body: {
          sheet: {
            family: 'SETS_OF_GAMES',
            sets: [{ games: [4, 6] }, { games: [6, 2] }, { games: [6, 4] }],
          },
          supersedesVersionId: V(1),
          reason: 'score entry error',
          recognitionLevel: 'PLATFORM',
        },
        key: 'oc-key-0000000001',
      },
    ]);
  });

  it('refuses a correction that changes nothing, or one made against a result that changed meanwhile', async () => {
    platform();
    routes[`POST /v1/contests/${K(3)}/score-sheets/validate`] = check(HASH(1));
    expect(
      ((await correct({ reason: 'x', intent: 'record', hash: HASH(1) })) as EntryState).error,
    ).toBe('result_same_as_current');
    results[K(3)] = [
      version(2, 'PROVISIONAL', QF3, { supersedes: V(1) }),
      version(1, 'SUPERSEDED', QF3, { current: false }),
    ];
    expect(
      ((await correct({ reason: 'x', intent: 'record', hash: HASH(4) })) as EntryState).error,
    ).toBe('result_changed');
    expect(writes().some((c) => c.path.endsWith('/corrections'))).toBe(false);
  });
});

describe('accepting and declaring official', () => {
  const run = (fields: Record<string, string>) =>
    outcome(() =>
      transitionAction(
        form({ ...base, contestId: K(4), versionId: V(1), key: 'oc-key-0000000002', ...fields }),
      ),
    );

  it('sends each step once to its ledger route, at platform recognition', async () => {
    platform();
    routes[`POST /v1/result-versions/${V(1)}/accept`] = () =>
      json(200, { resultVersionId: V(1), status: 'PROVISIONAL' });
    expect(await run({ step: 'accept' })).toBe(`${BACK}?notice=result_accepted`);
    routes[`POST /v1/result-versions/${V(1)}/declare-official`] = () =>
      json(200, { resultVersionId: V(1), status: 'OFFICIAL' });
    expect(await run({ step: 'official', confirm: 'yes' })).toBe(`${BACK}?notice=result_official`);
    expect(writes()).toEqual([
      {
        method: 'POST',
        path: `/v1/result-versions/${V(1)}/accept`,
        body: { recognitionLevel: 'PLATFORM' },
        key: 'oc-key-0000000002',
      },
      {
        method: 'POST',
        path: `/v1/result-versions/${V(1)}/declare-official`,
        body: { recognitionLevel: 'PLATFORM' },
        key: 'oc-key-0000000002',
      },
    ]);
  });

  it('declaring official needs the acknowledgement; unknown steps never reach the API', async () => {
    platform();
    expect(await run({ step: 'official' })).toBe(`${BACK}?error=result_confirm_required`);
    expect(await run({ step: 'reject' })).toBe(`${BACK}?error=result_blocked`);
    expect(await run({ step: 'accept', versionId: 'x' })).toBe(`${BACK}?error=result_not_found`);
    expect(writes()).toEqual([]);
  });

  it('explains a refusal without retrying: already done, overtaken by another version, or not possible', async () => {
    platform();
    routes[`POST /v1/result-versions/${V(1)}/accept`] = () => err(409, 'INVALID_TRANSITION');
    results[K(4)] = [version(1, 'PROVISIONAL', QF4)];
    expect(await run({ step: 'accept' })).toBe(`${BACK}?error=result_already_done`);
    routes[`POST /v1/result-versions/${V(1)}/accept`] = () => err(409, 'CURRENT_VERSION_CONFLICT');
    results[K(4)] = [
      version(2, 'PROVISIONAL', QF4B),
      version(1, 'SUBMITTED', QF4, { current: false }),
    ];
    expect(await run({ step: 'accept' })).toBe(`${BACK}?error=result_changed`);
    routes[`POST /v1/result-versions/${V(1)}/accept`] = () => err(409, 'INVALID_TRANSITION');
    results[K(4)] = [version(1, 'SUBMITTED', QF4)];
    expect(await run({ step: 'accept' })).toBe(`${BACK}?error=result_blocked`);
    routes[`POST /v1/result-versions/${V(1)}/accept`] = () => err(403, 'AUTHORITY_DENIED');
    expect(await run({ step: 'accept' })).toBe(`${BACK}?error=result_no_authority`);
    expect(writes().filter((c) => c.path.endsWith('/accept'))).toHaveLength(4);
  });

  it('WP-P0-1: a match that is not in progress or finished is named as such, not re-read as "already done"', async () => {
    platform();
    routes[`POST /v1/result-versions/${V(1)}/accept`] = () =>
      json(409, { error: { code: 'INVALID_TRANSITION', reason: 'CONTEST_NOT_PLAYABLE' } });
    results[K(4)] = [version(1, 'PROVISIONAL', QF4)];
    expect(await run({ step: 'accept' })).toBe(`${BACK}?error=result_match_not_playable`);
    expect(ERROR_MESSAGES.result_match_not_playable).toContain('Nothing was changed');
  });

  it('words every result and refusal it can come back with', () => {
    const src = [
      readFileSync(
        new URL(
          '../app/orgs/[slug]/tournaments/[competitionId]/results/actions.ts',
          import.meta.url,
        ),
        'utf8',
      ),
      readFileSync(new URL('../_product/results-ui.tsx', import.meta.url), 'utf8'),
    ].join('\n');
    const codes = new Set([...src.matchAll(/'(result_[a-z_]+)'/g)].map((m) => m[1] as string));
    expect(codes.size).toBeGreaterThan(10);
    for (const c of codes)
      expect(Object.hasOwn(ERROR_MESSAGES, c) || Object.hasOwn(NOTICE_MESSAGES, c), c).toBe(true);
  });
});

// ───────────────────────────── navigation and layout ─────────────────────────────

describe('navigation and context', () => {
  it('reaches Results from the hub without losing the tournament', async () => {
    platform({
      detail: managed({ events: [event(MEN, 'men-open', 'Men Open', 'IN_PROGRESS', 'padel')] }),
    });
    routes[`GET /v1/competitions/${COMP}/staff`] = () => json(200, { items: [] });
    routes[`GET /v1/competitions/${COMP}/resources`] = () => json(200, { items: [] });
    routes[`GET /v1/competitions/${COMP}/availability`] = () => json(200, { items: [] });
    routes[`GET /v1/competitions/${COMP}/schedule/versions`] = () => json(200, { items: [] });
    routes['GET /v1/catalog'] = () => json(200, { disciplineVersions: [], formatVersions: [] });
    const out = html(await Hub({ ...pc(), ...sp() }));
    expect(out).toContain(`<a href="${BACK}" data-key="results">Results</a>`);
    expect(out).toMatch(
      /data-key="results"><a href="[^"]*\/results">.*?Enter and confirm match results/,
    );
    // The workspace's own nav keeps every tournament destination, Results current.
    platform();
    const page = await render();
    for (const k of [
      'overview',
      'registrations',
      'structure',
      'resources',
      'schedule',
      'operations',
      'staff',
    ])
      expect(page).toContain(`data-key="${k}"`);
    expect(page).toContain(`href="${BASE}/operations"`);
  });

  it('keeps score entry usable on phones (stacked rows, no fixed widths that overflow)', () => {
    const css = readFileSync(new URL('../_product/product.css', import.meta.url), 'utf8');
    const block = css.slice(css.indexOf('/* ── Results workspace (ONCF-L5)'));
    expect(block).toMatch(
      /@media \(max-width: 520px\) \{[^@]*\.rs-match \{[^}]*grid-template-columns: minmax\(0, 1fr\);/,
    );
    expect(block).toMatch(
      /@media \(max-width: 520px\) \{[^@]*\.rs-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) 3\.5rem 3\.5rem;/,
    );
    expect(block).not.toMatch(/min-width: \d{3,}px/);
    expect(block).not.toMatch(/\swidth: \d{3,}px/);
  });

  it('never scrolls the page sideways: the hero bleed is clipped, standings scroll in place', () => {
    const css = readFileSync(new URL('../_product/product.css', import.meta.url), 'utf8');
    // `clip`, not `hidden`: a scroll container would break the sticky top bar.
    expect(css).toMatch(/\n\.oc-app \{\s*overflow-x: clip;\s*\}/);
    expect(css).toMatch(/\.oc-app \.rs-standings \{\s*overflow-x: auto;\s*\}/);
  });
});
