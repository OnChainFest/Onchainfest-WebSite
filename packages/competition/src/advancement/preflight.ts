import { capabilityIssues, providedCapabilities } from '../capabilities';
import type { DisciplineVersionSpec } from '../catalog';
import { engineRequirements, type AnyFormatEngine } from '../format/engine';
import type { AdvancementPolicySpec } from './policy';

/** Inspect a deterministic, disposable plan. No event facts or real participant ids are created. */
export function advancementRequirements(
  engine: AnyFormatEngine,
  discipline: DisciplineVersionSpec,
  config: Readonly<Record<string, unknown>>,
  count: number,
) {
  const issues = capabilityIssues(providedCapabilities(discipline), engineRequirements(engine));
  if (issues.length > 0) throw new Error('format and discipline are incompatible');
  const participants = Array.from({ length: count }, (_, i) => ({
    participantId: `preflight-${i}`,
    kind: discipline.participation.participantKinds[0]!,
  }));
  const plan = engine.generate({
    eventId: 'preflight',
    participants,
    seedOrder: participants.map((p) => p.participantId),
    config,
    allowedContestTypes: discipline.allowedContestTypes,
  });
  const sources = plan.rounds.flatMap((round) =>
    round.contests.flatMap((contest) => contest.slots.map((slot) => slot.source)),
  );
  const v2 = 'planVersion' in plan && plan.planVersion === 2 ? plan : undefined;
  const transitions = v2?.transitions ?? [];
  const required =
    sources.some((source) => source !== 'PARTICIPANT') ||
    (v2?.rounds.some((round) => round.dynamicEntry !== undefined) ?? false);
  const crossGroup = sources.includes('BEST_RANKED_FROM_STAGE');
  const grouped = v2?.rounds.some((round) => round.groupKey !== undefined) ?? false;
  const heatPlaces = transitions.some(
    (t) => t.kind === 'QUALIFY_BY_PLACE_AND_TIME' && Number(t.params['qualifyByPlace'] ?? 0) > 0,
  );
  return {
    required,
    crossGroup,
    grouped,
    heatPlaces,
    // An engine explicitly opts in. A policy-free final never gets a default.
    defaultPolicyCode:
      required &&
      engine.advancementDefaultPolicyCode !== undefined &&
      providedCapabilities(discipline).rulesetFamilies.includes('SETS_OF_GAMES')
        ? engine.advancementDefaultPolicyCode
        : null,
  };
}

export function advancementCompatibility(
  requirements: ReturnType<typeof advancementRequirements>,
  policy: AdvancementPolicySpec,
): string[] {
  const issues: string[] = [];
  if (requirements.crossGroup && policy.crossGroupOrder.length === 0)
    issues.push('CROSS_GROUP_ORDER_REQUIRED');
  if (!requirements.crossGroup && !requirements.grouped && policy.crossGroupOrder.length > 0)
    issues.push('CROSS_GROUP_ORDER_UNUSED');
  if (requirements.heatPlaces && policy.heatSemantics !== 'PLACE_THEN_TIME')
    issues.push('HEAT_PLACE_QUALIFICATION_REQUIRED');
  return issues;
}
