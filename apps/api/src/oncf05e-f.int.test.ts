import { configureAdvancementFixture } from '@br/testkit';
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
import { apiDb, newTestAccount, operatorDb, ownerDb, uniqueSlug } from '@br/testkit';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevTokenAuth, mintDevToken } from './auth';
import { buildServer } from './server';

// ONCF-05E-F API: the proposal COMMIT (ADR-0075 § 16–18, ADR-0076; ONCF-05E-F architecture §§ 22–23).
// COMP_MANAGE_SCHEDULE (OWNER, ADMIN, SCHEDULER), re-resolved at commit; an Idempotency-Key; the
// closed body carries only `proposalHash`, `scope` and `from`. The server recomputes the proposal:
// a hash mismatch is 409 PROPOSAL_STALE, a non-SUCCESS status 409 PROPOSAL_NOT_COMMITTABLE, and a
// SUCCESS proposal is appended to the open draft in one transaction (facts, outbox, audit). Commit
// never publishes. Every refusal is proven to write nothing with the competition's row snapshot.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form navigation of JSON responses
type Json = Record<string, any>;

const SECRET = 'oncf05e-f-api-int-secret-0123456789abcdef';
const db = apiDb();
const operator = operatorDb();
const owner = ownerDb();
const app = buildServer({
  db,
  operatorDb: operator,
  auth: (identity: IdentityStore) => createDevTokenAuth(identity, { secret: SECRET }),
});
afterAll(async () => {
  await app.close();
  await Promise.all([db.destroy(), operator.destroy(), owner.destroy()]);
});

const idem = (key = `k-${newId()}`) => ({ 'idempotency-key': key });
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

async function addStaff(o: Org, p: { personId: string }, role: string) {
  const r = await call(
    'POST',
    `/v1/competitions/${o.competitionId}/staff`,
    { ...o.h, ...idem() },
    { personId: p.personId, role },
  );
  expect(r.status, r.text).toBe(201);
  return r.body?.staffId as string;
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
          code: `w${tag}`,
          name: '05E-F API sport',
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

const WEEK = { startsAt: '2027-09-01T12:00:00Z', endsAt: '2027-09-08T12:00:00Z' };

/** A four-player tennis knockout with a court, declared hours and an open draft — all over HTTP. */
async function scheduledKnockout(o: Org, label: string, window = WEEK) {
  const ev = await call(
    'POST',
    `/v1/competitions/${o.competitionId}/events`,
    { ...o.h, ...idem() },
    {
      slug: 'singles',
      disciplineVersionId: v['tennis'],
      formatVersionId: v['se'],
      formatConfig: { drawSize: 4 },
      settings: { name: 'Singles', category: { genderCategory: 'OPEN' }, ...window },
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
  await configureAdvancementFixture(
    db,
    (await call('GET', '/v1/me', o.h)).body?.accountId as string,
    eventId,
  );
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

const previewUrl = (versionId: string) => `/v1/schedule-versions/${versionId}/proposals/preview`;
const commitUrl = (versionId: string) => `/v1/schedule-versions/${versionId}/proposals/commit`;

async function preview(o: Org, versionId: string, body: Json = {}) {
  const r = await call('POST', previewUrl(versionId), o.h, body);
  expect(r.status, r.text).toBe(200);
  return r.body?.proposal as Json;
}

/**
 * Every authoritative row a commit could touch for one competition, serialized by the database
 * itself (owner connection): versions and their status history, assignment facts, publications, the
 * public projection, resources, availability, contest / event / competition status, audit and
 * outbox entries naming any of them, and every idempotency record of the commit command.
 */
async function snapshot(competitionId: string) {
  const q = async (table: string, where: ReturnType<typeof sql>) => {
    const { rows } = await sql<{ j: string }>`
      SELECT coalesce(json_agg(t ORDER BY t::text), '[]')::text AS j
      FROM ${sql.raw(table)} t WHERE ${where}`.execute(owner);
    return rows[0]?.j as string;
  };
  const events = sql`(SELECT id FROM competition.event WHERE competition_id = ${competitionId})`;
  const contests = sql`(SELECT c.id FROM competition.contest c JOIN competition.event e ON e.id = c.event_id
                        WHERE e.competition_id = ${competitionId})`;
  const versions = sql`(SELECT id FROM competition.schedule_version WHERE competition_id = ${competitionId})`;
  const res = sql`(SELECT id FROM competition.resource WHERE competition_id = ${competitionId})`;
  const targets = sql`(SELECT ${competitionId}::uuid UNION ALL SELECT * FROM ${events} UNION ALL SELECT * FROM ${contests}
                       UNION ALL SELECT * FROM ${versions} UNION ALL SELECT * FROM ${res})`;
  const byComp = sql`t.competition_id = ${competitionId}`;
  return {
    schedule_version: await q('competition.schedule_version', byComp),
    schedule_version_status_change: await q(
      'competition.schedule_version_status_change',
      sql`t.version_id IN ${versions}`,
    ),
    schedule_assignment: await q('competition.schedule_assignment', byComp),
    schedule_publication: await q('competition.schedule_publication', byComp),
    contest_schedule: await q('competition.contest_schedule', sql`t.contest_id IN ${contests}`),
    resource_revision: await q('competition.resource_revision', sql`t.resource_id IN ${res}`),
    resource_availability: await q('competition.resource_availability', byComp),
    contest_status_change: await q(
      'competition.contest_status_change',
      sql`t.contest_id IN ${contests}`,
    ),
    event_status_change: await q('competition.event_status_change', sql`t.event_id IN ${events}`),
    competition_status_change: await q('competition.competition_status_change', byComp),
    audit_event: await q('platform.audit_event', sql`t.target_id IN ${targets}`),
    outbox_event: await q('platform.outbox_event', sql`t.aggregate_id IN ${targets}`),
    command_idempotency: await q(
      'platform.command_idempotency',
      sql`t.command_type = 'CommitScheduleProposal'`,
    ),
  };
}

const outboxOf = async (aggregateId: string) =>
  (
    await sql<{ event_type: string; payload: Json }>`
      SELECT event_type, payload FROM platform.outbox_event WHERE aggregate_id = ${aggregateId}
      ORDER BY recorded_at, event_type, payload::text`.execute(owner)
  ).rows;

const auditOf = async (action: string, targetId: string) =>
  (
    await sql<{ actor_account_id: string; details: Json; outcome: string }>`
      SELECT actor_account_id, details, outcome FROM platform.audit_event
      WHERE action = ${action} AND target_id = ${targetId}`.execute(owner)
  ).rows;

const idempotencyRows = async (key: string) =>
  (
    await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM platform.command_idempotency
      WHERE command_type = 'CommitScheduleProposal' AND idempotency_key = ${key}`.execute(owner)
  ).rows[0]?.n;

/** A REAL database failure inside the commit transaction (owner-created BEFORE INSERT trigger). */
async function withFault<T>(table: string, when: string, fn: () => Promise<T>): Promise<T> {
  const name = `oncf05e_f_api_fault_${newId().replace(/-/g, '').slice(-12)}`;
  await sql
    .raw(
      `CREATE FUNCTION platform.${name}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION 'injected fault ${name}'; END $$`,
    )
    .execute(owner);
  await sql
    .raw(
      `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW WHEN (${when})
       EXECUTE FUNCTION platform.${name}()`,
    )
    .execute(owner);
  try {
    return await fn();
  } finally {
    await sql.raw(`DROP TRIGGER ${name} ON ${table}`).execute(owner);
    await sql.raw(`DROP FUNCTION platform.${name}()`).execute(owner);
  }
}

/** A refusal body: a code, a fixed message and (only for the two proposal refusals) a reason. */
function expectRefusal(
  r: Awaited<ReturnType<typeof call>>,
  status: number,
  code: string,
  reason?: string,
) {
  expect(r.status, r.text).toBe(status);
  expect(r.body?.error.code).toBe(code);
  if (reason === undefined) expect(r.body?.error.reason).toBeUndefined();
  else expect(r.body?.error.reason).toBe(reason);
  expect(Object.keys(r.body as Json)).toEqual(['error']);
  expect(r.text).not.toMatch(/stack|select |insert |sql|pg_|postgres|injected fault/i);
}

const RESPONSE_FIELDS = [
  'assignmentIds',
  'baseStateIdentity',
  'competitionId',
  'created',
  'placedContests',
  'proposalHash',
  'versionId',
];

describe('ONCF-05E-F proposal commit over the API', () => {
  it('authorized SUCCESS commit: recomputed placements persisted with provenance, outbox and audit; every boundary refusal writes nothing', async () => {
    const A = await organizer('o5ef-a');
    const B = await organizer('o5ef-b');
    const stranger = await person('o5ef-stranger');
    const scheduler = await person('o5ef-scheduler');
    const manager = await person('o5ef-regman');
    await addStaff(A, scheduler, 'SCHEDULER');
    await addStaff(A, manager, 'REGISTRATION_MANAGER');
    const a = await scheduledKnockout(A, 'o5ef-a');
    const b = await scheduledKnockout(B, 'o5ef-b');

    const p = await preview(A, a.versionId);
    expect(p.status).toBe('SUCCESS');
    expect(p.placements).toHaveLength(3);
    const hash = p.proposalHash as string;
    const before = await snapshot(A.competitionId);

    // Malformed or incomplete requests: refused at the boundary (400) before the store runs.
    for (const [headers, payload, what] of [
      [{ ...A.h, ...idem() }, undefined, 'no body'],
      [{ ...A.h, ...idem() }, {}, 'no proposalHash'],
      [{ ...A.h, ...idem() }, { proposalHash: 'sha256:abc' }, 'short hash'],
      [{ ...A.h, ...idem() }, { proposalHash: hash.toUpperCase() }, 'non-canonical hash'],
      [{ ...A.h, ...idem() }, { proposalHash: 42 }, 'hash type'],
      [{ ...A.h, ...idem() }, { proposalHash: hash, scope: { eventIds: ['x'] } }, 'scope uuid'],
      [{ ...A.h, ...idem() }, { proposalHash: hash, scope: [] }, 'scope type'],
      [{ ...A.h, ...idem() }, { proposalHash: hash, from: 7 }, 'from type'],
      [{ ...A.h, ...idem() }, { proposalHash: hash, from: 'next tuesday morning' }, 'from'],
      [{ ...A.h, ...idem() }, { proposalHash: hash, from: '2027-09-02T09:00:00.250Z' }, 'from ms'],
      [A.h, { proposalHash: hash }, 'no Idempotency-Key'],
    ] as const) {
      const r = await call('POST', commitUrl(a.versionId), headers, payload);
      expect(r.status, `${what}: ${r.text}`).toBe(400);
      expect(r.body?.error.code, what).toBe('INVALID_INPUT');
    }
    expectRefusal(
      await call('POST', commitUrl('nope'), { ...A.h, ...idem() }, { proposalHash: hash }),
      400,
      'INVALID_INPUT',
    );
    // A foreign scope id is refused with a fixed message that never echoes it.
    const foreign = await call(
      'POST',
      commitUrl(a.versionId),
      { ...A.h, ...idem() },
      { proposalHash: hash, scope: { eventIds: [b.eventId] } },
    );
    expectRefusal(foreign, 400, 'INVALID_INPUT');
    expect(foreign.text).not.toContain(b.eventId);

    // Tampering: authoritative values next to a valid hash are refused by the closed schema,
    // never ignored and never written. Identity and actor come only from the server.
    for (const extra of [
      { placements: [{ contestId: a.contests[0]?.contestId, resourceId: a.courtId, start: 0 }] },
      { assignments: [{ contestId: a.contests[0]?.contestId, startsAt: '2027-09-03T08:00:00Z' }] },
      { resourceId: a.courtId },
      { startsAt: '2027-09-03T08:00:00Z' },
      { start: 0, end: 3600 },
      { expectedEnd: '2027-09-03T10:00:00Z' },
      { changeoverSeconds: 0 },
      { unitKey: 'u' },
      { status: 'SUCCESS' },
      { baseStateIdentity: p.baseStateIdentity },
      { competitionId: B.competitionId },
      { versionId: b.versionId },
      { organizationId: newId() },
      { actorAccountId: newId() },
      { budget: { maxEvaluations: 1 } },
      { strategy: { id: 'other', version: 9 } },
      { scope: { contestIds: [a.contests[0]?.contestId] } },
    ]) {
      const r = await call(
        'POST',
        commitUrl(a.versionId),
        { ...A.h, ...idem() },
        { proposalHash: hash, ...extra },
      );
      expect(r.status, `${JSON.stringify(extra)} ${r.text}`).toBe(400);
    }

    // Authentication and authorization at the commit boundary (COMP_MANAGE_SCHEDULE).
    expectRefusal(
      await call('POST', commitUrl(a.versionId), idem(), { proposalHash: hash }),
      401,
      'UNAUTHENTICATED',
    );
    for (const h of [manager.h, stranger.h, B.h])
      expectRefusal(
        await call('POST', commitUrl(a.versionId), { ...h, ...idem() }, { proposalHash: hash }),
        403,
        'FORBIDDEN',
      );
    // Another organization's version reads as forbidden; an unknown version is not found.
    expectRefusal(
      await call('POST', commitUrl(b.versionId), { ...A.h, ...idem() }, { proposalHash: hash }),
      403,
      'FORBIDDEN',
    );
    expectRefusal(
      await call('POST', commitUrl(newId()), { ...A.h, ...idem() }, { proposalHash: hash }),
      404,
      'NOT_FOUND',
    );
    // Hash mismatch: another proposal's hash, a fabricated one, or the right hash with other
    // request parameters (they are part of the identity) — all PROPOSAL_STALE, never a write.
    const pb = await preview(B, b.versionId);
    for (const payload of [
      { proposalHash: pb.proposalHash },
      { proposalHash: `sha256:${'f'.repeat(64)}` },
      { proposalHash: hash, from: '2027-09-02T09:00:00Z' },
      { proposalHash: hash, scope: { eventIds: [a.eventId] } },
    ]) {
      const r = await call('POST', commitUrl(a.versionId), { ...A.h, ...idem() }, payload);
      expectRefusal(r, 409, 'CONCURRENCY_CONFLICT', 'PROPOSAL_STALE');
      expect(r.text).not.toContain(payload.proposalHash);
    }
    expect(await snapshot(A.competitionId)).toEqual(before);

    // SUCCESS by the organizer: exactly the defined public fields.
    const key = `k-${newId()}`;
    const ok = await call(
      'POST',
      commitUrl(a.versionId),
      { ...A.h, ...idem(key) },
      {
        proposalHash: hash,
      },
    );
    expect(ok.status, ok.text).toBe(200);
    expect(Object.keys(ok.body as Json).sort()).toEqual(RESPONSE_FIELDS);
    const sortedContests = a.contests.map((c) => c.contestId as string).sort();
    expect(ok.body).toMatchObject({
      versionId: a.versionId,
      competitionId: A.competitionId,
      proposalHash: hash,
      baseStateIdentity: p.baseStateIdentity,
      placedContests: 3,
      created: true,
    });
    const assignmentIds = ok.body?.assignmentIds as { contestId: string; assignmentId: string }[];
    expect(assignmentIds.map((x) => x.contestId)).toEqual(sortedContests);
    for (const x of assignmentIds)
      expect(Object.keys(x).sort()).toEqual(['assignmentId', 'contestId']);

    // Persisted: the draft's facts are the server's placements, MANUAL, reason `proposal <hash>`.
    const version = await call('GET', `/v1/schedule-versions/${a.versionId}`, A.h);
    expect(version.status, version.text).toBe(200);
    expect(version.body?.status).toBe('DRAFT');
    const actor = version.body?.statusHistory[0].actorAccountId as string;
    const facts = version.body?.assignments as Json[];
    expect(facts.map((f) => f.contestId).sort()).toEqual(sortedContests);
    for (const f of facts) {
      const x = (p.placements as Json[]).find((y) => y.contestId === f.contestId) as Json;
      expect(f).toMatchObject({
        assignmentId: assignmentIds.find((y) => y.contestId === f.contestId)?.assignmentId,
        versionId: a.versionId,
        resourceId: a.courtId,
        startsAt: new Date(x.start * 1000).toISOString(),
        expectedEnd: new Date(x.expectedEnd * 1000).toISOString(),
        changeoverSeconds: x.changeoverSeconds,
        zone: x.zone,
        unitKey: x.unitKey,
        provisional: x.provisional,
        locked: false,
        removed: false,
        source: 'MANUAL',
        reason: `proposal ${hash}`,
        actorAccountId: actor,
      });
    }

    // Outbox: one ScheduleAssignmentChanged per fact and one ScheduleProposalCommitted.
    const outbox = await outboxOf(a.versionId);
    expect(
      outbox
        .filter((e) => e.event_type === 'ScheduleAssignmentChanged')
        .map((e) => e.payload)
        .sort((x, y) => String(x.contestId).localeCompare(String(y.contestId))),
    ).toEqual(assignmentIds.map((x) => ({ ...x, action: 'SET' })));
    const committed = outbox.filter((e) => e.event_type === 'ScheduleProposalCommitted');
    expect(committed.map((e) => e.payload)).toEqual([
      {
        competitionId: A.competitionId,
        proposalHash: hash,
        baseStateIdentity: p.baseStateIdentity,
        strategy: PROPOSAL_STRATEGY,
        budget: PROPOSAL_BUDGET,
        reportHash: p.report.reportHash,
        placedUnits: 3,
        placedContests: 3,
        unplacedUnits: 0,
        assignments: assignmentIds,
      },
    ]);
    // Audit: the commit entry by the authenticated actor (never a body value).
    expect(await auditOf('schedule.proposal-committed', a.versionId)).toEqual([
      expect.objectContaining({
        actor_account_id: actor,
        outcome: 'SUCCEEDED',
        details: expect.objectContaining({ proposalHash: hash }),
      }),
    ]);
    for (const c of a.contests)
      expect(await auditOf('schedule.assignment-set', c.contestId as string)).toHaveLength(1);
    expect(await idempotencyRows(key)).toBe(1);

    // Commit is not publication: no projection, no contest status, no public schedule.
    const afterCommit = await snapshot(A.competitionId);
    for (const t of [
      'contest_schedule',
      'contest_status_change',
      'schedule_version',
      'schedule_version_status_change',
      'schedule_publication',
    ] as const)
      expect(afterCommit[t], t).toEqual(before[t]);

    // Retry with the same key (a lost response): the stored response, nothing written.
    const replay = await call(
      'POST',
      commitUrl(a.versionId),
      { ...A.h, ...idem(key) },
      {
        proposalHash: hash,
      },
    );
    expect(replay.status, replay.text).toBe(200);
    expect(replay.body).toEqual({ ...ok.body, created: false });
    // The same key with other parameters is refused; a new key is stale (the watermark moved).
    expectRefusal(
      await call(
        'POST',
        commitUrl(a.versionId),
        { ...A.h, ...idem(key) },
        { proposalHash: hash, scope: { eventIds: [a.eventId] } },
      ),
      409,
      'IDEMPOTENCY_KEY_REUSED',
    );
    expectRefusal(
      await call('POST', commitUrl(a.versionId), { ...A.h, ...idem() }, { proposalHash: hash }),
      409,
      'CONCURRENCY_CONFLICT',
      'PROPOSAL_STALE',
    );
    // Everything is placed now: NOTHING_TO_PLACE, a matching hash, but not committable.
    const nothing = await preview(A, a.versionId);
    expect(nothing.status).toBe('NOTHING_TO_PLACE');
    const nkey = `k-${newId()}`;
    const nr = await call(
      'POST',
      commitUrl(a.versionId),
      { ...A.h, ...idem(nkey) },
      {
        proposalHash: nothing.proposalHash,
      },
    );
    expectRefusal(nr, 409, 'INVALID_TRANSITION', 'PROPOSAL_NOT_COMMITTABLE');
    expect(await idempotencyRows(nkey)).toBe(0);
    expect(await snapshot(A.competitionId)).toEqual(afterCommit);

    // Published state is immutable: once this draft is published, it cannot be committed into.
    const report = await call('POST', `/v1/schedule-versions/${a.versionId}/validate`, A.h);
    expect(report.status, report.text).toBe(200);
    expect(report.body?.hardConflicts).toBe(0);
    const pub = await call(
      'POST',
      `/v1/schedule-versions/${a.versionId}/publish`,
      { ...A.h, ...idem() },
      {
        baseVersionId: version.body?.baseVersionId ?? null,
        reportHash: report.body?.reportHash,
        acknowledgedConflictKeys: (report.body?.conflicts as Json[])
          .filter((c) => c.severity === 'SOFT')
          .map((c) => c.conflictKey),
      },
    );
    expect(pub.status, pub.text).toBe(200);
    const published = await snapshot(A.competitionId);
    expectRefusal(
      await call(
        'POST',
        commitUrl(a.versionId),
        { ...A.h, ...idem() },
        {
          proposalHash: nothing.proposalHash,
        },
      ),
      409,
      'INVALID_TRANSITION',
    );
    expect(await snapshot(A.competitionId)).toEqual(published);

    // B's own preview still commits: nothing A did, or was refused, touched B's competition.
    const bh = await call(
      'POST',
      commitUrl(b.versionId),
      { ...B.h, ...idem() },
      {
        proposalHash: pb.proposalHash,
      },
    );
    expect(bh.status, bh.text).toBe(200);
  }, 900_000);

  it('a SCHEDULER commits; authorization is re-resolved at commit — revoked after preview is 403', async () => {
    const A = await organizer('o5ef-auth');
    const keep = await person('o5ef-keep');
    const lose = await person('o5ef-lose');
    await addStaff(A, keep, 'SCHEDULER');
    const loseStaff = await addStaff(A, lose, 'SCHEDULER');
    const a = await scheduledKnockout(A, 'o5ef-auth');

    // The revoked scheduler previewed while still authorized; the preview grants nothing.
    const p = await preview({ ...A, h: lose.h }, a.versionId);
    expect(p.status).toBe('SUCCESS');
    expect((await call('DELETE', `/v1/competition-staff/${loseStaff}`, A.h)).status).toBe(204);
    const before = await snapshot(A.competitionId);
    expectRefusal(
      await call(
        'POST',
        commitUrl(a.versionId),
        { ...lose.h, ...idem() },
        {
          proposalHash: p.proposalHash,
        },
      ),
      403,
      'FORBIDDEN',
    );
    expect(await snapshot(A.competitionId)).toEqual(before);

    const ok = await call(
      'POST',
      commitUrl(a.versionId),
      { ...keep.h, ...idem() },
      {
        proposalHash: p.proposalHash,
      },
    );
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body).toMatchObject({ placedContests: 3, created: true });
  }, 600_000);

  it('stale: an authoritative change between preview and commit is 409 PROPOSAL_STALE with no partial write', async () => {
    const A = await organizer('o5ef-stale');
    const a = await scheduledKnockout(A, 'o5ef-stale');

    // A draft edit (an assignment set by hand) after the preview.
    const p1 = await preview(A, a.versionId);
    expect(p1.status).toBe('SUCCESS');
    const draftNow = await call('GET', `/v1/schedule-versions/${a.versionId}`, A.h);
    const lastFact = (draftNow.body?.history as Json[])
      .filter((f) => f.contestId === a.contests[0]?.contestId)
      .at(-1)?.assignmentId as string | undefined;
    const set = await call(
      'PUT',
      `/v1/schedule-versions/${a.versionId}/assignments/${a.contests[0]?.contestId}`,
      {
        ...A.h,
        ...idem(),
        ...(lastFact === undefined ? { 'if-none-match': '*' } : { 'if-match': `"${lastFact}"` }),
      },
      { resourceId: a.courtId, startsAt: '2027-09-05T12:00:00Z' },
    );
    expect(set.status, set.text).toBe(200);
    let before = await snapshot(A.competitionId);
    let key = `k-${newId()}`;
    expectRefusal(
      await call(
        'POST',
        commitUrl(a.versionId),
        { ...A.h, ...idem(key) },
        {
          proposalHash: p1.proposalHash,
        },
      ),
      409,
      'CONCURRENCY_CONFLICT',
      'PROPOSAL_STALE',
    );
    expect(await snapshot(A.competitionId)).toEqual(before);
    expect(await idempotencyRows(key)).toBe(0);

    // A resource change (a second court) after a fresh preview.
    const p2 = await preview(A, a.versionId);
    expect(p2.status).toBe('SUCCESS');
    expect(p2.proposalHash).not.toBe(p1.proposalHash);
    const court2 = await call(
      'POST',
      `/v1/competitions/${A.competitionId}/resources`,
      { ...A.h, ...idem() },
      { typeCode: 'TENNIS_COURT', label: 'Court 2' },
    );
    expect(court2.status, court2.text).toBe(201);
    before = await snapshot(A.competitionId);
    key = `k-${newId()}`;
    expectRefusal(
      await call(
        'POST',
        commitUrl(a.versionId),
        { ...A.h, ...idem(key) },
        {
          proposalHash: p2.proposalHash,
        },
      ),
      409,
      'CONCURRENCY_CONFLICT',
      'PROPOSAL_STALE',
    );
    expect(await snapshot(A.competitionId)).toEqual(before);
    expect(await idempotencyRows(key)).toBe(0);
    // Not one of the two committed proposals left a fact, an outbox event or an audit entry.
    expect(
      (await outboxOf(a.versionId)).filter((e) => e.event_type === 'ScheduleProposalCommitted'),
    ).toEqual([]);
    expect(await auditOf('schedule.proposal-committed', a.versionId)).toEqual([]);

    // Previewed again on the current state, it commits.
    const p3 = await preview(A, a.versionId);
    const ok = await call(
      'POST',
      commitUrl(a.versionId),
      { ...A.h, ...idem() },
      {
        proposalHash: p3.proposalHash,
      },
    );
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body?.placedContests).toBe(2);
  }, 600_000);

  it('non-SUCCESS: an INFEASIBLE proposal (with placements) is 409 PROPOSAL_NOT_COMMITTABLE; stale wins', async () => {
    const A = await organizer('o5ef-infeasible');
    const a = await scheduledKnockout(A, 'o5ef-infeasible', {
      startsAt: '2027-09-01T12:00:00Z',
      endsAt: '2027-09-01T14:00:00Z',
    });
    const p = await preview(A, a.versionId);
    expect(p.status).toBe('INFEASIBLE');
    expect((p.placements as Json[]).length).toBeGreaterThan(0);
    const before = await snapshot(A.competitionId);
    const key = `k-${newId()}`;
    const r = await call(
      'POST',
      commitUrl(a.versionId),
      { ...A.h, ...idem(key) },
      {
        proposalHash: p.proposalHash,
      },
    );
    expectRefusal(r, 409, 'INVALID_TRANSITION', 'PROPOSAL_NOT_COMMITTABLE');
    expect(r.body?.error.message).toContain('INFEASIBLE');
    expect(await snapshot(A.competitionId)).toEqual(before);
    expect(await idempotencyRows(key)).toBe(0);
    // The same key retried recomputes and is refused again (nothing was stored under it).
    expectRefusal(
      await call(
        'POST',
        commitUrl(a.versionId),
        { ...A.h, ...idem(key) },
        {
          proposalHash: p.proposalHash,
        },
      ),
      409,
      'INVALID_TRANSITION',
      'PROPOSAL_NOT_COMMITTABLE',
    );

    // ADR-0076 C5: after a state change the same hash is stale, whatever the recomputed status.
    expect(
      (
        await call(
          'POST',
          `/v1/competitions/${A.competitionId}/resources`,
          { ...A.h, ...idem() },
          { typeCode: 'TENNIS_COURT', label: 'Court 2' },
        )
      ).status,
    ).toBe(201);
    expectRefusal(
      await call(
        'POST',
        commitUrl(a.versionId),
        { ...A.h, ...idem() },
        {
          proposalHash: p.proposalHash,
        },
      ),
      409,
      'CONCURRENCY_CONFLICT',
      'PROPOSAL_STALE',
    );
  }, 600_000);

  it('concurrent commits of one preview: exactly one 200, the other 409 PROPOSAL_STALE; one set of facts', async () => {
    const A = await organizer('o5ef-race');
    const a = await scheduledKnockout(A, 'o5ef-race');
    const p = await preview(A, a.versionId);
    expect(p.status).toBe('SUCCESS');
    const send = () =>
      call('POST', commitUrl(a.versionId), { ...A.h, ...idem() }, { proposalHash: p.proposalHash });
    const results = await Promise.all([send(), send()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = results.find((r) => r.status === 409);
    expectRefusal(loser as never, 409, 'CONCURRENCY_CONFLICT', 'PROPOSAL_STALE');
    const version = await call('GET', `/v1/schedule-versions/${a.versionId}`, A.h);
    expect(version.body?.history).toHaveLength(3);
    expect(
      (await outboxOf(a.versionId)).filter((e) => e.event_type === 'ScheduleProposalCommitted'),
    ).toHaveLength(1);
  }, 600_000);

  it('internal failure is a bare 500 with no partial write; a closed competition is 409', async () => {
    const A = await organizer('o5ef-fail');
    const a = await scheduledKnockout(A, 'o5ef-fail');
    const p = await preview(A, a.versionId);
    expect(p.status).toBe('SUCCESS');
    const before = await snapshot(A.competitionId);
    const key = `k-${newId()}`;
    // The second fact's insert fails: the first fact, its outbox and audit roll back with it.
    const second = [...a.contests.map((c) => c.contestId as string)].sort()[1];
    const failed = await withFault(
      'competition.schedule_assignment',
      `NEW.version_id = '${a.versionId}' AND NEW.contest_id = '${second}'`,
      () =>
        call(
          'POST',
          commitUrl(a.versionId),
          { ...A.h, ...idem(key) },
          {
            proposalHash: p.proposalHash,
          },
        ),
    );
    expect(failed.status, failed.text).toBe(500);
    expect(failed.body).toEqual({ error: { code: 'INTERNAL', message: 'internal error' } });
    expect(await snapshot(A.competitionId)).toEqual(before);
    expect(await idempotencyRows(key)).toBe(0);

    // A cancelled competition refuses the commit (a generic INVALID_TRANSITION, no proposal reason).
    const cancelled = await call('POST', `/v1/competitions/${A.competitionId}/cancel`, A.h, {
      reason: 'weather',
    });
    expect(cancelled.status, cancelled.text).toBe(200);
    const closed = await snapshot(A.competitionId);
    expectRefusal(
      await call(
        'POST',
        commitUrl(a.versionId),
        { ...A.h, ...idem(key) },
        {
          proposalHash: p.proposalHash,
        },
      ),
      409,
      'INVALID_TRANSITION',
    );
    expect(await snapshot(A.competitionId)).toEqual(closed);
  }, 600_000);

  it('the route inventory: proposal preview and commit only; no generation, optimization or auto-publish route', () => {
    // (BRT-10's classification proposals are a different, result-side surface.)
    expect(
      app.v1Routes
        .filter((r) => /propos/i.test(r.url) && !/classification-proposals/.test(r.url))
        .map((r) => `${r.method} ${r.url} ${r.classification}`)
        .sort(),
    ).toEqual([
      'POST /v1/schedule-versions/:versionId/proposals/commit COMP_STAFF',
      'POST /v1/schedule-versions/:versionId/proposals/preview COMP_STAFF',
    ]);
    expect(
      app.v1Routes.filter((r) =>
        /proposals\/(?!(preview|commit)$)|commit-proposal|optimi|generate-schedule|auto-publish|reschedul/i.test(
          r.url,
        ),
      ),
    ).toEqual([]);
  });
});
