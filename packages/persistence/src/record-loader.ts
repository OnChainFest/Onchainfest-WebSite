import { metricOrders, type VerificationSummary } from '@br/achievements';
import type { DisciplineVersionSpec } from '@br/competition';
import {
  DomainError,
  DomainErrorCode,
  PRODUCTION_SUPPORTED_RECORD_FACT_KINDS,
  type Mark,
  type RecordStanding,
  type TiePolicy,
} from '@br/domain';
import {
  replayRecordHistory,
  sealRecordSnapshot,
  type RecordCategorySpec,
  type RecordEvaluationSnapshot,
  type ReplayInput,
  type SealedRecordSnapshot,
  type StandingMark,
} from '@br/records';
import { sql } from 'kysely';
import { contestStartedAt, type VersionFacts } from './achievement-loader';
import type { TxContext } from './tx';

/**
 * BRT-09 canonical record assembly (the CANONICAL PRODUCTION lane). Loads ONLY facts today's
 * producers create — ResultVersion content + hash (re-verified by the achievement loader), lifecycle
 * status, supersession, participants, contest occurrence, the immutable competition path, BRT-07
 * current verification with hash-based freshness (under the SELECT-only br_verification_reader) — and
 * declares exactly those kinds as supported. It NEVER infers a hold's absence, a population fact
 * ("no handicap data" is not SCRATCH), a condition, a venue / league membership (the contest schedule
 * venue is operational, not canonical), regional eligibility (private identity data is never read) or
 * a ratification (the RECORD_RATIFIED / REVIEW_COMPLETED producer is deferred to BRT-06R).
 */
export const RECORD_ASSEMBLER_VERSION = 'record-assembler/1';
const integrity = (reason: string, message: string) =>
  new DomainError(DomainErrorCode.RECORD_INTEGRITY_FAILURE, message, { reason });

export interface CategoryVersionRow {
  readonly categoryId: string;
  readonly code: string;
  readonly categoryVersionId: string;
  readonly version: number;
  readonly spec: RecordCategorySpec;
  readonly specHash: string;
  readonly lifecycle: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
}

/**
 * Category versions applicable to a performance of an exact DisciplineVersion + metric at its
 * sporting time: per category, the highest-numbered version that is PUBLISHED now (never RETIRED /
 * DRAFT) with effective_from ≤ the performance time. No retroactive binding, no fallback.
 */
export async function applicableCategoryVersions(
  ctx: TxContext,
  input: { disciplineVersionId: string; markMetricIds: readonly string[]; occurredAt: Date },
): Promise<CategoryVersionRow[]> {
  if (input.markMetricIds.length === 0) return [];
  const { rows } = await sql<{
    category_id: string;
    code: string;
    category_version_id: string;
    version: number;
    spec: RecordCategorySpec;
    spec_hash: string;
  }>`
    SELECT DISTINCT ON (v.category_id) v.category_id, c.code, v.id AS category_version_id, v.version, v.spec, v.spec_hash
    FROM record.category_version v
    JOIN record.category c ON c.id = v.category_id
    JOIN record.v_category_version_current s ON s.category_version_id = v.id
    WHERE v.discipline_version_id = ${input.disciplineVersionId}
      AND v.mark_metric_id = ANY(${[...input.markMetricIds]}::text[])
      AND s.status = 'PUBLISHED' AND v.effective_from <= ${input.occurredAt}
    ORDER BY v.category_id, v.version DESC`.execute(ctx.trx);
  return rows
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map((r) => ({
      categoryId: r.category_id,
      code: r.code,
      categoryVersionId: r.category_version_id,
      version: r.version,
      spec: r.spec,
      specHash: r.spec_hash,
      lifecycle: 'PUBLISHED',
    }));
}

export async function loadCategoryVersion(
  ctx: TxContext,
  categoryVersionId: string,
): Promise<CategoryVersionRow | undefined> {
  const { rows } = await sql<{
    category_id: string;
    code: string;
    version: number;
    spec: RecordCategorySpec;
    spec_hash: string;
    status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  }>`
    SELECT v.category_id, c.code, v.version, v.spec, v.spec_hash, s.status FROM record.category_version v
    JOIN record.category c ON c.id = v.category_id
    JOIN record.v_category_version_current s ON s.category_version_id = v.id
    WHERE v.id = ${categoryVersionId}`.execute(ctx.trx);
  const r = rows[0];
  if (r === undefined) return undefined;
  return {
    categoryId: r.category_id,
    code: r.code,
    categoryVersionId,
    version: r.version,
    spec: r.spec,
    specHash: r.spec_hash,
    lifecycle: r.status,
  };
}

/** One mark of a category with the facts replay needs (from append-only status history). */
export interface CategoryMarkFacts {
  readonly recordMarkId: string;
  readonly markHash: string;
  readonly holderType: 'ATHLETE' | 'TEAM';
  readonly holderId: string;
  readonly value: Mark;
  readonly effectiveFrom: Date;
  readonly provenance: 'CANONICAL_ASSEMBLY' | 'REFERENCE_FIXTURE';
  readonly latestStatus: string;
  readonly latestReasons: readonly string[];
  readonly latestEffectiveTo?: Date;
  readonly latestSupersededBy?: string;
  /** The ratification-by-authority entry (never a restoration). */
  readonly ratification?: {
    readonly entryId: string;
    readonly seq: number;
    readonly standing: RecordStanding;
    readonly hash: string;
    readonly recordedAt: Date;
  };
  /** Replaced by a ratified corrected mark (supersession kind CORRECTION). */
  readonly replacedByCorrection: boolean;
}

export const MAX_CATEGORY_MARKS = 10_000;

export async function categoryMarks(
  ctx: TxContext,
  categoryId: string,
): Promise<CategoryMarkFacts[]> {
  const { rows } = await sql<{
    id: string;
    mark_hash: string;
    holder_type: 'ATHLETE' | 'TEAM';
    holder_id: string;
    value: Mark;
    effective_from: Date;
    provenance: 'CANONICAL_ASSEMBLY' | 'REFERENCE_FIXTURE';
    latest_status: string;
    latest_reasons: string[];
    latest_effective_to: Date | null;
    latest_superseded_by: string | null;
    rat_id: string | null;
    rat_seq: number | null;
    rat_status: RecordStanding | null;
    rat_hash: string | null;
    rat_at: Date | null;
    replaced: boolean;
  }>`
    SELECT m.id, m.mark_hash, m.holder_type, m.holder_id, m.value, m.effective_from, m.provenance,
           l.status AS latest_status, l.reasons AS latest_reasons, l.effective_to AS latest_effective_to,
           l.superseded_by_mark_id AS latest_superseded_by,
           r.id AS rat_id, r.seq AS rat_seq, r.status AS rat_status, r.ratification_hash AS rat_hash, r.recorded_at AS rat_at,
           EXISTS (SELECT 1 FROM record.mark_supersession x
                   JOIN record.mark_status_entry xr ON xr.record_mark_id = x.superseding_mark_id AND xr.ratification_ref IS NOT NULL
                   WHERE x.superseded_mark_id = m.id AND x.kind = 'CORRECTION'
                     AND (SELECT s2.status FROM record.mark_status_entry s2 WHERE s2.record_mark_id = x.superseding_mark_id
                          ORDER BY s2.seq DESC LIMIT 1) <> 'RESCINDED') AS replaced
    FROM record.record_mark m
    JOIN LATERAL (SELECT * FROM record.mark_status_entry s WHERE s.record_mark_id = m.id ORDER BY s.seq DESC LIMIT 1) l ON true
    LEFT JOIN record.mark_status_entry r ON r.record_mark_id = m.id AND r.ratification_ref IS NOT NULL
    WHERE m.category_id = ${categoryId}
    ORDER BY m.effective_from, m.id LIMIT ${MAX_CATEGORY_MARKS + 1}`.execute(ctx.trx);
  if (rows.length > MAX_CATEGORY_MARKS)
    throw integrity('CATEGORY_HISTORY_TOO_LARGE', 'category history exceeds the replay bound');
  return rows.map((r) => ({
    recordMarkId: r.id,
    markHash: r.mark_hash,
    holderType: r.holder_type,
    holderId: r.holder_id,
    value: r.value,
    effectiveFrom: r.effective_from,
    provenance: r.provenance,
    latestStatus: r.latest_status,
    latestReasons: r.latest_reasons,
    ...(r.latest_effective_to === null ? {} : { latestEffectiveTo: r.latest_effective_to }),
    ...(r.latest_superseded_by === null ? {} : { latestSupersededBy: r.latest_superseded_by }),
    ...(r.rat_id === null ||
    r.rat_seq === null ||
    r.rat_status === null ||
    r.rat_hash === null ||
    r.rat_at === null
      ? {}
      : {
          ratification: {
            entryId: r.rat_id,
            seq: Number(r.rat_seq),
            standing: r.rat_status,
            hash: r.rat_hash,
            recordedAt: r.rat_at,
          },
        }),
    replacedByCorrection: r.replaced,
  }));
}

/** A mark takes part in replay iff validly ratified, not RESCINDED and not replaced by a correction. */
export function replayValid(m: CategoryMarkFacts): boolean {
  return m.ratification !== undefined && m.latestStatus !== 'RESCINDED' && !m.replacedByCorrection;
}

export function replayInputOf(
  categoryId: string,
  tiePolicy: TiePolicy,
  comparator: 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER',
  marks: readonly CategoryMarkFacts[],
  filter: (m: CategoryMarkFacts) => boolean = () => true,
): ReplayInput {
  return {
    categoryId,
    tiePolicy,
    comparator,
    marks: marks
      .filter((m) => m.ratification !== undefined && filter(m))
      .map((m) => ({
        recordMarkId: m.recordMarkId,
        value: m.value,
        effectiveFrom: m.effectiveFrom.toISOString(),
        ratifiedSeq: m.ratification?.seq ?? 0,
        standing: m.ratification?.standing ?? 'RATIFIED',
        valid: replayValid(m),
      })),
  };
}

/**
 * The record standing at a sporting instant: a replay over the valid marks whose effectiveFrom is at
 * or before it (excluding the mark being ratified). RC-2: pending marks never stand.
 */
export function standingAt(
  categoryId: string,
  spec: RecordCategorySpec,
  comparator: 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER',
  marks: readonly CategoryMarkFacts[],
  at: Date,
  excludeMarkId?: string,
): StandingMark[] {
  const input = replayInputOf(
    categoryId,
    spec.tiePolicy,
    comparator,
    marks,
    (m) => m.recordMarkId !== excludeMarkId && m.effectiveFrom.getTime() <= at.getTime(),
  );
  const r = replayRecordHistory(input);
  const byId = new Map(marks.map((m) => [m.recordMarkId, m]));
  return r.current.map((id) => {
    const m = byId.get(id) as CategoryMarkFacts;
    return {
      recordMarkId: m.recordMarkId,
      markHash: m.markHash,
      holder: { holderType: m.holderType, holderId: m.holderId },
      value: m.value,
      effectiveFrom: m.effectiveFrom.toISOString(),
      standing: m.ratification?.standing ?? 'RATIFIED',
    };
  });
}

export async function disciplineFacts(ctx: TxContext, disciplineVersionId: string) {
  const { rows } = await sql<{ spec: DisciplineVersionSpec; sport: string; discipline: string }>`
    SELECT dv.spec, s.code AS sport, d.code AS discipline FROM sports.discipline_version dv
    JOIN sports.discipline d ON d.id = dv.discipline_id JOIN sports.sport s ON s.id = d.sport_id
    WHERE dv.id = ${disciplineVersionId}`.execute(ctx.trx);
  const d = rows[0];
  if (d === undefined)
    throw integrity('DISCIPLINE_VERSION_MISSING', 'event discipline version missing');
  const orders = metricOrders(d.spec);
  return {
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

export interface PerformanceRef {
  readonly participantId: string;
  readonly ordinal: number;
}

/**
 * Assembles the canonical RecordEvaluationSnapshot for one (performance, category version). Every
 * member is a fact loaded here; kinds without a producer are simply not declared.
 */
export async function assembleRecordSnapshot(
  ctx: TxContext,
  input: {
    readonly facts: VersionFacts;
    readonly perf: PerformanceRef;
    readonly category: CategoryVersionRow;
    readonly verification: VerificationSummary;
    readonly pendingMark?: RecordEvaluationSnapshot['pendingMark'];
  },
): Promise<SealedRecordSnapshot | undefined> {
  const { facts, category } = input;
  const performance = (facts.content.performances ?? []).find(
    (p) => p.participantId === input.perf.participantId && p.ordinal === input.perf.ordinal,
  );
  if (performance === undefined) return undefined;
  const { rows: parts } = await sql<{
    participant_kind: 'INDIVIDUAL' | 'TEAM';
    athlete_id: string | null;
    team_id: string | null;
  }>`
    SELECT participant_kind, athlete_id, team_id FROM competition.participant
    WHERE id = ${performance.participantId} AND event_id = ${facts.path.eventId ?? null}::uuid`.execute(
    ctx.trx,
  );
  const part = parts[0];
  if (part === undefined) throw integrity('PARTICIPANT_UNKNOWN', 'performance participant unknown');
  const d = await disciplineFacts(ctx, facts.disciplineVersionId);
  const started = await contestStartedAt(ctx, facts.path.contestId);
  const metric = d.metrics.find((m) => m.key === category.spec.universe.metric.key);
  const comparator =
    metric?.order === 'HIGHER_IS_BETTER' || metric?.order === 'LOWER_IS_BETTER'
      ? metric.order
      : 'HIGHER_IS_BETTER';
  const marks = await categoryMarks(ctx, category.categoryId);
  const currentMarks =
    started === undefined
      ? []
      : standingAt(
          category.categoryId,
          category.spec,
          comparator,
          marks.filter((m) => m.provenance === 'CANONICAL_ASSEMBLY'),
          started,
          input.pendingMark?.recordMarkId,
        );
  const snapshot: RecordEvaluationSnapshot = {
    provenance: 'CANONICAL_ASSEMBLY',
    assembler: RECORD_ASSEMBLER_VERSION,
    supportedFactKinds: PRODUCTION_SUPPORTED_RECORD_FACT_KINDS,
    category: {
      categoryId: category.categoryId,
      code: category.code,
      categoryVersionId: category.categoryVersionId,
      version: category.version,
      specHash: category.specHash,
      spec: category.spec,
      lifecycle: category.lifecycle,
    },
    discipline: {
      disciplineVersionId: facts.disciplineVersionId,
      sport: d.sport,
      discipline: d.discipline,
      metrics: d.metrics,
    },
    performance: {
      resultVersionId: facts.rv.resultVersionId,
      resultId: facts.rv.resultId,
      contentHash: facts.rv.contentHash,
      scopeType: facts.rv.scopeType,
      status: facts.status,
      ...(facts.supersedesVersionId === undefined
        ? {}
        : { supersedesVersionId: facts.supersedesVersionId }),
      ...(facts.supersededByVersionId === undefined
        ? {}
        : { supersededByVersionId: facts.supersededByVersionId }),
      competitionId: facts.path.competitionId as string,
      ...(facts.path.eventId === undefined ? {} : { eventId: facts.path.eventId }),
      ...(facts.path.contestId === undefined ? {} : { contestId: facts.path.contestId }),
      participantId: performance.participantId,
      participantKind: part.participant_kind,
      ...(part.athlete_id === null ? {} : { athleteId: part.athlete_id }),
      ...(part.team_id === null ? {} : { teamId: part.team_id }),
      ...(performance.athleteId === undefined
        ? {}
        : { performanceAthleteId: performance.athleteId }),
      ordinal: performance.ordinal,
      mark: performance.mark,
      valid: performance.valid ?? true,
      ...(started === undefined ? {} : { occurredAt: started.toISOString() }),
    },
    verification: input.verification,
    currentMarks,
    ...(input.pendingMark === undefined ? {} : { pendingMark: input.pendingMark }),
  };
  return sealRecordSnapshot(snapshot);
}
