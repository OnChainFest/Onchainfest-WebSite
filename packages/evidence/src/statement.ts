import { randomBytes } from 'node:crypto';
import { CanonicalError, type ContentHash } from '@br/canonical';
import {
  DomainError,
  DomainErrorCode,
  toCanonicalTimestamp,
  type ActingRole,
  type AttestationClaimType,
  type ClaimPolarity,
  type Instant,
  type RetractionReason,
  type StatementPurpose,
  type Uuid,
} from '@br/domain';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';

/**
 * Signed statements (BRT-02 §4.1, ADR-0015). Every signature signs a canonical BR-JSON Statement;
 * each purpose has its own schema AND domain tag, so a statement hash of one purpose can never be
 * confused with another's:
 *
 *   purpose                  schema                                   domain tag
 *   attestation              br:attestation-statement@1               attestation-statement
 *   attestation-retraction   br:attestation-retraction-statement@1    attestation-retraction
 *   key-registration         br:key-registration-statement@1          key-registration
 *
 *   statementHash = SHA-256("BR" ‖ 0x01 ‖ tag ‖ 0x00 ‖ schema@1 ‖ 0x00 ‖ "br-json/1" ‖ 0x00 ‖ JCS(statement))
 *
 * Every statement binds `audience` (environment), `purpose`, the issuer principal AND key, the
 * exact subject hash, a 128-bit single-use `nonce` (the ceremony challenge) and `expiresAt`.
 */
export const STATEMENT_KINDS = {
  attestation: {
    purpose: 'attestation',
    schema: SchemaRef.attestationStatement,
    domainTag: DomainTag.attestationStatement,
  },
  'attestation-retraction': {
    purpose: 'attestation-retraction',
    schema: SchemaRef.attestationRetractionStatement,
    domainTag: DomainTag.attestationRetraction,
  },
  'key-registration': {
    purpose: 'key-registration',
    schema: SchemaRef.keyRegistrationStatement,
    domainTag: DomainTag.keyRegistration,
  },
} as const satisfies Record<
  StatementPurpose,
  {
    purpose: StatementPurpose;
    schema: { id: string; version: number };
    domainTag: string;
  }
>;

export const AUDIENCE_PATTERN = /^bragging-rights:[a-z0-9-]{1,32}$/;
/** BRT-02 §5: statements for human signers expire within 24 h of signedAt. */
export const MAX_STATEMENT_LIFETIME_MS = 24 * 60 * 60 * 1000;

export interface HashedStatement<S = Record<string, unknown>> {
  readonly purpose: StatementPurpose;
  readonly statement: S;
  readonly statementHash: ContentHash;
  readonly canonicalText: string;
}

const invalid = (message: string) => new DomainError(DomainErrorCode.INVALID_INPUT, message);

/** 128-bit random nonce, base64url (22 chars). */
export function newNonce(): string {
  return randomBytes(16).toString('base64url');
}

export function assertAudience(audience: string): string {
  if (!AUDIENCE_PATTERN.test(audience)) throw invalid('invalid signature audience');
  return audience;
}

/** Canonicalizes + hashes a statement of the given purpose. Unknown members are rejected. */
export function hashStatement<S = Record<string, unknown>>(
  purpose: StatementPurpose,
  doc: unknown,
): HashedStatement<S> {
  const kind = STATEMENT_KINDS[purpose];
  try {
    const r = platformCanonicalizer().hashCanonical(
      kind.domainTag,
      kind.schema.id,
      kind.schema.version,
      doc,
    );
    const statement = r.normalized as unknown as { purpose?: unknown };
    if (statement.purpose !== purpose) throw invalid('statement purpose mismatch');
    return {
      purpose,
      statement: r.normalized as unknown as S,
      statementHash: r.contentHash,
      canonicalText: r.canonicalText,
    };
  } catch (err) {
    if (err instanceof CanonicalError) throw invalid(`statement rejected: ${err.code}`);
    throw err;
  }
}

function assertTimes(signedAt: Instant, expiresAt: Instant): void {
  const lifetime = expiresAt.getTime() - signedAt.getTime();
  if (lifetime <= 0) throw invalid('expiresAt must follow signedAt');
  if (lifetime > MAX_STATEMENT_LIFETIME_MS) throw invalid('statement lifetime exceeds 24 hours');
}

// ───────────────────────────── attestation statement ─────────────────────────────

export interface ConditionObservation {
  readonly aspect: string;
  readonly key: string;
  readonly value?: string;
  readonly unit?: string;
  readonly code?: string;
}

export interface AttestationClaim {
  readonly type: AttestationClaimType;
  readonly polarity: ClaimPolarity;
  readonly payload?: {
    readonly conditions?: readonly ConditionObservation[];
    readonly reasonCode?:
      'SCORE_INCORRECT' | 'OUTCOME_INCORRECT' | 'PARTICIPANT_INCORRECT' | 'OTHER';
  };
}

export interface EvidenceCitation {
  readonly evidenceId: Uuid;
  readonly contentHash: string;
  readonly descriptorHash: string;
}

export interface AttestationStatementInput {
  readonly audience: string;
  readonly issuer: { readonly principalId: Uuid; readonly keyId: Uuid };
  readonly subject: { readonly type: 'RESULT_VERSION'; readonly id: Uuid; readonly hash: string };
  readonly claim: AttestationClaim;
  readonly authorityContext?: {
    readonly actingRole: ActingRole;
    readonly scopeRef?: {
      readonly level: 'COMPETITION' | 'EVENT' | 'ROUND' | 'CONTEST';
      readonly id: Uuid;
    };
  };
  readonly evidenceRefs?: readonly EvidenceCitation[];
  readonly supersedes?: { readonly attestationId: Uuid; readonly statementHash: string };
  readonly nonce: string;
  readonly signedAt: Instant;
  readonly expiresAt: Instant;
}

export interface AttestationStatement {
  readonly v: 1;
  readonly purpose: 'attestation';
  readonly audience: string;
  readonly issuer: { readonly principalId: string; readonly keyId: string };
  readonly subject: { readonly type: 'RESULT_VERSION'; readonly id: string; readonly hash: string };
  readonly claim: AttestationClaim;
  readonly authorityContext?: AttestationStatementInput['authorityContext'];
  readonly evidenceRefs?: readonly EvidenceCitation[];
  readonly supersedes?: { readonly attestationId: string; readonly statementHash: string };
  readonly nonce: string;
  readonly signedAt: string;
  readonly expiresAt: string;
}

/** Claim-type rules the schema cannot express (bounded claim language, no executable content). */
export function assertClaimShape(claim: AttestationClaim): void {
  const conditions = claim.payload?.conditions ?? [];
  const reason = claim.payload?.reasonCode;
  if (claim.type === 'RESULT_ACCURATE') {
    if (conditions.length > 0) throw invalid('RESULT_ACCURATE claims carry no conditions');
    if (reason !== undefined && claim.polarity !== 'DENY')
      throw invalid('a reasonCode is only meaningful on a DENY claim');
  } else {
    if (conditions.length === 0) throw invalid('CONDITIONS_COMPLIANT claims need observations');
    if (reason !== undefined) throw invalid('CONDITIONS_COMPLIANT claims carry no reasonCode');
    for (const c of conditions) {
      if (c.value === undefined && c.code === undefined)
        throw invalid('each condition observation needs a value or a code');
      if (c.unit !== undefined && c.value === undefined)
        throw invalid('a condition unit needs a value');
    }
  }
}

export function attestationStatementDocument(
  input: AttestationStatementInput,
): Record<string, unknown> {
  assertAudience(input.audience);
  assertTimes(input.signedAt, input.expiresAt);
  assertClaimShape(input.claim);
  return {
    v: 1,
    purpose: 'attestation',
    audience: input.audience,
    issuer: { principalId: input.issuer.principalId, keyId: input.issuer.keyId },
    subject: { type: input.subject.type, id: input.subject.id, hash: input.subject.hash },
    claim: input.claim,
    ...(input.authorityContext === undefined ? {} : { authorityContext: input.authorityContext }),
    ...(input.evidenceRefs === undefined || input.evidenceRefs.length === 0
      ? {}
      : { evidenceRefs: input.evidenceRefs }),
    ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
    nonce: input.nonce,
    signedAt: toCanonicalTimestamp(input.signedAt),
    expiresAt: toCanonicalTimestamp(input.expiresAt),
  };
}

export function buildAttestationStatement(
  input: AttestationStatementInput,
): HashedStatement<AttestationStatement> {
  return hashStatement<AttestationStatement>('attestation', attestationStatementDocument(input));
}

// ───────────────────────────── retraction statement ─────────────────────────────

export interface RetractionStatement {
  readonly v: 1;
  readonly purpose: 'attestation-retraction';
  readonly audience: string;
  readonly issuer: { readonly principalId: string; readonly keyId: string };
  readonly subject: { readonly type: 'ATTESTATION'; readonly id: string; readonly hash: string };
  readonly reasonCode: RetractionReason;
  readonly nonce: string;
  readonly signedAt: string;
  readonly expiresAt: string;
}

export function buildRetractionStatement(input: {
  readonly audience: string;
  readonly issuer: { readonly principalId: Uuid; readonly keyId: Uuid };
  readonly attestationId: Uuid;
  readonly attestationStatementHash: string;
  readonly reasonCode: RetractionReason;
  readonly nonce: string;
  readonly signedAt: Instant;
  readonly expiresAt: Instant;
}): HashedStatement<RetractionStatement> {
  assertAudience(input.audience);
  assertTimes(input.signedAt, input.expiresAt);
  return hashStatement<RetractionStatement>('attestation-retraction', {
    v: 1,
    purpose: 'attestation-retraction',
    audience: input.audience,
    issuer: input.issuer,
    subject: { type: 'ATTESTATION', id: input.attestationId, hash: input.attestationStatementHash },
    reasonCode: input.reasonCode,
    nonce: input.nonce,
    signedAt: toCanonicalTimestamp(input.signedAt),
    expiresAt: toCanonicalTimestamp(input.expiresAt),
  });
}

// ───────────────────────────── key registration statement ─────────────────────────────

export interface KeyRegistrationStatement {
  readonly v: 1;
  readonly purpose: 'key-registration';
  readonly audience: string;
  readonly principalId: string;
  readonly key: {
    readonly keyId: string;
    readonly keyKind: 'JWK';
    readonly algorithm: 'EdDSA' | 'ES256';
    readonly verificationMaterialHash: string;
    readonly effectiveTo?: string;
  };
  readonly nonce: string;
  readonly signedAt: string;
  readonly expiresAt: string;
}

export function buildKeyRegistrationStatement(input: {
  readonly audience: string;
  readonly principalId: Uuid;
  readonly keyId: Uuid;
  readonly algorithm: 'EdDSA' | 'ES256';
  readonly verificationMaterialHash: string;
  readonly effectiveTo?: Instant;
  readonly nonce: string;
  readonly signedAt: Instant;
  readonly expiresAt: Instant;
}): HashedStatement<KeyRegistrationStatement> {
  assertAudience(input.audience);
  assertTimes(input.signedAt, input.expiresAt);
  return hashStatement<KeyRegistrationStatement>('key-registration', {
    v: 1,
    purpose: 'key-registration',
    audience: input.audience,
    principalId: input.principalId,
    key: {
      keyId: input.keyId,
      keyKind: 'JWK',
      algorithm: input.algorithm,
      verificationMaterialHash: input.verificationMaterialHash,
      ...(input.effectiveTo === undefined
        ? {}
        : { effectiveTo: toCanonicalTimestamp(input.effectiveTo) }),
    },
    nonce: input.nonce,
    signedAt: toCanonicalTimestamp(input.signedAt),
    expiresAt: toCanonicalTimestamp(input.expiresAt),
  });
}
