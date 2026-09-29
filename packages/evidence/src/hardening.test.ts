import { createPublicKey } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hashEvidenceBytes } from '@br/canonical';
import { newId, type Uuid } from '@br/domain';
import { describe, expect, it } from 'vitest';
import { es256VectorKey, vectorKey } from '../scripts/vectors';
import {
  buildAttestationStatement,
  buildEvidenceDescriptor,
  createEphemeralSigner,
  detachedJwsHash,
  isPublishedVectorKey,
  jwkThumbprint,
  jwsDetachedVerifier,
  parsePublicJwk,
} from './index';

/** BRT-06R focused hardening proofs (time semantics, key identity, JWS rules). */
const repo = new URL('../../../', import.meta.url).pathname;
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === 'node_modules') return [];
    return statSync(p).isDirectory()
      ? sources(p)
      : /\.ts$/.test(n) && !/\.test\.ts$/.test(n)
        ? [p]
        : [];
  });

describe('time semantics: no new clock slack, no timestamp rewriting', () => {
  it('SIGNER_CLOCK_SKEW_MS is used only for the source-asserted capturedAt of a descriptor', () => {
    const users = [
      ...sources(join(repo, 'packages/evidence/src')),
      ...sources(join(repo, 'packages/persistence/src')),
      ...sources(join(repo, 'apps/api/src')),
    ].filter((f) => readFileSync(f, 'utf8').includes('SIGNER_CLOCK_SKEW_MS'));
    expect(users.map((f) => f.slice(repo.length))).toEqual(['packages/evidence/src/descriptor.ts']);
    const d = readFileSync(join(repo, 'packages/evidence/src/descriptor.ts'), 'utf8');
    expect(d.match(/SIGNER_CLOCK_SKEW_MS/g)).toHaveLength(2); // import + the capturedAt rule
    expect(d).toMatch(
      /s\.capturedAt\.getTime\(\) >\s*input\.acquisition\.receivedAt\.getTime\(\) \+ SIGNER_CLOCK_SKEW_MS/,
    );
  });

  it('no BRT-06 code or migration rewrites a platform timestamp (no clamp / LEAST / GREATEST)', () => {
    const store = readFileSync(join(repo, 'packages/persistence/src/evidence-store.ts'), 'utf8');
    expect(store).not.toMatch(/\?\s*ctx\.txTime\s*:/);
    expect(store).toMatch(/const observedAt = receivedAt;/);
    for (const m of [
      '0010_evidence.sql',
      '0011_attestations.sql',
      '0012_evidence_read_models.sql',
    ]) {
      const sql = readFileSync(join(repo, 'db/migrations', m), 'utf8');
      expect(sql, m).not.toMatch(/\b(LEAST|GREATEST)\s*\(/i);
      expect(sql, m).not.toMatch(/received_at\s*<=\s*recorded_at/);
    }
  });

  it('a receipt observed "after" recording (clock stepped back) is hashed verbatim and deterministically', () => {
    const input = {
      evidenceId: newId(),
      evidenceType: 'SIGNED_SCORESHEET' as const,
      contentHash: hashEvidenceBytes(new Uint8Array([1])),
      byteLength: 1,
      mediaType: 'text/plain' as const,
      source: { kind: 'HUMAN' as const },
      acquisition: {
        method: 'REFERENCE_UPLOAD' as const,
        receivedAt: new Date('2030-01-01T00:00:00.123Z'),
      },
    };
    const a = buildEvidenceDescriptor(input);
    expect(a.descriptor.acquisition.receivedAt).toBe('2030-01-01T00:00:00.123Z');
    expect(buildEvidenceDescriptor(input).descriptorHash).toBe(a.descriptorHash);
  });
});

describe('public-key identity (RFC 7638) and published fixture keys', () => {
  it('thumbprint conforms to RFC 8037 Appendix A.3 (Ed25519)', () => {
    const jwk = { kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' };
    const p = parsePublicJwk('EdDSA', jwk);
    expect(p.ok).toBe(true);
    if (p.ok) expect(jwkThumbprint(p.key)).toBe('kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k');
  });

  it('both fixture keys are blocked in every equivalent representation; other keys are not', () => {
    for (const k of [vectorKey(), es256VectorKey()]) {
      const reordered = Object.fromEntries(Object.entries(k.publicJwk).reverse());
      const withMetadata = {
        ...reordered,
        alg: k.alg,
        use: 'sig',
        key_ops: ['verify'],
        kid: 'x',
        ext: true,
      };
      for (const variant of [k.publicJwk, reordered, withMetadata]) {
        const p = parsePublicJwk(k.alg, variant);
        expect(p.ok).toBe(true);
        if (p.ok) expect(isPublishedVectorKey(p.key)).toBe(true);
      }
      expect(isPublishedVectorKey(createPublicKey({ key: k.publicJwk, format: 'jwk' }))).toBe(true);
    }
    for (const alg of ['EdDSA', 'ES256'] as const) {
      const p = parsePublicJwk(alg, createEphemeralSigner(alg).publicJwk);
      expect(p.ok && isPublishedVectorKey(p.key)).toBe(false);
    }
  });

  it('metadata is validated and discarded; private members and wrong metadata are refused', () => {
    const k = createEphemeralSigner('ES256').publicJwk;
    const p = parsePublicJwk('ES256', { ...k, alg: 'ES256', use: 'sig', kid: 'mine' });
    expect(p.ok && Object.keys(p.jwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    for (const bad of [
      { alg: 'EdDSA' },
      { use: 'enc' },
      { key_ops: ['sign'] },
      { d: k.x },
      { ext: 'yes' },
      { x5c: [] },
    ])
      expect(parsePublicJwk('ES256', { ...k, ...bad }).ok, JSON.stringify(bad)).toBe(false);
  });
});

describe('JWS_DETACHED rules (RFC 7515 / 7797 / 7518)', () => {
  const kid = newId();
  const statementHash = buildAttestationStatement({
    audience: 'bragging-rights:test',
    issuer: { principalId: newId(), keyId: kid as Uuid },
    subject: { type: 'RESULT_VERSION', id: newId(), hash: hashEvidenceBytes(new Uint8Array([2])) },
    claim: { type: 'RESULT_ACCURATE', polarity: 'AFFIRM' },
    nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
    signedAt: new Date('2026-01-01T00:00:00.000Z'),
    expiresAt: new Date('2026-01-01T00:10:00.000Z'),
  }).statementHash;
  const run = (
    alg: 'EdDSA' | 'ES256',
    signer = createEphemeralSigner(alg),
    proof: unknown = signer.signJws(kid, statementHash),
    keyAlg: string = alg,
  ) =>
    jwsDetachedVerifier.verify({
      statementHash,
      keyId: kid,
      keyKind: 'JWK',
      algorithm: keyAlg,
      verificationMaterial: signer.publicJwk,
      proof,
    });

  it('there is no unprotected header: an extra proof member (e.g. "header") is refused', () => {
    const s = createEphemeralSigner();
    expect(
      run('EdDSA', s, { ...s.signJws(kid, statementHash), header: { alg: 'none' } }),
    ).toMatchObject({ ok: false, reason: 'MALFORMED_PROOF' });
  });

  it('key/curve substitution fails: an Ed25519 key cannot verify as ES256 and vice versa', () => {
    const ed = createEphemeralSigner('EdDSA');
    expect(run('EdDSA', ed, ed.signJws(kid, statementHash), 'ES256').ok).toBe(false);
    const es = createEphemeralSigner('ES256');
    expect(run('ES256', es, es.signJws(kid, statementHash), 'EdDSA').ok).toBe(false);
  });

  it('ES256 requires the fixed 64-byte R‖S form; DER and other lengths fail closed', () => {
    const es = createEphemeralSigner('ES256');
    const proof = es.signJws(kid, statementHash);
    expect(run('ES256', es, proof).ok).toBe(true);
    const rs = Buffer.from(proof.signature, 'base64url');
    const derInt = (b: Buffer) => {
      let v = b;
      while (v.length > 1 && v[0] === 0 && (v[1] as number) < 0x80) v = v.subarray(1);
      if ((v[0] as number) >= 0x80) v = Buffer.concat([Buffer.from([0]), v]);
      return Buffer.concat([Buffer.from([2, v.length]), v]);
    };
    const body = Buffer.concat([derInt(rs.subarray(0, 32)), derInt(rs.subarray(32))]);
    const der = Buffer.concat([Buffer.from([0x30, body.length]), body]);
    for (const sig of [
      der,
      rs.subarray(0, 63),
      Buffer.concat([rs, Buffer.from([0])]),
      Buffer.alloc(64),
    ])
      expect(run('ES256', es, { ...proof, signature: sig.toString('base64url') }).ok).toBe(false);
  });

  it('the proof identity is SHA-256 of the RFC 7515 App. F detached serialization', () => {
    const s = createEphemeralSigner();
    const proof = s.signJws(kid, statementHash);
    expect(detachedJwsHash(proof)).toBe(
      hashEvidenceBytes(Buffer.from(`${proof.protected}..${proof.signature}`, 'ascii')),
    );
  });
});
