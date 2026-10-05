import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AchievementRuleSpec } from '@br/achievements';
import type { FixtureRuleIdentity } from '@br/achievements/fixtures';
import type { DisciplineVersionSpec } from '@br/competition';
import { newId } from '@br/domain';
import {
  AchievementRuleStore,
  achievementOperatorDatabaseUrl,
  achievementWorkerDatabaseUrl,
  bootstrapDatabase,
  CatalogStore,
  createDb,
  databaseUrls,
  devRolePasswords,
  IdentityStore,
  migrate,
  operatorDatabaseUrl,
  type Db,
} from '@br/persistence';
import pg from 'pg';
import { newTestAccount, PADEL_DOUBLES_SPEC, RUNNING_5K_SPEC, TEST_DATABASE } from './index';
import { dropThrowawayFixtureDatabase } from './throwaway-database';

/**
 * BRT-08 test harness for AchievementRules and for the REFERENCE PERSISTENCE FIXTURE lane.
 *
 *   ┌──────────────────────────────────────────────────────────────────────────────────────┐
 *   │ REFERENCE FIXTURE PERSISTENCE ENVIRONMENT — NOT CANONICAL SPORTING TRUTH              │
 *   │ A THROWAWAY database (br_achfx_<hex>) is created, migrated with the NORMAL migrations,│
 *   │ then (optionally) given the test-only overlay that relaxes ONLY the Achievement       │
 *   │ provenance CHECKs. It is dropped after use. The API, web, worker and seeds never      │
 *   │ connect to it; no upstream canonical table ever receives a synthetic fact.            │
 *   └──────────────────────────────────────────────────────────────────────────────────────┘
 */
export const FIXTURE_ENVIRONMENT_BANNER = [
  'REFERENCE FIXTURE PERSISTENCE ENVIRONMENT',
  'NOT CANONICAL SPORTING TRUTH',
  'DATABASE WILL BE DESTROYED',
] as const;

const OVERLAY_FILE = fileURLToPath(
  new URL('../sql/achievement-fixture-overlay.sql', import.meta.url),
);
export const FIXTURE_DATABASE_PATTERN = /^br_achfx_[0-9a-f]{12}$/;

/** Login br_achievement_operator_app on the normal integration database (→ br_achievement_rules). */
export function achievementOperatorDb(database = TEST_DATABASE): Db {
  const url = achievementOperatorDatabaseUrl(database);
  if (url === undefined) throw new Error('no achievement operator database URL');
  return createDb(url, { max: 2 });
}

/** Login br_achievement_worker_app on the normal integration database (→ br_achievements, br_verification). */
export function achievementWorkerDb(database = TEST_DATABASE): Db {
  const url = achievementWorkerDatabaseUrl(database);
  if (url === undefined) throw new Error('no achievement worker database URL');
  return createDb(url, { max: 4 });
}

/** A fictional bowling-like DisciplineVersion (game score has no comparator order; series does). */
export const BOWLING_LIKE_SPEC: DisciplineVersionSpec = {
  resultSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['score'],
    properties: {
      score: { type: 'integer', minimum: 0, maximum: 300 },
      seriesPins: { type: 'integer', minimum: 0, maximum: 900 },
    },
  },
  metrics: [
    { key: 'score', valueType: 'INTEGER', unit: 'pins' },
    { key: 'seriesPins', valueType: 'INTEGER', unit: 'pins' },
  ],
  comparator: {
    outcomeModel: 'SCORED_RANKED',
    primary: 'METRICS',
    keys: [{ metric: 'seriesPins', order: 'HIGHER_IS_BETTER' }],
  },
  validation: { bounds: [{ metric: 'score', min: '0', max: '300' }] },
  allowedContestTypes: ['SERIES'],
  participation: { participantKinds: ['INDIVIDUAL'], lineupSize: { min: 1, max: 1 } },
};

/** Creates, versions, publishes and binds a rule through the dedicated operator store. */
export async function publishAchievementRule(
  rules: AchievementRuleStore,
  operatorAccountId: string,
  spec: AchievementRuleSpec,
  options: { code?: string; competitionId?: string; eventId?: string; effectiveFrom?: Date } = {},
): Promise<FixtureRuleIdentity & { specHash: string }> {
  const code = options.code ?? `rule-${newId().replace(/-/g, '').slice(-12)}`;
  const { ruleId } = await rules.createRule({
    operatorAccountId,
    code,
    name: `Fictional ${spec.achievementType.toLowerCase()} rule`,
    achievementType: spec.achievementType,
    idempotencyKey: `ar-${newId()}`,
  });
  const v = await rules.createRuleVersion({
    operatorAccountId,
    ruleId,
    spec,
    idempotencyKey: `arv-${newId()}`,
  });
  await rules.changeVersionStatus({
    operatorAccountId,
    ruleVersionId: v.ruleVersionId,
    status: 'PUBLISHED',
  });
  const b = await rules.bindRule({
    operatorAccountId,
    ruleVersionId: v.ruleVersionId,
    ...(options.competitionId === undefined ? {} : { competitionId: options.competitionId }),
    ...(options.eventId === undefined ? {} : { eventId: options.eventId }),
    ...(options.effectiveFrom === undefined ? {} : { effectiveFrom: options.effectiveFrom }),
    idempotencyKey: `arb-${newId()}`,
  });
  return {
    ruleId,
    ruleVersionId: v.ruleVersionId,
    code,
    version: v.version,
    bindingId: b.bindingId,
    specHash: v.specHash,
  };
}

export interface FixturePersistenceEnvironment {
  readonly database: string;
  readonly overlay: boolean;
  /** br_api login on the throwaway database (may SET br_achievements, br_verification, …). */
  readonly api: Db;
  readonly maintenance: Db;
  readonly worker: Db;
  readonly probe: Db;
  readonly owner: Db;
  readonly ruleOperator: Db;
  readonly identity: IdentityStore;
  readonly rules: AchievementRuleStore;
  readonly operatorAccountId: string;
  readonly dv: { readonly padel: string; readonly bowling: string; readonly running: string };
  readonly destroy: () => Promise<void>;
}

function url(base: string, database: string) {
  const u = new URL(base);
  u.pathname = `/${database}`;
  return u.toString();
}

/** Applies the TEST-ONLY overlay as the owner. Refuses anything but a throwaway fixture database. */
export async function applyAchievementFixtureOverlay(database: string): Promise<void> {
  if (!FIXTURE_DATABASE_PATTERN.test(database))
    throw new Error(`refusing to apply the fixture overlay to ${database}`);
  const client = new pg.Client({ connectionString: url(databaseUrls().owner, database) });
  await client.connect();
  try {
    await client.query(readFileSync(OVERLAY_FILE, 'utf8'));
  } finally {
    await client.end();
  }
}

export async function dropThrowawayDatabase(database: string): Promise<void> {
  // Waits for the database's own sessions to close before terminating stragglers (see
  // dropThrowawayFixtureDatabase): terminating a pool client mid-close is an unhandled 57P01.
  await dropThrowawayFixtureDatabase(database, FIXTURE_DATABASE_PATTERN);
}

/**
 * Creates a THROWAWAY database with the normal bootstrap + migrations; with `overlay: true` it then
 * applies the test-only fixture overlay. Returns logins, a real (fictional) catalog and a rule
 * operator. Always call `destroy()`.
 */
export async function createFixturePersistenceEnvironment(
  options: { overlay?: boolean } = {},
): Promise<FixturePersistenceEnvironment> {
  const database = `br_achfx_${randomBytes(6).toString('hex')}`;
  await bootstrapDatabase(databaseUrls().admin, [database], devRolePasswords());
  await migrate(url(databaseUrls().owner, database));
  const overlay = options.overlay ?? true;
  if (overlay) await applyAchievementFixtureOverlay(database);
  const urls = databaseUrls(database);
  const api = createDb(urls.api, { max: 24 });
  const maintenance = createDb(urls.maintenance, { max: 2 });
  const worker = createDb(urls.worker, { max: 4 });
  const probe = createDb(urls.probe, { max: 1 });
  const owner = createDb(urls.owner, { max: 2 });
  const ruleOperator = createDb(achievementOperatorDatabaseUrl(database) as string, { max: 2 });
  const catalogOperator = createDb(operatorDatabaseUrl(database) as string, { max: 2 });
  const identity = new IdentityStore(api);
  const catalog = new CatalogStore(catalogOperator);
  const rules = new AchievementRuleStore(ruleOperator);
  const op = (await newTestAccount(identity, { withPerson: false, label: 'fixture-operator' }))
    .accountId;
  const k = () => `fx-${newId()}`;
  const dvOf = async (sportCode: string, code: string, spec: DisciplineVersionSpec) => {
    const { sportId } = await catalog.createSport({
      operatorAccountId: op,
      code: sportCode,
      name: sportCode,
      idempotencyKey: k(),
    });
    const { disciplineId } = await catalog.createDiscipline({
      operatorAccountId: op,
      sportId,
      code: `${sportCode}.${code}`,
      name: code,
      idempotencyKey: k(),
    });
    const { disciplineVersionId } = await catalog.createDisciplineVersion({
      operatorAccountId: op,
      disciplineId,
      spec,
      idempotencyKey: k(),
    });
    await catalog.publishDisciplineVersion({ operatorAccountId: op, disciplineVersionId });
    return disciplineVersionId;
  };
  const dv = {
    padel: await dvOf('fixturepadel', 'doubles', PADEL_DOUBLES_SPEC),
    bowling: await dvOf('fixturebowling', 'singles', BOWLING_LIKE_SPEC),
    running: await dvOf('fixturerunning', 'fivek', RUNNING_5K_SPEC),
  };
  await catalogOperator.destroy();
  return {
    database,
    overlay,
    api,
    maintenance,
    worker,
    probe,
    owner,
    ruleOperator,
    identity,
    rules,
    operatorAccountId: op,
    dv,
    destroy: async () => {
      await Promise.all(
        [api, maintenance, worker, probe, owner, ruleOperator].map((d) => d.destroy()),
      );
      await dropThrowawayDatabase(database);
    },
  };
}
