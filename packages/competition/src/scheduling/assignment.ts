import type { OccupancyMode } from '../resources/resource';
import {
  resolveRequirement,
  type SchedulingContestFacts,
  type SchedulingProfileSpec,
} from './profile';
import {
  ConflictCode,
  type ScheduleConflict,
  type ScheduleConflictReport,
  type ScheduleReportInputs,
} from './report';

/**
 * Concrete assignments (ONCF-05E-C, ADR-0070 + ADR-0073 B8). An assignment stores the concrete
 * interval and changeover; the profile only supplies their write-time DEFAULTS. Nothing here judges
 * feasibility (overlap, capacity, spacing, participants, rest, dependencies, availability, daily
 * limits): that is the 05E-D engine. Instants are whole seconds (ADR-0073 B4).
 */

export const isWholeSecond = (ms: number) => Number.isSafeInteger(ms) && ms % 1000 === 0;

/** Default expected end: start + the contest's latest plan start offset + expected duration. */
export function defaultExpectedEnd(
  startMs: number,
  requirement: { readonly expectedDurationSeconds: number },
  latestOffsetSeconds: number,
): number {
  return startMs + (latestOffsetSeconds + requirement.expectedDurationSeconds) * 1000;
}

/** Occupancy O = [start, expectedEnd); blocking B adds the stored changeover on EXCLUSIVE resources. */
export function blockingEnd(a: {
  readonly startMs: number;
  readonly expectedEndMs: number | null;
  readonly changeoverSeconds: number;
  readonly occupancyMode: OccupancyMode | null;
}): number {
  const end = a.expectedEndMs ?? a.startMs;
  return a.occupancyMode === 'EXCLUSIVE' ? end + a.changeoverSeconds * 1000 : end;
}

export interface BaselineAssignment {
  readonly assignmentId: string;
  readonly contestId: string;
  readonly eventId: string;
  readonly unitKey: string | null;
  readonly resourceId: string | null;
  readonly resourceType: string | null;
  readonly occupancyMode: OccupancyMode | null;
  readonly startMs: number;
  readonly expectedEndMs: number | null;
  readonly changeoverSeconds: number;
  readonly contest: SchedulingContestFacts;
}

export interface BaselineEvent {
  readonly profile: {
    readonly versionId: string;
    readonly spec: SchedulingProfileSpec;
  } | null;
  readonly windowStartMs: number | null;
  readonly windowEndMs: number | null;
}

/** The 05E-C baseline validator: structural checks only, declared as its coverage. */
export const BASELINE_VALIDATOR = { id: 'br:schedule-baseline-validator', version: 1 } as const;
export const BASELINE_COVERAGE = [
  ConflictCode.INCOMPLETE_ASSIGNMENT,
  ConflictCode.OUTSIDE_EVENT_WINDOW,
  ConflictCode.RESOURCE_TYPE_MISMATCH,
] as const;

const sec = (ms: number) => Math.floor(ms / 1000);

export function baselineScheduleReport(input: {
  readonly competitionId: string;
  readonly scheduleVersionId: string;
  readonly assignments: readonly BaselineAssignment[];
  readonly events: ReadonlyMap<string, BaselineEvent>;
  readonly inputs: ScheduleReportInputs;
}): ScheduleConflictReport {
  const conflicts: ScheduleConflict[] = [];
  for (const a of input.assignments) {
    const ev = input.events.get(a.eventId);
    const subject = {
      certainty: 'CERTAIN' as const,
      interval: { start: sec(a.startMs), end: sec(blockingEnd(a)) },
      unitKeys: a.unitKey === null ? [] : [a.unitKey],
      contestIds: [a.contestId],
      assignmentIds: [a.assignmentId],
      resourceIds: a.resourceId === null ? [] : [a.resourceId],
    };
    const resolved =
      ev?.profile === null || ev?.profile === undefined
        ? undefined
        : resolveRequirement(ev.profile.spec, a.contest);
    const requirement =
      resolved?.ok === true && ev?.profile !== null && ev?.profile !== undefined
        ? {
            eventId: a.eventId,
            profileVersionId: ev.profile.versionId,
            requirementIndex: resolved.index,
          }
        : undefined;
    // A missing expected end, or a missing resource where the pinned profile requires one, is never
    // silently complete (ADR-0073 I-B8.3).
    const missing = [
      ...(a.expectedEndMs === null ? ['expectedEnd'] : []),
      ...(requirement !== undefined && a.resourceId === null ? ['resource'] : []),
    ];
    if (missing.length > 0)
      conflicts.push({
        ...subject,
        code: 'INCOMPLETE_ASSIGNMENT',
        severity: 'SOFT',
        ...(requirement === undefined ? {} : { requirement }),
        actual: missing.join(','),
      });
    if (
      ev !== undefined &&
      ((ev.windowStartMs !== null && a.startMs < ev.windowStartMs) ||
        (ev.windowEndMs !== null && (a.expectedEndMs ?? a.startMs) > ev.windowEndMs))
    )
      conflicts.push({ ...subject, code: 'OUTSIDE_EVENT_WINDOW', severity: 'HARD' });
    if (
      requirement !== undefined &&
      resolved?.ok === true &&
      a.resourceType !== null &&
      a.resourceType !== resolved.requirement.resourceType
    )
      conflicts.push({
        ...subject,
        code: 'RESOURCE_TYPE_MISMATCH',
        severity: 'HARD',
        requirement,
        expected: resolved.requirement.resourceType,
        actual: a.resourceType,
      });
  }
  return {
    reportVersion: 1,
    competitionId: input.competitionId,
    scheduleVersionId: input.scheduleVersionId,
    assignmentIds: input.assignments.map((a) => a.assignmentId),
    inputs: input.inputs,
    validator: BASELINE_VALIDATOR,
    coverage: BASELINE_COVERAGE,
    conflicts,
  };
}
