import {
  CANONICAL_CATALOG,
  RULESET_TEMPLATES,
  SCHEDULING_PROFILE_TEMPLATES,
  type DisciplineVersionSpec,
} from '@br/competition';
import { newId } from '@br/domain';
import {
  CatalogStore,
  CompetitionReader,
  IdentityStore,
  ResourceStore,
  ResultAuthorityGovernance,
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

// ONCF-L6 API (ADR-0078): the public category / competition outcome (anonymous GETs, DRAFT 404,
// OFFICIAL results only, no version ids or provenance, podium only once completed), the staff
// outcome with completion readiness, the completion and freeze refusals with their allowlisted
// reasons (409), and the route inventory.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form navigation of JSON responses
type Json = Record<string, any>;

const SECRET = 'oncf-l6-api-int-secret-0123456789abcdef';
const db = apiDb();
const operator = operatorDb();
const owner = ownerDb();
const app = buildServer({
  db,
  operatorDb: operator,
  resultConflictChecker: declaredNoParticipation,
  auth: (identity: IdentityStore) => createDevTokenAuth(identity, { secret: SECRET }),
});
const governance = new ResultAuthorityGovernance(db);
let platformPrincipalId: string | undefined;
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
async function organizer(label: string, opts: { activate?: boolean } = {}) {
  const o = await person(label);
  const org = await call(
    'POST',
    '/v1/organizations',
    { ...o.h, ...idem() },
    { orgType: 'CLUB', slug: uniqueSlug(label), profile: { displayName: `${label} club` } },
  );
  const slug = uniqueSlug('l6fest');
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
  if (opts.activate !== false) {
    expect((await call('POST', `/v1/competitions/${competitionId}/publish`, o.h)).status).toBe(200);
    expect((await call('POST', `/v1/competitions/${competitionId}/activate`, o.h)).status).toBe(
      200,
    );
  }
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
          code: `w${tag}`,
          name: 'L6 API sport',
          disciplines: [{ code: `w${tag}.tennis`, name: 'Tennis', specs: [tennisV2] }],
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
    if (d.discipline.code === `w${tag}.tennis`) v['tennis'] = d.disciplineVersionId;
  for (const f of listed.formatVersions)
    if (f.format.code === `se-${tag}`) v['se'] = f.formatVersionId;
  for (const r of listed.rulesetVersions)
    if (r.code === `q${tag}-sets-bo3-tiebreak`) v['rs'] = r.versionId;
  for (const p of listed.schedulingProfileVersions)
    if (p.code.startsWith(`s${tag}-`)) v['sp'] = p.versionId;
}, 240_000);

type Org = Awaited<ReturnType<typeof organizer>>;

/** A started two-player knockout (one final) over the API; returns the final and its players. */
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
    const a = await athlete(`l6-${eventSlug}-p${i}`);
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
  expect(
    (await call('POST', `/v1/events/${eventId}/lock-field`, { ...A.h, ...idem() })).status,
  ).toBe(200);
  expect(
    (
      await call(
        'POST',
        `/v1/events/${eventId}/seed`,
        { ...A.h, ...idem() },
        { method: 'DETERMINISTIC_DRAW' },
      )
    ).status,
  ).toBe(200);
  expect(
    (await call('POST', `/v1/events/${eventId}/generate-plan`, { ...A.h, ...idem() })).status,
  ).toBe(200);
  expect((await call('POST', `/v1/events/${eventId}/start`, A.h)).status).toBe(200);
  const bracket = await call('GET', `/v1/competitions/${A.slug}/events/${eventSlug}/bracket`);
  const final = bracket.body?.rounds[0]?.contests[0] as Json;
  return {
    eventId,
    contestId: final.contestId as string,
    players: final.slots.map((s: Json) => s.participantId as string) as [string, string],
  };
}

/** Published on a court (PLANNED → SCHEDULED), then started and finished over the API. */
async function play(A: Org, contestId: string) {
  const { resourceId } = await resources.createResource({
    actorAccountId: A.accountId,
    competitionId: A.competitionId,
    typeCode: 'TENNIS_COURT',
    resource: { label: `Court ${newId().slice(0, 4)}` },
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
    assignment: { resourceId, startsAt: '2027-07-01T10:00:00Z' },
    expectedLastFactId: null,
    idempotencyKey: k(),
  });
  const r = await schedule.validate({ actorAccountId: A.accountId, versionId });
  expect(r.conflicts.filter((c) => c.severity === 'HARD')).toEqual([]);
  await schedule.publish({
    actorAccountId: A.accountId,
    versionId,
    baseVersionId: null,
    reportHash: r.reportHash,
    acknowledgedConflictKeys: r.conflicts
      .filter((c) => c.severity === 'SOFT')
      .map((c) => c.conflictKey),
    idempotencyKey: k(),
  });
  expect((await call('POST', `/v1/contests/${contestId}/start`, A.h)).status).toBe(200);
  expect((await call('POST', `/v1/contests/${contestId}/complete`, A.h)).status).toBe(200);
}

/**
 * The ADR-0077 operator act: the organizer's own PERSON principal receives the four result
 * capabilities, bound to its current OWNER eligibility (ADR-0079 §2.3).
 */
async function grant(A: Org) {
  platformPrincipalId ??= (
    await governance.bootstrapPlatformAnchor({
      governanceDecisionRef: `gov:l6-api:anchor:${newId()}`,
      basisRef: 'basis:l6-api:charter',
    })
  ).platformPrincipalId;
  const g = await governance.grantCompetitionResultAuthority({
    platformPrincipalId,
    competitionId: A.competitionId,
    granteeAccountId: A.accountId,
    governanceDecisionRef: `gov:l6-api:${newId()}`,
  });
  // Authority is evaluated as of the transaction time (the database clock), which the local
  // Docker clock has been measured stepping back by up to ~1.5 s: wait until it is safely past
  // the grant's recording before the first use (no assertion is relaxed).
  for (;;) {
    const { rows } = await sql<{ ok: boolean }>`
      SELECT now() > greatest(recorded_at, effective_from) + interval '2 seconds' AS ok
      FROM authority.authority_grant WHERE id = ${g.grantId}`.execute(owner);
    if (rows[0]?.ok === true) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

const sheet = { family: 'SETS_OF_GAMES', sets: [{ games: [6, 1] }, { games: [6, 2] }] };
/** Nothing internal to the result ledger may appear in a public payload. */
const LEAKS = /resultVersionId|provenance|contentHash|PROVISIONAL|SUBMITTED|"hold"/;

describe('ONCF-L6 over the API', () => {
  it('official-only public outcome, staff readiness, completion and freeze refusals', async () => {
    const A = await organizer('l6-a');
    const { eventId, contestId, players } = await category(A, 'singles');
    const pub = `/v1/competitions/${A.slug}/events/singles/outcome`;

    // Live, nothing official: the public outcome lists the match without any outcome.
    let o = await call('GET', pub);
    expect(o.status, o.text).toBe(200);
    expect(o.body).toMatchObject({
      schema: 'br:public-event-outcome@1',
      final: false,
      authority: 'ORGANIZER_DECLARED',
      kind: 'KNOCKOUT',
      podium: { status: 'NOT_AVAILABLE', reason: 'EVENT_NOT_COMPLETED' },
    });
    expect(o.body?.matches).toHaveLength(1);
    expect(o.body?.matches[0]).toMatchObject({ contestId, official: false });

    // Completion is refused while the final is open (reason allowlisted, 409).
    let done = await call('POST', `/v1/events/${eventId}/complete`, A.h);
    expect(done.status, done.text).toBe(409);
    expect(done.body?.error).toMatchObject({ code: 'INVALID_TRANSITION', reason: 'CONTESTS_OPEN' });

    await play(A, contestId);
    await grant(A);
    const sub = await call(
      'POST',
      `/v1/contests/${contestId}/results`,
      { ...A.h, ...idem() },
      { sheet, recognitionLevel: 'PLATFORM' },
    );
    expect(sub.status, sub.text).toBe(200);
    const rv = sub.body?.resultVersionId as string;
    expect(
      (
        await call(
          'POST',
          `/v1/result-versions/${rv}/accept`,
          { ...A.h, ...idem() },
          { recognitionLevel: 'PLATFORM' },
        )
      ).status,
    ).toBe(200);

    // PROVISIONAL: never public, not even its existence; staff readiness names the match.
    o = await call('GET', pub);
    expect(o.body?.matches[0]).toMatchObject({ official: false });
    expect(o.body?.matches[0].entrants.every((e: Json) => e.outcome === null)).toBe(true);
    expect(o.text).not.toMatch(LEAKS);
    expect(o.text).not.toContain(rv);
    const staff = await call('GET', `/v1/events/${eventId}/outcome`, A.h);
    expect(staff.status, staff.text).toBe(200);
    expect(staff.body?.readiness).toMatchObject({
      ready: false,
      contestsOpen: [],
      resultsNotOfficial: [contestId],
      required: 1,
      official: 0,
    });
    done = await call('POST', `/v1/events/${eventId}/complete`, A.h);
    expect(done.status).toBe(409);
    expect(done.body?.error?.reason).toBe('RESULTS_NOT_OFFICIAL');

    // OFFICIAL: the match outcome is public; the podium is still withheld until completion.
    expect(
      (
        await call(
          'POST',
          `/v1/result-versions/${rv}/declare-official`,
          { ...A.h, ...idem() },
          { recognitionLevel: 'PLATFORM' },
        )
      ).status,
    ).toBe(200);
    o = await call('GET', pub);
    expect(o.body?.matches[0]).toMatchObject({ official: true });
    const won = o.body?.matches[0].entrants.find((e: Json) => e.outcome === 'WIN');
    expect(won?.participantId).toBe(players[0]);
    expect(o.body?.podium).toEqual({ status: 'NOT_AVAILABLE', reason: 'EVENT_NOT_COMPLETED' });
    expect(o.text).not.toMatch(LEAKS);
    expect((await call('GET', `/v1/events/${eventId}/outcome`, A.h)).body?.readiness.ready).toBe(
      true,
    );

    // Completed: the podium is public and the results are frozen.
    done = await call('POST', `/v1/events/${eventId}/complete`, A.h);
    expect(done.status, done.text).toBe(200);
    o = await call('GET', pub);
    expect(o.body).toMatchObject({
      final: true,
      podium: {
        status: 'AVAILABLE',
        placements: [
          { participantId: players[0], position: 1, tied: false },
          { participantId: players[1], position: 2, tied: false },
        ],
      },
    });
    expect(o.body?.podium.placements[0].display).toMatchObject({ kind: 'ATHLETE' });
    expect(o.text).not.toMatch(LEAKS);
    const comp = await call('GET', `/v1/competitions/${A.slug}/outcome`);
    expect(comp.status, comp.text).toBe(200);
    expect(comp.body).toMatchObject({
      schema: 'br:public-competition-outcome@1',
      authority: 'ORGANIZER_DECLARED',
    });
    expect(comp.body?.events).toMatchObject([
      { id: eventId, final: true, champions: [{ participantId: players[0], position: 1 }] },
    ]);
    expect(comp.text).not.toMatch(LEAKS);

    const correction = await call(
      'POST',
      `/v1/contests/${contestId}/results/corrections`,
      { ...A.h, ...idem() },
      {
        sheet: { family: 'SETS_OF_GAMES', sets: [{ games: [1, 6] }, { games: [2, 6] }] },
        supersedesVersionId: rv,
        reason: 'scorer error',
        recognitionLevel: 'PLATFORM',
      },
    );
    expect(correction.status, correction.text).toBe(409);
    expect(correction.body?.error).toMatchObject({
      code: 'INVALID_TRANSITION',
      reason: 'RESULTS_FROZEN',
    });
    const voided = await call('POST', `/v1/contests/${contestId}/void`, A.h, { reason: 'appeal' });
    expect(voided.status).toBe(409);
    expect(voided.body?.error?.reason).toBe('EVENT_FINISHED');

    // The tournament completes (one completed category).
    const completeComp = await call('POST', `/v1/competitions/${A.competitionId}/complete`, A.h);
    expect(completeComp.status, completeComp.text).toBe(200);
  }, 600_000);

  it('competition completion reasons, DRAFT 404, anonymous reads and staff-only readiness', async () => {
    const B = await organizer('l6-b');
    const only = await category(B, 'only');
    // An open category: EVENTS_OPEN.
    let done = await call('POST', `/v1/competitions/${B.competitionId}/complete`, B.h);
    expect(done.status).toBe(409);
    expect(done.body?.error).toMatchObject({ code: 'INVALID_TRANSITION', reason: 'EVENTS_OPEN' });
    // Only cancelled categories: NO_COMPLETED_EVENT.
    expect(
      (
        await call('POST', `/v1/events/${only.eventId}/cancel`, B.h, {
          reason: 'rain',
        })
      ).status,
    ).toBe(200);
    done = await call('POST', `/v1/competitions/${B.competitionId}/complete`, B.h);
    expect(done.status).toBe(409);
    expect(done.body?.error?.reason).toBe('NO_COMPLETED_EVENT');
    // A cancelled category's public outcome: no podium, no outcome.
    const cancelled = await call('GET', `/v1/competitions/${B.slug}/events/only/outcome`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body?.podium).toEqual({ status: 'NOT_AVAILABLE', reason: 'EVENT_CANCELLED' });

    // DRAFT competitions are invisible on both outcome routes.
    const D = await organizer('l6-draft', { activate: false });
    expect((await call('GET', `/v1/competitions/${D.slug}/outcome`)).status).toBe(404);
    expect((await call('GET', `/v1/competitions/${D.slug}/events/x/outcome`)).status).toBe(404);
    expect((await call('GET', `/v1/competitions/no-such-${tag}/outcome`)).status).toBe(404);

    // Staff outcome: 401 without credentials, 403 for a stranger.
    expect((await call('GET', `/v1/events/${only.eventId}/outcome`)).status).toBe(401);
    const stranger = await person('l6-stranger');
    expect((await call('GET', `/v1/events/${only.eventId}/outcome`, stranger.h)).status).toBe(403);
  }, 600_000);

  it('the outcome routes are GET-only, public reads PUBLIC and the staff read COMP_STAFF', () => {
    const routes = app.v1Routes.filter((r) => /\/outcome$/.test(r.url));
    expect(routes.map((r) => `${r.method} ${r.url} ${r.classification}`).sort()).toEqual(
      [
        'GET /v1/competitions/:slug/events/:eventSlug/outcome PUBLIC',
        'GET /v1/competitions/:slug/outcome PUBLIC',
        'GET /v1/events/:eventId/outcome COMP_STAFF',
      ].sort(),
    );
    // The existing public DTO routes are unchanged: the bracket still states no results.
    expect(
      app.v1Routes.some((r) => r.url === '/v1/competitions/:slug/events/:eventSlug/bracket'),
    ).toBe(true);
  });
});
