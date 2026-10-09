import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateBrt09Vectors, serialize, VECTORS_FILE } from '../scripts/vectors';

describe('BRT-09 record vectors', () => {
  it('the committed corpus reproduces byte for byte', () => {
    expect(readFileSync(VECTORS_FILE, 'utf8')).toBe(serialize(generateBrt09Vectors()));
  });
  it('outcome states: ratified canonical, forged subject stays pending, handicap never enters scratch', () => {
    const doc = generateBrt09Vectors();
    const v = doc.vectors.filter((x) => x.kind === 'outcome');
    expect(v.find((x) => x.name === 'outcome/ratify-national-canonical')?.expectState).toBe(
      'QUALIFIES',
    );
    expect(v.find((x) => x.name === 'outcome/ratify-national-forged-subject')?.expectState).toBe(
      'PENDING_REQUIRED_FACTS',
    );
    expect(v.find((x) => x.name === 'outcome/handicap-into-scratch')?.expectState).toBe(
      'INELIGIBLE',
    );
  });
});
