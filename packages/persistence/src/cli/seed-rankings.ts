import type { DisciplineVersionSpec } from '@br/competition';
import { PLATFORM_RANKING_LABEL, RANKING_PLATFORM_FLOOR } from '@br/domain';
import { RANKING_ENGINE_VERSION, type RankingSystemSpec } from '@br/rankings';
import { sql } from 'kysely';
import { databaseUrls, rankingOperatorDatabaseUrl } from '../config';
import { createDb } from '../db';
import { IdentityStore } from '../identity-store';
import { RankingDefinitionStore } from '../ranking-definition-store';
import { inTransaction, ModuleRole } from '../tx';

/**
 * BRT-10 development seed — CANONICAL ONLY. ALL DATA IS FICTIONAL. It never enables any fixture lane
 * and never creates a ranking run, snapshot, classification, QUALIFIED Achievement, prize, trophy,
 * payout, entry, seeding or advancement.
 *
 * Builds on `pnpm db:seed:competition` (the published running.5k DisciplineVersion). Through the
 * dedicated operator login (br_ranking_operator_app → br_ranking_rules) and the validated
 * RankingDefinitionStore it creates and publishes ONE fictional development reference definition
 * (not a universal standard):
 *   br-dev-5k-best-marks   PLATFORM · BEST_MARK · running.5k elapsedTimeMs (comparator copied from the
 *                          pinned DisciplineVersion) · ATHLETE · CONTEST · unrestricted universe ·
 *                          V2 · FINAL · hold blocks (the BRT-01 platform floor, not raised)
 * No OFFICIAL system is seeded: the development seeds anchor only PLATFORM-level principals, and the
 * platform never manufactures an owner, trust anchor or publication authority (ADR-0048 §6).
 *
 * Idempotent: fixed code / provider subject / idempotency keys; an existing version is reused (a
 * version is never re-created with a different effectiveFrom) and an already PUBLISHED one is left as
 * is.
 */
if (process.env.NODE_ENV === 'production') throw new Error('development seed refuses production');
const DISCIPLINE = 'running.5k';
const CODE = 'br-dev-5k-best-marks';
const METRIC = { key: 'elapsedTimeMs', markMetricId: 'running.elapsed_time_ms' } as const;

const db = createDb(databaseUrls().api, { max: 2 });
const opUrl = rankingOperatorDatabaseUrl();
if (opUrl === undefined) throw new Error('no ranking operator database URL');
const op = createDb(opUrl, { max: 2 });
const owner = createDb(databaseUrls().owner, { max: 1 });
const identity = new IdentityStore(db);
const definitions = new RankingDefinitionStore(op);

try {
  // Read under the operator's own module role: the exact catalog facts the store validates against.
  const found = await inTransaction(op, ModuleRole.rankingRules, async (ctx) => {
    const { rows } = await sql<{ id: string; sport: string; spec: DisciplineVersionSpec }>`
      SELECT v.id, s.code AS sport, v.spec FROM sports.discipline_version v
      JOIN sports.discipline d ON d.id = v.discipline_id JOIN sports.sport s ON s.id = d.sport_id
      JOIN sports.v_discipline_version_current c ON c.discipline_version_id = v.id
      WHERE d.code = ${DISCIPLINE} AND c.status = 'PUBLISHED' ORDER BY v.recorded_at LIMIT 1`.execute(
      ctx.trx,
    );
    return rows[0];
  });
  if (found === undefined)
    throw new Error(
      `run \`pnpm db:seed:competition\` first (no PUBLISHED ${DISCIPLINE} DisciplineVersion)`,
    );
  // The comparator is the DisciplineVersion's own key for the universe metric, never declared here.
  const key = found.spec.comparator.keys.find((k) => k.metric === METRIC.key);
  if (key === undefined)
    throw new Error(`${DISCIPLINE} declares no comparator key for ${METRIC.key}`);

  const { accountId: operator } = await identity.signIn({
    provider: 'test',
    providerSubject: 'seed:ranking-operator',
    method: 'TEST',
  });
  const { systemId } = await definitions.createRankingSystem({
    operatorAccountId: operator,
    code: CODE,
    name: 'Fictional 5K best marks (development reference)',
    kind: 'PLATFORM',
    idempotencyKey: `seed:ranking:${CODE}`,
  });
  const latest = async () =>
    (
      await sql<{
        id: string;
        version: number;
        status: string;
        spec: RankingSystemSpec;
        spec_hash: string;
        universe_hash: string;
      }>`
        SELECT v.id, v.version, c.status, v.spec, v.spec_hash, v.universe_hash FROM ranking.system_version v
        JOIN ranking.v_system_version_current c ON c.system_version_id = v.id
        WHERE v.system_id = ${systemId} ORDER BY v.version DESC LIMIT 1`.execute(owner)
    ).rows[0];
  let version = await latest();
  if (version === undefined) {
    const spec: RankingSystemSpec = {
      targetEngine: RANKING_ENGINE_VERSION,
      displayName: 'Fictional 5K best marks',
      kind: 'PLATFORM',
      method: 'BEST_MARK',
      universe: {
        disciplineVersionId: found.id,
        metric: METRIC,
        resultScope: 'CONTEST',
        holderType: 'ATHLETE',
        population: {},
      },
      comparator: { keys: [key] },
      requirements: { minimumVerificationLevel: 'V2', minimumResultStatus: 'FINAL' },
      recognition: { level: 'PLATFORM', sport: [found.sport] },
      effectiveFrom: new Date(Date.now() + 60_000).toISOString(),
    };
    await definitions.createRankingSystemVersion({
      operatorAccountId: operator,
      systemId,
      spec,
      idempotencyKey: `seed:ranking:${CODE}:v1`,
    });
    version = await latest();
  }
  if (version === undefined) throw new Error('the seeded ranking system version is missing');
  if (version.status === 'DRAFT')
    await definitions.changeRankingSystemVersionStatus({
      operatorAccountId: operator,
      systemVersionId: version.id,
      status: 'PUBLISHED',
    });
  version = await latest();
  if (version === undefined) throw new Error('the seeded ranking system version is missing');

  const { rows: counts } = await sql<{
    runs: number;
    snapshots: number;
    fixtureRows: number;
  }>`
    SELECT (SELECT count(*) FROM ranking.run r JOIN ranking.system s ON s.id = r.system_id
              WHERE s.code = ${CODE})::int AS runs,
           (SELECT count(*) FROM ranking.snapshot)::int AS snapshots,
           ((SELECT count(*) FROM ranking.run WHERE provenance <> 'CANONICAL_ASSEMBLY')
             + (SELECT count(*) FROM ranking.snapshot WHERE provenance <> 'CANONICAL_ASSEMBLY'))::int AS "fixtureRows"`.execute(
    owner,
  );
  const s = version.spec;
  console.log(
    JSON.stringify(
      {
        fictionalDataOnly: true,
        lane: 'CANONICAL PRODUCTION ASSEMBLY (no fixture lane is ever enabled by this seed)',
        rankingSystems: [
          {
            code: CODE,
            kind: s.kind,
            label: PLATFORM_RANKING_LABEL,
            version: version.version,
            lifecycle: version.status,
            effectiveFrom: s.effectiveFrom,
            method: s.method,
            universe: {
              discipline: DISCIPLINE,
              metric: s.universe.metric,
              resultScope: s.universe.resultScope,
              holderType: s.universe.holderType,
              competitions: 'unrestricted',
              window: 'unrestricted (no season entity)',
              population: 'none declared',
            },
            comparator: s.comparator.keys,
            requirements: {
              ...s.requirements,
              holdBlocks: RANKING_PLATFORM_FLOOR.PLATFORM.holdBlocks,
            },
            specHash: version.spec_hash,
            universeHash: version.universe_hash,
            note: 'fictional development reference ranking definition — not a universal standard',
          },
        ],
        officialSystems:
          'none seeded: the development seeds anchor only PLATFORM-level principals, and the platform never manufactures an owner, trust anchor or publication authority (ADR-0048 §6)',
        rankingRunsOfSeededSystem: counts[0]?.runs ?? 0,
        rankingSnapshotsInDatabase: counts[0]?.snapshots ?? 0,
        referenceFixtureRankingRowsInDatabase: counts[0]?.fixtureRows ?? 0,
        honestProductionCeiling:
          '0 snapshots: no canonical producer reaches FINAL, V2 or a known, absent hold yet, and running.5k has no events (no heat format) — `pnpm demo:rankings` shows the BLOCKED canonical run',
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.all([db.destroy(), op.destroy(), owner.destroy()]);
}
