import type { Uuid } from './ids';

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

export const VerificationLevel = { V0: 'V0', V1: 'V1', V2: 'V2', V3: 'V3', V4: 'V4' } as const;
export type VerificationLevel = (typeof VerificationLevel)[keyof typeof VerificationLevel];

export interface VerificationRef {
  readonly verificationId: Uuid;
  readonly level: VerificationLevel;
  readonly inputsDigest: string;
}
