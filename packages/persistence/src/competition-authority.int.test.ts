import { pathToScope } from '@br/competition';
import {
  DomainErrorCode,
  newId,
  type AuthorityScope,
  type Capability,
  type Uuid,
} from '@br/domain';
import {
  apiDb,
  operatorDb,
  declaredNoParticipation,
  newAthlete,
  newOrganizer,
  newTestAccount,
  ownerDb,
  seedTestCatalog,
  uniqueSlug,
  type TestCatalog,
} from '@br/testkit';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthorityStore } from './authority-store';
import { CatalogStore } from './catalog-store';
import {
  authorizeInHierarchy,
  CompetitionHierarchyResolver,
  competitionResultScopeValidator,
  createCompetitionResultLedger,
  resolveHierarchy,
} from './competition-hierarchy';
import { CompetitionStore } from './competition-store';
import { StructureStore } from './competition-structure-store';
import { IdentityStore } from './identity-store';
import { OrganizationStore } from './organization-store';
import { ResultLedger } from './result-ledger';
import { inTransaction, ModuleRole } from './tx';

const api = apiDb();
const owner = ownerDb();
afterAll(async () => {
  await Promise.all([api, owner, operator].map((d) => d.destroy()));
});

const identity = new IdentityStore(api);
const orgs = new OrganizationStore(api);
const operator = operatorDb();
const catalog = new CatalogStore(operator); // BRT-05R: catalog writes use the operator login
const comps = new CompetitionStore(api);
const structure = new StructureStore(api);
const authority = new AuthorityStore(api, { conflictChecker: declaredNoParticipation });
const resolver = new CompetitionHierarchyResolver(api);
const k = () => `k-${newId()}`;
let cat: TestCatalog;

/** C1 { E1 { A, B }, E2 { C } }, C2 { E3 { D } } — built through the real commands. */
interface Tree {
  C1: string;
  C2: string;
  E1: string;
  E2: string;
  E3: string;
  A: string;
  B: string;
  C: string;
  D: string;
  organizer: Awaited<ReturnType<typeof newOrganizer>>;
}
let t: Tree;
let platformId: Uuid;

async function competition(org: Awaited<ReturnType<typeof newOrganizer>>) {
  const { competitionId } = await comps.createCompetition({
    actorAccountId: org.ownerAccountId,
    organizerOrganizationId: org.organizationId,
    slug: uniqueSlug('auth'),
    profile: { name: 'Authority Test Open', timezone: 'UTC' },
    idempotencyKey: k(),
  });
  await comps.publishCompetition({ actorAccountId: org.ownerAccountId, competitionId });
  return competitionId;
}

async function eventWithContests(
  org: Awaited<ReturnType<typeof newOrganizer>>,
  competitionId: string,
  entrants: number,
): Promise<{ eventId: string; contests: string[] }> {
  const { eventId } = await comps.createEvent({
    actorAccountId: org.ownerAccountId,
    competitionId,
    slug: uniqueSlug('ev'),
    disciplineVersionId: cat.tennisSingles,
    formatVersionId: cat.singleElimination,
    settings: { name: 'Singles' },
    idempotencyKey: k(),
  });
  await comps.openRegistration({ actorAccountId: org.ownerAccountId, eventId });
  for (let i = 0; i < entrants; i++) {
    const a = await newAthlete(identity);
    await comps.register({
      actorAccountId: a.accountId,
      eventId,
      athleteId: a.athleteId,
      eligibilityDeclared: true,
      idempotencyKey: k(),
    });
  }
  await comps.closeRegistration({ actorAccountId: org.ownerAccountId, eventId });
  await structure.lockField({ actorAccountId: org.ownerAccountId, eventId, idempotencyKey: k() });
  await structure.seedField({
    actorAccountId: org.ownerAccountId,
    eventId,
    method: 'DETERMINISTIC_DRAW',
    idempotencyKey: k(),
  });
  await structure.generatePlan({
    actorAccountId: org.ownerAccountId,
    eventId,
    idempotencyKey: k(),
  });
  const { rows } = await sql<{
    id: string;
  }>`SELECT id FROM competition.contest WHERE event_id = ${eventId} ORDER BY sequence`.execute(
    owner,
  );
  return { eventId, contests: rows.map((r) => r.id) };
}

beforeAll(async () => {
  cat = await seedTestCatalog(identity, catalog);
  const organizer = await newOrganizer(identity, orgs);
  const C1 = await competition(organizer);
  const C2 = await competition(organizer); // same organizer: grants still must not leak across competitions
  const e1 = await eventWithContests(organizer, C1, 3); // 2 contests
  const e2 = await eventWithContests(organizer, C1, 2); // 1 contest
  const e3 = await eventWithContests(organizer, C2, 2); // 1 contest
  t = {
    C1,
    C2,
    E1: e1.eventId,
    E2: e2.eventId,
    E3: e3.eventId,
    A: e1.contests[0]!,
    B: e1.contests[1]!,
    C: e2.contests[0]!,
    D: e3.contests[0]!,
    organizer,
  };
  const platform = await authority.registerPrincipal({
    principalType: 'PLATFORM',
    label: 'platform (hierarchy test)',
  });
  await authority.recognizeTrustAnchor({
    principalId: platform.id,
    recognitionScope: { recognitionLevel: ['PLATFORM'] },
    basisRef: 'test',
    governanceDecisionRef: `test-${newId()}`,
  });
  platformId = platform.id;
}, 180_000);

async function grantee(
  scope: AuthorityScope,
  capabilities: Capability[] = ['ACCEPT_RESULT', 'SUBMIT_RESULT'],
): Promise<Uuid> {
  const p = await authority.registerPrincipal({
    principalType: 'PERSON',
    label: 'referee (fictional)',
  });
  await authority.issueGrant({
    actorPrincipalId: platformId,
    grantorPrincipalId: platformId,
    granteePrincipalId: p.id,
    capabilities,
    scope: { recognitionLevel: ['PLATFORM'], ...scope },
    delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
  });
  return p.id;
}

const covers = (
  principalId: Uuid,
  level: 'COMPETITION' | 'EVENT' | 'CONTEST',
  id: string,
  capability: Capability = 'ACCEPT_RESULT',
) =>
  inTransaction(api, ModuleRole.authority, async (ctx) => {
    const now = ctx.txTime;
    const d = await authorizeInHierarchy(
      ctx,
      {
        principalId,
        capability,
        target: { level, id },
        recognitionLevel: 'PLATFORM',
        atTime: now,
        asOf: now,
      },
      declaredNoParticipation,
    );
    return d.authorized;
  });

describe('hierarchy resolver', () => {
  it('resolves full, deterministic paths from relationships', async () => {
    const a = await resolver.resolve('CONTEST', t.A);
    expect(a).toMatchObject({
      level: 'CONTEST',
      competitionId: t.C1,
      eventId: t.E1,
      contestId: t.A,
    });
    expect(a?.roundId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a?.sport).toMatch(/^tennis/);
    expect(a?.discipline).toMatch(/^tennis[0-9a-f]+\.singles$/);
    expect(await resolver.resolve('CONTEST', t.A)).toEqual(a);
    expect(await resolver.resolve('EVENT', t.E1)).toEqual({
      level: 'EVENT',
      competitionId: t.C1,
      eventId: t.E1,
      sport: a?.sport,
      discipline: a?.discipline,
    });
    expect(await resolver.resolve('COMPETITION', t.C2)).toEqual({
      level: 'COMPETITION',
      competitionId: t.C2,
    });
  });

  it('unknown, malformed or mis-kinded ids fail closed', async () => {
    expect(await resolver.resolve('CONTEST', newId())).toBeUndefined();
    expect(await resolver.resolve('CONTEST', "x' OR 1=1 --")).toBeUndefined();
    expect(await resolver.resolve('EVENT', t.A)).toBeUndefined(); // a contest id is not an event
    const p = await grantee({ competition: [t.C1 as Uuid] });
    await expect(covers(p, 'CONTEST', newId())).rejects.toMatchObject({
      code: DomainErrorCode.NOT_FOUND,
    });
  });

  it('cancelling an event does not change historical ancestry', async () => {
    const before = await resolver.resolve('CONTEST', t.C);
    const org = t.organizer;
    const extra = await eventWithContests(org, t.C1, 2);
    await comps.cancelEvent({
      actorAccountId: org.ownerAccountId,
      eventId: extra.eventId,
      reason: 'test',
    });
    expect((await resolver.resolve('CONTEST', extra.contests[0]!))?.eventId).toBe(extra.eventId);
    expect(await resolver.resolve('CONTEST', t.C)).toEqual(before);
  });
});

describe('authority scope over the hierarchy (real grants, exact BRT-03 semantics)', () => {
  it('competition grant C1 covers A, B, C and nothing in sibling competition C2', async () => {
    const p = await grantee({ competition: [t.C1 as Uuid] });
    expect(await covers(p, 'CONTEST', t.A)).toBe(true);
    expect(await covers(p, 'CONTEST', t.B)).toBe(true);
    expect(await covers(p, 'CONTEST', t.C)).toBe(true);
    expect(await covers(p, 'EVENT', t.E2)).toBe(true);
    expect(await covers(p, 'CONTEST', t.D)).toBe(false);
    expect(await covers(p, 'EVENT', t.E3)).toBe(false);
    expect(await covers(p, 'COMPETITION', t.C2)).toBe(false);
  });

  it('event grant E1 covers A and B, not C (sibling event)', async () => {
    const p = await grantee({ competition: [t.C1 as Uuid], event: [t.E1 as Uuid] });
    expect(await covers(p, 'CONTEST', t.A)).toBe(true);
    expect(await covers(p, 'CONTEST', t.B)).toBe(true);
    expect(await covers(p, 'CONTEST', t.C)).toBe(false);
    expect(await covers(p, 'COMPETITION', t.C1)).toBe(false); // narrower grant never covers its ancestor
  });

  it('contest grant A covers A only', async () => {
    const p = await grantee({
      competition: [t.C1 as Uuid],
      event: [t.E1 as Uuid],
      contest: [t.A as Uuid],
    });
    expect(await covers(p, 'CONTEST', t.A)).toBe(true);
    expect(await covers(p, 'CONTEST', t.B)).toBe(false);
  });

  it('sport / discipline scoping uses catalog codes from the pinned version', async () => {
    const path = (await resolver.resolve('CONTEST', t.D))!;
    const bySport = await grantee({ sport: [path.sport!] });
    expect(await covers(bySport, 'CONTEST', t.D)).toBe(true);
    expect(await covers(bySport, 'COMPETITION', t.C2)).toBe(false); // competition-level requests carry no sport
    const otherSport = await grantee({ sport: ['padel'] });
    expect(await covers(otherSport, 'CONTEST', t.D)).toBe(false);
    const byDiscipline = await grantee({
      discipline: [`${path.sport}.*`],
      competition: [t.C2 as Uuid],
    });
    expect(await covers(byDiscipline, 'CONTEST', t.D)).toBe(true);
    expect(await covers(byDiscipline, 'CONTEST', t.A)).toBe(false);
  });
});

describe('operational permissions never become sports authority', () => {
  it('competition operations create no grants or anchors; the organizer principal holds no capability', async () => {
    const counts = async () =>
      (
        await sql<{
          g: number;
          a: number;
        }>`SELECT (SELECT count(*) FROM authority.authority_grant)::int AS g, (SELECT count(*) FROM authority.trust_anchor)::int AS a`.execute(
          owner,
        )
      ).rows[0];
    const before = await counts();
    const org = await newOrganizer(identity, orgs);
    const C = await competition(org);
    const e = await eventWithContests(org, C, 2);
    const staff = await newTestAccount(identity);
    await comps.assignStaff({
      actorAccountId: org.ownerAccountId,
      competitionId: C,
      personId: staff.personId as string,
      role: 'ADMIN',
      idempotencyKey: k(),
    });
    await structure.scheduleContest({
      actorAccountId: staff.accountId,
      contestId: e.contests[0]!,
      scheduledStart: '2027-05-01T10:00:00Z',
      idempotencyKey: k(),
    });
    expect(await counts()).toEqual(before);
    const { rows } = await sql<{
      principal_id: Uuid;
    }>`SELECT principal_id FROM organizations.organization_principal WHERE organization_id = ${org.organizationId}`.execute(
      owner,
    );
    for (const cap of [
      'ACCEPT_RESULT',
      'DECLARE_OFFICIAL',
      'ATTEST_RESULT',
      'RATIFY_RECORD',
    ] as Capability[]) {
      expect(await covers(rows[0]!.principal_id, 'CONTEST', e.contests[0]!, cap)).toBe(false);
    }
    // no authority-bearing staff roles exist
    for (const role of ['OFFICIAL', 'REFEREE']) {
      await expect(
        comps.assignStaff({
          actorAccountId: org.ownerAccountId,
          competitionId: C,
          personId: staff.personId as string,
          role: role as never,
          idempotencyKey: k(),
        }),
      ).rejects.toMatchObject({ code: DomainErrorCode.INVALID_INPUT });
    }
  });

  it('a FEDERATION organizer has no authority either', async () => {
    const fedOwner = await newTestAccount(identity);
    const fed = await orgs.createOrganization({
      actorAccountId: fedOwner.accountId,
      orgType: 'FEDERATION',
      slug: uniqueSlug('fed'),
      profile: { displayName: 'Fictional Federation' },
      idempotencyKey: k(),
    });
    const C = await comps.createCompetition({
      actorAccountId: fedOwner.accountId,
      organizerOrganizationId: fed.organizationId,
      slug: uniqueSlug('fed-cup'),
      profile: { name: 'Fed Cup', timezone: 'UTC' },
      idempotencyKey: k(),
    });
    expect(await covers(fed.principalId as Uuid, 'COMPETITION', C.competitionId)).toBe(false);
  });

  it('an ACCEPT_RESULT grant to the organizer principal does not grant any competition permission', async () => {
    const org = t.organizer;
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
    const ownerBefore = await comps.permissions(org.ownerAccountId, t.C1);
    const { rows } = await sql<{
      principal_id: Uuid;
    }>`SELECT principal_id FROM organizations.organization_principal WHERE organization_id = ${org.organizationId}`.execute(
      owner,
    );
    await authority.issueGrant({
      actorPrincipalId: platformId,
      grantorPrincipalId: platformId,
      granteePrincipalId: rows[0]!.principal_id,
      capabilities: ['ACCEPT_RESULT', 'DECLARE_OFFICIAL'],
      scope: { recognitionLevel: ['PLATFORM'], competition: [t.C1 as Uuid] },
      delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
    });
    expect(await covers(rows[0]!.principal_id, 'CONTEST', t.A)).toBe(true); // the grant is real…
    expect(await comps.permissions(member.accountId, t.C1)).toEqual({
      staffRoles: [],
      permissions: [],
    }); // …but grants no COMP_*
    expect(await comps.permissions(org.ownerAccountId, t.C1)).toEqual(ownerBefore);
    await expect(
      comps.cancelCompetition({
        actorAccountId: member.accountId,
        competitionId: t.C1,
        reason: 'x',
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.FORBIDDEN });
  });
});

describe('Result ↔ Contest linkage (no redesign; validator port)', () => {
  const ledger = new ResultLedger(api, {
    conflictChecker: declaredNoParticipation,
    scopeValidator: competitionResultScopeValidator,
  });
  const content = (p1: string, p2: string) => ({
    entries: [
      {
        participantId: p1,
        outcome: 'WIN',
        primaryMark: { metricId: 'tennis.match.sets', value: '2', unit: 'sets', precision: 0 },
      },
      {
        participantId: p2,
        outcome: 'LOSS',
        primaryMark: { metricId: 'tennis.match.sets', value: '0', unit: 'sets', precision: 0 },
      },
    ],
  });

  it('contests have no Result until one is explicitly created; unknown targets are refused', async () => {
    expect(
      Number(
        (
          await sql<{
            n: number;
          }>`SELECT count(*)::int AS n FROM results.result WHERE scope_target_id IN (${t.A}, ${t.B}, ${t.C}, ${t.D})`.execute(
            owner,
          )
        ).rows[0]?.n,
      ),
    ).toBe(0);
    await expect(
      ledger.createResult({ scopeType: 'CONTEST', scopeTargetId: newId() }),
    ).rejects.toMatchObject({ code: DomainErrorCode.NOT_FOUND });
    await expect(
      ledger.createResult({ scopeType: 'EVENT_CLASSIFICATION', scopeTargetId: t.A as Uuid }),
    ).rejects.toMatchObject({ code: DomainErrorCode.NOT_FOUND });
  });

  it('authority scope used on a contest Result must be its exact hierarchy (no borrowed ancestry); nothing is auto-accepted', async () => {
    const referee = await grantee({ competition: [t.C2 as Uuid] }, ['SUBMIT_RESULT']);
    const result = await ledger.createResult({ scopeType: 'CONTEST', scopeTargetId: t.A as Uuid });
    const { rows: ps } = await sql<{
      participant_id: string;
    }>`SELECT participant_id FROM competition.contestant WHERE contest_id = ${t.A} AND participant_id IS NOT NULL ORDER BY slot`.execute(
      owner,
    );
    const { draftId } = await ledger.saveDraft({
      resultId: result.id,
      authorPrincipalId: referee,
      disciplineVersionRef: 'tennis.singles@1',
      content: content(ps[0]!.participant_id, ps[1]!.participant_id),
    });
    const pathD = (await resolver.resolve('CONTEST', t.D))!;
    // the C2 referee claims contest A sits in C2 (D's ancestry) to borrow their grant → refused
    await expect(
      ledger.submitDraft({
        draftId,
        actorPrincipalId: referee,
        scope: { ...pathToScope({ ...pathD, contestId: t.A }), recognitionLevel: ['PLATFORM'] },
        idempotencyKey: k(),
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.AUTHORITY_DENIED });
    // with the true ancestry the C2 referee is simply not authorized for A
    const trueScope = {
      ...(await resolver.scopeOf('CONTEST', t.A)),
      recognitionLevel: ['PLATFORM'],
    } as AuthorityScope;
    await expect(
      ledger.submitDraft({
        draftId,
        actorPrincipalId: referee,
        scope: trueScope,
        idempotencyKey: k(),
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.AUTHORITY_DENIED });
    // a C1 referee submits with the exact scope: the version is SUBMITTED — never PROVISIONAL/VERIFIED by itself
    const c1Referee = await grantee({ competition: [t.C1 as Uuid] }, ['SUBMIT_RESULT']);
    const out = await ledger.submitDraft({
      draftId,
      actorPrincipalId: c1Referee,
      scope: trueScope,
      idempotencyKey: k(),
    });
    expect(out.status).toBe('SUBMITTED');
    await inTransaction(api, ModuleRole.results, async (ctx) => {
      await expect(
        competitionResultScopeValidator.assertScope(ctx, 'CONTEST', t.A, trueScope),
      ).resolves.toBeUndefined();
      expect(await resolveHierarchy(ctx, 'CONTEST', t.A)).toBeDefined();
    });
  });
});

describe('BRT-05R guardrail: competition-aware ResultLedger composition', () => {
  it('createCompetitionResultLedger always validates the competition hierarchy', async () => {
    const guarded = createCompetitionResultLedger(api, {
      conflictChecker: declaredNoParticipation,
    });
    await expect(
      guarded.createResult({ scopeType: 'CONTEST', scopeTargetId: newId() }),
    ).rejects.toMatchObject({ code: DomainErrorCode.NOT_FOUND });
    await expect(
      guarded.createResult({ scopeType: 'COMPETITION_CLASSIFICATION', scopeTargetId: newId() }),
    ).rejects.toMatchObject({ code: DomainErrorCode.NOT_FOUND });
    const r = await guarded.createResult({ scopeType: 'CONTEST', scopeTargetId: t.B as Uuid });
    expect(r.scopeTargetId).toBe(t.B);
  });
});
