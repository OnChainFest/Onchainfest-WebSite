import {
  CANONICAL_CATALOG,
  type CatalogManifest,
  type DisciplineVersionSpec,
} from '@br/competition';
import { DomainError, DomainErrorCode } from '@br/domain';
import { CatalogStore } from '../catalog-store';
import { CompetitionStore } from '../competition-store';
import { StructureStore } from '../competition-structure-store';
import { databaseUrls, operatorDatabaseUrl } from '../config';
import { createDb } from '../db';
import { IdentityStore } from '../identity-store';
import { OrganizationStore } from '../organization-store';
import { TeamStore } from '../team-store';

/**
 * BRT-05 development seed. ALL DATA IS FICTIONAL; no federation, venue or athlete is real.
 * Idempotent: fixed provider subjects, codes, slugs and idempotency keys; lifecycle commands that
 * already happened are tolerated. Demonstrates two structurally different sports:
 *   A. Fictional Padel Open — padel doubles (TEAM pairs), single elimination, 4 pairs.
 *   B. Fictional Club League — tennis singles (INDIVIDUAL), round robin, 5 players.
 * A running 5K discipline (HEAT contests) is published in the catalog only: BRT-05 has no heat
 * format engine, so no running event is faked.
 * Run: pnpm db:seed:competition
 */
if (process.env.NODE_ENV === 'production') throw new Error('development seed refuses production');

const db = createDb(databaseUrls().api);
const identity = new IdentityStore(db);
const orgs = new OrganizationStore(db);
// BRT-05R: catalog writes use the dedicated operator login (br_operator_app → br_catalog only).
const operatorUrl = operatorDatabaseUrl();
if (operatorUrl === undefined)
  throw new Error('catalog seeding needs BR_OPERATOR_DATABASE_URL (operator login)');
const operatorDb = createDb(operatorUrl, { max: 2 });
const catalog = new CatalogStore(operatorDb);
const comps = new CompetitionStore(db);
const structure = new StructureStore(db);
const teams = new TeamStore(db);

const tolerate = async <T>(fn: () => Promise<T>, ...codes: string[]): Promise<T | undefined> => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DomainError && codes.includes(err.code)) return undefined;
    throw err;
  }
};
const T = DomainErrorCode.INVALID_TRANSITION;

async function account(name: string) {
  const { accountId } = await identity.signIn({
    provider: 'test',
    providerSubject: `seed:${name}`,
    method: 'TEST',
  });
  const { personId } = await identity.createPerson({
    actorAccountId: accountId,
    relation: 'SELF',
    idempotencyKey: `seed:self:${name}`,
  });
  return { accountId, personId };
}

async function athlete(name: string, displayName: string) {
  const a = await account(name);
  const { athleteId } = await identity.createAthlete({
    actorAccountId: a.accountId,
    personId: a.personId,
    slug: `seed-${name}`,
    profile: { displayName, preferredSports: [] },
    idempotencyKey: `seed:athlete:${name}`,
  });
  return { ...a, athleteId };
}

const RUNNING: DisciplineVersionSpec = {
  resultSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['elapsedTimeMs'],
    properties: { elapsedTimeMs: { type: 'integer', minimum: 0 } },
  },
  metrics: [{ key: 'elapsedTimeMs', valueType: 'DURATION_MS', unit: 'ms' }],
  comparator: {
    outcomeModel: 'RANKED',
    primary: 'METRICS',
    keys: [{ metric: 'elapsedTimeMs', order: 'LOWER_IS_BETTER' }],
  },
  validation: { bounds: [{ metric: 'elapsedTimeMs', min: '600000' }] },
  allowedContestTypes: ['HEAT'],
  participation: { participantKinds: ['INDIVIDUAL'], lineupSize: { min: 1, max: 1 } },
};

try {
  // ── catalog (operator) ──
  const { accountId: op } = await identity.signIn({
    provider: 'test',
    providerSubject: 'seed:operator',
    method: 'TEST',
  });
  // ONCF-03A: the same lookup-first provisioner production uses, plus a dev-only running 5K
  // (HEAT contests have no format engine yet, so it is not in the canonical catalog).
  // ONCF-05B: running is canonical now (road / track / relay); the dev-only 5K stays an extra
  // discipline of the same sport (distance as a discipline code is the pre-ONCF-05B shape).
  const DEV_CATALOG: CatalogManifest = {
    sports: CANONICAL_CATALOG.sports.map((s) =>
      s.code === 'running'
        ? {
            ...s,
            disciplines: [
              ...s.disciplines,
              { code: 'running.5k', name: 'Running 5K', specs: [RUNNING] },
            ],
          }
        : s,
    ),
    formats: CANONICAL_CATALOG.formats,
  };
  const provisioned = await catalog.provision({ operatorAccountId: op, manifest: DEV_CATALOG });
  if (provisioned.conflicts.length > 0)
    throw new Error(`catalog conflicts: ${JSON.stringify(provisioned.conflicts)}`);
  const idOf = (kind: 'discipline-version' | 'format-version', code: string): string => {
    const id = provisioned.steps.find((s) => s.kind === kind && s.code === code)?.id;
    if (id === undefined) throw new Error(`catalog entry ${code} missing`);
    return id;
  };
  const padelDv = idOf('discipline-version', 'padel.doubles');
  const tennisDv = idOf('discipline-version', 'tennis.singles');
  const se = idOf('format-version', 'single-elimination');
  const rr = idOf('format-version', 'round-robin');

  // ── organizer ──
  const organizer = await account('comp-organizer');
  const { organizationId } = await orgs.createOrganization({
    actorAccountId: organizer.accountId,
    orgType: 'CLUB',
    slug: 'club-competiciones-ficticio',
    profile: {
      displayName: 'Club de Competiciones Ficticio',
      description: 'A fictional organizer for development.',
    },
    idempotencyKey: 'seed:org:competitions',
  });
  const org = organizer.accountId;

  // ── A. Fictional Padel Open: 4 pairs, single elimination ──
  const open = await comps.createCompetition({
    actorAccountId: org,
    organizerOrganizationId: organizationId,
    slug: 'fictional-padel-open',
    profile: {
      name: 'Fictional Padel Open',
      description: 'Fictional development competition.',
      locationLabel: 'Fictional Padel Centre',
      timezone: 'America/Costa_Rica',
      startsAt: '2027-03-01T00:00:00Z',
      endsAt: '2027-03-08T00:00:00Z',
    },
    idempotencyKey: 'seed:comp:padel-open',
  });
  await tolerate(
    () => comps.publishCompetition({ actorAccountId: org, competitionId: open.competitionId }),
    T,
  );
  const doubles = await comps.createEvent({
    actorAccountId: org,
    competitionId: open.competitionId,
    slug: 'open-doubles',
    disciplineVersionId: padelDv,
    formatVersionId: se,
    settings: { name: 'Open Doubles', capacity: 8, category: { genderCategory: 'OPEN' } },
    idempotencyKey: 'seed:event:open-doubles',
  });
  await tolerate(
    () => comps.openRegistration({ actorAccountId: org, eventId: doubles.eventId }),
    T,
  );
  const pairNames = [
    ['Ana', 'Beatriz'],
    ['Carla', 'Daniela'],
    ['Elena', 'Fernanda'],
    ['Gabriela', 'Helena'],
  ];
  for (const [i, [a, b]] of pairNames.entries()) {
    const p1 = await athlete(`padel-${i + 1}a`, `${a} Ficticia`);
    const p2 = await athlete(`padel-${i + 1}b`, `${b} Ficticia`);
    const { teamId } = await teams.createTeam({
      actorAccountId: p1.accountId,
      teamKind: 'EVENT_PAIR',
      displayName: `${a} & ${b}`,
      idempotencyKey: `seed:team:${i + 1}`,
    });
    await teams.addMember({
      actorAccountId: p1.accountId,
      teamId,
      athleteId: p1.athleteId,
      idempotencyKey: `seed:team:${i + 1}:a`,
    });
    const m = await teams.addMember({
      actorAccountId: p1.accountId,
      teamId,
      athleteId: p2.athleteId,
      idempotencyKey: `seed:team:${i + 1}:b`,
    });
    await tolerate(
      () =>
        teams.respond({ actorAccountId: p2.accountId, membershipId: m.membershipId, accept: true }),
      T,
    );
    await tolerate(
      () =>
        comps.register({
          actorAccountId: p1.accountId,
          eventId: doubles.eventId,
          teamId,
          eligibilityDeclared: true,
          idempotencyKey: `seed:reg:pair:${i + 1}`,
        }),
      T,
    );
  }
  await tolerate(
    () => comps.closeRegistration({ actorAccountId: org, eventId: doubles.eventId }),
    T,
  );
  await structure.lockField({
    actorAccountId: org,
    eventId: doubles.eventId,
    idempotencyKey: 'seed:lock:open-doubles',
  });
  await structure.seedField({
    actorAccountId: org,
    eventId: doubles.eventId,
    method: 'DETERMINISTIC_DRAW',
    idempotencyKey: 'seed:seed:open-doubles',
  });
  const openPlan = await structure.generatePlan({
    actorAccountId: org,
    eventId: doubles.eventId,
    idempotencyKey: 'seed:plan:open-doubles',
  });

  // ── B. Fictional Club League: 5 players, round robin ──
  const league = await comps.createCompetition({
    actorAccountId: org,
    organizerOrganizationId: organizationId,
    slug: 'fictional-club-league',
    profile: {
      name: 'Fictional Club League',
      description: 'Fictional development league.',
      timezone: 'Europe/Madrid',
    },
    idempotencyKey: 'seed:comp:club-league',
  });
  await tolerate(
    () => comps.publishCompetition({ actorAccountId: org, competitionId: league.competitionId }),
    T,
  );
  const singles = await comps.createEvent({
    actorAccountId: org,
    competitionId: league.competitionId,
    slug: 'league-singles',
    disciplineVersionId: tennisDv,
    formatVersionId: rr,
    settings: { name: 'League Singles', category: { skillClass: 'Club' } },
    idempotencyKey: 'seed:event:league-singles',
  });
  await tolerate(
    () => comps.openRegistration({ actorAccountId: org, eventId: singles.eventId }),
    T,
  );
  for (const [i, name] of ['Irene', 'Julia', 'Karen', 'Laura', 'Marta'].entries()) {
    const p = await athlete(`league-${i + 1}`, `${name} Ejemplo`);
    await tolerate(
      () =>
        comps.register({
          actorAccountId: p.accountId,
          eventId: singles.eventId,
          athleteId: p.athleteId,
          eligibilityDeclared: true,
          idempotencyKey: `seed:reg:league:${i + 1}`,
        }),
      T,
    );
  }
  await tolerate(
    () => comps.closeRegistration({ actorAccountId: org, eventId: singles.eventId }),
    T,
  );
  await structure.lockField({
    actorAccountId: org,
    eventId: singles.eventId,
    idempotencyKey: 'seed:lock:league-singles',
  });
  await structure.seedField({
    actorAccountId: org,
    eventId: singles.eventId,
    method: 'DETERMINISTIC_DRAW',
    idempotencyKey: 'seed:seed:league-singles',
  });
  const leaguePlan = await structure.generatePlan({
    actorAccountId: org,
    eventId: singles.eventId,
    idempotencyKey: 'seed:plan:league-singles',
  });

  console.log(
    JSON.stringify(
      {
        fictionalDataOnly: true,
        catalog: {
          disciplines: [
            'padel.doubles@1',
            'tennis.singles@1',
            'tennis.doubles@1',
            'running.5k@1 (catalog only: no heat format yet)',
          ],
          formats: ['single-elimination/1', 'round-robin/1'],
        },
        competitions: {
          'fictional-padel-open': {
            event: 'open-doubles',
            engine: openPlan.engine,
            contests: openPlan.contests,
            planHash: openPlan.planHash,
          },
          'fictional-club-league': {
            event: 'league-singles',
            engine: leaguePlan.engine,
            contests: leaguePlan.contests,
            planHash: leaguePlan.planHash,
          },
        },
        pages: [
          '/competitions/fictional-padel-open',
          '/competitions/fictional-padel-open/events/open-doubles',
          '/competitions/fictional-club-league/events/league-singles',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.all([db.destroy(), operatorDb.destroy()]);
}
