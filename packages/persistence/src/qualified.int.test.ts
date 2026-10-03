import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveAchievements,
  referenceQualifiedRule,
  type AchievementRuleSpec,
  type SupportFacts,
} from '@br/achievements';
import {
  qualifiedClassificationFixture,
  qualifiedRankingFixture,
  qualifier,
} from '@br/achievements/fixtures';
import { newId } from '@br/domain';
import { rankCandidate, rankingRunInput, rankingSpec, rkId } from '@br/rankings/fixtures';
import {
  apiDb,
  awaitDbTimePast,
  newOrganizer,
  newTestAccount,
  operatorDb,
  ownerDb,
  seedTestCatalog,
  uniqueSlug,
  type TestCatalog,
} from '@br/testkit';
import { achievementOperatorDb, publishAchievementRule } from '@br/testkit/achievements';
import {
  createQualifiedFixtureDatabase,
  qualificationFixtureSnapshot,
  rankingOperatorDb,
  rankingWorkerDb,
  storedSnapshot,
  type RankingFixtureDatabase,
  type StoredSnapshot,
} from '@br/testkit/rankings';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disciplineFacts } from './achievement-loader';
import { persistDerivation, sweepSupport, type SupportFactSource } from './achievement-lanes';
import { AchievementRuleStore } from './achievement-rule-store';
import {
  AchievementPublicReader,
  AchievementService,
  qualificationIndex,
} from './achievement-store';
import { bootstrapDatabase } from './bootstrap';
import { CatalogStore } from './catalog-store';
import { CompetitionStore } from './competition-store';
import {
  achievementOperatorDatabaseUrl,
  databaseUrls,
  devRolePasswords,
  operatorDatabaseUrl,
  rankingOperatorDatabaseUrl,
  rankingWorkerDatabaseUrl,
} from './config';
import { createDb, type Db } from './db';
import { IdentityStore } from './identity-store';
import { migrate, MIGRATIONS_DIR } from './migrate';
import { OrganizationStore } from './organization-store';
import { RankingDefinitionStore } from './ranking-definition-store';
import { persistRankingRun, publishRankingSnapshot } from './ranking-lanes';
import { RankingService } from './ranking-store';
import { inTransaction, ModuleRole } from './tx';

/**
 * BRT-10 Step 9 — QUALIFIED Achievement (achievement-engine/3, ADR-0050) end to end.
 *
 *   1. migration boundary: 0027 applies to a fresh database WITHOUT 0028 and never names ranking_read;
 *   2. canonical lane (normal schema): every QUALIFIED derivation fails closed with its exact blockers
 *      (no FINAL / V3 / hold / target-authority producer), least privilege, no manual write path;
 *   3. REFERENCE FIXTURE lane (throwaway br_rkfx_ database with the ranking AND achievement
 *      overlays): issuance from a real stored snapshot, threshold, idempotency, one per (rule, holder,
 *      target), immutability under later publications, correction ⇒ supersede / revoke, no side effect.
 */
const k = (p: string) => `${p}-${newId()}`;
const futureIso = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
/** The fixture ranking candidates' holder ids (rankCandidate: rkId(700 + holder)). */
const holderId = (h: number) => rkId(700 + h);
const count = async (db: Db, q: ReturnType<typeof sql<{ n: string }>>) =>
  Number((await q.execute(db)).rows[0]?.n ?? '0');

// ═════════════════════════════ 1. migration boundary (0027 ⟂ 0028) ═════════════════════════════

describe('migration 0027: fresh database before 0028, no ranking_read dependency', () => {
  it('0027 never references ranking_read.*', () => {
    const text = readFileSync(join(MIGRATIONS_DIR, '0027_qualified_achievements.sql'), 'utf8');
    const code = text
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n');
    expect(code).not.toMatch(/ranking_read/);
  });

  it('an existing database (0028 already applied) applies 0027 afterwards', async () => {
    const database = `br_qmig_${randomBytes(6).toString('hex')}`;
    const partial = mkdtempSync(join(tmpdir(), 'br-qmig-'));
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)))
      // Bounded at 0028: the boundary under test is 0027 ↔ 0028 (later migrations apply afterwards).
      if (!f.startsWith('0027') && f < '0029')
        copyFileSync(join(MIGRATIONS_DIR, f), join(partial, f));
    const owner = new URL(databaseUrls().owner);
    owner.pathname = `/${database}`;
    const admin = new pg.Client({ connectionString: databaseUrls().admin });
    try {
      await bootstrapDatabase(databaseUrls().admin, [database], devRolePasswords());
      const first = await migrate(owner.toString(), `${partial}/`);
      expect(first.at(-1)).toBe('0028_ranking_read_models.sql');
      const second = await migrate(owner.toString());
      expect(second[0]).toBe('0027_qualified_achievements.sql');
      expect(second.filter((m) => m < '0029')).toEqual(['0027_qualified_achievements.sql']);
    } finally {
      rmSync(partial, { recursive: true, force: true });
      await admin.connect();
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [database],
      );
      await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(database)}`);
      await admin.end();
    }
  }, 240_000);

  it('a fresh database migrates 0001…0027 without 0028, then applies 0028', async () => {
    const database = `br_qmig_${randomBytes(6).toString('hex')}`;
    const partial = mkdtempSync(join(tmpdir(), 'br-qmig-'));
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)))
      if (f < '0028') copyFileSync(join(MIGRATIONS_DIR, f), join(partial, f));
    const owner = new URL(databaseUrls().owner);
    owner.pathname = `/${database}`;
    const admin = new pg.Client({ connectionString: databaseUrls().admin });
    try {
      await bootstrapDatabase(databaseUrls().admin, [database], devRolePasswords());
      const first = await migrate(owner.toString(), `${partial}/`);
      expect(first.at(-1)).toBe('0027_qualified_achievements.sql');
      expect(first.some((m) => m.startsWith('0028'))).toBe(false);
      const c = new pg.Client({ connectionString: owner.toString() });
      await c.connect();
      try {
        const { rows } = await c.query<{ q: string | null; rr: string | null }>(
          `SELECT to_regclass('achievement.qualification_basis')::text AS q,
                  (SELECT nspname FROM pg_namespace WHERE nspname = 'ranking_read') AS rr`,
        );
        expect(rows[0]).toEqual({ q: 'achievement.qualification_basis', rr: null });
      } finally {
        await c.end();
      }
      const second = await migrate(owner.toString());
      expect(second[0]).toBe('0028_ranking_read_models.sql');
      expect(second.filter((m) => m < '0029')).toEqual(['0028_ranking_read_models.sql']);
    } finally {
      rmSync(partial, { recursive: true, force: true });
      await admin.connect();
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [database],
      );
      await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(database)}`);
      await admin.end();
    }
  }, 240_000);
});

// ═════════════════════════════ 2. canonical lane (normal schema) ═════════════════════════════

describe('canonical lane: QUALIFIED fails closed; least privilege; no manual write', () => {
  const api = apiDb();
  const owner = ownerDb();
  const op = operatorDb();
  const rankOp = rankingOperatorDb();
  const rankWorker = rankingWorkerDb();
  const ruleOp = achievementOperatorDb();
  const identity = new IdentityStore(api);
  const definitions = new RankingDefinitionStore(rankOp);
  const rules = new AchievementRuleStore(ruleOp);
  let catalog: TestCatalog;
  let codes: { sport: string; discipline: string };
  let target: string;

  beforeAll(async () => {
    catalog = await seedTestCatalog(identity, new CatalogStore(op));
    const { rows } = await sql<{ sport: string; discipline: string }>`
      SELECT s.code AS sport, d.code AS discipline FROM sports.discipline_version v
      JOIN sports.discipline d ON d.id = v.discipline_id JOIN sports.sport s ON s.id = d.sport_id
      WHERE v.id = ${catalog.running5k}`.execute(owner);
    codes = rows[0] as { sport: string; discipline: string };
    const org = await newOrganizer(identity, new OrganizationStore(api));
    target = (
      await new CompetitionStore(api).createCompetition({
        actorAccountId: org.ownerAccountId,
        organizerOrganizationId: org.organizationId,
        slug: uniqueSlug('qtarget'),
        profile: { name: 'Fictional Target Championship', timezone: 'UTC' },
        idempotencyKey: k('comp'),
      })
    ).competitionId;
  }, 120_000);
  afterAll(async () => {
    await Promise.all([api, owner, op, rankOp, rankWorker, ruleOp].map((d) => d.destroy()));
  });

  async function platformSystem() {
    const eff = futureIso(2);
    const { systemId } = await definitions.createRankingSystem({
      operatorAccountId: catalog.operatorAccountId,
      code: `rk-${newId().slice(-12)}`,
      name: 'Fictional 5k best marks',
      kind: 'PLATFORM',
      idempotencyKey: k('rs'),
    });
    const v = await definitions.createRankingSystemVersion({
      operatorAccountId: catalog.operatorAccountId,
      systemId,
      spec: rankingSpec({
        universe: {
          disciplineVersionId: catalog.running5k,
          metric: { key: 'elapsedTimeMs', markMetricId: 'running.elapsed_time' },
          resultScope: 'CONTEST',
          holderType: 'ATHLETE',
          population: {},
        },
        recognition: { level: 'PLATFORM', sport: [codes.sport] },
        effectiveFrom: eff,
      }),
      idempotencyKey: k('rsv'),
    });
    await definitions.changeRankingSystemVersionStatus({
      operatorAccountId: catalog.operatorAccountId,
      systemVersionId: v.systemVersionId,
      status: 'PUBLISHED',
    });
    return { systemId, ...v, eff };
  }

  const qualifiedSpec = (s: { systemId: string; systemVersionId: string }, t = target) =>
    referenceQualifiedRule(catalog.running5k, {
      targetCompetitionId: t,
      qualifyingRanks: 8,
      source: {
        kind: 'RANKING_SNAPSHOT_POSITION',
        rankingSystemId: s.systemId,
        rankingSystemVersionId: s.systemVersionId,
      },
    });

  it('a QUALIFIED rule must name a real target and the exact system version of its DisciplineVersion', async () => {
    const s = await platformSystem();
    const { ruleId } = await rules.createRule({
      operatorAccountId: catalog.operatorAccountId,
      code: `q-${newId().slice(-12)}`,
      name: 'Fictional qualification',
      achievementType: 'QUALIFIED',
      idempotencyKey: k('ar'),
    });
    const version = (spec: AchievementRuleSpec) =>
      rules.createRuleVersion({
        operatorAccountId: catalog.operatorAccountId,
        ruleId,
        spec,
        idempotencyKey: k('arv'),
      });
    await expect(version(qualifiedSpec(s, newId()))).rejects.toMatchObject({
      details: { issues: [{ code: 'COMPETITION_UNKNOWN' }] },
    });
    await expect(
      version(qualifiedSpec({ systemId: newId(), systemVersionId: s.systemVersionId })),
    ).rejects.toMatchObject({ details: { issues: [{ code: 'QUALIFYING_SOURCE_MISMATCH' }] } });
    await expect(version(qualifiedSpec(s))).resolves.toMatchObject({ created: true });
  });

  it('production: a canonical ranking run is BLOCKED for QUALIFIED with exact blockers; zero Achievements', async () => {
    const s = await platformSystem();
    await publishAchievementRule(rules, catalog.operatorAccountId, qualifiedSpec(s));
    await awaitDbTimePast(api, s.eff);
    const run = await new RankingService(rankWorker).evaluate({
      systemVersionId: s.systemVersionId,
      asOf: new Date(Date.now() - 500),
      trigger: 'STAFF_REQUEST',
    });
    expect(run).toMatchObject({ provenance: 'CANONICAL_ASSEMBLY', publicationState: 'BLOCKED' });
    const before = await count(
      owner,
      sql`SELECT count(*)::text AS n FROM achievement.qualification_basis`,
    );
    const out = await new AchievementService(api).deriveQualification({
      actor: { internal: true },
      source: { kind: 'RANKING_RUN', runId: run.runId },
    });
    expect(out.rules).toHaveLength(1);
    const [report] = out.rules;
    expect(report).toMatchObject({
      achievementType: 'QUALIFIED',
      state: 'BLOCKED',
      provenance: 'CANONICAL_ASSEMBLY',
    });
    expect(report?.blockedBy).toEqual(
      expect.arrayContaining([
        'RANKING_SNAPSHOT_NOT_PUBLISHED',
        'HOLD_STATE_UNAVAILABLE',
        'TARGET_QUALIFICATION_AUTHORITY_UNAVAILABLE',
      ]),
    );
    expect(report?.achievements).toEqual([]);
    expect(
      await count(owner, sql`SELECT count(*)::text AS n FROM achievement.qualification_basis`),
    ).toBe(before);
    expect(
      await count(
        owner,
        sql`SELECT count(*)::text AS n FROM achievement.achievement WHERE achievement_type = 'QUALIFIED'`,
      ),
    ).toBe(0);
    // Ranking sources are INTERNAL-only; an unknown source is NOT_FOUND, never a guess.
    const staff = await newTestAccount(identity, { withPerson: false, label: 'q-staff' });
    await expect(
      new AchievementService(api).deriveQualification({
        actor: { accountId: staff.accountId },
        source: { kind: 'RANKING_RUN', runId: run.runId },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      new AchievementService(api).deriveQualification({
        actor: { internal: true },
        source: { kind: 'CLASSIFICATION', resultVersionId: newId() },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  }, 120_000);

  it('fixture provenance and forged "canonical" QUALIFIED snapshots never reach the normal schema', async () => {
    await expect(persistDerivation(api, { snapshot: qualifiedRankingFixture() })).rejects.toThrow();
    await expect(
      persistDerivation(api, {
        snapshot: { ...qualifiedRankingFixture(), provenance: 'CANONICAL_ASSEMBLY' },
      }),
    ).rejects.toMatchObject({ details: { reason: 'CANONICAL_SNAPSHOT_MISMATCH' } });
  });

  it('least privilege: no PUBLIC grant, no SECURITY DEFINER, runtime read-only on ranking / results', async () => {
    const { rows: pub } = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM information_schema.role_table_grants
      WHERE grantee = 'PUBLIC' AND table_schema = 'achievement'`.execute(owner);
    expect(pub[0]?.n).toBe('0');
    const { rows: definer } = await sql<{ proname: string }>`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'achievement' AND p.prosecdef`.execute(owner);
    expect(definer).toEqual([]);
    const { rows: execs } = await sql<{ ok: boolean }>`
      SELECT bool_or(has_function_privilege('public', p.oid, 'EXECUTE')) AS ok FROM pg_proc p
      WHERE p.proname IN ('assert_qualification_basis', 'assert_qualified_complete', 'assert_qualified_single')`.execute(
      owner,
    );
    expect(execs[0]?.ok).toBe(false);
    const priv = async (role: string, table: string, p: string) =>
      (
        await sql<{
          ok: boolean;
        }>`SELECT has_table_privilege(${role}, ${table}, ${p}) AS ok`.execute(owner)
      ).rows[0]?.ok;
    expect(await priv('br_achievements', 'achievement.qualification_basis', 'INSERT')).toBe(true);
    for (const p of ['UPDATE', 'DELETE', 'TRUNCATE'])
      expect(await priv('br_achievements', 'achievement.qualification_basis', p)).toBe(false);
    for (const t of [
      'ranking.snapshot',
      'ranking.snapshot_entry',
      'ranking.run',
      'results.classification_derivation',
    ])
      for (const p of ['INSERT', 'UPDATE', 'DELETE'])
        expect(await priv('br_achievements', t, p)).toBe(false);
    expect(await priv('br_public_read', 'achievement.qualification_basis', 'SELECT')).toBe(false);
    expect(await priv('br_rankings', 'achievement.qualification_basis', 'INSERT')).toBe(false);
  });

  it('no manual write: raw inserts of a QUALIFIED Achievement or link are refused; the link is append-only', async () => {
    await expect(
      inTransaction(api, ModuleRole.achievements, (ctx) =>
        sql`INSERT INTO achievement.qualification_basis
              (achievement_id, rule_id, holder_type, holder_id, target_competition_id, basis_kind, qualifying_ranks,
               rank, tied, classification_version_id, classification_content_hash, classification_policy_version_id,
               basis_hash, target_adoption_id, target_adoption_hash, provenance, recorded_at)
            VALUES (${newId()}, ${newId()}, 'ATHLETE', ${newId()}, ${target}, 'CLASSIFICATION_POSITION', 3, 1, false,
                    ${newId()}, ${`sha256:${'1'.repeat(64)}`}, ${newId()}, ${`sha256:${'2'.repeat(64)}`}, ${newId()},
                    ${`sha256:${'3'.repeat(64)}`}, 'CANONICAL_ASSEMBLY', ${ctx.txTime})`.execute(
          ctx.trx,
        ),
      ),
    ).rejects.toThrow();
    // A forged canonical QUALIFIED Achievement row: refused before any link can follow.
    await expect(
      inTransaction(api, ModuleRole.achievements, (ctx) =>
        sql`INSERT INTO achievement.achievement
              (id, identity_hash, candidate_hash, candidate, achievement_type, rule_id, rule_version_id, engine_version,
               holder_type, holder_id, scope_type, scope_id, competition_id, discipline_version_id, basis_level,
               evidence_commitment, snapshot_provenance, derivation_snapshot_hash, derivation_outcome_hash, recorded_at)
            VALUES (${newId()}, ${`sha256:${'4'.repeat(64)}`}, ${`sha256:${'5'.repeat(64)}`}, '{"achievementType":"QUALIFIED"}'::jsonb,
                    'QUALIFIED', ${newId()}, ${newId()}, 'achievement-engine/3', 'ATHLETE', ${newId()}, 'COMPETITION',
                    ${target}, ${target}, ${catalog.running5k}, 'V3', ${`sha256:${'6'.repeat(64)}`}, 'CANONICAL_ASSEMBLY',
                    ${`sha256:${'7'.repeat(64)}`}, ${`sha256:${'8'.repeat(64)}`}, ${ctx.txTime})`.execute(
          ctx.trx,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      sql`TRUNCATE achievement.qualification_basis`.execute(owner),
    ).rejects.toMatchObject({ code: 'BR001' });
  });
});

// ═════════════════════════════ 3. REFERENCE FIXTURE lane (br_rkfx_ + overlays) ═════════════════════════════

describe('REFERENCE FIXTURE lane: QUALIFIED persistence mechanics (synthetic FINAL / V3 / hold / adoption)', () => {
  let fx: RankingFixtureDatabase;
  const dbs: Db[] = [];
  let api: Db;
  let owner: Db;
  let fw: Db;
  let fop: RankingDefinitionStore;
  let rules: AchievementRuleStore;
  let operatorAccountId: string;
  let catalog: TestCatalog;
  let codes: { sport: string; discipline: string };
  let target: string;

  beforeAll(async () => {
    fx = await createQualifiedFixtureDatabase();
    const urls = databaseUrls(fx.database);
    const mk = (u: string | undefined, max = 4) => {
      const d = createDb(u as string, { max });
      dbs.push(d);
      return d;
    };
    api = mk(urls.api, 12);
    owner = mk(urls.owner);
    fw = mk(rankingWorkerDatabaseUrl(fx.database));
    fop = new RankingDefinitionStore(mk(rankingOperatorDatabaseUrl(fx.database)));
    rules = new AchievementRuleStore(mk(achievementOperatorDatabaseUrl(fx.database)));
    const identity = new IdentityStore(api);
    catalog = await seedTestCatalog(
      identity,
      new CatalogStore(mk(operatorDatabaseUrl(fx.database))),
    );
    operatorAccountId = catalog.operatorAccountId;
    const { rows } = await sql<{ sport: string; discipline: string }>`
      SELECT s.code AS sport, d.code AS discipline FROM sports.discipline_version v
      JOIN sports.discipline d ON d.id = v.discipline_id JOIN sports.sport s ON s.id = d.sport_id
      WHERE v.id = ${catalog.running5k}`.execute(owner);
    codes = rows[0] as { sport: string; discipline: string };
    const org = await newOrganizer(identity, new OrganizationStore(api));
    target = (
      await new CompetitionStore(api).createCompetition({
        actorAccountId: org.ownerAccountId,
        organizerOrganizationId: org.organizationId,
        slug: uniqueSlug('qtarget'),
        profile: { name: 'Fictional Target Championship', timezone: 'UTC' },
        idempotencyKey: k('comp'),
      })
    ).competitionId;
  }, 300_000);
  afterAll(async () => {
    await Promise.all(dbs.map((d) => d.destroy()));
    await fx.destroy();
  }, 60_000);

  /** A published fixture PLATFORM system + a QUALIFIED rule (N) bound DV-wide, both in force. */
  async function world(n = 2) {
    const eff = futureIso(2);
    const { systemId } = await fop.createRankingSystem({
      operatorAccountId,
      code: `rk-${newId().slice(-12)}`,
      name: 'Fictional 5k best marks',
      kind: 'PLATFORM',
      idempotencyKey: k('rs'),
    });
    const v = await fop.createRankingSystemVersion({
      operatorAccountId,
      systemId,
      spec: rankingSpec({
        universe: {
          disciplineVersionId: catalog.running5k,
          metric: { key: 'elapsedTimeMs', markMetricId: 'running.elapsed_time' },
          resultScope: 'CONTEST',
          holderType: 'ATHLETE',
          population: {},
        },
        recognition: { level: 'PLATFORM', sport: [codes.sport] },
        effectiveFrom: eff,
      }),
      idempotencyKey: k('rsv'),
    });
    await fop.changeRankingSystemVersionStatus({
      operatorAccountId,
      systemVersionId: v.systemVersionId,
      status: 'PUBLISHED',
    });
    const { rows } = await sql<{ spec: Record<string, unknown>; code: string }>`
      SELECT v.spec, s.code FROM ranking.system_version v JOIN ranking.system s ON s.id = v.system_id
      WHERE v.id = ${v.systemVersionId}`.execute(owner);
    const row = rows[0] as { spec: Record<string, unknown>; code: string };
    const spec = referenceQualifiedRule(catalog.running5k, {
      targetCompetitionId: target,
      qualifyingRanks: n,
      source: {
        kind: 'RANKING_SNAPSHOT_POSITION',
        rankingSystemId: systemId,
        rankingSystemVersionId: v.systemVersionId,
      },
    });
    const rule = { ...(await publishAchievementRule(rules, operatorAccountId, spec)), spec };
    const later = (m: number) => new Date(Date.parse(eff) + m * 60_000).toISOString();
    const cand = (n2: number, holder: number, value: string, level = 'V3') => {
      const c = rankCandidate(n2, holder, value, { occurredAt: later(60) });
      return { ...c, verification: { ...c.verification, level } };
    };
    const publish = async (
      candidates: unknown[],
      asOfMin: number,
      correction?: { correctsSnapshotId: string; reasons: string[] },
    ) => {
      const r = await persistRankingRun(fw, {
        input: rankingRunInput(candidates, {
          spec: row.spec,
          system: {
            systemId,
            systemVersionId: v.systemVersionId,
            code: row.code,
            version: v.version,
            specHash: v.specHash,
            lifecycle: 'PUBLISHED',
          },
          discipline: {
            disciplineVersionId: catalog.running5k,
            sport: codes.sport,
            discipline: codes.discipline,
          },
          asOf: later(asOfMin),
        }),
        trigger: 'STAFF_REQUEST',
      });
      const p = await publishRankingSnapshot(fw, {
        runId: r.runId,
        ...(correction === undefined ? {} : { correction }),
      });
      return storedSnapshot(owner, p.snapshotId);
    };
    const discipline = await inTransaction(api, ModuleRole.achievements, (ctx) =>
      disciplineFacts(ctx, catalog.running5k),
    );
    const snapshotOf = (
      snap: StoredSnapshot,
      o: Partial<Parameters<typeof qualificationFixtureSnapshot>[0]> = {},
    ) =>
      qualificationFixtureSnapshot({
        snapshot: snap,
        rule,
        discipline,
        targetCompetitionId: target,
        ...o,
      });
    return { systemId, ...v, rule, cand, publish, snapshotOf };
  }

  const links = (ids: readonly string[]) =>
    sql<{
      achievement_id: string;
      holder_id: string;
      rank: number;
      tied: boolean;
      snapshot_id: string;
      qualifying_ranks: number;
      provenance: string;
    }>`
      SELECT achievement_id::text AS achievement_id, holder_id::text AS holder_id, rank, tied,
             snapshot_id::text AS snapshot_id, qualifying_ranks, provenance
      FROM achievement.qualification_basis WHERE achievement_id = ANY(${ids}::uuid[]) ORDER BY rank, holder_id`.execute(
      owner,
    );
  const statusOf = async (id: string) =>
    (
      await sql<{
        status: string;
      }>`SELECT status FROM achievement.v_achievement_status WHERE achievement_id = ${id}`.execute(
        owner,
      )
    ).rows[0]?.status;

  it('issuance: rank 1 and the shared rank N qualify; N+1 and a V2 holder never do; pins are exact', async () => {
    const w = await world(3);
    const snap = await w.publish(
      [
        w.cand(1, 1, '900000'),
        w.cand(2, 2, '905000'),
        w.cand(3, 3, '905000'),
        w.cand(4, 4, '910000'),
        w.cand(5, 5, '899000', 'V2'),
      ],
      120,
    );
    const before = {
      runs: await count(owner, sql`SELECT count(*)::text AS n FROM ranking.run`),
      snaps: await count(owner, sql`SELECT count(*)::text AS n FROM ranking.snapshot`),
      entries: await count(owner, sql`SELECT count(*)::text AS n FROM ranking.snapshot_entry`),
      results: await count(owner, sql`SELECT count(*)::text AS n FROM results.result_version`),
      runsV: await count(owner, sql`SELECT count(*)::text AS n FROM verification.run`),
      participants: await count(
        owner,
        sql`SELECT count(*)::text AS n FROM competition.participant`,
      ),
      events: await count(owner, sql`SELECT count(*)::text AS n FROM competition.event`),
    };
    const report = await persistDerivation(api, { snapshot: w.snapshotOf(snap) });
    expect(report).toMatchObject({ state: 'ISSUABLE', provenance: 'REFERENCE_FIXTURE' });
    const ids = report.achievements.map((a) => a.achievementId);
    const rows = (await links(ids)).rows;
    // Holder 5 (V2) holds rank 1 in the PLATFORM snapshot but is below the QUALIFIED V3 floor.
    expect(rows.map((r) => [r.rank, r.tied])).toEqual([
      [2, false],
      [3, true],
      [3, true],
    ]);
    expect(snap.entries.find((e) => e.rank === 1)?.basis[0]?.verificationLevel).toBe('V2');
    expect(rows.map((r) => r.holder_id).sort()).toEqual(
      [holderId(1), holderId(2), holderId(3)].sort(),
    );
    expect(new Set(rows.map((r) => r.snapshot_id))).toEqual(new Set([snap.snapshotId]));
    expect(rows.every((r) => r.qualifying_ranks === 3)).toBe(true);
    expect(rows.every((r) => r.provenance === 'REFERENCE_FIXTURE')).toBe(true);
    for (const id of ids) expect(await statusOf(id)).toBe('ACTIVE');
    // No side effects: nothing in rankings, results, verification or competitions was written.
    expect({
      runs: await count(owner, sql`SELECT count(*)::text AS n FROM ranking.run`),
      snaps: await count(owner, sql`SELECT count(*)::text AS n FROM ranking.snapshot`),
      entries: await count(owner, sql`SELECT count(*)::text AS n FROM ranking.snapshot_entry`),
      results: await count(owner, sql`SELECT count(*)::text AS n FROM results.result_version`),
      runsV: await count(owner, sql`SELECT count(*)::text AS n FROM verification.run`),
      participants: await count(
        owner,
        sql`SELECT count(*)::text AS n FROM competition.participant`,
      ),
      events: await count(owner, sql`SELECT count(*)::text AS n FROM competition.event`),
    }).toEqual(before);
    const { rows: ev } = await sql<{ t: string }>`
      SELECT DISTINCT event_type AS t FROM platform.outbox_event WHERE aggregate_id = ANY(${ids}::uuid[])`.execute(
      owner,
    );
    expect(ev.map((e) => e.t).sort()).toEqual(['AchievementDerived']);
    // Fixture rows never reach the public (canonical-only) read path.
    expect(await new AchievementPublicReader(api).achievement(ids[0] as string)).toBeUndefined();
    // The dependency index names exactly these Achievements for the snapshot.
    const idx = await inTransaction(api, ModuleRole.achievements, (ctx) =>
      qualificationIndex(ctx, { snapshotId: snap.snapshotId }),
    );
    expect(idx.map((x) => x.achievementId).sort()).toEqual([...ids].sort());
  }, 120_000);

  it('idempotent: re-derivation and concurrent derivations create exactly one per holder', async () => {
    const w = await world(3);
    const snap = await w.publish([w.cand(1, 11, '900000'), w.cand(2, 12, '901000')], 120);
    const outs = await Promise.all(
      [1, 2, 3].map(() => persistDerivation(api, { snapshot: w.snapshotOf(snap) })),
    );
    const created = outs.flatMap((o) => o.achievements.filter((a) => a.created));
    expect(created).toHaveLength(2);
    const again = await persistDerivation(api, { snapshot: w.snapshotOf(snap) });
    expect(again.achievements.every((a) => !a.created)).toBe(true);
  }, 120_000);

  it('blocked inputs persist nothing: hold, missing / out-of-scope / withdrawn adoption, corrected snapshot', async () => {
    const w = await world(3);
    const snap = await w.publish([w.cand(1, 21, '900000')], 120);
    for (const [o, reason] of [
      [{ hold: true }, 'HOLD_ACTIVE'],
      [{ adoption: null }, 'TARGET_QUALIFICATION_AUTHORITY_UNAVAILABLE'],
      [
        { adoption: { targetCompetitionId: newId() } },
        'TARGET_QUALIFICATION_AUTHORITY_OUT_OF_SCOPE',
      ],
      [{ adoption: { status: 'WITHDRAWN' as const } }, 'TARGET_QUALIFICATION_AUTHORITY_INVALID'],
      [{ correctedBySnapshotId: newId() }, 'RANKING_SNAPSHOT_CORRECTED'],
    ] as const) {
      const r = await persistDerivation(api, { snapshot: w.snapshotOf(snap, o) });
      expect(r.state).toBe('BLOCKED');
      expect(r.blockedBy).toContain(reason);
      expect(r.achievements).toEqual([]);
    }
  }, 120_000);

  it('a later FOLLOWS snapshot never mutates nor duplicates an existing QUALIFIED; a new qualifier is added', async () => {
    const w = await world(2);
    const s1 = await w.publish([w.cand(1, 31, '900000'), w.cand(2, 32, '901000')], 120);
    const first = await persistDerivation(api, { snapshot: w.snapshotOf(s1) });
    const byHolder = new Map(first.achievements.map((a) => [a.holder.holderId, a.achievementId]));
    expect([...byHolder.keys()].sort()).toEqual([holderId(31), holderId(32)].sort());
    const ids = [...byHolder.values()];
    const { rows: rowsBefore } = await sql<{ id: string; candidate_hash: string }>`
      SELECT id::text AS id, candidate_hash FROM achievement.achievement
      WHERE id = ANY(${ids}::uuid[]) ORDER BY id`.execute(owner);
    const linksBefore = (await links(ids)).rows;
    // Holder 31 stays rank 1; holder 33 enters at rank 2; holder 32 drops to rank 3 (outside N).
    const s2 = await w.publish(
      [w.cand(1, 31, '899000'), w.cand(3, 33, '900500'), w.cand(2, 32, '901000')],
      180,
    );
    expect(s2.lineageKind).toBe('FOLLOWS');
    const second = await persistDerivation(api, { snapshot: w.snapshotOf(s2) });
    const by2 = new Map(second.achievements.map((a) => [a.holder.holderId, a]));
    expect(by2.get(holderId(31))).toMatchObject({
      created: false,
      achievementId: byHolder.get(holderId(31)),
    });
    expect(by2.get(holderId(33))?.created).toBe(true);
    expect(by2.has(holderId(32))).toBe(false);
    // Earlier Achievements (including holder 32, now outside N) are untouched and still ACTIVE.
    const { rows: rowsAfter } = await sql<{ id: string; candidate_hash: string }>`
      SELECT id::text AS id, candidate_hash FROM achievement.achievement
      WHERE id = ANY(${ids}::uuid[]) ORDER BY id`.execute(owner);
    expect(rowsAfter).toEqual(rowsBefore);
    expect((await links(ids)).rows).toEqual(linksBefore);
    for (const id of ids) expect(await statusOf(id)).toBe('ACTIVE');
  }, 120_000);

  it('correction: still qualifying ⇒ new QUALIFIED SUPERSEDES the old; no longer qualifying ⇒ REVOKED', async () => {
    const w = await world(2);
    const s1 = await w.publish([w.cand(1, 41, '900000'), w.cand(2, 42, '901000')], 120);
    const first = await persistDerivation(api, { snapshot: w.snapshotOf(s1) });
    const old = new Map(first.achievements.map((a) => [a.holder.holderId, a.achievementId]));
    expect(old.size).toBe(2);
    // The correcting snapshot: holder 41 still qualifies, holder 42 is out (a third holder ranks 2).
    const s2 = await w.publish(
      [w.cand(1, 41, '900000'), w.cand(3, 43, '900500'), w.cand(2, 42, '905000')],
      150,
      { correctsSnapshotId: s1.snapshotId, reasons: ['RESULT_SUPERSEDED'] },
    );
    expect(s2.lineageKind).toBe('CORRECTS');
    // The corrected snapshot can no longer qualify anyone.
    const stale = await persistDerivation(api, {
      snapshot: w.snapshotOf(s1, { correctedBySnapshotId: s2.snapshotId }),
    });
    expect(stale.blockedBy).toContain('RANKING_SNAPSHOT_CORRECTED');
    const corrected = await persistDerivation(api, { snapshot: w.snapshotOf(s2) });
    const holder41 = holderId(41);
    const replacement = corrected.achievements.find((a) => a.holder.holderId === holder41);
    expect(replacement).toMatchObject({ created: true, supersedes: [old.get(holder41)] });
    expect(await statusOf(old.get(holder41) as string)).toBe('SUPERSEDED');
    // Holder 42: re-assessed against the as-corrected view (fixture support source).
    expect(corrected.achievements.find((a) => a.holder.holderId === holderId(43))?.created).toBe(
      true,
    );
    expect(corrected.achievements.some((a) => a.holder.holderId === holderId(42))).toBe(false);
    const old42 = old.get(holderId(42)) as string;
    const source: SupportFactSource = async (_ctx, id) =>
      id !== old42
        ? undefined
        : ({
            provenance: 'REFERENCE_FIXTURE',
            achievementId: id,
            requiredLevel: 'V3',
            basis: [],
            holdSupported: true,
            holdActive: false,
            qualifyingSnapshotCorrected: true,
            successorDerivation: 'HOLDER_DOES_NOT_QUALIFY',
          } as unknown as SupportFacts);
    const swept = await sweepSupport(api, source, { provenance: 'REFERENCE_FIXTURE' });
    expect(swept.find((x) => x.achievementId === old42)).toMatchObject({
      status: 'REVOKED',
      changed: true,
    });
    // History is kept: the revoked / superseded facts and their links are unchanged rows.
    const { rows: hist } = await sql<{ status: string; reasons: string[] }>`
      SELECT status, reasons FROM achievement.status_entry WHERE achievement_id = ${old42} ORDER BY seq`.execute(
      owner,
    );
    expect(hist).toEqual([
      { status: 'ACTIVE', reasons: [] },
      { status: 'REVOKED', reasons: ['HOLDER_NO_LONGER_QUALIFIES', 'RANKING_SNAPSHOT_CORRECTED'] },
    ]);
    expect((await links([old42])).rows[0]?.snapshot_id).toBe(s1.snapshotId);
    const { rows: sup } = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM achievement.supersession
      WHERE superseded_id = ${old.get(holder41)} AND superseding_id = ${replacement?.achievementId}`.execute(
      owner,
    );
    expect(sup[0]?.n).toBe('1');
  }, 120_000);

  it('a new rule version never rewrites the old basis; the link and Achievement stay immutable', async () => {
    const w = await world(2);
    const snap = await w.publish([w.cand(1, 51, '900000')], 120);
    const [a] = (await persistDerivation(api, { snapshot: w.snapshotOf(snap) })).achievements;
    const id = a?.achievementId as string;
    for (const stmt of [
      sql`UPDATE achievement.qualification_basis SET rank = 1 WHERE achievement_id = ${id}`,
      sql`DELETE FROM achievement.qualification_basis WHERE achievement_id = ${id}`,
      sql`UPDATE achievement.achievement SET basis_level = 'V4' WHERE id = ${id}`,
    ])
      await expect(stmt.execute(owner)).rejects.toMatchObject({ code: 'BR001' });
    // A forged link (rank > N, another snapshot) for an existing QUALIFIED is refused.
    await expect(
      inTransaction(api, ModuleRole.achievements, (ctx) =>
        sql`INSERT INTO achievement.qualification_basis
              (achievement_id, rule_id, holder_type, holder_id, target_competition_id, basis_kind, qualifying_ranks,
               rank, tied, ranking_system_id, ranking_system_version_id, snapshot_id, snapshot_hash, basis_hash,
               target_adoption_id, target_adoption_hash, provenance, recorded_at)
            SELECT ${newId()}::uuid, rule_id, holder_type, holder_id, target_competition_id, basis_kind, qualifying_ranks,
                   99, tied, ranking_system_id, ranking_system_version_id, snapshot_id, snapshot_hash, basis_hash,
                   target_adoption_id, target_adoption_hash, provenance, ${ctx.txTime}
            FROM achievement.qualification_basis WHERE achievement_id = ${id}`.execute(ctx.trx),
      ),
    ).rejects.toThrow();
  }, 120_000);

  it('raw SQL forgery: a lowered / raised threshold or a sub-V3 basis level is refused by the database', async () => {
    const w = await world(2);
    const snap = await w.publish([w.cand(1, 81, '900000')], 120);
    const [a] = (await persistDerivation(api, { snapshot: w.snapshotOf(snap) })).achievements;
    const src = a?.achievementId as string;
    // Copy an existing, valid fixture QUALIFIED (achievement + basis + status + link) as br_achievements,
    // changing only the threshold N (candidate and link kept consistent with each other).
    const forge = (patch: { ranks?: number; level?: string }) =>
      inTransaction(api, ModuleRole.achievements, async (ctx) => {
        const id = newId();
        const ranks = patch.ranks ?? 2;
        await sql`INSERT INTO achievement.achievement
            (id, identity_hash, candidate_hash, candidate, achievement_type, rule_id, rule_version_id, engine_version,
             holder_type, holder_id, scope_type, scope_id, competition_id, event_id, discipline_version_id, basis_level,
             qualifying_value, comparison_set_hash, evidence_commitment, governing_recognition_level, governing_anchor_id,
             governing_anchor_fact_hash, snapshot_provenance, derivation_snapshot_hash, derivation_outcome_hash,
             requested_by_account_id, recorded_at)
          SELECT ${id}::uuid, ${`sha256:${'9'.repeat(64)}`}, candidate_hash,
                 jsonb_set(
                   jsonb_set(candidate, '{qualification,qualifyingRanks}', to_jsonb(${ranks}::int)),
                   '{basisLevel}', to_jsonb(${patch.level ?? 'V3'}::text)),
                 achievement_type, rule_id, rule_version_id, engine_version, holder_type, holder_id, scope_type, scope_id,
                 competition_id, event_id, discipline_version_id, ${patch.level ?? 'V3'}, qualifying_value,
                 comparison_set_hash, evidence_commitment, governing_recognition_level, governing_anchor_id,
                 governing_anchor_fact_hash, snapshot_provenance, derivation_snapshot_hash, derivation_outcome_hash,
                 requested_by_account_id, ${ctx.txTime}
          FROM achievement.achievement WHERE id = ${src}`.execute(ctx.trx);
        await sql`INSERT INTO achievement.qualification_basis
            (achievement_id, rule_id, holder_type, holder_id, target_competition_id, basis_kind, qualifying_ranks,
             rank, tied, ranking_system_id, ranking_system_version_id, snapshot_id, snapshot_hash, basis_hash,
             target_adoption_id, target_adoption_hash, provenance, recorded_at)
          SELECT ${id}::uuid, rule_id, holder_type, holder_id, target_competition_id, basis_kind, ${ranks},
                 rank, tied, ranking_system_id, ranking_system_version_id, snapshot_id, snapshot_hash, basis_hash,
                 target_adoption_id, target_adoption_hash, provenance, ${ctx.txTime}
          FROM achievement.qualification_basis WHERE achievement_id = ${src}`.execute(ctx.trx);
      });
    // N = 5 is not the rule version's N = 2.
    await expect(forge({ ranks: 5 })).rejects.toMatchObject({ code: 'BR183' });
    // A QUALIFIED below the V3 floor is not representable (achievement_qualified_shape).
    await expect(forge({ level: 'V2' })).rejects.toMatchObject({ code: '23514' });
    expect(
      await count(
        owner,
        sql`SELECT count(*)::text AS n FROM achievement.qualification_basis WHERE snapshot_id = ${snap.snapshotId}`,
      ),
    ).toBe(1);
  }, 120_000);

  it('the engine re-derivation guards the writer: a tampered candidate or a lying snapshot is refused', async () => {
    const w = await world(2);
    const snap = await w.publish([w.cand(1, 61, '900000')], 120);
    const s = w.snapshotOf(snap);
    const d = deriveAchievements(s);
    expect(d.outcome.state).toBe('ISSUABLE');
    // A snapshot claiming a different rank for the holder is a different (hash-bound) snapshot whose
    // candidate the database refuses: the stored snapshot entry has rank 1.
    const lying = {
      ...s,
      qualification: {
        ...s.qualification,
        ranking: {
          ...s.qualification.ranking!,
          entries: s.qualification.ranking!.entries.map((e) => ({ ...e, rank: 2 })),
        },
      },
    };
    await expect(persistDerivation(api, { snapshot: lying })).rejects.toMatchObject({
      code: 'BR183',
    });
    expect(
      await count(
        owner,
        sql`SELECT count(*)::text AS n FROM achievement.qualification_basis WHERE snapshot_id = ${snap.snapshotId}`,
      ),
    ).toBe(0);
  }, 120_000);

  it('classification path: FINAL classification position ≤ N; a superseding version SUPERSEDES', async () => {
    const identity = new IdentityStore(api);
    const org = await newOrganizer(identity, new OrganizationStore(api));
    const comps = new CompetitionStore(api);
    const { competitionId } = await comps.createCompetition({
      actorAccountId: org.ownerAccountId,
      organizerOrganizationId: org.organizationId,
      slug: uniqueSlug('qsource'),
      profile: { name: 'Fictional Source Open', timezone: 'UTC' },
      idempotencyKey: k('comp'),
    });
    await comps.publishCompetition({ actorAccountId: org.ownerAccountId, competitionId });
    const { eventId } = await comps.createEvent({
      actorAccountId: org.ownerAccountId,
      competitionId,
      slug: uniqueSlug('qevent'),
      disciplineVersionId: catalog.timedSingles,
      formatVersionId: catalog.singleElimination,
      settings: { name: 'Fictional Duel' },
      idempotencyKey: k('event'),
    });
    const { policyId } = await fop.createClassificationPolicy({
      operatorAccountId,
      code: `cp-${newId().slice(-12)}`,
      name: 'Fictional table',
      scopeType: 'EVENT_CLASSIFICATION',
      idempotencyKey: k('cp'),
    });
    const pv = await fop.createClassificationPolicyVersion({
      operatorAccountId,
      policyId,
      spec: {
        targetEngine: 'classification-engine/1',
        displayName: 'Fictional event table',
        scopeType: 'EVENT_CLASSIFICATION',
        disciplineVersionId: catalog.timedSingles,
        minimumInputStatus: 'PROVISIONAL',
        primary: 'METRICS',
        keys: [
          {
            metric: 'elapsedTimeMs',
            markMetricId: 'athletics.100m.time',
            order: 'LOWER_IS_BETTER',
            source: 'PERFORMANCE',
            aggregation: 'MIN',
          },
        ],
      },
      idempotencyKey: k('cpv'),
    });
    const spec = referenceQualifiedRule(catalog.timedSingles, {
      targetCompetitionId: target,
      qualifyingRanks: 3,
      source: {
        kind: 'CLASSIFICATION_POSITION',
        scopeType: 'EVENT_CLASSIFICATION',
        scopeId: eventId,
        policyVersionId: pv.policyVersionId,
      },
    });
    const rule = await publishAchievementRule(rules, operatorAccountId, spec);
    const fixture = (
      version: string,
      extra: Parameters<typeof qualifiedClassificationFixture>[0] = {},
    ) =>
      qualifiedClassificationFixture({
        ruleSpec: spec,
        ruleIdentity: rule,
        disciplineVersionId: catalog.timedSingles,
        classificationDv: catalog.timedSingles,
        policyVersionId: pv.policyVersionId,
        scopeTargetId: eventId,
        targetAuthority: { targetCompetitionId: target },
        version,
        ...extra,
      });
    const c1 = await persistDerivation(api, { snapshot: fixture(`c1-${newId().slice(-6)}`) });
    expect(c1.state).toBe('ISSUABLE');
    const byHolder = new Map(c1.achievements.map((a) => [a.holder.holderId, a.achievementId]));
    expect([...byHolder.keys()].sort()).toEqual(
      [1, 2, 3, 4].map((x) => qualifier(x).athleteId).sort(),
    );
    const { rows } = await sql<{ v: string; p: string; rank: number; kind: string }>`
      SELECT classification_version_id::text AS v, classification_policy_version_id::text AS p, rank,
             basis_kind AS kind
      FROM achievement.qualification_basis
      WHERE achievement_id = ${byHolder.get(qualifier(1).athleteId)}`.execute(owner);
    expect(rows[0]).toMatchObject({
      p: pv.policyVersionId,
      rank: 1,
      kind: 'CLASSIFICATION_POSITION',
    });
    // A corrected classification version (fixture: no T7 producer) where holder 1 still qualifies.
    const v1 = rows[0]?.v;
    const c2snap = fixture(`c2-${newId().slice(-6)}`, {
      entries: [
        { k: 1, rank: 1 },
        { k: 5, rank: 2 },
      ],
    });
    const c2 = await persistDerivation(api, {
      snapshot: {
        ...c2snap,
        qualification: {
          ...c2snap.qualification,
          classification: {
            ...c2snap.qualification.classification!,
            supersedesVersionId: v1 as string,
          },
        },
      },
    });
    const replacement = c2.achievements.find((a) => a.holder.holderId === qualifier(1).athleteId);
    expect(replacement).toMatchObject({
      created: true,
      supersedes: [byHolder.get(qualifier(1).athleteId)],
    });
    expect(await statusOf(byHolder.get(qualifier(1).athleteId) as string)).toBe('SUPERSEDED');
    // Holder 2 is not in the corrected version: its old QUALIFIED is untouched until re-assessed.
    expect(await statusOf(byHolder.get(qualifier(2).athleteId) as string)).toBe('ACTIVE');
  }, 180_000);

  it('the canonical service never consumes a fixture source', async () => {
    const w = await world(2);
    const snap = await w.publish([w.cand(1, 71, '900000')], 120);
    await expect(
      new AchievementService(api).deriveQualification({
        actor: { internal: true },
        source: { kind: 'RANKING_SNAPSHOT', snapshotId: snap.snapshotId },
      }),
    ).rejects.toMatchObject({ details: { reason: 'FIXTURE_SOURCE_REFUSED' } });
  }, 120_000);
});
