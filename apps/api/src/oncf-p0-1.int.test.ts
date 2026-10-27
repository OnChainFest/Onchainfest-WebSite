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

// ONCF WP-P0-1 API (D-14): a result write on a match that is not IN_PROGRESS or COMPLETED answers
// 409 INVALID_TRANSITION with the allowlisted reason CONTEST_NOT_PLAYABLE and records nothing;
// played matches keep the submit → accept → declare official → correct workflow.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form navigation of JSON responses
type Json = Record<string, any>;

const SECRET = 'oncf-p0-1-api-int-secret-0123456789abcdef';
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
async function organizer(label: string) {
  const o = await person(label);
  const org = await call(
    'POST',
    '/v1/organizations',
    { ...o.h, ...idem() },
    { orgType: 'CLUB', slug: uniqueSlug(label), profile: { displayName: `${label} club` } },
  );
  const slug = uniqueSlug('p01fest');
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
          name: 'P0-1 API sport',
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
    const a = await athlete(`p01-${eventSlug}-p${i}`);
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

/**
 * The ADR-0077 operator act: the organizer's own PERSON principal receives the four result
 * capabilities, bound to its current OWNER eligibility (ADR-0079 §2.3).
 */
async function grant(A: Org) {
  platformPrincipalId ??= (
    await governance.bootstrapPlatformAnchor({
      governanceDecisionRef: `gov:p01-api:anchor:${newId()}`,
      basisRef: 'basis:p01-api:charter',
    })
  ).platformPrincipalId;
  const g = await governance.grantCompetitionResultAuthority({
    platformPrincipalId,
    competitionId: A.competitionId,
    granteeAccountId: A.accountId,
    governanceDecisionRef: `gov:p01-api:${newId()}`,
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
const flipped = { family: 'SETS_OF_GAMES', sets: [{ games: [1, 6] }, { games: [2, 6] }] };

describe('WP-P0-1 API · results only on played matches (D-14)', () => {
  it('409 CONTEST_NOT_PLAYABLE on PLANNED, SCHEDULED, CANCELLED and VOID; nothing recorded; played matches unchanged', async () => {
    const A = await organizer('p01');
    await grant(A);
    const submit = (contestId: string, s: Json = sheet) =>
      call(
        'POST',
        `/v1/contests/${contestId}/results`,
        { ...A.h, ...idem() },
        { sheet: s, recognitionLevel: 'PLATFORM' },
      );
    const versions = async (contestId: string) =>
      ((await call('GET', `/v1/contests/${contestId}/results`, A.h)).body?.versions ?? []).length;
    const refused = (r: Awaited<ReturnType<typeof call>>) => {
      expect(r.status, r.text).toBe(409);
      expect(r.body?.error).toMatchObject({
        code: 'INVALID_TRANSITION',
        reason: 'CONTEST_NOT_PLAYABLE',
      });
      expect(r.text).not.toMatch(/contestStatus|stack|sql/i);
    };

    // PLANNED, then SCHEDULED, then CANCELLED.
    const a = await category(A, uniqueSlug('pa'));
    refused(await submit(a.contestId));
    await scheduleOnCourt(A, a.contestId);
    refused(await submit(a.contestId));
    expect(
      (await call('POST', `/v1/contests/${a.contestId}/cancel`, A.h, { reason: 'rain' })).status,
    ).toBe(200);
    refused(await submit(a.contestId));
    expect(await versions(a.contestId)).toBe(0);

    // Played: submit → accept → declare official → (completed) correct → declare.
    const b = await category(A, uniqueSlug('pb'));
    await scheduleOnCourt(A, b.contestId);
    expect((await call('POST', `/v1/contests/${b.contestId}/start`, A.h)).status).toBe(200);
    const sub = await submit(b.contestId);
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
    expect((await call('POST', `/v1/contests/${b.contestId}/complete`, A.h)).status).toBe(200);
    const correction = await call(
      'POST',
      `/v1/contests/${b.contestId}/results/corrections`,
      { ...A.h, ...idem() },
      {
        sheet: flipped,
        supersedesVersionId: rv,
        reason: 'scorer error',
        recognitionLevel: 'PLATFORM',
      },
    );
    expect(correction.status, correction.text).toBe(200);
    const corrected = correction.body?.resultVersionId as string;

    // VOID: a further correction or declaration is refused; history stays.
    expect(
      (await call('POST', `/v1/contests/${b.contestId}/void`, A.h, { reason: 'appeal' })).status,
    ).toBe(200);
    const before = await versions(b.contestId);
    refused(
      await call(
        'POST',
        `/v1/result-versions/${corrected}/declare-official`,
        { ...A.h, ...idem() },
        { recognitionLevel: 'PLATFORM' },
      ),
    );
    refused(await submit(b.contestId, flipped));
    expect(await versions(b.contestId)).toBe(before);
  }, 600_000);

  it('authorization comes first for everyone outside the staff: the match state is never disclosed', async () => {
    const A = await organizer('p01auth');
    await grant(A);
    const played = await category(A, uniqueSlug('pp'));
    await scheduleOnCourt(A, played.contestId);
    expect((await call('POST', `/v1/contests/${played.contestId}/start`, A.h)).status).toBe(200);
    const unplayed = await category(A, uniqueSlug('pu'));
    await scheduleOnCourt(A, unplayed.contestId);

    const outsider = await person('p01out');
    const scheduler = await person('p01sched');
    const staffed = await call(
      'POST',
      `/v1/competitions/${A.competitionId}/staff`,
      { ...A.h, ...idem() },
      { personId: scheduler.personId, role: 'SCHEDULER' },
    );
    expect(staffed.status, staffed.text).toBeLessThan(300);

    const submit = (h: Record<string, string>, contestId: string) =>
      call(
        'POST',
        `/v1/contests/${contestId}/results`,
        { ...h, ...idem() },
        { sheet, recognitionLevel: 'PLATFORM' },
      );
    const shape = (r: Awaited<ReturnType<typeof call>>) => [r.status, r.body?.error?.code ?? null];
    const discloses = (r: Awaited<ReturnType<typeof call>>) =>
      /CONTEST_NOT_PLAYABLE|not started|cancelled|voided|SCHEDULED|IN_PROGRESS/i.test(r.text);

    // Anonymous: 401 on both, before anything about the match.
    const anonP = await submit({}, played.contestId);
    const anonU = await submit({}, unplayed.contestId);
    expect(anonP.status).toBe(401);
    expect(shape(anonU)).toEqual(shape(anonP));
    expect(discloses(anonU)).toBe(false);

    // Signed in but not competition staff: the same refusal whether or not the match was played.
    const outP = await submit(outsider.h, played.contestId);
    const outU = await submit(outsider.h, unplayed.contestId);
    expect([403, 404]).toContain(outP.status);
    expect(shape(outU)).toEqual(shape(outP));
    expect(discloses(outU)).toBe(false);

    // Competition staff without a result grant: denied on a played match. On an unplayed match the
    // lifecycle refusal answers first (the RESULTS_FROZEN precedence) — staff already read match
    // states (COMP_VIEW_PRIVATE), so nothing new is disclosed and nothing is recorded either way.
    const stP = await submit(scheduler.h, played.contestId);
    expect(stP.status, stP.text).toBe(403);
    expect(stP.body?.error?.code).toBe('AUTHORITY_DENIED');
    const stU = await submit(scheduler.h, unplayed.contestId);
    expect(stU.status, stU.text).toBe(409);
    expect(stU.body?.error).toMatchObject({ reason: 'CONTEST_NOT_PLAYABLE' });
    const contest = await call('GET', `/v1/contests/${unplayed.contestId}/results`, scheduler.h);
    expect(contest.status, contest.text).toBe(200);

    // The grantee: accepted on the played match, refused on the unplayed one.
    expect((await submit(A.h, played.contestId)).status).toBe(200);
    expect((await submit(A.h, unplayed.contestId)).status).toBe(409);
    const versions = async (contestId: string) =>
      ((await call('GET', `/v1/contests/${contestId}/results`, A.h)).body?.versions ?? []).length;
    expect(await versions(played.contestId)).toBe(1);
    expect(await versions(unplayed.contestId)).toBe(0);
  }, 600_000);
});
