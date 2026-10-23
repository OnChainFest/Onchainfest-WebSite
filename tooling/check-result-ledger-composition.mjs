#!/usr/bin/env node
// BRT-05R guardrail: application code (apps/*) must never construct a bare ResultLedger. Result
// operations scoped to the competition hierarchy must use `createCompetitionResultLedger`, which
// always wires `competitionResultScopeValidator`. Tests are exempt (they exercise BRT-03 paths).
// WP-P0-3 (D-16, ADR-0079): every such composition in application code (apps/* and the persistence
// services, outside cli demos / seeds and tests) names the account it acts for (`actorAccountId`),
// which wires the result-staff gate; a composition without it would skip the current-role check.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../apps/', import.meta.url).pathname;
const persistence = new URL('../packages/persistence/src/', import.meta.url).pathname;
const offenders = [];
const ungated = [];
/** `createCompetitionResultLedger(` calls (outside its definition) that never name actorAccountId. */
const scanFactoryCalls = (path, text) => {
  if (/\/cli\//.test(path) || /competition-hierarchy\.ts$/.test(path)) return;
  const re = /createCompetitionResultLedger\s*\(/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (; end < text.length; end++) {
      if (text[end] === '(') depth++;
      else if (text[end] === ')' && --depth === 0) break;
    }
    if (!/actorAccountId/.test(text.slice(m.index, end)))
      ungated.push(`${path}:${text.slice(0, m.index).split('\n').length}`);
  }
};
const walk = (dir, bareRule) => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, bareRule);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\.[tj]sx?$/.test(name)) {
      const text = readFileSync(path, 'utf8');
      scanFactoryCalls(path, text);
      if (bareRule)
        text.split('\n').forEach((line, i) => {
          if (/new\s+ResultLedger\s*\(/.test(line)) offenders.push(`${path}:${i + 1}`);
        });
    }
  }
};
walk(root, true);
walk(persistence, false);
if (offenders.length > 0 || ungated.length > 0) {
  if (offenders.length > 0)
    console.error(
      'bare ResultLedger construction in application code (use createCompetitionResultLedger):',
    );
  for (const o of offenders) console.error(`  ${o}`);
  if (ungated.length > 0)
    console.error(
      'createCompetitionResultLedger without actorAccountId in application code (ADR-0079):',
    );
  for (const o of ungated) console.error(`  ${o}`);
  process.exit(1);
}
console.log(
  'result-ledger guard: application code composes ResultLedger only via createCompetitionResultLedger, always for an acting account',
);
