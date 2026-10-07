import {
  BASKETBALL_3X3_V2,
  GOLF_INDIVIDUAL_V2,
  PADEL_DOUBLES_V1,
  RUNNING_ROAD_V2,
  SWIMMING_POOL_V2,
  TENNIS_SINGLES_V1,
  CANONICAL_CATALOG,
  type CatalogManifest,
  type DisciplineVersionSpec,
} from '@br/competition';
import { DomainErrorCode, newId } from '@br/domain';
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
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CatalogStore } from './catalog-store';
import {
  rebuildCompetitionReadModels,
  snapshotCompetitionReadModels,
} from './competition-projection';
import { CompetitionReader } from './competition-reader';
import { CompetitionStore } from './competition-store';
import { StructureStore } from './competition-structure-store';
import { IdentityStore } from './identity-store';
import { OrganizationStore } from './organization-store';
import { TeamStore } from './team-store';

/**
 * ONCF-05B proof cases A–F (ONCF-05A §34) through the real stores: field lock (roster and entry
 * attribute snapshots), seeding v2, stage-graph plans and the public structure read. Results,
 * advancement and scheduling are later slices; nothing here resolves a dependency.
 */

const api = apiDb();
const owner = ownerDb();
const maintenance = maintenanceDb();
const operator = operatorDb();
afterAll(async () => {
  await Promise.all([api, owner, maintenance, operator].map((d) => d.destroy()));
});
const identity = new IdentityStore(api);
const orgs = new OrganizationStore(api);
const catalog = new CatalogStore(operator);
const comps = new CompetitionStore(api);
const structure = new StructureStore(api);
const teams = new TeamStore(api);
const reader = new CompetitionReader(api);
const k = () => `k-${newId()}`;
const count = async (q: string) =>
  Number(((await sql.raw(q).execute(owner)).rows[0] as { n: number | string }).n);

const racketV2 = (code: string) =>
  CANONICAL_CATALOG.sports.flatMap((s) => s.disciplines).find((d) => d.code === code)
    ?.specs[1] as DisciplineVersionSpec;

const tag = newId().replace(/-/g, '').slice(-8);
const ids: Record<string, string> = {};

beforeAll(async () => {
  const op = (await newTestAccount(identity, { withPerson: false, label: 'operator' })).accountId;
  const d = (code: string, specs: DisciplineVersionSpec[]) => ({
    code: `x${tag}.${code}`,
    name: code,
    specs,
  });
  const manifest: CatalogManifest = {
    sports: [
      {
        code: `x${tag}`,
        name: 'ONCF-05B test sport',
        disciplines: [
          d('tennis', [TENNIS_SINGLES_V1, racketV2('tennis.singles')]),
          d('padel', [PADEL_DOUBLES_V1, racketV2('padel.doubles')]),
          d('road', [RUNNING_ROAD_V2]),
          d('pool', [SWIMMING_POOL_V2]),
          d('golf', [GOLF_INDIVIDUAL_V2]),
          d('3x3', [BASKETBALL_3X3_V2]),
        ],
      },
    ],
    formats: [
      {
        code: `se-${tag}`,
        name: 'SE',
        versions: [
          { engineId: 'single-elimination', engineVersion: 1 },
          { engineId: 'single-elimination', engineVersion: 2 },
        ],
      },
      {
        code: `gk-${tag}`,
        name: 'Groups KO',
        versions: [{ engineId: 'groups-knockout', engineVersion: 1 }],
      },
      {
        code: `wave-${tag}`,
        name: 'Waves',
        versions: [{ engineId: 'wave-start', engineVersion: 1 }],
      },
      {
        code: `heats-${tag}`,
        name: 'Heats',
        versions: [{ engineId: 'heats-final', engineVersion: 1 }],
      },
      {
        code: `mr-${tag}`,
        name: 'Multi-round',
        versions: [{ engineId: 'multi-round', engineVersion: 1 }],
      },
    ],
  };
  const report = await catalog.provision({ operatorAccountId: op, manifest });
  expect(report.conflicts).toEqual([]);
  const listed = await reader.catalog();
  for (const dv of listed.disciplineVersions)
    if (dv.discipline.code.startsWith(`x${tag}.`))
      ids[`${dv.discipline.code.split('.')[1]}@${dv.version}`] = dv.disciplineVersionId;
  for (const fv of listed.formatVersions)
    if (fv.format.code.endsWith(`-${tag}`))
      ids[`${fv.format.code.split('-')[0]}@${fv.version}`] = fv.formatVersionId;
}, 120_000);

async function eventWith(dv: string, fv: string, formatConfig: Record<string, unknown> = {}) {
  const org = await newOrganizer(identity, orgs);
  const { competitionId } = await comps.createCompetition({
    actorAccountId: org.ownerAccountId,
    organizerOrganizationId: org.organizationId,
    slug: uniqueSlug('comp'),
    profile: { name: 'ONCF-05B Fest', timezone: 'America/Costa_Rica' },
    idempotencyKey: k(),
  });
  await comps.publishCompetition({ actorAccountId: org.ownerAccountId, competitionId });
  await comps.activateCompetition({ actorAccountId: org.ownerAccountId, competitionId });
  const slug = uniqueSlug('ev');
  const { eventId } = await comps.createEvent({
    actorAccountId: org.ownerAccountId,
    competitionId,
    slug,
    disciplineVersionId: ids[dv] as string,
    formatVersionId: ids[fv] as string,
    formatConfig,
    settings: { name: 'Category', capacity: null, registrationMode: 'AUTO_CONFIRM' },
    idempotencyKey: k(),
  });
  await comps.openRegistration({ actorAccountId: org.ownerAccountId, eventId });
  const competitionSlug = (
    await sql<{
      slug: string;
    }>`SELECT slug FROM competition.competition_slug WHERE competition_id = ${competitionId}`.execute(
      owner,
    )
  ).rows[0]?.slug as string;
  return { org, eventId, slug, competitionSlug, actor: org.ownerAccountId };
}

async function individuals(eventId: string, n: number) {
  const out: { athleteId: string; accountId: string; registrationId: string }[] = [];
  for (let i = 0; i < n; i++) {
    const a = await newAthlete(identity, `r${i}`, `Racer ${i}`);
    const { registrationId } = await comps.register({
      actorAccountId: a.accountId,
      eventId,
      athleteId: a.athleteId,
      eligibilityDeclared: true,
      idempotencyKey: k(),
    });
    out.push({ athleteId: a.athleteId, accountId: a.accountId, registrationId });
  }
  return out;
}

/** A team managed by its first member's account; the others accept their memberships. */
async function teamOf(size: number, kind: 'EVENT_PAIR' | 'EVENT_SQUAD') {
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
  return { teamId, manager, members };
}

async function lockAndSeed(
  ev: { eventId: string; actor: string },
  seeding: Parameters<StructureStore['seedField']>[0] extends infer T
    ? Omit<T & object, 'actorAccountId' | 'eventId' | 'idempotencyKey'>
    : never,
) {
  await comps.closeRegistration({ actorAccountId: ev.actor, eventId: ev.eventId });
  const field = await structure.lockField({
    actorAccountId: ev.actor,
    eventId: ev.eventId,
    idempotencyKey: k(),
  });
  const seeded = await structure.seedField({
    actorAccountId: ev.actor,
    eventId: ev.eventId,
    idempotencyKey: k(),
    ...seeding,
  });
  const plan = await structure.generatePlan({
    actorAccountId: ev.actor,
    eventId: ev.eventId,
    idempotencyKey: k(),
  });
  return { field, seeded, plan };
}

describe('proof case A — tennis singles, single elimination v2 (KNOCKOUT)', () => {
  it('a 24-entrant ITF-style draw: 8 banded seeds, byes to the top seeds, a stage-graph plan', async () => {
    const ev = await eventWith('tennis@2', 'se@2', { drawSize: 32 });
    const players = await individuals(ev.eventId, 24);
    const pid = async (athleteId: string) =>
      (
        await sql<{
          id: string;
        }>`SELECT id FROM competition.participant WHERE event_id = ${ev.eventId} AND athlete_id = ${athleteId}`.execute(
          owner,
        )
      ).rows[0]?.id as string;
    await comps.closeRegistration({ actorAccountId: ev.actor, eventId: ev.eventId });
    const field = await structure.lockField({
      actorAccountId: ev.actor,
      eventId: ev.eventId,
      idempotencyKey: k(),
    });
    const seeds = await Promise.all(players.slice(0, 8).map((p) => pid(p.athleteId)));
    const seeded = await structure.seedField({
      actorAccountId: ev.actor,
      eventId: ev.eventId,
      method: 'RANKED_THEN_DRAWN',
      seeds,
      source: { kind: 'DECLARED_EXTERNAL', label: 'Club ranking', asOf: '2026-10-01' },
      idempotencyKey: k(),
    });
    expect(seeded.seedingVersion).toBe(2);
    expect(seeded.seedOrder.slice(0, 2)).toEqual(seeds.slice(0, 2));
    const plan = await structure.generatePlan({
      actorAccountId: ev.actor,
      eventId: ev.eventId,
      idempotencyKey: k(),
    });
    expect(plan.engine).toBe('single-elimination/2');
    expect(plan.contests).toBe(23);
    expect(field.fieldHash).toMatch(/^sha256:/);
    expect(
      await count(`SELECT count(*) AS n FROM competition.stage WHERE event_id = '${ev.eventId}'`),
    ).toBe(1);
    expect(
      await count(
        `SELECT plan_version AS n FROM competition.event_plan WHERE event_id = '${ev.eventId}'`,
      ),
    ).toBe(2);
    // No top-8 seed plays in round 1 (byes are structural, never contests).
    const r1 =
      await count(`SELECT count(*) AS n FROM competition.contestant ct JOIN competition.contest c ON c.id = ct.contest_id
      JOIN competition.round r ON r.id = c.round_id WHERE r.event_id = '${ev.eventId}' AND r.sequence = 1
      AND ct.participant_id = ANY(ARRAY[${seeds.map((s) => `'${s}'`).join(',')}]::uuid[])`);
    expect(r1).toBe(0);
    const structureRead = await reader.structure(ev.competitionSlug, ev.slug);
    expect(structureRead?.[0]?.stage).toMatchObject({
      key: 's1',
      primitive: 'KNOCKOUT',
      partitionKind: null,
    });
    // Repeating returns the stored plan; nothing is regenerated.
    const again = await structure.generatePlan({
      actorAccountId: ev.actor,
      eventId: ev.eventId,
      idempotencyKey: k(),
    });
    expect(again).toMatchObject({ planHash: plan.planHash, created: false });
  });

  it('a v1 discipline on a v1 engine keeps the exact BRT-05 documents', async () => {
    const ev = await eventWith('tennis@1', 'se@1');
    await individuals(ev.eventId, 4);
    await lockAndSeed(ev, { method: 'DETERMINISTIC_DRAW' });
    const v = await sql<{ f: number; s: number; p: number }>`
      SELECT f.field_version AS f, s.seeding_version AS s, p.plan_version AS p FROM competition.event_field f
      JOIN competition.event_seeding s USING (event_id) JOIN competition.event_plan p USING (event_id) WHERE f.event_id = ${ev.eventId}`.execute(
      owner,
    );
    expect(v.rows[0]).toEqual({ f: 1, s: 1, p: 1 });
  });
});

describe('proof case B — padel doubles, groups → knockout (ROUND_ROBIN + pair entrant)', () => {
  it('pairs enter as teams, rosters are frozen, groups are competitive and the knockout depends on group ranks', async () => {
    const ev = await eventWith('padel@2', 'gk@1', { groupCount: 2, qualifiersPerGroup: 2 });
    for (let i = 0; i < 8; i++) {
      const t = await teamOf(2, 'EVENT_PAIR');
      await comps.register({
        actorAccountId: t.manager.accountId,
        eventId: ev.eventId,
        teamId: t.teamId,
        eligibilityDeclared: true,
        idempotencyKey: k(),
      });
    }
    const { plan } = await lockAndSeed(ev, { method: 'DETERMINISTIC_DRAW' });
    expect(plan.engine).toBe('groups-knockout/1');
    expect(plan.contests).toBe(12 + 3); // 2 groups × C(4,2) + semis + final
    expect(
      await count(
        `SELECT count(*) AS n FROM competition.participant_roster_member m JOIN competition.participant p ON p.id = m.participant_id WHERE p.event_id = '${ev.eventId}'`,
      ),
    ).toBe(16);
    expect(
      await count(
        `SELECT count(*) AS n FROM competition.stage_transition WHERE event_id = '${ev.eventId}' AND kind = 'RANK_FROM_GROUP'`,
      ),
    ).toBe(1);
    expect(
      await count(`SELECT count(*) AS n FROM competition.contestant ct JOIN competition.contest c ON c.id = ct.contest_id
      WHERE c.event_id = '${ev.eventId}' AND ct.source_kind = 'RANK_FROM_STAGE' AND ct.source_stage_id IS NOT NULL AND ct.source_group_key IS NOT NULL`),
    ).toBe(4);
    const rounds = await reader.structure(ev.competitionSlug, ev.slug);
    expect(rounds?.find((r) => r.groupKey === 'g2')?.stage?.partitionKind).toBe('COMPETITIVE');
    const semi = rounds?.find((r) => r.stage?.primitive === 'KNOCKOUT')?.contests[0];
    expect(semi?.slots[0]).toMatchObject({
      kind: 'RANK_FROM_STAGE',
      stageKey: 's1',
      resolved: false,
    });
  });
});

describe('proof case C — running road race, wave start (FIELD + logistic partitions + scale)', () => {
  it('150 runners in 3 logistic waves: entries beyond the 64-slot ceiling, attributes frozen at lock', async () => {
    const ev = await eventWith('road@1', 'wave@1', { waveCapacity: 60 });
    const runners = await individuals(ev.eventId, 150);
    for (const [i, r] of runners.slice(0, 5).entries())
      await structure.declareEntryAttributes({
        actorAccountId: r.accountId,
        registrationId: r.registrationId,
        attributes: [
          { key: 'bib', value: `${1000 + i}` },
          { key: 'predictedTimeMs', value: `${3_000_000 + i}` },
        ],
        idempotencyKey: k(),
      });
    await expect(
      structure.declareEntryAttributes({
        actorAccountId: runners[5]?.accountId as string,
        registrationId: runners[5]?.registrationId as string,
        attributes: [{ key: 'entryTimeMs', value: '1' }],
        idempotencyKey: k(),
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.INVALID_INPUT });
    const { plan } = await lockAndSeed(ev, {
      method: 'BY_ENTRY_ATTRIBUTE',
      attributeKey: 'predictedTimeMs',
      direction: 'ASC',
    });
    expect(plan.contests).toBe(3);
    expect(
      await count(
        `SELECT count(*) AS n FROM competition.contest_entry ce JOIN competition.contest c ON c.id = ce.contest_id WHERE c.event_id = '${ev.eventId}'`,
      ),
    ).toBe(150);
    expect(
      await count(
        `SELECT count(*) AS n FROM competition.participant_entry_attribute a JOIN competition.participant p ON p.id = a.participant_id WHERE p.event_id = '${ev.eventId}'`,
      ),
    ).toBe(10);
    const round = (await reader.structure(ev.competitionSlug, ev.slug))?.[0];
    expect(round?.stage).toMatchObject({ primitive: 'FIELD', partitionKind: 'LOGISTIC' });
    expect(round?.contests.map((c) => [c.partitionKey, c.entryCount])).toEqual([
      ['w1', 60],
      ['w2', 60],
      ['w3', 30],
    ]);
    // Declared predicted times seed the first wave; the rest are drawn after them.
    const firstWave = round?.contests[0]?.entries.slice(0, 5).map((e) => e.participantId);
    expect(firstWave).toHaveLength(5);
    // Frozen once the field is locked.
    await expect(
      structure.declareEntryAttributes({
        actorAccountId: runners[0]?.accountId as string,
        registrationId: runners[0]?.registrationId as string,
        attributes: [{ key: 'bib', value: '7' }],
        idempotencyKey: k(),
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.INVALID_TRANSITION });
  }, 120_000);
});

describe('proof case D — swimming individual, heats → final (HEATS + entry-time seeding)', () => {
  it('seeds heats by declared entry time, centre lanes for the fastest, and a final of qualifiers', async () => {
    const ev = await eventWith('pool@1', 'heats@1', { qualifyByTime: 8 });
    const swimmers = await individuals(ev.eventId, 20);
    for (const [i, s] of swimmers.entries())
      await structure.declareEntryAttributes({
        actorAccountId: s.accountId,
        registrationId: s.registrationId,
        attributes: [{ key: 'entryTimeMs', value: `${60_000 + i * 100}` }],
        idempotencyKey: k(),
      });
    const { seeded, plan } = await lockAndSeed(ev, {
      method: 'BY_ENTRY_ATTRIBUTE',
      attributeKey: 'entryTimeMs',
      direction: 'ASC',
    });
    expect(plan.contests).toBe(3 + 1);
    const fastest = seeded.seedOrder[0] as string;
    const lane = await sql<{ slot: number; seq: number }>`
      SELECT ct.slot, c.sequence AS seq FROM competition.contestant ct JOIN competition.contest c ON c.id = ct.contest_id
      WHERE c.event_id = ${ev.eventId} AND ct.participant_id = ${fastest}`.execute(owner);
    expect(lane.rows[0]?.slot).toBe(4);
    const final = (await reader.structure(ev.competitionSlug, ev.slug))?.find(
      (r) => r.roundType === 'FINAL',
    );
    expect(final?.contests[0]?.slots).toHaveLength(8);
    expect(final?.contests[0]?.slots.every((s) => s.kind === 'QUALIFIER')).toBe(true);
  }, 120_000);
});

describe('proof case E — golf stroke play, multi-round + cut (cumulative classification)', () => {
  it('rounds 1–2 per entrant in tee groups; rounds 3–4 wait for the cut', async () => {
    const ev = await eventWith('golf@1', 'mr@1', {
      rounds: 4,
      cutAfterRound: 2,
      cutTopN: 6,
      groupSize: 3,
    });
    const golfers = await individuals(ev.eventId, 12);
    await structure.declareEntryAttributes({
      actorAccountId: golfers[0]?.accountId as string,
      registrationId: golfers[0]?.registrationId as string,
      attributes: [{ key: 'handicapIndex', value: '12.4' }],
      idempotencyKey: k(),
    });
    const { plan } = await lockAndSeed(ev, { method: 'DETERMINISTIC_DRAW' });
    expect(plan.contests).toBe(24);
    const rounds = await reader.structure(ev.competitionSlug, ev.slug);
    expect(rounds?.map((r) => r.dynamicEntry?.transitionKey ?? null)).toEqual([
      null,
      null,
      't1',
      't1',
    ]);
    expect(new Set(rounds?.[0]?.contests.map((c) => c.partitionKey))).toEqual(
      new Set(['t1', 't2', 't3', 't4']),
    );
    expect(
      await count(
        `SELECT count(*) AS n FROM competition.stage_transition WHERE event_id = '${ev.eventId}' AND kind = 'CUT' AND after_round_plan_key = 's1-r2'`,
      ),
    ).toBe(1);
  }, 120_000);
});

describe('proof case F — basketball 3x3, pools → knockout (roster / lineup)', () => {
  it('freezes rosters at lock; lineups validate against the frozen roster, not later memberships', async () => {
    const ev = await eventWith('3x3@1', 'gk@1', { groupCount: 2, qualifiersPerGroup: 2 });
    const entrants = [];
    for (let i = 0; i < 6; i++) {
      const t = await teamOf(i === 0 ? 3 : 4, 'EVENT_SQUAD');
      await comps.register({
        actorAccountId: t.manager.accountId,
        eventId: ev.eventId,
        teamId: t.teamId,
        eligibilityDeclared: true,
        idempotencyKey: k(),
      });
      entrants.push(t);
    }
    await lockAndSeed(ev, { method: 'DETERMINISTIC_DRAW' });
    const team = entrants[0] as (typeof entrants)[number];
    // A member added after the lock is not on the frozen roster.
    const late = await newAthlete(identity, 'late', 'Late Signing');
    const { membershipId } = await teams.addMember({
      actorAccountId: team.manager.accountId,
      teamId: team.teamId,
      athleteId: late.athleteId,
      idempotencyKey: k(),
    });
    await teams.respond({ actorAccountId: late.accountId, membershipId, accept: true });
    const p = (
      await sql<{
        id: string;
      }>`SELECT id FROM competition.participant WHERE event_id = ${ev.eventId} AND team_id = ${team.teamId}`.execute(
        owner,
      )
    ).rows[0]?.id as string;
    const contest = (
      await sql<{
        id: string;
      }>`SELECT ct.contest_id AS id FROM competition.contestant ct WHERE ct.participant_id = ${p} LIMIT 1`.execute(
        owner,
      )
    ).rows[0]?.id as string;
    await expect(
      structure.submitLineup({
        actorAccountId: team.manager.accountId,
        contestId: contest,
        participantId: p,
        athletes: [...team.members.map((m) => ({ athleteId: m.athleteId }))]
          .slice(0, 2)
          .concat([{ athleteId: late.athleteId }]),
        idempotencyKey: k(),
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.INVALID_INPUT });
    const ok = await structure.submitLineup({
      actorAccountId: team.manager.accountId,
      contestId: contest,
      participantId: p,
      athletes: team.members.map((m) => ({ athleteId: m.athleteId })),
      idempotencyKey: k(),
    });
    expect(ok.created).toBe(true);
  }, 120_000);

  it('refuses to lock when a team is outside the discipline roster bounds', async () => {
    const ev = await eventWith('3x3@1', 'gk@1', { groupCount: 2, qualifiersPerGroup: 1 });
    for (let i = 0; i < 4; i++) {
      const t = await teamOf(3, 'EVENT_SQUAD');
      await comps.register({
        actorAccountId: t.manager.accountId,
        eventId: ev.eventId,
        teamId: t.teamId,
        eligibilityDeclared: true,
        idempotencyKey: k(),
      });
      if (i === 0) {
        // 5 active members after registration: above the 3x3 roster maximum of 4.
        for (let j = 0; j < 2; j++) {
          const extra = await newAthlete(identity, `x${j}`, `Extra ${j}`);
          const { membershipId } = await teams.addMember({
            actorAccountId: t.manager.accountId,
            teamId: t.teamId,
            athleteId: extra.athleteId,
            idempotencyKey: k(),
          });
          await teams.respond({ actorAccountId: extra.accountId, membershipId, accept: true });
        }
      }
    }
    await comps.closeRegistration({ actorAccountId: ev.actor, eventId: ev.eventId });
    await expect(
      structure.lockField({ actorAccountId: ev.actor, eventId: ev.eventId, idempotencyKey: k() }),
    ).rejects.toMatchObject({
      code: DomainErrorCode.INVALID_INPUT,
      details: { reason: 'FIELD_INCOMPLETE' },
    });
  }, 120_000);
});

describe('ONCF-05B invariants', () => {
  it('seeding overrides are hashed into the document and audited one by one', async () => {
    const ev = await eventWith('tennis@2', 'se@2');
    await individuals(ev.eventId, 4);
    await comps.closeRegistration({ actorAccountId: ev.actor, eventId: ev.eventId });
    await structure.lockField({
      actorAccountId: ev.actor,
      eventId: ev.eventId,
      idempotencyKey: k(),
    });
    const pids = (
      await sql<{
        id: string;
      }>`SELECT id FROM competition.participant WHERE event_id = ${ev.eventId} ORDER BY id`.execute(
        owner,
      )
    ).rows.map((r) => r.id);
    const seeded = await structure.seedField({
      actorAccountId: ev.actor,
      eventId: ev.eventId,
      method: 'DETERMINISTIC_DRAW',
      overrides: [{ participantId: pids[3] as string, toPosition: 1, reason: 'Host wild card' }],
      idempotencyKey: k(),
    });
    expect(seeded.seedOrder[0]).toBe(pids[3]);
    const doc = await sql<{
      d: { overrides: unknown[] };
    }>`SELECT seeding_document AS d FROM competition.event_seeding WHERE event_id = ${ev.eventId}`.execute(
      owner,
    );
    expect(doc.rows[0]?.d.overrides).toHaveLength(1);
    expect(
      await count(
        `SELECT count(*) AS n FROM platform.audit_event WHERE action = 'event.seeding.override' AND target_id = '${ev.eventId}'`,
      ),
    ).toBe(1);
  });

  it('a format the discipline cannot provide for is refused at event creation (capability rule)', async () => {
    await expect(eventWith('golf@1', 'wave@1')).rejects.toMatchObject({
      code: DomainErrorCode.INVALID_INPUT,
      details: { reason: 'CAPABILITY_MISMATCH' },
    });
  });

  it('read models rebuild identically from canonical facts (stage graphs included)', async () => {
    const before = await snapshotCompetitionReadModels(api);
    await rebuildCompetitionReadModels(maintenance);
    expect(await snapshotCompetitionReadModels(api)).toEqual(before);
  }, 120_000);

  it('new structure tables are append-only, even for the owner', async () => {
    for (const t of [
      'stage',
      'stage_transition',
      'contest_entry',
      'participant_roster_member',
      'participant_entry_attribute',
      'registration_entry_attribute',
    ])
      await expect(sql.raw(`DELETE FROM competition.${t}`).execute(owner)).rejects.toThrow();
  });
});
