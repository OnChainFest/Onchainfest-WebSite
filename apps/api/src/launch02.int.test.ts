import {
  ADVANCEMENT_POLICY_TEMPLATES,
  CANONICAL_CATALOG,
  RULESET_TEMPLATES,
  TENNIS_SINGLES_V1,
  type DisciplineVersionSpec,
} from '@br/competition';
import { newId } from '@br/domain';
import {
  CatalogStore,
  CompetitionReader,
  IdentityStore,
  ResultAuthorityGovernance,
} from '@br/persistence';
import { apiDb, newTestAccount, operatorDb, uniqueSlug } from '@br/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevTokenAuth, mintDevToken } from './auth';
import { buildServer } from './server';

// LAUNCH-02 · ADR-0077 end to end over HTTP, composed as production composes the API: result
// conflict-of-interest questions are answered from database participation (`resultParticipationIndex`),
// never from a test fixture. Authority comes only from the operator's governance grant, and the
// lifecycle stays SUBMITTED → PROVISIONAL → OFFICIAL.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form navigation of JSON responses
type Json = Record<string, any>;

const SECRET = 'launch02-api-int-secret-0123456789abcdef';
const db = apiDb();
const operator = operatorDb();
const auth = (identity: IdentityStore) => createDevTokenAuth(identity, { secret: SECRET });
const app = buildServer({ db, operatorDb: operator, resultParticipationIndex: true, auth });
// The pre-LAUNCH-02 production composition: no participation source at all.
const failClosed = buildServer({ db, auth });
const governance = new ResultAuthorityGovernance(db);
afterAll(async () => {
  await Promise.all([app.close(), failClosed.close()]);
  await Promise.all([db.destroy(), operator.destroy()]);
});

const idem = () => ({ 'idempotency-key': `k-${newId()}` });
const bearer = (subject: string) => ({
  authorization: `Bearer ${mintDevToken(subject, { secret: SECRET })}`,
});
async function call(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  headers: Record<string, string> = {},
  payload?: unknown,
  server = app,
) {
  const res = await server.inject({
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
  const h = bearer(`${label}-${newId()}`);
  const p = await call('POST', '/v1/persons', { ...h, ...idem() }, { relation: 'SELF' });
  expect(p.status, p.text).toBe(201);
  const me = await call('GET', '/v1/me', h);
  return { h, personId: p.body?.personId as string, accountId: me.body?.accountId as string };
}
async function withAthlete(u: Awaited<ReturnType<typeof person>>, label: string) {
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
  expect(org.status, org.text).toBe(201);
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
async function event(org: Awaited<ReturnType<typeof organizer>>, slug: string): Promise<string> {
  const ev = await call(
    'POST',
    `/v1/competitions/${org.competitionId}/events`,
    { ...org.h, ...idem() },
    {
      slug,
      disciplineVersionId: v['tennis@2'],
      formatVersionId: v['se'],
      formatConfig: { drawSize: 4 },
      settings: { name: slug, category: { genderCategory: 'OPEN' } },
    },
  );
  expect(ev.status, ev.text).toBe(201);
  const eventId = ev.body?.eventId as string;
  const pinned = await call(
    'PUT',
    `/v1/events/${eventId}/scoring`,
    { ...org.h, ...idem() },
    { rulesetVersionId: v['rs'], advancementPolicyVersionId: v['ap'] },
  );
  expect(pinned.status, pinned.text).toBe(200);
  expect((await call('POST', `/v1/events/${eventId}/open-registration`, org.h)).status).toBe(200);
  return eventId;
}
async function register(eventId: string, a: { h: Record<string, string>; athleteId: string }) {
  const r = await call(
    'POST',
    `/v1/events/${eventId}/registrations`,
    { ...a.h, ...idem() },
    { athleteId: a.athleteId, eligibilityDeclared: true },
  );
  expect(r.status, r.text).toBe(201);
}
async function staff(
  org: Awaited<ReturnType<typeof organizer>>,
  personId: string,
  role: 'ADMIN' | 'REGISTRATION_MANAGER',
): Promise<string> {
  const s = await call(
    'POST',
    `/v1/competitions/${org.competitionId}/staff`,
    { ...org.h, ...idem() },
    { personId, role },
  );
  expect(s.status, s.text).toBe(201);
  return s.body?.staffId as string;
}

const tag = newId().replace(/-/g, '').slice(-8);
const v: Record<string, string> = {};
const LEVEL = { recognitionLevel: 'PLATFORM' };
const SHEET = { family: 'SETS_OF_GAMES', sets: [{ games: [6, 1] }, { games: [6, 2] }] };
const CORRECTED = { family: 'SETS_OF_GAMES', sets: [{ games: [6, 3] }, { games: [6, 2] }] };

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
          code: `l${tag}`,
          name: 'Launch 02 sport',
          disciplines: [
            { code: `l${tag}.tennis`, name: 'Tennis', specs: [TENNIS_SINGLES_V1, tennisV2] },
          ],
        },
      ],
      formats: [
        {
          code: `se-l${tag}`,
          name: 'SE',
          versions: [{ engineId: 'single-elimination', engineVersion: 2 }],
        },
      ],
      rulesets: RULESET_TEMPLATES.filter((t) => t.code === 'sets-bo3-tiebreak').map((t) => ({
        code: `rl${tag}-${t.code}`,
        name: t.name,
        versions: [{ spec: t.spec, basis: t.basis }],
      })),
      advancementPolicies: ADVANCEMENT_POLICY_TEMPLATES.filter(
        (t) => t.code === 'official-confirmed',
      ).map((t) => ({
        code: `pl${tag}-${t.code}`,
        name: t.name,
        versions: [{ spec: t.spec, basis: t.basis }],
      })),
    },
  });
  expect(report.conflicts).toEqual([]);
  const listed = await new CompetitionReader(db).catalog();
  for (const d of listed.disciplineVersions)
    if (d.discipline.code === `l${tag}.tennis`) v[`tennis@${d.version}`] = d.disciplineVersionId;
  for (const f of listed.formatVersions)
    if (f.format.code === `se-l${tag}`) v['se'] = f.formatVersionId;
  for (const r of listed.rulesetVersions)
    if (r.code === `rl${tag}-sets-bo3-tiebreak`) v['rs'] = r.versionId;
  for (const a of listed.advancementPolicyVersions)
    if (a.code === `pl${tag}-official-confirmed`) v['ap'] = a.versionId;
}, 240_000);

describe('LAUNCH-02 · governance-issued result authority over the API', () => {
  it('real organizer staff run SUBMITTED → PROVISIONAL → OFFICIAL; everyone else stays denied', async () => {
    const A = await organizer('l02-a');
    const B = await organizer('l02-b');
    const eventId = await event(A, 'singles');
    for (let i = 0; i < 4; i++)
      await register(eventId, await withAthlete(await person(`l02-p${i}`), `l02-p${i}`));
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
    const [sf1, sf2] = bracket.body?.rounds[0]?.contests as Json[];

    const admin = await person('l02-admin');
    const adminStaffId = await staff(A, admin.personId, 'ADMIN');
    const regman = await person('l02-regman');
    await staff(A, regman.personId, 'REGISTRATION_MANAGER');

    // Before any governance act: staff hold no sporting authority.
    const before = await call(
      'POST',
      `/v1/contests/${sf1?.contestId}/results`,
      { ...A.h, ...idem() },
      { sheet: SHEET, ...LEVEL },
    );
    expect(before.status, before.text).toBe(403);
    expect(before.body?.error?.code).toBe('AUTHORITY_DENIED');

    // The operator act (ADR-0077): anchor once, then grant the OWNER and the ADMIN for A only.
    const { platformPrincipalId } = await governance.bootstrapPlatformAnchor({
      governanceDecisionRef: `gov:l02-api:anchor:${tag}`,
      basisRef: 'basis:l02-api:charter',
    });
    for (const u of [A, admin])
      expect(
        (
          await governance.grantCompetitionResultAuthority({
            platformPrincipalId,
            competitionId: A.competitionId,
            granteeAccountId: u.accountId,
            governanceDecisionRef: `gov:l02-api:${u.accountId}`,
          })
        ).created,
      ).toBe(true);
    // B's OWNER is refused a grant for A's competition (cross-organization isolation).
    await expect(
      governance.grantCompetitionResultAuthority({
        platformPrincipalId,
        competitionId: A.competitionId,
        granteeAccountId: B.accountId,
        governanceDecisionRef: `gov:l02-api:b:${tag}`,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await governance.grantCompetitionResultAuthority({
      platformPrincipalId,
      competitionId: B.competitionId,
      granteeAccountId: B.accountId,
      governanceDecisionRef: `gov:l02-api:b-own:${tag}`,
    });

    // T2 by the OWNER, T3 by the OWNER, T5 by the ADMIN — under the production participation checker.
    const sub = await call(
      'POST',
      `/v1/contests/${sf1?.contestId}/results`,
      { ...A.h, ...idem() },
      { sheet: SHEET, ...LEVEL },
    );
    expect(sub.status, sub.text).toBe(200);
    expect(sub.body?.status).toBe('SUBMITTED');
    const rv = sub.body?.resultVersionId as string;
    // Declaring a SUBMITTED version official is still an invalid transition (lifecycle unchanged).
    expect(
      (
        await call(
          'POST',
          `/v1/result-versions/${rv}/declare-official`,
          { ...A.h, ...idem() },
          LEVEL,
        )
      ).status,
    ).toBe(409);

    // Strangers to A: B (with its own grant elsewhere), the registration manager (staff, no grant).
    for (const h of [B.h, regman.h]) {
      expect(
        (await call('POST', `/v1/result-versions/${rv}/accept`, { ...h, ...idem() }, LEVEL)).status,
      ).toBe(403);
      expect(
        (
          await call(
            'POST',
            `/v1/contests/${sf2?.contestId}/results`,
            { ...h, ...idem() },
            { sheet: SHEET, ...LEVEL },
          )
        ).status,
      ).toBe(403);
    }

    // The pre-LAUNCH-02 composition still fails closed on the conflict-sensitive step.
    const closed = await call(
      'POST',
      `/v1/result-versions/${rv}/accept`,
      { ...A.h, ...idem() },
      LEVEL,
      failClosed,
    );
    expect(closed.status).toBe(403);
    expect(closed.body?.error?.message).toContain('CONFLICT_CHECK_UNAVAILABLE');

    const accepted = await call(
      'POST',
      `/v1/result-versions/${rv}/accept`,
      { ...A.h, ...idem() },
      LEVEL,
    );
    expect(accepted.status, accepted.text).toBe(200);
    expect(accepted.body?.status).toBe('PROVISIONAL');
    const official = await call(
      'POST',
      `/v1/result-versions/${rv}/declare-official`,
      { ...admin.h, ...idem() },
      LEVEL,
    );
    expect(official.status, official.text).toBe(200);
    expect(official.body?.status).toBe('OFFICIAL');
    expect(
      (await call('GET', `/v1/contests/${sf1?.contestId}/results`, A.h)).body?.versions,
    ).toEqual([
      expect.objectContaining({ resultVersionId: rv, status: 'OFFICIAL', current: true }),
    ]);

    // Atomic correction (CORRECT_RESULT + ACCEPT_RESULT), then explicit re-officialization.
    const fixed = await call(
      'POST',
      `/v1/contests/${sf1?.contestId}/results/corrections`,
      { ...A.h, ...idem() },
      { sheet: CORRECTED, supersedesVersionId: rv, reason: 'score entry error', ...LEVEL },
    );
    expect(fixed.status, fixed.text).toBe(200);
    expect(fixed.body).toMatchObject({ supersededVersionId: rv, status: 'PROVISIONAL' });
    const rv2 = fixed.body?.resultVersionId as string;
    expect(
      (
        await call(
          'POST',
          `/v1/result-versions/${rv2}/declare-official`,
          { ...admin.h, ...idem() },
          LEVEL,
        )
      ).status,
    ).toBe(200);
    expect(
      (await call('GET', `/v1/contests/${sf1?.contestId}/results`, A.h)).body?.versions,
    ).toEqual([
      expect.objectContaining({ resultVersionId: rv2, status: 'OFFICIAL', current: true }),
      expect.objectContaining({ resultVersionId: rv, status: 'SUPERSEDED', current: false }),
    ]);

    // Conflict of interest at action time: the ADMIN enters the competition as an athlete in
    // another event. Submission stays possible (SUBMIT_RESULT is not conflict-sensitive);
    // acceptance and declaration are refused while the participation lasts.
    const sub2 = await call(
      'POST',
      `/v1/contests/${sf2?.contestId}/results`,
      { ...A.h, ...idem() },
      { sheet: SHEET, ...LEVEL },
    );
    expect(sub2.status, sub2.text).toBe(200);
    const rv3 = sub2.body?.resultVersionId as string;
    const doubles = await event(A, 'consolation');
    await register(doubles, await withAthlete(admin, 'l02-admin'));
    const conflicted = await call(
      'POST',
      `/v1/result-versions/${rv3}/accept`,
      { ...admin.h, ...idem() },
      LEVEL,
    );
    expect(conflicted.status).toBe(403);
    expect(conflicted.body?.error?.message).toContain('CONFLICT_OF_INTEREST');
    expect(
      (await call('POST', `/v1/result-versions/${rv3}/accept`, { ...A.h, ...idem() }, LEVEL))
        .status,
    ).toBe(200);

    // Losing the staff role stops result actions at once (staff gate), grant or no grant.
    expect((await call('DELETE', `/v1/competition-staff/${adminStaffId}`, A.h)).status).toBe(204);
    const gone = await call(
      'POST',
      `/v1/result-versions/${rv3}/declare-official`,
      { ...admin.h, ...idem() },
      LEVEL,
    );
    expect(gone.status).toBe(403);
    expect(gone.body?.error?.code).toBe('FORBIDDEN');
    expect(
      (
        await call(
          'POST',
          `/v1/result-versions/${rv3}/declare-official`,
          { ...A.h, ...idem() },
          LEVEL,
        )
      ).status,
    ).toBe(200);
  });

  it('exposes no route that issues, revokes or lists authority grants or anchors', () => {
    const paths = app.v1Routes.map((r) => `${r.method} ${r.url}`);
    expect(paths.filter((p) => /grant|anchor|authorit/i.test(p))).toEqual([]);
  });
});
