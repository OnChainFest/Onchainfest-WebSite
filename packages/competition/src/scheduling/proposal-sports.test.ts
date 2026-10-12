import { describe, expect, it } from 'vitest';
import { CANONICAL_CATALOG, CANONICAL_DESIGN_MATRIX } from '../catalog-manifest';
import type { ContestType, DisciplineVersionSpec } from '../catalog';
import { capabilityIssues, providedCapabilities, type ResourceType } from '../capabilities';
import { engineRequirements } from '../format/engine';
import type { AnyFormatEngine, CompetitionFormatEngineV2 } from '../format/engine';
import type { PlanDocumentV2 } from '../format/plan-v2';
import { formatEngine } from '../format/registry';
import { RESOURCE_TYPE_DEFAULT_OCCUPANCY_MODE } from '../resources/resource';
import { evaluateSchedule, type EvaluationAssignment } from './engine';
import { HOUR, T0, World } from './engine.fixture';
import {
  producedContestTypes,
  schedulingProfileCompatibility,
  type SchedulingProfileSpec,
} from './profile';
import { proposeSchedule, type ScheduleProposal } from './proposal';
import { SCHEDULING_PROFILE_TEMPLATES } from './templates';

/**
 * ONCF-05E-E across the catalog (ADR-0075 § 21): real plans from the canonical format engines for
 * every compatible (sport × modality × format) cell, the canonical SchedulingProfile templates and
 * resources declared with the per-type default modes — and NO assignments. The proposal engine sees
 * only plan, 05D, profile, resource and availability DATA; one generic algorithm places every cell.
 */

const DAY = 24 * HOUR;
const disciplines = new Map(
  CANONICAL_CATALOG.sports.flatMap((s) => s.disciplines.map((d) => [d.code, d] as const)),
);
const latestSpec = (code: string) => {
  const d = disciplines.get(code);
  if (d === undefined) throw new Error(`unknown discipline ${code}`);
  return d.specs[d.specs.length - 1] as DisciplineVersionSpec;
};
const latestEngine = (code: string): AnyFormatEngine => {
  const f = CANONICAL_CATALOG.formats.find((x) => x.code === code);
  const v = f?.versions[f.versions.length - 1];
  const e = v === undefined ? undefined : formatEngine(v.engineId, v.engineVersion);
  if (e === undefined) throw new Error(`unknown format ${code}`);
  return e;
};
const pid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

function generate(
  format: string,
  n: number,
  kind: 'INDIVIDUAL' | 'TEAM',
  allowed: readonly ContestType[],
  config: Record<string, unknown> = {},
): PlanDocumentV2 {
  const field = Array.from({ length: n }, (_, i) => pid(i + 1));
  return (latestEngine(format) as CompetitionFormatEngineV2).generate({
    eventId: '00000000-0000-4000-8000-0000000000ee',
    participants: field.map((participantId) => ({ participantId, kind })),
    seedOrder: field,
    config,
    allowedContestTypes: allowed,
  });
}

function templateFor(spec: DisciplineVersionSpec, format: string) {
  const produced = producedContestTypes(latestEngine(format), spec.allowedContestTypes);
  return [...SCHEDULING_PROFILE_TEMPLATES]
    .sort((a, b) => (a.code < b.code ? -1 : 1))
    .find(
      (t) =>
        schedulingProfileCompatibility(
          t.spec,
          { resourceTypes: spec.capabilities?.resourceTypes ?? [] },
          produced,
        ).length === 0,
    );
}

/** An unscheduled world for a plan: PLANNED contests, places, entrants, resources, 24 h hours. */
function planWorld(
  plan: PlanDocumentV2,
  o: {
    kind: 'INDIVIDUAL' | 'TEAM';
    profile: SchedulingProfileSpec | null;
    resourceType: ResourceType;
    resources?: number;
    capacity?: number;
    days?: number;
  },
) {
  const w = new World().event('e1', {
    profile: o.profile,
    windowStartMs: T0,
    windowEndMs: T0 + (o.days ?? 14) * DAY,
  });
  const mode = RESOURCE_TYPE_DEFAULT_OCCUPANCY_MODE[o.resourceType];
  const k = mode === 'SHARED' ? 1 : (o.resources ?? 6);
  for (let i = 0; i < k; i++)
    w.resource(`R${i}`, {
      type: o.resourceType,
      mode,
      capacity: o.capacity ?? (mode === 'SHARED' ? 100_000 : 64),
    });
  const participants = new Set<string>();
  const stageOf = new Map(plan.stages.map((s) => [s.key, s]));
  const roundOf = new Map(plan.rounds.map((r) => [r.key, r]));
  const contestsOfStage = (stageKey: string, groupKey?: string, maxRoundSeq?: number) =>
    plan.rounds
      .filter(
        (r) =>
          r.stageKey === stageKey &&
          (groupKey === undefined || r.groupKey === groupKey) &&
          (maxRoundSeq === undefined || r.sequence <= maxRoundSeq),
      )
      .flatMap((r) => r.contests.map((c) => c.key));
  const transitionFeeders = (key: string) => {
    const t = plan.transitions.find((x) => x.key === key);
    if (t === undefined) throw new Error(`no transition ${key}`);
    const after = t.afterRound === undefined ? undefined : roundOf.get(t.afterRound)?.sequence;
    return contestsOfStage(t.fromStage, undefined, after);
  };
  const offsets: Record<string, number> = {};
  for (const r of plan.rounds) {
    const stage = stageOf.get(r.stageKey);
    for (const c of r.contests) {
      const sole =
        c.slots.length === 1 && c.slots[0]?.source === 'PARTICIPANT' ? c.slots[0] : undefined;
      w.contest(c.key, {
        status: 'PLANNED',
        round: r.key,
        roundSeq: r.sequence,
        stage: r.stageKey,
        stageSeq: stage?.sequence ?? 0,
        grouped: stage?.partition?.method === 'GROUPED_ENTRANTS',
        type: c.contestType,
        roundType: r.roundType,
        primitive: stage?.primitive ?? null,
        partitionKey: c.partitionKey ?? null,
        unitParticipant: sole?.participantId ?? null,
      });
      for (const s of c.slots) {
        if (s.source === 'PARTICIPANT') {
          participants.add(s.participantId as string);
          w.place(c.key, s.slot, { state: 'FIXED', occupant: s.participantId as string });
        } else {
          const feeders =
            s.source === 'WINNER_OF_CONTEST' || s.source === 'LOSER_OF_CONTEST'
              ? [s.contestKey as string]
              : s.source === 'QUALIFIER'
                ? transitionFeeders(s.transitionKey as string)
                : contestsOfStage(s.stageKey as string, s.groupKey);
          w.place(c.key, s.slot, { state: 'UNRESOLVED', feeders, sourceKind: s.source });
        }
      }
      for (const e of c.entries ?? []) {
        participants.add(e.participantId);
        w.place(c.key, e.position, { state: 'FIXED', occupant: e.participantId });
      }
      offsets[c.key] = Math.max(0, ...(c.entries ?? []).map((e) => e.startOffsetSeconds ?? 0));
    }
  }
  for (const p of [...participants].sort())
    w.entrant(p, o.kind === 'TEAM' ? { kind: 'TEAM', persons: [`${p}-m1`, `${p}-m2`] } : {});
  return { w, offsets };
}

function propose(w: World, offsets: Record<string, number>) {
  return proposeSchedule({
    judge: w.input(),
    draftStatus: 'DRAFT',
    competitionStatus: 'IN_PROGRESS',
    basePublishedVersionId: null,
    eventStatuses: [{ eventId: 'e1', status: 'FIELD_LOCKED' }],
    latestOffsets: w.contests.map((c) => ({ contestId: c.id, seconds: offsets[c.id] ?? 0 })),
  });
}

/** The judge over base ⊕ placements (real ids replaced by the synthetic ones the engine used). */
function finalReport(w: World, p: ScheduleProposal) {
  const extra: EvaluationAssignment[] = p.placements.map((x) => ({
    id: `proposal:${x.contestId}`,
    contestId: x.contestId,
    resourceId: x.resourceId,
    startMs: x.start * 1000,
    expectedEndMs: x.expectedEnd * 1000,
    changeoverSeconds: x.changeoverSeconds,
    recordedUnitKey: x.unitKey,
  }));
  const judge = w.input();
  return evaluateSchedule({
    ...judge,
    watermark: [...judge.watermark, ...extra.map((a) => a.id)],
    assignments: [...judge.assignments, ...extra],
  });
}

const cells = CANONICAL_DESIGN_MATRIX.flatMap((s) =>
  s.modalities.flatMap((m) =>
    s.formats
      .filter(
        (f) =>
          capabilityIssues(
            providedCapabilities(latestSpec(m.discipline)),
            engineRequirements(latestEngine(f.format)),
          ).length === 0,
      )
      .map((f) => ({
        sport: s.sport,
        modality: m.name,
        discipline: m.discipline,
        format: f.format,
      })),
  ),
);

describe('every compatible sport × modality × format cell (61): one generic proposer', () => {
  it('covers the 8 canonical sports, wheelchair basketball included', () => {
    expect(cells).toHaveLength(61);
    expect(new Set(cells.map((c) => c.sport)).size).toBe(8);
    expect(cells.some((c) => c.discipline === 'basketball.wheelchair')).toBe(true);
  });

  it.each(cells)('$sport · $modality · $format', { timeout: 60_000 }, (cell) => {
    const spec = latestSpec(cell.discipline);
    const kind = spec.participation.participantKinds[0] as 'INDIVIDUAL' | 'TEAM';
    const plan = generate(cell.format, 8, kind, spec.allowedContestTypes);
    const template = templateFor(spec, cell.format);
    const resourceType = (template?.spec.requirements[0]?.resourceType ??
      spec.capabilities?.resourceTypes[0]) as ResourceType;
    const { w, offsets } = planWorld(plan, { kind, profile: template?.spec ?? null, resourceType });
    const p = propose(w, offsets);
    if (template === undefined) {
      // Catalog-data gap (no template): profile-less events are never proposed (ADR-0069).
      expect(p.placements).toEqual([]);
      expect(new Set(p.unplaced.map((u) => u.reason))).toEqual(new Set(['NO_PROFILE']));
      return;
    }
    // Every materialized contest is placed; dynamic rounds have no contests yet.
    expect(p.status, JSON.stringify(p.unplaced)).toBe('SUCCESS');
    expect(p.placements).toHaveLength(w.contests.length);
    // The judge confirms: no HARD conflict anywhere and nothing in undeclared time.
    const report = finalReport(w, p);
    expect(report.conflicts.filter((c) => c.severity === 'HARD')).toEqual([]);
    expect(report.conflicts.filter((c) => c.code === 'AVAILABILITY_UNDECLARED')).toEqual([]);
    expect(p.report.hardConflicts).toBe(0);
    // Every unit starts together.
    const starts = new Map<string, Set<number>>();
    for (const x of p.placements)
      starts.set(x.unitKey, (starts.get(x.unitKey) ?? new Set()).add(x.start));
    for (const s of starts.values()) expect(s.size).toBe(1);
  });
});

describe('bowling (ten-pin) and golf through the generic proposer', () => {
  it('a 24-bowler squad is packed four per lane pair over six EXCLUSIVE pairs at one start', () => {
    const bowling = SCHEDULING_PROFILE_TEMPLATES.find((t) => t.code === 'bowling-lane-pair-blocks');
    const singles = latestSpec('bowling.tenpin.singles');
    const plan = generate('multi-round', 24, 'INDIVIDUAL', singles.allowedContestTypes, {
      rounds: 2,
      groupSize: 24,
    });
    const { w, offsets } = planWorld(plan, {
      kind: 'INDIVIDUAL',
      profile: bowling?.spec ?? null,
      resourceType: 'BOWLING_LANE_PAIR',
      resources: 6,
      capacity: 4,
    });
    const p = propose(w, offsets);
    expect(p.status).toBe('SUCCESS');
    const block1 = p.placements.filter((x) => x.unitKey.endsWith('-r1:t1'));
    expect(block1).toHaveLength(24);
    expect(new Set(block1.map((x) => x.start)).size).toBe(1);
    const perPair = new Map<string, number>();
    for (const x of block1) perPair.set(x.resourceId, (perPair.get(x.resourceId) ?? 0) + 1);
    expect([...perPair.values()]).toEqual([4, 4, 4, 4, 4, 4]);
    // Block 2 (inherited squad) starts after block 1 and its changeover on the same pairs.
    const block2 = p.placements.filter((x) => x.unitKey.endsWith('-r2:t1'));
    expect(Math.min(...block2.map((x) => x.start))).toBeGreaterThanOrEqual(
      Math.max(...block1.map((x) => x.expectedEnd + x.changeoverSeconds)),
    );
    expect(finalReport(w, p).conflicts.filter((c) => c.severity === 'HARD')).toEqual([]);
  });

  it('golf tee groups: one SHARED course, 600 s spacing, two concurrent starts, 1/day rounds', () => {
    const golf = SCHEDULING_PROFILE_TEMPLATES.find((t) => t.code === 'golf-course-tee-groups');
    const stroke = latestSpec('golf.individual');
    const plan = generate('multi-round', 16, 'INDIVIDUAL', stroke.allowedContestTypes, {
      rounds: 2,
      groupSize: 4,
    });
    const { w, offsets } = planWorld(plan, {
      kind: 'INDIVIDUAL',
      profile: golf?.spec ?? null,
      resourceType: 'GOLF_COURSE',
    });
    const p = propose(w, offsets);
    expect(p.status).toBe('SUCCESS');
    const round1 = p.placements.filter((x) => x.unitKey.includes('-r1:'));
    const slots = [...new Set(round1.map((x) => x.start))].sort((a, b) => a - b);
    // Four tee groups: two per slot, slots 600 s apart.
    expect(slots.map((s) => s - (slots[0] as number))).toEqual([0, 600]);
    const round2 = p.placements.filter((x) => x.unitKey.includes('-r2:'));
    // The HARD daily limit pushes round 2 to the next local date (UTC event zone here).
    expect(Math.min(...round2.map((x) => x.start))).toBe(Date.UTC(2026, 10, 15) / 1000);
    expect(new Set(p.placements.map((x) => x.resourceId))).toEqual(new Set(['R0']));
  });
});

describe('performance (diagnostic; never part of the semantics)', () => {
  it(
    'a 32-entrant knockout on 8 courts: every match placed within the v1 budget',
    {
      timeout: 300_000,
    },
    () => {
      const tennis = SCHEDULING_PROFILE_TEMPLATES.find((t) => t.code === 'tennis-court-match');
      const plan = generate('single-elimination', 32, 'INDIVIDUAL', ['MATCH']);
      const { w, offsets } = planWorld(plan, {
        kind: 'INDIVIDUAL',
        profile: tennis?.spec ?? null,
        resourceType: 'TENNIS_COURT',
        resources: 8,
      });
      const t0 = performance.now();
      const p = propose(w, offsets);
      const elapsed = performance.now() - t0;
      expect(p.status).toBe('SUCCESS');
      expect(p.placements).toHaveLength(31);
      expect(p.diagnostics.judgeCalls).toBeLessThan(p.budget.maxEvaluations);
      // Reported for the review; a generous bound only guards against pathological regressions.
      console.info(
        `[05E-E perf] 31 matches / 8 courts: ${p.diagnostics.judgeCalls} judge calls, ` +
          `${Math.round(elapsed)} ms`,
      );
      expect(elapsed).toBeLessThan(240_000);
    },
  );

  it(
    'an 8-team round robin on 4 courts (28 matches, rest + daily limits)',
    {
      timeout: 300_000,
    },
    () => {
      const padel = SCHEDULING_PROFILE_TEMPLATES.find((t) => t.code === 'padel-court-match');
      const plan = generate('round-robin', 8, 'TEAM', ['MATCH']);
      const { w, offsets } = planWorld(plan, {
        kind: 'TEAM',
        profile: padel?.spec ?? null,
        resourceType: 'PADEL_COURT',
        resources: 4,
        days: 21,
      });
      const t0 = performance.now();
      const p = propose(w, offsets);
      const elapsed = performance.now() - t0;
      expect(p.status).toBe('SUCCESS');
      expect(p.placements).toHaveLength(28);
      console.info(
        `[05E-E perf] 28 matches / 4 courts: ${p.diagnostics.judgeCalls} judge calls, ` +
          `${Math.round(elapsed)} ms`,
      );
      expect(elapsed).toBeLessThan(240_000);
    },
  );
});
