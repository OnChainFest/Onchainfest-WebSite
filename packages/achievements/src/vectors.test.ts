import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateBrt08Vectors, serialize, VECTORS_FILE } from '../scripts/vectors';

describe('BRT-08 achievement vectors', () => {
  it('the committed corpus reproduces byte for byte (rule, snapshot, outcome, candidate, identity)', () => {
    expect(readFileSync(VECTORS_FILE, 'utf8')).toBe(serialize(generateBrt08Vectors()));
  });
  it('a team title vector is ONE TEAM candidate with two member credits', () => {
    const doc = generateBrt08Vectors();
    const c = doc.vectors.filter((v) => v.name.startsWith('candidate/team-title-v2/'));
    expect(c).toHaveLength(1);
    const parsed = JSON.parse(c[0]!.canonicalText);
    expect(parsed.holder.holderType).toBe('TEAM');
    expect(parsed.memberCredits).toHaveLength(2);
  });
});
