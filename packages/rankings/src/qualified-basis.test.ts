import { deriveAchievements, qualificationBasisDocument } from '@br/achievements';
import { qualifiedClassificationFixture, qualifiedRankingFixture } from '@br/achievements/fixtures';
import { describe, expect, it } from 'vitest';
import { validateQualificationBasis } from './qualification';

/**
 * BRT-10 Step 9: the QUALIFIED candidate's `basisHash` is exactly the hash of the Step 2
 * `br:qualification-basis@1` document, and that document passes the Step 2 coherence validator
 * (kind ↔ position, position ≤ N, every underlying FINAL · V3+). REFERENCE ENGINE FIXTURES.
 */
describe('QUALIFIED basis = br:qualification-basis@1 (Step 2 vocabulary)', () => {
  for (const [name, snapshot] of [
    ['ranking snapshot', qualifiedRankingFixture()],
    ['classification', qualifiedClassificationFixture()],
  ] as const)
    it(`${name}: every candidate's basisHash validates and recomputes`, () => {
      const d = deriveAchievements(snapshot);
      expect(d.outcome.candidates?.length).toBeGreaterThan(0);
      for (const { candidate } of d.outcome.candidates ?? []) {
        const { basisHash, targetAuthority: _t, ...position } = candidate.qualification!;
        const v = validateQualificationBasis(qualificationBasisDocument(candidate, position));
        expect(v.ok).toBe(true);
        expect(v.ok && v.hash).toBe(basisHash);
      }
    });
});
