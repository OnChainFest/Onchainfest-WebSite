import { newId } from '@br/domain';
import { categorySpec } from '@br/records/fixtures';
import { CatalogStore, IdentityStore } from '@br/persistence';
import {
  apiDb,
  operatorDb,
  ownerDb,
  seedTestCatalog,
  vaultDb,
  type TestCatalog,
} from '@br/testkit';
import { futureInstant, recordOperatorDb } from '@br/testkit/records';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevTokenAuth, mintDevToken } from './auth';
import { buildServer } from './server';

/**
 * BRT-09 through the real /v1 surface (CANONICAL PRODUCTION lane): category administration on the
 * dedicated operator connection (503 without it; 403 non-operator; 401 forged), closed request
 * schemas (no manual record / ratification path), public record / category / history / Record Hall of
 * Fame DTOs with bounded filters + cursors, and a leak scan of every response and log line.
 */
const SECRET = `record-int-auth-secret-${newId()}`;
const logLines: string[] = [];
const db = apiDb();
const vault = vaultDb();
const owner = ownerDb();
const catalogOperator = operatorDb();
const rop = recordOperatorDb();
const app = buildServer({
  db,
  vaultDb: vault,
  recordOperatorDb: rop,
  auth: (identity: IdentityStore) => createDevTokenAuth(identity, { secret: SECRET }),
  logStream: { write: (line: string) => void logLines.push(line) },
});
const noOperator = buildServer({
  db,
  auth: (identity: IdentityStore) => createDevTokenAuth(identity, { secret: SECRET }),
});
afterAll(async () => {
  await Promise.all([app.close(), noOperator.close()]);
  await Promise.all([db, vault, owner, catalogOperator, rop].map((d) => d.destroy()));
});
const bearer = (sub: string, operator = false) => ({
  authorization: `Bearer ${mintDevToken(sub, { secret: SECRET, operator })}`,
});
const idem = () => ({ 'idempotency-key': `k-${newId()}` });
const bodies: string[] = [];
async function call(
  method: 'GET' | 'POST',
  url: string,
  headers: Record<string, string> = {},
  payload?: unknown,
  server = app,
) {
  const res = await server.inject({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  bodies.push(res.body);
  return { status: res.statusCode, body: res.json() as Record<string, never> };
}

let catalog: TestCatalog;
let sport: string;
beforeAll(async () => {
  catalog = await seedTestCatalog(new IdentityStore(db), new CatalogStore(catalogOperator));
  const { rows } = await sql<{ sport: string }>`
    SELECT s.code AS sport FROM sports.discipline_version v JOIN sports.discipline d ON d.id = v.discipline_id
    JOIN sports.sport s ON s.id = d.sport_id WHERE v.id = ${catalog.timedSingles}`.execute(owner);
  sport = rows[0]?.sport as string;
}, 120_000);

describe('BRT-09 /v1 records', () => {
  it('INTERNAL category administration: operator + dedicated connection; floors enforced; 503 / 403 / 401', async () => {
    const op = bearer(`rop-${newId()}`, true);
    const code = `api-rc-${newId().slice(-8)}`;
    const created = await call(
      'POST',
      '/v1/internal/record-categories',
      { ...op, ...idem() },
      {
        code,
        name: 'Fictional platform 100 m',
        scopeType: 'PLATFORM',
      },
    );
    expect(created.status).toBe(201);
    const spec = categorySpec({
      scopeType: 'PLATFORM',
      disciplineVersionId: catalog.timedSingles,
      sportCode: sport,
      effectiveFrom: futureInstant(5),
    });
    const low = await call(
      'POST',
      `/v1/internal/record-categories/${created.body.categoryId}/versions`,
      { ...op, ...idem() },
      {
        spec: {
          ...spec,
          requirements: { minimumVerificationLevel: 'V1', minimumResultStatus: 'FINAL' },
        },
      },
    );
    expect(low.status).toBe(400);
    expect(JSON.stringify(low.body)).toContain('BELOW_PLATFORM_FLOOR');
    const v = await call(
      'POST',
      `/v1/internal/record-categories/${created.body.categoryId}/versions`,
      { ...op, ...idem() },
      { spec },
    );
    expect(v.status).toBe(201);
    const pub = await call(
      'POST',
      `/v1/internal/record-category-versions/${v.body.categoryVersionId}/publish`,
      op,
      {},
    );
    expect(pub.body.status).toBe('PUBLISHED');
    const personal = await call(
      'POST',
      '/v1/internal/record-categories',
      { ...op, ...idem() },
      {
        code: `p-${newId().slice(-8)}`,
        name: 'p',
        scopeType: 'PERSONAL',
      },
    );
    expect(personal.status).toBe(400);
    const noConn = await call(
      'POST',
      '/v1/internal/record-categories',
      { ...op, ...idem() },
      { code: `x-${newId().slice(-8)}`, name: 'x', scopeType: 'PLATFORM' },
      noOperator,
    );
    const notOp = await call(
      'POST',
      '/v1/internal/record-categories',
      { ...bearer('not-op'), ...idem() },
      { code: `y-${newId().slice(-8)}`, name: 'y', scopeType: 'PLATFORM' },
    );
    const forged = await call(
      'POST',
      '/v1/internal/record-categories',
      { authorization: 'Bearer forged.token', ...idem() },
      { code: `z-${newId().slice(-8)}`, name: 'z', scopeType: 'PLATFORM' },
    );
    expect([noConn.status, notOp.status, forged.status]).toEqual([503, 403, 401]);

    const cat = await call('GET', `/v1/record-categories/${code}`);
    expect(cat.status).toBe(200);
    expect(cat.body.scopeType).toBe('PLATFORM');
    expect(JSON.stringify(cat.body)).not.toMatch(/principalId|registryRef/);
    const current = await call('GET', `/v1/record-categories/${code}/current`);
    expect(current.body.status).toBe('NO_CURRENT_RECORD');
    const history = await call('GET', `/v1/record-categories/${code}/history?limit=5`);
    expect(history.body.items).toEqual([]);
  });

  it('no manual record path: closed bodies, no create / ratify / set-current route', async () => {
    const staff = bearer(`staff-${newId()}`);
    const forced = await call('POST', `/v1/result-versions/${newId()}/record-evaluations`, staff, {
      holderId: newId(),
      value: '1',
      ratified: true,
      force: true,
    });
    expect(forced.status).toBe(400);
    for (const url of [
      '/v1/records',
      '/v1/record-marks',
      `/v1/records/${newId()}/ratify`,
      '/v1/internal/record-marks',
    ])
      expect((await call('POST', url, bearer('x', true), {})).status).toBe(404);
  });

  it('public reads: unknown record 404; Hall of Fame bounded filters + cursor; no filter language', async () => {
    expect((await call('GET', `/v1/records/${newId()}`)).status).toBe(404);
    const hof = await call('GET', '/v1/hall-of-fame/records?scopeType=PLATFORM&limit=10');
    expect(hof.status).toBe(200);
    expect(hof.body.schema).toBe('br:public-record-hall-of-fame@1');
    expect((await call('GET', '/v1/hall-of-fame/records?scopeType=PERSONAL')).status).toBe(400);
    expect((await call('GET', '/v1/hall-of-fame/records?where=1%3D1')).status).toBe(400);
    expect((await call('GET', '/v1/hall-of-fame/records?sort=greatness')).status).toBe(400);
    expect((await call('GET', '/v1/hall-of-fame/records?cursor=%27%3B--')).status).toBe(400);
  });

  it('leak scan: no response or log carries private or authority-topology data', () => {
    const all = [...bodies, ...logLines].join('\n');
    for (const forbidden of [
      /anchorFactHash|anchor_fact_hash|anchorId/,
      /grantId|grantChain|grant_chain/,
      /personId|accountId|account_id/,
      /dateOfBirth|date_of_birth|guardian/i,
      /BEGIN (EC |RSA )?PRIVATE KEY|"d":"/,
      /evidence\/|storage_ref|storageRef/,
    ])
      expect(all).not.toMatch(forbidden);
  });
});
