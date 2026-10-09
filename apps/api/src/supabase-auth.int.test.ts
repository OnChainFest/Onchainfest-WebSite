import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { newId } from '@br/domain';
import { apiDb, uniqueSlug } from '@br/testkit';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from './server';
import { createSupabaseJwtAuth } from './supabase-auth';

// ONCF-01 (ADR-0052): Supabase access tokens → AuthAdapter → IdentityStore.signIn → platform rows.
// No real Supabase project is needed: tokens are signed with a local key whose JWKS is injected.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form navigation of JSON responses
type Json = Record<string, any>;

const PROJECT = 'https://oncf01integration.supabase.co';
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const JWKS = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'int-1', alg: 'ES256' }] };

const db = apiDb();
const app = buildServer({
  db,
  auth: (identity) =>
    createSupabaseJwtAuth(
      identity,
      { projectUrl: PROJECT },
      { fetchJwks: () => Promise.resolve(JWKS) },
    ),
});
afterAll(async () => {
  await app.close();
  await db.destroy();
});

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
function supabaseToken(sub: string, extra: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: 'ES256', typ: 'JWT', kid: 'int-1' })}.${b64({
    iss: `${PROJECT}/auth/v1`,
    aud: 'authenticated',
    role: 'authenticated',
    sub,
    iat: now,
    exp: now + 600,
    aal: 'aal1',
    amr: [{ method: 'password', timestamp: now }],
    ...extra,
  })}`;
  const sig = sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${sig.toString('base64url')}`;
}
const bearer = (sub: string, extra?: Record<string, unknown>) => ({
  authorization: `Bearer ${supabaseToken(sub, extra)}`,
});
const idem = () => ({ 'idempotency-key': `k-${newId()}` });

async function call(
  method: 'GET' | 'POST',
  url: string,
  headers: Record<string, string>,
  payload?: unknown,
) {
  const res = await app.inject({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, body: res.body.length > 0 ? (res.json() as Json) : null };
}

describe('Supabase identity resolves to the platform account', () => {
  it('first call provisions an account with no person; the same sub maps to the same account', async () => {
    const sub = randomUUID();
    const first = await call('GET', '/v1/me', bearer(sub));
    expect(first.status).toBe(200);
    expect(first.body?.selfPersonId).toBeNull();
    expect(first.body?.athletes).toEqual([]);
    const again = await call('GET', '/v1/me', bearer(sub));
    expect(again.body?.accountId).toBe(first.body?.accountId);
    const other = await call('GET', '/v1/me', bearer(randomUUID()));
    expect(other.body?.accountId).not.toBe(first.body?.accountId);
    expect((await call('GET', '/v1/me/organizations', bearer(sub))).body).toEqual({ items: [] });
  });

  it('forged, anonymous and service-role tokens are 401', async () => {
    const forged = supabaseToken(randomUUID()).replace(/\.[^.]+$/, '.AAAA');
    expect((await call('GET', '/v1/me', { authorization: `Bearer ${forged}` })).status).toBe(401);
    expect((await call('GET', '/v1/me', bearer(randomUUID(), { is_anonymous: true }))).status).toBe(
      401,
    );
    expect(
      (await call('GET', '/v1/me', bearer(randomUUID(), { role: 'service_role' }))).status,
    ).toBe(401);
    expect((await call('GET', '/v1/me/organizations', {})).status).toBe(401);
  });
});

describe('onboarding persists only through the platform API', () => {
  it('athlete path: person → athlete; user_metadata claims grant nothing', async () => {
    const sub = randomUUID();
    // A token claiming to be an organization admin in metadata is still a plain new account.
    const h = bearer(sub, {
      user_metadata: { account_type: 'organization', role: 'OWNER' },
      app_metadata: { role: 'admin' },
    });
    expect((await call('GET', '/v1/me/organizations', h)).body).toEqual({ items: [] });
    const person = await call('POST', '/v1/persons', { ...h, ...idem() }, { relation: 'SELF' });
    expect(person.status).toBe(201);
    const slug = uniqueSlug('oncf01-athlete');
    const athlete = await call(
      'POST',
      '/v1/athletes',
      { ...h, ...idem() },
      { personId: person.body?.personId, slug, profile: { displayName: 'ONCF Athlete' } },
    );
    expect(athlete.status).toBe(201);
    const me = await call('GET', '/v1/me', h);
    expect(me.body?.selfPersonId).toBe(person.body?.personId);
    expect(me.body?.athletes).toEqual([
      { athleteId: athlete.body?.athleteId, personId: person.body?.personId, slug },
    ]);
  });

  it('organization path: an organization needs a person first; the creator becomes OWNER', async () => {
    const h = bearer(randomUUID());
    const slug = uniqueSlug('oncf01-club');
    const body = { orgType: 'CLUB', slug, profile: { displayName: 'ONCF Club', country: 'CR' } };
    expect((await call('POST', '/v1/organizations', { ...h, ...idem() }, body)).status).toBe(403);
    expect(
      (await call('POST', '/v1/persons', { ...h, ...idem() }, { relation: 'SELF' })).status,
    ).toBe(201);
    const k = idem();
    const org = await call('POST', '/v1/organizations', { ...h, ...k }, body);
    expect(org.status).toBe(201);
    // Retrying the same submission is idempotent.
    expect((await call('POST', '/v1/organizations', { ...h, ...k }, body)).status).toBe(200);
    const mine = await call('GET', '/v1/me/organizations', h);
    expect(mine.body?.items).toEqual([
      {
        membershipId: expect.any(String),
        organizationId: org.body?.organizationId,
        role: 'OWNER',
        orgType: 'CLUB',
        slug,
        displayName: 'ONCF Club',
      },
    ]);
    // Another account sees none of it.
    expect((await call('GET', '/v1/me/organizations', bearer(randomUUID()))).body).toEqual({
      items: [],
    });
  });
});
