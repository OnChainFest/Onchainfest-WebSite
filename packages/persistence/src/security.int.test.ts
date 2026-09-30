import { newId } from '@br/domain';
import { apiDb, maintenanceDb, ownerDb, probeDb, testUrls, workerDb } from '@br/testkit';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { hashEvidenceBytes } from './hashing';
import { openStream, StreamType } from './ledger';
import { inTransaction, ModuleRole, type ModuleRole as Role } from './tx';
import type { Db } from './db';

const api = apiDb();
const worker = workerDb();
const maintenance = maintenanceDb();
const owner = ownerDb();
const probe = probeDb();
afterAll(async () => {
  await Promise.all([api, worker, maintenance, owner, probe].map((d) => d.destroy()));
});

const PERMISSION_DENIED = { code: '42501' };

/** Attempts `SET ROLE` outside inTransaction to test the raw membership graph. */
const setRole = (db: Db, role: string) =>
  db.transaction().execute((trx) => sql`SET LOCAL ROLE ${sql.id(role)}`.execute(trx));

async function oneEntry() {
  return inTransaction(api, ModuleRole.results, async (ctx) => {
    const stream = await openStream(ctx, newId(), StreamType.VERIFICATION);
    const e = await stream.append({
      eventType: 'TEST',
      factTable: 'test.fact',
      factRowId: newId(),
      payloadHash: hashEvidenceBytes(new Uint8Array([1])),
    });
    await stream.close();
    return e;
  });
}

describe('login → module-role graph (BRT-03R least privilege)', () => {
  it('the membership graph is exactly the intended one (no inheritance, no admin option)', async () => {
    const { rows } = await sql<{
      member: string;
      role: string;
      inherit: boolean;
      set: boolean;
      admin: boolean;
    }>`
      SELECT m.rolname AS member, r.rolname AS role, a.inherit_option AS inherit, a.set_option AS set, a.admin_option AS admin
      FROM pg_auth_members a JOIN pg_roles m ON m.oid = a.member JOIN pg_roles r ON r.oid = a.roleid
      WHERE m.rolname LIKE 'br\\_%' AND r.rolname LIKE 'br\\_%'
      ORDER BY 1, 2`.execute(owner);
    expect(rows.filter((r) => r.member !== 'br_runtime')).toEqual([
      { member: 'br_api', role: 'br_authority', inherit: false, set: true, admin: false },
      // BRT-05: competition operations.
      { member: 'br_api', role: 'br_competition', inherit: false, set: true, admin: false },
      // BRT-06: evidence + attestation module.
      { member: 'br_api', role: 'br_evidence', inherit: false, set: true, admin: false },
      { member: 'br_api', role: 'br_identity', inherit: false, set: true, admin: false },
      { member: 'br_api', role: 'br_organizations', inherit: false, set: true, admin: false },
      { member: 'br_api', role: 'br_public_read', inherit: false, set: true, admin: false },
      { member: 'br_api', role: 'br_results', inherit: false, set: true, admin: false },
      // BRT-07: verification runtime (reads canonical facts; writes runs + read model only).
      { member: 'br_api', role: 'br_verification', inherit: false, set: true, admin: false },
      // BRT-04: the PII vault is reachable only through its own login.
      {
        member: 'br_api_vault',
        role: 'br_identity_private',
        inherit: false,
        set: true,
        admin: false,
      },
      { member: 'br_maintenance', role: 'br_rebuild', inherit: false, set: true, admin: false },
      // BRT-05R: catalog mutation has its own login; br_api can no longer reach br_catalog.
      { member: 'br_operator_app', role: 'br_catalog', inherit: false, set: true, admin: false },
      // BRT-07: verification-policy mutation has its own login; br_api cannot reach it.
      {
        member: 'br_verification_operator_app',
        role: 'br_verification_policy',
        inherit: false,
        set: true,
        admin: false,
      },
      { member: 'br_worker_app', role: 'br_worker', inherit: false, set: true, admin: false },
    ]);
  });

  it('API login cannot become the rebuild, worker or owner role', async () => {
    for (const role of ['br_rebuild', 'br_worker', 'br_owner', 'br_maintenance', 'br_worker_app']) {
      await expect(setRole(api, role)).rejects.toMatchObject(PERMISSION_DENIED);
    }
  });

  it('worker login cannot become rebuild, domain or owner roles', async () => {
    for (const role of ['br_rebuild', 'br_authority', 'br_results', 'br_owner', 'br_api']) {
      await expect(setRole(worker, role)).rejects.toMatchObject(PERMISSION_DENIED);
    }
  });

  it('maintenance login can only become br_rebuild', async () => {
    await expect(setRole(maintenance, 'br_rebuild')).resolves.toBeDefined();
    for (const role of ['br_authority', 'br_results', 'br_worker', 'br_owner']) {
      await expect(setRole(maintenance, role)).rejects.toMatchObject(PERMISSION_DENIED);
    }
  });

  it('logins hold no table privileges before assuming a module role (NOINHERIT)', async () => {
    for (const db of [api, worker, maintenance]) {
      await expect(
        sql`SELECT 1 FROM platform.ledger_entry LIMIT 1`.execute(db),
      ).rejects.toMatchObject(PERMISSION_DENIED);
      await expect(
        sql`SELECT 1 FROM results.result_state LIMIT 1`.execute(db),
      ).rejects.toMatchObject(PERMISSION_DENIED);
    }
  });

  it('worker-only privileges are not available to the API login', async () => {
    // job queue writes and outbox consumption receipts belong to br_worker only
    for (const role of [ModuleRole.authority, ModuleRole.results] as Role[]) {
      await expect(
        inTransaction(api, role, (ctx) =>
          sql`INSERT INTO platform.job (id, kind) VALUES (${newId()}, 'x')`.execute(ctx.trx),
        ),
      ).rejects.toMatchObject(PERMISSION_DENIED);
      await expect(
        inTransaction(api, role, (ctx) =>
          sql`INSERT INTO platform.outbox_consumption (consumer, event_id) VALUES ('x', ${newId()})`.execute(
            ctx.trx,
          ),
        ),
      ).rejects.toMatchObject(PERMISSION_DENIED);
    }
  });

  it('the worker cannot write domain ledgers or projections, nor rebuild', async () => {
    await expect(
      inTransaction(worker, ModuleRole.worker, (ctx) =>
        sql`UPDATE results.result_state SET latest_version_number = 1`.execute(ctx.trx),
      ),
    ).rejects.toMatchObject(PERMISSION_DENIED);
    await expect(
      inTransaction(worker, ModuleRole.worker, (ctx) =>
        sql`DELETE FROM results.result_version_state`.execute(ctx.trx),
      ),
    ).rejects.toMatchObject(PERMISSION_DENIED);
    await expect(
      inTransaction(worker, ModuleRole.rebuild, async () => undefined),
    ).rejects.toMatchObject(PERMISSION_DENIED);
  });

  it('rebuild credentials have exactly the maintenance privileges: projections yes, ledgers and authority no', async () => {
    // allowed: rewrite projections (inside a rolled-back transaction, so no state changes)
    await expect(
      maintenance.transaction().execute(async (trx) => {
        await sql`SET LOCAL ROLE br_rebuild`.execute(trx);
        await sql`DELETE FROM results.result_state WHERE false`.execute(trx);
        await sql`SELECT 1 FROM platform.ledger_entry LIMIT 1`.execute(trx);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    const denied = [
      sql`INSERT INTO platform.ledger_entry (id) VALUES (${newId()})`,
      sql`DELETE FROM platform.ledger_entry WHERE false`,
      sql`INSERT INTO platform.outbox_event (id) VALUES (${newId()})`,
      sql`SELECT 1 FROM authority.authority_grant LIMIT 1`,
      sql`INSERT INTO platform.job (id, kind) VALUES (${newId()}, 'x')`,
    ];
    for (const stmt of denied) {
      await expect(
        inTransaction(maintenance, ModuleRole.rebuild, (ctx) => stmt.execute(ctx.trx)),
      ).rejects.toMatchObject(PERMISSION_DENIED);
    }
  });

  it('owner/migration privileges are never available through runtime credentials', async () => {
    for (const db of [api, worker, maintenance]) {
      await expect(
        sql`CREATE TABLE platform.escalation (id int)`.execute(db),
      ).rejects.toMatchObject(PERMISSION_DENIED);
      await expect(sql`CREATE SCHEMA escalation`.execute(db)).rejects.toMatchObject(
        PERMISSION_DENIED,
      );
    }
    for (const role of [ModuleRole.authority, ModuleRole.results] as Role[]) {
      await expect(
        inTransaction(api, role, (ctx) =>
          sql`ALTER TABLE platform.ledger_entry DISABLE TRIGGER ALL`.execute(ctx.trx),
        ),
      ).rejects.toMatchObject(PERMISSION_DENIED);
    }
    expect(testUrls().api).not.toContain('br_owner');
  });
});

describe('append-only ledgers', () => {
  it('module roles cannot UPDATE, DELETE or TRUNCATE ledger entries', async () => {
    const e = await oneEntry();
    const cases: [Db, Role][] = [
      [api, ModuleRole.results],
      [api, ModuleRole.authority],
      [worker, ModuleRole.worker],
      [maintenance, ModuleRole.rebuild],
    ];
    for (const [db, role] of cases) {
      await expect(
        inTransaction(db, role, (ctx) =>
          sql`UPDATE platform.ledger_entry SET event_type = 'X' WHERE id = ${e.id}`.execute(
            ctx.trx,
          ),
        ),
      ).rejects.toMatchObject(PERMISSION_DENIED);
      await expect(
        inTransaction(db, role, (ctx) =>
          sql`DELETE FROM platform.ledger_entry WHERE id = ${e.id}`.execute(ctx.trx),
        ),
      ).rejects.toMatchObject(PERMISSION_DENIED);
      await expect(
        inTransaction(db, role, (ctx) => sql`TRUNCATE platform.ledger_entry`.execute(ctx.trx)),
      ).rejects.toMatchObject(PERMISSION_DENIED);
    }
  });

  it('even the owner role is stopped by append-only triggers', async () => {
    const e = await oneEntry();
    await expect(
      sql`UPDATE platform.ledger_entry SET event_type = 'X' WHERE id = ${e.id}`.execute(owner),
    ).rejects.toMatchObject({ code: 'BR001' });
    await expect(
      sql`DELETE FROM platform.ledger_entry WHERE id = ${e.id}`.execute(owner),
    ).rejects.toMatchObject({ code: 'BR001' });
    await expect(sql`TRUNCATE platform.ledger_entry CASCADE`.execute(owner)).rejects.toMatchObject({
      code: 'BR001',
    });
  });

  it('recordedAt cannot be forged: it must equal the transaction time', async () => {
    await expect(
      inTransaction(api, ModuleRole.results, async (ctx) => {
        await sql`INSERT INTO platform.outbox_event (id, event_type, event_version, aggregate_type, aggregate_id, payload, recorded_at)
                  VALUES (${newId()}, 'X', 1, 'RESULT', ${newId()}, '{}', ${new Date(0)})`.execute(
          ctx.trx,
        );
      }),
    ).rejects.toMatchObject({ code: 'BR002' });
  });

  it('projections are writable only by their owning module role', async () => {
    await expect(
      inTransaction(api, ModuleRole.authority, (ctx) =>
        sql`UPDATE results.result_state SET latest_version_number = 99`.execute(ctx.trx),
      ),
    ).rejects.toMatchObject(PERMISSION_DENIED);
  });
});

describe('unprivileged access', () => {
  it('a connected client without a module role cannot read canonical schemas', async () => {
    for (const table of [
      'platform.ledger_entry',
      'authority.authority_grant',
      'results.result_version',
      'br_migrations.applied',
    ]) {
      await expect(sql.raw(`SELECT 1 FROM ${table} LIMIT 1`).execute(probe)).rejects.toMatchObject(
        PERMISSION_DENIED,
      );
    }
    await expect(setRole(probe, 'br_results')).rejects.toMatchObject(PERMISSION_DENIED);
  });

  it('PUBLIC has no access to the database or its canonical schemas', async () => {
    const { rows } = await sql<{ public_connect: boolean; public_schema_acl: boolean }>`
      SELECT
        EXISTS (SELECT 1 FROM pg_database d, aclexplode(d.datacl) a WHERE d.datname = current_database() AND a.grantee = 0) AS public_connect,
        EXISTS (SELECT 1 FROM pg_namespace n, aclexplode(n.nspacl) a WHERE n.nspname IN ('platform', 'authority', 'results', 'br_migrations') AND a.grantee = 0) AS public_schema_acl`.execute(
      owner,
    );
    expect(rows[0]).toEqual({ public_connect: false, public_schema_acl: false });
  });
});
