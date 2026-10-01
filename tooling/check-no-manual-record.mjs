#!/usr/bin/env node
// BRT-09 guardrail: a RecordMark is produced ONLY by the pure record engine from a sealed
// RecordEvaluationSnapshot and written ONLY by the validated writer in
// packages/persistence/src/record-store.ts (categories: record-category-store.ts). This scan fails on:
//   · manual record functions (declared or called): manualCurrentRecord, forceRecord, setWorldRecord,
//     awardRecord, insertRecordMark, forceCanonicalRecord, setCurrentRecord, forceRatification,
//     markAsRecord;
//   · record flags on Results / Performances / Verification: isRecord, isWorldRecord,
//     isNationalRecord, worldRecord / nationalRecord / currentRecord members on result or performance
//     objects, record columns added to results / verification tables;
//   · raw SQL writes into record.* canonical tables outside the validated writers (tests, the
//     throwaway-DB harness and migrations exempt);
//   · BRT-10+ leapfrogging in record code and BRT-09 migrations: rankings, ranking points,
//     qualification, prizes, payouts, trophies / NFTs;
//   · application code (apps/*) importing record fixture lanes: @br/records/fixtures,
//     @br/persistence/record-lanes, @br/testkit/records — except the demo CLI, whose Part B / Part C
//     are explicitly labelled reference fixtures (Part C in a throwaway database).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const repo = new URL('../', import.meta.url).pathname;
const scanDirs = ['packages', 'apps', 'db/migrations'];
const isTest = /\.(int\.)?test\.ts$/;
const WRITERS = new Set([
  'packages/persistence/src/record-store.ts',
  'packages/persistence/src/record-category-store.ts',
  'packages/persistence/src/record-projection.ts',
]);
const DEMO = 'apps/api/src/cli/demo-records.ts';
const code = [
  /\b(manualCurrentRecord|forceRecord|setWorldRecord|awardRecord|insertRecordMark|forceCanonicalRecord|setCurrentRecord|forceRatification|markAsRecord)\s*\(/,
  /\b(isRecord|isWorldRecord|isNationalRecord)\b/,
  /\b(result|performance|verification|resultVersion)\.(worldRecord|nationalRecord|currentRecord|record)\b/,
];
const recordWrite =
  /INSERT\s+INTO\s+record(_read)?\.(record_mark|mark_status_entry|mark_supersession|mark_dependency|evaluation|mark_member_credit|category|category_version|category_version_status_change|category_card|mark_card|hall_of_fame_entry|athlete_record)\b/i;
const leapfrog =
  /\b(RankingUpdated|RankingSnapshot|RankingPoints|QualificationGranted|PrizeEntitlement|PrizePaid|PayoutReleased|TrophyMinted|mintTrophy|mintNft)\b/;
const fixtureImport =
  /from\s+['"]@br\/(records\/fixtures|persistence\/record-lanes|testkit\/records)['"]/;
const sqlRules = [
  /ALTER\s+TABLE\s+(results|verification)\.[a-z_]+\s+ADD\s+(COLUMN\s+)?[a-z_]*record/i,
  /\b(ranking|ranking_point|qualification|prize|payout|trophy|nft)[a-z_]*\b/i,
];
const offenders = [];

const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dist') continue;
    const path = join(dir, name);
    const rel = relative(repo, path);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) {
      const test = isTest.test(name);
      const brt09 = /record/i.test(rel);
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line)) return; // documentation of the rule itself
          const at = `${rel}:${i + 1}`;
          if (!test && code.some((re) => re.test(line)))
            offenders.push(`${at} manual record path / record flag shortcut`);
          if (
            !test &&
            !WRITERS.has(rel) &&
            !rel.startsWith('packages/testkit/') &&
            recordWrite.test(line)
          )
            offenders.push(`${at} raw record write outside the validated writers`);
          if (!test && brt09 && leapfrog.test(line))
            offenders.push(`${at} ranking / qualification / prize / trophy leapfrog`);
          if (!test && rel.startsWith('apps/') && rel !== DEMO && fixtureImport.test(line))
            offenders.push(`${at} application code imports a record fixture lane`);
        });
    } else if (name.endsWith('.sql') && /^(0019|0020|0021|0022)_/.test(name)) {
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*--/.test(line)) return;
          if (sqlRules.some((re) => re.test(line)))
            offenders.push(
              `${rel}:${i + 1} ranking / prize / trophy table or record shortcut column`,
            );
        });
    }
  }
};
for (const d of scanDirs) walk(join(repo, d));
if (offenders.length > 0) {
  console.error('manual record path, record shortcut, fixture import or BRT-10+ leapfrog found:');
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}
console.log(
  'record guard: no manual record path, no isRecord shortcut, no raw record write, no record fixture lane in apps, no ranking/qualification/prize/trophy',
);
