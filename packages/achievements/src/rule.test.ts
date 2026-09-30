import { describe, expect, it } from 'vitest';
import { FX } from './fixtures';
import { compareDecimal, satisfiesThreshold, strictlyBetter } from './marks';
import {
  referencePersonalBestRule,
  referenceThresholdRule,
  referenceTitleRule,
  validateAchievementRuleSpec,
  type RuleDisciplineContext,
} from './rule';

const codes = (input: unknown, dv?: RuleDisciplineContext) => {
  const v = validateAchievementRuleSpec(input, dv);
  return v.ok ? [] : v.issues.map((i) => i.code);
};
const title = referenceTitleRule(FX.padelDv);
const bowlingDv: RuleDisciplineContext = {
  disciplineVersionId: FX.bowlingDv,
  status: 'PUBLISHED',
  spec: {
    metrics: [
      { key: 'score', valueType: 'INTEGER', unit: 'pins' },
      { key: 'seriesPins', valueType: 'INTEGER', unit: 'pins' },
      { key: 'averagePins', valueType: 'DECIMAL', unit: 'pins' },
    ],
    comparator: {
      outcomeModel: 'SCORED_RANKED',
      primary: 'METRICS',
      keys: [{ metric: 'seriesPins', order: 'HIGHER_IS_BETTER' }],
    },
  },
};

describe('rule validation (bounded, declarative, floors never lowered)', () => {
  it('accepts the fictional reference rules; same semantics reordered ⇒ same hash', () => {
    const a = validateAchievementRuleSpec(title);
    const reordered = Object.fromEntries(Object.entries(title).reverse());
    const b = validateAchievementRuleSpec(reordered);
    expect(a.ok && b.ok && a.specHash === b.specHash).toBe(true);
  });

  it('rejects unknown kinds, types, levels, fields and scripts', () => {
    expect(codes({ ...title, achievementType: 'RECORD_SET' })).toContain('BRJ_ENUM');
    expect(codes({ ...title, achievementType: 'WORLD_RECORD' })).toContain('BRJ_ENUM');
    expect(codes({ ...title, criterion: { ...title.criterion, kind: 'JAVASCRIPT' } })).toContain(
      'BRJ_ENUM',
    );
    expect(
      codes({ ...title, requirements: { ...title.requirements, minimumVerificationLevel: 'V9' } }),
    ).toContain('BRJ_ENUM');
    expect(codes({ ...title, expression: 'rank == 1' })).not.toEqual([]);
    expect(codes({ ...title, criterion: { ...title.criterion, sql: 'SELECT 1' } })).not.toEqual([]);
  });

  it('platform floors: V1 title / OFFICIAL title / V1 threshold / V1 PB are rejected; raising is fine', () => {
    expect(
      codes({
        ...title,
        requirements: { minimumVerificationLevel: 'V1', minimumResultStatus: 'FINAL' },
      }),
    ).toContain('BELOW_PLATFORM_FLOOR');
    expect(
      codes({
        ...title,
        requirements: { minimumVerificationLevel: 'V2', minimumResultStatus: 'OFFICIAL' },
      }),
    ).toContain('BELOW_PLATFORM_FLOOR');
    const th = referenceThresholdRule(
      FX.bowlingDv,
      { key: 'score', markMetricId: 'score' },
      'GTE',
      '300',
    );
    expect(
      codes({ ...th, requirements: { ...th.requirements, minimumVerificationLevel: 'V1' } }),
    ).toContain('BELOW_PLATFORM_FLOOR');
    const pb = referencePersonalBestRule(FX.bowlingDv, {
      key: 'seriesPins',
      markMetricId: 'series_pins',
    });
    expect(
      codes({ ...pb, requirements: { ...pb.requirements, minimumVerificationLevel: 'V0' } }),
    ).toContain('BELOW_PLATFORM_FLOOR');
    expect(
      codes({
        ...title,
        requirements: { minimumVerificationLevel: 'V3', minimumResultStatus: 'FINAL' },
      }),
    ).toEqual([]);
  });

  it('title needs exactly rank 1; negative / impossible ranks are rejected', () => {
    expect(
      codes({ ...title, criterion: { ...title.criterion, rank: { min: 1, max: 3 } } }),
    ).toContain('TITLE_REQUIRES_RANK_1');
    expect(
      codes({ ...title, criterion: { ...title.criterion, rank: { min: 0, max: 1 } } }),
    ).toContain('BRJ_SCHEMA_CONSTRAINT');
    expect(
      codes({ ...title, criterion: { ...title.criterion, rank: { min: -1, max: 1 } } }),
    ).not.toEqual([]);
    expect(
      codes({
        ...title,
        achievementType: 'PLACEMENT',
        criterion: { ...title.criterion, rank: { min: 3, max: 2 } },
      }),
    ).toContain('RANK_RANGE_INVALID');
  });

  it('type ↔ criterion kind ↔ holder ↔ scope must agree; parameters are per kind', () => {
    expect(codes({ ...title, criterion: { ...title.criterion, kind: 'PERSONAL_BEST' } })).toContain(
      'CRITERION_KIND_NOT_ALLOWED_FOR_TYPE',
    );
    expect(codes({ ...title, holder: 'PERFORMER' })).toContain(
      'HOLDER_STRATEGY_NOT_ALLOWED_FOR_TYPE',
    );
    expect(
      codes({ ...title, criterion: { ...title.criterion, resultScope: 'CONTEST' } }),
    ).toContain('RESULT_SCOPE_NOT_ALLOWED_FOR_TYPE');
    expect(codes({ ...title, criterion: { ...title.criterion, threshold: '3' } })).toContain(
      'PARAM_NOT_ALLOWED',
    );
  });

  it('display names cannot claim recognition (AC-4): national / world / official / record', () => {
    for (const name of [
      'National Champion',
      'World Record Holder',
      'Official Winner',
      'Campeón Nacional',
    ])
      expect(codes({ ...title, displayName: name })).toContain('DISPLAY_NAME_CLAIMS_RECOGNITION');
  });

  it('metric references are checked against the exact PUBLISHED DisciplineVersion', () => {
    const th = referenceThresholdRule(
      FX.bowlingDv,
      { key: 'score', markMetricId: 'score' },
      'GTE',
      '300',
    );
    expect(codes(th, bowlingDv)).toEqual([]);
    expect(
      codes(
        { ...th, criterion: { ...th.criterion, metric: { key: 'lanes', markMetricId: 'x' } } },
        bowlingDv,
      ),
    ).toContain('METRIC_UNKNOWN');
    expect(
      codes({ ...th, criterion: { ...th.criterion, threshold: '299.5' } }, bowlingDv),
    ).toContain('THRESHOLD_TYPE_MISMATCH');
    expect(codes(th, { ...bowlingDv, status: 'DRAFT' })).toContain(
      'DISCIPLINE_VERSION_NOT_PUBLISHED',
    );
    expect(codes(th, { ...bowlingDv, disciplineVersionId: FX.otherDv })).toContain(
      'DISCIPLINE_VERSION_MISMATCH',
    );
    const seriesLte = referenceThresholdRule(
      FX.bowlingDv,
      { key: 'seriesPins', markMetricId: 'series_pins' },
      'LTE',
      '700',
    );
    expect(codes(seriesLte, bowlingDv)).toContain('OPERATOR_CONTRADICTS_COMPARATOR');
    const pbUnordered = referencePersonalBestRule(FX.bowlingDv, {
      key: 'score',
      markMetricId: 'score',
    });
    expect(codes(pbUnordered, bowlingDv)).toContain('PB_METRIC_ORDER_UNDEFINED');
  });

  it('oversized / deep specs are rejected', () => {
    expect(codes({ ...title, displayName: 'x'.repeat(200) })).not.toEqual([]);
    expect(
      codes({
        ...title,
        criterion: { ...title.criterion, rank: { min: 1, max: 1, deep: { a: { b: {} } } } },
      }),
    ).not.toEqual([]);
  });
});

describe('exact metric arithmetic (no floating point)', () => {
  it('compares canonical decimals exactly across scales', () => {
    expect(compareDecimal('0.1', '0.10')).toBe(0);
    expect(compareDecimal('299.999', '300')).toBe(-1);
    expect(compareDecimal('-1', '0')).toBe(-1);
    expect(compareDecimal('12345678901234567890.123', '12345678901234567890.122')).toBe(1);
  });
  it('thresholds and comparator orders', () => {
    expect(satisfiesThreshold('300', 'GTE', '300')).toBe(true);
    expect(satisfiesThreshold('300', 'GT', '300')).toBe(false);
    expect(strictlyBetter('59000', '60000', 'LOWER_IS_BETTER')).toBe(true);
    expect(strictlyBetter('2', '1', 'ORDINAL')).toBe(false);
    expect(strictlyBetter('701', '700', 'HIGHER_IS_BETTER')).toBe(true);
  });
});
