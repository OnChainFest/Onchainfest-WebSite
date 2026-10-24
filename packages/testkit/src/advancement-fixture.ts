import {
  ADVANCEMENT_POLICY_TEMPLATES,
  RULESET_TEMPLATES,
  advancementCompatibility,
  advancementRequirements,
  formatEngine,
  type DisciplineVersionSpec,
} from '@br/competition';
import { newId } from '@br/domain';
import {
  CatalogStore,
  CompetitionReader,
  IdentityStore,
  ModuleRole,
  ScoringStore,
  inTransaction,
  type Db,
} from '@br/persistence';
import { sql } from 'kysely';
import { newTestAccount, operatorDb } from './index';

/** Explicit setup for older structure/scheduling tests: new scored fields must be operable.
 * Never used by product code or the D-13 refusal tests. Existing scoring pins are preserved.
 */
export async function configureAdvancementFixture(db: Db, actorAccountId: string, eventId: string) {
  const row = await inTransaction(db, ModuleRole.competition, async (ctx) => {
    const { rows } = await sql<{
      spec: DisciplineVersionSpec;
      engine_id: string;
      engine_version: number;
      format_config: Record<string, unknown>;
      n: number;
    }>`
      SELECT d.spec, f.engine_id, f.engine_version, e.format_config,
        (SELECT count(*)::int FROM competition.registration r
         JOIN competition.v_registration_current s ON s.registration_id = r.id
         WHERE r.event_id = e.id AND s.status = 'CONFIRMED') AS n
      FROM competition.event e
      JOIN sports.discipline_version d ON d.id = e.discipline_version_id
      JOIN sports.format_version f ON f.id = e.format_version_id
      WHERE e.id = ${eventId}`.execute(ctx.trx);
    return rows[0];
  });
  if (row === undefined || row.spec.specVersion !== 2) return;
  const engine = formatEngine(row.engine_id, row.engine_version);
  if (engine === undefined || row.n < engine.minParticipants) return;
  const requirements = advancementRequirements(engine, row.spec, row.format_config, row.n);
  const scoring = new ScoringStore(db);
  const pin = await scoring.scoring({ actorAccountId, eventId });
  if (pin.pinned && (!requirements.required || pin.advancementPolicy != null)) return;
  const policy = ADVANCEMENT_POLICY_TEMPLATES.find(
    (p) => advancementCompatibility(requirements, p.spec).length === 0,
  );
  const ruleset = RULESET_TEMPLATES.find((t) =>
    row.spec.capabilities?.rulesetFamilies.includes(t.spec.family),
  );
  if (policy === undefined || ruleset === undefined)
    throw new Error('fixture has no compatible scoring');
  const operator = operatorDb();
  const tag = newId().replaceAll('-', '').slice(-8);
  const op = await newTestAccount(new IdentityStore(db), { withPerson: false, label: 'operator' });
  try {
    const result = await new CatalogStore(operator).provision({
      operatorAccountId: op.accountId,
      manifest: {
        sports: [],
        formats: [],
        rulesets: [
          {
            code: `fx-rs-${tag}`,
            name: ruleset.name,
            versions: [{ spec: ruleset.spec, basis: ruleset.basis }],
          },
        ],
        advancementPolicies: [
          {
            code: `fx-ap-${tag}`,
            name: policy.name,
            versions: [{ spec: policy.spec, basis: policy.basis }],
          },
        ],
      },
    });
    if (result.conflicts.length > 0) throw new Error('fixture catalog conflict');
  } finally {
    await operator.destroy();
  }
  const catalog = await new CompetitionReader(db).catalog();
  const p = 'ruleset' in pin ? pin : undefined;
  await scoring.pinScoring({
    actorAccountId,
    eventId,
    rulesetVersionId:
      p?.ruleset?.versionId ??
      catalog.rulesetVersions.find((v) => v.code === `fx-rs-${tag}`)!.versionId,
    classificationTemplateVersionId: p?.classificationTemplate?.versionId ?? null,
    schedulingProfileVersionId: p?.schedulingProfile?.versionId ?? null,
    stageOverrides: p?.stageOverrides ?? {},
    advancementPolicyVersionId: requirements.required
      ? catalog.advancementPolicyVersions.find((v) => v.code === `fx-ap-${tag}`)!.versionId
      : null,
    idempotencyKey: `fixture-${newId()}`,
  });
}
