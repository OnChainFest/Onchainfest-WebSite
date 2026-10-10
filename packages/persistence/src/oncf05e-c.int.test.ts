import {
  BOWLING_SINGLES_V2,
  CANONICAL_CATALOG,
  GOLF_INDIVIDUAL_V2,
  RESOURCE_TYPE_DEFAULT_OCCUPANCY_MODE,
  RULESET_TEMPLATES,
  SCHEDULING_PROFILE_TEMPLATES,
  type DisciplineVersionSpec,
} from '@br/competition';
import { DomainErrorCode, newId } from '@br/domain';
import {
  apiDb,
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
 * ONCF-05E-C through the real stores: competition schedule versions (private DRAFT → validated
 * PUBLISHED → SUPERSEDED; DISCARDED terminal), append-only per-contest assignments (≤ 1 resource,
 * concrete interval, stored changeover, derived unit key, provisional / locked), explicit human
 * publication against the canonical conflict report, the contest_schedule projection, the declared
 * resource occupancy mode and the legacy migration. Feasibility (overlap, capacity, spacing,
 * participants, rest, dependencies, availability, daily limits) is never judged here: that is 05E-D.
 */

const db = apiDb();
const owner = ownerDb();
const operator = operatorDb();
afterAll(async () => {
  await Promise.all([db, owner, operator].map((d) => d.destroy()));
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
const v2 = (code: string) =>
  CANONICAL_CATALOG.sports.flatMap((s) => s.disciplines).find((d) => d.code === code)
    ?.specs[1] as DisciplineVersionSpec;
const RS = ['sets-bo3-tiebreak', 'bowling-6-games-scratch', 'golf-stroke-gross'];

beforeAll(async () => {
  const op = (await newTestAccount(identity, { withPerson: false, label: 'operator' })).accountId;
  const d = (code: string, specs: DisciplineVersionSpec[]) => ({
    code: `z${tag}.${code}`,
    name: code,
    specs,
  });
  const f = (code: string, engineId: string, engineVersion = 1) => ({
    code: `${code}-${tag}`,
    name: code,
    versions: [{ engineId, engineVersion }],
  });
  const report = await catalog.provision({
    operatorAccountId: op,
    manifest: {
      sports: [
        {
          code: `z${tag}`,
          name: 'ONCF-05E-C test sport',
          disciplines: [
            d('tennis', [v2('tennis.singles')]),
            d('bowling', [BOWLING_SINGLES_V2]),
            d('golf', [GOLF_INDIVIDUAL_V2]),
          ],
        },
      ],
      formats: [
        f('se', 'single-elimination', 2),
        f('qk', 'qualifying-knockout'),
        f('mr', 'multi-round'),
      ],
      rulesets: RULESET_TEMPLATES.filter((t) => RS.includes(t.code)).map((t) => ({
        code: `r${tag}-${t.code}`,
        name: t.name,
        versions: [{ spec: t.spec, basis: t.basis }],
      })),
      schedulingProfiles: SCHEDULING_PROFILE_TEMPLATES.map((t) => ({
        code: `p${tag}-${t.code}`,
        name: t.name,
        versions: [{ spec: t.spec, basis: t.basis }],
      })),
    },
  });
  expect(report.conflicts).toEqual([]);
  const listed = await reader.catalog();
  for (const x of listed.disciplineVersions)
    if (x.discipline.code.startsWith(`z${tag}.`))
      ids[x.discipline.code.split('.')[1] as string] = x.disciplineVersionId;
  for (const fv of listed.formatVersions)
    if (fv.format.code.endsWith(`-${tag}`))
      ids[fv.format.code.split('-')[0] as string] = fv.formatVersionId;
  for (const r of listed.rulesetVersions)
    if (r.code.startsWith(`r${tag}-`)) ids[`rs:${r.code.slice(`r${tag}-`.length)}`] = r.versionId;
  for (const p of listed.schedulingProfileVersions)
    if (p.code.startsWith(`p${tag}-`)) ids[`sp:${p.code.slice(`p${tag}-`.length)}`] = p.versionId;
}, 240_000);

interface Ev {
  eventId: string;
  competitionId: string;
  actor: string;
  contests: { id: string; planKey: string; roundSequence: number }[];
}

/** An event with a locked, seeded field and a generated plan; optionally a pinned profile. */
async function plannedEvent(opts: {
  discipline: string;
  format: string;
  ruleset?: string;
  profile?: string;
  entrants: number;
  formatConfig?: Record<string, unknown>;
  window?: { startsAt: string; endsAt: string };
  competitionId?: string;
  actor?: string;
}): Promise<Ev> {
  let competitionId = opts.competitionId;
  let actor = opts.actor;
  if (competitionId === undefined || actor === undefined) {
    const org = await newOrganizer(identity, orgs);
    actor = org.ownerAccountId;
    competitionId = (
      await comps.createCompetition({
        actorAccountId: actor,
        organizerOrganizationId: org.organizationId,
        slug: uniqueSlug('comp'),
        profile: { name: 'ONCF-05E-C Fest', timezone: 'America/Costa_Rica' },
        idempotencyKey: k(),
      })
    ).competitionId;
    await comps.publishCompetition({ actorAccountId: actor, competitionId });
    await comps.activateCompetition({ actorAccountId: actor, competitionId });
  }
  const { eventId } = await comps.createEvent({
    actorAccountId: actor,
    competitionId,
    slug: uniqueSlug('ev'),
    disciplineVersionId: ids[opts.discipline] as string,
    formatVersionId: ids[opts.format] as string,
    formatConfig: opts.formatConfig ?? {},
    settings: {
      name: 'Category',
      capacity: null,
      registrationMode: 'AUTO_CONFIRM',
      ...(opts.window ?? {}),
    },
    idempotencyKey: k(),
  });
  await comps.openRegistration({ actorAccountId: actor, eventId });
  if (opts.ruleset !== undefined)
    await scoring.pinScoring({
      actorAccountId: actor,
      eventId,
      rulesetVersionId: ids[`rs:${opts.ruleset}`] as string,
      ...(opts.profile === undefined
        ? {}
        : { schedulingProfileVersionId: ids[`sp:${opts.profile}`] as string }),
      idempotencyKey: k(),
    });
  for (let i = 0; i < opts.entrants; i++) {
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
  const { rows } = await sql<{ id: string; plan_key: string; round_sequence: number }>`
    SELECT c.id, c.plan_key, r.sequence AS round_sequence FROM competition.contest c
    JOIN competition.round r ON r.id = c.round_id WHERE c.event_id = ${eventId}
    ORDER BY c.sequence`.execute(owner);
  return {
    eventId,
    competitionId,
    actor,
    contests: rows.map((r) => ({ id: r.id, planKey: r.plan_key, roundSequence: r.round_sequence })),
  };
}

const resource = async (
  ev: Pick<Ev, 'competitionId' | 'actor'>,
  typeCode: string,
  label: string,
  extra: Record<string, unknown> = {},
) =>
  (
    await resources.createResource({
      actorAccountId: ev.actor,
      competitionId: ev.competitionId,
      typeCode,
      resource: { label, ...extra },
      idempotencyKey: k(),
    })
  ).resourceId;

const rejects = (p: Promise<unknown>, code: DomainErrorCode, reason?: string) =>
  expect(p).rejects.toMatchObject({
    code,
    ...(reason === undefined ? {} : { details: { reason } }),
  });

const count = async (q: string) =>
  Number((await sql.raw<{ n: string }>(q).execute(owner)).rows[0]?.n);

async function staff(
  ev: Pick<Ev, 'competitionId' | 'actor'>,
  role: 'SCHEDULER' | 'REGISTRATION_MANAGER',
) {
  const a = await newTestAccount(identity);
  await comps.assignStaff({
    actorAccountId: ev.actor,
    competitionId: ev.competitionId,
    personId: a.personId as string,
    role,
    idempotencyKey: k(),
  });
  return a.accountId;
}

async function publishNow(
  actor: string,
  versionId: string,
  baseVersionId: string | null,
  ack?: string[],
) {
  const r = await schedule.validate({ actorAccountId: actor, versionId });
  return schedule.publish({
    actorAccountId: actor,
    versionId,
    baseVersionId,
    reportHash: r.reportHash,
    acknowledgedConflictKeys:
      ack ?? r.conflicts.filter((c) => c.severity === 'SOFT').map((c) => c.conflictKey),
    idempotencyKey: k(),
  });
}

// ───────────────────────────── the draft / publication lifecycle ─────────────────────────────

describe('a tennis knockout on courts: drafts, assignments, publication, history', () => {
  let ev: Ev;
  let court1 = '';
  let court2 = '';
  let v1 = '';
  const [s1, s2, fin] = ['2027-06-01T15:00:00Z', '2027-06-01T15:00:00Z', '2027-06-02T16:00:00Z'];

  beforeAll(async () => {
    ev = await plannedEvent({
      discipline: 'tennis',
      format: 'se',
      ruleset: 'sets-bo3-tiebreak',
      profile: 'tennis-court-match',
      entrants: 4,
    });
    court1 = await resource(ev, 'TENNIS_COURT', 'Court 1');
    court2 = await resource(ev, 'TENNIS_COURT', 'Court 2');
  }, 240_000);

  it('opens one private draft with a deterministic version number', async () => {
    const d = await schedule.openDraft({
      actorAccountId: ev.actor,
      competitionId: ev.competitionId,
      idempotencyKey: k(),
    });
    expect(d).toMatchObject({ versionNumber: 1, baseVersionId: null, created: true });
    v1 = d.versionId;
    await rejects(
      schedule.openDraft({
        actorAccountId: ev.actor,
        competitionId: ev.competitionId,
        idempotencyKey: k(),
      }),
      DomainErrorCode.ALREADY_EXISTS,
      'DRAFT_OPEN',
    );
  });

  it('persists the concrete interval, stored changeover, one resource, the unit key and the provisional flag', async () => {
    const [semi1, semi2, final] = ev.contests;
    await schedule.setAssignment({
      actorAccountId: ev.actor,
      versionId: v1,
      contestId: semi1!.id,
      assignment: { resourceId: court1, startsAt: s1 },
      idempotencyKey: k(),
    });
    // Same court, same time: 05E-C records it; whether it conflicts is 05E-D's decision.
    await schedule.setAssignment({
      actorAccountId: ev.actor,
      versionId: v1,
      contestId: semi2!.id,
      assignment: { resourceId: court1, startsAt: s2, courtLabel: 'Centre' },
      idempotencyKey: k(),
    });
    await schedule.setAssignment({
      actorAccountId: ev.actor,
      versionId: v1,
      contestId: final!.id,
      assignment: {
        resourceId: court2,
        startsAt: fin,
        expectedEnd: '2027-06-02T18:30:00Z',
        changeoverSeconds: 0,
      },
      idempotencyKey: k(),
    });
    const v = await schedule.getVersion({ actorAccountId: ev.actor, versionId: v1 });
    const byContest = new Map(v.assignments.map((a) => [a.contestId, a]));
    // Profile defaults stamped at write time: 5 400 s duration, 600 s changeover.
    expect(byContest.get(semi1!.id)).toMatchObject({
      resourceId: court1,
      startsAt: '2027-06-01T15:00:00.000Z',
      expectedEnd: '2027-06-01T16:30:00.000Z',
      changeoverSeconds: 600,
      unitKey: `contest:${semi1!.id}`,
      provisional: false,
      locked: false,
      source: 'MANUAL',
      zone: 'America/Costa_Rica',
    });
    // Explicit values win; the final's places are unresolved, so it is provisional.
    expect(byContest.get(final!.id)).toMatchObject({
      expectedEnd: '2027-06-02T18:30:00.000Z',
      changeoverSeconds: 0,
      provisional: true,
    });
    // One resource per assignment is the schema itself.
    const { rows } = await sql<{ data_type: string }>`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'competition' AND table_name = 'schedule_assignment' AND column_name = 'resource_id'`.execute(
      owner,
    );
    expect(rows).toEqual([{ data_type: 'uuid' }]);
  });

  it('refuses structurally invalid writes only', async () => {
    const [semi1] = ev.contests;
    const set = (assignment: Record<string, unknown>, contestId = semi1!.id) =>
      schedule.setAssignment({
        actorAccountId: ev.actor,
        versionId: v1,
        contestId,
        assignment: assignment as never,
        idempotencyKey: k(),
      });
    await rejects(set({ startsAt: s1 }), DomainErrorCode.INVALID_INPUT, 'RESOURCE_REQUIRED');
    const padel = await resource(ev, 'PADEL_COURT', 'Padel 1');
    await rejects(
      set({ resourceId: padel, startsAt: s1 }),
      DomainErrorCode.INVALID_INPUT,
      'RESOURCE_TYPE_MISMATCH',
    );
    const retired = await resource(ev, 'TENNIS_COURT', 'Old court');
    await resources.setResourceStatus({
      actorAccountId: ev.actor,
      resourceId: retired,
      status: 'RETIRED',
      reason: 'resurfacing',
      idempotencyKey: k(),
    });
    await rejects(
      set({ resourceId: retired, startsAt: s1 }),
      DomainErrorCode.INVALID_TRANSITION,
      'RESOURCE_RETIRED',
    );
    const other = await plannedEvent({ discipline: 'tennis', format: 'se', entrants: 2 });
    const foreign = await resource(other, 'TENNIS_COURT', 'Foreign');
    await rejects(
      set({ resourceId: foreign, startsAt: s1 }),
      DomainErrorCode.INVALID_INPUT,
      'CROSS_COMPETITION',
    );
    await rejects(
      set({ resourceId: court1, startsAt: s1 }, other.contests[0]!.id),
      DomainErrorCode.INVALID_INPUT,
      'CROSS_COMPETITION',
    );
    await rejects(set({ resourceId: court1, startsAt: s1 }, newId()), DomainErrorCode.NOT_FOUND);
    await rejects(
      set({ resourceId: court1, startsAt: '2027-06-01T15:00:00.500Z' }),
      DomainErrorCode.INVALID_INPUT,
    );
    await rejects(
      set({ resourceId: court1, startsAt: s1, expectedEnd: s1 }),
      DomainErrorCode.INVALID_INPUT,
    );
    await rejects(
      set({ resourceId: court1, startsAt: '2027-06-01 15:00' }),
      DomainErrorCode.INVALID_INPUT,
    );
  }, 240_000);

  it('the draft is invisible publicly: no projection row, the contest stays PLANNED', async () => {
    expect(
      await count(
        `SELECT count(*) AS n FROM competition.contest_schedule WHERE contest_id IN ('${ev.contests.map((c) => c.id).join("','")}')`,
      ),
    ).toBe(0);
    const { rows } = await sql<{ status: string }>`
      SELECT status FROM competition.v_contest_current WHERE contest_id = ${ev.contests[0]!.id}`.execute(
      owner,
    );
    expect(rows[0]?.status).toBe('PLANNED');
  });

  it('publication authority: COMP_MANAGE_SCHEDULE held by a human; strangers and registration managers are refused', async () => {
    const r = await schedule.validate({ actorAccountId: ev.actor, versionId: v1 });
    expect(r.report.coverage).toEqual([
      'INCOMPLETE_ASSIGNMENT',
      'OUTSIDE_EVENT_WINDOW',
      'RESOURCE_TYPE_MISMATCH',
    ]);
    expect(r.conflicts).toEqual([]);
    const body = (actorAccountId: string) => ({
      actorAccountId,
      versionId: v1,
      baseVersionId: null,
      reportHash: r.reportHash,
      acknowledgedConflictKeys: [],
      idempotencyKey: k(),
    });
    const stranger = (await newTestAccount(identity)).accountId;
    await rejects(schedule.publish(body(stranger)), DomainErrorCode.FORBIDDEN);
    await rejects(
      schedule.publish(body(await staff(ev, 'REGISTRATION_MANAGER'))),
      DomainErrorCode.FORBIDDEN,
    );
    // An account without a person (an operator/system login) is not a human publisher.
    const machine = (await newTestAccount(identity, { withPerson: false })).accountId;
    await rejects(schedule.publish(body(machine)), DomainErrorCode.FORBIDDEN);
  }, 120_000);

  it('a stale report or a stale base version is refused', async () => {
    const r = await schedule.validate({ actorAccountId: ev.actor, versionId: v1 });
    await schedule.setAssignment({
      actorAccountId: ev.actor,
      versionId: v1,
      contestId: ev.contests[1]!.id,
      assignment: { resourceId: court2, startsAt: s2, reason: 'second court free' },
      idempotencyKey: k(),
    });
    await rejects(
      schedule.publish({
        actorAccountId: ev.actor,
        versionId: v1,
        baseVersionId: null,
        reportHash: r.reportHash,
        acknowledgedConflictKeys: [],
        idempotencyKey: k(),
      }),
      DomainErrorCode.CONCURRENCY_CONFLICT,
      'REPORT_STALE',
    );
    const fresh = await schedule.validate({ actorAccountId: ev.actor, versionId: v1 });
    await rejects(
      schedule.publish({
        actorAccountId: ev.actor,
        versionId: v1,
        baseVersionId: newId(),
        reportHash: fresh.reportHash,
        acknowledgedConflictKeys: [],
        idempotencyKey: k(),
      }),
      DomainErrorCode.CONCURRENCY_CONFLICT,
      'BASE_VERSION_STALE',
    );
  });

  it('a SCHEDULER publishes: atomic status, projection, SCHEDULED contests, audit + outbox, idempotent replay', async () => {
    const scheduler = await staff(ev, 'SCHEDULER');
    const r = await schedule.validate({ actorAccountId: scheduler, versionId: v1 });
    const key = k();
    const req = {
      actorAccountId: scheduler,
      versionId: v1,
      baseVersionId: null,
      reportHash: r.reportHash,
      acknowledgedConflictKeys: [],
      idempotencyKey: key,
    };
    const out = await schedule.publish(req);
    expect(out).toMatchObject({
      versionId: v1,
      supersededVersionId: null,
      scheduledContests: 3,
      created: true,
    });
    expect(await schedule.publish(req)).toMatchObject({ created: false, versionId: v1 });
    const { rows: proj } = await sql<{
      contest_id: string;
      scheduled_start: Date;
      resource_id: string;
      court_label: string | null;
    }>`
      SELECT contest_id, scheduled_start, resource_id, court_label FROM competition.contest_schedule
      WHERE contest_id = ANY(${ev.contests.map((c) => c.id)}::uuid[]) ORDER BY scheduled_start, contest_id`.execute(
      owner,
    );
    expect(proj).toHaveLength(3);
    expect(proj.find((p) => p.contest_id === ev.contests[1]!.id)).toMatchObject({
      resource_id: court2,
    });
    const { rows: st } = await sql<{ status: string }>`
      SELECT DISTINCT status FROM competition.v_contest_current WHERE contest_id = ANY(${ev.contests.map((c) => c.id)}::uuid[])`.execute(
      owner,
    );
    expect(st).toEqual([{ status: 'SCHEDULED' }]);
    expect(
      await count(
        `SELECT count(*) AS n FROM platform.outbox_event WHERE event_type = 'ContestScheduled' AND aggregate_id IN ('${ev.contests.map((c) => c.id).join("','")}')`,
      ),
    ).toBe(3);
    expect(
      await count(
        `SELECT count(*) AS n FROM platform.outbox_event WHERE event_type = 'ScheduleVersionPublished' AND aggregate_id = '${v1}'`,
      ),
    ).toBe(1);
    const { rows: audit } = await sql<{
      actor_account_id: string;
      details: Record<string, unknown>;
    }>`
      SELECT actor_account_id, details FROM platform.audit_event WHERE action = 'schedule.published' AND target_id = ${v1}`.execute(
      owner,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_account_id: scheduler,
      details: {
        reportHash: r.reportHash,
        coverage: r.report.coverage,
        acknowledgedConflictKeys: [],
      },
    });
    const { rows: pub } = await sql<{ report_hash: string; actor_account_id: string }>`
      SELECT report_hash, actor_account_id FROM competition.schedule_publication WHERE version_id = ${v1}`.execute(
      owner,
    );
    expect(pub).toEqual([{ report_hash: r.reportHash, actor_account_id: scheduler }]);
    // A PUBLISHED version is never changed again.
    await rejects(
      schedule.setAssignment({
        actorAccountId: ev.actor,
        versionId: v1,
        contestId: ev.contests[0]!.id,
        assignment: { resourceId: court1, startsAt: s1 },
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_TRANSITION,
      'NOT_A_DRAFT',
    );
  });

  it('a new draft carries the published content; moves need reasons; locks hold; published assignments stay', async () => {
    const d = await schedule.openDraft({
      actorAccountId: ev.actor,
      competitionId: ev.competitionId,
      idempotencyKey: k(),
    });
    expect(d).toMatchObject({ versionNumber: 2, baseVersionId: v1 });
    const v2 = d.versionId;
    const carried = await schedule.getVersion({ actorAccountId: ev.actor, versionId: v2 });
    expect(carried.assignments.map((a) => a.source)).toEqual(['CARRIED', 'CARRIED', 'CARRIED']);
    const [semi1, semi2, final] = ev.contests;
    const move = (contestId: string, startsAt: string, reason?: string, resourceId = court1) =>
      schedule.setAssignment({
        actorAccountId: ev.actor,
        versionId: v2,
        contestId,
        assignment: { resourceId, startsAt, ...(reason === undefined ? {} : { reason }) },
        idempotencyKey: k(),
      });
    await rejects(
      move(semi1!.id, '2027-06-01T17:00:00Z'),
      DomainErrorCode.INVALID_INPUT,
      'REASON_REQUIRED',
    );
    await move(semi1!.id, '2027-06-01T17:00:00Z', 'rain delay');
    await schedule.setLock({
      actorAccountId: ev.actor,
      versionId: v2,
      contestId: semi2!.id,
      locked: true,
      idempotencyKey: k(),
    });
    await rejects(
      move(semi2!.id, '2027-06-01T18:00:00Z', 'try', court2),
      DomainErrorCode.INVALID_TRANSITION,
      'ASSIGNMENT_LOCKED',
    );
    await rejects(
      schedule.setLock({
        actorAccountId: ev.actor,
        versionId: v2,
        contestId: semi2!.id,
        locked: false,
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_INPUT,
      'REASON_REQUIRED',
    );
    await schedule.setLock({
      actorAccountId: ev.actor,
      versionId: v2,
      contestId: semi2!.id,
      locked: false,
      reason: 'players agreed',
      idempotencyKey: k(),
    });
    await move(semi2!.id, '2027-06-01T18:00:00Z', 'players agreed', court2);
    await rejects(
      schedule.removeAssignment({
        actorAccountId: ev.actor,
        versionId: v2,
        contestId: final!.id,
        reason: 'x',
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_TRANSITION,
      'PUBLISHED_ASSIGNMENT',
    );
    // The published projection is untouched by draft edits.
    const { rows } = await sql<{ scheduled_start: Date }>`
      SELECT scheduled_start FROM competition.contest_schedule WHERE contest_id = ${semi1!.id}`.execute(
      owner,
    );
    expect(rows[0]?.scheduled_start.toISOString()).toBe('2027-06-01T15:00:00.000Z');

    const before = await count(
      `SELECT count(*) AS n FROM platform.outbox_event WHERE event_type = 'ContestScheduled' AND aggregate_id = '${final!.id}'`,
    );
    const out = await publishNow(ev.actor, v2, v1);
    // Only the two moved contests are re-announced; the unchanged final is not.
    expect(out.scheduledContests).toBe(2);
    expect(
      await count(
        `SELECT count(*) AS n FROM platform.outbox_event WHERE event_type = 'ContestScheduled' AND aggregate_id = '${final!.id}'`,
      ),
    ).toBe(before);
    const versions = await schedule.listVersions({
      actorAccountId: ev.actor,
      competitionId: ev.competitionId,
    });
    expect(versions.items.map((v) => [v.versionNumber, v.status])).toEqual([
      [2, 'PUBLISHED'],
      [1, 'SUPERSEDED'],
    ]);
    // History is complete and append-only: version 1 still shows its own content.
    const old = await schedule.getVersion({ actorAccountId: ev.actor, versionId: v1 });
    expect(old.assignments.find((a) => a.contestId === semi1!.id)?.startsAt).toBe(
      '2027-06-01T15:00:00.000Z',
    );
    const now = await schedule.getVersion({ actorAccountId: ev.actor, versionId: v2 });
    expect(
      now.history.filter((h) => h.contestId === semi2!.id).map((h) => [h.source, h.locked]),
    ).toEqual([
      ['CARRIED', false],
      ['CARRIED', true],
      ['CARRIED', false],
      ['MANUAL', false],
    ]);
  }, 120_000);

  it('a discarded draft is terminal; the next draft starts from the published version', async () => {
    const d = await schedule.openDraft({
      actorAccountId: ev.actor,
      competitionId: ev.competitionId,
      idempotencyKey: k(),
    });
    await schedule.discard({
      actorAccountId: ev.actor,
      versionId: d.versionId,
      reason: 'abandoned',
      idempotencyKey: k(),
    });
    await rejects(
      schedule.setAssignment({
        actorAccountId: ev.actor,
        versionId: d.versionId,
        contestId: ev.contests[0]!.id,
        assignment: { resourceId: court1, startsAt: s1, reason: 'x' },
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_TRANSITION,
      'NOT_A_DRAFT',
    );
    await rejects(
      schedule.discard({
        actorAccountId: ev.actor,
        versionId: d.versionId,
        reason: 'again',
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_TRANSITION,
    );
    const next = await schedule.openDraft({
      actorAccountId: ev.actor,
      competitionId: ev.competitionId,
      idempotencyKey: k(),
    });
    const published = (
      await schedule.listVersions({ actorAccountId: ev.actor, competitionId: ev.competitionId })
    ).items.find((v) => v.status === 'PUBLISHED');
    expect(next.baseVersionId).toBe(published?.versionId);
  });

  it('the database keeps the model append-only and structurally sound', async () => {
    for (const stmt of [
      sql`UPDATE competition.schedule_assignment SET starts_at = now() WHERE version_id = ${v1}`,
      sql`DELETE FROM competition.schedule_version_status_change WHERE version_id = ${v1}`,
      sql`UPDATE competition.schedule_publication SET report_hash = report_hash WHERE version_id = ${v1}`,
      sql`TRUNCATE competition.schedule_assignment`,
    ])
      await expect(stmt.execute(owner)).rejects.toThrow();
    // A fact written behind the store into a non-draft version is refused.
    await expect(
      sql`INSERT INTO competition.schedule_assignment (id, version_id, competition_id, contest_id, starts_at, changeover_seconds,
            zone, unit_key, provisional, locked, removed, source, actor_account_id, recorded_at)
          VALUES (${newId()}, ${v1}, ${ev.competitionId}, ${ev.contests[0]!.id}, '2027-06-01T15:00:00Z', 0, 'UTC',
                  ${`contest:${ev.contests[0]!.id}`}, false, false, false, 'MANUAL', ${ev.actor}, date_trunc('milliseconds', now()))`.execute(
        owner,
      ),
    ).rejects.toThrow(/only in an open draft/);
    // A second open draft cannot be created behind the store either.
    await expect(
      sql`WITH v AS (INSERT INTO competition.schedule_version (id, competition_id, version_number, created_by_account_id, recorded_at)
            VALUES (${newId()}, ${ev.competitionId}, 99, ${ev.actor}, date_trunc('milliseconds', now())) RETURNING id)
          INSERT INTO competition.schedule_version_status_change (id, version_id, status, actor_account_id, recorded_at)
          SELECT ${newId()}, id, 'DRAFT', ${ev.actor}, date_trunc('milliseconds', now()) FROM v`.execute(
        owner,
      ),
    ).rejects.toThrow(/already has a DRAFT/);
  });
});

// ───────────────────────────── report contract through publication ─────────────────────────────

describe('SOFT acknowledgement and HARD blocking against the exact report', () => {
  it('a time-only legacy assignment is INCOMPLETE (SOFT): it must be acknowledged exactly; OUTSIDE_EVENT_WINDOW (HARD) blocks', async () => {
    const ev = await plannedEvent({
      discipline: 'tennis',
      format: 'se',
      entrants: 2,
      window: { startsAt: '2027-07-01T00:00:00Z', endsAt: '2027-07-03T00:00:00Z' },
    });
    const [match] = ev.contests;
    // The legacy route: opens a draft automatically, records a time-only assignment, never publishes.
    const r1 = await structure.scheduleContest({
      actorAccountId: ev.actor,
      contestId: match!.id,
      scheduledStart: '2027-07-01T15:00:00Z',
      courtLabel: 'Court 9',
      idempotencyKey: k(),
    });
    expect(r1).toMatchObject({ status: 'PLANNED', created: true });
    expect(
      await count(
        `SELECT count(*) AS n FROM competition.contest_schedule WHERE contest_id = '${match!.id}'`,
      ),
    ).toBe(0);
    await rejects(
      structure.scheduleContest({
        actorAccountId: ev.actor,
        contestId: match!.id,
        scheduledStart: '2027-07-01T16:00:00Z',
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_INPUT,
      'REASON_REQUIRED',
    );
    const draft = r1.versionId;
    const report = await schedule.validate({ actorAccountId: ev.actor, versionId: draft });
    expect(report.conflicts.map((c) => [c.code, c.severity, c.actual])).toEqual([
      ['INCOMPLETE_ASSIGNMENT', 'SOFT', 'expectedEnd'],
    ]);
    const softKey = report.conflicts[0]!.conflictKey;
    const publish = (acknowledgedConflictKeys: string[], reportHash = report.reportHash) =>
      schedule.publish({
        actorAccountId: ev.actor,
        versionId: draft,
        baseVersionId: null,
        reportHash,
        acknowledgedConflictKeys,
        idempotencyKey: k(),
      });
    await rejects(publish([]), DomainErrorCode.INVALID_INPUT, 'ACKNOWLEDGEMENT_MISMATCH');
    await rejects(
      publish([softKey, `sha256:${'0'.repeat(64)}`]),
      DomainErrorCode.INVALID_INPUT,
      'ACKNOWLEDGEMENT_MISMATCH',
    );

    // Moving outside the declared window: a HARD conflict blocks publication; the old ack is void.
    await structure.scheduleContest({
      actorAccountId: ev.actor,
      contestId: match!.id,
      scheduledStart: '2027-07-05T15:00:00Z',
      reason: 'venue clash',
      idempotencyKey: k(),
    });
    await rejects(publish([softKey]), DomainErrorCode.CONCURRENCY_CONFLICT, 'REPORT_STALE');
    const outside = await schedule.validate({ actorAccountId: ev.actor, versionId: draft });
    expect(outside.conflicts.map((c) => c.code)).toEqual([
      'OUTSIDE_EVENT_WINDOW',
      'INCOMPLETE_ASSIGNMENT',
    ]);
    expect(outside.conflicts.find((c) => c.code === 'INCOMPLETE_ASSIGNMENT')?.conflictKey).not.toBe(
      softKey,
    );
    await rejects(
      publish(
        outside.conflicts.filter((c) => c.severity === 'SOFT').map((c) => c.conflictKey),
        outside.reportHash,
      ),
      DomainErrorCode.INVALID_TRANSITION,
      'HARD_CONFLICTS',
    );

    // Back inside the window with an end: nothing to acknowledge, publication succeeds.
    await structure.scheduleContest({
      actorAccountId: ev.actor,
      contestId: match!.id,
      scheduledStart: '2027-07-01T15:00:00Z',
      scheduledEnd: '2027-07-01T17:00:00Z',
      reason: 'back on day one',
      idempotencyKey: k(),
    });
    const clean = await schedule.validate({ actorAccountId: ev.actor, versionId: draft });
    expect(clean.conflicts).toEqual([]);
    await publish([], clean.reportHash);
    const { rows } = await sql<{ acknowledged_conflict_keys: string[] }>`
      SELECT acknowledged_conflict_keys FROM competition.schedule_publication WHERE version_id = ${draft}`.execute(
      owner,
    );
    expect(rows).toEqual([{ acknowledged_conflict_keys: [] }]);
  }, 240_000);

  it('an acknowledged SOFT conflict is recorded with the publication, bound to its report hash', async () => {
    const ev = await plannedEvent({ discipline: 'tennis', format: 'se', entrants: 2 });
    const r = await structure.scheduleContest({
      actorAccountId: ev.actor,
      contestId: ev.contests[0]!.id,
      scheduledStart: '2027-08-01T15:00:00Z',
      idempotencyKey: k(),
    });
    const report = await schedule.validate({ actorAccountId: ev.actor, versionId: r.versionId });
    const keys = report.conflicts.map((c) => c.conflictKey);
    await schedule.publish({
      actorAccountId: ev.actor,
      versionId: r.versionId,
      baseVersionId: null,
      reportHash: report.reportHash,
      acknowledgedConflictKeys: keys,
      idempotencyKey: k(),
    });
    const { rows } = await sql<{
      report_hash: string;
      acknowledged_conflict_keys: string[];
      report: { conflicts: unknown[] };
    }>`
      SELECT report_hash, acknowledged_conflict_keys, report FROM competition.schedule_publication WHERE version_id = ${r.versionId}`.execute(
      owner,
    );
    expect(rows[0]).toMatchObject({
      report_hash: report.reportHash,
      acknowledged_conflict_keys: keys,
    });
    expect(rows[0]?.report.conflicts).toHaveLength(1);
  }, 120_000);
});

// ───────────────────────────── grouped units over several resources ─────────────────────────────

describe('a 24-entrant squad is one unit placed over six EXCLUSIVE lane pairs (generic, ADR-0073 B9)', () => {
  it('one resource per contest assignment; every member carries the same derived unit key', async () => {
    const ev = await plannedEvent({
      discipline: 'bowling',
      format: 'qk',
      ruleset: 'bowling-6-games-scratch',
      profile: 'bowling-lane-pair-blocks',
      entrants: 24,
      formatConfig: { groupSize: 24, qualifiers: 4 },
    });
    const pairs = [];
    for (let i = 0; i < 6; i++)
      pairs.push(
        await resource(ev, 'BOWLING_LANE_PAIR', `Lanes ${2 * i + 1}-${2 * i + 2}`, {
          capacity: 4,
          exclusivityKeys: [`lane-${2 * i + 1}`, `lane-${2 * i + 2}`],
        }),
      );
    const listed = await resources.listResources({
      actorAccountId: ev.actor,
      competitionId: ev.competitionId,
    });
    // Declared mode is the semantic; the capacity-derived legacy label disagrees and is not used.
    expect(listed.items.map((r) => [r.occupancyMode, r.occupancy])).toEqual(
      pairs.map(() => ['EXCLUSIVE', 'SHARED_CAPACITY']),
    );
    const { versionId } = await schedule.openDraft({
      actorAccountId: ev.actor,
      competitionId: ev.competitionId,
      idempotencyKey: k(),
    });
    const squad = ev.contests.filter((c) => c.roundSequence === 1);
    expect(squad).toHaveLength(24);
    for (const [i, c] of squad.entries())
      await schedule.setAssignment({
        actorAccountId: ev.actor,
        versionId,
        contestId: c.id,
        assignment: {
          resourceId: pairs[Math.floor(i / 4)] as string,
          startsAt: '2027-09-01T09:00:00Z',
        },
        idempotencyKey: k(),
      });
    // A fifth bowler on pair 1 is recorded too: capacity is judged by 05E-D, not here.
    const v = await schedule.getVersion({ actorAccountId: ev.actor, versionId });
    expect(new Set(v.assignments.map((a) => a.unitKey)).size).toBe(1);
    expect(v.assignments[0]?.unitKey).toMatch(/^partition:[0-9a-f-]{36}:t1$/);
    expect(new Set(v.assignments.map((a) => a.resourceId)).size).toBe(6);
    expect(new Set(v.assignments.map((a) => a.startsAt))).toEqual(
      new Set(['2027-09-01T09:00:00.000Z']),
    );
    // The block requirement's defaults: 9 000 s and 900 s changeover.
    expect(v.assignments[0]).toMatchObject({
      expectedEnd: '2027-09-01T11:30:00.000Z',
      changeoverSeconds: 900,
    });
    // The stepladder matches are their own units.
    const ladder = ev.contests.find((c) => c.roundSequence > 1);
    await schedule.setAssignment({
      actorAccountId: ev.actor,
      versionId,
      contestId: ladder!.id,
      assignment: { resourceId: pairs[0] as string, startsAt: '2027-09-01T14:00:00Z' },
      idempotencyKey: k(),
    });
    const after = await schedule.getVersion({ actorAccountId: ev.actor, versionId });
    expect(after.assignments.find((a) => a.contestId === ladder!.id)).toMatchObject({
      unitKey: `contest:${ladder!.id}`,
      changeoverSeconds: 300,
      provisional: true,
    });
  }, 600_000);

  it('a later non-dynamic round inherits the same entrant’s group (golf round 2)', async () => {
    const ev = await plannedEvent({
      discipline: 'golf',
      format: 'mr',
      ruleset: 'golf-stroke-gross',
      profile: 'golf-course-tee-groups',
      entrants: 8,
      formatConfig: { rounds: 2, groupSize: 4 },
    });
    const course = await resource(ev, 'GOLF_COURSE', 'North course', { capacity: 144 });
    const { versionId } = await schedule.openDraft({
      actorAccountId: ev.actor,
      competitionId: ev.competitionId,
      idempotencyKey: k(),
    });
    for (const c of ev.contests)
      await schedule.setAssignment({
        actorAccountId: ev.actor,
        versionId,
        contestId: c.id,
        assignment: {
          resourceId: course,
          startsAt: c.roundSequence === 1 ? '2027-10-01T08:00:00Z' : '2027-10-02T08:00:00Z',
        },
        idempotencyKey: k(),
      });
    const v = await schedule.getVersion({ actorAccountId: ev.actor, versionId });
    const keys = (round: number) =>
      new Set(
        v.assignments
          .filter((a) => ev.contests.find((c) => c.id === a.contestId)?.roundSequence === round)
          .map((a) => a.unitKey),
      );
    expect(keys(1).size).toBe(2);
    expect(keys(2).size).toBe(2);
    for (const k2 of keys(2)) expect(k2).toMatch(/^partition:[0-9a-f-]{36}:t[12]$/);
    const listed = await resources.listResources({
      actorAccountId: ev.actor,
      competitionId: ev.competitionId,
    });
    expect(listed.items[0]).toMatchObject({ occupancyMode: 'SHARED' });
  }, 300_000);
});

// ───────────────────────────── resource occupancy mode ─────────────────────────────

describe('resource occupancyMode: declared, stored explicitly, never derived from capacity', () => {
  it('defaults by type at write time, overrides explicitly, survives revise and retire, is audited', async () => {
    const org = await newOrganizer(identity, orgs);
    const { competitionId } = await comps.createCompetition({
      actorAccountId: org.ownerAccountId,
      organizerOrganizationId: org.organizationId,
      slug: uniqueSlug('comp'),
      profile: { name: 'Modes', timezone: 'UTC' },
      idempotencyKey: k(),
    });
    const ctx = { competitionId, actor: org.ownerAccountId };
    const course = await resource(ctx, 'CYCLING_COURSE', 'Loop', { capacity: 1 });
    const tt = await resource(ctx, 'CYCLING_COURSE', 'Loop (time trial)', {
      occupancyMode: 'EXCLUSIVE',
      exclusivityKeys: ['loop'],
    });
    const get = (resourceId: string) =>
      resources.getResource({ actorAccountId: org.ownerAccountId, resourceId });
    // Capacity 1 does not make it exclusive: the type default is SHARED.
    expect(await get(course)).toMatchObject({
      occupancyMode: 'SHARED',
      occupancy: 'EXCLUSIVE',
      capacity: 1,
    });
    expect(await get(tt)).toMatchObject({ occupancyMode: 'EXCLUSIVE' });
    await resources.reviseResource({
      actorAccountId: org.ownerAccountId,
      resourceId: tt,
      resource: { label: 'Loop TT' },
      idempotencyKey: k(),
    });
    expect(await get(tt)).toMatchObject({ occupancyMode: 'EXCLUSIVE', revision: 2 });
    await resources.reviseResource({
      actorAccountId: org.ownerAccountId,
      resourceId: tt,
      resource: { label: 'Loop TT', occupancyMode: 'SHARED' },
      idempotencyKey: k(),
    });
    await resources.setResourceStatus({
      actorAccountId: org.ownerAccountId,
      resourceId: tt,
      status: 'RETIRED',
      reason: 'closed',
      idempotencyKey: k(),
    });
    const after = await get(tt);
    expect(after).toMatchObject({ occupancyMode: 'SHARED', status: 'RETIRED' });
    expect(after.history.map((h) => h.occupancyMode)).toEqual([
      'SHARED',
      'SHARED',
      'EXCLUSIVE',
      'EXCLUSIVE',
    ]);
    const { rows } = await sql<{ details: { changed: string[] } }>`
      SELECT details FROM platform.audit_event WHERE action = 'resource.revised' AND target_id = ${tt} ORDER BY recorded_at`.execute(
      owner,
    );
    expect(rows.map((r) => r.details.changed.includes('occupancyMode'))).toEqual([false, true]);
    await rejects(
      resources.createResource({
        actorAccountId: org.ownerAccountId,
        competitionId,
        typeCode: 'POOL',
        resource: { label: 'Pool', occupancyMode: 'SOMETIMES' as never },
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_INPUT,
    );
  });

  it('the backfill is deterministic: the SQL default equals the domain table, and no revision lacks a mode', async () => {
    for (const [type, mode] of Object.entries(RESOURCE_TYPE_DEFAULT_OCCUPANCY_MODE)) {
      const { rows } = await sql<{
        m: string;
      }>`SELECT competition.default_occupancy_mode(${type}) AS m`.execute(owner);
      expect([type, rows[0]?.m]).toEqual([type, mode]);
    }
    expect(
      await count(
        `SELECT count(*) AS n FROM competition.resource_revision WHERE occupancy_mode IS NULL`,
      ),
    ).toBe(0);
    await expect(
      sql`UPDATE competition.resource_revision SET occupancy_mode = 'SHARED'`.execute(owner),
    ).rejects.toThrow(/append-only/);
    await expect(
      sql`SELECT 1 FROM pg_constraint WHERE conname = 'resource_revision_occupancy_mode'`.execute(
        owner,
      ),
    ).resolves.toMatchObject({ rows: [{ '?column?': 1 }] });
  });
});

// ───────────────────────────── the legacy migration ─────────────────────────────

describe('legacy contest_schedule rows become version 1, PUBLISHED, without invented data', () => {
  it('reproduces the rows exactly (no resource, NULL end kept, no unit key); 05E-C reports them INCOMPLETE', async () => {
    const ev = await plannedEvent({ discipline: 'tennis', format: 'se', entrants: 4 });
    const [a, b] = ev.contests;
    // Rows as BRT-05 wrote them (sub-second instant, no end), inserted as the owner behind the stores.
    await sql`INSERT INTO competition.contest_schedule (contest_id, scheduled_start, scheduled_end, court_label, updated_at, updated_by_account_id)
      VALUES (${a!.id}, '2027-11-01T15:00:00.123Z', NULL, 'Court A', now(), ${ev.actor}),
             (${b!.id}, '2027-11-01T17:00:00Z', '2027-11-01T18:30:00Z', NULL, now(), ${ev.actor})`.execute(
      owner,
    );
    const { rows: n } = await sql<{
      n: number;
    }>`SELECT competition.migrate_legacy_contest_schedule() AS n`.execute(owner);
    expect(n[0]?.n).toBeGreaterThanOrEqual(1);
    const { items } = await schedule.listVersions({
      actorAccountId: ev.actor,
      competitionId: ev.competitionId,
    });
    expect(items.map((v) => [v.versionNumber, v.status, v.createdByAccountId])).toEqual([
      [1, 'PUBLISHED', null],
    ]);
    const v = await schedule.getVersion({
      actorAccountId: ev.actor,
      versionId: items[0]!.versionId,
    });
    expect(v.statusHistory[0]).toMatchObject({ status: 'PUBLISHED', actorAccountId: null });
    const byContest = new Map(v.assignments.map((x) => [x.contestId, x]));
    expect(byContest.get(a!.id)).toMatchObject({
      source: 'MIGRATED',
      resourceId: null,
      startsAt: '2027-11-01T15:00:00.123Z',
      expectedEnd: null,
      unitKey: null,
      courtLabel: 'Court A',
      actorAccountId: ev.actor,
    });
    expect(byContest.get(b!.id)).toMatchObject({
      expectedEnd: '2027-11-01T18:30:00.000Z',
      unitKey: null,
    });
    // A second run migrates nothing new for this competition.
    await sql`SELECT competition.migrate_legacy_contest_schedule()`.execute(owner);
    expect(
      (await schedule.listVersions({ actorAccountId: ev.actor, competitionId: ev.competitionId }))
        .items,
    ).toHaveLength(1);
    // The missing end is reported, never treated as complete.
    const r = await schedule.validate({ actorAccountId: ev.actor, versionId: items[0]!.versionId });
    expect(r.conflicts.map((c) => [c.code, c.contestIds])).toEqual([
      ['INCOMPLETE_ASSIGNMENT', [a!.id]],
    ]);
    // Rescheduling continues through a draft carried from the migrated version.
    const d = await schedule.openDraft({
      actorAccountId: ev.actor,
      competitionId: ev.competitionId,
      idempotencyKey: k(),
    });
    const carried = await schedule.getVersion({ actorAccountId: ev.actor, versionId: d.versionId });
    expect(carried.assignments.map((x) => [x.source, x.unitKey])).toEqual([
      ['CARRIED', null],
      ['CARRIED', null],
    ]);
  }, 240_000);
});
