import {
  contestDecision,
  RULESET_TEMPLATES,
  scoreContest,
  type NormalizedContestResult,
  type RulesetSpec,
  type ScoreSheet,
} from '@br/competition';
import type { ResultOutcome } from '@br/domain';
import { describe, expect, it } from 'vitest';
import { classifyStage, type ClassificationV2Contest } from './classification-engine-v2';
import {
  CLASSIFICATION_TEMPLATES,
  type ClassificationPolicyV2Spec,
} from './classification-policy-v2';
import {
  eventOutcome,
  podium,
  type EventOutcomeContest,
  type EventOutcomeInput,
} from './event-outcome';

const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const EVENT = id(9999);
const R = (code: string): RulesetSpec =>
  RULESET_TEMPLATES.find((t) => t.code === code)?.spec as RulesetSpec;
const P = (code: string): ClassificationPolicyV2Spec =>
  CLASSIFICATION_TEMPLATES.find((t) => t.code === code)?.spec as ClassificationPolicyV2Spec;

/** A normalized head-to-head result: entries sorted by participant id, as the scorer emits them. */
function h2h(
  a: string,
  oa: ResultOutcome,
  b: string,
  ob: ResultOutcome,
  extra: NormalizedContestResult['entries'] = [],
): NormalizedContestResult {
  const e = (participantId: string, outcome: ResultOutcome) => ({
    participantId,
    outcome,
    metrics: {},
    series: {},
  });
  return {
    family: 'SETS_OF_GAMES',
    mode: 'HEAD_TO_HEAD',
    entries: [e(a, oa), e(b, ob), ...extra].sort((x, y) =>
      x.participantId < y.participantId ? -1 : 1,
    ),
  };
}
const win = (w: string, l: string) => h2h(w, 'WIN', l, 'LOSS');

let vseq = 0;
function contest(
  contestId: string,
  stageKey: string,
  roundKey: string,
  roundType: string,
  occupants: (string | null)[],
  opts: {
    status?: string;
    result?: NormalizedContestResult | undefined;
    feeders?: EventOutcomeContest['feeders'];
    vacant?: boolean;
  } = {},
): EventOutcomeContest {
  vseq += 1;
  return {
    contestId,
    stageKey,
    roundKey,
    roundType,
    status: opts.status ?? 'COMPLETED',
    occupants,
    vacant: opts.vacant ?? false,
    feeders: opts.feeders ?? [],
    ...(opts.result === undefined
      ? {}
      : {
          evidence: {
            resultVersionId: id(70_000 + vseq),
            contentHash: `sha256:${String(vseq).padStart(64, '0')}`,
            result: opts.result,
          },
        }),
  };
}
const W = (contestId: string) => ({ kind: 'WINNER_OF_CONTEST' as const, contestId });
const L = (contestId: string) => ({ kind: 'LOSER_OF_CONTEST' as const, contestId });

const [A, B, C, D, E, F, G, H] = [1, 2, 3, 4, 5, 6, 7, 8].map(id) as [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];
const [Q1, Q2, Q3, Q4, S1, S2, FIN, P3] = [101, 102, 103, 104, 201, 202, 301, 302].map(id) as [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

/**
 * An 8-entrant single-elimination stage: A beats B, C beats D, E beats F, G beats H; A beats C and
 * E beats G in the semifinals; the final (and the optional play-off) are given by the test.
 */
function bracket(
  final: Partial<Parameters<typeof contest>[5]> & { occupants?: (string | null)[] },
  playoff?: Partial<Parameters<typeof contest>[5]> & { occupants?: (string | null)[] },
  semis: { s1?: Parameters<typeof contest>[5]; s2?: Parameters<typeof contest>[5] } = {},
): EventOutcomeInput {
  const contests = [
    contest(Q1, 's1', 's1-r1', 'KNOCKOUT', [A, B], { result: win(A, B) }),
    contest(Q2, 's1', 's1-r1', 'KNOCKOUT', [C, D], { result: win(C, D) }),
    contest(Q3, 's1', 's1-r1', 'KNOCKOUT', [E, F], { result: win(E, F) }),
    contest(Q4, 's1', 's1-r1', 'KNOCKOUT', [G, H], { result: win(G, H) }),
    contest(S1, 's1', 's1-r2', 'KNOCKOUT', [A, C], {
      result: win(A, C),
      feeders: [W(Q1), W(Q2)],
      ...semis.s1,
    }),
    contest(S2, 's1', 's1-r2', 'KNOCKOUT', [E, G], {
      result: win(E, G),
      feeders: [W(Q3), W(Q4)],
      ...semis.s2,
    }),
    contest(FIN, 's1', 's1-r3', 'FINAL', final.occupants ?? [A, E], {
      feeders: [W(S1), W(S2)],
      ...final,
    }),
    ...(playoff === undefined
      ? []
      : [
          contest(P3, 's1', 's1-r3-3p', 'KNOCKOUT', playoff.occupants ?? [C, G], {
            feeders: [L(S1), L(S2)],
            ...playoff,
          }),
        ]),
  ];
  return {
    eventId: EVENT,
    stages: [{ key: 's1', sequence: 1, primitive: 'KNOCKOUT' }],
    transitions: [],
    rounds: [...new Set(contests.map((c) => c.roundKey))].map((key) => ({
      key,
      stageKey: 's1',
      dynamic: false,
    })),
    contests,
    classifications: [],
  };
}

const places = (input: EventOutcomeInput) =>
  eventOutcome(input).document.placements.map((p) => [p.participantId, p.position, p.tied]);

describe('event-outcome/1 — knockout', () => {
  it('1. the final decides winner (1) and runner-up (2) from the official result', () => {
    const o = eventOutcome(bracket({ result: win(E, A) }));
    expect(o.document.kind).toBe('KNOCKOUT');
    expect(o.document.status).toBe('DECIDED');
    expect(o.document.placements.slice(0, 2)).toMatchObject([
      { participantId: E, position: 1, tied: false, basis: { contestId: FIN, as: 'WINNER' } },
      { participantId: A, position: 2, tied: false, basis: { contestId: FIN, as: 'LOSER' } },
    ]);
  });

  it('2. a third-place play-off decides third and fourth', () => {
    expect(places(bracket({ result: win(A, E) }, { result: win(G, C) }))).toEqual([
      [A, 1, false],
      [E, 2, false],
      [G, 3, false],
      [C, 4, false],
    ]);
  });

  it('3. without a play-off both semifinal losers share third (D1) and nobody is fourth', () => {
    const o = eventOutcome(bracket({ result: win(A, E) }));
    expect(places(bracket({ result: win(A, E) }))).toEqual([
      [A, 1, false],
      [E, 2, false],
      [C, 3, true],
      [G, 3, true],
    ]);
    expect(podium(o.document).map((p) => p.position)).toEqual([1, 2, 3, 3]);
  });

  it('a play-off that was cancelled (unused) falls back to joint third', () => {
    expect(places(bracket({ result: win(A, E) }, { status: 'CANCELLED' }))).toEqual([
      [A, 1, false],
      [E, 2, false],
      [C, 3, true],
      [G, 3, true],
    ]);
  });

  it('a play-off not yet official keeps the outcome PENDING', () => {
    const o = eventOutcome(bracket({ result: win(A, E) }, { status: 'IN_PROGRESS' }));
    expect(o.document.status).toBe('PENDING');
    expect(o.document.reasons).toEqual([{ code: 'THIRD_PLACE_NOT_OFFICIAL', contestIds: [P3] }]);
    expect(o.document.placements).toEqual([]);
  });

  it('4. a bye creates no contest: a semifinal fed by a bye contributes one third place only', () => {
    // 3 entrants in a draw of 4: A has a bye into the final, B beats C in the only semifinal.
    const semi = contest(S1, 's1', 's1-r1', 'KNOCKOUT', [B, C], { result: win(B, C) });
    const final = contest(FIN, 's1', 's1-r2', 'FINAL', [A, B], {
      result: win(A, B),
      feeders: [W(S1)],
    });
    const o = eventOutcome({
      eventId: EVENT,
      stages: [{ key: 's1', sequence: 1, primitive: 'KNOCKOUT' }],
      transitions: [],
      rounds: [
        { key: 's1-r1', stageKey: 's1', dynamic: false },
        { key: 's1-r2', stageKey: 's1', dynamic: false },
      ],
      contests: [semi, final],
      classifications: [],
    });
    expect(o.document.placements.map((p) => [p.participantId, p.position, p.tied])).toEqual([
      [A, 1, false],
      [B, 2, false],
      [C, 3, false],
    ]);
    expect(o.document.inputs.map((i) => i.contestId)).toEqual([S1, FIN].sort());
  });

  it('5. a walkover is an ordinary decision', () => {
    expect(
      places(bracket({ result: h2h(A, 'WALKOVER_LOSS', E, 'WALKOVER_WIN') })).slice(0, 2),
    ).toEqual([
      [E, 1, false],
      [A, 2, false],
    ]);
  });

  it('6. a drawn final is UNDECIDED (D7)', () => {
    const o = eventOutcome(bracket({ result: h2h(A, 'DRAW', E, 'DRAW') }));
    expect(o.document.status).toBe('UNDECIDED');
    expect(o.document.reasons).toEqual([{ code: 'FINAL_NO_WINNER', contestIds: [FIN] }]);
    expect(o.document.placements).toEqual([]);
  });

  it('7. a void final is UNDECIDED, even with an official result', () => {
    const o = eventOutcome(bracket({ status: 'VOID', result: win(A, E) }));
    expect([o.document.status, o.document.reasons[0]?.code]).toEqual(['UNDECIDED', 'FINAL_VOID']);
  });

  it('8. a cancelled final is UNDECIDED', () => {
    const o = eventOutcome(bracket({ status: 'CANCELLED' }));
    expect([o.document.status, o.document.reasons[0]?.code]).toEqual([
      'UNDECIDED',
      'FINAL_CANCELLED',
    ]);
  });

  it('9. a finalist place decided vacant is UNDECIDED', () => {
    const o = eventOutcome(bracket({ status: 'PLANNED', occupants: [A, null], vacant: true }));
    expect([o.document.status, o.document.reasons[0]?.code]).toEqual(['UNDECIDED', 'FINAL_VACANT']);
  });

  it('10. a final without an official result is PENDING (never a guess)', () => {
    const o = eventOutcome(bracket({ status: 'IN_PROGRESS' }));
    expect([o.document.status, o.document.reasons[0]?.code]).toEqual([
      'PENDING',
      'FINAL_NOT_OFFICIAL',
    ]);
    expect(o.document.placements).toEqual([]);
  });

  it('a result naming other entrants than the final’s occupants decides nothing', () => {
    const o = eventOutcome(bracket({ result: win(A, G) }));
    expect([o.document.status, o.document.reasons[0]?.code]).toEqual([
      'UNDECIDED',
      'FINAL_OCCUPANTS_CHANGED',
    ]);
  });

  it('a semifinal without an official result keeps third place PENDING', () => {
    const o = eventOutcome(
      bracket({ result: win(A, E) }, undefined, { s2: { status: 'COMPLETED', result: undefined } }),
    );
    // The second semifinal's evidence is absent: its loser is unknown.
    expect(o.document.status).toBe('PENDING');
    expect(o.document.reasons).toEqual([{ code: 'SEMIFINAL_NOT_OFFICIAL', contestIds: [S2] }]);
  });
});

function twoStage(
  primitive1: 'ROUND_ROBIN' | 'FIELD',
  s2: EventOutcomeContest[],
  transition: string,
  extraS1Rounds: EventOutcomeInput['rounds'] = [],
): EventOutcomeInput {
  return {
    eventId: EVENT,
    // Listed out of order on purpose: the final stage is the highest sequence.
    stages: [
      { key: 's2', sequence: 2, primitive: 'KNOCKOUT' },
      { key: 's1', sequence: 1, primitive: primitive1 },
    ],
    transitions: [{ kind: transition, fromStage: 's1', toStage: 's2' }],
    rounds: [
      ...extraS1Rounds,
      ...[...new Set(s2.map((c) => c.roundKey))].map((key) => ({
        key,
        stageKey: 's2',
        dynamic: false,
      })),
    ],
    contests: s2,
    classifications: [],
  };
}

describe('event-outcome/1 — two-stage formats', () => {
  it('11. groups → knockout reads the knockout stage', () => {
    const o = eventOutcome(
      twoStage(
        'ROUND_ROBIN',
        [
          contest(S1, 's2', 's2-r1', 'KNOCKOUT', [A, D], { result: win(A, D) }),
          contest(S2, 's2', 's2-r1', 'KNOCKOUT', [C, B], { result: win(B, C) }),
          contest(FIN, 's2', 's2-r2', 'FINAL', [A, B], {
            result: win(B, A),
            feeders: [W(S1), W(S2)],
          }),
        ],
        'RANK_FROM_GROUP',
        [
          { key: 's1-g1-r1', stageKey: 's1', groupKey: 'g1', dynamic: false },
          { key: 's1-g2-r1', stageKey: 's1', groupKey: 'g2', dynamic: false },
        ],
      ),
    );
    expect([o.document.kind, o.document.finalStageKey, o.document.status]).toEqual([
      'KNOCKOUT',
      's2',
      'DECIDED',
    ]);
    expect(o.document.placements.map((p) => [p.participantId, p.position])).toEqual([
      [B, 1],
      [A, 2],
      [C, 3],
      [D, 3],
    ]);
  });

  it('12 + 24. qualifying → bracket: the final stage is the highest sequence, not the qualifying FINAL round', () => {
    const input = twoStage(
      'FIELD',
      [
        // The qualifying stage's last round is typed FINAL too; it must be ignored.
        contest(Q1, 's1', 's1-r1', 'FINAL', [], { result: win(A, B) }),
        contest(S1, 's2', 's2-r1', 'KNOCKOUT', [A, D], { result: win(A, D) }),
        contest(S2, 's2', 's2-r1', 'KNOCKOUT', [B, C], { result: win(C, B) }),
        contest(FIN, 's2', 's2-r2', 'FINAL', [A, C], {
          result: win(A, C),
          feeders: [W(S1), W(S2)],
        }),
      ],
      'RANK_TO_BRACKET',
    );
    const o = eventOutcome(input);
    expect([o.document.kind, o.document.finalStageKey]).toEqual(['KNOCKOUT', 's2']);
    expect(o.document.placements.map((p) => [p.participantId, p.position, p.tied])).toEqual([
      [A, 1, false],
      [C, 2, false],
      [B, 3, true],
      [D, 3, true],
    ]);
  });

  const ladder = (k: number) => {
    // Seats 1..k = A, B, C, D. m1: seat k vs k−1; each next match: the climber vs the next seat.
    const seats = [A, B, C, D].slice(0, k);
    const contests: EventOutcomeContest[] = [];
    let climber = seats[k - 1] as string;
    for (let m = 1, seat = k - 1; seat >= 1; m++, seat--) {
      const opponent = seats[seat - 1] as string;
      // The higher seat always wins, so the climber stops at m1 unless k = 2.
      const [w, l] = [opponent, climber];
      contests.push(
        contest(
          id(400 + m),
          's2',
          `s2-r${m}`,
          seat === 1 ? 'FINAL' : 'KNOCKOUT',
          [climber, opponent],
          {
            result: win(w, l),
            feeders: m === 1 ? [] : [W(id(400 + m - 1))],
          },
        ),
      );
      climber = w;
    }
    return eventOutcome(twoStage('FIELD', contests, 'STEPLADDER'));
  };

  it('13. stepladder K=2: one match is the final; no third place exists', () => {
    const o = ladder(2);
    expect(o.document.kind).toBe('STEPLADDER');
    expect(o.document.placements.map((p) => [p.participantId, p.position])).toEqual([
      [A, 1],
      [B, 2],
    ]);
  });

  it('14. stepladder K=3: the first match’s loser is third (alone)', () => {
    expect(ladder(3).document.placements.map((p) => [p.participantId, p.position, p.tied])).toEqual(
      [
        [A, 1, false],
        [B, 2, false],
        [C, 3, false],
      ],
    );
  });

  it('15. stepladder K=4: elimination order gives 1–3; fourth is not invented (D2)', () => {
    expect(ladder(4).document.placements.map((p) => [p.participantId, p.position, p.tied])).toEqual(
      [
        [A, 1, false],
        [B, 2, false],
        [C, 3, false],
      ],
    );
  });
});

// ───────────────────────── classification-backed formats ─────────────────────────

let cseq = 0;
function scored(
  ruleset: string,
  mode: 'HEAD_TO_HEAD' | 'FIELD',
  participants: string[],
  sheet: ScoreSheet,
  round = 1,
): ClassificationV2Contest {
  const s = scoreContest({ ruleset: R(ruleset), mode, participants }, sheet);
  if (!s.ok) throw new Error(JSON.stringify(s.issues));
  cseq += 1;
  return {
    contestId: id(80_000 + cseq),
    roundSequence: round,
    resultVersionId: id(90_000 + cseq),
    contentHash: `sha256:${String(cseq).padStart(64, 'a')}`,
    result: s.result,
  };
}
function table(
  policy: string,
  participants: string[],
  contests: ClassificationV2Contest[],
  opts: { groupKey?: string; pending?: string[] } = {},
) {
  const out = classifyStage({
    policy: P(policy),
    policyRef: { code: policy, version: 1, specHash: `sha256:${'0'.repeat(64)}` },
    scope: {
      eventId: EVENT,
      stageKey: 's1',
      ...(opts.groupKey === undefined ? {} : { groupKey: opts.groupKey }),
    },
    participants,
    contests,
    pendingContests: opts.pending ?? [],
  });
  if (!out.ok) throw new Error(JSON.stringify(out.issues));
  return {
    ...(opts.groupKey === undefined ? {} : { groupKey: opts.groupKey }),
    policy: P(policy),
    document: out.document,
  };
}
function single(
  primitive: 'ROUND_ROBIN' | 'FIELD',
  classifications: EventOutcomeInput['classifications'],
  rounds: EventOutcomeInput['rounds'] = [{ key: 's1-r1', stageKey: 's1', dynamic: false }],
  contests: EventOutcomeContest[] = [],
): EventOutcomeInput {
  return {
    eventId: EVENT,
    stages: [{ key: 's1', sequence: 1, primitive }],
    transitions: [],
    rounds,
    contests,
    classifications,
  };
}
const sets = (...s: [number, number][]): ScoreSheet => ({
  family: 'SETS_OF_GAMES',
  sets: s.map((games) => ({ games })),
});
const TENNIS = 'sets-2-plus-match-tiebreak-no-ad';

describe('event-outcome/1 — round robin', () => {
  it('16. one group: positions come from the official standings', () => {
    const t = table(
      'itf_rr',
      [A, B, C],
      [
        scored(TENNIS, 'HEAD_TO_HEAD', [A, B], sets([6, 4], [6, 4])),
        scored(TENNIS, 'HEAD_TO_HEAD', [A, C], sets([6, 4], [6, 4])),
        scored(TENNIS, 'HEAD_TO_HEAD', [B, C], sets([6, 4], [6, 4])),
      ],
    );
    const o = eventOutcome(single('ROUND_ROBIN', [t]));
    expect([o.document.kind, o.document.status, o.document.reasons]).toEqual([
      'STANDINGS',
      'DECIDED',
      [],
    ]);
    expect(o.document.placements.map((p) => [p.participantId, p.position, p.tied])).toEqual([
      [A, 1, false],
      [B, 2, false],
      [C, 3, false],
    ]);
    expect(o.document.standings).toEqual([{ document: t.document }]);
    expect(o.document.inputs).toHaveLength(3);
  });

  it('17. an exhausted tie stays shared, with TIE_UNBROKEN_LOT (no lot is stored, D5)', () => {
    const t = table(
      'itf_rr',
      [A, B, C],
      [
        scored(TENNIS, 'HEAD_TO_HEAD', [A, B], sets([6, 4], [6, 4])),
        scored(TENNIS, 'HEAD_TO_HEAD', [B, C], sets([6, 4], [6, 4])),
        scored(TENNIS, 'HEAD_TO_HEAD', [C, A], sets([6, 4], [6, 4])),
      ],
    );
    const o = eventOutcome(single('ROUND_ROBIN', [t]));
    expect(o.document.status).toBe('DECIDED');
    expect(o.document.reasons).toEqual([{ code: 'TIE_UNBROKEN_LOT' }]);
    expect(o.document.placements.map((p) => [p.position, p.tied])).toEqual([
      [1, true],
      [1, true],
      [1, true],
    ]);
  });

  it('18. several groups: GROUPS, one table each, no invented champion (D3)', () => {
    const g1 = table(
      'itf_rr',
      [A, B],
      [scored(TENNIS, 'HEAD_TO_HEAD', [A, B], sets([6, 4], [6, 4]))],
      {
        groupKey: 'g1',
      },
    );
    const g2 = table(
      'itf_rr',
      [C, D],
      [scored(TENNIS, 'HEAD_TO_HEAD', [C, D], sets([6, 4], [6, 4]))],
      {
        groupKey: 'g2',
      },
    );
    const o = eventOutcome(
      single(
        'ROUND_ROBIN',
        [g2, g1],
        [
          { key: 's1-g1-r1', stageKey: 's1', groupKey: 'g1', dynamic: false },
          { key: 's1-g2-r1', stageKey: 's1', groupKey: 'g2', dynamic: false },
        ],
      ),
    );
    expect([o.document.kind, o.document.status]).toEqual(['GROUPS', 'DECIDED']);
    expect(o.document.reasons).toEqual([{ code: 'GROUPS_NO_CHAMPION' }]);
    expect(o.document.placements).toEqual([]);
    expect(podium(o.document)).toEqual([]);
    expect(o.document.standings.map((s) => s.groupKey)).toEqual(['g1', 'g2']);
  });

  it('a group without its table is NOT_SUPPORTED (never a partial champion)', () => {
    const g1 = table(
      'itf_rr',
      [A, B],
      [scored(TENNIS, 'HEAD_TO_HEAD', [A, B], sets([6, 4], [6, 4]))],
      {
        groupKey: 'g1',
      },
    );
    const o = eventOutcome(
      single(
        'ROUND_ROBIN',
        [g1],
        [
          { key: 's1-g1-r1', stageKey: 's1', groupKey: 'g1', dynamic: false },
          { key: 's1-g2-r1', stageKey: 's1', groupKey: 'g2', dynamic: false },
        ],
      ),
    );
    expect([o.document.status, o.document.reasons]).toEqual([
      'NOT_SUPPORTED',
      [{ code: 'CLASSIFICATION_UNAVAILABLE' }],
    ]);
  });

  it('an incomplete table (a match without an official result) is PENDING', () => {
    const played = scored(TENNIS, 'HEAD_TO_HEAD', [A, B], sets([6, 4], [6, 4]));
    const t = table('itf_rr', [A, B, C], [played], { pending: [id(77)] });
    const o = eventOutcome(
      single('ROUND_ROBIN', [t], undefined, [
        contest(played.contestId, 's1', 's1-r1', 'GROUP', [A, B]),
        contest(id(77), 's1', 's1-r1', 'GROUP', [A, C], { status: 'IN_PROGRESS' }),
      ]),
    );
    expect([o.document.status, o.document.reasons]).toEqual([
      'PENDING',
      [{ code: 'CLASSIFICATION_INCOMPLETE', contestIds: [id(77)] }],
    ]);
    expect(o.document.placements).toEqual([]);
    expect(o.document.standings).toHaveLength(1);
  });

  it('a cancelled or void match without a result decides nothing and keeps nothing pending', () => {
    const played = scored(TENNIS, 'HEAD_TO_HEAD', [A, B], sets([6, 4], [6, 4]));
    const t = table('itf_rr', [A, B, C], [played], { pending: [id(77), id(78)] });
    const o = eventOutcome(
      single('ROUND_ROBIN', [t], undefined, [
        contest(played.contestId, 's1', 's1-r1', 'GROUP', [A, B]),
        contest(id(77), 's1', 's1-r1', 'GROUP', [A, C], { status: 'CANCELLED' }),
        contest(id(78), 's1', 's1-r1', 'GROUP', [B, C], { status: 'VOID' }),
      ]),
    );
    expect(o.document.status).toBe('DECIDED');
    expect(o.document.placements.map((p) => p.participantId)).toEqual([A, B, C]);
  });
});

describe('event-outcome/1 — metric', () => {
  const race = (
    entries: { participantId: string; status: 'FINISHED' | 'DNF'; timeMs?: number }[],
  ) =>
    table(
      'road_race',
      entries.map((e) => e.participantId),
      [
        scored(
          'road-gun-time',
          'FIELD',
          entries.map((e) => e.participantId),
          { family: 'ELAPSED_TIME', entries } as ScoreSheet,
        ),
      ],
    );

  it('19. mass start: positions from the classification; shared times stay shared (1, 1, 3 — D8)', () => {
    const o = eventOutcome(
      single('FIELD', [
        race([
          { participantId: A, status: 'FINISHED', timeMs: 3_600_000 },
          { participantId: B, status: 'FINISHED', timeMs: 3_600_000 },
          { participantId: C, status: 'FINISHED', timeMs: 3_700_000 },
        ]),
      ]),
    );
    expect([o.document.kind, o.document.status, o.document.reasons]).toEqual([
      'METRIC',
      'DECIDED',
      [],
    ]);
    const p = podium(o.document).map((x) => [x.participantId, x.position, x.tied]);
    // Two first places, no second place, one third place.
    expect(p).toEqual([
      [A, 1, true],
      [B, 1, true],
      [C, 3, false],
    ]);
    expect(p.some(([, pos]) => pos === 2)).toBe(false);
  });

  it('20. non-finishers stay in the standings but never on the podium', () => {
    const o = eventOutcome(
      single('FIELD', [
        race([
          { participantId: A, status: 'FINISHED', timeMs: 3_600_000 },
          { participantId: B, status: 'FINISHED', timeMs: 3_650_000 },
          { participantId: C, status: 'DNF' },
        ]),
      ]),
    );
    expect(o.document.placements.map((x) => x.participantId)).toEqual([A, B]);
    expect(o.document.standings[0]?.document.entries.map((e) => e.status)).toEqual([
      'CLASSIFIED',
      'CLASSIFIED',
      'DNF',
    ]);
  });

  it('21. golf: identical cards survive count-back and the undrawn organizer lot → shared', () => {
    const course = {
      holes: Array.from({ length: 18 }, (_, i) => ({ par: 4, strokeIndex: i + 1 })),
    };
    const flat = Array.from({ length: 18 }, () => 4);
    const t = table(
      'golf_stroke',
      [A, B, C],
      [
        scored('golf-stroke-gross', 'FIELD', [A, B, C], {
          family: 'STROKES',
          course,
          entries: [
            { participantId: A, status: 'FINISHED', holes: flat },
            { participantId: B, status: 'FINISHED', holes: flat },
            { participantId: C, status: 'FINISHED', holes: flat.map((x) => x + 1) },
          ],
        } as ScoreSheet),
      ],
    );
    const o = eventOutcome(single('FIELD', [t]));
    expect(o.document.reasons).toEqual([{ code: 'TIE_UNBROKEN_LOT' }]);
    expect(o.document.placements.map((x) => [x.participantId, x.position, x.tied])).toEqual([
      [A, 1, true],
      [B, 1, true],
      [C, 3, false],
    ]);
  });

  it('22. multi-round: a dynamic round not materialized yet keeps the outcome PENDING', () => {
    const t = race([{ participantId: A, status: 'FINISHED', timeMs: 1 }]);
    const o = eventOutcome(
      single(
        'FIELD',
        [t],
        [
          { key: 's1-r1', stageKey: 's1', dynamic: false },
          { key: 's1-r2', stageKey: 's1', dynamic: true },
        ],
        [contest(t.document.inputs[0]?.contestId as string, 's1', 's1-r1', 'SESSION', [])],
      ),
    );
    expect([o.document.status, o.document.reasons]).toEqual([
      'PENDING',
      [{ code: 'DYNAMIC_ROUND_PENDING' }],
    ]);
  });

  it('a final stage without a classification is NOT_SUPPORTED', () => {
    const o = eventOutcome(single('FIELD', []));
    expect([o.document.kind, o.document.status]).toEqual(['METRIC', 'NOT_SUPPORTED']);
  });
});

describe('event-outcome/1 — engines and determinism', () => {
  it('23. a v1 engine (no stage graph) is NOT_SUPPORTED', () => {
    const o = eventOutcome({
      eventId: EVENT,
      stages: [],
      transitions: [],
      rounds: [],
      contests: [],
      classifications: [],
    });
    expect(o.document).toMatchObject({ status: 'NOT_SUPPORTED', reasons: [{ code: 'ENGINE_V1' }] });
    expect(o.document.kind).toBeUndefined();
  });

  it('25. the canonical hash is independent of input order and changes with the outcome', () => {
    const input = bracket({ result: win(A, E) }, { result: win(C, G) });
    const shuffled: EventOutcomeInput = {
      ...input,
      contests: [...input.contests].reverse(),
      rounds: [...input.rounds].reverse(),
    };
    const a = eventOutcome(input);
    expect(eventOutcome(shuffled).hash).toBe(a.hash);
    expect(eventOutcome(input).document).toEqual(a.document);
    expect(a.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(eventOutcome(bracket({ result: win(E, A) }, { result: win(C, G) })).hash).not.toBe(
      a.hash,
    );
  });

  it('26. contestDecision is the advancement winner rule (WIN / WALKOVER_WIN vs exactly one)', () => {
    expect(contestDecision(win(A, B))).toMatchObject({
      winner: { participantId: A },
      loser: { participantId: B },
    });
    expect(contestDecision(h2h(A, 'WALKOVER_WIN', B, 'WALKOVER_LOSS'))?.winner.participantId).toBe(
      A,
    );
    expect(contestDecision(h2h(A, 'RETIRED', B, 'WIN'))?.winner.participantId).toBe(B);
    expect(contestDecision(h2h(A, 'DRAW', B, 'DRAW'))).toBeUndefined();
    expect(contestDecision(h2h(A, 'LOSS', B, 'LOSS'))).toBeUndefined();
    const three = h2h(A, 'WIN', B, 'LOSS', [
      { participantId: C, outcome: 'LOSS', metrics: {}, series: {} },
    ]);
    expect(contestDecision(three)).toBeUndefined();
    // The outcome engine uses exactly that rule for the final.
    for (const r of [win(A, E), h2h(A, 'WALKOVER_LOSS', E, 'WALKOVER_WIN')]) {
      const d = contestDecision(r);
      const o = eventOutcome(bracket({ result: r }));
      expect(o.document.placements[0]?.participantId).toBe(d?.winner.participantId);
      expect(o.document.placements[1]?.participantId).toBe(d?.loser.participantId);
    }
  });
});
