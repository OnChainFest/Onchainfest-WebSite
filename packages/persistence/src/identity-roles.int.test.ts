import { newId } from '@br/domain';
import { apiDb, maintenanceDb, ownerDb, probeDb, vaultDb, workerDb } from '@br/testkit';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import type { Db } from './db';
import { IdentityStore } from './identity-store';
import { OrganizationStore } from './organization-store';
import { inTransaction, ModuleRole, type ModuleRole as Role } from './tx';

const api = apiDb();
const vault = vaultDb();
const worker = workerDb();
const maintenance = maintenanceDb();
const owner = ownerDb();
const probe = probeDb();
afterAll(async () => {
  await Promise.all([api, vault, worker, maintenance, owner, probe].map((d) => d.destroy()));
});

const DENIED = { code: '42501' };
const setRole = (db: Db, role: string) =>
  db.transaction().execute((trx) => sql`SET LOCAL ROLE ${sql.id(role)}`.execute(trx));
const asRole = (db: Db, role: Role, query: string) =>
  inTransaction(db, role, (ctx) => sql.raw(query).execute(ctx.trx));

describe('BRT-04 PII vault isolation', () => {
  it('only the vault login can become br_identity_private; the vault login can become nothing else', async () => {
    for (const db of [api, worker, maintenance, probe]) {
      await expect(setRole(db, 'br_identity_private')).rejects.toMatchObject(DENIED);
    }
    await expect(setRole(vault, 'br_identity_private')).resolves.toBeDefined();
    for (const role of [
      'br_identity',
      'br_organizations',
      'br_public_read',
      'br_authority',
      'br_results',
      'br_rebuild',
      'br_worker',
      'br_owner',
      'br_api',
    ]) {
      await expect(setRole(vault, role)).rejects.toMatchObject(DENIED);
    }
  });

  it('no runtime module role other than br_identity_private can read the vault', async () => {
    for (const role of [
      ModuleRole.identity,
      ModuleRole.organizations,
      ModuleRole.publicRead,
      ModuleRole.authority,
      ModuleRole.results,
    ]) {
      await expect(
        asRole(api, role, 'SELECT 1 FROM identity_private.person_private LIMIT 1'),
      ).rejects.toMatchObject(DENIED);
    }
    await expect(
      asRole(
        maintenance,
        ModuleRole.rebuild,
        'SELECT 1 FROM identity_private.person_private LIMIT 1',
      ),
    ).rejects.toMatchObject(DENIED);
    await expect(
      asRole(worker, ModuleRole.worker, 'SELECT 1 FROM identity_private.person_private LIMIT 1'),
    ).rejects.toMatchObject(DENIED);
    await expect(
      sql`SELECT 1 FROM identity_private.person_private LIMIT 1`.execute(vault),
    ).rejects.toMatchObject(DENIED); // NOINHERIT
  });

  it('the vault role reaches nothing outside the vault (no identity, org, passport or ledger reads)', async () => {
    for (const table of [
      'identity.person',
      'identity.account',
      'organizations.membership',
      'passport.athlete_card',
      'platform.ledger_entry',
      'platform.outbox_event',
      'authority.principal',
    ]) {
      await expect(
        asRole(vault, ModuleRole.identityPrivate, `SELECT 1 FROM ${table} LIMIT 1`),
      ).rejects.toMatchObject(DENIED);
    }
  });

  it('vault rows cannot be deleted by the vault role (erasure is an explicit nulling update)', async () => {
    await expect(
      asRole(vault, ModuleRole.identityPrivate, 'DELETE FROM identity_private.person_private'),
    ).rejects.toMatchObject(DENIED);
  });
});

describe('BRT-04 public read path', () => {
  it('br_public_read reads the passport projection and public org profile only', async () => {
    await expect(
      asRole(api, ModuleRole.publicRead, 'SELECT 1 FROM passport.athlete_card LIMIT 1'),
    ).resolves.toBeDefined();
    await expect(
      asRole(
        api,
        ModuleRole.publicRead,
        'SELECT 1 FROM organizations.organization_profile LIMIT 1',
      ),
    ).resolves.toBeDefined();
    for (const table of [
      'identity.account',
      'identity.auth_identity',
      'identity.person',
      'identity.athlete_profile',
      'identity.guardian_relationship',
      'identity.external_identity',
      'identity.wallet_link',
      'identity.wallet_link_challenge',
      'organizations.membership',
      'organizations.invitation',
      'platform.audit_event',
      'platform.outbox_event',
      'platform.command_idempotency',
    ]) {
      await expect(
        asRole(api, ModuleRole.publicRead, `SELECT 1 FROM ${table} LIMIT 1`),
      ).rejects.toMatchObject(DENIED);
    }
  });

  it('br_public_read cannot write anything', async () => {
    await expect(
      asRole(api, ModuleRole.publicRead, `DELETE FROM passport.athlete_card`),
    ).rejects.toMatchObject(DENIED);
    await expect(
      asRole(
        api,
        ModuleRole.publicRead,
        `INSERT INTO passport.athlete_slug (slug, athlete_id) VALUES ('evil-slug', '${newId()}')`,
      ),
    ).rejects.toMatchObject(DENIED);
  });
});

describe('BRT-04 context boundaries', () => {
  it('organizations cannot write identity facts; identity cannot write organization facts', async () => {
    await expect(
      asRole(
        api,
        ModuleRole.organizations,
        `INSERT INTO identity.account (id, recorded_at) VALUES ('${newId()}', now())`,
      ),
    ).rejects.toMatchObject(DENIED);
    await expect(
      asRole(
        api,
        ModuleRole.organizations,
        `INSERT INTO identity.external_identity_status_change (id, external_identity_id, status, recorded_at) VALUES ('${newId()}', '${newId()}', 'CONFIRMED', now())`,
      ),
    ).rejects.toMatchObject(DENIED);
    await expect(
      asRole(
        api,
        ModuleRole.identity,
        `INSERT INTO organizations.membership_status_change (id, membership_id, status, recorded_at) VALUES ('${newId()}', '${newId()}', 'ACTIVE', now())`,
      ),
    ).rejects.toMatchObject(DENIED);
  });

  it('organizations may register principals but never grants, anchors or keys', async () => {
    for (const table of [
      'authority.authority_grant',
      'authority.trust_anchor',
      'authority.principal_key',
    ]) {
      await expect(
        asRole(api, ModuleRole.organizations, `INSERT INTO ${table} DEFAULT VALUES`),
      ).rejects.toMatchObject(DENIED);
    }
  });

  it('identity/organization facts and audit events are append-only even for the owner', async () => {
    // Real rows first: row-level triggers do not fire on empty tables.
    const identity = new IdentityStore(api);
    const orgs = new OrganizationStore(api);
    const { accountId } = await identity.signIn({
      provider: 'test',
      providerSubject: `roles-${newId()}`,
      method: 'TEST',
    });
    await identity.createPerson({
      actorAccountId: accountId,
      relation: 'SELF',
      idempotencyKey: newId(),
    });
    const { organizationId } = await orgs.createOrganization({
      actorAccountId: accountId,
      orgType: 'CLUB',
      slug: `roles-${newId().slice(-12)}`,
      profile: { displayName: 'Roles Club' },
      idempotencyKey: newId(),
    });
    const targets = [
      `DELETE FROM identity.account WHERE id = '${accountId}'`,
      `UPDATE identity.auth_identity SET provider_subject = 'x' WHERE account_id = '${accountId}'`,
      `DELETE FROM identity.account_status_change WHERE account_id = '${accountId}'`,
      `UPDATE organizations.organization_slug SET slug = 'stolen-slug' WHERE organization_id = '${organizationId}'`,
      `DELETE FROM organizations.membership_status_change WHERE membership_id IN (SELECT id FROM organizations.membership WHERE organization_id = '${organizationId}')`,
      `DELETE FROM platform.audit_event WHERE actor_account_id = '${accountId}'`,
    ];
    for (const q of targets) {
      await expect(sql.raw(q).execute(owner), q).rejects.toMatchObject({ code: 'BR001' });
    }
  });

  it('runtime roles cannot read the audit log (write-only accountability)', async () => {
    for (const role of [ModuleRole.identity, ModuleRole.organizations]) {
      await expect(
        asRole(api, role, 'SELECT 1 FROM platform.audit_event LIMIT 1'),
      ).rejects.toMatchObject(DENIED);
    }
  });

  it('the maintenance rebuild role cannot write identity or organization facts', async () => {
    await expect(
      asRole(
        maintenance,
        ModuleRole.rebuild,
        `INSERT INTO identity.account (id, recorded_at) VALUES ('${newId()}', now())`,
      ),
    ).rejects.toMatchObject(DENIED);
    await expect(
      asRole(maintenance, ModuleRole.rebuild, 'SELECT 1 FROM identity.auth_identity LIMIT 1'),
    ).rejects.toMatchObject(DENIED);
  });

  it('the probe login sees nothing in the BRT-04 schemas; PUBLIC holds no schema ACL', async () => {
    for (const table of [
      'identity.account',
      'identity_private.person_private',
      'organizations.organization',
      'passport.athlete_card',
    ]) {
      await expect(sql.raw(`SELECT 1 FROM ${table} LIMIT 1`).execute(probe)).rejects.toMatchObject(
        DENIED,
      );
    }
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_namespace n, aclexplode(n.nspacl) a
      WHERE n.nspname IN ('identity', 'identity_private', 'organizations', 'passport') AND a.grantee = 0`.execute(
      owner,
    );
    expect(rows[0]?.n).toBe(0);
  });
});
