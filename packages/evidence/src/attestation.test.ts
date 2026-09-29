import { hashEvidenceBytes } from '@br/canonical';
import { newId, type KeyStatusChange, type PrincipalKey, type Uuid } from '@br/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildAttestationStatement,
  buildKeyRegistrationStatement,
  buildRetractionStatement,
  createEphemeralSigner,
  evaluateKeyAdmissibility,
  hashStatement,
  jwsDetachedVerifier,
  jwsSigningInput,
  parsePublicJwk,
  protectedHeaderFor,
  signaturePayload,
  type AttestationStatementInput,
} from './index';

const T = new Date('2026-05-14T18:03:07.120Z');
const issuer = { principalId: newId(), keyId: newId() };
const rvHash = hashEvidenceBytes(new TextEncoder().encode('result-version'));
const ref = {
  evidenceId: newId(),
  contentHash: hashEvidenceBytes(new Uint8Array([1, 2, 3])),
  descriptorHash: hashEvidenceBytes(new Uint8Array([4, 5, 6])),
};

const input = (over: Partial<AttestationStatementInput> = {}): AttestationStatementInput => ({
  audience: 'bragging-rights:test',
  issuer,
  subject: {
    type: 'RESULT_VERSION',
    id: '0190f4c2-0000-7000-8000-00000000aaaa' as Uuid,
    hash: rvHash,
  },
  claim: { type: 'RESULT_ACCURATE', polarity: 'AFFIRM' },
  evidenceRefs: [ref],
  nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
  signedAt: T,
  expiresAt: new Date(T.getTime() + 600_000),
  ...over,
});

const key = (
  signer: ReturnType<typeof createEphemeralSigner>,
  over: Partial<PrincipalKey> = {},
): PrincipalKey => ({
  id: issuer.keyId,
  principalId: issuer.principalId,
  keyKind: 'JWK',
  algorithm: signer.algorithm,
  verificationMaterial: signer.publicJwk,
  effectiveFrom: new Date(T.getTime() - 3_600_000),
  recordedAt: new Date(T.getTime() - 3_600_000),
  ...over,
});

const verify = (
  signer: ReturnType<typeof createEphemeralSigner>,
  statementHash: string,
  proof: unknown,
  keyId = issuer.keyId,
) =>
  jwsDetachedVerifier.verify({
    statementHash,
    keyId,
    keyKind: 'JWK',
    algorithm: signer.algorithm,
    verificationMaterial: signer.publicJwk,
    proof,
  });

describe('AttestationStatement canonicalization', () => {
  it('is deterministic and domain-separated per purpose', () => {
    const a = buildAttestationStatement(input());
    const b = buildAttestationStatement(input());
    expect(a.statementHash).toBe(b.statementHash);
    expect(a.canonicalText).toBe(b.canonicalText);
    // identical JCS under another purpose/tag can never collide
    const k = buildKeyRegistrationStatement({
      audience: 'bragging-rights:test',
      principalId: issuer.principalId,
      keyId: issuer.keyId,
      algorithm: 'EdDSA',
      verificationMaterialHash: rvHash,
      nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
      signedAt: T,
      expiresAt: new Date(T.getTime() + 600_000),
    });
    expect(k.statementHash).not.toBe(a.statementHash);
    expect(() => hashStatement('attestation-retraction', a.statement)).toThrow(/rejected/);
  });

  it('property: changing any signed canonical field changes the statement hash', () => {
    const h = buildAttestationStatement(input()).statementHash;
    const other = hashEvidenceBytes(new Uint8Array([9]));
    const variants: Partial<AttestationStatementInput>[] = [
      { audience: 'bragging-rights:prod' },
      { issuer: { ...issuer, principalId: newId() } },
      { issuer: { ...issuer, keyId: newId() } },
      { subject: { type: 'RESULT_VERSION', id: newId(), hash: rvHash } },
      {
        subject: {
          type: 'RESULT_VERSION',
          id: '0190f4c2-0000-7000-8000-00000000aaaa' as Uuid,
          hash: other,
        },
      },
      { claim: { type: 'RESULT_ACCURATE', polarity: 'DENY' } },
      {
        claim: {
          type: 'CONDITIONS_COMPLIANT',
          polarity: 'AFFIRM',
          payload: {
            conditions: [{ aspect: 'WIND', key: 'wind.speed', value: '1.2', unit: 'm/s' }],
          },
        },
      },
      { evidenceRefs: [{ ...ref, evidenceId: newId() }] },
      { evidenceRefs: [{ ...ref, contentHash: other }] },
      { evidenceRefs: [] },
      { nonce: 'BAAAAAAAAAAAAAAAAAAAAA' },
      { signedAt: new Date(T.getTime() - 1) },
      { expiresAt: new Date(T.getTime() + 600_001) },
      { authorityContext: { actingRole: 'OFFICIAL' } },
    ];
    for (const v of variants) expect(buildAttestationStatement(input(v)).statementHash).not.toBe(h);
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 86_000_000 }),
        (ms) =>
          buildAttestationStatement(input({ expiresAt: new Date(T.getTime() + ms) }))
            .statementHash !== h || ms === 600_000,
      ),
    );
  });

  it('evidence references are a set: order-independent, duplicates rejected', () => {
    const r2 = { ...ref, evidenceId: newId() };
    expect(buildAttestationStatement(input({ evidenceRefs: [ref, r2] })).statementHash).toBe(
      buildAttestationStatement(input({ evidenceRefs: [r2, ref] })).statementHash,
    );
    expect(() => buildAttestationStatement(input({ evidenceRefs: [ref, ref] }))).toThrow();
    expect(() =>
      buildAttestationStatement(input({ evidenceRefs: [ref, { ...ref, contentHash: rvHash }] })),
    ).toThrow();
  });

  it('bounded claim language: shapes enforced, no free-form members', () => {
    expect(() =>
      buildAttestationStatement(
        input({ claim: { type: 'CONDITIONS_COMPLIANT', polarity: 'AFFIRM' } }),
      ),
    ).toThrow(/observations/);
    expect(() =>
      buildAttestationStatement(
        input({
          claim: { type: 'RESULT_ACCURATE', polarity: 'AFFIRM', payload: { reasonCode: 'OTHER' } },
        }),
      ),
    ).toThrow(/DENY/);
    const doc = JSON.parse(buildAttestationStatement(input()).canonicalText) as Record<
      string,
      unknown
    >;
    expect(() => hashStatement('attestation', { ...doc, verified: true })).toThrow(/rejected/);
    expect(() =>
      hashStatement('attestation', {
        ...doc,
        claim: { type: 'RESULT_VERIFIED', polarity: 'AFFIRM' },
      }),
    ).toThrow(/rejected/);
    expect(() => buildAttestationStatement(input({ expiresAt: T }))).toThrow(/expiresAt/);
    expect(() =>
      buildAttestationStatement(input({ expiresAt: new Date(T.getTime() + 25 * 3_600_000) })),
    ).toThrow(/24 hours/);
    expect(() => buildAttestationStatement(input({ audience: 'evil' }))).toThrow(/audience/);
  });
});

describe('signing preimage (JWS_DETACHED, RFC 7515 + RFC 7797)', () => {
  it('is exactly protected "." "bragging-rights/sig/v1:" hex(statementHash)', () => {
    const { statementHash } = buildAttestationStatement(input());
    const p = protectedHeaderFor('EdDSA', issuer.keyId);
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toEqual({
      alg: 'EdDSA',
      b64: false,
      crit: ['b64'],
      kid: issuer.keyId,
    });
    expect(jwsSigningInput(p, statementHash).toString('ascii')).toBe(
      `${p}.bragging-rights/sig/v1:${statementHash.slice(7)}`,
    );
    expect(signaturePayload(statementHash)).toMatch(/^bragging-rights\/sig\/v1:[0-9a-f]{64}$/);
  });
});

describe('proof verification (production scheme) and tampering', () => {
  for (const alg of ['EdDSA', 'ES256'] as const) {
    it(`${alg}: a valid proof verifies; any tamper fails closed`, () => {
      const signer = createEphemeralSigner(alg);
      const hashed = buildAttestationStatement(input());
      const proof = signer.signJws(issuer.keyId, hashed.statementHash);
      expect(verify(signer, hashed.statementHash, proof)).toMatchObject({
        ok: true,
        assurance: 'HOLDER_KEY',
      });

      // Changing any signed content after signature breaks the proof.
      const tampered: Partial<AttestationStatementInput>[] = [
        { subject: { type: 'RESULT_VERSION', id: newId(), hash: rvHash } }, // ResultVersion id
        { evidenceRefs: [{ ...ref, evidenceId: newId() }] }, // evidence id
        { evidenceRefs: [{ ...ref, contentHash: hashEvidenceBytes(new Uint8Array([7])) }] }, // content hash
        { issuer: { ...issuer, principalId: newId() } }, // issuer
        {
          subject: {
            type: 'RESULT_VERSION',
            id: '0190f4c2-0000-7000-8000-00000000aaaa' as Uuid,
            hash: hashEvidenceBytes(new Uint8Array([8])),
          },
        }, // subject
        { claim: { type: 'RESULT_ACCURATE', polarity: 'DENY' } }, // claim type/polarity
        { audience: 'bragging-rights:prod' }, // audience
        { nonce: 'ZZZZZZZZZZZZZZZZZZZZZZ' }, // nonce
      ];
      for (const v of tampered)
        expect(
          verify(signer, buildAttestationStatement(input(v)).statementHash, proof),
        ).toMatchObject({ ok: false });

      // Wrong key, wrong kid, malformed / oversized / truncated signature, extra header member.
      expect(verify(createEphemeralSigner(alg), hashed.statementHash, proof).ok).toBe(false);
      expect(verify(signer, hashed.statementHash, proof, newId())).toMatchObject({
        ok: false,
        reason: 'HEADER_MISMATCH',
      });
      expect(verify(signer, hashed.statementHash, { ...proof, signature: 'A'.repeat(86) }).ok).toBe(
        false,
      );
      expect(
        verify(signer, hashed.statementHash, { ...proof, signature: `${proof.signature}AA` }),
      ).toMatchObject({ reason: 'MALFORMED_PROOF' });
      expect(
        verify(signer, hashed.statementHash, { ...proof, signature: proof.signature.slice(4) }),
      ).toMatchObject({ reason: 'MALFORMED_PROOF' });
      expect(verify(signer, hashed.statementHash, { ...proof, extra: 1 })).toMatchObject({
        reason: 'MALFORMED_PROOF',
      });
      const header = Buffer.from(
        JSON.stringify({ alg, b64: false, crit: ['b64'], kid: issuer.keyId, jku: 'https://evil' }),
      ).toString('base64url');
      expect(verify(signer, hashed.statementHash, { ...proof, protected: header })).toMatchObject({
        reason: 'HEADER_MISMATCH',
      });
      // A b64:true header (signing the raw hash instead of the detached payload) is refused.
      const b64true = Buffer.from(
        JSON.stringify({ alg, b64: true, crit: ['b64'], kid: issuer.keyId }),
      ).toString('base64url');
      expect(verify(signer, hashed.statementHash, { ...proof, protected: b64true })).toMatchObject({
        reason: 'HEADER_MISMATCH',
      });
    });
  }

  it('cross-purpose replay: a key-registration or retraction signature is never an attestation proof', () => {
    const signer = createEphemeralSigner();
    const att = buildAttestationStatement(input());
    const ret = buildRetractionStatement({
      audience: 'bragging-rights:test',
      issuer,
      attestationId: newId(),
      attestationStatementHash: att.statementHash,
      reasonCode: 'WITHDRAWN',
      nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
      signedAt: T,
      expiresAt: new Date(T.getTime() + 600_000),
    });
    const retProof = signer.signJws(issuer.keyId, ret.statementHash);
    expect(verify(signer, att.statementHash, retProof).ok).toBe(false);
    expect(verify(signer, ret.statementHash, retProof).ok).toBe(true);
  });

  it('wrong scheme / algorithm / key kind fail closed', () => {
    const signer = createEphemeralSigner('EdDSA');
    const hashed = buildAttestationStatement(input());
    const proof = signer.signJws(issuer.keyId, hashed.statementHash);
    const base = {
      statementHash: hashed.statementHash,
      keyId: issuer.keyId,
      verificationMaterial: signer.publicJwk,
      proof,
    };
    expect(
      jwsDetachedVerifier.verify({ ...base, keyKind: 'JWK', algorithm: 'ES256K' }),
    ).toMatchObject({ reason: 'UNSUPPORTED_ALGORITHM' });
    expect(
      jwsDetachedVerifier.verify({ ...base, keyKind: 'WALLET', algorithm: 'EdDSA' }),
    ).toMatchObject({ reason: 'UNSUPPORTED_ALGORITHM' });
    expect(jwsDetachedVerifier.verify({ ...base, keyKind: 'JWK', algorithm: 'ES256' }).ok).toBe(
      false,
    );
  });

  it('public JWKs only: private members and malformed points are refused', () => {
    const signer = createEphemeralSigner();
    expect(parsePublicJwk('EdDSA', signer.publicJwk).ok).toBe(true);
    expect(parsePublicJwk('EdDSA', { ...signer.publicJwk, d: 'x'.repeat(43) }).ok).toBe(false);
    expect(
      parsePublicJwk('ES256', { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'A'.repeat(43) }).ok,
    ).toBe(false);
    expect(parsePublicJwk('RS256', { kty: 'RSA', n: 'x', e: 'AQAB' }).ok).toBe(false);
  });
});

describe('key admissibility at platform-observed time (signer time never resurrects a key)', () => {
  const signer = createEphemeralSigner();
  const at = (min: number) => new Date(T.getTime() + min * 60_000);
  const decide = (
    k: PrincipalKey | undefined,
    changes: KeyStatusChange[],
    issuedAt: Date,
    signedAt?: Date,
  ) =>
    evaluateKeyAdmissibility({
      key: k,
      statusChanges: changes,
      issuerPrincipalId: issuer.principalId,
      issuedAt,
      ...(signedAt === undefined ? {} : { signedAt }),
      supportedAlgorithms: ['EdDSA', 'ES256'],
    });
  it('unknown, foreign, expired and revoked keys are refused', () => {
    expect(decide(undefined, [], T)).toEqual({ admissible: false, reason: 'KEY_UNKNOWN' });
    expect(decide(key(signer, { principalId: newId() }), [], T)).toMatchObject({
      reason: 'KEY_NOT_OWNED',
    });
    expect(decide(key(signer, { effectiveTo: at(-1) }), [], T)).toMatchObject({
      reason: 'KEY_NOT_VALID_AT_TIME',
    });
    const revoked: KeyStatusChange = {
      id: newId(),
      keyId: issuer.keyId,
      kind: 'REVOKED',
      effectiveFrom: at(-5),
      recordedAt: at(-5),
      reason: 'x',
    };
    expect(decide(key(signer), [revoked], T)).toMatchObject({ reason: 'KEY_REVOKED' });
    expect(decide(key(signer, { algorithm: 'ES256K' }), [], T)).toMatchObject({
      reason: 'KEY_ALGORITHM_UNSUPPORTED',
    });
  });
  it('an older signedAt cannot resurrect an expired, revoked or compromised key', () => {
    const expired = key(signer, { effectiveTo: at(-1) });
    expect(decide(expired, [], T, at(-30)).admissible).toBe(false);
    const revoked: KeyStatusChange = {
      id: newId(),
      keyId: issuer.keyId,
      kind: 'REVOKED',
      effectiveFrom: at(-5),
      recordedAt: at(-5),
      reason: 'x',
    };
    expect(decide(key(signer), [revoked], T, at(-30)).admissible).toBe(false);
    const compromised: KeyStatusChange = {
      id: newId(),
      keyId: issuer.keyId,
      kind: 'COMPROMISED',
      compromisedSince: at(-10),
      recordedAt: at(-1),
      reason: 'x',
    };
    expect(decide(key(signer), [compromised], T, at(-30))).toMatchObject({
      reason: 'KEY_COMPROMISED',
    });
    // A compromise recorded AFTER acceptance is not known at T (it never rewrites the accepted fact;
    // BRT-07 applies it retroactively from the bundle's key facts).
    expect(decide(key(signer), [{ ...compromised, recordedAt: at(5) }], T, at(-30))).toEqual({
      admissible: true,
    });
  });
  it('a prospective revocation after T does not affect T; a valid key is admissible', () => {
    const later: KeyStatusChange = {
      id: newId(),
      keyId: issuer.keyId,
      kind: 'REVOKED',
      effectiveFrom: at(5),
      recordedAt: at(-1),
      reason: 'x',
    };
    expect(decide(key(signer), [later], T)).toEqual({ admissible: true });
    expect(decide(key(signer), [], T)).toEqual({ admissible: true });
  });
});
