import {
  createCanonicalizer,
  type BrObjectSchema,
  type BrRootSchema,
  type ContentHash,
} from '@br/canonical';
import { platformCanonicalizer, SchemaRef } from '@br/schemas';
import { type CompetitionFormatEngine, type FieldEntry, type PlanDocument } from './engine';
import { roundRobinV1 } from './round-robin';
import { singleEliminationV1 } from './single-elimination';

/**
 * Registered engines, keyed "id/version". Historical plans are never regenerated from this
 * registry: a FormatVersion pins an exact engine version, and a new engine behaviour requires a
 * new version entry (old versions stay registered for new events that pin them).
 */
const ENGINES: ReadonlyMap<string, CompetitionFormatEngine> = new Map(
  [singleEliminationV1, roundRobinV1].map((e) => [`${e.id}/${e.version}`, e]),
);

export function formatEngine(id: string, version: number): CompetitionFormatEngine | undefined {
  return ENGINES.get(`${id}/${version}`);
}

export function registeredEngines(): readonly CompetitionFormatEngine[] {
  return [...ENGINES.values()];
}

const TAG = 'ledger-fact';

/**
 * Validates and normalizes an event's format configuration against the FormatVersion's pinned
 * BR-JSON configuration schema. Unknown fields are rejected, never stripped.
 */
export function canonicalFormatConfig(
  formatVersionId: string,
  configurationSchema: BrObjectSchema,
  config: unknown,
): { config: Record<string, unknown>; configHash: ContentHash } {
  const id = `br:format-config.${formatVersionId.replace(/-/g, '')}`;
  const c = createCanonicalizer([
    { ...configurationSchema, $id: id, 'x-br-version': 1 } as BrRootSchema,
  ]);
  const normalized = c.normalize(id, 1, config) as Record<string, unknown>;
  return { config: normalized, configHash: c.hashCanonical(TAG, id, 1, config).contentHash };
}

export interface FieldSnapshot {
  readonly eventId: string;
  readonly participants: readonly (FieldEntry & {
    readonly registrationId: string;
    readonly athleteId?: string;
    readonly teamId?: string;
  })[];
}

export function fieldHash(field: FieldSnapshot): ContentHash {
  return platformCanonicalizer().hashCanonical(TAG, SchemaRef.competitionField.id, 1, field)
    .contentHash;
}

export interface SeedingDocument {
  readonly eventId: string;
  readonly fieldHash: string;
  readonly method: 'MANUAL' | 'DETERMINISTIC_DRAW';
  readonly drawAlgorithm?: string;
  readonly drawSeed?: string;
  readonly order: readonly string[];
}

export function seedingHash(doc: SeedingDocument): ContentHash {
  return platformCanonicalizer().hashCanonical(TAG, SchemaRef.competitionSeeding.id, 1, doc)
    .contentHash;
}

export interface PlanInputDocument {
  readonly eventId: string;
  readonly disciplineVersionId: string;
  readonly disciplineVersionHash: string;
  readonly formatVersionId: string;
  readonly formatVersionHash: string;
  readonly engineId: string;
  readonly engineVersion: number;
  readonly fieldHash: string;
  readonly seedingHash: string;
  readonly configHash: string;
  readonly seedOrder: readonly string[];
}

export function planInputHash(doc: PlanInputDocument): ContentHash {
  return platformCanonicalizer().hashCanonical(TAG, SchemaRef.competitionPlanInput.id, 1, doc)
    .contentHash;
}

export function planHash(plan: PlanDocument): ContentHash {
  return platformCanonicalizer().hashCanonical(TAG, SchemaRef.competitionPlan.id, 1, plan)
    .contentHash;
}
