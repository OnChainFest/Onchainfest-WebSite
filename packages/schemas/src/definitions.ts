import type { BrRootSchema } from '@br/canonical';
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
];
