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
//     supersession / record_basis / qualification_basis anywhere except the validated writer (tests
//     and the throwaway-DB harness exempt);
//   · BRT-10 qualification shortcuts: a qualification entity, decision or flag (isQualified,
//     is_qualified, QualificationDecision) — QUALIFIED is an Achievement only (ADR-0050 §1);
//   · consequence leapfrogging in achievement code and BRT-08 migrations: PrizeEntitlement /
//     TrophyMinted / RankingUpdated / PrizePaid (records exist since BRT-09: RECORD_SET is derived
//     through the validated writer only — see tooling/check-no-manual-record.mjs);
//   · application code (apps/*) importing fixture lanes: @br/achievements/fixtures,
//     @br/persistence/achievement-lanes, @br/testkit/achievements — except the demo CLI, whose
//     Part B / Part C are explicitly labelled reference fixtures (Part C in a throwaway database).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const repo = new URL('../', import.meta.url).pathname;
const scanDirs = ['packages', 'apps', 'db/migrations'];
const isTest = /\.(int\.)?test\.ts$/;
const WRITER = 'packages/persistence/src/achievement-store.ts';
const DEMOS = new Set([
  'apps/api/src/cli/demo-achievements.ts',
  'apps/api/src/cli/demo-records.ts',
]);
const code = [
  /\b(awardAchievement|setAchievement|forceAchievement|markWinnerAchievement|grantAchievement|insertAchievement|overrideAchievement|manualAchievement)\s*\(/,
  /\b(isWinner|is_winner|hasAchievement)\b/,
  /\b(result|verification)\.achievement\b/,
  /\b(isQualified|is_qualified|QualificationDecision|qualification_decision)\b/,
];
const achievementWrite =
  /INSERT\s+INTO\s+achievement\.(achievement|basis_item|member_credit|status_entry|supersession|record_basis|qualification_basis)\b/i;
const leapfrog = /\b(PrizeEntitlement|TrophyMinted|RankingUpdated|PrizePaid)\b/;
const fixtureImport =
  /from\s+['"]@br\/(achievements\/fixtures|persistence\/achievement-lanes|testkit\/achievements)['"]/;
const sqlRules = [
  /ALTER\s+TABLE\s+(results|verification)\.[a-z_]+\s+ADD\s+(COLUMN\s+)?[a-z_]*achievement/i,
  /\b(prize_entitlement|trophy)\b/i,
];
// BRT-10 0027 (QUALIFIED): never a projection dependency (ranking_read is 0028), never a write into
// the competitions, rankings or results it qualifies from, never a qualified flag on them.
const qualifiedSqlRules = [
  /\branking_read\b/i,
  /INSERT\s+INTO\s+(competition|ranking|results|verification)\./i,
  /ALTER\s+TABLE\s+(competition|ranking|results)\.[a-z_]+\s+ADD\s+(COLUMN\s+)?[a-z_]*qualif/i,
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
          if (!test && rel.startsWith('apps/') && !DEMOS.has(rel) && fixtureImport.test(line))
            offenders.push(`${at} application code imports a fixture lane`);
        });
    } else if (name.endsWith('.sql') && /^(001[6-8]|0027)_/.test(name)) {
      const rules = name.startsWith('0027_') ? [...sqlRules, ...qualifiedSqlRules] : sqlRules;
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*--/.test(line)) return;
          if (rules.some((re) => re.test(line)))
            offenders.push(
              `${rel}:${i + 1} consequence table / shortcut column / qualification dependency`,
            );
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
  'achievement guard: no manual award path, no result/verification shortcut, no raw Achievement write, no fixture lane in apps, no prize/trophy/ranking, no qualification shortcut or 0027 → ranking_read dependency',
);
