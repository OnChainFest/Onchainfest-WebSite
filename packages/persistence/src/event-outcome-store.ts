import type {
  ContestStatus,
  EventStatus,
  NormalizedContestResult,
  PublicEntrantDisplay,
} from '@br/competition';
import { DomainError, DomainErrorCode } from '@br/domain';
import {
  eventOutcome,
  podium,
  type ClassificationPolicyV2Spec,
  type EventOutcome,
  type EventOutcomeContest,
  type EventOutcomeInput,
  type EventOutcomeKind,
} from '@br/rankings';
import { sql } from 'kysely';
import { loadCompetition, loadEvent, requireCompPermission } from './competition-support';
import type { Db } from './db';
import { currentPin, type ScoringStore } from './scoring-store';
import { inTransaction, ModuleRole, withModuleRole, type TxContext } from './tx';

/**
 * ONCF-L6 event outcome (ADR-0078). Nothing here is persisted: the outcome of a category is
 * derived on read by `event-outcome/1` from the immutable stage graph, the CURRENT contest results
 * at the OFFICIAL floor (OFFICIAL or FINAL; never the template's PROVISIONAL default) and the
 * final stage's classification-engine/2 document at that same floor.
 *
 *  · settlement  `eventSettlementIn` — every contest of the event, its status and its CURRENT result
 *                version, read inside the caller's transaction (category completion holds every
 *                contest lock while it reads it). The fingerprint lets completion prove that the
 *                outcome it computed beforehand read exactly the state it now holds under its locks.
 *  · derive      the outcome, with a fail-closed cross-check: every result the outcome read must be
 *                the contest's current OFFICIAL / FINAL version (CONCURRENCY_CONFLICT otherwise).
 *  · publicEvent / publicCompetition  OFFICIAL-only public DTOs; the caller gates DRAFT (404) and
 *                supplies public-safe displays. No version ids, provenance, holds or evidence; a
 *                contest below the floor carries no outcome and never says why. The podium is
 *                withheld until the category is COMPLETED.
 *  · staff       the full outcome plus completion readiness (COMP_VIEW_PRIVATE).
 * Structure is read as br_competition and results as br_results (`withModuleRole`), as ScoringStore.
 */

export const PUBLIC_EVENT_OUTCOME_SCHEMA = 'br:public-event-outcome@1';
export const PUBLIC_COMPETITION_OUTCOME_SCHEMA = 'br:public-competition-outcome@1';

const OFFICIAL = new Set(['OFFICIAL', 'FINAL']);
const OPEN_CONTEST = new Set(['PLANNED', 'SCHEDULED', 'IN_PROGRESS']);
const SETTLED_CONTEST = new Set(['CANCELLED', 'VOID']);

export interface EventSettlement {
  readonly contests: readonly {
    readonly contestId: string;
    readonly status: ContestStatus;
    readonly currentVersionId: string | null;
    readonly currentStatus: string | null;
  }[];
  /** PLANNED, SCHEDULED or IN_PROGRESS contests (contest id order). */
  readonly open: readonly string[];
  /** COMPLETED contests whose current result is missing or below OFFICIAL. */
  readonly notOfficial: readonly string[];
  /** Contests that need a result (not CANCELLED / VOID) and how many of them are OFFICIAL. */
  readonly required: number;
  readonly official: number;
  /** Every contest's status and current version, in contest id order. */
  readonly fingerprint: string;
}

/**
 * The settlement of one event inside the caller's br_competition transaction (results are read as
 * br_results through `withModuleRole`). Plain reads: the caller decides which locks it holds.
 */
export async function eventSettlementIn(ctx: TxContext, eventId: string): Promise<EventSettlement> {
  const { rows: contests } = await sql<{ id: string; status: ContestStatus }>`
    SELECT c.id, cur.status FROM competition.contest c
    JOIN competition.v_contest_current cur ON cur.contest_id = c.id
    WHERE c.event_id = ${eventId} ORDER BY c.id`.execute(ctx.trx);
  const ids = contests.map((c) => c.id);
  const current = await withModuleRole(ctx, ModuleRole.results, async (rctx) => {
    const { rows } = await sql<{
      contest_id: string;
      version_id: string | null;
      status: string | null;
    }>`
      SELECT r.scope_target_id AS contest_id, rs.current_version_id AS version_id, st.current_status AS status
      FROM results.result r
      JOIN results.result_state rs ON rs.result_id = r.id
      LEFT JOIN results.result_version_state st ON st.result_version_id = rs.current_version_id
      WHERE r.scope_type = 'CONTEST' AND r.scope_target_id = ANY(${ids}::uuid[])
      ORDER BY r.scope_target_id, r.recorded_at DESC, r.id DESC`.execute(rctx.trx);
    const out = new Map<string, { version_id: string | null; status: string | null }>();
    for (const r of rows) if (!out.has(r.contest_id)) out.set(r.contest_id, r);
    return out;
  });
  const rows = contests.map((c) => {
    const r = current.get(c.id);
    return {
      contestId: c.id,
      status: c.status,
      currentVersionId: r?.version_id ?? null,
      currentStatus: r?.version_id === null ? null : (r?.status ?? null),
    };
  });
  const isOfficial = (r: (typeof rows)[number]) =>
    r.currentStatus !== null && OFFICIAL.has(r.currentStatus);
  return {
    contests: rows,
    open: rows.filter((r) => OPEN_CONTEST.has(r.status)).map((r) => r.contestId),
    notOfficial: rows
      .filter((r) => r.status === 'COMPLETED' && !isOfficial(r))
      .map((r) => r.contestId),
    required: rows.filter((r) => !SETTLED_CONTEST.has(r.status)).length,
    official: rows.filter((r) => !SETTLED_CONTEST.has(r.status) && isOfficial(r)).length,
    fingerprint: rows
      .map(
        (r) => `${r.contestId}:${r.status}:${r.currentVersionId ?? '-'}:${r.currentStatus ?? '-'}`,
      )
      .join('|'),
  };
}

interface Structure {
  readonly eventId: string;
  readonly competitionId: string;
  readonly status: EventStatus;
  readonly stages: EventOutcomeInput['stages'];
  readonly transitions: EventOutcomeInput['transitions'];
  readonly rounds: readonly {
    readonly key: string;
    readonly sequence: number;
    readonly type: string;
    readonly label: string;
    readonly stageKey: string | null;
    readonly groupKey: string | null;
    readonly dynamic: boolean;
  }[];
  readonly contests: readonly {
    readonly id: string;
    readonly sequence: number;
    readonly roundKey: string;
    readonly status: ContestStatus;
    readonly occupants: readonly (string | null)[];
    readonly vacant: boolean;
    readonly feeders: EventOutcomeContest['feeders'];
  }[];
  /** The final stage's classification template spec (with its per-stage override), if pinned. */
  readonly finalPolicy?: ClassificationPolicyV2Spec;
  readonly settlement: EventSettlement;
}

export interface DerivedEventOutcome {
  readonly eventId: string;
  readonly competitionId: string;
  readonly eventStatus: EventStatus;
  readonly outcome: EventOutcome;
  readonly settlement: EventSettlement;
  /** Every contest in round / plan order with its official result (absent below OFFICIAL). */
  readonly contests: readonly {
    readonly contestId: string;
    readonly sequence: number;
    readonly roundLabel: string;
    readonly roundSequence: number;
    readonly stageKey: string | null;
    readonly groupKey: string | null;
    readonly status: ContestStatus;
    readonly occupants: readonly (string | null)[];
    readonly official?: NormalizedContestResult;
  }[];
}

export interface PublicPlacement {
  readonly participantId: string;
  readonly display: PublicEntrantDisplay;
  readonly position: number;
  readonly tied: boolean;
}

export interface PublicEventOutcomeV1 {
  readonly schema: typeof PUBLIC_EVENT_OUTCOME_SCHEMA;
  readonly event: { readonly id: string; readonly status: EventStatus };
  /** The category is COMPLETED: its outcome is settled and its results are frozen. */
  readonly final: boolean;
  /** Official results are declared by the organizer's result authority, not independently verified. */
  readonly authority: 'ORGANIZER_DECLARED';
  readonly kind: EventOutcomeKind | null;
  readonly podium:
    | { readonly status: 'AVAILABLE'; readonly placements: readonly PublicPlacement[] }
    | {
        readonly status: 'NOT_AVAILABLE';
        readonly reason:
          | 'EVENT_NOT_COMPLETED'
          | 'EVENT_CANCELLED'
          | 'NO_CHAMPION_ACROSS_GROUPS'
          | 'FORMAT_NOT_SUPPORTED'
          | 'OUTCOME_UNDECIDED';
      };
  /** Official standings ("so far" until `final`). */
  readonly standings: readonly {
    readonly groupKey: string | null;
    readonly complete: boolean;
    readonly entries: readonly {
      readonly participantId: string;
      readonly display: PublicEntrantDisplay;
      readonly position: number;
      readonly tied: boolean;
      readonly status: string;
      readonly values: readonly { readonly key: string; readonly value: string }[];
    }[];
  }[];
  /** Every contest; only an OFFICIAL / FINAL current result carries an outcome. */
  readonly matches: readonly {
    readonly contestId: string;
    readonly sequence: number;
    readonly roundLabel: string;
    readonly roundSequence: number;
    readonly groupKey: string | null;
    readonly status: ContestStatus;
    readonly official: boolean;
    readonly entrants: readonly {
      readonly participantId: string;
      readonly display: PublicEntrantDisplay;
      readonly outcome: string | null;
      readonly score: readonly { readonly key: string; readonly value: string }[];
    }[];
  }[];
  /** Outcome notes a reader needs (a tie no lot separated; groups without a champion). */
  readonly notes: readonly ('TIE_UNBROKEN_LOT' | 'GROUPS_NO_CHAMPION')[];
}

export interface PublicCompetitionOutcomeV1 {
  readonly schema: typeof PUBLIC_COMPETITION_OUTCOME_SCHEMA;
  readonly competition: { readonly id: string; readonly status: string };
  readonly authority: 'ORGANIZER_DECLARED';
  readonly events: readonly {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly status: EventStatus;
    readonly final: boolean;
    readonly kind: EventOutcomeKind | null;
    /** Position-1 placements of a COMPLETED, decided category (several when tied); else null. */
    readonly champions: readonly PublicPlacement[] | null;
  }[];
}

export interface EventReadiness {
  readonly ready: boolean;
  readonly contestsOpen: readonly string[];
  readonly resultsNotOfficial: readonly string[];
  readonly required: number;
  readonly official: number;
}

const PRIVATE: PublicEntrantDisplay = { kind: 'PRIVATE_ENTRANT' };

export class EventOutcomeStore {
  private readonly db: Db;
  private readonly scoring: ScoringStore;

  constructor(db: Db, scoring: ScoringStore) {
    this.db = db;
    this.scoring = scoring;
  }

  private async structure(eventId: string): Promise<Structure> {
    return inTransaction(this.db, ModuleRole.competition, async (ctx) => {
      const e = await loadEvent(ctx, eventId);
      const { rows: stages } = await sql<{
        id: string;
        key: string;
        sequence: number;
        primitive: string;
      }>`
        SELECT id, plan_key AS key, sequence, primitive FROM competition.stage WHERE event_id = ${e.id} ORDER BY sequence`.execute(
        ctx.trx,
      );
      const stageKey = new Map(stages.map((s) => [s.id, s.key]));
      const { rows: transitions } = await sql<{
        kind: string;
        from_stage_id: string;
        to_stage_id: string;
      }>`
        SELECT kind, from_stage_id, to_stage_id FROM competition.stage_transition WHERE event_id = ${e.id} ORDER BY plan_key`.execute(
        ctx.trx,
      );
      const { rows: rounds } = await sql<{
        id: string;
        key: string;
        sequence: number;
        round_type: string;
        label: string;
        stage_id: string | null;
        group_key: string | null;
        dynamic: boolean;
      }>`SELECT id, plan_key AS key, sequence, round_type, label, stage_id, group_key,
                dynamic_transition_key IS NOT NULL AS dynamic
         FROM competition.round WHERE event_id = ${e.id} ORDER BY sequence`.execute(ctx.trx);
      const roundKey = new Map(rounds.map((r) => [r.id, r.key]));
      const { rows: contests } = await sql<{
        id: string;
        sequence: number;
        round_id: string;
        status: ContestStatus;
      }>`SELECT c.id, c.sequence, c.round_id, cur.status
         FROM competition.contest c JOIN competition.v_contest_current cur ON cur.contest_id = c.id
         WHERE c.event_id = ${e.id} ORDER BY c.sequence`.execute(ctx.trx);
      // Places in order: dependent / participant slots (null = unresolved or decided vacant), then
      // field entries.
      const { rows: places } = await sql<{
        contest_id: string;
        place: number;
        participant_id: string | null;
        vacant: boolean;
      }>`
        SELECT o.contest_id, o.place, o.participant_id, (o.participant_id IS NULL AND o.assignment_id IS NOT NULL) AS vacant
        FROM competition.v_contest_occupant o JOIN competition.contest c ON c.id = o.contest_id WHERE c.event_id = ${e.id}
        UNION ALL
        SELECT ce.contest_id, ce.start_order, ce.participant_id, false FROM competition.contest_entry ce
        JOIN competition.contest c ON c.id = ce.contest_id WHERE c.event_id = ${e.id}
        ORDER BY 1, 2`.execute(ctx.trx);
      const { rows: feeders } = await sql<{
        contest_id: string;
        source_kind: 'WINNER_OF_CONTEST' | 'LOSER_OF_CONTEST';
        source_contest_id: string;
      }>`
        SELECT ct.contest_id, ct.source_kind, ct.source_contest_id FROM competition.contestant ct
        JOIN competition.contest c ON c.id = ct.contest_id
        WHERE c.event_id = ${e.id} AND ct.source_kind IN ('WINNER_OF_CONTEST', 'LOSER_OF_CONTEST')
          AND ct.source_contest_id IS NOT NULL
        ORDER BY ct.contest_id, ct.slot`.execute(ctx.trx);
      const placesOf = new Map<string, { participant: string | null; vacant: boolean }[]>();
      for (const p of places) {
        const list = placesOf.get(p.contest_id) ?? [];
        list.push({ participant: p.participant_id, vacant: p.vacant });
        placesOf.set(p.contest_id, list);
      }
      const finalStage = stages.at(-1);
      let finalPolicy: ClassificationPolicyV2Spec | undefined;
      const pin = await currentPin(ctx, e.id);
      const templateId =
        finalStage === undefined || pin === undefined
          ? null
          : (pin.stageOverrides[finalStage.key]?.classificationTemplateVersionId ??
            pin.classificationTemplateVersionId);
      if (templateId !== null) {
        const { rows } = await sql<{ spec: ClassificationPolicyV2Spec }>`
          SELECT spec FROM sports.classification_template_version WHERE id = ${templateId}`.execute(
          ctx.trx,
        );
        finalPolicy = rows[0]?.spec;
      }
      return {
        eventId: e.id,
        competitionId: e.competitionId,
        status: e.status,
        stages: stages.map((s) => ({
          key: s.key,
          sequence: s.sequence,
          primitive: s.primitive as EventOutcomeInput['stages'][number]['primitive'],
        })),
        transitions: transitions.map((t) => ({
          kind: t.kind,
          fromStage: stageKey.get(t.from_stage_id) as string,
          toStage: stageKey.get(t.to_stage_id) as string,
        })),
        rounds: rounds.map((r) => ({
          key: r.key,
          sequence: r.sequence,
          type: r.round_type,
          label: r.label,
          stageKey: r.stage_id === null ? null : (stageKey.get(r.stage_id) ?? null),
          groupKey: r.group_key,
          dynamic: r.dynamic,
        })),
        contests: contests.map((c) => {
          const list = placesOf.get(c.id) ?? [];
          return {
            id: c.id,
            sequence: c.sequence,
            roundKey: roundKey.get(c.round_id) as string,
            status: c.status,
            occupants: list.map((p) => p.participant),
            vacant: list.some((p) => p.vacant),
            feeders: feeders
              .filter((f) => f.contest_id === c.id)
              .map((f) => ({ kind: f.source_kind, contestId: f.source_contest_id })),
          };
        }),
        ...(finalPolicy === undefined ? {} : { finalPolicy }),
        settlement: await eventSettlementIn(ctx, e.id),
      };
    });
  }

  /** Current OFFICIAL / FINAL evidence; an event without pinned scoring has none. */
  private async evidence(contestIds: readonly string[]) {
    try {
      return (await this.scoring.contestEvidence(contestIds, 'OFFICIAL')).admissible;
    } catch (err) {
      if (err instanceof DomainError && err.details.reason === 'SCORING_NOT_PINNED')
        return new Map();
      throw err;
    }
  }

  /** Final-stage classification(s) at the OFFICIAL floor; none when no template is pinned. */
  private async classifications(s: Structure): Promise<EventOutcomeInput['classifications']> {
    const finalStage = s.stages.at(-1);
    if (
      finalStage === undefined ||
      finalStage.primitive === 'KNOCKOUT' ||
      s.finalPolicy === undefined
    )
      return [];
    const groups = [
      ...new Set(
        s.rounds.flatMap((r) =>
          r.stageKey === finalStage.key && r.groupKey !== null ? [r.groupKey] : [],
        ),
      ),
    ].sort();
    const out = [];
    for (const groupKey of groups.length > 0 ? groups : [undefined]) {
      try {
        const c = await this.scoring.classificationAt({
          eventId: s.eventId,
          stageKey: finalStage.key,
          ...(groupKey === undefined ? {} : { groupKey }),
          floor: 'OFFICIAL',
        });
        out.push({
          ...(groupKey === undefined ? {} : { groupKey }),
          policy: s.finalPolicy,
          document: c.document,
        });
      } catch (err) {
        const reason = err instanceof DomainError ? err.details.reason : undefined;
        if (reason === 'TEMPLATE_NOT_PINNED' || reason === 'SCORING_NOT_PINNED') return [];
        throw err;
      }
    }
    return out;
  }

  /**
   * The outcome of one event and the settlement it was read against. NOT authorization-checked:
   * the public routes gate DRAFT first, the staff read checks COMP_VIEW_PRIVATE, and category
   * completion re-reads the settlement under its locks.
   */
  async derive(eventId: string): Promise<DerivedEventOutcome> {
    // A declaration or correction landing between the reads is retried a few times (reads only).
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.deriveOnce(eventId);
      } catch (err) {
        const changed =
          err instanceof DomainError && err.details.reason === 'OUTCOME_INPUTS_CHANGED';
        if (!changed || attempt >= 3) throw err;
      }
    }
  }

  private async deriveOnce(eventId: string): Promise<DerivedEventOutcome> {
    const s = await this.structure(eventId);
    // A CANCELLED or VOID contest decides nothing: a result it carries is never read as evidence,
    // so it reaches neither a placement nor the public match list (ONCF-V1 hardening).
    const ids = s.contests.filter((c) => !SETTLED_CONTEST.has(c.status)).map((c) => c.id);
    const evidence = await this.evidence(ids);
    const classifications = await this.classifications(s);
    // Fail closed: every result read is the contest's current OFFICIAL / FINAL version of the
    // settlement (a correction or declaration in between is a concurrency conflict, never mixed).
    const current = new Map(s.settlement.contests.map((c) => [c.contestId, c]));
    const consistent = (contestId: string, versionId: string | undefined) => {
      const c = current.get(contestId);
      return (
        c !== undefined &&
        c.currentVersionId === versionId &&
        c.currentStatus !== null &&
        OFFICIAL.has(c.currentStatus)
      );
    };
    const drift =
      [...evidence].some(([contestId, ev]) => !consistent(contestId, ev.resultVersionId)) ||
      classifications.some((t) =>
        t.document.inputs.some(
          (i) => i.resultVersionId !== undefined && !consistent(i.contestId, i.resultVersionId),
        ),
      );
    if (drift)
      throw new DomainError(
        DomainErrorCode.CONCURRENCY_CONFLICT,
        'official results changed while the outcome was read',
        { reason: 'OUTCOME_INPUTS_CHANGED' },
      );
    const roundOf = new Map(s.rounds.map((r) => [r.key, r]));
    const input: EventOutcomeInput = {
      eventId: s.eventId,
      stages: s.stages,
      transitions: s.transitions,
      rounds: s.rounds.flatMap((r) =>
        r.stageKey === null
          ? []
          : [
              {
                key: r.key,
                stageKey: r.stageKey,
                ...(r.groupKey === null ? {} : { groupKey: r.groupKey }),
                dynamic: r.dynamic,
              },
            ],
      ),
      contests: s.contests.flatMap((c) => {
        const r = roundOf.get(c.roundKey);
        if (r === undefined || r.stageKey === null) return [];
        const ev = evidence.get(c.id);
        return [
          {
            contestId: c.id,
            stageKey: r.stageKey,
            roundKey: r.key,
            roundType: r.type,
            ...(r.groupKey === null ? {} : { groupKey: r.groupKey }),
            status: c.status,
            occupants: c.occupants,
            vacant: c.vacant,
            feeders: c.feeders,
            ...(ev === undefined
              ? {}
              : {
                  evidence: {
                    resultVersionId: ev.resultVersionId,
                    contentHash: ev.contentHash,
                    result: ev.result,
                  },
                }),
          },
        ];
      }),
      classifications,
    };
    return {
      eventId: s.eventId,
      competitionId: s.competitionId,
      eventStatus: s.status,
      outcome: eventOutcome(input),
      settlement: s.settlement,
      contests: s.contests
        .map((c) => {
          const r = roundOf.get(c.roundKey);
          const ev = evidence.get(c.id);
          return {
            contestId: c.id,
            sequence: c.sequence,
            roundLabel: r?.label ?? '',
            roundSequence: r?.sequence ?? 0,
            stageKey: r?.stageKey ?? null,
            groupKey: r?.groupKey ?? null,
            status: c.status,
            occupants: c.occupants,
            ...(ev === undefined ? {} : { official: ev.result }),
          };
        })
        .sort((a, b) => a.roundSequence - b.roundSequence || a.sequence - b.sequence),
    };
  }

  /**
   * Category completion's pre-read: never throws, so the lifecycle check inside the completion
   * transaction still decides first. `error` when no outcome could be derived at all.
   */
  async preflight(
    eventId: string,
  ): Promise<{ readonly derived?: DerivedEventOutcome; readonly error?: string }> {
    try {
      return { derived: await this.derive(eventId) };
    } catch (err) {
      return { error: err instanceof DomainError ? err.code : 'OUTCOME_UNAVAILABLE' };
    }
  }

  /** The full outcome and completion readiness (competition staff, COMP_VIEW_PRIVATE). */
  async staff(input: { actorAccountId: string; eventId: string }) {
    await inTransaction(this.db, ModuleRole.competition, async (ctx) => {
      const e = await loadEvent(ctx, input.eventId);
      await requireCompPermission(
        ctx,
        input.actorAccountId,
        await loadCompetition(ctx, e.competitionId),
        'COMP_VIEW_PRIVATE',
      );
    });
    const d = await this.derive(input.eventId);
    const undecided = ['PENDING', 'UNDECIDED'].includes(d.outcome.document.status);
    const readiness: EventReadiness = {
      ready:
        d.eventStatus === 'IN_PROGRESS' &&
        d.settlement.open.length === 0 &&
        d.settlement.notOfficial.length === 0 &&
        !undecided,
      contestsOpen: d.settlement.open,
      resultsNotOfficial: d.settlement.notOfficial,
      required: d.settlement.required,
      official: d.settlement.official,
    };
    return {
      eventId: d.eventId,
      eventStatus: d.eventStatus,
      final: d.eventStatus === 'COMPLETED',
      outcome: d.outcome.document,
      hash: d.outcome.hash,
      readiness,
    };
  }

  /**
   * The public outcome of one non-DRAFT event (the caller resolved the slugs, gated DRAFT and
   * supplies public-safe displays by participant id).
   */
  async publicEvent(
    eventId: string,
    displays: ReadonlyMap<string, PublicEntrantDisplay>,
  ): Promise<PublicEventOutcomeV1> {
    return publicEventOutcome(await this.derive(eventId), displays);
  }

  /** Champions of every listed (non-DRAFT) event of a competition. */
  async publicCompetition(
    competition: { id: string; status: string },
    events: readonly {
      id: string;
      slug: string;
      name: string;
      status: EventStatus;
      displays: ReadonlyMap<string, PublicEntrantDisplay>;
    }[],
  ): Promise<PublicCompetitionOutcomeV1> {
    const out = [];
    for (const e of events) {
      // An event whose outcome cannot be read now (e.g. a concurrent declaration) shows no champion.
      let champions: PublicPlacement[] | null = null;
      let kind: EventOutcomeKind | null = null;
      if (e.status === 'COMPLETED' || e.status === 'IN_PROGRESS')
        try {
          const d = await this.derive(e.id);
          kind = d.outcome.document.kind ?? null;
          if (e.status === 'COMPLETED' && d.outcome.document.status === 'DECIDED') {
            const first = d.outcome.document.placements.filter((p) => p.position === 1);
            champions = first.length === 0 ? null : first.map((p) => placement(p, e.displays));
          }
        } catch (err) {
          if (!(err instanceof DomainError)) throw err;
        }
      out.push({
        id: e.id,
        slug: e.slug,
        name: e.name,
        status: e.status,
        final: e.status === 'COMPLETED',
        kind,
        champions,
      });
    }
    return {
      schema: PUBLIC_COMPETITION_OUTCOME_SCHEMA,
      competition: { id: competition.id, status: competition.status },
      authority: 'ORGANIZER_DECLARED',
      events: out,
    };
  }
}

function placement(
  p: { participantId: string; position: number; tied: boolean },
  displays: ReadonlyMap<string, PublicEntrantDisplay>,
): PublicPlacement {
  return {
    participantId: p.participantId,
    display: displays.get(p.participantId) ?? PRIVATE,
    position: p.position,
    tied: p.tied,
  };
}

/** The OFFICIAL-only public DTO of a derived outcome (pure; exported for tests). */
export function publicEventOutcome(
  d: DerivedEventOutcome,
  displays: ReadonlyMap<string, PublicEntrantDisplay>,
): PublicEventOutcomeV1 {
  const doc = d.outcome.document;
  const final = d.eventStatus === 'COMPLETED';
  const display = (participantId: string) => displays.get(participantId) ?? PRIVATE;
  const podiumField: PublicEventOutcomeV1['podium'] =
    d.eventStatus === 'CANCELLED'
      ? { status: 'NOT_AVAILABLE', reason: 'EVENT_CANCELLED' }
      : !final
        ? { status: 'NOT_AVAILABLE', reason: 'EVENT_NOT_COMPLETED' }
        : doc.kind === 'GROUPS'
          ? { status: 'NOT_AVAILABLE', reason: 'NO_CHAMPION_ACROSS_GROUPS' }
          : doc.status === 'NOT_SUPPORTED'
            ? { status: 'NOT_AVAILABLE', reason: 'FORMAT_NOT_SUPPORTED' }
            : doc.status !== 'DECIDED'
              ? { status: 'NOT_AVAILABLE', reason: 'OUTCOME_UNDECIDED' }
              : {
                  status: 'AVAILABLE',
                  placements: podium(doc).map((p) => placement(p, displays)),
                };
  return {
    schema: PUBLIC_EVENT_OUTCOME_SCHEMA,
    event: { id: d.eventId, status: d.eventStatus },
    final,
    authority: 'ORGANIZER_DECLARED',
    kind: doc.kind ?? null,
    podium: podiumField,
    standings: doc.standings.map((s) => ({
      groupKey: s.groupKey ?? null,
      // Settled tables: CANCELLED / VOID contests keep nothing pending (event-outcome/1).
      complete: doc.status === 'DECIDED',
      entries: s.document.entries.map((e) => ({
        participantId: e.participantId,
        display: display(e.participantId),
        position: e.position,
        tied: e.tied,
        status: e.status,
        values: e.values,
      })),
    })),
    matches: d.contests.map((c) => {
      const entries = new Map((c.official?.entries ?? []).map((e) => [e.participantId, e]));
      const participants =
        c.official === undefined
          ? c.occupants.flatMap((o) => (o === null ? [] : [o]))
          : c.official.entries.map((e) => e.participantId);
      return {
        contestId: c.contestId,
        sequence: c.sequence,
        roundLabel: c.roundLabel,
        roundSequence: c.roundSequence,
        groupKey: c.groupKey,
        status: c.status,
        official: c.official !== undefined,
        entrants: participants.map((participantId) => {
          const e = entries.get(participantId);
          return {
            participantId,
            display: display(participantId),
            outcome: e?.outcome ?? null,
            score:
              e === undefined
                ? []
                : Object.keys(e.metrics)
                    .sort()
                    .map((key) => ({ key, value: e.metrics[key] as string })),
          };
        }),
      };
    }),
    notes: doc.reasons
      .map((r) => r.code)
      .filter(
        (c): c is 'TIE_UNBROKEN_LOT' | 'GROUPS_NO_CHAMPION' =>
          c === 'TIE_UNBROKEN_LOT' || c === 'GROUPS_NO_CHAMPION',
      ),
  };
}
