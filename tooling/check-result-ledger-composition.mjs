#!/usr/bin/env node
// BRT-05R guardrail: application code (apps/*) must never construct a bare ResultLedger. Result
// operations scoped to the competition hierarchy must use `createCompetitionResultLedger`, which
// always wires `competitionResultScopeValidator`. Tests are exempt (they exercise BRT-03 paths).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../apps/', import.meta.url).pathname;
const offenders = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\.[tj]sx?$/.test(name)) {
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/new\s+ResultLedger\s*\(/.test(line)) offenders.push(`${path}:${i + 1}`);
        });
    }
  }
};
walk(root);
if (offenders.length > 0) {
  console.error(
    'bare ResultLedger construction in application code (use createCompetitionResultLedger):',
  );
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}
console.log(
  'result-ledger guard: application code composes ResultLedger only via createCompetitionResultLedger',
);
