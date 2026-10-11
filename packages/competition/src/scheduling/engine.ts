import { compareUtf16, type CanonicalValue } from '@br/canonical';
import type { ContestType } from '../catalog';
import type { RoundType } from '../format/engine';
import type { StagePrimitive } from '../format/plan-v2';
import type { ContestStatus } from '../lifecycle';
import {
  classifyExpanded,
  expandAvailability,
  type AvailabilityExpansion,
  type AvailabilityFact,
} from '../resources/availability';
import type { Interval } from '../resources/interval';
import { OCCUPANCY_MODES, sharesSpace, type OccupancyMode } from '../resources/resource';
import { localDateOf } from '../resources/zoned';
import {
  resolveRequirement,
  type SchedulingProfileSpec,
  type SchedulingRequirement,
} from './profile';
import {
  canonicalConflict,
  canonicalScheduleReport,
  CONFLICT_CODES,
  conflictKey,
  scheduleDigest,
  type ConflictCertainty,
  type ConflictCode,
  type ScheduleConflict,
  type ScheduleConflictReport,
} from './report';
import { deriveUnitKeys, type UnitContestFacts } from './units';

/**
 * The ONCF-05E-D conflict / feasibility engine (ADR-0071, ADR-0073, ADR-0074): the pure function
 *
 *     evaluateSchedule(input) → ScheduleConflictReport (reportVersion 2, canonical)
 *
 * It JUDGES one schedule version's concrete content; it never schedules, moves, proposes, writes or
 * publishes. No database, clock, randomness, environment or options: a caller can never narrow its
 * coverage. Malformed state is a `ScheduleEvaluationError` (no report), never a conflict (D16).
 *
 * Semantics, by ADR-0074 decision:
 *   D3  exact epoch-millisecond, half-open arithmetic; report instants are floor(ms / 1000)
 *   D4  CANCELLED / VOID contests are excluded; a conflict whose contests are all settled
 *       (IN_PROGRESS / COMPLETED) is not reported, except LOCKED_ASSIGNMENT_VIOLATION
 *   D5  units recomputed with `deriveUnitKeys`; UNIT_SPLIT reasons
 *   D6  R1–R5 on the STORED occupancy mode only; R4 also within one unit
 *   D7  start events on SHARED resources (max spacing, min concurrency)
 *   D8  DECLARED / UNRESTRICTED availability
 *   D10 participants, possible occupants, same-round rule, rest, daily limits
 *   D11 dependency order and round sequence
 *   D12 stale occupants and started-contest moves
 *   D13 per-code emission; conflict keys unique within a report
 * No rule branches on a sport, discipline, format engine or resource type (R5 compares the declared
 * type with the requirement's declared type — data matching, not branching).
 */

export const CONFLICT_ENGINE = { id: 'br:schedule-conflict-engine', version: 1 } as const;

/** Codes with no declarative input in profile spec v1 (ADR-0074 D15): never evaluated. */
export const ENGINE_UNCOVERED_CODES: readonly ConflictCode[] = [
  'LONG_WAIT',
  'SEQUENCING_INEFFICIENCY',
  'UNDERUSED_RESOURCE',
];
/** The engine's coverage: ADR-0071 + ADR-0073 minus the three of D15 (19 codes). */
export const ENGINE_COVERAGE: readonly ConflictCode[] = CONFLICT_CODES.filter(
  (c) => !ENGINE_UNCOVERED_CODES.includes(c),
);

/** Schema id of the version-2 occupancy digest (place, source kind, 05D state, occupant, fact). */
export const OCCUPANCY_DIGEST_SCHEMA = 'br:schedule-occupancy-states';

/** Malformed input: a broken invariant, never a scheduling conflict (ADR-0074 D16). */
export class ScheduleEvaluationError extends Error {}

const CONTEST_STATUSES: readonly ContestStatus[] = [
  'PLANNED',
  'SCHEDULED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'VOID',
];

/** FIXED = a plan PARTICIPANT slot or field entry; the others are 05D target states (on read). */
export type PlaceState = 'FIXED' | 'UNRESOLVED' | 'RESOLVED' | 'VACANT' | 'STALE' | 'OVERRIDDEN';
const PLACE_STATES: readonly PlaceState[] = [
  'FIXED',
  'UNRESOLVED',
  'RESOLVED',
  'VACANT',
  'STALE',
  'OVERRIDDEN',
];

export interface EvaluationAssignment {
  /** The assignment fact id (opaque; 05E-E may pass synthetic, unique ids). */
  readonly id: string;
  readonly contestId: string;
  readonly resourceId: string | null;
  readonly startMs: number;
  readonly expectedEndMs: number | null;
  readonly changeoverSeconds: number;
  /** The unit key recorded at write time (NULL for migrated facts). */
  readonly recordedUnitKey: string | null;
}

export interface EvaluationContest {
  readonly id: string;
  readonly eventId: string;
  readonly roundId: string;
  readonly roundSequence: number;
  readonly stageId: string | null;
  /** 0 for contests outside a stage (v1 plans). */
  readonly stageSequence: number;
  /** The stage's logistic partition method is GROUPED_ENTRANTS. */
  readonly grouped: boolean;
  readonly dynamic: boolean;
  readonly contestType: ContestType;
  readonly roundType: RoundType;
  readonly stagePrimitive: StagePrimitive | null;
  /** Plan sequence. */
  readonly sequence: number;
  readonly partitionKey: string | null;
  readonly status: ContestStatus;
  /** Unit-derivation facts (exactly as 05E-C records unit keys): the sole PARTICIPANT slot's entrant… */
  readonly unitParticipantId: string | null;
  /** …and the sole QUALIFIER slot's 05D field ordinal. */
  readonly unitFieldOrdinal: number | null;
  /** Feeder contests (05D plan edges): every contest whose results decide one of its places. */
  readonly feeders: readonly string[];
}

export interface EvaluationPlace {
  readonly contestId: string;
  readonly place: number;
  readonly sourceKind: string;
  readonly state: PlaceState;
  /** The current occupant (FIXED, RESOLVED, OVERRIDDEN, and STALE's still-recorded occupant). */
  readonly occupantId: string | null;
  /** The current 05D fact id, when one exists. */
  readonly factId: string | null;
  /** The contests this place's possible occupants come from (empty for FIXED places). */
  readonly feeders: readonly string[];
}

export interface EvaluationEntrant {
  readonly id: string;
  readonly kind: 'INDIVIDUAL' | 'TEAM';
  /** The athlete, or a team's frozen roster athletes (ADR-0057; empty when none was frozen). */
  readonly personIds: readonly string[];
}

export interface EvaluationEvent {
  readonly id: string;
  readonly timezone: string;
  readonly windowStartMs: number | null;
  readonly windowEndMs: number | null;
  readonly profile: {
    readonly versionId: string;
    readonly specHash: string;
    readonly spec: SchedulingProfileSpec;
  } | null;
}

export interface EvaluationResource {
  readonly id: string;
  readonly revisionId: string;
  readonly typeCode: string;
  /** The stored, declared mode of the revision in force — the only source of exclusivity. */
  readonly occupancyMode: OccupancyMode;
  readonly capacity: number;
  readonly exclusivityKeys: readonly string[];
  /** Resolved zone of the resource's availability layer (its own, else the competition's). */
  readonly zone: string;
  readonly status: 'ACTIVE' | 'RETIRED';
}

export interface EvaluationAvailabilityFact {
  readonly id: string;
  /** NULL = competition-wide. */
  readonly resourceId: string | null;
  readonly fact: AvailabilityFact;
}

export interface ScheduleEvaluationInput {
  readonly competitionId: string;
  readonly competitionTimezone: string;
  readonly scheduleVersionId: string;
  /** Every current fact id of the version, removals included (the report's content watermark). */
  readonly watermark: readonly string[];
  /** The version's live (non-removed) assignments. */
  readonly assignments: readonly EvaluationAssignment[];
  /** The base PUBLISHED version's live assignments (started-contest moves, D12). */
  readonly baseAssignments: readonly EvaluationAssignment[];
  /** Every contest of the competition. */
  readonly contests: readonly EvaluationContest[];
  readonly places: readonly EvaluationPlace[];
  readonly entrants: readonly EvaluationEntrant[];
  readonly events: readonly EvaluationEvent[];
  readonly resources: readonly EvaluationResource[];
  readonly availability: readonly EvaluationAvailabilityFact[];
}

// ───────────────────────────── preparation ─────────────────────────────

interface Req {
  readonly requirement: SchedulingRequirement;
  readonly ref: { eventId: string; profileVersionId: string; requirementIndex: number };
}

interface Live {
  readonly a: EvaluationAssignment;
  readonly contest: EvaluationContest;
  readonly event: EvaluationEvent;
  readonly req: Req | null;
  readonly unitKey: string;
  readonly resource: EvaluationResource | null;
  /** Occupancy O, or null without an expected end. */
  readonly O: Interval | null;
  /** Blocking B (O + changeover on EXCLUSIVE), or null without an expected end. */
  readonly B: Interval | null;
}

const fail = (message: string): never => {
  throw new ScheduleEvaluationError(message);
};
const isMs = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);
const byStr = (a: string, b: string) => compareUtf16(a, b);
const sortedUnique = (xs: Iterable<string>): string[] => [...new Set(xs)].sort(byStr);
const sec = (ms: number) => Math.floor(ms / 1000);
const overlap = (x: Interval, y: Interval) => x.start < y.end && y.start < x.end;
const SETTLED = new Set<ContestStatus>(['IN_PROGRESS', 'COMPLETED']);
const EXCLUDED = new Set<ContestStatus>(['CANCELLED', 'VOID']);
const isVacant = (p: EvaluationPlace) =>
  p.state === 'VACANT' || (p.state === 'OVERRIDDEN' && p.occupantId === null);
const isCertain = (p: EvaluationPlace) =>
  p.state === 'FIXED' ||
  ((p.state === 'RESOLVED' || p.state === 'OVERRIDDEN') && p.occupantId !== null);

function index<T>(xs: readonly T[], key: (x: T) => string, what: string): Map<string, T> {
  const m = new Map<string, T>();
  for (const x of xs) {
    const k = key(x);
    if (m.has(k)) fail(`duplicate ${what} ${k}`);
    m.set(k, x);
  }
  return m;
}

function group<T>(xs: Iterable<T>, key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = m.get(k);
    if (list === undefined) m.set(k, [x]);
    else list.push(x);
  }
  return m;
}

/** Map entries in key order (never insertion or hash order). */
const ordered = <V>(m: ReadonlyMap<string, V>): [string, V][] =>
  [...m.entries()].sort(([a], [b]) => byStr(a, b));

class Context {
  readonly contests: Map<string, EvaluationContest>;
  readonly events: Map<string, EvaluationEvent>;
  readonly resources: Map<string, EvaluationResource>;
  readonly entrants: Map<string, EvaluationEntrant>;
  readonly placesOf: Map<string, EvaluationPlace[]>;
  readonly unitOf = new Map<string, string>();
  readonly live: Live[] = [];
  readonly liveByContest = new Map<string, Live>();
  readonly liveById = new Map<string, Live>();
  /** Anchoring interval per involved assignment id (draft and base). */
  readonly anchorOf = new Map<string, Interval>();
  readonly membersOf: Map<string, EvaluationContest[]>;

  readonly input: ScheduleEvaluationInput;

  constructor(input: ScheduleEvaluationInput) {
    this.input = input;
    this.contests = index(input.contests, (c) => c.id, 'contest');
    this.events = index(input.events, (e) => e.id, 'event');
    this.resources = index(input.resources, (r) => r.id, 'resource');
    this.entrants = index(input.entrants, (e) => e.id, 'entrant');
    // An individual is exactly its athlete. A team's persons are its frozen roster, which teams
    // locked before rosters were frozen (ADR-0057) do not have: they keep entrant-level checks only.
    for (const e of input.entrants)
      if (
        (e.kind !== 'INDIVIDUAL' && e.kind !== 'TEAM') ||
        (e.kind === 'INDIVIDUAL' && e.personIds.length !== 1)
      )
        fail(`entrant ${e.id} has no valid persons`);
    for (const r of input.resources) {
      if (!OCCUPANCY_MODES.includes(r.occupancyMode))
        fail(`resource ${r.id} has no valid occupancy mode`);
      if (!Number.isSafeInteger(r.capacity) || r.capacity < 1)
        fail(`resource ${r.id} has an invalid capacity`);
      if (r.status !== 'ACTIVE' && r.status !== 'RETIRED')
        fail(`resource ${r.id} has an invalid status`);
    }
    for (const f of input.availability)
      if (f.resourceId !== null && !this.resources.has(f.resourceId))
        fail(`availability fact ${f.id} names an unknown resource`);
    index(input.availability, (f) => f.id, 'availability fact');
    for (const c of input.contests) {
      if (!this.events.has(c.eventId)) fail(`contest ${c.id} names an unknown event`);
      if (!CONTEST_STATUSES.includes(c.status)) fail(`contest ${c.id} has an invalid status`);
      for (const f of c.feeders)
        if (!this.contests.has(f)) fail(`contest ${c.id} names an unknown feeder ${f}`);
    }
    index(input.places, (p) => `${p.contestId}#${p.place}`, 'place');
    for (const p of input.places) {
      if (!this.contests.has(p.contestId)) fail(`a place names an unknown contest ${p.contestId}`);
      if (!PLACE_STATES.includes(p.state)) fail(`place ${p.contestId}#${p.place} has no state`);
      if (p.occupantId !== null && !this.entrants.has(p.occupantId))
        fail(`place ${p.contestId}#${p.place} names an unknown entrant`);
      if (p.state === 'FIXED' && p.occupantId === null)
        fail(`fixed place ${p.contestId}#${p.place} has no entrant`);
      for (const f of p.feeders)
        if (!this.contests.has(f)) fail(`place ${p.contestId}#${p.place} names an unknown feeder`);
    }
    this.placesOf = group(
      [...input.places].sort((a, b) => byStr(a.contestId, b.contestId) || a.place - b.place),
      (p) => p.contestId,
    );
    this.assertAcyclic();

    // Units (ADR-0073 B9, ADR-0074 D5): recomputed per event with the 05E-C derivation.
    for (const [eventId, contests] of ordered(group(input.contests, (c) => c.eventId))) {
      const ev = this.events.get(eventId) as EvaluationEvent;
      const facts: UnitContestFacts[] = [...contests]
        .sort((a, b) => byStr(a.id, b.id))
        .map((c) => ({
          contestId: c.id,
          roundId: c.roundId,
          roundSequence: c.roundSequence,
          stageId: c.stageId,
          grouped: c.grouped,
          dynamic: c.dynamic,
          partitionKey: c.partitionKey,
          participantId: c.unitParticipantId,
          fieldOrdinal: c.unitFieldOrdinal,
        }));
      for (const [contestId, key] of deriveUnitKeys(facts, ev.profile?.spec.regrouping))
        this.unitOf.set(contestId, key);
    }
    this.membersOf = group(
      [...input.contests].filter((c) => !EXCLUDED.has(c.status)).sort(this.compareContests),
      (c) => this.unitOf.get(c.id) as string,
    );

    index(input.assignments, (a) => a.id, 'assignment');
    index(input.assignments, (a) => a.contestId, 'current assignment for contest');
    index(input.baseAssignments, (a) => a.contestId, 'base assignment for contest');
    for (const a of [...input.assignments, ...input.baseAssignments]) {
      if (!this.contests.has(a.contestId)) fail(`assignment ${a.id}: unknown contest`);
      if (!isMs(a.startMs) || a.startMs < 0) fail(`assignment ${a.id}: invalid start`);
      if (a.expectedEndMs !== null && (!isMs(a.expectedEndMs) || a.expectedEndMs <= a.startMs))
        fail(`assignment ${a.id}: the expected end must follow the start`);
      if (!Number.isSafeInteger(a.changeoverSeconds) || a.changeoverSeconds < 0)
        fail(`assignment ${a.id}: invalid changeover`);
      const resource =
        a.resourceId === null
          ? null
          : (this.resources.get(a.resourceId) ?? fail(`assignment ${a.id}: unknown resource`));
      const O = a.expectedEndMs === null ? null : { start: a.startMs, end: a.expectedEndMs };
      const B =
        O === null
          ? null
          : resource?.occupancyMode === 'EXCLUSIVE'
            ? { start: O.start, end: O.end + a.changeoverSeconds * 1000 }
            : O;
      this.anchorOf.set(a.id, B ?? { start: a.startMs, end: a.startMs });
    }
    for (const a of [...input.assignments].sort((x, y) => byStr(x.contestId, y.contestId))) {
      const contest = this.contests.get(a.contestId) as EvaluationContest;
      if (EXCLUDED.has(contest.status)) continue;
      const event = this.events.get(contest.eventId) as EvaluationEvent;
      const resource = a.resourceId === null ? null : (this.resources.get(a.resourceId) ?? null);
      const B = this.anchorOf.get(a.id) as Interval;
      const O = a.expectedEndMs === null ? null : { start: a.startMs, end: a.expectedEndMs };
      const l: Live = {
        a,
        contest,
        event,
        req: this.requirement(contest, event),
        unitKey: this.unitOf.get(contest.id) as string,
        resource,
        O,
        B: O === null ? null : B,
      };
      this.live.push(l);
      this.liveByContest.set(contest.id, l);
      this.liveById.set(a.id, l);
    }
  }

  /** The frozen contest order: event, stage, round, plan sequence, id. */
  readonly compareContests = (a: EvaluationContest, b: EvaluationContest): number =>
    byStr(a.eventId, b.eventId) ||
    a.stageSequence - b.stageSequence ||
    a.roundSequence - b.roundSequence ||
    a.sequence - b.sequence ||
    byStr(a.id, b.id);

  private requirement(c: EvaluationContest, ev: EvaluationEvent): Req | null {
    if (ev.profile === null) return null;
    const r = resolveRequirement(ev.profile.spec, {
      contestType: c.contestType,
      roundType: c.roundType,
      ...(c.stagePrimitive === null ? {} : { stagePrimitive: c.stagePrimitive }),
    });
    if (!r.ok) return fail(`contest ${c.id}: requirement resolution ${r.reason}`);
    return {
      requirement: r.requirement,
      ref: { eventId: ev.id, profileVersionId: ev.profile.versionId, requirementIndex: r.index },
    };
  }

  /** The plan graph (contest → feeders, place → feeders) must be a DAG. */
  private assertAcyclic() {
    const next = new Map<string, Set<string>>();
    for (const c of this.input.contests) next.set(c.id, new Set(c.feeders));
    for (const p of this.input.places)
      for (const f of p.feeders) (next.get(p.contestId) as Set<string>).add(f);
    const state = new Map<string, 1 | 2>();
    for (const start of [...next.keys()].sort(byStr)) {
      if (state.has(start)) continue;
      const stack: [string, string[]][] = [[start, [...(next.get(start) ?? [])].sort(byStr)]];
      state.set(start, 1);
      while (stack.length > 0) {
        const top = stack[stack.length - 1] as [string, string[]];
        const child = top[1].shift();
        if (child === undefined) {
          state.set(top[0], 2);
          stack.pop();
        } else if (state.get(child) === 1) fail(`the plan graph has a cycle through ${child}`);
        else if (!state.has(child)) {
          state.set(child, 1);
          stack.push([child, [...(next.get(child) ?? [])].sort(byStr)]);
        }
      }
    }
  }

  isSettled = (contestId: string) =>
    SETTLED.has((this.contests.get(contestId) as EvaluationContest).status);

  // Possible occupants: the full transitive closure over the plan graph (ADR-0073 B8).
  private readonly closure = new Map<string, readonly string[]>();
  possibleOfContest(contestId: string): readonly string[] {
    const hit = this.closure.get(contestId);
    if (hit !== undefined) return hit;
    const out = new Set<string>();
    for (const p of this.placesOf.get(contestId) ?? []) for (const e of this.ofPlace(p)) out.add(e);
    const list = [...out].sort(byStr);
    this.closure.set(contestId, list);
    return list;
  }
  ofPlace(p: EvaluationPlace): readonly string[] {
    if (isCertain(p)) return [p.occupantId as string];
    if (isVacant(p)) return [];
    const out = new Set<string>();
    for (const f of p.feeders) for (const e of this.possibleOfContest(f)) out.add(e);
    return [...out].sort(byStr);
  }
}

// ───────────────────────────── emission ─────────────────────────────

type Draft = Omit<ScheduleConflict, 'interval' | 'severity'> & {
  readonly severity?: ScheduleConflict['severity'];
};

class Emitter {
  private readonly conflicts: ScheduleConflict[] = [];
  private readonly keys = new Set<string>();
  /** Per-assignment INCOMPLETE_ASSIGNMENT reasons (one conflict per assignment, D13). */
  private readonly incomplete = new Map<string, { reasons: Set<string>; contests: Set<string> }>();

  private readonly ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  /**
   * Records one conflict. Unless `always`, a conflict whose contests are all settled is history
   * nobody can change and is not reported (D4).
   */
  emit(d: Draft, always = false) {
    if (!always && d.contestIds.every((c) => this.ctx.isSettled(c))) return;
    const anchors = d.assignmentIds.map((id) => this.ctx.anchorOf.get(id) as Interval);
    const first = anchors.sort((x, y) => x.start - y.start || x.end - y.end)[0];
    if (first === undefined) return fail(`${d.code} without an involved assignment`);
    const severity = d.severity ?? (FIXED_SEVERITY[d.code] as 'HARD' | 'SOFT');
    const conflict = canonicalConflict({
      ...d,
      severity,
      interval: { start: sec(first.start), end: sec(first.end) },
    } as ScheduleConflict);
    const key = conflictKey(conflict);
    if (this.keys.has(key)) fail(`conflict-key collision on ${d.code}`);
    this.keys.add(key);
    this.conflicts.push(conflict);
  }

  incompleteReason(l: Live, reason: string, contests: readonly string[] = []) {
    const hit = this.incomplete.get(l.a.id) ?? { reasons: new Set(), contests: new Set() };
    hit.reasons.add(reason);
    for (const c of contests) hit.contests.add(c);
    this.incomplete.set(l.a.id, hit);
  }

  flushIncomplete() {
    for (const [id, x] of ordered(this.incomplete)) {
      const l = this.ctx.liveById.get(id) as Live;
      this.emit({
        code: 'INCOMPLETE_ASSIGNMENT',
        certainty: 'CERTAIN',
        unitKeys: [l.unitKey],
        contestIds: [l.contest.id, ...x.contests],
        assignmentIds: [id],
        resourceIds: l.resource === null ? [] : [l.resource.id],
        ...(l.req === null ? {} : { requirement: l.req.ref }),
        actual: sortedUnique(x.reasons).join(','),
      });
    }
  }

  get all(): readonly ScheduleConflict[] {
    return this.conflicts;
  }
}

const FIXED_SEVERITY: Partial<Record<ConflictCode, 'HARD' | 'SOFT'>> = {
  RESOURCE_OVERLAP: 'HARD',
  EXCLUSIVITY_CONFLICT: 'HARD',
  CAPACITY_EXCEEDED: 'HARD',
  RESOURCE_TYPE_MISMATCH: 'HARD',
  RESOURCE_UNAVAILABLE: 'HARD',
  PARTICIPANT_OVERLAP: 'HARD',
  TEAM_OVERLAP: 'HARD',
  DEPENDENCY_ORDER: 'HARD',
  LOCKED_ASSIGNMENT_VIOLATION: 'HARD',
  OUTSIDE_EVENT_WINDOW: 'HARD',
  STALE_OCCUPANT: 'HARD',
  START_SPACING: 'HARD',
  CONCURRENT_STARTS_EXCEEDED: 'HARD',
  UNIT_SPLIT: 'HARD',
  AVAILABILITY_UNDECLARED: 'SOFT',
  ROUND_SEQUENCE: 'SOFT',
  INCOMPLETE_ASSIGNMENT: 'SOFT',
};

const totalSeconds = (xs: readonly Interval[]) =>
  sec(xs.reduce((s, i) => s + (i.end - i.start), 0));
const idsOf = (ls: readonly Live[]) => ({
  contestIds: sortedUnique(ls.map((l) => l.contest.id)),
  assignmentIds: sortedUnique(ls.map((l) => l.a.id)),
  unitKeys: sortedUnique(ls.map((l) => l.unitKey)),
});

// ───────────────────────────── per assignment ─────────────────────────────

function checkAssignments(ctx: Context, out: Emitter) {
  const facts = group(ctx.input.availability, (f) => f.resourceId ?? '');
  const layerFacts = (k: string) =>
    [...(facts.get(k) ?? [])].sort((a, b) => byStr(a.id, b.id)).map((f) => f.fact);
  const competitionLayer = { zone: ctx.input.competitionTimezone, facts: layerFacts('') };
  // Each resource's availability is expanded once over the horizon of its claims (§ 21).
  const horizon = new Map<string, Interval>();
  for (const l of ctx.live)
    if (l.resource !== null && l.B !== null) {
      const h = horizon.get(l.resource.id);
      horizon.set(l.resource.id, {
        start: Math.min(h?.start ?? l.B.start, l.B.start),
        end: Math.max(h?.end ?? l.B.end, l.B.end),
      });
    }
  const expansion = new Map<string, AvailabilityExpansion>();
  for (const [id, h] of ordered(horizon)) {
    const r = ctx.resources.get(id) as EvaluationResource;
    expansion.set(
      id,
      expandAvailability(
        {
          status: r.status,
          resource: { zone: r.zone, facts: layerFacts(r.id) },
          competition: competitionLayer,
        },
        h.start,
        h.end,
      ),
    );
  }
  for (const l of ctx.live) {
    const subject = {
      certainty: 'CERTAIN' as ConflictCertainty,
      unitKeys: [l.unitKey],
      contestIds: [l.contest.id],
      assignmentIds: [l.a.id],
      resourceIds: l.resource === null ? [] : [l.resource.id],
    };
    // D3 / D6 / I-B8.3: incomplete, never silently complete.
    if (l.O === null) out.incompleteReason(l, 'expectedEnd');
    if (l.req !== null && l.resource === null) out.incompleteReason(l, 'resource');
    if (l.req === null && l.resource !== null) out.incompleteReason(l, 'consumption');
    // D9: the event window (the end bound uses the start when there is no end).
    const ev = l.event;
    if (
      (ev.windowStartMs !== null && l.a.startMs < ev.windowStartMs) ||
      (ev.windowEndMs !== null && (l.a.expectedEndMs ?? l.a.startMs) > ev.windowEndMs)
    )
      out.emit({ ...subject, code: 'OUTSIDE_EVENT_WINDOW' });
    // R5: the declared type against the requirement's declared type.
    if (
      l.req !== null &&
      l.resource !== null &&
      l.resource.typeCode !== l.req.requirement.resourceType
    )
      out.emit({
        ...subject,
        code: 'RESOURCE_TYPE_MISMATCH',
        requirement: l.req.ref,
        expected: l.req.requirement.resourceType,
        actual: l.resource.typeCode,
      });
    // D12: a place this contest reads is STALE.
    if ((ctx.placesOf.get(l.contest.id) ?? []).some((p) => p.state === 'STALE'))
      out.emit({ ...subject, code: 'STALE_OCCUPANT' });
    // D8: availability of the blocking interval.
    if (l.resource !== null && l.B !== null) {
      const cls = classifyExpanded(expansion.get(l.resource.id) as AvailabilityExpansion, l.B);
      if (cls.closed.length > 0)
        out.emit({ ...subject, code: 'RESOURCE_UNAVAILABLE', actual: totalSeconds(cls.closed) });
      if (cls.undeclared.length > 0)
        out.emit({
          ...subject,
          code: 'AVAILABILITY_UNDECLARED',
          actual: totalSeconds(cls.undeclared),
        });
    }
  }
}

// ───────────────────────────── units (D5) ─────────────────────────────

function checkUnits(ctx: Context, out: Emitter) {
  for (const [unitKey, members] of ordered(ctx.membersOf)) {
    const scheduled = members.flatMap((c) => {
      const l = ctx.liveByContest.get(c.id);
      return l === undefined ? [] : [l];
    });
    if (scheduled.length === 0) continue;
    const reasons = new Set<string>();
    if (new Set(scheduled.map((l) => l.a.startMs)).size > 1) reasons.add('start');
    const used = sortedUnique(
      scheduled.flatMap((l) => (l.resource === null ? [] : [l.resource.id])),
    );
    if (used.length > 1 && used.some((id) => ctx.resources.get(id)?.occupancyMode === 'SHARED'))
      reasons.add('shared-multi-resource');
    if (scheduled.some((l) => l.a.recordedUnitKey !== null && l.a.recordedUnitKey !== unitKey))
      reasons.add('unit-key');
    const unscheduled = members.filter((c) => {
      if (ctx.liveByContest.has(c.id)) return false;
      const places = ctx.placesOf.get(c.id) ?? [];
      return !(places.length > 0 && places.every(isVacant));
    });
    if (unscheduled.length > 0) reasons.add('unscheduled-member');
    if (reasons.size === 0) continue;
    out.emit({
      code: 'UNIT_SPLIT',
      certainty: 'CERTAIN',
      unitKeys: [unitKey],
      contestIds: sortedUnique([
        ...scheduled.map((l) => l.contest.id),
        ...unscheduled.map((c) => c.id),
      ]),
      assignmentIds: scheduled.map((l) => l.a.id),
      resourceIds: used,
      actual: sortedUnique(reasons).join(','),
    });
  }
}

// ───────────────────────────── resources (D6: R1–R4) ─────────────────────────────

interface Claim {
  readonly l: Live;
  readonly B: Interval;
  /** Consumption; null = unknown (no governing requirement). */
  readonly n: number | null;
}

function consumption(ctx: Context, l: Live): number | null {
  if (l.req === null) return null;
  if (l.req.requirement.capacityUnit === 'CONTEST') return 1;
  return (ctx.placesOf.get(l.contest.id) ?? []).filter((p) => !isVacant(p)).length;
}

const compareClaims = (x: Claim, y: Claim) =>
  x.B.start - y.B.start || x.B.end - y.B.end || byStr(x.l.a.id, y.l.a.id);

/** Every overlapping pair of a sorted claim list, by a sweep (output-sensitive). */
function overlappingPairs(claims: readonly Claim[], visit: (x: Claim, y: Claim) => void) {
  const sorted = [...claims].sort(compareClaims);
  let active: Claim[] = [];
  for (const c of sorted) {
    active = active.filter((x) => x.B.end > c.B.start);
    for (const x of active) if (overlap(x.B, c.B)) visit(x, c);
    active.push(c);
  }
}

function checkResources(ctx: Context, out: Emitter) {
  const claims: Claim[] = ctx.live.flatMap((l) =>
    l.resource === null || l.B === null || l.B.end <= l.B.start
      ? []
      : [{ l, B: l.B, n: consumption(ctx, l) }],
  );
  const byResource = group(claims, (c) => (c.l.resource as EvaluationResource).id);
  const consumptionOf = (cs: readonly Claim[]) =>
    cs.flatMap((c) =>
      c.n === null
        ? []
        : [
            {
              assignmentId: c.l.a.id,
              resourceId: (c.l.resource as EvaluationResource).id,
              units: c.n,
            },
          ],
    );

  for (const [resourceId, cs] of ordered(byResource)) {
    const r = ctx.resources.get(resourceId) as EvaluationResource;
    if (r.occupancyMode === 'EXCLUSIVE') {
      // R1: different units never overlap on an EXCLUSIVE resource.
      const pairs = new Map<string, Set<Claim>>();
      overlappingPairs(cs, (x, y) => {
        if (x.l.unitKey === y.l.unitKey) return;
        const k = [x.l.unitKey, y.l.unitKey].sort(byStr).join('\u0000');
        const set = pairs.get(k) ?? new Set();
        set.add(x).add(y);
        pairs.set(k, set);
      });
      for (const [, set] of ordered(pairs))
        out.emit({
          code: 'RESOURCE_OVERLAP',
          certainty: 'CERTAIN',
          ...idsOf([...set].map((c) => c.l)),
          resourceIds: [resourceId],
        });
      // R3: one unit's consumption on one EXCLUSIVE resource is bounded by its capacity.
      for (const [, unitClaims] of ordered(group(cs, (c) => c.l.unitKey))) {
        const known = unitClaims.filter((c) => c.n !== null);
        const total = known.reduce((s, c) => s + (c.n as number), 0);
        if (known.length > 0 && total > r.capacity)
          out.emit({
            code: 'CAPACITY_EXCEEDED',
            certainty: 'CERTAIN',
            ...idsOf(known.map((c) => c.l)),
            resourceIds: [resourceId],
            consumption: consumptionOf(known),
            expected: r.capacity,
            actual: total,
          });
      }
    } else {
      // R2: at every instant, summed consumption ≤ capacity (sweep; ends before starts).
      const known = cs.filter((c) => c.n !== null);
      const points = [...new Set(known.flatMap((c) => [c.B.start, c.B.end]))].sort((a, b) => a - b);
      let window: { claims: Set<Claim>; peak: number } | undefined;
      const flush = () => {
        if (window === undefined) return;
        const list = [...window.claims];
        out.emit({
          code: 'CAPACITY_EXCEEDED',
          certainty: 'CERTAIN',
          ...idsOf(list.map((c) => c.l)),
          resourceIds: [resourceId],
          consumption: consumptionOf(list),
          expected: r.capacity,
          actual: window.peak,
        });
        window = undefined;
      };
      const starts = [...known].sort((a, b) => a.B.start - b.B.start || byStr(a.l.a.id, b.l.a.id));
      const ends = [...known].sort((a, b) => a.B.end - b.B.end || byStr(a.l.a.id, b.l.a.id));
      const active = new Set<Claim>();
      let sum = 0;
      let i = 0;
      let j = 0;
      for (const t of points) {
        // Half-open: a claim ending at t no longer counts at t; one starting at t does.
        for (; j < ends.length && (ends[j] as Claim).B.end <= t; j++) {
          active.delete(ends[j] as Claim);
          sum -= (ends[j] as Claim).n as number;
        }
        for (; i < starts.length && (starts[i] as Claim).B.start <= t; i++) {
          active.add(starts[i] as Claim);
          sum += (starts[i] as Claim).n as number;
        }
        if (sum > r.capacity) {
          window ??= { claims: new Set(), peak: 0 };
          for (const c of active) window.claims.add(c);
          window.peak = Math.max(window.peak, sum);
        } else flush();
      }
      flush();
    }
  }

  // R4 (+ D6 same-unit extension): claims on two different key-sharing resources never overlap.
  const byKey = new Map<string, Set<string>>();
  for (const r of [...ctx.resources.values()].sort((a, b) => byStr(a.id, b.id)))
    for (const k of r.exclusivityKeys) byKey.set(k, (byKey.get(k) ?? new Set()).add(r.id));
  const resourcePairs = new Set<string>();
  for (const [, ids] of ordered(byKey)) {
    const list = [...ids].sort(byStr);
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++)
        resourcePairs.add(`${list[i] as string}\u0000${list[j] as string}`);
  }
  for (const pair of [...resourcePairs].sort(byStr)) {
    const [ra, rb] = pair.split('\u0000') as [string, string];
    const a = ctx.resources.get(ra) as EvaluationResource;
    const b = ctx.resources.get(rb) as EvaluationResource;
    if (!sharesSpace(a, b)) continue;
    const both = [...(byResource.get(ra) ?? []), ...(byResource.get(rb) ?? [])];
    const units = new Map<string, Set<Claim>>();
    overlappingPairs(both, (x, y) => {
      if ((x.l.resource as EvaluationResource).id === (y.l.resource as EvaluationResource).id)
        return;
      const k = [x.l.unitKey, y.l.unitKey].sort(byStr).join('\u0000');
      const set = units.get(k) ?? new Set();
      set.add(x).add(y);
      units.set(k, set);
    });
    for (const [, set] of ordered(units))
      out.emit({
        code: 'EXCLUSIVITY_CONFLICT',
        certainty: 'CERTAIN',
        ...idsOf([...set].map((c) => c.l)),
        resourceIds: [ra, rb],
      });
  }
}

// ───────────────────────────── start events (D7) ─────────────────────────────

function checkStarts(ctx: Context, out: Emitter) {
  const events = ctx.live.filter((l) => l.resource?.occupancyMode === 'SHARED');
  for (const [resourceId, ls] of ordered(
    group(events, (l) => (l.resource as EvaluationResource).id),
  )) {
    const slots = [...group(ls, (l) => String(l.a.startMs)).entries()]
      .map(([t, members]) => ({ t: Number(t), members }))
      .sort((a, b) => a.t - b.t);
    const unitsOf = (members: readonly Live[]) => group(members, (l) => l.unitKey);
    /** The governing requirement of a set of start events: max spacing, or min concurrency (B4). */
    const governing = (
      members: readonly Live[],
      value: (r: Req) => number,
      better: (a: number, b: number) => boolean,
    ) => {
      let best: Req | undefined;
      for (const [, us] of ordered(unitsOf(members))) {
        const r = (us[0] as Live).req;
        if (r !== null && (best === undefined || better(value(r), value(best)))) best = r;
      }
      return best;
    };
    for (const slot of slots) {
      const units = unitsOf(slot.members);
      const g = governing(
        slot.members,
        (r) => r.requirement.concurrentStarts ?? 1,
        (a, b) => a < b,
      );
      if (g === undefined) continue;
      const limit = g.requirement.concurrentStarts ?? 1;
      if (units.size > limit)
        out.emit({
          code: 'CONCURRENT_STARTS_EXCEEDED',
          certainty: 'CERTAIN',
          ...idsOf(slot.members),
          resourceIds: [resourceId],
          requirement: g.ref,
          expected: limit,
          actual: units.size,
        });
    }
    for (let i = 0; i + 1 < slots.length; i++) {
      const s1 = slots[i] as (typeof slots)[number];
      const s2 = slots[i + 1] as (typeof slots)[number];
      const u1 = new Set(s1.members.map((l) => l.unitKey));
      const u2 = new Set(s2.members.map((l) => l.unitKey));
      // Events of the same unit are never compared with each other.
      if (u1.size === 1 && u2.size === 1 && [...u1][0] === [...u2][0]) continue;
      const members = [...s1.members, ...s2.members];
      const g = governing(
        members,
        (r) => r.requirement.startSpacingSeconds ?? 0,
        (a, b) => a > b,
      );
      const spacing = g?.requirement.startSpacingSeconds ?? 0;
      if (g !== undefined && s2.t - s1.t < spacing * 1000)
        out.emit({
          code: 'START_SPACING',
          certainty: 'CERTAIN',
          ...idsOf(members),
          resourceIds: [resourceId],
          requirement: g.ref,
          expected: spacing,
          actual: sec(s2.t - s1.t),
        });
    }
  }
}

// ───────────────────────────── participants (D10, D11) ─────────────────────────────

interface Appearance {
  readonly l: Live;
  readonly entrant: string;
  readonly certain: boolean;
}

function appearances(ctx: Context): Appearance[] {
  const out: Appearance[] = [];
  for (const l of ctx.live) {
    const who = new Map<string, boolean>();
    for (const p of ctx.placesOf.get(l.contest.id) ?? []) {
      const certain = isCertain(p);
      for (const e of ctx.ofPlace(p)) who.set(e, (who.get(e) ?? false) || certain);
    }
    for (const [entrant, certain] of ordered(who)) out.push({ l, entrant, certain });
  }
  return out;
}

const certaintyOf = (...xs: readonly { certain: boolean }[]): ConflictCertainty =>
  xs.every((x) => x.certain) ? 'CERTAIN' : 'POSSIBLE';
const sameRound = (x: Appearance, y: Appearance) => x.l.contest.roundId === y.l.contest.roundId;

/** Overlapping appearance pairs on O, under the same-round rule (D10). */
function overlappingAppearances<A extends Appearance>(
  list: readonly A[],
  visit: (x: A, y: A) => void,
) {
  const timed = list
    .filter((a) => a.l.O !== null)
    .sort(
      (x, y) => (x.l.O as Interval).start - (y.l.O as Interval).start || byStr(x.l.a.id, y.l.a.id),
    );
  let active: A[] = [];
  for (const c of timed) {
    const o = c.l.O as Interval;
    active = active.filter((x) => (x.l.O as Interval).end > o.start);
    for (const x of active)
      if (x.l.a.id !== c.l.a.id && overlap(x.l.O as Interval, o)) {
        if (sameRound(x, c) && !(x.certain && c.certain)) continue;
        visit(x, c);
      }
    active.push(c);
  }
}

function checkParticipants(ctx: Context, out: Emitter) {
  const apps = appearances(ctx);

  // TEAM_OVERLAP: the same team entrant in two overlapping contests.
  for (const [entrant, list] of ordered(group(apps, (a) => a.entrant))) {
    if ((ctx.entrants.get(entrant) as EvaluationEntrant).kind !== 'TEAM') continue;
    overlappingAppearances(list, (x, y) => {
      out.emit({
        code: 'TEAM_OVERLAP',
        certainty: certaintyOf(x, y),
        ...idsOf([x.l, y.l]),
        resourceIds: [],
        entrantIds: [entrant],
      });
    });
  }

  // Person appearances (persons from the athlete or the frozen roster).
  interface PersonApp extends Appearance {
    readonly person: string;
  }
  const personApps = new Map<string, PersonApp>();
  for (const a of apps)
    for (const person of (ctx.entrants.get(a.entrant) as EvaluationEntrant).personIds) {
      const k = `${person}\u0000${a.l.a.id}\u0000${a.entrant}`;
      personApps.set(k, { ...a, person });
    }
  const byPerson = group(
    [...personApps.values()].sort(
      (x, y) => byStr(x.l.a.id, y.l.a.id) || byStr(x.entrant, y.entrant),
    ),
    (p) => p.person,
  );

  for (const [person, list] of ordered(byPerson)) {
    // One appearance per (person, assignment): CERTAIN wins; remember every entrant it came through.
    const merged = new Map<string, Appearance & { entrants: Set<string> }>();
    for (const p of list) {
      const hit = merged.get(p.l.a.id);
      if (hit === undefined)
        merged.set(p.l.a.id, {
          l: p.l,
          entrant: p.entrant,
          certain: p.certain,
          entrants: new Set([p.entrant]),
        });
      else {
        hit.entrants.add(p.entrant);
        if (p.certain && !hit.certain)
          merged.set(p.l.a.id, { ...hit, certain: true, entrant: p.entrant });
      }
    }
    const mine = [...merged.values()];

    // PARTICIPANT_OVERLAP: a person not explained by one common team entrant.
    overlappingAppearances(mine, (x, y) => {
      const common = [...x.entrants].filter(
        (e) => y.entrants.has(e) && (ctx.entrants.get(e) as EvaluationEntrant).kind === 'TEAM',
      );
      if (common.length > 0) return;
      out.emit({
        code: 'PARTICIPANT_OVERLAP',
        certainty: certaintyOf(x, y),
        ...idsOf([x.l, y.l]),
        resourceIds: [],
        personIds: [person],
      });
    });

    // SHORT_REST: the latest-ending earlier appearance in another round (D10).
    const timed = mine
      .filter((a) => a.l.O !== null)
      .sort(
        (x, y) =>
          (x.l.O as Interval).end - (y.l.O as Interval).end ||
          (x.certain === y.certain ? 0 : x.certain ? -1 : 1) ||
          ctx.compareContests(x.l.contest, y.l.contest),
      );
    for (const a2 of timed) {
      const rest = a2.l.req?.requirement.rest;
      if (rest === undefined || rest.minimumSeconds === 0) continue;
      const start = a2.l.a.startMs;
      let pred: (typeof timed)[number] | undefined;
      for (const a1 of timed) {
        const end = (a1.l.O as Interval).end;
        if (end > start) break;
        if (a1.l.contest.roundId === a2.l.contest.roundId) continue;
        // Latest end wins; at equal ends the first in (certain, contest order) is kept.
        if (pred === undefined || end > (pred.l.O as Interval).end) pred = a1;
      }
      if (pred === undefined) continue;
      const gap = start - (pred.l.O as Interval).end;
      if (gap < rest.minimumSeconds * 1000)
        out.emit({
          code: 'SHORT_REST',
          severity: rest.enforcement,
          certainty: certaintyOf(pred, a2),
          ...idsOf([pred.l, a2.l]),
          resourceIds: [],
          personIds: [person],
          requirement: (a2.l.req as Req).ref,
          expected: rest.minimumSeconds,
          actual: sec(gap),
        });
    }
  }

  // MAX_CONTESTS_PER_DAY: units per (event, entrant, requirement, local start date) (B6, D10).
  const unitStart = new Map<string, number>();
  for (const l of ctx.live)
    unitStart.set(l.unitKey, Math.min(unitStart.get(l.unitKey) ?? Infinity, l.a.startMs));
  const counted = apps.filter((a) => a.l.req?.requirement.maxUnitsPerEntrantPerDay !== undefined);
  const dayKey = (a: Appearance) => {
    const req = a.l.req as Req;
    const date = localDateOf(unitStart.get(a.l.unitKey) as number, a.l.event.timezone);
    return [a.l.event.id, a.entrant, String(req.ref.requirementIndex), date].join('\u0000');
  };
  for (const [, list] of ordered(group(counted, dayKey))) {
    const first = list[0] as Appearance;
    const limit = (first.l.req as Req).requirement.maxUnitsPerEntrantPerDay as {
      value: number;
      enforcement: 'HARD' | 'SOFT';
    };
    // Same-round collapse: one entrant occupies one place of a round, so a round counts once.
    const rounds = new Set(list.map((a) => a.l.contest.roundId));
    const certainRounds = new Set(list.filter((a) => a.certain).map((a) => a.l.contest.roundId));
    if (rounds.size <= limit.value) continue;
    out.emit({
      code: 'MAX_CONTESTS_PER_DAY',
      severity: limit.enforcement,
      certainty: certainRounds.size > limit.value ? 'CERTAIN' : 'POSSIBLE',
      ...idsOf(list.map((a) => a.l)),
      resourceIds: [],
      entrantIds: [first.entrant],
      requirement: (first.l.req as Req).ref,
      expected: limit.value,
      actual: rounds.size,
    });
  }

  // ROUND_SEQUENCE: per entrant and stage, consecutive rounds of CERTAIN appearances (D11).
  const certainApps = apps.filter((a) => a.certain && a.l.contest.stageId !== null);
  for (const [, list] of ordered(
    group(certainApps, (a) => `${a.entrant}\u0000${a.l.contest.stageId as string}`),
  )) {
    const rounds = [...group(list, (a) => a.l.contest.roundId).values()].sort(
      (x, y) =>
        (x[0] as Appearance).l.contest.roundSequence - (y[0] as Appearance).l.contest.roundSequence,
    );
    for (let i = 0; i + 1 < rounds.length; i++) {
      const prev = rounds[i] as Appearance[];
      const next = rounds[i + 1] as Appearance[];
      const prevBound = Math.max(...prev.map((a) => a.l.O?.end ?? a.l.a.startMs));
      const nextStart = Math.min(...next.map((a) => a.l.a.startMs));
      if (nextStart < prevBound)
        out.emit({
          code: 'ROUND_SEQUENCE',
          certainty: 'CERTAIN',
          ...idsOf([...prev, ...next].map((a) => a.l)),
          resourceIds: [],
          entrantIds: [(prev[0] as Appearance).entrant],
        });
    }
  }
}

// ───────────────────────────── dependencies (D11) ─────────────────────────────

function checkDependencies(ctx: Context, out: Emitter) {
  for (const l of ctx.live) {
    const feeders = sortedUnique(l.contest.feeders)
      .map((id) => ctx.contests.get(id) as EvaluationContest)
      .filter((f) => !EXCLUDED.has(f.status) && f.status !== 'COMPLETED');
    if (feeders.length === 0) continue;
    const unscheduled = feeders.filter((f) => !ctx.liveByContest.has(f.id));
    if (unscheduled.length > 0)
      out.incompleteReason(
        l,
        'feeder',
        unscheduled.map((f) => f.id),
      );
    const timed = feeders.flatMap((f) => {
      const fl = ctx.liveByContest.get(f.id);
      return fl === undefined || fl.O === null ? [] : [fl];
    });
    if (timed.length === 0) continue;
    const lead = (l.req?.requirement.dependencyLeadSeconds ?? 0) * 1000;
    const required = Math.max(...timed.map((f) => (f.O as Interval).end)) + lead;
    if (l.a.startMs >= required) continue;
    const violating = timed.filter((f) => (f.O as Interval).end + lead > l.a.startMs);
    out.emit({
      code: 'DEPENDENCY_ORDER',
      certainty: 'CERTAIN',
      ...idsOf([l, ...violating]),
      resourceIds: [],
      ...(l.req === null ? {} : { requirement: l.req.ref }),
      expected: sec(required),
      actual: sec(l.a.startMs),
    });
  }
}

// ───────────────────────────── locks (D12) ─────────────────────────────

function checkLocks(ctx: Context, out: Emitter) {
  const base = new Map(ctx.input.baseAssignments.map((a) => [a.contestId, a]));
  const draft = new Map(ctx.input.assignments.map((a) => [a.contestId, a]));
  for (const c of [...ctx.contests.values()].sort(ctx.compareContests)) {
    if (!SETTLED.has(c.status)) continue;
    const d = draft.get(c.id);
    const b = base.get(c.id);
    if (d === undefined && b === undefined) continue;
    const same =
      d !== undefined &&
      b !== undefined &&
      d.resourceId === b.resourceId &&
      d.startMs === b.startMs &&
      d.expectedEndMs === b.expectedEndMs &&
      d.changeoverSeconds === b.changeoverSeconds;
    if (same) continue;
    const involved = d ?? (b as EvaluationAssignment);
    out.emit(
      {
        code: 'LOCKED_ASSIGNMENT_VIOLATION',
        certainty: 'CERTAIN',
        unitKeys: [ctx.unitOf.get(c.id) as string],
        contestIds: [c.id],
        assignmentIds: [involved.id],
        resourceIds: involved.resourceId === null ? [] : [involved.resourceId],
      },
      true,
    );
  }
}

// ───────────────────────────── the report ─────────────────────────────

/**
 * Evaluates one schedule version. Same input ⇒ byte-identical canonical report and hash; the order
 * of every input array is irrelevant.
 */
export function evaluateSchedule(input: ScheduleEvaluationInput): ScheduleConflictReport {
  const ctx = new Context(input);
  const out = new Emitter(ctx);
  checkAssignments(ctx, out);
  checkUnits(ctx, out);
  checkResources(ctx, out);
  checkStarts(ctx, out);
  checkParticipants(ctx, out);
  checkDependencies(ctx, out);
  checkLocks(ctx, out);
  out.flushIncomplete();

  const occupancy = [...input.places]
    .sort((a, b) => byStr(a.contestId, b.contestId) || a.place - b.place)
    .map((p) => [p.contestId, p.place, p.sourceKind, p.state, p.occupantId ?? '', p.factId ?? '']);
  return canonicalScheduleReport({
    reportVersion: 2,
    competitionId: input.competitionId,
    scheduleVersionId: input.scheduleVersionId,
    assignmentIds: input.watermark,
    inputs: {
      events: input.events.map((e) => ({
        eventId: e.id,
        profileVersionId: e.profile?.versionId ?? null,
        specHash: e.profile?.specHash ?? null,
        timezone: e.timezone,
        windowStart: e.windowStartMs === null ? null : sec(e.windowStartMs),
        windowEnd: e.windowEndMs === null ? null : sec(e.windowEndMs),
      })),
      competitionTimezone: input.competitionTimezone,
      resourceRevisionIds: input.resources.map((r) => r.revisionId),
      availabilityFactIds: input.availability.map((f) => f.id),
      occupancyDigest: scheduleDigest(
        OCCUPANCY_DIGEST_SCHEMA,
        occupancy as unknown as CanonicalValue[],
      ),
      contestStatuses: input.contests.map((c) => ({ contestId: c.id, status: c.status })),
    },
    validator: CONFLICT_ENGINE,
    coverage: ENGINE_COVERAGE,
    conflicts: out.all,
  });
}
