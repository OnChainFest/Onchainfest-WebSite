import { describe, expect, it } from 'vitest';
import { RULESET_TEMPLATES, type RulesetSpec } from '../ruleset';
import {
  readContestContent,
  scoreContest,
  type ScoreSheet,
  type ScoringContext,
  type ScoringOutcome,
} from './index';

// WP-P0-2 (D-15, D-18): a score sheet is untrusted JSON. A termination names one of the two sides
// (0 or 1, nothing else), a malformed structure is refused with coded issues (never an exception,
// never a silent default), and whatever the executor accepts reads back from stored content.

const R = (code: string): RulesetSpec => {
  const t = RULESET_TEMPLATES.find((x) => x.code === code);
  if (t === undefined) throw new Error(code);
  return t.spec;
};
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const P = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
const h2h = (code: string): ScoringContext => ({
  ruleset: R(code),
  mode: 'HEAD_TO_HEAD',
  participants: [A, B],
});
const field = (code: string, extra: Partial<ScoringContext> = {}): ScoringContext => ({
  ruleset: R(code),
  mode: 'FIELD',
  participants: P,
  ...extra,
});
const ok = (o: ScoringOutcome) => {
  if (!o.ok) throw new Error(JSON.stringify(o.issues));
  return o;
};
const issues = (o: ScoringOutcome) => (o.ok ? [] : o.issues.map((i) => `${i.path} ${i.code}`));
const outcomeOf = (o: ScoringOutcome, id: string) =>
  ok(o).result.entries.find((e) => e.participantId === id)?.outcome;
/** Untyped input: the API hands the executor whatever JSON object the client sent. */
const score = (ctx: ScoringContext, sheet: unknown) => scoreContest(ctx, sheet as ScoreSheet);

const tennis = h2h('sets-bo3-tiebreak');
const basketball = h2h('basketball-4x10');
const threeByThree = h2h('3x3-10min-21');
const matchPlay = h2h('golf-match-play-100');

/** Side values that do not name one of the two sides (JSON-representable ones first). */
const BAD_SIDES: unknown[] = [2, -1, 0.5, '1', '0', null, true, [], {}, NaN, Infinity, -0.5];

describe('WP-P0-2 (D-15) · a termination names side 0 or side 1, nothing else', () => {
  const terminations: [string, ScoringContext, (side: unknown) => unknown, string][] = [
    [
      'tennis walkover',
      tennis,
      (side) => ({ family: 'SETS_OF_GAMES', sets: [], termination: { kind: 'WALKOVER', side } }),
      '/termination/side',
    ],
    [
      'tennis retirement',
      tennis,
      (side) => ({
        family: 'SETS_OF_GAMES',
        sets: [{ games: [6, 2] }, { games: [3, 1] }],
        termination: { kind: 'RETIRED', side },
      }),
      '/termination/side',
    ],
    [
      'basketball forfeit',
      basketball,
      (side) => ({ family: 'TIMED_PERIODS', periods: [], termination: { kind: 'FORFEIT', side } }),
      '/termination/side',
    ],
    [
      'basketball default',
      basketball,
      (side) => ({
        family: 'TIMED_PERIODS',
        periods: [
          [20, 10],
          [10, 10],
        ],
        termination: { kind: 'DEFAULT', side },
      }),
      '/termination/side',
    ],
    [
      '3x3 forfeit',
      threeByThree,
      (side) => ({
        family: 'TIMED_OR_TARGET',
        regulation: [0, 0],
        endedBy: 'TIME',
        termination: { kind: 'FORFEIT', side },
      }),
      '/termination/side',
    ],
    [
      'match play concession',
      matchPlay,
      (side) => ({ family: 'MATCH_PLAY_HOLES', holes: ['A', 'B'], conceded: { side } }),
      '/conceded/side',
    ],
  ];

  for (const [name, ctx, sheet, path] of terminations)
    it(`${name}: side ∉ {0, 1} (or missing) is refused at ${path}`, () => {
      for (const side of BAD_SIDES) {
        let out: ScoringOutcome | undefined;
        expect(() => (out = score(ctx, sheet(side))), `side ${String(side)}`).not.toThrow();
        expect(issues(out as ScoringOutcome), `side ${String(side)}`).toContain(
          `${path} SIDE_INVALID`,
        );
      }
      const missing = sheet(0) as { termination?: object; conceded?: object };
      const { side: _drop, ...noSide } = (missing.termination ?? missing.conceded) as {
        side: unknown;
      };
      const withoutSide =
        missing.termination === undefined
          ? { ...missing, conceded: noSide }
          : { ...missing, termination: noSide };
      expect(issues(score(ctx, withoutSide))).toContain(`${path} SIDE_INVALID`);
    });

  it('the QA-03 SCOR-028 sheet (walkover naming side 2) never reaches "both sides lost"', () => {
    const out = score(tennis, {
      family: 'SETS_OF_GAMES',
      sets: [],
      termination: { kind: 'WALKOVER', side: 2 },
    });
    expect(out.ok).toBe(false);
    expect(issues(out)).toEqual(['/termination/side SIDE_INVALID']);
  });

  it('an unknown termination kind is refused, never ignored', () => {
    const decided = [{ games: [6, 1] }, { games: [6, 2] }];
    for (const [ctx, sheet, path] of [
      [
        tennis,
        { family: 'SETS_OF_GAMES', sets: decided, termination: { kind: 'FORFEIT', side: 1 } },
        '/termination/kind',
      ],
      [
        tennis,
        { family: 'SETS_OF_GAMES', sets: decided, termination: { kind: 'DQ', side: 1 } },
        '/termination/kind',
      ],
      [
        basketball,
        {
          family: 'TIMED_PERIODS',
          periods: [
            [20, 10],
            [10, 10],
            [10, 10],
            [10, 10],
          ],
          termination: { kind: 'WALKOVER', side: 1 },
        },
        '/termination/kind',
      ],
      [
        threeByThree,
        {
          family: 'TIMED_OR_TARGET',
          regulation: [21, 10],
          endedBy: 'TARGET',
          termination: { kind: 'DEFAULT', side: 1 },
        },
        '/termination/kind',
      ],
      [tennis, { family: 'SETS_OF_GAMES', sets: decided, termination: null }, '/termination'],
      [tennis, { family: 'SETS_OF_GAMES', sets: decided, termination: 'WALKOVER' }, '/termination'],
      [tennis, { family: 'SETS_OF_GAMES', sets: decided, termination: [] }, '/termination'],
      [matchPlay, { family: 'MATCH_PLAY_HOLES', holes: ['A'], conceded: null }, '/conceded'],
    ] as const) {
      let out: ScoringOutcome | undefined;
      expect(() => (out = score(ctx, sheet)), JSON.stringify(sheet)).not.toThrow();
      expect(out?.ok, JSON.stringify(sheet)).toBe(false);
      expect(
        (out as ScoringOutcome & { ok: false }).issues.map((i) => i.path),
        JSON.stringify(sheet),
      ).toContain(path);
    }
  });

  it('valid walkovers in both directions name the other side the winner and read back', () => {
    for (const side of [0, 1] as const) {
      const out = ok(
        score(tennis, {
          family: 'SETS_OF_GAMES',
          sets: [],
          termination: { kind: 'WALKOVER', side },
        }),
      );
      const [loser, winner] = side === 0 ? [A, B] : [B, A];
      expect(outcomeOf(out, winner)).toBe('WALKOVER_WIN');
      expect(outcomeOf(out, loser)).toBe('WALKOVER_LOSS');
      expect(readContestContent(tennis, JSON.parse(JSON.stringify(out.content))).ok).toBe(true);
    }
  });

  it('valid retirements, forfeits, defaults and concessions in both directions are unchanged', () => {
    for (const side of [0, 1] as const) {
      const other = side === 0 ? B : A;
      const mine = side === 0 ? A : B;
      const retired = ok(
        score(tennis, {
          family: 'SETS_OF_GAMES',
          sets: [{ games: [6, 2] }, { games: [3, 1] }],
          termination: { kind: 'RETIRED', side },
        }),
      );
      expect([outcomeOf(retired, mine), outcomeOf(retired, other)]).toEqual(['RETIRED', 'WIN']);
      const forfeit = ok(
        score(basketball, {
          family: 'TIMED_PERIODS',
          periods: [],
          termination: { kind: 'FORFEIT', side },
        }),
      );
      expect([outcomeOf(forfeit, mine), outcomeOf(forfeit, other)]).toEqual([
        'WALKOVER_LOSS',
        'WALKOVER_WIN',
      ]);
      const defaulted = ok(
        score(basketball, {
          family: 'TIMED_PERIODS',
          periods: [
            [20, 10],
            [10, 10],
          ],
          termination: { kind: 'DEFAULT', side },
        }),
      );
      expect([outcomeOf(defaulted, mine), outcomeOf(defaulted, other)]).toEqual(['LOSS', 'WIN']);
      const tot = ok(
        score(threeByThree, {
          family: 'TIMED_OR_TARGET',
          regulation: [0, 0],
          endedBy: 'TIME',
          termination: { kind: 'FORFEIT', side },
        }),
      );
      expect(outcomeOf(tot, other)).toBe('WALKOVER_WIN');
      const conceded = ok(
        score(matchPlay, { family: 'MATCH_PLAY_HOLES', holes: ['A', 'B'], conceded: { side } }),
      );
      expect([outcomeOf(conceded, mine), outcomeOf(conceded, other)]).toEqual(['LOSS', 'WIN']);
      for (const [ctx, out] of [
        [tennis, retired],
        [basketball, forfeit],
        [basketball, defaulted],
        [threeByThree, tot],
        [matchPlay, conceded],
      ] as const)
        expect(readContestContent(ctx, JSON.parse(JSON.stringify(out.content))).ok).toBe(true);
    }
  });

  it('valid tennis scores are unchanged: straight sets, a tie-break set, a deciding set', () => {
    const straight = ok(
      score(tennis, { family: 'SETS_OF_GAMES', sets: [{ games: [6, 4] }, { games: [6, 3] }] }),
    );
    expect(outcomeOf(straight, A)).toBe('WIN');
    const tb = ok(
      score(tennis, {
        family: 'SETS_OF_GAMES',
        sets: [
          { games: [7, 6], tiebreak: [7, 5] },
          { games: [4, 6] },
          { games: [6, 7], tiebreak: [8, 10] },
        ],
      }),
    );
    expect(outcomeOf(tb, B)).toBe('WIN');
    const superTb = ok(
      score(h2h('padel-bo3-golden-point-super-tiebreak'), {
        family: 'SETS_OF_GAMES',
        sets: [{ games: [6, 3] }, { games: [4, 6] }],
        matchTiebreak: [10, 8],
      }),
    );
    expect(outcomeOf(superTb, A)).toBe('WIN');
  });
});

describe('WP-P0-2 (D-18) · a malformed structure is a coded refusal, never an exception', () => {
  const tennisOk = { family: 'SETS_OF_GAMES', sets: [{ games: [6, 4] }, { games: [6, 3] }] };
  const periodsOk = {
    family: 'TIMED_PERIODS',
    periods: [
      [20, 10],
      [10, 10],
      [10, 10],
      [10, 10],
    ],
  };
  const totOk = { family: 'TIMED_OR_TARGET', regulation: [21, 10], endedBy: 'TARGET' };
  const roadOk = {
    family: 'ELAPSED_TIME',
    entries: [
      { participantId: P[0], status: 'FINISHED', timeMs: 3_600_000 },
      { participantId: P[1], status: 'DNF' },
    ],
  };
  const bowlingOk = {
    family: 'FRAMES_PINFALL',
    entries: [
      { participantId: P[0], status: 'FINISHED', games: [200, 210, 190, 300, 180, 220] },
      { participantId: P[1], status: 'DNS' },
    ],
  };
  const course = {
    holes: Array.from({ length: 18 }, (_, i) => ({ par: 4, strokeIndex: i + 1 })),
  };
  const golfOk = {
    family: 'STROKES',
    course,
    entries: [
      { participantId: P[0], status: 'FINISHED', holes: course.holes.map(() => 4) },
      { participantId: P[1], status: 'DQ' },
    ],
  };
  const matchPlayOk = { family: 'MATCH_PLAY_HOLES', holes: Array.from({ length: 10 }, () => 'A') };
  const road = field('road-gun-time');
  const bowling = field('bowling-6-games-scratch');
  const golf = field('golf-stroke-gross');

  /** [context, valid sheet, malformed variant, the issue path that must be reported]. */
  const cases: [string, ScoringContext, unknown, string][] = [
    ['sets as an object', tennis, { ...tennisOk, sets: { 0: { games: [6, 4] } } }, '/sets'],
    ['sets as a string', tennis, { ...tennisOk, sets: '6-4 6-3' }, '/sets'],
    ['sets as a number', tennis, { ...tennisOk, sets: 2 }, '/sets'],
    ['sets null', tennis, { ...tennisOk, sets: null }, '/sets'],
    ['sets missing', tennis, { family: 'SETS_OF_GAMES' }, '/sets'],
    ['periods as an object', basketball, { ...periodsOk, periods: { a: [1, 2] } }, '/periods'],
    ['periods missing', basketball, { family: 'TIMED_PERIODS' }, '/periods'],
    ['overtimes as an object', basketball, { ...periodsOk, overtimes: {} }, '/overtimes'],
    ['regulation null', threeByThree, { ...totOk, regulation: null }, '/regulation'],
    [
      'regulation null on a forfeit',
      threeByThree,
      { ...totOk, regulation: null, termination: { kind: 'FORFEIT', side: 0 } },
      '/regulation',
    ],
    ['endedBy unknown', threeByThree, { ...totOk, endedBy: 'BUZZER' }, '/endedBy'],
    [
      'endedBy missing',
      threeByThree,
      { family: 'TIMED_OR_TARGET', regulation: [21, 10] },
      '/endedBy',
    ],
    ['entries as an object', road, { ...roadOk, entries: { 0: roadOk.entries[0] } }, '/entries'],
    ['entries missing', road, { family: 'ELAPSED_TIME' }, '/entries'],
    ['an entry is null', road, { ...roadOk, entries: [null, roadOk.entries[1]] }, '/entries/0'],
    [
      'legs as an object',
      road,
      { ...roadOk, entries: [{ ...roadOk.entries[0], legs: {} }, roadOk.entries[1]] },
      '/entries/0/legs',
    ],
    [
      'a leg is null',
      road,
      { ...roadOk, entries: [{ ...roadOk.entries[0], legs: [null] }, roadOk.entries[1]] },
      '/entries/0/legs/0',
    ],
    ['a bowling entry is null', bowling, { ...bowlingOk, entries: [null, null] }, '/entries/0'],
    [
      'a bowling status outside the family',
      bowling,
      { ...bowlingOk, entries: [bowlingOk.entries[0], { participantId: P[1], status: 'RETIRED' }] },
      '/entries/1/status',
    ],
    [
      'bowling members as an object',
      bowling,
      {
        ...bowlingOk,
        entries: [{ participantId: P[0], status: 'FINISHED', members: {} }, bowlingOk.entries[1]],
      },
      '/entries/0/members',
    ],
    ['course as a number', golf, { ...golfOk, course: 5 }, '/course'],
    ['course holes as an object', golf, { ...golfOk, course: { holes: {} } }, '/course/holes'],
    ['a course hole is null', golf, { ...golfOk, course: { holes: [null] } }, '/course/holes/0'],
    [
      'a golf status outside the family',
      golf,
      { ...golfOk, entries: [golfOk.entries[0], { participantId: P[1], status: 'PULLED' }] },
      '/entries/1/status',
    ],
    [
      'golf members with a null member',
      golf,
      {
        ...golfOk,
        entries: [{ participantId: P[0], status: 'FINISHED', members: [null] }, golfOk.entries[1]],
      },
      '/entries/0/members/0',
    ],
    [
      'golf member handicaps as an object',
      golf,
      {
        ...golfOk,
        entries: [{ ...golfOk.entries[0], memberCourseHandicaps: {} }, golfOk.entries[1]],
      },
      '/entries/0/memberCourseHandicaps',
    ],
    ['match play holes as an object', matchPlay, { ...matchPlayOk, holes: {} }, '/holes'],
    ['match play holes missing', matchPlay, { family: 'MATCH_PLAY_HOLES' }, '/holes'],
  ];

  it('the valid base sheets score', () => {
    for (const [ctx, sheet] of [
      [tennis, tennisOk],
      [basketball, periodsOk],
      [threeByThree, totOk],
      [road, roadOk],
      [bowling, bowlingOk],
      [golf, golfOk],
      [matchPlay, matchPlayOk],
    ] as const)
      expect(score(ctx, sheet).ok, JSON.stringify(sheet).slice(0, 60)).toBe(true);
  });

  for (const [name, ctx, sheet, path] of cases)
    it(`${name} → SHEET_MALFORMED at ${path}`, () => {
      let out: ScoringOutcome | undefined;
      expect(() => (out = score(ctx, sheet))).not.toThrow();
      expect(out?.ok).toBe(false);
      expect(issues(out as ScoringOutcome)).toContain(`${path} SHEET_MALFORMED`);
    });

  it('malformed set entries and numbers are refused as set scores (unchanged)', () => {
    for (const set of [
      null,
      5,
      'x',
      {},
      { games: {} },
      { games: [6] },
      { games: ['6', '4'] },
      { games: [6.5, 4] },
      { games: [-1, 4] },
      { games: [NaN, 4] },
      { games: [Infinity, 4] },
      { games: [6, 4], tiebreak: 'x' },
    ]) {
      let out: ScoringOutcome | undefined;
      expect(
        () => (out = score(tennis, { family: 'SETS_OF_GAMES', sets: [set, { games: [6, 3] }] })),
      ).not.toThrow();
      expect(issues(out as ScoringOutcome), JSON.stringify(set)).toContain(
        '/sets/0 SET_SCORE_INVALID',
      );
    }
  });

  it('no value in any field of any family throws: every sheet is scored or refused', () => {
    const garbage: unknown[] = [
      null,
      0,
      -1,
      2,
      0.5,
      NaN,
      'x',
      true,
      {},
      [],
      [null],
      [{}],
      { 0: 1 },
    ];
    const bases: [ScoringContext, Record<string, unknown>][] = [
      [tennis, { ...tennisOk, matchTiebreak: [10, 8], termination: { kind: 'RETIRED', side: 0 } }],
      [
        basketball,
        { ...periodsOk, overtimes: [[2, 1]], termination: { kind: 'DEFAULT', side: 0 } },
      ],
      [threeByThree, { ...totOk, overtime: [2, 0], termination: { kind: 'FORFEIT', side: 0 } }],
      [road, roadOk],
      [
        field('relay-team-finish', { rosters: { [P[0] as string]: [A], [P[1] as string]: [B] } }),
        {
          ...roadOk,
          entries: [
            { ...roadOk.entries[0], legs: [{ athleteId: A, timeMs: 1 }] },
            roadOk.entries[1],
          ],
        },
      ],
      [bowling, bowlingOk],
      [
        field('bowling-team-baker-5', { rosters: { [P[0] as string]: [A] } }),
        {
          ...bowlingOk,
          entries: [
            { participantId: P[0], status: 'FINISHED', members: [{ athleteId: A, games: [1] }] },
            bowlingOk.entries[1],
          ],
        },
      ],
      [golf, golfOk],
      [
        field('golf-fourball-net-85', { rosters: { [P[0] as string]: [A] } }),
        {
          ...golfOk,
          entries: [
            {
              participantId: P[0],
              status: 'FINISHED',
              members: [{ athleteId: A, holes: course.holes.map(() => 4) }],
              memberCourseHandicaps: [{ athleteId: A, courseHandicap: 3 }],
            },
            golfOk.entries[1],
          ],
        },
      ],
      [matchPlay, { ...matchPlayOk, conceded: { side: 0 } }],
    ];
    /** Every path into the sheet (objects and arrays), so each container can be replaced. */
    const paths = (v: unknown, at: (string | number)[] = []): (string | number)[][] => {
      if (typeof v !== 'object' || v === null) return [];
      const keys = Array.isArray(v)
        ? v.map((_, i) => i)
        : Object.keys(v).filter((k) => k !== 'family');
      return keys.flatMap((k) => [
        [...at, k],
        ...paths((v as Record<string, unknown>)[k], [...at, k]),
      ]);
    };
    const replace = (v: unknown, path: (string | number)[], value: unknown): unknown => {
      if (path.length === 0) return value;
      const [head, ...rest] = path as [string | number, ...(string | number)[]];
      const copy = (Array.isArray(v) ? [...v] : { ...(v as object) }) as Record<string, unknown>;
      copy[head] = replace(copy[head], rest, value);
      return copy;
    };
    let tried = 0;
    for (const [ctx, base] of bases)
      for (const path of paths(base))
        for (const value of garbage) {
          const sheet = replace(base, path, value);
          tried += 1;
          let out: ScoringOutcome | undefined;
          expect(
            () => (out = score(ctx, sheet)),
            `${path.join('/')} = ${JSON.stringify(value)}`,
          ).not.toThrow();
          // Whatever is accepted is a real result: it reads back from its own stored content,
          // and a head-to-head names a winner among the two sides, or a draw.
          if (out?.ok === true) {
            expect(readContestContent(ctx, JSON.parse(JSON.stringify(out.content))).ok).toBe(true);
            if (ctx.mode === 'HEAD_TO_HEAD') {
              const outcomes = out.result.entries.map((e) => e.outcome).sort();
              expect(
                [
                  ['DRAW', 'DRAW'],
                  ['LOSS', 'WIN'],
                  ['RETIRED', 'WIN'],
                  ['WALKOVER_LOSS', 'WALKOVER_WIN'],
                ].map((x) => x.join()),
                `${path.join('/')} = ${JSON.stringify(value)}`,
              ).toContain(outcomes.join());
            }
          }
        }
    expect(tried).toBeGreaterThan(1000);
  });
});
