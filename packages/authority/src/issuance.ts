import {
  Capability,
  isBackdated,
  isWithin,
  windowContains,
  type AuthorityGrant,
  type AuthorityScope,
  type DelegationPolicy,
  type GrantConstraints,
  type Instant,
  type Uuid,
} from '@br/domain';
import { AuthorityView, evaluateChain, runConflictCheck } from './engine';
import {
  participationIndexUnavailable,
  type AuthorityFacts,
  type AuthorizationReason,
  type ConflictOfInterestChecker,
} from './facts';
import { scopeContains, wideningDimensions } from './scope';

export interface GrantDraft {
  readonly grantorPrincipalId: Uuid;
  readonly granteePrincipalId: Uuid;
  readonly parentGrantId?: Uuid;
  readonly capabilities: readonly Capability[];
  readonly scope: AuthorityScope;
  readonly delegation: DelegationPolicy;
  readonly constraints: GrantConstraints;
  readonly effectiveFrom: Instant;
  readonly effectiveTo?: Instant;
}

export const GrantIssuanceReason = {
  OK: 'OK',
  BACKDATED: 'BACKDATED',
  EMPTY_WINDOW: 'EMPTY_WINDOW',
  SELF_GRANT: 'SELF_GRANT',
  UNKNOWN_PRINCIPAL: 'UNKNOWN_PRINCIPAL',
  NO_CAPABILITIES: 'NO_CAPABILITIES',
  INCONSISTENT_DELEGATION: 'INCONSISTENT_DELEGATION',
  PARENT_UNKNOWN: 'PARENT_UNKNOWN',
  PARENT_NOT_HELD_BY_GRANTOR: 'PARENT_NOT_HELD_BY_GRANTOR',
  SCOPE_WIDENED: 'SCOPE_WIDENED',
  VALIDITY_WIDENED: 'VALIDITY_WIDENED',
  DEPTH_WIDENED: 'DEPTH_WIDENED',
  GRANTOR_NOT_AUTHORIZED: 'GRANTOR_NOT_AUTHORIZED',
  /** GRANT_AUTHORITY is conflict-sensitive: the grantor participates in the granted scope. */
  GRANTOR_CONFLICTED: 'GRANTOR_CONFLICTED',
  /** Fail-closed: no participation data to prove the grantor is independent of the scope. */
  CONFLICT_CHECK_UNAVAILABLE: 'CONFLICT_CHECK_UNAVAILABLE',
} as const;
export type GrantIssuanceReason = (typeof GrantIssuanceReason)[keyof typeof GrantIssuanceReason];

export interface GrantIssuanceOutcome {
  readonly ok: boolean;
  readonly reason: GrantIssuanceReason;
  /** Chain/anchor failure behind GRANTOR_NOT_AUTHORIZED, per capability. */
  readonly chainFailure?: { readonly capability: Capability; readonly reason: AuthorizationReason };
  readonly detail?: string;
}

const ok: GrantIssuanceOutcome = { ok: true, reason: GrantIssuanceReason.OK };
const reject = (reason: GrantIssuanceReason, detail?: string): GrantIssuanceOutcome =>
  detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };

/**
 * Validates a grant at issuance time `recordedAt` (DB transaction time), as known now.
 *
 * Rules (BRT-01 §4.3–4.5, BRT-02 §5.1):
 *  - no backdating: effectiveFrom ≥ recordedAt, strictly — no clock-skew tolerance; authority is
 *    never created for the past (future-scheduled grants are allowed);
 *  - grantor ≠ grantee; both principals exist;
 *  - delegation policy is internally consistent;
 *  - anchor-rooted grant: the grantor is a recognized anchor at recordedAt whose recognition
 *    covers the new scope, and the grant's validity lies inside the anchor's;
 *  - delegated grant: the parent is held by the grantor, allows delegation of every granted
 *    capability through the whole chain, the new scope and validity do not widen the parent's,
 *    and the delegation depth only tightens;
 *  - conflict of interest (fail-closed): exercising GRANT_AUTHORITY is conflict-sensitive, so the
 *    checker must report the grantor CLEAR for the granted scope.
 */
export function validateGrantIssuance(
  facts: AuthorityFacts,
  draft: GrantDraft,
  recordedAt: Instant,
  conflictChecker: ConflictOfInterestChecker = participationIndexUnavailable,
): GrantIssuanceOutcome {
  if (isBackdated(draft.effectiveFrom, recordedAt)) {
    return reject(GrantIssuanceReason.BACKDATED, 'effectiveFrom precedes the recording time');
  }
  if (
    draft.effectiveTo !== undefined &&
    draft.effectiveTo.getTime() <= draft.effectiveFrom.getTime()
  ) {
    return reject(GrantIssuanceReason.EMPTY_WINDOW);
  }
  if (draft.grantorPrincipalId === draft.granteePrincipalId)
    return reject(GrantIssuanceReason.SELF_GRANT);
  if (draft.capabilities.length === 0) return reject(GrantIssuanceReason.NO_CAPABILITIES);

  const d = draft.delegation;
  const grantsAuthority = draft.capabilities.includes(Capability.GRANT_AUTHORITY);
  const delegableSubset = d.capabilitiesDelegable.every((c) => draft.capabilities.includes(c));
  const consistent = d.allowed
    ? grantsAuthority && d.maxDepth >= 1 && delegableSubset
    : !grantsAuthority && d.maxDepth === 0 && d.capabilitiesDelegable.length === 0;
  if (!consistent) return reject(GrantIssuanceReason.INCONSISTENT_DELEGATION);

  const view = new AuthorityView(facts, recordedAt);
  if (
    view.principal(draft.grantorPrincipalId) === undefined ||
    view.principal(draft.granteePrincipalId) === undefined
  ) {
    return reject(GrantIssuanceReason.UNKNOWN_PRINCIPAL);
  }

  if (draft.parentGrantId !== undefined) {
    const parent = view.grant(draft.parentGrantId);
    if (parent === undefined) return reject(GrantIssuanceReason.PARENT_UNKNOWN);
    if (parent.granteePrincipalId !== draft.grantorPrincipalId)
      return reject(GrantIssuanceReason.PARENT_NOT_HELD_BY_GRANTOR);
    if (!scopeContains(parent.scope, draft.scope)) {
      return reject(
        GrantIssuanceReason.SCOPE_WIDENED,
        `widened dimensions: ${wideningDimensions(parent.scope, draft.scope).join(', ')}`,
      );
    }
    if (!windowContains(parent, draft)) return reject(GrantIssuanceReason.VALIDITY_WIDENED);
    if (d.maxDepth > Math.max(0, parent.delegation.maxDepth - 1))
      return reject(GrantIssuanceReason.DEPTH_WIDENED);
  }

  // Evaluate the would-be chain for every granted capability, with the draft as leaf.
  const virtualLeaf: AuthorityGrant = {
    ...draft,
    id: '00000000-0000-7000-8000-000000000000' as Uuid,
    grantHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    recordedAt,
  };
  // The chain must hold when the grant takes effect (issuance may schedule a future start);
  // revocations are considered as known at recordedAt.
  const evaluationTime = new Date(Math.max(recordedAt.getTime(), draft.effectiveFrom.getTime()));
  for (const capability of draft.capabilities) {
    const outcome = evaluateChain(view, virtualLeaf, capability, draft.scope, evaluationTime);
    if (!outcome.ok) {
      return {
        ok: false,
        reason: GrantIssuanceReason.GRANTOR_NOT_AUTHORIZED,
        chainFailure: { capability, reason: outcome.reason },
      };
    }
    if (draft.parentGrantId === undefined && !windowContains(outcome.anchor, draft)) {
      return reject(
        GrantIssuanceReason.VALIDITY_WIDENED,
        'grant validity exceeds the anchor recognition window',
      );
    }
  }
  const conflict = runConflictCheck(
    conflictChecker,
    draft.grantorPrincipalId,
    draft.scope,
    new Date(Math.max(recordedAt.getTime(), draft.effectiveFrom.getTime())),
  );
  if (conflict === 'CONFLICTED') return reject(GrantIssuanceReason.GRANTOR_CONFLICTED);
  if (conflict !== 'CLEAR') {
    return reject(GrantIssuanceReason.CONFLICT_CHECK_UNAVAILABLE, `checker ${conflictChecker.id}`);
  }
  if (!isWithin(draft, draft.effectiveFrom)) return reject(GrantIssuanceReason.EMPTY_WINDOW);
  return ok;
}
