import type { ResultContent } from './results';

/**
 * ONCF-L5 score sheets for the head-to-head ruleset families: the rows a family's sheet takes
 * under its ruleset parameters, form fields → sheet, and stored `@1` content → a score line (and
 * back into the form, for a correction). Layout and formatting only — whether a score is possible
 * is the ruleset's question, answered by the API. Client-safe (imported by the entry form).
 */

/** The head-to-head families this workspace can enter (field families are a later slice). */
export const ENTRY_FAMILIES = [
  'SETS_OF_GAMES',
  'TIMED_PERIODS',
  'TIMED_OR_TARGET',
  'MATCH_PLAY_HOLES',
] as const;
export type EntryFamily = (typeof ENTRY_FAMILIES)[number];

export const isEntryFamily = (f: unknown): f is EntryFamily =>
  typeof f === 'string' && (ENTRY_FAMILIES as readonly string[]).includes(f);

export const FAMILY_LABEL: Record<string, string> = {
  SETS_OF_GAMES: 'sets of games',
  TIMED_PERIODS: 'timed periods',
  TIMED_OR_TARGET: 'time or target score',
  MATCH_PLAY_HOLES: 'match play',
  ELAPSED_TIME: 'elapsed time',
  FINISH_ORDER_WITH_TIME: 'finish order and time',
  LAPS_AND_TIME: 'laps and time',
  FRAMES_PINFALL: 'pinfall',
  STROKES: 'stroke play',
  STABLEFORD: 'Stableford',
};

/** How the match ended other than by playing it out (the sheet's `termination` / `conceded`). */
export interface Ending {
  value: string;
  label: (sides: readonly [string, string]) => string;
}

/** The rows a family's sheet takes under its ruleset parameters. Layout only — never validation. */
export type SheetLayout =
  | {
      family: 'SETS_OF_GAMES';
      sets: number;
      tiebreaks: boolean;
      matchTiebreak: 7 | 10 | null;
      endings: readonly Ending[];
      note: string;
    }
  | {
      family: 'TIMED_PERIODS';
      periods: number;
      overtimes: number;
      endings: readonly Ending[];
      note: string;
    }
  | { family: 'TIMED_OR_TARGET'; target: number; endings: readonly Ending[]; note: string }
  | {
      family: 'MATCH_PLAY_HOLES';
      holes: number;
      extra: number;
      endings: readonly Ending[];
      note: string;
    };

const num = (v: unknown, d: number) => (Number.isSafeInteger(v) ? (v as number) : d);

const ending = (value: string, label: Ending['label']): Ending => ({ value, label });

/** The sheet's early endings per family (`termination` kinds, or match play's concession). */
export const ENDINGS: Record<EntryFamily, readonly Ending[]> = {
  SETS_OF_GAMES: [
    ending('RETIRED:0', ([a]) => `${a} retired`),
    ending('RETIRED:1', ([, b]) => `${b} retired`),
    ending('WALKOVER:0', ([a]) => `Walkover — ${a} didn’t play`),
    ending('WALKOVER:1', ([, b]) => `Walkover — ${b} didn’t play`),
  ],
  TIMED_PERIODS: [
    ending('FORFEIT:0', ([a]) => `Forfeit — ${a} didn’t play`),
    ending('FORFEIT:1', ([, b]) => `Forfeit — ${b} didn’t play`),
    ending('DEFAULT:0', ([a]) => `${a} defaulted during play`),
    ending('DEFAULT:1', ([, b]) => `${b} defaulted during play`),
  ],
  TIMED_OR_TARGET: [
    ending('FORFEIT:0', ([a]) => `Forfeit — ${a} didn’t play`),
    ending('FORFEIT:1', ([, b]) => `Forfeit — ${b} didn’t play`),
  ],
  MATCH_PLAY_HOLES: [
    ending('CONCEDED:0', ([a]) => `${a} conceded the match`),
    ending('CONCEDED:1', ([, b]) => `${b} conceded the match`),
  ],
};

/**
 * The most rows any ruleset of the family can take (ruleset parameter bounds: ≤ 3 sets to win,
 * ≤ 8 periods, 18 holes + extras). The server reads up to these, so it needs no ruleset to parse.
 */
const MAX_ROWS = { sets: 5, periods: 8, overtimes: 3, holes: 24 } as const;

export function sheetLayout(
  family: EntryFamily,
  parameters: Readonly<Record<string, unknown>>,
): SheetLayout {
  switch (family) {
    case 'SETS_OF_GAMES': {
      const s = num(parameters.setsToWin, 2);
      const fin = String(parameters.finalSet ?? 'FULL');
      const mtb = fin === 'MATCH_TIEBREAK_7' ? 7 : fin === 'MATCH_TIEBREAK_10' ? 10 : null;
      return {
        family,
        sets: mtb === null ? 2 * s - 1 : 2 * s - 2,
        tiebreaks: parameters.tiebreakAt !== undefined,
        matchTiebreak: mtb,
        endings: ENDINGS.SETS_OF_GAMES,
        note: `Best of ${2 * s - 1} sets of ${num(parameters.gamesPerSet, 6)} games${
          mtb === null ? '' : `, a ${mtb}-point match tie-break instead of the deciding set`
        }. Enter games per set; tie-break points only for a set that went to a tie-break.`,
      };
    }
    case 'TIMED_PERIODS':
      return {
        family,
        periods: num(parameters.periods, 4),
        overtimes: parameters.overtimeMinutes === undefined ? 0 : 3,
        endings: ENDINGS.TIMED_PERIODS,
        note: `${num(parameters.periods, 4)} periods of ${num(parameters.periodMinutes, 10)} minutes${
          parameters.overtimeMinutes === undefined ? '' : '; overtime only while level'
        }. Enter the points scored in each period.`,
      };
    case 'TIMED_OR_TARGET':
      return {
        family,
        target: num(parameters.targetScore, 21),
        endings: ENDINGS.TIMED_OR_TARGET,
        note: `${num(parameters.minutes, 10)} minutes or first to ${num(parameters.targetScore, 21)}. Enter the final score and how it ended; overtime only after a level timed finish.`,
      };
    case 'MATCH_PLAY_HOLES': {
      const holes = String(parameters.holes ?? '18') === '9' ? 9 : 18;
      return {
        family,
        holes,
        extra: parameters.extraHoles === 'SUDDEN_DEATH' ? 6 : 0,
        endings: ENDINGS.MATCH_PLAY_HOLES,
        note: `${holes} holes of match play${
          parameters.extraHoles === 'SUDDEN_DEATH' ? ', extra holes until decided' : ''
        }. Mark who won each hole played; leave the rest empty.`,
      };
    }
  }
}

export interface SheetIssue {
  /** JSON pointer into the sheet, as the API reports it. */
  path: string;
  code: string;
  message?: string;
}

type Pair = [number, number];
type Get = (name: string) => string;

/** Form field names, per sheet path (the inverse is `formValues`). */
export const F = {
  set: (i: number, s: 'a' | 'b') => `set${i}${s}`,
  tb: (i: number, s: 'a' | 'b') => `tb${i}${s}`,
  mtb: (s: 'a' | 'b') => `mtb${s}`,
  period: (i: number, s: 'a' | 'b') => `per${i}${s}`,
  ot: (i: number, s: 'a' | 'b') => `ot${i}${s}`,
  reg: (s: 'a' | 'b') => `reg${s}`,
  tot: (s: 'a' | 'b') => `tot${s}`,
  endedBy: 'endedBy',
  hole: (i: number) => `hole${i}`,
  ending: 'ending',
} as const;

/**
 * Reads one optional side-by-side pair: both empty = absent; one empty = incomplete; anything but
 * a small whole number = malformed. These are the only checks made here: whether a score is
 * possible is the ruleset's question, answered by the API.
 */
function pair(get: Get, a: string, b: string, path: string, issues: SheetIssue[]): Pair | null {
  const x = get(a).trim();
  const y = get(b).trim();
  if (x === '' && y === '') return null;
  if (x === '' || y === '') {
    issues.push({ path, code: 'INCOMPLETE' });
    return null;
  }
  if (!/^\d{1,3}$/.test(x) || !/^\d{1,3}$/.test(y)) {
    issues.push({ path, code: 'MALFORMED' });
    return null;
  }
  return [Number(x), Number(y)];
}

/** Rows filled in order; an empty row followed by a filled one is a gap the organizer must fix. */
function rows<T>(
  count: number,
  read: (i: number) => T | null,
  path: (i: number) => string,
  issues: SheetIssue[],
): T[] {
  const got = Array.from({ length: count }, (_, i) => read(i));
  const last = got.reduce((acc, v, i) => (v === null ? acc : i), -1);
  const out: T[] = [];
  for (let i = 0; i <= last; i++) {
    const v = got[i];
    if (v === null || v === undefined) issues.push({ path: path(i), code: 'GAP' });
    else out.push(v);
  }
  return out;
}

function endingOf(get: Get, family: EntryFamily, issues: SheetIssue[]) {
  const v = get(F.ending);
  if (v === '') return null;
  if (!ENDINGS[family].some((e) => e.value === v)) {
    issues.push({ path: '/termination', code: 'MALFORMED' });
    return null;
  }
  const [kind, side] = v.split(':') as [string, string];
  return { kind, side: side === '0' ? (0 as const) : (1 as const) };
}

/**
 * Form fields → the family's score sheet, or the obvious problems (missing / malformed / gaps).
 * Reads every row the family can have; rows the form didn't render are simply empty.
 */
export function sheetFromForm(
  family: EntryFamily,
  get: Get,
): { sheet: Record<string, unknown> } | { issues: SheetIssue[] } {
  const issues: SheetIssue[] = [];
  const end = endingOf(get, family, issues);
  let sheet: Record<string, unknown>;
  let scored: boolean;
  switch (family) {
    case 'SETS_OF_GAMES': {
      const sets = rows(
        MAX_ROWS.sets,
        (i) => {
          const games = pair(get, F.set(i, 'a'), F.set(i, 'b'), `/sets/${i}`, issues);
          const tb = pair(get, F.tb(i, 'a'), F.tb(i, 'b'), `/sets/${i}/tiebreak`, issues);
          if (games === null && tb !== null)
            issues.push({ path: `/sets/${i}`, code: 'INCOMPLETE' });
          return games === null ? null : { games, ...(tb === null ? {} : { tiebreak: tb }) };
        },
        (i) => `/sets/${i}`,
        issues,
      );
      const mtb = pair(get, F.mtb('a'), F.mtb('b'), '/matchTiebreak', issues);
      sheet = {
        family,
        sets,
        ...(mtb === null ? {} : { matchTiebreak: mtb }),
        ...(end === null ? {} : { termination: end }),
      };
      scored = sets.length > 0 || mtb !== null;
      break;
    }
    case 'TIMED_PERIODS': {
      const periods = rows(
        MAX_ROWS.periods,
        (i) => pair(get, F.period(i, 'a'), F.period(i, 'b'), `/periods/${i}`, issues),
        (i) => `/periods/${i}`,
        issues,
      );
      const overtimes = rows(
        MAX_ROWS.overtimes,
        (i) => pair(get, F.ot(i, 'a'), F.ot(i, 'b'), `/overtimes/${i}`, issues),
        (i) => `/overtimes/${i}`,
        issues,
      );
      sheet = {
        family,
        periods,
        ...(overtimes.length === 0 ? {} : { overtimes }),
        ...(end === null ? {} : { termination: end }),
      };
      scored = periods.length > 0 || overtimes.length > 0;
      break;
    }
    case 'TIMED_OR_TARGET': {
      const regulation = pair(get, F.reg('a'), F.reg('b'), '/regulation', issues);
      const overtime = pair(get, F.tot('a'), F.tot('b'), '/overtime', issues);
      const endedBy = get(F.endedBy);
      if (end === null && endedBy !== 'TARGET' && endedBy !== 'TIME')
        issues.push({ path: '/endedBy', code: 'MISSING' });
      sheet = {
        family,
        regulation: regulation ?? [0, 0],
        endedBy: endedBy === 'TIME' ? 'TIME' : 'TARGET',
        ...(overtime === null ? {} : { overtime }),
        ...(end === null ? {} : { termination: end }),
      };
      scored = regulation !== null;
      break;
    }
    case 'MATCH_PLAY_HOLES': {
      const holes = rows(
        MAX_ROWS.holes,
        (i) => {
          const v = get(F.hole(i));
          if (v === '') return null;
          if (v !== 'A' && v !== 'B' && v !== 'HALVED') {
            issues.push({ path: `/holes/${i}`, code: 'MALFORMED' });
            return null;
          }
          return v;
        },
        (i) => `/holes/${i}`,
        issues,
      );
      sheet = {
        family,
        holes,
        ...(end === null ? {} : { conceded: { side: end.side } }),
      };
      scored = holes.length > 0;
      break;
    }
  }
  // A match that ended early (walkover, retirement, concession…) may have no score; whether its
  // score fits that ending is the ruleset's question.
  if (!scored && end === null && issues.length === 0) issues.push({ path: '', code: 'MISSING' });
  return issues.length > 0 ? { issues } : { sheet };
}

/** "Set 2", "Period 3 of the score", "Hole 7": where a sheet issue is, in organizer words. */
export function issuePlace(path: string): string | null {
  const m = /^\/(sets|periods|overtimes|holes)\/(\d+)(\/tiebreak)?/.exec(path);
  if (m !== null) {
    const n = Number(m[2]) + 1;
    const what = { sets: 'Set', periods: 'Period', overtimes: 'Overtime', holes: 'Hole' }[
      m[1] as 'sets'
    ];
    return `${what} ${n}${m[3] === undefined ? '' : ' tie-break'}`;
  }
  const fixed: Record<string, string> = {
    '/sets': 'Sets',
    '/periods': 'Periods',
    '/overtimes': 'Overtime',
    '/holes': 'Holes',
    '/matchTiebreak': 'Match tie-break',
    '/regulation': 'Score',
    '/overtime': 'Overtime',
    '/endedBy': 'How it ended',
    '/termination': 'How it ended',
    '/conceded': 'Concession',
  };
  return fixed[path] ?? null;
}

const LOCAL_ISSUE: Record<string, string> = {
  INCOMPLETE: 'fill in both sides',
  MALFORMED: 'use whole numbers only',
  GAP: 'empty, but a later one is filled — fill it or clear the later ones',
  MISSING: 'enter the score, or how the match ended without one',
  CONTEST_NOT_READY: 'both sides of the match must be known first',
  SCORING_NOT_PINNED: 'the category has no scoring chosen',
};

/** One line per issue: where, then what. The API's own message where it gave one. */
export function issueText(i: SheetIssue): string {
  const where = issuePlace(i.path);
  const what = LOCAL_ISSUE[i.code] ?? i.message ?? i.code.toLowerCase().replace(/_/g, ' ');
  return where === null ? cap(what) : `${where}: ${what}`;
}

const cap = (s: string) => (s === '' ? s : s[0]?.toUpperCase() + s.slice(1));

// ───────────────────────────── reading stored content ─────────────────────────────

export interface ScoreLine {
  /** Index of the winning side in slot order, or null for a draw / no winner recorded. */
  winner: 0 | 1 | null;
  /** "6–1 6–2", "84–79", "3 up · 16 holes" (side A first). */
  score: string;
  /** "Walkover", "Retired", "Forfeit", "Conceded", "Overtime"… (null: played out). */
  how: string | null;
}

const OUTCOME_WIN = new Set(['WIN', 'WALKOVER_WIN']);

/**
 * Stored content → one score line, side A first. Reads the marks the ruleset executor wrote (metric
 * ids and ordinals of `@1` content) — formatting only; outcomes are the stored ones, never derived.
 */
export function scoreLine(
  family: string,
  content: ResultContent | undefined,
  sides: readonly string[],
): ScoreLine | null {
  if (content === undefined || sides.length !== 2) return null;
  const [a, b] = sides as [string, string];
  const entry = (id: string) => content.entries.find((e) => e.participantId === id);
  const ea = entry(a);
  const eb = entry(b);
  if (ea === undefined || eb === undefined) return null;
  const winner = OUTCOME_WIN.has(ea.outcome) ? 0 : OUTCOME_WIN.has(eb.outcome) ? 1 : null;
  const perf = (id: string, metric: string) =>
    new Map(
      (content.performances ?? [])
        .filter((p) => p.participantId === id && p.mark.metricId === metric)
        .map((p) => [p.ordinal, p.mark.value]),
    );
  const walkover = ea.outcome.startsWith('WALKOVER');
  switch (family) {
    case 'SETS_OF_GAMES': {
      if (walkover) return { winner, score: '—', how: 'Walkover' };
      const ga = perf(a, 'sog.set_games');
      const gb = perf(b, 'sog.set_games');
      const ta = perf(a, 'sog.tiebreak_points');
      const tb = perf(b, 'sog.tiebreak_points');
      const parts = [...ga.keys()]
        .sort((x, y) => x - y)
        .map((o) => {
          const t = ta.get(10 + o);
          const u = tb.get(10 + o);
          return `${ga.get(o)}–${gb.get(o) ?? '?'}${t !== undefined && u !== undefined ? ` (${t}–${u})` : ''}`;
        });
      const ma = perf(a, 'sog.match_tiebreak_points').get(20);
      const mb = perf(b, 'sog.match_tiebreak_points').get(20);
      if (ma !== undefined && mb !== undefined) parts.push(`[${ma}–${mb}]`);
      const retired = ea.outcome === 'RETIRED' || eb.outcome === 'RETIRED';
      return { winner, score: parts.join(' ') || '—', how: retired ? 'Retired' : null };
    }
    case 'TIMED_PERIODS': {
      if (walkover) return { winner, score: '—', how: 'Forfeit' };
      const pa = ea.primaryMark?.value ?? '?';
      const pb = eb.primaryMark?.value ?? '?';
      const ot = perf(a, 'tp.overtime_points').size > 0;
      const defaulted =
        perf(a, 'tp.defaulted').size > 0 || perf(b, 'tp.defaulted').size > 0 ? 'Default' : null;
      return {
        winner,
        score: `${pa}–${pb}`,
        how: defaulted ?? (ot ? 'Overtime' : winner === null ? 'Draw' : null),
      };
    }
    case 'TIMED_OR_TARGET': {
      if (walkover) return { winner, score: '—', how: 'Forfeit' };
      const ended = perf(a, 'tot.ended_by').get(3);
      const ot = perf(a, 'tot.overtime_points').size > 0;
      return {
        winner,
        score: `${ea.primaryMark?.value ?? '?'}–${eb.primaryMark?.value ?? '?'}`,
        how: ot ? 'Overtime' : ended === '1' ? 'Target reached' : ended === '2' ? 'Time' : null,
      };
    }
    case 'MATCH_PLAY_HOLES': {
      const holes = perf(a, 'mp.hole').size;
      const conceded = perf(a, 'mp.conceded').size > 0 || perf(b, 'mp.conceded').size > 0;
      const up = winner === null ? '0' : ((winner === 0 ? ea : eb).primaryMark?.value ?? '?');
      return {
        winner,
        score: winner === null ? 'All square' : `${up} up · ${holes} holes`,
        how: conceded ? 'Conceded' : winner === null ? 'Halved' : null,
      };
    }
    default:
      return null;
  }
}

/**
 * Stored content → the form's field values, so a correction starts from what is recorded. Inverse
 * of `sheetFromForm` over the same marks `scoreLine` reads; the organizer changes what was wrong.
 */
export function formValues(
  family: string,
  content: ResultContent | undefined,
  sides: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (content === undefined || sides.length !== 2) return out;
  const ids = sides as [string, string];
  const perf = (side: 0 | 1, metric: string) =>
    new Map(
      (content.performances ?? [])
        .filter((p) => p.participantId === ids[side] && p.mark.metricId === metric)
        .map((p) => [p.ordinal, p.mark.value]),
    );
  const outcome = (side: 0 | 1) =>
    content.entries.find((e) => e.participantId === ids[side])?.outcome ?? '';
  const sideOf = (pred: (o: string) => boolean) =>
    pred(outcome(0)) ? '0' : pred(outcome(1)) ? '1' : null;
  const both = (
    metric: string,
    at: (o: number) => [string, string] | null,
    map: Map<number, string>,
  ) =>
    [...map.keys()].forEach((o) => {
      const names = at(o);
      const other = perf(1, metric).get(o);
      if (names === null || other === undefined) return;
      out[names[0]] = map.get(o) as string;
      out[names[1]] = other;
    });
  const lost = sideOf((o) => o === 'WALKOVER_LOSS');
  switch (family) {
    case 'SETS_OF_GAMES': {
      both(
        'sog.set_games',
        (o) => [F.set(o - 1, 'a'), F.set(o - 1, 'b')],
        perf(0, 'sog.set_games'),
      );
      both(
        'sog.tiebreak_points',
        (o) => (o >= 11 && o < 20 ? [F.tb(o - 11, 'a'), F.tb(o - 11, 'b')] : null),
        perf(0, 'sog.tiebreak_points'),
      );
      both(
        'sog.match_tiebreak_points',
        () => [F.mtb('a'), F.mtb('b')],
        perf(0, 'sog.match_tiebreak_points'),
      );
      const retired = sideOf((o) => o === 'RETIRED');
      if (lost !== null) out[F.ending] = `WALKOVER:${lost}`;
      else if (retired !== null) out[F.ending] = `RETIRED:${retired}`;
      break;
    }
    case 'TIMED_PERIODS': {
      both(
        'tp.period_points',
        (o) => [F.period(o - 1, 'a'), F.period(o - 1, 'b')],
        perf(0, 'tp.period_points'),
      );
      both(
        'tp.overtime_points',
        (o) => [F.ot(o - 11, 'a'), F.ot(o - 11, 'b')],
        perf(0, 'tp.overtime_points'),
      );
      const defaulted =
        perf(0, 'tp.defaulted').size > 0 ? '0' : perf(1, 'tp.defaulted').size > 0 ? '1' : null;
      if (lost !== null) out[F.ending] = `FORFEIT:${lost}`;
      else if (defaulted !== null) out[F.ending] = `DEFAULT:${defaulted}`;
      break;
    }
    case 'TIMED_OR_TARGET': {
      both(
        'tot.regulation_points',
        () => [F.reg('a'), F.reg('b')],
        perf(0, 'tot.regulation_points'),
      );
      both('tot.overtime_points', () => [F.tot('a'), F.tot('b')], perf(0, 'tot.overtime_points'));
      const ended = perf(0, 'tot.ended_by').get(3);
      if (ended !== undefined) out[F.endedBy] = ended === '2' ? 'TIME' : 'TARGET';
      if (lost !== null) out[F.ending] = `FORFEIT:${lost}`;
      break;
    }
    case 'MATCH_PLAY_HOLES': {
      for (const [o, v] of perf(0, 'mp.hole'))
        out[F.hole(o - 1)] = v === '2' ? 'A' : v === '1' ? 'HALVED' : 'B';
      const conceded =
        perf(0, 'mp.conceded').size > 0 ? '0' : perf(1, 'mp.conceded').size > 0 ? '1' : null;
      if (conceded !== null) out[F.ending] = `CONCEDED:${conceded}`;
      break;
    }
  }
  return out;
}
