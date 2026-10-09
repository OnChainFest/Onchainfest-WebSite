import {
  advancementDecision,
  assignmentDigest,
  resolveAdvancementUnit,
  targetKey,
  type AdvancementAssignment,
  type AdvancementDecisionDocument,
  type AdvancementPolicySpec,
  type AdvancementProvenance,
  type AdvancementTarget,
  type AdvancementUnit,
  type ClassificationEvidence,
  type ContestEvidence,
  type EntrantEligibility,
} from '@br/competition';
import { DomainError, DomainErrorCode, newId, type Uuid } from '@br/domain';
import { sql } from 'kysely';
import { loadCompetition, loadEvent, requireCompPermission, text } from './competition-support';
import { refreshEventReadModels } from './competition-projection';
import type { Db } from './db';
import { identityIdempotency, lockKeys, recordAudit } from './identity-support';
import { emitEvent } from './outbox';
import { advancementPolicyVersion, currentPin, type ScoringStore } from './scoring-store';
import { inTransaction, ModuleRole, type TxContext } from './tx';

/**
 * ONCF-05D advancement (ADR-0065): WHO occupies each dependent slot of the immutable plan, and WHY.
 *
 *  · state      every advancement unit of an event, its preview (what the pinned policy proposes
 *               from the CURRENT official results and classifications, with a canonical hash), and
 *               every target's state: UNRESOLVED · RESOLVED · VACANT · STALE · OVERRIDDEN.
 *  · commit     records a unit's preview as an append-only decision + one fact per changed target —
 *               only with the hash of the preview the organizer saw (policy CONFIRM), never over a
 *               newer decision (optimistic check), never moving an entrant out of a started contest.
 *  · override / revokeOverride  an organizer's explicit, reasoned, audited assignment, and its
 *               explicit reversal; the automatic decision is kept and stays visible.
 *  · history    every fact a target ever had, with the decision and provenance behind it.
 * Facts are never updated: a correction upstream makes a committed fact STALE (computed on read by
 * comparing its digest with the current preview), and only a new decision replaces it. Results are
 * read through ScoringStore as br_results (re-validated under the pinned ruleset); structure and
 * facts as br_competition. Nothing here schedules anything (05E).
 */

export type TargetState = 'UNRESOLVED' | 'RESOLVED' | 'VACANT' | 'STALE' | 'OVERRIDDEN';
export type TargetRef =
  | { readonly contestId: string; readonly slot: number }
  | { readonly transitionKey: string; readonly ordinal: number };

const ACTIVE_EVENT = ['FIELD_LOCKED', 'IN_PROGRESS'];
const OPEN_CONTEST = ['PLANNED', 'SCHEDULED'];
const FIELD_KINDS = new Set(['QUALIFY_BY_PLACE_AND_TIME', 'CUT', 'ELIMINATE_NON_FINISHERS']);

interface Structure {
  readonly eventId: string;
  readonly status: string;
  readonly competitionId: string;
  readonly policy?: {
    readonly id: string;
    readonly ref: { code: string; version: number; specHash: string };
    readonly spec: AdvancementPolicySpec;
  };
  readonly stages: readonly {
    id: string;
    key: string;
    sequence: number;
    rounds: number;
    groups: string[];
  }[];
  readonly rounds: readonly {
    id: string;
    key: string;
    sequence: number;
    stageKey: string;
    groupKey: string | null;
    dynamicTransitionKey: string | null;
    label: string;
  }[];
  readonly transitions: readonly {
    id: string;
    key: string;
    kind: string;
    fromStage: string;
    toStage: string;
    afterRound: string | null;
    params: Record<string, number | boolean>;
  }[];
  readonly contests: readonly {
    id: string;
    planKey: string;
    roundId: string;
    sequence: number;
    contestType: string;
    status: string;
  }[];
  readonly dependents: readonly {
    contestId: string;
    slot: number;
    kind: string;
    sourceContestId: string | null;
    stageKey: string | null;
    groupKey: string | null;
    rank: number | null;
    ordinal: number | null;
    transitionKey: string | null;
  }[];
  /** contest → places (slot / field ordinal) → current occupant (null: none). */
  readonly occupants: ReadonlyMap<string, readonly (string | null)[]>;
  readonly facts: ReadonlyMap<string, Fact>;
  readonly lastDecision: ReadonlyMap<string, string>;
  readonly entrants: Readonly<Record<string, EntrantEligibility>>;
}

interface Fact {
  readonly id: string;
  readonly decisionId: string;
  readonly decisionKind: 'RESOLUTION' | 'OVERRIDE' | 'OVERRIDE_REVOKED';
  readonly participantId: string | null;
  readonly digest: string;
  readonly recordedAt: Date;
}

interface ComputedTarget {
  readonly key: string;
  readonly target: AdvancementTarget;
  readonly state: TargetState;
  readonly current?: Fact;
  readonly proposed: AdvancementAssignment & { readonly digest: string };
  /** The proposal differs from the current automatic fact and can be committed. */
  readonly changed: boolean;
}

interface ComputedUnit {
  readonly unitKey: string;
  readonly kind: AdvancementUnit['kind'];
  readonly families: readonly string[];
  readonly complete: boolean;
  readonly document: AdvancementDecisionDocument;
  readonly hash: string;
  readonly targets: readonly ComputedTarget[];
}

const keyOfRef = (t: TargetRef | AdvancementTarget): string =>
  'contestId' in t
    ? targetKey({ kind: 'SLOT', contestId: t.contestId, slot: t.slot })
    : targetKey({ kind: 'FIELD', transitionKey: t.transitionKey, ordinal: t.ordinal });

/** Digest of "no automatic occupant" (an override revoked where nothing automatic existed). */
function revokedPlaceholder(target: AdvancementTarget): string {
  return assignmentDigest({
    target,
    state: 'PENDING',
    reason: 'OVERRIDE_REVOKED',
    provenance: { family: 'MANUAL_OVERRIDE', source: { kind: 'REVOKED' } },
  });
}

export class AdvancementStore {
  private readonly db: Db;
  private readonly scoring: ScoringStore;

  constructor(db: Db, scoring: ScoringStore) {
    this.db = db;
    this.scoring = scoring;
  }

  private tx<T>(fn: (ctx: TxContext) => Promise<T>): Promise<T> {
    return inTransaction(this.db, ModuleRole.competition, fn);
  }

  // ───────────────────────────── structure ─────────────────────────────

  private async structure(ctx: TxContext, eventId: string): Promise<Structure> {
    const e = await loadEvent(ctx, eventId);
    const pin = await currentPin(ctx, e.id);
    const pv =
      pin?.advancementPolicyVersionId === null || pin === undefined
        ? undefined
        : await advancementPolicyVersion(ctx, pin.advancementPolicyVersionId);
    const { rows: stages } = await sql<{ id: string; key: string; sequence: number }>`
      SELECT id, plan_key AS key, sequence FROM competition.stage WHERE event_id = ${e.id} ORDER BY sequence`.execute(
      ctx.trx,
    );
    const { rows: rounds } = await sql<{
      id: string;
      key: string;
      sequence: number;
      stage_id: string | null;
      group_key: string | null;
      dynamic_transition_key: string | null;
      label: string;
    }>`SELECT id, plan_key AS key, sequence, stage_id, group_key, dynamic_transition_key, label
       FROM competition.round WHERE event_id = ${e.id} ORDER BY sequence`.execute(ctx.trx);
    const stageKey = new Map(stages.map((s) => [s.id, s.key]));
    const { rows: transitions } = await sql<{
      id: string;
      key: string;
      kind: string;
      from_stage_id: string;
      to_stage_id: string;
      after_round_plan_key: string | null;
      params: Record<string, number | boolean>;
    }>`SELECT id, plan_key AS key, kind, from_stage_id, to_stage_id, after_round_plan_key, params
       FROM competition.stage_transition WHERE event_id = ${e.id} ORDER BY plan_key`.execute(
      ctx.trx,
    );
    const { rows: contests } = await sql<{
      id: string;
      plan_key: string;
      round_id: string;
      sequence: number;
      contest_type: string;
      status: string;
    }>`SELECT c.id, c.plan_key, c.round_id, c.sequence, c.contest_type, cur.status
       FROM competition.contest c JOIN competition.v_contest_current cur ON cur.contest_id = c.id
       WHERE c.event_id = ${e.id} ORDER BY c.sequence`.execute(ctx.trx);
    const { rows: dependents } = await sql<{
      contest_id: string;
      slot: number;
      source_kind: string;
      source_contest_id: string | null;
      stage_key: string | null;
      source_group_key: string | null;
      source_rank: number | null;
      source_ordinal: number | null;
      transition_key: string | null;
    }>`SELECT ct.contest_id, ct.slot, ct.source_kind, ct.source_contest_id, s.plan_key AS stage_key,
              ct.source_group_key, ct.source_rank, ct.source_ordinal, t.plan_key AS transition_key
       FROM competition.contestant ct JOIN competition.contest c ON c.id = ct.contest_id
       LEFT JOIN competition.stage s ON s.id = ct.source_stage_id
       LEFT JOIN competition.stage_transition t ON t.id = ct.source_transition_id
       WHERE c.event_id = ${e.id} AND ct.source_kind <> 'PARTICIPANT'
       ORDER BY c.sequence, ct.slot`.execute(ctx.trx);
    const { rows: occ } = await sql<{
      contest_id: string;
      place: number;
      participant_id: string | null;
    }>`
      SELECT o.contest_id, o.place, o.participant_id FROM competition.v_contest_occupant o
      JOIN competition.contest c ON c.id = o.contest_id WHERE c.event_id = ${e.id}
      UNION ALL
      SELECT ce.contest_id, ce.start_order, ce.participant_id FROM competition.contest_entry ce
      JOIN competition.contest c ON c.id = ce.contest_id WHERE c.event_id = ${e.id}
      ORDER BY 1, 2`.execute(ctx.trx);
    const occupants = new Map<string, (string | null)[]>();
    for (const o of occ) {
      const list = occupants.get(o.contest_id) ?? [];
      list.push(o.participant_id);
      occupants.set(o.contest_id, list);
    }
    const { rows: facts } = await sql<{
      id: string;
      decision_id: string;
      kind: Fact['decisionKind'];
      contest_id: string | null;
      slot: number | null;
      transition_key: string | null;
      ordinal: number | null;
      participant_id: string | null;
      digest: string;
      recorded_at: Date;
    }>`SELECT a.id, a.decision_id, d.kind, a.contest_id, a.slot, t.plan_key AS transition_key, a.ordinal,
              a.participant_id, a.digest, a.recorded_at
       FROM competition.v_slot_assignment_current a
       JOIN competition.advancement_decision d ON d.id = a.decision_id
       LEFT JOIN competition.stage_transition t ON t.id = a.transition_id
       WHERE a.event_id = ${e.id}`.execute(ctx.trx);
    const { rows: decisions } = await sql<{ unit_key: string; id: string }>`
      SELECT DISTINCT ON (unit_key) unit_key, id FROM competition.advancement_decision
      WHERE event_id = ${e.id} ORDER BY unit_key, seq DESC`.execute(ctx.trx);
    const { rows: entrants } = await sql<{ id: string; status: string }>`
      SELECT p.id, pv.status FROM competition.participant p
      JOIN competition.v_participant_current pv ON pv.participant_id = p.id WHERE p.event_id = ${e.id}`.execute(
      ctx.trx,
    );
    const { rows: seeding } = await sql<{ seed_order: string[] }>`
      SELECT seed_order FROM competition.event_seeding WHERE event_id = ${e.id}`.execute(ctx.trx);
    const seedOf = new Map((seeding[0]?.seed_order ?? []).map((id, i) => [id, i + 1]));
    return {
      eventId: e.id,
      status: e.status,
      competitionId: e.competitionId,
      ...(pv === undefined
        ? {}
        : {
            policy: {
              id: pv.id,
              ref: { code: pv.code, version: pv.version, specHash: pv.spec_hash },
              spec: pv.spec as AdvancementPolicySpec,
            },
          }),
      stages: stages.map((s) => ({
        ...s,
        rounds: rounds.filter((r) => r.stage_id === s.id).length,
        groups: [
          ...new Set(
            rounds.flatMap((r) =>
              r.stage_id === s.id && r.group_key !== null ? [r.group_key] : [],
            ),
          ),
        ].sort(),
      })),
      rounds: rounds.map((r) => ({
        id: r.id,
        key: r.key,
        sequence: r.sequence,
        stageKey: stageKey.get(r.stage_id ?? '') ?? '',
        groupKey: r.group_key,
        dynamicTransitionKey: r.dynamic_transition_key,
        label: r.label,
      })),
      transitions: transitions.map((t) => ({
        id: t.id,
        key: t.key,
        kind: t.kind,
        fromStage: stageKey.get(t.from_stage_id) ?? '',
        toStage: stageKey.get(t.to_stage_id) ?? '',
        afterRound: t.after_round_plan_key,
        params: t.params,
      })),
      contests: contests.map((c) => ({
        id: c.id,
        planKey: c.plan_key,
        roundId: c.round_id,
        sequence: c.sequence,
        contestType: c.contest_type,
        status: c.status,
      })),
      dependents: dependents.map((d) => ({
        contestId: d.contest_id,
        slot: d.slot,
        kind: d.source_kind,
        sourceContestId: d.source_contest_id,
        stageKey: d.stage_key,
        groupKey: d.source_group_key,
        rank: d.source_rank,
        ordinal: d.source_ordinal,
        transitionKey: d.transition_key,
      })),
      occupants,
      facts: new Map(
        facts.map((f) => {
          const target: AdvancementTarget =
            f.contest_id !== null
              ? { kind: 'SLOT', contestId: f.contest_id, slot: f.slot as number }
              : {
                  kind: 'FIELD',
                  transitionKey: f.transition_key as string,
                  ordinal: f.ordinal as number,
                };
          return [
            targetKey(target),
            {
              id: f.id,
              decisionId: f.decision_id,
              decisionKind: f.kind,
              participantId: f.participant_id,
              digest: f.digest,
              recordedAt: f.recorded_at,
            },
          ];
        }),
      ),
      lastDecision: new Map(decisions.map((d) => [d.unit_key, d.id])),
      entrants: Object.fromEntries(
        entrants.map((p) => [
          p.id,
          { status: p.status, ...(seedOf.has(p.id) ? { seed: seedOf.get(p.id) as number } : {}) },
        ]),
      ),
    };
  }

  // ───────────────────────────── computation ─────────────────────────────

  /**
   * Every unit of the event with its preview and target states (no authorization: callers check).
   * Staleness propagates: a contest whose own dependent slot is STALE cannot feed anything.
   */
  private async compute(eventId: string): Promise<{ s: Structure; units: ComputedUnit[] }> {
    const s = await this.tx((ctx) => this.structure(ctx, eventId));
    if (s.stages.length === 0 || s.policy === undefined) return { s, units: [] };
    const policy = s.policy;
    const floor = policy.spec.minimumResultStatus;
    const roundOf = new Map(s.rounds.map((r) => [r.id, r]));
    const contestOf = new Map(s.contests.map((c) => [c.id, c]));

    // Evidence: results of every contest that feeds a direct slot.
    const sourceContests = [
      ...new Set(
        s.dependents.flatMap((d) => (d.sourceContestId === null ? [] : [d.sourceContestId])),
      ),
    ].sort();
    const evidence =
      sourceContests.length === 0
        ? { admissible: new Map<string, ContestEvidence>(), below: new Map<string, string>() }
        : await this.scoring.contestEvidence(sourceContests, floor);

    const cache = new Map<string, ClassificationEvidence | { pendingReason: string }>();
    const classification = async (stageKey: string, groupKey?: string, throughRound?: number) => {
      const k = `${stageKey}|${groupKey ?? ''}|${throughRound ?? ''}`;
      const hit = cache.get(k);
      if (hit !== undefined) return hit;
      let out: ClassificationEvidence | { pendingReason: string };
      try {
        const c = await this.scoring.classificationAt({
          eventId: s.eventId,
          stageKey,
          ...(groupKey === undefined ? {} : { groupKey }),
          ...(throughRound === undefined ? {} : { throughRound }),
          floor,
        });
        out = {
          stageKey,
          ...(groupKey === undefined ? {} : { groupKey }),
          ...(throughRound === undefined ? {} : { throughRound }),
          hash: c.hash,
          document: c.document,
        };
      } catch (err) {
        const reason = (err as DomainError).details?.['reason'];
        out = { pendingReason: typeof reason === 'string' ? reason : 'CLASSIFICATION_UNAVAILABLE' };
      }
      cache.set(k, out);
      return out;
    };
    const asEvidence = (c: ClassificationEvidence | { pendingReason: string }) =>
      'hash' in c ? { classification: c } : { pendingReason: c.pendingReason };

    // Units (deterministic keys; one per source).
    const raw: {
      unitKey: string;
      build: (stale: ReadonlySet<string>) => Promise<AdvancementUnit>;
    }[] = [];
    const byUnit = new Map<string, typeof s.dependents>();
    for (const d of s.dependents) {
      const key =
        d.kind === 'WINNER_OF_CONTEST' || d.kind === 'LOSER_OF_CONTEST'
          ? `contest:${d.sourceContestId}`
          : d.kind === 'RANK_FROM_STAGE'
            ? `rank:${d.stageKey}${d.groupKey === null ? '' : `:${d.groupKey}`}`
            : d.kind === 'BEST_RANKED_FROM_STAGE'
              ? `best:${d.stageKey}:${d.rank}`
              : undefined;
      if (
        key === undefined ||
        (d.stageKey === null && d.kind !== 'WINNER_OF_CONTEST' && d.kind !== 'LOSER_OF_CONTEST')
      )
        continue;
      byUnit.set(key, [...(byUnit.get(key) ?? []), d]);
    }
    for (const [unitKey, ds] of [...byUnit.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const first = ds[0] as (typeof ds)[number];
      const slotTarget = (d: (typeof ds)[number]): AdvancementTarget => ({
        kind: 'SLOT',
        contestId: d.contestId,
        slot: d.slot,
      });
      if (unitKey.startsWith('contest:')) {
        const src = first.sourceContestId as string;
        raw.push({
          unitKey,
          build: async (stale) => {
            const ev = evidence.admissible.get(src);
            const below = evidence.below.get(src);
            return {
              kind: 'CONTEST',
              contestId: src,
              contestStatus: contestOf.get(src)?.status ?? 'PLANNED',
              occupants: s.occupants.get(src) ?? [],
              upstreamStale: stale.has(src),
              ...(ev === undefined ? {} : { evidence: ev }),
              ...(below === undefined ? {} : { belowPolicyStatus: below }),
              targets: ds.map((d) => ({
                target: slotTarget(d),
                family: d.kind === 'WINNER_OF_CONTEST' ? 'DIRECT_WINNER' : 'DIRECT_LOSER',
              })),
            };
          },
        });
      } else if (unitKey.startsWith('rank:')) {
        const stage = s.stages.find((x) => x.key === first.stageKey);
        raw.push({
          unitKey,
          build: async () => ({
            kind: 'RANK',
            stageKey: first.stageKey as string,
            ...(first.groupKey === null ? {} : { groupKey: first.groupKey }),
            multiRound: (stage?.rounds ?? 1) > 1,
            ...asEvidence(
              await classification(first.stageKey as string, first.groupKey ?? undefined),
            ),
            targets: ds.map((d) => ({ target: slotTarget(d), rank: d.rank as number })),
          }),
        });
      } else {
        const stage = s.stages.find((x) => x.key === first.stageKey);
        raw.push({
          unitKey,
          build: async () => ({
            kind: 'BEST',
            stageKey: first.stageKey as string,
            rank: first.rank as number,
            groups: await Promise.all(
              (stage?.groups ?? []).map(async (g) => ({
                groupKey: g,
                ...asEvidence(await classification(first.stageKey as string, g)),
              })),
            ),
            targets: ds.map((d) => ({ target: slotTarget(d), ordinal: d.ordinal as number })),
          }),
        });
      }
    }
    for (const t of s.transitions.filter((x) => FIELD_KINDS.has(x.kind))) {
      const qualifierSlots = s.dependents.filter(
        (d) => d.kind === 'QUALIFIER' && d.transitionKey === t.key,
      );
      const recorded = Math.max(
        0,
        ...[...s.facts.keys()]
          .filter((k) => k.startsWith(`field:${t.key}:`))
          .map((k) => Number(k.split(':')[2])),
      );
      const afterRound = s.rounds.find((r) => r.key === t.afterRound);
      raw.push({
        unitKey: `field:${t.key}`,
        build: async () => {
          const heats =
            t.kind === 'QUALIFY_BY_PLACE_AND_TIME'
              ? s.contests
                  .filter((c) => roundOf.get(c.roundId)?.stageKey === t.fromStage)
                  .map((c) => ({
                    contestId: c.id,
                    members: (s.occupants.get(c.id) ?? []).flatMap((o) => (o === null ? [] : [o])),
                  }))
              : undefined;
          return {
            kind: 'FIELD',
            transition: { key: t.key, kind: t.kind, params: t.params },
            ...asEvidence(await classification(t.fromStage, undefined, afterRound?.sequence)),
            ...(heats === undefined ? {} : { heats }),
            ...(qualifierSlots.length === 0 || t.kind !== 'QUALIFY_BY_PLACE_AND_TIME'
              ? {}
              : { capacity: qualifierSlots.length }),
            recordedOrdinals: recorded,
          };
        },
      });
    }

    // Resolve, then propagate staleness until it settles (bounded by the depth of the graph).
    let stale = new Set<string>();
    let units: ComputedUnit[] = [];
    for (let pass = 0; pass < 64; pass += 1) {
      units = [];
      for (const r of raw) units.push(this.evaluate(s, r.unitKey, await r.build(stale)));
      const next = new Set<string>();
      for (const u of units)
        for (const t of u.targets)
          if (t.state === 'STALE' && t.target.kind === 'SLOT') next.add(t.target.contestId);
      // A field place feeds a QUALIFIER slot of a contest.
      for (const d of s.dependents)
        if (d.kind === 'QUALIFIER') {
          const f = units
            .flatMap((u) => u.targets)
            .find(
              (x) =>
                x.key ===
                targetKey({
                  kind: 'FIELD',
                  transitionKey: d.transitionKey as string,
                  ordinal: d.ordinal as number,
                }),
            );
          if (f?.state === 'STALE') next.add(d.contestId);
        }
      if ([...next].every((x) => stale.has(x)) && next.size === stale.size) break;
      stale = next;
    }
    return { s, units };
  }

  private evaluate(s: Structure, unitKey: string, unit: AdvancementUnit): ComputedUnit {
    const policy = s.policy as NonNullable<Structure['policy']>;
    const r = resolveAdvancementUnit(policy.spec, s.entrants, unit);
    const { document, hash } = advancementDecision({
      eventId: s.eventId,
      unit: unitKey,
      kind: 'RESOLUTION',
      policy: policy.ref,
      assignments: r.assignments,
    });
    const targets = document.assignments.map((proposed): ComputedTarget => {
      const key = targetKey(proposed.target);
      const current = s.facts.get(key);
      const decided = proposed.state === 'RESOLVED' || proposed.state === 'VACANT';
      let state: TargetState;
      if (current === undefined) state = 'UNRESOLVED';
      else if (current.decisionKind === 'OVERRIDE') state = 'OVERRIDDEN';
      else if (
        current.decisionKind === 'OVERRIDE_REVOKED' &&
        current.digest === revokedPlaceholder(proposed.target)
      )
        state = 'UNRESOLVED';
      else if (decided && current.digest === proposed.digest)
        state = current.participantId === null ? 'VACANT' : 'RESOLVED';
      else state = 'STALE';
      return {
        key,
        target: proposed.target,
        state,
        ...(current === undefined ? {} : { current }),
        proposed,
        changed:
          decided &&
          current?.decisionKind !== 'OVERRIDE' &&
          (current === undefined || current.digest !== proposed.digest),
      };
    });
    return {
      unitKey,
      kind: unit.kind,
      families: r.families,
      complete: r.complete,
      document,
      hash,
      targets,
    };
  }

  private async authorize(
    ctx: TxContext,
    s: { competitionId: string },
    actor: string,
    permission: 'COMP_VIEW_PRIVATE' | 'COMP_GENERATE_STRUCTURE',
  ) {
    await requireCompPermission(
      ctx,
      actor,
      await loadCompetition(ctx, s.competitionId),
      permission,
    );
  }

  // ───────────────────────────── reads ─────────────────────────────

  /** The advancement state of an event (COMP_VIEW_PRIVATE). */
  async state(input: { actorAccountId: string; eventId: string }) {
    const e = await this.tx(async (ctx) => {
      const ev = await loadEvent(ctx, input.eventId);
      await this.authorize(ctx, ev, input.actorAccountId, 'COMP_VIEW_PRIVATE');
      return ev;
    });
    const { s, units } = await this.compute(e.id);
    const labels = this.labels(s);
    return {
      eventId: s.eventId,
      policy: s.policy === undefined ? null : s.policy.ref,
      commitMode: s.policy?.spec.commit ?? null,
      /** No dependent slot and no selecting transition: nothing ever advances in this format. */
      advancement:
        s.stages.length === 0
          ? 'NOT_APPLICABLE'
          : units.length === 0 && s.policy !== undefined
            ? 'NO_ADVANCEMENT_REQUIRED'
            : s.policy === undefined
              ? 'POLICY_NOT_PINNED'
              : 'REQUIRED',
      units: units.map((u) => ({
        unitKey: u.unitKey,
        kind: u.kind,
        families: u.families,
        complete: u.complete,
        previewHash: u.hash,
        needsCommit: u.targets.some((t) => t.changed),
        targets: u.targets.map((t) => ({
          target: t.target,
          label: labels(t.target),
          state: t.state,
          current:
            t.current === undefined
              ? null
              : {
                  participantId: t.current.participantId,
                  decisionId: t.current.decisionId,
                  decisionKind: t.current.decisionKind,
                  digest: t.current.digest,
                  recordedAt: t.current.recordedAt.toISOString(),
                },
          proposed: {
            state: t.proposed.state,
            participantId: t.proposed.participantId ?? null,
            reason: t.proposed.reason ?? null,
            provenance: t.proposed.provenance,
            digest: t.proposed.digest,
          },
        })),
      })),
    };
  }

  private labels(s: Structure) {
    const round = new Map(s.rounds.map((r) => [r.id, r]));
    const contest = new Map(s.contests.map((c) => [c.id, c]));
    return (t: AdvancementTarget) => {
      if (t.kind === 'SLOT') {
        const c = contest.get(t.contestId);
        const r = c === undefined ? undefined : round.get(c.roundId);
        return {
          stageKey: r?.stageKey ?? null,
          round: r?.label ?? null,
          contestPlanKey: c?.planKey ?? null,
          contestSequence: c?.sequence ?? null,
          contestStatus: c?.status ?? null,
          place: t.slot,
        };
      }
      const tr = s.transitions.find((x) => x.key === t.transitionKey);
      return {
        stageKey: tr?.toStage ?? null,
        round: s.rounds.find((r) => r.dynamicTransitionKey === t.transitionKey)?.label ?? null,
        contestPlanKey: null,
        contestSequence: null,
        contestStatus: null,
        place: t.ordinal,
      };
    };
  }

  /** Every fact a target ever had, newest first, with its decision and provenance (organizer). */
  async history(input: { actorAccountId: string; eventId: string; target: TargetRef }) {
    return this.tx(async (ctx) => {
      const e = await loadEvent(ctx, input.eventId);
      await this.authorize(ctx, e, input.actorAccountId, 'COMP_VIEW_PRIVATE');
      const target = await this.resolveTarget(ctx, e.id, input.target);
      const { rows } = await sql<{
        id: string;
        participant_id: string | null;
        digest: string;
        recorded_at: Date;
        decision_id: string;
        kind: string;
        unit_key: string;
        reason: string | null;
        actor_account_id: string;
        document: AdvancementDecisionDocument;
        document_hash: string;
      }>`SELECT a.id, a.participant_id, a.digest, a.recorded_at, d.id AS decision_id, d.kind, d.unit_key, d.reason,
                d.actor_account_id, d.document, d.document_hash
         FROM competition.slot_assignment a JOIN competition.advancement_decision d ON d.id = a.decision_id
         WHERE a.event_id = ${e.id}
           AND ${target.contestId ?? null}::uuid IS NOT DISTINCT FROM a.contest_id
           AND ${target.slot ?? null}::int IS NOT DISTINCT FROM a.slot
           AND ${target.transitionId ?? null}::uuid IS NOT DISTINCT FROM a.transition_id
           AND ${target.ordinal ?? null}::int IS NOT DISTINCT FROM a.ordinal
         ORDER BY a.seq DESC`.execute(ctx.trx);
      const key = keyOfRef(input.target);
      return {
        target: input.target,
        facts: rows.map((r, i) => ({
          assignmentId: r.id,
          participantId: r.participant_id,
          digest: r.digest,
          recordedAt: r.recorded_at.toISOString(),
          /** CURRENT; INVALIDATED when a later fact moved a different entrant in; REPLACED otherwise. */
          status:
            i === 0
              ? 'CURRENT'
              : rows.slice(0, i).some((later) => later.participant_id !== r.participant_id)
                ? 'INVALIDATED'
                : 'REPLACED',
          decision: {
            decisionId: r.decision_id,
            kind: r.kind,
            unitKey: r.unit_key,
            documentHash: r.document_hash,
            reason: r.reason,
            actorAccountId: r.actor_account_id,
          },
          provenance:
            r.document.assignments.find((x) => targetKey(x.target) === key)?.provenance ?? null,
        })),
      };
    });
  }

  private async resolveTarget(ctx: TxContext, eventId: string, t: TargetRef) {
    if ('contestId' in t) {
      if (!/^[0-9a-f-]{36}$/.test(t.contestId) || !Number.isInteger(t.slot))
        throw new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid target');
      const { rows } = await sql<{ kind: string; status: string; round_id: string }>`
        SELECT ct.source_kind AS kind, cur.status, c.round_id FROM competition.contestant ct
        JOIN competition.contest c ON c.id = ct.contest_id
        JOIN competition.v_contest_current cur ON cur.contest_id = c.id
        WHERE ct.contest_id = ${t.contestId} AND ct.slot = ${t.slot} AND c.event_id = ${eventId}`.execute(
        ctx.trx,
      );
      const r = rows[0];
      if (r === undefined) throw new DomainError(DomainErrorCode.NOT_FOUND, 'target not found');
      return {
        contestId: t.contestId,
        slot: t.slot,
        kind: r.kind,
        contestStatus: r.status,
        roundId: r.round_id,
      };
    }
    if (!/^t[0-9]{1,2}$/.test(t.transitionKey) || !Number.isInteger(t.ordinal) || t.ordinal < 1)
      throw new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid target');
    const { rows } = await sql<{ id: string; kind: string }>`
      SELECT id, kind FROM competition.stage_transition WHERE event_id = ${eventId} AND plan_key = ${t.transitionKey}`.execute(
      ctx.trx,
    );
    const r = rows[0];
    if (r === undefined || !FIELD_KINDS.has(r.kind))
      throw new DomainError(DomainErrorCode.NOT_FOUND, 'target not found');
    return {
      transitionId: r.id,
      transitionKey: t.transitionKey,
      ordinal: t.ordinal,
      kind: 'QUALIFIER',
    };
  }

  // ───────────────────────────── commit ─────────────────────────────

  /**
   * Commits units (COMP_GENERATE_STRUCTURE). CONFIRM policies require, per unit, the hash of the
   * preview the organizer saw; a different current preview, or a decision recorded meanwhile, is a
   * conflict (nothing is written). Only targets whose proposal changed get a new fact; overridden
   * targets are never touched (the override must be revoked explicitly). Re-running with nothing new
   * writes nothing.
   */
  async commit(input: {
    actorAccountId: string;
    eventId: string;
    units: readonly { unitKey: string; previewHash?: string }[];
    idempotencyKey: string;
  }) {
    if (input.units.length === 0 || input.units.length > 200)
      throw new DomainError(DomainErrorCode.INVALID_INPUT, '1–200 units');
    const e = await this.tx(async (ctx) => {
      const ev = await loadEvent(ctx, input.eventId);
      await this.authorize(ctx, ev, input.actorAccountId, 'COMP_GENERATE_STRUCTURE');
      return ev;
    });
    const { s, units } = await this.compute(e.id);
    if (s.policy === undefined)
      throw new DomainError(DomainErrorCode.INVALID_TRANSITION, 'no advancement policy is pinned', {
        reason: 'POLICY_NOT_PINNED',
      });
    const policy = s.policy;
    const chosen = input.units.map((r) => {
      const u = units.find((x) => x.unitKey === r.unitKey);
      if (u === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, `unknown unit ${r.unitKey}`);
      if (policy.spec.commit === 'CONFIRM' && r.previewHash === undefined)
        throw new DomainError(DomainErrorCode.INVALID_INPUT, 'confirm the preview (previewHash)', {
          reason: 'PREVIEW_REQUIRED',
        });
      if (r.previewHash !== undefined && r.previewHash !== u.hash)
        throw new DomainError(
          DomainErrorCode.CONCURRENCY_CONFLICT,
          'the preview changed; review it again',
          {
            reason: 'PREVIEW_CHANGED',
            unitKey: u.unitKey,
            previewHash: u.hash,
          },
        );
      return u;
    });
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{
        decisions: unknown[];
        materializedContests: number;
      }>(ctx, {
        command: 'CommitAdvancement',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: {
          eventId: e.id,
          units: input.units.map((u) => [u.unitKey, u.previewHash ?? null]),
        },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      await lockKeys(ctx, `event-structure:${e.id}`);
      const now = await this.structure(ctx, e.id);
      if (!ACTIVE_EVENT.includes(now.status))
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          `advancement is closed for a ${now.status} event`,
        );
      const decisions: {
        unitKey: string;
        decisionId: string;
        documentHash: string;
        facts: number;
      }[] = [];
      let materialized = 0;
      for (const u of chosen) {
        // Optimistic check: nothing was decided for this unit (or its targets) since the read.
        if (now.lastDecision.get(u.unitKey) !== s.lastDecision.get(u.unitKey))
          throw new DomainError(
            DomainErrorCode.CONCURRENCY_CONFLICT,
            'advancement changed meanwhile',
            {
              reason: 'PREVIEW_CHANGED',
              unitKey: u.unitKey,
            },
          );
        for (const t of u.targets)
          if (now.facts.get(t.key)?.id !== s.facts.get(t.key)?.id)
            throw new DomainError(
              DomainErrorCode.CONCURRENCY_CONFLICT,
              'advancement changed meanwhile',
              {
                reason: 'PREVIEW_CHANGED',
                unitKey: u.unitKey,
              },
            );
        const changes = u.targets.filter((t) => t.changed);
        if (changes.length === 0) continue;
        await this.assertDownstreamOpen(ctx, now, changes);
        const decisionId = newId();
        await sql`INSERT INTO competition.advancement_decision
            (id, event_id, unit_key, kind, advancement_policy_version_id, document, document_hash, supersedes_decision_id,
             reason, actor_account_id, recorded_at)
          VALUES (${decisionId}, ${e.id}, ${u.unitKey}, 'RESOLUTION', ${policy.id}, ${JSON.stringify(u.document)}::jsonb,
                  ${u.hash}, ${now.lastDecision.get(u.unitKey) ?? null}, NULL, ${input.actorAccountId}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
        for (const t of changes)
          await this.insertFact(
            ctx,
            now,
            decisionId,
            t.target,
            t.proposed.participantId ?? null,
            t.proposed.digest,
          );
        decisions.push({
          unitKey: u.unitKey,
          decisionId,
          documentHash: u.hash,
          facts: changes.length,
        });
        if (u.kind === 'FIELD')
          materialized += await this.materialize(ctx, now, u, input.actorAccountId);
      }
      await this.assertNoDuplicates(ctx, e.id);
      if (decisions.length > 0) {
        await refreshEventReadModels(ctx, e.id);
        await emitEvent(ctx, {
          eventType: 'AdvancementCommitted',
          aggregateType: 'EVENT',
          aggregateId: e.id as Uuid,
          payload: {
            decisions: decisions.map((d) => ({ unitKey: d.unitKey, documentHash: d.documentHash })),
          },
        });
        await recordAudit(ctx, {
          actorAccountId: input.actorAccountId,
          action: 'event.advancement-committed',
          targetType: 'EVENT',
          targetId: e.id,
          details: { units: decisions.length, facts: decisions.reduce((n, d) => n + d.facts, 0) },
        });
      }
      const response = { decisions, materializedContests: materialized };
      await idem.record(response);
      return { ...response, created: decisions.length > 0 };
    });
  }

  private async insertFact(
    ctx: TxContext,
    s: Structure,
    decisionId: string,
    target: AdvancementTarget,
    participantId: string | null,
    digest: string,
  ) {
    const transitionId =
      target.kind === 'FIELD'
        ? s.transitions.find((t) => t.key === target.transitionKey)?.id
        : undefined;
    await sql`INSERT INTO competition.slot_assignment
        (id, decision_id, event_id, contest_id, slot, transition_id, ordinal, participant_id, digest, recorded_at)
      VALUES (${newId()}, ${decisionId}, ${s.eventId},
              ${target.kind === 'SLOT' ? target.contestId : null}, ${target.kind === 'SLOT' ? target.slot : null},
              ${transitionId ?? null}, ${target.kind === 'FIELD' ? target.ordinal : null},
              ${participantId}, ${digest}, ${ctx.txTime})`.execute(ctx.trx);
  }

  /** An entrant is never moved into or out of a contest that has started (or ended). */
  private async assertDownstreamOpen(
    ctx: TxContext,
    s: Structure,
    changes: readonly { target: AdvancementTarget }[],
  ) {
    const contestIds = new Set<string>();
    for (const { target } of changes) {
      if (target.kind === 'SLOT') contestIds.add(target.contestId);
      else {
        for (const d of s.dependents)
          if (
            d.kind === 'QUALIFIER' &&
            d.transitionKey === target.transitionKey &&
            d.ordinal === target.ordinal
          )
            contestIds.add(d.contestId);
        const rounds = new Set(
          s.rounds.filter((r) => r.dynamicTransitionKey === target.transitionKey).map((r) => r.id),
        );
        for (const c of s.contests) if (rounds.has(c.roundId)) contestIds.add(c.id);
      }
    }
    if (contestIds.size === 0) return;
    const { rows } = await sql<{ id: string; status: string }>`
      SELECT contest_id AS id, status FROM competition.v_contest_current WHERE contest_id = ANY(${[...contestIds]}::uuid[])`.execute(
      ctx.trx,
    );
    const started = rows.filter((r) => !OPEN_CONTEST.includes(r.status));
    if (started.length > 0)
      throw new DomainError(
        DomainErrorCode.INVALID_TRANSITION,
        'a contest this changes has already started; void or cancel it first',
        { reason: 'DOWNSTREAM_STARTED', contests: started.map((r) => r.id).slice(0, 20) },
      );
  }

  /** No entrant occupies two places of the same round (or of the same field). */
  private async assertNoDuplicates(ctx: TxContext, eventId: string) {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM (
        SELECT c.round_id, o.participant_id FROM competition.v_contest_occupant o
        JOIN competition.contest c ON c.id = o.contest_id
        WHERE c.event_id = ${eventId} AND o.participant_id IS NOT NULL
        GROUP BY c.round_id, o.participant_id HAVING count(*) > 1
        UNION ALL
        SELECT a.transition_id, a.participant_id FROM competition.v_slot_assignment_current a
        WHERE a.event_id = ${eventId} AND a.transition_id IS NOT NULL AND a.participant_id IS NOT NULL
        GROUP BY a.transition_id, a.participant_id HAVING count(*) > 1) d`.execute(ctx.trx);
    if ((rows[0]?.n ?? 0) > 0)
      throw new DomainError(
        DomainErrorCode.INVALID_INPUT,
        'an entrant would occupy two places of one round',
        {
          reason: 'DUPLICATE_ENTRANT',
        },
      );
  }

  /**
   * Dynamic rounds of a committed field (after a cut / elimination) get their contests: one per
   * field place for per-entrant contests (SERIES), one field contest otherwise. Additive and
   * idempotent; a place that later becomes vacant keeps its (then vacant) contest. No time, venue
   * or grouping is assigned (05E).
   */
  private async materialize(
    ctx: TxContext,
    s: Structure,
    u: ComputedUnit,
    actor: string,
  ): Promise<number> {
    const transitionKey = u.unitKey.slice('field:'.length);
    const t = s.transitions.find((x) => x.key === transitionKey);
    if (t === undefined || t.kind === 'QUALIFY_BY_PLACE_AND_TIME') return 0;
    const places = u.targets.filter((x) => x.proposed.state === 'RESOLVED').length;
    const firstRound = s.rounds.find((r) => r.stageKey === t.fromStage);
    const contestType =
      s.contests.find((c) => c.roundId === firstRound?.id)?.contestType ?? 'SESSION';
    let created = 0;
    for (const r of s.rounds.filter((x) => x.dynamicTransitionKey === transitionKey)) {
      const keys =
        contestType === 'SERIES'
          ? Array.from({ length: places }, (_, i) => ({
              planKey: `${r.key}-q${i + 1}`,
              ordinal: i + 1,
            }))
          : [{ planKey: `${r.key}-c1`, ordinal: undefined }];
      for (const k of keys) {
        const { rows: exists } = await sql<{ id: string }>`
          SELECT id FROM competition.contest WHERE event_id = ${s.eventId} AND plan_key = ${k.planKey}`.execute(
          ctx.trx,
        );
        if (exists.length > 0) continue;
        const contestId = newId();
        await sql`INSERT INTO competition.contest (id, event_id, round_id, plan_key, sequence, contest_type, recorded_at)
          VALUES (${contestId}, ${s.eventId}, ${r.id}, ${k.planKey},
                  (SELECT coalesce(max(sequence), 0) + 1 FROM competition.contest WHERE event_id = ${s.eventId}),
                  ${contestType}, ${ctx.txTime})`.execute(ctx.trx);
        await sql`INSERT INTO competition.contest_status_change (id, contest_id, status, actor_account_id, recorded_at)
          VALUES (${newId()}, ${contestId}, 'PLANNED', ${actor}, ${ctx.txTime})`.execute(ctx.trx);
        if (k.ordinal !== undefined)
          await sql`INSERT INTO competition.contestant (id, contest_id, slot, source_kind, source_ordinal, source_transition_id, recorded_at)
            VALUES (${newId()}, ${contestId}, 1, 'QUALIFIER', ${k.ordinal}, ${t.id}, ${ctx.txTime})`.execute(
            ctx.trx,
          );
        created += 1;
      }
    }
    if (created > 0)
      await emitEvent(ctx, {
        eventType: 'DynamicContestsMaterialized',
        aggregateType: 'EVENT',
        aggregateId: s.eventId as Uuid,
        payload: { transitionKey, contests: created },
      });
    return created;
  }

  // ───────────────────────────── override ─────────────────────────────

  /**
   * An organizer places an entrant (or nobody) in a dependent target, with a reason
   * (COMP_GENERATE_STRUCTURE). The automatic decision is kept; the override records what it
   * replaces. Refused for a started contest, an entrant who is not ACTIVE in this event, or an
   * entrant already placed in the same round / field.
   */
  async override(input: {
    actorAccountId: string;
    eventId: string;
    target: TargetRef;
    participantId: string | null;
    reason: string;
    idempotencyKey: string;
  }) {
    const reason = text(input.reason, 500, 'reason');
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ decisionId: string }>(ctx, {
        command: 'OverrideAdvancement',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: {
          eventId: input.eventId,
          target: keyOfRef(input.target),
          participantId: input.participantId,
          reason,
        },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      await lockKeys(ctx, `event-structure:${input.eventId}`);
      const e = await loadEvent(ctx, input.eventId);
      await this.authorize(ctx, e, input.actorAccountId, 'COMP_GENERATE_STRUCTURE');
      const s = await this.structure(ctx, e.id);
      if (!ACTIVE_EVENT.includes(s.status))
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          `advancement is closed for a ${s.status} event`,
        );
      if (s.policy === undefined)
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          'no advancement policy is pinned',
          {
            reason: 'POLICY_NOT_PINNED',
          },
        );
      const resolved = await this.resolveTarget(ctx, e.id, input.target);
      if (resolved.kind === 'PARTICIPANT')
        throw new DomainError(
          DomainErrorCode.INVALID_INPUT,
          'a fixed slot is not an advancement target',
          {
            reason: 'NOT_A_DEPENDENT_SLOT',
          },
        );
      const target: AdvancementTarget =
        'contestId' in input.target
          ? { kind: 'SLOT', contestId: input.target.contestId, slot: input.target.slot }
          : {
              kind: 'FIELD',
              transitionKey: input.target.transitionKey,
              ordinal: input.target.ordinal,
            };
      if (target.kind === 'FIELD') {
        const recorded = Math.max(
          0,
          ...[...s.facts.keys()]
            .filter((k) => k.startsWith(`field:${target.transitionKey}:`))
            .map((k) => Number(k.split(':')[2])),
        );
        const capacity = s.dependents.filter(
          (d) => d.kind === 'QUALIFIER' && d.transitionKey === target.transitionKey,
        ).length;
        if (target.ordinal > Math.max(recorded + 1, capacity))
          throw new DomainError(DomainErrorCode.INVALID_INPUT, 'field places are filled in order', {
            reason: 'ORDINAL_OUT_OF_RANGE',
          });
      }
      if (input.participantId !== null && s.entrants[input.participantId]?.status !== 'ACTIVE')
        throw new DomainError(
          DomainErrorCode.INVALID_INPUT,
          'the entrant is not an active participant of this event',
          {
            reason: 'ENTRANT_NOT_ELIGIBLE',
          },
        );
      await this.assertDownstreamOpen(ctx, s, [{ target }]);
      const current = s.facts.get(targetKey(target));
      const assignment: AdvancementAssignment = {
        target,
        state: input.participantId === null ? 'VACANT' : 'RESOLVED',
        ...(input.participantId === null ? {} : { participantId: input.participantId }),
        ...(input.participantId === null ? { reason: 'MANUAL_VACANCY' } : {}),
        provenance: {
          family: 'MANUAL_OVERRIDE',
          source: overrideSource(s, target),
          ...(current === undefined
            ? {}
            : {
                replaces: {
                  ...(current.participantId === null
                    ? {}
                    : { participantId: current.participantId }),
                  assignmentDigest: current.digest,
                },
              }),
        } as AdvancementProvenance,
      };
      const unitKey = `override:${targetKey(target).replace(/^(slot|field):/, '$1-')}`;
      const { document, hash } = advancementDecision({
        eventId: e.id,
        unit: unitKey,
        kind: 'OVERRIDE',
        policy: s.policy.ref,
        reason,
        assignments: [assignment],
      });
      const decisionId = newId();
      await sql`INSERT INTO competition.advancement_decision
          (id, event_id, unit_key, kind, advancement_policy_version_id, document, document_hash, supersedes_decision_id,
           reason, actor_account_id, recorded_at)
        VALUES (${decisionId}, ${e.id}, ${unitKey}, 'OVERRIDE', ${s.policy.id}, ${JSON.stringify(document)}::jsonb, ${hash},
                ${current?.decisionId ?? null}, ${reason}, ${input.actorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await this.insertFact(
        ctx,
        s,
        decisionId,
        target,
        input.participantId,
        document.assignments[0]?.digest as string,
      );
      await this.assertNoDuplicates(ctx, e.id);
      await refreshEventReadModels(ctx, e.id);
      await emitEvent(ctx, {
        eventType: 'AdvancementOverridden',
        aggregateType: 'EVENT',
        aggregateId: e.id as Uuid,
        payload: { target: targetKey(target), documentHash: hash },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'event.advancement-overridden',
        targetType: 'EVENT',
        targetId: e.id,
        details: { target: targetKey(target), decisionId },
      });
      await idem.record({ decisionId });
      return { decisionId, created: true };
    });
  }

  /**
   * Reverses an override explicitly (COMP_GENERATE_STRUCTURE, with a reason). The target returns to
   * its latest automatic fact (whose staleness is then judged as usual), or to unresolved.
   */
  async revokeOverride(input: {
    actorAccountId: string;
    eventId: string;
    target: TargetRef;
    reason: string;
    idempotencyKey: string;
  }) {
    const reason = text(input.reason, 500, 'reason');
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ decisionId: string }>(ctx, {
        command: 'RevokeAdvancementOverride',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { eventId: input.eventId, target: keyOfRef(input.target), reason },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      await lockKeys(ctx, `event-structure:${input.eventId}`);
      const e = await loadEvent(ctx, input.eventId);
      await this.authorize(ctx, e, input.actorAccountId, 'COMP_GENERATE_STRUCTURE');
      const s = await this.structure(ctx, e.id);
      if (s.policy === undefined || !ACTIVE_EVENT.includes(s.status))
        throw new DomainError(DomainErrorCode.INVALID_TRANSITION, 'advancement is closed');
      await this.resolveTarget(ctx, e.id, input.target);
      const target: AdvancementTarget =
        'contestId' in input.target
          ? { kind: 'SLOT', contestId: input.target.contestId, slot: input.target.slot }
          : {
              kind: 'FIELD',
              transitionKey: input.target.transitionKey,
              ordinal: input.target.ordinal,
            };
      const current = s.facts.get(targetKey(target));
      if (current?.decisionKind !== 'OVERRIDE')
        throw new DomainError(DomainErrorCode.INVALID_TRANSITION, 'the target is not overridden', {
          reason: 'NOT_OVERRIDDEN',
        });
      await this.assertDownstreamOpen(ctx, s, [{ target }]);
      const transitionId =
        target.kind === 'FIELD'
          ? s.transitions.find((t) => t.key === target.transitionKey)?.id
          : null;
      const { rows: automatic } = await sql<{ participant_id: string | null; digest: string }>`
        SELECT a.participant_id, a.digest FROM competition.slot_assignment a
        JOIN competition.advancement_decision d ON d.id = a.decision_id AND d.kind = 'RESOLUTION'
        WHERE a.event_id = ${e.id}
          AND ${target.kind === 'SLOT' ? target.contestId : null}::uuid IS NOT DISTINCT FROM a.contest_id
          AND ${target.kind === 'SLOT' ? target.slot : null}::int IS NOT DISTINCT FROM a.slot
          AND ${transitionId ?? null}::uuid IS NOT DISTINCT FROM a.transition_id
          AND ${target.kind === 'FIELD' ? target.ordinal : null}::int IS NOT DISTINCT FROM a.ordinal
        ORDER BY a.seq DESC LIMIT 1`.execute(ctx.trx);
      const restore = automatic[0];
      const unitKey = `override:${targetKey(target).replace(/^(slot|field):/, '$1-')}`;
      const { document, hash } = advancementDecision({
        eventId: e.id,
        unit: unitKey,
        kind: 'OVERRIDE_REVOKED',
        policy: s.policy.ref,
        reason,
        assignments: [
          {
            target,
            state:
              restore === undefined
                ? 'PENDING'
                : restore.participant_id === null
                  ? 'VACANT'
                  : 'RESOLVED',
            ...(restore === undefined || restore.participant_id === null
              ? {}
              : { participantId: restore.participant_id }),
            reason: 'OVERRIDE_REVOKED',
            provenance: {
              family: 'MANUAL_OVERRIDE',
              source: { kind: 'REVOKED' },
              replaces: {
                ...(current.participantId === null ? {} : { participantId: current.participantId }),
                assignmentDigest: current.digest,
              },
            } as AdvancementProvenance,
          },
        ],
      });
      const decisionId = newId();
      await sql`INSERT INTO competition.advancement_decision
          (id, event_id, unit_key, kind, advancement_policy_version_id, document, document_hash, supersedes_decision_id,
           reason, actor_account_id, recorded_at)
        VALUES (${decisionId}, ${e.id}, ${unitKey}, 'OVERRIDE_REVOKED', ${s.policy.id}, ${JSON.stringify(document)}::jsonb, ${hash},
                ${current.decisionId}, ${reason}, ${input.actorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      // The restored fact carries the automatic digest (so it is judged RESOLVED / STALE as usual).
      await this.insertFact(
        ctx,
        s,
        decisionId,
        target,
        restore?.participant_id ?? null,
        restore?.digest ?? revokedPlaceholder(target),
      );
      await this.assertNoDuplicates(ctx, e.id);
      await refreshEventReadModels(ctx, e.id);
      await emitEvent(ctx, {
        eventType: 'AdvancementOverrideRevoked',
        aggregateType: 'EVENT',
        aggregateId: e.id as Uuid,
        payload: { target: targetKey(target), documentHash: hash },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'event.advancement-override-revoked',
        targetType: 'EVENT',
        targetId: e.id,
        details: { target: targetKey(target), decisionId },
      });
      await idem.record({ decisionId });
      return { decisionId, created: true };
    });
  }

  // ───────────────────────────── start guard ─────────────────────────────

  /**
   * Targets of a contest that are not trustworthy right now (STALE, or unresolved). Used to refuse
   * starting a contest whose occupant no longer follows from current official results.
   */
  async contestBlockers(contestId: string): Promise<string[]> {
    const eventId = await this.tx(async (ctx) => {
      const { rows } = await sql<{ event_id: string }>`
        SELECT event_id FROM competition.contest WHERE id = ${contestId}`.execute(ctx.trx);
      return rows[0]?.event_id;
    });
    if (eventId === undefined) return [];
    const { s, units } = await this.compute(eventId);
    const feeds = new Set(
      s.dependents
        .filter((d) => d.contestId === contestId && d.kind === 'QUALIFIER')
        .map((d) =>
          targetKey({
            kind: 'FIELD',
            transitionKey: d.transitionKey as string,
            ordinal: d.ordinal as number,
          }),
        ),
    );
    const contest = s.contests.find((c) => c.id === contestId);
    const dynamic = s.rounds.find((r) => r.id === contest?.roundId)?.dynamicTransitionKey ?? null;
    return units
      .flatMap((u) => u.targets)
      .filter(
        (t) =>
          (t.target.kind === 'SLOT' && t.target.contestId === contestId) ||
          feeds.has(t.key) ||
          (dynamic !== null && t.target.kind === 'FIELD' && t.target.transitionKey === dynamic),
      )
      .filter((t) => t.state === 'STALE')
      .map((t) => t.key);
  }
}

function overrideSource(s: Structure, target: AdvancementTarget): AdvancementProvenance['source'] {
  if (target.kind === 'FIELD')
    return { kind: 'QUALIFIER', transitionKey: target.transitionKey, ordinal: target.ordinal };
  const d = s.dependents.find((x) => x.contestId === target.contestId && x.slot === target.slot);
  if (d === undefined) return { kind: 'SLOT' };
  return {
    kind: d.kind,
    ...(d.sourceContestId === null ? {} : { contestId: d.sourceContestId }),
    ...(d.stageKey === null ? {} : { stageKey: d.stageKey }),
    ...(d.groupKey === null ? {} : { groupKey: d.groupKey }),
    ...(d.rank === null ? {} : { rank: d.rank }),
    ...(d.ordinal === null ? {} : { ordinal: d.ordinal }),
    ...(d.transitionKey === null ? {} : { transitionKey: d.transitionKey }),
  };
}
