import { DomainError, DomainErrorCode, newId, type Instant, type Uuid } from '@br/domain';
import {
  assertAudience,
  buildKeyRegistrationStatement,
  hashStatement,
  jwsDetachedVerifier,
  newNonce,
  parsePublicJwk,
  isPublishedVectorKey,
  signingRequest,
  type JwsAlgorithm,
  type KeyRegistrationStatement,
} from '@br/evidence';
import { sql } from 'kysely';
import type { PreparedStatement, SubmitProofInput } from './attestation-store';
import { insertKeyStatusChange, insertPrincipalKey } from './authority-store';
import type { Db } from './db';
import { representation, unwrap, type Committed } from './evidence-support';
import { keyMaterialHash } from './hashing';
import { identityIdempotency, lockKeys, recordAudit } from './identity-support';
import { inTransaction, ModuleRole, type TxContext } from './tx';

/**
 * BRT-06 public-key onboarding (authority module, br_authority). Before BRT-06, PrincipalKeys were
 * creatable only by internal store code; this narrow ceremony lets a representative register a
 * PUBLIC key with proof of possession:
 *
 *   prepare  → the server pre-allocates the key id and canonicalizes a key-registration statement
 *              (purpose, audience, principal, key id, algorithm, material hash, nonce, expiry)
 *   sign     → the NEW private key signs it (JWS_DETACHED, kid = the pre-allocated key id)
 *   submit   → single use, expiry, representation re-checked, signature verified with the
 *              submitted public key; only then is the PrincipalKey fact written.
 *
 * Representation: SELF for the account's own PERSON principal; OWNER/ADMIN for an ORGANIZATION
 * principal. A guardian can never register a key for a dependent (no representation basis). No
 * private key is ever accepted (closed public JWK member sets), and there is no test bypass.
 * Registering a key is NOT a grant of authority.
 */
export const KEY_CHALLENGE_TTL_MS = 10 * 60 * 1000;

interface KeyChallengeRow {
  id: string;
  principal_id: string;
  account_id: string;
  key_id: string;
  algorithm: JwsAlgorithm;
  verification_material: Record<string, string>;
  effective_to: Date | null;
  statement: Record<string, unknown>;
  statement_hash: string;
  expires_at: Date;
}

export class PrincipalKeyCeremony {
  private readonly db: Db;
  private readonly audience: string;

  constructor(db: Db, options: { audience: string }) {
    this.db = db;
    this.audience = assertAudience(options.audience);
  }

  private tx<T>(fn: (ctx: TxContext) => Promise<T>): Promise<T> {
    return inTransaction(this.db, ModuleRole.authority, fn);
  }

  private async requireRepresentative(
    ctx: TxContext,
    accountId: string,
    principalId: string,
    action: string,
  ): Promise<DomainError | undefined> {
    if ((await representation(ctx, accountId, principalId)) !== undefined) return undefined;
    await recordAudit(ctx, {
      actorAccountId: accountId,
      action: `${action}.denied`,
      targetType: 'PRINCIPAL',
      outcome: 'DENIED',
    });
    return new DomainError(
      DomainErrorCode.ISSUER_NOT_CONTROLLED,
      'the account cannot represent this principal',
    );
  }

  private prepared(c: KeyChallengeRow): PreparedStatement<KeyRegistrationStatement> {
    const hashed = hashStatement<KeyRegistrationStatement>('key-registration', c.statement);
    return {
      challengeId: c.id,
      purpose: 'key-registration',
      statement: hashed.statement,
      statementHash: hashed.statementHash,
      canonicalStatement: hashed.canonicalText,
      signing: signingRequest(c.algorithm, c.key_id, hashed.statementHash),
      expiresAt: c.expires_at.toISOString(),
    };
  }

  async prepareKeyRegistration(input: {
    readonly actorAccountId: string;
    readonly idempotencyKey: string;
    readonly principalId: string;
    readonly algorithm: JwsAlgorithm;
    readonly publicJwk: Readonly<Record<string, unknown>>;
    readonly effectiveTo?: Instant;
  }): Promise<PreparedStatement<KeyRegistrationStatement>> {
    const parsed = parsePublicJwk(input.algorithm, input.publicJwk);
    if (!parsed.ok)
      throw new DomainError(
        DomainErrorCode.INVALID_INPUT,
        'a public JWK for the algorithm is required (private members are refused)',
      );
    if (isPublishedVectorKey(parsed.key))
      throw new DomainError(
        DomainErrorCode.INVALID_INPUT,
        'published test-vector keys can never be registered',
      );
    const r = await this.tx(
      async (ctx): Promise<Committed<PreparedStatement<KeyRegistrationStatement>>> => {
        const idem = await identityIdempotency<{ challengeId: string }>(ctx, {
          command: 'PreparePrincipalKeyRegistration',
          actorAccountId: input.actorAccountId,
          idempotencyKey: input.idempotencyKey,
          params: {
            principalId: input.principalId,
            algorithm: input.algorithm,
            jwk: parsed.jwk,
            effectiveTo: input.effectiveTo,
          },
        });
        if (idem.lookup.replay)
          return {
            ok: this.prepared(
              (await this.loadChallenge(ctx, idem.lookup.response.challengeId)) as KeyChallengeRow,
            ),
          };
        const denied = await this.requireRepresentative(
          ctx,
          input.actorAccountId,
          input.principalId,
          'principal-key.register',
        );
        if (denied !== undefined) return { error: denied };
        if (input.effectiveTo !== undefined && input.effectiveTo.getTime() <= ctx.txTime.getTime())
          throw new DomainError(DomainErrorCode.INVALID_INPUT, 'effectiveTo must be in the future');
        // A public key already bound to ANOTHER principal is refused (no key substitution/confusion).
        const { rows: clash } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM authority.principal_key
        WHERE verification_material->>'x' = ${parsed.jwk.x as string}
          AND COALESCE(verification_material->>'y', '') = ${parsed.jwk.y ?? ''}
          AND principal_id <> ${input.principalId}`.execute(ctx.trx);
        if ((clash[0]?.n ?? 0) > 0)
          throw new DomainError(
            DomainErrorCode.INVALID_INPUT,
            'this public key is registered to another principal',
          );
        const keyId = newId();
        const expiresAt = new Date(ctx.txTime.getTime() + KEY_CHALLENGE_TTL_MS);
        const hashed = buildKeyRegistrationStatement({
          audience: this.audience,
          principalId: input.principalId as Uuid,
          keyId,
          algorithm: input.algorithm,
          verificationMaterialHash: keyMaterialHash(parsed.jwk),
          ...(input.effectiveTo === undefined ? {} : { effectiveTo: input.effectiveTo }),
          nonce: newNonce(),
          signedAt: ctx.txTime,
          expiresAt,
        });
        const id = newId();
        await sql`INSERT INTO authority.key_registration_challenge (id, principal_id, account_id, key_id, key_kind, algorithm,
          verification_material, effective_to, statement, statement_hash, nonce, audience, expires_at, recorded_at)
        VALUES (${id}, ${input.principalId}, ${input.actorAccountId}, ${keyId}, 'JWK', ${input.algorithm},
          ${JSON.stringify(parsed.jwk)}, ${input.effectiveTo ?? null}, ${JSON.stringify(hashed.statement)},
          ${hashed.statementHash}, ${hashed.statement.nonce}, ${this.audience}, ${expiresAt}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
        await idem.record({ challengeId: id });
        return { ok: this.prepared((await this.loadChallenge(ctx, id)) as KeyChallengeRow) };
      },
    );
    return unwrap(r);
  }

  private async loadChallenge(ctx: TxContext, id: string): Promise<KeyChallengeRow | undefined> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
    const { rows } = await sql<KeyChallengeRow>`
      SELECT id, principal_id, account_id, key_id, algorithm, verification_material, effective_to, statement,
             statement_hash, expires_at
      FROM authority.key_registration_challenge WHERE id = ${id}`.execute(ctx.trx);
    return rows[0];
  }

  async submitKeyRegistration(
    input: SubmitProofInput & { readonly principalId: string },
  ): Promise<{ keyId: string; principalId: string; created: boolean }> {
    const r = await this.tx(
      async (ctx): Promise<Committed<{ keyId: string; principalId: string; created: boolean }>> => {
        const idem = await identityIdempotency<{
          keyId: string;
          principalId: string;
          created: boolean;
        }>(ctx, {
          command: 'SubmitPrincipalKeyRegistration',
          actorAccountId: input.actorAccountId,
          idempotencyKey: input.idempotencyKey,
          params: {
            challengeId: input.challengeId,
            statementHash: input.statementHash,
            proof: input.proof,
          },
        });
        if (idem.lookup.replay) return { ok: idem.lookup.response };
        await lockKeys(ctx, `key-challenge:${input.challengeId}`);
        const c = await this.loadChallenge(ctx, input.challengeId);
        if (
          c === undefined ||
          c.account_id !== input.actorAccountId ||
          c.principal_id !== input.principalId
        )
          return {
            error: new DomainError(DomainErrorCode.CHALLENGE_INVALID, 'challenge not found'),
          };
        const { rows: used } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM authority.key_registration_consumption WHERE challenge_id = ${c.id}`.execute(
          ctx.trx,
        );
        if ((used[0]?.n ?? 0) > 0)
          return {
            error: new DomainError(
              DomainErrorCode.ATTESTATION_CHALLENGE_USED,
              'challenge already used',
            ),
          };
        const reject = async (reason: string, error: DomainError) => {
          await sql`INSERT INTO authority.key_registration_consumption (challenge_id, outcome, reason_code, recorded_at)
          VALUES (${c.id}, 'REJECTED', ${reason}, ${ctx.txTime})`.execute(ctx.trx);
          await recordAudit(ctx, {
            actorAccountId: input.actorAccountId,
            action: 'principal-key.register-rejected',
            targetType: 'PRINCIPAL',
            targetId: c.principal_id,
            outcome: 'DENIED',
            details: { reason },
          });
          return { error };
        };
        if ((c.statement as { audience?: unknown }).audience !== this.audience)
          return reject(
            'WRONG_AUDIENCE',
            new DomainError(
              DomainErrorCode.ATTESTATION_PROOF_INVALID,
              'statement audience does not match this environment',
            ),
          );
        if (ctx.txTime.getTime() > c.expires_at.getTime())
          return reject(
            'EXPIRED',
            new DomainError(DomainErrorCode.ATTESTATION_CHALLENGE_EXPIRED, 'challenge expired'),
          );
        if (hashStatement('key-registration', c.statement).statementHash !== c.statement_hash)
          throw new Error('key challenge statement integrity failure');
        if (input.statementHash !== undefined && input.statementHash !== c.statement_hash)
          return reject(
            'STATEMENT_MISMATCH',
            new DomainError(
              DomainErrorCode.ATTESTATION_PROOF_INVALID,
              'statement does not match the challenge',
            ),
          );
        if (input.proof.proofType !== 'DIRECT_SIGNATURE' || input.proof.scheme !== 'JWS_DETACHED')
          return reject(
            'WRONG_SCHEME',
            new DomainError(DomainErrorCode.ATTESTATION_PROOF_INVALID, 'unsupported proof scheme'),
          );
        const denied = await this.requireRepresentative(
          ctx,
          input.actorAccountId,
          c.principal_id,
          'principal-key.register',
        );
        if (denied !== undefined) return reject('ISSUER_NOT_CONTROLLED', denied);
        // Proof of possession: the submitted PUBLIC key must verify the statement it is bound into.
        const verification = jwsDetachedVerifier.verify({
          statementHash: c.statement_hash,
          keyId: c.key_id,
          keyKind: 'JWK',
          algorithm: c.algorithm,
          verificationMaterial: c.verification_material,
          proof: { protected: input.proof.protected, signature: input.proof.signature },
        });
        if (!verification.ok)
          return reject(
            'PROOF_INVALID',
            new DomainError(
              DomainErrorCode.ATTESTATION_PROOF_INVALID,
              'proof of possession failed',
            ),
          );
        await sql`INSERT INTO authority.key_registration_consumption (challenge_id, outcome, reason_code, recorded_at)
        VALUES (${c.id}, 'ACCEPTED', 'VERIFIED', ${ctx.txTime})`.execute(ctx.trx);
        await insertPrincipalKey(ctx, {
          keyId: c.key_id as Uuid,
          principalId: c.principal_id as Uuid,
          keyKind: 'JWK',
          algorithm: c.algorithm,
          verificationMaterial: c.verification_material,
          ...(c.effective_to === null ? {} : { effectiveTo: c.effective_to }),
        });
        await recordAudit(ctx, {
          actorAccountId: input.actorAccountId,
          action: 'principal-key.registered',
          targetType: 'PRINCIPAL_KEY',
          targetId: c.key_id,
          details: { algorithm: c.algorithm },
        });
        const response = { keyId: c.key_id, principalId: c.principal_id, created: true };
        await idem.record(response);
        return { ok: response };
      },
    );
    return unwrap(r);
  }

  /**
   * Representative-declared key status (append-only; history is never rewritten):
   *   REVOKED      prospective (effective now)
   *   COMPROMISED  retroactive to `compromisedSince` (≤ now). Existing attestations stay stored
   *                unchanged; BRT-07 decides their trust from the compromise facts.
   */
  async changeKeyStatus(input: {
    readonly actorAccountId: string;
    readonly principalId: string;
    readonly keyId: string;
    readonly kind: 'REVOKED' | 'COMPROMISED';
    readonly compromisedSince?: Instant;
    readonly idempotencyKey: string;
  }): Promise<{ statusChangeId: string }> {
    const r = await this.tx(async (ctx): Promise<Committed<{ statusChangeId: string }>> => {
      const idem = await identityIdempotency<{ statusChangeId: string }>(ctx, {
        command: 'ChangePrincipalKeyStatus',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: {
          principalId: input.principalId,
          keyId: input.keyId,
          kind: input.kind,
          compromisedSince: input.compromisedSince,
        },
      });
      if (idem.lookup.replay) return { ok: idem.lookup.response };
      const denied = await this.requireRepresentative(
        ctx,
        input.actorAccountId,
        input.principalId,
        'principal-key.status',
      );
      if (denied !== undefined) return { error: denied };
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM authority.principal_key WHERE id = ${input.keyId} AND principal_id = ${input.principalId}`.execute(
        ctx.trx,
      );
      if ((rows[0]?.n ?? 0) === 0)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'key not found');
      await lockKeys(ctx, `principal-key:${input.keyId}`);
      const out =
        input.kind === 'COMPROMISED'
          ? await insertKeyStatusChange(ctx, {
              keyId: input.keyId as Uuid,
              kind: 'COMPROMISED',
              compromisedSince: input.compromisedSince ?? ctx.txTime,
              reason: 'declared compromised by a principal representative',
              declaredByPrincipalId: input.principalId as Uuid,
            })
          : await insertKeyStatusChange(ctx, {
              keyId: input.keyId as Uuid,
              kind: 'REVOKED',
              reason: 'revoked by a principal representative',
              declaredByPrincipalId: input.principalId as Uuid,
            });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: `principal-key.${input.kind.toLowerCase()}`,
        targetType: 'PRINCIPAL_KEY',
        targetId: input.keyId,
      });
      await idem.record(out);
      return { ok: out };
    });
    return unwrap(r);
  }
}

/**
 * BRT-06 Person ↔ PERSON Principal mapping (identity module, br_identity). The mapping is created
 * only through the narrow SECURITY DEFINER function `identity.ensure_person_principal`, so the
 * identity role holds no authority-table grant. SELF only: a guardian gets FORBIDDEN for a
 * dependent (a guardian signs, if at all, as their own Principal).
 */
export class PersonPrincipalService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  ensure(input: { actorAccountId: string; personId: string }): Promise<{ principalId: string }> {
    return inTransaction(this.db, ModuleRole.identity, async (ctx) => {
      if (!/^[0-9a-f-]{36}$/.test(input.personId))
        throw new DomainError(DomainErrorCode.FORBIDDEN, 'not permitted');
      const { rows } = await sql<{ p: string | null }>`
        SELECT identity.ensure_person_principal(${input.actorAccountId}::uuid, ${input.personId}::uuid) AS p`.execute(
        ctx.trx,
      );
      const principalId = rows[0]?.p ?? null;
      if (principalId === null) {
        await recordAudit(ctx, {
          actorAccountId: input.actorAccountId,
          action: 'person-principal.denied',
          targetType: 'PERSON',
          outcome: 'DENIED',
        });
        return { denied: true as const };
      }
      return { principalId };
    }).then((r) => {
      if ('denied' in r) throw new DomainError(DomainErrorCode.FORBIDDEN, 'not permitted');
      return r;
    });
  }
}
