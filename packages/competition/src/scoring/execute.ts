import type { Mark, Performance, ResultOutcome, ResultVersionContent } from '@br/domain';
import { validateRulesetSpec } from '../ruleset';
import {
  STATUS_OUTCOME,
  type DecidedBy,
  type EntryStatus,
  type GolfSheet,
  type MatchPlaySheet,
  type NormalizedEntry,
  type Pair,
  type PeriodsSheet,
  type PinfallSheet,
  type ScoreSheet,
  type ScoringContext,
  type ScoringIssue,
  type ScoringOutcome,
  type SetsSheet,
  type TargetSheet,
  type TimedSheet,
} from './types';

/**
 * Ruleset execution — ONCF-05C (ADR-0059, ADR-0062). One executor per ruleset FAMILY; parameters
 * come from the pinned RulesetVersion and the context (participants, frozen rosters, declared
 * attributes). No executor knows a sport.
 *
 * PERFORMANCE ORDINAL LAYOUT. `br:result-version-content@1` carries per-unit measurements as
 * Performances keyed (participantId, ordinal), so each family fixes a documented layout:
 *   SETS_OF_GAMES      sog.set_games i · sog.tiebreak_points 10+i · sog.match_tiebreak_points 20
 *   TIMED_PERIODS      tp.period_points i · tp.overtime_points 10+j · tp.defaulted 30
 *   TIMED_OR_TARGET    tot.regulation_points 1 · tot.overtime_points 2 · tot.ended_by 3 (1 TARGET, 2 TIME)
 *   timed families     time.raw_ms 1 · time.net_ms 2 · finish.position 3 · laps.completed 4 ·
 *                      laps.down 5 · laps.pull_order 6 · time.leg_ms 10+leg (athleteId)
 *   FRAMES_PINFALL     pins.game g · pins.member_game 100·m+g (athleteId; m = roster index) ·
 *                      pins.handicap_per_game 90
 *   STROKES/STABLEFORD golf.hole_strokes h · golf.member_hole_strokes 1000·m+h (athleteId) ·
 *                      golf.par 200+h · golf.stroke_index 300+h · golf.course_handicap 400 ·
 *                      golf.member_course_handicap 400+m (athleteId)
 *   MATCH_PLAY_HOLES   mp.hole h (2 won · 1 halved · 0 lost) · mp.conceded 99
 * The layout is part of the ruleset family's semantics: changing it is a new family version.
 */

const MAX_INT = 100_000_000;
const n = (v: number): string => String(v);
const mk = (metricId: string, value: number, unit: string): Mark => ({
  metricId,
  value: n(value),
  unit,
  precision: 0,
});

class Builder {
  readonly issues: ScoringIssue[] = [];
  readonly entries: { participantId: string; outcome: ResultOutcome; primaryMark?: Mark }[] = [];
  readonly performances: Performance[] = [];
  readonly normalized: NormalizedEntry[] = [];

  fail(path: string, code: string, message: string): void {
    this.issues.push({ path, code, message });
  }

  perf(participantId: string, ordinal: number, mark: Mark, athleteId?: string): void {
    this.performances.push({
      participantId: participantId as Performance['participantId'],
      ordinal,
      mark,
      ...(athleteId === undefined ? {} : { athleteId: athleteId as Performance['participantId'] }),
    });
  }

  done(ctx: ScoringContext): ScoringOutcome {
    if (this.issues.length > 0) return { ok: false, issues: this.issues };
    const byId = (a: { participantId: string }, b: { participantId: string }) =>
      a.participantId < b.participantId ? -1 : a.participantId > b.participantId ? 1 : 0;
    const content: ResultVersionContent = {
      entries: [...this.entries].sort(byId) as unknown as ResultVersionContent['entries'],
      ...(this.performances.length === 0
        ? {}
        : {
            performances: [...this.performances].sort(
              (a, b) => byId(a, b) || a.ordinal - b.ordinal,
            ),
          }),
    };
    return {
      ok: true,
      content,
      result: {
        family: ctx.ruleset.family,
        mode: ctx.mode,
        entries: [...this.normalized].sort(byId),
      },
    };
  }
}

const isInt = (v: unknown, min = 0, max = MAX_INT): v is number =>
  Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const pairOk = (p: unknown, max: number): p is Pair =>
  Array.isArray(p) && p.length === 2 && isInt(p[0], 0, max) && isInt(p[1], 0, max);

/** The one rule every executor shares: the sheet names exactly the contest's participants. */
function sameParticipants(
  b: Builder,
  ctx: ScoringContext,
  ids: readonly string[],
  path = '/entries',
): boolean {
  const want = [...ctx.participants].sort();
  const got = [...ids].sort();
  if (new Set(got).size !== got.length || want.join() !== got.join()) {
    b.fail(
      path,
      'PARTICIPANTS_MISMATCH',
      'the sheet must list every contest participant exactly once',
    );
    return false;
  }
  return true;
}

// ───────────────────────────── SETS_OF_GAMES ─────────────────────────────

function tiebreakValid(tb: Pair, to: number): boolean {
  const [w, l] = tb[0] > tb[1] ? tb : [tb[1], tb[0]];
  return w >= to && w - l >= 2 && (w === to || w - l === 2);
}

/** Classifies one completed set: the winner side, or undefined when the score is impossible. */
function setWinner(
  set: { games: Pair; tiebreak?: Pair },
  p: { G: number; T: number | undefined; TB: number; advantageSet: boolean },
): 0 | 1 | undefined {
  const [a, b] = set.games;
  if (a === b) return undefined;
  const side: 0 | 1 = a > b ? 0 : 1;
  const w = Math.max(a, b);
  const l = Math.min(a, b);
  if (p.advantageSet || p.T === undefined) {
    if (set.tiebreak !== undefined) return undefined;
    if (w === p.G && l <= p.G - 2) return side;
    if (w > p.G && w - l === 2) return side;
    return undefined;
  }
  if (p.T !== undefined && w === p.T + 1 && l === p.T) {
    if (set.tiebreak === undefined || !tiebreakValid(set.tiebreak, p.TB)) return undefined;
    if ((set.tiebreak[0] > set.tiebreak[1] ? 0 : 1) !== side) return undefined;
    return side;
  }
  if (set.tiebreak !== undefined) return undefined;
  if (w === p.G && l <= p.G - 2) return side;
  if (p.T >= p.G && w === p.G + 1 && l === p.G - 1) return side;
  return undefined;
}

function scoreSets(ctx: ScoringContext, s: SetsSheet): ScoringOutcome {
  const b = new Builder();
  const P = ctx.ruleset.parameters as {
    setsToWin: number;
    gamesPerSet: number;
    tiebreakAt?: number;
    tiebreakTo?: number;
    finalSet: 'FULL' | 'MATCH_TIEBREAK_7' | 'MATCH_TIEBREAK_10' | 'ADVANTAGE';
  };
  if (ctx.participants.length !== 2) {
    b.fail('', 'PARTICIPANTS_MISMATCH', 'a head-to-head contest has exactly two sides');
    return b.done(ctx);
  }
  const ids = ctx.participants as readonly [string, string];
  const S = P.setsToWin;
  const base = { G: P.gamesPerSet, T: P.tiebreakAt, TB: P.tiebreakTo ?? 7 };
  const won: [number, number] = [0, 0];
  const games: [number, number] = [0, 0];
  const term = s.termination;
  if (term !== undefined && term.kind === 'WALKOVER') {
    if ((s.sets?.length ?? 0) > 0 || s.matchTiebreak !== undefined)
      b.fail('/sets', 'WALKOVER_WITH_SCORE', 'a walkover records no score');
    const winner = 1 - term.side;
    ids.forEach((id, i) => {
      b.entries.push({
        participantId: id,
        outcome: i === winner ? 'WALKOVER_WIN' : 'WALKOVER_LOSS',
      });
      b.normalized.push({
        participantId: id,
        outcome: i === winner ? 'WALKOVER_WIN' : 'WALKOVER_LOSS',
        decidedBy: 'WALKOVER',
        opponentId: ids[1 - i] as string,
        metrics: {},
        series: {},
      });
    });
    return b.done(ctx);
  }
  const sets = s.sets ?? [];
  let decided: 0 | 1 | undefined;
  let decidedBy: DecidedBy = 'REGULATION';
  sets.forEach((set, i) => {
    const path = `/sets/${i}`;
    if (!pairOk(set?.games, 99) || (set.tiebreak !== undefined && !pairOk(set.tiebreak, 99))) {
      b.fail(path, 'SET_SCORE_INVALID', 'games and tie-break points are non-negative integers');
      return;
    }
    if (decided !== undefined) {
      b.fail(path, 'SET_AFTER_DECISION', 'no set is played after the match is decided');
      return;
    }
    const finalSet = won[0] === S - 1 && won[1] === S - 1;
    const isLast = i === sets.length - 1;
    const retiredHere = term?.kind === 'RETIRED' && isLast;
    const winner = setWinner(set, {
      ...base,
      advantageSet: finalSet && P.finalSet === 'ADVANTAGE',
    });
    if (finalSet && (P.finalSet === 'MATCH_TIEBREAK_7' || P.finalSet === 'MATCH_TIEBREAK_10'))
      b.fail(path, 'MATCH_TIEBREAK_EXPECTED', 'the deciding set is a match tie-break');
    games[0] += set.games[0];
    games[1] += set.games[1];
    b.perf(ids[0], i + 1, mk('sog.set_games', set.games[0], 'games'));
    b.perf(ids[1], i + 1, mk('sog.set_games', set.games[1], 'games'));
    if (set.tiebreak !== undefined) {
      b.perf(ids[0], 11 + i, mk('sog.tiebreak_points', set.tiebreak[0], 'points'));
      b.perf(ids[1], 11 + i, mk('sog.tiebreak_points', set.tiebreak[1], 'points'));
    }
    if (winner === undefined) {
      if (!retiredHere)
        b.fail(path, 'SET_SCORE_INVALID', `impossible set score ${set.games.join('–')}`);
      return;
    }
    won[winner] += 1;
    if (won[winner] === S) decided = winner;
  });
  if (s.matchTiebreak !== undefined) {
    const to = P.finalSet === 'MATCH_TIEBREAK_7' ? 7 : 10;
    if (!(won[0] === S - 1 && won[1] === S - 1) || !P.finalSet.startsWith('MATCH_TIEBREAK'))
      b.fail('/matchTiebreak', 'MATCH_TIEBREAK_UNEXPECTED', 'no match tie-break is due');
    else if (!pairOk(s.matchTiebreak, 99) || !tiebreakValid(s.matchTiebreak, to))
      b.fail('/matchTiebreak', 'MATCH_TIEBREAK_INVALID', `a match tie-break is won at ${to}+ by 2`);
    else {
      const w: 0 | 1 = s.matchTiebreak[0] > s.matchTiebreak[1] ? 0 : 1;
      won[w] += 1;
      games[w] += 1; // a match tie-break counts as one set and one game (ITF J §57)
      decided = w;
      decidedBy = 'MATCH_TIEBREAK';
      b.perf(ids[0], 20, mk('sog.match_tiebreak_points', s.matchTiebreak[0], 'points'));
      b.perf(ids[1], 20, mk('sog.match_tiebreak_points', s.matchTiebreak[1], 'points'));
    }
  }
  let winner: 0 | 1 | undefined = decided;
  if (term?.kind === 'RETIRED') {
    if (decided !== undefined)
      b.fail(
        '/termination',
        'RETIREMENT_AFTER_DECISION',
        'a decided match cannot end in retirement',
      );
    winner = term.side === 0 ? 1 : 0;
    decidedBy = 'RETIREMENT';
  } else if (decided === undefined)
    b.fail('/sets', 'MATCH_NOT_DECIDED', `a side must win ${S} set${S === 1 ? '' : 's'}`);
  if (winner === undefined) return b.done(ctx);
  ids.forEach((id, i) => {
    const outcome: ResultOutcome =
      i === winner ? 'WIN' : decidedBy === 'RETIREMENT' ? 'RETIRED' : 'LOSS';
    b.entries.push({
      participantId: id,
      outcome,
      primaryMark: mk('sog.sets_won', won[i] as number, 'sets'),
    });
    b.normalized.push({
      participantId: id,
      outcome,
      decidedBy,
      opponentId: ids[1 - i] as string,
      metrics: {
        setsWon: n(won[i] as number),
        setsLost: n(won[1 - i] as number),
        gamesWon: n(games[i] as number),
        gamesLost: n(games[1 - i] as number),
      },
      series: {},
    });
  });
  return b.done(ctx);
}

// ───────────────────────────── TIMED_PERIODS ─────────────────────────────

function scorePeriods(ctx: ScoringContext, s: PeriodsSheet): ScoringOutcome {
  const b = new Builder();
  const P = ctx.ruleset.parameters as {
    periods: number;
    drawAllowed: boolean;
    forfeitScoreFor?: number;
    defaultScoreFor?: number;
  };
  if (ctx.participants.length !== 2) {
    b.fail('', 'PARTICIPANTS_MISMATCH', 'a head-to-head contest has exactly two sides');
    return b.done(ctx);
  }
  const ids = ctx.participants as readonly [string, string];
  const term = s.termination;
  const push = (scores: Pair, winner: 0 | 1 | undefined, decidedBy: DecidedBy, forfeit = false) =>
    ids.forEach((id, i) => {
      const outcome: ResultOutcome =
        winner === undefined
          ? 'DRAW'
          : forfeit
            ? i === winner
              ? 'WALKOVER_WIN'
              : 'WALKOVER_LOSS'
            : i === winner
              ? 'WIN'
              : 'LOSS';
      b.entries.push({
        participantId: id,
        outcome,
        primaryMark: mk('tp.points', scores[i] as number, 'pts'),
      });
      b.normalized.push({
        participantId: id,
        outcome,
        decidedBy,
        opponentId: ids[1 - i] as string,
        metrics: { pointsFor: n(scores[i] as number), pointsAgainst: n(scores[1 - i] as number) },
        series: {},
      });
    });
  if (term?.kind === 'FORFEIT') {
    if ((s.periods?.length ?? 0) > 0)
      b.fail('/periods', 'FORFEIT_WITH_SCORE', 'a forfeit records no periods');
    const winner: 0 | 1 = term.side === 0 ? 1 : 0;
    const scores: [number, number] = [0, 0];
    scores[winner] = P.forfeitScoreFor ?? 0;
    if (b.issues.length === 0) push(scores, winner, 'FORFEIT', true);
    return b.done(ctx);
  }
  const periods = s.periods ?? [];
  const ots = s.overtimes ?? [];
  const totals: [number, number] = [0, 0];
  periods.forEach((p, i) => {
    if (!pairOk(p, 300))
      return b.fail(`/periods/${i}`, 'POINTS_INVALID', 'points are non-negative integers');
    totals[0] += p[0];
    totals[1] += p[1];
    b.perf(ids[0], i + 1, mk('tp.period_points', p[0], 'pts'));
    b.perf(ids[1], i + 1, mk('tp.period_points', p[1], 'pts'));
  });
  if (term?.kind !== 'DEFAULT' && periods.length !== P.periods)
    b.fail('/periods', 'PERIODS_COUNT', `exactly ${P.periods} periods are played`);
  if (periods.length > P.periods)
    b.fail('/periods', 'PERIODS_COUNT', `at most ${P.periods} periods`);
  const regulationTied = totals[0] === totals[1];
  ots.forEach((p, j) => {
    const path = `/overtimes/${j}`;
    if (!pairOk(p, 300)) return b.fail(path, 'POINTS_INVALID', 'points are non-negative integers');
    if (term === undefined && totals[0] !== totals[1])
      b.fail(path, 'OVERTIME_UNEXPECTED', 'overtime is only played while the score is level');
    totals[0] += p[0];
    totals[1] += p[1];
    b.perf(ids[0], 11 + j, mk('tp.overtime_points', p[0], 'pts'));
    b.perf(ids[1], 11 + j, mk('tp.overtime_points', p[1], 'pts'));
  });
  if (ots.length > 0 && (P.drawAllowed || !regulationTied) && term === undefined)
    b.fail('/overtimes', 'OVERTIME_UNEXPECTED', 'no overtime is due');
  if (term?.kind === 'DEFAULT') {
    const winner: 0 | 1 = term.side === 0 ? 1 : 0;
    b.perf(ids[term.side], 30, mk('tp.defaulted', 1, 'flag'));
    const scores: [number, number] = [totals[0], totals[1]];
    if (scores[winner] <= scores[term.side] && P.defaultScoreFor !== undefined) {
      scores[winner] = P.defaultScoreFor;
      scores[term.side] = 0;
    }
    if (b.issues.length === 0) push(scores, winner, 'DEFAULT');
    return b.done(ctx);
  }
  if (totals[0] === totals[1] && !P.drawAllowed)
    b.fail('/overtimes', 'NOT_DECIDED', 'the game is not decided (play overtime)');
  if (b.issues.length === 0)
    push(
      totals,
      totals[0] === totals[1] ? undefined : totals[0] > totals[1] ? 0 : 1,
      ots.length > 0 ? 'OVERTIME' : 'REGULATION',
    );
  return b.done(ctx);
}

// ───────────────────────────── TIMED_OR_TARGET ─────────────────────────────

function scoreTarget(ctx: ScoringContext, s: TargetSheet): ScoringOutcome {
  const b = new Builder();
  const P = ctx.ruleset.parameters as { targetScore: number; overtimeTargetMargin: number };
  if (ctx.participants.length !== 2) {
    b.fail('', 'PARTICIPANTS_MISMATCH', 'a head-to-head contest has exactly two sides');
    return b.done(ctx);
  }
  const ids = ctx.participants as readonly [string, string];
  if (s.termination?.kind === 'FORFEIT') {
    if (s.regulation !== undefined && (s.regulation[0] !== 0 || s.regulation[1] !== 0))
      b.fail('/regulation', 'FORFEIT_WITH_SCORE', 'a forfeit records no score');
    const winner = s.termination.side === 0 ? 1 : 0;
    ids.forEach((id, i) => {
      const outcome: ResultOutcome = i === winner ? 'WALKOVER_WIN' : 'WALKOVER_LOSS';
      b.entries.push({ participantId: id, outcome });
      b.normalized.push({
        participantId: id,
        outcome,
        decidedBy: 'FORFEIT',
        opponentId: ids[1 - i] as string,
        metrics: {},
        series: {},
      });
    });
    return b.done(ctx);
  }
  const T = P.targetScore;
  const reg = s.regulation;
  if (!pairOk(reg, 200)) {
    b.fail('/regulation', 'POINTS_INVALID', 'points are non-negative integers');
    return b.done(ctx);
  }
  const hi = Math.max(reg[0], reg[1]);
  const lo = Math.min(reg[0], reg[1]);
  let totals: Pair = reg;
  let decidedBy: DecidedBy = 'REGULATION';
  if (s.endedBy === 'TARGET') {
    // The game ends the moment a side reaches the target; a last shot may overshoot by the shot value.
    if (!(hi >= T && hi <= T + 1 && lo < T))
      b.fail(
        '/regulation',
        'TARGET_SCORE_INVALID',
        `a target finish has the winner at ${T}–${T + 1}`,
      );
    if (s.overtime !== undefined)
      b.fail('/overtime', 'OVERTIME_UNEXPECTED', 'no overtime after a target finish');
  } else {
    if (hi >= T)
      b.fail('/regulation', 'TIME_SCORE_INVALID', `a timed finish has both sides below ${T}`);
    if (reg[0] === reg[1]) {
      const ot = s.overtime;
      const M = P.overtimeTargetMargin;
      if (!pairOk(ot, 50))
        b.fail('/overtime', 'OVERTIME_REQUIRED', 'a level game goes to overtime');
      else {
        const ohi = Math.max(ot[0], ot[1]);
        const olo = Math.min(ot[0], ot[1]);
        if (!(ohi >= M && ohi <= M + 1 && olo < M))
          b.fail(
            '/overtime',
            'OVERTIME_SCORE_INVALID',
            `overtime is won by the first side to ${M}`,
          );
        totals = [reg[0] + ot[0], reg[1] + ot[1]];
        decidedBy = 'OVERTIME';
        b.perf(ids[0], 2, mk('tot.overtime_points', ot[0], 'pts'));
        b.perf(ids[1], 2, mk('tot.overtime_points', ot[1], 'pts'));
      }
    } else if (s.overtime !== undefined)
      b.fail('/overtime', 'OVERTIME_UNEXPECTED', 'no overtime after a decided game');
  }
  b.perf(ids[0], 1, mk('tot.regulation_points', reg[0], 'pts'));
  b.perf(ids[1], 1, mk('tot.regulation_points', reg[1], 'pts'));
  const ended = s.endedBy === 'TARGET' ? 1 : 2;
  b.perf(ids[0], 3, mk('tot.ended_by', ended, 'code'));
  b.perf(ids[1], 3, mk('tot.ended_by', ended, 'code'));
  if (b.issues.length > 0) return b.done(ctx);
  const winner = totals[0] > totals[1] ? 0 : 1;
  ids.forEach((id, i) => {
    const outcome: ResultOutcome = i === winner ? 'WIN' : 'LOSS';
    b.entries.push({
      participantId: id,
      outcome,
      primaryMark: mk('tot.points', totals[i] as number, 'pts'),
    });
    b.normalized.push({
      participantId: id,
      outcome,
      decidedBy,
      opponentId: ids[1 - i] as string,
      metrics: {
        pointsFor: n(totals[i] as number),
        pointsAgainst: n(totals[1 - i] as number),
        regulationPointsFor: n(reg[i] as number),
      },
      series: {},
    });
  });
  return b.done(ctx);
}

// ───────────────────────────── timed families ─────────────────────────────

/** Official time: the measured ms rounded to the ruleset precision in the declared direction. */
export function officialTime(
  ms: number,
  precisionMs: number,
  rounding: 'UP' | 'DOWN' | 'TRUNCATE',
): number {
  const q = Math.floor(ms / precisionMs) * precisionMs;
  return rounding === 'UP' && q !== ms ? q + precisionMs : q;
}

const TIMED_STATUSES: Record<TimedSheet['family'], readonly EntryStatus[]> = {
  ELAPSED_TIME: ['FINISHED', 'DNF', 'DNS', 'DQ', 'NOT_PLACED'],
  FINISH_ORDER_WITH_TIME: ['FINISHED', 'DNF', 'DNS', 'DQ', 'NOT_PLACED'],
  LAPS_AND_TIME: ['FINISHED', 'DNF', 'DNS', 'DQ', 'NOT_PLACED', 'PULLED'],
};

function scoreTimed(ctx: ScoringContext, s: TimedSheet): ScoringOutcome {
  const b = new Builder();
  const P = ctx.ruleset.parameters as {
    precisionMs: string;
    rounding: 'UP' | 'DOWN' | 'TRUNCATE';
    teamTime?: 'TEAM_FINISH' | 'SUM_OF_LEGS';
    sameTimeGroups?: boolean;
    notPlacedBeyondPercent?: number;
  };
  const family = s.family;
  const entries = s.entries ?? [];
  if (
    !sameParticipants(
      b,
      ctx,
      entries.map((e) => e.participantId),
    )
  )
    return b.done(ctx);
  const precision = Number(P.precisionMs);
  const timed: { id: string; official: number; position?: number }[] = [];
  const positions: number[] = [];
  const pulls: number[] = [];
  entries.forEach((e, i) => {
    const path = `/entries/${i}`;
    if (!TIMED_STATUSES[family].includes(e.status)) {
      b.fail(
        `${path}/status`,
        'STATUS_NOT_ALLOWED',
        `${e.status} is not a status of this ruleset family`,
      );
      return;
    }
    const finishedLike = e.status === 'FINISHED' || e.status === 'NOT_PLACED';
    const members = ctx.rosters?.[e.participantId];
    let time = e.timeMs;
    if (e.legs !== undefined) {
      if (members === undefined)
        b.fail(`${path}/legs`, 'LEGS_FOR_INDIVIDUAL', 'only team entrants run legs');
      else if (!e.legs.every((l) => members.includes(l.athleteId) && isInt(l.timeMs, 1)))
        b.fail(`${path}/legs`, 'LEG_INVALID', 'legs name rostered athletes with positive times');
      else if (new Set(e.legs.map((l) => l.athleteId)).size !== e.legs.length)
        b.fail(`${path}/legs`, 'LEG_INVALID', 'each athlete runs one leg');
      if (P.teamTime === 'SUM_OF_LEGS' && finishedLike) {
        const sum = e.legs.reduce((t, l) => t + (isInt(l.timeMs, 1) ? l.timeMs : 0), 0);
        if (time !== undefined && time !== sum)
          b.fail(`${path}/timeMs`, 'TEAM_TIME_MISMATCH', 'the team time is the sum of its legs');
        time = sum;
      }
    } else if (P.teamTime === 'SUM_OF_LEGS' && members !== undefined && finishedLike)
      b.fail(`${path}/legs`, 'LEGS_REQUIRED', 'this ruleset derives the team time from its legs');
    if (finishedLike) {
      if (!isInt(time, 1))
        b.fail(`${path}/timeMs`, 'TIME_REQUIRED', 'a finisher has a positive time');
    } else if (e.timeMs !== undefined)
      b.fail(`${path}/timeMs`, 'TIME_FORBIDDEN', `${e.status} records no official time`);
    if (e.netTimeMs !== undefined && (!finishedLike || !isInt(e.netTimeMs, 1)))
      b.fail(`${path}/netTimeMs`, 'NET_TIME_INVALID', 'net time is a positive time of a finisher');
    if (family === 'FINISH_ORDER_WITH_TIME') {
      if (e.status === 'FINISHED') {
        if (!isInt(e.finishPosition, 1, entries.length))
          b.fail(`${path}/finishPosition`, 'POSITION_REQUIRED', 'finishers have a finish position');
        else positions.push(e.finishPosition);
      } else if (e.finishPosition !== undefined)
        b.fail(
          `${path}/finishPosition`,
          'POSITION_FORBIDDEN',
          'only finishers have a finish position',
        );
    } else if (e.finishPosition !== undefined)
      b.fail(`${path}/finishPosition`, 'POSITION_FORBIDDEN', 'this family ranks by time');
    if (family === 'LAPS_AND_TIME') {
      if (
        e.status === 'FINISHED' ||
        e.status === 'PULLED' ||
        e.status === 'DNF' ||
        e.status === 'NOT_PLACED'
      ) {
        if (!isInt(e.lapsCompleted, 0, 1000))
          b.fail(`${path}/lapsCompleted`, 'LAPS_REQUIRED', 'laps completed are recorded');
      }
      if (e.status === 'PULLED') {
        if (!isInt(e.lapsDown, 1, 1000) || !isInt(e.pullOrder, 1, entries.length))
          b.fail(path, 'PULL_INVALID', 'a pulled entrant has laps down and a pull order');
        else pulls.push(e.pullOrder);
      } else if (e.lapsDown !== undefined || e.pullOrder !== undefined)
        b.fail(path, 'PULL_FORBIDDEN', 'only pulled entrants have laps down / pull order');
    } else if (
      e.lapsCompleted !== undefined ||
      e.lapsDown !== undefined ||
      e.pullOrder !== undefined
    )
      b.fail(path, 'LAPS_FORBIDDEN', 'this family does not count laps');
    if (e.status === 'PULLED' && e.timeMs !== undefined)
      b.fail(`${path}/timeMs`, 'TIME_FORBIDDEN', 'a pulled entrant has no time');
    if (b.issues.length > 0) return;
    const official = finishedLike ? officialTime(time as number, precision, P.rounding) : undefined;
    const outcome = STATUS_OUTCOME[e.status];
    b.entries.push({
      participantId: e.participantId,
      outcome,
      ...(official === undefined ? {} : { primaryMark: mk('time.elapsed_ms', official, 'ms') }),
    });
    const metrics: Record<string, string> = {};
    if (official !== undefined) {
      metrics['elapsedTimeMs'] = n(official);
      metrics['rawTimeMs'] = n(time as number);
      b.perf(e.participantId, 1, mk('time.raw_ms', time as number, 'ms'));
      timed.push({
        id: e.participantId,
        official,
        ...(e.finishPosition === undefined ? {} : { position: e.finishPosition }),
      });
    }
    if (e.netTimeMs !== undefined) b.perf(e.participantId, 2, mk('time.net_ms', e.netTimeMs, 'ms'));
    if (e.finishPosition !== undefined) {
      metrics['finishPosition'] = n(e.finishPosition);
      b.perf(e.participantId, 3, mk('finish.position', e.finishPosition, 'place'));
    }
    if (e.lapsCompleted !== undefined) {
      metrics['lapsCompleted'] = n(e.lapsCompleted);
      b.perf(e.participantId, 4, mk('laps.completed', e.lapsCompleted, 'laps'));
    }
    if (e.lapsDown !== undefined) {
      metrics['lapsDown'] = n(e.lapsDown);
      b.perf(e.participantId, 5, mk('laps.down', e.lapsDown, 'laps'));
    }
    if (e.pullOrder !== undefined) {
      metrics['pullOrder'] = n(e.pullOrder);
      b.perf(e.participantId, 6, mk('laps.pull_order', e.pullOrder, 'place'));
    }
    (e.legs ?? []).forEach((l, j) =>
      b.perf(e.participantId, 11 + j, mk('time.leg_ms', l.timeMs, 'ms'), l.athleteId),
    );
    b.normalized.push({ participantId: e.participantId, outcome, metrics, series: {} });
  });
  if (positions.length > 0) {
    const sorted = [...positions].sort((x, y) => x - y);
    if (!sorted.every((p, i) => p === i + 1))
      b.fail('/entries', 'POSITIONS_INVALID', 'finish positions are 1..finishers, each once');
    // Finish order and times agree: a later finisher never has a lower time (same time allowed).
    const byPos = timed
      .filter((t) => t.position !== undefined)
      .sort((x, y) => (x.position as number) - (y.position as number));
    for (let i = 1; i < byPos.length; i++)
      if (
        (byPos[i] as { official: number }).official <
        (byPos[i - 1] as { official: number }).official
      )
        b.fail('/entries', 'ORDER_TIME_INCONSISTENT', 'finish order and times disagree');
  }
  if (pulls.length > 0) {
    const sorted = [...pulls].sort((x, y) => x - y);
    if (!sorted.every((p, i) => p === i + 1))
      b.fail('/entries', 'PULL_ORDER_INVALID', 'pull orders are 1..pulled, each once');
  }
  if (P.notPlacedBeyondPercent !== undefined && timed.length > 0) {
    const winner = Math.min(
      ...entries
        .filter((e) => e.status === 'FINISHED')
        .map((e) => timed.find((t) => t.id === e.participantId)?.official ?? Infinity),
    );
    const limit = Math.floor((winner * (100 + P.notPlacedBeyondPercent)) / 100);
    entries.forEach((e, i) => {
      const t = timed.find((x) => x.id === e.participantId)?.official;
      if (e.status === 'FINISHED' && t !== undefined && Number.isFinite(winner) && t > limit)
        b.fail(
          `/entries/${i}/status`,
          'NOT_PLACED_EXPECTED',
          'beyond the time limit a finisher is NOT_PLACED',
        );
    });
  }
  return b.done(ctx);
}

// ───────────────────────────── FRAMES_PINFALL ─────────────────────────────

const gamesOk = (g: unknown, count: number): g is readonly number[] =>
  Array.isArray(g) && g.length === count && g.every((x) => isInt(x, 0, 300));

/** USBC-style handicap per game: floor(percent × (basis − average) / 100), never negative. */
export function pinfallHandicap(average: number, basis: number, percent: number): number {
  return Math.max(0, Math.floor(((basis - average) * percent) / 100));
}

function scorePinfall(ctx: ScoringContext, s: PinfallSheet): ScoringOutcome {
  const b = new Builder();
  const P = ctx.ruleset.parameters as {
    gamesPerBlock: number;
    handicapPercent?: number;
    handicapBasis?: number;
    baker: boolean;
    handicapAverageAttribute?: string;
  };
  const entries = s.entries ?? [];
  if (
    !sameParticipants(
      b,
      ctx,
      entries.map((e) => e.participantId),
    )
  )
    return b.done(ctx);
  const G = P.gamesPerBlock;
  const handicapOn = P.handicapPercent !== undefined && P.handicapBasis !== undefined;
  entries.forEach((e, i) => {
    const path = `/entries/${i}`;
    const roster = ctx.rosters?.[e.participantId];
    if (e.status !== 'FINISHED') {
      if (e.games !== undefined || e.members !== undefined)
        b.fail(path, 'SCORE_FORBIDDEN', `${e.status} records no games`);
      const outcome = STATUS_OUTCOME[e.status];
      b.entries.push({ participantId: e.participantId, outcome });
      b.normalized.push({ participantId: e.participantId, outcome, metrics: {}, series: {} });
      return;
    }
    let gameTotals: number[];
    if (roster === undefined || P.baker) {
      if (!gamesOk(e.games, G) || e.members !== undefined) {
        b.fail(`${path}/games`, 'GAMES_INVALID', `${G} games of 0–300 pins`);
        return;
      }
      gameTotals = [...e.games];
      e.games.forEach((pins, g) => b.perf(e.participantId, g + 1, mk('pins.game', pins, 'pins')));
    } else {
      const members = e.members ?? [];
      if (
        members.length === 0 ||
        e.games !== undefined ||
        new Set(members.map((m) => m.athleteId)).size !== members.length ||
        !members.every((m) => roster.includes(m.athleteId) && gamesOk(m.games, G))
      ) {
        b.fail(
          `${path}/members`,
          'MEMBERS_INVALID',
          `rostered members with ${G} games of 0–300 each`,
        );
        return;
      }
      gameTotals = Array.from({ length: G }, (_, g) =>
        members.reduce((t, m) => t + (m.games[g] as number), 0),
      );
      for (const m of members) {
        const mi = roster.indexOf(m.athleteId) + 1;
        m.games.forEach((pins, g) =>
          b.perf(
            e.participantId,
            mi * 100 + g + 1,
            mk('pins.member_game', pins, 'pins'),
            m.athleteId,
          ),
        );
      }
    }
    let handicap = 0;
    if (handicapOn) {
      const key = P.handicapAverageAttribute;
      const own = key === undefined ? undefined : ctx.attributes?.[e.participantId]?.[key];
      const memberAvgs =
        key === undefined || roster === undefined
          ? undefined
          : roster.map((a) => ctx.memberAttributes?.[e.participantId]?.[a]?.[key]);
      if (own !== undefined)
        handicap = pinfallHandicap(
          Number(own),
          P.handicapBasis as number,
          P.handicapPercent as number,
        );
      else if (
        memberAvgs !== undefined &&
        memberAvgs.length > 0 &&
        memberAvgs.every((v) => v !== undefined)
      )
        handicap = memberAvgs.reduce(
          (t, v) =>
            t + pinfallHandicap(Number(v), P.handicapBasis as number, P.handicapPercent as number),
          0,
        );
      else {
        b.fail(
          path,
          'HANDICAP_INPUT_MISSING',
          'a handicap ruleset needs every declared entering average',
        );
        return;
      }
      b.perf(e.participantId, 90, mk('pins.handicap_per_game', handicap, 'pins'));
    }
    const scratch = gameTotals.reduce((t, x) => t + x, 0);
    b.entries.push({
      participantId: e.participantId,
      outcome: 'RANKED',
      primaryMark: mk('pins.total', scratch, 'pins'),
    });
    b.normalized.push({
      participantId: e.participantId,
      outcome: 'RANKED',
      metrics: {
        pins: n(scratch),
        pinsHandicap: n(scratch + handicap * G),
        handicapPerGame: n(handicap),
        highGame: n(Math.max(...gameTotals)),
      },
      series: { games: gameTotals, gamesHandicap: gameTotals.map((g) => g + handicap) },
    });
  });
  return b.done(ctx);
}

// ───────────────────────────── STROKES / STABLEFORD ─────────────────────────────

/** WHS-style rounding of handicap × allowance% to the nearest whole number (.5 up). */
export function playingHandicap(courseHandicap: number, percent: number): number {
  return Math.floor((2 * courseHandicap * percent + 100) / 200);
}

/** Strokes received on a hole of stroke index `si` (1..holes) for a playing handicap. */
export function strokesReceived(ph: number, si: number, holes: number): number {
  const abs = Math.abs(ph);
  const base = Math.floor(abs / holes);
  const rem = abs - base * holes;
  if (ph >= 0) return base + (si <= rem ? 1 : 0);
  const back = base + (si > holes - rem ? 1 : 0);
  return back === 0 ? 0 : -back;
}

function scoreGolf(ctx: ScoringContext, s: GolfSheet): ScoringOutcome {
  const b = new Builder();
  const P = ctx.ruleset.parameters as {
    holes: '9' | '18';
    scoring?: 'GROSS' | 'NET';
    allowancePercent?: number;
    maxScorePerHole?: 'NONE' | 'NET_DOUBLE_BOGEY';
    teamFormat?: 'INDIVIDUAL' | 'BETTER_BALL' | 'TEAM_BALL';
    teamAllowancePercents?: readonly number[];
  };
  const stableford = s.family === 'STABLEFORD';
  const H = Number(P.holes);
  const net = stableford || P.scoring === 'NET';
  const format = P.teamFormat ?? 'INDIVIDUAL';
  const course = s.course?.holes;
  const needCourse = net || P.maxScorePerHole === 'NET_DOUBLE_BOGEY';
  if (course !== undefined) {
    const si = course.map((h) => h.strokeIndex).sort((x, y) => x - y);
    if (
      course.length !== H ||
      !course.every((h) => isInt(h.par, 3, 6)) ||
      !si.every((v, i) => v === i + 1)
    )
      b.fail('/course', 'COURSE_INVALID', `${H} holes with par 3–6 and stroke indexes 1..${H}`);
  } else if (needCourse)
    b.fail('/course', 'COURSE_REQUIRED', 'net and Stableford scoring need par and stroke index');
  const entries = s.entries ?? [];
  if (
    !sameParticipants(
      b,
      ctx,
      entries.map((e) => e.participantId),
    ) ||
    b.issues.length > 0
  )
    return b.done(ctx);
  const holesOk = (h: unknown, allowZero: boolean): h is readonly number[] =>
    Array.isArray(h) && h.length === H && h.every((x) => isInt(x, allowZero ? 0 : 1, 20));
  entries.forEach((e, i) => {
    const path = `/entries/${i}`;
    const roster = ctx.rosters?.[e.participantId];
    if (e.status !== 'FINISHED') {
      if (e.holes !== undefined || e.members !== undefined)
        b.fail(path, 'SCORE_FORBIDDEN', `${e.status} records no holes`);
      const outcome = STATUS_OUTCOME[e.status];
      b.entries.push({ participantId: e.participantId, outcome });
      b.normalized.push({ participantId: e.participantId, outcome, metrics: {}, series: {} });
      return;
    }
    const par = course?.map((h) => h.par) ?? [];
    const si = course?.map((h) => h.strokeIndex) ?? [];
    // Per hole: gross strokes and strokes received for the scoring unit (entrant or best member).
    let gross: number[] = [];
    let received: number[] = Array.from({ length: H }, () => 0);
    let ph = 0;
    if (format === 'BETTER_BALL' && roster !== undefined) {
      const members = e.members ?? [];
      const chs = new Map(
        (e.memberCourseHandicaps ?? []).map((m) => [m.athleteId, m.courseHandicap]),
      );
      if (
        members.length === 0 ||
        e.holes !== undefined ||
        !members.every((m) => roster.includes(m.athleteId) && holesOk(m.holes, true))
      ) {
        b.fail(
          `${path}/members`,
          'MEMBERS_INVALID',
          `rostered members with ${H} holes (0 = no score)`,
        );
        return;
      }
      if (net && !members.every((m) => isInt(chs.get(m.athleteId), -10, 54))) {
        b.fail(
          `${path}/memberCourseHandicaps`,
          'HANDICAP_INPUT_MISSING',
          'net better ball needs each member course handicap',
        );
        return;
      }
      const memberPh = members.map((m) =>
        net ? playingHandicap(chs.get(m.athleteId) as number, P.allowancePercent ?? 100) : 0,
      );
      for (let h = 0; h < H; h++) {
        let best: { gross: number; recv: number; value: number } | undefined;
        members.forEach((m, mi) => {
          const g = m.holes[h] as number;
          if (g === 0) return;
          const recv = net ? strokesReceived(memberPh[mi] as number, si[h] as number, H) : 0;
          const value = stableford ? -Math.max(0, 2 + (par[h] as number) + recv - g) : g - recv;
          if (best === undefined || value < best.value) best = { gross: g, recv, value };
        });
        if (best === undefined) {
          b.fail(`${path}/members`, 'HOLE_WITHOUT_SCORE', `hole ${h + 1} has no member score`);
          return;
        }
        gross.push((best as { gross: number }).gross);
        received[h] = (best as { recv: number }).recv;
      }
      members.forEach((m) => {
        const mi = roster.indexOf(m.athleteId) + 1;
        m.holes.forEach((g, h) => {
          if (g > 0)
            b.perf(
              e.participantId,
              mi * 1000 + h + 1,
              mk('golf.member_hole_strokes', g, 'strokes'),
              m.athleteId,
            );
        });
        if (net)
          b.perf(
            e.participantId,
            400 + mi,
            mk('golf.member_course_handicap', chs.get(m.athleteId) as number, 'strokes'),
            m.athleteId,
          );
      });
    } else {
      if (!holesOk(e.holes, false) || e.members !== undefined) {
        b.fail(`${path}/holes`, 'HOLES_INVALID', `${H} holes of 1–20 strokes`);
        return;
      }
      gross = [...e.holes];
      if (net) {
        if (format === 'TEAM_BALL' && roster !== undefined) {
          const pct = P.teamAllowancePercents ?? [];
          const chs = (e.memberCourseHandicaps ?? []).filter((m) => roster.includes(m.athleteId));
          if (
            chs.length !== roster.length ||
            chs.length > pct.length ||
            !chs.every((m) => isInt(m.courseHandicap, -10, 54))
          ) {
            b.fail(
              `${path}/memberCourseHandicaps`,
              'HANDICAP_INPUT_MISSING',
              'a team ball handicap needs every member course handicap',
            );
            return;
          }
          const sorted = [...chs].sort((x, y) => x.courseHandicap - y.courseHandicap);
          const twice = sorted.reduce(
            (t, m, k) => t + 2 * m.courseHandicap * (pct[k] as number),
            0,
          );
          ph = Math.floor((twice + 100) / 200);
          chs.forEach((m) =>
            b.perf(
              e.participantId,
              400 + roster.indexOf(m.athleteId) + 1,
              mk('golf.member_course_handicap', m.courseHandicap, 'strokes'),
              m.athleteId,
            ),
          );
        } else {
          if (!isInt(e.courseHandicap, -10, 54)) {
            b.fail(
              `${path}/courseHandicap`,
              'HANDICAP_INPUT_MISSING',
              'net scoring needs a course handicap',
            );
            return;
          }
          ph = playingHandicap(e.courseHandicap, P.allowancePercent ?? 100);
          b.perf(e.participantId, 400, mk('golf.course_handicap', e.courseHandicap, 'strokes'));
        }
        received = si.map((x) => strokesReceived(ph, x, H));
      }
      gross.forEach((g, h) =>
        b.perf(e.participantId, h + 1, mk('golf.hole_strokes', g, 'strokes')),
      );
    }
    (course ?? []).forEach((h, k) => {
      b.perf(e.participantId, 201 + k, mk('golf.par', h.par, 'strokes'));
      b.perf(e.participantId, 301 + k, mk('golf.stroke_index', h.strokeIndex, 'index'));
    });
    const adjusted = gross.map((g, h) =>
      P.maxScorePerHole === 'NET_DOUBLE_BOGEY'
        ? Math.min(g, (par[h] as number) + 2 + (received[h] as number))
        : g,
    );
    const metrics: Record<string, string> = { strokesGross: n(gross.reduce((t, x) => t + x, 0)) };
    const series: Record<string, number[]> = {};
    if (stableford) {
      const pts = gross.map((g, h) =>
        Math.max(0, 2 + (par[h] as number) + (received[h] as number) - g),
      );
      metrics['stablefordPoints'] = n(pts.reduce((t, x) => t + x, 0));
      series['holes'] = pts;
      b.entries.push({
        participantId: e.participantId,
        outcome: 'RANKED',
        primaryMark: mk('golf.stableford_points', Number(metrics['stablefordPoints']), 'pts'),
      });
    } else {
      const holeNet = adjusted.map((g, h) => (net ? g - (received[h] as number) : g));
      const total = net
        ? adjusted.reduce((t, x) => t + x, 0) - (format === 'BETTER_BALL' ? 0 : ph)
        : adjusted.reduce((t, x) => t + x, 0);
      const strokes = format === 'BETTER_BALL' ? holeNet.reduce((t, x) => t + x, 0) : total;
      metrics['strokes'] = n(strokes);
      series['holes'] = holeNet;
      b.entries.push({
        participantId: e.participantId,
        outcome: 'RANKED',
        primaryMark: mk('golf.strokes', strokes, 'strokes'),
      });
    }
    b.normalized.push({ participantId: e.participantId, outcome: 'RANKED', metrics, series });
  });
  return b.done(ctx);
}

// ───────────────────────────── MATCH_PLAY_HOLES ─────────────────────────────

function scoreMatchPlay(ctx: ScoringContext, s: MatchPlaySheet): ScoringOutcome {
  const b = new Builder();
  const P = ctx.ruleset.parameters as { holes: '9' | '18'; extraHoles: 'SUDDEN_DEATH' | 'NONE' };
  if (ctx.participants.length !== 2) {
    b.fail('', 'PARTICIPANTS_MISMATCH', 'a head-to-head contest has exactly two sides');
    return b.done(ctx);
  }
  const ids = ctx.participants as readonly [string, string];
  const H = Number(P.holes);
  const holes = s.holes ?? [];
  let up = 0; // positive: side A ahead
  let decidedAt: number | undefined;
  holes.forEach((h, i) => {
    if (h !== 'A' && h !== 'B' && h !== 'HALVED')
      return b.fail(`/holes/${i}`, 'HOLE_INVALID', 'A, B or HALVED');
    if (decidedAt !== undefined)
      return b.fail(
        `/holes/${i}`,
        'HOLE_AFTER_DECISION',
        'no hole is played after the match is decided',
      );
    up += h === 'A' ? 1 : h === 'B' ? -1 : 0;
    b.perf(ids[0], i + 1, mk('mp.hole', h === 'A' ? 2 : h === 'HALVED' ? 1 : 0, 'code'));
    b.perf(ids[1], i + 1, mk('mp.hole', h === 'B' ? 2 : h === 'HALVED' ? 1 : 0, 'code'));
    const played = i + 1;
    if (played < H ? Math.abs(up) > H - played : up !== 0) decidedAt = played;
    if (played > H && P.extraHoles === 'NONE')
      b.fail(`/holes/${i}`, 'EXTRA_HOLE_NOT_ALLOWED', 'no extra holes in this ruleset');
  });
  let winner: 0 | 1 | undefined;
  let decidedBy: DecidedBy = holes.length > H ? 'EXTRA_HOLES' : 'REGULATION';
  if (s.conceded !== undefined) {
    if (decidedAt !== undefined)
      b.fail('/conceded', 'CONCESSION_AFTER_DECISION', 'a decided match cannot be conceded');
    winner = s.conceded.side === 0 ? 1 : 0;
    decidedBy = 'CONCESSION';
    b.perf(ids[s.conceded.side], 99, mk('mp.conceded', 1, 'flag'));
  } else if (decidedAt !== undefined) winner = up > 0 ? 0 : 1;
  else if (!(holes.length === H && up === 0 && P.extraHoles === 'NONE'))
    b.fail('/holes', 'MATCH_NOT_DECIDED', 'the match is not decided');
  if (b.issues.length > 0) return b.done(ctx);
  const won = [holes.filter((h) => h === 'A').length, holes.filter((h) => h === 'B').length];
  ids.forEach((id, i) => {
    const outcome: ResultOutcome = winner === undefined ? 'DRAW' : i === winner ? 'WIN' : 'LOSS';
    const margin = i === 0 ? up : -up;
    b.entries.push({
      participantId: id,
      outcome,
      primaryMark: mk('mp.holes_up', Math.max(0, margin), 'holes'),
    });
    b.normalized.push({
      participantId: id,
      outcome,
      decidedBy,
      opponentId: ids[1 - i] as string,
      metrics: {
        holesWon: n(won[i] as number),
        holesLost: n(won[1 - i] as number),
        holesUp: n(Math.max(0, margin)),
      },
      series: {},
    });
  });
  return b.done(ctx);
}

// ───────────────────────────── dispatch ─────────────────────────────

const HEAD_TO_HEAD_FAMILIES = [
  'SETS_OF_GAMES',
  'TIMED_PERIODS',
  'TIMED_OR_TARGET',
  'MATCH_PLAY_HOLES',
];

/**
 * Validates a score sheet against the ruleset and context and normalizes it. Fails closed with
 * coded issues; never guesses a missing value.
 */
export function scoreContest(ctx: ScoringContext, sheet: ScoreSheet): ScoringOutcome {
  const rulesetIssues = validateRulesetSpec(ctx.ruleset);
  if (rulesetIssues.length > 0)
    return {
      ok: false,
      issues: rulesetIssues.map((i) => ({
        path: `/ruleset${i.path}`,
        code: 'RULESET_INVALID',
        message: i.message,
      })),
    };
  if (typeof sheet !== 'object' || sheet === null || sheet.family !== ctx.ruleset.family)
    return {
      ok: false,
      issues: [
        {
          path: '/family',
          code: 'FAMILY_MISMATCH',
          message: `the pinned ruleset is ${ctx.ruleset.family}`,
        },
      ],
    };
  const h2h = HEAD_TO_HEAD_FAMILIES.includes(sheet.family);
  if (h2h !== (ctx.mode === 'HEAD_TO_HEAD'))
    return {
      ok: false,
      issues: [
        {
          path: '/family',
          code: 'MODE_MISMATCH',
          message: 'this ruleset does not fit this contest',
        },
      ],
    };
  switch (sheet.family) {
    case 'SETS_OF_GAMES':
      return scoreSets(ctx, sheet);
    case 'TIMED_PERIODS':
      return scorePeriods(ctx, sheet);
    case 'TIMED_OR_TARGET':
      return scoreTarget(ctx, sheet);
    case 'ELAPSED_TIME':
    case 'FINISH_ORDER_WITH_TIME':
    case 'LAPS_AND_TIME':
      return scoreTimed(ctx, sheet);
    case 'FRAMES_PINFALL':
      return scorePinfall(ctx, sheet);
    case 'STROKES':
    case 'STABLEFORD':
      return scoreGolf(ctx, sheet);
    case 'MATCH_PLAY_HOLES':
      return scoreMatchPlay(ctx, sheet);
    default:
      return {
        ok: false,
        issues: [
          { path: '/family', code: 'FAMILY_UNSUPPORTED', message: 'unknown ruleset family' },
        ],
      };
  }
}
