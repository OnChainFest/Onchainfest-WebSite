import {
  createCanonicalizer,
  type BrObjectSchema,
  type BrRootSchema,
  type ContentHash,
} from '@br/canonical';
import { platformCanonicalizer, SchemaRef } from '@br/schemas';
import {
  engineRequirements,
  type AnyFormatEngine,
  type FieldEntry,
  type PlanDocument,
} from './engine';
import type { PlanDocumentV2 } from './plan-v2';
import { V2_ENGINES } from './engines-v2';
import { roundRobinV1 } from './round-robin';
import { singleEliminationV1 } from './single-elimination';

/**
 * Registered engines, keyed "id/version". Historical plans are never regenerated from this
 * registry: a FormatVersion pins an exact engine version, and a new engine behaviour requires a
 * new version entry (old versions stay registered for new events that pin them).
 */
const ENGINES: ReadonlyMap<string, AnyFormatEngine> = new Map<string, AnyFormatEngine>(
  [singleEliminationV1, roundRobinV1, ...V2_ENGINES].map((e) => [`${e.id}/${e.version}`, e]),
);

export function formatEngine(id: string, version: number): AnyFormatEngine | undefined {
  return ENGINES.get(`${id}/${version}`);
}

export function registeredEngines(): readonly AnyFormatEngine[] {
  return [...ENGINES.values()];
}

const TAG = 'ledger-fact';

/**
 * The hashed specification a FormatVersion pinning `engine` carries. v1 engines keep their exact
 * BRT-05 shape (so existing spec hashes are unchanged); v2 engines add their declared requirements.
 */
export function formatVersionSpec(engine: AnyFormatEngine): Record<string, unknown> {
  return {
    engineId: engine.id,
    engineVersion: engine.version,
    configurationSchema: engine.configurationSchema,
    contestType: engine.contestType,
    ...(engine.planVersion === 2 ? { requires: engineRequirements(engine) } : {}),
  };
}

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

// ───────────────────────────── v2 documents (ONCF-05B) ─────────────────────────────

/** Field v2: + roster snapshot (TEAM) and declared entry attributes. */
export interface FieldSnapshotV2 {
  readonly eventId: string;
  readonly participants: readonly (FieldEntry & {
    readonly registrationId: string;
    readonly athleteId?: string;
    readonly teamId?: string;
    readonly roster?: readonly string[];
    readonly attributes?: readonly { readonly key: string; readonly value: string }[];
    readonly memberAttributes?: readonly {
      readonly athleteId: string;
      readonly key: string;
      readonly value: string;
    }[];
  })[];
}

export function fieldHashV2(field: FieldSnapshotV2): ContentHash {
  return platformCanonicalizer().hashCanonical(TAG, SchemaRef.competitionFieldV2.id, 2, field)
    .contentHash;
}

export function planInputHashV2(doc: PlanInputDocument): ContentHash {
  return platformCanonicalizer().hashCanonical(TAG, SchemaRef.competitionPlanInputV2.id, 2, doc)
    .contentHash;
}

export function planHashV2(plan: PlanDocumentV2): ContentHash {
  return platformCanonicalizer().hashCanonical(TAG, SchemaRef.competitionPlanV2.id, 2, plan)
    .contentHash;
}
