import type { Uuid } from './ids';
import type { VerificationLevel } from './verification';

/** References into modules not yet implemented in BRT-03. Integrity binds via the hash. */
export interface EvidenceRef {
  readonly evidenceId: Uuid;
  /** Plain SHA-256 of the evidence bytes. */
  readonly contentHash: string;
}

export interface AttestationRef {
  readonly attestationId: Uuid;
  readonly statementHash: string;
}

export interface VerificationRef {
  readonly verificationId: Uuid;
  readonly level: VerificationLevel;
  readonly inputsDigest: string;
}
