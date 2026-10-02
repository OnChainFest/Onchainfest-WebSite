import type { BrObjectSchema, BrRootSchema, BrSchema, BrStringSchema } from '@br/canonical';
import {
  ALL_RANKING_FACT_KINDS,
  CLASSIFICATION_AGGREGATIONS,
  CLASSIFICATION_STALE_REASONS,
  ClassificationKeySource,
  HolderType,
  PopulationDimension,
  QualificationBasisKind,
  RANKING_METHODS,
  RANKING_SYSTEM_KINDS,
  RankingCandidateState,
  RankingDefinitionLifecycle,
  RankingProvenance,
  RankingPublicationState,
  RankingSnapshotLineageKind,
  ResultOutcome,
  ResultScopeType,
  ResultVersionStatus,
  VERIFICATION_LEVELS,
} from '@br/domain';
import { resultVersionContentV1 } from './definitions';
import { enumOf, hashRef, mark, setOf, timestamp, uuid } from './primitives';
import {
  governingRecognitionSchema,
  recordHolderSchema,
  recordPopulationSchema,
  recordRecognitionSchema,
  verificationSummarySchema,
} from './records';

/**
 * BRT-10 Ranking & Classification schemas (ADR-0014 BR-JSON + JCS + SHA-256, domain-separated):
 *
 *   br:result-version-content@2     classification ResultVersion content (+ derivation) tag result-version-content
 *   br:classification-policy@1      immutable classification ordering policy            tag classification-policy
 *   br:ranking-system-version@1     immutable ranking system definition                 tag ranking-system-version
 *   br:ranking-universe@1           the universe identity every version shares          tag ranking-universe
 *   br:ranking-run-input@1          pure ranking-engine input (NOT a RankingSnapshot)   tag ranking-run-input
 *   br:ranking-run-outcome@1        deterministic run outcome (entries + candidates)    tag ranking-run-outcome
 *   br:ranking-snapshot@1           the published, immutable RankingSnapshot content    tag ranking-snapshot
 *   br:qualification-basis@1        the qualifying fact a QUALIFIED Achievement pins     tag qualification-basis
 *   br:classification-derivation-input@1    pure classification-engine input   tag classification-derivation-input
 *   br:classification-derivation-outcome@1  its deterministic outcome          tag classification-derivation-outcome
 *   br:classification-staleness@1           why a classification is STALE     tag classification-staleness
 *
 * Closed (unknown members rejected — a RankingSnapshot can therefore never carry a Result lifecycle
 * status), bounded, no floats / nulls / scores; sets never depend on input order. Semantic rules
 * (floors, kind ↔ recognition coherence, comparator vs DisciplineVersion, competition-ranking ties,
 * qualification coherence) are enforced by the validators in @br/rankings.
 */
const root = (
  id: string,
  version: number,
  body: Omit<BrRootSchema, '$id' | 'x-br-version'>,
): BrRootSchema => ({ $id: id, 'x-br-version': version, ...body });
const code = (pattern: string, maxLength: number): BrStringSchema => ({
  type: 'string',
  pattern,
  maxLength,
});
const bounded = <T extends BrSchema & { type: 'array' }>(schema: T, maxItems: number): T => ({
  ...schema,
  maxItems,
});
const obj = (
  properties: Record<string, BrSchema>,
  required: readonly string[] = [],
): BrObjectSchema => ({ type: 'object', additionalProperties: false, required, properties });

const level = enumOf(VERIFICATION_LEVELS);
const provenance = enumOf(Object.values(RankingProvenance));
const reasonCode = code('^[A-Z][A-Z0-9_]{0,63}$', 64);
const reasons = bounded(setOf(reasonCode), 32);
const systemCode = code('^[a-z0-9][a-z0-9-]{1,63}$', 64);
const metricKey = code('^[a-z][A-Za-z0-9]{0,63}$', 64);
const markMetricId = code('^[a-z0-9_]+(?:\\.[a-z0-9_]+)*$', 128);
const sportCode = code('^[a-z0-9]+(?:[-_][a-z0-9]+)*$', 64);
const disciplineCode = code('^[a-z0-9_-]+(?:\\.[a-z0-9_-]+)*$', 128);
const assemblerCode = code('^[a-z0-9][a-z0-9./_-]{0,63}$', 64);
const decimal: BrStringSchema = { type: 'string', 'x-br-type': 'decimal' };
const displayName: BrStringSchema = { type: 'string', minLength: 1, maxLength: 80 };
const rankingEngine = code('^ranking-engine/[1-9][0-9]{0,3}$', 32);
const classificationEngine = code('^classification-engine/[1-9][0-9]{0,3}$', 32);
/** The BRT-05 ComparatorOrder vocabulary, verbatim (validators decide which orders a use admits). */
const comparatorOrder = enumOf(['HIGHER_IS_BETTER', 'LOWER_IS_BETTER', 'ORDINAL']);
const finalOnly = enumOf(['FINAL']);
const rank = { type: 'integer', minimum: 1, maximum: 1_000_000 } as const;

/** One DisciplineVersion comparator key, as BRT-05 stores it ({metric, order}). ORDER MATTERS. */
const comparatorKey = obj({ metric: metricKey, order: comparatorOrder }, ['metric', 'order']);
/** The comparator value used for one key (BRT-01 §6.2 tieBreakKeys), in comparator order. */
const comparatorTraceItem = obj({ key: metricKey, order: comparatorOrder, value: decimal }, [
  'key',
  'order',
  'value',
]);
const comparatorTrace = { type: 'array', items: comparatorTraceItem, maxItems: 9 } as const;
const valueType = enumOf(['INTEGER', 'DECIMAL', 'DURATION_MS']);
/** One BRT-05 MetricSpec ({key, valueType, unit}) plus, when the DV comparator declares one, its order. */
const dvMetric = obj(
  {
    key: metricKey,
    valueType,
    unit: { type: 'string', minLength: 1, maxLength: 32 },
    order: comparatorOrder,
  },
  ['key', 'valueType', 'unit'],
);

// ───────────────────────────── classification ResultVersion content (@2) ─────────────────────────────

/**
 * Classification ResultVersion content (ADR-0047): `@1` plus a REQUIRED `derivation` that pins the
 * exact input versions (`derivedFrom`), the ClassificationPolicy version and spec hash, the
 * DisciplineVersion, the engine and the inputs digest. Entries are RANKED with competition-style shared
 * ranks (`tied`); their serialized order (by participantId) carries no meaning (ADR-0049 §5).
 * Not accepted by the ResultLedger until Step 6 (the ledger pins `@1` today).
 */
export const resultVersionContentV2 = root('br:result-version-content', 2, {
  type: 'object',
  additionalProperties: false,
  required: ['entries', 'derivation'],
  properties: {
    entries: setOf(
      obj(
        {
          participantId: uuid,
          outcome: enumOf(['RANKED']),
          rank,
          tied: { type: 'boolean' },
          primaryMark: mark,
          tieBreakKeys: comparatorTrace,
        },
        ['participantId', 'outcome', 'rank', 'tied', 'tieBreakKeys'],
      ),
      { minItems: 1, sortBy: ['/participantId'], keyUnique: true },
    ),
    performances: resultVersionContentV1.properties.performances as BrSchema,
    derivation: obj(
      {
        derivedFrom: bounded(
          setOf(
            obj(
              {
                resultVersionId: uuid,
                contentHash: hashRef,
                status: enumOf(['PROVISIONAL', 'OFFICIAL', 'FINAL']),
              },
              ['resultVersionId', 'contentHash', 'status'],
            ),
            { minItems: 1, sortBy: ['/resultVersionId'], keyUnique: true },
          ),
          2048,
        ),
        policy: obj({ policyId: uuid, policyVersionId: uuid, specHash: hashRef }, [
          'policyId',
          'policyVersionId',
          'specHash',
        ]),
        disciplineVersionId: uuid,
        engineVersion: classificationEngine,
        inputsDigest: hashRef,
      },
      ['derivedFrom', 'policy', 'disciplineVersionId', 'engineVersion', 'inputsDigest'],
    ),
  },
});

// ───────────────────────────── classification policy ─────────────────────────────

/**
 * Immutable ClassificationPolicy (ADR-0049): the DisciplineVersion comparator keys IN ORDER (never
 * added / removed / reordered / re-directed — checked against the exact DV), each with an explicit
 * source and a closed aggregation (SUM | MAX | MIN; AVERAGE refused), plus integer outcome points for
 * HEAD_TO_HEAD_WINNER disciplines. No expressions, scripts or plugins.
 */
export const classificationPolicyV1 = root('br:classification-policy', 1, {
  type: 'object',
  additionalProperties: false,
  required: [
    'targetEngine',
    'displayName',
    'scopeType',
    'disciplineVersionId',
    'minimumInputStatus',
    'primary',
    'keys',
  ],
  properties: {
    targetEngine: classificationEngine,
    displayName,
    scopeType: enumOf([
      'ROUND_CLASSIFICATION',
      'EVENT_CLASSIFICATION',
      'COMPETITION_CLASSIFICATION',
    ]),
    disciplineVersionId: uuid,
    /** Operational floor PROVISIONAL (ADR-0008); a policy may raise it. */
    minimumInputStatus: enumOf(['PROVISIONAL', 'OFFICIAL', 'FINAL']),
    /** Copied from the DisciplineVersion comparator (validated equal). */
    primary: enumOf(['HEAD_TO_HEAD_WINNER', 'METRICS']),
    keys: {
      type: 'array',
      maxItems: 8,
      items: obj(
        {
          metric: metricKey,
          /** The canonical Mark.metricId the DV key is recorded under (the DV declares no mapping). */
          markMetricId,
          order: comparatorOrder,
          source: enumOf(Object.values(ClassificationKeySource)),
          aggregation: enumOf(CLASSIFICATION_AGGREGATIONS),
        },
        ['metric', 'markMetricId', 'order', 'source', 'aggregation'],
      ),
    },
    outcomePoints: bounded(
      setOf(
        obj(
          {
            outcome: enumOf(Object.values(ResultOutcome)),
            points: { type: 'integer', minimum: -1000, maximum: 1000 },
          },
          ['outcome', 'points'],
        ),
        { minItems: 1, sortBy: ['/outcome'], keyUnique: true },
      ),
      16,
    ),
  },
});

// ───────────────────────────── classification derivation input / outcome ─────────────────────────────

const embedded = (schema: BrRootSchema): BrObjectSchema => ({
  type: 'object',
  additionalProperties: false,
  required: schema.required ?? [],
  properties: schema.properties,
});

/**
 * The ONLY input of the pure classification engine (ADR-0047 §3–4): one exact ClassificationPolicy
 * version (spec embedded + hash), the pinned DisciplineVersion metrics and comparator (+ catalog spec
 * hash), the classification scope with the contests the hierarchy resolves into it, and the current
 * version of each input Result with its exact `@1` content (re-hashed by the engine). No trigger, no
 * transaction time and no existing-classification fact: equal inputs always hash equally, so a
 * re-derivation from unchanged inputs reproduces the identical proposal.
 */
export const classificationDerivationInputV1 = root('br:classification-derivation-input', 1, {
  type: 'object',
  additionalProperties: false,
  required: ['provenance', 'assembler', 'policy', 'discipline', 'scope', 'inputs'],
  properties: {
    provenance,
    assembler: assemblerCode,
    policy: obj(
      {
        policyId: uuid,
        policyVersionId: uuid,
        specHash: hashRef,
        spec: embedded(classificationPolicyV1),
      },
      ['policyId', 'policyVersionId', 'specHash', 'spec'],
    ),
    discipline: obj(
      {
        disciplineVersionId: uuid,
        /** catalogSpecHash of the DisciplineVersion spec the metrics / comparator are copied from. */
        specHash: hashRef,
        metrics: bounded(
          setOf(
            obj(
              { key: metricKey, valueType, unit: { type: 'string', minLength: 1, maxLength: 32 } },
              ['key', 'valueType', 'unit'],
            ),
            { minItems: 1, sortBy: ['/key'], keyUnique: true },
          ),
          64,
        ),
        comparator: obj(
          {
            /** The BRT-05 OutcomeModel vocabulary, verbatim. */
            outcomeModel: enumOf(['WIN_LOSS_DRAW', 'RANKED', 'SCORED_RANKED', 'JUDGED_RANKED']),
            primary: enumOf(['HEAD_TO_HEAD_WINNER', 'METRICS']),
            keys: { type: 'array', items: comparatorKey, maxItems: 8 },
          },
          ['outcomeModel', 'primary', 'keys'],
        ),
      },
      ['disciplineVersionId', 'specHash', 'metrics', 'comparator'],
    ),
    scope: obj(
      {
        scopeType: enumOf([
          'ROUND_CLASSIFICATION',
          'EVENT_CLASSIFICATION',
          'COMPETITION_CLASSIFICATION',
        ]),
        /** The round / event / competition the classification Result belongs to. */
        scopeId: uuid,
        /** Every contest the explicit hierarchy (ADR-0025) resolves into the scope. */
        contestIds: bounded(setOf(uuid, { minItems: 1 }), 2048),
      },
      ['scopeType', 'scopeId', 'contestIds'],
    ),
    inputs: bounded(
      setOf(
        obj(
          {
            resultId: uuid,
            resultVersionId: uuid,
            contentHash: hashRef,
            /** Any scope, so an inadmissible (e.g. classification) input is REPORTED, not refused. */
            scopeType: enumOf(Object.values(ResultScopeType)),
            contestId: uuid,
            status: enumOf(Object.values(ResultVersionStatus).filter((s) => s !== 'DRAFT')),
            supersededByVersionId: uuid,
            content: embedded(resultVersionContentV1),
          },
          [
            'resultId',
            'resultVersionId',
            'contentHash',
            'scopeType',
            'contestId',
            'status',
            'content',
          ],
        ),
        { sortBy: ['/resultVersionId'], keyUnique: true },
      ),
      2048,
    ),
  },
});

/**
 * Deterministic outcome of one classification derivation: every input and every contest in scope
 * accounted for, the derivation-level blockers, and — only when nothing blocks — the proposed `@2`
 * ResultVersion content and its hash. A proposal is NOT a submission: it enters only through the
 * ResultLedger, which re-derives it (ADR-0047 §3).
 */
export const classificationDerivationOutcomeV1 = root('br:classification-derivation-outcome', 1, {
  type: 'object',
  additionalProperties: false,
  required: [
    'engineVersion',
    'provenance',
    'inputsDigest',
    'policy',
    'disciplineVersionId',
    'state',
    'blockers',
    'inputs',
    'missingContestIds',
    'participants',
  ],
  properties: {
    engineVersion: classificationEngine,
    provenance,
    inputsDigest: hashRef,
    policy: obj({ policyId: uuid, policyVersionId: uuid, specHash: hashRef }, [
      'policyId',
      'policyVersionId',
      'specHash',
    ]),
    disciplineVersionId: uuid,
    state: enumOf(['PROPOSED', 'BLOCKED']),
    /** Every blocker of the derivation (input, participant and definition level), as a set. */
    blockers: reasons,
    inputs: bounded(
      setOf(
        obj(
          {
            resultVersionId: uuid,
            state: enumOf(['ADMITTED', 'EXCLUDED']),
            reasons,
          },
          ['resultVersionId', 'state', 'reasons'],
        ),
        { sortBy: ['/resultVersionId'], keyUnique: true },
      ),
      2048,
    ),
    /** Contests in scope with no admissible current input (CLASSIFICATION_INPUT_MISSING). */
    missingContestIds: bounded(setOf(uuid), 2048),
    /** Participants whose comparator inputs block the derivation (never silently dropped). */
    participants: bounded(
      setOf(obj({ participantId: uuid, reasons }, ['participantId', 'reasons']), {
        sortBy: ['/participantId'],
        keyUnique: true,
      }),
      4096,
    ),
    proposal: obj({ contentHash: hashRef, content: embedded(resultVersionContentV2) }, [
      'contentHash',
      'content',
    ]),
  },
});

// ───────────────────────────── classification staleness ─────────────────────────────

const pinSet = bounded(
  setOf(obj({ resultVersionId: uuid, contentHash: hashRef }, ['resultVersionId', 'contentHash']), {
    sortBy: ['/resultVersionId'],
    keyUnique: true,
  }),
  2048,
);

/**
 * Why ONE classification ResultVersion is STALE (ADR-0047 §5). Its hash is the `staleDigest`:
 * ClassificationStale is idempotent per (classification version, staleDigest). Computed from the
 * version's immutable pins and the current canonical state — never stored on the version. Input
 * statuses are deliberately absent, so a status upgrade of a pinned input (PROVISIONAL → OFFICIAL)
 * changes nothing here.
 *   notCurrent  pins that are no longer the current version of their Result (or whose state is unknown)
 *   added       admissible inputs of the scope (under the pinned policy) that are not pinned
 *   removed     pins that are still current but no longer admissible (e.g. no longer in scope)
 */
export const classificationStalenessV1 = root('br:classification-staleness', 1, {
  type: 'object',
  additionalProperties: false,
  required: [
    'classificationVersionId',
    'contentHash',
    'inputsDigest',
    'reasons',
    'notCurrent',
    'added',
    'removed',
  ],
  properties: {
    classificationVersionId: uuid,
    contentHash: hashRef,
    inputsDigest: hashRef,
    reasons: setOf(enumOf(CLASSIFICATION_STALE_REASONS), { minItems: 1 }),
    notCurrent: pinSet,
    added: pinSet,
    removed: pinSet,
  },
});

// ───────────────────────────── ranking system version ─────────────────────────────

const rankingUniverseBody = obj(
  {
    /** The exact DisciplineVersion whose metric semantics and comparator the ranking uses. */
    disciplineVersionId: uuid,
    metric: obj({ key: metricKey, markMetricId }, ['key', 'markMetricId']),
    /** BEST_MARK ranks Performances of CONTEST ResultVersions only — never classifications. */
    resultScope: enumOf(['CONTEST']),
    holderType: enumOf(Object.values(HolderType)),
    /** Explicit competition set; absent = every competition the canonical hierarchy resolves. */
    competitionIds: bounded(setOf(uuid, { minItems: 1 }), 256),
    /** Sporting-time window [from, to). There is no season entity (ADR-0048 §2). */
    window: obj({ from: timestamp, to: timestamp }, ['from']),
    /** Declared population restriction (BRT-09 vocabulary). No producer ⇒ declared dims fail closed. */
    population: recordPopulationSchema,
  },
  ['disciplineVersionId', 'metric', 'resultScope', 'holderType', 'population'],
);
const rankingComparator = obj(
  { keys: { type: 'array', items: comparatorKey, minItems: 1, maxItems: 8 } },
  ['keys'],
);

/**
 * An immutable RankingSystemVersion (ADR-0048): kind, method, universe, the pinned comparator keys,
 * the raise-only verification / status floor, the structural recognition scope, the owner (OFFICIAL
 * only) and `effectiveFrom`. Its semantics never change once published; history pins its spec hash.
 */
export const rankingSystemVersionV1 = root('br:ranking-system-version', 1, {
  type: 'object',
  additionalProperties: false,
  required: [
    'targetEngine',
    'displayName',
    'kind',
    'method',
    'universe',
    'comparator',
    'requirements',
    'recognition',
    'effectiveFrom',
  ],
  properties: {
    targetEngine: rankingEngine,
    /** Descriptive universe name; recognition words refused (the model computes public labels). */
    displayName,
    kind: enumOf(RANKING_SYSTEM_KINDS),
    method: enumOf(RANKING_METHODS),
    universe: rankingUniverseBody,
    comparator: rankingComparator,
    requirements: obj({ minimumVerificationLevel: level, minimumResultStatus: finalOnly }, [
      'minimumVerificationLevel',
      'minimumResultStatus',
    ]),
    /** PLATFORM: level PLATFORM only. OFFICIAL: the owner's anchored recognition scope. */
    recognition: recordRecognitionSchema,
    /** OFFICIAL only: the anchored owner (its anchor must recognize `recognition`). */
    owner: obj({ principalId: uuid, anchorId: uuid }, ['principalId', 'anchorId']),
    /** Performances before this instant never enter the system (no backdating; ≥ publication). */
    effectiveFrom: timestamp,
  },
});

/** The universe identity: every version of one ranking system must share it (ADR-0048 §1). */
export const rankingUniverseV1 = root('br:ranking-universe', 1, {
  type: 'object',
  additionalProperties: false,
  required: ['method', 'universe', 'comparator'],
  properties: {
    method: enumOf(RANKING_METHODS),
    universe: rankingUniverseBody,
    comparator: rankingComparator,
  },
});

const systemSpecEmbedded: BrObjectSchema = {
  type: 'object',
  additionalProperties: false,
  required: rankingSystemVersionV1.required ?? [],
  properties: rankingSystemVersionV1.properties,
};

// ───────────────────────────── ranking basis / entry ─────────────────────────────

/**
 * The verified immutable Performance basis of ONE ranked mark (ADR-0044 / ADR-0048 §4.2): the exact
 * Performance inside the exact FINAL CONTEST ResultVersion, its CURRENT BRT-07 run (hashes + level),
 * the evidence commitment, governing recognition, competition / event / contest, sporting time and
 * hold state known ABSENT. No raw Result content.
 */
const rankingBasis = obj(
  {
    resultId: uuid,
    resultVersionId: uuid,
    contentHash: hashRef,
    resultStatus: finalOnly,
    competitionId: uuid,
    eventId: uuid,
    contestId: uuid,
    participantId: uuid,
    performanceOrdinal: { type: 'integer', minimum: 1 },
    performanceAthleteId: uuid,
    verificationRunId: uuid,
    verificationSnapshotHash: hashRef,
    verificationOutcomeHash: hashRef,
    verificationLevel: level,
    evidenceBundleHash: hashRef,
    evidenceBundleAsOf: timestamp,
    evidenceCommitment: hashRef,
    governingRecognition: governingRecognitionSchema,
    hold: enumOf(['ABSENT']),
    occurredAt: timestamp,
  },
  [
    'resultId',
    'resultVersionId',
    'contentHash',
    'resultStatus',
    'competitionId',
    'eventId',
    'contestId',
    'participantId',
    'performanceOrdinal',
    'verificationRunId',
    'verificationSnapshotHash',
    'verificationOutcomeHash',
    'verificationLevel',
    'evidenceBundleHash',
    'evidenceBundleAsOf',
    'evidenceCommitment',
    'hold',
    'occurredAt',
  ],
);

/**
 * One RankingEntry: the holder's shared competition-style rank inside ONE immutable snapshot, the
 * ranked Mark (byte-equal to the Performance Mark), the comparator trace and the exact basis — every
 * Performance achieving the holder's best value (equal best marks are all pinned; no hidden choice).
 * Entries are a set keyed by holder; their serialized order carries no ranking meaning.
 */
const rankingEntry = obj(
  {
    rank,
    tied: { type: 'boolean' },
    holder: recordHolderSchema,
    value: mark,
    comparatorTrace,
    basis: bounded(
      setOf(rankingBasis, {
        minItems: 1,
        sortBy: ['/resultVersionId', '/participantId', '/performanceOrdinal'],
        keyUnique: true,
      }),
      64,
    ),
  },
  ['rank', 'tied', 'holder', 'value', 'comparatorTrace', 'basis'],
);
const rankingEntries = bounded(
  setOf(rankingEntry, { sortBy: ['/holder/holderType', '/holder/holderId'], keyUnique: true }),
  10_000,
);

// ───────────────────────────── ranking run input / outcome ─────────────────────────────

const runCandidate = obj(
  {
    resultId: uuid,
    resultVersionId: uuid,
    contentHash: hashRef,
    /** CONTEST only: a classification ResultVersion can never be a BEST_MARK candidate. */
    scopeType: enumOf(['CONTEST']),
    status: enumOf(Object.values(ResultVersionStatus).filter((s) => s !== 'DRAFT')),
    supersededByVersionId: uuid,
    competitionId: uuid,
    eventId: uuid,
    contestId: uuid,
    participantId: uuid,
    /** Resolved durable holder (absent ⇒ HOLDER_UNRESOLVED). */
    holder: recordHolderSchema,
    performanceAthleteId: uuid,
    ordinal: { type: 'integer', minimum: 1 },
    mark,
    valid: { type: 'boolean' },
    occurredAt: timestamp,
    verification: verificationSummarySchema,
    /** HOLD_STATE kind (no producer): absent ⇒ HOLD_STATE_UNAVAILABLE, never "no hold". */
    hold: obj({ active: { type: 'boolean' } }, ['active']),
    /** POPULATION kind (no producer): typed facts; absence is never a default value. */
    population: bounded(
      setOf(
        obj(
          {
            dimension: enumOf(Object.values(PopulationDimension)),
            value: code('^[A-Z0-9][A-Z0-9_-]{0,31}$', 32),
          },
          ['dimension', 'value'],
        ),
        { sortBy: ['/dimension'], keyUnique: true },
      ),
      8,
    ),
  },
  [
    'resultId',
    'resultVersionId',
    'contentHash',
    'scopeType',
    'status',
    'participantId',
    'ordinal',
    'mark',
    'valid',
    'verification',
  ],
);
const candidateKey = ['/resultVersionId', '/participantId', '/ordinal'];

/**
 * The ONLY input of the pure ranking engine (ADR-0048): one exact RankingSystemVersion (spec embedded
 * + hash), the DisciplineVersion identity, the as-of sporting cutoff and the candidate Performances
 * with their canonical facts. Deliberately NOT called a snapshot (a RankingSnapshot is the published
 * output). The run trigger and transaction time are never members, so equal inputs hash equally.
 */
export const rankingRunInputV1 = root('br:ranking-run-input', 1, {
  type: 'object',
  additionalProperties: false,
  required: [
    'provenance',
    'assembler',
    'supportedFactKinds',
    'system',
    'discipline',
    'asOf',
    'candidates',
  ],
  properties: {
    provenance,
    assembler: assemblerCode,
    supportedFactKinds: setOf(enumOf(ALL_RANKING_FACT_KINDS)),
    system: obj(
      {
        systemId: uuid,
        code: systemCode,
        kind: enumOf(RANKING_SYSTEM_KINDS),
        systemVersionId: uuid,
        version: { type: 'integer', minimum: 1 },
        specHash: hashRef,
        spec: systemSpecEmbedded,
        lifecycle: enumOf(Object.values(RankingDefinitionLifecycle)),
      },
      ['systemId', 'code', 'kind', 'systemVersionId', 'version', 'specHash', 'spec', 'lifecycle'],
    ),
    discipline: obj(
      {
        disciplineVersionId: uuid,
        sport: sportCode,
        discipline: disciplineCode,
        /**
         * The pinned DisciplineVersion facts of the universe metric: its MetricSpec and the order the
         * DV comparator declares for it (absent ⇒ the DV declares none ⇒ METRIC_NOT_COMPARABLE).
         */
        metric: dvMetric,
      },
      ['disciplineVersionId', 'sport', 'discipline', 'metric'],
    ),
    /** The sporting cutoff: performances after it never enter (PERFORMANCE_AFTER_AS_OF). */
    asOf: timestamp,
    candidates: bounded(setOf(runCandidate, { sortBy: candidateKey, keyUnique: true }), 10_000),
    /** RANKING_PUBLICATION kind (OFFICIAL owner act; NO producer — never present canonically). */
    publication: obj(
      { provenance: enumOf(['REFERENCE_FIXTURE']), ref: uuid, ownerPrincipalId: uuid },
      ['provenance', 'ref', 'ownerPrincipalId'],
    ),
  },
});

/** Deterministic outcome of one run: every candidate accounted for, plus the ordered entries. */
export const rankingRunOutcomeV1 = root('br:ranking-run-outcome', 1, {
  type: 'object',
  additionalProperties: false,
  required: [
    'engineVersion',
    'provenance',
    'inputHash',
    'systemVersionId',
    'specHash',
    'asOf',
    'publication',
    'entries',
    'candidates',
  ],
  properties: {
    engineVersion: rankingEngine,
    provenance,
    /** H(ranking-run-input, …) — the inputs digest. */
    inputHash: hashRef,
    systemVersionId: uuid,
    specHash: hashRef,
    asOf: timestamp,
    publication: obj({ state: enumOf(Object.values(RankingPublicationState)), reasons }, [
      'state',
      'reasons',
    ]),
    entries: rankingEntries,
    candidates: bounded(
      setOf(
        obj(
          {
            resultVersionId: uuid,
            participantId: uuid,
            ordinal: { type: 'integer', minimum: 1 },
            state: enumOf(Object.values(RankingCandidateState)),
            reasons,
          },
          ['resultVersionId', 'participantId', 'ordinal', 'state', 'reasons'],
        ),
        { sortBy: candidateKey, keyUnique: true },
      ),
      10_000,
    ),
  },
});

// ───────────────────────────── ranking snapshot ─────────────────────────────

/**
 * The published, immutable RankingSnapshot content (ADR-0048 §5, §8). A separate derived artefact:
 * no Result lifecycle, no status member (closed schema), never attested or disputed as a Result. It
 * pins the system version + spec hash, the run's input / outcome hashes, engine, provenance, as-of
 * cutoff, lineage (INITIAL | FOLLOWS | CORRECTS a prior snapshot by id + hash) and the entries. Its own
 * id and publication time are persistence attributes, never part of the hashed content.
 */
export const rankingSnapshotV1 = root('br:ranking-snapshot', 1, {
  type: 'object',
  additionalProperties: false,
  required: [
    'systemId',
    'systemVersionId',
    'specHash',
    'kind',
    'method',
    'engineVersion',
    'provenance',
    'runInputHash',
    'runOutcomeHash',
    'asOf',
    'lineage',
    'entries',
  ],
  properties: {
    systemId: uuid,
    systemVersionId: uuid,
    specHash: hashRef,
    kind: enumOf(RANKING_SYSTEM_KINDS),
    method: enumOf(RANKING_METHODS),
    engineVersion: rankingEngine,
    provenance,
    runInputHash: hashRef,
    runOutcomeHash: hashRef,
    asOf: timestamp,
    lineage: obj(
      {
        kind: enumOf(Object.values(RankingSnapshotLineageKind)),
        priorSnapshotId: uuid,
        priorSnapshotHash: hashRef,
        /** CORRECTS only: why (e.g. RESULT_SUPERSEDED, RESULT_REVOKED, VERIFICATION_STALE). */
        reasons,
      },
      ['kind'],
    ),
    /** A published snapshot ranks at least one holder (a run with none is NO_RANKED_ENTRIES). */
    entries: { ...rankingEntries, minItems: 1 },
  },
});

// ───────────────────────────── qualification basis ─────────────────────────────

const underlyingBasis = obj(
  {
    resultVersionId: uuid,
    contentHash: hashRef,
    resultStatus: finalOnly,
    verificationRunId: uuid,
    verificationOutcomeHash: hashRef,
    verificationLevel: level,
  },
  [
    'resultVersionId',
    'contentHash',
    'resultStatus',
    'verificationRunId',
    'verificationOutcomeHash',
    'verificationLevel',
  ],
);

/**
 * The qualifying fact a QUALIFIED Achievement will pin (ADR-0050 §2, §6): target competition, the
 * qualifying ranks N, the holder, EITHER a published snapshot position OR a FINAL classification
 * position, and the underlying verified result versions + runs (AC-1). Consumed by the BRT-08 engine
 * in Step 9; there is no qualification entity.
 */
export const qualificationBasisV1 = root('br:qualification-basis', 1, {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'targetCompetitionId', 'qualifyingRanks', 'holder', 'underlying'],
  properties: {
    kind: enumOf(Object.values(QualificationBasisKind)),
    targetCompetitionId: uuid,
    /** Every holder whose (shared) rank is ≤ N qualifies (ADR-0049 §5). */
    qualifyingRanks: { type: 'integer', minimum: 1, maximum: 10_000 },
    holder: recordHolderSchema,
    ranking: obj(
      {
        systemId: uuid,
        systemVersionId: uuid,
        snapshotId: uuid,
        snapshotHash: hashRef,
        rank,
        tied: { type: 'boolean' },
      },
      ['systemId', 'systemVersionId', 'snapshotId', 'snapshotHash', 'rank', 'tied'],
    ),
    classification: obj(
      {
        resultId: uuid,
        resultVersionId: uuid,
        contentHash: hashRef,
        scopeType: enumOf(['EVENT_CLASSIFICATION', 'COMPETITION_CLASSIFICATION']),
        status: finalOnly,
        participantId: uuid,
        rank,
        tied: { type: 'boolean' },
      },
      [
        'resultId',
        'resultVersionId',
        'contentHash',
        'scopeType',
        'status',
        'participantId',
        'rank',
        'tied',
      ],
    ),
    underlying: bounded(
      setOf(underlyingBasis, { minItems: 1, sortBy: ['/resultVersionId'], keyUnique: true }),
      2048,
    ),
  },
});

export const BRT10_SCHEMAS: readonly BrRootSchema[] = [
  resultVersionContentV2,
  classificationPolicyV1,
  rankingSystemVersionV1,
  rankingUniverseV1,
  rankingRunInputV1,
  rankingRunOutcomeV1,
  rankingSnapshotV1,
  qualificationBasisV1,
  classificationDerivationInputV1,
  classificationDerivationOutcomeV1,
  classificationStalenessV1,
];
