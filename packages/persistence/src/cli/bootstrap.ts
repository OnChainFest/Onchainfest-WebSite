import {
  adminDatabaseUrl,
  databaseUrls,
  devRolePasswords,
  productionRolePasswords,
} from '../config';
import { bootstrapDatabase } from '../bootstrap';

// Development/test: the local cluster, the dev and test databases, development passwords.
// Production (NODE_ENV=production; LAUNCH-02): exactly one database (BR_DATABASE_NAME), the admin
// login from BR_ADMIN_DATABASE_URL and an explicit password per login (productionRolePasswords).
// Nothing falls back to a development value. Idempotent: roles converge, passwords are (re)set.
if (process.env.NODE_ENV === 'production') {
  const database = process.env.BR_DATABASE_NAME ?? '';
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(database))
    throw new Error('BR_DATABASE_NAME must be set in production (lowercase identifier)');
  const passwords = productionRolePasswords();
  await bootstrapDatabase(adminDatabaseUrl(), [database], passwords);
  console.log(`bootstrap complete: roles + passwords + hardening for ${database}`);
} else {
  const urls = databaseUrls();
  const databases = [
    'bragging_rights',
    process.env.BR_TEST_DATABASE_NAME ?? 'bragging_rights_test',
  ];
  await bootstrapDatabase(urls.admin, databases, devRolePasswords());
  console.log(`bootstrap complete: roles + hardening for ${databases.join(', ')}`);
}
