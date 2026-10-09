import type { BrRootSchema, BrStringSchema } from '@br/canonical';
import {
  AcquisitionMethod,
  ActingRole,
  AttestationClaimType,
  AttestationSubjectType,
  CapturedAtAssurance,
  ClaimPolarity,
  EVIDENCE_MEDIA_TYPES,
  EvidenceAttachmentRole,
  EvidenceAttachmentTarget,
  EvidenceAvailability,
  EvidencePrivacyClass,
  EvidenceRelationKind,
  EvidenceSourceKind,
  EvidenceType,
  GeneratorKind,
  ProofScheme,
  ProofType,
  ResultOutcome,
  ResultScopeType,
  ResultVersionStatus,
  RetractionReason,
  SignatureAssurance,
  TransitionCode,
} from '@br/domain';
import {
  authorityScope,
  capability,
  enumOf,
  hashRef,
  mark,
  recognitionScope,
  setOf,
  shortText,
  timestamp,
  uuid,
} from './primitives';

const root = (
  id: string,
  version: number,
  body: Omit<BrRootSchema, '$id' | 'x-br-version'>,
): BrRootSchema => ({
  $id: id,
  'x-br-version': version,
  ...body,
});

/** Sport-neutral ResultVersion content (BRT-01 §6). Discipline components arrive with the catalog. */
export const resultVersionContentV1 = root('br:result-version-content', 1, {
  type: 'object',
  additionalProperties: false,
  required: ['entries'],
  properties: {
    entries: setOf(
      {
        type: 'object',
        additionalProperties: false,
        required: ['participantId', 'outcome'],
        properties: {
          participantId: uuid,
          outcome: enumOf(Object.values(ResultOutcome)),
          rank: { type: 'integer', minimum: 1 },
          primaryMark: mark,
        },
      },
      { minItems: 1, sortBy: ['/participantId'], keyUnique: true },
    ),
    performances: setOf(
      {
        type: 'object',
        additionalProperties: false,
        required: ['participantId', 'ordinal', 'mark'],
        properties: {
          participantId: uuid,
          athleteId: uuid,
          ordinal: { type: 'integer', minimum: 1 },
          mark,
          valid: { type: 'boolean', default: true },
        },
      },
      { sortBy: ['/participantId', '/ordinal'], keyUnique: true },
    ),
  },
});

const delegation = {
  type: 'object',
  additionalProperties: false,
  required: ['allowed', 'maxDepth'],
  properties: {
    allowed: { type: 'boolean' },
    maxDepth: { type: 'integer', minimum: 0, maximum: 8 },
    capabilitiesDelegable: setOf(capability),
  },
} as const;

/** The signed/hashed grant document. `grantHash` = H("authority-grant", this). */
export const authorityGrantV1 = root('br:authority-grant', 1, {
  type: 'object',
  additionalProperties: false,
  required: [
    'grantorPrincipalId',
    'granteePrincipalId',
    'capabilities',
    'scope',
    'delegation',
    'constraints',
    'effectiveFrom',
  ],
  properties: {
    grantorPrincipalId: uuid,
    granteePrincipalId: uuid,
    parentGrantId: uuid,
    capabilities: setOf(capability, { minItems: 1 }),
    scope: authorityScope,
    delegation,
    constraints: {
      type: 'object',
      additionalProperties: false,
      required: ['mustNotBeParticipant'],
      properties: { mustNotBeParticipant: { type: 'boolean' } },
    },
    effectiveFrom: timestamp,
    effectiveTo: timestamp,
  },
});

export const trustAnchorV1 = root('br:trust-anchor', 1, {
  type: 'object',
  additionalProperties: false,
  required: [
    'principalId',
    'recognitionScope',
    'basisRef',
    'governanceDecisionRef',
    'effectiveFrom',
  ],
  properties: {
    principalId: uuid,
    recognitionScope,
    basisRef: shortText,
    governanceDecisionRef: shortText,
    effectiveFrom: timestamp,
    effectiveTo: timestamp,
  },
});

export const principalV1 = root('br:principal', 1, {
  type: 'object',
  additionalProperties: false,
  required: ['principalId', 'principalType', 'label'],
  properties: {
    principalId: uuid,
    principalType: enumOf(['PLATFORM', 'ORGANIZATION', 'PERSON', 'SYSTEM']),
    label: shortText,
  },
});

export const principalKeyV1 = root('br:principal-key', 1, {
  type: 'object',
  additionalProperties: false,
  required: [
    'keyId',
    'principalId',
    'keyKind',
    'algorithm',
    'verificationMaterialHash',
    'effectiveFrom',
  ],
  properties: {
    keyId: uuid,
    principalId: uuid,
    keyKind: enumOf(['WALLET', 'PASSKEY', 'JWK', 'DEVICE', 'KMS']),
    algorithm: enumOf(['ES256', 'ES256K', 'EdDSA', 'RS256']),
    verificationMaterialHash: hashRef,
    effectiveFrom: timestamp,
    effectiveTo: timestamp,
  },
});

/** Generic status-change fact for keys, anchors and grants. */
export const statusChangeV1 = root('br:status-change', 1, {
  type: 'object',
  additionalProperties: false,
  required: ['subjectType', 'subjectId', 'kind', 'effectiveFrom', 'retroactive', 'reason'],
  properties: {
    subjectType: enumOf(['PRINCIPAL_KEY', 'TRUST_ANCHOR', 'AUTHORITY_GRANT']),
    subjectId: uuid,
    kind: enumOf(['ROTATED', 'REVOKED', 'COMPROMISED']),
    effectiveFrom: timestamp,
    retroactive: { type: 'boolean' },
    reason: shortText,
    declaredByPrincipalId: uuid,
  },
});

export const resultV1 = root('br:result', 1, {
  type: 'object',
  additionalProperties: false,
  required: ['resultId', 'scopeType', 'scopeTargetId'],
  properties: {
    resultId: uuid,
    scopeType: enumOf(Object.values(ResultScopeType)),
    scopeTargetId: uuid,
  },
});

/** Ledger fact for a ResultVersion row: binds identity metadata to the content hash. */
export const resultVersionFactV1 = root('br:result-version-fact', 1, {
  type: 'object',
  additionalProperties: false,
  required: [
    'resultVersionId',
    'resultId',
    'versionNumber',
    'contentHash',
    'contentSchema',
    'disciplineVersionRef',
    'submittedByPrincipalId',
  ],
  properties: {
    resultVersionId: uuid,
    resultId: uuid,
    versionNumber: { type: 'integer', minimum: 1 },
    contentHash: hashRef,
    contentSchema: shortText,
    disciplineVersionRef: shortText,
    submittedByPrincipalId: uuid,
    supersedesVersionId: uuid,
  },
});

export const resultStatusTransitionV1 = root('br:result-status-transition', 1, {
  type: 'object',
  additionalProperties: false,
  required: [
    'transitionId',
    'resultVersionId',
    'toStatus',
    'transitionCode',
    'actorPrincipalId',
    'authorizationProofDigest',
  ],
  properties: {
    transitionId: uuid,
    resultVersionId: uuid,
    fromStatus: enumOf(Object.values(ResultVersionStatus)),
    toStatus: enumOf(Object.values(ResultVersionStatus)),
    transitionCode: enumOf(Object.values(TransitionCode)),
    actorPrincipalId: uuid,
    authorizationProofDigest: hashRef,
    reason: shortText,
  },
});

/** Hash-chain entry (BRT-02 persistence §5.2). */
export const ledgerEntryV1 = root('br:ledger-entry', 1, {
  type: 'object',
  additionalProperties: false,
  required: [
    'streamType',
    'streamId',
    'sequence',
    'previousHash',
    'entryType',
    'factTable',
    'factRowId',
    'factHash',
    'recordedAt',
  ],
  properties: {
    streamType: shortText,
    streamId: uuid,
    sequence: { type: 'integer', minimum: 1 },
    previousHash: hashRef,
    entryType: shortText,
    factTable: shortText,
    factRowId: uuid,
    factHash: hashRef,
    recordedAt: timestamp,
  },
});

export const ledgerGenesisV1 = root('br:ledger-genesis', 1, {
  type: 'object',
  additionalProperties: false,
  required: ['streamType', 'streamId'],
  properties: { streamType: shortText, streamId: uuid },
});

/** Deterministic digest over the authority facts used by a decision (packages/authority). */
export const authorizationProofV1 = root('br:authorization-proof', 1, {
  type: 'object',
  additionalProperties: false,
  required: [
    'engineVersion',
    'request',
    'authorized',
    'reason',
    'conflictCheck',
    'conflictCheckerId',
  ],
  properties: {
    engineVersion: shortText,
    request: {
      type: 'object',
      additionalProperties: false,
      required: ['principalId', 'capability', 'scope', 'atTime', 'asOf'],
      properties: {
        principalId: uuid,
        keyId: uuid,
        capability,
        scope: authorityScope,
        atTime: timestamp,
        asOf: timestamp,
      },
    },
    authorized: { type: 'boolean' },
    reason: shortText,
    anchor: {
      type: 'object',
      additionalProperties: false,
      required: ['anchorId', 'factHash'],
      properties: { anchorId: uuid, factHash: hashRef },
    },
    /** Ordered leaf → root. */
    grantChain: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['grantId', 'grantHash'],
        properties: { grantId: uuid, grantHash: hashRef },
      },
    },
    key: {
      type: 'object',
      additionalProperties: false,
      required: ['keyId', 'factHash'],
      properties: { keyId: uuid, factHash: hashRef },
    },
    /** Status-change facts that were visible (asOf) for the chain, anchor and key. */
    statusFactIds: setOf(uuid),
    conflictCheck: enumOf(['CLEAR', 'CONFLICTED', 'UNAVAILABLE', 'NOT_APPLICABLE']),
    conflictCheckerId: shortText,
  },
});

const idempotentCommand = (
  id: string,
  properties: BrRootSchema['properties'],
  required: readonly string[],
): BrRootSchema =>
  root(id, 1, { type: 'object', additionalProperties: false, required, properties });

/** Request fingerprints for idempotency (same key + different request ⇒ rejected). */
export const commandSchemas = [
  idempotentCommand(
    'br:cmd-create-result',
    { scopeType: enumOf(Object.values(ResultScopeType)), scopeTargetId: uuid },
    ['scopeType', 'scopeTargetId'],
  ),
  idempotentCommand(
    'br:cmd-submit-result-version',
    { draftId: uuid, actorPrincipalId: uuid, contentHash: hashRef, scope: authorityScope },
    ['draftId', 'actorPrincipalId', 'contentHash', 'scope'],
  ),
  idempotentCommand(
    'br:cmd-transition-result-version',
    {
      resultVersionId: uuid,
      toStatus: enumOf(Object.values(ResultVersionStatus)),
      actorPrincipalId: uuid,
      scope: authorityScope,
      reason: shortText,
    },
    ['resultVersionId', 'toStatus', 'actorPrincipalId', 'scope'],
  ),
  // ONCF-05D: an atomic correction (T2 + T3 of the new version, T7 of the version it supersedes).
  idempotentCommand(
    'br:cmd-correct-result-version',
    {
      draftId: uuid,
      supersedesVersionId: uuid,
      actorPrincipalId: uuid,
      contentHash: hashRef,
      scope: authorityScope,
      reason: shortText,
    },
    ['draftId', 'supersedesVersionId', 'actorPrincipalId', 'contentHash', 'scope', 'reason'],
  ),
  idempotentCommand('br:cmd-issue-grant', { grantHash: hashRef, actorPrincipalId: uuid }, [
    'grantHash',
    'actorPrincipalId',
  ]),
] as const;

/**
 * BRT-04 command fingerprint: identity/organization commands are fingerprinted as
 * (command, actor, payloadDigest). `payloadDigest` is computed by the persistence layer over the
 * command parameters (PII-bearing parameters contribute only a keyed HMAC fingerprint), so the
 * idempotency table never stores raw parameters or plain hashes of PII.
 */
export const cmdIdentityV1 = root('br:cmd-identity', 1, {
  type: 'object',
  additionalProperties: false,
  required: ['command', 'actorAccountId', 'payloadDigest'],
  properties: {
    command: shortText,
    actorAccountId: uuid,
    payloadDigest: hashRef,
  },
});

// ───────────────────────────── BRT-05 competition facts ─────────────────────────────
// Hashed documents that make field locking, seeding and plan generation reproducible and
// auditable ("this bracket was generated from exactly this field, seed order and config").

const planKey: BrStringSchema = {
  type: 'string',
  pattern: '^r[0-9]{1,3}(-c[0-9]{1,4})?$',
  maxLength: 16,
};
const participantKind = enumOf(['INDIVIDUAL', 'TEAM']);
const contestType = enumOf(['MATCH', 'HEAT', 'SERIES', 'ATTEMPT_SET', 'ROUTINE', 'SESSION']);

/** The locked participant set of an Event (order-independent: a set keyed by participantId). */
export const competitionFieldV1 = root('br:competition-field', 1, {
  type: 'object',
  additionalProperties: false,
  required: ['eventId', 'participants'],
  properties: {
    eventId: uuid,
    participants: {
      ...setOf(
        {
          type: 'object',
          additionalProperties: false,
          required: ['participantId', 'registrationId', 'kind'],
          properties: {
            participantId: uuid,
            registrationId: uuid,
            kind: participantKind,
            athleteId: uuid,
            teamId: uuid,
          },
        },
        { sortBy: ['/participantId'], keyUnique: true },
      ),
      maxItems: 4096,
    },
  },
});

/** A seeding fact: method, reproducibility input and the resulting order (ordered array). */
export const competitionSeedingV1 = root('br:competition-seeding', 1, {
  type: 'object',
  additionalProperties: false,
  required: ['eventId', 'fieldHash', 'method', 'order'],
  properties: {
    eventId: uuid,
    fieldHash: hashRef,
    method: enumOf(['MANUAL', 'DETERMINISTIC_DRAW']),
    drawAlgorithm: { type: 'string', pattern: '^[a-z0-9-]+/[0-9]+$', maxLength: 32 },
    drawSeed: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    order: { type: 'array', items: uuid, maxItems: 4096, uniqueItems: true },
  },
});

/** Canonical input of plan generation. */
export const competitionPlanInputV1 = root('br:competition-plan-input', 1, {
  type: 'object',
  additionalProperties: false,
  required: [
    'eventId',
    'disciplineVersionId',
    'disciplineVersionHash',
    'formatVersionId',
    'formatVersionHash',
    'engineId',
    'engineVersion',
    'fieldHash',
    'seedingHash',
    'configHash',
    'seedOrder',
  ],
  properties: {
    eventId: uuid,
    disciplineVersionId: uuid,
    disciplineVersionHash: hashRef,
    formatVersionId: uuid,
    formatVersionHash: hashRef,
    engineId: { type: 'string', pattern: '^[a-z0-9-]+$', maxLength: 64 },
    engineVersion: { type: 'integer', minimum: 1, maximum: 1000 },
    fieldHash: hashRef,
    seedingHash: hashRef,
    configHash: hashRef,
    seedOrder: { type: 'array', items: uuid, maxItems: 4096, uniqueItems: true },
  },
});

/** Generated logical structure (rounds → contests → slots with dependency sources). */
export const competitionPlanV1 = root('br:competition-plan', 1, {
  type: 'object',
  additionalProperties: false,
  required: ['engineId', 'engineVersion', 'rounds'],
  properties: {
    engineId: { type: 'string', pattern: '^[a-z0-9-]+$', maxLength: 64 },
    engineVersion: { type: 'integer', minimum: 1, maximum: 1000 },
    rounds: {
      type: 'array',
      maxItems: 512,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'sequence', 'roundType', 'label', 'byes', 'contests'],
        properties: {
          key: planKey,
          sequence: { type: 'integer', minimum: 1, maximum: 512 },
          roundType: enumOf([
            'QUALIFYING',
            'GROUP',
            'HEAT',
            'KNOCKOUT',
            'REPECHAGE',
            'FINAL',
            'SESSION',
          ]),
          label: { type: 'string', minLength: 1, maxLength: 80 },
          byes: { ...setOf(uuid), uniqueItems: true, maxItems: 4096 },
          contests: {
            type: 'array',
            maxItems: 4096,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['key', 'sequence', 'contestType', 'slots'],
              properties: {
                key: planKey,
                sequence: { type: 'integer', minimum: 1, maximum: 100000 },
                contestType,
                slots: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 64,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['slot', 'source'],
                    properties: {
                      slot: { type: 'integer', minimum: 1, maximum: 64 },
                      source: enumOf([
                        'PARTICIPANT',
                        'WINNER_OF_CONTEST',
                        'LOSER_OF_CONTEST',
                        'RANK_FROM_STAGE',
                      ]),
                      participantId: uuid,
                      contestKey: planKey,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});

export const ALL_SCHEMAS: readonly BrRootSchema[] = [
  cmdIdentityV1,
  resultVersionContentV1,
  authorityGrantV1,
  trustAnchorV1,
  principalV1,
  principalKeyV1,
  statusChangeV1,
  resultV1,
  resultVersionFactV1,
  resultStatusTransitionV1,
  ledgerEntryV1,
  ledgerGenesisV1,
  authorizationProofV1,
  ...commandSchemas,
  competitionFieldV1,
  competitionSeedingV1,
  competitionPlanInputV1,
  competitionPlanV1,
];

// ───────────────────────────── BRT-06 evidence & attestation ─────────────────────────────
// Evidence descriptors, signed statements (BRT-02 §4.1), ledger facts and the deterministic
// Evidence Bundle handed to BRT-07. Hashing is always domain-separated (ADR-0014); evidence BYTES
// are the one exception (plain SHA-256 of the raw bytes, ADR-0018).

const code = (pattern: string, maxLength: number): BrStringSchema => ({
  type: 'string',
  pattern,
  maxLength,
});
const systemId = code('^[a-z0-9][a-z0-9._:-]{0,99}$', 100);
const systemVersion = code('^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$', 40);
const externalNamespace = code('^[a-z0-9][a-z0-9:._-]{1,99}$', 100);
const externalId = code('^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$', 200);
const audience = code('^bragging-rights:[a-z0-9-]{1,32}$', 48);
/** 128-bit random nonce, base64url without padding (BRT-02 §4.1). */
const nonce = code('^[A-Za-z0-9_-]{22}$', 22);
const evidenceType = enumOf(Object.values(EvidenceType));
const mediaType = enumOf(EVIDENCE_MEDIA_TYPES);
const byteLength = { type: 'integer', minimum: 0, maximum: 9007199254740991 } as const;
const scopeLevel = enumOf(['COMPETITION', 'EVENT', 'ROUND', 'CONTEST']);

const evidenceRef = {
  type: 'object',
  additionalProperties: false,
  required: ['evidenceId', 'contentHash', 'descriptorHash'],
  properties: { evidenceId: uuid, contentHash: hashRef, descriptorHash: hashRef },
} as const;

/** EvidenceItem descriptor: exact bytes + provenance. `descriptorHash` = H("evidence-descriptor", this). */
export const evidenceDescriptorV1 = root('br:evidence-descriptor', 1, {
  type: 'object',
  additionalProperties: false,
  required: ['evidenceId', 'evidenceType', 'content', 'source', 'acquisition'],
  properties: {
    evidenceId: uuid,
    evidenceType,
    content: {
      type: 'object',
      additionalProperties: false,
      required: ['sha256', 'byteLength', 'mediaType'],
      properties: { sha256: hashRef, byteLength, mediaType },
    },
    source: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'capturedAtAssurance'],
      properties: {
        kind: enumOf(Object.values(EvidenceSourceKind)),
        principalId: uuid,
        system: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'version'],
          properties: { id: systemId, version: systemVersion },
        },
        deviceId: systemId,
        externalNamespace,
        externalId,
        /** Source assertion (BRT-02 §5.1): never platform truth. */
        capturedAt: timestamp,
        capturedAtAssurance: enumOf(Object.values(CapturedAtAssurance)),
      },
    },
    acquisition: {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'receivedAt'],
      properties: {
        method: enumOf(Object.values(AcquisitionMethod)),
        /** Platform-observed. */
        receivedAt: timestamp,
      },
    },
    /** Machine-derived evidence (BRT-01 §2.6 / E-4): generator identity, never "true". */
    derivation: {
      type: 'object',
      additionalProperties: false,
      required: ['generator', 'inputs'],
      properties: {
        generator: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'systemId', 'version'],
          properties: {
            kind: enumOf(Object.values(GeneratorKind)),
            systemId,
            version: systemVersion,
            configurationHash: hashRef,
          },
        },
        generatedAt: timestamp,
        inputs: {
          ...setOf(
            {
              type: 'object',
              additionalProperties: false,
              required: ['evidenceId', 'contentHash'],
              properties: { evidenceId: uuid, contentHash: hashRef },
            },
            { minItems: 1, sortBy: ['/evidenceId'], keyUnique: true },
          ),
          maxItems: 64,
        },
      },
    },
    /** Immutable lineage edges to parent items (child → parent). */
    lineage: {
      ...setOf(
        {
          type: 'object',
          additionalProperties: false,
          required: ['relation', 'evidenceId', 'descriptorHash'],
          properties: {
            relation: enumOf(Object.values(EvidenceRelationKind)),
            evidenceId: uuid,
            descriptorHash: hashRef,
          },
        },
        { sortBy: ['/evidenceId', '/relation'], keyUnique: true },
      ),
      maxItems: 64,
    },
  },
});

const conditionObservation = {
  type: 'object',
  additionalProperties: false,
  required: ['aspect', 'key'],
  properties: {
    aspect: enumOf([
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
    ]),
    /** Discipline-neutral metric key, e.g. "wind.speed", "lane.oil-pattern". */
    key: code('^[a-z0-9]+(?:[._-][a-z0-9]+)*$', 64),
    value: { type: 'string', 'x-br-type': 'decimal' },
    unit: { type: 'string', minLength: 1, maxLength: 16 },
    code: code('^[A-Z][A-Z0-9_]{0,31}$', 32),
  },
} as const;

/**
 * Attestation statement (BRT-02 §4.1; ADR-0015). `statementHash` = H("attestation-statement", this).
 * Signed through the JWS_DETACHED payload "bragging-rights/sig/v1:" ‖ hex(statementHash).
 */
export const attestationStatementV1 = root('br:attestation-statement', 1, {
  type: 'object',
  additionalProperties: false,
  required: [
    'v',
    'purpose',
    'audience',
    'issuer',
    'subject',
    'claim',
    'nonce',
    'signedAt',
    'expiresAt',
  ],
  properties: {
    v: { type: 'integer', minimum: 1, maximum: 1 },
    purpose: enumOf(['attestation']),
    audience,
    issuer: {
      type: 'object',
      additionalProperties: false,
      required: ['principalId', 'keyId'],
      properties: { principalId: uuid, keyId: uuid },
    },
    subject: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id', 'hash'],
      properties: {
        type: enumOf(Object.values(AttestationSubjectType)),
        id: uuid,
        hash: hashRef,
      },
    },
    claim: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'polarity'],
      properties: {
        type: enumOf(Object.values(AttestationClaimType)),
        polarity: enumOf(Object.values(ClaimPolarity)),
        payload: {
          type: 'object',
          additionalProperties: false,
          properties: {
            conditions: {
              ...setOf(conditionObservation, { sortBy: ['/aspect', '/key'], keyUnique: true }),
              maxItems: 32,
            },
            reasonCode: enumOf([
              'SCORE_INCORRECT',
              'OUTCOME_INCORRECT',
              'PARTICIPANT_INCORRECT',
              'OTHER',
            ]),
          },
        },
      },
    },
    /** Declared by the signer; evaluated only by BRT-07 (never trusted here). */
    authorityContext: {
      type: 'object',
      additionalProperties: false,
      required: ['actingRole'],
      properties: {
        actingRole: enumOf(Object.values(ActingRole)),
        scopeRef: {
          type: 'object',
          additionalProperties: false,
          required: ['level', 'id'],
          properties: { level: scopeLevel, id: uuid },
        },
      },
    },
    evidenceRefs: {
      ...setOf(evidenceRef, { sortBy: ['/evidenceId'], keyUnique: true }),
      maxItems: 64,
    },
    supersedes: {
      type: 'object',
      additionalProperties: false,
      required: ['attestationId', 'statementHash'],
      properties: { attestationId: uuid, statementHash: hashRef },
    },
    nonce,
    /** Signer assertion (BRT-02 §5.1): never establishes key or authority validity. */
    signedAt: timestamp,
    expiresAt: timestamp,
  },
});

/** Signed retraction: the issuer withdraws an exact attestation (withdrawn ≠ false). */
export const attestationRetractionStatementV1 = root('br:attestation-retraction-statement', 1, {
  type: 'object',
  additionalProperties: false,
  required: [
    'v',
    'purpose',
    'audience',
    'issuer',
    'subject',
    'reasonCode',
    'nonce',
    'signedAt',
    'expiresAt',
  ],
  properties: {
    v: { type: 'integer', minimum: 1, maximum: 1 },
    purpose: enumOf(['attestation-retraction']),
    audience,
    issuer: {
      type: 'object',
      additionalProperties: false,
      required: ['principalId', 'keyId'],
      properties: { principalId: uuid, keyId: uuid },
    },
    subject: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id', 'hash'],
      properties: { type: enumOf(['ATTESTATION']), id: uuid, hash: hashRef },
    },
    reasonCode: enumOf(Object.values(RetractionReason)),
    nonce,
    signedAt: timestamp,
    expiresAt: timestamp,
  },
});

/** Proof-of-possession statement for registering a public key (signed by the NEW key). */
export const keyRegistrationStatementV1 = root('br:key-registration-statement', 1, {
  type: 'object',
  additionalProperties: false,
  required: ['v', 'purpose', 'audience', 'principalId', 'key', 'nonce', 'signedAt', 'expiresAt'],
  properties: {
    v: { type: 'integer', minimum: 1, maximum: 1 },
    purpose: enumOf(['key-registration']),
    audience,
    principalId: uuid,
    key: {
      type: 'object',
      additionalProperties: false,
      required: ['keyId', 'keyKind', 'algorithm', 'verificationMaterialHash'],
      properties: {
        keyId: uuid,
        keyKind: enumOf(['JWK']),
        algorithm: enumOf(['EdDSA', 'ES256']),
        verificationMaterialHash: hashRef,
        effectiveTo: timestamp,
      },
    },
    nonce,
    signedAt: timestamp,
    expiresAt: timestamp,
  },
});

/** Ledger fact of an accepted attestation (payload hash of the ATTESTATION stream entry). */
export const attestationFactV1 = root('br:attestation-fact', 1, {
  type: 'object',
  additionalProperties: false,
  required: [
    'attestationId',
    'statementHash',
    'keyId',
    'proofType',
    'proofScheme',
    'proofDigest',
    'challengeId',
  ],
  properties: {
    attestationId: uuid,
    statementHash: hashRef,
    keyId: uuid,
    proofType: enumOf(Object.values(ProofType)),
    proofScheme: enumOf(Object.values(ProofScheme)),
    proofDigest: hashRef,
    challengeId: uuid,
  },
});

export const attestationRetractionFactV1 = root('br:attestation-retraction-fact', 1, {
  type: 'object',
  additionalProperties: false,
  required: [
    'retractionId',
    'attestationId',
    'statementHash',
    'keyId',
    'proofDigest',
    'challengeId',
  ],
  properties: {
    retractionId: uuid,
    attestationId: uuid,
    statementHash: hashRef,
    keyId: uuid,
    proofDigest: hashRef,
    challengeId: uuid,
  },
});

/** Append-only evidence lifecycle facts (availability, privacy raise, attachment). */
export const evidenceLifecycleFactV1 = root('br:evidence-lifecycle-fact', 1, {
  type: 'object',
  additionalProperties: false,
  required: ['factId', 'evidenceId', 'kind'],
  properties: {
    factId: uuid,
    evidenceId: uuid,
    kind: enumOf(['AVAILABILITY', 'PRIVACY', 'ATTACHMENT']),
    fromStatus: enumOf(Object.values(EvidenceAvailability)),
    toStatus: enumOf(Object.values(EvidenceAvailability)),
    reasonCode: code('^[A-Z][A-Z0-9_]{0,39}$', 40),
    fromClass: enumOf(Object.values(EvidencePrivacyClass)),
    toClass: enumOf(Object.values(EvidencePrivacyClass)),
    targetType: enumOf(Object.values(EvidenceAttachmentTarget)),
    targetId: uuid,
    role: enumOf(Object.values(EvidenceAttachmentRole)),
  },
});

const bundleKey = {
  type: 'object',
  additionalProperties: false,
  required: [
    'keyId',
    'principalId',
    'factHash',
    'verificationMaterialHash',
    'keyKind',
    'algorithm',
    'effectiveFrom',
  ],
  properties: {
    keyId: uuid,
    principalId: uuid,
    factHash: hashRef,
    /** H("key-material", public JWK) — the material the proof must verify against (BRT-03). */
    verificationMaterialHash: hashRef,
    keyKind: enumOf(['WALLET', 'PASSKEY', 'JWK', 'DEVICE', 'KMS']),
    algorithm: enumOf(['ES256', 'ES256K', 'EdDSA', 'RS256']),
    effectiveFrom: timestamp,
    effectiveTo: timestamp,
    statusChanges: setOf(
      {
        type: 'object',
        additionalProperties: false,
        required: ['statusChangeId', 'kind', 'effectiveFrom', 'recordedAt', 'factHash'],
        properties: {
          statusChangeId: uuid,
          kind: enumOf(['ROTATED', 'REVOKED', 'COMPROMISED']),
          effectiveFrom: timestamp,
          recordedAt: timestamp,
          factHash: hashRef,
        },
      },
      { sortBy: ['/statusChangeId'], keyUnique: true },
    ),
  },
} as const;

/**
 * Deterministic Evidence Bundle (BRT-06 → BRT-07 handoff) for one exact ResultVersion "as known at
 * asOf" (transaction-time horizon). Contains facts and references only — NEVER a verdict, level,
 * trust score or authority decision. `bundleHash` = H("evidence-bundle", this).
 */
export const evidenceBundleV1 = root('br:evidence-bundle', 1, {
  type: 'object',
  additionalProperties: false,
  required: ['asOf', 'resultVersion', 'evidence', 'attestations', 'keys', 'lineage'],
  properties: {
    asOf: timestamp,
    resultVersion: {
      type: 'object',
      additionalProperties: false,
      required: [
        'resultVersionId',
        'resultId',
        'versionNumber',
        'contentHash',
        'contentSchema',
        'scope',
      ],
      properties: {
        resultVersionId: uuid,
        resultId: uuid,
        versionNumber: { type: 'integer', minimum: 1 },
        contentHash: hashRef,
        contentSchema: shortText,
        scope: {
          type: 'object',
          additionalProperties: false,
          required: ['scopeType', 'scopeTargetId'],
          properties: {
            scopeType: enumOf(Object.values(ResultScopeType)),
            scopeTargetId: uuid,
            competitionId: uuid,
            eventId: uuid,
            roundId: uuid,
            contestId: uuid,
            sport: code('^[a-z0-9]+(?:[-_][a-z0-9]+)*$', 64),
            discipline: code('^[a-z0-9_-]+(?:\\.[a-z0-9_-]+)*$', 128),
            region: code('^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$', 6),
          },
        },
      },
    },
    evidence: setOf(
      {
        type: 'object',
        additionalProperties: false,
        required: [
          'evidenceId',
          'evidenceType',
          'descriptorHash',
          'contentHash',
          'byteLength',
          'mediaType',
          'source',
          'receivedAt',
          'recordedAt',
          'availability',
          'privacyClass',
          'inclusion',
        ],
        properties: {
          evidenceId: uuid,
          evidenceType,
          descriptorHash: hashRef,
          contentHash: hashRef,
          byteLength,
          mediaType,
          source: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'capturedAtAssurance'],
            properties: {
              kind: enumOf(Object.values(EvidenceSourceKind)),
              principalId: uuid,
              principalType: enumOf(['PLATFORM', 'ORGANIZATION', 'PERSON', 'SYSTEM']),
              capturedAt: timestamp,
              capturedAtAssurance: enumOf(Object.values(CapturedAtAssurance)),
            },
          },
          derivation: {
            type: 'object',
            additionalProperties: false,
            required: ['generatorKind', 'systemId', 'version'],
            properties: {
              generatorKind: enumOf(Object.values(GeneratorKind)),
              systemId,
              version: systemVersion,
              configurationHash: hashRef,
            },
          },
          receivedAt: timestamp,
          recordedAt: timestamp,
          availability: {
            type: 'object',
            additionalProperties: false,
            required: ['status', 'since'],
            properties: { status: enumOf(Object.values(EvidenceAvailability)), since: timestamp },
          },
          privacyClass: enumOf(Object.values(EvidencePrivacyClass)),
          inclusion: setOf(enumOf(['ATTACHED', 'CITED', 'LINEAGE']), { minItems: 1 }),
          attachments: setOf(
            {
              type: 'object',
              additionalProperties: false,
              required: ['attachmentId', 'targetType', 'targetId', 'role', 'recordedAt'],
              properties: {
                attachmentId: uuid,
                targetType: enumOf(Object.values(EvidenceAttachmentTarget)),
                targetId: uuid,
                role: enumOf(Object.values(EvidenceAttachmentRole)),
                recordedAt: timestamp,
              },
            },
            { sortBy: ['/attachmentId'], keyUnique: true },
          ),
        },
      },
      { sortBy: ['/evidenceId'], keyUnique: true },
    ),
    attestations: setOf(
      {
        type: 'object',
        additionalProperties: false,
        required: [
          'attestationId',
          'statementHash',
          'issuer',
          'claim',
          'subjectHash',
          'proof',
          'signedAt',
          'expiresAt',
          'issuedAt',
          'recordedAt',
        ],
        properties: {
          attestationId: uuid,
          statementHash: hashRef,
          issuer: {
            type: 'object',
            additionalProperties: false,
            required: ['principalId', 'principalType', 'keyId'],
            properties: {
              principalId: uuid,
              principalType: enumOf(['PLATFORM', 'ORGANIZATION', 'PERSON', 'SYSTEM']),
              keyId: uuid,
            },
          },
          claim: attestationStatementV1.properties.claim as BrRootSchema['properties'][string],
          subjectHash: hashRef,
          authorityContext: attestationStatementV1.properties
            .authorityContext as BrRootSchema['properties'][string],
          proof: {
            type: 'object',
            additionalProperties: false,
            required: [
              'proofType',
              'proofScheme',
              'algorithm',
              'assurance',
              'verifierId',
              'proofHash',
            ],
            properties: {
              proofType: enumOf(Object.values(ProofType)),
              proofScheme: enumOf(Object.values(ProofScheme)),
              algorithm: enumOf(['EdDSA', 'ES256']),
              assurance: enumOf(Object.values(SignatureAssurance)),
              /** The production verifier that accepted the proof at issuedAt. */
              verifierId: enumOf(['jws-detached/v1']),
              /** SHA-256 of the exact stored detached JWS (RFC 7515 App. F: protected..signature). */
              proofHash: hashRef,
            },
          },
          signedAt: timestamp,
          expiresAt: timestamp,
          issuedAt: timestamp,
          recordedAt: timestamp,
          evidenceRefs: setOf(evidenceRef, { sortBy: ['/evidenceId'], keyUnique: true }),
          supersedesAttestationId: uuid,
          supersededBy: setOf(uuid),
          retraction: {
            type: 'object',
            additionalProperties: false,
            required: [
              'retractionId',
              'statementHash',
              'keyId',
              'proofHash',
              'reasonCode',
              'issuedAt',
              'recordedAt',
            ],
            properties: {
              retractionId: uuid,
              statementHash: hashRef,
              keyId: uuid,
              proofHash: hashRef,
              reasonCode: enumOf(Object.values(RetractionReason)),
              issuedAt: timestamp,
              recordedAt: timestamp,
            },
          },
        },
      },
      { sortBy: ['/attestationId'], keyUnique: true },
    ),
    keys: setOf(bundleKey, { sortBy: ['/keyId'], keyUnique: true }),
    lineage: setOf(
      {
        type: 'object',
        additionalProperties: false,
        required: ['evidenceId', 'relation', 'relatedEvidenceId', 'relatedDescriptorHash'],
        properties: {
          evidenceId: uuid,
          relation: enumOf(Object.values(EvidenceRelationKind)),
          relatedEvidenceId: uuid,
          relatedDescriptorHash: hashRef,
        },
      },
      { sortBy: ['/evidenceId', '/relation', '/relatedEvidenceId'], keyUnique: true },
    ),
  },
});

export const BRT06_SCHEMAS: readonly BrRootSchema[] = [
  evidenceDescriptorV1,
  attestationStatementV1,
  attestationRetractionStatementV1,
  keyRegistrationStatementV1,
  attestationFactV1,
  attestationRetractionFactV1,
  evidenceLifecycleFactV1,
  evidenceBundleV1,
];
