import {
  DomainError,
  DomainErrorCode,
  newId,
  type ActingRole,
  type RetractionReason,
  type Uuid,
} from '@br/domain';
import {
  assertAudience,
  buildAttestationStatement,
  buildRetractionStatement,
  detachedJwsHash,
  evaluateKeyAdmissibility,
  hashStatement,
  jwsDetachedVerifier,
  JWS_ALGORITHMS,
  newNonce,
  signingRequest,
  verifyStoredProof,
  type AttestationClaim,
  type AttestationProofVerifier,
  type AttestationStatement,
  type EvidenceCitation,
  type JwsAlgorithm,
  type RetractionStatement,
  type SigningRequest,
} from '@br/evidence';
import { SchemaRef } from '@br/schemas';
import { sql } from 'kysely';
import type { Db } from './db';
import {
  evidenceAccess,
  evidenceNotFound,
  loadItem,
  loadKeyFacts,
  principalType,
  representation,
  resolveResultVersion,
  resultVersionPath,
  unwrap,
  type Committed,
} from './evidence-support';
import { refreshAttestationCard } from './evidence-projection';
import { factHash } from './hashing';
import { identityIdempotency, lockKeys, payloadDigest, recordAudit } from './identity-support';
import { openStream, StreamType } from './ledger';
import { emitEvent } from './outbox';
import { inTransaction, ModuleRole, type TxContext } from './tx';

/**
 * BRT-06 Attestations (br_evidence). An attestation is an immutable, cryptographically signed
 * CLAIM by an identified Principal about an exact ResultVersion. Storing one requires:
 *   1. an authenticated account that REPRESENTS the issuer Principal (application permission:
 *      SELF for a PERSON principal, OWNER/ADMIN for an ORGANIZATION principal) — never a Capability;
 *   2. a key of that Principal admissible at the platform-observed acceptance time;
 *   3. a valid production proof over the exact statement the server canonicalized, through a
 *      single-use, expiring, audience- and purpose-bound challenge.
 * It does NOT require (and never records) an authority decision: BRT-07 evaluates grants/anchors,
 * retroactive compromise and policy later. It never moves a Result's lifecycle, never creates a
 * Verification and never resolves bracket dependencies. Conflicting attestations coexist.
 */
export const ATTESTATION_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const SUPPORTED_ALGORITHMS: readonly string[] = JWS_ALGORITHMS;

export interface PreparedStatement<S> {
  readonly challengeId: string;
  readonly purpose: string;
  readonly statement: S;
  readonly statementHash: string;
  /** Exact JCS text of the statement (what statementHash commits to). */
  readonly canonicalStatement: string;
  readonly signing: SigningRequest;
  readonly expiresAt: string;
}

export interface SubmitProofInput {
  readonly actorAccountId: string;
  readonly idempotencyKey: string;
  readonly challengeId: string;
  /** Optional echo of the statement the signer signed; re-canonicalized and compared. */
  readonly statement?: unknown;
  readonly statementHash?: string;
  readonly proof: {
    readonly proofType: string;
    readonly scheme: string;
    readonly protected: string;
    readonly signature: string;
  };
}

interface ChallengeRow {
  id: string;
  purpose: 'attestation' | 'attestation-retraction';
  account_id: string;
  issuer_principal_id: string;
  key_id: string;
  target_attestation_id: string | null;
  statement: Record<string, unknown>;
  statement_hash: string;
  nonce: string;
  audience: string;
  visibility: 'PUBLIC' | 'PRIVATE' | null;
  expires_at: Date;
  recorded_at: Date;
}

const rejected = (code: DomainErrorCode, message: string, details: Record<string, unknown> = {}) =>
  new DomainError(code, message, details);

export class AttestationStore {
  private readonly db: Db;
  private readonly audience: string;
  private readonly ttlMs: number;
  private readonly verifiers: readonly AttestationProofVerifier[];

  constructor(
    db: Db,
    options: {
      /** Environment binding, e.g. "bragging-rights:prod". */
      audience: string;
      challengeTtlMs?: number;
      verifiers?: readonly AttestationProofVerifier[];
    },
  ) {
    this.db = db;
    this.audience = assertAudience(options.audience);
    this.ttlMs = options.challengeTtlMs ?? ATTESTATION_CHALLENGE_TTL_MS;
    this.verifiers = options.verifiers ?? [jwsDetachedVerifier];
    if (this.verifiers.some((v) => v.kind !== 'PRODUCTION'))
      throw new Error('only production proof verifiers exist for attestations');
  }

  private tx<T>(fn: (ctx: TxContext) => Promise<T>): Promise<T> {
    return inTransaction(this.db, ModuleRole.evidence, fn);
  }

  /** Issuer representation, audited on denial (the denial is committed before it surfaces). */
  private async requireRepresentation(
    ctx: TxContext,
    accountId: string,
    principalId: string,
    action: string,
  ): Promise<DomainError | undefined> {
    const basis = await representation(ctx, accountId, principalId);
    if (basis !== undefined) return undefined;
    await recordAudit(ctx, {
      actorAccountId: accountId,
      action: `${action}.issuer-denied`,
      targetType: 'PRINCIPAL',
      targetId: (await principalType(ctx, principalId)) === undefined ? undefined : principalId,
      outcome: 'DENIED',
    });
    return rejected(
      DomainErrorCode.ISSUER_NOT_CONTROLLED,
      'the account cannot represent this issuer principal',
    );
  }

  private async admissibleKey(
    ctx: TxContext,
    issuerPrincipalId: string,
    keyId: string,
    signedAt?: Date,
  ) {
    const facts = await loadKeyFacts(ctx, keyId);
    const decision = evaluateKeyAdmissibility({
      key: facts.key,
      statusChanges: facts.statusChanges,
      issuerPrincipalId,
      issuedAt: ctx.txTime,
      ...(signedAt === undefined ? {} : { signedAt }),
      supportedAlgorithms: SUPPORTED_ALGORITHMS,
    });
    return { facts, decision };
  }

  private async insertChallenge(
    ctx: TxContext,
    row: Omit<ChallengeRow, 'recorded_at'>,
  ): Promise<void> {
    await sql`INSERT INTO attestation.challenge (id, purpose, account_id, issuer_principal_id, key_id, target_attestation_id,
        statement, statement_hash, nonce, audience, visibility, expires_at, recorded_at)
      VALUES (${row.id}, ${row.purpose}, ${row.account_id}, ${row.issuer_principal_id}, ${row.key_id},
        ${row.target_attestation_id}, ${JSON.stringify(row.statement)}, ${row.statement_hash}, ${row.nonce},
        ${row.audience}, ${row.visibility}, ${row.expires_at}, ${ctx.txTime})`.execute(ctx.trx);
  }

  private async loadChallenge(ctx: TxContext, id: string): Promise<ChallengeRow | undefined> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
    const { rows } =
      await sql<ChallengeRow>`SELECT * FROM attestation.challenge WHERE id = ${id}`.execute(
        ctx.trx,
      );
    return rows[0];
  }

  private prepared<S>(c: ChallengeRow, algorithm: JwsAlgorithm): PreparedStatement<S> {
    const hashed = hashStatement<S>(c.purpose, c.statement);
    if (hashed.statementHash !== c.statement_hash)
      throw new Error('stored challenge statement does not reproduce its hash');
    return {
      challengeId: c.id,
      purpose: c.purpose,
      statement: hashed.statement,
      statementHash: hashed.statementHash,
      canonicalStatement: hashed.canonicalText,
      signing: signingRequest(algorithm, c.key_id, hashed.statementHash),
      expiresAt: c.expires_at.toISOString(),
    };
  }

  // ───────────────────────────── prepare ─────────────────────────────

  /**
   * Step 1: the server resolves the exact subject hash and evidence hashes, canonicalizes the
   * EXACT statement and stores a single-use challenge (nonce, audience, purpose, issuer, key,
   * subject, expiry are all inside the statement). Returns the JWS signing input to sign
   * externally. Nothing is accepted yet.
   */
  async prepare(input: {
    readonly actorAccountId: string;
    readonly idempotencyKey: string;
    readonly issuerPrincipalId: string;
    readonly keyId: string;
    readonly subject: { readonly type: 'RESULT_VERSION'; readonly id: string };
    readonly claim: AttestationClaim;
    readonly authorityContext?: {
      readonly actingRole: ActingRole;
      readonly scopeRef?: {
        readonly level: 'COMPETITION' | 'EVENT' | 'ROUND' | 'CONTEST';
        readonly id: string;
      };
    };
    readonly evidenceIds?: readonly string[];
    readonly supersedesAttestationId?: string;
    readonly visibility?: 'PUBLIC' | 'PRIVATE';
  }): Promise<PreparedStatement<AttestationStatement>> {
    const evidenceIds = input.evidenceIds ?? [];
    if (new Set(evidenceIds).size !== evidenceIds.length)
      throw new DomainError(DomainErrorCode.INVALID_INPUT, 'duplicate evidence reference');
    const r = await this.tx(
      async (ctx): Promise<Committed<PreparedStatement<AttestationStatement>>> => {
        const idem = await identityIdempotency<{ challengeId: string }>(ctx, {
          command: 'PrepareAttestation',
          actorAccountId: input.actorAccountId,
          idempotencyKey: input.idempotencyKey,
          params: { ...input, idempotencyKey: undefined, actorAccountId: undefined },
        });
        if (idem.lookup.replay) {
          const c = (await this.loadChallenge(
            ctx,
            idem.lookup.response.challengeId,
          )) as ChallengeRow;
          const { facts } = await this.admissibleKey(ctx, c.issuer_principal_id, c.key_id);
          return { ok: this.prepared(c, facts.key?.algorithm as JwsAlgorithm) };
        }
        const denied = await this.requireRepresentation(
          ctx,
          input.actorAccountId,
          input.issuerPrincipalId,
          'attestation',
        );
        if (denied !== undefined) return { error: denied };
        const { facts, decision } = await this.admissibleKey(
          ctx,
          input.issuerPrincipalId,
          input.keyId,
        );
        if (!decision.admissible)
          return {
            error: rejected(DomainErrorCode.KEY_NOT_VALID, 'key is not valid for this issuer', {
              reason: decision.reason,
            }),
          };
        const rv = await resolveResultVersion(ctx, input.subject.id);
        if (rv === undefined)
          throw new DomainError(DomainErrorCode.NOT_FOUND, 'result version not found');
        if (input.authorityContext?.scopeRef !== undefined) {
          const path = await resultVersionPath(ctx, rv);
          const ref = input.authorityContext.scopeRef;
          const byLevel: Record<string, string | undefined> = {
            COMPETITION: path?.competitionId,
            EVENT: path?.eventId,
            ROUND: path?.roundId,
            CONTEST: path?.contestId,
          };
          if (byLevel[ref.level] !== ref.id)
            throw new DomainError(
              DomainErrorCode.INVALID_INPUT,
              'scopeRef is not in the subject hierarchy',
            );
        }
        const citations: EvidenceCitation[] = [];
        for (const id of evidenceIds) {
          const item = await loadItem(ctx, id);
          if (
            item === undefined ||
            !(await evidenceAccess(ctx, { accountId: input.actorAccountId }, item, 'CITE')).allowed
          )
            throw evidenceNotFound();
          citations.push({
            evidenceId: item.id as Uuid,
            contentHash: item.content_hash,
            descriptorHash: item.descriptor_hash,
          });
        }
        let supersedes: { attestationId: Uuid; statementHash: string } | undefined;
        if (input.supersedesAttestationId !== undefined) {
          const { rows } = await sql<{
            statement_hash: string;
            issuer_principal_id: string;
            subject_id: string;
          }>`
          SELECT statement_hash, issuer_principal_id, subject_id FROM attestation.attestation
          WHERE id = ${input.supersedesAttestationId}`.execute(ctx.trx);
          const prev = rows[0];
          const prevRv =
            prev === undefined ? undefined : await resolveResultVersion(ctx, prev.subject_id);
          if (
            prev === undefined ||
            prev.issuer_principal_id !== input.issuerPrincipalId ||
            prevRv?.resultId !== rv.resultId
          )
            throw new DomainError(
              DomainErrorCode.INVALID_INPUT,
              'only an earlier attestation of the same issuer on the same Result can be superseded',
            );
          supersedes = {
            attestationId: input.supersedesAttestationId as Uuid,
            statementHash: prev.statement_hash,
          };
        }
        const expiresAt = new Date(ctx.txTime.getTime() + this.ttlMs);
        const hashed = buildAttestationStatement({
          audience: this.audience,
          issuer: { principalId: input.issuerPrincipalId as Uuid, keyId: input.keyId as Uuid },
          subject: { type: 'RESULT_VERSION', id: rv.resultVersionId as Uuid, hash: rv.contentHash },
          claim: input.claim,
          ...(input.authorityContext === undefined
            ? {}
            : {
                authorityContext: {
                  actingRole: input.authorityContext.actingRole,
                  ...(input.authorityContext.scopeRef === undefined
                    ? {}
                    : {
                        scopeRef: {
                          level: input.authorityContext.scopeRef.level,
                          id: input.authorityContext.scopeRef.id as Uuid,
                        },
                      }),
                },
              }),
          evidenceRefs: citations,
          ...(supersedes === undefined ? {} : { supersedes }),
          nonce: newNonce(),
          signedAt: ctx.txTime,
          expiresAt,
        });
        const row: Omit<ChallengeRow, 'recorded_at'> = {
          id: newId(),
          purpose: 'attestation',
          account_id: input.actorAccountId,
          issuer_principal_id: input.issuerPrincipalId,
          key_id: input.keyId,
          target_attestation_id: null,
          statement: hashed.statement as unknown as Record<string, unknown>,
          statement_hash: hashed.statementHash,
          nonce: hashed.statement.nonce,
          audience: this.audience,
          visibility: input.visibility ?? 'PUBLIC',
          expires_at: expiresAt,
        };
        await this.insertChallenge(ctx, row);
        await idem.record({ challengeId: row.id });
        return {
          ok: this.prepared<AttestationStatement>(
            { ...row, recorded_at: ctx.txTime },
            facts.key?.algorithm as JwsAlgorithm,
          ),
        };
      },
    );
    return unwrap(r);
  }

  // ───────────────────────────── shared acceptance ─────────────────────────────

  /**
   * Consumes the challenge exactly once and verifies everything. Rejections are COMMITTED
   * (consumption + audit) before they surface, so a rejected proof can never be retried against
   * the same challenge.
   */
  private async accept(
    ctx: TxContext,
    input: SubmitProofInput,
    purpose: ChallengeRow['purpose'],
  ): Promise<
    | { error: DomainError }
    | { challenge: ChallengeRow; algorithm: JwsAlgorithm; assurance: string; verifierId: string }
  > {
    await lockKeys(ctx, `attestation-challenge:${input.challengeId}`);
    const c = await this.loadChallenge(ctx, input.challengeId);
    if (c === undefined || c.account_id !== input.actorAccountId || c.purpose !== purpose)
      return { error: rejected(DomainErrorCode.CHALLENGE_INVALID, 'challenge not found') };
    const { rows: used } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM attestation.challenge_consumption WHERE challenge_id = ${c.id}`.execute(
      ctx.trx,
    );
    if ((used[0]?.n ?? 0) > 0)
      return {
        error: rejected(DomainErrorCode.ATTESTATION_CHALLENGE_USED, 'challenge already used'),
      };
    const reject = async (reason: string, error: DomainError) => {
      await sql`INSERT INTO attestation.challenge_consumption (challenge_id, outcome, reason_code, recorded_at)
        VALUES (${c.id}, 'REJECTED', ${reason}, ${ctx.txTime})`.execute(ctx.trx);
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: `${purpose}.rejected`,
        targetType: 'ATTESTATION_CHALLENGE',
        targetId: c.id,
        outcome: 'DENIED',
        details: { reason },
      });
      return { error };
    };
    // Environment binding: a statement signed for another audience is never accepted here.
    if (
      c.audience !== this.audience ||
      (c.statement as { audience?: unknown }).audience !== this.audience
    )
      return reject(
        'WRONG_AUDIENCE',
        rejected(
          DomainErrorCode.ATTESTATION_PROOF_INVALID,
          'statement audience does not match this environment',
        ),
      );
    // Strict: the challenge (and the signed expiresAt) bound the online signing window. No slack.
    if (ctx.txTime.getTime() > c.expires_at.getTime())
      return reject(
        'EXPIRED',
        rejected(DomainErrorCode.ATTESTATION_CHALLENGE_EXPIRED, 'challenge expired'),
      );
    if (input.proof.proofType !== 'DIRECT_SIGNATURE' || input.proof.scheme !== 'JWS_DETACHED')
      return reject(
        'WRONG_SCHEME',
        rejected(DomainErrorCode.ATTESTATION_PROOF_INVALID, 'unsupported proof scheme'),
      );
    // The stored statement must still reproduce its hash; an echoed statement must be identical.
    const stored = hashStatement(c.purpose, c.statement);
    if (stored.statementHash !== c.statement_hash)
      throw new Error('challenge statement integrity failure');
    if (input.statementHash !== undefined && input.statementHash !== c.statement_hash)
      return reject(
        'STATEMENT_MISMATCH',
        rejected(
          DomainErrorCode.ATTESTATION_PROOF_INVALID,
          'statement does not match the challenge',
        ),
      );
    if (input.statement !== undefined) {
      let echoed: string | undefined;
      try {
        echoed = hashStatement(c.purpose, input.statement).statementHash;
      } catch {
        echoed = undefined;
      }
      if (echoed !== c.statement_hash)
        return reject(
          'STATEMENT_MISMATCH',
          rejected(
            DomainErrorCode.ATTESTATION_PROOF_INVALID,
            'statement does not match the challenge',
          ),
        );
    }
    const denied = await this.requireRepresentation(
      ctx,
      input.actorAccountId,
      c.issuer_principal_id,
      purpose,
    );
    if (denied !== undefined) return reject('ISSUER_NOT_CONTROLLED', denied);
    const signedAt = new Date(String((c.statement as { signedAt: string }).signedAt));
    const { facts, decision } = await this.admissibleKey(
      ctx,
      c.issuer_principal_id,
      c.key_id,
      signedAt,
    );
    if (!decision.admissible || facts.key === undefined)
      return reject(
        decision.admissible ? 'KEY_UNKNOWN' : decision.reason,
        rejected(DomainErrorCode.KEY_NOT_VALID, 'key is not valid for this issuer', {
          reason: decision.admissible ? 'KEY_UNKNOWN' : decision.reason,
        }),
      );
    const verifier = this.verifiers.find(
      (v) => v.proofType === input.proof.proofType && v.scheme === input.proof.scheme,
    );
    const verification = verifier?.verify({
      statementHash: c.statement_hash,
      keyId: c.key_id,
      keyKind: facts.key.keyKind,
      algorithm: facts.key.algorithm,
      verificationMaterial: facts.key.verificationMaterial,
      proof: { protected: input.proof.protected, signature: input.proof.signature },
    });
    if (verification === undefined || !verification.ok)
      return reject(
        'PROOF_INVALID',
        rejected(
          DomainErrorCode.ATTESTATION_PROOF_INVALID,
          'proof does not verify for this statement and key',
        ),
      );
    return {
      challenge: c,
      algorithm: facts.key.algorithm as JwsAlgorithm,
      assurance: verification.assurance,
      verifierId: verification.verifierId,
    };
  }

  private proofDigest(proof: SubmitProofInput['proof']): string {
    return detachedJwsHash({ protected: proof.protected, signature: proof.signature });
  }

  // ───────────────────────────── submit ─────────────────────────────

  async submit(input: SubmitProofInput): Promise<AttestationAccepted> {
    const r = await this.tx(async (ctx): Promise<Committed<AttestationAccepted>> => {
      const idem = await identityIdempotency<AttestationAccepted>(ctx, {
        command: 'SubmitAttestation',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: {
          challengeId: input.challengeId,
          statementHash: input.statementHash,
          statementDigest:
            input.statement === undefined ? undefined : payloadDigest(input.statement),
          proofType: input.proof.proofType,
          scheme: input.proof.scheme,
          proofDigest: this.proofDigest(input.proof),
        },
      });
      if (idem.lookup.replay) return { ok: idem.lookup.response };
      const accepted = await this.accept(ctx, input, 'attestation');
      if ('error' in accepted) return accepted;
      const { challenge: c, algorithm, assurance, verifierId } = accepted;
      const statement = c.statement as unknown as AttestationStatement;
      const id = newId();
      const issuerType = (await principalType(ctx, c.issuer_principal_id)) as string;
      await sql`INSERT INTO attestation.challenge_consumption (challenge_id, outcome, reason_code, recorded_at)
        VALUES (${c.id}, 'ACCEPTED', 'VERIFIED', ${ctx.txTime})`.execute(ctx.trx);
      await sql`INSERT INTO attestation.attestation (id, statement, statement_schema, statement_hash, audience,
          issuer_principal_id, issuer_principal_type, key_id, subject_type, subject_id, subject_hash, claim_type, polarity,
          nonce, signed_at, expires_at, proof_type, proof_scheme, proof_algorithm, proof, verifier_id, assurance,
          challenge_id, submitted_by_account_id, visibility, supersedes_attestation_id, received_at, issued_at, recorded_at)
        VALUES (${id}, ${JSON.stringify(statement)}, 'br:attestation-statement@1', ${c.statement_hash}, ${c.audience},
          ${c.issuer_principal_id}, ${issuerType}, ${c.key_id}, ${statement.subject.type}, ${statement.subject.id},
          ${statement.subject.hash}, ${statement.claim.type}, ${statement.claim.polarity}, ${statement.nonce},
          ${statement.signedAt}, ${statement.expiresAt}, 'DIRECT_SIGNATURE', 'JWS_DETACHED', ${algorithm},
          ${JSON.stringify({ protected: input.proof.protected, signature: input.proof.signature })}, ${verifierId},
          ${assurance}, ${c.id}, ${input.actorAccountId}, ${c.visibility}, ${statement.supersedes?.attestationId ?? null},
          ${ctx.txTime}, ${ctx.txTime}, ${ctx.txTime})`.execute(ctx.trx);
      for (const ref of statement.evidenceRefs ?? []) {
        await sql`INSERT INTO attestation.attestation_evidence (attestation_id, evidence_id, content_hash, descriptor_hash, recorded_at)
          VALUES (${id}, ${ref.evidenceId}, ${ref.contentHash}, ${ref.descriptorHash}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
      }
      const fact = factHash(SchemaRef.attestationFact, {
        attestationId: id,
        statementHash: c.statement_hash,
        keyId: c.key_id,
        proofType: 'DIRECT_SIGNATURE',
        proofScheme: 'JWS_DETACHED',
        proofDigest: this.proofDigest(input.proof),
        challengeId: c.id,
      });
      const stream = await openStream(ctx, id, StreamType.ATTESTATION);
      await stream.append({
        eventType: 'ATTESTATION_ISSUED',
        factTable: 'attestation.attestation',
        factRowId: id,
        payloadHash: fact,
      });
      await stream.close();
      await emitEvent(ctx, {
        eventType: 'AttestationIssued',
        aggregateType: 'ATTESTATION',
        aggregateId: id,
        payload: {
          statementHash: c.statement_hash,
          subjectType: statement.subject.type,
          subjectId: statement.subject.id,
          claimType: statement.claim.type,
          polarity: statement.claim.polarity,
          proofScheme: 'JWS_DETACHED',
          evidenceCount: statement.evidenceRefs?.length ?? 0,
          // Explicitly not an authority or verification outcome.
          authority: 'NOT_EVALUATED',
        },
      });
      if (statement.supersedes !== undefined) {
        await emitEvent(ctx, {
          eventType: 'AttestationSuperseded',
          aggregateType: 'ATTESTATION',
          aggregateId: statement.supersedes.attestationId as Uuid,
          payload: { supersededBy: id },
        });
      }
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'attestation.submitted',
        targetType: 'ATTESTATION',
        targetId: id,
        details: { claimType: statement.claim.type, polarity: statement.claim.polarity },
      });
      await refreshAttestationCard(ctx, id);
      if (statement.supersedes !== undefined)
        await refreshAttestationCard(ctx, statement.supersedes.attestationId);
      const response: AttestationAccepted = {
        attestationId: id,
        statementHash: c.statement_hash,
        issuedAt: ctx.txTime.toISOString(),
        signature: 'VALID',
        authority: 'NOT_EVALUATED',
        verification: 'NOT_IMPLEMENTED',
        created: true,
      };
      await idem.record(response);
      return { ok: response };
    });
    return unwrap(r);
  }

  // ───────────────────────────── retraction ─────────────────────────────

  async prepareRetraction(input: {
    readonly actorAccountId: string;
    readonly idempotencyKey: string;
    readonly attestationId: string;
    readonly keyId: string;
    readonly reasonCode: RetractionReason;
  }): Promise<PreparedStatement<RetractionStatement>> {
    const r = await this.tx(
      async (ctx): Promise<Committed<PreparedStatement<RetractionStatement>>> => {
        const idem = await identityIdempotency<{ challengeId: string }>(ctx, {
          command: 'PrepareAttestationRetraction',
          actorAccountId: input.actorAccountId,
          idempotencyKey: input.idempotencyKey,
          params: {
            attestationId: input.attestationId,
            keyId: input.keyId,
            reasonCode: input.reasonCode,
          },
        });
        if (idem.lookup.replay) {
          const c = (await this.loadChallenge(
            ctx,
            idem.lookup.response.challengeId,
          )) as ChallengeRow;
          const { facts } = await this.admissibleKey(ctx, c.issuer_principal_id, c.key_id);
          return { ok: this.prepared(c, facts.key?.algorithm as JwsAlgorithm) };
        }
        const { rows } = await sql<{
          id: string;
          issuer_principal_id: string;
          statement_hash: string;
        }>`
        SELECT id, issuer_principal_id, statement_hash FROM attestation.attestation WHERE id = ${input.attestationId}`.execute(
          ctx.trx,
        );
        const a = rows[0];
        if (a === undefined)
          throw new DomainError(DomainErrorCode.NOT_FOUND, 'attestation not found');
        const denied = await this.requireRepresentation(
          ctx,
          input.actorAccountId,
          a.issuer_principal_id,
          'attestation-retraction',
        );
        if (denied !== undefined) return { error: denied };
        const { rows: done } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM attestation.retraction WHERE attestation_id = ${a.id}`.execute(
          ctx.trx,
        );
        if ((done[0]?.n ?? 0) > 0)
          throw new DomainError(
            DomainErrorCode.INVALID_TRANSITION,
            'attestation is already retracted',
          );
        const { facts, decision } = await this.admissibleKey(
          ctx,
          a.issuer_principal_id,
          input.keyId,
        );
        if (!decision.admissible)
          return {
            error: rejected(DomainErrorCode.KEY_NOT_VALID, 'key is not valid for this issuer', {
              reason: decision.reason,
            }),
          };
        const expiresAt = new Date(ctx.txTime.getTime() + this.ttlMs);
        const hashed = buildRetractionStatement({
          audience: this.audience,
          issuer: { principalId: a.issuer_principal_id as Uuid, keyId: input.keyId as Uuid },
          attestationId: a.id as Uuid,
          attestationStatementHash: a.statement_hash,
          reasonCode: input.reasonCode,
          nonce: newNonce(),
          signedAt: ctx.txTime,
          expiresAt,
        });
        const row: Omit<ChallengeRow, 'recorded_at'> = {
          id: newId(),
          purpose: 'attestation-retraction',
          account_id: input.actorAccountId,
          issuer_principal_id: a.issuer_principal_id,
          key_id: input.keyId,
          target_attestation_id: a.id,
          statement: hashed.statement as unknown as Record<string, unknown>,
          statement_hash: hashed.statementHash,
          nonce: hashed.statement.nonce,
          audience: this.audience,
          visibility: null,
          expires_at: expiresAt,
        };
        await this.insertChallenge(ctx, row);
        await idem.record({ challengeId: row.id });
        return {
          ok: this.prepared<RetractionStatement>(
            { ...row, recorded_at: ctx.txTime },
            facts.key?.algorithm as JwsAlgorithm,
          ),
        };
      },
    );
    return unwrap(r);
  }

  /** One logical retraction per attestation; the original attestation row is never touched. */
  async submitRetraction(input: SubmitProofInput): Promise<RetractionAccepted> {
    const r = await this.tx(async (ctx): Promise<Committed<RetractionAccepted>> => {
      const idem = await identityIdempotency<RetractionAccepted>(ctx, {
        command: 'SubmitAttestationRetraction',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: {
          challengeId: input.challengeId,
          statementHash: input.statementHash,
          proofDigest: this.proofDigest(input.proof),
        },
      });
      if (idem.lookup.replay) return { ok: idem.lookup.response };
      const probe = await this.loadChallenge(ctx, input.challengeId);
      if (typeof probe?.target_attestation_id === 'string')
        await lockKeys(ctx, `attestation:${probe.target_attestation_id}`);
      const accepted = await this.accept(ctx, input, 'attestation-retraction');
      if ('error' in accepted) return accepted;
      const { challenge: c, algorithm, verifierId } = accepted;
      const attestationId = c.target_attestation_id as string;
      const { rows: existing } = await sql<{ id: string; statement_hash: string; issued_at: Date }>`
        SELECT id, statement_hash, issued_at FROM attestation.retraction WHERE attestation_id = ${attestationId}`.execute(
        ctx.trx,
      );
      if (existing[0] !== undefined) {
        await sql`INSERT INTO attestation.challenge_consumption (challenge_id, outcome, reason_code, recorded_at)
          VALUES (${c.id}, 'ALREADY_RETRACTED', 'ALREADY_RETRACTED', ${ctx.txTime})`.execute(
          ctx.trx,
        );
        const response: RetractionAccepted = {
          retractionId: existing[0].id,
          attestationId,
          statementHash: existing[0].statement_hash,
          issuedAt: existing[0].issued_at.toISOString(),
          created: false,
        };
        await idem.record(response);
        return { ok: response };
      }
      const s = c.statement as unknown as RetractionStatement;
      const id = newId();
      await sql`INSERT INTO attestation.challenge_consumption (challenge_id, outcome, reason_code, recorded_at)
        VALUES (${c.id}, 'ACCEPTED', 'VERIFIED', ${ctx.txTime})`.execute(ctx.trx);
      await sql`INSERT INTO attestation.retraction (id, attestation_id, statement, statement_schema, statement_hash,
          issuer_principal_id, key_id, reason_code, nonce, signed_at, expires_at, proof_type, proof_scheme, proof_algorithm,
          proof, verifier_id, challenge_id, submitted_by_account_id, received_at, issued_at, recorded_at)
        VALUES (${id}, ${attestationId}, ${JSON.stringify(s)}, 'br:attestation-retraction-statement@1', ${c.statement_hash},
          ${c.issuer_principal_id}, ${c.key_id}, ${s.reasonCode}, ${s.nonce}, ${s.signedAt}, ${s.expiresAt},
          'DIRECT_SIGNATURE', 'JWS_DETACHED', ${algorithm},
          ${JSON.stringify({ protected: input.proof.protected, signature: input.proof.signature })}, ${verifierId},
          ${c.id}, ${input.actorAccountId}, ${ctx.txTime}, ${ctx.txTime}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      const fact = factHash(SchemaRef.attestationRetractionFact, {
        retractionId: id,
        attestationId,
        statementHash: c.statement_hash,
        keyId: c.key_id,
        proofDigest: this.proofDigest(input.proof),
        challengeId: c.id,
      });
      const stream = await openStream(ctx, attestationId as Uuid, StreamType.ATTESTATION);
      await stream.append({
        eventType: 'ATTESTATION_RETRACTED',
        factTable: 'attestation.retraction',
        factRowId: id,
        payloadHash: fact,
      });
      await stream.close();
      await emitEvent(ctx, {
        eventType: 'AttestationRetracted',
        aggregateType: 'ATTESTATION',
        aggregateId: attestationId as Uuid,
        payload: { retractionId: id, statementHash: c.statement_hash, reasonCode: s.reasonCode },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'attestation.retracted',
        targetType: 'ATTESTATION',
        targetId: attestationId,
        details: { reasonCode: s.reasonCode },
      });
      await refreshAttestationCard(ctx, attestationId);
      const response: RetractionAccepted = {
        retractionId: id,
        attestationId,
        statementHash: c.statement_hash,
        issuedAt: ctx.txTime.toISOString(),
        created: true,
      };
      await idem.record(response);
      return { ok: response };
    });
    return unwrap(r);
  }

  // ───────────────────────────── authorized detail ─────────────────────────────

  /**
   * Full statement + proof for the submitting account or a current representative of the issuer.
   * The signature is RE-VERIFIED from the stored material on every read ("is the signature valid?")
   * — a statement about cryptography only.
   */
  async detail(actorAccountId: string, attestationId: string): Promise<AttestationDetailV1> {
    return this.tx(async (ctx) => {
      if (!/^[0-9a-f-]{36}$/.test(attestationId))
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'attestation not found');
      const { rows } = await sql<{
        id: string;
        statement: AttestationStatement;
        statement_hash: string;
        issuer_principal_id: string;
        issuer_principal_type: string;
        key_id: string;
        proof: { protected: string; signature: string };
        proof_algorithm: string;
        submitted_by_account_id: string;
        visibility: string;
        issued_at: Date;
        supersedes_attestation_id: string | null;
      }>`SELECT * FROM attestation.attestation WHERE id = ${attestationId}`.execute(ctx.trx);
      const a = rows[0];
      const allowed =
        a !== undefined &&
        (a.submitted_by_account_id === actorAccountId ||
          (await representation(ctx, actorAccountId, a.issuer_principal_id)) !== undefined);
      if (a === undefined || !allowed)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'attestation not found');
      const facts = await loadKeyFacts(ctx, a.key_id);
      const recomputed = hashStatement('attestation', a.statement).statementHash;
      const valid =
        recomputed === a.statement_hash &&
        facts.key !== undefined &&
        verifyStoredProof(jwsDetachedVerifier, {
          statementHash: a.statement_hash,
          key: facts.key,
          proof: a.proof,
        });
      const { rows: ret } = await sql<{
        id: string;
        reason_code: string;
        issued_at: Date;
        statement_hash: string;
      }>`
        SELECT id, reason_code, issued_at, statement_hash FROM attestation.retraction WHERE attestation_id = ${a.id}`.execute(
        ctx.trx,
      );
      return {
        schema: 'br:attestation-detail@1',
        attestationId: a.id,
        statement: a.statement,
        statementHash: a.statement_hash,
        proof: {
          proofType: 'DIRECT_SIGNATURE',
          scheme: 'JWS_DETACHED',
          algorithm: a.proof_algorithm,
          ...a.proof,
        },
        issuer: {
          principalId: a.issuer_principal_id,
          principalType: a.issuer_principal_type,
          keyId: a.key_id,
        },
        issuedAt: a.issued_at.toISOString(),
        visibility: a.visibility,
        supersedesAttestationId: a.supersedes_attestation_id,
        trust: {
          signature: valid ? 'VALID' : 'INVALID',
          claim: ret[0] === undefined ? 'ACTIVE' : 'RETRACTED',
          authority: 'NOT_EVALUATED',
          sportingVerification: 'NOT_IMPLEMENTED',
          meaning:
            'A cryptographically signed claim. It proves who signed this exact statement, not that the statement is correct.',
        },
        retraction:
          ret[0] === undefined
            ? null
            : {
                retractionId: ret[0].id,
                reasonCode: ret[0].reason_code,
                issuedAt: ret[0].issued_at.toISOString(),
                statementHash: ret[0].statement_hash,
              },
      };
    });
  }
}

export interface AttestationAccepted {
  readonly attestationId: string;
  readonly statementHash: string;
  readonly issuedAt: string;
  readonly signature: 'VALID';
  readonly authority: 'NOT_EVALUATED';
  readonly verification: 'NOT_IMPLEMENTED';
  readonly created: boolean;
}

export interface RetractionAccepted {
  readonly retractionId: string;
  readonly attestationId: string;
  readonly statementHash: string;
  readonly issuedAt: string;
  readonly created: boolean;
}

export interface AttestationDetailV1 {
  readonly schema: 'br:attestation-detail@1';
  readonly attestationId: string;
  readonly statement: AttestationStatement;
  readonly statementHash: string;
  readonly proof: Record<string, string>;
  readonly issuer: { principalId: string; principalType: string; keyId: string };
  readonly issuedAt: string;
  readonly visibility: string;
  readonly supersedesAttestationId: string | null;
  readonly trust: {
    signature: 'VALID' | 'INVALID';
    claim: 'ACTIVE' | 'RETRACTED';
    authority: 'NOT_EVALUATED';
    sportingVerification: 'NOT_IMPLEMENTED';
    meaning: string;
  };
  readonly retraction: {
    retractionId: string;
    reasonCode: string;
    issuedAt: string;
    statementHash: string;
  } | null;
}
