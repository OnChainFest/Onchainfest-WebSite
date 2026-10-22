import {
  CANONICAL_CATALOG,
  RULESET_TEMPLATES,
  SCHEDULING_PROFILE_TEMPLATES,
  type DisciplineVersionSpec,
} from '@br/competition';
import { newId, type Uuid } from '@br/domain';
import {
  AuthorityStore,
  CatalogStore,
  CompetitionReader,
  IdentityStore,
  ResourceStore,
  ScheduleStore,
} from '@br/persistence';
import {
  apiDb,
  declaredNoParticipation,
  newTestAccount,
  operatorDb,
  ownerDb,
  uniqueSlug,
} from '@br/testkit';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevTokenAuth, mintDevToken } from './auth';
import { buildServer } from './server';

// ONCF WP-P0-2 API (D-15, D-18): a malformed score sheet, or a termination naming a side that does
// not exist, answers a coded 400 (validate: 200 { ok: false }) — never a 500 — on validate, submit
// and correct, and stores nothing; valid walkovers in both directions still become official and
// decide the podium; the D-14 lifecycle gate and the authorization order are unchanged.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form navigation of JSON responses
type Json = Record<string, any>;

const SECRET = 'oncf-p0-2-api-int-secret-0123456789abcdef';
const db = apiDb();
const operator = operatorDb();
const owner = ownerDb();
const app = buildServer({
  db,
  operatorDb: operator,
  resultConflictChecker: declaredNoParticipation,
  auth: (identity: IdentityStore) => createDevTokenAuth(identity, { secret: SECRET }),
});
const authority = new AuthorityStore(db, { conflictChecker: declaredNoParticipation });
const resources = new ResourceStore(db);
const schedule = new ScheduleStore(db);
afterAll(async () => {
  await app.close();
  await Promise.all([db.destroy(), operator.destroy(), owner.destroy()]);
});

const k = () => `k-${newId()}`;
const idem = () => ({ 'idempotency-key': k() });
const auth = (subject: string) => ({
  authorization: `Bearer ${mintDevToken(subject, { secret: SECRET })}`,
});
async function call(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  headers: Record<string, string> = {},
  payload?: unknown,
) {
  const res = await app.inject({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return {
    status: res.statusCode,
    body: res.body.length > 0 ? (res.json() as Json) : null,
    text: res.body,
  };
}
async function person(label: string) {
  const h = auth(`${label}-${newId()}`);
  const p = await call('POST', '/v1/persons', { ...h, ...idem() }, { relation: 'SELF' });
  expect(p.status).toBe(201);
  const me = await call('GET', '/v1/me', h);
  return { h, personId: p.body?.personId as string, accountId: me.body?.accountId as string };
}
async function athlete(label: string) {
  const u = await person(label);
  const a = await call(
    'POST',
    '/v1/athletes',
    { ...u.h, ...idem() },
    {
      personId: u.personId,
      slug: uniqueSlug(label),
      profile: { displayName: `Athlete ${label}`, profileVisibility: 'PUBLIC' },
    },
  );
  expect(a.status, a.text).toBe(201);
  return { ...u, athleteId: a.body?.athleteId as string };
}
async function organizer(label: string) {
  const o = await person(label);
  const org = await call(
    'POST',
    '/v1/organizations',
    { ...o.h, ...idem() },
    { orgType: 'CLUB', slug: uniqueSlug(label), profile: { displayName: `${label} club` } },
  );
  const slug = uniqueSlug('p02fest');
  const c = await call(
    'POST',
    '/v1/competitions',
    { ...o.h, ...idem() },
    {
      organizerOrganizationId: org.body?.organizationId,
      slug,
      profile: { name: `${label} fest`, timezone: 'America/Costa_Rica' },
    },
  );
  const competitionId = c.body?.competitionId as string;
  expect((await call('POST', `/v1/competitions/${competitionId}/publish`, o.h)).status).toBe(200);
  expect((await call('POST', `/v1/competitions/${competitionId}/activate`, o.h)).status).toBe(200);
  return { ...o, competitionId, slug };
}

const tag = newId().replace(/-/g, '').slice(-8);
const v: Record<string, string> = {};

beforeAll(async () => {
  const identity = new IdentityStore(db);
  const op = (await newTestAccount(identity, { withPerson: false, label: 'operator' })).accountId;
  const tennisV2 = CANONICAL_CATALOG.sports
    .flatMap((s) => s.disciplines)
    .find((d) => d.code === 'tennis.singles')?.specs[1] as DisciplineVersionSpec;
  const report = await new CatalogStore(operator).provision({
    operatorAccountId: op,
    manifest: {
      sports: [
        {
          code: `x${tag}`,
          name: 'P0-2 API sport',
          disciplines: [{ code: `x${tag}.tennis`, name: 'Tennis', specs: [tennisV2] }],
        },
      ],
      formats: [
        {
          code: `se-${tag}`,
          name: 'SE',
          versions: [{ engineId: 'single-elimination', engineVersion: 2 }],
        },
      ],
      rulesets: RULESET_TEMPLATES.filter((t) => t.code === 'sets-bo3-tiebreak').map((t) => ({
        code: `q${tag}-${t.code}`,
        name: t.name,
        versions: [{ spec: t.spec, basis: t.basis }],
      })),
      schedulingProfiles: SCHEDULING_PROFILE_TEMPLATES.filter(
        (t) => t.code === 'tennis-court-match',
      ).map((t) => ({
        code: `s${tag}-${t.code}`,
        name: t.name,
        versions: [{ spec: t.spec, basis: t.basis }],
      })),
    },
  });
  expect(report.conflicts).toEqual([]);
  const listed = await new CompetitionReader(db).catalog();
  for (const d of listed.disciplineVersions)
    if (d.discipline.code === `x${tag}.tennis`) v['tennis'] = d.disciplineVersionId;
  for (const f of listed.formatVersions)
    if (f.format.code === `se-${tag}`) v['se'] = f.formatVersionId;
  for (const r of listed.rulesetVersions)
    if (r.code === `q${tag}-sets-bo3-tiebreak`) v['rs'] = r.versionId;
  for (const p of listed.schedulingProfileVersions)
    if (p.code.startsWith(`s${tag}-`)) v['sp'] = p.versionId;
}, 240_000);

type Org = Awaited<ReturnType<typeof organizer>>;

/** A started two-player knockout (one final, PLANNED) over the API. */
async function category(A: Org, eventSlug: string) {
  const ev = await call(
    'POST',
    `/v1/competitions/${A.competitionId}/events`,
    { ...A.h, ...idem() },
    {
      slug: eventSlug,
      disciplineVersionId: v['tennis'],
      formatVersionId: v['se'],
      formatConfig: {},
      settings: { name: `Singles ${eventSlug}`, category: { genderCategory: 'OPEN' } },
    },
  );
  expect(ev.status, ev.text).toBe(201);
  const eventId = ev.body?.eventId as string;
  const pinned = await call(
    'PUT',
    `/v1/events/${eventId}/scoring`,
    { ...A.h, ...idem() },
    { rulesetVersionId: v['rs'], schedulingProfileVersionId: v['sp'] },
  );
  expect(pinned.status, pinned.text).toBe(200);
  expect((await call('POST', `/v1/events/${eventId}/open-registration`, A.h)).status).toBe(200);
  for (let i = 0; i < 2; i++) {
    const a = await athlete(`p02-${eventSlug}-p${i}`);
    expect(
      (
        await call(
          'POST',
          `/v1/events/${eventId}/registrations`,
          { ...a.h, ...idem() },
          { athleteId: a.athleteId, eligibilityDeclared: true },
        )
      ).status,
    ).toBe(201);
  }
  expect((await call('POST', `/v1/events/${eventId}/close-registration`, A.h)).status).toBe(200);
  for (const [path, payload] of [
    ['lock-field', undefined],
    ['seed', { method: 'DETERMINISTIC_DRAW' }],
    ['generate-plan', undefined],
  ] as const)
    expect(
      (await call('POST', `/v1/events/${eventId}/${path}`, { ...A.h, ...idem() }, payload)).status,
    ).toBe(200);
  expect((await call('POST', `/v1/events/${eventId}/start`, A.h)).status).toBe(200);
  const bracket = await call('GET', `/v1/competitions/${A.slug}/events/${eventSlug}/bracket`);
  return { eventId, contestId: bracket.body?.rounds[0]?.contests[0]?.contestId as string };
}

/** Published on a court: PLANNED → SCHEDULED. */
async function scheduleOnCourt(A: Org, contestId: string) {
  const { resourceId } = await resources.createResource({
    actorAccountId: A.accountId,
    competitionId: A.competitionId,
    typeCode: 'TENNIS_COURT',
    resource: { label: `Court ${newId().slice(-6)}` },
    idempotencyKey: k(),
  });
  for (const weekday of [1, 2, 3, 4, 5, 6, 7])
    await resources.addAvailability({
      actorAccountId: A.accountId,
      competitionId: A.competitionId,
      resourceId,
      fact: { kind: 'WEEKLY', weekday, start: '00:00', end: '24:00' },
      idempotencyKey: k(),
    });
  const { versionId } = await schedule.openDraft({
    actorAccountId: A.accountId,
    competitionId: A.competitionId,
    idempotencyKey: k(),
  });
  await schedule.setAssignment({
    actorAccountId: A.accountId,
    versionId,
    contestId,
    assignment: {
      resourceId,
      startsAt: `2027-0${1 + (Number(`0x${newId().slice(-2)}`) % 9)}-11T10:00:00Z`,
    },
    expectedLastFactId: null,
    idempotencyKey: k(),
  });
  const r = await schedule.validate({ actorAccountId: A.accountId, versionId });
  expect(r.conflicts.filter((c) => c.severity === 'HARD')).toEqual([]);
  const base = (
    await sql<{ id: string }>`
      SELECT version_id AS id FROM competition.v_schedule_version_current
      WHERE competition_id = ${A.competitionId} AND status = 'PUBLISHED'`.execute(owner)
  ).rows[0]?.id;
  await schedule.publish({
    actorAccountId: A.accountId,
    versionId,
    baseVersionId: base ?? null,
    reportHash: r.reportHash,
    acknowledgedConflictKeys: r.conflicts
      .filter((c) => c.severity === 'SOFT')
      .map((c) => c.conflictKey),
    idempotencyKey: k(),
  });
}

/** The organizer's own PERSON principal holds the four result capabilities (fixture anchor). */
async function grant(A: Org) {
  const principal = await call('POST', `/v1/persons/${A.personId}/principal`, A.h);
  expect(principal.status, principal.text).toBe(200);
  const platform = await authority.registerPrincipal({
    principalType: 'PLATFORM',
    label: 'platform (P0-2 api)',
  });
  await authority.recognizeTrustAnchor({
    principalId: platform.id,
    recognitionScope: { recognitionLevel: ['PLATFORM'] },
    basisRef: 'fixture',
    governanceDecisionRef: `fx-${newId()}`,
  });
  await authority.issueGrant({
    actorPrincipalId: platform.id,
    grantorPrincipalId: platform.id,
    granteePrincipalId: principal.body?.principalId as Uuid,
    capabilities: ['SUBMIT_RESULT', 'ACCEPT_RESULT', 'DECLARE_OFFICIAL', 'CORRECT_RESULT'],
    scope: { recognitionLevel: ['PLATFORM'], competition: [A.competitionId as Uuid] },
    delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
  });
  // Authority is evaluated as of the database clock, measured stepping back by up to ~1.5 s
  // locally: wait until it is safely past the recording before the first use.
  const id = principal.body?.principalId as string;
  for (;;) {
    const { rows } = await sql<{ ok: boolean }>`
      SELECT now() > greatest(p.recorded_at, max(g.recorded_at), max(g.effective_from)) + interval '2 seconds' AS ok
      FROM authority.principal p LEFT JOIN authority.authority_grant g ON g.grantee_principal_id = p.id
      WHERE p.id = ${id} GROUP BY p.recorded_at`.execute(owner);
    if (rows[0]?.ok === true) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

const sheet = { family: 'SETS_OF_GAMES', sets: [{ games: [6, 1] }, { games: [6, 2] }] };
const walkover = (side: unknown) => ({
  family: 'SETS_OF_GAMES',
  sets: [],
  termination: { kind: 'WALKOVER', side },
});

/** Malformed or impossible sheets and the issue each must report (path, code). */
const INVALID: [string, Json, { path: string; code: string }][] = [
  ['walkover side 2', walkover(2), { path: '/termination/side', code: 'SIDE_INVALID' }],
  ['walkover side -1', walkover(-1), { path: '/termination/side', code: 'SIDE_INVALID' }],
  ['walkover side 0.5', walkover(0.5), { path: '/termination/side', code: 'SIDE_INVALID' }],
  ['walkover side "1"', walkover('1'), { path: '/termination/side', code: 'SIDE_INVALID' }],
  ['walkover side null', walkover(null), { path: '/termination/side', code: 'SIDE_INVALID' }],
  [
    'walkover without a side',
    { family: 'SETS_OF_GAMES', sets: [], termination: { kind: 'WALKOVER' } },
    { path: '/termination/side', code: 'SIDE_INVALID' },
  ],
  [
    'retirement side 2',
    {
      ...sheet,
      sets: [{ games: [6, 2] }, { games: [3, 1] }],
      termination: { kind: 'RETIRED', side: 2 },
    },
    { path: '/termination/side', code: 'SIDE_INVALID' },
  ],
  [
    'termination null',
    { ...sheet, termination: null },
    { path: '/termination', code: 'TERMINATION_INVALID' },
  ],
  [
    'sets as an object (QA-03 setsNotArray)',
    { family: 'SETS_OF_GAMES', sets: { 0: { games: [6, 1] }, 1: { games: [6, 2] } } },
    { path: '/sets', code: 'SHEET_MALFORMED' },
  ],
  [
    'sets as a string',
    { family: 'SETS_OF_GAMES', sets: '6-1 6-2' },
    { path: '/sets', code: 'SHEET_MALFORMED' },
  ],
  ['sets missing', { family: 'SETS_OF_GAMES' }, { path: '/sets', code: 'SHEET_MALFORMED' }],
  [
    'a set without games',
    { family: 'SETS_OF_GAMES', sets: [{}, { games: [6, 2] }] },
    { path: '/sets/0', code: 'SET_SCORE_INVALID' },
  ],
  [
    'string games',
    { family: 'SETS_OF_GAMES', sets: [{ games: ['6', '1'] }, { games: [6, 2] }] },
    { path: '/sets/0', code: 'SET_SCORE_INVALID' },
  ],
  [
    'negative games',
    { family: 'SETS_OF_GAMES', sets: [{ games: [6, -1] }, { games: [6, 2] }] },
    { path: '/sets/0', code: 'SET_SCORE_INVALID' },
  ],
];

describe('WP-P0-2 API · score sheets are validated before anything is stored (D-15, D-18)', () => {
  it('malformed or impossible sheets are coded 4xx on validate, submit and correct; nothing is stored; valid walkovers decide the podium', async () => {
    const A = await organizer('p02');
    await grant(A);
    const versions = async (contestId: string) =>
      ((await call('GET', `/v1/contests/${contestId}/results`, A.h)).body?.versions ??
        []) as Json[];
    const validate = (contestId: string, s: unknown) =>
      call('POST', `/v1/contests/${contestId}/score-sheets/validate`, A.h, { sheet: s });
    const submit = (contestId: string, s: unknown, headers = idem()) =>
      call(
        'POST',
        `/v1/contests/${contestId}/results`,
        { ...A.h, ...headers },
        { sheet: s, recognitionLevel: 'PLATFORM' },
      );
    const refused = (
      r: Awaited<ReturnType<typeof call>>,
      issue: { path: string; code: string },
      name: string,
    ) => {
      expect(r.status, `${name}: ${r.text}`).toBe(400);
      expect(r.body?.error?.code, name).toBe('INVALID_INPUT');
      expect(r.body?.error?.issues, name).toContainEqual(issue);
      expect(r.text, name).not.toMatch(/TypeError|stack|INTERNAL|sql/i);
    };

    const aSlug = uniqueSlug('wa');
    const a = await category(A, aSlug);
    await scheduleOnCourt(A, a.contestId);
    expect((await call('POST', `/v1/contests/${a.contestId}/start`, A.h)).status).toBe(200);

    // validate answers { ok: false, issues } (200, never 500); submit refuses with the same issues.
    for (const [name, s, issue] of INVALID) {
      const v = await validate(a.contestId, s);
      expect(v.status, `${name}: ${v.text}`).toBe(200);
      expect(v.body?.ok, name).toBe(false);
      expect(
        (v.body?.issues as Json[]).map((i) => ({ path: i.path, code: i.code })),
        name,
      ).toContainEqual(issue);
      refused(await submit(a.contestId, s), issue, name);
    }
    // A malformed retry under one Idempotency-Key is refused the same way every time.
    const retry = idem();
    for (let i = 0; i < 2; i++)
      refused(
        await submit(a.contestId, INVALID[0]?.[1], retry),
        { path: '/termination/side', code: 'SIDE_INVALID' },
        `retry ${i}`,
      );
    expect(await versions(a.contestId)).toHaveLength(0);

    // Both walkover directions name the other side the winner.
    const winnerOf = (content: Json) =>
      (content.entries as Json[]).find((e) => e.outcome === 'WALKOVER_WIN')
        ?.participantId as string;
    const v0 = await validate(a.contestId, walkover(0));
    const v1 = await validate(a.contestId, walkover(1));
    expect([v0.body?.ok, v1.body?.ok]).toEqual([true, true]);
    const [w0, w1] = [winnerOf(v0.body?.content), winnerOf(v1.body?.content)];
    expect(w0).toBeDefined();
    expect(w1).toBeDefined();
    expect(w0).not.toBe(w1);
    for (const v of [v0, v1])
      expect((v.body?.content.entries as Json[]).map((e) => e.outcome).sort()).toEqual([
        'WALKOVER_LOSS',
        'WALKOVER_WIN',
      ]);

    // A valid walkover (side 1 withdrew) becomes official; corrections are validated the same way.
    const sub = await submit(a.contestId, walkover(1));
    expect(sub.status, sub.text).toBe(200);
    const rv = sub.body?.resultVersionId as string;
    for (const step of ['accept', 'declare-official'])
      expect(
        (
          await call(
            'POST',
            `/v1/result-versions/${rv}/${step}`,
            { ...A.h, ...idem() },
            { recognitionLevel: 'PLATFORM' },
          )
        ).status,
      ).toBe(200);
    for (const [name, s, issue] of INVALID)
      refused(
        await call(
          'POST',
          `/v1/contests/${a.contestId}/results/corrections`,
          { ...A.h, ...idem() },
          {
            sheet: s,
            supersedesVersionId: rv,
            reason: 'scorer error',
            recognitionLevel: 'PLATFORM',
          },
        ),
        issue,
        `correct: ${name}`,
      );
    const stored = await versions(a.contestId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ status: 'OFFICIAL', current: true });
    expect(winnerOf(stored[0]?.content)).toBe(w1);

    // The official walkover decides the event: completion and a podium naming the real winner.
    expect((await call('POST', `/v1/contests/${a.contestId}/complete`, A.h)).status).toBe(200);
    const staff = await call('GET', `/v1/events/${a.eventId}/outcome`, A.h);
    expect(staff.status, staff.text).toBe(200);
    expect(staff.body?.readiness.ready).toBe(true);
    const done = await call('POST', `/v1/events/${a.eventId}/complete`, A.h);
    expect(done.status, done.text).toBe(200);
    const pub = await call('GET', `/v1/competitions/${A.slug}/events/${aSlug}/outcome`);
    expect(pub.status, pub.text).toBe(200);
    expect(pub.body?.podium).toMatchObject({
      status: 'AVAILABLE',
      placements: [{ participantId: w1, position: 1 }, { position: 2 }],
    });

    // The other direction (side 0 withdrew) on a second final.
    const b = await category(A, uniqueSlug('wb'));
    await scheduleOnCourt(A, b.contestId);
    expect((await call('POST', `/v1/contests/${b.contestId}/start`, A.h)).status).toBe(200);
    const subB = await submit(b.contestId, walkover(0));
    expect(subB.status, subB.text).toBe(200);
    const winnerB = winnerOf((await versions(b.contestId))[0]?.content as Json);
    const vB = await validate(b.contestId, walkover(1));
    expect(winnerOf(vB.body?.content)).not.toBe(winnerB);
  }, 600_000);

  it('the D-14 lifecycle gate and the authorization order are unchanged', async () => {
    const A = await organizer('p02gate');
    await grant(A);
    const unplayed = await category(A, uniqueSlug('wu'));
    await scheduleOnCourt(A, unplayed.contestId);
    const submit = (h: Record<string, string>, s: unknown) =>
      call(
        'POST',
        `/v1/contests/${unplayed.contestId}/results`,
        { ...h, ...idem() },
        { sheet: s, recognitionLevel: 'PLATFORM' },
      );
    // A valid walkover on a SCHEDULED match is still a lifecycle refusal (D-14).
    const valid = await submit(A.h, walkover(0));
    expect(valid.status, valid.text).toBe(409);
    expect(valid.body?.error).toMatchObject({
      code: 'INVALID_TRANSITION',
      reason: 'CONTEST_NOT_PLAYABLE',
    });
    // A malformed sheet is refused as a sheet first (as before): it never reaches the ledger.
    const malformed = await submit(A.h, { family: 'SETS_OF_GAMES', sets: {} });
    expect(malformed.status, malformed.text).toBe(400);
    // Outside the staff, nothing about the sheet or the match is disclosed (as before).
    expect((await submit({}, walkover(2))).status).toBe(401);
    const outsider = await person('p02out');
    const out = await submit(outsider.h, walkover(2));
    expect([403, 404]).toContain(out.status);
    expect(out.text).not.toMatch(/SIDE_INVALID|termination|SHEET_MALFORMED/);
    const outValidate = await call(
      'POST',
      `/v1/contests/${unplayed.contestId}/score-sheets/validate`,
      outsider.h,
      { sheet: { family: 'SETS_OF_GAMES', sets: {} } },
    );
    expect([403, 404]).toContain(outValidate.status);
    expect(
      ((await call('GET', `/v1/contests/${unplayed.contestId}/results`, A.h)).body?.versions ?? [])
        .length,
    ).toBe(0);
  }, 600_000);
});
