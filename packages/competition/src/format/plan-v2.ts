import type { ContestType } from '../catalog';
import type { PartitionKind, StartMethod } from '../capabilities';
import type { RoundType } from './engine';

/**
 * Plan document v2 (`br:competition-plan@2`, ADR-0054): a stage graph.
 *
 * v1 plans (single-stage, ≤ 64 slots per contest) are untouched and keep their schema. A v2 plan
 * adds stages, cross-stage transitions, field entries without the 64-slot ceiling, partitions,
 * dependent slots that name their stage/group/transition, and DYNAMIC rounds whose field is only
 * known once a transition resolves (a golf cut "top N and ties", cycling non-finisher
 * elimination). One immutable plan per event still holds: dynamic rounds are materialized by
 * advancement (ONCF-05D) as resolution facts, never by regenerating the plan.
 */

/** The four stage primitives (ONCF-05A §4). */
export const StagePrimitive = {
  KNOCKOUT: 'KNOCKOUT',
  ROUND_ROBIN: 'ROUND_ROBIN',
  FIELD: 'FIELD',
  HEATS: 'HEATS',
} as const;
export type StagePrimitive = (typeof StagePrimitive)[keyof typeof StagePrimitive];

export interface PlanStage {
  /** "s1", "s2", … */
  readonly key: string;
  readonly sequence: number;
  readonly primitive: StagePrimitive;
  readonly label: string;
  /** Partitions of this stage (groups, heats, waves, tee groups) and what they mean. */
  readonly partition?: { readonly kind: PartitionKind; readonly method: StartMethod | 'GROUPS' };
}

export const TransitionKind = {
  /** Group rank → knockout slot (fixed crossover). */
  RANK_FROM_GROUP: 'RANK_FROM_GROUP',
  /** Q by place per heat + q fastest of the rest. */
  QUALIFY_BY_PLACE_AND_TIME: 'QUALIFY_BY_PLACE_AND_TIME',
  /** Top N (and ties) after a round continue. */
  CUT: 'CUT',
  /** Entrants without a finish (DNF/DNS/DQ) leave a multi-round classification. */
  ELIMINATE_NON_FINISHERS: 'ELIMINATE_NON_FINISHERS',
  /** Qualifying rank → stepladder seat; winners climb. */
  STEPLADDER: 'STEPLADDER',
  /** Qualifying rank → seeded knockout bracket. */
  RANK_TO_BRACKET: 'RANK_TO_BRACKET',
} as const;
export type TransitionKind = (typeof TransitionKind)[keyof typeof TransitionKind];

export interface PlanTransition {
  /** "t1", "t2", … */
  readonly key: string;
  readonly kind: TransitionKind;
  readonly fromStage: string;
  readonly toStage: string;
  /** Round of `fromStage` the transition reads (multi-round cut / elimination). */
  readonly afterRound?: string;
  /** Closed, flat integer/boolean parameters (e.g. qualifyByPlace, qualifyByTime, topN, includeTies). */
  readonly params: Readonly<Record<string, number | boolean>>;
}

export const SlotSourceV2 = {
  PARTICIPANT: 'PARTICIPANT',
  WINNER_OF_CONTEST: 'WINNER_OF_CONTEST',
  LOSER_OF_CONTEST: 'LOSER_OF_CONTEST',
  /** rank `rank` of stage `stageKey` (and group `groupKey` when the stage has groups). */
  RANK_FROM_STAGE: 'RANK_FROM_STAGE',
  /** the `ordinal`-th best entrant of rank `rank` across the groups of `stageKey`. */
  BEST_RANKED_FROM_STAGE: 'BEST_RANKED_FROM_STAGE',
  /** the `ordinal`-th qualifier of transition `transitionKey` (heats → final). */
  QUALIFIER: 'QUALIFIER',
} as const;
export type SlotSourceV2 = (typeof SlotSourceV2)[keyof typeof SlotSourceV2];

export interface PlanSlotV2 {
  /** 1..64. For lane contests the slot number IS the lane. */
  readonly slot: number;
  readonly source: SlotSourceV2;
  readonly participantId?: string;
  readonly contestKey?: string;
  readonly stageKey?: string;
  readonly groupKey?: string;
  readonly rank?: number;
  readonly ordinal?: number;
  readonly transitionKey?: string;
}

/** A field entry (FIELD contests; no 64 ceiling). `position` = start order, lane or grid spot. */
export interface PlanEntry {
  readonly participantId: string;
  readonly position: number;
  /** Interval starts: seconds after the contest's start. */
  readonly startOffsetSeconds?: number;
}

export interface PlanContestV2 {
  readonly key: string;
  readonly sequence: number;
  readonly contestType: ContestType;
  /** Logistic or competitive partition this contest belongs to ("w2", "h3", "t17", "g1"). */
  readonly partitionKey?: string;
  readonly slots: readonly PlanSlotV2[];
  readonly entries?: readonly PlanEntry[];
}

export interface PlanRoundV2 {
  readonly key: string;
  readonly sequence: number;
  readonly roundType: RoundType;
  readonly label: string;
  readonly stageKey: string;
  /** Competitive group of a ROUND_ROBIN stage ("g1"). */
  readonly groupKey?: string;
  readonly byes: readonly string[];
  /** Field known only when this transition resolves; contests are materialized by advancement. */
  readonly dynamicEntry?: { readonly transitionKey: string };
  readonly contests: readonly PlanContestV2[];
}

export interface PlanDocumentV2 {
  readonly planVersion: 2;
  readonly engineId: string;
  readonly engineVersion: number;
  readonly stages: readonly PlanStage[];
  readonly transitions: readonly PlanTransition[];
  readonly rounds: readonly PlanRoundV2[];
}

export function isPlanV2(plan: { readonly planVersion?: number }): plan is PlanDocumentV2 {
  return plan.planVersion === 2;
}

/** Sequencer shared by the stage primitives so that round and contest sequences stay global. */
export class PlanBuilder {
  private roundSeq = 0;
  private contestSeq = 0;
  readonly stages: PlanStage[] = [];
  readonly transitions: PlanTransition[] = [];
  readonly rounds: PlanRoundV2[] = [];

  stage(primitive: StagePrimitive, label: string, partition?: PlanStage['partition']): string {
    const key = `s${this.stages.length + 1}`;
    this.stages.push({
      key,
      sequence: this.stages.length + 1,
      primitive,
      label,
      ...(partition === undefined ? {} : { partition }),
    });
    return key;
  }

  transition(t: Omit<PlanTransition, 'key'>): string {
    const key = `t${this.transitions.length + 1}`;
    this.transitions.push({ key, ...t });
    return key;
  }

  nextContestSequence(): number {
    this.contestSeq += 1;
    return this.contestSeq;
  }

  round(r: Omit<PlanRoundV2, 'sequence'>): PlanRoundV2 {
    this.roundSeq += 1;
    const round = { ...r, sequence: this.roundSeq };
    this.rounds.push(round);
    return round;
  }

  build(engineId: string, engineVersion: number): PlanDocumentV2 {
    return {
      planVersion: 2,
      engineId,
      engineVersion,
      stages: this.stages,
      transitions: this.transitions,
      rounds: this.rounds,
    };
  }
}
