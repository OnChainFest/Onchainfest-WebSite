import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { IdentityStore } from '@br/persistence';
import { afterEach, describe, expect, it } from 'vitest';
import {
  authFromEnvironment,
  createDevTokenAuth,
  failClosedAuth,
  mintDevToken,
  resolveDevAuthSecret,
  verifyDevToken,
} from './auth';

const STRONG = 'unit-test-dev-auth-secret-0123456789abcdefghij';
const identity = {} as IdentityStore; // construction only resolves the secret
const saved = { ...process.env };
afterEach(() => {
  for (const k of ['NODE_ENV', 'BR_DEV_AUTH', 'BR_DEV_AUTH_SECRET']) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('development authentication has no built-in secret', () => {
  it('BR_DEV_AUTH unset → fail-closed adapter (no tokens accepted)', () => {
    delete process.env.BR_DEV_AUTH;
    expect(authFromEnvironment(identity)).toBe(failClosedAuth);
  });

  it('BR_DEV_AUTH=1 without BR_DEV_AUTH_SECRET → startup fails with an actionable error', () => {
    process.env.BR_DEV_AUTH = '1';
    delete process.env.BR_DEV_AUTH_SECRET;
    expect(() => authFromEnvironment(identity)).toThrow(/BR_DEV_AUTH_SECRET/);
    process.env.BR_DEV_AUTH_SECRET = '';
    expect(() => authFromEnvironment(identity)).toThrow(/BR_DEV_AUTH_SECRET/);
  });

  it('weak secrets are refused (too short or trivially repetitive)', () => {
    for (const weak of ['short', 'a'.repeat(64), 'abababababababababababababababababab']) {
      expect(() => resolveDevAuthSecret({ secret: weak })).toThrow(/too weak/);
    }
    expect(resolveDevAuthSecret({ secret: STRONG })).toBe(STRONG);
  });

  it('minting and verifying require an explicit secret; tokens do not verify under another secret', () => {
    delete process.env.BR_DEV_AUTH_SECRET;
    expect(() => mintDevToken('x')).toThrow(/BR_DEV_AUTH_SECRET/);
    const token = mintDevToken('x', { secret: STRONG });
    expect(verifyDevToken(token, { secret: STRONG })?.sub).toBe('x');
    expect(verifyDevToken(token, { secret: `${STRONG}-other` })).toBeNull();
    process.env.BR_DEV_AUTH_SECRET = STRONG;
    expect(verifyDevToken(token)?.sub).toBe('x');
  });

  it('production refuses development auth even with a strong secret', () => {
    process.env.NODE_ENV = 'production';
    process.env.BR_DEV_AUTH = '1';
    process.env.BR_DEV_AUTH_SECRET = STRONG;
    expect(authFromEnvironment(identity)).toBe(failClosedAuth);
    expect(() => createDevTokenAuth(identity, { secret: STRONG })).toThrow(/production/);
    expect(() => mintDevToken('x', { secret: STRONG })).toThrow(/production/);
  });

  it('the dev-token CLI fails clearly unless development auth is explicitly configured', () => {
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    const run = (env: Record<string, string>) => {
      const base: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !k.startsWith('BR_DEV_AUTH')) base[k] = v;
      }
      return spawnSync(process.execPath, ['--import', 'tsx', 'src/dev-token.ts', 'someone'], {
        cwd,
        env: { ...base, ...env },
        encoding: 'utf8',
      });
    };
    const disabled = run({});
    expect(disabled.status).toBe(2);
    expect(disabled.stderr).toMatch(/BR_DEV_AUTH=1/);
    const noSecret = run({ BR_DEV_AUTH: '1' });
    expect(noSecret.status).toBe(2);
    expect(noSecret.stderr).toMatch(/BR_DEV_AUTH_SECRET/);
    const ok = run({ BR_DEV_AUTH: '1', BR_DEV_AUTH_SECRET: STRONG });
    expect(ok.status).toBe(0);
    expect(ok.stdout.trim()).toMatch(/^brdev\./);
  }, 60_000);
});
