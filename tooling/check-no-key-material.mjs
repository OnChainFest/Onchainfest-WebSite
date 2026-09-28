#!/usr/bin/env node
// Regression guard for BRT-00 C-2 / ADR-0016: schemas must never gain columns for private key
// material. Scans SQL migrations for forbidden column names.
import { readdirSync, readFileSync } from 'node:fs';

const FORBIDDEN =
  /\b(private_key|privkey|secret_key|mnemonic|seed_phrase|seed|wallet_credentials)\b\s+(text|bytea|jsonb|json|varchar)/i;
const dir = new URL('../db/migrations/', import.meta.url);
let failures = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
  readFileSync(new URL(file, dir), 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (FORBIDDEN.test(line) && !line.trimStart().startsWith('--')) {
        console.error(`${file}:${i + 1}: forbidden key-material column: ${line.trim()}`);
        failures++;
      }
    });
}
if (failures > 0) process.exit(1);
console.log('key-material guard: no forbidden columns in migrations');
