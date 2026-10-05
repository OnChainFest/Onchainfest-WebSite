/**
 * BRT-04 identity vocabulary. Every concept is a closed union; nothing is "stringly typed".
 *
 * Mandatory distinctions (BRT-02 identity & authority §1):
 *   Person ≠ Account ≠ Athlete ≠ Wallet;  membership ≠ sports authority;
 *   public profile ≠ private identity;  Athlete Passport ≠ source of sporting truth.
 */
export const AccountStatus = { ACTIVE: 'ACTIVE', DISABLED: 'DISABLED' } as const;
export type AccountStatus = (typeof AccountStatus)[keyof typeof AccountStatus];

export const AthleteStatus = { ACTIVE: 'ACTIVE', DEACTIVATED: 'DEACTIVATED' } as const;
export type AthleteStatus = (typeof AthleteStatus)[keyof typeof AthleteStatus];

/** Profile visibility (athlete profile / passport). */
export const ProfileVisibility = {
  PUBLIC: 'PUBLIC',
  AUTHENTICATED: 'AUTHENTICATED',
  PRIVATE: 'PRIVATE',
} as const;
export type ProfileVisibility = (typeof ProfileVisibility)[keyof typeof ProfileVisibility];

/** Visibility of an individual identity attribute (external id, wallet). */
export const AttributeVisibility = { PUBLIC: 'PUBLIC', PRIVATE: 'PRIVATE' } as const;
export type AttributeVisibility = (typeof AttributeVisibility)[keyof typeof AttributeVisibility];

/**
 * Organization types. TEAM is deliberately absent: BRT-01 defines Team as a competition identity
 * (a persistent side or an ad-hoc pair) that belongs to the Competition/Participation context.
 * The type is descriptive only — FEDERATION confers no authority (TrustAnchor/AuthorityGrant do).
 */
export const OrganizationType = {
  FEDERATION: 'FEDERATION',
  GOVERNING_BODY: 'GOVERNING_BODY',
  LEAGUE: 'LEAGUE',
  CLUB: 'CLUB',
  ACADEMY: 'ACADEMY',
  EVENT_ORGANIZER: 'EVENT_ORGANIZER',
  VENUE: 'VENUE',
  SPONSOR: 'SPONSOR',
  BRAND: 'BRAND',
  SERVICE_PROVIDER: 'SERVICE_PROVIDER',
  OTHER: 'OTHER',
} as const;
export type OrganizationType = (typeof OrganizationType)[keyof typeof OrganizationType];

export const OrganizationStatus = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  CLOSED: 'CLOSED',
} as const;
export type OrganizationStatus = (typeof OrganizationStatus)[keyof typeof OrganizationStatus];

/**
 * Operational membership roles. `OFFICIAL` means "listed as an official of the club" in the
 * application — it is NOT authority to certify results (that requires an AuthorityGrant).
 */
export const MembershipRole = {
  OWNER: 'OWNER',
  ADMIN: 'ADMIN',
  MEMBER: 'MEMBER',
  ATHLETE: 'ATHLETE',
  COACH: 'COACH',
  OFFICIAL: 'OFFICIAL',
  STAFF: 'STAFF',
} as const;
export type MembershipRole = (typeof MembershipRole)[keyof typeof MembershipRole];

export const MembershipStatus = {
  INVITED: 'INVITED',
  ACTIVE: 'ACTIVE',
  DECLINED: 'DECLINED',
  SUSPENDED: 'SUSPENDED',
  ENDED: 'ENDED',
} as const;
export type MembershipStatus = (typeof MembershipStatus)[keyof typeof MembershipStatus];

export const MembershipVisibility = {
  PUBLIC: 'PUBLIC',
  MEMBERS: 'MEMBERS',
  PRIVATE: 'PRIVATE',
} as const;
export type MembershipVisibility = (typeof MembershipVisibility)[keyof typeof MembershipVisibility];

/** Roles that may appear as a public athlete affiliation in the passport. */
export const AFFILIATION_ROLES: readonly MembershipRole[] = ['ATHLETE', 'MEMBER', 'COACH'];

export const GuardianRelationshipKind = {
  PARENT: 'PARENT',
  LEGAL_GUARDIAN: 'LEGAL_GUARDIAN',
  OTHER_RESPONSIBLE_ADULT: 'OTHER_RESPONSIBLE_ADULT',
} as const;
export type GuardianRelationshipKind =
  (typeof GuardianRelationshipKind)[keyof typeof GuardianRelationshipKind];

/** PENDING = asserted; ACTIVE = confirmed (requires a confirmation basis). */
export const GuardianStatus = {
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  REVOKED: 'REVOKED',
  ENDED: 'ENDED',
} as const;
export type GuardianStatus = (typeof GuardianStatus)[keyof typeof GuardianStatus];

export const GuardianConfirmationBasis = {
  PLATFORM_REVIEW: 'PLATFORM_REVIEW',
  ORGANIZATION_CONFIRMED: 'ORGANIZATION_CONFIRMED',
  DEPENDENT_CONFIRMED: 'DEPENDENT_CONFIRMED',
} as const;
export type GuardianConfirmationBasis =
  (typeof GuardianConfirmationBasis)[keyof typeof GuardianConfirmationBasis];

export const ExternalIdentityStatus = {
  CLAIMED: 'CLAIMED',
  CONFIRMED: 'CONFIRMED',
  REVOKED: 'REVOKED',
} as const;
export type ExternalIdentityStatus =
  (typeof ExternalIdentityStatus)[keyof typeof ExternalIdentityStatus];

export const WalletLinkStatus = { ACTIVE: 'ACTIVE', REVOKED: 'REVOKED' } as const;
export type WalletLinkStatus = (typeof WalletLinkStatus)[keyof typeof WalletLinkStatus];

/**
 * A wallet link exists only after a successful proof. TEST_VERIFIED is produced by the
 * development/test verifier and is never presented as a production proof of control.
 */
export const WalletProofStatus = { VERIFIED: 'VERIFIED', TEST_VERIFIED: 'TEST_VERIFIED' } as const;
export type WalletProofStatus = (typeof WalletProofStatus)[keyof typeof WalletProofStatus];

/**
 * Provenance / trust class of every passport field (BRT-04 §11). There is no global "verified".
 *   SELF_DECLARED           written by the athlete (or guardian); not checked by anyone
 *   ACCOUNT_VERIFIED        proven by the account holder's authentication (never public in BRT-04)
 *   ORGANIZATION_CONFIRMED  confirmed by an organization acting through its application permissions
 *   PROOF_OF_CONTROL        cryptographic proof that the person controls a wallet
 *   TEST_PROOF              proof accepted by the development/test verifier only
 *   AUTHORITY_VERIFIED      a sporting fact verified under the BRT Authority Engine (not in BRT-04)
 *   SYSTEM_DERIVED          computed by the platform from other facts
 */
export const Provenance = {
  SELF_DECLARED: 'SELF_DECLARED',
  ACCOUNT_VERIFIED: 'ACCOUNT_VERIFIED',
  ORGANIZATION_CONFIRMED: 'ORGANIZATION_CONFIRMED',
  PROOF_OF_CONTROL: 'PROOF_OF_CONTROL',
  TEST_PROOF: 'TEST_PROOF',
  AUTHORITY_VERIFIED: 'AUTHORITY_VERIFIED',
  SYSTEM_DERIVED: 'SYSTEM_DERIVED',
} as const;
export type Provenance = (typeof Provenance)[keyof typeof Provenance];
