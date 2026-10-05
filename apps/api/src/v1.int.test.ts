import { newId } from '@br/domain';
import {
  createDevelopmentPiiCipher,
  createTestWalletVerifier,
  eip155EoaPersonalSignVerifier,
  generateTestWalletKey,
  signEip191ForTest,
} from '@br/identity';
import { IdentityStore } from '@br/persistence';
import { apiDb, uniqueSlug, vaultDb } from '@br/testkit';
import { afterAll, describe, expect, it } from 'vitest';
import { authFromEnvironment, createDevTokenAuth, failClosedAuth, mintDevToken } from './auth';
import { buildServer } from './server';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form navigation of JSON responses
type Json = Record<string, any>;

// Explicit test-only secrets, injected directly (there are no library defaults).
const TEST_AUTH_SECRET = 'api-int-test-auth-secret-0123456789abcdefghijkl';
const TEST_VAULT_KEY = 'api-int-test-vault-key-0123456789abcdefghijklmn';
const testAuth = (identity: IdentityStore) =>
  createDevTokenAuth(identity, { secret: TEST_AUTH_SECRET });

const db = apiDb();
const vault = vaultDb();
const app = buildServer({
  db,
  vaultDb: vault,
  piiCipher: createDevelopmentPiiCipher({ keyMaterial: TEST_VAULT_KEY }),
  auth: testAuth,
  walletVerifiers: [eip155EoaPersonalSignVerifier, createTestWalletVerifier()],
});
afterAll(async () => {
  await app.close();
  await Promise.all([db.destroy(), vault.destroy()]);
});

const bearer = (subject: string, operator = false) => ({
  authorization: `Bearer ${mintDevToken(subject, { operator, secret: TEST_AUTH_SECRET })}`,
});
const idem = () => ({ 'idempotency-key': `k-${newId()}` });

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
  return {
    status: res.statusCode,
    body: res.body.length > 0 ? (res.json() as Json) : null,
    headers: res.headers,
  };
}

async function user(label = 'user') {
  const subject = `${label}-${newId()}`;
  const h = bearer(subject);
  const person = await call('POST', '/v1/persons', { ...h, ...idem() }, { relation: 'SELF' });
  expect(person.status).toBe(201);
  return { subject, h, personId: person.body?.personId as string };
}

async function athlete(label = 'athlete') {
  const u = await user(label);
  const slug = uniqueSlug(label);
  const r = await call(
    'POST',
    '/v1/athletes',
    { ...u.h, ...idem() },
    {
      personId: u.personId,
      slug,
      profile: { displayName: 'API Test Athlete', preferredSports: ['padel'] },
    },
  );
  expect(r.status).toBe(201);
  return { ...u, athleteId: r.body?.athleteId as string, slug };
}

const sampleUrl = (url: string) =>
  url.replace(/:slug/, 'some-slug').replace(/:[A-Za-z]+Id/g, newId());

describe('endpoint classification and authentication boundary', () => {
  it('every /v1 route is classified; only GET reads are PUBLIC', () => {
    expect(app.v1Routes.length).toBeGreaterThan(20);
    for (const r of app.v1Routes) {
      expect([
        'PUBLIC',
        'AUTHENTICATED',
        'SELF',
        'GUARDIAN',
        'ORG_MEMBER',
        'ORG_ADMIN',
        'COMP_STAFF',
        // BRT-06: represents the issuer Principal (application permission, never authority).
        'ISSUER_REPRESENTATIVE',
        'INTERNAL',
      ]).toContain(r.classification);
      if (r.classification === 'PUBLIC') expect(r.method).toBe('GET');
      if (r.url.startsWith('/v1/internal/')) expect(r.classification).toBe('INTERNAL');
    }
  });

  it('every non-PUBLIC route answers 401 without credentials — and X-User-Id is never accepted', async () => {
    const victim = await user('victim');
    const { rows } = { rows: app.v1Routes.filter((r) => r.classification !== 'PUBLIC') };
    for (const r of rows) {
      for (const headers of [
        {},
        { 'x-user-id': victim.personId },
        { 'x-account-id': newId() },
        { authorization: 'Bearer not-a-token' },
      ]) {
        const res = await call(
          r.method,
          sampleUrl(r.url),
          { ...headers, ...idem() },
          r.method === 'GET' || r.method === 'DELETE' ? undefined : {},
        );
        expect(res.status, `${r.method} ${r.url} ${JSON.stringify(headers)}`).toBe(401);
        expect(res.body?.error.code).toBe('UNAUTHENTICATED');
      }
    }
  });

  it('forged, tampered and expired development tokens are rejected', async () => {
    const good = mintDevToken('someone', { secret: TEST_AUTH_SECRET });
    const [p, body, sig] = good.split('.') as [string, string, string];
    const tampered = `${p}.${Buffer.from(JSON.stringify({ sub: 'admin', iat: 1, exp: 9_999_999_999, op: true })).toString('base64url')}.${sig}`;
    const expired = mintDevToken('someone', {
      secret: TEST_AUTH_SECRET,
      ttlSeconds: 1,
      now: new Date(Date.now() - 60_000),
    });
    for (const token of [tampered, expired, `${p}.${body}.AAAA`]) {
      expect((await call('GET', '/v1/me', { authorization: `Bearer ${token}` })).status).toBe(401);
    }
    expect((await call('GET', '/v1/me', { authorization: `Bearer ${good}` })).status).toBe(200);
  });

  it('INTERNAL endpoints require the operator flag', async () => {
    const u = await user();
    const r = await call('POST', `/v1/internal/accounts/${newId()}/disable`, u.h, { reason: 'x' });
    expect(r.status).toBe(403);
  });

  it('production fails closed: no dev auth, no dev tokens, no test verifier, no dev cipher', () => {
    const prev = process.env.NODE_ENV;
    const prevDev = process.env.BR_DEV_AUTH;
    process.env.NODE_ENV = 'production';
    process.env.BR_DEV_AUTH = '1';
    try {
      const identity = new IdentityStore(db);
      expect(authFromEnvironment(identity)).toBe(failClosedAuth);
      expect(() => createDevTokenAuth(identity)).toThrow(/production/);
      expect(() => mintDevToken('x')).toThrow(/production/);
      expect(() => createTestWalletVerifier()).toThrow(/production/);
      expect(() => createDevelopmentPiiCipher()).toThrow(/production/);
    } finally {
      process.env.NODE_ENV = prev;
      if (prevDev === undefined) delete process.env.BR_DEV_AUTH;
      else process.env.BR_DEV_AUTH = prevDev;
    }
  });

  it('without a configured vault, private-data endpoints fail closed with 503', async () => {
    const bare = buildServer({ db, auth: testAuth });
    try {
      const u = await user();
      const res = await bare.inject({
        method: 'GET',
        url: `/v1/persons/${u.personId}/private`,
        headers: u.h,
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({
        error: {
          code: 'PRIVATE_DATA_UNAVAILABLE',
          message: 'private data storage is not configured',
        },
      });
    } finally {
      await bare.close();
    }
  });
});

describe('DTO validation', () => {
  it('commands require an Idempotency-Key', async () => {
    const u = await user();
    const r = await call('POST', '/v1/athletes', u.h, {
      personId: u.personId,
      slug: uniqueSlug(),
      profile: { displayName: 'X' },
    });
    expect(r.status).toBe(400);
  });

  it('unknown fields are refused (no smuggling of "verified" flags or ids)', async () => {
    const a = await athlete();
    for (const patch of [
      { verified: true },
      { displayName: 'X', provenance: 'AUTHORITY_VERIFIED' },
      { athleteId: newId() },
    ]) {
      expect((await call('PATCH', `/v1/athletes/${a.athleteId}/profile`, a.h, patch)).status).toBe(
        400,
      );
    }
  });
});

describe('authorization (SELF / GUARDIAN / ORG)', () => {
  it('another account cannot edit an athlete, read private data, link a wallet or change a slug', async () => {
    const a = await athlete();
    const stranger = await user('stranger');
    expect(
      (
        await call('PATCH', `/v1/athletes/${a.athleteId}/profile`, stranger.h, {
          displayName: 'Hijack',
        })
      ).status,
    ).toBe(403);
    expect(
      (await call('PUT', `/v1/athletes/${a.athleteId}/slug`, stranger.h, { slug: uniqueSlug() }))
        .status,
    ).toBe(403);
    expect((await call('GET', `/v1/persons/${a.personId}/private`, stranger.h)).status).toBe(403);
    expect(
      (
        await call(
          'POST',
          `/v1/persons/${a.personId}/wallet-challenges`,
          { ...stranger.h, ...idem() },
          { network: 'eip155:1', address: '0x' + '12'.repeat(20), visibility: 'PUBLIC' },
        )
      ).status,
    ).toBe(403);
  });

  it('SELF private data round trip; responses are no-store; nothing leaks to the public passport', async () => {
    const a = await athlete();
    const pii = {
      legalName: 'Api Ficticia',
      dateOfBirth: '1999-09-09',
      email: 'api.ficticia@example.test',
      phone: '+34611111111',
    };
    expect((await call('PUT', `/v1/persons/${a.personId}/private`, a.h, pii)).status).toBe(200);
    const read = await call('GET', `/v1/persons/${a.personId}/private`, a.h);
    expect(read.body).toEqual({ ...pii, erased: false });
    expect(read.headers['cache-control']).toBe('no-store');
    const pub = await call('GET', `/v1/athletes/${a.slug}`);
    for (const v of Object.values(pii)) expect(JSON.stringify(pub.body)).not.toContain(v);
  });

  it('private, restricted and unknown athletes are indistinguishable (404, same body)', async () => {
    const a = await athlete();
    await call('PATCH', `/v1/athletes/${a.athleteId}/profile`, a.h, {
      profileVisibility: 'PRIVATE',
    });
    const hidden = await call('GET', `/v1/athletes/${a.slug}`);
    const unknown = await call('GET', `/v1/athletes/${uniqueSlug('nobody')}`);
    expect(hidden).toMatchObject({ status: 404 });
    expect(hidden.body).toEqual(unknown.body);
  });

  it('guardian flow: PENDING grants nothing; operator confirmation enables the dependent athlete (restricted)', async () => {
    const parent = await user('parent');
    const dep = await call(
      'POST',
      '/v1/persons',
      { ...parent.h, ...idem() },
      { relation: 'DEPENDENT', relationshipKind: 'PARENT' },
    );
    expect(dep.body).toMatchObject({ guardianStatus: 'PENDING' });
    const slug = uniqueSlug('junior');
    const create = { personId: dep.body?.personId, slug, profile: { displayName: 'Junior' } };
    expect((await call('POST', '/v1/athletes', { ...parent.h, ...idem() }, create)).status).toBe(
      403,
    );
    const op = bearer(`operator-${newId()}`, true);
    expect(
      (
        await call(
          'POST',
          `/v1/internal/guardian-relationships/${dep.body?.guardianRelationshipId}/confirm`,
          op,
          { basis: 'PLATFORM_REVIEW' },
        )
      ).status,
    ).toBe(200);
    expect((await call('POST', '/v1/athletes', { ...parent.h, ...idem() }, create)).status).toBe(
      201,
    );
    expect((await call('GET', `/v1/athletes/${slug}`)).status).toBe(404); // minors are restricted by default
    expect((await call('GET', `/v1/persons/${dep.body?.personId}/private`, parent.h)).status).toBe(
      403,
    ); // guardians never read the vault
  });

  it('organization lifecycle through the API: invite → accept → public affiliation; members cannot administer', async () => {
    const founder = await user('founder');
    const orgSlug = uniqueSlug('club');
    const org = await call(
      'POST',
      '/v1/organizations',
      { ...founder.h, ...idem() },
      {
        orgType: 'CLUB',
        slug: orgSlug,
        profile: { displayName: 'API Fictional Club', country: 'PT' },
      },
    );
    expect(org.status).toBe(201);
    const orgId = org.body?.organizationId as string;
    const a = await athlete();
    const k = idem();
    const inv = await call(
      'POST',
      `/v1/organizations/${orgId}/invitations`,
      { ...founder.h, ...k },
      { personId: a.personId, role: 'ATHLETE', visibility: 'PUBLIC' },
    );
    expect(inv.status).toBe(201);
    expect(inv.headers['cache-control']).toBe('no-store');
    const replay = await call(
      'POST',
      `/v1/organizations/${orgId}/invitations`,
      { ...founder.h, ...k },
      { personId: a.personId, role: 'ATHLETE', visibility: 'PUBLIC' },
    );
    expect(replay).toMatchObject({
      status: 200,
      body: { token: null, membershipId: inv.body?.membershipId },
    });
    expect(
      (await call('POST', '/v1/invitations/accept', a.h, { token: inv.body?.token })).status,
    ).toBe(200);
    expect(
      (await call('PATCH', `/v1/organizations/${orgId}/profile`, a.h, { displayName: 'Hijacked' }))
        .status,
    ).toBe(403);
    const pub = await call('GET', `/v1/organizations/${orgSlug.toUpperCase()}`);
    expect(pub.body?.organization.authority).toEqual({
      status: 'NOT_AVAILABLE',
      reason: 'SOURCE_NOT_IMPLEMENTED',
    });
    expect(pub.body?.affiliations.items).toEqual([
      expect.objectContaining({
        athleteSlug: a.slug,
        role: 'ATHLETE',
        provenance: 'ORGANIZATION_CONFIRMED',
      }),
    ]);
    const passport = await call('GET', `/v1/athletes/${a.slug}`);
    expect(passport.body?.passport.affiliations.items[0]).toMatchObject({
      organizationSlug: orgSlug,
      role: { value: 'ATHLETE', provenance: 'ORGANIZATION_CONFIRMED' },
    });
    const members = await call('GET', `/v1/organizations/${orgId}/members`, a.h);
    expect(members.status).toBe(200);
    expect(JSON.stringify(members.body)).not.toMatch(/email|legalName|phone/);
  });

  it('wallet linking: production signature → VERIFIED; test signature → TEST_VERIFIED; labels in the passport', async () => {
    const a = await athlete();
    const { secretKey, address } = generateTestWalletKey();
    const ch = await call(
      'POST',
      `/v1/persons/${a.personId}/wallet-challenges`,
      { ...a.h, ...idem() },
      { network: 'eip155:8453', address, visibility: 'PUBLIC' },
    );
    expect(ch.status).toBe(201);
    const link = await call(
      'POST',
      '/v1/wallet-links',
      { ...a.h, ...idem() },
      {
        challengeId: ch.body?.challengeId,
        signature: signEip191ForTest(ch.body?.message as string, secretKey),
      },
    );
    expect(link.body).toMatchObject({ proofStatus: 'VERIFIED' });
    const test = generateTestWalletKey();
    const ch2 = await call(
      'POST',
      `/v1/persons/${a.personId}/wallet-challenges`,
      { ...a.h, ...idem() },
      {
        network: 'eip155:1',
        address: test.address,
        visibility: 'PUBLIC',
        proofScheme: 'test-signature',
      },
    );
    expect(ch2.body?.proofScheme).toBe('test-signature');
    const nonce = /Nonce: ([0-9a-f]+)/.exec(ch2.body?.message as string)?.[1];
    const link2 = await call(
      'POST',
      '/v1/wallet-links',
      { ...a.h, ...idem() },
      { challengeId: ch2.body?.challengeId, signature: `test-signature:${nonce}` },
    );
    expect(link2.body).toMatchObject({ proofStatus: 'TEST_VERIFIED' });
    const wallets = (await call('GET', `/v1/athletes/${a.slug}`)).body?.passport.wallets.items as {
      proofStatus: string;
      provenance: string;
    }[];
    expect(wallets.map((w) => [w.proofStatus, w.provenance]).sort()).toEqual([
      ['TEST_VERIFIED', 'TEST_PROOF'],
      ['VERIFIED', 'PROOF_OF_CONTROL'],
    ]);
  });

  it('wallet network boundary: non-EVM / malformed networks and addresses are refused; schemes do not cross', async () => {
    const a = await athlete();
    const { address } = generateTestWalletKey();
    const challenge = (body: Record<string, unknown>) =>
      call(
        'POST',
        `/v1/persons/${a.personId}/wallet-challenges`,
        { ...a.h, ...idem() },
        { visibility: 'PUBLIC', ...body },
      );
    for (const network of [
      'xrpl:0',
      'solana:mainnet',
      'eip155',
      'eip155:',
      'eip155:abc',
      'eip155:0',
      'EIP155:1',
    ]) {
      expect((await challenge({ network, address })).status, network).toBe(400);
    }
    for (const bad of [
      '0x1234',
      `${address}00`,
      address.replace('0x', ''),
      'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
    ]) {
      expect((await challenge({ network: 'eip155:1', address: bad })).status, bad).toBe(400);
    }
    // A production-scheme challenge cannot be satisfied by a test signature (no scheme crossing).
    const prod = await challenge({ network: 'eip155:1', address });
    expect(prod.body?.proofScheme).toBe('eip191-personal-sign');
    const nonce = /Nonce: ([0-9a-f]+)/.exec(prod.body?.message as string)?.[1];
    const crossed = await call(
      'POST',
      '/v1/wallet-links',
      { ...a.h, ...idem() },
      { challengeId: prod.body?.challengeId, signature: `test-signature:${nonce}` },
    );
    expect(crossed.status).toBe(422);
    expect(crossed.body?.error.code).toBe('PROOF_INVALID');
  });

  it('error bodies never leak SQL or internal details', async () => {
    const a = await athlete();
    const dup = await call(
      'POST',
      '/v1/athletes',
      { ...a.h, ...idem() },
      { personId: a.personId, slug: a.slug, profile: { displayName: 'dup' } },
    );
    expect(dup.status).toBe(409);
    expect(JSON.stringify(dup.body)).not.toMatch(/SELECT|INSERT|constraint|identity\.|pg_/i);
  });
});
