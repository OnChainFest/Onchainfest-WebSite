import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  adminDatabaseUrl,
  apiDatabaseUrl,
  databaseUrls,
  devRolePasswords,
  ownerDatabaseUrl,
  productionRolePasswords,
  ROLE_PASSWORD_ENV,
  vaultDatabaseUrl,
  workerDatabaseUrl,
} from './config';

// LAUNCH-02: production processes resolve only the logins they use; production bootstrap needs an
// explicit strong password per login; nothing falls back to a development credential.

afterEach(() => {
  vi.unstubAllEnvs();
});

const ACCESSORS = [
  ['BR_ADMIN_DATABASE_URL', adminDatabaseUrl, 'br_admin'],
  ['BR_OWNER_DATABASE_URL', ownerDatabaseUrl, 'br_owner'],
  ['BR_API_DATABASE_URL', apiDatabaseUrl, 'br_api'],
  ['BR_VAULT_DATABASE_URL', vaultDatabaseUrl, 'br_api_vault'],
  ['BR_WORKER_DATABASE_URL', workerDatabaseUrl, 'br_worker_app'],
] as const;

describe('per-login database URLs', () => {
  it.each(ACCESSORS)('%s is required in production', (name, accessor) => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv(name, '');
    expect(() => accessor()).toThrow(`${name} must be set in production`);
  });

  it.each(ACCESSORS)(
    '%s alone suffices in production (no other login needed)',
    (name, accessor) => {
      vi.stubEnv('NODE_ENV', 'production');
      for (const [other] of ACCESSORS) vi.stubEnv(other, '');
      vi.stubEnv(name, 'postgres://u:p@db.internal:5432/onchainfest');
      expect(accessor()).toBe('postgres://u:p@db.internal:5432/onchainfest');
      // The all-logins resolver still demands every credential, so production entry points avoid it.
      expect(() => databaseUrls()).toThrow(/must be set in production/);
    },
  );

  it.each(ACCESSORS)(
    '%s falls back to the local development login outside production',
    (name, accessor, user) => {
      vi.stubEnv('NODE_ENV', 'test');
      vi.stubEnv(name, '');
      expect(accessor('some_db')).toBe(
        `postgres://${user}:${user}_dev_only@localhost:55432/some_db`,
      );
    },
  );

  it('an explicit URL is retargeted to an explicit database name', () => {
    vi.stubEnv('BR_API_DATABASE_URL', 'postgres://u:p@db.internal:5432/onchainfest');
    expect(apiDatabaseUrl('other_db')).toBe('postgres://u:p@db.internal:5432/other_db');
  });
});

describe('bootstrap role passwords', () => {
  const strong = (role: string) => `${role}-${'x'.repeat(30)}`;

  it('development passwords are refused in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => devRolePasswords()).toThrow(
      'development passwords are not available in production',
    );
  });

  it('production needs every login password except br_probe', () => {
    for (const [role, env] of Object.entries(ROLE_PASSWORD_ENV)) vi.stubEnv(env, strong(role));
    vi.stubEnv('BR_PROBE_PASSWORD', '');
    const passwords = productionRolePasswords();
    expect(Object.keys(passwords).sort()).toEqual(
      Object.keys(ROLE_PASSWORD_ENV)
        .filter((r) => r !== 'br_probe')
        .sort(),
    );
    expect(passwords).not.toHaveProperty('br_probe');
  });

  it('refuses missing, short and development passwords, naming variables but never values', () => {
    for (const [role, env] of Object.entries(ROLE_PASSWORD_ENV)) vi.stubEnv(env, strong(role));
    vi.stubEnv('BR_API_PASSWORD', '');
    vi.stubEnv('BR_WORKER_PASSWORD', 'short-secret');
    vi.stubEnv('BR_OWNER_PASSWORD', 'br_owner_padding_padding_dev_only');
    let message = '';
    try {
      productionRolePasswords();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('BR_API_PASSWORD is not set');
    expect(message).toContain('BR_WORKER_PASSWORD is shorter than 24 characters');
    expect(message).toContain('BR_OWNER_PASSWORD is a development password');
    expect(message).not.toContain('short-secret');
  });
});
