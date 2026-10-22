import type { ScoreSheet, ScoringIssue } from './types';

/**
 * Score-sheet structure — WP-P0-2 (D-15, D-18). A sheet arrives as untrusted JSON, so before any
 * family executor reads it: every container has its declared type, every enumeration one of its
 * declared values, and a termination (or a match play concession) names side 0 or side 1 —
 * nothing else, never coerced. Nothing missing or malformed is defaulted. The executors keep the
 * sporting rules (counts, bounds, who won); this gate only guarantees they read what they expect.
 */

type Obj = Readonly<Record<string, unknown>>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

class Shape {
  readonly issues: ScoringIssue[] = [];

  fail(path: string, code: string, message: string): void {
    this.issues.push({ path, code, message });
  }

  /** An array at `sheet[key]` (required or optional); with `objects`, every element is an object. */
  array(
    sheet: Obj,
    key: string,
    path: string,
    o: { required: boolean; objects?: boolean },
  ): readonly unknown[] | undefined {
    const v = sheet[key];
    if (v === undefined && !o.required) return undefined;
    if (!Array.isArray(v)) {
      this.fail(path, 'SHEET_MALFORMED', `${key} is ${o.required ? 'a required' : 'an'} array`);
      return undefined;
    }
    if (o.objects === true)
      v.forEach((x, i) => {
        if (!isObj(x)) this.fail(`${path}/${i}`, 'SHEET_MALFORMED', 'an entry is an object');
      });
    return v;
  }

  /** An optional termination `{ kind, side }` (or a concession `{ side }` when `kinds` is undefined). */
  termination(sheet: Obj, key: string, kinds: readonly string[] | undefined): void {
    const t = sheet[key];
    if (t === undefined) return;
    if (!isObj(t)) {
      this.fail(`/${key}`, 'TERMINATION_INVALID', `${key} is an object`);
      return;
    }
    if (kinds !== undefined && !kinds.includes(t['kind'] as string))
      this.fail(`/${key}/kind`, 'TERMINATION_INVALID', `the kind is one of ${kinds.join(', ')}`);
    if (t['side'] !== 0 && t['side'] !== 1)
      this.fail(`/${key}/side`, 'SIDE_INVALID', 'the side is 0 (first) or 1 (second)');
  }

  /** Field entries: an array of objects whose status is one of the family's. */
  entries(sheet: Obj, statuses?: readonly string[]): readonly Obj[] {
    const entries = this.array(sheet, 'entries', '/entries', { required: true, objects: true });
    return (entries ?? []).map((e, i) => {
      if (!isObj(e)) return {}; // already reported
      if (statuses !== undefined && !statuses.includes(e['status'] as string))
        this.fail(
          `/entries/${i}/status`,
          'SHEET_MALFORMED',
          `the status is one of ${statuses.join(', ')}`,
        );
      return e;
    });
  }
}

/** Structural issues of a sheet whose family already matches the pinned ruleset; [] when sound. */
export function sheetShapeIssues(sheet: ScoreSheet): readonly ScoringIssue[] {
  const s = new Shape();
  const o = sheet as unknown as Obj;
  switch (sheet.family) {
    case 'SETS_OF_GAMES':
      s.array(o, 'sets', '/sets', { required: true });
      s.termination(o, 'termination', ['RETIRED', 'WALKOVER']);
      break;
    case 'TIMED_PERIODS':
      s.array(o, 'periods', '/periods', { required: true });
      s.array(o, 'overtimes', '/overtimes', { required: false });
      s.termination(o, 'termination', ['FORFEIT', 'DEFAULT']);
      break;
    case 'TIMED_OR_TARGET':
      s.array(o, 'regulation', '/regulation', { required: true });
      if (o['endedBy'] !== 'TARGET' && o['endedBy'] !== 'TIME')
        s.fail('/endedBy', 'SHEET_MALFORMED', 'endedBy is TARGET or TIME');
      s.termination(o, 'termination', ['FORFEIT']);
      break;
    case 'ELAPSED_TIME':
    case 'FINISH_ORDER_WITH_TIME':
    case 'LAPS_AND_TIME':
      // Statuses are the executor's (STATUS_NOT_ALLOWED differs per timed family).
      s.entries(o).forEach((e, i) =>
        s.array(e, 'legs', `/entries/${i}/legs`, { required: false, objects: true }),
      );
      break;
    case 'FRAMES_PINFALL':
      s.entries(o, ['FINISHED', 'DNS', 'DQ']).forEach((e, i) =>
        s.array(e, 'members', `/entries/${i}/members`, { required: false, objects: true }),
      );
      break;
    case 'STROKES':
    case 'STABLEFORD': {
      const course = o['course'];
      if (course !== undefined) {
        if (!isObj(course)) s.fail('/course', 'SHEET_MALFORMED', 'course is an object');
        else s.array(course, 'holes', '/course/holes', { required: true, objects: true });
      }
      s.entries(o, ['FINISHED', 'DNF', 'DNS', 'DQ']).forEach((e, i) => {
        s.array(e, 'members', `/entries/${i}/members`, { required: false, objects: true });
        s.array(e, 'memberCourseHandicaps', `/entries/${i}/memberCourseHandicaps`, {
          required: false,
          objects: true,
        });
      });
      break;
    }
    case 'MATCH_PLAY_HOLES':
      s.array(o, 'holes', '/holes', { required: true });
      s.termination(o, 'conceded', undefined);
      break;
  }
  return s.issues;
}
