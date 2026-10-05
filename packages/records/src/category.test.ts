import { describe, expect, it } from 'vitest';
import {
  recordLabel,
  universeHash,
  validateRecordCategorySpec,
  versionContinues,
  type CategoryDisciplineContext,
  type RecordCategorySpec,
} from './category';
import { categorySpec, RFX } from './fixtures';

/** REFERENCE ENGINE FIXTURES — NOT PERSISTED SPORTING TRUTH. */
const codes = (spec: unknown, dv?: CategoryDisciplineContext) => {
  const v = validateRecordCategorySpec(spec, dv);
  return v.ok ? [] : v.issues.map((i) => i.code);
};
const with_ = (base: RecordCategorySpec, patch: Record<string, unknown>) => ({ ...base, ...patch });
const RUNNING_DV: CategoryDisciplineContext = {
  disciplineVersionId: RFX.runningDv,
  status: 'PUBLISHED',
  sport: 'athletics',
  discipline: 'athletics.100m',
  spec: {
    metrics: [{ key: 'elapsedTimeMs', valueType: 'DURATION_MS', unit: 'ms' }],
    comparator: {
      outcomeModel: 'RANKED',
      primary: 'METRICS',
      keys: [{ metric: 'elapsedTimeMs', order: 'LOWER_IS_BETTER' }],
    },
    participation: { participantKinds: ['INDIVIDUAL'], lineupSize: { min: 1, max: 1 } },
  },
};

describe('RecordCategoryVersion validation (bounded, declarative, floors never lowered)', () => {
  it('accepts every non-PERSONAL scope; same semantics reordered ⇒ same hash', () => {
    for (const st of [
      'VENUE',
      'COMPETITION',
      'LEAGUE',
      'PLATFORM',
      'NATIONAL',
      'CONTINENTAL',
      'WORLD',
    ] as const)
      expect(codes(categorySpec({ scopeType: st }))).toEqual([]);
    const s = categorySpec();
    const a = validateRecordCategorySpec(s);
    const b = validateRecordCategorySpec(Object.fromEntries(Object.entries(s).reverse()));
    expect(a.ok && b.ok && a.specHash === b.specHash).toBe(true);
  });

  it('PERSONAL categories are refused: personal bests are the BRT-08 PERSONAL_BEST Achievement', () => {
    expect(codes(with_(categorySpec(), { scope: { scopeType: 'PERSONAL' } }))).toContain(
      'PERSONAL_RECORDS_ARE_PERSONAL_BEST',
    );
  });

  it('rejects executable / free-form conditions, unknown members, scripts and unknown scopes', () => {
    expect(
      codes(with_(categorySpec(), { conditions: [{ aspect: 'WIND', requirement: 'JAVASCRIPT' }] })),
    ).not.toEqual([]);
    expect(codes(with_(categorySpec(), { sql: 'SELECT 1' }))).not.toEqual([]);
    expect(codes(with_(categorySpec(), { scope: { scopeType: 'GALACTIC' } }))).not.toEqual([]);
    expect(codes(with_(categorySpec(), { conditionsPassed: true }))).not.toEqual([]);
  });

  it('floors: a category may raise, never lower (V2 COMPETITION / V3 NATIONAL are refused)', () => {
    expect(codes(categorySpec({ minimumVerificationLevel: 'V2' }))).toContain(
      'BELOW_PLATFORM_FLOOR',
    );
    expect(
      codes(categorySpec({ scopeType: 'NATIONAL', minimumVerificationLevel: 'V3' })),
    ).toContain('BELOW_PLATFORM_FLOOR');
    expect(codes(categorySpec({ minimumVerificationLevel: 'V4' }))).toEqual([]);
  });

  it('the V2 + platform review alternative never leaks outside PLATFORM', () => {
    for (const st of [
      'VENUE',
      'COMPETITION',
      'LEAGUE',
      'NATIONAL',
      'CONTINENTAL',
      'WORLD',
    ] as const)
      expect(codes(categorySpec({ scopeType: st, platformReview: true }))).toContain(
        'PLATFORM_REVIEW_ONLY_FOR_PLATFORM_SCOPE',
      );
    expect(codes(categorySpec({ scopeType: 'PLATFORM', platformReview: true }))).toEqual([]);
    expect(
      codes(
        categorySpec({
          scopeType: 'PLATFORM',
          platformReview: true,
          minimumVerificationLevel: 'V4',
        }),
      ),
    ).toContain('PLATFORM_REVIEW_CANNOT_UNDERCUT_RAISED_FLOOR');
  });

  it('recognition is structural and coherent with the scope; PLATFORM cannot claim NATIONAL / WORLD', () => {
    expect(codes(categorySpec({ scopeType: 'PLATFORM', recognitionLevel: 'NATIONAL' }))).toContain(
      'PLATFORM_SCOPE_RECOGNITION_ONLY',
    );
    expect(codes(categorySpec({ scopeType: 'NATIONAL', recognitionLevel: 'PLATFORM' }))).toContain(
      'RECOGNITION_LEVEL_MUST_MATCH_SCOPE',
    );
    expect(codes(categorySpec({ scopeType: 'WORLD', recognitionLevel: 'NATIONAL' }))).toContain(
      'RECOGNITION_LEVEL_MUST_MATCH_SCOPE',
    );
    const pe = categorySpec({ scopeType: 'NATIONAL', region: ['CR'] });
    expect(codes({ ...pe, recognition: { ...pe.recognition, region: ['PE'] } })).toContain(
      'RECOGNITION_REGION_MUST_MATCH_SCOPE',
    );
    expect(codes(categorySpec({ scopeType: 'NATIONAL', region: ['CR', 'PE'] }))).toContain(
      'NATIONAL_SCOPE_NEEDS_ONE_COUNTRY',
    );
  });

  it('names can never widen recognition; PLATFORM never masquerades as a record', () => {
    expect(codes(categorySpec({ displayName: 'Costa Rica national 100 m' }))).toContain(
      'DISPLAY_NAME_CLAIMS_RECOGNITION',
    );
    expect(codes(categorySpec({ displayName: 'World best 100 m' }))).toContain(
      'DISPLAY_NAME_CLAIMS_RECOGNITION',
    );
    expect(codes(categorySpec({ scopeType: 'PLATFORM', displayName: '100 m record' }))).toContain(
      'PLATFORM_NAME_CANNOT_CLAIM_RECORD',
    );
    expect(codes(categorySpec({ displayName: 'La Negrita tournament record' }))).toEqual([]);
  });

  it('CANONICAL keeper cannot be designated on PLATFORM categories', () => {
    expect(codes(categorySpec({ scopeType: 'PLATFORM', canonicalKeeper: true }))).toContain(
      'PLATFORM_CANNOT_BE_CANONICAL_KEEPER',
    );
    expect(codes(categorySpec({ scopeType: 'NATIONAL', canonicalKeeper: true }))).toEqual([]);
  });

  it('checks metric, comparator, sport and holder type against the exact DisciplineVersion', () => {
    expect(codes(categorySpec(), RUNNING_DV)).toEqual([]);
    expect(codes(categorySpec(), { ...RUNNING_DV, status: 'DRAFT' })).toContain(
      'DISCIPLINE_VERSION_NOT_PUBLISHED',
    );
    expect(codes(categorySpec(), { ...RUNNING_DV, sport: 'bowling' })).toContain(
      'RECOGNITION_SPORT_MUST_BE_DISCIPLINE_SPORT',
    );
    expect(
      codes(categorySpec(), {
        ...RUNNING_DV,
        spec: {
          ...RUNNING_DV.spec,
          comparator: { outcomeModel: 'RANKED', primary: 'METRICS', keys: [] },
        },
      }),
    ).toContain('METRIC_NOT_COMPARABLE');
    expect(codes(categorySpec({ holderType: 'TEAM' }), RUNNING_DV)).toContain(
      'HOLDER_TYPE_NOT_IN_DISCIPLINE',
    );
  });
});

describe('category versions keep their comparison universe (ADR-0043)', () => {
  it('policy changes continue the category; universe changes require a new category', () => {
    const v1 = categorySpec({ competitionIds: [RFX.competition] });
    const v2 = categorySpec({
      competitionIds: [RFX.competition, RFX.competition2],
      displayName: 'Renamed series record',
    });
    expect(versionContinues(v1, v2).ok).toBe(true);
    expect(universeHash(v1)).toBe(universeHash(v2));
    expect(versionContinues(v1, categorySpec({ tiePolicy: 'FIRST_ACHIEVED' })).code).toBe(
      'UNIVERSE_CHANGE_REQUIRES_NEW_CATEGORY',
    );
    expect(
      versionContinues(v1, categorySpec({ population: { handicapMode: 'SCRATCH' } })).code,
    ).toBe('UNIVERSE_CHANGE_REQUIRES_NEW_CATEGORY');
    expect(versionContinues(v2, v1).code).toBe('COMPETITION_SERIES_CANNOT_SHRINK');
  });
});

describe('record naming is enforced by the model (BRT-01 §9.3)', () => {
  it('national / world labels only for the structural scope AND a ratified status', () => {
    expect(
      recordLabel({
        scopeType: 'NATIONAL',
        displayName: '100 m',
        region: ['CR'],
        status: 'RATIFIED',
      }),
    ).toBe('National record (CR) — 100 m');
    expect(
      recordLabel({
        scopeType: 'NATIONAL',
        displayName: '100 m',
        region: ['CR'],
        status: 'PENDING_RATIFICATION',
      }),
    ).not.toMatch(/National record/);
    expect(recordLabel({ scopeType: 'WORLD', displayName: '100 m', status: 'CANONICAL' })).toBe(
      'World record — 100 m',
    );
    expect(
      recordLabel({ scopeType: 'PLATFORM', displayName: '100 m time', status: 'RATIFIED' }),
    ).toBe('Bragging Rights platform best — 100 m time');
    expect(
      recordLabel({
        scopeType: 'COMPETITION',
        displayName: 'La Negrita tournament record',
        status: 'RATIFIED',
      }),
    ).toBe('La Negrita tournament record');
    expect(
      recordLabel({ scopeType: 'COMPETITION', displayName: 'X record', status: 'RESCINDED' }),
    ).toMatch(/rescinded — not a record/);
  });
});
