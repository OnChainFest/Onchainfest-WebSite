import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  generate,
  readJson,
  serializeDoc,
  SOURCE_FILE,
  VECTORS_FILE,
  type VectorDoc,
  type VectorSourceDoc,
} from '../scripts/vectors';
import { CanonicalError, createCanonicalizer } from './index';

const doc = readJson<VectorDoc>(VECTORS_FILE);
const canonicalizer = createCanonicalizer(doc.schemas);

describe('BR-JSON v1 golden vectors (protocol surface)', () => {
  it('committed vectors are exactly what the implementation generates from the hand-authored source', () => {
    const { doc: generated, problems } = generate(readJson<VectorSourceDoc>(SOURCE_FILE));
    expect(problems).toEqual([]);
    expect(serializeDoc(generated)).toBe(readFileSync(VECTORS_FILE, 'utf8'));
  });

  for (const v of doc.vectors) {
    it(`${v.id}: ${v.description}`, () => {
      if (v.expect === 'accept') {
        const r = canonicalizer.hashCanonicalJson(
          v.domainTag,
          v.schema.id,
          v.schema.version,
          v.input,
        );
        expect(r.normalized).toEqual(v.normalized);
        expect(r.canonicalText).toBe(v.canonical);
        expect(r.contentHash).toBe(v.sha256);
      } else {
        let caught: unknown;
        try {
          canonicalizer.hashCanonicalJson(v.domainTag, v.schema.id, v.schema.version, v.input);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(CanonicalError);
        expect((caught as CanonicalError).code).toBe(v.error);
      }
    });
  }

  it('equal-hash groups share a hash and distinct-hash groups do not', () => {
    const hashes = new Map(
      doc.vectors.flatMap((v) => (v.expect === 'accept' ? [[v.id, v.sha256] as const] : [])),
    );
    for (const group of doc.equalHashGroups)
      expect(new Set(group.map((id) => hashes.get(id))).size).toBe(1);
    for (const group of doc.distinctHashGroups)
      expect(new Set(group.map((id) => hashes.get(id))).size).toBe(group.length);
  });
});
