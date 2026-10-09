import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_CATALOG,
  CANONICAL_DESIGN_MATRIX,
  capabilityIssues,
  centreOutLanes,
  composeHeats,
  compareDecimal,
  computeSeeding,
  engineRequirements,
  evenGroupSizes,
  formatEngine,
  planHashV2,
  providedCapabilities,
  RULESET_TEMPLATES,
  seedBands,
  seedingHashV2,
  serpentineGroups,
  validateDisciplineVersionSpec,
  validateRulesetSpec,
  validEntryAttributeValue,
  type AnyFormatEngine,
  type CompetitionFormatEngineV2,
  type ContestType,
  type DisciplineVersionSpec,
  type PlanDocumentV2,
} from './index';

const SEED = 'ab'.repeat(32);
const ids = (n: number) =>
  Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);

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
const v2 = (code: string) => latestEngine(code) as CompetitionFormatEngineV2;

function generate(
  format: string,
  n: number,
  config: Record<string, unknown> = {},
  allowed: readonly ContestType[] = ['MATCH'],
): PlanDocumentV2 {
  const field = ids(n);
  return v2(format).generate({
    eventId: '00000000-0000-4000-8000-0000000000ee',
    participants: field.map((participantId) => ({ participantId, kind: 'INDIVIDUAL' })),
    seedOrder: field,
    config,
    allowedContestTypes: allowed,
  });
}

const contestsOf = (p: PlanDocumentV2) => p.rounds.flatMap((r) => r.contests);
const participantsOf = (p: PlanDocumentV2, stage?: string) =>
  p.rounds
    .filter((r) => stage === undefined || r.stageKey === stage)
    .flatMap((r) => r.contests)
    .flatMap((c) => [
      ...c.slots.flatMap((s) => (s.participantId === undefined ? [] : [s.participantId])),
      ...(c.entries ?? []).map((e) => e.participantId),
    ]);

describe('ONCF-05B canonical catalog: eight sports as data', () => {
  it('lists exactly the eight canonical sports and 21 disciplines (24 modalities)', () => {
    expect(CANONICAL_CATALOG.sports.map((s) => s.code)).toEqual([
      'padel',
      'tennis',
      'running',
      'swimming',
      'cycling',
      'bowling',
      'basketball',
      'golf',
    ]);
    expect(disciplines.size).toBe(21);
    expect(CANONICAL_DESIGN_MATRIX.flatMap((s) => s.modalities)).toHaveLength(24);
    expect(CANONICAL_DESIGN_MATRIX.flatMap((s) => s.formats)).toHaveLength(24);
    for (const s of CANONICAL_DESIGN_MATRIX) {
      expect(s.modalities, s.sport).toHaveLength(3);
      expect(s.formats, s.sport).toHaveLength(3);
    }
  });

  it('every discipline version is valid; v1 racket specs keep their exact history position', () => {
    for (const [code, d] of disciplines)
      for (const spec of d.specs) expect(validateDisciplineVersionSpec(spec), code).toEqual([]);
    for (const code of ['padel.doubles', 'tennis.singles', 'tennis.doubles'])
      expect(disciplines.get(code)?.specs[0]?.specVersion, code).toBeUndefined();
  });

  it('labels scramble as common practice and keeps wheelchair basketball canonical', () => {
    const golf = CANONICAL_DESIGN_MATRIX.find((s) => s.sport === 'golf');
    expect(golf?.modalities.find((m) => m.name === 'Scramble')?.commonPractice).toBe(true);
    const bb = CANONICAL_DESIGN_MATRIX.find((s) => s.sport === 'basketball');
    expect(bb?.modalities.map((m) => m.discipline)).toEqual([
      'basketball.5x5',
      'basketball.3x3',
      'basketball.wheelchair',
    ]);
    expect(latestSpec('basketball.wheelchair').participation.lineupConstraint).toEqual({
      sumOf: 'classificationPoints',
      max: '14.0',
    });
  });

  it('refuses v2-only fields in a v1 spec and unknown capabilities', () => {
    const v1 = disciplines.get('tennis.singles')?.specs[0] as DisciplineVersionSpec;
    expect(
      validateDisciplineVersionSpec({
        ...v1,
        capabilities: latestSpec('tennis.singles').capabilities,
      } as DisciplineVersionSpec),
    ).not.toEqual([]);
    const bad = {
      ...latestSpec('running.road'),
      capabilities: { ...latestSpec('running.road').capabilities, startMethods: ['TELEPORT'] },
    } as unknown as DisciplineVersionSpec;
    expect(validateDisciplineVersionSpec(bad).map((i) => i.path)).toContain(
      '/capabilities/startMethods',
    );
  });
});

describe('ONCF-05A §16.3 capability matrix (72 combinations, computed from catalog data)', () => {
  /** The 11 ✘ cells of the approved design; everything else must be compatible. */
  const NOT_SUPPORTED = new Set([
    'running|Road race|Heats → final',
    'running|Track race|Wave-start timed race',
    'swimming|Individual pool event|Open-water mass start',
    'swimming|Relay|Open-water mass start',
    'swimming|Open water|Timed finals',
    'swimming|Open water|Heats → final',
    'cycling|Road race / Gran Fondo|Interval-start time trial',
    'cycling|Individual time trial|Mass-start race',
    'cycling|MTB cross-country|Interval-start time trial',
    'golf|Scramble|Stableford',
    'golf|Scramble|Match-play bracket (from qualifying)',
  ]);

  const cells = CANONICAL_DESIGN_MATRIX.flatMap((s) =>
    s.modalities.flatMap((m) =>
      s.formats.map((f) => ({
        key: `${s.sport}|${m.name}|${f.name}`,
        issues: capabilityIssues(
          providedCapabilities(latestSpec(m.discipline)),
          engineRequirements(latestEngine(f.format)),
        ),
      })),
    ),
  );

  it('has 72 cells: 61 compatible and exactly the 11 approved ✘ cells', () => {
    expect(cells).toHaveLength(72);
    const incompatible = cells.filter((c) => c.issues.length > 0).map((c) => c.key);
    expect(new Set(incompatible)).toEqual(NOT_SUPPORTED);
    expect(cells.filter((c) => c.issues.length === 0)).toHaveLength(61);
  });

  it('explains every ✘ by a missing capability, never by a sport', () => {
    for (const c of cells.filter((x) => x.issues.length > 0)) {
      for (const i of c.issues) {
        expect(i.message).not.toMatch(/tennis|padel|running|swim|cycl|bowl|basket|golf/i);
        expect([
          'contestType',
          'partitionKind',
          'startMethod',
          'multiRound',
          'rulesetFamily',
          'entryAttribute',
        ]).toContain(i.capability);
      }
    }
  });

  it('keeps v1 disciplines compatible with exactly what BRT-05 allowed', () => {
    const v1 = disciplines.get('padel.doubles')?.specs[0] as DisciplineVersionSpec;
    const p = providedCapabilities(v1);
    expect(
      capabilityIssues(
        p,
        engineRequirements(formatEngine('single-elimination', 1) as AnyFormatEngine),
      ),
    ).toEqual([]);
    expect(
      capabilityIssues(
        p,
        engineRequirements(formatEngine('groups-knockout', 1) as AnyFormatEngine),
      ),
    ).toEqual([]);
    expect(
      capabilityIssues(p, engineRequirements(formatEngine('mass-start', 1) as AnyFormatEngine)),
    ).not.toEqual([]);
  });
});

describe('ONCF-05B engines: every plan is a valid br:competition-plan@2 document', () => {
  const cases: [string, number, Record<string, unknown>, ContestType[]][] = [
    ['single-elimination', 24, { drawSize: 32, thirdPlace: true }, ['MATCH']],
    ['round-robin', 13, { groupCount: 4 }, ['MATCH']],
    ['groups-knockout', 16, { groupCount: 4, qualifiersPerGroup: 2 }, ['MATCH']],
    ['groups-knockout', 20, { groupCount: 4, qualifiersPerGroup: 2 }, ['MATCH']],
    ['mass-start', 3000, {}, ['HEAT']],
    ['wave-start', 2500, { waveCapacity: 800 }, ['HEAT']],
    ['timed-finals', 37, {}, ['HEAT']],
    ['heats-final', 30, { qualifyByTime: 8 }, ['HEAT']],
    ['interval-start', 40, { intervalSeconds: 60 }, ['SESSION']],
    ['multi-round', 144, { rounds: 4, cutAfterRound: 2, cutTopN: 65 }, ['SERIES', 'MATCH']],
    ['multi-round', 120, { rounds: 3, eliminateNonFinishers: true }, ['HEAT']],
    ['stableford', 60, { rounds: 2 }, ['SERIES', 'MATCH']],
    ['qualifying-knockout', 40, { qualifiers: 5 }, ['SERIES', 'MATCH']],
    ['qualifying-knockout', 32, { qualifiers: 16, ladder: 'BRACKET' }, ['SERIES', 'MATCH']],
  ];
  it.each(cases)('%s with %i entrants canonicalizes and hashes', (format, n, config, allowed) => {
    const plan = generate(format, n, config, allowed);
    expect(planHashV2(plan)).toMatch(/^sha256:[0-9a-f]{64}$/);
    // deterministic
    expect(planHashV2(generate(format, n, config, allowed))).toBe(planHashV2(plan));
    // global sequences are unique
    const rs = plan.rounds.map((r) => r.sequence);
    expect(new Set(rs).size).toBe(rs.length);
    const cs = contestsOf(plan).map((c) => c.sequence);
    expect(new Set(cs).size).toBe(cs.length);
    const keys = [...plan.rounds.map((r) => r.key), ...contestsOf(plan).map((c) => c.key)];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('proof case A — tennis singles, single elimination (KNOCKOUT)', () => {
  it('a 24-entrant draw in a 32 bracket gives byes to the top 8 seeds and n−1 matches', () => {
    const plan = generate('single-elimination', 24, { drawSize: 32 });
    expect(contestsOf(plan)).toHaveLength(23);
    const r1 = plan.rounds[0]?.contests ?? [];
    const r1Players = new Set(r1.flatMap((c) => c.slots.map((s) => s.participantId)));
    for (const top of ids(8)) expect(r1Players.has(top)).toBe(false);
    expect(plan.rounds.at(-1)?.roundType).toBe('FINAL');
  });
  it('adds a third-place play-off fed by both semifinal losers', () => {
    const plan = generate('single-elimination', 8, { thirdPlace: true });
    const third = plan.rounds.find((r) => r.label === 'Third place')?.contests[0];
    expect(third?.slots.map((s) => s.source)).toEqual(['LOSER_OF_CONTEST', 'LOSER_OF_CONTEST']);
    expect(contestsOf(plan)).toHaveLength(8);
  });
  it('refuses a draw size that is not a power of two at least the field', () => {
    expect(() => generate('single-elimination', 24, { drawSize: 16 })).toThrow(/draw size/);
  });
});

describe('proof case B — padel doubles, groups → knockout (ROUND_ROBIN + standings)', () => {
  it('every pair plays in exactly one group; groups are competitive; crossover avoids own group', () => {
    const plan = generate('groups-knockout', 16, { groupCount: 4, qualifiersPerGroup: 2 });
    const [groups, ko] = plan.stages;
    expect(groups?.partition).toEqual({ kind: 'COMPETITIVE', method: 'GROUPS' });
    const inGroups = participantsOf(plan, groups?.key);
    expect(new Set(inGroups)).toEqual(new Set(ids(16)));
    expect(plan.transitions[0]).toMatchObject({
      kind: 'RANK_FROM_GROUP',
      fromStage: 's1',
      toStage: 's2',
    });
    const firstKo = plan.rounds.find((r) => r.stageKey === ko?.key)?.contests ?? [];
    for (const c of firstKo) {
      const [a, b] = c.slots;
      expect(a?.groupKey).not.toBe(b?.groupKey);
    }
    // 4 groups × C(4,2) = 24 group matches; 8 qualifiers → 7 knockout matches
    expect(contestsOf(plan)).toHaveLength(24 + 7);
  });
  it('two groups cross 1A–2B and 1B–2A (FIP)', () => {
    const plan = generate('groups-knockout', 8, { groupCount: 2, qualifiersPerGroup: 2 });
    const semis = plan.rounds.find((r) => r.stageKey === 's2')?.contests ?? [];
    const pairs = semis.map((c) =>
      c.slots
        .map((s) => `${s.rank}${s.groupKey}`)
        .sort()
        .join('-'),
    );
    expect(pairs.sort()).toEqual(['1g1-2g2', '1g2-2g1']);
  });
  it('a two-pair group plays twice (FIP table: 11 pairs → 3×3 + 1×2)', () => {
    const groups = serpentineGroups(ids(11), [3, 3, 3, 2], true);
    expect(groups.map((g) => g.length)).toEqual([3, 3, 3, 2]);
    const plan = v2('round-robin').generate({
      eventId: '00000000-0000-4000-8000-0000000000ee',
      participants: ids(2).map((participantId) => ({ participantId, kind: 'TEAM' as const })),
      seedOrder: ids(2),
      config: {},
      allowedContestTypes: ['MATCH'],
    });
    expect(contestsOf(plan)).toHaveLength(2);
  });
  it('serpentine sends seeds 1 and 2 to different groups and higher seeds to smaller groups', () => {
    const groups = serpentineGroups(ids(13), evenGroupSizes(13, 4).reverse(), true);
    const ix = (id: string) => groups.findIndex((g) => g.includes(id));
    expect(ix(ids(1)[0] as string)).not.toBe(ix(ids(2)[1] as string));
    expect(groups[ix(ids(1)[0] as string)]?.length).toBe(3);
  });
});

describe('proof case C — running road race, wave start (FIELD + logistic partitions + scale)', () => {
  it('splits thousands of entrants into logistic waves with no 64-slot ceiling', () => {
    const plan = generate('wave-start', 2500, { waveCapacity: 800 }, ['HEAT']);
    expect(plan.stages[0]?.partition).toEqual({ kind: 'LOGISTIC', method: 'WAVE_START' });
    const waves = plan.rounds[0]?.contests ?? [];
    expect(waves.map((w) => w.entries?.length)).toEqual([800, 800, 800, 100]);
    expect(waves.every((w) => w.slots.length === 0)).toBe(true);
    expect(new Set(participantsOf(plan)).size).toBe(2500);
    expect(plan.rounds).toHaveLength(1); // one race, one classification across waves
  });
});

describe('proof case D — swimming individual, heats → final (HEATS + entry-time seeding)', () => {
  it('circle-seeds the last heats, lanes 4,5,3,6,2,7,1,8, and a top-8-by-time final', () => {
    expect(centreOutLanes(8)).toEqual([4, 5, 3, 6, 2, 7, 1, 8]);
    expect(centreOutLanes(6)).toEqual([3, 4, 2, 5, 1, 6]);
    const plan = generate('heats-final', 30, { qualifyByTime: 8 }, ['HEAT']);
    const heats = plan.rounds.find((r) => r.roundType === 'HEAT')?.contests ?? [];
    expect(heats).toHaveLength(4);
    const fastest = ids(30)[0];
    const last = heats.at(-1);
    expect(last?.slots.find((s) => s.participantId === fastest)?.slot).toBe(4);
    expect(heats[0]?.slots.length).toBeGreaterThanOrEqual(3);
    const final = plan.rounds.find((r) => r.roundType === 'FINAL')?.contests[0];
    expect(final?.slots).toHaveLength(8);
    expect(final?.slots.find((s) => s.ordinal === 1)?.slot).toBe(4);
    expect(plan.transitions[0]).toMatchObject({
      kind: 'QUALIFY_BY_PLACE_AND_TIME',
      params: { qualifyByPlace: 0, qualifyByTime: 8, heats: 4 },
    });
    expect(plan.stages[0]?.partition?.kind).toBe('COMPETITIVE');
  });
  it('one heat is a direct final; timed-final heats are logistic', () => {
    expect(generate('heats-final', 7, {}, ['HEAT']).stages).toHaveLength(1);
    expect(generate('timed-finals', 20, {}, ['HEAT']).stages[0]?.partition?.kind).toBe('LOGISTIC');
  });
  it('places every swimmer exactly once whatever the field (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 200 }), fc.integer({ min: 3, max: 10 }), (n, lanes) => {
        const heats = composeHeats(ids(n), lanes, 'CIRCLE', 3, 3);
        const flat = heats.flat();
        return (
          flat.length === n && new Set(flat).size === n && heats.every((h) => h.length <= lanes)
        );
      }),
    );
  });
});

describe('proof case E — golf stroke play, multi-round + cut (cumulative classification)', () => {
  it('materializes rounds 1–2 in tee groups and makes rounds 3–4 dynamic after the cut', () => {
    const plan = generate('multi-round', 144, { rounds: 4, cutAfterRound: 2, cutTopN: 65 }, [
      'SERIES',
      'MATCH',
    ]);
    expect(plan.stages[0]?.partition).toEqual({ kind: 'LOGISTIC', method: 'GROUPED_ENTRANTS' });
    const [r1, r2, r3, r4] = plan.rounds;
    expect(r1?.contests).toHaveLength(144);
    expect(new Set(r1?.contests.map((c) => c.partitionKey)).size).toBe(36);
    expect(r1?.contests.every((c) => c.contestType === 'SERIES')).toBe(true);
    expect(r2?.contests).toHaveLength(144);
    expect(r3?.contests).toEqual([]);
    expect(r3?.dynamicEntry?.transitionKey).toBe('t1');
    expect(r4?.dynamicEntry?.transitionKey).toBe('t1');
    expect(plan.transitions[0]).toMatchObject({
      kind: 'CUT',
      afterRound: 's1-r2',
      params: { topN: 65, includeTies: true },
    });
  });
  it('a stage race (HEAT discipline) eliminates non-finishers between stages', () => {
    const plan = generate('multi-round', 100, { rounds: 3, eliminateNonFinishers: true }, ['HEAT']);
    expect(plan.rounds[0]?.contests[0]?.entries).toHaveLength(100);
    expect(plan.rounds.slice(1).every((r) => r.dynamicEntry !== undefined)).toBe(true);
    expect(plan.transitions.map((t) => t.kind)).toEqual([
      'ELIMINATE_NON_FINISHERS',
      'ELIMINATE_NON_FINISHERS',
    ]);
  });
});

describe('proof case F — basketball 3x3, pools → knockout (team roster/lineup)', () => {
  it('20 teams in 4 pools of 5, top 2 to an 8-team knockout with third place', () => {
    const plan = generate('groups-knockout', 20, {
      groupCount: 4,
      qualifiersPerGroup: 2,
      thirdPlace: true,
    });
    expect(plan.rounds.filter((r) => r.stageKey === 's1').map((r) => r.groupKey)).toContain('g4');
    const ko = plan.rounds.filter((r) => r.stageKey === 's2');
    expect(ko.map((r) => r.label)).toEqual(['Quarterfinal', 'Semifinal', 'Third place', 'Final']);
    const spec = latestSpec('basketball.3x3');
    expect(spec.participation.roster).toEqual({ min: 3, max: 4 });
    expect(spec.participation.onCourt?.count).toBe(3);
    expect(spec.capabilities?.resourceTypes).toEqual(['BASKETBALL_HALF_COURT']);
  });
});

describe('qualifying → stepladder (bowling finals)', () => {
  it('seat 5 vs 4, the winner climbs, the final is against seat 1', () => {
    const plan = generate('qualifying-knockout', 40, { qualifiers: 5 }, ['SERIES', 'MATCH']);
    const ladder = plan.rounds.filter((r) => r.stageKey === 's2').map((r) => r.contests[0]);
    expect(ladder).toHaveLength(4);
    expect(ladder[0]?.slots.map((s) => s.rank)).toEqual([4, 5]);
    expect(ladder[3]?.slots[0]?.rank).toBe(1);
    expect(ladder[3]?.slots[1]?.source).toBe('WINNER_OF_CONTEST');
  });
});

describe('seeding v2', () => {
  const field = ids(12);
  it('bands seeds 3–4 and 5–8 and draws the unseeded; reproducible', () => {
    expect(seedBands(8)).toEqual([[1], [2], [3, 4], [5, 6, 7, 8]]);
    const seeds = field.slice(0, 8);
    const doc = computeSeeding({
      eventId: field[0] as string,
      fieldHash: `sha256:${'0'.repeat(64)}`,
      participantIds: field,
      request: {
        method: 'RANKED_THEN_DRAWN',
        seeds,
        source: { kind: 'DECLARED_EXTERNAL', label: 'FIP ranking', asOf: '2026-10-01' },
      },
      drawSeed: SEED,
    });
    expect(doc.order.slice(0, 2)).toEqual(seeds.slice(0, 2));
    expect(new Set(doc.order.slice(2, 4))).toEqual(new Set(seeds.slice(2, 4)));
    expect(new Set(doc.order.slice(4, 8))).toEqual(new Set(seeds.slice(4, 8)));
    expect(new Set(doc.order.slice(8))).toEqual(new Set(field.slice(8)));
    expect(seedingHashV2(doc)).toMatch(/^sha256:/);
  });
  it('orders by entry time ascending with missing times last; overrides are recorded', () => {
    const values = new Map([
      [field[3] as string, '61000'],
      [field[1] as string, '59000'],
      [field[2] as string, '61000'],
    ]);
    const doc = computeSeeding({
      eventId: field[0] as string,
      fieldHash: `sha256:${'0'.repeat(64)}`,
      participantIds: field,
      request: {
        method: 'BY_ENTRY_ATTRIBUTE',
        attributeKey: 'entryTimeMs',
        direction: 'ASC',
        overrides: [
          {
            participantId: field[11] as string,
            toPosition: 1,
            reason: 'Defending champion (organizer)',
          },
        ],
      },
      drawSeed: SEED,
      attributeValues: values,
      attributeType: 'DURATION_MS',
    });
    expect(doc.order[0]).toBe(field[11]);
    expect(doc.order[1]).toBe(field[1]);
    expect(new Set(doc.order.slice(2, 4))).toEqual(new Set([field[2], field[3]]));
    expect(doc.overrides).toHaveLength(1);
    expect(seedingHashV2(doc)).toMatch(/^sha256:/);
  });
  it('compares decimals exactly and validates declared values', () => {
    expect(compareDecimal('14.0', '14')).toBe(0);
    expect(compareDecimal('-1.5', '0.25')).toBe(-1);
    expect(validEntryAttributeValue('DECIMAL', '3.5', { min: '1.0', max: '4.5' })).toBe(true);
    expect(validEntryAttributeValue('DECIMAL', '5', { min: '1.0', max: '4.5' })).toBe(false);
    expect(validEntryAttributeValue('DURATION_MS', '-1')).toBe(false);
    expect(validEntryAttributeValue('TEXT', ' x')).toBe(false);
  });
});

describe('ruleset vocabulary (validated, not executed in ONCF-05B)', () => {
  it('every published template is valid and labelled with its basis', () => {
    for (const t of RULESET_TEMPLATES) {
      expect(validateRulesetSpec(t.spec), t.code).toEqual([]);
      expect(['GOVERNING_RULE', 'COMMON_PRACTICE']).toContain(t.basis.kind);
    }
  });
  it('refuses unknown families and parameters', () => {
    expect(validateRulesetSpec({ family: 'QUIDDITCH' as never, parameters: {} })).not.toEqual([]);
    expect(
      validateRulesetSpec({
        family: 'STABLEFORD',
        parameters: { holes: '18', allowancePercent: 95, magic: 1 },
      }),
    ).not.toEqual([]);
  });
});
