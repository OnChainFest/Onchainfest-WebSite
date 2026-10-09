import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CANONICAL_CATALOG } from '../catalog-manifest';
import type { DisciplineVersionSpec } from '../catalog';
import { providedCapabilities, ResourceType } from '../capabilities';
import { formatEngine } from '../format/registry';
import {
  canonicalSchedulingProfileSpec,
  producedContestTypes,
  resolveRequirement,
  schedulingProfileCompatibility,
  schedulingProfileSpecHash,
  selectorSpecificity,
  validateSchedulingProfileSpec,
  type SchedulingProfileSpec,
  type SchedulingRequirement,
} from './profile';
import { SCHEDULING_PROFILE_TEMPLATES } from './templates';

/**
 * ONCF-05E-B · SchedulingProfile v1 (ADR-0072): validation, selectors, canonicalization and
 * hashing, pin-time compatibility, and the eight-sport (+ wheelchair) proof — all as data.
 */

const req = (over: Partial<SchedulingRequirement> = {}): SchedulingRequirement => ({
  selector: {},
  resourceType: 'TENNIS_COURT',
  capacityUnit: 'CONTEST',
  expectedDurationSeconds: 3_600,
  changeoverSeconds: 300,
  ...over,
});
const spec = (...requirements: SchedulingRequirement[]): SchedulingProfileSpec => ({
  specVersion: 1,
  requirements,
});
const template = (code: string): SchedulingProfileSpec => {
  const t = SCHEDULING_PROFILE_TEMPLATES.find((x) => x.code === code);
  if (t === undefined) throw new Error(`no template ${code}`);
  return t.spec;
};
const discipline = (code: string): DisciplineVersionSpec => {
  const d = CANONICAL_CATALOG.sports.flatMap((s) => s.disciplines).find((x) => x.code === code);
  const spec = d?.specs[d.specs.length - 1];
  if (spec === undefined) throw new Error(`no discipline ${code}`);
  return spec;
};
const produced = (disciplineCode: string, engineId: string, engineVersion: number) => {
  const engine = formatEngine(engineId, engineVersion);
  if (engine === undefined) throw new Error(`no engine ${engineId}/${engineVersion}`);
  return producedContestTypes(engine, discipline(disciplineCode).allowedContestTypes);
};
const compat = (profile: string, disciplineCode: string, engineId: string, engineVersion = 1) =>
  schedulingProfileCompatibility(
    template(profile),
    providedCapabilities(discipline(disciplineCode)),
    produced(disciplineCode, engineId, engineVersion),
  );

describe('validation (closed, bounded, integer seconds)', () => {
  it('every canonical template is valid', () => {
    for (const t of SCHEDULING_PROFILE_TEMPLATES)
      expect(validateSchedulingProfileSpec(t.spec), t.code).toEqual([]);
    expect(new Set(SCHEDULING_PROFILE_TEMPLATES.map((t) => t.code)).size).toBe(
      SCHEDULING_PROFILE_TEMPLATES.length,
    );
  });

  it('refuses a wrong schemaVersion, unknown keys and missing fields', () => {
    const issues = (s: unknown) => validateSchedulingProfileSpec(s).map((i) => i.path);
    expect(issues({ ...spec(req()), specVersion: 2 })).toContain('/specVersion');
    expect(issues({ requirements: [req()] })).toContain('/specVersion');
    expect(issues({ ...spec(req()), sessions: [] })).toContain('/sessions');
    expect(issues(spec({ ...req(), quantity: 2 } as never))).toContain('/requirements/0/quantity');
    expect(issues(spec({ ...req(), requiredCapacity: 4 } as never))).toContain(
      '/requirements/0/requiredCapacity',
    );
    const { resourceType: _r, ...noResource } = req();
    expect(issues(spec(noResource as never))).toContain('/requirements/0/resourceType');
    expect(issues({ specVersion: 1, requirements: [] })).toContain('/requirements');
    expect(issues(null)).toEqual(['']);
  });

  it('durations are positive / non-negative INTEGER seconds within bounds', () => {
    const bad: Partial<SchedulingRequirement>[] = [
      { expectedDurationSeconds: 0 },
      { expectedDurationSeconds: 90.5 },
      { expectedDurationSeconds: 86_401 },
      { expectedDurationSeconds: '3600' as never },
      { changeoverSeconds: -1 },
      { startSpacingSeconds: 0 },
      { concurrentStarts: 0 },
      { concurrentStarts: 1.5 },
      { dependencyLeadSeconds: -5 },
      { rest: { minimumSeconds: -1, enforcement: 'SOFT' } },
      { rest: { minimumSeconds: 60, enforcement: 'MAYBE' as never } },
      { rest: { minimumSeconds: 60 } as never },
      { maxUnitsPerEntrantPerDay: { value: 0, enforcement: 'HARD' } },
    ];
    for (const b of bad)
      expect(validateSchedulingProfileSpec(spec(req(b))), JSON.stringify(b)).not.toEqual([]);
    const ok = req({
      expectedDurationSeconds: 1,
      changeoverSeconds: 0,
      startSpacingSeconds: 1,
      concurrentStarts: 1,
      dependencyLeadSeconds: 0,
      rest: { minimumSeconds: 0, enforcement: 'HARD' },
      maxUnitsPerEntrantPerDay: { value: 1, enforcement: 'SOFT' },
    });
    expect(validateSchedulingProfileSpec(spec(ok))).toEqual([]);
  });

  it('capacity units are CONTEST or ENTRANT; resource types are catalog vocabulary', () => {
    expect(validateSchedulingProfileSpec(spec(req({ capacityUnit: 'ENTRANT' })))).toEqual([]);
    expect(
      validateSchedulingProfileSpec(spec(req({ capacityUnit: 'LANE' as never }))),
    ).toMatchObject([{ path: '/requirements/0/capacityUnit' }]);
    expect(
      validateSchedulingProfileSpec(spec(req({ resourceType: 'LANE' as never }))),
    ).toMatchObject([{ path: '/requirements/0/resourceType' }]);
  });

  it('regrouping is optional, bounded and orders field ordinals only', () => {
    const base = spec(req());
    expect(
      validateSchedulingProfileSpec({
        ...base,
        regrouping: { groupSize: 3, order: 'FIELD_ORDINAL_ASC' },
      }),
    ).toEqual([]);
    for (const regrouping of [
      { groupSize: 0, order: 'FIELD_ORDINAL_ASC' },
      { groupSize: 3, order: 'BY_SCORE' },
      { groupSize: 3, order: 'FIELD_ORDINAL_ASC', select: 'TOP' },
    ])
      expect(validateSchedulingProfileSpec({ ...base, regrouping })).toMatchObject([
        { path: '/regrouping' },
      ]);
  });
});

describe('selectors: precedence, ambiguity, determinism', () => {
  const MATCH_REQ = req({ selector: { contestType: 'MATCH' }, expectedDurationSeconds: 1_200 });
  const FINAL_MATCH = req({
    selector: { contestType: 'MATCH', roundType: 'FINAL' },
    expectedDurationSeconds: 2_400,
  });
  const FINAL_KO_MATCH = req({
    selector: { contestType: 'MATCH', roundType: 'FINAL', stagePrimitive: 'KNOCKOUT' },
    expectedDurationSeconds: 4_800,
  });

  it('A · default-only profile: every contest uses the default', () => {
    const s = spec(req());
    for (const contestType of ['MATCH', 'HEAT', 'SERIES', 'SESSION'] as const)
      expect(resolveRequirement(s, { contestType })).toMatchObject({ ok: true, index: 0 });
  });

  it('B · one specific selector applies to its contests only', () => {
    const s = spec(req(), MATCH_REQ);
    expect(resolveRequirement(s, { contestType: 'MATCH' })).toMatchObject({ ok: true, index: 1 });
    expect(resolveRequirement(s, { contestType: 'SERIES' })).toMatchObject({ ok: true, index: 0 });
  });

  it('C/D · multiple specificity levels: the most specific matching selector wins', () => {
    const s = spec(req(), MATCH_REQ, FINAL_MATCH, FINAL_KO_MATCH);
    expect(validateSchedulingProfileSpec(s)).toEqual([]);
    expect(
      resolveRequirement(s, {
        contestType: 'MATCH',
        roundType: 'FINAL',
        stagePrimitive: 'KNOCKOUT',
      }),
    ).toMatchObject({ ok: true, requirement: { expectedDurationSeconds: 4_800 } });
    expect(
      resolveRequirement(s, { contestType: 'MATCH', roundType: 'FINAL', stagePrimitive: 'FIELD' }),
    ).toMatchObject({ ok: true, requirement: { expectedDurationSeconds: 2_400 } });
    expect(resolveRequirement(s, { contestType: 'MATCH', roundType: 'GROUP' })).toMatchObject({
      ok: true,
      requirement: { expectedDurationSeconds: 1_200 },
    });
    expect(resolveRequirement(s, { contestType: 'HEAT', roundType: 'FINAL' })).toMatchObject({
      ok: true,
      requirement: { expectedDurationSeconds: 3_600 },
    });
    expect(FINAL_KO_MATCH.selector).toSatisfy((x: object) => selectorSpecificity(x) === 3);
  });

  it('E · equal-specificity selectors that can match the same contest are refused', () => {
    const overlapping = spec(
      req(),
      req({ selector: { contestType: 'HEAT' } }),
      req({ selector: { roundType: 'FINAL' } }),
    );
    expect(validateSchedulingProfileSpec(overlapping)).toMatchObject([
      { path: '/requirements/2/selector', message: expect.stringContaining('ambiguous') },
    ]);
    // …even when a more specific requirement exists for the intersection (no hidden tie-breaks).
    expect(
      validateSchedulingProfileSpec({
        ...overlapping,
        requirements: [
          ...overlapping.requirements,
          req({ selector: { contestType: 'HEAT', roundType: 'FINAL' } }),
        ],
      }),
    ).not.toEqual([]);
    // Identical selectors are the plainest overlap.
    expect(validateSchedulingProfileSpec(spec(req(), MATCH_REQ, MATCH_REQ))).not.toEqual([]);
    // Unvalidated input: resolution reports the tie instead of picking by position.
    expect(resolveRequirement(overlapping, { contestType: 'HEAT', roundType: 'FINAL' })).toEqual({
      ok: false,
      reason: 'AMBIGUOUS',
      indexes: [1, 2],
    });
    // Same specificity but disjoint on a dimension: no overlap, valid.
    expect(
      validateSchedulingProfileSpec(
        spec(req(), req({ selector: { contestType: 'HEAT' } }), MATCH_REQ),
      ),
    ).toEqual([]);
  });

  it('F · no specific match falls back to the default', () => {
    const s = spec(req({ expectedDurationSeconds: 999 }), FINAL_MATCH);
    expect(resolveRequirement(s, { contestType: 'MATCH', roundType: 'GROUP' })).toMatchObject({
      ok: true,
      requirement: { expectedDurationSeconds: 999 },
    });
    // A v1 contest (no stage primitive) never matches a stage-primitive selector.
    expect(
      resolveRequirement(spec(req(), FINAL_KO_MATCH), { contestType: 'MATCH', roundType: 'FINAL' }),
    ).toMatchObject({ ok: true, index: 0 });
  });

  it('G · a missing default (or two defaults) is a validation error', () => {
    expect(validateSchedulingProfileSpec(spec(MATCH_REQ))).toMatchObject([
      { path: '/requirements', message: expect.stringContaining('found 0') },
    ]);
    expect(validateSchedulingProfileSpec(spec(req(), req()))).toMatchObject([
      { path: '/requirements', message: expect.stringContaining('found 2') },
    ]);
    expect(resolveRequirement(spec(MATCH_REQ), { contestType: 'HEAT' })).toEqual({
      ok: false,
      reason: 'NO_MATCH',
      indexes: [],
    });
  });

  it('H · resolution is independent of declaration order (every permutation)', () => {
    const all = [req(), MATCH_REQ, FINAL_MATCH, FINAL_KO_MATCH];
    const contests = [
      { contestType: 'MATCH', roundType: 'FINAL', stagePrimitive: 'KNOCKOUT' },
      { contestType: 'MATCH', roundType: 'FINAL' },
      { contestType: 'MATCH', roundType: 'GROUP', stagePrimitive: 'ROUND_ROBIN' },
      { contestType: 'SERIES', roundType: 'SESSION', stagePrimitive: 'FIELD' },
    ] as const;
    const expected = contests.map(
      (c) =>
        (resolveRequirement(spec(...all), c) as { requirement: SchedulingRequirement }).requirement,
    );
    fc.assert(
      fc.property(fc.shuffledSubarray(all, { minLength: 4, maxLength: 4 }), (order) => {
        contests.forEach((c, i) =>
          expect(resolveRequirement(spec(...order), c)).toMatchObject({
            ok: true,
            requirement: expected[i],
          }),
        );
      }),
    );
  });

  it('I · canonicalization is deterministic despite selector ordering', () => {
    const all = [req(), MATCH_REQ, FINAL_MATCH, FINAL_KO_MATCH];
    const canonical = JSON.stringify(canonicalSchedulingProfileSpec(spec(...all)));
    const hash = schedulingProfileSpecHash(spec(...all));
    fc.assert(
      fc.property(fc.shuffledSubarray(all, { minLength: 4, maxLength: 4 }), (order) => {
        expect(JSON.stringify(canonicalSchedulingProfileSpec(spec(...order)))).toBe(canonical);
        expect(schedulingProfileSpecHash(spec(...order))).toBe(hash);
      }),
    );
    // Content-derived order: default first, then by specificity and values.
    expect(
      canonicalSchedulingProfileSpec(spec(FINAL_KO_MATCH, MATCH_REQ, req())).requirements.map((r) =>
        selectorSpecificity(r.selector),
      ),
    ).toEqual([0, 1, 3]);
  });

  it('J · invalid selector dimensions and values are refused', () => {
    expect(
      validateSchedulingProfileSpec(spec(req(), req({ selector: { sport: 'golf' } as never }))),
    ).toMatchObject([{ path: '/requirements/1/selector/sport' }]);
    expect(
      validateSchedulingProfileSpec(
        spec(req(), req({ selector: { roundType: 'SEMIS' as never } })),
      ),
    ).toMatchObject([{ path: '/requirements/1/selector/roundType' }]);
    expect(
      validateSchedulingProfileSpec(
        spec(req(), req({ selector: { stagePrimitive: 'LADDER' as never } })),
      ),
    ).toMatchObject([{ path: '/requirements/1/selector/stagePrimitive' }]);
    expect(validateSchedulingProfileSpec(spec(req({ selector: null as never })))).not.toEqual([]);
  });
});

describe('canonicalization and hashing', () => {
  const base = template('golf-course-tee-groups');

  it('1/2 · equivalent objects and property orders → same canonical form and hash', () => {
    const reordered = JSON.parse(
      JSON.stringify(base, (_k, v: unknown) =>
        v !== null && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).reverse())
          : v,
      ),
    ) as SchedulingProfileSpec;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(base));
    expect(canonicalSchedulingProfileSpec(reordered)).toEqual(canonicalSchedulingProfileSpec(base));
    expect(schedulingProfileSpecHash(reordered)).toBe(schedulingProfileSpecHash(base));
    // The default concurrentStarts is explicit in the canonical form: absent ≡ 1.
    const implicit = spec(req());
    const explicit = spec(req({ concurrentStarts: 1 }));
    expect(schedulingProfileSpecHash(implicit)).toBe(schedulingProfileSpecHash(explicit));
    expect(canonicalSchedulingProfileSpec(implicit).requirements[0]?.concurrentStarts).toBe(1);
    expect(schedulingProfileSpecHash(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('3 · selector order does not change the hash', () => {
    const swapped = { ...base, requirements: [...base.requirements].reverse() };
    expect(schedulingProfileSpecHash(swapped)).toBe(schedulingProfileSpecHash(base));
  });

  it('4/5/6 · a changed duration, resource requirement or selector changes the hash', () => {
    const h = schedulingProfileSpecHash(base);
    const edit = (i: number, over: Partial<SchedulingRequirement>): SchedulingProfileSpec => ({
      ...base,
      requirements: base.requirements.map((r, j) => (j === i ? { ...r, ...over } : r)),
    });
    const variants = [
      edit(0, { expectedDurationSeconds: 14_401 }),
      edit(0, { changeoverSeconds: 60 }),
      edit(0, { resourceType: 'ROAD_COURSE' }),
      edit(0, { capacityUnit: 'CONTEST' }),
      edit(1, { selector: { contestType: 'SERIES' } }),
      edit(1, { selector: { contestType: 'MATCH', roundType: 'FINAL' } }),
      edit(0, { rest: { minimumSeconds: 0, enforcement: 'HARD' } }),
      { ...base, regrouping: { groupSize: 4, order: 'FIELD_ORDINAL_DESC' as const } },
    ];
    const hashes = variants.map(schedulingProfileSpecHash);
    for (const x of hashes) expect(x).not.toBe(h);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('7 · an invalid (ambiguous) profile cannot be canonicalized or hashed', () => {
    const ambiguous = spec(
      req(),
      req({ selector: { contestType: 'HEAT' } }),
      req({ selector: { roundType: 'FINAL' } }),
    );
    expect(() => canonicalSchedulingProfileSpec(ambiguous)).toThrow(/ambiguous/);
    expect(() => schedulingProfileSpecHash(ambiguous)).toThrow(/ambiguous/);
  });
});

describe('pin-time compatibility is capability data, never sport identity', () => {
  it('compatible: the discipline declares every resource type and the default covers the format', () => {
    expect(compat('tennis-court-match', 'tennis.singles', 'single-elimination', 2)).toEqual([]);
    expect(compat('padel-court-match', 'padel.doubles', 'groups-knockout')).toEqual([]);
  });

  it('incompatible: a resource type the discipline does not declare (capability mismatch)', () => {
    expect(compat('padel-court-match', 'tennis.singles', 'single-elimination', 2)).toEqual([
      {
        capability: 'resourceType',
        message: 'requires resource type PADEL_COURT, which the discipline does not declare',
      },
    ]);
    expect(compat('basketball-court-game', 'basketball.3x3', 'groups-knockout')).toMatchObject([
      { capability: 'resourceType' },
    ]);
  });

  it('a v1 discipline declares no resource types and cannot pin any profile', () => {
    const v1 = CANONICAL_CATALOG.sports
      .flatMap((s) => s.disciplines)
      .find((d) => d.code === 'tennis.singles')?.specs[0] as DisciplineVersionSpec;
    expect(providedCapabilities(v1).resourceTypes).toEqual([]);
    for (const t of SCHEDULING_PROFILE_TEMPLATES)
      expect(
        schedulingProfileCompatibility(t.spec, providedCapabilities(v1), ['MATCH']),
      ).not.toEqual([]);
  });

  it('format coverage: every produced contest type resolves; a spec without a default is refused', () => {
    expect(produced('bowling.tenpin.singles', 'qualifying-knockout', 1)).toEqual([
      'MATCH',
      'SERIES',
    ]);
    const noDefault = spec(req({ selector: { contestType: 'MATCH' } }));
    const issues = schedulingProfileCompatibility(noDefault, { resourceTypes: ['TENNIS_COURT'] }, [
      'MATCH',
      'SERIES',
    ]);
    expect(issues.map((i) => i.capability)).toEqual(['spec']);
  });

  it('every canonical sport has at least one compatible template under one of its design formats', () => {
    const pairs: [string, string, string, number][] = [
      ['tennis-court-match', 'tennis.doubles', 'round-robin', 2],
      ['road-course-waves', 'running.road', 'wave-start', 1],
      ['pool-heats', 'swimming.pool', 'heats-final', 1],
      ['cycling-course-stage', 'cycling.road', 'multi-round', 1],
      ['cycling-course-stage', 'cycling.itt', 'interval-start', 1],
      ['cycling-course-stage', 'cycling.mtb_xc', 'mass-start', 1],
      ['bowling-lane-pair-blocks', 'bowling.tenpin.team', 'multi-round', 1],
      ['basketball-court-game', 'basketball.5x5', 'round-robin', 2],
      ['basketball-court-game', 'basketball.wheelchair', 'single-elimination', 2],
      ['basketball-half-court-3x3', 'basketball.3x3', 'groups-knockout', 1],
      ['golf-course-tee-groups', 'golf.individual', 'multi-round', 1],
      ['golf-course-tee-groups', 'golf.fourball', 'qualifying-knockout', 1],
    ];
    for (const [p, d, f, v] of pairs) expect(compat(p, d, f, v), `${p} × ${d}`).toEqual([]);
  });
});

describe('sport proof: one generic profile type, only values differ', () => {
  const resolved = (code: string, contestType: 'MATCH' | 'HEAT' | 'SERIES' | 'SESSION') => {
    const r = resolveRequirement(template(code), { contestType });
    if (!r.ok) throw new Error(`${code}: ${r.reason}`);
    return r.requirement;
  };

  it('tennis: court, match duration, changeover, rest; one contest per court at a time', () => {
    expect(resolved('tennis-court-match', 'MATCH')).toMatchObject({
      resourceType: 'TENNIS_COURT',
      capacityUnit: 'CONTEST',
      expectedDurationSeconds: 5_400,
      changeoverSeconds: 600,
      rest: { minimumSeconds: 3_600, enforcement: 'SOFT' },
    });
    // Sequential contests on an exclusive court: no shared-capacity spacing is declared.
    expect(resolved('tennis-court-match', 'MATCH').startSpacingSeconds).toBeUndefined();
  });

  it('padel: court, doubles match (discipline participation), duration, changeover, rest', () => {
    expect(discipline('padel.doubles').participation.lineupSize).toEqual({ min: 2, max: 2 });
    expect(resolved('padel-court-match', 'MATCH')).toMatchObject({
      resourceType: 'PADEL_COURT',
      capacityUnit: 'CONTEST',
      expectedDurationSeconds: 5_400,
      changeoverSeconds: 600,
      rest: { minimumSeconds: 3_600 },
    });
  });

  it('running: course occupancy and wave start spacing are independent concepts', () => {
    const wave = resolved('road-course-waves', 'HEAT');
    expect(wave).toMatchObject({
      resourceType: 'ROAD_COURSE',
      capacityUnit: 'ENTRANT',
      expectedDurationSeconds: 21_600,
      startSpacingSeconds: 900,
    });
    const base = template('road-course-waves');
    const withSpacing = (s: number): SchedulingProfileSpec => ({
      ...base,
      requirements: [{ ...wave, startSpacingSeconds: s }],
    });
    const withOccupancy = (s: number): SchedulingProfileSpec => ({
      ...base,
      requirements: [{ ...wave, expectedDurationSeconds: s }],
    });
    expect(withSpacing(600).requirements[0]?.expectedDurationSeconds).toBe(21_600);
    expect(withOccupancy(18_000).requirements[0]?.startSpacingSeconds).toBe(900);
    expect(validateSchedulingProfileSpec(withSpacing(600))).toEqual([]);
    expect(validateSchedulingProfileSpec(withOccupancy(18_000))).toEqual([]);
    const hashes = [base, withSpacing(600), withOccupancy(18_000)].map(schedulingProfileSpecHash);
    expect(new Set(hashes).size).toBe(3);
    // Wave size is the format's (waveCapacity), never the profile's.
    expect(JSON.stringify(base)).not.toMatch(/wave|capacity"/i);
  });

  it('swimming: the pool is the resource; lanes stay plan slots (no lane resource, no lane unit)', () => {
    const heat = resolved('pool-heats', 'HEAT');
    expect(heat).toMatchObject({
      resourceType: 'POOL',
      capacityUnit: 'CONTEST',
      expectedDurationSeconds: 300,
      changeoverSeconds: 60,
    });
    expect(Object.values(ResourceType).some((t) => /LANE$/.test(t))).toBe(false);
    expect(JSON.stringify(template('pool-heats'))).not.toMatch(/lane/i);
    expect(discipline('swimming.pool').capabilities?.resourceTypes).toEqual(['POOL']);
    // Exclusive pool: consecutive heats are spaced by occupancy + changeover (ADR-0072 §7), so no
    // shared-capacity startSpacingSeconds is declared.
    expect(heat.startSpacingSeconds).toBeUndefined();
  });

  it('cycling: course resource, stage duration, start spacing and the time-trial session by selector', () => {
    expect(resolved('cycling-course-stage', 'HEAT')).toMatchObject({
      resourceType: 'CYCLING_COURSE',
      capacityUnit: 'ENTRANT',
      expectedDurationSeconds: 18_000,
      startSpacingSeconds: 300,
      maxUnitsPerEntrantPerDay: { value: 1, enforcement: 'HARD' },
    });
    // Interval starts within a session are the plan's startOffsetSeconds (format), not the profile's.
    const session = resolved('cycling-course-stage', 'SESSION');
    expect(session).toMatchObject({ expectedDurationSeconds: 3_600 });
    expect(session.startSpacingSeconds).toBeUndefined();
    expect(produced('cycling.itt', 'interval-start', 1)).toEqual(['SESSION']);
  });

  it('ten-pin bowling: lane-pair resource, grouped squad block (ENTRANT), stepladder match (CONTEST)', () => {
    const block = resolved('bowling-lane-pair-blocks', 'SERIES');
    expect(block).toMatchObject({
      resourceType: 'BOWLING_LANE_PAIR',
      capacityUnit: 'ENTRANT',
      expectedDurationSeconds: 9_000,
    });
    expect(resolved('bowling-lane-pair-blocks', 'MATCH')).toMatchObject({
      resourceType: 'BOWLING_LANE_PAIR',
      capacityUnit: 'CONTEST',
      expectedDurationSeconds: 1_200,
      dependencyLeadSeconds: 300,
    });
    // The squad is the plan's GROUPED_ENTRANTS partition (05B); the profile declares no grouping.
    expect(discipline('bowling.tenpin.singles').capabilities?.startMethods).toContain(
      'GROUPED_ENTRANTS',
    );
    expect(template('bowling-lane-pair-blocks').regrouping).toBeUndefined();
    expect(JSON.stringify(template('bowling-lane-pair-blocks'))).not.toMatch(/squad|group|games/i);
  });

  it('basketball and wheelchair basketball pin the SAME generic profile version', () => {
    const game = resolved('basketball-court-game', 'MATCH');
    expect(game).toMatchObject({
      resourceType: 'BASKETBALL_COURT',
      capacityUnit: 'CONTEST',
      expectedDurationSeconds: 7_200,
      changeoverSeconds: 900,
      rest: { minimumSeconds: 10_800 },
    });
    expect(compat('basketball-court-game', 'basketball.5x5', 'groups-knockout')).toEqual([]);
    expect(compat('basketball-court-game', 'basketball.wheelchair', 'groups-knockout')).toEqual([]);
    // Wheelchair-specific constraints (classification points on court) stay in the discipline.
    expect(discipline('basketball.wheelchair').participation.lineupConstraint).toBeDefined();
    expect(JSON.stringify(template('basketball-court-game'))).not.toMatch(/classification/i);
  });

  it('golf: course, tee groups, start spacing and round duration are independent; post-cut regrouping', () => {
    const round = resolved('golf-course-tee-groups', 'SERIES');
    expect(round).toMatchObject({
      resourceType: 'GOLF_COURSE',
      capacityUnit: 'ENTRANT',
      expectedDurationSeconds: 14_400,
      startSpacingSeconds: 600,
      concurrentStarts: 2,
    });
    expect(template('golf-course-tee-groups').regrouping).toEqual({
      groupSize: 3,
      order: 'FIELD_ORDINAL_DESC',
    });
    const base = template('golf-course-tee-groups');
    const set = (over: Partial<SchedulingRequirement>): SchedulingProfileSpec => ({
      ...base,
      requirements: base.requirements.map((r) =>
        Object.keys(r.selector).length === 0 ? { ...r, ...over } : r,
      ),
    });
    const longerRound = resolveRequirement(set({ expectedDurationSeconds: 16_200 }), {
      contestType: 'SERIES',
    });
    const tighterTees = resolveRequirement(set({ startSpacingSeconds: 480 }), {
      contestType: 'SERIES',
    });
    expect(longerRound).toMatchObject({
      requirement: { expectedDurationSeconds: 16_200, startSpacingSeconds: 600 },
    });
    expect(tighterTees).toMatchObject({
      requirement: { expectedDurationSeconds: 14_400, startSpacingSeconds: 480 },
    });
    const hashes = [
      base,
      set({ expectedDurationSeconds: 16_200 }),
      set({ startSpacingSeconds: 480 }),
    ];
    expect(new Set(hashes.map(schedulingProfileSpecHash)).size).toBe(3);
  });

  it('the domain module never names a sport (data only)', () => {
    const src = readFileSync(fileURLToPath(new URL('./profile.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(
      /tennis|padel|golf|swim|bowling|basketball|wheelchair|cycling|marathon|running|sport\s*===|discipline\s*===/i,
    );
  });
});
