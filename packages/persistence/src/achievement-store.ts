import {
  assessSupport,
  blockingReasons,
  currentSupportStatement,
  deriveAchievements,
  derivedFromStatement,
  evidenceCommitmentOf,
  governingRecognitionStatement,
  effectiveRequirements,
  hashCandidate,
  identityOf,
  PUBLIC_ACHIEVEMENT_NOTICE,
  publicBlocker,
  publicReason,
  sealDerivationSnapshot,
  type AchievementCandidate,
  type CandidateEntry,
  type Derivation,
  type SealedDerivationSnapshot,
  type SupportAssessment,
  type SupportFacts,
} from '@br/achievements';
import {
  ACHIEVEMENT_TYPE_LABEL,
  DomainError,
  DomainErrorCode,
  newId,
  VERIFICATION_LEVEL_LABEL,
  verificationLevelIndex,
  type AchievementStatus,
  type AchievementType,
  type DomainEvent,
  type Mark,
  type Uuid,
  type VerificationLevel,
} from '@br/domain';
import { SchemaRef } from '@br/schemas';
import { categoryFloor, type RecordCategorySpec } from '@br/records';
import { sql } from 'kysely';
import {
  applicableRules,
  assembleCanonicalSnapshot,
  canonicalBasisFact,
  loadVersionFacts,
  ratifiedRecordMarks,
  verificationSummary,
  type ApplicableRule,
  type VersionFacts,
} from './achievement-loader';
import { refreshAchievementCard } from './achievement-projection';
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
import { inTransaction, ModuleRole, type TxContext } from './tx';

/**
 * BRT-08 Achievement persistence.
 *
 * There is NO generic insert, award, force or override path: an Achievement row can only be written
 * by `insertDerived`, which accepts a candidate only together with the sealed snapshot it was derived
 * from, re-runs the pure engine on that snapshot (the candidate must be reproduced byte-for-byte),
 * re-checks every basis element against the snapshot and lets the database re-check the upstream
 * canonical facts (trigger) — and which is reachable only from
 *   · AchievementService (canonical production lane: snapshots it assembled itself), and
 *   · `persistDerivation` (exported to the test harness): a CANONICAL_ASSEMBLY snapshot is refused
 *     unless it equals the snapshot the service re-assembles from canonical facts right now; a
 *     REFERENCE_FIXTURE snapshot is refused by the normal database schema (CHECK) and can only be
 *     stored in a throwaway overlay database.
 * No input anywhere names a holder, a winner, a qualifying value, a level or an override.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const integrity = (reason: string, message: string) =>
  new DomainError(DomainErrorCode.ACHIEVEMENT_INTEGRITY_FAILURE, message, { reason });

export interface PersistedAchievement {
  readonly achievementId: string;
  readonly created: boolean;
  readonly identityHash: string;
  readonly candidateHash: string;
  readonly achievementType: AchievementType;
  readonly holder: AchievementCandidate['holder'];
  readonly memberCredits: readonly string[];
  readonly supersedes: readonly string[];
}

// ───────────────────────────── validation (§98) ─────────────────────────────

const sameMark = (a: Mark | undefined, b: Mark | undefined) =>
  a !== undefined &&
  b !== undefined &&
  a.metricId === b.metricId &&
  a.value === b.value &&
  a.unit === b.unit &&
  a.precision === b.precision;

/**
 * The candidate must be exactly what the engine derives from the snapshot, and every element of it
 * must be backed by a snapshot fact. Any mismatch is an integrity failure — never a partial write.
 */
export function validateCandidate(
  sealed: SealedDerivationSnapshot,
  derivation: Derivation,
  entry: CandidateEntry,
): void {
  const s = sealed.snapshot;
  const c = entry.candidate;
  if (derivation.snapshotHash !== sealed.snapshotHash)
    throw integrity('SNAPSHOT_HASH_MISMATCH', 'derivation does not belong to this snapshot');
  const again = deriveAchievements(s);
  if (again.outcomeHash !== derivation.outcomeHash)
    throw integrity('OUTCOME_NOT_REPRODUCIBLE', 'derivation outcome does not reproduce');
  if (!(again.outcome.candidates ?? []).some((x) => x.identityHash === entry.identityHash))
    throw integrity('CANDIDATE_NOT_DERIVED', 'candidate was not derived from this snapshot');
  if (hashCandidate(c) !== entry.candidateHash)
    throw integrity('CANDIDATE_HASH_MISMATCH', 'candidate hash does not recompute');
  if (identityOf(c).identityHash !== entry.identityHash)
    throw integrity('IDENTITY_HASH_MISMATCH', 'identity hash does not recompute');
  if (c.provenance !== s.provenance || c.engineVersion !== s.rule.spec.targetEngine)
    throw integrity('CANDIDATE_PROVENANCE_MISMATCH', 'candidate provenance / engine mismatch');
  // BRT-09 RECORD_SET: the record pin must be exactly the snapshot's RecordMark facts.
  if (c.achievementType === 'RECORD_SET') {
    const r = s.record;
    const pin = c.record;
    if (
      r === undefined ||
      pin === undefined ||
      pin.recordMarkId !== r.recordMarkId ||
      pin.markHash !== r.markHash ||
      pin.categoryId !== r.categoryId ||
      pin.categoryVersionId !== r.categoryVersionId ||
      pin.categoryVersionHash !== r.categoryVersionHash ||
      pin.ratificationEntryId !== r.ratificationEntryId ||
      pin.ratificationHash !== r.ratificationHash ||
      pin.standing !== r.standing ||
      c.holder.holderType !== r.holder.holderType ||
      c.holder.holderId !== r.holder.holderId ||
      !sameMark(c.qualifyingValue, r.value)
    )
      throw integrity('RECORD_PIN_MISMATCH', 'RECORD_SET pin does not match the RecordMark facts');
  } else if (c.record !== undefined)
    throw integrity('RECORD_PIN_MISMATCH', 'only a RECORD_SET carries a record pin');
  if (
    c.rule.ruleId !== s.rule.ruleId ||
    c.rule.ruleVersionId !== s.rule.ruleVersionId ||
    c.rule.specHash !== s.rule.specHash
  )
    throw integrity('RULE_MISMATCH', 'candidate rule is not the snapshot rule');
  const v = s.verification;
  if (evidenceCommitmentOf(c.basis) !== c.evidenceCommitment)
    throw integrity('EVIDENCE_COMMITMENT_MISMATCH', 'evidenceCommitment does not recompute');
  if (
    JSON.stringify(c.governingAuthority ?? null) !== JSON.stringify(v.governingRecognition ?? null)
  )
    throw integrity(
      'GOVERNING_AUTHORITY_MISMATCH',
      'governingAuthority is not the pinned run recognition',
    );
  for (const b of c.basis) {
    if (
      b.resultVersionId !== s.resultVersion.resultVersionId ||
      b.contentHash !== s.resultVersion.contentHash ||
      b.resultStatus !== s.resultVersion.status ||
      b.verificationRunId !== v.runId ||
      b.verificationSnapshotHash !== v.snapshotHash ||
      b.verificationOutcomeHash !== v.outcomeHash ||
      b.verificationLevel !== v.level ||
      b.evidenceBundleHash !== v.evidenceBundleHash ||
      b.evidenceBundleAsOf !== v.evaluatedAsOf ||
      v.state !== 'CURRENT'
    )
      throw integrity('BASIS_MISMATCH', 'basis does not match the snapshot facts');
    const participant = s.participants.find((p) => p.participantId === b.participantId);
    if (participant === undefined)
      throw integrity('BASIS_PARTICIPANT_UNKNOWN', 'unknown participant');
    const perf =
      b.performanceOrdinal === undefined
        ? undefined
        : (s.performances ?? []).find(
            (p) => p.participantId === b.participantId && p.ordinal === b.performanceOrdinal,
          );
    if (b.performanceOrdinal !== undefined && perf === undefined)
      throw integrity('BASIS_PERFORMANCE_UNKNOWN', 'performance is not in the basis version');
    const value =
      c.achievementType === 'PERFORMANCE_THRESHOLD' ||
      c.achievementType === 'PERSONAL_BEST' ||
      c.achievementType === 'RECORD_SET';
    if (value ? !sameMark(c.qualifyingValue, perf?.mark) : c.qualifyingValue !== undefined)
      throw integrity(
        'QUALIFYING_VALUE_MISMATCH',
        'qualifyingValue must equal the source performance',
      );
    const lineup = (s.creditedLineups ?? []).find((l) => l.participantId === b.participantId);
    const credits = (c.memberCredits ?? []).map((m) => m.athleteId).sort();
    if (c.holder.holderType === 'TEAM') {
      if (participant.teamId !== c.holder.holderId)
        throw integrity('HOLDER_MISMATCH', 'team holder mismatch');
      const expected =
        lineup === undefined || !s.supportedFactKinds.includes('CREDITED_LINEUP')
          ? []
          : [...new Set(lineup.athleteIds)].sort();
      if (JSON.stringify(credits) !== JSON.stringify(expected))
        throw integrity('MEMBER_CREDITS_MISMATCH', 'member credits must equal the credited lineup');
    } else {
      if (credits.length > 0)
        throw integrity('MEMBER_CREDITS_MISMATCH', 'athlete holders carry no credits');
      const ok =
        participant.kind === 'INDIVIDUAL'
          ? participant.athleteId === c.holder.holderId
          : perf?.athleteId === c.holder.holderId &&
            (lineup?.athleteIds ?? []).includes(c.holder.holderId);
      if (!ok) throw integrity('HOLDER_MISMATCH', 'athlete holder is not supported by the basis');
    }
  }
}

// ───────────────────────────── status history ─────────────────────────────

async function latestStatus(ctx: TxContext, achievementId: string) {
  const { rows } = await sql<{
    status: AchievementStatus;
    reasons: string[];
    superseded_by: string | null;
  }>`
    SELECT status, reasons, superseded_by FROM achievement.status_entry WHERE achievement_id = ${achievementId}
    ORDER BY seq DESC LIMIT 1`.execute(ctx.trx);
  return rows[0];
}

/**
 * Appends a status entry when the assessed status differs from the current one (append-only
 * statusHistory; nothing is rewritten). Ledger + outbox + projection in the same transaction.
 */
async function appendStatus(
  ctx: TxContext,
  achievementId: string,
  a: SupportAssessment,
): Promise<{ changed: boolean; previous?: AchievementStatus; status: AchievementStatus }> {
  const prev = await latestStatus(ctx, achievementId);
  if (
    prev !== undefined &&
    prev.status === a.status &&
    JSON.stringify([...prev.reasons].sort()) === JSON.stringify(a.reasons) &&
    (prev.superseded_by ?? undefined) === a.supersededBy
  )
    return { changed: false, previous: prev.status, status: prev.status };
  if (prev !== undefined && (prev.status === 'SUPERSEDED' || prev.status === 'REVOKED'))
    return { changed: false, previous: prev.status, status: prev.status };
  const id = newId();
  await sql`INSERT INTO achievement.status_entry
      (id, achievement_id, status, reasons, superseded_by, support_facts_hash, assessment_provenance, recorded_at)
    VALUES (${id}, ${achievementId}, ${a.status}, ${a.reasons as string[]}, ${a.supersededBy ?? null},
            ${a.supportFactsHash}, ${a.facts.provenance}, ${ctx.txTime})`.execute(ctx.trx);
  const stream = await openStream(ctx, achievementId as Uuid, StreamType.ACHIEVEMENT);
  await stream.append({
    eventType: 'AchievementStatusRecorded',
    factTable: 'achievement.status_entry',
    factRowId: id as Uuid,
    payloadHash: factHash(SchemaRef.achievementStatusFact, {
      statusEntryId: id,
      achievementId,
      status: a.status,
      reasons: a.reasons,
      ...(a.supersededBy === undefined ? {} : { supersededBy: a.supersededBy }),
      supportFactsHash: a.supportFactsHash,
    }),
  });
  await stream.close();
  if (prev !== undefined)
    await emitEvent(ctx, {
      eventType: 'AchievementCurrentStateChanged',
      aggregateType: 'ACHIEVEMENT',
      aggregateId: achievementId as Uuid,
      payload: {
        achievementId,
        previousStatus: prev.status,
        status: a.status,
        reasons: [...a.reasons],
        ...(a.supersededBy === undefined ? {} : { supersededBy: a.supersededBy }),
      },
    });
  await refreshAchievementCard(ctx, achievementId);
  return {
    changed: true,
    ...(prev === undefined ? {} : { previous: prev.status }),
    status: a.status,
  };
}

// ───────────────────────────── the only Achievement writer ─────────────────────────────

async function insertDerived(
  ctx: TxContext,
  sealed: SealedDerivationSnapshot,
  derivation: Derivation,
  entry: CandidateEntry,
  actorAccountId: string | undefined,
): Promise<PersistedAchievement> {
  validateCandidate(sealed, derivation, entry);
  const c = entry.candidate;
  const s = sealed.snapshot;
  const credits = (c.memberCredits ?? []).map((m) => m.athleteId);
  const view = (achievementId: string, created: boolean, supersedes: string[]) => ({
    achievementId,
    created,
    identityHash: entry.identityHash,
    candidateHash: entry.candidateHash,
    achievementType: c.achievementType,
    holder: c.holder,
    memberCredits: credits,
    supersedes,
  });
  await lockKeys(
    ctx,
    `achievement:${entry.identityHash}`,
    ...(c.record === undefined ? [] : [`record-set:${c.record.recordMarkId}`]),
  );
  if (c.record !== undefined) {
    // One RECORD_SET per RecordMark, whatever run / rule version re-derives it (idempotent).
    const { rows: linked } = await sql<{ achievement_id: string }>`
      SELECT achievement_id FROM achievement.record_basis WHERE record_mark_id = ${c.record.recordMarkId}`.execute(
      ctx.trx,
    );
    if (linked[0] !== undefined) return view(linked[0].achievement_id, false, []);
  }
  const { rows: existing } = await sql<{ id: string; candidate_hash: string }>`
    SELECT id, candidate_hash FROM achievement.achievement WHERE identity_hash = ${entry.identityHash}`.execute(
    ctx.trx,
  );
  const found = existing[0];
  if (found !== undefined) {
    if (found.candidate_hash !== entry.candidateHash)
      throw integrity(
        'IDENTITY_CONTENT_CONFLICT',
        'same logical achievement with different content',
      );
    return view(found.id, false, []);
  }
  const id = newId();
  await sql`INSERT INTO achievement.achievement
      (id, identity_hash, candidate_hash, candidate, achievement_type, rule_id, rule_version_id, engine_version, holder_type,
       holder_id, scope_type, scope_id, competition_id, event_id, discipline_version_id, basis_level, qualifying_value,
       comparison_set_hash, evidence_commitment, governing_recognition_level, governing_anchor_id,
       governing_anchor_fact_hash, snapshot_provenance,
       derivation_snapshot_hash, derivation_outcome_hash, requested_by_account_id, recorded_at)
    VALUES (${id}, ${entry.identityHash}, ${entry.candidateHash}, ${JSON.stringify(c)}, ${c.achievementType}, ${c.rule.ruleId},
            ${c.rule.ruleVersionId}, ${c.engineVersion}, ${c.holder.holderType}, ${c.holder.holderId}, ${c.scope.scopeType},
            ${c.scope.scopeId}, ${c.context.competitionId}, ${c.context.eventId ?? null}, ${c.context.disciplineVersionId},
            ${c.basisLevel}, ${c.qualifyingValue === undefined ? null : JSON.stringify(c.qualifyingValue)},
            ${c.comparisonSetHash ?? null}, ${c.evidenceCommitment}, ${c.governingAuthority?.recognitionLevel ?? null},
            ${c.governingAuthority?.anchorId ?? null}, ${c.governingAuthority?.anchorFactHash ?? null}, ${c.provenance}, ${sealed.snapshotHash}, ${derivation.outcomeHash},
            ${actorAccountId ?? null}, ${ctx.txTime})`.execute(ctx.trx);
  for (const b of c.basis)
    await sql`INSERT INTO achievement.basis_item
        (achievement_id, result_version_id, content_hash, result_status, verification_run_id, verification_snapshot_hash,
         verification_outcome_hash, pinned_run_level, participant_id, performance_ordinal, credited_lineup_hash,
         evidence_bundle_hash, evidence_bundle_as_of, recorded_at)
      VALUES (${id}, ${b.resultVersionId}, ${b.contentHash}, ${b.resultStatus}, ${b.verificationRunId},
              ${b.verificationSnapshotHash}, ${b.verificationOutcomeHash}, ${b.verificationLevel}, ${b.participantId},
              ${b.performanceOrdinal ?? null}, ${b.creditedLineupHash ?? null}, ${b.evidenceBundleHash},
              ${b.evidenceBundleAsOf}, ${ctx.txTime})`.execute(ctx.trx);
  for (const m of c.memberCredits ?? [])
    await sql`INSERT INTO achievement.member_credit (achievement_id, athlete_id, credit_role, recorded_at)
      VALUES (${id}, ${m.athleteId}, ${m.creditRole}, ${ctx.txTime})`.execute(ctx.trx);
  // BRT-09 (ADR-0045): the append-only RECORD_SET → RecordMark link (the mark row is never mutated).
  if (c.record !== undefined)
    await sql`INSERT INTO achievement.record_basis
        (achievement_id, record_mark_id, mark_hash, category_id, category_version_id, category_version_hash,
         ratification_entry_id, ratification_hash, standing, recorded_at)
      VALUES (${id}, ${c.record.recordMarkId}, ${c.record.markHash}, ${c.record.categoryId},
              ${c.record.categoryVersionId}, ${c.record.categoryVersionHash}, ${c.record.ratificationEntryId},
              ${c.record.ratificationHash}, ${c.record.standing}, ${ctx.txTime})`.execute(ctx.trx);

  const stream = await openStream(ctx, id as Uuid, StreamType.ACHIEVEMENT);
  await stream.append({
    eventType: 'AchievementDerived',
    factTable: 'achievement.achievement',
    factRowId: id as Uuid,
    payloadHash: factHash(SchemaRef.achievementFact, {
      achievementId: id,
      identityHash: entry.identityHash,
      candidateHash: entry.candidateHash,
      derivationSnapshotHash: sealed.snapshotHash,
      derivationOutcomeHash: derivation.outcomeHash,
      provenance: c.provenance,
    }),
  });
  await stream.close();
  const required = effectiveRequirements(s.rule.spec).level;
  await appendStatus(
    ctx,
    id,
    assessSupport({
      provenance: s.provenance,
      achievementId: id,
      requiredLevel: required,
      basis: c.basis.map((b) => ({
        resultVersionId: b.resultVersionId,
        pinnedRunId: b.verificationRunId,
        status: s.resultVersion.status,
        verification: s.verification,
      })),
      holdSupported: s.supportedFactKinds.includes('HOLD_STATE'),
      ...(s.hold === undefined ? {} : { holdActive: s.hold.active }),
      ...(s.record === undefined ? {} : { recordMarkStatus: s.record.currentStatus }),
    }),
  );
  await emitEvent(ctx, {
    eventType: 'AchievementDerived',
    aggregateType: 'ACHIEVEMENT',
    aggregateId: id as Uuid,
    payload: {
      achievementId: id,
      achievementType: c.achievementType,
      holderType: c.holder.holderType,
      holderId: c.holder.holderId,
      scopeType: c.scope.scopeType,
      scopeId: c.scope.scopeId,
      ruleVersionId: c.rule.ruleVersionId,
      identityHash: entry.identityHash,
      candidateHash: entry.candidateHash,
      basis: c.basis.map((b) => ({
        resultVersionId: b.resultVersionId,
        contentHash: b.contentHash,
        verificationRunId: b.verificationRunId,
      })),
    },
  });

  // Supersession: an ACTIVE / SUSPENDED Achievement of the same type / rule / holder / scope whose
  // basis is the version this one corrects (or an older run of the same version) is replaced — the
  // old fact is never modified; it gains a link and a SUPERSEDED status entry.
  const supersedesRv = s.resultVersion.supersedesVersionId ?? null;
  const { rows: preds } = await sql<{ id: string }>`
    SELECT DISTINCT a.id FROM achievement.achievement a
    JOIN achievement.v_achievement_status st ON st.achievement_id = a.id
    JOIN achievement.basis_item b ON b.achievement_id = a.id
    WHERE a.id <> ${id} AND a.achievement_type = ${c.achievementType} AND a.rule_id = ${c.rule.ruleId}
      AND a.holder_type = ${c.holder.holderType} AND a.holder_id = ${c.holder.holderId}
      AND a.scope_type = ${c.scope.scopeType} AND a.scope_id = ${c.scope.scopeId}
      AND a.snapshot_provenance = ${c.provenance} AND st.status IN ('ACTIVE', 'SUSPENDED')
      AND (b.result_version_id = ${supersedesRv}::uuid
           OR (b.result_version_id = ${s.resultVersion.resultVersionId}::uuid AND b.verification_run_id <> ${s.verification.runId ?? null}::uuid))
    ORDER BY a.id`.execute(ctx.trx);
  const supersedes: string[] = [];
  for (const p of preds) {
    await sql`INSERT INTO achievement.supersession (superseded_id, superseding_id, recorded_at)
      VALUES (${p.id}, ${id}, ${ctx.txTime})`.execute(ctx.trx);
    const { rows: items } = await sql<{
      result_version_id: string;
      verification_run_id: string;
      result_status: string;
    }>`
      SELECT result_version_id, verification_run_id, result_status FROM achievement.basis_item WHERE achievement_id = ${p.id}`.execute(
      ctx.trx,
    );
    await appendStatus(
      ctx,
      p.id,
      assessSupport({
        provenance: c.provenance,
        achievementId: p.id,
        requiredLevel: required,
        basis: items.map((i) => ({
          resultVersionId: i.result_version_id,
          pinnedRunId: i.verification_run_id,
          status: i.result_status as SupportFacts['basis'][number]['status'],
          ...(i.result_version_id === supersedesRv
            ? { supersededByVersionId: s.resultVersion.resultVersionId }
            : {}),
        })),
        replacementAchievementId: id,
      }),
    );
    supersedes.push(p.id);
  }
  await refreshAchievementCard(ctx, id);
  return view(id, true, supersedes);
}

// ───────────────────────────── exported lane entry points ─────────────────────────────

export interface DerivationReport {
  readonly ruleCode: string;
  readonly ruleVersion: number;
  readonly achievementType: AchievementType;
  readonly state: 'ISSUABLE' | 'BLOCKED' | 'NO_QUALIFYING_FACTS';
  readonly blockedBy: readonly string[];
  readonly snapshotHash: string;
  readonly outcomeHash: string;
  readonly provenance: 'CANONICAL_ASSEMBLY' | 'REFERENCE_FIXTURE';
  readonly wouldQualify: number;
  readonly achievements: readonly PersistedAchievement[];
}

async function persistSealed(
  ctx: TxContext,
  sealed: SealedDerivationSnapshot,
  displayCode: { code: string; version: number },
  actorAccountId: string | undefined,
): Promise<DerivationReport> {
  const d = deriveAchievements(sealed.snapshot);
  const achievements: PersistedAchievement[] = [];
  for (const entry of d.outcome.candidates ?? [])
    achievements.push(await insertDerived(ctx, sealed, d, entry, actorAccountId));
  return {
    ruleCode: displayCode.code,
    ruleVersion: displayCode.version,
    achievementType: sealed.snapshot.rule.spec.achievementType,
    state: d.outcome.state,
    blockedBy: blockingReasons(d.outcome),
    snapshotHash: d.snapshotHash,
    outcomeHash: d.outcomeHash,
    provenance: sealed.snapshot.provenance,
    wouldQualify: (d.outcome.subjects ?? []).filter((x) => x.qualifies).length,
    achievements,
  };
}

/**
 * BRT-09: RECORD_SET rules applicable to a ratified mark — bound (no retroactivity) at the moment the
 * mark was ratified, which is the fact that creates a RECORD_SET (BRT-01 §8.2).
 */
async function recordSetRulesAt(
  ctx: TxContext,
  facts: VersionFacts,
  ratifiedAt: Date,
): Promise<ApplicableRule[]> {
  return (
    await applicableRules(ctx, {
      disciplineVersionId: facts.disciplineVersionId,
      competitionId: facts.path.competitionId,
      eventId: facts.path.eventId,
      submittedAt: ratifiedAt,
    })
  ).filter((r) => r.spec.achievementType === 'RECORD_SET');
}

/** Re-assembles the canonical snapshot a CANONICAL_ASSEMBLY claim names, from live facts. */
async function reassembleCanonical(
  ctx: TxContext,
  claimed: SealedDerivationSnapshot,
): Promise<SealedDerivationSnapshot> {
  const facts = await loadVersionFacts(ctx, claimed.snapshot.resultVersion.resultVersionId);
  if (facts === undefined)
    throw integrity('CANONICAL_SNAPSHOT_MISMATCH', 'result version not found');
  if (claimed.snapshot.record !== undefined) {
    const mark = (await ratifiedRecordMarks(ctx, facts.rv.resultVersionId)).find(
      (m) => m.recordMarkId === claimed.snapshot.record?.recordMarkId,
    );
    const rule =
      mark === undefined
        ? undefined
        : (await recordSetRulesAt(ctx, facts, mark.ratifiedAt)).find(
            (r) => r.ruleVersionId === claimed.snapshot.rule.ruleVersionId,
          );
    if (mark === undefined || rule === undefined)
      throw integrity('CANONICAL_SNAPSHOT_MISMATCH', 'record mark / rule is not applicable');
    const { ratifiedAt: _t, ...record } = mark;
    const sealed = await assembleCanonicalSnapshot(
      ctx,
      facts,
      rule,
      await verificationSummary(ctx, facts.rv.resultVersionId),
      record,
    );
    if (sealed.snapshotHash !== claimed.snapshotHash)
      throw integrity('CANONICAL_SNAPSHOT_MISMATCH', 'snapshot is not the canonical assembly');
    return sealed;
  }
  const rule = (
    await applicableRules(ctx, {
      disciplineVersionId: facts.disciplineVersionId,
      competitionId: facts.path.competitionId,
      eventId: facts.path.eventId,
      submittedAt: facts.submittedAt,
    })
  ).find((r) => r.ruleVersionId === claimed.snapshot.rule.ruleVersionId);
  if (rule === undefined) throw integrity('CANONICAL_SNAPSHOT_MISMATCH', 'rule is not applicable');
  const sealed = await assembleCanonicalSnapshot(
    ctx,
    facts,
    rule,
    await verificationSummary(ctx, facts.rv.resultVersionId),
  );
  if (sealed.snapshotHash !== claimed.snapshotHash)
    throw integrity('CANONICAL_SNAPSHOT_MISMATCH', 'snapshot is not the canonical assembly');
  return sealed;
}

/** REPEATABLE READ achievement transaction with bounded retries on BRT-07 clock-step inconsistency. */
async function achievementTx<T>(db: Db, fn: (ctx: TxContext) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await inTransaction(db, ModuleRole.achievements, fn, 6, {
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

/**
 * Persists every candidate of ONE sealed snapshot through the validated path. A CANONICAL_ASSEMBLY
 * snapshot must equal the canonical re-assembly (no caller-supplied sporting facts); a
 * REFERENCE_FIXTURE snapshot is refused by the normal schema (CHECK) and succeeds only in a
 * throwaway overlay database. There is no flag that changes any of this.
 */
export function persistDerivation(
  db: Db,
  input: { readonly snapshot: unknown; readonly actorAccountId?: string },
): Promise<DerivationReport> {
  const claimed = sealDerivationSnapshot(input.snapshot);
  return achievementTx(db, async (ctx) => {
    const sealed =
      claimed.snapshot.provenance === 'CANONICAL_ASSEMBLY'
        ? await reassembleCanonical(ctx, claimed)
        : claimed;
    return persistSealed(
      ctx,
      sealed,
      { code: sealed.snapshot.rule.code, version: sealed.snapshot.rule.version },
      input.actorAccountId,
    );
  });
}

/**
 * Records a current-support assessment. CANONICAL_ASSEMBLY facts must equal the facts re-computed
 * from canonical data now; REFERENCE_FIXTURE facts are refused by the normal schema (CHECK).
 */
export function recordSupportAssessment(
  db: Db,
  facts: SupportFacts,
): Promise<{ changed: boolean; previous?: AchievementStatus; status: AchievementStatus }> {
  return achievementTx(db, async (ctx) => {
    const assessment = assessSupport(facts);
    if (facts.provenance === 'CANONICAL_ASSEMBLY') {
      const recomputed = await canonicalSupportFacts(ctx, facts.achievementId);
      if (
        recomputed === undefined ||
        assessSupport(recomputed).supportFactsHash !== assessment.supportFactsHash
      )
        throw integrity('CANONICAL_SUPPORT_MISMATCH', 'support facts are not the canonical facts');
    }
    return appendStatus(ctx, facts.achievementId, assessment);
  });
}

// ───────────────────────────── canonical support facts ─────────────────────────────

async function achievementCore(ctx: TxContext, achievementId: string) {
  const { rows } = await sql<{
    id: string;
    rule_id: string;
    holder_type: string;
    holder_id: string;
    provenance: 'CANONICAL_ASSEMBLY' | 'REFERENCE_FIXTURE';
    spec: ApplicableRule['spec'];
  }>`
    SELECT a.id, a.rule_id, a.holder_type, a.holder_id, a.snapshot_provenance AS provenance, v.spec
    FROM achievement.achievement a JOIN achievement.rule_version v ON v.id = a.rule_version_id
    WHERE a.id = ${achievementId}`.execute(ctx.trx);
  const a = rows[0];
  if (a === undefined) return undefined;
  const { rows: items } = await sql<{ result_version_id: string; verification_run_id: string }>`
    SELECT result_version_id, verification_run_id FROM achievement.basis_item WHERE achievement_id = ${achievementId}
    ORDER BY result_version_id`.execute(ctx.trx);
  return { ...a, items };
}

/**
 * The canonical current-support facts of a CANONICAL_ASSEMBLY Achievement: live status,
 * supersession and BRT-07 freshness of every basis version; for a superseded basis, whether the
 * successor version (under the same rule) is issuable for this holder. Hold state is not produced
 * by the platform (holdSupported = false).
 */
async function canonicalSupportFacts(
  ctx: TxContext,
  achievementId: string,
): Promise<SupportFacts | undefined> {
  const a = await achievementCore(ctx, achievementId);
  if (a === undefined || a.provenance !== 'CANONICAL_ASSEMBLY') return undefined;
  const basis = [];
  for (const i of a.items)
    basis.push(
      await canonicalBasisFact(ctx, {
        resultVersionId: i.result_version_id,
        pinnedRunId: i.verification_run_id,
      }),
    );
  let successorDerivation: SupportFacts['successorDerivation'];
  const successor = basis.find((b) => b.supersededByVersionId !== undefined)?.supersededByVersionId;
  if (successor !== undefined) {
    successorDerivation = 'BLOCKED';
    const facts = await loadVersionFacts(ctx, successor);
    const rule =
      facts === undefined
        ? undefined
        : (
            await applicableRules(ctx, {
              disciplineVersionId: facts.disciplineVersionId,
              competitionId: facts.path.competitionId,
              eventId: facts.path.eventId,
              submittedAt: facts.submittedAt,
            })
          ).find((r) => r.ruleId === a.rule_id);
    if (facts !== undefined && rule !== undefined) {
      const sealed = await assembleCanonicalSnapshot(
        ctx,
        facts,
        rule,
        await verificationSummary(ctx, successor),
      );
      const d = deriveAchievements(sealed.snapshot);
      if (d.outcome.state !== 'BLOCKED')
        successorDerivation = (d.outcome.candidates ?? []).some(
          (x) =>
            x.candidate.holder.holderType === a.holder_type &&
            x.candidate.holder.holderId === a.holder_id,
        )
          ? 'HOLDER_QUALIFIES'
          : 'HOLDER_DOES_NOT_QUALIFY';
    }
  }
  const { rows: rec } = await sql<{ status: SupportFacts['recordMarkStatus'] }>`
    SELECT (SELECT s.status FROM record.mark_status_entry s WHERE s.record_mark_id = b.record_mark_id
            ORDER BY s.seq DESC LIMIT 1) AS status
    FROM achievement.record_basis b WHERE b.achievement_id = ${achievementId}`.execute(ctx.trx);
  const { rows: floorSpec } = await sql<{ spec: RecordCategorySpec }>`
    SELECT v.spec FROM achievement.record_basis b JOIN record.category_version v ON v.id = b.category_version_id
    WHERE b.achievement_id = ${achievementId}`.execute(ctx.trx);
  const base = effectiveRequirements(a.spec).level;
  // RECORD_SET: current support is measured against the recognized mark's category floor.
  const recordFloor = floorSpec[0] === undefined ? undefined : categoryFloor(floorSpec[0].spec);
  return {
    provenance: 'CANONICAL_ASSEMBLY',
    achievementId,
    requiredLevel:
      recordFloor !== undefined &&
      verificationLevelIndex(recordFloor) > verificationLevelIndex(base)
        ? recordFloor
        : base,
    basis,
    holdSupported: false,
    ...(successorDerivation === undefined ? {} : { successorDerivation }),
    ...(rec[0]?.status === undefined || rec[0].status === null
      ? {}
      : { recordMarkStatus: rec[0].status }),
  };
}

// ───────────────────────────── current support: sources, sweep, live view ─────────────────────────────

/**
 * Where current-support facts come from. The canonical source recomputes them from live canonical
 * facts (status, supersession, BRT-07 hash-based freshness). The persistence fixture harness passes a
 * REFERENCE_FIXTURE source; the database refuses such assessments for canonical Achievements (BR123:
 * provenance must match) and the normal schema refuses them entirely (CHECK).
 */
export type SupportFactSource = (
  ctx: TxContext,
  achievementId: string,
) => Promise<SupportFacts | undefined>;
export const canonicalSupportSource: SupportFactSource = (ctx, id) =>
  canonicalSupportFacts(ctx, id);

async function nonTerminalIds(
  ctx: TxContext,
  provenance: 'CANONICAL_ASSEMBLY' | 'REFERENCE_FIXTURE',
  resultVersionIds?: readonly string[],
): Promise<string[]> {
  const { rows } = await sql<{ id: string }>`
    SELECT DISTINCT a.id FROM achievement.achievement a
    JOIN achievement.v_achievement_status st ON st.achievement_id = a.id
    JOIN achievement.basis_item b ON b.achievement_id = a.id
    WHERE st.status IN ('ACTIVE', 'SUSPENDED') AND a.snapshot_provenance = ${provenance}
      AND (${resultVersionIds === undefined} OR b.result_version_id = ANY(${resultVersionIds ?? []}::uuid[]))
    ORDER BY a.id LIMIT 500`.execute(ctx.trx);
  return rows.map((r) => r.id);
}

async function reassessWith(ctx: TxContext, source: SupportFactSource, ids: readonly string[]) {
  const out: { achievementId: string; status: AchievementStatus; changed: boolean }[] = [];
  for (const id of ids) {
    const facts = await source(ctx, id);
    if (facts === undefined) continue;
    const r = await appendStatus(ctx, id, assessSupport(facts));
    out.push({ achievementId: id, status: r.status, changed: r.changed });
  }
  return out;
}

/**
 * Re-assesses the current support of every non-terminal Achievement of a provenance (optionally only
 * those depending on given ResultVersions) from a support-fact source; appends a status entry only
 * when the status changes (idempotent under replay). Used by the worker (canonical source).
 */
export function sweepSupport(
  db: Db,
  source: SupportFactSource,
  opts: {
    readonly provenance: 'CANONICAL_ASSEMBLY' | 'REFERENCE_FIXTURE';
    readonly resultVersionIds?: readonly string[];
  },
) {
  return achievementTx(db, async (ctx) =>
    reassessWith(ctx, source, await nonTerminalIds(ctx, opts.provenance, opts.resultVersionIds)),
  );
}

/**
 * The LIVE current support of one Achievement (no write): what reads present. A non-terminal
 * Achievement whose pinned run is no longer CURRENT is never presented as currently supported, even
 * before any event-driven re-assessment has been recorded.
 */
export function liveSupport(
  db: Db,
  achievementId: string,
  source: SupportFactSource,
): Promise<SupportAssessment | undefined> {
  return achievementTx(db, async (ctx) => {
    const facts = await source(ctx, achievementId);
    return facts === undefined ? undefined : assessSupport(facts);
  });
}

// ───────────────────────────── canonical production service ─────────────────────────────

export interface ResultVersionDerivation {
  readonly resultVersionId: string;
  readonly provenance: 'CANONICAL_ASSEMBLY';
  readonly rules: readonly DerivationReport[];
  readonly noApplicableRule: boolean;
  readonly reassessed: readonly {
    achievementId: string;
    status: AchievementStatus;
    changed: boolean;
  }[];
}

const DERIVATION_EVENTS = new Set([
  // BRT-09: a validly ratified RecordMark ⇒ its RECORD_SET (validated derivation, idempotent).
  'RecordMarkRatified',
  'RecordMarkCanonicalized',
  'VerificationEvaluated',
  'AchievementRuleBound',
  'ResultSubmitted',
  'ResultProvisional',
]);
/**
 * Canonical events that can make a pinned VerificationRun non-CURRENT (BRT-07 hash-based freshness)
 * or change a basis: each triggers an automatic re-assessment of current support. (Reads also apply
 * a live freshness check, so staleness is never presented as current even between events.)
 */
const SWEEP_EVENTS = new Set([
  'PrincipalKeyStatusChanged',
  'AuthorityGrantIssued',
  'AuthorityGrantRevoked',
  'TrustAnchorRecognized',
  'TrustAnchorChanged',
  'EvidenceAdded',
  'EvidenceAttached',
  'EvidenceDerived',
  'EvidencePrivacyRaised',
  'AttestationIssued',
  'AttestationRetracted',
  'AttestationSuperseded',
  'EvidenceAvailabilityChanged',
  'VerificationPolicyBound',
  'CurrentVerificationChanged',
  // BRT-09: a rescinded RecordMark revokes its RECORD_SET.
  'RecordMarkRescinded',
]);

/**
 * The CANONICAL PRODUCTION lane. Derives from snapshots it assembles itself from real canonical
 * facts, persists through the validated writer, and re-assesses the current support of Achievements
 * that depend on a changed basis. Requesting a derivation confers nothing and chooses nothing: the
 * only input is an exact ResultVersion id. Honest production output today is ZERO Achievements
 * (no V2, no OFFICIAL/FINAL, no hold facts, no credited lineups are produced) — every blocker is
 * reported.
 */
export class AchievementService {
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

  /** Records a refused INTERNAL rule mutation when no operator connection exists (503) or denied. */
  auditDeniedRuleMutation(actorAccountId: string | undefined, action: string): Promise<void> {
    return inTransaction(this.db, ModuleRole.achievements, (ctx) =>
      recordAudit(ctx, {
        ...(actorAccountId === undefined ? {} : { actorAccountId }),
        action,
        targetType: 'ACHIEVEMENT_RULE',
        outcome: 'DENIED',
      }),
    );
  }

  /** Canonical derivation for one exact ResultVersion (staff / INTERNAL; the worker uses `react`). */
  async derive(input: {
    readonly actor: EvidenceActor;
    readonly resultVersionId: string;
  }): Promise<ResultVersionDerivation> {
    const r = await achievementTx(
      this.db,
      async (ctx): Promise<Committed<ResultVersionDerivation>> => {
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
            action: 'achievement.derivation-requested',
            targetType: 'RESULT_VERSION',
            outcome: 'DENIED',
          });
          return { error: new DomainError(DomainErrorCode.NOT_FOUND, 'result version not found') };
        }
        const out = await this.deriveInTx(ctx, input.resultVersionId, actorAccountId);
        if (out === undefined)
          return { error: new DomainError(DomainErrorCode.NOT_FOUND, 'result version not found') };
        return { ok: out };
      },
    );
    return unwrap(r);
  }

  private async deriveInTx(
    ctx: TxContext,
    resultVersionId: string,
    actorAccountId: string | undefined,
  ): Promise<ResultVersionDerivation | undefined> {
    const facts = await loadVersionFacts(ctx, resultVersionId);
    if (facts === undefined) return undefined;
    const rules = (
      await applicableRules(ctx, {
        disciplineVersionId: facts.disciplineVersionId,
        competitionId: facts.path.competitionId,
        eventId: facts.path.eventId,
        submittedAt: facts.submittedAt,
      })
    ).filter((r) => r.spec.achievementType !== 'RECORD_SET');
    const verification =
      rules.length === 0 ? undefined : await verificationSummary(ctx, resultVersionId);
    const reports: DerivationReport[] = [];
    for (const rule of rules) {
      const sealed = await assembleCanonicalSnapshot(
        ctx,
        facts,
        rule,
        verification ?? { state: 'NOT_EVALUATED' },
      );
      const report = await persistSealed(
        ctx,
        sealed,
        { code: rule.code, version: rule.version },
        actorAccountId,
      );
      reports.push(report);
      await recordAudit(ctx, {
        actorAccountId,
        action: 'achievement.derivation-requested',
        targetType: 'RESULT_VERSION',
        targetId: resultVersionId,
        outcome: 'SUCCEEDED',
        details: {
          ruleCode: rule.code,
          ruleVersion: rule.version,
          state: report.state,
          blockedBy: [...report.blockedBy],
          persisted: report.achievements.filter((x) => x.created).length,
        },
      });
    }
    if (rules.length === 0)
      await recordAudit(ctx, {
        actorAccountId,
        action: 'achievement.derivation-requested',
        targetType: 'RESULT_VERSION',
        targetId: resultVersionId,
        outcome: 'SUCCEEDED',
        details: { state: 'NO_APPLICABLE_RULE' },
      });
    // BRT-09 RECORD_SET: one snapshot per validly ratified mark of this version, under the RECORD_SET
    // rules in force when it was ratified. Marks already linked are skipped (one RECORD_SET per mark).
    for (const mark of await ratifiedRecordMarks(ctx, resultVersionId)) {
      const { rows: linked } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM achievement.record_basis WHERE record_mark_id = ${mark.recordMarkId}`.execute(
        ctx.trx,
      );
      if ((linked[0]?.n ?? 0) > 0) continue;
      const { ratifiedAt: _t, ...record } = mark;
      for (const rule of await recordSetRulesAt(ctx, facts, mark.ratifiedAt)) {
        const sealed = await assembleCanonicalSnapshot(
          ctx,
          facts,
          rule,
          await verificationSummary(ctx, resultVersionId),
          record,
        );
        reports.push(
          await persistSealed(
            ctx,
            sealed,
            { code: rule.code, version: rule.version },
            actorAccountId,
          ),
        );
      }
    }
    const reassessed = await this.reassessDependents(ctx, [
      resultVersionId,
      facts.supersedesVersionId,
    ]);
    return {
      resultVersionId,
      provenance: 'CANONICAL_ASSEMBLY',
      rules: reports,
      noApplicableRule: rules.length === 0,
      reassessed,
    };
  }

  private async reassessDependents(
    ctx: TxContext,
    resultVersionIds: readonly (string | undefined)[],
  ) {
    const ids = resultVersionIds.filter((x): x is string => x !== undefined);
    if (ids.length === 0) return [];
    const { rows } = await sql<{ id: string }>`
      SELECT DISTINCT a.id FROM achievement.achievement a
      JOIN achievement.basis_item b ON b.achievement_id = a.id
      JOIN achievement.v_achievement_status st ON st.achievement_id = a.id
      WHERE b.result_version_id = ANY(${ids}::uuid[]) AND st.status IN ('ACTIVE', 'SUSPENDED')
        AND a.snapshot_provenance = 'CANONICAL_ASSEMBLY'
      ORDER BY a.id`.execute(ctx.trx);
    return this.reassessIds(
      ctx,
      rows.map((r) => r.id),
    );
  }

  private reassessIds(ctx: TxContext, ids: readonly string[]) {
    return reassessWith(ctx, canonicalSupportSource, ids);
  }

  /** INTERNAL / staff: re-assess the current support of one canonical Achievement now. */
  async reassess(input: { readonly actor: EvidenceActor; readonly achievementId: string }) {
    const r = await achievementTx(
      this.db,
      async (
        ctx,
      ): Promise<
        Committed<{ achievementId: string; status: AchievementStatus; changed: boolean }>
      > => {
        const { rows } = UUID.test(input.achievementId)
          ? await sql<{
              competition_id: string;
            }>`SELECT competition_id FROM achievement.achievement WHERE id = ${input.achievementId}`.execute(
              ctx.trx,
            )
          : { rows: [] as { competition_id: string }[] };
        if (
          rows[0] === undefined ||
          !(await this.staffAllowed(ctx, input.actor, rows[0].competition_id))
        ) {
          await recordAudit(ctx, {
            actorAccountId: 'accountId' in input.actor ? input.actor.accountId : undefined,
            action: 'achievement.reassessment-requested',
            targetType: 'ACHIEVEMENT',
            outcome: 'DENIED',
          });
          return { error: new DomainError(DomainErrorCode.NOT_FOUND, 'achievement not found') };
        }
        const [res] = await this.reassessIds(ctx, [input.achievementId]);
        await recordAudit(ctx, {
          actorAccountId: 'accountId' in input.actor ? input.actor.accountId : undefined,
          action: 'achievement.reassessment-requested',
          targetType: 'ACHIEVEMENT',
          targetId: input.achievementId,
        });
        if (res === undefined)
          return { error: new DomainError(DomainErrorCode.NOT_FOUND, 'achievement not found') };
        return { ok: res };
      },
    );
    return unwrap(r);
  }

  /**
   * Worker reaction (at-least-once delivery ⇒ exactly-once logical effects through natural
   * identity). Only canonical events are consumed; there is no fixture job, flag or event.
   */
  async react(event: DomainEvent): Promise<{ derived: number; reassessed: number } | undefined> {
    const rvId =
      typeof event.payload.resultVersionId === 'string'
        ? event.payload.resultVersionId
        : event.aggregateType === 'RESULT_VERSION'
          ? event.aggregateId
          : undefined;
    if (DERIVATION_EVENTS.has(event.eventType) && rvId !== undefined) {
      return achievementTx(this.db, async (ctx) => {
        const out = await this.deriveInTx(ctx, rvId, undefined);
        return {
          derived: (out?.rules ?? []).reduce(
            (n, r) => n + r.achievements.filter((a) => a.created).length,
            0,
          ),
          reassessed: out?.reassessed.length ?? 0,
        };
      });
    }
    if (SWEEP_EVENTS.has(event.eventType)) {
      return achievementTx(this.db, async (ctx) => {
        const { rows } = await sql<{ id: string }>`
          SELECT a.id FROM achievement.achievement a JOIN achievement.v_achievement_status st ON st.achievement_id = a.id
          WHERE st.status IN ('ACTIVE', 'SUSPENDED') AND a.snapshot_provenance = 'CANONICAL_ASSEMBLY' ORDER BY a.id LIMIT 500`.execute(
          ctx.trx,
        );
        const out = await this.reassessIds(
          ctx,
          rows.map((r) => r.id),
        );
        return { derived: 0, reassessed: out.filter((x) => x.changed).length };
      });
    }
    return undefined;
  }

  /** INTERNAL / staff: the dependency index for an exact ResultVersion (and its performances). */
  async dependents(input: { readonly actor: EvidenceActor; readonly resultVersionId: string }) {
    const r = await inTransaction(
      this.db,
      ModuleRole.achievements,
      async (ctx): Promise<Committed<unknown>> => {
        const facts = UUID.test(input.resultVersionId)
          ? await loadVersionFacts(ctx, input.resultVersionId)
          : undefined;
        if (
          facts === undefined ||
          !(await this.staffAllowed(ctx, input.actor, facts.path.competitionId))
        )
          return { error: new DomainError(DomainErrorCode.NOT_FOUND, 'result version not found') };
        return { ok: await dependencyIndex(ctx, { resultVersionId: input.resultVersionId }) };
      },
    );
    return unwrap(r);
  }
}

/** Dependency queries over the canonical basis items (BRT-08 §49). */
export async function dependencyIndex(
  ctx: TxContext,
  q: {
    resultVersionId?: string;
    verificationRunId?: string;
    participantId?: string;
    performanceOrdinal?: number;
  },
) {
  const { rows } = await sql<{
    achievement_id: string;
    achievement_type: string;
    result_version_id: string;
    verification_run_id: string;
    participant_id: string;
    performance_ordinal: number | null;
    status: string;
  }>`
    SELECT b.achievement_id, a.achievement_type, b.result_version_id, b.verification_run_id, b.participant_id,
           b.performance_ordinal, st.status
    FROM achievement.basis_item b
    JOIN achievement.achievement a ON a.id = b.achievement_id
    JOIN achievement.v_achievement_status st ON st.achievement_id = a.id
    WHERE (${q.resultVersionId ?? null}::uuid IS NULL OR b.result_version_id = ${q.resultVersionId ?? null}::uuid)
      AND (${q.verificationRunId ?? null}::uuid IS NULL OR b.verification_run_id = ${q.verificationRunId ?? null}::uuid)
      AND (${q.participantId ?? null}::uuid IS NULL OR b.participant_id = ${q.participantId ?? null}::uuid)
      AND (${q.performanceOrdinal ?? null}::int IS NULL OR b.performance_ordinal = ${q.performanceOrdinal ?? null}::int)
    ORDER BY b.achievement_id`.execute(ctx.trx);
  return rows.map((r) => ({
    achievementId: r.achievement_id,
    achievementType: r.achievement_type,
    resultVersionId: r.result_version_id,
    verificationRunId: r.verification_run_id,
    participantId: r.participant_id,
    ...(r.performance_ordinal === null ? {} : { performanceOrdinal: r.performance_ordinal }),
    status: r.status,
  }));
}

// ───────────────────────────── public read path (br_public_read) ─────────────────────────────

export interface PublicAthleteRef {
  readonly privateEntrant?: true;
  readonly athleteId?: string;
  readonly slug?: string;
  readonly displayName?: string;
}

export interface PublicAchievementV1 {
  readonly schema: 'br:public-achievement@1';
  readonly achievementId: string;
  readonly type: AchievementType;
  readonly typeLabel: string;
  readonly displayName: string;
  readonly holder:
    | { readonly holderType: 'ATHLETE'; readonly athlete: PublicAthleteRef }
    | {
        readonly holderType: 'TEAM';
        readonly team: { readonly teamId: string; readonly name?: string };
      };
  readonly memberCredits?: readonly {
    readonly creditType: 'TEAM_MEMBER';
    readonly creditRole: 'LINEUP_MEMBER';
    readonly athlete: PublicAthleteRef;
  }[];
  readonly context: {
    readonly sport?: string;
    readonly discipline?: string;
    readonly competition: { readonly competitionId: string; readonly name?: string };
    readonly event?: { readonly eventId: string; readonly name?: string };
    readonly scopeType: string;
  };
  readonly qualifyingValue?: Mark & { readonly display: string };
  readonly verification: {
    readonly levelAtDerivation: VerificationLevel;
    readonly label: string;
    readonly statement: string;
    /** AC-4 governing recognition of the basis: level, public region / sport scope and fixed wording
     *  only (no anchor, fact-hash, grant or chain identifiers). */
    readonly governingRecognition?: {
      readonly level: string;
      readonly region?: readonly string[];
      readonly sport?: readonly string[];
      readonly statement: string;
    };
  };
  readonly rule: {
    readonly code: string;
    readonly version: number;
    readonly engineVersion: string;
  };
  readonly currentSupport: {
    readonly status: AchievementStatus;
    readonly currentlySupported: boolean;
    readonly statement: string;
    readonly reasons: readonly { readonly code: string; readonly explanation: string }[];
    readonly since: string;
    readonly supersededBy?: string;
    readonly supersedes: readonly string[];
    /** True when the status was re-assessed from live canonical facts at read time. */
    readonly assessedLive: boolean;
  };
  readonly derivedAt: string;
  readonly notice: string;
}

interface CardRow {
  achievement_id: string;
  achievement_type: AchievementType;
  display_name: string;
  rule_code: string;
  rule_version: number;
  engine_version: string;
  holder_type: 'ATHLETE' | 'TEAM';
  holder_id: string;
  member_athlete_ids: string[];
  scope_type: string;
  competition_id: string;
  event_id: string | null;
  sport_code: string | null;
  discipline_code: string | null;
  basis_level: VerificationLevel;
  qualifying_value: Mark | null;
  governing_recognition_level: string | null;
  governing_recognition_region: string[] | null;
  governing_recognition_sport: string[] | null;
  status: AchievementStatus;
  status_reasons: string[];
  superseded_by: string | null;
  supersedes: string[];
  status_since: Date;
  recorded_at: Date;
  competition_name: string;
  event_name: string | null;
}

/** Athlete display through the Passport privacy policy: restricted / private athletes are never named. */
async function athleteRefs(
  ctx: TxContext,
  ids: readonly string[],
): Promise<Map<string, PublicAthleteRef>> {
  const out = new Map<string, PublicAthleteRef>(ids.map((id) => [id, { privateEntrant: true }]));
  if (ids.length === 0) return out;
  const { rows } = await sql<{ athlete_id: string; slug: string; display_name: string }>`
    SELECT athlete_id, slug, display_name FROM passport.athlete_card
    WHERE athlete_id = ANY(${ids}::uuid[]) AND profile_visibility = 'PUBLIC' AND NOT restricted AND athlete_status = 'ACTIVE'`.execute(
    ctx.trx,
  );
  for (const r of rows)
    out.set(r.athlete_id, { athleteId: r.athlete_id, slug: r.slug, displayName: r.display_name });
  return out;
}

/**
 * AC-4 public governing recognition of a card: level, region, sport and fixed wording ONLY. The anchor
 * id, anchor fact hash, grants and the grant chain never leave the canonical fact.
 */
export function publicGoverningRecognition(
  c: Pick<
    CardRow,
    'governing_recognition_level' | 'governing_recognition_region' | 'governing_recognition_sport'
  >,
) {
  if (c.governing_recognition_level === null) return {};
  const scope = {
    ...(c.governing_recognition_region === null ? {} : { region: c.governing_recognition_region }),
    ...(c.governing_recognition_sport === null ? {} : { sport: c.governing_recognition_sport }),
  };
  return {
    governingRecognition: {
      level: c.governing_recognition_level,
      ...scope,
      statement: governingRecognitionStatement(
        c.governing_recognition_level as Parameters<typeof governingRecognitionStatement>[0],
        scope,
      ),
    },
  };
}

const CARD_SELECT = sql`
  SELECT c.*, cc.name AS competition_name, es.name AS event_name
  FROM achievement_read.achievement_card c
  JOIN competition_read.competition_card cc ON cc.competition_id = c.competition_id AND cc.status <> 'DRAFT'
  LEFT JOIN competition_read.event_summary es ON es.event_id = c.event_id
  WHERE c.provenance = 'CANONICAL_ASSEMBLY' AND (c.event_id IS NULL OR es.status <> 'DRAFT')`;

async function toPublic(
  ctx: TxContext,
  c: CardRow,
  assessedLive = false,
): Promise<PublicAchievementV1> {
  const refs = await athleteRefs(ctx, [
    ...(c.holder_type === 'ATHLETE' ? [c.holder_id] : []),
    ...c.member_athlete_ids,
  ]);
  let teamName: string | undefined;
  if (c.holder_type === 'TEAM') {
    const { rows } = await sql<{ team_name: string | null }>`
      SELECT team_name FROM competition_read.event_entry WHERE team_id = ${c.holder_id} AND team_name IS NOT NULL LIMIT 1`.execute(
      ctx.trx,
    );
    teamName = rows[0]?.team_name ?? undefined;
  }
  const qv = c.qualifying_value;
  return {
    schema: 'br:public-achievement@1',
    achievementId: c.achievement_id,
    type: c.achievement_type,
    typeLabel: ACHIEVEMENT_TYPE_LABEL[c.achievement_type],
    displayName: c.display_name,
    holder:
      c.holder_type === 'ATHLETE'
        ? { holderType: 'ATHLETE', athlete: refs.get(c.holder_id) ?? { privateEntrant: true } }
        : {
            holderType: 'TEAM',
            team: { teamId: c.holder_id, ...(teamName === undefined ? {} : { name: teamName }) },
          },
    ...(c.holder_type === 'TEAM'
      ? {
          memberCredits: c.member_athlete_ids.map((id) => ({
            creditType: 'TEAM_MEMBER' as const,
            creditRole: 'LINEUP_MEMBER' as const,
            athlete: refs.get(id) ?? { privateEntrant: true },
          })),
        }
      : {}),
    context: {
      ...(c.sport_code === null ? {} : { sport: c.sport_code }),
      ...(c.discipline_code === null ? {} : { discipline: c.discipline_code }),
      competition: { competitionId: c.competition_id, name: c.competition_name },
      ...(c.event_id === null
        ? {}
        : {
            event: {
              eventId: c.event_id,
              ...(c.event_name === null ? {} : { name: c.event_name }),
            },
          }),
      scopeType: c.scope_type,
    },
    ...(qv === null ? {} : { qualifyingValue: { ...qv, display: `${qv.value} ${qv.unit}` } }),
    verification: {
      levelAtDerivation: c.basis_level,
      label: VERIFICATION_LEVEL_LABEL[c.basis_level],
      statement: derivedFromStatement(c.basis_level),
      ...publicGoverningRecognition(c),
    },
    rule: { code: c.rule_code, version: c.rule_version, engineVersion: c.engine_version },
    currentSupport: {
      status: c.status,
      currentlySupported: c.status === 'ACTIVE',
      statement: currentSupportStatement(c.status),
      reasons: c.status_reasons.map((code) => ({ code, explanation: publicReason(code) })),
      since: c.status_since.toISOString(),
      ...(c.superseded_by === null ? {} : { supersededBy: c.superseded_by }),
      supersedes: c.supersedes,
      assessedLive,
    },
    derivedAt: c.recorded_at.toISOString(),
    notice: PUBLIC_ACHIEVEMENT_NOTICE,
  };
}

export interface PassportAchievementItem {
  readonly achievementId: string;
  readonly type: AchievementType;
  readonly typeLabel: string;
  readonly displayName: string;
  readonly creditType: 'HOLDER' | 'TEAM_MEMBER';
  readonly holderType: 'ATHLETE' | 'TEAM';
  readonly teamName?: string;
  readonly sport?: string;
  readonly discipline?: string;
  readonly competitionName: string;
  readonly eventName?: string;
  readonly qualifyingValue?: string;
  readonly verificationLevelAtDerivation: VerificationLevel;
  readonly derivedFrom: string;
  readonly currentSupport: AchievementStatus;
  readonly currentlySupported: boolean;
  readonly rule: { readonly code: string; readonly version: number };
  readonly derivedAt: string;
}

/** Passport section items for one athlete (read model only — no derivation here). */
export async function passportAchievements(
  ctx: TxContext,
  athleteId: string,
): Promise<PassportAchievementItem[]> {
  const { rows } = await sql<CardRow & { credit_type: 'HOLDER' | 'TEAM_MEMBER' }>`
    SELECT x.*, aa.credit_type FROM (${CARD_SELECT}) x
    JOIN achievement_read.athlete_achievement aa ON aa.achievement_id = x.achievement_id
    WHERE aa.athlete_id = ${athleteId}::uuid ORDER BY x.recorded_at DESC, x.achievement_id`.execute(
    ctx.trx,
  );
  const out: PassportAchievementItem[] = [];
  for (const r of rows) {
    const p = await toPublic(ctx, r);
    out.push({
      achievementId: r.achievement_id,
      type: r.achievement_type,
      typeLabel: p.typeLabel,
      displayName: r.display_name,
      creditType: r.credit_type,
      holderType: r.holder_type,
      ...(p.holder.holderType === 'TEAM' && p.holder.team.name !== undefined
        ? { teamName: p.holder.team.name }
        : {}),
      ...(p.context.sport === undefined ? {} : { sport: p.context.sport }),
      ...(p.context.discipline === undefined ? {} : { discipline: p.context.discipline }),
      competitionName: r.competition_name,
      ...(r.event_name === null ? {} : { eventName: r.event_name }),
      ...(p.qualifyingValue === undefined ? {} : { qualifyingValue: p.qualifyingValue.display }),
      verificationLevelAtDerivation: r.basis_level,
      derivedFrom: p.verification.statement,
      currentSupport: r.status,
      currentlySupported: r.status === 'ACTIVE',
      rule: { code: r.rule_code, version: r.rule_version },
      derivedAt: r.recorded_at.toISOString(),
    });
  }
  return out;
}

/**
 * Live current support for public / Passport presentation: a non-terminal CANONICAL Achievement is
 * re-assessed from live canonical facts (BRT-07 hash-based freshness of its pinned run) at read time,
 * so a pinned run that became STALE (e.g. after a key compromise) is never shown as currently
 * supported — even before the event-driven re-assessment is recorded. If current support cannot be
 * assessed now, it is presented as not currently supported (fail closed). Reads never write.
 */
export async function liveCurrentSupport(
  db: Db,
  achievementId: string,
  stored: {
    status: AchievementStatus;
    reasons: readonly string[];
    supersededBy?: string | undefined;
  },
): Promise<{
  status: AchievementStatus;
  reasons: readonly string[];
  supersededBy?: string;
  live: boolean;
}> {
  const kept = {
    status: stored.status,
    reasons: stored.reasons,
    ...(stored.supersededBy === undefined ? {} : { supersededBy: stored.supersededBy }),
    live: false,
  };
  if (stored.status === 'SUPERSEDED' || stored.status === 'REVOKED') return kept;
  try {
    const a = await liveSupport(db, achievementId, canonicalSupportSource);
    if (a === undefined) return kept;
    return {
      status: a.status,
      reasons: a.reasons,
      ...(a.supersededBy === undefined ? {} : { supersededBy: a.supersededBy }),
      live: true,
    };
  } catch {
    return { status: 'SUSPENDED', reasons: ['CURRENT_SUPPORT_UNASSESSABLE'], live: true };
  }
}

/** Applies live current support to Passport items (terminal items are kept as stored). */
export async function withLiveSupport<
  T extends {
    achievementId: string;
    currentSupport: AchievementStatus;
    currentlySupported: boolean;
  },
>(db: Db, items: readonly T[]): Promise<T[]> {
  const out: T[] = [];
  for (const x of items) {
    const live = await liveCurrentSupport(db, x.achievementId, {
      status: x.currentSupport,
      reasons: [],
    });
    out.push({ ...x, currentSupport: live.status, currentlySupported: live.status === 'ACTIVE' });
  }
  return out;
}

export class AchievementPublicReader {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Public Achievement detail (visible competitions / events; canonical rows only). */
  async achievement(achievementId: string): Promise<PublicAchievementV1 | undefined> {
    if (!UUID.test(achievementId)) return undefined;
    const card = await inTransaction(this.db, ModuleRole.publicRead, async (ctx) => {
      const { rows } =
        await sql<CardRow>`SELECT * FROM (${CARD_SELECT}) x WHERE x.achievement_id = ${achievementId}::uuid`.execute(
          ctx.trx,
        );
      return rows[0];
    });
    if (card === undefined) return undefined;
    const live = await liveCurrentSupport(this.db, achievementId, {
      status: card.status,
      reasons: card.status_reasons,
      supersededBy: card.superseded_by ?? undefined,
    });
    const effective: CardRow = {
      ...card,
      status: live.status,
      status_reasons: [...live.reasons],
      superseded_by: live.supersededBy ?? card.superseded_by,
    };
    return inTransaction(this.db, ModuleRole.publicRead, (ctx) =>
      toPublic(ctx, effective, live.live),
    );
  }

  /** Public, published AchievementRule versions (declarative specs are public-safe). */
  rule(code: string) {
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(code)) return Promise.resolve(undefined);
    return inTransaction(this.db, ModuleRole.achievements, async (ctx) => {
      const { rows } = await sql<{
        name: string;
        achievement_type: string;
        version: number;
        id: string;
        spec: unknown;
        spec_hash: string;
        status: string;
      }>`
        SELECT r.name, r.achievement_type, v.version, v.id, v.spec, v.spec_hash, c.status
        FROM achievement.rule r JOIN achievement.rule_version v ON v.rule_id = r.id
        JOIN achievement.v_rule_version_current c ON c.rule_version_id = v.id
        WHERE r.code = ${code} AND c.status <> 'DRAFT' ORDER BY v.version`.execute(ctx.trx);
      if (rows[0] === undefined) return undefined;
      return {
        schema: 'br:public-achievement-rule@1' as const,
        code,
        name: rows[0].name,
        achievementType: rows[0].achievement_type,
        notice:
          'An AchievementRule is a declarative, versioned derivation policy. A rule never awards anything by itself.',
        versions: rows.map((r) => ({
          ruleVersionId: r.id,
          version: r.version,
          status: r.status,
          specHash: r.spec_hash,
          spec: r.spec,
        })),
      };
    });
  }

  /** Why nothing was issued for a public result version (fixed wording; no private facts). */
  explainBlockers(reasons: readonly string[]) {
    return reasons.map((code) => ({ code, explanation: publicBlocker(code) }));
  }
}
