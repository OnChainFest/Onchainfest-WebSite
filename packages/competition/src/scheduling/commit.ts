import type { ContentHash } from '@br/canonical';
import type { DomainErrorCode } from '@br/domain';
import {
  PROPOSAL_BUDGET,
  proposeScheduleWithBudget,
  ScheduleProposalError,
  type ProposalBudget,
  type ProposalPlacement,
  type ProposalStatus,
  type ScheduleProposalInput,
} from './proposal';

/**
 * ONCF-05E-F-1: the proposal COMMIT decision (ADR-0075 § 16–17, ADR-0076), as the pure function
 *
 *     planProposalCommit(input, request) → ProposalCommitResult
 *
 * `input` is the authoritative proposal input the server loads (the same loader as the preview),
 * `request` carries only the presented proposal hash. The proposal is RECOMPUTED here with the same
 * engine; the presented hash is a claim compared against it, never data. In order (ADR-0076 C5–C6):
 *
 *   1. closed competition / not the open draft    → COMPETITION_CLOSED / NOT_A_DRAFT
 *   2. recompute (engine refusal)                 → INVALID_INPUT
 *   3. recomputed hash ≠ presented                → PROPOSAL_STALE            (wins over 4)
 *   4. recomputed status ≠ SUCCESS                → PROPOSAL_NOT_COMMITTABLE  (no partial commit)
 *   5. otherwise                                  → the commit plan of the recomputed placements
 *
 * Nothing is written, locked, audited or emitted: the persistence transaction (05E-F-2) authorizes
 * (`COMP_MANAGE_SCHEDULE`; FORBIDDEN / NOT_FOUND stay its existing refusals), loads under the
 * competition-schedule lock, calls this, and applies the plan through the per-fact write path. No
 * database, clock, randomness or I/O; the rule reads `status` only and never branches on a sport.
 */

/** The only client-supplied commit value. Placements, status, scope identity: never accepted here. */
export interface ProposalCommitRequest {
  readonly proposalHash: string;
}

/**
 * One fact to append to the open draft (ADR-0075 § 17: `MANUAL`, unlocked, by the committing human
 * with the plan's `reason`). Values are the recomputed placement's, in epoch seconds. `unitKey` and
 * `provisional` are derived again by the write path; they are carried for its equality assertion
 * (ONCF-05E-F architecture § 10), never written in place of the derived value.
 */
export type ProposalCommitFact = Omit<ProposalPlacement, 'softConflictKeys'>;

/** Everything the persistence transaction needs to apply and record one commit. */
export interface ProposalCommitPlan {
  readonly competitionId: string;
  readonly scheduleVersionId: string;
  readonly proposalHash: ContentHash;
  readonly baseStateIdentity: ContentHash;
  readonly strategy: { readonly id: string; readonly version: number };
  readonly budget: ProposalBudget;
  /** The recomputed proposal's final report hash (synthetic ids; never presented to publish). */
  readonly reportHash: ContentHash;
  /** ADR-0075 § 17: the deterministic provenance reason of every fact. */
  readonly reason: string;
  /** Sorted by contest id; exactly the recomputed placements. */
  readonly facts: readonly ProposalCommitFact[];
  readonly placedUnits: number;
  readonly placedContests: number;
  /** Units in scope reported unplaced that were never targets (NO_PROFILE, PARTIALLY_PLACED, …). */
  readonly unplacedUnits: number;
}

/** Each refusal names the existing domain error it maps to (ONCF-05E-F architecture § 23). */
export type ProposalCommitRefusal =
  | {
      readonly reason: 'PROPOSAL_STALE';
      readonly code: Extract<DomainErrorCode, 'CONCURRENCY_CONFLICT'>;
    }
  | {
      readonly reason: 'PROPOSAL_NOT_COMMITTABLE';
      readonly code: Extract<DomainErrorCode, 'INVALID_TRANSITION'>;
      readonly status: Exclude<ProposalStatus, 'SUCCESS'>;
    }
  | {
      readonly reason: 'NOT_A_DRAFT' | 'COMPETITION_CLOSED';
      readonly code: Extract<DomainErrorCode, 'INVALID_TRANSITION'>;
      readonly status: string;
    }
  | {
      readonly reason: 'INVALID_INPUT';
      readonly code: Extract<DomainErrorCode, 'INVALID_INPUT'>;
      readonly message: string;
    };

export type ProposalCommitResult =
  | { readonly ok: true; readonly plan: ProposalCommitPlan }
  | { readonly ok: false; readonly refusal: ProposalCommitRefusal };

const CLOSED_COMPETITION = new Set(['COMPLETED', 'CANCELLED']);

/** ADR-0076 C1: only SUCCESS. A status added later is not committable unless its ADR says so. */
const COMMITTABLE: ReadonlySet<ProposalStatus> = new Set<ProposalStatus>(['SUCCESS']);

const refused = (refusal: ProposalCommitRefusal): ProposalCommitResult => ({ ok: false, refusal });

/** ADR-0075 § 16, ADR-0076: decide a commit against the server's own recomputation. */
export function planProposalCommit(
  input: ScheduleProposalInput,
  request: ProposalCommitRequest,
): ProposalCommitResult {
  return planProposalCommitWithBudget(input, request, PROPOSAL_BUDGET);
}

/**
 * Test seam (not exported by the package), as `proposeScheduleWithBudget`: the same decision under
 * an explicit engine budget, so budget-bound statuses can be reached cheaply.
 */
export function planProposalCommitWithBudget(
  input: ScheduleProposalInput,
  request: ProposalCommitRequest,
  budget: ProposalBudget,
): ProposalCommitResult {
  // The draft and competition state, typed here rather than as the engine's INCOMPLETE_STATE.
  if (CLOSED_COMPETITION.has(input.competitionStatus))
    return refused({
      reason: 'COMPETITION_CLOSED',
      code: 'INVALID_TRANSITION',
      status: input.competitionStatus,
    });
  if (input.draftStatus !== 'DRAFT')
    return refused({
      reason: 'NOT_A_DRAFT',
      code: 'INVALID_TRANSITION',
      status: input.draftStatus,
    });

  let proposal;
  try {
    proposal = proposeScheduleWithBudget(input, budget);
  } catch (e) {
    if (e instanceof ScheduleProposalError && e.code === 'INVALID_INPUT')
      return refused({ reason: 'INVALID_INPUT', code: 'INVALID_INPUT', message: e.message });
    throw e;
  }

  // ADR-0076 C5: the hash comparison runs first; stale wins whatever the recomputed status.
  if (proposal.proposalHash !== request.proposalHash)
    return refused({ reason: 'PROPOSAL_STALE', code: 'CONCURRENCY_CONFLICT' });
  if (!COMMITTABLE.has(proposal.status))
    return refused({
      reason: 'PROPOSAL_NOT_COMMITTABLE',
      code: 'INVALID_TRANSITION',
      status: proposal.status as Exclude<ProposalStatus, 'SUCCESS'>,
    });

  // ADR-0075 § 7: additive only. The engine never targets a contest with a live assignment; a
  // placement that would overwrite one is an internal invariant failure, never a commit.
  const live = new Set(input.judge.assignments.map((a) => a.contestId));
  const facts = proposal.placements.map((p): ProposalCommitFact => {
    if (live.has(p.contestId))
      throw new Error(`proposal invariant: contest ${p.contestId} already has an assignment`);
    return {
      contestId: p.contestId,
      unitKey: p.unitKey,
      resourceId: p.resourceId,
      start: p.start,
      expectedEnd: p.expectedEnd,
      changeoverSeconds: p.changeoverSeconds,
      zone: p.zone,
      provisional: p.provisional,
    };
  });

  return {
    ok: true,
    plan: {
      competitionId: input.judge.competitionId,
      scheduleVersionId: input.judge.scheduleVersionId,
      proposalHash: proposal.proposalHash,
      baseStateIdentity: proposal.baseStateIdentity,
      strategy: proposal.strategy,
      budget: proposal.budget,
      reportHash: proposal.report.reportHash,
      reason: `proposal ${proposal.proposalHash}`,
      facts,
      placedUnits: proposal.metrics.placedUnits,
      placedContests: proposal.metrics.placedContests,
      unplacedUnits: proposal.metrics.unplacedUnits,
    },
  };
}
