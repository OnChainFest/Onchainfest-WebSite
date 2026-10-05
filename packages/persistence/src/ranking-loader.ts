import {
  DomainError,
  DomainErrorCode,
  PRODUCTION_SUPPORTED_RANKING_FACT_KINDS,
  type RankingDefinitionLifecycle,
  type ResultVersionContent,
  type ResultVersionStatus,
} from '@br/domain';
import type { RankingRunCandidate, RankingRunInput, RankingSystemSpec } from '@br/rankings';
import { sql } from 'kysely';
import { contestStartedAt, verificationSummary } from './achievement-loader';
import { disciplineFacts } from './record-loader';
import type { TxContext } from './tx';

/**
 * BRT-10 canonical ranking-run assembly (the CANONICAL PRODUCTION lane, ADR-0048 §4). Runs under
 * br_rankings (read-only on everything it loads; BRT-07 freshness and run traces under the SELECT-only
 * br_verification_reader in the same transaction) and builds the exact `br:ranking-run-input@1` of one
 * (system version, sporting cutoff):
 *
 *   system      the exact RankingSystemVersion row, its spec + hash, and its CURRENT lifecycle
 *   discipline  the exact DisciplineVersion of the universe (sport / discipline codes, MetricSpec + order)
 *   candidates  EVERY Performance with the universe's Mark metric in EVERY ResultVersion (any status)
 *               of a CONTEST Result of an event of that DisciplineVersion — raw submissions included, so
 *               that each appears in the outcome with its blocker (ADR-0048 §4.3), never silently
 *               dropped. Status from append-only transitions, supersession, the immutable competition
 *               path, the participant's durable holder identity, contest occurrence, verification.
 *
 * Kinds without a producer (HOLD_STATE, POPULATION, RANKING_PUBLICATION) are simply NOT declared, so the
 * engine fails them closed; a hold's absence, a population fact or an owner publication act is never
 * inferred. The competition set and window are gated by the engine (explicit universe), not here.
 */
export const RANKING_ASSEMBLER_VERSION = 'ranking-assembler/1';
export const MAX_RANKING_CANDIDATES = 10_000;

const integrity = (reason: string, message: string, details: Record<string, unknown> = {}) =>
  new DomainError(DomainErrorCode.RANKING_INTEGRITY_FAILURE, message, { reason, ...details });

export interface SystemVersionRow {
  readonly systemId: string;
  readonly code: string;
  readonly kind: 'PLATFORM' | 'OFFICIAL';
  readonly systemVersionId: string;
  readonly version: number;
  readonly specHash: string;
  readonly spec: RankingSystemSpec;
  readonly lifecycle: RankingDefinitionLifecycle;
}

export async function loadSystemVersion(
  ctx: TxContext,
  systemVersionId: string,
): Promise<SystemVersionRow | undefined> {
  const { rows } = await sql<{
    system_id: string;
    code: string;
    kind: 'PLATFORM' | 'OFFICIAL';
    version: number;
    spec_hash: string;
    spec: RankingSystemSpec;
    status: RankingDefinitionLifecycle;
  }>`
    SELECT v.system_id, s.code, v.kind, v.version, v.spec_hash, v.spec, c.status
    FROM ranking.system_version v JOIN ranking.system s ON s.id = v.system_id
    JOIN ranking.v_system_version_current c ON c.system_version_id = v.id
    WHERE v.id = ${systemVersionId}`.execute(ctx.trx);
  const r = rows[0];
  if (r === undefined) return undefined;
  return {
    systemId: r.system_id,
    code: r.code,
    kind: r.kind,
    systemVersionId,
    version: r.version,
    specHash: r.spec_hash,
    spec: r.spec,
    lifecycle: r.status,
  };
}

/** Assembles the canonical run input of `systemVersionId` at the sporting cutoff `asOf`. */
export async function assembleRankingRunInput(
  ctx: TxContext,
  input: { readonly systemVersionId: string; readonly asOf: Date },
): Promise<RankingRunInput> {
  const system = await loadSystemVersion(ctx, input.systemVersionId);
  if (system === undefined)
    throw new DomainError(DomainErrorCode.NOT_FOUND, 'ranking system version not found');
  const universe = system.spec.universe;
  const d = await disciplineFacts(ctx, universe.disciplineVersionId);
  const metric = d.metrics.find((m) => m.key === universe.metric.key);
  if (metric === undefined)
    throw integrity('METRIC_UNKNOWN', 'the universe metric is not a DisciplineVersion metric');

  const { rows } = await sql<{
    result_id: string;
    result_version_id: string;
    content: ResultVersionContent;
    content_hash: string;
    contest_id: string;
    event_id: string;
    competition_id: string;
  }>`
    SELECT r.id AS result_id, v.id AS result_version_id, v.content, v.content_hash,
           ct.id AS contest_id, e.id AS event_id, e.competition_id
    FROM competition.event e
    JOIN competition.contest ct ON ct.event_id = e.id
    JOIN results.result r ON r.scope_type = 'CONTEST' AND r.scope_target_id = ct.id
    JOIN results.result_version v ON v.result_id = r.id
    WHERE e.discipline_version_id = ${universe.disciplineVersionId}
      AND v.content @> jsonb_build_object('performances',
            jsonb_build_array(jsonb_build_object('mark', jsonb_build_object('metricId', ${universe.metric.markMetricId}::text))))
    ORDER BY v.id`.execute(ctx.trx);

  const candidates: RankingRunCandidate[] = [];
  for (const row of rows) {
    const { rows: st } = await sql<{ to_status: Exclude<ResultVersionStatus, 'DRAFT'> }>`
      SELECT to_status FROM results.result_status_transition WHERE result_version_id = ${row.result_version_id}
      ORDER BY recorded_at DESC, id DESC LIMIT 1`.execute(ctx.trx);
    const status = st[0]?.to_status ?? 'SUBMITTED';
    const { rows: sup } = await sql<{ id: string }>`
      SELECT id FROM results.result_version WHERE supersedes_version_id = ${row.result_version_id}
      ORDER BY recorded_at, id LIMIT 1`.execute(ctx.trx);
    const started = await contestStartedAt(ctx, row.contest_id);
    const verification = await verificationSummary(ctx, row.result_version_id);
    for (const perf of row.content.performances ?? []) {
      if (perf.mark.metricId !== universe.metric.markMetricId) continue;
      const { rows: parts } = await sql<{
        participant_kind: 'INDIVIDUAL' | 'TEAM';
        athlete_id: string | null;
        team_id: string | null;
      }>`
        SELECT participant_kind, athlete_id, team_id FROM competition.participant
        WHERE id = ${perf.participantId} AND event_id = ${row.event_id}`.execute(ctx.trx);
      const part = parts[0];
      // The durable public holder identity; an unknown participant is HOLDER_UNRESOLVED (no guess).
      const holder =
        part === undefined
          ? undefined
          : part.participant_kind === 'INDIVIDUAL' && part.athlete_id !== null
            ? { holderType: 'ATHLETE' as const, holderId: part.athlete_id }
            : part.participant_kind === 'TEAM' && part.team_id !== null
              ? { holderType: 'TEAM' as const, holderId: part.team_id }
              : undefined;
      candidates.push({
        resultId: row.result_id,
        resultVersionId: row.result_version_id,
        contentHash: row.content_hash,
        scopeType: 'CONTEST',
        status,
        ...(sup[0] === undefined ? {} : { supersededByVersionId: sup[0].id }),
        competitionId: row.competition_id,
        eventId: row.event_id,
        contestId: row.contest_id,
        participantId: perf.participantId,
        ...(holder === undefined ? {} : { holder }),
        ...(perf.athleteId === undefined ? {} : { performanceAthleteId: perf.athleteId }),
        ordinal: perf.ordinal,
        mark: perf.mark,
        valid: perf.valid ?? true,
        ...(started === undefined ? {} : { occurredAt: started.toISOString() }),
        verification,
      });
      if (candidates.length > MAX_RANKING_CANDIDATES)
        throw integrity('CANDIDATE_LIMIT_EXCEEDED', 'the universe exceeds the run candidate bound');
    }
  }

  return {
    provenance: 'CANONICAL_ASSEMBLY',
    assembler: RANKING_ASSEMBLER_VERSION,
    supportedFactKinds: PRODUCTION_SUPPORTED_RANKING_FACT_KINDS,
    system: {
      systemId: system.systemId,
      code: system.code,
      kind: system.kind,
      systemVersionId: system.systemVersionId,
      version: system.version,
      specHash: system.specHash,
      spec: system.spec,
      lifecycle: system.lifecycle,
    },
    discipline: {
      disciplineVersionId: universe.disciplineVersionId,
      sport: d.sport,
      discipline: d.discipline,
      metric: {
        key: metric.key,
        valueType: metric.valueType,
        unit: metric.unit,
        ...(metric.order === undefined ? {} : { order: metric.order }),
      },
    },
    asOf: input.asOf.toISOString(),
    candidates,
  };
}
