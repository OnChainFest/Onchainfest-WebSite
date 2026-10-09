import { DomainError, DomainErrorCode } from '@br/domain';
import {
  createDevelopmentPiiCipher,
  createTestWalletVerifier,
  type ProviderAssertion,
} from '@br/identity';
import { databaseUrls } from '../config';
import { createDb } from '../db';
import { IdentityStore } from '../identity-store';
import { OrganizationStore } from '../organization-store';
import { PersonPrivateDataService } from '../vault-store';

/**
 * BRT-04 development seed. ALL DATA IS FICTIONAL (names, identifiers, e-mail domains under
 * `.example.test`). Idempotent: fixed provider subjects and idempotency keys, so re-running converges.
 * Wallet links use the TEST verifier and are therefore TEST_VERIFIED (never VERIFIED).
 * Requires BR_VAULT_DEV_KEY (the vault data is persistent; there is no built-in key).
 * Run: BR_VAULT_DEV_KEY=... pnpm db:seed:identity
 */
if (process.env.NODE_ENV === 'production') throw new Error('development seed refuses production');

const urls = databaseUrls();
const db = createDb(urls.api);
const vaultDb = createDb(urls.vault, { max: 2 });
const identity = new IdentityStore(db, { walletVerifiers: [createTestWalletVerifier()] });
const orgs = new OrganizationStore(db);
const vault = new PersonPrivateDataService(vaultDb, createDevelopmentPiiCipher());

const tolerate = async <T>(fn: () => Promise<T>, ...codes: string[]): Promise<T | undefined> => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DomainError && codes.includes(err.code)) return undefined;
    throw err;
  }
};
const subject = (s: string): ProviderAssertion => ({
  provider: 'test',
  providerSubject: `seed:${s}`,
  method: 'TEST',
});

async function person(name: string) {
  const { accountId } = await identity.signIn(subject(name));
  const { personId } = await identity.createPerson({
    actorAccountId: accountId,
    relation: 'SELF',
    idempotencyKey: `seed:self:${name}`,
  });
  return { accountId, personId };
}

try {
  const operator = await identity.signIn(subject('operator'));
  const ana = await person('ana');
  const bruno = await person('bruno');
  const carla = await person('carla');

  const anaAthlete = await identity.createAthlete({
    actorAccountId: ana.accountId,
    personId: ana.personId,
    slug: 'ana-ficticia',
    profile: {
      displayName: 'Ana Ficticia',
      shortBio: 'Fictional padel player used for development.',
      homeCountry: 'ES',
      preferredSports: ['padel'],
    },
    idempotencyKey: 'seed:athlete:ana',
  });
  const carlaAthlete = await identity.createAthlete({
    actorAccountId: carla.accountId,
    personId: carla.personId,
    slug: 'carla-ejemplo',
    profile: {
      displayName: 'Carla Ejemplo',
      homeCountry: 'PT',
      preferredSports: ['padel', 'tennis'],
      profileVisibility: 'AUTHENTICATED',
    },
    idempotencyKey: 'seed:athlete:carla',
  });
  await vault.write({
    actorAccountId: ana.accountId,
    personId: ana.personId,
    data: { legalName: 'Ana Ficticia Ejemplo', email: 'ana@example.test' },
  });

  const club = await orgs.createOrganization({
    actorAccountId: bruno.accountId,
    orgType: 'CLUB',
    slug: 'club-ficticio-padel',
    profile: {
      displayName: 'Club Ficticio de Pádel',
      description: 'A fictional club for development.',
      country: 'ES',
      region: 'ES-M',
      website: 'https://club-ficticio.example.test',
    },
    idempotencyKey: 'seed:org:club',
  });
  const federation = await orgs.createOrganization({
    actorAccountId: bruno.accountId,
    orgType: 'FEDERATION',
    slug: 'federacion-ficticia',
    profile: {
      displayName: 'Federación Ficticia',
      description: 'Fictional federation. Listing implies no recognized authority.',
      country: 'ES',
    },
    idempotencyKey: 'seed:org:federation',
  });

  for (const [who, role] of [
    [ana, 'ATHLETE'],
    [carla, 'COACH'],
  ] as const) {
    const inv = await orgs.invite({
      actorAccountId: bruno.accountId,
      organizationId: club.organizationId,
      personId: who.personId,
      role,
      visibility: 'PUBLIC',
      idempotencyKey: `seed:invite:${role}`,
    });
    if (inv.token !== null)
      await orgs.respondToInvitation({
        actorAccountId: who.accountId,
        token: inv.token,
        accept: true,
      });
  }

  const license = await identity.claimExternalIdentity({
    actorAccountId: ana.accountId,
    athleteId: anaAthlete.athleteId,
    namespace: 'fed:license',
    issuerOrganizationId: federation.organizationId,
    externalValue: 'FICT-000123',
    visibility: 'PUBLIC',
    idempotencyKey: 'seed:extid:ana',
  });
  await tolerate(
    () =>
      identity.confirmExternalIdentity({
        actorAccountId: bruno.accountId,
        externalIdentityId: license.externalIdentityId,
      }),
    DomainErrorCode.INVALID_TRANSITION,
  );

  const challenge = await identity.prepareWalletLink({
    actorAccountId: ana.accountId,
    personId: ana.personId,
    network: 'eip155:84532',
    address: '0x000000000000000000000000000000000000dEaD',
    visibility: 'PUBLIC',
    proofScheme: 'test-signature',
    idempotencyKey: 'seed:wallet:ana',
  });
  await tolerate(
    () =>
      identity.verifyWalletLink({
        actorAccountId: ana.accountId,
        challengeId: challenge.challengeId,
        signature: `test-signature:${challenge.nonce}`,
        idempotencyKey: 'seed:wallet-verify:ana',
      }),
    DomainErrorCode.CHALLENGE_INVALID,
  );

  // A minor managed by Carla: asserted, then confirmed by a (development) platform review.
  const dependent = await identity.createPerson({
    actorAccountId: carla.accountId,
    relation: 'DEPENDENT',
    relationshipKind: 'PARENT',
    idempotencyKey: 'seed:dependent:carla',
  });
  if (dependent.guardianRelationshipId !== null) {
    await tolerate(
      () =>
        identity.confirmGuardianRelationship({
          operatorAccountId: operator.accountId,
          guardianRelationshipId: dependent.guardianRelationshipId as string,
          basis: 'PLATFORM_REVIEW',
        }),
      DomainErrorCode.INVALID_TRANSITION,
    );
  }
  const junior = await identity.createAthlete({
    actorAccountId: carla.accountId,
    personId: dependent.personId,
    slug: 'junior-ejemplo',
    profile: { displayName: 'Junior Ejemplo', preferredSports: ['padel'] },
    idempotencyKey: 'seed:athlete:junior',
  });

  console.log(
    JSON.stringify(
      {
        fictionalDataOnly: true,
        athletes: {
          ana: anaAthlete.slug,
          carla: `${carlaAthlete.slug} (AUTHENTICATED only)`,
          junior: `${junior.slug} (minor: restricted, not public)`,
        },
        organizations: { club: club.slug, federation: federation.slug },
        devTokens:
          'pnpm --filter @br/api dev-token seed:ana   (subjects: seed:ana, seed:bruno, seed:carla, seed:operator --operator)',
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.all([db.destroy(), vaultDb.destroy()]);
}
