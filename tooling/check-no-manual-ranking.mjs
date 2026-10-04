#!/usr/bin/env node
// BRT-10 guardrail (ADR-0047, ADR-0048, ADR-0050): a classification is a derived ResultVersion
// submitted ONLY through the ResultLedger (T2 re-derives it), and a ranking is a run / snapshot
// written ONLY by the validated writers in packages/persistence/src:
//   ranking-definition-store.ts  RankingSystem / ClassificationPolicy definitions (br_ranking_rules)
//   ranking-store.ts             runs, run dependencies, snapshots, entries (br_rankings)
//   ranking-projection.ts        ranking_read.* projections (refreshed by the writer of the fact)
//   result-ledger.ts             results.classification_derivation / classification_input
// The canonical runtime is RankingService, reached by application code only through the approved
// worker (RankingWorkerService); the lane entry points live in @br/persistence/ranking-lanes.
// This scan fails on:
//   · manual ranking / classification functions (declared or called): setRanking, forceRanking,
//     overrideRank, setStanding, forcePublish, makeOfficial, insertSnapshot, setSnapshotLineage, …;
//   · ranking shortcut fields: isRanked / rankingPosition / currentRank / rankingPoints /
//     currentRanking / isClassified / currentSnapshotId, stored staleness (isStale …), and ranking /
//     qualified members on results, performances, verification, achievements or holders;
//   · raw SQL writes into ranking.* / ranking_read.* / results.classification_* outside the exact
//     writer and table allowlist (UPDATE / DELETE / TRUNCATE of class-A ranking tables: never), and
//     DDL or trigger bypasses (ALTER TABLE ranking…, session_replication_role) in application code;
//   · writer entry points referenced outside their allowlist: persistRankingRun /
//     publishRankingSnapshot, RankingService, RankingDefinitionStore, the read-model refresh and
//     rebuild functions, ClassificationStale emission, the fixture read lane, and the pure engines
//     (evaluateRankingRun / deriveClassification: no re-ranking outside the validated paths);
//   · consequence leapfrogging in ranking code: QUALIFIED derivation, Achievement / RecordMark
//     writers, prizes / payouts / trophies / NFTs, entries / seeding / advancement, and SQL writes
//     into any non-ranking schema;
//   · fixture lanes outside tests, the throwaway-DB harness (packages/testkit) and the vector
//     generators (packages/rankings/scripts): @br/rankings/fixtures, @br/persistence/ranking-lanes,
//     @br/testkit/rankings, br_rkfx_ databases, the ranking fixture overlay;
//   · write surfaces: a non-GET ranking / classification route in the API other than the approved
//     COMP_STAFF proposal (which writes nothing), and database access from the web;
//   · migrations: DML into ranking / classification tables, write grants on them beyond the writer
//     roles (never UPDATE / DELETE / TRUNCATE on ranking.*), ranking / standing / qualification
//     columns or tables outside the ranking schemas, stored currentness / staleness on ranking
//     tables, and prize / trophy / entry / advancement vocabulary in the BRT-10 migrations.
// Comments, tests (which prove these paths are refused) and migrations creating the ranking tables
// are not offenders. Usage: node tooling/check-no-manual-ranking.mjs [root] (root defaults to the repo).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const repo =
  process.argv[2] === undefined
    ? new URL('../', import.meta.url).pathname
    : `${resolve(process.argv[2])}/`;
const scanDirs = ['packages', 'apps', 'db/migrations'];
const isTest = /\.(int\.)?test\.tsx?$/;
const P = 'packages/persistence/src/';
const STORE = `${P}ranking-store.ts`;
const DEFINITIONS = `${P}ranking-definition-store.ts`;
const PROJECTION = `${P}ranking-projection.ts`;
const LEDGER = `${P}result-ledger.ts`;
const LANES = `${P}ranking-lanes.ts`;
const WORKER = `${P}ranking-worker.ts`;
const STALENESS = `${P}classification-staleness.ts`;
const API_READER = `${P}ranking-api-reader.ts`;
const INDEX = `${P}index.ts`;

// ── writers: exact file → canonical ranking tables it may INSERT into ──
const RANKING_INSERTS = new Map([
  [STORE, new Set(['run', 'run_dependency', 'snapshot', 'snapshot_entry'])],
  [
    DEFINITIONS,
    new Set([
      'classification_policy',
      'classification_policy_version',
      'classification_policy_version_status_change',
      'system',
      'system_version',
      'system_version_status_change',
    ]),
  ],
]);
// ── entry points: symbol → the only files (or directory prefixes, ending in '/') that may name it ──
const ENTRY_POINTS = [
  [
    /\b(persistRankingRun|publishRankingSnapshot)\b/,
    [STORE, LANES],
    'ranking lane writer outside ranking-store / ranking-lanes',
  ],
  [/\bRankingService\b/, [STORE, WORKER, INDEX], 'canonical ranking runtime outside the worker'],
  [/\bRankingDefinitionStore\b/, [DEFINITIONS], 'ranking definition writer used directly'],
  [
    /\brefresh(System|Run|Snapshot|Classification)Card\b/,
    [PROJECTION, STORE, DEFINITIONS, LEDGER],
    'ranking read-model refresh outside the writer of the projected fact',
  ],
  [/\brebuildRankingReadModels\b/, [PROJECTION, INDEX], 'ranking read-model rebuild'],
  [/\bemitStale\b/, [STALENESS, WORKER], 'ClassificationStale emission outside the worker'],
  [
    /\bRANKING_FIXTURE_READ_LANE\b/,
    [API_READER, LANES],
    'fixture read lane outside the reader / lane module',
  ],
  [
    /\b(evaluateRankingRun|deriveClassification)\s*\(/,
    ['packages/rankings/src/', 'packages/rankings/scripts/', STORE, LEDGER, STALENESS],
    'ranking / classification engine run outside the validated writers (re-ranking)',
  ],
];
const allowed = (rel, list) =>
  list.some((entry) => (entry.endsWith('/') ? rel.startsWith(entry) : rel === entry));

// ── code rules ──
const manual =
  /\b(setRanking|forceRanking|overrideRanking|manualRanking|insertRanking|setRank|forceRank|overrideRank|setStanding|forceStanding|updateStandings|recomputeStandings|forcePublish|forcePublication|publishManually|makeOfficial|markOfficial|setCurrentRanking|forceSnapshot|insertSnapshot|insertSnapshotEntry|overrideSnapshot|rewriteSnapshot|setSnapshotLineage|forceClassification|overrideClassification|setClassification|markClassified)\s*\(/;
const shortcutField =
  /\b(isRanked|is_ranked|rankingPosition|ranking_position|currentRank|current_rank|rankingPoints|ranking_points|currentRanking|current_ranking|isOfficialRanking|is_official_ranking|isClassified|is_classified|currentSnapshotId|current_snapshot_id)\b/;
const storedStaleness = /\b(isStale|is_stale|isCurrentSnapshot|isCurrentRanking)\s*[:?=]/;
const foreignMember =
  /\b(result|resultVersion|performance|verification|achievement|recordMark|entry|participant|athlete|team|passport)\.(ranking|rankings|rankingSnapshot|ranked|qualified|isQualified)\b/;
const fixtureImport =
  /(?:from\s+|import\s*\(\s*)['"]@br\/(?:rankings\/fixtures|persistence\/ranking-lanes|testkit\/rankings)['"]/;
const relativeFixtureImport = [
  ['packages/rankings/src/', /(?:from\s+|import\s*\(\s*)['"]\.\/fixtures['"]/],
  [P, /(?:from\s+|import\s*\(\s*)['"]\.\/ranking-lanes['"]/],
];
const FIXTURE_HOSTS = ['packages/testkit/', 'packages/rankings/scripts/'];
const fixtureDatabase = /\bbr_rkfx_|ranking-fixture-overlay/;
const triggerBypass =
  /\b(ALTER\s+TABLE\s+(ONLY\s+)?(ranking|ranking_read)\.|session_replication_role)\b/i;
// ranking code (engine, writers, readers, worker reaction, API routes, web pages)
const RANKING_PATH =
  /^(packages\/rankings\/src\/|packages\/persistence\/src\/(ranking|classification)-|apps\/api\/src\/v1-rankings\.ts$|apps\/web\/app\/(_lib\/ranking|ranking-|result-versions\/\[id\]\/classification\/))/;
const leapfrog =
  /\b(AchievementService|deriveQualification|persistDerivation|deriveAchievements|QualificationGranted|RecordService|persistRecordEvaluation|insertRecordMark|PrizeEntitlement|PrizePaid|PayoutReleased|TrophyMinted|mintTrophy|mintNft|RankingPoints|advancement|seedNextRound|resolveSlot)\b/;
const foreignWrite =
  /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(achievement|achievement_read|record|record_read|competition|competition_read|results|verification|verification_read|evidence|attestation|identity|passport|authority)\.\w+/i;
const webDatabase =
  /(?:from\s+|import\s*\(\s*)['"](@br\/persistence|@br\/testkit|pg|kysely)(\/[^'"]*)?['"]/;
const webWrite = /\bmethod\s*:\s*['"](POST|PUT|PATCH|DELETE)['"]/i;
// whole-file (multi-line) SQL / route patterns
const rankingDml =
  /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?(ranking|ranking_read)\.(\w+)/gi;
const truncateList = /\bTRUNCATE\b[^;`]*?\b(ranking|ranking_read)\.\w+/gi;
const classificationDml =
  /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?results\.(classification_(?:derivation|input))\b/gi;
const kyselyWrite =
  /\b(insertInto|updateTable|deleteFrom|replaceInto|mergeInto)\(\s*['"`](ranking|ranking_read)\.(\w+)/g;
const kyselyClassificationWrite =
  /\b(insertInto|updateTable|deleteFrom|replaceInto|mergeInto)\(\s*['"`]results\.classification_/g;
const writeRoute =
  /['"`](POST|PUT|PATCH|DELETE)['"`]\s*,\s*['"`](\/v1\/[^'"`]*(?:ranking|classification)[^'"`]*)['"`]|\.(post|put|patch|delete)\(\s*['"`](\/v1\/[^'"`]*(?:ranking|classification)[^'"`]*)['"`]/gi;
const APPROVED_WRITE_ROUTES = new Set([
  // COMP_STAFF proposal (Step 11): read-only proposal, closed empty body, writes nothing.
  'POST /v1/result-versions/:resultVersionId/classification-proposals',
]);

// ── migration rules ──
const BRT10_MIGRATION = /^00(2[3-9]|30)_/;
const RANKING_WRITERS = new Set(['br_ranking_rules', 'br_rankings']);
const PROJECTION_WRITERS = new Set(['br_ranking_rules', 'br_rankings', 'br_results', 'br_rebuild']);
const CLASSIFICATION_WRITERS = new Set(['br_results']);
const grantStatement = /\bGRANT\s+([^;']*?)\s+ON\s+(?:TABLE\s+)?([^;']*?)\s+TO\s+([^;')]*)/gi;
const shortcutName = /(rank|standing|qualif|classified|leaderboard)/i;
const shortcutTable = /(standing|ranking|leaderboard|qualification_decision|qualified)/i;
const storedState = /\b(is_current|is_stale|stale|is_latest|is_head|current_rank)\s+\w/i;
const consequenceSql =
  /\b(prize|payout|trophy|nft|mint|settlement|entitlement|advancement|seeding)\w*/i;

const offenders = [];
const lineOf = (text, index) => text.slice(0, index).split('\n').length;
// Comment lines are blanked (line numbers preserved): documentation of a rule is not a violation.
const withoutComments = (text) =>
  text
    .split('\n')
    .map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l))
    .join('\n');
const withoutSqlComments = (text) => text.replace(/--[^\n]*/g, '');

function scanCode(rel, text) {
  const code = withoutComments(text);
  const ranking = RANKING_PATH.test(rel);
  const fixtureHost = allowed(rel, FIXTURE_HOSTS);
  code.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    const at = `${rel}:${i + 1}`;
    if (manual.test(line)) offenders.push(`${at} manual ranking / classification function`);
    if (shortcutField.test(line) || storedStaleness.test(line) || foreignMember.test(line))
      offenders.push(
        `${at} ranking shortcut field (rank / ranking / qualified flag, stored staleness)`,
      );
    if (triggerBypass.test(line))
      offenders.push(`${at} ranking DDL / trigger bypass outside migrations`);
    for (const [re, files, what] of ENTRY_POINTS)
      if (re.test(line) && !allowed(rel, files)) offenders.push(`${at} ${what}`);
    if (!fixtureHost) {
      if (fixtureImport.test(line)) offenders.push(`${at} imports a ranking fixture lane`);
      for (const [prefix, re] of relativeFixtureImport)
        if (rel.startsWith(prefix) && re.test(line))
          offenders.push(`${at} imports a ranking fixture lane`);
      if (fixtureDatabase.test(line))
        offenders.push(`${at} names a throwaway ranking fixture database / overlay`);
    }
    if (ranking && (leapfrog.test(line) || foreignWrite.test(line)))
      offenders.push(
        `${at} ranking → qualification / achievement / record / prize / trophy / entry leapfrog`,
      );
    if (rel.startsWith('apps/web/')) {
      if (webDatabase.test(line)) offenders.push(`${at} web reaches the database`);
      if (ranking && webWrite.test(line)) offenders.push(`${at} web ranking write request`);
    }
  });
  for (const m of code.matchAll(rankingDml)) {
    const [, verb, schema, table] = m;
    const insert = /^INSERT/i.test(verb);
    const ok =
      schema === 'ranking'
        ? insert && RANKING_INSERTS.get(rel)?.has(table) === true
        : rel === PROJECTION;
    if (!ok)
      offenders.push(
        `${rel}:${lineOf(code, m.index)} raw ${verb.split(/\s/)[0].toUpperCase()} on ${schema}.${table} outside its validated writer`,
      );
  }
  for (const m of code.matchAll(truncateList))
    if (m[1] === 'ranking' || rel !== PROJECTION)
      offenders.push(`${rel}:${lineOf(code, m.index)} TRUNCATE of a ranking table`);
  for (const m of code.matchAll(classificationDml))
    if (!(/^INSERT/i.test(m[1]) && rel === LEDGER))
      offenders.push(
        `${rel}:${lineOf(code, m.index)} raw write on results.${m[2]} outside the ResultLedger`,
      );
  for (const m of code.matchAll(kyselyWrite)) {
    const ok =
      m[2] === 'ranking'
        ? m[1] === 'insertInto' && RANKING_INSERTS.get(rel)?.has(m[3]) === true
        : rel === PROJECTION;
    if (!ok)
      offenders.push(
        `${rel}:${lineOf(code, m.index)} query-builder write on ${m[2]}.${m[3]} outside its validated writer`,
      );
  }
  for (const m of code.matchAll(kyselyClassificationWrite))
    if (!(m[1] === 'insertInto' && rel === LEDGER))
      offenders.push(
        `${rel}:${lineOf(code, m.index)} query-builder write on a classification table`,
      );
  if (rel.startsWith('apps/api/'))
    for (const m of code.matchAll(writeRoute)) {
      const route = `${(m[1] ?? m[3]).toUpperCase()} ${m[2] ?? m[4]}`;
      if (!APPROVED_WRITE_ROUTES.has(route))
        offenders.push(
          `${rel}:${lineOf(code, m.index)} ranking / classification write route ${route}`,
        );
    }
}

function scanMigration(rel, name, text) {
  const sqlText = withoutSqlComments(text);
  const at = (index) => `${rel}:${lineOf(sqlText, index)}`;
  for (const m of sqlText.matchAll(rankingDml))
    offenders.push(`${at(m.index)} data write on ${m[2]}.${m[3]} in a migration`);
  for (const m of sqlText.matchAll(classificationDml))
    offenders.push(`${at(m.index)} data write on results.${m[2]} in a migration`);
  for (const m of sqlText.matchAll(grantStatement)) {
    const [, privileges, target, granteeList] = m;
    if (!/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALL)\b/i.test(privileges)) continue;
    const grantees = granteeList
      .split(',')
      .map((g) => g.trim().split(/\s+/)[0])
      .filter(Boolean);
    const check = (writers, what) => {
      const extra = grantees.filter((g) => !writers.has(g));
      if (extra.length > 0)
        offenders.push(`${at(m.index)} write grant on ${what} to ${extra.join(', ')}`);
    };
    if (/\branking\.|\bSCHEMA\s+ranking\b/i.test(target)) {
      if (/\b(UPDATE|DELETE|TRUNCATE|ALL)\b/i.test(privileges))
        offenders.push(
          `${at(m.index)} UPDATE / DELETE / TRUNCATE grant on a class-A ranking table`,
        );
      check(RANKING_WRITERS, 'ranking.*');
    }
    if (/\branking_read\.|\bSCHEMA\s+ranking_read\b/i.test(target))
      check(PROJECTION_WRITERS, 'ranking_read.*');
    if (/\bresults\.classification_/i.test(target))
      check(CLASSIFICATION_WRITERS, 'results.classification_*');
  }
  for (const m of sqlText.matchAll(
    /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(\w+)\.(\w+)([^;]*)/gi,
  )) {
    if (m[1] === 'ranking' || m[1] === 'ranking_read') continue;
    for (const c of m[3].matchAll(/\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi))
      if (!/^CONSTRAINT$/i.test(c[1]) && shortcutName.test(c[1]))
        offenders.push(`${at(m.index)} ranking / qualification column ${m[1]}.${m[2]}.${c[1]}`);
  }
  for (const m of sqlText.matchAll(
    /\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\.(\w+)/gi,
  )) {
    const inRankingSchema = m[1] === 'ranking' || m[1] === 'ranking_read';
    if (!inRankingSchema && shortcutTable.test(m[2]))
      offenders.push(`${at(m.index)} ranking / standing / qualification table ${m[1]}.${m[2]}`);
    if (inRankingSchema) {
      const end = sqlText.indexOf('\n);', m.index);
      const body = sqlText.slice(m.index, end === -1 ? undefined : end);
      if (storedState.test(body))
        offenders.push(`${at(m.index)} stored currentness / staleness on ${m[1]}.${m[2]}`);
    }
  }
  if (BRT10_MIGRATION.test(name))
    sqlText.split('\n').forEach((line, i) => {
      if (consequenceSql.test(line))
        offenders.push(
          `${rel}:${i + 1} prize / trophy / entry / advancement in a BRT-10 migration`,
        );
    });
}

const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dist') continue;
    const path = join(dir, name);
    const rel = relative(repo, path);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) {
      if (!isTest.test(name)) scanCode(rel, readFileSync(path, 'utf8'));
    } else if (name.endsWith('.sql') && rel.startsWith('db/migrations/'))
      scanMigration(rel, name, readFileSync(path, 'utf8'));
  }
};
for (const d of scanDirs) walk(join(repo, d));
if (offenders.length > 0) {
  console.error(
    'manual ranking path, ranking shortcut, fixture import or consequence leapfrog found:',
  );
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}
console.log(
  'ranking guard: no manual ranking path, no ranking shortcut field, no raw ranking / classification write outside the validated writers, no publication bypass, no fixture lane outside tests, no ranking → qualification / record / prize / trophy leapfrog, no write surface',
);
