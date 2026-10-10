import {
  baselineScheduleReport,
  canonicalScheduleReport,
  conflictKey,
  defaultExpectedEnd,
  deriveUnitKeys,
  ianaZoneIssue,
  isWholeSecond,
  reportVerdict,
  resolveRequirement,
  scheduleDigest,
  scheduleReportHash,
  type BaselineAssignment,
  type BaselineEvent,
  type ContestType,
  type OccupancyMode,
  type RoundType,
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
  optionalText,
  requireCompPermission,
  text,
  type CompetitionRow,
} from './competition-support';
import { refreshEventReadModels } from './competition-projection';
import type { Db } from './db';
import { identityIdempotency, lockKeys, recordAudit } from './identity-support';
import { emitEvent } from './outbox';
import { inTransaction, ModuleRole, type TxContext } from './tx';

/**
 * ONCF-05E-C schedule model (ADR-0070, ADR-0071 contract, ADR-0073): competition schedule versions
 * (private DRAFT → validated PUBLISHED → SUPERSEDED; DRAFT → DISCARDED, terminal), append-only
 * per-contest assignments (at most one resource each, concrete interval, stored changeover, derived
 * unit key, provisional / locked flags), explicit human publication against the canonical conflict
 * report, and `contest_schedule` as the projection of the PUBLISHED version.
 *
 * This store never judges feasibility: overlap, capacity, start spacing, concurrency, participants,
 * rest, dependency lead, availability and daily limits are the 05E-D engine's. It refuses only
 * structurally invalid writes, and publication runs the validator in force (the 05E-C baseline,
 * whose report declares exactly what it covers). Nothing here branches on sport identity.
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

export class ScheduleStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
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

  /** Unit keys of every contest of an event (ADR-0073 B9), from plan, 05D and profile data. */
  private async unitKeys(
    ctx: TxContext,
    eventId: string,
    spec: SchedulingProfileSpec | undefined,
  ): Promise<Map<string, string>> {
    const { rows } = await sql<{
      contest_id: string;
      round_id: string;
      round_sequence: number;
      stage_id: string | null;
      grouped: boolean;
      dynamic: boolean;
      partition_key: string | null;
      participant_id: string | null;
      field_ordinal: number | null;
    }>`
      SELECT c.id AS contest_id, c.round_id, r.sequence AS round_sequence, r.stage_id,
             coalesce(st.partition_method = 'GROUPED_ENTRANTS', false) AS grouped,
             r.dynamic_transition_key IS NOT NULL AS dynamic, c.partition_key,
             one.participant_id, one.field_ordinal
      FROM competition.contest c
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
      WHERE c.event_id = ${eventId}`.execute(ctx.trx);
    const facts: UnitContestFacts[] = rows.map((r) => ({
      contestId: r.contest_id,
      roundId: r.round_id,
      roundSequence: r.round_sequence,
      stageId: r.stage_id,
      grouped: r.grouped,
      dynamic: r.dynamic,
      partitionKey: r.partition_key,
      participantId: r.participant_id,
      fieldOrdinal: r.field_ordinal,
    }));
    return deriveUnitKeys(facts, spec?.regrouping);
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
   * The canonical report over exactly the version's current content. In 05E-C the validator in force
   * is the baseline (structural checks only, declared as coverage); 05E-D replaces it behind the
   * same contract.
   */
  private async report(ctx: TxContext, v: VersionRow) {
    const facts = await this.content(ctx, v.version_id);
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
      WHERE e.competition_id = ${v.competition_id} ORDER BY e.id`.execute(ctx.trx);
    const events = new Map<string, BaselineEvent>();
    const eventInputs = [];
    for (const e of evs) {
      const profile = await this.profile(ctx, e.event_id);
      events.set(e.event_id, {
        profile: profile === null ? null : { versionId: profile.versionId, spec: profile.spec },
        windowStartMs: e.starts_at?.getTime() ?? null,
        windowEndMs: e.ends_at?.getTime() ?? null,
      });
      eventInputs.push({
        eventId: e.event_id,
        profileVersionId: profile?.versionId ?? null,
        specHash: profile?.specHash ?? null,
        timezone: e.timezone,
        windowStart: e.starts_at === null ? null : Math.floor(e.starts_at.getTime() / 1000),
        windowEnd: e.ends_at === null ? null : Math.floor(e.ends_at.getTime() / 1000),
      });
    }
    const live = facts.filter((a) => !a.removed);
    const { rows: shape } = await sql<{
      contest_id: string;
      event_id: string;
      contest_type: ContestType;
      round_type: RoundType;
      stage_primitive: StagePrimitive | null;
      type_code: string | null;
      occupancy_mode: OccupancyMode | null;
    }>`
      SELECT c.id AS contest_id, c.event_id, c.contest_type, r.round_type, st.primitive AS stage_primitive,
             rc.type_code, rc.occupancy_mode
      FROM competition.v_schedule_assignment_current a
      JOIN competition.contest c ON c.id = a.contest_id
      JOIN competition.round r ON r.id = c.round_id
      LEFT JOIN competition.stage st ON st.id = r.stage_id
      LEFT JOIN competition.v_resource_current rc ON rc.resource_id = a.resource_id
      WHERE a.version_id = ${v.version_id}`.execute(ctx.trx);
    const byContest = new Map(shape.map((s) => [s.contest_id, s]));
    const assignments: BaselineAssignment[] = live.map((a) => {
      const s = byContest.get(a.contest_id);
      if (s === undefined) throw new Error('assignment without contest');
      return {
        assignmentId: a.id,
        contestId: a.contest_id,
        eventId: s.event_id,
        unitKey: a.unit_key,
        resourceId: a.resource_id,
        resourceType: s.type_code,
        occupancyMode: s.occupancy_mode,
        startMs: a.starts_at.getTime(),
        expectedEndMs: a.expected_end?.getTime() ?? null,
        changeoverSeconds: a.changeover_seconds,
        contest: {
          contestType: s.contest_type,
          roundType: s.round_type,
          ...(s.stage_primitive === null ? {} : { stagePrimitive: s.stage_primitive }),
        },
      };
    });
    const { rows: revisions } = await sql<{ revision_id: string }>`
      SELECT revision_id FROM competition.v_resource_current WHERE competition_id = ${v.competition_id}`.execute(
      ctx.trx,
    );
    const { rows: avail } = await sql<{ id: string }>`
      SELECT id FROM competition.v_resource_availability_current WHERE competition_id = ${v.competition_id}`.execute(
      ctx.trx,
    );
    const { rows: occ } = await sql<{
      contest_id: string;
      place: number;
      participant_id: string | null;
    }>`
      SELECT o.contest_id, o.place, o.participant_id FROM competition.v_contest_occupant o
      JOIN competition.contest c ON c.id = o.contest_id JOIN competition.event e ON e.id = c.event_id
      WHERE e.competition_id = ${v.competition_id} ORDER BY o.contest_id, o.place`.execute(ctx.trx);
    const { rows: statuses } = await sql<{ contest_id: string; status: string }>`
      SELECT cc.contest_id, cc.status FROM competition.v_contest_current cc
      JOIN competition.contest c ON c.id = cc.contest_id JOIN competition.event e ON e.id = c.event_id
      WHERE e.competition_id = ${v.competition_id}`.execute(ctx.trx);
    const report = canonicalScheduleReport(
      baselineScheduleReport({
        competitionId: v.competition_id,
        scheduleVersionId: v.version_id,
        assignments,
        events,
        inputs: {
          events: eventInputs,
          resourceRevisionIds: revisions.map((r) => r.revision_id),
          availabilityFactIds: avail.map((r) => r.id),
          occupancyDigest: scheduleDigest(
            'br:schedule-occupancy',
            occ.map((o) => [o.contest_id, o.place, o.participant_id ?? '']),
          ),
          contestStatuses: statuses.map((s) => ({ contestId: s.contest_id, status: s.status })),
        },
      }),
    );
    // The watermark covers every current fact, removals included: a removal is content.
    const withWatermark = canonicalScheduleReport({
      ...report,
      assignmentIds: facts.map((a) => a.id),
    });
    return { report: withWatermark, reportHash: scheduleReportHash(withWatermark) };
  }

  /** The report the publish command would check, with its hash and acknowledgement keys. */
  async validate(input: { actorAccountId: string; versionId: string }) {
    return this.tx(async (ctx) => {
      const v = await this.version(ctx, input.versionId);
      await this.competition(ctx, input.actorAccountId, v.competition_id, 'COMP_MANAGE_SCHEDULE');
      const { report, reportHash } = await this.report(ctx, v);
      const verdict = reportVerdict(report);
      return {
        reportHash,
        report,
        hardConflicts: verdict.hard,
        conflicts: report.conflicts.map((c) => ({ conflictKey: conflictKey(c), ...c })),
      };
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
   */
  private async setAssignmentTx(
    ctx: TxContext,
    v: VersionRow,
    actor: string,
    contestId: string,
    input: AssignmentInput,
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
    const fact = {
      version_id: v.version_id,
      competition_id: v.competition_id,
      contest_id: contestId,
      ...next,
      zone,
      unit_key: unitKey,
      provisional: await this.provisional(ctx, contestId, c.dynamic),
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

  async setAssignment(input: {
    actorAccountId: string;
    versionId: string;
    contestId: string;
    assignment: AssignmentInput;
    idempotencyKey: string;
  }) {
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ assignmentId: string; versionId: string }>(ctx, {
        command: 'SetScheduleAssignment',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: {
          versionId: input.versionId,
          contestId: input.contestId,
          assignment: { ...input.assignment, startsAt: String(input.assignment.startsAt) },
        },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      const v = await this.draft(ctx, input.actorAccountId, input.versionId);
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
    idempotencyKey: string;
  }) {
    const reason = text(input.reason, 500, 'reason');
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ assignmentId: string }>(ctx, {
        command: 'RemoveScheduleAssignment',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { versionId: input.versionId, contestId: input.contestId, reason },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      const v = await this.draft(ctx, input.actorAccountId, input.versionId);
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

  /** Lock (reason optional) or unlock (reason required) a draft assignment. */
  async setLock(input: {
    actorAccountId: string;
    versionId: string;
    contestId: string;
    locked: boolean;
    reason?: string | null;
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
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ assignmentId: string }>(ctx, {
        command: input.locked ? 'LockScheduleAssignment' : 'UnlockScheduleAssignment',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { versionId: input.versionId, contestId: input.contestId, reason },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      const v = await this.draft(ctx, input.actorAccountId, input.versionId);
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
      const current = await this.currentOf(ctx, v.competition_id, 'PUBLISHED');
      const currentId = current?.version_id ?? null;
      if (input.baseVersionId !== v.base_version_id || input.baseVersionId !== currentId)
        throw stale(
          'BASE_VERSION_STALE',
          'the published schedule changed since this draft was opened; open a new draft',
        );
      const { report, reportHash } = await this.report(ctx, v);
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
    idempotencyKey: string;
  }) {
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
      const open =
        (await this.currentOf(ctx, competitionId, 'DRAFT'))?.version_id ??
        (await this.openDraftTx(ctx, competitionId, input.actorAccountId)).versionId;
      const v = await this.draft(ctx, input.actorAccountId, open);
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
