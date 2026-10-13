import { readFileSync } from 'node:fs';
import {
  BASKETBALL_3X3_V2,
  BOWLING_SINGLES_V2,
  CANONICAL_CATALOG,
  CYCLING_ROAD_V2,
  GOLF_INDIVIDUAL_V2,
  PROPOSAL_BUDGET,
  PROPOSAL_STRATEGY,
  RULESET_TEMPLATES,
  RUNNING_ROAD_V2,
  SCHEDULING_PROFILE_TEMPLATES,
  SWIMMING_POOL_V2,
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
import { TeamStore } from './team-store';

/**
 * ONCF-05E-F-2 proposal COMMIT through the real stores (ADR-0075 § 16–18, ADR-0076): the server
 * recomputes the previewed proposal under the competition-schedule lock (05E-F-1 decides), then
 * appends exactly the recomputed placements to the open draft through the per-fact write path, with
 * one `ScheduleProposalCommitted` outbox event, one `schedule.proposal-committed` audit and the
 * idempotency record — all in ONE transaction. Every refusal and every injected failure is proven
 * to leave the whole competition byte-identical (real SQL, real constraints, real rollback: faults
 * are injected with database triggers, never with mocks of the transaction).
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
const teams = new TeamStore(db);
const k = () => `k-${newId()}`;

const tag = newId().replace(/-/g, '').slice(-8);
const ids: Record<string, string> = {};
const v2 = (code: string) =>
  CANONICAL_CATALOG.sports.flatMap((s) => s.disciplines).find((d) => d.code === code)
    ?.specs[1] as DisciplineVersionSpec;
const RS = [
  'sets-bo3-tiebreak',
  'padel-bo3-star-point',
  'road-gun-time',
  'swim-hundredths',
  'cycling-road-same-time',
  'bowling-6-games-scratch',
  '3x3-10min-21',
  'golf-stroke-gross',
];

beforeAll(async () => {
  const op = (await newTestAccount(identity, { withPerson: false, label: 'operator' })).accountId;
  const d = (code: string, specs: DisciplineVersionSpec[]) => ({
    code: `f${tag}.${code}`,
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
          code: `f${tag}`,
          name: 'ONCF-05E-F test sport',
          disciplines: [
            d('tennis', [v2('tennis.singles')]),
            d('padel', [v2('padel.doubles')]),
            d('road', [RUNNING_ROAD_V2]),
            d('pool', [SWIMMING_POOL_V2]),
            d('cycling', [CYCLING_ROAD_V2]),
            d('bowling', [BOWLING_SINGLES_V2]),
            d('b3x3', [BASKETBALL_3X3_V2]),
            d('golf', [GOLF_INDIVIDUAL_V2]),
          ],
        },
      ],
      formats: [
        f('se', 'single-elimination', 2),
        f('gk', 'groups-knockout'),
        f('wave', 'wave-start'),
        f('heats', 'heats-final'),
        f('mr', 'multi-round'),
        f('qk', 'qualifying-knockout'),
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
    if (x.discipline.code.startsWith(`f${tag}.`))
      ids[x.discipline.code.split('.')[1] as string] = x.disciplineVersionId;
  for (const fv of listed.formatVersions)
    if (fv.format.code.endsWith(`-${tag}`))
      ids[fv.format.code.split('-')[0] as string] = fv.formatVersionId;
  for (const r of listed.rulesetVersions)
    if (r.code.startsWith(`r${tag}-`)) ids[`rs:${r.code.slice(`r${tag}-`.length)}`] = r.versionId;
  for (const p of listed.schedulingProfileVersions)
    if (p.code.startsWith(`p${tag}-`)) ids[`sp:${p.code.slice(`p${tag}-`.length)}`] = p.versionId;
}, 240_000);

// ───────────────────────────── fixtures ─────────────────────────────

const WEEK = { startsAt: '2027-09-01T12:00:00Z', endsAt: '2027-09-08T12:00:00Z' };
const epoch = (iso: string) => Date.parse(iso) / 1000;

interface Comp {
  competitionId: string;
  actor: string;
}

async function competition(): Promise<Comp> {
  const org = await newOrganizer(identity, orgs);
  const actor = org.ownerAccountId;
  const { competitionId } = await comps.createCompetition({
    actorAccountId: actor,
    organizerOrganizationId: org.organizationId,
    slug: uniqueSlug('comp'),
    profile: { name: 'ONCF-05E-F Fest', timezone: 'America/Costa_Rica' },
    idempotencyKey: k(),
  });
  await comps.publishCompetition({ actorAccountId: actor, competitionId });
  await comps.activateCompetition({ actorAccountId: actor, competitionId });
  return { competitionId, actor };
}

/** A team managed by its first member; the others accept their memberships. */
async function team(size: number, kind: 'EVENT_PAIR' | 'EVENT_SQUAD') {
  const members = [];
  for (let i = 0; i < size; i++) members.push(await newAthlete(identity, `m${i}`, `Member ${i}`));
  const manager = members[0] as (typeof members)[number];
  const { teamId } = await teams.createTeam({
    actorAccountId: manager.accountId,
    teamKind: kind,
    displayName: `Team ${newId().slice(0, 6)}`,
    idempotencyKey: k(),
  });
  for (const m of members) {
    const { membershipId, status } = await teams.addMember({
      actorAccountId: manager.accountId,
      teamId,
      athleteId: m.athleteId,
      idempotencyKey: k(),
    });
    if (status !== 'ACTIVE')
      await teams.respond({ actorAccountId: m.accountId, membershipId, accept: true });
  }
  return { teamId, manager };
}

interface EventSpec {
  discipline: string;
  format: string;
  ruleset: string;
  /** null: the ruleset is pinned without a scheduling profile. */
  profile: string | null;
  formatConfig: Record<string, unknown>;
  entrants?: number;
  teams?: { count: number; size: number; kind: 'EVENT_PAIR' | 'EVENT_SQUAD' };
  /** Seed by declared entry time (swimming heats), else a deterministic draw. */
  byEntryTime?: boolean;
  window?: { startsAt: string; endsAt: string };
}

/** An event with a locked, seeded field and a generated plan, created only through the stores. */
async function plannedEvent(comp: Comp, o: EventSpec) {
  const { actor, competitionId } = comp;
  const { eventId } = await comps.createEvent({
    actorAccountId: actor,
    competitionId,
    slug: uniqueSlug('ev'),
    disciplineVersionId: ids[o.discipline] as string,
    formatVersionId: ids[o.format] as string,
    formatConfig: o.formatConfig,
    settings: {
      name: 'Category',
      capacity: null,
      registrationMode: 'AUTO_CONFIRM',
      ...(o.window ?? WEEK),
    },
    idempotencyKey: k(),
  });
  await comps.openRegistration({ actorAccountId: actor, eventId });
  await scoring.pinScoring({
    actorAccountId: actor,
    eventId,
    rulesetVersionId: ids[`rs:${o.ruleset}`] as string,
    ...(o.profile === null ? {} : { schedulingProfileVersionId: ids[`sp:${o.profile}`] as string }),
    idempotencyKey: k(),
  });
  for (let i = 0; i < (o.entrants ?? 0); i++) {
    const a = await newAthlete(identity, `p${i}`, `Player ${i}`);
    const { registrationId } = await comps.register({
      actorAccountId: a.accountId,
      eventId,
      athleteId: a.athleteId,
      eligibilityDeclared: true,
      idempotencyKey: k(),
    });
    if (o.byEntryTime === true)
      await structure.declareEntryAttributes({
        actorAccountId: a.accountId,
        registrationId,
        attributes: [{ key: 'entryTimeMs', value: `${60_000 + i * 100}` }],
        idempotencyKey: k(),
      });
  }
  for (let i = 0; i < (o.teams?.count ?? 0); i++) {
    const t = await team(o.teams?.size as number, o.teams?.kind as 'EVENT_PAIR');
    await comps.register({
      actorAccountId: t.manager.accountId,
      eventId,
      teamId: t.teamId,
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
    ...(o.byEntryTime === true
      ? { method: 'BY_ENTRY_ATTRIBUTE', attributeKey: 'entryTimeMs', direction: 'ASC' }
      : { method: 'DETERMINISTIC_DRAW' }),
  });
  await structure.generatePlan({ actorAccountId: actor, eventId, idempotencyKey: k() });
  const { rows } = await sql<{ id: string; round_id: string; round_sequence: number }>`
    SELECT c.id, c.round_id, r.sequence AS round_sequence FROM competition.contest c
    JOIN competition.round r ON r.id = c.round_id WHERE c.event_id = ${eventId}
    ORDER BY r.sequence, c.sequence`.execute(owner);
  return {
    eventId,
    contests: rows.map((r) => ({ id: r.id, roundId: r.round_id, round: r.round_sequence })),
  };
}

const resource = async (
  comp: Comp,
  typeCode: string,
  label: string,
  extra: Record<string, unknown> = {},
) =>
  (
    await resources.createResource({
      actorAccountId: comp.actor,
      competitionId: comp.competitionId,
      typeCode,
      resource: { label, ...extra },
      idempotencyKey: k(),
    })
  ).resourceId;

/** Competition-wide hours declared every day, all day (no undeclared time, ADR-0073 B5). */
const openAllWeek = async (comp: Comp) => {
  for (const weekday of [1, 2, 3, 4, 5, 6, 7])
    await resources.addAvailability({
      actorAccountId: comp.actor,
      competitionId: comp.competitionId,
      resourceId: null,
      fact: { kind: 'WEEKLY', weekday, start: '00:00', end: '24:00' },
      idempotencyKey: k(),
    });
};

const draft = async (comp: Comp) =>
  (
    await schedule.openDraft({
      actorAccountId: comp.actor,
      competitionId: comp.competitionId,
      idempotencyKey: k(),
    })
  ).versionId;

type PreviewInput = Parameters<ScheduleStore['previewProposal']>[0];
type CommitInput = Parameters<ScheduleStore['commitProposal']>[0];

const preview = (actor: string, versionId: string, extra: Partial<PreviewInput> = {}) =>
  schedule.previewProposal({ actorAccountId: actor, versionId, ...extra });

const commit = (
  actor: string,
  versionId: string,
  proposalHash: string,
  extra: Partial<CommitInput> = {},
  store: ScheduleStore = schedule,
) =>
  store.commitProposal({
    actorAccountId: actor,
    versionId,
    proposalHash,
    idempotencyKey: k(),
    ...extra,
  });

const rejects = (p: Promise<unknown>, code: DomainErrorCode, reason?: string) =>
  expect(p).rejects.toMatchObject({
    code,
    ...(reason === undefined ? {} : { details: { reason } }),
  });

/** A four-player tennis knockout (two semis, a final) with the tennis profile pinned. */
async function tennis(
  comp: Comp,
  o: { profile?: string | null; window?: { startsAt: string; endsAt: string } } = {},
) {
  return plannedEvent(comp, {
    discipline: 'tennis',
    format: 'se',
    ruleset: 'sets-bo3-tiebreak',
    profile: o.profile === undefined ? 'tennis-court-match' : o.profile,
    formatConfig: { drawSize: 4 },
    entrants: 4,
    ...(o.window === undefined ? {} : { window: o.window }),
  });
}

/** A competition with a tennis knockout, two courts, declared hours and an open draft. */
async function setup() {
  const comp = await competition();
  const ev = await tennis(comp);
  const courts = [
    await resource(comp, 'TENNIS_COURT', 'Court 1'),
    await resource(comp, 'TENNIS_COURT', 'Court 2'),
  ].sort();
  await openAllWeek(comp);
  const versionId = await draft(comp);
  return { comp, ev, courts, versionId };
}

/**
 * Every authoritative row a commit could touch for one competition, serialized by the database
 * itself (owner connection): schedule versions, status history, assignments, publications, the
 * public projection, resources, availability, pins, contest / event / competition status, the
 * public contest cards, audit / outbox entries naming any of them, and the idempotency records of
 * the given actors.
 */
async function snapshot(competitionId: string, actors: readonly string[] = []) {
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
    resource: await q('competition.resource', byComp),
    resource_revision: await q('competition.resource_revision', sql`t.resource_id IN ${res}`),
    resource_availability: await q('competition.resource_availability', byComp),
    event_scoring: await q('competition.event_scoring', sql`t.event_id IN ${events}`),
    contest_status_change: await q(
      'competition.contest_status_change',
      sql`t.contest_id IN ${contests}`,
    ),
    event_status_change: await q('competition.event_status_change', sql`t.event_id IN ${events}`),
    competition_status_change: await q('competition.competition_status_change', byComp),
    contest_card: await q('competition_read.contest_card', sql`t.event_id IN ${events}`),
    audit_event: await q('platform.audit_event', sql`t.target_id IN ${targets}`),
    outbox_event: await q('platform.outbox_event', sql`t.aggregate_id IN ${targets}`),
    command_idempotency: await q(
      'platform.command_idempotency',
      sql`t.scope = ANY(${[...actors]}::text[])`,
    ),
  };
}

/** The draft's facts in insertion order, as stored. */
async function facts(versionId: string) {
  const { rows } = await sql<{
    id: string;
    contest_id: string;
    resource_id: string | null;
    starts_at: Date;
    expected_end: Date | null;
    changeover_seconds: number;
    zone: string;
    unit_key: string | null;
    provisional: boolean;
    locked: boolean;
    removed: boolean;
    reason: string | null;
    replaces_assignment_id: string | null;
    source: string;
    actor_account_id: string | null;
  }>`
    SELECT id, contest_id, resource_id, starts_at, expected_end, changeover_seconds, zone, unit_key, provisional,
           locked, removed, reason, replaces_assignment_id, source, actor_account_id
    FROM competition.schedule_assignment WHERE version_id = ${versionId} ORDER BY seq`.execute(
    owner,
  );
  return rows;
}

const outboxOf = async (aggregateId: string) =>
  (
    await sql<{ event_type: string; payload: Record<string, unknown> }>`
      SELECT event_type, payload FROM platform.outbox_event WHERE aggregate_id = ${aggregateId}
      ORDER BY recorded_at, event_type, payload::text`.execute(owner)
  ).rows;

const auditOf = async (action: string, targetId: string) =>
  (
    await sql<{ actor_account_id: string; details: Record<string, unknown>; outcome: string }>`
      SELECT actor_account_id, details, outcome FROM platform.audit_event
      WHERE action = ${action} AND target_id = ${targetId}`.execute(owner)
  ).rows;

const idempotencyRows = async (actor: string, key: string) =>
  (
    await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM platform.command_idempotency
      WHERE scope = ${actor} AND idempotency_key = ${key}`.execute(owner)
  ).rows[0]?.n;

/**
 * A REAL failure inside the commit transaction: a BEFORE INSERT trigger (owner connection) that
 * raises for the rows `when` matches, created for `fn` only. PostgreSQL aborts the statement, the
 * store's transaction rolls back everything it wrote before it. No transaction is mocked.
 */
async function withFault<T>(table: string, when: string, fn: () => Promise<T>): Promise<T> {
  const name = `oncf05e_f_fault_${newId().replace(/-/g, '').slice(-12)}`;
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

/** Validate and publish a draft as its human scheduler does (ADR-0073 B1), acknowledging SOFT keys. */
async function publishDraft(comp: Comp, versionId: string) {
  const r = await schedule.validate({ actorAccountId: comp.actor, versionId });
  expect(r.hardConflicts).toBe(0);
  const v = await schedule.getVersion({ actorAccountId: comp.actor, versionId });
  return schedule.publish({
    actorAccountId: comp.actor,
    versionId,
    baseVersionId: v.baseVersionId,
    reportHash: r.reportHash,
    acknowledgedConflictKeys: r.conflicts
      .filter((c) => c.severity === 'SOFT')
      .map((c) => c.conflictKey),
    idempotencyKey: k(),
  });
}

// ───────────────────────────── successful commit ─────────────────────────────

describe('ONCF-05E-F-2 commit: the recomputed plan, persisted atomically', () => {
  it('SUCCESS: facts = recomputed placements exactly; per-fact and commit events, audits, idempotency; nothing public', async () => {
    const { comp, ev, courts, versionId } = await setup();
    const { proposal: p } = await preview(comp.actor, versionId);
    expect(p.status).toBe('SUCCESS');
    expect(p.placements).toHaveLength(3);
    const before = await snapshot(comp.competitionId);
    const key = k();

    const r = await commit(comp.actor, versionId, p.proposalHash, { idempotencyKey: key });
    const sortedContests = [...ev.contests.map((c) => c.id)].sort();
    expect(r).toMatchObject({
      versionId,
      competitionId: comp.competitionId,
      proposalHash: p.proposalHash,
      // The commit's own recomputation has the preview's identity (unchanged base state).
      baseStateIdentity: p.baseStateIdentity,
      placedContests: 3,
      created: true,
    });
    expect(r.assignmentIds.map((a) => a.contestId)).toEqual(sortedContests);

    // Persisted facts = the plan, in the plan's (contest id) order, MANUAL, reason `proposal <hash>`.
    const stored = await facts(versionId);
    expect(stored.map((f) => f.contest_id)).toEqual(sortedContests);
    expect(stored.map((f) => f.id)).toEqual(r.assignmentIds.map((a) => a.assignmentId));
    for (const f of stored) {
      const x = p.placements.find((y) => y.contestId === f.contest_id);
      expect(x).toBeDefined();
      expect({
        resourceId: f.resource_id,
        start: f.starts_at.getTime() / 1000,
        expectedEnd: (f.expected_end as Date).getTime() / 1000,
        changeoverSeconds: f.changeover_seconds,
        zone: f.zone,
        unitKey: f.unit_key,
        provisional: f.provisional,
      }).toEqual({
        resourceId: x?.resourceId,
        start: x?.start,
        expectedEnd: x?.expectedEnd,
        changeoverSeconds: x?.changeoverSeconds,
        zone: x?.zone,
        unitKey: x?.unitKey,
        provisional: x?.provisional,
      });
      expect(f).toMatchObject({
        source: 'MANUAL',
        reason: `proposal ${p.proposalHash}`,
        actor_account_id: comp.actor,
        locked: false,
        removed: false,
        replaces_assignment_id: null,
      });
      expect(courts).toContain(f.resource_id);
    }
    // The hashed placement values, e.g. the provisional final after the semis plus the lead.
    const final = stored.find((f) => f.contest_id === ev.contests[2]?.id);
    expect(final).toMatchObject({ provisional: true, changeover_seconds: 600 });
    expect(final?.starts_at.getTime()).toBe((epoch(WEEK.startsAt) + 5_400 + 900) * 1000);

    // Outbox: one ScheduleAssignmentChanged SET per fact, then one ScheduleProposalCommitted.
    const outbox = await outboxOf(versionId);
    const changed = outbox.filter((e) => e.event_type === 'ScheduleAssignmentChanged');
    expect(
      changed
        .map((e) => e.payload)
        .sort((a, b) => String(a.contestId).localeCompare(String(b.contestId))),
    ).toEqual(r.assignmentIds.map((a) => ({ ...a, action: 'SET' })));
    const committed = outbox.filter((e) => e.event_type === 'ScheduleProposalCommitted');
    expect(committed).toHaveLength(1);
    expect(committed[0]?.payload).toEqual({
      competitionId: comp.competitionId,
      proposalHash: p.proposalHash,
      baseStateIdentity: p.baseStateIdentity,
      strategy: PROPOSAL_STRATEGY,
      budget: PROPOSAL_BUDGET,
      reportHash: p.report.reportHash,
      placedUnits: 3,
      placedContests: 3,
      unplacedUnits: 0,
      assignments: r.assignmentIds,
    });

    // Audit: the per-fact entries plus one commit entry, by the committing human; no PII.
    for (const c of ev.contests)
      expect(await auditOf('schedule.assignment-set', c.id)).toEqual([
        expect.objectContaining({ actor_account_id: comp.actor, outcome: 'SUCCEEDED' }),
      ]);
    expect(await auditOf('schedule.proposal-committed', versionId)).toEqual([
      {
        actor_account_id: comp.actor,
        outcome: 'SUCCEEDED',
        details: {
          competitionId: comp.competitionId,
          proposalHash: p.proposalHash,
          baseStateIdentity: p.baseStateIdentity,
          strategyId: PROPOSAL_STRATEGY.id,
          strategyVersion: PROPOSAL_STRATEGY.version,
          maxEvaluations: PROPOSAL_BUDGET.maxEvaluations,
          maxEvaluationsPerUnit: PROPOSAL_BUDGET.maxEvaluationsPerUnit,
          reportHash: p.report.reportHash,
          placedUnits: 3,
          placedContests: 3,
          unplacedUnits: 0,
        },
      },
    ]);
    expect(await idempotencyRows(comp.actor, key)).toBe(1);

    // Nothing public: no projection row, no contest status, no read model, no other version touched.
    const after = await snapshot(comp.competitionId);
    for (const t of [
      'contest_schedule',
      'contest_status_change',
      'contest_card',
      'schedule_version',
      'schedule_version_status_change',
      'schedule_publication',
      'event_status_change',
      'resource_revision',
      'resource_availability',
    ] as const)
      expect(after[t], t).toEqual(before[t]);

    // The draft's live content is now exactly the committed placements; nothing else proposable.
    const again = await preview(comp.actor, versionId);
    expect(again.proposal.status).toBe('NOTHING_TO_PLACE');
  }, 300_000);

  it('published state is immutable; the committed draft becomes public only by publication', async () => {
    const { comp, ev, versionId: first } = await setup();
    const [sf1, sf2, final] = ev.contests as [
      (typeof ev.contests)[0],
      (typeof ev.contests)[0],
      (typeof ev.contests)[0],
    ];
    const court = (
      await sql<{ id: string }>`
      SELECT id FROM competition.resource WHERE competition_id = ${comp.competitionId} ORDER BY id LIMIT 1`.execute(
        owner,
      )
    ).rows[0]?.id as string;
    // Version 1: one semi placed by hand and published.
    await schedule.setAssignment({
      actorAccountId: comp.actor,
      versionId: first,
      contestId: sf1.id,
      assignment: { resourceId: court, startsAt: '2027-09-03T12:00:00Z' },
      idempotencyKey: k(),
    });
    await publishDraft(comp, first);
    const second = await draft(comp);
    const publishedBefore = await facts(first);
    const projectionBefore = (await snapshot(comp.competitionId)).contest_schedule;
    expect(JSON.parse(projectionBefore)).toHaveLength(1);

    const { proposal: p } = await preview(comp.actor, second);
    expect(p.status).toBe('SUCCESS');
    expect(p.placements.map((x) => x.contestId).sort()).toEqual([sf2.id, final.id].sort());

    // The PUBLISHED version is never a commit target.
    await rejects(
      commit(comp.actor, first, p.proposalHash),
      DomainErrorCode.INVALID_TRANSITION,
      'NOT_A_DRAFT',
    );
    const r = await commit(comp.actor, second, p.proposalHash);
    expect(r.placedContests).toBe(2);

    // The published version and its public projection are untouched by the commit.
    expect(await facts(first)).toEqual(publishedBefore);
    const mid = await snapshot(comp.competitionId);
    expect(mid.contest_schedule).toEqual(projectionBefore);
    // The draft: the carried published fact, then the two committed facts.
    expect((await facts(second)).map((f) => [f.contest_id, f.source])).toEqual([
      [sf1.id, 'CARRIED'],
      ...[sf2.id, final.id].sort().map((id) => [id, 'MANUAL']),
    ]);

    // Publication (unchanged, separate, human) is what makes the committed placements public.
    await publishDraft(comp, second);
    const pub = JSON.parse((await snapshot(comp.competitionId)).contest_schedule) as {
      contest_id: string;
    }[];
    expect(pub.map((x) => x.contest_id).sort()).toEqual([sf1.id, sf2.id, final.id].sort());
  }, 300_000);

  it('existing content: locked, manual and removed-in-draft facts — the diff is additions only', async () => {
    const { comp, ev, courts, versionId } = await setup();
    const [sf1, sf2, final] = ev.contests as [
      (typeof ev.contests)[0],
      (typeof ev.contests)[0],
      (typeof ev.contests)[0],
    ];
    // sf1: placed by hand and locked. final: placed by hand, then removed (draft-only).
    for (const c of [sf1, final])
      await schedule.setAssignment({
        actorAccountId: comp.actor,
        versionId,
        contestId: c.id,
        assignment: { resourceId: courts[0] as string, startsAt: '2027-09-05T12:00:00Z' },
        idempotencyKey: k(),
      });
    await schedule.setLock({
      actorAccountId: comp.actor,
      versionId,
      contestId: sf1.id,
      locked: true,
      reason: null,
      idempotencyKey: k(),
    });
    await schedule.removeAssignment({
      actorAccountId: comp.actor,
      versionId,
      contestId: final.id,
      reason: 'make room',
      idempotencyKey: k(),
    });
    const before = await facts(versionId);
    const removal = before.at(-1);
    expect(removal).toMatchObject({ contest_id: final.id, removed: true });

    const { proposal: p } = await preview(comp.actor, versionId);
    expect(p.status).toBe('SUCCESS');
    expect(p.placements.map((x) => x.contestId).sort()).toEqual([sf2.id, final.id].sort());
    await commit(comp.actor, versionId, p.proposalHash);

    const after = await facts(versionId);
    // Append-only: every earlier fact unchanged, in place; only the plan's facts were added.
    expect(after.slice(0, before.length)).toEqual(before);
    const added = after.slice(before.length);
    expect(added.map((f) => f.contest_id)).toEqual([sf2.id, final.id].sort());
    // The removed contest is re-placed on top of its removal fact (ADR-0075 § 7).
    expect(added.find((f) => f.contest_id === final.id)?.replaces_assignment_id).toBe(removal?.id);
    expect(added.find((f) => f.contest_id === sf2.id)?.replaces_assignment_id).toBeNull();
    // The locked assignment is still the live one, still locked.
    const live = await schedule.getVersion({ actorAccountId: comp.actor, versionId });
    expect(live.assignments.find((a) => a.contestId === sf1.id)).toMatchObject({ locked: true });
  }, 300_000);
});

// ───────────────────────────── idempotency ─────────────────────────────

describe('idempotency (ADR-0076 C9): replay, key reuse, retry after success', () => {
  it('same key → the stored response, nothing written; same key other params → KEY_REUSED; new key → stale', async () => {
    const { comp, versionId } = await setup();
    const { proposal: p } = await preview(comp.actor, versionId);
    const key = k();
    const first = await commit(comp.actor, versionId, p.proposalHash, { idempotencyKey: key });
    const after = await snapshot(comp.competitionId, [comp.actor]);

    const replay = await commit(comp.actor, versionId, p.proposalHash, { idempotencyKey: key });
    expect(replay).toEqual({ ...first, created: false });
    expect(await snapshot(comp.competitionId, [comp.actor])).toEqual(after);

    // Same key, different request (scope or from): refused, never treated as a replay.
    await rejects(
      commit(comp.actor, versionId, p.proposalHash, {
        idempotencyKey: key,
        from: '2027-09-02T00:00:00Z',
      }),
      DomainErrorCode.IDEMPOTENCY_KEY_REUSED,
    );
    // A retry with a NEW key recomputes: the commit changed the watermark → stale, no second set.
    await rejects(
      commit(comp.actor, versionId, p.proposalHash),
      DomainErrorCode.CONCURRENCY_CONFLICT,
      'PROPOSAL_STALE',
    );
    expect(await snapshot(comp.competitionId, [comp.actor])).toEqual(after);
    expect((await facts(versionId)).filter((f) => f.reason?.startsWith('proposal '))).toHaveLength(
      3,
    );
  }, 300_000);
});

// ───────────────────────────── staleness and non-overwrite ─────────────────────────────

describe('stale base state (ADR-0075 § 16): any authoritative change refuses, nothing written', () => {
  it('assignment, lock, resource, availability, event lifecycle, scope and from changes are all PROPOSAL_STALE', async () => {
    const { comp, ev, courts, versionId } = await setup();
    const [sf1, sf2] = ev.contests as [(typeof ev.contests)[0], (typeof ev.contests)[0]];
    const stale = async (hash: string, extra: Partial<CommitInput> = {}) => {
      const before = await snapshot(comp.competitionId, [comp.actor]);
      const key = k();
      await rejects(
        commit(comp.actor, versionId, hash, { idempotencyKey: key, ...extra }),
        DomainErrorCode.CONCURRENCY_CONFLICT,
        'PROPOSAL_STALE',
      );
      expect(await snapshot(comp.competitionId, [comp.actor])).toEqual(before);
      expect(await idempotencyRows(comp.actor, key)).toBe(0);
    };
    const hashNow = async (extra: Partial<PreviewInput> = {}) =>
      (await preview(comp.actor, versionId, extra)).proposal.proposalHash;

    // A forged or unrelated hash is a claim that never matches.
    await stale(`sha256:${'0'.repeat(64)}`);

    // Another organizer places a target contest by hand: the proposal is stale, the manual
    // assignment is never overwritten.
    let h = await hashNow();
    await schedule.setAssignment({
      actorAccountId: comp.actor,
      versionId,
      contestId: sf1.id,
      assignment: { resourceId: courts[1] as string, startsAt: '2027-09-04T12:00:00Z' },
      idempotencyKey: k(),
    });
    await stale(h);
    const manual = (await facts(versionId)).filter((f) => f.contest_id === sf1.id);
    expect(manual).toEqual([expect.objectContaining({ source: 'MANUAL', reason: null })]);

    // A lock fact changes the watermark.
    h = await hashNow();
    await schedule.setLock({
      actorAccountId: comp.actor,
      versionId,
      contestId: sf1.id,
      locked: true,
      reason: null,
      idempotencyKey: k(),
    });
    await stale(h);

    // A new resource revision; a new availability fact.
    h = await hashNow();
    await resource(comp, 'TENNIS_COURT', 'Court 3');
    await stale(h);
    h = await hashNow();
    await resources.addAvailability({
      actorAccountId: comp.actor,
      competitionId: comp.competitionId,
      resourceId: courts[0] as string,
      fact: {
        kind: 'BLACKOUT',
        startsAt: '2027-09-07T00:00:00Z',
        endsAt: '2027-09-07T06:00:00Z',
        reason: 'maintenance',
      },
      idempotencyKey: k(),
    });
    await stale(h);

    // Scope or `from` other than the previewed ones, with the previewed hash: a different proposal.
    h = await hashNow({ scope: { roundIds: [sf2.roundId] } });
    await stale(h);
    await stale(h, { scope: { eventIds: [ev.eventId] } });
    await stale(h, { scope: { roundIds: [sf2.roundId] }, from: '2027-09-02T00:00:00Z' });
    // …while the same request does reproduce it (the baseline the stale cases are measured against).
    expect(await hashNow({ scope: { roundIds: [sf2.roundId] } })).toBe(h);

    // Event lifecycle: the event goes IN_PROGRESS between preview and commit.
    h = await hashNow();
    await comps.startEvent({ actorAccountId: comp.actor, eventId: ev.eventId });
    await stale(h);
  }, 600_000);

  it('a cancelled event makes the proposal stale; a cancelled or completed competition refuses the commit', async () => {
    const a = await setup();
    const h = (await preview(a.comp.actor, a.versionId)).proposal.proposalHash;
    await comps.cancelEvent({
      actorAccountId: a.comp.actor,
      eventId: a.ev.eventId,
      reason: 'rain',
    });
    let before = await snapshot(a.comp.competitionId, [a.comp.actor]);
    await rejects(
      commit(a.comp.actor, a.versionId, h),
      DomainErrorCode.CONCURRENCY_CONFLICT,
      'PROPOSAL_STALE',
    );
    expect(await snapshot(a.comp.competitionId, [a.comp.actor])).toEqual(before);

    // Competition COMPLETED (every event terminal first): the schedule is closed.
    await comps.completeCompetition({
      actorAccountId: a.comp.actor,
      competitionId: a.comp.competitionId,
    });
    before = await snapshot(a.comp.competitionId, [a.comp.actor]);
    await rejects(commit(a.comp.actor, a.versionId, h), DomainErrorCode.INVALID_TRANSITION);
    expect(await snapshot(a.comp.competitionId, [a.comp.actor])).toEqual(before);

    // Competition CANCELLED between preview and commit.
    const b = await setup();
    const hb = (await preview(b.comp.actor, b.versionId)).proposal.proposalHash;
    await comps.cancelCompetition({
      actorAccountId: b.comp.actor,
      competitionId: b.comp.competitionId,
      reason: 'storm',
    });
    before = await snapshot(b.comp.competitionId, [b.comp.actor]);
    await rejects(commit(b.comp.actor, b.versionId, hb), DomainErrorCode.INVALID_TRANSITION);
    expect(await snapshot(b.comp.competitionId, [b.comp.actor])).toEqual(before);
  }, 600_000);

  it('a draft discarded after the preview is NOT_A_DRAFT; an unknown version is NOT_FOUND', async () => {
    const { comp, versionId } = await setup();
    const h = (await preview(comp.actor, versionId)).proposal.proposalHash;
    await schedule.discard({
      actorAccountId: comp.actor,
      versionId,
      reason: 'restart',
      idempotencyKey: k(),
    });
    const before = await snapshot(comp.competitionId, [comp.actor]);
    await rejects(
      commit(comp.actor, versionId, h),
      DomainErrorCode.INVALID_TRANSITION,
      'NOT_A_DRAFT',
    );
    await rejects(commit(comp.actor, newId(), h), DomainErrorCode.NOT_FOUND);
    expect(await snapshot(comp.competitionId, [comp.actor])).toEqual(before);
  }, 300_000);
});

// ───────────────────────────── eligibility (ADR-0076) ─────────────────────────────

describe('only SUCCESS is committable (ADR-0076 C1, C8): refusals write nothing', () => {
  const notCommittable = async (comp: Comp, versionId: string, status: string) => {
    const { proposal: p } = await preview(comp.actor, versionId);
    expect(p.status).toBe(status);
    const before = await snapshot(comp.competitionId, [comp.actor]);
    const key = k();
    await expect(
      commit(comp.actor, versionId, p.proposalHash, { idempotencyKey: key }),
    ).rejects.toMatchObject({
      code: DomainErrorCode.INVALID_TRANSITION,
      details: { reason: 'PROPOSAL_NOT_COMMITTABLE', status },
    });
    // Zero writes: no fact, event, audit, outbox or idempotency record.
    expect(await snapshot(comp.competitionId, [comp.actor])).toEqual(before);
    expect(await idempotencyRows(comp.actor, key)).toBe(0);
    return p;
  };

  it('INFEASIBLE (placements exist) is refused; stale wins over non-committable', async () => {
    const comp = await competition();
    await tennis(comp, {
      window: { startsAt: '2027-09-01T12:00:00Z', endsAt: '2027-09-01T14:00:00Z' },
    });
    await resource(comp, 'TENNIS_COURT', 'Court 1');
    await openAllWeek(comp);
    const versionId = await draft(comp);
    const p = await notCommittable(comp, versionId, 'INFEASIBLE');
    expect(p.placements).toHaveLength(1);

    // ADR-0076 C5: after a state change the same hash is stale, whatever the recomputed status.
    await resource(comp, 'TENNIS_COURT', 'Court 2');
    await rejects(
      commit(comp.actor, versionId, p.proposalHash),
      DomainErrorCode.CONCURRENCY_CONFLICT,
      'PROPOSAL_STALE',
    );
  }, 300_000);

  it('NOTHING_TO_PLACE and NO_CANDIDATES are refused', async () => {
    const a = await competition();
    const ev = await tennis(a);
    const court = await resource(a, 'TENNIS_COURT', 'Court 1');
    await openAllWeek(a);
    const va = await draft(a);
    for (const [i, c] of ev.contests.entries())
      await schedule.setAssignment({
        actorAccountId: a.actor,
        versionId: va,
        contestId: c.id,
        assignment: { resourceId: court, startsAt: `2027-09-0${2 + i}T12:00:00Z` },
        idempotencyKey: k(),
      });
    await notCommittable(a, va, 'NOTHING_TO_PLACE');

    const b = await competition();
    await plannedEvent(b, {
      discipline: 'tennis',
      format: 'se',
      ruleset: 'sets-bo3-tiebreak',
      profile: 'tennis-court-match',
      formatConfig: { drawSize: 2 },
      entrants: 2,
    });
    await resource(b, 'PADEL_COURT', 'Padel 1');
    await openAllWeek(b);
    await notCommittable(b, await draft(b), 'NO_CANDIDATES');
  }, 300_000);

  it('SEARCH_EXHAUSTED (a budget artefact) is refused', async () => {
    const comp = await competition();
    const MONTH = { startsAt: '2027-09-01T00:00:00Z', endsAt: '2027-09-29T00:00:00Z' };
    // As the preview suite: twenty courts held for the whole horizon, so the target unit spends its
    // whole per-unit budget without a decision.
    const filler = await plannedEvent(comp, {
      discipline: 'tennis',
      format: 'se',
      ruleset: 'sets-bo3-tiebreak',
      profile: 'tennis-court-match',
      formatConfig: { drawSize: 32 },
      entrants: 32,
      window: MONTH,
    });
    const target = await plannedEvent(comp, {
      discipline: 'tennis',
      format: 'se',
      ruleset: 'sets-bo3-tiebreak',
      profile: 'tennis-court-match',
      formatConfig: { drawSize: 2 },
      entrants: 2,
      window: MONTH,
    });
    const courts = [];
    for (let i = 0; i < 20; i++) courts.push(await resource(comp, 'TENNIS_COURT', `Court ${i}`));
    await openAllWeek(comp);
    const versionId = await draft(comp);
    for (const [i, court] of courts.entries())
      await schedule.setAssignment({
        actorAccountId: comp.actor,
        versionId,
        contestId: filler.contests[i]?.id as string,
        assignment: {
          resourceId: court,
          startsAt: MONTH.startsAt,
          expectedEnd: '2027-10-01T00:00:00Z',
        },
        idempotencyKey: k(),
      });
    const scope = { eventIds: [target.eventId] };
    const { proposal: p } = await preview(comp.actor, versionId, { scope });
    expect(p.status).toBe('SEARCH_EXHAUSTED');
    const before = await snapshot(comp.competitionId, [comp.actor]);
    await expect(commit(comp.actor, versionId, p.proposalHash, { scope })).rejects.toMatchObject({
      code: DomainErrorCode.INVALID_TRANSITION,
      details: { reason: 'PROPOSAL_NOT_COMMITTABLE', status: 'SEARCH_EXHAUSTED' },
    });
    expect(await snapshot(comp.competitionId, [comp.actor])).toEqual(before);
  }, 900_000);
});

// ───────────────────────────── authorization and tampering ─────────────────────────────

describe('authorization at commit time and client tampering', () => {
  it('COMP_MANAGE_SCHEDULE re-resolved in the commit transaction: revoked after preview, strangers, registration managers', async () => {
    const { comp, versionId } = await setup();
    const staff = async (role: 'SCHEDULER' | 'REGISTRATION_MANAGER') => {
      const a = await newTestAccount(identity);
      const { staffId } = await comps.assignStaff({
        actorAccountId: comp.actor,
        competitionId: comp.competitionId,
        personId: a.personId as string,
        role,
        idempotencyKey: k(),
      });
      return { accountId: a.accountId, staffId };
    };
    const h = (await preview(comp.actor, versionId)).proposal.proposalHash;
    const scheduler = await staff('SCHEDULER');
    // The scheduler previews (authorized then) and loses the role before committing.
    expect((await preview(scheduler.accountId, versionId)).proposal.proposalHash).toBe(h);
    await comps.endStaff({ actorAccountId: comp.actor, staffId: scheduler.staffId });
    const registrar = await staff('REGISTRATION_MANAGER');
    const other = await competition();
    const actors = [
      scheduler.accountId,
      registrar.accountId,
      other.actor,
      (await newTestAccount(identity)).accountId,
    ];
    const before = await snapshot(comp.competitionId, actors);
    for (const actor of actors)
      await rejects(commit(actor, versionId, h), DomainErrorCode.FORBIDDEN);
    // Nothing written, not even the DENIED audit (it rolls back with the refused transaction).
    expect(await snapshot(comp.competitionId, actors)).toEqual(before);

    // A current SCHEDULER may commit (OWNER, ADMIN, SCHEDULER hold COMP_MANAGE_SCHEDULE).
    const current = await staff('SCHEDULER');
    const r = await commit(current.accountId, versionId, h);
    expect(r.created).toBe(true);
    expect(new Set((await facts(versionId)).map((f) => f.actor_account_id))).toEqual(
      new Set([current.accountId]),
    );
  }, 300_000);

  it('client values are never authoritative: forged placements, resources, instants and status change nothing', async () => {
    const { comp, ev, versionId } = await setup();
    const other = await competition();
    const foreignCourt = await resource(other, 'TENNIS_COURT', 'Elsewhere');
    const { proposal: p } = await preview(comp.actor, versionId);
    // A request smuggling authoritative-looking fields (no such fields exist in the command).
    const forged = {
      placements: ev.contests.map((c) => ({
        contestId: c.id,
        resourceId: foreignCourt,
        start: epoch('2030-01-01T00:00:00Z'),
        expectedEnd: epoch('2030-01-01T01:00:00Z'),
      })),
      resourceId: foreignCourt,
      startsAt: '2030-01-01T00:00:00Z',
      expectedEnd: '2030-01-01T01:00:00Z',
      status: 'SUCCESS',
      baseStateIdentity: `sha256:${'1'.repeat(64)}`,
    } as unknown as Partial<CommitInput>;
    await commit(comp.actor, versionId, p.proposalHash, forged);
    const stored = await facts(versionId);
    expect(
      stored.map((f) => ({
        contestId: f.contest_id,
        resourceId: f.resource_id,
        start: f.starts_at.getTime() / 1000,
        expectedEnd: (f.expected_end as Date).getTime() / 1000,
      })),
    ).toEqual(
      p.placements.map((x) => ({
        contestId: x.contestId,
        resourceId: x.resourceId,
        start: x.start,
        expectedEnd: x.expectedEnd,
      })),
    );
    expect(stored.map((f) => f.resource_id)).not.toContain(foreignCourt);

    // A failed run's hash can never become a commit by claiming success: the status is the
    // recomputation's (INFEASIBLE above); here a status claim with a fabricated hash is just stale.
    const c2 = await setup();
    await rejects(
      commit(c2.comp.actor, c2.versionId, `sha256:${'f'.repeat(64)}`, {
        status: 'SUCCESS',
      } as unknown as Partial<CommitInput>),
      DomainErrorCode.CONCURRENCY_CONFLICT,
      'PROPOSAL_STALE',
    );
  }, 300_000);
});

// ───────────────────────────── concurrency ─────────────────────────────

describe('concurrent commits (ADR-0075 § 18): advisory lock + recomputation, never last-write-wins', () => {
  it('two connections commit the same preview: exactly one succeeds, the other is stale; one set of facts', async () => {
    const { comp, versionId } = await setup();
    const { proposal: p } = await preview(comp.actor, versionId);
    const other = new ScheduleStore(db2);
    const results = await Promise.allSettled([
      commit(comp.actor, versionId, p.proposalHash),
      commit(comp.actor, versionId, p.proposalHash, {}, other),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({
      code: DomainErrorCode.CONCURRENCY_CONFLICT,
      details: { reason: 'PROPOSAL_STALE' },
    });
    const stored = await facts(versionId);
    expect(stored).toHaveLength(3);
    expect(new Set(stored.map((f) => f.contest_id)).size).toBe(3);
    expect(
      (await outboxOf(versionId)).filter((e) => e.event_type === 'ScheduleProposalCommitted'),
    ).toHaveLength(1);
  }, 300_000);

  it('two different proposals over the same draft race: one wins, the other is stale, nothing interleaves', async () => {
    const { comp, ev, versionId } = await setup();
    const semis = { roundIds: [ev.contests[0]?.roundId as string] };
    // Two different SUCCESS proposals of one base: the semis only, and the whole competition.
    const a = (await preview(comp.actor, versionId, { scope: semis })).proposal;
    const whole = (await preview(comp.actor, versionId)).proposal;
    expect([a.status, whole.status]).toEqual(['SUCCESS', 'SUCCESS']);
    expect(a.proposalHash).not.toBe(whole.proposalHash);
    const results = await Promise.allSettled([
      commit(comp.actor, versionId, a.proposalHash, { scope: semis }),
      commit(comp.actor, versionId, whole.proposalHash, {}, new ScheduleStore(db2)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toMatchObject({
      code: DomainErrorCode.CONCURRENCY_CONFLICT,
      details: { reason: 'PROPOSAL_STALE' },
    });
    // The facts are exactly one proposal's: one reason, each contest at most once.
    const stored = await facts(versionId);
    expect(new Set(stored.map((f) => f.reason)).size).toBe(1);
    expect(new Set(stored.map((f) => f.contest_id)).size).toBe(stored.length);
  }, 300_000);

  it('the same key raced on two connections: one commit, one replay', async () => {
    const { comp, versionId } = await setup();
    const { proposal: p } = await preview(comp.actor, versionId);
    const key = k();
    const [x, y] = await Promise.all([
      commit(comp.actor, versionId, p.proposalHash, { idempotencyKey: key }),
      commit(
        comp.actor,
        versionId,
        p.proposalHash,
        { idempotencyKey: key },
        new ScheduleStore(db2),
      ),
    ]);
    expect([x.created, y.created].sort()).toEqual([false, true]);
    const { created: _x, ...rx } = x;
    const { created: _y, ...ry } = y;
    expect(rx).toEqual(ry);
    expect(await facts(versionId)).toHaveLength(3);
  }, 300_000);
});

// ───────────────────────────── failure atomicity ─────────────────────────────

describe('failure atomicity: a failure at any step leaves no trace (real rollback)', () => {
  it('assignment, outbox, audit and idempotency write failures each roll back everything; a retry then succeeds', async () => {
    const { comp, ev, versionId } = await setup();
    const { proposal: p } = await preview(comp.actor, versionId);
    const lastContest = [...ev.contests.map((c) => c.id)].sort().at(-1) as string;
    const key = k();
    const before = await snapshot(comp.competitionId, [comp.actor]);
    const attempt = () => commit(comp.actor, versionId, p.proposalHash, { idempotencyKey: key });
    const unchanged = async () => {
      expect(await snapshot(comp.competitionId, [comp.actor])).toEqual(before);
      expect(await idempotencyRows(comp.actor, key)).toBe(0);
    };

    // A. The LAST assignment insert fails (two facts, their events and audits already written).
    await withFault(
      'competition.schedule_assignment',
      `NEW.contest_id = '${lastContest}'::uuid AND NEW.reason LIKE 'proposal %'`,
      () => expect(attempt()).rejects.toThrow(/injected fault/),
    );
    await unchanged();

    // B. The per-fact outbox event of the last fact fails.
    await withFault(
      'platform.outbox_event',
      `NEW.event_type = 'ScheduleAssignmentChanged' AND NEW.payload->>'contestId' = '${lastContest}'`,
      () => expect(attempt()).rejects.toThrow(/injected fault/),
    );
    await unchanged();

    // C. The commit's own outbox event fails (after every fact was written).
    await withFault(
      'platform.outbox_event',
      `NEW.event_type = 'ScheduleProposalCommitted' AND NEW.aggregate_id = '${versionId}'::uuid`,
      () => expect(attempt()).rejects.toThrow(/injected fault/),
    );
    await unchanged();

    // D. The commit audit fails.
    await withFault(
      'platform.audit_event',
      `NEW.action = 'schedule.proposal-committed' AND NEW.target_id = '${versionId}'::uuid`,
      () => expect(attempt()).rejects.toThrow(/injected fault/),
    );
    await unchanged();

    // E. The idempotency record (the last write) fails.
    await withFault(
      'platform.command_idempotency',
      `NEW.command_type = 'CommitScheduleProposal' AND NEW.scope = '${comp.actor}'`,
      () => expect(attempt()).rejects.toThrow(/injected fault/),
    );
    await unchanged();

    // Nothing was recorded under the key, so the same request now commits normally.
    const r = await attempt();
    expect(r.created).toBe(true);
    expect(await facts(versionId)).toHaveLength(3);
  }, 600_000);

  it('a write-path value that differs from the hashed placement is an invariant failure: nothing written', async () => {
    const { comp, versionId } = await setup();
    const { proposal: p } = await preview(comp.actor, versionId);
    const before = await snapshot(comp.competitionId, [comp.actor]);
    // Probe: the store derives the opposite provisional flag (a forced divergence of the two sources).
    const probe = new ScheduleStore(db);
    const internals = probe as unknown as {
      provisional: (ctx: unknown, contestId: string, dynamic: boolean) => Promise<boolean>;
    };
    const derive = internals.provisional.bind(probe);
    internals.provisional = async (ctx, contestId, dynamic) =>
      !(await derive(ctx, contestId, dynamic));
    await expect(commit(comp.actor, versionId, p.proposalHash, {}, probe)).rejects.toThrow(
      /proposal commit invariant/,
    );
    expect(await snapshot(comp.competitionId, [comp.actor])).toEqual(before);
  }, 300_000);

  it('a resource retired between preview and commit is stale; the commit path keeps the write-path refusals', async () => {
    const { comp, courts, versionId } = await setup();
    const h = (await preview(comp.actor, versionId)).proposal.proposalHash;
    await resources.setResourceStatus({
      actorAccountId: comp.actor,
      resourceId: courts[1] as string,
      status: 'RETIRED',
      reason: 'flooded',
      idempotencyKey: k(),
    });
    const before = await snapshot(comp.competitionId, [comp.actor]);
    await rejects(
      commit(comp.actor, versionId, h),
      DomainErrorCode.CONCURRENCY_CONFLICT,
      'PROPOSAL_STALE',
    );
    expect(await snapshot(comp.competitionId, [comp.actor])).toEqual(before);
  }, 300_000);
});

// ───────────────────────────── source guards and cross-sport ─────────────────────────────

interface SportCase extends EventSpec {
  readonly sport: string;
  readonly resources: readonly [typeCode: string, extra: Record<string, unknown>][];
}

const lanes = (i: number) => ({
  capacity: 4,
  exclusivityKeys: [`lane-${2 * i + 1}`, `lane-${2 * i + 2}`],
});

const SPORTS: readonly SportCase[] = [
  {
    sport: 'tennis',
    discipline: 'tennis',
    format: 'se',
    ruleset: 'sets-bo3-tiebreak',
    profile: 'tennis-court-match',
    formatConfig: { drawSize: 4 },
    entrants: 4,
    resources: [
      ['TENNIS_COURT', {}],
      ['TENNIS_COURT', {}],
    ],
  },
  {
    sport: 'padel',
    discipline: 'padel',
    format: 'gk',
    ruleset: 'padel-bo3-star-point',
    profile: 'padel-court-match',
    formatConfig: { groupCount: 2, qualifiersPerGroup: 2 },
    teams: { count: 8, size: 2, kind: 'EVENT_PAIR' },
    resources: [
      ['PADEL_COURT', {}],
      ['PADEL_COURT', {}],
    ],
  },
  {
    sport: 'running',
    discipline: 'road',
    format: 'wave',
    ruleset: 'road-gun-time',
    profile: 'road-course-waves',
    formatConfig: { waveCapacity: 10 },
    entrants: 20,
    resources: [['ROAD_COURSE', { capacity: 1000 }]],
  },
  {
    sport: 'swimming',
    discipline: 'pool',
    format: 'heats',
    ruleset: 'swim-hundredths',
    profile: 'pool-heats',
    formatConfig: { qualifyByTime: 8 },
    entrants: 16,
    byEntryTime: true,
    resources: [['POOL', {}]],
  },
  {
    sport: 'cycling',
    discipline: 'cycling',
    format: 'mr',
    ruleset: 'cycling-road-same-time',
    profile: 'cycling-course-stage',
    formatConfig: { rounds: 2 },
    entrants: 10,
    resources: [['CYCLING_COURSE', { capacity: 500 }]],
  },
  {
    sport: 'bowling',
    discipline: 'bowling',
    format: 'qk',
    ruleset: 'bowling-6-games-scratch',
    profile: 'bowling-lane-pair-blocks',
    formatConfig: { groupSize: 8, qualifiers: 4 },
    entrants: 8,
    resources: [
      ['BOWLING_LANE_PAIR', lanes(0)],
      ['BOWLING_LANE_PAIR', lanes(1)],
    ],
  },
  {
    sport: 'basketball',
    discipline: 'b3x3',
    format: 'gk',
    ruleset: '3x3-10min-21',
    profile: 'basketball-half-court-3x3',
    formatConfig: { groupCount: 2, qualifiersPerGroup: 2 },
    teams: { count: 6, size: 4, kind: 'EVENT_SQUAD' },
    resources: [
      ['BASKETBALL_HALF_COURT', {}],
      ['BASKETBALL_HALF_COURT', {}],
    ],
  },
  {
    sport: 'golf',
    discipline: 'golf',
    format: 'mr',
    ruleset: 'golf-stroke-gross',
    profile: 'golf-course-tee-groups',
    formatConfig: { rounds: 2, groupSize: 4 },
    entrants: 8,
    resources: [['GOLF_COURSE', { capacity: 144 }]],
  },
];

describe('cross-sport commit: the same path for every sport (ADR-0075 § 21)', () => {
  it('the commit path names no sport, discipline or resource type, and never raises the isolation level', () => {
    const source = readFileSync(new URL('./schedule-store.ts', import.meta.url), 'utf8');
    const path = source.slice(
      source.indexOf('private async proposalInput('),
      source.indexOf('// ───────────────────────────── drafts'),
    );
    expect(path).toContain('async commitProposal(');
    expect(path).not.toMatch(
      /\b(tennis|padel|running|marathon|swim\w*|cycling|bowling|basketball|golf)\b/i,
    );
    expect(path).not.toMatch(/sport|discipline|_COURT|_LANE|COURSE|POOL/);
    // F architecture § 12: READ COMMITTED, so reads after the lock see the previous holder's facts.
    expect(path).not.toMatch(/isolation\s*:|setIsolationLevel|SET\s+TRANSACTION\s+ISOLATION/i);
  });

  it.each(SPORTS)(
    '$sport: the committed facts are the SUCCESS proposal exactly (unit keys, provisional, resources)',
    async (c) => {
      const comp = await competition();
      const ev = await plannedEvent(comp, c);
      for (const [i, [typeCode, extra]] of c.resources.entries())
        await resource(comp, typeCode, `${c.sport} ${i + 1}`, extra);
      await openAllWeek(comp);
      const versionId = await draft(comp);
      const { proposal: p } = await preview(comp.actor, versionId);
      expect(p.status).toBe('SUCCESS');
      const r = await commit(comp.actor, versionId, p.proposalHash);
      expect(r.placedContests).toBe(ev.contests.length);
      const stored = await facts(versionId);
      expect(
        stored.map((f) => ({
          contestId: f.contest_id,
          unitKey: f.unit_key,
          resourceId: f.resource_id,
          start: f.starts_at.getTime() / 1000,
          expectedEnd: (f.expected_end as Date).getTime() / 1000,
          changeoverSeconds: f.changeover_seconds,
          zone: f.zone,
          provisional: f.provisional,
        })),
      ).toEqual(p.placements.map(({ softConflictKeys: _, ...x }) => x));
      // The committed draft is judged by the same engine publication uses: no HARD conflict.
      expect(
        (await schedule.validate({ actorAccountId: comp.actor, versionId })).hardConflicts,
      ).toBe(0);
    },
    600_000,
  );
});
