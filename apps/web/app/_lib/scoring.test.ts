import { describe, expect, it } from 'vitest';
import { basisLabel, compatibleRulesets, decidedByLabel, templatesFor } from './scoring';
import type { Catalog } from './tournaments';

const version = (
  versionId: string,
  family: string,
  basis: 'GOVERNING_RULE' | 'COMMON_PRACTICE' = 'GOVERNING_RULE',
) => ({
  versionId,
  code: versionId,
  name: versionId,
  version: 1,
  family,
  specHash: `sha256:${'0'.repeat(64)}`,
  basis:
    basis === 'GOVERNING_RULE'
      ? ({ kind: basis, source: 'Rules' } as const)
      : ({ kind: basis, note: 'organizer practice' } as const),
});
const catalog = {
  disciplineVersions: [
    { disciplineVersionId: 'dv', compatibleRulesetVersionIds: ['r-sets'] },
    { disciplineVersionId: 'v1' },
  ],
  formatVersions: [],
  rulesetVersions: [version('r-sets', 'SETS_OF_GAMES'), version('r-time', 'ELAPSED_TIME')],
  classificationTemplateVersions: [version('t-std', 'STANDINGS'), version('t-met', 'METRIC')],
} as unknown as Catalog;

describe('ONCF-05C scoring helpers (catalog-driven, no sport logic)', () => {
  it('offers only catalog-compatible rulesets; v1 disciplines get none', () => {
    expect(compatibleRulesets(catalog, 'dv').map((r) => r.versionId)).toEqual(['r-sets']);
    expect(compatibleRulesets(catalog, 'v1')).toEqual([]);
  });
  it('pairs head-to-head families with standings templates and field families with metric ones', () => {
    expect(templatesFor(catalog, 'SETS_OF_GAMES').map((t) => t.versionId)).toEqual(['t-std']);
    expect(templatesFor(catalog, 'ELAPSED_TIME').map((t) => t.versionId)).toEqual(['t-met']);
    expect(templatesFor(catalog, undefined)).toEqual([]);
  });
  it('labels the basis honestly and names the deciding criterion', () => {
    expect(basisLabel(version('x', 'STROKES', 'COMMON_PRACTICE'))).toBe(
      'Common practice — organizer practice',
    );
    expect(decidedByLabel('COUNT_BACK')).toBe('count-back');
    expect(decidedByLabel('KEY:elapsedTimeMs')).toBe('elapsedTimeMs');
    expect(decidedByLabel(undefined)).toBeNull();
  });
});
