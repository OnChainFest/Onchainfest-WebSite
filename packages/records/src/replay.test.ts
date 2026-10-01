import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareDecimal } from '@br/achievements';
import { replayRecordHistory, type ReplayInput, type ReplayMark } from './replay';
import { rfxId, rfxTime } from './fixtures';

/** REFERENCE ENGINE FIXTURES — NOT PERSISTED SPORTING TRUTH. */
const mark = (
  label: string,
  value: string,
  minute: number,
  valid = true,
  seq = minute,
): ReplayMark => ({
  recordMarkId: rfxId(`mark:${label}`),
  value: { metricId: 'athletics.100m.time', value, unit: 'ms', precision: 0 },
  effectiveFrom: rfxTime(minute),
  ratifiedSeq: seq,
  standing: 'RATIFIED',
  valid,
});
const run = (
  marks: ReplayMark[],
  tiePolicy: 'SHARED' | 'FIRST_ACHIEVED' = 'SHARED',
  comparator: 'LOWER_IS_BETTER' | 'HIGHER_IS_BETTER' = 'LOWER_IS_BETTER',
): ReturnType<typeof replayRecordHistory> =>
  replayRecordHistory({ categoryId: rfxId('cat'), tiePolicy, comparator, marks });
const id = (label: string) => rfxId(`mark:${label}`);
const stateOf = (r: ReturnType<typeof run>, label: string) =>
  r.marks.find((m) => m.recordMarkId === id(label));

describe('chronological record replay (RC-1…RC-3)', () => {
  it('A (10.0) → B (9.8) → C (9.7): C current; effective periods end at the successor', () => {
    const r = run([mark('A', '10000', 1), mark('B', '9800', 2), mark('C', '9700', 3)]);
    expect(r.current).toEqual([id('C')]);
    expect(stateOf(r, 'A')).toMatchObject({ effectiveTo: rfxTime(2), supersededBy: id('B') });
    expect(stateOf(r, 'B')).toMatchObject({ effectiveTo: rfxTime(3), supersededBy: id('C') });
  });

  it('rescind C ⇒ B restored; rescind B too ⇒ A restored (history replayed, never a pointer)', () => {
    expect(
      run([mark('A', '10000', 1), mark('B', '9800', 2), mark('C', '9700', 3, false)]).current,
    ).toEqual([id('B')]);
    const r = run([
      mark('A', '10000', 1),
      mark('B', '9800', 2, false),
      mark('C', '9700', 3, false),
    ]);
    expect(r.current).toEqual([id('A')]);
    expect(stateOf(r, 'A')).toMatchObject({ current: true });
  });

  it('A, B, C, D with B and D invalidated ⇒ C current from surviving history', () => {
    const r = run([
      mark('A', '10000', 1),
      mark('B', '9900', 2, false),
      mark('C', '9800', 3),
      mark('D', '9700', 4, false),
    ]);
    expect(r.current).toEqual([id('C')]);
    expect(stateOf(r, 'A')).toMatchObject({ effectiveTo: rfxTime(3), supersededBy: id('C') });
  });

  it('rescinding a non-current intermediate mark leaves an independently valid current mark', () => {
    const r = run([mark('A', '10000', 1), mark('B', '9800', 2, false), mark('C', '9700', 3)]);
    expect(r.current).toEqual([id('C')]);
    expect(stateOf(r, 'A')).toMatchObject({ supersededBy: id('C'), effectiveTo: rfxTime(3) });
  });

  it('SHARED: A and B at exactly 10.90 are co-current; C at 10.80 supersedes both', () => {
    const tie = run([mark('A', '10900', 1), mark('B', '10900', 2)]);
    expect(tie.current).toEqual([id('A'), id('B')].sort());
    const next = run([mark('A', '10900', 1), mark('B', '10900', 2), mark('C', '10800', 3)]);
    expect(next.current).toEqual([id('C')]);
    expect(stateOf(next, 'A')).toMatchObject({ supersededBy: id('C') });
    expect(stateOf(next, 'B')).toMatchObject({ supersededBy: id('C') });
  });

  it('FIRST_ACHIEVED: an equal later mark never becomes current', () => {
    const r = run([mark('A', '10900', 1), mark('B', '10900', 2)], 'FIRST_ACHIEVED');
    expect(r.current).toEqual([id('A')]);
    expect(stateOf(r, 'B')).toMatchObject({ held: false, cause: 'EQUAL_FIRST_ACHIEVED' });
  });

  it('a late-ratified intermediate mark is placed at its sporting time (RC-2 effectiveTo = successor effectiveFrom)', () => {
    const r = run([
      mark('A', '10000', 1, true, 1),
      mark('B', '9800', 3, true, 2),
      mark('C', '9900', 2, true, 3),
    ]);
    expect(r.current).toEqual([id('B')]);
    expect(stateOf(r, 'A')).toMatchObject({ effectiveTo: rfxTime(2), supersededBy: id('C') });
    expect(stateOf(r, 'C')).toMatchObject({
      held: true,
      effectiveTo: rfxTime(3),
      supersededBy: id('B'),
    });
  });

  it('HIGHER_IS_BETTER replays the other way round', () => {
    const r = run(
      [mark('A', '700', 1), mark('B', '710', 2), mark('C', '705', 3)],
      'SHARED',
      'HIGHER_IS_BETTER',
    );
    expect(r.current).toEqual([id('B')]);
    expect(stateOf(r, 'C')).toMatchObject({ held: false, cause: 'NOT_BETTER' });
  });
});

// ───────────────────────────── properties ─────────────────────────────

const arbMarks = fc
  .array(
    fc.record({
      v: fc.integer({ min: 9000, max: 9010 }),
      t: fc.integer({ min: 0, max: 40 }),
      valid: fc.boolean(),
    }),
    { minLength: 0, maxLength: 12 },
  )
  .map((xs) => xs.map((x, i) => mark(`p${i}`, String(x.v), x.t, x.valid, i)));
const arbInput = fc.record({
  marks: arbMarks,
  tiePolicy: fc.constantFrom('SHARED' as const, 'FIRST_ACHIEVED' as const),
  comparator: fc.constantFrom('LOWER_IS_BETTER' as const, 'HIGHER_IS_BETTER' as const),
});
const valueOf = (input: ReplayInput, markId: string) =>
  input.marks.find((m) => m.recordMarkId === markId)?.value.value ?? '';

describe('replay properties', () => {
  const full = (x: {
    marks: ReplayMark[];
    tiePolicy: 'SHARED' | 'FIRST_ACHIEVED';
    comparator: 'LOWER_IS_BETTER' | 'HIGHER_IS_BETTER';
  }): ReplayInput => ({
    categoryId: rfxId('cat'),
    ...x,
  });

  it('input order never changes the replay hash or the result', () => {
    fc.assert(
      fc.property(arbInput, (x) => {
        const a = replayRecordHistory(full(x));
        const b = replayRecordHistory(full({ ...x, marks: [...x.marks].reverse() }));
        expect(a.replayHash).toBe(b.replayHash);
        expect(a.current).toEqual(b.current);
      }),
    );
  });

  it('current holders share one exact value; FIRST_ACHIEVED has at most one holder', () => {
    fc.assert(
      fc.property(arbInput, (x) => {
        const input = full(x);
        const r = replayRecordHistory(input);
        const values = new Set(r.current.map((m) => valueOf(input, m)));
        expect(values.size <= 1).toBe(true);
        if (x.tiePolicy === 'FIRST_ACHIEVED') expect(r.current.length <= 1).toBe(true);
      }),
    );
  });

  it('a worse value can never be current: the current value is the best valid value', () => {
    fc.assert(
      fc.property(arbInput, (x) => {
        const input = full(x);
        const r = replayRecordHistory(input);
        const valid = input.marks.filter((m) => m.valid).map((m) => m.value.value);
        if (valid.length === 0) {
          expect(r.current).toEqual([]);
          return;
        }
        const best = valid.reduce((a, b) =>
          (
            x.comparator === 'HIGHER_IS_BETTER'
              ? compareDecimal(b, a) > 0
              : compareDecimal(b, a) < 0
          )
            ? b
            : a,
        );
        expect(compareDecimal(valueOf(input, r.current[0] ?? ''), best)).toBe(0);
      }),
    );
  });

  it('invalidating a non-current mark never changes the current record; replay is deterministic', () => {
    fc.assert(
      fc.property(arbInput, fc.nat(), (x, k) => {
        const input = full(x);
        const r = replayRecordHistory(input);
        const nonCurrent = input.marks.filter(
          (m) => m.valid && !r.current.includes(m.recordMarkId),
        );
        const target = nonCurrent[k % Math.max(1, nonCurrent.length)];
        if (target === undefined) return;
        const after = replayRecordHistory({
          ...input,
          marks: input.marks.map((m) =>
            m.recordMarkId === target.recordMarkId ? { ...m, valid: false } : m,
          ),
        });
        expect(after.current).toEqual(r.current);
        expect(replayRecordHistory(input)).toEqual(r);
      }),
    );
  });
});
