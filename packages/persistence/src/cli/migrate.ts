import { databaseUrls } from '../config';
import { migrate } from '../migrate';

const database = process.argv[2];
const applied = await migrate(databaseUrls(database).owner);
console.log(
  applied.length === 0 ? 'migrations: up to date' : `migrations applied: ${applied.join(', ')}`,
);
