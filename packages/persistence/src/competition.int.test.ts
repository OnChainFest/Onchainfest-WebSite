import { deterministicDraw, type PlanDocument } from '@br/competition';
import { DomainErrorCode, newId } from '@br/domain';
import {
  apiDb,
  operatorDb,
  maintenanceDb,
  newAthlete,
  newOrganizer,
  newTestAccount,
  ownerDb,
  RUNNING_5K_SPEC,
  seedTestCatalog,
  uniqueSlug,
  type TestCatalog,
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
import { inTransaction, ModuleRole } from './tx';

const api = apiDb();
const owner = ownerDb();
const maintenance = maintenanceDb();
afterAll(async () => {
  await Promise.all([api, owner, maintenance, operator].map((d) => d.destroy()));
});

const identity = new IdentityStore(api);
const orgs = new OrganizationStore(api);
const operator = operatorDb();
const catalog = new CatalogStore(operator); // BRT-05R: catalog writes use the operator login
const comps = new CompetitionStore(api);
const structure = new StructureStore(api);
const teams = new TeamStore(api);
const reader = new CompetitionReader(api);
let cat: TestCatalog;
beforeAll(async () => {
  cat = await seedTestCatalog(identity, catalog);
}, 60_000);

const k = () => `k-${newId()}`;
async function rejects(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toMatchObject({ code });
}

async function world(
  options: { publish?: boolean; activate?: boolean; startsAt?: string; endsAt?: string } = {},
) {
  const org = await newOrganizer(identity, orgs);
  const slug = uniqueSlug('comp');
  const { competitionId } = await comps.createCompetition({
    actorAccountId: org.ownerAccountId,
    organizerOrganizationId: org.organizationId,
    slug,
    profile: {
      name: 'Fictional Open',
      timezone: 'America/Costa_Rica',
      ...(options.startsAt ? { startsAt: options.startsAt } : {}),
      ...(options.endsAt ? { endsAt: options.endsAt } : {}),
    },
    idempotencyKey: k(),
  });
  if (options.publish !== false)
    await comps.publishCompetition({ actorAccountId: org.ownerAccountId, competitionId });
  if (options.activate === true)
    await comps.activateCompetition({ actorAccountId: org.ownerAccountId, competitionId });
  return { ...org, competitionId, competitionSlug: slug };
}

async function tennisEvent(
  w: Awaited<ReturnType<typeof world>>,
  settings: {
    capacity?: number | null;
    registrationMode?: 'AUTO_CONFIRM' | 'ORGANIZER_APPROVAL';
    format?: 'SE' | 'RR';
  } = {},
) {
  const slug = uniqueSlug('ev');
  const { eventId } = await comps.createEvent({
    actorAccountId: w.ownerAccountId,
    competitionId: w.competitionId,
    slug,
    disciplineVersionId: cat.tennisSingles,
    formatVersionId: settings.format === 'RR' ? cat.roundRobin : cat.singleElimination,
    settings: {
      name: 'Open Singles',
      capacity: settings.capacity ?? null,
      registrationMode: settings.registrationMode ?? 'AUTO_CONFIRM',
    },
    idempotencyKey: k(),
  });
  return { eventId, slug };
}

/** Event with `n` confirmed individual entrants, locked, seeded (MANUAL in confirmation order) and planned. */
async function plannedEvent(
  n: number,
  format: 'SE' | 'RR' = 'SE',
  options: { activate?: boolean } = {},
) {
  const w = await world({ activate: options.activate ?? true });
  const ev = await tennisEvent(w, { format });
  await comps.openRegistration({ actorAccountId: w.ownerAccountId, eventId: ev.eventId });
  const athletes = [];
  for (let i = 0; i < n; i++) {
    const a = await newAthlete(identity, `p${i}`, `Player ${i}`);
    await comps.register({
      actorAccountId: a.accountId,
      eventId: ev.eventId,
      athleteId: a.athleteId,
      eligibilityDeclared: true,
      idempotencyKey: k(),
    });
    athletes.push(a);
  }
  await comps.closeRegistration({ actorAccountId: w.ownerAccountId, eventId: ev.eventId });
  const field = await structure.lockField({
    actorAccountId: w.ownerAccountId,
    eventId: ev.eventId,
    idempotencyKey: k(),
  });
  const seeding = await structure.seedField({
    actorAccountId: w.ownerAccountId,
    eventId: ev.eventId,
    method: 'DETERMINISTIC_DRAW',
    idempotencyKey: k(),
  });
  const plan = await structure.generatePlan({
    actorAccountId: w.ownerAccountId,
    eventId: ev.eventId,
    idempotencyKey: k(),
  });
  return { w, ev, athletes, field, seeding, plan };
}

const count = async (q: string) =>
  Number(((await sql.raw(q).execute(owner)).rows[0] as { n: number | string }).n);

// ───────────────────────────── catalog ─────────────────────────────

describe('sport catalog (operator-only, versioned, immutable)', () => {
  it('codes are unique; disciplines live in their sport namespace; bad specs and engines are refused', async () => {
    const tag = newId().replace(/-/g, '').slice(-8);
    const { sportId } = await catalog.createSport({
      operatorAccountId: cat.operatorAccountId,
      code: `bowling${tag}`,
      name: 'Bowling',
      idempotencyKey: k(),
    });
    await rejects(
      catalog.createSport({
        operatorAccountId: cat.operatorAccountId,
        code: `bowling${tag}`,
        name: 'Bowling again',
        idempotencyKey: k(),
      }),
      DomainErrorCode.ALREADY_EXISTS,
    );
    await rejects(
      catalog.createDiscipline({
        operatorAccountId: cat.operatorAccountId,
        sportId,
        code: `padel${tag}.doubles`,
        name: 'Wrong namespace',
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_INPUT,
    );
    const { disciplineId } = await catalog.createDiscipline({
      operatorAccountId: cat.operatorAccountId,
      sportId,
      code: `bowling${tag}.tenpin`,
      name: 'Tenpin',
      idempotencyKey: k(),
    });
    await rejects(
      catalog.createDisciplineVersion({
        operatorAccountId: cat.operatorAccountId,
        disciplineId,
        spec: {
          ...RUNNING_5K_SPEC,
          comparator: { outcomeModel: 'RANKED', primary: 'METRICS', keys: [] },
        },
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_INPUT,
    );
    await rejects(
      catalog.createDisciplineVersion({
        operatorAccountId: cat.operatorAccountId,
        disciplineId,
        spec: {
          ...RUNNING_5K_SPEC,
          resultSchema: { type: 'object', properties: { x: { type: 'number' } } },
        } as never,
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_INPUT,
    );
    const { formatTemplateId } = await catalog.createFormatTemplate({
      operatorAccountId: cat.operatorAccountId,
      code: `ladder-${tag}`,
      name: 'Ladder',
      idempotencyKey: k(),
    });
    await rejects(
      catalog.createFormatVersion({
        operatorAccountId: cat.operatorAccountId,
        formatTemplateId,
        engineId: 'stepladder',
        engineVersion: 1,
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_INPUT,
    );
    await rejects(
      catalog.createFormatVersion({
        operatorAccountId: cat.operatorAccountId,
        formatTemplateId,
        engineId: 'single-elimination',
        engineVersion: 99, // ONCF-05B registered single-elimination/2; an unknown version is still refused
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_INPUT,
    );
  });

  it('versions are numbered, immutable (even for the owner) and only PUBLISHED versions can be pinned', async () => {
    const { rows } = await sql<{
      discipline_id: string;
    }>`SELECT discipline_id FROM sports.discipline_version WHERE id = ${cat.tennisSingles}`.execute(
      owner,
    );
    const disciplineId = rows[0]?.discipline_id as string;
    const v2 = await catalog.createDisciplineVersion({
      operatorAccountId: cat.operatorAccountId,
      disciplineId,
      spec: RUNNING_5K_SPEC,
      idempotencyKey: k(),
    });
    expect(v2.version).toBe(2);
    await expect(
      sql`UPDATE sports.discipline_version SET spec = '{}'::jsonb WHERE id = ${cat.tennisSingles}`.execute(
        owner,
      ),
    ).rejects.toMatchObject({ code: 'BR001' });
    await rejects(
      catalog.publishDisciplineVersion({
        operatorAccountId: cat.operatorAccountId,
        disciplineVersionId: cat.tennisSingles,
      }),
      DomainErrorCode.INVALID_TRANSITION,
    );
    const w = await world();
    // DRAFT version cannot be pinned
    await rejects(
      comps.createEvent({
        actorAccountId: w.ownerAccountId,
        competitionId: w.competitionId,
        slug: uniqueSlug('ev'),
        disciplineVersionId: v2.disciplineVersionId,
        formatVersionId: cat.singleElimination,
        settings: { name: 'X' },
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_INPUT,
    );
    // an event pins the exact version; publishing/retiring later versions never changes it
    const ev = await tennisEvent(w);
    await catalog.publishDisciplineVersion({
      operatorAccountId: cat.operatorAccountId,
      disciplineVersionId: v2.disciplineVersionId,
    });
    await catalog.retireDisciplineVersion({
      operatorAccountId: cat.operatorAccountId,
      disciplineVersionId: v2.disciplineVersionId,
    });
    const { rows: pinned } = await sql<{
      discipline_version_id: string;
      format_version_id: string;
    }>`
      SELECT discipline_version_id, format_version_id FROM competition.event WHERE id = ${ev.eventId}`.execute(
      owner,
    );
    expect(pinned[0]).toEqual({
      discipline_version_id: cat.tennisSingles,
      format_version_id: cat.singleElimination,
    });
    await rejects(
      comps.createEvent({
        actorAccountId: w.ownerAccountId,
        competitionId: w.competitionId,
        slug: uniqueSlug('ev'),
        disciplineVersionId: v2.disciplineVersionId,
        formatVersionId: cat.singleElimination,
        settings: { name: 'X' },
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_INPUT,
    );
  });

  it('format structure is separate from sporting rules: a HEAT-only discipline cannot use a MATCH format', async () => {
    const w = await world();
    await rejects(
      comps.createEvent({
        actorAccountId: w.ownerAccountId,
        competitionId: w.competitionId,
        slug: uniqueSlug('5k'),
        disciplineVersionId: cat.running5k,
        formatVersionId: cat.singleElimination,
        settings: { name: '5K' },
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_INPUT,
    );
    await rejects(
      comps.createEvent({
        actorAccountId: w.ownerAccountId,
        competitionId: w.competitionId,
        slug: uniqueSlug('ev'),
        disciplineVersionId: cat.tennisSingles,
        formatVersionId: cat.singleElimination,
        formatConfig: { extra: 1 },
        settings: { name: 'X' },
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_INPUT,
    );
  });
});

// ───────────────────────────── competitions ─────────────────────────────

describe('competition lifecycle and operational permissions', () => {
  it('only organizer OWNER/ADMIN may create; members cannot; slugs are unique and normalized', async () => {
    const org = await newOrganizer(identity, orgs);
    const member = await newTestAccount(identity);
    const inv = await orgs.invite({
      actorAccountId: org.ownerAccountId,
      organizationId: org.organizationId,
      personId: member.personId as string,
      role: 'MEMBER',
      visibility: 'PUBLIC',
      idempotencyKey: k(),
    });
    await orgs.respondToInvitation({
      actorAccountId: member.accountId,
      token: inv.token as string,
      accept: true,
    });
    const profile = { name: 'Member Cup', timezone: 'UTC' };
    await rejects(
      comps.createCompetition({
        actorAccountId: member.accountId,
        organizerOrganizationId: org.organizationId,
        slug: uniqueSlug('c'),
        profile,
        idempotencyKey: k(),
      }),
      DomainErrorCode.FORBIDDEN,
    );
    const slug = uniqueSlug('Mixed_Case');
    const r = await comps.createCompetition({
      actorAccountId: org.ownerAccountId,
      organizerOrganizationId: org.organizationId,
      slug: slug.toUpperCase(),
      profile,
      idempotencyKey: k(),
    });
    expect(r.slug).toBe(slug.toLowerCase().replace(/_/g, '-'));
    await rejects(
      comps.createCompetition({
        actorAccountId: org.ownerAccountId,
        organizerOrganizationId: org.organizationId,
        slug: 'admin',
        profile,
        idempotencyKey: k(),
      }),
      DomainErrorCode.SLUG_INVALID,
    );
    await rejects(
      comps.createCompetition({
        actorAccountId: org.ownerAccountId,
        organizerOrganizationId: org.organizationId,
        slug: r.slug,
        profile,
        idempotencyKey: k(),
      }),
      DomainErrorCode.SLUG_TAKEN,
    );
    await rejects(
      comps.publishCompetition({
        actorAccountId: member.accountId,
        competitionId: r.competitionId,
      }),
      DomainErrorCode.FORBIDDEN,
    );
    await rejects(
      comps.createCompetition({
        actorAccountId: org.ownerAccountId,
        organizerOrganizationId: org.organizationId,
        slug: uniqueSlug('c'),
        profile: { name: 'Bad tz', timezone: 'Mars/Olympus' },
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_INPUT,
    );
  });

  it('concurrent competition creations claiming one slug: exactly one wins, no orphans', async () => {
    const org = await newOrganizer(identity, orgs);
    const slug = uniqueSlug('race');
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        comps.createCompetition({
          actorAccountId: org.ownerAccountId,
          organizerOrganizationId: org.organizationId,
          slug,
          profile: { name: 'Race', timezone: 'UTC' },
          idempotencyKey: k(),
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results)
      if (r.status === 'rejected')
        expect(r.reason).toMatchObject({ code: DomainErrorCode.SLUG_TAKEN });
    expect(
      await count(
        `SELECT count(*) AS n FROM competition.competition c WHERE NOT EXISTS (SELECT 1 FROM competition.competition_slug s WHERE s.competition_id = c.id)`,
      ),
    ).toBe(0);
  });

  it('transitions follow the lifecycle; completion needs terminal events; cancellation cascades as status facts', async () => {
    const w = await world({ publish: false });
    await rejects(
      comps.activateCompetition({
        actorAccountId: w.ownerAccountId,
        competitionId: w.competitionId,
      }),
      DomainErrorCode.INVALID_TRANSITION,
    );
    await comps.publishCompetition({
      actorAccountId: w.ownerAccountId,
      competitionId: w.competitionId,
    });
    await rejects(
      comps.publishCompetition({
        actorAccountId: w.ownerAccountId,
        competitionId: w.competitionId,
      }),
      DomainErrorCode.INVALID_TRANSITION,
    );
    const ev = await tennisEvent(w);
    await comps.activateCompetition({
      actorAccountId: w.ownerAccountId,
      competitionId: w.competitionId,
    });
    await rejects(
      comps.completeCompetition({
        actorAccountId: w.ownerAccountId,
        competitionId: w.competitionId,
      }),
      DomainErrorCode.INVALID_TRANSITION,
    );
    await comps.cancelCompetition({
      actorAccountId: w.ownerAccountId,
      competitionId: w.competitionId,
      reason: 'weather',
    });
    const { rows } = await sql<{
      status: string;
    }>`SELECT status FROM competition.v_event_current WHERE event_id = ${ev.eventId}`.execute(
      owner,
    );
    expect(rows[0]?.status).toBe('CANCELLED');
    await rejects(
      comps.activateCompetition({
        actorAccountId: w.ownerAccountId,
        competitionId: w.competitionId,
      }),
      DomainErrorCode.INVALID_TRANSITION,
    );
    // history kept: nothing deleted
    expect(
      await count(`SELECT count(*) AS n FROM competition.event WHERE id = '${ev.eventId}'`),
    ).toBe(1);
    const pub = await reader.competitionBySlug(w.competitionSlug);
    expect(pub?.competition.competition.status).toBe('CANCELLED');
  });

  it('draft competitions and events are never public', async () => {
    const w = await world({ publish: false });
    expect(await reader.competitionBySlug(w.competitionSlug)).toBeUndefined();
    await comps.publishCompetition({
      actorAccountId: w.ownerAccountId,
      competitionId: w.competitionId,
    });
    const ev = await tennisEvent(w);
    expect(await reader.eventBySlugs(w.competitionSlug, ev.slug)).toBeUndefined();
    expect((await reader.competitionBySlug(w.competitionSlug))?.competition.events).toEqual([]);
    await comps.openRegistration({ actorAccountId: w.ownerAccountId, eventId: ev.eventId });
    expect((await reader.eventBySlugs(w.competitionSlug, ev.slug))?.event.event.status).toBe(
      'REGISTRATION_OPEN',
    );
  });
});

// ───────────────────────────── registration & capacity ─────────────────────────────

describe('registration lifecycle, capacity and waitlist', () => {
  it('20 simultaneous registrations against capacity 4: exactly 4 confirmed, 16 waitlisted, never more', async () => {
    const w = await world();
    const ev = await tennisEvent(w, { capacity: 4 });
    await comps.openRegistration({ actorAccountId: w.ownerAccountId, eventId: ev.eventId });
    const athletes = await Promise.all(
      Array.from({ length: 20 }, (_, i) => newAthlete(identity, `cap${i}`)),
    );
    const results = await Promise.all(
      athletes.map((a) =>
        comps.register({
          actorAccountId: a.accountId,
          eventId: ev.eventId,
          athleteId: a.athleteId,
          eligibilityDeclared: true,
          idempotencyKey: k(),
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'CONFIRMED')).toHaveLength(4);
    expect(results.filter((r) => r.status === 'WAITLISTED')).toHaveLength(16);
    expect(
      await count(
        `SELECT count(*) AS n FROM competition.v_registration_current WHERE event_id = '${ev.eventId}' AND status = 'CONFIRMED'`,
      ),
    ).toBe(4);
    const pub = await reader.eventBySlugs(w.competitionSlug, ev.slug);
    expect(pub?.event.event).toMatchObject({ capacity: 4, confirmedCount: 4, waitlistCount: 16 });
    // the database itself refuses a fifth CONFIRMED even if application code skipped its checks
    const waitlisted = results.find((r) => r.status === 'WAITLISTED') as { registrationId: string };
    await expect(
      inTransaction(api, ModuleRole.competition, (ctx) =>
        sql`INSERT INTO competition.registration_status_change (id, registration_id, event_id, status, eligibility_basis, recorded_at)
            VALUES (${newId()}, ${waitlisted.registrationId}, ${ev.eventId}, 'CONFIRMED', 'DECLARED', ${ctx.txTime})`.execute(
          ctx.trx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'BR003' });
  });

  it('20 identical attempts with one key → one registration; a second key for the same athlete is refused', async () => {
    const w = await world();
    const ev = await tennisEvent(w);
    await comps.openRegistration({ actorAccountId: w.ownerAccountId, eventId: ev.eventId });
    const a = await newAthlete(identity);
    const key = k();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        comps.register({
          actorAccountId: a.accountId,
          eventId: ev.eventId,
          athleteId: a.athleteId,
          eligibilityDeclared: true,
          idempotencyKey: key,
        }),
      ),
    );
    expect(new Set(results.map((r) => r.registrationId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const others = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        comps.register({
          actorAccountId: a.accountId,
          eventId: ev.eventId,
          athleteId: a.athleteId,
          eligibilityDeclared: true,
          idempotencyKey: k(),
        }),
      ),
    );
    expect(
      others.every(
        (r) =>
          r.status === 'rejected' &&
          (r.reason as { code: string }).code === DomainErrorCode.ALREADY_EXISTS,
      ),
    ).toBe(true);
    expect(
      await count(
        `SELECT count(*) AS n FROM competition.registration WHERE event_id = '${ev.eventId}'`,
      ),
    ).toBe(1);
    // same key, different request → IDEMPOTENCY_KEY_REUSED
    const b = await newAthlete(identity);
    await rejects(
      comps.register({
        actorAccountId: a.accountId,
        eventId: ev.eventId,
        athleteId: b.athleteId,
        eligibilityDeclared: true,
        idempotencyKey: key,
      }),
      DomainErrorCode.IDEMPOTENCY_KEY_REUSED,
    );
  });

  it('entrant authorization, windows, XOR, declared eligibility; organizer approval mode', async () => {
    const w = await world();
    const ev = await tennisEvent(w, { capacity: 1, registrationMode: 'ORGANIZER_APPROVAL' });
    const a = await newAthlete(identity);
    const stranger = await newTestAccount(identity);
    await rejects(
      comps.register({
        actorAccountId: a.accountId,
        eventId: ev.eventId,
        athleteId: a.athleteId,
        eligibilityDeclared: true,
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_TRANSITION,
    );
    await comps.openRegistration({ actorAccountId: w.ownerAccountId, eventId: ev.eventId });
    await rejects(
      comps.register({
        actorAccountId: stranger.accountId,
        eventId: ev.eventId,
        athleteId: a.athleteId,
        eligibilityDeclared: true,
        idempotencyKey: k(),
      }),
      DomainErrorCode.FORBIDDEN,
    );
    await rejects(
      comps.register({
        actorAccountId: a.accountId,
        eventId: ev.eventId,
        athleteId: a.athleteId,
        eligibilityDeclared: false,
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_INPUT,
    );
    await expect(
      comps.register({
        actorAccountId: a.accountId,
        eventId: ev.eventId,
        athleteId: a.athleteId,
        teamId: newId(),
        eligibilityDeclared: true,
        idempotencyKey: k(),
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.INVALID_INPUT });
    const r1 = await comps.register({
      actorAccountId: a.accountId,
      eventId: ev.eventId,
      athleteId: a.athleteId,
      eligibilityDeclared: true,
      idempotencyKey: k(),
    });
    expect(r1.status).toBe('REQUESTED');
    const b = await newAthlete(identity);
    const r2 = await comps.register({
      actorAccountId: b.accountId,
      eventId: ev.eventId,
      athleteId: b.athleteId,
      eligibilityDeclared: true,
      idempotencyKey: k(),
    });
    await rejects(
      comps.decideRegistration({
        actorAccountId: a.accountId,
        registrationId: r1.registrationId,
        decision: 'CONFIRM',
        idempotencyKey: k(),
      }),
      DomainErrorCode.FORBIDDEN,
    );
    await comps.decideRegistration({
      actorAccountId: w.ownerAccountId,
      registrationId: r1.registrationId,
      decision: 'CONFIRM',
      idempotencyKey: k(),
    });
    await rejects(
      comps.decideRegistration({
        actorAccountId: w.ownerAccountId,
        registrationId: r2.registrationId,
        decision: 'CONFIRM',
        idempotencyKey: k(),
      }),
      DomainErrorCode.CAPACITY_REACHED,
    );
    await comps.decideRegistration({
      actorAccountId: w.ownerAccountId,
      registrationId: r2.registrationId,
      decision: 'WAITLIST',
      idempotencyKey: k(),
    });
    const { rows } = await sql<{ eligibility_basis: string }>`
      SELECT eligibility_basis FROM competition.registration_status_change WHERE registration_id = ${r1.registrationId} AND status = 'CONFIRMED'`.execute(
      owner,
    );
    expect(rows[0]?.eligibility_basis).toBe('ORGANIZER_ACCEPTED');
    // invalid transitions
    await rejects(
      comps.decideRegistration({
        actorAccountId: w.ownerAccountId,
        registrationId: r1.registrationId,
        decision: 'WAITLIST',
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_TRANSITION,
    );
    await comps.decideRegistration({
      actorAccountId: w.ownerAccountId,
      registrationId: r2.registrationId,
      decision: 'DECLINE',
      idempotencyKey: k(),
    });
    await rejects(
      comps.decideRegistration({
        actorAccountId: w.ownerAccountId,
        registrationId: r2.registrationId,
        decision: 'CONFIRM',
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_TRANSITION,
    );
  });

  it('withdrawing a confirmed entry promotes the earliest waitlisted entry (AUTO_CONFIRM)', async () => {
    const w = await world();
    const ev = await tennisEvent(w, { capacity: 1 });
    await comps.openRegistration({ actorAccountId: w.ownerAccountId, eventId: ev.eventId });
    const [a, b, c] = [
      await newAthlete(identity),
      await newAthlete(identity),
      await newAthlete(identity),
    ];
    const ra = await comps.register({
      actorAccountId: a.accountId,
      eventId: ev.eventId,
      athleteId: a.athleteId,
      eligibilityDeclared: true,
      idempotencyKey: k(),
    });
    const rb = await comps.register({
      actorAccountId: b.accountId,
      eventId: ev.eventId,
      athleteId: b.athleteId,
      eligibilityDeclared: true,
      idempotencyKey: k(),
    });
    await comps.register({
      actorAccountId: c.accountId,
      eventId: ev.eventId,
      athleteId: c.athleteId,
      eligibilityDeclared: true,
      idempotencyKey: k(),
    });
    const w1 = await comps.withdrawRegistration({
      actorAccountId: a.accountId,
      registrationId: ra.registrationId,
      idempotencyKey: k(),
    });
    expect(w1.promotedRegistrationId).toBe(rb.registrationId);
    // a withdrawn athlete may register again (new registration), and lands on the waitlist
    const again = await comps.register({
      actorAccountId: a.accountId,
      eventId: ev.eventId,
      athleteId: a.athleteId,
      eligibilityDeclared: true,
      idempotencyKey: k(),
    });
    expect(again.status).toBe('WAITLISTED');
  });
});

// ───────────────────────────── field lock, seeding, plan ─────────────────────────────

describe('field lock, seeding and immutable plan', () => {
  it('lock materializes Participants from CONFIRMED registrations only; nothing enters afterwards', async () => {
    const w = await world({ activate: true });
    const ev = await tennisEvent(w, { capacity: 3 });
    await comps.openRegistration({ actorAccountId: w.ownerAccountId, eventId: ev.eventId });
    const as = await Promise.all(
      Array.from({ length: 5 }, (_, i) => newAthlete(identity, `fl${i}`)),
    );
    const regs = [];
    for (const a of as)
      regs.push(
        await comps.register({
          actorAccountId: a.accountId,
          eventId: ev.eventId,
          athleteId: a.athleteId,
          eligibilityDeclared: true,
          idempotencyKey: k(),
        }),
      );
    await comps.withdrawRegistration({
      actorAccountId: as[0]!.accountId,
      registrationId: regs[0]!.registrationId,
      idempotencyKey: k(),
    }); // promotes as[3]
    await rejects(
      structure.lockField({
        actorAccountId: w.ownerAccountId,
        eventId: ev.eventId,
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_TRANSITION,
    ); // still open
    await comps.closeRegistration({ actorAccountId: w.ownerAccountId, eventId: ev.eventId });
    const field = await structure.lockField({
      actorAccountId: w.ownerAccountId,
      eventId: ev.eventId,
      idempotencyKey: k(),
    });
    expect(field.participantCount).toBe(3);
    const { rows: ps } = await sql<{
      athlete_id: string;
    }>`SELECT athlete_id FROM competition.participant WHERE event_id = ${ev.eventId}`.execute(
      owner,
    );
    expect(new Set(ps.map((p) => p.athlete_id))).toEqual(
      new Set([as[1]!.athleteId, as[2]!.athleteId, as[3]!.athleteId]),
    );
    // waitlisted (as[4]) and withdrawn (as[0]) are not participants
    const late = await newAthlete(identity);
    await rejects(
      comps.register({
        actorAccountId: late.accountId,
        eventId: ev.eventId,
        athleteId: late.athleteId,
        eligibilityDeclared: true,
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_TRANSITION,
    );
    await rejects(
      comps.openRegistration({ actorAccountId: w.ownerAccountId, eventId: ev.eventId }),
      DomainErrorCode.INVALID_TRANSITION,
    );
    await rejects(
      comps.withdrawRegistration({
        actorAccountId: as[1]!.accountId,
        registrationId: regs[1]!.registrationId,
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_TRANSITION,
    );
    await rejects(
      comps.decideRegistration({
        actorAccountId: w.ownerAccountId,
        registrationId: regs[4]!.registrationId,
        decision: 'CONFIRM',
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_TRANSITION,
    );
    await rejects(
      structure.generatePlan({
        actorAccountId: w.ownerAccountId,
        eventId: ev.eventId,
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_TRANSITION,
    ); // needs seeding
  });

  it('seeding is tied to the field, reproducible from the stored draw seed, and immutable', async () => {
    const { w, ev, field, seeding } = await plannedEvent(6);
    const { rows } = await sql<{
      id: string;
    }>`SELECT id FROM competition.participant WHERE event_id = ${ev.eventId}`.execute(owner);
    expect(seeding.seedOrder).toEqual(
      deterministicDraw(
        rows.map((r) => r.id),
        seeding.drawSeed as string,
      ),
    );
    const { rows: s } = await sql<{
      field_hash: string;
    }>`SELECT field_hash FROM competition.event_seeding WHERE event_id = ${ev.eventId}`.execute(
      owner,
    );
    expect(s[0]?.field_hash).toBe(field.fieldHash);
    await rejects(
      structure.seedField({
        actorAccountId: w.ownerAccountId,
        eventId: ev.eventId,
        method: 'MANUAL',
        order: rows.map((r) => r.id),
        idempotencyKey: k(),
      }),
      DomainErrorCode.ALREADY_EXISTS,
    );
    await expect(
      sql`UPDATE competition.event_seeding SET seed_order = '{}' WHERE event_id = ${ev.eventId}`.execute(
        owner,
      ),
    ).rejects.toMatchObject({ code: 'BR001' });
  });

  it('manual seeding must be an exact permutation of the locked field', async () => {
    const w = await world({ activate: true });
    const ev = await tennisEvent(w);
    await comps.openRegistration({ actorAccountId: w.ownerAccountId, eventId: ev.eventId });
    for (let i = 0; i < 4; i++) {
      const a = await newAthlete(identity);
      await comps.register({
        actorAccountId: a.accountId,
        eventId: ev.eventId,
        athleteId: a.athleteId,
        eligibilityDeclared: true,
        idempotencyKey: k(),
      });
    }
    await comps.closeRegistration({ actorAccountId: w.ownerAccountId, eventId: ev.eventId });
    await structure.lockField({
      actorAccountId: w.ownerAccountId,
      eventId: ev.eventId,
      idempotencyKey: k(),
    });
    const { rows } = await sql<{
      id: string;
    }>`SELECT id FROM competition.participant WHERE event_id = ${ev.eventId} ORDER BY id`.execute(
      owner,
    );
    const ids = rows.map((r) => r.id);
    for (const bad of [
      ids.slice(0, 3),
      [...ids.slice(0, 3), ids[0] as string],
      [...ids.slice(0, 3), newId()],
    ]) {
      await rejects(
        structure.seedField({
          actorAccountId: w.ownerAccountId,
          eventId: ev.eventId,
          method: 'MANUAL',
          order: bad,
          idempotencyKey: k(),
        }),
        DomainErrorCode.INVALID_INPUT,
      );
    }
    const s = await structure.seedField({
      actorAccountId: w.ownerAccountId,
      eventId: ev.eventId,
      method: 'MANUAL',
      order: [...ids].reverse(),
      idempotencyKey: k(),
    });
    expect(s.seedOrder).toEqual([...ids].reverse());
    expect(s.drawSeed).toBeNull();
  });

  it('concurrent plan generation: one canonical plan, same replay, no duplicate rounds or contests', async () => {
    const w = await world({ activate: true });
    const ev = await tennisEvent(w);
    await comps.openRegistration({ actorAccountId: w.ownerAccountId, eventId: ev.eventId });
    for (let i = 0; i < 5; i++) {
      const a = await newAthlete(identity);
      await comps.register({
        actorAccountId: a.accountId,
        eventId: ev.eventId,
        athleteId: a.athleteId,
        eligibilityDeclared: true,
        idempotencyKey: k(),
      });
    }
    await comps.closeRegistration({ actorAccountId: w.ownerAccountId, eventId: ev.eventId });
    await structure.lockField({
      actorAccountId: w.ownerAccountId,
      eventId: ev.eventId,
      idempotencyKey: k(),
    });
    await structure.seedField({
      actorAccountId: w.ownerAccountId,
      eventId: ev.eventId,
      method: 'DETERMINISTIC_DRAW',
      idempotencyKey: k(),
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        structure.generatePlan({
          actorAccountId: w.ownerAccountId,
          eventId: ev.eventId,
          idempotencyKey: k(),
        }),
      ),
    );
    expect(new Set(results.map((r) => r.planHash)).size).toBe(1);
    expect(new Set(results.map((r) => r.inputHash)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(
      await count(
        `SELECT count(*) AS n FROM competition.event_plan WHERE event_id = '${ev.eventId}'`,
      ),
    ).toBe(1);
    expect(
      await count(`SELECT count(*) AS n FROM competition.contest WHERE event_id = '${ev.eventId}'`),
    ).toBe(4); // n − 1
    expect(
      await count(`SELECT count(*) AS n FROM competition.round WHERE event_id = '${ev.eventId}'`),
    ).toBe(3);
    await expect(
      sql`UPDATE competition.event_plan SET plan_hash = plan_hash WHERE event_id = ${ev.eventId}`.execute(
        owner,
      ),
    ).rejects.toMatchObject({ code: 'BR001' });
    await expect(
      sql`DELETE FROM competition.contest WHERE event_id = ${ev.eventId}`.execute(owner),
    ).rejects.toMatchObject({ code: 'BR001' });
  });

  it('the stored plan document is the historical structure and matches its hash and the persisted rows', async () => {
    const { ev, plan } = await plannedEvent(8);
    const { rows } = await sql<{
      plan_document: PlanDocument;
      plan_hash: string;
    }>`SELECT plan_document, plan_hash FROM competition.event_plan WHERE event_id = ${ev.eventId}`.execute(
      owner,
    );
    const { planHash } = await import('@br/competition');
    expect(planHash(rows[0]?.plan_document as PlanDocument)).toBe(plan.planHash);
    expect(plan.engine).toBe('single-elimination/1');
    // unresolved WINNER_OF dependencies: no participant on dependent slots
    expect(
      await count(
        `SELECT count(*) AS n FROM competition.contestant ct JOIN competition.contest c ON c.id = ct.contest_id WHERE c.event_id = '${ev.eventId}' AND ct.source_kind = 'WINNER_OF_CONTEST' AND ct.participant_id IS NOT NULL`,
      ),
    ).toBe(0);
    expect(
      await count(
        `SELECT count(*) AS n FROM competition.contestant ct JOIN competition.contest c ON c.id = ct.contest_id WHERE c.event_id = '${ev.eventId}' AND ct.source_kind = 'WINNER_OF_CONTEST'`,
      ),
    ).toBe(6);
  });

  it('round robin: every pairing once, BYEs recorded on rounds', async () => {
    const { ev, plan } = await plannedEvent(5, 'RR');
    expect(plan.engine).toBe('round-robin/1');
    expect(plan.contests).toBe(10);
    const { rows } = await sql<{
      byes: string[];
    }>`SELECT byes FROM competition.round WHERE event_id = ${ev.eventId} ORDER BY sequence`.execute(
      owner,
    );
    expect(rows).toHaveLength(5);
    expect(new Set(rows.flatMap((r) => r.byes)).size).toBe(5);
  });
});

// ───────────────────────────── participants, contests, lineups ─────────────────────────────

describe('participants, contests and lineups', () => {
  it('the same athlete in two events has two distinct Participants', async () => {
    const w = await world({ activate: true });
    const e1 = await tennisEvent(w);
    const e2 = await tennisEvent(w);
    const a = await newAthlete(identity);
    const b = await newAthlete(identity);
    for (const e of [e1, e2]) {
      await comps.openRegistration({ actorAccountId: w.ownerAccountId, eventId: e.eventId });
      for (const x of [a, b])
        await comps.register({
          actorAccountId: x.accountId,
          eventId: e.eventId,
          athleteId: x.athleteId,
          eligibilityDeclared: true,
          idempotencyKey: k(),
        });
      await comps.closeRegistration({ actorAccountId: w.ownerAccountId, eventId: e.eventId });
      await structure.lockField({
        actorAccountId: w.ownerAccountId,
        eventId: e.eventId,
        idempotencyKey: k(),
      });
    }
    const { rows } = await sql<{
      id: string;
      event_id: string;
    }>`SELECT id, event_id FROM competition.participant WHERE athlete_id = ${a.athleteId}`.execute(
      owner,
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.event_id))).toEqual(new Set([e1.eventId, e2.eventId]));
    expect(rows[0]?.id).not.toBe(rows[1]?.id);
  });

  it('scheduling respects the event window; contests start only when every slot holds an active participant', async () => {
    const { w, ev, athletes } = await plannedEvent(4, 'SE');
    const { rows } = await sql<{
      id: string;
      plan_key: string;
    }>`SELECT id, plan_key FROM competition.contest WHERE event_id = ${ev.eventId} ORDER BY sequence`.execute(
      owner,
    );
    const [semi1, , final] = rows;
    await structure.scheduleContest({
      actorAccountId: w.ownerAccountId,
      contestId: semi1!.id,
      scheduledStart: '2027-03-01T15:00:00Z',
      courtLabel: 'Court 1',
      idempotencyKey: k(),
    });
    await rejects(
      structure.scheduleContest({
        actorAccountId: w.ownerAccountId,
        contestId: semi1!.id,
        scheduledStart: '2027-03-01 15:00',
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_INPUT,
    ); // naive local time
    const stranger = await newTestAccount(identity);
    await rejects(
      structure.scheduleContest({
        actorAccountId: stranger.accountId,
        contestId: semi1!.id,
        scheduledStart: '2027-03-01T16:00:00Z',
        idempotencyKey: k(),
      }),
      DomainErrorCode.FORBIDDEN,
    );
    await rejects(
      structure.startContest({ actorAccountId: w.ownerAccountId, contestId: semi1!.id }),
      DomainErrorCode.INVALID_TRANSITION,
    ); // event not in progress
    await comps.startEvent({ actorAccountId: w.ownerAccountId, eventId: ev.eventId });
    await structure.startContest({ actorAccountId: w.ownerAccountId, contestId: semi1!.id });
    await structure.completeContest({ actorAccountId: w.ownerAccountId, contestId: semi1!.id });
    // completing a contest resolves nothing and creates no Result
    await structure.scheduleContest({
      actorAccountId: w.ownerAccountId,
      contestId: final!.id,
      scheduledStart: '2027-03-02T15:00:00Z',
      idempotencyKey: k(),
    });
    await rejects(
      structure.startContest({ actorAccountId: w.ownerAccountId, contestId: final!.id }),
      DomainErrorCode.INVALID_TRANSITION,
    );
    expect(
      await count(
        `SELECT count(*) AS n FROM competition.contestant WHERE contest_id = '${final!.id}' AND participant_id IS NOT NULL`,
      ),
    ).toBe(0);
    expect(
      await count(
        `SELECT count(*) AS n FROM results.result WHERE scope_target_id = '${semi1!.id}'`,
      ),
    ).toBe(0);
    expect(athletes).toHaveLength(4);
  });

  it('withdrawal after the plan keeps the bracket slot; the contest cannot start; no walkover is fabricated', async () => {
    const { w, ev, athletes } = await plannedEvent(2, 'SE');
    const { rows } = await sql<{
      id: string;
    }>`SELECT id FROM competition.participant WHERE event_id = ${ev.eventId} AND athlete_id = ${athletes[0]!.athleteId}`.execute(
      owner,
    );
    await structure.withdrawParticipant({
      actorAccountId: athletes[0]!.accountId,
      participantId: rows[0]!.id,
      reason: 'injury',
    });
    expect(
      await count(
        `SELECT count(*) AS n FROM competition.contestant WHERE participant_id = '${rows[0]!.id}'`,
      ),
    ).toBe(1);
    const { rows: c } = await sql<{
      id: string;
    }>`SELECT id FROM competition.contest WHERE event_id = ${ev.eventId}`.execute(owner);
    await structure.scheduleContest({
      actorAccountId: w.ownerAccountId,
      contestId: c[0]!.id,
      scheduledStart: '2027-03-01T15:00:00Z',
      idempotencyKey: k(),
    });
    await comps.startEvent({ actorAccountId: w.ownerAccountId, eventId: ev.eventId });
    await rejects(
      structure.startContest({ actorAccountId: w.ownerAccountId, contestId: c[0]!.id }),
      DomainErrorCode.INVALID_TRANSITION,
    );
    await rejects(
      structure.disqualifyParticipant({
        actorAccountId: athletes[1]!.accountId,
        participantId: rows[0]!.id,
        reason: 'x',
        reference: 'y',
      }),
      DomainErrorCode.FORBIDDEN,
    );
  });

  it('lineups: individual fields exactly its athlete; team lineups need active members; replacements are audited', async () => {
    const { w, ev, athletes } = await plannedEvent(2, 'SE');
    const { rows } = await sql<{ contest_id: string; participant_id: string; athlete_id: string }>`
      SELECT ct.contest_id, ct.participant_id, p.athlete_id FROM competition.contestant ct JOIN competition.participant p ON p.id = ct.participant_id
      WHERE p.event_id = ${ev.eventId} ORDER BY ct.slot`.execute(owner);
    const mine = rows.find((r) => r.athlete_id === athletes[0]!.athleteId)!;
    const other = rows.find((r) => r.athlete_id === athletes[1]!.athleteId)!;
    await rejects(
      structure.submitLineup({
        actorAccountId: athletes[0]!.accountId,
        contestId: mine.contest_id,
        participantId: mine.participant_id,
        athletes: [{ athleteId: athletes[1]!.athleteId }],
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_INPUT,
    );
    await rejects(
      structure.submitLineup({
        actorAccountId: athletes[0]!.accountId,
        contestId: mine.contest_id,
        participantId: other.participant_id,
        athletes: [{ athleteId: athletes[1]!.athleteId }],
        idempotencyKey: k(),
      }),
      DomainErrorCode.FORBIDDEN,
    );
    const l1 = await structure.submitLineup({
      actorAccountId: athletes[0]!.accountId,
      contestId: mine.contest_id,
      participantId: mine.participant_id,
      athletes: [{ athleteId: athletes[0]!.athleteId }],
      idempotencyKey: k(),
    });
    expect(l1.replaced).toBe(false);
    const l2 = await structure.submitLineup({
      actorAccountId: w.ownerAccountId,
      contestId: mine.contest_id,
      participantId: mine.participant_id,
      athletes: [{ athleteId: athletes[0]!.athleteId, role: 'PLAYER' }],
      idempotencyKey: k(),
    });
    expect(l2.replaced).toBe(true);
    expect(
      await count(
        `SELECT count(*) AS n FROM platform.audit_event WHERE action = 'lineup.replaced' AND target_id = '${mine.contest_id}'`,
      ),
    ).toBe(1);
  });
});

// ───────────────────────────── teams ─────────────────────────────

describe('teams: competition identities with temporal membership', () => {
  it('Team ≠ Organization; membership needs consent; TeamMembership ≠ Lineup; temporal ending', async () => {
    const manager = await newTestAccount(identity, { label: 'manager' });
    const own = await newAthlete(identity, 'own');
    const other = await newAthlete(identity, 'other');
    const { teamId } = await teams.createTeam({
      actorAccountId: manager.accountId,
      teamKind: 'EVENT_PAIR',
      displayName: 'Fictional Pair',
      idempotencyKey: k(),
    });
    expect(
      await count(`SELECT count(*) AS n FROM organizations.organization WHERE id = '${teamId}'`),
    ).toBe(0);
    // the manager does not control these athletes → PROPOSED, until the athlete side accepts
    const m1 = await teams.addMember({
      actorAccountId: manager.accountId,
      teamId,
      athleteId: own.athleteId,
      idempotencyKey: k(),
    });
    expect(m1.status).toBe('PROPOSED');
    await rejects(
      teams.respond({
        actorAccountId: manager.accountId,
        membershipId: m1.membershipId,
        accept: true,
      }),
      DomainErrorCode.FORBIDDEN,
    );
    await teams.respond({
      actorAccountId: own.accountId,
      membershipId: m1.membershipId,
      accept: true,
    });
    const m2 = await teams.addMember({
      actorAccountId: manager.accountId,
      teamId,
      athleteId: other.athleteId,
      idempotencyKey: k(),
    });
    await teams.respond({
      actorAccountId: other.accountId,
      membershipId: m2.membershipId,
      accept: true,
    });
    const before = new Date();
    expect(new Set(await teams.members(teamId))).toEqual(new Set([own.athleteId, other.athleteId]));
    const stranger = await newTestAccount(identity);
    await rejects(
      teams.addMember({
        actorAccountId: stranger.accountId,
        teamId,
        athleteId: own.athleteId,
        idempotencyKey: k(),
      }),
      DomainErrorCode.FORBIDDEN,
    );

    // Team participant in a padel doubles event: participant references the Team
    const w = await world({ activate: true });
    const { eventId } = await comps.createEvent({
      actorAccountId: w.ownerAccountId,
      competitionId: w.competitionId,
      slug: uniqueSlug('dbl'),
      disciplineVersionId: cat.padelDoubles,
      formatVersionId: cat.singleElimination,
      settings: { name: 'Doubles' },
      idempotencyKey: k(),
    });
    await comps.openRegistration({ actorAccountId: w.ownerAccountId, eventId });
    await rejects(
      comps.register({
        actorAccountId: own.accountId,
        eventId,
        athleteId: own.athleteId,
        eligibilityDeclared: true,
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_INPUT,
    ); // TEAM event
    await comps.register({
      actorAccountId: manager.accountId,
      eventId,
      teamId,
      eligibilityDeclared: true,
      idempotencyKey: k(),
    });
    // a second team containing an already-entered athlete is refused
    const { teamId: t2 } = await teams.createTeam({
      actorAccountId: own.accountId,
      teamKind: 'EVENT_PAIR',
      displayName: 'Other Pair',
      idempotencyKey: k(),
    });
    await teams.addMember({
      actorAccountId: own.accountId,
      teamId: t2,
      athleteId: own.athleteId,
      idempotencyKey: k(),
    });
    const third = await newAthlete(identity, 'third');
    const m3 = await teams.addMember({
      actorAccountId: own.accountId,
      teamId: t2,
      athleteId: third.athleteId,
      idempotencyKey: k(),
    });
    await teams.respond({
      actorAccountId: third.accountId,
      membershipId: m3.membershipId,
      accept: true,
    });
    await rejects(
      comps.register({
        actorAccountId: own.accountId,
        eventId,
        teamId: t2,
        eligibilityDeclared: true,
        idempotencyKey: k(),
      }),
      DomainErrorCode.ALREADY_EXISTS,
    );

    // ending a membership is prospective: history remains, the athlete was a member before
    await teams.endMembership({ actorAccountId: other.accountId, membershipId: m2.membershipId });
    expect(await teams.members(teamId)).toEqual([own.athleteId]);
    expect(new Set(await teams.members(teamId, before))).toEqual(
      new Set([own.athleteId, other.athleteId]),
    );
    const { rows } = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM competition.participant WHERE team_id = ${teamId}`.execute(
      owner,
    );
    expect(rows[0]?.n).toBe(0); // registration ≠ participant until the field locks
  });
});

// ───────────────────────────── read models ─────────────────────────────

describe('competition read models', () => {
  it('a full rebuild (maintenance login) reproduces the incremental projection exactly', async () => {
    await plannedEvent(4, 'SE');
    const before = await snapshotCompetitionReadModels(api);
    const r = await rebuildCompetitionReadModels(maintenance);
    expect(r.events).toBeGreaterThan(0);
    expect(await snapshotCompetitionReadModels(api)).toEqual(before);
  });

  it('public structure shows unresolved dependencies as dependencies (never names), and results NOT_AVAILABLE', async () => {
    const { w, ev } = await plannedEvent(4, 'SE');
    const rounds = await reader.structure(w.competitionSlug, ev.slug);
    expect(rounds?.map((r) => r.label)).toEqual(['Semifinal', 'Final']);
    const final = rounds?.[1]?.contests[0];
    expect(final?.slots.map((s) => s.kind)).toEqual(['WINNER_OF_CONTEST', 'WINNER_OF_CONTEST']);
    expect(final?.slots.every((s) => !('display' in s))).toBe(true);
    expect(final?.result).toEqual({ status: 'NOT_AVAILABLE', reason: 'SOURCE_NOT_IMPLEMENTED' });
    const event = await reader.eventBySlugs(w.competitionSlug, ev.slug);
    expect(event?.event.results.status).toBe('NOT_AVAILABLE');
    expect(event?.event.plan?.engine).toBe('single-elimination/1');
  });
});
