import {
  CANONICAL_CATALOG,
  RULESET_TEMPLATES,
  SCHEDULING_PROFILE_TEMPLATES,
} from '@br/competition';
import type { ContestStatus, DisciplineVersionSpec } from '@br/competition';
import { newId } from '@br/domain';
import {
  apiDb,
  maintenanceDb,
  newAthlete,
  newOrganizer,
  newTestAccount,
  operatorDb,
  ownerDb,
  uniqueSlug,
} from '@br/testkit';
import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CatalogStore } from './catalog-store';
import { refreshEventReadModels } from './competition-projection';
import { CompetitionReader } from './competition-reader';
import { CompetitionStore } from './competition-store';
import { StructureStore } from './competition-structure-store';
import type { Database } from './db';
import { IdentityStore } from './identity-store';
import { OrganizationStore } from './organization-store';
import { ResourceStore } from './resource-store';
import { ScheduleStore } from './schedule-store';
import { ScoringStore } from './scoring-store';
import { inTransaction, ModuleRole } from './tx';

/**
 * ONCF-05E-R1: concurrent refreshes of one event's read models. Writers of different contests of
 * one event take different `contest:<id>` locks, so they overlap and both refresh the event. The
 * refresh deletes and re-inserts the event's rows; unserialized, a refresh that waited on another's
 * delete re-inserts over the other's committed row and fails on `event_summary_pkey`. The refresh
 * now takes the event's `event-read-model:<id>` lock first, so concurrent refreshes of one event
 * run one after the other and each sees every earlier committed fact.
 *
 * Races are real: each writer runs on its own pool, and a third connection holds the event's
 * `event_summary` row (FOR UPDATE) until every writer is blocked (`pg_locks`), i.e. has written
 * its status fact and reached the refresh. No timing is involved.
 */

const db = apiDb();
const db2 = apiDb();
const db3 = apiDb();
const owner = ownerDb();
const operator = operatorDb();
const maintenance = maintenanceDb();
afterAll(async () => {
  await Promise.all([db, db2, db3, owner, operator, maintenance].map((d) => d.destroy()));
});
const identity = new IdentityStore(db);
const orgs = new OrganizationStore(db);
const catalog = new CatalogStore(operator);
const comps = new CompetitionStore(db);
const structures = [new StructureStore(db), new StructureStore(db2), new StructureStore(db3)];
const structure = structures[0] as StructureStore;
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
          name: 'ONCF-05E-R1 test sport',
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
    if (r.code === `r${tag}-sets-bo3-tiebreak`) ids['rs'] = r.versionId;
  for (const p of listed.schedulingProfileVersions)
    if (p.code.startsWith(`p${tag}-`)) ids['sp'] = p.versionId;
}, 240_000);

interface Ev {
  eventId: string;
  actor: string;
  /** The published first-round contests (SCHEDULED), in plan order. */
  r1: string[];
}

/** A started tennis knockout of eight whose four first-round matches are published. */
async function startedKnockout(): Promise<Ev> {
  const org = await newOrganizer(identity, orgs);
  const actor = org.ownerAccountId;
  const { competitionId } = await comps.createCompetition({
    actorAccountId: actor,
    organizerOrganizationId: org.organizationId,
    slug: uniqueSlug('comp'),
    profile: { name: 'ONCF-05E-R1 Fest', timezone: 'America/Costa_Rica' },
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
  for (let i = 0; i < 8; i++) {
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
  const { rows } = await sql<{ id: string }>`
    SELECT c.id FROM competition.contest c
    JOIN competition.round r ON r.id = c.round_id WHERE c.event_id = ${eventId} AND r.sequence = 1
    ORDER BY c.sequence`.execute(owner);
  const courts: string[] = [];
  for (let i = 0; i < 2; i++)
    courts.push(
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
  for (const weekday of [1, 2, 3, 4, 5, 6, 7])
    await resources.addAvailability({
      actorAccountId: actor,
      competitionId,
      resourceId: null,
      fact: { kind: 'WEEKLY', weekday, start: '00:00', end: '24:00' },
      idempotencyKey: k(),
    });
  const { versionId } = await schedule.openDraft({
    actorAccountId: actor,
    competitionId,
    idempotencyKey: k(),
  });
  for (const [i, { id }] of rows.entries())
    await schedule.setAssignment({
      actorAccountId: actor,
      versionId,
      contestId: id,
      assignment: {
        resourceId: courts[i % 2] as string,
        startsAt: `2027-06-01T${i < 2 ? '09' : '12'}:00:00Z`,
      },
      expectedLastFactId: null,
      idempotencyKey: k(),
    });
  const r = await schedule.validate({ actorAccountId: actor, versionId });
  expect(r.conflicts.filter((c) => c.severity === 'HARD')).toEqual([]);
  await schedule.publish({
    actorAccountId: actor,
    versionId,
    baseVersionId: null,
    reportHash: r.reportHash,
    acknowledgedConflictKeys: r.conflicts
      .filter((c) => c.severity === 'SOFT')
      .map((c) => c.conflictKey),
    idempotencyKey: k(),
  });
  await comps.startEvent({ actorAccountId: actor, eventId });
  return { eventId, actor, r1: rows.map((x) => x.id) };
}

/** Ungranted locks of other backends: each blocked transaction waits on exactly one. */
const blocked = async (trx: Transaction<Database>) =>
  (
    await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND pid <> pg_backend_pid()`.execute(
      trx,
    )
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
 * A database barrier at the refresh point: a third connection locks the event's `event_summary`
 * row while `start` launches the writers, and commits (writing nothing) only once `waiters`
 * transactions are blocked — on that row, or on a lock a blocked writer holds. A writer only
 * touches the row in the refresh, after its status fact, so every writer has reached the refresh.
 * A writer that settles first releases the barrier at once, so a failure cannot hang the test.
 */
async function atRefresh<T>(
  eventId: string,
  waiters: number,
  start: () => Promise<T>[],
): Promise<PromiseSettledResult<T>[]> {
  let settled: Promise<PromiseSettledResult<T>[]> | undefined;
  await owner.transaction().execute(async (trx) => {
    const { rows } = await sql`
      SELECT event_id FROM competition_read.event_summary WHERE event_id = ${eventId} FOR UPDATE`.execute(
      trx,
    );
    expect(rows).toHaveLength(1);
    const writers = start().map((p) => track(p));
    settled = Promise.all(writers.map((w) => w.result));
    while (!writers.some((w) => w.settled) && (await blocked(trx)) < waiters);
    expect(writers.some((w) => w.settled)).toBe(false);
  });
  return settled as Promise<PromiseSettledResult<T>[]>;
}

/** 'ok', or the failure (with its constraint, for a unique violation). */
const outcome = (r: PromiseSettledResult<unknown> | undefined) => {
  if (r?.status === 'fulfilled') return 'ok';
  const err = (r as PromiseRejectedResult).reason as { message?: string; constraint?: string };
  return `${String(err?.message ?? err)}${err?.constraint === undefined ? '' : ` [${err.constraint}]`}`;
};

const READ_MODELS = {
  event_summary: 'event_id',
  event_slug: 'slug',
  event_entry: 'registration_id',
  round_card: 'round_id',
  contest_card: 'contest_id',
} as const;

/** Every read-model row of an event, in a stable order. */
async function readModels(eventId: string) {
  const out: Record<string, unknown[]> = {};
  for (const [t, order] of Object.entries(READ_MODELS))
    out[t] = (
      await sql`SELECT * FROM ${sql.raw(`competition_read.${t}`)} WHERE event_id = ${eventId}
        ORDER BY ${sql.raw(order)}`.execute(owner)
    ).rows;
  return out;
}

/**
 * The read models are the authoritative state: one summary row, each card's status the contest's
 * current fact, and a recomputation from canonical facts (as the full rebuild does) changes nothing.
 */
async function expectAuthoritative(eventId: string, expected: Record<string, ContestStatus>) {
  const maintained = await readModels(eventId);
  expect(maintained['event_summary']).toHaveLength(1);
  const { rows: current } = await sql<{ contest_id: string; status: ContestStatus }>`
    SELECT v.contest_id, v.status FROM competition.v_contest_current v
    JOIN competition.contest c ON c.id = v.contest_id WHERE c.event_id = ${eventId}`.execute(owner);
  const cards = maintained['contest_card'] as { contest_id: string; status: string }[];
  expect(Object.fromEntries(cards.map((c) => [c.contest_id, c.status]))).toEqual(
    Object.fromEntries(current.map((c) => [c.contest_id, c.status])),
  );
  for (const [contestId, status] of Object.entries(expected))
    expect(cards.find((c) => c.contest_id === contestId)?.status).toBe(status);
  await inTransaction(maintenance, ModuleRole.rebuild, (ctx) =>
    refreshEventReadModels(ctx, eventId),
  );
  expect(await readModels(eventId)).toEqual(maintained);
}

const history = async (contestId: string) =>
  (
    await sql<{ status: ContestStatus }>`
      SELECT status FROM competition.contest_status_change WHERE contest_id = ${contestId} ORDER BY seq`.execute(
      owner,
    )
  ).rows.map((r) => r.status);

describe('R1: concurrent refreshes of one event serialize', () => {
  it('two staff start different matches of one category at once: both succeed', async () => {
    const ev = await startedKnockout();
    const [a, b] = ev.r1 as [string, string];
    const results = await atRefresh(ev.eventId, 2, () => [
      structures[0]!.startContest({ actorAccountId: ev.actor, contestId: a }),
      structures[1]!.startContest({ actorAccountId: ev.actor, contestId: b }),
    ]);
    expect(results.map(outcome)).toEqual(['ok', 'ok']);
    for (const c of [a, b])
      expect(await history(c)).toEqual(['PLANNED', 'SCHEDULED', 'IN_PROGRESS']);
    await expectAuthoritative(ev.eventId, { [a]: 'IN_PROGRESS', [b]: 'IN_PROGRESS' });
  }, 600_000);

  it('three writers (start, start, cancel) of one category at once: no update is lost', async () => {
    const ev = await startedKnockout();
    const [a, b, c] = ev.r1 as [string, string, string];
    const results = await atRefresh(ev.eventId, 3, () => [
      structures[0]!.startContest({ actorAccountId: ev.actor, contestId: a }),
      structures[1]!.startContest({ actorAccountId: ev.actor, contestId: b }),
      structures[2]!.cancelContest({ actorAccountId: ev.actor, contestId: c, reason: 'rain' }),
    ]);
    expect(results.map(outcome)).toEqual(['ok', 'ok', 'ok']);
    expect(await history(c)).toEqual(['PLANNED', 'SCHEDULED', 'CANCELLED']);
    await expectAuthoritative(ev.eventId, {
      [a]: 'IN_PROGRESS',
      [b]: 'IN_PROGRESS',
      [c]: 'CANCELLED',
    });
  }, 600_000);
});
