import type { BrObjectSchema, BrRootSchema, BrSchema, BrStringSchema } from '@br/canonical';
import {
  ALL_CANONICAL_FACT_KINDS,
  ALL_CRITERION_KINDS,
  ALL_PARTICIPATION_RELATIONS,
  CriterionStatus,
  EvaluationState,
  EvidenceAttachmentRole,
  EvidenceAvailability,
  EvidenceSourceKind,
  EvidenceType,
  GeneratorKind,
  ParticipationResolution,
  RelationTiming,
  ResultScopeType,
  ResultVersionStatus,
  SignatureAssurance,
  SnapshotProvenance,
  VERIFICATION_LEVELS,
  VerificationFlag,
} from '@br/domain';
import {
  authorityScope,
  capability,
  enumOf,
  hashRef,
  recognitionLevel,
  recognitionScope,
  setOf,
  timestamp,
  uuid,
} from './primitives';

/**
 * BRT-07 Verification Engine schemas (ADR-0014 BR-JSON + JCS + SHA-256, domain-separated):
 *
 *   br:verification-policy@1    declarative policy spec          tag verification-policy
 *   br:verification-snapshot@1  deterministic Oracle input       tag verification-snapshot
 *   br:verification-trace@1     per-criterion explanation        tag verification-trace
 *   br:verification-outcome@1   deterministic outcome            tag verification-outcome
 *   br:verification-run-fact@1  ledger fact of a persisted run   tag ledger-fact
 *
 * All are closed (unknown members rejected), bounded (maxItems / maxLength) and contain no floats,
 * nulls, scores, confidences or weights. Collections are BR-JSON sets, so insertion order never
 * changes a hash.
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

export const verificationLevel = enumOf(VERIFICATION_LEVELS);
const criterionId = code('^[a-z0-9][a-z0-9._-]{0,63}$', 64);
const criterionKind = enumOf(ALL_CRITERION_KINDS);
const reasonCode = code('^[A-Z][A-Z0-9_]{0,63}$', 64);
const reasons = bounded(setOf(reasonCode), 16);
const uuidSet = (max: number) => bounded(setOf(uuid), max);
const principalType = enumOf(['PLATFORM', 'ORGANIZATION', 'PERSON', 'SYSTEM']);
const participationRelation = enumOf(ALL_PARTICIPATION_RELATIONS);
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
const engineVersion = code('^verification-engine/[1-9][0-9]{0,3}$', 32);
const hierarchyLevel = enumOf(['COMPETITION', 'EVENT', 'ROUND', 'CONTEST']);

// ───────────────────────────── policy ─────────────────────────────

const criterionParams: BrObjectSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    minIssuers: { type: 'integer', minimum: 1, maximum: 16 },
    minItems: { type: 'integer', minimum: 1, maximum: 16 },
    minSources: { type: 'integer', minimum: 2, maximum: 16 },
    capabilities: bounded(setOf(capability, { minItems: 1 }), 4),
    availability: bounded(setOf(enumOf(['AVAILABLE', 'ARCHIVED']), { minItems: 1 }), 2),
    minRecognitionLevel: enumOf(['REGIONAL', 'NATIONAL', 'CONTINENTAL', 'WORLD']),
  },
};

/**
 * Declarative verification policy spec. Levels are conjunctive lists of closed criterion kinds;
 * there are no expressions, scripts, SQL, plugins or nested boolean trees. Semantic rules (level
 * ancestry, mandatory BRT-01 criteria per level, parameter applicability) are enforced by
 * `validatePolicySpec` in @br/verification before a version can be created or published.
 */
export const verificationPolicyV1 = root('br:verification-policy', 1, {
  type: 'object',
  additionalProperties: false,
  required: ['targetEngine', 'levels'],
  properties: {
    /** The engine semantics this spec was authored for (a new engine major needs a new spec). */
    targetEngine: engineVersion,
    levels: bounded(
      setOf(
        {
          type: 'object',
          additionalProperties: false,
          required: ['level', 'requiresPreviousLevel', 'criteria'],
          properties: {
            level: verificationLevel,
            requiresPreviousLevel: { type: 'boolean' },
            criteria: bounded(
              setOf(
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'kind'],
                  properties: { id: criterionId, kind: criterionKind, params: criterionParams },
                },
                { minItems: 1, sortBy: ['/id'], keyUnique: true },
              ),
              16,
            ),
          },
        },
        { minItems: 1, sortBy: ['/level'], keyUnique: true },
      ),
      5,
    ),
    conflict: {
      type: 'object',
      additionalProperties: false,
      properties: {
        /** Relations that ALSO make an issuer conflicted (BRT-01 rule 7 relations always do). */
        additionalProhibitedRelations: bounded(
          setOf(participationRelation, { minItems: 1 }),
          ALL_PARTICIPATION_RELATIONS.length,
        ),
      },
    },
  },
});

// ───────────────────────────── snapshot ─────────────────────────────

const signedFactProps = {
  attestationId: uuid,
  statementHash: hashRef,
  issuerPrincipalId: uuid,
  issuerPrincipalType: principalType,
  keyId: uuid,
  assurance: enumOf(Object.values(SignatureAssurance)),
  /** Platform-observed acceptance time (authority evaluation time T). */
  issuedAt: timestamp,
  /** Signer assertion: only ever restricts (compromise t₀ ≤ signedAt). */
  signedAt: timestamp,
  /** Stored proof re-verified by the assembler; anything else is an integrity failure. */
  proof: enumOf(['VERIFIED']),
  polarity: enumOf(['AFFIRM', 'DENY']),
  /** As of the snapshot cutoff: retraction / supersession facts recorded ≤ asOf. */
  status: enumOf(['ACTIVE', 'RETRACTED', 'SUPERSEDED']),
} as const;
const signedFactRequired = [
  'attestationId',
  'statementHash',
  'issuerPrincipalId',
  'issuerPrincipalType',
  'keyId',
  'assurance',
  'issuedAt',
  'proof',
  'polarity',
  'status',
];

const signedFactSet = (
  extra: Record<string, BrSchema>,
  extraRequired: string[],
  maxItems: number,
) =>
  bounded(
    setOf(
      {
        type: 'object',
        additionalProperties: false,
        required: [...signedFactRequired, ...extraRequired],
        properties: { ...signedFactProps, ...extra },
      },
      { sortBy: ['/attestationId'], keyUnique: true },
    ),
    maxItems,
  );

const snapshotPolicy: BrObjectSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['policyId', 'policyVersionId', 'code', 'version', 'specHash', 'spec'],
  properties: {
    policyId: uuid,
    policyVersionId: uuid,
    code: code('^[a-z0-9][a-z0-9-]{1,63}$', 64),
    version: { type: 'integer', minimum: 1, maximum: 100000 },
    specHash: hashRef,
    spec: {
      type: 'object',
      additionalProperties: false,
      required: verificationPolicyV1.required ?? [],
      properties: verificationPolicyV1.properties,
    },
  },
};

/**
 * The deterministic Oracle input for ONE exact ResultVersion under ONE policy version, as known at a
 * knowledge cutoff. The cutoff (`asOf`) is evaluation metadata and is NOT a member: two snapshots
 * assembled at different cutoffs over identical facts ARE the same input (BRT-02 verification §1.1:
 * the digest excludes evaluation timestamps), which is what hash-based freshness relies on. For the
 * same reason the BRT-06 bundle hash (which embeds its own asOf) is run metadata, not a member: the
 * bundle's facts themselves are represented here.
 */
export const verificationSnapshotV1 = root('br:verification-snapshot', 1, {
  type: 'object',
  additionalProperties: false,
  required: [
    'provenance',
    'assembler',
    'policy',
    'resultVersion',
    'hierarchy',
    'discipline',
    'supportedFactKinds',
    'authority',
    'participation',
  ],
  properties: {
    provenance: enumOf(Object.values(SnapshotProvenance)),
    assembler: code('^[a-z0-9-]+/[1-9][0-9]{0,3}$', 48),
    policy: snapshotPolicy,
    resultVersion: {
      type: 'object',
      additionalProperties: false,
      required: [
        'resultVersionId',
        'resultId',
        'versionNumber',
        'contentHash',
        'contentSchema',
        'submittedByPrincipalId',
        'submittedAt',
        'status',
        'scopeType',
        'scopeTargetId',
      ],
      properties: {
        resultVersionId: uuid,
        resultId: uuid,
        versionNumber: { type: 'integer', minimum: 1 },
        contentHash: hashRef,
        contentSchema: code('^br:[a-z0-9-]+@[1-9][0-9]{0,3}$', 64),
        submittedByPrincipalId: uuid,
        submittedAt: timestamp,
        /** Read only; verification never changes it. Orthogonal to the level. */
        status: enumOf(Object.values(ResultVersionStatus).filter((s) => s !== 'DRAFT')),
        supersededByVersionId: uuid,
        scopeType: enumOf(Object.values(ResultScopeType)),
        scopeTargetId: uuid,
        /** Participants named by the version's entries (structural ids only). */
        entryParticipantIds: uuidSet(256),
      },
    },
    hierarchy: {
      type: 'object',
      additionalProperties: false,
      required: ['level', 'competitionId'],
      properties: {
        level: hierarchyLevel,
        competitionId: uuid,
        eventId: uuid,
        roundId: uuid,
        contestId: uuid,
        sport: code('^[a-z0-9]+(?:[-_][a-z0-9]+)*$', 64),
        discipline: code('^[a-z0-9_-]+(?:\\.[a-z0-9_-]+)*$', 128),
        region: code('^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$', 6),
      },
    },
    discipline: {
      type: 'object',
      additionalProperties: false,
      properties: {
        disciplineVersionId: uuid,
        /** DisciplineVersion evidence expectations (BRT-01 §4.2) — the only source of "primary". */
        primaryEvidenceTypes: bounded(setOf(enumOf(Object.values(EvidenceType))), 16),
      },
    },
    evidence: bounded(
      setOf(
        {
          type: 'object',
          additionalProperties: false,
          required: [
            'evidenceId',
            'evidenceType',
            'contentHash',
            'descriptorHash',
            'sourceKind',
            'availability',
            'provenanceRootId',
            'integrity',
          ],
          properties: {
            evidenceId: uuid,
            evidenceType: enumOf(Object.values(EvidenceType)),
            contentHash: hashRef,
            descriptorHash: hashRef,
            sourceKind: enumOf(Object.values(EvidenceSourceKind)),
            sourcePrincipalId: uuid,
            generatorKind: enumOf(Object.values(GeneratorKind)),
            availability: enumOf(Object.values(EvidenceAvailability)),
            /** Roles of attachments to THIS exact ResultVersion. */
            versionRoles: bounded(setOf(enumOf(Object.values(EvidenceAttachmentRole))), 3),
            /** Lineage root (derived / redacted / transformed copies share their origin). */
            provenanceRootId: uuid,
            integrity: enumOf(['VERIFIED']),
          },
        },
        { sortBy: ['/evidenceId'], keyUnique: true },
      ),
      512,
    ),
    attestations: signedFactSet(
      {
        claimType: enumOf(['RESULT_ACCURATE', 'CONDITIONS_COMPLIANT', 'RESULT_OFFICIAL']),
        actingRole: enumOf([
          'PARTICIPANT',
          'OPPONENT',
          'OFFICIAL',
          'ORGANIZER',
          'SANCTIONING_BODY',
          'ACCREDITED_PROVIDER',
          'SYSTEM',
        ]),
        evidenceIds: uuidSet(64),
        conditionAspects: bounded(setOf(conditionAspect), 10),
      },
      ['claimType'],
      512,
    ),
    sanctions: signedFactSet(
      {
        subjectLevel: enumOf(['COMPETITION', 'EVENT']),
        subjectId: uuid,
        recognitionLevel,
      },
      ['subjectLevel', 'subjectId', 'recognitionLevel'],
      32,
    ),
    identityConfirmations: signedFactSet({ athleteId: uuid }, ['athleteId'], 256),
    ratifications: signedFactSet(
      {
        kind: enumOf(['RECORD_RATIFIED', 'REVIEW_COMPLETED']),
        recordCategoryId: uuid,
      },
      ['kind', 'recordCategoryId'],
      32,
    ),
    t5Transitions: bounded(
      setOf(
        {
          type: 'object',
          additionalProperties: false,
          required: ['transitionId', 'actorPrincipalId', 'recordedAt'],
          properties: { transitionId: uuid, actorPrincipalId: uuid, recordedAt: timestamp },
        },
        { sortBy: ['/transitionId'], keyUnique: true },
      ),
      8,
    ),
    /** REGISTERED_OFFICIAL (future producer): structural official registration, not authority. */
    registeredOfficials: bounded(
      setOf(
        {
          type: 'object',
          additionalProperties: false,
          required: [
            'registrationId',
            'principalId',
            'subjectLevel',
            'subjectId',
            'effectiveFrom',
            'recordedAt',
          ],
          properties: {
            registrationId: uuid,
            principalId: uuid,
            subjectLevel: enumOf(['COMPETITION', 'EVENT', 'CONTEST']),
            subjectId: uuid,
            effectiveFrom: timestamp,
            effectiveTo: timestamp,
            recordedAt: timestamp,
          },
        },
        { sortBy: ['/registrationId'], keyUnique: true },
      ),
      64,
    ),
    officialEvidenceSet: {
      type: 'object',
      additionalProperties: false,
      required: ['evidenceTypes'],
      properties: {
        evidenceTypes: bounded(setOf(enumOf(Object.values(EvidenceType)), { minItems: 1 }), 16),
      },
    },
    recordCategory: {
      type: 'object',
      additionalProperties: false,
      required: ['recordCategoryId', 'recognitionLevel'],
      properties: {
        recordCategoryId: uuid,
        recognitionLevel,
        requiredConditionAspects: bounded(setOf(conditionAspect), 10),
      },
    },
    evidenceAssessments: bounded(
      setOf(
        {
          type: 'object',
          additionalProperties: false,
          required: ['assessmentId', 'evidenceId', 'finding'],
          properties: {
            assessmentId: uuid,
            evidenceId: uuid,
            finding: enumOf([
              'AUTHENTIC',
              'INTEGRITY_FAILED',
              'WRONG_SUBJECT',
              'MANIPULATED',
              'INCONCLUSIVE',
              'SUPERSEDED_SOURCE',
            ]),
          },
        },
        { sortBy: ['/assessmentId'], keyUnique: true },
      ),
      256,
    ),
    /** Canonical fact kinds whose producer exists for this snapshot (others: INPUT_NOT_SUPPORTED). */
    supportedFactKinds: bounded(setOf(enumOf(ALL_CANONICAL_FACT_KINDS)), 16),
    keys: bounded(
      setOf(
        {
          type: 'object',
          additionalProperties: false,
          required: [
            'keyId',
            'principalId',
            'keyKind',
            'algorithm',
            'factHash',
            'effectiveFrom',
            'recordedAt',
          ],
          properties: {
            keyId: uuid,
            principalId: uuid,
            keyKind: enumOf(['WALLET', 'PASSKEY', 'JWK', 'DEVICE', 'KMS']),
            algorithm: enumOf(['ES256', 'ES256K', 'EdDSA', 'RS256']),
            factHash: hashRef,
            effectiveFrom: timestamp,
            effectiveTo: timestamp,
            recordedAt: timestamp,
            statusChanges: bounded(
              setOf(
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['statusChangeId', 'kind', 'effectiveFrom', 'recordedAt'],
                  properties: {
                    statusChangeId: uuid,
                    kind: enumOf(['ROTATED', 'REVOKED', 'COMPROMISED']),
                    effectiveFrom: timestamp,
                    compromisedSince: timestamp,
                    recordedAt: timestamp,
                  },
                },
                { sortBy: ['/statusChangeId'], keyUnique: true },
              ),
              32,
            ),
          },
        },
        { sortBy: ['/keyId'], keyUnique: true },
      ),
      512,
    ),
    authority: {
      type: 'object',
      additionalProperties: false,
      properties: {
        principals: bounded(
          setOf(
            {
              type: 'object',
              additionalProperties: false,
              required: ['principalId', 'principalType', 'recordedAt'],
              properties: { principalId: uuid, principalType, recordedAt: timestamp },
            },
            { sortBy: ['/principalId'], keyUnique: true },
          ),
          1024,
        ),
        anchors: bounded(
          setOf(
            {
              type: 'object',
              additionalProperties: false,
              required: [
                'anchorId',
                'principalId',
                'recognitionScope',
                'factHash',
                'effectiveFrom',
                'recordedAt',
              ],
              properties: {
                anchorId: uuid,
                principalId: uuid,
                recognitionScope,
                factHash: hashRef,
                effectiveFrom: timestamp,
                effectiveTo: timestamp,
                recordedAt: timestamp,
              },
            },
            { sortBy: ['/anchorId'], keyUnique: true },
          ),
          256,
        ),
        anchorStatusChanges: bounded(
          setOf(
            {
              type: 'object',
              additionalProperties: false,
              required: ['statusChangeId', 'anchorId', 'effectiveFrom', 'recordedAt'],
              properties: {
                statusChangeId: uuid,
                anchorId: uuid,
                effectiveFrom: timestamp,
                recordedAt: timestamp,
              },
            },
            { sortBy: ['/statusChangeId'], keyUnique: true },
          ),
          256,
        ),
        grants: bounded(
          setOf(
            {
              type: 'object',
              additionalProperties: false,
              required: [
                'grantId',
                'grantorPrincipalId',
                'granteePrincipalId',
                'capabilities',
                'scope',
                'delegation',
                'grantHash',
                'effectiveFrom',
                'recordedAt',
              ],
              properties: {
                grantId: uuid,
                grantorPrincipalId: uuid,
                granteePrincipalId: uuid,
                parentGrantId: uuid,
                capabilities: setOf(capability, { minItems: 1 }),
                scope: authorityScope,
                delegation: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['allowed', 'maxDepth'],
                  properties: {
                    allowed: { type: 'boolean' },
                    maxDepth: { type: 'integer', minimum: 0, maximum: 8 },
                    capabilitiesDelegable: setOf(capability),
                  },
                },
                grantHash: hashRef,
                effectiveFrom: timestamp,
                effectiveTo: timestamp,
                recordedAt: timestamp,
              },
            },
            { sortBy: ['/grantId'], keyUnique: true },
          ),
          2048,
        ),
        grantStatusChanges: bounded(
          setOf(
            {
              type: 'object',
              additionalProperties: false,
              required: ['statusChangeId', 'grantId', 'compromise', 'effectiveFrom', 'recordedAt'],
              properties: {
                statusChangeId: uuid,
                grantId: uuid,
                compromise: { type: 'boolean' },
                effectiveFrom: timestamp,
                recordedAt: timestamp,
              },
            },
            { sortBy: ['/statusChangeId'], keyUnique: true },
          ),
          2048,
        ),
      },
    },
    participation: {
      type: 'object',
      additionalProperties: false,
      required: ['sidesComplete'],
      properties: {
        /** False when a contestant slot is unresolved (its side cannot be known). */
        sidesComplete: { type: 'boolean' },
        /**
         * The contest occurrence window time-bounded relations are sliced at: `from` = first
         * IN_PROGRESS transition known at the cutoff (absent: unknown), `to` = the earliest of the
         * first COMPLETED transition and the version's submission (a result cannot precede play).
         */
        occurrenceWindow: {
          type: 'object',
          additionalProperties: false,
          required: ['to'],
          properties: { from: timestamp, to: timestamp },
        },
        sides: bounded(
          setOf(
            {
              type: 'object',
              additionalProperties: false,
              required: ['participantId', 'participantKind'],
              properties: {
                participantId: uuid,
                participantKind: enumOf(['INDIVIDUAL', 'TEAM']),
                athleteIds: uuidSet(64),
                principalIds: uuidSet(256),
              },
            },
            { sortBy: ['/participantId'], keyUnique: true },
          ),
          256,
        ),
        principals: bounded(
          setOf(
            {
              type: 'object',
              additionalProperties: false,
              required: ['principalId', 'principalType', 'resolution'],
              properties: {
                principalId: uuid,
                principalType,
                resolution: enumOf(Object.values(ParticipationResolution)),
                relations: bounded(
                  setOf({
                    type: 'object',
                    additionalProperties: false,
                    required: ['kind', 'timing'],
                    properties: {
                      kind: participationRelation,
                      participantId: uuid,
                      timing: enumOf(Object.values(RelationTiming)),
                    },
                  }),
                  64,
                ),
              },
            },
            { sortBy: ['/principalId'], keyUnique: true },
          ),
          1024,
        ),
      },
    },
  },
});

// ───────────────────────────── trace ─────────────────────────────

const authorityDecision: BrObjectSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['principalId', 'capability', 'atTime', 'authorized', 'reason', 'conflictCheck'],
  properties: {
    principalId: uuid,
    factId: uuid,
    capability,
    /** Requested scope: the resolved hierarchy + this recognition level (never inferred). */
    recognitionLevel,
    atTime: timestamp,
    authorized: { type: 'boolean' },
    reason: reasonCode,
    anchorId: uuid,
    /** Observed anchor recognition levels (RecognitionLevel — never a VerificationLevel). */
    anchorLevels: bounded(setOf(recognitionLevel), 6),
    /** Leaf → root. */
    grantChain: { type: 'array', items: uuid, maxItems: 16 },
    conflictCheck: enumOf(['CLEAR', 'CONFLICTED', 'UNAVAILABLE', 'NOT_APPLICABLE']),
    proofDigest: hashRef,
  },
};

export const verificationTraceV1 = root('br:verification-trace', 1, {
  type: 'object',
  additionalProperties: false,
  required: ['engineVersion', 'snapshotHash', 'criteria'],
  properties: {
    engineVersion,
    snapshotHash: hashRef,
    /** Per signed fact: claim status and key trust as evaluated (signature ≠ key trust ≠ authority). */
    signedFacts: bounded(
      setOf(
        {
          type: 'object',
          additionalProperties: false,
          required: ['attestationId', 'factType', 'status', 'keyTrust', 'counts'],
          properties: {
            attestationId: uuid,
            factType: enumOf(['ATTESTATION', 'SANCTION', 'IDENTITY_CONFIRMATION', 'RATIFICATION']),
            status: enumOf(['ACTIVE', 'RETRACTED', 'SUPERSEDED']),
            keyTrust: enumOf(['TRUSTED', 'SUSPECT', 'INVALID']),
            keyReason: reasonCode,
            counts: { type: 'boolean' },
          },
        },
        { sortBy: ['/attestationId'], keyUnique: true },
      ),
      1024,
    ),
    criteria: bounded(
      setOf(
        {
          type: 'object',
          additionalProperties: false,
          required: ['criterionId', 'kind', 'level', 'status'],
          properties: {
            criterionId: code('^[a-z0-9][a-z0-9._:-]{0,79}$', 80),
            kind: code('^[A-Z][A-Z0-9_]{0,63}$', 64),
            level: verificationLevel,
            status: enumOf(Object.values(CriterionStatus)),
            reasons,
            observed: { type: 'integer', minimum: 0, maximum: 1000000 },
            required: { type: 'integer', minimum: 0, maximum: 1000000 },
            supportingAttestationIds: uuidSet(512),
            supportingEvidenceIds: uuidSet(512),
            grantIds: uuidSet(512),
            anchorIds: uuidSet(64),
            authority: bounded(setOf(authorityDecision), 256),
            issuerGroups: bounded(
              setOf(
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['principalId', 'attestationIds', 'classification'],
                  properties: {
                    principalId: uuid,
                    attestationIds: uuidSet(64),
                    classification: reasonCode,
                    reasons,
                  },
                },
                { sortBy: ['/principalId'], keyUnique: true },
              ),
              256,
            ),
            sourceGroups: bounded(
              setOf(
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['groupKey', 'evidenceIds', 'classification'],
                  properties: {
                    groupKey: code('^[A-Z_]+:[0-9a-f-]{36}$', 80),
                    evidenceIds: uuidSet(64),
                    classification: reasonCode,
                  },
                },
                { sortBy: ['/groupKey'], keyUnique: true },
              ),
              256,
            ),
            participation: bounded(
              setOf({
                type: 'object',
                additionalProperties: false,
                required: ['principalId', 'relation'],
                properties: {
                  principalId: uuid,
                  relation: reasonCode,
                  participantId: uuid,
                  timing: enumOf(Object.values(RelationTiming)),
                },
              }),
              256,
            ),
          },
        },
        { sortBy: ['/criterionId'], keyUnique: true },
      ),
      128,
    ),
  },
});

// ───────────────────────────── outcome ─────────────────────────────

export const verificationOutcomeV1 = root('br:verification-outcome', 1, {
  type: 'object',
  additionalProperties: false,
  required: [
    'engineId',
    'engineVersion',
    'evaluationState',
    'resultVersionId',
    'policyVersionId',
    'policySpecHash',
    'snapshotHash',
    'levels',
    'traceHash',
  ],
  properties: {
    engineId: code('^[a-z0-9-]+$', 64),
    engineVersion,
    evaluationState: enumOf([EvaluationState.EVALUATED, EvaluationState.INSUFFICIENT_INPUT]),
    resultVersionId: uuid,
    policyVersionId: uuid,
    policySpecHash: hashRef,
    snapshotHash: hashRef,
    /** Absent when V0 cannot be established (never a fictional sixth level). */
    highestSatisfiedLevel: verificationLevel,
    satisfiedLevels: bounded(setOf(verificationLevel), 5),
    levels: bounded(
      setOf(
        {
          type: 'object',
          additionalProperties: false,
          required: ['level', 'status'],
          properties: {
            level: verificationLevel,
            status: enumOf(['SATISFIED', 'BLOCKED', 'NOT_REACHED', 'NOT_DEFINED']),
            criteria: bounded(
              setOf(
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['criterionId', 'kind', 'status'],
                  properties: {
                    criterionId: code('^[a-z0-9][a-z0-9._:-]{0,79}$', 80),
                    kind: code('^[A-Z][A-Z0-9_]{0,63}$', 64),
                    status: enumOf(Object.values(CriterionStatus)),
                    reasons,
                  },
                },
                { sortBy: ['/criterionId'], keyUnique: true },
              ),
              24,
            ),
          },
        },
        { sortBy: ['/level'], keyUnique: true },
      ),
      5,
    ),
    flags: bounded(setOf(enumOf(Object.values(VerificationFlag))), 8),
    traceHash: hashRef,
  },
});

/** Ledger fact of a persisted VerificationRun (payload hash of the VERIFICATION stream entry). */
export const verificationRunFactV1 = root('br:verification-run-fact', 1, {
  type: 'object',
  additionalProperties: false,
  required: [
    'runId',
    'resultVersionId',
    'policyVersionId',
    'engineVersion',
    'evaluatedAsOf',
    'snapshotHash',
    'outcomeHash',
    'traceHash',
    'evidenceBundleHash',
    'evaluationState',
  ],
  properties: {
    runId: uuid,
    resultVersionId: uuid,
    policyVersionId: uuid,
    engineVersion,
    evaluatedAsOf: timestamp,
    snapshotHash: hashRef,
    outcomeHash: hashRef,
    traceHash: hashRef,
    evidenceBundleHash: hashRef,
    evaluationState: enumOf([EvaluationState.EVALUATED, EvaluationState.INSUFFICIENT_INPUT]),
    highestSatisfiedLevel: verificationLevel,
  },
});

export const BRT07_SCHEMAS: readonly BrRootSchema[] = [
  verificationPolicyV1,
  verificationSnapshotV1,
  verificationTraceV1,
  verificationOutcomeV1,
  verificationRunFactV1,
];
