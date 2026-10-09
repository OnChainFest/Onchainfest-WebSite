import type { AuthorizationDecision, ConflictOfInterestChecker } from '@br/authority';
import {
  pathToScope,
  scopeMatchesPath,
  type HierarchyLevel,
  type HierarchyPath,
} from '@br/competition';
import {
  DomainError,
  DomainErrorCode,
  type AuthorityScope,
  type Capability,
  type Instant,
  type RecognitionLevel,
  type ResultScopeType,
  type Uuid,
} from '@br/domain';
import { sql } from 'kysely';
import { authorizeIn } from './authority-store';
import type { Db } from './db';
import { ResultLedger, type ResultScopeValidator } from './result-ledger';
import { inTransaction, ModuleRole, type TxContext } from './tx';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Resolves a competition / event / round / contest to its full hierarchy path using database
 * relationships (`competition.resolve_scope_path`, SECURITY DEFINER; executable by the
 * competition, authority and results roles). Unknown or malformed ids resolve to `undefined` —
 * callers fail closed. Ancestry is immutable, so cancelled entities keep their historical path.
 */
export async function resolveHierarchy(
  ctx: TxContext,
  level: HierarchyLevel,
  id: string,
): Promise<HierarchyPath | undefined> {
  if (!UUID.test(id)) return undefined;
  const { rows } = await sql<{ path: HierarchyPath | null }>`
    SELECT competition.resolve_scope_path(${level}, ${id}::uuid) AS path`.execute(ctx.trx);
  return rows[0]?.path ?? undefined;
}

/** Stand-alone resolver (own transaction under the given role). */
export class CompetitionHierarchyResolver {
  private readonly db: Db;
  private readonly role: ModuleRole;

  constructor(db: Db, role: ModuleRole = ModuleRole.competition) {
    this.db = db;
    this.role = role;
  }

  resolve(level: HierarchyLevel, id: string): Promise<HierarchyPath | undefined> {
    return inTransaction(this.db, this.role, (ctx) => resolveHierarchy(ctx, level, id));
  }

  async scopeOf(
    level: HierarchyLevel,
    id: string,
    extra: { recognitionLevel?: RecognitionLevel } = {},
  ): Promise<AuthorityScope> {
    const path = await this.resolve(level, id);
    if (path === undefined)
      throw new DomainError(
        DomainErrorCode.NOT_FOUND,
        'target not found in the competition hierarchy',
      );
    return pathToScope(path, extra);
  }
}

export interface HierarchyAuthorizeInput {
  readonly principalId: Uuid;
  readonly capability: Capability;
  readonly target: { readonly level: HierarchyLevel; readonly id: string };
  /** Not a structural fact: supplied explicitly when the grant chain constrains it. */
  readonly recognitionLevel?: RecognitionLevel;
  readonly atTime: Instant;
  readonly asOf: Instant;
}

/**
 * Authority check against a competition target: resolves the target's full path inside the same
 * transaction and evaluates the grant chain against it (exact BRT-03 scope semantics; no implicit
 * ancestry). An unresolvable target is denied as NOT_FOUND.
 */
export async function authorizeInHierarchy(
  ctx: TxContext,
  input: HierarchyAuthorizeInput,
  conflictChecker?: ConflictOfInterestChecker,
): Promise<AuthorizationDecision & { readonly scope: AuthorityScope }> {
  const path = await resolveHierarchy(ctx, input.target.level, input.target.id);
  if (path === undefined)
    throw new DomainError(
      DomainErrorCode.NOT_FOUND,
      'target not found in the competition hierarchy',
    );
  const scope = pathToScope(
    path,
    input.recognitionLevel === undefined ? {} : { recognitionLevel: input.recognitionLevel },
  );
  const decision = await authorizeIn(
    ctx,
    {
      principalId: input.principalId,
      capability: input.capability,
      scope,
      atTime: input.atTime,
      asOf: input.asOf,
    },
    conflictChecker,
  );
  return { ...decision, scope };
}

const LEVEL_OF: Readonly<Record<ResultScopeType, HierarchyLevel>> = {
  CONTEST: 'CONTEST',
  ROUND_CLASSIFICATION: 'ROUND',
  EVENT_CLASSIFICATION: 'EVENT',
  COMPETITION_CLASSIFICATION: 'COMPETITION',
};

/**
 * Result ↔ competition linkage (BRT-05 §44). Contest becomes a legitimate Result scope: the
 * target must exist, and any authority scope used on that Result must state exactly its resolved
 * hierarchy. Creating a Contest never creates a Result, and nothing here accepts or verifies one.
 */
export const competitionResultScopeValidator: ResultScopeValidator = {
  async assertTarget(ctx, scopeType, scopeTargetId) {
    if ((await resolveHierarchy(ctx, LEVEL_OF[scopeType], scopeTargetId)) === undefined) {
      throw new DomainError(
        DomainErrorCode.NOT_FOUND,
        'result scope target does not exist in the competition hierarchy',
      );
    }
  },
  async assertScope(ctx, scopeType, scopeTargetId, scope) {
    const path = await resolveHierarchy(ctx, LEVEL_OF[scopeType], scopeTargetId);
    if (path === undefined)
      throw new DomainError(
        DomainErrorCode.NOT_FOUND,
        'result scope target does not exist in the competition hierarchy',
      );
    if (!scopeMatchesPath(scope, path)) {
      throw new DomainError(
        DomainErrorCode.AUTHORITY_DENIED,
        'authority scope does not match the result target hierarchy',
        {
          reason: 'SCOPE_HIERARCHY_MISMATCH',
        },
      );
    }
  },
};

/**
 * BRT-05R guardrail — THE composition for competition-scoped Result operations.
 *
 * Any BRT-06+ application composition that exposes Result operations scoped to a COMPETITION,
 * EVENT, ROUND or CONTEST MUST construct its ledger with this factory, never `new ResultLedger`
 * directly: the factory always wires `competitionResultScopeValidator`, so a route cannot bypass
 * hierarchy validation by accident. `tooling/check-result-ledger-composition.mjs` (run by
 * `pnpm lint`) rejects direct `new ResultLedger(` in application code.
 */
export function createCompetitionResultLedger(
  db: Db,
  options: { conflictChecker?: ConflictOfInterestChecker } = {},
): ResultLedger {
  return new ResultLedger(db, { ...options, scopeValidator: competitionResultScopeValidator });
}
