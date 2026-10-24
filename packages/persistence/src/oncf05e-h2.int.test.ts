import { configureAdvancementFixture } from '@br/testkit';
import {
  ADVANCEMENT_POLICY_TEMPLATES,
  CANONICAL_CATALOG,
  CompetitionLifecycle,
  ContestLifecycle,
  EventLifecycle,
  GOLF_INDIVIDUAL_V2,
  RULESET_TEMPLATES,
  SCHEDULING_PROFILE_TEMPLATES,
  canTransition,
  type CompetitionStatus,
  type ContestStatus,
  type DisciplineVersionSpec,
  type EventStatus,
  type ScoreSheet,
} from '@br/competition';
import { DomainErrorCode, newId, type Uuid } from '@br/domain';
import { CLASSIFICATION_TEMPLATES } from '@br/rankings';
import {
  apiDb,
  declaredNoParticipation,
  newAthlete,
  newOrganizer,
  newTestAccount,
  operatorDb,
  ownerDb,
  playContest,
  uniqueSlug,
} from '@br/testkit';
import { sql, type RawBuilder, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdvancementStore } from './advancement-store';
import { AuthorityStore } from './authority-store';
import { CatalogStore } from './catalog-store';
import {
  CompetitionHierarchyResolver,
  createCompetitionResultLedger,
} from './competition-hierarchy';
import { CompetitionReader } from './competition-reader';
import { CompetitionStore } from './competition-store';
import type { Database } from './db';
import { StructureStore } from './competition-structure-store';
import { IdentityStore } from './identity-store';
import { OrganizationStore } from './organization-store';
import { ResourceStore } from './resource-store';
import { ScheduleStore } from './schedule-store';
import { ScoringStore } from './scoring-store';

/**
 * ONCF-05E-H-2 (G-1) through the real stores: every writer of contest status facts — start,
 * complete, cancel, void, publication (PLANNED → SCHEDULED) and the event / competition
 * cancellation cascade — takes the contest's `contest:<id>` advisory lock before it reads the
 * status it validates, so two writers can never both transition the same prior state.
 *
 * Races are real: the writers run on two pools, and a third connection holds a lock until every
 * writer is blocked (`pg_locks`), so they provably overlap. No timing is involved. The two pinned
 * interleavings of ONCF-05E-F-5 § 39 hold one writer between its status read and its write.
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
const comps2 = new CompetitionStore(db2);
const structure = new StructureStore(db);
const structure2 = new StructureStore(db2);
const reader = new CompetitionReader(db);
const scoring = new ScoringStore(db);
const resources = new ResourceStore(db);
const schedule = new ScheduleStore(db);
const advancement = new AdvancementStore(db, scoring);
const authority = new AuthorityStore(db, { conflictChecker: declaredNoParticipation });
const ledger = createCompetitionResultLedger(db, { conflictChecker: declaredNoParticipation });
const resolver = new CompetitionHierarchyResolver(db);
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
          name: 'ONCF-05E-H-2 test sport',
          disciplines: [
            { code: `z${tag}.tennis`, name: 'tennis', specs: [tennis] },
            // H-2 category level: a golf cut, the 05D path that materializes contests.
            { code: `z${tag}.golf`, name: 'golf', specs: [GOLF_INDIVIDUAL_V2] },
          ],
        },
      ],
      formats: [
        {
          code: `se-${tag}`,
          name: 'se',
          versions: [{ engineId: 'single-elimination', engineVersion: 2 }],
        },
        {
          code: `mr-${tag}`,
          name: 'mr',
          versions: [{ engineId: 'multi-round', engineVersion: 1 }],
        },
      ],
      rulesets: RULESET_TEMPLATES.filter((t) =>
        ['sets-bo3-tiebreak', 'golf-stroke-gross'].includes(t.code),
      ).map((t) => ({
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
      advancementPolicies: ADVANCEMENT_POLICY_TEMPLATES.filter(
        (t) => t.code === 'field-cut-official',
      ).map((t) => ({
        code: `a${tag}-${t.code}`,
        name: t.name,
        versions: [{ spec: t.spec, basis: t.basis }],
      })),
    },
    classificationTemplates: CLASSIFICATION_TEMPLATES.filter((t) => t.code === 'golf_stroke').map(
      (t) => ({
        code: `t${tag}_${t.code}`,
        name: t.name,
        versions: [{ spec: t.spec, basis: t.basis }],
      }),
    ),
  });
  expect(report.conflicts).toEqual([]);
  const listed = await reader.catalog();
  for (const x of listed.disciplineVersions)
    if (x.discipline.code === `z${tag}.tennis`) ids['tennis'] = x.disciplineVersionId;
    else if (x.discipline.code === `z${tag}.golf`) ids['golf'] = x.disciplineVersionId;
  for (const fv of listed.formatVersions)
    if (fv.format.code === `se-${tag}`) ids['se'] = fv.formatVersionId;
    else if (fv.format.code === `mr-${tag}`) ids['mr'] = fv.formatVersionId;
  for (const r of listed.rulesetVersions)
    if (r.code === `r${tag}-sets-bo3-tiebreak`) ids['rs'] = r.versionId;
    else if (r.code === `r${tag}-golf-stroke-gross`) ids['rs:golf'] = r.versionId;
  for (const t of listed.classificationTemplateVersions)
    if (t.code === `t${tag}_golf_stroke`) ids['tp:golf'] = t.versionId;
  for (const a of listed.advancementPolicyVersions)
    if (a.code === `a${tag}-field-cut-official`) ids['ap:cut'] = a.versionId;
  for (const p of listed.schedulingProfileVersions)
    if (p.code.startsWith(`p${tag}-`)) ids['sp'] = p.versionId;
}, 240_000);

interface Ev {
  eventId: string;
  competitionId: string;
  actor: string;
  /** First-round contests, then later rounds' contests, in plan order. */
  r1: string[];
  later: string[];
  courts: string[];
}

/** A tennis knockout with a seeded field, a generated plan, a pinned profile and open courts. */
async function knockout(entrants: number, courts: number): Promise<Ev> {
  const org = await newOrganizer(identity, orgs);
  const actor = org.ownerAccountId;
  const { competitionId } = await comps.createCompetition({
    actorAccountId: actor,
    organizerOrganizationId: org.organizationId,
    slug: uniqueSlug('comp'),
    profile: { name: 'ONCF-05E-H-2 Fest', timezone: 'America/Costa_Rica' },
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
  await configureAdvancementFixture(db, actor, eventId);
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
    r1: rows.filter((r) => r.round_sequence === 1).map((r) => r.id),
    later: rows.filter((r) => r.round_sequence > 1).map((r) => r.id),
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

/** Places a contest with no prior fact in the draft. */
const place = (ev: Ev, versionId: string, contestId: string, court: number, startsAt: string) =>
  schedule.setAssignment({
    actorAccountId: ev.actor,
    versionId,
    contestId,
    assignment: { resourceId: ev.courts[court] as string, startsAt },
    expectedLastFactId: null,
    idempotencyKey: k(),
  });

/** The publication command for a draft, validated now; a HARD conflict fails the fixture. */
async function publication(ev: Ev, versionId: string, baseVersionId: string | null) {
  const r = await schedule.validate({ actorAccountId: ev.actor, versionId });
  expect(r.conflicts.filter((c) => c.severity === 'HARD')).toEqual([]);
  return (store: ScheduleStore) =>
    store.publish({
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

/** A contest's status facts, in recording order. */
const history = async (contestId: string) =>
  (
    await sql<{ status: ContestStatus }>`
      SELECT status FROM competition.contest_status_change WHERE contest_id = ${contestId} ORDER BY seq`.execute(
      owner,
    )
  ).rows.map((r) => r.status);

const statusOf = async (contestId: string) => (await history(contestId)).at(-1);

/** Every status history is a path of the contest state machine from PLANNED (BRT-05 § 8). */
async function expectValidHistory(contestId: string) {
  const h = await history(contestId);
  expect(h[0]).toBe('PLANNED');
  for (let i = 1; i < h.length; i++)
    expect(
      canTransition(ContestLifecycle, h[i - 1] as ContestStatus, h[i] as ContestStatus),
      `${h.join(' → ')} is not a path of the contest lifecycle`,
    ).toBe(true);
  return h;
}

/** Every row a lifecycle writer can write for a contest: status facts, audit and outbox. */
async function effects(contestId: string) {
  const rows = async (q: RawBuilder<{ id: string; v: string }>) => (await q.execute(owner)).rows;
  return {
    facts: await rows(sql<{ id: string; v: string }>`
      SELECT id, status AS v FROM competition.contest_status_change WHERE contest_id = ${contestId} ORDER BY seq`),
    audit: await rows(sql<{ id: string; v: string }>`
      SELECT id, action || ':' || outcome AS v FROM platform.audit_event WHERE target_id = ${contestId} ORDER BY id`),
    outbox: await rows(sql<{ id: string; v: string }>`
      SELECT id::text, event_type AS v FROM platform.outbox_event WHERE aggregate_id = ${contestId} ORDER BY id`),
  };
}

/** The rows written since `before`, by kind (values only, sorted). */
function added(before: Awaited<ReturnType<typeof effects>>, after: typeof before) {
  const diff = (b: { id: string; v: string }[], a: typeof b) => {
    const seen = new Set(b.map((r) => r.id));
    return a
      .filter((r) => !seen.has(r.id))
      .map((r) => r.v)
      .sort();
  };
  return {
    facts: diff(before.facts, after.facts),
    audit: diff(before.audit, after.audit),
    outbox: diff(before.outbox, after.outbox),
  };
}

const lockId = (key: string) => sql`hashtextextended(${key}, 0)`;

/** Ungranted locks of other backends: each blocked transaction waits on exactly one. */
const blocked = async (trx: Transaction<Database>) =>
  (
    await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND pid <> pg_backend_pid()`.execute(
      trx,
    )
  ).rows[0]?.n ?? 0;

/** Transactions blocked on the advisory lock `key`. */
const waitingOn = async (trx: Transaction<Database>, key: string) =>
  (
    await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
        AND ((classid::bigint << 32) | objid::bigint) = ${lockId(key)}`.execute(trx)
  ).rows[0]?.n ?? 0;

/** Tracks whether a writer's promise has settled, without consuming its outcome. */
function track<T>(p: Promise<T>) {
  const t = {
    settled: false,
    result: Promise.allSettled([p]).then(([r]) => r as PromiseSettledResult<T>),
  };
  void t.result.then(() => {
    t.settled = true;
  });
  return t;
}

/**
 * A database barrier: a third connection holds `contest:<contestId>` — the lifecycle lock — while
 * `start` launches the writers, and releases it only once `waiters` transactions are blocked
 * (on it, or on a lock a blocked writer holds). `during` runs while the lock is still held. A
 * writer that finishes while the lock is held did not take it: the barrier then releases at once,
 * so a missing serialization fails the test instead of hanging it.
 */
async function underContestLock<T>(
  contestId: string,
  waiters: number,
  start: () => Promise<T>[],
  during?: () => Promise<void>,
): Promise<PromiseSettledResult<T>[]> {
  const key = `contest:${contestId}`;
  let settled: Promise<PromiseSettledResult<T>[]> | undefined;
  await owner.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(${lockId(key)})`.execute(trx);
    const writers = start().map((p) => track(p));
    settled = Promise.all(writers.map((w) => w.result));
    while (
      !writers.some((w) => w.settled) &&
      ((await blocked(trx)) < waiters || (await waitingOn(trx, key)) < 1)
    );
    await during?.();
  });
  return settled as Promise<PromiseSettledResult<T>[]>;
}

/** Rolls back the third connection's transaction once `fn` is done. */
class Release extends Error {}
async function holding(fn: (trx: Transaction<Database>) => Promise<void>): Promise<void> {
  await owner
    .transaction()
    .execute(async (trx) => {
      await fn(trx);
      throw new Release();
    })
    .catch((err: unknown) => {
      if (!(err instanceof Release)) throw err;
    });
}

const reason = (r: PromiseSettledResult<unknown> | undefined) =>
  (r as PromiseRejectedResult).reason as { code: string; message: string };

/** 'ok', or the refusal's message: a failed assertion shows why a writer was refused. */
const outcome = (r: PromiseSettledResult<unknown> | undefined) =>
  r?.status === 'fulfilled' ? 'ok' : String(reason(r)?.message ?? r);

// ───────────────────────── the contest commands, racing each other ─────────────────────────

type Command = 'start' | 'complete' | 'cancel' | 'void';
const TARGET: Record<Command, ContestStatus> = {
  start: 'IN_PROGRESS',
  complete: 'COMPLETED',
  cancel: 'CANCELLED',
  void: 'VOID',
};
const AUDIT: Record<Command, string> = {
  start: 'contest.in-progress',
  complete: 'contest.completed',
  cancel: 'contest.cancelled',
  void: 'contest.void',
};
const OUTBOX: Record<Command, string> = {
  start: 'ContestStarted',
  complete: 'ContestCompleted',
  cancel: 'ContestCancelled',
  void: 'ContestVoided',
};

function run(store: StructureStore, actor: string, cmd: Command, contestId: string) {
  const input = { actorAccountId: actor, contestId };
  switch (cmd) {
    case 'start':
      return store.startContest(input);
    case 'complete':
      return store.completeContest(input);
    case 'cancel':
      return store.cancelContest({ ...input, reason: 'rain' });
    case 'void':
      return store.voidContest({ ...input, reason: 'walkover dispute' });
  }
}

/**
 * The outcome of running commands `cmds` from `from` one after the other in `order`: which succeed,
 * each refusal, and the final state. A serialized race must equal one of the serial orders.
 */
function serial(from: ContestStatus, cmds: readonly Command[], order: readonly number[]) {
  let s = from;
  const ok = cmds.map(() => false);
  const refusals: (string | null)[] = cmds.map(() => null);
  for (const i of order) {
    const to = TARGET[cmds[i] as Command];
    if (canTransition(ContestLifecycle, s, to)) {
      ok[i] = true;
      s = to;
    } else
      refusals[i] = `${DomainErrorCode.INVALID_TRANSITION}: cannot move a ${s} contest to ${to}`;
  }
  return { ok, refusals, final: s };
}

describe('G-1: the contest commands are serialized per contest', () => {
  let ev: Ev;
  const pool: string[] = [];
  /** A fresh SCHEDULED first-round contest; IN_PROGRESS / COMPLETED ones are started from it. */
  async function contestIn(status: ContestStatus): Promise<string> {
    const contestId = pool.shift() as string;
    expect(await statusOf(contestId)).toBe('SCHEDULED');
    if (status !== 'SCHEDULED') await run(structure, ev.actor, 'start', contestId);
    if (status === 'COMPLETED') await run(structure, ev.actor, 'complete', contestId);
    expect(await statusOf(contestId)).toBe(status);
    return contestId;
  }

  beforeAll(async () => {
    ev = await knockout(32, 4);
    expect(ev.r1).toHaveLength(16);
    // Version 1 publishes the sixteen first-round matches: all SCHEDULED. The event starts.
    const v1 = await openDraft(ev);
    for (const [i, contestId] of ev.r1.entries())
      await place(
        ev,
        v1,
        contestId,
        i % 4,
        `2027-06-01T${String(8 + Math.floor(i / 4) * 2).padStart(2, '0')}:00:00Z`,
      );
    await (
      await publication(ev, v1, null)
    )(schedule);
    await comps.startEvent({ actorAccountId: ev.actor, eventId: ev.eventId });
    pool.push(...ev.r1);
  }, 900_000);

  it('A–D, N–P: each command alone writes exactly one fact, its audit and its outbox event', async () => {
    const played = await contestIn('SCHEDULED');
    const rained = await contestIn('SCHEDULED');
    for (const [cmd, contestId] of [
      ['start', played],
      ['complete', played],
      ['void', played],
      ['cancel', rained],
    ] as const) {
      const before = await effects(contestId);
      await run(structure, ev.actor, cmd, contestId);
      expect(added(before, await effects(contestId))).toEqual({
        facts: [TARGET[cmd]],
        audit: [`${AUDIT[cmd]}:SUCCEEDED`],
        outbox: [OUTBOX[cmd]],
      });
    }
    expect(await expectValidHistory(played)).toEqual([
      'PLANNED',
      'SCHEDULED',
      'IN_PROGRESS',
      'COMPLETED',
      'VOID',
    ]);
    expect(await expectValidHistory(rained)).toEqual(['PLANNED', 'SCHEDULED', 'CANCELLED']);
  }, 120_000);

  it.each([
    ['E', 'start', 'start', 'SCHEDULED'],
    ['F', 'complete', 'complete', 'IN_PROGRESS'],
    ['G', 'cancel', 'cancel', 'SCHEDULED'],
    ['H', 'void', 'void', 'COMPLETED'],
    ['I', 'start', 'cancel', 'SCHEDULED'],
    ['J', 'start', 'void', 'SCHEDULED'],
    ['K', 'complete', 'cancel', 'IN_PROGRESS'],
    ['L', 'complete', 'void', 'IN_PROGRESS'],
    ['M', 'cancel', 'void', 'SCHEDULED'],
  ] as const)(
    '%s, Q, R: %s vs %s from %s — provably concurrent, the outcome of one serial order',
    async (_case, a, b, from) => {
      const contestId = await contestIn(from);
      const before = await effects(contestId);
      const [ra, rb] = await underContestLock(contestId, 2, () => [
        run(structure, ev.actor, a, contestId),
        run(structure2, ev.actor, b, contestId),
      ]);
      const ok = [ra?.status === 'fulfilled', rb?.status === 'fulfilled'];
      const observed = {
        ok,
        // A refusal names the state the refused writer read: for a loser, the winner's commit.
        refusals: [ra, rb].map((r) => (r?.status === 'rejected' ? reason(r).message : null)),
        final: await statusOf(contestId),
      };
      // Either writer may take the lock first; the outcome must be exactly that serial order's.
      expect([serial(from, [a, b], [0, 1]), serial(from, [a, b], [1, 0])]).toContainEqual(observed);
      // Exactly one fact, audit row and outbox event per successful command; none for a loser.
      const winners = ([a, b] as const).filter((_, i) => ok[i]);
      expect(added(before, await effects(contestId))).toEqual({
        facts: winners.map((c) => TARGET[c]).sort(),
        audit: winners.map((c) => `${AUDIT[c]}:SUCCEEDED`).sort(),
        outbox: winners.map((c) => OUTBOX[c]).sort(),
      });
      await expectValidHistory(contestId);
    },
    120_000,
  );

  it('W: the lock is per contest — another contest transitions while this one is held', async () => {
    const held = await contestIn('SCHEDULED');
    const other = await contestIn('SCHEDULED');
    // `during` runs while `held`'s lifecycle lock is taken and one writer is blocked on it: the
    // other contest's start completes regardless (it would hang here if it needed that lock).
    const [r] = await underContestLock(
      held,
      1,
      () => [run(structure, ev.actor, 'start', held)],
      async () => {
        await run(structure2, ev.actor, 'start', other);
        expect(await statusOf(other)).toBe('IN_PROGRESS');
        expect(await statusOf(held)).toBe('SCHEDULED');
      },
    );
    expect(outcome(r)).toBe('ok');
    expect(await statusOf(held)).toBe('IN_PROGRESS');
  }, 120_000);

  it('S–U: guards, authorization and reasons are unchanged, and a refusal writes nothing', async () => {
    const scheduled = await contestIn('SCHEDULED');
    const inProgress = await contestIn('IN_PROGRESS');
    const stranger = (await newTestAccount(identity, { label: 'stranger' })).accountId;
    const before = [await effects(scheduled), await effects(inProgress)];
    // S: the state machine.
    await expect(run(structure, ev.actor, 'complete', scheduled)).rejects.toMatchObject({
      code: DomainErrorCode.INVALID_TRANSITION,
      message: 'INVALID_TRANSITION: cannot move a SCHEDULED contest to COMPLETED',
    });
    await expect(run(structure, ev.actor, 'void', scheduled)).rejects.toMatchObject({
      code: DomainErrorCode.INVALID_TRANSITION,
    });
    await expect(run(structure, ev.actor, 'start', inProgress)).rejects.toMatchObject({
      code: DomainErrorCode.INVALID_TRANSITION,
      message: 'INVALID_TRANSITION: cannot move a IN_PROGRESS contest to IN_PROGRESS',
    });
    await expect(run(structure, ev.actor, 'cancel', inProgress)).rejects.toMatchObject({
      code: DomainErrorCode.INVALID_TRANSITION,
    });
    // T: no competition role, no transition.
    for (const [cmd, contestId] of [
      ['start', scheduled],
      ['cancel', scheduled],
      ['complete', inProgress],
      ['void', inProgress],
    ] as const)
      await expect(run(structure, stranger, cmd, contestId)).rejects.toMatchObject({
        code: DomainErrorCode.FORBIDDEN,
      });
    // U: cancel and void need a reason.
    for (const [cancel, contestId] of [
      [true, scheduled],
      [false, inProgress],
    ] as const)
      await expect(
        (async () =>
          (cancel ? structure.cancelContest : structure.voidContest).call(structure, {
            actorAccountId: ev.actor,
            contestId,
            reason: '  ',
          }))(),
      ).rejects.toMatchObject({ code: DomainErrorCode.INVALID_INPUT });
    expect([await effects(scheduled), await effects(inProgress)]).toEqual(before);
  }, 120_000);
});

// ───────────────────────── the other status writers (ONCF-05E-F-5 § 39) ─────────────────────────

describe('G-1: publication and the cancellation cascade take the same lifecycle lock', () => {
  let ev: Ev;
  let v1 = '';

  beforeAll(async () => {
    ev = await knockout(8, 2);
    expect([ev.r1.length, ev.later.length]).toEqual([4, 3]);
    // Version 1 publishes the first round; the semifinals stay PLANNED. The event starts.
    v1 = await openDraft(ev);
    for (const [i, contestId] of ev.r1.entries())
      await place(ev, v1, contestId, i % 2, `2027-06-01T${i < 2 ? '09' : '12'}:00:00Z`);
    await (
      await publication(ev, v1, null)
    )(schedule);
    await comps.startEvent({ actorAccountId: ev.actor, eventId: ev.eventId });
  }, 600_000);

  it('the § 39 interleaving: a publication paused after reading PLANNED, then a cancel', async () => {
    const x = ev.later[0] as string;
    const v2 = await openDraft(ev);
    await place(ev, v2, x, 0, '2027-06-03T10:00:00Z');
    const publish = await publication(ev, v2, v1);
    expect(await statusOf(x)).toBe('PLANNED');
    let pub: ReturnType<typeof track<unknown>> | undefined;
    let cancel: ReturnType<typeof track<unknown>> | undefined;
    // The third connection holds an uncommitted `contest_schedule` row for X: publication reads
    // X's status, then blocks on projecting X's schedule — between its read and its status write.
    await holding(async (trx) => {
      await sql`INSERT INTO competition.contest_schedule (contest_id, scheduled_start, updated_at, updated_by_account_id)
        VALUES (${x}, now(), now(), ${ev.actor})`.execute(trx);
      pub = track(publish(schedule));
      while (!pub.settled && (await blocked(trx)) < 1);
      // Now X is cancelled on another connection. Without serialization it commits at once.
      cancel = track(run(structure2, ev.actor, 'cancel', x));
      while (!cancel.settled && (await blocked(trx)) < 2);
    });
    const [p, c] = [await pub?.result, await cancel?.result];
    expect([outcome(p), outcome(c)]).toEqual(['ok', 'ok']);
    // Publication held X's lifecycle lock: the cancel waited and saw SCHEDULED, a valid source.
    expect(await expectValidHistory(x)).toEqual(['PLANNED', 'SCHEDULED', 'CANCELLED']);
  }, 180_000);

  it('publication vs cancel, provably concurrent — either order, never SCHEDULED after CANCELLED', async () => {
    const y = ev.later[1] as string;
    const base = (
      await sql<{ id: string }>`
        SELECT version_id AS id FROM competition.v_schedule_version_current
        WHERE competition_id = ${ev.competitionId} AND status = 'PUBLISHED'`.execute(owner)
    ).rows[0]?.id as string;
    const v3 = await openDraft(ev);
    await place(ev, v3, y, 1, '2027-06-03T10:00:00Z');
    const publish = await publication(ev, v3, base);
    const before = await effects(y);
    const [p, c] = await underContestLock<unknown>(y, 2, () => [
      publish(schedule),
      run(structure2, ev.actor, 'cancel', y),
    ]);
    // Cancel is valid from PLANNED and from SCHEDULED, so it succeeds in either order.
    expect(outcome(c)).toBe('ok');
    const h = await expectValidHistory(y);
    expect(h.at(-1)).toBe('CANCELLED');
    const scheduled = added(before, await effects(y)).facts.includes('SCHEDULED');
    if (scheduled) {
      // Publication first: it scheduled Y, and the cancel then saw SCHEDULED.
      expect(p?.status).toBe('fulfilled');
      expect(h).toEqual(['PLANNED', 'SCHEDULED', 'CANCELLED']);
    } else {
      // Cancel first: publication, re-reading after the lock, never schedules a CANCELLED contest.
      // It either refuses the changed report or publishes without a status fact for Y.
      expect(h).toEqual(['PLANNED', 'CANCELLED']);
      if (p?.status === 'rejected')
        expect(reason(p)).toMatchObject({ code: DomainErrorCode.CONCURRENCY_CONFLICT });
    }
  }, 180_000);

  it('start vs event cancellation, provably concurrent — the winner decides the loser', async () => {
    const z = ev.r1[0] as string;
    const others = ev.r1.slice(1) as string[];
    expect(await statusOf(z)).toBe('SCHEDULED');
    const before = await effects(z);
    const [s, e] = await underContestLock<unknown>(z, 2, () => [
      run(structure, ev.actor, 'start', z),
      comps2.cancelEvent({ actorAccountId: ev.actor, eventId: ev.eventId, reason: 'storm' }),
    ]);
    // The cascade only cancels PLANNED / SCHEDULED contests, so it always succeeds.
    expect(outcome(e)).toBe('ok');
    const h = await expectValidHistory(z);
    if (s?.status === 'fulfilled') {
      // Start first: the cascade, re-reading after the lock, leaves the IN_PROGRESS contest alone.
      expect(h).toEqual(['PLANNED', 'SCHEDULED', 'IN_PROGRESS']);
      expect(added(before, await effects(z)).facts).toEqual(['IN_PROGRESS']);
    } else {
      // Cascade first: start is refused by the state machine against CANCELLED.
      expect(reason(s)).toMatchObject({
        code: DomainErrorCode.INVALID_TRANSITION,
        message: 'INVALID_TRANSITION: cannot move a CANCELLED contest to IN_PROGRESS',
      });
      expect(h).toEqual(['PLANNED', 'SCHEDULED', 'CANCELLED']);
      expect(added(before, await effects(z))).toEqual({
        facts: ['CANCELLED'],
        audit: [],
        outbox: [],
      });
    }
    for (const contestId of others) {
      await expectValidHistory(contestId);
      expect(await statusOf(contestId)).toBe('CANCELLED');
    }
  }, 180_000);
});

describe('G-1: the § 39 interleaving of start and a competition cancellation', () => {
  it('a start paused after reading SCHEDULED, then the cascade: one transition, not two', async () => {
    const ev = await knockout(4, 1);
    const v1 = await openDraft(ev);
    for (const [i, contestId] of ev.r1.entries())
      await place(ev, v1, contestId, 0, `2027-06-01T${i === 0 ? '09' : '12'}:00:00Z`);
    await (
      await publication(ev, v1, null)
    )(schedule);
    await comps.startEvent({ actorAccountId: ev.actor, eventId: ev.eventId });
    const x = ev.r1[0] as string;
    expect(await statusOf(x)).toBe('SCHEDULED');
    let start: ReturnType<typeof track<unknown>> | undefined;
    let cascade: ReturnType<typeof track<unknown>> | undefined;
    // The third connection locks `contest_entry`, which start reads after the contest's and the
    // event's status: start is held between its status read and its status write.
    await holding(async (trx) => {
      await sql`LOCK TABLE competition.contest_entry IN ACCESS EXCLUSIVE MODE`.execute(trx);
      start = track(run(structure, ev.actor, 'start', x));
      while (!start.settled && (await blocked(trx)) < 1);
      cascade = track(
        comps2.cancelCompetition({
          actorAccountId: ev.actor,
          competitionId: ev.competitionId,
          reason: 'storm',
        }),
      );
      while (!cascade.settled && (await blocked(trx)) < 2);
    });
    const [s, c] = [await start?.result, await cascade?.result];
    expect([outcome(s), outcome(c)]).toEqual(['ok', 'ok']);
    // Start held X's lifecycle lock: the cascade waited, saw IN_PROGRESS and left X alone.
    expect(await expectValidHistory(x)).toEqual(['PLANNED', 'SCHEDULED', 'IN_PROGRESS']);
    expect(await expectValidHistory(ev.r1[1] as string)).toEqual([
      'PLANNED',
      'SCHEDULED',
      'CANCELLED',
    ]);
  }, 600_000);
});

// ───────────────────────── category level: competition cancellation vs event writers ─────────────────────────

/** A status history, in recording order. */
const statuses = async (table: string, column: string, id: string) =>
  (
    await sql<{ status: string }>`
      SELECT status FROM ${sql.table(`competition.${table}`)} WHERE ${sql.ref(column)} = ${id} ORDER BY seq`.execute(
      owner,
    )
  ).rows.map((r) => r.status);

/** The event's history is a path of the event state machine from DRAFT (BRT-05 § 3). */
async function expectValidEventHistory(eventId: string) {
  const h = (await statuses('event_status_change', 'event_id', eventId)) as EventStatus[];
  expect(h[0]).toBe('DRAFT');
  for (let i = 1; i < h.length; i++)
    expect(
      canTransition(EventLifecycle, h[i - 1] as EventStatus, h[i] as EventStatus),
      `${h.join(' → ')} is not a path of the event lifecycle`,
    ).toBe(true);
  return h;
}

/** The competition's history is a path of its state machine from DRAFT (BRT-05 § 2). */
async function expectValidCompetitionHistory(competitionId: string) {
  const h = (await statuses(
    'competition_status_change',
    'competition_id',
    competitionId,
  )) as CompetitionStatus[];
  expect(h[0]).toBe('DRAFT');
  for (let i = 1; i < h.length; i++)
    expect(
      canTransition(CompetitionLifecycle, h[i - 1] as CompetitionStatus, h[i] as CompetitionStatus),
      `${h.join(' → ')} is not a path of the competition lifecycle`,
    ).toBe(true);
  return h;
}

/** Every contest of the event: a valid path, and none still PLANNED or SCHEDULED once it is cancelled. */
async function expectContestsSettled(eventId: string) {
  const { rows } = await sql<{ id: string }>`
    SELECT id FROM competition.contest WHERE event_id = ${eventId} ORDER BY sequence`.execute(
    owner,
  );
  const cancelled =
    (await statuses('event_status_change', 'event_id', eventId)).at(-1) === 'CANCELLED';
  const out: ContestStatus[][] = [];
  for (const { id } of rows) {
    const h = await expectValidHistory(id);
    if (cancelled) expect(['PLANNED', 'SCHEDULED']).not.toContain(h.at(-1));
    out.push(h);
  }
  return out;
}

/**
 * A pinned interleaving: the third connection holds `pin` (a table lock), so `first` stops at its
 * first write — after the status reads it validates. `second` then runs until it blocks too (on a
 * lock `first` holds, or on the pin) or finishes. Without serialization `second` decides on the
 * state `first` has read but not yet changed.
 */
async function pinned<A, B>(
  pin: RawBuilder<unknown>,
  first: () => Promise<A>,
  second: () => Promise<B>,
): Promise<[PromiseSettledResult<A>, PromiseSettledResult<B>]> {
  let a: ReturnType<typeof track<A>> | undefined;
  let b: ReturnType<typeof track<B>> | undefined;
  await holding(async (trx) => {
    await pin.execute(trx);
    a = track(first());
    while (!a.settled && (await blocked(trx)) < 1);
    b = track(second());
    while (!b.settled && (await blocked(trx)) < 2);
  });
  return [
    (await a?.result) as PromiseSettledResult<A>,
    (await b?.result) as PromiseSettledResult<B>,
  ];
}

/** Blocks inserts of event status facts; reads of them go on. */
const EVENT_FACTS = sql`LOCK TABLE competition.event_status_change IN EXCLUSIVE MODE`;

const cancelCompetition = (store: CompetitionStore, ev: { competitionId: string; actor: string }) =>
  store.cancelCompetition({
    actorAccountId: ev.actor,
    competitionId: ev.competitionId,
    reason: 'storm',
  });

describe('H-2 category level: competition cancellation vs category start, complete and cancel', () => {
  it('A1: category start first (held after its status reads), then the cancellation', async () => {
    const ev = await knockout(2, 0);
    // Start reads the event and the competition, then the plan: the pin holds it there.
    const [s, c] = await pinned(
      sql`LOCK TABLE competition.event_plan IN ACCESS EXCLUSIVE MODE`,
      () => comps.startEvent({ actorAccountId: ev.actor, eventId: ev.eventId }),
      () => cancelCompetition(comps2, ev),
    );
    expect([outcome(s), outcome(c)]).toEqual(['ok', 'ok']);
    // The cascade waited for the start's event lock and cancelled the started category.
    expect((await expectValidEventHistory(ev.eventId)).slice(-3)).toEqual([
      'FIELD_LOCKED',
      'IN_PROGRESS',
      'CANCELLED',
    ]);
    expect(await expectContestsSettled(ev.eventId)).toEqual([['PLANNED', 'CANCELLED']]);
    expect((await expectValidCompetitionHistory(ev.competitionId)).at(-1)).toBe('CANCELLED');
  }, 600_000);

  it('A2: the cancellation first (held at its event write), then category start', async () => {
    const ev = await knockout(2, 0);
    const [c, s] = await pinned(
      EVENT_FACTS,
      () => cancelCompetition(comps2, ev),
      () => comps.startEvent({ actorAccountId: ev.actor, eventId: ev.eventId }),
    );
    expect(outcome(c)).toBe('ok');
    expect(reason(s)).toMatchObject({
      code: DomainErrorCode.INVALID_TRANSITION,
      message: 'INVALID_TRANSITION: cannot move a CANCELLED event to IN_PROGRESS',
    });
    expect((await expectValidEventHistory(ev.eventId)).slice(-2)).toEqual([
      'FIELD_LOCKED',
      'CANCELLED',
    ]);
    expect(await expectContestsSettled(ev.eventId)).toEqual([['PLANNED', 'CANCELLED']]);
    await expectValidCompetitionHistory(ev.competitionId);
  }, 600_000);

  it('B1: category completion first (held at its event write), then the cancellation', async () => {
    // ONCF-L6 (ADR-0078 §2.1): completion settles the outcome, so the final is played and
    // OFFICIAL first (published, started, completed, declared) — the race itself is unchanged.
    const ev = await knockout(2, 1);
    const ref = await referee(ev.competitionId);
    const final = ev.r1[0] as string;
    const v1 = await openDraft(ev);
    await place(ev, v1, final, 0, '2027-06-01T09:00:00Z');
    await (
      await publication(ev, v1, null)
    )(schedule);
    await comps.startEvent({ actorAccountId: ev.actor, eventId: ev.eventId });
    await structure.startContest({ actorAccountId: ev.actor, contestId: final });
    await structure.completeContest({ actorAccountId: ev.actor, contestId: final });
    await official(ev.actor, ref, final, {
      family: 'SETS_OF_GAMES',
      sets: [{ games: [6, 2] }, { games: [6, 3] }],
    });
    const [d, c] = await pinned(
      EVENT_FACTS,
      () => comps.completeEvent({ actorAccountId: ev.actor, eventId: ev.eventId }),
      () => cancelCompetition(comps2, ev),
    );
    expect([outcome(d), outcome(c)]).toEqual(['ok', 'ok']);
    // The cascade re-read the event under its lock: COMPLETED is terminal, so it was left alone.
    expect((await expectValidEventHistory(ev.eventId)).slice(-2)).toEqual([
      'IN_PROGRESS',
      'COMPLETED',
    ]);
    await expectContestsSettled(ev.eventId);
    expect((await expectValidCompetitionHistory(ev.competitionId)).at(-1)).toBe('CANCELLED');
  }, 600_000);

  it('B2: the cancellation first (held at its event write), then category completion', async () => {
    const ev = await knockout(2, 0);
    await comps.startEvent({ actorAccountId: ev.actor, eventId: ev.eventId });
    const [c, d] = await pinned(
      EVENT_FACTS,
      () => cancelCompetition(comps2, ev),
      () => comps.completeEvent({ actorAccountId: ev.actor, eventId: ev.eventId }),
    );
    expect(outcome(c)).toBe('ok');
    expect(reason(d)).toMatchObject({
      code: DomainErrorCode.INVALID_TRANSITION,
      message: 'INVALID_TRANSITION: cannot move a CANCELLED event to COMPLETED',
    });
    expect((await expectValidEventHistory(ev.eventId)).slice(-2)).toEqual([
      'IN_PROGRESS',
      'CANCELLED',
    ]);
    expect(await expectContestsSettled(ev.eventId)).toEqual([['PLANNED', 'CANCELLED']]);
  }, 600_000);

  it('C1: category cancellation first (held at its event write), then the competition’s', async () => {
    const ev = await knockout(2, 0);
    const [e, c] = await pinned(
      EVENT_FACTS,
      () => comps.cancelEvent({ actorAccountId: ev.actor, eventId: ev.eventId, reason: 'rain' }),
      () => cancelCompetition(comps2, ev),
    );
    expect([outcome(e), outcome(c)]).toEqual(['ok', 'ok']);
    // One CANCELLED for the event and one for its contest: never two.
    expect((await expectValidEventHistory(ev.eventId)).slice(-2)).toEqual([
      'FIELD_LOCKED',
      'CANCELLED',
    ]);
    expect(await expectContestsSettled(ev.eventId)).toEqual([['PLANNED', 'CANCELLED']]);
    expect((await expectValidCompetitionHistory(ev.competitionId)).at(-1)).toBe('CANCELLED');
  }, 600_000);

  it('C2: the competition’s cancellation first (held at its event write), then the category’s', async () => {
    const ev = await knockout(2, 0);
    const [c, e] = await pinned(
      EVENT_FACTS,
      () => cancelCompetition(comps2, ev),
      () => comps.cancelEvent({ actorAccountId: ev.actor, eventId: ev.eventId, reason: 'rain' }),
    );
    expect(outcome(c)).toBe('ok');
    expect(reason(e)).toMatchObject({
      code: DomainErrorCode.INVALID_TRANSITION,
      message: 'INVALID_TRANSITION: cannot move a CANCELLED event to CANCELLED',
    });
    expect((await expectValidEventHistory(ev.eventId)).slice(-2)).toEqual([
      'FIELD_LOCKED',
      'CANCELLED',
    ]);
    expect(await expectContestsSettled(ev.eventId)).toEqual([['PLANNED', 'CANCELLED']]);
  }, 600_000);
});

// ───────────────────────── category level: competition cancellation vs a 05D-materialized contest ─────────────────────────

/** A results-authority referee for the competition (the 05E-F-4 fixture: PLATFORM anchor → PERSON). */
async function referee(competitionId: string) {
  const platform = await authority.registerPrincipal({
    principalType: 'PLATFORM',
    label: 'platform (05E-H-2)',
  });
  await authority.recognizeTrustAnchor({
    principalId: platform.id,
    recognitionScope: { recognitionLevel: ['PLATFORM'] },
    basisRef: 'fixture',
    governanceDecisionRef: `fx-${newId()}`,
  });
  const ref = await authority.registerPrincipal({
    principalType: 'PERSON',
    label: 'referee (05E-H-2)',
  });
  await authority.issueGrant({
    actorPrincipalId: platform.id,
    grantorPrincipalId: platform.id,
    granteePrincipalId: ref.id,
    capabilities: ['SUBMIT_RESULT', 'ACCEPT_RESULT', 'DECLARE_OFFICIAL', 'CORRECT_RESULT'] as never,
    scope: { recognitionLevel: ['PLATFORM'], competition: [competitionId as Uuid] },
    delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
  });
  return ref.id;
}

/** An OFFICIAL result through the ResultLedger, validated under the pinned ruleset (as 05D). */
async function official(actor: string, ref: Uuid, contestId: string, sheet: ScoreSheet) {
  const v = await scoring.validateScoreSheet({ actorAccountId: actor, contestId, sheet });
  if (!v.ok) throw new Error(JSON.stringify(v.issues));
  await playContest({ db, comps, structure }, actor, contestId);
  const result = await ledger.createResult({
    scopeType: 'CONTEST',
    scopeTargetId: contestId as Uuid,
  });
  const scope = await resolver.scopeOf('CONTEST', contestId, { recognitionLevel: 'PLATFORM' });
  const { draftId } = await ledger.saveDraft({
    resultId: result.id,
    authorPrincipalId: ref,
    disciplineVersionRef: 'oncf05e-h2@1',
    content: v.content,
  });
  const sub = await ledger.submitDraft({
    draftId,
    actorPrincipalId: ref,
    scope,
    idempotencyKey: k(),
  });
  for (const toStatus of ['PROVISIONAL', 'OFFICIAL'] as const)
    await ledger.transition({
      resultVersionId: sub.resultVersionId,
      toStatus,
      actorPrincipalId: ref,
      scope,
      idempotencyKey: k(),
    });
}

/**
 * A golf stroke-play category (3 rounds, cut after round 2) whose rounds 1–2 are OFFICIAL: the cut
 * field is resolved but not committed, so committing it materializes the three round-3 contests
 * (the 05E-F-4 fixture). Returns the commit, ready to run.
 */
async function golfCut() {
  const org = await newOrganizer(identity, orgs);
  const actor = org.ownerAccountId;
  const { competitionId } = await comps.createCompetition({
    actorAccountId: actor,
    organizerOrganizationId: org.organizationId,
    slug: uniqueSlug('comp'),
    profile: { name: 'ONCF-05E-H-2 Open', timezone: 'America/Costa_Rica' },
    idempotencyKey: k(),
  });
  await comps.publishCompetition({ actorAccountId: actor, competitionId });
  await comps.activateCompetition({ actorAccountId: actor, competitionId });
  // The referee's grant is recorded before the event setup, well before its first use.
  const ref = await referee(competitionId);
  const { eventId } = await comps.createEvent({
    actorAccountId: actor,
    competitionId,
    slug: uniqueSlug('ev'),
    disciplineVersionId: ids['golf'] as string,
    formatVersionId: ids['mr'] as string,
    formatConfig: { rounds: 3, cutAfterRound: 2, cutTopN: 2, cutIncludesTies: true, groupSize: 3 },
    settings: {
      name: 'Stroke play',
      capacity: null,
      registrationMode: 'AUTO_CONFIRM',
      startsAt: '2027-09-01T12:00:00Z',
      endsAt: '2027-09-08T12:00:00Z',
    },
    idempotencyKey: k(),
  });
  await comps.openRegistration({ actorAccountId: actor, eventId });
  await scoring.pinScoring({
    actorAccountId: actor,
    eventId,
    rulesetVersionId: ids['rs:golf'] as string,
    advancementPolicyVersionId: ids['ap:cut'] as string,
    classificationTemplateVersionId: ids['tp:golf'] as string,
    idempotencyKey: k(),
  });
  for (let i = 0; i < 5; i++) {
    const a = await newAthlete(identity, `g${i}`, `Golfer ${i}`);
    await comps.register({
      actorAccountId: a.accountId,
      eventId,
      athleteId: a.athleteId,
      eligibilityDeclared: true,
      idempotencyKey: k(),
    });
  }
  await comps.closeRegistration({ actorAccountId: actor, eventId });
  await configureAdvancementFixture(db, actor, eventId);
  await structure.lockField({ actorAccountId: actor, eventId, idempotencyKey: k() });
  await structure.seedField({
    actorAccountId: actor,
    eventId,
    idempotencyKey: k(),
    method: 'DETERMINISTIC_DRAW',
  });
  await structure.generatePlan({ actorAccountId: actor, eventId, idempotencyKey: k() });
  const { rows: contests } = await sql<{ id: string; round: number }>`
    SELECT c.id, r.sequence AS round FROM competition.contest c
    JOIN competition.round r ON r.id = c.round_id WHERE c.event_id = ${eventId}
    ORDER BY r.sequence, c.sequence`.execute(owner);
  const { rows: occ } = await sql<{ contest_id: string; participant_id: string }>`
    SELECT contest_id, participant_id FROM competition.v_contest_occupant
    WHERE contest_id = ANY(${contests.map((c) => c.id)}::uuid[])`.execute(owner);
  const players = [...new Set(occ.map((o) => o.participant_id))].sort();
  expect(players).toHaveLength(5);
  const card: Record<number, number[]> = { 1: [70, 71, 72, 75, 72], 2: [70, 71, 70, 75, -1] };
  const holes = (total: number) =>
    Array.from(
      { length: 18 },
      (_, i) => 4 + (i < Math.abs(total - 72) ? Math.sign(total - 72) : 0),
    );
  for (const c of contests) {
    const p = occ.find((o) => o.contest_id === c.id)?.participant_id as string;
    const strokes = card[c.round]?.[players.indexOf(p)] as number;
    await official(actor, ref, c.id, {
      family: 'STROKES',
      entries: [
        strokes < 0
          ? { participantId: p, status: 'DNF' }
          : { participantId: p, status: 'FINISHED', holes: holes(strokes) },
      ],
    });
  }
  const s = await advancement.state({ actorAccountId: actor, eventId });
  const units = s.units.filter((u) => u.unitKey.startsWith('field:'));
  expect(units.flatMap((u) => u.targets.map((t) => t.proposed.state))).toEqual([
    'RESOLVED',
    'RESOLVED',
    'RESOLVED',
  ]);
  return {
    competitionId,
    eventId,
    actor,
    known: contests.map((c) => c.id),
    commitCut: () =>
      advancement.commit({
        actorAccountId: actor,
        eventId,
        units: units.map((u) => ({ unitKey: u.unitKey, previewHash: u.previewHash })),
        idempotencyKey: k(),
      }),
  };
}

const contestsOf = async (eventId: string) =>
  (
    await sql<{
      id: string;
    }>`SELECT id FROM competition.contest WHERE event_id = ${eventId}`.execute(owner)
  ).rows.map((r) => r.id);

describe('H-2 category level: competition cancellation vs an advancement-created contest', () => {
  it('D1: the cut commit first (held at its contest insert), then the cancellation', async () => {
    const g = await golfCut();
    // The commit reads the event's status under `event-structure`, then materializes round 3:
    // the pin blocks its writes to `contest`.
    const [a, c] = await pinned(
      sql`LOCK TABLE competition.contest IN EXCLUSIVE MODE`,
      () => g.commitCut(),
      () => cancelCompetition(comps2, g),
    );
    expect([outcome(a), outcome(c)]).toEqual(['ok', 'ok']);
    expect(
      (a as PromiseFulfilledResult<{ materializedContests: number }>).value.materializedContests,
    ).toBe(3);
    // The cascade waited for `event-structure`, so it saw the three new contests and cancelled them.
    const created = (await contestsOf(g.eventId)).filter((id) => !g.known.includes(id));
    expect(created).toHaveLength(3);
    for (const id of created)
      expect(await expectValidHistory(id)).toEqual(['PLANNED', 'CANCELLED']);
    expect((await expectValidEventHistory(g.eventId)).at(-1)).toBe('CANCELLED');
    await expectContestsSettled(g.eventId);
  }, 600_000);

  it('D2: the cancellation first (held at its event write), then the cut commit', async () => {
    const g = await golfCut();
    const [c, a] = await pinned(
      EVENT_FACTS,
      () => cancelCompetition(comps2, g),
      () => g.commitCut(),
    );
    expect(outcome(c)).toBe('ok');
    // The commit waited for `event-structure` and re-read a CANCELLED event: nothing is created.
    expect(reason(a)).toMatchObject({
      code: DomainErrorCode.INVALID_TRANSITION,
      message: 'INVALID_TRANSITION: advancement is closed for a CANCELLED event',
    });
    expect((await contestsOf(g.eventId)).sort()).toEqual([...g.known].sort());
    expect((await expectValidEventHistory(g.eventId)).at(-1)).toBe('CANCELLED');
    await expectContestsSettled(g.eventId);
  }, 600_000);
});
