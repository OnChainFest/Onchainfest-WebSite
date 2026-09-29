import { randomBytes } from 'node:crypto';
import { staticParticipationChecker } from '@br/authority';
import { newId, type Uuid } from '@br/domain';
import {
  createDevelopmentPiiCipher,
  createTestWalletVerifier,
  eip155EoaPersonalSignVerifier,
} from '@br/identity';
import {
  AuthorityStore,
  authorizeInHierarchy,
  CompetitionHierarchyResolver,
  createDb,
  databaseUrls,
  inTransaction,
  ModuleRole,
  operatorDatabaseUrl,
  rebuildCompetitionReadModels,
  snapshotCompetitionReadModels,
} from '@br/persistence';
import { sql } from 'kysely';
import { createDevTokenAuth, mintDevToken } from '../auth';
import { buildServer } from '../server';

/**
 * BRT-05 acceptance walkthrough (31 steps) through the real /v1 surface (in-process inject), with
 * database-level proofs for authority, hierarchy, results and rebuilds. ALL DATA IS FICTIONAL.
 * Development only. No built-in secrets: the dev-auth secret is random per run; the vault key is
 * BR_VAULT_DEV_KEY if set, otherwise an explicitly requested ephemeral key.
 * Run: pnpm db:up && pnpm db:bootstrap && pnpm db:migrate && pnpm demo:competition
 */
const devAuthSecret = randomBytes(32).toString('hex');
const urls = databaseUrls();
const db = createDb(urls.api);
const vaultDb = createDb(urls.vault, { max: 2 });
// BRT-05R: the INTERNAL catalog routes run on the dedicated operator login (development default).
const operatorUrl = operatorDatabaseUrl();
if (operatorUrl === undefined) throw new Error('the demo needs an operator database URL');
const operatorDb = createDb(operatorUrl, { max: 2 });
const maintenanceDb = createDb(urls.maintenance, { max: 2 });
const app = buildServer({
  db,
  vaultDb,
  operatorDb,
  piiCipher: createDevelopmentPiiCipher(
    (process.env.BR_VAULT_DEV_KEY ?? '') !== '' ? {} : { ephemeral: true },
  ),
  auth: (identity) => createDevTokenAuth(identity, { secret: devAuthSecret }),
  walletVerifiers: [eip155EoaPersonalSignVerifier, createTestWalletVerifier()],
});
const noParticipation = staticParticipationChecker([], 'demo-declared-no-participation');
const authority = new AuthorityStore(db, { conflictChecker: noParticipation });
const resolver = new CompetitionHierarchyResolver(db);

const run = newId().replace(/-/g, '').slice(-8);
let step = 0;
const show = (title: string, detail: unknown) =>
  console.log(
    `\n▶ ${String(++step).padStart(2, '0')}. ${title}\n   ${typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2).replaceAll('\n', '\n   ')}`,
  );
const bearer = (s: string, operator = false) => ({
  authorization: `Bearer ${mintDevToken(`demo5-${run}-${s}`, { operator, secret: devAuthSecret })}`,
});
const idem = () => ({ 'idempotency-key': `demo5-${newId()}` });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form navigation of JSON responses
type Json = Record<string, any>;
async function call(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  headers: Record<string, string> = {},
  payload?: unknown,
) {
  const res = await app.inject({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return {
    status: res.statusCode,
    text: res.body,
    body: (res.body.length > 0 ? res.json() : null) as Json,
  };
}
async function ok(p: ReturnType<typeof call>, status = 200): Promise<Json> {
  const r = await p;
  if (r.status !== status) throw new Error(`expected HTTP ${status}, got ${r.status}: ${r.text}`);
  return r.body;
}

const SENTINEL = {
  legalName: `Demo Sentinel Legal ${run}`,
  email: `demo.sentinel.${run}@example.test`,
};

try {
  // 1
  show('Service health and readiness', {
    health: (await call('GET', '/health')).body,
    ready: (await call('GET', '/ready')).body,
  });

  // 2–6: operator-only catalog
  const op = bearer('operator', true);
  const sport = await ok(
    call(
      'POST',
      '/v1/internal/catalog/sports',
      { ...op, ...idem() },
      { code: `padel${run}`, name: 'Padel (demo)' },
    ),
    201,
  );
  const denied = await call(
    'POST',
    '/v1/internal/catalog/sports',
    { ...bearer('not-operator'), ...idem() },
    { code: `evil${run}`, name: 'Evil' },
  );
  show('Operator creates a Sport (catalog mutation is INTERNAL; others get 403)', {
    sport,
    nonOperator: denied.status,
  });
  const discipline = await ok(
    call(
      'POST',
      `/v1/internal/catalog/sports/${sport.sportId}/disciplines`,
      { ...op, ...idem() },
      { code: `padel${run}.doubles`, name: 'Padel doubles (demo)' },
    ),
    201,
  );
  show('Operator creates a Discipline in the sport namespace', discipline);
  const spec = {
    resultSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['setsWon', 'gamesWon'],
      properties: {
        setsWon: { type: 'integer', minimum: 0, maximum: 5 },
        gamesWon: { type: 'integer', minimum: 0, maximum: 99 },
      },
    },
    metrics: [
      { key: 'setsWon', valueType: 'INTEGER', unit: 'sets' },
      { key: 'gamesWon', valueType: 'INTEGER', unit: 'games' },
    ],
    comparator: {
      outcomeModel: 'WIN_LOSS_DRAW',
      primary: 'HEAD_TO_HEAD_WINNER',
      keys: [{ metric: 'setsWon', order: 'HIGHER_IS_BETTER' }],
    },
    validation: { bounds: [{ metric: 'setsWon', min: '0', max: '3' }] },
    allowedContestTypes: ['MATCH'],
    participation: { participantKinds: ['TEAM'], lineupSize: { min: 2, max: 2 } },
  };
  const dv = await ok(
    call(
      'POST',
      `/v1/internal/catalog/disciplines/${discipline.disciplineId}/versions`,
      { ...op, ...idem() },
      { spec },
    ),
    201,
  );
  await ok(
    call('POST', `/v1/internal/catalog/discipline-versions/${dv.disciplineVersionId}/publish`, op),
  );
  show('DisciplineVersion created (validated, immutable) and PUBLISHED', {
    version: dv.version,
    specHash: dv.specHash,
  });
  const ft = await ok(
    call(
      'POST',
      '/v1/internal/catalog/format-templates',
      { ...op, ...idem() },
      { code: `knockout-${run}`, name: 'Knockout (demo)' },
    ),
    201,
  );
  show('FormatTemplate created (structure ≠ sporting rules)', ft);
  const fv = await ok(
    call(
      'POST',
      `/v1/internal/catalog/format-templates/${ft.formatTemplateId}/versions`,
      { ...op, ...idem() },
      { engineId: 'single-elimination', engineVersion: 1 },
    ),
    201,
  );
  await ok(call('POST', `/v1/internal/catalog/format-versions/${fv.formatVersionId}/publish`, op));
  show('FormatVersion pins engine single-elimination/1 and is PUBLISHED', fv);

  // 7–8: organizer
  const orgH = bearer('organizer');
  await ok(call('POST', '/v1/persons', { ...orgH, ...idem() }, { relation: 'SELF' }), 201);
  const org = await ok(
    call(
      'POST',
      '/v1/organizations',
      { ...orgH, ...idem() },
      {
        orgType: 'FEDERATION',
        slug: `demo-fed-${run}`,
        profile: { displayName: 'Demo Fictional Federation' },
      },
    ),
    201,
  );
  const compSlug = `demo-padel-open-${run}`;
  const comp = await ok(
    call(
      'POST',
      '/v1/competitions',
      { ...orgH, ...idem() },
      {
        organizerOrganizationId: org.organizationId,
        slug: compSlug,
        profile: {
          name: 'Demo Fictional Padel Open',
          timezone: 'America/Costa_Rica',
          startsAt: '2027-04-01T00:00:00Z',
          endsAt: '2027-04-10T00:00:00Z',
        },
      },
    ),
    201,
  );
  show('Organization admin (a self-declared FEDERATION) creates a Competition', comp);
  const orgPrincipal = (
    await inTransaction(db, ModuleRole.organizations, (ctx) =>
      sql<{
        principal_id: Uuid;
      }>`SELECT principal_id FROM organizations.organization_principal WHERE organization_id = ${org.organizationId}`.execute(
        ctx.trx,
      ),
    )
  ).rows[0]!.principal_id;
  const orgAuthority = await inTransaction(db, ModuleRole.authority, async (ctx) => {
    const out: Record<string, boolean> = {};
    for (const cap of [
      'ACCEPT_RESULT',
      'DECLARE_OFFICIAL',
      'ATTEST_RESULT',
      'RATIFY_RECORD',
    ] as const) {
      out[cap] = (
        await authorizeInHierarchy(
          ctx,
          {
            principalId: orgPrincipal,
            capability: cap,
            target: { level: 'COMPETITION', id: comp.competitionId },
            recognitionLevel: 'PLATFORM',
            atTime: ctx.txTime,
            asOf: ctx.txTime,
          },
          noParticipation,
        )
      ).authorized;
    }
    return out;
  });
  show(
    'The organizer still holds NO sports authority (operational permissions ≠ capabilities)',
    orgAuthority,
  );

  // 9–11
  const eventSlug = 'open-doubles';
  const ev = await ok(
    call(
      'POST',
      `/v1/competitions/${comp.competitionId}/events`,
      { ...orgH, ...idem() },
      {
        slug: eventSlug,
        disciplineVersionId: dv.disciplineVersionId,
        formatVersionId: fv.formatVersionId,
        settings: { name: 'Open Doubles', capacity: 4, category: { genderCategory: 'OPEN' } },
      },
    ),
    201,
  );
  show('Event created, pinned to exact DisciplineVersion + FormatVersion (capacity 4 pairs)', ev);
  await ok(call('POST', `/v1/competitions/${comp.competitionId}/publish`, orgH));
  show('Competition PUBLISHED', {
    status: (await ok(call('GET', `/v1/competitions/${compSlug}`))).competition.status,
  });
  await ok(call('POST', `/v1/events/${ev.eventId}/open-registration`, orgH));
  show('Registration OPEN', {
    status: (await ok(call('GET', `/v1/competitions/${compSlug}/events/${eventSlug}`))).event
      .status,
  });

  // 12–13: pairs (Team = competition identity; TeamMembership needs consent)
  const players: { h: Record<string, string>; personId: string; athleteId: string }[] = [];
  const player = async (i: number) => {
    const h = bearer(`player-${i}`);
    const p = await ok(call('POST', '/v1/persons', { ...h, ...idem() }, { relation: 'SELF' }), 201);
    const a = await ok(
      call(
        'POST',
        '/v1/athletes',
        { ...h, ...idem() },
        {
          personId: p.personId,
          slug: `demo5-${run}-p${i}`,
          profile: { displayName: `Demo Player ${i}` },
        },
      ),
      201,
    );
    return { h, personId: p.personId as string, athleteId: a.athleteId as string };
  };
  const registrations: Json[] = [];
  const teamsCreated: { teamId: string; name: string; members: string[] }[] = [];
  for (let pair = 0; pair < 5; pair++) {
    const a = await player(pair * 2 + 1);
    const b = await player(pair * 2 + 2);
    players.push(a, b);
    const team = await ok(
      call(
        'POST',
        '/v1/teams',
        { ...a.h, ...idem() },
        { teamKind: 'EVENT_PAIR', displayName: `Demo Pair ${pair + 1}` },
      ),
      201,
    );
    await ok(
      call(
        'POST',
        `/v1/teams/${team.teamId}/members`,
        { ...a.h, ...idem() },
        { athleteId: a.athleteId },
      ),
      201,
    );
    const m = await ok(
      call(
        'POST',
        `/v1/teams/${team.teamId}/members`,
        { ...a.h, ...idem() },
        { athleteId: b.athleteId },
      ),
      201,
    );
    await ok(call('POST', `/v1/team-memberships/${m.membershipId}/accept`, b.h));
    teamsCreated.push({
      teamId: team.teamId,
      name: `Demo Pair ${pair + 1}`,
      members: [a.athleteId, b.athleteId],
    });
    registrations.push(
      await ok(
        call(
          'POST',
          `/v1/events/${ev.eventId}/registrations`,
          { ...a.h, ...idem() },
          { teamId: team.teamId, eligibilityDeclared: true },
        ),
        201,
      ),
    );
  }
  show(
    'Five pairs register (Team ≠ Organization; partners accepted membership)',
    registrations.slice(0, 4).map((r) => r.status),
  );
  show('Capacity 4: the fifth pair is WAITLISTED (never over capacity)', {
    fifth: registrations[4]?.status,
  });

  // 14–16
  await ok(call('POST', `/v1/events/${ev.eventId}/close-registration`, orgH));
  show('Registration CLOSED', 'no new entries accepted');
  const field = await ok(
    call('POST', `/v1/events/${ev.eventId}/lock-field`, { ...orgH, ...idem() }),
  );
  show('Field LOCKED (canonical participant set hashed)', field);
  const participants = await ok(
    call('GET', `/v1/competitions/${compSlug}/events/${eventSlug}/participants`),
  );
  show(
    'Participants materialized from CONFIRMED registrations only (event-scoped identities)',
    participants.items.map((p: Json) => ({ participantId: p.participantId, display: p.display })),
  );

  // 17–20
  const seeding = await ok(
    call(
      'POST',
      `/v1/events/${ev.eventId}/seed`,
      { ...orgH, ...idem() },
      { method: 'DETERMINISTIC_DRAW' },
    ),
  );
  show(
    'Field seeded by deterministic draw (seed persisted → reproducible; not a provably fair draw)',
    { drawSeed: seeding.drawSeed, seedingHash: seeding.seedingHash },
  );
  const planKey = idem();
  const plan = await ok(
    call('POST', `/v1/events/${ev.eventId}/generate-plan`, { ...orgH, ...planKey }),
  );
  const replay = await ok(
    call('POST', `/v1/events/${ev.eventId}/generate-plan`, { ...orgH, ...idem() }),
  );
  show('Deterministic plan generated; a second request returns the same immutable plan', {
    plan,
    replayCreated: replay.created,
    sameHash: replay.planHash === plan.planHash,
  });
  const bracket = await ok(call('GET', `/v1/competitions/${compSlug}/events/${eventSlug}/bracket`));
  show(
    'Rounds and contests',
    bracket.rounds.map((r: Json) => ({
      round: r.label,
      contests: r.contests.map((c: Json) => `#${c.sequence} ${c.contestType}`),
    })),
  );
  const final = bracket.rounds[bracket.rounds.length - 1].contests[0];
  show('The final is unresolved: WINNER_OF dependencies, no fabricated finalists', final.slots);

  // 21–22
  const semi = bracket.rounds[0].contests[0];
  await ok(
    call(
      'POST',
      `/v1/contests/${semi.contestId}/schedule`,
      { ...orgH, ...idem() },
      {
        scheduledStart: '2027-04-05T10:00:00-06:00',
        courtLabel: 'Court 1',
        locationLabel: 'Fictional Padel Centre',
      },
    ),
  );
  show(
    'A semifinal is scheduled (UTC storage; IANA timezone for display)',
    (await ok(call('GET', `/v1/competitions/${compSlug}/events/${eventSlug}/schedule`))).items[0],
  );
  const slot = semi.slots[0];
  const team =
    teamsCreated.find((t) => t.name === slot.display.teamName) ??
    (() => {
      throw new Error('semifinal slot does not hold a known pair');
    })();
  const manager = players.find((p) => p.athleteId === team.members[0])!;
  const invalid = await call(
    'POST',
    `/v1/contests/${semi.contestId}/lineups`,
    { ...manager.h, ...idem() },
    {
      participantId: slot.participantId,
      athletes: [{ athleteId: players[9]!.athleteId }, { athleteId: team.members[0] }],
    },
  );
  const lineup = await call(
    'POST',
    `/v1/contests/${semi.contestId}/lineups`,
    { ...manager.h, ...idem() },
    {
      participantId: slot.participantId,
      athletes: team.members.map((athleteId) => ({ athleteId })),
    },
  );
  show(
    'Lineup: a non-member is refused; the pair fields its two active members (Lineup ≠ TeamMembership)',
    { invalid: invalid.body?.error?.code ?? invalid.status, valid: lineup.status },
  );

  // 23–25
  const page = await ok(call('GET', `/v1/competitions/${compSlug}`));
  show('Public Competition page DTO', {
    name: page.competition.name,
    status: page.competition.status,
    organizer: page.competition.organizer.displayName,
    events: page.events.map((e: Json) => e.name),
    authority: page.authority,
  });
  show(
    'Public participant list (display names from public Passport cards / team names only)',
    participants.items.map((p: Json) => p.display),
  );
  show('Public bracket and schedule', {
    rounds: bracket.rounds.length,
    scheduled: (
      await ok(call('GET', `/v1/competitions/${compSlug}/events/${eventSlug}/schedule`))
    ).items.filter((c: Json) => c.scheduledStart !== null).length,
    results: bracket.results,
  });

  // 26–28: hierarchy + authority
  const path = await resolver.resolve('CONTEST', semi.contestId);
  show(
    'Hierarchy resolver: Contest → Round → Event → Competition (+ sport/discipline codes)',
    path,
  );
  const platform = await authority.registerPrincipal({
    principalType: 'PLATFORM',
    label: 'platform (competition demo)',
  });
  await authority.recognizeTrustAnchor({
    principalId: platform.id,
    recognitionScope: { recognitionLevel: ['PLATFORM'] },
    basisRef: 'demo',
    governanceDecisionRef: `demo-${run}`,
  });
  const referee = await authority.registerPrincipal({
    principalType: 'PERSON',
    label: 'fictional referee',
  });
  await authority.issueGrant({
    actorPrincipalId: platform.id,
    grantorPrincipalId: platform.id,
    granteePrincipalId: referee.id,
    capabilities: ['ACCEPT_RESULT'],
    scope: { recognitionLevel: ['PLATFORM'], competition: [comp.competitionId as Uuid] },
    delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
  });
  const covers = (level: 'CONTEST' | 'COMPETITION', id: string) =>
    inTransaction(
      db,
      ModuleRole.authority,
      async (ctx) =>
        (
          await authorizeInHierarchy(
            ctx,
            {
              principalId: referee.id,
              capability: 'ACCEPT_RESULT',
              target: { level, id },
              recognitionLevel: 'PLATFORM',
              atTime: ctx.txTime,
              asOf: ctx.txTime,
            },
            noParticipation,
          )
        ).authorized,
    );
  show('A real AuthorityGrant scoped to this Competition covers its descendant Contest', {
    contest: await covers('CONTEST', semi.contestId),
  });
  const sibling = await ok(
    call(
      'POST',
      '/v1/competitions',
      { ...orgH, ...idem() },
      {
        organizerOrganizationId: org.organizationId,
        slug: `demo-sibling-${run}`,
        profile: { name: 'Sibling Cup', timezone: 'UTC' },
      },
    ),
    201,
  );
  show('…and does NOT cover a sibling Competition of the same organizer', {
    sibling: await covers('COMPETITION', sibling.competitionId),
  });

  // 29
  const results = await inTransaction(
    db,
    ModuleRole.results,
    async (ctx) =>
      (
        await sql<{
          n: number;
        }>`SELECT count(*)::int AS n FROM results.result WHERE scope_target_id IN (SELECT unnest(${bracket.rounds.flatMap((r: Json) => r.contests.map((c: Json) => c.contestId))}::uuid[]))`.execute(
          ctx.trx,
        )
      ).rows[0]?.n,
  );
  show('Event operations created no Result (let alone a verified one)', {
    resultsForContests: results,
    contestResultField: final.result,
  });

  // 30
  const before = await snapshotCompetitionReadModels(db);
  const rebuilt = await rebuildCompetitionReadModels(maintenanceDb);
  const after = await snapshotCompetitionReadModels(db);
  show('Read models rebuilt by the maintenance login; output identical', {
    ...rebuilt,
    identical: JSON.stringify(before) === JSON.stringify(after),
  });

  // 31
  const p1 = players[0]!;
  await ok(call('PUT', `/v1/persons/${p1.personId}/private`, p1.h, SENTINEL));
  const publicText = [
    (await call('GET', `/v1/competitions/${compSlug}`)).text,
    (await call('GET', `/v1/competitions/${compSlug}/events/${eventSlug}`)).text,
    (await call('GET', `/v1/competitions/${compSlug}/events/${eventSlug}/participants`)).text,
    (await call('GET', `/v1/competitions/${compSlug}/events/${eventSlug}/bracket`)).text,
  ].join('\n');
  const outbox = await inTransaction(db, ModuleRole.competition, async (ctx) =>
    JSON.stringify((await sql`SELECT payload FROM platform.outbox_event`.execute(ctx.trx)).rows),
  );
  const leaks = Object.values(SENTINEL).filter((v) => publicText.includes(v) || outbox.includes(v));
  show('No PII in public competition DTOs or outbox payloads', {
    sentinelValuesFound: leaks.length,
  });

  if (step !== 31) throw new Error(`demo expected 31 steps, ran ${step}`);
  if (
    Object.values(orgAuthority).some(Boolean) ||
    leaks.length > 0 ||
    results !== 0 ||
    replay.planHash !== plan.planHash ||
    JSON.stringify(before) !== JSON.stringify(after)
  ) {
    throw new Error('demo invariant violated');
  }
  console.log('\n✔ BRT-05 demo completed: 31/31 steps.');
} finally {
  await app.close();
  await Promise.all([
    db.destroy(),
    vaultDb.destroy(),
    maintenanceDb.destroy(),
    operatorDb.destroy(),
  ]);
}
