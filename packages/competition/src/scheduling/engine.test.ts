import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONFLICT_ENGINE,
  ENGINE_COVERAGE,
  ENGINE_UNCOVERED_CODES,
  evaluateSchedule,
  ScheduleEvaluationError,
  type ScheduleEvaluationInput,
} from './engine';
import type { ContestStatus } from '../lifecycle';
import { at, codes, HOUR, MIN, must, ofCode, spec, T0, World } from './engine.fixture';
import {
  canonicalScheduleReport,
  compareConflicts,
  CONFLICT_CODES,
  conflictKey,
  reportVerdict,
  scheduleReportHash,
  type ScheduleConflictReport,
} from './report';

/**
 * ONCF-05E-D conflict / feasibility engine (ADR-0074): every rule with a conflicting case, a
 * non-conflicting case and its boundary; determinism, hashing, key uniqueness, malformed input.
 */

const run = (w: World): ScheduleConflictReport => evaluateSchedule(w.input());
const TENNIS = spec({ resourceType: 'TENNIS_COURT', changeoverSeconds: 600 });

/** A tennis-like world: event e1, courts c1/c2, entrants x1…x8. */
function courts(profile = TENNIS) {
  const w = new World().event('e1', { profile }).resource('c1').resource('c2');
  for (let i = 1; i <= 8; i++) w.entrant(`x${i}`);
  return w;
}

describe('contract: one engine, 19 codes, reportVersion 2', () => {
  it('declares its identity and exactly the 19 covered codes (D1, D15)', () => {
    const r = run(courts());
    expect(r.reportVersion).toBe(2);
    expect(r.validator).toEqual(CONFLICT_ENGINE);
    expect(r.coverage).toHaveLength(19);
    expect([...r.coverage].sort()).toEqual(
      CONFLICT_CODES.filter((c) => !ENGINE_UNCOVERED_CODES.includes(c)).sort(),
    );
    expect(r.coverage).not.toContain('LONG_WAIT');
    expect(r.coverage).not.toContain('UNDERUSED_RESOURCE');
    expect(r.coverage).not.toContain('SEQUENCING_INEFFICIENCY');
    expect(ENGINE_COVERAGE).toHaveLength(19);
    expect(r.inputs.competitionTimezone).toBe('UTC');
    expect(r.conflicts).toEqual([]);
  });

  it('takes exactly one argument: no options can narrow the coverage', () => {
    expect(evaluateSchedule.length).toBe(1);
  });

  it('the report carries no wall-clock value and is already canonical', () => {
    const r = run(
      courts()
        .contest('m1', { entrants: ['x1', 'x2'] })
        .assign('m1', { resource: 'c1' }),
    );
    expect(JSON.stringify(r)).not.toMatch(/evaluatedAt|generatedAt|now/i);
    expect(canonicalScheduleReport(r)).toEqual(r);
  });
});

describe('R1 — EXCLUSIVE occupancy on blocking intervals (D3, D6)', () => {
  const base = () =>
    courts()
      .contest('m1', { entrants: ['x1', 'x2'] })
      .contest('m2', { entrants: ['x3', 'x4'] });

  it('two units overlapping on one court: one RESOURCE_OVERLAP, never A/B and B/A', () => {
    const r = run(
      base()
        .assign('m1', { resource: 'c1', start: 0, changeover: 600 })
        .assign('m2', { resource: 'c1', start: 30 }),
    );
    const c = ofCode(r, 'RESOURCE_OVERLAP');
    expect(c).toHaveLength(1);
    expect(c[0]?.assignmentIds).toEqual(['a-m1', 'a-m2']);
    expect(c[0]?.unitKeys).toEqual(['contest:m1', 'contest:m2']);
    expect(c[0]?.severity).toBe('HARD');
    expect(c[0]?.interval).toEqual({ start: T0 / 1000, end: (at(60) + 600_000) / 1000 });
  });

  it('touching intervals never overlap (changeover 0)', () => {
    const w = courts(spec({ changeoverSeconds: 0 }))
      .contest('m1', { entrants: ['x1', 'x2'] })
      .contest('m2', { entrants: ['x3', 'x4'] })
      .assign('m1', { resource: 'c1', start: 0, end: 60 })
      .assign('m2', { resource: 'c1', start: 60, end: 120 });
    expect(codes(run(w))).toEqual([]);
  });

  it('the stored changeover blocks the court: inside it conflicts, at its end it does not', () => {
    const inside = base()
      .assign('m1', { resource: 'c1', start: 0, end: 60, changeover: 600 })
      .assign('m2', { resource: 'c1', start: 69 });
    expect(codes(run(inside))).toContain('RESOURCE_OVERLAP');
    const boundary = base()
      .assign('m1', { resource: 'c1', start: 0, end: 60, changeover: 600 })
      .assign('m2', { resource: 'c1', start: 70 });
    expect(codes(run(boundary))).not.toContain('RESOURCE_OVERLAP');
  });

  it('the engine uses the STORED changeover, never the profile value', () => {
    const w = base()
      .assign('m1', { resource: 'c1', start: 0, end: 60, changeover: 0 })
      .assign('m2', { resource: 'c1', start: 60 });
    expect(codes(run(w))).not.toContain('RESOURCE_OVERLAP');
  });

  it('claims of the same unit coexist on one EXCLUSIVE resource', () => {
    const w = new World()
      .event('e1', {
        profile: spec({ resourceType: 'BOWLING_LANE_PAIR', capacityUnit: 'ENTRANT' }),
      })
      .resource('lp1', { type: 'BOWLING_LANE_PAIR', capacity: 4 });
    for (const i of [1, 2, 3])
      w.entrant(`b${i}`).contest(`s${i}`, {
        grouped: true,
        partitionKey: 't1',
        type: 'SERIES',
        primitive: 'FIELD',
        roundType: 'SESSION',
        entrants: [`b${i}`],
        unitParticipant: `b${i}`,
      });
    for (const i of [1, 2, 3]) w.assign(`s${i}`, { resource: 'lp1', start: 0 });
    expect(codes(run(w))).toEqual([]);
  });

  it('the mode is the declared one: capacity never makes a resource shared', () => {
    const w = base()
      .resource('big', { capacity: 50, mode: 'EXCLUSIVE' })
      .assign('m1', { resource: 'big', start: 0 })
      .assign('m2', { resource: 'big', start: 0 });
    expect(codes(run(w))).toContain('RESOURCE_OVERLAP');
    expect(codes(run(w))).not.toContain('CAPACITY_EXCEEDED');
  });
});

describe('R4 — exclusivity keys, including the same unit (D6)', () => {
  const basketball = () =>
    new World()
      .event('e1', { profile: spec({ resourceType: 'BASKETBALL_COURT', changeoverSeconds: 900 }) })
      .event('e2', { profile: spec({ resourceType: 'BASKETBALL_HALF_COURT' }) })
      .resource('full', { type: 'BASKETBALL_COURT', keys: ['c1-a', 'c1-b'] })
      .resource('halfA', { type: 'BASKETBALL_HALF_COURT', keys: ['c1-a'] })
      .resource('halfB', { type: 'BASKETBALL_HALF_COURT', keys: ['c1-b'] })
      .entrant('t1')
      .entrant('t2')
      .entrant('t3')
      .entrant('t4')
      .entrant('t5')
      .entrant('t6')
      .contest('g1', { entrants: ['t1', 't2'] })
      .contest('h1', { event: 'e2', entrants: ['t3', 't4'] })
      .contest('h2', { event: 'e2', entrants: ['t5', 't6'] });

  it('a full-court game and a half-court game at once: EXCLUSIVITY_CONFLICT; halves coexist', () => {
    const r = run(
      basketball()
        .assign('g1', { resource: 'full', start: 0 })
        .assign('h1', { resource: 'halfA', start: 0 })
        .assign('h2', { resource: 'halfB', start: 30 }),
    );
    const ex = ofCode(r, 'EXCLUSIVITY_CONFLICT');
    expect(ex.map((c) => c.resourceIds)).toEqual([
      ['full', 'halfA'],
      ['full', 'halfB'],
    ]);
    const halves = run(
      basketball()
        .assign('h1', { resource: 'halfA', start: 0 })
        .assign('h2', { resource: 'halfB', start: 0 }),
    );
    expect(codes(halves)).toEqual([]);
  });

  it("the full court's changeover propagates to its halves", () => {
    const inside = basketball()
      .assign('g1', { resource: 'full', start: 0, end: 120, changeover: 900 })
      .assign('h1', { resource: 'halfA', start: 130 });
    expect(codes(run(inside))).toContain('EXCLUSIVITY_CONFLICT');
    const after = basketball()
      .assign('g1', { resource: 'full', start: 0, end: 120, changeover: 900 })
      .assign('h1', { resource: 'halfA', start: 135 });
    expect(codes(run(after))).not.toContain('EXCLUSIVITY_CONFLICT');
  });

  it('one squad on lane pairs {11,12} and {12,13} at once uses lane 12 twice', () => {
    const squad = (pairB: string) => {
      const w = new World()
        .event('e1', {
          profile: spec({ resourceType: 'BOWLING_LANE_PAIR', capacityUnit: 'ENTRANT' }),
        })
        .resource('p11', { type: 'BOWLING_LANE_PAIR', capacity: 4, keys: ['lane-11', 'lane-12'] })
        .resource('p12', { type: 'BOWLING_LANE_PAIR', capacity: 4, keys: ['lane-12', 'lane-13'] })
        .resource('p13', { type: 'BOWLING_LANE_PAIR', capacity: 4, keys: ['lane-13', 'lane-14'] });
      for (const i of [1, 2])
        w.entrant(`b${i}`).contest(`s${i}`, {
          grouped: true,
          partitionKey: 't1',
          type: 'SERIES',
          primitive: 'FIELD',
          roundType: 'SESSION',
          entrants: [`b${i}`],
          unitParticipant: `b${i}`,
        });
      return w
        .assign('s1', { resource: 'p11', start: 0 })
        .assign('s2', { resource: pairB, start: 0 });
    };
    const twice = ofCode(run(squad('p12')), 'EXCLUSIVITY_CONFLICT');
    expect(twice).toHaveLength(1);
    expect(twice[0]?.unitKeys).toEqual(['partition:r1:t1']);
    expect(twice[0]?.resourceIds).toEqual(['p11', 'p12']);
    expect(codes(run(squad('p13')))).toEqual([]);
  });

  it('a SHARED course and its EXCLUSIVE twin sharing a key never overlap', () => {
    const w = new World()
      .event('e1', { profile: spec({ resourceType: 'CYCLING_COURSE', capacityUnit: 'ENTRANT' }) })
      .resource('mass', { type: 'CYCLING_COURSE', mode: 'SHARED', capacity: 500, keys: ['course'] })
      .resource('tt', {
        type: 'CYCLING_COURSE',
        mode: 'EXCLUSIVE',
        capacity: 500,
        keys: ['course'],
      })
      .entrant('r1')
      .entrant('r2')
      .contest('stage', { type: 'HEAT', primitive: 'FIELD', entrants: ['r1'] })
      .contest('itt', { type: 'SESSION', primitive: 'FIELD', round: 'r2', entrants: ['r2'] })
      .assign('stage', { resource: 'mass', start: 0, end: 300 })
      .assign('itt', { resource: 'tt', start: 200, end: 260 });
    expect(codes(run(w))).toContain('EXCLUSIVITY_CONFLICT');
  });
});

describe('R2 / R3 — capacity counts places (D6)', () => {
  function shared(capacity: number) {
    return new World()
      .event('e1', {
        profile: spec({
          resourceType: 'ROAD_COURSE',
          capacityUnit: 'ENTRANT',
          changeoverSeconds: 600,
        }),
      })
      .resource('road', { type: 'ROAD_COURSE', mode: 'SHARED', capacity });
  }
  const wave = (w: World, id: string, size: number, start: number, end: number) => {
    const es = Array.from({ length: size }, (_, i) => `${id}-r${i}`);
    for (const e of es) w.entrant(e);
    return w
      .contest(id, { type: 'HEAT', primitive: 'FIELD', entrants: es, round: `r-${id}` })
      .assign(id, { resource: 'road', start, end });
  };

  it('SHARED: summed consumption above capacity is CAPACITY_EXCEEDED with each claim', () => {
    const w = shared(5);
    wave(w, 'w1', 3, 0, 120);
    wave(w, 'w2', 3, 60, 180);
    const c = ofCode(run(w), 'CAPACITY_EXCEEDED');
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ expected: 5, actual: 6 });
    expect(c[0]?.consumption).toEqual([
      { assignmentId: 'a-w1', resourceId: 'road', units: 3 },
      { assignmentId: 'a-w2', resourceId: 'road', units: 3 },
    ]);
  });

  it('exactly at capacity is fine; touching claims never add up', () => {
    const atCap = shared(6);
    wave(atCap, 'w1', 3, 0, 120);
    wave(atCap, 'w2', 3, 60, 180);
    expect(codes(run(atCap))).not.toContain('CAPACITY_EXCEEDED');
    const touching = shared(3);
    wave(touching, 'w1', 3, 0, 60);
    wave(touching, 'w2', 3, 60, 120);
    expect(codes(run(touching))).not.toContain('CAPACITY_EXCEEDED');
  });

  it('changeover has no effect on a SHARED resource', () => {
    const w = shared(3);
    wave(w, 'w1', 3, 0, 60);
    w.assignments[0] = { ...must(w.assignments[0]), changeoverSeconds: 3_600 };
    wave(w, 'w2', 3, 60, 120);
    expect(codes(run(w))).not.toContain('CAPACITY_EXCEEDED');
  });

  it('two separate over-capacity windows are two conflicts', () => {
    const w = shared(4);
    wave(w, 'w1', 3, 0, 600);
    wave(w, 'w2', 3, 10, 20);
    wave(w, 'w3', 3, 100, 110);
    expect(ofCode(run(w), 'CAPACITY_EXCEEDED')).toHaveLength(2);
  });

  it('R3: a unit of 5 on a 4-seat EXCLUSIVE lane pair; 4 fits', () => {
    const squad = (n: number) => {
      const w = new World()
        .event('e1', {
          profile: spec({ resourceType: 'BOWLING_LANE_PAIR', capacityUnit: 'ENTRANT' }),
        })
        .resource('lp', { type: 'BOWLING_LANE_PAIR', capacity: 4 });
      for (let i = 1; i <= n; i++)
        w.entrant(`b${i}`)
          .contest(`s${i}`, {
            grouped: true,
            partitionKey: 't1',
            type: 'SERIES',
            primitive: 'FIELD',
            roundType: 'SESSION',
            entrants: [`b${i}`],
            unitParticipant: `b${i}`,
          })
          .assign(`s${i}`, { resource: 'lp', start: 0 });
      return run(w);
    };
    expect(ofCode(squad(5), 'CAPACITY_EXCEEDED')[0]).toMatchObject({ expected: 4, actual: 5 });
    expect(codes(squad(4))).toEqual([]);
  });

  it('ENTRANT consumption: VACANT and overridden-empty places do not count; unresolved and STALE do', () => {
    const w = shared(2).entrant('a').entrant('b');
    w.contest('f1', { type: 'HEAT', primitive: 'FIELD', round: 'r0', entrants: ['a', 'b'] });
    w.contest('h', { type: 'HEAT', primitive: 'FIELD' });
    w.place('h', 1, { state: 'VACANT', feeders: ['f1'] })
      .place('h', 2, { state: 'OVERRIDDEN', occupant: null, feeders: ['f1'] })
      .place('h', 3, { state: 'UNRESOLVED', feeders: ['f1'] })
      .place('h', 4, { state: 'STALE', occupant: 'a', feeders: ['f1'] })
      .place('h', 5, { state: 'OVERRIDDEN', occupant: 'b', feeders: ['f1'] })
      .assign('f1', { resource: 'road', start: -600, end: -500 })
      .assign('h', { resource: 'road', start: 0, end: 60 });
    expect(ofCode(run(w), 'CAPACITY_EXCEEDED')[0]?.consumption).toEqual([
      { assignmentId: 'a-h', resourceId: 'road', units: 3 },
    ]);
  });

  it('no governing requirement: consumption unknown, R2 skipped, INCOMPLETE (consumption), R1 still applies', () => {
    const w = new World()
      .event('e1', { profile: null })
      .resource('road', { type: 'ROAD_COURSE', mode: 'SHARED', capacity: 1 })
      .resource('court')
      .entrant('a')
      .entrant('b')
      .entrant('c')
      .entrant('d')
      .contest('h1', { entrants: ['a'] })
      .contest('h2', { entrants: ['b'] })
      .contest('m1', { entrants: ['c'] })
      .contest('m2', { entrants: ['d'] })
      .assign('h1', { resource: 'road', start: 0 })
      .assign('h2', { resource: 'road', start: 10 })
      .assign('m1', { resource: 'court', start: 0 })
      .assign('m2', { resource: 'court', start: 10 });
    const r = run(w);
    expect(codes(r)).not.toContain('CAPACITY_EXCEEDED');
    expect(ofCode(r, 'RESOURCE_OVERLAP')).toHaveLength(1);
    const inc = ofCode(r, 'INCOMPLETE_ASSIGNMENT');
    expect(inc).toHaveLength(4);
    expect(new Set(inc.map((c) => c.actual))).toEqual(new Set(['consumption']));
    expect(codes(r)).not.toContain('START_SPACING');
    expect(codes(r)).not.toContain('CONCURRENT_STARTS_EXCEEDED');
  });
});

describe('B4 / D7 — start events on SHARED resources', () => {
  function course(req: Parameters<typeof spec>[0] = {}) {
    return new World()
      .event('e1', {
        profile: spec({
          resourceType: 'ROAD_COURSE',
          capacityUnit: 'ENTRANT',
          startSpacingSeconds: 900,
          ...req,
        }),
      })
      .resource('road', { type: 'ROAD_COURSE', mode: 'SHARED', capacity: 10_000 });
  }
  const wave = (
    w: World,
    id: string,
    start: number,
    o: { event?: string; end?: number | null } = {},
  ) =>
    w
      .entrant(`${id}-x`)
      .contest(id, {
        type: 'HEAT',
        primitive: 'FIELD',
        round: `r-${id}`,
        entrants: [`${id}-x`],
        ...(o.event === undefined ? {} : { event: o.event }),
      })
      .assign(id, { resource: 'road', start, ...(o.end === undefined ? {} : { end: o.end }) });

  it('waves 900 s apart are valid; 600 s apart is START_SPACING (900 / 600)', () => {
    const ok = course();
    wave(ok, 'w1', 0);
    wave(ok, 'w2', 15);
    wave(ok, 'w3', 30);
    expect(codes(run(ok))).toEqual([]);
    const tight = course();
    wave(tight, 'w1', 0);
    wave(tight, 'w2', 10);
    const c = ofCode(run(tight), 'START_SPACING');
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ expected: 900, actual: 600, severity: 'HARD' });
  });

  it('concurrency 1: two units at one instant; 2 allowed when declared; 3 exceeds 2', () => {
    const one = course();
    wave(one, 'w1', 0);
    wave(one, 'w2', 0);
    expect(ofCode(run(one), 'CONCURRENT_STARTS_EXCEEDED')[0]).toMatchObject({
      expected: 1,
      actual: 2,
    });
    const two = course({ concurrentStarts: 2, startSpacingSeconds: 600 });
    wave(two, 'g1', 0);
    wave(two, 'g2', 0);
    expect(codes(run(two))).toEqual([]);
    wave(two, 'g3', 0);
    expect(ofCode(run(two), 'CONCURRENT_STARTS_EXCEEDED')[0]).toMatchObject({
      expected: 2,
      actual: 3,
    });
  });

  it('different requirements on one resource: max spacing, min concurrency (300/600/900 example)', () => {
    const w = new World()
      .event('a', {
        profile: spec({
          resourceType: 'ROAD_COURSE',
          capacityUnit: 'ENTRANT',
          startSpacingSeconds: 300,
        }),
      })
      .event('b', {
        profile: spec({
          resourceType: 'ROAD_COURSE',
          capacityUnit: 'ENTRANT',
          startSpacingSeconds: 600,
        }),
      })
      .event('c', {
        profile: spec({
          resourceType: 'ROAD_COURSE',
          capacityUnit: 'ENTRANT',
          startSpacingSeconds: 900,
        }),
      })
      .resource('road', { type: 'ROAD_COURSE', mode: 'SHARED', capacity: 10_000 });
    wave(w, 'A', 0, { event: 'a' });
    wave(w, 'B', 10, { event: 'b' });
    wave(w, 'C', 25, { event: 'c' });
    expect(codes(run(w))).toEqual([]);
    const tight = new World()
      .event('a', {
        profile: spec({
          resourceType: 'ROAD_COURSE',
          capacityUnit: 'ENTRANT',
          startSpacingSeconds: 300,
        }),
      })
      .event('b', {
        profile: spec({
          resourceType: 'ROAD_COURSE',
          capacityUnit: 'ENTRANT',
          startSpacingSeconds: 600,
        }),
      })
      .resource('road', { type: 'ROAD_COURSE', mode: 'SHARED', capacity: 10_000 });
    wave(tight, 'A', 0, { event: 'a' });
    wave(tight, 'B', 5, { event: 'b' });
    expect(ofCode(run(tight), 'START_SPACING')[0]).toMatchObject({ expected: 600, actual: 300 });
  });

  it('spacing and concurrency never apply on an EXCLUSIVE resource', () => {
    const w = new World()
      .event('e1', { profile: spec({ startSpacingSeconds: 3_600, concurrentStarts: 1 }) })
      .resource('c1')
      .resource('c2')
      .entrant('a')
      .entrant('b')
      .contest('m1', { entrants: ['a'] })
      .contest('m2', { entrants: ['b'] })
      .assign('m1', { resource: 'c1', start: 0 })
      .assign('m2', { resource: 'c2', start: 0 });
    expect(codes(run(w))).toEqual([]);
  });

  it('a start event needs only the start: an end-less wave still violates spacing', () => {
    const w = course();
    wave(w, 'w1', 0, { end: null });
    wave(w, 'w2', 5);
    expect(codes(run(w))).toEqual(
      expect.arrayContaining(['START_SPACING', 'INCOMPLETE_ASSIGNMENT']),
    );
  });

  it('a unit without a requirement adds no bound; a governed neighbour still binds it', () => {
    const free = new World()
      .event('free', { profile: null })
      .resource('road', { type: 'ROAD_COURSE', mode: 'SHARED', capacity: 10_000 });
    wave(free, 'f1', 0, { event: 'free' });
    wave(free, 'f2', 0, { event: 'free' });
    wave(free, 'f3', 1, { event: 'free' });
    expect(codes(run(free))).not.toContain('START_SPACING');
    expect(codes(run(free))).not.toContain('CONCURRENT_STARTS_EXCEEDED');
    // Max spacing over the units of both slots: the governed wave's 900 s applies to the pair.
    const mixed = course().event('free', { profile: null });
    wave(mixed, 'w1', 0);
    wave(mixed, 'f1', 5, { event: 'free' });
    expect(ofCode(run(mixed), 'START_SPACING')[0]).toMatchObject({ expected: 900, actual: 300 });
  });
});

describe('units (D5): one start, one SHARED resource, recorded key, every member placed', () => {
  function golf() {
    const w = new World()
      .event('e1', {
        profile: spec({
          resourceType: 'GOLF_COURSE',
          capacityUnit: 'ENTRANT',
          startSpacingSeconds: 600,
          concurrentStarts: 2,
        }),
      })
      .resource('course', { type: 'GOLF_COURSE', mode: 'SHARED', capacity: 200 })
      .resource('course2', { type: 'GOLF_COURSE', mode: 'SHARED', capacity: 200, keys: ['other'] });
    for (const i of [1, 2, 3])
      w.entrant(`g${i}`).contest(`c${i}`, {
        grouped: true,
        partitionKey: 't1',
        type: 'SERIES',
        primitive: 'FIELD',
        roundType: 'SESSION',
        entrants: [`g${i}`],
        unitParticipant: `g${i}`,
      });
    return w;
  }
  const split = (r: ScheduleConflictReport) => ofCode(r, 'UNIT_SPLIT').map((c) => c.actual);

  it('all members at one start on one course: no conflict', () => {
    const w = golf();
    for (const i of [1, 2, 3])
      w.assign(`c${i}`, { resource: 'course', start: 0, unitKey: 'partition:r1:t1' });
    expect(codes(run(w))).toEqual([]);
  });

  it('a member one second later is UNIT_SPLIT (start), never a spacing self-comparison', () => {
    const w = golf()
      .assign('c1', { resource: 'course', start: 0 })
      .assign('c2', { resource: 'course', start: 0 })
      .assign('c3', { resource: 'course', startMs: at(0) + 1000 });
    const r = run(w);
    expect(split(r)).toEqual(['start']);
    expect(codes(r)).not.toContain('START_SPACING');
  });

  it('a member on a second SHARED course is UNIT_SPLIT (shared-multi-resource)', () => {
    const w = golf()
      .assign('c1', { resource: 'course', start: 0 })
      .assign('c2', { resource: 'course', start: 0 })
      .assign('c3', { resource: 'course2', start: 0 });
    expect(split(run(w))).toEqual(['shared-multi-resource']);
  });

  it('an unscheduled member is UNIT_SPLIT; an entirely VACANT or cancelled member is not', () => {
    const w = golf()
      .assign('c1', { resource: 'course', start: 0 })
      .assign('c2', { resource: 'course', start: 0 });
    expect(split(run(w))).toEqual(['unscheduled-member']);
    const vacant = golf()
      .assign('c1', { resource: 'course', start: 0 })
      .assign('c2', { resource: 'course', start: 0 });
    vacant.places.splice(
      vacant.places.findIndex((p) => p.contestId === 'c3'),
      1,
      {
        contestId: 'c3',
        place: 1,
        sourceKind: 'QUALIFIER',
        state: 'VACANT',
        occupantId: null,
        factId: 'f',
        feeders: [],
      },
    );
    expect(split(run(vacant))).toEqual([]);
    const cancelled = golf()
      .assign('c1', { resource: 'course', start: 0 })
      .assign('c2', { resource: 'course', start: 0 });
    cancelled.contests[2] = { ...must(cancelled.contests[2]), status: 'CANCELLED' };
    expect(split(run(cancelled))).toEqual([]);
  });

  it('a recorded key that differs from the derived one is UNIT_SPLIT (unit-key); NULL is accepted', () => {
    const w = golf();
    w.assign('c1', { resource: 'course', start: 0, unitKey: 'partition:r1:t9' })
      .assign('c2', { resource: 'course', start: 0, unitKey: null })
      .assign('c3', { resource: 'course', start: 0, unitKey: 'partition:r1:t1' });
    expect(split(run(w))).toEqual(['unit-key']);
  });

  it('several reasons are one conflict with sorted reasons', () => {
    const w = golf()
      .assign('c1', { resource: 'course', start: 0 })
      .assign('c2', { resource: 'course2', start: 5 });
    expect(split(run(w))).toEqual(['shared-multi-resource,start,unscheduled-member']);
  });

  it('a squad spanning several EXCLUSIVE lane pairs at one start is valid', () => {
    const w = new World()
      .event('e1', {
        profile: spec({ resourceType: 'BOWLING_LANE_PAIR', capacityUnit: 'ENTRANT' }),
      })
      .resource('p1', { type: 'BOWLING_LANE_PAIR', capacity: 4, keys: ['l1', 'l2'] })
      .resource('p2', { type: 'BOWLING_LANE_PAIR', capacity: 4, keys: ['l3', 'l4'] });
    for (let i = 1; i <= 8; i++)
      w.entrant(`b${i}`)
        .contest(`s${i}`, {
          grouped: true,
          partitionKey: 't1',
          type: 'SERIES',
          primitive: 'FIELD',
          roundType: 'SESSION',
          entrants: [`b${i}`],
          unitParticipant: `b${i}`,
        })
        .assign(`s${i}`, { resource: i <= 4 ? 'p1' : 'p2', start: 0 });
    expect(codes(run(w))).toEqual([]);
  });
});

describe('availability (D8): DECLARED-OPEN / DECLARED-CLOSED / UNRESTRICTED', () => {
  function court(open = false) {
    return new World(open)
      .event('e1', { profile: TENNIS })
      .resource('c1')
      .entrant('a')
      .entrant('b')
      .contest('m1', { entrants: ['a', 'b'] });
  }
  // T0 is Saturday (weekday 6) 08:00 UTC.
  const saturday = (start: string, end: string) =>
    ({ kind: 'WEEKLY', weekday: 6, start, end }) as const;

  it('inside a weekly window: nothing; outside: RESOURCE_UNAVAILABLE (HARD)', () => {
    const inside = court()
      .fact('w', 'c1', saturday('07:00', '20:00'))
      .assign('m1', { resource: 'c1', start: 0, end: 60 });
    expect(codes(run(inside))).toEqual([]);
    const outside = court()
      .fact('w', 'c1', saturday('09:00', '20:00'))
      .assign('m1', { resource: 'c1', start: 0, end: 60 });
    expect(ofCode(run(outside), 'RESOURCE_UNAVAILABLE')[0]).toMatchObject({ actual: 3_600 });
  });

  it('a weekly-ruled layer closes the other weekdays (closed, not unrestricted)', () => {
    const w = court()
      .fact('w', 'c1', { kind: 'WEEKLY', weekday: 1, start: '07:00', end: '20:00' })
      .assign('m1', { resource: 'c1', start: 0, end: 60 });
    expect(codes(run(w))).toEqual(['RESOURCE_UNAVAILABLE']);
  });

  it('DATE_CLOSED, BLACKOUT and MAINTENANCE are declared closures', () => {
    for (const fact of [
      { kind: 'DATE_CLOSED', date: '2026-11-14' },
      { kind: 'BLACKOUT', startsAt: at(30), endsAt: at(45), reason: 'storm' },
      { kind: 'MAINTENANCE', startsAt: at(-10), endsAt: at(5), reason: 'nets' },
    ] as const) {
      const w = court(true)
        .fact('x', 'c1', fact)
        .assign('m1', { resource: 'c1', start: 0, end: 60 });
      expect(codes(run(w)), fact.kind).toEqual(['RESOURCE_UNAVAILABLE']);
    }
  });

  it('a DATE_OPEN on an otherwise unruled layer declares that local day only', () => {
    const w = court().fact('d', 'c1', {
      kind: 'DATE_OPEN',
      date: '2026-11-14',
      start: '06:00',
      end: '22:00',
    });
    expect(codes(run(w.assign('m1', { resource: 'c1', start: 0, end: 60 })))).toEqual([]);
    const next = court()
      .fact('d', 'c1', { kind: 'DATE_OPEN', date: '2026-11-14', start: '06:00', end: '22:00' })
      .assign('m1', { resource: 'c1', start: 24 * 60, end: 24 * 60 + 60 });
    expect(codes(run(next))).toEqual(['AVAILABILITY_UNDECLARED']);
  });

  it('no facts at all: AVAILABILITY_UNDECLARED (SOFT), never treated as open', () => {
    const r = run(court().assign('m1', { resource: 'c1', start: 0, end: 60, changeover: 600 }));
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toMatchObject({
      code: 'AVAILABILITY_UNDECLARED',
      severity: 'SOFT',
      actual: 4_200,
    });
    expect(reportVerdict(r).hard).toBe(0);
  });

  it('a RETIRED resource is unavailable for the whole blocking interval', () => {
    const w = court(true);
    w.resources[0] = { ...must(w.resources[0]), status: 'RETIRED' };
    expect(
      ofCode(
        run(w.assign('m1', { resource: 'c1', start: 0, end: 60, changeover: 600 })),
        'RESOURCE_UNAVAILABLE',
      )[0],
    ).toMatchObject({
      actual: 4_200,
    });
  });

  it('a window crossing midnight, in the resource zone (America/Costa_Rica, UTC−6)', () => {
    const w = court();
    w.resources[0] = { ...must(w.resources[0]), zone: 'America/Costa_Rica' };
    // Friday 20:00 → Saturday 02:00 local = Saturday 02:00 → 08:00 UTC.
    w.fact('n', 'c1', { kind: 'WEEKLY', weekday: 5, start: '20:00', end: '02:00' });
    const inside = w.assign('m1', {
      resource: 'c1',
      startMs: T0 - 3 * HOUR,
      endMs: T0 - 2 * HOUR - 10 * MIN,
    });
    expect(codes(run(inside))).toEqual([]);
  });

  it('DST: a spring-forward day has a shorter local day (America/New_York, 2026-03-08)', () => {
    const w = new World(false)
      .event('e1', { profile: spec({ changeoverSeconds: 0 }) })
      .resource('c1', { zone: 'America/New_York' })
      .entrant('a')
      .contest('m1', { entrants: ['a'] })
      .fact('d', 'c1', { kind: 'DATE_OPEN', date: '2026-03-08', start: '01:00', end: '04:00' });
    // 01:00 EST = 06:00Z; 04:00 EDT = 08:00Z (02:00–03:00 does not exist).
    w.assign('m1', {
      resource: 'c1',
      startMs: Date.UTC(2026, 2, 8, 6),
      endMs: Date.UTC(2026, 2, 8, 8),
    });
    expect(codes(run(w))).toEqual([]);
    w.assignments[0] = { ...must(w.assignments[0]), expectedEndMs: Date.UTC(2026, 2, 8, 8, 30) };
    expect(codes(run(w))).toEqual(['RESOURCE_UNAVAILABLE']);
  });

  it('the changeover is part of the blocking interval: past closing it is unavailable; 0 is not', () => {
    const late = court()
      .fact('w', 'c1', saturday('07:00', '09:00'))
      .assign('m1', { resource: 'c1', start: 0, end: 60, changeover: 600 });
    expect(codes(run(late))).toEqual(['RESOURCE_UNAVAILABLE']);
    const zero = court()
      .fact('w', 'c1', saturday('07:00', '09:00'))
      .assign('m1', { resource: 'c1', start: 0, end: 60, changeover: 0 });
    expect(codes(run(zero))).toEqual([]);
  });

  it('a competition-wide declaration counts for every resource', () => {
    const w = court()
      .fact('w', null, saturday('07:00', '20:00'))
      .assign('m1', { resource: 'c1', start: 0, end: 60 });
    expect(codes(run(w))).toEqual([]);
  });
});

describe('event window (D9) and missing end (D3)', () => {
  const windowed = () =>
    new World()
      .event('e1', { profile: TENNIS, windowStartMs: at(0), windowEndMs: at(240) })
      .resource('c1')
      .resource('c2')
      .entrant('a')
      .entrant('b')
      .entrant('c')
      .contest('m1', { entrants: ['a'] })
      .contest('m2', { entrants: ['b'] })
      .contest('m3', { entrants: ['a', 'c'], round: 'r2', roundSeq: 2 });

  it('before the window start or ending after it: OUTSIDE_EVENT_WINDOW; on the bounds: fine', () => {
    expect(codes(run(windowed().assign('m1', { resource: 'c1', start: -1, end: 60 })))).toEqual([
      'OUTSIDE_EVENT_WINDOW',
    ]);
    expect(codes(run(windowed().assign('m1', { resource: 'c1', start: 200, end: 241 })))).toEqual([
      'OUTSIDE_EVENT_WINDOW',
    ]);
    expect(codes(run(windowed().assign('m1', { resource: 'c1', start: 0, end: 240 })))).toEqual([]);
  });

  it('missing end: INCOMPLETE (expectedEnd); occupancy and participant checks skip it', () => {
    const r = run(
      windowed()
        .assign('m1', { resource: 'c1', start: 0, end: null })
        .assign('m2', { resource: 'c1', start: 30 })
        .assign('m3', { resource: 'c2', start: 10 }),
    );
    expect(codes(r)).toEqual(['INCOMPLETE_ASSIGNMENT']);
    expect(r.conflicts[0]).toMatchObject({
      actual: 'expectedEnd',
      interval: { start: T0 / 1000, end: T0 / 1000 },
    });
  });

  it('missing end: the window start still applies; an end-less start after the window end fails', () => {
    expect(codes(run(windowed().assign('m1', { resource: 'c1', start: -5, end: null })))).toEqual([
      'OUTSIDE_EVENT_WINDOW',
      'INCOMPLETE_ASSIGNMENT',
    ]);
    expect(
      codes(run(windowed().assign('m1', { resource: 'c1', start: 300, end: null }))),
    ).toContain('OUTSIDE_EVENT_WINDOW');
  });

  it('missing resource where the profile names a type: INCOMPLETE (resource)', () => {
    expect(
      ofCode(run(windowed().assign('m1', { start: 0 })), 'INCOMPLETE_ASSIGNMENT')[0]?.actual,
    ).toBe('resource');
  });

  it('RESOURCE_TYPE_MISMATCH against the governing requirement', () => {
    const w = windowed()
      .resource('pool', { type: 'POOL' })
      .assign('m1', { resource: 'pool', start: 0 });
    expect(ofCode(run(w), 'RESOURCE_TYPE_MISMATCH')[0]).toMatchObject({
      expected: 'TENNIS_COURT',
      actual: 'POOL',
    });
  });
});

describe('participants (D10): persons, teams, possible occupants, same-round rule', () => {
  it('one athlete in two events at once: PARTICIPANT_OVERLAP for that person', () => {
    const w = new World()
      .event('e1', { profile: TENNIS })
      .event('e2', { profile: TENNIS })
      .resource('c1')
      .resource('c2')
      .entrant('s1', { persons: ['ana'] })
      .entrant('s2', { persons: ['bea'] })
      .entrant('d1', { kind: 'TEAM', persons: ['ana', 'cris'] })
      .entrant('d2', { kind: 'TEAM', persons: ['dan', 'eva'] })
      .contest('singles', { entrants: ['s1', 's2'] })
      .contest('doubles', { event: 'e2', entrants: ['d1', 'd2'] })
      .assign('singles', { resource: 'c1', start: 0 })
      .assign('doubles', { resource: 'c2', start: 30 });
    const c = ofCode(run(w), 'PARTICIPANT_OVERLAP');
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ personIds: ['ana'], certainty: 'CERTAIN' });
    expect(c[0]?.entrantIds).toBeUndefined();
  });

  it('a team in two overlapping games is one TEAM_OVERLAP, not one per member', () => {
    const w = new World()
      .event('e1', { profile: spec({ resourceType: 'BASKETBALL_COURT' }) })
      .resource('c1', { type: 'BASKETBALL_COURT' })
      .resource('c2', { type: 'BASKETBALL_COURT' })
      .entrant('A', { kind: 'TEAM', persons: ['a1', 'a2', 'a3'] })
      .entrant('B', { kind: 'TEAM', persons: ['b1'] })
      .entrant('C', { kind: 'TEAM', persons: ['c1'] })
      .contest('g1', { entrants: ['A', 'B'] })
      .contest('g2', { round: 'r2', roundSeq: 2, entrants: ['A', 'C'] })
      .assign('g1', { resource: 'c1', start: 0 })
      .assign('g2', { resource: 'c2', start: 30 });
    const r = run(w);
    expect(ofCode(r, 'TEAM_OVERLAP')).toHaveLength(1);
    expect(ofCode(r, 'TEAM_OVERLAP')[0]).toMatchObject({ entrantIds: ['A'] });
    expect(ofCode(r, 'PARTICIPANT_OVERLAP')).toEqual([]);
  });

  it('a team without a frozen roster keeps entrant-level checks only', () => {
    const w = new World()
      .event('e1', { profile: spec({ resourceType: 'BASKETBALL_COURT' }) })
      .resource('c1', { type: 'BASKETBALL_COURT' })
      .resource('c2', { type: 'BASKETBALL_COURT' })
      .entrant('A', { kind: 'TEAM', persons: [] })
      .entrant('B', { kind: 'TEAM', persons: [] })
      .entrant('C', { kind: 'TEAM', persons: [] })
      .contest('g1', { entrants: ['A', 'B'] })
      .contest('g2', { round: 'r2', roundSeq: 2, entrants: ['A', 'C'] })
      .assign('g1', { resource: 'c1', start: 0 })
      .assign('g2', { resource: 'c2', start: 30 });
    // Entrant-level checks only: the team overlap and its round order; no person-level code.
    expect(codes(run(w))).toEqual(['TEAM_OVERLAP', 'ROUND_SEQUENCE']);
  });

  it('two persons overlapping between the same two teams get two distinct conflict keys (D13)', () => {
    const w = new World()
      .event('e1', { profile: TENNIS })
      .event('e2', { profile: TENNIS })
      .resource('c1')
      .resource('c2')
      .entrant('T1', { kind: 'TEAM', persons: ['p', 'q'] })
      .entrant('T2', { kind: 'TEAM', persons: ['p', 'q'] })
      .entrant('o1')
      .entrant('o2')
      .contest('m1', { entrants: ['T1', 'o1'] })
      .contest('m2', { event: 'e2', entrants: ['T2', 'o2'] })
      .assign('m1', { resource: 'c1', start: 0 })
      .assign('m2', { resource: 'c2', start: 0 });
    const c = ofCode(run(w), 'PARTICIPANT_OVERLAP');
    expect(c.map((x) => x.personIds)).toEqual([['p'], ['q']]);
    expect(new Set(c.map(conflictKey)).size).toBe(2);
  });

  function bracket() {
    // Two semifinals feed a final whose places are unresolved (possible occupants = closure).
    const w = new World()
      .event('e1', { profile: TENNIS })
      .resource('c1')
      .resource('c2')
      .resource('c3');
    for (const e of ['a', 'b', 'c', 'd', 'z1', 'z2']) w.entrant(e);
    w.contest('sf1', { entrants: ['a', 'b'] }).contest('sf2', { entrants: ['c', 'd'] });
    w.contest('f', { round: 'r2', roundSeq: 2 })
      .place('f', 1, { feeders: ['sf1'] })
      .place('f', 2, { feeders: ['sf2'] });
    return w;
  }

  it('a provisional final overlapping a possible occupant elsewhere: POSSIBLE, still HARD', () => {
    const w = bracket()
      .event('e2', { profile: TENNIS })
      .contest('other', { event: 'e2', entrants: ['a', 'z1'] })
      .assign('sf1', { resource: 'c1', start: 0 })
      .assign('sf2', { resource: 'c2', start: 0 })
      .assign('f', { resource: 'c1', start: 300 })
      .assign('other', { resource: 'c3', start: 320 });
    const c = ofCode(run(w), 'PARTICIPANT_OVERLAP');
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ personIds: ['p-a'], certainty: 'POSSIBLE', severity: 'HARD' });
    expect(reportVerdict(run(w)).hard).toBe(1);
  });

  it('same round: possible occupants are never compared; two certain occupants are', () => {
    const w = new World()
      .event('e1', { profile: TENNIS })
      .resource('c1')
      .resource('c2')
      .resource('c3');
    for (const e of ['a', 'b', 'c', 'd']) w.entrant(e);
    w.contest('q1', { entrants: ['a', 'b', 'c', 'd'] });
    w.contest('k1', { round: 'r2', roundSeq: 2 }).place('k1', 1, { feeders: ['q1'] });
    w.contest('k2', { round: 'r2', roundSeq: 2 }).place('k2', 1, { feeders: ['q1'] });
    w.assign('q1', { resource: 'c1', start: 0 })
      .assign('k1', { resource: 'c2', start: 300 })
      .assign('k2', { resource: 'c3', start: 300 });
    expect(codes(run(w))).toEqual([]);
    const certain = new World().event('e1', { profile: TENNIS }).resource('c1').resource('c2');
    certain
      .entrant('a')
      .entrant('b')
      .contest('k1', { entrants: ['a'] })
      .contest('k2', { entrants: ['a', 'b'] })
      .assign('k1', { resource: 'c1', start: 0 })
      .assign('k2', { resource: 'c2', start: 0 });
    expect(codes(run(certain))).toEqual(['PARTICIPANT_OVERLAP']);
  });

  describe('rest (later unit requirement, latest predecessor in another round)', () => {
    const rested = (gapMinutes: number, enforcement: 'HARD' | 'SOFT' = 'SOFT') =>
      new World()
        .event('e1', { profile: spec({ rest: { minimumSeconds: 3_600, enforcement } }) })
        .resource('c1')
        .resource('c2')
        .entrant('a')
        .entrant('b')
        .entrant('c')
        .contest('r1m', { entrants: ['a', 'b'] })
        .contest('r2m', { round: 'r2', roundSeq: 2, entrants: ['a', 'c'] })
        .assign('r1m', { resource: 'c1', start: 0, end: 60 })
        .assign('r2m', { resource: 'c2', start: 60 + gapMinutes });

    it('a 50-minute gap against 60 required: SHORT_REST (SOFT), 3600 / 3000', () => {
      const c = ofCode(run(rested(50)), 'SHORT_REST');
      expect(c).toHaveLength(1);
      expect(c[0]).toMatchObject({
        severity: 'SOFT',
        expected: 3_600,
        actual: 3_000,
        personIds: ['p-a'],
      });
    });

    it('HARD when the requirement says HARD; exactly 60 minutes is enough', () => {
      expect(ofCode(run(rested(50, 'HARD')), 'SHORT_REST')[0]?.severity).toBe('HARD');
      expect(codes(run(rested(60)))).toEqual([]);
    });

    it('only the latest-ending predecessor is compared (consecutive units)', () => {
      const w = rested(30)
        .contest('r0m', { round: 'r0', roundSeq: 0, entrants: ['a'] })
        .assign('r0m', { resource: 'c2', start: -200, end: -150 });
      const c = ofCode(run(w), 'SHORT_REST');
      expect(c).toHaveLength(1);
      expect(c[0]?.assignmentIds).toEqual(['a-r1m', 'a-r2m']);
    });

    it('changeover never enters rest', () => {
      const w = rested(60);
      w.assignments[0] = { ...must(w.assignments[0]), changeoverSeconds: 3_000 };
      expect(codes(run(w))).not.toContain('SHORT_REST');
    });
  });

  describe('daily limit: units per entrant, requirement and local date of the unit start', () => {
    const daily = (
      starts: readonly number[],
      o: { tz?: string; value?: number; enforcement?: 'HARD' | 'SOFT' } = {},
    ) => {
      const w = new World()
        .event('e1', {
          timezone: o.tz ?? 'America/Costa_Rica',
          profile: spec({
            maxUnitsPerEntrantPerDay: { value: o.value ?? 1, enforcement: o.enforcement ?? 'HARD' },
          }),
        })
        .entrant('a');
      starts.forEach((s, i) => {
        w.resource(`c${i}`)
          .entrant(`o${i}`)
          .contest(`m${i}`, { round: `r${i}`, roundSeq: i + 1, entrants: ['a', `o${i}`] })
          .assign(`m${i}`, { resource: `c${i}`, startMs: s, endMs: s + HOUR });
      });
      return run(w);
    };
    // 2026-11-14 in Costa Rica (UTC−6): 06:00Z is 00:00 local.
    const local = (h: number) => Date.UTC(2026, 10, 14, h + 6);

    it('two units on one local date with a HARD limit of 1: CERTAIN conflict', () => {
      const c = ofCode(daily([local(9), local(15)]), 'MAX_CONTESTS_PER_DAY');
      expect(c).toHaveLength(1);
      expect(c[0]).toMatchObject({
        severity: 'HARD',
        certainty: 'CERTAIN',
        expected: 1,
        actual: 2,
        entrantIds: ['a'],
      });
    });

    it('the local date, not UTC: 23:30 and 00:30 local are different days', () => {
      expect(codes(daily([local(17), local(23) + 30 * MIN + 2 * HOUR]))).not.toContain(
        'MAX_CONTESTS_PER_DAY',
      );
      // Same pair, but in UTC they straddle the UTC midnight while being one Costa Rica day.
      expect(codes(daily([local(17), local(19)]))).toContain('MAX_CONTESTS_PER_DAY');
    });

    it('a unit crossing midnight counts on its start date only', () => {
      expect(codes(daily([local(23), local(24) + 2 * HOUR]))).not.toContain('MAX_CONTESTS_PER_DAY');
    });

    it('SOFT limit, and a limit of 2 is not exceeded by two units', () => {
      expect(
        ofCode(daily([local(9), local(15)], { enforcement: 'SOFT' }), 'MAX_CONTESTS_PER_DAY')[0]
          ?.severity,
      ).toBe('SOFT');
      expect(codes(daily([local(9), local(15)], { value: 2 }))).toEqual([]);
    });

    it('possible occupants of one round count once; POSSIBLE when certain units alone fit', () => {
      const w = new World()
        .event('e1', {
          profile: spec({ maxUnitsPerEntrantPerDay: { value: 1, enforcement: 'HARD' } }),
        })
        .resource('c0');
      for (const e of ['a', 'b', 'c', 'd']) w.entrant(e);
      w.contest('q', { entrants: ['a', 'b', 'c', 'd'] }).assign('q', { resource: 'c0', start: 0 });
      for (const k of [1, 2, 3]) {
        w.resource(`c${k}`)
          .contest(`k${k}`, { round: 'r2', roundSeq: 2 })
          .place(`k${k}`, 1, { feeders: ['q'] })
          .assign(`k${k}`, { resource: `c${k}`, start: 120 });
      }
      const c = ofCode(run(w), 'MAX_CONTESTS_PER_DAY');
      expect(c).toHaveLength(4);
      for (const x of c)
        expect(x).toMatchObject({ actual: 2, certainty: 'POSSIBLE', severity: 'HARD' });
    });
  });
});

describe('dependencies and round sequence (D11)', () => {
  function chain(lead = 900) {
    const w = new World()
      .event('e1', { profile: spec({ dependencyLeadSeconds: lead, changeoverSeconds: 600 }) })
      .resource('c1')
      .resource('c2');
    for (const e of ['a', 'b', 'c', 'd']) w.entrant(e);
    w.contest('sf1', { entrants: ['a', 'b'] }).contest('sf2', { entrants: ['c', 'd'] });
    w.contest('f', { round: 'r2', roundSeq: 2 })
      .place('f', 1, { feeders: ['sf1'] })
      .place('f', 2, { feeders: ['sf2'] });
    return w;
  }

  it('the final before the semis end + lead: DEPENDENCY_ORDER (earliest vs actual)', () => {
    const w = chain()
      .assign('sf1', { resource: 'c1', start: 0, end: 60, changeover: 600 })
      .assign('sf2', { resource: 'c2', start: 0, end: 100 })
      .assign('f', { resource: 'c1', start: 110 });
    const c = ofCode(run(w), 'DEPENDENCY_ORDER');
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ expected: at(115) / 1000, actual: at(110) / 1000 });
    expect(c[0]?.assignmentIds).toEqual(['a-f', 'a-sf2']);
  });

  it('exactly at feeder end + lead is fine; changeover is never added', () => {
    const w = chain()
      .assign('sf1', { resource: 'c1', start: 0, end: 60, changeover: 600 })
      .assign('sf2', { resource: 'c2', start: 0, end: 100 })
      .assign('f', { resource: 'c2', start: 115 });
    expect(codes(run(w))).not.toContain('DEPENDENCY_ORDER');
  });

  it('an unscheduled feeder: INCOMPLETE (feeder) on the dependent, never satisfied, never a violation', () => {
    const w = chain()
      .assign('sf1', { resource: 'c1', start: 0 })
      .assign('f', { resource: 'c2', start: 200 });
    const inc = ofCode(run(w), 'INCOMPLETE_ASSIGNMENT');
    expect(inc).toHaveLength(1);
    expect(inc[0]).toMatchObject({ actual: 'feeder', contestIds: ['f', 'sf2'] });
    expect(codes(run(w))).not.toContain('DEPENDENCY_ORDER');
  });

  it('a COMPLETED, CANCELLED or VOID feeder imposes nothing', () => {
    for (const status of ['COMPLETED', 'CANCELLED', 'VOID'] as const) {
      const w = chain()
        .assign('sf1', { resource: 'c1', start: 0 })
        .assign('sf2', { resource: 'c2', start: 0, end: 500 })
        .assign('f', { resource: 'c1', start: 100 });
      w.contests[1] = { ...must(w.contests[1]), status };
      expect(codes(run(w)), status).not.toContain('DEPENDENCY_ORDER');
    }
  });

  it('a feeder without an end is skipped (it carries its own INCOMPLETE)', () => {
    const w = chain()
      .assign('sf1', { resource: 'c1', start: 0, end: 60 })
      .assign('sf2', { resource: 'c2', start: 0, end: null })
      .assign('f', { resource: 'c1', start: 80 });
    const r = run(w);
    expect(codes(r)).not.toContain('DEPENDENCY_ORDER');
    expect(ofCode(r, 'INCOMPLETE_ASSIGNMENT').map((c) => c.assignmentIds)).toEqual([['a-sf2']]);
  });

  it('ROUND_SEQUENCE: round 2 before the entrant finishes round 1 (SOFT); in order: nothing', () => {
    const multi = (r2Start: number) =>
      new World()
        .event('e1', { profile: spec({ resourceType: 'GOLF_COURSE', capacityUnit: 'ENTRANT' }) })
        .resource('course', { type: 'GOLF_COURSE', mode: 'SHARED', capacity: 100 })
        .entrant('g')
        .contest('r1g', { type: 'SERIES', primitive: 'FIELD', entrants: ['g'] })
        .contest('r2g', {
          type: 'SERIES',
          primitive: 'FIELD',
          round: 'r2',
          roundSeq: 2,
          entrants: ['g'],
        })
        .assign('r1g', { resource: 'course', start: 0, end: 240 })
        .assign('r2g', { resource: 'course', start: r2Start, end: r2Start + 240 });
    const bad = run(multi(-500));
    expect(ofCode(bad, 'ROUND_SEQUENCE')[0]).toMatchObject({ severity: 'SOFT', entrantIds: ['g'] });
    expect(codes(run(multi(24 * 60)))).toEqual([]);
  });
});

describe('statuses (D4), staleness and locks (D12)', () => {
  const two = (s1: ContestStatus, s2: ContestStatus) => {
    const w = courts()
      .contest('m1', { entrants: ['x1', 'x2'], status: s1 })
      .contest('m2', { entrants: ['x3', 'x4'], status: s2 })
      .assign('m1', { resource: 'c1', start: 0 })
      .assign('m2', { resource: 'c1', start: 30 });
    for (const a of w.assignments) w.base.push({ ...a, id: `base-${a.contestId}` });
    return run(w);
  };

  it('CANCELLED and VOID contests are excluded entirely', () => {
    expect(codes(two('SCHEDULED', 'CANCELLED'))).toEqual([]);
    expect(codes(two('VOID', 'SCHEDULED'))).toEqual([]);
  });

  it('settled-only conflicts are history and are not reported; one unsettled contest reports', () => {
    expect(codes(two('COMPLETED', 'COMPLETED'))).toEqual([]);
    expect(codes(two('IN_PROGRESS', 'COMPLETED'))).toEqual([]);
    expect(codes(two('COMPLETED', 'SCHEDULED'))).toEqual(['RESOURCE_OVERLAP']);
  });

  it('a started contest moved in the draft: LOCKED_ASSIGNMENT_VIOLATION; unchanged: nothing', () => {
    const w = courts()
      .contest('m1', { entrants: ['x1', 'x2'], status: 'IN_PROGRESS' })
      .assign('m1', { resource: 'c1', start: 60 })
      .assign('m1', { resource: 'c1', start: 0, base: true });
    expect(codes(run(w))).toEqual(['LOCKED_ASSIGNMENT_VIOLATION']);
    const same = courts()
      .contest('m1', { entrants: ['x1', 'x2'], status: 'COMPLETED' })
      .assign('m1', { resource: 'c1', start: 0 })
      .assign('m1', { resource: 'c1', start: 0, base: true });
    expect(codes(run(same))).toEqual([]);
  });

  it('a STALE place: STALE_OCCUPANT (HARD); its occupants become possible, not certain', () => {
    const w = courts().contest('sf', { entrants: ['x1', 'x2'] });
    w.contest('f', { round: 'r2', roundSeq: 2 })
      .place('f', 1, { state: 'STALE', occupant: 'x1', feeders: ['sf'] })
      .place('f', 2, { state: 'RESOLVED', occupant: 'x3', feeders: ['sf'] })
      .event('e2', { profile: TENNIS })
      .contest('o', { event: 'e2', entrants: ['x2', 'x5'] })
      .assign('sf', { resource: 'c1', start: -300, end: -240 })
      .assign('f', { resource: 'c1', start: 0 })
      .assign('o', { resource: 'c2', start: 10 });
    const r = run(w);
    expect(ofCode(r, 'STALE_OCCUPANT')).toHaveLength(1);
    expect(ofCode(r, 'PARTICIPANT_OVERLAP')[0]).toMatchObject({
      personIds: ['p-x2'],
      certainty: 'POSSIBLE',
    });
  });
});

describe('legacy sub-second instants (D3)', () => {
  it('verdicts use exact milliseconds; the report floors to seconds', () => {
    const w = courts(spec({ changeoverSeconds: 0 }))
      .contest('m1', { entrants: ['x1', 'x2'] })
      .contest('m2', { entrants: ['x3', 'x4'] })
      .assign('m1', { resource: 'c1', startMs: T0 + 250, endMs: T0 + HOUR + 500 })
      .assign('m2', { resource: 'c1', startMs: T0 + HOUR + 400, endMs: T0 + 2 * HOUR });
    const c = ofCode(run(w), 'RESOURCE_OVERLAP');
    expect(c).toHaveLength(1);
    expect(c[0]?.interval).toEqual({ start: T0 / 1000, end: (T0 + HOUR) / 1000 });
    w.assignments[1] = { ...must(w.assignments[1]), startMs: T0 + HOUR + 500 };
    expect(codes(run(w))).toEqual([]);
  });
});

describe('malformed input is an error, never a conflict (D16)', () => {
  const ok = () =>
    courts()
      .contest('m1', { entrants: ['x1', 'x2'] })
      .assign('m1', { resource: 'c1' });
  // Deliberately malformed shapes: the cast is the point of these cases.
  const bad = (edit: (i: ScheduleEvaluationInput) => unknown) => () =>
    evaluateSchedule(edit(ok().input()) as ScheduleEvaluationInput);

  it.each([
    [
      'an unknown contest',
      (i: ScheduleEvaluationInput) => ({
        ...i,
        assignments: [{ ...must(i.assignments[0]), contestId: 'nope' }],
      }),
    ],
    [
      'an unknown resource',
      (i: ScheduleEvaluationInput) => ({
        ...i,
        assignments: [{ ...must(i.assignments[0]), resourceId: 'nope' }],
      }),
    ],
    [
      'two current facts for one contest',
      (i: ScheduleEvaluationInput) => ({
        ...i,
        assignments: [...i.assignments, { ...must(i.assignments[0]), id: 'other' }],
      }),
    ],
    [
      'an end before the start',
      (i: ScheduleEvaluationInput) => ({
        ...i,
        assignments: [{ ...must(i.assignments[0]), expectedEndMs: T0 - 1 }],
      }),
    ],
    [
      'a resource without a valid mode',
      (i: ScheduleEvaluationInput) => ({
        ...i,
        resources: [{ ...must(i.resources[0]), occupancyMode: 'MAYBE' }, ...i.resources.slice(1)],
      }),
    ],
    [
      'an ambiguous requirement',
      (i: ScheduleEvaluationInput) => ({
        ...i,
        events: [
          {
            ...must(i.events[0]),
            profile: {
              versionId: 'v',
              specHash: 'h',
              spec: spec(
                { selector: { contestType: 'MATCH' } },
                { selector: { roundType: 'KNOCKOUT' } },
              ),
            },
          },
        ],
      }),
    ],
    [
      'an unknown feeder',
      (i: ScheduleEvaluationInput) => ({
        ...i,
        contests: [{ ...must(i.contests[0]), feeders: ['ghost'] }],
      }),
    ],
    [
      'a cycle in the plan graph',
      (i: ScheduleEvaluationInput) => ({
        ...i,
        contests: [{ ...must(i.contests[0]), feeders: ['m1'] }],
      }),
    ],
    [
      'an entrant without persons',
      (i: ScheduleEvaluationInput) => ({
        ...i,
        entrants: [{ id: 'x1', kind: 'INDIVIDUAL', personIds: [] }, ...i.entrants.slice(1)],
      }),
    ],
    [
      'a place naming an unknown entrant',
      (i: ScheduleEvaluationInput) => ({
        ...i,
        places: [{ ...must(i.places[0]), occupantId: 'ghost' }],
      }),
    ],
  ])('%s → ScheduleEvaluationError, no report', (_name, edit) => {
    expect(bad(edit)).toThrow(ScheduleEvaluationError);
  });
});

describe('determinism, ordering and hashing (D13, § 16–18)', () => {
  function rich() {
    const w = courts(
      spec({ changeoverSeconds: 600, rest: { minimumSeconds: 7_200, enforcement: 'SOFT' } }),
    )
      .event('e2', { profile: TENNIS })
      .resource('road', { type: 'ROAD_COURSE', mode: 'SHARED', capacity: 2 })
      .contest('m1', { entrants: ['x1', 'x2'] })
      .contest('m2', { entrants: ['x3', 'x4'] })
      .contest('m3', { round: 'r2', roundSeq: 2, entrants: ['x1', 'x3'] })
      .contest('m4', { event: 'e2', entrants: ['x5', 'x6'] })
      .contest('m5', { event: 'e2', entrants: ['x1', 'x7'] })
      .assign('m1', { resource: 'c1', start: 0 })
      .assign('m2', { resource: 'c1', start: 30 })
      .assign('m3', { resource: 'c2', start: 90 })
      .assign('m4', { resource: 'road', start: 0, end: null })
      .assign('m5', { resource: 'c2', start: 10 });
    return w;
  }

  it('the same input twice yields a byte-identical report and hash', () => {
    const a = run(rich());
    const b = run(rich());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(scheduleReportHash(a)).toBe(scheduleReportHash(b));
    expect(a.conflicts.length).toBeGreaterThan(5);
  });

  it('conflicts are totally ordered by the frozen keys, HARD first', () => {
    const r = run(rich());
    expect([...r.conflicts].sort(compareConflicts)).toEqual(r.conflicts);
    const sev = r.conflicts.map((c) => c.severity);
    expect(sev.indexOf('SOFT')).toBeGreaterThan(sev.lastIndexOf('HARD'));
  });

  it('every conflict key is unique within a report', () => {
    const r = run(rich());
    expect(new Set(r.conflicts.map(conflictKey)).size).toBe(r.conflicts.length);
  });

  it('shuffling every input array changes nothing (property)', () => {
    const input = rich().input();
    const reference = scheduleReportHash(evaluateSchedule(input));
    const shuffle = <T>(xs: readonly T[], seed: number): T[] =>
      xs
        .map((x, i) => ({ x, k: ((i + 1) * 2_654_435_761 * (seed + 7)) % 4_294_967_291 }))
        .sort((a, b) => a.k - b.k)
        .map((e) => e.x);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), (seed) => {
        const shuffled: ScheduleEvaluationInput = {
          ...input,
          watermark: shuffle(input.watermark, seed),
          assignments: shuffle(input.assignments, seed + 1),
          contests: shuffle(input.contests, seed + 2),
          places: shuffle(input.places, seed + 3),
          entrants: shuffle(input.entrants, seed + 4).map((e) => ({
            ...e,
            personIds: shuffle(e.personIds, seed),
          })),
          events: shuffle(input.events, seed + 5),
          resources: shuffle(input.resources, seed + 6),
          availability: shuffle(input.availability, seed + 7),
        };
        expect(scheduleReportHash(evaluateSchedule(shuffled))).toBe(reference);
      }),
      { numRuns: 60 },
    );
  });

  afterEach(() => vi.useRealTimers());

  it('the wall clock never reaches the hash', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
    const a = scheduleReportHash(run(rich()));
    vi.setSystemTime(new Date('2031-07-15T13:14:15Z'));
    const b = scheduleReportHash(run(rich()));
    expect(a).toBe(b);
  });

  it('every evaluated input changes the hash', () => {
    const reference = scheduleReportHash(run(rich()));
    const edits: [string, (w: World) => void][] = [
      ['start', (w) => void (w.assignments[0] = { ...must(w.assignments[0]), startMs: at(1) })],
      [
        'end',
        (w) => void (w.assignments[0] = { ...must(w.assignments[0]), expectedEndMs: at(61) }),
      ],
      [
        'changeover',
        (w) => void (w.assignments[0] = { ...must(w.assignments[0]), changeoverSeconds: 1 }),
      ],
      [
        'resource revision',
        (w) => void (w.resources[0] = { ...must(w.resources[0]), revisionId: 'rev-x' }),
      ],
      [
        'availability fact',
        (w) => void w.fact('new', null, { kind: 'DATE_CLOSED', date: '2030-01-01' }),
      ],
      [
        'profile',
        (w) =>
          void (w.events[0] = {
            ...must(w.events[0]),
            profile: { ...must(w.events[0]?.profile ?? undefined), versionId: 'pv-2' },
          }),
      ],
      [
        'event zone',
        (w) => void (w.events[0] = { ...must(w.events[0]), timezone: 'America/Costa_Rica' }),
      ],
      ['competition zone', (w) => void (w.competitionTimezone = 'America/Costa_Rica')],
      [
        'contest status',
        (w) => void (w.contests[0] = { ...must(w.contests[0]), status: 'PLANNED' }),
      ],
      [
        'place state (STALE)',
        (w) => void w.places.splice(0, 1, { ...must(w.places[0]), state: 'STALE' }),
      ],
      ['place fact id', (w) => void w.places.splice(0, 1, { ...must(w.places[0]), factId: 'f2' })],
      [
        'watermark',
        (w) =>
          void w.assignments.push({
            ...must(w.assignments[0]),
            id: 'removed-fact',
            contestId: 'm-none',
          }),
      ],
    ];
    for (const [name, edit] of edits) {
      const w = rich();
      if (name === 'watermark') {
        const input = w.input();
        expect(
          scheduleReportHash(
            evaluateSchedule({ ...input, watermark: [...input.watermark, 'removed'] }),
          ),
        ).not.toBe(reference);
        continue;
      }
      edit(w);
      expect(scheduleReportHash(run(w)), name).not.toBe(reference);
    }
  });
});

describe('no sport identity in the engine', () => {
  it('engine.ts and availability.ts never name a sport or branch on one', () => {
    for (const f of ['./engine.ts', '../resources/availability.ts']) {
      const src = readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
      expect(src).not.toMatch(
        /tennis|padel|golf|swim|bowling|basketball|wheelchair|cycling|marathon|running|sport\s*===|discipline\s*===|typeCode\s*===|occupancyMode\s*=\s*.*startSpacing/i,
      );
    }
  });
});
