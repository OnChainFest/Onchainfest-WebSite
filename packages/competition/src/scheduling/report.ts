import {
  buildPreimage,
  compareUtf16,
  serializeJcs,
  sha256,
  toContentHash,
  type CanonicalValue,
  type ContentHash,
} from '@br/canonical';

/**
 * The schedule conflict-report CONTRACT (ONCF-05E-C, ADR-0071 + ADR-0073 B1/B7). 05E-C owns the
 * shape, the vocabulary, the canonical form and the hash; it does not decide feasibility. The 05E-C
 * baseline validator fills it with the few structural checks it may run, and declares exactly those
 * in `coverage`; the 05E-D engine will fill it with every other code, without changing this module.
 *
 * Determinism: lists are sorted, pairwise conflicts collapse to one, conflicts are ordered by the
 * seven frozen keys, and nothing depends on insertion order, map iteration, wall-clock or randomness.
 * Instants are epoch SECONDS (assignments are whole seconds, ADR-0073 B4).
 */

/** Every conflict code: ADR-0071 (unchanged) + the six added by ADR-0073. */
export const ConflictCode = {
  // ADR-0071 HARD
  RESOURCE_OVERLAP: 'RESOURCE_OVERLAP',
  EXCLUSIVITY_CONFLICT: 'EXCLUSIVITY_CONFLICT',
  CAPACITY_EXCEEDED: 'CAPACITY_EXCEEDED',
  RESOURCE_TYPE_MISMATCH: 'RESOURCE_TYPE_MISMATCH',
  RESOURCE_UNAVAILABLE: 'RESOURCE_UNAVAILABLE',
  PARTICIPANT_OVERLAP: 'PARTICIPANT_OVERLAP',
  TEAM_OVERLAP: 'TEAM_OVERLAP',
  DEPENDENCY_ORDER: 'DEPENDENCY_ORDER',
  LOCKED_ASSIGNMENT_VIOLATION: 'LOCKED_ASSIGNMENT_VIOLATION',
  OUTSIDE_EVENT_WINDOW: 'OUTSIDE_EVENT_WINDOW',
  STALE_OCCUPANT: 'STALE_OCCUPANT',
  // ADR-0071 SOFT (SHORT_REST and MAX_CONTESTS_PER_DAY follow the requirement's enforcement)
  SHORT_REST: 'SHORT_REST',
  LONG_WAIT: 'LONG_WAIT',
  MAX_CONTESTS_PER_DAY: 'MAX_CONTESTS_PER_DAY',
  UNDERUSED_RESOURCE: 'UNDERUSED_RESOURCE',
  SEQUENCING_INEFFICIENCY: 'SEQUENCING_INEFFICIENCY',
  // ADR-0073
  START_SPACING: 'START_SPACING',
  CONCURRENT_STARTS_EXCEEDED: 'CONCURRENT_STARTS_EXCEEDED',
  UNIT_SPLIT: 'UNIT_SPLIT',
  AVAILABILITY_UNDECLARED: 'AVAILABILITY_UNDECLARED',
  ROUND_SEQUENCE: 'ROUND_SEQUENCE',
  INCOMPLETE_ASSIGNMENT: 'INCOMPLETE_ASSIGNMENT',
} as const;
export type ConflictCode = (typeof ConflictCode)[keyof typeof ConflictCode];
export const CONFLICT_CODES: readonly ConflictCode[] = Object.values(ConflictCode);

export type ConflictSeverity = 'HARD' | 'SOFT';
export type ConflictCertainty = 'CERTAIN' | 'POSSIBLE';

/** Fixed severity per code; `ENFORCEMENT` = the governing requirement's HARD/SOFT enforcement. */
export const CONFLICT_SEVERITY: Readonly<Record<ConflictCode, ConflictSeverity | 'ENFORCEMENT'>> = {
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
  SHORT_REST: 'ENFORCEMENT',
  LONG_WAIT: 'SOFT',
  MAX_CONTESTS_PER_DAY: 'ENFORCEMENT',
  UNDERUSED_RESOURCE: 'SOFT',
  SEQUENCING_INEFFICIENCY: 'SOFT',
  START_SPACING: 'HARD',
  CONCURRENT_STARTS_EXCEEDED: 'HARD',
  UNIT_SPLIT: 'HARD',
  AVAILABILITY_UNDECLARED: 'SOFT',
  ROUND_SEQUENCE: 'SOFT',
  INCOMPLETE_ASSIGNMENT: 'SOFT',
};

/** Half-open `[start, end)` in epoch seconds. */
export interface ReportInterval {
  readonly start: number;
  readonly end: number;
}

export interface ScheduleConflict {
  readonly code: ConflictCode;
  readonly severity: ConflictSeverity;
  readonly certainty: ConflictCertainty;
  /** The earliest involved blocking interval (ADR-0073 I-B7.2). */
  readonly interval: ReportInterval;
  readonly unitKeys: readonly string[];
  readonly contestIds: readonly string[];
  readonly assignmentIds: readonly string[];
  readonly resourceIds: readonly string[];
  /** Capacity conflicts: what each claim consumes. */
  readonly consumption?: readonly {
    readonly assignmentId: string;
    readonly resourceId: string;
    readonly units: number;
  }[];
  /** Participant conflicts. */
  readonly personIds?: readonly string[];
  readonly entrantIds?: readonly string[];
  /** The requirement whose constraint is violated (canonical requirement index of the pinned spec). */
  readonly requirement?: {
    readonly eventId: string;
    readonly profileVersionId: string;
    readonly requirementIndex: number;
  };
  readonly expected?: number | string;
  readonly actual?: number | string;
}

/** Absent values are omitted in the canonical form (null on input is accepted and dropped). */
export interface ScheduleReportEventInput {
  readonly eventId: string;
  readonly profileVersionId?: string | null;
  readonly specHash?: string | null;
  readonly timezone: string;
  readonly windowStart?: number | null;
  readonly windowEnd?: number | null;
}

export interface ScheduleReportInputs {
  readonly events: readonly ScheduleReportEventInput[];
  readonly resourceRevisionIds: readonly string[];
  readonly availabilityFactIds: readonly string[];
  /** Digest of the 05D occupancy the report used. */
  readonly occupancyDigest: string;
  readonly contestStatuses: readonly { readonly contestId: string; readonly status: string }[];
}

export interface ScheduleConflictReport {
  readonly reportVersion: 1;
  readonly competitionId: string;
  readonly scheduleVersionId: string;
  /** Content watermark: the current assignment fact ids evaluated. */
  readonly assignmentIds: readonly string[];
  readonly inputs: ScheduleReportInputs;
  readonly validator: { readonly id: string; readonly version: number };
  /** The codes this validator evaluated; it claims nothing about any other code (ADR-0073 I-B1.2). */
  readonly coverage: readonly ConflictCode[];
  readonly conflicts: readonly ScheduleConflict[];
}

export class ScheduleReportError extends Error {}

const sorted = (xs: readonly string[] | undefined): string[] =>
  [...new Set(xs ?? [])].sort(compareUtf16);

function compareLists(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = compareUtf16(a[i] as string, b[i] as string);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

const absent = (v: unknown): v is null | undefined => v === null || v === undefined;
const isSeconds = (n: number) => Number.isSafeInteger(n) && n >= 0;

/** One conflict in canonical form: lists sorted and de-duplicated, absent optionals omitted. */
export function canonicalConflict(c: ScheduleConflict): ScheduleConflict {
  if (!CONFLICT_CODES.includes(c.code)) throw new ScheduleReportError(`unknown code ${c.code}`);
  const fixed = CONFLICT_SEVERITY[c.code];
  if (fixed !== 'ENFORCEMENT' && fixed !== c.severity)
    throw new ScheduleReportError(`${c.code} is always ${fixed}`);
  if (c.severity !== 'HARD' && c.severity !== 'SOFT')
    throw new ScheduleReportError('severity must be HARD or SOFT');
  if (c.certainty !== 'CERTAIN' && c.certainty !== 'POSSIBLE')
    throw new ScheduleReportError('certainty must be CERTAIN or POSSIBLE');
  if (
    !isSeconds(c.interval.start) ||
    !isSeconds(c.interval.end) ||
    c.interval.end < c.interval.start
  )
    throw new ScheduleReportError('the interval must be [start, end) in whole epoch seconds');
  const consumption =
    c.consumption === undefined
      ? undefined
      : [...c.consumption]
          .map((x) => {
            if (!Number.isSafeInteger(x.units) || x.units < 0)
              throw new ScheduleReportError('consumption units must be a non-negative integer');
            return { assignmentId: x.assignmentId, resourceId: x.resourceId, units: x.units };
          })
          .sort(
            (a, b) =>
              compareUtf16(a.assignmentId, b.assignmentId) ||
              compareUtf16(a.resourceId, b.resourceId) ||
              a.units - b.units,
          );
  return {
    code: c.code,
    severity: c.severity,
    certainty: c.certainty,
    interval: { start: c.interval.start, end: c.interval.end },
    unitKeys: sorted(c.unitKeys),
    contestIds: sorted(c.contestIds),
    assignmentIds: sorted(c.assignmentIds),
    resourceIds: sorted(c.resourceIds),
    ...(consumption === undefined ? {} : { consumption }),
    ...(c.personIds === undefined ? {} : { personIds: sorted(c.personIds) }),
    ...(c.entrantIds === undefined ? {} : { entrantIds: sorted(c.entrantIds) }),
    ...(c.requirement === undefined
      ? {}
      : {
          requirement: {
            eventId: c.requirement.eventId,
            profileVersionId: c.requirement.profileVersionId,
            requirementIndex: c.requirement.requirementIndex,
          },
        }),
    ...(c.expected === undefined ? {} : { expected: c.expected }),
    ...(c.actual === undefined ? {} : { actual: c.actual }),
  };
}

const primary = (xs: readonly string[] | undefined): string => xs?.[0] ?? '';
const participant = (c: ScheduleConflict) =>
  sorted([...(c.personIds ?? []), ...(c.entrantIds ?? [])])[0] ?? '';

/**
 * The frozen total order (ADR-0073 B7), over canonical conflicts:
 * 1 severity (HARD first) · 2 interval start, then end · 3 code · 4 primary resource id (absent
 * first) · 5 unit keys · 6 person / entrant id (absent first) · 7 assignment fact ids.
 */
export function compareConflicts(a: ScheduleConflict, b: ScheduleConflict): number {
  return (
    (a.severity === b.severity ? 0 : a.severity === 'HARD' ? -1 : 1) ||
    a.interval.start - b.interval.start ||
    a.interval.end - b.interval.end ||
    compareUtf16(a.code, b.code) ||
    compareUtf16(primary(a.resourceIds), primary(b.resourceIds)) ||
    compareLists(a.unitKeys, b.unitKeys) ||
    compareUtf16(participant(a), participant(b)) ||
    compareLists(a.assignmentIds, b.assignmentIds) ||
    // Full content as the final tie-break, so equal sort keys still order deterministically.
    compareUtf16(
      serializeJcs(a as unknown as CanonicalValue),
      serializeJcs(b as unknown as CanonicalValue),
    )
  );
}

/**
 * The canonical key of a conflict (its code + sort keys 2–7): what a publication acknowledges.
 * A different report content changes the key, so an acknowledgement never carries over.
 */
export function conflictKey(c: ScheduleConflict): string {
  const x = canonicalConflict(c);
  const tuple = [
    x.code,
    x.interval.start,
    x.interval.end,
    primary(x.resourceIds),
    x.unitKeys,
    participant(x),
    x.assignmentIds,
  ] as unknown as CanonicalValue;
  return hashOf('br:schedule-conflict-key', tuple);
}

function hashOf(schemaId: string, value: CanonicalValue): ContentHash {
  return toContentHash(
    sha256(
      buildPreimage('ledger-fact', schemaId, 1, new TextEncoder().encode(serializeJcs(value))),
    ),
  );
}

/**
 * The canonical report: inputs sorted, conflicts canonicalized, pairwise duplicates collapsed (A/B
 * and B/A are one conflict once their lists are sorted), ordered by `compareConflicts`. Every
 * conflict's code must be inside the declared coverage.
 */
export function canonicalScheduleReport(r: ScheduleConflictReport): ScheduleConflictReport {
  const coverage = [...new Set(r.coverage)].sort(compareUtf16) as ConflictCode[];
  for (const c of coverage)
    if (!CONFLICT_CODES.includes(c)) throw new ScheduleReportError(`unknown code ${c}`);
  const unique = new Map<string, ScheduleConflict>();
  for (const c of r.conflicts) {
    if (!coverage.includes(c.code))
      throw new ScheduleReportError(`${c.code} is outside the report's coverage`);
    const x = canonicalConflict(c);
    unique.set(serializeJcs(x as unknown as CanonicalValue), x);
  }
  // JCS has no null: an absent profile or window is an omitted member.
  const ev = [...r.inputs.events]
    .map(
      (e) =>
        ({
          eventId: e.eventId,
          ...(absent(e.profileVersionId) ? {} : { profileVersionId: e.profileVersionId }),
          ...(absent(e.specHash) ? {} : { specHash: e.specHash }),
          timezone: e.timezone,
          ...(absent(e.windowStart) ? {} : { windowStart: e.windowStart }),
          ...(absent(e.windowEnd) ? {} : { windowEnd: e.windowEnd }),
        }) as ScheduleReportEventInput,
    )
    .sort((a, b) => compareUtf16(a.eventId, b.eventId));
  return {
    reportVersion: 1,
    competitionId: r.competitionId,
    scheduleVersionId: r.scheduleVersionId,
    assignmentIds: sorted(r.assignmentIds),
    inputs: {
      events: ev,
      resourceRevisionIds: sorted(r.inputs.resourceRevisionIds),
      availabilityFactIds: sorted(r.inputs.availabilityFactIds),
      occupancyDigest: r.inputs.occupancyDigest,
      contestStatuses: [...r.inputs.contestStatuses]
        .map((s) => ({ contestId: s.contestId, status: s.status }))
        .sort((a, b) => compareUtf16(a.contestId, b.contestId)),
    },
    validator: { id: r.validator.id, version: r.validator.version },
    coverage,
    conflicts: [...unique.values()].sort(compareConflicts),
  };
}

/** SHA-256 over the canonical JSON (RFC 8785) of the canonical report, domain-separated. */
export function scheduleReportHash(r: ScheduleConflictReport): ContentHash {
  return hashOf(
    'br:schedule-conflict-report',
    canonicalScheduleReport(r) as unknown as CanonicalValue,
  );
}

/** What publication needs from a report: HARD count and the keys of its SOFT conflicts. */
export function reportVerdict(r: ScheduleConflictReport): {
  readonly hard: number;
  readonly softKeys: readonly string[];
} {
  const c = canonicalScheduleReport(r);
  return {
    hard: c.conflicts.filter((x) => x.severity === 'HARD').length,
    softKeys: c.conflicts
      .filter((x) => x.severity === 'SOFT')
      .map(conflictKey)
      .sort(compareUtf16),
  };
}

/** Deterministic digest of a sorted list of facts (watermarks, 05D occupancy). */
export function scheduleDigest(schemaId: string, rows: readonly CanonicalValue[]): ContentHash {
  return hashOf(schemaId, rows as unknown as CanonicalValue);
}
