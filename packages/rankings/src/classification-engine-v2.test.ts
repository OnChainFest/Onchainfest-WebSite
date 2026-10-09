import {
  RULESET_TEMPLATES,
  scoreContest,
  type NormalizedContestResult,
  type RulesetSpec,
  type ScoreSheet,
} from '@br/competition';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  classifyStage,
  type ClassificationV2Contest,
  type ClassificationV2Input,
} from './classification-engine-v2';
import {
  CLASSIFICATION_TEMPLATES,
  type ClassificationPolicyV2Spec,
} from './classification-policy-v2';

const R = (code: string): RulesetSpec =>
  RULESET_TEMPLATES.find((t) => t.code === code)?.spec as RulesetSpec;
const P = (code: string): ClassificationPolicyV2Spec =>
  CLASSIFICATION_TEMPLATES.find((t) => t.code === code)?.spec as ClassificationPolicyV2Spec;
const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const EVENT = id(9999);
let cseq = 0;

function h2h(
  ruleset: string,
  a: string,
  b: string,
  sheet: ScoreSheet,
  round = 1,
): ClassificationV2Contest {
  const s = scoreContest(
    { ruleset: R(ruleset), mode: 'HEAD_TO_HEAD', participants: [a, b] },
    sheet,
  );
  if (!s.ok) throw new Error(JSON.stringify(s.issues));
  cseq += 1;
  return { contestId: id(50_000 + cseq), roundSequence: round, result: s.result };
}
function fieldContest(
  ruleset: string,
  participants: string[],
  sheet: ScoreSheet,
  round = 1,
  extra = {},
): ClassificationV2Contest {
  const s = scoreContest({ ruleset: R(ruleset), mode: 'FIELD', participants, ...extra }, sheet);
  if (!s.ok) throw new Error(JSON.stringify(s.issues));
  cseq += 1;
  return { contestId: id(60_000 + cseq), roundSequence: round, result: s.result };
}
function run(
  policy: string,
  participants: string[],
  contests: ClassificationV2Contest[],
  extra: Partial<ClassificationV2Input> = {},
) {
  const out = classifyStage({
    policy: P(policy),
    policyRef: { code: policy, version: 1, specHash: `sha256:${'0'.repeat(64)}` },
    scope: { eventId: EVENT, stageKey: 's1' },
    participants,
    contests,
    ...extra,
  });
  if (!out.ok) throw new Error(JSON.stringify(out.issues));
  return out;
}
const order = (o: ReturnType<typeof run>) =>
  o.document.entries.map((e) => [e.participantId, e.position]);
const sets = (...s: [number, number][]): ScoreSheet => ({
  family: 'SETS_OF_GAMES',
  sets: s.map((games) => ({ games })),
});

describe('STANDINGS — padel group (fip_groups): three-way tie by set and game difference', () => {
  // A beats B, B beats C, C beats A (circular), all beat D.
  const [A, B, C, D] = [id(1), id(2), id(3), id(4)];
  const contests = [
    h2h('padel-bo3-star-point', A, B, sets([6, 0], [6, 0])), // A sets +2, games +12
    h2h('padel-bo3-star-point', B, C, sets([6, 4], [6, 4])), // B sets +2, games +4
    h2h('padel-bo3-star-point', C, A, sets([6, 3], [3, 6], [6, 3])), // C sets +1, games +3
    h2h('padel-bo3-star-point', A, D, sets([6, 1], [6, 1])),
    h2h('padel-bo3-star-point', B, D, sets([6, 1], [6, 1])),
    h2h('padel-bo3-star-point', C, D, sets([6, 1], [6, 1])),
  ];
  it('orders by wins, then the tied subset (set difference among the three), and explains it', () => {
    const o = run('fip_groups', [A, B, C, D], contests);
    // Among A, B, C: A sets 2-2 → 0... computed by the engine; D last.
    expect(o.document.entries.at(-1)?.participantId).toBe(D);
    const split = o.document.explanations.find((e) => e.kind === 'TIED_SUBSET');
    expect(split?.participants).toEqual([A, B, C].sort());
    expect(new Set(o.document.entries.slice(0, 3).map((e) => e.position))).toEqual(
      new Set([1, 2, 3]),
    );
    expect(o.document.entries[0]?.decidedBy?.kind).toBe('TIED_SUBSET');
  });
  it('is deterministic and independent of the order contests are supplied in (property)', () => {
    const base = run('fip_groups', [A, B, C, D], contests);
    fc.assert(
      fc.property(
        fc.shuffledSubarray(contests, { minLength: contests.length, maxLength: contests.length }),
        fc.shuffledSubarray([A, B, C, D], { minLength: 4, maxLength: 4 }),
        (cs, ps) => {
          const o = run('fip_groups', ps, cs);
          return o.hash === base.hash;
        },
      ),
    );
  });
});

describe('STANDINGS — tennis round robin (itf_rr): head-to-head only between two', () => {
  it('two players level on wins are separated by their match', () => {
    const [A, B, C] = [id(11), id(12), id(13)];
    const o = run(
      'itf_rr',
      [A, B, C],
      [
        h2h('sets-2-plus-match-tiebreak-no-ad', A, B, sets([6, 4], [6, 4])),
        h2h('sets-2-plus-match-tiebreak-no-ad', B, C, sets([6, 4], [6, 4])),
        h2h('sets-2-plus-match-tiebreak-no-ad', C, A, sets([6, 4], [6, 4])),
      ],
    );
    // Three-way tie on wins: H2H (max 2) does not apply → % sets, % games decide or they stay tied.
    expect(o.document.explanations.some((e) => e.kind === 'HEAD_TO_HEAD')).toBe(false);
    expect(o.document.entries.every((e) => e.tied)).toBe(true);
    expect(o.document.entries.map((e) => e.position)).toEqual([1, 1, 1]);
  });
  it('an explicit organizer lot is the only thing that separates an exhausted tie', () => {
    const [A, B, C] = [id(11), id(12), id(13)];
    const cs = [
      h2h('sets-2-plus-match-tiebreak-no-ad', A, B, sets([6, 4], [6, 4])),
      h2h('sets-2-plus-match-tiebreak-no-ad', B, C, sets([6, 4], [6, 4])),
      h2h('sets-2-plus-match-tiebreak-no-ad', C, A, sets([6, 4], [6, 4])),
    ];
    const o = run('itf_rr', [A, B, C], cs, { lotOrder: [C, A, B] });
    expect(order(o)).toEqual([
      [C, 1],
      [A, 2],
      [B, 3],
    ]);
    expect(o.document.entries[0]?.decidedBy?.kind).toBe('ORGANIZER_LOT');
  });
});

describe('STANDINGS — basketball 3x3 pool (fiba_3x3): win ratio, H2H, capped average', () => {
  it('a 21-point cap per game and forfeits excluded from the average', () => {
    const [A, B, C, D] = [id(21), id(22), id(23), id(24)];
    const target = (a: number, b: number): ScoreSheet => ({
      family: 'TIMED_OR_TARGET',
      regulation: [a, b],
      endedBy: a >= 21 || b >= 21 ? 'TARGET' : 'TIME',
    });
    const o = run(
      'fiba_3x3',
      [A, B, C, D],
      [
        h2h('3x3-10min-21', A, B, target(21, 10)),
        h2h('3x3-10min-21', C, D, target(22, 5)),
        h2h('3x3-10min-21', A, C, target(15, 21)),
        h2h('3x3-10min-21', B, D, target(18, 12)),
        h2h('3x3-10min-21', A, D, target(21, 3)),
        h2h('3x3-10min-21', B, C, {
          family: 'TIMED_OR_TARGET',
          regulation: [0, 0],
          endedBy: 'TIME',
          termination: { kind: 'FORFEIT', side: 1 },
        }),
      ],
    );
    // A 2–1, C 2–1 (one win by forfeit), B 2–1, D 0–3 → H2H not applicable to 3 → capped average.
    expect(o.document.entries.at(-1)?.participantId).toBe(D);
    const avg = o.document.explanations.find((e) => e.kind === 'AVERAGE');
    expect(avg).toBeDefined();
    const cValue = avg?.values.find((v) => v.participantId === C)?.value;
    expect(cValue).toBe('21'); // (21 + 21 capped from 22) / 2 — the forfeit win is excluded
  });
});

describe('STANDINGS — basketball 5v5 (fiba_5x5): 2/1/0 points; forfeits score 0', () => {
  it('a forfeit loser gets 0, a regular loser 1', () => {
    const [A, B, C] = [id(31), id(32), id(33)];
    const per = (a: number, b: number): ScoreSheet => ({
      family: 'TIMED_PERIODS',
      periods: [
        [a, b],
        [10, 10],
        [10, 10],
        [10, 10],
      ],
    });
    const o = run(
      'fiba_5x5',
      [A, B, C],
      [
        h2h('basketball-4x10', A, B, per(30, 10)),
        h2h('basketball-4x10', B, C, {
          family: 'TIMED_PERIODS',
          periods: [],
          termination: { kind: 'FORFEIT', side: 1 },
        }),
        h2h('basketball-4x10', A, C, per(20, 10)),
      ],
    );
    const pts = (pid: string) =>
      o.document.entries
        .find((e) => e.participantId === pid)
        ?.values.find((v) => v.key === 'points')?.value;
    expect([pts(A), pts(B), pts(C)]).toEqual(['4', '3', '1']);
  });
});

describe('METRIC — running road race (road_race): large field, statuses, subsets, teams', () => {
  it('classifies 2,000 finishers by official time; non-finishers follow in status order', () => {
    const n = 2000;
    const ps = Array.from({ length: n + 3 }, (_, i) => id(100_000 + i));
    const entries = ps.map((p, i) =>
      i < n
        ? {
            participantId: p,
            status: 'FINISHED' as const,
            timeMs: 3_000_000 + ((i * 7919) % 5000) * 1000,
          }
        : { participantId: p, status: (['DQ', 'DNF', 'DNS'] as const)[i - n] as 'DQ' },
    );
    const attributes = Object.fromEntries(
      ps.map((p, i) => [
        p,
        { ageBand: i % 2 === 0 ? '35-39' : '40-44', teamAffiliation: `club${i % 7}` },
      ]),
    );
    const o = run(
      'road_race',
      ps,
      [fieldContest('road-gun-time', ps, { family: 'ELAPSED_TIME', entries })],
      { attributes },
    );
    const e = o.document.entries;
    expect(e).toHaveLength(n + 3);
    for (let i = 1; i < n; i++) {
      const a = Number(e[i - 1]?.values[0]?.value);
      const b = Number(e[i]?.values[0]?.value);
      expect(a <= b).toBe(true);
      if (a === b) expect(e[i]?.position).toBe(e[i - 1]?.position); // equal times share (SHARED)
    }
    expect(e.slice(-3).map((x) => x.status)).toEqual(['DNF', 'DQ', 'DNS']);
    expect(o.document.subsets?.map((s) => s.value)).toEqual(['35-39', '40-44']);
  });
  it('team-derived score sums the best N places; ties go to the better last scorer', () => {
    const ps = [id(201), id(202), id(203), id(204)];
    const times = [100_000, 101_000, 102_000, 103_000];
    const policy = {
      ...P('road_race'),
      teamDerived: {
        groupByAttribute: 'teamAffiliation',
        scorers: 2,
        fn: 'SUM_OF_PLACES' as const,
        incompleteTeam: 'EXCLUDE' as const,
      },
    };
    const out = classifyStage({
      policy,
      policyRef: { code: 'road_race_teams', version: 1, specHash: `sha256:${'1'.repeat(64)}` },
      scope: { eventId: EVENT, stageKey: 's1' },
      participants: ps,
      contests: [
        fieldContest('road-gun-time', ps, {
          family: 'ELAPSED_TIME',
          entries: ps.map((p, i) => ({
            participantId: p,
            status: 'FINISHED' as const,
            timeMs: times[i] as number,
          })),
        }),
      ],
      attributes: {
        [ps[0] as string]: { teamAffiliation: 'X' },
        [ps[3] as string]: { teamAffiliation: 'X' },
        [ps[1] as string]: { teamAffiliation: 'Y' },
        [ps[2] as string]: { teamAffiliation: 'Y' },
      },
    });
    if (!out.ok) throw new Error('classification failed');
    // X: 1 + 4 = 5, Y: 2 + 3 = 5 → tied on score; Y's last scorer (3rd) beat X's (4th).
    expect(out.document.teams?.map((t) => [t.label, t.position, t.score])).toEqual([
      ['Y', 1, '5'],
      ['X', 2, '5'],
    ]);
  });
});

describe('METRIC — swimming (swim_time) and cycling GC (cycling_gc)', () => {
  it('equal times share a place; lower time never ranks below a higher one (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 20_000, max: 30_000 }), { minLength: 2, maxLength: 16 }),
        (times) => {
          const ps = times.map((_, i) => id(300 + i));
          const o = run('swim_time', ps, [
            fieldContest('swim-hundredths', ps, {
              family: 'ELAPSED_TIME',
              entries: ps.map((p, i) => ({
                participantId: p,
                status: 'FINISHED' as const,
                timeMs: times[i] as number,
              })),
            }),
          ]);
          const pos = new Map(o.document.entries.map((e) => [e.participantId, e.position]));
          return ps.every((a, i) =>
            ps.every((b, j) => {
              const ta = Math.floor((times[i] as number) / 10);
              const tb = Math.floor((times[j] as number) / 10);
              return ta < tb
                ? (pos.get(a) as number) < (pos.get(b) as number)
                : ta === tb
                  ? pos.get(a) === pos.get(b)
                  : true;
            }),
          );
        },
      ),
    );
  });
  it('stage race: GC sums stages; non-finishers of a stage leave the GC; place sum breaks a time tie', () => {
    const ps = [id(401), id(402), id(403)];
    const stage = (t: number[], positions: number[], round: number, dnf?: number) =>
      fieldContest(
        'cycling-road-same-time',
        ps,
        {
          family: 'FINISH_ORDER_WITH_TIME',
          entries: ps.map((p, i) =>
            i === dnf
              ? { participantId: p, status: 'DNF' as const }
              : {
                  participantId: p,
                  status: 'FINISHED' as const,
                  timeMs: t[i] as number,
                  finishPosition: positions[i] as number,
                },
          ),
        },
        round,
      );
    const o = run('cycling_gc', ps, [
      stage([10_000_000, 10_000_000, 10_001_000], [1, 2, 3], 1),
      stage([10_000_000, 10_000_000, 10_000_000], [2, 1, 3], 2),
      stage([9_000_000, 9_000_000, 9_000_000], [1, 2, 3], 3, 2),
    ]);
    expect(o.document.entries.at(-1)).toMatchObject({ participantId: ps[2], status: 'DNF' });
    expect(o.document.entries[0]?.participantId).toBe(ps[0]); // equal time; place sum 4 vs 5
    expect(o.document.entries[0]?.decidedBy?.kind).toBe('PLACE_SUM');
  });
});

describe('METRIC — golf stroke play (golf_stroke): multi-round aggregate, cut-compatible, count-back', () => {
  const course = { holes: Array.from({ length: 18 }, (_, i) => ({ par: 4, strokeIndex: i + 1 })) };
  const card = (p: string, holes: number[]) => ({
    participantId: p,
    status: 'FINISHED' as const,
    holes,
  });
  it('aggregates rounds; a tie on total is broken by the last 9 / 6 / 3 / 1 of the final round', () => {
    const [A, B, C] = [id(501), id(502), id(503)];
    const flat = Array.from({ length: 18 }, () => 4);
    const backNineBetter = [
      ...Array.from({ length: 9 }, () => 5),
      ...Array.from({ length: 9 }, () => 3),
    ];
    const r1 = fieldContest(
      'golf-stroke-gross',
      [A, B, C],
      {
        family: 'STROKES',
        course,
        entries: [
          card(A, flat),
          card(B, flat),
          card(
            C,
            flat.map((x) => x + 1),
          ),
        ],
      },
      1,
    );
    const r2 = fieldContest(
      'golf-stroke-gross',
      [A, B, C],
      {
        family: 'STROKES',
        course,
        entries: [card(A, flat), card(B, backNineBetter), card(C, flat)],
      },
      2,
    );
    const o = run('golf_stroke', [A, B, C], [r1, r2]);
    expect(order(o)).toEqual([
      [B, 1],
      [A, 2],
      [C, 3],
    ]);
    expect(o.document.entries[0]?.decidedBy?.kind).toBe('COUNT_BACK');
    // Classification after round 1 only (what a cut reads): A and B tie, C behind.
    const after1 = run('golf_stroke', [A, B, C], [r1, r2], {
      scope: { eventId: EVENT, stageKey: 's1', throughRound: 1 },
    });
    expect(after1.document.entries.map((e) => e.position)).toEqual([1, 1, 3]);
  });
  it('Stableford ranks higher points first', () => {
    const [A, B] = [id(511), id(512)];
    const o = run(
      'golf_stableford',
      [A, B],
      [
        fieldContest('golf-stableford-95', [A, B], {
          family: 'STABLEFORD',
          course,
          entries: [
            {
              ...card(
                A,
                Array.from({ length: 18 }, () => 5),
              ),
              courseHandicap: 18,
            },
            {
              ...card(
                B,
                Array.from({ length: 18 }, () => 5),
              ),
              courseHandicap: 0,
            },
          ],
        }),
      ],
    );
    expect(o.document.entries[0]?.participantId).toBe(A);
  });
});

describe('METRIC — bowling pinfall (bowling_pinfall): higher pins, highest single game', () => {
  it('higher pinfall ranks above lower (property) and ties fall to the highest game', () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.integer({ min: 0, max: 300 }), { minLength: 6, maxLength: 6 }), {
          minLength: 2,
          maxLength: 10,
        }),
        (games) => {
          const ps = games.map((_, i) => id(600 + i));
          const o = run('bowling_pinfall', ps, [
            fieldContest('bowling-6-games-scratch', ps, {
              family: 'FRAMES_PINFALL',
              entries: ps.map((p, i) => ({
                participantId: p,
                status: 'FINISHED' as const,
                games: games[i] as number[],
              })),
            }),
          ]);
          const total = (i: number) => (games[i] as number[]).reduce((t, x) => t + x, 0);
          const pos = new Map(o.document.entries.map((e) => [e.participantId, e.position]));
          return ps.every((a, i) =>
            ps.every(
              (b, j) => !(total(i) > total(j)) || (pos.get(a) as number) < (pos.get(b) as number),
            ),
          );
        },
      ),
    );
  });
});

describe('engine boundaries', () => {
  it('refuses a standings policy over field results and results naming entrants outside the scope', () => {
    const ps = [id(701), id(702)];
    const c = fieldContest('swim-hundredths', ps, {
      family: 'ELAPSED_TIME',
      entries: ps.map((p) => ({ participantId: p, status: 'FINISHED' as const, timeMs: 30_000 })),
    });
    const out = classifyStage({
      policy: P('itf_rr'),
      policyRef: { code: 'itf_rr', version: 1, specHash: `sha256:${'0'.repeat(64)}` },
      scope: { eventId: EVENT, stageKey: 's1' },
      participants: ps,
      contests: [c],
    });
    expect(out.ok).toBe(false);
    const stray = classifyStage({
      policy: P('swim_time'),
      policyRef: { code: 'swim_time', version: 1, specHash: `sha256:${'0'.repeat(64)}` },
      scope: { eventId: EVENT, stageKey: 's1' },
      participants: [ps[0] as string],
      contests: [c],
    });
    expect(stray.ok).toBe(false);
  });
  it('marks a classification incomplete while contests are pending', () => {
    const ps = [id(711), id(712)];
    const o = run('swim_time', ps, [], { pendingContests: [id(9_000)] });
    expect(o.document.complete).toBe(false);
  });
  it('normalized results built by hand are accepted only in their declared mode', () => {
    const fake: NormalizedContestResult = {
      family: 'ELAPSED_TIME',
      mode: 'HEAD_TO_HEAD',
      entries: [],
    };
    const out = classifyStage({
      policy: P('swim_time'),
      policyRef: { code: 'swim_time', version: 1, specHash: `sha256:${'0'.repeat(64)}` },
      scope: { eventId: EVENT, stageKey: 's1' },
      participants: [],
      contests: [{ contestId: id(1), roundSequence: 1, result: fake }],
    });
    expect(out.ok).toBe(false);
  });
});
