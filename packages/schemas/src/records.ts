import type { BrObjectSchema, BrRootSchema, BrSchema, BrStringSchema } from '@br/canonical';
import {
  ALL_RECORD_FACT_KINDS,
  HolderType,
  MemberCreditRole,
  PopulationDimension,
  RatificationKind,
  RatificationProvenance,
  RECORD_MARK_STATUSES,
  RECORD_SCOPE_TYPES,
  RecordEvaluationState,
  RecordProvenance,
  ResultScopeType,
  ResultVersionStatus,
  TiePolicy,
  VERIFICATION_LEVELS,
} from '@br/domain';
import { enumOf, hashRef, mark, recognitionScope, setOf, timestamp, uuid } from './primitives';
import { verificationSnapshotV1 } from './verification';

/**
 * BRT-09 Record schemas (ADR-0014 BR-JSON + JCS + SHA-256, domain-separated):
 *
 *   br:record-category-version@1        immutable category universe + policy     tag record-category-version
 *   br:record-category-universe@1       the comparison-universe identity          tag record-category-universe
 *   br:record-evaluation-snapshot@1     pure record-engine input                  tag record-evaluation-snapshot
 *   br:record-evaluation-outcome@1      deterministic outcome + trace             tag record-evaluation-outcome
 *   br:record-mark@1                    the RecordMark content                    tag record-mark
 *   br:record-mark-identity@1           natural key                               tag record-mark-identity
 *   br:record-ratification@1            the ratification a status entry pins      tag record-ratification
 *   br:record-replay-input@1            chronological history replay input        tag record-replay
 *   br:record-support-facts@1           current-support assessment input          tag record-support
 *   br:record-mark-fact@1 / br:record-mark-status-fact@1   ledger facts           tag ledger-fact
 *
 * Closed (unknown members rejected), bounded, no floats / nulls / scores; sets never depend on order.
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
const recordProvenance = enumOf(Object.values(RecordProvenance));
const reasonCode = code('^[A-Z][A-Z0-9_]{0,63}$', 64);
const reasons = bounded(setOf(reasonCode), 32);
const categoryCode = code('^[a-z0-9][a-z0-9-]{1,63}$', 64);
const metricKey = code('^[a-z][A-Za-z0-9]{0,63}$', 64);
const markMetricId = code('^[a-z0-9_]+(?:\\.[a-z0-9_]+)*$', 128);
const sportCode = code('^[a-z0-9]+(?:[-_][a-z0-9]+)*$', 64);
const disciplineCode = code('^[a-z0-9_-]+(?:\\.[a-z0-9_-]+)*$', 128);
const regionCode = code('^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$', 6);
const labelCode = code('^[A-Z0-9][A-Z0-9_-]{0,31}$', 32);
const decimal: BrStringSchema = { type: 'string', 'x-br-type': 'decimal' };
const recordEngine = code('^record-engine/[1-9][0-9]{0,3}$', 32);
const scopeType = enumOf(RECORD_SCOPE_TYPES);
const tiePolicy = enumOf(Object.values(TiePolicy));
const comparatorOrder = enumOf(['HIGHER_IS_BETTER', 'LOWER_IS_BETTER']);
const statusNoDraft = enumOf(Object.values(ResultVersionStatus).filter((s) => s !== 'DRAFT'));
const recognitionLevelSchema = enumOf([
  'PLATFORM',
  'CLUB',
  'REGIONAL',
  'NATIONAL',
  'CONTINENTAL',
  'WORLD',
]);
const conditionAspect = enumOf([
  'WIND',
  'TEMPERATURE',
  'HUMIDITY',
  'ALTITUDE',
  'SURFACE',
  'LIGHTING',
  'EQUIPMENT',
  'TIMING_SYSTEM',
  'COURSE_CONFIGURATION',
  'OTHER',
]);
const standing = enumOf(['RATIFIED', 'CANONICAL']);
const holder = obj({ holderType: enumOf(Object.values(HolderType)), holderId: uuid }, [
  'holderType',
  'holderId',
]);

// ───────────────────────────── category version ─────────────────────────────

const categoryScope = obj(
  {
    scopeType,
    /** COMPETITION: the exact competition series (explicit set; a new edition is a new version). */
    competitionIds: bounded(setOf(uuid, { minItems: 1 }), 64),
    /** VENUE: the venue organization. */
    venueOrganizationId: uuid,
    /** LEAGUE: the league organization. */
    leagueOrganizationId: uuid,
    /** NATIONAL: exactly one ISO 3166-1 country; CONTINENTAL: the explicit country set; WORLD: none. */
    region: bounded(setOf(regionCode, { minItems: 1 }), 64),
  },
  ['scopeType'],
);
const universe = obj(
  {
    /** The exact DisciplineVersion whose metric semantics and comparator the category compares. */
    disciplineVersionId: uuid,
    metric: obj({ key: metricKey, markMetricId }, ['key', 'markMetricId']),
    resultScope: enumOf(['CONTEST']),
    holderType: enumOf(Object.values(HolderType)),
  },
  ['disciplineVersionId', 'metric', 'resultScope', 'holderType'],
);
const population = obj({
  handicapMode: enumOf(['SCRATCH', 'HANDICAP']),
  genderCategory: enumOf(['OPEN', 'MEN', 'WOMEN', 'MIXED']),
  ageGroup: labelCode,
  weightClass: labelCode,
  equipmentClass: labelCode,
});
const conditionRequirement = obj(
  {
    aspect: conditionAspect,
    requirement: enumOf(['COMPLIANT', 'MAXIMUM', 'MINIMUM']),
    limit: decimal,
    unit: code('^[a-z0-9%/_-]{1,24}$', 24),
  },
  ['aspect', 'requirement'],
);
const conditionRequirements = bounded(
  setOf(conditionRequirement, { sortBy: ['/aspect', '/requirement'], keyUnique: true }),
  16,
);
const recognition = obj(
  {
    /** The recognition level the ratifying authority's anchor must be recognized at. */
    level: recognitionLevelSchema,
    sport: bounded(setOf(sportCode, { minItems: 1 }), 1),
    discipline: bounded(setOf(disciplineCode, { minItems: 1 }), 1),
    region: bounded(setOf(regionCode, { minItems: 1 }), 64),
  },
  ['level', 'sport'],
);

/**
 * An immutable RecordCategoryVersion (ADR-0043): a declarative comparison universe (metric,
 * DisciplineVersion, scope, population, conditions, tie policy) plus its recognition policy (floor,
 * recognizing authority, canonical keeper, effectiveFrom, naming). No JavaScript, SQL, expression,
 * JSONPath or plugin: every member is a closed enum or a bounded value. Semantic rules (floors,
 * scope ↔ recognition coherence, naming) are enforced by `validateRecordCategorySpec` in @br/records.
 */
export const recordCategoryVersionV1 = root('br:record-category-version', 1, {
  type: 'object',
  additionalProperties: false,
  required: [
    'targetEngine',
    'displayName',
    'scope',
    'universe',
    'tiePolicy',
    'population',
    'conditions',
    'requirements',
    'recognition',
    'effectiveFrom',
  ],
  properties: {
    targetEngine: recordEngine,
    /** Descriptive universe name (recognition words refused; the model computes public labels). */
    displayName: { type: 'string', minLength: 1, maxLength: 80 },
    scope: categoryScope,
    universe,
    tiePolicy,
    population,
    conditions: conditionRequirements,
    requirements: obj(
      { minimumVerificationLevel: level, minimumResultStatus: enumOf(['OFFICIAL', 'FINAL']) },
      ['minimumVerificationLevel', 'minimumResultStatus'],
    ),
    recognition,
    /** PLATFORM only: admit the BRT-01 "V2 + platform review" alternative (REVIEW_COMPLETED). */
    platformReview: { type: 'boolean' },
    /** Explicit canonical-keeper designation (the registry this authority keeps for the universe). */
    canonicalKeeper: obj({ principalId: uuid, registryRef: labelCode }, [
      'principalId',
      'registryRef',
    ]),
    /** Performances before this instant never enter the category (no backdating; ≥ publication). */
    effectiveFrom: timestamp,
  },
});

/** The comparison-universe identity: versions of one category must share it (ADR-0043). */
export const recordCategoryUniverseV1 = root('br:record-category-universe', 1, {
  type: 'object',
  additionalProperties: false,
  required: ['scopeType', 'universe', 'tiePolicy', 'population', 'conditions'],
  properties: {
    scopeType,
    venueOrganizationId: uuid,
    leagueOrganizationId: uuid,
    region: bounded(setOf(regionCode, { minItems: 1 }), 64),
    universe,
    tiePolicy,
    population,
    conditions: conditionRequirements,
  },
});

const categorySpecEmbedded: BrObjectSchema = {
  type: 'object',
  additionalProperties: false,
  required: recordCategoryVersionV1.required ?? [],
  properties: recordCategoryVersionV1.properties,
};

// ───────────────────────────── evaluation snapshot ─────────────────────────────

const governingRecognition = obj(
  {
    recognitionLevel: recognitionLevelSchema,
    anchorId: uuid,
    source: enumOf(['CERTIFICATION', 'SANCTION']),
    anchorFactHash: hashRef,
    recognitionScope,
  },
  ['recognitionLevel', 'anchorId', 'source', 'anchorFactHash'],
);
const verificationSummary = obj(
  {
    state: enumOf(['CURRENT', 'STALE', 'NOT_EVALUATED', 'POLICY_UNAVAILABLE']),
    runId: uuid,
    policyVersionId: uuid,
    snapshotHash: hashRef,
    outcomeHash: hashRef,
    level,
    evidenceBundleHash: hashRef,
    evaluatedAsOf: timestamp,
    governingRecognition,
    /**
     * BRT-07 V4 is per record category: the categories whose RECORD_RATIFIED / REVIEW_COMPLETED the
     * pinned run's passing V4 criterion counted (from its immutable trace). Never present today.
     */
    ratifiedRecordCategoryIds: bounded(setOf(uuid, { minItems: 1 }), 16),
  },
  ['state'],
);
const currentMark = obj(
  {
    recordMarkId: uuid,
    markHash: hashRef,
    holder,
    value: mark,
    effectiveFrom: timestamp,
    standing,
  },
  ['recordMarkId', 'markHash', 'holder', 'value', 'effectiveFrom', 'standing'],
);
const signedAssurance = enumOf(['HOLDER_KEY', 'DEVICE_KEY', 'PLATFORM_WITNESSED']);
const authoritySchema = verificationSnapshotV1.properties?.authority as BrSchema;
const keysSchema = verificationSnapshotV1.properties?.keys as BrSchema;

/**
 * The ONLY input of the pure record engine: one exact verified Performance against one exact
 * RecordCategoryVersion, the category's current record(s), and — when ratifying a pending mark — the
 * ratification fact with the authority facts needed to authorize it. Ids, codes, hashes, marks and
 * platform timestamps only: no names, DOB, legal sex, nationality documents or evidence.
 */
export const recordEvaluationSnapshotV1 = root('br:record-evaluation-snapshot', 1, {
  type: 'object',
  additionalProperties: false,
  required: [
    'provenance',
    'assembler',
    'supportedFactKinds',
    'category',
    'discipline',
    'performance',
    'verification',
    'currentMarks',
  ],
  properties: {
    provenance: recordProvenance,
    assembler: code('^[a-z0-9-]+/[1-9][0-9]{0,3}$', 48),
    supportedFactKinds: bounded(setOf(enumOf(ALL_RECORD_FACT_KINDS)), 16),
    category: obj(
      {
        categoryId: uuid,
        code: categoryCode,
        categoryVersionId: uuid,
        version: { type: 'integer', minimum: 1, maximum: 100000 },
        specHash: hashRef,
        spec: categorySpecEmbedded,
        lifecycle: enumOf(['DRAFT', 'PUBLISHED', 'RETIRED']),
      },
      ['categoryId', 'code', 'categoryVersionId', 'version', 'specHash', 'spec', 'lifecycle'],
    ),
    discipline: obj(
      {
        disciplineVersionId: uuid,
        sport: sportCode,
        discipline: disciplineCode,
        metrics: bounded(
          setOf(
            obj(
              {
                key: metricKey,
                valueType: enumOf(['INTEGER', 'DECIMAL', 'DURATION_MS']),
                unit: code('^[a-z0-9%/_-]{1,24}$', 24),
                order: enumOf(['HIGHER_IS_BETTER', 'LOWER_IS_BETTER', 'ORDINAL']),
              },
              ['key', 'valueType', 'unit'],
            ),
            { sortBy: ['/key'], keyUnique: true },
          ),
          32,
        ),
      },
      ['disciplineVersionId', 'metrics'],
    ),
    performance: obj(
      {
        resultVersionId: uuid,
        resultId: uuid,
        contentHash: hashRef,
        scopeType: enumOf(Object.values(ResultScopeType)),
        status: statusNoDraft,
        /** The ResultVersion this one corrects (absent ⇒ not a correction; never null). */
        supersedesVersionId: uuid,
        supersededByVersionId: uuid,
        competitionId: uuid,
        eventId: uuid,
        contestId: uuid,
        participantId: uuid,
        participantKind: enumOf(['INDIVIDUAL', 'TEAM']),
        athleteId: uuid,
        teamId: uuid,
        /** The athlete named on the Performance itself (team entries). */
        performanceAthleteId: uuid,
        ordinal: { type: 'integer', minimum: 1 },
        mark,
        valid: { type: 'boolean' },
        /** Contest start: the sporting effective time of a record (never DB insertion time). */
        occurredAt: timestamp,
      },
      [
        'resultVersionId',
        'resultId',
        'contentHash',
        'scopeType',
        'status',
        'competitionId',
        'participantId',
        'participantKind',
        'ordinal',
        'mark',
        'valid',
      ],
    ),
    verification: verificationSummary,
    hold: obj({ active: { type: 'boolean' } }, ['active']),
    memberships: obj({
      venueOrganizationId: uuid,
      leagueOrganizationId: uuid,
      regionEligibility: bounded(setOf(regionCode, { minItems: 1 }), 64),
    }),
    /** Typed population facts (POPULATION kind). Absence is never a default value. */
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
    /** Authority-evaluated condition facts (CONDITIONS kind). */
    conditions: bounded(
      setOf(
        obj(
          {
            aspect: conditionAspect,
            compliant: { type: 'boolean' },
            value: decimal,
            unit: code('^[a-z0-9%/_-]{1,24}$', 24),
          },
          ['aspect', 'compliant'],
        ),
        { sortBy: ['/aspect'], keyUnique: true },
      ),
      16,
    ),
    creditedLineup: obj({ athleteIds: bounded(setOf(uuid, { minItems: 1 }), 64) }, ['athleteIds']),
    /** The category's current record(s) at the cutoff (RC-1: ≥ 2 only under SHARED). */
    currentMarks: bounded(setOf(currentMark, { sortBy: ['/recordMarkId'], keyUnique: true }), 64),
    /** Ratification mode: the exact PENDING_RATIFICATION mark being ratified. */
    pendingMark: obj(
      { recordMarkId: uuid, markHash: hashRef, identityHash: hashRef, effectiveFrom: timestamp },
      ['recordMarkId', 'markHash', 'identityHash', 'effectiveFrom'],
    ),
    ratification: obj(
      {
        provenance: enumOf(Object.values(RatificationProvenance)),
        kind: enumOf(Object.values(RatificationKind)),
        ref: uuid,
        polarity: enumOf(['AFFIRM', 'DENY']),
        status: enumOf(['ACTIVE', 'RETRACTED', 'SUSPECT']),
        subject: obj(
          { subjectType: enumOf(['RECORD_MARK']), subjectId: uuid, subjectHash: hashRef },
          ['subjectType', 'subjectId', 'subjectHash'],
        ),
        issuerPrincipalId: uuid,
        issuerPrincipalType: enumOf(['PLATFORM', 'ORGANIZATION', 'PERSON', 'SYSTEM']),
        keyId: uuid,
        assurance: signedAssurance,
        issuedAt: timestamp,
        signedAt: timestamp,
      },
      [
        'provenance',
        'kind',
        'ref',
        'polarity',
        'status',
        'subject',
        'issuerPrincipalId',
        'issuerPrincipalType',
        'keyId',
        'assurance',
        'issuedAt',
      ],
    ),
    keys: keysSchema,
    authority: authoritySchema,
    /** Principals conflicted with the performance (PARTICIPATION kind; ratifier conflict check). */
    participation: obj({ conflictedPrincipalIds: bounded(setOf(uuid), 256) }, [
      'conflictedPrincipalIds',
    ]),
  },
});

// ───────────────────────────── mark content / identity ─────────────────────────────

const basisItem = obj(
  {
    resultVersionId: uuid,
    contentHash: hashRef,
    resultStatus: statusNoDraft,
    verificationRunId: uuid,
    verificationSnapshotHash: hashRef,
    verificationOutcomeHash: hashRef,
    verificationLevel: level,
    participantId: uuid,
    performanceOrdinal: { type: 'integer', minimum: 1 },
    evidenceBundleHash: hashRef,
    evidenceBundleAsOf: timestamp,
  },
  [
    'resultVersionId',
    'contentHash',
    'resultStatus',
    'verificationRunId',
    'verificationSnapshotHash',
    'verificationOutcomeHash',
    'verificationLevel',
    'participantId',
    'performanceOrdinal',
    'evidenceBundleHash',
    'evidenceBundleAsOf',
  ],
);
const consideredMark = obj({ recordMarkId: uuid, markHash: hashRef, value: mark }, [
  'recordMarkId',
  'markHash',
  'value',
]);
const relation = enumOf([
  'NO_CURRENT_RECORD',
  'BETTER',
  'EQUAL_SHARED',
  'EQUAL_FIRST_ACHIEVED_EARLIER',
  'EQUAL',
  'WORSE',
]);

/**
 * The content of ONE RecordMark, exactly as evaluated: pins the category version, the exact verified
 * Performance basis (ResultVersion, content hash, current VerificationRun, evidence commitment,
 * governing recognition), the exact source value, holder, metric, comparator, tie policy, sporting
 * effective time and the comparison basis (the current marks considered). No raw Result content.
 */
export const recordMarkV1 = root('br:record-mark', 1, {
  type: 'object',
  additionalProperties: false,
  required: [
    'provenance',
    'engineVersion',
    'category',
    'scopeType',
    'tiePolicy',
    'comparator',
    'metric',
    'value',
    'holder',
    'memberCreditBasis',
    'basis',
    'basisLevel',
    'evidenceCommitment',
    'context',
    'effectiveFrom',
    'comparison',
  ],
  properties: {
    provenance: recordProvenance,
    engineVersion: recordEngine,
    category: obj(
      {
        categoryId: uuid,
        code: categoryCode,
        categoryVersionId: uuid,
        version: { type: 'integer', minimum: 1, maximum: 100000 },
        specHash: hashRef,
      },
      ['categoryId', 'code', 'categoryVersionId', 'version', 'specHash'],
    ),
    scopeType,
    tiePolicy,
    comparator: comparatorOrder,
    metric: obj({ key: metricKey, markMetricId }, ['key', 'markMetricId']),
    value: mark,
    holder,
    memberCreditBasis: enumOf(['NOT_APPLICABLE', 'CREDITED_LINEUP', 'CREDITED_LINEUP_UNAVAILABLE']),
    memberCredits: bounded(
      setOf(
        obj({ athleteId: uuid, creditRole: enumOf(Object.values(MemberCreditRole)) }, [
          'athleteId',
          'creditRole',
        ]),
        { sortBy: ['/athleteId'], keyUnique: true },
      ),
      64,
    ),
    basis: basisItem,
    basisLevel: level,
    evidenceCommitment: hashRef,
    governingRecognition,
    context: obj(
      {
        competitionId: uuid,
        eventId: uuid,
        contestId: uuid,
        disciplineVersionId: uuid,
        sport: sportCode,
        discipline: disciplineCode,
      },
      ['competitionId', 'disciplineVersionId'],
    ),
    effectiveFrom: timestamp,
    comparison: obj(
      {
        relation,
        currentMarks: bounded(
          setOf(consideredMark, { sortBy: ['/recordMarkId'], keyUnique: true }),
          64,
        ),
      },
      ['relation', 'currentMarks'],
    ),
  },
});

/** Natural key: one logical mark per (category, holder, exact value, exact Performance basis). */
export const recordMarkIdentityV1 = root('br:record-mark-identity', 1, {
  type: 'object',
  additionalProperties: false,
  required: ['categoryId', 'holder', 'value', 'basis'],
  properties: {
    categoryId: uuid,
    holder,
    value: mark,
    basis: obj(
      {
        resultVersionId: uuid,
        contentHash: hashRef,
        participantId: uuid,
        performanceOrdinal: { type: 'integer', minimum: 1 },
      },
      ['resultVersionId', 'contentHash', 'participantId', 'performanceOrdinal'],
    ),
  },
});

// ───────────────────────────── outcome ─────────────────────────────

export const recordEvaluationOutcomeV1 = root('br:record-evaluation-outcome', 1, {
  type: 'object',
  additionalProperties: false,
  required: [
    'engineVersion',
    'snapshotHash',
    'provenance',
    'categoryVersionId',
    'resultVersionId',
    'participantId',
    'performanceOrdinal',
    'mode',
    'state',
    'gates',
  ],
  properties: {
    engineVersion: recordEngine,
    snapshotHash: hashRef,
    provenance: recordProvenance,
    categoryVersionId: uuid,
    resultVersionId: uuid,
    participantId: uuid,
    performanceOrdinal: { type: 'integer', minimum: 1 },
    mode: enumOf(['ESTABLISH', 'RATIFY']),
    state: enumOf(Object.values(RecordEvaluationState)),
    markStatus: enumOf(['PENDING_RATIFICATION', 'RATIFIED', 'CANONICAL']),
    gates: bounded(
      setOf(
        obj({ gate: reasonCode, status: enumOf(['PASS', 'FAIL']), reasons }, ['gate', 'status']),
        { sortBy: ['/gate'], keyUnique: true },
      ),
      24,
    ),
    comparison: obj(
      {
        comparator: comparatorOrder,
        tiePolicy,
        candidateValue: mark,
        relation,
        currentMarks: bounded(
          setOf(consideredMark, { sortBy: ['/recordMarkId'], keyUnique: true }),
          64,
        ),
        displaces: bounded(setOf(uuid), 64),
      },
      ['comparator', 'tiePolicy', 'candidateValue', 'relation', 'currentMarks', 'displaces'],
    ),
    candidate: obj(
      {
        candidateHash: hashRef,
        identityHash: hashRef,
        candidate: {
          type: 'object',
          additionalProperties: false,
          required: recordMarkV1.required ?? [],
          properties: recordMarkV1.properties,
        },
      },
      ['candidateHash', 'identityHash', 'candidate'],
    ),
    ratification: obj(
      {
        ref: uuid,
        kind: enumOf(Object.values(RatificationKind)),
        standing,
        subjectHash: hashRef,
        authorityProofDigest: hashRef,
        canonicalKeeper: { type: 'boolean' },
        platformReview: { type: 'boolean' },
      },
      ['ref', 'kind', 'standing', 'subjectHash', 'authorityProofDigest', 'canonicalKeeper'],
    ),
  },
});

// ───────────────────────────── ratification / replay / support ─────────────────────────────

/** The ratification a RATIFIED / CANONICAL status entry pins (and a RECORD_SET pins in turn). */
export const recordRatificationV1 = root('br:record-ratification', 1, {
  type: 'object',
  additionalProperties: false,
  required: [
    'recordMarkId',
    'markHash',
    'provenance',
    'kind',
    'ref',
    'subjectHash',
    'standing',
    'authorityProofDigest',
    'evaluationSnapshotHash',
    'evaluationOutcomeHash',
    'verificationRunId',
    'verificationLevel',
  ],
  properties: {
    recordMarkId: uuid,
    markHash: hashRef,
    provenance: enumOf(Object.values(RatificationProvenance)),
    kind: enumOf(Object.values(RatificationKind)),
    ref: uuid,
    subjectHash: hashRef,
    standing,
    authorityProofDigest: hashRef,
    evaluationSnapshotHash: hashRef,
    evaluationOutcomeHash: hashRef,
    verificationRunId: uuid,
    verificationLevel: level,
  },
});

/** Chronological replay input (RC-1…RC-3): every mark of one category with its validity. */
export const recordReplayInputV1 = root('br:record-replay-input', 1, {
  type: 'object',
  additionalProperties: false,
  required: ['categoryId', 'tiePolicy', 'comparator', 'marks'],
  properties: {
    categoryId: uuid,
    tiePolicy,
    comparator: comparatorOrder,
    marks: bounded(
      setOf(
        obj(
          {
            recordMarkId: uuid,
            value: mark,
            effectiveFrom: timestamp,
            /** Ratification order (tie-break after the sporting time). */
            ratifiedSeq: { type: 'integer', minimum: 0 },
            standing,
            valid: { type: 'boolean' },
          },
          ['recordMarkId', 'value', 'effectiveFrom', 'ratifiedSeq', 'standing', 'valid'],
        ),
        { sortBy: ['/recordMarkId'], keyUnique: true },
      ),
      10000,
    ),
  },
});

/** Current-support facts of a standing mark (temporary suspension ≠ rescission, BRT-01 §4 / §5.3). */
export const recordSupportFactsV1 = root('br:record-support-facts', 1, {
  type: 'object',
  additionalProperties: false,
  required: ['provenance', 'recordMarkId', 'requiredLevel', 'basisStatus'],
  properties: {
    provenance: recordProvenance,
    recordMarkId: uuid,
    requiredLevel: level,
    /** V4 categories: the run's V4 must have counted THIS category's ratification (BRT-07). */
    v4CategoryId: uuid,
    pinnedRunId: uuid,
    basisStatus: statusNoDraft,
    supersededByVersionId: uuid,
    verification: verificationSummary,
    holdSupported: { type: 'boolean' },
    holdActive: { type: 'boolean' },
    /** A corrected successor performance was evaluated against the category (correction path). */
    successor: enumOf(['QUALIFIES', 'NO_LONGER_QUALIFIES', 'PENDING']),
  },
});

// ───────────────────────────── ledger facts ─────────────────────────────

export const recordMarkFactV1 = root('br:record-mark-fact', 1, {
  type: 'object',
  additionalProperties: false,
  required: [
    'recordMarkId',
    'identityHash',
    'markHash',
    'evaluationSnapshotHash',
    'evaluationOutcomeHash',
    'provenance',
  ],
  properties: {
    recordMarkId: uuid,
    identityHash: hashRef,
    markHash: hashRef,
    evaluationSnapshotHash: hashRef,
    evaluationOutcomeHash: hashRef,
    provenance: recordProvenance,
  },
});

export const recordMarkStatusFactV1 = root('br:record-mark-status-fact', 1, {
  type: 'object',
  additionalProperties: false,
  required: ['statusEntryId', 'recordMarkId', 'status'],
  properties: {
    statusEntryId: uuid,
    recordMarkId: uuid,
    status: enumOf(RECORD_MARK_STATUSES),
    reasons,
    effectiveTo: timestamp,
    supersededByMarkId: uuid,
    ratificationHash: hashRef,
    replayHash: hashRef,
    supportFactsHash: hashRef,
  },
});

export const BRT09_SCHEMAS: readonly BrRootSchema[] = [
  recordCategoryVersionV1,
  recordCategoryUniverseV1,
  recordEvaluationSnapshotV1,
  recordEvaluationOutcomeV1,
  recordMarkV1,
  recordMarkIdentityV1,
  recordRatificationV1,
  recordReplayInputV1,
  recordSupportFactsV1,
  recordMarkFactV1,
  recordMarkStatusFactV1,
];

/** Fragments shared with BRT-10 rankings (the same vocabulary, never a copy). */
export {
  holder as recordHolderSchema,
  population as recordPopulationSchema,
  governingRecognition as governingRecognitionSchema,
  verificationSummary as verificationSummarySchema,
  recognition as recordRecognitionSchema,
};
