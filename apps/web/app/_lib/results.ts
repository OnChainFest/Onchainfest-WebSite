import type { Contest, StructureRound } from './competition';
import { partitionLabel, placeLabel } from './competition';
import { sideText } from './schedule';
import type { FieldParticipant } from './structure';
import { FAMILY_LABEL, isEntryFamily } from './score-sheet';
import type { StageClassification } from './scoring';
import type { ManagedEvent } from './tournaments';

/**
 * ONCF-L5 results workspace. Everything here PRESENTS the ResultLedger the API already has
 * (ADR-0064, ADR-0077): a score sheet is entered (SUBMITTED), accepted (PROVISIONAL, the current
 * result), declared official (OFFICIAL — what advancement uses) or corrected (a new version that
 * supersedes the current one). The API validates every sheet under the pinned ruleset, decides
 * authority and serializes every write; this module only lays out the sheet a ruleset family
 * takes, turns form fields into that sheet, and reads stored content back as a score line.
 * No outcome is decided here. Sheet layout and reading live in score-sheet.ts (client-safe); the
 * API calls in results-api.ts.
 */

// ───────────────────────────── ledger vocabulary ─────────────────────────────

export type VersionStatus =
  'SUBMITTED' | 'PROVISIONAL' | 'OFFICIAL' | 'FINAL' | 'REJECTED' | 'SUPERSEDED' | 'REVOKED';

export interface Mark {
  metricId: string;
  value: string;
  unit: string;
  precision: number;
}

/** The stored canonical `br:result-version-content@1` (sorted by participant id). */
export interface ResultContent {
  entries: { participantId: string; outcome: string; primaryMark?: Mark }[];
  performances?: { participantId: string; ordinal: number; mark: Mark; athleteId?: string }[];
}

export interface ResultVersion {
  resultVersionId: string;
  versionNumber: number;
  contentHash: string;
  status: VersionStatus;
  current: boolean;
  supersedesVersionId: string | null;
  /** ONCF-L5 (absent on older API builds). */
  content?: ResultContent;
  recordedAt?: string;
}

/** Result authority is issued only at PLATFORM recognition (ADR-0077 §2.2); every action sends it. */
export const RECOGNITION_LEVEL = 'PLATFORM';

/**
 * ADR-0077 §2.3: only a tournament's OWNER / ADMIN can ever be issued result authority. Mirrors
 * `RESULT_AUTHORITY_STAFF_ROLES` (a test pins it) to decide what to OFFER; the API decides.
 */
export const RESULT_STAFF_ROLES: readonly string[] = ['OWNER', 'ADMIN'];

export const resultEligible = (staffRoles: readonly string[]) =>
  staffRoles.some((r) => RESULT_STAFF_ROLES.includes(r));

export const VERSION_STATUS_LABEL: Record<VersionStatus, string> = {
  SUBMITTED: 'Entered',
  PROVISIONAL: 'Provisional',
  OFFICIAL: 'Official',
  FINAL: 'Final',
  REJECTED: 'Rejected',
  SUPERSEDED: 'Replaced',
  REVOKED: 'Revoked',
};

export const versionStatusLabel = (s: string) =>
  Object.hasOwn(VERSION_STATUS_LABEL, s) ? VERSION_STATUS_LABEL[s as VersionStatus] : s;

/** The two ledger steps after entry, as the API routes them. */
export const TRANSITIONS = {
  accept: {
    path: 'accept',
    from: 'SUBMITTED',
    to: 'PROVISIONAL',
    label: 'Accept result',
    consequence:
      'It becomes the match’s current result, provisionally. Nothing advances until it is declared official.',
    final: false,
  },
  official: {
    path: 'declare-official',
    from: 'PROVISIONAL',
    to: 'OFFICIAL',
    label: 'Declare official',
    consequence:
      'The result becomes official: advancement and standings use it. Changing it afterwards needs a correction with a reason.',
    final: true,
  },
} as const;
export type TransitionKey = keyof typeof TRANSITIONS;

// ───────────────────────────── the board ─────────────────────────────

/** Which ruleset a match is scored under: its stage's override, else the category's. */
export interface MatchScoring {
  family: string;
  parameters: Readonly<Record<string, unknown>>;
  name: string;
}

export interface ResultMatch {
  contestId: string;
  event: ManagedEvent;
  round: string;
  title: string;
  /** Participant id per side, in slot order (null: not decided yet). */
  sideIds: (string | null)[];
  sides: string[];
  status: string;
  scoring: MatchScoring | null;
  /** null: the result couldn't be read. */
  versions: ResultVersion[] | null;
  /** ONCF-L6: its category is finished (COMPLETED or CANCELLED) — results are frozen. */
  frozen: boolean;
}

export type ResultState = 'needs' | 'entered' | 'provisional' | 'official' | 'unreadable';

export const RESULT_STATE_LABEL: Record<ResultState, string> = {
  needs: 'No result',
  entered: 'Entered — awaiting acceptance',
  provisional: 'Provisional',
  official: 'Official',
  unreadable: 'Can’t be read',
};

/** The matches whose results matter now: in play (about to need one), finished, or voided after one. */
export const RESULT_STATUSES: ReadonlySet<string> = new Set(['IN_PROGRESS', 'COMPLETED', 'VOID']);

/** ONCF-L6 (ADR-0078): a finished category's results and matches no longer change. */
export const FINISHED_CATEGORY: ReadonlySet<string> = new Set(['COMPLETED', 'CANCELLED']);

export const currentVersion = (m: Pick<ResultMatch, 'versions'>) =>
  m.versions?.find((v) => v.current) ?? null;

/** Entered versions nobody has accepted yet (only while no version is current). */
export const pendingVersions = (m: Pick<ResultMatch, 'versions'>) =>
  currentVersion(m) === null ? (m.versions ?? []).filter((v) => v.status === 'SUBMITTED') : [];

export function resultState(m: Pick<ResultMatch, 'versions'>): ResultState {
  if (m.versions === null) return 'unreadable';
  const cur = currentVersion(m);
  if (cur !== null) return cur.status === 'PROVISIONAL' ? 'provisional' : 'official';
  return pendingVersions(m).length > 0 ? 'entered' : 'needs';
}

function titleOf(c: Contest): string {
  return partitionLabel(c.partitionKey) ?? `Match ${c.sequence}`;
}

/** Every head-to-head match of the given categories whose result matters now, with its scoring. */
export function resultMatches(
  categories: readonly {
    event: ManagedEvent;
    rounds: readonly StructureRound[];
    field: readonly FieldParticipant[];
    scoringFor: (stageKey: string | null) => MatchScoring | null;
  }[],
  versions: ReadonlyMap<string, ResultVersion[] | null>,
): ResultMatch[] {
  const out: ResultMatch[] = [];
  for (const { event, rounds, field, scoringFor } of categories) {
    const names = new Map(
      field.map((p) => [
        p.participantId,
        p.athlete?.displayName ?? p.teamName ?? 'Private entrant',
      ]),
    );
    for (const r of rounds)
      for (const c of r.contests) {
        if (!RESULT_STATUSES.has(c.status) || c.slots.length === 0) continue;
        const v = versions.has(c.contestId) ? (versions.get(c.contestId) ?? null) : null;
        if (c.status === 'VOID' && (v === null || v.length === 0)) continue;
        const slots = [...c.slots].sort((x, y) => x.slot - y.slot);
        out.push({
          contestId: c.contestId,
          event,
          round: r.label,
          title: titleOf(c),
          sideIds: slots.map((s) =>
            s.kind === 'PARTICIPANT' || s.resolved ? s.participantId : null,
          ),
          sides: slots.map((s) => sideText(s, names)),
          status: c.status,
          scoring: scoringFor(r.stage?.key ?? null),
          versions: v,
          frozen: FINISHED_CATEGORY.has(event.status),
        });
      }
  }
  return out;
}

const byCategory = (a: ResultMatch, b: ResultMatch) =>
  a.event.settings.name.localeCompare(b.event.settings.name) ||
  a.round.localeCompare(b.round) ||
  a.title.localeCompare(b.title, undefined, { numeric: true });

/** The workspace lists: what needs a result (finished first), what awaits each next step, what is done. */
export function resultsBoard(matches: readonly ResultMatch[]) {
  const of = (s: ResultState) => matches.filter((m) => resultState(m) === s).sort(byCategory);
  const needs = of('needs').sort(
    (a, b) => Number(b.status === 'COMPLETED') - Number(a.status === 'COMPLETED'),
  );
  return {
    needs,
    entered: of('entered'),
    provisional: of('provisional'),
    official: of('official'),
    unreadable: of('unreadable'),
  };
}

export interface ResultAttention {
  key: string;
  tone: 'go' | 'warn' | 'bad';
  label: string;
  detail: string;
  href: string;
}

/** What a results operator should look at first. Advice only, from the state on screen. */
export function resultAttention(
  board: ReturnType<typeof resultsBoard>,
  categories: readonly { event: ManagedEvent; family: string | null; pinned: boolean }[],
): ResultAttention[] {
  const items: ResultAttention[] = [];
  const name = (m: ResultMatch) => `${m.event.settings.name} · ${m.round} · ${m.title}`;
  // A voided match's entered scores never count, so they need no decision.
  for (const m of board.entered)
    if (m.status !== 'VOID' && pendingVersions(m).length > 1)
      items.push({
        key: `two-${m.contestId}`,
        tone: 'bad',
        label: `${name(m)} has ${pendingVersions(m).length} different scores entered`,
        detail: 'Check which one is right and accept only that one.',
        href: `#r-${m.contestId}`,
      });
  // A frozen category's matches can't be acted on (only grandfathered data has gaps there).
  const finished = board.needs.filter((m) => m.status === 'COMPLETED' && !m.frozen);
  if (finished.length > 0)
    items.push({
      key: 'finished',
      tone: 'warn',
      label:
        finished.length === 1
          ? `${name(finished[0] as ResultMatch)} finished without a result`
          : `${finished.length} finished matches have no result`,
      detail: 'Enter their scores so they can be accepted and made official.',
      href: '#res-needs',
    });
  if (board.unreadable.length > 0)
    items.push({
      key: 'unreadable',
      tone: 'bad',
      label: `${board.unreadable.length} ${board.unreadable.length === 1 ? 'result' : 'results'} can’t be read right now`,
      detail: 'Nothing was changed. Reload the page in a moment.',
      href: '#res-needs',
    });
  for (const c of categories) {
    if (!c.pinned)
      items.push({
        key: `pin-${c.event.id}`,
        tone: 'bad',
        label: `${c.event.settings.name} has no scoring chosen`,
        detail: 'Results can’t be validated without it.',
        href: '#res-needs',
      });
    else if (c.family !== null && !isEntryFamily(c.family))
      items.push({
        key: `family-${c.event.id}`,
        tone: 'warn',
        label: `${c.event.settings.name} is scored by ${FAMILY_LABEL[c.family] ?? c.family}`,
        detail: 'Entering that kind of result isn’t available in this workspace yet.',
        href: '#res-needs',
      });
  }
  return items;
}

// ───────────────────────────── category outcome (ONCF-L6) ─────────────────────────────

export type OutcomeKind = 'KNOCKOUT' | 'STEPLADDER' | 'STANDINGS' | 'METRIC' | 'GROUPS';
export type OutcomeStatus = 'DECIDED' | 'PENDING' | 'UNDECIDED' | 'NOT_SUPPORTED';

export interface OutcomePlacement {
  participantId: string;
  position: number;
  tied: boolean;
}

/**
 * `GET /v1/events/:eventId/outcome` (competition staff): the category's `event-outcome/1`, derived
 * by the API from OFFICIAL results only, and whether it can be completed now (ADR-0078).
 */
export interface StaffOutcome {
  eventId: string;
  eventStatus: string;
  final: boolean;
  outcome: {
    kind?: OutcomeKind;
    status: OutcomeStatus;
    reasons: { code: string; contestIds?: string[] }[];
    placements: OutcomePlacement[];
    standings: { groupKey?: string; document: StageClassification['document'] }[];
  };
  hash: string;
  readiness: {
    ready: boolean;
    contestsOpen: string[];
    resultsNotOfficial: string[];
    required: number;
    official: number;
  };
}

/** Why an outcome isn't settled (or what a reader must know about it), in organizer words. */
export const OUTCOME_REASON_LABEL: Record<string, string> = {
  ENGINE_V1: 'This category’s format has no stage structure, so no outcome is derived for it.',
  STRUCTURE_UNRECOGNIZED: 'The final of this category can’t be identified.',
  CLASSIFICATION_UNAVAILABLE: 'No standings template is chosen for this category.',
  CLASSIFICATION_INCOMPLETE: 'Some matches still need an official result.',
  DYNAMIC_ROUND_PENDING: 'A later round hasn’t been filled yet.',
  FINAL_NOT_OFFICIAL: 'The final has no official result yet.',
  FINAL_NO_WINNER: 'The final’s official result has no winner.',
  FINAL_VOID: 'The final was voided.',
  FINAL_CANCELLED: 'The final was cancelled.',
  FINAL_VACANT: 'A place in the final is vacant.',
  FINAL_OCCUPANTS_CHANGED: 'The final’s result names other players than the final.',
  THIRD_PLACE_NOT_OFFICIAL: 'The third-place match has no official result yet.',
  THIRD_PLACE_NO_WINNER: 'The third-place match has no winner.',
  SEMIFINAL_NOT_OFFICIAL: 'A semifinal has no official result yet.',
  TIE_UNBROKEN_LOT: 'A tie that only an organizer lot could separate stays shared.',
  GROUPS_NO_CHAMPION: 'Groups are ranked separately: there is no single champion.',
};

export const outcomeReasonLabel = (code: string) => OUTCOME_REASON_LABEL[code] ?? code;

/** The podium: positions 1–3 exactly as derived (ties stay shared; no place is invented). */
export const podiumOf = (placements: readonly OutcomePlacement[]) =>
  placements.filter((p) => p.position <= 3);

/** Podium placements grouped by position, in order. */
export function podiumGroups(placements: readonly OutcomePlacement[]) {
  const groups = new Map<number, OutcomePlacement[]>();
  for (const p of podiumOf(placements))
    groups.set(p.position, [...(groups.get(p.position) ?? []), p]);
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([position, entrants]) => ({
      position,
      label: placeLabel(position, entrants.length),
      entrants,
    }));
}
