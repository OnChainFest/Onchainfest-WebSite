import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { IdentityStore } from '@br/persistence';
import type { FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { authFromEnvironment, failClosedAuth } from './auth';
import {
  createSupabaseJwtAuth,
  normalizeProjectUrl,
  parseJwks,
  type JwksFetcher,
} from './supabase-auth';

const PROJECT = 'https://abcdefghijklmnop.supabase.co';
const ISSUER = `${PROJECT}/auth/v1`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const NOW = new Date('2026-10-06T12:00:00Z');
const nowS = NOW.getTime() / 1000;

const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherEc = generateKeyPairSync('ec', { namedCurve: 'P-256' });

const jwk = (key: KeyObject, kid: string, alg: string) => ({
  ...key.export({ format: 'jwk' }),
  kid,
  alg,
  use: 'sig',
});
const JWKS = { keys: [jwk(ec.publicKey, 'ec-1', 'ES256'), jwk(rsa.publicKey, 'rsa-1', 'RS256')] };

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

function token(
  claims: Record<string, unknown> = {},
  opts: { kid?: string; alg?: 'ES256' | 'RS256'; key?: KeyObject; header?: object } = {},
): string {
  const alg = opts.alg ?? 'ES256';
  const header = { alg, typ: 'JWT', kid: opts.kid ?? (alg === 'ES256' ? 'ec-1' : 'rsa-1') };
  const payload = {
    iss: ISSUER,
    aud: 'authenticated',
    sub: '5b1f0c1e-7d3a-4e8e-9a51-0c2f3f9e1a11',
    role: 'authenticated',
    iat: nowS - 60,
    exp: nowS + 3600,
    aal: 'aal1',
    amr: [{ method: 'password', timestamp: nowS - 60 }],
    is_anonymous: false,
    ...claims,
  };
  const input = `${b64({ ...header, ...opts.header })}.${b64(payload)}`;
  const key = opts.key ?? (alg === 'ES256' ? ec.privateKey : rsa.privateKey);
  const sig =
    alg === 'ES256'
      ? sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' })
      : sign('sha256', Buffer.from(input), key);
  return `${input}.${sig.toString('base64url')}`;
}

function fakeIdentity() {
  const calls: unknown[] = [];
  const identity = {
    signIn: (assertion: unknown) => {
      calls.push(assertion);
      return Promise.resolve({ accountId: 'acc-1', authIdentityId: 'aid-1', created: false });
    },
  } as unknown as IdentityStore;
  return { identity, calls };
}

function adapter(fetchJwks: JwksFetcher = () => Promise.resolve(JWKS), now = () => NOW) {
  const { identity, calls } = fakeIdentity();
  return {
    auth: createSupabaseJwtAuth(identity, { projectUrl: PROJECT }, { fetchJwks, now }),
    calls,
  };
}

const req = (authorization?: string) =>
  ({ headers: authorization === undefined ? {} : { authorization } }) as FastifyRequest;

describe('Supabase access tokens resolve to the platform account through IdentityStore.signIn', () => {
  it('a valid ES256 user token → AuthContext; identity is (supabase, sub) and nothing else', async () => {
    const { auth, calls } = adapter();
    const ctx = await auth.authenticate(
      req(`Bearer ${token({ user_metadata: { account_type: 'organization', role: 'admin' } })}`),
    );
    expect(ctx).toEqual({
      accountId: 'acc-1',
      authIdentityId: 'aid-1',
      authenticationMethod: 'PASSWORD',
      authenticatedAt: new Date((nowS - 60) * 1000),
      assurance: 'aal1',
    });
    expect(calls).toEqual([
      {
        provider: 'supabase',
        providerSubject: '5b1f0c1e-7d3a-4e8e-9a51-0c2f3f9e1a11',
        method: 'PASSWORD',
      },
    ]);
  });

  it('RS256 keys are supported; OAuth sessions map to OIDC and magic links to EMAIL_LINK', async () => {
    const { auth } = adapter();
    const oauth = await auth.authenticate(
      req(`Bearer ${token({ amr: [{ method: 'oauth', timestamp: nowS }] }, { alg: 'RS256' })}`),
    );
    expect(oauth?.authenticationMethod).toBe('OIDC');
    const link = await auth.authenticate(
      req(`Bearer ${token({ amr: [{ method: 'totp' }, { method: 'otp', timestamp: nowS }] })}`),
    );
    expect(link?.authenticationMethod).toBe('EMAIL_LINK');
  });

  it.each([
    ['no header', undefined],
    ['not a bearer', 'Basic abc'],
    ['garbage', 'Bearer not.a.jwt'],
    ['dev token shape', 'Bearer brdev.e30.sig'],
  ])('rejects %s', async (_label, header) => {
    const { auth, calls } = adapter();
    expect(await auth.authenticate(req(header))).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['wrong issuer', { iss: 'https://evil.supabase.co/auth/v1' }],
    ['wrong audience', { aud: 'other' }],
    ['expired', { exp: nowS - 3600 }],
    ['issued in the future', { iat: nowS + 3600 }],
    ['not yet valid', { nbf: nowS + 3600 }],
    ['anon API key', { role: 'anon' }],
    ['service_role API key', { role: 'service_role', sub: undefined }],
    ['anonymous sign-in', { is_anonymous: true }],
    ['missing sub', { sub: '' }],
    ['unknown first factor', { amr: [{ method: 'something-new' }] }],
    ['no amr', { amr: undefined }],
  ])('rejects a correctly signed token with %s', async (_label, claims) => {
    const { auth, calls } = adapter();
    expect(await auth.authenticate(req(`Bearer ${token(claims)}`))).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('rejects bad signatures, unknown kids, alg confusion and alg=none', async () => {
    const { auth } = adapter();
    const forged = token({}, { key: otherEc.privateKey });
    expect(await auth.authenticate(req(`Bearer ${forged}`))).toBeNull();
    expect(await auth.authenticate(req(`Bearer ${token({}, { kid: 'nope' })}`))).toBeNull();
    // An RS256-signed token presented under the EC key id.
    const confused = token({}, { alg: 'RS256', kid: 'ec-1' });
    expect(await auth.authenticate(req(`Bearer ${confused}`))).toBeNull();
    const [, payload] = token().split('.');
    const none = `${b64({ alg: 'none', typ: 'JWT', kid: 'ec-1' })}.${payload}.`;
    expect(await auth.authenticate(req(`Bearer ${none}`))).toBeNull();
    const hs = token({}, { header: { alg: 'HS256' } });
    expect(await auth.authenticate(req(`Bearer ${hs}`))).toBeNull();
  });

  it('an unreachable JWKS endpoint fails closed (no exception, no fallback trust)', async () => {
    const { auth, calls } = adapter(() => Promise.reject(new Error('network down')));
    expect(await auth.authenticate(req(`Bearer ${token()}`))).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('caches keys, and rate-limits refetches triggered by unknown kids', async () => {
    const urls: string[] = [];
    let t = NOW.getTime();
    const { auth } = adapter(
      (url) => {
        urls.push(url);
        return Promise.resolve(JWKS);
      },
      () => new Date(t),
    );
    await auth.authenticate(req(`Bearer ${token()}`));
    await auth.authenticate(req(`Bearer ${token()}`));
    expect(urls).toEqual([JWKS_URL]);
    for (let i = 0; i < 5; i += 1)
      await auth.authenticate(req(`Bearer ${token({}, { kid: `x${i}` })}`));
    expect(urls).toHaveLength(1);
    t += 31_000;
    await auth.authenticate(req(`Bearer ${token({}, { kid: 'rotated' })}`));
    expect(urls).toHaveLength(2);
  });
});

describe('JWKS parsing and configuration', () => {
  it('skips symmetric, private, encryption and weak keys', () => {
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const keys = parseJwks({
      keys: [
        { kty: 'oct', k: 'c2VjcmV0', kid: 'sym' },
        { ...ec.privateKey.export({ format: 'jwk' }), kid: 'priv' },
        { ...jwk(ec.publicKey, 'enc', 'ES256'), use: 'enc' },
        jwk(weak.publicKey, 'weak', 'RS256'),
        jwk(ec.publicKey, 'good', 'ES256'),
      ],
    });
    expect([...keys.keys()]).toEqual(['good']);
    expect(parseJwks(null).size).toBe(0);
  });

  it('project URL must be https (http only for a local stack outside production)', () => {
    expect(normalizeProjectUrl(`${PROJECT}/`)).toBe(PROJECT);
    expect(normalizeProjectUrl('http://127.0.0.1:54321')).toBe('http://127.0.0.1:54321');
    expect(() => normalizeProjectUrl('http://example.com')).toThrow(/https/);
    expect(() => normalizeProjectUrl(`${PROJECT}?x=1`)).toThrow(/bare/);
    expect(() => normalizeProjectUrl('nope')).toThrow(/valid URL/);
  });
});

describe('authFromEnvironment selects the identity provider explicitly', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ['NODE_ENV', 'BR_AUTH_PROVIDER', 'BR_SUPABASE_URL', 'BR_DEV_AUTH']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const identity = {} as IdentityStore;

  it('BR_AUTH_PROVIDER=supabase works in production and requires BR_SUPABASE_URL', () => {
    process.env.NODE_ENV = 'production';
    process.env.BR_AUTH_PROVIDER = 'supabase';
    delete process.env.BR_SUPABASE_URL;
    expect(() => authFromEnvironment(identity)).toThrow(/BR_SUPABASE_URL/);
    process.env.BR_SUPABASE_URL = 'http://127.0.0.1:54321';
    expect(() => authFromEnvironment(identity)).toThrow(/production/);
    process.env.BR_SUPABASE_URL = PROJECT;
    expect(authFromEnvironment(identity).id).toBe('supabase-jwt');
  });

  it('an unknown provider refuses to start; unset keeps the fail-closed default', () => {
    process.env.BR_AUTH_PROVIDER = 'clerk';
    expect(() => authFromEnvironment(identity)).toThrow(/unknown BR_AUTH_PROVIDER/);
    delete process.env.BR_AUTH_PROVIDER;
    process.env.NODE_ENV = 'production';
    expect(authFromEnvironment(identity)).toBe(failClosedAuth);
  });
});
