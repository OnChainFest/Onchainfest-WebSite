import type { BrRootSchema, BrStringSchema } from '@br/canonical';
import { ResultOutcome, ResultScopeType, ResultVersionStatus, TransitionCode } from '@br/domain';
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
