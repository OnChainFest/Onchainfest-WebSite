import { randomBytes } from 'node:crypto';
import { newId } from '@br/domain';
import {
  createDevelopmentPiiCipher,
  createTestWalletVerifier,
  eip155EoaPersonalSignVerifier,
  generateTestWalletKey,
  signEip191ForTest,
} from '@br/identity';
import {
  createDb,
  databaseUrls,
  inTransaction,
  ModuleRole,
  rebuildPassports,
  snapshotPassports,
} from '@br/persistence';
import { sql } from 'kysely';
import { createDevTokenAuth, mintDevToken } from '../auth';
import { buildServer } from '../server';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form navigation of JSON responses
type Json = Record<string, any>;

/**
 * BRT-04 acceptance walkthrough (20 steps) through the real /v1 HTTP surface (in-process inject).
 * ALL DATA IS FICTIONAL. Development only (dev tokens and the test wallet verifier refuse production).
 * Run: pnpm db:up && pnpm db:bootstrap && pnpm db:migrate && pnpm demo:identity
 */
// No built-in secrets. The dev-auth HMAC secret is random per run (tokens never leave this
// process). The vault key comes from BR_VAULT_DEV_KEY if set; otherwise an EPHEMERAL key is
// requested explicitly — the demo's private rows are then unreadable after the run, by design.
const devAuthSecret = randomBytes(32).toString('hex');
const vaultKeyFromEnv = (process.env.BR_VAULT_DEV_KEY ?? '') !== '';
const urls = databaseUrls();
const db = createDb(urls.api);
const vaultDb = createDb(urls.vault, { max: 2 });
const maintenanceDb = createDb(urls.maintenance, { max: 2 });
const app = buildServer({
  db,
  vaultDb,
  piiCipher: createDevelopmentPiiCipher(vaultKeyFromEnv ? {} : { ephemeral: true }),
  auth: (identity) => createDevTokenAuth(identity, { secret: devAuthSecret }),
  walletVerifiers: [eip155EoaPersonalSignVerifier, createTestWalletVerifier()],
});

const run = newId().replace(/-/g, '').slice(-8);
let step = 0;
const show = (title: string, detail: unknown) =>
  console.log(
    `\n▶ ${String(++step).padStart(2, '0')}. ${title}\n   ${typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2).replaceAll('\n', '\n   ')}`,
  );
const bearer = (s: string, operator = false) => ({
  authorization: `Bearer ${mintDevToken(`demo-${run}-${s}`, { operator, secret: devAuthSecret })}`,
});
const idem = () => ({ 'idempotency-key': `demo-${newId()}` });

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
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
  const body = res.body.length > 0 ? (res.json() as Json) : null;
  return { status: res.statusCode, body };
}
function expectStatus<T extends { status: number; body: unknown }>(
  r: T,
  status: number,
  what: string,
): T {
  if (r.status !== status)
    throw new Error(`${what}: expected HTTP ${status}, got ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}

try {
  const ana = bearer('ana');
  const bruno = bearer('bruno');
  const stranger = bearer('stranger');
  const parent = bearer('parent');
  const operator = bearer('operator', true);

  const health = await call('GET', '/health');
  const ready = await call('GET', '/ready');
  show('Service health and readiness', { health: health.body, ready: ready.body });

  const noAuth = await call('GET', '/v1/me');
  const spoof = await call('GET', '/v1/me', { 'x-user-id': newId() });
  show('No credentials / X-User-Id spoofing → 401 (fails closed)', {
    noAuth: noAuth.status,
    xUserId: spoof.status,
  });

  const me = expectStatus(await call('GET', '/v1/me', ana), 200, 'me');
  show('Ana signs in (provider "test"): an Account exists, but no Person yet', me.body);

  const anaPerson = expectStatus(
    await call('POST', '/v1/persons', { ...ana, ...idem() }, { relation: 'SELF' }),
    201,
    'person',
  );
  const anaPersonId = anaPerson.body?.personId as string;
  show('Ana creates her own Person (SELF control)', anaPerson.body);

  const priv = expectStatus(
    await call('PUT', `/v1/persons/${anaPersonId}/private`, ana, {
      legalName: 'Ana Demo Ficticia',
      dateOfBirth: '1998-04-12',
      email: `ana.${run}@example.test`,
    }),
    200,
    'vault write',
  );
  show(
    'Private data goes to the PII vault (separate login, AES-256-GCM envelopes); only field names are echoed',
    priv.body,
  );

  const anaSlug = `Ana_Demo_${run}`;
  const athlete = expectStatus(
    await call(
      'POST',
      '/v1/athletes',
      { ...ana, ...idem() },
      {
        personId: anaPersonId,
        slug: anaSlug,
        profile: {
          displayName: 'Ana Demo',
          shortBio: 'World champion (self-described)',
          homeCountry: 'ES',
          preferredSports: ['padel'],
        },
      },
    ),
    201,
    'athlete',
  );
  const anaAthleteId = athlete.body?.athleteId as string;
  show(`Ana becomes an Athlete; slug "${anaSlug}" is normalized`, athlete.body);

  const pass1 = expectStatus(
    await call('GET', `/v1/athletes/${athlete.body?.slug}`),
    200,
    'passport',
  );
  const p1 = pass1.body?.passport;
  show(
    'Public passport: self-described fields are labelled SELF_DECLARED; future sections are NOT_AVAILABLE (never fabricated)',
    {
      displayName: p1.athlete.displayName,
      bio: p1.athlete.bio,
      verifiedAchievements: p1.verifiedAchievements,
      records: p1.records.status,
      trophies: p1.trophies.status,
    },
  );

  const brunoPerson = expectStatus(
    await call('POST', '/v1/persons', { ...bruno, ...idem() }, { relation: 'SELF' }),
    201,
    'bruno person',
  );
  const reserved = await call(
    'POST',
    '/v1/athletes',
    { ...bruno, ...idem() },
    { personId: brunoPerson.body?.personId, slug: 'Admin', profile: { displayName: 'Bruno' } },
  );
  const taken = await call(
    'POST',
    '/v1/athletes',
    { ...bruno, ...idem() },
    {
      personId: brunoPerson.body?.personId,
      slug: athlete.body?.slug,
      profile: { displayName: 'Bruno' },
    },
  );
  show('Slug rules: reserved words and taken slugs are refused', {
    reserved: reserved.body?.error,
    taken: taken.body?.error,
  });

  const newSlug = `ana-padel-${run}`;
  expectStatus(
    await call('PUT', `/v1/athletes/${anaAthleteId}/slug`, ana, { slug: newSlug }),
    200,
    'slug change',
  );
  const old = await call('GET', `/v1/athletes/${athlete.body?.slug}`);
  show('Slug change: the former slug still resolves and asks clients to redirect (no hijacking)', {
    canonicalSlug: old.body?.canonicalSlug,
    redirected: old.body?.redirected,
  });

  const clubSlug = `club-demo-${run}`;
  const club = expectStatus(
    await call(
      'POST',
      '/v1/organizations',
      { ...bruno, ...idem() },
      {
        orgType: 'CLUB',
        slug: clubSlug,
        profile: { displayName: 'Club Demo Ficticio', country: 'ES' },
      },
    ),
    201,
    'org',
  );
  const clubId = club.body?.organizationId as string;
  const grants = await inTransaction(
    db,
    ModuleRole.authority,
    async (ctx) =>
      (
        await sql<{
          n: number;
        }>`SELECT count(*)::int AS n FROM authority.authority_grant WHERE grantee_principal_id = ${club.body?.principalId}`.execute(
          ctx.trx,
        )
      ).rows[0]?.n,
  );
  show(
    'Bruno creates a CLUB: separate ORGANIZATION principal, OWNER membership, zero authority grants',
    { ...club.body, authorityGrants: grants },
  );

  const inviteKey = idem();
  const invite = expectStatus(
    await call(
      'POST',
      `/v1/organizations/${clubId}/invitations`,
      { ...bruno, ...inviteKey },
      { personId: anaPersonId, role: 'ATHLETE', visibility: 'PUBLIC' },
    ),
    201,
    'invite',
  );
  const replay = await call(
    'POST',
    `/v1/organizations/${clubId}/invitations`,
    { ...bruno, ...inviteKey },
    { personId: anaPersonId, role: 'ATHLETE', visibility: 'PUBLIC' },
  );
  show(
    'Invitation: the token is shown once (only its SHA-256 is stored); an idempotent replay cannot recover it',
    {
      token: `${String(invite.body?.token).slice(0, 6)}… (redacted)`,
      expiresAt: invite.body?.expiresAt,
      replayToken: replay.body?.token,
    },
  );

  const strangerPerson = await call(
    'POST',
    '/v1/persons',
    { ...stranger, ...idem() },
    { relation: 'SELF' },
  );
  const hijack = await call('POST', '/v1/invitations/accept', stranger, {
    token: invite.body?.token,
  });
  const accepted = expectStatus(
    await call('POST', '/v1/invitations/accept', ana, { token: invite.body?.token }),
    200,
    'accept',
  );
  show("A stranger cannot use Ana's invitation; Ana accepts it", {
    strangerPerson: strangerPerson.status,
    stranger: hijack.body?.error,
    ana: accepted.body,
  });

  const pass2 = await call('GET', `/v1/athletes/${newSlug}`);
  const orgPage = await call('GET', `/v1/organizations/${clubSlug}`);
  show(
    'Affiliation appears on the passport (ORGANIZATION_CONFIRMED) and on the club page; the club shows no authority',
    {
      passportAffiliations: pass2.body?.passport.affiliations.items,
      clubAthletes: orgPage.body?.affiliations.items,
      clubAuthority: orgPage.body?.organization.authority,
    },
  );

  const ext = expectStatus(
    await call(
      'POST',
      `/v1/athletes/${anaAthleteId}/external-identities`,
      { ...ana, ...idem() },
      {
        namespace: 'club:member-number',
        issuerOrganizationId: clubId,
        externalValue: `CM-${run}`,
        visibility: 'PUBLIC',
      },
    ),
    201,
    'claim',
  );
  show(
    'Ana claims an external identifier: CLAIMED (self-declared), not confirmed by being typed in',
    ext.body,
  );

  const anaConfirm = await call(
    'POST',
    `/v1/external-identities/${ext.body?.externalIdentityId}/confirm`,
    ana,
  );
  expectStatus(
    await call('POST', `/v1/external-identities/${ext.body?.externalIdentityId}/confirm`, bruno),
    200,
    'confirm',
  );
  const pass3 = await call('GET', `/v1/athletes/${newSlug}`);
  show('Only the issuer organization can confirm it', {
    anaSelfConfirm: anaConfirm.body?.error,
    passport: pass3.body?.passport.externalIdentities.items,
  });

  const wallet = generateTestWalletKey();
  const ch = expectStatus(
    await call(
      'POST',
      `/v1/persons/${anaPersonId}/wallet-challenges`,
      { ...ana, ...idem() },
      { network: 'eip155:8453', address: wallet.address, visibility: 'PUBLIC' },
    ),
    201,
    'challenge',
  );
  const sig = signEip191ForTest(ch.body?.message as string, wallet.secretKey);
  const linked = expectStatus(
    await call(
      'POST',
      '/v1/wallet-links',
      { ...ana, ...idem() },
      { challengeId: ch.body?.challengeId, signature: sig },
    ),
    201,
    'link',
  );
  const replayed = await call(
    'POST',
    '/v1/wallet-links',
    { ...ana, ...idem() },
    { challengeId: ch.body?.challengeId, signature: sig },
  );
  show('Wallet link with a real EIP-191 signature → VERIFIED; replaying the challenge fails', {
    challenge: ch.body?.message.split('\n').slice(2, 6),
    link: linked.body,
    replay: replayed.body?.error,
  });

  const other = generateTestWalletKey();
  const ch2 = expectStatus(
    await call(
      'POST',
      `/v1/persons/${anaPersonId}/wallet-challenges`,
      { ...ana, ...idem() },
      {
        network: 'eip155:84532',
        address: other.address,
        visibility: 'PUBLIC',
        proofScheme: 'test-signature',
      },
    ),
    201,
    'challenge 2',
  );
  const nonce = /Nonce: ([0-9a-f]+)/.exec(ch2.body?.message as string)?.[1];
  const testLink = expectStatus(
    await call(
      'POST',
      '/v1/wallet-links',
      { ...ana, ...idem() },
      { challengeId: ch2.body?.challengeId, signature: `test-signature:${nonce}` },
    ),
    201,
    'test link',
  );
  const pass4 = await call('GET', `/v1/athletes/${newSlug}`);
  show('A development test proof is only ever TEST_VERIFIED and labelled TEST_PROOF', {
    link: testLink.body,
    wallets: pass4.body?.passport.wallets.items,
  });

  expectStatus(
    await call('POST', '/v1/persons', { ...parent, ...idem() }, { relation: 'SELF' }),
    201,
    'parent person',
  );
  const dep = expectStatus(
    await call(
      'POST',
      '/v1/persons',
      { ...parent, ...idem() },
      { relation: 'DEPENDENT', relationshipKind: 'PARENT' },
    ),
    201,
    'dependent',
  );
  const juniorSlug = `junior-${run}`;
  const early = await call(
    'POST',
    '/v1/athletes',
    { ...parent, ...idem() },
    { personId: dep.body?.personId, slug: juniorSlug, profile: { displayName: 'Junior Demo' } },
  );
  expectStatus(
    await call(
      'POST',
      `/v1/internal/guardian-relationships/${dep.body?.guardianRelationshipId}/confirm`,
      operator,
      { basis: 'PLATFORM_REVIEW' },
    ),
    200,
    'confirm guardian',
  );
  expectStatus(
    await call(
      'POST',
      '/v1/athletes',
      { ...parent, ...idem() },
      { personId: dep.body?.personId, slug: juniorSlug, profile: { displayName: 'Junior Demo' } },
    ),
    201,
    'junior',
  );
  const juniorPublic = await call('GET', `/v1/athletes/${juniorSlug}`);
  const guardianVault = await call('GET', `/v1/persons/${dep.body?.personId}/private`, parent);
  show(
    "Minor: asserted guardianship grants nothing until confirmed; the minor's passport is restricted; guardians cannot read the vault",
    {
      beforeConfirmation: early.body?.error,
      publicPassport: juniorPublic.status,
      guardianReadsVault: guardianVault.status,
    },
  );

  const memberEdit = await call('PATCH', `/v1/organizations/${clubId}/profile`, ana, {
    displayName: 'Hijacked',
  });
  const members = await call('GET', `/v1/organizations/${clubId}/members`, ana);
  show(
    'Membership ≠ admin: Ana (ATHLETE) cannot edit the club; the roster contains ids and roles only',
    { edit: memberEdit.body?.error, members: members.body?.items.length },
  );

  const before = await snapshotPassports(db);
  const rebuilt = await rebuildPassports(maintenanceDb);
  const after = await snapshotPassports(db);
  const piiLeaks = await inTransaction(db, ModuleRole.identity, async (ctx) => {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM platform.outbox_event WHERE payload::text ILIKE ${'%Ana Demo Ficticia%'} OR payload::text ILIKE ${`%ana.${run}@example.test%`} OR payload::text LIKE '%1998-04-12%'`.execute(
      ctx.trx,
    );
    return rows[0]?.n;
  });
  show(
    'Passport rebuilt from canonical tables by the maintenance login (no PII access) equals the incremental projection; no PII in outbox',
    {
      athletesRebuilt: rebuilt.athletes,
      identical: JSON.stringify(before) === JSON.stringify(after),
      outboxEventsContainingPii: piiLeaks,
    },
  );

  if (step !== 20) throw new Error(`demo expected 20 steps, ran ${step}`);
  console.log('\n✔ BRT-04 demo completed: 20/20 steps.');
} finally {
  await app.close();
  await Promise.all([db.destroy(), vaultDb.destroy(), maintenanceDb.destroy()]);
}
