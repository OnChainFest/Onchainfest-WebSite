import { describe, expect, it } from 'vitest';
import { CANONICAL_CATALOG } from '../catalog-manifest';
import { formatEngine } from '../format/registry';
import { ADVANCEMENT_POLICY_TEMPLATES } from './policy';
import { advancementCompatibility, advancementRequirements } from './preflight';

const discipline = (code: string) =>
  CANONICAL_CATALOG.sports
    .flatMap((s) => s.disciplines)
    .find((d) => d.code === code)!
    .specs.at(-1)!;
const official = ADVANCEMENT_POLICY_TEMPLATES.find((p) => p.code === 'official-confirmed')!;

describe('D-13 format-derived advancement requirements', () => {
  it('requires advancement for three and four entrants but not a two-player final', () => {
    for (const version of [1, 2]) {
      const engine = formatEngine('single-elimination', version)!;
      for (const n of [2, 3, 4]) {
        const requirement = advancementRequirements(engine, discipline('tennis.singles'), {}, n);
        expect(requirement.required).toBe(n > 2);
        expect(requirement.defaultPolicyCode).toBe(
          version === 2 && n > 2 ? 'official-confirmed' : null,
        );
        expect(advancementCompatibility(requirement, official.spec)).toEqual([]);
      }
    }
  });

  it('does not assign universal defaults or require advancement for independent round robin', () => {
    const requirements = advancementRequirements(
      formatEngine('round-robin', 2)!,
      discipline('tennis.singles'),
      {},
      4,
    );
    expect(requirements.required).toBe(false);
    expect(requirements.defaultPolicyCode).toBeNull();
    const basketball = advancementRequirements(
      formatEngine('single-elimination', 2)!,
      discipline('basketball.5x5'),
      {},
      4,
    );
    expect(basketball.required).toBe(true);
    expect(basketball.defaultPolicyCode).toBeNull();
  });

  it('filters cross-group comparison policies from a pure knockout', () => {
    const requirements = advancementRequirements(
      formatEngine('single-elimination', 2)!,
      discipline('tennis.singles'),
      {},
      4,
    );
    for (const code of ['groups-wins-games', 'pools-wins-points']) {
      const policy = ADVANCEMENT_POLICY_TEMPLATES.find((p) => p.code === code)!;
      expect(advancementCompatibility(requirements, policy.spec)).toContain(
        'CROSS_GROUP_ORDER_UNUSED',
      );
    }
  });

  it('detects cross-group requirements from configured dependent slots', () => {
    const requirements = advancementRequirements(
      formatEngine('groups-knockout', 1)!,
      discipline('tennis.singles'),
      { groupCount: 2, qualifiersPerGroup: 1, bestRankedExtra: 1 },
      8,
    );
    expect(requirements.required).toBe(true);
    expect(requirements.defaultPolicyCode).toBeNull();
    expect(advancementCompatibility(requirements, official.spec)).toContain(
      'CROSS_GROUP_ORDER_REQUIRED',
    );
  });

  it('keeps a direct swimming final policy-free and checks heat-place semantics', () => {
    const engine = formatEngine('heats-final', 1)!;
    const pool = discipline('swimming.pool');
    expect(advancementRequirements(engine, pool, {}, 8).required).toBe(false);
    const requirements = advancementRequirements(
      engine,
      pool,
      { qualifyByPlace: 1, qualifyByTime: 6 },
      16,
    );
    expect(requirements.required).toBe(true);
    expect(
      advancementCompatibility(requirements, { ...official.spec, heatSemantics: 'OVERALL' }),
    ).toContain('HEAT_PLACE_QUALIFICATION_REQUIRED');
  });
});
