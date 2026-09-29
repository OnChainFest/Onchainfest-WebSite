import { newId } from '@br/domain';
import {
  createDevelopmentPiiCipher,
  createTestWalletVerifier,
  eip155EoaPersonalSignVerifier,
  generateTestWalletKey,
} from '@br/identity';
import type { IdentityStore } from '@br/persistence';
import { apiDb, ownerDb, uniqueSlug, vaultDb } from '@br/testkit';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { createDevTokenAuth, mintDevToken } from './auth';
import { buildServer } from './server';

/**
 * BRT-04R sentinel regression: distinctive private values are written through the real API and
 * must never appear, literally, in any public DTO, outbox payload, audit entry, idempotency record,
 * passport projection or captured log line. (The authorized vault response may contain them.)
 */
const SECRET = 'privacy-int-test-auth-secret-0123456789abcdefghij';
const KEY = 'privacy-int-test-vault-key-0123456789abcdefghijk';
const tag = newId().replace(/-/g, '').slice(-10);
const S = {
  legalName: `Sentinel Legalname Q${tag}`,
  dateOfBirth: '1903-07-29',
  email: `sentinel.q${tag}@example.test`,
  phone: `+1555${tag.replace(/[a-f]/g, '7').slice(0, 7)}`,
  guardianLegalName: `Sentinel Guardian Q${tag}`,
  guardianEmail: `guardian.q${tag}@example.test`,
  privateExternalId: `PRIV-EXT-Q${tag}`,
};
const privateWallet = generateTestWalletKey().address;
const sentinels = [...Object.values(S), privateWallet];

const logLines: string[] = [];
const db = apiDb();
const vault = vaultDb();
const owner = ownerDb();
const app = buildServer({
  db,
  vaultDb: vault,
  piiCipher: createDevelopmentPiiCipher({ keyMaterial: KEY }),
  auth: (identity: IdentityStore) => createDevTokenAuth(identity, { secret: SECRET }),
  walletVerifiers: [eip155EoaPersonalSignVerifier, createTestWalletVerifier()],
  logStream: { write: (line: string) => void logLines.push(line) },
});
afterAll(async () => {
  await app.close();
  await Promise.all([db.destroy(), vault.destroy(), owner.destroy()]);
});

const bearer = (sub: string) => ({
  authorization: `Bearer ${mintDevToken(sub, { secret: SECRET })}`,
});
const idem = () => ({ 'idempotency-key': `k-${newId()}` });
async function call(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
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
    json: res.body.length > 0 ? (res.json() as Record<string, never>) : null,
  };
}
const assertAbsent = (label: string, text: string) => {
  for (const v of sentinels)
    expect(text.includes(v), `${label} contains sentinel ${v}`).toBe(false);
};

describe('sentinel-driven public/private serialization regression', () => {
  it('private values never reach public DTOs, outbox, audit, idempotency, projections or logs', async () => {
    const athleteH = bearer(`sentinel-athlete-${tag}`);
    const guardianH = bearer(`sentinel-guardian-${tag}`);
    const founderH = bearer(`sentinel-founder-${tag}`);

    const person = await call(
      'POST',
      '/v1/persons',
      { ...athleteH, ...idem() },
      { relation: 'SELF' },
    );
    const personId = person.json?.['personId'] as unknown as string;
    const slug = uniqueSlug('sentinel');
    const athlete = await call(
      'POST',
      '/v1/athletes',
      { ...athleteH, ...idem() },
      { personId, slug, profile: { displayName: 'Public Name', preferredSports: ['padel'] } },
    );
    const athleteId = athlete.json?.['athleteId'] as unknown as string;
    expect(athlete.status).toBe(201);

    // private data (athlete + guardian)
    expect(
      (
        await call('PUT', `/v1/persons/${personId}/private`, athleteH, {
          legalName: S.legalName,
          dateOfBirth: S.dateOfBirth,
          email: S.email,
          phone: S.phone,
        })
      ).status,
    ).toBe(200);
    const g = await call('POST', '/v1/persons', { ...guardianH, ...idem() }, { relation: 'SELF' });
    const guardianPersonId = g.json?.['personId'] as unknown as string;
    expect(
      (
        await call('PUT', `/v1/persons/${guardianPersonId}/private`, guardianH, {
          legalName: S.guardianLegalName,
          email: S.guardianEmail,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          'POST',
          '/v1/persons',
          { ...guardianH, ...idem() },
          { relation: 'DEPENDENT', relationshipKind: 'PARENT' },
        )
      ).status,
    ).toBe(201);

    // organization + membership, private external identity, private wallet
    expect(
      (await call('POST', '/v1/persons', { ...founderH, ...idem() }, { relation: 'SELF' })).status,
    ).toBe(201);
    const orgSlug = uniqueSlug('sentinel-club');
    const org = await call(
      'POST',
      '/v1/organizations',
      { ...founderH, ...idem() },
      { orgType: 'CLUB', slug: orgSlug, profile: { displayName: 'Sentinel Club' } },
    );
    expect(org.status).toBe(201);
    const orgId = org.json?.['organizationId'] as unknown as string;
    const inv = await call(
      'POST',
      `/v1/organizations/${orgId}/invitations`,
      { ...founderH, ...idem() },
      { personId, role: 'ATHLETE', visibility: 'PUBLIC' },
    );
    expect(inv.status).toBe(201);
    expect(
      (await call('POST', '/v1/invitations/accept', athleteH, { token: inv.json?.['token'] }))
        .status,
    ).toBe(200);
    expect(
      (
        await call(
          'POST',
          `/v1/athletes/${athleteId}/external-identities`,
          { ...athleteH, ...idem() },
          {
            namespace: 'fed:license',
            issuerOrganizationId: orgId,
            externalValue: S.privateExternalId,
            visibility: 'PRIVATE',
          },
        )
      ).status,
    ).toBe(201);
    const ch = await call(
      'POST',
      `/v1/persons/${personId}/wallet-challenges`,
      { ...athleteH, ...idem() },
      {
        network: 'eip155:1',
        address: privateWallet,
        visibility: 'PRIVATE',
        proofScheme: 'test-signature',
      },
    );
    const nonce = /Nonce: ([0-9a-f]+)/.exec(ch.json?.['message'] as unknown as string)?.[1];
    expect(
      (
        await call(
          'POST',
          '/v1/wallet-links',
          { ...athleteH, ...idem() },
          { challengeId: ch.json?.['challengeId'], signature: `test-signature:${nonce}` },
        )
      ).status,
    ).toBe(201);
    // an error path too (duplicate slug), to exercise error serialization and logging
    expect(
      (
        await call(
          'POST',
          '/v1/athletes',
          { ...athleteH, ...idem() },
          { personId, slug, profile: { displayName: 'dup' } },
        )
      ).status,
    ).toBe(409);

    // The authorized vault response does contain the data (sanity: sentinels are real).
    const own = await call('GET', `/v1/persons/${personId}/private`, athleteH);
    expect(own.text).toContain(S.email);

    // Public DTOs
    assertAbsent('athlete passport DTO', (await call('GET', `/v1/athletes/${slug}`)).text);
    assertAbsent(
      'athlete passport DTO (authenticated viewer)',
      (await call('GET', `/v1/athletes/${slug}`, founderH)).text,
    );
    assertAbsent('organization DTO', (await call('GET', `/v1/organizations/${orgSlug}`)).text);
    assertAbsent('/v1/me', (await call('GET', '/v1/me', athleteH)).text);
    assertAbsent('/v1/me (guardian)', (await call('GET', '/v1/me', guardianH)).text);
    assertAbsent(
      'org member roster',
      (await call('GET', `/v1/organizations/${orgId}/members`, founderH)).text,
    );

    // Stored non-private surfaces
    for (const table of [
      'platform.outbox_event',
      'platform.audit_event',
      'platform.command_idempotency',
      'passport.athlete_card',
      'passport.athlete_slug',
      'passport.affiliation',
      'passport.external_identity',
      'passport.wallet',
    ]) {
      assertAbsent(
        table,
        JSON.stringify((await sql`SELECT * FROM ${sql.raw(table)}`.execute(owner)).rows),
      );
    }
    // The vault itself holds ciphertext only.
    const vaultDump = JSON.stringify(
      (await sql`SELECT * FROM identity_private.person_private`.execute(owner)).rows,
    );
    for (const v of [
      S.legalName,
      S.email,
      S.phone,
      S.dateOfBirth,
      S.guardianLegalName,
      S.guardianEmail,
    ])
      expect(vaultDump.includes(v)).toBe(false);

    // Logs captured from the running server (every request above was logged).
    expect(logLines.length).toBeGreaterThan(10);
    assertAbsent('logs', logLines.join('\n'));
    expect(logLines.join('\n')).not.toMatch(/brdev\.|authorization/i);
  });
});
