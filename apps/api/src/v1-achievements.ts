import { ACHIEVEMENT_TYPES, DomainError, DomainErrorCode } from '@br/domain';
import type {
  AchievementPublicReader,
  AchievementRuleStore,
  AchievementService,
  PassportReader,
} from '@br/persistence';
import type { FastifyRequest } from 'fastify';
import { idempotencyHeaders, idParams, obj, uuid, type V1Toolkit } from './v1';

export interface AchievementsV1Deps {
  readonly achievements: AchievementService;
  readonly publicReader: AchievementPublicReader;
  /**
   * Rule WRITER on the dedicated operator connection (br_achievement_operator_app →
   * br_achievement_rules). Absent when no operator connection is configured: INTERNAL rule mutation
   * then fails closed (503); public reads and canonical derivation never need it.
   */
  readonly rules?: AchievementRuleStore;
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
const ruleCode = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,63}$' } as const;

/**
 * BRT-08 /v1 surface.
 *
 *   PUBLIC       an Achievement (public-safe DTO br:public-achievement@1), an athlete's Verified
 *                Achievements (Passport section), published AchievementRules
 *   COMP_STAFF   request a CANONICAL derivation for an exact ResultVersion (closed empty body: no
 *                holder, type, qualifying value, level, force or override can be supplied); request a
 *                current-support re-assessment; read the dependency index of a ResultVersion
 *   INTERNAL     create / version / publish / retire / bind AchievementRules — operator flag AND the
 *                dedicated operator connection (503 without it; no fallback to the API login)
 *
 * There is NO route that creates an Achievement from caller-supplied content.
 */
export function registerAchievementsV1(
  t: V1Toolkit,
  deps: AchievementsV1Deps & { readonly passports: PassportReader },
): void {
  const { route, requireAuth, operator, key } = t;
  const params = <T>(request: FastifyRequest) => request.params as T;
  const actorOf = (request: FastifyRequest) => ({ accountId: requireAuth(request).accountId });

  // ───────────────────────────── PUBLIC ─────────────────────────────

  route(
    'GET',
    '/v1/achievements/:achievementId',
    'PUBLIC',
    { params: idParams('achievementId') },
    async (request) => {
      const a = await deps.publicReader.achievement(
        params<{ achievementId: string }>(request).achievementId,
      );
      if (a === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'achievement not found');
      return a;
    },
  );

  route(
    'GET',
    '/v1/athletes/:slug/achievements',
    'PUBLIC',
    {
      params: {
        type: 'object',
        required: ['slug'],
        properties: { slug: { type: 'string', minLength: 1, maxLength: 100 } },
        additionalProperties: false,
      },
    },
    async (request) => {
      const { slug } = params<{ slug: string }>(request);
      const r = await deps.passports.bySlug(slug, { authenticated: request.authContext !== null });
      if (r === undefined) throw new DomainError(DomainErrorCode.NOT_FOUND, 'athlete not found');
      return {
        schema: 'br:public-athlete-achievements@1',
        athlete: {
          slug: r.resolution.currentSlug,
          displayName: r.passport.athlete.displayName.value,
        },
        verifiedAchievements: r.passport.verifiedAchievements,
      };
    },
  );

  route(
    'GET',
    '/v1/achievement-rules/:code',
    'PUBLIC',
    { params: obj({ code: ruleCode }, ['code']) },
    async (request) => {
      const r = await deps.publicReader.rule(params<{ code: string }>(request).code);
      if (r === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'achievement rule not found');
      return r;
    },
  );

  // ───────────────────────────── COMP_STAFF ─────────────────────────────

  route(
    'POST',
    '/v1/result-versions/:resultVersionId/achievement-derivations',
    'COMP_STAFF',
    // Closed body: achievementType / holderId / qualifyingValue / desiredVerificationLevel / force /
    // override are rejected by schema — the rules and canonical facts decide the output.
    { params: idParams('resultVersionId'), body: obj({}) },
    async (request) =>
      deps.achievements.derive({
        actor: actorOf(request),
        resultVersionId: params<{ resultVersionId: string }>(request).resultVersionId,
      }),
  );

  route(
    'POST',
    '/v1/achievements/:achievementId/support-assessments',
    'COMP_STAFF',
    { params: idParams('achievementId'), body: obj({}) },
    async (request) =>
      deps.achievements.reassess({
        actor: actorOf(request),
        achievementId: params<{ achievementId: string }>(request).achievementId,
      }),
  );

  route(
    'GET',
    '/v1/result-versions/:resultVersionId/achievement-dependents',
    'COMP_STAFF',
    { params: idParams('resultVersionId') },
    async (request) => ({
      schema: 'br:achievement-dependents@1',
      dependents: await deps.achievements.dependents({
        actor: actorOf(request),
        resultVersionId: params<{ resultVersionId: string }>(request).resultVersionId,
      }),
    }),
  );

  // ───────────────────────────── INTERNAL · rules ─────────────────────────────

  const rules = async (request: FastifyRequest, action: string): Promise<AchievementRuleStore> => {
    if (deps.rules === undefined) {
      await deps.achievements.auditDeniedRuleMutation(request.authContext?.accountId, action);
      throw new DomainError(
        DomainErrorCode.INTERNAL_CAPABILITY_UNAVAILABLE,
        'achievement-rule mutation is not available: no operator database connection is configured',
      );
    }
    return deps.rules;
  };
  const deniedAudit = (action: string) => ({
    onDenied: (request: FastifyRequest) =>
      deps.achievements.auditDeniedRuleMutation(request.authContext?.accountId, action),
  });

  route(
    'POST',
    '/v1/internal/achievement-rules',
    'INTERNAL',
    {
      headers: idempotencyHeaders,
      body: obj(
        {
          code: ruleCode,
          name: { type: 'string', minLength: 1, maxLength: 120 },
          achievementType: { enum: ACHIEVEMENT_TYPES },
        },
        ['code', 'name', 'achievementType'],
      ),
    },
    async (request, reply) => {
      const ctx = operator(request);
      const body = request.body as { code: string; name: string; achievementType: string };
      const r = await (
        await rules(request, 'achievement.rule-create-denied')
      ).createRule({
        operatorAccountId: ctx.accountId,
        ...body,
        idempotencyKey: key(request),
      });
      reply.code(r.created ? 201 : 200);
      return r;
    },
    deniedAudit('achievement.rule-create-denied'),
  );

  route(
    'POST',
    '/v1/internal/achievement-rules/:ruleId/versions',
    'INTERNAL',
    // The spec is validated by the declarative rule validator (closed BR-JSON schema + BRT-01 floors).
    {
      headers: idempotencyHeaders,
      params: idParams('ruleId'),
      body: obj({ spec: { type: 'object' } }, ['spec']),
    },
    async (request, reply) => {
      const ctx = operator(request);
      const r = await (
        await rules(request, 'achievement.rule-version-denied')
      ).createRuleVersion({
        operatorAccountId: ctx.accountId,
        ruleId: params<{ ruleId: string }>(request).ruleId,
        spec: (request.body as { spec: unknown }).spec,
        idempotencyKey: key(request),
      });
      reply.code(r.created ? 201 : 200);
      return r;
    },
    { ...deniedAudit('achievement.rule-version-denied'), bodyLimit: 32 * 1024 },
  );

  for (const [action, status] of [
    ['publish', 'PUBLISHED'],
    ['retire', 'RETIRED'],
  ] as const) {
    route(
      'POST',
      `/v1/internal/achievement-rule-versions/:ruleVersionId/${action}`,
      'INTERNAL',
      { params: idParams('ruleVersionId'), body: obj({}) },
      async (request) => {
        const ctx = operator(request);
        return (await rules(request, `achievement.rule-${action}-denied`)).changeVersionStatus({
          operatorAccountId: ctx.accountId,
          ruleVersionId: params<{ ruleVersionId: string }>(request).ruleVersionId,
          status,
        });
      },
      deniedAudit(`achievement.rule-${action}-denied`),
    );
  }

  route(
    'POST',
    '/v1/internal/achievement-rule-versions/:ruleVersionId/bindings',
    'INTERNAL',
    {
      headers: idempotencyHeaders,
      params: idParams('ruleVersionId'),
      body: obj({ competitionId: uuid, eventId: uuid, effectiveFrom: instant }),
    },
    async (request, reply) => {
      const ctx = operator(request);
      const body = request.body as {
        competitionId?: string;
        eventId?: string;
        effectiveFrom?: string;
      };
      const r = await (
        await rules(request, 'achievement.rule-bind-denied')
      ).bindRule({
        operatorAccountId: ctx.accountId,
        ruleVersionId: params<{ ruleVersionId: string }>(request).ruleVersionId,
        ...(body.competitionId === undefined ? {} : { competitionId: body.competitionId }),
        ...(body.eventId === undefined ? {} : { eventId: body.eventId }),
        ...(body.effectiveFrom === undefined
          ? {}
          : { effectiveFrom: toDate(body.effectiveFrom, 'effectiveFrom') }),
        idempotencyKey: key(request),
      });
      reply.code(r.created ? 201 : 200);
      return r;
    },
    deniedAudit('achievement.rule-bind-denied'),
  );
}
