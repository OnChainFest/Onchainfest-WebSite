import { describe, expect, it } from 'vitest';
import {
  CLASSIFICATION_ENGINE_V2,
  CLASSIFICATION_TEMPLATES,
  validateClassificationPolicyV2,
  type StandingsPolicySpec,
} from './classification-policy-v2';

describe('ClassificationPolicy v2 vocabulary (ONCF-05B; engine in ONCF-05C)', () => {
  it('every published template is valid and cites its basis', () => {
    for (const t of CLASSIFICATION_TEMPLATES) {
      expect(validateClassificationPolicyV2(t.spec), t.code).toEqual([]);
      expect(t.basis.kind === 'GOVERNING_RULE' ? t.basis.source.length : 0, t.code).toBeGreaterThan(
        0,
      );
    }
    expect(CLASSIFICATION_TEMPLATES.map((t) => t.code)).toEqual(
      expect.arrayContaining([
        'itf_rr',
        'fip_groups',
        'fiba_5x5',
        'fiba_3x3',
        'road_race',
        'swim_time',
        'golf_stroke',
      ]),
    );
  });

  it('refuses a standings policy without an explicit terminal tie rule', () => {
    const bad: StandingsPolicySpec = {
      family: 'STANDINGS',
      targetEngine: CLASSIFICATION_ENGINE_V2,
      matchPoints: [{ outcome: 'WIN', points: 2 }],
      criteria: [{ kind: 'POINTS' }],
      restartOnSeparation: false,
      minimumInputStatus: 'PROVISIONAL',
    };
    expect(validateClassificationPolicyV2(bad).map((i) => i.path)).toContain('/criteria');
  });

  it('refuses unknown criteria and non-integer points', () => {
    const bad = {
      family: 'STANDINGS',
      targetEngine: CLASSIFICATION_ENGINE_V2,
      matchPoints: [{ outcome: 'WIN', points: 2.5 }],
      criteria: [{ kind: 'VIBES' }, { kind: 'ORGANIZER_LOT' }],
      restartOnSeparation: false,
      minimumInputStatus: 'PROVISIONAL',
    } as unknown as StandingsPolicySpec;
    const paths = validateClassificationPolicyV2(bad).map((i) => i.path);
    expect(paths).toContain('/matchPoints/0/points');
    expect(paths).toContain('/criteria/0');
  });
});
