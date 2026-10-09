import {
  DomainError,
  DomainErrorCode,
  newId,
  VERIFICATION_LEVEL_LABEL,
  type EvaluationState,
  type Uuid,
  type VerificationFreshness,
  type VerificationLevel,
} from '@br/domain';
import { SchemaRef } from '@br/schemas';
import {
  assembleSnapshot,
  ASSEMBLER_VERSION,
  ENGINE_ID,
  ENGINE_VERSION,
  evaluateVerification,
  hashOutcome,
  hashTrace,
  PUBLIC_VERIFICATION_NOTICE,
  publicBody,
  publicStatement,
  validatePolicySpec,
  type PolicySpec,
  type PublicVerificationBody,
  type VerificationOutcome,
  type VerificationTrace,
} from '@br/verification';
import { sql } from 'kysely';
import type { Db } from './db';
import {
  competitionPermissionSet,
  resolveResultVersion,
  resultVersionPath,
  type Committed,
  type EvidenceActor,
  unwrap,
} from './evidence-support';
import { factHash } from './hashing';
import { identityIdempotency, lockKeys, pgConstraint, recordAudit } from './identity-support';
import { openStream, StreamType } from './ledger';
import { emitEvent } from './outbox';
import { inTransaction, ModuleRole, type TxContext } from './tx';
import {
  disciplineVersionOf,
  loadRawVerificationFacts,
  resolveApplicablePolicy,
  type ApplicablePolicy,
} from './verification-loader';
import { refreshCurrentVerification, refreshRunSummary } from './verification-projection';

// ───────────────────────────── policy operator (br_verification_policy) ─────────────────────────────

const POLICY_CODE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * INTERNAL verification-policy administration on the DEDICATED operator connection
 * (br_verification_operator_app → br_verification_policy only). Creates policy identities,
 * immutable declarative versions (validated before any row exists), publishes/retires versions and
 * binds PUBLISHED versions to exact DisciplineVersions. It cannot create runs, touch results,
 * evidence, authority, competition or PII — the role has no such privilege.
 */
export class VerificationPolicyStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private tx<T>(fn: (ctx: TxContext) => Promise<T>): Promise<T> {
    return inTransaction(this.db, ModuleRole.verificationPolicy, fn);
  }

  createPolicy(input: {
    operatorAccountId: string;
    code: string;
    name: string;
    idempotencyKey: string;
  }): Promise<{ policyId: string; created: boolean }> {
    if (!POLICY_CODE.test(input.code))
      return Promise.reject(new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid policy code'));
    const name = input.name.trim();
    if (name.length === 0 || name.length > 120)
      return Promise.reject(new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid policy name'));
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ policyId: string }>(ctx, {
        command: 'CreateVerificationPolicy',
        actorAccountId: input.operatorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { code: input.code, name },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      await lockKeys(ctx, `verification-policy-code:${input.code}`);
      const policyId = newId();
      try {
        await sql`INSERT INTO verification.policy (id, code, name, created_by_account_id, recorded_at)
          VALUES (${policyId}, ${input.code}, ${name}, ${input.operatorAccountId}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
      } catch (err) {
        if (pgConstraint(err) !== undefined)
          throw new DomainError(DomainErrorCode.ALREADY_EXISTS, 'policy code already exists');
        throw err;
      }
      await emitEvent(ctx, {
        eventType: 'VerificationPolicyCreated',
        aggregateType: 'VERIFICATION_POLICY',
        aggregateId: policyId as Uuid,
        payload: { code: input.code },
      });
      await recordAudit(ctx, {
        actorAccountId: input.operatorAccountId,
        action: 'verification.policy-created',
        targetType: 'VERIFICATION_POLICY',
        targetId: policyId,
      });
      await idem.record({ policyId });
      return { policyId, created: true };
    });
  }

  /** Validates the declarative spec BEFORE any row exists; versions are immutable from creation. */
  createPolicyVersion(input: {
    operatorAccountId: string;
    policyId: string;
    spec: unknown;
    idempotencyKey: string;
  }): Promise<{ policyVersionId: string; version: number; specHash: string; created: boolean }> {
    const v = validatePolicySpec(input.spec);
    if (!v.ok)
      return Promise.reject(
        new DomainError(DomainErrorCode.INVALID_INPUT, 'verification policy spec rejected', {
          issues: v.issues,
        }),
      );
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{
        policyVersionId: string;
        version: number;
        specHash: string;
      }>(ctx, {
        command: 'CreateVerificationPolicyVersion',
        actorAccountId: input.operatorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { policyId: input.policyId, specHash: v.specHash },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      if (!UUID.test(input.policyId))
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'policy not found');
      await lockKeys(ctx, `verification-policy:${input.policyId}`);
      const { rows: p } = await sql<{
        code: string;
      }>`SELECT code FROM verification.policy WHERE id = ${input.policyId}`.execute(ctx.trx);
      if (p[0] === undefined) throw new DomainError(DomainErrorCode.NOT_FOUND, 'policy not found');
      const { rows: same } = await sql<{ id: string }>`
        SELECT id FROM verification.policy_version WHERE policy_id = ${input.policyId} AND spec_hash = ${v.specHash}`.execute(
        ctx.trx,
      );
      if (same[0] !== undefined)
        throw new DomainError(
          DomainErrorCode.ALREADY_EXISTS,
          'this policy already has a version with the same spec',
        );
      const { rows: max } = await sql<{ n: number | null }>`
        SELECT max(version) AS n FROM verification.policy_version WHERE policy_id = ${input.policyId}`.execute(
        ctx.trx,
      );
      const version = (max[0]?.n ?? 0) + 1;
      const policyVersionId = newId();
      await sql`INSERT INTO verification.policy_version
          (id, policy_id, version, spec, spec_schema, spec_hash, target_engine, created_by_account_id, recorded_at)
        VALUES (${policyVersionId}, ${input.policyId}, ${version}, ${JSON.stringify(v.spec)}, 'br:verification-policy@1',
                ${v.specHash}, ${v.spec.targetEngine}, ${input.operatorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await emitEvent(ctx, {
        eventType: 'VerificationPolicyVersionCreated',
        aggregateType: 'VERIFICATION_POLICY_VERSION',
        aggregateId: policyVersionId as Uuid,
        payload: { policyId: input.policyId, version, specHash: v.specHash },
      });
      await recordAudit(ctx, {
        actorAccountId: input.operatorAccountId,
        action: 'verification.policy-version-created',
        targetType: 'VERIFICATION_POLICY_VERSION',
        targetId: policyVersionId,
        details: { version },
      });
      const out = { policyVersionId, version, specHash: v.specHash };
      await idem.record(out);
      return { ...out, created: true };
    });
  }

  /** DRAFT → PUBLISHED (once) / PUBLISHED → RETIRED. Published versions stay immutable. */
  changeVersionStatus(input: {
    operatorAccountId: string;
    policyVersionId: string;
    status: 'PUBLISHED' | 'RETIRED';
  }): Promise<{ policyVersionId: string; status: string; changed: boolean }> {
    if (!UUID.test(input.policyVersionId))
      return Promise.reject(new DomainError(DomainErrorCode.NOT_FOUND, 'policy version not found'));
    return this.tx(async (ctx) => {
      await lockKeys(ctx, `verification-policy-version:${input.policyVersionId}`);
      const { rows } = await sql<{ status: string; spec: unknown; spec_hash: string }>`
        SELECT c.status, v.spec, v.spec_hash FROM verification.v_policy_version_current c
        JOIN verification.policy_version v ON v.id = c.policy_version_id
        WHERE c.policy_version_id = ${input.policyVersionId}`.execute(ctx.trx);
      const cur = rows[0];
      if (cur === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'policy version not found');
      if (cur.status === input.status)
        return { policyVersionId: input.policyVersionId, status: cur.status, changed: false };
      // Re-validate the stored spec before it can drive evaluations (defence in depth).
      const v = validatePolicySpec(cur.spec);
      if (input.status === 'PUBLISHED' && (!v.ok || v.specHash !== cur.spec_hash))
        throw new DomainError(
          DomainErrorCode.VERIFICATION_INTEGRITY_FAILURE,
          'stored policy spec does not match its hash',
          {
            reason: 'POLICY_HASH_MISMATCH',
          },
        );
      try {
        await sql`INSERT INTO verification.policy_version_status_change (id, policy_version_id, status, actor_account_id, recorded_at)
          VALUES (${newId()}, ${input.policyVersionId}, ${input.status}, ${input.operatorAccountId}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
      } catch (err) {
        if ((err as { code?: string }).code === 'BR090' || pgConstraint(err) !== undefined)
          throw new DomainError(
            DomainErrorCode.INVALID_TRANSITION,
            `policy version cannot move from ${cur.status} to ${input.status}`,
          );
        throw err;
      }
      await emitEvent(ctx, {
        eventType:
          input.status === 'PUBLISHED'
            ? 'VerificationPolicyVersionPublished'
            : 'VerificationPolicyVersionRetired',
        aggregateType: 'VERIFICATION_POLICY_VERSION',
        aggregateId: input.policyVersionId as Uuid,
        payload: { status: input.status, specHash: cur.spec_hash },
      });
      await recordAudit(ctx, {
        actorAccountId: input.operatorAccountId,
        action:
          input.status === 'PUBLISHED'
            ? 'verification.policy-version-published'
            : 'verification.policy-version-retired',
        targetType: 'VERIFICATION_POLICY_VERSION',
        targetId: input.policyVersionId,
      });
      return { policyVersionId: input.policyVersionId, status: input.status, changed: true };
    });
  }

  /**
   * Appends a binding of a PUBLISHED version to an exact DisciplineVersion, effective now or at a
   * later scheduled time (never earlier than its own recording time — no backdating). Old runs stay
   * pinned to the policy they were evaluated under.
   */
  bindPolicy(input: {
    operatorAccountId: string;
    disciplineVersionId: string;
    policyVersionId: string;
    effectiveFrom?: Date;
    idempotencyKey: string;
  }): Promise<{ bindingId: string; effectiveFrom: string; created: boolean }> {
    if (!UUID.test(input.disciplineVersionId) || !UUID.test(input.policyVersionId))
      return Promise.reject(new DomainError(DomainErrorCode.NOT_FOUND, 'not found'));
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ bindingId: string; effectiveFrom: string }>(ctx, {
        command: 'BindVerificationPolicy',
        actorAccountId: input.operatorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: {
          disciplineVersionId: input.disciplineVersionId,
          policyVersionId: input.policyVersionId,
          effectiveFrom: input.effectiveFrom?.toISOString(),
        },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      const effectiveFrom = input.effectiveFrom ?? ctx.txTime;
      if (effectiveFrom.getTime() < ctx.txTime.getTime())
        throw new DomainError(
          DomainErrorCode.BACKDATING_REJECTED,
          'a policy binding cannot take effect before it is recorded',
        );
      const { rows: dv } = await sql<{
        id: string;
      }>`SELECT id FROM sports.discipline_version WHERE id = ${input.disciplineVersionId}`.execute(
        ctx.trx,
      );
      if (dv[0] === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'discipline version not found');
      const bindingId = newId();
      try {
        await sql`INSERT INTO verification.policy_binding (id, discipline_version_id, policy_version_id, effective_from, actor_account_id, recorded_at)
          VALUES (${bindingId}, ${input.disciplineVersionId}, ${input.policyVersionId}, ${effectiveFrom}, ${input.operatorAccountId}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
      } catch (err) {
        const c = (err as { code?: string }).code;
        if (c === 'BR091')
          throw new DomainError(
            DomainErrorCode.INVALID_TRANSITION,
            'only a PUBLISHED policy version can be bound',
          );
        if (c === 'BR092')
          throw new DomainError(
            DomainErrorCode.INVALID_INPUT,
            'a binding must take effect strictly after the previous binding',
          );
        if (c === '23503')
          throw new DomainError(DomainErrorCode.NOT_FOUND, 'policy version not found');
        throw err;
      }
      await emitEvent(ctx, {
        eventType: 'VerificationPolicyBound',
        aggregateType: 'VERIFICATION_POLICY_VERSION',
        aggregateId: input.policyVersionId as Uuid,
        payload: {
          bindingId,
          disciplineVersionId: input.disciplineVersionId,
          effectiveFrom: effectiveFrom.toISOString(),
        },
      });
      await recordAudit(ctx, {
        actorAccountId: input.operatorAccountId,
        action: 'verification.policy-bound',
        targetType: 'DISCIPLINE_VERSION',
        targetId: input.disciplineVersionId,
        details: { policyVersionId: input.policyVersionId },
      });
      const out = { bindingId, effectiveFrom: effectiveFrom.toISOString() };
      await idem.record(out);
      return { ...out, created: true };
    });
  }
}

// ───────────────────────────── verification runtime (br_verification) ─────────────────────────────

export interface VerificationRunView {
  readonly runId: string;
  readonly created: boolean;
  readonly resultVersionId: string;
  readonly evaluatedAsOf: string;
  readonly policy: {
    readonly policyVersionId: string;
    readonly code: string;
    readonly version: number;
  };
  readonly engine: { readonly engineId: string; readonly engineVersion: string };
  readonly snapshotHash: string;
  readonly evidenceBundleHash: string;
  readonly outcomeHash: string;
  readonly traceHash: string;
  readonly evaluationState: 'EVALUATED' | 'INSUFFICIENT_INPUT';
  readonly highestSatisfiedLevel?: VerificationLevel;
  readonly label?: string;
  readonly outcome: VerificationOutcome;
  readonly public: PublicVerificationBody;
}

export type EvaluationResponse =
  | { readonly kind: 'RUN'; readonly run: VerificationRunView }
  | {
      readonly kind: 'POLICY_UNAVAILABLE';
      readonly evaluationState: 'POLICY_UNAVAILABLE';
      readonly reason: string;
    };

export interface HistoricalEvaluation {
  readonly kind: 'HISTORICAL';
  readonly persisted: false;
  readonly resultVersionId: string;
  readonly asOf: string;
  readonly policy: {
    readonly policyVersionId: string;
    readonly code: string;
    readonly version: number;
  };
  readonly snapshotHash: string;
  readonly outcomeHash: string;
  readonly traceHash: string;
  readonly evaluationState: 'EVALUATED' | 'INSUFFICIENT_INPUT';
  readonly highestSatisfiedLevel?: VerificationLevel;
  readonly outcome: VerificationOutcome;
  /** A persisted run with the same identity, if one exists (replay reproducibility). */
  readonly matchingRunId?: string;
}

export interface PublicVerificationV1 {
  readonly schema: 'br:public-verification@1';
  readonly resultVersionId: string;
  readonly freshness: VerificationFreshness;
  readonly evaluationState: EvaluationState;
  readonly level?: VerificationLevel;
  readonly label?: string;
  readonly statement: string;
  readonly notice: string;
  readonly policy?: { readonly code: string; readonly version: number };
  readonly evaluatedAsOf?: string;
  readonly runId?: string;
  readonly lastEvaluated?: {
    readonly runId: string;
    readonly level?: VerificationLevel;
    readonly label?: string;
    readonly evaluatedAsOf: string;
    readonly policy: { readonly code: string; readonly version: number };
  };
  readonly reEvaluationRequired: boolean;
  readonly activeDispute: boolean;
  readonly levels?: PublicVerificationBody['levels'];
  readonly next?: PublicVerificationBody['next'];
}

interface StoredRun {
  id: string;
  result_version_id: string;
  policy_version_id: string;
  engine_id: string;
  engine_version: string;
  evaluated_as_of: Date;
  snapshot_hash: string;
  evidence_bundle_hash: string;
  outcome: VerificationOutcome;
  outcome_hash: string;
  trace_hash: string;
  evaluation_state: 'EVALUATED' | 'INSUFFICIENT_INPUT';
  highest_level: VerificationLevel | null;
  policy_code: string;
  policy_version: number;
}

const RUN_SELECT = sql`
  SELECT r.id, r.result_version_id, r.policy_version_id, r.engine_id, r.engine_version, r.evaluated_as_of, r.snapshot_hash,
         r.evidence_bundle_hash, r.outcome, r.outcome_hash, r.trace_hash, r.evaluation_state, r.highest_level,
         p.code AS policy_code, v.version AS policy_version
  FROM verification.run r
  JOIN verification.policy_version v ON v.id = r.policy_version_id
  JOIN verification.policy p ON p.id = v.policy_id`;

function toRunView(r: StoredRun, created: boolean): VerificationRunView {
  return {
    runId: r.id,
    created,
    resultVersionId: r.result_version_id,
    evaluatedAsOf: r.evaluated_as_of.toISOString(),
    policy: {
      policyVersionId: r.policy_version_id,
      code: r.policy_code,
      version: r.policy_version,
    },
    engine: { engineId: r.engine_id, engineVersion: r.engine_version },
    snapshotHash: r.snapshot_hash,
    evidenceBundleHash: r.evidence_bundle_hash,
    outcomeHash: r.outcome_hash,
    traceHash: r.trace_hash,
    evaluationState: r.evaluation_state,
    ...(r.highest_level === null
      ? {}
      : {
          highestSatisfiedLevel: r.highest_level,
          label: VERIFICATION_LEVEL_LABEL[r.highest_level],
        }),
    outcome: r.outcome,
    public: publicBody(r.outcome),
  };
}

/**
 * Bounded waits before re-running a CURRENT evaluation whose cutoff predates recorded facts: long
 * enough to span a one-second host clock correction (observed on WSL2 / Docker Desktop), short
 * enough that a real, persistent regression surfaces quickly as VERIFICATION_TIME_INCONSISTENT.
 * Nothing is clamped: each attempt is a new transaction with its own database time.
 */
const TIME_RETRY_DELAYS_MS = [300, 900] as const;

const notFound = () => new DomainError(DomainErrorCode.NOT_FOUND, 'result version not found');
const SYSTEM_CONDITIONS = new Set<string>([
  DomainErrorCode.VERIFICATION_INTEGRITY_FAILURE,
  DomainErrorCode.VERIFICATION_TIME_INCONSISTENT,
]);

/**
 * The Sports Oracle runtime. Assembles snapshots from REAL canonical facts only (never from a
 * caller-supplied snapshot — there is no API for that), evaluates them with the pure engine and
 * persists immutable, idempotent VerificationRuns. Requesting an evaluation confers no authority and
 * cannot choose the outcome: there is no level, override, confidence or conflict-waiver input.
 * Verification never transitions a Result, advances a bracket or creates any consequence.
 */
export class VerificationService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Every verification transaction reads under REPEATABLE READ: all loader statements see ONE
   * consistent snapshot. The CURRENT cutoff is this transaction's database time; a fact visible to
   * the snapshot but recorded later than the cutoff means a concurrent commit in the BEGIN→snapshot
   * window or a database clock step backwards — never clamped: the whole transaction is retried a
   * bounded number of times with a fresh cutoff, and a persistent inconsistency surfaces as
   * VERIFICATION_TIME_INCONSISTENT (fail closed).
   */
  private async tx<T>(fn: (ctx: TxContext) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await inTransaction(this.db, ModuleRole.verification, fn, 4, {
          isolation: 'repeatable read',
        });
      } catch (err) {
        if (
          !(err instanceof DomainError) ||
          err.code !== DomainErrorCode.VERIFICATION_TIME_INCONSISTENT ||
          attempt >= 3
        )
          throw err;
        await new Promise((resolve) => setTimeout(resolve, TIME_RETRY_DELAYS_MS[attempt - 1]));
      }
    }
  }

  /** Staff access: INTERNAL, or an account with COMP_VIEW_PRIVATE on the result's competition. */
  private async staffAllowed(
    ctx: TxContext,
    actor: EvidenceActor,
    competitionId: string | undefined,
  ): Promise<boolean> {
    if ('internal' in actor) return true;
    if (competitionId === undefined) return false;
    return (await competitionPermissionSet(ctx, actor.accountId, competitionId)).has(
      'COMP_VIEW_PRIVATE',
    );
  }

  private async denied(
    ctx: TxContext,
    actor: EvidenceActor,
    action: string,
    targetType: string,
    targetId?: string,
  ) {
    await recordAudit(ctx, {
      actorAccountId: 'accountId' in actor ? actor.accountId : undefined,
      action,
      targetType,
      ...(targetId === undefined ? {} : { targetId }),
      outcome: 'DENIED',
    });
  }

  /** Records a refused INTERNAL policy mutation (e.g. no operator flag / no operator connection). */
  auditDeniedPolicyMutation(actorAccountId: string | undefined, action: string): Promise<void> {
    return this.tx((ctx) =>
      recordAudit(ctx, {
        ...(actorAccountId === undefined ? {} : { actorAccountId }),
        action,
        targetType: 'VERIFICATION_POLICY',
        outcome: 'DENIED',
      }),
    );
  }

  /**
   * CURRENT evaluation: cutoff = this transaction's own database time. Identical inputs (same
   * result version, policy version, engine version and snapshot hash) map to ONE logical run,
   * even under concurrency; a changed snapshot creates a new run; nothing is ever overwritten.
   */
  async evaluate(input: {
    readonly actor: EvidenceActor;
    readonly resultVersionId: string;
  }): Promise<EvaluationResponse> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.evaluateOnce(input);
      } catch (err) {
        if (
          !(err instanceof DomainError) ||
          err.code !== DomainErrorCode.VERIFICATION_TIME_INCONSISTENT ||
          attempt >= 3
        )
          throw err;
        await new Promise((resolve) => setTimeout(resolve, TIME_RETRY_DELAYS_MS[attempt - 1]));
      }
    }
  }

  private async evaluateOnce(input: {
    readonly actor: EvidenceActor;
    readonly resultVersionId: string;
  }): Promise<EvaluationResponse> {
    const r = await this.tx(async (ctx): Promise<Committed<EvaluationResponse>> => {
      const rv = await resolveResultVersion(ctx, input.resultVersionId);
      const path = rv === undefined ? undefined : await resultVersionPath(ctx, rv);
      if (rv === undefined || !(await this.staffAllowed(ctx, input.actor, path?.competitionId))) {
        await this.denied(ctx, input.actor, 'verification.evaluation-requested', 'RESULT_VERSION');
        return { error: notFound() };
      }
      const actorAccountId = 'accountId' in input.actor ? input.actor.accountId : undefined;
      const asOf = ctx.txTime;
      const dv = await disciplineVersionOf(ctx, path);
      const resolution = await resolveApplicablePolicy(ctx, dv.disciplineVersionId, asOf);
      if (!resolution.ok) {
        await recordAudit(ctx, {
          actorAccountId,
          action: 'verification.evaluation-requested',
          targetType: 'RESULT_VERSION',
          targetId: rv.resultVersionId,
          details: { evaluationState: 'POLICY_UNAVAILABLE', reason: resolution.reason },
        });
        return {
          ok: {
            kind: 'POLICY_UNAVAILABLE',
            evaluationState: 'POLICY_UNAVAILABLE',
            reason: resolution.reason,
          },
        };
      }
      const policy = resolution.policy;
      let envelope;
      let evaluation;
      try {
        const raw = await loadRawVerificationFacts(ctx, rv, policy);
        envelope = assembleSnapshot(raw, asOf, 'CURRENT');
        evaluation = evaluateVerification(envelope.snapshot);
      } catch (err) {
        if (err instanceof DomainError && SYSTEM_CONDITIONS.has(err.code)) {
          await recordAudit(ctx, {
            actorAccountId,
            action: 'verification.evaluation-requested',
            targetType: 'RESULT_VERSION',
            targetId: rv.resultVersionId,
            outcome: 'FAILED',
            details: { code: err.code, reason: String(err.details.reason ?? 'UNSPECIFIED') },
          });
          return { error: err };
        }
        throw err;
      }
      const run = await this.persistRun(ctx, {
        resultVersionId: rv.resultVersionId,
        policy,
        asOf,
        evidenceBundleHash: envelope.evidenceBundleHash,
        evaluation,
        actorAccountId,
      });
      await recordAudit(ctx, {
        actorAccountId,
        action: 'verification.evaluation-requested',
        targetType: 'RESULT_VERSION',
        targetId: rv.resultVersionId,
        details: { runId: run.runId, created: run.created, evaluationState: run.evaluationState },
      });
      return { ok: { kind: 'RUN', run } };
    });
    return unwrap(r);
  }

  private async persistRun(
    ctx: TxContext,
    input: {
      resultVersionId: string;
      policy: ApplicablePolicy;
      asOf: Date;
      evidenceBundleHash: string;
      evaluation: ReturnType<typeof evaluateVerification>;
      actorAccountId: string | undefined;
    },
  ): Promise<VerificationRunView> {
    const e = input.evaluation;
    // Defensive: the documents we are about to store must re-hash to their recorded hashes.
    if (hashOutcome(e.outcome) !== e.outcomeHash || hashTrace(e.trace) !== e.traceHash)
      throw new DomainError(
        DomainErrorCode.VERIFICATION_INTEGRITY_FAILURE,
        'outcome/trace hash mismatch',
        { reason: 'OUTCOME_HASH_MISMATCH' },
      );
    await lockKeys(
      ctx,
      `verification-run:${input.resultVersionId}:${input.policy.policyVersionId}:${ENGINE_VERSION}:${e.snapshotHash}`,
    );
    const { rows: existing } = await sql<StoredRun>`${RUN_SELECT}
      WHERE r.result_version_id = ${input.resultVersionId} AND r.policy_version_id = ${input.policy.policyVersionId}
        AND r.engine_version = ${ENGINE_VERSION} AND r.snapshot_hash = ${e.snapshotHash}`.execute(
      ctx.trx,
    );
    if (existing[0] !== undefined) return toRunView(existing[0], false);

    const runId = newId();
    const level = e.outcome.highestSatisfiedLevel ?? null;
    await sql`INSERT INTO verification.run
        (id, result_version_id, policy_version_id, policy_binding_id, engine_id, engine_version, assembler_version,
         snapshot_provenance, evaluated_as_of, snapshot_hash, policy_spec_hash, evidence_bundle_hash, outcome,
         outcome_hash, trace_hash, evaluation_state, highest_level, requested_by_account_id, recorded_at)
      VALUES (${runId}, ${input.resultVersionId}, ${input.policy.policyVersionId}, ${input.policy.bindingId}, ${ENGINE_ID},
              ${ENGINE_VERSION}, ${ASSEMBLER_VERSION}, 'CANONICAL_ASSEMBLY', ${input.asOf}, ${e.snapshotHash},
              ${input.policy.specHash}, ${input.evidenceBundleHash}, ${JSON.stringify(e.outcome)}, ${e.outcomeHash},
              ${e.traceHash}, ${e.outcome.evaluationState}, ${level}, ${input.actorAccountId ?? null}, ${ctx.txTime})`.execute(
      ctx.trx,
    );
    await sql`INSERT INTO verification.run_trace (run_id, trace, trace_hash, recorded_at)
      VALUES (${runId}, ${JSON.stringify(e.trace)}, ${e.traceHash}, ${ctx.txTime})`.execute(
      ctx.trx,
    );

    const fact = {
      runId,
      resultVersionId: input.resultVersionId,
      policyVersionId: input.policy.policyVersionId,
      engineVersion: ENGINE_VERSION,
      evaluatedAsOf: input.asOf.toISOString(),
      snapshotHash: e.snapshotHash,
      outcomeHash: e.outcomeHash,
      traceHash: e.traceHash,
      evidenceBundleHash: input.evidenceBundleHash,
      evaluationState: e.outcome.evaluationState,
      ...(level === null ? {} : { highestSatisfiedLevel: level }),
    };
    const stream = await openStream(ctx, input.resultVersionId as Uuid, StreamType.VERIFICATION);
    await stream.append({
      eventType: 'VerificationEvaluated',
      factTable: 'verification.run',
      factRowId: runId as Uuid,
      payloadHash: factHash(SchemaRef.verificationRunFact, fact),
    });
    await stream.close();
    await emitEvent(ctx, {
      eventType: 'VerificationEvaluated',
      aggregateType: 'VERIFICATION_RUN',
      aggregateId: runId as Uuid,
      payload: {
        resultVersionId: input.resultVersionId,
        policyVersionId: input.policy.policyVersionId,
        engineVersion: ENGINE_VERSION,
        snapshotHash: e.snapshotHash,
        outcomeHash: e.outcomeHash,
        evaluationState: e.outcome.evaluationState,
        ...(level === null ? {} : { highestSatisfiedLevel: level }),
      },
    });
    await refreshRunSummary(ctx, runId);
    const change = await refreshCurrentVerification(ctx, input.resultVersionId);
    if (
      change.previous === undefined ||
      change.previous.level !== level ||
      change.previous.state !== e.outcome.evaluationState
    ) {
      await emitEvent(ctx, {
        eventType: 'CurrentVerificationChanged',
        aggregateType: 'RESULT_VERSION',
        aggregateId: input.resultVersionId as Uuid,
        payload: {
          resultVersionId: input.resultVersionId,
          verificationRunId: runId,
          snapshotHash: e.snapshotHash,
          policyVersionId: input.policy.policyVersionId,
          ...(change.previous?.level === undefined || change.previous.level === null
            ? {}
            : { previousLevel: change.previous.level }),
          ...(level === null ? {} : { newLevel: level }),
        },
      });
    }
    const { rows } = await sql<StoredRun>`${RUN_SELECT} WHERE r.id = ${runId}`.execute(ctx.trx);
    return toRunView(rows[0] as StoredRun, true);
  }

  /**
   * HISTORICAL evaluation ("as known then"): cutoff T ≤ now; facts recorded after T are excluded
   * (later retractions / compromises / grants are invisible). Never persisted — persisted runs are
   * current evaluations only. Returns the matching persisted run, if any, for reproducibility.
   */
  async evaluateAsOf(input: {
    readonly actor: EvidenceActor;
    readonly resultVersionId: string;
    readonly asOf: Date;
  }): Promise<HistoricalEvaluation | Extract<EvaluationResponse, { kind: 'POLICY_UNAVAILABLE' }>> {
    const r = await this.tx(
      async (
        ctx,
      ): Promise<
        Committed<
          HistoricalEvaluation | Extract<EvaluationResponse, { kind: 'POLICY_UNAVAILABLE' }>
        >
      > => {
        const rv = await resolveResultVersion(ctx, input.resultVersionId);
        const path = rv === undefined ? undefined : await resultVersionPath(ctx, rv);
        if (rv === undefined || !(await this.staffAllowed(ctx, input.actor, path?.competitionId))) {
          await this.denied(
            ctx,
            input.actor,
            'verification.historical-evaluation-requested',
            'RESULT_VERSION',
          );
          return { error: notFound() };
        }
        if (Number.isNaN(input.asOf.getTime()) || input.asOf.getTime() > ctx.txTime.getTime())
          return {
            error: new DomainError(DomainErrorCode.INVALID_INPUT, 'asOf cannot be in the future'),
          };
        const actorAccountId = 'accountId' in input.actor ? input.actor.accountId : undefined;
        await recordAudit(ctx, {
          actorAccountId,
          action: 'verification.historical-evaluation-requested',
          targetType: 'RESULT_VERSION',
          targetId: rv.resultVersionId,
          details: { asOf: input.asOf.toISOString() },
        });
        const dv = await disciplineVersionOf(ctx, path);
        const resolution = await resolveApplicablePolicy(ctx, dv.disciplineVersionId, input.asOf);
        if (!resolution.ok)
          return {
            ok: {
              kind: 'POLICY_UNAVAILABLE',
              evaluationState: 'POLICY_UNAVAILABLE',
              reason: resolution.reason,
            },
          };
        try {
          const raw = await loadRawVerificationFacts(ctx, rv, resolution.policy);
          const envelope = assembleSnapshot(raw, input.asOf, 'HISTORICAL');
          const e = evaluateVerification(envelope.snapshot);
          const { rows } = await sql<{ id: string }>`
          SELECT id FROM verification.run WHERE result_version_id = ${rv.resultVersionId}
            AND policy_version_id = ${resolution.policy.policyVersionId} AND engine_version = ${ENGINE_VERSION}
            AND snapshot_hash = ${e.snapshotHash}`.execute(ctx.trx);
          return {
            ok: {
              kind: 'HISTORICAL',
              persisted: false,
              resultVersionId: rv.resultVersionId,
              asOf: input.asOf.toISOString(),
              policy: {
                policyVersionId: resolution.policy.policyVersionId,
                code: resolution.policy.code,
                version: resolution.policy.version,
              },
              snapshotHash: e.snapshotHash,
              outcomeHash: e.outcomeHash,
              traceHash: e.traceHash,
              evaluationState: e.outcome.evaluationState,
              ...(e.outcome.highestSatisfiedLevel === undefined
                ? {}
                : { highestSatisfiedLevel: e.outcome.highestSatisfiedLevel }),
              outcome: e.outcome,
              ...(rows[0] === undefined ? {} : { matchingRunId: rows[0].id }),
            },
          };
        } catch (err) {
          if (
            err instanceof DomainError &&
            (SYSTEM_CONDITIONS.has(err.code) || err.code === DomainErrorCode.INVALID_INPUT)
          )
            return { error: err };
          throw err;
        }
      },
    );
    return unwrap(r);
  }

  /** Freshness of the latest run of a result version under the CURRENTLY applicable policy. */
  private freshness(ctx: TxContext, resultVersionId: string) {
    return currentVerificationFreshness(ctx, resultVersionId);
  }

  /**
   * PUBLIC current verification of an exact ResultVersion (visible competitions / events only).
   * A STALE run's level is never presented as current: only `lastEvaluated` + reEvaluationRequired.
   */
  async publicCurrent(resultVersionId: string): Promise<PublicVerificationV1> {
    return this.tx(async (ctx) => {
      const rv = await resolveResultVersion(ctx, resultVersionId);
      const path = rv === undefined ? undefined : await resultVersionPath(ctx, rv);
      if (
        rv === undefined ||
        path?.competitionId === undefined ||
        !(await this.publiclyVisible(ctx, path.competitionId, path.eventId))
      )
        throw notFound();
      const f = await this.freshness(ctx, resultVersionId);
      const base = {
        schema: 'br:public-verification@1' as const,
        resultVersionId,
        notice: PUBLIC_VERIFICATION_NOTICE,
      };
      const last = f.latest;
      const lastEvaluated =
        last === undefined
          ? undefined
          : {
              runId: last.id,
              ...(last.highest_level === null
                ? {}
                : {
                    level: last.highest_level,
                    label: VERIFICATION_LEVEL_LABEL[last.highest_level],
                  }),
              evaluatedAsOf: last.evaluated_as_of.toISOString(),
              policy: { code: last.policy_code, version: last.policy_version },
            };
      const activeDispute = last === undefined ? false : publicBody(last.outcome).activeDispute;
      if (!f.resolution.ok)
        return {
          ...base,
          freshness: f.freshness,
          evaluationState: 'POLICY_UNAVAILABLE',
          statement: publicStatement({
            freshness: f.freshness,
            evaluationState: 'POLICY_UNAVAILABLE',
          }),
          ...(lastEvaluated === undefined ? {} : { lastEvaluated }),
          reEvaluationRequired: false,
          activeDispute,
        };
      if (last === undefined || f.freshness === 'NOT_EVALUATED')
        return {
          ...base,
          freshness: 'NOT_EVALUATED',
          evaluationState: 'NOT_EVALUATED',
          statement: publicStatement({
            freshness: 'NOT_EVALUATED',
            evaluationState: 'NOT_EVALUATED',
          }),
          policy: { code: f.resolution.policy.code, version: f.resolution.policy.version },
          reEvaluationRequired: true,
          activeDispute: false,
        };
      if (f.freshness === 'STALE')
        return {
          ...base,
          freshness: 'STALE',
          evaluationState: last.evaluation_state,
          statement: publicStatement({
            freshness: 'STALE',
            evaluationState: last.evaluation_state,
          }),
          policy: { code: f.resolution.policy.code, version: f.resolution.policy.version },
          ...(lastEvaluated === undefined ? {} : { lastEvaluated }),
          reEvaluationRequired: true,
          activeDispute,
        };
      const body = publicBody(last.outcome);
      const policy = { code: last.policy_code, version: last.policy_version };
      return {
        ...base,
        freshness: 'CURRENT',
        evaluationState: body.evaluationState,
        ...(body.level === undefined ? {} : { level: body.level, label: body.label }),
        statement: publicStatement({
          freshness: 'CURRENT',
          evaluationState: body.evaluationState,
          ...(body.level === undefined ? {} : { level: body.level }),
          policy,
        }),
        policy,
        evaluatedAsOf: last.evaluated_as_of.toISOString(),
        runId: last.id,
        reEvaluationRequired: false,
        activeDispute: body.activeDispute,
        levels: body.levels,
        ...(body.next === undefined ? {} : { next: body.next }),
      };
    });
  }

  private async publiclyVisible(
    ctx: TxContext,
    competitionId: string,
    eventId: string | undefined,
  ): Promise<boolean> {
    const { rows } = await sql<{ ok: boolean }>`
      SELECT EXISTS (SELECT 1 FROM competition.v_competition_current c WHERE c.competition_id = ${competitionId} AND c.status <> 'DRAFT')
         AND (${eventId ?? null}::uuid IS NULL OR EXISTS (
              SELECT 1 FROM competition.v_event_current e WHERE e.event_id = ${eventId ?? null}::uuid AND e.status <> 'DRAFT')) AS ok`.execute(
      ctx.trx,
    );
    return rows[0]?.ok === true;
  }

  /** INTERNAL / staff: one run with its canonical outcome and trace (history is never re-rendered). */
  async runDetail(
    actor: EvidenceActor,
    runId: string,
  ): Promise<VerificationRunView & { trace: VerificationTrace; freshness: VerificationFreshness }> {
    const r = await this.tx(
      async (
        ctx,
      ): Promise<
        Committed<
          VerificationRunView & { trace: VerificationTrace; freshness: VerificationFreshness }
        >
      > => {
        const { rows } = UUID.test(runId)
          ? await sql<StoredRun>`${RUN_SELECT} WHERE r.id = ${runId}`.execute(ctx.trx)
          : { rows: [] as StoredRun[] };
        const run = rows[0];
        const rv =
          run === undefined ? undefined : await resolveResultVersion(ctx, run.result_version_id);
        const path = rv === undefined ? undefined : await resultVersionPath(ctx, rv);
        if (run === undefined || !(await this.staffAllowed(ctx, actor, path?.competitionId))) {
          await this.denied(ctx, actor, 'verification.run-read', 'VERIFICATION_RUN');
          return {
            error: new DomainError(DomainErrorCode.NOT_FOUND, 'verification run not found'),
          };
        }
        const { rows: t } = await sql<{ trace: VerificationTrace; trace_hash: string }>`
        SELECT trace, trace_hash FROM verification.run_trace WHERE run_id = ${runId}`.execute(
          ctx.trx,
        );
        const trace = t[0];
        if (
          trace === undefined ||
          hashTrace(trace.trace) !== run.trace_hash ||
          hashOutcome(run.outcome) !== run.outcome_hash
        )
          return {
            error: new DomainError(
              DomainErrorCode.VERIFICATION_INTEGRITY_FAILURE,
              'stored run documents do not match their hashes',
              {
                reason: 'RUN_HASH_MISMATCH',
              },
            ),
          };
        const f = await this.freshness(ctx, run.result_version_id);
        const freshness: VerificationFreshness = f.latest?.id === run.id ? f.freshness : 'STALE';
        return { ok: { ...toRunView(run, false), trace: trace.trace, freshness } };
      },
    );
    return unwrap(r);
  }

  /** INTERNAL / staff: every run of a result version (newest first) with freshness of the latest. */
  async history(actor: EvidenceActor, resultVersionId: string) {
    const r = await this.tx(
      async (
        ctx,
      ): Promise<
        Committed<{
          freshness: VerificationFreshness;
          runs: Omit<VerificationRunView, 'outcome'>[];
        }>
      > => {
        const rv = await resolveResultVersion(ctx, resultVersionId);
        const path = rv === undefined ? undefined : await resultVersionPath(ctx, rv);
        if (rv === undefined || !(await this.staffAllowed(ctx, actor, path?.competitionId))) {
          await this.denied(ctx, actor, 'verification.history-read', 'RESULT_VERSION');
          return { error: notFound() };
        }
        const { rows } =
          await sql<StoredRun>`${RUN_SELECT} WHERE r.result_version_id = ${resultVersionId}
        ORDER BY r.recorded_at DESC, r.id DESC`.execute(ctx.trx);
        const f = await this.freshness(ctx, resultVersionId);
        return {
          ok: {
            freshness: f.freshness,
            runs: rows.map((x) => {
              const { outcome: _o, ...rest } = toRunView(x, false);
              void _o;
              return rest;
            }),
          },
        };
      },
    );
    return unwrap(r);
  }

  /** PUBLIC: published / retired policy versions of a policy (declarative specs are public-safe). */
  async publicPolicy(code: string) {
    if (!POLICY_CODE.test(code))
      throw new DomainError(DomainErrorCode.NOT_FOUND, 'policy not found');
    return this.tx(async (ctx) => {
      const { rows } = await sql<{
        policy_id: string;
        name: string;
        version: number;
        policy_version_id: string;
        spec: PolicySpec;
        spec_hash: string;
        status: string;
      }>`
        SELECT p.id AS policy_id, p.name, v.version, v.id AS policy_version_id, v.spec, v.spec_hash, c.status
        FROM verification.policy p
        JOIN verification.policy_version v ON v.policy_id = p.id
        JOIN verification.v_policy_version_current c ON c.policy_version_id = v.id
        WHERE p.code = ${code} AND c.status <> 'DRAFT' ORDER BY v.version`.execute(ctx.trx);
      if (rows[0] === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'policy not found');
      return {
        schema: 'br:public-verification-policy@1',
        code,
        name: rows[0].name,
        notice:
          'A verification policy is a declarative, versioned list of BRT-01 criteria per level. It is not a score.',
        versions: rows.map((r) => ({
          policyVersionId: r.policy_version_id,
          version: r.version,
          status: r.status,
          specHash: r.spec_hash,
          spec: r.spec,
        })),
      };
    });
  }
}

/**
 * BRT-07 hash-based freshness of the latest run of an exact ResultVersion under the CURRENTLY
 * applicable policy (CURRENT / STALE / NOT_EVALUATED), computed by re-assembling the current snapshot
 * in the caller's transaction (which must run as br_verification). Exported for BRT-08, which needs
 * "is this VerificationRun CURRENT?" before issuing an Achievement; behaviour is exactly the
 * VerificationService's own freshness.
 */
export async function currentVerificationFreshness(ctx: TxContext, resultVersionId: string) {
  const rv = await resolveResultVersion(ctx, resultVersionId);
  if (rv === undefined) throw notFound();
  const path = await resultVersionPath(ctx, rv);
  const dv = await disciplineVersionOf(ctx, path);
  const resolution = await resolveApplicablePolicy(ctx, dv.disciplineVersionId, ctx.txTime);
  const { rows } = await sql<StoredRun>`${RUN_SELECT} WHERE r.result_version_id = ${resultVersionId}
    ORDER BY r.recorded_at DESC, r.id DESC LIMIT 1`.execute(ctx.trx);
  const latest = rows[0];
  if (!resolution.ok)
    return {
      path,
      latest,
      resolution,
      freshness: latest === undefined ? 'NOT_EVALUATED' : 'STALE',
    } as const;
  if (latest === undefined)
    return { path, latest, resolution, freshness: 'NOT_EVALUATED' } as const;
  if (
    latest.policy_version_id !== resolution.policy.policyVersionId ||
    latest.engine_version !== ENGINE_VERSION
  )
    return { path, latest, resolution, freshness: 'STALE' } as const;
  const raw = await loadRawVerificationFacts(ctx, rv, resolution.policy);
  const hash = assembleSnapshot(raw, ctx.txTime, 'CURRENT').snapshotHash;
  return {
    path,
    latest,
    resolution,
    freshness: hash === latest.snapshot_hash ? 'CURRENT' : 'STALE',
  } as const;
}

/** PUBLIC run summary (br_public_read): only visible competitions / events; never the trace. */
export class VerificationPublicReader {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async runSummary(runId: string) {
    if (!UUID.test(runId)) return undefined;
    return inTransaction(this.db, ModuleRole.publicRead, async (ctx) => {
      const { rows } = await sql<{
        run_id: string;
        result_version_id: string;
        competition_id: string;
        event_id: string | null;
        contest_id: string | null;
        policy_code: string;
        policy_version: number;
        engine_version: string;
        evaluation_state: string;
        highest_level: VerificationLevel | null;
        evaluated_as_of: Date;
        public_body: PublicVerificationBody;
        competition_name: string;
        event_name: string | null;
      }>`
        SELECT s.*, cc.name AS competition_name, es.name AS event_name
        FROM verification_read.run_summary s
        JOIN competition_read.competition_card cc ON cc.competition_id = s.competition_id AND cc.status <> 'DRAFT'
        LEFT JOIN competition_read.event_summary es ON es.event_id = s.event_id
        WHERE s.run_id = ${runId}::uuid AND (s.event_id IS NULL OR es.status <> 'DRAFT')`.execute(
        ctx.trx,
      );
      const r = rows[0];
      if (r === undefined) return undefined;
      return {
        schema: 'br:public-verification-run@1' as const,
        runId: r.run_id,
        historical: true,
        notice: PUBLIC_VERIFICATION_NOTICE,
        context: {
          resultVersionId: r.result_version_id,
          competition: { competitionId: r.competition_id, name: r.competition_name },
          ...(r.event_id === null ? {} : { event: { eventId: r.event_id, name: r.event_name } }),
          ...(r.contest_id === null ? {} : { contestId: r.contest_id }),
        },
        policy: { code: r.policy_code, version: r.policy_version },
        engineVersion: r.engine_version,
        evaluatedAsOf: r.evaluated_as_of.toISOString(),
        ...r.public_body,
        statement:
          r.highest_level === null
            ? 'The claim prerequisites of V0 could not be established from canonical facts at this evaluation.'
            : `Evaluation under policy ${r.policy_code} v${r.policy_version}: canonical facts known at ${r.evaluated_as_of.toISOString()} satisfied ${VERIFICATION_LEVEL_LABEL[r.highest_level]} (${r.highest_level}).`,
      };
    });
  }
}
