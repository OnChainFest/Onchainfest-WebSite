export { coversValue, scopeContains, wideningDimensions } from './scope';
export {
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
  type KeyFact,
} from './facts';
export {
  authorize,
  evaluateChain,
  isConflictSensitive,
  runConflictCheck,
  CONFLICT_EXEMPT_CAPABILITIES,
  ENGINE_VERSION,
  type EvaluateOptions,
} from './engine';
export { staticParticipationChecker, type ParticipationDeclaration } from './conflict';
export {
  validateGrantIssuance,
  GrantIssuanceReason,
  type GrantDraft,
  type GrantIssuanceOutcome,
} from './issuance';
