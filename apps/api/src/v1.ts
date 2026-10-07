import { DomainError, DomainErrorCode } from '@br/domain';
import { OrgPermission, ROLE_PERMISSIONS, SLUG_MAX_LENGTH, type AuthContext } from '@br/identity';
import type {
  IdentityStore,
  OrganizationReader,
  OrganizationStore,
  PassportReader,
  PersonPrivateDataService,
} from '@br/persistence';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthAdapter } from './auth';
import { registerAchievementsV1, type AchievementsV1Deps } from './v1-achievements';
import { registerRecordsV1, type RecordsV1Deps } from './v1-records';
import { registerRankingsV1, type RankingsV1Deps } from './v1-rankings';
import { registerCompetitionV1, type CompetitionV1Deps } from './v1-competition';
import { registerEvidenceV1, type EvidenceV1Deps } from './v1-evidence';
import { registerVerificationV1, type VerificationV1Deps } from './v1-verification';

/**
 * Endpoint classification (BRT-04 §20). The edge enforces authentication (and the operator flag for
 * INTERNAL); the finer SELF / GUARDIAN / ORG_MEMBER / ORG_ADMIN decisions are made by the stores
 * inside the command transaction, from database facts — never from client-supplied claims.
 */
export type EndpointClass =
  | 'PUBLIC'
  | 'AUTHENTICATED'
  | 'SELF'
  | 'GUARDIAN'
  | 'ORG_MEMBER'
  | 'ORG_ADMIN'
  /** BRT-05: competition operational staff (application permissions decided in the store). */
  | 'COMP_STAFF'
  /**
   * BRT-06: an account that represents the issuer Principal (SELF for its own PERSON principal,
   * OWNER/ADMIN for an ORGANIZATION principal) — an application permission, never authority.
   */
  | 'ISSUER_REPRESENTATIVE'
  | 'INTERNAL';

export interface RouteInfo {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly url: string;
  readonly classification: EndpointClass;
}

export interface V1Deps {
  readonly auth: AuthAdapter;
  readonly identity: IdentityStore;
  readonly organizations: OrganizationStore;
  readonly passports: PassportReader;
  readonly organizationReader: OrganizationReader;
  /** Absent when no PII cipher is configured (e.g. production without KMS): private-data endpoints fail closed. */
  readonly privateData?: PersonPrivateDataService;
  /** BRT-05 competition operations (registered when provided). */
  readonly competition?: CompetitionV1Deps;
  /** BRT-06 evidence & attestation (registered when provided). */
  readonly evidence?: EvidenceV1Deps;
  /** BRT-07 verification (registered when provided). */
  readonly verification?: VerificationV1Deps;
  /** BRT-08 achievements (registered when provided). */
  readonly achievements?: AchievementsV1Deps;
  /** BRT-09 records & Record Hall of Fame (registered when provided). */
  readonly records?: RecordsV1Deps;
  /** BRT-10 rankings & classifications read surface (registered when provided). */
  readonly rankings?: RankingsV1Deps;
}

/** Shared route-registration toolkit (same auth boundary, DTO strictness and classification). */
export interface V1Toolkit {
  readonly route: (
    method: RouteInfo['method'],
    url: string,
    classification: EndpointClass,
    schema: Record<string, unknown>,
    handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
    options?: {
      readonly bodyLimit?: number;
      /** BRT-07: accountability hook for requests refused at the edge (e.g. non-operator). */
      readonly onDenied?: (request: FastifyRequest) => Promise<void>;
    },
  ) => void;
  readonly requireAuth: (request: FastifyRequest) => AuthContext;
  readonly operator: (request: FastifyRequest) => AuthContext;
  readonly key: (request: FastifyRequest) => string;
}

const HTTP_STATUS: Record<DomainErrorCode, number> = {
  NOT_FOUND: 404,
  INVALID_INPUT: 400,
  SLUG_INVALID: 400,
  AUTHORITY_DENIED: 403,
  FORBIDDEN: 403,
  UNAUTHENTICATED: 401,
  INVALID_TRANSITION: 409,
  CONCURRENCY_CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  ALREADY_EXISTS: 409,
  SLUG_TAKEN: 409,
  CURRENT_VERSION_CONFLICT: 409,
  IMMUTABLE: 409,
  BACKDATING_REJECTED: 400,
  GRANT_INVALID: 400,
  ANCHOR_INVALID: 400,
  INVITATION_INVALID: 422,
  CHALLENGE_INVALID: 422,
  PROOF_INVALID: 422,
  PRIVATE_DATA_UNAVAILABLE: 503,
  CAPACITY_REACHED: 409,
  INTERNAL_CAPABILITY_UNAVAILABLE: 503,
  EVIDENCE_STORAGE_UNAVAILABLE: 503,
  EVIDENCE_NOT_AVAILABLE: 409,
  EVIDENCE_TOO_LARGE: 413,
  EVIDENCE_TYPE_NOT_ALLOWED: 415,
  ATTESTATION_CHALLENGE_EXPIRED: 422,
  ATTESTATION_CHALLENGE_USED: 409,
  ATTESTATION_PROOF_INVALID: 422,
  ISSUER_NOT_CONTROLLED: 403,
  KEY_NOT_VALID: 422,
  // BRT-07: system conditions, never sporting outcomes.
  VERIFICATION_INTEGRITY_FAILURE: 500,
  VERIFICATION_TIME_INCONSISTENT: 503,
  // BRT-08: a system condition (basis / hash mismatch), never a sporting outcome.
  ACHIEVEMENT_INTEGRITY_FAILURE: 500,
  // BRT-09: a system condition (category / value / subject-hash mismatch), never a sporting outcome.
  RECORD_INTEGRITY_FAILURE: 500,
  // BRT-10: a submitted classification that is not the canonical derivation (client-side content).
  CLASSIFICATION_DERIVATION_MISMATCH: 422,
  // BRT-10: a system condition (run / outcome / snapshot mismatch), never a sporting outcome.
  RANKING_INTEGRITY_FAILURE: 500,
};

/** Error body: stable code + safe message. Never echoes request values, SQL details or PII. */
export function errorBody(err: DomainError): {
  status: number;
  body: {
    error: {
      code: string;
      message: string;
      reason?: string;
      issues?: { path: string; code: string }[];
    };
  };
} {
  const status = HTTP_STATUS[err.code] ?? 500;
  const message = err.message.replace(/^[A-Z_]+: /, '');
  // BRT-06: a fixed-vocabulary reason code (never input values) where it helps a signer.
  const reason = err.details.reason ?? err.details.availability;
  const withReason =
    (err.code === 'KEY_NOT_VALID' ||
      err.code === 'EVIDENCE_NOT_AVAILABLE' ||
      err.code === 'VERIFICATION_INTEGRITY_FAILURE' ||
      err.code === 'VERIFICATION_TIME_INCONSISTENT' ||
      err.code === 'ACHIEVEMENT_INTEGRITY_FAILURE' ||
      err.code === 'RECORD_INTEGRITY_FAILURE' ||
      err.code === 'RANKING_INTEGRITY_FAILURE') &&
    typeof reason === 'string' &&
    /^[A-Z][A-Z0-9_]{0,39}$/.test(reason);
  // BRT-07: policy-spec validation issues — fixed codes and sanitized JSON pointers, never values.
  const rawIssues = err.code === 'INVALID_INPUT' ? err.details.issues : undefined;
  const issues = Array.isArray(rawIssues)
    ? rawIssues
        .filter(
          (i): i is { path: string; code: string } =>
            typeof i === 'object' &&
            i !== null &&
            typeof (i as { path?: unknown }).path === 'string' &&
            typeof (i as { code?: unknown }).code === 'string',
        )
        .map((i) => ({
          path: /^[/A-Za-z0-9._-]{0,200}$/.test(i.path) ? i.path : '/',
          code: /^[A-Z][A-Z0-9_:]{0,79}$/.test(i.code) ? i.code : 'INVALID',
        }))
        .slice(0, 32)
    : undefined;
  return {
    status,
    body: {
      error: {
        code: err.code,
        message,
        ...(withReason ? { reason } : {}),
        ...(issues === undefined ? {} : { issues }),
      },
    },
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    authContext: AuthContext | null;
  }
}

export const uuid = { type: 'string', format: 'uuid' } as const;
export const idParams = (name: string) =>
  ({
    type: 'object',
    required: [name],
    properties: { [name]: uuid },
    additionalProperties: false,
  }) as const;
/**
 * ONCF-03A slug bounds. A slug being CLAIMED (body) is bounded by the canonical SLUG_MAX_LENGTH
 * (the store still normalizes and validates it). A slug in a PATH is only a lookup key: any value
 * that cannot be a slug simply misses (404), so its bound is a request-size guard, not a slug rule.
 */
export const slugSchema = { type: 'string', minLength: 1, maxLength: SLUG_MAX_LENGTH } as const;
export const lookupSlugSchema = { type: 'string', minLength: 1, maxLength: 100 } as const;
const slugParams = {
  type: 'object',
  required: ['slug'],
  properties: { slug: lookupSlugSchema },
} as const;
export const idempotencyHeaders = {
  type: 'object',
  required: ['idempotency-key'],
  properties: {
    'idempotency-key': {
      type: 'string',
      minLength: 8,
      maxLength: 200,
      pattern: '^[A-Za-z0-9._:-]+$',
    },
  },
} as const;
export const nullableString = (max: number) =>
  ({ type: ['string', 'null'], maxLength: max }) as const;
const profileProps = {
  displayName: { type: 'string', minLength: 1, maxLength: 80 },
  shortBio: nullableString(500),
  homeCountry: { type: ['string', 'null'], pattern: '^[A-Z]{2}$' },
  preferredSports: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 40 } },
  profileVisibility: { enum: ['PUBLIC', 'AUTHENTICATED', 'PRIVATE'] },
} as const;
const orgProfileProps = {
  displayName: { type: 'string', minLength: 1, maxLength: 120 },
  description: nullableString(2000),
  website: nullableString(255),
  country: { type: ['string', 'null'], pattern: '^[A-Z]{2}$' },
  region: nullableString(10),
  publicContact: nullableString(200),
  // ONCF-02 (0031): branding and sports.
  logoUrl: nullableString(500),
  accentColor: { type: ['string', 'null'], pattern: '^#[0-9a-f]{6}$' },
  sports: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 40 } },
} as const;
export const obj = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', properties, required, additionalProperties: false }) as const;

/** Removes keys whose value is undefined (exactOptionalPropertyTypes-friendly DTO mapping). */
export function defined<T extends Record<string, unknown>>(
  o: T,
): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as never;
}

export function registerV1(app: FastifyInstance, deps: V1Deps): RouteInfo[] {
  const routes: RouteInfo[] = [];
  app.decorateRequest('authContext', null);

  const requireAuth = (request: FastifyRequest): AuthContext => {
    if (request.authContext === null)
      throw new DomainError(DomainErrorCode.UNAUTHENTICATED, 'authentication required');
    return request.authContext;
  };
  const operator = (request: FastifyRequest): AuthContext => {
    const ctx = requireAuth(request);
    if (ctx.operator !== true) throw new DomainError(DomainErrorCode.FORBIDDEN, 'not permitted');
    return ctx;
  };
  const vault = (): PersonPrivateDataService => {
    if (deps.privateData === undefined)
      throw new DomainError(
        DomainErrorCode.PRIVATE_DATA_UNAVAILABLE,
        'private data storage is not configured',
      );
    return deps.privateData;
  };
  const key = (request: FastifyRequest): string => request.headers['idempotency-key'] as string;

  type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  const route = (
    method: RouteInfo['method'],
    url: string,
    classification: EndpointClass,
    schema: Record<string, unknown>,
    handler: Handler,
    options: {
      readonly bodyLimit?: number;
      readonly onDenied?: (request: FastifyRequest) => Promise<void>;
    } = {},
  ) => {
    routes.push({ method, url, classification });
    app.route({
      method,
      url,
      schema,
      ...(options.bodyLimit === undefined ? {} : { bodyLimit: options.bodyLimit }),
      config: { classification },
      // onRequest runs before body/params validation: unauthenticated callers learn nothing about DTOs.
      onRequest: async (request) => {
        request.authContext = await deps.auth.authenticate(request);
        try {
          if (classification === 'INTERNAL') operator(request);
          else if (classification !== 'PUBLIC') requireAuth(request);
        } catch (err) {
          if (options.onDenied !== undefined)
            await options.onDenied(request).catch(() => undefined);
          throw err;
        }
      },
      handler,
    });
  };

  // ───────────────────────────── PUBLIC ─────────────────────────────

  route('GET', '/v1/athletes/:slug', 'PUBLIC', { params: slugParams }, async (request) => {
    const { slug } = request.params as { slug: string };
    const r = await deps.passports.bySlug(slug, { authenticated: request.authContext !== null });
    if (r === undefined) throw new DomainError(DomainErrorCode.NOT_FOUND, 'athlete not found');
    return {
      passport: r.passport,
      canonicalSlug: r.resolution.currentSlug,
      redirected: r.resolution.redirected,
    };
  });

  // ONCF-02: the canonical membership roles and the organization permissions each one grants.
  route('GET', '/v1/organization-roles', 'PUBLIC', {}, () =>
    Promise.resolve({
      roles: Object.entries(ROLE_PERMISSIONS).map(([role, permissions]) => ({
        role,
        permissions: [...permissions].sort(),
      })),
      permissions: [...Object.values(OrgPermission)].sort(),
    }),
  );

  route('GET', '/v1/organizations/:slug', 'PUBLIC', { params: slugParams }, async (request) => {
    const { slug } = request.params as { slug: string };
    const r = await deps.organizationReader.bySlug(slug);
    if (r === undefined) throw new DomainError(DomainErrorCode.NOT_FOUND, 'organization not found');
    const affiliations = await deps.passports.organizationAffiliations(
      r.organization.organizationId,
    );
    return {
      organization: {
        ...r.organization,
        profile: { ...r.organization.profile, provenance: 'SELF_DECLARED' },
        // Describing an organization confers no authority: authority comes only from trust anchors and grants.
        authority: { status: 'NOT_AVAILABLE', reason: 'SOURCE_NOT_IMPLEMENTED' },
      },
      affiliations: {
        status: 'AVAILABLE',
        items: affiliations.map((a) => ({ ...a, provenance: 'ORGANIZATION_CONFIRMED' })),
      },
      canonicalSlug: r.currentSlug,
      redirected: r.redirected,
    };
  });

  // ───────────────────────────── AUTHENTICATED ─────────────────────────────

  route('GET', '/v1/me', 'AUTHENTICATED', {}, async (request) => {
    const ctx = requireAuth(request);
    return deps.identity.me(ctx.accountId);
  });

  // ONCF-01: the caller's own active organization memberships (onboarding state, signed-in nav).
  route('GET', '/v1/me/organizations', 'AUTHENTICATED', {}, async (request) => {
    const ctx = requireAuth(request);
    return { items: await deps.organizations.myOrganizations(ctx.accountId) };
  });

  route(
    'POST',
    '/v1/persons',
    'AUTHENTICATED',
    {
      headers: idempotencyHeaders,
      body: obj(
        {
          relation: { enum: ['SELF', 'DEPENDENT'] },
          relationshipKind: { enum: ['PARENT', 'LEGAL_GUARDIAN', 'OTHER_RESPONSIBLE_ADULT'] },
        },
        ['relation'],
      ),
    },
    async (request, reply) => {
      const ctx = requireAuth(request);
      const body = request.body as {
        relation: 'SELF' | 'DEPENDENT';
        relationshipKind?: 'PARENT' | 'LEGAL_GUARDIAN' | 'OTHER_RESPONSIBLE_ADULT';
      };
      const r = await deps.identity.createPerson(
        defined({
          actorAccountId: ctx.accountId,
          relation: body.relation,
          relationshipKind: body.relationshipKind,
          idempotencyKey: key(request),
        }),
      );
      reply.code(r.created ? 201 : 200);
      return {
        personId: r.personId,
        guardianRelationshipId: r.guardianRelationshipId,
        guardianStatus: r.guardianRelationshipId === null ? null : 'PENDING',
      };
    },
  );

  route(
    'POST',
    '/v1/athletes',
    'GUARDIAN',
    {
      headers: idempotencyHeaders,
      body: obj(
        {
          personId: uuid,
          slug: slugSchema,
          profile: obj(profileProps, ['displayName']),
        },
        ['personId', 'slug', 'profile'],
      ),
    },
    async (request, reply) => {
      const ctx = requireAuth(request);
      const body = request.body as {
        personId: string;
        slug: string;
        profile: {
          displayName: string;
          shortBio?: string | null;
          homeCountry?: string | null;
          preferredSports?: string[];
          profileVisibility?: 'PUBLIC' | 'AUTHENTICATED' | 'PRIVATE';
        };
      };
      const r = await deps.identity.createAthlete({
        actorAccountId: ctx.accountId,
        personId: body.personId,
        slug: body.slug,
        profile: defined(body.profile),
        idempotencyKey: key(request),
      });
      reply.code(r.created ? 201 : 200);
      return { athleteId: r.athleteId, slug: r.slug };
    },
  );

  route(
    'POST',
    '/v1/organizations',
    'AUTHENTICATED',
    {
      headers: idempotencyHeaders,
      body: obj(
        {
          orgType: {
            enum: [
              'FEDERATION',
              'GOVERNING_BODY',
              'LEAGUE',
              'CLUB',
              'ACADEMY',
              'EVENT_ORGANIZER',
              'VENUE',
              'SPONSOR',
              'BRAND',
              'SERVICE_PROVIDER',
              'OTHER',
            ],
          },
          slug: slugSchema,
          profile: obj(orgProfileProps, ['displayName']),
        },
        ['orgType', 'slug', 'profile'],
      ),
    },
    async (request, reply) => {
      const ctx = requireAuth(request);
      const body = request.body as {
        orgType: never;
        slug: string;
        profile: { displayName: string };
      };
      const r = await deps.organizations.createOrganization({
        actorAccountId: ctx.accountId,
        orgType: body.orgType,
        slug: body.slug,
        profile: defined(body.profile),
        idempotencyKey: key(request),
      });
      reply.code(r.created ? 201 : 200);
      return { organizationId: r.organizationId, principalId: r.principalId, slug: r.slug };
    },
  );

  for (const [path, accept] of [
    ['accept', true],
    ['decline', false],
  ] as const) {
    route(
      'POST',
      `/v1/invitations/${path}`,
      'SELF',
      { body: obj({ token: { type: 'string', minLength: 20, maxLength: 200 } }, ['token']) },
      async (request) => {
        const ctx = requireAuth(request);
        const { token } = request.body as { token: string };
        return deps.organizations.respondToInvitation({
          actorAccountId: ctx.accountId,
          token,
          accept,
        });
      },
    );
  }

  // ONCF-02: the invitee previews an invitation before answering (same validity rules as accept).
  route(
    'POST',
    '/v1/invitations/inspect',
    'SELF',
    { body: obj({ token: { type: 'string', minLength: 20, maxLength: 200 } }, ['token']) },
    async (request, reply) => {
      const ctx = requireAuth(request);
      const { token } = request.body as { token: string };
      reply.header('cache-control', 'no-store');
      return deps.organizations.inspectInvitation({ actorAccountId: ctx.accountId, token });
    },
  );

  // ───────────────────────────── SELF (private data, wallets) ─────────────────────────────

  route(
    'GET',
    '/v1/persons/:personId/private',
    'SELF',
    { params: idParams('personId') },
    async (request, reply) => {
      const ctx = requireAuth(request);
      const { personId } = request.params as { personId: string };
      reply.header('cache-control', 'no-store');
      return vault().read({ actorAccountId: ctx.accountId, personId });
    },
  );

  route(
    'PUT',
    '/v1/persons/:personId/private',
    'SELF',
    {
      params: idParams('personId'),
      body: obj({
        legalName: nullableString(200),
        dateOfBirth: nullableString(10),
        email: nullableString(254),
        phone: nullableString(16),
      }),
    },
    async (request) => {
      const ctx = requireAuth(request);
      const { personId } = request.params as { personId: string };
      const r = await vault().write({
        actorAccountId: ctx.accountId,
        personId,
        data: defined(request.body as Record<string, string | null | undefined>),
      });
      return { updatedFields: r.fields };
    },
  );

  route(
    'DELETE',
    '/v1/persons/:personId/private',
    'SELF',
    { params: idParams('personId') },
    async (request, reply) => {
      const ctx = requireAuth(request);
      const { personId } = request.params as { personId: string };
      await vault().erase({ actorAccountId: ctx.accountId, personId });
      reply.code(204);
      return null;
    },
  );

  route(
    'POST',
    '/v1/persons/:personId/wallet-challenges',
    'SELF',
    {
      params: idParams('personId'),
      headers: idempotencyHeaders,
      body: obj(
        {
          // BRT-04 proof schemes are EVM-only: CAIP-2 eip155:<chainId> + 20-byte hex address.
          network: { type: 'string', pattern: '^eip155:[1-9][0-9]{0,31}$' },
          address: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
          visibility: { enum: ['PUBLIC', 'PRIVATE'] },
          proofScheme: { enum: ['eip191-personal-sign', 'test-signature'] },
        },
        ['network', 'address', 'visibility'],
      ),
    },
    async (request, reply) => {
      const ctx = requireAuth(request);
      const { personId } = request.params as { personId: string };
      const body = request.body as {
        network: string;
        address: string;
        visibility: 'PUBLIC' | 'PRIVATE';
        proofScheme?: 'eip191-personal-sign' | 'test-signature';
      };
      const c = await deps.identity.prepareWalletLink(
        defined({
          actorAccountId: ctx.accountId,
          personId,
          ...body,
          idempotencyKey: key(request),
        }),
      );
      reply.code(201);
      return {
        challengeId: c.challengeId,
        proofScheme: c.proofScheme,
        message: c.message,
        expiresAt: c.expiresAt.toISOString(),
      };
    },
  );

  route(
    'POST',
    '/v1/wallet-links',
    'SELF',
    {
      headers: idempotencyHeaders,
      body: obj(
        { challengeId: uuid, signature: { type: 'string', minLength: 1, maxLength: 1000 } },
        ['challengeId', 'signature'],
      ),
    },
    async (request, reply) => {
      const ctx = requireAuth(request);
      const body = request.body as { challengeId: string; signature: string };
      const r = await deps.identity.verifyWalletLink({
        actorAccountId: ctx.accountId,
        ...body,
        idempotencyKey: key(request),
      });
      reply.code(201);
      return r;
    },
  );

  route(
    'DELETE',
    '/v1/wallet-links/:walletLinkId',
    'SELF',
    { params: idParams('walletLinkId') },
    async (request, reply) => {
      const ctx = requireAuth(request);
      const { walletLinkId } = request.params as { walletLinkId: string };
      await deps.identity.revokeWalletLink({
        actorAccountId: ctx.accountId,
        walletLinkId,
        reason: 'revoked by owner',
      });
      reply.code(204);
      return null;
    },
  );

  // ───────────────────────────── GUARDIAN (self or confirmed guardian) ─────────────────────────────

  route(
    'PATCH',
    '/v1/athletes/:athleteId/profile',
    'GUARDIAN',
    { params: idParams('athleteId'), body: obj(profileProps) },
    async (request) => {
      const ctx = requireAuth(request);
      const { athleteId } = request.params as { athleteId: string };
      await deps.identity.updateAthleteProfile({
        actorAccountId: ctx.accountId,
        athleteId,
        patch: defined(request.body as Record<string, never>),
      });
      return { athleteId };
    },
  );

  route(
    'PUT',
    '/v1/athletes/:athleteId/slug',
    'GUARDIAN',
    {
      params: idParams('athleteId'),
      body: obj({ slug: slugSchema }, ['slug']),
    },
    async (request) => {
      const ctx = requireAuth(request);
      const { athleteId } = request.params as { athleteId: string };
      return deps.identity.changeAthleteSlug({
        actorAccountId: ctx.accountId,
        athleteId,
        slug: (request.body as { slug: string }).slug,
      });
    },
  );

  route(
    'POST',
    '/v1/athletes/:athleteId/external-identities',
    'GUARDIAN',
    {
      params: idParams('athleteId'),
      headers: idempotencyHeaders,
      body: obj(
        {
          namespace: { type: 'string', maxLength: 100 },
          issuerOrganizationId: uuid,
          externalValue: { type: 'string', minLength: 1, maxLength: 200 },
          visibility: { enum: ['PUBLIC', 'PRIVATE'] },
        },
        ['namespace', 'externalValue', 'visibility'],
      ),
    },
    async (request, reply) => {
      const ctx = requireAuth(request);
      const { athleteId } = request.params as { athleteId: string };
      const body = request.body as {
        namespace: string;
        issuerOrganizationId?: string;
        externalValue: string;
        visibility: 'PUBLIC' | 'PRIVATE';
      };
      const r = await deps.identity.claimExternalIdentity(
        defined({
          actorAccountId: ctx.accountId,
          athleteId,
          ...body,
          idempotencyKey: key(request),
        }),
      );
      reply.code(201);
      return r;
    },
  );

  route(
    'DELETE',
    '/v1/external-identities/:externalIdentityId',
    'GUARDIAN',
    { params: idParams('externalIdentityId') },
    async (request, reply) => {
      const ctx = requireAuth(request);
      const { externalIdentityId } = request.params as { externalIdentityId: string };
      await deps.identity.revokeExternalIdentity({
        actorAccountId: ctx.accountId,
        externalIdentityId,
        reason: 'revoked',
      });
      reply.code(204);
      return null;
    },
  );

  route(
    'POST',
    '/v1/guardian-relationships',
    'AUTHENTICATED',
    {
      headers: idempotencyHeaders,
      body: obj(
        {
          dependentPersonId: uuid,
          relationshipKind: { enum: ['PARENT', 'LEGAL_GUARDIAN', 'OTHER_RESPONSIBLE_ADULT'] },
        },
        ['dependentPersonId', 'relationshipKind'],
      ),
    },
    async (request, reply) => {
      const ctx = requireAuth(request);
      const body = request.body as { dependentPersonId: string; relationshipKind: 'PARENT' };
      const r = await deps.identity.assertGuardianRelationship({
        actorAccountId: ctx.accountId,
        ...body,
        idempotencyKey: key(request),
      });
      reply.code(201);
      return { ...r, status: 'PENDING' };
    },
  );

  route(
    'DELETE',
    '/v1/guardian-relationships/:guardianRelationshipId',
    'GUARDIAN',
    { params: idParams('guardianRelationshipId') },
    async (request, reply) => {
      const ctx = requireAuth(request);
      const { guardianRelationshipId } = request.params as { guardianRelationshipId: string };
      await deps.identity.revokeGuardianRelationship({
        actorAccountId: ctx.accountId,
        guardianRelationshipId,
        reason: 'revoked by guardian',
      });
      reply.code(204);
      return null;
    },
  );

  // ───────────────────────────── ORG_MEMBER / ORG_ADMIN ─────────────────────────────

  route(
    'GET',
    '/v1/organizations/:organizationId/permissions',
    'AUTHENTICATED',
    { params: idParams('organizationId') },
    async (request) => {
      const ctx = requireAuth(request);
      const { organizationId } = request.params as { organizationId: string };
      return deps.organizations.permissions(ctx.accountId, organizationId);
    },
  );

  route(
    'GET',
    '/v1/organizations/:organizationId/members',
    'ORG_MEMBER',
    { params: idParams('organizationId') },
    async (request) => {
      const ctx = requireAuth(request);
      const { organizationId } = request.params as { organizationId: string };
      const items = await deps.organizations.members({
        actorAccountId: ctx.accountId,
        organizationId,
      });
      // ONCF-02: public athlete identity (PUBLIC/AUTHENTICATED profiles only) to name roster rows.
      const athletes = await deps.identity.visibleAthletesForPersons([
        ...new Set(items.map((m) => m.personId)),
      ]);
      return {
        items: items.map((m) => ({ ...m, athlete: athletes.get(m.personId) ?? null })),
      };
    },
  );

  route(
    'PATCH',
    '/v1/organizations/:organizationId/profile',
    'ORG_ADMIN',
    { params: idParams('organizationId'), body: obj(orgProfileProps) },
    async (request) => {
      const ctx = requireAuth(request);
      const { organizationId } = request.params as { organizationId: string };
      await deps.organizations.updateProfile({
        actorAccountId: ctx.accountId,
        organizationId,
        patch: defined(request.body as Record<string, never>),
      });
      return { organizationId };
    },
  );

  // ONCF-02: change the public page address (old addresses keep redirecting; ORG_EDIT_PROFILE).
  route(
    'PUT',
    '/v1/organizations/:organizationId/slug',
    'ORG_ADMIN',
    {
      params: idParams('organizationId'),
      body: obj({ slug: slugSchema }, ['slug']),
    },
    async (request) => {
      const ctx = requireAuth(request);
      const { organizationId } = request.params as { organizationId: string };
      return deps.organizations.changeSlug({
        actorAccountId: ctx.accountId,
        organizationId,
        slug: (request.body as { slug: string }).slug,
      });
    },
  );

  route(
    'POST',
    '/v1/organizations/:organizationId/invitations',
    'ORG_ADMIN',
    {
      params: idParams('organizationId'),
      headers: idempotencyHeaders,
      body: obj(
        {
          personId: uuid,
          // ONCF-02: or the invitee's athlete profile address (resolved server-side).
          athleteSlug: slugSchema,
          role: { enum: ['OWNER', 'ADMIN', 'MEMBER', 'ATHLETE', 'COACH', 'OFFICIAL', 'STAFF'] },
          visibility: { enum: ['PUBLIC', 'MEMBERS', 'PRIVATE'] },
        },
        ['role', 'visibility'],
      ),
    },
    async (request, reply) => {
      const ctx = requireAuth(request);
      const { organizationId } = request.params as { organizationId: string };
      const body = request.body as {
        personId?: string;
        athleteSlug?: string;
        role: 'MEMBER';
        visibility: 'PUBLIC';
      };
      if ((body.personId === undefined) === (body.athleteSlug === undefined))
        throw new DomainError(
          DomainErrorCode.INVALID_INPUT,
          'exactly one of personId or athleteSlug is required',
        );
      let personId = body.personId;
      if (body.athleteSlug !== undefined) {
        // Permission first, so the address lookup is never an oracle for non-admins.
        const { permissions } = await deps.organizations.permissions(ctx.accountId, organizationId);
        if (!permissions.includes('ORG_INVITE_MEMBER'))
          throw new DomainError(DomainErrorCode.FORBIDDEN, 'not permitted');
        personId = await deps.identity.invitablePersonByAthleteSlug(body.athleteSlug);
        if (personId === undefined)
          throw new DomainError(DomainErrorCode.NOT_FOUND, 'athlete not found');
      }
      const r = await deps.organizations.invite({
        actorAccountId: ctx.accountId,
        organizationId,
        personId: personId!,
        role: body.role,
        visibility: body.visibility,
        idempotencyKey: key(request),
      });
      reply.code(r.token === null ? 200 : 201).header('cache-control', 'no-store');
      // The token is returned exactly once; replays cannot recover it (only its hash is stored).
      return {
        membershipId: r.membershipId,
        invitationId: r.invitationId,
        expiresAt: r.expiresAt.toISOString(),
        token: r.token,
        tokenShownOnce: true,
      };
    },
  );

  route(
    'PUT',
    '/v1/memberships/:membershipId/status',
    'ORG_ADMIN',
    {
      params: idParams('membershipId'),
      body: obj(
        {
          status: { enum: ['ENDED', 'SUSPENDED', 'ACTIVE'] },
          reason: { type: 'string', maxLength: 500 },
        },
        ['status'],
      ),
    },
    async (request) => {
      const ctx = requireAuth(request);
      const { membershipId } = request.params as { membershipId: string };
      const body = request.body as { status: 'ENDED' | 'SUSPENDED' | 'ACTIVE'; reason?: string };
      await deps.organizations.setMembershipStatus(
        defined({
          actorAccountId: ctx.accountId,
          membershipId,
          status: body.status,
          reason: body.reason,
        }),
      );
      return { membershipId, status: body.status };
    },
  );

  route(
    'POST',
    '/v1/memberships/:membershipId/role',
    'ORG_ADMIN',
    {
      params: idParams('membershipId'),
      headers: idempotencyHeaders,
      body: obj(
        { role: { enum: ['OWNER', 'ADMIN', 'MEMBER', 'ATHLETE', 'COACH', 'OFFICIAL', 'STAFF'] } },
        ['role'],
      ),
    },
    async (request) => {
      const ctx = requireAuth(request);
      const { membershipId } = request.params as { membershipId: string };
      return deps.organizations.changeRole({
        actorAccountId: ctx.accountId,
        membershipId,
        role: (request.body as { role: 'MEMBER' }).role,
        idempotencyKey: key(request),
      });
    },
  );

  route(
    'POST',
    '/v1/external-identities/:externalIdentityId/confirm',
    'ORG_ADMIN',
    { params: idParams('externalIdentityId') },
    async (request) => {
      const ctx = requireAuth(request);
      const { externalIdentityId } = request.params as { externalIdentityId: string };
      await deps.identity.confirmExternalIdentity({
        actorAccountId: ctx.accountId,
        externalIdentityId,
      });
      return { externalIdentityId, status: 'CONFIRMED' };
    },
  );

  // ───────────────────────────── INTERNAL (platform operators) ─────────────────────────────

  route(
    'POST',
    '/v1/internal/guardian-relationships/:guardianRelationshipId/confirm',
    'INTERNAL',
    {
      params: idParams('guardianRelationshipId'),
      body: obj(
        { basis: { enum: ['PLATFORM_REVIEW', 'ORGANIZATION_CONFIRMED', 'DEPENDENT_CONFIRMED'] } },
        ['basis'],
      ),
    },
    async (request) => {
      const ctx = operator(request);
      const { guardianRelationshipId } = request.params as { guardianRelationshipId: string };
      await deps.identity.confirmGuardianRelationship({
        operatorAccountId: ctx.accountId,
        guardianRelationshipId,
        basis: (request.body as { basis: 'PLATFORM_REVIEW' }).basis,
      });
      return { guardianRelationshipId, status: 'ACTIVE' };
    },
  );

  route(
    'POST',
    '/v1/internal/accounts/:accountId/disable',
    'INTERNAL',
    {
      params: idParams('accountId'),
      body: obj({ reason: { type: 'string', minLength: 1, maxLength: 500 } }, ['reason']),
    },
    async (request) => {
      const ctx = operator(request);
      const { accountId } = request.params as { accountId: string };
      await deps.identity.disableAccount({
        operatorAccountId: ctx.accountId,
        accountId,
        reason: (request.body as { reason: string }).reason,
      });
      return { accountId, status: 'DISABLED' };
    },
  );

  route(
    'POST',
    '/v1/internal/organizations/:organizationId/status',
    'INTERNAL',
    {
      params: idParams('organizationId'),
      body: obj(
        {
          status: { enum: ['ACTIVE', 'SUSPENDED', 'CLOSED'] },
          reason: { type: 'string', minLength: 1, maxLength: 500 },
        },
        ['status', 'reason'],
      ),
    },
    async (request) => {
      const ctx = operator(request);
      const { organizationId } = request.params as { organizationId: string };
      const body = request.body as { status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED'; reason: string };
      await deps.organizations.setStatus({
        operatorAccountId: ctx.accountId,
        organizationId,
        ...body,
      });
      return { organizationId, status: body.status };
    },
  );

  route(
    'POST',
    '/v1/internal/athletes/:athleteId/resolution',
    'INTERNAL',
    {
      params: idParams('athleteId'),
      body: obj(
        { canonicalAthleteId: uuid, reason: { type: 'string', minLength: 1, maxLength: 500 } },
        ['canonicalAthleteId', 'reason'],
      ),
    },
    async (request) => {
      const ctx = operator(request);
      const { athleteId } = request.params as { athleteId: string };
      const body = request.body as { canonicalAthleteId: string; reason: string };
      await deps.identity.recordIdentityResolution({
        operatorAccountId: ctx.accountId,
        athleteId,
        ...body,
      });
      return { athleteId, canonicalAthleteId: body.canonicalAthleteId };
    },
  );

  if (deps.competition !== undefined)
    registerCompetitionV1({ route, requireAuth, operator, key }, deps.competition);
  if (deps.evidence !== undefined)
    registerEvidenceV1({ route, requireAuth, operator, key }, deps.evidence);
  if (deps.verification !== undefined)
    registerVerificationV1({ route, requireAuth, operator, key }, deps.verification);
  if (deps.achievements !== undefined)
    registerAchievementsV1(
      { route, requireAuth, operator, key },
      { ...deps.achievements, passports: deps.passports },
    );
  if (deps.records !== undefined)
    registerRecordsV1(
      { route, requireAuth, operator, key },
      { ...deps.records, passports: deps.passports },
    );
  if (deps.rankings !== undefined)
    registerRankingsV1({ route, requireAuth, operator, key }, deps.rankings);

  return routes;
}
