import { databaseUrls, devRolePasswords } from '../config';
import { bootstrapDatabase, resetDatabase } from '../bootstrap';
import { migrate } from '../migrate';

/** Development only: drop canonical schemas, re-bootstrap roles/grants, re-run all migrations. */
const database = process.argv[2] ?? 'bragging_rights';
const urls = databaseUrls(database);
await bootstrapDatabase(databaseUrls().admin, [database], devRolePasswords());
await resetDatabase(urls.admin, database);
const applied = await migrate(urls.owner);
console.log(`reset ${database}; migrations applied: ${applied.join(', ')}`);
