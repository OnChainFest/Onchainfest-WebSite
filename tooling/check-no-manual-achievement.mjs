#!/usr/bin/env node
// BRT-08 guardrail: an Achievement is produced ONLY by the pure engine from a sealed derivation
// snapshot and written ONLY by the validated writer in packages/persistence/src/achievement-store.ts.
// This scan fails on:
//   · award / force / manual-achievement functions (declared or called): awardAchievement,
//     setAchievement, forceAchievement, markWinnerAchievement, grantAchievement, insertAchievement,
//     overrideAchievement, manualAchievement;
//   · mutable shortcuts on Results / Verification: isWinner / is_winner / hasAchievement /
//     result.achievement / verification.achievement / achievement columns on results or verification;
//   · raw SQL writes into achievement.achievement / basis_item / member_credit / status_entry /
//     supersession anywhere except the validated writer (tests and the throwaway-DB harness exempt);
//   · consequence leapfrogging in BRT-08 code and migrations: RecordMark / RecordCategory /
//     PrizeEntitlement / TrophyMinted / RankingUpdated / RECORD_SET issuance;
//   · application code (apps/*) importing fixture lanes: @br/achievements/fixtures,
//     @br/persistence/achievement-lanes, @br/testkit/achievements — except the demo CLI, whose
//     Part B / Part C are explicitly labelled reference fixtures (Part C in a throwaway database).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const repo = new URL('../', import.meta.url).pathname;
const scanDirs = ['packages', 'apps', 'db/migrations'];
const isTest = /\.(int\.)?test\.ts$/;
const WRITER = 'packages/persistence/src/achievement-store.ts';
const DEMO = 'apps/api/src/cli/demo-achievements.ts';
const code = [
  /\b(awardAchievement|setAchievement|forceAchievement|markWinnerAchievement|grantAchievement|insertAchievement|overrideAchievement|manualAchievement)\s*\(/,
  /\b(isWinner|is_winner|hasAchievement)\b/,
  /\b(result|verification)\.achievement\b/,
];
const achievementWrite =
  /INSERT\s+INTO\s+achievement\.(achievement|basis_item|member_credit|status_entry|supersession)\b/i;
const leapfrog =
  /\b(RecordMark|RecordCategory|PrizeEntitlement|TrophyMinted|RankingUpdated|RecordRatified|PrizePaid)\b/;
const fixtureImport =
  /from\s+['"]@br\/(achievements\/fixtures|persistence\/achievement-lanes|testkit\/achievements)['"]/;
const sqlRules = [
  /ALTER\s+TABLE\s+(results|verification)\.[a-z_]+\s+ADD\s+(COLUMN\s+)?[a-z_]*achievement/i,
  /\b(record_mark|record_category|prize_entitlement|trophy)\b/i,
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
      const brt08 = /achievement/i.test(rel);
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line)) return; // documentation of the rule itself
          const at = `${rel}:${i + 1}`;
          if (!test && code.some((re) => re.test(line)))
            offenders.push(`${at} manual achievement / shortcut`);
          if (
            !test &&
            rel !== WRITER &&
            !rel.startsWith('packages/testkit/') &&
            achievementWrite.test(line)
          )
            offenders.push(`${at} raw Achievement write outside the validated writer`);
          if (!test && brt08 && leapfrog.test(line))
            offenders.push(`${at} record/prize/trophy/ranking leapfrog`);
          if (!test && rel.startsWith('apps/') && rel !== DEMO && fixtureImport.test(line))
            offenders.push(`${at} application code imports a fixture lane`);
        });
    } else if (name.endsWith('.sql') && /^001[6-9]_|^002/.test(name)) {
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*--/.test(line)) return;
          if (sqlRules.some((re) => re.test(line)))
            offenders.push(`${rel}:${i + 1} consequence table / shortcut column`);
        });
    }
  }
};
for (const d of scanDirs) walk(join(repo, d));
if (offenders.length > 0) {
  console.error('manual Achievement path, shortcut, fixture import or consequence leapfrog found:');
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}
console.log(
  'achievement guard: no manual award path, no result/verification shortcut, no raw Achievement write, no fixture lane in apps, no record/prize/trophy/ranking',
);
