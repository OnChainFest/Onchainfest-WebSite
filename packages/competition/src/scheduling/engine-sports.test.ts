import { describe, expect, it } from 'vitest';
import { CANONICAL_CATALOG, CANONICAL_DESIGN_MATRIX } from '../catalog-manifest';
import type { ContestType, DisciplineVersionSpec } from '../catalog';
import { capabilityIssues, providedCapabilities } from '../capabilities';
import { engineRequirements } from '../format/engine';
import type { AnyFormatEngine, CompetitionFormatEngineV2 } from '../format/engine';
import type { PlanDocumentV2 } from '../format/plan-v2';
import { formatEngine } from '../format/registry';
import type { ResourceType } from '../capabilities';
import { RESOURCE_TYPE_DEFAULT_OCCUPANCY_MODE } from '../resources/resource';
import { evaluateSchedule } from './engine';
import { codes, HOUR, MIN, must, ofCode, T0, World } from './engine.fixture';
import {
  producedContestTypes,
  resolveRequirement,
  schedulingProfileCompatibility,
  type SchedulingProfileSpec,
} from './profile';
import { reportVerdict, scheduleReportHash } from './report';
import { SCHEDULING_PROFILE_TEMPLATES } from './templates';
import { deriveUnitKeys } from './units';

/**
 * ONCF-05E-D across the catalog (ADR-0074 Appendix B): real plans from the canonical format engines
 * for every compatible (sport × modality × format) cell of the design matrix, the canonical
 * SchedulingProfile templates, and resources declared with the per-type default modes. The engine
 * sees only plan, resource, availability and profile DATA — never a sport.
 */

const DAY = 24 * HOUR;
const disciplines = new Map(
  CANONICAL_CATALOG.sports.flatMap((s) => s.disciplines.map((d) => [d.code, d] as const)),
);
const latestSpec = (code: string) => {
  const d = disciplines.get(code);
  if (d === undefined) throw new Error(`unknown discipline ${code}`);
  return d.specs[d.specs.length - 1] as DisciplineVersionSpec;
};
const latestEngine = (code: string): AnyFormatEngine => {
  const f = CANONICAL_CATALOG.formats.find((x) => x.code === code);
  const v = f?.versions[f.versions.length - 1];
  const e = v === undefined ? undefined : formatEngine(v.engineId, v.engineVersion);
  if (e === undefined) throw new Error(`unknown format ${code}`);
  return e;
};
const pid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

function generate(
  format: string,
  n: number,
  kind: 'INDIVIDUAL' | 'TEAM',
  allowed: readonly ContestType[],
  config: Record<string, unknown> = {},
): PlanDocumentV2 {
  const field = Array.from({ length: n }, (_, i) => pid(i + 1));
  return (latestEngine(format) as CompetitionFormatEngineV2).generate({
    eventId: '00000000-0000-4000-8000-0000000000ee',
    participants: field.map((participantId) => ({ participantId, kind })),
    seedOrder: field,
    config,
    allowedContestTypes: allowed,
  });
}

interface Layout {
  readonly w: World;
  /** unit key → its member contest ids, in plan order. */
  readonly units: Map<string, string[]>;
  /** round key → unit keys, in plan order. */
  readonly roundUnits: Map<string, string[]>;
}

/**
 * Builds the evaluation world for a plan and lays it out FEASIBLY with a trivial deterministic
 * arrangement (each round on its own day; EXCLUSIVE units round-robin over k resources, one after
 * another with the stored changeover; SHARED units one per start slot, spaced by the requirement).
 * Extra contests (05D-materialized dynamic rounds) can be appended through `dynamic`.
 */
function layout(
  plan: PlanDocumentV2,
  o: {
    kind: 'INDIVIDUAL' | 'TEAM';
    profile: SchedulingProfileSpec | null;
    resourceType: ResourceType;
    resources?: number;
    capacity?: number;
    dynamic?: readonly {
      roundKey: string;
      ordinal: number;
      occupant: string;
      transitionKey: string;
    }[];
  },
): Layout {
  const w = new World().event('e1', { profile: o.profile });
  const mode = RESOURCE_TYPE_DEFAULT_OCCUPANCY_MODE[o.resourceType];
  const k = mode === 'SHARED' ? 1 : (o.resources ?? 6);
  for (let i = 0; i < k; i++)
    w.resource(`R${i}`, {
      type: o.resourceType,
      mode,
      capacity: o.capacity ?? (mode === 'SHARED' ? 100_000 : 64),
    });
  const participants = new Set<string>();
  const stageOf = new Map(plan.stages.map((s) => [s.key, s]));
  const roundOf = new Map(plan.rounds.map((r) => [r.key, r]));
  const contestsOfStage = (stageKey: string, groupKey?: string, maxRoundSeq?: number) =>
    plan.rounds
      .filter(
        (r) =>
          r.stageKey === stageKey &&
          (groupKey === undefined || r.groupKey === groupKey) &&
          (maxRoundSeq === undefined || r.sequence <= maxRoundSeq),
      )
      .flatMap((r) => r.contests.map((c) => c.key));
  const transitionFeeders = (key: string) => {
    const t = plan.transitions.find((x) => x.key === key);
    if (t === undefined) throw new Error(`no transition ${key}`);
    const after = t.afterRound === undefined ? undefined : roundOf.get(t.afterRound)?.sequence;
    return contestsOfStage(t.fromStage, undefined, after);
  };
  const latestOffset = new Map<string, number>();
  for (const r of plan.rounds) {
    const stage = stageOf.get(r.stageKey);
    for (const c of r.contests) {
      const sole =
        c.slots.length === 1 && c.slots[0]?.source === 'PARTICIPANT' ? c.slots[0] : undefined;
      w.contest(c.key, {
        round: r.key,
        roundSeq: r.sequence,
        stage: r.stageKey,
        stageSeq: stage?.sequence ?? 0,
        grouped: stage?.partition?.method === 'GROUPED_ENTRANTS',
        type: c.contestType,
        roundType: r.roundType,
        primitive: stage?.primitive ?? null,
        partitionKey: c.partitionKey ?? null,
        unitParticipant: sole?.participantId ?? null,
      });
      for (const s of c.slots) {
        if (s.source === 'PARTICIPANT') {
          participants.add(s.participantId as string);
          w.place(c.key, s.slot, { state: 'FIXED', occupant: s.participantId as string });
        } else {
          const feeders =
            s.source === 'WINNER_OF_CONTEST' || s.source === 'LOSER_OF_CONTEST'
              ? [s.contestKey as string]
              : s.source === 'QUALIFIER'
                ? transitionFeeders(s.transitionKey as string)
                : contestsOfStage(s.stageKey as string, s.groupKey);
          w.place(c.key, s.slot, { state: 'UNRESOLVED', feeders, sourceKind: s.source });
        }
      }
      for (const e of c.entries ?? []) {
        participants.add(e.participantId);
        w.place(c.key, e.position, { state: 'FIXED', occupant: e.participantId });
      }
      latestOffset.set(
        c.key,
        Math.max(0, ...(c.entries ?? []).map((e) => e.startOffsetSeconds ?? 0)),
      );
    }
  }
  // 05D-materialized dynamic per-entrant contests (resolved field places).
  for (const d of o.dynamic ?? []) {
    const r = roundOf.get(d.roundKey);
    if (r === undefined) throw new Error(`no round ${d.roundKey}`);
    const stage = stageOf.get(r.stageKey);
    const id = `${d.roundKey}-q${d.ordinal}`;
    w.contest(id, {
      round: r.key,
      roundSeq: r.sequence,
      stage: r.stageKey,
      stageSeq: stage?.sequence ?? 0,
      grouped: stage?.partition?.method === 'GROUPED_ENTRANTS',
      dynamic: true,
      type: 'SERIES',
      roundType: r.roundType,
      primitive: stage?.primitive ?? null,
      unitOrdinal: d.ordinal,
    });
    w.place(id, 1, {
      state: 'RESOLVED',
      occupant: d.occupant,
      feeders: transitionFeeders(d.transitionKey),
      sourceKind: 'QUALIFIER',
    });
    latestOffset.set(id, 0);
  }
  for (const p of [...participants].sort())
    w.entrant(p, o.kind === 'TEAM' ? { kind: 'TEAM', persons: [`${p}-m1`, `${p}-m2`] } : {});

  const keys = deriveUnitKeys(
    w.contests.map((c) => ({
      contestId: c.id,
      roundId: c.roundId,
      roundSequence: c.roundSequence,
      stageId: c.stageId,
      grouped: c.grouped,
      dynamic: c.dynamic,
      partitionKey: c.partitionKey,
      participantId: c.unitParticipantId,
      fieldOrdinal: c.unitFieldOrdinal,
    })),
    o.profile?.regrouping,
  );
  const units = new Map<string, string[]>();
  const roundUnits = new Map<string, string[]>();
  for (const c of w.contests) {
    const key = keys.get(c.id) as string;
    if (!units.has(key)) {
      units.set(key, []);
      roundUnits.set(c.roundId, [...(roundUnits.get(c.roundId) ?? []), key]);
    }
    units.get(key)?.push(c.id);
  }
  const requirement = (contestId: string) => {
    const c = w.contests.find((x) => x.id === contestId);
    if (o.profile === null || c === undefined) return undefined;
    const r = resolveRequirement(o.profile, {
      contestType: c.contestType,
      roundType: c.roundType,
      ...(c.stagePrimitive === null ? {} : { stagePrimitive: c.stagePrimitive }),
    });
    if (!r.ok) throw new Error(`requirement for ${contestId}: ${r.reason}`);
    return r.requirement;
  };

  let dayStart = T0;
  const rounds = [...new Set(w.contests.map((c) => c.roundId))].sort(
    (a, b) =>
      (w.contests.find((c) => c.roundId === a)?.roundSequence ?? 0) -
      (w.contests.find((c) => c.roundId === b)?.roundSequence ?? 0),
  );
  for (const round of rounds) {
    const cursor = new Array<number>(k).fill(dayStart);
    let slot = dayStart;
    let roundEnd = dayStart;
    (roundUnits.get(round) ?? []).forEach((unit, i) => {
      const members = units.get(unit) as string[];
      const req = requirement(members[0] as string);
      const r = i % k;
      const start = mode === 'SHARED' ? slot : (cursor[r] as number);
      const duration =
        ((req?.expectedDurationSeconds ?? 3_600) +
          Math.max(...members.map((m) => latestOffset.get(m) ?? 0))) *
        1000;
      const changeover = req?.changeoverSeconds ?? 0;
      for (const m of members)
        w.assign(m, {
          resource: `R${r}`,
          startMs: start,
          endMs: start + duration,
          changeover,
          unitKey: unit,
        });
      if (mode === 'SHARED') slot += Math.max(req?.startSpacingSeconds ?? 0, 60) * 1000;
      else cursor[r] = start + duration + changeover * 1000;
      roundEnd = Math.max(roundEnd, start + duration + changeover * 1000);
    });
    // The next round starts on a later day, at 08:00, at least 12 hours later.
    dayStart = Math.ceil((roundEnd + 12 * HOUR - 8 * HOUR) / DAY) * DAY + 8 * HOUR;
  }
  return { w, units, roundUnits };
}

/** The first canonical template compatible with this discipline and format, by code. */
function templateFor(spec: DisciplineVersionSpec, format: string) {
  const produced = producedContestTypes(latestEngine(format), spec.allowedContestTypes);
  return [...SCHEDULING_PROFILE_TEMPLATES]
    .sort((a, b) => (a.code < b.code ? -1 : 1))
    .find(
      (t) =>
        schedulingProfileCompatibility(
          t.spec,
          { resourceTypes: spec.capabilities?.resourceTypes ?? [] },
          produced,
        ).length === 0,
    );
}

const cells = CANONICAL_DESIGN_MATRIX.flatMap((s) =>
  s.modalities.flatMap((m) =>
    s.formats
      .filter(
        (f) =>
          capabilityIssues(
            providedCapabilities(latestSpec(m.discipline)),
            engineRequirements(latestEngine(f.format)),
          ).length === 0,
      )
      .map((f) => ({
        sport: s.sport,
        modality: m.name,
        discipline: m.discipline,
        format: f.format,
      })),
  ),
);

describe('every compatible sport × modality × format cell of the catalog (61)', () => {
  it('covers 61 cells across the 8 canonical sports', () => {
    expect(cells).toHaveLength(61);
    expect(new Set(cells.map((c) => c.sport))).toEqual(
      new Set([
        'tennis',
        'padel',
        'running',
        'swimming',
        'cycling',
        'bowling',
        'basketball',
        'golf',
      ]),
    );
    expect(cells.some((c) => c.discipline === 'basketball.wheelchair')).toBe(true);
  });

  it.each(cells)(
    '$sport · $modality · $format: a feasible layout is clean; a collision is caught',
    (cell) => {
      const spec = latestSpec(cell.discipline);
      const kind = spec.participation.participantKinds[0] as 'INDIVIDUAL' | 'TEAM';
      const plan = generate(cell.format, 8, kind, spec.allowedContestTypes);
      const template = templateFor(spec, cell.format);
      const resourceType = (template?.spec.requirements[0]?.resourceType ??
        spec.capabilities?.resourceTypes[0]) as ResourceType;
      const { w, units, roundUnits } = layout(plan, {
        kind,
        profile: template?.spec ?? null,
        resourceType,
      });
      const report = evaluateSchedule(w.input());
      if (template !== undefined) {
        expect(report.conflicts, `${cell.discipline} with ${template.code}`).toEqual([]);
      } else {
        // A catalog-data gap (no template for this resource type): manual scheduling only; the
        // engine never invents a consumption and says so.
        expect(reportVerdict(report).hard).toBe(0);
        expect(new Set(codes(report))).toEqual(new Set(['INCOMPLETE_ASSIGNMENT']));
        expect(new Set(report.conflicts.map((c) => c.actual))).toEqual(new Set(['consumption']));
      }

      // Perturbation: the second unit of a round starts one minute after the first, on its resource.
      const round = [...roundUnits.values()].find((us) => us.length >= 2);
      if (round === undefined) return; // a single-unit event (one mass start) has nothing to collide
      const [u, v] = round as [string, string];
      const first = w.assignments.find((a) => a.contestId === (units.get(u) as string[])[0]);
      if (first === undefined) throw new Error('unscheduled');
      const mode = RESOURCE_TYPE_DEFAULT_OCCUPANCY_MODE[resourceType];
      const spacing = template?.spec.requirements[0]?.startSpacingSeconds;
      if (mode === 'SHARED' && spacing === undefined) return;
      for (const m of units.get(v) as string[]) {
        const i = w.assignments.findIndex((a) => a.contestId === m);
        const a = w.assignments[i] as (typeof w.assignments)[number];
        const length = (a.expectedEndMs as number) - a.startMs;
        w.assignments[i] = {
          ...a,
          resourceId: first.resourceId,
          startMs: first.startMs + MIN,
          expectedEndMs: first.startMs + MIN + length,
        };
      }
      expect(codes(evaluateSchedule(w.input()))).toContain(
        mode === 'EXCLUSIVE' ? 'RESOURCE_OVERLAP' : 'START_SPACING',
      );
    },
  );
});

describe('bowling (ten-pin): squads are units over EXCLUSIVE lane pairs', () => {
  const bowling = SCHEDULING_PROFILE_TEMPLATES.find((t) => t.code === 'bowling-lane-pair-blocks');
  const singles = latestSpec('bowling.tenpin.singles');

  it('a 24-bowler squad spans six 4-seat lane pairs at one start; block 2 inherits the squad', () => {
    const plan = generate('multi-round', 24, 'INDIVIDUAL', singles.allowedContestTypes, {
      rounds: 2,
      groupSize: 24,
    });
    const { w, units } = layout(plan, {
      kind: 'INDIVIDUAL',
      profile: bowling?.spec ?? null,
      resourceType: 'BOWLING_LANE_PAIR',
      resources: 6,
      capacity: 4,
    });
    // Spread each squad four per pair (the layout put the whole squad on one pair).
    for (const [, members] of units)
      members.forEach((m, i) => {
        const j = w.assignments.findIndex((a) => a.contestId === m);
        w.assignments[j] = { ...must(w.assignments[j]), resourceId: `R${Math.floor(i / 4)}` };
      });
    expect([...units.keys()].sort()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^partition:.*-r1:t1$/),
        expect.stringMatching(/^partition:.*-r2:t1$/),
      ]),
    );
    expect(units.size).toBe(2);
    expect(codes(evaluateSchedule(w.input()))).toEqual([]);
    // A fifth bowler on one pair exceeds its seats (R3).
    const j = w.assignments.findIndex((a) => a.resourceId === 'R1');
    w.assignments[j] = { ...must(w.assignments[j]), resourceId: 'R0' };
    expect(ofCode(evaluateSchedule(w.input()), 'CAPACITY_EXCEEDED')[0]).toMatchObject({
      expected: 4,
      actual: 5,
    });
  });

  it('re-paired lanes are caught through keys, also within one squad (lane 12 used twice)', () => {
    const plan = generate('multi-round', 8, 'INDIVIDUAL', singles.allowedContestTypes, {
      rounds: 1,
      groupSize: 8,
    });
    const { w, units } = layout(plan, {
      kind: 'INDIVIDUAL',
      profile: bowling?.spec ?? null,
      resourceType: 'BOWLING_LANE_PAIR',
      resources: 2,
      capacity: 4,
    });
    w.resources.splice(0, 2);
    w.resource('R0', { type: 'BOWLING_LANE_PAIR', capacity: 4, keys: ['lane-11', 'lane-12'] });
    w.resource('R1', { type: 'BOWLING_LANE_PAIR', capacity: 4, keys: ['lane-12', 'lane-13'] });
    const members = [...units.values()][0] as string[];
    members.forEach((m, i) => {
      const j = w.assignments.findIndex((a) => a.contestId === m);
      w.assignments[j] = { ...must(w.assignments[j]), resourceId: i < 4 ? 'R0' : 'R1' };
    });
    const ex = ofCode(evaluateSchedule(w.input()), 'EXCLUSIVITY_CONFLICT');
    expect(ex).toHaveLength(1);
    expect(ex[0]?.unitKeys).toHaveLength(1);
  });

  it('after a cut, the template declares no regrouping: each post-cut contest is its own unit', () => {
    expect(bowling?.spec.regrouping).toBeUndefined();
    const plan = generate('multi-round', 8, 'INDIVIDUAL', singles.allowedContestTypes, {
      rounds: 2,
      groupSize: 4,
      cutAfterRound: 1,
      cutTopN: 4,
    });
    const r2 = plan.rounds.find((r) => r.dynamicEntry !== undefined);
    const t = r2?.dynamicEntry?.transitionKey as string;
    const { w, units } = layout(plan, {
      kind: 'INDIVIDUAL',
      profile: bowling?.spec ?? null,
      resourceType: 'BOWLING_LANE_PAIR',
      resources: 4,
      capacity: 4,
      dynamic: [1, 2, 3, 4].map((ordinal) => ({
        roundKey: r2?.key as string,
        ordinal,
        occupant: pid(ordinal),
        transitionKey: t,
      })),
    });
    expect([...units.keys()].filter((u) => u.startsWith('contest:'))).toHaveLength(4);
    expect([...units.keys()].some((u) => u.startsWith('regroup:'))).toBe(false);
    expect(codes(evaluateSchedule(w.input()))).toEqual([]);
  });
});

describe('golf: tee groups on a SHARED course, 600 s spacing, two tees, regroup after the cut', () => {
  const golf = SCHEDULING_PROFILE_TEMPLATES.find((t) => t.code === 'golf-course-tee-groups');
  const individual = latestSpec('golf.individual');

  function tournament(sameDay = false) {
    const plan = generate('multi-round', 12, 'INDIVIDUAL', individual.allowedContestTypes, {
      rounds: 3,
      groupSize: 3,
      cutAfterRound: 2,
      cutTopN: 6,
    });
    const r3 = plan.rounds.find((r) => r.dynamicEntry !== undefined);
    const t = r3?.dynamicEntry?.transitionKey as string;
    const l = layout(plan, {
      kind: 'INDIVIDUAL',
      profile: golf?.spec ?? null,
      resourceType: 'GOLF_COURSE',
      dynamic: [1, 2, 3, 4, 5, 6].map((ordinal) => ({
        roundKey: r3?.key as string,
        ordinal,
        occupant: pid(ordinal),
        transitionKey: t,
      })),
    });
    if (sameDay) {
      // Move round 3 onto round 2's local date, after round 2 ends (still ordered, lead respected).
      const r2Start = Math.min(
        ...l.w.assignments
          .filter((a) => l.w.contests.find((c) => c.id === a.contestId)?.roundSequence === 2)
          .map((a) => a.startMs),
      );
      const r3Ids = new Set(l.w.contests.filter((c) => c.dynamic).map((c) => c.id));
      const r3First = Math.min(
        ...l.w.assignments.filter((x) => r3Ids.has(x.contestId)).map((x) => x.startMs),
      );
      for (let i = 0; i < l.w.assignments.length; i++) {
        const a = l.w.assignments[i] as (typeof l.w.assignments)[number];
        if (!r3Ids.has(a.contestId)) continue;
        const start = r2Start + 5 * HOUR + (a.startMs - r3First);
        l.w.assignments[i] = { ...a, startMs: start, expectedEndMs: start + 4 * HOUR };
      }
    }
    return l;
  }

  it('round-1 tee groups, inherited round-2 groups, regrouped {3, DESC} post-cut groups: clean', () => {
    const { w, units } = tournament();
    const keys = [...units.keys()];
    expect(keys.filter((k) => k.startsWith('partition:') && k.includes('-r1:'))).toHaveLength(4);
    expect(keys.filter((k) => k.startsWith('partition:') && k.includes('-r2:'))).toHaveLength(4);
    expect(keys.filter((k) => k.startsWith('regroup:'))).toHaveLength(2);
    expect(w.resources.map((r) => r.typeCode)).toEqual(['GOLF_COURSE']);
    expect(codes(evaluateSchedule(w.input()))).toEqual([]);
  });

  it('two groups off two tees in one slot are fine; a third, or a 300 s interval, is not', () => {
    const { w, roundUnits, units } = tournament();
    const r1 = [...roundUnits.values()][0] as string[];
    const startOf = (u: string) =>
      w.assignments.find((a) => a.contestId === (units.get(u) as string[])[0])?.startMs as number;
    const move = (u: string, to: number) => {
      for (const m of units.get(u) as string[]) {
        const i = w.assignments.findIndex((a) => a.contestId === m);
        const a = w.assignments[i] as (typeof w.assignments)[number];
        w.assignments[i] = { ...a, startMs: to, expectedEndMs: to + 4 * HOUR };
      }
    };
    const t1 = startOf(r1[0] as string);
    move(r1[1] as string, t1);
    move(r1[2] as string, t1 + 20 * MIN);
    move(r1[3] as string, t1 + 30 * MIN);
    expect(codes(evaluateSchedule(w.input()))).toEqual([]);
    move(r1[2] as string, t1);
    expect(ofCode(evaluateSchedule(w.input()), 'CONCURRENT_STARTS_EXCEEDED')[0]).toMatchObject({
      expected: 2,
      actual: 3,
    });
    move(r1[2] as string, t1 + 5 * MIN);
    expect(ofCode(evaluateSchedule(w.input()), 'START_SPACING')[0]).toMatchObject({
      expected: 600,
      actual: 300,
    });
  });

  it('the post-cut round on round 2’s day: HARD daily-limit conflict for each post-cut player', () => {
    const r = evaluateSchedule(tournament(true).w.input());
    const daily = ofCode(r, 'MAX_CONTESTS_PER_DAY');
    expect(daily).toHaveLength(6);
    for (const c of daily)
      expect(c).toMatchObject({ severity: 'HARD', certainty: 'CERTAIN', expected: 1, actual: 2 });
  });
});

describe('performance at realistic sizes (sweeps and indexes, no quadratic blow-up)', () => {
  it(
    '5 000 assignments, 500 entrants, 50 courts: clean, deterministic, fast',
    { timeout: 60_000 },
    () => {
      const w = new World().event('e1', {
        profile: {
          specVersion: 1,
          requirements: [
            {
              selector: {},
              resourceType: 'TENNIS_COURT',
              capacityUnit: 'CONTEST',
              expectedDurationSeconds: 5_400,
              changeoverSeconds: 600,
              rest: { minimumSeconds: 3_600, enforcement: 'SOFT' },
              maxUnitsPerEntrantPerDay: { value: 2, enforcement: 'SOFT' },
            },
          ],
        },
      });
      for (let c = 0; c < 50; c++) w.resource(`court-${c}`);
      for (let e = 0; e < 500; e++) w.entrant(`ent-${e}`);
      // 20 rounds (one per day); each entrant plays once per round.
      for (let r = 0; r < 20; r++)
        for (let m = 0; m < 250; m++) {
          const id = `m-${r}-${m}`;
          // Each entrant plays exactly once per round: a ∈ 0…249 meets b ∈ 250…499 (rotating).
          const a = m;
          const b = 250 + ((m + r) % 250);
          w.contest(id, { round: `r${r}`, roundSeq: r + 1, entrants: [`ent-${a}`, `ent-${b}`] });
          const start = T0 + r * DAY + Math.floor(m / 50) * 2 * HOUR;
          w.assign(id, {
            resource: `court-${m % 50}`,
            startMs: start,
            endMs: start + 90 * MIN,
            changeover: 600,
          });
        }
      const input = w.input();
      const t0 = performance.now();
      const report = evaluateSchedule(input);
      const elapsed = performance.now() - t0;
      expect(input.assignments).toHaveLength(5_000);
      expect(report.conflicts).toEqual([]);
      expect(scheduleReportHash(evaluateSchedule(input))).toBe(scheduleReportHash(report));
      expect(elapsed).toBeLessThan(15_000);
    },
  );

  it(
    'a 128-entrant knockout: possible-occupant closure over the whole bracket stays fast',
    { timeout: 60_000 },
    () => {
      const plan = generate('single-elimination', 128, 'INDIVIDUAL', ['MATCH']);
      const template = SCHEDULING_PROFILE_TEMPLATES.find((t) => t.code === 'tennis-court-match');
      const { w } = layout(plan, {
        kind: 'INDIVIDUAL',
        profile: template?.spec ?? null,
        resourceType: 'TENNIS_COURT',
        resources: 16,
      });
      const t0 = performance.now();
      const report = evaluateSchedule(w.input());
      expect(report.conflicts).toEqual([]);
      expect(performance.now() - t0).toBeLessThan(10_000);
    },
  );
});
