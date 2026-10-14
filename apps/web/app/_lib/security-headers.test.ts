import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, securityHeaders } from './security-headers';

describe('apps/web security headers (LAUNCH-02)', () => {
  it('production CSP: same-origin only, no eval, no framing, upgrade to https', () => {
    const csp = contentSecurityPolicy(true);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain('upgrade-insecure-requests');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('ws:');
  });

  it('development relaxes only what the dev server needs', () => {
    const csp = contentSecurityPolicy(false);
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("connect-src 'self' ws:");
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('HSTS only in production; anti-framing and nosniff always', () => {
    const keys = (p: boolean) => securityHeaders(p).map((h) => h.key);
    expect(keys(true)).toContain('Strict-Transport-Security');
    expect(keys(false)).not.toContain('Strict-Transport-Security');
    for (const p of [true, false])
      expect(keys(p)).toEqual(
        expect.arrayContaining([
          'Content-Security-Policy',
          'X-Content-Type-Options',
          'X-Frame-Options',
        ]),
      );
  });
});
