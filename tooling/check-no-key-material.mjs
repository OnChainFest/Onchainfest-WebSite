#!/usr/bin/env node
// Regression guard for BRT-00 C-2 / ADR-0016 (extended in BRT-06).
//  1. SQL migrations must never gain columns for private key material.
//  2. Committed source/config/docs must never contain private keys (PEM, private JWK members with
//     values), seed phrases, or development crypto keys/secrets with a concrete value
//     (BR_VAULT_DEV_KEY / BR_EVIDENCE_DEV_KEY / BR_DEV_AUTH_SECRET). Values must be generated per run.
//  3. Production (non-test) TypeScript must never embed literal key material for a cipher.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const repo = new URL('..', import.meta.url).pathname;
let failures = 0;
const fail = (where, what) => {
  console.error(`${where}: ${what}`);
  failures++;
};

// 1 · migrations
const FORBIDDEN_COLUMN =
  /\b(private_key|privkey|secret_key|mnemonic|seed_phrase|seed|wallet_credentials)\b\s+(text|bytea|jsonb|json|varchar)/i;
const migrations = join(repo, 'db/migrations');
for (const file of readdirSync(migrations).filter((f) => f.endsWith('.sql'))) {
  readFileSync(join(migrations, file), 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (FORBIDDEN_COLUMN.test(line) && !line.trimStart().startsWith('--'))
        fail(`${file}:${i + 1}`, `forbidden key-material column: ${line.trim()}`);
    });
}

// 2 · repository content
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'coverage', '.turbo']);
const TEXT = /\.(ts|tsx|mts|js|mjs|cjs|json|sql|md|ya?ml|py|sh|env|example|txt)$|^\.env/;
const RULES = [
  [/-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/, 'PEM private key'],
  [/"(?:d|p|q|dp|dq|qi|k)"\s*:\s*"[A-Za-z0-9_-]{32,}"/, 'private JWK member with a value'],
  [
    /\b(?:mnemonic|seedPhrase|seed_phrase)\b\s*[:=]\s*['"`](?:[a-z]{3,8} ){11,23}[a-z]{3,8}['"`]/i,
    'seed phrase',
  ],
  [
    /\bBR_(?:VAULT_DEV_KEY|EVIDENCE_DEV_KEY|DEV_AUTH_SECRET)=(?!\$|\s|$|<|\.\.\.)[^\s'"`]+/,
    'development key/secret with a committed value',
  ],
];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walk(path);
    else if (TEXT.test(name) && st.size < 2_000_000 && !name.endsWith('pnpm-lock.yaml')) {
      const rel = relative(repo, path);
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const [re, what] of RULES) if (re.test(line)) fail(`${rel}:${i + 1}`, what);
          // 3 · literal cipher key material in production code (tests may use fake fixtures)
          if (
            /^(apps|packages)\/[^/]+\/src\//.test(rel) &&
            !/\.(test|int\.test)\.tsx?$/.test(rel) &&
            /\bkeyMaterial\s*:\s*['"`][^'"`]{8,}/.test(line) &&
            // domain-tag / label constants (e.g. DomainTag.keyMaterial = 'key-material') are not keys
            !/\bkeyMaterial\s*:\s*'[a-z-]+'/.test(line)
          )
            fail(`${rel}:${i + 1}`, 'literal key material in production code');
        });
    }
  }
};
walk(repo);

if (failures > 0) process.exit(1);
console.log(
  'key-material guard: no forbidden columns, private keys, seed phrases or committed dev secrets',
);
