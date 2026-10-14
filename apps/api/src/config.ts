/**
 * LAUNCH-02 · API runtime configuration, validated once at startup. It fails closed: in production
 * any missing or unsafe value stops the process before it listens. Errors name variables, never
 * their values. Database URLs are resolved per login by @br/persistence (api and vault only), so the
 * API never needs admin, owner, worker or maintenance credentials.
 */
export interface ApiRuntimeConfig {
  readonly production: boolean;
  readonly host: string;
  readonly port: number;
  /** Explicit signature audience (required in production; a distinct value per environment). */
  readonly signatureAudience?: string;
}

export class ApiConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`API configuration refused: ${problems.join('; ')}`);
    this.name = 'ApiConfigError';
    this.problems = problems;
  }
}

/** `bragging-rights:<environment>` (historical prefix, ADR-0051), never the development audience. */
export const SIGNATURE_AUDIENCE_PATTERN = /^bragging-rights:[a-z0-9][a-z0-9-]{1,31}$/;

/** Development-only variables. Production refuses them instead of silently ignoring them. */
export const DEVELOPMENT_ONLY_VARIABLES = [
  'BR_DEV_AUTH',
  'BR_DEV_AUTH_SECRET',
  'BR_VAULT_DEV_KEY',
  'BR_EVIDENCE_DEV_KEY',
  'BR_EVIDENCE_DEV_DIR',
] as const;

export function loadApiRuntimeConfig(env: NodeJS.ProcessEnv = process.env): ApiRuntimeConfig {
  const problems: string[] = [];
  const production = env.NODE_ENV === 'production';
  const set = (name: string) => (env[name] ?? '') !== '';

  const portText = env.PORT ?? '4000';
  const port = Number(portText);
  if (!/^\d{1,5}$/.test(portText) || port < 1 || port > 65535)
    problems.push('PORT must be an integer between 1 and 65535');
  const host = env.HOST ?? '127.0.0.1';
  if (host.trim() === '') problems.push('HOST must not be empty');

  const audience = env.BR_SIGNATURE_AUDIENCE ?? '';
  if (audience !== '' && !SIGNATURE_AUDIENCE_PATTERN.test(audience))
    problems.push('BR_SIGNATURE_AUDIENCE must look like bragging-rights:<environment>');

  if (production) {
    for (const name of ['BR_API_DATABASE_URL', 'BR_VAULT_DATABASE_URL'])
      if (!set(name)) problems.push(`${name} must be set in production`);
    if (env.BR_AUTH_PROVIDER !== 'supabase')
      problems.push('BR_AUTH_PROVIDER must be "supabase" in production');
    if (!set('BR_SUPABASE_URL')) problems.push('BR_SUPABASE_URL must be set in production');
    if (audience === '') problems.push('BR_SIGNATURE_AUDIENCE must be set in production');
    else if (audience === 'bragging-rights:development')
      problems.push('BR_SIGNATURE_AUDIENCE must not be the development audience in production');
    for (const name of DEVELOPMENT_ONLY_VARIABLES)
      if (set(name)) problems.push(`${name} is development-only and must not be set in production`);
  }

  if (problems.length > 0) throw new ApiConfigError(problems);
  return {
    production,
    host,
    port,
    ...(audience === '' ? {} : { signatureAudience: audience }),
  };
}
