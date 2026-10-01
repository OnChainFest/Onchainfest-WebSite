import { createCanonicalizer, type Canonicalizer } from '@br/canonical';
import { ALL_SCHEMAS, BRT06_SCHEMAS } from './definitions';
import { BRT07_SCHEMAS } from './verification';
import { BRT08_SCHEMAS } from './achievements';
import { BRT09_SCHEMAS } from './records';

export * from './definitions';
export * from './verification';
export * from './achievements';
export * from './records';
export { authorityScope, recognitionScope, mark } from './primitives';

/** Schema ids as constants (id, version) so callers never hand-type them. */
export const SchemaRef = {
  resultVersionContent: { id: 'br:result-version-content', version: 1 },
  authorityGrant: { id: 'br:authority-grant', version: 1 },
  trustAnchor: { id: 'br:trust-anchor', version: 1 },
  principal: { id: 'br:principal', version: 1 },
  principalKey: { id: 'br:principal-key', version: 1 },
  statusChange: { id: 'br:status-change', version: 1 },
  result: { id: 'br:result', version: 1 },
  resultVersionFact: { id: 'br:result-version-fact', version: 1 },
  resultStatusTransition: { id: 'br:result-status-transition', version: 1 },
  ledgerEntry: { id: 'br:ledger-entry', version: 1 },
  ledgerGenesis: { id: 'br:ledger-genesis', version: 1 },
  authorizationProof: { id: 'br:authorization-proof', version: 1 },
  cmdCreateResult: { id: 'br:cmd-create-result', version: 1 },
  cmdSubmitResultVersion: { id: 'br:cmd-submit-result-version', version: 1 },
  cmdTransitionResultVersion: { id: 'br:cmd-transition-result-version', version: 1 },
  cmdIssueGrant: { id: 'br:cmd-issue-grant', version: 1 },
  cmdIdentity: { id: 'br:cmd-identity', version: 1 },
  competitionField: { id: 'br:competition-field', version: 1 },
  competitionSeeding: { id: 'br:competition-seeding', version: 1 },
  competitionPlanInput: { id: 'br:competition-plan-input', version: 1 },
  competitionPlan: { id: 'br:competition-plan', version: 1 },
  // BRT-06
  evidenceDescriptor: { id: 'br:evidence-descriptor', version: 1 },
  attestationStatement: { id: 'br:attestation-statement', version: 1 },
  attestationRetractionStatement: { id: 'br:attestation-retraction-statement', version: 1 },
  keyRegistrationStatement: { id: 'br:key-registration-statement', version: 1 },
  attestationFact: { id: 'br:attestation-fact', version: 1 },
  attestationRetractionFact: { id: 'br:attestation-retraction-fact', version: 1 },
  evidenceLifecycleFact: { id: 'br:evidence-lifecycle-fact', version: 1 },
  evidenceBundle: { id: 'br:evidence-bundle', version: 1 },
  // BRT-07
  verificationPolicy: { id: 'br:verification-policy', version: 1 },
  verificationSnapshot: { id: 'br:verification-snapshot', version: 1 },
  verificationTrace: { id: 'br:verification-trace', version: 1 },
  verificationOutcome: { id: 'br:verification-outcome', version: 1 },
  verificationRunFact: { id: 'br:verification-run-fact', version: 1 },
  // BRT-08
  achievementRule: { id: 'br:achievement-rule', version: 1 },
  achievementDerivationSnapshot: { id: 'br:achievement-derivation-snapshot', version: 1 },
  achievementDerivationOutcome: { id: 'br:achievement-derivation-outcome', version: 1 },
  achievementCandidate: { id: 'br:achievement-candidate', version: 1 },
  achievementIdentity: { id: 'br:achievement-identity', version: 1 },
  achievementSupportFacts: { id: 'br:achievement-support-facts', version: 1 },
  achievementCreditedLineup: { id: 'br:achievement-credited-lineup', version: 1 },
  achievementComparisonSet: { id: 'br:achievement-comparison-set', version: 1 },
  achievementEvidenceCommitment: { id: 'br:achievement-evidence-commitment', version: 1 },
  achievementFact: { id: 'br:achievement-fact', version: 1 },
  achievementStatusFact: { id: 'br:achievement-status-fact', version: 1 },
  // BRT-09
  recordCategoryVersion: { id: 'br:record-category-version', version: 1 },
  recordCategoryUniverse: { id: 'br:record-category-universe', version: 1 },
  recordEvaluationSnapshot: { id: 'br:record-evaluation-snapshot', version: 1 },
  recordEvaluationOutcome: { id: 'br:record-evaluation-outcome', version: 1 },
  recordMark: { id: 'br:record-mark', version: 1 },
  recordMarkIdentity: { id: 'br:record-mark-identity', version: 1 },
  recordRatification: { id: 'br:record-ratification', version: 1 },
  recordReplayInput: { id: 'br:record-replay-input', version: 1 },
  recordSupportFacts: { id: 'br:record-support-facts', version: 1 },
  recordMarkFact: { id: 'br:record-mark-fact', version: 1 },
  recordMarkStatusFact: { id: 'br:record-mark-status-fact', version: 1 },
} as const;

/** Domain tags (BRT-02 §3.2 registry). */
export const DomainTag = {
  resultVersionContent: 'result-version-content',
  authorityGrant: 'authority-grant',
  trustAnchor: 'trust-anchor',
  ledgerFact: 'ledger-fact',
  ledgerRow: 'ledger-row',
  ledgerGenesis: 'ledger-genesis',
  authorizationProof: 'authorization-proof',
  commandRequest: 'command-request',
  keyMaterial: 'key-material',
  // BRT-06 (BRT-02 §3.2 registry: one tag per kind of object / signed purpose)
  evidenceDescriptor: 'evidence-descriptor',
  attestationStatement: 'attestation-statement',
  attestationRetraction: 'attestation-retraction',
  keyRegistration: 'key-registration',
  evidenceBundle: 'evidence-bundle',
  // BRT-07 (one tag per kind of verification object)
  verificationPolicy: 'verification-policy',
  verificationSnapshot: 'verification-snapshot',
  verificationTrace: 'verification-trace',
  verificationOutcome: 'verification-outcome',
  // BRT-08 (one tag per kind of achievement object)
  achievementRule: 'achievement-rule',
  achievementDerivationSnapshot: 'achievement-derivation-snapshot',
  achievementDerivationOutcome: 'achievement-derivation-outcome',
  achievementCandidate: 'achievement-candidate',
  achievementIdentity: 'achievement-identity',
  achievementSupport: 'achievement-support',
  achievementLineup: 'achievement-credited-lineup',
  achievementComparisonSet: 'achievement-comparison-set',
  achievementEvidenceCommitment: 'achievement-evidence-commitment',
  // BRT-09 (one tag per kind of record object)
  recordCategoryVersion: 'record-category-version',
  recordCategoryUniverse: 'record-category-universe',
  recordEvaluationSnapshot: 'record-evaluation-snapshot',
  recordEvaluationOutcome: 'record-evaluation-outcome',
  recordMark: 'record-mark',
  recordMarkIdentity: 'record-mark-identity',
  recordRatification: 'record-ratification',
  recordReplay: 'record-replay',
  recordSupport: 'record-support',
} as const;

let shared: Canonicalizer | undefined;

/** Process-wide canonicalizer over the immutable platform schema set. */
export function platformCanonicalizer(): Canonicalizer {
  shared ??= createCanonicalizer([
    ...ALL_SCHEMAS,
    ...BRT06_SCHEMAS,
    ...BRT07_SCHEMAS,
    ...BRT08_SCHEMAS,
    ...BRT09_SCHEMAS,
  ]);
  return shared;
}
