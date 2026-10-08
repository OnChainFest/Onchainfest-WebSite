import { DomainError, DomainErrorCode } from '@br/domain';
import type {
  CatalogStore,
  CompetitionReader,
  CompetitionStore,
  IdentityStore,
  RegistrationEntry,
  ScoringStore,
  StructureStore,
  TeamStore,
} from '@br/persistence';
import type { FastifyRequest } from 'fastify';
import {
  defined,
  idempotencyHeaders,
  idParams,
  lookupSlugSchema,
  nullableString,
  obj,
  slugSchema,
  uuid,
  type V1Toolkit,
} from './v1';

export interface CompetitionV1Deps {
  /**
   * Catalog WRITER on the dedicated operator connection (br_operator_app → br_catalog). Absent
   * when no operator connection is configured: INTERNAL catalog mutation then fails closed (503);
   * catalog reads (`reader.catalog()`, event pinning) never need it.
   */
  readonly catalog?: CatalogStore;
  readonly competitions: CompetitionStore;
  readonly structure: StructureStore;
  readonly teams: TeamStore;
  readonly reader: CompetitionReader;
  /** ONCF-05C scoring (pin, score-sheet validation, stage classification). Routes exist only when wired. */
  readonly scoring?: ScoringStore;
}

const notFound = (what: string) => new DomainError(DomainErrorCode.NOT_FOUND, `${what} not found`);

/**
 * BRT-05 /v1 surface. PUBLIC reads return public DTOs only. Every mutation is an explicit lifecycle
 * command (no status PATCH); SELF/COMP_STAFF/ORG_ADMIN decisions are made inside the store from
 * database facts. Catalog mutation is INTERNAL (operator flag). Commands that create or change
 * state take an Idempotency-Key.
 */
export function registerCompetitionV1(
  t: V1Toolkit,
  deps: CompetitionV1Deps & {
    /** ONCF-04: names registrations by the ONCF-02 roster rule (PUBLIC/AUTHENTICATED profiles). */
    readonly identity: Pick<IdentityStore, 'visibleAthletes'>;
  },
): void {
  const { route, requireAuth, operator, key } = t;
  const slug = slugSchema;
  const lookup = lookupSlugSchema;
  const compSlugParams = obj({ slug: lookup }, ['slug']);
  const eventSlugParams = obj({ slug: lookup, eventSlug: lookup }, ['slug', 'eventSlug']);
  const instant = { type: 'string', minLength: 16, maxLength: 40 } as const;
  const nullableInstant = { type: ['string', 'null'], minLength: 16, maxLength: 40 } as const;
  const label = { type: 'string', minLength: 1, maxLength: 40 } as const;
  const category = obj({
    genderCategory: { enum: ['OPEN', 'MEN', 'WOMEN', 'MIXED'] },
    ageCategory: obj(
      {
        label,
        minAge: { type: 'integer', minimum: 0, maximum: 120 },
        maxAge: { type: 'integer', minimum: 0, maximum: 120 },
      },
      ['label'],
    ),
    skillClass: label,
    weightClass: label,
    division: label,
    classification: label,
    customLabels: { type: 'array', maxItems: 8, items: label },
  });
  const profile = obj(
    {
      name: { type: 'string', minLength: 1, maxLength: 120 },
      description: nullableString(2000),
      locationLabel: nullableString(120),
      regionCode: { type: ['string', 'null'], pattern: '^[A-Z]{2}(-[A-Z0-9]{1,3})?$' },
      timezone: { type: 'string', minLength: 1, maxLength: 64 },
      startsAt: nullableInstant,
      endsAt: nullableInstant,
      website: nullableString(255),
    },
    ['name', 'timezone'],
  );
  const settings = obj(
    {
      name: { type: 'string', minLength: 1, maxLength: 120 },
      category,
      capacity: { type: ['integer', 'null'], minimum: 1, maximum: 4096 },
      registrationMode: { enum: ['AUTO_CONFIRM', 'ORGANIZER_APPROVAL'] },
      registrationOpensAt: nullableInstant,
      registrationClosesAt: nullableInstant,
      startsAt: nullableInstant,
      endsAt: nullableInstant,
      timezone: { type: 'string', minLength: 1, maxLength: 64 },
    },
    ['name'],
  );
  const code = (pattern: string, max: number) =>
    ({ type: 'string', pattern, maxLength: max }) as const;
  const nameProp = { type: 'string', minLength: 1, maxLength: 80 } as const;

  const params = <T>(request: FastifyRequest) => request.params as T;
  // Never falls back to the normal API connection (which cannot assume br_catalog anyway).
  const catalog = (): CatalogStore => {
    if (deps.catalog === undefined) {
      throw new DomainError(
        DomainErrorCode.INTERNAL_CAPABILITY_UNAVAILABLE,
        'catalog mutation is not available: no operator database connection is configured',
      );
    }
    return deps.catalog;
  };
  const body = <T>(request: FastifyRequest) => request.body as T;

  // ───────────────────────────── PUBLIC ─────────────────────────────

  route('GET', '/v1/catalog', 'PUBLIC', {}, async () => deps.reader.catalog());

  // ONCF-02: an organization's public (non-DRAFT) competitions, for its page and dashboard.
  route(
    'GET',
    '/v1/organizations/:slug/competitions',
    'PUBLIC',
    { params: compSlugParams },
    async (request) => {
      const items = await deps.reader.competitionsByOrganizerSlug(
        params<{ slug: string }>(request).slug,
      );
      if (items === undefined) throw notFound('organization');
      return { items };
    },
  );

  route('GET', '/v1/competitions/:slug', 'PUBLIC', { params: compSlugParams }, async (request) => {
    const r = await deps.reader.competitionBySlug(params<{ slug: string }>(request).slug);
    if (r === undefined) throw notFound('competition');
    return { ...r.competition, canonicalSlug: r.canonicalSlug, redirected: r.redirected };
  });

  route(
    'GET',
    '/v1/competitions/:slug/events/:eventSlug',
    'PUBLIC',
    { params: eventSlugParams },
    async (request) => {
      const p = params<{ slug: string; eventSlug: string }>(request);
      const r = await deps.reader.eventBySlugs(p.slug, p.eventSlug);
      if (r === undefined) throw notFound('event');
      return { ...r.event, canonical: r.canonical, redirected: r.redirected };
    },
  );

  route(
    'GET',
    '/v1/competitions/:slug/events/:eventSlug/participants',
    'PUBLIC',
    { params: eventSlugParams },
    async (request) => {
      const p = params<{ slug: string; eventSlug: string }>(request);
      const items = await deps.reader.entries(p.slug, p.eventSlug);
      if (items === undefined) throw notFound('event');
      return { items };
    },
  );

  route(
    'GET',
    '/v1/competitions/:slug/events/:eventSlug/schedule',
    'PUBLIC',
    { params: eventSlugParams },
    async (request) => {
      const p = params<{ slug: string; eventSlug: string }>(request);
      const items = await deps.reader.schedule(p.slug, p.eventSlug);
      if (items === undefined) throw notFound('event');
      return { items };
    },
  );

  route(
    'GET',
    '/v1/competitions/:slug/events/:eventSlug/bracket',
    'PUBLIC',
    { params: eventSlugParams },
    async (request) => {
      const p = params<{ slug: string; eventSlug: string }>(request);
      const rounds = await deps.reader.structure(p.slug, p.eventSlug);
      if (rounds === undefined) throw notFound('event');
      // A schedule/structure is not a ranking; no standings or results are computed here.
      return { rounds, results: { status: 'NOT_AVAILABLE', reason: 'SOURCE_NOT_IMPLEMENTED' } };
    },
  );

  // ───────────────────────────── INTERNAL · sport catalog ─────────────────────────────

  route(
    'POST',
    '/v1/internal/catalog/sports',
    'INTERNAL',
    {
      headers: idempotencyHeaders,
      body: obj({ code: code('^[a-z0-9]+(?:[-_][a-z0-9]+)*$', 64), name: nameProp }, [
        'code',
        'name',
      ]),
    },
    async (request, reply) => {
      const ctx = operator(request);
      const r = await catalog().createSport({
        operatorAccountId: ctx.accountId,
        ...body<{ code: string; name: string }>(request),
        idempotencyKey: key(request),
      });
      reply.code(r.created ? 201 : 200);
      return r;
    },
  );

  route(
    'POST',
    '/v1/internal/catalog/sports/:sportId/disciplines',
    'INTERNAL',
    {
      params: idParams('sportId'),
      headers: idempotencyHeaders,
      body: obj({ code: code('^[a-z0-9._-]+$', 128), name: nameProp }, ['code', 'name']),
    },
    async (request, reply) => {
      const ctx = operator(request);
      const r = await catalog().createDiscipline({
        operatorAccountId: ctx.accountId,
        sportId: params<{ sportId: string }>(request).sportId,
        ...body<{ code: string; name: string }>(request),
        idempotencyKey: key(request),
      });
      reply.code(r.created ? 201 : 200);
      return r;
    },
  );

  route(
    'POST',
    '/v1/internal/catalog/disciplines/:disciplineId/versions',
    'INTERNAL',
    // The spec is validated by the catalog (bounded declarative model; BR-JSON result schema).
    {
      params: idParams('disciplineId'),
      headers: idempotencyHeaders,
      body: obj({ spec: { type: 'object' } }, ['spec']),
    },
    async (request, reply) => {
      const ctx = operator(request);
      const r = await catalog().createDisciplineVersion({
        operatorAccountId: ctx.accountId,
        disciplineId: params<{ disciplineId: string }>(request).disciplineId,
        spec: body<{ spec: never }>(request).spec,
        idempotencyKey: key(request),
      });
      reply.code(r.created ? 201 : 200);
      return r;
    },
  );

  for (const action of ['publish', 'retire'] as const) {
    route(
      'POST',
      `/v1/internal/catalog/discipline-versions/:disciplineVersionId/${action}`,
      'INTERNAL',
      { params: idParams('disciplineVersionId') },
      async (request) => {
        const ctx = operator(request);
        const { disciplineVersionId } = params<{ disciplineVersionId: string }>(request);
        await (action === 'publish'
          ? catalog().publishDisciplineVersion({
              operatorAccountId: ctx.accountId,
              disciplineVersionId,
            })
          : catalog().retireDisciplineVersion({
              operatorAccountId: ctx.accountId,
              disciplineVersionId,
            }));
        return { disciplineVersionId, status: action === 'publish' ? 'PUBLISHED' : 'RETIRED' };
      },
    );
    route(
      'POST',
      `/v1/internal/catalog/format-versions/:formatVersionId/${action}`,
      'INTERNAL',
      { params: idParams('formatVersionId') },
      async (request) => {
        const ctx = operator(request);
        const { formatVersionId } = params<{ formatVersionId: string }>(request);
        await (action === 'publish'
          ? catalog().publishFormatVersion({ operatorAccountId: ctx.accountId, formatVersionId })
          : catalog().retireFormatVersion({
              operatorAccountId: ctx.accountId,
              formatVersionId,
            }));
        return { formatVersionId, status: action === 'publish' ? 'PUBLISHED' : 'RETIRED' };
      },
    );
  }

  route(
    'POST',
    '/v1/internal/catalog/format-templates',
    'INTERNAL',
    {
      headers: idempotencyHeaders,
      body: obj({ code: code('^[a-z0-9]+(?:-[a-z0-9]+)*$', 64), name: nameProp }, ['code', 'name']),
    },
    async (request, reply) => {
      const ctx = operator(request);
      const r = await catalog().createFormatTemplate({
        operatorAccountId: ctx.accountId,
        ...body<{ code: string; name: string }>(request),
        idempotencyKey: key(request),
      });
      reply.code(r.created ? 201 : 200);
      return r;
    },
  );

  route(
    'POST',
    '/v1/internal/catalog/format-templates/:formatTemplateId/versions',
    'INTERNAL',
    {
      params: idParams('formatTemplateId'),
      headers: idempotencyHeaders,
      body: obj(
        {
          engineId: code('^[a-z0-9-]+$', 64),
          engineVersion: { type: 'integer', minimum: 1, maximum: 1000 },
        },
        ['engineId', 'engineVersion'],
      ),
    },
    async (request, reply) => {
      const ctx = operator(request);
      const r = await catalog().createFormatVersion({
        operatorAccountId: ctx.accountId,
        formatTemplateId: params<{ formatTemplateId: string }>(request).formatTemplateId,
        ...body<{ engineId: string; engineVersion: number }>(request),
        idempotencyKey: key(request),
      });
      reply.code(r.created ? 201 : 200);
      return r;
    },
  );

  // ───────────────────────────── competitions (ORG_ADMIN / COMP_STAFF) ─────────────────────────────

  route(
    'POST',
    '/v1/competitions',
    'ORG_ADMIN',
    {
      headers: idempotencyHeaders,
      body: obj({ organizerOrganizationId: uuid, slug, profile }, [
        'organizerOrganizationId',
        'slug',
        'profile',
      ]),
    },
    async (request, reply) => {
      const ctx = requireAuth(request);
      const b = body<{ organizerOrganizationId: string; slug: string; profile: never }>(request);
      const r = await deps.competitions.createCompetition({
        actorAccountId: ctx.accountId,
        ...b,
        profile: defined(b.profile),
        idempotencyKey: key(request),
      });
      reply.code(r.created ? 201 : 200);
      return r;
    },
  );

  route(
    'GET',
    '/v1/competitions/:competitionId/permissions',
    'AUTHENTICATED',
    { params: idParams('competitionId') },
    async (request) => {
      const ctx = requireAuth(request);
      return deps.competitions.permissions(
        ctx.accountId,
        params<{ competitionId: string }>(request).competitionId,
      );
    },
  );

  // ONCF-03A organizer reads (DRAFT included). The store decides: ORG_MANAGE_COMPETITIONS in the
  // organization for the list, COMP_VIEW_PRIVATE on the competition for the detail.
  route(
    'GET',
    '/v1/organizations/:organizationId/competitions/manage',
    'ORG_ADMIN',
    { params: idParams('organizationId') },
    async (request) => {
      const ctx = requireAuth(request);
      return {
        items: await deps.competitions.organizationCompetitions({
          actorAccountId: ctx.accountId,
          organizationId: params<{ organizationId: string }>(request).organizationId,
        }),
      };
    },
  );

  route(
    'GET',
    '/v1/competitions/:competitionId/manage',
    'COMP_STAFF',
    { params: idParams('competitionId') },
    async (request) => {
      const ctx = requireAuth(request);
      return deps.competitions.managedCompetition({
        actorAccountId: ctx.accountId,
        competitionId: params<{ competitionId: string }>(request).competitionId,
      });
    },
  );

  route(
    'PUT',
    '/v1/competitions/:competitionId/profile',
    'COMP_STAFF',
    { params: idParams('competitionId'), body: profile },
    async (request) => {
      const ctx = requireAuth(request);
      const { competitionId } = params<{ competitionId: string }>(request);
      await deps.competitions.updateCompetitionProfile({
        actorAccountId: ctx.accountId,
        competitionId,
        profile: defined(body<Record<string, never>>(request)) as never,
      });
      return { competitionId };
    },
  );

  route(
    'PUT',
    '/v1/competitions/:competitionId/slug',
    'COMP_STAFF',
    { params: idParams('competitionId'), body: obj({ slug }, ['slug']) },
    async (request) => {
      const ctx = requireAuth(request);
      return deps.competitions.changeCompetitionSlug({
        actorAccountId: ctx.accountId,
        competitionId: params<{ competitionId: string }>(request).competitionId,
        slug: body<{ slug: string }>(request).slug,
      });
    },
  );

  for (const action of ['publish', 'activate', 'complete'] as const) {
    route(
      'POST',
      `/v1/competitions/:competitionId/${action}`,
      'COMP_STAFF',
      { params: idParams('competitionId') },
      async (request) => {
        const ctx = requireAuth(request);
        const { competitionId } = params<{ competitionId: string }>(request);
        const input = { actorAccountId: ctx.accountId, competitionId };
        await (action === 'publish'
          ? deps.competitions.publishCompetition(input)
          : action === 'activate'
            ? deps.competitions.activateCompetition(input)
            : deps.competitions.completeCompetition(input));
        return {
          competitionId,
          status:
            action === 'publish' ? 'PUBLISHED' : action === 'activate' ? 'ACTIVE' : 'COMPLETED',
        };
      },
    );
  }

  route(
    'POST',
    '/v1/competitions/:competitionId/cancel',
    'COMP_STAFF',
    {
      params: idParams('competitionId'),
      body: obj({ reason: { type: 'string', minLength: 1, maxLength: 500 } }, ['reason']),
    },
    async (request) => {
      const ctx = requireAuth(request);
      const { competitionId } = params<{ competitionId: string }>(request);
      await deps.competitions.cancelCompetition({
        actorAccountId: ctx.accountId,
        competitionId,
        reason: body<{ reason: string }>(request).reason,
      });
      return { competitionId, status: 'CANCELLED' };
    },
  );

  route(
    'POST',
    '/v1/competitions/:competitionId/staff',
    'COMP_STAFF',
    {
      params: idParams('competitionId'),
      headers: idempotencyHeaders,
      body: obj(
        { personId: uuid, role: { enum: ['OWNER', 'ADMIN', 'REGISTRATION_MANAGER', 'SCHEDULER'] } },
        ['personId', 'role'],
      ),
    },
    async (request, reply) => {
      const ctx = requireAuth(request);
      const r = await deps.competitions.assignStaff({
        actorAccountId: ctx.accountId,
        competitionId: params<{ competitionId: string }>(request).competitionId,
        ...body<{ personId: string; role: 'ADMIN' }>(request),
        idempotencyKey: key(request),
      });
      reply.code(r.created ? 201 : 200);
      return r;
    },
  );

  route(
    'DELETE',
    '/v1/competition-staff/:staffId',
    'COMP_STAFF',
    { params: idParams('staffId') },
    async (request, reply) => {
      const ctx = requireAuth(request);
      await deps.competitions.endStaff({
        actorAccountId: ctx.accountId,
        staffId: params<{ staffId: string }>(request).staffId,
      });
      reply.code(204);
      return null;
    },
  );

  // ───────────────────────────── events (COMP_STAFF) ─────────────────────────────

  route(
    'POST',
    '/v1/competitions/:competitionId/events',
    'COMP_STAFF',
    {
      params: idParams('competitionId'),
      headers: idempotencyHeaders,
      body: obj(
        {
          slug,
          disciplineVersionId: uuid,
          formatVersionId: uuid,
          entrantKind: { enum: ['INDIVIDUAL', 'TEAM'] },
          formatConfig: { type: 'object' },
          settings,
        },
        ['slug', 'disciplineVersionId', 'formatVersionId', 'settings'],
      ),
    },
    async (request, reply) => {
      const ctx = requireAuth(request);
      const b = body<{
        slug: string;
        disciplineVersionId: string;
        formatVersionId: string;
        entrantKind?: 'INDIVIDUAL' | 'TEAM';
        formatConfig?: Record<string, unknown>;
        settings: never;
      }>(request);
      const r = await deps.competitions.createEvent(
        defined({
          actorAccountId: ctx.accountId,
          competitionId: params<{ competitionId: string }>(request).competitionId,
          ...b,
          settings: defined(b.settings) as never,
          idempotencyKey: key(request),
        }),
      );
      reply.code(r.created ? 201 : 200);
      return r;
    },
  );

  route(
    'PUT',
    '/v1/events/:eventId/settings',
    'COMP_STAFF',
    { params: idParams('eventId'), body: settings },
    async (request) => {
      const ctx = requireAuth(request);
      const { eventId } = params<{ eventId: string }>(request);
      await deps.competitions.updateEventSettings({
        actorAccountId: ctx.accountId,
        eventId,
        settings: defined(body<Record<string, never>>(request)) as never,
      });
      return { eventId };
    },
  );

  const eventCommands = {
    'open-registration': (a: { actorAccountId: string; eventId: string }) =>
      deps.competitions.openRegistration(a),
    'close-registration': (a: { actorAccountId: string; eventId: string }) =>
      deps.competitions.closeRegistration(a),
    start: (a: { actorAccountId: string; eventId: string }) => deps.competitions.startEvent(a),
    complete: (a: { actorAccountId: string; eventId: string }) =>
      deps.competitions.completeEvent(a),
  } as const;
  for (const [action, fn] of Object.entries(eventCommands)) {
    route(
      'POST',
      `/v1/events/:eventId/${action}`,
      'COMP_STAFF',
      { params: idParams('eventId') },
      async (request) => {
        const ctx = requireAuth(request);
        const { eventId } = params<{ eventId: string }>(request);
        await fn({ actorAccountId: ctx.accountId, eventId });
        return { eventId, command: action };
      },
    );
  }

  route(
    'POST',
    '/v1/events/:eventId/cancel',
    'COMP_STAFF',
    {
      params: idParams('eventId'),
      body: obj({ reason: { type: 'string', minLength: 1, maxLength: 500 } }, ['reason']),
    },
    async (request) => {
      const ctx = requireAuth(request);
      const { eventId } = params<{ eventId: string }>(request);
      await deps.competitions.cancelEvent({
        actorAccountId: ctx.accountId,
        eventId,
        reason: body<{ reason: string }>(request).reason,
      });
      return { eventId, status: 'CANCELLED' };
    },
  );

  route(
    'POST',
    '/v1/events/:eventId/lock-field',
    'COMP_STAFF',
    { params: idParams('eventId'), headers: idempotencyHeaders },
    async (request) => {
      const ctx = requireAuth(request);
      return deps.structure.lockField({
        actorAccountId: ctx.accountId,
        eventId: params<{ eventId: string }>(request).eventId,
        idempotencyKey: key(request),
      });
    },
  );

  route(
    'POST',
    '/v1/events/:eventId/seed',
    'COMP_STAFF',
    {
      params: idParams('eventId'),
      headers: idempotencyHeaders,
      body: obj(
        {
          // ONCF-05B (ADR-0058): + ranked-then-drawn, by entry attribute, sources and overrides.
          method: {
            enum: ['MANUAL', 'DETERMINISTIC_DRAW', 'RANKED_THEN_DRAWN', 'BY_ENTRY_ATTRIBUTE'],
          },
          order: { type: 'array', maxItems: 20000, uniqueItems: true, items: uuid },
          seeds: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: uuid },
          banded: { type: 'boolean' },
          attributeKey: { type: 'string', pattern: '^[a-z][A-Za-z0-9]{0,31}$' },
          direction: { enum: ['ASC', 'DESC'] },
          source: obj(
            {
              kind: { enum: ['ORGANIZER', 'DECLARED_EXTERNAL', 'ENTRY_ATTRIBUTE'] },
              label: { type: 'string', minLength: 1, maxLength: 120 },
              asOf: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' },
            },
            ['kind'],
          ),
          overrides: {
            type: 'array',
            maxItems: 256,
            items: obj(
              {
                participantId: uuid,
                toPosition: { type: 'integer', minimum: 1, maximum: 20000 },
                reason: { type: 'string', minLength: 1, maxLength: 300 },
              },
              ['participantId', 'toPosition', 'reason'],
            ),
          },
        },
        ['method'],
      ),
    },
    async (request) => {
      const ctx = requireAuth(request);
      const b = body<{
        method: 'MANUAL' | 'DETERMINISTIC_DRAW' | 'RANKED_THEN_DRAWN' | 'BY_ENTRY_ATTRIBUTE';
        order?: string[];
        seeds?: string[];
        banded?: boolean;
        attributeKey?: string;
        direction?: 'ASC' | 'DESC';
        source?: {
          kind: 'ORGANIZER' | 'DECLARED_EXTERNAL' | 'ENTRY_ATTRIBUTE';
          label?: string;
          asOf?: string;
        };
        overrides?: { participantId: string; toPosition: number; reason: string }[];
      }>(request);
      return deps.structure.seedField(
        defined({
          actorAccountId: ctx.accountId,
          eventId: params<{ eventId: string }>(request).eventId,
          ...b,
          idempotencyKey: key(request),
        }),
      );
    },
  );

  // ONCF-05B organizer structure reads (never public; declared values stay private).
  route(
    'GET',
    '/v1/events/:eventId/readiness',
    'COMP_STAFF',
    { params: idParams('eventId') },
    async (request) => {
      const ctx = requireAuth(request);
      return deps.structure.readiness({
        actorAccountId: ctx.accountId,
        eventId: params<{ eventId: string }>(request).eventId,
      });
    },
  );

  route(
    'GET',
    '/v1/events/:eventId/plan-preview',
    'COMP_STAFF',
    { params: idParams('eventId') },
    async (request) => {
      const ctx = requireAuth(request);
      return deps.structure.previewPlan({
        actorAccountId: ctx.accountId,
        eventId: params<{ eventId: string }>(request).eventId,
      });
    },
  );

  route(
    'GET',
    '/v1/events/:eventId/field',
    'COMP_STAFF',
    { params: idParams('eventId') },
    async (request) => {
      const ctx = requireAuth(request);
      const items = await deps.structure.lockedField({
        actorAccountId: ctx.accountId,
        eventId: params<{ eventId: string }>(request).eventId,
      });
      const athletes = await deps.identity.visibleAthletes([
        ...new Set(items.flatMap((p) => (p.athleteId === null ? [] : [p.athleteId]))),
      ]);
      return {
        items: items.map((p) => ({
          ...p,
          athlete: p.athleteId === null ? null : (athletes.get(p.athleteId) ?? null),
        })),
      };
    },
  );

  route(
    'POST',
    '/v1/events/:eventId/generate-plan',
    'COMP_STAFF',
    { params: idParams('eventId'), headers: idempotencyHeaders },
    async (request) => {
      const ctx = requireAuth(request);
      return deps.structure.generatePlan({
        actorAccountId: ctx.accountId,
        eventId: params<{ eventId: string }>(request).eventId,
        idempotencyKey: key(request),
      });
    },
  );

  // ───────────────────────────── scoring (ONCF-05C; COMP_STAFF) ─────────────────────────────
  // Organizer surface only: rulesets and templates are pinned before the field locks; score sheets
  // are validated (never written — submission is the ResultLedger's, in 05D); classifications are
  // computed on read from current results and are proposals (ADR-0047), never published here.
  const scoring = deps.scoring;
  if (scoring !== undefined) {
    route(
      'PUT',
      '/v1/events/:eventId/scoring',
      'COMP_STAFF',
      {
        params: idParams('eventId'),
        headers: idempotencyHeaders,
        body: obj(
          {
            rulesetVersionId: uuid,
            classificationTemplateVersionId: { type: ['string', 'null'], format: 'uuid' },
            stageOverrides: {
              type: 'object',
              maxProperties: 16,
              propertyNames: { pattern: '^s[0-9]{1,2}$' },
              additionalProperties: obj({
                rulesetVersionId: uuid,
                classificationTemplateVersionId: uuid,
              }),
            },
          },
          ['rulesetVersionId'],
        ),
      },
      async (request) => {
        const ctx = requireAuth(request);
        const b = body<{
          rulesetVersionId: string;
          classificationTemplateVersionId?: string | null;
          stageOverrides?: Record<
            string,
            { rulesetVersionId?: string; classificationTemplateVersionId?: string }
          >;
        }>(request);
        return scoring.pinScoring(
          defined({
            actorAccountId: ctx.accountId,
            eventId: params<{ eventId: string }>(request).eventId,
            ...b,
            idempotencyKey: key(request),
          }),
        );
      },
    );

    route(
      'GET',
      '/v1/events/:eventId/scoring',
      'COMP_STAFF',
      { params: idParams('eventId') },
      async (request) => {
        const ctx = requireAuth(request);
        return scoring.scoring({
          actorAccountId: ctx.accountId,
          eventId: params<{ eventId: string }>(request).eventId,
        });
      },
    );

    route(
      'POST',
      '/v1/contests/:contestId/score-sheets/validate',
      'COMP_STAFF',
      {
        params: idParams('contestId'),
        body: {
          type: 'object',
          required: ['sheet'],
          additionalProperties: false,
          properties: { sheet: { type: 'object' } },
        },
      },
      async (request) => {
        const ctx = requireAuth(request);
        return scoring.validateScoreSheet({
          actorAccountId: ctx.accountId,
          contestId: params<{ contestId: string }>(request).contestId,
          sheet: body<{ sheet: never }>(request).sheet,
        });
      },
    );

    route(
      'GET',
      '/v1/events/:eventId/stages/:stageKey/classification',
      'COMP_STAFF',
      {
        params: obj({ eventId: uuid, stageKey: { type: 'string', pattern: '^s[0-9]{1,2}$' } }, [
          'eventId',
          'stageKey',
        ]),
        querystring: obj({
          group: { type: 'string', pattern: '^g[0-9]{1,2}$' },
          throughRound: { type: 'integer', minimum: 1, maximum: 100 },
        }),
      },
      async (request) => {
        const ctx = requireAuth(request);
        const p = params<{ eventId: string; stageKey: string }>(request);
        const q = request.query as { group?: string; throughRound?: number };
        return scoring.classify(
          defined({
            actorAccountId: ctx.accountId,
            eventId: p.eventId,
            stageKey: p.stageKey,
            groupKey: q.group,
            throughRound: q.throughRound,
          }),
        );
      },
    );
  }

  // ───────────────────────────── registration (SELF / COMP_STAFF) ─────────────────────────────

  // ONCF-04 registration reads. Never public. An athlete is named only when its profile is PUBLIC or
  // AUTHENTICATED (the ONCF-02 roster rule); otherwise `athlete` is null and the row is a private
  // athlete. Team names are public by design.
  const named = async <T extends RegistrationEntry>(items: T[]) => {
    const athletes = await deps.identity.visibleAthletes([
      ...new Set(items.flatMap((r) => (r.athleteId === null ? [] : [r.athleteId]))),
    ]);
    return items.map((r) => ({
      ...r,
      athlete: r.athleteId === null ? null : (athletes.get(r.athleteId) ?? null),
    }));
  };

  // ONCF-05B: declared entry attributes (entry time, average, handicap, bib, classification points).
  route(
    'GET',
    '/v1/registrations/:registrationId/entry-attributes',
    'SELF',
    { params: idParams('registrationId') },
    async (request) => {
      const ctx = requireAuth(request);
      return {
        items: await deps.structure.entryAttributes({
          actorAccountId: ctx.accountId,
          registrationId: params<{ registrationId: string }>(request).registrationId,
        }),
      };
    },
  );

  route(
    'POST',
    '/v1/registrations/:registrationId/entry-attributes',
    'SELF',
    {
      params: idParams('registrationId'),
      headers: idempotencyHeaders,
      body: obj(
        {
          attributes: {
            type: 'array',
            minItems: 1,
            maxItems: 64,
            items: obj(
              {
                key: { type: 'string', pattern: '^[a-z][A-Za-z0-9]{0,31}$' },
                value: { type: ['string', 'null'], minLength: 1, maxLength: 64 },
                athleteId: uuid,
              },
              ['key', 'value'],
            ),
          },
        },
        ['attributes'],
      ),
    },
    async (request) => {
      const ctx = requireAuth(request);
      const b = body<{ attributes: { key: string; value: string | null; athleteId?: string }[] }>(
        request,
      );
      return deps.structure.declareEntryAttributes({
        actorAccountId: ctx.accountId,
        registrationId: params<{ registrationId: string }>(request).registrationId,
        attributes: b.attributes,
        idempotencyKey: key(request),
      });
    },
  );

  route('GET', '/v1/me/registrations', 'AUTHENTICATED', {}, async (request) => {
    const ctx = requireAuth(request);
    return {
      items: await named(
        await deps.competitions.myRegistrations({ actorAccountId: ctx.accountId }),
      ),
    };
  });

  route(
    'GET',
    '/v1/registrations/:registrationId',
    'SELF',
    { params: idParams('registrationId') },
    async (request) => {
      const ctx = requireAuth(request);
      const r = await deps.competitions.registration({
        actorAccountId: ctx.accountId,
        registrationId: params<{ registrationId: string }>(request).registrationId,
      });
      return (await named([r]))[0];
    },
  );

  route(
    'GET',
    '/v1/competitions/:competitionId/registrations',
    'COMP_STAFF',
    {
      params: idParams('competitionId'),
      querystring: obj({
        eventId: uuid,
        status: {
          enum: ['REQUESTED', 'WAITLISTED', 'CONFIRMED', 'DECLINED', 'WITHDRAWN', 'CANCELLED'],
        },
        after: uuid,
        limit: { type: 'string', pattern: '^([1-9]|[1-9][0-9]|100)$' },
      }),
    },
    async (request) => {
      const ctx = requireAuth(request);
      const q = request.query as {
        eventId?: string;
        status?: 'REQUESTED';
        after?: string;
        limit?: string;
      };
      const page = await deps.competitions.competitionRegistrations(
        defined({
          actorAccountId: ctx.accountId,
          competitionId: params<{ competitionId: string }>(request).competitionId,
          eventId: q.eventId,
          status: q.status,
          after: q.after,
          limit: q.limit === undefined ? undefined : Number(q.limit),
        }),
      );
      return { ...page, items: await named(page.items) };
    },
  );

  route(
    'POST',
    '/v1/events/:eventId/registrations',
    'SELF',
    {
      params: idParams('eventId'),
      headers: idempotencyHeaders,
      body: obj({ athleteId: uuid, teamId: uuid, eligibilityDeclared: { type: 'boolean' } }, [
        'eligibilityDeclared',
      ]),
    },
    async (request, reply) => {
      const ctx = requireAuth(request);
      const b = body<{ athleteId?: string; teamId?: string; eligibilityDeclared: boolean }>(
        request,
      );
      const r = await deps.competitions.register(
        defined({
          actorAccountId: ctx.accountId,
          eventId: params<{ eventId: string }>(request).eventId,
          ...b,
          idempotencyKey: key(request),
        }),
      );
      reply.code(r.created ? 201 : 200);
      return r;
    },
  );

  route(
    'POST',
    '/v1/registrations/:registrationId/decision',
    'COMP_STAFF',
    {
      params: idParams('registrationId'),
      headers: idempotencyHeaders,
      body: obj(
        {
          decision: { enum: ['CONFIRM', 'WAITLIST', 'DECLINE', 'CANCEL'] },
          reason: { type: 'string', minLength: 1, maxLength: 500 },
        },
        ['decision'],
      ),
    },
    async (request) => {
      const ctx = requireAuth(request);
      const b = body<{ decision: 'CONFIRM'; reason?: string }>(request);
      return deps.competitions.decideRegistration(
        defined({
          actorAccountId: ctx.accountId,
          registrationId: params<{ registrationId: string }>(request).registrationId,
          ...b,
          idempotencyKey: key(request),
        }),
      );
    },
  );

  route(
    'POST',
    '/v1/registrations/:registrationId/withdraw',
    'SELF',
    { params: idParams('registrationId'), headers: idempotencyHeaders },
    async (request) => {
      const ctx = requireAuth(request);
      return deps.competitions.withdrawRegistration({
        actorAccountId: ctx.accountId,
        registrationId: params<{ registrationId: string }>(request).registrationId,
        idempotencyKey: key(request),
      });
    },
  );

  route(
    'POST',
    '/v1/participants/:participantId/withdraw',
    'SELF',
    {
      params: idParams('participantId'),
      body: obj({ reason: { type: 'string', minLength: 1, maxLength: 500 } }),
    },
    async (request) => {
      const ctx = requireAuth(request);
      const { participantId } = params<{ participantId: string }>(request);
      await deps.structure.withdrawParticipant(
        defined({
          actorAccountId: ctx.accountId,
          participantId,
          reason: body<{ reason?: string } | undefined>(request)?.reason,
        }),
      );
      return { participantId, status: 'WITHDRAWN' };
    },
  );

  route(
    'POST',
    '/v1/participants/:participantId/disqualify',
    'COMP_STAFF',
    {
      params: idParams('participantId'),
      body: obj(
        {
          reason: { type: 'string', minLength: 1, maxLength: 500 },
          reference: { type: 'string', minLength: 1, maxLength: 200 },
        },
        ['reason', 'reference'],
      ),
    },
    async (request) => {
      const ctx = requireAuth(request);
      const { participantId } = params<{ participantId: string }>(request);
      await deps.structure.disqualifyParticipant({
        actorAccountId: ctx.accountId,
        participantId,
        ...body<{ reason: string; reference: string }>(request),
      });
      return {
        participantId,
        status: 'DISQUALIFIED',
        note: 'operational status; not a verified sporting sanction',
      };
    },
  );

  // ───────────────────────────── contests (COMP_STAFF / SELF) ─────────────────────────────

  route(
    'POST',
    '/v1/contests/:contestId/schedule',
    'COMP_STAFF',
    {
      params: idParams('contestId'),
      headers: idempotencyHeaders,
      body: obj(
        {
          scheduledStart: instant,
          scheduledEnd: nullableInstant,
          venueOrganizationId: { type: ['string', 'null'], format: 'uuid' },
          locationLabel: nullableString(120),
          courtLabel: nullableString(40),
        },
        ['scheduledStart'],
      ),
    },
    async (request) => {
      const ctx = requireAuth(request);
      const b = body<{
        scheduledStart: string;
        scheduledEnd?: string | null;
        venueOrganizationId?: string | null;
        locationLabel?: string | null;
        courtLabel?: string | null;
      }>(request);
      return deps.structure.scheduleContest(
        defined({
          actorAccountId: ctx.accountId,
          contestId: params<{ contestId: string }>(request).contestId,
          ...b,
          idempotencyKey: key(request),
        }),
      );
    },
  );

  for (const action of ['start', 'complete'] as const) {
    route(
      'POST',
      `/v1/contests/:contestId/${action}`,
      'COMP_STAFF',
      { params: idParams('contestId') },
      async (request) => {
        const ctx = requireAuth(request);
        const { contestId } = params<{ contestId: string }>(request);
        await (action === 'start'
          ? deps.structure.startContest({ actorAccountId: ctx.accountId, contestId })
          : deps.structure.completeContest({ actorAccountId: ctx.accountId, contestId }));
        // Operational status only: no Result is created, accepted or verified.
        return {
          contestId,
          status: action === 'start' ? 'IN_PROGRESS' : 'COMPLETED',
          result: { status: 'NOT_AVAILABLE', reason: 'SOURCE_NOT_IMPLEMENTED' },
        };
      },
    );
  }

  for (const action of ['cancel', 'void'] as const) {
    route(
      'POST',
      `/v1/contests/:contestId/${action}`,
      'COMP_STAFF',
      {
        params: idParams('contestId'),
        body: obj({ reason: { type: 'string', minLength: 1, maxLength: 500 } }, ['reason']),
      },
      async (request) => {
        const ctx = requireAuth(request);
        const { contestId } = params<{ contestId: string }>(request);
        const input = {
          actorAccountId: ctx.accountId,
          contestId,
          reason: body<{ reason: string }>(request).reason,
        };
        await (action === 'cancel'
          ? deps.structure.cancelContest(input)
          : deps.structure.voidContest(input));
        return { contestId, status: action === 'cancel' ? 'CANCELLED' : 'VOID' };
      },
    );
  }

  route(
    'POST',
    '/v1/contests/:contestId/lineups',
    'SELF',
    {
      params: idParams('contestId'),
      headers: idempotencyHeaders,
      body: obj(
        {
          participantId: uuid,
          athletes: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            items: obj(
              { athleteId: uuid, role: { type: 'string', pattern: '^[A-Z][A-Z_]{1,31}$' } },
              ['athleteId'],
            ),
          },
        },
        ['participantId', 'athletes'],
      ),
    },
    async (request, reply) => {
      const ctx = requireAuth(request);
      const b = body<{ participantId: string; athletes: { athleteId: string; role?: string }[] }>(
        request,
      );
      const r = await deps.structure.submitLineup({
        actorAccountId: ctx.accountId,
        contestId: params<{ contestId: string }>(request).contestId,
        participantId: b.participantId,
        athletes: b.athletes.map((a) => defined(a)),
        idempotencyKey: key(request),
      });
      reply.code(r.created ? 201 : 200);
      return r;
    },
  );

  // ───────────────────────────── teams (AUTHENTICATED / SELF) ─────────────────────────────

  // ONCF-05B team reads for pair / squad entry. Members are named under the roster rule.
  route('GET', '/v1/me/teams', 'AUTHENTICATED', {}, async (request) => {
    const ctx = requireAuth(request);
    const items = await deps.teams.myTeams({ actorAccountId: ctx.accountId });
    const athletes = await deps.identity.visibleAthletes([
      ...new Set(items.flatMap((t) => t.members.map((m) => m.athleteId))),
    ]);
    return {
      items: items.map((t) => ({
        ...t,
        members: t.members.map((m) => ({ ...m, athlete: athletes.get(m.athleteId) ?? null })),
      })),
    };
  });

  route('GET', '/v1/me/team-memberships', 'AUTHENTICATED', {}, async (request) => {
    const ctx = requireAuth(request);
    return { items: await deps.teams.myMemberships({ actorAccountId: ctx.accountId }) };
  });

  route(
    'POST',
    '/v1/teams',
    'AUTHENTICATED',
    {
      headers: idempotencyHeaders,
      body: obj(
        {
          teamKind: { enum: ['PERSISTENT', 'EVENT_PAIR', 'EVENT_SQUAD'] },
          displayName: { type: 'string', minLength: 1, maxLength: 80 },
          organizationId: uuid,
        },
        ['teamKind', 'displayName'],
      ),
    },
    async (request, reply) => {
      const ctx = requireAuth(request);
      const r = await deps.teams.createTeam(
        defined({
          actorAccountId: ctx.accountId,
          ...body<{ teamKind: 'EVENT_PAIR'; displayName: string; organizationId?: string }>(
            request,
          ),
          idempotencyKey: key(request),
        }),
      );
      reply.code(r.created ? 201 : 200);
      return r;
    },
  );

  route(
    'POST',
    '/v1/teams/:teamId/members',
    'AUTHENTICATED',
    {
      params: idParams('teamId'),
      headers: idempotencyHeaders,
      body: obj({ athleteId: uuid, role: { type: 'string', pattern: '^[A-Z][A-Z_]{1,31}$' } }, [
        'athleteId',
      ]),
    },
    async (request, reply) => {
      const ctx = requireAuth(request);
      const r = await deps.teams.addMember(
        defined({
          actorAccountId: ctx.accountId,
          teamId: params<{ teamId: string }>(request).teamId,
          ...body<{ athleteId: string; role?: string }>(request),
          idempotencyKey: key(request),
        }),
      );
      reply.code(r.created ? 201 : 200);
      return r;
    },
  );

  for (const [action, accept] of [
    ['accept', true],
    ['decline', false],
  ] as const) {
    route(
      'POST',
      `/v1/team-memberships/:membershipId/${action}`,
      'SELF',
      { params: idParams('membershipId') },
      async (request) => {
        const ctx = requireAuth(request);
        return deps.teams.respond({
          actorAccountId: ctx.accountId,
          membershipId: params<{ membershipId: string }>(request).membershipId,
          accept,
        });
      },
    );
  }

  route(
    'POST',
    '/v1/team-memberships/:membershipId/end',
    'SELF',
    { params: idParams('membershipId') },
    async (request) => {
      const ctx = requireAuth(request);
      const { membershipId } = params<{ membershipId: string }>(request);
      await deps.teams.endMembership({ actorAccountId: ctx.accountId, membershipId });
      return { membershipId, status: 'ENDED' };
    },
  );
}
