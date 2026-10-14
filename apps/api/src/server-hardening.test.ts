import { createDb } from '@br/persistence';
import { afterAll, describe, expect, it } from 'vitest';
import { failClosedAuth } from './auth';
import { API_HSTS_HEADER, API_SECURITY_HEADERS, buildServer } from './server';

// LAUNCH-02: security headers, CORS stance and readiness failure, without a database. Nothing
// listens on port 1, so every query fails fast.
const unreachable = createDb('postgres://nobody:nothing@127.0.0.1:1/none', { max: 1 });
const app = buildServer({ db: unreachable, auth: () => failClosedAuth, hsts: true });
const plain = buildServer({ db: unreachable, auth: () => failClosedAuth });
afterAll(async () => {
  await Promise.all([app.close(), plain.close()]);
  await unreachable.destroy();
});

describe('API hardening', () => {
  it('/ready fails closed (503) when the database is unreachable; /health stays a liveness probe', async () => {
    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: 'not_ready', reason: 'database_unavailable' });
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('sends the baseline security headers on every response, and HSTS only when enabled', async () => {
    for (const url of ['/health', '/ready', '/v1/does-not-exist']) {
      const res = await app.inject({ method: 'GET', url });
      for (const [name, value] of Object.entries(API_SECURITY_HEADERS))
        expect(res.headers[name], `${url} ${name}`).toBe(value);
      expect(res.headers['strict-transport-security']).toBe(API_HSTS_HEADER);
    }
    const res = await plain.inject({ method: 'GET', url: '/health' });
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('never grants cross-origin browser access (no CORS headers, preflight not answered)', async () => {
    const origin = { origin: 'https://evil.example' };
    const get = await app.inject({ method: 'GET', url: '/health', headers: origin });
    expect(get.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/v1/me',
      headers: { ...origin, 'access-control-request-method': 'POST' },
    });
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    expect(preflight.headers['access-control-allow-methods']).toBeUndefined();
  });

  it('protected routes stay closed under fail-closed auth', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(401);
  });
});
