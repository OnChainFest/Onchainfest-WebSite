import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SIGNUP_LIMIT_PER_IP_MAX } from '../apps/web/app/_lib/auth/rate-limit';

// D-P5: the desk-sized sign-up limit is a local-pilot setting only. Staging and production keep
// the default (5 per IP per hour) unless an operator deliberately wires it in.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('D-P5 sign-up limit configuration boundary', () => {
  it('is set only in the local pilot overlay, within the cap', () => {
    const value = /^ {6}AUTH_SIGNUP_LIMIT_PER_IP: '([0-9]+)'$/m.exec(
      read('deploy/local-pilot/compose.yml'),
    )?.[1];
    expect(Number(value)).toBeGreaterThanOrEqual(7);
    expect(Number(value)).toBeLessThanOrEqual(SIGNUP_LIMIT_PER_IP_MAX);
  });

  it('is never set by staging, its env template or the Vercel workflow', () => {
    for (const path of [
      'deploy/staging/compose.yml',
      'deploy/staging/.env.example',
      '.github/workflows/vercel-deploy.yml',
    ])
      expect(read(path), path).not.toContain('AUTH_SIGNUP_LIMIT_PER_IP');
  });

  it('is server-only configuration, never a public build variable', () => {
    expect(read('apps/web/app/_lib/auth/rate-limit.ts')).not.toContain('NEXT_PUBLIC_AUTH_SIGNUP');
  });
});
