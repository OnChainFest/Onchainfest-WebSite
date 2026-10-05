import {
  referencePersonalBestRule,
  referenceThresholdRule,
  referenceTitleRule,
  type AchievementRuleSpec,
} from '@br/achievements';
import { sql } from 'kysely';
import { AchievementRuleStore } from '../achievement-rule-store';
import { AchievementService } from '../achievement-store';
import { achievementOperatorDatabaseUrl, databaseUrls } from '../config';
import { createDb } from '../db';
import { IdentityStore } from '../identity-store';
import { inTransaction, ModuleRole } from '../tx';

/**
 * BRT-08 development seed — CANONICAL ONLY. ALL DATA IS FICTIONAL. It never enables any fixture lane.
 *
 * Builds on `pnpm db:seed:competition && db:seed:evidence && db:seed:verification`. Through the
 * dedicated operator login (br_achievement_operator_app) it creates, publishes and binds FICTIONAL
 * development reference rules (not universal standards), each exactly at the BRT-01 floor:
 *   br-dev-event-title      TITLE — rank 1 in an event classification        (V2 · FINAL)
 *   br-dev-match-winner     CONTEST_WON — WIN in a padel match               (V2 · FINAL)
 *   br-dev-two-sets         PERFORMANCE_THRESHOLD — setsWon ≥ 2 (padel)       (V2 · FINAL)
 *   br-dev-5k-personal-best PERSONAL_BEST — elapsed time, lower is better     (V2 · OFFICIAL)
 * then requests one CANONICAL derivation for the seeded ResultVersion and prints the honest outcome:
 * 0 Achievements (the seeded version was submitted before these rules took effect — bindings never
 * derive retroactively — and in any case no canonical producer can reach V2 / FINAL / hold facts /
 * credited lineups today).
 *
 * Idempotent: fixed idempotency keys; re-running finds the rules / versions / bindings.
 */
if (process.env.NODE_ENV === 'production') throw new Error('development seed refuses production');
const db = createDb(databaseUrls().api, { max: 4 });
const operatorUrl = achievementOperatorDatabaseUrl();
if (operatorUrl === undefined) throw new Error('no achievement operator database URL');
const aop = createDb(operatorUrl, { max: 2 });
const identity = new IdentityStore(db);
const rules = new AchievementRuleStore(aop);
const achievements = new AchievementService(db);
const owner = createDb(databaseUrls().owner, { max: 1 });

try {
  const found = await inTransaction(db, ModuleRole.competition, async (ctx) => {
    const { rows } = await sql<{ padel_dv: string; running_dv: string | null; contest_id: string }>`
      SELECT e.discipline_version_id AS padel_dv, ct.id AS contest_id,
             (SELECT dv.id FROM sports.discipline_version dv JOIN sports.discipline d ON d.id = dv.discipline_id
              WHERE d.code LIKE 'running.%' ORDER BY dv.recorded_at LIMIT 1) AS running_dv
      FROM competition.competition_slug s
      JOIN competition.event e ON e.competition_id = s.competition_id
      JOIN competition.contest ct ON ct.event_id = e.id
      WHERE s.slug = 'fictional-padel-open' ORDER BY ct.sequence LIMIT 1`.execute(ctx.trx);
    return rows[0];
  });
  if (found === undefined) throw new Error('run `pnpm db:seed:competition` first');
  const rv = await inTransaction(db, ModuleRole.results, async (ctx) => {
    const { rows } = await sql<{ id: string }>`
      SELECT v.id FROM results.result r JOIN results.result_version v ON v.result_id = r.id
      WHERE r.scope_type = 'CONTEST' AND r.scope_target_id = ${found.contest_id} ORDER BY v.version_number LIMIT 1`.execute(
      ctx.trx,
    );
    return rows[0]?.id;
  });
  if (rv === undefined)
    throw new Error('run `pnpm db:seed:evidence` first (no seeded ResultVersion)');

  const { accountId: operator } = await identity.signIn({
    provider: 'test',
    providerSubject: 'seed:achievement-operator',
    method: 'TEST',
  });
  const reference: { code: string; name: string; spec: AchievementRuleSpec }[] = [
    {
      code: 'br-dev-event-title',
      name: 'Fictional event title rule',
      spec: referenceTitleRule(found.padel_dv),
    },
    {
      code: 'br-dev-match-winner',
      name: 'Fictional match-winner rule',
      spec: {
        ...referenceTitleRule(found.padel_dv),
        achievementType: 'CONTEST_WON',
        displayName: 'Match Winner',
        criterion: { kind: 'CONTEST_OUTCOME', resultScope: 'CONTEST', outcomes: ['WIN'] },
      },
    },
    {
      code: 'br-dev-two-sets',
      name: 'Fictional two-set threshold rule',
      spec: referenceThresholdRule(
        found.padel_dv,
        { key: 'setsWon', markMetricId: 'padel.match.sets' },
        'GTE',
        '2',
        'Two Sets Won',
      ),
    },
    ...(found.running_dv === null
      ? []
      : [
          {
            code: 'br-dev-5k-personal-best',
            name: 'Fictional 5K personal-best rule',
            spec: referencePersonalBestRule(
              found.running_dv,
              { key: 'elapsedTimeMs', markMetricId: 'running.elapsed_time_ms' },
              '5K Personal Best',
            ),
          },
        ]),
  ];
  const seeded = [];
  for (const r of reference) {
    const { ruleId } = await rules.createRule({
      operatorAccountId: operator,
      code: r.code,
      name: r.name,
      achievementType: r.spec.achievementType,
      idempotencyKey: `seed:achievement:${r.code}`,
    });
    const v = await rules.createRuleVersion({
      operatorAccountId: operator,
      ruleId,
      spec: r.spec,
      idempotencyKey: `seed:achievement:${r.code}:v1`,
    });
    await rules.changeVersionStatus({
      operatorAccountId: operator,
      ruleVersionId: v.ruleVersionId,
      status: 'PUBLISHED',
    });
    const b = await rules.bindRule({
      operatorAccountId: operator,
      ruleVersionId: v.ruleVersionId,
      idempotencyKey: `seed:achievement:${r.code}:binding`,
    });
    seeded.push({
      code: r.code,
      type: r.spec.achievementType,
      version: v.version,
      specHash: v.specHash,
      effectiveFrom: b.effectiveFrom,
    });
  }

  const d = await achievements.derive({ actor: { internal: true }, resultVersionId: rv });
  const { rows: count } = await sql<{
    n: number;
  }>`SELECT count(*)::int AS n FROM achievement.achievement`.execute(owner);
  console.log(
    JSON.stringify(
      {
        fictionalDataOnly: true,
        lane: 'CANONICAL PRODUCTION ASSEMBLY (no fixture lane is ever enabled by this seed)',
        rules: seeded.map((r) => ({
          ...r,
          note: 'fictional development reference rule — not a universal standard',
        })),
        derivation: {
          resultVersionId: rv,
          noApplicableRule: d.noApplicableRule,
          explanation: d.noApplicableRule
            ? 'the seeded ResultVersion was submitted before these rules took effect; bindings never derive retroactively'
            : undefined,
          rules: d.rules.map((r) => ({
            rule: `${r.ruleCode} v${r.ruleVersion}`,
            state: r.state,
            blockedBy: r.blockedBy,
            persisted: r.achievements.length,
          })),
        },
        achievementsInDatabase: count[0]?.n ?? 0,
        honestProductionCeiling:
          '0 Achievements: no canonical producer reaches V2 (RESULT_OFFICIAL / T5), OFFICIAL/FINAL (T5/T6), hold facts or credited Result lineups yet',
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.all([db.destroy(), aop.destroy(), owner.destroy()]);
}
