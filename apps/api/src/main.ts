import {
  createDevelopmentPiiCipher,
  createTestWalletVerifier,
  eip155EoaPersonalSignVerifier,
  type PiiCipher,
} from '@br/identity';
import { developmentEvidenceBlobStore } from '@br/evidence';
import { apiDatabaseUrl, createDb, vaultDatabaseUrl } from '@br/persistence';
import { loadApiRuntimeConfig } from './config';
import { buildServer } from './server';

// LAUNCH-02: validate the whole runtime configuration before opening any connection (fail closed).
const config = loadApiRuntimeConfig();
const production = config.production;
const db = createDb(apiDatabaseUrl(), { max: 5 });
const vaultDb = createDb(vaultDatabaseUrl(), { max: 2 });
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

// BRT-08: the achievement-rule operator connection is opt-in as well (no fallback to br_api).
const achievementOperatorUrl = process.env.BR_ACHIEVEMENT_OPERATOR_DATABASE_URL;
const achievementOperatorDb =
  achievementOperatorUrl !== undefined && achievementOperatorUrl !== ''
    ? createDb(achievementOperatorUrl, { max: 2 })
    : undefined;

// BRT-09: the record-category operator connection is opt-in as well (no fallback to br_api).
const recordOperatorUrl = process.env.BR_RECORD_OPERATOR_DATABASE_URL;
const recordOperatorDb =
  recordOperatorUrl !== undefined && recordOperatorUrl !== ''
    ? createDb(recordOperatorUrl, { max: 2 })
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
const signatureAudience = config.signatureAudience;

const devAuth = !production && process.env.BR_DEV_AUTH === '1';
const app = buildServer({
  db,
  vaultDb,
  ...(operatorDb === undefined ? {} : { operatorDb }),
  ...(verificationOperatorDb === undefined ? {} : { verificationOperatorDb }),
  ...(achievementOperatorDb === undefined ? {} : { achievementOperatorDb }),
  ...(recordOperatorDb === undefined ? {} : { recordOperatorDb }),
  ...(piiCipher === undefined ? {} : { piiCipher }),
  ...(evidenceBlobStore === undefined ? {} : { evidenceBlobStore }),
  ...(signatureAudience === undefined ? {} : { signatureAudience }),
  // ADR-0077 §2.5: result conflict-of-interest questions are answered from database participation.
  resultParticipationIndex: true,
  hsts: production,
  // The test wallet verifier (TEST_VERIFIED only) is available with development auth only.
  walletVerifiers: devAuth
    ? [eip155EoaPersonalSignVerifier, createTestWalletVerifier()]
    : [eip155EoaPersonalSignVerifier],
  logger: true,
});

const shutdown = async () => {
  await app.close();
  await Promise.all([
    db.destroy(),
    vaultDb.destroy(),
    operatorDb?.destroy(),
    verificationOperatorDb?.destroy(),
    achievementOperatorDb?.destroy(),
    recordOperatorDb?.destroy(),
  ]);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: config.host, port: config.port });
