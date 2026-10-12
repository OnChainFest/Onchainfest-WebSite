import type { ContestType } from '../catalog';
import type { RoundType } from '../format/engine';
import type { StagePrimitive } from '../format/plan-v2';
import type { ContestStatus } from '../lifecycle';
import type { AvailabilityFact } from '../resources/availability';
import type { OccupancyMode } from '../resources/resource';
import type {
  EvaluationAssignment,
  EvaluationAvailabilityFact,
  EvaluationContest,
  EvaluationEntrant,
  EvaluationEvent,
  EvaluationPlace,
  EvaluationResource,
  PlaceState,
  ScheduleEvaluationInput,
} from './engine';
import type { SchedulingProfileSpec, SchedulingRequirement } from './profile';
import type { ScheduleConflictReport } from './report';

/**
 * Test-only builder for `ScheduleEvaluationInput` (ONCF-05E-D). Not exported by the package.
 * Times are minutes from T0 (2026-11-14 08:00 UTC, a Saturday) unless given in milliseconds.
 */

export const T0 = Date.UTC(2026, 10, 14, 8, 0, 0);
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const at = (minutes: number) => T0 + minutes * MIN;

export const spec = (...requirements: Partial<SchedulingRequirement>[]): SchedulingProfileSpec => ({
  specVersion: 1,
  requirements: requirements.map((r) => ({
    selector: {},
    resourceType: 'TENNIS_COURT',
    capacityUnit: 'CONTEST',
    expectedDurationSeconds: 3_600,
    changeoverSeconds: 0,
    ...r,
  })) as SchedulingRequirement[],
});

/** Open every weekday 00:00–24:00 (declares all time: no AVAILABILITY_UNDECLARED noise). */
export const ALWAYS_OPEN: readonly AvailabilityFact[] = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
  kind: 'WEEKLY',
  weekday,
  start: '00:00',
  end: '24:00',
}));

interface ContestOpts {
  readonly event?: string;
  readonly round?: string;
  readonly roundSeq?: number;
  readonly stage?: string | null;
  readonly stageSeq?: number;
  readonly grouped?: boolean;
  readonly dynamic?: boolean;
  readonly type?: ContestType;
  readonly roundType?: RoundType;
  readonly primitive?: StagePrimitive | null;
  readonly partitionKey?: string | null;
  readonly status?: ContestStatus;
  readonly feeders?: readonly string[];
  /** Fixed entrants (one FIXED place each). */
  readonly entrants?: readonly string[];
  readonly unitParticipant?: string | null;
  readonly unitOrdinal?: number | null;
}

export class World {
  competitionTimezone = 'UTC';
  readonly contests: EvaluationContest[] = [];
  readonly places: EvaluationPlace[] = [];
  readonly entrants: EvaluationEntrant[] = [];
  readonly events: EvaluationEvent[] = [];
  readonly resources: EvaluationResource[] = [];
  availability: EvaluationAvailabilityFact[] = [];
  readonly assignments: EvaluationAssignment[] = [];
  readonly base: EvaluationAssignment[] = [];
  private seq = 0;

  constructor(open = true) {
    if (open)
      this.availability = ALWAYS_OPEN.map((fact, i) => ({
        id: `avail-open-${i + 1}`,
        resourceId: null,
        fact,
      }));
  }

  event(
    id: string,
    o: {
      profile?: SchedulingProfileSpec | null;
      timezone?: string;
      windowStartMs?: number | null;
      windowEndMs?: number | null;
    } = {},
  ): this {
    this.events.push({
      id,
      timezone: o.timezone ?? 'UTC',
      windowStartMs: o.windowStartMs ?? null,
      windowEndMs: o.windowEndMs ?? null,
      profile:
        o.profile === undefined || o.profile === null
          ? null
          : { versionId: `pv-${id}`, specHash: `sha256:${'0'.repeat(63)}1`, spec: o.profile },
    });
    return this;
  }

  resource(
    id: string,
    o: {
      type?: string;
      mode?: OccupancyMode;
      capacity?: number;
      keys?: readonly string[];
      zone?: string;
      status?: 'ACTIVE' | 'RETIRED';
      revisionId?: string;
    } = {},
  ): this {
    this.resources.push({
      id,
      revisionId: o.revisionId ?? `rev-${id}`,
      typeCode: o.type ?? 'TENNIS_COURT',
      occupancyMode: o.mode ?? 'EXCLUSIVE',
      capacity: o.capacity ?? 1,
      exclusivityKeys: o.keys ?? [`k-${id}`],
      zone: o.zone ?? 'UTC',
      status: o.status ?? 'ACTIVE',
    });
    return this;
  }

  fact(id: string, resourceId: string | null, fact: AvailabilityFact): this {
    this.availability.push({ id, resourceId, fact });
    return this;
  }

  entrant(id: string, o: { kind?: 'INDIVIDUAL' | 'TEAM'; persons?: readonly string[] } = {}): this {
    this.entrants.push({ id, kind: o.kind ?? 'INDIVIDUAL', personIds: o.persons ?? [`p-${id}`] });
    return this;
  }

  contest(id: string, o: ContestOpts = {}): this {
    this.seq += 1;
    this.contests.push({
      id,
      eventId: o.event ?? 'e1',
      roundId: o.round ?? 'r1',
      roundSequence: o.roundSeq ?? 1,
      stageId: o.stage === undefined ? 's1' : o.stage,
      stageSequence: o.stageSeq ?? 1,
      grouped: o.grouped ?? false,
      dynamic: o.dynamic ?? false,
      contestType: o.type ?? 'MATCH',
      roundType: o.roundType ?? 'KNOCKOUT',
      stagePrimitive: o.primitive === undefined ? 'KNOCKOUT' : o.primitive,
      sequence: this.seq,
      partitionKey: o.partitionKey ?? null,
      status: o.status ?? 'SCHEDULED',
      unitParticipantId: o.unitParticipant ?? null,
      unitFieldOrdinal: o.unitOrdinal ?? null,
      feeders: o.feeders ?? [],
    });
    (o.entrants ?? []).forEach((e, i) => this.place(id, i + 1, { state: 'FIXED', occupant: e }));
    return this;
  }

  place(
    contestId: string,
    place: number,
    o: {
      state?: PlaceState;
      occupant?: string | null;
      feeders?: readonly string[];
      sourceKind?: string;
      factId?: string | null;
    } = {},
  ): this {
    const state = o.state ?? 'UNRESOLVED';
    this.places.push({
      contestId,
      place,
      sourceKind: o.sourceKind ?? (state === 'FIXED' ? 'PARTICIPANT' : 'WINNER_OF_CONTEST'),
      state,
      occupantId: o.occupant ?? null,
      factId:
        o.factId ??
        (state === 'FIXED' || state === 'UNRESOLVED' ? null : `fact-${contestId}-${place}`),
      feeders: o.feeders ?? [],
    });
    // A dependent place is a plan edge of its contest.
    const c = this.contests.find((x) => x.id === contestId);
    if (c !== undefined && (o.feeders ?? []).length > 0) {
      const i = this.contests.indexOf(c);
      this.contests[i] = { ...c, feeders: [...new Set([...c.feeders, ...(o.feeders ?? [])])] };
    }
    return this;
  }

  /** `start`/`end` in minutes from T0 (or `startMs` / `endMs`); `end: null` = no expected end. */
  assign(
    contestId: string,
    o: {
      resource?: string | null;
      start?: number;
      end?: number | null;
      startMs?: number;
      endMs?: number | null;
      changeover?: number;
      unitKey?: string | null;
      id?: string;
      base?: boolean;
    } = {},
  ): this {
    const startMs = o.startMs ?? at(o.start ?? 0);
    const endMs =
      o.endMs !== undefined ? o.endMs : o.end === null ? null : at(o.end ?? (o.start ?? 0) + 60);
    const a: EvaluationAssignment = {
      id: o.id ?? `${o.base === true ? 'base' : 'a'}-${contestId}`,
      contestId,
      resourceId: o.resource === undefined ? null : o.resource,
      startMs,
      expectedEndMs: endMs,
      changeoverSeconds: o.changeover ?? 0,
      recordedUnitKey: o.unitKey ?? null,
    };
    (o.base === true ? this.base : this.assignments).push(a);
    return this;
  }

  input(): ScheduleEvaluationInput {
    return {
      competitionId: 'comp-1',
      competitionTimezone: this.competitionTimezone,
      scheduleVersionId: 'version-2',
      watermark: this.assignments.map((a) => a.id),
      assignments: this.assignments,
      baseAssignments: this.base,
      contests: this.contests,
      places: this.places,
      entrants: this.entrants,
      events: this.events,
      resources: this.resources,
      availability: this.availability,
    };
  }
}

export const codes = (r: ScheduleConflictReport) => r.conflicts.map((c) => c.code);
export const ofCode = (r: ScheduleConflictReport, code: string) =>
  r.conflicts.filter((c) => c.code === code);

/** A defined array element (test convenience; fails loudly instead of spreading undefined). */
export function must<T>(x: T | undefined): T {
  if (x === undefined) throw new Error('fixture: missing element');
  return x;
}
