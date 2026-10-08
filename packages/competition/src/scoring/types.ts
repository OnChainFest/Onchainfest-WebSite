import type { ResultOutcome, ResultVersionContent } from '@br/domain';
import type { RulesetSpec } from '../ruleset';

/**
 * Ruleset execution types — ONCF-05C (ADR-0059, ADR-0062).
 *
 * A SCORE SHEET is what an official records for one contest. A ruleset family validates it and
 * NORMALIZES it into (1) the canonical `br:result-version-content@1` content the ResultLedger stores
 * and (2) a NormalizedContestResult (outcomes, metrics, per-unit series) that classification
 * consumes. Stored content can be read back (re-derived and re-validated) without the sheet, so
 * an invalid score can never be classified. Everything here is keyed by ruleset FAMILY and
 * parameters — never by sport.
 */

/** Field status of an entrant in a timed / scored field contest. */
export const EntryStatus = {
  FINISHED: 'FINISHED',
  DNF: 'DNF',
  DNS: 'DNS',
  DQ: 'DQ',
  NOT_PLACED: 'NOT_PLACED',
  PULLED: 'PULLED',
} as const;
export type EntryStatus = (typeof EntryStatus)[keyof typeof EntryStatus];

/** Field status → the ResultOutcome stored in content (FINISHED ⇒ RANKED). */
export const STATUS_OUTCOME: Readonly<Record<EntryStatus, ResultOutcome>> = {
  FINISHED: 'RANKED',
  DNF: 'DNF',
  DNS: 'DNS',
  DQ: 'DQ',
  NOT_PLACED: 'NOT_PLACED',
  PULLED: 'PULLED',
};

/** How a head-to-head contest was decided (normalized; informs standings exclusions). */
export type DecidedBy =
  | 'REGULATION'
  | 'OVERTIME'
  | 'MATCH_TIEBREAK'
  | 'EXTRA_HOLES'
  | 'RETIREMENT'
  | 'WALKOVER'
  | 'FORFEIT'
  | 'DEFAULT'
  | 'CONCESSION';

export interface ScoringContext {
  readonly ruleset: RulesetSpec;
  /** HEAD_TO_HEAD: the two resolved slot occupants (slot order). FIELD: every entrant of the contest. */
  readonly mode: 'HEAD_TO_HEAD' | 'FIELD';
  readonly participants: readonly string[];
  /** Frozen roster per TEAM participant (athlete ids). */
  readonly rosters?: Readonly<Record<string, readonly string[]>>;
  /** Frozen declared entry attributes per participant (key → value). */
  readonly attributes?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Frozen MEMBER-scope attributes: participant → athlete → key → value. */
  readonly memberAttributes?: Readonly<
    Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>
  >;
}

// ───────────────────────────── score sheets (input; one shape per family) ─────────────────────────────

export type Pair = readonly [number, number];

export interface SetsSheet {
  readonly family: 'SETS_OF_GAMES';
  /** Games per set in slot order (side A, side B); `tiebreak` points when the set went to a tie-break. */
  readonly sets: readonly { readonly games: Pair; readonly tiebreak?: Pair }[];
  /** Match tie-break replacing the deciding set (when the ruleset's finalSet says so). */
  readonly matchTiebreak?: Pair;
  readonly termination?: { readonly kind: 'RETIRED' | 'WALKOVER'; readonly side: 0 | 1 };
}

export interface PeriodsSheet {
  readonly family: 'TIMED_PERIODS';
  readonly periods: readonly Pair[];
  readonly overtimes?: readonly Pair[];
  readonly termination?: { readonly kind: 'FORFEIT' | 'DEFAULT'; readonly side: 0 | 1 };
}

export interface TargetSheet {
  readonly family: 'TIMED_OR_TARGET';
  readonly regulation: Pair;
  readonly endedBy: 'TARGET' | 'TIME';
  readonly overtime?: Pair;
  readonly termination?: { readonly kind: 'FORFEIT'; readonly side: 0 | 1 };
}

export interface TimedEntry {
  readonly participantId: string;
  readonly status: EntryStatus;
  /** Measured time in integer ms, before the ruleset's rounding. */
  readonly timeMs?: number;
  /** Informational net (chip) time, never official unless the ruleset's reference says so. */
  readonly netTimeMs?: number;
  /** Judges' finish order among finishers (FINISH_ORDER_WITH_TIME). */
  readonly finishPosition?: number;
  readonly lapsCompleted?: number;
  /** PULLED: laps behind the leader, and the order in which entrants were pulled. */
  readonly lapsDown?: number;
  readonly pullOrder?: number;
  /** Relay legs (TEAM): athlete and leg time in ms, in running order. */
  readonly legs?: readonly { readonly athleteId: string; readonly timeMs: number }[];
}

export interface TimedSheet {
  readonly family: 'ELAPSED_TIME' | 'FINISH_ORDER_WITH_TIME' | 'LAPS_AND_TIME';
  readonly entries: readonly TimedEntry[];
}

export interface PinfallEntry {
  readonly participantId: string;
  readonly status: 'FINISHED' | 'DNS' | 'DQ';
  /** Individual games, or the team's Baker games (one score per game). */
  readonly games?: readonly number[];
  /** Team (non-Baker): each member's games. */
  readonly members?: readonly { readonly athleteId: string; readonly games: readonly number[] }[];
}

export interface PinfallSheet {
  readonly family: 'FRAMES_PINFALL';
  readonly entries: readonly PinfallEntry[];
}

export interface CourseHole {
  readonly par: number;
  readonly strokeIndex: number;
}

export interface GolfEntry {
  readonly participantId: string;
  readonly status: 'FINISHED' | 'DNF' | 'DNS' | 'DQ';
  /** Individual or TEAM_BALL strokes per hole. */
  readonly holes?: readonly number[];
  /** BETTER_BALL: each member's strokes per hole (0 = no score / picked up). */
  readonly members?: readonly { readonly athleteId: string; readonly holes: readonly number[] }[];
  /** Course handicap (individual / TEAM_BALL members are listed in memberCourseHandicaps). */
  readonly courseHandicap?: number;
  readonly memberCourseHandicaps?: readonly {
    readonly athleteId: string;
    readonly courseHandicap: number;
  }[];
}

export interface GolfSheet {
  readonly family: 'STROKES' | 'STABLEFORD';
  /** Par and stroke index per hole, as printed on the scorecard (needed for net / Stableford). */
  readonly course?: { readonly holes: readonly CourseHole[] };
  readonly entries: readonly GolfEntry[];
}

export interface MatchPlaySheet {
  readonly family: 'MATCH_PLAY_HOLES';
  /** Hole winners in order: 'A' | 'B' | 'HALVED' (net hole results as decided by the match). */
  readonly holes: readonly ('A' | 'B' | 'HALVED')[];
  readonly conceded?: { readonly side: 0 | 1 };
}

export type ScoreSheet =
  SetsSheet | PeriodsSheet | TargetSheet | TimedSheet | PinfallSheet | GolfSheet | MatchPlaySheet;

// ───────────────────────────── outputs ─────────────────────────────

export interface NormalizedEntry {
  readonly participantId: string;
  readonly outcome: ResultOutcome;
  readonly decidedBy?: DecidedBy;
  /** Head-to-head opponent. */
  readonly opponentId?: string;
  /** Integer metrics as canonical decimal strings (setsWon, pointsFor, elapsedTimeMs, pins, strokes…). */
  readonly metrics: Readonly<Record<string, string>>;
  /** Per-unit sequences for tie-breaks (holes for count-back, games for highest single). */
  readonly series: Readonly<Record<string, readonly number[]>>;
}

export interface NormalizedContestResult {
  readonly family: RulesetSpec['family'];
  readonly mode: 'HEAD_TO_HEAD' | 'FIELD';
  /** Sorted by participantId. */
  readonly entries: readonly NormalizedEntry[];
}

export interface ScoringIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type ScoringOutcome =
  | {
      readonly ok: true;
      readonly content: ResultVersionContent;
      readonly result: NormalizedContestResult;
    }
  | { readonly ok: false; readonly issues: readonly ScoringIssue[] };
