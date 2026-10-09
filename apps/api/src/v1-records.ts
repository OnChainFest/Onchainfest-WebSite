import {
  DomainError,
  DomainErrorCode,
  RECORD_CATEGORY_SCOPE_TYPES,
  RECORD_SCOPE_TYPES,
} from '@br/domain';
import type {
  PassportReader,
  RecordCategoryStore,
  RecordPublicReader,
  RecordService,
} from '@br/persistence';
import type { FastifyRequest } from 'fastify';
import { idempotencyHeaders, idParams, obj, type V1Toolkit } from './v1';

export interface RecordsV1Deps {
  readonly records: RecordService;
  readonly publicReader: RecordPublicReader;
  /**
   * Category WRITER on the dedicated operator connection (br_record_operator_app → br_record_rules).
   * Absent when no operator connection is configured: INTERNAL category mutation then fails closed
   * (503); public record reads and canonical record evaluation never need it.
   */
  readonly categories?: RecordCategoryStore;
}

const categoryRef = {
  type: 'string',
  pattern:
    '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9][a-z0-9-]{1,63})$',
} as const;
const categoryCode = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,63}$' } as const;
const cursor = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,400}$' } as const;
// Query strings are never coerced (server-wide ajv setting): the page size is a bounded digit string.
const limit = { type: 'string', pattern: '^([1-9]|[1-4][0-9]|50)$' } as const;
const code64 = { type: 'string', pattern: '^[a-z0-9_.-]{1,128}$' } as const;
const region = { type: 'string', pattern: '^[A-Z]{2}(-[A-Z0-9]{1,3})?$' } as const;

/**
 * BRT-09 /v1 surface.
 *
 *   PUBLIC       a RecordMark (br:public-record-mark@1), a RecordCategory, its current record(s), its
 *                full chronology (cursor), the Record Hall of Fame (bounded filters + cursor), an
 *                athlete's Records section (Passport)
 *   COMP_STAFF   request a CANONICAL record evaluation of an exact ResultVersion (closed empty body:
 *                no holder, value, category, level, ratification, force or override can be supplied);
 *                read the record dependency index of a ResultVersion
 *   INTERNAL     create / version / publish / retire RecordCategories — operator flag AND the
 *                dedicated operator connection (503 without it; no fallback to the API login)
 *
 * There is NO route that creates, ratifies, rescinds or sets a record from caller-supplied content,
 * and no ranking, qualification, prize or trophy route.
 */
export function registerRecordsV1(
  t: V1Toolkit,
  deps: RecordsV1Deps & { readonly passports: PassportReader },
): void {
  const { route, requireAuth, operator, key } = t;
  const params = <T>(request: FastifyRequest) => request.params as T;
  const query = <T>(request: FastifyRequest) => request.query as T;
  const actorOf = (request: FastifyRequest) => ({ accountId: requireAuth(request).accountId });
  const notFound = (what: string) =>
    new DomainError(DomainErrorCode.NOT_FOUND, `${what} not found`);

  // ───────────────────────────── PUBLIC ─────────────────────────────

  route(
    'GET',
    '/v1/records/:recordMarkId',
    'PUBLIC',
    { params: idParams('recordMarkId') },
    async (request) => {
      const r = await deps.publicReader.record(
        params<{ recordMarkId: string }>(request).recordMarkId,
      );
      if (r === undefined) throw notFound('record');
      return r;
    },
  );

  route(
    'GET',
    '/v1/record-categories/:category',
    'PUBLIC',
    { params: obj({ category: categoryRef }, ['category']) },
    async (request) => {
      const r = await deps.publicReader.category(params<{ category: string }>(request).category);
      if (r === undefined) throw notFound('record category');
      return r;
    },
  );

  route(
    'GET',
    '/v1/record-categories/:category/current',
    'PUBLIC',
    { params: obj({ category: categoryRef }, ['category']) },
    async (request) => {
      const r = await deps.publicReader.current(params<{ category: string }>(request).category);
      if (r === undefined) throw notFound('record category');
      return r;
    },
  );

  route(
    'GET',
    '/v1/record-categories/:category/history',
    'PUBLIC',
    {
      params: obj({ category: categoryRef }, ['category']),
      querystring: obj({ cursor, limit }),
    },
    async (request) => {
      const q = query<{ cursor?: string; limit?: string }>(request);
      const r = await deps.publicReader.history(params<{ category: string }>(request).category, {
        ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
        ...(q.limit === undefined ? {} : { limit: Number(q.limit) }),
      });
      if (r === undefined) throw notFound('record category');
      return r;
    },
  );

  route(
    'GET',
    '/v1/hall-of-fame/records',
    'PUBLIC',
    {
      // Bounded filters only — no filter language, no sort / score / popularity parameter.
      querystring: obj({
        sport: code64,
        discipline: code64,
        scopeType: { enum: RECORD_SCOPE_TYPES.filter((s) => s !== 'PERSONAL') },
        region,
        category: categoryCode,
        holding: { enum: ['CURRENT', 'FORMER'] },
        cursor,
        limit,
      }),
    },
    async (request) => {
      const q = query<Record<string, string | undefined>>(request);
      return deps.publicReader.hallOfFame({
        ...(q.sport === undefined ? {} : { sport: q.sport }),
        ...(q.discipline === undefined ? {} : { discipline: q.discipline }),
        ...(q.scopeType === undefined ? {} : { scopeType: q.scopeType }),
        ...(q.region === undefined ? {} : { region: q.region }),
        ...(q.category === undefined ? {} : { category: q.category }),
        ...(q.holding === undefined ? {} : { holding: q.holding as 'CURRENT' | 'FORMER' }),
        ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
        ...(q.limit === undefined ? {} : { limit: Number(q.limit) }),
      });
    },
  );

  route(
    'GET',
    '/v1/athletes/:slug/records',
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
      if (r === undefined) throw notFound('athlete');
      return {
        schema: 'br:public-athlete-records@1',
        athlete: {
          slug: r.resolution.currentSlug,
          displayName: r.passport.athlete.displayName.value,
        },
        records: r.passport.records,
      };
    },
  );

  // ───────────────────────────── COMP_STAFF ─────────────────────────────

  route(
    'POST',
    '/v1/result-versions/:resultVersionId/record-evaluations',
    'COMP_STAFF',
    // Closed body: holderId / value / categoryId / verificationLevel / ratification / force /
    // override / isRecord are rejected by schema — categories and canonical facts decide.
    { params: idParams('resultVersionId'), body: obj({}) },
    async (request) =>
      deps.records.evaluate({
        actor: actorOf(request),
        resultVersionId: params<{ resultVersionId: string }>(request).resultVersionId,
      }),
  );

  route(
    'GET',
    '/v1/result-versions/:resultVersionId/record-dependents',
    'COMP_STAFF',
    { params: idParams('resultVersionId') },
    async (request) => ({
      schema: 'br:record-dependents@1',
      dependents: await deps.records.dependents({
        actor: actorOf(request),
        resultVersionId: params<{ resultVersionId: string }>(request).resultVersionId,
      }),
    }),
  );

  // ───────────────────────────── INTERNAL · categories ─────────────────────────────

  const categories = async (
    request: FastifyRequest,
    action: string,
  ): Promise<RecordCategoryStore> => {
    if (deps.categories === undefined) {
      await deps.records.auditDeniedCategoryMutation(request.authContext?.accountId, action);
      throw new DomainError(
        DomainErrorCode.INTERNAL_CAPABILITY_UNAVAILABLE,
        'record-category mutation is not available: no operator database connection is configured',
      );
    }
    return deps.categories;
  };
  const deniedAudit = (action: string) => ({
    onDenied: (request: FastifyRequest) =>
      deps.records.auditDeniedCategoryMutation(request.authContext?.accountId, action),
  });

  route(
    'POST',
    '/v1/internal/record-categories',
    'INTERNAL',
    {
      headers: idempotencyHeaders,
      body: obj(
        {
          code: categoryCode,
          name: { type: 'string', minLength: 1, maxLength: 120 },
          scopeType: { enum: RECORD_CATEGORY_SCOPE_TYPES },
        },
        ['code', 'name', 'scopeType'],
      ),
    },
    async (request, reply) => {
      const ctx = operator(request);
      const body = request.body as { code: string; name: string; scopeType: string };
      const r = await (
        await categories(request, 'record.category-create-denied')
      ).createCategory({
        operatorAccountId: ctx.accountId,
        ...body,
        idempotencyKey: key(request),
      });
      reply.code(r.created ? 201 : 200);
      return r;
    },
    deniedAudit('record.category-create-denied'),
  );

  route(
    'POST',
    '/v1/internal/record-categories/:categoryId/versions',
    'INTERNAL',
    // The spec is validated by the declarative category validator (closed BR-JSON schema, BRT-01
    // floors, scope ↔ recognition coherence, model-enforced naming, one universe per category).
    {
      headers: idempotencyHeaders,
      params: idParams('categoryId'),
      body: obj({ spec: { type: 'object' } }, ['spec']),
    },
    async (request, reply) => {
      const ctx = operator(request);
      const r = await (
        await categories(request, 'record.category-version-denied')
      ).createCategoryVersion({
        operatorAccountId: ctx.accountId,
        categoryId: params<{ categoryId: string }>(request).categoryId,
        spec: (request.body as { spec: unknown }).spec,
        idempotencyKey: key(request),
      });
      reply.code(r.created ? 201 : 200);
      return r;
    },
    { ...deniedAudit('record.category-version-denied'), bodyLimit: 32 * 1024 },
  );

  for (const [action, status] of [
    ['publish', 'PUBLISHED'],
    ['retire', 'RETIRED'],
  ] as const) {
    route(
      'POST',
      `/v1/internal/record-category-versions/:categoryVersionId/${action}`,
      'INTERNAL',
      { params: idParams('categoryVersionId'), body: obj({}) },
      async (request) => {
        const ctx = operator(request);
        return (await categories(request, `record.category-${action}-denied`)).changeVersionStatus({
          operatorAccountId: ctx.accountId,
          categoryVersionId: params<{ categoryVersionId: string }>(request).categoryVersionId,
          status,
        });
      },
      deniedAudit(`record.category-${action}-denied`),
    );
  }
}
