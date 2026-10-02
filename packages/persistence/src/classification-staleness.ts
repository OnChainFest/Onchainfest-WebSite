import {
  DomainError,
  DomainErrorCode,
  type ResultScopeType,
  type ResultVersionStatus,
  type Uuid,
} from '@br/domain';
import {
  classificationCorrectionImpact,
  classificationDependencies,
  classificationStalePayload,
  classificationStaleness,
  deriveClassification,
  type ClassificationDerivation,
  type ClassificationPin,
  type ClassificationStaleness,
} from '@br/rankings';
import { sql } from 'kysely';
import { assemblePinnedClassificationInput, isClassificationScope } from './classification-loader';
import type { Db } from './db';
import { lockKeys } from './identity-support';
import { emitEvent } from './outbox';
import { inTransaction, ModuleRole, type TxContext } from './tx';

/**
 * BRT-10 Step 7 — classification staleness, correction impact and the as-corrected classification read
 * (ADR-0047 §5–6). Runs under br_results, the module that owns classification ResultVersions and their
 * derivedFrom index (`results.classification_input`, 0023). No grant is added.
 *
 *   read(version)            the immutable version + its exact pins + staleness COMPUTED from the current
 *                            canonical state. Nothing is written: no flag, no correction, no replacement.
 *   dependents(version)      classification versions pinning a ResultVersion — the derivedFrom index
 *                            (classification_input_target_idx), never a scan of unrelated results.
 *   correctionImpact(rv)     for each dependent: the pins that are no longer current (unknown ⇒ affected).
 *   emitStale(version)       the ClassificationStale outbox event, at most once per (version,
 *                            staleDigest), in one transaction serialized per version. The Step 10 worker
 *                            decides WHEN to call it; nothing calls it automatically yet.
 *
 * Staleness is never stored (R-1). A stale classification stays the current version of its Result;
 * replacing it requires a T7 correction, which has no producer (CLASSIFICATION_REPLACEMENT_REQUIRES_
 * CORRECTION is raised by the ResultLedger, unchanged).
 */

const integrity = (reason: string, message: string, details: Record<string, unknown> = {}) =>
  new DomainError(DomainErrorCode.RANKING_INTEGRITY_FAILURE, message, { reason, ...details });

const LIVE_STATUSES: readonly string[] = ['PROVISIONAL', 'OFFICIAL', 'FINAL'];

export type ClassificationReadStaleness =
  | ClassificationStaleness
  | {
      readonly state: 'PROVENANCE_UNAVAILABLE';
      readonly code: 'CLASSIFICATION_PROVENANCE_UNAVAILABLE';
    };

export interface ClassificationRead {
  readonly classificationVersionId: string;
  readonly resultId: string;
  readonly scopeType: ResultScopeType;
  readonly scopeTargetId: string;
  /** The version's own latest append-only status (it is never rewritten). */
  readonly status: Exclude<ResultVersionStatus, 'DRAFT'>;
  readonly contentSchema: string;
  readonly contentHash: string;
  /** The exact pins, as hashed in the immutable content. Absent for `@1` (provenance unavailable). */
  readonly derivation?: ClassificationDerivation;
  /** Why the admissible set is unknown, when it is (the assembly's fail-closed code). */
  readonly admissibleSetUnavailable?: string;
  readonly staleness: ClassificationReadStaleness;
}

export interface ClassificationImpact {
  readonly classificationVersionId: string;
  readonly resultId: string;
  /** Pins no longer current (unknown counts), deterministic order; empty ⇒ unaffected. */
  readonly impact: readonly ClassificationDerivation['derivedFrom'][number][];
}

interface VersionRow {
  id: string;
  result_id: string;
  scope_type: ResultScopeType;
  scope_target_id: string;
  content: unknown;
  content_hash: string;
  content_schema: string;
  status: Exclude<ResultVersionStatus, 'DRAFT'> | null;
}

async function loadVersion(ctx: TxContext, versionId: string): Promise<VersionRow> {
  const { rows } = await sql<VersionRow>`
    SELECT v.id, v.result_id, r.scope_type, r.scope_target_id, v.content, v.content_hash, v.content_schema,
           (SELECT x.to_status FROM results.result_status_transition x WHERE x.result_version_id = v.id
            ORDER BY x.recorded_at DESC, x.id DESC LIMIT 1) AS status
    FROM results.result_version v JOIN results.result r ON r.id = v.result_id
    WHERE v.id = ${versionId}`.execute(ctx.trx);
  const row = rows[0];
  if (row === undefined || row.status === null)
    throw new DomainError(DomainErrorCode.NOT_FOUND, 'classification version not found');
  if (!isClassificationScope(row.scope_type))
    throw new DomainError(DomainErrorCode.INVALID_INPUT, 'not a classification ResultVersion', {
      reason: 'NOT_A_CLASSIFICATION_RESULT',
    });
  return row;
}

/**
 * The derivedFrom index of a version must be exactly its content pins (BR163–BR168 bind them at
 * insert). Any drift is an integrity failure, never silently trusted in either direction.
 */
async function assertIndexMatches(ctx: TxContext, versionId: string, d: ClassificationDerivation) {
  const { rows } = await sql<{ id: string; hash: string; status: string }>`
    SELECT input_result_version_id::text AS id, input_content_hash AS hash, input_status AS status
    FROM results.classification_input WHERE classification_version_id = ${versionId}
    ORDER BY input_result_version_id`.execute(ctx.trx);
  const { rows: head } = await sql<{ inputs_digest: string; policy_version_id: string }>`
    SELECT inputs_digest, policy_version_id FROM results.classification_derivation
    WHERE result_version_id = ${versionId}`.execute(ctx.trx);
  const pins = d.derivedFrom.map((p) => ({
    id: p.resultVersionId,
    hash: p.contentHash,
    status: p.status,
  }));
  if (
    JSON.stringify(rows) !== JSON.stringify(pins) ||
    head[0]?.inputs_digest !== d.inputsDigest ||
    head[0]?.policy_version_id !== d.policy.policyVersionId
  )
    throw integrity(
      'CLASSIFICATION_INDEX_MISMATCH',
      'the derivedFrom index does not match the classification content pins',
      { classificationVersionId: versionId },
    );
}

/** Pinned id → still the current (not superseded / revoked / rejected) version with its pinned hash. */
async function pinCurrency(
  ctx: TxContext,
  pins: readonly ClassificationPin[],
): Promise<Map<string, boolean>> {
  const { rows } = await sql<{
    id: string;
    content_hash: string;
    status: string | null;
    superseded: boolean;
  }>`
    SELECT v.id::text AS id, v.content_hash,
           (SELECT x.to_status FROM results.result_status_transition x WHERE x.result_version_id = v.id
            ORDER BY x.recorded_at DESC, x.id DESC LIMIT 1) AS status,
           EXISTS (SELECT 1 FROM results.result_version s WHERE s.supersedes_version_id = v.id) AS superseded
    FROM results.result_version v WHERE v.id = ANY(${pins.map((p) => p.resultVersionId)}::uuid[])`.execute(
    ctx.trx,
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const current = new Map<string, boolean>();
  for (const p of pins) {
    const r = byId.get(p.resultVersionId);
    if (r === undefined || r.status === null) continue; // unknown ⇒ absent ⇒ affected
    current.set(
      p.resultVersionId,
      LIVE_STATUSES.includes(r.status) && !r.superseded && r.content_hash === p.contentHash,
    );
  }
  return current;
}

/** The scope's current admissible inputs under the PINNED policy, or the fail-closed code. */
async function admissibleUnderPinnedPolicy(
  ctx: TxContext,
  resultId: string,
  d: ClassificationDerivation,
): Promise<
  { readonly admissible: readonly ClassificationPin[] } | { readonly unavailable: string }
> {
  const assembly = await assemblePinnedClassificationInput(ctx, resultId, {
    policyVersionId: d.policy.policyVersionId,
    disciplineVersionId: d.disciplineVersionId,
  });
  if (!assembly.ok) return { unavailable: assembly.reason };
  const r = deriveClassification(assembly.input);
  if (!r.ok) return { unavailable: 'CLASSIFICATION_INPUT_INVALID' };
  const admitted = new Set(
    r.outcome.inputs.filter((i) => i.state === 'ADMITTED').map((i) => i.resultVersionId),
  );
  return {
    admissible: assembly.input.inputs
      .filter((i) => admitted.has(i.resultVersionId))
      .map((i) => ({ resultVersionId: i.resultVersionId, contentHash: i.contentHash })),
  };
}

async function readIn(ctx: TxContext, versionId: string): Promise<ClassificationRead> {
  const v = await loadVersion(ctx, versionId);
  const base = {
    classificationVersionId: v.id,
    resultId: v.result_id,
    scopeType: v.scope_type,
    scopeTargetId: v.scope_target_id,
    status: v.status as Exclude<ResultVersionStatus, 'DRAFT'>,
    contentSchema: v.content_schema,
    contentHash: v.content_hash,
  };
  const deps = classificationDependencies(v.content);
  if (!deps.ok) return { ...base, staleness: { state: 'PROVENANCE_UNAVAILABLE', code: deps.code } };
  const d = deps.derivation;
  await assertIndexMatches(ctx, v.id, d);
  const current = await pinCurrency(ctx, d.derivedFrom);
  const set = await admissibleUnderPinnedPolicy(ctx, v.result_id, d);
  const staleness = classificationStaleness(
    { resultVersionId: v.id, contentHash: v.content_hash },
    d,
    { current, admissible: 'admissible' in set ? set.admissible : undefined },
  );
  return {
    ...base,
    derivation: d,
    ...('unavailable' in set ? { admissibleSetUnavailable: set.unavailable } : {}),
    staleness,
  };
}

export class ClassificationStalenessService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * The as-corrected classification read: the immutable version and its pins, with staleness computed
   * now. One consistent snapshot (REPEATABLE READ); read-only.
   */
  read(classificationVersionId: string): Promise<ClassificationRead> {
    return inTransaction(
      this.db,
      ModuleRole.results,
      (ctx) => readIn(ctx, classificationVersionId),
      4,
      {
        isolation: 'repeatable read',
      },
    );
  }

  /** Classification versions whose derivedFrom pins `resultVersionId` (the index), sorted. */
  dependents(resultVersionId: string): Promise<readonly string[]> {
    return inTransaction(this.db, ModuleRole.results, async (ctx) => {
      const { rows } = await sql<{ id: string }>`
        SELECT classification_version_id::text AS id FROM results.classification_input
        WHERE input_result_version_id = ${resultVersionId} ORDER BY classification_version_id`.execute(
        ctx.trx,
      );
      return rows.map((r) => r.id);
    });
  }

  /**
   * Correction impact of a changed ResultVersion, found through the derivedFrom index only: every
   * classification pinning it, with ALL of its pins that are no longer current. Analytical: it never
   * creates a correction, a replacement or a version.
   */
  correctionImpact(changedResultVersionId: string): Promise<readonly ClassificationImpact[]> {
    return inTransaction(
      this.db,
      ModuleRole.results,
      async (ctx) => {
        const { rows } = await sql<{ id: string; result_id: string; content: unknown }>`
          SELECT v.id::text AS id, v.result_id, v.content FROM results.result_version v
          WHERE v.id IN (SELECT i.classification_version_id FROM results.classification_input i
                         WHERE i.input_result_version_id = ${changedResultVersionId})
          ORDER BY v.id`.execute(ctx.trx);
        const out: ClassificationImpact[] = [];
        for (const row of rows) {
          const deps = classificationDependencies(row.content);
          // An indexed version always carries `@2` provenance (BR160–BR168); anything else is drift.
          if (!deps.ok)
            throw integrity('CLASSIFICATION_INDEX_MISMATCH', 'indexed version has no provenance', {
              classificationVersionId: row.id,
            });
          await assertIndexMatches(ctx, row.id, deps.derivation);
          const current = await pinCurrency(ctx, deps.derivation.derivedFrom);
          out.push({
            classificationVersionId: row.id,
            resultId: row.result_id,
            impact: classificationCorrectionImpact(deps.derivation, current),
          });
        }
        return out;
      },
      4,
      { isolation: 'repeatable read' },
    );
  }

  /**
   * Emits ClassificationStale through the transactional outbox iff the version is STALE now and no
   * event exists yet for (version, staleDigest). Serialized per version (advisory lock taken before any
   * read, READ COMMITTED), so concurrent or repeated calls in the same state emit exactly one event; a
   * different stale state (a new digest) emits a new one. A CURRENT version emits nothing.
   */
  emitStale(classificationVersionId: string): Promise<{
    readonly state: ClassificationReadStaleness['state'];
    readonly staleDigest?: string;
    readonly emitted: boolean;
    readonly eventId?: string;
  }> {
    return inTransaction(this.db, ModuleRole.results, async (ctx) => {
      await lockKeys(ctx, `classification-stale:${classificationVersionId.toLowerCase()}`);
      const read = await readIn(ctx, classificationVersionId);
      const s = read.staleness;
      if (s.state !== 'STALE') return { state: s.state, emitted: false };
      const { rows } = await sql<{ id: string }>`
        SELECT id::text AS id FROM platform.outbox_event
        WHERE aggregate_type = 'RESULT_VERSION' AND aggregate_id = ${classificationVersionId}
          AND event_type = 'ClassificationStale' AND payload->>'staleDigest' = ${s.staleDigest}
        ORDER BY recorded_at, id LIMIT 1`.execute(ctx.trx);
      const existing = rows[0];
      if (existing !== undefined)
        return { state: 'STALE', staleDigest: s.staleDigest, emitted: false, eventId: existing.id };
      const event = await emitEvent(ctx, {
        eventType: 'ClassificationStale',
        aggregateType: 'RESULT_VERSION',
        aggregateId: classificationVersionId as Uuid,
        payload: classificationStalePayload(read.resultId, s),
      });
      return { state: 'STALE', staleDigest: s.staleDigest, emitted: true, eventId: event.eventId };
    });
  }
}
