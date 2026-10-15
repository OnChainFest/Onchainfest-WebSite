#!/usr/bin/env node
// LAUNCH-02 guardrail (ADR-0004, ADR-0020, ADR-0064 §7, ADR-0077): sporting authority is created
// only through the AuthorityStore commands, and only outside request handling.
// This scan fails on:
//   · authority-creating calls in application code (apps/**): issueGrant, revokeGrant,
//     recognizeTrustAnchor, revokeTrustAnchor, `new AuthorityStore(`, ResultAuthorityGovernance.
//     Only the existing acceptance walkthroughs (apps/api/src/cli/demo-*.ts) may build fixtures;
//   · HTTP routes whose path names grants, trust anchors or authority (no "give me a permission"
//     endpoint; the operator command `pnpm authority:results` is the only issuance path);
//   · raw SQL writes into authority.* (INSERT / UPDATE / DELETE / TRUNCATE, or Kysely
//     insertInto / updateTable / deleteFrom) outside the authority writers;
//   · ResultAuthorityGovernance referenced outside its module, the persistence index and its CLI.
// Tests (*.test.ts) are exempt, as are comment lines. Usage: node check-no-manual-authority.mjs [root]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const root = process.argv[2] ?? new URL('../', import.meta.url).pathname;
const offenders = [];

const AUTHORITY_WRITERS = new Set([
  'packages/persistence/src/authority-store.ts',
  'packages/persistence/src/key-ceremony-store.ts',
  'packages/persistence/src/organization-store.ts',
]);
const GOVERNANCE_ALLOWED = new Set([
  'packages/persistence/src/result-authority.ts',
  'packages/persistence/src/index.ts',
  'packages/persistence/src/cli/result-authority.ts',
]);
const DEMO = /^apps\/api\/src\/cli\/demo-[a-z-]+\.ts$/;

const AUTHORITY_CALL =
  /\.(issueGrant|revokeGrant|recognizeTrustAnchor|revokeTrustAnchor)\s*\(|new\s+AuthorityStore\s*\(|\bResultAuthorityGovernance\b/;
const AUTHORITY_ROUTE = /['"`]\/v1\/[^'"`]*\b(grants?|trust-anchors?|authority|authorities)\b/i;
const RAW_AUTHORITY_WRITE =
  /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(\s+TABLE)?)\s+authority\.|\b(insertInto|updateTable|deleteFrom)\(\s*['"`]authority\./i;

const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

function scan(rel, text) {
  const inApps = rel.startsWith('apps/');
  text.split('\n').forEach((line, i) => {
    if (isComment(line)) return;
    const at = `${rel}:${i + 1}`;
    if (inApps && !DEMO.test(rel) && AUTHORITY_CALL.test(line))
      offenders.push(`${at} authority issuance in application code`);
    if (inApps && AUTHORITY_ROUTE.test(line))
      offenders.push(`${at} HTTP route exposing authority grants or anchors`);
    if (!AUTHORITY_WRITERS.has(rel) && RAW_AUTHORITY_WRITE.test(line))
      offenders.push(`${at} raw write into authority.* outside the authority writers`);
    if (!inApps && !GOVERNANCE_ALLOWED.has(rel) && /\bResultAuthorityGovernance\b/.test(line))
      offenders.push(`${at} ResultAuthorityGovernance outside the operator command`);
  });
}

function walk(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === 'node_modules' || name === '.next' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\.[tj]sx?$/.test(name)) {
      const rel = relative(root, path).split(sep).join('/');
      if (rel.startsWith('packages/testkit/')) continue;
      scan(rel, readFileSync(path, 'utf8'));
    }
  }
}
walk(join(root, 'apps'));
walk(join(root, 'packages'));

if (offenders.length > 0) {
  console.error('manual authority path detected (ADR-0077):');
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}
console.log(
  'authority guard: no grant / anchor issuance in application code, no authority route, no raw authority write, governance only via the operator command',
);
