import { apiDb } from '@br/testkit';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from './server';

const db = apiDb();
const app = buildServer({ db });
afterAll(async () => {
  await app.close();
  await db.destroy();
});

describe('api scaffold', () => {
  it('GET /health', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });

  it('GET /ready reports a migrated, reachable database', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.json()).toEqual({ status: 'ready' });
    expect(res.statusCode).toBe(200);
  });
});
