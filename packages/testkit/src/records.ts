import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALL_DERIVATION_FACT_KINDS, newId } from '@br/domain';
import type { AchievementDerivationSnapshot, AchievementRuleSpec } from '@br/achievements';
import { fixtureRule, type FixtureRuleIdentity } from '@br/achievements/fixtures';
import type { RecordCategorySpec, RecordEvaluationSnapshot } from '@br/records';
import {
  AchievementRuleStore,
  achievementOperatorDatabaseUrl,
  bootstrapDatabase,
  CatalogStore,
  createDb,
  databaseUrls,
  devRolePasswords,
  IdentityStore,
  migrate,
  operatorDatabaseUrl,
  RecordCategoryStore,
  recordOperatorDatabaseUrl,
  recordWorkerDatabaseUrl,
  type Db,
} from '@br/persistence';
import pg from 'pg';
import { sql } from 'kysely';
import { BOWLING_LIKE_SPEC } from './achievements';
import { newTestAccount, RUNNING_5K_SPEC, TEST_DATABASE } from './index';
import { dropThrowawayFixtureDatabase } from './throwaway-database';

/**
 * BRT-09 test harness for RecordCategories and for the REFERENCE PERSISTENCE FIXTURE lane.
 *
 *   ┌──────────────────────────────────────────────────────────────────────────────────────┐
 *   │ REFERENCE FIXTURE PERSISTENCE ENVIRONMENT — NOT CANONICAL SPORTING TRUTH              │
 *   │ A THROWAWAY database (br_recfx_<hex>) is created, migrated with the NORMAL migrations,│
 *   │ then given the test-only overlays that relax ONLY the record / achievement provenance │
 *   │ CHECKs. It is dropped after use. The API, web, worker and seeds never connect to it;  │
 *   │ no upstream canonical table ever receives a synthetic fact or a synthetic attestation.│
 *   └──────────────────────────────────────────────────────────────────────────────────────┘
 */
export const RECORD_FIXTURE_ENVIRONMENT_BANNER = [
  'REFERENCE FIXTURE PERSISTENCE ENVIRONMENT (RECORDS)',
  'NOT CANONICAL SPORTING TRUTH',
  'DATABASE WILL BE DESTROYED',
] as const;
export const RECORD_FIXTURE_DATABASE_PATTERN = /^br_recfx_[0-9a-f]{12}$/;

const OVERLAYS = [
  fileURLToPath(new URL('../sql/achievement-fixture-overlay.sql', import.meta.url)),
  fileURLToPath(new URL('../sql/record-fixture-overlay.sql', import.meta.url)),
];

/** Login br_record_operator_app on the normal integration database (→ br_record_rules). */
export function recordOperatorDb(database = TEST_DATABASE): Db {
  const url = recordOperatorDatabaseUrl(database);
  if (url === undefined) throw new Error('no record operator database URL');
  return createDb(url, { max: 2 });
}

/** Login br_record_worker_app on the normal integration database (→ br_records, br_verification_reader). */
export function recordWorkerDb(database = TEST_DATABASE): Db {
  const url = recordWorkerDatabaseUrl(database);
  if (url === undefined) throw new Error('no record worker database URL');
  return createDb(url, { max: 4 });
}

function url(base: string, database: string) {
  const u = new URL(base);
  u.pathname = `/${database}`;
  return u.toString();
}

export async function applyRecordFixtureOverlays(database: string): Promise<void> {
  if (!RECORD_FIXTURE_DATABASE_PATTERN.test(database))
    throw new Error(`refusing to apply the record fixture overlays to ${database}`);
  const client = new pg.Client({ connectionString: url(databaseUrls().owner, database) });
  await client.connect();
  try {
    for (const f of OVERLAYS) await client.query(readFileSync(f, 'utf8'));
  } finally {
    await client.end();
  }
}

export async function dropRecordFixtureDatabase(database: string): Promise<void> {
  // Waits for the database's own sessions to close before terminating stragglers (see
  // dropThrowawayFixtureDatabase): terminating a pool client mid-close is an unhandled 57P01.
  await dropThrowawayFixtureDatabase(database, RECORD_FIXTURE_DATABASE_PATTERN);
}

export interface RecordFixtureEnvironment {
  readonly database: string;
  readonly overlay: boolean;
  /** br_api login (may SET br_records, br_achievements, br_public_read, …). */
  readonly api: Db;
  readonly recordWorker: Db;
  readonly maintenance: Db;
  readonly probe: Db;
  readonly owner: Db;
  readonly categoryOperator: Db;
  readonly categories: RecordCategoryStore;
  readonly rules: AchievementRuleStore;
  readonly identity: IdentityStore;
  readonly operatorAccountId: string;
  readonly dv: {
    readonly running: { readonly id: string; readonly sport: string; readonly discipline: string };
    readonly bowling: { readonly id: string; readonly sport: string; readonly discipline: string };
  };
  readonly destroy: () => Promise<void>;
}

/** Creates a THROWAWAY database with the normal bootstrap + migrations (+ the test-only overlays). */
export async function createRecordFixtureEnvironment(
  options: { overlay?: boolean } = {},
): Promise<RecordFixtureEnvironment> {
  const database = `br_recfx_${randomBytes(6).toString('hex')}`;
  await bootstrapDatabase(databaseUrls().admin, [database], devRolePasswords());
  await migrate(url(databaseUrls().owner, database));
  const overlay = options.overlay ?? true;
  if (overlay) await applyRecordFixtureOverlays(database);
  const urls = databaseUrls(database);
  const api = createDb(urls.api, { max: 24 });
  const recordWorker = createDb(recordWorkerDatabaseUrl(database) as string, { max: 4 });
  const maintenance = createDb(urls.maintenance, { max: 2 });
  const probe = createDb(urls.probe, { max: 1 });
  const owner = createDb(urls.owner, { max: 2 });
  const categoryOperator = createDb(recordOperatorDatabaseUrl(database) as string, { max: 2 });
  const ruleOperator = createDb(achievementOperatorDatabaseUrl(database) as string, { max: 2 });
  const catalogOperator = createDb(operatorDatabaseUrl(database) as string, { max: 2 });
  const identity = new IdentityStore(api);
  const catalog = new CatalogStore(catalogOperator);
  const op = (await newTestAccount(identity, { withPerson: false, label: 'record-operator' }))
    .accountId;
  const k = () => `rfx-${newId()}`;
  const dvOf = async (sportCode: string, code: string, spec: typeof RUNNING_5K_SPEC) => {
    const { sportId } = await catalog.createSport({
      operatorAccountId: op,
      code: sportCode,
      name: sportCode,
      idempotencyKey: k(),
    });
    const discipline = `${sportCode}.${code}`;
    const { disciplineId } = await catalog.createDiscipline({
      operatorAccountId: op,
      sportId,
      code: discipline,
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
    return { id: disciplineVersionId, sport: sportCode, discipline };
  };
  const dv = {
    running: await dvOf('fixturerunning', 'sprint', RUNNING_5K_SPEC),
    bowling: await dvOf('fixturebowling', 'series', BOWLING_LIKE_SPEC),
  };
  await catalogOperator.destroy();
  return {
    database,
    overlay,
    api,
    recordWorker,
    maintenance,
    probe,
    owner,
    categoryOperator,
    categories: new RecordCategoryStore(categoryOperator),
    rules: new AchievementRuleStore(ruleOperator),
    identity,
    operatorAccountId: op,
    dv,
    destroy: async () => {
      await Promise.all(
        [api, recordWorker, maintenance, probe, owner, categoryOperator, ruleOperator].map((d) =>
          d.destroy(),
        ),
      );
      await dropRecordFixtureDatabase(database);
    },
  };
}

/** Creates, versions and publishes a category through the dedicated operator store. */
export async function publishRecordCategory(
  store: RecordCategoryStore,
  operatorAccountId: string,
  spec: RecordCategorySpec,
  options: { code?: string; categoryId?: string; publish?: boolean } = {},
) {
  const code = options.code ?? `rc-${newId().replace(/-/g, '').slice(-12)}`;
  const categoryId =
    options.categoryId ??
    (
      await store.createCategory({
        operatorAccountId,
        code,
        name: `Fictional ${spec.scope.scopeType.toLowerCase()} category`,
        scopeType: spec.scope.scopeType,
        idempotencyKey: `rc-${newId()}`,
      })
    ).categoryId;
  const v = await store.createCategoryVersion({
    operatorAccountId,
    categoryId,
    spec,
    idempotencyKey: `rcv-${newId()}`,
  });
  if (options.publish !== false)
    await store.changeVersionStatus({
      operatorAccountId,
      categoryVersionId: v.categoryVersionId,
      status: 'PUBLISHED',
    });
  return {
    categoryId,
    code,
    categoryVersionId: v.categoryVersionId,
    version: v.version,
    specHash: v.specHash,
  };
}

/** An effectiveFrom safely after publication (the database never accepts a backdated category). */
export const futureInstant = (seconds = 60) => new Date(Date.now() + seconds * 1000).toISOString();
export const plusMinutes = (iso: string, minutes: number) =>
  new Date(Date.parse(iso) + minutes * 60_000).toISOString();

/**
 * REFERENCE FIXTURE RECORD_SET derivation snapshot for a persisted fixture mark: the same
 * Performance basis the record snapshot evaluated, plus the mark pin read back from the throwaway
 * database (mark hash, ratification entry + hash). Never persisted sporting truth.
 */
export async function recordSetSnapshotFor(
  owner: Db,
  input: {
    readonly recordMarkId: string;
    readonly recordSnapshot: RecordEvaluationSnapshot;
    readonly ruleSpec: AchievementRuleSpec;
    readonly ruleIdentity: FixtureRuleIdentity;
  },
): Promise<AchievementDerivationSnapshot> {
  const { rows } = await sql<{
    mark_hash: string;
    category_id: string;
    category_version_id: string;
    category_spec_hash: string;
    scope_type: string;
    latest: string;
    rat_id: string | null;
    rat_status: 'RATIFIED' | 'CANONICAL' | null;
    rat_hash: string | null;
  }>`
    SELECT m.mark_hash, m.category_id, m.category_version_id, m.category_spec_hash, m.scope_type,
           (SELECT s.status FROM record.mark_status_entry s WHERE s.record_mark_id = m.id ORDER BY s.seq DESC LIMIT 1) AS latest,
           r.id AS rat_id, r.status AS rat_status, r.ratification_hash AS rat_hash
    FROM record.record_mark m
    LEFT JOIN record.mark_status_entry r ON r.record_mark_id = m.id AND r.ratification_ref IS NOT NULL
    WHERE m.id = ${input.recordMarkId}`.execute(owner);
  const m = rows[0];
  if (m === undefined) throw new Error('fixture mark not found');
  const s = input.recordSnapshot;
  const p = s.performance;
  const spec = s.category.spec;
  const holder =
    p.participantKind === 'INDIVIDUAL'
      ? { holderType: 'ATHLETE' as const, holderId: p.athleteId as string }
      : { holderType: 'TEAM' as const, holderId: p.teamId as string };
  const floor =
    spec.scope.scopeType === 'NATIONAL' ||
    spec.scope.scopeType === 'CONTINENTAL' ||
    spec.scope.scopeType === 'WORLD' ||
    spec.requirements.minimumVerificationLevel === 'V4'
      ? 'V4'
      : 'V3';
  return {
    provenance: 'REFERENCE_FIXTURE',
    assembler: 'reference-fixture/1',
    rule: fixtureRule(input.ruleSpec, 'record-set', input.ruleIdentity.version, input.ruleIdentity),
    // TARGET_QUALIFICATION_AUTHORITY (BRT-10) belongs to QUALIFIED fixtures only.
    supportedFactKinds: ALL_DERIVATION_FACT_KINDS.filter(
      (k) => k !== 'TARGET_QUALIFICATION_AUTHORITY',
    ),
    discipline: {
      disciplineVersionId: s.discipline.disciplineVersionId,
      ...(s.discipline.sport === undefined ? {} : { sport: s.discipline.sport }),
      ...(s.discipline.discipline === undefined ? {} : { discipline: s.discipline.discipline }),
      metrics: s.discipline.metrics,
    },
    hierarchy: {
      competitionId: p.competitionId,
      ...(p.eventId === undefined ? {} : { eventId: p.eventId }),
      ...(p.contestId === undefined ? {} : { contestId: p.contestId }),
    },
    resultVersion: {
      resultVersionId: p.resultVersionId,
      resultId: p.resultId,
      versionNumber: 1,
      contentHash: p.contentHash,
      scopeType: 'CONTEST',
      scopeTargetId: p.contestId ?? p.resultId,
      submittedAt: p.occurredAt ?? new Date().toISOString(),
      status: p.status,
      ...(p.supersedesVersionId === undefined
        ? {}
        : { supersedesVersionId: p.supersedesVersionId }),
      ...(p.supersededByVersionId === undefined
        ? {}
        : { supersededByVersionId: p.supersededByVersionId }),
    },
    verification: s.verification,
    hold: { active: false },
    entries: [{ participantId: p.participantId, outcome: 'RANKED', rank: 1 }],
    performances: [
      {
        participantId: p.participantId,
        ordinal: p.ordinal,
        mark: p.mark,
        valid: p.valid,
        ...(p.performanceAthleteId === undefined ? {} : { athleteId: p.performanceAthleteId }),
      },
    ],
    participants: [
      {
        participantId: p.participantId,
        kind: p.participantKind,
        ...(p.athleteId === undefined ? {} : { athleteId: p.athleteId }),
        ...(p.teamId === undefined ? {} : { teamId: p.teamId }),
      },
    ],
    ...(s.creditedLineup === undefined
      ? {}
      : {
          creditedLineups: [
            { participantId: p.participantId, athleteIds: s.creditedLineup.athleteIds },
          ],
        }),
    ...(p.occurredAt === undefined ? {} : { occurrence: { startedAt: p.occurredAt } }),
    ...(m.rat_id === null || m.rat_status === null || m.rat_hash === null
      ? {}
      : {
          record: {
            recordMarkId: input.recordMarkId,
            markHash: m.mark_hash,
            categoryId: m.category_id,
            categoryVersionId: m.category_version_id,
            categoryVersionHash: m.category_spec_hash,
            scopeType: m.scope_type as never,
            standing: m.rat_status,
            ratificationEntryId: m.rat_id,
            ratificationHash: m.rat_hash,
            recognitionLevel: spec.recognition.level,
            currentStatus: m.latest as never,
            requiredLevel: floor,
            holder,
            participantId: p.participantId,
            performanceOrdinal: p.ordinal,
            value: p.mark,
          },
        }),
  } as AchievementDerivationSnapshot;
}
