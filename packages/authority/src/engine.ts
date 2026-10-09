import {
  Capability,
  isWithin,
  toCanonicalTimestamp,
  type AuthorityGrant,
  type AuthorityScope,
  type Instant,
  type Uuid,
} from '@br/domain';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';
import {
  AuthorizationReason,
  participationIndexUnavailable,
  type AnchorFact,
  type AuthorityFacts,
  type AuthorizationDecision,
  type AuthorizationRequest,
  type ChainLink,
  type ConflictOfInterestChecker,
  type ConflictStatus,
  type CheckerResult,
  type EvaluateOptionsLike,
} from './facts';
import { scopeContains } from './scope';

export const ENGINE_VERSION = 'brt-03/2';
const MAX_CHAIN_LENGTH = 16;

/**
 * Capabilities whose semantics do NOT require independence from the subject (BRT-03R):
 *   SUBMIT_RESULT — participants may submit claims about their own contests (BRT-01 T1/T2
 *   submission policy); a submission confers no trust by itself (V0) and still needs
 *   independent acceptance/attestation.
 * Every other capability is conflict-sensitive and fails closed unless the checker says CLEAR.
 */
export const CONFLICT_EXEMPT_CAPABILITIES: ReadonlySet<Capability> = new Set([
  Capability.SUBMIT_RESULT,
]);

export function isConflictSensitive(capability: Capability): boolean {
  return !CONFLICT_EXEMPT_CAPABILITIES.has(capability);
}

/** Runs the checker; a throwing checker counts as UNAVAILABLE (fail-closed). */
export function runConflictCheck(
  checker: ConflictOfInterestChecker,
  principalId: Uuid,
  scope: AuthorityScope,
  atTime: Instant,
): CheckerResult {
  try {
    const result = checker.check(principalId, scope, atTime);
    return result === 'CLEAR' || result === 'CONFLICTED' ? result : 'UNAVAILABLE';
  } catch {
    return 'UNAVAILABLE';
  }
}

export type EvaluateOptions = EvaluateOptionsLike;

/** Facts visible at the knowledge horizon `asOf` (transaction time). */
class View {
  private readonly facts: AuthorityFacts;
  private readonly asOf: Instant;

  constructor(facts: AuthorityFacts, asOf: Instant) {
    this.facts = facts;
    this.asOf = asOf;
  }

  private visible<T extends { readonly recordedAt: Instant }>(items: readonly T[]): T[] {
    const horizon = this.asOf.getTime();
    return items.filter((f) => f.recordedAt.getTime() <= horizon);
  }

  principal(id: Uuid) {
    return this.visible(this.facts.principals).find((p) => p.id === id);
  }
  key(id: Uuid) {
    return this.visible(this.facts.keys).find((k) => k.id === id);
  }
  keyStatus(keyId: Uuid) {
    return this.visible(this.facts.keyStatusChanges).filter((s) => s.keyId === keyId);
  }
  grant(id: Uuid) {
    return this.visible(this.facts.grants).find((g) => g.id === id);
  }
  grantsHeldBy(principalId: Uuid) {
    return this.visible(this.facts.grants)
      .filter((g) => g.granteePrincipalId === principalId)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }
  grantStatus(grantId: Uuid) {
    return this.visible(this.facts.grantStatusChanges).filter((s) => s.grantId === grantId);
  }
  anchorsOf(principalId: Uuid) {
    return this.visible(this.facts.anchors)
      .filter((a) => a.principalId === principalId)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }
  anchorStatus(anchorId: Uuid) {
    return this.visible(this.facts.anchorStatusChanges).filter((s) => s.anchorId === anchorId);
  }
}

type ChainOutcome =
  | { ok: true; chain: ChainLink[]; anchor: AnchorFact; statusFactIds: Uuid[] }
  | { ok: false; reason: AuthorizationReason; statusFactIds: Uuid[] };

/**
 * Walks a grant chain from `leaf` to a trust anchor, checking at effective time T:
 * validity windows, revocations (as known at asOf), capability delegability at every hop,
 * delegation depth, scope narrowing and anchor recognition. The leaf itself may be a
 * not-yet-persisted draft (issuance validation).
 */
export function evaluateChain(
  view: View,
  leaf: AuthorityGrant,
  capability: Capability,
  requestScope: AuthorityScope,
  atTime: Instant,
): ChainOutcome {
  const statusFactIds: Uuid[] = [];
  const active = (g: AuthorityGrant): AuthorizationReason | undefined => {
    if (!isWithin(g, atTime)) return AuthorizationReason.GRANT_NOT_VALID_AT_TIME;
    for (const change of view.grantStatus(g.id)) {
      statusFactIds.push(change.id);
      if (change.effectiveFrom.getTime() <= atTime.getTime())
        return AuthorizationReason.GRANT_REVOKED;
    }
    return undefined;
  };
  const fail = (reason: AuthorizationReason): ChainOutcome => ({
    ok: false,
    reason,
    statusFactIds,
  });

  if (!leaf.capabilities.includes(capability))
    return fail(AuthorizationReason.NO_GRANT_FOR_CAPABILITY);
  if (!scopeContains(leaf.scope, requestScope)) return fail(AuthorizationReason.SCOPE_NOT_COVERED);
  const leafInactive = active(leaf);
  if (leafInactive !== undefined) return fail(leafInactive);

  const chain: ChainLink[] = [{ grantId: leaf.id, grantHash: leaf.grantHash }];
  let child = leaf;
  let hops = 0;
  while (child.parentGrantId !== undefined) {
    if (chain.length >= MAX_CHAIN_LENGTH) return fail(AuthorizationReason.CHAIN_BROKEN);
    const parent = view.grant(child.parentGrantId);
    if (parent === undefined || parent.granteePrincipalId !== child.grantorPrincipalId) {
      return fail(AuthorizationReason.CHAIN_BROKEN);
    }
    const parentInactive = active(parent);
    if (parentInactive !== undefined) return fail(parentInactive);
    hops += 1;
    if (!parent.delegation.allowed || !parent.capabilities.includes(Capability.GRANT_AUTHORITY)) {
      return fail(AuthorizationReason.DELEGATION_NOT_ALLOWED);
    }
    if (
      !parent.delegation.capabilitiesDelegable.includes(capability) ||
      !parent.capabilities.includes(capability)
    ) {
      return fail(AuthorizationReason.CAPABILITY_NOT_DELEGABLE);
    }
    if (hops > parent.delegation.maxDepth)
      return fail(AuthorizationReason.DELEGATION_DEPTH_EXCEEDED);
    if (!scopeContains(parent.scope, child.scope)) return fail(AuthorizationReason.SCOPE_WIDENED);
    chain.push({ grantId: parent.id, grantHash: parent.grantHash });
    child = parent;
  }

  // Root: the grantor of the top-most grant must be a recognized trust anchor at T.
  const grantor = view.principal(child.grantorPrincipalId);
  const anchors = view.anchorsOf(child.grantorPrincipalId);
  if (grantor === undefined || anchors.length === 0)
    return fail(AuthorizationReason.ANCHOR_MISSING);
  let best: AuthorizationReason = AuthorizationReason.ANCHOR_MISSING;
  for (const anchor of anchors) {
    const levels = anchor.recognitionScope.recognitionLevel;
    const platformOnly = levels.length === 1 && levels[0] === 'PLATFORM';
    // Defense in depth (BRT-01 §4.2): the PLATFORM principal can only anchor PLATFORM level,
    // and no other principal may claim the PLATFORM level.
    if ((grantor.principalType === 'PLATFORM') !== platformOnly) {
      best = AuthorizationReason.ANCHOR_LEVEL_FORBIDDEN;
      continue;
    }
    if (!isWithin(anchor, atTime)) {
      best = AuthorizationReason.ANCHOR_NOT_VALID_AT_TIME;
      continue;
    }
    let revoked = false;
    for (const change of view.anchorStatus(anchor.id)) {
      statusFactIds.push(change.id);
      if (change.effectiveFrom.getTime() <= atTime.getTime()) revoked = true;
    }
    if (revoked) {
      best = AuthorizationReason.ANCHOR_REVOKED;
      continue;
    }
    if (!scopeContains(anchor.recognitionScope, child.scope)) {
      best = AuthorizationReason.ANCHOR_SCOPE_NOT_COVERED;
      continue;
    }
    return { ok: true, chain, anchor, statusFactIds };
  }
  return fail(best);
}

/**
 * Answers "was principal X authorized to exercise capability C over scope S at time T,
 * as known at asOf?" — deterministically and explainably.
 */
export function authorize(
  facts: AuthorityFacts,
  request: AuthorizationRequest,
  options: EvaluateOptions = {},
): AuthorizationDecision {
  const view = new View(facts, request.asOf);
  const checker = options.conflictChecker ?? participationIndexUnavailable;
  const evaluatedAt = options.evaluatedAt ?? new Date();
  const statusFactIds = new Set<Uuid>();
  let keyProof: { keyId: Uuid; factHash: string } | undefined;

  const finish = (
    reason: AuthorizationReason,
    extra: {
      conflictCheck?: ConflictStatus;
      conflictCheckerId?: string;
      chain?: ChainLink[];
      anchor?: AnchorFact;
      failures?: { grantId: Uuid; reason: AuthorizationReason }[];
    } = {},
  ): AuthorizationDecision => {
    const authorized = reason === AuthorizationReason.AUTHORIZED;
    const conflictCheck = extra.conflictCheck ?? 'NOT_APPLICABLE';
    const conflictCheckerId = extra.conflictCheckerId ?? 'none';
    const chain = extra.chain ?? [];
    const proofDoc: Record<string, unknown> = {
      engineVersion: ENGINE_VERSION,
      request: {
        principalId: request.principalId,
        ...(request.keyId === undefined ? {} : { keyId: request.keyId }),
        capability: request.capability,
        scope: request.scope,
        atTime: toCanonicalTimestamp(request.atTime),
        asOf: toCanonicalTimestamp(request.asOf),
      },
      authorized,
      reason,
      grantChain: chain,
      statusFactIds: [...statusFactIds],
      conflictCheck,
      conflictCheckerId,
      ...(extra.anchor === undefined
        ? {}
        : { anchor: { anchorId: extra.anchor.id, factHash: extra.anchor.factHash } }),
      ...(keyProof === undefined ? {} : { key: keyProof }),
    };
    const { contentHash } = platformCanonicalizer().hashCanonical(
      DomainTag.authorizationProof,
      SchemaRef.authorizationProof.id,
      SchemaRef.authorizationProof.version,
      proofDoc,
    );
    return {
      authorized,
      reason,
      ...(extra.anchor === undefined ? {} : { anchorId: extra.anchor.id }),
      grantChain: chain,
      conflictCheck,
      conflictCheckerId,
      candidateFailures: extra.failures ?? [],
      evaluatedAt,
      atTime: request.atTime,
      asOf: request.asOf,
      engineVersion: ENGINE_VERSION,
      proofDigest: contentHash,
    };
  };

  if (Number.isNaN(request.atTime.getTime()) || Number.isNaN(request.asOf.getTime())) {
    return finish(AuthorizationReason.INVALID_REQUEST);
  }
  if (view.principal(request.principalId) === undefined)
    return finish(AuthorizationReason.PRINCIPAL_UNKNOWN);

  if (request.keyId !== undefined) {
    const key = view.key(request.keyId);
    if (key === undefined) return finish(AuthorizationReason.KEY_UNKNOWN);
    if (key.principalId !== request.principalId) return finish(AuthorizationReason.KEY_NOT_OWNED);
    keyProof = { keyId: key.id, factHash: key.factHash };
    if (!isWithin(key, request.atTime)) return finish(AuthorizationReason.KEY_NOT_VALID_AT_TIME);
    const t = request.atTime.getTime();
    const signed = request.signedAt?.getTime();
    for (const change of view.keyStatus(key.id)) {
      statusFactIds.add(change.id);
      if (change.kind === 'COMPROMISED') {
        const t0 = change.compromisedSince.getTime();
        // BRT-02 §5.1 rule 5: SUSPECT if signedAt ≥ t₀ OR issuedAt ≥ t₀ (defeats backdating).
        if (t >= t0 || (signed !== undefined && signed >= t0))
          return finish(AuthorizationReason.KEY_COMPROMISED);
      } else if (change.effectiveFrom.getTime() <= t) {
        return finish(AuthorizationReason.KEY_REVOKED);
      }
    }
  }

  // Conflict of interest (fail-closed for sensitive capabilities). The status is always
  // recorded; it decides the outcome only once an authority chain has been found, so denial
  // reasons stay specific (e.g. NO_GRANT_FOR_CAPABILITY when there is no chain at all).
  const sensitive = isConflictSensitive(request.capability);
  const conflictCheck: ConflictStatus = sensitive
    ? runConflictCheck(checker, request.principalId, request.scope, request.atTime)
    : 'NOT_APPLICABLE';
  const conflict = { conflictCheck, conflictCheckerId: sensitive ? checker.id : 'none' };

  const candidates = view
    .grantsHeldBy(request.principalId)
    .filter((g) => g.capabilities.includes(request.capability));
  if (candidates.length === 0) return finish(AuthorizationReason.NO_GRANT_FOR_CAPABILITY, conflict);

  const failures: { grantId: Uuid; reason: AuthorizationReason }[] = [];
  for (const grant of candidates) {
    const outcome = evaluateChain(view, grant, request.capability, request.scope, request.atTime);
    outcome.statusFactIds.forEach((id) => statusFactIds.add(id));
    if (outcome.ok) {
      const chainInfo = { ...conflict, chain: outcome.chain, anchor: outcome.anchor, failures };
      if (conflictCheck === 'CONFLICTED') {
        return finish(AuthorizationReason.CONFLICT_OF_INTEREST, chainInfo);
      }
      if (sensitive && conflictCheck !== 'CLEAR') {
        return finish(AuthorizationReason.CONFLICT_CHECK_UNAVAILABLE, chainInfo);
      }
      return finish(AuthorizationReason.AUTHORIZED, chainInfo);
    }
    failures.push({ grantId: grant.id, reason: outcome.reason });
  }
  return finish(failures[0]?.reason ?? AuthorizationReason.NO_GRANT_FOR_CAPABILITY, {
    ...conflict,
    failures,
  });
}

export { View as AuthorityView };
