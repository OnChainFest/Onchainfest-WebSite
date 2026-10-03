import { DomainError, DomainErrorCode } from '@br/domain';
import type { RankingPublicReader, RankingStaffReader } from '@br/persistence';
import type { FastifyRequest } from 'fastify';
import { idParams, obj, type V1Toolkit } from './v1';

export interface RankingsV1Deps {
  readonly publicReader: RankingPublicReader;
  /** Staff run read (br_ranking_staff_reader) + the authorized classification proposal (br_results). */
  readonly staffReader: RankingStaffReader;
}

const systemRef = {
  type: 'string',
  pattern:
    '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9][a-z0-9-]{1,63})$',
} as const;
// Opaque base64url; the reader also rejects anything that is not exactly an encoded key (400).
const cursor = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,400}$' } as const;
// Query strings are never coerced (server-wide ajv setting): the page size is a bounded digit string.
const limit = { type: 'string', pattern: '^([1-9]|[1-4][0-9]|50)$' } as const;

/**
 * BRT-10 /v1 surface (Step 11).
 *
 *   PUBLIC       ranking systems (list / by id or code), snapshot history (as-published |
 *                as-corrected), a snapshot with read-time staleness, its leaderboard, a `@2`
 *                classification (live statuses only) with read-time staleness and its ranked rows
 *   COMP_STAFF   the read-only canonical classification PROPOSAL of an exact ResultVersion's Result
 *                (closed empty body: no rank, tie, value, participant, policy, input, hash, level,
 *                holder, force or override can be supplied; nothing is written)
 *   INTERNAL     a ranking run card with every candidate's state and blockers (diagnostic; the
 *                SELECT-only br_ranking_staff_reader — never br_rankings)
 *
 * There is NO route that writes a run, snapshot, rank, classification or QUALIFIED Achievement,
 * publishes a ranking, triggers an evaluation or administers a definition.
 */
export function registerRankingsV1(t: V1Toolkit, deps: RankingsV1Deps): void {
  const { route, requireAuth, operator } = t;
  // Built at registration: `obj` comes from ./v1, which imports this module (load-order cycle).
  const page = obj({ cursor, limit });
  const params = <T>(request: FastifyRequest) => request.params as T;
  const pageOf = (request: FastifyRequest) => {
    const q = request.query as { cursor?: string; limit?: string };
    return {
      ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
      ...(q.limit === undefined ? {} : { limit: Number(q.limit) }),
    };
  };
  const found = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) throw new DomainError(DomainErrorCode.NOT_FOUND, `${what} not found`);
    return value;
  };

  // ───────────────────────────── PUBLIC ─────────────────────────────

  route('GET', '/v1/ranking-systems', 'PUBLIC', { querystring: page }, async (request) =>
    deps.publicReader.systems(pageOf(request)),
  );

  route(
    'GET',
    '/v1/ranking-systems/:system',
    'PUBLIC',
    { params: obj({ system: systemRef }, ['system']) },
    async (request) =>
      found(
        await deps.publicReader.system(params<{ system: string }>(request).system),
        'ranking system',
      ),
  );

  route(
    'GET',
    '/v1/ranking-systems/:system/snapshots',
    'PUBLIC',
    {
      params: obj({ system: systemRef }, ['system']),
      querystring: obj({ view: { enum: ['as-published', 'as-corrected'] }, cursor, limit }),
    },
    async (request) => {
      const q = request.query as { view?: 'as-published' | 'as-corrected' };
      return found(
        await deps.publicReader.history(
          params<{ system: string }>(request).system,
          q.view ?? 'as-published',
          pageOf(request),
        ),
        'ranking system',
      );
    },
  );

  route(
    'GET',
    '/v1/ranking-snapshots/:snapshotId',
    'PUBLIC',
    { params: idParams('snapshotId') },
    async (request) =>
      found(
        await deps.publicReader.snapshot(params<{ snapshotId: string }>(request).snapshotId),
        'ranking snapshot',
      ),
  );

  route(
    'GET',
    '/v1/ranking-snapshots/:snapshotId/leaderboard',
    'PUBLIC',
    { params: idParams('snapshotId'), querystring: page },
    async (request) =>
      found(
        await deps.publicReader.leaderboard(
          params<{ snapshotId: string }>(request).snapshotId,
          pageOf(request),
        ),
        'ranking snapshot',
      ),
  );

  route(
    'GET',
    '/v1/result-versions/:resultVersionId/classification',
    'PUBLIC',
    { params: idParams('resultVersionId') },
    async (request) =>
      found(
        await deps.publicReader.classification(
          params<{ resultVersionId: string }>(request).resultVersionId,
        ),
        'classification',
      ),
  );

  route(
    'GET',
    '/v1/result-versions/:resultVersionId/classification/entries',
    'PUBLIC',
    { params: idParams('resultVersionId'), querystring: page },
    async (request) =>
      found(
        await deps.publicReader.classificationEntries(
          params<{ resultVersionId: string }>(request).resultVersionId,
          pageOf(request),
        ),
        'classification',
      ),
  );

  // ───────────────────────────── COMP_STAFF ─────────────────────────────

  route(
    'POST',
    '/v1/result-versions/:resultVersionId/classification-proposals',
    'COMP_STAFF',
    // Closed body: ranks / ties / values / participants / policy / inputs / hashes / level / holder /
    // force / override are rejected by schema — the canonical assembly decides everything.
    { params: idParams('resultVersionId'), body: obj({}) },
    async (request) =>
      deps.staffReader.proposeClassification({
        actor: { accountId: requireAuth(request).accountId },
        resultVersionId: params<{ resultVersionId: string }>(request).resultVersionId,
      }),
  );

  // ───────────────────────────── INTERNAL ─────────────────────────────

  route(
    'GET',
    '/v1/internal/ranking-runs/:runId',
    'INTERNAL',
    { params: idParams('runId') },
    async (request, reply) => {
      operator(request);
      reply.header('cache-control', 'no-store');
      return found(
        await deps.staffReader.run(params<{ runId: string }>(request).runId),
        'ranking run',
      );
    },
  );
}
