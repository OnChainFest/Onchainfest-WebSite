import {
  ADVANCEMENT_POLICY_TEMPLATES,
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
import { CLASSIFICATION_TEMPLATES } from '@br/rankings';
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
  v['op'] = op;
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
        {
          code: `gk-${tag}`,
          name: 'Groups knockout',
          versions: [{ engineId: 'groups-knockout', engineVersion: 1 }],
        },
      ],
      rulesets: RULESET_TEMPLATES.filter((t) => t.code === 'sets-bo3-tiebreak').map((t) => ({
        code: `q${tag}-${t.code}`,
        name: t.name,
        versions: [{ spec: t.spec, basis: t.basis }],
      })),
      advancementPolicies: [
        ...ADVANCEMENT_POLICY_TEMPLATES.map((t) => ({
          code: t.code,
          name: t.name,
          versions: [{ spec: t.spec, basis: t.basis }],
        })),
        // D-13B: a version owned by this file alone, retired after it is pinned.
        ...ADVANCEMENT_POLICY_TEMPLATES.filter((t) => t.code === 'official-confirmed').map((t) => ({
          code: `r${tag}-retired`,
          name: t.name,
          versions: [{ spec: t.spec, basis: t.basis }],
        })),
      ],
      schedulingProfiles: SCHEDULING_PROFILE_TEMPLATES.filter(
        (t) => t.code === 'tennis-court-match',
      ).map((t) => ({
        code: `s${tag}-${t.code}`,
        name: t.name,
        versions: [{ spec: t.spec, basis: t.basis }],
      })),
    },
    classificationTemplates: CLASSIFICATION_TEMPLATES.filter((t) =>
      ['itf_rr', 'ibf_bowling_rr'].includes(t.code),
    ).map((t) => ({
      code: `c${tag}_${t.code}`,
      name: t.name,
      versions: [{ spec: t.spec, basis: t.basis }],
    })),
  });
  expect(report.conflicts).toEqual([]);
  const listed = await new CompetitionReader(db).catalog();
  for (const d of listed.disciplineVersions)
    if (d.discipline.code === `w${tag}.tennis`) v['tennis'] = d.disciplineVersionId;
  for (const f of listed.formatVersions)
    if (f.format.code === `se-${tag}`) v['se'] = f.formatVersionId;
    else if (f.format.code === `gk-${tag}`) v['gk'] = f.formatVersionId;
  for (const r of listed.rulesetVersions)
    if (r.code === `q${tag}-sets-bo3-tiebreak`) v['rs'] = r.versionId;
  for (const p of listed.advancementPolicyVersions)
    if (p.code === 'official-confirmed') v['ap'] = p.versionId;
    else if (p.code === 'groups-wins-games') v['apGroups'] = p.versionId;
    else if (p.code === `r${tag}-retired`) v['apRetired'] = p.versionId;
  for (const t of listed.classificationTemplateVersions)
    if (t.code === `c${tag}_itf_rr`) v['ctItf'] = t.versionId;
    else if (t.code === `c${tag}_ibf_bowling_rr`) v['ctBowling'] = t.versionId;
  for (const p of listed.schedulingProfileVersions)
    if (p.code.startsWith(`s${tag}-`)) v['sp'] = p.versionId;
}, 240_000);

type Org = Awaited<ReturnType<typeof organizer>>;

/** Synthetic scored category; the default two-player final remains policy-free. */
async function category(
  A: Org,
  eventSlug: string,
  options: {
    count?: number;
    policy?: boolean;
    lock?: boolean;
    scoring?: boolean;
    /** D-13B: groups → knockout instead of the default single elimination. */
    groups?: Record<string, unknown>;
    /** Scoring fields replacing the default pin body (ruleset is always set). */
    pin?: Record<string, unknown>;
    /** Confirmed entries when fewer than the capacity (`count`). */
    registered?: number;
    /** false: stop with registration still open. */
    close?: boolean;
  } = {},
) {
  const ev = await call(
    'POST',
    `/v1/competitions/${A.competitionId}/events`,
    { ...A.h, ...idem() },
    {
      slug: eventSlug,
      disciplineVersionId: v['tennis'],
      formatVersionId: options.groups === undefined ? v['se'] : v['gk'],
      formatConfig: options.groups ?? {},
      settings: {
        name: `Singles ${eventSlug}`,
        capacity: options.count ?? 2,
        category: { genderCategory: 'OPEN' },
      },
    },
  );
  expect(ev.status, ev.text).toBe(201);
  const eventId = ev.body?.eventId as string;
  if (options.scoring !== false) {
    const pinned = await call(
      'PUT',
      `/v1/events/${eventId}/scoring`,
      { ...A.h, ...idem() },
      {
        rulesetVersionId: v['rs'],
        ...(options.pin ?? {
          schedulingProfileVersionId: v['sp'],
          ...(options.policy ? { advancementPolicyVersionId: v['ap'] } : {}),
        }),
      },
    );
    expect(pinned.status, pinned.text).toBe(200);
  }
  expect((await call('POST', `/v1/events/${eventId}/open-registration`, A.h)).status).toBe(200);
  for (let i = 0; i < (options.registered ?? options.count ?? 2); i++) {
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
  if (options.close === false) return { eventId, contestId: '', players: [] as string[] };
  expect((await call('POST', `/v1/events/${eventId}/close-registration`, A.h)).status).toBe(200);
  if (options.lock === false) return { eventId, contestId: '', players: [] as string[] };
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
let playOrdinal = 0;
async function play(A: Org, contestId: string) {
  const { resourceId } = await resources.createResource({
    actorAccountId: A.accountId,
    competitionId: A.competitionId,
    typeCode: 'TENNIS_COURT',
    // Labels are unique per competition; a UUIDv7 prefix is a timestamp and collides within a test.
    resource: { label: `Court ${playOrdinal + 1}` },
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
      startsAt: `2027-07-01T${String(10 + 3 * playOrdinal++).padStart(2, '0')}:00:00Z`,
    },
    expectedLastFactId: null,
    idempotencyKey: k(),
  });
  const r = await schedule.validate({ actorAccountId: A.accountId, versionId });
  expect(r.conflicts.filter((c) => c.severity === 'HARD')).toEqual([]);
  await schedule.publish({
    actorAccountId: A.accountId,
    versionId,
    baseVersionId:
      (
        await sql<{
          id: string;
        }>`SELECT version_id AS id FROM competition.v_schedule_version_current WHERE competition_id = ${A.competitionId} AND status = 'PUBLISHED'`.execute(
          owner,
        )
      ).rows[0]?.id ?? null,
    reportHash: r.reportHash,
    acknowledgedConflictKeys: r.conflicts
      .filter((c) => c.severity === 'SOFT')
      .map((c) => c.conflictKey),
    idempotencyKey: k(),
  });
  expect((await call('POST', `/v1/contests/${contestId}/start`, A.h)).status).toBe(200);
  expect((await call('POST', `/v1/contests/${contestId}/complete`, A.h)).status).toBe(200);
}

/** The organizer's own PERSON principal holds the four result capabilities (fixture anchor). */
async function grant(A: Org) {
  const principal = await call('POST', `/v1/persons/${A.personId}/principal`, A.h);
  expect(principal.status, principal.text).toBe(200);
  const platform = await authority.registerPrincipal({
    principalType: 'PLATFORM',
    label: 'platform (L6 api)',
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
  // Authority is evaluated as of the transaction time (the database clock), which the local
  // Docker clock has been measured stepping back by up to ~1.5 s: wait until it is safely past
  // the principal's and grant's recording before the first use (no assertion is relaxed).
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

describe('D-13 advancement preflight API and four-player tennis acceptance', () => {
  it('refuses field lock without advancement and writes no field facts', async () => {
    const A = await organizer('p04-refuse');
    const { eventId } = await category(A, 'singles', { count: 4, lock: false });
    const facts = async () =>
      (
        await sql`SELECT
      (SELECT count(*)::int FROM competition.participant WHERE event_id = ${eventId}) AS participants,
      (SELECT count(*)::int FROM competition.event_field WHERE event_id = ${eventId}) AS fields,
      (SELECT count(*)::int FROM competition.event_status_change WHERE event_id = ${eventId}) AS statuses,
      (SELECT count(*)::int FROM platform.outbox_event WHERE aggregate_id = ${eventId}) AS outbox`.execute(
          owner,
        )
      ).rows;
    const baseline = await facts();
    const before = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM competition.participant WHERE event_id = ${eventId}`.execute(
      owner,
    );
    const key = idem();
    for (let i = 0; i < 2; i++) {
      const refused = await call('POST', `/v1/events/${eventId}/lock-field`, { ...A.h, ...key });
      expect(refused.status).toBe(409);
      expect(refused.body?.error.reason).toBe('ADVANCEMENT_POLICY_REQUIRED');
    }
    expect(
      (
        await sql<{
          n: number;
        }>`SELECT count(*)::int AS n FROM competition.participant WHERE event_id = ${eventId}`.execute(
          owner,
        )
      ).rows,
    ).toEqual(before.rows);
    expect(
      (await sql`SELECT 1 FROM competition.event_field WHERE event_id = ${eventId}`.execute(owner))
        .rows,
    ).toEqual([]);
    expect(await facts()).toEqual(baseline);
    const ready = await call('GET', `/v1/events/${eventId}/readiness`, A.h);
    expect(ready.body?.advancement.required).toBe(true);
    expect(ready.body?.advancement.defaultPolicyVersionId).toBe(v['ap']);
    expect(ready.body?.blockers).toContain('ADVANCEMENT_POLICY_REQUIRED');
  });

  it('refuses a dependent field without scoring before any participant is created', async () => {
    const A = await organizer('p04-scoring');
    const { eventId } = await category(A, 'singles', { count: 4, lock: false, scoring: false });
    const result = await call('POST', `/v1/events/${eventId}/lock-field`, { ...A.h, ...idem() });
    expect(result.status).toBe(409);
    expect(result.body?.error.reason).toBe('SCORING_NOT_PINNED');
    expect(
      (await sql`SELECT 1 FROM competition.participant WHERE event_id = ${eventId}`.execute(owner))
        .rows,
    ).toEqual([]);
  });

  it('refuses a group-comparison policy at pin time and leaves the pin unchanged', async () => {
    const A = await organizer('p04-policy');
    const { eventId } = await category(A, 'singles', { count: 4, lock: false });
    const catalog = await new CompetitionReader(db).catalog();
    const incompatible = catalog.advancementPolicyVersions.find(
      (p) => p.code === 'groups-wins-games',
    )!;
    const result = await call(
      'PUT',
      `/v1/events/${eventId}/scoring`,
      { ...A.h, ...idem() },
      { rulesetVersionId: v['rs'], advancementPolicyVersionId: incompatible.versionId },
    );
    expect(result.status).toBe(400);
    expect(result.body?.error.reason).toBe('ADVANCEMENT_POLICY_INCOMPATIBLE');
    const pin = await call('GET', `/v1/events/${eventId}/scoring`, A.h);
    expect(pin.body?.advancementPolicy).toBeNull();
  });

  it('serializes pin versus lock in both orders, with replay and database read-back', async () => {
    type Reply = Awaited<ReturnType<typeof call>>;
    for (const pinFirst of [true, false]) {
      for (let run = 0; run < Number(process.env['ONCF_P04_RACE_RUNS'] ?? '2'); run++) {
        const A = await organizer(`p04-race-${pinFirst}-${run}`);
        const { eventId } = await category(A, 'singles', { count: 4, lock: false });
        const pin = () =>
          call(
            'PUT',
            `/v1/events/${eventId}/scoring`,
            { ...A.h, ...idem() },
            {
              rulesetVersionId: v['rs'],
              schedulingProfileVersionId: v['sp'],
              advancementPolicyVersionId: v['ap'],
            },
          );
        const lockKey = idem();
        const lock = () => call('POST', `/v1/events/${eventId}/lock-field`, { ...A.h, ...lockKey });
        const key = `event-structure:${eventId}`;
        let pending: Promise<Reply[]> | undefined;
        let queued = 0;
        await owner.transaction().execute(async (trx) => {
          await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(trx);
          const waitFor = async (n: number) => {
            for (let attempt = 0; attempt < 400; attempt++) {
              const row = (
                await sql<{
                  n: number;
                }>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(${key}, 0)`.execute(
                  trx,
                )
              ).rows[0];
              if ((row?.n ?? 0) >= n) {
                queued++;
                return;
              }
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          };
          const a = pinFirst ? pin() : lock();
          await waitFor(1);
          const b = pinFirst ? lock() : pin();
          await waitFor(2);
          pending = Promise.all([a, b]);
        });
        const result = await pending!;
        expect(queued).toBe(2);
        expect(result.map((r) => r.status)).toEqual(pinFirst ? [200, 200] : [409, 200]);
        // A refused request did not record success; it can succeed after configuration is fixed.
        const replay = await lock();
        expect(replay.status).toBe(200);
        expect(replay.body?.fieldHash).toMatch(/^sha256:/);
        expect((await lock()).body?.fieldHash).toBe(replay.body?.fieldHash);
        const state = await sql<{ participants: number; fields: number }>`SELECT
          (SELECT count(*)::int FROM competition.participant WHERE event_id = ${eventId}) AS participants,
          (SELECT count(*)::int FROM competition.event_field WHERE event_id = ${eventId}) AS fields`.execute(
          owner,
        );
        expect(state.rows).toEqual([{ participants: 4, fields: 1 }]);
        const frozen = await pin();
        expect(frozen.status).toBe(409);
      }
    }
  }, 900_000);

  it('preserves the policy-free two-player final', async () => {
    const A = await organizer('p04-two');
    const { eventId } = await category(A, 'singles');
    const ready = await call('GET', `/v1/events/${eventId}/readiness`, A.h);
    expect(ready.status).toBe(200);
    expect(ready.body?.fieldLocked).toBe(true);
    expect(ready.body?.advancement.required).toBe(false);
    expect(ready.body?.advancement.defaultPolicyVersionId).toBeNull();
  });

  it('completes synthetic four-player tennis from registration through public final standings', async () => {
    const A = await organizer('p04-journey');
    const { eventId } = await category(A, 'singles', { count: 4, policy: true });
    await grant(A);
    const bracketPath = `/v1/competitions/${A.slug}/events/singles/bracket`;
    const bracket = await call('GET', bracketPath);
    const semis = bracket.body?.rounds[0].contests as Json[];
    expect(semis).toHaveLength(2);
    const official = async (contestId: string) => {
      await play(A, contestId);
      const sub = await call(
        'POST',
        `/v1/contests/${contestId}/results`,
        { ...A.h, ...idem() },
        { sheet, recognitionLevel: 'PLATFORM' },
      );
      expect(sub.status, sub.text).toBe(200);
      for (const step of ['accept', 'declare-official']) {
        const result = await call(
          'POST',
          `/v1/result-versions/${sub.body?.resultVersionId}/${step}`,
          { ...A.h, ...idem() },
          { recognitionLevel: 'PLATFORM' },
        );
        expect(result.status, result.text).toBe(200);
      }
    };
    for (const semi of semis) await official(semi.contestId as string);
    const preview = await call('GET', `/v1/events/${eventId}/advancement`, A.h);
    const units = (preview.body?.units as Json[]).filter((u) =>
      semis.some((s) => u.unitKey === `contest:${s.contestId}`),
    );
    expect(units).toHaveLength(2);
    const committed = await call(
      'POST',
      `/v1/events/${eventId}/advancement/commit`,
      { ...A.h, ...idem() },
      { units: units.map((u) => ({ unitKey: u.unitKey, previewHash: u.previewHash })) },
    );
    expect(committed.status, committed.text).toBe(200);
    const finalBracket = await call('GET', bracketPath);
    const final = finalBracket.body?.rounds[1].contests[0] as Json;
    expect(final.slots.every((s: Json) => typeof s.participantId === 'string')).toBe(true);
    await official(final.contestId as string);
    for (const path of [`events/${eventId}`, `competitions/${A.competitionId}`]) {
      const done = await call('POST', `/v1/${path}/complete`, A.h);
      expect(done.status, done.text).toBe(200);
    }
    const outcome = await call('GET', `/v1/competitions/${A.slug}/events/singles/outcome`);
    expect(outcome.status).toBe(200);
    expect(outcome.body?.final).toBe(true);
    expect(outcome.body?.matches).toHaveLength(3);
    expect(outcome.body?.matches.every((m: Json) => m.official)).toBe(true);
    expect(outcome.body?.podium.status).toBe('AVAILABLE');
    expect(outcome.body?.podium.placements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          participantId: final.slots[0].participantId,
          position: 1,
          tied: false,
        }),
        expect.objectContaining({
          participantId: final.slots[1].participantId,
          position: 2,
          tied: false,
        }),
      ]),
    );
    const tournamentOutcome = await call('GET', `/v1/competitions/${A.slug}/outcome`);
    expect(tournamentOutcome.status).toBe(200);
    expect(tournamentOutcome.body?.schema).toBe('br:public-competition-outcome@1');
    const frozen = await call(
      'POST',
      `/v1/contests/${final.contestId}/results`,
      { ...A.h, ...idem() },
      { sheet, recognitionLevel: 'PLATFORM' },
    );
    expect(frozen.status).toBe(409);
    expect(frozen.body?.error.reason).toBe('RESULTS_FROZEN');
  }, 180_000);
});

describe('D-13B ranked-stage classification, retired pins and exact lock readiness', () => {
  const participants = async (eventId: string) =>
    (
      await sql<{
        n: number;
      }>`SELECT count(*)::int AS n FROM competition.participant WHERE event_id = ${eventId}`.execute(
        owner,
      )
    ).rows[0]?.n;
  const refusedLock = async (A: Org, eventId: string, reason: string) => {
    const refused = await call('POST', `/v1/events/${eventId}/lock-field`, { ...A.h, ...idem() });
    expect(refused.status, refused.text).toBe(409);
    expect(refused.body?.error.reason).toBe(reason);
    expect(await participants(eventId)).toBe(0);
  };
  const lock = async (A: Org, eventId: string, n: number) => {
    const locked = await call('POST', `/v1/events/${eventId}/lock-field`, { ...A.h, ...idem() });
    expect(locked.status, locked.text).toBe(200);
    expect(await participants(eventId)).toBe(n);
  };
  const repin = async (A: Org, eventId: string, body: Record<string, unknown>) => {
    const pinned = await call(
      'PUT',
      `/v1/events/${eventId}/scoring`,
      { ...A.h, ...idem() },
      { rulesetVersionId: v['rs'], ...body },
    );
    expect(pinned.status, pinned.text).toBe(200);
  };

  it('refuses a ranked group stage without a classification template, then locks with a stage override', async () => {
    const A = await organizer('p04b-template');
    const { eventId } = await category(A, 'groups', {
      count: 4,
      lock: false,
      groups: { groupCount: 2, qualifiersPerGroup: 1 },
      pin: { advancementPolicyVersionId: v['ap'] },
    });
    const ready = await call('GET', `/v1/events/${eventId}/readiness`, A.h);
    expect(ready.body?.advancement.countBasis).toBe('EXACT');
    expect(ready.body?.advancement.required).toBe(true);
    expect(ready.body?.blockers).toContain('CLASSIFICATION_TEMPLATE_REQUIRED');
    await refusedLock(A, eventId, 'CLASSIFICATION_TEMPLATE_REQUIRED');
    // The ranked stage's own override satisfies the dependency without an event-wide template.
    await repin(A, eventId, {
      advancementPolicyVersionId: v['ap'],
      stageOverrides: { s1: { classificationTemplateVersionId: v['ctItf'] } },
    });
    const fixed = await call('GET', `/v1/events/${eventId}/readiness`, A.h);
    expect(fixed.body?.advancement.blockers).toEqual([]);
    await lock(A, eventId, 4);
  }, 180_000);

  it('checks the cross-group order against the effective stage override, not the event template', async () => {
    const A = await organizer('p04b-override');
    const { eventId } = await category(A, 'groups', {
      count: 6,
      lock: false,
      groups: { groupCount: 3, qualifiersPerGroup: 1, bestRankedExtra: 1 },
      pin: {
        classificationTemplateVersionId: v['ctItf'],
        advancementPolicyVersionId: v['apGroups'],
        stageOverrides: { s1: { classificationTemplateVersionId: v['ctBowling'] } },
      },
    });
    await refusedLock(A, eventId, 'CLASSIFICATION_TEMPLATE_INCOMPATIBLE');
    await repin(A, eventId, {
      classificationTemplateVersionId: v['ctItf'],
      advancementPolicyVersionId: v['apGroups'],
    });
    await lock(A, eventId, 6);
  }, 180_000);

  it('keeps an already-pinned policy usable after retirement and refuses it as a new selection', async () => {
    const A = await organizer('p04b-retired');
    const { eventId } = await category(A, 'singles', {
      count: 4,
      lock: false,
      pin: { schedulingProfileVersionId: v['sp'], advancementPolicyVersionId: v['apRetired'] },
    });
    await new CatalogStore(operator).setScoringVersionStatus({
      operatorAccountId: v['op'] as string,
      kind: 'advancement-policy',
      versionId: v['apRetired'] as string,
      status: 'RETIRED',
    });
    const ready = await call('GET', `/v1/events/${eventId}/readiness`, A.h);
    expect(ready.body?.advancement.countBasis).toBe('EXACT');
    // A direct knockout ranks no stage: no classification template is needed.
    expect(ready.body?.advancement.blockers).toEqual([]);
    expect(ready.body?.advancement.compatiblePolicyVersionIds).not.toContain(v['apRetired']);
    const B = await organizer('p04b-retired-new');
    const fresh = await category(B, 'singles', { count: 4, lock: false, scoring: false });
    const selected = await call(
      'PUT',
      `/v1/events/${fresh.eventId}/scoring`,
      { ...B.h, ...idem() },
      { rulesetVersionId: v['rs'], advancementPolicyVersionId: v['apRetired'] },
    );
    expect(selected.status).toBe(400);
    await lock(A, eventId, 4);
  }, 180_000);

  it('assesses lock readiness on the exact confirmed field once registration closes', async () => {
    const A = await organizer('p04b-exact');
    const { eventId } = await category(A, 'singles', {
      count: 4,
      registered: 1,
      lock: false,
      close: false,
      policy: true,
    });
    // Before close the preflight is setup guidance from a feasible estimate, never lock-ready.
    const open = await call('GET', `/v1/events/${eventId}/readiness`, A.h);
    expect(open.body?.advancement.countBasis).toBe('ESTIMATE');
    expect(open.body?.advancement.blockers).not.toContain('ADVANCEMENT_PLAN_INVALID');
    expect((await call('POST', `/v1/events/${eventId}/close-registration`, A.h)).status).toBe(200);
    const closed = await call('GET', `/v1/events/${eventId}/readiness`, A.h);
    expect(closed.body?.advancement.countBasis).toBe('EXACT');
    expect(closed.body?.advancement.participantCount).toBe(1);
    expect(closed.body?.blockers).toContain('ADVANCEMENT_PLAN_INVALID');
    await refusedLock(A, eventId, 'ADVANCEMENT_PLAN_INVALID');
  }, 180_000);
});
