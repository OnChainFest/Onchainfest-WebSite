/**
 * Authentication boundary (BRT-04 §4, §34). HTTP handlers depend on AuthContext, never on a
 * vendor SDK. The identity provider is Supabase Auth behind the API's AuthAdapter (ADR-0052);
 * without a configured provider, production fails closed (every authenticated route answers 401).
 */
export type AuthenticationMethod =
  'OIDC' | 'PASSKEY' | 'EMAIL_LINK' | 'PASSWORD' | 'WALLET' | 'TEST';

export interface AuthContext {
  readonly accountId: string;
  readonly authIdentityId: string;
  readonly authenticationMethod: AuthenticationMethod;
  readonly authenticatedAt: Date;
  /** Assurance reported by the provider, if any (e.g. "mfa"). */
  readonly assurance?: string;
  /** Platform-operator capability for INTERNAL endpoints (never derived from org membership). */
  readonly operator?: boolean;
}

/** What an identity provider asserts after authenticating a user. */
export interface ProviderAssertion {
  readonly provider: string;
  readonly providerSubject: string;
  readonly emailVerified?: boolean;
  readonly method: AuthenticationMethod;
}
