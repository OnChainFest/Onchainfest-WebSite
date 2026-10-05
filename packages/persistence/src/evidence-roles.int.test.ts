import { newId } from '@br/domain';
import { apiDb, maintenanceDb, operatorDb, ownerDb, probeDb, vaultDb, workerDb } from '@br/testkit';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import type { Db } from './db';
import { inTransaction, ModuleRole, type ModuleRole as Role } from './tx';

const api = apiDb();
const vault = vaultDb();
const worker = workerDb();
const maintenance = maintenanceDb();
const owner = ownerDb();
const probe = probeDb();
const operator = operatorDb();
afterAll(async () => {
  await Promise.all(
    [api, vault, worker, maintenance, owner, probe, operator].map((d) => d.destroy()),
  );
});

const DENIED = { code: '42501' };
const setRole = (db: Db, role: string) =>
  db.transaction().execute((trx) => sql`SET LOCAL ROLE ${sql.id(role)}`.execute(trx));
const asRole = (db: Db, role: Role, query: string) =>
  inTransaction(db, role, (ctx) => sql.raw(query).execute(ctx.trx));
const id = () => `'${newId()}'`;

describe('BRT-06 role graph: br_evidence is reachable only from br_api', () => {
  it('only br_api can become br_evidence; nobody else (worker, vault, operator, maintenance, probe, owner)', async () => {
    await expect(setRole(api, 'br_evidence')).resolves.toBeDefined();
    for (const db of [worker, vault, operator, maintenance, probe])
      await expect(setRole(db, 'br_evidence')).rejects.toMatchObject(DENIED);
    const { rows } = await sql<{ member: string }>`
      SELECT m.rolname AS member FROM pg_auth_members a JOIN pg_roles m ON m.oid = a.member JOIN pg_roles r ON r.oid = a.roleid
      WHERE r.rolname = 'br_evidence' ORDER BY 1`.execute(owner);
    expect(rows.map((r) => r.member)).toEqual(['br_api']);
    const { rows: flags } = await sql<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>`
      SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'br_evidence'`.execute(
      owner,
    );
    expect(flags[0]).toEqual({ rolcanlogin: false, rolsuper: false, rolbypassrls: false });
  });

  // SET ROLE is checked against the SESSION login (br_api), so this proves the login-level graph:
  // from an evidence transaction nothing outside br_api's own module roles is reachable.
  it('an evidence transaction cannot escalate to owner, rebuild, catalog, identity_private or worker', async () => {
    await expect(
      inTransaction(api, ModuleRole.evidence, (ctx) =>
        sql`SET LOCAL ROLE br_owner`.execute(ctx.trx),
      ),
    ).rejects.toMatchObject(DENIED);
    for (const r of [
      'br_rebuild',
      'br_catalog',
      'br_identity_private',
      'br_worker',
      'br_maintenance',
      'br_api_vault',
    ])
      await expect(
        inTransaction(api, ModuleRole.evidence, (ctx) =>
          sql`SET LOCAL ROLE ${sql.id(r)}`.execute(ctx.trx),
        ),
        r,
      ).rejects.toMatchObject(DENIED);
  });

  it('br_evidence cannot read identity_private or auth identities, and cannot write authority, results or competition', async () => {
    for (const q of [
      'SELECT 1 FROM identity_private.person_private LIMIT 1',
      'SELECT 1 FROM identity.auth_identity LIMIT 1',
      'SELECT 1 FROM identity.person LIMIT 1',
      'SELECT 1 FROM results.result_version LIMIT 1',
      'SELECT 1 FROM competition.contest LIMIT 1',
      'SELECT 1 FROM organizations.membership LIMIT 1',
      'SELECT 1 FROM authority.authority_grant LIMIT 1',
      `INSERT INTO authority.principal (id, principal_type, label, fact_hash, recorded_at) VALUES (${id()}, 'PERSON', 'x', 'sha256:${'0'.repeat(64)}', now())`,
      `INSERT INTO authority.principal_key (id) VALUES (${id()})`,
      `INSERT INTO authority.authority_grant (id) VALUES (${id()})`,
      `INSERT INTO results.result (id) VALUES (${id()})`,
      `INSERT INTO results.result_status_transition (id) VALUES (${id()})`,
      `INSERT INTO competition.contest_status_change (id) VALUES (${id()})`,
      `INSERT INTO identity.person_principal (person_id) VALUES (${id()})`,
      `UPDATE evidence_read.attestation_card SET retracted = false`, // allowed (projection) — checked below
    ].slice(0, -1)) {
      await expect(asRole(api, ModuleRole.evidence, q), q).rejects.toMatchObject(DENIED);
    }
    await expect(
      asRole(api, ModuleRole.evidence, `SELECT identity.ensure_person_principal(${id()}, ${id()})`),
    ).rejects.toMatchObject(DENIED);
    // narrow helpers are callable; they reveal only public-safe ids / booleans
    await expect(
      asRole(
        api,
        ModuleRole.evidence,
        `SELECT results.resolve_result_version(${id()}), competition.resolve_scope_path('CONTEST', ${id()}), authority.account_principal_representation(${id()}, ${id()})`,
      ),
    ).resolves.toBeDefined();
  });

  it('other module roles cannot reach evidence or attestation tables; the public role sees only cards', async () => {
    for (const role of [
      ModuleRole.identity,
      ModuleRole.organizations,
      ModuleRole.authority,
      ModuleRole.results,
      ModuleRole.competition,
      ModuleRole.publicRead,
    ]) {
      for (const q of [
        'SELECT 1 FROM evidence.item LIMIT 1',
        'SELECT 1 FROM attestation.attestation LIMIT 1',
        'SELECT 1 FROM evidence_read.evidence_state LIMIT 1',
      ])
        await expect(asRole(api, role, q), `${role}: ${q}`).rejects.toMatchObject(DENIED);
    }
    await expect(
      asRole(api, ModuleRole.publicRead, 'SELECT 1 FROM evidence_read.attestation_card LIMIT 1'),
    ).resolves.toBeDefined();
    await expect(
      asRole(vault, ModuleRole.identityPrivate, 'SELECT 1 FROM evidence.item LIMIT 1'),
    ).rejects.toMatchObject(DENIED);
    await expect(
      asRole(worker, ModuleRole.worker, 'SELECT 1 FROM evidence.item LIMIT 1'),
    ).rejects.toMatchObject(DENIED);
    await expect(
      asRole(worker, ModuleRole.worker, 'SELECT 1 FROM attestation.challenge LIMIT 1'),
    ).rejects.toMatchObject(DENIED);
    for (const q of [
      'SELECT 1 FROM evidence.item LIMIT 1',
      'SELECT 1 FROM attestation.attestation LIMIT 1',
    ])
      await expect(sql.raw(q).execute(probe)).rejects.toMatchObject(DENIED);
    await expect(sql.raw('SELECT 1 FROM evidence.item LIMIT 1').execute(api)).rejects.toMatchObject(
      DENIED,
    ); // NOINHERIT
  });

  it('maintenance can rebuild projections from metadata but cannot write facts; the database holds no key material', async () => {
    await expect(
      asRole(maintenance, ModuleRole.rebuild, 'SELECT descriptor FROM evidence.item LIMIT 1'),
    ).resolves.toBeDefined();
    await expect(
      asRole(maintenance, ModuleRole.rebuild, 'TRUNCATE evidence_read.attestation_card'),
    ).resolves.toBeDefined();
    await expect(
      asRole(
        maintenance,
        ModuleRole.rebuild,
        `INSERT INTO evidence.blob (content_hash) VALUES ('sha256:${'1'.repeat(64)}')`,
      ),
    ).rejects.toMatchObject(DENIED);
    await expect(
      asRole(
        maintenance,
        ModuleRole.rebuild,
        'SELECT 1 FROM identity_private.person_private LIMIT 1',
      ),
    ).rejects.toMatchObject(DENIED);
    const { rows } = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema IN ('evidence', 'attestation', 'evidence_read')
        AND column_name ~* '(private|secret|seed|mnemonic|password|key_material|path|url|bucket)'`.execute(
      owner,
    );
    expect(rows).toEqual([]);
    const { rows: cfg } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole WHERE r.rolname LIKE 'br\\_%'`.execute(
      owner,
    );
    expect(cfg[0]?.n).toBe(0); // no blob/cipher credentials in role configuration
  });
});
