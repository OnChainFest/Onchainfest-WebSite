import { referenceRecordSetRule } from '@br/achievements';
import { RECORD_ENGINE_VERSION, type RecordCategorySpec } from '@br/records';
import { sql } from 'kysely';
import { AchievementRuleStore } from '../achievement-rule-store';
import { achievementOperatorDatabaseUrl, databaseUrls, recordOperatorDatabaseUrl } from '../config';
import { createDb } from '../db';
import { IdentityStore } from '../identity-store';
import { RecordCategoryStore } from '../record-category-store';
import { RecordService } from '../record-store';
import { inTransaction, ModuleRole } from '../tx';

/**
 * BRT-09 development seed — CANONICAL ONLY. ALL DATA IS FICTIONAL. It never enables any fixture lane
 * and never creates a RecordMark, a ratification or an attestation.
 *
 * Builds on `pnpm db:seed:competition && … && db:seed:achievements`. Through the dedicated operator
 * logins it creates and publishes FICTIONAL development RecordCategories on the seeded running
 * DisciplineVersion (not universal standards), each exactly at the BRT-01 floor:
 *   br-dev-5k-platform-best   PLATFORM (Bragging Rights platform best), SHARED ties   (V3 · FINAL)
 *   br-dev-5k-cr              NATIONAL (CR), FIRST_ACHIEVED, national recognition    (V4 · FINAL)
 * plus the RECORD_SET AchievementRule (achievement-engine/2) for that DisciplineVersion, then requests
 * one CANONICAL record evaluation of the seeded ResultVersion and prints the honest outcome: 0 marks.
 *
 * Idempotent: fixed codes / idempotency keys; an existing published version is reused (a category
 * version is never re-created with a different effectiveFrom).
 */
if (process.env.NODE_ENV === 'production') throw new Error('development seed refuses production');
const db = createDb(databaseUrls().api, { max: 4 });
const rUrl = recordOperatorDatabaseUrl();
const aUrl = achievementOperatorDatabaseUrl();
if (rUrl === undefined || aUrl === undefined) throw new Error('no operator database URLs');
const rop = createDb(rUrl, { max: 2 });
const aop = createDb(aUrl, { max: 2 });
const owner = createDb(databaseUrls().owner, { max: 1 });
const identity = new IdentityStore(db);
const categories = new RecordCategoryStore(rop);
const rules = new AchievementRuleStore(aop);
const records = new RecordService(db);

try {
  const found = await inTransaction(db, ModuleRole.records, async (ctx) => {
    const { rows } = await sql<{ id: string; sport: string }>`
      SELECT dv.id, s.code AS sport FROM sports.discipline_version dv JOIN sports.discipline d ON d.id = dv.discipline_id
      JOIN sports.sport s ON s.id = d.sport_id WHERE d.code LIKE 'running.%' ORDER BY dv.recorded_at LIMIT 1`.execute(
      ctx.trx,
    );
    return rows[0];
  });
  if (found === undefined)
    throw new Error('run `pnpm db:seed:competition` first (no running DisciplineVersion)');
  const { accountId: operator } = await identity.signIn({
    provider: 'test',
    providerSubject: 'seed:record-operator',
    method: 'TEST',
  });
  const effectiveFrom = new Date(Date.now() + 60_000).toISOString();
  const base = (o: Partial<RecordCategorySpec>): RecordCategorySpec => ({
    targetEngine: RECORD_ENGINE_VERSION,
    displayName: '5K time',
    scope: { scopeType: 'PLATFORM' },
    universe: {
      disciplineVersionId: found.id,
      metric: { key: 'elapsedTimeMs', markMetricId: 'running.elapsed_time_ms' },
      resultScope: 'CONTEST',
      holderType: 'ATHLETE',
    },
    tiePolicy: 'SHARED',
    population: {},
    conditions: [],
    requirements: { minimumVerificationLevel: 'V3', minimumResultStatus: 'FINAL' },
    recognition: { level: 'PLATFORM', sport: [found.sport] },
    effectiveFrom,
    ...o,
  });
  const reference = [
    { code: 'br-dev-5k-platform-best', name: 'Fictional 5K platform best', spec: base({}) },
    {
      code: 'br-dev-5k-cr',
      name: 'Fictional 5K record (CR)',
      spec: base({
        displayName: 'Fictional 5K (CR)',
        scope: { scopeType: 'NATIONAL', region: ['CR'] },
        tiePolicy: 'FIRST_ACHIEVED',
        requirements: { minimumVerificationLevel: 'V4', minimumResultStatus: 'FINAL' },
        recognition: { level: 'NATIONAL', sport: [found.sport], region: ['CR'] },
      }),
    },
  ];
  const seeded = [];
  for (const r of reference) {
    const { categoryId } = await categories.createCategory({
      operatorAccountId: operator,
      code: r.code,
      name: r.name,
      scopeType: r.spec.scope.scopeType,
      idempotencyKey: `seed:record:${r.code}`,
    });
    const { rows } = await sql<{ id: string; version: number; status: string }>`
      SELECT v.id, v.version, c.status FROM record.category_version v
      JOIN record.v_category_version_current c ON c.category_version_id = v.id
      WHERE v.category_id = ${categoryId} ORDER BY v.version DESC LIMIT 1`.execute(owner);
    let version = rows[0];
    if (version === undefined) {
      const v = await categories.createCategoryVersion({
        operatorAccountId: operator,
        categoryId,
        spec: r.spec,
        idempotencyKey: `seed:record:${r.code}:v1`,
      });
      version = { id: v.categoryVersionId, version: v.version, status: 'DRAFT' };
    }
    if (version.status === 'DRAFT')
      await categories.changeVersionStatus({
        operatorAccountId: operator,
        categoryVersionId: version.id,
        status: 'PUBLISHED',
      });
    seeded.push({ code: r.code, scopeType: r.spec.scope.scopeType, version: version.version });
  }
  const { ruleId } = await rules.createRule({
    operatorAccountId: operator,
    code: 'br-dev-record-set',
    name: 'Fictional RECORD_SET rule (5K)',
    achievementType: 'RECORD_SET',
    idempotencyKey: 'seed:record:record-set-rule',
  });
  const rv = await rules.createRuleVersion({
    operatorAccountId: operator,
    ruleId,
    spec: referenceRecordSetRule(found.id),
    idempotencyKey: 'seed:record:record-set-rule:v1',
  });
  await rules.changeVersionStatus({
    operatorAccountId: operator,
    ruleVersionId: rv.ruleVersionId,
    status: 'PUBLISHED',
  });
  await rules.bindRule({
    operatorAccountId: operator,
    ruleVersionId: rv.ruleVersionId,
    idempotencyKey: 'seed:record:record-set-rule:binding',
  });
  const seededRv = await inTransaction(db, ModuleRole.results, async (ctx) => {
    const { rows } = await sql<{ id: string }>`
      SELECT v.id FROM results.result_version v ORDER BY v.recorded_at LIMIT 1`.execute(ctx.trx);
    return rows[0]?.id;
  });
  const evaluation =
    seededRv === undefined
      ? undefined
      : await records.evaluate({ actor: { internal: true }, resultVersionId: seededRv });
  const { rows: marks } = await sql<{
    n: number;
  }>`SELECT count(*)::int AS n FROM record.record_mark`.execute(owner);
  const { rows: ratified } = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM record.mark_status_entry WHERE ratification_ref IS NOT NULL`.execute(
    owner,
  );
  console.log(
    JSON.stringify(
      {
        fictionalDataOnly: true,
        lane: 'CANONICAL PRODUCTION ASSEMBLY (no fixture lane is ever enabled by this seed)',
        categories: seeded.map((c) => ({
          ...c,
          note: 'fictional development reference category — not a universal standard',
        })),
        recordSetRule: {
          code: 'br-dev-record-set',
          version: rv.version,
          engine: 'achievement-engine/2',
        },
        evaluation:
          evaluation === undefined
            ? 'no seeded ResultVersion'
            : {
                resultVersionId: evaluation.resultVersionId,
                noApplicableCategory: evaluation.noApplicableCategory,
                evaluations: evaluation.evaluations.map((e) => ({
                  category: e.categoryCode,
                  state: e.state,
                  blockedBy: e.blockedBy,
                })),
              },
        recordMarksInDatabase: marks[0]?.n ?? 0,
        ratifiedMarksInDatabase: ratified[0]?.n ?? 0,
        honestProductionCeiling:
          '0 record marks: no canonical producer reaches FINAL, V3 / V4, hold facts or RECORD_RATIFIED / REVIEW_COMPLETED yet (deferred BRT-06R)',
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.all([db.destroy(), rop.destroy(), aop.destroy(), owner.destroy()]);
}
