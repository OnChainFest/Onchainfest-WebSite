import type { AuthorizationDecision, ConflictOfInterestChecker } from '@br/authority';
import {
  Capability,
  DomainError,
  DomainErrorCode,
  findTransition,
  newId,
  type AuthorityScope,
  type Result,
  type ResultScopeType,
  type ResultVersionContent,
  type ResultVersionStatus,
  type Uuid,
} from '@br/domain';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';
import { authorizeIn } from './authority-store';
import type { Db, LedgerEntryTable, ResultVersionTable } from './db';
import { factHash } from './hashing';
import { checkIdempotency, recordIdempotency, type IdempotencySpec } from './idempotency';
import { openStream, StreamType } from './ledger';
import { emitEvent } from './outbox';
import { inTransaction, ModuleRole, type TxContext } from './tx';

export const RESULT_CONTENT_SCHEMA = `${SchemaRef.resultVersionContent.id}@${SchemaRef.resultVersionContent.version}`;

export interface CanonicalContent {
  readonly normalized: ResultVersionContent;
  readonly canonicalText: string;
  readonly contentHash: string;
}

/** ResultVersion content hash via @br/canonical (BR-JSON v1, domain tag result-version-content). */
export function hashResultContent(content: unknown): CanonicalContent {
  const r = platformCanonicalizer().hashCanonical(
    DomainTag.resultVersionContent,
    SchemaRef.resultVersionContent.id,
    SchemaRef.resultVersionContent.version,
    content,
  );
  return {
    normalized: r.normalized as unknown as ResultVersionContent,
    canonicalText: r.canonicalText,
    contentHash: r.contentHash,
  };
}

export interface SubmitOutcome {
  readonly resultVersionId: Uuid;
  readonly versionNumber: number;
  readonly contentHash: string;
  readonly status: ResultVersionStatus;
  /** False when the same content had already been submitted (no new ledger consequence). */
  readonly created: boolean;
  readonly ledgerEntries: readonly LedgerEntryTable[];
  readonly authorizationProofDigest: string;
}

export interface TransitionOutcome {
  readonly resultVersionId: Uuid;
  readonly status: ResultVersionStatus;
  readonly transitionId: Uuid;
  readonly created: boolean;
  readonly ledgerEntries: readonly LedgerEntryTable[];
  readonly authorizationProofDigest: string;
}

export interface SubmitInput {
  readonly draftId: Uuid;
  readonly actorPrincipalId: Uuid;
  /** Resolved authority scope path of the contest this result belongs to. */
  readonly scope: AuthorityScope;
  readonly idempotencyKey: string;
}

export interface TransitionInput {
  readonly resultVersionId: Uuid;
  readonly toStatus: 'PROVISIONAL' | 'REJECTED';
  readonly actorPrincipalId: Uuid;
  readonly scope: AuthorityScope;
  readonly idempotencyKey: string;
  readonly reason?: string;
}

function denied(decision: AuthorizationDecision): DomainError {
  return new DomainError(DomainErrorCode.AUTHORITY_DENIED, `authority denied: ${decision.reason}`, {
    reason: decision.reason,
    proofDigest: decision.proofDigest,
  });
}

/**
 * Optional scope-target validation (BRT-05). When configured, a Result's scope target must exist
 * in the competition hierarchy, and every authority check on it must use exactly the target's
 * resolved hierarchy path (a caller cannot claim a different competition/event to borrow a grant).
 * Implemented by the competition context (`competitionResultScopeValidator`); the BRT-03 ledger
 * without a validator keeps its previous behaviour.
 */
export interface ResultScopeValidator {
  assertTarget(ctx: TxContext, scopeType: ResultScopeType, scopeTargetId: string): Promise<void>;
  assertScope(
    ctx: TxContext,
    scopeType: ResultScopeType,
    scopeTargetId: string,
    scope: AuthorityScope,
  ): Promise<void>;
}

/**
 * Result ledger (BRT-01 result domain §6–7; BRT-02 persistence §4.1, §5.4).
 * Every command runs in one transaction under the br_results role: ledger facts, class B
 * projections, outbox events and the idempotency record commit atomically.
 */
export class ResultLedger {
  private readonly db: Db;
  private readonly conflictChecker: ConflictOfInterestChecker | undefined;
  private readonly scopeValidator: ResultScopeValidator | undefined;

  /**
   * `scopeValidator` is optional only for BRT-03 backward compatibility (tests/demos with bare
   * scope targets). Application compositions exposing competition-scoped Result operations must
   * use `createCompetitionResultLedger` (competition-hierarchy.ts), which always wires it; `pnpm
   * lint` rejects a bare `new ResultLedger(` in application code.
   */
  constructor(
    db: Db,
    options: {
      conflictChecker?: ConflictOfInterestChecker;
      scopeValidator?: ResultScopeValidator;
    } = {},
  ) {
    this.db = db;
    this.conflictChecker = options.conflictChecker;
    this.scopeValidator = options.scopeValidator;
  }

  private async assertResultScope(
    ctx: TxContext,
    resultId: string,
    scope: AuthorityScope,
  ): Promise<void> {
    if (this.scopeValidator === undefined) return;
    const r = await ctx.trx
      .selectFrom('results.result')
      .select(['scope_type', 'scope_target_id'])
      .where('id', '=', resultId)
      .executeTakeFirst();
    if (r === undefined) throw new DomainError(DomainErrorCode.NOT_FOUND, 'result not found');
    await this.scopeValidator.assertScope(
      ctx,
      r.scope_type as ResultScopeType,
      r.scope_target_id,
      scope,
    );
  }

  /** Creates the stable Result identity for a scope target (idempotent per target). */
  createResult(input: { scopeType: ResultScopeType; scopeTargetId: Uuid }): Promise<Result> {
    return inTransaction(this.db, ModuleRole.results, async (ctx) => {
      await this.scopeValidator?.assertTarget(ctx, input.scopeType, input.scopeTargetId);
      const existing = await ctx.trx
        .selectFrom('results.result')
        .selectAll()
        .where('scope_type', '=', input.scopeType)
        .where('scope_target_id', '=', input.scopeTargetId)
        .executeTakeFirst();
      if (existing !== undefined) {
        return {
          id: existing.id as Uuid,
          scopeType: input.scopeType,
          scopeTargetId: input.scopeTargetId,
          recordedAt: existing.recorded_at,
        };
      }
      const id = newId();
      const hash = factHash(SchemaRef.result, {
        resultId: id,
        scopeType: input.scopeType,
        scopeTargetId: input.scopeTargetId,
      });
      await ctx.trx
        .insertInto('results.result')
        .values({
          id,
          scope_type: input.scopeType,
          scope_target_id: input.scopeTargetId,
          fact_hash: hash,
          recorded_at: ctx.txTime,
        })
        .execute();
      const stream = await openStream(ctx, id, StreamType.RESULT);
      await stream.append({
        eventType: 'RESULT_CREATED',
        factTable: 'results.result',
        factRowId: id,
        payloadHash: hash,
      });
      await stream.close();
      await ctx.trx
        .insertInto('results.result_state')
        .values({
          result_id: id,
          current_version_id: null,
          latest_version_number: 0,
          updated_at: ctx.txTime,
        })
        .execute();
      await emitEvent(ctx, {
        eventType: 'ResultCreated',
        aggregateType: 'RESULT',
        aggregateId: id,
        payload: { scopeType: input.scopeType, scopeTargetId: input.scopeTargetId },
      });
      return {
        id,
        scopeType: input.scopeType,
        scopeTargetId: input.scopeTargetId,
        recordedAt: ctx.txTime,
      };
    });
  }

  /** DRAFT: mutable, not visible, not attestable. Content is validated early for feedback. */
  saveDraft(input: {
    resultId: Uuid;
    authorPrincipalId: Uuid;
    disciplineVersionRef: string;
    content: unknown;
  }): Promise<{ draftId: Uuid }> {
    hashResultContent(input.content);
    return inTransaction(this.db, ModuleRole.results, async (ctx) => {
      const draftId = newId();
      await ctx.trx
        .insertInto('results.result_draft')
        .values({
          id: draftId,
          result_id: input.resultId,
          author_principal_id: input.authorPrincipalId,
          discipline_version_ref: input.disciplineVersionRef,
          content: JSON.stringify(input.content),
          submitted_version_id: null,
          updated_at: ctx.txTime,
        })
        .execute();
      return { draftId };
    });
  }

  updateDraft(input: { draftId: Uuid; content: unknown }): Promise<void> {
    hashResultContent(input.content);
    return inTransaction(this.db, ModuleRole.results, async (ctx) => {
      const draft = await ctx.trx
        .selectFrom('results.result_draft')
        .selectAll()
        .where('id', '=', input.draftId)
        .forUpdate()
        .executeTakeFirst();
      if (draft === undefined) throw new DomainError(DomainErrorCode.NOT_FOUND, 'draft not found');
      if (draft.submitted_version_id !== null) {
        throw new DomainError(
          DomainErrorCode.IMMUTABLE,
          'draft was submitted; a change requires a new draft and a new ResultVersion',
        );
      }
      await ctx.trx
        .updateTable('results.result_draft')
        .set({ content: JSON.stringify(input.content), updated_at: ctx.txTime })
        .where('id', '=', input.draftId)
        .execute();
    });
  }

  /** T2 DRAFT → SUBMITTED: freezes content into an immutable, content-hashed ResultVersion. */
  submitDraft(input: SubmitInput): Promise<SubmitOutcome> {
    return inTransaction(this.db, ModuleRole.results, async (ctx) => {
      const draft = await ctx.trx
        .selectFrom('results.result_draft')
        .selectAll()
        .where('id', '=', input.draftId)
        .forUpdate()
        .executeTakeFirst();
      if (draft === undefined) throw new DomainError(DomainErrorCode.NOT_FOUND, 'draft not found');
      const content = hashResultContent(draft.content);
      const idem: IdempotencySpec = {
        scope: input.actorPrincipalId,
        key: input.idempotencyKey,
        commandType: 'SubmitResultVersion',
        requestSchema: SchemaRef.cmdSubmitResultVersion,
        request: {
          draftId: input.draftId,
          actorPrincipalId: input.actorPrincipalId,
          contentHash: content.contentHash,
          scope: input.scope,
        },
      };
      const lookup = await checkIdempotency<SubmitOutcome>(ctx, idem);
      if (lookup.replay) return { ...lookup.response, created: false, ledgerEntries: [] };
      if (draft.submitted_version_id !== null) {
        throw new DomainError(DomainErrorCode.IMMUTABLE, 'draft was already submitted');
      }
      await this.assertResultScope(ctx, draft.result_id, input.scope);

      const decision = await authorizeIn(
        ctx,
        {
          principalId: input.actorPrincipalId,
          capability: Capability.SUBMIT_RESULT,
          scope: input.scope,
          atTime: ctx.txTime,
          asOf: ctx.txTime,
        },
        this.conflictChecker,
      );
      if (!decision.authorized) throw denied(decision);

      // Serialize all writes to this Result on its ledger stream head.
      const stream = await openStream(ctx, draft.result_id as Uuid, StreamType.RESULT);
      const duplicate = await ctx.trx
        .selectFrom('results.result_version')
        .selectAll()
        .where('result_id', '=', draft.result_id)
        .where('content_hash', '=', content.contentHash)
        .executeTakeFirst();
      if (duplicate !== undefined) {
        const state = await ctx.trx
          .selectFrom('results.result_version_state')
          .select('current_status')
          .where('result_version_id', '=', duplicate.id)
          .executeTakeFirstOrThrow();
        await ctx.trx
          .updateTable('results.result_draft')
          .set({ submitted_version_id: duplicate.id, updated_at: ctx.txTime })
          .where('id', '=', draft.id)
          .execute();
        const response: SubmitOutcome = {
          resultVersionId: duplicate.id as Uuid,
          versionNumber: duplicate.version_number,
          contentHash: duplicate.content_hash,
          status: state.current_status as ResultVersionStatus,
          created: false,
          ledgerEntries: [],
          authorizationProofDigest: decision.proofDigest,
        };
        await recordIdempotency(ctx, idem, lookup.requestHash, response);
        await stream.close();
        return response;
      }

      const resultState = await ctx.trx
        .selectFrom('results.result_state')
        .selectAll()
        .where('result_id', '=', draft.result_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const versionNumber = resultState.latest_version_number + 1;
      const resultVersionId = newId();
      const versionRow: ResultVersionTable = {
        id: resultVersionId,
        result_id: draft.result_id,
        version_number: versionNumber,
        discipline_version_ref: draft.discipline_version_ref,
        content_schema: RESULT_CONTENT_SCHEMA,
        content: JSON.stringify(content.normalized),
        content_hash: content.contentHash,
        submitted_by_principal_id: input.actorPrincipalId,
        supersedes_version_id: null,
        fact_hash: factHash(SchemaRef.resultVersionFact, {
          resultVersionId,
          resultId: draft.result_id,
          versionNumber,
          contentHash: content.contentHash,
          contentSchema: RESULT_CONTENT_SCHEMA,
          disciplineVersionRef: draft.discipline_version_ref,
          submittedByPrincipalId: input.actorPrincipalId,
        }),
        recorded_at: ctx.txTime,
      };
      await ctx.trx.insertInto('results.result_version').values(versionRow).execute();
      await stream.append({
        eventType: 'RESULT_VERSION_SUBMITTED',
        factTable: 'results.result_version',
        factRowId: resultVersionId,
        payloadHash: versionRow.fact_hash,
      });

      const transitionId = await this.appendTransition(ctx, stream, {
        resultVersionId,
        fromStatus: null,
        toStatus: 'SUBMITTED',
        transitionCode: 'T2',
        actorPrincipalId: input.actorPrincipalId,
        proofDigest: decision.proofDigest,
      });
      void transitionId;

      // Class B projections, same transaction.
      await ctx.trx
        .insertInto('results.result_version_state')
        .values({
          result_version_id: resultVersionId,
          result_id: draft.result_id,
          current_status: 'SUBMITTED',
          hold: false,
          updated_at: ctx.txTime,
        })
        .execute();
      const bumped = await ctx.trx
        .updateTable('results.result_state')
        .set({ latest_version_number: versionNumber, updated_at: ctx.txTime })
        .where('result_id', '=', draft.result_id)
        .where('latest_version_number', '=', resultState.latest_version_number)
        .executeTakeFirst();
      if (bumped.numUpdatedRows !== 1n)
        throw new DomainError(
          DomainErrorCode.CONCURRENCY_CONFLICT,
          'result state moved concurrently',
        );
      await ctx.trx
        .updateTable('results.result_draft')
        .set({ submitted_version_id: resultVersionId, updated_at: ctx.txTime })
        .where('id', '=', draft.id)
        .execute();

      await emitEvent(ctx, {
        eventType: 'ResultSubmitted',
        aggregateType: 'RESULT_VERSION',
        aggregateId: resultVersionId,
        actorPrincipalId: input.actorPrincipalId,
        causationId: input.idempotencyKey,
        payload: {
          resultId: draft.result_id,
          versionNumber,
          contentHash: content.contentHash,
          status: 'SUBMITTED',
        },
      });
      await stream.close();
      const response: SubmitOutcome = {
        resultVersionId,
        versionNumber,
        contentHash: content.contentHash,
        status: 'SUBMITTED',
        created: true,
        ledgerEntries: stream.entries,
        authorizationProofDigest: decision.proofDigest,
      };
      await recordIdempotency(ctx, idem, lookup.requestHash, { ...response, ledgerEntries: [] });
      return response;
    });
  }

  /** T3 SUBMITTED → PROVISIONAL and T4 SUBMITTED → REJECTED (capability ACCEPT_RESULT). */
  transition(input: TransitionInput): Promise<TransitionOutcome> {
    return inTransaction(this.db, ModuleRole.results, async (ctx) => {
      const idem: IdempotencySpec = {
        scope: input.actorPrincipalId,
        key: input.idempotencyKey,
        commandType: 'TransitionResultVersion',
        requestSchema: SchemaRef.cmdTransitionResultVersion,
        request: {
          resultVersionId: input.resultVersionId,
          toStatus: input.toStatus,
          actorPrincipalId: input.actorPrincipalId,
          scope: input.scope,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        },
      };
      const lookup = await checkIdempotency<TransitionOutcome>(ctx, idem);
      if (lookup.replay) return { ...lookup.response, created: false, ledgerEntries: [] };

      const version = await ctx.trx
        .selectFrom('results.result_version')
        .selectAll()
        .where('id', '=', input.resultVersionId)
        .executeTakeFirst();
      if (version === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'result version not found');
      await this.assertResultScope(ctx, version.result_id, input.scope);

      const decision = await authorizeIn(
        ctx,
        {
          principalId: input.actorPrincipalId,
          capability: Capability.ACCEPT_RESULT,
          scope: input.scope,
          atTime: ctx.txTime,
          asOf: ctx.txTime,
        },
        this.conflictChecker,
      );
      if (!decision.authorized) throw denied(decision);

      const stream = await openStream(ctx, version.result_id as Uuid, StreamType.RESULT);
      const state = await ctx.trx
        .selectFrom('results.result_version_state')
        .selectAll()
        .where('result_version_id', '=', version.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const from = state.current_status as ResultVersionStatus;
      const rule = findTransition(from, input.toStatus);
      if (rule === undefined) {
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          `cannot move a ${from} version to ${input.toStatus}`,
        );
      }
      if (state.hold)
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          'version is under an active hold',
        );
      if (input.toStatus === 'PROVISIONAL') {
        const current = await ctx.trx
          .selectFrom('results.result_version_state')
          .select('result_version_id')
          .where('result_id', '=', version.result_id)
          .where('current_status', 'in', ['PROVISIONAL', 'OFFICIAL', 'FINAL'])
          .executeTakeFirst();
        if (current !== undefined) {
          throw new DomainError(
            DomainErrorCode.CURRENT_VERSION_CONFLICT,
            'another version is already current; supersession requires a correction (not in BRT-03)',
            {
              currentVersionId: current.result_version_id,
            },
          );
        }
      }

      const transitionId = await this.appendTransition(ctx, stream, {
        resultVersionId: version.id as Uuid,
        fromStatus: from,
        toStatus: input.toStatus,
        transitionCode: rule.code,
        actorPrincipalId: input.actorPrincipalId,
        proofDigest: decision.proofDigest,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      });
      const updated = await ctx.trx
        .updateTable('results.result_version_state')
        .set({ current_status: input.toStatus, updated_at: ctx.txTime })
        .where('result_version_id', '=', version.id)
        .where('current_status', '=', from)
        .where('hold', '=', false)
        .executeTakeFirst();
      if (updated.numUpdatedRows !== 1n)
        throw new DomainError(
          DomainErrorCode.CONCURRENCY_CONFLICT,
          'version state moved concurrently',
        );
      if (input.toStatus === 'PROVISIONAL') {
        await ctx.trx
          .updateTable('results.result_state')
          .set({ current_version_id: version.id, updated_at: ctx.txTime })
          .where('result_id', '=', version.result_id)
          .execute();
      }
      await emitEvent(ctx, {
        eventType: input.toStatus === 'PROVISIONAL' ? 'ResultProvisional' : 'ResultRejected',
        aggregateType: 'RESULT_VERSION',
        aggregateId: version.id as Uuid,
        actorPrincipalId: input.actorPrincipalId,
        causationId: input.idempotencyKey,
        payload: {
          resultId: version.result_id,
          from,
          to: input.toStatus,
          transitionCode: rule.code,
          contentHash: version.content_hash,
        },
      });
      await stream.close();
      const response: TransitionOutcome = {
        resultVersionId: version.id as Uuid,
        status: input.toStatus,
        transitionId,
        created: true,
        ledgerEntries: stream.entries,
        authorizationProofDigest: decision.proofDigest,
      };
      await recordIdempotency(ctx, idem, lookup.requestHash, { ...response, ledgerEntries: [] });
      return response;
    });
  }

  private async appendTransition(
    ctx: TxContext,
    stream: Awaited<ReturnType<typeof openStream>>,
    t: {
      resultVersionId: Uuid;
      fromStatus: ResultVersionStatus | null;
      toStatus: ResultVersionStatus;
      transitionCode: string;
      actorPrincipalId: Uuid;
      proofDigest: string;
      reason?: string;
    },
  ): Promise<Uuid> {
    const id = newId();
    const hash = factHash(SchemaRef.resultStatusTransition, {
      transitionId: id,
      resultVersionId: t.resultVersionId,
      ...(t.fromStatus === null ? {} : { fromStatus: t.fromStatus }),
      toStatus: t.toStatus,
      transitionCode: t.transitionCode,
      actorPrincipalId: t.actorPrincipalId,
      authorizationProofDigest: t.proofDigest,
      ...(t.reason === undefined ? {} : { reason: t.reason }),
    });
    await ctx.trx
      .insertInto('results.result_status_transition')
      .values({
        id,
        result_version_id: t.resultVersionId,
        from_status: t.fromStatus,
        to_status: t.toStatus,
        transition_code: t.transitionCode,
        actor_principal_id: t.actorPrincipalId,
        authorization_proof_digest: t.proofDigest,
        reason: t.reason ?? null,
        fact_hash: hash,
        recorded_at: ctx.txTime,
      })
      .execute();
    await stream.append({
      eventType: 'STATUS_TRANSITION',
      factTable: 'results.result_status_transition',
      factRowId: id,
      payloadHash: hash,
    });
    return id;
  }

  /** Read helpers (projection + immutable snapshot). */
  async getVersion(resultVersionId: Uuid) {
    return inTransaction(this.db, ModuleRole.results, async (ctx) => {
      const version = await ctx.trx
        .selectFrom('results.result_version')
        .selectAll()
        .where('id', '=', resultVersionId)
        .executeTakeFirst();
      const state = await ctx.trx
        .selectFrom('results.result_version_state')
        .selectAll()
        .where('result_version_id', '=', resultVersionId)
        .executeTakeFirst();
      return version === undefined ? undefined : { version, state };
    });
  }

  async getResultState(resultId: Uuid) {
    return inTransaction(this.db, ModuleRole.results, (ctx) =>
      ctx.trx
        .selectFrom('results.result_state')
        .selectAll()
        .where('result_id', '=', resultId)
        .executeTakeFirst(),
    );
  }
}

export { findTransition };
