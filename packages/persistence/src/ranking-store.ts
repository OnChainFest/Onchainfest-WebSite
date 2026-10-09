import { DomainError, DomainErrorCode, newId, type RankingRunTrigger, type Uuid } from '@br/domain';
import {
  evaluateRankingRun,
  hashRankingRunInput,
  hashRankingRunOutcome,
  validateRankingSnapshot,
  type RankingRunInput,
  type RankingRunOutcome,
  type RankingSnapshotContent,
} from '@br/rankings';
import { sql } from 'kysely';
import type { Db } from './db';
import { lockKeys, recordAudit } from './identity-support';
import { emitEvent } from './outbox';
import { refreshRunCard, refreshSnapshotCard } from './ranking-projection';
import { assembleRankingRunInput, loadSystemVersion } from './ranking-loader';
import { inTransaction, ModuleRole, type TxContext } from './tx';

/**
 * BRT-10 validated ranking writer (ADR-0048 §5–6, §8) — the ONLY code that inserts ranking runs,
 * dependencies, snapshots and entries (br_ranking_worker_app → br_rankings). The rule is
 *
 *   DERIVE → LOAD CANONICAL FACTS → RE-DERIVE → COMPARE → PERSIST
 *
 *   · run        a CANONICAL_ASSEMBLY input must equal the canonical re-assembly (same system version
 *                and sporting cutoff) byte for byte; the outcome is ALWAYS re-evaluated by the pure
 *                engine here and a caller-claimed outcome / hash that differs is refused. Identity is
 *                (system version, input hash): the same input never creates a second run. BLOCKED
 *                runs are persisted too, with their exact blockers. The trigger is metadata, never
 *                hashed.
 *   · snapshot   published only from a PUBLISHABLE run (≥ 1 ranked entry) of a CURRENTLY PUBLISHED
 *                system version whose stored outcome re-hashes, with content built here from the run
 *                (a caller-claimed content / hash that differs is refused). PLATFORM systems are
 *                published under the platform's own label; OFFICIAL publication fails closed
 *                (OWNER_PUBLICATION_UNAVAILABLE — no owner-publication producer; the platform never
 *                publishes on an owner's behalf). Lineage: the first snapshot of a system is INITIAL,
 *                every later one FOLLOWS the head; CORRECTS has no production producer and is accepted
 *                only for REFERENCE_FIXTURE runs (throwaway overlay databases).
 *
 * REFERENCE_FIXTURE inputs (synthetic FINAL / V2+ / hold facts) are refused by the normal schema's
 * provenance CHECKs and only persist in a br_rkfx_ overlay database. There is no flag that changes this.
 */
const integrity = (reason: string, message: string, details: Record<string, unknown> = {}) =>
  new DomainError(DomainErrorCode.RANKING_INTEGRITY_FAILURE, message, { reason, ...details });
const refused = (reason: string, message: string, details: Record<string, unknown> = {}) =>
  new DomainError(DomainErrorCode.INVALID_TRANSITION, message, { reason, ...details });

export interface RankingRunReport {
  readonly runId: string;
  readonly systemId: string;
  readonly systemVersionId: string;
  readonly inputHash: string;
  readonly outcomeHash: string;
  readonly provenance: 'CANONICAL_ASSEMBLY' | 'REFERENCE_FIXTURE';
  readonly publicationState: 'PUBLISHABLE' | 'BLOCKED';
  readonly publicationReasons: readonly string[];
  readonly entryCount: number;
  readonly candidateCount: number;
  /** False when the same (system version, input hash) run already existed. */
  readonly created: boolean;
}

export interface RankingSnapshotReport {
  readonly snapshotId: string;
  readonly runId: string;
  readonly systemId: string;
  readonly snapshotHash: string;
  readonly lineageKind: 'INITIAL' | 'FOLLOWS' | 'CORRECTS';
  readonly priorSnapshotId?: string;
  readonly entryCount: number;
  /** False when this run had already been published (no duplicate snapshot). */
  readonly created: boolean;
}

/**
 * REPEATABLE READ: the multi-statement canonical re-assembly (statuses, verification freshness) reads
 * one consistent snapshot. Identical concurrent runs collapse on ranking_run_identity_key (retried by
 * naturalKeyRace below), landing in the "already exists" path. Bounded retries on BRT-07 clock-step inconsistency.
 */
async function runTx<T>(db: Db, fn: (ctx: TxContext) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await naturalKeyRace(() =>
        inTransaction(db, ModuleRole.rankings, fn, 16, { isolation: 'repeatable read' }),
      );
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

/**
 * The writer's natural keys. A REPEATABLE READ writer that lost the race to an identical concurrent
 * run / publication hits one of these on insert; the retry (a fresh transaction) finds the committed
 * row and returns it (`created: false`). Kept local to the ranking writer — raw inserts elsewhere still
 * see the plain unique violation.
 */
const NATURAL_KEYS = new Set(['ranking_run_identity_key', 'snapshot_run_key', 'snapshot_hash_key']);
async function naturalKeyRace<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      if (
        attempt >= attempts ||
        e.code !== '23505' ||
        e.constraint === undefined ||
        !NATURAL_KEYS.has(e.constraint)
      )
        throw err;
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20 * attempt));
    }
  }
}

// ───────────────────────────── runs ─────────────────────────────

async function persistRun(
  ctx: TxContext,
  input: RankingRunInput,
  claimed: { readonly outcome?: unknown; readonly outcomeHash?: string } | undefined,
  meta: { readonly trigger: RankingRunTrigger; readonly requestedByAccountId?: string },
): Promise<RankingRunReport> {
  const ev = evaluateRankingRun(input, { trigger: meta.trigger });
  if (!ev.ok)
    throw integrity('RUN_INPUT_INVALID', 'ranking run input is not canonical', {
      issues: ev.issues.map((i) => i.code),
    });
  if (claimed?.outcomeHash !== undefined && claimed.outcomeHash !== ev.outcomeHash)
    throw integrity('OUTCOME_NOT_REPRODUCIBLE', 'claimed outcome hash does not reproduce');
  if (claimed?.outcome !== undefined) {
    const h = hashRankingRunOutcome(claimed.outcome);
    if (!h.ok || h.hash !== ev.outcomeHash)
      throw integrity('OUTCOME_NOT_REPRODUCIBLE', 'claimed outcome does not reproduce');
  }
  const o = ev.outcome;
  const report = (runId: string, created: boolean): RankingRunReport => ({
    runId,
    systemId: input.system.systemId,
    systemVersionId: o.systemVersionId,
    inputHash: ev.inputHash,
    outcomeHash: ev.outcomeHash,
    provenance: o.provenance,
    publicationState: o.publication.state,
    publicationReasons: o.publication.reasons,
    entryCount: o.entries.length,
    candidateCount: o.candidates.length,
    created,
  });

  const { rows: existing } = await sql<{ id: string; outcome_hash: string }>`
    SELECT id, outcome_hash FROM ranking.run
    WHERE system_version_id = ${o.systemVersionId} AND input_hash = ${ev.inputHash}`.execute(
    ctx.trx,
  );
  const prior = existing[0];
  if (prior !== undefined) {
    // Same input ⇒ same outcome (the engine is pure). A difference is an engine / storage defect.
    if (prior.outcome_hash !== ev.outcomeHash)
      throw integrity('OUTCOME_NOT_REPRODUCIBLE', 'stored run outcome differs from re-evaluation');
    return report(prior.id, false);
  }

  const runId = newId();
  await sql`INSERT INTO ranking.run (id, system_id, system_version_id, spec_hash, engine_version, provenance, input_hash,
      outcome_hash, outcome, as_of, publication_state, publication_reasons, entry_count, candidate_count, trigger,
      requested_by_account_id, recorded_at)
    VALUES (${runId}, ${input.system.systemId}, ${o.systemVersionId}, ${o.specHash}, ${o.engineVersion}, ${o.provenance},
      ${ev.inputHash}, ${ev.outcomeHash}, ${JSON.stringify(o)}, ${o.asOf}, ${o.publication.state},
      ${[...o.publication.reasons]}, ${o.entries.length}, ${o.candidates.length}, ${meta.trigger},
      ${meta.requestedByAccountId ?? null}, ${ctx.txTime})`.execute(ctx.trx);

  // Dependency index (correction impact; consumed in Step 7). Canonical pins only: a REFERENCE_FIXTURE
  // run's candidate pins are synthetic and would (correctly) be refused by BR176.
  const deps: [string, string, string | null][] = [
    ['SYSTEM_VERSION', o.systemVersionId, o.specHash],
  ];
  if (o.provenance === 'CANONICAL_ASSEMBLY') {
    const versions = new Map<string, string>();
    const runs = new Map<string, string>();
    for (const c of input.candidates) {
      versions.set(c.resultVersionId, c.contentHash);
      const v = c.verification;
      if (v.runId !== undefined && v.outcomeHash !== undefined) runs.set(v.runId, v.outcomeHash);
    }
    for (const [id, hash] of [...versions].sort()) deps.push(['RESULT_VERSION', id, hash]);
    for (const [id, hash] of [...runs].sort()) deps.push(['VERIFICATION_RUN', id, hash]);
  }
  for (const [type, id, hash] of deps)
    await sql`INSERT INTO ranking.run_dependency (run_id, dependency_type, dependency_id, dependency_hash, recorded_at)
      VALUES (${runId}, ${type}, ${id}, ${hash}, ${ctx.txTime})`.execute(ctx.trx);
  await refreshRunCard(ctx, runId); // class B projection, same transaction

  await emitEvent(ctx, {
    eventType: 'RankingRunEvaluated',
    aggregateType: 'RANKING_RUN',
    aggregateId: runId as Uuid,
    payload: {
      systemId: input.system.systemId,
      systemVersionId: o.systemVersionId,
      inputHash: ev.inputHash,
      outcomeHash: ev.outcomeHash,
      provenance: o.provenance,
      publicationState: o.publication.state,
      publicationReasons: [...o.publication.reasons],
      entryCount: o.entries.length,
      candidateCount: o.candidates.length,
      trigger: meta.trigger,
    },
  });
  return report(runId, true);
}

/**
 * Persists one ranking run through the validated path. A CANONICAL_ASSEMBLY input must equal the
 * canonical re-assembly of its own (system version, asOf); a REFERENCE_FIXTURE input is refused by the
 * normal schema (CHECK) and succeeds only in a throwaway overlay database. A claimed outcome / hash is
 * only ever compared, never stored.
 */
export function persistRankingRun(
  db: Db,
  input: {
    readonly input: unknown;
    readonly claimed?: { readonly outcome?: unknown; readonly outcomeHash?: string };
    readonly trigger: RankingRunTrigger;
    readonly requestedByAccountId?: string;
  },
): Promise<RankingRunReport> {
  const sealed = hashRankingRunInput(input.input);
  if (!sealed.ok)
    return Promise.reject(
      integrity('RUN_INPUT_INVALID', 'ranking run input is not canonical', {
        issues: sealed.issues.map((i) => i.code),
      }),
    );
  const claimed = sealed.value;
  return runTx(db, async (ctx) => {
    let effective = claimed;
    if (claimed.provenance === 'CANONICAL_ASSEMBLY') {
      const canonical = await assembleRankingRunInput(ctx, {
        systemVersionId: claimed.system.systemVersionId,
        asOf: new Date(claimed.asOf),
      });
      const h = hashRankingRunInput(canonical);
      if (!h.ok || h.hash !== sealed.hash)
        throw integrity('CANONICAL_INPUT_MISMATCH', 'run input is not the canonical assembly');
      effective = h.value;
    }
    return persistRun(ctx, effective, input.claimed, {
      trigger: input.trigger,
      ...(input.requestedByAccountId === undefined
        ? {}
        : { requestedByAccountId: input.requestedByAccountId }),
    });
  });
}

// ───────────────────────────── snapshots ─────────────────────────────

interface RunRow {
  readonly id: string;
  readonly system_id: string;
  readonly system_version_id: string;
  readonly spec_hash: string;
  readonly provenance: 'CANONICAL_ASSEMBLY' | 'REFERENCE_FIXTURE';
  readonly input_hash: string;
  readonly outcome_hash: string;
  readonly outcome: RankingRunOutcome;
  readonly as_of: Date;
  readonly publication_state: string;
}

export interface SnapshotCorrection {
  readonly correctsSnapshotId: string;
  readonly reasons: readonly string[];
}

async function publishInTx(
  ctx: TxContext,
  input: {
    readonly runId: string;
    readonly publishedByAccountId?: string;
    readonly claimed?: { readonly content?: unknown; readonly snapshotHash?: string };
    readonly correction?: SnapshotCorrection;
  },
): Promise<RankingSnapshotReport> {
  const { rows: rr } = await sql<RunRow>`
    SELECT id, system_id, system_version_id, spec_hash, provenance, input_hash, outcome_hash, outcome, as_of,
           publication_state
    FROM ranking.run WHERE id = ${input.runId}`.execute(ctx.trx);
  const run = rr[0];
  if (run === undefined) throw new DomainError(DomainErrorCode.NOT_FOUND, 'ranking run not found');
  // Lineage decisions of one system are linearized (the same lock the snapshot trigger takes); in READ
  // COMMITTED every statement after the lock sees the committed snapshots of the system.
  await lockKeys(ctx, `ranking-snapshot:${run.system_id}`);

  const { rows: already } = await sql<{
    id: string;
    snapshot_hash: string;
    lineage_kind: 'INITIAL' | 'FOLLOWS' | 'CORRECTS';
    prior: string | null;
    entry_count: number;
  }>`
    SELECT id, snapshot_hash, lineage_kind, COALESCE(previous_snapshot_id, corrects_snapshot_id) AS prior, entry_count
    FROM ranking.snapshot WHERE run_id = ${run.id}`.execute(ctx.trx);
  const done = already[0];
  if (done !== undefined)
    return {
      snapshotId: done.id,
      runId: run.id,
      systemId: run.system_id,
      snapshotHash: done.snapshot_hash,
      lineageKind: done.lineage_kind,
      ...(done.prior === null ? {} : { priorSnapshotId: done.prior }),
      entryCount: done.entry_count,
      created: false,
    };

  // The stored run must still be exactly the engine's outcome.
  const rehash = hashRankingRunOutcome(run.outcome);
  if (!rehash.ok || rehash.hash !== run.outcome_hash)
    throw integrity('RUN_OUTCOME_HASH_MISMATCH', 'stored run outcome does not match its hash');
  const o = rehash.value;
  if (run.publication_state !== 'PUBLISHABLE' || o.publication.state !== 'PUBLISHABLE')
    throw refused('RUN_NOT_PUBLISHABLE', 'a BLOCKED run cannot be published', {
      reasons: [...o.publication.reasons],
    });
  if (o.entries.length === 0)
    throw refused('NO_RANKED_ENTRIES', 'a run that ranks nobody cannot be published');

  const system = await loadSystemVersion(ctx, run.system_version_id);
  if (system === undefined) throw integrity('SYSTEM_VERSION_MISSING', 'system version missing');
  if (system.lifecycle !== 'PUBLISHED')
    throw refused(
      system.lifecycle === 'RETIRED' ? 'SYSTEM_VERSION_RETIRED' : 'SYSTEM_VERSION_NOT_PUBLISHED',
      'snapshots are published only for a currently PUBLISHED system version',
    );
  // ADR-0048 §6: no owner-publication producer exists, and the platform never publishes for an owner.
  if (system.kind === 'OFFICIAL')
    throw refused('OWNER_PUBLICATION_UNAVAILABLE', 'official publication requires the owner act');

  // A canonical run is published only while it is still the canonical assembly of its cutoff.
  if (run.provenance === 'CANONICAL_ASSEMBLY') {
    const now = hashRankingRunInput(
      await assembleRankingRunInput(ctx, {
        systemVersionId: run.system_version_id,
        asOf: run.as_of,
      }),
    );
    if (!now.ok || now.hash !== run.input_hash)
      throw refused('RUN_NOT_CURRENT', 'the canonical facts changed since the run was evaluated');
  }

  // Lineage: INITIAL for the system's first snapshot, else FOLLOWS the head (the snapshot no other
  // snapshot follows or corrects). CORRECTS has no production producer (fixture runs only).
  if (input.correction !== undefined && run.provenance !== 'REFERENCE_FIXTURE')
    throw refused(
      'CORRECTION_PRODUCER_UNAVAILABLE',
      'snapshot corrections have no canonical producer',
    );
  const { rows: heads } = await sql<{ id: string; snapshot_hash: string }>`
    SELECT s.id, s.snapshot_hash FROM ranking.snapshot s
    WHERE s.system_id = ${run.system_id}
      AND NOT EXISTS (SELECT 1 FROM ranking.snapshot n
                      WHERE n.previous_snapshot_id = s.id OR n.corrects_snapshot_id = s.id)
    ORDER BY s.recorded_at, s.id`.execute(ctx.trx);
  let lineage: RankingSnapshotContent['lineage'];
  if (input.correction !== undefined) {
    const target = heads.find((h) => h.id === input.correction?.correctsSnapshotId);
    if (target === undefined)
      throw refused(
        'LINEAGE_INVALID',
        'only the current head snapshot of the system can be corrected',
      );
    lineage = {
      kind: 'CORRECTS',
      priorSnapshotId: target.id,
      priorSnapshotHash: target.snapshot_hash,
      reasons: [...new Set(input.correction.reasons)].sort(),
    };
  } else if (heads.length === 0) {
    lineage = { kind: 'INITIAL' };
  } else {
    const [head] = heads;
    if (head === undefined || heads.length !== 1)
      throw integrity('LINEAGE_FORKED', 'the system has more than one head snapshot');
    lineage = { kind: 'FOLLOWS', priorSnapshotId: head.id, priorSnapshotHash: head.snapshot_hash };
  }

  const v = validateRankingSnapshot({
    systemId: run.system_id,
    systemVersionId: run.system_version_id,
    specHash: run.spec_hash,
    kind: system.kind,
    method: system.spec.method,
    engineVersion: o.engineVersion,
    provenance: o.provenance,
    runInputHash: run.input_hash,
    runOutcomeHash: run.outcome_hash,
    asOf: o.asOf,
    lineage,
    entries: o.entries,
  });
  if (!v.ok)
    throw integrity('SNAPSHOT_INVALID', 'snapshot content is not valid', {
      issues: v.issues.map((i) => i.code),
    });
  if (input.claimed?.snapshotHash !== undefined && input.claimed.snapshotHash !== v.hash)
    throw integrity('SNAPSHOT_HASH_MISMATCH', 'claimed snapshot hash does not match the run');
  if (input.claimed?.content !== undefined) {
    const c = validateRankingSnapshot(input.claimed.content);
    if (!c.ok || c.hash !== v.hash)
      throw integrity(
        'SNAPSHOT_CONTENT_MISMATCH',
        'claimed snapshot content does not match the run',
      );
  }
  const content = v.value;

  const snapshotId = newId();
  const priorId = lineage.priorSnapshotId ?? null;
  await sql`INSERT INTO ranking.snapshot (id, system_id, system_version_id, spec_hash, run_id, run_input_hash,
      run_outcome_hash, snapshot_hash, content, kind, method, engine_version, provenance, as_of, lineage_kind,
      previous_snapshot_id, corrects_snapshot_id, prior_snapshot_hash, lineage_reasons, entry_count,
      published_by_account_id, recorded_at)
    VALUES (${snapshotId}, ${run.system_id}, ${run.system_version_id}, ${run.spec_hash}, ${run.id}, ${run.input_hash},
      ${run.outcome_hash}, ${v.hash}, ${JSON.stringify(content)}, ${content.kind}, ${content.method},
      ${content.engineVersion}, ${content.provenance}, ${content.asOf}, ${lineage.kind},
      ${lineage.kind === 'FOLLOWS' ? priorId : null}, ${lineage.kind === 'CORRECTS' ? priorId : null},
      ${lineage.priorSnapshotHash ?? null}, ${[...(lineage.reasons ?? [])]}, ${content.entries.length},
      ${input.publishedByAccountId ?? null}, ${ctx.txTime})`.execute(ctx.trx);
  for (const e of content.entries)
    await sql`INSERT INTO ranking.snapshot_entry (snapshot_id, holder_type, holder_id, rank, tied, value,
        comparator_trace, basis, recorded_at)
      VALUES (${snapshotId}, ${e.holder.holderType}, ${e.holder.holderId}, ${e.rank}, ${e.tied},
        ${JSON.stringify(e.value)}, ${JSON.stringify(e.comparatorTrace)}, ${JSON.stringify(e.basis)}, ${ctx.txTime})`.execute(
      ctx.trx,
    );
  // Class B projections, same transaction: the new card, and the prior's (its corrected_by may change).
  await refreshSnapshotCard(ctx, snapshotId);
  if (priorId !== null) await refreshSnapshotCard(ctx, priorId);

  await emitEvent(ctx, {
    eventType: 'RankingSnapshotPublished',
    aggregateType: 'RANKING_SNAPSHOT',
    aggregateId: snapshotId as Uuid,
    payload: {
      systemId: run.system_id,
      systemVersionId: run.system_version_id,
      runId: run.id,
      snapshotHash: v.hash,
      kind: content.kind,
      provenance: content.provenance,
      lineageKind: lineage.kind,
      ...(priorId === null ? {} : { priorSnapshotId: priorId }),
      entryCount: content.entries.length,
    },
  });
  await recordAudit(ctx, {
    ...(input.publishedByAccountId === undefined
      ? {}
      : { actorAccountId: input.publishedByAccountId }),
    action: 'ranking.snapshot-published',
    targetType: 'RANKING_SNAPSHOT',
    targetId: snapshotId,
    details: { kind: content.kind, lineageKind: lineage.kind, provenance: content.provenance },
  });
  return {
    snapshotId,
    runId: run.id,
    systemId: run.system_id,
    snapshotHash: v.hash,
    lineageKind: lineage.kind,
    ...(priorId === null ? {} : { priorSnapshotId: priorId }),
    entryCount: content.entries.length,
    created: true,
  };
}

/**
 * Publishes the snapshot of one run through the validated path (READ COMMITTED + the per-system lock,
 * so lineage never races). Republishing the same run returns the existing snapshot. A claimed content /
 * hash is only compared; a correction is accepted only for REFERENCE_FIXTURE runs.
 */
export function publishRankingSnapshot(
  db: Db,
  input: {
    readonly runId: string;
    readonly publishedByAccountId?: string;
    readonly claimed?: { readonly content?: unknown; readonly snapshotHash?: string };
    readonly correction?: SnapshotCorrection;
  },
): Promise<RankingSnapshotReport> {
  return naturalKeyRace(() =>
    inTransaction(db, ModuleRole.rankings, (ctx) => publishInTx(ctx, input), 16),
  );
}

/**
 * The CANONICAL ranking runtime (worker / later API): evaluates a run from canonical facts only and
 * publishes PLATFORM snapshots of PUBLISHABLE runs. There is no input, outcome, rank or lineage
 * parameter — every fact is loaded here.
 */
export class RankingService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Evaluates and persists the canonical run of a system version at a sporting cutoff ≤ now. */
  evaluate(input: {
    readonly systemVersionId: string;
    readonly asOf?: Date;
    readonly trigger: RankingRunTrigger;
    readonly requestedByAccountId?: string;
  }): Promise<RankingRunReport> {
    return runTx(this.db, async (ctx) => {
      const asOf = input.asOf ?? ctx.txTime;
      if (asOf.getTime() > ctx.txTime.getTime())
        throw new DomainError(
          DomainErrorCode.INVALID_INPUT,
          'a sporting cutoff cannot be in the future',
        );
      const canonical = await assembleRankingRunInput(ctx, {
        systemVersionId: input.systemVersionId,
        asOf,
      });
      const h = hashRankingRunInput(canonical);
      if (!h.ok)
        throw integrity('RUN_INPUT_INVALID', 'canonical run input is not canonical', {
          issues: h.issues.map((i) => i.code),
        });
      return persistRun(ctx, h.value, undefined, {
        trigger: input.trigger,
        ...(input.requestedByAccountId === undefined
          ? {}
          : { requestedByAccountId: input.requestedByAccountId }),
      });
    });
  }

  /** Publishes the snapshot of a PUBLISHABLE canonical run (never a correction: no producer). */
  publish(input: {
    readonly runId: string;
    readonly publishedByAccountId?: string;
  }): Promise<RankingSnapshotReport> {
    return publishRankingSnapshot(this.db, input);
  }
}
