import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CanonicalError,
  createCanonicalizer,
  hashEvidenceBytes,
  normalizeDecimal,
  normalizeTimestamp,
  parseStrictJson,
  serializeJcs,
  type BrRootSchema,
} from './index';

const schema: BrRootSchema = {
  $id: 'br:test-props',
  'x-br-version': 1,
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', 'x-br-type': 'uuid' },
    name: { type: 'string' },
    count: { type: 'integer' },
    ratio: { type: 'string', 'x-br-type': 'decimal' },
    tags: { type: 'array', items: { type: 'string' }, 'x-br-set': { sortBy: [] } },
    games: { type: 'array', items: { type: 'integer' } },
  },
};
const c = createCanonicalizer([schema]);
const ID = '0190f4c2-3b7a-7c21-9d4e-5f6a7b8c9d01';
const hash = (v: unknown) => c.hashCanonical('test', 'br:test-props', 1, v).contentHash;

/** Strips characters BR-JSON rejects in plain strings (C0 controls, lone surrogates). */
const clean = (s: string): string =>
  [...s]
    .filter(
      (ch) =>
        ch.charCodeAt(0) >= 0x20 &&
        !(ch.length === 1 && ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdfff),
    )
    .join('');

const shuffle = <T>(xs: readonly T[], seed: number): T[] => {
  const out = [...xs];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
};

describe('canonicalization properties', () => {
  it('member insertion order never changes the hash', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.integer({ min: -1000, max: 1000 }),
        fc.nat(),
        (name, count, seed) => {
          const entries: [string, unknown][] = [
            ['id', ID],
            ['name', clean(name)],
            ['count', count],
          ];
          const a = Object.fromEntries(entries);
          const b = Object.fromEntries(shuffle(entries, seed));
          expect(hash(a)).toBe(hash(b));
        },
      ),
    );
  });

  it('set order never changes the hash; ordered arrays do', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z]{1,6}$/), { minLength: 2, maxLength: 8 }),
        fc.nat(),
        (tags, seed) => {
          const shuffled = shuffle(tags, seed);
          expect(hash({ id: ID, tags })).toBe(hash({ id: ID, tags: shuffled }));
        },
      ),
    );
    expect(hash({ id: ID, games: [1, 2] })).not.toBe(hash({ id: ID, games: [2, 1] }));
  });

  it('decimal normalization is idempotent and value-preserving', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.nat({ max: 6 }),
        fc.nat({ max: 3 }),
        (units, scale, zeros) => {
          const s =
            (Math.abs(units) / 10 ** scale).toFixed(scale) + (scale > 0 ? '0'.repeat(zeros) : '');
          const input = units < 0 ? `-${s}` : s;
          const once = normalizeDecimal(input, '');
          expect(normalizeDecimal(once, '')).toBe(once);
          expect(Number(once)).toBe(Number(input) === 0 ? 0 : Number(input));
        },
      ),
    );
  });

  it('canonical text re-parses to the normalized value (JCS round trip)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), fc.integer(), (name, count) => {
        const r = c.canonicalize('br:test-props', 1, { id: ID, name: clean(name), count });
        expect(parseStrictJson(r.canonicalText)).toEqual(r.normalized);
        expect(serializeJcs(parseStrictJson(r.canonicalText) as never)).toBe(r.canonicalText);
      }),
    );
  });

  it('any semantic change changes the hash', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1e6, max: 1e6 }),
        fc.integer({ min: 1, max: 1000 }),
        (count, delta) => {
          expect(hash({ id: ID, count })).not.toBe(hash({ id: ID, count: count + delta }));
        },
      ),
    );
  });
});

describe('scalar edge cases', () => {
  it('handles leap years and offsets across year boundaries', () => {
    expect(normalizeTimestamp('2024-02-29T23:59:59.999+00:00', '')).toBe(
      '2024-02-29T23:59:59.999Z',
    );
    expect(() => normalizeTimestamp('2023-02-29T00:00:00Z', '')).toThrow(CanonicalError);
    expect(normalizeTimestamp('0001-01-01T00:00:00Z', '')).toBe('0001-01-01T00:00:00.000Z');
    expect(() => normalizeTimestamp('0001-01-01T00:00:00+01:00', '')).toThrow(
      /BRJ_TIMESTAMP_RANGE/,
    );
  });

  it('evidence bytes use plain SHA-256 (no domain separation)', () => {
    expect(hashEvidenceBytes(new TextEncoder().encode('abc'))).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('rejects schemas with open objects or ambiguous set keys', () => {
    expect(() =>
      createCanonicalizer([
        { ...schema, $id: 'br:bad', additionalProperties: true as unknown as false },
      ]),
    ).toThrow(/BRJ_SCHEMA_DEFINITION/);
    expect(() =>
      createCanonicalizer([
        {
          $id: 'br:bad-set',
          'x-br-version': 1,
          type: 'object',
          additionalProperties: false,
          properties: {
            xs: {
              type: 'array',
              'x-br-set': { sortBy: ['/missing'] },
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { a: { type: 'string' } },
              },
            },
          },
        },
      ]),
    ).toThrow(/BRJ_SCHEMA_DEFINITION/);
  });

  it('refuses unknown schemas and invalid domain tags', () => {
    expect(() => c.hashCanonical('test', 'br:nope', 1, {})).toThrow(/BRJ_UNKNOWN_SCHEMA/);
    expect(() => c.hashCanonical('Bad Tag', 'br:test-props', 1, { id: ID })).toThrow(
      /BRJ_DOMAIN_TAG/,
    );
  });
});
