import {
  CANONICAL_CATALOG,
  RULESET_TEMPLATES,
  SCHEDULING_PROFILE_TEMPLATES,
  type DisciplineVersionSpec,
} from '@br/competition';
import { DomainErrorCode, newId } from '@br/domain';
import {
  apiDb,
  lastScheduleFact,
  newAthlete,
  newOrganizer,
  newTestAccount,
  operatorDb,
  ownerDb,
  uniqueSlug,
} from '@br/testkit';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CatalogStore } from './catalog-store';
import { CompetitionReader } from './competition-reader';
import { CompetitionStore } from './competition-store';
import { StructureStore } from './competition-structure-store';
import { IdentityStore } from './identity-store';
import { OrganizationStore } from './organization-store';
import { ResourceStore } from './resource-store';
import { ScheduleStore } from './schedule-store';
import { ScoringStore } from './scoring-store';

/**
 * ONCF-05E-H-1 through the real stores: manual schedule edits are optimistic-concurrency operations
 * (ADR-0070 §9 amendment, C-2) and lock / unlock follow the contest lifecycle (ADR-0070 §8
 * amendment, G-7). Every manual edit — set or move, remove, lock, unlock and the legacy route —
 * states the contest's last fact in the draft, or none; a stale statement is refused with
 * CONCURRENCY_CONFLICT LAST_FACT_STALE and writes nothing. Concurrent writers are serialized by the
 * competition-schedule advisory lock; the tests hold that lock on a third connection until every
 * writer waits on it, so the writers provably overlap.
 */

const db = apiDb();
const db2 = apiDb();
const owner = ownerDb();
const operator = operatorDb();
afterAll(async () => {
  await Promise.all([db, db2, owner, operator].map((d) => d.destroy()));
});
const identity = new IdentityStore(db);
const orgs = new OrganizationStore(db);
const catalog = new CatalogStore(operator);
const comps = new CompetitionStore(db);
const structure = new StructureStore(db);
const reader = new CompetitionReader(db);
const scoring = new ScoringStore(db);
const resources = new ResourceStore(db);
const schedule = new ScheduleStore(db);
const k = () => `k-${newId()}`;

const tag = newId().replace(/-/g, '').slice(-8);
const ids: Record<string, string> = {};

beforeAll(async () => {
  const op = (await newTestAccount(identity, { withPerson: false, label: 'operator' })).accountId;
  const tennis = CANONICAL_CATALOG.sports
    .flatMap((s) => s.disciplines)
    .find((d) => d.code === 'tennis.singles')?.specs[1] as DisciplineVersionSpec;
  const report = await catalog.provision({
    operatorAccountId: op,
    manifest: {
      sports: [
        {
          code: `z${tag}`,
          name: 'ONCF-05E-H-1 test sport',
          disciplines: [{ code: `z${tag}.tennis`, name: 'tennis', specs: [tennis] }],
        },
      ],
      formats: [
        {
          code: `se-${tag}`,
          name: 'se',
          versions: [{ engineId: 'single-elimination', engineVersion: 2 }],
        },
      ],
      rulesets: RULESET_TEMPLATES.filter((t) => t.code === 'sets-bo3-tiebreak').map((t) => ({
        code: `r${tag}-${t.code}`,
        name: t.name,
        versions: [{ spec: t.spec, basis: t.basis }],
      })),
      schedulingProfiles: SCHEDULING_PROFILE_TEMPLATES.filter(
        (t) => t.code === 'tennis-court-match',
      ).map((t) => ({
        code: `p${tag}-${t.code}`,
        name: t.name,
        versions: [{ spec: t.spec, basis: t.basis }],
      })),
    },
  });
  expect(report.conflicts).toEqual([]);
  const listed = await reader.catalog();
  for (const x of listed.disciplineVersions)
    if (x.discipline.code === `z${tag}.tennis`) ids['tennis'] = x.disciplineVersionId;
  for (const fv of listed.formatVersions)
    if (fv.format.code === `se-${tag}`) ids['se'] = fv.formatVersionId;
  for (const r of listed.rulesetVersions)
    if (r.code.startsWith(`r${tag}-`)) ids['rs'] = r.versionId;
  for (const p of listed.schedulingProfileVersions)
    if (p.code.startsWith(`p${tag}-`)) ids['sp'] = p.versionId;
}, 240_000);

interface Ev {
  eventId: string;
  competitionId: string;
  actor: string;
  /** Contests in plan order, with their round sequence (1 = first round). */
  contests: { id: string; roundSequence: number }[];
  courts: string[];
}

/** A tennis knockout with a seeded field, a generated plan, a pinned profile and open courts. */
async function knockout(entrants: number, courts = 1): Promise<Ev> {
  const org = await newOrganizer(identity, orgs);
  const actor = org.ownerAccountId;
  const { competitionId } = await comps.createCompetition({
    actorAccountId: actor,
    organizerOrganizationId: org.organizationId,
    slug: uniqueSlug('comp'),
    profile: { name: 'ONCF-05E-H-1 Fest', timezone: 'America/Costa_Rica' },
    idempotencyKey: k(),
  });
  await comps.publishCompetition({ actorAccountId: actor, competitionId });
  await comps.activateCompetition({ actorAccountId: actor, competitionId });
  const { eventId } = await comps.createEvent({
    actorAccountId: actor,
    competitionId,
    slug: uniqueSlug('ev'),
    disciplineVersionId: ids['tennis'] as string,
    formatVersionId: ids['se'] as string,
    formatConfig: {},
    settings: { name: 'Singles', capacity: null, registrationMode: 'AUTO_CONFIRM' },
    idempotencyKey: k(),
  });
  await comps.openRegistration({ actorAccountId: actor, eventId });
  await scoring.pinScoring({
    actorAccountId: actor,
    eventId,
    rulesetVersionId: ids['rs'] as string,
    schedulingProfileVersionId: ids['sp'] as string,
    idempotencyKey: k(),
  });
  for (let i = 0; i < entrants; i++) {
    const a = await newAthlete(identity, `p${i}`, `Player ${i}`);
    await comps.register({
      actorAccountId: a.accountId,
      eventId,
      athleteId: a.athleteId,
      eligibilityDeclared: true,
      idempotencyKey: k(),
    });
  }
  await comps.closeRegistration({ actorAccountId: actor, eventId });
  await structure.lockField({ actorAccountId: actor, eventId, idempotencyKey: k() });
  await structure.seedField({
    actorAccountId: actor,
    eventId,
    idempotencyKey: k(),
    method: 'DETERMINISTIC_DRAW',
  });
  await structure.generatePlan({ actorAccountId: actor, eventId, idempotencyKey: k() });
  const { rows } = await sql<{ id: string; round_sequence: number }>`
    SELECT c.id, r.sequence AS round_sequence FROM competition.contest c
    JOIN competition.round r ON r.id = c.round_id WHERE c.event_id = ${eventId}
    ORDER BY r.sequence, c.sequence`.execute(owner);
  const courtIds: string[] = [];
  for (let i = 0; i < courts; i++)
    courtIds.push(
      (
        await resources.createResource({
          actorAccountId: actor,
          competitionId,
          typeCode: 'TENNIS_COURT',
          resource: { label: `Court ${i + 1}` },
          idempotencyKey: k(),
        })
      ).resourceId,
    );
  // Declared hours every day, all day (no undeclared time, ADR-0073 B5).
  for (const weekday of [1, 2, 3, 4, 5, 6, 7])
    await resources.addAvailability({
      actorAccountId: actor,
      competitionId,
      resourceId: null,
      fact: { kind: 'WEEKLY', weekday, start: '00:00', end: '24:00' },
      idempotencyKey: k(),
    });
  return {
    eventId,
    competitionId,
    actor,
    contests: rows.map((r) => ({ id: r.id, roundSequence: r.round_sequence })),
    courts: courtIds,
  };
}

const openDraft = async (ev: Ev) =>
  (
    await schedule.openDraft({
      actorAccountId: ev.actor,
      competitionId: ev.competitionId,
      idempotencyKey: k(),
    })
  ).versionId;

/** Publishes a draft, acknowledging its SOFT conflicts; a HARD conflict fails the fixture. */
async function publish(ev: Ev, versionId: string, baseVersionId: string | null) {
  const r = await schedule.validate({ actorAccountId: ev.actor, versionId });
  expect(r.conflicts.filter((c) => c.severity === 'HARD')).toEqual([]);
  await schedule.publish({
    actorAccountId: ev.actor,
    versionId,
    baseVersionId,
    reportHash: r.reportHash,
    acknowledgedConflictKeys: r.conflicts
      .filter((c) => c.severity === 'SOFT')
      .map((c) => c.conflictKey),
    idempotencyKey: k(),
  });
}

const last = (versionId: string, contestId: string) => lastScheduleFact(db, contestId, versionId);

const rejects = (p: Promise<unknown>, code: DomainErrorCode, reason?: string) =>
  expect(p).rejects.toMatchObject({
    code,
    ...(reason === undefined ? {} : { details: { reason } }),
  });

const STALE = [DomainErrorCode.CONCURRENCY_CONFLICT, 'LAST_FACT_STALE'] as const;
const CLOSED = [DomainErrorCode.INVALID_TRANSITION, 'CONTEST_STARTED_OR_CLOSED'] as const;

/** Every row a manual edit could write for the competition: facts, versions, audit, outbox, keys. */
async function snapshot(ev: Ev) {
  const q = async (table: string, where: ReturnType<typeof sql>) => {
    const { rows } = await sql<{ j: string }>`
      SELECT coalesce(json_agg(t ORDER BY t::text), '[]')::text AS j
      FROM ${sql.raw(table)} t WHERE ${where}`.execute(owner);
    return rows[0]?.j as string;
  };
  const contests = sql`(SELECT c.id FROM competition.contest c JOIN competition.event e ON e.id = c.event_id
                        WHERE e.competition_id = ${ev.competitionId})`;
  const versions = sql`(SELECT id FROM competition.schedule_version WHERE competition_id = ${ev.competitionId})`;
  const targets = sql`(SELECT * FROM ${contests} UNION ALL SELECT * FROM ${versions})`;
  return {
    schedule_version: await q(
      'competition.schedule_version',
      sql`t.competition_id = ${ev.competitionId}`,
    ),
    schedule_assignment: await q(
      'competition.schedule_assignment',
      sql`t.competition_id = ${ev.competitionId}`,
    ),
    contest_status_change: await q(
      'competition.contest_status_change',
      sql`t.contest_id IN ${contests}`,
    ),
    audit_event: await q('platform.audit_event', sql`t.target_id IN ${targets}`),
    outbox_event: await q('platform.outbox_event', sql`t.aggregate_id IN ${targets}`),
    command_idempotency: await q('platform.command_idempotency', sql`t.scope = ${ev.actor}`),
  };
}

/** The assignment facts of a version, in recording order. */
async function facts(versionId: string) {
  const { rows } = await sql<{
    id: string;
    contest_id: string;
    starts_at: Date;
    locked: boolean;
    removed: boolean;
    reason: string | null;
    replaces_assignment_id: string | null;
  }>`
    SELECT id, contest_id, starts_at, locked, removed, reason, replaces_assignment_id
    FROM competition.schedule_assignment WHERE version_id = ${versionId} ORDER BY seq`.execute(
    owner,
  );
  return rows;
}

const auditOf = async (assignmentId: string) =>
  (
    await sql<{ action: string; details: Record<string, unknown> }>`
      SELECT action, details FROM platform.audit_event WHERE details->>'assignmentId' = ${assignmentId}`.execute(
      owner,
    )
  ).rows;

const outboxOf = async (assignmentId: string) =>
  (
    await sql<{ event_type: string; payload: Record<string, unknown> }>`
      SELECT event_type, payload FROM platform.outbox_event WHERE payload->>'assignmentId' = ${assignmentId}`.execute(
      owner,
    )
  ).rows;

const statusOf = async (contestId: string) =>
  (
    await sql<{ status: string }>`
      SELECT status FROM competition.v_contest_current WHERE contest_id = ${contestId}`.execute(
      owner,
    )
  ).rows[0]?.status;

/**
 * A database barrier: a third connection holds the competition-schedule advisory lock — the lock
 * every manual edit takes — while `start` launches the writers; it is released only once `waiters`
 * transactions are blocked on it (then `between` runs, still under the lock). No timing is involved.
 */
async function underScheduleLock<T>(
  competitionId: string,
  waiters: number,
  start: () => Promise<T>[],
  between?: () => Promise<void>,
): Promise<PromiseSettledResult<T>[]> {
  const key = `competition-schedule:${competitionId}`;
  let settled: Promise<PromiseSettledResult<T>[]> | undefined;
  await owner.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(trx);
    settled = Promise.allSettled(start());
    for (;;) {
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted
          AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(${key}, 0)`.execute(trx);
      if ((rows[0]?.n ?? 0) >= waiters) break;
    }
    await between?.();
  });
  return settled as Promise<PromiseSettledResult<T>[]>;
}

// ───────────────────────────── C-2: optimistic concurrency ─────────────────────────────

describe('C-2: every manual edit states the last fact it saw (ADR-0070 §9 amendment)', () => {
  let ev: Ev;
  let v = '';
  let semi1 = '';
  let semi2 = '';
  let final = '';
  const set = (
    contestId: string,
    startsAt: string,
    expectedLastFactId: string | null,
    extra: { reason?: string; idempotencyKey?: string; store?: ScheduleStore } = {},
  ) =>
    (extra.store ?? schedule).setAssignment({
      actorAccountId: ev.actor,
      versionId: v,
      contestId,
      assignment: {
        resourceId: ev.courts[0] as string,
        startsAt,
        ...(extra.reason === undefined ? {} : { reason: extra.reason }),
      },
      expectedLastFactId,
      idempotencyKey: extra.idempotencyKey ?? k(),
    });
  const lock = (
    contestId: string,
    locked: boolean,
    expectedLastFactId: string | null,
    store = schedule,
  ) =>
    store.setLock({
      actorAccountId: ev.actor,
      versionId: v,
      contestId,
      locked,
      reason: locked ? null : 'organizer decision',
      expectedLastFactId,
      idempotencyKey: k(),
    });

  beforeAll(async () => {
    ev = await knockout(4);
    [semi1, semi2, final] = ev.contests.map((c) => c.id) as [string, string, string];
    v = await openDraft(ev);
  }, 240_000);

  it('B: "none" is accepted only while the contest has no fact in the draft', async () => {
    expect(await last(v, semi1)).toBeNull();
    const first = await set(semi1, '2027-06-01T15:00:00Z', null);
    expect(first.created).toBe(true);
    const before = await snapshot(ev);
    // "None" again, now that a fact exists: the state the client saw is gone.
    await rejects(set(semi1, '2027-06-01T16:00:00Z', null, { reason: 'later' }), ...STALE);
    expect(await snapshot(ev)).toEqual(before);
    expect(await last(v, semi1)).toBe(first.assignmentId);
  });

  it('A, C–G, AB: the current fact is accepted; a stale one is refused and writes nothing', async () => {
    const f1 = (await last(v, semi1)) as string;
    const moved = await set(semi1, '2027-06-01T17:00:00Z', f1, { reason: 'court 1 wet' });
    const [fact] = (await facts(v)).filter((f) => f.id === moved.assignmentId);
    expect(fact).toMatchObject({ contest_id: semi1, replaces_assignment_id: f1 });
    // The successful edit keeps its audit (previous and new placement, who, why, version) and event.
    const audit = await auditOf(moved.assignmentId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'schedule.assignment-moved',
      details: {
        versionId: v,
        startsAt: '2027-06-01T17:00:00.000Z',
        previousStartsAt: '2027-06-01T15:00:00.000Z',
        resourceId: ev.courts[0],
        previousResourceId: ev.courts[0],
        reason: 'court 1 wet',
      },
    });
    expect(await outboxOf(moved.assignmentId)).toEqual([
      {
        event_type: 'ScheduleAssignmentChanged',
        payload: { contestId: semi1, assignmentId: moved.assignmentId, action: 'MOVE' },
      },
    ]);

    // B never saw A's move: it still names f1. Refused; no fact, audit, outbox or key is written.
    const before = await snapshot(ev);
    const key = k();
    await rejects(
      set(semi1, '2027-06-01T18:00:00Z', f1, { reason: 'TV slot', idempotencyKey: key }),
      ...STALE,
    );
    expect(await snapshot(ev)).toEqual(before);
    expect(await last(v, semi1)).toBe(moved.assignmentId);
    // Nothing was recorded under the refused key: the same key with a re-read expectation is new.
    const again = await set(semi1, '2027-06-01T18:00:00Z', moved.assignmentId, {
      reason: 'TV slot',
      idempotencyKey: key,
    });
    expect(again.created).toBe(true);
  });

  it('D: idempotency stays a separate mechanism — replay, key reuse, and a new key after success', async () => {
    const before = (await last(v, semi1)) as string;
    const key = k();
    const first = await set(semi1, '2027-06-01T19:00:00Z', before, {
      reason: 'evening',
      idempotencyKey: key,
    });
    // Same key, same request: the stored response, no new check and no write.
    const factsBefore = await facts(v);
    const replay = await set(semi1, '2027-06-01T19:00:00Z', before, {
      reason: 'evening',
      idempotencyKey: key,
    });
    expect(replay).toEqual({ ...first, created: false });
    expect(await facts(v)).toEqual(factsBefore);
    // Same key, another expectation: the expectation is part of the fingerprint.
    await rejects(
      set(semi1, '2027-06-01T19:00:00Z', first.assignmentId, {
        reason: 'evening',
        idempotencyKey: key,
      }),
      DomainErrorCode.IDEMPOTENCY_KEY_REUSED,
    );
    // A new key repeating the succeeded command: its stated fact was replaced, so it is stale.
    await rejects(set(semi1, '2027-06-01T19:00:00Z', before, { reason: 'evening' }), ...STALE);
    expect(await facts(v)).toEqual(factsBefore);
  });

  it('the check is per contest: an edit of another contest does not make this one stale', async () => {
    const mine = (await last(v, semi1)) as string;
    await set(semi2, '2027-06-02T15:00:00Z', await last(v, semi2));
    const r = await set(semi1, '2027-06-01T20:00:00Z', mine, { reason: 'night session' });
    expect(r.created).toBe(true);
  });

  it('remove: a stale removal is refused; the removal fact is the next last fact', async () => {
    const live = (await last(v, semi2)) as string;
    const remove = (expectedLastFactId: string | null) =>
      schedule.removeAssignment({
        actorAccountId: ev.actor,
        versionId: v,
        contestId: semi2,
        reason: 'reschedule later',
        expectedLastFactId,
        idempotencyKey: k(),
      });
    let before = await snapshot(ev);
    await rejects(remove(null), ...STALE);
    expect(await snapshot(ev)).toEqual(before);
    const removed = await remove(live);
    expect(await auditOf(removed.assignmentId)).toEqual([
      expect.objectContaining({ action: 'schedule.assignment-removed' }),
    ]);
    expect((await outboxOf(removed.assignmentId))[0]?.payload).toMatchObject({ action: 'REMOVE' });
    // A removal counts: "none" and the removed live fact are both stale now.
    before = await snapshot(ev);
    await rejects(set(semi2, '2027-06-02T16:00:00Z', null), ...STALE);
    await rejects(set(semi2, '2027-06-02T16:00:00Z', live), ...STALE);
    expect(await snapshot(ev)).toEqual(before);
    const back = await set(semi2, '2027-06-02T16:00:00Z', removed.assignmentId);
    expect(back.created).toBe(true);
  });

  it('the expectation is required: an omitted or malformed one is invalid input and writes nothing', async () => {
    const before = await snapshot(ev);
    const omitted = undefined as unknown as string | null;
    const base = { actorAccountId: ev.actor, versionId: v, contestId: semi1 };
    for (const attempt of [
      () =>
        schedule.setAssignment({
          ...base,
          assignment: { resourceId: ev.courts[0] as string, startsAt: '2027-06-01T21:00:00Z' },
          expectedLastFactId: omitted,
          idempotencyKey: k(),
        }),
      () =>
        schedule.removeAssignment({
          ...base,
          reason: 'x',
          expectedLastFactId: omitted,
          idempotencyKey: k(),
        }),
      () =>
        schedule.setLock({
          ...base,
          locked: true,
          expectedLastFactId: omitted,
          idempotencyKey: k(),
        }),
      () =>
        schedule.setLock({
          ...base,
          locked: false,
          reason: 'x',
          expectedLastFactId: omitted,
          idempotencyKey: k(),
        }),
      () =>
        schedule.scheduleContest({
          actorAccountId: ev.actor,
          contestId: semi1,
          scheduledStart: '2027-06-01T21:00:00Z',
          resourceId: ev.courts[0] as string,
          expectedLastFactId: omitted,
          idempotencyKey: k(),
        }),
    ])
      await rejects(attempt(), DomainErrorCode.INVALID_INPUT, 'PRECONDITION_REQUIRED');
    await rejects(
      schedule.setLock({ ...base, locked: true, expectedLastFactId: 'f1', idempotencyKey: k() }),
      DomainErrorCode.INVALID_INPUT,
    );
    expect(await snapshot(ev)).toEqual(before);
  });

  it('V–X: lock and unlock are optimistic-concurrency operations; a stale unlock never undoes a lock', async () => {
    const x = (await last(v, semi1)) as string;
    // W: a stale lock.
    let before = await snapshot(ev);
    await rejects(lock(semi1, true, null), ...STALE);
    expect(await snapshot(ev)).toEqual(before);
    // Client A locks from X; client B, still holding X, tries to unlock.
    const locked = await lock(semi1, true, x);
    expect(await auditOf(locked.assignmentId)).toEqual([
      expect.objectContaining({ action: 'schedule.assignment-locked' }),
    ]);
    expect((await outboxOf(locked.assignmentId))[0]?.payload).toMatchObject({ action: 'LOCK' });
    before = await snapshot(ev);
    await rejects(lock(semi1, false, x, new ScheduleStore(db2)), ...STALE); // X
    expect(await snapshot(ev)).toEqual(before);
    const current = await last(v, semi1);
    expect((await facts(v)).find((f) => f.id === current)?.locked).toBe(true);
    // B re-reads, sees A's lock, and unlocks deliberately.
    const unlocked = await lock(semi1, false, locked.assignmentId);
    expect(await auditOf(unlocked.assignmentId)).toEqual([
      expect.objectContaining({
        action: 'schedule.assignment-unlocked',
        details: expect.objectContaining({ reason: 'organizer decision' }),
      }),
    ]);
    expect((await outboxOf(unlocked.assignmentId))[0]?.payload).toMatchObject({
      action: 'UNLOCK',
    });
    // Relocking from the fact the unlock replaced is stale.
    await rejects(lock(semi1, true, locked.assignmentId), ...STALE);
  });

  it('H, I: two writers from the same fact, provably concurrent — exactly one succeeds', async () => {
    const x = (await last(v, semi1)) as string;
    const factsBefore = await facts(v);
    const results = await underScheduleLock(ev.competitionId, 2, () => [
      set(semi1, '2027-06-03T09:00:00Z', x, { reason: 'writer A' }),
      set(semi1, '2027-06-03T11:00:00Z', x, { reason: 'writer B', store: new ScheduleStore(db2) }),
    ]);
    const won = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof set>>> => r.status === 'fulfilled',
    );
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({
      code: STALE[0],
      details: { reason: STALE[1] },
    });
    // Exactly one new fact, replacing X; one audit entry and one event for it; nothing else.
    const added = (await facts(v)).slice(factsBefore.length);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ id: won[0]?.value.assignmentId, replaces_assignment_id: x });
    expect(await auditOf(added[0]?.id as string)).toHaveLength(1);
    expect(await outboxOf(added[0]?.id as string)).toHaveLength(1);
  }, 120_000);

  it('a lock and a move racing from the same fact: one wins, the other is stale', async () => {
    const x = (await last(v, semi1)) as string;
    const factsBefore = await facts(v);
    const results = await underScheduleLock(ev.competitionId, 2, () => [
      lock(semi1, true, x),
      set(semi1, '2027-06-03T13:00:00Z', x, { reason: 'move', store: new ScheduleStore(db2) }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({ code: STALE[0], details: { reason: STALE[1] } });
    expect((await facts(v)).slice(factsBefore.length)).toHaveLength(1);
  }, 120_000);

  it('AA: the legacy route edits the open draft under the same contract', async () => {
    const before = await snapshot(ev);
    const legacy = (expectedLastFactId: string | null) =>
      structure.scheduleContest({
        actorAccountId: ev.actor,
        contestId: final,
        scheduledStart: '2027-06-05T15:00:00Z',
        resourceId: ev.courts[0] as string,
        expectedLastFactId,
        idempotencyKey: k(),
      });
    await rejects(legacy(newId()), ...STALE);
    expect(await snapshot(ev)).toEqual(before);
    const r = await legacy(null);
    expect(r).toMatchObject({ versionId: v, created: true });
    await rejects(legacy(null), ...STALE);
  });
});

describe('AA: the legacy route opening the draft itself (no draft open)', () => {
  it('states the published fact the carried copy replaces; a stale statement opens no draft', async () => {
    const ev = await knockout(4);
    const [semi1, semi2] = ev.contests.map((c) => c.id) as [string, string];
    const v1 = await openDraft(ev);
    const published = await schedule.setAssignment({
      actorAccountId: ev.actor,
      versionId: v1,
      contestId: semi1,
      assignment: { resourceId: ev.courts[0] as string, startsAt: '2027-06-01T15:00:00Z' },
      expectedLastFactId: null,
      idempotencyKey: k(),
    });
    await schedule.setAssignment({
      actorAccountId: ev.actor,
      versionId: v1,
      contestId: semi2,
      assignment: { resourceId: ev.courts[0] as string, startsAt: '2027-06-02T15:00:00Z' },
      expectedLastFactId: null,
      idempotencyKey: k(),
    });
    await publish(ev, v1, null);
    expect(await lastScheduleFact(db, semi1)).toBe(published.assignmentId);
    const legacy = (expectedLastFactId: string | null) =>
      structure.scheduleContest({
        actorAccountId: ev.actor,
        contestId: semi1,
        scheduledStart: '2027-06-01T17:00:00Z',
        resourceId: ev.courts[0] as string,
        reason: 'rain',
        expectedLastFactId,
        idempotencyKey: k(),
      });

    // "None" for a published contest is stale; the refusal also rolls back the draft it opened.
    const before = await snapshot(ev);
    await rejects(legacy(null), ...STALE);
    expect(await snapshot(ev)).toEqual(before);

    const moved = await legacy(published.assignmentId);
    expect(moved.versionId).not.toBe(v1);
    const draftFacts = (await facts(moved.versionId)).filter((f) => f.contest_id === semi1);
    expect(draftFacts.map((f) => f.replaces_assignment_id)).toEqual([
      published.assignmentId,
      draftFacts[0]?.id,
    ]);
    // Now a draft is open: its current fact is what must be stated, not the published one.
    await rejects(legacy(published.assignmentId), ...STALE);
    const again = await legacy(moved.assignmentId);
    expect(again).toMatchObject({ versionId: moved.versionId, created: true });
  }, 300_000);
});

// ───────────────────────────── G-7: lock and unlock follow the lifecycle ─────────────────────────────

describe('G-7: lock and unlock only while the contest is PLANNED or SCHEDULED (ADR-0070 §8 amendment)', () => {
  let ev: Ev;
  let v2 = '';
  let r16: string[] = [];
  let qf: string[] = [];
  const lock = (contestId: string, locked: boolean, expectedLastFactId: string | null) =>
    schedule.setLock({
      actorAccountId: ev.actor,
      versionId: v2,
      contestId,
      locked,
      reason: locked ? null : 'organizer decision',
      expectedLastFactId,
      idempotencyKey: k(),
    });

  beforeAll(async () => {
    ev = await knockout(16, 4);
    r16 = ev.contests.filter((c) => c.roundSequence === 1).map((c) => c.id);
    qf = ev.contests.filter((c) => c.roundSequence === 2).map((c) => c.id);
    expect([r16.length, qf.length]).toEqual([8, 4]);
    // Version 1 publishes the eight first-round matches and two quarterfinals: all SCHEDULED.
    const v1 = await openDraft(ev);
    const place = (contestId: string, court: number, startsAt: string) =>
      schedule.setAssignment({
        actorAccountId: ev.actor,
        versionId: v1,
        contestId,
        assignment: { resourceId: ev.courts[court] as string, startsAt },
        expectedLastFactId: null,
        idempotencyKey: k(),
      });
    for (const [i, contestId] of r16.entries())
      await place(contestId, i % 4, `2027-06-01T${i < 4 ? '09' : '12'}:00:00Z`);
    await place(qf[0] as string, 0, '2027-06-03T10:00:00Z');
    await place(qf[2] as string, 1, '2027-06-03T10:00:00Z');
    await publish(ev, v1, null);
    // Version 2 (the open draft) carries them. The even first-round matches are locked while
    // SCHEDULED (case L); the odd ones stay unlocked.
    v2 = await openDraft(ev);
    for (const contestId of [r16[0], r16[2], r16[4], r16[6]] as string[]) {
      expect(await statusOf(contestId)).toBe('SCHEDULED');
      await lock(contestId, true, await last(v2, contestId));
    }
    // A quarterfinal placed in the draft only stays PLANNED.
    await schedule.setAssignment({
      actorAccountId: ev.actor,
      versionId: v2,
      contestId: qf[1] as string,
      assignment: { resourceId: ev.courts[2] as string, startsAt: '2027-06-03T10:00:00Z' },
      expectedLastFactId: null,
      idempotencyKey: k(),
    });
    // The lifecycle: two first-round matches each IN_PROGRESS, COMPLETED and VOID (one locked,
    // one not), and a locked and an unlocked contest CANCELLED. r16[7] stays SCHEDULED.
    await comps.startEvent({ actorAccountId: ev.actor, eventId: ev.eventId });
    const actor = ev.actor;
    for (const contestId of r16.slice(0, 6))
      await structure.startContest({ actorAccountId: actor, contestId });
    for (const contestId of r16.slice(2, 4))
      await structure.completeContest({ actorAccountId: actor, contestId });
    for (const contestId of r16.slice(4, 6))
      await structure.voidContest({ actorAccountId: actor, contestId, reason: 'walkover dispute' });
    for (const contestId of [r16[6], qf[2]] as string[])
      await structure.cancelContest({ actorAccountId: actor, contestId, reason: 'rain' });
  }, 600_000);

  it('J, K: PLANNED — lock and unlock succeed', async () => {
    const contestId = qf[1] as string;
    expect(await statusOf(contestId)).toBe('PLANNED');
    const locked = await lock(contestId, true, await last(v2, contestId));
    const unlocked = await lock(contestId, false, locked.assignmentId);
    expect(unlocked.created).toBe(true);
    expect((await facts(v2)).find((f) => f.id === unlocked.assignmentId)?.locked).toBe(false);
  });

  it('L, M: SCHEDULED — lock and unlock succeed', async () => {
    const contestId = qf[0] as string;
    expect(await statusOf(contestId)).toBe('SCHEDULED');
    const locked = await lock(contestId, true, await last(v2, contestId));
    expect((await facts(v2)).find((f) => f.id === locked.assignmentId)?.locked).toBe(true);
    const unlocked = await lock(contestId, false, locked.assignmentId);
    expect(unlocked.created).toBe(true);
  });

  it.each([
    ['IN_PROGRESS', 0, 1],
    ['COMPLETED', 2, 3],
    ['VOID', 4, 5],
  ] as const)(
    'N–U: %s — lock and unlock are refused with CONTEST_STARTED_OR_CLOSED and write nothing',
    async (status, lockedAt, unlockedAt) => {
      const lockedContest = r16[lockedAt] as string;
      const unlockedContest = r16[unlockedAt] as string;
      expect([await statusOf(lockedContest), await statusOf(unlockedContest)]).toEqual([
        status,
        status,
      ]);
      const before = await snapshot(ev);
      await rejects(lock(unlockedContest, true, await last(v2, unlockedContest)), ...CLOSED);
      await rejects(lock(lockedContest, false, await last(v2, lockedContest)), ...CLOSED);
      expect(await snapshot(ev)).toEqual(before);
    },
  );

  it('R, S: CANCELLED — lock and unlock are refused with CONTEST_STARTED_OR_CLOSED and write nothing', async () => {
    const lockedContest = r16[6] as string;
    const unlockedContest = qf[2] as string;
    expect([await statusOf(lockedContest), await statusOf(unlockedContest)]).toEqual([
      'CANCELLED',
      'CANCELLED',
    ]);
    const before = await snapshot(ev);
    await rejects(lock(unlockedContest, true, await last(v2, unlockedContest)), ...CLOSED);
    await rejects(lock(lockedContest, false, await last(v2, lockedContest)), ...CLOSED);
    expect(await snapshot(ev)).toEqual(before);
  });

  it('Y: a start committed while the lock command waits is seen at write time', async () => {
    const contestId = r16[7] as string;
    expect(await statusOf(contestId)).toBe('SCHEDULED');
    const expected = await last(v2, contestId);
    const before = (await facts(v2)).length;
    // The lock command is in flight (blocked on the schedule lock) when the contest starts on
    // another connection; its status read comes after, inside its own transaction.
    const [result] = await underScheduleLock(
      ev.competitionId,
      1,
      () => [lock(contestId, true, expected)],
      () => new StructureStore(db2).startContest({ actorAccountId: ev.actor, contestId }),
    );
    expect(await statusOf(contestId)).toBe('IN_PROGRESS');
    expect(result?.status).toBe('rejected');
    expect((result as PromiseRejectedResult).reason).toMatchObject({
      code: CLOSED[0],
      details: { reason: CLOSED[1] },
    });
    expect(await facts(v2)).toHaveLength(before);
  }, 120_000);
});
