import { ownerDatabaseUrl } from '../config';
import { migrate } from '../migrate';

// Only the owner login is needed (LAUNCH-02: production requires BR_OWNER_DATABASE_URL alone).
const database = process.argv[2];
const applied = await migrate(ownerDatabaseUrl(database));
console.log(
  applied.length === 0 ? 'migrations: up to date' : `migrations applied: ${applied.join(', ')}`,
);
