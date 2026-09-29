import { createCanonicalizer, type Canonicalizer } from '@br/canonical';
import { ALL_SCHEMAS } from './definitions';

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
} as const;

let shared: Canonicalizer | undefined;

/** Process-wide canonicalizer over the immutable platform schema set. */
export function platformCanonicalizer(): Canonicalizer {
  shared ??= createCanonicalizer(ALL_SCHEMAS);
  return shared;
}
