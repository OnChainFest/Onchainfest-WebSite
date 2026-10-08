import { DomainError } from '@br/domain';
import {
  eip155EoaPersonalSignVerifier,
  type PiiCipher,
  type WalletProofVerifier,
} from '@br/identity';
import { unavailableEvidenceBlobStore, type EvidenceBlobStore } from '@br/evidence';
import {
  AchievementPublicReader,
  AchievementRuleStore,
  AchievementService,
  RecordCategoryStore,
  RecordPublicReader,
  RecordService,
  RankingPublicReader,
  RankingStaffReader,
  AttestationPublicReader,
  AttestationStore,
  CatalogStore,
  CompetitionReader,
  CompetitionStore,
  IdentityStore,
  OrganizationReader,
  OrganizationStore,
  PassportReader,
  EvidenceBundleService,
  EvidenceStore,
  PersonPrincipalService,
  PersonPrivateDataService,
  PrincipalKeyCeremony,
  ScoringStore,
  StructureStore,
  TeamStore,
  VerificationPolicyStore,
  VerificationPublicReader,
  VerificationService,
  pendingMigrations,
  type Db,
} from '@br/persistence';
import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { authFromEnvironment, type AuthAdapter } from './auth';
import { errorBody, registerV1, type RouteInfo } from './v1';

export interface ApiOptions {
  /** br_api login. */
  readonly db: Db;
  /** br_api_vault login; private-data endpoints fail closed (503) without it or without a cipher. */
  readonly vaultDb?: Db;
  /**
   * BRT-05R: br_operator_app login (→ br_catalog only). INTERNAL catalog mutation uses it and
   * nothing else; without it catalog mutation answers 503 INTERNAL_CAPABILITY_UNAVAILABLE.
   */
  readonly operatorDb?: Db;
  /**
   * BRT-07: br_verification_operator_app login (→ br_verification_policy only). INTERNAL policy
   * mutation uses it and nothing else; without it policy mutation answers 503
   * INTERNAL_CAPABILITY_UNAVAILABLE while verification reads and evaluations keep working.
   */
  readonly verificationOperatorDb?: Db;
  /**
   * BRT-08: br_achievement_operator_app login (→ br_achievement_rules only). INTERNAL rule mutation
   * uses it and nothing else; without it rule mutation answers 503 INTERNAL_CAPABILITY_UNAVAILABLE
   * while public reads and canonical derivation keep working.
   */
  readonly achievementOperatorDb?: Db;
  /**
   * BRT-09: br_record_operator_app login (→ br_record_rules only). INTERNAL category mutation is
   * available only when this connection is configured (503 otherwise; no fallback to br_api).
   */
  readonly recordOperatorDb?: Db;
  readonly piiCipher?: PiiCipher;
  /** Defaults to `authFromEnvironment` (production: fail closed). */
  readonly auth?: (identity: IdentityStore) => AuthAdapter;
  /** Defaults to the production EIP-191 verifier only. Test verifiers must be injected explicitly. */
  readonly walletVerifiers?: readonly WalletProofVerifier[];
  /**
   * BRT-06 evidence blob store. Defaults to the fail-closed placeholder: without a configured store
   * (production has no object storage + KMS adapter yet) evidence ingestion and content reads answer
   * 503 EVIDENCE_STORAGE_UNAVAILABLE, while metadata, attestations and bundles keep working.
   */
  readonly evidenceBlobStore?: EvidenceBlobStore;
  /** Signature audience (environment binding) for signed statements, e.g. "bragging-rights:prod". */
  readonly signatureAudience?: string;
  readonly logger?: boolean;
  /** Destination for the (redacted) logger; enables logging. Used by tests to inspect log output. */
  readonly logStream?: { write(line: string): void };
}

export type ApiServer = FastifyInstance & { readonly v1Routes: readonly RouteInfo[] };

/**
 * API: health/readiness plus the /v1 identity, passport, organization (BRT-04), catalog and
 * competition (BRT-05), evidence and attestation (BRT-06), verification (BRT-07), achievement (BRT-08), record (BRT-09), ranking / classification read (BRT-10) endpoints.
 * Logs never include request bodies or the Authorization header.
 */
export function buildServer(options: ApiOptions): ApiServer {
  const app = Fastify({
    // Unknown DTO fields are rejected, never silently stripped or coerced.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, allErrors: false } },
    logger:
      options.logger === true || options.logStream !== undefined
        ? {
            ...(options.logStream === undefined
              ? {}
              : { stream: options.logStream, level: 'debug' }),
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.headers["idempotency-key"]',
              ],
              remove: true,
            },
          }
        : false,
  });

  const identity = new IdentityStore(options.db, {
    walletVerifiers: options.walletVerifiers ?? [eip155EoaPersonalSignVerifier],
  });
  const organizations = new OrganizationStore(options.db);
  const privateData =
    options.vaultDb !== undefined && options.piiCipher !== undefined
      ? new PersonPrivateDataService(options.vaultDb, options.piiCipher)
      : undefined;
  const auth = (options.auth ?? authFromEnvironment)(identity);
  const audience =
    options.signatureAudience ??
    (process.env.NODE_ENV === 'production'
      ? 'bragging-rights:prod'
      : 'bragging-rights:development');

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof DomainError) {
      const { status, body } = errorBody(err);
      return reply.code(status).send(body);
    }
    const e = err as { validation?: unknown; statusCode?: number; message?: string };
    if (e.validation !== undefined) {
      return reply
        .code(400)
        .send({ error: { code: 'INVALID_INPUT', message: e.message ?? 'invalid request' } });
    }
    if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
      return reply
        .code(e.statusCode)
        .send({ error: { code: 'BAD_REQUEST', message: 'bad request' } });
    }
    // Unknown failures: no SQL details or values in the response or logs.
    request.log.error(
      { errName: (err as Error).name, pgCode: (err as { code?: string }).code },
      'unhandled error',
    );
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'internal error' } });
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'bragging-rights-api',
    phase: 'BRT-09',
  }));

  app.get('/ready', async (_request, reply) => {
    try {
      // Runs as the api login itself (no module role): it may only read the migration ledger.
      const pending = await options.db.transaction().execute(async (trx) => {
        await sql`SELECT 1`.execute(trx);
        return pendingMigrations(async (text) => {
          const { rows } = await sql.raw<{ version: string }>(text).execute(trx);
          return { rows };
        });
      });
      if (pending.length > 0)
        return reply.code(503).send({ status: 'not_ready', reason: 'pending_migrations', pending });
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'not_ready', reason: 'database_unavailable' });
    }
  });

  const v1Routes = registerV1(app, {
    auth,
    identity,
    organizations,
    passports: new PassportReader(options.db),
    organizationReader: new OrganizationReader(options.db),
    competition: {
      ...(options.operatorDb === undefined
        ? {}
        : { catalog: new CatalogStore(options.operatorDb) }),
      competitions: new CompetitionStore(options.db),
      structure: new StructureStore(options.db),
      teams: new TeamStore(options.db),
      reader: new CompetitionReader(options.db),
      scoring: new ScoringStore(options.db),
    },
    ...(privateData === undefined ? {} : { privateData }),
    evidence: {
      evidence: new EvidenceStore(options.db, {
        blobStore: options.evidenceBlobStore ?? unavailableEvidenceBlobStore,
      }),
      attestations: new AttestationStore(options.db, { audience }),
      keys: new PrincipalKeyCeremony(options.db, { audience }),
      persons: new PersonPrincipalService(options.db),
      bundles: new EvidenceBundleService(options.db),
      publicReader: new AttestationPublicReader(options.db),
    },
    verification: {
      verification: new VerificationService(options.db),
      publicReader: new VerificationPublicReader(options.db),
      ...(options.verificationOperatorDb === undefined
        ? {}
        : { policies: new VerificationPolicyStore(options.verificationOperatorDb) }),
    },
    achievements: {
      achievements: new AchievementService(options.db),
      publicReader: new AchievementPublicReader(options.db),
      ...(options.achievementOperatorDb === undefined
        ? {}
        : { rules: new AchievementRuleStore(options.achievementOperatorDb) }),
    },
    records: {
      records: new RecordService(options.db),
      publicReader: new RecordPublicReader(options.db),
      ...(options.recordOperatorDb === undefined
        ? {}
        : { categories: new RecordCategoryStore(options.recordOperatorDb) }),
    },
    // BRT-10 reads only: no ranking-definition, run, snapshot or classification writer on the API.
    rankings: {
      publicReader: new RankingPublicReader(options.db),
      staffReader: new RankingStaffReader(options.db),
    },
  });

  return Object.assign(app, { v1Routes });
}
