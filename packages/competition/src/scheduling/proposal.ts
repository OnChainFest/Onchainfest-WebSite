import {
  buildPreimage,
  compareUtf16,
  serializeJcs,
  sha256,
  toContentHash,
  type CanonicalValue,
  type ContentHash,
} from '@br/canonical';
import {
  classifyExpanded,
  expandAvailability,
  type AvailabilityExpansion,
} from '../resources/availability';
import { intersect, type Interval } from '../resources/interval';
import { addDays, localDateOf, localMs, resolveRecurring } from '../resources/zoned';
import { defaultExpectedEnd } from './assignment';
import {
  evaluateSchedule,
  ScheduleEvaluationError,
  type EvaluationAssignment,
  type EvaluationContest,
  type EvaluationEvent,
  type EvaluationPlace,
  type EvaluationResource,
  type ScheduleEvaluationInput,
} from './engine';
import { resolveRequirement, type SchedulingRequirement } from './profile';
import {
  conflictKey,
  scheduleReportHash,
  type ConflictCode,
  type ScheduleConflict,
  type ScheduleConflictReport,
} from './report';
import { deriveUnitKeys, type UnitContestFacts } from './units';

/**
 * The ONCF-05E-E scheduler / proposal engine core (ADR-0075): the pure function
 *
 *     proposeSchedule(input) → ScheduleProposal
 *
 * It PROPOSES placements (a start instant and one resource per member contest) for the units of
 * the open draft that have none; the 05E-D engine (`evaluateSchedule`) is the only feasibility
 * judge (§ 2). No rule of ADR-0071/0073/0074 is re-implemented here: candidates are CONSTRUCTED
 * with the helpers 05E-C/D already use (`deriveUnitKeys`, `resolveRequirement`,
 * `defaultExpectedEnd`, `expandAvailability`, B2 consumption) and ACCEPTED only on the judge's
 * report. No database, clock, randomness, environment or I/O.
 *
 * v1 (ADR-0075 § 7–13): additive only (every live assignment is fixed); deterministic greedy,
 * time-major, single pass, no backtracking; earliest feasible interval, then the resource-id
 * tie-break (§ 10); SOFT conflicts reported, never used to choose; a logical budget in judge calls.
 * No rule branches on a sport, discipline, format engine or resource type.
 */

/** ADR-0075 § 8: the strategy identity. Any change to its semantics bumps `version`. */
export const PROPOSAL_STRATEGY = { id: 'br:schedule-proposal-greedy', version: 1 } as const;

/** ADR-0075 § 12: v1 operational defaults (judge calls), not architectural constants. */
export const PROPOSAL_BUDGET: ProposalBudget = {
  maxEvaluations: 10_000,
  maxEvaluationsPerUnit: 500,
};

export const PROPOSAL_VERSION = 1;

export interface ProposalBudget {
  readonly maxEvaluations: number;
  readonly maxEvaluationsPerUnit: number;
}

export type ProposalUnplacedReason =
  | 'NO_PROFILE'
  | 'EVENT_NOT_SCHEDULABLE'
  | 'PARTIALLY_PLACED'
  | 'ALL_VACANT'
  | 'STALE_OCCUPANT'
  | 'NO_COMPATIBLE_RESOURCE'
  | 'NO_HORIZON'
  | 'NO_DECLARED_TIME'
  | 'FEEDER_UNPLACED'
  | 'NO_FEASIBLE_CANDIDATE'
  | 'BUDGET_EXHAUSTED';

export type ProposalStatus =
  'SUCCESS' | 'NOTHING_TO_PLACE' | 'INFEASIBLE' | 'NO_CANDIDATES' | 'SEARCH_EXHAUSTED';

/** Refusals: no proposal is produced (ADR-0075 § 13). */
export type ProposalRefusalCode = 'INVALID_INPUT' | 'INCOMPLETE_STATE';

export class ScheduleProposalError extends Error {
  readonly code: ProposalRefusalCode;
  constructor(code: ProposalRefusalCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The authoritative input (ADR-0075 § 4). `judge` is exactly the 05E-D evaluation input of the open
 * draft, as the `validate` loader builds it. The other fields are authoritative facts the judge does
 * not read but 05E-E needs: lifecycle states, the plan's latest start offset per contest (05E-C's
 * write default for the expected end) and the base PUBLISHED version id. `scope` and `fromMs` are
 * the only request parameters.
 */
export interface ScheduleProposalInput {
  readonly judge: ScheduleEvaluationInput;
  /** Status of the version `judge.scheduleVersionId` (it must be the open DRAFT). */
  readonly draftStatus: string;
  readonly competitionStatus: string;
  readonly basePublishedVersionId: string | null;
  /** Lifecycle status of every event of `judge.events`. */
  readonly eventStatuses: readonly { readonly eventId: string; readonly status: string }[];
  /** Latest plan start offset (seconds) of every contest of `judge.contests`. */
  readonly latestOffsets: readonly { readonly contestId: string; readonly seconds: number }[];
  readonly scope?: { readonly eventIds?: readonly string[]; readonly roundIds?: readonly string[] };
  /** Earliest start considered (epoch ms, whole seconds). Never the clock. */
  readonly fromMs?: number;
}

export interface ProposalPlacement {
  readonly contestId: string;
  readonly unitKey: string;
  readonly resourceId: string;
  /** Epoch seconds. */
  readonly start: number;
  readonly expectedEnd: number;
  readonly changeoverSeconds: number;
  readonly zone: string;
  readonly provisional: boolean;
  /** Keys of the final report's SOFT conflicts that involve this placement. */
  readonly softConflictKeys: readonly string[];
}

export interface ProposalUnplaced {
  readonly unitKey: string;
  readonly contestIds: readonly string[];
  readonly reason: ProposalUnplacedReason;
  /** NO_FEASIBLE_CANDIDATE: the blocking conflicts of the first candidate tried. */
  readonly blockingConflictKeys: readonly string[];
}

export interface ProposalMetrics {
  readonly placedUnits: number;
  readonly placedContests: number;
  readonly unplacedUnits: number;
  readonly placementsWithSoftConflicts: number;
  /** Epoch seconds, or null without placements. */
  readonly earliestStart: number | null;
  readonly latestEnd: number | null;
  readonly makespanSeconds: number;
  readonly busySeconds: readonly { readonly resourceId: string; readonly seconds: number }[];
  /** HARD conflicts of the preserved content alone (never attributed to placements). */
  readonly baseHardConflicts: number;
}

/** The semantic proposal: everything here is canonical and hashed (ADR-0075 § 14). */
export interface ScheduleProposalBody {
  readonly proposalVersion: typeof PROPOSAL_VERSION;
  readonly strategy: { readonly id: string; readonly version: number };
  readonly budget: ProposalBudget;
  readonly baseStateIdentity: ContentHash;
  readonly scope: {
    readonly eventIds: readonly string[] | null;
    readonly roundIds: readonly string[] | null;
  };
  /** Epoch seconds, or null. */
  readonly from: number | null;
  readonly placements: readonly ProposalPlacement[];
  readonly unplaced: readonly ProposalUnplaced[];
  readonly status: ProposalStatus;
  /** The judge's report over base ⊕ placements (synthetic ids: preview evidence only). */
  readonly report: {
    readonly reportHash: ContentHash;
    readonly validator: { readonly id: string; readonly version: number };
    readonly coverage: readonly string[];
    readonly hardConflicts: number;
  };
  readonly metrics: ProposalMetrics;
}

/** Execution metadata: returned for humans and logs, never hashed. */
export interface ProposalDiagnostics {
  /** Judge calls on candidates (the budgeted quantity). */
  readonly judgeCalls: number;
  /** Including the base and final evaluations. */
  readonly totalEvaluations: number;
  readonly skips: { readonly unit: number; readonly time: number; readonly resource: number };
  readonly packingRebuilds: number;
}

export interface ScheduleProposal extends ScheduleProposalBody {
  readonly proposalHash: ContentHash;
  readonly diagnostics: ProposalDiagnostics;
}

// ───────────────────────────── search classes (ADR-0075 § 8) ─────────────────────────────

export type ConflictSearchClass = 'UNIT' | 'TIME' | 'RESOURCE';

/**
 * Classes steer the search only; they never accept anything. Exhaustive over the vocabulary, so a
 * new code must be classified here; an unknown code at run time defaults to RESOURCE (skips least).
 */
export const CONFLICT_SEARCH_CLASS: Readonly<Record<ConflictCode, ConflictSearchClass>> = {
  STALE_OCCUPANT: 'UNIT',
  PARTICIPANT_OVERLAP: 'TIME',
  TEAM_OVERLAP: 'TIME',
  SHORT_REST: 'TIME',
  DEPENDENCY_ORDER: 'TIME',
  MAX_CONTESTS_PER_DAY: 'TIME',
  ROUND_SEQUENCE: 'TIME',
  OUTSIDE_EVENT_WINDOW: 'TIME',
  RESOURCE_OVERLAP: 'RESOURCE',
  EXCLUSIVITY_CONFLICT: 'RESOURCE',
  CAPACITY_EXCEEDED: 'RESOURCE',
  RESOURCE_TYPE_MISMATCH: 'RESOURCE',
  RESOURCE_UNAVAILABLE: 'RESOURCE',
  AVAILABILITY_UNDECLARED: 'RESOURCE',
  START_SPACING: 'RESOURCE',
  CONCURRENT_STARTS_EXCEEDED: 'RESOURCE',
  UNIT_SPLIT: 'RESOURCE',
  // Outside the judge's v1 coverage (ADR-0074 D15): never emitted; default class.
  LONG_WAIT: 'RESOURCE',
  UNDERUSED_RESOURCE: 'RESOURCE',
  SEQUENCING_INEFFICIENCY: 'RESOURCE',
  LOCKED_ASSIGNMENT_VIOLATION: 'RESOURCE',
  INCOMPLETE_ASSIGNMENT: 'RESOURCE',
};

const searchClassOf = (code: string): ConflictSearchClass =>
  (CONFLICT_SEARCH_CLASS as Record<string, ConflictSearchClass>)[code] ?? 'RESOURCE';

// ───────────────────────────── helpers ─────────────────────────────

const SCHEDULABLE_EVENT = new Set(['FIELD_LOCKED', 'IN_PROGRESS']);
const CLOSED_COMPETITION = new Set(['COMPLETED', 'CANCELLED']);
const EXCLUDED = new Set(['CANCELLED', 'VOID']);
const EMPTY_DOMAIN = new Set<ProposalUnplacedReason>([
  'NO_COMPATIBLE_RESOURCE',
  'NO_HORIZON',
  'NO_DECLARED_TIME',
]);

const byStr = (a: string, b: string) => compareUtf16(a, b);
const sortedUnique = (xs: Iterable<string>): string[] => [...new Set(xs)].sort(byStr);
const sec = (ms: number) => Math.floor(ms / 1000);
/** Round UP to the next whole second (legacy sub-second anchors, ADR-0075 § 10). */
const ceilSecond = (ms: number) => Math.ceil(ms / 1000) * 1000;

/**
 * ADR-0075 § 10 (amended): the start instant of every local calendar date of `zone` within
 * [from, to] — 00:00 local, resolved with 05E-A's recurring-rule DST semantics (a skipped midnight
 * moves forward to the date's first instant), exactly as availability expands local days. These
 * are boundaries derived from the event zone, not a scheduling grid.
 */
function localDateStarts(from: number, to: number, zone: string): number[] {
  const out: number[] = [];
  for (let d = localDateOf(from, zone); ; d = addDays(d, 1)) {
    const start = resolveRecurring(localMs(d, '00:00') as number, zone);
    if (start > to) return out;
    if (start >= from) out.push(start);
  }
}
const isVacant = (p: EvaluationPlace) =>
  p.state === 'VACANT' || (p.state === 'OVERRIDDEN' && p.occupantId === null);
const refuse = (code: ProposalRefusalCode, message: string): never => {
  throw new ScheduleProposalError(code, message);
};

/** JCS has no null: an absent value is an omitted member, as in the report's canonical form. */
function omitAbsent(value: unknown): CanonicalValue {
  if (Array.isArray(value)) return value.map(omitAbsent);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => [k, omitAbsent(v)]),
    );
  return value as CanonicalValue;
}

function hashOf(schemaId: string, value: unknown): ContentHash {
  const bytes = new TextEncoder().encode(serializeJcs(omitAbsent(value)));
  return toContentHash(sha256(buildPreimage('ledger-fact', schemaId, 1, bytes)));
}

/** The frozen contest order the judge uses: event, stage, round, plan sequence, id. */
const compareContests = (a: EvaluationContest, b: EvaluationContest) =>
  byStr(a.eventId, b.eventId) ||
  a.stageSequence - b.stageSequence ||
  a.roundSequence - b.roundSequence ||
  a.sequence - b.sequence ||
  byStr(a.id, b.id);

interface Unit {
  readonly key: string;
  readonly event: EvaluationEvent;
  /** Non-excluded members, in member order. */
  readonly members: readonly EvaluationContest[];
  readonly stageSequence: number;
  readonly roundSequence: number;
  readonly roundId: string;
  readonly minSequence: number;
  depth: number;
}

interface Target {
  readonly unit: Unit;
  readonly requirement: SchedulingRequirement;
  /** Members to place: every member except entirely VACANT ones (the judge excuses those). */
  readonly toPlace: readonly EvaluationContest[];
}

/** One built candidate: member → resource at one instant. */
type Candidate = readonly {
  readonly contest: EvaluationContest;
  readonly resource: EvaluationResource;
}[];

// ───────────────────────────── the engine ─────────────────────────────

/** ADR-0075: one proposal for the open draft, with the v1 default budget. */
export function proposeSchedule(input: ScheduleProposalInput): ScheduleProposal {
  return proposeScheduleWithBudget(input, PROPOSAL_BUDGET);
}

/**
 * Test seam (not exported by the package): the same engine under an explicit budget. Callers of the
 * package cannot set the budget in v1 (ADR-0075 § 12); the budget used is recorded and hashed.
 */
export function proposeScheduleWithBudget(
  input: ScheduleProposalInput,
  budget: ProposalBudget,
): ScheduleProposal {
  return new Run(input, budget).execute();
}

class Run {
  private readonly judge: ScheduleEvaluationInput;
  private readonly contests = new Map<string, EvaluationContest>();
  private readonly events = new Map<string, EvaluationEvent>();
  private readonly eventStatus = new Map<string, string>();
  private readonly latestOffset = new Map<string, number>();
  private readonly placesOf = new Map<string, EvaluationPlace[]>();
  private readonly liveByContest = new Map<string, EvaluationAssignment>();
  private readonly resources: readonly EvaluationResource[];
  private readonly resourceById = new Map<string, EvaluationResource>();
  private readonly unitOf = new Map<string, string>();
  private readonly scope: { eventIds: string[] | null; roundIds: string[] | null };
  private readonly fromMs: number | null;
  /** Lead, rest minimum and start-spacing constants of every pinned requirement, plus 0 (ms). */
  private readonly constants: readonly number[];
  /** Breakpoint anchors (start, O.end, B.end) of live and accepted assignments (ms). */
  private readonly anchors = new Set<number>();
  private readonly accepted: EvaluationAssignment[] = [];
  private readonly placedContests = new Set<string>();
  private readonly expansions = new Map<string, AvailabilityExpansion>();

  private judgeCalls = 0;
  private totalEvaluations = 0;
  private readonly skips = { unit: 0, time: 0, resource: 0 };
  private packingRebuilds = 0;
  private globalExhausted = false;

  private readonly input: ScheduleProposalInput;
  private readonly budget: ProposalBudget;

  constructor(input: ScheduleProposalInput, budget: ProposalBudget) {
    this.input = input;
    this.budget = budget;
    this.judge = input.judge;

    // Refusals first (ADR-0075 § 13): no proposal for these.
    if (CLOSED_COMPETITION.has(input.competitionStatus))
      refuse('INCOMPLETE_STATE', `the competition is ${input.competitionStatus}`);
    if (input.draftStatus !== 'DRAFT')
      refuse('INCOMPLETE_STATE', 'the schedule version is not the open draft');
    for (const b of [budget.maxEvaluations, budget.maxEvaluationsPerUnit])
      if (!Number.isSafeInteger(b) || b < 1) refuse('INVALID_INPUT', 'invalid budget');

    for (const e of this.judge.events) this.events.set(e.id, e);
    for (const c of this.judge.contests) this.contests.set(c.id, c);
    for (const s of input.eventStatuses) {
      if (!this.events.has(s.eventId) || this.eventStatus.has(s.eventId))
        refuse('INVALID_INPUT', `event status for an unknown or repeated event ${s.eventId}`);
      this.eventStatus.set(s.eventId, s.status);
    }
    if (this.eventStatus.size !== this.events.size)
      refuse('INVALID_INPUT', 'every event needs a lifecycle status');
    for (const o of input.latestOffsets) {
      if (!this.contests.has(o.contestId) || this.latestOffset.has(o.contestId))
        refuse('INVALID_INPUT', `offset for an unknown or repeated contest ${o.contestId}`);
      if (!Number.isSafeInteger(o.seconds) || o.seconds < 0)
        refuse('INVALID_INPUT', `invalid offset for contest ${o.contestId}`);
      this.latestOffset.set(o.contestId, o.seconds);
    }
    if (this.latestOffset.size !== this.contests.size)
      refuse('INVALID_INPUT', 'every contest needs its latest plan offset');

    const eventIds = input.scope?.eventIds;
    const roundIds = input.scope?.roundIds;
    if (eventIds !== undefined)
      for (const id of eventIds)
        if (!this.events.has(id)) refuse('INVALID_INPUT', `scope names a foreign event ${id}`);
    const rounds = new Set(this.judge.contests.map((c) => c.roundId));
    if (roundIds !== undefined)
      for (const id of roundIds)
        if (!rounds.has(id)) refuse('INVALID_INPUT', `scope names a foreign round ${id}`);
    this.scope = {
      eventIds: eventIds === undefined ? null : sortedUnique(eventIds),
      roundIds: roundIds === undefined ? null : sortedUnique(roundIds),
    };
    if (
      input.fromMs !== undefined &&
      (!Number.isSafeInteger(input.fromMs) || input.fromMs < 0 || input.fromMs % 1000 !== 0)
    )
      refuse('INVALID_INPUT', '`from` must be a whole-second instant');
    this.fromMs = input.fromMs ?? null;

    this.resources = [...this.judge.resources].sort((a, b) => byStr(a.id, b.id));
    for (const r of this.resources) this.resourceById.set(r.id, r);
    for (const p of [...this.judge.places].sort(
      (a, b) => byStr(a.contestId, b.contestId) || a.place - b.place,
    ))
      this.placesOf.set(p.contestId, [...(this.placesOf.get(p.contestId) ?? []), p]);
    for (const a of this.judge.assignments) this.liveByContest.set(a.contestId, a);

    const constants = new Set<number>([0]);
    for (const e of this.judge.events)
      for (const r of e.profile?.spec.requirements ?? [])
        for (const s of [r.dependencyLeadSeconds, r.rest?.minimumSeconds, r.startSpacingSeconds])
          if (s !== undefined) constants.add(s * 1000);
    this.constants = [...constants].sort((a, b) => a - b);
  }

  execute(): ScheduleProposal {
    // The base state must be judgeable; a malformed state is a refusal, never a status (D16).
    const base = this.evaluate(this.judge.assignments, false);
    const baseStateIdentity = this.baseStateIdentity(base);

    this.deriveUnits();
    const { targets, unplaced } = this.classifyUnits();
    for (const a of this.judge.assignments) this.addAnchors(a);

    const decided = new Map<string, ProposalUnplaced | null>();
    for (const t of targets) {
      if (this.globalExhausted) {
        decided.set(t.unit.key, this.unplacedOf(t.unit, 'BUDGET_EXHAUSTED'));
        continue;
      }
      decided.set(t.unit.key, this.place(t));
    }
    for (const u of decided.values()) if (u !== null) unplaced.push(u);
    unplaced.sort((a, b) => byStr(a.unitKey, b.unitKey));

    const final = this.accepted.length === 0 ? base : this.evaluate(this.accepted, false);
    const status = this.status(targets, decided);
    const placements = this.placements(final);
    const body: ScheduleProposalBody = {
      proposalVersion: PROPOSAL_VERSION,
      strategy: { id: PROPOSAL_STRATEGY.id, version: PROPOSAL_STRATEGY.version },
      budget: {
        maxEvaluations: this.budget.maxEvaluations,
        maxEvaluationsPerUnit: this.budget.maxEvaluationsPerUnit,
      },
      baseStateIdentity,
      scope: this.scope,
      from: this.fromMs === null ? null : sec(this.fromMs),
      placements,
      unplaced,
      status,
      report: {
        reportHash: scheduleReportHash(final),
        validator: { id: final.validator.id, version: final.validator.version },
        coverage: [...final.coverage],
        hardConflicts: final.conflicts.filter((c) => c.severity === 'HARD').length,
      },
      metrics: this.metrics(placements, unplaced.length, base),
    };
    return {
      ...body,
      proposalHash: proposalHash(body),
      diagnostics: {
        judgeCalls: this.judgeCalls,
        totalEvaluations: this.totalEvaluations,
        skips: { ...this.skips },
        packingRebuilds: this.packingRebuilds,
      },
    };
  }

  // ─────────────── judge ───────────────

  /** One judge call over base ⊕ `extra` (the extra assignments are synthetic). */
  private evaluate(extra: readonly EvaluationAssignment[], budgeted: boolean) {
    const sameAsBase = extra === this.judge.assignments;
    const assignments = sameAsBase ? extra : [...this.judge.assignments, ...extra];
    const input: ScheduleEvaluationInput = sameAsBase
      ? this.judge
      : {
          ...this.judge,
          watermark: [...this.judge.watermark, ...extra.map((a) => a.id)],
          assignments,
        };
    this.totalEvaluations += 1;
    if (budgeted) this.judgeCalls += 1;
    try {
      return evaluateSchedule(input);
    } catch (e) {
      if (e instanceof ScheduleEvaluationError) return refuse('INVALID_INPUT', e.message);
      throw e;
    }
  }

  // ─────────────── identity (ADR-0075 § 15) ───────────────

  private baseStateIdentity(base: ScheduleConflictReport): ContentHash {
    const statuses = [...this.eventStatus.entries()]
      .sort(([a], [b]) => byStr(a, b))
      .map(([eventId, status]) => ({ eventId, status }));
    const offsets = [...this.latestOffset.entries()]
      .sort(([a], [b]) => byStr(a, b))
      .map(([contestId, seconds]) => ({ contestId, seconds }));
    return hashOf('br:schedule-proposal-base', {
      competitionId: this.judge.competitionId,
      scheduleVersionId: this.judge.scheduleVersionId,
      watermark: sortedUnique(this.judge.watermark),
      basePublishedVersionId: this.input.basePublishedVersionId,
      // The judge's canonical inputs: profiles and spec hashes, zones, windows, resource revisions,
      // availability facts, the 05D occupancy digest and contest statuses (which enumerate contests).
      inputs: base.inputs as unknown as CanonicalValue,
      eventStatuses: statuses,
      latestOffsets: offsets,
      scope: this.scope,
      from: this.fromMs === null ? null : sec(this.fromMs),
      strategy: { id: PROPOSAL_STRATEGY.id, version: PROPOSAL_STRATEGY.version },
      budget: {
        maxEvaluations: this.budget.maxEvaluations,
        maxEvaluationsPerUnit: this.budget.maxEvaluationsPerUnit,
      },
    } as unknown as CanonicalValue);
  }

  // ─────────────── units and targets (ADR-0075 § 7) ───────────────

  /** Unit keys exactly as the judge derives them (per event, with the pinned profile's regrouping). */
  private deriveUnits() {
    const byEvent = new Map<string, EvaluationContest[]>();
    for (const c of this.judge.contests)
      byEvent.set(c.eventId, [...(byEvent.get(c.eventId) ?? []), c]);
    for (const [eventId, contests] of [...byEvent.entries()].sort(([a], [b]) => byStr(a, b))) {
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
  }

  private classifyUnits(): { targets: Target[]; unplaced: ProposalUnplaced[] } {
    const membersOf = new Map<string, EvaluationContest[]>();
    for (const c of [...this.judge.contests]
      .filter((x) => !EXCLUDED.has(x.status))
      .sort(compareContests)) {
      const key = this.unitOf.get(c.id) as string;
      membersOf.set(key, [...(membersOf.get(key) ?? []), c]);
    }
    const depth = this.depths();
    const targets: Target[] = [];
    const unplaced: ProposalUnplaced[] = [];
    for (const [key, members] of [...membersOf.entries()].sort(([a], [b]) => byStr(a, b))) {
      const first = members[0] as EvaluationContest;
      const event = this.events.get(first.eventId) as EvaluationEvent;
      if (this.scope.eventIds !== null && !this.scope.eventIds.includes(event.id)) continue;
      if (this.scope.roundIds !== null && !this.scope.roundIds.includes(first.roundId)) continue;
      const unscheduled = members.filter((c) => !this.liveByContest.has(c.id));
      // Fully placed, or containing settled / published-scheduled contests: not E's to place.
      if (unscheduled.length === 0) continue;
      if (members.some((c) => c.status !== 'PLANNED')) continue;
      const unit: Unit = {
        key,
        event,
        members,
        stageSequence: first.stageSequence,
        roundSequence: first.roundSequence,
        roundId: first.roundId,
        minSequence: Math.min(...members.map((c) => c.sequence)),
        depth: Math.max(...members.map((c) => depth.get(c.id) ?? 0)),
      };
      const allVacant = (c: EvaluationContest) => {
        const ps = this.placesOf.get(c.id) ?? [];
        return ps.length > 0 && ps.every(isVacant);
      };
      let reason: ProposalUnplacedReason | null = null;
      if (unscheduled.length !== members.length) reason = 'PARTIALLY_PLACED';
      else if (event.profile === null) reason = 'NO_PROFILE';
      else if (!SCHEDULABLE_EVENT.has(this.eventStatus.get(event.id) as string))
        reason = 'EVENT_NOT_SCHEDULABLE';
      else if (members.every(allVacant)) reason = 'ALL_VACANT';
      else if (
        members.some((c) => (this.placesOf.get(c.id) ?? []).some((p) => p.state === 'STALE'))
      )
        reason = 'STALE_OCCUPANT';
      if (reason !== null) {
        unplaced.push(this.unplacedOf(unit, reason));
        continue;
      }
      const spec = (event.profile as NonNullable<EvaluationEvent['profile']>).spec;
      const resolved = resolveRequirement(spec, {
        contestType: first.contestType,
        roundType: first.roundType,
        ...(first.stagePrimitive === null ? {} : { stagePrimitive: first.stagePrimitive }),
      });
      if (!resolved.ok)
        refuse('INVALID_INPUT', `contest ${first.id}: requirement resolution ${resolved.reason}`);
      targets.push({
        unit,
        requirement: (resolved as { requirement: SchedulingRequirement }).requirement,
        toPlace: members.filter((c) => !allVacant(c)),
      });
    }
    // ADR-0075 § 9: stage, round, dependency depth, lowest member sequence, event id, unit key.
    targets.sort(
      (a, b) =>
        a.unit.stageSequence - b.unit.stageSequence ||
        a.unit.roundSequence - b.unit.roundSequence ||
        a.unit.depth - b.unit.depth ||
        a.unit.minSequence - b.unit.minSequence ||
        byStr(a.unit.event.id, b.unit.event.id) ||
        byStr(a.unit.key, b.unit.key),
    );
    return { targets, unplaced };
  }

  /** Longest feeder chain per contest over the plan edges (the judge asserts the graph is a DAG). */
  private depths(): Map<string, number> {
    const memo = new Map<string, number>();
    const depthOf = (id: string): number => {
      const hit = memo.get(id);
      if (hit !== undefined) return hit;
      const c = this.contests.get(id);
      const feeders = c === undefined ? [] : c.feeders;
      const d = feeders.length === 0 ? 0 : 1 + Math.max(...feeders.map(depthOf));
      memo.set(id, d);
      return d;
    };
    for (const id of [...this.contests.keys()].sort(byStr)) depthOf(id);
    return memo;
  }

  private unplacedOf(
    unit: Unit,
    reason: ProposalUnplacedReason,
    blocking: readonly string[] = [],
  ): ProposalUnplaced {
    return {
      unitKey: unit.key,
      contestIds: sortedUnique(unit.members.map((c) => c.id)),
      reason,
      blockingConflictKeys: sortedUnique(blocking),
    };
  }

  // ─────────────── one unit (ADR-0075 § 8, § 10) ───────────────

  /** Places one target, or returns why it stays unplaced. */
  private place(t: Target): ProposalUnplaced | null {
    const { unit, requirement: req } = t;
    // A feeder neither settled, cancelled nor scheduled: the judge could not check the dependency.
    for (const c of t.toPlace)
      for (const f of c.feeders) {
        const fc = this.contests.get(f) as EvaluationContest;
        if (EXCLUDED.has(fc.status) || fc.status === 'COMPLETED') continue;
        if (!this.liveByContest.has(f) && !this.placedContests.has(f))
          return this.unplacedOf(unit, 'FEEDER_UNPLACED');
      }
    const compatible = this.resources.filter(
      (r) => r.status === 'ACTIVE' && r.typeCode === req.resourceType,
    );
    if (compatible.length === 0) return this.unplacedOf(unit, 'NO_COMPATIBLE_RESOURCE');

    // Horizon: [max(window start, from), window end) — the judge's window (event, else competition).
    const ev = unit.event;
    const starts = [ev.windowStartMs, this.fromMs].filter((x): x is number => x !== null);
    if (ev.windowEndMs === null || starts.length === 0) return this.unplacedOf(unit, 'NO_HORIZON');
    const lo = ceilSecond(Math.max(...starts));
    const hi = ev.windowEndMs;
    const occupancy = (c: EvaluationContest) =>
      defaultExpectedEnd(0, req, this.latestOffset.get(c.id) as number);
    const longest = Math.max(...t.toPlace.map(occupancy));
    // Every member must END by the window end (the judge's D9 end bound).
    const lastStart = hi - longest;
    if (lastStart < lo) return this.unplacedOf(unit, 'NO_HORIZON');

    const expansionEnd = hi + req.changeoverSeconds * 1000;
    const open = new Map<string, readonly Interval[]>();
    const points = new Set<number>([lo]);
    for (const r of compatible) {
      const x = this.expansion(r, lo, expansionEnd);
      const declaredOpen = intersect(intersect(x.effective, x.declared), [{ start: lo, end: hi }]);
      if (declaredOpen.length > 0) open.set(r.id, declaredOpen);
      for (const i of [...x.effective, ...x.declared]) points.add(ceilSecond(i.start));
    }
    if (open.size === 0) return this.unplacedOf(unit, 'NO_DECLARED_TIME');
    for (const a of this.anchors) for (const c of this.constants) points.add(ceilSecond(a + c));
    // A daily limit is judged by the local date of the start in the event zone (ADR-0073 B6), so
    // the earliest start it allows can be a local-date boundary that no anchor or availability
    // interval produces (e.g. continuous 24 h availability).
    if (req.maxUnitsPerEntrantPerDay !== undefined)
      for (const d of localDateStarts(lo, lastStart, ev.timezone)) points.add(ceilSecond(d));
    const instants = [...points].filter((p) => p >= lo && p <= lastStart).sort((a, b) => a - b);

    let unitCalls = 0;
    let blocking: string[] | null = null;
    for (const instant of instants) {
      // Domain pruning with the judge's own helper (B5/D8): the resource must be declared open
      // over the unit's whole blocking interval at this instant.
      const blockingMs = longest + req.changeoverSeconds * 1000;
      const excluded = new Set<string>();
      const available = compatible.filter((r) => {
        if (!open.has(r.id)) return false;
        const B = {
          start: instant,
          end: instant + (r.occupancyMode === 'EXCLUSIVE' ? blockingMs : longest),
        };
        const cls = classifyExpanded(this.expansion(r, lo, expansionEnd), B);
        return cls.closed.length === 0 && cls.undeclared.length === 0;
      });
      let packingTried = false;
      let nextInstant = false;
      for (const r of available) {
        if (nextInstant) break;
        if (excluded.has(r.id)) continue;
        if (r.occupancyMode === 'EXCLUSIVE' && packingTried) continue;
        if (r.occupancyMode === 'EXCLUSIVE') packingTried = true;
        // SHARED: every member on r. EXCLUSIVE: pack over the remaining EXCLUSIVE resources,
        // rebuilding after each resource-scoped rejection (each rebuild excludes ≥ 1 resource).
        for (;;) {
          const candidate =
            r.occupancyMode === 'SHARED'
              ? t.toPlace.map((contest) => ({ contest, resource: r }))
              : this.pack(
                  t,
                  available.filter((x) => x.occupancyMode === 'EXCLUSIVE' && !excluded.has(x.id)),
                );
          if (candidate === null) break;
          if (this.globalExhausted || this.judgeCalls >= this.budget.maxEvaluations) {
            this.globalExhausted = true;
            return this.unplacedOf(unit, 'BUDGET_EXHAUSTED');
          }
          if (unitCalls >= this.budget.maxEvaluationsPerUnit)
            return this.unplacedOf(unit, 'BUDGET_EXHAUSTED');
          unitCalls += 1;
          const synthetic = this.synthesize(t, candidate, instant);
          const report = this.evaluate([...this.accepted, ...synthetic], true);
          const ids = new Set(synthetic.map((a) => a.id));
          const offending = report.conflicts.filter(
            (c) =>
              (c.severity === 'HARD' || c.code === 'AVAILABILITY_UNDECLARED') &&
              c.assignmentIds.some((id) => ids.has(id)),
          );
          if (blocking === null) blocking = offending.map(conflictKey);
          if (offending.length === 0) {
            this.accept(synthetic);
            return null;
          }
          const classes = new Set(offending.map((c) => searchClassOf(c.code)));
          if (classes.has('UNIT')) {
            this.skips.unit += 1;
            return this.unplacedOf(unit, 'STALE_OCCUPANT', blocking);
          }
          if (classes.has('TIME')) {
            this.skips.time += 1;
            nextInstant = true;
            break;
          }
          this.skips.resource += 1;
          const used = new Set(candidate.map((m) => m.resource.id));
          const named = offending
            .filter((c) => searchClassOf(c.code) === 'RESOURCE')
            .flatMap((c: ScheduleConflict) => c.resourceIds)
            .filter((id) => used.has(id));
          for (const id of named.length > 0 ? named : [...used]) excluded.add(id);
          if (r.occupancyMode === 'SHARED') break;
          this.packingRebuilds += 1;
        }
      }
    }
    return this.unplacedOf(unit, 'NO_FEASIBLE_CANDIDATE', blocking ?? []);
  }

  /**
   * ADR-0073 B9 member packing: members in member order onto EXCLUSIVE resources in tie-break
   * order, each filled while the B2 consumption fits its capacity, then the next. Null when the
   * resources cannot hold every member. Construction only: the judge decides (R1, R3, R4).
   */
  private pack(t: Target, resources: readonly EvaluationResource[]): Candidate | null {
    const out: { contest: EvaluationContest; resource: EvaluationResource }[] = [];
    let i = 0;
    let used = 0;
    for (const contest of t.toPlace) {
      const n =
        t.requirement.capacityUnit === 'CONTEST'
          ? 1
          : (this.placesOf.get(contest.id) ?? []).filter((p) => !isVacant(p)).length;
      for (;;) {
        const r = resources[i];
        if (r === undefined) return null;
        if (used + n <= r.capacity) break;
        i += 1;
        used = 0;
      }
      out.push({ contest, resource: resources[i] as EvaluationResource });
      used += n;
    }
    return out;
  }

  /** Synthetic assignments with 05E-C's write-time defaults (ADR-0075 § 5). */
  private synthesize(t: Target, candidate: Candidate, startMs: number): EvaluationAssignment[] {
    return candidate.map(({ contest, resource }) => ({
      id: `proposal:${contest.id}`,
      contestId: contest.id,
      resourceId: resource.id,
      startMs,
      expectedEndMs: defaultExpectedEnd(
        startMs,
        t.requirement,
        this.latestOffset.get(contest.id) as number,
      ),
      changeoverSeconds: t.requirement.changeoverSeconds,
      recordedUnitKey: this.unitOf.get(contest.id) as string,
    }));
  }

  private accept(synthetic: readonly EvaluationAssignment[]) {
    for (const a of synthetic) {
      this.accepted.push(a);
      this.placedContests.add(a.contestId);
      this.addAnchors(a);
    }
  }

  private addAnchors(a: EvaluationAssignment) {
    this.anchors.add(a.startMs);
    if (a.expectedEndMs === null) return;
    this.anchors.add(a.expectedEndMs);
    const r = a.resourceId === null ? undefined : this.resourceById.get(a.resourceId);
    if (r?.occupancyMode === 'EXCLUSIVE')
      this.anchors.add(a.expectedEndMs + a.changeoverSeconds * 1000);
  }

  /** Availability expanded once per resource and horizon, exactly as the judge's D8 layers. */
  private expansion(r: EvaluationResource, from: number, to: number): AvailabilityExpansion {
    const key = `${r.id}|${from}|${to}`;
    const hit = this.expansions.get(key);
    if (hit !== undefined) return hit;
    const layer = (resourceId: string | null) =>
      this.judge.availability
        .filter((f) => f.resourceId === resourceId)
        .sort((a, b) => byStr(a.id, b.id))
        .map((f) => f.fact);
    const x = expandAvailability(
      {
        status: r.status,
        resource: { zone: r.zone, facts: layer(r.id) },
        competition: { zone: this.judge.competitionTimezone, facts: layer(null) },
      },
      from,
      to,
    );
    this.expansions.set(key, x);
    return x;
  }

  // ─────────────── result ───────────────

  private status(
    targets: readonly Target[],
    decided: ReadonlyMap<string, ProposalUnplaced | null>,
  ): ProposalStatus {
    if (targets.length === 0) return 'NOTHING_TO_PLACE';
    if (this.globalExhausted) return 'SEARCH_EXHAUSTED';
    const failed = [...decided.values()].filter((u): u is ProposalUnplaced => u !== null);
    if (failed.length === 0) return 'SUCCESS';
    if (failed.length === targets.length && failed.every((u) => EMPTY_DOMAIN.has(u.reason)))
      return 'NO_CANDIDATES';
    if (failed.some((u) => u.reason !== 'BUDGET_EXHAUSTED')) return 'INFEASIBLE';
    // Only per-unit budgets ended: the search was cut short, not completed.
    return 'SEARCH_EXHAUSTED';
  }

  private placements(final: ScheduleConflictReport): ProposalPlacement[] {
    const soft = new Map<string, string[]>();
    for (const c of final.conflicts)
      if (c.severity === 'SOFT')
        for (const id of c.assignmentIds) soft.set(id, [...(soft.get(id) ?? []), conflictKey(c)]);
    return [...this.accepted]
      .sort((a, b) => byStr(a.contestId, b.contestId))
      .map((a) => {
        const contest = this.contests.get(a.contestId) as EvaluationContest;
        const places = this.placesOf.get(a.contestId) ?? [];
        return {
          contestId: a.contestId,
          unitKey: a.recordedUnitKey as string,
          resourceId: a.resourceId as string,
          start: sec(a.startMs),
          expectedEnd: sec(a.expectedEndMs as number),
          changeoverSeconds: a.changeoverSeconds,
          zone: (this.events.get(contest.eventId) as EvaluationEvent).timezone,
          // 05E-C: a place still open, or a dynamic contest with nobody yet.
          provisional:
            places.some((p) => p.occupantId === null) ||
            (contest.dynamic && places.every((p) => p.occupantId === null)),
          softConflictKeys: sortedUnique(soft.get(a.id) ?? []),
        };
      });
  }

  private metrics(
    placements: readonly ProposalPlacement[],
    unplacedUnits: number,
    base: ScheduleConflictReport,
  ): ProposalMetrics {
    const busy = new Map<string, number>();
    for (const p of placements)
      busy.set(p.resourceId, (busy.get(p.resourceId) ?? 0) + (p.expectedEnd - p.start));
    const earliestStart =
      placements.length === 0 ? null : Math.min(...placements.map((p) => p.start));
    const latestEnd =
      placements.length === 0 ? null : Math.max(...placements.map((p) => p.expectedEnd));
    return {
      placedUnits: new Set(placements.map((p) => p.unitKey)).size,
      placedContests: placements.length,
      unplacedUnits,
      placementsWithSoftConflicts: placements.filter((p) => p.softConflictKeys.length > 0).length,
      earliestStart,
      latestEnd,
      makespanSeconds: earliestStart === null || latestEnd === null ? 0 : latestEnd - earliestStart,
      busySeconds: [...busy.entries()]
        .sort(([a], [b]) => byStr(a, b))
        .map(([resourceId, seconds]) => ({ resourceId, seconds })),
      baseHardConflicts: base.conflicts.filter((c) => c.severity === 'HARD').length,
    };
  }
}

/** ADR-0075 § 15: SHA-256 over the canonical (RFC 8785) semantic proposal, domain-separated. */
export function proposalHash(body: ScheduleProposalBody): ContentHash {
  const canonical: ScheduleProposalBody = {
    proposalVersion: body.proposalVersion,
    strategy: body.strategy,
    budget: body.budget,
    baseStateIdentity: body.baseStateIdentity,
    scope: body.scope,
    from: body.from,
    placements: body.placements,
    unplaced: body.unplaced,
    status: body.status,
    report: body.report,
    metrics: body.metrics,
  };
  return hashOf('br:schedule-proposal', canonical as unknown as CanonicalValue);
}
