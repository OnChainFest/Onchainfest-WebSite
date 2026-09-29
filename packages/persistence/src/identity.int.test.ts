import { DomainErrorCode, newId, type Uuid } from '@br/domain';
import {
  createDevelopmentPiiCipher,
  createTestWalletVerifier,
  eip155EoaPersonalSignVerifier,
  generateTestWalletKey,
  signEip191ForTest,
} from '@br/identity';
import {
  apiDb,
  declaredNoParticipation,
  maintenanceDb,
  newTestAccount,
  ownerDb,
  uniqueSlug,
  vaultDb,
} from '@br/testkit';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { AuthorityStore } from './authority-store';
import { IdentityStore } from './identity-store';
import { OrganizationReader, OrganizationStore, hashInvitationToken } from './organization-store';
import { PassportReader, rebuildPassports, snapshotPassports } from './passport-store';
import { inTransaction, ModuleRole } from './tx';
import { PersonPrivateDataService } from './vault-store';

const api = apiDb();
const vault = vaultDb();
const maintenance = maintenanceDb();
const owner = ownerDb();
afterAll(async () => {
  await Promise.all([api, vault, maintenance, owner].map((d) => d.destroy()));
});

const identity = new IdentityStore(api, {
  walletVerifiers: [eip155EoaPersonalSignVerifier, createTestWalletVerifier()],
});
const productionOnly = new IdentityStore(api, { walletVerifiers: [eip155EoaPersonalSignVerifier] });
const orgs = new OrganizationStore(api);
const passports = new PassportReader(api);
const orgReader = new OrganizationReader(api);
const TEST_KEY = 'integration-test-key-0123456789abcdef-not-a-real-key';
const DIFFERENT_TEST_KEY = 'a-different-integration-key-fedcba9876543210-zz';
const cipher = createDevelopmentPiiCipher({ keyMaterial: TEST_KEY });
const privateData = new PersonPrivateDataService(vault, cipher);
const anon = { authenticated: false };

async function rejects(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toMatchObject({ code });
}

async function athleteFor(opts: { slug?: string; displayName?: string } = {}) {
  const acct = await newTestAccount(identity);
  const slug = opts.slug ?? uniqueSlug();
  const { athleteId } = await identity.createAthlete({
    actorAccountId: acct.accountId,
    personId: acct.personId as string,
    slug,
    profile: { displayName: opts.displayName ?? 'Test Athlete', preferredSports: ['padel'] },
    idempotencyKey: `ath-${slug}`,
  });
  return { ...acct, personId: acct.personId as string, athleteId, slug };
}

async function orgFor(ownerAccountId: string, slug = uniqueSlug('club')) {
  const r = await orgs.createOrganization({
    actorAccountId: ownerAccountId,
    orgType: 'CLUB',
    slug,
    profile: { displayName: 'Fictional Padel Club', country: 'ES' },
    idempotencyKey: `org-${slug}`,
  });
  return { ...r, slug };
}

describe('accounts and authentication identities', () => {
  it('(provider, subject) is stable: repeated sign-in returns the same account, never a new one', async () => {
    const subject = `sub-${newId()}`;
    const a = await identity.signIn({ provider: 'test', providerSubject: subject, method: 'TEST' });
    const b = await identity.signIn({ provider: 'test', providerSubject: subject, method: 'TEST' });
    expect(a.created).toBe(true);
    expect(b).toMatchObject({
      accountId: a.accountId,
      authIdentityId: a.authIdentityId,
      created: false,
    });
    const other = await identity.signIn({
      provider: 'test-other',
      providerSubject: subject,
      method: 'TEST',
    });
    expect(other.accountId).not.toBe(a.accountId);
  });

  it('concurrent first sign-ins converge on one account', async () => {
    const subject = `race-${newId()}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        identity.signIn({ provider: 'test', providerSubject: subject, method: 'TEST' }),
      ),
    );
    expect(new Set(results.map((r) => r.accountId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  it('an account has at most one SELF person; a disabled account controls nothing', async () => {
    const acct = await newTestAccount(identity);
    await rejects(
      identity.createPerson({
        actorAccountId: acct.accountId,
        relation: 'SELF',
        idempotencyKey: newId(),
      }),
      DomainErrorCode.ALREADY_EXISTS,
    );
    // same idempotency key → replay, not a duplicate
    const replay = await identity.createPerson({
      actorAccountId: acct.accountId,
      relation: 'SELF',
      idempotencyKey: `self-${acct.accountId}`,
    });
    expect(replay).toMatchObject({ personId: acct.personId, created: false });
    const operator = await newTestAccount(identity, { withPerson: false });
    await identity.disableAccount({
      operatorAccountId: operator.accountId,
      accountId: acct.accountId,
      reason: 'test',
    });
    await rejects(
      identity.createAthlete({
        actorAccountId: acct.accountId,
        personId: acct.personId as string,
        slug: uniqueSlug(),
        profile: { displayName: 'X' },
        idempotencyKey: newId(),
      }),
      DomainErrorCode.FORBIDDEN,
    );
  });
});

describe('athletes, profiles and slugs', () => {
  it('creates an athlete with a public passport; same key replays; one athlete per person', async () => {
    const a = await athleteFor({ displayName: 'Ana Ficticia' });
    const p = await passports.bySlug(a.slug.toUpperCase(), anon);
    expect(p?.passport.athlete.displayName).toEqual({
      value: 'Ana Ficticia',
      provenance: 'SELF_DECLARED',
    });
    expect(p?.passport.verifiedAchievements.status).toBe('NOT_AVAILABLE');
    await rejects(
      identity.createAthlete({
        actorAccountId: a.accountId,
        personId: a.personId,
        slug: uniqueSlug(),
        profile: { displayName: 'Again' },
        idempotencyKey: newId(),
      }),
      DomainErrorCode.ALREADY_EXISTS,
    );
  });

  it('concurrent creation with the same idempotency key creates exactly one athlete', async () => {
    const acct = await newTestAccount(identity);
    const slug = uniqueSlug();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        identity.createAthlete({
          actorAccountId: acct.accountId,
          personId: acct.personId as string,
          slug,
          profile: { displayName: 'Racer' },
          idempotencyKey: 'same-key',
        }),
      ),
    );
    const ok = results.filter(
      (r): r is PromiseFulfilledResult<{ athleteId: string; slug: string; created: boolean }> =>
        r.status === 'fulfilled',
    );
    expect(ok).toHaveLength(5);
    expect(new Set(ok.map((r) => r.value.athleteId)).size).toBe(1);
    expect(ok.filter((r) => r.value.created)).toHaveLength(1);
  });

  it('concurrent claims of one slug by different athletes: exactly one wins', async () => {
    const slug = uniqueSlug('contested');
    const accts = await Promise.all(Array.from({ length: 4 }, () => newTestAccount(identity)));
    const results = await Promise.allSettled(
      accts.map((a) =>
        identity.createAthlete({
          actorAccountId: a.accountId,
          personId: a.personId as string,
          slug,
          profile: { displayName: 'Contender' },
          idempotencyKey: newId(),
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x): x is PromiseRejectedResult => x.status === 'rejected'))
      expect(r.reason).toMatchObject({ code: DomainErrorCode.SLUG_TAKEN });
  });

  it('reserved and invalid slugs are refused; slug changes redirect and old slugs cannot be hijacked', async () => {
    const acct = await newTestAccount(identity);
    await rejects(
      identity.createAthlete({
        actorAccountId: acct.accountId,
        personId: acct.personId as string,
        slug: 'Admin',
        profile: { displayName: 'X' },
        idempotencyKey: newId(),
      }),
      DomainErrorCode.SLUG_INVALID,
    );
    const a = await athleteFor();
    const next = uniqueSlug('renamed');
    await identity.changeAthleteSlug({
      actorAccountId: a.accountId,
      athleteId: a.athleteId,
      slug: next,
    });
    const old = await passports.bySlug(a.slug, anon);
    expect(old?.resolution).toEqual({
      athleteId: a.athleteId,
      currentSlug: next,
      redirected: true,
    });
    const thief = await newTestAccount(identity);
    await rejects(
      identity.createAthlete({
        actorAccountId: thief.accountId,
        personId: thief.personId as string,
        slug: a.slug,
        profile: { displayName: 'Thief' },
        idempotencyKey: newId(),
      }),
      DomainErrorCode.SLUG_TAKEN,
    );
  });

  it('another account cannot edit the profile; the bio stays SELF_DECLARED whatever it claims', async () => {
    const a = await athleteFor();
    const stranger = await newTestAccount(identity);
    await rejects(
      identity.updateAthleteProfile({
        actorAccountId: stranger.accountId,
        athleteId: a.athleteId,
        patch: { displayName: 'Hijacked' },
      }),
      DomainErrorCode.FORBIDDEN,
    );
    await identity.updateAthleteProfile({
      actorAccountId: a.accountId,
      athleteId: a.athleteId,
      patch: { shortBio: 'Verified world champion 2026' },
    });
    const p = await passports.passport(a.athleteId, anon);
    expect(p?.athlete.bio).toEqual({
      value: 'Verified world champion 2026',
      provenance: 'SELF_DECLARED',
    });
    expect(p?.verifiedAchievements).toEqual({
      status: 'NOT_AVAILABLE',
      reason: 'SOURCE_NOT_IMPLEMENTED',
      items: [],
    });
  });

  it('PRIVATE and AUTHENTICATED visibility are enforced on the public path', async () => {
    const a = await athleteFor();
    await identity.updateAthleteProfile({
      actorAccountId: a.accountId,
      athleteId: a.athleteId,
      patch: { profileVisibility: 'AUTHENTICATED' },
    });
    expect(await passports.passport(a.athleteId, anon)).toBeUndefined();
    expect(await passports.passport(a.athleteId, { authenticated: true })).toBeDefined();
    await identity.updateAthleteProfile({
      actorAccountId: a.accountId,
      athleteId: a.athleteId,
      patch: { profileVisibility: 'PRIVATE' },
    });
    expect(await passports.passport(a.athleteId, { authenticated: true })).toBeUndefined();
  });
});

describe('guardians and minors', () => {
  it('an asserted (PENDING) guardian relationship grants nothing; confirmation grants the allowed set only', async () => {
    const parent = await newTestAccount(identity, { label: 'parent' });
    const { personId: childId, guardianRelationshipId } = await identity.createPerson({
      actorAccountId: parent.accountId,
      relation: 'DEPENDENT',
      relationshipKind: 'PARENT',
      idempotencyKey: newId(),
    });
    expect(await identity.canOperateOnPerson(parent.accountId, childId, 'CREATE_ATHLETE')).toBe(
      false,
    );
    const operator = await newTestAccount(identity, { withPerson: false });
    await identity.confirmGuardianRelationship({
      operatorAccountId: operator.accountId,
      guardianRelationshipId: guardianRelationshipId as string,
      basis: 'PLATFORM_REVIEW',
    });
    expect(await identity.canOperateOnPerson(parent.accountId, childId, 'CREATE_ATHLETE')).toBe(
      true,
    );
    expect(await identity.canOperateOnPerson(parent.accountId, childId, 'VIEW_PRIVATE_DATA')).toBe(
      false,
    );
    expect(await identity.canOperateOnPerson(parent.accountId, childId, 'LINK_WALLET')).toBe(false);

    const slug = uniqueSlug('junior');
    const { athleteId } = await identity.createAthlete({
      actorAccountId: parent.accountId,
      personId: childId,
      slug,
      profile: { displayName: 'Junior Player' },
      idempotencyKey: newId(),
    });
    const { rows: tagged } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM platform.audit_event
      WHERE action = 'guardian.acted-on-behalf' AND actor_account_id = ${parent.accountId} AND target_id = ${childId}`.execute(
      owner,
    );
    expect(tagged[0]?.n).toBeGreaterThan(0);
    // Minor privacy default: restricted and PRIVATE; invisible even if visibility is later set to PUBLIC.
    await identity.updateAthleteProfile({
      actorAccountId: parent.accountId,
      athleteId,
      patch: { profileVisibility: 'PUBLIC' },
    });
    expect(await passports.bySlug(slug, { authenticated: true })).toBeUndefined();
    const { rows } = await sql<{
      restricted: boolean;
    }>`SELECT restricted FROM passport.athlete_card WHERE athlete_id = ${athleteId}`.execute(owner);
    expect(rows[0]?.restricted).toBe(true);

    await identity.revokeGuardianRelationship({
      actorAccountId: parent.accountId,
      guardianRelationshipId: guardianRelationshipId as string,
      reason: 'test',
    });
    expect(
      await identity.canOperateOnPerson(parent.accountId, childId, 'EDIT_ATHLETE_PROFILE'),
    ).toBe(false);
  });

  it('asserting guardianship over an adult does not let the asserter act for them', async () => {
    const adult = await athleteFor();
    const claimant = await newTestAccount(identity);
    await identity.assertGuardianRelationship({
      actorAccountId: claimant.accountId,
      dependentPersonId: adult.personId,
      relationshipKind: 'OTHER_RESPONSIBLE_ADULT',
      idempotencyKey: newId(),
    });
    await rejects(
      identity.updateAthleteProfile({
        actorAccountId: claimant.accountId,
        athleteId: adult.athleteId,
        patch: { displayName: 'Pwned' },
      }),
      DomainErrorCode.FORBIDDEN,
    );
  });
});

describe('organizations, memberships and invitations', () => {
  it('creates org + separate ORGANIZATION principal (no grants) + OWNER membership atomically', async () => {
    const founder = await newTestAccount(identity);
    const org = await orgFor(founder.accountId);
    expect(org.principalId).not.toBe(org.organizationId);
    const { rows } = await sql<{ principal_type: string; grants: number }>`
      SELECT p.principal_type, (SELECT count(*)::int FROM authority.authority_grant g WHERE g.grantee_principal_id = p.id) AS grants
      FROM authority.principal p WHERE p.id = ${org.principalId}`.execute(owner);
    expect(rows[0]).toEqual({ principal_type: 'ORGANIZATION', grants: 0 });
    expect(await orgs.permissions(founder.accountId, org.organizationId)).toMatchObject({
      roles: ['OWNER'],
    });
    const pub = await orgReader.bySlug(org.slug);
    expect(pub?.organization.profile.displayName).toBe('Fictional Padel Club');
  });

  it('invitations: only a hash is stored; single use; wrong person cannot accept; expiry enforced', async () => {
    const founder = await newTestAccount(identity);
    const org = await orgFor(founder.accountId);
    const invitee = await athleteFor();
    const key = newId();
    const inv = await orgs.invite({
      actorAccountId: founder.accountId,
      organizationId: org.organizationId,
      personId: invitee.personId,
      role: 'ATHLETE',
      visibility: 'PUBLIC',
      idempotencyKey: key,
    });
    expect(inv.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const replay = await orgs.invite({
      actorAccountId: founder.accountId,
      organizationId: org.organizationId,
      personId: invitee.personId,
      role: 'ATHLETE',
      visibility: 'PUBLIC',
      idempotencyKey: key,
    });
    expect(replay).toMatchObject({ membershipId: inv.membershipId, token: null });
    const { rows } = await sql<{
      token_hash: string;
    }>`SELECT token_hash FROM organizations.invitation WHERE id = ${inv.invitationId}`.execute(
      owner,
    );
    expect(rows[0]?.token_hash).toBe(hashInvitationToken(inv.token as string));
    const dump = JSON.stringify(
      (await sql`SELECT * FROM organizations.invitation`.execute(owner)).rows,
    );
    expect(dump).not.toContain(inv.token as string);

    const stranger = await newTestAccount(identity);
    await rejects(
      orgs.respondToInvitation({
        actorAccountId: stranger.accountId,
        token: inv.token as string,
        accept: true,
      }),
      DomainErrorCode.FORBIDDEN,
    );
    await rejects(
      orgs.respondToInvitation({
        actorAccountId: invitee.accountId,
        token: 'forged-token',
        accept: true,
      }),
      DomainErrorCode.INVITATION_INVALID,
    );
    expect(
      await orgs.respondToInvitation({
        actorAccountId: invitee.accountId,
        token: inv.token as string,
        accept: true,
      }),
    ).toMatchObject({ status: 'ACTIVE' });
    // repeat accept = idempotent; flip to decline = invalid
    expect(
      await orgs.respondToInvitation({
        actorAccountId: invitee.accountId,
        token: inv.token as string,
        accept: true,
      }),
    ).toMatchObject({ status: 'ACTIVE' });
    await rejects(
      orgs.respondToInvitation({
        actorAccountId: invitee.accountId,
        token: inv.token as string,
        accept: false,
      }),
      DomainErrorCode.INVITATION_INVALID,
    );

    const p = await passports.passport(invitee.athleteId, anon);
    expect(p?.affiliations.items).toEqual([
      expect.objectContaining({
        organizationSlug: org.slug,
        role: { value: 'ATHLETE', provenance: 'ORGANIZATION_CONFIRMED' },
      }),
    ]);

    const shortOrgs = new OrganizationStore(api, { invitationTtlMs: 1 });
    const late = await athleteFor();
    const expiring = await shortOrgs.invite({
      actorAccountId: founder.accountId,
      organizationId: org.organizationId,
      personId: late.personId,
      role: 'MEMBER',
      visibility: 'PUBLIC',
      idempotencyKey: newId(),
    });
    await new Promise((r) => setTimeout(r, 20));
    await rejects(
      orgs.respondToInvitation({
        actorAccountId: late.accountId,
        token: expiring.token as string,
        accept: true,
      }),
      DomainErrorCode.INVITATION_INVALID,
    );
  });

  it('concurrent acceptance of one invitation activates the membership exactly once', async () => {
    const founder = await newTestAccount(identity);
    const org = await orgFor(founder.accountId);
    const invitee = await athleteFor();
    const inv = await orgs.invite({
      actorAccountId: founder.accountId,
      organizationId: org.organizationId,
      personId: invitee.personId,
      role: 'MEMBER',
      visibility: 'MEMBERS',
      idempotencyKey: newId(),
    });
    await Promise.all(
      Array.from({ length: 5 }, () =>
        orgs.respondToInvitation({
          actorAccountId: invitee.accountId,
          token: inv.token as string,
          accept: true,
        }),
      ),
    );
    const { rows } = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM organizations.membership_status_change WHERE membership_id = ${inv.membershipId} AND status = 'ACTIVE'`.execute(
      owner,
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('application permissions: members cannot administer; ADMIN cannot create OWNERs; last OWNER is kept', async () => {
    const founder = await newTestAccount(identity);
    const org = await orgFor(founder.accountId);
    const member = await athleteFor();
    const inv = await orgs.invite({
      actorAccountId: founder.accountId,
      organizationId: org.organizationId,
      personId: member.personId,
      role: 'MEMBER',
      visibility: 'PUBLIC',
      idempotencyKey: newId(),
    });
    await orgs.respondToInvitation({
      actorAccountId: member.accountId,
      token: inv.token as string,
      accept: true,
    });
    await rejects(
      orgs.updateProfile({
        actorAccountId: member.accountId,
        organizationId: org.organizationId,
        patch: { displayName: 'Hacked' },
      }),
      DomainErrorCode.FORBIDDEN,
    );
    await rejects(
      orgs.invite({
        actorAccountId: member.accountId,
        organizationId: org.organizationId,
        personId: founder.personId as string,
        role: 'ADMIN',
        visibility: 'PRIVATE',
        idempotencyKey: newId(),
      }),
      DomainErrorCode.FORBIDDEN,
    );
    const { membershipId: adminMembership } = await orgs.changeRole({
      actorAccountId: founder.accountId,
      membershipId: inv.membershipId,
      role: 'ADMIN',
      idempotencyKey: newId(),
    });
    await rejects(
      orgs.invite({
        actorAccountId: member.accountId,
        organizationId: org.organizationId,
        personId: (await newTestAccount(identity)).personId as string,
        role: 'OWNER',
        visibility: 'PRIVATE',
        idempotencyKey: newId(),
      }),
      DomainErrorCode.FORBIDDEN,
    );
    const { rows } = await sql<{
      id: string;
    }>`SELECT id FROM organizations.membership WHERE organization_id = ${org.organizationId} AND membership_role = 'OWNER'`.execute(
      owner,
    );
    await rejects(
      orgs.setMembershipStatus({
        actorAccountId: founder.accountId,
        membershipId: rows[0]?.id as string,
        status: 'ENDED',
      }),
      DomainErrorCode.INVALID_TRANSITION,
    );
    await rejects(
      orgs.setMembershipStatus({
        actorAccountId: member.accountId,
        membershipId: rows[0]?.id as string,
        status: 'SUSPENDED',
      }),
      DomainErrorCode.FORBIDDEN,
    );
    // the admin leaves on their own
    await orgs.setMembershipStatus({
      actorAccountId: member.accountId,
      membershipId: adminMembership,
      status: 'ENDED',
    });
    expect(await orgs.permissions(member.accountId, org.organizationId)).toEqual({
      roles: [],
      permissions: [],
    });
  });

  it('membership in an org (even OWNER of a FEDERATION) grants no BRT domain capability', async () => {
    const founder = await newTestAccount(identity);
    const r = await orgs.createOrganization({
      actorAccountId: founder.accountId,
      orgType: 'FEDERATION',
      slug: uniqueSlug('fed'),
      profile: { displayName: 'Fictional Federation' },
      idempotencyKey: newId(),
    });
    const { rows } = await sql<{ n: number }>`
      SELECT (SELECT count(*) FROM authority.authority_grant WHERE grantee_principal_id = ${r.principalId})::int
           + (SELECT count(*) FROM authority.trust_anchor WHERE principal_id = ${r.principalId})::int AS n`.execute(
      owner,
    );
    expect(rows[0]?.n).toBe(0);
  });
});

describe('sports authority does not manufacture organization permissions', () => {
  it('a real AuthorityGrant to the organization principal changes no membership or application permission', async () => {
    const founder = await newTestAccount(identity);
    const outsider = await newTestAccount(identity);
    const org = await orgFor(founder.accountId);
    const before = await orgs.permissions(founder.accountId, org.organizationId);
    const authority = new AuthorityStore(api, { conflictChecker: declaredNoParticipation });
    const platform = await authority.registerPrincipal({
      principalType: 'PLATFORM',
      label: 'platform (grant test)',
    });
    await authority.recognizeTrustAnchor({
      principalId: platform.id,
      recognitionScope: { recognitionLevel: ['PLATFORM'] },
      basisRef: 'test',
      governanceDecisionRef: `test-${newId()}`,
    });
    await authority.issueGrant({
      actorPrincipalId: platform.id,
      grantorPrincipalId: platform.id,
      granteePrincipalId: org.principalId as Uuid,
      capabilities: ['GRANT_AUTHORITY', 'DECLARE_OFFICIAL', 'ACCEPT_RESULT'],
      scope: { sport: ['padel'], recognitionLevel: ['PLATFORM'], competition: [newId()] },
      delegation: { allowed: true, maxDepth: 1, capabilitiesDelegable: ['ACCEPT_RESULT'] },
    });
    expect(await orgs.permissions(outsider.accountId, org.organizationId)).toEqual({
      roles: [],
      permissions: [],
    });
    expect(await orgs.permissions(founder.accountId, org.organizationId)).toEqual(before);
    await rejects(
      orgs.updateProfile({
        actorAccountId: outsider.accountId,
        organizationId: org.organizationId,
        patch: { displayName: 'Taken over' },
      }),
      DomainErrorCode.FORBIDDEN,
    );
    const { rows } = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM organizations.membership WHERE organization_id = ${org.organizationId}`.execute(
      owner,
    );
    expect(rows[0]?.n).toBe(1);
  });
});

describe('external identities', () => {
  it('CLAIMED until the issuer organization confirms; others cannot confirm', async () => {
    const founder = await newTestAccount(identity);
    const fed = await orgFor(founder.accountId, uniqueSlug('fed'));
    const a = await athleteFor();
    const value = `LIC-${newId().slice(0, 6)}`;
    const { externalIdentityId, status } = await identity.claimExternalIdentity({
      actorAccountId: a.accountId,
      athleteId: a.athleteId,
      namespace: 'fed:license',
      issuerOrganizationId: fed.organizationId,
      externalValue: value,
      visibility: 'PUBLIC',
      idempotencyKey: newId(),
    });
    expect(status).toBe('CLAIMED');
    expect(
      (await passports.passport(a.athleteId, anon))?.externalIdentities.items[0],
    ).toMatchObject({ status: 'CLAIMED', provenance: 'SELF_DECLARED' });
    await rejects(
      identity.confirmExternalIdentity({ actorAccountId: a.accountId, externalIdentityId }),
      DomainErrorCode.FORBIDDEN,
    );
    await identity.confirmExternalIdentity({
      actorAccountId: founder.accountId,
      externalIdentityId,
    });
    expect(
      (await passports.passport(a.athleteId, anon))?.externalIdentities.items[0],
    ).toMatchObject({ status: 'CONFIRMED', provenance: 'ORGANIZATION_CONFIRMED' });
    // the same identifier cannot be confirmed for a second athlete
    const b = await athleteFor();
    const second = await identity.claimExternalIdentity({
      actorAccountId: b.accountId,
      athleteId: b.athleteId,
      namespace: 'fed:license',
      issuerOrganizationId: fed.organizationId,
      externalValue: value,
      visibility: 'PRIVATE',
      idempotencyKey: newId(),
    });
    await rejects(
      identity.confirmExternalIdentity({
        actorAccountId: founder.accountId,
        externalIdentityId: second.externalIdentityId,
      }),
      DomainErrorCode.ALREADY_EXISTS,
    );
    await identity.revokeExternalIdentity({
      actorAccountId: a.accountId,
      externalIdentityId,
      reason: 'test',
    });
    expect((await passports.passport(a.athleteId, anon))?.externalIdentities.items).toEqual([]);
  });
});

describe('wallet links (proof of control)', () => {
  const { secretKey: key, address } = generateTestWalletKey();

  it('production verifier: a real EIP-191 signature → VERIFIED; the challenge cannot be replayed', async () => {
    const a = await athleteFor();
    const ch = await productionOnly.prepareWalletLink({
      actorAccountId: a.accountId,
      personId: a.personId,
      network: 'eip155:8453',
      address,
      visibility: 'PUBLIC',
      idempotencyKey: newId(),
    });
    const signature = signEip191ForTest(ch.message, key);
    const r = await productionOnly.verifyWalletLink({
      actorAccountId: a.accountId,
      challengeId: ch.challengeId,
      signature,
      idempotencyKey: newId(),
    });
    expect(r.proofStatus).toBe('VERIFIED');
    // The stored proof (challenge message + signature) re-verifies independently, later.
    const { rows: proof } = await sql<{
      message: string;
      proof_signature: string;
      address: string;
    }>`
      SELECT c.message, w.proof_signature, w.address FROM identity.wallet_link w JOIN identity.wallet_link_challenge c ON c.id = w.challenge_id
      WHERE w.id = ${r.walletLinkId}`.execute(owner);
    const stored = proof[0] as { message: string; proof_signature: string; address: string };
    expect(
      eip155EoaPersonalSignVerifier.verify(
        { ...ch, message: stored.message, address: stored.address },
        stored.proof_signature,
      ),
    ).toBe(true);
    await rejects(
      productionOnly.verifyWalletLink({
        actorAccountId: a.accountId,
        challengeId: ch.challengeId,
        signature,
        idempotencyKey: newId(),
      }),
      DomainErrorCode.CHALLENGE_INVALID,
    );
    expect((await passports.passport(a.athleteId, anon))?.wallets.items).toEqual([
      { network: 'eip155:8453', address, proofStatus: 'VERIFIED', provenance: 'PROOF_OF_CONTROL' },
    ]);
    await identity.revokeWalletLink({
      actorAccountId: a.accountId,
      walletLinkId: r.walletLinkId,
      reason: 'test',
    });
    expect((await passports.passport(a.athleteId, anon))?.wallets.items).toEqual([]);
  });

  it('a test-verifier proof is TEST_VERIFIED, never VERIFIED; a production-only store rejects it', async () => {
    const a = await athleteFor();
    const ch = await identity.prepareWalletLink({
      actorAccountId: a.accountId,
      personId: a.personId,
      network: 'eip155:8453',
      address: '0x' + 'ab'.repeat(20),
      visibility: 'PUBLIC',
      proofScheme: 'test-signature',
      idempotencyKey: newId(),
    });
    // a production-only store does not even offer the test scheme
    await rejects(
      productionOnly.prepareWalletLink({
        actorAccountId: a.accountId,
        personId: a.personId,
        network: 'eip155:8453',
        address: '0x' + 'ab'.repeat(20),
        visibility: 'PUBLIC',
        proofScheme: 'test-signature',
        idempotencyKey: newId(),
      }),
      DomainErrorCode.INVALID_INPUT,
    );
    // a test signature on a production-scheme challenge → REJECTED, and the challenge is consumed
    const ch2 = await productionOnly.prepareWalletLink({
      actorAccountId: a.accountId,
      personId: a.personId,
      network: 'eip155:8453',
      address: '0x' + 'ab'.repeat(20),
      visibility: 'PUBLIC',
      idempotencyKey: newId(),
    });
    await rejects(
      productionOnly.verifyWalletLink({
        actorAccountId: a.accountId,
        challengeId: ch2.challengeId,
        signature: `test-signature:${ch2.nonce}`,
        idempotencyKey: newId(),
      }),
      DomainErrorCode.PROOF_INVALID,
    );
    await rejects(
      productionOnly.verifyWalletLink({
        actorAccountId: a.accountId,
        challengeId: ch2.challengeId,
        signature: `test-signature:${ch2.nonce}`,
        idempotencyKey: newId(),
      }),
      DomainErrorCode.CHALLENGE_INVALID,
    );
    // a store configured with a TEST verifier only (development) yields TEST_VERIFIED
    const devOnly = new IdentityStore(api, { walletVerifiers: [createTestWalletVerifier()] });
    const r = await devOnly.verifyWalletLink({
      actorAccountId: a.accountId,
      challengeId: ch.challengeId,
      signature: `test-signature:${ch.nonce}`,
      idempotencyKey: newId(),
    });
    expect(r.proofStatus).toBe('TEST_VERIFIED');
    expect((await passports.passport(a.athleteId, anon))?.wallets.items[0]).toMatchObject({
      proofStatus: 'TEST_VERIFIED',
      provenance: 'TEST_PROOF',
    });
  });

  it('challenges are bound to the account and expire', async () => {
    const a = await athleteFor();
    const other = await athleteFor();
    const ch = await productionOnly.prepareWalletLink({
      actorAccountId: a.accountId,
      personId: a.personId,
      network: 'eip155:1',
      address,
      visibility: 'PRIVATE',
      idempotencyKey: newId(),
    });
    await rejects(
      productionOnly.verifyWalletLink({
        actorAccountId: other.accountId,
        challengeId: ch.challengeId,
        signature: signEip191ForTest(ch.message, key),
        idempotencyKey: newId(),
      }),
      DomainErrorCode.CHALLENGE_INVALID,
    );
    await rejects(
      productionOnly.prepareWalletLink({
        actorAccountId: other.accountId,
        personId: a.personId,
        network: 'eip155:1',
        address,
        visibility: 'PRIVATE',
        idempotencyKey: newId(),
      }),
      DomainErrorCode.FORBIDDEN,
    );
    const shortLived = new IdentityStore(api, {
      walletVerifiers: [eip155EoaPersonalSignVerifier],
      walletChallengeTtlMs: 1,
    });
    const expiring = await shortLived.prepareWalletLink({
      actorAccountId: a.accountId,
      personId: a.personId,
      network: 'eip155:1',
      address,
      visibility: 'PRIVATE',
      idempotencyKey: newId(),
    });
    await new Promise((r) => setTimeout(r, 20));
    await rejects(
      shortLived.verifyWalletLink({
        actorAccountId: a.accountId,
        challengeId: expiring.challengeId,
        signature: signEip191ForTest(expiring.message, key),
        idempotencyKey: newId(),
      }),
      DomainErrorCode.CHALLENGE_INVALID,
    );
  });

  it('concurrent verification of one challenge links at most one wallet', async () => {
    const a = await athleteFor();
    const ch = await productionOnly.prepareWalletLink({
      actorAccountId: a.accountId,
      personId: a.personId,
      network: 'eip155:10',
      address,
      visibility: 'PRIVATE',
      idempotencyKey: newId(),
    });
    const sig = signEip191ForTest(ch.message, key);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        productionOnly.verifyWalletLink({
          actorAccountId: a.accountId,
          challengeId: ch.challengeId,
          signature: sig,
          idempotencyKey: newId(),
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const { rows } = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM identity.wallet_link WHERE challenge_id = ${ch.challengeId}`.execute(
      owner,
    );
    expect(rows[0]?.n).toBe(1);
  });
});

describe('PII vault and privacy', () => {
  const PII = {
    legalName: 'Zoe Ficticia Example',
    dateOfBirth: '2001-02-03',
    email: 'zoe.ficticia@example.test',
    phone: '+34600000000',
  };

  it('SELF reads/writes private data; strangers and guardians cannot; ciphertext only at rest', async () => {
    const a = await athleteFor();
    await privateData.write({ actorAccountId: a.accountId, personId: a.personId, data: PII });
    expect(await privateData.read({ actorAccountId: a.accountId, personId: a.personId })).toEqual({
      ...PII,
      erased: false,
    });
    const stranger = await newTestAccount(identity);
    await rejects(
      privateData.read({ actorAccountId: stranger.accountId, personId: a.personId }),
      DomainErrorCode.FORBIDDEN,
    );
    const { rows } =
      await sql`SELECT * FROM identity_private.person_private WHERE person_id = ${a.personId}`.execute(
        owner,
      );
    const raw = JSON.stringify(rows);
    for (const v of Object.values(PII)) expect(raw).not.toContain(v);
    await privateData.erase({ actorAccountId: a.accountId, personId: a.personId });
    expect(await privateData.read({ actorAccountId: a.accountId, personId: a.personId })).toEqual({
      legalName: null,
      dateOfBirth: null,
      email: null,
      phone: null,
      erased: true,
    });
  });

  it('no PII in outbox events, audit events, projections or idempotency records', async () => {
    const a = await athleteFor();
    await privateData.write({ actorAccountId: a.accountId, personId: a.personId, data: PII });
    const tables = [
      'platform.outbox_event',
      'platform.audit_event',
      'platform.command_idempotency',
      'passport.athlete_card',
      'passport.external_identity',
      'passport.wallet',
      'passport.affiliation',
    ];
    for (const t of tables) {
      const dump = JSON.stringify((await sql`SELECT * FROM ${sql.raw(t)}`.execute(owner)).rows);
      for (const v of Object.values(PII)) expect(dump, t).not.toContain(v);
    }
    const passport = JSON.stringify(await passports.passport(a.athleteId, anon));
    for (const v of Object.values(PII)) expect(passport).not.toContain(v);
  });

  it('a vault key mismatch fails closed with PRIVATE_DATA_UNAVAILABLE (no plaintext, no crash)', async () => {
    const a = await athleteFor();
    await privateData.write({
      actorAccountId: a.accountId,
      personId: a.personId,
      data: { email: 'other@example.test' },
    });
    const wrongKey = new PersonPrivateDataService(
      vault,
      createDevelopmentPiiCipher({ keyMaterial: DIFFERENT_TEST_KEY }),
    );
    await rejects(
      wrongKey.read({ actorAccountId: a.accountId, personId: a.personId }),
      DomainErrorCode.PRIVATE_DATA_UNAVAILABLE,
    );
  });
});

describe('passport projection rebuild', () => {
  it('a full rebuild (maintenance login, no PII access) reproduces the incremental projection exactly', async () => {
    const before = await snapshotPassports(api);
    const r = await rebuildPassports(maintenance);
    expect(r.athletes).toBeGreaterThan(0);
    expect(await snapshotPassports(api)).toEqual(before);
  });

  it('suspending an organization removes its public affiliations; reactivating restores them', async () => {
    const founder = await newTestAccount(identity);
    const org = await orgFor(founder.accountId);
    const a = await athleteFor();
    const inv = await orgs.invite({
      actorAccountId: founder.accountId,
      organizationId: org.organizationId,
      personId: a.personId,
      role: 'ATHLETE',
      visibility: 'PUBLIC',
      idempotencyKey: newId(),
    });
    await orgs.respondToInvitation({
      actorAccountId: a.accountId,
      token: inv.token as string,
      accept: true,
    });
    expect(await passports.organizationAffiliations(org.organizationId)).toHaveLength(1);
    await orgs.setStatus({
      operatorAccountId: founder.accountId,
      organizationId: org.organizationId,
      status: 'SUSPENDED',
      reason: 'test',
    });
    expect((await passports.passport(a.athleteId, anon))?.affiliations.items).toEqual([]);
    await orgs.setStatus({
      operatorAccountId: founder.accountId,
      organizationId: org.organizationId,
      status: 'ACTIVE',
      reason: 'test',
    });
    expect((await passports.passport(a.athleteId, anon))?.affiliations.items).toHaveLength(1);
  });
});

// ───────────────────────────── BRT-04R hardening ─────────────────────────────

const withEnv = async <T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T> | T,
): Promise<T> => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const settledWithin = async (p: Promise<unknown>, ms: number) =>
  Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
  ]);
const PII = { legalName: 'Toctou Ficticia', email: 'toctou@example.test' };

describe('BRT-04R · vault authorization is evaluated inside the vault transaction', () => {
  it('SELF allowed; unrelated, guardian (ACTIVE and revoked) and disabled accounts denied — and denials are audited', async () => {
    const a = await athleteFor();
    await privateData.write({ actorAccountId: a.accountId, personId: a.personId, data: PII });
    expect(
      await privateData.read({ actorAccountId: a.accountId, personId: a.personId }),
    ).toMatchObject(PII);
    const stranger = await newTestAccount(identity);
    await rejects(
      privateData.read({ actorAccountId: stranger.accountId, personId: a.personId }),
      DomainErrorCode.FORBIDDEN,
    );
    await rejects(
      privateData.write({
        actorAccountId: stranger.accountId,
        personId: a.personId,
        data: { email: 'x@example.test' },
      }),
      DomainErrorCode.FORBIDDEN,
    );

    const parent = await newTestAccount(identity, { label: 'parent' });
    const operator = await newTestAccount(identity, { withPerson: false });
    const dep = await identity.createPerson({
      actorAccountId: parent.accountId,
      relation: 'DEPENDENT',
      relationshipKind: 'PARENT',
      idempotencyKey: newId(),
    });
    const rel = dep.guardianRelationshipId as string;
    await identity.confirmGuardianRelationship({
      operatorAccountId: operator.accountId,
      guardianRelationshipId: rel,
      basis: 'PLATFORM_REVIEW',
    });
    await rejects(
      privateData.read({ actorAccountId: parent.accountId, personId: dep.personId }),
      DomainErrorCode.FORBIDDEN,
    );
    await identity.revokeGuardianRelationship({
      actorAccountId: parent.accountId,
      guardianRelationshipId: rel,
      reason: 'test',
    });
    await rejects(
      privateData.write({
        actorAccountId: parent.accountId,
        personId: dep.personId,
        data: { email: 'y@example.test' },
      }),
      DomainErrorCode.FORBIDDEN,
    );

    await identity.disableAccount({
      operatorAccountId: operator.accountId,
      accountId: a.accountId,
      reason: 'test',
    });
    await rejects(
      privateData.read({ actorAccountId: a.accountId, personId: a.personId }),
      DomainErrorCode.FORBIDDEN,
    );
    // update after revocation is refused and changes nothing
    await rejects(
      privateData.write({
        actorAccountId: a.accountId,
        personId: a.personId,
        data: { email: 'late@example.test' },
      }),
      DomainErrorCode.FORBIDDEN,
    );
    await rejects(
      privateData.erase({ actorAccountId: a.accountId, personId: a.personId }),
      DomainErrorCode.FORBIDDEN,
    );
    const { rows } = await sql<{ erased_at: Date | null; updated_at: Date }>`
      SELECT erased_at, updated_at FROM identity_private.person_private WHERE person_id = ${a.personId}`.execute(
      owner,
    );
    expect(rows[0]?.erased_at).toBeNull();
    const { rows: denied } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM platform.audit_event WHERE target_id = ${a.personId} AND outcome = 'DENIED' AND action LIKE 'vault.%'`.execute(
      owner,
    );
    expect(denied[0]?.n).toBeGreaterThanOrEqual(5);
  });

  it('race: a vault operation that starts while a revocation is in flight waits for it and then sees it', async () => {
    const a = await athleteFor();
    await privateData.write({ actorAccountId: a.accountId, personId: a.personId, data: PII });
    const operator = await newTestAccount(identity, { withPerson: false });
    const locked = deferred();
    const release = deferred();
    // An in-flight disableAccount: holds the exclusive account key and has written DISABLED, uncommitted.
    const revocation = inTransaction(api, ModuleRole.identity, async (ctx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`account:${a.accountId}`}, 0))`.execute(
        ctx.trx,
      );
      await sql`INSERT INTO identity.account_status_change (id, account_id, status, reason, actor_account_id, recorded_at)
        VALUES (${newId()}, ${a.accountId}, 'DISABLED', 'race test', ${operator.accountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const read = privateData.read({ actorAccountId: a.accountId, personId: a.personId });
    expect(await settledWithin(read, 400)).toBe(false); // blocked on the shared lock
    release.resolve();
    await revocation;
    await rejects(read, DomainErrorCode.FORBIDDEN);
  });

  it('race: a revocation that starts during an authorized vault transaction waits until it commits', async () => {
    const a = await athleteFor();
    const operator = await newTestAccount(identity, { withPerson: false });
    const authorized = deferred();
    const release = deferred();
    const vaultTx = vault.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE br_identity_private`.execute(trx);
      const { rows } = await sql<{ ok: boolean }>`
        SELECT identity_private.authorize_private_data(${a.accountId}::uuid, ${a.personId}::uuid) AS ok`.execute(
        trx,
      );
      expect(rows[0]?.ok).toBe(true);
      authorized.resolve();
      await release.promise;
    });
    await authorized.promise;
    const disable = identity.disableAccount({
      operatorAccountId: operator.accountId,
      accountId: a.accountId,
      reason: 'race',
    });
    expect(await settledWithin(disable, 400)).toBe(false); // waits for the vault transaction
    release.resolve();
    await vaultTx;
    await disable;
    await rejects(
      privateData.read({ actorAccountId: a.accountId, personId: a.personId }),
      DomainErrorCode.FORBIDDEN,
    );
  });

  it('the authorization function is SECURITY DEFINER, has a fixed search_path and is executable only by br_identity_private', async () => {
    const { rows } = await sql<{
      secdef: boolean;
      config: string[] | null;
      owner: string;
      volatile: string;
    }>`
      SELECT p.prosecdef AS secdef, p.proconfig AS config, pg_get_userbyid(p.proowner) AS owner, p.provolatile AS volatile
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'identity_private' AND p.proname = 'authorize_private_data'`.execute(owner);
    expect(rows[0]).toMatchObject({
      secdef: true,
      config: ['search_path=pg_catalog, pg_temp'],
      owner: 'br_owner',
      volatile: 'v',
    });
    const { rows: grants } = await sql<{ grantee: string }>`
      SELECT grantee FROM information_schema.routine_privileges
      WHERE routine_schema = 'identity_private' AND routine_name = 'authorize_private_data' AND privilege_type = 'EXECUTE'
      ORDER BY grantee`.execute(owner);
    expect(grants.map((g) => g.grantee).filter((g) => g !== 'br_owner')).toEqual([
      'br_identity_private',
    ]);
    for (const role of [ModuleRole.identity, ModuleRole.organizations, ModuleRole.publicRead]) {
      await expect(
        inTransaction(api, role, (ctx) =>
          sql`SELECT identity_private.authorize_private_data(${newId()}::uuid, ${newId()}::uuid)`.execute(
            ctx.trx,
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });
});

describe('BRT-04R · Athlete ↔ Person invariant (strict: every athlete has a person)', () => {
  it('the database refuses an athlete without a person', async () => {
    await expect(
      inTransaction(api, ModuleRole.identity, (ctx) =>
        sql`INSERT INTO identity.athlete (id, person_id, recorded_at) VALUES (${newId()}, NULL, ${ctx.txTime})`.execute(
          ctx.trx,
        ),
      ),
    ).rejects.toMatchObject({ code: '23502' });
    const { rows } = await sql<{ nullable: string }>`
      SELECT is_nullable AS nullable FROM information_schema.columns
      WHERE table_schema = 'identity' AND table_name = 'athlete' AND column_name = 'person_id'`.execute(
      owner,
    );
    expect(rows[0]?.nullable).toBe('NO');
  });

  it('self-service cannot create an athlete for a person the caller does not control (or that does not exist)', async () => {
    const acct = await newTestAccount(identity);
    await rejects(
      identity.createAthlete({
        actorAccountId: acct.accountId,
        personId: newId(),
        slug: uniqueSlug(),
        profile: { displayName: 'Ghost' },
        idempotencyKey: newId(),
      }),
      DomainErrorCode.FORBIDDEN,
    );
  });
});

describe('BRT-04R · Organization ↔ Principal consistency', () => {
  it('an organization cannot commit without its mapping; the mapping must target an ORGANIZATION principal; one mapping only', async () => {
    const founder = await newTestAccount(identity);
    // organization row without a mapping → deferred constraint trigger fails at COMMIT
    await expect(
      inTransaction(api, ModuleRole.organizations, (ctx) =>
        sql`INSERT INTO organizations.organization (id, org_type, created_by_account_id, recorded_at)
            VALUES (${newId()}, 'CLUB', ${founder.accountId}, ${ctx.txTime})`.execute(ctx.trx),
      ),
    ).rejects.toMatchObject({ code: 'BR002' });
    // mapping to a PERSON principal → composite FK violation
    const authority = new AuthorityStore(api, { conflictChecker: declaredNoParticipation });
    const person = await authority.registerPrincipal({
      principalType: 'PERSON',
      label: 'not an org',
    });
    await expect(
      inTransaction(api, ModuleRole.organizations, async (ctx) => {
        const orgId = newId();
        await sql`INSERT INTO organizations.organization (id, org_type, created_by_account_id, recorded_at)
            VALUES (${orgId}, 'CLUB', ${founder.accountId}, ${ctx.txTime})`.execute(ctx.trx);
        await sql`INSERT INTO organizations.organization_principal (organization_id, principal_id, recorded_at)
            VALUES (${orgId}, ${person.id}, ${ctx.txTime})`.execute(ctx.trx);
      }),
    ).rejects.toMatchObject({ code: '23503' });
    // a second mapping for an existing organization → PK violation
    const org = await orgFor(founder.accountId);
    const other = await authority.registerPrincipal({
      principalType: 'ORGANIZATION',
      label: 'second',
    });
    await expect(
      inTransaction(api, ModuleRole.organizations, (ctx) =>
        sql`INSERT INTO organizations.organization_principal (organization_id, principal_id, recorded_at)
            VALUES (${org.organizationId}, ${other.id}, ${ctx.txTime})`.execute(ctx.trx),
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('failed (lost-race) creations leave no organization without a principal and no orphan organization principal', async () => {
    const slug = uniqueSlug('race-org');
    const founders = await Promise.all(Array.from({ length: 4 }, () => newTestAccount(identity)));
    const results = await Promise.allSettled(
      founders.map((f) =>
        orgs.createOrganization({
          actorAccountId: f.accountId,
          orgType: 'CLUB',
          slug,
          profile: { displayName: 'Race Club' },
          idempotencyKey: newId(),
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const { rows } = await sql<{ orphans: number; unmapped: number }>`
      SELECT
        (SELECT count(*)::int FROM authority.principal p
          WHERE p.principal_type = 'ORGANIZATION' AND p.label LIKE 'organization:%'
            AND NOT EXISTS (SELECT 1 FROM organizations.organization_principal m WHERE m.principal_id = p.id)) AS orphans,
        (SELECT count(*)::int FROM organizations.organization o
          WHERE NOT EXISTS (SELECT 1 FROM organizations.organization_principal m WHERE m.organization_id = o.id)) AS unmapped`.execute(
      owner,
    );
    expect(rows[0]).toEqual({ orphans: 0, unmapped: 0 });
  });

  it('closing an organization keeps its principal, mapping and authority history', async () => {
    const founder = await newTestAccount(identity);
    const org = await orgFor(founder.accountId);
    const authority = new AuthorityStore(api, { conflictChecker: declaredNoParticipation });
    const platform = await authority.registerPrincipal({
      principalType: 'PLATFORM',
      label: 'platform (close test)',
    });
    await authority.recognizeTrustAnchor({
      principalId: platform.id,
      recognitionScope: { recognitionLevel: ['PLATFORM'] },
      basisRef: 'test',
      governanceDecisionRef: `test-${newId()}`,
    });
    const { grant } = await authority.issueGrant({
      actorPrincipalId: platform.id,
      grantorPrincipalId: platform.id,
      granteePrincipalId: org.principalId as Uuid,
      capabilities: ['ACCEPT_RESULT'],
      scope: { sport: ['padel'], recognitionLevel: ['PLATFORM'], competition: [newId()] },
      delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
    });
    await orgs.setStatus({
      operatorAccountId: founder.accountId,
      organizationId: org.organizationId,
      status: 'CLOSED',
      reason: 'test',
    });
    const { rows } = await sql<{ mapped: number; principal: number; grants: number }>`
      SELECT (SELECT count(*)::int FROM organizations.organization_principal WHERE organization_id = ${org.organizationId}) AS mapped,
             (SELECT count(*)::int FROM authority.principal WHERE id = ${org.principalId} AND principal_type = 'ORGANIZATION') AS principal,
             (SELECT count(*)::int FROM authority.authority_grant WHERE id = ${grant.id}) AS grants`.execute(
      owner,
    );
    expect(rows[0]).toEqual({ mapped: 1, principal: 1, grants: 1 });
    expect(await orgReader.bySlug(org.slug)).toBeUndefined();
  });
});

describe('BRT-04R · TEST_PROOF production safety', () => {
  it('a store with a TEST verifier cannot be constructed in production', async () => {
    await withEnv({ NODE_ENV: 'production' }, () => {
      const fakeTest = {
        ...eip155EoaPersonalSignVerifier,
        id: 'fake',
        kind: 'TEST' as const,
        scheme: 'test-signature' as const,
      };
      expect(() => new IdentityStore(api, { walletVerifiers: [fakeTest] })).toThrow(/production/);
      expect(
        () => new IdentityStore(api, { walletVerifiers: [eip155EoaPersonalSignVerifier] }),
      ).not.toThrow();
    });
  });

  it('even a pre-configured TEST verifier cannot activate a link while running in production', async () => {
    const a = await athleteFor();
    const devStore = new IdentityStore(api, { walletVerifiers: [createTestWalletVerifier()] });
    const ch = await devStore.prepareWalletLink({
      actorAccountId: a.accountId,
      personId: a.personId,
      network: 'eip155:1',
      address: '0x' + 'cd'.repeat(20),
      visibility: 'PUBLIC',
      proofScheme: 'test-signature',
      idempotencyKey: newId(),
    });
    await withEnv({ NODE_ENV: 'production' }, () =>
      rejects(
        devStore.verifyWalletLink({
          actorAccountId: a.accountId,
          challengeId: ch.challengeId,
          signature: `test-signature:${ch.nonce}`,
          idempotencyKey: newId(),
        }),
        DomainErrorCode.PROOF_INVALID,
      ),
    );
    const { rows } = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM identity.wallet_link WHERE challenge_id = ${ch.challengeId}`.execute(
      owner,
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('the database refuses a test-scheme link marked VERIFIED', async () => {
    const a = await athleteFor();
    const devStore = new IdentityStore(api, { walletVerifiers: [createTestWalletVerifier()] });
    const ch = await devStore.prepareWalletLink({
      actorAccountId: a.accountId,
      personId: a.personId,
      network: 'eip155:1',
      address: '0x' + 'ef'.repeat(20),
      visibility: 'PUBLIC',
      proofScheme: 'test-signature',
      idempotencyKey: newId(),
    });
    await expect(
      inTransaction(api, ModuleRole.identity, (ctx) =>
        sql`INSERT INTO identity.wallet_link (id, person_id, network, address, challenge_id, verifier_id, proof_status, proof_scheme, proof_signature, visibility, recorded_at)
            VALUES (${newId()}, ${a.personId}, 'eip155:1', ${'0x' + 'ef'.repeat(20)}, ${ch.challengeId}, 'eip155-eoa-personal-sign', 'VERIFIED', 'test-signature', 'x', 'PUBLIC', ${ctx.txTime})`.execute(
          ctx.trx,
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // and a challenge for a non-EVM network cannot even be stored
    await expect(
      inTransaction(api, ModuleRole.identity, (ctx) =>
        sql`INSERT INTO identity.wallet_link_challenge (id, person_id, account_id, network, address, visibility, nonce, purpose, proof_scheme, audience, message, expires_at, recorded_at)
            VALUES (${newId()}, ${a.personId}, ${a.accountId}, 'xrpl:0', 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', 'PUBLIC', ${newId()}, 'wallet-link', 'eip191-personal-sign', 'x', 'm',
                    ${new Date(Date.now() + 600_000)}, ${ctx.txTime})`.execute(ctx.trx),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('if TEST_VERIFIED data exists in a production database, the public passport suppresses it (never PROOF_OF_CONTROL)', async () => {
    const a = await athleteFor();
    const devStore = new IdentityStore(api, { walletVerifiers: [createTestWalletVerifier()] });
    const ch = await devStore.prepareWalletLink({
      actorAccountId: a.accountId,
      personId: a.personId,
      network: 'eip155:1',
      address: '0x' + '9a'.repeat(20),
      visibility: 'PUBLIC',
      proofScheme: 'test-signature',
      idempotencyKey: newId(),
    });
    await devStore.verifyWalletLink({
      actorAccountId: a.accountId,
      challengeId: ch.challengeId,
      signature: `test-signature:${ch.nonce}`,
      idempotencyKey: newId(),
    });
    expect((await passports.passport(a.athleteId, anon))?.wallets.items).toEqual([
      expect.objectContaining({ proofStatus: 'TEST_VERIFIED', provenance: 'TEST_PROOF' }),
    ]);
    await withEnv({ NODE_ENV: 'production' }, async () => {
      const prodReader = new PassportReader(api, { testProofs: 'LABEL' }); // cannot be overridden in production
      const p = await prodReader.passport(a.athleteId, anon);
      expect(p?.wallets.items).toEqual([]);
      expect(JSON.stringify(p)).not.toMatch(/TEST_PROOF|TEST_VERIFIED|PROOF_OF_CONTROL/);
    });
  });
});
