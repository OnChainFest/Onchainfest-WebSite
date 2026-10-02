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

describe('BRT-05R role graph: catalog mutation only through br_operator_app', () => {
  it('1 · br_api cannot SET ROLE br_catalog (but still reaches br_competition)', async () => {
    await expect(setRole(api, 'br_catalog')).rejects.toMatchObject(DENIED);
    await expect(setRole(api, 'br_competition')).resolves.toBeDefined();
    for (const role of [
      'br_identity_private',
      'br_rebuild',
      'br_worker',
      'br_owner',
      'br_operator_app',
    ]) {
      await expect(setRole(api, role)).rejects.toMatchObject(DENIED);
    }
  });

  it('2–7, 11 · br_operator_app can become br_catalog and nothing else (incl. owner/migration)', async () => {
    await expect(setRole(operator, 'br_catalog')).resolves.toBeDefined();
    for (const role of [
      'br_competition',
      'br_authority',
      'br_results',
      'br_identity_private',
      'br_rebuild',
      'br_worker',
      'br_identity',
      'br_organizations',
      'br_public_read',
      'br_owner',
      'br_api',
      'br_maintenance',
    ]) {
      await expect(setRole(operator, role), role).rejects.toMatchObject(DENIED);
    }
  });

  it('8–10 · worker, maintenance, vault and probe cannot SET ROLE br_catalog (or br_competition)', async () => {
    for (const db of [worker, maintenance, vault, probe]) {
      for (const role of ['br_catalog', 'br_competition'])
        await expect(setRole(db, role)).rejects.toMatchObject(DENIED);
    }
  });

  it('the operator login holds no table privileges before assuming br_catalog (NOINHERIT)', async () => {
    for (const table of [
      'sports.sport',
      'sports.discipline_version',
      'competition.event',
      'identity.account',
      'platform.outbox_event',
    ]) {
      await expect(
        sql.raw(`SELECT 1 FROM ${table} LIMIT 1`).execute(operator),
        table,
      ).rejects.toMatchObject(DENIED);
    }
    await expect(
      sql
        .raw(
          `INSERT INTO sports.sport (id, code, name, created_by_account_id, recorded_at) VALUES ('${newId()}', 'x', 'x', '${newId()}', now())`,
        )
        .execute(operator),
    ).rejects.toMatchObject(DENIED);
    const { rows } = await sql<{
      rolinherit: boolean;
      rolsuper: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolbypassrls: boolean;
    }>`
      SELECT rolinherit, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname = 'br_operator_app'`.execute(
      owner,
    );
    expect(rows[0]).toEqual({
      rolinherit: false,
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolbypassrls: false,
    });
  });

  it('12 · PUBLIC has no catalog access at all', async () => {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE table_schema = 'sports' AND grantee = 'PUBLIC'`.execute(
      owner,
    );
    expect(rows[0]?.n).toBe(0);
    const { rows: members } = await sql<{ member: string }>`
      SELECT m.rolname AS member FROM pg_auth_members a JOIN pg_roles m ON m.oid = a.member JOIN pg_roles r ON r.oid = a.roleid
      WHERE r.rolname = 'br_catalog' ORDER BY 1`.execute(owner);
    expect(members.map((m) => m.member)).toEqual(['br_operator_app']);
  });
});

describe('competition writer (br_competition)', () => {
  it('cannot read PII, auth identities or the vault, and cannot write authority facts', async () => {
    for (const table of [
      'identity_private.person_private',
      'identity.auth_identity',
      'identity.wallet_link_challenge',
      'identity.external_identity',
      'platform.audit_event',
    ]) {
      await expect(
        asRole(api, ModuleRole.competition, `SELECT 1 FROM ${table} LIMIT 1`),
      ).rejects.toMatchObject(DENIED);
    }
    for (const table of [
      'authority.authority_grant',
      'authority.trust_anchor',
      'authority.principal',
    ]) {
      await expect(
        asRole(api, ModuleRole.competition, `INSERT INTO ${table} DEFAULT VALUES`),
      ).rejects.toMatchObject(DENIED);
    }
    await expect(
      asRole(api, ModuleRole.competition, 'SELECT 1 FROM authority.authority_grant LIMIT 1'),
    ).rejects.toMatchObject(DENIED);
    await expect(
      asRole(api, ModuleRole.competition, 'SELECT 1 FROM results.result LIMIT 1'),
    ).rejects.toMatchObject(DENIED);
  });

  it('cannot mutate the sport catalog (organizers never redefine rules)', async () => {
    await expect(
      asRole(
        api,
        ModuleRole.competition,
        `INSERT INTO sports.sport (id, code, name, created_by_account_id, recorded_at) VALUES ('${newId()}', 'evil', 'Evil', '${newId()}', now())`,
      ),
    ).rejects.toMatchObject(DENIED);
    await expect(
      asRole(
        api,
        ModuleRole.competition,
        `UPDATE sports.discipline_version SET spec = '{}'::jsonb`,
      ),
    ).rejects.toMatchObject(DENIED);
    await expect(
      asRole(
        api,
        ModuleRole.competition,
        `INSERT INTO sports.discipline_version_status_change (id, discipline_version_id, status, recorded_at) VALUES ('${newId()}', '${newId()}', 'PUBLISHED', now())`,
      ),
    ).rejects.toMatchObject(DENIED);
  });

  it('cannot update or delete append-only competition facts (and neither can the owner)', async () => {
    await expect(
      asRole(api, ModuleRole.competition, 'DELETE FROM competition.event_plan'),
    ).rejects.toThrow();
    for (const table of [
      'competition.event_plan',
      'competition.contestant',
      'competition.registration_status_change',
      'competition.event_seeding',
    ]) {
      await expect(sql.raw(`TRUNCATE ${table} CASCADE`).execute(owner)).rejects.toMatchObject({
        code: 'BR001',
      });
    }
  });
});

describe('catalog writer (br_catalog, via br_operator_app)', () => {
  it('writes only the catalog: no competition, identity, authority or PII access; append-only still applies', async () => {
    await expect(
      asRole(
        operator,
        ModuleRole.catalog,
        `INSERT INTO competition.competition (id, organizer_organization_id, created_by_account_id, recorded_at) VALUES ('${newId()}', '${newId()}', '${newId()}', now())`,
      ),
    ).rejects.toMatchObject(DENIED);
    await expect(
      asRole(operator, ModuleRole.catalog, 'SELECT 1 FROM identity.account LIMIT 1'),
    ).rejects.toMatchObject(DENIED);
    await expect(
      asRole(operator, ModuleRole.catalog, 'SELECT 1 FROM identity_private.person_private LIMIT 1'),
    ).rejects.toMatchObject(DENIED);
    await expect(
      asRole(operator, ModuleRole.catalog, 'SELECT 1 FROM authority.authority_grant LIMIT 1'),
    ).rejects.toMatchObject(DENIED);
    await expect(
      asRole(operator, ModuleRole.catalog, `INSERT INTO authority.principal DEFAULT VALUES`),
    ).rejects.toMatchObject(DENIED);
    await expect(
      asRole(operator, ModuleRole.catalog, 'SELECT 1 FROM competition.event LIMIT 1'),
    ).rejects.toMatchObject(DENIED);
    await expect(
      asRole(operator, ModuleRole.catalog, 'SELECT 1 FROM sports.sport LIMIT 1'),
    ).resolves.toBeDefined();
    await expect(
      asRole(operator, ModuleRole.catalog, 'UPDATE sports.sport SET name = name'),
    ).rejects.toThrow(); // append-only trigger
  });

  it('the normal API login can still READ the catalog (competition / public roles) but never write it', async () => {
    await expect(
      asRole(api, ModuleRole.competition, 'SELECT 1 FROM sports.discipline_version LIMIT 1'),
    ).resolves.toBeDefined();
    await expect(
      asRole(api, ModuleRole.publicRead, 'SELECT 1 FROM sports.format_version LIMIT 1'),
    ).resolves.toBeDefined();
    await expect(asRole(api, ModuleRole.catalog, 'SELECT 1')).rejects.toMatchObject(DENIED);
  });
});

describe('public read path (br_public_read)', () => {
  it('reads catalog and competition projections; cannot write, cannot read canonical operational tables', async () => {
    await expect(
      asRole(api, ModuleRole.publicRead, 'SELECT 1 FROM competition_read.event_summary LIMIT 1'),
    ).resolves.toBeDefined();
    await expect(
      asRole(api, ModuleRole.publicRead, 'SELECT 1 FROM sports.discipline_version LIMIT 1'),
    ).resolves.toBeDefined();
    for (const table of [
      'competition.registration',
      'competition.participant',
      'competition.lineup',
      'competition.competition_staff',
      'competition.team_membership',
    ]) {
      await expect(
        asRole(api, ModuleRole.publicRead, `SELECT 1 FROM ${table} LIMIT 1`),
      ).rejects.toMatchObject(DENIED);
    }
    await expect(
      asRole(api, ModuleRole.publicRead, 'DELETE FROM competition_read.contest_card'),
    ).rejects.toMatchObject(DENIED);
    await expect(
      asRole(
        api,
        ModuleRole.publicRead,
        `INSERT INTO competition_read.competition_slug (slug, competition_id) VALUES ('hijack', '${newId()}')`,
      ),
    ).rejects.toMatchObject(DENIED);
    await expect(
      asRole(
        api,
        ModuleRole.publicRead,
        "SELECT competition.resolve_scope_path('EVENT', gen_random_uuid())",
      ),
    ).rejects.toMatchObject(DENIED);
  });
});

describe('maintenance, probe, vault and owner', () => {
  it('rebuild role reads competition facts but never PII, and cannot write canonical tables', async () => {
    await expect(
      asRole(maintenance, ModuleRole.rebuild, 'SELECT 1 FROM competition.registration LIMIT 1'),
    ).resolves.toBeDefined();
    await expect(
      asRole(
        maintenance,
        ModuleRole.rebuild,
        'SELECT 1 FROM identity_private.person_private LIMIT 1',
      ),
    ).rejects.toMatchObject(DENIED);
    await expect(
      asRole(
        maintenance,
        ModuleRole.rebuild,
        `INSERT INTO competition.event_status_change (id, event_id, status, recorded_at) VALUES ('${newId()}', '${newId()}', 'CANCELLED', now())`,
      ),
    ).rejects.toMatchObject(DENIED);
  });

  it('probe sees nothing; the vault login reaches no competition data; PUBLIC holds no schema ACL', async () => {
    for (const table of [
      'sports.sport',
      'competition.competition',
      'competition_read.competition_card',
    ]) {
      await expect(sql.raw(`SELECT 1 FROM ${table} LIMIT 1`).execute(probe)).rejects.toMatchObject(
        DENIED,
      );
      await expect(
        asRole(vault, ModuleRole.identityPrivate, `SELECT 1 FROM ${table} LIMIT 1`),
      ).rejects.toMatchObject(DENIED);
    }
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_namespace n, aclexplode(n.nspacl) a
      WHERE n.nspname IN ('sports', 'competition', 'competition_read') AND a.grantee = 0`.execute(
      owner,
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('the hierarchy resolver is SECURITY DEFINER with a fixed search_path, executable only by competition/authority/results', async () => {
    const { rows } = await sql<{ secdef: boolean; config: string[] | null; owner: string }>`
      SELECT p.prosecdef AS secdef, p.proconfig AS config, pg_get_userbyid(p.proowner) AS owner
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'competition' AND p.proname = 'resolve_scope_path'`.execute(
      owner,
    );
    expect(rows[0]).toMatchObject({
      secdef: true,
      config: ['search_path=pg_catalog, pg_temp'],
      owner: 'br_owner',
    });
    const { rows: grants } = await sql<{ grantee: string }>`
      SELECT grantee FROM information_schema.routine_privileges
      WHERE routine_schema = 'competition' AND routine_name = 'resolve_scope_path' AND privilege_type = 'EXECUTE' ORDER BY grantee`.execute(
      owner,
    );
    expect(grants.map((g) => g.grantee).filter((g) => g !== 'br_owner')).toEqual([
      // BRT-08: achievement derivation resolves the exact hierarchy of a basis (EXECUTE only).
      'br_achievements',
      'br_authority',
      'br_competition',
      // BRT-06: evidence attachment/bundle hierarchy and metadata-only card rebuilds (EXECUTE only).
      'br_evidence',
      // BRT-10: ranking-run assembly resolves the exact hierarchy of a candidate (EXECUTE only).
      'br_rankings',
      'br_rebuild',
      // BRT-09: record evaluation resolves the exact hierarchy of a performance (EXECUTE only).
      'br_records',
      'br_results',
      // BRT-07: verification snapshots resolve the exact hierarchy (EXECUTE only).
      'br_verification',
      // BRT-08R: the SELECT-only verification reader (achievement freshness), EXECUTE only.
      'br_verification_reader',
    ]);
  });
});
