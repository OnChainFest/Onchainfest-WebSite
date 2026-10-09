import { newId } from '@br/domain';
import { REFERENCE_POLICY_SPEC } from '@br/verification';
import {
  apiDb,
  maintenanceDb,
  newTestAccount,
  operatorDb,
  ownerDb,
  probeDb,
  seedTestCatalog,
  vaultDb,
  verificationOperatorDb,
  workerDb,
} from '@br/testkit';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CatalogStore } from './catalog-store';
import type { Db } from './db';
import { IdentityStore } from './identity-store';
import { inTransaction, ModuleRole, type ModuleRole as Role } from './tx';
import { VerificationPolicyStore } from './verification-store';

const api = apiDb();
const vop = verificationOperatorDb();
const op = operatorDb();
const worker = workerDb();
const vault = vaultDb();
const maintenance = maintenanceDb();
const owner = ownerDb();
const probe = probeDb();
afterAll(async () => {
  await Promise.all(
    [api, vop, op, worker, vault, maintenance, owner, probe].map((d) => d.destroy()),
  );
});

const DENIED = { code: '42501' };
const setRole = (db: Db, role: string) =>
  db.transaction().execute((trx) => sql`SET LOCAL ROLE ${sql.id(role)}`.execute(trx));
const asRole = (db: Db, role: Role, stmt: string) =>
  inTransaction(db, role, (ctx) => sql.raw(stmt).execute(ctx.trx), 1);
const u = () => `'${newId()}'::uuid`;

describe('BRT-07 role graph: verification runtime and policy operator are isolated', () => {
  it('br_api can become br_verification but never br_verification_policy', async () => {
    await expect(setRole(api, 'br_verification')).resolves.toBeDefined();
    await expect(setRole(api, 'br_verification_policy')).rejects.toMatchObject(DENIED);
  });

  it('br_verification_operator_app can become br_verification_policy and nothing else', async () => {
    await expect(setRole(vop, 'br_verification_policy')).resolves.toBeDefined();
    for (const role of [
      'br_verification',
      'br_evidence',
      'br_results',
      'br_authority',
      'br_competition',
      'br_identity',
      'br_identity_private',
      'br_rebuild',
      'br_catalog',
      'br_owner',
      'br_api',
    ])
      await expect(setRole(vop, role), role).rejects.toMatchObject(DENIED);
    const { rows } = await sql<{
      inh: boolean;
      su: boolean;
      cr: boolean;
      db: boolean;
      rls: boolean;
    }>`
      SELECT rolinherit AS inh, rolsuper AS su, rolcreaterole AS cr, rolcreatedb AS db, rolbypassrls AS rls
      FROM pg_roles WHERE rolname = 'br_verification_operator_app'`.execute(owner);
    expect(rows[0]).toEqual({ inh: false, su: false, cr: false, db: false, rls: false });
  });

  it('no other login can become a verification role (worker, vault, catalog operator, maintenance, probe)', async () => {
    for (const db of [worker, vault, op, maintenance, probe])
      for (const role of ['br_verification', 'br_verification_policy'])
        await expect(setRole(db, role)).rejects.toMatchObject(DENIED);
  });

  it('the module roles are members of nothing (no inherited privileges) and PUBLIC has no access', async () => {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_auth_members a JOIN pg_roles m ON m.oid = a.member
      WHERE m.rolname IN ('br_verification', 'br_verification_policy')`.execute(owner);
    expect(rows[0]!.n).toBe(0);
    const { rows: pub } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM information_schema.table_privileges
      WHERE table_schema IN ('verification', 'verification_read') AND grantee = 'PUBLIC'`.execute(
      owner,
    );
    expect(pub[0]!.n).toBe(0);
    for (const t of ['verification.run', 'verification.policy', 'verification_read.run_summary'])
      await expect(sql.raw(`SELECT 1 FROM ${t} LIMIT 1`).execute(probe)).rejects.toMatchObject(
        DENIED,
      );
  });
});

describe('br_verification: reads narrowly, writes only runs + its read model', () => {
  it('cannot write results, evidence, attestations, authority, competition, identity, catalog or policies', async () => {
    for (const stmt of [
      `INSERT INTO results.result (id, scope_type, scope_target_id, fact_hash, recorded_at) VALUES (${u()}, 'CONTEST', ${u()}, 'sha256:${'0'.repeat(64)}', now())`,
      `UPDATE results.result_version_state SET current_status = 'OFFICIAL'`,
      `DELETE FROM evidence.item`,
      `INSERT INTO attestation.retraction (id) VALUES (${u()})`,
      `INSERT INTO authority.authority_grant (id) VALUES (${u()})`,
      `UPDATE competition.contestant SET participant_id = NULL`,
      `INSERT INTO identity.person_principal (person_id, principal_id, recorded_at) VALUES (${u()}, ${u()}, now())`,
      `INSERT INTO sports.sport (id) VALUES (${u()})`,
      `INSERT INTO verification.policy (id, code, name, created_by_account_id, recorded_at) VALUES (${u()}, 'x-y', 'x', ${u()}, now())`,
      `INSERT INTO verification.policy_binding (id) VALUES (${u()})`,
      `UPDATE verification.run SET highest_level = 'V4'`,
      `DELETE FROM verification.run_trace`,
      `TRUNCATE verification.run`,
    ])
      await expect(asRole(api, ModuleRole.verification, stmt), stmt).rejects.toMatchObject(DENIED);
  });

  it('cannot read PII, auth identities, profiles/names or the vault', async () => {
    for (const t of [
      'identity_private.person_private',
      'identity.auth_identity',
      'identity.account',
      'identity.athlete_profile',
      'identity.person',
      'organizations.organization_profile',
      'competition.competition_profile',
      'competition.team_profile',
      'evidence.blob',
    ])
      await expect(
        asRole(api, ModuleRole.verification, `SELECT 1 FROM ${t} LIMIT 1`),
        t,
      ).rejects.toMatchObject(DENIED);
  });

  it('reads exactly the canonical inputs it needs', async () => {
    for (const t of [
      'results.result_version',
      'results.result_status_transition',
      'evidence.item',
      'evidence.attachment',
      'attestation.attestation',
      'attestation.retraction',
      'authority.authority_grant',
      'authority.trust_anchor',
      'authority.principal_key',
      'competition.participant',
      'competition.team_membership',
      'identity.person_principal',
      'organizations.organization_principal',
      'sports.discipline_version',
      'verification.policy_binding',
    ])
      await expect(
        asRole(api, ModuleRole.verification, `SELECT 1 FROM ${t} LIMIT 1`),
        t,
      ).resolves.toBeDefined();
  });

  it('every verification function is SECURITY INVOKER with a fixed search_path and no PUBLIC EXECUTE', async () => {
    const { rows } = await sql<{
      fn: string;
      secdef: boolean;
      config: string[] | null;
      pub: boolean;
    }>`
      SELECT p.oid::regprocedure::text AS fn, p.prosecdef AS secdef, p.proconfig AS config,
             EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                     WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS pub
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('verification', 'verification_read') ORDER BY 1`.execute(owner);
    expect(rows.map((r) => r.fn)).toEqual([
      'verification.assert_policy_binding()',
      'verification.assert_policy_transition()',
      'verification.assert_run_binding()',
      'verification.assert_trace_binding()',
    ]);
    for (const r of rows) {
      expect(r.secdef, r.fn).toBe(false);
      expect(r.config, r.fn).toEqual(['search_path=pg_catalog, pg_temp']);
      expect(r.pub, r.fn).toBe(false);
    }
  });
});

describe('br_verification_policy: policies and bindings only', () => {
  it('cannot create runs, read canonical sporting facts, PII, or write results / evidence / authority / competition', async () => {
    for (const stmt of [
      `INSERT INTO verification.run (id) VALUES (${u()})`,
      `SELECT 1 FROM verification.run LIMIT 1`,
      `SELECT 1 FROM results.result_version LIMIT 1`,
      `SELECT 1 FROM evidence.item LIMIT 1`,
      `SELECT 1 FROM attestation.attestation LIMIT 1`,
      `SELECT 1 FROM authority.authority_grant LIMIT 1`,
      `SELECT 1 FROM competition.participant LIMIT 1`,
      `SELECT 1 FROM identity_private.person_private LIMIT 1`,
      `SELECT 1 FROM identity.person_principal LIMIT 1`,
      `INSERT INTO sports.sport (id) VALUES (${u()})`,
      `UPDATE verification.policy_version SET version = 2`,
    ])
      await expect(asRole(vop, ModuleRole.verificationPolicy, stmt), stmt).rejects.toMatchObject(
        DENIED,
      );
  });
});

describe('policy facts are immutable, never backdated, and never ambiguous under concurrency', () => {
  const identity = new IdentityStore(api);
  const policies = new VerificationPolicyStore(vop);
  let dv: string;
  let operatorAccountId: string;
  beforeAll(async () => {
    const cat = await seedTestCatalog(identity, new CatalogStore(op));
    dv = cat.running5k;
    operatorAccountId = (await newTestAccount(identity, { withPerson: false, label: 'vop' }))
      .accountId;
  });

  it('versions are append-only for every role (including the owner); a binding cannot be backdated', async () => {
    const { policyId } = await policies.createPolicy({
      operatorAccountId,
      code: `imm-${newId().slice(-8)}`,
      name: 'Immutable',
      idempotencyKey: `i-${newId()}`,
    });
    const v = await policies.createPolicyVersion({
      operatorAccountId,
      policyId,
      spec: REFERENCE_POLICY_SPEC,
      idempotencyKey: `i-${newId()}`,
    });
    await expect(
      sql`UPDATE verification.policy_version SET version = 9 WHERE id = ${v.policyVersionId}`.execute(
        owner,
      ),
    ).rejects.toMatchObject({ code: 'BR001' });
    await expect(
      sql`DELETE FROM verification.policy WHERE id = ${policyId}`.execute(owner),
    ).rejects.toMatchObject({ code: 'BR001' });
    await expect(
      policies.bindPolicy({
        operatorAccountId,
        disciplineVersionId: dv,
        policyVersionId: v.policyVersionId,
        idempotencyKey: `b-${newId()}`,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' }); // DRAFT cannot be bound
    await policies.changeVersionStatus({
      operatorAccountId,
      policyVersionId: v.policyVersionId,
      status: 'PUBLISHED',
    });
    await expect(
      policies.bindPolicy({
        operatorAccountId,
        disciplineVersionId: dv,
        policyVersionId: v.policyVersionId,
        effectiveFrom: new Date(Date.now() - 86_400_000),
        idempotencyKey: `b-${newId()}`,
      }),
    ).rejects.toMatchObject({ code: 'BACKDATING_REJECTED' });
    // and the database refuses it even through direct SQL
    await expect(
      inTransaction(
        vop,
        ModuleRole.verificationPolicy,
        (ctx) =>
          sql`INSERT INTO verification.policy_binding (id, discipline_version_id, policy_version_id, effective_from, actor_account_id, recorded_at)
            VALUES (${newId()}, ${dv}, ${v.policyVersionId}, ${new Date(ctx.txTime.getTime() - 1)}, ${operatorAccountId}, ${ctx.txTime})`.execute(
            ctx.trx,
          ),
        1,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // RETIRED → PUBLISHED is not a transition
    await policies.changeVersionStatus({
      operatorAccountId,
      policyVersionId: v.policyVersionId,
      status: 'RETIRED',
    });
    await expect(
      policies.changeVersionStatus({
        operatorAccountId,
        policyVersionId: v.policyVersionId,
        status: 'PUBLISHED',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('concurrent publications and bindings never create two applicable policies at one instant', async () => {
    const { policyId } = await policies.createPolicy({
      operatorAccountId,
      code: `cc-${newId().slice(-8)}`,
      name: 'Concurrent',
      idempotencyKey: `i-${newId()}`,
    });
    const v = await policies.createPolicyVersion({
      operatorAccountId,
      policyId,
      spec: REFERENCE_POLICY_SPEC,
      idempotencyKey: `i-${newId()}`,
    });
    const pubs = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        policies.changeVersionStatus({
          operatorAccountId,
          policyVersionId: v.policyVersionId,
          status: 'PUBLISHED',
        }),
      ),
    );
    expect(pubs.filter((p) => p.status === 'fulfilled' && p.value.changed)).toHaveLength(1);
    await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        policies.bindPolicy({
          operatorAccountId,
          disciplineVersionId: dv,
          policyVersionId: v.policyVersionId,
          idempotencyKey: `cb-${newId()}`,
        }),
      ),
    );
    const { rows } = await sql<{ n: number; d: number }>`
      SELECT count(*)::int AS n, count(DISTINCT effective_from)::int AS d FROM verification.policy_binding WHERE discipline_version_id = ${dv}`.execute(
      owner,
    );
    expect(rows[0]!.n).toBeGreaterThan(0);
    expect(rows[0]!.d).toBe(rows[0]!.n);
    const { rows: st } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM verification.policy_version_status_change WHERE policy_version_id = ${v.policyVersionId} AND status = 'PUBLISHED'`.execute(
      owner,
    );
    expect(st[0]!.n).toBe(1);
  });
});
