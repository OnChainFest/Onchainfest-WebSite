import { getPublic, type Fetched } from './api';
import type { Contest, Slot, StructureRound } from './competition';
import { groupName, ordinalLabel, partitionLabel } from './competition';
import { apiRequest, type ApiResult } from './platform';
import {
  addDays,
  dayStart,
  readinessOf,
  shortDateText,
  typeLabel,
  type AvailabilityFactView,
  type ResourceView,
} from './resources';
import type { EventScoring } from './scoring';
import type { FieldParticipant, Readiness as StructureReadiness } from './structure';
import { instantToZoned } from './tournament-builder';
import type { Catalog, ManagedCompetition, ManagedEvent } from './tournaments';

/**
 * ONCF-L3 scheduling workspace. Everything here reads or presents the ONCF-05E-C/D/E/F API: schedule
 * versions (one open DRAFT, one PUBLISHED), the conflict report, and the read-only proposal preview
 * whose hash the commit re-checks. Nothing here places a match, judges a conflict or decides
 * readiness for the scheduler — the API does. The web only translates codes into organizer language
 * and lines contests up with their courts and times.
 */

// ───────────────────────────── API shapes ─────────────────────────────

export type VersionStatus = 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED' | 'DISCARDED';

export interface ScheduleVersion {
  versionId: string;
  competitionId: string;
  versionNumber: number;
  baseVersionId: string | null;
  status: VersionStatus;
  createdAt: string;
  statusChangedAt: string;
}

export interface Assignment {
  assignmentId: string;
  contestId: string;
  resourceId: string | null;
  startsAt: string;
  expectedEnd: string | null;
  changeoverSeconds: number;
  zone: string;
  unitKey: string | null;
  provisional: boolean;
  locked: boolean;
  locationLabel: string | null;
  courtLabel: string | null;
  source: 'MANUAL' | 'CARRIED' | 'MIGRATED';
}

export interface VersionDetail extends ScheduleVersion {
  assignments: Assignment[];
  publication: {
    reportHash: string;
    acknowledgedConflictKeys: string[];
    supersededVersionId: string | null;
    publishedAt: string;
  } | null;
}

export type Severity = 'HARD' | 'SOFT';

export interface ConflictView {
  conflictKey: string;
  code: string;
  severity: Severity;
  certainty: 'CERTAIN' | 'POSSIBLE';
  /** Epoch seconds, half-open. */
  interval: { start: number; end: number };
  contestIds: string[];
  resourceIds: string[];
  entrantIds?: string[];
}

export interface Validation {
  reportHash: string;
  hardConflicts: number;
  conflicts: ConflictView[];
}

export type ProposalStatus =
  'SUCCESS' | 'NOTHING_TO_PLACE' | 'NO_CANDIDATES' | 'INFEASIBLE' | 'SEARCH_EXHAUSTED';

export interface Placement {
  contestId: string;
  unitKey: string;
  resourceId: string;
  /** Epoch seconds. */
  start: number;
  expectedEnd: number;
  zone: string;
  softConflictKeys: string[];
}

export interface Unplaced {
  unitKey: string;
  contestIds: string[];
  reason: string;
}

export interface Proposal {
  proposalHash: string;
  status: ProposalStatus;
  scope: { eventIds: string[] | null; roundIds: string[] | null };
  placements: Placement[];
  unplaced: Unplaced[];
  metrics: { placedContests: number; unplacedUnits: number };
}

export interface SchedulingProfileVersion {
  versionId: string;
  code: string;
  name: string;
  version: number;
  spec?: {
    requirements?: {
      resourceType: string;
      expectedDurationSeconds: number;
      changeoverSeconds: number;
    }[];
  };
}

export function scheduleVersions(
  token: string,
  competitionId: string,
): Promise<ApiResult<{ items: ScheduleVersion[] }>> {
  return apiRequest(token, 'GET', `/v1/competitions/${competitionId}/schedule/versions`);
}

export function scheduleVersion(
  token: string,
  versionId: string,
): Promise<ApiResult<VersionDetail>> {
  return apiRequest(token, 'GET', `/v1/schedule-versions/${versionId}`);
}

/** The conflict report publish would check. Side-effect free; needs COMP_MANAGE_SCHEDULE. */
export function validateVersion(token: string, versionId: string): Promise<ApiResult<Validation>> {
  return apiRequest(token, 'POST', `/v1/schedule-versions/${versionId}/validate`);
}

/** The read-only, deterministic proposal preview (no `from`: the categories' dates bound it). */
export function previewProposal(
  token: string,
  versionId: string,
  eventIds: readonly string[] | null,
): Promise<ApiResult<{ proposal: Proposal }>> {
  return apiRequest(token, 'POST', `/v1/schedule-versions/${versionId}/proposals/preview`, {
    body: eventIds === null ? {} : { scope: { eventIds: [...eventIds] } },
  });
}

/** A category's matches (the public structure read: available once the plan exists). */
export function eventBracket(
  competitionSlug: string,
  eventSlug: string,
): Promise<Fetched<{ rounds: StructureRound[] }>> {
  return getPublic(`/v1/competitions/${competitionSlug}/events/${eventSlug}/bracket`);
}

// ───────────────────────────── permissions and versions ─────────────────────────────

export const canManageSchedule = (perms: readonly string[]) =>
  perms.includes('COMP_MANAGE_SCHEDULE');

export const scheduleClosed = (status: string) => status === 'COMPLETED' || status === 'CANCELLED';

/** The open draft and the current published version (the API keeps at most one of each). */
export function currentVersions(items: readonly ScheduleVersion[]) {
  return {
    draft: items.find((v) => v.status === 'DRAFT') ?? null,
    published: items.find((v) => v.status === 'PUBLISHED') ?? null,
  };
}

/** Categories whose matches the scheduler can place (ONCF-05E-E: field locked or in progress). */
export const SCHEDULABLE: ReadonlySet<string> = new Set(['FIELD_LOCKED', 'IN_PROGRESS']);
/** Categories that can still choose a scheduling profile (scoring freezes at field lock). */
export const PROFILE_EDITABLE: ReadonlySet<string> = new Set([
  'DRAFT',
  'REGISTRATION_OPEN',
  'REGISTRATION_CLOSED',
]);

// ───────────────────────────── organizer language ─────────────────────────────

export const PROPOSAL_STATUS: Record<
  ProposalStatus,
  { tone: 'ok' | 'warn' | 'bad'; title: string; detail: string }
> = {
  SUCCESS: {
    tone: 'ok',
    title: 'Every match fits',
    detail: 'Each match below has a court and a time with no conflicts.',
  },
  NOTHING_TO_PLACE: {
    tone: 'warn',
    title: 'Nothing to schedule',
    detail:
      'Every match that can be scheduled already has a time, or no category can be scheduled yet.',
  },
  NO_CANDIDATES: {
    tone: 'bad',
    title: 'No courts or time to use',
    detail: 'The matches below have no suitable court, dates or declared hours to use.',
  },
  INFEASIBLE: {
    tone: 'bad',
    title: 'Not every match fits',
    detail: 'Some matches can’t be placed. Nothing can be added until every match fits.',
  },
  SEARCH_EXHAUSTED: {
    tone: 'bad',
    title: 'The search stopped before finishing',
    detail: 'Too many combinations to try. Schedule one category at a time.',
  },
};

export const UNPLACED_REASON: Record<string, string> = {
  NO_PROFILE: 'The category has no scheduling profile.',
  EVENT_NOT_SCHEDULABLE: 'The category’s field isn’t locked yet.',
  NO_COMPATIBLE_RESOURCE: 'There is no active court of the kind these matches need.',
  NO_HORIZON: 'The category has no end date, or its dates are too short for the match.',
  NO_DECLARED_TIME: 'No suitable court has declared hours within the category’s dates.',
  NO_FEASIBLE_CANDIDATE: 'No free court and time avoids a conflict.',
  FEEDER_UNPLACED: 'It depends on a match that isn’t scheduled yet.',
  PARTIALLY_PLACED:
    'Part of this group already has a time, so it can’t be completed automatically.',
  ALL_VACANT: 'Nobody can play it: every place is empty.',
  STALE_OCCUPANT: 'Its players changed after results. Check the category’s progression first.',
  BUDGET_EXHAUSTED: 'The search ran out of attempts before finding a time.',
};

export const CONFLICT_TEXT: Record<string, string> = {
  RESOURCE_OVERLAP: 'Two matches on the same court at the same time',
  EXCLUSIVITY_CONFLICT: 'Courts that share space are used at the same time',
  CAPACITY_EXCEEDED: 'More matches than the place can hold',
  RESOURCE_TYPE_MISMATCH: 'A match is on the wrong kind of court',
  RESOURCE_UNAVAILABLE: 'The court is closed or unavailable then',
  PARTICIPANT_OVERLAP: 'A player has two matches at once',
  TEAM_OVERLAP: 'A team has two matches at once',
  DEPENDENCY_ORDER: 'A match starts before the match it depends on ends',
  LOCKED_ASSIGNMENT_VIOLATION: 'A locked match was moved',
  OUTSIDE_EVENT_WINDOW: 'A match falls outside the category’s dates',
  STALE_OCCUPANT: 'A match’s players changed after it was scheduled',
  START_SPACING: 'Matches start too close together',
  CONCURRENT_STARTS_EXCEEDED: 'Too many matches start at the same time',
  UNIT_SPLIT: 'Matches that belong together were split up',
  AVAILABILITY_UNDECLARED: 'The court has no declared hours then',
  ROUND_SEQUENCE: 'A later round is scheduled before an earlier one',
  INCOMPLETE_ASSIGNMENT: 'A match is missing its court or end time',
  SHORT_REST: 'Players get less rest than the profile asks for',
  MAX_CONTESTS_PER_DAY: 'Players have more matches in one day than allowed',
  LONG_WAIT: 'Players wait a long time between matches',
  UNDERUSED_RESOURCE: 'A court is barely used',
  SEQUENCING_INEFFICIENCY: 'The order of matches could be tighter',
};

export const conflictText = (code: string) => CONFLICT_TEXT[code] ?? 'Scheduling conflict';
export const unplacedText = (reason: string) => UNPLACED_REASON[reason] ?? 'It couldn’t be placed.';

/** "90 min", "1 h 30 min", "2 h". */
export function durationText(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
}

/** "Padel court · 90 min matches + 10 min changeover" for each requirement of a profile. */
export function profileLines(profile: SchedulingProfileVersion | null | undefined): string[] {
  return (profile?.spec?.requirements ?? []).map(
    (r) =>
      `${typeLabel(r.resourceType)} · ${durationText(r.expectedDurationSeconds)} matches` +
      (r.changeoverSeconds > 0 ? ` + ${durationText(r.changeoverSeconds)} changeover` : ''),
  );
}

export const profileResourceTypes = (profile: SchedulingProfileVersion | null | undefined) => [
  ...new Set((profile?.spec?.requirements ?? []).map((r) => r.resourceType)),
];

// ───────────────────────────── readiness ─────────────────────────────

export type CheckState = 'ok' | 'todo' | 'blocked';

export interface ReadinessCheck {
  key: 'profile' | 'field' | 'matches' | 'dates' | 'courts';
  state: CheckState;
  label: string;
  detail: string;
  href: string | null;
}

export interface CategoryReadiness {
  event: ManagedEvent;
  /** `blocked`: cannot be scheduled from the web at all (no profile after the field locked). */
  state: 'complete' | 'incomplete' | 'blocked';
  checks: ReadinessCheck[];
  profile: SchedulingProfileVersion | null;
  matches: number;
}

/**
 * What each live category still needs before the proposal can place its matches — the inputs the
 * ONCF-05E-E preview loads (ADR-0075): a pinned profile, a locked field with generated matches,
 * finite dates, and active courts of the profile's kind with declared hours. `complete` only means
 * those inputs exist; whether everything fits is the proposal's answer, never this one.
 */
export function categoryReadiness(
  data: ManagedCompetition,
  base: string,
  inputs: ReadonlyMap<
    string,
    { scoring: EventScoring | null; structure: StructureReadiness | null }
  >,
  resources: readonly ResourceView[] | null,
  facts: readonly AvailabilityFactView[] | null,
): CategoryReadiness[] {
  const live = data.events.filter((e) => e.status !== 'CANCELLED' && e.status !== 'COMPLETED');
  return live.map((event) => {
    const { scoring, structure } = inputs.get(event.id) ?? { scoring: null, structure: null };
    const name = event.settings.name;
    const structureHref = `${base}/categories/${event.id}/structure`;
    const profile = (scoring?.schedulingProfile ?? null) as SchedulingProfileVersion | null;
    const locked = SCHEDULABLE.has(event.status);
    const checks: ReadinessCheck[] = [];

    checks.push(
      profile !== null
        ? {
            key: 'profile',
            state: 'ok',
            label: `Scheduling profile: ${profile.name}`,
            detail: profileLines(profile).join(' · ') || 'Pinned for this category.',
            href: null,
          }
        : PROFILE_EDITABLE.has(event.status)
          ? {
              key: 'profile',
              state: 'todo',
              label: 'Choose a scheduling profile',
              detail: `How long ${name} matches last and which courts they need. It must be chosen before the field is locked.`,
              href: `${structureHref}#sc-h`,
            }
          : {
              key: 'profile',
              state: 'blocked',
              label: 'No scheduling profile',
              detail:
                'The field was locked without one, and a profile can’t be added after that. These matches can’t be scheduled here.',
              href: null,
            },
    );
    checks.push(
      locked
        ? { key: 'field', state: 'ok', label: 'Field locked', detail: '', href: null }
        : {
            key: 'field',
            state: 'todo',
            label: 'Lock the field',
            detail: 'Matches are scheduled once the entry list is final.',
            href: structureHref,
          },
    );
    const total = structure?.plan?.contests ?? 0;
    checks.push(
      structure?.planGenerated === true
        ? {
            key: 'matches',
            state: 'ok',
            label: `${total} ${total === 1 ? 'match' : 'matches'} generated`,
            detail: '',
            href: null,
          }
        : {
            key: 'matches',
            state: 'todo',
            label: 'Generate the matches',
            detail: 'Seed the field and generate the structure to create the matches.',
            href: structureHref,
          },
    );
    const startsAt = event.settings.startsAt ?? data.competition.profile.startsAt;
    const endsAt = event.settings.endsAt ?? data.competition.profile.endsAt;
    checks.push(
      startsAt !== null && endsAt !== null
        ? { key: 'dates', state: 'ok', label: 'Dates set', detail: '', href: null }
        : {
            key: 'dates',
            state: 'todo',
            label: 'Set start and end dates',
            detail: 'Matches are only placed between the category’s (or tournament’s) dates.',
            href: `${base}/edit`,
          },
    );
    const types = profileResourceTypes(profile);
    if (types.length > 0 && resources !== null && facts !== null) {
      const missing = types.filter(
        (t) =>
          !resources.some(
            (r) => r.typeCode === t && r.status === 'ACTIVE' && readinessOf(r, facts) === 'ready',
          ),
      );
      const usable = resources.filter(
        (r) =>
          types.includes(r.typeCode) && r.status === 'ACTIVE' && readinessOf(r, facts) === 'ready',
      ).length;
      checks.push(
        missing.length === 0
          ? {
              key: 'courts',
              state: 'ok',
              label: `${usable} ${usable === 1 ? 'court' : 'courts'} with declared hours`,
              detail: '',
              href: null,
            }
          : {
              key: 'courts',
              state: 'todo',
              label: `Add ${missing.map((t) => typeLabel(t).toLowerCase()).join(', ')} with hours`,
              detail: 'Scheduling only uses active courts of the right kind with declared hours.',
              href: `${base}/resources`,
            },
      );
    }
    const state = checks.some((c) => c.state === 'blocked')
      ? 'blocked'
      : checks.every((c) => c.state === 'ok') && types.length > 0
        ? 'complete'
        : 'incomplete';
    return { event, state, checks, profile, matches: total };
  });
}

// ───────────────────────────── matches ─────────────────────────────

export interface MatchInfo {
  contestId: string;
  eventId: string;
  category: string;
  round: string;
  /** "Match 3" (head-to-head) or "Heat 2" (field contests). */
  title: string;
  sides: string[];
  status: string;
}

const nameFrom = (
  participantId: string,
  display: { kind: string; displayName?: string; teamName?: string },
  names: ReadonlyMap<string, string>,
) =>
  names.get(participantId) ??
  (display.kind === 'ATHLETE'
    ? (display.displayName ?? 'Private entrant')
    : display.kind === 'TEAM'
      ? (display.teamName ?? 'Team')
      : 'Private entrant');

/** A slot as an organizer reads it: a name, or where the entrant will come from. */
export function sideText(slot: Slot, names: ReadonlyMap<string, string>): string {
  if (slot.kind === 'PARTICIPANT') return nameFrom(slot.participantId, slot.display, names);
  if (slot.resolved) return nameFrom(slot.participantId, slot.display, names);
  switch (slot.kind) {
    case 'WINNER_OF_CONTEST':
      return `Winner of match ${slot.contestSequence}`;
    case 'LOSER_OF_CONTEST':
      return `Loser of match ${slot.contestSequence}`;
    case 'RANK_FROM_STAGE': {
      const g = groupName(slot.groupKey);
      return g !== null
        ? `Group ${g} ${ordinalLabel(slot.rank)}`
        : `${ordinalLabel(slot.rank)} place`;
    }
    case 'BEST_RANKED_FROM_STAGE':
      return `Best ${ordinalLabel(slot.rank)} #${slot.ordinal}`;
    default:
      return `Qualifier #${slot.ordinal}`;
  }
}

/** contestId → what the match is and who plays it, from the categories' structures and fields. */
export function matchIndex(
  categories: readonly {
    event: ManagedEvent;
    rounds: readonly StructureRound[];
    field: readonly FieldParticipant[];
  }[],
): Map<string, MatchInfo> {
  const out = new Map<string, MatchInfo>();
  for (const { event, rounds, field } of categories) {
    const names = new Map<string, string>();
    for (const p of field)
      names.set(p.participantId, p.athlete?.displayName ?? p.teamName ?? 'Private entrant');
    for (const r of rounds)
      for (const c of r.contests) out.set(c.contestId, match(event, r.label, c, names));
  }
  return out;
}

function match(
  event: ManagedEvent,
  round: string,
  c: Contest,
  names: ReadonlyMap<string, string>,
): MatchInfo {
  const part = partitionLabel(c.partitionKey);
  const field = c.slots.length === 0 && (c.entryCount ?? c.entries?.length ?? 0) > 0;
  return {
    contestId: c.contestId,
    eventId: event.id,
    category: event.settings.name,
    round,
    title: part ?? `${field ? 'Race' : 'Match'} ${c.sequence}`,
    sides: field
      ? [`${c.entryCount ?? c.entries?.length ?? 0} entrants`]
      : [...c.slots].sort((a, b) => a.slot - b.slot).map((s) => sideText(s, names)),
    status: c.status,
  };
}

// ───────────────────────────── times ─────────────────────────────

/** One scheduled (or proposed) match, whichever source it came from. Instants are ISO. */
export interface ScheduleRow {
  contestId: string;
  resourceId: string | null;
  start: string;
  end: string | null;
  zone: string;
  locked: boolean;
}

export const fromAssignment = (a: Assignment): ScheduleRow => ({
  contestId: a.contestId,
  resourceId: a.resourceId,
  start: a.startsAt,
  end: a.expectedEnd,
  zone: a.zone,
  locked: a.locked,
});

const iso = (s: number) => new Date(s * 1000).toISOString();

export const fromPlacement = (p: Placement): ScheduleRow => ({
  contestId: p.contestId,
  resourceId: p.resourceId,
  start: iso(p.start),
  end: iso(p.expectedEnd),
  zone: p.zone,
  locked: false,
});

export interface ScheduleDay {
  date: string;
  label: string;
  rows: ScheduleRow[];
}

/** Rows grouped by local day in each row's own zone (the category's), ordered by time. */
export function scheduleDays(rows: readonly ScheduleRow[]): ScheduleDay[] {
  const byDay = new Map<string, ScheduleRow[]>();
  for (const r of rows) {
    const local = instantToZoned(r.start, r.zone);
    const date = local === '' ? r.start.slice(0, 10) : local.slice(0, 10);
    byDay.set(date, [...(byDay.get(date) ?? []), r]);
  }
  return [...byDay.keys()].sort().map((date) => ({
    date,
    label: shortDateText(date),
    rows: (byDay.get(date) ?? []).sort(
      (a, b) => Date.parse(a.start) - Date.parse(b.start) || a.contestId.localeCompare(b.contestId),
    ),
  }));
}

/** "09:00–10:30" in the row's zone ("09:00" without an end). */
export function timeText(row: Pick<ScheduleRow, 'start' | 'end' | 'zone'>): string {
  const a = instantToZoned(row.start, row.zone).slice(11);
  if (row.end === null) return a;
  const endLocal = instantToZoned(row.end, row.zone);
  const sameDay = endLocal.slice(0, 10) === instantToZoned(row.start, row.zone).slice(0, 10);
  return `${a}–${endLocal.slice(11)}${sameDay ? '' : ' next day'}`;
}

/** The zones the rows are shown in (one, normally: every category shares the tournament's). */
export const zonesOf = (rows: readonly ScheduleRow[]) => [...new Set(rows.map((r) => r.zone))];

// ───────────────────────────── resource lanes ─────────────────────────────

export interface LaneBlock {
  row: ScheduleRow;
  /** Percent of the day's span. */
  left: number;
  width: number;
}

export interface Lane {
  resourceId: string;
  label: string;
  blocks: LaneBlock[];
  /** Declared-open segments in percent of the span (null: hours not loaded). */
  open: { left: number; width: number }[] | null;
}

export interface LaneDay {
  date: string;
  label: string;
  /** Whole hours shown, e.g. 8 → "08:00" … 22. */
  hours: number[];
  lanes: Lane[];
}

const localMinutes = (instant: string, zone: string, date: string): number => {
  const l = instantToZoned(instant, zone);
  if (l === '') return 0;
  if (l.slice(0, 10) < date) return 0;
  if (l.slice(0, 10) > date) return 24 * 60;
  return Number(l.slice(11, 13)) * 60 + Number(l.slice(14, 16));
};

/**
 * One timeline per day: a lane per court (every court a row is on, plus the courts the categories
 * can use), blocks placed by local time, and the court's declared-open time behind them so free and
 * unavailable time read at a glance. Presentation only: the rows are the API's, untouched.
 */
export function laneDays(
  days: readonly ScheduleDay[],
  courts: readonly Pick<ResourceView, 'resourceId' | 'label'>[],
  open: ReadonlyMap<string, readonly { start: string; end: string }[]>,
): LaneDay[] {
  return days.map((d) => {
    const zone = d.rows[0]?.zone ?? 'UTC';
    const starts = d.rows.map((r) => localMinutes(r.start, zone, d.date));
    const ends = d.rows.map((r) => localMinutes(r.end ?? r.start, zone, d.date));
    const from = Math.max(0, Math.floor(Math.min(...starts) / 60) - 1);
    const to = Math.min(24, Math.ceil(Math.max(...ends) / 60) + 1);
    const span = (to - from) * 60;
    const pct = (m: number) => Math.min(100, Math.max(0, ((m - from * 60) / span) * 100));
    const ids = [
      ...new Set([
        ...courts.map((c) => c.resourceId),
        ...d.rows.flatMap((r) => (r.resourceId === null ? [] : [r.resourceId])),
      ]),
    ];
    const dayFrom = dayStart(d.date, zone);
    const dayTo = dayStart(addDays(d.date, 1), zone);
    const lanes = ids.map((id) => {
      const intervals = open.get(id);
      return {
        resourceId: id,
        label: courts.find((c) => c.resourceId === id)?.label ?? 'Court',
        blocks: d.rows
          .filter((r) => r.resourceId === id)
          .map((row) => {
            const a = pct(localMinutes(row.start, zone, d.date));
            const b = pct(localMinutes(row.end ?? row.start, zone, d.date));
            return { row, left: a, width: Math.max(b - a, 1.5) };
          }),
        open:
          intervals === undefined || dayFrom === null || dayTo === null
            ? null
            : intervals
                .filter(
                  (iv) =>
                    Date.parse(iv.end) > Date.parse(dayFrom) &&
                    Date.parse(iv.start) < Date.parse(dayTo),
                )
                .map((iv) => {
                  const a = pct(localMinutes(iv.start, zone, d.date));
                  const b = pct(localMinutes(iv.end, zone, d.date));
                  return { left: a, width: b - a };
                })
                .filter((s) => s.width > 0),
      };
    });
    return {
      date: d.date,
      label: d.label,
      hours: Array.from({ length: to - from + 1 }, (_, i) => from + i),
      lanes,
    };
  });
}

// ───────────────────────────── the hub ─────────────────────────────

export interface ScheduleSummary {
  draft: ScheduleVersion | null;
  published: ScheduleVersion | null;
}

/** The courts the categories' profiles need, from the catalog (for the lanes' empty courts). */
export function profileFor(catalog: Catalog | null, versionId: string | undefined) {
  return (catalog?.schedulingProfileVersions ?? []).find((p) => p.versionId === versionId) ?? null;
}
