import { databaseUrls, devRolePasswords } from '../config';
import { bootstrapDatabase } from '../bootstrap';

const urls = databaseUrls();
const databases = ['bragging_rights', process.env.BR_TEST_DATABASE_NAME ?? 'bragging_rights_test'];
await bootstrapDatabase(urls.admin, databases, devRolePasswords());
console.log(`bootstrap complete: roles + hardening for ${databases.join(', ')}`);
