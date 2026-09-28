import type {
  AuthorityGrant,
  AuthorityScope,
  Capability,
  GrantStatusChange,
  Instant,
  KeyStatusChange,
  Principal,
  PrincipalKey,
  TrustAnchor,
  TrustAnchorStatusChange,
  Uuid,
} from '@br/domain';

/** An anchor or key together with the hash of its ledger fact (bound into proof digests). */
export type AnchorFact = TrustAnchor & { readonly factHash: string };
export type KeyFact = PrincipalKey & { readonly factHash: string };

/**
 * The authority facts an evaluation may use. Facts carry `recordedAt` (transaction time); the
 * engine filters them by `asOf` itself, so a loader may over-fetch safely.
 */
export interface AuthorityFacts {
  readonly principals: readonly Principal[];
  readonly keys: readonly KeyFact[];
  readonly keyStatusChanges: readonly KeyStatusChange[];
  readonly anchors: readonly AnchorFact[];
  readonly anchorStatusChanges: readonly TrustAnchorStatusChange[];
  readonly grants: readonly AuthorityGrant[];
  readonly grantStatusChanges: readonly GrantStatusChange[];
}

export interface AuthorizationRequest {
  readonly principalId: Uuid;
  readonly keyId?: Uuid;
  /** Signer assertion; only tightens compromise checks, never establishes authority. */
  readonly signedAt?: Instant;
  readonly capability: Capability;
  /** The request's resolved scope path (singleton sets). */
  readonly scope: AuthorityScope;
  /** Effective time T. For online acts: platform-observed issuedAt. */
  readonly atTime: Instant;
  /** Knowledge horizon (transaction time). Default in callers: now ("as known now"). */
  readonly asOf: Instant;
}

/** What a checker can say. `NOT_APPLICABLE` is only ever produced by the engine (exempt capability). */
export type CheckerResult = 'CLEAR' | 'CONFLICTED' | 'UNAVAILABLE';
export type ConflictStatus = CheckerResult | 'NOT_APPLICABLE';

/**
 * Conflict-of-interest hook (BRT-01 §4.5 rule 7).
 *
 * FAIL-CLOSED (BRT-03R): for every conflict-sensitive capability, authorization requires the
 * checker to answer `CLEAR`. `CONFLICTED`, `UNAVAILABLE`, a missing checker, or a checker that
 * throws all deny. The real participation-backed checker belongs to the Participation context
 * (BRT-04+); until it exists, conflict-sensitive actions are denied unless a caller explicitly
 * supplies a checker with declared participation data (see `staticParticipationChecker`).
 */
export interface ConflictOfInterestChecker {
  /** Recorded in every decision and proof digest (which data source answered). */
  readonly id: string;
  check(principalId: Uuid, scope: AuthorityScope, atTime: Instant): CheckerResult;
}

/** Default: no participation data exists ⇒ every conflict-sensitive capability is denied. */
export const participationIndexUnavailable: ConflictOfInterestChecker = {
  id: 'participation-index-unavailable',
  check: () => 'UNAVAILABLE',
};

/** Options accepted by `authorize` (declared here so tests and callers can type them). */
export interface EvaluateOptionsLike {
  readonly conflictChecker?: ConflictOfInterestChecker;
  readonly evaluatedAt?: Instant;
}

export const AuthorizationReason = {
  AUTHORIZED: 'AUTHORIZED',
  INVALID_REQUEST: 'INVALID_REQUEST',
  PRINCIPAL_UNKNOWN: 'PRINCIPAL_UNKNOWN',
  KEY_UNKNOWN: 'KEY_UNKNOWN',
  KEY_NOT_OWNED: 'KEY_NOT_OWNED',
  KEY_NOT_VALID_AT_TIME: 'KEY_NOT_VALID_AT_TIME',
  KEY_REVOKED: 'KEY_REVOKED',
  KEY_COMPROMISED: 'KEY_COMPROMISED',
  CONFLICT_OF_INTEREST: 'CONFLICT_OF_INTEREST',
  CONFLICT_CHECK_UNAVAILABLE: 'CONFLICT_CHECK_UNAVAILABLE',
  NO_GRANT_FOR_CAPABILITY: 'NO_GRANT_FOR_CAPABILITY',
  SCOPE_NOT_COVERED: 'SCOPE_NOT_COVERED',
  GRANT_NOT_VALID_AT_TIME: 'GRANT_NOT_VALID_AT_TIME',
  GRANT_REVOKED: 'GRANT_REVOKED',
  CHAIN_BROKEN: 'CHAIN_BROKEN',
  DELEGATION_NOT_ALLOWED: 'DELEGATION_NOT_ALLOWED',
  CAPABILITY_NOT_DELEGABLE: 'CAPABILITY_NOT_DELEGABLE',
  DELEGATION_DEPTH_EXCEEDED: 'DELEGATION_DEPTH_EXCEEDED',
  SCOPE_WIDENED: 'SCOPE_WIDENED',
  ANCHOR_MISSING: 'ANCHOR_MISSING',
  ANCHOR_NOT_VALID_AT_TIME: 'ANCHOR_NOT_VALID_AT_TIME',
  ANCHOR_REVOKED: 'ANCHOR_REVOKED',
  ANCHOR_SCOPE_NOT_COVERED: 'ANCHOR_SCOPE_NOT_COVERED',
  ANCHOR_LEVEL_FORBIDDEN: 'ANCHOR_LEVEL_FORBIDDEN',
} as const;
export type AuthorizationReason = (typeof AuthorizationReason)[keyof typeof AuthorizationReason];

export interface ChainLink {
  readonly grantId: Uuid;
  readonly grantHash: string;
}

export interface AuthorizationDecision {
  readonly authorized: boolean;
  readonly reason: AuthorizationReason;
  readonly anchorId?: Uuid;
  /** Ordered leaf → root. */
  readonly grantChain: readonly ChainLink[];
  readonly conflictCheck: ConflictStatus;
  /** Identifier of the checker consulted (or `none` for exempt capabilities). */
  readonly conflictCheckerId: string;
  /** Why each candidate grant failed (empty when authorized by the first candidate). */
  readonly candidateFailures: readonly {
    readonly grantId: Uuid;
    readonly reason: AuthorizationReason;
  }[];
  readonly evaluatedAt: Instant;
  readonly atTime: Instant;
  readonly asOf: Instant;
  readonly engineVersion: string;
  /** Deterministic digest over the request, outcome and exact authority facts used. */
  readonly proofDigest: string;
}
