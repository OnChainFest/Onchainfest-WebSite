import { DomainError, DomainErrorCode } from '@br/domain';
import type {
  VerificationPolicyStore,
  VerificationPublicReader,
  VerificationService,
} from '@br/persistence';
import type { FastifyRequest } from 'fastify';
import { idempotencyHeaders, idParams, obj, uuid, type V1Toolkit } from './v1';

export interface VerificationV1Deps {
  readonly verification: VerificationService;
  readonly publicReader: VerificationPublicReader;
  /**
   * Policy WRITER on the dedicated operator connection (br_verification_operator_app →
   * br_verification_policy). Absent when no operator connection is configured: INTERNAL policy
   * mutation then fails closed (503); verification reads and evaluations never need it.
   */
  readonly policies?: VerificationPolicyStore;
}

const instant = { type: 'string', minLength: 20, maxLength: 40 } as const;
const toDate = (value: string, what: string): Date => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(value))
    throw new DomainError(DomainErrorCode.INVALID_INPUT, `${what} must be an RFC 3339 instant`);
  const d = new Date(value);
  if (Number.isNaN(d.getTime()))
    throw new DomainError(DomainErrorCode.INVALID_INPUT, `${what} is invalid`);
  return d;
};

/**
 * BRT-07 /v1 surface.
 *
 *   PUBLIC       current verification of an exact ResultVersion (hash-based freshness), a public
 *                run summary, published policies — public-safe only (no ids of people, grants,
 *                keys or private evidence; never the internal trace)
 *   COMP_STAFF   request an evaluation (current, persisted) or a historical "as known then"
 *                evaluation (never persisted); read run detail + trace and run history
 *   INTERNAL     create / version / publish / retire / bind policies — operator flag AND the
 *                dedicated operator connection (503 without it; no fallback to the API login)
 *
 * No endpoint accepts a level, an override, a confidence, a score or a conflict waiver: closed
 * request schemas reject them. Requesting an evaluation confers no sporting authority.
 */
export function registerVerificationV1(t: V1Toolkit, deps: VerificationV1Deps): void {
  const { route, requireAuth, operator, key } = t;
  const params = <T>(request: FastifyRequest) => request.params as T;
  const actorOf = (request: FastifyRequest) => ({ accountId: requireAuth(request).accountId });

  // ───────────────────────────── PUBLIC ─────────────────────────────

  route(
    'GET',
    '/v1/result-versions/:resultVersionId/verification',
    'PUBLIC',
    { params: idParams('resultVersionId') },
    async (request) =>
      deps.verification.publicCurrent(params<{ resultVersionId: string }>(request).resultVersionId),
  );

  route(
    'GET',
    '/v1/verification-runs/:runId/summary',
    'PUBLIC',
    { params: idParams('runId') },
    async (request) => {
      const s = await deps.publicReader.runSummary(params<{ runId: string }>(request).runId);
      if (s === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'verification run not found');
      return s;
    },
  );

  route(
    'GET',
    '/v1/verification-policies/:code',
    'PUBLIC',
    {
      params: {
        type: 'object',
        required: ['code'],
        properties: { code: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,63}$' } },
        additionalProperties: false,
      },
    },
    async (request) => deps.verification.publicPolicy(params<{ code: string }>(request).code),
  );

  // ───────────────────────────── COMP_STAFF ─────────────────────────────

  route(
    'POST',
    '/v1/result-versions/:resultVersionId/verification-runs',
    'COMP_STAFF',
    // Closed body: no desiredLevel / forceLevel / manualOverride / confidence / ignoreConflict.
    { params: idParams('resultVersionId'), body: obj({}) },
    async (request, reply) => {
      const r = await deps.verification.evaluate({
        actor: actorOf(request),
        resultVersionId: params<{ resultVersionId: string }>(request).resultVersionId,
      });
      if (r.kind === 'POLICY_UNAVAILABLE')
        return { evaluationState: r.evaluationState, reason: r.reason };
      reply.code(r.run.created ? 201 : 200);
      return r.run;
    },
  );

  route(
    'POST',
    '/v1/result-versions/:resultVersionId/verification-replays',
    'COMP_STAFF',
    { params: idParams('resultVersionId'), body: obj({ asOf: instant }, ['asOf']) },
    async (request) => {
      const { asOf } = request.body as { asOf: string };
      return deps.verification.evaluateAsOf({
        actor: actorOf(request),
        resultVersionId: params<{ resultVersionId: string }>(request).resultVersionId,
        asOf: toDate(asOf, 'asOf'),
      });
    },
  );

  route(
    'GET',
    '/v1/result-versions/:resultVersionId/verification-runs',
    'COMP_STAFF',
    { params: idParams('resultVersionId') },
    async (request) =>
      deps.verification.history(
        actorOf(request),
        params<{ resultVersionId: string }>(request).resultVersionId,
      ),
  );

  route(
    'GET',
    '/v1/verification-runs/:runId',
    'COMP_STAFF',
    { params: idParams('runId') },
    async (request) =>
      deps.verification.runDetail(actorOf(request), params<{ runId: string }>(request).runId),
  );

  // ───────────────────────────── INTERNAL · policies ─────────────────────────────

  // Never falls back to the normal API connection (which cannot assume br_verification_policy).
  const policies = async (
    request: FastifyRequest,
    action: string,
  ): Promise<VerificationPolicyStore> => {
    if (deps.policies === undefined) {
      await deps.verification.auditDeniedPolicyMutation(request.authContext?.accountId, action);
      throw new DomainError(
        DomainErrorCode.INTERNAL_CAPABILITY_UNAVAILABLE,
        'verification-policy mutation is not available: no operator database connection is configured',
      );
    }
    return deps.policies;
  };
  const deniedAudit = (action: string) => ({
    onDenied: (request: FastifyRequest) =>
      deps.verification.auditDeniedPolicyMutation(request.authContext?.accountId, action),
  });

  route(
    'POST',
    '/v1/internal/verification-policies',
    'INTERNAL',
    {
      headers: idempotencyHeaders,
      body: obj(
        {
          code: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,63}$' },
          name: { type: 'string', minLength: 1, maxLength: 120 },
        },
        ['code', 'name'],
      ),
    },
    async (request, reply) => {
      const ctx = operator(request);
      const body = request.body as { code: string; name: string };
      const r = await (
        await policies(request, 'verification.policy-create-denied')
      ).createPolicy({
        operatorAccountId: ctx.accountId,
        ...body,
        idempotencyKey: key(request),
      });
      reply.code(r.created ? 201 : 200);
      return r;
    },
    deniedAudit('verification.policy-create-denied'),
  );

  route(
    'POST',
    '/v1/internal/verification-policies/:policyId/versions',
    'INTERNAL',
    // The spec is validated by the declarative policy validator (closed BR-JSON schema + BRT-01 floor).
    {
      headers: idempotencyHeaders,
      params: idParams('policyId'),
      body: obj({ spec: { type: 'object' } }, ['spec']),
    },
    async (request, reply) => {
      const ctx = operator(request);
      const r = await (
        await policies(request, 'verification.policy-version-denied')
      ).createPolicyVersion({
        operatorAccountId: ctx.accountId,
        policyId: params<{ policyId: string }>(request).policyId,
        spec: (request.body as { spec: unknown }).spec,
        idempotencyKey: key(request),
      });
      reply.code(r.created ? 201 : 200);
      return r;
    },
    { ...deniedAudit('verification.policy-version-denied'), bodyLimit: 64 * 1024 },
  );

  for (const [action, status] of [
    ['publish', 'PUBLISHED'],
    ['retire', 'RETIRED'],
  ] as const) {
    route(
      'POST',
      `/v1/internal/verification-policy-versions/:policyVersionId/${action}`,
      'INTERNAL',
      { params: idParams('policyVersionId'), body: obj({}) },
      async (request) => {
        const ctx = operator(request);
        return (
          await policies(request, `verification.policy-${action}-denied`)
        ).changeVersionStatus({
          operatorAccountId: ctx.accountId,
          policyVersionId: params<{ policyVersionId: string }>(request).policyVersionId,
          status,
        });
      },
      deniedAudit(`verification.policy-${action}-denied`),
    );
  }

  route(
    'POST',
    '/v1/internal/discipline-versions/:disciplineVersionId/verification-policy-bindings',
    'INTERNAL',
    {
      headers: idempotencyHeaders,
      params: idParams('disciplineVersionId'),
      body: obj({ policyVersionId: uuid, effectiveFrom: instant }, ['policyVersionId']),
    },
    async (request, reply) => {
      const ctx = operator(request);
      const body = request.body as { policyVersionId: string; effectiveFrom?: string };
      const r = await (
        await policies(request, 'verification.policy-bind-denied')
      ).bindPolicy({
        operatorAccountId: ctx.accountId,
        disciplineVersionId: params<{ disciplineVersionId: string }>(request).disciplineVersionId,
        policyVersionId: body.policyVersionId,
        ...(body.effectiveFrom === undefined
          ? {}
          : { effectiveFrom: toDate(body.effectiveFrom, 'effectiveFrom') }),
        idempotencyKey: key(request),
      });
      reply.code(r.created ? 201 : 200);
      return r;
    },
    deniedAudit('verification.policy-bind-denied'),
  );
}
