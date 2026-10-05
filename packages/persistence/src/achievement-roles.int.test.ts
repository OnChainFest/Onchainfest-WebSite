import { newId } from '@br/domain';
import {
  apiDb,
  maintenanceDb,
  operatorDb,
  ownerDb,
  probeDb,
  vaultDb,
  verificationOperatorDb,
  workerDb,
} from '@br/testkit';
import { achievementOperatorDb, achievementWorkerDb } from '@br/testkit/achievements';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import type { Db } from './db';
import { inTransaction, ModuleRole, type ModuleRole as Role } from './tx';

/** BRT-08 role graph and module isolation, proven with direct SQL on the NORMAL migrated schema. */
const api = apiDb();
const aop = achievementOperatorDb();
const aworker = achievementWorkerDb();
const vop = verificationOperatorDb();
const op = operatorDb();
const worker = workerDb();
const vault = vaultDb();
const maintenance = maintenanceDb();
const owner = ownerDb();
const probe = probeDb();
afterAll(async () => {
  await Promise.all(
    [api, aop, aworker, vop, op, worker, vault, maintenance, owner, probe].map((d) => d.destroy()),
  );
});

const DENIED = { code: '42501' };
const setRole = (db: Db, role: string) =>
  db.transaction().execute((trx) => sql`SET LOCAL ROLE ${sql.id(role)}`.execute(trx));
const asRole = (db: Db, role: Role, stmt: string) =>
  inTransaction(db, role, (ctx) => sql.raw(stmt).execute(ctx.trx), 1);
const u = () => `'${newId()}'::uuid`;

describe('BRT-08 role graph: achievement runtime, rule operator and achievement worker are isolated', () => {
  it('br_api can become br_achievements but never br_achievement_rules', async () => {
    await expect(setRole(api, 'br_achievements')).resolves.toBeDefined();
    await expect(setRole(api, 'br_achievement_rules')).rejects.toMatchObject(DENIED);
  });

  it('br_achievement_operator_app can become br_achievement_rules and nothing else', async () => {
    await expect(setRole(aop, 'br_achievement_rules')).resolves.toBeDefined();
    for (const role of [
      'br_achievements',
      'br_verification',
      'br_verification_policy',
      'br_results',
      'br_competition',
      'br_identity',
      'br_identity_private',
      'br_rebuild',
      'br_catalog',
      'br_owner',
      'br_api',
      'br_worker',
    ])
      await expect(setRole(aop, role), role).rejects.toMatchObject(DENIED);
    const { rows } = await sql<{
      inh: boolean;
      su: boolean;
      cr: boolean;
      db: boolean;
      rls: boolean;
    }>`
      SELECT rolinherit AS inh, rolsuper AS su, rolcreaterole AS cr, rolcreatedb AS db, rolbypassrls AS rls
      FROM pg_roles WHERE rolname IN ('br_achievement_operator_app', 'br_achievement_worker_app') ORDER BY rolname`.execute(
      owner,
    );
    expect(rows).toEqual([
      { inh: false, su: false, cr: false, db: false, rls: false },
      { inh: false, su: false, cr: false, db: false, rls: false },
    ]);
  });

  it('F · br_achievement_worker_app can become br_achievements / br_verification_reader only — never br_verification', async () => {
    await expect(setRole(aworker, 'br_achievements')).resolves.toBeDefined();
    await expect(setRole(aworker, 'br_verification_reader')).resolves.toBeDefined();
    for (const role of [
      'br_verification',
      'br_verification_policy',
      'br_worker',
      'br_achievement_rules',
      'br_results',
      'br_evidence',
      'br_identity_private',
      'br_rebuild',
      'br_owner',
    ])
      await expect(setRole(aworker, role), role).rejects.toMatchObject(DENIED);
  });

  it('br_verification_reader holds SELECT (and read-only EXECUTE) only — no write privilege anywhere', async () => {
    const { rows } = await sql<{ privilege_type: string }>`
      SELECT DISTINCT privilege_type FROM information_schema.role_table_grants WHERE grantee = 'br_verification_reader'`.execute(
      owner,
    );
    expect(rows.map((r) => r.privilege_type)).toEqual(['SELECT']);
    const { rows: members } = await sql<{ role: string }>`
      SELECT r.rolname AS role FROM pg_auth_members a JOIN pg_roles m ON m.oid = a.member JOIN pg_roles r ON r.oid = a.roleid
      WHERE m.rolname = 'br_verification_reader'`.execute(owner);
    expect(members).toEqual([]); // a leaf role: it inherits nothing
  });

  it('G · br_achievements reads exactly verification.run (SELECT) — no other verification grant', async () => {
    const { rows } = await sql<{ table_name: string; privilege_type: string }>`
      SELECT table_name, privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'br_achievements' AND table_schema IN ('verification', 'verification_read') ORDER BY 1, 2`.execute(
      owner,
    );
    expect(rows).toEqual([{ table_name: 'run', privilege_type: 'SELECT' }]);
  });

  it('no other login can become an achievement role', async () => {
    for (const db of [worker, vault, op, vop, maintenance, probe])
      for (const role of ['br_achievements', 'br_achievement_rules'])
        await expect(setRole(db, role), role).rejects.toMatchObject(DENIED);
  });
});

describe('Achievement consumes Verification, never produces it (achievement worker login)', () => {
  const verificationWrites = [
    // B · no VerificationRun
    `INSERT INTO verification.run (id, result_version_id, policy_version_id, policy_binding_id, engine_id, engine_version, assembler_version, snapshot_provenance, evaluated_as_of, snapshot_hash, policy_spec_hash, evidence_bundle_hash, outcome, outcome_hash, trace_hash, evaluation_state, highest_level, recorded_at) VALUES (${u()}, ${u()}, ${u()}, ${u()}, 'x', 'verification-engine/1', 'verification-assembler/1', 'CANONICAL_ASSEMBLY', now(), 'sha256:${'0'.repeat(64)}', 'sha256:${'0'.repeat(64)}', 'sha256:${'0'.repeat(64)}', '{}', 'sha256:${'0'.repeat(64)}', 'sha256:${'0'.repeat(64)}', 'EVALUATED', 'V2', now())`,
    // C · no trace
    `INSERT INTO verification.run_trace (run_id, trace, trace_hash, recorded_at) VALUES (${u()}, '{}', 'sha256:${'0'.repeat(64)}', now())`,
    // D · no policy / version / publication / binding
    `INSERT INTO verification.policy (id, code, name, created_by_account_id, recorded_at) VALUES (${u()}, 'forged-policy', 'x', ${u()}, now())`,
    `INSERT INTO verification.policy_version_status_change (id, policy_version_id, status, actor_account_id, recorded_at) VALUES (${u()}, ${u()}, 'PUBLISHED', ${u()}, now())`,
    `INSERT INTO verification.policy_binding (id, discipline_version_id, policy_version_id, effective_from, actor_account_id, recorded_at) VALUES (${u()}, ${u()}, ${u()}, now(), ${u()}, now())`,
    `DELETE FROM verification_read.current_verification`,
    // E · no canonical Result / Evidence / Attestation / Authority / Competition writes
    `INSERT INTO results.result (id, scope_type, scope_target_id, fact_hash, recorded_at) VALUES (${u()}, 'CONTEST', ${u()}, 'sha256:${'0'.repeat(64)}', now())`,
    `UPDATE evidence.item SET media_type = 'x'`,
    `DELETE FROM attestation.attestation`,
    `UPDATE authority.authority_grant SET effective_to = now()`,
    `UPDATE competition.competition SET recorded_at = now()`,
  ];
  it('B–E · under every role the worker login can assume, all Verification / canonical writes are refused', async () => {
    for (const role of [ModuleRole.achievements, ModuleRole.verificationReader])
      for (const stmt of verificationWrites)
        await expect(
          asRole(aworker, role, stmt),
          `${role}: ${stmt.slice(0, 60)}`,
        ).rejects.toMatchObject(DENIED);
  });

  it('A · the worker login can run its reaction: read verification freshness inputs and achievement facts', async () => {
    await expect(
      asRole(aworker, ModuleRole.verificationReader, 'SELECT count(*) FROM verification.run_trace'),
    ).resolves.toBeDefined();
    await expect(
      asRole(
        aworker,
        ModuleRole.verificationReader,
        'SELECT count(*) FROM attestation.attestation',
      ),
    ).resolves.toBeDefined();
    await expect(
      asRole(aworker, ModuleRole.achievements, 'SELECT count(*) FROM achievement.achievement'),
    ).resolves.toBeDefined();
  });
});

describe('br_achievements: reads exact facts, writes only achievement facts + its read model', () => {
  const writes = [
    `INSERT INTO results.result (id, scope_type, scope_target_id, fact_hash, recorded_at) VALUES (${u()}, 'CONTEST', ${u()}, 'sha256:${'0'.repeat(64)}', now())`,
    `UPDATE verification.run SET highest_level = 'V2'`,
    `INSERT INTO verification.run_trace (run_id, trace, trace_hash, recorded_at) VALUES (${u()}, '{}', 'sha256:${'0'.repeat(64)}', now())`,
    `UPDATE attestation.attestation SET status = 'x'`,
    `DELETE FROM evidence.item`,
    `UPDATE authority.authority_grant SET effective_to = now()`,
    `UPDATE competition.competition SET recorded_at = now()`,
    `UPDATE identity.athlete SET person_id = NULL`,
    `UPDATE sports.discipline_version SET spec = '{}'`,
    `INSERT INTO achievement.rule (id, code, name, achievement_type, created_by_account_id, recorded_at) VALUES (${u()}, 'x-forged', 'x', 'TITLE', ${u()}, now())`,
    `UPDATE achievement.achievement SET holder_id = ${u()}`,
    `DELETE FROM achievement.status_entry`,
    `TRUNCATE achievement.member_credit`,
  ];
  it('cannot write any other module (nor mutate its own canonical facts)', async () => {
    for (const stmt of writes)
      await expect(asRole(api, ModuleRole.achievements, stmt), stmt).rejects.toMatchObject(DENIED);
  });

  it('cannot read PII, evidence, attestations, profiles or private athlete columns', async () => {
    for (const stmt of [
      'SELECT * FROM identity_private.person_private',
      'SELECT person_id FROM identity.athlete',
      'SELECT * FROM identity.athlete_profile',
      'SELECT * FROM identity.auth_identity',
      'SELECT * FROM evidence.item',
      'SELECT * FROM attestation.attestation',
      'SELECT * FROM competition.lineup',
      'SELECT * FROM authority.authority_grant',
      // BRT-08R-F: only the immutable anchor fact columns (id, fact_hash, recognition_scope) for BR133
      'SELECT * FROM authority.trust_anchor',
      'SELECT principal_id FROM authority.trust_anchor',
      'SELECT * FROM authority.trust_anchor_status_change',
      'SELECT * FROM authority.principal',
    ])
      await expect(asRole(api, ModuleRole.achievements, stmt), stmt).rejects.toMatchObject(DENIED);
    await expect(
      asRole(api, ModuleRole.achievements, 'SELECT id FROM identity.athlete LIMIT 1'),
    ).resolves.toBeDefined();
    await expect(
      asRole(
        api,
        ModuleRole.achievements,
        'SELECT id, fact_hash, recognition_scope FROM authority.trust_anchor LIMIT 1',
      ),
    ).resolves.toBeDefined();
  });

  it('br_achievement_rules cannot derive, read results or write Achievements', async () => {
    for (const stmt of [
      'SELECT * FROM results.result_version',
      'SELECT * FROM verification.run',
      `INSERT INTO achievement.status_entry (id, achievement_id, status, support_facts_hash, assessment_provenance, recorded_at) VALUES (${u()}, ${u()}, 'ACTIVE', 'sha256:${'0'.repeat(64)}', 'CANONICAL_ASSEMBLY', now())`,
      'SELECT * FROM achievement.achievement',
      'SELECT * FROM identity.athlete',
    ])
      await expect(asRole(aop, ModuleRole.achievementRules, stmt), stmt).rejects.toMatchObject(
        DENIED,
      );
  });

  it('public read sees only the read model; rebuild cannot write canonical facts', async () => {
    await expect(
      asRole(api, ModuleRole.publicRead, 'SELECT * FROM achievement_read.achievement_card LIMIT 1'),
    ).resolves.toBeDefined();
    await expect(
      asRole(api, ModuleRole.publicRead, 'SELECT * FROM achievement.achievement'),
    ).rejects.toMatchObject(DENIED);
    await expect(
      asRole(maintenance, ModuleRole.rebuild, `DELETE FROM achievement.basis_item`),
    ).rejects.toMatchObject(DENIED);
  });
});

describe('fixture containment: no runtime role can enable REFERENCE_FIXTURE persistence', () => {
  const relax = [
    'ALTER TABLE achievement.achievement DROP CONSTRAINT achievement_canonical_provenance_only',
    'ALTER TABLE achievement.status_entry DROP CONSTRAINT status_entry_canonical_provenance_only',
  ];
  it('br_api / br_achievements / rule operator / achievement worker / maintenance / worker cannot alter the schema', async () => {
    const attempts: [Db, Role][] = [
      [api, ModuleRole.achievements],
      [api, ModuleRole.publicRead],
      [aop, ModuleRole.achievementRules],
      [aworker, ModuleRole.achievements],
      [aworker, ModuleRole.verification],
      [maintenance, ModuleRole.rebuild],
      [worker, ModuleRole.worker],
    ];
    for (const [db, role] of attempts)
      for (const stmt of relax)
        await expect(asRole(db, role, stmt), `${role}: ${stmt}`).rejects.toMatchObject(DENIED);
  });

  it('no SQL function installs an overlay, and no SECURITY DEFINER function was added by BRT-08', async () => {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('achievement', 'achievement_read') AND p.prosecdef`.execute(owner);
    expect(rows[0]?.n).toBe(0);
    const { rows: fx } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.proname ~* '(fixture|overlay)'`.execute(
      owner,
    );
    expect(fx[0]?.n).toBe(0);
  });

  it('achievement tables are owned by the migration owner only', async () => {
    const { rows } = await sql<{ owner: string }>`
      SELECT DISTINCT pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('achievement', 'achievement_read') AND c.relkind IN ('r', 'v')`.execute(
      owner,
    );
    expect(rows).toEqual([{ owner: 'br_owner' }]);
  });
});
