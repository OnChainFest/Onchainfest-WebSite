import type { BrObjectSchema } from '@br/canonical';
import type { ContestType, ParticipantKind } from '../catalog';

/**
 * Competition format engine port (BRT-05). An engine is a PURE, deterministic function:
 * (confirmed field + seed order + validated configuration) → logical plan. No database, clock or
 * randomness. The plan is persisted separately and is then historical fact: it is never
 * regenerated from engine code after the fact (engine semantics are versioned instead).
 */

/** BRT-01 §5.3 round types. */
export const RoundType = {
  QUALIFYING: 'QUALIFYING',
  GROUP: 'GROUP',
  HEAT: 'HEAT',
  KNOCKOUT: 'KNOCKOUT',
  REPECHAGE: 'REPECHAGE',
  FINAL: 'FINAL',
  SESSION: 'SESSION',
} as const;
export type RoundType = (typeof RoundType)[keyof typeof RoundType];

/**
 * Where a contest slot's occupant comes from. Only PARTICIPANT is resolved at generation time;
 * dependency sources stay unresolved until a trustworthy sporting outcome exists (never because
 * an organizer says so, and never because a contest is operationally COMPLETED).
 */
export const SlotSource = {
  PARTICIPANT: 'PARTICIPANT',
  WINNER_OF_CONTEST: 'WINNER_OF_CONTEST',
  LOSER_OF_CONTEST: 'LOSER_OF_CONTEST',
  RANK_FROM_STAGE: 'RANK_FROM_STAGE',
} as const;
export type SlotSource = (typeof SlotSource)[keyof typeof SlotSource];

export interface PlanSlot {
  readonly slot: number;
  readonly source: SlotSource;
  /** PARTICIPANT only. */
  readonly participantId?: string;
  /** WINNER_OF_CONTEST / LOSER_OF_CONTEST: key of a contest in the same plan. */
  readonly contestKey?: string;
}

export interface PlanContest {
  /** Stable logical key within the plan, e.g. "r2-c1". */
  readonly key: string;
  /** 1-based order within the event. */
  readonly sequence: number;
  readonly contestType: ContestType;
  readonly slots: readonly PlanSlot[];
}

export interface PlanRound {
  readonly key: string;
  readonly sequence: number;
  readonly roundType: RoundType;
  /** Presentation label only; semantics live in sequence/roundType/structure. */
  readonly label: string;
  /** Participants who sit out this round (round-robin BYE; not a contest, not a result). */
  readonly byes: readonly string[];
  readonly contests: readonly PlanContest[];
}

/** Logical plan (hashed as `br:competition-plan@1`). */
export interface PlanDocument {
  readonly engineId: string;
  readonly engineVersion: number;
  readonly rounds: readonly PlanRound[];
}

export interface FieldEntry {
  readonly participantId: string;
  readonly kind: ParticipantKind;
}

export interface FormatEngineInput {
  readonly eventId: string;
  /** The locked field. */
  readonly participants: readonly FieldEntry[];
  /** Participant ids, seed 1 first; must be a permutation of the field. */
  readonly seedOrder: readonly string[];
  /** Configuration already validated against `configurationSchema`. */
  readonly config: Readonly<Record<string, unknown>>;
  /** From the pinned DisciplineVersion. */
  readonly allowedContestTypes: readonly ContestType[];
}

export class FormatEngineError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'FormatEngineError';
    this.reason = reason;
  }
}

export interface CompetitionFormatEngine {
  /** Stable engine id (e.g. "single-elimination"). */
  readonly id: string;
  /** Semantic version: any change to generated structure ⇒ a new version. */
  readonly version: number;
  readonly displayName: string;
  /** BR-JSON schema of the per-event configuration. */
  readonly configurationSchema: BrObjectSchema;
  /** Contest type produced; the discipline must allow it. */
  readonly contestType: ContestType;
  readonly minParticipants: number;
  readonly maxParticipants: number;
  generate(input: FormatEngineInput): PlanDocument;
}

/** "single-elimination/1" */
export function engineRef(engine: Pick<CompetitionFormatEngine, 'id' | 'version'>): string {
  return `${engine.id}/${engine.version}`;
}

/** Shared input checks: field size, contest type, seed order is an exact permutation. */
export function assertEngineInput(engine: CompetitionFormatEngine, input: FormatEngineInput): void {
  const n = input.participants.length;
  if (n < engine.minParticipants || n > engine.maxParticipants) {
    throw new FormatEngineError(
      'FIELD_SIZE',
      `${engineRef(engine)} supports ${engine.minParticipants}–${engine.maxParticipants} participants (got ${n})`,
    );
  }
  if (!input.allowedContestTypes.includes(engine.contestType)) {
    throw new FormatEngineError(
      'CONTEST_TYPE_NOT_ALLOWED',
      `${engineRef(engine)} produces ${engine.contestType} contests, which this discipline does not allow`,
    );
  }
  const ids = new Set(input.participants.map((p) => p.participantId));
  if (ids.size !== n)
    throw new FormatEngineError('DUPLICATE_PARTICIPANT', 'duplicate participant in field');
  const seeds = new Set(input.seedOrder);
  if (
    seeds.size !== input.seedOrder.length ||
    seeds.size !== n ||
    ![...seeds].every((s) => ids.has(s))
  ) {
    throw new FormatEngineError(
      'SEED_ORDER',
      'seed order must be a permutation of the locked field',
    );
  }
  if (
    Object.keys(input.config).length > 0 &&
    Object.keys(engine.configurationSchema.properties).length === 0
  ) {
    throw new FormatEngineError('CONFIG', 'this engine takes no configuration');
  }
}
