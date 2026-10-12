import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateSchedule, type EvaluationAssignment } from './engine';
import { at, HOUR, MIN, must, spec, T0, World } from './engine.fixture';
import type { SchedulingProfileSpec } from './profile';
import {
  CONFLICT_SEARCH_CLASS,
  PROPOSAL_BUDGET,
  PROPOSAL_STRATEGY,
  proposalHash,
  proposeSchedule,
  proposeScheduleWithBudget,
  ScheduleProposalError,
  type ScheduleProposal,
  type ScheduleProposalInput,
} from './proposal';
import { CONFLICT_CODES } from './report';

/**
 * ONCF-05E-E proposal engine (ADR-0075). Every accepted placement is judged by the real 05E-D
 * engine; nothing here mocks `evaluateSchedule`.
 */

const DAY = 24 * HOUR;
const S = (ms: number) => Math.floor(ms / 1000);

/** A world with event e1 (profile, window [T0, T0 + 3 days)) whose contests default to PLANNED. */
function world(
  profile: SchedulingProfileSpec | null = spec({}),
  o: { windowStartMs?: number | null; windowEndMs?: number | null; open?: boolean } = {},
) {
  return new World(o.open ?? true).event('e1', {
    profile,
    windowStartMs: o.windowStartMs === undefined ? T0 : o.windowStartMs,
    windowEndMs: o.windowEndMs === undefined ? T0 + 3 * DAY : o.windowEndMs,
  });
}

type Contest = Parameters<World['contest']>[1];
const planned = (w: World, id: string, o: Contest = {}) =>
  w.contest(id, { status: 'PLANNED', ...o });

function input(
  w: World,
  o: Partial<Omit<ScheduleProposalInput, 'judge'>> & { offsets?: Record<string, number> } = {},
): ScheduleProposalInput {
  const { offsets, ...rest } = o;
  return {
    judge: w.input(),
    draftStatus: 'DRAFT',
    competitionStatus: 'IN_PROGRESS',
    basePublishedVersionId: 'version-1',
    eventStatuses: w.events.map((e) => ({ eventId: e.id, status: 'FIELD_LOCKED' })),
    latestOffsets: w.contests.map((c) => ({ contestId: c.id, seconds: offsets?.[c.id] ?? 0 })),
    ...rest,
  };
}

const placement = (p: ScheduleProposal, contestId: string) =>
  must(p.placements.find((x) => x.contestId === contestId));
const unplaced = (p: ScheduleProposal, unitKey: string) =>
  must(p.unplaced.find((x) => x.unitKey === unitKey));

/** The judge's verdict on base ⊕ the proposal's placements: no HARD conflict involves them. */
function judgedClean(w: World, p: ScheduleProposal) {
  const extra: EvaluationAssignment[] = p.placements.map((x) => ({
    id: `proposal:${x.contestId}`,
    contestId: x.contestId,
    resourceId: x.resourceId,
    startMs: x.start * 1000,
    expectedEndMs: x.expectedEnd * 1000,
    changeoverSeconds: x.changeoverSeconds,
    recordedUnitKey: x.unitKey,
  }));
  const judge = w.input();
  const report = evaluateSchedule({
    ...judge,
    watermark: [...judge.watermark, ...extra.map((a) => a.id)],
    assignments: [...judge.assignments, ...extra],
  });
  const ids = new Set(extra.map((a) => a.id));
  return report.conflicts.filter(
    (c) =>
      (c.severity === 'HARD' || c.code === 'AVAILABILITY_UNDECLARED') &&
      c.assignmentIds.some((id) => ids.has(id)),
  );
}

// ───────────────────────────── A. basic placement ─────────────────────────────

describe('A. basic placement', () => {
  it('1. one contest on one resource: placed at the horizon start with 05E-C defaults', () => {
    const w = world(spec({ changeoverSeconds: 600 }))
      .resource('c1')
      .entrant('x')
      .entrant('y');
    planned(w, 'm1', { entrants: ['x', 'y'] });
    const p = proposeSchedule(input(w));
    expect(p.status).toBe('SUCCESS');
    expect(p.placements).toEqual([
      {
        contestId: 'm1',
        unitKey: 'contest:m1',
        resourceId: 'c1',
        start: S(T0),
        expectedEnd: S(T0 + HOUR),
        changeoverSeconds: 600,
        zone: 'UTC',
        provisional: false,
        softConflictKeys: [],
      },
    ]);
    expect(p.strategy).toEqual(PROPOSAL_STRATEGY);
    expect(p.budget).toEqual(PROPOSAL_BUDGET);
    expect(p.report.hardConflicts).toBe(0);
    expect(judgedClean(w, p)).toEqual([]);
  });

  it('2. two resources: two simultaneous contests use both at the same instant (time-major)', () => {
    const w = world().resource('c1').resource('c2');
    for (const e of ['a', 'b', 'c', 'd']) w.entrant(e);
    planned(w, 'm1', { entrants: ['a', 'b'] });
    planned(w, 'm2', { entrants: ['c', 'd'] });
    const p = proposeSchedule(input(w));
    expect([placement(p, 'm1').resourceId, placement(p, 'm2').resourceId]).toEqual(['c1', 'c2']);
    expect(placement(p, 'm2').start).toBe(S(T0));
  });

  it('3. earliest feasible: after the preserved claim and its changeover on the only court', () => {
    const w = world(spec({ changeoverSeconds: 600 })).resource('c1');
    for (const e of ['a', 'b', 'c', 'd']) w.entrant(e);
    w.contest('m0', { entrants: ['a', 'b'] }).assign('m0', {
      resource: 'c1',
      start: 0,
      end: 60,
      changeover: 600,
    });
    planned(w, 'm1', { entrants: ['c', 'd'] });
    const p = proposeSchedule(input(w));
    expect(placement(p, 'm1').start).toBe(S(at(70)));
    expect(judgedClean(w, p)).toEqual([]);
  });

  it('4. resource id is a deterministic tie-break, whatever the declaration order', () => {
    const w = world().resource('court-b').resource('court-a').entrant('x').entrant('y');
    planned(w, 'm1', { entrants: ['x', 'y'] });
    expect(placement(proposeSchedule(input(w)), 'm1').resourceId).toBe('court-a');
  });
});

// ───────────────────────────── B. existing content ─────────────────────────────

describe('B. existing content is fixed in v1 (additive only)', () => {
  const twoMatches = () => {
    const w = world().resource('c1');
    for (const e of ['a', 'b', 'c', 'd']) w.entrant(e);
    return w;
  };

  it('5–8. locked / MANUAL / CARRIED / MIGRATED-shaped live assignments are never moved', () => {
    const w = twoMatches();
    // A whole-second resourced claim (locked, MANUAL or CARRIED alike: the judge sees one shape)…
    w.contest('m0', { entrants: ['a', 'b'] }).assign('m0', { resource: 'c1', start: 0, end: 60 });
    // …and a MIGRATED-derived one: no resource, no end, a sub-second legacy start.
    w.contest('legacy', { event: 'e1', entrants: ['a', 'b'], round: 'r0', roundSeq: 1 });
    w.assign('legacy', { startMs: T0 + 5 * DAY + 123, endMs: null });
    planned(w, 'm1', { entrants: ['c', 'd'] });
    const before = JSON.stringify(w.input().assignments);
    const p = proposeSchedule(input(w));
    expect(p.placements.map((x) => x.contestId)).toEqual(['m1']);
    expect(JSON.stringify(w.input().assignments)).toBe(before);
    expect(placement(p, 'm1').start).toBe(S(at(60)));
  });

  it('9. a grouped unit with a placed member is PARTIALLY_PLACED (v1 does not complete it)', () => {
    const w = world(spec({ resourceType: 'GOLF_COURSE', capacityUnit: 'ENTRANT' })).resource('g1', {
      type: 'GOLF_COURSE',
      mode: 'SHARED',
      capacity: 100,
    });
    for (const e of ['a', 'b']) w.entrant(e);
    planned(w, 't-a', { grouped: true, partitionKey: 't1', type: 'SERIES', entrants: ['a'] });
    planned(w, 't-b', { grouped: true, partitionKey: 't1', type: 'SERIES', entrants: ['b'] });
    w.assign('t-a', { resource: 'g1', start: 0, end: 60 });
    const p = proposeSchedule(input(w));
    expect(unplaced(p, 'partition:r1:t1')).toMatchObject({
      reason: 'PARTIALLY_PLACED',
      contestIds: ['t-a', 't-b'],
    });
    expect(p.placements).toEqual([]);
  });

  it('10. a contest whose draft assignment was removed is a target again', () => {
    const w = twoMatches();
    planned(w, 'm1', { entrants: ['a', 'b'] });
    // The removal fact is in the watermark; the contest has no live assignment.
    const judge = { ...w.input(), watermark: ['removed-fact-m1'] };
    const p = proposeSchedule({ ...input(w), judge });
    expect(placement(p, 'm1').start).toBe(S(T0));
  });
});

// ───────────────────────────── C. resources ─────────────────────────────

describe('C. resources', () => {
  it('11–12. a resource of another type is never used: NO_COMPATIBLE_RESOURCE', () => {
    const w = world().resource('p1', { type: 'PADEL_COURT' }).entrant('x').entrant('y');
    planned(w, 'm1', { entrants: ['x', 'y'] });
    const p = proposeSchedule(input(w));
    expect(unplaced(p, 'contest:m1').reason).toBe('NO_COMPATIBLE_RESOURCE');
    expect(p.status).toBe('NO_CANDIDATES');
  });

  it('RETIRED resources are not compatible', () => {
    const w = world().resource('c1', { status: 'RETIRED' }).entrant('x').entrant('y');
    planned(w, 'm1', { entrants: ['x', 'y'] });
    expect(unplaced(proposeSchedule(input(w)), 'contest:m1').reason).toBe('NO_COMPATIBLE_RESOURCE');
  });

  it('13. a declared blackout is avoided (RESOURCE_UNAVAILABLE never proposed)', () => {
    const w = world().resource('c1').entrant('x').entrant('y');
    w.fact('bo', 'c1', { kind: 'BLACKOUT', startsAt: T0, endsAt: T0 + 2 * HOUR, reason: 'works' });
    planned(w, 'm1', { entrants: ['x', 'y'] });
    const p = proposeSchedule(input(w));
    expect(placement(p, 'm1').start).toBe(S(T0 + 2 * HOUR));
    expect(judgedClean(w, p)).toEqual([]);
  });

  it('14. resource overlap on the second court is avoided at the same instant', () => {
    const w = world().resource('c1').resource('c2');
    for (const e of ['a', 'b', 'c', 'd']) w.entrant(e);
    w.contest('m0', { entrants: ['a', 'b'] }).assign('m0', { resource: 'c1', start: 0, end: 60 });
    planned(w, 'm1', { entrants: ['c', 'd'] });
    const p = proposeSchedule(input(w));
    expect(placement(p, 'm1')).toMatchObject({ resourceId: 'c2', start: S(T0) });
    expect(p.diagnostics.skips.resource).toBe(1);
  });

  it('15. exclusivity keys: a half court waits for the busy full court', () => {
    const w = world(spec({ resourceType: 'BASKETBALL_HALF_COURT' }))
      .resource('full', { type: 'BASKETBALL_COURT', keys: ['h1', 'h2'] })
      .resource('half', { type: 'BASKETBALL_HALF_COURT', keys: ['h1'] });
    for (const e of ['a', 'b', 'c', 'd']) w.entrant(e);
    w.contest('g0', { event: 'e2', entrants: ['a', 'b'] }).assign('g0', {
      resource: 'full',
      start: 0,
      end: 90,
    });
    w.event('e2', { profile: null });
    planned(w, 'g1', { entrants: ['c', 'd'] });
    const p = proposeSchedule(input(w));
    expect(placement(p, 'g1').start).toBe(S(at(90)));
    expect(judgedClean(w, p)).toEqual([]);
  });

  it('16. shared capacity: a group that does not fit waits for capacity to free up', () => {
    const golf = spec({ resourceType: 'GOLF_COURSE', capacityUnit: 'ENTRANT' });
    const w = world(golf).resource('g1', { type: 'GOLF_COURSE', mode: 'SHARED', capacity: 4 });
    for (const e of ['a', 'b', 'c', 'd', 'e']) w.entrant(e);
    w.contest('big', { type: 'SERIES', entrants: ['a', 'b', 'c', 'd'] });
    w.assign('big', { resource: 'g1', start: 0, end: 60 });
    planned(w, 'solo', { type: 'SERIES', entrants: ['e'] });
    const p = proposeSchedule(input(w));
    expect(placement(p, 'solo').start).toBe(S(at(60)));
  });

  it('17. start spacing on a SHARED course', () => {
    const golf = spec({
      resourceType: 'GOLF_COURSE',
      capacityUnit: 'ENTRANT',
      startSpacingSeconds: 600,
      expectedDurationSeconds: 4 * 3_600,
    });
    const w = world(golf).resource('g1', { type: 'GOLF_COURSE', mode: 'SHARED', capacity: 100 });
    for (const e of ['a', 'b']) w.entrant(e);
    w.contest('t0', { type: 'SERIES', entrants: ['a'] });
    w.assign('t0', { resource: 'g1', start: 0, end: 240 });
    planned(w, 't1', { type: 'SERIES', entrants: ['b'] });
    expect(placement(proposeSchedule(input(w)), 't1').start).toBe(S(at(10)));
  });

  it('18. concurrent starts: two units share a slot, the third takes the next slot', () => {
    const golf = spec({
      resourceType: 'GOLF_COURSE',
      capacityUnit: 'ENTRANT',
      startSpacingSeconds: 600,
      concurrentStarts: 2,
      expectedDurationSeconds: 4 * 3_600,
    });
    const w = world(golf).resource('g1', { type: 'GOLF_COURSE', mode: 'SHARED', capacity: 100 });
    for (const e of ['a', 'b', 'c']) w.entrant(e);
    for (const e of ['a', 'b', 'c']) planned(w, `t-${e}`, { type: 'SERIES', entrants: [e] });
    const p = proposeSchedule(input(w));
    expect(p.placements.map((x) => x.start - S(T0))).toEqual([0, 0, 600]);
    expect(judgedClean(w, p)).toEqual([]);
  });
});

// ───────────────────────────── D. time ─────────────────────────────

describe('D. time domain', () => {
  const one = (o: Parameters<typeof world>[1] = {}, profile = spec({})) => {
    const w = world(profile, o).resource('c1').entrant('x').entrant('y');
    planned(w, 'm1', { entrants: ['x', 'y'] });
    return w;
  };

  it('19–20. the window start bounds the earliest start (event window, else competition: the loader coalesces)', () => {
    const p = proposeSchedule(input(one({ windowStartMs: T0 + 3 * HOUR })));
    expect(placement(p, 'm1').start).toBe(S(T0 + 3 * HOUR));
  });

  it('19b. a window too short for the unit: NO_HORIZON', () => {
    const p = proposeSchedule(input(one({ windowEndMs: T0 + 30 * MIN })));
    expect(unplaced(p, 'contest:m1').reason).toBe('NO_HORIZON');
  });

  it('21. run.from moves the earliest start; it must be whole seconds', () => {
    const w = one();
    expect(placement(proposeSchedule(input(w, { fromMs: T0 + 2 * HOUR })), 'm1').start).toBe(
      S(T0 + 2 * HOUR),
    );
    expect(() => proposeSchedule(input(w, { fromMs: T0 + 1 }))).toThrow(ScheduleProposalError);
  });

  it('22. no finite window end: NO_HORIZON, status NO_CANDIDATES (the clock is never read)', () => {
    const p = proposeSchedule(input(one({ windowEndMs: null })));
    expect(unplaced(p, 'contest:m1').reason).toBe('NO_HORIZON');
    expect(p.status).toBe('NO_CANDIDATES');
  });

  it('23. declared-open weekly hours: the first opening', () => {
    const w = world(spec({}), { open: false }).resource('c1').entrant('x').entrant('y');
    // T0 is Saturday 08:00 UTC (ISO weekday 6).
    w.fact('wk', 'c1', { kind: 'WEEKLY', weekday: 6, start: '09:00', end: '17:00' });
    planned(w, 'm1', { entrants: ['x', 'y'] });
    expect(placement(proposeSchedule(input(w)), 'm1').start).toBe(S(T0 + HOUR));
  });

  it('24. undeclared time is never proposed: NO_DECLARED_TIME, or the declared day', () => {
    const none = world(spec({}), { open: false }).resource('c1').entrant('x').entrant('y');
    planned(none, 'm1', { entrants: ['x', 'y'] });
    expect(unplaced(proposeSchedule(input(none)), 'contest:m1').reason).toBe('NO_DECLARED_TIME');

    const w = world(spec({}), { open: false }).resource('c1').entrant('x').entrant('y');
    w.fact('d2', null, { kind: 'DATE_OPEN', date: '2026-11-15', start: '10:00', end: '18:00' });
    planned(w, 'm1', { entrants: ['x', 'y'] });
    const p = proposeSchedule(input(w));
    expect(placement(p, 'm1').start).toBe(S(Date.UTC(2026, 10, 15, 10)));
    expect(judgedClean(w, p)).toEqual([]);
  });

  it('25. declared-closed dates are rejected', () => {
    const w = world().resource('c1').entrant('x').entrant('y');
    w.fact('closed', 'c1', { kind: 'DATE_CLOSED', date: '2026-11-14' });
    planned(w, 'm1', { entrants: ['x', 'y'] });
    expect(placement(proposeSchedule(input(w)), 'm1').start).toBe(S(Date.UTC(2026, 10, 15)));
  });

  it('26. a legacy sub-second anchor rounds UP to the next whole second', () => {
    const w = world().resource('c1');
    for (const e of ['a', 'b', 'c', 'd']) w.entrant(e);
    w.contest('m0', { entrants: ['a', 'b'] }).assign('m0', {
      resource: 'c1',
      startMs: T0,
      endMs: T0 + HOUR + 500,
    });
    planned(w, 'm1', { entrants: ['c', 'd'] });
    const p = proposeSchedule(input(w));
    expect(placement(p, 'm1').start).toBe(S(T0 + HOUR) + 1);
    expect(p.placements.every((x) => Number.isSafeInteger(x.start))).toBe(true);
  });

  it('the expected end includes the latest plan offset (05E-C write default)', () => {
    const w = one();
    expect(placement(proposeSchedule(input(w, { offsets: { m1: 900 } })), 'm1').expectedEnd).toBe(
      S(T0 + HOUR) + 900,
    );
  });
});

// ───────────────────────────── E. grouping ─────────────────────────────

describe('E. grouped units', () => {
  const golf = spec({ resourceType: 'GOLF_COURSE', capacityUnit: 'ENTRANT' });
  const bowling = spec({
    resourceType: 'BOWLING_LANE_PAIR',
    capacityUnit: 'ENTRANT',
    changeoverSeconds: 900,
  });
  const squad = (w: World, n: number, key = 't1') => {
    for (let i = 1; i <= n; i++) {
      w.entrant(`b${key}${i}`);
      planned(w, `s-${key}-${i}`, {
        grouped: true,
        partitionKey: key,
        type: 'SERIES',
        entrants: [`b${key}${i}`],
      });
    }
  };

  it('27. a grouped unit on a SHARED course: every member on one course, one start', () => {
    const w = world(golf)
      .resource('g1', { type: 'GOLF_COURSE', mode: 'SHARED', capacity: 100 })
      .resource('g2', { type: 'GOLF_COURSE', mode: 'SHARED', capacity: 100 });
    squad(w, 4);
    const p = proposeSchedule(input(w));
    expect(new Set(p.placements.map((x) => x.resourceId))).toEqual(new Set(['g1']));
    expect(new Set(p.placements.map((x) => x.start))).toEqual(new Set([S(T0)]));
    expect(new Set(p.placements.map((x) => x.unitKey))).toEqual(new Set(['partition:r1:t1']));
  });

  it('28–29. an EXCLUSIVE squad is packed by capacity over lane pairs in id order', () => {
    const w = world(bowling);
    for (const id of ['p1', 'p2', 'p3']) w.resource(id, { type: 'BOWLING_LANE_PAIR', capacity: 4 });
    squad(w, 8);
    const p = proposeSchedule(input(w));
    expect(p.placements.map((x) => x.resourceId)).toEqual([
      'p1',
      'p1',
      'p1',
      'p1',
      'p2',
      'p2',
      'p2',
      'p2',
    ]);
    expect(judgedClean(w, p)).toEqual([]);
  });

  it('30. a busy pair is excluded and the packing rebuilt at the same instant', () => {
    const w = world(bowling);
    for (const id of ['p1', 'p2', 'p3']) w.resource(id, { type: 'BOWLING_LANE_PAIR', capacity: 4 });
    w.entrant('other');
    w.contest('busy', { event: 'e2', type: 'SERIES', entrants: ['other'] });
    w.event('e2', { profile: null });
    w.assign('busy', { resource: 'p1', start: 0, end: 120 });
    squad(w, 8);
    const p = proposeSchedule(input(w));
    expect(new Set(p.placements.map((x) => x.resourceId))).toEqual(new Set(['p2', 'p3']));
    expect(new Set(p.placements.map((x) => x.start))).toEqual(new Set([S(T0)]));
    expect(p.diagnostics.packingRebuilds).toBeGreaterThanOrEqual(1);
  });

  it('31. a unit is never split across two SHARED courses (it stays unplaced instead)', () => {
    const w = world(golf)
      .resource('g1', { type: 'GOLF_COURSE', mode: 'SHARED', capacity: 2 })
      .resource('g2', { type: 'GOLF_COURSE', mode: 'SHARED', capacity: 2 });
    squad(w, 4);
    const p = proposeSchedule(input(w));
    expect(p.placements).toEqual([]);
    expect(unplaced(p, 'partition:r1:t1').reason).toBe('NO_FEASIBLE_CANDIDATE');
    expect(p.status).toBe('INFEASIBLE');
  });

  it('round 2 inherits the round-1 squad and is placed as one unit', () => {
    const w = world(bowling);
    for (const id of ['p1', 'p2']) w.resource(id, { type: 'BOWLING_LANE_PAIR', capacity: 4 });
    for (const i of [1, 2]) {
      w.entrant(`e${i}`);
      planned(w, `r1-${i}`, {
        grouped: true,
        partitionKey: 't1',
        type: 'SERIES',
        entrants: [`e${i}`],
        unitParticipant: `e${i}`,
      });
      planned(w, `r2-${i}`, {
        round: 'r2',
        roundSeq: 2,
        grouped: true,
        type: 'SERIES',
        entrants: [`e${i}`],
        unitParticipant: `e${i}`,
      });
    }
    const p = proposeSchedule(input(w));
    expect(p.status).toBe('SUCCESS');
    expect(new Set(p.placements.map((x) => x.unitKey))).toEqual(
      new Set(['partition:r1:t1', 'partition:r2:t1']),
    );
    expect(placement(p, 'r2-1').start).toBe(placement(p, 'r2-2').start);
    expect(placement(p, 'r2-1').start).toBeGreaterThanOrEqual(placement(p, 'r1-1').expectedEnd);
  });

  it('a profile regroup forms the post-cut units over 05D field ordinals', () => {
    const w = world({
      ...golf,
      regrouping: { groupSize: 2, order: 'FIELD_ORDINAL_DESC' },
    }).resource('g1', { type: 'GOLF_COURSE', mode: 'SHARED', capacity: 100 });
    for (const i of [1, 2, 3]) {
      w.entrant(`q${i}`);
      planned(w, `cut-${i}`, {
        grouped: true,
        dynamic: true,
        type: 'SERIES',
        unitOrdinal: i,
      });
      w.place(`cut-${i}`, 1, { state: 'RESOLVED', occupant: `q${i}`, sourceKind: 'QUALIFIER' });
    }
    const p = proposeSchedule(input(w));
    expect(placement(p, 'cut-3').unitKey).toBe('regroup:r1:1');
    expect(placement(p, 'cut-2').unitKey).toBe('regroup:r1:1');
    expect(placement(p, 'cut-1').unitKey).toBe('regroup:r1:2');
  });
});

// ───────────────────────────── F. dependencies ─────────────────────────────

describe('F. dependencies and occupants', () => {
  const ko = (lead = 900) => {
    const w = world(spec({ dependencyLeadSeconds: lead }))
      .resource('c1')
      .resource('c2');
    for (const e of ['a', 'b', 'c', 'd']) w.entrant(e);
    planned(w, 'sf1', { entrants: ['a', 'b'] });
    planned(w, 'sf2', { entrants: ['c', 'd'] });
    planned(w, 'f', { round: 'r2', roundSeq: 2 });
    w.place('f', 1, { feeders: ['sf1'] }).place('f', 2, { feeders: ['sf2'] });
    return w;
  };

  it('32. a final starts after both semifinals plus the dependency lead', () => {
    const w = ko();
    const p = proposeSchedule(input(w));
    expect(placement(p, 'f').start).toBe(S(T0 + HOUR) + 900);
    expect(judgedClean(w, p)).toEqual([]);
  });

  it('33. a feeder that stays unplaced makes the dependent FEEDER_UNPLACED', () => {
    const w = ko();
    w.place('sf1', 3, { state: 'STALE', occupant: 'a', feeders: [] });
    const p = proposeSchedule(input(w));
    expect(unplaced(p, 'contest:sf1').reason).toBe('STALE_OCCUPANT');
    expect(unplaced(p, 'contest:f').reason).toBe('FEEDER_UNPLACED');
    expect(p.status).toBe('INFEASIBLE');
  });

  it('34. only materialized contests are placed; a materialized dynamic contest is placed', () => {
    const w = world().resource('c1').entrant('a');
    planned(w, 'q1', { round: 'r9', dynamic: true, type: 'SERIES', unitOrdinal: 1 });
    w.place('q1', 1, { state: 'RESOLVED', occupant: 'a', sourceKind: 'QUALIFIER' });
    const p = proposeSchedule(input(w));
    expect(p.placements.map((x) => x.contestId)).toEqual(['q1']);
    expect(placement(p, 'q1').provisional).toBe(false);
  });

  it('35. an unresolved place gives a provisional placement (possible occupants judged by D)', () => {
    const w = ko();
    const p = proposeSchedule(input(w));
    expect(placement(p, 'f').provisional).toBe(true);
    expect(placement(p, 'sf1').provisional).toBe(false);
  });

  it('a feeder COMPLETED in the base imposes nothing; a CANCELLED contest is never placed', () => {
    const w = world(spec({ dependencyLeadSeconds: 900 })).resource('c1');
    for (const e of ['a', 'b']) w.entrant(e);
    w.contest('sf', { status: 'COMPLETED', entrants: ['a', 'b'] });
    planned(w, 'x', { status: 'CANCELLED', entrants: ['a', 'b'] });
    planned(w, 'f', { round: 'r2', roundSeq: 2 });
    w.place('f', 1, { feeders: ['sf'] });
    const p = proposeSchedule(input(w));
    expect(p.placements.map((x) => x.contestId)).toEqual(['f']);
    expect(placement(p, 'f').start).toBe(S(T0));
  });
});

// ───────────────────────────── G. conflicts ─────────────────────────────

describe('G. acceptance comes only from the judge', () => {
  it('36. a HARD participant overlap is rejected; the instant is skipped for every court', () => {
    const w = world().resource('c1').resource('c2');
    for (const e of ['a', 'b', 'c']) w.entrant(e);
    w.contest('m0', { entrants: ['a', 'b'] }).assign('m0', { resource: 'c1', start: 0, end: 60 });
    planned(w, 'm1', { entrants: ['a', 'c'] });
    const p = proposeSchedule(input(w));
    expect(placement(p, 'm1')).toMatchObject({ start: S(at(60)), resourceId: 'c1' });
    expect(p.diagnostics.skips.time).toBe(1);
    expect(p.diagnostics.judgeCalls).toBe(2);
  });

  it('37. AVAILABILITY_UNDECLARED is never accepted (undeclared time is outside the domain)', () => {
    const w = world(spec({}), { open: false }).resource('c1').entrant('x').entrant('y');
    w.fact('d', 'c1', { kind: 'DATE_OPEN', date: '2026-11-14', start: '08:00', end: '08:30' });
    planned(w, 'm1', { entrants: ['x', 'y'] });
    const p = proposeSchedule(input(w));
    // 08:00–08:30 cannot hold a one-hour match; nothing after it is declared.
    expect(unplaced(p, 'contest:m1').reason).toBe('NO_FEASIBLE_CANDIDATE');
    expect(p.placements).toEqual([]);
  });

  it('38. SOFT rest is accepted at the earliest feasible instant and reported, never avoided', () => {
    const w = world(spec({ rest: { minimumSeconds: 3_600, enforcement: 'SOFT' } }))
      .resource('c1')
      .resource('c2');
    for (const e of ['a', 'b', 'c']) w.entrant(e);
    w.contest('m0', { round: 'r0', roundSeq: 0, entrants: ['a', 'b'] });
    w.assign('m0', { resource: 'c1', start: 0, end: 60 });
    planned(w, 'm1', { entrants: ['a', 'c'] });
    const p = proposeSchedule(input(w));
    expect(placement(p, 'm1').start).toBe(S(at(60)));
    expect(placement(p, 'm1').softConflictKeys).toHaveLength(1);
    expect(p.metrics.placementsWithSoftConflicts).toBe(1);
  });

  it('38b. HARD rest is never violated', () => {
    const w = world(spec({ rest: { minimumSeconds: 3_600, enforcement: 'HARD' } })).resource('c1');
    for (const e of ['a', 'b', 'c']) w.entrant(e);
    w.contest('m0', { round: 'r0', roundSeq: 0, entrants: ['a', 'b'] });
    w.assign('m0', { resource: 'c1', start: 0, end: 60 });
    planned(w, 'm1', { entrants: ['a', 'c'] });
    expect(placement(proposeSchedule(input(w)), 'm1').start).toBe(S(at(120)));
  });

  it('39. a pre-existing conflict that does not involve the candidate never rejects it', () => {
    const w = world().resource('c1').resource('c2');
    for (const e of ['a', 'b', 'c', 'd', 'e', 'f']) w.entrant(e);
    w.contest('x1', { entrants: ['a', 'b'] }).assign('x1', { resource: 'c1', start: 0, end: 60 });
    w.contest('x2', { entrants: ['c', 'd'] }).assign('x2', { resource: 'c1', start: 0, end: 60 });
    planned(w, 'm1', { entrants: ['e', 'f'] });
    const p = proposeSchedule(input(w));
    expect(placement(p, 'm1')).toMatchObject({ resourceId: 'c2', start: S(T0) });
    expect(p.metrics.baseHardConflicts).toBe(1);
    expect(p.report.hardConflicts).toBe(1);
  });
});

// ───────────────────────────── H. determinism ─────────────────────────────

function mixed() {
  const w = world(spec({ changeoverSeconds: 300, dependencyLeadSeconds: 600 }))
    .resource('c2')
    .resource('c1');
  for (const e of ['a', 'b', 'c', 'd', 'e', 'f']) w.entrant(e);
  w.contest('m0', { entrants: ['e', 'f'] }).assign('m0', { resource: 'c1', start: 0, end: 60 });
  planned(w, 'sf1', { entrants: ['a', 'b'] });
  planned(w, 'sf2', { entrants: ['c', 'd'] });
  planned(w, 'f', { round: 'r2', roundSeq: 2 });
  w.place('f', 1, { feeders: ['sf1'] }).place('f', 2, { feeders: ['sf2'] });
  return w;
}

const reversed = (i: ScheduleProposalInput): ScheduleProposalInput => ({
  ...i,
  judge: {
    ...i.judge,
    watermark: [...i.judge.watermark].reverse(),
    assignments: [...i.judge.assignments].reverse(),
    contests: [...i.judge.contests].reverse(),
    places: [...i.judge.places].reverse(),
    entrants: [...i.judge.entrants].reverse(),
    events: [...i.judge.events].reverse(),
    resources: [...i.judge.resources].reverse(),
    availability: [...i.judge.availability].reverse(),
  },
  eventStatuses: [...i.eventStatuses].reverse(),
  latestOffsets: [...i.latestOffsets].reverse(),
});

const semantic = (p: ScheduleProposal) => {
  const { diagnostics: _d, ...body } = p;
  return body;
};

describe('H. determinism', () => {
  afterEach(() => vi.useRealTimers());

  it('40–42. same input ⇒ byte-identical semantic proposal and hash, repeatedly', () => {
    const a = proposeSchedule(input(mixed()));
    const b = proposeSchedule(input(mixed()));
    expect(JSON.stringify(semantic(a))).toBe(JSON.stringify(semantic(b)));
    expect(a.proposalHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(b.proposalHash).toBe(a.proposalHash);
  });

  it('41. input row order never changes the result', () => {
    const a = proposeSchedule(input(mixed()));
    const b = proposeSchedule(reversed(input(mixed())));
    expect(JSON.stringify(semantic(b))).toBe(JSON.stringify(semantic(a)));
  });

  it('43. wall-clock time and randomness are never read', () => {
    const random = vi.spyOn(Math, 'random');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const a = proposeSchedule(input(mixed()));
    vi.setSystemTime(new Date('2001-06-01T12:34:56Z'));
    const b = proposeSchedule(input(mixed()));
    expect(b.proposalHash).toBe(a.proposalHash);
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
  });
});

// ───────────────────────────── I. budget ─────────────────────────────

describe('I. logical budget (judge calls)', () => {
  const busy = () => {
    const w = world().resource('c1');
    for (const e of ['a', 'b', 'c', 'd', 'e', 'f']) w.entrant(e);
    w.contest('m0', { entrants: ['a', 'b'] }).assign('m0', { resource: 'c1', start: 0, end: 60 });
    planned(w, 'm1', { entrants: ['a', 'c'] });
    planned(w, 'm2', { entrants: ['e', 'f'] });
    return w;
  };

  it('44/47. a unit budget ends that unit as BUDGET_EXHAUSTED; the run continues', () => {
    const p = proposeScheduleWithBudget(input(busy()), {
      maxEvaluations: 100,
      maxEvaluationsPerUnit: 1,
    });
    // m1's first candidate (T0) overlaps participant a; its unit budget ends there. m2 then fits
    // at 01:00 after the preserved match on the only court (its first candidate also fails).
    expect(unplaced(p, 'contest:m1').reason).toBe('BUDGET_EXHAUSTED');
    expect(p.budget).toEqual({ maxEvaluations: 100, maxEvaluationsPerUnit: 1 });
    expect(p.status).toBe('SEARCH_EXHAUSTED');
  });

  it('45–46. the run budget: later units BUDGET_EXHAUSTED, status SEARCH_EXHAUSTED', () => {
    const p = proposeScheduleWithBudget(input(busy()), {
      maxEvaluations: 2,
      maxEvaluationsPerUnit: 500,
    });
    expect(placement(p, 'm1').start).toBe(S(at(60)));
    expect(unplaced(p, 'contest:m2').reason).toBe('BUDGET_EXHAUSTED');
    expect(p.status).toBe('SEARCH_EXHAUSTED');
    expect(p.diagnostics.judgeCalls).toBe(2);
  });

  it('the default budget is the v1 guardrail and is part of the identity', () => {
    const w = busy();
    const a = proposeSchedule(input(w));
    const b = proposeScheduleWithBudget(input(w), {
      maxEvaluations: 9_999,
      maxEvaluationsPerUnit: 500,
    });
    expect(a.budget).toEqual({ maxEvaluations: 10_000, maxEvaluationsPerUnit: 500 });
    expect(b.baseStateIdentity).not.toBe(a.baseStateIdentity);
    expect(b.placements).toEqual(a.placements);
  });
});

// ───────────────────────────── J. multi-stage order ─────────────────────────────

describe('J. unit order', () => {
  const court = () => {
    const w = world().resource('c1');
    for (const e of ['a', 'b', 'c', 'd', 'e', 'f']) w.entrant(e);
    return w;
  };

  it('48. stage order: the earlier stage gets the earlier slot', () => {
    const w = court();
    planned(w, 'late', { stage: 's2', stageSeq: 2, entrants: ['a', 'b'] });
    planned(w, 'early', { stage: 's1', stageSeq: 1, entrants: ['c', 'd'] });
    const p = proposeSchedule(input(w));
    expect(placement(p, 'early').start).toBe(S(T0));
    expect(placement(p, 'late').start).toBe(S(at(60)));
  });

  it('49. round order inside a stage', () => {
    const w = court();
    planned(w, 'r2m', { round: 'r2', roundSeq: 2, entrants: ['a', 'b'] });
    planned(w, 'r1m', { round: 'r1', roundSeq: 1, entrants: ['c', 'd'] });
    expect(placement(proposeSchedule(input(w)), 'r1m').start).toBe(S(T0));
  });

  it('50. dependency depth before plan sequence within one round', () => {
    const w = court();
    planned(w, 'feeder', { round: 'r1', roundSeq: 1, entrants: ['a', 'b'] });
    planned(w, 'deep', { round: 'r2', roundSeq: 2 });
    w.place('deep', 1, { feeders: ['feeder'] });
    planned(w, 'flat', { round: 'r2', roundSeq: 2, entrants: ['e', 'f'] });
    const p = proposeSchedule(input(w));
    expect(placement(p, 'flat').start).toBe(S(at(60)));
    expect(placement(p, 'deep').start).toBe(S(at(120)));
  });

  it('51. an unmaterialized dynamic round has no contests: nothing to place', () => {
    const w = court();
    w.contest('m0', { entrants: ['a', 'b'] }).assign('m0', { resource: 'c1', start: 0, end: 60 });
    const p = proposeSchedule(input(w));
    expect(p.status).toBe('NOTHING_TO_PLACE');
    expect(p.placements).toEqual([]);
  });

  it('scope narrows the targets only; the judgment stays competition-wide', () => {
    const w = court().event('e2', { profile: spec({}), windowStartMs: T0, windowEndMs: T0 + DAY });
    planned(w, 'm1', { entrants: ['a', 'b'] });
    planned(w, 'm2', { event: 'e2', entrants: ['a', 'c'] });
    const statuses = w.events.map((e) => ({ eventId: e.id, status: 'FIELD_LOCKED' }));
    const p = proposeSchedule(input(w, { scope: { eventIds: ['e2'] }, eventStatuses: statuses }));
    expect(p.placements.map((x) => x.contestId)).toEqual(['m2']);
    expect(p.scope).toEqual({ eventIds: ['e2'], roundIds: null });
  });
});

// ───────────────────────────── K. hashing ─────────────────────────────

describe('K. identity and hash', () => {
  it('52. any authoritative change changes the base identity', () => {
    const base = proposeSchedule(input(mixed()));
    const changed = [
      (w: World) => w.fact('extra', 'c1', { kind: 'DATE_CLOSED', date: '2026-12-01' }),
      (w: World) => {
        const i = w.resources.findIndex((r) => r.id === 'c1');
        w.resources[i] = { ...must(w.resources[i]), revisionId: 'rev-c1-2' };
      },
      (w: World) => {
        w.competitionTimezone = 'America/Costa_Rica';
      },
      (w: World) => w.contest('extra-contest', { status: 'PLANNED', round: 'r7' }),
    ];
    for (const change of changed) {
      const w = mixed();
      change(w);
      expect(proposeSchedule(input(w)).baseStateIdentity).not.toBe(base.baseStateIdentity);
    }
    const statuses = proposeSchedule(
      input(mixed(), { eventStatuses: [{ eventId: 'e1', status: 'IN_PROGRESS' }] }),
    );
    expect(statuses.baseStateIdentity).not.toBe(base.baseStateIdentity);
  });

  it('53. a changed placement changes the proposal hash', () => {
    const a = proposeSchedule(input(mixed()));
    const b = proposeSchedule(input(mixed(), { fromMs: T0 + HOUR }));
    expect(b.placements).not.toEqual(a.placements);
    expect(b.proposalHash).not.toBe(a.proposalHash);
  });

  it('54–55. diagnostics and timestamps are not hashed', () => {
    const p = proposeSchedule(input(mixed()));
    const withOtherDiagnostics = {
      ...p,
      diagnostics: {
        judgeCalls: 1,
        totalEvaluations: 1,
        skips: { unit: 9, time: 9, resource: 9 },
        packingRebuilds: 9,
      },
      producedAt: '2030-01-01T00:00:00Z',
      runtimeMs: 12,
    };
    expect(proposalHash(withOtherDiagnostics)).toBe(p.proposalHash);
    expect(JSON.stringify(semantic(p))).not.toMatch(/runtime|timestamp|producedAt|recordedAt/i);
  });

  it('56. row order never changes either hash', () => {
    const a = proposeSchedule(input(mixed()));
    const b = proposeSchedule(reversed(input(mixed())));
    expect(b.baseStateIdentity).toBe(a.baseStateIdentity);
    expect(b.proposalHash).toBe(a.proposalHash);
  });
});

// ───────────────────────────── reasons, statuses, refusals ─────────────────────────────

describe('unplaced reasons and statuses', () => {
  it('NO_PROFILE and EVENT_NOT_SCHEDULABLE are reported, never searched', () => {
    const w = world(null).resource('c1').entrant('x').entrant('y');
    planned(w, 'm1', { entrants: ['x', 'y'] });
    const p = proposeSchedule(input(w));
    expect(unplaced(p, 'contest:m1').reason).toBe('NO_PROFILE');
    expect(p.status).toBe('NOTHING_TO_PLACE');

    const v = world().resource('c1').entrant('x').entrant('y');
    planned(v, 'm1', { entrants: ['x', 'y'] });
    const q = proposeSchedule(
      input(v, { eventStatuses: [{ eventId: 'e1', status: 'REGISTRATION_OPEN' }] }),
    );
    expect(unplaced(q, 'contest:m1').reason).toBe('EVENT_NOT_SCHEDULABLE');
    expect(q.diagnostics.judgeCalls).toBe(0);
  });

  it('ALL_VACANT units have nothing to schedule', () => {
    const w = world().resource('c1');
    planned(w, 'm1');
    w.place('m1', 1, { state: 'VACANT' }).place('m1', 2, { state: 'VACANT' });
    expect(unplaced(proposeSchedule(input(w)), 'contest:m1').reason).toBe('ALL_VACANT');
  });

  it('INFEASIBLE never claims more than the greedy space: it carries the blocking conflicts', () => {
    const w = world(spec({}), { windowEndMs: T0 + HOUR }).resource('c1');
    for (const e of ['a', 'b', 'c', 'd']) w.entrant(e);
    planned(w, 'm1', { entrants: ['a', 'b'] });
    planned(w, 'm2', { entrants: ['c', 'd'] });
    const p = proposeSchedule(input(w));
    expect(p.status).toBe('INFEASIBLE');
    expect(unplaced(p, 'contest:m2')).toMatchObject({ reason: 'NO_FEASIBLE_CANDIDATE' });
    expect(unplaced(p, 'contest:m2').blockingConflictKeys).toHaveLength(1);
  });
});

describe('refusals produce no proposal', () => {
  const ok = () => {
    const w = world().resource('c1').entrant('x').entrant('y');
    planned(w, 'm1', { entrants: ['x', 'y'] });
    return w;
  };
  const refusal = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return e instanceof ScheduleProposalError ? e.code : 'OTHER';
    }
    return 'NONE';
  };

  it('INCOMPLETE_STATE: no open draft, or a closed competition', () => {
    expect(refusal(() => proposeSchedule(input(ok(), { draftStatus: 'PUBLISHED' })))).toBe(
      'INCOMPLETE_STATE',
    );
    for (const competitionStatus of ['COMPLETED', 'CANCELLED'])
      expect(refusal(() => proposeSchedule(input(ok(), { competitionStatus })))).toBe(
        'INCOMPLETE_STATE',
      );
  });

  it('INVALID_INPUT: foreign scope, invalid from, malformed base state', () => {
    expect(refusal(() => proposeSchedule(input(ok(), { scope: { eventIds: ['nope'] } })))).toBe(
      'INVALID_INPUT',
    );
    expect(refusal(() => proposeSchedule(input(ok(), { scope: { roundIds: ['nope'] } })))).toBe(
      'INVALID_INPUT',
    );
    expect(refusal(() => proposeSchedule(input(ok(), { fromMs: -1000 })))).toBe('INVALID_INPUT');
    const broken = ok();
    broken.assign('ghost', { resource: 'c1', start: 0, end: 60 });
    expect(refusal(() => proposeSchedule(input(broken)))).toBe('INVALID_INPUT');
  });
});

describe('search classes and boundaries', () => {
  it('classifies every judge code; ADR-0075 § 8 table', () => {
    expect(Object.keys(CONFLICT_SEARCH_CLASS).sort()).toEqual([...CONFLICT_CODES].sort());
    expect(CONFLICT_SEARCH_CLASS.STALE_OCCUPANT).toBe('UNIT');
    for (const c of [
      'PARTICIPANT_OVERLAP',
      'TEAM_OVERLAP',
      'SHORT_REST',
      'DEPENDENCY_ORDER',
      'MAX_CONTESTS_PER_DAY',
      'ROUND_SEQUENCE',
      'OUTSIDE_EVENT_WINDOW',
    ] as const)
      expect(CONFLICT_SEARCH_CLASS[c]).toBe('TIME');
    for (const c of [
      'RESOURCE_OVERLAP',
      'EXCLUSIVITY_CONFLICT',
      'CAPACITY_EXCEEDED',
      'RESOURCE_TYPE_MISMATCH',
      'RESOURCE_UNAVAILABLE',
      'AVAILABILITY_UNDECLARED',
      'START_SPACING',
      'CONCURRENT_STARTS_EXCEEDED',
      'UNIT_SPLIT',
    ] as const)
      expect(CONFLICT_SEARCH_CLASS[c]).toBe('RESOURCE');
  });

  it('the proposal module never names a sport or re-implements a judge rule', () => {
    const src = readFileSync(fileURLToPath(new URL('./proposal.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(
      /tennis|padel|golf|swim|bowling|basketball|wheelchair|cycling|marathon|running|sport\s*===|discipline\s*===|typeCode\s*===\s*'/i,
    );
    // No local overlap / capacity / rest / spacing judgment: only the judge's report decides.
    expect(src).not.toMatch(
      /sharesSpace|minimumSeconds\s*[<>]|startSpacingSeconds\s*[<>]|maxUnitsPerEntrantPerDay\.value/,
    );
    expect(src).toMatch(/evaluateSchedule\(/);
  });
});

// ───────────────────────────── ADR-0075 § 10 amendment: local-date boundaries ─────────────────────────────

describe('daily-limit local-date boundaries (ADR-0075 § 10 amendment)', () => {
  /**
   * The discovered case: continuous 24 h availability (one merged interval, no local-midnight
   * interval start), a HARD 1/day limit, the entrant already playing on day N, and no other
   * blocking constraint. The earliest feasible start is local midnight of day N+1 in the EVENT zone.
   */
  const dailyLimit = (timezone: string) => {
    const w = new World()
      .event('e1', {
        profile: spec({ maxUnitsPerEntrantPerDay: { value: 1, enforcement: 'HARD' } }),
        timezone,
        windowStartMs: T0,
        windowEndMs: T0 + 3 * DAY,
      })
      .resource('c1');
    for (const e of ['a', 'b', 'c']) w.entrant(e);
    w.contest('m0', { round: 'r0', roundSeq: 0, entrants: ['a', 'b'] });
    w.assign('m0', { resource: 'c1', start: 0, end: 60 });
    planned(w, 'm1', { entrants: ['a', 'c'] });
    return w;
  };

  it.each([
    // T0 = 2026-11-14 08:00 UTC. Next local midnight after the day-N match, in each event zone:
    ['America/New_York', Date.UTC(2026, 10, 15, 5)], // Sat 03:00 EST → Sun 00:00 EST
    ['America/Costa_Rica', Date.UTC(2026, 10, 15, 6)], // Sat 02:00 CST → Sun 00:00 CST
    ['Asia/Tokyo', Date.UTC(2026, 10, 14, 15)], // Sat 17:00 JST → Sun 00:00 JST
  ])('%s: the start is the next local-date boundary, feasible and stable', (zone, midnight) => {
    const w = dailyLimit(zone);
    const p = proposeSchedule(input(w));
    expect(p.status).toBe('SUCCESS');
    expect(placement(p, 'm1')).toMatchObject({ start: S(midnight), zone });
    expect(judgedClean(w, p)).toEqual([]);
    expect(p.report.hardConflicts).toBe(0);
    const again = proposeSchedule(input(dailyLimit(zone)));
    expect(again.proposalHash).toBe(p.proposalHash);
  });

  it('the boundary follows the event zone, never UTC midnight or the server zone', () => {
    const ny = placement(proposeSchedule(input(dailyLimit('America/New_York'))), 'm1').start;
    const tokyo = placement(proposeSchedule(input(dailyLimit('Asia/Tokyo'))), 'm1').start;
    expect(ny).not.toBe(tokyo);
    expect(ny).not.toBe(S(Date.UTC(2026, 10, 15)));
    expect(proposeSchedule(input(dailyLimit('UTC'))).placements[0]?.start).toBe(
      S(Date.UTC(2026, 10, 15)),
    );
  });

  it('without a daily limit, local-date boundaries are not breakpoints (no grid)', () => {
    const w = world().resource('c1').entrant('x').entrant('y');
    planned(w, 'm1', { entrants: ['x', 'y'] });
    // One target, empty court: exactly one candidate is evaluated, at the horizon start.
    const p = proposeSchedule(input(w));
    expect(p.diagnostics.judgeCalls).toBe(1);
    expect(placement(p, 'm1').start).toBe(S(T0));
  });
});
