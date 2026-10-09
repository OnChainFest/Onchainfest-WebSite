import { readFileSync } from 'node:fs';
import { PLATFORM_RANKING_LABEL } from '@br/domain';
import { describe, expect, it } from 'vitest';
import { API_VECTORS_FILE, generateBrt10ApiVectors, serialize } from '../scripts/api-vectors';
import {
  dtoDigest,
  forbiddenMembers,
  PUBLIC_CLASSIFICATION_STATUSES,
  publicClassificationStaleness,
  publicLeaderboardEntry,
  type publicRankingSystem,
  publicSnapshotStaleness,
  rankingSystemLabel,
} from './public';

/**
 * BRT-10 Step 11 pure public DTO composition: deterministic, closed, topology-free; staleness reduced
 * to {state, reasons}; the committed API vectors reproduce byte for byte.
 */
describe('BRT-10 public DTO composition', () => {
  const doc = generateBrt10ApiVectors();

  it('the committed API vector corpus reproduces exactly (and twice identically)', () => {
    expect(readFileSync(API_VECTORS_FILE, 'utf8')).toBe(serialize(doc));
    expect(serialize(generateBrt10ApiVectors())).toBe(serialize(doc));
  });

  it('every PUBLIC vector DTO is free of forbidden members and carries a br:public-* tag', () => {
    for (const v of doc.vectors.filter((x) => x.visibility === 'PUBLIC')) {
      const dto = JSON.parse(v.canonicalText) as { schema: string };
      expect(forbiddenMembers(dto), v.name).toEqual([]);
      expect(dto.schema, v.name).toMatch(/^br:public-[a-z-]+@1$/);
      expect(dtoDigest(dto)).toBe(v.digest);
    }
  });

  it('read-time staleness keeps only state + sorted reasons (pins, documents and digests dropped)', () => {
    expect(publicSnapshotStaleness({ state: 'CURRENT' })).toEqual({
      state: 'CURRENT',
      reasons: [],
    });
    expect(
      publicSnapshotStaleness({
        state: 'STALE',
        reasons: ['BASIS_VERIFICATION_NOT_CURRENT', 'BASIS_RESULT_NOT_CURRENT'],
        affected: [{ resultVersionId: 'x' }] as never,
      }),
    ).toEqual({
      state: 'STALE',
      reasons: ['BASIS_RESULT_NOT_CURRENT', 'BASIS_VERIFICATION_NOT_CURRENT'],
    });
    const stale = publicClassificationStaleness({
      state: 'STALE',
      document: {
        classificationVersionId: 'c',
        contentHash: 'h',
        inputsDigest: 'd',
        reasons: ['ADMISSIBLE_INPUT_SET_CHANGED'],
        notCurrent: [],
        added: [{ resultVersionId: 'secret-added', contentHash: 'h' }],
        removed: [],
      },
      staleDigest: 'sha256:digest' as never,
    });
    expect(stale).toEqual({ state: 'STALE', reasons: ['ADMISSIBLE_INPUT_SET_CHANGED'] });
    expect(JSON.stringify(stale)).not.toMatch(/secret-added|digest/);
  });

  it('labels are computed: PLATFORM only; OFFICIAL is never presented as published by the platform', () => {
    expect(rankingSystemLabel('PLATFORM')).toBe(PLATFORM_RANKING_LABEL);
    expect(rankingSystemLabel('OFFICIAL')).toBeUndefined();
    const official = doc.vectors.find((v) => v.name.startsWith('system/official'));
    const dto = JSON.parse(official?.canonicalText ?? '{}') as ReturnType<
      typeof publicRankingSystem
    >;
    expect(dto.label).toBeUndefined();
    expect(dto.ownerPublication).toEqual({
      status: 'NOT_AVAILABLE',
      reason: 'OWNER_PUBLICATION_UNAVAILABLE',
    });
  });

  it('a private athlete holder is never identified; ranks, ties and exact decimals are copied', () => {
    const e = publicLeaderboardEntry({
      holderType: 'ATHLETE',
      holderId: 'private-athlete-id',
      rank: 1,
      tied: true,
      value: { metricId: 'm', value: '9.580', unit: 's', precision: 3 },
      comparatorTrace: [{ key: 'k', order: 'LOWER_IS_BETTER', value: '9.580' }],
      basisCount: 2,
      display: { kind: 'PRIVATE_ENTRANT' },
    });
    expect(JSON.stringify(e)).not.toContain('private-athlete-id');
    expect(e).toMatchObject({ rank: 1, tied: true, value: { value: '9.580', display: '9.580 s' } });
  });

  it('only live statuses are public classification statuses', () => {
    expect([...PUBLIC_CLASSIFICATION_STATUSES]).toEqual(['PROVISIONAL', 'OFFICIAL', 'FINAL']);
  });
});
