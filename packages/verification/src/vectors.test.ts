import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateBrt07Vectors, serialize, VECTORS_FILE } from '../scripts/vectors';

describe('BRT-07 verification vectors', () => {
  it('the committed corpus reproduces byte for byte (policy, snapshot, trace, outcome hashes)', () => {
    expect(readFileSync(VECTORS_FILE, 'utf8')).toBe(serialize(generateBrt07Vectors()));
  });
  it('the snapshot cutoff is metadata: identical facts at two cutoffs share one hash', () => {
    const doc = generateBrt07Vectors();
    expect(doc.cutoffIndependence.early).not.toBe(doc.cutoffIndependence.late);
    expect(doc.vectors.find((v) => v.name === 'snapshot/reference-world-v4')!.hash).toBe(
      doc.cutoffIndependence.snapshotHash,
    );
  });
});
