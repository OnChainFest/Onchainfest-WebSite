import {
  ADVANCEMENT_POLICY_TEMPLATES,
  CANONICAL_CATALOG,
  RULESET_TEMPLATES,
  TENNIS_SINGLES_V1,
  type DisciplineVersionSpec,
} from '@br/competition';
import { newId, type Uuid } from '@br/domain';
import { AuthorityStore, CatalogStore, CompetitionReader, IdentityStore } from '@br/persistence';
import {
  apiDb,
  declaredNoParticipation,
  newTestAccount,
  operatorDb,
  uniqueSlug,
} from '@br/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevTokenAuth, mintDevToken } from './auth';
import { buildServer } from './server';

// ONCF-05D API: the result lifecycle (as the caller's own PERSON principal, under Authority Engine
// grants) and advancement (state, hash-confirmed commit, reasoned override / revoke). Negative
// authorization: strangers, other organizers (IDOR), registration managers, participants and staff
// without a sporting grant are all refused; there is no arbitrary slot mutation route.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form navigation of JSON responses
type Json = Record<string, any>;

const SECRET = 'oncf05d-api-int-secret-0123456789abcdef';
const db = apiDb();
const operator = operatorDb();
const app = buildServer({
  db,
  operatorDb: operator,
  resultConflictChecker: declaredNoParticipation,
  auth: (identity: IdentityStore) => createDevTokenAuth(identity, { secret: SECRET }),
});
const authority = new AuthorityStore(db, { conflictChecker: declaredNoParticipation });
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
  const report = await new CatalogStore(operator).provision({
    operatorAccountId: op,
    manifest: {
      sports: [
        {
          code: `x${tag}`,
          name: '05D API sport',
          disciplines: [
            { code: `x${tag}.tennis`, name: 'Tennis', specs: [TENNIS_SINGLES_V1, tennisV2] },
          ],
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
      advancementPolicies: ADVANCEMENT_POLICY_TEMPLATES.filter(
        (t) => t.code === 'official-confirmed',
      ).map((t) => ({
        code: `p${tag}-${t.code}`,
        name: t.name,
        versions: [{ spec: t.spec, basis: t.basis }],
      })),
    },
  });
  expect(report.conflicts).toEqual([]);
  const listed = await new CompetitionReader(db).catalog();
  for (const d of listed.disciplineVersions)
    if (d.discipline.code === `x${tag}.tennis`) v[`tennis@${d.version}`] = d.disciplineVersionId;
  for (const f of listed.formatVersions)
    if (f.format.code === `se-${tag}`) v['se'] = f.formatVersionId;
  for (const r of listed.rulesetVersions)
    if (r.code === `q${tag}-sets-bo3-tiebreak`) v['rs'] = r.versionId;
  for (const a of listed.advancementPolicyVersions)
    if (a.code === `p${tag}-official-confirmed`) v['ap'] = a.versionId;
}, 240_000);

describe('ONCF-05D over the API', () => {
  it('result lifecycle under authority grants, advancement with preview confirmation, and every refusal', async () => {
    const A = await organizer('o5d-a');
    const B = await organizer('o5d-b');
    const ev = await call(
      'POST',
      `/v1/competitions/${A.competitionId}/events`,
      { ...A.h, ...idem() },
      {
        slug: 'singles',
        disciplineVersionId: v['tennis@2'],
        formatVersionId: v['se'],
        formatConfig: { drawSize: 4 },
        settings: { name: 'Singles', category: { genderCategory: 'OPEN' } },
      },
    );
    expect(ev.status, ev.text).toBe(201);
    const eventId = ev.body?.eventId as string;
    const pinned = await call(
      'PUT',
      `/v1/events/${eventId}/scoring`,
      { ...A.h, ...idem() },
      { rulesetVersionId: v['rs'], advancementPolicyVersionId: v['ap'] },
    );
    expect(pinned.status, pinned.text).toBe(200);
    expect(
      (await call('GET', `/v1/events/${eventId}/scoring`, A.h)).body?.advancementPolicy,
    ).toMatchObject({ family: 'ADVANCEMENT' });

    // Staff roles: a registration manager can read, never decide.
    const manager = await person('o5d-regman');
    expect(
      (
        await call(
          'POST',
          `/v1/competitions/${A.competitionId}/staff`,
          { ...A.h, ...idem() },
          { personId: manager.personId, role: 'REGISTRATION_MANAGER' },
        )
      ).status,
    ).toBe(201);

    expect((await call('POST', `/v1/events/${eventId}/open-registration`, A.h)).status).toBe(200);
    const players = [];
    for (let i = 0; i < 4; i++) {
      const a = await athlete(`o5d-p${i}`);
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
      players.push(a);
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
    const sf1 = bracket.body?.rounds[0]?.contests[0];
    const lanes = sf1.slots.map((x: Json) => x.participantId as string);
    const sheet = { family: 'SETS_OF_GAMES', sets: [{ games: [6, 1] }, { games: [6, 2] }] };

    // Operational permission never becomes sporting authority: staff without a grant are refused.
    const denied = await call(
      'POST',
      `/v1/contests/${sf1.contestId}/results`,
      { ...A.h, ...idem() },
      { sheet, recognitionLevel: 'PLATFORM' },
    );
    expect(denied.status, denied.text).toBe(403);
    expect(denied.body?.error?.code).toBe('AUTHORITY_DENIED');
    // Strangers and other organizers are refused before any authority question (IDOR).
    const stranger = await person('o5d-stranger');
    expect(
      (
        await call(
          'POST',
          `/v1/contests/${sf1.contestId}/results`,
          { ...stranger.h, ...idem() },
          { sheet, recognitionLevel: 'PLATFORM' },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          'POST',
          `/v1/contests/${sf1.contestId}/results`,
          { ...B.h, ...idem() },
          { sheet, recognitionLevel: 'PLATFORM' },
        )
      ).status,
    ).toBe(403);
    expect((await call('GET', `/v1/contests/${sf1.contestId}/results`, B.h)).status).toBe(403);

    // The organizer's own PERSON principal receives grants from a recognized platform anchor.
    const principal = await call('POST', `/v1/persons/${A.personId}/principal`, A.h);
    expect(principal.status, principal.text).toBe(200);
    const platform = await authority.registerPrincipal({
      principalType: 'PLATFORM',
      label: 'platform (05D api)',
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
    const invalid = await call(
      'POST',
      `/v1/contests/${sf1.contestId}/results`,
      { ...A.h, ...idem() },
      {
        sheet: { family: 'SETS_OF_GAMES', sets: [{ games: [6, 5] }] },
        recognitionLevel: 'PLATFORM',
      },
    );
    expect(invalid.status).toBe(400);
    const sub = await call(
      'POST',
      `/v1/contests/${sf1.contestId}/results`,
      { ...A.h, ...idem() },
      { sheet, recognitionLevel: 'PLATFORM' },
    );
    expect(sub.status, sub.text).toBe(200);
    const rv = sub.body?.resultVersionId as string;
    expect(
      (
        await call(
          'POST',
          `/v1/result-versions/${rv}/declare-official`,
          { ...A.h, ...idem() },
          { recognitionLevel: 'PLATFORM' },
        )
      ).status,
    ).toBe(409);
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
    expect(
      (
        await call(
          'POST',
          `/v1/result-versions/${rv}/declare-official`,
          { ...B.h, ...idem() },
          { recognitionLevel: 'PLATFORM' },
        )
      ).status,
    ).toBe(403);
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
    const versions = await call('GET', `/v1/contests/${sf1.contestId}/results`, A.h);
    expect(versions.body?.versions).toEqual([
      expect.objectContaining({ resultVersionId: rv, status: 'OFFICIAL', current: true }),
    ]);

    // Advancement: readable by staff (incl. the registration manager), decided only by OWNER / ADMIN.
    const state = await call('GET', `/v1/events/${eventId}/advancement`, A.h);
    expect(state.status, state.text).toBe(200);
    const unit = state.body?.units.find((u: Json) => u.unitKey === `contest:${sf1.contestId}`);
    expect(unit.targets[0].proposed).toMatchObject({ state: 'RESOLVED', participantId: lanes[0] });
    expect((await call('GET', `/v1/events/${eventId}/advancement`, manager.h)).status).toBe(200);
    for (const h of [manager.h, players[0]?.h as Record<string, string>, stranger.h, B.h])
      expect(
        (
          await call(
            'POST',
            `/v1/events/${eventId}/advancement/commit`,
            { ...h, ...idem() },
            { units: [{ unitKey: unit.unitKey, previewHash: unit.previewHash }] },
          )
        ).status,
      ).toBe(403);
    for (const h of [stranger.h, B.h, players[0]?.h as Record<string, string>])
      expect((await call('GET', `/v1/events/${eventId}/advancement`, h)).status).toBe(403);
    expect(
      (
        await call(
          'POST',
          `/v1/events/${eventId}/advancement/commit`,
          { ...A.h, ...idem() },
          { units: [{ unitKey: unit.unitKey }] },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          'POST',
          `/v1/events/${eventId}/advancement/commit`,
          { ...A.h, ...idem() },
          { units: [{ unitKey: unit.unitKey, previewHash: `sha256:${'f'.repeat(64)}` }] },
        )
      ).status,
    ).toBe(409);
    const ok = await call(
      'POST',
      `/v1/events/${eventId}/advancement/commit`,
      { ...A.h, ...idem() },
      { units: [{ unitKey: unit.unitKey, previewHash: unit.previewHash }] },
    );
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body?.decisions).toHaveLength(1);

    // Public bracket: the finalist appears; organizer-only data (provenance, reasons) never does.
    const pub = await call('GET', `/v1/competitions/${A.slug}/events/singles/bracket`);
    const finalSlot = pub.body?.rounds
      .flatMap((r: Json) => r.contests)
      .flatMap((c: Json) => c.slots)
      .find((s: Json) => s.kind === 'WINNER_OF_CONTEST' && s.contestId === sf1.contestId);
    expect(finalSlot).toMatchObject({ resolved: true, participantId: lanes[0] });
    expect(pub.text).not.toContain('resultVersionId');
    expect(pub.text).not.toContain('provenance');

    // Override: a reason is mandatory; registration managers and strangers cannot; the reason stays private.
    const other = state.body?.units.find((u: Json) => u.unitKey !== unit.unitKey)?.targets[0]
      ?.target;
    const body = {
      target: other,
      participantId: lanes[1],
      reason: 'organizer decision after a protest',
    };
    expect(
      (
        await call(
          'POST',
          `/v1/events/${eventId}/advancement/overrides`,
          { ...manager.h, ...idem() },
          body,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          'POST',
          `/v1/events/${eventId}/advancement/overrides`,
          { ...A.h, ...idem() },
          { ...body, reason: '' },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          'POST',
          `/v1/events/${eventId}/advancement/overrides`,
          { ...A.h, ...idem() },
          body,
        )
      ).status,
    ).toBe(200);
    const history = await call(
      'GET',
      `/v1/events/${eventId}/advancement/history?contest=${other.contestId}&slot=${other.slot}`,
      A.h,
    );
    expect(history.status, history.text).toBe(200);
    expect(history.body?.facts[0]?.decision).toMatchObject({
      kind: 'OVERRIDE',
      reason: 'organizer decision after a protest',
    });
    expect(
      (
        await call(
          'GET',
          `/v1/events/${eventId}/advancement/history?contest=${other.contestId}&slot=${other.slot}`,
          stranger.h,
        )
      ).status,
    ).toBe(403);
    expect(
      (await call('GET', `/v1/competitions/${A.slug}/events/singles/bracket`)).text,
    ).not.toContain('protest');
    expect(
      (
        await call(
          'POST',
          `/v1/events/${eventId}/advancement/overrides/revoke`,
          { ...A.h, ...idem() },
          { target: other, reason: 'protest withdrawn' },
        )
      ).status,
    ).toBe(200);
    // A fixed (seeded) slot is never an advancement target.
    expect(
      (
        await call(
          'POST',
          `/v1/events/${eventId}/advancement/overrides`,
          { ...A.h, ...idem() },
          { target: { contestId: sf1.contestId, slot: 1 }, participantId: lanes[1], reason: 'x' },
        )
      ).status,
    ).toBe(400);
  }, 400_000);

  it('query parameters are strings on this API: a numeric query value is accepted and parsed (incl. 05C throughRound)', async () => {
    const A = await organizer('o5d-q');
    const ev = await call(
      'POST',
      `/v1/competitions/${A.competitionId}/events`,
      { ...A.h, ...idem() },
      {
        slug: 'q',
        disciplineVersionId: v['tennis@2'],
        formatVersionId: v['se'],
        settings: { name: 'Q', category: { genderCategory: 'OPEN' } },
      },
    );
    const eventId = ev.body?.eventId as string;
    // No pin: the classification is refused for that reason — not for a query type error.
    const r = await call(
      'GET',
      `/v1/events/${eventId}/stages/s1/classification?throughRound=2`,
      A.h,
    );
    expect(r.text).not.toContain('querystring');
    expect(
      (await call('GET', `/v1/events/${eventId}/stages/s1/classification?throughRound=abc`, A.h))
        .status,
    ).toBe(400);
  });

  it('the route inventory has no arbitrary slot / advancement mutation surface', () => {
    const routes = app.v1Routes.filter((r) =>
      /advancement|results|result-versions\/:resultVersionId\/(accept|declare)/.test(r.url),
    );
    expect(routes.map((r) => `${r.method} ${r.url}`).sort()).toEqual(
      [
        'GET /v1/events/:eventId/advancement',
        'GET /v1/events/:eventId/advancement/history',
        'POST /v1/events/:eventId/advancement/commit',
        'POST /v1/events/:eventId/advancement/overrides',
        'POST /v1/events/:eventId/advancement/overrides/revoke',
        'GET /v1/contests/:contestId/results',
        'POST /v1/contests/:contestId/results',
        'POST /v1/contests/:contestId/results/corrections',
        'POST /v1/result-versions/:resultVersionId/accept',
        'POST /v1/result-versions/:resultVersionId/declare-official',
      ].sort(),
    );
    expect(
      // ONCF-05E-C schedule assignments (where / when) are not slot or advancement assignments.
      app.v1Routes.filter(
        (r) =>
          /slot|assignment/i.test(r.url) &&
          !r.url.startsWith('/v1/schedule-versions/') &&
          r.method !== 'GET',
      ),
    ).toEqual([]);
    expect(
      app.v1Routes.filter(
        (r) => /advancement|results/.test(r.url) && ['PUT', 'PATCH', 'DELETE'].includes(r.method),
      ),
    ).toEqual([]);
  });
});
