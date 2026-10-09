import { DomainError, DomainErrorCode, type EvidenceType } from '@br/domain';
import { decodeStrictBase64, MAX_REFERENCE_UPLOAD_BYTES, type JwsAlgorithm } from '@br/evidence';
import type {
  AttestationPublicReader,
  AttestationStore,
  EvidenceBundleService,
  EvidenceStore,
  PersonPrincipalService,
  PrincipalKeyCeremony,
} from '@br/persistence';
import type { FastifyRequest } from 'fastify';
import { defined, idempotencyHeaders, idParams, obj, uuid, type V1Toolkit } from './v1';

export interface EvidenceV1Deps {
  readonly evidence: EvidenceStore;
  readonly attestations: AttestationStore;
  readonly keys: PrincipalKeyCeremony;
  readonly persons: PersonPrincipalService;
  readonly bundles: EvidenceBundleService;
  readonly publicReader: AttestationPublicReader;
}

/** base64 length of the reference upload cap (+ padding). */
const MAX_BASE64 = Math.ceil(MAX_REFERENCE_UPLOAD_BYTES / 3) * 4;
const code = (max: number) =>
  ({ type: 'string', pattern: '^[A-Z][A-Z0-9_]*$', maxLength: max }) as const;
const instant = { type: 'string', minLength: 20, maxLength: 40 } as const;
const toDate = (value: string | undefined, what: string): Date | undefined => {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(value))
    throw new DomainError(DomainErrorCode.INVALID_INPUT, `${what} must be an RFC 3339 instant`);
  const d = new Date(value);
  if (Number.isNaN(d.getTime()))
    throw new DomainError(DomainErrorCode.INVALID_INPUT, `${what} is invalid`);
  return d;
};

/**
 * BRT-06 /v1 surface. Evidence is authenticated + resource policy (decided in the store); raw
 * bytes need an authorized viewer and are served as attachments with nosniff. Attestation
 * submission needs an authenticated account that represents the issuer AND a valid proof — it is
 * accepted without any authority decision and never verifies a Result. PUBLIC reads return the
 * public-safe signed-claim card only.
 */
export function registerEvidenceV1(t: V1Toolkit, deps: EvidenceV1Deps): void {
  const { route, requireAuth, operator, key } = t;
  // Built lazily: `obj` comes from ./v1, which imports this module (same pattern as v1-competition).
  const systemRef = obj(
    {
      id: { type: 'string', pattern: '^[a-z0-9][a-z0-9._:-]{0,99}$' },
      version: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$' },
    },
    ['id', 'version'],
  );
  const proof = obj(
    {
      proofType: { enum: ['DIRECT_SIGNATURE'] },
      scheme: { enum: ['JWS_DETACHED'] },
      protected: { type: 'string', minLength: 1, maxLength: 256 },
      signature: { type: 'string', minLength: 1, maxLength: 128 },
    },
    ['proofType', 'scheme', 'protected', 'signature'],
  );
  const submitBody = obj(
    {
      challengeId: uuid,
      statementHash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
      // Optional echo of the signed statement: re-canonicalized strictly (unknown members rejected).
      statement: { type: 'object' },
      proof,
    },
    ['challengeId', 'proof'],
  );
  const claim = obj(
    {
      type: { enum: ['RESULT_ACCURATE', 'CONDITIONS_COMPLIANT'] },
      polarity: { enum: ['AFFIRM', 'DENY'] },
      payload: obj({
        conditions: {
          type: 'array',
          maxItems: 32,
          items: obj(
            {
              aspect: {
                enum: [
                  'WIND',
                  'TEMPERATURE',
                  'HUMIDITY',
                  'ALTITUDE',
                  'SURFACE',
                  'LIGHTING',
                  'EQUIPMENT',
                  'TIMING_SYSTEM',
                  'COURSE_CONFIGURATION',
                  'OTHER',
                ],
              },
              key: { type: 'string', pattern: '^[a-z0-9]+(?:[._-][a-z0-9]+)*$', maxLength: 64 },
              value: { type: 'string', maxLength: 40 },
              unit: { type: 'string', minLength: 1, maxLength: 16 },
              code: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,31}$' },
            },
            ['aspect', 'key'],
          ),
        },
        reasonCode: {
          enum: ['SCORE_INCORRECT', 'OUTCOME_INCORRECT', 'PARTICIPANT_INCORRECT', 'OTHER'],
        },
      }),
    },
    ['type', 'polarity'],
  );
  const params = <T>(request: FastifyRequest) => request.params as T;
  const body = <T>(request: FastifyRequest) => request.body as T;

  // ───────────────────────────── PUBLIC ─────────────────────────────

  route(
    'GET',
    '/v1/attestations/:attestationId',
    'PUBLIC',
    { params: idParams('attestationId') },
    async (request) => {
      const card = await deps.publicReader.attestation(
        params<{ attestationId: string }>(request).attestationId,
      );
      if (card === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'attestation not found');
      return card;
    },
  );

  route(
    'GET',
    '/v1/result-versions/:resultVersionId/attestations',
    'PUBLIC',
    { params: idParams('resultVersionId') },
    async (request) => ({
      notice: 'Cryptographically signed claims. Sporting verification is evaluated separately.',
      items: await deps.publicReader.resultVersionAttestations(
        params<{ resultVersionId: string }>(request).resultVersionId,
      ),
    }),
  );

  // ───────────────────────────── evidence (AUTHENTICATED + resource policy) ─────────────────────────────

  route(
    'POST',
    '/v1/evidence',
    'AUTHENTICATED',
    {
      headers: idempotencyHeaders,
      body: obj(
        {
          content: obj(
            {
              base64: { type: 'string', minLength: 4, maxLength: MAX_BASE64 + 4 },
              mediaType: { type: 'string', minLength: 3, maxLength: 64 },
            },
            ['base64', 'mediaType'],
          ),
          evidenceType: {
            enum: [
              'SCORING_SYSTEM_EXPORT',
              'TIMING_SYSTEM_EXPORT',
              'SIGNED_SCORESHEET',
              'OFFICIAL_REPORT',
              'FEDERATION_RECORD',
              'PROVIDER_FEED',
              'SENSOR_DATA',
              'VIDEO',
              'IMAGE',
              'AUDIO',
              'DOCUMENT',
              'HISTORICAL_ARCHIVE',
              'OFFICIATING_SYSTEM_OUTPUT',
              'AI_DERIVED',
              'MANUAL_ENTRY',
            ],
          },
          source: obj(
            {
              kind: { enum: ['HUMAN', 'ORGANIZATION', 'AI_PIPELINE'] },
              principalId: uuid,
              system: systemRef,
              externalNamespace: { type: 'string', pattern: '^[a-z0-9][a-z0-9:._-]{1,99}$' },
              externalId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$' },
              capturedAt: instant,
            },
            ['kind'],
          ),
          privacyClass: { enum: ['PLATFORM_PRIVATE', 'AUTHORITY_ONLY'] },
          derivation: obj(
            {
              generator: obj(
                {
                  kind: {
                    enum: [
                      'AI_PIPELINE',
                      'OCR',
                      'TRANSCODER',
                      'REDACTION_TOOL',
                      'CERTIFIED_SYSTEM',
                      'OTHER',
                    ],
                  },
                  systemId: { type: 'string', pattern: '^[a-z0-9][a-z0-9._:-]{0,99}$' },
                  version: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$' },
                  configurationHash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
                },
                ['kind', 'systemId', 'version'],
              ),
              generatedAt: instant,
              inputEvidenceIds: { type: 'array', minItems: 1, maxItems: 64, items: uuid },
            },
            ['generator', 'inputEvidenceIds'],
          ),
          lineage: {
            type: 'array',
            maxItems: 64,
            items: obj(
              {
                relation: {
                  enum: ['DERIVED_FROM', 'REDACTED_FROM', 'TRANSFORMED_FROM', 'SUPERSEDES'],
                },
                evidenceId: uuid,
              },
              ['relation', 'evidenceId'],
            ),
          },
          attachTo: obj(
            {
              targetType: { enum: ['RESULT_VERSION', 'CONTEST', 'EVENT'] },
              targetId: uuid,
              role: { enum: ['PRIMARY', 'SUPPORTING', 'CONTEXT'] },
            },
            ['targetType', 'targetId', 'role'],
          ),
        },
        ['content', 'evidenceType', 'source'],
      ),
    },
    async (request, reply) => {
      const ctx = requireAuth(request);
      const b = body<{
        content: { base64: string; mediaType: string };
        evidenceType: EvidenceType;
        source: {
          kind: 'HUMAN' | 'ORGANIZATION' | 'AI_PIPELINE';
          principalId?: string;
          system?: { id: string; version: string };
          externalNamespace?: string;
          externalId?: string;
          capturedAt?: string;
        };
        privacyClass?: 'PLATFORM_PRIVATE' | 'AUTHORITY_ONLY';
        derivation?: {
          generator: {
            kind:
              | 'AI_PIPELINE'
              | 'OCR'
              | 'TRANSCODER'
              | 'REDACTION_TOOL'
              | 'CERTIFIED_SYSTEM'
              | 'OTHER';
            systemId: string;
            version: string;
            configurationHash?: string;
          };
          generatedAt?: string;
          inputEvidenceIds: string[];
        };
        lineage?: {
          relation: 'DERIVED_FROM' | 'REDACTED_FROM' | 'TRANSFORMED_FROM' | 'SUPERSEDES';
          evidenceId: string;
        }[];
        attachTo?: {
          targetType: 'RESULT_VERSION' | 'CONTEST' | 'EVENT';
          targetId: string;
          role: 'PRIMARY' | 'SUPPORTING' | 'CONTEXT';
        };
      }>(request);
      // Never trust a client hash, filename or length: the bytes are decoded strictly and the
      // storage layer computes the SHA-256 of exactly these bytes.
      const bytes = decodeStrictBase64(b.content.base64);
      if (bytes === undefined)
        throw new DomainError(DomainErrorCode.INVALID_INPUT, 'content must be strict base64');
      const capturedAt = toDate(b.source.capturedAt, 'capturedAt');
      const generatedAt = toDate(b.derivation?.generatedAt, 'generatedAt');
      const r = await deps.evidence.ingest({
        actorAccountId: ctx.accountId,
        idempotencyKey: key(request),
        bytes,
        mediaType: b.content.mediaType,
        evidenceType: b.evidenceType,
        source: {
          kind: b.source.kind,
          ...defined({
            principalId: b.source.principalId as never,
            system: b.source.system,
            externalNamespace: b.source.externalNamespace,
            externalId: b.source.externalId,
            capturedAt,
          }),
        },
        ...defined({
          privacyClass: b.privacyClass,
          lineage: b.lineage,
          attachTo: b.attachTo,
          derivation:
            b.derivation === undefined
              ? undefined
              : {
                  generator: defined(b.derivation.generator),
                  ...defined({ generatedAt }),
                  inputEvidenceIds: b.derivation.inputEvidenceIds,
                },
        }),
      });
      reply.code(r.created ? 201 : 200);
      return {
        ...r,
        notice:
          'Evidence is an artefact with provenance. It asserts nothing and is not a verification.',
      };
    },
    { bodyLimit: MAX_BASE64 + 64 * 1024 },
  );

  route(
    'GET',
    '/v1/evidence/:evidenceId',
    'AUTHENTICATED',
    { params: idParams('evidenceId') },
    async (request) => {
      const ctx = requireAuth(request);
      return deps.evidence.metadata(
        { accountId: ctx.accountId },
        params<{ evidenceId: string }>(request).evidenceId,
      );
    },
  );

  route(
    'GET',
    '/v1/evidence/:evidenceId/content',
    'AUTHENTICATED',
    { params: idParams('evidenceId') },
    async (request, reply) => {
      const ctx = requireAuth(request);
      const { evidenceId } = params<{ evidenceId: string }>(request);
      const c = await deps.evidence.content({ accountId: ctx.accountId }, evidenceId);
      // Never rendered inline, never sniffed, never cached, never scriptable.
      reply
        .header('content-type', c.mediaType)
        .header('content-disposition', `attachment; filename="evidence-${evidenceId}"`)
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('cache-control', 'no-store')
        .header('x-evidence-sha256', c.contentHash.slice('sha256:'.length));
      return reply.send(Buffer.from(c.bytes));
    },
  );

  route(
    'POST',
    '/v1/evidence/:evidenceId/attachments',
    'AUTHENTICATED',
    {
      headers: idempotencyHeaders,
      params: idParams('evidenceId'),
      body: obj(
        {
          targetType: { enum: ['RESULT_VERSION', 'CONTEST', 'EVENT'] },
          targetId: uuid,
          role: { enum: ['PRIMARY', 'SUPPORTING', 'CONTEXT'] },
        },
        ['targetType', 'targetId', 'role'],
      ),
    },
    async (request, reply) => {
      const ctx = requireAuth(request);
      const b = body<{
        targetType: 'RESULT_VERSION' | 'CONTEST' | 'EVENT';
        targetId: string;
        role: 'PRIMARY' | 'SUPPORTING' | 'CONTEXT';
      }>(request);
      const r = await deps.evidence.attach({
        actorAccountId: ctx.accountId,
        evidenceId: params<{ evidenceId: string }>(request).evidenceId,
        ...b,
        idempotencyKey: key(request),
      });
      reply.code(r.created ? 201 : 200);
      return {
        ...r,
        meaning: 'ASSOCIATED_WITH (an attachment never asserts the target is correct)',
      };
    },
  );

  for (const [action, toStatus] of [
    ['restrict', 'RESTRICTED'],
    ['restore', 'AVAILABLE'],
  ] as const) {
    route(
      'POST',
      `/v1/evidence/:evidenceId/${action}`,
      'AUTHENTICATED',
      {
        headers: idempotencyHeaders,
        params: idParams('evidenceId'),
        body: obj({ reasonCode: code(40) }, ['reasonCode']),
      },
      async (request) => {
        const ctx = requireAuth(request);
        return deps.evidence.changeAvailability({
          actor: { accountId: ctx.accountId },
          evidenceId: params<{ evidenceId: string }>(request).evidenceId,
          toStatus,
          reasonCode: body<{ reasonCode: string }>(request).reasonCode,
          idempotencyKey: key(request),
        });
      },
    );
  }

  route(
    'POST',
    '/v1/evidence/:evidenceId/raise-privacy',
    'AUTHENTICATED',
    { headers: idempotencyHeaders, params: idParams('evidenceId'), body: obj({}) },
    async (request) => {
      const ctx = requireAuth(request);
      return deps.evidence.raisePrivacy({
        actorAccountId: ctx.accountId,
        evidenceId: params<{ evidenceId: string }>(request).evidenceId,
        idempotencyKey: key(request),
      });
    },
  );

  route(
    'POST',
    '/v1/internal/evidence/:evidenceId/purge',
    'INTERNAL',
    {
      headers: idempotencyHeaders,
      params: idParams('evidenceId'),
      body: obj(
        {
          basis: { enum: ['RETENTION', 'ERASURE'] },
          reasonCode: code(40),
          basisRef: { type: 'string', pattern: '^[A-Za-z0-9:._/-]{1,200}$' },
        },
        ['basis', 'reasonCode', 'basisRef'],
      ),
    },
    async (request) => {
      operator(request);
      const b = body<{ basis: 'RETENTION' | 'ERASURE'; reasonCode: string; basisRef: string }>(
        request,
      );
      return deps.evidence.changeAvailability({
        actor: { internal: true },
        evidenceId: params<{ evidenceId: string }>(request).evidenceId,
        toStatus: b.basis === 'RETENTION' ? 'DELETED_BY_RETENTION' : 'DELETED_BY_ERASURE',
        reasonCode: b.reasonCode,
        basisRef: b.basisRef,
        idempotencyKey: key(request),
      });
    },
  );

  // ───────────────────────────── signing principals & keys ─────────────────────────────

  route(
    'POST',
    '/v1/persons/:personId/principal',
    'SELF',
    { params: idParams('personId') },
    async (request) => {
      const ctx = requireAuth(request);
      return deps.persons.ensure({
        actorAccountId: ctx.accountId,
        personId: params<{ personId: string }>(request).personId,
      });
    },
  );

  route(
    'POST',
    '/v1/principals/:principalId/keys/prepare',
    'ISSUER_REPRESENTATIVE',
    {
      headers: idempotencyHeaders,
      params: idParams('principalId'),
      body: obj(
        {
          algorithm: { enum: ['EdDSA', 'ES256'] },
          // Public members + validated metadata only; private members (d, p, q, k…) are refused.
          publicJwk: obj(
            {
              kty: { enum: ['OKP', 'EC'] },
              crv: { enum: ['Ed25519', 'P-256'] },
              x: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
              y: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
              // RFC 7517 metadata: validated and discarded (never stored, never key identity).
              alg: { enum: ['EdDSA', 'ES256'] },
              use: { enum: ['sig'] },
              key_ops: { type: 'array', maxItems: 1, items: { enum: ['verify'] } },
              kid: { type: 'string', maxLength: 200 },
              ext: { type: 'boolean' },
            },
            ['kty', 'crv', 'x'],
          ),
          effectiveTo: instant,
        },
        ['algorithm', 'publicJwk'],
      ),
    },
    async (request) => {
      const ctx = requireAuth(request);
      const b = body<{
        algorithm: JwsAlgorithm;
        publicJwk: Record<string, string>;
        effectiveTo?: string;
      }>(request);
      const effectiveTo = toDate(b.effectiveTo, 'effectiveTo');
      return deps.keys.prepareKeyRegistration({
        actorAccountId: ctx.accountId,
        idempotencyKey: key(request),
        principalId: params<{ principalId: string }>(request).principalId,
        algorithm: b.algorithm,
        publicJwk: b.publicJwk,
        ...defined({ effectiveTo }),
      });
    },
  );

  route(
    'POST',
    '/v1/principals/:principalId/keys',
    'ISSUER_REPRESENTATIVE',
    { headers: idempotencyHeaders, params: idParams('principalId'), body: submitBody },
    async (request, reply) => {
      const ctx = requireAuth(request);
      const b = body<{
        challengeId: string;
        statementHash?: string;
        proof: { proofType: string; scheme: string; protected: string; signature: string };
      }>(request);
      const r = await deps.keys.submitKeyRegistration({
        actorAccountId: ctx.accountId,
        idempotencyKey: key(request),
        principalId: params<{ principalId: string }>(request).principalId,
        challengeId: b.challengeId,
        proof: b.proof,
        ...defined({ statementHash: b.statementHash }),
      });
      reply.code(201);
      return { ...r, notice: 'A registered public key is not a grant of sporting authority.' };
    },
  );

  for (const [action, kind] of [
    ['revoke', 'REVOKED'],
    ['declare-compromised', 'COMPROMISED'],
  ] as const) {
    route(
      'POST',
      `/v1/principals/:principalId/keys/:keyId/${action}`,
      'ISSUER_REPRESENTATIVE',
      {
        headers: idempotencyHeaders,
        params: obj({ principalId: uuid, keyId: uuid }, ['principalId', 'keyId']),
        body: obj(kind === 'COMPROMISED' ? { compromisedSince: instant } : {}),
      },
      async (request) => {
        const ctx = requireAuth(request);
        const p = params<{ principalId: string; keyId: string }>(request);
        const compromisedSince = toDate(
          body<{ compromisedSince?: string }>(request)?.compromisedSince,
          'compromisedSince',
        );
        return deps.keys.changeKeyStatus({
          actorAccountId: ctx.accountId,
          principalId: p.principalId,
          keyId: p.keyId,
          kind,
          ...defined({ compromisedSince }),
          idempotencyKey: key(request),
        });
      },
    );
  }

  // ───────────────────────────── attestations ─────────────────────────────

  route(
    'POST',
    '/v1/attestations/prepare',
    'ISSUER_REPRESENTATIVE',
    {
      headers: idempotencyHeaders,
      body: obj(
        {
          issuerPrincipalId: uuid,
          keyId: uuid,
          subject: obj({ type: { enum: ['RESULT_VERSION'] }, id: uuid }, ['type', 'id']),
          claim,
          authorityContext: obj(
            {
              actingRole: {
                enum: [
                  'PARTICIPANT',
                  'OPPONENT',
                  'OFFICIAL',
                  'ORGANIZER',
                  'SANCTIONING_BODY',
                  'ACCREDITED_PROVIDER',
                  'SYSTEM',
                ],
              },
              scopeRef: obj(
                { level: { enum: ['COMPETITION', 'EVENT', 'ROUND', 'CONTEST'] }, id: uuid },
                ['level', 'id'],
              ),
            },
            ['actingRole'],
          ),
          evidenceIds: { type: 'array', maxItems: 64, items: uuid },
          supersedesAttestationId: uuid,
          visibility: { enum: ['PUBLIC', 'PRIVATE'] },
        },
        ['issuerPrincipalId', 'keyId', 'subject', 'claim'],
      ),
    },
    async (request) => {
      const ctx = requireAuth(request);
      const b = body<Parameters<AttestationStore['prepare']>[0]>(request);
      return deps.attestations.prepare({
        ...b,
        actorAccountId: ctx.accountId,
        idempotencyKey: key(request),
      });
    },
  );

  route(
    'POST',
    '/v1/attestations',
    'ISSUER_REPRESENTATIVE',
    { headers: idempotencyHeaders, body: submitBody },
    async (request, reply) => {
      const ctx = requireAuth(request);
      const b = body<{
        challengeId: string;
        statementHash?: string;
        statement?: unknown;
        proof: { proofType: string; scheme: string; protected: string; signature: string };
      }>(request);
      const r = await deps.attestations.submit({
        actorAccountId: ctx.accountId,
        idempotencyKey: key(request),
        challengeId: b.challengeId,
        proof: b.proof,
        ...defined({ statementHash: b.statementHash, statement: b.statement }),
      });
      reply.code(r.created ? 201 : 200);
      return {
        ...r,
        notice: 'Stored as a cryptographically signed claim. This is not a verified result.',
      };
    },
  );

  route(
    'GET',
    '/v1/attestations/:attestationId/detail',
    'AUTHENTICATED',
    { params: idParams('attestationId') },
    async (request) => {
      const ctx = requireAuth(request);
      return deps.attestations.detail(
        ctx.accountId,
        params<{ attestationId: string }>(request).attestationId,
      );
    },
  );

  route(
    'POST',
    '/v1/attestations/:attestationId/retractions/prepare',
    'ISSUER_REPRESENTATIVE',
    {
      headers: idempotencyHeaders,
      params: idParams('attestationId'),
      body: obj(
        {
          keyId: uuid,
          reasonCode: { enum: ['ISSUER_ERROR', 'SUPERSEDED_BY_CORRECTION', 'WITHDRAWN', 'OTHER'] },
        },
        ['keyId', 'reasonCode'],
      ),
    },
    async (request) => {
      const ctx = requireAuth(request);
      const b = body<{
        keyId: string;
        reasonCode: 'ISSUER_ERROR' | 'SUPERSEDED_BY_CORRECTION' | 'WITHDRAWN' | 'OTHER';
      }>(request);
      return deps.attestations.prepareRetraction({
        actorAccountId: ctx.accountId,
        idempotencyKey: key(request),
        attestationId: params<{ attestationId: string }>(request).attestationId,
        ...b,
      });
    },
  );

  route(
    'POST',
    '/v1/attestations/:attestationId/retractions',
    'ISSUER_REPRESENTATIVE',
    { headers: idempotencyHeaders, params: idParams('attestationId'), body: submitBody },
    async (request, reply) => {
      const ctx = requireAuth(request);
      const b = body<{
        challengeId: string;
        statementHash?: string;
        statement?: unknown;
        proof: { proofType: string; scheme: string; protected: string; signature: string };
      }>(request);
      const r = await deps.attestations.submitRetraction({
        actorAccountId: ctx.accountId,
        idempotencyKey: key(request),
        challengeId: b.challengeId,
        proof: b.proof,
        ...defined({ statementHash: b.statementHash, statement: b.statement }),
      });
      if (r.attestationId !== params<{ attestationId: string }>(request).attestationId)
        throw new DomainError(DomainErrorCode.CHALLENGE_INVALID, 'challenge not found');
      reply.code(r.created ? 201 : 200);
      return {
        ...r,
        notice: 'The issuer withdrew this claim. A retraction does not mean the claim was false.',
      };
    },
  );

  // ───────────────────────────── evidence bundle (BRT-07 input) ─────────────────────────────

  route(
    'GET',
    '/v1/result-versions/:resultVersionId/evidence-bundle',
    'COMP_STAFF',
    {
      params: idParams('resultVersionId'),
      querystring: obj({ asOf: instant }),
    },
    async (request) => {
      const ctx = requireAuth(request);
      const asOf = toDate((request.query as { asOf?: string }).asOf, 'asOf');
      const r = await deps.bundles.build({
        actor: ctx.operator === true ? { internal: true } : { accountId: ctx.accountId },
        resultVersionId: params<{ resultVersionId: string }>(request).resultVersionId,
        ...defined({ asOf }),
      });
      return {
        schema: 'br:evidence-bundle@1',
        asOf: r.asOf,
        bundleHash: r.bundleHash,
        bundle: r.bundle,
        notice:
          'Deterministic input set for later verification. It contains no verdict; bundleHash only identifies these exact inputs.',
      };
    },
  );
}
