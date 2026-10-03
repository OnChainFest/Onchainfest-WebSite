import { fileURLToPath } from 'node:url';
import {
  dtoCanonicalText,
  dtoDigest,
  publicClassification,
  publicClassificationEntries,
  publicLeaderboard,
  publicRankingSnapshot,
  publicRankingSystem,
  publicRankingSystemList,
  publicSnapshotHistory,
  staffRankingRun,
  type ClassificationCardFacts,
  type ClassificationEntryFacts,
  type LeaderboardEntryFacts,
  type RankingSystemCardFacts,
  type RunCandidateFacts,
  type RunCardFacts,
  type SnapshotCardFacts,
} from '../src/public';
import type { ClassificationStaleness, RankingSnapshotStaleness } from '../src/staleness';

/**
 * BRT-10 Step 11 API vectors: PURE INPUT → PURE PUBLIC DTO → JCS → SHA-256. Every input is a literal
 * (fixed fictional ids and instants; no database, clock, randomness, UUID generation or environment).
 * The DTOs come from the real composer (`src/public.ts`); the independent Python checker
 * (`reference/check_brt10_api_vectors.py`) rebuilds each DTO from its input, re-derives JCS and the
 * digest, and fails on any forbidden member or on any input topology (basis / pins / affected ids /
 * staleDigest) that reaches a public DTO. `error` vectors pin the exact error envelopes the API
 * returns (the HTTP tests compare real responses against them).
 *
 * The digest is plain SHA-256 over the JCS text: a DTO is a response document, not a hashed domain
 * object, so no domain tag is involved.
 */
export const API_VECTORS_FILE = fileURLToPath(
  new URL('../test-vectors/brt-10-api.vectors.json', import.meta.url),
);

type Kind =
  | 'system'
  | 'systemList'
  | 'history'
  | 'snapshot'
  | 'leaderboard'
  | 'classification'
  | 'classificationEntries'
  | 'staffRun'
  | 'error';

interface ApiVector {
  readonly name: string;
  readonly kind: Kind;
  readonly visibility: 'PUBLIC' | 'STAFF' | 'ERROR';
  readonly input: unknown;
  readonly canonicalText: string;
  readonly digest: string;
}

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const h = (c: string) => `sha256:${c.repeat(64)}`;

const SYSTEM_PLATFORM: RankingSystemCardFacts = {
  systemId: id(1),
  code: 'fictional-5k-best',
  name: 'Fictional 5K best marks',
  kind: 'PLATFORM',
  latestVersion: 2,
  latestLifecycle: 'PUBLISHED',
  latestSpecHash: h('a'),
  publishedVersion: 2,
  displayName: 'Fictional 5K best marks',
  method: 'BEST_MARK',
  disciplineVersionId: id(2),
  metricKey: 'elapsedTimeMs',
  markMetricId: 'running.elapsed_time',
  holderType: 'ATHLETE',
  recognitionLevel: 'PLATFORM',
  minimumVerificationLevel: 'V2',
  effectiveFrom: '2027-01-01T00:00:00.000Z',
};
const SYSTEM_OFFICIAL: RankingSystemCardFacts = {
  ...SYSTEM_PLATFORM,
  systemId: id(3),
  code: 'fictional-owned-5k',
  name: 'Fictional owned 5K list',
  kind: 'OFFICIAL',
  latestVersion: 1,
  publishedVersion: 1,
  displayName: 'Fictional owned 5K list',
  recognitionLevel: 'CLUB',
  minimumVerificationLevel: 'V3',
};
const SYSTEM_RETIRED: RankingSystemCardFacts = {
  systemId: id(4),
  code: 'fictional-retired',
  name: 'Fictional retired list',
  kind: 'PLATFORM',
  latestVersion: 1,
  latestLifecycle: 'RETIRED',
  latestSpecHash: h('b'),
  displayName: 'Fictional retired list',
  method: 'BEST_MARK',
  disciplineVersionId: id(2),
  metricKey: 'elapsedTimeMs',
  markMetricId: 'running.elapsed_time',
  holderType: 'TEAM',
  recognitionLevel: 'PLATFORM',
  minimumVerificationLevel: 'V2',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
};

const card = (
  n: number,
  pos: number,
  lineage: Pick<
    SnapshotCardFacts,
    'lineageKind' | 'priorSnapshotId' | 'priorSnapshotHash' | 'lineageReasons'
  >,
  extra: Partial<SnapshotCardFacts> = {},
): SnapshotCardFacts => ({
  snapshotId: id(100 + n),
  snapshotHash: h(String(n)),
  systemId: SYSTEM_PLATFORM.systemId,
  systemCode: SYSTEM_PLATFORM.code,
  systemVersionId: id(10),
  systemVersion: 2,
  specHash: SYSTEM_PLATFORM.latestSpecHash,
  kind: 'PLATFORM',
  method: 'BEST_MARK',
  engineVersion: 'ranking-engine/1',
  asOf: `2027-02-0${n}T12:00:00.000Z`,
  publishedAt: `2027-02-0${n}T12:00:05.000Z`,
  chainPosition: pos,
  entryCount: 3,
  ...lineage,
  ...extra,
});
// INITIAL a → FOLLOWS b → CORRECTS b (c) → CORRECTS c (d) → FOLLOWS d (e)
const A = card(1, 1, { lineageKind: 'INITIAL', lineageReasons: [] });
const B = card(
  2,
  2,
  {
    lineageKind: 'FOLLOWS',
    priorSnapshotId: A.snapshotId,
    priorSnapshotHash: A.snapshotHash,
    lineageReasons: [],
  },
  { correctedBySnapshotId: id(103) },
);
const C = card(
  3,
  3,
  {
    lineageKind: 'CORRECTS',
    priorSnapshotId: B.snapshotId,
    priorSnapshotHash: B.snapshotHash,
    lineageReasons: ['RESULT_SUPERSEDED'],
  },
  { correctedBySnapshotId: id(104), entryCount: 1 },
);
const D = card(
  4,
  4,
  {
    lineageKind: 'CORRECTS',
    priorSnapshotId: C.snapshotId,
    priorSnapshotHash: C.snapshotHash,
    lineageReasons: ['RESULT_SUPERSEDED'],
  },
  { entryCount: 1 },
);
const E = card(5, 5, {
  lineageKind: 'FOLLOWS',
  priorSnapshotId: D.snapshotId,
  priorSnapshotHash: D.snapshotHash,
  lineageReasons: [],
});

const STALE_SNAPSHOT: RankingSnapshotStaleness = {
  state: 'STALE',
  reasons: ['BASIS_VERIFICATION_NOT_CURRENT', 'BASIS_RESULT_NOT_CURRENT'],
  affected: [
    {
      resultVersionId: id(900),
      contentHash: h('c'),
      verificationRunId: id(901),
      reasons: ['BASIS_RESULT_NOT_CURRENT', 'BASIS_VERIFICATION_NOT_CURRENT'],
    },
  ] as never,
};

const mark = (value: string) => ({
  metricId: 'running.elapsed_time',
  value,
  unit: 'ms',
  precision: 0,
});
const trace = (value: string) => [
  { key: 'elapsedTimeMs', order: 'LOWER_IS_BETTER' as const, value },
];
const LEADERBOARD: LeaderboardEntryFacts[] = [
  {
    holderType: 'ATHLETE',
    holderId: id(201),
    rank: 1,
    tied: true,
    value: mark('900000'),
    comparatorTrace: trace('900000'),
    basisCount: 2,
    display: {
      kind: 'ATHLETE',
      athleteSlug: 'fictional-runner-a',
      displayName: 'Fictional Runner A',
    },
  },
  {
    holderType: 'ATHLETE',
    holderId: id(202),
    rank: 1,
    tied: true,
    value: mark('900000'),
    comparatorTrace: trace('900000'),
    basisCount: 1,
    display: { kind: 'PRIVATE_ENTRANT' },
  },
  {
    holderType: 'TEAM',
    holderId: id(203),
    rank: 3,
    tied: false,
    value: mark('905000'),
    comparatorTrace: trace('905000'),
    basisCount: 1,
    display: { kind: 'TEAM', teamName: 'Fictional Relay Club' },
  },
];

const CLASSIFICATION: ClassificationCardFacts = {
  resultVersionId: id(301),
  resultId: id(302),
  scopeType: 'COMPETITION_CLASSIFICATION',
  scopeTargetId: id(303),
  versionNumber: 1,
  contentHash: h('d'),
  policyId: id(304),
  policyVersionId: id(305),
  policySpecHash: h('e'),
  disciplineVersionId: id(2),
  engineVersion: 'classification-engine/1',
  inputsDigest: h('f'),
  inputCount: 2,
  status: 'PROVISIONAL',
  statusSince: '2027-03-01T10:00:00.000Z',
  submittedAt: '2027-03-01T09:00:00.000Z',
  entryCount: 3,
};
const STALE_CLASSIFICATION: ClassificationStaleness = {
  state: 'STALE',
  document: {
    classificationVersionId: CLASSIFICATION.resultVersionId,
    contentHash: CLASSIFICATION.contentHash,
    inputsDigest: CLASSIFICATION.inputsDigest,
    reasons: ['PINNED_INPUT_NOT_CURRENT', 'ADMISSIBLE_INPUT_SET_CHANGED'],
    notCurrent: [{ resultVersionId: id(910), contentHash: h('1') }],
    added: [{ resultVersionId: id(911), contentHash: h('2') }],
    removed: [{ resultVersionId: id(912), contentHash: h('3') }],
  },
  staleDigest: h('9') as never,
};
const ENTRIES: ClassificationEntryFacts[] = [
  {
    participantId: id(401),
    rank: 1,
    tied: false,
    tieBreakKeys: trace('10870'),
    display: {
      kind: 'ATHLETE',
      athleteSlug: 'fictional-sprinter',
      displayName: 'Fictional Sprinter',
    },
  },
  {
    participantId: id(402),
    rank: 2,
    tied: true,
    tieBreakKeys: trace('11020'),
    display: { kind: 'PRIVATE_ENTRANT' },
  },
  {
    participantId: id(403),
    rank: 2,
    tied: true,
    tieBreakKeys: trace('11020'),
    display: { kind: 'TEAM', teamName: 'Fictional Team' },
  },
];

const RUN: RunCardFacts = {
  runId: id(501),
  systemId: SYSTEM_PLATFORM.systemId,
  systemVersionId: id(10),
  systemVersion: 2,
  specHash: SYSTEM_PLATFORM.latestSpecHash,
  engineVersion: 'ranking-engine/1',
  provenance: 'CANONICAL_ASSEMBLY',
  inputHash: h('4'),
  outcomeHash: h('5'),
  asOf: '2027-02-01T12:00:00.000Z',
  publicationState: 'BLOCKED',
  publicationReasons: ['NO_RANKED_ENTRIES'],
  entryCount: 0,
  candidateCount: 2,
  trigger: 'UPSTREAM_FACT_CHANGED',
  recordedAt: '2027-02-01T12:00:01.000Z',
};
const CANDIDATES: RunCandidateFacts[] = [
  {
    resultVersionId: id(601),
    participantId: id(602),
    ordinal: 0,
    state: 'PENDING_REQUIRED_FACTS',
    reasons: ['RESULT_STATUS_BELOW_REQUIRED', 'HOLD_STATE_UNAVAILABLE'],
  },
  {
    resultVersionId: id(603),
    participantId: id(604),
    ordinal: 0,
    state: 'PENDING_REQUIRED_FACTS',
    reasons: ['VERIFICATION_NOT_EVALUATED', 'HOLD_STATE_UNAVAILABLE'],
  },
];

/** The exact error envelopes of the BRT-10 routes (apps/api `errorBody` + the AJV edge). */
export const API_ERROR_CASES = {
  'error/snapshot-not-found': {
    status: 404,
    body: { error: { code: 'NOT_FOUND', message: 'ranking snapshot not found' } },
  },
  'error/system-not-found': {
    status: 404,
    body: { error: { code: 'NOT_FOUND', message: 'ranking system not found' } },
  },
  'error/classification-not-found': {
    status: 404,
    body: { error: { code: 'NOT_FOUND', message: 'classification not found' } },
  },
  'error/proposal-not-found': {
    status: 404,
    body: { error: { code: 'NOT_FOUND', message: 'result version not found' } },
  },
  'error/invalid-cursor': {
    status: 400,
    body: { error: { code: 'INVALID_INPUT', message: 'invalid cursor' } },
  },
  'error/malformed-snapshot-id': {
    status: 400,
    body: {
      error: { code: 'INVALID_INPUT', message: 'params/snapshotId must match format "uuid"' },
    },
  },
  'error/projection-mismatch': {
    status: 500,
    body: {
      error: {
        code: 'RANKING_INTEGRITY_FAILURE',
        message: 'ranking projection does not match the canonical facts',
        reason: 'PROJECTION_MISMATCH',
      },
    },
  },
} as const;

export function generateBrt10ApiVectors() {
  const vectors: ApiVector[] = [];
  const add = (name: string, kind: Kind, input: unknown, dto: unknown) =>
    vectors.push({
      name,
      kind,
      visibility: kind === 'staffRun' ? 'STAFF' : kind === 'error' ? 'ERROR' : 'PUBLIC',
      input,
      canonicalText: dtoCanonicalText(dto),
      digest: dtoDigest(dto),
    });
  add('system/platform-published', 'system', SYSTEM_PLATFORM, publicRankingSystem(SYSTEM_PLATFORM));
  add(
    'system/official-owner-publication-unavailable',
    'system',
    SYSTEM_OFFICIAL,
    publicRankingSystem(SYSTEM_OFFICIAL),
  );
  add('system/retired-team', 'system', SYSTEM_RETIRED, publicRankingSystem(SYSTEM_RETIRED));
  {
    const input = {
      cards: [SYSTEM_OFFICIAL, SYSTEM_PLATFORM],
      nextCursor: 'ZmljdGlvbmFsLTVrLWJlc3Q',
    };
    add(
      'systemList/page-with-cursor',
      'systemList',
      input,
      publicRankingSystemList(input.cards, input.nextCursor),
    );
  }
  {
    const input = {
      systemId: SYSTEM_PLATFORM.systemId,
      view: 'as-published',
      cards: [A, B, C, D, E],
    };
    add(
      'history/as-published-keeps-every-snapshot',
      'history',
      input,
      publicSnapshotHistory(input.systemId, 'as-published', input.cards),
    );
  }
  {
    const input = {
      systemId: SYSTEM_PLATFORM.systemId,
      view: 'as-corrected',
      cards: [A, { ...D, corrects: [B.snapshotId, C.snapshotId] }, E],
    };
    add(
      'history/as-corrected-replaces-corrected',
      'history',
      input,
      publicSnapshotHistory(input.systemId, 'as-corrected', input.cards),
    );
  }
  {
    const input = {
      systemId: SYSTEM_PLATFORM.systemId,
      view: 'as-published',
      cards: [A, B],
      nextCursor: 'Mg',
    };
    add(
      'history/page-with-cursor',
      'history',
      input,
      publicSnapshotHistory(input.systemId, 'as-published', input.cards, input.nextCursor),
    );
  }
  {
    const input = { systemId: SYSTEM_RETIRED.systemId, view: 'as-published', cards: [] };
    add(
      'history/empty',
      'history',
      input,
      publicSnapshotHistory(input.systemId, 'as-published', input.cards),
    );
  }
  for (const [name, c, s] of [
    ['snapshot/current', E, { state: 'CURRENT' }],
    ['snapshot/stale-topology-omitted', A, STALE_SNAPSHOT],
    ['snapshot/correction-lineage', D, { state: 'CURRENT' }],
  ] as const)
    add(name, 'snapshot', { card: c, staleness: s }, publicRankingSnapshot(c, s));
  {
    const input = { snapshotId: A.snapshotId, snapshotHash: A.snapshotHash, entries: LEADERBOARD };
    add(
      'leaderboard/shared-ties-private-and-team',
      'leaderboard',
      input,
      publicLeaderboard(input.snapshotId, input.snapshotHash, input.entries),
    );
    const paged = { ...input, entries: LEADERBOARD.slice(0, 1), nextCursor: 'MXxBVEhMRVRF' };
    add(
      'leaderboard/page-with-cursor',
      'leaderboard',
      paged,
      publicLeaderboard(paged.snapshotId, paged.snapshotHash, paged.entries, paged.nextCursor),
    );
  }
  add(
    'classification/current',
    'classification',
    { card: CLASSIFICATION, staleness: { state: 'CURRENT' } },
    publicClassification(CLASSIFICATION, { state: 'CURRENT' }),
  );
  {
    const c = { ...CLASSIFICATION, status: 'FINAL' as const };
    add(
      'classification/stale-topology-omitted',
      'classification',
      { card: c, staleness: STALE_CLASSIFICATION },
      publicClassification(c, STALE_CLASSIFICATION),
    );
  }
  {
    const input = {
      resultVersionId: CLASSIFICATION.resultVersionId,
      contentHash: CLASSIFICATION.contentHash,
      entries: ENTRIES,
    };
    add(
      'classificationEntries/shared-rank',
      'classificationEntries',
      input,
      publicClassificationEntries(input.resultVersionId, input.contentHash, input.entries),
    );
  }
  add(
    'staffRun/blocked-with-blockers',
    'staffRun',
    { card: RUN, candidates: CANDIDATES },
    staffRankingRun(RUN, CANDIDATES),
  );
  for (const [name, e] of Object.entries(API_ERROR_CASES)) add(name, 'error', e, e.body);
  return {
    schema: 'br:brt-10-api-vectors@1',
    note: 'FICTIONAL DATA ONLY. Public / staff DTOs of the BRT-10 /v1 surface: input → DTO → JCS → SHA-256 (no domain tag).',
    vectors,
  };
}

export const serialize = (doc: unknown) => `${JSON.stringify(doc, null, 2)}\n`;
