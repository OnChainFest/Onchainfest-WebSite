import { readFileSync } from 'node:fs';
import {
  ADVANCEMENT_POLICY_TEMPLATES,
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
  uniqueSlug,
  lastScheduleFact,
} from '@br/testkit';
import { sql } from 'kysely';
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
import { refreshCompetitionCard, refreshCompetitionEvents } from './competition-projection';
import { inTransaction, ModuleRole } from './tx';
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
const advancement = new AdvancementStore(db, scoring);
const authority = new AuthorityStore(db, { conflictChecker: declaredNoParticipation });
const ledger = createCompetitionResultLedger(db, { conflictChecker: declaredNoParticipation });
const resolver = new CompetitionHierarchyResolver(db);
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
      // ONCF-05E-F-4: the 05D axes, so results and advancement can change state between a preview
      // and its commit exactly as in production.
      advancementPolicies: ADVANCEMENT_POLICY_TEMPLATES.map((t) => ({
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
    if (x.discipline.code.startsWith(`f${tag}.`))
      ids[x.discipline.code.split('.')[1] as string] = x.disciplineVersionId;
  for (const fv of listed.formatVersions)
    if (fv.format.code.endsWith(`-${tag}`))
      ids[fv.format.code.split('-')[0] as string] = fv.formatVersionId;
  for (const r of listed.rulesetVersions)
    if (r.code.startsWith(`r${tag}-`)) ids[`rs:${r.code.slice(`r${tag}-`.length)}`] = r.versionId;
  for (const p of listed.schedulingProfileVersions)
    if (p.code.startsWith(`p${tag}-`)) ids[`sp:${p.code.slice(`p${tag}-`.length)}`] = p.versionId;
  for (const t of listed.classificationTemplateVersions)
    if (t.code.startsWith(`t${tag}_`)) ids[`tp:${t.code.slice(`t${tag}_`.length)}`] = t.versionId;
  for (const a of listed.advancementPolicyVersions)
    if (a.code.startsWith(`a${tag}-`)) ids[`ap:${a.code.slice(`a${tag}-`.length)}`] = a.versionId;
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
  /** 05D axes (ONCF-05E-F-4): an advancement policy and a classification template to pin. */
  policy?: string;
  template?: string;
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
    ...(o.policy === undefined
      ? {}
      : { advancementPolicyVersionId: ids[`ap:${o.policy}`] as string }),
    ...(o.template === undefined
      ? {}
      : { classificationTemplateVersionId: ids[`tp:${o.template}`] as string }),
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
      expectedLastFactId: await lastScheduleFact(db, sf1.id, first),
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
        expectedLastFactId: await lastScheduleFact(db, c.id, versionId),
        idempotencyKey: k(),
      });
    await schedule.setLock({
      actorAccountId: comp.actor,
      versionId,
      contestId: sf1.id,
      locked: true,
      reason: null,
      expectedLastFactId: await lastScheduleFact(db, sf1.id, versionId),
      idempotencyKey: k(),
    });
    await schedule.removeAssignment({
      actorAccountId: comp.actor,
      versionId,
      contestId: final.id,
      reason: 'make room',
      expectedLastFactId: await lastScheduleFact(db, final.id, versionId),
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
      expectedLastFactId: await lastScheduleFact(db, sf1.id, versionId),
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
      expectedLastFactId: await lastScheduleFact(db, sf1.id, versionId),
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

    // Competition COMPLETED: the schedule is closed. ONCF-L6 (ADR-0078 §2.4): a competition whose
    // only category was cancelled can no longer complete (NO_COMPLETED_EVENT), so the completed
    // competition this case needs is grandfathered pre-L6 data, written directly as such.
    await rejects(
      comps.completeCompetition({
        actorAccountId: a.comp.actor,
        competitionId: a.comp.competitionId,
      }),
      DomainErrorCode.INVALID_TRANSITION,
      'NO_COMPLETED_EVENT',
    );
    await inTransaction(db, ModuleRole.competition, async (ctx) => {
      await sql`INSERT INTO competition.competition_status_change (id, competition_id, status, actor_account_id, recorded_at)
        VALUES (${newId()}, ${a.comp.competitionId}, 'COMPLETED', ${a.comp.actor}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await refreshCompetitionCard(ctx, a.comp.competitionId);
      await refreshCompetitionEvents(ctx, a.comp.competitionId);
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
        expectedLastFactId: await lastScheduleFact(db, c.id, va),
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
        expectedLastFactId: await lastScheduleFact(db, filler.contests[i]?.id as string, versionId),
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
  /** The resource shape this case proves (the preview suite's table; asserted from data only). */
  readonly shape?: 'EXCLUSIVE_PAIR' | 'GROUPED_EXCLUSIVE' | 'GROUPED_SHARED';
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
    shape: 'EXCLUSIVE_PAIR',
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
    shape: 'GROUPED_EXCLUSIVE',
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
    shape: 'GROUPED_SHARED',
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
      const own = [];
      for (const [i, [typeCode, extra]] of c.resources.entries())
        own.push(await resource(comp, typeCode, `${c.sport} ${i + 1}`, extra));
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

      // ONCF-05E-F architecture § 25 (05E-F-4): the preview suite's shape table, asserted on the
      // PERSISTED facts — grouped units stay one unit (one start) through the per-fact write path.
      const units = new Map<string, typeof stored>();
      for (const f of stored)
        units.set(f.unit_key as string, [...(units.get(f.unit_key as string) ?? []), f]);
      const startOf = (f: (typeof stored)[number]) => f.starts_at.getTime() / 1000;
      if (c.shape === 'GROUPED_EXCLUSIVE') {
        // The squad: eight facts of one unit, one start, packed over both EXCLUSIVE lane pairs.
        const squad = [...units.values()].find((u) => u.length === 8);
        expect(squad).toBeDefined();
        expect(new Set(squad?.map(startOf)).size).toBe(1);
        expect(new Set(squad?.map((f) => f.resource_id))).toEqual(new Set(own));
      }
      if (c.shape === 'GROUPED_SHARED') {
        // Tee groups: several facts per unit on the one SHARED course, each group with one start.
        const groups = [...units.values()].filter((u) => u.length > 1);
        expect(groups.length).toBeGreaterThan(0);
        for (const g of groups) expect(new Set(g.map(startOf)).size).toBe(1);
        expect(new Set(stored.map((f) => f.resource_id))).toEqual(new Set(own));
      }
      if (c.shape === 'EXCLUSIVE_PAIR') {
        // EXCLUSIVE resources: the two first-round contests share a start on two resources.
        const first = stored.filter((f) => startOf(f) === epoch(WEEK.startsAt));
        expect(first).toHaveLength(2);
        expect(new Set(first.map((f) => f.resource_id))).toEqual(new Set(own));
      }
      // The committed draft is judged by the same engine publication uses: no HARD conflict.
      expect(
        (await schedule.validate({ actorAccountId: comp.actor, versionId })).hardConflicts,
      ).toBe(0);
    },
    600_000,
  );
});

// ───────────────────────────── ONCF-05E-F-4 hardening ─────────────────────────────

/**
 * ONCF-05E-F-4 (ONCF-05E-F architecture §§ 5, 25, 28): every remaining authoritative change between
 * a preview and its commit, produced only through the production commands (no SQL mutation), is
 * refused as `PROPOSAL_STALE` with the whole competition snapshot and the key's idempotency record
 * unchanged; each case then shows the CURRENT state still commits afresh (the refusal is the stale
 * hash, never the state).
 */
async function refusedAsStale(comp: Comp, versionId: string, hash: string) {
  const before = await snapshot(comp.competitionId, [comp.actor]);
  const key = k();
  await rejects(
    commit(comp.actor, versionId, hash, { idempotencyKey: key }),
    DomainErrorCode.CONCURRENCY_CONFLICT,
    'PROPOSAL_STALE',
  );
  expect(await snapshot(comp.competitionId, [comp.actor])).toEqual(before);
  expect(await idempotencyRows(comp.actor, key)).toBe(0);
}

/** On the current state: a fresh preview is SUCCESS and commits exactly its own placements. */
async function commitsAfresh(comp: Comp, versionId: string) {
  const { proposal: p } = await preview(comp.actor, versionId);
  expect(p.status, JSON.stringify(p.unplaced)).toBe('SUCCESS');
  const before = await facts(versionId);
  const r = await commit(comp.actor, versionId, p.proposalHash);
  expect(r.placedContests).toBe(p.placements.length);
  const added = (await facts(versionId)).slice(before.length);
  expect(
    added.map((f) => [f.contest_id, f.resource_id, f.starts_at.getTime() / 1000, f.reason]),
  ).toEqual(
    [...p.placements]
      .sort((a, b) => (a.contestId < b.contestId ? -1 : 1))
      .map((x) => [x.contestId, x.resourceId, x.start, `proposal ${p.proposalHash}`]),
  );
  return p;
}

const hashOf = async (comp: Comp, versionId: string) =>
  (await preview(comp.actor, versionId)).proposal.proposalHash;

/** A referee holding the sporting capabilities on this competition (Authority Engine grant). */
async function referee(competitionId: string) {
  const platform = await authority.registerPrincipal({
    principalType: 'PLATFORM',
    label: 'platform (05E-F-4)',
  });
  await authority.recognizeTrustAnchor({
    principalId: platform.id,
    recognitionScope: { recognitionLevel: ['PLATFORM'] },
    basisRef: 'fixture',
    governanceDecisionRef: `fx-${newId()}`,
  });
  const ref = await authority.registerPrincipal({
    principalType: 'PERSON',
    label: 'referee (05E-F-4)',
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
  const result = await ledger.createResult({
    scopeType: 'CONTEST',
    scopeTargetId: contestId as Uuid,
  });
  const scope = await resolver.scopeOf('CONTEST', contestId, { recognitionLevel: 'PLATFORM' });
  const { draftId } = await ledger.saveDraft({
    resultId: result.id,
    authorPrincipalId: ref,
    disciplineVersionRef: 'oncf05e-f@1',
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

/** Commit every pending 05D unit whose key starts with `prefix`, as its organizer does. */
async function advance(comp: Comp, eventId: string, prefix: string) {
  const s = await advancement.state({ actorAccountId: comp.actor, eventId });
  const units = s.units.filter((u) => u.unitKey.startsWith(prefix));
  expect(units.length).toBeGreaterThan(0);
  return advancement.commit({
    actorAccountId: comp.actor,
    eventId,
    units: units.map((u) => ({ unitKey: u.unitKey, previewHash: u.previewHash })),
    idempotencyKey: k(),
  });
}

/** The judge's hashed inputs for the draft (05E-D `validate`, read-only). */
const inputsOf = async (comp: Comp, versionId: string) =>
  (await schedule.validate({ actorAccountId: comp.actor, versionId })).report.inputs;

describe('ONCF-05E-F-4: resource, availability and draft edits between preview and commit', () => {
  it('a resource revised, or retired and then reactivated, after the preview is PROPOSAL_STALE', async () => {
    const { comp, courts, versionId } = await setup();
    const [c1, c2] = courts as [string, string];

    // A. Revision: a new revision of an ACTIVE court (new label; type and status unchanged).
    const h = await hashOf(comp, versionId);
    const rev = await resources.reviseResource({
      actorAccountId: comp.actor,
      resourceId: c1,
      resource: { label: 'Court 1 (resurfaced)' },
      idempotencyKey: k(),
    });
    expect(rev).toMatchObject({ revision: 2, created: true });
    await refusedAsStale(comp, versionId, h);

    // B. Reactivation (ACTIVE ↔ RETIRED is the resource lifecycle): retired before the preview,
    // which then uses the one active court; reactivated before the commit.
    await resources.setResourceStatus({
      actorAccountId: comp.actor,
      resourceId: c2,
      status: 'RETIRED',
      reason: 'flooded',
      idempotencyKey: k(),
    });
    const { proposal: oneCourt } = await preview(comp.actor, versionId);
    expect(oneCourt.status).toBe('SUCCESS');
    expect(new Set(oneCourt.placements.map((x) => x.resourceId))).toEqual(new Set([c1]));
    await resources.setResourceStatus({
      actorAccountId: comp.actor,
      resourceId: c2,
      status: 'ACTIVE',
      reason: 'drained',
      idempotencyKey: k(),
    });
    await refusedAsStale(comp, versionId, oneCourt.proposalHash);

    const fresh = await commitsAfresh(comp, versionId);
    expect(fresh.proposalHash).not.toBe(oneCourt.proposalHash);
  }, 600_000);

  it('an availability fact revoked after the preview is PROPOSAL_STALE', async () => {
    const { comp, courts, versionId } = await setup();
    // A blackout declared before the preview and revoked (append-only revocation) before the commit.
    const { availabilityId } = await resources.addAvailability({
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
    const h = await hashOf(comp, versionId);
    const before = await inputsOf(comp, versionId);
    await resources.revokeAvailability({
      actorAccountId: comp.actor,
      availabilityId,
      reason: 'maintenance cancelled',
      idempotencyKey: k(),
    });
    const after = await inputsOf(comp, versionId);
    expect(before.availabilityFactIds).toContain(availabilityId);
    expect(after.availabilityFactIds).not.toContain(availabilityId);
    await refusedAsStale(comp, versionId, h);
    await commitsAfresh(comp, versionId);
  }, 600_000);

  it('a draft assignment moved, unlocked or removed after the preview is PROPOSAL_STALE; the edit is never overwritten', async () => {
    const { comp, ev, courts, versionId } = await setup();
    const sf1 = (ev.contests[0] as (typeof ev.contests)[0]).id;
    const live = async () =>
      (await schedule.getVersion({ actorAccountId: comp.actor, versionId })).assignments.find(
        (a) => a.contestId === sf1,
      );
    await schedule.setAssignment({
      actorAccountId: comp.actor,
      versionId,
      contestId: sf1,
      assignment: { resourceId: courts[0] as string, startsAt: '2027-09-05T12:00:00Z' },
      expectedLastFactId: await lastScheduleFact(db, sf1, versionId),
      idempotencyKey: k(),
    });

    // A. Moved: another resource and time, with the mandatory reason.
    let h = await hashOf(comp, versionId);
    await schedule.setAssignment({
      actorAccountId: comp.actor,
      versionId,
      contestId: sf1,
      assignment: {
        resourceId: courts[1] as string,
        startsAt: '2027-09-06T12:00:00Z',
        reason: 'player request',
      },
      expectedLastFactId: await lastScheduleFact(db, sf1, versionId),
      idempotencyKey: k(),
    });
    await refusedAsStale(comp, versionId, h);
    expect(await live()).toMatchObject({
      resourceId: courts[1],
      startsAt: '2027-09-06T12:00:00.000Z',
      reason: 'player request',
      source: 'MANUAL',
    });

    // B. Unlocked: locked before the preview, unlocked (with a reason) before the commit.
    await schedule.setLock({
      actorAccountId: comp.actor,
      versionId,
      contestId: sf1,
      locked: true,
      reason: null,
      expectedLastFactId: await lastScheduleFact(db, sf1, versionId),
      idempotencyKey: k(),
    });
    h = await hashOf(comp, versionId);
    await schedule.setLock({
      actorAccountId: comp.actor,
      versionId,
      contestId: sf1,
      locked: false,
      reason: 'reopened',
      expectedLastFactId: await lastScheduleFact(db, sf1, versionId),
      idempotencyKey: k(),
    });
    await refusedAsStale(comp, versionId, h);
    expect(await live()).toMatchObject({ resourceId: courts[1], locked: false });

    // C. Removed (draft-only removal fact).
    h = await hashOf(comp, versionId);
    await schedule.removeAssignment({
      actorAccountId: comp.actor,
      versionId,
      contestId: sf1,
      reason: 'make room',
      expectedLastFactId: await lastScheduleFact(db, sf1, versionId),
      idempotencyKey: k(),
    });
    await refusedAsStale(comp, versionId, h);
    expect(await live()).toBeUndefined();

    // Only the organizer's five facts exist; no proposal fact was ever written.
    const history = await facts(versionId);
    expect(history).toHaveLength(5);
    expect(history.every((f) => f.contest_id === sf1 && !f.reason?.startsWith('proposal '))).toBe(
      true,
    );
    // The current state commits afresh; the removed contest is re-placed on its removal fact.
    const fresh = await commitsAfresh(comp, versionId);
    expect(fresh.placements.map((x) => x.contestId)).toContain(sf1);
    const replaced = (await facts(versionId)).find(
      (f) => f.contest_id === sf1 && f.reason === `proposal ${fresh.proposalHash}`,
    );
    expect(replaced?.replaces_assignment_id).toBe(history.at(-1)?.id);
  }, 600_000);
});

describe('ONCF-05E-F-4: 05D bracket and results changes between preview and commit', () => {
  it('a contest whose status changes after the preview (cancelled) is PROPOSAL_STALE; the fresh proposal omits it', async () => {
    const { comp, ev, versionId } = await setup();
    const final = (ev.contests[2] as (typeof ev.contests)[0]).id;
    const { proposal: p } = await preview(comp.actor, versionId);
    expect(p.status).toBe('SUCCESS');
    expect(p.placements.map((x) => x.contestId)).toContain(final);
    const before = await inputsOf(comp, versionId);

    await structure.cancelContest({ actorAccountId: comp.actor, contestId: final, reason: 'rain' });
    const after = await inputsOf(comp, versionId);
    // Exactly the contest status moved among the hashed inputs.
    expect(after.contestStatuses.find((c) => c.contestId === final)?.status).toBe('CANCELLED');
    expect({ ...after, contestStatuses: null }).toEqual({ ...before, contestStatuses: null });

    await refusedAsStale(comp, versionId, p.proposalHash);
    const fresh = await commitsAfresh(comp, versionId);
    expect(fresh.placements.map((x) => x.contestId)).not.toContain(final);
  }, 600_000);

  it('an occupant resolved by a 05D commit after the preview is PROPOSAL_STALE; the stale provisional final is never written', async () => {
    const comp = await competition();
    // The referee's grant is recorded before the event setup, well before its first use.
    const ref = await referee(comp.competitionId);
    const ev = await tennis(comp);
    // tennis() pins no advancement policy; this event pins one so 05D can resolve the final.
    const ko = await plannedEvent(comp, {
      discipline: 'tennis',
      format: 'se',
      ruleset: 'sets-bo3-tiebreak',
      profile: 'tennis-court-match',
      policy: 'official-confirmed',
      formatConfig: { drawSize: 4 },
      entrants: 4,
    });
    for (const label of ['Court 1', 'Court 2', 'Court 3', 'Court 4'])
      await resource(comp, 'TENNIS_COURT', label);
    await openAllWeek(comp);
    const versionId = await draft(comp);
    const [sf1, sf2, final] = ko.contests.map((c) => c.id) as [string, string, string];
    const win: ScoreSheet = {
      family: 'SETS_OF_GAMES',
      sets: [{ games: [6, 2] }, { games: [6, 3] }],
    };
    await official(comp.actor, ref, sf1, win);
    await official(comp.actor, ref, sf2, win);

    const { proposal: p } = await preview(comp.actor, versionId);
    expect(p.status).toBe('SUCCESS');
    const staleFinal = p.placements.find((x) => x.contestId === final);
    expect(staleFinal?.provisional).toBe(true);
    const before = await inputsOf(comp, versionId);

    // 05D commits the semifinal winners into the final's places.
    await advance(comp, ko.eventId, 'contest:');
    const after = await inputsOf(comp, versionId);
    // Exactly the occupancy digest moved (no contest status, resource, availability or pin).
    expect(after.occupancyDigest).not.toBe(before.occupancyDigest);
    expect({ ...after, occupancyDigest: null }).toEqual({ ...before, occupancyDigest: null });

    await refusedAsStale(comp, versionId, p.proposalHash);
    const fresh = await commitsAfresh(comp, versionId);
    expect(fresh.placements.find((x) => x.contestId === final)?.provisional).toBe(false);
    const written = (await facts(versionId)).find((f) => f.contest_id === final);
    expect(written).toMatchObject({ provisional: false, reason: `proposal ${fresh.proposalHash}` });
    // The other event was proposed and committed alongside, untouched by the 05D change.
    expect((await facts(versionId)).map((f) => f.contest_id).sort()).toEqual(
      [...ev.contests, ...ko.contests].map((c) => c.id).sort(),
    );
  }, 600_000);

  it('contests materialized by a committed 05D cut after the preview are PROPOSAL_STALE; the fresh proposal places them', async () => {
    const comp = await competition();
    // The referee's grant is recorded before the event setup, well before its first use.
    const ref = await referee(comp.competitionId);
    const ev = await plannedEvent(comp, {
      discipline: 'golf',
      format: 'mr',
      ruleset: 'golf-stroke-gross',
      profile: 'golf-course-tee-groups',
      template: 'golf_stroke',
      policy: 'field-cut-official',
      formatConfig: {
        rounds: 3,
        cutAfterRound: 2,
        cutTopN: 2,
        cutIncludesTies: true,
        groupSize: 3,
      },
      entrants: 5,
    });
    await resource(comp, 'GOLF_COURSE', 'Course', { capacity: 144 });
    await openAllWeek(comp);
    const versionId = await draft(comp);

    // Rounds 1 and 2 are OFFICIAL: three players make the cut (a tie at the line), one DNF.
    const { rows: occ } = await sql<{ contest_id: string; participant_id: string }>`
      SELECT contest_id, participant_id FROM competition.v_contest_occupant
      WHERE contest_id = ANY(${ev.contests.map((c) => c.id)}::uuid[])`.execute(owner);
    const players = [...new Set(occ.map((o) => o.participant_id))].sort();
    expect(players).toHaveLength(5);
    const card: Record<number, number[]> = { 1: [70, 71, 72, 75, 72], 2: [70, 71, 70, 75, -1] };
    const holes = (total: number) =>
      Array.from(
        { length: 18 },
        (_, i) => 4 + (i < Math.abs(total - 72) ? Math.sign(total - 72) : 0),
      );
    for (const c of ev.contests) {
      const p = occ.find((o) => o.contest_id === c.id)?.participant_id as string;
      const strokes = card[c.round]?.[players.indexOf(p)] as number;
      await official(comp.actor, ref, c.id, {
        family: 'STROKES',
        entries: [
          strokes < 0
            ? { participantId: p, status: 'DNF' }
            : { participantId: p, status: 'FINISHED', holes: holes(strokes) },
        ],
      });
    }

    // Fixture precondition (05D, before the preview): the cut field is resolved, three places.
    const pending = await advancement.state({ actorAccountId: comp.actor, eventId: ev.eventId });
    expect(
      pending.units
        .filter((u) => u.unitKey.startsWith('field:'))
        .flatMap((u) => u.targets.map((t) => t.proposed.state)),
    ).toEqual(['RESOLVED', 'RESOLVED', 'RESOLVED']);

    const { proposal: p } = await preview(comp.actor, versionId);
    const before = await inputsOf(comp, versionId);
    expect(before.contestStatuses).toHaveLength(ev.contests.length);

    // 05D commits the cut: the round-3 contests now exist (structure changed after the preview).
    const cut = await advance(comp, ev.eventId, 'field:');
    expect(cut.materializedContests).toBe(3);
    const after = await inputsOf(comp, versionId);
    const known = new Set(ev.contests.map((c) => c.id));
    const created = after.contestStatuses.map((c) => c.contestId).filter((id) => !known.has(id));
    expect(created).toHaveLength(3);

    // Whatever the stale proposal's status, a changed structure is stale first (ADR-0076 C5).
    await refusedAsStale(comp, versionId, p.proposalHash);
    expect(p.placements.map((x) => x.contestId)).not.toEqual(expect.arrayContaining(created));
    const fresh = await commitsAfresh(comp, versionId);
    expect(fresh.placements.map((x) => x.contestId)).toEqual(expect.arrayContaining(created));
  }, 900_000);
});

describe('ONCF-05E-F-4: event window and profile pin', () => {
  it('frozen for a locked event; another event of the competition edited after the preview is PROPOSAL_STALE', async () => {
    const { comp, ev, versionId } = await setup();
    // ADR-0069 § 1: a field-locked event's settings and pins cannot change at all, so the target
    // event's own window or profile can never change between a preview and its commit.
    await expect(
      comps.updateEventSettings({
        actorAccountId: comp.actor,
        eventId: ev.eventId,
        settings: { name: 'Category', ...WEEK, startsAt: '2027-09-02T12:00:00Z' },
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.INVALID_TRANSITION });
    await expect(
      scoring.pinScoring({
        actorAccountId: comp.actor,
        eventId: ev.eventId,
        rulesetVersionId: ids['rs:sets-bo3-tiebreak'] as string,
        idempotencyKey: k(),
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.INVALID_TRANSITION });

    // Another event of the same competition, still open for registration: its window and pin are
    // legitimately editable, and every event's window and pin is a hashed input of the proposal.
    const { eventId: side } = await comps.createEvent({
      actorAccountId: comp.actor,
      competitionId: comp.competitionId,
      slug: uniqueSlug('ev'),
      disciplineVersionId: ids['tennis'] as string,
      formatVersionId: ids['se'] as string,
      formatConfig: { drawSize: 4 },
      settings: { name: 'Doubles', capacity: null, registrationMode: 'AUTO_CONFIRM', ...WEEK },
      idempotencyKey: k(),
    });
    await comps.openRegistration({ actorAccountId: comp.actor, eventId: side });
    await scoring.pinScoring({
      actorAccountId: comp.actor,
      eventId: side,
      rulesetVersionId: ids['rs:sets-bo3-tiebreak'] as string,
      idempotencyKey: k(),
    });
    const sideInput = async () =>
      (await inputsOf(comp, versionId)).events.find((e) => e.eventId === side);

    // A. Window.
    let h = await hashOf(comp, versionId);
    const w0 = await sideInput();
    await comps.updateEventSettings({
      actorAccountId: comp.actor,
      eventId: side,
      settings: {
        name: 'Doubles',
        capacity: null,
        registrationMode: 'AUTO_CONFIRM',
        ...WEEK,
        startsAt: '2027-09-02T12:00:00Z',
      },
    });
    expect((await sideInput())?.windowStart).not.toBe(w0?.windowStart);
    await refusedAsStale(comp, versionId, h);

    // B. Profile pin (none → the tennis profile).
    h = await hashOf(comp, versionId);
    await scoring.pinScoring({
      actorAccountId: comp.actor,
      eventId: side,
      rulesetVersionId: ids['rs:sets-bo3-tiebreak'] as string,
      schedulingProfileVersionId: ids['sp:tennis-court-match'] as string,
      idempotencyKey: k(),
    });
    expect((await sideInput())?.profileVersionId).toBe(ids['sp:tennis-court-match']);
    await refusedAsStale(comp, versionId, h);

    // The side event has no plan: the fresh commit places exactly the locked event's contests.
    const fresh = await commitsAfresh(comp, versionId);
    expect(fresh.placements.map((x) => x.contestId).sort()).toEqual(
      ev.contests.map((c) => c.id).sort(),
    );
  }, 600_000);
});

describe('ONCF-05E-F-4: a scoped SUCCESS proposal commits only its scope (ADR-0075 § 4, § 7)', () => {
  it('event scope: facts, per-fact events and audits only for the scoped event; the other event untouched and still placeable', async () => {
    const comp = await competition();
    const a = await tennis(comp);
    const b = await tennis(comp);
    for (const label of ['Court 1', 'Court 2']) await resource(comp, 'TENNIS_COURT', label);
    await openAllWeek(comp);
    const versionId = await draft(comp);
    const aIds = a.contests.map((c) => c.id).sort();
    const bIds = b.contests.map((c) => c.id).sort();

    const scope = { eventIds: [a.eventId] };
    const { proposal: p } = await preview(comp.actor, versionId, { scope });
    expect(p.status).toBe('SUCCESS');
    expect(p.placements.map((x) => x.contestId).sort()).toEqual(aIds);
    const before = await snapshot(comp.competitionId);
    const bOutboxBefore = await Promise.all(bIds.map((id) => outboxOf(id)));

    const r = await commit(comp.actor, versionId, p.proposalHash, { scope });
    expect(r).toMatchObject({ placedContests: 3, created: true });

    // Facts: exactly the scoped event's three contests, nothing for the other event.
    expect((await facts(versionId)).map((f) => f.contest_id)).toEqual(aIds);
    // Per-fact outbox events and audits only for the committed facts; one commit event and audit.
    const outbox = await outboxOf(versionId);
    expect(
      outbox
        .filter((e) => e.event_type === 'ScheduleAssignmentChanged')
        .map((e) => e.payload.contestId)
        .sort(),
    ).toEqual(aIds);
    const committed = outbox.filter((e) => e.event_type === 'ScheduleProposalCommitted');
    expect(committed).toHaveLength(1);
    expect(committed[0]?.payload).toMatchObject({
      proposalHash: p.proposalHash,
      placedContests: 3,
      assignments: r.assignmentIds,
    });
    expect(await auditOf('schedule.proposal-committed', versionId)).toHaveLength(1);
    for (const id of aIds) expect(await auditOf('schedule.assignment-set', id)).toHaveLength(1);
    for (const id of bIds) expect(await auditOf('schedule.assignment-set', id)).toEqual([]);
    expect(await Promise.all(bIds.map((id) => outboxOf(id)))).toEqual(bOutboxBefore);

    // Everything else of the competition is unchanged: versions, projection, contest / event /
    // competition status, resources, availability, pins, read models.
    const after = await snapshot(comp.competitionId);
    for (const t of Object.keys(before) as (keyof typeof before)[])
      if (!['schedule_assignment', 'audit_event', 'outbox_event'].includes(t))
        expect(after[t], t).toEqual(before[t]);

    // The other event is still unplaced and placeable: the whole-competition proposal now
    // targets exactly its contests.
    const rest = await commitsAfresh(comp, versionId);
    expect(rest.placements.map((x) => x.contestId).sort()).toEqual(bIds);
  }, 600_000);
});
