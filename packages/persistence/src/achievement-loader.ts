import {
  attachAnchorFact,
  governingRecognitionFromRun,
  metricOrders,
  sealDerivationSnapshot,
  type AchievementDerivationSnapshot,
  type AchievementRuleSpec,
  type GoverningRecognitionScope,
  type PinnedGoverningDecision,
  type SealedDerivationSnapshot,
  type SnapshotComparison,
  type SnapshotRecordMark,
  type SupportBasisFact,
  type VerificationSummary,
} from '@br/achievements';
import type { DisciplineVersionSpec } from '@br/competition';
import {
  DomainError,
  DomainErrorCode,
  PRODUCTION_SUPPORTED_DERIVATION_FACT_KINDS,
  type ResultVersionContent,
  type ResultVersionStatus,
  toCanonicalTimestamp,
} from '@br/domain';
import { DomainTag, SchemaRef } from '@br/schemas';
import { sql } from 'kysely';
import {
  resolveResultVersion,
  resultVersionPath,
  type ResolvedResultVersion,
  type ScopePath,
} from './evidence-support';
import { canonicalHash } from './hashing';
import { ModuleRole, withModuleRole, type TxContext } from './tx';
import { hashOutcome, hashTrace, type VerificationTrace } from '@br/verification';
import { currentVerificationFreshness } from './verification-store';
import { categoryFloor, type RecordCategorySpec } from '@br/records';

/**
 * BRT-08 canonical assembly (the CANONICAL PRODUCTION lane). Loads ONLY facts today's producers
 * create — ResultVersion content + hash (re-verified), lifecycle status from append-only
 * transitions, supersession, participants, contest occurrence, BRT-07 current verification with
 * hash-based freshness — and declares exactly those kinds as supported. It NEVER reads
 * `competition.lineup` as a credited lineup (ADR-0026), never infers a hold's absence, never defaults
 * a status, never manufactures a verification level. Runs in the derivation transaction
 * (br_achievements, REPEATABLE READ); freshness is computed under br_verification in the same
 * snapshot (withModuleRole, read-only use).
 */
export const ACHIEVEMENT_ASSEMBLER_VERSION = 'achievement-assembler/1';
const MAX_PB_COMPARISONS = 200;

export interface ApplicableRule {
  readonly ruleId: string;
  readonly ruleVersionId: string;
  readonly code: string;
  readonly version: number;
  readonly specHash: string;
  readonly spec: AchievementRuleSpec;
  readonly bindingId: string;
  readonly displayName: string;
}

/**
 * Rules applicable to a ResultVersion: per rule, the most specific binding scope (event >
 * competition > DisciplineVersion-wide) with a binding in force AT THE VERSION'S SUBMISSION TIME
 * (effective_from ≤ submittedAt, recorded ≤ submittedAt — no retroactive derivation); the latest such
 * binding wins, and its version must still be PUBLISHED (not RETIRED) now. No fallback.
 */
export async function applicableRules(
  ctx: TxContext,
  input: {
    disciplineVersionId: string;
    competitionId?: string | undefined;
    eventId?: string | undefined;
    submittedAt: Date;
  },
): Promise<ApplicableRule[]> {
  const { rows } = await sql<{
    rule_id: string;
    code: string;
    binding_id: string;
    rule_version_id: string;
    version: number;
    spec: AchievementRuleSpec;
    spec_hash: string;
    status: string;
    specificity: number;
  }>`
    SELECT DISTINCT ON (b.rule_id) b.rule_id, r.code, b.id AS binding_id, v.id AS rule_version_id, v.version, v.spec,
           v.spec_hash, c.status,
           (CASE WHEN b.event_id IS NOT NULL THEN 2 WHEN b.competition_id IS NOT NULL THEN 1 ELSE 0 END) AS specificity
    FROM achievement.rule_binding b
    JOIN achievement.rule r ON r.id = b.rule_id
    JOIN achievement.rule_version v ON v.id = b.rule_version_id
    JOIN achievement.v_rule_version_current c ON c.rule_version_id = v.id
    WHERE b.discipline_version_id = ${input.disciplineVersionId}
      AND (b.competition_id IS NULL OR b.competition_id = ${input.competitionId ?? null}::uuid)
      AND (b.event_id IS NULL OR b.event_id = ${input.eventId ?? null}::uuid)
      AND b.effective_from <= ${input.submittedAt} AND b.recorded_at <= ${input.submittedAt}
    ORDER BY b.rule_id, specificity DESC, b.effective_from DESC, b.seq DESC`.execute(ctx.trx);
  return rows
    .filter((r) => r.status === 'PUBLISHED')
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map((r) => ({
      ruleId: r.rule_id,
      ruleVersionId: r.rule_version_id,
      code: r.code,
      version: r.version,
      specHash: r.spec_hash,
      spec: r.spec,
      bindingId: r.binding_id,
      displayName: r.spec.displayName,
    }));
}

/** BRT-07 current verification (freshness CURRENT / STALE / …) of an exact version, as a summary. */
export async function verificationSummary(
  ctx: TxContext,
  resultVersionId: string,
): Promise<VerificationSummary> {
  // Read-only: br_verification_reader holds SELECT only (it can never write a run, trace or policy).
  return withModuleRole(ctx, ModuleRole.verificationReader, async (vctx) => {
    const f = await currentVerificationFreshness(vctx, resultVersionId);
    if (!f.resolution.ok) return { state: 'POLICY_UNAVAILABLE' };
    if (f.latest === undefined || f.freshness === 'NOT_EVALUATED')
      return { state: 'NOT_EVALUATED' };
    const l = f.latest;
    // governingAuthority (BRT-01 §8.1 / AC-4) is derived from the run's IMMUTABLE, hash-bound
    // documents only — never from today's authority state. The stored trace must re-hash.
    const { rows } = await sql<{ trace: VerificationTrace; trace_hash: string }>`
      SELECT t.trace, r.trace_hash FROM verification.run_trace t JOIN verification.run r ON r.id = t.run_id
      WHERE t.run_id = ${l.id}`.execute(vctx.trx);
    const t = rows[0];
    if (
      t === undefined ||
      hashTrace(t.trace) !== t.trace_hash ||
      hashOutcome(l.outcome) !== l.outcome_hash
    )
      throw integrity(
        'RUN_HASH_MISMATCH',
        'stored verification run documents do not match their hashes',
      );
    const decision = governingRecognitionFromRun({
      satisfiedLevels: l.outcome.satisfiedLevels ?? [],
      criteria: t.trace.criteria,
    });
    const governing =
      decision === undefined ? undefined : await pinnedGoverningAnchorFact(vctx, decision);
    return {
      state: f.freshness,
      runId: l.id,
      policyVersionId: l.policy_version_id,
      snapshotHash: l.snapshot_hash,
      outcomeHash: l.outcome_hash,
      ...(l.highest_level === null ? {} : { level: l.highest_level }),
      evidenceBundleHash: l.evidence_bundle_hash,
      evaluatedAsOf: l.evaluated_as_of.toISOString(),
      ...(governing === undefined ? {} : { governingRecognition: governing }),
    };
  });
}

/**
 * AC-4 region / sport scope of the governing decision. The pinned trace names the anchor
 * (`anchorId`, `anchorLevels`) but not its region or sport; those live in the anchor's IMMUTABLE
 * BRT-03 fact (class A `authority.trust_anchor`: `recognition_scope` + `fact_hash`). The fact is
 * re-hashed here, and its levels must equal those the trace recorded. Anchor STATUS (revocation /
 * suspension, a separate table) and grants are deliberately never read: the Achievement pins the
 * scope the run was decided under, not today's authority state.
 */
export async function pinnedGoverningAnchorFact(ctx: TxContext, decision: PinnedGoverningDecision) {
  const { rows } = await sql<{
    principal_id: string;
    recognition_scope: GoverningRecognitionScope;
    basis_ref: string;
    governance_decision_ref: string;
    effective_from: Date;
    effective_to: Date | null;
    fact_hash: string;
  }>`SELECT principal_id, recognition_scope, basis_ref, governance_decision_ref, effective_from,
            effective_to, fact_hash
     FROM authority.trust_anchor WHERE id = ${decision.anchorId}`.execute(ctx.trx);
  const a = rows[0];
  if (a === undefined)
    throw integrity('ANCHOR_FACT_MISSING', 'the pinned governing anchor fact does not exist');
  const hashed = canonicalHash(DomainTag.trustAnchor, SchemaRef.trustAnchor, {
    principalId: a.principal_id,
    recognitionScope: a.recognition_scope,
    basisRef: a.basis_ref,
    governanceDecisionRef: a.governance_decision_ref,
    effectiveFrom: toCanonicalTimestamp(a.effective_from),
    ...(a.effective_to === null ? {} : { effectiveTo: toCanonicalTimestamp(a.effective_to) }),
  });
  if (hashed.contentHash !== a.fact_hash)
    throw integrity(
      'ANCHOR_FACT_HASH_MISMATCH',
      'the governing anchor fact does not match its hash',
    );
  const scope = (hashed.normalized as unknown as { recognitionScope: GoverningRecognitionScope })
    .recognitionScope;
  const g = attachAnchorFact(decision, { factHash: a.fact_hash, recognitionScope: scope });
  if (g === undefined)
    throw integrity(
      'ANCHOR_FACT_MISMATCH',
      'the governing anchor fact disagrees with the pinned verification trace',
    );
  return g;
}

export interface VersionFacts {
  readonly rv: ResolvedResultVersion;
  readonly path: ScopePath;
  readonly content: ResultVersionContent;
  readonly submittedAt: Date;
  readonly status: Exclude<ResultVersionStatus, 'DRAFT'>;
  readonly supersedesVersionId?: string;
  readonly supersededByVersionId?: string;
  readonly disciplineVersionId: string;
}

const integrity = (reason: string, message: string) =>
  new DomainError(DomainErrorCode.ACHIEVEMENT_INTEGRITY_FAILURE, message, { reason });

/** Lifecycle status as of now, from append-only transitions (never from a projection). */
export async function currentStatus(
  ctx: TxContext,
  resultVersionId: string,
): Promise<Exclude<ResultVersionStatus, 'DRAFT'>> {
  const { rows } = await sql<{ to_status: Exclude<ResultVersionStatus, 'DRAFT'> }>`
    SELECT to_status FROM results.result_status_transition WHERE result_version_id = ${resultVersionId}
    ORDER BY recorded_at DESC, id DESC LIMIT 1`.execute(ctx.trx);
  return rows[0]?.to_status ?? 'SUBMITTED';
}

export async function supersedingVersion(
  ctx: TxContext,
  resultVersionId: string,
): Promise<string | undefined> {
  const { rows } = await sql<{ id: string }>`
    SELECT id FROM results.result_version WHERE supersedes_version_id = ${resultVersionId}
    ORDER BY recorded_at, id LIMIT 1`.execute(ctx.trx);
  return rows[0]?.id;
}

export async function loadVersionFacts(
  ctx: TxContext,
  resultVersionId: string,
): Promise<VersionFacts | undefined> {
  const rv = await resolveResultVersion(ctx, resultVersionId);
  if (rv === undefined) return undefined;
  const path = await resultVersionPath(ctx, rv);
  if (path?.competitionId === undefined || path.eventId === undefined) return undefined;
  const { rows } = await sql<{
    content: ResultVersionContent;
    content_hash: string;
    recorded_at: Date;
    supersedes_version_id: string | null;
    discipline_version_id: string;
  }>`
    SELECT v.content, v.content_hash, v.recorded_at, v.supersedes_version_id, e.discipline_version_id
    FROM results.result_version v, competition.event e
    WHERE v.id = ${resultVersionId} AND e.id = ${path.eventId}`.execute(ctx.trx);
  const r = rows[0];
  if (r === undefined) return undefined;
  // Integrity: the stored content must re-hash to its content hash (never trusted blindly).
  const rehash = canonicalHash(
    DomainTag.resultVersionContent,
    SchemaRef.resultVersionContent,
    r.content,
  );
  if (rehash.contentHash !== r.content_hash)
    throw integrity(
      'CONTENT_HASH_MISMATCH',
      'stored ResultVersion content does not match its hash',
    );
  const superseded = await supersedingVersion(ctx, resultVersionId);
  return {
    rv,
    path,
    content: rehash.normalized as unknown as ResultVersionContent,
    submittedAt: r.recorded_at,
    status: await currentStatus(ctx, resultVersionId),
    ...(r.supersedes_version_id === null ? {} : { supersedesVersionId: r.supersedes_version_id }),
    ...(superseded === undefined ? {} : { supersededByVersionId: superseded }),
    disciplineVersionId: r.discipline_version_id,
  };
}

export async function contestStartedAt(ctx: TxContext, contestId: string | undefined) {
  if (contestId === undefined) return undefined;
  const { rows } = await sql<{ t: Date | null }>`
    SELECT min(recorded_at) AS t FROM competition.contest_status_change
    WHERE contest_id = ${contestId} AND status = 'IN_PROGRESS'`.execute(ctx.trx);
  return rows[0]?.t ?? undefined;
}

/** PB comparison set: the athlete's other non-superseded contest versions in the same DisciplineVersion. */
async function loadComparisons(
  ctx: TxContext,
  facts: VersionFacts,
  athleteIds: readonly string[],
  markMetricId: string,
): Promise<SnapshotComparison[]> {
  if (athleteIds.length === 0) return [];
  const { rows } = await sql<{
    result_version_id: string;
    content: ResultVersionContent;
    content_hash: string;
    participant_id: string;
    athlete_id: string;
    contest_id: string;
  }>`
    SELECT v.id AS result_version_id, v.content, v.content_hash, p.id AS participant_id, p.athlete_id, ct.id AS contest_id
    FROM competition.participant p
    JOIN competition.event e ON e.id = p.event_id
    JOIN competition.contest ct ON ct.event_id = e.id
    JOIN results.result r ON r.scope_type = 'CONTEST' AND r.scope_target_id = ct.id
    JOIN results.result_version v ON v.result_id = r.id
    WHERE p.athlete_id = ANY(${athleteIds}::uuid[]) AND e.discipline_version_id = ${facts.disciplineVersionId}
      AND v.id <> ${facts.rv.resultVersionId}
      AND NOT EXISTS (SELECT 1 FROM results.result_version s WHERE s.supersedes_version_id = v.id)
      AND v.content @> jsonb_build_object('performances', jsonb_build_array(jsonb_build_object('participantId', p.id::text)))
    ORDER BY v.id, p.id LIMIT ${MAX_PB_COMPARISONS}`.execute(ctx.trx);
  const out: SnapshotComparison[] = [];
  for (const row of rows) {
    const started = await contestStartedAt(ctx, row.contest_id);
    const status = await currentStatus(ctx, row.result_version_id);
    const verification = await verificationSummary(ctx, row.result_version_id);
    for (const perf of row.content.performances ?? []) {
      if (perf.participantId !== row.participant_id || perf.mark.metricId !== markMetricId)
        continue;
      if (perf.athleteId !== undefined && perf.athleteId !== row.athlete_id) continue;
      out.push({
        resultVersionId: row.result_version_id,
        contentHash: row.content_hash,
        disciplineVersionId: facts.disciplineVersionId,
        participantId: perf.participantId,
        athleteId: row.athlete_id,
        ordinal: perf.ordinal,
        mark: perf.mark,
        valid: perf.valid ?? true,
        ...(started === undefined ? {} : { occurredAt: started.toISOString() }),
        status,
        verification,
      });
    }
  }
  return out;
}

/**
 * Assembles the canonical AchievementDerivationSnapshot for one (version, rule). Everything the
 * snapshot says is a fact loaded here; kinds without a producer are simply not declared.
 */
/** The snapshot `discipline` member of an exact DisciplineVersion (catalog facts, re-read). */
export async function disciplineFacts(
  ctx: TxContext,
  disciplineVersionId: string,
): Promise<AchievementDerivationSnapshot['discipline']> {
  const { rows: dv } = await sql<{
    spec: DisciplineVersionSpec;
    sport: string;
    discipline: string;
  }>`
    SELECT dv.spec, s.code AS sport, d.code AS discipline FROM sports.discipline_version dv
    JOIN sports.discipline d ON d.id = dv.discipline_id JOIN sports.sport s ON s.id = d.sport_id
    WHERE dv.id = ${disciplineVersionId}`.execute(ctx.trx);
  const d = dv[0];
  if (d === undefined)
    throw integrity('DISCIPLINE_VERSION_MISSING', 'event discipline version missing');
  const orders = metricOrders(d.spec);
  return {
    disciplineVersionId,
    sport: d.sport,
    discipline: d.discipline,
    metrics: d.spec.metrics.map((m) => {
      const order = orders.get(m.key);
      return {
        key: m.key,
        valueType: m.valueType,
        unit: m.unit,
        ...(order === undefined ? {} : { order }),
      };
    }),
  };
}

export async function assembleCanonicalSnapshot(
  ctx: TxContext,
  facts: VersionFacts,
  rule: ApplicableRule,
  verification: VerificationSummary,
  record?: SnapshotRecordMark,
): Promise<SealedDerivationSnapshot> {
  const discipline = await disciplineFacts(ctx, facts.disciplineVersionId);
  const participantIds = [
    ...new Set([
      ...facts.content.entries.map((e) => e.participantId),
      ...(facts.content.performances ?? []).map((p) => p.participantId),
    ]),
  ].sort();
  const { rows: parts } = await sql<{
    id: string;
    participant_kind: 'INDIVIDUAL' | 'TEAM';
    athlete_id: string | null;
    team_id: string | null;
  }>`
    SELECT id, participant_kind, athlete_id, team_id FROM competition.participant
    WHERE id = ANY(${participantIds}::uuid[]) AND event_id = ${facts.path.eventId ?? null}::uuid`.execute(
    ctx.trx,
  );
  const c = rule.spec.criterion;
  const pb = c.kind === 'PERSONAL_BEST' && c.metric !== undefined;
  const started = await contestStartedAt(ctx, facts.path.contestId);
  const comparisons = pb
    ? await loadComparisons(
        ctx,
        facts,
        parts.flatMap((p) => (p.athlete_id === null ? [] : [p.athlete_id])),
        c.metric?.markMetricId ?? '',
      )
    : [];
  const snapshot: AchievementDerivationSnapshot = {
    provenance: 'CANONICAL_ASSEMBLY',
    assembler: ACHIEVEMENT_ASSEMBLER_VERSION,
    rule: {
      ruleId: rule.ruleId,
      ruleVersionId: rule.ruleVersionId,
      code: rule.code,
      version: rule.version,
      specHash: rule.specHash,
      spec: rule.spec,
      bindingId: rule.bindingId,
    },
    supportedFactKinds: PRODUCTION_SUPPORTED_DERIVATION_FACT_KINDS,
    discipline,
    hierarchy: {
      competitionId: facts.path.competitionId as string,
      ...(facts.path.eventId === undefined ? {} : { eventId: facts.path.eventId }),
      ...(facts.path.roundId === undefined ? {} : { roundId: facts.path.roundId }),
      ...(facts.path.contestId === undefined ? {} : { contestId: facts.path.contestId }),
    },
    resultVersion: {
      resultVersionId: facts.rv.resultVersionId,
      resultId: facts.rv.resultId,
      versionNumber: facts.rv.versionNumber,
      contentHash: facts.rv.contentHash,
      scopeType: facts.rv.scopeType,
      scopeTargetId: facts.rv.scopeTargetId,
      submittedAt: facts.submittedAt.toISOString(),
      status: facts.status,
      ...(facts.supersedesVersionId === undefined
        ? {}
        : { supersedesVersionId: facts.supersedesVersionId }),
      ...(facts.supersededByVersionId === undefined
        ? {}
        : { supersededByVersionId: facts.supersededByVersionId }),
    },
    verification,
    entries: facts.content.entries.map((e) => ({
      participantId: e.participantId,
      outcome: e.outcome,
      ...(e.rank === undefined ? {} : { rank: e.rank }),
    })),
    performances: (facts.content.performances ?? []).map((p) => ({
      participantId: p.participantId,
      ...(p.athleteId === undefined ? {} : { athleteId: p.athleteId }),
      ordinal: p.ordinal,
      mark: p.mark,
      valid: p.valid ?? true,
    })),
    participants: parts.map((p) => ({
      participantId: p.id,
      kind: p.participant_kind,
      ...(p.athlete_id === null ? {} : { athleteId: p.athlete_id }),
      ...(p.team_id === null ? {} : { teamId: p.team_id }),
    })),
    ...(started === undefined ? {} : { occurrence: { startedAt: started.toISOString() } }),
    ...(comparisons.length === 0 ? {} : { comparisons }),
    // BRT-09 RECORD_SET: the exact RecordMark facts. RECORD_RATIFICATION is NOT a supported kind in
    // production (no canonical RECORD_RATIFIED / REVIEW_COMPLETED producer): the gate fails closed.
    ...(record === undefined ? {} : { record }),
  };
  return sealDerivationSnapshot(snapshot);
}

/**
 * BRT-09: the RecordMarks of one ResultVersion that were validly ratified (a ratification entry by
 * authority exists; latest status RATIFIED / CANONICAL / SUPERSEDED — never PENDING, never RESCINDED),
 * as RECORD_SET snapshot facts, with the ratification instant (RECORD_SET rule applicability time).
 */
export async function ratifiedRecordMarks(
  ctx: TxContext,
  resultVersionId: string,
  provenance: 'CANONICAL_ASSEMBLY' | 'REFERENCE_FIXTURE' = 'CANONICAL_ASSEMBLY',
): Promise<(SnapshotRecordMark & { readonly ratifiedAt: Date })[]> {
  const { rows } = await sql<{
    id: string;
    mark_hash: string;
    category_id: string;
    category_version_id: string;
    category_spec_hash: string;
    scope_type: SnapshotRecordMark['scopeType'];
    holder_type: 'ATHLETE' | 'TEAM';
    holder_id: string;
    participant_id: string;
    performance_ordinal: number;
    value: SnapshotRecordMark['value'];
    spec: RecordCategorySpec;
    rat_id: string;
    rat_status: 'RATIFIED' | 'CANONICAL';
    rat_hash: string;
    rat_at: Date;
    latest: SnapshotRecordMark['currentStatus'];
  }>`
    SELECT m.id, m.mark_hash, m.category_id, m.category_version_id, m.category_spec_hash, m.scope_type,
           m.holder_type, m.holder_id, m.participant_id, m.performance_ordinal, m.value, v.spec,
           r.id AS rat_id, r.status AS rat_status, r.ratification_hash AS rat_hash, r.recorded_at AS rat_at,
           (SELECT s.status FROM record.mark_status_entry s WHERE s.record_mark_id = m.id ORDER BY s.seq DESC LIMIT 1) AS latest
    FROM record.record_mark m
    JOIN record.category_version v ON v.id = m.category_version_id
    JOIN record.mark_status_entry r ON r.record_mark_id = m.id AND r.ratification_ref IS NOT NULL
    WHERE m.result_version_id = ${resultVersionId} AND m.provenance = ${provenance}
    ORDER BY m.id`.execute(ctx.trx);
  return rows.map((r) => ({
    recordMarkId: r.id,
    markHash: r.mark_hash,
    categoryId: r.category_id,
    categoryVersionId: r.category_version_id,
    categoryVersionHash: r.category_spec_hash,
    scopeType: r.scope_type,
    standing: r.rat_status,
    ratificationEntryId: r.rat_id,
    ratificationHash: r.rat_hash,
    recognitionLevel: r.spec.recognition.level,
    currentStatus: r.latest,
    requiredLevel: categoryFloor(r.spec),
    holder: { holderType: r.holder_type, holderId: r.holder_id },
    participantId: r.participant_id,
    performanceOrdinal: r.performance_ordinal,
    value: r.value,
    ratifiedAt: r.rat_at,
  }));
}

/** Canonical current state of one basis item (for current-support assessment). */
export async function canonicalBasisFact(
  ctx: TxContext,
  item: { resultVersionId: string; pinnedRunId: string },
): Promise<SupportBasisFact> {
  const superseded = await supersedingVersion(ctx, item.resultVersionId);
  return {
    resultVersionId: item.resultVersionId,
    pinnedRunId: item.pinnedRunId,
    status: await currentStatus(ctx, item.resultVersionId),
    ...(superseded === undefined ? {} : { supersededByVersionId: superseded }),
    verification: await verificationSummary(ctx, item.resultVersionId),
  };
}
