import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateBrt10Vectors, serialize, VECTORS_FILE } from '../scripts/vectors';

describe('BRT-10 ranking / classification vectors', () => {
  it('the committed corpus reproduces byte for byte', () => {
    expect(readFileSync(VECTORS_FILE, 'utf8')).toBe(serialize(generateBrt10Vectors()));
  });
  it('states: shared-tie run publishable, missing facts / values / points block, forged keys refused', () => {
    const v = generateBrt10Vectors().vectors;
    const state = (name: string) => v.find((x) => x.name === name)?.expectState;
    expect(state('run-outcome/best-mark-ties')).toBe('PUBLISHABLE');
    expect(state('derivation-outcome/head-to-head-points')).toBe('PROPOSED');
    expect(state('derivation-outcome/missing-metric-value')).toBe('BLOCKED');
    expect(state('derivation-outcome/undeclared-outcome')).toBe('BLOCKED');
    expect(state('derivation-outcome/policy-keys-reordered-forged')).toBe('BLOCKED');
  });
  it('QUALIFIED (Step 9): top-N issuable on both paths; V2, a corrected snapshot and production block', () => {
    const v = generateBrt10Vectors().vectors;
    const state = (name: string) => v.find((x) => x.name === name)?.expectState;
    expect(state('qualified-outcome/ranking-top-n-shared')).toBe('ISSUABLE');
    expect(state('qualified-outcome/classification-top-n')).toBe('ISSUABLE');
    expect(state('qualified-outcome/ranking-v2-below-floor')).toBe('NO_QUALIFYING_FACTS');
    expect(state('qualified-outcome/ranking-corrected-snapshot')).toBe('BLOCKED');
    expect(state('qualified-outcome/production-fails-closed')).toBe('BLOCKED');
    expect(v.filter((x) => x.kind === 'qualifiedCandidate')).toHaveLength(8);
  });
  it('staleness (Step 7): one fresh case, every stale state a distinct digest, reordering irrelevant', () => {
    const doc = generateBrt10Vectors();
    const stale = doc.vectors.filter((x) => x.kind === 'staleness');
    expect(doc.freshCases).toHaveLength(1);
    expect(stale.map((x) => x.name)).toEqual([
      'staleness/pin-superseded',
      'staleness/pin-superseded-reordered',
      'staleness/admissible-set-grew',
      'staleness/pin-out-of-scope',
      'staleness/admissible-set-unknown',
      'staleness/pins-unknown',
    ]);
    expect(new Set(stale.map((x) => x.hash)).size).toBe(5);
  });
});
