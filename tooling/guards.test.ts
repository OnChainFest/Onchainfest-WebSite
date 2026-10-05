import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * BRT-10 Step 13: the repository guards are plain node scripts run by `pnpm lint`. These tests run
 * them as lint does — against the real repository and against small throwaway trees (an explicit
 * root argument) that each plant one representative violation — so a rule that silently stops
 * matching fails here, not in review.
 */
const repo = new URL('../', import.meta.url).pathname;
const guard = (name: string) => join(repo, 'tooling', `check-no-manual-${name}.mjs`);
const RANKING = guard('ranking');
const ACHIEVEMENT = guard('achievement');
const RECORD = guard('record');
const roots: string[] = [];

function run(script: string, root?: string) {
  const r = spawnSync(process.execPath, root === undefined ? [script] : [script, root], {
    encoding: 'utf8',
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** A minimal repository tree (the guards walk packages/, apps/ and db/migrations/). */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'br-guard-'));
  roots.push(root);
  for (const d of ['packages', 'apps', 'db/migrations'])
    mkdirSync(join(root, d), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}
const real = (rel: string) => readFileSync(join(repo, rel), 'utf8');
const P = 'packages/persistence/src';
// The real validated BRT-10 writers and entry points, at their real paths.
const WRITERS = [
  `${P}/ranking-store.ts`,
  `${P}/ranking-definition-store.ts`,
  `${P}/ranking-projection.ts`,
  `${P}/result-ledger.ts`,
  `${P}/ranking-lanes.ts`,
  `${P}/ranking-worker.ts`,
  `${P}/ranking-api-reader.ts`,
  `${P}/classification-staleness.ts`,
  `${P}/qualification-loader.ts`,
  `${P}/achievement-store.ts`,
  `${P}/index.ts`,
  // Step 14: the development seed (definitions only) and the two-lane demo.
  `${P}/cli/seed-rankings.ts`,
  'apps/api/src/cli/demo-rankings.ts',
  'apps/api/src/v1-rankings.ts',
  'apps/worker/src/main.ts',
  'packages/testkit/src/rankings.ts',
  'packages/rankings/src/ranking-engine.ts',
  'packages/rankings/src/classification-engine.ts',
  'packages/rankings/scripts/vectors.ts',
  'db/migrations/0023_classification_derivation.sql',
  'db/migrations/0025_ranking_runs_snapshots.sql',
  'db/migrations/0027_qualified_achievements.sql',
  'db/migrations/0028_ranking_read_models.sql',
];
const realWriters = () => Object.fromEntries(WRITERS.map((rel) => [rel, real(rel)]));

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('check-no-manual-ranking', () => {
  it('passes on the real repository', () => {
    const r = run(RANKING);
    expect(r.out).toContain('ranking guard:');
    expect(r.status).toBe(0);
  }, 60_000);

  it('does not flag the validated writers, migrations, comments or tests', () => {
    const r = run(
      RANKING,
      tree({
        ...realWriters(),
        'apps/api/src/notes.ts': [
          '// a manual forceRanking(x) or INSERT INTO ranking.snapshot is forbidden (documentation)',
          ' * publishRankingSnapshot is reached only through RankingService',
          'export const ok = 1;',
        ].join('\n'),
        'apps/api/src/forbidden.int.test.ts':
          "await sql`UPDATE ranking.snapshot SET rank = 1`; import '@br/persistence/ranking-lanes';",
      }),
    );
    expect(r.out).toContain('ranking guard:');
    expect(r.status).toBe(0);
  });

  const cases: readonly [string, Record<string, string>, RegExp][] = [
    [
      'a manual ranking setter',
      { 'packages/competition/src/x.ts': 'export function forceRanking(id: string) {}' },
      /x\.ts:1 manual ranking/,
    ],
    [
      'a forced publication shortcut',
      { 'apps/api/src/x.ts': 'await makeOfficial(snapshotId);' },
      /x\.ts:1 manual ranking/,
    ],
    [
      'a ranking flag on a Result',
      { 'packages/domain/src/x.ts': 'export interface R { isRanked: boolean }' },
      /x\.ts:1 ranking shortcut field/,
    ],
    [
      'stored staleness',
      { 'packages/rankings/src/x.ts': 'const card = { isStale: true };' },
      /x\.ts:1 ranking shortcut field/,
    ],
    [
      'a raw snapshot INSERT outside the writer',
      { 'apps/api/src/x.ts': 'await sql`INSERT INTO ranking.snapshot (id) VALUES (${id})`;' },
      /x\.ts:1 raw INSERT on ranking\.snapshot/,
    ],
    [
      'a multi-line INSERT outside the writer',
      {
        [`${P}/x.ts`]: 'await sql`\n  INSERT INTO\n    ranking.snapshot_entry (rank) VALUES (1)`;',
      },
      /x\.ts:2 raw INSERT on ranking\.snapshot_entry/,
    ],
    [
      'a definition writer inserting a snapshot',
      {
        [`${P}/ranking-definition-store.ts`]:
          'await sql`INSERT INTO ranking.snapshot (id) VALUES (1)`;',
      },
      /ranking-definition-store\.ts:1 raw INSERT on ranking\.snapshot/,
    ],
    [
      'an UPDATE of a class-A table, even in the writer',
      {
        [`${P}/ranking-store.ts`]:
          'await sql`UPDATE ranking.snapshot SET previous_snapshot_id = NULL`;',
      },
      /ranking-store\.ts:1 raw UPDATE on ranking\.snapshot/,
    ],
    [
      'a TRUNCATE of canonical ranking tables',
      { [`${P}/x.ts`]: 'await sql`TRUNCATE ranking.run, ranking.snapshot`;' },
      /x\.ts:1 TRUNCATE of a ranking table/,
    ],
    [
      'a projection write outside the projection writer',
      { [`${P}/ranking-api-reader.ts`]: 'await sql`DELETE FROM ranking_read.leaderboard_entry`;' },
      /raw DELETE on ranking_read\.leaderboard_entry/,
    ],
    [
      'a query-builder write',
      { 'apps/worker/src/x.ts': "await db.insertInto('ranking.run').values(row).execute();" },
      /x\.ts:1 query-builder write on ranking\.run/,
    ],
    [
      'a classification index write outside the ResultLedger',
      { [`${P}/x.ts`]: 'await sql`INSERT INTO results.classification_input (a) VALUES (1)`;' },
      /raw write on results\.classification_input outside the ResultLedger/,
    ],
    [
      'a direct snapshot publication from the API',
      { 'apps/api/src/x.ts': 'await publishRankingSnapshot(db, { runId });' },
      /x\.ts:1 ranking lane writer/,
    ],
    [
      'the canonical runtime used by the API',
      { 'apps/api/src/x.ts': 'await new RankingService(db).publish({ runId });' },
      /x\.ts:1 canonical ranking runtime outside the worker/,
    ],
    [
      'a read-model refresh outside the fact writer',
      { [`${P}/x.ts`]: 'await refreshSnapshotCard(ctx, id);' },
      /x\.ts:1 ranking read-model refresh/,
    ],
    [
      're-ranking in application code',
      { 'apps/web/app/x.tsx': 'const r = evaluateRankingRun(input);' },
      /x\.tsx:1 ranking \/ classification engine run outside the validated writers/,
    ],
    [
      'ClassificationStale emitted by the API',
      { 'apps/api/src/x.ts': 'await staleness.emitStale(versionId);' },
      /x\.ts:1 ClassificationStale emission outside the worker/,
    ],
    [
      'a fixture lane imported by application code',
      {
        'apps/worker/src/x.ts':
          "import { persistRankingRun } from '@br/persistence/ranking-lanes';",
      },
      /x\.ts:1 imports a ranking fixture lane/,
    ],
    [
      'the engine fixtures imported by production code',
      { 'packages/rankings/src/x.ts': "import { rankingRunInput } from './fixtures';" },
      /x\.ts:1 imports a ranking fixture lane/,
    ],
    [
      'a throwaway fixture database named by application code',
      { 'apps/api/src/x.ts': "const url = 'postgres://h/br_rkfx_0123456789ab';" },
      /x\.ts:1 names a throwaway ranking fixture database/,
    ],
    // Step 14: the seed and the demo are exact-file exceptions, never a CLI-wide one.
    [
      'the canonical runtime in the ranking seed (definitions only)',
      { [`${P}/cli/seed-rankings.ts`]: 'await new RankingService(db).evaluate(input);' },
      /seed-rankings\.ts:1 canonical ranking runtime outside the worker/,
    ],
    [
      'a lane writer in the ranking seed',
      { [`${P}/cli/seed-rankings.ts`]: 'await publishRankingSnapshot(db, { runId });' },
      /seed-rankings\.ts:1 ranking lane writer/,
    ],
    [
      'a fixture lane imported by the ranking seed',
      {
        [`${P}/cli/seed-rankings.ts`]:
          "import { createRankingFixtureDatabase } from '@br/testkit/rankings';",
      },
      /seed-rankings\.ts:1 imports a ranking fixture lane/,
    ],
    [
      'the definition writer in another seed',
      { [`${P}/cli/seed-records.ts`]: 'const d = new RankingDefinitionStore(op);' },
      /seed-records\.ts:1 ranking definition writer used directly/,
    ],
    [
      'a fixture lane imported by another demo',
      {
        'apps/api/src/cli/demo-records.ts':
          "import { rankingRunInput } from '@br/rankings/fixtures';",
      },
      /demo-records\.ts:1 imports a ranking fixture lane/,
    ],
    [
      'the canonical runtime in another demo',
      { 'apps/api/src/cli/demo-achievements.ts': 'await new RankingService(db).evaluate(input);' },
      /demo-achievements\.ts:1 canonical ranking runtime outside the worker/,
    ],
    [
      'a raw snapshot write in the ranking demo',
      {
        'apps/api/src/cli/demo-rankings.ts':
          'await sql`INSERT INTO ranking.snapshot (id) VALUES (1)`;',
      },
      /demo-rankings\.ts:1 raw INSERT on ranking\.snapshot/,
    ],
    [
      'a projection refresh in the ranking demo',
      { 'apps/api/src/cli/demo-rankings.ts': 'await refreshSnapshotCard(ctx, id);' },
      /demo-rankings\.ts:1 ranking read-model refresh/,
    ],
    [
      're-ranking in the ranking demo',
      { 'apps/api/src/cli/demo-rankings.ts': 'const r = evaluateRankingRun(input);' },
      /demo-rankings\.ts:1 ranking \/ classification engine run outside the validated writers/,
    ],
    [
      'ClassificationStale emitted by the ranking demo',
      { 'apps/api/src/cli/demo-rankings.ts': 'await staleness.emitStale(versionId);' },
      /demo-rankings\.ts:1 ClassificationStale emission outside the worker/,
    ],
    [
      'ranking → QUALIFIED leapfrog',
      { [`${P}/ranking-worker.ts`]: 'await achievements.deriveQualification({ ruleVersionId });' },
      /ranking-worker\.ts:1 ranking → qualification/,
    ],
    [
      'ranking → prize leapfrog',
      { 'packages/rankings/src/x.ts': "export const e = 'PrizeEntitlement';" },
      /x\.ts:1 ranking → qualification/,
    ],
    [
      'ranking → record / entry write',
      { [`${P}/ranking-store.ts`]: 'await sql`INSERT INTO record.record_mark (id) VALUES (1)`;' },
      /ranking-store\.ts:1 ranking → qualification/,
    ],
    [
      'a ranking write route in the API',
      {
        'apps/api/src/x.ts':
          "route(\n  'POST',\n  '/v1/ranking-snapshots/:snapshotId/publish',\n);",
      },
      /x\.ts:2 ranking \/ classification write route POST \/v1\/ranking-snapshots/,
    ],
    [
      'database access from a web page',
      { 'apps/web/app/ranking-systems/page.tsx': "import { createDb } from '@br/persistence';" },
      /page\.tsx:1 web reaches the database/,
    ],
    [
      'a ranking column on Results',
      {
        'db/migrations/0031_x.sql':
          'ALTER TABLE results.result_entry ADD COLUMN ranking_position int;',
      },
      /0031_x\.sql:1 ranking \/ qualification column results\.result_entry\.ranking_position/,
    ],
    [
      'a standings table outside the ranking schemas',
      { 'db/migrations/0031_x.sql': 'CREATE TABLE competition.standings (id uuid);' },
      /0031_x\.sql:1 ranking \/ standing \/ qualification table/,
    ],
    [
      'a write grant on a canonical ranking table to the API',
      { 'db/migrations/0031_x.sql': 'GRANT SELECT, INSERT ON ranking.snapshot TO br_api;' },
      /0031_x\.sql:1 write grant on ranking\.\* to br_api/,
    ],
    [
      'an UPDATE grant on a class-A ranking table',
      { 'db/migrations/0031_x.sql': 'GRANT UPDATE ON ranking.run TO br_rankings;' },
      /0031_x\.sql:1 UPDATE \/ DELETE \/ TRUNCATE grant/,
    ],
    [
      'a data write in a migration',
      { 'db/migrations/0031_x.sql': "INSERT INTO ranking.snapshot (id) VALUES ('x');" },
      /0031_x\.sql:1 data write on ranking\.snapshot/,
    ],
    [
      'stored currentness on a ranking projection',
      {
        'db/migrations/0031_x.sql':
          'CREATE TABLE ranking_read.x (\n  id uuid,\n  is_current boolean\n);',
      },
      /0031_x\.sql:1 stored currentness \/ staleness on ranking_read\.x/,
    ],
  ];
  it.each(cases)('flags %s', (_what, files, offender) => {
    const r = run(RANKING, tree({ ...realWriters(), ...files }));
    expect(r.status).toBe(1);
    expect(r.out).toMatch(offender);
  });
});

describe('check-no-manual-achievement (BRT-10 refinements)', () => {
  it('passes on the real repository', () => {
    const r = run(ACHIEVEMENT);
    expect(r.out).toContain('achievement guard:');
    expect(r.status).toBe(0);
  }, 60_000);

  it('allows the validated QUALIFIED path', () => {
    const r = run(ACHIEVEMENT, tree(realWriters()));
    expect(r.status).toBe(0);
  });

  it.each([
    [
      'a ranking projection as a QUALIFIED source',
      { [`${P}/qualification-loader.ts`]: 'await sql`SELECT * FROM ranking_read.snapshot_card`;' },
      /qualification-loader\.ts:1 achievement code uses a ranking projection/,
    ],
    [
      'a ranking writer called by achievement code',
      { 'packages/achievements/src/x.ts': 'await publishRankingSnapshot(db, { runId });' },
      /x\.ts:1 achievement code uses a ranking projection \/ writer/,
    ],
    [
      'a QUALIFIED derivation outside the writer',
      { 'apps/worker/src/x.ts': 'await achievements.deriveQualification({ ruleVersionId });' },
      /x\.ts:1 QUALIFIED derivation outside the validated Achievement writer/,
    ],
    [
      'a qualification event',
      { 'packages/achievements/src/x.ts': "emit('QualificationGranted');" },
      /x\.ts:1 manual achievement \/ shortcut/,
    ],
  ] as const)('flags %s', (_what, files, offender) => {
    const r = run(ACHIEVEMENT, tree({ ...realWriters(), ...files }));
    expect(r.status).toBe(1);
    expect(r.out).toMatch(offender);
  });
});

describe('check-no-manual-record (BRT-10 refinements)', () => {
  it('passes on the real repository', () => {
    const r = run(RECORD);
    expect(r.out).toContain('record guard:');
    expect(r.status).toBe(0);
  }, 60_000);

  it.each([
    [
      'a ranking snapshot as a record source',
      { [`${P}/record-loader.ts`]: 'await sql`SELECT * FROM ranking.snapshot_entry`;' },
      /record-loader\.ts:1 record code uses a ranking \/ qualification fact or writer/,
    ],
    [
      'a ranking publication from record code',
      { [`${P}/record-store.ts`]: 'await publishRankingSnapshot(db, { runId });' },
      /record-store\.ts:1 record code uses a ranking \/ qualification fact or writer/,
    ],
    [
      'a qualification side effect from record code',
      { [`${P}/record-store.ts`]: 'await achievements.deriveQualification({ ruleVersionId });' },
      /record-store\.ts:1 record code uses a ranking \/ qualification fact or writer/,
    ],
  ] as const)('flags %s', (_what, files, offender) => {
    const r = run(RECORD, tree(files));
    expect(r.status).toBe(1);
    expect(r.out).toMatch(offender);
  });
});
