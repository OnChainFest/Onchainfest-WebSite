import {
  createDevelopmentPiiCipher,
  createTestWalletVerifier,
  eip155EoaPersonalSignVerifier,
  type PiiCipher,
} from '@br/identity';
import { developmentEvidenceBlobStore } from '@br/evidence';
import { createDb, databaseUrls } from '@br/persistence';
import { buildServer } from './server';

const production = process.env.NODE_ENV === 'production';
const urls = databaseUrls();
const db = createDb(urls.api, { max: 5 });
const vaultDb = createDb(urls.vault, { max: 2 });
// BRT-05R: the operator (catalog-writer) connection is opt-in, even in development: only an
// explicitly configured BR_OPERATOR_DATABASE_URL enables INTERNAL catalog mutation.
const operatorUrl = process.env.BR_OPERATOR_DATABASE_URL;
const operatorDb =
  operatorUrl !== undefined && operatorUrl !== '' ? createDb(operatorUrl, { max: 2 }) : undefined;
// BRT-07: the verification-policy operator connection is opt-in as well (no fallback to br_api).
const verificationOperatorUrl = process.env.BR_VERIFICATION_OPERATOR_DATABASE_URL;
const verificationOperatorDb =
  verificationOperatorUrl !== undefined && verificationOperatorUrl !== ''
    ? createDb(verificationOperatorUrl, { max: 2 })
    : undefined;

// No KMS-backed cipher exists yet. Production runs without private-data storage (503
// PRIVATE_DATA_UNAVAILABLE). Development uses the dev cipher only when BR_VAULT_DEV_KEY is set
// explicitly — there is no built-in key.
let piiCipher: PiiCipher | undefined;
if (!production && (process.env.BR_VAULT_DEV_KEY ?? '') !== '')
  piiCipher = createDevelopmentPiiCipher();

// BRT-06: evidence bytes need a blob store. No production object storage + KMS adapter exists yet,
// so production evidence ingestion fails closed (503). Development uses the encrypted filesystem
// store only when BR_EVIDENCE_DEV_DIR and BR_EVIDENCE_DEV_KEY are both set explicitly.
const evidenceBlobStore = production ? undefined : developmentEvidenceBlobStore();
const signatureAudience = process.env.BR_SIGNATURE_AUDIENCE;

const devAuth = !production && process.env.BR_DEV_AUTH === '1';
const app = buildServer({
  db,
  vaultDb,
  ...(operatorDb === undefined ? {} : { operatorDb }),
  ...(verificationOperatorDb === undefined ? {} : { verificationOperatorDb }),
  ...(piiCipher === undefined ? {} : { piiCipher }),
  ...(evidenceBlobStore === undefined ? {} : { evidenceBlobStore }),
  ...(signatureAudience === undefined || signatureAudience === '' ? {} : { signatureAudience }),
  // The test wallet verifier (TEST_VERIFIED only) is available with development auth only.
  walletVerifiers: devAuth
    ? [eip155EoaPersonalSignVerifier, createTestWalletVerifier()]
    : [eip155EoaPersonalSignVerifier],
  logger: true,
});
const port = Number(process.env.PORT ?? 4000);

const shutdown = async () => {
  await app.close();
  await Promise.all([
    db.destroy(),
    vaultDb.destroy(),
    operatorDb?.destroy(),
    verificationOperatorDb?.destroy(),
  ]);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: process.env.HOST ?? '127.0.0.1', port });
