import {
  CANONICAL_CATALOG,
  PROPOSAL_BUDGET,
  PROPOSAL_STRATEGY,
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

// ONCF-05E-E API: the read-only proposal PREVIEW (ADR-0075 § 16). COMP_MANAGE_SCHEDULE (OWNER,
// ADMIN, SCHEDULER); the closed body carries only `scope` and `from`, and any client-supplied
// authoritative data (resources, availability, profiles, placements, budget...) is refused. Nothing
// is written: no assignment, version, publication, resource or availability changes. There is no
// commit, generation or optimization route.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form navigation of JSON responses
type Json = Record<string, any>;

const SECRET = 'oncf05e-e-api-int-secret-0123456789abcdef';
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
type Org = Awaited<ReturnType<typeof organizer>>;

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
          code: `w${tag}`,
          name: '05E-E API sport',
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
    if (d.discipline.code === `w${tag}.tennis`) v['tennis'] = d.disciplineVersionId;
  for (const f of listed.formatVersions)
    if (f.format.code === `se-${tag}`) v['se'] = f.formatVersionId;
  for (const r of listed.rulesetVersions)
    if (r.code === `q${tag}-sets-bo3-tiebreak`) v['rs'] = r.versionId;
  for (const p of listed.schedulingProfileVersions)
    if (p.code === `s${tag}-tennis`) v['sp'] = p.versionId;
}, 240_000);

/** A four-player tennis knockout with a court, declared hours and an open draft — all over HTTP. */
async function scheduledKnockout(o: Org, label: string) {
  const ev = await call(
    'POST',
    `/v1/competitions/${o.competitionId}/events`,
    { ...o.h, ...idem() },
    {
      slug: 'singles',
      disciplineVersionId: v['tennis'],
      formatVersionId: v['se'],
      formatConfig: { drawSize: 4 },
      settings: {
        name: 'Singles',
        category: { genderCategory: 'OPEN' },
        startsAt: '2027-09-01T12:00:00Z',
        endsAt: '2027-09-08T12:00:00Z',
      },
    },
  );
  expect(ev.status, ev.text).toBe(201);
  const eventId = ev.body?.eventId as string;
  expect(
    (
      await call(
        'PUT',
        `/v1/events/${eventId}/scoring`,
        { ...o.h, ...idem() },
        { rulesetVersionId: v['rs'], schedulingProfileVersionId: v['sp'] },
      )
    ).status,
  ).toBe(200);
  expect((await call('POST', `/v1/events/${eventId}/open-registration`, o.h)).status).toBe(200);
  for (let i = 0; i < 4; i++) {
    const a = await athlete(`${label}-p${i}`);
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
  expect((await call('POST', `/v1/events/${eventId}/close-registration`, o.h)).status).toBe(200);
  expect(
    (await call('POST', `/v1/events/${eventId}/lock-field`, { ...o.h, ...idem() })).status,
  ).toBe(200);
  expect(
    (
      await call(
        'POST',
        `/v1/events/${eventId}/seed`,
        { ...o.h, ...idem() },
        { method: 'DETERMINISTIC_DRAW' },
      )
    ).status,
  ).toBe(200);
  expect(
    (await call('POST', `/v1/events/${eventId}/generate-plan`, { ...o.h, ...idem() })).status,
  ).toBe(200);
  const bracket = await call('GET', `/v1/competitions/${o.slug}/events/singles/bracket`);
  const contests = (bracket.body?.rounds as Json[]).flatMap((r) => r.contests as Json[]);
  expect(contests).toHaveLength(3);
  const court = await call(
    'POST',
    `/v1/competitions/${o.competitionId}/resources`,
    { ...o.h, ...idem() },
    { typeCode: 'TENNIS_COURT', label: 'Court 1' },
  );
  expect(court.status, court.text).toBe(201);
  for (const weekday of [1, 2, 3, 4, 5, 6, 7])
    expect(
      (
        await call(
          'POST',
          `/v1/competitions/${o.competitionId}/availability`,
          { ...o.h, ...idem() },
          { resourceId: null, fact: { kind: 'WEEKLY', weekday, start: '00:00', end: '24:00' } },
        )
      ).status,
    ).toBe(201);
  const draft = await call('POST', `/v1/competitions/${o.competitionId}/schedule/drafts`, {
    ...o.h,
    ...idem(),
  });
  expect(draft.status, draft.text).toBe(201);
  return {
    eventId,
    contests,
    courtId: court.body?.resourceId as string,
    versionId: draft.body?.versionId as string,
  };
}

/** What a preview must never change, read through the public and staff API. */
async function observable(o: Org, versionId: string) {
  const reads = await Promise.all([
    call('GET', `/v1/schedule-versions/${versionId}`, o.h),
    call('GET', `/v1/competitions/${o.competitionId}/schedule/versions`, o.h),
    call('GET', `/v1/competitions/${o.slug}/events/singles/schedule`),
    call('GET', `/v1/competitions/${o.competitionId}/resources`, o.h),
    call('GET', `/v1/competitions/${o.competitionId}/availability`, o.h),
  ]);
  for (const r of reads) expect(r.status, r.text).toBe(200);
  return reads.map((r) => r.body);
}

describe('ONCF-05E-E proposal preview over the API', () => {
  it('authorized preview: canonical proposal, diagnostics apart, read-only, deterministic; every refusal', async () => {
    const A = await organizer('o5ee-a');
    const B = await organizer('o5ee-b');
    const stranger = await person('o5ee-stranger');
    const scheduler = await person('o5ee-scheduler');
    const manager = await person('o5ee-regman');
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
    const a = await scheduledKnockout(A, 'o5ee-a');
    const b = await scheduledKnockout(B, 'o5ee-b');
    const url = (versionId: string) => `/v1/schedule-versions/${versionId}/proposals/preview`;

    const before = await observable(A, a.versionId);
    const ok = await call('POST', url(a.versionId), A.h, {});
    expect(ok.status, ok.text).toBe(200);
    expect(Object.keys(ok.body as Json).sort()).toEqual(
      ['competitionId', 'diagnostics', 'proposal', 'versionId'].sort(),
    );
    const p = ok.body?.proposal as Json;
    expect(ok.body).toMatchObject({ versionId: a.versionId, competitionId: A.competitionId });
    expect(p).toMatchObject({
      proposalVersion: 1,
      strategy: PROPOSAL_STRATEGY,
      budget: PROPOSAL_BUDGET,
      scope: { eventIds: null, roundIds: null },
      from: null,
      status: 'SUCCESS',
      unplaced: [],
      report: { hardConflicts: 0 },
    });
    expect(p.proposalHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(p.baseStateIdentity).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(p.report.reportHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(p.placements).toHaveLength(3);
    for (const x of p.placements as Json[]) expect(x.resourceId).toBe(a.courtId);
    // The canonical body carries no timestamp, runtime, actor or request identifier.
    expect(JSON.stringify(p)).not.toMatch(/recordedAt|generatedAt|runtime|actor|requestId/i);
    expect(ok.body?.diagnostics).toMatchObject({ judgeCalls: expect.any(Number) });
    expect(p.diagnostics).toBeUndefined();

    // Read-only: nothing observable changed, and the same request returns the same bytes.
    expect(await observable(A, a.versionId)).toEqual(before);
    const again = await call('POST', url(a.versionId), A.h, {});
    expect(again.text).toBe(ok.text);
    // The body is always a JSON object (possibly empty), as for the other closed-body commands.
    expect((await call('POST', url(a.versionId), A.h)).status).toBe(400);

    // Request parameters: scope (this competition's ids) and a whole-second `from`.
    const scoped = await call('POST', url(a.versionId), A.h, {
      scope: { eventIds: [a.eventId] },
      from: '2027-09-02T09:00:00Z',
    });
    expect(scoped.status, scoped.text).toBe(200);
    expect(scoped.body?.proposal).toMatchObject({
      scope: { eventIds: [a.eventId], roundIds: null },
      from: Date.parse('2027-09-02T09:00:00Z') / 1000,
    });
    for (const [body, reason] of [
      [{ from: '2027-09-02T09:00:00.250Z' }, undefined],
      [{ from: 'next tuesday morning' }, undefined],
      [{ scope: { eventIds: [b.eventId] } }, 'FOREIGN_SCOPE'],
      [{ scope: { roundIds: [a.contests[0]?.contestId] } }, 'FOREIGN_SCOPE'],
      [{ scope: { eventIds: ['not-a-uuid'] } }, undefined],
    ] as const) {
      const r = await call('POST', url(a.versionId), A.h, body);
      expect(r.status, `${JSON.stringify(body)} ${r.text}`).toBe(400);
      expect(r.body?.error.code).toBe('INVALID_INPUT');
      if (reason !== undefined) expect(r.text).not.toContain(b.eventId);
    }

    // Client-supplied authoritative data is refused, never ignored (closed schema).
    for (const body of [
      { resources: [{ id: a.courtId, typeCode: 'TENNIS_COURT' }] },
      { availability: [{ kind: 'WEEKLY', weekday: 1, start: '00:00', end: '24:00' }] },
      { profile: { versionId: v['sp'] } },
      { schedulingProfileVersionId: v['sp'] },
      { placements: [{ contestId: a.contests[0]?.contestId, start: 0 }] },
      { assignments: [] },
      { budget: { maxEvaluations: 1 } },
      { strategy: { id: 'other', version: 9 } },
      { proposalHash: p.proposalHash },
      { scope: { contestIds: [a.contests[0]?.contestId] } },
      { scope: { eventIds: [a.eventId], resources: [] } },
    ]) {
      const r = await call('POST', url(a.versionId), A.h, body);
      expect(r.status, `${JSON.stringify(body)} ${r.text}`).toBe(400);
    }
    expect(await observable(A, a.versionId)).toEqual(before);

    // Who may preview: COMP_MANAGE_SCHEDULE only. A foreign version reads like any other refusal.
    const bySch = await call('POST', url(a.versionId), scheduler.h, {});
    expect(bySch.status, bySch.text).toBe(200);
    expect(bySch.body?.proposal.proposalHash).toBe(p.proposalHash);
    for (const h of [manager.h, stranger.h, B.h])
      expect((await call('POST', url(a.versionId), h, {})).status).toBe(403);
    expect((await call('POST', url(b.versionId), A.h, {})).status).toBe(403);
    expect((await call('POST', url(a.versionId), {}, {})).status).toBe(401);
    expect((await call('POST', url(newId()), A.h, {})).status).toBe(404);
    expect((await call('POST', url('nope'), A.h, {})).status).toBe(400);

    // Not the open draft: INCOMPLETE_STATE (409), no proposal.
    expect(
      (
        await call(
          'POST',
          `/v1/schedule-versions/${b.versionId}/discard`,
          { ...B.h, ...idem() },
          { reason: 'restart' },
        )
      ).status,
    ).toBe(200);
    const closed = await call('POST', url(b.versionId), B.h, {});
    expect(closed.status, closed.text).toBe(409);
    expect(closed.body?.error).toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(closed.body?.error.message).toContain('INCOMPLETE_STATE');
    expect(closed.body?.proposal).toBeUndefined();
  }, 600_000);

  it('the route inventory: one read-only proposal route; no commit, generation or optimization route', () => {
    // (BRT-10's classification proposals are a different, result-side surface.)
    expect(
      app.v1Routes
        .filter((r) => /propos/i.test(r.url) && !/classification-proposals/.test(r.url))
        .map((r) => `${r.method} ${r.url}`),
    ).toEqual(['POST /v1/schedule-versions/:versionId/proposals/preview']);
    expect(
      app.v1Routes.filter((r) =>
        /proposals\/(?!preview$)|commit-proposal|optimi|generate-schedule|auto-publish/i.test(
          r.url,
        ),
      ),
    ).toEqual([]);
  });
});
