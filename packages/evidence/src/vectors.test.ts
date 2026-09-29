import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateBrt06Vectors, serialize, VECTORS_FILE } from '../scripts/vectors';
import {
  jwkThumbprint,
  jwsDetachedVerifier,
  parsePublicJwk,
  PUBLISHED_VECTOR_KEY_THUMBPRINTS,
} from './index';

describe('BRT-06 cross-language vectors', () => {
  const doc = generateBrt06Vectors();

  it('the committed corpus reproduces exactly (ES256 signatures are reused while they verify)', () => {
    expect(readFileSync(VECTORS_FILE, 'utf8')).toBe(serialize(doc));
    expect(serialize(generateBrt06Vectors())).toBe(serialize(doc));
  });

  it('equal-hash and equal-thumbprint groups hold; rejected canonical vectors carry a rule code', () => {
    const byId = new Map(doc.canonical.map((v) => [v.id, v]));
    for (const group of doc.equalHashGroups)
      expect(new Set(group.map((id) => byId.get(id)?.hash)).size).toBe(1);
    for (const v of doc.canonical.filter((x) => x.expect === 'reject'))
      expect(v.error).toMatch(/^BRJ_/);
    const keys = new Map(doc.keys.map((k) => [k.id, k]));
    for (const group of doc.equalThumbprintGroups) {
      const t = new Set(group.map((id) => (keys.get(id) as { thumbprint?: string }).thumbprint));
      expect(t.size).toBe(1);
    }
  });

  it('every signing vector is accepted or rejected by the production verifier exactly as expected (EdDSA and ES256)', () => {
    for (const v of doc.signing) {
      const key = doc.vectorKeys[v.key] as { publicJwk: Record<string, string> };
      const r = jwsDetachedVerifier.verify({
        statementHash: v.statementHash,
        keyId: v.keyId,
        keyKind: 'JWK',
        algorithm: v.alg,
        verificationMaterial: key.publicJwk,
        proof: { protected: v.protected, signature: v.signature },
      });
      expect(r.ok, v.id).toBe(v.expect === 'accept');
    }
    expect(
      doc.signing
        .filter((v) => v.expect === 'accept')
        .map((v) => v.alg)
        .sort(),
    ).toEqual(['ES256', 'EdDSA']);
  });

  it('key vectors: strict JWK validation and RFC 7638 identity', () => {
    for (const k of doc.keys) {
      const parsed = parsePublicJwk(k.alg, k.jwk);
      expect(parsed.ok, k.id).toBe(k.expect === 'accept');
      if (parsed.ok)
        expect(jwkThumbprint(parsed.key)).toBe((k as { thumbprint: string }).thumbprint);
    }
  });

  it('both published vector keys are blocked by thumbprint', () => {
    for (const k of Object.values(doc.vectorKeys))
      expect(PUBLISHED_VECTOR_KEY_THUMBPRINTS).toContain(k.thumbprint);
  });
});
