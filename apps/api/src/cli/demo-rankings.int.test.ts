import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DomainError, DomainErrorCode } from '@br/domain';
import { CatalogStore, IdentityStore } from '@br/persistence';
import { apiDb, brt10ConsequenceFootprint, operatorDb, ownerDb } from '@br/testkit';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * BRT-10 Step 14 through the real commands: `db:seed:rankings` (twice) and `demo:rankings`, run as
 * child processes exactly as `pnpm` runs them, against the integration database (BR_DATABASE_NAME is
 * inherited from the integration project). The only prerequisite created here is the one the seed
 * documents — the PUBLISHED running.5k DisciplineVersion of `db:seed:competition`, through the same
 * catalog writer, idempotency keys and spec — and nothing else. ALL DATA IS FICTIONAL.
 */
const repo = new URL('../../../../', import.meta.url).pathname;
const tsx = `${repo}node_modules/.bin/tsx`;
const SEED = 'packages/persistence/src/cli/seed-rankings.ts';
const DEMO = 'apps/api/src/cli/demo-rankings.ts';
const CODE = 'br-dev-5k-best-marks';
const exec = promisify(execFile);
const cli = async (script: string) => {
  try {
    const r = await exec(tsx, [script], { cwd: repo, env: process.env, maxBuffer: 16 << 20 });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: x.code ?? 1, out: x.stdout ?? '', err: x.stderr ?? '' };
  }
};

const api = apiDb();
const owner = ownerDb();
const catalogOperator = operatorDb();
afterAll(async () => {
  await Promise.all([api, owner, catalogOperator].map((d) => d.destroy()));
});

/** The documented prerequisite (`db:seed:competition`'s running.5k), with its exact keys and spec. */
const RUNNING: Parameters<CatalogStore['createDisciplineVersion']>[0]['spec'] = {
  resultSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['elapsedTimeMs'],
    properties: { elapsedTimeMs: { type: 'integer', minimum: 0 } },
  },
  metrics: [{ key: 'elapsedTimeMs', valueType: 'DURATION_MS', unit: 'ms' }],
  comparator: {
    outcomeModel: 'RANKED',
    primary: 'METRICS',
    keys: [{ metric: 'elapsedTimeMs', order: 'LOWER_IS_BETTER' }],
  },
  validation: { bounds: [{ metric: 'elapsedTimeMs', min: '600000' }] },
  allowedContestTypes: ['HEAT'],
  participation: { participantKinds: ['INDIVIDUAL'], lineupSize: { min: 1, max: 1 } },
};
beforeAll(async () => {
  const catalog = new CatalogStore(catalogOperator);
  const { accountId: op } = await new IdentityStore(api).signIn({
    provider: 'test',
    providerSubject: 'seed:operator',
    method: 'TEST',
  });
  const { sportId } = await catalog.createSport({
    operatorAccountId: op,
    code: 'running',
    name: 'Running',
    idempotencyKey: 'seed:sport:running',
  });
  const { disciplineId } = await catalog.createDiscipline({
    operatorAccountId: op,
    sportId,
    code: 'running.5k',
    name: 'Running 5K',
    idempotencyKey: 'seed:discipline:running.5k',
  });
  const { disciplineVersionId } = await catalog.createDisciplineVersion({
    operatorAccountId: op,
    disciplineId,
    spec: RUNNING,
    idempotencyKey: 'seed:dv:running.5k:1',
  });
  try {
    await catalog.publishDisciplineVersion({ operatorAccountId: op, disciplineVersionId });
  } catch (err) {
    if (!(err instanceof DomainError && err.code === DomainErrorCode.INVALID_TRANSITION)) throw err;
  }
}, 60_000);

const state = async () =>
  (
    await sql<{
      systems: number;
      versions: number;
      published: number;
      events: string[];
      audits: string[];
      seededRuns: number;
      runs: number;
      snapshots: number;
      fixtureRows: number;
      fixtureDatabases: string[];
    }>`
      SELECT (SELECT count(*) FROM ranking.system WHERE code = ${CODE})::int AS systems,
             (SELECT count(*) FROM ranking.system_version v JOIN ranking.system s ON s.id = v.system_id
               WHERE s.code = ${CODE})::int AS versions,
             (SELECT count(*) FROM ranking.system_version_status_change c
               JOIN ranking.system_version v ON v.id = c.system_version_id JOIN ranking.system s ON s.id = v.system_id
               WHERE s.code = ${CODE} AND c.status = 'PUBLISHED')::int AS published,
             (SELECT coalesce(array_agg(o.event_type ORDER BY o.event_type), '{}') FROM platform.outbox_event o
               JOIN ranking.system s ON s.code = ${CODE}
               WHERE o.aggregate_id = s.id
                  OR o.aggregate_id IN (SELECT id FROM ranking.system_version WHERE system_id = s.id)) AS events,
             (SELECT coalesce(array_agg(a.action ORDER BY a.action), '{}') FROM platform.audit_event a
               JOIN ranking.system s ON s.code = ${CODE}
               WHERE a.target_id = s.id
                  OR a.target_id IN (SELECT id FROM ranking.system_version WHERE system_id = s.id)) AS audits,
             (SELECT count(*) FROM ranking.run r JOIN ranking.system s ON s.id = r.system_id
               WHERE s.code = ${CODE})::int AS "seededRuns",
             (SELECT count(*) FROM ranking.run)::int AS runs,
             (SELECT count(*) FROM ranking.snapshot)::int AS snapshots,
             ((SELECT count(*) FROM ranking.run WHERE provenance <> 'CANONICAL_ASSEMBLY')
               + (SELECT count(*) FROM ranking.snapshot WHERE provenance <> 'CANONICAL_ASSEMBLY'))::int AS "fixtureRows",
             (SELECT coalesce(array_agg(datname ORDER BY datname), '{}') FROM pg_database
               WHERE datname LIKE 'br\\_rkfx\\_%') AS "fixtureDatabases"`.execute(owner)
  ).rows[0];

describe('BRT-10 Step 14 — db:seed:rankings and demo:rankings (real commands, integration database)', () => {
  it('the seed creates one fictional PLATFORM definition through the canonical definition writer, idempotently', async () => {
    const before = await state();
    const first = await cli(SEED);
    expect(first.err).toBe('');
    expect(first.code).toBe(0);
    const second = await cli(SEED);
    expect(second.code).toBe(0);
    // Idempotent: the second run reports exactly what the first did (same version, hashes, times).
    expect(second.out).toBe(first.out);
    const report = JSON.parse(first.out) as Record<string, unknown> & {
      rankingSystems: Record<string, unknown>[];
    };
    expect(report.fictionalDataOnly).toBe(true);
    expect(report.lane).toMatch(/^CANONICAL PRODUCTION ASSEMBLY \(no fixture lane/);
    expect(report.officialSystems).toMatch(/^none seeded/);
    expect(report.rankingSystems).toHaveLength(1);
    expect(report.rankingSystems[0]).toMatchObject({
      code: CODE,
      kind: 'PLATFORM',
      label: 'Bragging Rights platform ranking',
      version: 1,
      lifecycle: 'PUBLISHED',
      method: 'BEST_MARK',
      comparator: [{ metric: 'elapsedTimeMs', order: 'LOWER_IS_BETTER' }],
      requirements: {
        minimumResultStatus: 'FINAL',
        minimumVerificationLevel: 'V2',
        holdBlocks: true,
      },
      note: 'fictional development reference ranking definition — not a universal standard',
    });

    const afterSeed = await state();
    // Exactly one logical definition, published once, with the writer's events and audit rows only.
    expect(afterSeed).toMatchObject({ systems: 1, versions: 1, published: 1 });
    expect(afterSeed?.events).toEqual([
      'RankingSystemCreated',
      'RankingSystemVersionCreated',
      'RankingSystemVersionPublished',
    ]);
    expect(afterSeed?.audits).toEqual([
      'ranking.system-created',
      'ranking.system-version-created',
      'ranking.system-version-published',
    ]);
    // No run, snapshot or fixture row: the seed writes definitions only.
    expect(afterSeed?.seededRuns).toBe(before?.seededRuns);
    expect(afterSeed?.runs).toBe(before?.runs);
    expect(afterSeed?.snapshots).toBe(before?.snapshots);
    expect(afterSeed?.fixtureRows).toBe(0);
  }, 300_000);

  it('the demo: an honest BLOCKED canonical run, the positive lifecycle only in a destroyed fixture database', async () => {
    const before = await state();
    const footprintBefore = await brt10ConsequenceFootprint(owner);
    const demo = await cli(DEMO);
    expect(demo.err).toBe('');
    expect(demo.out).not.toContain('✘');
    expect(demo.code).toBe(0);
    for (const line of [
      // canonical lane: honest outcome
      '✔ BLOCKED with the honest blocker NO_RANKED_ENTRIES only',
      '✔ the validated writer refuses to publish a BLOCKED run (RUN_NOT_PUBLISHABLE)',
      '✔ no snapshot is falsely published',
      '✔ the development database holds no REFERENCE_FIXTURE ranking row',
      '✔ Part A added only the canonical run itself',
      // fixture lane: positive mechanics
      '✔ deterministic BEST_MARK ranking with a shared tie: A 1=, B 1=, C 3',
      '✔ holder best:',
      '✔ snapshot 1 is INITIAL',
      '✔ idempotent replay: same run, same snapshot, no new run / snapshot / entry / event',
      '✔ snapshot 2 FOLLOWS snapshot 1',
      '✔ snapshot 3 CORRECTS snapshot 2',
      '✔ as-published keeps every snapshot in chain order',
      '✔ as-corrected replaces snapshot 2 by its correction',
      '✔ ranking_read.* rebuild (maintenance login) equals the incremental projections',
      '✔ every fixture run and snapshot is REFERENCE_FIXTURE',
      '✔ fixture snapshots are invisible to the production reader and the real /v1 server',
      // cleanup
      '✔ the throwaway fixture database no longer exists',
      '✔ Part B left the development database exactly as Part A did',
    ])
      expect(demo.out).toContain(line);

    const fixtureDb = /"database": "(br_rkfx_[0-9a-f]{12})"/.exec(demo.out)?.[1];
    expect(fixtureDb).toBeDefined();
    const after = await state();
    // Cleanup: the throwaway database is gone, and no other one was left behind.
    expect(after?.fixtureDatabases).not.toContain(fixtureDb);
    expect(after?.fixtureDatabases).toEqual(before?.fixtureDatabases);
    // Canonical footprint: exactly one new canonical run of the seeded system; nothing else.
    expect(after?.seededRuns).toBe((before?.seededRuns ?? 0) + 1);
    expect(after?.runs).toBe((before?.runs ?? 0) + 1);
    expect(after).toMatchObject({
      systems: 1,
      versions: 1,
      published: 1,
      snapshots: before?.snapshots,
      fixtureRows: 0,
      events: before?.events,
      audits: before?.audits,
    });
    expect(await brt10ConsequenceFootprint(owner)).toEqual(footprintBefore);
    const { rows } = await sql<{
      provenance: string;
      publication_state: string;
      entry_count: number;
    }>`
      SELECT r.provenance, r.publication_state, r.entry_count FROM ranking.run r
      JOIN ranking.system s ON s.id = r.system_id WHERE s.code = ${CODE}
      ORDER BY r.recorded_at DESC LIMIT 1`.execute(owner);
    expect(rows[0]).toEqual({
      provenance: 'CANONICAL_ASSEMBLY',
      publication_state: 'BLOCKED',
      entry_count: 0,
    });
  }, 300_000);
});
