import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { RULESET_TEMPLATES, type RulesetSpec } from '../ruleset';
import {
  officialTime,
  pinfallHandicap,
  playingHandicap,
  readContestContent,
  scoreContest,
  strokesReceived,
  type ScoreSheet,
  type ScoringContext,
  type ScoringOutcome,
} from './index';

const R = (code: string): RulesetSpec => {
  const t = RULESET_TEMPLATES.find((x) => x.code === code);
  if (t === undefined) throw new Error(code);
  return t.spec;
};
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const ids = (k: number) =>
  Array.from({ length: k }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
const h2h = (ruleset: RulesetSpec): ScoringContext => ({
  ruleset,
  mode: 'HEAD_TO_HEAD',
  participants: [A, B],
});
const field = (
  ruleset: RulesetSpec,
  participants: readonly string[],
  extra: Partial<ScoringContext> = {},
): ScoringContext => ({
  ruleset,
  mode: 'FIELD',
  participants,
  ...extra,
});
const ok = (o: ScoringOutcome) => {
  if (!o.ok) throw new Error(JSON.stringify(o.issues));
  return o;
};
const codes = (o: ScoringOutcome) => (o.ok ? [] : o.issues.map((i) => i.code));
const entry = (o: ScoringOutcome, id: string) =>
  ok(o).result.entries.find((e) => e.participantId === id);

/** Every valid sheet must round-trip through stored content. */
function roundTrips(ctx: ScoringContext, sheet: ScoreSheet) {
  const scored = ok(scoreContest(ctx, sheet));
  const read = readContestContent(ctx, JSON.parse(JSON.stringify(scored.content)));
  expect(read.ok).toBe(true);
  return scored;
}

describe('SETS_OF_GAMES (tennis, padel)', () => {
  const ctx = h2h(R('sets-bo3-tiebreak'));
  it('a valid best of 3 with a tie-break set determines the winner and metrics', () => {
    const s = roundTrips(ctx, {
      family: 'SETS_OF_GAMES',
      sets: [{ games: [6, 4] }, { games: [6, 7], tiebreak: [5, 7] }, { games: [7, 5] }],
    });
    expect(entry(s, A)).toMatchObject({
      outcome: 'WIN',
      metrics: { setsWon: '2', setsLost: '1', gamesWon: '19', gamesLost: '16' },
    });
    expect(entry(s, B)?.outcome).toBe('LOSS');
  });
  it('rejects impossible sets, undecided matches and sets after the decision', () => {
    expect(
      codes(
        scoreContest(ctx, {
          family: 'SETS_OF_GAMES',
          sets: [{ games: [6, 5] }, { games: [6, 0] }],
        }),
      ),
    ).toContain('SET_SCORE_INVALID');
    expect(
      codes(scoreContest(ctx, { family: 'SETS_OF_GAMES', sets: [{ games: [6, 4] }] })),
    ).toContain('MATCH_NOT_DECIDED');
    expect(
      codes(
        scoreContest(ctx, {
          family: 'SETS_OF_GAMES',
          sets: [{ games: [6, 4] }, { games: [6, 4] }, { games: [6, 0] }],
        }),
      ),
    ).toContain('SET_AFTER_DECISION');
    expect(
      codes(
        scoreContest(ctx, {
          family: 'SETS_OF_GAMES',
          sets: [{ games: [7, 6], tiebreak: [7, 6] }, { games: [6, 0] }],
        }),
      ),
    ).toContain('SET_SCORE_INVALID');
    expect(
      codes(
        scoreContest(ctx, {
          family: 'SETS_OF_GAMES',
          sets: [{ games: [7, 6], tiebreak: [3, 7] }, { games: [6, 0] }],
        }),
      ),
    ).toContain('SET_SCORE_INVALID');
  });
  it('a match tie-break replaces the deciding set when the ruleset says so (padel super tie-break)', () => {
    const c = h2h(R('padel-bo3-golden-point-super-tiebreak'));
    const s = roundTrips(c, {
      family: 'SETS_OF_GAMES',
      sets: [{ games: [6, 3] }, { games: [4, 6] }],
      matchTiebreak: [10, 8],
    });
    expect(entry(s, A)).toMatchObject({
      outcome: 'WIN',
      decidedBy: 'MATCH_TIEBREAK',
      metrics: { setsWon: '2', gamesWon: '11' },
    });
    expect(
      codes(
        scoreContest(c, {
          family: 'SETS_OF_GAMES',
          sets: [{ games: [6, 3] }, { games: [4, 6] }, { games: [6, 2] }],
        }),
      ),
    ).toContain('MATCH_TIEBREAK_EXPECTED');
    expect(
      codes(
        scoreContest(c, {
          family: 'SETS_OF_GAMES',
          sets: [{ games: [6, 3] }, { games: [4, 6] }],
          matchTiebreak: [10, 9],
        }),
      ),
    ).toContain('MATCH_TIEBREAK_INVALID');
  });
  it('the deuce variant (star / golden point) is a ruleset parameter that does not change game counting', () => {
    const star = h2h(R('padel-bo3-star-point'));
    expect(
      ok(
        scoreContest(star, {
          family: 'SETS_OF_GAMES',
          sets: [{ games: [6, 1] }, { games: [6, 2] }],
        }),
      ).result.entries,
    ).toHaveLength(2);
    expect(star.ruleset.parameters['deuce']).toBe('STAR_POINT');
  });
  it('retirement and walkover are explicit terminations', () => {
    const r = roundTrips(ctx, {
      family: 'SETS_OF_GAMES',
      sets: [{ games: [6, 2] }, { games: [3, 1] }],
      termination: { kind: 'RETIRED', side: 1 },
    });
    expect(entry(r, B)).toMatchObject({ outcome: 'RETIRED', decidedBy: 'RETIREMENT' });
    const w = roundTrips(ctx, {
      family: 'SETS_OF_GAMES',
      sets: [],
      termination: { kind: 'WALKOVER', side: 0 },
    });
    expect(entry(w, B)?.outcome).toBe('WALKOVER_WIN');
  });
  it('tampered content never reads back', () => {
    const s = ok(
      scoreContest(ctx, { family: 'SETS_OF_GAMES', sets: [{ games: [6, 4] }, { games: [6, 4] }] }),
    );
    const bad = JSON.parse(JSON.stringify(s.content));
    bad.entries[0].primaryMark.value = '3';
    expect(codes(readContestContent(ctx, bad))).toEqual(['CONTENT_NOT_CANONICAL']);
    const flipped = JSON.parse(JSON.stringify(s.content));
    flipped.entries[0].outcome = flipped.entries[0].outcome === 'WIN' ? 'LOSS' : 'WIN';
    expect(readContestContent(ctx, flipped).ok).toBe(false);
  });
});

describe('TIMED_PERIODS / TIMED_OR_TARGET (basketball 5v5, wheelchair, 3x3)', () => {
  it('5v5: four periods, overtime only while level, forfeit 20–0, negative points refused', () => {
    const c = h2h(R('basketball-4x10'));
    const g = roundTrips(c, {
      family: 'TIMED_PERIODS',
      periods: [
        [20, 18],
        [15, 20],
        [22, 19],
        [18, 18],
      ],
      overtimes: [[10, 8]],
    });
    expect(entry(g, A)).toMatchObject({
      outcome: 'WIN',
      decidedBy: 'OVERTIME',
      metrics: { pointsFor: '85', pointsAgainst: '83' },
    });
    expect(
      codes(
        scoreContest(c, {
          family: 'TIMED_PERIODS',
          periods: [
            [20, 18],
            [15, 20],
            [22, 19],
            [18, 18],
          ],
        }),
      ),
    ).toContain('NOT_DECIDED');
    expect(
      codes(
        scoreContest(c, {
          family: 'TIMED_PERIODS',
          periods: [
            [20, -1],
            [15, 20],
            [22, 19],
            [18, 18],
          ],
        }),
      ),
    ).toContain('POINTS_INVALID');
    const f = roundTrips(c, {
      family: 'TIMED_PERIODS',
      periods: [],
      termination: { kind: 'FORFEIT', side: 1 },
    });
    expect(entry(f, A)).toMatchObject({ outcome: 'WALKOVER_WIN', metrics: { pointsFor: '20' } });
  });
  it('wheelchair basketball uses the same TIMED_PERIODS family — no sport branch exists', () => {
    const c = h2h(R('wheelchair-basketball-4x10'));
    const g = roundTrips(c, {
      family: 'TIMED_PERIODS',
      periods: [
        [10, 8],
        [12, 9],
        [8, 14],
        [11, 9],
      ],
    });
    expect(entry(g, A)).toMatchObject({ outcome: 'WIN', metrics: { pointsFor: '41' } });
  });
  it('3x3: first to 21 or the time limit; overtime to +2', () => {
    const c = h2h(R('3x3-10min-21'));
    expect(
      entry(
        roundTrips(c, { family: 'TIMED_OR_TARGET', regulation: [21, 15], endedBy: 'TARGET' }),
        A,
      )?.outcome,
    ).toBe('WIN');
    expect(
      entry(roundTrips(c, { family: 'TIMED_OR_TARGET', regulation: [17, 18], endedBy: 'TIME' }), B)
        ?.outcome,
    ).toBe('WIN');
    const ot = roundTrips(c, {
      family: 'TIMED_OR_TARGET',
      regulation: [15, 15],
      endedBy: 'TIME',
      overtime: [2, 0],
    });
    expect(entry(ot, A)).toMatchObject({
      outcome: 'WIN',
      decidedBy: 'OVERTIME',
      metrics: { pointsFor: '17' },
    });
    expect(
      codes(
        scoreContest(c, { family: 'TIMED_OR_TARGET', regulation: [25, 15], endedBy: 'TARGET' }),
      ),
    ).toContain('TARGET_SCORE_INVALID');
    expect(
      codes(scoreContest(c, { family: 'TIMED_OR_TARGET', regulation: [21, 15], endedBy: 'TIME' })),
    ).toContain('TIME_SCORE_INVALID');
    expect(
      codes(scoreContest(c, { family: 'TIMED_OR_TARGET', regulation: [15, 15], endedBy: 'TIME' })),
    ).toContain('OVERTIME_REQUIRED');
  });
});

describe('timed families (running, swimming, cycling)', () => {
  it('road race: gun time rounded up to the second; statuses own their time rules', () => {
    const p = ids(4);
    const c = field(R('road-gun-time'), p);
    const s = roundTrips(c, {
      family: 'ELAPSED_TIME',
      entries: [
        {
          participantId: p[0] as string,
          status: 'FINISHED',
          timeMs: 3_601_001,
          netTimeMs: 3_590_000,
        },
        { participantId: p[1] as string, status: 'DNF' },
        { participantId: p[2] as string, status: 'DQ' },
        { participantId: p[3] as string, status: 'DNS' },
      ],
    });
    expect(entry(s, p[0] as string)?.metrics).toMatchObject({
      elapsedTimeMs: '3602000',
      rawTimeMs: '3601001',
    });
    expect(entry(s, p[1] as string)?.outcome).toBe('DNF');
    expect(
      codes(
        scoreContest(c, {
          family: 'ELAPSED_TIME',
          entries: p.map((id) => ({ participantId: id, status: 'DNS' as const, timeMs: 5 })),
        }),
      ),
    ).toContain('TIME_FORBIDDEN');
    expect(
      codes(
        scoreContest(c, {
          family: 'ELAPSED_TIME',
          entries: p.map((id) => ({ participantId: id, status: 'FINISHED' as const, timeMs: -1 })),
        }),
      ),
    ).toContain('TIME_REQUIRED');
    expect(
      codes(
        scoreContest(c, {
          family: 'ELAPSED_TIME',
          entries: p.slice(1).map((id) => ({ participantId: id, status: 'DNS' as const })),
        }),
      ),
    ).toContain('PARTICIPANTS_MISMATCH');
    expect(
      codes(
        scoreContest(c, {
          family: 'ELAPSED_TIME',
          entries: p.map((id) => ({ participantId: id, status: 'PULLED' as const })),
        }),
      ),
    ).toContain('STATUS_NOT_ALLOWED');
  });
  it('rounding follows the ruleset (UP / DOWN / TRUNCATE) — never the sport', () => {
    expect(officialTime(60_001, 1000, 'UP')).toBe(61_000);
    expect(officialTime(60_999, 1000, 'DOWN')).toBe(60_000);
    expect(officialTime(60_999, 10, 'TRUNCATE')).toBe(60_990);
    expect(officialTime(61_000, 1000, 'UP')).toBe(61_000);
  });
  it('cycling mass start: finish order agrees with time; beyond the limit is NOT_PLACED', () => {
    const p = ids(3);
    const c = field(R('cycling-road-same-time'), p);
    const s = roundTrips(c, {
      family: 'FINISH_ORDER_WITH_TIME',
      entries: [
        {
          participantId: p[0] as string,
          status: 'FINISHED',
          timeMs: 10_000_000,
          finishPosition: 1,
        },
        {
          participantId: p[1] as string,
          status: 'FINISHED',
          timeMs: 10_000_000,
          finishPosition: 2,
        },
        { participantId: p[2] as string, status: 'NOT_PLACED', timeMs: 11_000_000 },
      ],
    });
    expect(entry(s, p[2] as string)?.outcome).toBe('NOT_PLACED');
    expect(
      codes(
        scoreContest(c, {
          family: 'FINISH_ORDER_WITH_TIME',
          entries: [
            {
              participantId: p[0] as string,
              status: 'FINISHED',
              timeMs: 10_000_000,
              finishPosition: 2,
            },
            {
              participantId: p[1] as string,
              status: 'FINISHED',
              timeMs: 10_500_000,
              finishPosition: 1,
            },
            {
              participantId: p[2] as string,
              status: 'FINISHED',
              timeMs: 11_000_000,
              finishPosition: 3,
            },
          ],
        }),
      ),
    ).toEqual(expect.arrayContaining(['ORDER_TIME_INCONSISTENT', 'NOT_PLACED_EXPECTED']));
  });
  it('MTB: pulled riders carry laps down and pull order, never a time', () => {
    const p = ids(2);
    const c = field(R('mtb-laps'), p);
    const s = roundTrips(c, {
      family: 'LAPS_AND_TIME',
      entries: [
        { participantId: p[0] as string, status: 'FINISHED', timeMs: 5_400_000, lapsCompleted: 6 },
        {
          participantId: p[1] as string,
          status: 'PULLED',
          lapsCompleted: 4,
          lapsDown: 2,
          pullOrder: 1,
        },
      ],
    });
    expect(entry(s, p[1] as string)).toMatchObject({
      outcome: 'PULLED',
      metrics: { lapsDown: '2', pullOrder: '1' },
    });
  });
  it('relay: legs name rostered athletes; SUM_OF_LEGS derives the team time', () => {
    const team = ids(1)[0] as string;
    const roster = ids(5).slice(1);
    const sum: RulesetSpec = {
      family: 'ELAPSED_TIME',
      parameters: { ...R('relay-team-finish').parameters, teamTime: 'SUM_OF_LEGS' },
    };
    const c = field(sum, [team], { rosters: { [team]: roster } });
    const legs = roster.map((athleteId, i) => ({ athleteId, timeMs: 12_000 + i }));
    const s = roundTrips(c, {
      family: 'ELAPSED_TIME',
      entries: [{ participantId: team, status: 'FINISHED', legs }],
    });
    expect(entry(s, team)?.metrics['rawTimeMs']).toBe('48006');
    expect(
      codes(
        scoreContest(c, {
          family: 'ELAPSED_TIME',
          entries: [{ participantId: team, status: 'FINISHED', timeMs: 48_000 }],
        }),
      ),
    ).toContain('LEGS_REQUIRED');
  });
});

describe('FRAMES_PINFALL (bowling)', () => {
  it('scratch totals, 0–300 bounds, games count', () => {
    const p = ids(2);
    const c = field(R('bowling-6-games-scratch'), p);
    const s = roundTrips(c, {
      family: 'FRAMES_PINFALL',
      entries: [
        {
          participantId: p[0] as string,
          status: 'FINISHED',
          games: [200, 210, 190, 300, 180, 220],
        },
        { participantId: p[1] as string, status: 'DNS' },
      ],
    });
    expect(entry(s, p[0] as string)?.metrics).toMatchObject({ pins: '1300', highGame: '300' });
    expect(
      codes(
        scoreContest(c, {
          family: 'FRAMES_PINFALL',
          entries: [
            { participantId: p[0] as string, status: 'FINISHED', games: [301, 1, 1, 1, 1, 1] },
            { participantId: p[1] as string, status: 'DNS' },
          ],
        }),
      ),
    ).toContain('GAMES_INVALID');
  });
  it('handicap comes from the declared average named by the ruleset; missing averages refuse', () => {
    expect(pinfallHandicap(180, 220, 90)).toBe(36);
    expect(pinfallHandicap(230, 220, 90)).toBe(0);
    const p = ids(1);
    const c = field(R('bowling-handicap-90-220'), p, {
      attributes: { [p[0] as string]: { average: '180' } },
    });
    const s = roundTrips(c, {
      family: 'FRAMES_PINFALL',
      entries: [{ participantId: p[0] as string, status: 'FINISHED', games: [200, 190, 210] }],
    });
    expect(entry(s, p[0] as string)?.metrics).toMatchObject({
      pins: '600',
      pinsHandicap: '708',
      handicapPerGame: '36',
    });
    const none = field(R('bowling-handicap-90-220'), p);
    expect(
      codes(
        scoreContest(none, {
          family: 'FRAMES_PINFALL',
          entries: [{ participantId: p[0] as string, status: 'FINISHED', games: [200, 190, 210] }],
        }),
      ),
    ).toContain('HANDICAP_INPUT_MISSING');
  });
  it('team: members’ games sum per game (non-Baker); Baker records one team score per game', () => {
    const team = ids(1)[0] as string;
    const roster = ids(4).slice(1);
    const sumRules: RulesetSpec = {
      family: 'FRAMES_PINFALL',
      parameters: { gamesPerBlock: 2, baker: false },
    };
    const s = roundTrips(field(sumRules, [team], { rosters: { [team]: roster } }), {
      family: 'FRAMES_PINFALL',
      entries: [
        {
          participantId: team,
          status: 'FINISHED',
          members: roster.map((athleteId, i) => ({ athleteId, games: [150 + i, 160] })),
        },
      ],
    });
    expect(entry(s, team)?.series['games']).toEqual([453, 480]);
    const baker = roundTrips(
      field(R('bowling-team-baker-5'), [team], { rosters: { [team]: roster } }),
      {
        family: 'FRAMES_PINFALL',
        entries: [{ participantId: team, status: 'FINISHED', games: [200, 210, 220, 230, 240] }],
      },
    );
    expect(entry(baker, team)?.metrics['pins']).toBe('1100');
  });
});

describe('STROKES / STABLEFORD / MATCH_PLAY_HOLES (golf)', () => {
  const course = {
    holes: Array.from({ length: 18 }, (_, i) => ({
      par: i % 3 === 0 ? 3 : i % 3 === 1 ? 4 : 5,
      strokeIndex: i + 1,
    })),
  };
  const parTotal = course.holes.reduce((t, h) => t + h.par, 0);
  it('handicap arithmetic: WHS rounding and strokes per hole by stroke index', () => {
    expect(playingHandicap(13, 95)).toBe(12); // 12.35
    expect(playingHandicap(15, 95)).toBe(14); // 14.25
    expect(playingHandicap(11, 95)).toBe(10); // 10.45
    expect(playingHandicap(-2, 95)).toBe(-2);
    expect([1, 5, 6, 18].map((si) => strokesReceived(5, si, 18))).toEqual([1, 1, 0, 0]);
    expect([1, 18].map((si) => strokesReceived(20, si, 18))).toEqual([2, 1]);
    expect([1, 18].map((si) => strokesReceived(-1, si, 18))).toEqual([0, -1]);
  });
  it('gross stroke play: lower total; invalid hole scores refused', () => {
    const p = ids(2);
    const c = field(R('golf-stroke-gross'), p);
    const holes = course.holes.map((h) => h.par);
    const s = roundTrips(c, {
      family: 'STROKES',
      entries: [
        { participantId: p[0] as string, status: 'FINISHED', holes },
        { participantId: p[1] as string, status: 'DQ' },
      ],
    });
    expect(entry(s, p[0] as string)?.metrics['strokes']).toBe(String(parTotal));
    expect(
      codes(
        scoreContest(c, {
          family: 'STROKES',
          entries: [
            { participantId: p[0] as string, status: 'FINISHED', holes: holes.map(() => 0) },
            { participantId: p[1] as string, status: 'DQ' },
          ],
        }),
      ),
    ).toContain('HOLES_INVALID');
  });
  it('net stroke play subtracts the playing handicap; Stableford awards 2 + par + received − strokes', () => {
    const p = ids(1);
    const holes = course.holes.map((h) => h.par + 1); // bogey golf
    const net = roundTrips(field(R('golf-stroke-net-95'), p), {
      family: 'STROKES',
      course,
      entries: [{ participantId: p[0] as string, status: 'FINISHED', holes, courseHandicap: 18 }],
    });
    expect(entry(net, p[0] as string)?.metrics).toMatchObject({
      strokes: String(parTotal + 18 - 17),
      strokesGross: String(parTotal + 18),
    });
    const stb = roundTrips(field(R('golf-stableford-95'), p), {
      family: 'STABLEFORD',
      course,
      entries: [{ participantId: p[0] as string, status: 'FINISHED', holes, courseHandicap: 18 }],
    });
    expect(entry(stb, p[0] as string)?.metrics['stablefordPoints']).toBe(String(17 * 2 + 1));
    expect(
      codes(
        scoreContest(field(R('golf-stableford-95'), p), {
          family: 'STABLEFORD',
          entries: [
            { participantId: p[0] as string, status: 'FINISHED', holes, courseHandicap: 18 },
          ],
        }),
      ),
    ).toContain('COURSE_REQUIRED');
  });
  it('four-ball takes the best net member score per hole; scramble derives a team handicap', () => {
    const team = ids(1)[0] as string;
    const roster = ids(5).slice(1);
    const pair = roster.slice(0, 2);
    const fb = roundTrips(field(R('golf-fourball-net-85'), [team], { rosters: { [team]: pair } }), {
      family: 'STROKES',
      course,
      entries: [
        {
          participantId: team,
          status: 'FINISHED',
          members: [
            { athleteId: pair[0] as string, holes: course.holes.map((h) => h.par) },
            {
              athleteId: pair[1] as string,
              holes: course.holes.map((h, i) => (i === 0 ? h.par - 1 : 0)),
            },
          ],
          memberCourseHandicaps: [
            { athleteId: pair[0] as string, courseHandicap: 0 },
            { athleteId: pair[1] as string, courseHandicap: 0 },
          ],
        },
      ],
    });
    expect(entry(fb, team)?.metrics['strokes']).toBe(String(parTotal - 1));
    const scramble = roundTrips(
      field(R('golf-scramble-4-net'), [team], { rosters: { [team]: roster } }),
      {
        family: 'STROKES',
        course,
        entries: [
          {
            participantId: team,
            status: 'FINISHED',
            holes: course.holes.map((h) => h.par - 1),
            memberCourseHandicaps: roster.map((athleteId, i) => ({
              athleteId,
              courseHandicap: [4, 12, 20, 28][i] as number,
            })),
          },
        ],
      },
    );
    // 4·25 + 12·20 + 20·15 + 28·10 = 920 → 9.2 → 9
    expect(entry(scramble, team)?.metrics['strokes']).toBe(String(parTotal - 18 - 9));
  });
  it('match play: decided when the lead exceeds the holes left; extra holes when level', () => {
    const c = h2h(R('golf-match-play-100'));
    const won = roundTrips(c, {
      family: 'MATCH_PLAY_HOLES',
      holes: [
        ...Array.from({ length: 6 }, () => 'A' as const),
        ...Array.from({ length: 7 }, () => 'HALVED' as const),
      ],
    });
    expect(entry(won, A)).toMatchObject({ outcome: 'WIN', metrics: { holesUp: '6' } });
    expect(
      codes(
        scoreContest(c, {
          family: 'MATCH_PLAY_HOLES',
          holes: ['A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'B'],
        }),
      ),
    ).toContain('HOLE_AFTER_DECISION');
    const extra = roundTrips(c, {
      family: 'MATCH_PLAY_HOLES',
      holes: [...Array.from({ length: 18 }, () => 'HALVED' as const), 'B'],
    });
    expect(entry(extra, B)).toMatchObject({ outcome: 'WIN', decidedBy: 'EXTRA_HOLES' });
  });
});

describe('ruleset execution invariants (property)', () => {
  it('valid timed fields round-trip and lower official time never loses information', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 20_000_000 }), { minLength: 1, maxLength: 30 }),
        (times) => {
          const p = ids(times.length);
          const c = field(R('swim-hundredths'), p);
          const s = scoreContest(c, {
            family: 'ELAPSED_TIME',
            entries: p.map((participantId, i) => ({
              participantId,
              status: 'FINISHED' as const,
              timeMs: times[i] as number,
            })),
          });
          if (!s.ok) return false;
          const back = readContestContent(c, JSON.parse(JSON.stringify(s.content)));
          return (
            back.ok &&
            s.result.entries.every(
              (e) => Number(e.metrics['elapsedTimeMs']) <= Number(e.metrics['rawTimeMs']),
            )
          );
        },
      ),
    );
  });
  it('any game outside 0–300 never scores', () => {
    fc.assert(
      fc.property(fc.integer({ min: 301, max: 10_000 }), (bad) => {
        const p = ids(1);
        return !scoreContest(field(R('bowling-6-games-scratch'), p), {
          family: 'FRAMES_PINFALL',
          entries: [
            { participantId: p[0] as string, status: 'FINISHED', games: [bad, 1, 1, 1, 1, 1] },
          ],
        }).ok;
      }),
    );
  });
  it('a sheet of another family is refused by the pinned ruleset', () => {
    expect(
      codes(scoreContest(h2h(R('sets-bo3-tiebreak')), { family: 'TIMED_PERIODS', periods: [] })),
    ).toEqual(['FAMILY_MISMATCH']);
  });
});

describe('v1 backward compatibility (ONCF-05C must not reinterpret v1)', () => {
  it('v1 disciplines provide no ruleset family, so no ruleset can be pinned to a v1 event', async () => {
    const { providedCapabilities, TENNIS_SINGLES_V1, PADEL_DOUBLES_V1 } = await import('../index');
    expect(providedCapabilities(TENNIS_SINGLES_V1).rulesetFamilies).toEqual([]);
    expect(providedCapabilities(PADEL_DOUBLES_V1).rulesetFamilies).toEqual([]);
  });
  it('legacy aggregate content (BRT-03 shape) is never silently read as a v2 score', () => {
    const legacy = {
      entries: [
        {
          participantId: A,
          outcome: 'WIN',
          primaryMark: { metricId: 'tennis.match.sets', value: '2', unit: 'sets', precision: 0 },
        },
        {
          participantId: B,
          outcome: 'LOSS',
          primaryMark: { metricId: 'tennis.match.sets', value: '0', unit: 'sets', precision: 0 },
        },
      ],
    } as never;
    expect(readContestContent(h2h(R('sets-bo3-tiebreak')), legacy).ok).toBe(false);
  });
});
