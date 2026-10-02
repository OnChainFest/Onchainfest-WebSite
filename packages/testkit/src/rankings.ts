import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  bootstrapDatabase,
  createDb,
  databaseUrls,
  devRolePasswords,
  migrate,
  rankingOperatorDatabaseUrl,
  rankingWorkerDatabaseUrl,
  type Db,
} from '@br/persistence';
import type {
  AchievementRuleSpec,
  QualificationDerivationSnapshot,
  SnapshotQualification,
} from '@br/achievements';
import type { FixtureRuleIdentity } from '@br/achievements/fixtures';
import type { VerificationLevel } from '@br/domain';
import { sql } from 'kysely';
import pg from 'pg';
import { TEST_DATABASE } from './index';

/**
 * BRT-10 test logins and the REFERENCE PERSISTENCE FIXTURE lane (persistence foundation, Step 4).
 *
 *   ┌──────────────────────────────────────────────────────────────────────────────────────┐
 *   │ REFERENCE FIXTURE PERSISTENCE ENVIRONMENT — NOT CANONICAL SPORTING TRUTH              │
 *   │ A THROWAWAY database (br_rkfx_<hex>) is created, migrated with the NORMAL migrations, │
 *   │ then given the test-only overlay that relaxes ONLY the ranking run / snapshot         │
 *   │ provenance CHECKs. It is dropped after use. The API, web, worker and seeds never      │
 *   │ connect to it; no upstream canonical table ever receives a synthetic fact.            │
 *   └──────────────────────────────────────────────────────────────────────────────────────┘
 */
export const RANKING_FIXTURE_DATABASE_PATTERN = /^br_rkfx_[0-9a-f]{12}$/;
const OVERLAY = fileURLToPath(new URL('../sql/ranking-fixture-overlay.sql', import.meta.url));

/** Login br_ranking_operator_app (→ br_ranking_rules only). */
export function rankingOperatorDb(database = TEST_DATABASE): Db {
  const url = rankingOperatorDatabaseUrl(database);
  if (url === undefined) throw new Error('no ranking operator database URL');
  return createDb(url, { max: 2 });
}

/** Login br_ranking_worker_app (→ br_rankings, br_verification_reader). */
export function rankingWorkerDb(database = TEST_DATABASE): Db {
  const url = rankingWorkerDatabaseUrl(database);
  if (url === undefined) throw new Error('no ranking worker database URL');
  return createDb(url, { max: 2 });
}

function withDb(base: string, database: string) {
  const u = new URL(base);
  u.pathname = `/${database}`;
  return u.toString();
}

export interface RankingFixtureDatabase {
  readonly database: string;
  readonly destroy: () => Promise<void>;
}

/** Creates a THROWAWAY database with the normal bootstrap + migrations + the test-only overlay. */
export async function createRankingFixtureDatabase(): Promise<RankingFixtureDatabase> {
  const database = `br_rkfx_${randomBytes(6).toString('hex')}`;
  await bootstrapDatabase(databaseUrls().admin, [database], devRolePasswords());
  await migrate(withDb(databaseUrls().owner, database));
  const client = new pg.Client({ connectionString: withDb(databaseUrls().owner, database) });
  await client.connect();
  try {
    await client.query(readFileSync(OVERLAY, 'utf8'));
  } finally {
    await client.end();
  }
  return { database, destroy: () => dropRankingFixtureDatabase(database) };
}

export async function dropRankingFixtureDatabase(database: string): Promise<void> {
  if (!RANKING_FIXTURE_DATABASE_PATTERN.test(database))
    throw new Error(`refusing to drop ${database}: not a throwaway ranking fixture database`);
  const admin = new pg.Client({ connectionString: databaseUrls().admin });
  await admin.connect();
  try {
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(database)}`);
  } finally {
    await admin.end();
  }
}

// ───────────────────────────── BRT-10 Step 9: the QUALIFIED fixture lane ─────────────────────────────

const ACHIEVEMENT_OVERLAY = fileURLToPath(
  new URL('../sql/achievement-fixture-overlay.sql', import.meta.url),
);

/**
 * ┌──────────────────────────────────────────────────────────────────────────────────────────┐
 * │ REFERENCE FIXTURE PERSISTENCE ENVIRONMENT — NOT CANONICAL SPORTING TRUTH                  │
 * │ QUALIFIED needs fixture snapshots AND fixture Achievements in ONE throwaway database: a   │
 * │ br_rkfx_<hex> database, migrated normally, with the ranking overlay AND the achievement   │
 * │ overlay (provenance CHECKs only). TARGET_QUALIFICATION_AUTHORITY, FINAL, V3 and hold are   │
 * │ synthetic, in memory; nothing upstream is written. Dropped after use.                    │
 * └──────────────────────────────────────────────────────────────────────────────────────────┘
 */
export async function createQualifiedFixtureDatabase(): Promise<RankingFixtureDatabase> {
  const fx = await createRankingFixtureDatabase();
  const client = new pg.Client({ connectionString: withDb(databaseUrls().owner, fx.database) });
  await client.connect();
  try {
    await client.query(readFileSync(ACHIEVEMENT_OVERLAY, 'utf8'));
  } finally {
    await client.end();
  }
  return fx;
}

/** One published snapshot as stored (id, hash, lineage, entries) — read back for a fixture snapshot. */
export interface StoredSnapshot {
  readonly snapshotId: string;
  readonly snapshotHash: string;
  readonly systemId: string;
  readonly systemVersionId: string;
  readonly specHash: string;
  readonly runId: string;
  readonly runOutcomeHash: string;
  readonly lineageKind: 'INITIAL' | 'FOLLOWS' | 'CORRECTS';
  readonly priorSnapshotId?: string;
  readonly priorSnapshotHash?: string;
  readonly entries: readonly {
    readonly holder: { readonly holderType: 'ATHLETE' | 'TEAM'; readonly holderId: string };
    readonly rank: number;
    readonly tied: boolean;
    readonly basis: readonly Record<string, unknown>[];
  }[];
}

export async function storedSnapshot(db: Db, snapshotId: string): Promise<StoredSnapshot> {
  const { rows } = await sql<{
    snapshot_hash: string;
    system_id: string;
    system_version_id: string;
    spec_hash: string;
    run_id: string;
    run_outcome_hash: string;
    lineage_kind: 'INITIAL' | 'FOLLOWS' | 'CORRECTS';
    prior_id: string | null;
    prior_snapshot_hash: string | null;
    content: { entries: StoredSnapshot['entries'] };
  }>`
    SELECT snapshot_hash, system_id::text AS system_id, system_version_id::text AS system_version_id, spec_hash,
           run_id::text AS run_id, run_outcome_hash, lineage_kind,
           COALESCE(previous_snapshot_id, corrects_snapshot_id)::text AS prior_id, prior_snapshot_hash, content
    FROM ranking.snapshot WHERE id = ${snapshotId}`.execute(db);
  const r = rows[0];
  if (r === undefined) throw new Error(`snapshot ${snapshotId} not found`);
  return {
    snapshotId,
    snapshotHash: r.snapshot_hash,
    systemId: r.system_id,
    systemVersionId: r.system_version_id,
    specHash: r.spec_hash,
    runId: r.run_id,
    runOutcomeHash: r.run_outcome_hash,
    lineageKind: r.lineage_kind,
    ...(r.prior_id === null ? {} : { priorSnapshotId: r.prior_id }),
    ...(r.prior_snapshot_hash === null ? {} : { priorSnapshotHash: r.prior_snapshot_hash }),
    entries: r.content.entries,
  };
}

/**
 * A REFERENCE_FIXTURE QUALIFIED derivation snapshot over one STORED fixture snapshot: the snapshot's
 * real id / hash / lineage / entries, the real (published, bound) rule and DisciplineVersion — plus
 * the synthetic facts with no producer: staleness CURRENT (the snapshot's synthetic pins are unknown
 * to canonical tables), hold known and absent, and the target authority's adoption (labelled).
 */
export function qualificationFixtureSnapshot(input: {
  readonly snapshot: StoredSnapshot;
  readonly rule: FixtureRuleIdentity & {
    readonly specHash: string;
    readonly spec: AchievementRuleSpec;
  };
  readonly discipline: QualificationDerivationSnapshot['discipline'];
  readonly targetCompetitionId: string;
  readonly correctedBySnapshotId?: string;
  readonly hold?: boolean;
  readonly adoption?: Partial<NonNullable<SnapshotQualification['targetAuthority']>> | null;
}): QualificationDerivationSnapshot {
  const s = input.snapshot;
  return {
    provenance: 'REFERENCE_FIXTURE',
    assembler: 'reference-fixture/1',
    supportedFactKinds: [
      'RESULT_STATUS',
      'VERIFICATION',
      'CONTEST_OCCURRENCE',
      'HOLD_STATE',
      'TARGET_QUALIFICATION_AUTHORITY',
    ],
    discipline: input.discipline,
    rule: {
      ruleId: input.rule.ruleId,
      ruleVersionId: input.rule.ruleVersionId,
      code: input.rule.code,
      version: input.rule.version,
      specHash: input.rule.specHash,
      spec: input.rule.spec,
      bindingId: input.rule.bindingId,
    },
    qualification: {
      ranking: {
        systemId: s.systemId,
        systemVersionId: s.systemVersionId,
        specHash: s.specHash,
        runId: s.runId,
        runOutcomeHash: s.runOutcomeHash,
        published: {
          snapshotId: s.snapshotId,
          snapshotHash: s.snapshotHash,
          lineageKind: s.lineageKind,
          ...(s.priorSnapshotId === undefined ? {} : { priorSnapshotId: s.priorSnapshotId }),
          ...(s.priorSnapshotHash === undefined ? {} : { priorSnapshotHash: s.priorSnapshotHash }),
        },
        ...(input.correctedBySnapshotId === undefined
          ? {}
          : { correctedBySnapshotId: input.correctedBySnapshotId }),
        staleness: { state: 'CURRENT' },
        entries: s.entries.map((e) => ({
          holder: e.holder,
          rank: e.rank,
          tied: e.tied,
          basis: e.basis.map((b) => ({
            resultVersionId: b.resultVersionId as string,
            contentHash: b.contentHash as string,
            participantId: b.participantId as string,
            verificationRunId: b.verificationRunId as string,
            verificationSnapshotHash: b.verificationSnapshotHash as string,
            verificationOutcomeHash: b.verificationOutcomeHash as string,
            verificationLevel: b.verificationLevel as VerificationLevel,
            evidenceBundleHash: b.evidenceBundleHash as string,
            evidenceBundleAsOf: b.evidenceBundleAsOf as string,
          })),
        })),
      },
      hold: { active: input.hold ?? false },
      ...(input.adoption === null
        ? {}
        : {
            targetAuthority: {
              targetCompetitionId: input.targetCompetitionId,
              ruleVersionId: input.rule.ruleVersionId,
              ruleSpecHash: input.rule.specHash,
              adoptionId: '00000000-0000-8000-a000-00000000ad09',
              adoptionHash: `sha256:${'ad'.repeat(32)}`,
              status: 'ADOPTED',
              ...(input.adoption ?? {}),
            },
          }),
    },
  };
}
