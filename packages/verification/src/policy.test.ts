import { describe, expect, it } from 'vitest';
import { REFERENCE_POLICY_SPEC, validatePolicySpec, type PolicySpec } from './policy';

const spec = (mutate: (s: { -readonly [K in keyof PolicySpec]: unknown }) => void): unknown => {
  const s = structuredClone(REFERENCE_POLICY_SPEC) as unknown as {
    -readonly [K in keyof PolicySpec]: unknown;
  };
  mutate(s);
  return s;
};
const levels = (s: { levels: unknown }) =>
  s.levels as {
    level: string;
    requiresPreviousLevel: boolean;
    criteria: { id: string; kind: string; params?: Record<string, unknown> }[];
  }[];
const codes = (input: unknown) => {
  const r = validatePolicySpec(input);
  return r.ok ? [] : r.issues.map((i) => i.code);
};

describe('declarative policy validation (closed vocabulary, BRT-01 floor, bounded)', () => {
  it('the reference policy is valid; key order never changes its hash', () => {
    const a = validatePolicySpec(REFERENCE_POLICY_SPEC);
    expect(a.ok).toBe(true);
    const reordered = JSON.parse(
      JSON.stringify({
        levels: [...REFERENCE_POLICY_SPEC.levels].reverse(),
        conflict: REFERENCE_POLICY_SPEC.conflict,
        targetEngine: REFERENCE_POLICY_SPEC.targetEngine,
      }),
    );
    const b = validatePolicySpec(reordered);
    expect(b.ok && a.ok && b.specHash === a.specHash).toBe(true);
  });

  it('a prefix policy (V0–V2 only) is allowed; V3/V4 are then NOT_DEFINED', () => {
    expect(
      validatePolicySpec(
        spec((s) => {
          s.levels = levels(s as { levels: unknown }).slice(0, 3);
        }),
      ).ok,
    ).toBe(true);
  });

  it('rejects: missing V0, broken ancestry, V1 without requiresPreviousLevel, duplicate levels', () => {
    expect(
      codes(
        spec((s) => {
          s.levels = levels(s as { levels: unknown }).slice(1);
        }),
      ),
    ).toContain('LEVEL_V0_MISSING');
    expect(
      codes(
        spec((s) => {
          const l = levels(s as { levels: unknown });
          s.levels = [l[0], l[2]];
        }),
      ),
    ).toContain('LEVEL_ANCESTRY_BROKEN');
    expect(
      codes(
        spec((s) => {
          levels(s as { levels: unknown })[1]!.requiresPreviousLevel = false;
        }),
      ),
    ).toContain('ANCESTRY_REQUIRED');
    expect(
      codes(
        spec((s) => {
          const l = levels(s as { levels: unknown });
          s.levels = [...l, l[1]];
        }),
      ),
    ).toEqual(['BRJ_SET_DUPLICATE']);
    expect(
      codes(
        spec((s) => {
          const l = levels(s as { levels: unknown });
          s.levels = [...l, { ...l[1]!, requiresPreviousLevel: false }];
        }),
      ),
    ).toEqual(['BRJ_SET_DUPLICATE_KEY']);
  });

  it('rejects: missing mandatory BRT-01 criteria, criteria at the wrong level, duplicate ids / kinds', () => {
    expect(
      codes(
        spec((s) => {
          const l = levels(s as { levels: unknown });
          l[2]!.criteria = l[2]!.criteria.filter((c) => c.kind !== 'OFFICIAL_DECLARATION');
        }),
      ),
    ).toContain('MANDATORY_CRITERION_MISSING:OFFICIAL_DECLARATION');
    expect(
      codes(
        spec((s) => {
          levels(s as { levels: unknown })[1]!.criteria.push({
            id: 'v1.x',
            kind: 'OFFICIAL_DECLARATION',
          });
        }),
      ),
    ).toContain('CRITERION_NOT_ALLOWED_AT_LEVEL');
    expect(
      codes(
        spec((s) => {
          levels(s as { levels: unknown })[0]!.criteria.push({
            id: 'v0.dispute',
            kind: 'NO_ACTIVE_DISPUTE',
          });
        }),
      ),
    ).toContain('CRITERION_NOT_ALLOWED_AT_LEVEL');
    expect(
      codes(
        spec((s) => {
          levels(s as { levels: unknown })[2]!.criteria.push({
            id: 'v1.no-counterparty-deny',
            kind: 'NO_ACTIVE_DISPUTE',
          });
        }),
      ),
    ).toContain('DUPLICATE_CRITERION_ID');
    expect(
      codes(
        spec((s) => {
          levels(s as { levels: unknown })[1]!.criteria.push({
            id: 'v1.again',
            kind: 'INDEPENDENT_CORROBORATION',
          });
        }),
      ),
    ).toContain('DUPLICATE_CRITERION_KIND');
  });

  it('rejects: unknown criterion kind, capability, recognition level; impossible counts; misplaced params', () => {
    expect(
      codes(
        spec((s) => {
          levels(s as { levels: unknown })[1]!.criteria[0]!.kind = 'TRUST_SCORE_ABOVE';
        }),
      ),
    ).toEqual(['BRJ_ENUM']);
    expect(
      codes(
        spec((s) => {
          levels(s as { levels: unknown })[2]!.criteria.find(
            (c) => c.kind === 'OFFICIAL_DECLARATION',
          )!.params = { capabilities: ['GOD_MODE'] };
        }),
      ),
    ).toEqual(['BRJ_ENUM']);
    expect(
      codes(
        spec((s) => {
          levels(s as { levels: unknown })[2]!.criteria.find(
            (c) => c.kind === 'OFFICIAL_DECLARATION',
          )!.params = { capabilities: ['SANCTION'] };
        }),
      ),
    ).toContain('CAPABILITY_NOT_ALLOWED');
    expect(
      codes(
        spec((s) => {
          levels(s as { levels: unknown })[3]!.criteria.find(
            (c) => c.kind === 'COMPETITION_SANCTIONED',
          )!.params = { minRecognitionLevel: 'PLATFORM' };
        }),
      ),
    ).toEqual(['BRJ_ENUM']);
    expect(
      codes(
        spec((s) => {
          levels(s as { levels: unknown })[3]!.criteria.find(
            (c) => c.kind === 'COMPETITION_SANCTIONED',
          )!.params = { minRecognitionLevel: 'GALACTIC' };
        }),
      ),
    ).toEqual(['BRJ_ENUM']);
    expect(
      codes(
        spec((s) => {
          levels(s as { levels: unknown })[1]!.criteria[0]!.params = { minIssuers: 0 };
        }),
      ),
    ).toEqual(['BRJ_SCHEMA_CONSTRAINT']);
    expect(
      codes(
        spec((s) => {
          levels(s as { levels: unknown })[4]!.criteria.find(
            (c) => c.kind === 'INDEPENDENT_PRIMARY_SOURCES',
          )!.params = { minSources: 1 };
        }),
      ),
    ).toEqual(['BRJ_SCHEMA_CONSTRAINT']);
    expect(
      codes(
        spec((s) => {
          levels(s as { levels: unknown })[1]!.criteria[1]!.params = { minIssuers: 2 };
        }),
      ),
    ).toContain('PARAM_NOT_ALLOWED');
  });

  it('rejects: floats, nulls, unknown members, executable-looking strings, unsupported engine, oversize', () => {
    expect(
      codes(
        spec((s) => {
          levels(s as { levels: unknown })[1]!.criteria[0]!.params = { minIssuers: 1.5 };
        }),
      ),
    ).toEqual(['BRJ_NON_INTEGER_NUMBER']);
    expect(
      codes(
        spec((s) => {
          (s as Record<string, unknown>).conflict = null;
        }),
      ),
    ).toEqual(['BRJ_NULL']);
    expect(
      codes(
        spec((s) => {
          (s as Record<string, unknown>).script = 'return true';
        }),
      ),
    ).toEqual(['BRJ_UNKNOWN_FIELD']);
    expect(
      codes(
        spec((s) => {
          levels(s as { levels: unknown })[1]!.criteria[0]!.params = { expression: 'x > 1' };
        }),
      ),
    ).toEqual(['BRJ_UNKNOWN_FIELD']);
    expect(
      codes(
        spec((s) => {
          levels(s as { levels: unknown })[1]!.criteria[0]!.id = 'Drop Table;';
        }),
      ),
    ).toEqual(['BRJ_SCHEMA_CONSTRAINT']);
    expect(
      codes(
        spec((s) => {
          s.targetEngine = 'verification-engine/9';
        }),
      ),
    ).toEqual(['ENGINE_VERSION_UNSUPPORTED']);
    expect(
      codes(
        spec((s) => {
          const l = levels(s as { levels: unknown });
          for (let i = 0; i < 20; i++)
            l[4]!.criteria.push({ id: `v4.pad-${'x'.repeat(50)}-${i}`, kind: 'NO_ACTIVE_DISPUTE' });
        }),
      ),
    ).toEqual(['BRJ_SCHEMA_CONSTRAINT']);
  });
});
