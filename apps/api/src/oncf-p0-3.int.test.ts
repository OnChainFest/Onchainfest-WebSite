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
import { apiDb, newTestAccount, operatorDb, ownerDb, uniqueSlug } from '@br/testkit';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevTokenAuth, mintDevToken } from './auth';
import { buildServer } from './server';

// ONCF WP-P0-3 API (D-16): every result route (submit, accept, declare official, correct)
// re-checks, inside the result transaction, that the caller is CURRENTLY OWNER or ADMIN of the
// competition; a grantee demoted over the staff routes is refused 403 AUTHORITY_DENIED and nothing
// is written, while the OWNER and a still-ADMIN grantee keep working. Grants come from the
// ADR-0077 governance command; conflicts of interest from the production participation index.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form navigation of JSON responses
type Json = Record<string, any>;

const SECRET = 'oncf-p0-3-api-int-secret-0123456789abcdef';
const db = apiDb();
const operator = operatorDb();
const owner = ownerDb();
const app = buildServer({
  db,
  operatorDb: operator,
  resultParticipationIndex: true,
  auth: (identity: IdentityStore) => createDevTokenAuth(identity, { secret: SECRET }),
});
const governance = new ResultAuthorityGovernance(db);
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
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
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
  const slug = uniqueSlug('p03fest');
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
          name: 'P0-3 API sport',
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
    const a = await athlete(`p03-${eventSlug}-p${i}`);
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
let platformPrincipalId: string;
beforeAll(async () => {
  platformPrincipalId = (
    await governance.bootstrapPlatformAnchor({
      governanceDecisionRef: `gov:p03-api:anchor:${tag}`,
      basisRef: 'basis:p03-api:charter',
    })
  ).platformPrincipalId;
}, 120_000);

/** The ADR-0077 operator act for `accountId`, then a clock margin before first use. */
async function grant(A: Org, accountId: string) {
  const g = await governance.grantCompetitionResultAuthority({
    platformPrincipalId,
    competitionId: A.competitionId,
    granteeAccountId: accountId,
    governanceDecisionRef: `gov:p03-api:${newId()}`,
  });
  for (;;) {
    const { rows } = await sql<{ ok: boolean }>`
      SELECT now() > recorded_at + interval '2 seconds' AS ok
      FROM authority.authority_grant WHERE id = ${g.grantId}`.execute(owner);
    if (rows[0]?.ok === true) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

const sheet = { family: 'SETS_OF_GAMES', sets: [{ games: [6, 1] }, { games: [6, 2] }] };
const flipped = { family: 'SETS_OF_GAMES', sets: [{ games: [1, 6] }, { games: [2, 6] }] };

describe('WP-P0-3 API · result routes need a CURRENT OWNER / ADMIN role (D-16)', () => {
  it('a grantee demoted to SCHEDULER over the staff routes is refused on every result route; nothing is written; the OWNER keeps working', async () => {
    const A = await organizer('p03');
    const scorer = await person('p03scorer');
    const assign = async (role: string) => {
      const r = await call(
        'POST',
        `/v1/competitions/${A.competitionId}/staff`,
        { ...A.h, ...idem() },
        { personId: scorer.personId, role },
      );
      expect(r.status, r.text).toBe(201);
      return r.body?.staffId as string;
    };
    const adminStaffId = await assign('ADMIN');
    await grant(A, scorer.accountId);
    await grant(A, A.accountId);
    const LEVEL = { recognitionLevel: 'PLATFORM' };
    const results = async (contestId: string) =>
      ((await call('GET', `/v1/contests/${contestId}/results`, A.h)).body?.versions ??
        []) as Json[];
    const post = (h: Record<string, string>, url: string, payload: unknown) =>
      call('POST', url, { ...h, ...idem() }, payload);

    // While ADMIN: the full lifecycle works on one final; a second final keeps a pending version.
    const a = await category(A, uniqueSlug('ra'));
    await scheduleOnCourt(A, a.contestId);
    expect((await call('POST', `/v1/contests/${a.contestId}/start`, A.h)).status).toBe(200);
    const sub = await post(scorer.h, `/v1/contests/${a.contestId}/results`, { sheet, ...LEVEL });
    expect(sub.status, sub.text).toBe(200);
    const rv = sub.body?.resultVersionId as string;
    for (const step of ['accept', 'declare-official'])
      expect((await post(scorer.h, `/v1/result-versions/${rv}/${step}`, LEVEL)).status).toBe(200);
    const b = await category(A, uniqueSlug('rb'));
    await scheduleOnCourt(A, b.contestId);
    expect((await call('POST', `/v1/contests/${b.contestId}/start`, A.h)).status).toBe(200);
    const pending = await post(scorer.h, `/v1/contests/${b.contestId}/results`, {
      sheet,
      ...LEVEL,
    });
    expect(pending.status, pending.text).toBe(200);
    const pv = pending.body?.resultVersionId as string;

    // Demotion through the staff routes: SCHEDULER assigned, the ADMIN assignment ended.
    await assign('SCHEDULER');
    expect((await call('DELETE', `/v1/competition-staff/${adminStaffId}`, A.h)).status).toBe(204);
    const beforeA = await results(a.contestId);
    const beforeB = await results(b.contestId);
    const refused = (r: Awaited<ReturnType<typeof call>>, what: string) => {
      expect(r.status, `${what}: ${r.text}`).toBe(403);
      expect(r.body?.error?.code, what).toBe('AUTHORITY_DENIED');
      expect(r.text, what).not.toMatch(/stack|sql|SCHEDULER/i);
    };
    refused(
      await post(scorer.h, `/v1/contests/${a.contestId}/results/corrections`, {
        sheet: flipped,
        supersedesVersionId: rv,
        reason: 'scorer error',
        ...LEVEL,
      }),
      'correct',
    );
    refused(await post(scorer.h, `/v1/result-versions/${pv}/accept`, LEVEL), 'accept');
    refused(await post(scorer.h, `/v1/result-versions/${pv}/declare-official`, LEVEL), 'declare');
    refused(
      await post(scorer.h, `/v1/contests/${b.contestId}/results`, { sheet: flipped, ...LEVEL }),
      'submit',
    );
    expect(await results(a.contestId)).toEqual(beforeA);
    expect(await results(b.contestId)).toEqual(beforeB);

    // The demoted scheduler still schedules (operational role intact); the OWNER still decides.
    expect((await call('GET', `/v1/contests/${b.contestId}/results`, scorer.h)).status).toBe(200);
    for (const step of ['accept', 'declare-official'])
      expect((await post(A.h, `/v1/result-versions/${pv}/${step}`, LEVEL)).status, step).toBe(200);
    const fix = await post(A.h, `/v1/contests/${a.contestId}/results/corrections`, {
      sheet: flipped,
      supersedesVersionId: rv,
      reason: 'scorer error',
      ...LEVEL,
    });
    expect(fix.status, fix.text).toBe(200);
  }, 600_000);

  it('Q3 re-promoted to ADMIN over the staff routes, the scorer stays refused until a fresh grant is issued', async () => {
    const A = await organizer('p03q');
    const scorer = await person('p03q3');
    const assign = async (role: string) => {
      const r = await call(
        'POST',
        `/v1/competitions/${A.competitionId}/staff`,
        { ...A.h, ...idem() },
        { personId: scorer.personId, role },
      );
      expect(r.status, r.text).toBe(201);
      return r.body?.staffId as string;
    };
    const LEVEL = { recognitionLevel: 'PLATFORM' };
    const post = (url: string, payload: unknown) =>
      call('POST', url, { ...scorer.h, ...idem() }, payload);
    // A fixture DB-clock margin past the staff change (grants are bound to rows, ADR-0079 §2.3).
    const settled = async () => {
      for (;;) {
        const { rows } = await sql<{ ok: boolean }>`
          SELECT now() > max(c.recorded_at) + interval '2 seconds' AS ok
          FROM competition.competition_staff s
          JOIN competition.competition_staff_status_change c ON c.staff_id = s.id
          WHERE s.competition_id = ${A.competitionId} AND s.person_id = ${scorer.personId}`.execute(
          owner,
        );
        if (rows[0]?.ok === true) return;
        await new Promise((r) => setTimeout(r, 250));
      }
    };
    const adminStaffId = await assign('ADMIN');
    await settled();
    await grant(A, scorer.accountId);
    const a = await category(A, uniqueSlug('qa'));
    await scheduleOnCourt(A, a.contestId);
    expect((await call('POST', `/v1/contests/${a.contestId}/start`, A.h)).status).toBe(200);
    const sub = await post(`/v1/contests/${a.contestId}/results`, { sheet, ...LEVEL });
    expect(sub.status, sub.text).toBe(200);
    const rv = sub.body?.resultVersionId as string;
    for (const step of ['accept', 'declare-official'])
      expect((await post(`/v1/result-versions/${rv}/${step}`, LEVEL)).status).toBe(200);

    await assign('SCHEDULER');
    expect((await call('DELETE', `/v1/competition-staff/${adminStaffId}`, A.h)).status).toBe(204);
    await assign('ADMIN');
    const before = (await call('GET', `/v1/contests/${a.contestId}/results`, A.h)).body;
    const correction = () =>
      post(`/v1/contests/${a.contestId}/results/corrections`, {
        sheet: flipped,
        supersedesVersionId: rv,
        reason: 'scorer error',
        ...LEVEL,
      });
    const refused = await correction();
    expect(refused.status, refused.text).toBe(403);
    expect(refused.body?.error?.code).toBe('AUTHORITY_DENIED');
    expect(refused.text).not.toMatch(/stack|sql|SCHEDULER|grantId/i);
    expect((await call('GET', `/v1/contests/${a.contestId}/results`, A.h)).body).toEqual(before);

    await settled();
    await grant(A, scorer.accountId);
    const fixed = await correction();
    expect(fixed.status, fixed.text).toBe(200);
  }, 600_000);
});
