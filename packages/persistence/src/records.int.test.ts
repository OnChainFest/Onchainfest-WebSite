import { newId } from '@br/domain';
import { categorySpec } from '@br/records/fixtures';
import {
  apiDb,
  awaitDbTimePast,
  declaredNoParticipation,
  maintenanceDb,
  newContestResult,
  operatorDb,
  ownerDb,
  personSigner,
  publishPolicy,
  retryOnClockStep,
  seedTestCatalog,
  verificationOperatorDb,
  type TestCatalog,
} from '@br/testkit';
import {
  futureInstant,
  publishRecordCategory,
  recordOperatorDb,
  recordWorkerDb,
} from '@br/testkit/records';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AttestationStore } from './attestation-store';
import { AuthorityStore } from './authority-store';
import { CatalogStore } from './catalog-store';
import {
  CompetitionHierarchyResolver,
  createCompetitionResultLedger,
} from './competition-hierarchy';
import { CompetitionStore } from './competition-store';
import { StructureStore } from './competition-structure-store';
import { IdentityStore } from './identity-store';
import { PrincipalKeyCeremony } from './key-ceremony-store';
import { OrganizationStore } from './organization-store';
import { RecordCategoryStore } from './record-category-store';
import { rebuildRecordReadModels, snapshotRecordReadModels } from './record-projection';
import { RecordPublicReader } from './record-reader';
import { RecordService } from './record-store';
import { VerificationPolicyStore, VerificationService } from './verification-store';

/**
 * BRT-09 CANONICAL PRODUCTION lane on the NORMAL migrated schema. Only real facts: a real ResultVersion
 * with real Performances, a real VerificationRun (V1 at best), real statuses (SUBMITTED), no hold
 * facts, no ratification producer. Honest expected output: ZERO RecordMarks — every blocker explained,
 * every evaluation logged; no fake V3 / V4, no fake RECORD_RATIFIED, no ranking / prize / trophy row.
 */
const AUD = 'bragging-rights:test';
const db = apiDb();
const opDb = operatorDb();
const vopDb = verificationOperatorDb();
const ropDb = recordOperatorDb();
const maint = maintenanceDb();
const owner = ownerDb();
afterAll(async () => {
  await Promise.all([db, opDb, vopDb, ropDb, maint, owner].map((d) => d.destroy()));
});

const identity = new IdentityStore(db);
const categories = new RecordCategoryStore(ropDb);
const records = new RecordService(db);
const verification = new VerificationService(db);
const reader = new RecordPublicReader(db);
const INTERNAL = { internal: true } as const;
let catalog: TestCatalog;
let dvCodes: { sport: string; discipline: string };

beforeAll(async () => {
  catalog = await seedTestCatalog(identity, new CatalogStore(opDb));
  await publishPolicy(
    new VerificationPolicyStore(vopDb),
    catalog.operatorAccountId,
    catalog.timedSingles,
  );
  const { rows } = await sql<{ sport: string; discipline: string }>`
    SELECT s.code AS sport, d.code AS discipline FROM sports.discipline_version v
    JOIN sports.discipline d ON d.id = v.discipline_id JOIN sports.sport s ON s.id = d.sport_id
    WHERE v.id = ${catalog.timedSingles}`.execute(owner);
  dvCodes = rows[0] as { sport: string; discipline: string };
}, 120_000);

const spec = (o: Parameters<typeof categorySpec>[0] = {}) =>
  categorySpec({
    scopeType: 'PLATFORM',
    disciplineVersionId: catalog.timedSingles,
    sportCode: dvCodes.sport,
    effectiveFrom: futureInstant(5),
    ...o,
  });

describe('RecordCategory operator lane (dedicated login; floors; immutability; no backdating)', () => {
  it('creates, versions and publishes; the published spec is immutable even for the owner', async () => {
    const c = await publishRecordCategory(categories, catalog.operatorAccountId, spec());
    expect(c.version).toBe(1);
    await expect(
      sql`UPDATE record.category_version SET spec = '{}'::jsonb WHERE id = ${c.categoryVersionId}`.execute(
        owner,
      ),
    ).rejects.toMatchObject({ code: 'BR001' });
  });

  it('refuses PERSONAL categories, below-floor specs, backdated publication and universe changes', async () => {
    await expect(
      categories.createCategory({
        operatorAccountId: catalog.operatorAccountId,
        code: `p-${newId().slice(-8)}`,
        name: 'personal',
        scopeType: 'PERSONAL',
        idempotencyKey: `p-${newId()}`,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const { categoryId } = await categories.createCategory({
      operatorAccountId: catalog.operatorAccountId,
      code: `c-${newId().slice(-8)}`,
      name: 'competition probe',
      scopeType: 'PLATFORM',
      idempotencyKey: `c-${newId()}`,
    });
    await expect(
      categories.createCategoryVersion({
        operatorAccountId: catalog.operatorAccountId,
        categoryId,
        spec: spec({ minimumVerificationLevel: 'V2' }),
        idempotencyKey: `v-${newId()}`,
      }),
    ).rejects.toMatchObject({ details: { issues: [{ code: 'BELOW_PLATFORM_FLOOR' }] } });
    const past = await categories.createCategoryVersion({
      operatorAccountId: catalog.operatorAccountId,
      categoryId,
      spec: spec({ effectiveFrom: new Date(Date.now() - 86_400_000).toISOString() }),
      idempotencyKey: `v-${newId()}`,
    });
    await expect(
      categories.changeVersionStatus({
        operatorAccountId: catalog.operatorAccountId,
        categoryVersionId: past.categoryVersionId,
        status: 'PUBLISHED',
      }),
    ).rejects.toMatchObject({ code: 'BACKDATING_REJECTED' });
    await expect(
      categories.createCategoryVersion({
        operatorAccountId: catalog.operatorAccountId,
        categoryId,
        spec: spec({ tiePolicy: 'FIRST_ACHIEVED' }),
        idempotencyKey: `v-${newId()}`,
      }),
    ).rejects.toMatchObject({
      details: { issues: [{ code: 'UNIVERSE_CHANGE_REQUIRES_NEW_CATEGORY' }] },
    });
  });

  it('retirement prevents new use; a version cannot be re-published', async () => {
    const c = await publishRecordCategory(categories, catalog.operatorAccountId, spec());
    const r = await categories.changeVersionStatus({
      operatorAccountId: catalog.operatorAccountId,
      categoryVersionId: c.categoryVersionId,
      status: 'RETIRED',
    });
    expect(r.status).toBe('RETIRED');
    await expect(
      categories.changeVersionStatus({
        operatorAccountId: catalog.operatorAccountId,
        categoryVersionId: c.categoryVersionId,
        status: 'PUBLISHED',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });
});

describe('canonical production lane: honest ceiling = ZERO records', () => {
  it('a real, verified (V1) performance matches a published category but every floor is reported unmet', async () => {
    const eff = futureInstant(3);
    const cat = await publishRecordCategory(
      categories,
      catalog.operatorAccountId,
      spec({ effectiveFrom: eff }),
    );
    const w = await newContestResult({
      db,
      identity,
      orgs: new OrganizationStore(db),
      comps: new CompetitionStore(db),
      structure: new StructureStore(db),
      authority: new AuthorityStore(db, { conflictChecker: declaredNoParticipation }),
      ledger: createCompetitionResultLedger(db, { conflictChecker: declaredNoParticipation }),
      resolver: new CompetitionHierarchyResolver(db),
      catalog,
      submitAs: 'ATHLETE_A',
      timed: { winnerMs: '10870', loserMs: '11020', startAfter: eff },
    });
    await awaitDbTimePast(db, eff);
    const [, b] = w.athletes;
    if (b === undefined) throw new Error('athlete');
    const attestations = new AttestationStore(db, { audience: AUD });
    const ceremony = new PrincipalKeyCeremony(db, { audience: AUD });
    const B = await personSigner({ db, ceremony, attestations }, b);
    for (let i = 1; ; i++) {
      try {
        await B.attest(w.resultVersionId, { type: 'RESULT_ACCURATE', polarity: 'AFFIRM' });
        break;
      } catch (err) {
        if ((err as { code?: string }).code !== 'KEY_NOT_VALID' || i >= 4) throw err;
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    await retryOnClockStep(() =>
      verification.evaluate({ actor: INTERNAL, resultVersionId: w.resultVersionId }),
    );
    const out = await records.evaluate({ actor: INTERNAL, resultVersionId: w.resultVersionId });
    const mine = out.evaluations.filter((e) => e.categoryId === cat.categoryId);
    expect(mine).toHaveLength(2); // both performances were evaluated against the category
    for (const e of mine) {
      expect(e.provenance).toBe('CANONICAL_ASSEMBLY');
      expect(e.state).toBe('PENDING_REQUIRED_FACTS');
      expect(e.recordMarkId).toBeUndefined();
      expect(e.blockedBy).toEqual(
        expect.arrayContaining([
          'VERIFICATION_LEVEL_BELOW_REQUIRED',
          'RESULT_STATUS_BELOW_REQUIRED',
          'HOLD_STATE_UNAVAILABLE',
        ]),
      );
    }
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM record.record_mark WHERE category_id = ${cat.categoryId}`.execute(
      owner,
    );
    expect(rows[0]?.n).toBe(0);
    const { rows: logged } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM record.evaluation WHERE category_id = ${cat.categoryId}`.execute(
      owner,
    );
    expect(logged[0]?.n).toBe(2);
    // Idempotent re-evaluation: no duplicate evaluation facts for identical snapshots.
    await records.evaluate({ actor: INTERNAL, resultVersionId: w.resultVersionId });
    const { rows: again } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM record.evaluation WHERE category_id = ${cat.categoryId}`.execute(
      owner,
    );
    expect(again[0]?.n).toBe(2);
    // No ratification can exist: BRT-06 admits no RECORD_RATIFIED / REVIEW_COMPLETED claim at all.
    await expect(
      sql`INSERT INTO attestation.attestation (claim_type) VALUES ('RECORD_RATIFIED')`.execute(
        owner,
      ),
    ).rejects.toBeDefined();
    const current = await reader.current(cat.code);
    expect(current?.status).toBe('NO_CURRENT_RECORD');
    const hof = await reader.hallOfFame({ category: cat.code });
    expect(hof.items).toEqual([]);
    // No BRT-10+ side effects: no ranking / qualification / prize / trophy schema exists.
    const { rows: schemas } = await sql<{ nspname: string }>`
      SELECT nspname FROM pg_namespace WHERE nspname ~ '(ranking|qualification|prize|trophy|payout)'`.execute(
      owner,
    );
    expect(schemas).toEqual([]);
  }, 120_000);

  it('the normal schema refuses fixture provenance and fabricated ratifications at the database', async () => {
    await expect(
      sql`INSERT INTO record.mark_status_entry (id, record_mark_id, status, assessment_provenance, recorded_at)
          VALUES (${newId()}, ${newId()}, 'RATIFIED', 'REFERENCE_FIXTURE', platform.tx_time_ms())`.execute(
        owner,
      ),
    ).rejects.toBeDefined();
    const { rows } = await sql<{ conname: string }>`
      SELECT conname FROM pg_constraint WHERE conname IN ('record_mark_canonical_provenance_only',
        'mark_status_canonical_provenance_only', 'mark_status_canonical_ratification_only',
        'record_evaluation_canonical_provenance_only') ORDER BY conname`.execute(owner);
    expect(rows).toHaveLength(4);
  });

  it('read models rebuild identically through the maintenance login', async () => {
    const before = await snapshotRecordReadModels(db);
    await rebuildRecordReadModels(maint);
    expect(await snapshotRecordReadModels(db)).toEqual(before);
  });
});

describe('BRT-09 role graph: record runtime, category operator and record worker are least-privileged', () => {
  const DENIED = { code: '42501' };
  const setRole = (d: typeof db, role: string) =>
    d.transaction().execute((trx) => sql`SET LOCAL ROLE ${sql.id(role)}`.execute(trx));

  it('br_api can become br_records but never br_record_rules', async () => {
    await expect(setRole(db, 'br_records')).resolves.toBeDefined();
    await expect(setRole(db, 'br_record_rules')).rejects.toMatchObject(DENIED);
  });

  it('br_record_operator_app becomes br_record_rules only; br_record_worker_app becomes br_records / br_verification_reader only', async () => {
    await expect(setRole(ropDb, 'br_record_rules')).resolves.toBeDefined();
    for (const role of [
      'br_records',
      'br_achievements',
      'br_verification',
      'br_results',
      'br_owner',
      'br_api',
    ])
      await expect(setRole(ropDb, role), role).rejects.toMatchObject(DENIED);
    const rw = recordWorkerDb();
    try {
      await expect(setRole(rw, 'br_records')).resolves.toBeDefined();
      await expect(setRole(rw, 'br_verification_reader')).resolves.toBeDefined();
      for (const role of [
        'br_achievements',
        'br_verification',
        'br_evidence',
        'br_authority',
        'br_results',
        'br_competition',
        'br_identity_private',
        'br_record_rules',
        'br_rebuild',
        'br_owner',
      ])
        await expect(setRole(rw, role), role).rejects.toMatchObject(DENIED);
    } finally {
      await rw.destroy();
    }
  });

  it('br_records writes only record facts, record read models and platform plumbing — never achievements, results, verification, evidence, attestations, authority, competition or identity', async () => {
    const { rows } = await sql<{ table_schema: string }>`
      SELECT DISTINCT table_schema FROM information_schema.role_table_grants
      WHERE grantee = 'br_records' AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
      ORDER BY 1`.execute(owner);
    expect(rows.map((r) => r.table_schema)).toEqual(['platform', 'record', 'record_read']);
    const { rows: rr } = await sql<{ table_schema: string }>`
      SELECT DISTINCT table_schema FROM information_schema.role_table_grants
      WHERE grantee = 'br_record_rules' AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
      ORDER BY 1`.execute(owner);
    expect(rr.map((r) => r.table_schema)).toEqual(['platform', 'record', 'record_read']);
    const { rows: rrRead } = await sql<{ table_name: string }>`
      SELECT DISTINCT table_name FROM information_schema.role_table_grants
      WHERE grantee = 'br_record_rules' AND table_schema = 'record_read' AND privilege_type = 'INSERT'`.execute(
      owner,
    );
    expect(rrRead.map((r) => r.table_name)).toEqual(['category_card']);
    const { rows: rrTables } = await sql<{ table_name: string }>`
      SELECT DISTINCT table_name FROM information_schema.role_table_grants
      WHERE grantee = 'br_record_rules' AND table_schema = 'record' AND privilege_type = 'INSERT' ORDER BY 1`.execute(
      owner,
    );
    // The operator can never write a mark, a status (force RATIFIED / CANONICAL) or a projection.
    expect(rrTables.map((r) => r.table_name)).toEqual([
      'category',
      'category_version',
      'category_version_status_change',
    ]);
    const { rows: ach } = await sql<{ privilege_type: string }>`
      SELECT DISTINCT privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'br_achievements' AND table_schema = 'record'`.execute(owner);
    expect(ach.map((r) => r.privilege_type)).toEqual(['SELECT']);
  });

  it('direct SQL: br_records cannot write an Achievement / RECORD_SET link / result / run; br_record_rules cannot force a status', async () => {
    const as = (d: typeof db, role: string, stmt: string) =>
      d.transaction().execute(async (trx) => {
        await sql`SET LOCAL ROLE ${sql.id(role)}`.execute(trx);
        await sql.raw(stmt).execute(trx);
      });
    const u = `'${newId()}'::uuid`;
    for (const stmt of [
      `INSERT INTO achievement.record_basis (achievement_id) VALUES (${u})`,
      `INSERT INTO achievement.achievement (id) VALUES (${u})`,
      `INSERT INTO results.result_version (id) VALUES (${u})`,
      `INSERT INTO verification.run (id) VALUES (${u})`,
      `INSERT INTO attestation.attestation (id) VALUES (${u})`,
    ])
      await expect(as(db, 'br_records', stmt), stmt).rejects.toMatchObject(DENIED);
    await expect(
      as(ropDb, 'br_record_rules', `INSERT INTO record.mark_status_entry (id) VALUES (${u})`),
    ).rejects.toMatchObject(DENIED);
    await expect(
      as(ropDb, 'br_record_rules', `INSERT INTO record.record_mark (id) VALUES (${u})`),
    ).rejects.toMatchObject(DENIED);
  });

  it('no SECURITY DEFINER function exists in the record schemas', async () => {
    const { rows } = await sql<{ proname: string }>`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('record', 'record_read') AND p.prosecdef`.execute(owner);
    expect(rows).toEqual([]);
    const { rows: ach } = await sql<{ proname: string }>`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'achievement' AND p.prosecdef`.execute(owner);
    expect(ach).toEqual([]);
  });

  it('br_public_read reads the record projections only (never canonical mark / ratification rows)', async () => {
    const { rows } = await sql<{ table_schema: string; privilege_type: string }>`
      SELECT DISTINCT table_schema, privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'br_public_read' AND table_schema IN ('record', 'record_read') ORDER BY 1, 2`.execute(
      owner,
    );
    expect(rows).toEqual([{ table_schema: 'record_read', privilege_type: 'SELECT' }]);
  });
});
