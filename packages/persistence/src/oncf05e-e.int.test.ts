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
  lastScheduleFact,
} from '@br/testkit';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CatalogStore } from './catalog-store';
import { CompetitionReader } from './competition-reader';
import { CompetitionStore } from './competition-store';
import { refreshEventReadModels } from './competition-projection';
import { inTransaction, ModuleRole } from './tx';
import { StructureStore } from './competition-structure-store';
import { IdentityStore } from './identity-store';
import { OrganizationStore } from './organization-store';
import { ResourceStore } from './resource-store';
import { ScheduleStore } from './schedule-store';
import { ScoringStore } from './scoring-store';
import { TeamStore } from './team-store';

/**
 * ONCF-05E-E proposal PREVIEW through the real stores (ADR-0075 § 16): the pure engine
 * (`proposeSchedule`) over exactly the input `validate` loads, server-side. The preview is strictly
 * observational: its transaction is READ ONLY at the database level, and every scheduling table is
 * byte-identical before and after it. Statuses, refusals, scope, `from`, determinism, and one
 * representative event per sport through the same generic loader (no sport branch anywhere).
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
    code: `e${tag}.${code}`,
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
          code: `e${tag}`,
          name: 'ONCF-05E-E test sport',
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
    if (x.discipline.code.startsWith(`e${tag}.`))
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
    profile: { name: 'ONCF-05E-E Fest', timezone: 'America/Costa_Rica' },
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

const preview = (
  actor: string,
  versionId: string,
  extra: Partial<Parameters<ScheduleStore['previewProposal']>[0]> = {},
) => schedule.previewProposal({ actorAccountId: actor, versionId, ...extra });

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

/**
 * Every authoritative row a preview could touch for one competition, serialized by the database
 * itself (owner connection): schedule versions, status history, assignments, publications, the
 * public projection, resources and revisions, availability, pins, contest and event status, the
 * public contest cards, and audit / outbox entries naming any of them.
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
  };
}

// ───────────────────────────── preview over authoritative state ─────────────────────────────

describe('ONCF-05E-E proposal preview: authoritative input, read-only, statuses', () => {
  it('SUCCESS: a tennis knockout on two exclusive courts — placements, provisional final, identities', async () => {
    const comp = await competition();
    const ev = await tennis(comp);
    const courts = [
      await resource(comp, 'TENNIS_COURT', 'Court 1'),
      await resource(comp, 'TENNIS_COURT', 'Court 2'),
    ].sort();
    await openAllWeek(comp);
    const versionId = await draft(comp);
    const r = await preview(comp.actor, versionId);
    expect(r).toMatchObject({ versionId, competitionId: comp.competitionId });
    const p = r.proposal;
    expect(p).toMatchObject({
      proposalVersion: 1,
      strategy: PROPOSAL_STRATEGY,
      budget: PROPOSAL_BUDGET,
      scope: { eventIds: null, roundIds: null },
      from: null,
      status: 'SUCCESS',
      unplaced: [],
    });
    expect(p.proposalHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(p.baseStateIdentity).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(p.report.reportHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(p.report.hardConflicts).toBe(0);
    expect(r.diagnostics.judgeCalls).toBeGreaterThan(0);

    // Earliest feasible interval, then the resource-id tie-break (ADR-0075 § 10): both semis at the
    // window start on the two courts; the final after the semis' end plus the 900 s lead, provisional.
    const [sf1, sf2, final] = ev.contests as [
      (typeof ev.contests)[0],
      (typeof ev.contests)[0],
      (typeof ev.contests)[0],
    ];
    const at = (id: string) => p.placements.find((x) => x.contestId === id);
    const start = epoch(WEEK.startsAt);
    expect(p.placements).toHaveLength(3);
    expect([at(sf1.id)?.start, at(sf2.id)?.start]).toEqual([start, start]);
    expect(new Set([at(sf1.id)?.resourceId, at(sf2.id)?.resourceId])).toEqual(new Set(courts));
    expect(at(final.id)).toMatchObject({
      start: start + 5_400 + 900,
      expectedEnd: start + 5_400 + 900 + 5_400,
      resourceId: courts[0],
      changeoverSeconds: 600,
      provisional: true,
      zone: 'America/Costa_Rica',
      unitKey: `contest:${final.id}`,
    });
    // The SOFT rest of the tennis profile is reported on the final, never used to choose.
    expect(at(final.id)?.softConflictKeys.length).toBeGreaterThan(0);
    expect(p.metrics).toMatchObject({ placedUnits: 3, placedContests: 3, unplacedUnits: 0 });

    // The preview never wrote: the draft is still empty.
    const v = await schedule.getVersion({ actorAccountId: comp.actor, versionId });
    expect(v.assignments).toEqual([]);

    // Scope narrows the targets only; it is part of the base identity.
    const scoped = await preview(comp.actor, versionId, { scope: { roundIds: [sf1.roundId] } });
    expect(scoped.proposal.placements.map((x) => x.contestId).sort()).toEqual(
      [sf1.id, sf2.id].sort(),
    );
    expect(scoped.proposal.scope).toEqual({ eventIds: null, roundIds: [sf1.roundId] });
    expect(scoped.proposal.baseStateIdentity).not.toBe(p.baseStateIdentity);
    const byEvent = await preview(comp.actor, versionId, { scope: { eventIds: [ev.eventId] } });
    expect(byEvent.proposal.placements).toEqual(p.placements);
    expect(byEvent.proposal.baseStateIdentity).not.toBe(p.baseStateIdentity);

    // `from` (whole seconds) is the earliest start considered; it never defaults to the clock.
    const from = '2027-09-02T09:00:00Z';
    const later = await preview(comp.actor, versionId, { from });
    expect(later.proposal.from).toBe(epoch(from));
    expect(Math.min(...later.proposal.placements.map((x) => x.start))).toBe(epoch(from));
    await rejects(
      preview(comp.actor, versionId, { from: '2027-09-02T09:00:00.500Z' }),
      DomainErrorCode.INVALID_INPUT,
    );
    await rejects(
      preview(comp.actor, versionId, { from: 'tomorrow' }),
      DomainErrorCode.INVALID_INPUT,
    );
  }, 300_000);

  it('read-only at the database level: every scheduling row is identical, and a write is refused', async () => {
    const comp = await competition();
    const ev = await tennis(comp);
    const court = await resource(comp, 'TENNIS_COURT', 'Court 1');
    await openAllWeek(comp);
    const versionId = await draft(comp);
    // Preserved content of every kind the judge reads: a locked manual assignment.
    await schedule.setAssignment({
      actorAccountId: comp.actor,
      versionId,
      contestId: ev.contests[0]?.id as string,
      assignment: { resourceId: court, startsAt: '2027-09-03T12:00:00Z' },
      expectedLastFactId: await lastScheduleFact(db, ev.contests[0]?.id as string, versionId),
      idempotencyKey: k(),
    });
    await schedule.setLock({
      actorAccountId: comp.actor,
      versionId,
      contestId: ev.contests[0]?.id as string,
      locked: true,
      reason: null,
      expectedLastFactId: await lastScheduleFact(db, ev.contests[0]?.id as string, versionId),
      idempotencyKey: k(),
    });
    const before = await snapshot(comp.competitionId);
    expect(JSON.parse(before.schedule_assignment)).toHaveLength(2); // the fact and its lock
    const r = await preview(comp.actor, versionId);
    expect(r.proposal.status).toBe('SUCCESS');
    // The locked assignment is fixed: never moved, never re-proposed.
    expect(r.proposal.placements.map((x) => x.contestId)).not.toContain(ev.contests[0]?.id);
    expect(await snapshot(comp.competitionId)).toEqual(before);

    // Query level: inside the preview transaction PostgreSQL itself refuses any write.
    const store = new ScheduleStore(db);
    const probe = store as unknown as { evaluationInput: (ctx: { trx: unknown }) => unknown };
    probe.evaluationInput = async (ctx) => {
      await sql`DELETE FROM competition.schedule_assignment WHERE false`.execute(
        ctx.trx as Parameters<ReturnType<typeof sql>['execute']>[0],
      );
      throw new Error('unreachable: the write was accepted');
    };
    await expect(store.previewProposal({ actorAccountId: comp.actor, versionId })).rejects.toThrow(
      /read-only transaction/,
    );
    expect(await snapshot(comp.competitionId)).toEqual(before);
  }, 300_000);

  it('determinism: the same state and request twice give the identical response; other tenants change nothing', async () => {
    const comp = await competition();
    await tennis(comp);
    await resource(comp, 'TENNIS_COURT', 'Court 1');
    await resource(comp, 'TENNIS_COURT', 'Court 2');
    await openAllWeek(comp);
    const versionId = await draft(comp);
    const first = await preview(comp.actor, versionId);
    expect(await preview(comp.actor, versionId)).toEqual(first);

    // Unrelated rows interleaved into the same tables by another competition: drafts,
    // resources, availability and assignments with ids before and after this competition's.
    const other = await competition();
    const otherEv = await tennis(other);
    const otherCourt = await resource(other, 'TENNIS_COURT', 'Elsewhere');
    await openAllWeek(other);
    const otherDraft = await draft(other);
    await schedule.setAssignment({
      actorAccountId: other.actor,
      versionId: otherDraft,
      contestId: otherEv.contests[0]?.id as string,
      assignment: { resourceId: otherCourt, startsAt: WEEK.startsAt },
      expectedLastFactId: await lastScheduleFact(db, otherEv.contests[0]?.id as string, otherDraft),
      idempotencyKey: k(),
    });
    const again = await preview(comp.actor, versionId);
    expect(again).toEqual(first);
    expect(again.proposal.proposalHash).toBe(first.proposal.proposalHash);
    expect(again.proposal.baseStateIdentity).toBe(first.proposal.baseStateIdentity);

    // Any authoritative change does change the base identity (a new court revision here).
    await resource(comp, 'TENNIS_COURT', 'Court 3');
    const changed = await preview(comp.actor, versionId);
    expect(changed.proposal.baseStateIdentity).not.toBe(first.proposal.baseStateIdentity);
  }, 300_000);

  it('NOTHING_TO_PLACE once every contest has a draft assignment', async () => {
    const comp = await competition();
    const ev = await tennis(comp);
    const court = await resource(comp, 'TENNIS_COURT', 'Court 1');
    await openAllWeek(comp);
    const versionId = await draft(comp);
    for (const [i, c] of ev.contests.entries())
      await schedule.setAssignment({
        actorAccountId: comp.actor,
        versionId,
        contestId: c.id,
        assignment: { resourceId: court, startsAt: `2027-09-0${2 + i}T12:00:00Z` },
        expectedLastFactId: await lastScheduleFact(db, c.id, versionId),
        idempotencyKey: k(),
      });
    const r = await preview(comp.actor, versionId);
    expect(r.proposal).toMatchObject({ status: 'NOTHING_TO_PLACE', placements: [], unplaced: [] });
  }, 300_000);

  it('NO_CANDIDATES: no ACTIVE resource of the required type', async () => {
    const comp = await competition();
    // One contest: a dependent of an unplaced unit is FEEDER_UNPLACED (ADR-0075 § 8), not an empty
    // domain, so a knockout without courts is INFEASIBLE rather than NO_CANDIDATES.
    await plannedEvent(comp, {
      discipline: 'tennis',
      format: 'se',
      ruleset: 'sets-bo3-tiebreak',
      profile: 'tennis-court-match',
      formatConfig: { drawSize: 2 },
      entrants: 2,
    });
    await resource(comp, 'PADEL_COURT', 'Padel 1');
    await openAllWeek(comp);
    const r = await preview(comp.actor, await draft(comp));
    expect(r.proposal.status).toBe('NO_CANDIDATES');
    expect(r.proposal.placements).toEqual([]);
    expect(r.proposal.unplaced.map((u) => u.reason)).toEqual(['NO_COMPATIBLE_RESOURCE']);
    expect(r.diagnostics.judgeCalls).toBe(0);
  }, 300_000);

  it('INFEASIBLE: one court and a window that fits one match — blocking conflicts, dependents FEEDER_UNPLACED', async () => {
    const comp = await competition();
    const ev = await tennis(comp, {
      window: { startsAt: '2027-09-01T12:00:00Z', endsAt: '2027-09-01T14:00:00Z' },
    });
    await resource(comp, 'TENNIS_COURT', 'Court 1');
    await openAllWeek(comp);
    const r = await preview(comp.actor, await draft(comp));
    const p = r.proposal;
    expect(p.status).toBe('INFEASIBLE');
    expect(p.placements).toHaveLength(1);
    const reasons = Object.fromEntries(p.unplaced.map((u) => [u.contestIds[0], u]));
    const unplacedSemi = ev.contests.slice(0, 2).find((c) => reasons[c.id] !== undefined);
    expect(reasons[unplacedSemi?.id as string]?.reason).toBe('NO_FEASIBLE_CANDIDATE');
    expect(reasons[unplacedSemi?.id as string]?.blockingConflictKeys.length).toBeGreaterThan(0);
    expect(reasons[ev.contests[2]?.id as string]?.reason).toBe('FEEDER_UNPLACED');
  }, 300_000);

  it('SEARCH_EXHAUSTED: a unit whose domain exceeds the per-unit budget is never INFEASIBLE', async () => {
    const comp = await competition();
    const MONTH = { startsAt: '2027-09-01T00:00:00Z', endsAt: '2027-09-29T00:00:00Z' };
    // Twenty courts, each held for the whole horizon by a long manual assignment of another event:
    // every (instant, court) candidate passes the declared-time domain and is rejected by the judge
    // (resource-scoped), so the target unit spends its whole per-unit budget.
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
    const r = await preview(comp.actor, versionId, { scope: { eventIds: [target.eventId] } });
    expect(r.proposal.status).toBe('SEARCH_EXHAUSTED');
    expect(r.proposal.placements).toEqual([]);
    expect(r.proposal.unplaced.map((u) => u.reason)).toEqual(['BUDGET_EXHAUSTED']);
    expect(r.diagnostics.judgeCalls).toBe(PROPOSAL_BUDGET.maxEvaluationsPerUnit);
  }, 600_000);

  it('NO_PROFILE and EVENT_NOT_SCHEDULABLE are reported per unit, never INFEASIBLE', async () => {
    const comp = await competition();
    const unpinned = await tennis(comp, { profile: null });
    const done = await tennis(comp);
    await resource(comp, 'TENNIS_COURT', 'Court 1');
    await openAllWeek(comp);
    await comps.startEvent({ actorAccountId: comp.actor, eventId: done.eventId });
    // ONCF-L6 (ADR-0078 §2.1): completing a category with PLANNED matches is now refused, so the
    // finished category with unplayed matches this case needs is grandfathered pre-L6 data,
    // written directly as such (ADR-0078 §2.8).
    await expect(
      comps.completeEvent({ actorAccountId: comp.actor, eventId: done.eventId }),
    ).rejects.toMatchObject({
      code: DomainErrorCode.INVALID_TRANSITION,
      details: { reason: 'CONTESTS_OPEN' },
    });
    await inTransaction(db, ModuleRole.competition, async (ctx) => {
      await sql`INSERT INTO competition.event_status_change (id, event_id, status, actor_account_id, recorded_at)
        VALUES (${newId()}, ${done.eventId}, 'COMPLETED', ${comp.actor}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await refreshEventReadModels(ctx, done.eventId);
    });
    const r = await preview(comp.actor, await draft(comp));
    expect(r.proposal.status).toBe('NOTHING_TO_PLACE');
    expect(r.proposal.placements).toEqual([]);
    const reasonOf = new Map(r.proposal.unplaced.map((u) => [u.contestIds[0], u.reason]));
    for (const c of unpinned.contests) expect(reasonOf.get(c.id)).toBe('NO_PROFILE');
    for (const c of done.contests) expect(reasonOf.get(c.id)).toBe('EVENT_NOT_SCHEDULABLE');
  }, 300_000);

  it('refusals and authorization: not the open draft, foreign scope, unknown version, non-schedulers', async () => {
    const comp = await competition();
    const ev = await tennis(comp);
    await resource(comp, 'TENNIS_COURT', 'Court 1');
    await openAllWeek(comp);
    const versionId = await draft(comp);
    const other = await competition();
    const otherEv = await tennis(other);

    // Scope ids of another competition (or none at all) are refused with one fixed message.
    for (const scope of [
      { eventIds: [otherEv.eventId] },
      { roundIds: [otherEv.contests[0]?.roundId as string] },
      { roundIds: [ev.contests[0]?.id as string] }, // a contest id is not a round
      { eventIds: [newId()] },
    ])
      await rejects(
        preview(comp.actor, versionId, { scope }),
        DomainErrorCode.INVALID_INPUT,
        'FOREIGN_SCOPE',
      );

    // Who may preview: COMP_MANAGE_SCHEDULE (OWNER, ADMIN, SCHEDULER), decided server-side.
    const staff = async (role: 'SCHEDULER' | 'REGISTRATION_MANAGER') => {
      const a = await newTestAccount(identity);
      await comps.assignStaff({
        actorAccountId: comp.actor,
        competitionId: comp.competitionId,
        personId: a.personId as string,
        role,
        idempotencyKey: k(),
      });
      return a.accountId;
    };
    expect((await preview(await staff('SCHEDULER'), versionId)).proposal.status).toBe('SUCCESS');
    await rejects(
      preview(await staff('REGISTRATION_MANAGER'), versionId),
      DomainErrorCode.FORBIDDEN,
    );
    await rejects(preview(other.actor, versionId), DomainErrorCode.FORBIDDEN);
    await rejects(
      preview((await newTestAccount(identity)).accountId, versionId),
      DomainErrorCode.FORBIDDEN,
    );
    await rejects(preview(comp.actor, newId()), DomainErrorCode.NOT_FOUND);

    // A version that is no longer the open draft: INCOMPLETE_STATE, no proposal, nothing created.
    await schedule.discard({
      actorAccountId: comp.actor,
      versionId,
      reason: 'restart',
      idempotencyKey: k(),
    });
    const before = await snapshot(comp.competitionId);
    await rejects(
      preview(comp.actor, versionId),
      DomainErrorCode.INVALID_TRANSITION,
      'INCOMPLETE_STATE',
    );
    expect(await snapshot(comp.competitionId)).toEqual(before);
  }, 300_000);
});

// ───────────────────────────── one generic loader for every sport ─────────────────────────────

interface SportCase extends EventSpec {
  readonly sport: string;
  readonly resources: readonly [typeCode: string, extra: Record<string, unknown>][];
  /** The resource shape this case proves (asserted from data, never from the sport name). */
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

describe('cross-sport preview: the same loader and engine for every sport (ADR-0075 § 21)', () => {
  it('the preview path names no sport, discipline or resource type', () => {
    const source = readFileSync(new URL('./schedule-store.ts', import.meta.url), 'utf8');
    const preview = source.slice(
      source.indexOf('private async evaluationInput('),
      source.indexOf('// ───────────────────────────── drafts'),
    );
    expect(preview).toContain('async previewProposal(');
    expect(preview).not.toMatch(
      /\b(tennis|padel|running|marathon|swim\w*|cycling|bowling|basketball|golf)\b/i,
    );
    expect(preview).not.toMatch(/sport|discipline|_COURT|_LANE|COURSE|POOL/);
  });

  it.each(SPORTS)(
    '$sport: every planned contest placed on a resource of the pinned type, zero HARD conflicts',
    async (c) => {
      const comp = await competition();
      const ev = await plannedEvent(comp, c);
      const own = [];
      for (const [i, [typeCode, extra]] of c.resources.entries())
        own.push(await resource(comp, typeCode, `${c.sport} ${i + 1}`, extra));
      await openAllWeek(comp);
      const versionId = await draft(comp);
      const before = await snapshot(comp.competitionId);
      const { proposal: p } = await preview(comp.actor, versionId);
      expect(await snapshot(comp.competitionId)).toEqual(before);
      expect(p.unplaced, JSON.stringify(p.unplaced)).toEqual([]);
      expect(p.status).toBe('SUCCESS');
      expect(p.report.hardConflicts).toBe(0);
      expect(p.placements.map((x) => x.contestId).sort()).toEqual(
        ev.contests.map((x) => x.id).sort(),
      );
      for (const x of p.placements) expect(own).toContain(x.resourceId);
      for (const x of p.placements) expect(x.start).toBeGreaterThanOrEqual(epoch(WEEK.startsAt));
      expect(new Set(p.placements.map((x) => x.zone))).toEqual(new Set(['America/Costa_Rica']));
      // Same state, same proposal.
      expect((await preview(comp.actor, versionId)).proposal).toEqual(p);

      const units = new Map<string, typeof p.placements>();
      for (const x of p.placements) units.set(x.unitKey, [...(units.get(x.unitKey) ?? []), x]);
      if (c.shape === 'GROUPED_EXCLUSIVE') {
        // A grouped unit (the squad) over two EXCLUSIVE lane pairs: one start, members packed
        // four per pair by B2 consumption.
        const squad = [...units.values()].find((u) => u.length === 8);
        expect(squad).toBeDefined();
        expect(new Set(squad?.map((x) => x.start)).size).toBe(1);
        expect(new Set(squad?.map((x) => x.resourceId))).toEqual(new Set(own));
      }
      if (c.shape === 'GROUPED_SHARED') {
        // Grouped units (tee groups) on one SHARED resource.
        const groups = [...units.values()].filter((u) => u.length > 1);
        expect(groups.length).toBeGreaterThan(0);
        for (const g of groups) expect(new Set(g.map((x) => x.start)).size).toBe(1);
      }
      if (c.shape === 'EXCLUSIVE_PAIR') {
        // EXCLUSIVE resources: the two first-round contests share a start on two resources.
        const first = p.placements.filter((x) => x.start === epoch(WEEK.startsAt));
        expect(new Set(first.map((x) => x.resourceId)).size).toBe(2);
      }
    },
    600_000,
  );
});
