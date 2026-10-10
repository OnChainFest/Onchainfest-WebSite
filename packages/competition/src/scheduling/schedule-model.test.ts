import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ResourceType } from '../capabilities';
import type { CompetitionFormatEngineV2 } from '../format/engine';
import type { PlanDocumentV2 } from '../format/plan-v2';
import { formatEngine } from '../format/registry';
import { RESOURCE_TYPE_DEFAULT_OCCUPANCY_MODE } from '../resources/resource';
import {
  BASELINE_COVERAGE,
  baselineScheduleReport,
  blockingEnd,
  defaultExpectedEnd,
  isWholeSecond,
  type BaselineAssignment,
  type BaselineEvent,
} from './assignment';
import {
  canonicalScheduleReport,
  CONFLICT_CODES,
  CONFLICT_SEVERITY,
  conflictKey,
  reportVerdict,
  scheduleReportHash,
  ScheduleReportError,
  type ScheduleConflict,
  type ScheduleConflictReport,
} from './report';
import { SCHEDULING_PROFILE_TEMPLATES } from './templates';
import { deriveUnitKeys, type UnitContestFacts } from './units';

/**
 * ONCF-05E-C pure schedule model: the conflict-report contract (vocabulary, canonical order,
 * pairwise de-duplication, hash, acknowledgement keys), scheduling-unit keys (ADR-0073 B9), interval
 * defaults and the baseline validator. Nothing here judges feasibility (05E-D).
 */

const ids = (n: number) =>
  Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);

function plan(engine: string, n: number, config: Record<string, unknown>): PlanDocumentV2 {
  const field = ids(n);
  return (formatEngine(engine, 1) as CompetitionFormatEngineV2).generate({
    eventId: '00000000-0000-4000-8000-0000000000ee',
    participants: field.map((participantId) => ({ participantId, kind: 'INDIVIDUAL' })),
    seedOrder: field,
    config,
    allowedContestTypes: ['SERIES', 'MATCH', 'HEAT'],
  });
}

/** Plan keys stand in for database ids. */
function facts(p: PlanDocumentV2): UnitContestFacts[] {
  return p.rounds.flatMap((r) => {
    const stage = p.stages.find((s) => s.key === r.stageKey);
    return r.contests.map((c) => ({
      contestId: c.key,
      roundId: r.key,
      roundSequence: r.sequence,
      stageId: r.stageKey,
      grouped: stage?.partition?.method === 'GROUPED_ENTRANTS',
      dynamic: r.dynamicEntry !== undefined,
      partitionKey: c.partitionKey ?? null,
      participantId:
        c.slots.length === 1 && c.slots[0]?.source === 'PARTICIPANT'
          ? (c.slots[0].participantId ?? null)
          : null,
      fieldOrdinal: null,
    }));
  });
}

describe('occupancy mode: a declared resource fact with write-time defaults (ADR-0073 B2)', () => {
  it('every resource type has the frozen default; capacity plays no part', () => {
    expect(Object.keys(RESOURCE_TYPE_DEFAULT_OCCUPANCY_MODE).sort()).toEqual(
      Object.values(ResourceType).sort(),
    );
    expect(
      Object.entries(RESOURCE_TYPE_DEFAULT_OCCUPANCY_MODE)
        .filter(([, m]) => m === 'SHARED')
        .map(([t]) => t)
        .sort(),
    ).toEqual(['CYCLING_COURSE', 'GOLF_COURSE', 'OPEN_WATER_COURSE', 'ROAD_COURSE']);
  });
});

// ───────────────────────────── conflict-report contract ─────────────────────────────

const conflict = (over: Partial<ScheduleConflict> = {}): ScheduleConflict => ({
  code: 'RESOURCE_OVERLAP',
  severity: 'HARD',
  certainty: 'CERTAIN',
  interval: { start: 1_000, end: 2_000 },
  unitKeys: ['contest:a'],
  contestIds: ['a'],
  assignmentIds: ['fa'],
  resourceIds: ['r1'],
  ...over,
});

const report = (conflicts: ScheduleConflict[], over: Partial<ScheduleConflictReport> = {}) =>
  ({
    reportVersion: 1,
    competitionId: 'c1',
    scheduleVersionId: 'v1',
    assignmentIds: ['fb', 'fa'],
    inputs: {
      events: [
        { eventId: 'e2', timezone: 'UTC', profileVersionId: null, specHash: null },
        { eventId: 'e1', timezone: 'America/Costa_Rica', profileVersionId: 'p', specHash: 'h' },
      ],
      resourceRevisionIds: ['r2', 'r1'],
      availabilityFactIds: [],
      occupancyDigest: 'd',
      contestStatuses: [
        { contestId: 'b', status: 'PLANNED' },
        { contestId: 'a', status: 'SCHEDULED' },
      ],
    },
    validator: { id: 'test', version: 1 },
    coverage: [...CONFLICT_CODES],
    conflicts,
    ...over,
  }) as ScheduleConflictReport;

describe('the conflict-report contract (ADR-0071 + ADR-0073 B7)', () => {
  it('keeps every ADR-0071 code and adds exactly the six ADR-0073 codes', () => {
    expect(CONFLICT_CODES).toHaveLength(22);
    for (const c of [
      'START_SPACING',
      'CONCURRENT_STARTS_EXCEEDED',
      'UNIT_SPLIT',
      'AVAILABILITY_UNDECLARED',
      'ROUND_SEQUENCE',
      'INCOMPLETE_ASSIGNMENT',
    ] as const)
      expect(CONFLICT_CODES).toContain(c);
    expect(CONFLICT_SEVERITY.SHORT_REST).toBe('ENFORCEMENT');
    expect(CONFLICT_SEVERITY.MAX_CONTESTS_PER_DAY).toBe('ENFORCEMENT');
    expect(CONFLICT_SEVERITY.UNIT_SPLIT).toBe('HARD');
    expect(CONFLICT_SEVERITY.AVAILABILITY_UNDECLARED).toBe('SOFT');
  });

  it('orders by the seven frozen keys', () => {
    const ordered = [
      conflict({ code: 'UNIT_SPLIT', interval: { start: 9, end: 9 } }), // HARD first, start 9
      conflict({ code: 'RESOURCE_OVERLAP', interval: { start: 10, end: 11 } }),
      conflict({ code: 'RESOURCE_OVERLAP', interval: { start: 10, end: 12 } }), // end
      conflict({ code: 'START_SPACING', interval: { start: 10, end: 12 }, resourceIds: [] }), // code
      conflict({ code: 'START_SPACING', interval: { start: 10, end: 12 }, resourceIds: ['r1'] }), // resource
      conflict({
        code: 'START_SPACING',
        interval: { start: 10, end: 12 },
        resourceIds: ['r2'],
        unitKeys: ['u1'],
      }),
      conflict({
        code: 'START_SPACING',
        interval: { start: 10, end: 12 },
        resourceIds: ['r2'],
        unitKeys: ['u2'], // unit keys
      }),
      conflict({
        code: 'PARTICIPANT_OVERLAP',
        interval: { start: 11, end: 12 },
        personIds: ['p1'],
        resourceIds: [],
        unitKeys: [],
        assignmentIds: ['f2'],
      }),
      conflict({
        code: 'PARTICIPANT_OVERLAP',
        interval: { start: 11, end: 12 },
        personIds: ['p2'], // person
        resourceIds: [],
        unitKeys: [],
        assignmentIds: ['f1'],
      }),
      conflict({
        code: 'PARTICIPANT_OVERLAP',
        interval: { start: 11, end: 12 },
        personIds: ['p2'],
        resourceIds: [],
        unitKeys: [],
        assignmentIds: ['f3'], // assignment ids
      }),
      conflict({
        code: 'AVAILABILITY_UNDECLARED',
        severity: 'SOFT',
        interval: { start: 1, end: 2 },
      }),
    ];
    const shuffled = [...ordered].reverse();
    expect(canonicalScheduleReport(report(shuffled)).conflicts).toEqual(
      ordered.map((c) => canonicalScheduleReport(report([c])).conflicts[0]),
    );
  });

  it('a pairwise conflict appears once, never as A/B and B/A', () => {
    const ab = conflict({
      unitKeys: ['u-a', 'u-b'],
      contestIds: ['a', 'b'],
      assignmentIds: ['fa', 'fb'],
    });
    const ba = conflict({
      unitKeys: ['u-b', 'u-a'],
      contestIds: ['b', 'a'],
      assignmentIds: ['fb', 'fa'],
    });
    expect(canonicalScheduleReport(report([ab, ba])).conflicts).toHaveLength(1);
    expect(conflictKey(ab)).toBe(conflictKey(ba));
  });

  it('the hash ignores input order and changes with content', () => {
    const cs = [
      conflict(),
      conflict({ code: 'UNIT_SPLIT', unitKeys: ['x'] }),
      conflict({ code: 'ROUND_SEQUENCE', severity: 'SOFT', entrantIds: ['e1'] }),
    ];
    const h = scheduleReportHash(report(cs));
    fc.assert(
      fc.property(fc.shuffledSubarray(cs, { minLength: 3, maxLength: 3 }), (perm) => {
        expect(scheduleReportHash(report(perm))).toBe(h);
      }),
    );
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(scheduleReportHash(report(cs, { scheduleVersionId: 'v2' }))).not.toBe(h);
    expect(scheduleReportHash(report(cs, { assignmentIds: ['fa'] }))).not.toBe(h);
    expect(scheduleReportHash(report([cs[0] as ScheduleConflict]))).not.toBe(h);
    expect(
      scheduleReportHash(
        report(cs, { coverage: ['RESOURCE_OVERLAP', 'UNIT_SPLIT', 'ROUND_SEQUENCE'] }),
      ),
    ).not.toBe(h);
  });

  it('refuses a fixed-severity mismatch, an unknown code and a conflict outside the coverage', () => {
    expect(() => canonicalScheduleReport(report([conflict({ severity: 'SOFT' })]))).toThrow(
      ScheduleReportError,
    );
    expect(() => canonicalScheduleReport(report([conflict({ code: 'NOPE' as never })]))).toThrow(
      ScheduleReportError,
    );
    expect(() =>
      canonicalScheduleReport(report([conflict()], { coverage: ['UNIT_SPLIT'] })),
    ).toThrow(/outside the report's coverage/);
    expect(() =>
      canonicalScheduleReport(report([conflict({ interval: { start: 1.5, end: 2 } })])),
    ).toThrow(ScheduleReportError);
    // Enforcement-dependent codes accept either severity.
    for (const severity of ['HARD', 'SOFT'] as const)
      expect(
        canonicalScheduleReport(report([conflict({ code: 'SHORT_REST', severity })])).conflicts,
      ).toHaveLength(1);
  });

  it('the verdict counts HARD conflicts and lists SOFT acknowledgement keys', () => {
    const soft = conflict({ code: 'AVAILABILITY_UNDECLARED', severity: 'SOFT' });
    const v = reportVerdict(report([conflict(), soft]));
    expect(v.hard).toBe(1);
    expect(v.softKeys).toEqual([conflictKey(soft)]);
    // A different interval is a different conflict: an acknowledgement never carries over.
    expect(conflictKey({ ...soft, interval: { start: 1_000, end: 2_001 } })).not.toBe(
      conflictKey(soft),
    );
  });
});

// ───────────────────────────── scheduling units (B9) ─────────────────────────────

describe('scheduling-unit keys come from plan, 05D and profile data (ADR-0073 B9)', () => {
  it('a 24-entrant squad is one unit of 24 member contests; the knockout matches are their own units', () => {
    const p = plan('qualifying-knockout', 48, { groupSize: 24, qualifiers: 4 });
    const keys = deriveUnitKeys(facts(p));
    const r1 = p.rounds[0];
    const squads = new Set(r1?.contests.map((c) => keys.get(c.key)));
    expect(squads.size).toBe(2);
    for (const k of squads) expect(k).toMatch(/^partition:s1-r1:t[12]$/);
    expect(r1?.contests.filter((c) => keys.get(c.key) === `partition:s1-r1:t1`)).toHaveLength(24);
    const ladder = p.rounds.filter((r) => r.stageKey !== 's1').flatMap((r) => r.contests);
    for (const c of ladder) expect(keys.get(c.key)).toBe(`contest:${c.key}`);
  });

  it('a later non-dynamic round inherits the same entrant’s plan group', () => {
    const p = plan('multi-round', 8, { rounds: 2, groupSize: 4 });
    const keys = deriveUnitKeys(facts(p));
    const [r1, r2] = p.rounds;
    expect(r2?.contests.every((c) => c.partitionKey === undefined)).toBe(true);
    for (const c of r2?.contests ?? []) {
      const who = c.slots[0]?.participantId;
      const before = r1?.contests.find((x) => x.slots[0]?.participantId === who);
      expect(keys.get(c.key)).toBe(`partition:${r2?.key}:${before?.partitionKey}`);
    }
    expect(new Set(r2?.contests.map((c) => keys.get(c.key))).size).toBe(2);
  });

  it('a dynamic round is regrouped over 05D ordinals by the profile, else each contest is a unit', () => {
    const dyn = (ordinal: number): UnitContestFacts => ({
      contestId: `q${ordinal}`,
      roundId: 'r3',
      roundSequence: 3,
      stageId: 's1',
      grouped: true,
      dynamic: true,
      partitionKey: null,
      participantId: null,
      fieldOrdinal: ordinal,
    });
    const field = [5, 1, 4, 2, 3, 6, 7].map(dyn);
    const asc = deriveUnitKeys(field, { groupSize: 3, order: 'FIELD_ORDINAL_ASC' });
    expect([1, 2, 3, 4, 5, 6, 7].map((o) => asc.get(`q${o}`))).toEqual([
      'regroup:r3:1',
      'regroup:r3:1',
      'regroup:r3:1',
      'regroup:r3:2',
      'regroup:r3:2',
      'regroup:r3:2',
      'regroup:r3:3',
    ]);
    const desc = deriveUnitKeys(field, { groupSize: 3, order: 'FIELD_ORDINAL_DESC' });
    expect([7, 6, 5, 1].map((o) => desc.get(`q${o}`))).toEqual([
      'regroup:r3:1',
      'regroup:r3:1',
      'regroup:r3:1',
      'regroup:r3:3',
    ]);
    // Order of the input never matters.
    expect(
      deriveUnitKeys([...field].reverse(), { groupSize: 3, order: 'FIELD_ORDINAL_ASC' }),
    ).toEqual(asc);
    const none = deriveUnitKeys(field);
    for (const f of field) expect(none.get(f.contestId)).toBe(`contest:${f.contestId}`);
  });

  it('contests outside GROUPED_ENTRANTS stages are their own unit (heats, waves, matches)', () => {
    const p = plan('wave-start', 1200, { waveCapacity: 500 });
    const keys = deriveUnitKeys(facts(p));
    for (const c of p.rounds[0]?.contests ?? []) expect(keys.get(c.key)).toBe(`contest:${c.key}`);
  });
});

// ───────────────────────────── intervals and the baseline validator ─────────────────────────────

describe('concrete intervals: profile defaults at write time, stored values thereafter', () => {
  it('whole seconds only; default end = start + latest plan offset + expected duration', () => {
    expect(isWholeSecond(1_700_000_000_000)).toBe(true);
    expect(isWholeSecond(1_700_000_000_500)).toBe(false);
    expect(defaultExpectedEnd(0, { expectedDurationSeconds: 3_600 }, 0)).toBe(3_600_000);
    expect(defaultExpectedEnd(0, { expectedDurationSeconds: 3_600 }, 1_740)).toBe(5_340_000);
  });

  it('changeover extends blocking only on an EXCLUSIVE resource', () => {
    const a = { startMs: 0, expectedEndMs: 60_000, changeoverSeconds: 600 };
    expect(blockingEnd({ ...a, occupancyMode: 'EXCLUSIVE' })).toBe(660_000);
    expect(blockingEnd({ ...a, occupancyMode: 'SHARED' })).toBe(60_000);
    expect(blockingEnd({ ...a, occupancyMode: null })).toBe(60_000);
  });
});

describe('the 05E-C baseline validator: structural checks only, declared as coverage', () => {
  const golf = SCHEDULING_PROFILE_TEMPLATES.find((t) => t.code === 'golf-course-tee-groups');
  const events = new Map<string, BaselineEvent>([
    [
      'e-profile',
      {
        profile: { versionId: 'pv', spec: golf?.spec as never },
        windowStartMs: 1_000_000,
        windowEndMs: 9_000_000,
      },
    ],
    ['e-free', { profile: null, windowStartMs: null, windowEndMs: null }],
  ]);
  const a = (over: Partial<BaselineAssignment>): BaselineAssignment => ({
    assignmentId: 'f',
    contestId: 'c',
    eventId: 'e-profile',
    unitKey: 'contest:c',
    resourceId: 'r',
    resourceType: 'GOLF_COURSE',
    occupancyMode: 'SHARED',
    startMs: 2_000_000,
    expectedEndMs: 3_000_000,
    changeoverSeconds: 0,
    contest: { contestType: 'SERIES' },
    ...over,
  });
  const run = (as: BaselineAssignment[]) =>
    canonicalScheduleReport(
      baselineScheduleReport({
        competitionId: 'c1',
        scheduleVersionId: 'v1',
        assignments: as,
        events,
        inputs: {
          events: [],
          resourceRevisionIds: [],
          availabilityFactIds: [],
          occupancyDigest: 'd',
          contestStatuses: [],
        },
      }),
    );

  it('declares exactly its three structural codes and never a feasibility code', () => {
    const r = run([a({})]);
    expect(r.coverage).toEqual([...BASELINE_COVERAGE].sort());
    expect(r.conflicts).toEqual([]);
    for (const c of [
      'RESOURCE_OVERLAP',
      'CAPACITY_EXCEEDED',
      'START_SPACING',
      'PARTICIPANT_OVERLAP',
      'SHORT_REST',
      'DEPENDENCY_ORDER',
      'RESOURCE_UNAVAILABLE',
      'MAX_CONTESTS_PER_DAY',
    ])
      expect(r.coverage).not.toContain(c);
  });

  it('overlapping assignments on one resource are NOT a 05E-C conflict', () => {
    expect(
      run([a({ assignmentId: 'f1', contestId: 'c1' }), a({ assignmentId: 'f2', contestId: 'c2' })])
        .conflicts,
    ).toEqual([]);
  });

  it('INCOMPLETE_ASSIGNMENT (SOFT): no expected end, or no resource where the profile needs one', () => {
    const r = run([
      a({ assignmentId: 'f1', expectedEndMs: null }),
      a({ assignmentId: 'f2', resourceId: null, resourceType: null }),
      a({ assignmentId: 'f3', eventId: 'e-free', resourceId: null, resourceType: null }),
    ]);
    // Without an end the anchor is [start, start): it sorts before the full interval of f2.
    expect(r.conflicts.map((c) => [c.code, c.severity, c.assignmentIds, c.actual])).toEqual([
      ['INCOMPLETE_ASSIGNMENT', 'SOFT', ['f1'], 'expectedEnd'],
      ['INCOMPLETE_ASSIGNMENT', 'SOFT', ['f2'], 'resource'],
    ]);
  });

  it('OUTSIDE_EVENT_WINDOW and RESOURCE_TYPE_MISMATCH (HARD) with the governing requirement', () => {
    const r = run([
      a({ assignmentId: 'f1', startMs: 500_000 }),
      a({ assignmentId: 'f2', resourceType: 'TENNIS_COURT' }),
    ]);
    expect(r.conflicts.map((c) => c.code)).toEqual([
      'OUTSIDE_EVENT_WINDOW',
      'RESOURCE_TYPE_MISMATCH',
    ]);
    expect(r.conflicts[1]).toMatchObject({
      requirement: { eventId: 'e-profile', profileVersionId: 'pv', requirementIndex: 0 },
      expected: 'GOLF_COURSE',
      actual: 'TENNIS_COURT',
    });
  });
});

describe('no sport identity in the schedule model', () => {
  it('the new modules never name a sport or branch on one', () => {
    for (const f of ['./report.ts', './units.ts', './assignment.ts']) {
      const src = readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
      expect(src).not.toMatch(
        /tennis|padel|golf|swim|bowling|basketball|wheelchair|cycling|marathon|running|sport\s*===|discipline\s*===|typeCode\s*===/i,
      );
    }
  });
});
