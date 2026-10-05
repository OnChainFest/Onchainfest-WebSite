import { prepareIntegrationDatabase } from '@br/testkit';

/** Integration tests run against a freshly reset, fully migrated test database. */
export default async function setup(): Promise<void> {
  await prepareIntegrationDatabase();
}
