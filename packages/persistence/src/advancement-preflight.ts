import {
  advancementCompatibility,
  advancementRequirements,
  crossGroupKeysUsed,
  formatEngine,
  type AdvancementPolicySpec,
} from '@br/competition';
import { DomainError, DomainErrorCode } from '@br/domain';
import type { ClassificationPolicyV2Spec } from '@br/rankings';
import { sql } from 'kysely';
import { disciplineSpec } from './competition-structure-v2';
import type { EventRow } from './competition-support';
import type { TxContext } from './tx';

/** Ruleset families scored head-to-head: their stages classify with a STANDINGS template. */
export const HEAD_TO_HEAD_FAMILIES: ReadonlySet<string> = new Set([
  'SETS_OF_GAMES',
  'TIMED_PERIODS',
  'TIMED_OR_TARGET',
  'MATCH_PLAY_HOLES',
]);

/** Value keys a STANDINGS classification document carries (base values + criteria metrics). */
export function standingsValueKeys(spec: ClassificationPolicyV2Spec): Set<string> {
  const keys = new Set(['played', 'wins', 'points']);
  const walk = (cs: readonly unknown[]) => {
    for (const raw of cs) {
      const c = raw as Record<string, unknown>;
      for (const k of ['forMetric', 'againstMetric', 'metric'])
        if (typeof c[k] === 'string') keys.add(c[k] as string);
      if (Array.isArray(c['sub'])) walk(c['sub'] as unknown[]);
    }
  };
  if (spec.family === 'STANDINGS') walk(spec.criteria);
  return keys;
}

/**
 * The entrant count a preflight assesses. A number is authoritative (the field being locked, or
 * the locked field); CONFIRMED is the exact confirmed field once registration has closed, with no
 * substitute. Only ESTIMATE (setup guidance before registration closes, and pin-time suggestions)
 * may fall back to capacity or a feasible size, and an estimate is never lock-ready.
 */
export type PreflightCount = number | 'CONFIRMED' | 'ESTIMATE';

interface PinRow {
  readonly ruleset_version_id: string;
  readonly classification_template_version_id: string | null;
  readonly advancement_policy_version_id: string | null;
  readonly stage_overrides: Readonly<
    Record<string, { rulesetVersionId?: string; classificationTemplateVersionId?: string }>
  >;
}

/** Caller holds event-structure and event-capacity for a lock; reads are advisory in readiness. */
export async function advancementPreflight(ctx: TxContext, event: EventRow, basis: PreflightCount) {
  const { rows: counts } = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM competition.registration r
    JOIN competition.v_registration_current s ON s.registration_id = r.id
    WHERE r.event_id = ${event.id} AND s.status = 'CONFIRMED'`.execute(ctx.trx);
  const confirmed = counts[0]?.n ?? 0;
  const { rows: formats } = await sql<{ engine_id: string; engine_version: number }>`
    SELECT engine_id, engine_version FROM sports.format_version
    WHERE id = ${event.formatVersionId}`.execute(ctx.trx);
  const format = formats[0];
  const engine =
    format === undefined ? undefined : formatEngine(format.engine_id, format.engine_version);
  const discipline = await disciplineSpec(ctx, event.disciplineVersionId);
  const countBasis = basis === 'ESTIMATE' ? ('ESTIMATE' as const) : ('EXACT' as const);
  const actual =
    typeof basis === 'number'
      ? basis
      : basis === 'CONFIRMED' || confirmed > 0
        ? confirmed
        : (event.capacity ?? engine?.minParticipants ?? 2);
  // Historical v1 disciplines have no executable scoring axis (ONCF-05C). Preserve their
  // operational-only structure path; the scored organizer catalog already excludes them.
  if (discipline.specVersion !== 2)
    return {
      participantCount: actual,
      countBasis,
      required: false,
      compatiblePolicyVersionIds: [] as string[],
      defaultPolicyVersionId: null,
      blockers: [] as string[],
    };
  const blockers: string[] = [];
  const { rows: pins } = await sql<PinRow>`
    SELECT ruleset_version_id, classification_template_version_id, advancement_policy_version_id,
           stage_overrides
    FROM competition.v_event_scoring_current WHERE event_id = ${event.id}`.execute(ctx.trx);
  const pin = pins[0];
  // Suggestions and new selections: published versions only.
  const { rows: policies } = await sql<{ id: string; code: string; spec: AdvancementPolicySpec }>`
    SELECT v.id, p.code, v.spec FROM sports.advancement_policy_version v
    JOIN sports.advancement_policy p ON p.id = v.policy_id
    JOIN sports.v_advancement_policy_version_current s ON s.advancement_policy_version_id = v.id
    WHERE s.status = 'PUBLISHED' ORDER BY p.code, v.version DESC`.execute(ctx.trx);
  let requirements: ReturnType<typeof advancementRequirements> | undefined;
  if (engine !== undefined) {
    try {
      requirements = advancementRequirements(engine, discipline, event.formatConfig, actual);
    } catch {
      // Before registration closes, offer configuration for a feasible format shape. An exact
      // count (lock, closed registration, locked field) never uses this fallback.
      if (basis === 'ESTIMATE') {
        for (const n of [engine.minParticipants, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2000]) {
          if (n < engine.minParticipants || n > engine.maxParticipants) continue;
          try {
            requirements = advancementRequirements(engine, discipline, event.formatConfig, n);
            break;
          } catch {
            /* try the next feasible field */
          }
        }
      }
      if (requirements === undefined) blockers.push('ADVANCEMENT_PLAN_INVALID');
    }
  } else blockers.push('ADVANCEMENT_PLAN_INVALID');
  const assessed = requirements;
  const compatible =
    assessed === undefined
      ? []
      : policies.filter((p) => advancementCompatibility(assessed, p.spec).length === 0);
  if (pin === undefined) blockers.push('SCORING_NOT_PINNED');
  if (requirements?.required) {
    if (pin === undefined || pin.advancement_policy_version_id === null)
      blockers.push('ADVANCEMENT_POLICY_REQUIRED');
  }
  // A pinned version is immutable: it stays usable for this event whatever its catalog status now.
  let pinnedPolicy: AdvancementPolicySpec | undefined;
  if (pin !== undefined && pin.advancement_policy_version_id !== null) {
    const { rows } = await sql<{ spec: AdvancementPolicySpec }>`
      SELECT spec FROM sports.advancement_policy_version
      WHERE id = ${pin.advancement_policy_version_id}`.execute(ctx.trx);
    pinnedPolicy = rows[0]?.spec;
    if (
      assessed === undefined ||
      pinnedPolicy === undefined ||
      advancementCompatibility(assessed, pinnedPolicy).length > 0
    )
      blockers.push('ADVANCEMENT_POLICY_INCOMPATIBLE');
  }
  if (assessed !== undefined && pin !== undefined)
    blockers.push(...(await classificationIssues(ctx, assessed, pin, pinnedPolicy)));
  return {
    participantCount: actual,
    countBasis,
    required: requirements?.required ?? false,
    compatiblePolicyVersionIds: compatible.map((p) => p.id),
    defaultPolicyVersionId:
      compatible.find(
        (p) =>
          p.code === requirements?.defaultPolicyCode &&
          p.spec.minimumResultStatus === 'OFFICIAL' &&
          p.spec.commit === 'CONFIRM',
      )?.id ?? null,
    blockers,
  };
}

/**
 * Every stage advancement ranks needs an effective classification template (its stage override,
 * else the event's) that fits the stage's effective ruleset; a cross-group order may only compare
 * values that stage's standings produce. Pinned versions are read whatever their catalog status.
 */
async function classificationIssues(
  ctx: TxContext,
  requirements: ReturnType<typeof advancementRequirements>,
  pin: PinRow,
  policy: AdvancementPolicySpec | undefined,
): Promise<string[]> {
  const effective = requirements.classificationStages.map((stage) => {
    const o = pin.stage_overrides[stage];
    return {
      stage,
      rulesetId: o?.rulesetVersionId ?? pin.ruleset_version_id,
      templateId: o?.classificationTemplateVersionId ?? pin.classification_template_version_id,
    };
  });
  if (effective.length === 0) return [];
  if (effective.some((s) => s.templateId === null)) return ['CLASSIFICATION_TEMPLATE_REQUIRED'];
  const { rows: templates } = await sql<{
    id: string;
    family: string;
    spec: ClassificationPolicyV2Spec;
  }>`
    SELECT id, family, spec FROM sports.classification_template_version
    WHERE id = ANY(${effective.map((s) => s.templateId as string)}::uuid[])`.execute(ctx.trx);
  const { rows: rulesets } = await sql<{ id: string; family: string }>`
    SELECT id, family FROM sports.ruleset_version
    WHERE id = ANY(${effective.map((s) => s.rulesetId)}::uuid[])`.execute(ctx.trx);
  const used = policy === undefined ? [] : crossGroupKeysUsed(policy);
  for (const s of effective) {
    const template = templates.find((t) => t.id === s.templateId);
    const ruleset = rulesets.find((r) => r.id === s.rulesetId);
    if (
      template === undefined ||
      ruleset === undefined ||
      (template.family === 'STANDINGS') !== HEAD_TO_HEAD_FAMILIES.has(ruleset.family)
    )
      return ['CLASSIFICATION_TEMPLATE_INCOMPATIBLE'];
    if (
      requirements.crossGroupStages.includes(s.stage) &&
      used.some((k) => !standingsValueKeys(template.spec).has(k))
    )
      return ['CLASSIFICATION_TEMPLATE_INCOMPATIBLE'];
  }
  return [];
}

export function assertAdvancementReady(
  preflight: Awaited<ReturnType<typeof advancementPreflight>>,
) {
  if (preflight.countBasis !== 'EXACT' || preflight.blockers.length > 0)
    throw new DomainError(
      DomainErrorCode.INVALID_TRANSITION,
      'Configure compatible scoring and advancement before locking this field',
      {
        reason: preflight.blockers[0] ?? 'ADVANCEMENT_PLAN_INVALID',
        blockers: preflight.blockers,
      },
    );
}
