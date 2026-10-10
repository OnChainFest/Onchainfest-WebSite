import {
  CANONICAL_CATALOG,
  RULESET_TEMPLATES,
  SCHEDULING_PROFILE_TEMPLATES,
  type DisciplineVersionSpec,
} from '@br/competition';
import { newId } from '@br/domain';
import { CatalogStore, CompetitionReader, IdentityStore } from '@br/persistence';
import { apiDb, newTestAccount, operatorDb, uniqueSlug } from '@br/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevTokenAuth, mintDevToken } from './auth';
import { buildServer } from './server';

// ONCF-05E-C API: schedule versions. Drafts are private; reads need COMP_VIEW_PRIVATE; changes,
// validation and publication need COMP_MANAGE_SCHEDULE (OWNER, ADMIN, SCHEDULER). Publication is
// one explicit human command against the current report hash. The legacy schedule route edits the
// draft and never publishes. No conflict-engine, proposal or optimization route exists (05E-D/E).

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form navigation of JSON responses
type Json = Record<string, any>;

const SECRET = 'oncf05e-c-api-int-secret-0123456789abcdef';
const db = apiDb();
const operator = operatorDb();
const app = buildServer({
  db,
  operatorDb: operator,
  auth: (identity: IdentityStore) => createDevTokenAuth(identity, { secret: SECRET }),
});
afterAll(async () => {
  await app.close();
  await Promise.all([db.destroy(), operator.destroy()]);
});

const idem = (key = `k-${newId()}`) => ({ 'idempotency-key': key });
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
  return { h, personId: p.body?.personId as string };
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
  const slug = uniqueSlug('fest');
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
  const tennisProfile = SCHEDULING_PROFILE_TEMPLATES.find((t) => t.code === 'tennis-court-match');
  const report = await new CatalogStore(operator).provision({
    operatorAccountId: op,
    manifest: {
      sports: [
        {
          code: `y${tag}`,
          name: '05E-C API sport',
          disciplines: [{ code: `y${tag}.tennis`, name: 'Tennis', specs: [tennisV2] }],
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
      schedulingProfiles: [
        {
          code: `s${tag}-tennis`,
          name: 'tennis',
          versions: [{ spec: tennisProfile?.spec as never, basis: tennisProfile?.basis as never }],
        },
      ],
    },
  });
  expect(report.conflicts).toEqual([]);
  const listed = await new CompetitionReader(db).catalog();
  for (const d of listed.disciplineVersions)
    if (d.discipline.code === `y${tag}.tennis`) v['tennis'] = d.disciplineVersionId;
  for (const f of listed.formatVersions)
    if (f.format.code === `se-${tag}`) v['se'] = f.formatVersionId;
  for (const r of listed.rulesetVersions)
    if (r.code === `q${tag}-sets-bo3-tiebreak`) v['rs'] = r.versionId;
  for (const p of listed.schedulingProfileVersions)
    if (p.code === `s${tag}-tennis`) v['sp'] = p.versionId;
}, 240_000);

describe('ONCF-05E-C schedule versions over the API', () => {
  it('draft → assignments → validate → human publication → public projection; every refusal', async () => {
    const A = await organizer('o5ec-a');
    const B = await organizer('o5ec-b');
    const stranger = await person('o5ec-stranger');
    const scheduler = await person('o5ec-scheduler');
    const manager = await person('o5ec-regman');
    for (const [p, role] of [
      [scheduler, 'SCHEDULER'],
      [manager, 'REGISTRATION_MANAGER'],
    ] as const)
      expect(
        (
          await call(
            'POST',
            `/v1/competitions/${A.competitionId}/staff`,
            { ...A.h, ...idem() },
            { personId: p.personId, role },
          )
        ).status,
      ).toBe(201);

    const ev = await call(
      'POST',
      `/v1/competitions/${A.competitionId}/events`,
      { ...A.h, ...idem() },
      {
        slug: 'singles',
        disciplineVersionId: v['tennis'],
        formatVersionId: v['se'],
        formatConfig: { drawSize: 4 },
        settings: { name: 'Singles', category: { genderCategory: 'OPEN' } },
      },
    );
    expect(ev.status, ev.text).toBe(201);
    const eventId = ev.body?.eventId as string;
    expect(
      (
        await call(
          'PUT',
          `/v1/events/${eventId}/scoring`,
          { ...A.h, ...idem() },
          { rulesetVersionId: v['rs'], schedulingProfileVersionId: v['sp'] },
        )
      ).status,
    ).toBe(200);
    expect((await call('POST', `/v1/events/${eventId}/open-registration`, A.h)).status).toBe(200);
    for (let i = 0; i < 4; i++) {
      const a = await athlete(`o5ec-p${i}`);
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
    const bracket = await call('GET', `/v1/competitions/${A.slug}/events/singles/bracket`);
    const contests = (bracket.body?.rounds as Json[]).flatMap((r) => r.contests as Json[]);
    const first = contests[0] as Json;
    expect(contests).toHaveLength(3);

    // Resources: the declared occupancy mode, next to the legacy capacity label.
    const court = await call(
      'POST',
      `/v1/competitions/${A.competitionId}/resources`,
      { ...A.h, ...idem() },
      { typeCode: 'TENNIS_COURT', label: 'Court 1' },
    );
    expect(court.status, court.text).toBe(201);
    const courtId = court.body?.resourceId as string;
    expect((await call('GET', `/v1/resources/${courtId}`, A.h)).body).toMatchObject({
      occupancyMode: 'EXCLUSIVE',
      occupancy: 'EXCLUSIVE',
    });
    const hall = await call(
      'POST',
      `/v1/competitions/${A.competitionId}/resources`,
      { ...A.h, ...idem() },
      { typeCode: 'TENNIS_COURT', label: 'Hall', occupancyMode: 'SHARED' },
    );
    expect((await call('GET', `/v1/resources/${hall.body?.resourceId}`, A.h)).body).toMatchObject({
      occupancyMode: 'SHARED',
    });
    expect(
      (
        await call(
          'POST',
          `/v1/competitions/${A.competitionId}/resources`,
          { ...A.h, ...idem() },
          { typeCode: 'TENNIS_COURT', label: 'Bad', occupancyMode: 'SOMETIMES' },
        )
      ).status,
    ).toBe(400);

    // Drafts: COMP_MANAGE_SCHEDULE only; an idempotent retry returns the same draft.
    const base = `/v1/competitions/${A.competitionId}/schedule`;
    for (const h of [stranger.h, B.h, manager.h])
      expect((await call('POST', `${base}/drafts`, { ...h, ...idem() })).status).toBe(403);
    const key = idem();
    const draft = await call('POST', `${base}/drafts`, { ...A.h, ...key });
    expect(draft.status, draft.text).toBe(201);
    const retry = await call('POST', `${base}/drafts`, { ...A.h, ...key });
    expect(retry.status).toBe(200);
    expect(retry.body?.versionId).toBe(draft.body?.versionId);
    const versionId = draft.body?.versionId as string;
    const put = (contestId: string, payload: Json, h = A.h) =>
      call(
        'PUT',
        `/v1/schedule-versions/${versionId}/assignments/${contestId}`,
        { ...h, ...idem() },
        payload,
      );
    expect((await put(first.contestId, { startsAt: '2027-06-01T15:00:00Z' })).status).toBe(400);
    expect(
      (
        await put(
          first.contestId,
          { resourceId: courtId, startsAt: '2027-06-01T15:00:00Z' },
          stranger.h,
        )
      ).status,
    ).toBe(403);
    for (const [i, c] of contests.entries())
      expect(
        (
          await put(
            c.contestId,
            { resourceId: courtId, startsAt: `2027-06-0${i + 1}T15:00:00Z` },
            scheduler.h,
          )
        ).status,
      ).toBe(200);
    // Draft reads are private; the public schedule shows nothing yet.
    expect((await call('GET', `/v1/schedule-versions/${versionId}`, stranger.h)).status).toBe(403);
    const read = await call('GET', `/v1/schedule-versions/${versionId}`, manager.h);
    expect(read.status).toBe(200);
    expect(read.body?.assignments).toHaveLength(3);
    const publicBefore = await call('GET', `/v1/competitions/${A.slug}/events/singles/schedule`);
    expect((publicBefore.body?.items as Json[]).every((x) => x.scheduledStart === null)).toBe(true);

    // Validation and publication.
    const report = await call('POST', `/v1/schedule-versions/${versionId}/validate`, scheduler.h);
    expect(report.status, report.text).toBe(200);
    expect(report.body?.report.coverage).toEqual([
      'INCOMPLETE_ASSIGNMENT',
      'OUTSIDE_EVENT_WINDOW',
      'RESOURCE_TYPE_MISMATCH',
    ]);
    const publish = (h: Record<string, string>, reportHash: string) =>
      call(
        'POST',
        `/v1/schedule-versions/${versionId}/publish`,
        { ...h, ...idem() },
        { baseVersionId: null, reportHash, acknowledgedConflictKeys: [] },
      );
    expect((await publish(manager.h, report.body?.reportHash)).status).toBe(403);
    expect((await publish(scheduler.h, `sha256:${'0'.repeat(64)}`)).status).toBe(409);
    const published = await publish(scheduler.h, report.body?.reportHash);
    expect(published.status, published.text).toBe(200);
    expect(published.body).toMatchObject({ versionId, scheduledContests: 3 });
    const publicAfter = await call('GET', `/v1/competitions/${A.slug}/events/singles/schedule`);
    expect(
      (publicAfter.body?.items as Json[]).filter((x) => x.scheduledStart !== null),
    ).toHaveLength(3);

    // The legacy route now edits a new draft (auto-opened) and never publishes; moves need a reason.
    const legacy = (payload: Json) =>
      call('POST', `/v1/contests/${first.contestId}/schedule`, { ...A.h, ...idem() }, payload);
    expect(
      (await legacy({ scheduledStart: '2027-06-01T18:00:00Z', resourceId: courtId })).status,
    ).toBe(400);
    const moved = await legacy({
      scheduledStart: '2027-06-01T18:00:00Z',
      resourceId: courtId,
      reason: 'rain',
    });
    expect(moved.status, moved.text).toBe(200);
    expect(moved.body).toMatchObject({ status: 'SCHEDULED' });
    expect(moved.body?.versionId).not.toBe(versionId);
    const stillPublic = await call('GET', `/v1/competitions/${A.slug}/events/singles/schedule`);
    expect(
      (stillPublic.body?.items as Json[]).find((x) => x.contestId === first.contestId)
        ?.scheduledStart,
    ).toBe('2027-06-01T15:00:00.000Z');
    const versions = await call('GET', `${base}/versions`, A.h);
    expect((versions.body?.items as Json[]).map((x) => [x.versionNumber, x.status])).toEqual([
      [2, 'DRAFT'],
      [1, 'PUBLISHED'],
    ]);
    const discarded = await call(
      'POST',
      `/v1/schedule-versions/${moved.body?.versionId}/discard`,
      { ...A.h, ...idem() },
      { reason: 'not needed' },
    );
    expect(discarded.status, discarded.text).toBe(200);
  }, 600_000);

  it('the route inventory: schedule versions only — no conflict-engine, proposal or optimization route', () => {
    const routes = app.v1Routes
      .filter((r) => /schedule-versions|schedule\/(versions|drafts)/.test(r.url))
      .map((r) => `${r.method} ${r.url}`)
      .sort();
    expect(routes).toEqual(
      [
        'GET /v1/competitions/:competitionId/schedule/versions',
        'POST /v1/competitions/:competitionId/schedule/drafts',
        'GET /v1/schedule-versions/:versionId',
        'PUT /v1/schedule-versions/:versionId/assignments/:contestId',
        'POST /v1/schedule-versions/:versionId/assignments/:contestId/remove',
        'POST /v1/schedule-versions/:versionId/assignments/:contestId/lock',
        'POST /v1/schedule-versions/:versionId/assignments/:contestId/unlock',
        'POST /v1/schedule-versions/:versionId/validate',
        'POST /v1/schedule-versions/:versionId/publish',
        'POST /v1/schedule-versions/:versionId/discard',
      ].sort(),
    );
    expect(
      app.v1Routes.filter((r) =>
        /conflict|schedul\w*-proposal|optimi|generate-schedule|auto-publish/i.test(r.url),
      ),
    ).toEqual([]);
  });
});
