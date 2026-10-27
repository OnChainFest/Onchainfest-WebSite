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
import { competitionPermissions, loadCompetition } from './competition-support';
import type { Db } from './db';
import { loadControlFacts, lockKeys, lockKeysShared } from './identity-support';
import {
  bindingFrom,
  bindingHolds,
  grantEligibilityBindings,
  RESULT_AUTHORITY_STAFF_ROLES,
  resultEligibilitySnapshot,
  resultStaffEligibilityKeys,
} from './result-authority';
import { ResultLedger, type ResultActorGate, type ResultScopeValidator } from './result-ledger';
import { inTransaction, ModuleRole, withModuleRole, type TxContext } from './tx';

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

/** WP-P0-1: the match states in which a result can be submitted, accepted, declared or corrected. */
const PLAYED_CONTEST: ReadonlySet<string> = new Set(['IN_PROGRESS', 'COMPLETED']);
const NOT_PLAYABLE_MESSAGE: Readonly<Record<string, string>> = {
  PLANNED: 'the match has not started; a result needs a match in progress or completed',
  SCHEDULED: 'the match has not started; a result needs a match in progress or completed',
  CANCELLED: 'the match was cancelled; it decides no result',
  VOID: 'the match was voided; it decides no result',
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
  /**
   * ONCF-L6 (ADR-0078 §2.2): a CONTEST result is frozen once its event is COMPLETED or CANCELLED.
   * The contest's lifecycle lock (`contest:<id>`, the one category completion holds for every
   * contest while it validates) is taken first, then the event status is read as br_competition
   * (`withModuleRole`; the login holds SET on both roles, no grant is widened). Classification
   * scopes are not frozen: deriving from a finished event stays legitimate (V2).
   */
  async assertMutable(ctx, scopeType, scopeTargetId, operation) {
    if (scopeType !== 'CONTEST') return;
    const path = await resolveHierarchy(ctx, 'CONTEST', scopeTargetId);
    if (path?.eventId === undefined)
      throw new DomainError(
        DomainErrorCode.NOT_FOUND,
        'result scope target does not exist in the competition hierarchy',
      );
    const eventId = path.eventId;
    await lockKeys(ctx, `contest:${scopeTargetId}`);
    const { status, contestStatus } = await withModuleRole(
      ctx,
      ModuleRole.competition,
      async (cctx) => {
        const { rows } = await sql<{ status: string; contest_status: string | null }>`
          SELECT e.status, (SELECT c.status FROM competition.v_contest_current c
                            WHERE c.contest_id = ${scopeTargetId}) AS contest_status
          FROM competition.v_event_current e WHERE e.event_id = ${eventId}`.execute(cctx.trx);
        return { status: rows[0]?.status, contestStatus: rows[0]?.contest_status ?? undefined };
      },
    );
    if (status === 'COMPLETED' || status === 'CANCELLED')
      throw new DomainError(
        DomainErrorCode.INVALID_TRANSITION,
        'the event is finished; its results are frozen',
        { reason: 'RESULTS_FROZEN', eventStatus: status },
      );
    // WP-P0-1 (D-14): only a match being or having been played decides a result. Read under the
    // same `contest:<id>` lock that start / complete / cancel / void hold, so a lifecycle change
    // and a result write never interleave. Rejecting a pending candidate decides nothing and stays
    // possible (clean-up of a cancelled or voided match).
    if (
      operation !== undefined &&
      operation !== 'REJECT' &&
      !PLAYED_CONTEST.has(contestStatus ?? '')
    )
      throw new DomainError(
        DomainErrorCode.INVALID_TRANSITION,
        NOT_PLAYABLE_MESSAGE[contestStatus ?? ''] ?? 'the match cannot take a result',
        { reason: 'CONTEST_NOT_PLAYABLE', contestStatus: contestStatus ?? 'UNKNOWN' },
      );
  },

  /**
   * WP-P0-1 (D-14): a classification pins only results of matches in progress or completed. The
   * statuses are read under the inputs' `contest:<id>` locks (one call, key order, taken last), so
   * no lifecycle change interleaves with the pinning.
   */
  async assertInputsPlayed(ctx, contestIds) {
    if (contestIds.length === 0) return;
    await lockKeys(ctx, ...contestIds.map((id) => `contest:${id}`));
    const unplayed = await withModuleRole(ctx, ModuleRole.competition, async (cctx) => {
      const { rows } = await sql<{ status: string }>`
        SELECT status FROM competition.v_contest_current
        WHERE contest_id = ANY(${[...contestIds]}::uuid[]) ORDER BY contest_id`.execute(cctx.trx);
      return rows.find((r) => !PLAYED_CONTEST.has(r.status));
    });
    if (unplayed !== undefined)
      throw new DomainError(
        DomainErrorCode.INVALID_TRANSITION,
        'a classification input is the result of a match not in progress or completed',
        { reason: 'CONTEST_NOT_PLAYABLE', contestStatus: unplayed.status },
      );
  },
};

/**
 * WP-P0-3 (D-16, ADR-0079): the result-staff gate for one acting account. Result authority needs
 * the grant AND, at the moment of the write, an OWNER or ADMIN role of the target's competition —
 * the ADR-0077 §2.3 issuance predicate (`competitionPermissions`: explicit staff, or OWNER / ADMIN
 * of the ACTIVE organizer organization, for an ACTIVE account with a SELF person). The facts are
 * read after taking, SHARED, the keys every command that changes them takes exclusively: the
 * account (disable), the person's staff assignments in this competition (assign / end), the
 * organizer's roster (membership role and status) and the organization (status). A demotion that
 * committed first is observed; one that comes later waits for this write. It runs after
 * `contest:<id>` (assertMutable) and before the result stream head; no holder of these keys takes
 * a contest or result lock, so the order cannot invert. Anything unreadable fails closed.
 */
export function competitionResultStaffGate(accountId: string): ResultActorGate {
  const refuse = () =>
    new DomainError(
      DomainErrorCode.AUTHORITY_DENIED,
      'acting on results needs a current OWNER or ADMIN role in this competition',
      { reason: 'NOT_RESULT_STAFF' },
    );
  const stale = () =>
    new DomainError(
      DomainErrorCode.AUTHORITY_DENIED,
      'the result grant is not bound to the current OWNER or ADMIN eligibility; a fresh operator grant is required',
      { reason: 'GRANT_ELIGIBILITY_STALE' },
    );
  return {
    async assertActor(ctx, scopeType, scopeTargetId) {
      const path = await resolveHierarchy(ctx, LEVEL_OF[scopeType], scopeTargetId);
      if (path === undefined) throw refuse();
      const cleared = await withModuleRole(ctx, ModuleRole.competition, async (cctx) => {
        const competition = await loadCompetition(cctx, path.competitionId);
        const person = (await loadControlFacts(cctx, accountId)).selfPersonId;
        if (person === undefined) throw refuse();
        await lockKeysShared(cctx, ...resultStaffEligibilityKeys(accountId, competition, person));
        // Read again under the locks (READ COMMITTED: each statement sees the latest commit).
        if ((await loadControlFacts(cctx, accountId)).selfPersonId !== person) throw refuse();
        const { staffRoles } = await competitionPermissions(cctx, accountId, competition);
        if (
          !staffRoles.some((r) => (RESULT_AUTHORITY_STAFF_ROLES as readonly string[]).includes(r))
        )
          throw refuse();
        // Q3 (ADR-0079 §2.3): the eligibility facts, held unchanged until this transaction ends.
        const snapshot = await resultEligibilitySnapshot(cctx, accountId, competition, person);
        if (bindingFrom(snapshot) === undefined) throw refuse(); // fail closed: histories disagree
        return { competitionId: competition.id, person, snapshot };
      });
      return {
        async assertAuthorizedBy(actx, decision) {
          // The engine authorized by an ADR-0077 grant (a root grant: they cannot be delegated)
          // bound at issuance to this account's eligibility in this competition, and that binding
          // still holds. Anything else — another origin, no binding, a basis lost since — refuses:
          // a grant held across a loss of eligibility does not come back with a re-promotion.
          const leaf = decision.grantChain[0]?.grantId;
          if (leaf === undefined || decision.grantChain.length !== 1) throw stale();
          const { rows } = await sql<{ root: boolean }>`
            SELECT parent_grant_id IS NULL AS root FROM authority.authority_grant WHERE id = ${leaf}`.execute(
            actx.trx,
          );
          if (rows[0]?.root !== true) throw stale();
          const b = (
            await withModuleRole(actx, ModuleRole.competition, (cctx) =>
              grantEligibilityBindings(cctx, [leaf]),
            )
          ).get(leaf);
          if (
            b === undefined ||
            b.competitionId !== cleared.competitionId ||
            b.accountId !== accountId ||
            b.personId !== cleared.person ||
            !bindingHolds(b, cleared.snapshot)
          )
            throw stale();
        },
      };
    },
  };
}

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
  options: {
    conflictChecker?: ConflictOfInterestChecker;
    /**
     * WP-P0-3: the account a command acts for. Every application result command passes it (the
     * API composition, ContestResultService), which wires the result-staff gate. Demos, seeds and
     * ledger tests with fixture principals have no account and do not.
     */
    actorAccountId?: string;
  } = {},
): ResultLedger {
  const { actorAccountId, ...rest } = options;
  return new ResultLedger(db, {
    ...rest,
    scopeValidator: competitionResultScopeValidator,
    ...(actorAccountId === undefined
      ? {}
      : { actorGate: competitionResultStaffGate(actorAccountId) }),
  });
}
