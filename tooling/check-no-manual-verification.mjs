#!/usr/bin/env node
// BRT-07 guardrail: a VerificationLevel is produced ONLY by the pure evaluator. No code path may
// set, force, override or mark a level, and no mutable verified / verification_level column may
// exist on Result state. This scan fails on:
//   · functions / methods named setVerificationLevel, markVerified, forceV0…forceV4,
//     overrideVerification, setLevel, forceLevel (declared or called);
//   · request/DTO members named desiredLevel, forceLevel, manualOverride, levelOverride;
//   · score-like verification members: trustScore, verificationConfidence, confidenceScore,
//     certaintyPercent, sourceWeight, authorityWeight;
//   · SQL adding verified / verification_level columns to the results schema.
// Tests are exempt only where they assert that such inputs are REJECTED (listed allowance below).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const repo = new URL('../', import.meta.url).pathname;
const scanDirs = ['packages', 'apps', 'db/migrations'];
const code = [
  /\b(setVerificationLevel|markVerified|overrideVerification|forceV[0-4]|forceLevel|setLevel)\s*\(/,
  /\b(desiredLevel|forceLevel|manualOverride|levelOverride)\s*[:?]/,
  /\b(trustScore|verificationConfidence|confidenceScore|certaintyPercent|sourceWeight|authorityWeight)\s*[:=?]/,
];
const sqlRules = [
  /ALTER\s+TABLE\s+results\.[a-z_]+\s+ADD\s+(COLUMN\s+)?(verified|verification_level)\b/i,
  /\b(verified|verification_level)\s+(boolean|text)/i,
];
// Tests that prove closed schemas REJECT these members may mention them in request payloads.
const allowTests = /\.(int\.)?test\.ts$/;
const offenders = [];

const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) {
      if (allowTests.test(name)) continue;
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line)) return; // documentation of the rule itself
          if (code.some((re) => re.test(line))) offenders.push(`${relative(repo, path)}:${i + 1}`);
        });
    } else if (name.endsWith('.sql')) {
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*--/.test(line)) return;
          if (sqlRules.some((re) => re.test(line)))
            offenders.push(`${relative(repo, path)}:${i + 1}`);
        });
    }
  }
};
for (const d of scanDirs) walk(join(repo, d));
if (offenders.length > 0) {
  console.error(
    'manual verification-level override / score construct found (levels come only from the evaluator):',
  );
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}
console.log(
  'verification guard: no manual level override, level input, score field or result verification column',
);
