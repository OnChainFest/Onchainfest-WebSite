import { createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';
import type { AuthenticationMethod } from '@br/identity';
import type { IdentityStore } from '@br/persistence';
import type { AuthAdapter } from './auth';

/**
 * Supabase Auth as the identity provider (ONCF-01, ADR-0052). Supabase only proves WHO the caller
 * is: the access token's `sub` is resolved through IdentityStore.signIn('supabase', sub) to the
 * platform account. Nothing else in the token (user_metadata, app_metadata, email, role names) is
 * ever used for authorization — accounts, persons, athletes, organizations, memberships and roles
 * live in the platform database only.
 *
 * Tokens are verified locally against the project's JWKS (asymmetric ES256/RS256 signing keys).
 * Every verification failure, including an unreachable JWKS endpoint, fails closed (null ⇒ 401 on
 * non-PUBLIC routes); a cookie or token is never trusted without a verified signature.
 */
export const SUPABASE_PROVIDER = 'supabase';

export interface SupabaseAuthConfig {
  /** Project URL, e.g. https://<ref>.supabase.co (no trailing slash needed). */
  readonly projectUrl: string;
  /** Expected `aud` claim. Supabase user sessions use "authenticated". */
  readonly audience?: string;
  /** How long fetched signing keys are reused before a background refresh. */
  readonly jwksTtlSeconds?: number;
  /** Minimum interval between JWKS fetches triggered by unknown `kid`s (flood protection). */
  readonly minRefetchIntervalSeconds?: number;
  readonly clockToleranceSeconds?: number;
}

export type JwksFetcher = (url: string) => Promise<unknown>;

export interface SupabaseAuthOptions {
  /** Injected in tests; defaults to a bounded `fetch`. */
  readonly fetchJwks?: JwksFetcher;
  readonly now?: () => Date;
}

const DEFAULT_AUDIENCE = 'authenticated';
const MAX_TOKEN_LENGTH = 8192;

/** Reads BR_SUPABASE_URL. Production requires https; plain http is accepted only for a local stack. */
export function supabaseAuthConfigFromEnvironment(): SupabaseAuthConfig {
  const raw = process.env.BR_SUPABASE_URL;
  if (raw === undefined || raw === '') {
    throw new Error('BR_AUTH_PROVIDER=supabase needs BR_SUPABASE_URL (https://<ref>.supabase.co)');
  }
  return { projectUrl: normalizeProjectUrl(raw) };
}

export function normalizeProjectUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('BR_SUPABASE_URL is not a valid URL');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('BR_SUPABASE_URL must use https (http is allowed only for a local stack)');
  }
  if (local && process.env.NODE_ENV === 'production') {
    throw new Error('BR_SUPABASE_URL must not point at a local stack in production');
  }
  if (url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new Error('BR_SUPABASE_URL must be a bare project URL');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function supabaseIssuer(projectUrl: string): string {
  return `${projectUrl}/auth/v1`;
}

// ───────────────────────────── signing keys ─────────────────────────────

type SupportedAlg = 'ES256' | 'RS256';

interface SigningKey {
  readonly alg: SupportedAlg;
  readonly key: KeyObject;
}

function keyMatchesAlg(key: KeyObject, alg: SupportedAlg): boolean {
  if (alg === 'ES256') {
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
  }
  return key.asymmetricKeyType === 'rsa' && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048;
}

/** Parses a JWKS document. Symmetric, private, encryption-only or malformed keys are skipped. */
export function parseJwks(doc: unknown): Map<string, SigningKey> {
  const out = new Map<string, SigningKey>();
  if (typeof doc !== 'object' || doc === null) return out;
  const keys = (doc as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) return out;
  for (const jwk of keys as unknown[]) {
    if (typeof jwk !== 'object' || jwk === null) continue;
    const k = jwk as Record<string, unknown>;
    if (typeof k.kid !== 'string' || k.kid === '' || 'd' in k) continue;
    if (k.use !== undefined && k.use !== 'sig') continue;
    const alg: SupportedAlg | undefined =
      k.kty === 'EC' && (k.alg === undefined || k.alg === 'ES256')
        ? 'ES256'
        : k.kty === 'RSA' && (k.alg === undefined || k.alg === 'RS256')
          ? 'RS256'
          : undefined;
    if (alg === undefined) continue;
    try {
      const key = createPublicKey({ key: k as JsonWebKey, format: 'jwk' });
      if (keyMatchesAlg(key, alg)) out.set(k.kid, { alg, key });
    } catch {
      // malformed key material: skip
    }
  }
  return out;
}

async function defaultFetchJwks(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!res.ok) throw new Error(`JWKS fetch failed with ${res.status}`);
  return res.json();
}

/** Caches the project's signing keys; refetches on TTL expiry or (rate-limited) unknown kid. */
class JwksCache {
  private keys = new Map<string, SigningKey>();
  private fetchedAt = -Infinity;
  private lastAttemptAt = -Infinity;
  private inFlight: Promise<void> | undefined;
  private readonly url: string;
  private readonly fetcher: JwksFetcher;
  private readonly ttlMs: number;
  private readonly minRefetchMs: number;
  private readonly now: () => Date;

  constructor(
    url: string,
    fetcher: JwksFetcher,
    ttlMs: number,
    minRefetchMs: number,
    now: () => Date,
  ) {
    this.url = url;
    this.fetcher = fetcher;
    this.ttlMs = ttlMs;
    this.minRefetchMs = minRefetchMs;
    this.now = now;
  }

  async get(kid: string): Promise<SigningKey | undefined> {
    const t = this.now().getTime();
    const stale = t - this.fetchedAt >= this.ttlMs;
    if ((stale || !this.keys.has(kid)) && t - this.lastAttemptAt >= this.minRefetchMs) {
      await this.refresh(t);
    }
    return this.keys.get(kid);
  }

  private refresh(t: number): Promise<void> {
    this.inFlight ??= (async () => {
      this.lastAttemptAt = t;
      try {
        const parsed = parseJwks(await this.fetcher(this.url));
        if (parsed.size > 0) {
          this.keys = parsed;
          this.fetchedAt = t;
        }
      } catch {
        // keep the previous keys; callers fail closed on unknown kids
      } finally {
        this.inFlight = undefined;
      }
    })();
    return this.inFlight;
  }
}

// ───────────────────────────── token verification ─────────────────────────────

export interface VerifiedSupabaseToken {
  readonly subject: string;
  readonly method: AuthenticationMethod;
  readonly authenticatedAt: Date;
  readonly assurance?: string;
}

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Supabase `amr` entries → platform AuthenticationMethod. MFA factors (totp, phone) only raise
 * assurance; the first-factor method is the one recorded. Unknown first factors fail closed.
 */
const AMR_METHODS: Readonly<Record<string, AuthenticationMethod>> = {
  password: 'PASSWORD',
  oauth: 'OIDC',
  'sso/saml': 'OIDC',
  otp: 'EMAIL_LINK',
  magiclink: 'EMAIL_LINK',
  'email/signup': 'EMAIL_LINK',
  email_change: 'EMAIL_LINK',
  invite: 'EMAIL_LINK',
  recovery: 'EMAIL_LINK',
};
const SECOND_FACTORS = new Set(['totp', 'mfa/totp', 'phone', 'mfa/phone', 'mfa/webauthn']);

function firstFactor(amr: unknown): { method: AuthenticationMethod; at?: number } | null {
  if (!Array.isArray(amr)) return null;
  for (const entry of amr as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { method, timestamp } = entry as { method?: unknown; timestamp?: unknown };
    if (typeof method !== 'string' || SECOND_FACTORS.has(method)) continue;
    const mapped = AMR_METHODS[method];
    if (mapped === undefined) return null;
    return typeof timestamp === 'number' ? { method: mapped, at: timestamp } : { method: mapped };
  }
  return null;
}

/** Pure verification of a Supabase user access token. Returns null for any defect. */
export async function verifySupabaseAccessToken(
  token: string,
  ctx: {
    readonly issuer: string;
    readonly audience: string;
    readonly clockToleranceSeconds: number;
    readonly now: Date;
    readonly key: (kid: string) => Promise<SigningKey | undefined>;
  },
): Promise<VerifiedSupabaseToken | null> {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  const header = decodeSegment(h);
  const claims = decodeSegment(p);
  if (header === null || claims === null) return null;
  if (header.alg !== 'ES256' && header.alg !== 'RS256') return null;
  if (header.typ !== undefined && header.typ !== 'JWT') return null;
  if (typeof header.kid !== 'string' || header.crit !== undefined) return null;

  const signingKey = await ctx.key(header.kid);
  if (signingKey === undefined || signingKey.alg !== header.alg) return null;
  const signature = Buffer.from(s, 'base64url');
  const data = Buffer.from(`${h}.${p}`);
  const valid =
    signingKey.alg === 'ES256'
      ? signature.length === 64 &&
        verify('sha256', data, { key: signingKey.key, dsaEncoding: 'ieee-p1363' }, signature)
      : verify('sha256', data, signingKey.key, signature);
  if (!valid) return null;

  const nowS = ctx.now.getTime() / 1000;
  const tol = ctx.clockToleranceSeconds;
  if (claims.iss !== ctx.issuer) return null;
  const aud = claims.aud;
  if (!(aud === ctx.audience || (Array.isArray(aud) && aud.includes(ctx.audience)))) return null;
  if (typeof claims.exp !== 'number' || claims.exp <= nowS - tol) return null;
  if (typeof claims.iat !== 'number' || claims.iat > nowS + tol) return null;
  if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > nowS + tol))
    return null;
  // Only end-user sessions: never the anon/service_role API keys, never anonymous sign-ins.
  if (claims.role !== 'authenticated' || claims.is_anonymous === true) return null;
  const sub = claims.sub;
  if (typeof sub !== 'string' || sub.length === 0 || sub.length > 255) return null;

  const factor = firstFactor(claims.amr);
  if (factor === null) return null;
  return {
    subject: sub,
    method: factor.method,
    authenticatedAt: new Date((factor.at ?? claims.iat) * 1000),
    ...(typeof claims.aal === 'string' ? { assurance: claims.aal } : {}),
  };
}

// ───────────────────────────── adapter ─────────────────────────────

/**
 * AuthAdapter for Supabase user sessions: `Authorization: Bearer <supabase access token>`.
 * The identity resolved is (provider 'supabase', providerSubject = token `sub`).
 */
export function createSupabaseJwtAuth(
  identity: IdentityStore,
  config: SupabaseAuthConfig,
  options: SupabaseAuthOptions = {},
): AuthAdapter {
  const projectUrl = normalizeProjectUrl(config.projectUrl);
  const issuer = supabaseIssuer(projectUrl);
  const now = options.now ?? (() => new Date());
  const cache = new JwksCache(
    `${issuer}/.well-known/jwks.json`,
    options.fetchJwks ?? defaultFetchJwks,
    (config.jwksTtlSeconds ?? 600) * 1000,
    (config.minRefetchIntervalSeconds ?? 30) * 1000,
    now,
  );
  const audience = config.audience ?? DEFAULT_AUDIENCE;
  const clockToleranceSeconds = config.clockToleranceSeconds ?? 30;

  return {
    id: 'supabase-jwt',
    async authenticate(request) {
      const header = request.headers.authorization;
      if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
      let verified: VerifiedSupabaseToken | null;
      try {
        verified = await verifySupabaseAccessToken(header.slice('Bearer '.length).trim(), {
          issuer,
          audience,
          clockToleranceSeconds,
          now: now(),
          key: (kid) => cache.get(kid),
        });
      } catch {
        verified = null;
      }
      if (verified === null) return null;
      const { accountId, authIdentityId } = await identity.signIn({
        provider: SUPABASE_PROVIDER,
        providerSubject: verified.subject,
        method: verified.method,
      });
      return {
        accountId,
        authIdentityId,
        authenticationMethod: verified.method,
        authenticatedAt: verified.authenticatedAt,
        ...(verified.assurance === undefined ? {} : { assurance: verified.assurance }),
      };
    },
  };
}
