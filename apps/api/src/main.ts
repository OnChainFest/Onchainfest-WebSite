import {
  createDevelopmentPiiCipher,
  createTestWalletVerifier,
  eip155EoaPersonalSignVerifier,
  type PiiCipher,
} from '@br/identity';
import { createDb, databaseUrls } from '@br/persistence';
import { buildServer } from './server';

const production = process.env.NODE_ENV === 'production';
const urls = databaseUrls();
const db = createDb(urls.api, { max: 5 });
const vaultDb = createDb(urls.vault, { max: 2 });

// No KMS-backed cipher exists yet. Production runs without private-data storage (503
// PRIVATE_DATA_UNAVAILABLE). Development uses the dev cipher only when BR_VAULT_DEV_KEY is set
// explicitly — there is no built-in key.
let piiCipher: PiiCipher | undefined;
if (!production && (process.env.BR_VAULT_DEV_KEY ?? '') !== '')
  piiCipher = createDevelopmentPiiCipher();

const devAuth = !production && process.env.BR_DEV_AUTH === '1';
const app = buildServer({
  db,
  vaultDb,
  ...(piiCipher === undefined ? {} : { piiCipher }),
  // The test wallet verifier (TEST_VERIFIED only) is available with development auth only.
  walletVerifiers: devAuth
    ? [eip155EoaPersonalSignVerifier, createTestWalletVerifier()]
    : [eip155EoaPersonalSignVerifier],
  logger: true,
});
const port = Number(process.env.PORT ?? 4000);

const shutdown = async () => {
  await app.close();
  await Promise.all([db.destroy(), vaultDb.destroy()]);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: process.env.HOST ?? '127.0.0.1', port });
