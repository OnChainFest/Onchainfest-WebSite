import type { Uuid } from './ids';
import type { Instant, ValidityWindow } from './time';

export const PrincipalType = {
  PLATFORM: 'PLATFORM',
  ORGANIZATION: 'ORGANIZATION',
  PERSON: 'PERSON',
  SYSTEM: 'SYSTEM',
} as const;
export type PrincipalType = (typeof PrincipalType)[keyof typeof PrincipalType];

export interface Principal {
  readonly id: Uuid;
  readonly principalType: PrincipalType;
  /** Non-PII operational label (e.g. "Platform (development)"). Person PII lives in the vault. */
  readonly label: string;
  readonly recordedAt: Instant;
}

export const KeyKind = {
  WALLET: 'WALLET',
  PASSKEY: 'PASSKEY',
  JWK: 'JWK',
  DEVICE: 'DEVICE',
  KMS: 'KMS',
} as const;
export type KeyKind = (typeof KeyKind)[keyof typeof KeyKind];

export const SignatureAlgorithm = {
  ES256: 'ES256',
  ES256K: 'ES256K',
  EdDSA: 'EdDSA',
  RS256: 'RS256',
} as const;
export type SignatureAlgorithm = (typeof SignatureAlgorithm)[keyof typeof SignatureAlgorithm];

export const KeyStatusChangeKind = {
  ROTATED: 'ROTATED',
  REVOKED: 'REVOKED',
  COMPROMISED: 'COMPROMISED',
} as const;
export type KeyStatusChangeKind = (typeof KeyStatusChangeKind)[keyof typeof KeyStatusChangeKind];

/** Public verification material only. Private key material is never representable. */
export interface PrincipalKey extends ValidityWindow {
  readonly id: Uuid;
  readonly principalId: Uuid;
  readonly keyKind: KeyKind;
  readonly algorithm: SignatureAlgorithm;
  readonly verificationMaterial: Readonly<Record<string, string>>;
  readonly recordedAt: Instant;
}

export type KeyStatusChange =
  | {
      readonly id: Uuid;
      readonly keyId: Uuid;
      readonly kind: 'ROTATED' | 'REVOKED';
      /** Prospective: must not precede recordedAt (strict; no skew). */
      readonly effectiveFrom: Instant;
      readonly recordedAt: Instant;
      readonly reason: string;
    }
  | {
      readonly id: Uuid;
      readonly keyId: Uuid;
      readonly kind: 'COMPROMISED';
      /** Retroactive by design: may precede recordedAt. */
      readonly compromisedSince: Instant;
      readonly recordedAt: Instant;
      readonly reason: string;
    };

export const RecognitionLevel = {
  CLUB: 'CLUB',
  REGIONAL: 'REGIONAL',
  NATIONAL: 'NATIONAL',
  CONTINENTAL: 'CONTINENTAL',
  WORLD: 'WORLD',
  PLATFORM: 'PLATFORM',
} as const;
export type RecognitionLevel = (typeof RecognitionLevel)[keyof typeof RecognitionLevel];

/**
 * Scope algebra (see packages/authority): every constrained dimension is a non-empty set of
 * allowed values; an absent dimension is unconstrained. Request scopes use singleton sets.
 */
export interface AuthorityScope {
  readonly sport?: readonly string[];
  /** Exact discipline ids, or namespaces ending in ".*" (e.g. "athletics.*"). */
  readonly discipline?: readonly string[];
  /** ISO 3166-1 alpha-2 country, or ISO 3166-2 subdivision ("CR", "CR-SJ"). */
  readonly region?: readonly string[];
  readonly recognitionLevel?: readonly RecognitionLevel[];
  readonly competition?: readonly Uuid[];
  readonly event?: readonly Uuid[];
  readonly round?: readonly Uuid[];
  readonly contest?: readonly Uuid[];
}

export const SCOPE_DIMENSIONS = [
  'sport',
  'discipline',
  'region',
  'recognitionLevel',
  'competition',
  'event',
  'round',
  'contest',
] as const satisfies readonly (keyof AuthorityScope)[];
export type ScopeDimension = (typeof SCOPE_DIMENSIONS)[number];

/** Anchor recognition may only constrain the "regime" dimensions. */
export type RecognitionScope = Pick<AuthorityScope, 'sport' | 'discipline' | 'region'> & {
  readonly recognitionLevel: readonly RecognitionLevel[];
};

export interface TrustAnchor extends ValidityWindow {
  readonly id: Uuid;
  readonly principalId: Uuid;
  readonly recognitionScope: RecognitionScope;
  readonly basisRef: string;
  readonly governanceDecisionRef: string;
  readonly recordedAt: Instant;
}

export interface TrustAnchorStatusChange {
  readonly id: Uuid;
  readonly anchorId: Uuid;
  readonly kind: 'REVOKED';
  readonly effectiveFrom: Instant;
  readonly recordedAt: Instant;
  readonly reason: string;
}

/** BRT-01 verification model §4.4. */
export const Capability = {
  SUBMIT_RESULT: 'SUBMIT_RESULT',
  ACCEPT_RESULT: 'ACCEPT_RESULT',
  DECLARE_OFFICIAL: 'DECLARE_OFFICIAL',
  REVOKE_RESULT: 'REVOKE_RESULT',
  ELEVATED_REVOKE: 'ELEVATED_REVOKE',
  CORRECT_RESULT: 'CORRECT_RESULT',
  ELEVATED_CORRECT: 'ELEVATED_CORRECT',
  ATTEST_RESULT: 'ATTEST_RESULT',
  ATTEST_CONDITIONS: 'ATTEST_CONDITIONS',
  ATTEST_IDENTITY: 'ATTEST_IDENTITY',
  ATTEST_ELIGIBILITY: 'ATTEST_ELIGIBILITY',
  SANCTION: 'SANCTION',
  RATIFY_RECORD: 'RATIFY_RECORD',
  ADJUDICATE_DISPUTE: 'ADJUDICATE_DISPUTE',
  APPEAL_ADJUDICATE: 'APPEAL_ADJUDICATE',
  ASSESS_EVIDENCE: 'ASSESS_EVIDENCE',
  GRANT_AUTHORITY: 'GRANT_AUTHORITY',
} as const;
export type Capability = (typeof Capability)[keyof typeof Capability];
export const ALL_CAPABILITIES = Object.values(Capability);

export interface DelegationPolicy {
  readonly allowed: boolean;
  /** Maximum number of further delegation levels beneath this grant. 0 when not allowed. */
  readonly maxDepth: number;
  readonly capabilitiesDelegable: readonly Capability[];
}

export interface GrantConstraints {
  /** BRT-01 A-5 / §4.5 rule 7. Always true in BRT-03. */
  readonly mustNotBeParticipant: boolean;
}

/** Placeholder for the BRT-02 signature envelope (ADR-0015); verification arrives in BRT-04. */
export interface SignatureEnvelopePlaceholder {
  readonly proofType:
    | 'DIRECT_SIGNATURE'
    | 'WALLET_SIGNATURE'
    | 'WEBAUTHN_ASSERTION'
    | 'DEVICE_SIGNATURE'
    | 'PLATFORM_WITNESS';
  readonly scheme: string;
  readonly keyId: Uuid;
  readonly statementHash: string;
  readonly proof: Readonly<Record<string, string>>;
}

export interface AuthorityGrant extends ValidityWindow {
  readonly id: Uuid;
  readonly grantorPrincipalId: Uuid;
  readonly granteePrincipalId: Uuid;
  /** The grant held by the grantor under which this one is delegated; absent for anchor-rooted grants. */
  readonly parentGrantId?: Uuid;
  readonly capabilities: readonly Capability[];
  readonly scope: AuthorityScope;
  readonly delegation: DelegationPolicy;
  readonly constraints: GrantConstraints;
  readonly grantHash: string;
  readonly grantorSignature?: SignatureEnvelopePlaceholder;
  readonly recordedAt: Instant;
}

export type GrantStatusChange =
  | {
      readonly id: Uuid;
      readonly grantId: Uuid;
      readonly kind: 'REVOKED';
      readonly compromise: false;
      /** Prospective. */
      readonly effectiveFrom: Instant;
      readonly recordedAt: Instant;
      readonly reason: string;
    }
  | {
      readonly id: Uuid;
      readonly grantId: Uuid;
      readonly kind: 'REVOKED';
      readonly compromise: true;
      /** Retroactive (fraud / compromise from t₀). */
      readonly effectiveFrom: Instant;
      readonly recordedAt: Instant;
      readonly reason: string;
    };
