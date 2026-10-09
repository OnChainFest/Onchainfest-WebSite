import type { BrObjectSchema, BrRootSchema, BrSchema, BrStringSchema } from '@br/canonical';
import {
  ACHIEVEMENT_TYPES,
  ALL_DERIVATION_FACT_KINDS,
  AchievementStatus,
  DerivationProvenance,
  HolderType,
  MemberCreditRole,
  QualificationBasisKind,
  RANKING_SNAPSHOT_STALE_REASONS,
  CLASSIFICATION_STALE_REASONS,
  ResultOutcome,
  ResultScopeType,
  ResultVersionStatus,
  VERIFICATION_LEVELS,
} from '@br/domain';
import { enumOf, hashRef, mark, recognitionScope, setOf, timestamp, uuid } from './primitives';

/**
 * BRT-08 Verified Achievement schemas (ADR-0014 BR-JSON + JCS + SHA-256, domain-separated):
 *
 *   br:achievement-rule@1                  declarative rule spec             tag achievement-rule
 *   br:achievement-derivation-snapshot@1   pure-engine input                 tag achievement-derivation-snapshot
 *   br:achievement-derivation-outcome@1    deterministic outcome + trace     tag achievement-derivation-outcome
 *   br:achievement-candidate@1             the Achievement content           tag achievement-candidate
 *   br:achievement-identity@1              natural key (AC-2)                tag achievement-identity
 *   br:achievement-support-facts@1         current-support assessment input  tag achievement-support
 *   br:achievement-fact@1                  ledger fact of a persisted one    tag ledger-fact
 *   br:achievement-status-fact@1           ledger fact of a status entry     tag ledger-fact
 *
 * Closed (unknown members rejected), bounded, no floats / nulls / scores. Collections are BR-JSON
 * sets, so insertion order never changes a hash.
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
const achievementType = enumOf(ACHIEVEMENT_TYPES);
const holderType = enumOf(Object.values(HolderType));
const provenance = enumOf(Object.values(DerivationProvenance));
const reasonCode = code('^[A-Z][A-Z0-9_]{0,63}$', 64);
const reasons = bounded(setOf(reasonCode), 16);
const ruleEngine = code('^achievement-engine/[1-9][0-9]{0,3}$', 32);
const ruleCode = code('^[a-z0-9][a-z0-9-]{1,63}$', 64);
const metricKey = code('^[a-z][A-Za-z0-9]{0,63}$', 64);
const markMetricId = code('^[a-z0-9_]+(?:\\.[a-z0-9_]+)*$', 128);
const decimal: BrStringSchema = { type: 'string', 'x-br-type': 'decimal' };
const statusNoDraft = enumOf(Object.values(ResultVersionStatus).filter((s) => s !== 'DRAFT'));
// RECORD_CATEGORY (BRT-09): the scope of a RECORD_SET Achievement is the record category universe.
const achievementScopeType = enumOf([
  'CONTEST',
  'ROUND',
  'EVENT',
  'COMPETITION',
  'CAREER',
  'RECORD_CATEGORY',
]);
const verificationState = enumOf(['CURRENT', 'STALE', 'NOT_EVALUATED', 'POLICY_UNAVAILABLE']);

// ───────────────────────────── rule ─────────────────────────────

/**
 * Declarative AchievementRule spec. One criterion drawn from a closed vocabulary with bounded
 * parameters; no expression language, script, SQL, plugin or boolean tree. Semantic rules (type ↔
 * criterion kind, platform floors, metric references against the exact DisciplineVersion) are
 * enforced by `validateAchievementRuleSpec` in @br/achievements.
 */
export const achievementRuleV1 = root('br:achievement-rule', 1, {
  type: 'object',
  additionalProperties: false,
  required: [
    'targetEngine',
    'achievementType',
    'displayName',
    'disciplineVersionId',
    'holder',
    'requirements',
    'criterion',
  ],
  properties: {
    targetEngine: ruleEngine,
    achievementType,
    /** Public label (bounded; recognition-level claims such as "national" are refused). */
    displayName: { type: 'string', minLength: 1, maxLength: 80 },
    /** The exact DisciplineVersion whose semantics (metrics, comparator) the rule is written for. */
    disciplineVersionId: uuid,
    holder: enumOf(['ENTRY_PARTICIPANT', 'PERFORMER']),
    requirements: obj(
      {
        minimumVerificationLevel: level,
        minimumResultStatus: enumOf(['OFFICIAL', 'FINAL']),
      },
      ['minimumVerificationLevel', 'minimumResultStatus'],
    ),
    criterion: obj(
      {
        kind: enumOf([
          'CLASSIFICATION_POSITION',
          'CLASSIFICATION_COMPLETION',
          'CONTEST_OUTCOME',
          'PERFORMANCE_THRESHOLD',
          'PERSONAL_BEST',
          // BRT-09 RECORD_SET: the Performance basis of a validly RATIFIED / CANONICAL RecordMark.
          'RECORD_MARK_RATIFIED',
          // BRT-10 QUALIFIED (achievement-engine/3): a position ≤ N in the rule's pinned source.
          'QUALIFYING_POSITION',
        ]),
        resultScope: enumOf(Object.values(ResultScopeType)),
        rank: obj(
          {
            min: { type: 'integer', minimum: 1, maximum: 1000 },
            max: { type: 'integer', minimum: 1, maximum: 1000 },
          },
          ['min', 'max'],
        ),
        outcomes: bounded(setOf(enumOf(['WIN', 'WALKOVER_WIN']), { minItems: 1 }), 2),
        metric: obj({ key: metricKey, markMetricId }, ['key', 'markMetricId']),
        operator: enumOf(['GTE', 'GT', 'LTE', 'LT', 'EQ']),
        threshold: decimal,
        firstEligibleEstablishesBest: { type: 'boolean' },
        /**
         * AC-4 structural recognition claim of a TITLE / PLACEMENT (V3+, never PLATFORM). `region`
         * uses the authority-scope vocabulary (ISO 3166-1 alpha-2 / ISO 3166-2 codes; a continental
         * claim is the explicit set of its countries). The label can never widen it.
         */
        recognitionClaim: obj(
          {
            level: enumOf(['REGIONAL', 'NATIONAL', 'CONTINENTAL', 'WORLD']),
            region: bounded(setOf(code('^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$', 6), { minItems: 1 }), 64),
          },
          ['level'],
        ),
        /**
         * QUALIFYING_POSITION only (ADR-0050 §2): the target competition, the qualifying ranks N and
         * the exact pinned source — a ranking system version (RANKING_SNAPSHOT_POSITION) or one
         * classification scope under one classification policy version (CLASSIFICATION_POSITION).
         */
        qualification: obj(
          {
            targetCompetitionId: uuid,
            qualifyingRanks: { type: 'integer', minimum: 1, maximum: 10_000 },
            source: obj(
              {
                kind: enumOf(Object.values(QualificationBasisKind)),
                rankingSystemId: uuid,
                rankingSystemVersionId: uuid,
                scopeType: enumOf(['EVENT_CLASSIFICATION', 'COMPETITION_CLASSIFICATION']),
                scopeId: uuid,
                policyVersionId: uuid,
              },
              ['kind'],
            ),
          },
          ['targetCompetitionId', 'qualifyingRanks', 'source'],
        ),
      },
      ['kind', 'resultScope'],
    ),
  },
});

const ruleSpecEmbedded: BrObjectSchema = {
  type: 'object',
  additionalProperties: false,
  required: achievementRuleV1.required ?? [],
  properties: achievementRuleV1.properties,
};

// ───────────────────────────── snapshot ─────────────────────────────

const recognitionLevelSchema = enumOf([
  'PLATFORM',
  'CLUB',
  'REGIONAL',
  'NATIONAL',
  'CONTINENTAL',
  'WORLD',
]);
/**
 * BRT-01 §8.1 governingAuthority, as pinned from the IMMUTABLE trace of the VerificationRun: the
 * trust anchor backing the certification (V2 OFFICIAL_DECLARATION) or the sanction (V3), and the
 * recognition level it establishes. Never read from today's mutable authority state.
 */
const governingRecognition = obj(
  {
    recognitionLevel: recognitionLevelSchema,
    anchorId: uuid,
    source: enumOf(['CERTIFICATION', 'SANCTION']),
    /** fact_hash of the immutable trust-anchor fact the pinned trace names (re-verified). */
    anchorFactHash: hashRef,
    /**
     * The anchor's recognition scope (BRT-03 vocabulary: recognitionLevel, sport, discipline,
     * region) from that immutable, hash-verified fact. Absent ⇒ unknown ⇒ every claim fails closed.
     */
    recognitionScope,
  },
  ['recognitionLevel', 'anchorId', 'source', 'anchorFactHash'],
);
const verificationSummary = obj(
  {
    state: verificationState,
    runId: uuid,
    policyVersionId: uuid,
    snapshotHash: hashRef,
    outcomeHash: hashRef,
    level,
    /** The BRT-06 Evidence Bundle hash the run evaluated (evidence + attestation input identity). */
    evidenceBundleHash: hashRef,
    /** The run's own cutoff (the bundle's asOf) — a fact of the run, not a derivation cutoff. */
    evaluatedAsOf: timestamp,
    governingRecognition,
  },
  ['state'],
);

/**
 * BRT-09 (ADR-0045): the exact RecordMark a RECORD_SET recognizes — its identity + content hash, the
 * category version it was evaluated under, and the ratification status entry (+ hash of the pinned
 * br:record-ratification@1 document) that made it valid. The mark row itself is never mutated to
 * point at the Achievement: the link is this immutable, hash-bound pin (append-only).
 */
const recordPin = {
  recordMarkId: uuid,
  markHash: hashRef,
  categoryId: uuid,
  categoryVersionId: uuid,
  categoryVersionHash: hashRef,
  scopeType: enumOf([
    'PERSONAL',
    'VENUE',
    'COMPETITION',
    'LEAGUE',
    'PLATFORM',
    'NATIONAL',
    'CONTINENTAL',
    'WORLD',
  ]),
  standing: enumOf(['RATIFIED', 'CANONICAL']),
  ratificationEntryId: uuid,
  ratificationHash: hashRef,
  recognitionLevel: recognitionLevelSchema,
} as const;
const recordHolder = obj({ holderType, holderId: uuid }, ['holderType', 'holderId']);
const recordPinRequired = [
  'recordMarkId',
  'markHash',
  'categoryId',
  'categoryVersionId',
  'categoryVersionHash',
  'scopeType',
  'standing',
  'ratificationEntryId',
  'ratificationHash',
  'recognitionLevel',
] as const;

const performanceFact = {
  participantId: uuid,
  athleteId: uuid,
  ordinal: { type: 'integer', minimum: 1 },
  mark,
  valid: { type: 'boolean' },
} as const;

// ───────────────────────────── qualification (BRT-10) ─────────────────────────────

/** The pinned verified basis of one ranked holder, copied from the snapshot entry (ADR-0048 §4.2). */
const rankingBasisPin = obj(
  {
    resultVersionId: uuid,
    contentHash: hashRef,
    participantId: uuid,
    verificationRunId: uuid,
    verificationSnapshotHash: hashRef,
    verificationOutcomeHash: hashRef,
    verificationLevel: level,
    evidenceBundleHash: hashRef,
    evidenceBundleAsOf: timestamp,
  },
  [
    'resultVersionId',
    'contentHash',
    'participantId',
    'verificationRunId',
    'verificationSnapshotHash',
    'verificationOutcomeHash',
    'verificationLevel',
    'evidenceBundleHash',
    'evidenceBundleAsOf',
  ],
);
const qualificationHolder = obj({ holderType, holderId: uuid }, ['holderType', 'holderId']);
const sourceStaleness = (codes: readonly string[]) =>
  obj(
    {
      state: enumOf(['CURRENT', 'STALE']),
      reasons: bounded(setOf(enumOf(codes)), 8),
    },
    ['state'],
  );

/**
 * BRT-10 QUALIFIED facts (ADR-0050). EITHER `ranking` (a ranking run of one system version — with its
 * PUBLISHED snapshot when one exists, its lineage, whether a correction replaces it and its read-time
 * staleness) OR `classification` (one `@2` classification ResultVersion with its derivation header,
 * status, BRT-07 verification and read-time staleness). `targetAuthority` is the target competition's
 * adoption of the rule — a kind with NO producer: only REFERENCE_FIXTURE snapshots carry it.
 */
const qualificationFacts = obj({
  ranking: obj(
    {
      systemId: uuid,
      systemVersionId: uuid,
      specHash: hashRef,
      runId: uuid,
      runOutcomeHash: hashRef,
      /** Absent ⇒ the run was never published (RANKING_SNAPSHOT_NOT_PUBLISHED). */
      published: obj(
        {
          snapshotId: uuid,
          snapshotHash: hashRef,
          lineageKind: enumOf(['INITIAL', 'FOLLOWS', 'CORRECTS']),
          priorSnapshotId: uuid,
          priorSnapshotHash: hashRef,
        },
        ['snapshotId', 'snapshotHash', 'lineageKind'],
      ),
      /** The snapshot that corrects this one, if any (RANKING_SNAPSHOT_CORRECTED). */
      correctedBySnapshotId: uuid,
      staleness: sourceStaleness(RANKING_SNAPSHOT_STALE_REASONS),
      entries: bounded(
        setOf(
          obj(
            {
              holder: qualificationHolder,
              rank: { type: 'integer', minimum: 1, maximum: 1_000_000 },
              tied: { type: 'boolean' },
              basis: bounded(
                setOf(rankingBasisPin, {
                  minItems: 1,
                  sortBy: ['/resultVersionId', '/participantId'],
                  keyUnique: true,
                }),
                64,
              ),
            },
            ['holder', 'rank', 'tied', 'basis'],
          ),
          { sortBy: ['/holder/holderType', '/holder/holderId'], keyUnique: true },
        ),
        10_000,
      ),
    },
    ['systemId', 'systemVersionId', 'specHash', 'runId', 'runOutcomeHash', 'staleness', 'entries'],
  ),
  classification: obj(
    {
      resultId: uuid,
      resultVersionId: uuid,
      contentHash: hashRef,
      scopeType: enumOf(['EVENT_CLASSIFICATION', 'COMPETITION_CLASSIFICATION']),
      scopeTargetId: uuid,
      status: statusNoDraft,
      supersedesVersionId: uuid,
      supersededByVersionId: uuid,
      policyId: uuid,
      policyVersionId: uuid,
      policySpecHash: hashRef,
      disciplineVersionId: uuid,
      inputsDigest: hashRef,
      staleness: sourceStaleness(CLASSIFICATION_STALE_REASONS),
      verification: verificationSummary,
      entries: bounded(
        setOf(
          obj(
            {
              participantId: uuid,
              rank: { type: 'integer', minimum: 1, maximum: 1_000_000 },
              tied: { type: 'boolean' },
            },
            ['participantId', 'tied'],
          ),
          { sortBy: ['/participantId'], keyUnique: true },
        ),
        10_000,
      ),
      participants: bounded(
        setOf(
          obj(
            {
              participantId: uuid,
              kind: enumOf(['INDIVIDUAL', 'TEAM']),
              athleteId: uuid,
              teamId: uuid,
            },
            ['participantId', 'kind'],
          ),
          { sortBy: ['/participantId'], keyUnique: true },
        ),
        10_000,
      ),
    },
    [
      'resultId',
      'resultVersionId',
      'contentHash',
      'scopeType',
      'scopeTargetId',
      'status',
      'policyId',
      'policyVersionId',
      'policySpecHash',
      'disciplineVersionId',
      'inputsDigest',
      'staleness',
      'verification',
      'entries',
      'participants',
    ],
  ),
  /** Present only when HOLD_STATE is a supported kind: an admitted hold on any qualifying basis. */
  hold: obj({ active: { type: 'boolean' } }, ['active']),
  /** TARGET_QUALIFICATION_AUTHORITY (no producer): the target authority's adoption of this rule. */
  targetAuthority: obj(
    {
      targetCompetitionId: uuid,
      ruleVersionId: uuid,
      ruleSpecHash: hashRef,
      adoptionId: uuid,
      adoptionHash: hashRef,
      status: enumOf(['ADOPTED', 'WITHDRAWN']),
    },
    [
      'targetCompetitionId',
      'ruleVersionId',
      'ruleSpecHash',
      'adoptionId',
      'adoptionHash',
      'status',
    ],
  ),
});

/**
 * The deterministic Achievement-engine input: ONE exact ResultVersion under ONE rule version, as
 * known at a cutoff. The cutoff is metadata, never a member (identical facts ⇒ one hash). Ids, codes,
 * hashes and platform timestamps only — no names, slugs, PII or evidence.
 */
export const achievementDerivationSnapshotV1 = root('br:achievement-derivation-snapshot', 1, {
  type: 'object',
  additionalProperties: false,
  // hierarchy / resultVersion / verification / entries / participants are required for every
  // ResultVersion derivation and ABSENT from a QUALIFYING_POSITION derivation (BRT-10), whose facts
  // are all in `qualification` — exactly one of the two shapes (enforced by sealDerivationSnapshot).
  // Relaxing `required` changes no existing document or hash.
  required: ['provenance', 'assembler', 'rule', 'supportedFactKinds', 'discipline'],
  properties: {
    provenance,
    assembler: code('^[a-z0-9-]+/[1-9][0-9]{0,3}$', 48),
    rule: obj(
      {
        ruleId: uuid,
        ruleVersionId: uuid,
        code: ruleCode,
        version: { type: 'integer', minimum: 1, maximum: 100000 },
        specHash: hashRef,
        spec: ruleSpecEmbedded,
        bindingId: uuid,
      },
      ['ruleId', 'ruleVersionId', 'code', 'version', 'specHash', 'spec', 'bindingId'],
    ),
    supportedFactKinds: bounded(setOf(enumOf(ALL_DERIVATION_FACT_KINDS)), 8),
    discipline: obj(
      {
        disciplineVersionId: uuid,
        sport: code('^[a-z0-9]+(?:[-_][a-z0-9]+)*$', 64),
        discipline: code('^[a-z0-9_-]+(?:\\.[a-z0-9_-]+)*$', 128),
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
    hierarchy: obj({ competitionId: uuid, eventId: uuid, roundId: uuid, contestId: uuid }, [
      'competitionId',
    ]),
    resultVersion: obj(
      {
        resultVersionId: uuid,
        resultId: uuid,
        versionNumber: { type: 'integer', minimum: 1 },
        contentHash: hashRef,
        scopeType: enumOf(Object.values(ResultScopeType)),
        scopeTargetId: uuid,
        submittedAt: timestamp,
        /** As of the cutoff, from append-only status transitions (read only). */
        status: statusNoDraft,
        supersedesVersionId: uuid,
        supersededByVersionId: uuid,
      },
      [
        'resultVersionId',
        'resultId',
        'versionNumber',
        'contentHash',
        'scopeType',
        'scopeTargetId',
        'submittedAt',
        'status',
      ],
    ),
    /** BRT-07 current verification of this exact version (freshness computed at the cutoff). */
    verification: verificationSummary,
    /** Present only when HOLD_STATE is a supported kind. */
    hold: obj({ active: { type: 'boolean' } }, ['active']),
    /** Result content entries (public sporting facts). */
    entries: bounded(
      setOf(
        obj(
          {
            participantId: uuid,
            outcome: enumOf(Object.values(ResultOutcome)),
            rank: { type: 'integer', minimum: 1 },
          },
          ['participantId', 'outcome'],
        ),
        { sortBy: ['/participantId'], keyUnique: true },
      ),
      256,
    ),
    performances: bounded(
      setOf(obj(performanceFact, ['participantId', 'ordinal', 'mark', 'valid']), {
        sortBy: ['/participantId', '/ordinal'],
        keyUnique: true,
      }),
      1024,
    ),
    participants: bounded(
      setOf(
        obj(
          {
            participantId: uuid,
            kind: enumOf(['INDIVIDUAL', 'TEAM']),
            athleteId: uuid,
            teamId: uuid,
          },
          ['participantId', 'kind'],
        ),
        { sortBy: ['/participantId'], keyUnique: true },
      ),
      256,
    ),
    /** Credited lineups (Result-content facts). Present only when CREDITED_LINEUP is supported. */
    creditedLineups: bounded(
      setOf(
        obj(
          {
            participantId: uuid,
            athleteIds: bounded(setOf(uuid, { minItems: 1 }), 64),
          },
          ['participantId', 'athleteIds'],
        ),
        { sortBy: ['/participantId'], keyUnique: true },
      ),
      256,
    ),
    /** Contest occurrence (start) — the PB temporal order. */
    occurrence: obj({ startedAt: timestamp }, ['startedAt']),
    /**
     * RECORD_SET only (RECORD_RATIFICATION kind): the RecordMark facts — its pin, current status,
     * category floor, holder and exact Performance basis + value.
     */
    record: obj(
      {
        ...recordPin,
        currentStatus: enumOf([
          'PENDING_RATIFICATION',
          'RATIFIED',
          'CANONICAL',
          'SUPERSEDED',
          'RESCINDED',
        ]),
        requiredLevel: level,
        holder: recordHolder,
        participantId: uuid,
        performanceOrdinal: { type: 'integer', minimum: 1 },
        value: mark,
      },
      [
        ...recordPinRequired,
        'currentStatus',
        'requiredLevel',
        'holder',
        'participantId',
        'performanceOrdinal',
        'value',
      ],
    ),
    /** QUALIFIED only (BRT-10, ADR-0050): the qualifying source and the qualification gate facts. */
    qualification: qualificationFacts,
    /** PB only: the athlete's eligible-or-not comparison performances known at the cutoff. */
    comparisons: bounded(
      setOf(
        obj(
          {
            resultVersionId: uuid,
            contentHash: hashRef,
            disciplineVersionId: uuid,
            ...performanceFact,
            occurredAt: timestamp,
            status: statusNoDraft,
            verification: verificationSummary,
          },
          [
            'resultVersionId',
            'contentHash',
            'disciplineVersionId',
            'participantId',
            'athleteId',
            'ordinal',
            'mark',
            'valid',
            'status',
            'verification',
          ],
        ),
        { sortBy: ['/resultVersionId', '/participantId', '/ordinal'], keyUnique: true },
      ),
      1024,
    ),
  },
});

// ───────────────────────────── candidate / identity ─────────────────────────────

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
    /** H(sorted credited athlete ids) of the participant's credited lineup, when credits exist. */
    creditedLineupHash: hashRef,
    /** The pinned run's BRT-06 Evidence Bundle hash and its asOf (reproducible from immutable facts). */
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
    'evidenceBundleHash',
    'evidenceBundleAsOf',
  ],
);
const basisSet = bounded(
  setOf(basisItem, { minItems: 1, sortBy: ['/resultVersionId', '/participantId'] }),
  16,
);
const holder = obj({ holderType, holderId: uuid }, ['holderType', 'holderId']);
const scope = obj({ scopeType: achievementScopeType, scopeId: uuid }, ['scopeType', 'scopeId']);

/**
 * The content of ONE Achievement, exactly as derived. `memberCredits` (TEAM holders only) are part
 * of this immutable content (BRT-01 §8.1, AC-5). No raw result content is copied; `qualifyingValue`
 * exists only for value achievements and equals the referenced Performance mark byte-for-byte.
 */
export const achievementCandidateV1 = root('br:achievement-candidate', 1, {
  type: 'object',
  additionalProperties: false,
  required: [
    'provenance',
    'engineVersion',
    'achievementType',
    'rule',
    'holder',
    'memberCreditBasis',
    'scope',
    'context',
    'basis',
    'basisLevel',
    'evidenceCommitment',
  ],
  properties: {
    provenance,
    engineVersion: code('^achievement-engine/[1-9][0-9]{0,3}$', 32),
    achievementType,
    rule: obj(
      {
        ruleId: uuid,
        ruleVersionId: uuid,
        code: ruleCode,
        version: { type: 'integer', minimum: 1, maximum: 100000 },
        specHash: hashRef,
      },
      ['ruleId', 'ruleVersionId', 'code', 'version', 'specHash'],
    ),
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
    scope,
    context: obj(
      {
        competitionId: uuid,
        eventId: uuid,
        contestId: uuid,
        disciplineVersionId: uuid,
        sport: code('^[a-z0-9]+(?:[-_][a-z0-9]+)*$', 64),
        discipline: code('^[a-z0-9_-]+(?:\\.[a-z0-9_-]+)*$', 128),
      },
      ['competitionId', 'disciplineVersionId'],
    ),
    basis: basisSet,
    /** min(verificationLevel of basis items) at derivation. */
    basisLevel: level,
    qualifyingValue: mark,
    /** PB: hash of the exact comparison set (eligible prior performances) considered. */
    comparisonSetHash: hashRef,
    /** BRT-01 §8.1 evidenceCommitment: H(achievement-evidence-commitment, basis → Evidence Bundles). */
    evidenceCommitment: hashRef,
    /** BRT-01 §8.1 governingAuthority, pinned from the basis run's immutable trace (AC-4). */
    governingAuthority: governingRecognition,
    /** RECORD_SET only: the exact ratified RecordMark this Achievement recognizes (ADR-0045). */
    record: obj(recordPin, recordPinRequired),
    /**
     * QUALIFIED only (ADR-0050 §6): the target, N, the exact qualifying position (snapshot id + hash,
     * or classification version + content hash + policy version), the hash of the
     * br:qualification-basis@1 document (position + underlying FINAL basis + runs) and the target
     * authority's adoption it rests on.
     */
    qualification: obj(
      {
        kind: enumOf(Object.values(QualificationBasisKind)),
        targetCompetitionId: uuid,
        qualifyingRanks: { type: 'integer', minimum: 1, maximum: 10_000 },
        ranking: obj(
          {
            systemId: uuid,
            systemVersionId: uuid,
            snapshotId: uuid,
            snapshotHash: hashRef,
            rank: { type: 'integer', minimum: 1, maximum: 1_000_000 },
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
            policyVersionId: uuid,
            participantId: uuid,
            rank: { type: 'integer', minimum: 1, maximum: 1_000_000 },
            tied: { type: 'boolean' },
          },
          [
            'resultId',
            'resultVersionId',
            'contentHash',
            'scopeType',
            'policyVersionId',
            'participantId',
            'rank',
            'tied',
          ],
        ),
        basisHash: hashRef,
        targetAuthority: obj({ adoptionId: uuid, adoptionHash: hashRef }, [
          'adoptionId',
          'adoptionHash',
        ]),
      },
      ['kind', 'targetCompetitionId', 'qualifyingRanks', 'basisHash', 'targetAuthority'],
    ),
  },
});

/**
 * AC-2 natural key: (achievementType, ruleVersion, holder, scope, basis set) — plus, for QUALIFIED
 * only, the exact qualifying source (ADR-0050 §6). Absent members change no existing hash.
 */
export const achievementIdentityV1 = root('br:achievement-identity', 1, {
  type: 'object',
  additionalProperties: false,
  required: ['achievementType', 'ruleVersionId', 'holder', 'scope', 'basis'],
  properties: {
    achievementType,
    ruleVersionId: uuid,
    holder,
    scope,
    qualificationSource: obj(
      {
        kind: enumOf(Object.values(QualificationBasisKind)),
        sourceId: uuid,
        sourceHash: hashRef,
      },
      ['kind', 'sourceId', 'sourceHash'],
    ),
    basis: bounded(
      setOf(
        obj(
          {
            resultVersionId: uuid,
            contentHash: hashRef,
            verificationRunId: uuid,
            participantId: uuid,
            performanceOrdinal: { type: 'integer', minimum: 1 },
            creditedLineupHash: hashRef,
          },
          ['resultVersionId', 'contentHash', 'verificationRunId', 'participantId'],
        ),
        { minItems: 1, sortBy: ['/resultVersionId', '/participantId'] },
      ),
      16,
    ),
  },
});

// ───────────────────────────── outcome ─────────────────────────────

const candidateEntry = obj(
  {
    candidateHash: hashRef,
    identityHash: hashRef,
    candidate: {
      type: 'object',
      additionalProperties: false,
      required: achievementCandidateV1.required ?? [],
      properties: achievementCandidateV1.properties,
    },
  },
  ['candidateHash', 'identityHash', 'candidate'],
);

/** Deterministic outcome of one derivation, including its explanation trace. */
export const achievementDerivationOutcomeV1 = root('br:achievement-derivation-outcome', 1, {
  type: 'object',
  additionalProperties: false,
  // resultVersionId names the derived ResultVersion; a QUALIFYING_POSITION derivation from a ranking
  // run has none and names its `source` instead (exactly one of the two, enforced by the engine).
  required: ['engineVersion', 'snapshotHash', 'ruleVersionId', 'state', 'gates'],
  properties: {
    engineVersion: code('^achievement-engine/[1-9][0-9]{0,3}$', 32),
    snapshotHash: hashRef,
    provenance,
    ruleVersionId: uuid,
    resultVersionId: uuid,
    /** QUALIFIED only: the qualifying source (ranking run, or classification ResultVersion). */
    source: obj(
      {
        kind: enumOf(Object.values(QualificationBasisKind)),
        sourceId: uuid,
        sourceHash: hashRef,
      },
      ['kind', 'sourceId', 'sourceHash'],
    ),
    /** ISSUABLE: ≥ 1 candidate · BLOCKED: some gate failed · NO_QUALIFYING_FACTS: gates pass, nobody qualifies. */
    state: enumOf(['ISSUABLE', 'BLOCKED', 'NO_QUALIFYING_FACTS']),
    gates: bounded(
      setOf(
        obj({ gate: reasonCode, status: enumOf(['PASS', 'FAIL']), reasons }, ['gate', 'status']),
        {
          sortBy: ['/gate'],
          keyUnique: true,
        },
      ),
      16,
    ),
    /** Per subject (participant / performance): would it qualify on the sporting facts alone? */
    subjects: bounded(
      setOf(
        obj(
          {
            /** participantId, or participantId#ordinal for a performance subject. */
            subjectKey: code('^[0-9a-f-]{36}(?:#[1-9][0-9]{0,5})?$', 44),
            participantId: uuid,
            performanceOrdinal: { type: 'integer', minimum: 1 },
            qualifies: { type: 'boolean' },
            reasons,
          },
          ['subjectKey', 'participantId', 'qualifies'],
        ),
        { sortBy: ['/subjectKey'], keyUnique: true },
      ),
      1024,
    ),
    candidates: bounded(setOf(candidateEntry, { sortBy: ['/identityHash'], keyUnique: true }), 256),
  },
});

// ───────────────────────────── current support ─────────────────────────────

/** Inputs of one current-support assessment (hashed into the status entry). */
export const achievementSupportFactsV1 = root('br:achievement-support-facts', 1, {
  type: 'object',
  additionalProperties: false,
  required: ['provenance', 'achievementId', 'requiredLevel', 'basis'],
  properties: {
    provenance,
    achievementId: uuid,
    requiredLevel: level,
    basis: bounded(
      setOf(
        obj(
          {
            resultVersionId: uuid,
            pinnedRunId: uuid,
            status: statusNoDraft,
            supersededByVersionId: uuid,
            verification: verificationSummary,
          },
          ['resultVersionId', 'pinnedRunId', 'status'],
        ),
        { sortBy: ['/resultVersionId'], keyUnique: true },
      ),
      16,
    ),
    holdSupported: { type: 'boolean' },
    holdActive: { type: 'boolean' },
    replacementAchievementId: uuid,
    successorDerivation: enumOf(['HOLDER_QUALIFIES', 'HOLDER_DOES_NOT_QUALIFY', 'BLOCKED']),
    /** RECORD_SET only: the recognized RecordMark's current status (RESCINDED ⇒ REVOKED). */
    recordMarkStatus: enumOf([
      'PENDING_RATIFICATION',
      'RATIFIED',
      'CANONICAL',
      'SUPERSEDED',
      'RESCINDED',
    ]),
    /** QUALIFIED via a ranking snapshot only: a correcting snapshot replaces the pinned one. */
    qualifyingSnapshotCorrected: { type: 'boolean' },
  },
});

/** A participant's credited lineup inside one ResultVersion (hashed into basis items). */
export const achievementCreditedLineupV1 = root('br:achievement-credited-lineup', 1, {
  type: 'object',
  additionalProperties: false,
  required: ['resultVersionId', 'participantId', 'athleteIds'],
  properties: {
    resultVersionId: uuid,
    participantId: uuid,
    athleteIds: bounded(setOf(uuid, { minItems: 1 }), 64),
  },
});

/**
 * BRT-01 §8.1 evidenceCommitment document: for every basis item, the exact ResultVersion content
 * hash and the BRT-06 Evidence Bundle (hash + asOf) its pinned VerificationRun evaluated. The bundle
 * lists the version's evidence (ids, content + descriptor hashes, lineage) and attestations (ids,
 * statement hashes, proof / retraction / supersession state, signing keys) — exactly the evidence /
 * attestation basis, rebuildable deterministically from immutable BRT-06 facts at that asOf.
 */
export const achievementEvidenceCommitmentV1 = root('br:achievement-evidence-commitment', 1, {
  type: 'object',
  additionalProperties: false,
  required: ['basis'],
  properties: {
    basis: bounded(
      setOf(
        obj(
          {
            resultVersionId: uuid,
            contentHash: hashRef,
            verificationRunId: uuid,
            evidenceBundleHash: hashRef,
            evidenceBundleAsOf: timestamp,
          },
          [
            'resultVersionId',
            'contentHash',
            'verificationRunId',
            'evidenceBundleHash',
            'evidenceBundleAsOf',
          ],
        ),
        { minItems: 1, sortBy: ['/resultVersionId', '/verificationRunId'], keyUnique: true },
      ),
      16,
    ),
  },
});

/** PB: the exact eligible comparison set considered at the cutoff (reproducibility commitment). */
export const achievementComparisonSetV1 = root('br:achievement-comparison-set', 1, {
  type: 'object',
  additionalProperties: false,
  required: ['athleteId', 'disciplineVersionId', 'markMetricId', 'items'],
  properties: {
    athleteId: uuid,
    disciplineVersionId: uuid,
    markMetricId,
    items: bounded(
      setOf(
        obj(
          {
            resultVersionId: uuid,
            contentHash: hashRef,
            participantId: uuid,
            ordinal: { type: 'integer', minimum: 1 },
            value: {
              type: 'string',
              'x-br-type': 'mark-value',
              'x-br-precisionField': 'precision',
            },
            precision: { type: 'integer', minimum: 0, maximum: 9 },
            verificationRunId: uuid,
          },
          [
            'resultVersionId',
            'contentHash',
            'participantId',
            'ordinal',
            'value',
            'precision',
            'verificationRunId',
          ],
        ),
        { sortBy: ['/resultVersionId', '/participantId', '/ordinal'], keyUnique: true },
      ),
      1024,
    ),
  },
});

// ───────────────────────────── ledger facts ─────────────────────────────

export const achievementFactV1 = root('br:achievement-fact', 1, {
  type: 'object',
  additionalProperties: false,
  required: [
    'achievementId',
    'identityHash',
    'candidateHash',
    'derivationSnapshotHash',
    'derivationOutcomeHash',
    'provenance',
  ],
  properties: {
    achievementId: uuid,
    identityHash: hashRef,
    candidateHash: hashRef,
    derivationSnapshotHash: hashRef,
    derivationOutcomeHash: hashRef,
    provenance,
  },
});

export const achievementStatusFactV1 = root('br:achievement-status-fact', 1, {
  type: 'object',
  additionalProperties: false,
  required: ['statusEntryId', 'achievementId', 'status', 'supportFactsHash'],
  properties: {
    statusEntryId: uuid,
    achievementId: uuid,
    status: enumOf(Object.values(AchievementStatus)),
    reasons,
    supersededBy: uuid,
    supportFactsHash: hashRef,
  },
});

export const BRT08_SCHEMAS: readonly BrRootSchema[] = [
  achievementRuleV1,
  achievementDerivationSnapshotV1,
  achievementDerivationOutcomeV1,
  achievementCandidateV1,
  achievementIdentityV1,
  achievementSupportFactsV1,
  achievementCreditedLineupV1,
  achievementComparisonSetV1,
  achievementEvidenceCommitmentV1,
  achievementFactV1,
  achievementStatusFactV1,
];
