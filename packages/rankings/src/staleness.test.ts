import { describe, expect, it } from 'vitest';
import {
  assessClassificationReplacement,
  classificationCorrectionImpact,
  classificationDependencies,
  classificationStalePayload,
  classificationStaleness,
  deriveClassification,
  evaluateRankingRun,
  hashClassificationStaleness,
  rankingSnapshotDependencies,
  rankingSnapshotStaleness,
  type ClassificationDerivation,
  type ClassificationPin,
} from './index';
import {
  classificationInput,
  padelGroup,
  padelMatch,
  PADEL_DV,
  policySpec,
  rankCandidate,
  rankingRunInput,
  rkHash,
  rkId,
} from './fixtures';

/**
 * BRT-10 Step 7 — computed staleness, dependencies and correction impact (ADR-0047 §5–6, ADR-0048 §8).
 * REFERENCE ENGINE FIXTURES — NOT PERSISTED SPORTING TRUTH (fictional ids and values).
 */
const padelPolicy = policySpec(PADEL_DV, ['SUM', 'SUM'], ['ENTRY_PRIMARY_MARK', 'PERFORMANCE']);

function proposal(inputs: readonly { contestId: string }[] = padelGroup()) {
  const r = deriveClassification(classificationInput(PADEL_DV, padelPolicy, inputs));
  if (!r.ok || r.outcome.proposal === undefined) throw new Error('fixture must propose');
  return r.outcome.proposal;
}
const derivationOf = (content: unknown): ClassificationDerivation => {
  const d = classificationDependencies(content);
  if (!d.ok) throw new Error('fixture content must expose its dependencies');
  return d.derivation;
};
const ids = (pins: readonly { resultVersionId: string }[]) => pins.map((p) => p.resultVersionId);
const allCurrent = (d: ClassificationDerivation) =>
  new Map(d.derivedFrom.map((p) => [p.resultVersionId, true]));
const pinsOf = (d: ClassificationDerivation): ClassificationPin[] =>
  d.derivedFrom.map((p) => ({ resultVersionId: p.resultVersionId, contentHash: p.contentHash }));
const version = (contentHash: string) => ({ resultVersionId: rkId(9000), contentHash });

describe('classificationDependencies(content): exact pins from the canonical content only', () => {
  const p = proposal();

  it('1. one classification with one dependency', () => {
    const single = proposal([padelMatch(1, 1, 2, [2, 0, 12, 5])]);
    expect(ids(derivationOf(single.content).derivedFrom)).toEqual([rkId(1101)]);
  });

  it('2. multiple dependencies: exactly every pinned input, sorted', () => {
    const d = derivationOf(p.content);
    expect(ids(d.derivedFrom)).toEqual([rkId(1101), rkId(1102), rkId(1103), rkId(1104)]);
    expect(d.derivedFrom.map((x) => x.status)).toEqual(Array(4).fill('PROVISIONAL'));
  });

  it('3. repeated / reordered references: order is irrelevant, a repeated pin is refused (never merged)', () => {
    const c = structuredClone(p.content) as unknown as { derivation: { derivedFrom: object[] } };
    c.derivation.derivedFrom.reverse();
    expect(derivationOf(c)).toEqual(derivationOf(p.content));
    const first = c.derivation.derivedFrom[0];
    c.derivation.derivedFrom.push({ ...(first as object) });
    expect(classificationDependencies(c)).toEqual({
      ok: false,
      code: 'CLASSIFICATION_PROVENANCE_UNAVAILABLE',
    });
  });

  it('4. deterministic: the same content yields byte-identical dependencies', () => {
    const a = classificationDependencies(p.content);
    const b = classificationDependencies(JSON.parse(JSON.stringify(p.content)));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('5. malformed or incomplete provenance is never partially read', () => {
    /** `@2` content as a test may tamper with it (members optional so they can be deleted). */
    interface Tamperable {
      derivation: {
        inputsDigest?: string;
        derivedFrom: { contentHash?: string; status?: string }[];
        policy: object;
        isStale?: boolean;
      };
    }
    const variants: ((c: Tamperable) => void)[] = [
      (c) => delete c.derivation.inputsDigest,
      (c) => delete c.derivation.derivedFrom[0]?.contentHash,
      (c) => Object.assign(c.derivation.derivedFrom[0] ?? {}, { contentHash: 'not-a-hash' }),
      (c) => Object.assign(c.derivation.derivedFrom[0] ?? {}, { status: 'SUBMITTED' }),
      (c) => (c.derivation.derivedFrom = []),
      (c) => (c.derivation.isStale = false),
      (c) => (c.derivation.policy = {}),
    ];
    for (const mutate of variants) {
      const c = structuredClone(p.content) as unknown as Tamperable;
      mutate(c);
      expect(classificationDependencies(c)).toEqual({
        ok: false,
        code: 'CLASSIFICATION_PROVENANCE_UNAVAILABLE',
      });
    }
  });

  it('6. provenance unavailable: `@1` content, or no content at all', () => {
    for (const c of [{ entries: p.content.entries }, undefined, null, 'x', []])
      expect(classificationDependencies(c)).toEqual({
        ok: false,
        code: 'CLASSIFICATION_PROVENANCE_UNAVAILABLE',
      });
  });

  it('7. no unrelated inputs: only the pinned ResultVersions — never the policy, DV, scope or entries', () => {
    const d = derivationOf(p.content);
    const unrelated = [
      rkId(20),
      rkId(21),
      rkId(30),
      ...p.content.entries.map((e) => e.participantId),
    ];
    expect(ids(d.derivedFrom).some((x) => unrelated.includes(x))).toBe(false);
    // A second, unrelated classification shares nothing with this one.
    const other = derivationOf(proposal([padelMatch(9, 5, 6, [2, 0, 12, 1])]).content);
    expect(ids(other.derivedFrom)).toEqual([rkId(1109)]);
  });
});

describe('classificationCorrectionImpact(derivation, current): analytical, never a correction', () => {
  const p = proposal();
  const d = derivationOf(p.content);

  it('A. every dependency current ⇒ no impact', () => {
    expect(classificationCorrectionImpact(d, allCurrent(d))).toEqual([]);
  });

  it('B–C. exactly the pins that are no longer current (unchanged pins omitted)', () => {
    const one = allCurrent(d).set(rkId(1102), false);
    expect(ids(classificationCorrectionImpact(d, one))).toEqual([rkId(1102)]);
    const two = allCurrent(d).set(rkId(1104), false).set(rkId(1101), false);
    expect(classificationCorrectionImpact(d, two)).toEqual(
      d.derivedFrom.filter((x) => [rkId(1101), rkId(1104)].includes(x.resultVersionId)),
    );
  });

  it('D. an unrelated changed result has no impact', () => {
    expect(classificationCorrectionImpact(d, allCurrent(d).set(rkId(7777), false))).toEqual([]);
  });

  it('E. unknown current state counts as affected (fail closed)', () => {
    expect(classificationCorrectionImpact(d, new Map())).toHaveLength(4);
    const partial = allCurrent(d);
    partial.delete(rkId(1103));
    expect(ids(classificationCorrectionImpact(d, partial))).toEqual([rkId(1103)]);
  });

  it('F–G. deterministic order whatever the pin order; repeated references never repeat an impact', () => {
    const shuffled: ClassificationDerivation = {
      ...d,
      derivedFrom: [...d.derivedFrom].reverse().concat(d.derivedFrom),
    };
    expect(classificationCorrectionImpact(shuffled, new Map())).toEqual(
      classificationCorrectionImpact(d, new Map()),
    );
    expect(ids(classificationCorrectionImpact(shuffled, new Map()))).toEqual(ids(d.derivedFrom));
  });

  it('17. the historical version is never mutated by impact or staleness', () => {
    const frozen = JSON.stringify(p);
    classificationCorrectionImpact(d, new Map());
    classificationStaleness(version(p.contentHash), d, { current: new Map(), admissible: [] });
    expect(JSON.stringify(p)).toBe(frozen);
  });
});

describe('classificationStaleness(version, derivation, observed): computed, never stored', () => {
  const p = proposal();
  const d = derivationOf(p.content);
  const v = version(p.contentHash);
  const replacement = { resultVersionId: rkId(1199), contentHash: rkHash('e') };
  const newContest = { resultVersionId: rkId(1105), contentHash: rkHash('f') };

  it('1. all dependencies current and the admissible set unchanged ⇒ not stale', () => {
    expect(
      classificationStaleness(v, d, { current: allCurrent(d), admissible: pinsOf(d) }),
    ).toEqual({
      state: 'CURRENT',
    });
  });

  it('2. one pinned input no longer current ⇒ STALE (its successor appears as added)', () => {
    const s = classificationStaleness(v, d, {
      current: allCurrent(d).set(rkId(1102), false),
      admissible: [...pinsOf(d).filter((x) => x.resultVersionId !== rkId(1102)), replacement],
    });
    if (s.state !== 'STALE') throw new Error('must be stale');
    expect(s.document.reasons).toEqual([
      'ADMISSIBLE_INPUT_SET_CHANGED',
      'PINNED_INPUT_NOT_CURRENT',
    ]);
    expect(ids(s.document.notCurrent)).toEqual([rkId(1102)]);
    expect(s.document.added).toEqual([replacement]);
    // A non-current pin is reported once (impact), never again as `removed`.
    expect(s.document.removed).toEqual([]);
  });

  it('3. several non-current pins are all reported', () => {
    const s = classificationStaleness(v, d, {
      current: allCurrent(d).set(rkId(1101), false).set(rkId(1103), false),
      admissible: pinsOf(d),
    });
    expect(s.state === 'STALE' && ids(s.document.notCurrent)).toEqual([rkId(1101), rkId(1103)]);
  });

  it('4. an unrelated changed result ⇒ not stale', () => {
    expect(
      classificationStaleness(v, d, {
        current: allCurrent(d).set(rkId(7777), false),
        admissible: pinsOf(d),
      }).state,
    ).toBe('CURRENT');
  });

  it('5. changed admissible set ⇒ STALE (a new admissible input, or a pin no longer admissible)', () => {
    const grown = classificationStaleness(v, d, {
      current: allCurrent(d),
      admissible: [...pinsOf(d), newContest],
    });
    if (grown.state !== 'STALE') throw new Error('must be stale');
    expect(grown.document.reasons).toEqual(['ADMISSIBLE_INPUT_SET_CHANGED']);
    expect(grown.document.added).toEqual([newContest]);
    const shrunk = classificationStaleness(v, d, {
      current: allCurrent(d),
      admissible: pinsOf(d).slice(1),
    });
    expect(shrunk.state === 'STALE' && ids(shrunk.document.removed)).toEqual([rkId(1101)]);
  });

  it('6. unknown current state ⇒ affected (fail closed)', () => {
    const unknownSet = classificationStaleness(v, d, {
      current: allCurrent(d),
      admissible: undefined,
    });
    expect(unknownSet.state === 'STALE' && unknownSet.document.reasons).toEqual([
      'ADMISSIBLE_INPUT_SET_UNKNOWN',
    ]);
    const unknownPins = classificationStaleness(v, d, {
      current: new Map(),
      admissible: pinsOf(d),
    });
    expect(unknownPins.state === 'STALE' && unknownPins.document.notCurrent).toHaveLength(4);
  });

  it('7 & 22. deterministic: observation order is irrelevant; the digest re-hashes; distinct states differ', () => {
    const observe = (reverse: boolean) => {
      const current = allCurrent(d).set(rkId(1102), false);
      const admissible = [newContest, ...pinsOf(d)];
      return classificationStaleness(v, d, {
        current: reverse ? new Map([...current].reverse()) : current,
        admissible: reverse ? [...admissible].reverse() : admissible,
      });
    };
    const a = observe(false);
    const b = observe(true);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    if (a.state !== 'STALE') throw new Error('must be stale');
    const again = hashClassificationStaleness(a.document);
    expect(again.ok && again.hash).toBe(a.staleDigest);
    const other = classificationStaleness(v, d, { current: allCurrent(d), admissible: undefined });
    expect(other.state === 'STALE' && other.staleDigest).not.toBe(a.staleDigest);
    // The digest is bound to the exact version: another version in the same state differs.
    const elsewhere = classificationStaleness({ ...v, resultVersionId: rkId(9001) }, d, {
      current: allCurrent(d).set(rkId(1102), false),
      admissible: [newContest, ...pinsOf(d)],
    });
    expect(elsewhere.state === 'STALE' && elsewhere.staleDigest).not.toBe(a.staleDigest);
  });

  it('23–24. same version + same stale state ⇒ the same event identity and payload (idempotent)', () => {
    const observed = { current: allCurrent(d), admissible: [...pinsOf(d), newContest] };
    const a = classificationStaleness(v, d, observed);
    const b = classificationStaleness(v, structuredClone(d), structuredClone(observed));
    if (a.state !== 'STALE' || b.state !== 'STALE') throw new Error('must be stale');
    expect(classificationStalePayload(rkId(9100), a)).toEqual(
      classificationStalePayload(rkId(9100), b),
    );
    expect(classificationStalePayload(rkId(9100), a)).toEqual({
      resultId: rkId(9100),
      classificationVersionId: v.resultVersionId,
      contentHash: v.contentHash,
      inputsDigest: d.inputsDigest,
      staleDigest: a.staleDigest,
      reasons: ['ADMISSIBLE_INPUT_SET_CHANGED'],
      notCurrent: [],
      added: [rkId(1105)],
      removed: [],
    });
  });

  it('a status upgrade of a pinned input (same version) is neither impact nor a set change', () => {
    const upgraded: ClassificationDerivation = {
      ...d,
      derivedFrom: d.derivedFrom.map((x) => ({ ...x, status: 'OFFICIAL' as const })),
    };
    expect(
      classificationStaleness(v, upgraded, { current: allCurrent(d), admissible: pinsOf(d) }).state,
    ).toBe('CURRENT');
  });

  it('the staleness document carries no status, no stored-staleness flag and no content', () => {
    const s = classificationStaleness(v, d, { current: new Map(), admissible: undefined });
    const text = JSON.stringify(s);
    for (const forbidden of ['"isStale"', '"stale"', '"status"', '"entries"', 'PROVISIONAL'])
      expect(text).not.toContain(forbidden);
  });

  it('21. an affected classification is identified but never replaced: replacement stays blocked', () => {
    const corrected = padelMatch(2, 3, 4, [2, 0, 12, 4], { resultVersionId: rkId(1199) });
    const after = proposal(
      padelGroup().map((m) => (m.contestId === corrected.contestId ? corrected : m)),
    );
    const s = classificationStaleness(v, d, {
      current: allCurrent(d).set(rkId(1102), false),
      admissible: pinsOf(derivationOf(after.content)),
    });
    expect(s.state).toBe('STALE');
    expect(assessClassificationReplacement(after.contentHash, v)).toEqual({
      state: 'REPLACEMENT_BLOCKED',
      reasons: ['CLASSIFICATION_REPLACEMENT_REQUIRES_CORRECTION'],
      replaces: v.resultVersionId,
    });
    expect(assessClassificationReplacement(p.contentHash, v).state).toBe('IDENTICAL_TO_CURRENT');
  });
});

describe('ranking snapshots: dependencies and read-time STALE (ADR-0048 §8)', () => {
  const run = evaluateRankingRun(
    rankingRunInput([
      rankCandidate(1, 1, '900000'),
      rankCandidate(2, 2, '900000'),
      rankCandidate(3, 3, '905000'),
      rankCandidate(5, 3, '905000'),
    ]),
  );
  if (!run.ok) throw new Error('fixture run must evaluate');
  const content = { entries: run.outcome.entries };
  const pins = rankingSnapshotDependencies(content);
  const fresh = () => ({
    result: new Map(pins.map((x) => [x.resultVersionId, true])),
    verification: new Map<string, string | undefined>(
      pins.map((x) => [x.resultVersionId, x.verificationRunId]),
    ),
  });

  it('dependencies: one pin per (ResultVersion, VerificationRun), every basis, sorted', () => {
    expect(pins).toHaveLength(4);
    const basis = content.entries.flatMap((e) => e.basis.map((b) => b.resultVersionId)).sort();
    expect(pins.map((x) => x.resultVersionId)).toEqual(basis);
    expect(rankingSnapshotDependencies({ entries: [...content.entries].reverse() })).toEqual(pins);
  });

  it('every pin current ⇒ CURRENT; a superseded basis or a replaced run ⇒ STALE with exactly that pin', () => {
    expect(rankingSnapshotStaleness(content, fresh()).state).toBe('CURRENT');
    const [first, second] = pins;
    if (first === undefined || second === undefined) throw new Error('fixture');
    const o = fresh();
    o.result.set(first.resultVersionId, false);
    o.verification.set(second.resultVersionId, rkId(4242));
    const s = rankingSnapshotStaleness(content, o);
    expect(s).toEqual({
      state: 'STALE',
      reasons: ['BASIS_RESULT_NOT_CURRENT', 'BASIS_VERIFICATION_NOT_CURRENT'],
      affected: [
        { ...first, reasons: ['BASIS_RESULT_NOT_CURRENT'] },
        { ...second, reasons: ['BASIS_VERIFICATION_NOT_CURRENT'] },
      ],
    });
  });

  it('unknown state is affected (fail closed); unrelated changes are not', () => {
    const s = rankingSnapshotStaleness(content, { result: new Map(), verification: new Map() });
    expect(s.state === 'STALE' && s.affected).toHaveLength(4);
    const o = fresh();
    o.result.set(rkId(7777), false);
    expect(rankingSnapshotStaleness(content, o).state).toBe('CURRENT');
  });
});
