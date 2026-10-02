import { fileURLToPath } from 'node:url';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';
import { classificationDependencies, deriveClassification } from '../src/classification-engine';
import { evaluateRankingRun } from '../src/ranking-engine';
import { classificationStaleness, type ClassificationPin } from '../src/staleness';
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
  rankCandidate,
  rkHash,
  rkId,
  rankingRunInput,
  rankingSpec,
  THROWS_DV,
  timeMark,
} from '../src/fixtures';

/**
 * BRT-10 ranking & classification vectors: canonical text + domain-separated hash of ranking system
 * versions, run inputs / outcomes, classification policies, derivation inputs / outcomes and the
 * proposed `@2` classification content — all built from REFERENCE ENGINE FIXTURES (never persisted
 * sporting truth). The independent Python checker re-derives JCS and every hash, the equal / distinct
 * groups, the input → outcome → content bindings, re-hashes every classification input's `@1`
 * content, recomputes holder-best selection, aggregation (SUM / MAX / MIN / outcome points) and the
 * competition-style shared ranks from the committed documents. Staleness vectors (Step 7) commit the
 * `br:classification-staleness@1` document — whose hash is the ClassificationStale idempotency digest —
 * with the observation it was computed from; the checker recomputes the document from the content
 * vector's pins and that observation.
 */
export const VECTORS_FILE = fileURLToPath(
  new URL('../test-vectors/brt-10.vectors.json', import.meta.url),
);

type Kind =
  | 'system'
  | 'runInput'
  | 'runOutcome'
  | 'policy'
  | 'derivationInput'
  | 'derivationOutcome'
  | 'content'
  | 'staleness';
interface Vector {
  readonly name: string;
  readonly kind: Kind;
  readonly domainTag: string;
  readonly schemaId: string;
  readonly schemaVersion: number;
  readonly canonicalText: string;
  readonly hash: string;
  readonly inputVector?: string;
  readonly contentVector?: string;
  readonly expectState?: string;
  readonly stalenessCase?: StalenessCase;
}

/** The observation a staleness document was computed from (`admissible: null` ⇒ unknown). */
interface StalenessCase {
  readonly contentVector: string;
  readonly classificationVersionId: string;
  readonly current: Readonly<Record<string, boolean>>;
  readonly admissible: readonly ClassificationPin[] | null;
}

const REF = {
  system: [DomainTag.rankingSystemVersion, SchemaRef.rankingSystemVersion],
  runInput: [DomainTag.rankingRunInput, SchemaRef.rankingRunInput],
  runOutcome: [DomainTag.rankingRunOutcome, SchemaRef.rankingRunOutcome],
  policy: [DomainTag.classificationPolicy, SchemaRef.classificationPolicy],
  derivationInput: [
    DomainTag.classificationDerivationInput,
    SchemaRef.classificationDerivationInput,
  ],
  derivationOutcome: [
    DomainTag.classificationDerivationOutcome,
    SchemaRef.classificationDerivationOutcome,
  ],
  content: [DomainTag.resultVersionContent, SchemaRef.resultVersionContentV2],
  staleness: [DomainTag.classificationStaleness, SchemaRef.classificationStaleness],
} as const;

function vector(name: string, kind: Kind, doc: unknown, extra: Partial<Vector> = {}): Vector {
  const [tag, schema] = REF[kind];
  const r = platformCanonicalizer().hashCanonical(tag, schema.id, schema.version, doc);
  return {
    name,
    kind,
    domainTag: tag,
    schemaId: schema.id,
    schemaVersion: schema.version,
    canonicalText: r.canonicalText,
    hash: r.contentHash,
    ...extra,
  };
}

const reversed = (v: unknown): unknown =>
  Array.isArray(v)
    ? [...v].reverse().map(reversed)
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .reverse()
            .map(([k, x]) => [k, reversed(x)]),
        )
      : v;

/** Permutes only SET-valued members (inputs, contests, entries, performances) and member order. */
const permutedDerivation = (input: ReturnType<typeof classificationInput>) =>
  Object.fromEntries(
    Object.entries({
      ...input,
      scope: { ...input.scope, contestIds: [...input.scope.contestIds].reverse() },
      inputs: [...(input.inputs as ReturnType<typeof contestInput>[])].reverse().map((i) => ({
        ...i,
        content: {
          entries: [...i.content.entries].reverse(),
          performances: [...(i.content.performances ?? [])].reverse(),
        },
      })),
    }).reverse(),
  );

function ranked(name: string, input: unknown): Vector[] {
  const r = evaluateRankingRun(input);
  if (!r.ok) throw new Error(`vector ${name}: run input refused`);
  return [
    vector(`run-input/${name}`, 'runInput', input),
    vector(`run-outcome/${name}`, 'runOutcome', r.outcome, {
      inputVector: `run-input/${name}`,
      expectState: r.outcome.publication.state,
    }),
  ];
}

function derived(name: string, input: unknown): Vector[] {
  const r = deriveClassification(input);
  if (!r.ok) throw new Error(`vector ${name}: derivation input refused`);
  const p = r.outcome.proposal;
  return [
    vector(`derivation-input/${name}`, 'derivationInput', input),
    ...(p === undefined ? [] : [vector(`content/${name}`, 'content', p.content)]),
    vector(`derivation-outcome/${name}`, 'derivationOutcome', r.outcome, {
      inputVector: `derivation-input/${name}`,
      ...(p === undefined ? {} : { contentVector: `content/${name}` }),
      expectState: r.outcome.state,
    }),
  ];
}

/** Staleness of `content` under one observation: a vector when STALE, a fresh case when CURRENT. */
function stale(
  name: string,
  contentName: string,
  content: unknown,
  contentHash: string,
  observed: Omit<StalenessCase, 'contentVector' | 'classificationVersionId'>,
): { readonly vectors: Vector[]; readonly fresh: StalenessCase[] } {
  const d = classificationDependencies(content);
  if (!d.ok) throw new Error(`vector ${name}: content has no provenance`);
  const c: StalenessCase = {
    contentVector: contentName,
    classificationVersionId: rkId(9000),
    ...observed,
  };
  const s = classificationStaleness(
    { resultVersionId: c.classificationVersionId, contentHash },
    d.derivation,
    {
      current: new Map(Object.entries(c.current)),
      admissible: c.admissible === null ? undefined : c.admissible,
    },
  );
  return s.state === 'CURRENT'
    ? { vectors: [], fresh: [c] }
    : {
        vectors: [vector(`staleness/${name}`, 'staleness', s.document, { stalenessCase: c })],
        fresh: [],
      };
}

type PinsRow = readonly [number, readonly string[]];
const pinsContest = (n: number, rows: readonly PinsRow[]) =>
  contestInput(n, {
    entries: rows.map(([p]) => ({ participantId: participant(p), outcome: 'RANKED' })),
    performances: rows.flatMap(([p, games]) =>
      games.flatMap((g, i) => [
        {
          participantId: participant(p),
          ordinal: 2 * i + 1,
          mark: markOf(PINS_DV, 'totalPins', g),
        },
        { participantId: participant(p), ordinal: 2 * i + 2, mark: markOf(PINS_DV, 'highGame', g) },
      ]),
    ),
  });
const single = (
  dv: typeof HEATS_DV,
  key: string,
  rows: readonly (readonly [number, number, string, number?])[],
) => {
  const byContest = new Map<number, (readonly [number, number, string, number?])[]>();
  for (const row of rows) byContest.set(row[0], [...(byContest.get(row[0]) ?? []), row]);
  return [...byContest].map(([c, ps]) =>
    contestInput(c, {
      entries: ps.map(([, p]) => ({ participantId: participant(p), outcome: 'RANKED' })),
      performances: ps.map(([, p, v, prec]) => ({
        participantId: participant(p),
        ordinal: 1,
        mark: markOf(dv, key, v, prec ?? 0),
      })),
    }),
  );
};
const padelGroup = () => [
  padelMatch(1, 1, 2, [2, 0, 12, 5]),
  padelMatch(2, 3, 4, [1, 1, 9, 9]),
  padelMatch(3, 1, 3, [0, 2, 6, 12]),
  padelMatch(4, 2, 4, [2, 1, 13, 10]),
];
const padelPolicy = policySpec(PADEL_DV, ['SUM', 'SUM'], ['ENTRY_PRIMARY_MARK', 'PERFORMANCE']);

export function generateBrt10Vectors() {
  const bestMark = rankingRunInput([
    rankCandidate(1, 1, '900000'),
    rankCandidate(2, 2, '900000'),
    rankCandidate(3, 3, '905000'),
    rankCandidate(4, 1, '910000'), // holder 1: strictly worse ⇒ NOT_HOLDER_BEST
    rankCandidate(5, 3, '905000'), // holder 3: equal best ⇒ both pinned
    rankCandidate(6, 4, '899000', { status: 'OFFICIAL' }), // not FINAL ⇒ pending
  ]);
  const missingFacts = rankingRunInput(
    [
      rankCandidate(1, 1, '900000'),
      rankCandidate(2, 2, '901000', { verification: { state: 'STALE' } }),
      rankCandidate(3, 3, '902000', { mark: timeMark('902000', { metricId: 'running.pace' }) }),
      rankCandidate(4, 4, '903000', { occurredAt: '2027-07-01T00:00:00.000Z' }),
      rankCandidate(5, 5, '904000', { valid: false }),
    ],
    {
      supportedFactKinds: [
        'RESULT_STATUS',
        'VERIFICATION',
        'CONTEST_OCCURRENCE',
        'COMPETITION_MEMBERSHIP',
      ],
    },
  );
  const pins = classificationInput(PINS_DV, policySpec(PINS_DV, ['SUM', 'MAX']), [
    pinsContest(1, [
      [1, ['250', '250']],
      [2, ['250', '250']],
      [3, ['300', '191']],
      [4, ['200', '200']],
    ]),
    pinsContest(2, [
      [1, ['190']],
      [2, ['190']],
      [3, ['199']],
      [4, ['279']],
    ]),
  ]);
  const heatsMin = classificationInput(
    HEATS_DV,
    policySpec(HEATS_DV, ['MIN']),
    single(HEATS_DV, 'elapsedTimeMs', [
      [1, 1, '61000'],
      [2, 1, '59000'],
      [1, 2, '60000'],
      [2, 2, '60500'],
      [1, 3, '59000'],
    ]),
  );
  const throwsSum = classificationInput(
    THROWS_DV,
    policySpec(THROWS_DV, ['SUM']),
    single(THROWS_DV, 'distanceM', [
      [1, 1, '7.25', 2],
      [2, 1, '7.30', 2],
      [1, 2, '7.05', 2],
      [2, 2, '7.50', 2],
    ]),
  );
  const missingValue = classificationInput(PINS_DV, policySpec(PINS_DV, ['SUM', 'MAX']), [
    pinsContest(1, [
      [1, ['200']],
      [2, ['210']],
    ]),
    contestInput(2, {
      entries: [
        { participantId: participant(1), outcome: 'RANKED' },
        { participantId: participant(2), outcome: 'DNS' },
      ],
      performances: [
        { participantId: participant(1), ordinal: 1, mark: markOf(PINS_DV, 'totalPins', '190') },
        { participantId: participant(1), ordinal: 2, mark: markOf(PINS_DV, 'highGame', '190') },
      ],
    }),
  ]);
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

  const vectors: Vector[] = [
    vector('system/platform-5k', 'system', rankingSpec()),
    vector('system/platform-5k-reordered', 'system', reversed(rankingSpec())),
    ...ranked('best-mark-ties', bestMark),
    ...ranked('best-mark-ties-reordered', reversed(bestMark)),
    ...ranked('missing-required-facts', missingFacts),
    vector('policy/padel-group', 'policy', padelPolicy),
    ...derived('metrics-sum-max-tie', pins),
    ...derived('metrics-sum-max-tie-reordered', permutedDerivation(pins)),
    // The policy keys are ORDERED: reversing them is a different (forged) spec, refused by hash.
    ...derived('policy-keys-reordered-forged', reversed(pins)),
    ...derived('metrics-min-heats', heatsMin),
    ...derived('metrics-decimal-sum', throwsSum),
    ...derived('head-to-head-points', classificationInput(PADEL_DV, padelPolicy, padelGroup())),
    ...derived('missing-metric-value', missingValue),
    ...derived(
      'undeclared-outcome',
      classificationInput(PADEL_DV, padelPolicy, [...padelGroup(), walkover]),
    ),
  ];
  // Step 7 staleness over the head-to-head classification (pins = matches 1101..1104).
  const h2h = deriveClassification(classificationInput(PADEL_DV, padelPolicy, padelGroup()));
  const h2hProposal = h2h.ok ? h2h.outcome.proposal : undefined;
  if (h2hProposal === undefined) throw new Error('head-to-head vector must propose');
  const h2hPins = h2hProposal.content.derivation.derivedFrom.map((p) => ({
    resultVersionId: p.resultVersionId,
    contentHash: p.contentHash,
  }));
  const allCurrent = Object.fromEntries(h2hPins.map((p) => [p.resultVersionId, true]));
  const successor = { resultVersionId: rkId(1199), contentHash: rkHash('e') };
  const newContest = { resultVersionId: rkId(1105), contentHash: rkHash('f') };
  const without = (id: string) => h2hPins.filter((p) => p.resultVersionId !== id);
  const cases = [
    stale('fresh', 'content/head-to-head-points', h2hProposal.content, h2hProposal.contentHash, {
      current: allCurrent,
      admissible: h2hPins,
    }),
    stale(
      'pin-superseded',
      'content/head-to-head-points',
      h2hProposal.content,
      h2hProposal.contentHash,
      {
        current: { ...allCurrent, [rkId(1102)]: false },
        admissible: [...without(rkId(1102)), successor],
      },
    ),
    // Same state, observation listed in another order (and an unrelated changed result): same digest.
    stale(
      'pin-superseded-reordered',
      'content/head-to-head-points',
      h2hProposal.content,
      h2hProposal.contentHash,
      {
        current: Object.fromEntries(
          Object.entries({ ...allCurrent, [rkId(1102)]: false, [rkId(7777)]: false }).reverse(),
        ),
        admissible: [successor, ...without(rkId(1102))].reverse(),
      },
    ),
    stale(
      'admissible-set-grew',
      'content/head-to-head-points',
      h2hProposal.content,
      h2hProposal.contentHash,
      {
        current: allCurrent,
        admissible: [...h2hPins, newContest],
      },
    ),
    stale(
      'pin-out-of-scope',
      'content/head-to-head-points',
      h2hProposal.content,
      h2hProposal.contentHash,
      {
        current: allCurrent,
        admissible: without(rkId(1101)),
      },
    ),
    stale(
      'admissible-set-unknown',
      'content/head-to-head-points',
      h2hProposal.content,
      h2hProposal.contentHash,
      {
        current: allCurrent,
        admissible: null,
      },
    ),
    stale(
      'pins-unknown',
      'content/head-to-head-points',
      h2hProposal.content,
      h2hProposal.contentHash,
      {
        current: {},
        admissible: h2hPins,
      },
    ),
  ];
  vectors.push(...cases.flatMap((c) => c.vectors));

  return {
    schema: 'br-ranking-vectors/1',
    note: 'REFERENCE ENGINE FIXTURES — NOT PERSISTED SPORTING TRUTH. hash = SHA-256("BR"‖0x01‖domainTag‖0x00‖schemaId@version‖0x00‖"br-json/1"‖0x00‖JCS). Ranks are competition-style shared ranks (1, 1, 3); only a PROPOSED derivation carries `@2` content, which is a ResultVersion proposal, never a RankingSnapshot.',
    vectors,
    /** Observations under which the classification is CURRENT (no staleness document exists). */
    freshCases: cases.flatMap((c) => c.fresh),
    equal: [
      ['system/platform-5k', 'system/platform-5k-reordered'],
      ['run-input/best-mark-ties', 'run-input/best-mark-ties-reordered'],
      ['run-outcome/best-mark-ties', 'run-outcome/best-mark-ties-reordered'],
      ['derivation-input/metrics-sum-max-tie', 'derivation-input/metrics-sum-max-tie-reordered'],
      ['content/metrics-sum-max-tie', 'content/metrics-sum-max-tie-reordered'],
      ['staleness/pin-superseded', 'staleness/pin-superseded-reordered'],
    ],
    distinct: [
      ['run-input/best-mark-ties', 'run-input/missing-required-facts'],
      ['content/metrics-sum-max-tie', 'content/head-to-head-points'],
      ['derivation-input/head-to-head-points', 'derivation-input/undeclared-outcome'],
      ['derivation-input/metrics-sum-max-tie', 'derivation-input/policy-keys-reordered-forged'],
      [
        'staleness/pin-superseded',
        'staleness/admissible-set-grew',
        'staleness/pin-out-of-scope',
        'staleness/admissible-set-unknown',
        'staleness/pins-unknown',
      ],
    ],
  };
}

export const serialize = (doc: unknown) => `${JSON.stringify(doc, null, 2)}\n`;
