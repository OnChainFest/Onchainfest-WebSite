import { Capability, DomainError, newId, type Uuid } from '@br/domain';
import {
  apiDb,
  newAthlete,
  newOrganizer,
  newTestAccount,
  operatorDb,
  ownerDb,
  seedTestCatalog,
  uniqueSlug,
  type TestCatalog,
} from '@br/testkit';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthorityStore } from './authority-store';
import { CatalogStore } from './catalog-store';
import { CompetitionHierarchyResolver } from './competition-hierarchy';
import { competitionParticipationChecker } from './competition-participation';
import { CompetitionStore } from './competition-store';
import { StructureStore } from './competition-structure-store';
import { IdentityStore } from './identity-store';
import { OrganizationStore } from './organization-store';
import { competitionResultScope, ResultAuthorityGovernance } from './result-authority';

// LAUNCH-02 · ADR-0077: governance-issued competition result authority. Every precondition is
// checked against real database facts; grants are scoped, idempotent, auditable and revocable.

const api = apiDb();
const owner = ownerDb();
const operator = operatorDb();
afterAll(async () => {
  await Promise.all([api, owner, operator].map((d) => d.destroy()));
});

const identity = new IdentityStore(api);
const orgs = new OrganizationStore(api);
const comps = new CompetitionStore(api);
const structure = new StructureStore(api);
const governance = new ResultAuthorityGovernance(api);
const authority = new AuthorityStore(api);
const resolver = new CompetitionHierarchyResolver(api);
const k = () => `k-${newId()}`;
const ref = (what: string) => `gov:launch02:${what}:${newId()}`;

let cat: TestCatalog;
let organizer: Awaited<ReturnType<typeof newOrganizer>>;
let platformId: Uuid;
let C1: string;
let C2: string;
let contestC1: string;
let contestC2: string;

async function competition(org: Awaited<ReturnType<typeof newOrganizer>>, publish = true) {
  const { competitionId } = await comps.createCompetition({
    actorAccountId: org.ownerAccountId,
    organizerOrganizationId: org.organizationId,
    slug: uniqueSlug('l02'),
    profile: { name: 'Launch 02 Open', timezone: 'UTC' },
    idempotencyKey: k(),
  });
  if (publish)
    await comps.publishCompetition({ actorAccountId: org.ownerAccountId, competitionId });
  return competitionId;
}

/** An event with two registered athletes, locked, seeded and planned; returns its first contest. */
async function contestIn(competitionId: string): Promise<string> {
  const { eventId } = await comps.createEvent({
    actorAccountId: organizer.ownerAccountId,
    competitionId,
    slug: uniqueSlug('ev'),
    disciplineVersionId: cat.tennisSingles,
    formatVersionId: cat.singleElimination,
    settings: { name: 'Singles' },
    idempotencyKey: k(),
  });
  await comps.openRegistration({ actorAccountId: organizer.ownerAccountId, eventId });
  for (let i = 0; i < 2; i++) {
    const a = await newAthlete(identity);
    await comps.register({
      actorAccountId: a.accountId,
      eventId,
      athleteId: a.athleteId,
      eligibilityDeclared: true,
      idempotencyKey: k(),
    });
  }
  await comps.closeRegistration({ actorAccountId: organizer.ownerAccountId, eventId });
  await structure.lockField({
    actorAccountId: organizer.ownerAccountId,
    eventId,
    idempotencyKey: k(),
  });
  await structure.seedField({
    actorAccountId: organizer.ownerAccountId,
    eventId,
    method: 'DETERMINISTIC_DRAW',
    idempotencyKey: k(),
  });
  await structure.generatePlan({
    actorAccountId: organizer.ownerAccountId,
    eventId,
    idempotencyKey: k(),
  });
  const { rows } = await sql<{ id: string }>`
    SELECT id FROM competition.contest WHERE event_id = ${eventId} ORDER BY sequence LIMIT 1`.execute(
    owner,
  );
  return rows[0]?.id as string;
}

async function staff(competitionId: string, role: 'ADMIN' | 'REGISTRATION_MANAGER' | 'SCHEDULER') {
  const acct = await newTestAccount(identity, { label: `staff-${role.toLowerCase()}` });
  const { staffId } = await comps.assignStaff({
    actorAccountId: organizer.ownerAccountId,
    competitionId,
    personId: acct.personId as string,
    role,
    idempotencyKey: k(),
  });
  return { ...acct, staffId };
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; reason: unknown }> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    return { code: (err as DomainError).code, reason: (err as DomainError).details.reason };
  }
  throw new Error('expected a refusal');
}

async function grantCount(): Promise<number> {
  const { rows } = await sql<{
    n: number;
  }>`SELECT count(*)::int AS n FROM authority.authority_grant`.execute(owner);
  return rows[0]?.n ?? 0;
}

async function principalOf(accountId: string): Promise<Uuid> {
  const { rows } = await sql<{ principal_id: string }>`
    SELECT pp.principal_id FROM identity.person_principal pp
    JOIN identity.account_person_control apc ON apc.person_id = pp.person_id
    WHERE apc.account_id = ${accountId} AND apc.control_kind = 'SELF'`.execute(owner);
  return rows[0]?.principal_id as Uuid;
}

/** Authorization exactly as the result ledger asks: the contest's resolved path + PLATFORM. */
async function decide(
  principalId: Uuid,
  capability: Capability,
  contestId: string,
  competitionId: string,
) {
  const scope = await resolver.scopeOf('CONTEST', contestId, { recognitionLevel: 'PLATFORM' });
  return authority.authorize(
    { principalId, capability, scope },
    competitionParticipationChecker({ principalId, competitionId, participates: false }),
  );
}

beforeAll(async () => {
  cat = await seedTestCatalog(identity, new CatalogStore(operator));
  organizer = await newOrganizer(identity, orgs);
  C1 = await competition(organizer);
  C2 = await competition(organizer); // same organizer: a C1 grant must not reach C2
  contestC1 = await contestIn(C1);
  contestC2 = await contestIn(C2);
  platformId = (
    await governance.bootstrapPlatformAnchor({
      governanceDecisionRef: ref('anchor'),
      basisRef: 'basis:launch02:platform-charter',
    })
  ).platformPrincipalId;
}, 240_000);

describe('platform trust anchor bootstrap', () => {
  it('is idempotent by governance decision and anchors only the PLATFORM level', async () => {
    const decision = ref('anchor-idem');
    const first = await governance.bootstrapPlatformAnchor({
      governanceDecisionRef: decision,
      basisRef: 'basis:launch02:charter',
    });
    const again = await governance.bootstrapPlatformAnchor({
      governanceDecisionRef: decision,
      basisRef: 'basis:launch02:charter',
    });
    expect(first.created).toBe(true);
    expect(again).toEqual({ ...first, created: false });
    const { rows } = await sql<{ recognition_scope: unknown; principal_type: string }>`
      SELECT a.recognition_scope, p.principal_type FROM authority.trust_anchor a
      JOIN authority.principal p ON p.id = a.principal_id WHERE a.governance_decision_ref = ${decision}`.execute(
      owner,
    );
    expect(rows).toEqual([
      { recognition_scope: { recognitionLevel: ['PLATFORM'] }, principal_type: 'PLATFORM' },
    ]);
  });

  it('refuses a revoked anchor instead of replacing it, and refuses PII-shaped references', async () => {
    const decision = ref('anchor-revoked');
    const { anchorId } = await governance.bootstrapPlatformAnchor({
      governanceDecisionRef: decision,
      basisRef: 'basis:launch02:charter',
    });
    await authority.revokeTrustAnchor({ anchorId, reason: 'test: superseded charter' });
    expect(
      await refusal(
        governance.bootstrapPlatformAnchor({
          governanceDecisionRef: decision,
          basisRef: 'basis:x',
        }),
      ),
    ).toEqual({ code: 'INVALID_TRANSITION', reason: 'ANCHOR_REVOKED' });
    expect(
      (
        await refusal(
          governance.bootstrapPlatformAnchor({
            governanceDecisionRef: 'jane doe@example.com',
            basisRef: 'b:1',
          }),
        )
      ).code,
    ).toBe('INVALID_INPUT');
  });
});

describe('competition result grant', () => {
  it('the organizer OWNER receives exactly the scoped, non-delegable result capabilities', async () => {
    const decision = ref('grant-owner');
    const out = await governance.grantCompetitionResultAuthority({
      platformPrincipalId: platformId,
      competitionId: C1,
      granteeAccountId: organizer.ownerAccountId,
      governanceDecisionRef: decision,
    });
    expect(out.created).toBe(true);
    const { rows } = await sql<{
      grantor_principal_id: string;
      grantee_principal_id: string;
      capabilities: string[];
      scope: unknown;
      delegation: unknown;
      constraints: unknown;
      effective_to: Date | null;
    }>`SELECT grantor_principal_id, grantee_principal_id, capabilities, scope, delegation, constraints, effective_to
       FROM authority.authority_grant WHERE id = ${out.grantId}`.execute(owner);
    expect(rows[0]).toEqual({
      grantor_principal_id: platformId,
      grantee_principal_id: out.granteePrincipalId,
      capabilities: ['ACCEPT_RESULT', 'CORRECT_RESULT', 'DECLARE_OFFICIAL', 'SUBMIT_RESULT'],
      scope: competitionResultScope(C1),
      delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
      constraints: { mustNotBeParticipant: true },
      effective_to: null,
    });
    expect(out.granteePrincipalId).toBe(await principalOf(organizer.ownerAccountId));

    // Auditable: ledger stream, outbox event and a PII-free audit row naming the governance decision.
    const audit = await sql<{ action: string; details: Record<string, unknown> }>`
      SELECT action, details FROM platform.audit_event WHERE target_id = ${C1} AND action LIKE 'authority.result-grant.%'
      AND details->>'governanceDecisionRef' = ${decision}`.execute(owner);
    expect(audit.rows).toEqual([
      expect.objectContaining({
        action: 'authority.result-grant.issued',
        details: expect.objectContaining({ grantId: out.grantId, staffRoles: ['OWNER'] }),
      }),
    ]);
    const events = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM platform.outbox_event
      WHERE event_type = 'AuthorityGrantIssued' AND aggregate_id = ${out.grantId}`.execute(owner);
    expect(events.rows[0]?.n).toBe(1);
    const stream = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM platform.ledger_entry WHERE stream_id = ${out.grantId}`.execute(
      owner,
    );
    expect(stream.rows[0]?.n).toBe(1);

    // Every lifecycle capability authorizes over a C1 contest; nothing reaches sibling C2.
    for (const capability of [
      Capability.SUBMIT_RESULT,
      Capability.ACCEPT_RESULT,
      Capability.DECLARE_OFFICIAL,
      Capability.CORRECT_RESULT,
    ]) {
      const ok = await decide(out.granteePrincipalId, capability, contestC1, C1);
      expect(ok.authorized, `${capability}: ${ok.reason}`).toBe(true);
      expect(ok.grantChain[0]?.grantId).toBe(out.grantId);
    }
    const sibling = await decide(
      out.granteePrincipalId,
      Capability.DECLARE_OFFICIAL,
      contestC2,
      C2,
    );
    expect(sibling).toMatchObject({ authorized: false, reason: 'SCOPE_NOT_COVERED' });
    // The grant carries nothing beyond results (no ratification, no delegation).
    const ratify = await decide(out.granteePrincipalId, Capability.RATIFY_RECORD, contestC1, C1);
    expect(ratify.authorized).toBe(false);
  });

  it('repeated issuance converges on one grant (sequential and concurrent)', async () => {
    const admin = await staff(C1, 'ADMIN');
    const decision = ref('grant-idem');
    const input = {
      platformPrincipalId: platformId,
      competitionId: C1,
      granteeAccountId: admin.accountId,
      governanceDecisionRef: decision,
    };
    const before = await grantCount();
    const [a, b] = await Promise.all([
      governance.grantCompetitionResultAuthority(input),
      governance.grantCompetitionResultAuthority(input),
    ]);
    const c = await governance.grantCompetitionResultAuthority(input);
    // Even a different decision converges while an equivalent grant is active.
    const d = await governance.grantCompetitionResultAuthority({
      ...input,
      governanceDecisionRef: ref('other'),
    });
    expect(new Set([a.grantId, b.grantId, c.grantId, d.grantId]).size).toBe(1);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(c.created).toBe(false);
    expect(await grantCount()).toBe(before + 1);
  });

  it('only OWNER / ADMIN staff of that competition qualify; denials are audited and write no grant', async () => {
    const regman = await staff(C1, 'REGISTRATION_MANAGER');
    const scheduler = await staff(C1, 'SCHEDULER');
    const stranger = await newTestAccount(identity, { label: 'stranger' });
    const otherOrganizer = await newOrganizer(identity, orgs); // another organization's OWNER
    const noPerson = await newTestAccount(identity, { withPerson: false, label: 'no-person' });
    const before = await grantCount();
    for (const accountId of [
      regman.accountId,
      scheduler.accountId,
      stranger.accountId,
      otherOrganizer.ownerAccountId,
      noPerson.accountId,
    ]) {
      const decision = ref('denied');
      expect(
        await refusal(
          governance.grantCompetitionResultAuthority({
            platformPrincipalId: platformId,
            competitionId: C1,
            granteeAccountId: accountId,
            governanceDecisionRef: decision,
          }),
        ),
      ).toEqual({ code: 'FORBIDDEN', reason: 'NOT_RESULT_STAFF' });
      const audit = await sql<{ outcome: string }>`
        SELECT outcome FROM platform.audit_event WHERE details->>'governanceDecisionRef' = ${decision}`.execute(
        owner,
      );
      expect(audit.rows).toEqual([{ outcome: 'DENIED' }]);
    }
    expect(await grantCount()).toBe(before);
  });

  it('a staff member who participates in the competition is refused (conflict of interest)', async () => {
    const athlete = await newAthlete(identity, 'staff-athlete');
    const { eventId } = await comps.createEvent({
      actorAccountId: organizer.ownerAccountId,
      competitionId: C1,
      slug: uniqueSlug('ev'),
      disciplineVersionId: cat.tennisSingles,
      formatVersionId: cat.singleElimination,
      settings: { name: 'Second singles' },
      idempotencyKey: k(),
    });
    await comps.openRegistration({ actorAccountId: organizer.ownerAccountId, eventId });
    await comps.register({
      actorAccountId: athlete.accountId,
      eventId,
      athleteId: athlete.athleteId,
      eligibilityDeclared: true,
      idempotencyKey: k(),
    });
    await comps.assignStaff({
      actorAccountId: organizer.ownerAccountId,
      competitionId: C1,
      personId: athlete.personId,
      role: 'ADMIN',
      idempotencyKey: k(),
    });
    const before = await grantCount();
    expect(
      await refusal(
        governance.grantCompetitionResultAuthority({
          platformPrincipalId: platformId,
          competitionId: C1,
          granteeAccountId: athlete.accountId,
          governanceDecisionRef: ref('participant'),
        }),
      ),
    ).toEqual({ code: 'FORBIDDEN', reason: 'GRANTEE_PARTICIPATES' });
    expect(await grantCount()).toBe(before);
    // The same person is clear for a competition they do not take part in.
    await comps.assignStaff({
      actorAccountId: organizer.ownerAccountId,
      competitionId: C2,
      personId: athlete.personId,
      role: 'ADMIN',
      idempotencyKey: k(),
    });
    const ok = await governance.grantCompetitionResultAuthority({
      platformPrincipalId: platformId,
      competitionId: C2,
      granteeAccountId: athlete.accountId,
      governanceDecisionRef: ref('participant-elsewhere'),
    });
    expect(ok.created).toBe(true);
  });

  it('respects the competition lifecycle and refuses a non-PLATFORM grantor', async () => {
    const draft = await competition(organizer, false);
    expect(
      await refusal(
        governance.grantCompetitionResultAuthority({
          platformPrincipalId: platformId,
          competitionId: draft,
          granteeAccountId: organizer.ownerAccountId,
          governanceDecisionRef: ref('draft'),
        }),
      ),
    ).toEqual({ code: 'INVALID_TRANSITION', reason: 'COMPETITION_NOT_OPERATING' });
    const personPrincipal = await principalOf(organizer.ownerAccountId);
    for (const grantor of [personPrincipal, newId()])
      expect(
        await refusal(
          governance.grantCompetitionResultAuthority({
            platformPrincipalId: grantor,
            competitionId: C1,
            granteeAccountId: organizer.ownerAccountId,
            governanceDecisionRef: ref('not-platform'),
          }),
        ),
      ).toEqual({ code: 'NOT_FOUND', reason: 'NOT_A_PLATFORM_PRINCIPAL' });
    // A PLATFORM principal without a recognized anchor cannot root a grant (BRT-03 chain check).
    const unanchored = await authority.registerPrincipal({
      principalType: 'PLATFORM',
      label: 'unanchored',
    });
    expect(
      (
        await refusal(
          governance.grantCompetitionResultAuthority({
            platformPrincipalId: unanchored.id,
            competitionId: C1,
            granteeAccountId: organizer.ownerAccountId,
            governanceDecisionRef: ref('unanchored'),
          }),
        )
      ).code,
    ).toBe('GRANT_INVALID');
  });

  it('revocation is prospective, audited, listed, and a spent decision cannot re-grant', async () => {
    const admin = await staff(C1, 'ADMIN');
    const decision = ref('grant-revoke');
    const granted = await governance.grantCompetitionResultAuthority({
      platformPrincipalId: platformId,
      competitionId: C1,
      granteeAccountId: admin.accountId,
      governanceDecisionRef: decision,
    });
    expect(
      (await decide(granted.granteePrincipalId, Capability.DECLARE_OFFICIAL, contestC1, C1))
        .authorized,
    ).toBe(true);

    // Ending the staff role does not touch the grant (layers stay separate; the API's staff gate
    // stops result actions at once) — revocation is the operator's explicit act.
    await comps.endStaff({ actorAccountId: organizer.ownerAccountId, staffId: admin.staffId });
    const listed = await governance.listCompetitionResultAuthority(C1);
    expect(listed.find((g) => g.grantId === granted.grantId)?.status).toBe('ACTIVE');

    const revoked = await governance.revokeCompetitionResultAuthority({
      platformPrincipalId: platformId,
      competitionId: C1,
      granteeAccountId: admin.accountId,
      governanceDecisionRef: ref('revoke'),
      reason: 'staff member left the tournament team',
    });
    expect(revoked.revokedGrantIds).toEqual([granted.grantId]);
    const after = await decide(
      granted.granteePrincipalId,
      Capability.DECLARE_OFFICIAL,
      contestC1,
      C1,
    );
    expect(after).toMatchObject({ authorized: false, reason: 'GRANT_REVOKED' });
    expect(
      (await governance.listCompetitionResultAuthority(C1)).find(
        (g) => g.grantId === granted.grantId,
      )?.status,
    ).toBe('REVOKED');
    // Revoking again is a no-op.
    expect(
      (
        await governance.revokeCompetitionResultAuthority({
          platformPrincipalId: platformId,
          competitionId: C1,
          granteeAccountId: admin.accountId,
          governanceDecisionRef: ref('revoke-again'),
          reason: 'repeat',
        })
      ).revokedGrantIds,
    ).toEqual([]);

    // Re-staffed: the spent decision cannot be replayed into a new grant; a new decision can.
    await comps.assignStaff({
      actorAccountId: organizer.ownerAccountId,
      competitionId: C1,
      personId: admin.personId as string,
      role: 'ADMIN',
      idempotencyKey: k(),
    });
    expect(
      await refusal(
        governance.grantCompetitionResultAuthority({
          platformPrincipalId: platformId,
          competitionId: C1,
          granteeAccountId: admin.accountId,
          governanceDecisionRef: decision,
        }),
      ),
    ).toEqual({ code: 'ALREADY_EXISTS', reason: 'GOVERNANCE_DECISION_USED' });
    const regrant = await governance.grantCompetitionResultAuthority({
      platformPrincipalId: platformId,
      competitionId: C1,
      granteeAccountId: admin.accountId,
      governanceDecisionRef: ref('regrant'),
    });
    expect(regrant.created).toBe(true);
    expect(regrant.grantId).not.toBe(granted.grantId);
  });
});
