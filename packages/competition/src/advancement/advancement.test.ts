import { describe, expect, it } from 'vitest';
import {
  ADVANCEMENT_POLICY_TEMPLATES,
  advancementDecision,
  assignmentDigest,
  compareCrossGroup,
  resolveAdvancementUnit,
  validateAdvancementPolicy,
  type AdvancementPolicySpec,
  type AdvancementUnit,
  type ClassificationEvidence,
} from './index';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [A, B, C, D, E, F] = [1, 2, 3, 4, 5, 6].map(id) as [
  string,
  string,
  string,
  string,
  string,
  string,
];
const H = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;
const policy = (
  code: string,
  over: Partial<AdvancementPolicySpec> = {},
): AdvancementPolicySpec => ({
  ...(ADVANCEMENT_POLICY_TEMPLATES.find((t) => t.code === code)?.spec as AdvancementPolicySpec),
  ...over,
});
const active = (...ids: string[]) =>
  Object.fromEntries(ids.map((x, i) => [x, { status: 'ACTIVE', seed: i + 1 }]));
const slot = (n: number) => ({ kind: 'SLOT' as const, contestId: id(100), slot: n });

/** A classification document: entries in order with explicit positions. */
function cls(
  rows: [string, number, (string | undefined)?, Record<string, string>?][],
  extra: Partial<ClassificationEvidence> = {},
): ClassificationEvidence {
  const counts = new Map<number, number>();
  for (const [, p] of rows) counts.set(p, (counts.get(p) ?? 0) + 1);
  return {
    stageKey: 's1',
    hash: H(7),
    ...extra,
    document: {
      complete: true,
      entries: rows.map(([participantId, position, status, values]) => ({
        participantId,
        position,
        tied: (counts.get(position) ?? 0) > 1,
        status: status ?? 'CLASSIFIED',
        values: Object.entries(values ?? {}).map(([key, value]) => ({ key, value })),
      })),
    },
  };
}

const h2h = (winner: string, loser: string) => ({
  family: 'SETS_OF_GAMES' as const,
  mode: 'HEAD_TO_HEAD' as const,
  entries: [
    { participantId: winner, outcome: 'WIN' as const, opponentId: loser, metrics: {}, series: {} },
    { participantId: loser, outcome: 'LOSS' as const, opponentId: winner, metrics: {}, series: {} },
  ].sort((x, y) => (x.participantId < y.participantId ? -1 : 1)),
});

const contestUnit = (
  over: Partial<Extract<AdvancementUnit, { kind: 'CONTEST' }>> = {},
): AdvancementUnit => ({
  kind: 'CONTEST',
  contestId: id(50),
  contestStatus: 'COMPLETED',
  occupants: [A, B],
  upstreamStale: false,
  evidence: { resultVersionId: id(60), contentHash: H(1), status: 'OFFICIAL', result: h2h(B, A) },
  targets: [
    { target: slot(1), family: 'DIRECT_WINNER' },
    { target: { kind: 'SLOT', contestId: id(101), slot: 1 }, family: 'DIRECT_LOSER' },
  ],
  ...over,
});

describe('policy vocabulary', () => {
  it('every canonical template validates; unknown keys and values are refused', () => {
    for (const t of ADVANCEMENT_POLICY_TEMPLATES)
      expect(validateAdvancementPolicy(t.spec)).toEqual([]);
    expect(validateAdvancementPolicy({ ...policy('official-confirmed'), extra: 1 })).not.toEqual(
      [],
    );
    expect(
      validateAdvancementPolicy({ ...policy('official-confirmed'), commit: 'SILENT' }),
    ).not.toEqual([]);
    expect(
      validateAdvancementPolicy({
        ...policy('official-confirmed'),
        crossGroupOrder: [{ kind: 'HEAD_TO_HEAD' }],
      }),
    ).not.toEqual([]);
  });
});

describe('DIRECT_WINNER / DIRECT_LOSER', () => {
  const p = policy('official-confirmed');
  it('the winner and loser of an official result fill their slots, with the result as provenance', () => {
    const r = resolveAdvancementUnit(p, active(A, B), contestUnit());
    expect(r.complete).toBe(true);
    expect(r.assignments.map((a) => [a.provenance.family, a.participantId])).toEqual([
      ['DIRECT_WINNER', B],
      ['DIRECT_LOSER', A],
    ]);
    expect(r.assignments[0]?.provenance.result).toMatchObject({
      resultVersionId: id(60),
      outcome: 'WIN',
      opponentId: A,
    });
  });
  it('missing, non-official, cancelled, unresolved-upstream and changed-occupant sources stay PENDING', () => {
    const reasons = [
      contestUnit({ evidence: undefined } as never),
      contestUnit({ evidence: undefined, belowPolicyStatus: 'PROVISIONAL' } as never),
      contestUnit({ contestStatus: 'CANCELLED' }),
      contestUnit({ upstreamStale: true }),
      contestUnit({ occupants: [A, C] }),
      contestUnit({ occupants: [A, null] }),
    ].map((u) => resolveAdvancementUnit(p, active(A, B, C), u).assignments[0]?.reason);
    expect(reasons).toEqual([
      'RESULT_MISSING',
      'RESULT_NOT_OFFICIAL',
      'SOURCE_CANCELLED',
      'UPSTREAM_STALE',
      'SOURCE_OCCUPANTS_CHANGED',
      'SOURCE_OCCUPANTS_CHANGED',
    ]);
  });
  it('a result without a winner never advances anyone; a withdrawn winner vacates (never back-filled)', () => {
    const draw = {
      ...h2h(A, B),
      entries: h2h(A, B).entries.map((e) => ({ ...e, outcome: 'DRAW' as const })),
    };
    const noWinner = resolveAdvancementUnit(
      p,
      active(A, B),
      contestUnit({
        evidence: { resultVersionId: id(60), contentHash: H(1), status: 'OFFICIAL', result: draw },
      }),
    );
    expect(noWinner.assignments.map((a) => a.reason)).toEqual(['NO_WINNER', 'NO_WINNER']);
    const out = resolveAdvancementUnit(
      { ...p, withdrawn: 'NEXT_BEST' },
      { ...active(A, B), [B]: { status: 'WITHDRAWN' } },
      contestUnit(),
    );
    expect(out.assignments[0]).toMatchObject({ state: 'VACANT', reason: 'ENTRANT_WITHDRAWN' });
  });
});

describe('GROUP_RANK / TOP_N / STAGE_TOTAL', () => {
  const unit = (c: ClassificationEvidence, ranks: number[], over = {}): AdvancementUnit => ({
    kind: 'RANK',
    stageKey: 's1',
    groupKey: 'g1',
    multiRound: false,
    classification: c,
    targets: ranks.map((rank) => ({ target: slot(rank), rank })),
    ...over,
  });
  it('ranks map to slots; non-finishers never advance; the family follows the source', () => {
    const r = resolveAdvancementUnit(
      policy('official-confirmed'),
      active(A, B, C),
      unit(
        cls([
          [A, 1],
          [B, 2],
          [C, 3, 'DNF'],
        ]),
        [1, 2, 3],
      ),
    );
    expect(r.assignments.map((a) => a.participantId ?? a.reason)).toEqual([
      A,
      B,
      'NO_ENTRANT_AT_PLACE',
    ]);
    expect(r.assignments[0]?.provenance).toMatchObject({
      family: 'GROUP_RANK',
      classification: { position: 1, tied: false, hash: H(7) },
    });
    const total = resolveAdvancementUnit(
      policy('official-confirmed'),
      active(A, B),
      unit(
        cls([
          [A, 1],
          [B, 2],
        ]),
        [1],
        { groupKey: undefined, multiRound: true },
      ),
    );
    expect(total.families).toEqual(['STAGE_TOTAL']);
  });
  it('two-way tie for an ordered slot: HOLD keeps both slots unresolved; SEED breaks it and says so', () => {
    const c = cls([
      [A, 1],
      [B, 1],
      [C, 3],
    ]);
    const held = resolveAdvancementUnit(
      policy('official-confirmed'),
      active(A, B, C),
      unit(c, [1, 2]),
    );
    expect(held.assignments.map((a) => a.state)).toEqual(['HELD', 'HELD']);
    expect(held.assignments[0]?.provenance.candidates).toEqual([A, B]);
    const seeded = resolveAdvancementUnit(
      policy('official-confirmed', { boundaryTies: 'SEED' }),
      active(B, A, C),
      unit(c, [1, 2]),
    );
    expect(seeded.assignments.map((a) => a.participantId)).toEqual([B, A]);
    expect(seeded.assignments[0]?.provenance.decidedBy).toBe('SEED');
  });
  it('an incomplete classification resolves nothing', () => {
    const c = cls([[A, 1]]);
    const r = resolveAdvancementUnit(
      policy('official-confirmed'),
      active(A),
      unit({ ...c, document: { ...c.document, complete: false } }, [1]),
    );
    expect(r.assignments[0]).toMatchObject({
      state: 'PENDING',
      reason: 'CLASSIFICATION_INCOMPLETE',
    });
  });
  it('withdrawn: VACATE leaves the slot empty; NEXT_BEST takes the next eligible entrant', () => {
    const entrants = { ...active(A, B, C), [A]: { status: 'WITHDRAWN' } };
    const c = cls([
      [A, 1],
      [B, 2],
      [C, 3],
    ]);
    expect(
      resolveAdvancementUnit(policy('official-confirmed'), entrants, unit(c, [1])).assignments[0]
        ?.state,
    ).toBe('VACANT');
    expect(
      resolveAdvancementUnit(
        policy('official-confirmed', { withdrawn: 'NEXT_BEST' }),
        entrants,
        unit(c, [1, 2]),
      ).assignments.map((a) => a.participantId),
    ).toEqual([B, C]);
  });
});

describe('BEST_N_ACROSS_GROUPS (best third places)', () => {
  const p = policy('groups-wins-games');
  const group = (
    g: string,
    third: string,
    wins: string,
    sw: string,
    sl: string,
  ): { groupKey: string; classification: ClassificationEvidence } => ({
    groupKey: g,
    classification: cls(
      [
        [id(200 + g.charCodeAt(1)), 1],
        [id(300 + g.charCodeAt(1)), 2],
        [third, 3, undefined, { wins, setsWon: sw, setsLost: sl, gamesWon: '30', gamesLost: '30' }],
      ],
      { groupKey: g },
    ),
  });
  const unit = (groups: ReturnType<typeof group>[], n: number): AdvancementUnit => ({
    kind: 'BEST',
    stageKey: 's1',
    rank: 3,
    groups,
    targets: Array.from({ length: n }, (_, i) => ({ target: slot(i + 1), ordinal: i + 1 })),
  });
  it('compares the rank-3 entrants by the declared cross-group order and records the comparison', () => {
    const r = resolveAdvancementUnit(
      p,
      active(A, B, C),
      unit(
        [
          group('g1', A, '1', '3', '4'),
          group('g2', B, '1', '4', '3'),
          group('g3', C, '0', '2', '4'),
        ],
        2,
      ),
    );
    expect(r.assignments.map((a) => a.participantId)).toEqual([B, A]);
    expect(r.assignments[0]?.provenance.comparison?.map((x) => x.participantId)).toEqual([B, A, C]);
    expect(r.assignments[0]?.provenance.comparison?.[0]?.values.map((v) => v.key)).toEqual([
      'gamesLost',
      'gamesWon',
      'setsLost',
      'setsWon',
      'wins',
    ]);
  });
  it('a tie across groups at the boundary is HELD; a multi-way tie too', () => {
    const r = resolveAdvancementUnit(
      p,
      active(A, B, C),
      unit(
        [
          group('g1', A, '1', '3', '3'),
          group('g2', B, '1', '3', '3'),
          group('g3', C, '1', '3', '3'),
        ],
        2,
      ),
    );
    expect(r.assignments.map((a) => a.state)).toEqual(['HELD', 'HELD']);
    expect(r.assignments[0]?.provenance.candidates).toEqual([A, B, C]);
  });
  it('one incomplete group blocks the comparison; no declared order is refused', () => {
    const g = group('g2', B, '1', '4', '3');
    const incomplete = {
      ...g,
      classification: {
        ...g.classification,
        document: { ...g.classification.document, complete: false },
      },
    };
    expect(
      resolveAdvancementUnit(p, active(A, B), unit([group('g1', A, '1', '3', '4'), incomplete], 1))
        .assignments[0]?.reason,
    ).toBe('CLASSIFICATION_INCOMPLETE');
    expect(
      resolveAdvancementUnit(
        { ...p, crossGroupOrder: [] },
        active(A),
        unit([group('g1', A, '1', '3', '4')], 1),
      ).assignments[0]?.reason,
    ).toBe('CROSS_GROUP_ORDER_MISSING');
  });
  it('ratios are exact and equal ratios tie', () => {
    const v = (f: string, a: string) => [
      { key: 'f', value: f },
      { key: 'a', value: a },
    ];
    const order = [{ kind: 'RATIO' as const, forKey: 'f', againstKey: 'a' }];
    expect(compareCrossGroup(order, v('2', '4'), v('1', '2'))).toBe(0);
    expect(compareCrossGroup(order, v('2', '3'), v('1', '2'))).toBe(-1);
    expect(compareCrossGroup(order, v('1', '0'), v('9', '1'))).toBe(-1);
  });
});

describe('FIELD: heats → final, cut, finishers', () => {
  const heats = [
    { contestId: id(71), members: [A, B, C] },
    { contestId: id(72), members: [D, E, F] },
  ];
  // Overall time order: D A E B F C (a logistic reading ignores heats entirely).
  const overall = cls([
    [D, 1],
    [A, 2],
    [E, 3],
    [B, 4],
    [F, 5],
    [C, 6],
  ]);
  const heatsUnit = (q: number, t: number, capacity: number, c = overall): AdvancementUnit => ({
    kind: 'FIELD',
    transition: {
      key: 't1',
      kind: 'QUALIFY_BY_PLACE_AND_TIME',
      params: { qualifyByPlace: q, qualifyByTime: t, heats: 2 },
    },
    classification: c,
    heats,
    capacity,
    recordedOrdinals: 0,
  });
  it('competitive heats: Q by place in each heat, then q by time; ordinals by overall time', () => {
    const r = resolveAdvancementUnit(
      policy('heats-place-then-time'),
      active(A, B, C, D, E, F),
      heatsUnit(1, 2, 4),
    );
    expect(r.assignments.map((a) => a.participantId)).toEqual([D, A, E, B]);
    expect(r.assignments[0]?.provenance.heat).toEqual({ contestId: id(72), place: 1 });
    expect(r.assignments[2]?.provenance.heat).toBeUndefined();
  });
  it('logistic heats (OVERALL): the top N of one classification across heats', () => {
    const r = resolveAdvancementUnit(
      policy('heats-overall-time'),
      active(A, B, C, D, E, F),
      heatsUnit(0, 3, 3),
    );
    expect(r.assignments.map((a) => a.participantId)).toEqual([D, A, E]);
    expect(r.families).toEqual(['TOP_N']);
  });
  it('a tie for the last final place holds only that place (the swim-off is an explicit override)', () => {
    const tied = cls([
      [D, 1],
      [A, 2],
      [E, 3],
      [B, 3],
      [F, 5],
      [C, 6],
    ]);
    const r = resolveAdvancementUnit(
      policy('heats-overall-time'),
      active(A, B, C, D, E, F),
      heatsUnit(0, 3, 3, tied),
    );
    expect(r.assignments.map((a) => a.participantId ?? a.state)).toEqual([D, A, 'HELD']);
    expect(r.assignments[2]?.provenance.candidates).toEqual([B, E].sort());
    expect(r.complete).toBe(false);
  });
  it('a tie inside a heat’s Q places holds the whole field (who is left for q is unknown)', () => {
    const tied = cls([
      [D, 1],
      [A, 1],
      [E, 3],
      [B, 4],
      [F, 5],
      [C, 6],
    ]);
    const r = resolveAdvancementUnit(policy('heats-place-then-time'), active(A, B, C, D, E, F), {
      ...heatsUnit(1, 1, 3, tied),
      heats: [
        { contestId: id(71), members: [A, D, B] },
        { contestId: id(72), members: [E, F, C] },
      ],
    } as AdvancementUnit);
    expect(r.assignments.every((a) => a.state === 'HELD')).toBe(true);
  });
  const cut = (
    topN: number,
    includeTies: boolean,
    c: ClassificationEvidence,
    recordedOrdinals = 0,
  ): AdvancementUnit => ({
    kind: 'FIELD',
    transition: { key: 't1', kind: 'CUT', params: { topN, includeTies } },
    classification: { ...c, throughRound: 2 },
    recordedOrdinals,
  });
  it('cut: top N and ties takes everyone tied at the line; without ties the line is HELD', () => {
    const c = cls([
      [A, 1],
      [B, 2],
      [C, 3],
      [D, 3],
      [E, 5],
      [F, 6, 'DNF'],
    ]);
    const withTies = resolveAdvancementUnit(
      policy('field-cut-official'),
      active(A, B, C, D, E, F),
      cut(3, true, c),
    );
    expect(withTies.assignments.map((a) => a.participantId)).toEqual([A, B, C, D]);
    expect(withTies.assignments[3]?.provenance.classification).toMatchObject({
      position: 3,
      tied: true,
      throughRound: 2,
    });
    const noTies = resolveAdvancementUnit(
      policy('field-cut-official'),
      active(A, B, C, D, E, F),
      cut(3, false, c),
    );
    expect(noTies.assignments.map((a) => a.participantId ?? a.state)).toEqual([A, B, 'HELD']);
    const seeded = resolveAdvancementUnit(
      policy('field-cut-official', { boundaryTies: 'SEED' }),
      active(A, B, D, C, E, F),
      cut(3, false, c),
    );
    expect(seeded.assignments.map((a) => a.participantId)).toEqual([A, B, D]);
  });
  it('a smaller field after a correction vacates the recorded ordinals it no longer fills', () => {
    const c = cls([
      [A, 1],
      [B, 2],
      [C, 3],
      [D, 4],
    ]);
    const r = resolveAdvancementUnit(
      policy('field-cut-official'),
      active(A, B, C, D),
      cut(2, true, c, 3),
    );
    expect(r.assignments.map((a) => a.participantId ?? a.reason)).toEqual([A, B, 'NOT_SELECTED']);
  });
  it('finishers only: every classified entrant continues, non-finishers stop', () => {
    const r = resolveAdvancementUnit(policy('field-cut-official'), active(A, B, C), {
      kind: 'FIELD',
      transition: { key: 't2', kind: 'ELIMINATE_NON_FINISHERS', params: {} },
      classification: cls([
        [A, 1],
        [B, 2],
        [C, 3, 'DNF'],
      ]),
      recordedOrdinals: 0,
    });
    expect(r.assignments.map((a) => a.participantId)).toEqual([A, B]);
    expect(r.families).toEqual(['CUT']);
  });
});

describe('determinism and canonical documents', () => {
  it('same inputs ⇒ same document hash; input order never matters', () => {
    const c1 = cls([
      [A, 1],
      [B, 2],
      [C, 3],
    ]);
    const c2 = { ...c1, document: { ...c1.document, entries: [...c1.document.entries].reverse() } };
    const unit = (c: ClassificationEvidence): AdvancementUnit => ({
      kind: 'RANK',
      stageKey: 's1',
      multiRound: false,
      classification: c,
      targets: [
        { target: slot(2), rank: 2 },
        { target: slot(1), rank: 1 },
      ],
    });
    const doc = (c: ClassificationEvidence) =>
      advancementDecision({
        eventId: id(9),
        unit: 'rank:s1',
        kind: 'RESOLUTION',
        policy: { code: 'official-confirmed', version: 1, specHash: H(3) },
        assignments: resolveAdvancementUnit(policy('official-confirmed'), active(A, B, C), unit(c))
          .assignments,
      });
    expect(doc(c1).hash).toBe(doc(c2).hash);
    expect(doc(c1).document.assignments.map((a) => a.target)).toEqual([slot(1), slot(2)]);
  });
  it('the per-assignment digest changes with the evidence even when the entrant does not', () => {
    const a = resolveAdvancementUnit(policy('official-confirmed'), active(A, B), contestUnit())
      .assignments[0];
    const corrected = resolveAdvancementUnit(
      policy('official-confirmed'),
      active(A, B),
      contestUnit({
        evidence: {
          resultVersionId: id(61),
          contentHash: H(2),
          status: 'OFFICIAL',
          result: h2h(B, A),
        },
      }),
    ).assignments[0];
    expect(a?.participantId).toBe(corrected?.participantId);
    expect(assignmentDigest(a as never)).not.toBe(assignmentDigest(corrected as never));
  });
});
