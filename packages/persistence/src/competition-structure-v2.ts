import {
  type DisciplineVersionSpec,
  type FieldSnapshotV2,
  type PlanDocumentV2,
  type PlanSlotV2,
} from '@br/competition';
import { DomainError, DomainErrorCode, newId } from '@br/domain';
import { sql } from 'kysely';
import { activeTeamMembers } from './competition-store';
import type { TxContext } from './tx';

/**
 * ONCF-05B persistence of the v2 competition documents (ADR-0054, -0056, -0057). Used by the
 * StructureStore only for events pinned to a v2 DisciplineVersion (field, attributes, roster) or a
 * v2 format engine (stage-graph plans); every v1 event keeps the exact BRT-05 path.
 */

export interface LockedParticipant {
  readonly participantId: string;
  readonly registrationId: string;
  readonly kind: 'INDIVIDUAL' | 'TEAM';
  readonly athleteId: string | null;
  readonly teamId: string | null;
}

export async function disciplineSpec(
  ctx: TxContext,
  disciplineVersionId: string,
): Promise<DisciplineVersionSpec> {
  const { rows } = await sql<{ spec: DisciplineVersionSpec }>`
    SELECT spec FROM sports.discipline_version WHERE id = ${disciplineVersionId}`.execute(ctx.trx);
  const spec = rows[0]?.spec;
  if (spec === undefined)
    throw new DomainError(DomainErrorCode.NOT_FOUND, 'pinned discipline version not found');
  return spec;
}

/**
 * Freezes the v2 field at lock: each TEAM participant's ACTIVE members (roster snapshot, bounded
 * by the discipline's roster) and every participant's current declared entry attributes (only keys
 * the discipline declares). Rows are append-only facts; the snapshot is hashed as
 * `br:competition-field@2`. Missing required attributes or out-of-bounds rosters refuse the lock
 * (the organizer resolves the entry first — nothing is silently dropped).
 */
export async function snapshotFieldV2(
  ctx: TxContext,
  eventId: string,
  participants: readonly LockedParticipant[],
  spec: DisciplineVersionSpec,
): Promise<FieldSnapshotV2> {
  const declared = new Map((spec.entryAttributes ?? []).map((a) => [a.key, a]));
  const regIds = participants.map((p) => p.registrationId);
  const { rows: attrRows } = await sql<{
    registration_id: string;
    attribute_key: string;
    athlete_id: string | null;
    value: string;
  }>`
    SELECT registration_id, attribute_key, athlete_id, value FROM competition.v_registration_entry_attribute_current
    WHERE registration_id = ANY(${regIds}::uuid[])`.execute(ctx.trx);
  const byReg = new Map<string, typeof attrRows>();
  for (const r of attrRows)
    byReg.set(r.registration_id, [...(byReg.get(r.registration_id) ?? []), r]);

  const roster = spec.participation.roster;
  const problems: string[] = [];
  const out: FieldSnapshotV2['participants'][number][] = [];
  for (const p of participants) {
    const members =
      p.kind === 'TEAM'
        ? [...(await activeTeamMembers(ctx, p.teamId as string, ctx.txTime))].sort()
        : [];
    if (
      p.kind === 'TEAM' &&
      roster !== undefined &&
      (members.length < roster.min || members.length > roster.max)
    )
      problems.push(
        `team entry ${p.registrationId} has ${members.length} active members (roster ${roster.min}–${roster.max})`,
      );
    const rows = (byReg.get(p.registrationId) ?? []).filter((r) => {
      const d = declared.get(r.attribute_key);
      if (d === undefined) return false;
      return d.scope === 'MEMBER'
        ? r.athlete_id !== null && members.includes(r.athlete_id)
        : r.athlete_id === null;
    });
    for (const d of declared.values())
      if (d.required && d.scope === 'PARTICIPANT' && !rows.some((r) => r.attribute_key === d.key))
        problems.push(`entry ${p.registrationId} is missing the required attribute ${d.key}`);
    const attributes = rows
      .filter((r) => r.athlete_id === null)
      .map((r) => ({ key: r.attribute_key, value: r.value }))
      .sort((a, b) => (a.key < b.key ? -1 : 1));
    const memberAttributes = rows
      .filter((r) => r.athlete_id !== null)
      .map((r) => ({ athleteId: r.athlete_id as string, key: r.attribute_key, value: r.value }))
      .sort((a, b) =>
        a.athleteId === b.athleteId ? (a.key < b.key ? -1 : 1) : a.athleteId < b.athleteId ? -1 : 1,
      );
    out.push({
      participantId: p.participantId,
      registrationId: p.registrationId,
      kind: p.kind,
      ...(p.athleteId === null ? {} : { athleteId: p.athleteId }),
      ...(p.teamId === null ? {} : { teamId: p.teamId }),
      ...(p.kind === 'TEAM' ? { roster: members } : {}),
      ...(attributes.length === 0 ? {} : { attributes }),
      ...(memberAttributes.length === 0 ? {} : { memberAttributes }),
    });
  }
  if (problems.length > 0)
    throw new DomainError(DomainErrorCode.INVALID_INPUT, 'the field cannot be locked yet', {
      reason: 'FIELD_INCOMPLETE',
      problems: problems.slice(0, 20),
    });
  for (const p of out) {
    for (const athleteId of p.roster ?? [])
      await sql`INSERT INTO competition.participant_roster_member (participant_id, athlete_id, recorded_at)
        VALUES (${p.participantId}, ${athleteId}, ${ctx.txTime})`.execute(ctx.trx);
    for (const a of p.attributes ?? [])
      await sql`INSERT INTO competition.participant_entry_attribute (participant_id, attribute_key, athlete_id, value, recorded_at)
        VALUES (${p.participantId}, ${a.key}, NULL, ${a.value}, ${ctx.txTime})`.execute(ctx.trx);
    for (const a of p.memberAttributes ?? [])
      await sql`INSERT INTO competition.participant_entry_attribute (participant_id, attribute_key, athlete_id, value, recorded_at)
        VALUES (${p.participantId}, ${a.key}, ${a.athleteId}, ${a.value}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
  }
  return {
    eventId,
    participants: out.sort((a, b) => (a.participantId < b.participantId ? -1 : 1)),
  };
}

/** participantId → frozen value of a PARTICIPANT-scope attribute (seeding by entry attribute). */
export async function frozenAttribute(
  ctx: TxContext,
  eventId: string,
  key: string,
): Promise<Map<string, string>> {
  const { rows } = await sql<{ participant_id: string; value: string }>`
    SELECT a.participant_id, a.value FROM competition.participant_entry_attribute a
    JOIN competition.participant p ON p.id = a.participant_id
    WHERE p.event_id = ${eventId} AND a.attribute_key = ${key} AND a.athlete_id IS NULL`.execute(
    ctx.trx,
  );
  return new Map(rows.map((r) => [r.participant_id, r.value]));
}

/** The roster frozen at lock for a TEAM participant, or undefined for v1 fields (no snapshot). */
export async function frozenRoster(
  ctx: TxContext,
  participantId: string,
): Promise<string[] | undefined> {
  const { rows } = await sql<{ athlete_id: string; v: number }>`
    SELECT m.athlete_id, f.field_version AS v FROM competition.participant p
    JOIN competition.event_field f ON f.event_id = p.event_id
    LEFT JOIN competition.participant_roster_member m ON m.participant_id = p.id
    WHERE p.id = ${participantId}`.execute(ctx.trx);
  if (rows[0]?.v !== 2) return undefined;
  return rows.flatMap((r) => (r.athlete_id === null ? [] : [r.athlete_id]));
}

/**
 * Materializes a v2 plan: stages, transitions, rounds (with stage / group / dynamic entry), contests
 * (with partition), contestant slots (dependencies keep their stage / group / transition refs and
 * stay UNRESOLVED) and field entries (bulk; no 64 ceiling). Returns the number of contests.
 */
export async function materializePlanV2(
  ctx: TxContext,
  eventId: string,
  actorAccountId: string,
  plan: PlanDocumentV2,
): Promise<number> {
  const stageIds = new Map<string, string>();
  for (const s of plan.stages) {
    const id = newId();
    stageIds.set(s.key, id);
    await sql`INSERT INTO competition.stage (id, event_id, plan_key, sequence, primitive, label, partition_kind, partition_method, recorded_at)
      VALUES (${id}, ${eventId}, ${s.key}, ${s.sequence}, ${s.primitive}, ${s.label}, ${s.partition?.kind ?? null},
              ${s.partition?.method ?? null}, ${ctx.txTime})`.execute(ctx.trx);
  }
  const stageId = (key: string | undefined) => {
    const id = key === undefined ? undefined : stageIds.get(key);
    if (id === undefined) throw new Error(`plan references unknown stage ${key}`);
    return id;
  };
  const transitionIds = new Map<string, string>();
  for (const t of plan.transitions) {
    const id = newId();
    transitionIds.set(t.key, id);
    await sql`INSERT INTO competition.stage_transition (id, event_id, plan_key, kind, from_stage_id, to_stage_id, after_round_plan_key, params, recorded_at)
      VALUES (${id}, ${eventId}, ${t.key}, ${t.kind}, ${stageId(t.fromStage)}, ${stageId(t.toStage)}, ${t.afterRound ?? null},
              ${JSON.stringify(t.params)}::jsonb, ${ctx.txTime})`.execute(ctx.trx);
  }
  const contestIds = new Map<string, string>();
  let contests = 0;
  const slotValues = (s: PlanSlotV2) => {
    const sourceContest = s.contestKey === undefined ? null : contestIds.get(s.contestKey);
    if (s.contestKey !== undefined && sourceContest === undefined)
      throw new Error(`plan dependency ${s.contestKey} precedes its source`);
    const transition = s.transitionKey === undefined ? null : transitionIds.get(s.transitionKey);
    if (s.transitionKey !== undefined && transition === undefined)
      throw new Error(`plan references unknown transition ${s.transitionKey}`);
    return {
      participant: s.participantId ?? null,
      contest: sourceContest ?? null,
      rank: s.rank ?? null,
      stage: s.stageKey === undefined ? null : stageId(s.stageKey),
      group: s.groupKey ?? null,
      ordinal: s.ordinal ?? null,
      transition: transition ?? null,
    };
  };
  for (const round of plan.rounds) {
    const roundId = newId();
    await sql`INSERT INTO competition.round (id, event_id, plan_key, sequence, round_type, label, byes, stage_id, group_key, dynamic_transition_key, recorded_at)
      VALUES (${roundId}, ${eventId}, ${round.key}, ${round.sequence}, ${round.roundType}, ${round.label}, ${[...round.byes]}::uuid[],
              ${stageId(round.stageKey)}, ${round.groupKey ?? null}, ${round.dynamicEntry?.transitionKey ?? null}, ${ctx.txTime})`.execute(
      ctx.trx,
    );
    for (const c of round.contests) {
      const contestId = newId();
      contestIds.set(c.key, contestId);
      contests += 1;
      await sql`INSERT INTO competition.contest (id, event_id, round_id, plan_key, sequence, contest_type, partition_key, recorded_at)
        VALUES (${contestId}, ${eventId}, ${roundId}, ${c.key}, ${c.sequence}, ${c.contestType}, ${c.partitionKey ?? null}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await sql`INSERT INTO competition.contest_status_change (id, contest_id, status, actor_account_id, recorded_at)
        VALUES (${newId()}, ${contestId}, 'PLANNED', ${actorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      for (const s of c.slots) {
        const v = slotValues(s);
        await sql`INSERT INTO competition.contestant (id, contest_id, slot, source_kind, participant_id, source_contest_id, source_rank,
                    source_stage_id, source_group_key, source_ordinal, source_transition_id, recorded_at)
          VALUES (${newId()}, ${contestId}, ${s.slot}, ${s.source}, ${v.participant}, ${v.contest}, ${v.rank},
                  ${v.stage}, ${v.group}, ${v.ordinal}, ${v.transition}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
      }
      const entries = c.entries ?? [];
      for (let i = 0; i < entries.length; i += 2000) {
        const chunk = entries.slice(i, i + 2000);
        await sql`INSERT INTO competition.contest_entry (contest_id, participant_id, start_order, start_offset_seconds, recorded_at)
          SELECT ${contestId}, e.participant_id, e.position, e.start_offset_seconds, ${ctx.txTime}
          FROM unnest(${chunk.map((e) => e.participantId)}::uuid[], ${chunk.map((e) => e.position)}::int[],
                      ${chunk.map((e) => e.startOffsetSeconds ?? null)}::int[])
               AS e(participant_id, position, start_offset_seconds)`.execute(ctx.trx);
      }
    }
  }
  return contests;
}
