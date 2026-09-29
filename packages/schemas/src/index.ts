import { createCanonicalizer, type Canonicalizer } from '@br/canonical';
import { ALL_SCHEMAS, BRT06_SCHEMAS } from './definitions';

export * from './definitions';
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
} as const;

let shared: Canonicalizer | undefined;

/** Process-wide canonicalizer over the immutable platform schema set. */
export function platformCanonicalizer(): Canonicalizer {
  shared ??= createCanonicalizer([...ALL_SCHEMAS, ...BRT06_SCHEMAS]);
  return shared;
}
