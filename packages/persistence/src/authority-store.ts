import {
  authorize as evaluateAuthority,
  participationIndexUnavailable,
  validateGrantIssuance,
  type AuthorityFacts,
  type AuthorizationDecision,
  type ConflictOfInterestChecker,
  type GrantDraft,
} from '@br/authority';
import {
  isBackdated,
  DomainError,
  DomainErrorCode,
  newId,
  toCanonicalTimestamp,
  type AuthorityGrant,
  type AuthorityScope,
  type Capability,
  type DelegationPolicy,
  type GrantConstraints,
  type GrantStatusChange,
  type Instant,
  type KeyKind,
  type KeyStatusChange,
  type Principal,
  type PrincipalType,
  type RecognitionScope,
  type SignatureAlgorithm,
  type SignatureEnvelopePlaceholder,
  type TrustAnchorStatusChange,
  type Uuid,
} from '@br/domain';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';
import type { Kysely } from 'kysely';
import type { AuthorityGrantTable, Database, Db } from './db';
import {
  canonicalHash,
  factHash,
  FORBIDDEN_KEY_MATERIAL_MEMBERS,
  keyMaterialHash,
} from './hashing';
import { checkIdempotency, recordIdempotency } from './idempotency';
import { openStream, StreamType } from './ledger';
import { emitEvent } from './outbox';
import { inTransaction, ModuleRole, type TxContext } from './tx';

type Executor = Kysely<Database>;

function assertNotBackdated(effectiveFrom: Instant, recordedAt: Instant, what: string): void {
  if (isBackdated(effectiveFrom, recordedAt)) {
    throw new DomainError(
      DomainErrorCode.BACKDATING_REJECTED,
      `${what} cannot take effect before it is recorded`,
      {
        effectiveFrom: effectiveFrom.toISOString(),
        recordedAt: recordedAt.toISOString(),
      },
    );
  }
}

const optionalTimestamp = (key: string, value: Instant | undefined) =>
  value === undefined ? {} : { [key]: toCanonicalTimestamp(value) };

// ───────────────────────────── row → domain mapping ─────────────────────────────

function toGrant(row: AuthorityGrantTable): AuthorityGrant {
  return {
    id: row.id as Uuid,
    grantorPrincipalId: row.grantor_principal_id as Uuid,
    granteePrincipalId: row.grantee_principal_id as Uuid,
    ...(row.parent_grant_id === null ? {} : { parentGrantId: row.parent_grant_id as Uuid }),
    capabilities: row.capabilities as Capability[],
    scope: row.scope as AuthorityScope,
    delegation: row.delegation as DelegationPolicy,
    constraints: row.constraints as GrantConstraints,
    effectiveFrom: row.effective_from,
    ...(row.effective_to === null ? {} : { effectiveTo: row.effective_to }),
    grantHash: row.grant_hash,
    ...(row.grantor_signature === null
      ? {}
      : { grantorSignature: row.grantor_signature as SignatureEnvelopePlaceholder }),
    recordedAt: row.recorded_at,
  };
}

/**
 * Loads the authority facts relevant to a principal: the grants it holds, their full parent
 * chains, the anchors of every grantor, the principals involved, an optional key, and all
 * status histories. Transaction-time filtering (asOf) is done by the engine.
 */
export async function loadAuthorityFacts(
  db: Executor,
  principalId: Uuid,
  keyId?: Uuid,
): Promise<AuthorityFacts> {
  const grants = new Map<string, AuthorityGrant>();
  let frontier = (
    await db
      .selectFrom('authority.authority_grant')
      .selectAll()
      .where('grantee_principal_id', '=', principalId)
      .execute()
  ).map(toGrant);
  while (frontier.length > 0) {
    frontier.forEach((g) => grants.set(g.id, g));
    const parentIds = [
      ...new Set(frontier.flatMap((g) => (g.parentGrantId === undefined ? [] : [g.parentGrantId]))),
    ].filter((id) => !grants.has(id));
    frontier =
      parentIds.length === 0
        ? []
        : (
            await db
              .selectFrom('authority.authority_grant')
              .selectAll()
              .where('id', 'in', parentIds)
              .execute()
          ).map(toGrant);
  }
  const grantList = [...grants.values()];
  const principalIds = [
    ...new Set([
      principalId,
      ...grantList.flatMap((g) => [g.grantorPrincipalId, g.granteePrincipalId]),
    ]),
  ];
  // The principal itself may be an anchor (e.g. validating a root grant it issues).
  const grantorIds = [...new Set([principalId, ...grantList.map((g) => g.grantorPrincipalId)])];

  const [principals, anchors, grantStatus, keys] = await Promise.all([
    db.selectFrom('authority.principal').selectAll().where('id', 'in', principalIds).execute(),
    db
      .selectFrom('authority.trust_anchor')
      .selectAll()
      .where('principal_id', 'in', grantorIds)
      .execute(),
    grantList.length === 0
      ? []
      : db
          .selectFrom('authority.authority_grant_status_change')
          .selectAll()
          .where(
            'grant_id',
            'in',
            grantList.map((g) => g.id),
          )
          .execute(),
    keyId === undefined
      ? []
      : db.selectFrom('authority.principal_key').selectAll().where('id', '=', keyId).execute(),
  ]);
  const anchorStatus =
    anchors.length === 0
      ? []
      : await db
          .selectFrom('authority.trust_anchor_status_change')
          .selectAll()
          .where(
            'anchor_id',
            'in',
            anchors.map((a) => a.id),
          )
          .execute();
  const keyStatus =
    keys.length === 0
      ? []
      : await db
          .selectFrom('authority.principal_key_status_change')
          .selectAll()
          .where(
            'key_id',
            'in',
            keys.map((k) => k.id),
          )
          .execute();

  return {
    principals: principals.map((p): Principal => ({
      id: p.id as Uuid,
      principalType: p.principal_type as PrincipalType,
      label: p.label,
      recordedAt: p.recorded_at,
    })),
    keys: keys.map((k) => ({
      id: k.id as Uuid,
      principalId: k.principal_id as Uuid,
      keyKind: k.key_kind as KeyKind,
      algorithm: k.algorithm as SignatureAlgorithm,
      verificationMaterial: k.verification_material as Record<string, string>,
      effectiveFrom: k.effective_from,
      ...(k.effective_to === null ? {} : { effectiveTo: k.effective_to }),
      recordedAt: k.recorded_at,
      factHash: k.fact_hash,
    })),
    keyStatusChanges: keyStatus.map((s): KeyStatusChange =>
      s.kind === 'COMPROMISED'
        ? {
            id: s.id as Uuid,
            keyId: s.key_id as Uuid,
            kind: 'COMPROMISED',
            compromisedSince: s.compromised_since ?? s.effective_from,
            recordedAt: s.recorded_at,
            reason: s.reason,
          }
        : {
            id: s.id as Uuid,
            keyId: s.key_id as Uuid,
            kind: s.kind as 'ROTATED' | 'REVOKED',
            effectiveFrom: s.effective_from,
            recordedAt: s.recorded_at,
            reason: s.reason,
          },
    ),
    anchors: anchors.map((a) => ({
      id: a.id as Uuid,
      principalId: a.principal_id as Uuid,
      recognitionScope: a.recognition_scope as RecognitionScope,
      basisRef: a.basis_ref,
      governanceDecisionRef: a.governance_decision_ref,
      effectiveFrom: a.effective_from,
      ...(a.effective_to === null ? {} : { effectiveTo: a.effective_to }),
      recordedAt: a.recorded_at,
      factHash: a.fact_hash,
    })),
    anchorStatusChanges: anchorStatus.map((s): TrustAnchorStatusChange => ({
      id: s.id as Uuid,
      anchorId: s.anchor_id as Uuid,
      kind: 'REVOKED',
      effectiveFrom: s.effective_from,
      recordedAt: s.recorded_at,
      reason: s.reason,
    })),
    grants: grantList,
    grantStatusChanges: grantStatus.map(
      (s) =>
        ({
          id: s.id as Uuid,
          grantId: s.grant_id as Uuid,
          kind: 'REVOKED',
          compromise: s.compromise,
          effectiveFrom: s.effective_from,
          recordedAt: s.recorded_at,
          reason: s.reason,
        }) as GrantStatusChange,
    ),
  };
}

export interface AuthorizeInput {
  readonly principalId: Uuid;
  readonly keyId?: Uuid;
  readonly signedAt?: Instant;
  readonly capability: Capability;
  readonly scope: AuthorityScope;
  readonly atTime: Instant;
  readonly asOf: Instant;
}

/** Loads facts and evaluates authority inside an existing transaction (any module role with read access). */
export async function authorizeIn(
  ctx: TxContext,
  input: AuthorizeInput,
  conflictChecker?: ConflictOfInterestChecker,
): Promise<AuthorizationDecision> {
  const facts = await loadAuthorityFacts(ctx.trx, input.principalId, input.keyId);
  return evaluateAuthority(facts, input, {
    conflictChecker: conflictChecker ?? participationIndexUnavailable,
    evaluatedAt: new Date(),
  });
}

// ───────────────────────────── authority commands ─────────────────────────────

export interface RegisterPrincipalInput {
  readonly principalType: PrincipalType;
  /** Non-PII label. */
  readonly label: string;
}

export interface RegisterKeyInput {
  readonly principalId: Uuid;
  readonly keyKind: KeyKind;
  readonly algorithm: SignatureAlgorithm;
  /** Public verification material (e.g. a public JWK). Private members are refused. */
  readonly verificationMaterial: Readonly<Record<string, string>>;
  readonly effectiveFrom?: Instant;
  readonly effectiveTo?: Instant;
}

export interface RecognizeAnchorInput {
  readonly principalId: Uuid;
  readonly recognitionScope: RecognitionScope;
  readonly basisRef: string;
  readonly governanceDecisionRef: string;
  readonly effectiveFrom?: Instant;
  readonly effectiveTo?: Instant;
}

export interface IssueGrantInput {
  readonly actorPrincipalId: Uuid;
  readonly grantorPrincipalId: Uuid;
  readonly granteePrincipalId: Uuid;
  readonly parentGrantId?: Uuid;
  readonly capabilities: readonly Capability[];
  readonly scope: AuthorityScope;
  readonly delegation: DelegationPolicy;
  readonly constraints?: GrantConstraints;
  readonly effectiveFrom?: Instant;
  readonly effectiveTo?: Instant;
  readonly grantorSignature?: SignatureEnvelopePlaceholder;
  readonly idempotencyKey?: string;
}

export interface IssueGrantOutcome {
  readonly grant: AuthorityGrant;
  /** False when an identical grant already existed (duplicate command, no new fact). */
  readonly created: boolean;
}

export interface RevokeGrantInput {
  readonly grantId: Uuid;
  readonly actorPrincipalId: Uuid;
  readonly reason: string;
  /** Ordinary revocation: prospective (default: now). Compromise: may be in the past. */
  readonly effectiveFrom?: Instant;
  readonly compromise?: boolean;
}

export class AuthorityStore {
  private readonly db: Db;
  /**
   * Conflict-of-interest checker used for authorization and grant issuance. Defaults to
   * `participationIndexUnavailable`, which makes every conflict-sensitive action (including
   * issuing grants) fail closed until participation data is supplied.
   */
  private readonly conflictChecker: ConflictOfInterestChecker;

  constructor(db: Db, options: { conflictChecker?: ConflictOfInterestChecker } = {}) {
    this.db = db;
    this.conflictChecker = options.conflictChecker ?? participationIndexUnavailable;
  }

  registerPrincipal(input: RegisterPrincipalInput): Promise<Principal> {
    return inTransaction(this.db, ModuleRole.authority, async (ctx) => {
      const id = newId();
      const hash = factHash(SchemaRef.principal, {
        principalId: id,
        principalType: input.principalType,
        label: input.label,
      });
      await ctx.trx
        .insertInto('authority.principal')
        .values({
          id,
          principal_type: input.principalType,
          label: input.label,
          fact_hash: hash,
          recorded_at: ctx.txTime,
        })
        .execute();
      await emitEvent(ctx, {
        eventType: 'PrincipalRegistered',
        aggregateType: 'PRINCIPAL',
        aggregateId: id,
        payload: { principalType: input.principalType, factHash: hash },
      });
      return { id, principalType: input.principalType, label: input.label, recordedAt: ctx.txTime };
    });
  }

  registerKey(input: RegisterKeyInput): Promise<{ keyId: Uuid; factHash: string }> {
    const forbidden = Object.keys(input.verificationMaterial).filter((k) =>
      FORBIDDEN_KEY_MATERIAL_MEMBERS.includes(k),
    );
    if (forbidden.length > 0) {
      return Promise.reject(
        new DomainError(
          DomainErrorCode.INVALID_INPUT,
          `private key material is never stored (members: ${forbidden.join(', ')})`,
        ),
      );
    }
    return inTransaction(this.db, ModuleRole.authority, async (ctx) => {
      const effectiveFrom = input.effectiveFrom ?? ctx.txTime;
      assertNotBackdated(effectiveFrom, ctx.txTime, 'a key');
      const keyId = newId();
      const hash = factHash(SchemaRef.principalKey, {
        keyId,
        principalId: input.principalId,
        keyKind: input.keyKind,
        algorithm: input.algorithm,
        verificationMaterialHash: keyMaterialHash(input.verificationMaterial),
        effectiveFrom: toCanonicalTimestamp(effectiveFrom),
        ...optionalTimestamp('effectiveTo', input.effectiveTo),
      });
      await ctx.trx
        .insertInto('authority.principal_key')
        .values({
          id: keyId,
          principal_id: input.principalId,
          key_kind: input.keyKind,
          algorithm: input.algorithm,
          verification_material: JSON.stringify(input.verificationMaterial),
          effective_from: effectiveFrom,
          effective_to: input.effectiveTo ?? null,
          fact_hash: hash,
          recorded_at: ctx.txTime,
        })
        .execute();
      const stream = await openStream(ctx, keyId, StreamType.PRINCIPAL_KEY);
      await stream.append({
        eventType: 'PRINCIPAL_KEY_REGISTERED',
        factTable: 'authority.principal_key',
        factRowId: keyId,
        payloadHash: hash,
      });
      await stream.close();
      await emitEvent(ctx, {
        eventType: 'PrincipalKeyRegistered',
        aggregateType: 'PRINCIPAL_KEY',
        aggregateId: keyId,
        payload: { principalId: input.principalId, factHash: hash },
      });
      return { keyId, factHash: hash };
    });
  }

  /** Rotation/revocation are prospective; compromise may be retroactive to `compromisedSince`. */
  changeKeyStatus(
    input:
      | {
          keyId: Uuid;
          kind: 'ROTATED' | 'REVOKED';
          effectiveFrom?: Instant;
          reason: string;
          declaredByPrincipalId?: Uuid;
        }
      | {
          keyId: Uuid;
          kind: 'COMPROMISED';
          compromisedSince: Instant;
          reason: string;
          declaredByPrincipalId?: Uuid;
        },
  ): Promise<{ statusChangeId: Uuid }> {
    return inTransaction(this.db, ModuleRole.authority, async (ctx) => {
      const effectiveFrom =
        input.kind === 'COMPROMISED' ? input.compromisedSince : (input.effectiveFrom ?? ctx.txTime);
      if (input.kind === 'COMPROMISED') {
        if (effectiveFrom.getTime() > ctx.txTime.getTime()) {
          throw new DomainError(
            DomainErrorCode.INVALID_INPUT,
            'compromisedSince cannot be in the future',
          );
        }
      } else {
        assertNotBackdated(effectiveFrom, ctx.txTime, 'an ordinary key status change');
      }
      const id = newId();
      const hash = factHash(SchemaRef.statusChange, {
        subjectType: 'PRINCIPAL_KEY',
        subjectId: input.keyId,
        kind: input.kind,
        effectiveFrom: toCanonicalTimestamp(effectiveFrom),
        retroactive: input.kind === 'COMPROMISED',
        reason: input.reason,
        ...(input.declaredByPrincipalId === undefined
          ? {}
          : { declaredByPrincipalId: input.declaredByPrincipalId }),
      });
      await ctx.trx
        .insertInto('authority.principal_key_status_change')
        .values({
          id,
          key_id: input.keyId,
          kind: input.kind,
          effective_from: effectiveFrom,
          compromised_since: input.kind === 'COMPROMISED' ? input.compromisedSince : null,
          reason: input.reason,
          declared_by_principal_id: input.declaredByPrincipalId ?? null,
          fact_hash: hash,
          recorded_at: ctx.txTime,
        })
        .execute();
      const stream = await openStream(ctx, input.keyId, StreamType.PRINCIPAL_KEY);
      await stream.append({
        eventType: `PRINCIPAL_KEY_${input.kind}`,
        factTable: 'authority.principal_key_status_change',
        factRowId: id,
        payloadHash: hash,
      });
      await stream.close();
      await emitEvent(ctx, {
        eventType: 'PrincipalKeyStatusChanged',
        aggregateType: 'PRINCIPAL_KEY',
        aggregateId: input.keyId,
        payload: { kind: input.kind, factHash: hash },
      });
      return { statusChangeId: id };
    });
  }

  /**
   * Records an explicit governance recognition. There is no implicit bootstrap: callers must
   * state the recognition scope. The PLATFORM principal is limited to the PLATFORM level.
   */
  recognizeTrustAnchor(input: RecognizeAnchorInput): Promise<{ anchorId: Uuid; factHash: string }> {
    return inTransaction(this.db, ModuleRole.authority, async (ctx) => {
      const principal = await ctx.trx
        .selectFrom('authority.principal')
        .selectAll()
        .where('id', '=', input.principalId)
        .executeTakeFirst();
      if (principal === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'principal not found');
      const levels = input.recognitionScope.recognitionLevel;
      const platformOnly = levels.length === 1 && levels[0] === 'PLATFORM';
      if ((principal.principal_type === 'PLATFORM') !== platformOnly) {
        throw new DomainError(
          DomainErrorCode.ANCHOR_INVALID,
          principal.principal_type === 'PLATFORM'
            ? 'the PLATFORM principal can only be recognized at the PLATFORM level'
            : 'only the PLATFORM principal can be recognized at the PLATFORM level',
        );
      }
      const effectiveFrom = input.effectiveFrom ?? ctx.txTime;
      assertNotBackdated(effectiveFrom, ctx.txTime, 'a trust anchor');
      const anchorId = newId();
      const doc = {
        principalId: input.principalId,
        recognitionScope: input.recognitionScope,
        basisRef: input.basisRef,
        governanceDecisionRef: input.governanceDecisionRef,
        effectiveFrom: toCanonicalTimestamp(effectiveFrom),
        ...optionalTimestamp('effectiveTo', input.effectiveTo),
      };
      const hashed = canonicalHash(DomainTag.trustAnchor, SchemaRef.trustAnchor, doc);
      const normalizedScope = (hashed.normalized as { recognitionScope: RecognitionScope })
        .recognitionScope;
      await ctx.trx
        .insertInto('authority.trust_anchor')
        .values({
          id: anchorId,
          principal_id: input.principalId,
          recognition_scope: JSON.stringify(normalizedScope),
          basis_ref: input.basisRef,
          governance_decision_ref: input.governanceDecisionRef,
          effective_from: effectiveFrom,
          effective_to: input.effectiveTo ?? null,
          fact_hash: hashed.contentHash,
          recorded_at: ctx.txTime,
        })
        .execute();
      const stream = await openStream(ctx, anchorId, StreamType.TRUST_ANCHOR);
      await stream.append({
        eventType: 'TRUST_ANCHOR_RECOGNIZED',
        factTable: 'authority.trust_anchor',
        factRowId: anchorId,
        payloadHash: hashed.contentHash,
      });
      await stream.close();
      await emitEvent(ctx, {
        eventType: 'TrustAnchorRecognized',
        aggregateType: 'TRUST_ANCHOR',
        aggregateId: anchorId,
        payload: { principalId: input.principalId, factHash: hashed.contentHash },
      });
      return { anchorId, factHash: hashed.contentHash };
    });
  }

  revokeTrustAnchor(input: {
    anchorId: Uuid;
    reason: string;
    effectiveFrom?: Instant;
  }): Promise<{ statusChangeId: Uuid }> {
    return inTransaction(this.db, ModuleRole.authority, async (ctx) => {
      const effectiveFrom = input.effectiveFrom ?? ctx.txTime;
      assertNotBackdated(effectiveFrom, ctx.txTime, 'an anchor revocation');
      const id = newId();
      const hash = factHash(SchemaRef.statusChange, {
        subjectType: 'TRUST_ANCHOR',
        subjectId: input.anchorId,
        kind: 'REVOKED',
        effectiveFrom: toCanonicalTimestamp(effectiveFrom),
        retroactive: false,
        reason: input.reason,
      });
      await ctx.trx
        .insertInto('authority.trust_anchor_status_change')
        .values({
          id,
          anchor_id: input.anchorId,
          kind: 'REVOKED',
          effective_from: effectiveFrom,
          reason: input.reason,
          fact_hash: hash,
          recorded_at: ctx.txTime,
        })
        .execute();
      const stream = await openStream(ctx, input.anchorId, StreamType.TRUST_ANCHOR);
      await stream.append({
        eventType: 'TRUST_ANCHOR_REVOKED',
        factTable: 'authority.trust_anchor_status_change',
        factRowId: id,
        payloadHash: hash,
      });
      await stream.close();
      await emitEvent(ctx, {
        eventType: 'TrustAnchorChanged',
        aggregateType: 'TRUST_ANCHOR',
        aggregateId: input.anchorId,
        payload: { kind: 'REVOKED', factHash: hash },
      });
      return { statusChangeId: id };
    });
  }

  /**
   * Issues a grant after validating it against the authority facts as known now (issuance =
   * recordedAt). BRT-03 has no signature verification yet, so the acting principal must be the
   * grantor; the signature envelope is stored as a structural placeholder.
   * Identical grant documents are de-duplicated by grant hash.
   */
  issueGrant(input: IssueGrantInput): Promise<IssueGrantOutcome> {
    if (input.actorPrincipalId !== input.grantorPrincipalId) {
      return Promise.reject(
        new DomainError(DomainErrorCode.AUTHORITY_DENIED, 'only the grantor may issue its grants'),
      );
    }
    return inTransaction(this.db, ModuleRole.authority, async (ctx) => {
      const effectiveFrom = input.effectiveFrom ?? ctx.txTime;
      const constraints = input.constraints ?? { mustNotBeParticipant: true };
      const doc = {
        grantorPrincipalId: input.grantorPrincipalId,
        granteePrincipalId: input.granteePrincipalId,
        ...(input.parentGrantId === undefined ? {} : { parentGrantId: input.parentGrantId }),
        capabilities: input.capabilities,
        scope: input.scope,
        delegation: input.delegation,
        constraints,
        effectiveFrom: toCanonicalTimestamp(effectiveFrom),
        ...optionalTimestamp('effectiveTo', input.effectiveTo),
      };
      const hashed = canonicalHash(DomainTag.authorityGrant, SchemaRef.authorityGrant, doc);
      const normalized = hashed.normalized as unknown as {
        capabilities: Capability[];
        scope: AuthorityScope;
        delegation: DelegationPolicy;
      };
      const idem =
        input.idempotencyKey === undefined
          ? undefined
          : {
              scope: input.actorPrincipalId,
              key: input.idempotencyKey,
              commandType: 'IssueGrant',
              requestSchema: SchemaRef.cmdIssueGrant,
              request: { grantHash: hashed.contentHash, actorPrincipalId: input.actorPrincipalId },
            };
      let requestHash: string | undefined;
      if (idem !== undefined) {
        const lookup = await checkIdempotency<{ grantId: Uuid }>(ctx, idem);
        if (lookup.replay) {
          const row = await ctx.trx
            .selectFrom('authority.authority_grant')
            .selectAll()
            .where('id', '=', lookup.response.grantId)
            .executeTakeFirstOrThrow();
          return { grant: toGrant(row), created: false };
        }
        requestHash = lookup.requestHash;
      }

      const existing = await ctx.trx
        .selectFrom('authority.authority_grant')
        .selectAll()
        .where('grant_hash', '=', hashed.contentHash)
        .executeTakeFirst();
      if (existing !== undefined) {
        if (idem !== undefined && requestHash !== undefined)
          await recordIdempotency(ctx, idem, requestHash, { grantId: existing.id });
        return { grant: toGrant(existing), created: false };
      }

      const draft: GrantDraft = {
        grantorPrincipalId: input.grantorPrincipalId,
        granteePrincipalId: input.granteePrincipalId,
        ...(input.parentGrantId === undefined ? {} : { parentGrantId: input.parentGrantId }),
        capabilities: normalized.capabilities,
        scope: normalized.scope,
        delegation: {
          ...normalized.delegation,
          capabilitiesDelegable: normalized.delegation.capabilitiesDelegable ?? [],
        },
        constraints,
        effectiveFrom,
        ...(input.effectiveTo === undefined ? {} : { effectiveTo: input.effectiveTo }),
      };
      const facts = await loadAuthorityFacts(ctx.trx, input.grantorPrincipalId);
      const extra = await ctx.trx
        .selectFrom('authority.principal')
        .selectAll()
        .where('id', '=', input.granteePrincipalId)
        .execute();
      const withGrantee: AuthorityFacts = {
        ...facts,
        principals: [
          ...facts.principals,
          ...extra.map((p) => ({
            id: p.id as Uuid,
            principalType: p.principal_type as PrincipalType,
            label: p.label,
            recordedAt: p.recorded_at,
          })),
        ],
      };
      const outcome = validateGrantIssuance(withGrantee, draft, ctx.txTime, this.conflictChecker);
      if (!outcome.ok) {
        throw new DomainError(
          outcome.reason === 'BACKDATED'
            ? DomainErrorCode.BACKDATING_REJECTED
            : DomainErrorCode.GRANT_INVALID,
          `grant rejected: ${outcome.reason}${outcome.chainFailure === undefined ? '' : ` (${outcome.chainFailure.capability}: ${outcome.chainFailure.reason})`}`,
          {
            reason: outcome.reason,
            ...(outcome.chainFailure === undefined ? {} : { chainFailure: outcome.chainFailure }),
          },
        );
      }

      const id = newId();
      const row: AuthorityGrantTable = {
        id,
        grantor_principal_id: input.grantorPrincipalId,
        grantee_principal_id: input.granteePrincipalId,
        parent_grant_id: input.parentGrantId ?? null,
        capabilities: [...normalized.capabilities],
        scope: JSON.stringify(normalized.scope),
        delegation: JSON.stringify(draft.delegation),
        constraints: JSON.stringify(constraints),
        effective_from: effectiveFrom,
        effective_to: input.effectiveTo ?? null,
        grant_hash: hashed.contentHash,
        grantor_signature:
          input.grantorSignature === undefined ? null : JSON.stringify(input.grantorSignature),
        recorded_at: ctx.txTime,
      };
      await ctx.trx.insertInto('authority.authority_grant').values(row).execute();
      const stream = await openStream(ctx, id, StreamType.AUTHORITY_GRANT);
      await stream.append({
        eventType: 'AUTHORITY_GRANT_ISSUED',
        factTable: 'authority.authority_grant',
        factRowId: id,
        payloadHash: hashed.contentHash,
      });
      await stream.close();
      await emitEvent(ctx, {
        eventType: 'AuthorityGrantIssued',
        aggregateType: 'AUTHORITY_GRANT',
        aggregateId: id,
        actorPrincipalId: input.actorPrincipalId,
        payload: { grantHash: hashed.contentHash, granteePrincipalId: input.granteePrincipalId },
      });
      if (idem !== undefined && requestHash !== undefined)
        await recordIdempotency(ctx, idem, requestHash, { grantId: id });
      const stored = await ctx.trx
        .selectFrom('authority.authority_grant')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return { grant: toGrant(stored), created: true };
    });
  }

  /**
   * Revokes a grant. The actor must be the grantor of the grant or of one of its ancestors.
   * Ordinary revocation is prospective; `compromise: true` may take effect in the past.
   * Descendant grants fail automatically because every evaluation re-walks the whole chain.
   */
  revokeGrant(input: RevokeGrantInput): Promise<{ statusChangeId: Uuid }> {
    return inTransaction(this.db, ModuleRole.authority, async (ctx) => {
      const compromise = input.compromise === true;
      const effectiveFrom = input.effectiveFrom ?? ctx.txTime;
      if (compromise) {
        if (effectiveFrom.getTime() > ctx.txTime.getTime())
          throw new DomainError(
            DomainErrorCode.INVALID_INPUT,
            'compromise revocation cannot start in the future',
          );
      } else {
        assertNotBackdated(effectiveFrom, ctx.txTime, 'an ordinary revocation');
      }
      let current = await ctx.trx
        .selectFrom('authority.authority_grant')
        .selectAll()
        .where('id', '=', input.grantId)
        .executeTakeFirst();
      if (current === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'grant not found');
      let permitted = false;
      while (current !== undefined) {
        if (current.grantor_principal_id === input.actorPrincipalId) {
          permitted = true;
          break;
        }
        const parentId: string | null = current.parent_grant_id;
        current =
          parentId === null
            ? undefined
            : await ctx.trx
                .selectFrom('authority.authority_grant')
                .selectAll()
                .where('id', '=', parentId)
                .executeTakeFirst();
      }
      if (!permitted)
        throw new DomainError(
          DomainErrorCode.AUTHORITY_DENIED,
          'only a grantor in the chain may revoke this grant',
        );

      const id = newId();
      const hash = factHash(SchemaRef.statusChange, {
        subjectType: 'AUTHORITY_GRANT',
        subjectId: input.grantId,
        kind: 'REVOKED',
        effectiveFrom: toCanonicalTimestamp(effectiveFrom),
        retroactive: compromise,
        reason: input.reason,
        declaredByPrincipalId: input.actorPrincipalId,
      });
      await ctx.trx
        .insertInto('authority.authority_grant_status_change')
        .values({
          id,
          grant_id: input.grantId,
          kind: 'REVOKED',
          compromise,
          effective_from: effectiveFrom,
          reason: input.reason,
          declared_by_principal_id: input.actorPrincipalId,
          fact_hash: hash,
          recorded_at: ctx.txTime,
        })
        .execute();
      const stream = await openStream(ctx, input.grantId, StreamType.AUTHORITY_GRANT);
      await stream.append({
        eventType: 'AUTHORITY_GRANT_REVOKED',
        factTable: 'authority.authority_grant_status_change',
        factRowId: id,
        payloadHash: hash,
      });
      await stream.close();
      await emitEvent(ctx, {
        eventType: 'AuthorityGrantRevoked',
        aggregateType: 'AUTHORITY_GRANT',
        aggregateId: input.grantId,
        actorPrincipalId: input.actorPrincipalId,
        payload: { compromise, effectiveFrom: toCanonicalTimestamp(effectiveFrom), factHash: hash },
      });
      return { statusChangeId: id };
    });
  }

  /**
   * "Was principal X authorized to exercise capability C over scope S at time T (as known at asOf)?"
   * Defaults: atTime = asOf = now (online act, as known now).
   */
  authorize(
    input: Omit<AuthorizeInput, 'atTime' | 'asOf'> & { atTime?: Instant; asOf?: Instant },
    conflictChecker?: ConflictOfInterestChecker,
  ): Promise<AuthorizationDecision> {
    return inTransaction(this.db, ModuleRole.authority, (ctx) =>
      authorizeIn(
        ctx,
        { ...input, atTime: input.atTime ?? ctx.txTime, asOf: input.asOf ?? ctx.txTime },
        conflictChecker ?? this.conflictChecker,
      ),
    );
  }
}

/** Normalizes a scope through the canonical grant schema (validation + set sorting). */
export function normalizeScope(scope: AuthorityScope): AuthorityScope {
  const normalized = platformCanonicalizer().normalize(
    SchemaRef.authorityGrant.id,
    SchemaRef.authorityGrant.version,
    {
      grantorPrincipalId: '00000000-0000-7000-8000-000000000001',
      granteePrincipalId: '00000000-0000-7000-8000-000000000002',
      capabilities: ['SUBMIT_RESULT'],
      scope,
      delegation: { allowed: false, maxDepth: 0 },
      constraints: { mustNotBeParticipant: true },
      effectiveFrom: '2000-01-01T00:00:00.000Z',
    },
  ) as { scope?: AuthorityScope };
  return normalized.scope ?? {};
}
