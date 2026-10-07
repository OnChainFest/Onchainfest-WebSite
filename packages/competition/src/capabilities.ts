import type { ContestType, DisciplineVersionSpec, ParticipantKind } from './catalog';
import type { RulesetFamily } from './ruleset';

/**
 * Capability-driven compatibility — ONCF-05B (ADR-0053).
 *
 * A DisciplineVersion PROVIDES capabilities; a format engine (and, in ONCF-05C, a Ruleset)
 * REQUIRES them. A modality × format combination is valid iff every requirement is provided.
 * One generic function decides it everywhere (catalog read, event creation, plan generation).
 * Binding rule: no engine, store or UI branches on sport identity; a mismatch names the missing
 * capability, never the sport.
 */

/** How entrants start in a field (FIELD / HEATS stages). */
export const StartMethod = {
  /** One start for the whole field (mass start). */
  SINGLE_START: 'SINGLE_START',
  /** Several consecutive start waves (logistic partitions). */
  WAVE_START: 'WAVE_START',
  /** One start per entrant at a fixed interval (time trial). */
  INTERVAL_START: 'INTERVAL_START',
  /** Heats with lanes (track, pool). */
  LANE_HEATS: 'LANE_HEATS',
  /** Per-entrant contests grouped for scheduling (golf tee groups, bowling squads). */
  GROUPED_ENTRANTS: 'GROUPED_ENTRANTS',
} as const;
export type StartMethod = (typeof StartMethod)[keyof typeof StartMethod];

/**
 * LOGISTIC partitions only organize the field (everyone is classified together: running waves,
 * swimming timed-final heats, golf tee groups, bowling squads). COMPETITIVE partitions classify
 * within the partition for qualification (padel groups, track heats, swimming championship heats).
 */
export const PartitionKind = { LOGISTIC: 'LOGISTIC', COMPETITIVE: 'COMPETITIVE' } as const;
export type PartitionKind = (typeof PartitionKind)[keyof typeof PartitionKind];

/** Schedulable resource vocabulary (data). Resources themselves arrive in ONCF-05E. */
export const ResourceType = {
  TENNIS_COURT: 'TENNIS_COURT',
  PADEL_COURT: 'PADEL_COURT',
  BASKETBALL_COURT: 'BASKETBALL_COURT',
  BASKETBALL_HALF_COURT: 'BASKETBALL_HALF_COURT',
  BOWLING_LANE_PAIR: 'BOWLING_LANE_PAIR',
  POOL: 'POOL',
  TRACK: 'TRACK',
  ROAD_COURSE: 'ROAD_COURSE',
  OPEN_WATER_COURSE: 'OPEN_WATER_COURSE',
  CYCLING_COURSE: 'CYCLING_COURSE',
  GOLF_COURSE: 'GOLF_COURSE',
} as const;
export type ResourceType = (typeof ResourceType)[keyof typeof ResourceType];

export const EntryAttributeValueType = {
  /** Non-negative integer milliseconds (entry time, predicted time). */
  DURATION_MS: 'DURATION_MS',
  INTEGER: 'INTEGER',
  /** Canonical decimal string (handicap index, classification points). */
  DECIMAL: 'DECIMAL',
  /** Short label (bib, age band, team affiliation). */
  TEXT: 'TEXT',
} as const;
export type EntryAttributeValueType =
  (typeof EntryAttributeValueType)[keyof typeof EntryAttributeValueType];

/** Capabilities a v2 DisciplineVersion declares explicitly. */
export interface DisciplineCapabilitiesSpec {
  readonly rulesetFamilies: readonly RulesetFamily[];
  readonly partitionKinds: readonly PartitionKind[];
  readonly startMethods: readonly StartMethod[];
  /** Results accumulate over several rounds of one stage (golf rounds, cycling stages, games). */
  readonly multiRound: boolean;
  readonly resourceTypes: readonly ResourceType[];
}

/** Everything a discipline provides, in one normalized shape (v1 specs derive theirs). */
export interface ProvidedCapabilities {
  readonly contestTypes: readonly ContestType[];
  readonly participantKinds: readonly ParticipantKind[];
  readonly rulesetFamilies: readonly RulesetFamily[];
  readonly partitionKinds: readonly PartitionKind[];
  readonly startMethods: readonly StartMethod[];
  readonly multiRound: boolean;
  readonly resourceTypes: readonly ResourceType[];
  readonly entryAttributes: readonly {
    readonly key: string;
    readonly valueType: EntryAttributeValueType;
  }[];
}

/** What a format engine requires (declared on the engine; hashed into its FormatVersion spec). */
export interface FormatRequirements {
  readonly contestTypes?: {
    readonly allOf?: readonly ContestType[];
    readonly anyOf?: readonly ContestType[];
  };
  readonly partitionKinds?: readonly PartitionKind[];
  readonly startMethods?: { readonly anyOf: readonly StartMethod[] };
  readonly multiRound?: true;
  readonly rulesetFamilies?: { readonly anyOf: readonly RulesetFamily[] };
  readonly entryAttributes?: readonly {
    readonly key: string;
    readonly valueType: EntryAttributeValueType;
  }[];
}

export interface CapabilityIssue {
  readonly capability:
    | 'contestType'
    | 'partitionKind'
    | 'startMethod'
    | 'multiRound'
    | 'rulesetFamily'
    | 'entryAttribute';
  readonly message: string;
}

/**
 * The capabilities a DisciplineVersion provides. A v2 spec declares them; a v1 spec (BRT-05 /
 * ONCF-03A) derives the conservative legacy set from what it already pins, so every existing
 * event and FormatVersion keeps its exact meaning:
 *  - contest types and participant kinds as declared;
 *  - MATCH disciplines may be split into COMPETITIVE groups (BRT-05 round robin already did);
 *  - no start methods, no multi-round, no ruleset families, no entry attributes.
 */
export function providedCapabilities(spec: DisciplineVersionSpec): ProvidedCapabilities {
  const base = {
    contestTypes: spec.allowedContestTypes,
    participantKinds: spec.participation.participantKinds,
  };
  if (spec.specVersion === 2 && spec.capabilities !== undefined) {
    return {
      ...base,
      rulesetFamilies: spec.capabilities.rulesetFamilies,
      partitionKinds: spec.capabilities.partitionKinds,
      startMethods: spec.capabilities.startMethods,
      multiRound: spec.capabilities.multiRound,
      resourceTypes: spec.capabilities.resourceTypes,
      entryAttributes: (spec.entryAttributes ?? []).map((a) => ({
        key: a.key,
        valueType: a.valueType,
      })),
    };
  }
  return {
    ...base,
    rulesetFamilies: [],
    partitionKinds: spec.allowedContestTypes.includes('MATCH') ? ['COMPETITIVE'] : [],
    startMethods: [],
    multiRound: false,
    resourceTypes: [],
    entryAttributes: [],
  };
}

/** Requirement of an engine that declares none: its single contest type (BRT-05 behaviour). */
export function legacyRequirements(contestType: ContestType): FormatRequirements {
  return { contestTypes: { allOf: [contestType] } };
}

/** Generic compatibility: every requirement must be provided. Empty result = compatible. */
export function capabilityIssues(
  provided: ProvidedCapabilities,
  required: FormatRequirements,
): CapabilityIssue[] {
  const issues: CapabilityIssue[] = [];
  const ct = required.contestTypes;
  for (const t of ct?.allOf ?? [])
    if (!provided.contestTypes.includes(t))
      issues.push({ capability: 'contestType', message: `requires ${t} contests` });
  if (ct?.anyOf !== undefined && !ct.anyOf.some((t) => provided.contestTypes.includes(t)))
    issues.push({
      capability: 'contestType',
      message: `requires one of ${ct.anyOf.join(', ')} contests`,
    });
  for (const k of required.partitionKinds ?? [])
    if (!provided.partitionKinds.includes(k))
      issues.push({ capability: 'partitionKind', message: `requires ${k} partitions` });
  const sm = required.startMethods;
  if (sm !== undefined && !sm.anyOf.some((m) => provided.startMethods.includes(m)))
    issues.push({
      capability: 'startMethod',
      message: `requires start method ${sm.anyOf.join(' or ')}`,
    });
  if (required.multiRound === true && !provided.multiRound)
    issues.push({ capability: 'multiRound', message: 'requires multi-round classification' });
  const rf = required.rulesetFamilies;
  if (rf !== undefined && !rf.anyOf.some((f) => provided.rulesetFamilies.includes(f)))
    issues.push({
      capability: 'rulesetFamily',
      message: `requires ruleset family ${rf.anyOf.join(' or ')}`,
    });
  for (const a of required.entryAttributes ?? []) {
    const p = provided.entryAttributes.find((x) => x.key === a.key);
    if (p === undefined || p.valueType !== a.valueType)
      issues.push({
        capability: 'entryAttribute',
        message: `requires entry attribute ${a.key} (${a.valueType})`,
      });
  }
  return issues;
}
