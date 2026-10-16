import {
  conflictKey,
  defaultExpectedEnd,
  deriveUnitKeys,
  evaluateSchedule,
  ianaZoneIssue,
  isWholeSecond,
  planProposalCommit,
  proposeSchedule,
  reportVerdict,
  resolveRequirement,
  scheduleReportHash,
  ScheduleProposalError,
  targetKey,
  type ContestStatus,
  type ContestType,
  type EvaluationAssignment,
  type EvaluationContest,
  type EvaluationEntrant,
  type EvaluationEvent,
  type EvaluationPlace,
  type OccupancyMode,
  type PlaceState,
  type ProposalCommitFact,
  type ProposalCommitRefusal,
  type RoundType,
  type ScheduleEvaluationInput,
  type ScheduleProposal,
  type ScheduleProposalInput,
  type SchedulingProfileSpec,
  type StagePrimitive,
  type UnitContestFacts,
} from '@br/competition';
import { DomainError, DomainErrorCode, newId, type Uuid } from '@br/domain';
import { sql } from 'kysely';
import {
  instantOrThrow,
  loadCompetition,
  loadEvent,
  lockContestLifecycles,
  optionalText,
  requireCompPermission,
  text,
  type CompetitionRow,
} from './competition-support';
import { refreshEventReadModels } from './competition-projection';
import type { Db } from './db';
import { AdvancementStore, type TargetState } from './advancement-store';
import { identityIdempotency, lockKeys, recordAudit } from './identity-support';
import { emitEvent } from './outbox';
import { availabilityFactOfRow, type AvailabilityFactRow } from './resource-store';
import { ScoringStore } from './scoring-store';
import { inTransaction, ModuleRole, type TxContext } from './tx';

/**
 * ONCF-05E-C schedule model (ADR-0070, ADR-0071 contract, ADR-0073): competition schedule versions
 * (private DRAFT → validated PUBLISHED → SUPERSEDED; DRAFT → DISCARDED, terminal), append-only
 * per-contest assignments (at most one resource each, concrete interval, stored changeover, derived
 * unit key, provisional / locked flags), explicit human publication against the canonical conflict
 * report, and `contest_schedule` as the projection of the PUBLISHED version.
 *
 * This store never judges feasibility: overlap, capacity, start spacing, concurrency, participants,
 * rest, dependency lead, availability and daily limits are the 05E-D engine's (`evaluateSchedule`,
 * ADR-0074). It refuses only structurally invalid writes. `validate` and `publish` share ONE private
 * path (`report`) that loads every input server-side and runs the engine — the only validator in
 * force; there is no fallback and no caller-selectable validator. Nothing here branches on sport.
 */

const CLOSED_COMPETITION = ['COMPLETED', 'CANCELLED'];
const SCHEDULABLE_EVENT = ['FIELD_LOCKED', 'IN_PROGRESS'];
const EDITABLE_CONTEST = ['PLANNED', 'SCHEDULED'];
const UUID = /^[0-9a-f-]{36}$/;

type VersionStatus = 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED' | 'DISCARDED';

interface VersionRow {
  version_id: string;
  competition_id: string;
  version_number: number;
  base_version_id: string | null;
  created_by_account_id: string | null;
  recorded_at: Date;
  status: VersionStatus;
  status_reason: string | null;
  status_recorded_at: Date;
}

interface AssignmentRow {
  id: string;
  version_id: string;
  competition_id: string;
  contest_id: string;
  resource_id: string | null;
  starts_at: Date;
  expected_end: Date | null;
  changeover_seconds: number;
  zone: string;
  unit_key: string | null;
  provisional: boolean;
  locked: boolean;
  removed: boolean;
  venue_organization_id: string | null;
  location_label: string | null;
  court_label: string | null;
  reason: string | null;
  replaces_assignment_id: string | null;
  source: 'MANUAL' | 'CARRIED' | 'MIGRATED';
  actor_account_id: string | null;
  recorded_at: Date;
}

export interface AssignmentInput {
  readonly resourceId?: string | null;
  readonly startsAt: Date | string;
  readonly expectedEnd?: Date | string | null;
  readonly changeoverSeconds?: number;
  readonly zone?: string;
  readonly venueOrganizationId?: string | null;
  readonly locationLabel?: string | null;
  readonly courtLabel?: string | null;
  /** Mandatory when an existing assignment is moved (time, end, resource or changeover). */
  readonly reason?: string | null;
}

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

const assignmentView = (a: AssignmentRow) => ({
  assignmentId: a.id,
  versionId: a.version_id,
  contestId: a.contest_id,
  resourceId: a.resource_id,
  startsAt: a.starts_at.toISOString(),
  expectedEnd: iso(a.expected_end),
  changeoverSeconds: a.changeover_seconds,
  zone: a.zone,
  unitKey: a.unit_key,
  provisional: a.provisional,
  locked: a.locked,
  removed: a.removed,
  venueOrganizationId: a.venue_organization_id,
  locationLabel: a.location_label,
  courtLabel: a.court_label,
  reason: a.reason,
  replacesAssignmentId: a.replaces_assignment_id,
  source: a.source,
  actorAccountId: a.actor_account_id,
  recordedAt: a.recorded_at.toISOString(),
});

const versionView = (v: VersionRow) => ({
  versionId: v.version_id,
  competitionId: v.competition_id,
  versionNumber: v.version_number,
  baseVersionId: v.base_version_id,
  status: v.status,
  createdByAccountId: v.created_by_account_id,
  createdAt: v.recorded_at.toISOString(),
  statusChangedAt: v.status_recorded_at.toISOString(),
});

/** What makes two facts the same concrete placement (a "move" changes one of these). */
const placement = (a: {
  resource_id: string | null;
  starts_at: Date;
  expected_end: Date | null;
  changeover_seconds: number;
}) =>
  [
    a.resource_id,
    a.starts_at.getTime(),
    a.expected_end?.getTime() ?? null,
    a.changeover_seconds,
  ].join('|');
/** What the public projection shows. */
const published = (a: AssignmentRow) =>
  [
    a.resource_id,
    a.starts_at.getTime(),
    a.expected_end?.getTime() ?? null,
    a.venue_organization_id,
    a.location_label,
    a.court_label,
  ].join('|');

function stale(reason: string, message: string): DomainError {
  return new DomainError(DomainErrorCode.CONCURRENCY_CONFLICT, message, { reason });
}

/**
 * ADR-0070 §9 (amended, ONCF-05E-H-1): every manual edit states the contest's last fact the client
 * saw in the draft — an assignment fact id (a removal fact counts) — or `null` for an explicit
 * "none". Required: an omitted expectation is refused, never read as "whatever is current".
 */
function expectedLastFact(value: string | null | undefined): string | null {
  if (value === undefined)
    throw new DomainError(
      DomainErrorCode.INVALID_INPUT,
      "a manual schedule edit must state the contest's last fact in the draft, or none",
      { reason: 'PRECONDITION_REQUIRED' },
    );
  if (value !== null && !UUID.test(value))
    throw new DomainError(
      DomainErrorCode.INVALID_INPUT,
      'the expected last fact must be an assignment fact id',
    );
  return value;
}

/** The optimistic-concurrency check: the stated last fact must be the contest's current one. */
function requireLastFact(expected: string | null, current: string | null): void {
  if (expected !== current)
    throw stale(
      'LAST_FACT_STALE',
      "the contest's assignment changed since it was read; read it again before editing",
    );
}

/** The proposal request parameters (ADR-0075 § 4): the only client values a proposal reads. */
interface ProposalScope {
  readonly eventIds?: readonly string[];
  readonly roundIds?: readonly string[];
}

/** `from` as epoch ms, refused unless a whole-second instant (ADR-0075 § 13). */
function fromMsOf(from: Date | string | undefined): number | undefined {
  const ms = from === undefined ? undefined : instantOrThrow(from, 'from').getTime();
  if (ms !== undefined && ms % 1000 !== 0)
    throw new DomainError(DomainErrorCode.INVALID_INPUT, 'from must be a whole-second instant');
  return ms;
}

/** ADR-0075 § 13 engine refusals: no proposal. INCOMPLETE_STATE is a state conflict, never a status. */
function proposalRefused(e: ScheduleProposalError): DomainError {
  return new DomainError(
    e.code === 'INVALID_INPUT' ? DomainErrorCode.INVALID_INPUT : DomainErrorCode.INVALID_TRANSITION,
    `proposal refused (${e.code}): ${e.message}`,
    { reason: e.code },
  );
}

/** A 05E-F-1 commit refusal as the existing domain error it names (ADR-0076 C4–C5). */
function commitRefused(r: ProposalCommitRefusal): DomainError {
  switch (r.reason) {
    case 'PROPOSAL_STALE':
      return stale(
        'PROPOSAL_STALE',
        'the schedule changed since this proposal was previewed; preview it again',
      );
    case 'PROPOSAL_NOT_COMMITTABLE':
      return new DomainError(
        DomainErrorCode.INVALID_TRANSITION,
        `a ${r.status} proposal cannot be committed; only a SUCCESS proposal can`,
        { reason: r.reason, status: r.status },
      );
    case 'NOT_A_DRAFT':
    case 'COMPETITION_CLOSED':
      return new DomainError(
        DomainErrorCode.INVALID_TRANSITION,
        `the proposal cannot be committed (${r.status})`,
        { reason: r.reason, status: r.status },
      );
    case 'INVALID_INPUT':
      return new DomainError(
        DomainErrorCode.INVALID_INPUT,
        `proposal refused (INVALID_INPUT): ${r.message}`,
        { reason: 'INVALID_INPUT' },
      );
  }
}

/** 05D target states per event (eventId → targetKey → state), computed on read (ADR-0074 D2). */
type TargetStates = ReadonlyMap<
  string,
  ReadonlyMap<string, { state: TargetState; participantId: string | null; factId: string | null }>
>;

export class ScheduleStore {
  private readonly db: Db;
  private readonly advancement: AdvancementStore;

  constructor(db: Db) {
    this.db = db;
    this.advancement = new AdvancementStore(db, new ScoringStore(db));
  }

  private tx<T>(fn: (ctx: TxContext) => Promise<T>): Promise<T> {
    return inTransaction(this.db, ModuleRole.competition, fn);
  }

  // ───────────────────────────── authorization and loading ─────────────────────────────

  private async competition(
    ctx: TxContext,
    actor: string,
    competitionId: string,
    permission: 'COMP_VIEW_PRIVATE' | 'COMP_MANAGE_SCHEDULE',
  ): Promise<CompetitionRow> {
    if (!UUID.test(competitionId))
      throw new DomainError(DomainErrorCode.NOT_FOUND, 'competition not found');
    const c = await loadCompetition(ctx, competitionId);
    await requireCompPermission(ctx, actor, c, permission);
    if (permission === 'COMP_MANAGE_SCHEDULE' && CLOSED_COMPETITION.includes(c.status))
      throw new DomainError(
        DomainErrorCode.INVALID_TRANSITION,
        `the schedule is closed for a ${c.status} competition`,
      );
    return c;
  }

  private async version(ctx: TxContext, versionId: string): Promise<VersionRow> {
    if (!UUID.test(versionId))
      throw new DomainError(DomainErrorCode.NOT_FOUND, 'schedule version not found');
    const { rows } = await sql<VersionRow>`
      SELECT * FROM competition.v_schedule_version_current WHERE version_id = ${versionId}`.execute(
      ctx.trx,
    );
    const v = rows[0];
    if (v === undefined)
      throw new DomainError(DomainErrorCode.NOT_FOUND, 'schedule version not found');
    return v;
  }

  /** The version, its competition authorized, the competition schedule locked, the status re-read. */
  private async draft(ctx: TxContext, actor: string, versionId: string): Promise<VersionRow> {
    const before = await this.version(ctx, versionId);
    await this.competition(ctx, actor, before.competition_id, 'COMP_MANAGE_SCHEDULE');
    await lockKeys(ctx, `competition-schedule:${before.competition_id}`);
    const v = await this.version(ctx, versionId);
    if (v.status !== 'DRAFT')
      throw new DomainError(
        DomainErrorCode.INVALID_TRANSITION,
        `a ${v.status} schedule version cannot be changed`,
        { reason: 'NOT_A_DRAFT', status: v.status },
      );
    return v;
  }

  private async currentOf(
    ctx: TxContext,
    competitionId: string,
    status: 'DRAFT' | 'PUBLISHED',
  ): Promise<VersionRow | undefined> {
    const { rows } = await sql<VersionRow>`
      SELECT * FROM competition.v_schedule_version_current
      WHERE competition_id = ${competitionId} AND status = ${status}`.execute(ctx.trx);
    return rows[0];
  }

  private async content(ctx: TxContext, versionId: string): Promise<AssignmentRow[]> {
    const { rows } = await sql<AssignmentRow>`
      SELECT * FROM competition.v_schedule_assignment_current WHERE version_id = ${versionId}
      ORDER BY starts_at, contest_id`.execute(ctx.trx);
    return rows;
  }

  private async fact(
    ctx: TxContext,
    versionId: string,
    contestId: string,
  ): Promise<AssignmentRow | undefined> {
    const { rows } = await sql<AssignmentRow>`
      SELECT * FROM competition.v_schedule_assignment_current
      WHERE version_id = ${versionId} AND contest_id = ${contestId}`.execute(ctx.trx);
    return rows[0];
  }

  private async insertFact(
    ctx: TxContext,
    f: Omit<AssignmentRow, 'id' | 'recorded_at'>,
  ): Promise<string> {
    const id = newId();
    await sql`INSERT INTO competition.schedule_assignment
        (id, version_id, competition_id, contest_id, resource_id, starts_at, expected_end, changeover_seconds, zone, unit_key,
         provisional, locked, removed, venue_organization_id, location_label, court_label, reason, replaces_assignment_id,
         source, actor_account_id, recorded_at)
      VALUES (${id}, ${f.version_id}, ${f.competition_id}, ${f.contest_id}, ${f.resource_id}, ${f.starts_at}, ${f.expected_end},
              ${f.changeover_seconds}, ${f.zone}, ${f.unit_key}, ${f.provisional}, ${f.locked}, ${f.removed},
              ${f.venue_organization_id}, ${f.location_label}, ${f.court_label}, ${f.reason}, ${f.replaces_assignment_id},
              ${f.source}, ${f.actor_account_id}, ${ctx.txTime})`.execute(ctx.trx);
    return id;
  }

  /** The contest, checked against the version's competition and the operational lifecycle. */
  private async contest(ctx: TxContext, competitionId: string, contestId: string) {
    if (!UUID.test(contestId))
      throw new DomainError(DomainErrorCode.NOT_FOUND, 'contest not found');
    const { rows } = await sql<{
      event_id: string;
      competition_id: string;
      status: string;
      contest_type: ContestType;
      round_type: RoundType;
      stage_primitive: StagePrimitive | null;
      dynamic: boolean;
      latest_offset: number;
    }>`
      SELECT c.event_id, e.competition_id, cc.status, c.contest_type, r.round_type, st.primitive AS stage_primitive,
             r.dynamic_transition_key IS NOT NULL AS dynamic,
             coalesce((SELECT max(ce.start_offset_seconds) FROM competition.contest_entry ce WHERE ce.contest_id = c.id), 0)::int
               AS latest_offset
      FROM competition.contest c
      JOIN competition.event e ON e.id = c.event_id
      JOIN competition.v_contest_current cc ON cc.contest_id = c.id
      JOIN competition.round r ON r.id = c.round_id
      LEFT JOIN competition.stage st ON st.id = r.stage_id
      WHERE c.id = ${contestId}`.execute(ctx.trx);
    const c = rows[0];
    if (c === undefined) throw new DomainError(DomainErrorCode.NOT_FOUND, 'contest not found');
    if (c.competition_id !== competitionId)
      throw new DomainError(
        DomainErrorCode.INVALID_INPUT,
        'the contest belongs to another competition',
        { reason: 'CROSS_COMPETITION' },
      );
    return c;
  }

  private async profile(
    ctx: TxContext,
    eventId: string,
  ): Promise<{ versionId: string; specHash: string; spec: SchedulingProfileSpec } | null> {
    const { rows } = await sql<{ id: string; spec_hash: string; spec: SchedulingProfileSpec }>`
      SELECT v.id, v.spec_hash, v.spec FROM competition.v_event_scoring_current s
      JOIN sports.scheduling_profile_version v ON v.id = s.scheduling_profile_version_id
      WHERE s.event_id = ${eventId}`.execute(ctx.trx);
    const p = rows[0];
    return p === undefined ? null : { versionId: p.id, specHash: p.spec_hash, spec: p.spec };
  }

  /**
   * Plan facts of every contest of a competition (or of one event): the same rows feed the unit key
   * recorded at write time and the 05E-D engine, so both derive units identically (ADR-0073 B9).
   */
  private async contestRows(
    ctx: TxContext,
    scope: { readonly competitionId: string } | { readonly eventId: string },
  ) {
    const competitionId = 'competitionId' in scope ? scope.competitionId : null;
    const eventId = 'eventId' in scope ? scope.eventId : null;
    const { rows } = await sql<{
      contest_id: string;
      event_id: string;
      round_id: string;
      round_sequence: number;
      dynamic_transition_key: string | null;
      stage_id: string | null;
      stage_sequence: number;
      grouped: boolean;
      dynamic: boolean;
      contest_type: ContestType;
      round_type: RoundType;
      stage_primitive: StagePrimitive | null;
      sequence: number;
      partition_key: string | null;
      status: ContestStatus;
      participant_id: string | null;
      field_ordinal: number | null;
    }>`
      SELECT c.id AS contest_id, c.event_id, c.round_id, r.sequence AS round_sequence, r.dynamic_transition_key,
             r.stage_id, coalesce(st.sequence, 0) AS stage_sequence,
             coalesce(st.partition_method = 'GROUPED_ENTRANTS', false) AS grouped,
             r.dynamic_transition_key IS NOT NULL AS dynamic, c.contest_type, r.round_type,
             st.primitive AS stage_primitive, c.sequence, c.partition_key,
             coalesce(cc.status, 'PLANNED') AS status, one.participant_id, one.field_ordinal
      FROM competition.contest c
      JOIN competition.event e ON e.id = c.event_id
      LEFT JOIN competition.v_contest_current cc ON cc.contest_id = c.id
      JOIN competition.round r ON r.id = c.round_id
      LEFT JOIN competition.stage st ON st.id = r.stage_id
      LEFT JOIN LATERAL (
        SELECT CASE WHEN ct.source_kind = 'PARTICIPANT' THEN ct.participant_id END AS participant_id,
               CASE WHEN ct.source_kind = 'QUALIFIER' THEN ct.source_ordinal END AS field_ordinal
        FROM competition.contestant ct
        -- Only a single-place (per-entrant) contest has one entrant to inherit or one ordinal.
        WHERE ct.contest_id = c.id
          AND (SELECT count(*) FROM competition.contestant x WHERE x.contest_id = c.id) = 1
      ) one ON true
      WHERE (${competitionId}::uuid IS NULL OR e.competition_id = ${competitionId}::uuid)
        AND (${eventId}::uuid IS NULL OR c.event_id = ${eventId}::uuid)`.execute(ctx.trx);
    return rows;
  }

  private static unitFacts(r: {
    contest_id: string;
    round_id: string;
    round_sequence: number;
    stage_id: string | null;
    grouped: boolean;
    dynamic: boolean;
    partition_key: string | null;
    participant_id: string | null;
    field_ordinal: number | null;
  }): UnitContestFacts {
    return {
      contestId: r.contest_id,
      roundId: r.round_id,
      roundSequence: r.round_sequence,
      stageId: r.stage_id,
      grouped: r.grouped,
      dynamic: r.dynamic,
      partitionKey: r.partition_key,
      participantId: r.participant_id,
      fieldOrdinal: r.field_ordinal,
    };
  }

  /** Unit keys of every contest of an event (ADR-0073 B9), from plan, 05D and profile data. */
  private async unitKeys(
    ctx: TxContext,
    eventId: string,
    spec: SchedulingProfileSpec | undefined,
  ): Promise<Map<string, string>> {
    const rows = await this.contestRows(ctx, { eventId });
    return deriveUnitKeys(rows.map(ScheduleStore.unitFacts), spec?.regrouping);
  }

  /** Whether any place of the contest is still unresolved (a provisional assignment). */
  private async provisional(ctx: TxContext, contestId: string, dynamic: boolean) {
    const { rows } = await sql<{ open: number; filled: number }>`
      SELECT count(*) FILTER (WHERE participant_id IS NULL)::int AS open,
             count(*) FILTER (WHERE participant_id IS NOT NULL)::int AS filled
      FROM competition.v_contest_occupant WHERE contest_id = ${contestId}`.execute(ctx.trx);
    const r = rows[0] ?? { open: 0, filled: 0 };
    return r.open > 0 || (dynamic && r.filled === 0);
  }

  // ───────────────────────────── reads (COMP_VIEW_PRIVATE) ─────────────────────────────

  async listVersions(input: { actorAccountId: string; competitionId: string }) {
    return this.tx(async (ctx) => {
      await this.competition(ctx, input.actorAccountId, input.competitionId, 'COMP_VIEW_PRIVATE');
      const { rows } = await sql<VersionRow>`
        SELECT * FROM competition.v_schedule_version_current WHERE competition_id = ${input.competitionId}
        ORDER BY version_number DESC`.execute(ctx.trx);
      return { items: rows.map(versionView) };
    });
  }

  /** One version: current content, the status history and every assignment fact (history). */
  async getVersion(input: { actorAccountId: string; versionId: string }) {
    return this.tx(async (ctx) => {
      const v = await this.version(ctx, input.versionId);
      await this.competition(ctx, input.actorAccountId, v.competition_id, 'COMP_VIEW_PRIVATE');
      const { rows: statuses } = await sql<{
        status: VersionStatus;
        reason: string | null;
        actor_account_id: string | null;
        recorded_at: Date;
      }>`
        SELECT status, reason, actor_account_id, recorded_at FROM competition.schedule_version_status_change
        WHERE version_id = ${v.version_id} ORDER BY seq`.execute(ctx.trx);
      const { rows: history } = await sql<AssignmentRow>`
        SELECT * FROM competition.schedule_assignment WHERE version_id = ${v.version_id} ORDER BY seq`.execute(
        ctx.trx,
      );
      const { rows: pub } = await sql<{
        report_hash: string;
        coverage: string[];
        acknowledged_conflict_keys: string[];
        superseded_version_id: string | null;
        actor_account_id: string;
        recorded_at: Date;
      }>`
        SELECT report_hash, coverage, acknowledged_conflict_keys, superseded_version_id, actor_account_id, recorded_at
        FROM competition.schedule_publication WHERE version_id = ${v.version_id}`.execute(ctx.trx);
      const p = pub[0];
      return {
        ...versionView(v),
        statusHistory: statuses.map((s) => ({
          status: s.status,
          reason: s.reason,
          actorAccountId: s.actor_account_id,
          recordedAt: s.recorded_at.toISOString(),
        })),
        assignments: (await this.content(ctx, v.version_id))
          .filter((a) => !a.removed)
          .map(assignmentView),
        history: history.map(assignmentView),
        publication:
          p === undefined
            ? null
            : {
                reportHash: p.report_hash,
                coverage: p.coverage,
                acknowledgedConflictKeys: p.acknowledged_conflict_keys,
                supersededVersionId: p.superseded_version_id,
                actorAccountId: p.actor_account_id,
                publishedAt: p.recorded_at.toISOString(),
              },
      };
    });
  }

  // ───────────────────────────── the conflict report (validator in force) ─────────────────────────────

  /**
   * 05D target states of every event of the version's competition, computed on read by 05D itself
   * (staleness included). They are computed under 05D's own module roles, so they are read just
   * before the command transaction (the same pattern as 05D's start guard) after the same
   * authorization; their digest is hashed into the report, so a later change makes it stale.
   */
  private async targetStates(actor: string, versionId: string): Promise<TargetStates> {
    const events = await this.tx(async (ctx) => {
      const v = await this.version(ctx, versionId);
      await this.competition(ctx, actor, v.competition_id, 'COMP_MANAGE_SCHEDULE');
      const { rows } = await sql<{ id: string }>`
        SELECT id FROM competition.event WHERE competition_id = ${v.competition_id} ORDER BY id`.execute(
        ctx.trx,
      );
      return rows.map((r) => r.id);
    });
    const out = new Map<string, Awaited<ReturnType<AdvancementStore['targetStates']>>>();
    for (const id of events) out.set(id, await this.advancement.targetStates(id));
    return out;
  }

  /**
   * The 05E-D engine's input for exactly the version's current content, every value loaded here,
   * server-side (ADR-0074 D2). The one loader for `validate`, `publish` and the 05E-E proposal
   * preview (ADR-0075 § 4), so a proposal is judged against exactly what publication would judge.
   */
  private async evaluationInput(
    ctx: TxContext,
    v: VersionRow,
    states: TargetStates,
  ): Promise<ScheduleEvaluationInput> {
    const competitionId = v.competition_id;
    const { rows: tz } = await sql<{ timezone: string }>`
      SELECT timezone FROM competition.competition_profile WHERE competition_id = ${competitionId}`.execute(
      ctx.trx,
    );
    // The same default the resource store applies to availability layers.
    const competitionZone = tz[0]?.timezone ?? 'UTC';
    const facts = await this.content(ctx, v.version_id);
    const base = v.base_version_id === null ? [] : await this.content(ctx, v.base_version_id);
    const assignment = (a: AssignmentRow): EvaluationAssignment => ({
      id: a.id,
      contestId: a.contest_id,
      resourceId: a.resource_id,
      startMs: a.starts_at.getTime(),
      expectedEndMs: a.expected_end?.getTime() ?? null,
      changeoverSeconds: a.changeover_seconds,
      recordedUnitKey: a.unit_key,
    });

    // Events, windows and pinned profiles.
    const { rows: evs } = await sql<{
      event_id: string;
      timezone: string;
      starts_at: Date | null;
      ends_at: Date | null;
    }>`
      SELECT e.id AS event_id, p.timezone, coalesce(p.starts_at, cp.starts_at) AS starts_at,
             coalesce(p.ends_at, cp.ends_at) AS ends_at
      FROM competition.event e
      JOIN competition.event_profile p ON p.event_id = e.id
      LEFT JOIN competition.competition_profile cp ON cp.competition_id = e.competition_id
      WHERE e.competition_id = ${competitionId} ORDER BY e.id`.execute(ctx.trx);
    const events: EvaluationEvent[] = [];
    for (const e of evs)
      events.push({
        id: e.event_id,
        timezone: e.timezone,
        windowStartMs: e.starts_at?.getTime() ?? null,
        windowEndMs: e.ends_at?.getTime() ?? null,
        profile: await this.profile(ctx, e.event_id),
      });

    // The plan graph: rounds, transitions, contests, places, feeders.
    const contestRows = await this.contestRows(ctx, { competitionId });
    const { rows: rounds } = await sql<{
      id: string;
      event_id: string;
      plan_key: string;
      sequence: number;
      stage_id: string | null;
      group_key: string | null;
    }>`
      SELECT r.id, r.event_id, r.plan_key, r.sequence, r.stage_id, r.group_key FROM competition.round r
      JOIN competition.event e ON e.id = r.event_id WHERE e.competition_id = ${competitionId}`.execute(
      ctx.trx,
    );
    const { rows: transitions } = await sql<{
      id: string;
      event_id: string;
      plan_key: string;
      from_stage_id: string;
      after_round_plan_key: string | null;
    }>`
      SELECT t.id, t.event_id, t.plan_key, t.from_stage_id, t.after_round_plan_key
      FROM competition.stage_transition t JOIN competition.event e ON e.id = t.event_id
      WHERE e.competition_id = ${competitionId}`.execute(ctx.trx);
    const roundsOf = new Map<string, typeof rounds>();
    for (const r of rounds) roundsOf.set(r.event_id, [...(roundsOf.get(r.event_id) ?? []), r]);
    const contestsOfRound = new Map<string, string[]>();
    for (const c of contestRows)
      contestsOfRound.set(c.round_id, [...(contestsOfRound.get(c.round_id) ?? []), c.contest_id]);
    const contestsWhere = (eventId: string, keep: (r: (typeof rounds)[number]) => boolean) =>
      (roundsOf.get(eventId) ?? []).filter(keep).flatMap((r) => contestsOfRound.get(r.id) ?? []);
    /** The contests a transition's field is decided from (its from-stage, up to its after-round). */
    const transitionFeeders = (t: (typeof transitions)[number]) => {
      const after = (roundsOf.get(t.event_id) ?? []).find(
        (r) => r.plan_key === t.after_round_plan_key,
      );
      return contestsWhere(
        t.event_id,
        (r) =>
          r.stage_id === t.from_stage_id && (after === undefined || r.sequence <= after.sequence),
      );
    };
    const transitionById = new Map(transitions.map((t) => [t.id, t]));
    const transitionByKey = new Map(transitions.map((t) => [`${t.event_id}|${t.plan_key}`, t]));
    const contestById = new Map(contestRows.map((c) => [c.contest_id, c]));

    const state = (eventId: string, key: string) =>
      states.get(eventId)?.get(key) ?? {
        state: 'UNRESOLVED' as const,
        participantId: null,
        factId: null,
      };
    const places: EvaluationPlace[] = [];
    const { rows: contestants } = await sql<{
      contest_id: string;
      slot: number;
      source_kind: string;
      participant_id: string | null;
      source_contest_id: string | null;
      source_stage_id: string | null;
      source_group_key: string | null;
      source_ordinal: number | null;
      source_transition_id: string | null;
    }>`
      SELECT ct.contest_id, ct.slot, ct.source_kind, ct.participant_id, ct.source_contest_id, ct.source_stage_id,
             ct.source_group_key, ct.source_ordinal, ct.source_transition_id
      FROM competition.contestant ct JOIN competition.contest c ON c.id = ct.contest_id
      JOIN competition.event e ON e.id = c.event_id WHERE e.competition_id = ${competitionId}`.execute(
      ctx.trx,
    );
    for (const ct of contestants) {
      const c = contestById.get(ct.contest_id);
      if (c === undefined) throw new Error('contestant without contest');
      if (ct.source_kind === 'PARTICIPANT') {
        places.push({
          contestId: ct.contest_id,
          place: ct.slot,
          sourceKind: ct.source_kind,
          state: 'FIXED',
          occupantId: ct.participant_id,
          factId: null,
          feeders: [],
        });
        continue;
      }
      let feeders: string[];
      let key: string;
      if (ct.source_kind === 'QUALIFIER') {
        const t = transitionById.get(ct.source_transition_id ?? '');
        if (t === undefined) throw new Error('qualifier without transition');
        feeders = transitionFeeders(t);
        key = targetKey({
          kind: 'FIELD',
          transitionKey: t.plan_key,
          ordinal: ct.source_ordinal as number,
        });
      } else {
        key = targetKey({ kind: 'SLOT', contestId: ct.contest_id, slot: ct.slot });
        feeders =
          ct.source_kind === 'WINNER_OF_CONTEST' || ct.source_kind === 'LOSER_OF_CONTEST'
            ? [ct.source_contest_id as string]
            : ct.source_stage_id !== null
              ? contestsWhere(
                  c.event_id,
                  (r) =>
                    r.stage_id === ct.source_stage_id &&
                    (ct.source_group_key === null || r.group_key === ct.source_group_key),
                )
              : // A v1 rank row names no stage: every earlier round of the event, conservatively.
                contestsWhere(c.event_id, (r) => r.sequence < c.round_sequence);
      }
      const s = state(c.event_id, key);
      places.push({
        contestId: ct.contest_id,
        place: ct.slot,
        sourceKind: ct.source_kind,
        state: s.state as PlaceState,
        occupantId: s.participantId,
        factId: s.factId,
        feeders,
      });
    }
    const { rows: entries } = await sql<{
      contest_id: string;
      participant_id: string;
      start_order: number;
    }>`
      SELECT ce.contest_id, ce.participant_id, ce.start_order FROM competition.contest_entry ce
      JOIN competition.contest c ON c.id = ce.contest_id JOIN competition.event e ON e.id = c.event_id
      WHERE e.competition_id = ${competitionId}`.execute(ctx.trx);
    for (const ce of entries)
      places.push({
        contestId: ce.contest_id,
        place: ce.start_order,
        sourceKind: 'FIELD_ENTRY',
        state: 'FIXED',
        occupantId: ce.participant_id,
        factId: null,
        feeders: [],
      });
    // A dynamic-round contest without slots or entries reads its round's whole field (05D).
    const placed = new Set(places.map((p) => p.contestId));
    const contests: EvaluationContest[] = contestRows.map((c) => {
      const t =
        c.dynamic_transition_key === null
          ? undefined
          : transitionByKey.get(`${c.event_id}|${c.dynamic_transition_key}`);
      const fromTransition = t === undefined ? [] : transitionFeeders(t);
      if (t !== undefined && !placed.has(c.contest_id))
        for (const [key, s] of [...(states.get(c.event_id) ?? new Map()).entries()].sort())
          if (key.startsWith(`field:${t.plan_key}:`))
            places.push({
              contestId: c.contest_id,
              place: Number(key.split(':')[2]),
              sourceKind: 'QUALIFIER',
              state: s.state as PlaceState,
              occupantId: s.participantId,
              factId: s.factId,
              feeders: fromTransition,
            });
      return {
        id: c.contest_id,
        eventId: c.event_id,
        roundId: c.round_id,
        roundSequence: c.round_sequence,
        stageId: c.stage_id,
        stageSequence: c.stage_sequence,
        grouped: c.grouped,
        dynamic: c.dynamic,
        contestType: c.contest_type,
        roundType: c.round_type,
        stagePrimitive: c.stage_primitive,
        sequence: c.sequence,
        partitionKey: c.partition_key,
        status: c.status,
        unitParticipantId: c.participant_id,
        unitFieldOrdinal: c.field_ordinal,
        feeders: fromTransition,
      };
    });
    // A contest's plan edges: its own feeders plus every feeder of its places.
    const placeFeeders = new Map<string, Set<string>>();
    for (const p of places)
      for (const f of p.feeders)
        placeFeeders.set(p.contestId, (placeFeeders.get(p.contestId) ?? new Set()).add(f));
    const withEdges = contests.map((c) => ({
      ...c,
      feeders: [...new Set([...c.feeders, ...(placeFeeders.get(c.id) ?? [])])].sort(),
    }));

    // Entrants: the athlete, or the team's frozen roster (ADR-0057).
    const { rows: participants } = await sql<{
      id: string;
      participant_kind: 'INDIVIDUAL' | 'TEAM';
      athlete_id: string | null;
      roster: string[] | null;
    }>`
      SELECT p.id, p.participant_kind, p.athlete_id,
             (SELECT array_agg(m.athlete_id::text ORDER BY m.athlete_id) FROM competition.participant_roster_member m
              WHERE m.participant_id = p.id) AS roster
      FROM competition.participant p JOIN competition.event e ON e.id = p.event_id
      WHERE e.competition_id = ${competitionId}`.execute(ctx.trx);
    const entrants: EvaluationEntrant[] = participants.map((p) => ({
      id: p.id,
      kind: p.participant_kind,
      personIds: p.participant_kind === 'INDIVIDUAL' ? [p.athlete_id as string] : (p.roster ?? []),
    }));

    // Resources (the revision in force) and availability.
    const { rows: resources } = await sql<{
      resource_id: string;
      revision_id: string;
      type_code: string;
      occupancy_mode: OccupancyMode;
      capacity: number;
      exclusivity_keys: string[];
      timezone: string | null;
      status: 'ACTIVE' | 'RETIRED';
    }>`
      SELECT resource_id, revision_id, type_code, occupancy_mode, capacity, exclusivity_keys, timezone, status
      FROM competition.v_resource_current WHERE competition_id = ${competitionId}`.execute(ctx.trx);
    const { rows: availability } = await sql<AvailabilityFactRow>`
      SELECT id, resource_id, kind, weekday, to_char(local_date, 'YYYY-MM-DD') AS local_date, local_start, local_end,
             to_char(valid_from, 'YYYY-MM-DD') AS valid_from, to_char(valid_to, 'YYYY-MM-DD') AS valid_to,
             starts_at, ends_at, reason, recorded_at
      FROM competition.v_resource_availability_current WHERE competition_id = ${competitionId}`.execute(
      ctx.trx,
    );

    return {
      competitionId,
      competitionTimezone: competitionZone,
      scheduleVersionId: v.version_id,
      // The watermark covers every current fact, removals included: a removal is content.
      watermark: facts.map((a) => a.id),
      assignments: facts.filter((a) => !a.removed).map(assignment),
      baseAssignments: base.filter((a) => !a.removed).map(assignment),
      contests: withEdges,
      places,
      entrants,
      events,
      resources: resources.map((r) => ({
        id: r.resource_id,
        revisionId: r.revision_id,
        typeCode: r.type_code,
        occupancyMode: r.occupancy_mode,
        capacity: r.capacity,
        exclusivityKeys: r.exclusivity_keys,
        zone: r.timezone ?? competitionZone,
        status: r.status,
      })),
      availability: availability.map((f) => ({
        id: f.id,
        resourceId: f.resource_id,
        fact: availabilityFactOfRow(f),
      })),
    };
  }

  /**
   * The canonical report over exactly the version's current content, judged by the 05E-D engine
   * (ADR-0074 D1, D2). The one path for `validate` and `publish`.
   */
  private async report(ctx: TxContext, v: VersionRow, states: TargetStates) {
    const report = evaluateSchedule(await this.evaluationInput(ctx, v, states));
    return { report, reportHash: scheduleReportHash(report) };
  }

  /** The report the publish command would check, with its hash and acknowledgement keys. */
  async validate(input: { actorAccountId: string; versionId: string }) {
    const states = await this.targetStates(input.actorAccountId, input.versionId);
    return this.tx(async (ctx) => {
      const v = await this.version(ctx, input.versionId);
      await this.competition(ctx, input.actorAccountId, v.competition_id, 'COMP_MANAGE_SCHEDULE');
      const { report, reportHash } = await this.report(ctx, v, states);
      const verdict = reportVerdict(report);
      return {
        reportHash,
        report,
        hardConflicts: verdict.hard,
        conflicts: report.conflicts.map((c) => ({ conflictKey: conflictKey(c), ...c })),
      };
    });
  }

  // ───────────────────────────── proposal preview (05E-E; ADR-0075 § 16) ─────────────────────────────

  /**
   * ADR-0075 § 16 PREVIEW: the 05E-E proposal for the open draft. The pure engine
   * (`proposeSchedule`) runs over exactly the input `validate` loads (same loader, same judge) plus
   * the authoritative facts the judge does not read: lifecycle states, latest plan offsets and the
   * base PUBLISHED version. Nothing here searches, judges or chooses.
   *
   * Strictly observational: after authorization the transaction is READ ONLY at the database level,
   * nothing is locked, audited or emitted, and no proposal is stored (v1 is ephemeral, § 3). `scope`
   * and `from` are the only request parameters (§ 4). The budget and strategy are the engine's (§ 12).
   */
  async previewProposal(input: {
    actorAccountId: string;
    versionId: string;
    scope?: ProposalScope;
    from?: Date | string;
  }) {
    const fromMs = fromMsOf(input.from);
    const states = await this.targetStates(input.actorAccountId, input.versionId);
    return this.tx(async (ctx) => {
      const v = await this.version(ctx, input.versionId);
      const c = await this.competition(
        ctx,
        input.actorAccountId,
        v.competition_id,
        'COMP_MANAGE_SCHEDULE',
      );
      // From here on PostgreSQL refuses any write of this transaction.
      await sql`SET TRANSACTION READ ONLY`.execute(ctx.trx);
      const proposalInput = await this.proposalInput(ctx, v, c.status, states, input.scope, fromMs);

      let proposal: ScheduleProposal;
      try {
        proposal = proposeSchedule(proposalInput);
      } catch (e) {
        if (e instanceof ScheduleProposalError) throw proposalRefused(e);
        throw e;
      }
      // The canonical proposal (hashed) and the execution metadata (never hashed), kept apart.
      const { diagnostics, ...body } = proposal;
      return {
        versionId: v.version_id,
        competitionId: v.competition_id,
        proposal: body,
        diagnostics,
      };
    });
  }

  /**
   * The proposal engine's input for the version (ADR-0075 § 4), the one assembly shared by preview
   * and commit so the two can never drift: the judge's input from `evaluationInput` (the loader
   * `validate` / `publish` use) plus the authoritative facts the judge does not read — lifecycle
   * states, latest plan offsets and the base PUBLISHED version — and the request's `scope` / `from`.
   */
  private async proposalInput(
    ctx: TxContext,
    v: VersionRow,
    competitionStatus: string,
    states: TargetStates,
    scope: ProposalScope | undefined,
    fromMs: number | undefined,
  ): Promise<ScheduleProposalInput> {
    const { rows: drafts } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM competition.v_schedule_version_current
      WHERE competition_id = ${v.competition_id} AND status = 'DRAFT'`.execute(ctx.trx);
    // One open draft per competition is a schema invariant; never pick one arbitrarily.
    if ((drafts[0]?.n ?? 0) > 1)
      throw new DomainError(
        DomainErrorCode.INVALID_TRANSITION,
        'the competition has more than one open schedule draft',
        { reason: 'AMBIGUOUS_DRAFT' },
      );

    const judge = await this.evaluationInput(ctx, v, states);
    // Scope names only this competition's events and rounds (ADR-0075 § 13). Fixed message: the
    // request's ids are never echoed, and a foreign id reads the same whether it exists or not.
    const events = new Set(judge.events.map((e) => e.id));
    const rounds = new Set(judge.contests.map((x) => x.roundId));
    if (
      (scope?.eventIds ?? []).some((id) => !events.has(id)) ||
      (scope?.roundIds ?? []).some((id) => !rounds.has(id))
    )
      throw new DomainError(
        DomainErrorCode.INVALID_INPUT,
        'the scope names an event or round outside this competition',
        { reason: 'FOREIGN_SCOPE' },
      );

    const { rows: eventStatuses } = await sql<{ event_id: string; status: string }>`
      SELECT s.event_id, s.status FROM competition.v_event_current s
      JOIN competition.event e ON e.id = s.event_id
      WHERE e.competition_id = ${v.competition_id}`.execute(ctx.trx);
    // The same latest plan offset 05E-C's write default uses for the expected end.
    const { rows: offsets } = await sql<{ contest_id: string; seconds: number }>`
      SELECT c.id AS contest_id, coalesce(max(ce.start_offset_seconds), 0)::int AS seconds
      FROM competition.contest c JOIN competition.event e ON e.id = c.event_id
      LEFT JOIN competition.contest_entry ce ON ce.contest_id = c.id
      WHERE e.competition_id = ${v.competition_id} GROUP BY c.id`.execute(ctx.trx);

    return {
      judge,
      draftStatus: v.status,
      competitionStatus,
      basePublishedVersionId: v.base_version_id,
      eventStatuses: eventStatuses
        .filter((e) => events.has(e.event_id))
        .map((e) => ({ eventId: e.event_id, status: e.status })),
      latestOffsets: offsets.map((o) => ({ contestId: o.contest_id, seconds: o.seconds })),
      ...(scope === undefined ? {} : { scope }),
      ...(fromMs === undefined ? {} : { fromMs }),
    };
  }

  // ───────────────────────────── proposal commit (05E-F; ADR-0075 § 16–18, ADR-0076) ─────────────────────────────

  /**
   * ADR-0075 § 16 COMMIT: append the server's own recomputation of a previewed proposal to the open
   * draft, in ONE transaction. The client supplies only the presented `proposalHash` and the request
   * parameters that reproduce the proposal (`scope`, `from`); never placements, never a status.
   *
   * Under the competition-schedule advisory lock (taken by `draft()`, which also re-resolves
   * `COMP_MANAGE_SCHEDULE` and re-reads DRAFT), the input is reloaded with the preview's assembly
   * and the 05E-F-1 decision (`planProposalCommit`) recomputes the proposal: a hash mismatch is
   * `PROPOSAL_STALE`, a non-SUCCESS status `PROPOSAL_NOT_COMMITTABLE` — both before the first write.
   * The plan is then applied through the per-fact write path (every 05E-C structural refusal and
   * per-fact event/audit applies), additive only, followed by one `ScheduleProposalCommitted` event,
   * one `schedule.proposal-committed` audit and the idempotency record. Any throw rolls all of it
   * back. READ COMMITTED (never REPEATABLE READ): every read after the lock sees the facts of the
   * previous holder, so a commit that waited for a concurrent one is recomputed against them.
   */
  async commitProposal(input: {
    actorAccountId: string;
    versionId: string;
    proposalHash: string;
    scope?: ProposalScope;
    from?: Date | string;
    idempotencyKey: string;
  }) {
    const fromMs = fromMsOf(input.from);
    const canonical = (ids: readonly string[] | undefined) =>
      ids === undefined ? null : [...new Set(ids)].sort();
    const states = await this.targetStates(input.actorAccountId, input.versionId);
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{
        versionId: string;
        competitionId: string;
        proposalHash: string;
        baseStateIdentity: string;
        assignmentIds: { contestId: string; assignmentId: string }[];
        placedContests: number;
      }>(ctx, {
        command: 'CommitScheduleProposal',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: {
          versionId: input.versionId,
          proposalHash: input.proposalHash,
          // As the engine canonicalizes it: sorted, unique; absent stays distinct from empty.
          scope: {
            eventIds: canonical(input.scope?.eventIds),
            roundIds: canonical(input.scope?.roundIds),
          },
          from: fromMs ?? null,
        },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      const v = await this.draft(ctx, input.actorAccountId, input.versionId);
      const c = await loadCompetition(ctx, v.competition_id);
      const proposalInput = await this.proposalInput(ctx, v, c.status, states, input.scope, fromMs);

      let decision;
      try {
        decision = planProposalCommit(proposalInput, { proposalHash: input.proposalHash });
      } catch (e) {
        if (e instanceof ScheduleProposalError) throw proposalRefused(e);
        throw e;
      }
      if (!decision.ok) throw commitRefused(decision.refusal);
      const plan = decision.plan;
      if (plan.scheduleVersionId !== v.version_id || plan.competitionId !== v.competition_id)
        throw new Error('proposal commit invariant: the plan names another version');

      // The plan's facts, in its order (contest id), exactly as recomputed (ADR-0075 § 17).
      const assignmentIds: { contestId: string; assignmentId: string }[] = [];
      for (const f of plan.facts) {
        const { assignmentId } = await this.setAssignmentTx(
          ctx,
          v,
          input.actorAccountId,
          f.contestId,
          {
            resourceId: f.resourceId,
            startsAt: new Date(f.start * 1000),
            expectedEnd: new Date(f.expectedEnd * 1000),
            changeoverSeconds: f.changeoverSeconds,
            zone: f.zone,
            reason: plan.reason,
          },
          f,
        );
        assignmentIds.push({ contestId: f.contestId, assignmentId });
      }

      // ADR-0070 §10, ADR-0075 § 17: the commit's provenance — ids, hashes and counts only.
      await emitEvent(ctx, {
        eventType: 'ScheduleProposalCommitted',
        aggregateType: 'SCHEDULE_VERSION',
        aggregateId: v.version_id as Uuid,
        payload: {
          competitionId: v.competition_id,
          proposalHash: plan.proposalHash,
          baseStateIdentity: plan.baseStateIdentity,
          strategy: plan.strategy,
          budget: plan.budget,
          reportHash: plan.reportHash,
          placedUnits: plan.placedUnits,
          placedContests: plan.placedContests,
          unplacedUnits: plan.unplacedUnits,
          assignments: assignmentIds,
        },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'schedule.proposal-committed',
        targetType: 'SCHEDULE_VERSION',
        targetId: v.version_id,
        details: {
          competitionId: v.competition_id,
          proposalHash: plan.proposalHash,
          baseStateIdentity: plan.baseStateIdentity,
          strategyId: plan.strategy.id,
          strategyVersion: plan.strategy.version,
          maxEvaluations: plan.budget.maxEvaluations,
          maxEvaluationsPerUnit: plan.budget.maxEvaluationsPerUnit,
          reportHash: plan.reportHash,
          placedUnits: plan.placedUnits,
          placedContests: plan.placedContests,
          unplacedUnits: plan.unplacedUnits,
        },
      });
      const response = {
        versionId: v.version_id,
        competitionId: v.competition_id,
        proposalHash: plan.proposalHash,
        baseStateIdentity: plan.baseStateIdentity,
        assignmentIds,
        placedContests: plan.placedContests,
      };
      await idem.record(response);
      return { ...response, created: true };
    });
  }

  // ───────────────────────────── drafts ─────────────────────────────

  /** A new DRAFT from the PUBLISHED version (or empty); its assignments are CARRIED copies. */
  private async openDraftTx(ctx: TxContext, competitionId: string, actor: string) {
    const open = await this.currentOf(ctx, competitionId, 'DRAFT');
    if (open !== undefined)
      throw new DomainError(
        DomainErrorCode.ALREADY_EXISTS,
        'the competition already has an open schedule draft',
        { reason: 'DRAFT_OPEN', versionId: open.version_id },
      );
    const base = await this.currentOf(ctx, competitionId, 'PUBLISHED');
    const { rows } = await sql<{ n: number }>`
      SELECT coalesce(max(version_number), 0)::int + 1 AS n FROM competition.schedule_version
      WHERE competition_id = ${competitionId}`.execute(ctx.trx);
    const versionId = newId();
    const versionNumber = rows[0]?.n ?? 1;
    await sql`INSERT INTO competition.schedule_version (id, competition_id, version_number, base_version_id, created_by_account_id, recorded_at)
      VALUES (${versionId}, ${competitionId}, ${versionNumber}, ${base?.version_id ?? null}, ${actor}, ${ctx.txTime})`.execute(
      ctx.trx,
    );
    await sql`INSERT INTO competition.schedule_version_status_change (id, version_id, status, actor_account_id, recorded_at)
      VALUES (${newId()}, ${versionId}, 'DRAFT', ${actor}, ${ctx.txTime})`.execute(ctx.trx);
    if (base !== undefined)
      for (const a of await this.content(ctx, base.version_id))
        if (!a.removed)
          await this.insertFact(ctx, {
            ...a,
            version_id: versionId,
            reason: null,
            replaces_assignment_id: a.id,
            source: 'CARRIED',
            actor_account_id: actor,
          });
    await emitEvent(ctx, {
      eventType: 'ScheduleDraftOpened',
      aggregateType: 'SCHEDULE_VERSION',
      aggregateId: versionId as Uuid,
      payload: { competitionId, versionNumber, baseVersionId: base?.version_id ?? null },
    });
    await recordAudit(ctx, {
      actorAccountId: actor,
      action: 'schedule.draft-opened',
      targetType: 'SCHEDULE_VERSION',
      targetId: versionId,
      details: {
        competitionId,
        versionNumber,
        ...(base === undefined ? {} : { baseVersionId: base.version_id }),
      },
    });
    return { versionId, versionNumber, baseVersionId: base?.version_id ?? null };
  }

  async openDraft(input: {
    actorAccountId: string;
    competitionId: string;
    idempotencyKey: string;
  }) {
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{
        versionId: string;
        versionNumber: number;
        baseVersionId: string | null;
      }>(ctx, {
        command: 'OpenScheduleDraft',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { competitionId: input.competitionId },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      await this.competition(
        ctx,
        input.actorAccountId,
        input.competitionId,
        'COMP_MANAGE_SCHEDULE',
      );
      await lockKeys(ctx, `competition-schedule:${input.competitionId}`);
      const r = await this.openDraftTx(ctx, input.competitionId, input.actorAccountId);
      await idem.record(r);
      return { ...r, created: true };
    });
  }

  // ───────────────────────────── assignments ─────────────────────────────

  /**
   * Record a contest's concrete assignment in an open draft. Structural refusals only: a profile-
   * pinned event needs a resource of the required type; the resource must be this competition's
   * and ACTIVE; instants are whole seconds with end > start; a locked or started contest is not
   * moved; a move needs a reason. Overlaps, capacity, spacing, participants, rest, dependencies,
   * availability and daily limits are NOT checked here (05E-D).
   *
   * `committed`: the proposal fact being applied (05E-F). Its contest must have no live assignment
   * (ADR-0075 § 7, additive only), and the unit key and provisional flag this path derives must
   * equal the hashed placement's; a difference is an internal invariant failure, never written.
   */
  private async setAssignmentTx(
    ctx: TxContext,
    v: VersionRow,
    actor: string,
    contestId: string,
    input: AssignmentInput,
    committed?: ProposalCommitFact,
  ) {
    const start = instantOrThrow(input.startsAt, 'startsAt');
    if (!isWholeSecond(start.getTime()))
      throw new DomainError(DomainErrorCode.INVALID_INPUT, 'startsAt must be a whole second');
    const givenEnd =
      input.expectedEnd === undefined || input.expectedEnd === null
        ? null
        : instantOrThrow(input.expectedEnd, 'expectedEnd');
    if (givenEnd !== null && !isWholeSecond(givenEnd.getTime()))
      throw new DomainError(DomainErrorCode.INVALID_INPUT, 'expectedEnd must be a whole second');
    if (givenEnd !== null && givenEnd <= start)
      throw new DomainError(DomainErrorCode.INVALID_INPUT, 'expectedEnd must follow startsAt');
    if (
      input.changeoverSeconds !== undefined &&
      (!Number.isSafeInteger(input.changeoverSeconds) ||
        input.changeoverSeconds < 0 ||
        input.changeoverSeconds > 86_400)
    )
      throw new DomainError(
        DomainErrorCode.INVALID_INPUT,
        'changeoverSeconds must be an integer 0–86400',
      );
    const location = optionalText(input.locationLabel, 120, 'locationLabel');
    const court = optionalText(input.courtLabel, 40, 'courtLabel');
    const reason =
      input.reason === undefined || input.reason === null
        ? null
        : text(input.reason, 500, 'reason');

    const c = await this.contest(ctx, v.competition_id, contestId);
    const e = await loadEvent(ctx, c.event_id);
    if (!SCHEDULABLE_EVENT.includes(e.status))
      throw new DomainError(
        DomainErrorCode.INVALID_TRANSITION,
        `cannot schedule contests of a ${e.status} event`,
      );
    if (!EDITABLE_CONTEST.includes(c.status))
      throw new DomainError(
        DomainErrorCode.INVALID_TRANSITION,
        `a ${c.status} contest cannot be moved`,
        { reason: 'CONTEST_STARTED_OR_CLOSED' },
      );
    const zone = input.zone ?? (await this.eventZone(ctx, c.event_id));
    const zoneIssue = ianaZoneIssue(zone);
    if (zoneIssue !== undefined)
      throw new DomainError(DomainErrorCode.INVALID_INPUT, `zone: ${zoneIssue}`);
    if (input.venueOrganizationId !== undefined && input.venueOrganizationId !== null) {
      const { rows } = await sql<{ status: string }>`
        SELECT status FROM organizations.v_organization_current WHERE organization_id = ${input.venueOrganizationId}`.execute(
        ctx.trx,
      );
      if (rows[0]?.status !== 'ACTIVE')
        throw new DomainError(
          DomainErrorCode.INVALID_INPUT,
          'venue organization not found or not active',
        );
    }

    const profile = await this.profile(ctx, c.event_id);
    const resolved =
      profile === null
        ? undefined
        : resolveRequirement(profile.spec, {
            contestType: c.contest_type,
            roundType: c.round_type,
            ...(c.stage_primitive === null ? {} : { stagePrimitive: c.stage_primitive }),
          });
    const requirement = resolved?.ok === true ? resolved.requirement : undefined;
    const resourceId = input.resourceId ?? null;
    if (requirement !== undefined && resourceId === null)
      throw new DomainError(
        DomainErrorCode.INVALID_INPUT,
        `the event's scheduling profile requires a ${requirement.resourceType} resource`,
        { reason: 'RESOURCE_REQUIRED', resourceType: requirement.resourceType },
      );
    if (resourceId !== null) {
      if (!UUID.test(resourceId))
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'resource not found');
      const { rows } = await sql<{ competition_id: string; type_code: string; status: string }>`
        SELECT competition_id, type_code, status FROM competition.v_resource_current WHERE resource_id = ${resourceId}`.execute(
        ctx.trx,
      );
      const r = rows[0];
      if (r === undefined) throw new DomainError(DomainErrorCode.NOT_FOUND, 'resource not found');
      if (r.competition_id !== v.competition_id)
        throw new DomainError(
          DomainErrorCode.INVALID_INPUT,
          'the resource belongs to another competition',
          { reason: 'CROSS_COMPETITION' },
        );
      if (r.status !== 'ACTIVE')
        throw new DomainError(DomainErrorCode.INVALID_TRANSITION, 'the resource is RETIRED', {
          reason: 'RESOURCE_RETIRED',
        });
      if (requirement !== undefined && r.type_code !== requirement.resourceType)
        throw new DomainError(
          DomainErrorCode.INVALID_INPUT,
          `the contest requires a ${requirement.resourceType} resource, not ${r.type_code}`,
          { reason: 'RESOURCE_TYPE_MISMATCH' },
        );
    }
    // Concrete values: given, or the profile's write-time defaults (stored, never recomputed later).
    const end =
      givenEnd ??
      (requirement === undefined
        ? null
        : new Date(defaultExpectedEnd(start.getTime(), requirement, c.latest_offset)));
    const changeover = input.changeoverSeconds ?? requirement?.changeoverSeconds ?? 0;

    const before = await this.fact(ctx, v.version_id, contestId);
    const live = before !== undefined && !before.removed ? before : undefined;
    if (live?.locked === true)
      throw new DomainError(
        DomainErrorCode.INVALID_TRANSITION,
        'the assignment is locked; unlock it with a reason first',
        { reason: 'ASSIGNMENT_LOCKED' },
      );
    const next = {
      resource_id: resourceId,
      starts_at: start,
      expected_end: end,
      changeover_seconds: changeover,
    };
    const moved = live !== undefined && placement(live) !== placement(next);
    if (moved && reason === null)
      throw new DomainError(DomainErrorCode.INVALID_INPUT, 'moving an assignment needs a reason', {
        reason: 'REASON_REQUIRED',
      });
    const unitKey = (await this.unitKeys(ctx, c.event_id, profile?.spec)).get(contestId);
    if (unitKey === undefined) throw new Error('unit key not derivable');
    const provisional = await this.provisional(ctx, contestId, c.dynamic);
    if (committed !== undefined) {
      if (live !== undefined)
        throw new Error(
          `proposal commit invariant: contest ${contestId} already has an assignment`,
        );
      if (unitKey !== committed.unitKey || provisional !== committed.provisional)
        throw new Error(
          `proposal commit invariant: contest ${contestId} unit key or provisional flag differs from the proposal`,
        );
    }
    const fact = {
      version_id: v.version_id,
      competition_id: v.competition_id,
      contest_id: contestId,
      ...next,
      zone,
      unit_key: unitKey,
      provisional,
      locked: false,
      removed: false,
      venue_organization_id: input.venueOrganizationId ?? null,
      location_label: location,
      court_label: court,
      reason,
      replaces_assignment_id: before?.id ?? null,
      source: 'MANUAL' as const,
      actor_account_id: actor,
    };
    const assignmentId = await this.insertFact(ctx, fact);
    await emitEvent(ctx, {
      eventType: 'ScheduleAssignmentChanged',
      aggregateType: 'SCHEDULE_VERSION',
      aggregateId: v.version_id as Uuid,
      payload: { contestId, assignmentId, action: live === undefined ? 'SET' : 'MOVE' },
    });
    await recordAudit(ctx, {
      actorAccountId: actor,
      action: live === undefined ? 'schedule.assignment-set' : 'schedule.assignment-moved',
      targetType: 'CONTEST',
      targetId: contestId,
      details: {
        versionId: v.version_id,
        assignmentId,
        startsAt: start.toISOString(),
        ...(resourceId === null ? {} : { resourceId }),
        ...(live === undefined
          ? {}
          : {
              previousStartsAt: live.starts_at.toISOString(),
              ...(live.resource_id === null ? {} : { previousResourceId: live.resource_id }),
            }),
        ...(reason === null ? {} : { reason }),
      },
    });
    return { assignmentId, eventId: c.event_id, status: c.status };
  }

  private async eventZone(ctx: TxContext, eventId: string): Promise<string> {
    const { rows } = await sql<{ timezone: string }>`
      SELECT timezone FROM competition.event_profile WHERE event_id = ${eventId}`.execute(ctx.trx);
    return rows[0]?.timezone ?? 'UTC';
  }

  /**
   * The contest's current fact id in the draft, or null when it has none. Read only after `draft()`
   * took the competition-schedule lock, so a concurrent edit of the same draft has either committed
   * (and is seen) or waits for this transaction (ADR-0070 §9 amendment).
   */
  private async lastFactId(ctx: TxContext, versionId: string, contestId: string) {
    if (!UUID.test(contestId))
      throw new DomainError(DomainErrorCode.NOT_FOUND, 'contest not found');
    return (await this.fact(ctx, versionId, contestId))?.id ?? null;
  }

  async setAssignment(input: {
    actorAccountId: string;
    versionId: string;
    contestId: string;
    assignment: AssignmentInput;
    /** The contest's last fact in the draft, or null for none (ADR-0070 §9 amendment). */
    expectedLastFactId: string | null;
    idempotencyKey: string;
  }) {
    const expected = expectedLastFact(input.expectedLastFactId);
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ assignmentId: string; versionId: string }>(ctx, {
        command: 'SetScheduleAssignment',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: {
          versionId: input.versionId,
          contestId: input.contestId,
          assignment: { ...input.assignment, startsAt: String(input.assignment.startsAt) },
          expectedLastFactId: expected,
        },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      const v = await this.draft(ctx, input.actorAccountId, input.versionId);
      requireLastFact(expected, await this.lastFactId(ctx, v.version_id, input.contestId));
      const r = await this.setAssignmentTx(
        ctx,
        v,
        input.actorAccountId,
        input.contestId,
        input.assignment,
      );
      const response = { assignmentId: r.assignmentId, versionId: v.version_id };
      await idem.record(response);
      return { ...response, created: true };
    });
  }

  /** Remove a draft-only assignment. A published contest's assignment is never removed (v1). */
  async removeAssignment(input: {
    actorAccountId: string;
    versionId: string;
    contestId: string;
    reason: string;
    /** The contest's last fact in the draft, or null for none (ADR-0070 §9 amendment). */
    expectedLastFactId: string | null;
    idempotencyKey: string;
  }) {
    const reason = text(input.reason, 500, 'reason');
    const expected = expectedLastFact(input.expectedLastFactId);
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ assignmentId: string }>(ctx, {
        command: 'RemoveScheduleAssignment',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: {
          versionId: input.versionId,
          contestId: input.contestId,
          reason,
          expectedLastFactId: expected,
        },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      const v = await this.draft(ctx, input.actorAccountId, input.versionId);
      requireLastFact(expected, await this.lastFactId(ctx, v.version_id, input.contestId));
      const before = await this.fact(ctx, v.version_id, input.contestId);
      if (before === undefined || before.removed)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'the contest has no assignment here');
      if (before.locked)
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          'the assignment is locked; unlock it with a reason first',
          { reason: 'ASSIGNMENT_LOCKED' },
        );
      if (v.base_version_id !== null) {
        const pub = await this.fact(ctx, v.base_version_id, input.contestId);
        if (pub !== undefined && !pub.removed)
          throw new DomainError(
            DomainErrorCode.INVALID_TRANSITION,
            'a published assignment cannot be removed; move it in a draft, or cancel the contest',
            { reason: 'PUBLISHED_ASSIGNMENT' },
          );
      }
      const assignmentId = await this.insertFact(ctx, {
        ...before,
        removed: true,
        reason,
        replaces_assignment_id: before.id,
        source: before.source === 'MIGRATED' ? 'CARRIED' : before.source,
        actor_account_id: input.actorAccountId,
      });
      await emitEvent(ctx, {
        eventType: 'ScheduleAssignmentChanged',
        aggregateType: 'SCHEDULE_VERSION',
        aggregateId: v.version_id as Uuid,
        payload: { contestId: input.contestId, assignmentId, action: 'REMOVE' },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'schedule.assignment-removed',
        targetType: 'CONTEST',
        targetId: input.contestId,
        details: { versionId: v.version_id, assignmentId, reason },
      });
      await idem.record({ assignmentId });
      return { assignmentId, created: true };
    });
  }

  /**
   * Lock (reason optional) or unlock (reason required) a draft assignment. Only for a PLANNED or
   * SCHEDULED contest (ADR-0070 §8 amendment): its status is re-read inside this transaction, so a
   * start, completion, cancellation or void committed before it is always refused.
   */
  async setLock(input: {
    actorAccountId: string;
    versionId: string;
    contestId: string;
    locked: boolean;
    reason?: string | null;
    /** The contest's last fact in the draft, or null for none (ADR-0070 §9 amendment). */
    expectedLastFactId: string | null;
    idempotencyKey: string;
  }) {
    const reason =
      input.reason === undefined || input.reason === null
        ? null
        : text(input.reason, 500, 'reason');
    if (!input.locked && reason === null)
      throw new DomainError(DomainErrorCode.INVALID_INPUT, 'unlocking needs a reason', {
        reason: 'REASON_REQUIRED',
      });
    const expected = expectedLastFact(input.expectedLastFactId);
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ assignmentId: string }>(ctx, {
        command: input.locked ? 'LockScheduleAssignment' : 'UnlockScheduleAssignment',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: {
          versionId: input.versionId,
          contestId: input.contestId,
          reason,
          expectedLastFactId: expected,
        },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      const v = await this.draft(ctx, input.actorAccountId, input.versionId);
      requireLastFact(expected, await this.lastFactId(ctx, v.version_id, input.contestId));
      const c = await this.contest(ctx, v.competition_id, input.contestId);
      if (!EDITABLE_CONTEST.includes(c.status))
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          `a ${c.status} contest cannot be ${input.locked ? 'locked' : 'unlocked'}`,
          { reason: 'CONTEST_STARTED_OR_CLOSED' },
        );
      const before = await this.fact(ctx, v.version_id, input.contestId);
      if (before === undefined || before.removed)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'the contest has no assignment here');
      if (before.locked === input.locked)
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          `the assignment is already ${input.locked ? 'locked' : 'unlocked'}`,
        );
      const assignmentId = await this.insertFact(ctx, {
        ...before,
        locked: input.locked,
        reason,
        replaces_assignment_id: before.id,
        source: before.source === 'MIGRATED' ? 'CARRIED' : before.source,
        actor_account_id: input.actorAccountId,
      });
      const action = input.locked ? 'LOCK' : 'UNLOCK';
      await emitEvent(ctx, {
        eventType: 'ScheduleAssignmentChanged',
        aggregateType: 'SCHEDULE_VERSION',
        aggregateId: v.version_id as Uuid,
        payload: { contestId: input.contestId, assignmentId, action },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: input.locked ? 'schedule.assignment-locked' : 'schedule.assignment-unlocked',
        targetType: 'CONTEST',
        targetId: input.contestId,
        details: { versionId: v.version_id, assignmentId, ...(reason === null ? {} : { reason }) },
      });
      await idem.record({ assignmentId });
      return { assignmentId, created: true };
    });
  }

  // ───────────────────────────── publication ─────────────────────────────

  /**
   * Explicit publication by a human holding COMP_MANAGE_SCHEDULE (ADR-0073 B1). Preconditions: the
   * competition is open; the version is the open draft; `baseVersionId` is both the draft's base and
   * the current PUBLISHED version; `reportHash` is the current report over exactly this content; no
   * HARD conflict; the acknowledged keys are exactly the SOFT conflicts' keys. Then, atomically: the
   * previous version SUPERSEDED, this one PUBLISHED, the report recorded, `contest_schedule`
   * projected, newly scheduled contests SCHEDULED, ContestScheduled for new or moved contests only.
   */
  async publish(input: {
    actorAccountId: string;
    versionId: string;
    baseVersionId: string | null;
    reportHash: string;
    acknowledgedConflictKeys: readonly string[];
    idempotencyKey: string;
  }) {
    const acknowledged = [...new Set(input.acknowledgedConflictKeys)].sort();
    const states = await this.targetStates(input.actorAccountId, input.versionId);
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{
        versionId: string;
        supersededVersionId: string | null;
        reportHash: string;
        scheduledContests: number;
      }>(ctx, {
        command: 'PublishScheduleVersion',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: {
          versionId: input.versionId,
          baseVersionId: input.baseVersionId,
          reportHash: input.reportHash,
          acknowledged,
        },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      const v = await this.draft(ctx, input.actorAccountId, input.versionId);
      // G-1: the lifecycle lock of every contest this publication may move PLANNED → SCHEDULED,
      // taken before its status is read again. PLANNED is never re-entered, so a contest that is
      // not PLANNED now is never written here; the loop below re-reads each status under the lock.
      const { rows: planned } = await sql<{ contest_id: string }>`
        SELECT a.contest_id FROM competition.v_schedule_assignment_current a
        JOIN competition.v_contest_current cc ON cc.contest_id = a.contest_id
        WHERE a.version_id = ${v.version_id} AND NOT a.removed AND cc.status = 'PLANNED'`.execute(
        ctx.trx,
      );
      await lockContestLifecycles(
        ctx,
        planned.map((r) => r.contest_id),
      );
      const current = await this.currentOf(ctx, v.competition_id, 'PUBLISHED');
      const currentId = current?.version_id ?? null;
      if (input.baseVersionId !== v.base_version_id || input.baseVersionId !== currentId)
        throw stale(
          'BASE_VERSION_STALE',
          'the published schedule changed since this draft was opened; open a new draft',
        );
      const { report, reportHash } = await this.report(ctx, v, states);
      if (reportHash !== input.reportHash)
        throw stale('REPORT_STALE', 'the draft changed since it was validated; validate it again');
      const verdict = reportVerdict(report);
      if (verdict.hard > 0)
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          'the draft has HARD conflicts and cannot be published',
          { reason: 'HARD_CONFLICTS', hardConflicts: verdict.hard },
        );
      const expected = [...verdict.softKeys];
      const missing = expected.filter((k) => !acknowledged.includes(k));
      const unknown = acknowledged.filter((k) => !expected.includes(k));
      if (missing.length > 0 || unknown.length > 0)
        throw new DomainError(
          DomainErrorCode.INVALID_INPUT,
          'acknowledge exactly the SOFT conflicts of the current report',
          { reason: 'ACKNOWLEDGEMENT_MISMATCH', missing, unknown },
        );

      if (current !== undefined)
        await sql`INSERT INTO competition.schedule_version_status_change (id, version_id, status, actor_account_id, recorded_at)
          VALUES (${newId()}, ${current.version_id}, 'SUPERSEDED', ${input.actorAccountId}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
      await sql`INSERT INTO competition.schedule_version_status_change (id, version_id, status, actor_account_id, recorded_at)
        VALUES (${newId()}, ${v.version_id}, 'PUBLISHED', ${input.actorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await sql`INSERT INTO competition.schedule_publication
          (version_id, competition_id, superseded_version_id, report_hash, report, coverage, acknowledged_conflict_keys,
           actor_account_id, recorded_at)
        VALUES (${v.version_id}, ${v.competition_id}, ${currentId}, ${reportHash}, ${JSON.stringify(report)}::jsonb,
                ${[...report.coverage]}::text[], ${acknowledged}::text[], ${input.actorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );

      // The projection: contest_schedule mirrors the PUBLISHED version.
      const next = (await this.content(ctx, v.version_id)).filter((a) => !a.removed);
      const prev = new Map(
        current === undefined
          ? []
          : (await this.content(ctx, current.version_id))
              .filter((a) => !a.removed)
              .map((a) => [a.contest_id, a] as const),
      );
      const touchedEvents = new Set<string>();
      let scheduledContests = 0;
      for (const a of next) {
        const { rows: cs } = await sql<{ event_id: string; status: string }>`
          SELECT c.event_id, cc.status FROM competition.contest c
          JOIN competition.v_contest_current cc ON cc.contest_id = c.id WHERE c.id = ${a.contest_id}`.execute(
          ctx.trx,
        );
        const c = cs[0];
        if (c === undefined) continue;
        const was = prev.get(a.contest_id);
        const changed = was === undefined || published(was) !== published(a);
        if (changed) {
          await sql`INSERT INTO competition.contest_schedule
              (contest_id, scheduled_start, scheduled_end, venue_organization_id, location_label, court_label, resource_id,
               updated_at, updated_by_account_id)
            VALUES (${a.contest_id}, ${a.starts_at}, ${a.expected_end}, ${a.venue_organization_id}, ${a.location_label},
                    ${a.court_label}, ${a.resource_id}, ${ctx.txTime}, ${input.actorAccountId})
            ON CONFLICT (contest_id) DO UPDATE SET scheduled_start = EXCLUDED.scheduled_start,
              scheduled_end = EXCLUDED.scheduled_end, venue_organization_id = EXCLUDED.venue_organization_id,
              location_label = EXCLUDED.location_label, court_label = EXCLUDED.court_label,
              resource_id = EXCLUDED.resource_id, updated_at = EXCLUDED.updated_at,
              updated_by_account_id = EXCLUDED.updated_by_account_id`.execute(ctx.trx);
          touchedEvents.add(c.event_id);
          scheduledContests += 1;
          await emitEvent(ctx, {
            eventType: 'ContestScheduled',
            aggregateType: 'CONTEST',
            aggregateId: a.contest_id as Uuid,
            payload: {
              eventId: c.event_id,
              scheduledStart: a.starts_at.toISOString(),
              scheduleVersionId: v.version_id,
            },
          });
          await recordAudit(ctx, {
            actorAccountId: input.actorAccountId,
            action: was === undefined ? 'contest.scheduled' : 'contest.rescheduled',
            targetType: 'CONTEST',
            targetId: a.contest_id,
            details: {
              scheduledStart: a.starts_at.toISOString(),
              scheduleVersionId: v.version_id,
              ...(was === undefined ? {} : { previousStart: was.starts_at.toISOString() }),
            },
          });
        }
        // A contest becomes SCHEDULED when it appears in a published version (ADR-0070 §7).
        if (c.status === 'PLANNED') {
          await sql`INSERT INTO competition.contest_status_change (id, contest_id, status, actor_account_id, recorded_at)
            VALUES (${newId()}, ${a.contest_id}, 'SCHEDULED', ${input.actorAccountId}, ${ctx.txTime})`.execute(
            ctx.trx,
          );
          touchedEvents.add(c.event_id);
        }
      }
      for (const eventId of [...touchedEvents].sort()) await refreshEventReadModels(ctx, eventId);

      await emitEvent(ctx, {
        eventType: 'ScheduleVersionPublished',
        aggregateType: 'SCHEDULE_VERSION',
        aggregateId: v.version_id as Uuid,
        payload: {
          competitionId: v.competition_id,
          versionNumber: v.version_number,
          supersededVersionId: currentId,
          reportHash,
        },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'schedule.published',
        targetType: 'SCHEDULE_VERSION',
        targetId: v.version_id,
        details: {
          competitionId: v.competition_id,
          versionNumber: v.version_number,
          ...(currentId === null ? {} : { supersededVersionId: currentId }),
          reportHash,
          coverage: [...report.coverage],
          acknowledgedConflictKeys: acknowledged,
          scheduledContests,
        },
      });
      const response = {
        versionId: v.version_id,
        supersededVersionId: currentId,
        reportHash,
        scheduledContests,
      };
      await idem.record(response);
      return { ...response, created: true };
    });
  }

  /** DRAFT → DISCARDED (terminal: a discarded draft is never reopened). */
  async discard(input: {
    actorAccountId: string;
    versionId: string;
    reason: string;
    idempotencyKey: string;
  }) {
    const reason = text(input.reason, 500, 'reason');
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ versionId: string }>(ctx, {
        command: 'DiscardScheduleDraft',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { versionId: input.versionId, reason },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      const v = await this.draft(ctx, input.actorAccountId, input.versionId);
      await sql`INSERT INTO competition.schedule_version_status_change (id, version_id, status, reason, actor_account_id, recorded_at)
        VALUES (${newId()}, ${v.version_id}, 'DISCARDED', ${reason}, ${input.actorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await emitEvent(ctx, {
        eventType: 'ScheduleDraftDiscarded',
        aggregateType: 'SCHEDULE_VERSION',
        aggregateId: v.version_id as Uuid,
        payload: { competitionId: v.competition_id },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'schedule.draft-discarded',
        targetType: 'SCHEDULE_VERSION',
        targetId: v.version_id,
        details: { competitionId: v.competition_id, reason },
      });
      await idem.record({ versionId: v.version_id });
      return { versionId: v.version_id, created: true };
    });
  }

  // ───────────────────────────── the legacy route ─────────────────────────────

  /**
   * `POST /v1/contests/:id/schedule` (BRT-05): now edits the competition's open DRAFT — opening one
   * from the published version when none is open — and never publishes. Moving an existing
   * assignment needs a reason. The contest becomes SCHEDULED only when a version containing it is
   * published.
   *
   * The stated last fact (ADR-0070 §9 amendment) is the contest's current fact in the open draft.
   * When this command opens the draft itself, the client could only have seen the PUBLISHED
   * version, so the expectation is the published fact its CARRIED copy replaces, or none.
   */
  async scheduleContest(input: {
    actorAccountId: string;
    contestId: string;
    scheduledStart: Date | string;
    scheduledEnd?: Date | string | null;
    resourceId?: string | null;
    venueOrganizationId?: string | null;
    locationLabel?: string | null;
    courtLabel?: string | null;
    reason?: string | null;
    expectedLastFactId: string | null;
    idempotencyKey: string;
  }) {
    const expected = expectedLastFact(input.expectedLastFactId);
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{
        contestId: string;
        status: string;
        versionId: string;
        assignmentId: string;
      }>(ctx, {
        command: 'ScheduleContest',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: {
          contestId: input.contestId,
          start: String(input.scheduledStart),
          end:
            input.scheduledEnd === undefined || input.scheduledEnd === null
              ? undefined
              : String(input.scheduledEnd),
          resource: input.resourceId ?? undefined,
          venue: input.venueOrganizationId ?? undefined,
          location: input.locationLabel ?? undefined,
          court: input.courtLabel ?? undefined,
          reason: input.reason ?? undefined,
          expectedLastFactId: expected,
        },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      if (!UUID.test(input.contestId))
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'contest not found');
      const { rows } = await sql<{ competition_id: string }>`
        SELECT e.competition_id FROM competition.contest c JOIN competition.event e ON e.id = c.event_id
        WHERE c.id = ${input.contestId}`.execute(ctx.trx);
      const competitionId = rows[0]?.competition_id;
      if (competitionId === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'contest not found');
      await this.competition(ctx, input.actorAccountId, competitionId, 'COMP_MANAGE_SCHEDULE');
      await lockKeys(ctx, `competition-schedule:${competitionId}`);
      const existing = (await this.currentOf(ctx, competitionId, 'DRAFT'))?.version_id;
      const open =
        existing ?? (await this.openDraftTx(ctx, competitionId, input.actorAccountId)).versionId;
      const v = await this.draft(ctx, input.actorAccountId, open);
      // A draft opened by this command holds only CARRIED copies; each replaces its published fact.
      const current = await this.fact(ctx, v.version_id, input.contestId);
      requireLastFact(
        expected,
        existing === undefined ? (current?.replaces_assignment_id ?? null) : (current?.id ?? null),
      );
      const r = await this.setAssignmentTx(ctx, v, input.actorAccountId, input.contestId, {
        startsAt: input.scheduledStart,
        expectedEnd: input.scheduledEnd ?? null,
        resourceId: input.resourceId ?? null,
        venueOrganizationId: input.venueOrganizationId ?? null,
        locationLabel: input.locationLabel ?? null,
        courtLabel: input.courtLabel ?? null,
        reason: input.reason ?? null,
      });
      const response = {
        contestId: input.contestId,
        status: r.status,
        versionId: v.version_id,
        assignmentId: r.assignmentId,
      };
      await idem.record(response);
      return { ...response, created: true };
    });
  }
}
