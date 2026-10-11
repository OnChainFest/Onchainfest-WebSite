import {
  CANONICAL_CATALOG,
  RULESET_TEMPLATES,
  SCHEDULING_PROFILE_TEMPLATES,
  schedulingProfileSpecHash,
  type DisciplineVersionSpec,
} from '@br/competition';
import { newId } from '@br/domain';
import { CatalogStore, CompetitionReader, IdentityStore } from '@br/persistence';
import { apiDb, newTestAccount, operatorDb, uniqueSlug } from '@br/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevTokenAuth, mintDevToken } from './auth';
import { buildServer } from './server';

// ONCF-05E-B API: published SchedulingProfile versions are listed and served publicly as catalog
// data; an event pins one by id through its scoring pin (COMP_EDIT, before field lock) and reads
// it back. Refusals: strangers, other organizers, schedulers, incompatible and unpublished
// versions, and any change after field lock. No schedule-generation surface exists.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form navigation of JSON responses
type Json = Record<string, any>;

const SECRET = 'oncf05e-b-api-int-secret-0123456789abcdef';
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

const idem = () => ({ 'idempotency-key': `k-${newId()}` });
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
async function organizer(label: string) {
  const o = await person(label);
  const org = await call(
    'POST',
    '/v1/organizations',
    { ...o.h, ...idem() },
    { orgType: 'CLUB', slug: uniqueSlug(label), profile: { displayName: `${label} club` } },
  );
  const c = await call(
    'POST',
    '/v1/competitions',
    { ...o.h, ...idem() },
    {
      organizerOrganizationId: org.body?.organizationId,
      slug: uniqueSlug('fest'),
      profile: { name: `${label} fest`, timezone: 'America/Costa_Rica' },
    },
  );
  const competitionId = c.body?.competitionId as string;
  expect((await call('POST', `/v1/competitions/${competitionId}/publish`, o.h)).status).toBe(200);
  expect((await call('POST', `/v1/competitions/${competitionId}/activate`, o.h)).status).toBe(200);
  return { ...o, competitionId };
}

const tag = newId().replace(/-/g, '').slice(-8);
const v: Record<string, string> = {};
let draftId = '';

beforeAll(async () => {
  const identity = new IdentityStore(db);
  const op = (await newTestAccount(identity, { withPerson: false, label: 'operator' })).accountId;
  const tennisV2 = CANONICAL_CATALOG.sports
    .flatMap((s) => s.disciplines)
    .find((d) => d.code === 'tennis.singles')?.specs[1] as DisciplineVersionSpec;
  const catalog = new CatalogStore(operator);
  const report = await catalog.provision({
    operatorAccountId: op,
    manifest: {
      sports: [
        {
          code: `y${tag}`,
          name: '05E-B API sport',
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
      schedulingProfiles: SCHEDULING_PROFILE_TEMPLATES.filter((t) =>
        ['tennis-court-match', 'padel-court-match'].includes(t.code),
      ).map((t) => ({
        code: `s${tag}-${t.code}`,
        name: t.name,
        versions: [{ spec: t.spec, basis: t.basis }],
      })),
    },
  });
  expect(report.conflicts).toEqual([]);
  const { id: parentId } = await catalog.createScoringParent({
    operatorAccountId: op,
    kind: 'scheduling-profile',
    code: `s${tag}-draft`,
    name: 'Draft',
    idempotencyKey: `k-${newId()}`,
  });
  draftId = (
    await catalog.createScoringVersion({
      operatorAccountId: op,
      kind: 'scheduling-profile',
      parentId,
      spec: SCHEDULING_PROFILE_TEMPLATES[0]!.spec,
      basis: { kind: 'COMMON_PRACTICE', note: 'draft' },
      idempotencyKey: `k-${newId()}`,
    })
  ).id;
  const listed = await new CompetitionReader(db).catalog();
  for (const d of listed.disciplineVersions)
    if (d.discipline.code === `y${tag}.tennis`) v['tennis'] = d.disciplineVersionId;
  for (const f of listed.formatVersions)
    if (f.format.code === `se-${tag}`) v['se'] = f.formatVersionId;
  for (const r of listed.rulesetVersions)
    if (r.code === `q${tag}-sets-bo3-tiebreak`) v['rs'] = r.versionId;
  for (const p of listed.schedulingProfileVersions)
    if (p.code.startsWith(`s${tag}-`)) v[p.code.slice(`s${tag}-`.length)] = p.versionId;
}, 240_000);

describe('ONCF-05E-B over the API', () => {
  it('lists and serves PUBLISHED profiles only, with per-discipline compatibility', async () => {
    const cat = await call('GET', '/v1/catalog');
    expect(cat.status).toBe(200);
    const mine = (cat.body?.schedulingProfileVersions as Json[]).filter((p) =>
      String(p.code).startsWith(`s${tag}-`),
    );
    expect(mine.map((p) => p.code).sort()).toEqual([
      `s${tag}-padel-court-match`,
      `s${tag}-tennis-court-match`,
    ]);
    const tennis = (cat.body?.disciplineVersions as Json[]).find(
      (d) => d.disciplineVersionId === v['tennis'],
    );
    expect(tennis?.compatibleSchedulingProfileVersionIds).toContain(v['tennis-court-match']);
    expect(tennis?.compatibleSchedulingProfileVersionIds).not.toContain(v['padel-court-match']);

    const one = await call('GET', `/v1/catalog/scheduling-profiles/${v['tennis-court-match']}`);
    expect(one.status, one.text).toBe(200);
    expect(one.body).toMatchObject({
      versionId: v['tennis-court-match'],
      version: 1,
      specVersion: 1,
      specHash: schedulingProfileSpecHash(SCHEDULING_PROFILE_TEMPLATES[0]!.spec),
      spec: { specVersion: 1, requirements: [{ resourceType: 'TENNIS_COURT' }] },
      basis: { kind: 'COMMON_PRACTICE' },
    });
    expect((await call('GET', `/v1/catalog/scheduling-profiles/${draftId}`)).status).toBe(404);
    expect((await call('GET', `/v1/catalog/scheduling-profiles/${newId()}`)).status).toBe(404);
    expect((await call('GET', '/v1/catalog/scheduling-profiles/not-a-uuid')).status).toBe(400);
  });

  it('pins by reference under COMP_EDIT, refuses others and incompatibilities, and freezes at field lock', async () => {
    const A = await organizer('o5eb-a');
    const B = await organizer('o5eb-b');
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
    const put = (h: Record<string, string>, schedulingProfileVersionId: string | null) =>
      call(
        'PUT',
        `/v1/events/${eventId}/scoring`,
        { ...h, ...idem() },
        { rulesetVersionId: v['rs'], schedulingProfileVersionId },
      );

    // Draft event: the owner (COMP_EDIT) pins.
    const ok = await put(A.h, v['tennis-court-match'] as string);
    expect(ok.status, ok.text).toBe(200);
    const read = await call('GET', `/v1/events/${eventId}/scoring`, A.h);
    expect(read.body?.schedulingProfile).toMatchObject({
      versionId: v['tennis-court-match'],
      specVersion: 1,
      status: 'PUBLISHED',
    });

    // Refusals before lock.
    const mismatch = await put(A.h, v['padel-court-match'] as string);
    expect(mismatch.status).toBe(400);
    expect(mismatch.body?.error).toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('PADEL_COURT'),
    });
    expect((await put(A.h, draftId)).status).toBe(400);
    expect((await put(A.h, 'nope')).status).toBe(400);
    const scheduler = await person('o5eb-scheduler');
    expect(
      (
        await call(
          'POST',
          `/v1/competitions/${A.competitionId}/staff`,
          { ...A.h, ...idem() },
          { personId: scheduler.personId, role: 'SCHEDULER' },
        )
      ).status,
    ).toBe(201);
    expect((await put(scheduler.h, v['tennis-court-match'] as string)).status).toBe(403);
    const stranger = await person('o5eb-stranger');
    expect((await put(stranger.h, v['tennis-court-match'] as string)).status).toBe(403);
    expect((await put(B.h, v['tennis-court-match'] as string)).status).toBe(403);
    expect((await call('GET', `/v1/events/${eventId}/scoring`, B.h)).status).toBe(403);

    // Registration open: still editable; then the field locks and the pin is frozen.
    expect((await call('POST', `/v1/events/${eventId}/open-registration`, A.h)).status).toBe(200);
    expect((await put(A.h, v['tennis-court-match'] as string)).status).toBe(200);
    expect((await call('POST', `/v1/events/${eventId}/close-registration`, A.h)).status).toBe(200);
    expect(
      (await call('POST', `/v1/events/${eventId}/lock-field`, { ...A.h, ...idem() })).status,
    ).toBe(200);
    const frozen = await put(A.h, null);
    expect(frozen.status).toBe(409);
    expect(frozen.body?.error.code).toBe('INVALID_TRANSITION');
    const after = await call('GET', `/v1/events/${eventId}/scoring`, A.h);
    expect(after.body).toMatchObject({
      frozen: true,
      schedulingProfile: { versionId: v['tennis-court-match'] },
    });
  });

  it('the route inventory exposes catalog reads and the pin only — no schedule generation', () => {
    const routes = app.v1Routes
      .filter((r) => /schedul/i.test(r.url))
      .map((r) => `${r.method} ${r.url}`)
      .sort();
    // Pre-existing BRT-05 schedule routes, this phase's catalog read, and (since ONCF-05E-C) the
    // schedule-version surface. Still no conflict-engine, proposal or generation route (05E-D/E).
    expect(routes).toEqual(
      [
        'GET /v1/catalog/scheduling-profiles/:versionId',
        'GET /v1/competitions/:slug/events/:eventSlug/schedule',
        'POST /v1/contests/:contestId/schedule',
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
        /conflict|optimi|generate-schedule|schedule-proposal|resource-assign/i.test(r.url),
      ),
    ).toEqual([]);
  });
});
