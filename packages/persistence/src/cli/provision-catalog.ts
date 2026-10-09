import { CANONICAL_CLASSIFICATION_TEMPLATES } from '@br/rankings';
import { CANONICAL_CATALOG } from '@br/competition';
import { CatalogStore } from '../catalog-store';
import { operatorDatabaseUrl } from '../config';
import { createDb } from '../db';

/**
 * ONCF-03A · Provision the canonical sport catalog (padel, tennis; single elimination, round
 * robin) in ANY environment, production included. Unlike the development seeds this creates no
 * accounts, organizations or competitions — only `sports.*` catalog rows, through the operator
 * login (`br_operator_app` → `br_catalog`), lookup-first and idempotent (see CatalogStore.provision).
 *
 *   pnpm db:catalog:provision --operator-account <uuid> [--dry-run]
 *
 * The operator account (flag, or BR_CATALOG_OPERATOR_ACCOUNT_ID) must be an existing platform
 * account (catalog rows record who created them); it is never invented here. In production BR_OPERATOR_DATABASE_URL must be set explicitly.
 * Exit code 2 when the catalog has conflicts the operator must resolve.
 */
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const at = args.indexOf('--operator-account');
const operatorAccountId = at >= 0 ? args[at + 1] : process.env.BR_CATALOG_OPERATOR_ACCOUNT_ID;
if (
  operatorAccountId === undefined ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operatorAccountId)
) {
  console.error('usage: db:catalog:provision --operator-account <account uuid> [--dry-run]');
  process.exit(1);
}
const url = operatorDatabaseUrl();
if (url === undefined) {
  console.error('catalog provisioning needs BR_OPERATOR_DATABASE_URL (operator login)');
  process.exit(1);
}

const db = createDb(url, { max: 2 });
try {
  const report = await new CatalogStore(db).provision({
    operatorAccountId,
    manifest: CANONICAL_CATALOG,
    classificationTemplates: CANONICAL_CLASSIFICATION_TEMPLATES,
    dryRun,
  });
  for (const s of report.steps)
    console.log(`${s.action.padEnd(13)} ${s.kind.padEnd(18)} ${s.code}${s.id ? `  ${s.id}` : ''}`);
  for (const c of report.conflicts) console.error(`CONFLICT      ${c.code}: ${c.reason}`);
  if (report.conflicts.length > 0) process.exitCode = 2;
} catch (err) {
  // A missing operator account surfaces as a foreign-key violation on the first insert.
  if ((err as { code?: string }).code === '23503') {
    console.error('operator account not found: pass an existing platform account id');
    process.exitCode = 1;
  } else throw err;
} finally {
  await db.destroy();
}
