import {
  advancementCompatibility,
  advancementRequirements,
  formatEngine,
  type AdvancementPolicySpec,
} from '@br/competition';
import { DomainError, DomainErrorCode } from '@br/domain';
import { sql } from 'kysely';
import { disciplineSpec } from './competition-structure-v2';
import type { EventRow } from './competition-support';
import type { TxContext } from './tx';

/** Caller holds event-structure and event-capacity for a lock; reads are advisory in readiness. */
export async function advancementPreflight(ctx: TxContext, event: EventRow, count?: number) {
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
  const actual =
    count ?? (confirmed > 0 ? confirmed : (event.capacity ?? engine?.minParticipants ?? 2));
  // Historical v1 disciplines have no executable scoring axis (ONCF-05C). Preserve their
  // operational-only structure path; the scored organizer catalog already excludes them.
  if (discipline.specVersion !== 2)
    return {
      participantCount: actual,
      required: false,
      compatiblePolicyVersionIds: [] as string[],
      defaultPolicyVersionId: null,
      blockers: [] as string[],
    };
  const blockers: string[] = [];
  const { rows: pins } = await sql<{ advancement_policy_version_id: string | null }>`
    SELECT advancement_policy_version_id FROM competition.v_event_scoring_current
    WHERE event_id = ${event.id}`.execute(ctx.trx);
  const pin = pins[0];
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
      // Before a viable field exists, offer configuration for a feasible format shape.
      // The locking caller always supplies the exact count and never uses this fallback.
      if (count === undefined) {
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
  if (
    pin !== undefined &&
    pin.advancement_policy_version_id !== null &&
    !compatible.some((p) => p.id === pin.advancement_policy_version_id)
  )
    blockers.push('ADVANCEMENT_POLICY_INCOMPATIBLE');
  return {
    participantCount: actual,
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

export function assertAdvancementReady(
  preflight: Awaited<ReturnType<typeof advancementPreflight>>,
) {
  if (preflight.blockers.length > 0)
    throw new DomainError(
      DomainErrorCode.INVALID_TRANSITION,
      'Configure compatible scoring and advancement before locking this field',
      { reason: preflight.blockers[0], blockers: preflight.blockers },
    );
}
