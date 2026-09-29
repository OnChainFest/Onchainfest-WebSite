import { ALL_CAPABILITIES } from '@br/domain';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  assemblePassport,
  buildChallengeMessage,
  canAssignRole,
  canOperateOnPerson,
  createDevelopmentPiiCipher,
  createTestWalletVerifier,
  eip155EoaPersonalSignVerifier,
  eip191Digest,
  evmAddressOf,
  GUARDIAN_ALLOWED_OPERATIONS,
  isPassportVisible,
  normalizeSlug,
  OrganizationType,
  OrgPermission,
  PASSPORT_SCHEMA,
  permissionsForRoles,
  PersonOperation,
  RESERVED_SLUGS,
  signEip191ForTest,
  normalizeWalletTarget,
  schemeSupportsNetwork,
  walletProofProvenance,
  type PassportSource,
  type WalletChallenge,
} from './index';

describe('slugs', () => {
  it('normalizes case, whitespace, underscores and unicode compatibility forms', () => {
    expect(normalizeSlug('  Ana_Lopez  ')).toEqual({ ok: true, slug: 'ana-lopez' });
    expect(normalizeSlug('ANA   LOPEZ')).toEqual({ ok: true, slug: 'ana-lopez' });
    expect(normalizeSlug('ｃｌｕｂ-ｏｎｅ')).toEqual({ ok: true, slug: 'club-one' }); // full-width → NFKC
  });

  it('rejects invalid shapes', () => {
    for (const bad of [
      '',
      'a',
      '-abc',
      'abc-',
      'ab/cd',
      'émile',
      '..',
      'x'.repeat(51),
      'a b\u0000c',
    ]) {
      expect(normalizeSlug(bad).ok, bad).toBe(false);
    }
  });

  it('rejects reserved words in any case', () => {
    for (const r of ['admin', 'API', 'Official', 'verified', 'settings']) {
      expect(normalizeSlug(r)).toEqual({ ok: false, reason: 'RESERVED' });
    }
    expect(RESERVED_SLUGS.has('athletes')).toBe(true);
  });

  it('is idempotent (normalize(normalize(x)) = normalize(x)) and outputs only [a-z0-9-]', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (s) => {
        const r = normalizeSlug(s);
        if (!r.ok) return;
        expect(r.slug).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/);
        expect(normalizeSlug(r.slug)).toEqual(r);
      }),
    );
  });
});

describe('organization application permissions', () => {
  it('share no value with BRT domain capabilities', () => {
    const caps = new Set<string>(ALL_CAPABILITIES);
    expect(caps.size).toBeGreaterThan(5);
    for (const p of Object.values(OrgPermission)) expect(caps.has(p)).toBe(false);
  });

  it('come only from roles: OWNER/ADMIN all, STAFF view-private, others none', () => {
    expect(permissionsForRoles(['OWNER']).size).toBe(Object.values(OrgPermission).length);
    expect([...permissionsForRoles(['STAFF'])]).toEqual(['ORG_VIEW_PRIVATE']);
    for (const r of ['ATHLETE', 'COACH', 'OFFICIAL', 'MEMBER'] as const)
      expect(permissionsForRoles([r]).size).toBe(0);
  });

  it('only an OWNER can assign OWNER; ADMIN can invite non-owners; OFFICIAL role carries no authority', () => {
    expect(canAssignRole(['ADMIN'], 'OWNER', 'INVITE')).toBe(false);
    expect(canAssignRole(['OWNER'], 'OWNER', 'CHANGE')).toBe(true);
    expect(canAssignRole(['ADMIN'], 'COACH', 'INVITE')).toBe(true);
    expect(canAssignRole(['STAFF'], 'MEMBER', 'INVITE')).toBe(false);
    expect(permissionsForRoles(['OFFICIAL']).size).toBe(0);
  });

  it('organization types exclude TEAM (BRT-01 Team is a competition identity)', () => {
    expect(Object.values(OrganizationType)).not.toContain('TEAM');
  });
});

describe('person control policies', () => {
  const facts = {
    selfPersonId: 'p-self',
    activeDependentPersonIds: ['p-kid'],
    accountActive: true,
  };

  it('SELF may do everything; GUARDIAN only the allowed set; others nothing', () => {
    for (const op of Object.values(PersonOperation)) {
      expect(canOperateOnPerson(facts, 'p-self', op)).toBe(true);
      expect(canOperateOnPerson(facts, 'p-kid', op)).toBe(GUARDIAN_ALLOWED_OPERATIONS.has(op));
      expect(canOperateOnPerson(facts, 'p-stranger', op)).toBe(false);
    }
  });

  it('guardians never read private data or link wallets', () => {
    expect(canOperateOnPerson(facts, 'p-kid', 'VIEW_PRIVATE_DATA')).toBe(false);
    expect(canOperateOnPerson(facts, 'p-kid', 'LINK_WALLET')).toBe(false);
  });

  it('a disabled account controls nothing', () => {
    expect(
      canOperateOnPerson({ ...facts, accountActive: false }, 'p-self', 'EDIT_ATHLETE_PROFILE'),
    ).toBe(false);
  });
});

const source = (over: Partial<PassportSource['card']> = {}): PassportSource => ({
  card: {
    athleteId: 'a-1',
    slug: 'ana-lopez',
    displayName: 'Ana López',
    shortBio: 'I am the world champion', // self-described text: never becomes a verified fact
    homeCountry: 'ES',
    avatarRef: null,
    preferredSports: ['padel'],
    profileVisibility: 'PUBLIC',
    restricted: false,
    athleteStatus: 'ACTIVE',
    ...over,
  },
  affiliations: [
    {
      organizationId: 'o-2',
      organizationSlug: 'zeta-club',
      organizationName: 'Zeta',
      organizationType: 'CLUB',
      role: 'ATHLETE',
      since: new Date('2026-01-02T00:00:00Z'),
    },
    {
      organizationId: 'o-1',
      organizationSlug: 'alpha-club',
      organizationName: 'Alpha',
      organizationType: 'CLUB',
      role: 'COACH',
      since: new Date('2026-01-01T00:00:00Z'),
    },
  ],
  externalIdentities: [
    { namespace: 'fed:license', issuerOrganizationId: 'o-1', value: 'L-2', status: 'CONFIRMED' },
    { namespace: 'fed:license', issuerOrganizationId: null, value: 'L-1', status: 'CLAIMED' },
  ],
  wallets: [
    { network: 'eip155:8453', address: '0xbb', proofStatus: 'TEST_VERIFIED' },
    { network: 'eip155:1', address: '0xaa', proofStatus: 'VERIFIED' },
  ],
});

describe('passport assembly', () => {
  it('labels provenance honestly (development policy: test proofs LABELLED)', () => {
    const p = assemblePassport(source(), { testProofs: 'LABEL' });
    expect(p.schema).toBe(PASSPORT_SCHEMA);
    expect(p.athlete.displayName.provenance).toBe('SELF_DECLARED');
    expect(p.athlete.bio?.provenance).toBe('SELF_DECLARED');
    expect(p.affiliations.items.map((a) => a.role.provenance)).toEqual([
      'ORGANIZATION_CONFIRMED',
      'ORGANIZATION_CONFIRMED',
    ]);
    expect(p.externalIdentities.items.map((e) => [e.value, e.provenance])).toEqual([
      ['L-1', 'SELF_DECLARED'],
      ['L-2', 'ORGANIZATION_CONFIRMED'],
    ]);
    expect(p.wallets.items.map((w) => [w.address, w.provenance])).toEqual([
      ['0xaa', 'PROOF_OF_CONTROL'],
      ['0xbb', 'TEST_PROOF'],
    ]);
  });

  it('never fabricates unimplemented sections', () => {
    const p = assemblePassport(source());
    for (const s of [
      p.verifiedAchievements,
      p.records,
      p.competitionHistory,
      p.careerStats,
      p.trophies,
    ]) {
      expect(s).toEqual({ status: 'NOT_AVAILABLE', reason: 'SOURCE_NOT_IMPLEMENTED', items: [] });
    }
    expect(JSON.stringify(p)).not.toMatch(/AUTHORITY_VERIFIED/);
  });

  it('is deterministic regardless of input order', () => {
    const a = source();
    const b: PassportSource = {
      ...a,
      affiliations: [...a.affiliations].reverse(),
      externalIdentities: [...a.externalIdentities].reverse(),
      wallets: [...a.wallets].reverse(),
    };
    expect(JSON.stringify(assemblePassport(a))).toBe(JSON.stringify(assemblePassport(b)));
  });

  it('visibility: restricted/private/deactivated hidden; AUTHENTICATED needs sign-in', () => {
    const anon = { authenticated: false };
    const user = { authenticated: true };
    expect(isPassportVisible(source().card, anon)).toBe(true);
    expect(isPassportVisible(source({ restricted: true }).card, user)).toBe(false);
    expect(isPassportVisible(source({ profileVisibility: 'PRIVATE' }).card, user)).toBe(false);
    expect(isPassportVisible(source({ profileVisibility: 'AUTHENTICATED' }).card, anon)).toBe(
      false,
    );
    expect(isPassportVisible(source({ profileVisibility: 'AUTHENTICATED' }).card, user)).toBe(true);
    expect(isPassportVisible(source({ athleteStatus: 'DEACTIVATED' }).card, user)).toBe(false);
  });
});

describe('wallet proof of control', () => {
  // Public web3.js `eth.accounts.sign` vector (fictional key published in the web3.js docs).
  const WEB3_KEY = Buffer.from(
    '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318',
    'hex',
  );
  const WEB3_ADDRESS = '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23';
  const WEB3_SIG =
    '0xb91467e570a6466aa9e9876cbcd013baba02900b8979d43fe208a4a4f339f5fd6007e74cd82e037b800186422fc2da167c747ef045e5d18a5f5d4300f8e1a0291c';

  const challenge = (
    address: string,
    message?: string,
    over: Partial<Pick<WalletChallenge, 'network' | 'proofScheme' | 'nonce'>> = {},
  ): WalletChallenge => {
    const base = {
      challengeId: '00000000-0000-4000-8000-000000000001',
      network: over.network ?? 'eip155:8453',
      address,
      proofScheme: over.proofScheme ?? ('eip191-personal-sign' as const),
      nonce: over.nonce ?? '0123456789abcdef0123456789abcdef',
      purpose: 'wallet-link' as const,
      audience: 'bragging-rights.local',
      issuedAt: new Date('2026-01-01T00:00:00Z'),
      expiresAt: new Date('2026-01-01T00:10:00Z'),
    };
    return { ...base, message: message ?? buildChallengeMessage(base) };
  };

  it('matches the public EIP-191 vector (digest, address, signature)', () => {
    expect(Buffer.from(eip191Digest('Some data')).toString('hex')).toBe(
      '1da44b586eb0729ff70a73c326926f6ed5a25f5b056e7f47fbc6e58d86871655',
    );
    expect(evmAddressOf(secp256k1.getPublicKey(WEB3_KEY))).toBe(WEB3_ADDRESS);
    expect(signEip191ForTest('Some data', WEB3_KEY)).toBe(WEB3_SIG);
    expect(
      eip155EoaPersonalSignVerifier.verify(challenge(WEB3_ADDRESS, 'Some data'), WEB3_SIG),
    ).toBe(true);
  });

  it('binds address, nonce and every challenge field into the signed message', () => {
    const c = challenge(WEB3_ADDRESS);
    for (const field of [
      'Address: ',
      'Network: eip155:8453',
      'Proof Scheme: eip191-personal-sign',
      'Purpose: wallet-link',
      `Nonce: ${c.nonce}`,
      'Expires At: ',
    ]) {
      expect(c.message).toContain(field);
    }
    const sig = signEip191ForTest(c.message, WEB3_KEY);
    expect(eip155EoaPersonalSignVerifier.verify(c, sig)).toBe(true);
    // wrong address, altered message, malformed and truncated signatures are all rejected
    expect(eip155EoaPersonalSignVerifier.verify(challenge('0x' + '11'.repeat(20)), sig)).toBe(
      false,
    );
    expect(eip155EoaPersonalSignVerifier.verify({ ...c, message: c.message + ' ' }, sig)).toBe(
      false,
    );
    expect(eip155EoaPersonalSignVerifier.verify(c, sig.slice(0, -2))).toBe(false);
    expect(eip155EoaPersonalSignVerifier.verify(c, `test-signature:${c.nonce}`)).toBe(false);
  });

  it('the test verifier is marked TEST and cannot exist in production', () => {
    const v = createTestWalletVerifier();
    expect(v.kind).toBe('TEST');
    expect(v.scheme).toBe('test-signature');
    const c = challenge(WEB3_ADDRESS, undefined, { proofScheme: 'test-signature' });
    expect(v.verify(c, `test-signature:${c.nonce}`)).toBe(true);
    expect(v.verify(c, 'test-signature:other')).toBe(false);
    // it never satisfies a production-scheme challenge, nor a non-EVM network
    const prod = challenge(WEB3_ADDRESS);
    expect(v.verify(prod, `test-signature:${prod.nonce}`)).toBe(false);
    expect(v.supports('xrpl:0')).toBe(false);
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => createTestWalletVerifier()).toThrow(/not available in production/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

describe('development PII cipher', () => {
  const KEY = 'unit-test-vault-key-0123456789abcdefghijklmnop';
  const OTHER = 'unit-test-vault-key-other-0123456789abcdefghij';
  it('round-trips, binds the field name, uses fresh IVs and keyed fingerprints', () => {
    const c = createDevelopmentPiiCipher({ keyMaterial: KEY });
    const e1 = c.encrypt('email', 'ana@example.test');
    const e2 = c.encrypt('email', 'ana@example.test');
    expect(e1.ct).not.toBe(e2.ct);
    expect(JSON.stringify(e1)).not.toContain('ana@example.test');
    expect(c.decrypt('email', e1)).toBe('ana@example.test');
    expect(() => c.decrypt('phone', e1)).toThrow();
    expect(() => createDevelopmentPiiCipher({ keyMaterial: OTHER }).decrypt('email', e1)).toThrow();
    expect(c.fingerprint('x')).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(c.fingerprint('x')).not.toBe(
      createDevelopmentPiiCipher({ keyMaterial: OTHER }).fingerprint('x'),
    );
  });

  it('refuses production', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => createDevelopmentPiiCipher({ keyMaterial: KEY })).toThrow(/production/);
      expect(() => createDevelopmentPiiCipher({ ephemeral: true })).toThrow(/production/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('has no built-in key: without explicit key material or BR_VAULT_DEV_KEY it fails closed', () => {
    const prev = process.env.BR_VAULT_DEV_KEY;
    delete process.env.BR_VAULT_DEV_KEY;
    try {
      expect(() => createDevelopmentPiiCipher()).toThrow(/BR_VAULT_DEV_KEY/);
      process.env.BR_VAULT_DEV_KEY = '';
      expect(() => createDevelopmentPiiCipher()).toThrow(/BR_VAULT_DEV_KEY/);
      expect(() => createDevelopmentPiiCipher({ keyMaterial: 'too-short' })).toThrow(/at least 32/);
      process.env.BR_VAULT_DEV_KEY = KEY;
      const fromEnv = createDevelopmentPiiCipher();
      expect(fromEnv.keyId).toBe(createDevelopmentPiiCipher({ keyMaterial: KEY }).keyId);
    } finally {
      if (prev === undefined) delete process.env.BR_VAULT_DEV_KEY;
      else process.env.BR_VAULT_DEV_KEY = prev;
    }
  });

  it('an ephemeral key must be requested explicitly and is unique per instance', () => {
    const prev = process.env.BR_VAULT_DEV_KEY;
    delete process.env.BR_VAULT_DEV_KEY;
    try {
      const a = createDevelopmentPiiCipher({ ephemeral: true });
      const b = createDevelopmentPiiCipher({ ephemeral: true });
      expect(a.keyId).not.toBe(b.keyId);
      expect(() => b.decrypt('email', a.encrypt('email', 'x@example.test'))).toThrow();
    } finally {
      if (prev !== undefined) process.env.BR_VAULT_DEV_KEY = prev;
    }
  });
});

describe('wallet network / scheme boundary', () => {
  const KEY = Buffer.from(
    '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318',
    'hex',
  );
  const ADDRESS = '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23';
  const make = (over: Partial<Omit<WalletChallenge, 'message'>> = {}): WalletChallenge => {
    const base = {
      challengeId: '00000000-0000-4000-8000-000000000002',
      network: 'eip155:1',
      address: ADDRESS,
      proofScheme: 'eip191-personal-sign' as const,
      nonce: 'fedcba9876543210fedcba9876543210',
      purpose: 'wallet-link' as const,
      audience: 'bragging-rights.local',
      issuedAt: new Date('2026-01-01T00:00:00Z'),
      expiresAt: new Date('2026-01-01T00:10:00Z'),
      ...over,
    };
    return { ...base, message: buildChallengeMessage(base) };
  };

  it('schemes support only the eip155:<chainId> family', () => {
    for (const ok of ['eip155:1', 'eip155:8453', 'eip155:84532']) {
      expect(schemeSupportsNetwork('eip191-personal-sign', ok)).toBe(true);
      expect(eip155EoaPersonalSignVerifier.supports(ok)).toBe(true);
    }
    for (const bad of [
      'xrpl:0',
      'solana:mainnet',
      'bip122:000000000019d6689c085ae165831e93',
      'eip155',
      'eip155:',
      'eip155:0',
      'eip155:01',
      'eip155:abc',
      'EIP155:1',
    ]) {
      expect(schemeSupportsNetwork('eip191-personal-sign', bad), bad).toBe(false);
      expect(schemeSupportsNetwork('test-signature', bad), bad).toBe(false);
      expect(eip155EoaPersonalSignVerifier.supports(bad), bad).toBe(false);
    }
  });

  it('normalizes EVM addresses (lower-case bound into the challenge) and rejects malformed ones', () => {
    const mixed = '0x2C7536E3605D9C16a7a3D7b1898e529396a65c23';
    expect(normalizeWalletTarget('eip191-personal-sign', 'eip155:1', mixed)).toEqual({
      ok: true,
      network: 'eip155:1',
      address: ADDRESS,
    });
    for (const bad of [
      '0x1234',
      `${ADDRESS}00`,
      ADDRESS.slice(2),
      'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
      '0x' + 'g'.repeat(40),
    ]) {
      expect(normalizeWalletTarget('eip191-personal-sign', 'eip155:1', bad)).toEqual({
        ok: false,
        reason: 'INVALID_ADDRESS',
      });
    }
    expect(normalizeWalletTarget('eip191-personal-sign', 'xrpl:0', ADDRESS)).toEqual({
      ok: false,
      reason: 'UNSUPPORTED_NETWORK',
    });
  });

  it('an EIP-191 proof is rejected for a non-EVM network or a test-scheme challenge, even if the signature is valid', () => {
    const good = make();
    const sig = signEip191ForTest(good.message, KEY);
    expect(eip155EoaPersonalSignVerifier.verify(good, sig)).toBe(true);
    // Same text signed, but the challenge claims another family or scheme → refused.
    expect(eip155EoaPersonalSignVerifier.verify({ ...good, network: 'xrpl:0' }, sig)).toBe(false);
    expect(
      eip155EoaPersonalSignVerifier.verify({ ...good, proofScheme: 'test-signature' }, sig),
    ).toBe(false);
  });

  it('a proof for one network, nonce or address cannot activate another challenge', () => {
    const a = make({ network: 'eip155:1' });
    const sig = signEip191ForTest(a.message, KEY);
    expect(eip155EoaPersonalSignVerifier.verify(make({ network: 'eip155:8453' }), sig)).toBe(false);
    expect(
      eip155EoaPersonalSignVerifier.verify(
        make({ nonce: '00112233445566778899aabbccddeeff' }),
        sig,
      ),
    ).toBe(false);
    expect(
      eip155EoaPersonalSignVerifier.verify(make({ address: '0x' + '22'.repeat(20) }), sig),
    ).toBe(false);
  });
});

describe('TEST_PROOF can never become PROOF_OF_CONTROL', () => {
  it('fail-safe default suppresses test proofs; LABEL shows them as TEST_PROOF only', () => {
    const suppressed = assemblePassport(source());
    expect(suppressed.wallets.items.map((w) => [w.proofStatus, w.provenance])).toEqual([
      ['VERIFIED', 'PROOF_OF_CONTROL'],
    ]);
    const labelled = assemblePassport(source(), { testProofs: 'LABEL' });
    expect(labelled.wallets.items.find((w) => w.proofStatus === 'TEST_VERIFIED')?.provenance).toBe(
      'TEST_PROOF',
    );
    expect(walletProofProvenance('TEST_VERIFIED', 'LABEL')).toBe('TEST_PROOF');
    expect(walletProofProvenance('TEST_VERIFIED', 'SUPPRESS')).toBeUndefined();
    expect(walletProofProvenance('VERIFIED', 'SUPPRESS')).toBe('PROOF_OF_CONTROL');
    expect(walletProofProvenance('BOGUS' as never, 'LABEL')).toBeUndefined();
  });
});
