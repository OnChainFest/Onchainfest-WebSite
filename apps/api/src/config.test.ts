import { describe, expect, it } from 'vitest';
import { ApiConfigError, loadApiRuntimeConfig } from './config';

// LAUNCH-02: the API validates its runtime configuration before opening any connection and refuses
// to start in production when anything required is absent or unsafe (fail closed).

const PRODUCTION = {
  NODE_ENV: 'production',
  BR_API_DATABASE_URL: 'postgres://br_api:secret@db.internal:5432/onchainfest',
  BR_VAULT_DATABASE_URL: 'postgres://br_api_vault:secret@db.internal:5432/onchainfest',
  BR_AUTH_PROVIDER: 'supabase',
  BR_SUPABASE_URL: 'https://project.supabase.example',
  BR_SIGNATURE_AUDIENCE: 'bragging-rights:staging',
  HOST: '0.0.0.0',
  PORT: '8080',
};

function problems(env: NodeJS.ProcessEnv): readonly string[] {
  try {
    loadApiRuntimeConfig(env);
    return [];
  } catch (err) {
    expect(err).toBeInstanceOf(ApiConfigError);
    return (err as ApiConfigError).problems;
  }
}

describe('API runtime configuration', () => {
  it('development defaults: loopback, port 4000, no audience override', () => {
    expect(loadApiRuntimeConfig({})).toEqual({ production: false, host: '127.0.0.1', port: 4000 });
  });

  it('a complete production configuration is accepted', () => {
    expect(loadApiRuntimeConfig(PRODUCTION)).toEqual({
      production: true,
      host: '0.0.0.0',
      port: 8080,
      signatureAudience: 'bragging-rights:staging',
    });
  });

  it.each([
    'BR_API_DATABASE_URL',
    'BR_VAULT_DATABASE_URL',
    'BR_SUPABASE_URL',
    'BR_SIGNATURE_AUDIENCE',
  ])('production refuses a missing %s', (name) => {
    const env = { ...PRODUCTION, [name]: '' };
    expect(problems(env).some((p) => p.startsWith(name))).toBe(true);
  });

  it('production refuses any auth provider but supabase (no fail-open, no dev tokens)', () => {
    expect(problems({ ...PRODUCTION, BR_AUTH_PROVIDER: undefined })).toContain(
      'BR_AUTH_PROVIDER must be "supabase" in production',
    );
    expect(problems({ ...PRODUCTION, BR_AUTH_PROVIDER: 'none' }).length).toBe(1);
  });

  it('production refuses the development signature audience and malformed audiences', () => {
    expect(
      problems({ ...PRODUCTION, BR_SIGNATURE_AUDIENCE: 'bragging-rights:development' }),
    ).toEqual(['BR_SIGNATURE_AUDIENCE must not be the development audience in production']);
    expect(problems({ BR_SIGNATURE_AUDIENCE: 'prod' })).toEqual([
      'BR_SIGNATURE_AUDIENCE must look like bragging-rights:<environment>',
    ]);
  });

  it.each(['BR_DEV_AUTH', 'BR_DEV_AUTH_SECRET', 'BR_VAULT_DEV_KEY', 'BR_EVIDENCE_DEV_KEY'])(
    'production refuses the development-only variable %s instead of ignoring it',
    (name) => {
      expect(problems({ ...PRODUCTION, [name]: 'x' })).toEqual([
        `${name} is development-only and must not be set in production`,
      ]);
    },
  );

  it('rejects an invalid port or empty host in any environment', () => {
    expect(problems({ PORT: '0' })).toEqual(['PORT must be an integer between 1 and 65535']);
    expect(problems({ PORT: '80a' })).toEqual(['PORT must be an integer between 1 and 65535']);
    expect(problems({ HOST: ' ' })).toEqual(['HOST must not be empty']);
  });

  it('reports every problem at once and never echoes a value', () => {
    const err = (() => {
      try {
        loadApiRuntimeConfig({ NODE_ENV: 'production', BR_DEV_AUTH_SECRET: 'super-secret-value' });
      } catch (e) {
        return e as ApiConfigError;
      }
      throw new Error('expected a refusal');
    })();
    expect(err.problems.length).toBeGreaterThanOrEqual(6);
    expect(err.message).not.toContain('super-secret-value');
  });
});
