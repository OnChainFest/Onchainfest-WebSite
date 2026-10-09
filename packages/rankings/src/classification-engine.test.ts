import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { platformCanonicalizer, SchemaRef } from '@br/schemas';
import {
  assessClassificationReplacement,
  checkSharedRanks,
  CLASSIFICATION_ENGINE_VERSION,
  classificationCorrectionImpact,
  classificationDependencies,
  deriveClassification,
  OUTCOME_POINTS_TRACE_KEY,
  type ClassificationDerivationOutcome,
} from './index';
import {
  classificationInput,
  contestInput,
  HEATS_DV,
  markOf,
  padelMatch,
  PADEL_DV,
  participant,
  PINS_DV,
  policySpec,
  rkId,
  THROWS_DV,
} from './fixtures';

/**
 * BRT-10 Step 3 — classification engine (proposals of `@2` classification ResultVersion content).
 * REFERENCE ENGINE FIXTURES — NOT PERSISTED SPORTING TRUTH (fictional ids and values).
 */
const derive = (input: unknown, meta = {}) => {
  const r = deriveClassification(input, meta);
  if (!r.ok) throw new Error(`derivation input refused: ${JSON.stringify(r.issues)}`);
  return r;
};
/** [participant number, rank, tied, trace values] sorted by rank then participant. */
const table = (o: ClassificationDerivationOutcome) =>
  [...(o.proposal?.content.entries ?? [])]
    .map((e) => [
      Number.parseInt(e.participantId.slice(-12), 16) - 500,
      e.rank,
      e.tied,
      e.tieBreakKeys.map((t) => t.value),
    ])
    .sort((a, b) => (a[1] as number) - (b[1] as number) || (a[0] as number) - (b[0] as number));

type PinsRow = readonly [participant: number, games: readonly string[]];
/** Bowling-like contest: each game is a PERFORMANCE carrying totalPins and highGame marks. */
const pinsContest = (n: number, rows: readonly PinsRow[], patch: Record<string, unknown> = {}) =>
  contestInput(
    n,
    {
      entries: rows.map(([p]) => ({ participantId: participant(p), outcome: 'RANKED' })),
      performances: rows.flatMap(([p, games]) =>
        games.flatMap((g, i) => [
          {
            participantId: participant(p),
            ordinal: 2 * i + 1,
            mark: markOf(PINS_DV, 'totalPins', g),
          },
          {
            participantId: participant(p),
            ordinal: 2 * i + 2,
            mark: markOf(PINS_DV, 'highGame', g),
          },
        ]),
      ),
    },
    patch,
  );
const pinsInput = (aggs: readonly string[], inputs: readonly { contestId: string }[]) =>
  classificationInput(PINS_DV, policySpec(PINS_DV, aggs), inputs);

/** Heats: [contest, participant, elapsed ms] rows. */
const heats = (rows: readonly (readonly [number, number, string])[]) => {
  const byContest = new Map<number, [number, string][]>();
  for (const [c, p, v] of rows) byContest.set(c, [...(byContest.get(c) ?? []), [p, v]]);
  return [...byContest].map(([c, ps]) =>
    contestInput(c, {
      entries: ps.map(([p]) => ({ participantId: participant(p), outcome: 'RANKED' })),
      performances: ps.map(([p, v]) => ({
        participantId: participant(p),
        ordinal: 1,
        mark: markOf(HEATS_DV, 'elapsedTimeMs', v),
      })),
    }),
  );
};
const heatsInput = (agg: string, rows: readonly (readonly [number, number, string])[]) =>
  classificationInput(HEATS_DV, policySpec(HEATS_DV, [agg]), heats(rows));

const throwsInput = (rows: readonly (readonly [number, number, string, number])[]) => {
  const byContest = new Map<number, [number, string, number][]>();
  for (const [c, p, v, prec] of rows) byContest.set(c, [...(byContest.get(c) ?? []), [p, v, prec]]);
  const inputs = [...byContest].map(([c, ps]) =>
    contestInput(c, {
      entries: ps.map(([p]) => ({ participantId: participant(p), outcome: 'RANKED' })),
      performances: ps.map(([p, v, prec]) => ({
        participantId: participant(p),
        ordinal: 1,
        mark: markOf(THROWS_DV, 'distanceM', v, prec),
      })),
    }),
  );
  return classificationInput(THROWS_DV, policySpec(THROWS_DV, ['SUM']), inputs);
};

const padelGroup = () => [
  padelMatch(1, 1, 2, [2, 0, 12, 5]),
  padelMatch(2, 3, 4, [1, 1, 9, 9]),
  padelMatch(3, 1, 3, [0, 2, 6, 12]),
  padelMatch(4, 2, 4, [2, 1, 13, 10]),
];
const padelInput = (inputs = padelGroup(), patch: Record<string, unknown> = {}) =>
  classificationInput(
    PADEL_DV,
    policySpec(PADEL_DV, ['SUM', 'SUM'], ['ENTRY_PRIMARY_MARK', 'PERFORMANCE'], patch),
    inputs,
  );

describe('METRICS classification: ordered keys, closed aggregation, exact decimals', () => {
  it('26. SUM adds every applicable value exactly; later keys only break ties', () => {
    const o = derive(
      pinsInput(
        ['SUM', 'MAX'],
        [
          pinsContest(1, [
            [1, ['200', '210']],
            [2, ['250']],
          ]),
          pinsContest(2, [
            [1, ['190']],
            [2, ['300']],
          ]),
        ],
      ),
    ).outcome;
    expect(o.state).toBe('PROPOSED');
    expect(table(o)).toEqual([
      [1, 1, false, ['600', '210']],
      [2, 2, false, ['550', '300']],
    ]);
    // Exact decimal SUM at the metric precision (canonical decimal drops trailing zeros only).
    const t = derive(
      throwsInput([
        [1, 1, '7.25', 2],
        [2, 1, '7.30', 2],
        [1, 2, '0.10', 2],
        [2, 2, '0.20', 2],
      ]),
    ).outcome;
    expect(table(t)).toEqual([
      [1, 1, false, ['14.55']],
      [2, 2, false, ['0.3']],
    ]);
  });

  it('27. MAX selects the numerically largest value (best game, HIGHER_IS_BETTER)', () => {
    const o = derive(
      pinsInput(
        ['MAX', 'MAX'],
        [
          pinsContest(1, [
            [1, ['200', '279']],
            [2, ['250']],
          ]),
        ],
      ),
    ).outcome;
    expect(table(o)).toEqual([
      [1, 1, false, ['279', '279']],
      [2, 2, false, ['250', '250']],
    ]);
  });

  it('28. MIN selects the numerically smallest value (best heat, LOWER_IS_BETTER)', () => {
    const o = derive(
      heatsInput('MIN', [
        [1, 1, '61000'],
        [2, 1, '59000'],
        [1, 2, '60000'],
        [2, 2, '60500'],
      ]),
    ).outcome;
    expect(table(o)).toEqual([
      [1, 1, false, ['59000']],
      [2, 2, false, ['60000']],
    ]);
  });

  it('MAX / MIN are numeric in BOTH directions; only the key order decides which is better', () => {
    // LOWER_IS_BETTER + MAX: the numerically largest (slowest) heat, never the "best" one.
    const slowest = derive(
      heatsInput('MAX', [
        [1, 1, '61000'],
        [2, 1, '59000'],
        [1, 2, '60000'],
        [2, 2, '60500'],
      ]),
    ).outcome;
    expect(table(slowest)).toEqual([
      [2, 1, false, ['60500']],
      [1, 2, false, ['61000']],
    ]);
    // HIGHER_IS_BETTER + MIN: the numerically smallest (worst) game, never the "best" one.
    const lowest = derive(
      pinsInput(
        ['MIN', 'MIN'],
        [
          pinsContest(1, [
            [1, ['200', '279']],
            [2, ['250']],
          ]),
        ],
      ),
    ).outcome;
    expect(table(lowest)).toEqual([
      [2, 1, false, ['250', '250']],
      [1, 2, false, ['200', '200']],
    ]);
  });

  it('invalid performances are excluded from PERFORMANCE values (not zero, not worst, not summed)', () => {
    const perf = (p: number, ordinal: number, key: string, v: string, valid = true) => ({
      participantId: participant(p),
      ordinal,
      mark: markOf(PINS_DV, key, v),
      ...(valid ? {} : { valid: false }),
    });
    const c = contestInput(1, {
      entries: [
        { participantId: participant(1), outcome: 'RANKED' },
        { participantId: participant(2), outcome: 'RANKED' },
      ],
      performances: [
        perf(1, 1, 'totalPins', '200'),
        perf(1, 2, 'totalPins', '300', false),
        perf(1, 3, 'highGame', '200'),
        perf(1, 4, 'highGame', '300', false),
        perf(2, 1, 'totalPins', '250'),
        perf(2, 2, 'highGame', '250'),
      ],
    });
    const o = derive(pinsInput(['SUM', 'MAX'], [c])).outcome;
    // P1 = 200 (the invalid 300 contributes nothing), so P2 (250) leads.
    expect(table(o)).toEqual([
      [2, 1, false, ['250', '250']],
      [1, 2, false, ['200', '200']],
    ]);
  });

  it('29. AVERAGE is refused by name as POLICY_UNSUPPORTED (never approximated)', () => {
    const input = pinsInput(['AVERAGE', 'MAX'], [pinsContest(1, [[1, ['200']]])]);
    expect(deriveClassification(input)).toEqual({
      ok: false,
      issues: [{ path: '/policy/spec/keys/0/aggregation', code: 'POLICY_UNSUPPORTED' }],
    });
  });

  it('30. an ORDINAL key is POLICY_UNSUPPORTED (no silent fall-back to metric ordering)', () => {
    const dv = {
      ...HEATS_DV,
      comparator: { ...HEATS_DV.comparator, keys: [{ metric: 'elapsedTimeMs', order: 'ORDINAL' }] },
    };
    const o = derive(
      classificationInput(dv, policySpec(dv, ['SUM']), heats([[1, 1, '60000']])),
    ).outcome;
    expect(o.state).toBe('BLOCKED');
    expect(o.blockers).toContain('POLICY_UNSUPPORTED');
    expect(o.proposal).toBeUndefined();
  });

  it('31. ordered multi-key comparator: key 1 decides; key 2 only separates key-1 ties', () => {
    const o = derive(
      pinsInput(
        ['SUM', 'MAX'],
        [
          pinsContest(1, [
            [1, ['300', '200']],
            [2, ['250', '250']],
            [3, ['290', '201']],
            [4, ['100', '299']],
          ]),
        ],
      ),
    ).outcome;
    // 1 and 2 tie on 500 total → 1 wins on high game 300; 3 (491) is behind both despite no tie.
    expect(table(o)).toEqual([
      [1, 1, false, ['500', '300']],
      [2, 2, false, ['500', '250']],
      [3, 3, false, ['491', '290']],
      [4, 4, false, ['399', '299']],
    ]);
  });

  it('32. participants equal on EVERY key share the rank (1, 1, 3)', () => {
    const o = derive(
      pinsInput(
        ['SUM', 'MAX'],
        [
          pinsContest(1, [
            [1, ['250', '250']],
            [2, ['250', '250']],
            [3, ['200', '200']],
          ]),
        ],
      ),
    ).outcome;
    expect(table(o)).toEqual([
      [1, 1, true, ['500', '250']],
      [2, 1, true, ['500', '250']],
      [3, 3, false, ['400', '200']],
    ]);
  });

  it('33. no hidden tie-break: input order never matters and a broken tie is refused', () => {
    const contest = pinsContest(1, [
      [1, ['250']],
      [2, ['250']],
    ]);
    const a = derive(pinsInput(['SUM', 'MAX'], [contest]));
    const reordered = {
      ...contest,
      content: { ...contest.content, entries: [...contest.content.entries].reverse() },
    };
    const b = derive(pinsInput(['SUM', 'MAX'], [reordered]));
    expect(a.outcomeHash).toBe(b.outcomeHash);
    const entries = a.outcome.proposal?.content.entries ?? [];
    expect(entries.map((e) => [e.rank, e.tied])).toEqual([
      [1, true],
      [1, true],
    ]);
    const broken = entries.map((e, i) => ({ ...e, rank: i + 1, tied: false }));
    const cmp = (x: (typeof broken)[number], y: (typeof broken)[number]) =>
      Number(x.tieBreakKeys[0]?.value) - Number(y.tieBreakKeys[0]?.value);
    expect(checkSharedRanks(broken, cmp).map((i) => i.code)).toEqual(['HIDDEN_TIE_BREAK']);
  });
});

describe('METRICS classification: missing and incompatible values block (never 0, never worst)', () => {
  it('34. a participant without a value in a contest it played blocks the whole derivation', () => {
    const c1 = pinsContest(1, [
      [1, ['200']],
      [2, ['210']],
    ]);
    const c2 = contestInput(2, {
      entries: [
        { participantId: participant(1), outcome: 'RANKED' },
        { participantId: participant(2), outcome: 'DNS' },
      ],
      performances: [
        { participantId: participant(1), ordinal: 1, mark: markOf(PINS_DV, 'totalPins', '190') },
        { participantId: participant(1), ordinal: 2, mark: markOf(PINS_DV, 'highGame', '190') },
      ],
    });
    const o = derive(pinsInput(['SUM', 'MAX'], [c1, c2])).outcome;
    expect(o.state).toBe('BLOCKED');
    expect(o.blockers).toEqual(['COMPARATOR_INPUT_MISSING']);
    expect(o.participants).toEqual([
      { participantId: participant(2), reasons: ['COMPARATOR_INPUT_MISSING'] },
    ]);
    expect(o.proposal).toBeUndefined();
    // An invalid performance is not a value either.
    const invalid = contestInput(1, {
      entries: [{ participantId: participant(1), outcome: 'RANKED' }],
      performances: [
        {
          participantId: participant(1),
          ordinal: 1,
          mark: markOf(HEATS_DV, 'elapsedTimeMs', '60000'),
          valid: false,
        },
      ],
    });
    expect(
      derive(classificationInput(HEATS_DV, policySpec(HEATS_DV, ['MIN']), [invalid])).outcome
        .blockers,
    ).toEqual(['COMPARATOR_INPUT_MISSING']);
  });

  it('35. a primary mark of another metric blocks (METRIC_MISMATCH)', () => {
    const [m1] = padelGroup();
    if (m1 === undefined) throw new Error('fixture');
    const bad = contestInput(1, {
      ...m1.content,
      entries: m1.content.entries.map((e, i) =>
        i === 0 ? { ...e, primaryMark: markOf(PADEL_DV, 'gamesWon', '2') } : e,
      ),
    });
    const o = derive(padelInput([bad])).outcome;
    expect(o.blockers).toEqual(['METRIC_MISMATCH']);
  });

  it('36. a unit other than the DV unit blocks (METRIC_UNIT_MISMATCH, no conversion)', () => {
    const c = contestInput(1, {
      entries: [{ participantId: participant(1), outcome: 'RANKED' }],
      performances: [
        {
          participantId: participant(1),
          ordinal: 1,
          mark: { ...markOf(HEATS_DV, 'elapsedTimeMs', '60'), unit: 's' },
        },
      ],
    });
    const o = derive(classificationInput(HEATS_DV, policySpec(HEATS_DV, ['MIN']), [c])).outcome;
    expect(o.blockers).toEqual(['METRIC_UNIT_MISMATCH']);
  });

  it('37. mixed precisions of one key block (METRIC_PRECISION_MISMATCH, no re-scaling)', () => {
    const o = derive(
      throwsInput([
        [1, 1, '7.25', 2],
        [2, 1, '7.3', 1],
      ]),
    ).outcome;
    expect(o.blockers).toEqual(['METRIC_PRECISION_MISMATCH']);
    // A precision the DV value type does not admit (INTEGER with decimals) blocks too.
    const c = contestInput(1, {
      entries: [{ participantId: participant(1), outcome: 'RANKED' }],
      performances: [
        {
          participantId: participant(1),
          ordinal: 1,
          mark: markOf(PINS_DV, 'totalPins', '200.5', 1),
        },
        { participantId: participant(1), ordinal: 2, mark: markOf(PINS_DV, 'highGame', '200') },
      ],
    });
    expect(derive(pinsInput(['SUM', 'MAX'], [c])).outcome.blockers).toEqual([
      'METRIC_PRECISION_MISMATCH',
    ]);
  });

  it('38. a policy whose keys contradict the pinned DV comparator blocks (COMPARATOR_MISMATCH)', () => {
    const contest = pinsContest(1, [[1, ['200']]]);
    const reordered = { ...policySpec(PINS_DV, ['SUM', 'MAX']) };
    const swapped = { ...reordered, keys: [...reordered.keys].reverse() };
    const o = derive(classificationInput(PINS_DV, swapped, [contest])).outcome;
    expect(o.blockers).toEqual(['COMPARATOR_MISMATCH']);
    const flippedKeys = reordered.keys.map((k, i) =>
      i === 0 ? { ...k, order: 'LOWER_IS_BETTER' } : k,
    );
    expect(
      derive(classificationInput(PINS_DV, { ...reordered, keys: flippedKeys }, [contest])).outcome
        .blockers,
    ).toEqual(['COMPARATOR_MISMATCH']);
  });
});

describe('HEAD_TO_HEAD classification: declared outcome points only', () => {
  it('39. declared outcome points lead (SUM, HIGHER_IS_BETTER), then the DV keys', () => {
    const o = derive(padelInput()).outcome;
    expect(o.state).toBe('PROPOSED');
    // P1: W, L → 3 pts; P2: L, W → 3; P3: D, W → 4; P4: D, L → 1. P1 / P2 equal on every key.
    expect(table(o)).toEqual([
      [3, 1, false, ['4', '3', '21']],
      [1, 2, true, ['3', '2', '18']],
      [2, 2, true, ['3', '2', '18']],
      [4, 4, false, ['1', '2', '19']],
    ]);
    const first = o.proposal?.content.entries[0];
    expect(first?.tieBreakKeys.map((t) => [t.key, t.order])).toEqual([
      [OUTCOME_POINTS_TRACE_KEY, 'HIGHER_IS_BETTER'],
      ['setsWon', 'HIGHER_IS_BETTER'],
      ['gamesWon', 'HIGHER_IS_BETTER'],
    ]);
    // Points are a trace value, never a Mark: no entry carries a primaryMark.
    expect(o.proposal?.content.entries.every((e) => !('primaryMark' in e))).toBe(true);
  });

  it('40. an outcome without declared points blocks with POLICY_UNSUPPORTED (no default points)', () => {
    const walkover = contestInput(5, {
      entries: [
        {
          participantId: participant(1),
          outcome: 'WALKOVER_WIN',
          primaryMark: markOf(PADEL_DV, 'setsWon', '0'),
        },
        {
          participantId: participant(4),
          outcome: 'WALKOVER_LOSS',
          primaryMark: markOf(PADEL_DV, 'setsWon', '0'),
        },
      ],
      performances: [
        { participantId: participant(1), ordinal: 1, mark: markOf(PADEL_DV, 'gamesWon', '0') },
        { participantId: participant(4), ordinal: 1, mark: markOf(PADEL_DV, 'gamesWon', '0') },
      ],
    });
    const o = derive(padelInput([...padelGroup(), walkover])).outcome;
    expect(o.state).toBe('BLOCKED');
    expect(o.blockers).toEqual(['POLICY_UNSUPPORTED']);
    expect(o.participants.map((p) => p.participantId)).toEqual([participant(1), participant(4)]);
    // Declaring a subset is allowed; only outcomes actually encountered need points.
    const declared = derive(
      padelInput([...padelGroup(), walkover], {
        outcomePoints: [
          { outcome: 'WIN', points: 3 },
          { outcome: 'DRAW', points: 1 },
          { outcome: 'LOSS', points: 0 },
          { outcome: 'WALKOVER_WIN', points: 3 },
          { outcome: 'WALKOVER_LOSS', points: 0 },
        ],
      }),
    ).outcome;
    expect(declared.state).toBe('PROPOSED');
  });

  it('41. points aggregation is deterministic: negative points and any match order', () => {
    const pts = [
      { outcome: 'WIN', points: 2 },
      { outcome: 'DRAW', points: 0 },
      { outcome: 'LOSS', points: -1 },
    ];
    const a = derive(padelInput(padelGroup(), { outcomePoints: pts }));
    const b = derive(padelInput([...padelGroup()].reverse(), { outcomePoints: pts }));
    expect(a.outcomeHash).toBe(b.outcomeHash);
    expect(table(a.outcome).map((r) => [r[0], (r[3] as string[])[0]])).toEqual([
      [3, '2'],
      [1, '1'],
      [2, '1'],
      [4, '-1'],
    ]);
  });
});

describe('classification proposal: provenance, determinism, corrections', () => {
  const base = () => derive(padelInput());

  it('42. the proposal pins its derivation (ADR-0047 derivedFrom, policy, DV, engine, inputs digest)', () => {
    const r = base();
    const d = r.outcome.proposal?.content.derivation;
    expect(d?.derivedFrom.map((x) => x.resultVersionId)).toEqual(
      padelGroup().map((m) => m.resultVersionId),
    );
    expect(d?.derivedFrom.every((x) => x.status === 'PROVISIONAL')).toBe(true);
    expect(d?.disciplineVersionId).toBe(rkId(1));
    expect(d?.inputsDigest).toBe(r.inputsDigest);
    // No source Result JSON is copied: only exact pins and the comparator trace.
    const text = JSON.stringify(r.outcome.proposal?.content);
    expect(text).not.toContain('padel.games_won');
    expect(text).not.toContain('"performances"');
  });

  it('43. source content hashes are preserved exactly, and re-verified', () => {
    const inputs = padelGroup();
    const d = derive(padelInput(inputs)).outcome.proposal?.content.derivation;
    expect(d?.derivedFrom.map((x) => x.contentHash)).toEqual(inputs.map((i) => i.contentHash));
    const [first, ...rest] = inputs;
    if (first === undefined) throw new Error('fixture');
    const tampered = { ...first, contentHash: `sha256:${'0'.repeat(64)}` };
    const o = derive(padelInput([tampered, ...rest])).outcome;
    expect(o.inputs.find((i) => i.resultVersionId === first.resultVersionId)).toEqual({
      resultVersionId: first.resultVersionId,
      state: 'EXCLUDED',
      reasons: ['CLASSIFICATION_INPUT_INADMISSIBLE', 'CONTENT_HASH_MISMATCH'],
    });
    expect(o.blockers).toContain('CLASSIFICATION_INPUT_MISSING');
  });

  it('44. the policy spec hash is preserved (and a forged one is refused)', () => {
    const input = padelInput();
    const o = derive(input).outcome;
    expect(o.proposal?.content.derivation.policy).toEqual({
      policyId: input.policy.policyId,
      policyVersionId: input.policy.policyVersionId,
      specHash: input.policy.specHash,
    });
    const forged = derive({
      ...input,
      policy: { ...input.policy, specHash: `sha256:${'0'.repeat(64)}` },
    }).outcome;
    expect(forged.blockers).toEqual(['SPEC_HASH_MISMATCH']);
  });

  it('45. the engine version is preserved in the outcome and the content', () => {
    const o = base().outcome;
    expect(CLASSIFICATION_ENGINE_VERSION).toBe('classification-engine/1');
    expect(o.engineVersion).toBe(CLASSIFICATION_ENGINE_VERSION);
    expect(o.proposal?.content.derivation.engineVersion).toBe(CLASSIFICATION_ENGINE_VERSION);
  });

  it('46. identical input ⇒ byte-identical classification and hashes', () => {
    const a = base();
    const b = derive(JSON.parse(JSON.stringify(padelInput())));
    expect(a.inputsDigest).toBe(b.inputsDigest);
    expect(a.outcomeHash).toBe(b.outcomeHash);
    expect(a.outcome.proposal?.contentHash).toBe(b.outcome.proposal?.contentHash);
    expect(JSON.stringify(a.outcome)).toBe(JSON.stringify(b.outcome));
  });

  it('47. trigger metadata never changes the semantic result (and is not an input member)', () => {
    const input = padelInput();
    const a = derive(input, { trigger: 'UPSTREAM_FACT_CHANGED' });
    const b = derive(input, { trigger: 'STAFF_REQUEST' });
    expect(a.outcomeHash).toBe(b.outcomeHash);
    expect(a.outcome).toEqual(b.outcome);
    expect(JSON.stringify(a.outcome)).not.toContain('UPSTREAM_FACT_CHANGED');
    expect(deriveClassification({ ...input, trigger: 'STAFF_REQUEST' })).toEqual({
      ok: false,
      issues: [{ path: '/trigger', code: 'BRJ_UNKNOWN_FIELD' }],
    });
  });

  it('48. correction dependency: impact is computed from pins; a replacement is new content, blocked', () => {
    const before = base().outcome.proposal;
    if (before === undefined) throw new Error('fixture must propose');
    const frozen = JSON.stringify(before);
    const deps = classificationDependencies(before.content);
    if (!deps.ok) throw new Error('derived content must expose its dependencies');
    const corrected = padelGroup()[1];
    if (corrected === undefined) throw new Error('fixture');
    const current = new Map(deps.derivation.derivedFrom.map((p) => [p.resultVersionId, true]));
    current.set(corrected.resultVersionId, false);
    expect(classificationCorrectionImpact(deps.derivation, current)).toEqual([
      {
        resultVersionId: corrected.resultVersionId,
        contentHash: corrected.contentHash,
        status: 'PROVISIONAL',
      },
    ]);
    // Unknown currency never counts as fresh.
    expect(classificationCorrectionImpact(deps.derivation, new Map())).toHaveLength(4);
    // The corrected input is a NEW version: still pinned, so the old version must not be admitted…
    const superseded = { ...corrected, supersededByVersionId: rkId(1199), status: 'SUPERSEDED' };
    const stale = derive(
      padelInput(
        padelGroup().map((m) => (m.resultVersionId === corrected.resultVersionId ? superseded : m)),
      ),
    ).outcome;
    expect(stale.blockers).toEqual([
      'CLASSIFICATION_INPUT_INADMISSIBLE',
      'CLASSIFICATION_INPUT_MISSING',
      'RESULT_SUPERSEDED',
    ]);
    // …and the replacement version derives NEW content with intact lineage, blocked from the ledger.
    const replacement = padelMatch(2, 3, 4, [2, 0, 12, 4], { resultVersionId: rkId(1199) });
    const after = derive(
      padelInput(
        padelGroup().map((m) => (m.contestId === replacement.contestId ? replacement : m)),
      ),
    ).outcome.proposal;
    if (after === undefined) throw new Error('replacement must derive');
    expect(after.contentHash).not.toBe(before.contentHash);
    expect(after.content.derivation.derivedFrom.map((x) => x.resultVersionId)).toContain(
      rkId(1199),
    );
    expect(
      assessClassificationReplacement(after.contentHash, {
        resultVersionId: rkId(9000),
        contentHash: before.contentHash,
      }),
    ).toEqual({
      state: 'REPLACEMENT_BLOCKED',
      reasons: ['CLASSIFICATION_REPLACEMENT_REQUIRES_CORRECTION'],
      replaces: rkId(9000),
    });
    expect(
      assessClassificationReplacement(before.contentHash, {
        resultVersionId: rkId(9000),
        contentHash: before.contentHash,
      }).state,
    ).toBe('IDENTICAL_TO_CURRENT');
    expect(assessClassificationReplacement(after.contentHash).state).toBe('NO_CURRENT_VERSION');
    expect(JSON.stringify(before)).toBe(frozen); // the old proposal is never mutated
    // Legacy @1 classification content is never treated as derived.
    expect(classificationDependencies({ entries: before.content.entries })).toEqual({
      ok: false,
      code: 'CLASSIFICATION_PROVENANCE_UNAVAILABLE',
    });
  });

  it('49. the proposal is `@2` ResultVersion content — never a RankingSnapshot', () => {
    const p = base().outcome.proposal;
    const c = platformCanonicalizer();
    const asResult = c.hashCanonical(
      'result-version-content',
      SchemaRef.resultVersionContentV2.id,
      SchemaRef.resultVersionContentV2.version,
      p?.content,
    );
    expect(asResult.contentHash).toBe(p?.contentHash);
    expect(() =>
      c.hashCanonical(
        'ranking-snapshot',
        SchemaRef.rankingSnapshot.id,
        SchemaRef.rankingSnapshot.version,
        p?.content,
      ),
    ).toThrow();
    expect(p?.content.entries.every((e) => e.outcome === 'RANKED')).toBe(true);
  });

  it('inputs: status floor, scope, duplicates and missing contests are all accounted for', () => {
    const [m1, m2, m3, m4] = padelGroup();
    if (!m1 || !m2 || !m3 || !m4) throw new Error('fixture');
    const o = derive(
      padelInput([
        { ...m1, status: 'SUBMITTED' },
        { ...m2, scopeType: 'ROUND_CLASSIFICATION' },
        m3,
        { ...m4, resultVersionId: rkId(1150) },
        m4,
      ]),
    ).outcome;
    expect(o.inputs.map((i) => [i.resultVersionId, i.state, i.reasons])).toEqual([
      [
        m1.resultVersionId,
        'EXCLUDED',
        ['CLASSIFICATION_INPUT_INADMISSIBLE', 'RESULT_STATUS_BELOW_REQUIRED'],
      ],
      [
        m2.resultVersionId,
        'EXCLUDED',
        ['CLASSIFICATION_INPUT_INADMISSIBLE', 'RESULT_SCOPE_MISMATCH'],
      ],
      [m3.resultVersionId, 'ADMITTED', []],
      [m4.resultVersionId, 'EXCLUDED', ['CLASSIFICATION_INPUT_INADMISSIBLE']],
      [rkId(1150), 'EXCLUDED', ['CLASSIFICATION_INPUT_INADMISSIBLE']],
    ]);
    expect(o.missingContestIds).toEqual([m1.contestId, m2.contestId, m4.contestId].sort());
    expect(o.state).toBe('BLOCKED');
    // A raised policy floor is honoured (OFFICIAL inputs required).
    const raised = derive(padelInput(padelGroup(), { minimumInputStatus: 'OFFICIAL' })).outcome;
    expect(raised.blockers).toContain('RESULT_STATUS_BELOW_REQUIRED');
  });

  it('50. the engine is pure: no persistence, I/O, clock, randomness or environment', () => {
    const dir = new URL('.', import.meta.url);
    const sources = readdirSync(dir).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'fixtures.ts',
    );
    expect(sources).toContain('classification-engine.ts');
    expect(sources).toContain('ranking-engine.ts');
    for (const f of sources) {
      const text = readFileSync(new URL(f, dir), 'utf8');
      for (const banned of [
        /from ['"]node:fs/,
        /from ['"]pg['"]/,
        /@br\/persistence/,
        /process\.env/,
        /Date\.now\(/,
        /new Date\(\)/,
        /Math\.random/,
        /randomUUID/,
        /fetch\(/,
      ])
        expect(`${f}: ${banned.test(text)}`).toBe(`${f}: false`);
    }
    const pkg = JSON.parse(readFileSync(new URL('../package.json', dir), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies)).not.toContain('@br/persistence');
    // A frozen input is evaluated without mutation.
    const input = padelInput();
    const deepFreeze = (o: unknown): unknown => {
      if (typeof o === 'object' && o !== null) {
        Object.values(o).forEach(deepFreeze);
        Object.freeze(o);
      }
      return o;
    };
    expect(derive(deepFreeze(input)).outcome.state).toBe('PROPOSED');
  });
});
