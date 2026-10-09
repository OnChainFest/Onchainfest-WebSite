import {
  assessRecordSupport,
  categoryFloor,
  evaluateRecord,
  hashMarkCandidate,
  markIdentityOf,
  ratificationHash,
  recordBlockingReasons,
  replayRecordHistory,
  requiresV4,
  sealRecordSnapshot,
  type RecordEvaluation,
  type RecordSupportAssessment,
  type RecordSupportFacts,
  type SealedRecordSnapshot,
} from '@br/records';
import {
  DomainError,
  DomainErrorCode,
  newId,
  type DomainEvent,
  type RecordEvaluationState,
  type Uuid,
} from '@br/domain';
import { SchemaRef } from '@br/schemas';
import { sql } from 'kysely';
import { loadVersionFacts, verificationSummary } from './achievement-loader';
import type { Db } from './db';
import {
  competitionPermissionSet,
  type Committed,
  type EvidenceActor,
  unwrap,
} from './evidence-support';
import { factHash } from './hashing';
import { lockKeys, recordAudit } from './identity-support';
import { openStream, StreamType } from './ledger';
import { emitEvent } from './outbox';
import {
  applicableCategoryVersions,
  assembleRecordSnapshot,
  categoryMarks,
  loadCategoryVersion,
  replayInputOf,
  type CategoryMarkFacts,
} from './record-loader';
import { refreshCategoryCard, refreshMarkCard } from './record-projection';
import { inTransaction, ModuleRole, type TxContext } from './tx';

/**
 * BRT-09 record persistence.
 *
 * There is NO generic insert, set-current, force-record, force-ratified or override path. Record facts
 * are written only here, and only from a sealed RecordEvaluationSnapshot whose outcome the pure engine
 * reproduces byte-for-byte:
 *   · establish  QUALIFIES in ESTABLISH mode ⇒ one PENDING_RATIFICATION mark (natural identity)
 *   · ratify     QUALIFIES in RATIFY mode ⇒ one RATIFIED / CANONICAL entry pinning the ratification
 *                (the database requires a canonical RECORD_RATIFIED / REVIEW_COMPLETED attestation about
 *                the mark — the producer does not exist yet, so a normal database ratifies nothing)
 *   · rescind    only from an assessed support fact whose action is RESCIND (basis invalidated)
 *   · replay     the deterministic chronological replay of the category (RC-1…RC-3) appends
 *                SUPERSEDED / restoration entries — never edits history
 * The RECORD_SET Achievement is derived by the Achievement module (its own validated writer) reacting
 * to RecordMarkRatified; records never write achievement facts (ADR-0045).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const integrity = (reason: string, message: string) =>
  new DomainError(DomainErrorCode.RECORD_INTEGRITY_FAILURE, message, { reason });

export interface RecordEvaluationReport {
  readonly categoryId: string;
  readonly categoryCode: string;
  readonly categoryVersionId: string;
  readonly resultVersionId: string;
  readonly participantId: string;
  readonly performanceOrdinal: number;
  readonly mode: 'ESTABLISH' | 'RATIFY';
  readonly state: RecordEvaluationState;
  readonly markStatus?: string;
  readonly blockedBy: readonly string[];
  readonly snapshotHash: string;
  readonly outcomeHash: string;
  readonly provenance: 'CANONICAL_ASSEMBLY' | 'REFERENCE_FIXTURE';
  readonly recordMarkId?: string;
  readonly created: boolean;
}

// ───────────────────────────── validation ─────────────────────────────

/** The evaluation must be exactly what the engine derives from the sealed snapshot. */
export function validateRecordEvaluation(sealed: SealedRecordSnapshot, ev: RecordEvaluation): void {
  if (ev.snapshotHash !== sealed.snapshotHash)
    throw integrity('SNAPSHOT_HASH_MISMATCH', 'evaluation does not belong to this snapshot');
  const again = evaluateRecord(sealed.snapshot);
  if (again.outcomeHash !== ev.outcomeHash)
    throw integrity('OUTCOME_NOT_REPRODUCIBLE', 'record evaluation outcome does not reproduce');
  const c = ev.outcome.candidate;
  if (c !== undefined) {
    if (hashMarkCandidate(c.candidate) !== c.candidateHash)
      throw integrity('CANDIDATE_HASH_MISMATCH', 'mark candidate hash does not recompute');
    const p = sealed.snapshot.performance;
    // RecordMark.value is EXACTLY the canonical source value; holder / basis are the snapshot's.
    if (
      JSON.stringify(c.candidate.value) !== JSON.stringify(p.mark) ||
      c.candidate.basis.resultVersionId !== p.resultVersionId ||
      c.candidate.basis.contentHash !== p.contentHash ||
      c.candidate.basis.participantId !== p.participantId ||
      c.candidate.basis.performanceOrdinal !== p.ordinal ||
      c.candidate.provenance !== sealed.snapshot.provenance
    )
      throw integrity(
        'CANDIDATE_BASIS_MISMATCH',
        'mark candidate does not match the snapshot facts',
      );
    const id = markIdentityOf({
      categoryId: c.candidate.category.categoryId,
      holder: c.candidate.holder,
      value: c.candidate.value,
      resultVersionId: c.candidate.basis.resultVersionId,
      contentHash: c.candidate.basis.contentHash,
      participantId: c.candidate.basis.participantId,
      performanceOrdinal: c.candidate.basis.performanceOrdinal,
    });
    if (id.identityHash !== c.identityHash)
      throw integrity('IDENTITY_HASH_MISMATCH', 'mark identity does not recompute');
  }
}

// ───────────────────────────── ledger helpers ─────────────────────────────

async function appendLedger(
  ctx: TxContext,
  categoryId: string,
  eventType: string,
  factTable: string,
  factRowId: string,
  payloadHash: string,
) {
  const stream = await openStream(ctx, categoryId as Uuid, StreamType.RECORD_CATEGORY);
  await stream.append({ eventType, factTable, factRowId: factRowId as Uuid, payloadHash });
  await stream.close();
}

interface StatusEntryInput {
  readonly recordMarkId: string;
  readonly categoryId: string;
  readonly status: 'PENDING_RATIFICATION' | 'RATIFIED' | 'CANONICAL' | 'SUPERSEDED' | 'RESCINDED';
  readonly reasons?: readonly string[];
  readonly effectiveTo?: Date;
  readonly supersededByMarkId?: string;
  readonly restoration?: boolean;
  readonly ratification?: Record<string, unknown>;
  readonly ratificationHash?: string;
  readonly ratificationProvenance?: string;
  readonly ratificationRef?: string;
  readonly evaluationSnapshotHash?: string;
  readonly evaluationOutcomeHash?: string;
  readonly verificationRunId?: string;
  readonly verificationLevel?: string;
  readonly replayHash?: string;
  readonly supportFactsHash?: string;
  readonly provenance: string;
}

async function appendStatus(ctx: TxContext, e: StatusEntryInput): Promise<string> {
  const id = newId();
  const reasons = [...new Set(e.reasons ?? [])].sort();
  await sql`INSERT INTO record.mark_status_entry
      (id, record_mark_id, status, reasons, effective_to, superseded_by_mark_id, restoration, ratification,
       ratification_hash, ratification_provenance, ratification_ref, evaluation_snapshot_hash,
       evaluation_outcome_hash, verification_run_id, ratification_run_level, replay_hash, support_facts_hash,
       assessment_provenance, recorded_at)
    VALUES (${id}, ${e.recordMarkId}, ${e.status}, ${reasons}, ${e.effectiveTo ?? null},
            ${e.supersededByMarkId ?? null}, ${e.restoration ?? false},
            ${e.ratification === undefined ? null : JSON.stringify(e.ratification)}, ${e.ratificationHash ?? null},
            ${e.ratificationProvenance ?? null}, ${e.ratificationRef ?? null}, ${e.evaluationSnapshotHash ?? null},
            ${e.evaluationOutcomeHash ?? null}, ${e.verificationRunId ?? null}, ${e.verificationLevel ?? null},
            ${e.replayHash ?? null}, ${e.supportFactsHash ?? null}, ${e.provenance}, ${ctx.txTime})`.execute(
    ctx.trx,
  );
  await appendLedger(
    ctx,
    e.categoryId,
    'RecordMarkStatusRecorded',
    'record.mark_status_entry',
    id,
    factHash(SchemaRef.recordMarkStatusFact, {
      statusEntryId: id,
      recordMarkId: e.recordMarkId,
      status: e.status,
      reasons,
      ...(e.effectiveTo === undefined ? {} : { effectiveTo: e.effectiveTo.toISOString() }),
      ...(e.supersededByMarkId === undefined ? {} : { supersededByMarkId: e.supersededByMarkId }),
      ...(e.ratificationHash === undefined ? {} : { ratificationHash: e.ratificationHash }),
      ...(e.replayHash === undefined ? {} : { replayHash: e.replayHash }),
      ...(e.supportFactsHash === undefined ? {} : { supportFactsHash: e.supportFactsHash }),
    }),
  );
  return id;
}

async function addDependency(
  ctx: TxContext,
  recordMarkId: string,
  type:
    'RESULT_VERSION' | 'VERIFICATION_RUN' | 'CATEGORY_VERSION' | 'RATIFICATION' | 'CORRECTS_MARK',
  dependencyId: string,
  hash?: string,
) {
  await sql`INSERT INTO record.mark_dependency (record_mark_id, dependency_type, dependency_id, dependency_hash, recorded_at)
    VALUES (${recordMarkId}, ${type}, ${dependencyId}, ${hash ?? null}, ${ctx.txTime})
    ON CONFLICT DO NOTHING`.execute(ctx.trx);
}

async function logEvaluation(
  ctx: TxContext,
  sealed: SealedRecordSnapshot,
  ev: RecordEvaluation,
  recordMarkId: string | undefined,
) {
  const o = ev.outcome;
  const s = sealed.snapshot;
  await sql`INSERT INTO record.evaluation
      (id, category_id, category_version_id, result_version_id, participant_id, performance_ordinal, mode, state,
       reasons, considered_mark_ids, record_mark_id, engine_version, snapshot_hash, outcome_hash, outcome, provenance,
       recorded_at)
    VALUES (${newId()}, ${s.category.categoryId}, ${s.category.categoryVersionId}, ${o.resultVersionId},
            ${o.participantId}, ${o.performanceOrdinal}, ${o.mode}, ${o.state}, ${recordBlockingReasons(o)},
            ${(o.comparison?.currentMarks ?? []).map((m) => m.recordMarkId)}, ${recordMarkId ?? null},
            ${o.engineVersion}, ${ev.snapshotHash}, ${ev.outcomeHash}, ${JSON.stringify(o)}, ${s.provenance},
            ${ctx.txTime})
    ON CONFLICT ON CONSTRAINT record_evaluation_identity_key DO NOTHING`.execute(ctx.trx);
}

// ───────────────────────────── the only mark writer ─────────────────────────────

async function establishMark(
  ctx: TxContext,
  sealed: SealedRecordSnapshot,
  ev: RecordEvaluation,
  actorAccountId: string | undefined,
): Promise<{ recordMarkId: string; created: boolean }> {
  const entry = ev.outcome.candidate;
  if (ev.outcome.state !== 'QUALIFIES' || ev.outcome.mode !== 'ESTABLISH' || entry === undefined)
    throw integrity('NOT_ESTABLISHABLE', 'only a QUALIFYING ESTABLISH evaluation creates a mark');
  const c = entry.candidate;
  const s = sealed.snapshot;
  const { rows: existing } = await sql<{ id: string }>`
    SELECT id FROM record.record_mark WHERE identity_hash = ${entry.identityHash}`.execute(ctx.trx);
  if (existing[0] !== undefined) return { recordMarkId: existing[0].id, created: false };
  const id = newId();
  await sql`INSERT INTO record.record_mark
      (id, identity_hash, mark_hash, candidate, category_id, category_version_id, category_spec_hash, scope_type,
       engine_version, holder_type, holder_id, value, mark_metric_id, comparator, tie_policy, result_version_id,
       content_hash, participant_id, performance_ordinal, verification_run_id, basis_level, evidence_commitment,
       competition_id, event_id, discipline_version_id, effective_from, evaluation_snapshot_hash,
       evaluation_outcome_hash, provenance, requested_by_account_id, recorded_at)
    VALUES (${id}, ${entry.identityHash}, ${entry.candidateHash}, ${JSON.stringify(c)}, ${c.category.categoryId},
            ${c.category.categoryVersionId}, ${c.category.specHash}, ${c.scopeType}, ${c.engineVersion},
            ${c.holder.holderType}, ${c.holder.holderId}, ${JSON.stringify(c.value)}, ${c.value.metricId},
            ${c.comparator}, ${c.tiePolicy}, ${c.basis.resultVersionId}, ${c.basis.contentHash},
            ${c.basis.participantId}, ${c.basis.performanceOrdinal}, ${c.basis.verificationRunId}, ${c.basisLevel},
            ${c.evidenceCommitment}, ${c.context.competitionId}, ${c.context.eventId ?? null},
            ${c.context.disciplineVersionId}, ${c.effectiveFrom}, ${sealed.snapshotHash}, ${ev.outcomeHash},
            ${c.provenance}, ${actorAccountId ?? null}, ${ctx.txTime})`.execute(ctx.trx);
  for (const m of c.memberCredits ?? [])
    await sql`INSERT INTO record.mark_member_credit (record_mark_id, athlete_id, credit_role, recorded_at)
      VALUES (${id}, ${m.athleteId}, ${m.creditRole}, ${ctx.txTime})`.execute(ctx.trx);
  await appendLedger(
    ctx,
    c.category.categoryId,
    'RecordMarkEstablished',
    'record.record_mark',
    id,
    factHash(SchemaRef.recordMarkFact, {
      recordMarkId: id,
      identityHash: entry.identityHash,
      markHash: entry.candidateHash,
      evaluationSnapshotHash: sealed.snapshotHash,
      evaluationOutcomeHash: ev.outcomeHash,
      provenance: c.provenance,
    }),
  );
  await appendStatus(ctx, {
    recordMarkId: id,
    categoryId: c.category.categoryId,
    status: 'PENDING_RATIFICATION',
    reasons: ['AWAITING_RATIFICATION'],
    evaluationSnapshotHash: sealed.snapshotHash,
    evaluationOutcomeHash: ev.outcomeHash,
    verificationRunId: c.basis.verificationRunId,
    verificationLevel: c.basis.verificationLevel,
    provenance: c.provenance,
  });
  await addDependency(ctx, id, 'RESULT_VERSION', c.basis.resultVersionId, c.basis.contentHash);
  await addDependency(
    ctx,
    id,
    'VERIFICATION_RUN',
    c.basis.verificationRunId,
    c.basis.verificationOutcomeHash,
  );
  await addDependency(
    ctx,
    id,
    'CATEGORY_VERSION',
    c.category.categoryVersionId,
    c.category.specHash,
  );
  // Correction path: a mark of the same holder in this category whose basis is the version this
  // performance's ResultVersion corrects (the sealed snapshot's correction fact, as in BRT-08) will
  // be replaced once THIS mark is ratified.
  const supersedesRv = s.performance.supersedesVersionId;
  if (supersedesRv !== undefined) {
    const { rows: corrected } = await sql<{ id: string }>`
      SELECT m.id FROM record.record_mark m
      WHERE m.result_version_id = ${supersedesRv} AND m.category_id = ${c.category.categoryId}
        AND m.holder_type = ${c.holder.holderType} AND m.holder_id = ${c.holder.holderId}
        AND m.provenance = ${c.provenance} AND m.id <> ${id}
      ORDER BY m.id`.execute(ctx.trx);
    for (const r of corrected) await addDependency(ctx, id, 'CORRECTS_MARK', r.id);
  }
  await emitEvent(ctx, {
    eventType: 'RecordMarkPendingRatification',
    aggregateType: 'RECORD_MARK',
    aggregateId: id as Uuid,
    payload: {
      recordMarkId: id,
      categoryId: c.category.categoryId,
      categoryVersionId: c.category.categoryVersionId,
      resultVersionId: c.basis.resultVersionId,
      markHash: entry.candidateHash,
      provenance: s.provenance,
    },
  });
  await refreshMarkCard(ctx, id);
  await refreshCategoryCard(ctx, c.category.categoryId);
  return { recordMarkId: id, created: true };
}

async function ratifyMark(
  ctx: TxContext,
  sealed: SealedRecordSnapshot,
  ev: RecordEvaluation,
): Promise<{ recordMarkId: string; created: boolean }> {
  const s = sealed.snapshot;
  const pm = s.pendingMark;
  const r = ev.outcome.ratification;
  const rat = s.ratification;
  if (
    ev.outcome.state !== 'QUALIFIES' ||
    ev.outcome.mode !== 'RATIFY' ||
    pm === undefined ||
    r === undefined ||
    rat === undefined
  )
    throw integrity('NOT_RATIFIABLE', 'only a QUALIFYING RATIFY evaluation ratifies a mark');
  const { rows: marks } = await sql<{ mark_hash: string; category_id: string; provenance: string }>`
    SELECT mark_hash, category_id, provenance FROM record.record_mark WHERE id = ${pm.recordMarkId}`.execute(
    ctx.trx,
  );
  const m = marks[0];
  if (m === undefined || m.mark_hash !== pm.markHash || m.category_id !== s.category.categoryId)
    throw integrity('PENDING_MARK_MISMATCH', 'the pending mark does not match the snapshot');
  const { rows: prior } = await sql<{ ratification_ref: string }>`
    SELECT ratification_ref FROM record.mark_status_entry WHERE record_mark_id = ${pm.recordMarkId}
      AND ratification_ref IS NOT NULL`.execute(ctx.trx);
  if (prior[0] !== undefined) {
    // Replayed delivery of the SAME ratification ⇒ no second transition (idempotent).
    if (prior[0].ratification_ref === r.ref)
      return { recordMarkId: pm.recordMarkId, created: false };
    throw new DomainError(DomainErrorCode.INVALID_TRANSITION, 'the mark is already ratified');
  }
  const { rows: latest } = await sql<{ status: string }>`
    SELECT status FROM record.mark_status_entry WHERE record_mark_id = ${pm.recordMarkId}
    ORDER BY seq DESC LIMIT 1`.execute(ctx.trx);
  if (latest[0]?.status !== 'PENDING_RATIFICATION')
    throw new DomainError(
      DomainErrorCode.INVALID_TRANSITION,
      'only a pending mark can be ratified',
    );
  const vs = s.verification;
  const doc = {
    recordMarkId: pm.recordMarkId,
    markHash: pm.markHash,
    provenance: rat.provenance,
    kind: r.kind,
    ref: r.ref,
    subjectHash: r.subjectHash,
    standing: r.standing,
    authorityProofDigest: r.authorityProofDigest,
    evaluationSnapshotHash: sealed.snapshotHash,
    evaluationOutcomeHash: ev.outcomeHash,
    verificationRunId: vs.runId as string,
    verificationLevel: vs.level as 'V2' | 'V3' | 'V4',
  };
  const hash = ratificationHash(doc);
  await appendStatus(ctx, {
    recordMarkId: pm.recordMarkId,
    categoryId: m.category_id,
    status: r.standing,
    reasons: [
      r.standing === 'CANONICAL' ? 'RATIFIED_BY_CANONICAL_KEEPER' : 'RATIFIED_BY_AUTHORITY',
      ...(r.platformReview === true ? ['PLATFORM_REVIEW'] : []),
    ],
    ratification: doc,
    ratificationHash: hash,
    ratificationProvenance: rat.provenance,
    ratificationRef: r.ref,
    evaluationSnapshotHash: sealed.snapshotHash,
    evaluationOutcomeHash: ev.outcomeHash,
    verificationRunId: vs.runId as string,
    verificationLevel: vs.level as string,
    provenance: m.provenance,
  });
  await addDependency(ctx, pm.recordMarkId, 'RATIFICATION', r.ref, hash);
  await addDependency(ctx, pm.recordMarkId, 'VERIFICATION_RUN', vs.runId as string, vs.outcomeHash);
  await emitEvent(ctx, {
    eventType: r.standing === 'CANONICAL' ? 'RecordMarkCanonicalized' : 'RecordMarkRatified',
    aggregateType: 'RECORD_MARK',
    aggregateId: pm.recordMarkId as Uuid,
    payload: {
      recordMarkId: pm.recordMarkId,
      categoryId: m.category_id,
      resultVersionId: s.performance.resultVersionId,
      standing: r.standing,
      ratificationHash: hash,
      provenance: m.provenance,
    },
  });
  // Correction replacement: the ratified corrected mark replaces the mark(s) it corrects.
  const { rows: corrects } = await sql<{ dependency_id: string; effective_from: Date }>`
    SELECT d.dependency_id, n.effective_from FROM record.mark_dependency d
    JOIN record.record_mark n ON n.id = d.record_mark_id
    WHERE d.record_mark_id = ${pm.recordMarkId} AND d.dependency_type = 'CORRECTS_MARK'
    ORDER BY d.dependency_id`.execute(ctx.trx);
  for (const x of corrects) {
    await sql`INSERT INTO record.mark_supersession (superseded_mark_id, superseding_mark_id, kind, recorded_at)
      VALUES (${x.dependency_id}, ${pm.recordMarkId}, 'CORRECTION', ${ctx.txTime}) ON CONFLICT DO NOTHING`.execute(
      ctx.trx,
    );
    const { rows: st } = await sql<{ status: string }>`
      SELECT status FROM record.mark_status_entry WHERE record_mark_id = ${x.dependency_id} ORDER BY seq DESC LIMIT 1`.execute(
      ctx.trx,
    );
    if (
      st[0]?.status === 'RATIFIED' ||
      st[0]?.status === 'CANONICAL' ||
      st[0]?.status === 'SUPERSEDED'
    )
      await appendStatus(ctx, {
        recordMarkId: x.dependency_id,
        categoryId: m.category_id,
        status: 'SUPERSEDED',
        reasons: ['CORRECTED_BY_NEW_MARK'],
        effectiveTo: x.effective_from,
        supersededByMarkId: pm.recordMarkId,
        provenance: m.provenance,
      });
    else if (st[0]?.status === 'PENDING_RATIFICATION')
      await appendStatus(ctx, {
        recordMarkId: x.dependency_id,
        categoryId: m.category_id,
        status: 'RESCINDED',
        reasons: ['BASIS_RESULT_SUPERSEDED', 'CORRECTED_BY_NEW_MARK'],
        provenance: m.provenance,
      });
    await refreshMarkCard(ctx, x.dependency_id);
  }
  await replayCategory(
    ctx,
    m.category_id,
    m.provenance as 'CANONICAL_ASSEMBLY' | 'REFERENCE_FIXTURE',
  );
  await refreshMarkCard(ctx, pm.recordMarkId);
  return { recordMarkId: pm.recordMarkId, created: true };
}

/**
 * Deterministic chronological replay of one category (RC-1…RC-3). Appends only the status entries
 * whose replayed state differs from the latest recorded one: SUPERSEDED (effectiveTo, successor,
 * supersession link), a restoration that re-opens a ratified mark's period (the closed effectiveTo
 * stays in history), or a re-supersession when intermediate history changed. Never edits a row.
 */
export async function replayCategory(
  ctx: TxContext,
  categoryId: string,
  provenance: 'CANONICAL_ASSEMBLY' | 'REFERENCE_FIXTURE',
): Promise<{ changed: string[]; current: string[] }> {
  await lockKeys(ctx, `record-category-marks:${categoryId}`);
  const all = (await categoryMarks(ctx, categoryId)).filter((m) => m.provenance === provenance);
  const { rows: meta } = await sql<{
    tie_policy: 'SHARED' | 'FIRST_ACHIEVED';
    comparator: 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER';
  }>`
    SELECT tie_policy, comparator FROM record.record_mark WHERE category_id = ${categoryId} LIMIT 1`.execute(
    ctx.trx,
  );
  if (meta[0] === undefined) return { changed: [], current: [] };
  const before = all
    .filter((m) => m.latestStatus === 'RATIFIED' || m.latestStatus === 'CANONICAL')
    .map((m) => m.recordMarkId)
    .sort();
  const input = replayInputOf(categoryId, meta[0].tie_policy, meta[0].comparator, all);
  const r = replayRecordHistory(input);
  const byId = new Map<string, CategoryMarkFacts>(all.map((m) => [m.recordMarkId, m]));
  const changed: string[] = [];
  for (const st of r.marks) {
    const m = byId.get(st.recordMarkId);
    if (m === undefined || m.ratification === undefined) continue;
    const isCur = m.latestStatus === 'RATIFIED' || m.latestStatus === 'CANONICAL';
    if (st.current) {
      if (m.latestStatus === 'SUPERSEDED') {
        await appendStatus(ctx, {
          recordMarkId: m.recordMarkId,
          categoryId,
          status: m.ratification.standing,
          reasons: ['RESTORED_BY_REPLAY'],
          restoration: true,
          ratificationHash: m.ratification.hash,
          replayHash: r.replayHash,
          provenance,
        });
        await emitEvent(ctx, {
          eventType: 'RecordMarkRestored',
          aggregateType: 'RECORD_MARK',
          aggregateId: m.recordMarkId as Uuid,
          payload: { recordMarkId: m.recordMarkId, categoryId, replayHash: r.replayHash },
        });
        changed.push(m.recordMarkId);
      }
      continue;
    }
    const effectiveTo = new Date(st.effectiveTo as string);
    const successor = st.supersededBy as string;
    const same =
      m.latestStatus === 'SUPERSEDED' &&
      m.latestSupersededBy === successor &&
      m.latestEffectiveTo?.getTime() === effectiveTo.getTime();
    if (!isCur && (m.latestStatus !== 'SUPERSEDED' || same)) continue;
    await sql`INSERT INTO record.mark_supersession (superseded_mark_id, superseding_mark_id, kind, recorded_at)
      VALUES (${m.recordMarkId}, ${successor}, 'BETTER_MARK', ${ctx.txTime}) ON CONFLICT DO NOTHING`.execute(
      ctx.trx,
    );
    await appendStatus(ctx, {
      recordMarkId: m.recordMarkId,
      categoryId,
      status: 'SUPERSEDED',
      reasons: [
        st.held ? 'SUPERSEDED_BY_BETTER_MARK' : 'NEVER_HELD',
        ...(st.cause === 'EQUAL_FIRST_ACHIEVED' ? ['FIRST_ACHIEVER_KEEPS_RECORD'] : []),
      ],
      effectiveTo,
      supersededByMarkId: successor,
      replayHash: r.replayHash,
      provenance,
    });
    await emitEvent(ctx, {
      eventType: 'RecordMarkSuperseded',
      aggregateType: 'RECORD_MARK',
      aggregateId: m.recordMarkId as Uuid,
      payload: {
        recordMarkId: m.recordMarkId,
        categoryId,
        supersededByMarkId: successor,
        effectiveTo: effectiveTo.toISOString(),
        replayHash: r.replayHash,
      },
    });
    changed.push(m.recordMarkId);
  }
  const after = [...r.current].sort();
  if (JSON.stringify(before) !== JSON.stringify(after))
    await emitEvent(ctx, {
      eventType: 'CurrentRecordChanged',
      aggregateType: 'RECORD_CATEGORY',
      aggregateId: categoryId as Uuid,
      payload: { categoryId, previous: before, current: after, replayHash: r.replayHash },
    });
  for (const id of new Set([...changed, ...before, ...after])) await refreshMarkCard(ctx, id);
  await refreshCategoryCard(ctx, categoryId);
  return { changed, current: after };
}

async function rescindMark(
  ctx: TxContext,
  recordMarkId: string,
  assessment: RecordSupportAssessment,
): Promise<boolean> {
  const { rows } = await sql<{
    category_id: string;
    provenance: 'CANONICAL_ASSEMBLY' | 'REFERENCE_FIXTURE';
  }>`
    SELECT category_id, provenance FROM record.record_mark WHERE id = ${recordMarkId}`.execute(
    ctx.trx,
  );
  const m = rows[0];
  if (m === undefined) throw new DomainError(DomainErrorCode.NOT_FOUND, 'record mark not found');
  await lockKeys(ctx, `record-category-marks:${m.category_id}`);
  const { rows: st } = await sql<{ status: string }>`
    SELECT status FROM record.mark_status_entry WHERE record_mark_id = ${recordMarkId} ORDER BY seq DESC LIMIT 1`.execute(
    ctx.trx,
  );
  if (st[0]?.status === 'RESCINDED') return false;
  await appendStatus(ctx, {
    recordMarkId,
    categoryId: m.category_id,
    status: 'RESCINDED',
    reasons: [...assessment.reasons],
    supportFactsHash: assessment.supportFactsHash,
    provenance: m.provenance,
  });
  await emitEvent(ctx, {
    eventType: 'RecordMarkRescinded',
    aggregateType: 'RECORD_MARK',
    aggregateId: recordMarkId as Uuid,
    payload: {
      recordMarkId,
      categoryId: m.category_id,
      reasons: [...assessment.reasons],
      supportFactsHash: assessment.supportFactsHash,
    },
  });
  await replayCategory(ctx, m.category_id, m.provenance);
  await refreshMarkCard(ctx, recordMarkId);
  return true;
}

// ───────────────────────────── persisting one sealed snapshot ─────────────────────────────

async function persistSealedRecord(
  ctx: TxContext,
  sealed: SealedRecordSnapshot,
  actorAccountId: string | undefined,
): Promise<RecordEvaluationReport> {
  const ev = evaluateRecord(sealed.snapshot);
  validateRecordEvaluation(sealed, ev);
  const s = sealed.snapshot;
  await lockKeys(ctx, `record-category-marks:${s.category.categoryId}`);
  let recordMarkId: string | undefined = s.pendingMark?.recordMarkId;
  let created = false;
  if (ev.outcome.state === 'QUALIFIES') {
    const r =
      ev.outcome.mode === 'ESTABLISH'
        ? await establishMark(ctx, sealed, ev, actorAccountId)
        : await ratifyMark(ctx, sealed, ev);
    recordMarkId = r.recordMarkId;
    created = r.created;
  }
  await logEvaluation(ctx, sealed, ev, recordMarkId);
  await emitEvent(ctx, {
    eventType: 'RecordCandidateEvaluated',
    aggregateType: 'RECORD_CATEGORY',
    aggregateId: s.category.categoryId as Uuid,
    payload: {
      categoryVersionId: s.category.categoryVersionId,
      resultVersionId: s.performance.resultVersionId,
      mode: ev.outcome.mode,
      state: ev.outcome.state,
      snapshotHash: ev.snapshotHash,
      outcomeHash: ev.outcomeHash,
    },
  });
  return {
    categoryId: s.category.categoryId,
    categoryCode: s.category.code,
    categoryVersionId: s.category.categoryVersionId,
    resultVersionId: s.performance.resultVersionId,
    participantId: s.performance.participantId,
    performanceOrdinal: s.performance.ordinal,
    mode: ev.outcome.mode,
    state: ev.outcome.state,
    ...(ev.outcome.markStatus === undefined ? {} : { markStatus: ev.outcome.markStatus }),
    blockedBy: recordBlockingReasons(ev.outcome),
    snapshotHash: ev.snapshotHash,
    outcomeHash: ev.outcomeHash,
    provenance: s.provenance,
    ...(recordMarkId === undefined ? {} : { recordMarkId }),
    created,
  };
}

/**
 * REPEATABLE READ record transaction. Every record write of one category is serialized (advisory
 * lock + the category ledger stream), so N concurrent writers of the same category resolve by
 * serialization-failure retries: the budget scales with realistic per-category contention (each round
 * commits at least one writer). Bounded retries on BRT-07 clock-step inconsistency too.
 */
const RECORD_TX_ATTEMPTS = 48;
async function recordTx<T>(db: Db, fn: (ctx: TxContext) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await inTransaction(db, ModuleRole.records, fn, RECORD_TX_ATTEMPTS, {
        isolation: 'repeatable read',
      });
    } catch (err) {
      if (
        !(err instanceof DomainError) ||
        err.code !== DomainErrorCode.VERIFICATION_TIME_INCONSISTENT ||
        attempt >= 3
      )
        throw err;
      await new Promise((resolve) => setTimeout(resolve, attempt * 400));
    }
  }
}

/** Re-assembles the canonical snapshot a CANONICAL_ASSEMBLY claim names, from live facts. */
async function reassembleCanonicalRecord(
  ctx: TxContext,
  claimed: SealedRecordSnapshot,
): Promise<SealedRecordSnapshot> {
  const c = claimed.snapshot;
  const facts = await loadVersionFacts(ctx, c.performance.resultVersionId);
  const category = await loadCategoryVersion(ctx, c.category.categoryVersionId);
  if (facts === undefined || category === undefined)
    throw integrity('CANONICAL_SNAPSHOT_MISMATCH', 'basis or category not found');
  const sealed = await assembleRecordSnapshot(ctx, {
    facts,
    perf: { participantId: c.performance.participantId, ordinal: c.performance.ordinal },
    category,
    verification: await verificationSummary(ctx, facts.rv.resultVersionId),
    ...(c.pendingMark === undefined ? {} : { pendingMark: c.pendingMark }),
  });
  if (sealed === undefined || sealed.snapshotHash !== claimed.snapshotHash)
    throw integrity('CANONICAL_SNAPSHOT_MISMATCH', 'snapshot is not the canonical assembly');
  return sealed;
}

/**
 * Persists one sealed record snapshot through the validated path (ESTABLISH or RATIFY). A
 * CANONICAL_ASSEMBLY snapshot must equal the canonical re-assembly (no caller-supplied sporting
 * facts, no caller-supplied ratification); a REFERENCE_FIXTURE snapshot is refused by the normal
 * schema (CHECK) and succeeds only in a throwaway overlay database. There is no flag that changes this.
 */
export function persistRecordEvaluation(
  db: Db,
  input: { readonly snapshot: unknown; readonly actorAccountId?: string },
): Promise<RecordEvaluationReport> {
  const claimed = sealRecordSnapshot(input.snapshot);
  return recordTx(db, async (ctx) => {
    const sealed =
      claimed.snapshot.provenance === 'CANONICAL_ASSEMBLY'
        ? await reassembleCanonicalRecord(ctx, claimed)
        : claimed;
    return persistSealedRecord(ctx, sealed, input.actorAccountId);
  });
}

/**
 * Records a current-support assessment of a standing mark. Only RESCIND is a persisted consequence
 * (temporary suspension is presented live, never recorded as a rescission). CANONICAL_ASSEMBLY facts
 * must equal the canonical re-computation; REFERENCE_FIXTURE facts are refused by the normal schema.
 */
export function recordMarkSupportAssessment(
  db: Db,
  facts: RecordSupportFacts,
): Promise<{ assessment: RecordSupportAssessment; rescinded: boolean }> {
  return recordTx(db, async (ctx) => {
    const assessment = assessRecordSupport(facts);
    if (facts.provenance === 'CANONICAL_ASSEMBLY') {
      const recomputed = await canonicalRecordSupportFacts(ctx, facts.recordMarkId);
      if (
        recomputed === undefined ||
        assessRecordSupport(recomputed).supportFactsHash !== assessment.supportFactsHash
      )
        throw integrity('CANONICAL_SUPPORT_MISMATCH', 'support facts are not the canonical facts');
    }
    const rescinded =
      assessment.action === 'RESCIND'
        ? await rescindMark(ctx, facts.recordMarkId, assessment)
        : false;
    return { assessment, rescinded };
  });
}

// ───────────────────────────── canonical support facts ─────────────────────────────

async function canonicalRecordSupportFacts(
  ctx: TxContext,
  recordMarkId: string,
): Promise<RecordSupportFacts | undefined> {
  const { rows } = await sql<{
    result_version_id: string;
    participant_id: string;
    performance_ordinal: number;
    category_id: string;
    category_version_id: string;
    holder_type: string;
    holder_id: string;
    provenance: string;
  }>`
    SELECT result_version_id, participant_id, performance_ordinal, category_id, category_version_id, holder_type,
           holder_id, provenance
    FROM record.record_mark WHERE id = ${recordMarkId}`.execute(ctx.trx);
  const m = rows[0];
  if (m === undefined || m.provenance !== 'CANONICAL_ASSEMBLY') return undefined;
  const version = await loadCategoryVersion(ctx, m.category_version_id);
  if (version === undefined) return undefined;
  const facts = await loadVersionFacts(ctx, m.result_version_id);
  if (facts === undefined) return undefined;
  const verification = await verificationSummary(ctx, m.result_version_id);
  const floor = categoryFloor(version.spec);
  let successor: RecordSupportFacts['successor'];
  if (facts.supersededByVersionId !== undefined) {
    successor = 'PENDING';
    const next = await loadVersionFacts(ctx, facts.supersededByVersionId);
    if (next !== undefined) {
      const sealed = await assembleRecordSnapshot(ctx, {
        facts: next,
        perf: { participantId: m.participant_id, ordinal: m.performance_ordinal },
        category: version,
        verification: await verificationSummary(ctx, next.rv.resultVersionId),
      });
      if (sealed === undefined) successor = 'NO_LONGER_QUALIFIES';
      else {
        const st = evaluateRecord(sealed.snapshot).outcome.state;
        successor =
          st === 'QUALIFIES'
            ? 'QUALIFIES'
            : st === 'DOES_NOT_QUALIFY' || st === 'INELIGIBLE'
              ? 'NO_LONGER_QUALIFIES'
              : 'PENDING';
      }
    }
  }
  return {
    provenance: 'CANONICAL_ASSEMBLY',
    recordMarkId,
    requiredLevel: floor,
    ...(requiresV4(version.spec) ? { v4CategoryId: m.category_id } : {}),
    basisStatus: facts.status,
    ...(facts.supersededByVersionId === undefined
      ? {}
      : { supersededByVersionId: facts.supersededByVersionId }),
    verification,
    holdSupported: false,
    ...(successor === undefined ? {} : { successor }),
  };
}

export type RecordSupportSource = (
  ctx: TxContext,
  recordMarkId: string,
) => Promise<RecordSupportFacts | undefined>;
export const canonicalRecordSupportSource: RecordSupportSource = (ctx, id) =>
  canonicalRecordSupportFacts(ctx, id);

/** LIVE current support of one mark (no write) — what reads present. Fails closed. */
export async function liveRecordSupport(
  db: Db,
  recordMarkId: string,
  source: RecordSupportSource = canonicalRecordSupportSource,
): Promise<
  RecordSupportAssessment | { support: 'SUSPENDED'; reasons: readonly string[] } | undefined
> {
  try {
    return await recordTx(db, async (ctx) => {
      const f = await source(ctx, recordMarkId);
      return f === undefined ? undefined : assessRecordSupport(f);
    });
  } catch {
    return { support: 'SUSPENDED', reasons: ['CURRENT_SUPPORT_UNASSESSABLE'] };
  }
}

/** Re-assesses standing marks from a source; persists only rescissions (idempotent). */
export function sweepRecordSupport(
  db: Db,
  source: RecordSupportSource,
  opts: {
    readonly provenance: 'CANONICAL_ASSEMBLY' | 'REFERENCE_FIXTURE';
    readonly resultVersionIds?: readonly string[];
  },
) {
  return recordTx(db, async (ctx) => {
    const { rows } = await sql<{ id: string }>`
      SELECT m.id FROM record.record_mark m JOIN record.v_mark_status st ON st.record_mark_id = m.id
      WHERE st.status IN ('PENDING_RATIFICATION', 'RATIFIED', 'CANONICAL', 'SUPERSEDED')
        AND m.provenance = ${opts.provenance}
        AND (${opts.resultVersionIds === undefined} OR m.result_version_id = ANY(${opts.resultVersionIds ?? []}::uuid[]))
      ORDER BY m.id LIMIT 500`.execute(ctx.trx);
    const out: { recordMarkId: string; support: string; rescinded: boolean }[] = [];
    for (const r of rows) {
      const f = await source(ctx, r.id);
      if (f === undefined) continue;
      const a = assessRecordSupport(f);
      const rescinded = a.action === 'RESCIND' ? await rescindMark(ctx, r.id, a) : false;
      out.push({ recordMarkId: r.id, support: a.support, rescinded });
    }
    return out;
  });
}

// ───────────────────────────── dependency index ─────────────────────────────

/** Which marks depend on ResultVersion X / VerificationRun Y / category version C / ratification R. */
export async function recordDependencyIndex(
  ctx: TxContext,
  q: {
    resultVersionId?: string;
    verificationRunId?: string;
    categoryVersionId?: string;
    ratificationRef?: string;
    recordMarkId?: string;
  },
) {
  const { rows } = await sql<{
    record_mark_id: string;
    dependency_type: string;
    dependency_id: string;
    status: string;
    record_set_achievement_id: string | null;
  }>`
    SELECT d.record_mark_id, d.dependency_type, d.dependency_id, st.status,
           (SELECT b.achievement_id FROM achievement.record_basis b WHERE b.record_mark_id = d.record_mark_id) AS record_set_achievement_id
    FROM record.mark_dependency d
    JOIN record.v_mark_status st ON st.record_mark_id = d.record_mark_id
    WHERE (${q.recordMarkId ?? null}::uuid IS NULL OR d.record_mark_id = ${q.recordMarkId ?? null}::uuid)
      AND (${q.resultVersionId ?? null}::uuid IS NULL OR (d.dependency_type = 'RESULT_VERSION' AND d.dependency_id = ${q.resultVersionId ?? null}::uuid))
      AND (${q.verificationRunId ?? null}::uuid IS NULL OR (d.dependency_type = 'VERIFICATION_RUN' AND d.dependency_id = ${q.verificationRunId ?? null}::uuid))
      AND (${q.categoryVersionId ?? null}::uuid IS NULL OR (d.dependency_type = 'CATEGORY_VERSION' AND d.dependency_id = ${q.categoryVersionId ?? null}::uuid))
      AND (${q.ratificationRef ?? null}::uuid IS NULL OR (d.dependency_type = 'RATIFICATION' AND d.dependency_id = ${q.ratificationRef ?? null}::uuid))
    ORDER BY d.record_mark_id, d.dependency_type, d.dependency_id`.execute(ctx.trx);
  return rows.map((r) => ({
    recordMarkId: r.record_mark_id,
    dependencyType: r.dependency_type,
    dependencyId: r.dependency_id,
    status: r.status,
    ...(r.record_set_achievement_id === null
      ? {}
      : { recordSetAchievementId: r.record_set_achievement_id }),
  }));
}

// ───────────────────────────── canonical production service ─────────────────────────────

export interface ResultVersionRecordEvaluation {
  readonly resultVersionId: string;
  readonly provenance: 'CANONICAL_ASSEMBLY';
  readonly evaluations: readonly RecordEvaluationReport[];
  readonly noApplicableCategory: boolean;
  readonly rescinded: number;
}

const EVALUATION_EVENTS = new Set([
  'VerificationEvaluated',
  'CurrentVerificationChanged',
  'ResultSubmitted',
  'ResultProvisional',
]);
/** Canonical events that can stale a pinned run or invalidate a basis ⇒ support reassessment. */
const SWEEP_EVENTS = new Set([
  'PrincipalKeyStatusChanged',
  'AuthorityGrantRevoked',
  'TrustAnchorChanged',
  'EvidenceAvailabilityChanged',
  'AttestationRetracted',
  'CurrentVerificationChanged',
]);

/**
 * The CANONICAL PRODUCTION lane for records. Evaluates snapshots it assembles itself from real
 * canonical facts (every performance of an exact ResultVersion × every applicable PUBLISHED category
 * version), persists through the validated writer, and reassesses standing marks when their basis
 * changes. Requesting an evaluation confers nothing and chooses nothing: the only input is an exact
 * ResultVersion id. Honest production output today: ZERO marks (no FINAL, no V3/V4, no hold facts, no
 * ratification producer) — every blocker is reported and the evaluation is logged.
 */
export class RecordService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private async staffAllowed(
    ctx: TxContext,
    actor: EvidenceActor,
    competitionId: string | undefined,
  ) {
    if ('internal' in actor) return true;
    if (competitionId === undefined) return false;
    return (await competitionPermissionSet(ctx, actor.accountId, competitionId)).has(
      'COMP_VIEW_PRIVATE',
    );
  }

  /** Records a refused INTERNAL category mutation when no operator connection exists (503) or denied. */
  auditDeniedCategoryMutation(actorAccountId: string | undefined, action: string): Promise<void> {
    return inTransaction(this.db, ModuleRole.records, (ctx) =>
      recordAudit(ctx, {
        ...(actorAccountId === undefined ? {} : { actorAccountId }),
        action,
        targetType: 'RECORD_CATEGORY',
        outcome: 'DENIED',
      }),
    );
  }

  /** Canonical record evaluation for one exact ResultVersion (staff / INTERNAL; the worker uses react). */
  async evaluate(input: {
    readonly actor: EvidenceActor;
    readonly resultVersionId: string;
  }): Promise<ResultVersionRecordEvaluation> {
    const r = await recordTx(
      this.db,
      async (ctx): Promise<Committed<ResultVersionRecordEvaluation>> => {
        const facts = UUID.test(input.resultVersionId)
          ? await loadVersionFacts(ctx, input.resultVersionId)
          : undefined;
        const actorAccountId = 'accountId' in input.actor ? input.actor.accountId : undefined;
        if (
          facts === undefined ||
          !(await this.staffAllowed(ctx, input.actor, facts.path.competitionId))
        ) {
          await recordAudit(ctx, {
            actorAccountId,
            action: 'record.evaluation-requested',
            targetType: 'RESULT_VERSION',
            outcome: 'DENIED',
          });
          return { error: new DomainError(DomainErrorCode.NOT_FOUND, 'result version not found') };
        }
        const out = await this.evaluateInTx(ctx, input.resultVersionId, actorAccountId);
        if (out === undefined)
          return { error: new DomainError(DomainErrorCode.NOT_FOUND, 'result version not found') };
        return { ok: out };
      },
    );
    return unwrap(r);
  }

  private async evaluateInTx(
    ctx: TxContext,
    resultVersionId: string,
    actorAccountId: string | undefined,
  ): Promise<ResultVersionRecordEvaluation | undefined> {
    const facts = await loadVersionFacts(ctx, resultVersionId);
    if (facts === undefined) return undefined;
    const evaluations: RecordEvaluationReport[] = [];
    const perfs = facts.content.performances ?? [];
    const { rows: started } = await sql<{ t: Date | null }>`
      SELECT min(recorded_at) AS t FROM competition.contest_status_change
      WHERE contest_id = ${facts.path.contestId ?? null}::uuid AND status = 'IN_PROGRESS'`.execute(
      ctx.trx,
    );
    const occurredAt = started[0]?.t ?? undefined;
    const versions =
      occurredAt === undefined || perfs.length === 0
        ? []
        : await applicableCategoryVersions(ctx, {
            disciplineVersionId: facts.disciplineVersionId,
            markMetricIds: [...new Set(perfs.map((p) => p.mark.metricId))],
            occurredAt,
          });
    const verification =
      versions.length === 0 ? undefined : await verificationSummary(ctx, resultVersionId);
    for (const category of versions)
      for (const p of perfs) {
        if (p.mark.metricId !== category.spec.universe.metric.markMetricId) continue;
        const sealed = await assembleRecordSnapshot(ctx, {
          facts,
          perf: { participantId: p.participantId, ordinal: p.ordinal },
          category,
          verification: verification ?? { state: 'NOT_EVALUATED' },
        });
        if (sealed === undefined) continue;
        evaluations.push(await persistSealedRecord(ctx, sealed, actorAccountId));
      }
    // Pending marks of this version: attempt RATIFY with canonical facts only (no ratification
    // producer exists ⇒ RATIFICATION_UNAVAILABLE is reported; nothing is fabricated).
    const { rows: pending } = await sql<{
      id: string;
      mark_hash: string;
      identity_hash: string;
      effective_from: Date;
      participant_id: string;
      performance_ordinal: number;
      category_version_id: string;
    }>`
      SELECT m.id, m.mark_hash, m.identity_hash, m.effective_from, m.participant_id, m.performance_ordinal,
             m.category_version_id
      FROM record.record_mark m JOIN record.v_mark_status st ON st.record_mark_id = m.id
      WHERE m.result_version_id = ${resultVersionId} AND st.status = 'PENDING_RATIFICATION'
        AND m.provenance = 'CANONICAL_ASSEMBLY' ORDER BY m.id`.execute(ctx.trx);
    for (const pm of pending) {
      const category = await loadCategoryVersion(ctx, pm.category_version_id);
      if (category === undefined) continue;
      const sealed = await assembleRecordSnapshot(ctx, {
        facts,
        perf: { participantId: pm.participant_id, ordinal: pm.performance_ordinal },
        category,
        verification: verification ?? (await verificationSummary(ctx, resultVersionId)),
        pendingMark: {
          recordMarkId: pm.id,
          markHash: pm.mark_hash,
          identityHash: pm.identity_hash,
          effectiveFrom: pm.effective_from.toISOString(),
        },
      });
      if (sealed !== undefined)
        evaluations.push(await persistSealedRecord(ctx, sealed, actorAccountId));
    }
    await recordAudit(ctx, {
      actorAccountId,
      action: 'record.evaluation-requested',
      targetType: 'RESULT_VERSION',
      targetId: resultVersionId,
      details: {
        evaluations: evaluations.length,
        qualifying: evaluations.filter((e) => e.state === 'QUALIFIES').length,
        noApplicableCategory: versions.length === 0,
      },
    });
    const rescinded = await this.reassessDependents(ctx, [
      resultVersionId,
      facts.supersedesVersionId,
    ]);
    return {
      resultVersionId,
      provenance: 'CANONICAL_ASSEMBLY',
      evaluations,
      noApplicableCategory: versions.length === 0,
      rescinded,
    };
  }

  private async reassessDependents(ctx: TxContext, ids: readonly (string | undefined)[]) {
    const rvs = ids.filter((x): x is string => x !== undefined);
    if (rvs.length === 0) return 0;
    const { rows } = await sql<{ id: string }>`
      SELECT m.id FROM record.record_mark m JOIN record.v_mark_status st ON st.record_mark_id = m.id
      WHERE m.result_version_id = ANY(${rvs}::uuid[]) AND st.status <> 'RESCINDED'
        AND m.provenance = 'CANONICAL_ASSEMBLY' ORDER BY m.id`.execute(ctx.trx);
    let n = 0;
    for (const r of rows) {
      const f = await canonicalRecordSupportFacts(ctx, r.id);
      if (f === undefined) continue;
      const a = assessRecordSupport(f);
      if (a.action === 'RESCIND' && (await rescindMark(ctx, r.id, a))) n += 1;
    }
    return n;
  }

  /**
   * Worker reaction (at-least-once delivery ⇒ exactly-once logical effects through natural identity
   * and the ratification uniqueness). Only canonical events are consumed; no fixture job or flag.
   */
  async react(event: DomainEvent): Promise<{ evaluated: number; rescinded: number } | undefined> {
    const rvId =
      typeof event.payload.resultVersionId === 'string'
        ? event.payload.resultVersionId
        : event.aggregateType === 'RESULT_VERSION'
          ? event.aggregateId
          : undefined;
    if (EVALUATION_EVENTS.has(event.eventType) && rvId !== undefined)
      return recordTx(this.db, async (ctx) => {
        const out = await this.evaluateInTx(ctx, rvId, undefined);
        return { evaluated: out?.evaluations.length ?? 0, rescinded: out?.rescinded ?? 0 };
      });
    if (SWEEP_EVENTS.has(event.eventType)) {
      const out = await sweepRecordSupport(this.db, canonicalRecordSupportSource, {
        provenance: 'CANONICAL_ASSEMBLY',
      });
      return { evaluated: 0, rescinded: out.filter((x) => x.rescinded).length };
    }
    return undefined;
  }

  /** INTERNAL / staff: the record dependency index of an exact ResultVersion. */
  async dependents(input: { readonly actor: EvidenceActor; readonly resultVersionId: string }) {
    const r = await inTransaction(
      this.db,
      ModuleRole.records,
      async (ctx): Promise<Committed<unknown>> => {
        const facts = UUID.test(input.resultVersionId)
          ? await loadVersionFacts(ctx, input.resultVersionId)
          : undefined;
        if (
          facts === undefined ||
          !(await this.staffAllowed(ctx, input.actor, facts.path.competitionId))
        )
          return { error: new DomainError(DomainErrorCode.NOT_FOUND, 'result version not found') };
        return { ok: await recordDependencyIndex(ctx, { resultVersionId: input.resultVersionId }) };
      },
    );
    return unwrap(r);
  }
}

/**
 * The record standing of a category at a sporting instant, replayed from the append-only history of
 * one provenance (the same computation the canonical assembler uses) — for fixture snapshots.
 */
export function standingMarksAt(
  db: Db,
  input: {
    readonly categoryId: string;
    readonly tiePolicy: 'SHARED' | 'FIRST_ACHIEVED';
    readonly comparator: 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER';
    readonly at: string;
    readonly provenance: 'CANONICAL_ASSEMBLY' | 'REFERENCE_FIXTURE';
    readonly excludeMarkId?: string;
  },
) {
  return inTransaction(db, ModuleRole.records, async (ctx) => {
    const marks = (await categoryMarks(ctx, input.categoryId)).filter(
      (m) => m.provenance === input.provenance,
    );
    const at = Date.parse(input.at);
    const r = replayRecordHistory(
      replayInputOf(
        input.categoryId,
        input.tiePolicy,
        input.comparator,
        marks,
        (m) => m.recordMarkId !== input.excludeMarkId && m.effectiveFrom.getTime() <= at,
      ),
    );
    const byId = new Map(marks.map((m) => [m.recordMarkId, m]));
    return r.current.map((id) => {
      const m = byId.get(id) as CategoryMarkFacts;
      return {
        recordMarkId: m.recordMarkId,
        markHash: m.markHash,
        holder: { holderType: m.holderType, holderId: m.holderId },
        value: m.value,
        effectiveFrom: m.effectiveFrom.toISOString(),
        standing: m.ratification?.standing ?? ('RATIFIED' as const),
      };
    });
  });
}
