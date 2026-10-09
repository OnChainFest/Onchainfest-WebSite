import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AuthContext } from '@br/identity';
import type { IdentityStore } from '@br/persistence';
import type { FastifyRequest } from 'fastify';
import { createSupabaseJwtAuth, supabaseAuthConfigFromEnvironment } from './supabase-auth';

/**
 * Authentication boundary (BRT-04). An adapter turns a request into an AuthContext or null.
 * Identity is ALWAYS (provider, providerSubject) resolved through IdentityStore.signIn — never an
 * account id supplied by the client. Headers such as `X-User-Id` are ignored everywhere.
 */
export interface AuthAdapter {
  readonly id: string;
  authenticate(request: FastifyRequest): Promise<AuthContext | null>;
}

/**
 * Default when no identity provider is configured (BR_AUTH_PROVIDER unset): nobody is
 * authenticated, so every non-PUBLIC endpoint answers 401. Fails closed by construction.
 */
export const failClosedAuth: AuthAdapter = {
  id: 'fail-closed',
  authenticate: () => Promise.resolve(null),
};

// ───────────────────────────── development tokens ─────────────────────────────

const DEV_PREFIX = 'brdev';
export const MIN_DEV_AUTH_SECRET_LENGTH = 32;

interface DevTokenPayload {
  readonly sub: string;
  readonly iat: number;
  readonly exp: number;
  /** Platform operator flag (development only; production operators come from the real IdP). */
  readonly op?: boolean;
}

export interface DevAuthSecretOption {
  /** Explicit HMAC secret (tests, harnesses). Otherwise BR_DEV_AUTH_SECRET is required. */
  readonly secret?: string;
}

/**
 * Resolves the development HMAC secret. There is NO built-in default: it must be injected or set
 * in BR_DEV_AUTH_SECRET (≥ 32 characters, not trivially repetitive). Never in production.
 */
export function resolveDevAuthSecret(option: DevAuthSecretOption = {}): string {
  if (process.env.NODE_ENV === 'production')
    throw new Error('development authentication is not available in production');
  const env = process.env.BR_DEV_AUTH_SECRET;
  const secret = option.secret ?? (env === '' ? undefined : env);
  if (secret === undefined) {
    throw new Error(
      'development authentication needs a secret: set BR_DEV_AUTH_SECRET (e.g. `export BR_DEV_AUTH_SECRET=$(openssl rand -hex 32)`)',
    );
  }
  if (secret.length < MIN_DEV_AUTH_SECRET_LENGTH || new Set(secret).size < 10) {
    throw new Error(
      `BR_DEV_AUTH_SECRET is too weak: use at least ${MIN_DEV_AUTH_SECRET_LENGTH} random characters`,
    );
  }
  return secret;
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(`${DEV_PREFIX}.${body}`).digest('base64url');
}

/** Mints a short-lived development token (CLI, demo and tests only). Refuses production. */
export function mintDevToken(
  subject: string,
  options: DevAuthSecretOption & { operator?: boolean; ttlSeconds?: number; now?: Date } = {},
): string {
  const secret = resolveDevAuthSecret(options);
  if (!/^[A-Za-z0-9._:@-]{1,200}$/.test(subject)) throw new Error('invalid development subject');
  const iat = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const payload: DevTokenPayload = {
    sub: subject,
    iat,
    exp: iat + (options.ttlSeconds ?? 3600),
    ...(options.operator === true ? { op: true } : {}),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${DEV_PREFIX}.${body}.${sign(body, secret)}`;
}

export function verifyDevToken(
  token: string,
  options: DevAuthSecretOption & { now?: Date } = {},
): DevTokenPayload | null {
  const secret = resolveDevAuthSecret(options);
  const now = options.now ?? new Date();
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== DEV_PREFIX) return null;
  const [, body, sig] = parts as [string, string, string];
  const expected = Buffer.from(sign(body, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as DevTokenPayload;
    if (typeof p.sub !== 'string' || typeof p.exp !== 'number' || p.exp * 1000 <= now.getTime())
      return null;
    return p;
  } catch {
    return null;
  }
}

/**
 * Development/test authentication: `Authorization: Bearer brdev.<payload>.<hmac>` mapped to
 * provider `test`. The secret is resolved once at construction (fails closed if absent or weak);
 * constructing it in production throws.
 */
export function createDevTokenAuth(
  identity: IdentityStore,
  option: DevAuthSecretOption = {},
): AuthAdapter {
  const secret = resolveDevAuthSecret(option);
  return {
    id: 'dev-token',
    async authenticate(request) {
      const header = request.headers.authorization;
      if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
      const payload = verifyDevToken(header.slice('Bearer '.length).trim(), { secret });
      if (payload === null) return null;
      const { accountId, authIdentityId } = await identity.signIn({
        provider: 'test',
        providerSubject: payload.sub,
        method: 'TEST',
      });
      return {
        accountId,
        authIdentityId,
        authenticationMethod: 'TEST',
        authenticatedAt: new Date(payload.iat * 1000),
        ...(payload.op === true ? { operator: true } : {}),
      };
    },
  };
}

/**
 * BR_AUTH_PROVIDER=supabase → Supabase access tokens (any environment; ADR-0052). Otherwise:
 * production → fail closed; development → dev tokens only when BR_DEV_AUTH=1, and then
 * BR_DEV_AUTH_SECRET is mandatory (startup fails with an actionable error otherwise).
 * An unknown provider name refuses to start rather than silently failing open or closed.
 */
export function authFromEnvironment(identity: IdentityStore): AuthAdapter {
  const provider = process.env.BR_AUTH_PROVIDER;
  if (provider === 'supabase') {
    return createSupabaseJwtAuth(identity, supabaseAuthConfigFromEnvironment());
  }
  if (provider !== undefined && provider !== '' && provider !== 'none') {
    throw new Error(`unknown BR_AUTH_PROVIDER "${provider}" (expected "supabase" or unset)`);
  }
  if (process.env.NODE_ENV === 'production') return failClosedAuth;
  return process.env.BR_DEV_AUTH === '1' ? createDevTokenAuth(identity) : failClosedAuth;
}
