import { ALL_CAPABILITIES, type Uuid } from '@br/domain';
import { scopeContains } from '@br/authority';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  bracketSeedOrder,
  canTransition,
  catalogSpecHash,
  CatalogVersionLifecycle,
  CompetitionLifecycle,
  CompPermission,
  compPermissionsFor,
  ContestLifecycle,
  deterministicDraw,
  disciplineBelongsToSport,
  EventLifecycle,
  formatEngine,
  isTerminal,
  ParticipantLifecycle,
  pathToScope,
  planHash,
  RegistrationLifecycle,
  roundRobinV1,
  scopeMatchesPath,
  singleEliminationV1,
  STAFF_ROLE_PERMISSIONS,
  TeamMembershipLifecycle,
  validateCategory,
  validateDisciplineVersionSpec,
  type CompetitionFormatEngine,
  type DisciplineVersionSpec,
  type FormatEngineInput,
  type Lifecycle,
  type PlanDocument,
} from './index';

const ids = (n: number) =>
  Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
const input = (n: number, over: Partial<FormatEngineInput> = {}): FormatEngineInput => {
  const p = ids(n);
  return {
    eventId: '11111111-1111-4111-8111-111111111111',
    participants: p.map((participantId) => ({ participantId, kind: 'INDIVIDUAL' })),
    seedOrder: p,
    config: {},
    allowedContestTypes: ['MATCH'],
    ...over,
  };
};
const contests = (plan: PlanDocument) => plan.rounds.flatMap((r) => r.contests);
const pairKey = (a: string, b: string) => [a, b].sort().join('|');

// ───────────────────────────── single elimination ─────────────────────────────

function checkSingleElimination(n: number): PlanDocument {
  const plan = singleEliminationV1.generate(input(n));
  const all = contests(plan);
  const byKey = new Map(all.map((c) => [c.key, c]));
  // n − 1 contests, one final (last round, one contest)
  expect(all).toHaveLength(n - 1);
  const last = plan.rounds[plan.rounds.length - 1];
  expect(last?.roundType).toBe('FINAL');
  expect(last?.contests).toHaveLength(1);
  expect(plan.rounds.filter((r) => r.roundType === 'FINAL')).toHaveLength(1);
  // every participant appears exactly once as a direct PARTICIPANT slot
  const direct = all.flatMap((c) =>
    c.slots.filter((s) => s.source === 'PARTICIPANT').map((s) => s.participantId),
  );
  expect(new Set(direct).size).toBe(direct.length);
  expect(new Set(direct)).toEqual(new Set(ids(n)));
  // every dependency references an earlier contest; every contest except the final feeds exactly one later slot
  const fedBy = new Map<string, number>();
  for (const c of all) {
    expect(c.slots).toHaveLength(2);
    for (const s of c.slots) {
      if (s.source === 'WINNER_OF_CONTEST') {
        const src = byKey.get(s.contestKey as string);
        expect(src, `dependency ${s.contestKey}`).toBeDefined();
        expect((src?.sequence ?? Infinity) < c.sequence).toBe(true); // acyclic by construction
        fedBy.set(s.contestKey as string, (fedBy.get(s.contestKey as string) ?? 0) + 1);
      } else expect(s.source).toBe('PARTICIPANT');
    }
  }
  for (const c of all) expect(fedBy.get(c.key) ?? 0).toBe(c === last?.contests[0] ? 0 : 1);
  // nothing is resolved: no slot names a winner
  expect(JSON.stringify(plan)).not.toMatch(/winner"|champion/i);
  return plan;
}

describe('single elimination v1', () => {
  it.each([2, 3, 4, 5, 8])(
    '%i entrants: n−1 contests, one final, acyclic, no duplicate participant',
    (n) => {
      checkSingleElimination(n);
    },
  );

  it('standard seed placement keeps seeds 1 and 2 apart until the final', () => {
    expect(bracketSeedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
    const plan = singleEliminationV1.generate(input(8));
    const [s1, , , , s2] = ids(8).map((id, i) => ({ id, seed: i + 1 }));
    const r1 = plan.rounds[0]?.contests ?? [];
    const halfOf = (id: string) =>
      r1.findIndex((c) => c.slots.some((s) => s.participantId === id)) < 2;
    expect(halfOf(s1?.id as string)).not.toBe(halfOf(ids(8)[1] as string));
    expect(s2).toBeDefined();
  });

  it('byes: top seeds skip round 1 structurally (no contest against a BYE, no fabricated winner)', () => {
    const plan = checkSingleElimination(5);
    const [seed1, seed2, seed3] = ids(5);
    const r1 = plan.rounds[0]?.contests ?? [];
    expect(r1).toHaveLength(1); // only seeds 4 v 5 play in round 1
    expect(r1[0]?.slots.map((s) => s.participantId)).toEqual([ids(5)[3], ids(5)[4]]);
    const semis = plan.rounds[1]?.contests ?? [];
    expect(semis[0]?.slots).toEqual([
      { slot: 1, source: 'PARTICIPANT', participantId: seed1 },
      { slot: 2, source: 'WINNER_OF_CONTEST', contestKey: r1[0]?.key },
    ]);
    expect(semis[1]?.slots.map((s) => s.participantId)).toEqual([seed2, seed3]);
    expect(plan.rounds[2]?.contests[0]?.slots.every((s) => s.source === 'WINNER_OF_CONTEST')).toBe(
      true,
    );
  });

  it('stable bracket positions: keys follow bracket position, independent of which pairs are byes', () => {
    const plan = singleEliminationV1.generate(input(6)); // size 8, byes for seeds 1 and 2
    expect(plan.rounds[0]?.contests.map((c) => c.key)).toEqual(['r1-c2', 'r1-c4']);
    expect(plan.rounds[1]?.contests.map((c) => c.key)).toEqual(['r2-c1', 'r2-c2']);
  });

  it('property: valid for every field size 2..64, deterministic, seed order preserved', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 64 }), (n) => {
        const a = checkSingleElimination(n);
        const b = singleEliminationV1.generate(input(n));
        expect(planHash(a)).toBe(planHash(b));
        // seed 1 is always in the top slot of the first contest it appears in
        const first = contests(a).find((c) => c.slots.some((s) => s.participantId === ids(n)[0]));
        expect(first?.slots[0]?.participantId).toBe(ids(n)[0]);
      }),
      { numRuns: 63 },
    );
  });

  it('a different seed order yields a different plan hash; the same order the same hash', () => {
    const base = input(8);
    const swapped = { ...base, seedOrder: [...base.seedOrder].reverse() };
    expect(planHash(singleEliminationV1.generate(base))).toBe(
      planHash(singleEliminationV1.generate(input(8))),
    );
    expect(planHash(singleEliminationV1.generate(swapped))).not.toBe(
      planHash(singleEliminationV1.generate(base)),
    );
  });
});

// ───────────────────────────── round robin ─────────────────────────────

function checkRoundRobin(n: number): PlanDocument {
  const plan = roundRobinV1.generate(input(n));
  const all = contests(plan);
  expect(all).toHaveLength((n * (n - 1)) / 2);
  const pairs = new Set<string>();
  for (const c of all) {
    const [a, b] = c.slots.map((s) => s.participantId as string);
    expect(a).not.toBe(b); // no self-pairing
    const k = pairKey(a as string, b as string);
    expect(pairs.has(k)).toBe(false); // no duplicate pairing
    pairs.add(k);
  }
  // each round: every participant at most once; byes balanced
  const byeCount = new Map<string, number>();
  for (const r of plan.rounds) {
    const seen = r.contests
      .flatMap((c) => c.slots.map((s) => s.participantId as string))
      .concat(r.byes);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(n);
    for (const b of r.byes) byeCount.set(b, (byeCount.get(b) ?? 0) + 1);
  }
  if (n % 2 === 1) {
    expect(plan.rounds).toHaveLength(n);
    for (const id of ids(n)) expect(byeCount.get(id)).toBe(1);
  } else {
    expect(plan.rounds).toHaveLength(n - 1);
    expect(byeCount.size).toBe(0);
  }
  return plan;
}

describe('round robin v1', () => {
  it.each([2, 3, 4, 5])(
    '%i entrants: everyone meets everyone once, no self-pairing, balanced BYEs',
    (n) => {
      checkRoundRobin(n);
    },
  );

  it('property: valid and deterministic for every field size 2..40', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 40 }), (n) => {
        expect(planHash(checkRoundRobin(n))).toBe(planHash(roundRobinV1.generate(input(n))));
      }),
      { numRuns: 39 },
    );
  });
});

describe('engine input guards (shared)', () => {
  const engines: CompetitionFormatEngine[] = [singleEliminationV1, roundRobinV1];
  it.each(engines.map((e) => [e.id, e] as const))(
    '%s refuses bad fields, bad seed orders and disallowed contest types',
    (_id, engine) => {
      expect(() => engine.generate(input(1))).toThrow(/participants/);
      expect(() => engine.generate(input(4, { seedOrder: ids(4).slice(0, 3) }))).toThrow(
        /permutation/,
      );
      expect(() =>
        engine.generate(input(4, { seedOrder: [...ids(3), ids(3)[0] as string] })),
      ).toThrow(/permutation/);
      const dup = input(4);
      expect(() =>
        engine.generate({
          ...dup,
          participants: [...dup.participants.slice(0, 3), dup.participants[0]!],
        }),
      ).toThrow(/duplicate/);
      // e.g. a running discipline that only allows HEAT contests cannot use a head-to-head format
      expect(() => engine.generate(input(4, { allowedContestTypes: ['HEAT'] }))).toThrow(
        /does not allow/,
      );
      expect(() => engine.generate(input(4, { config: { unexpected: true } }))).toThrow(
        /configuration/,
      );
    },
  );

  it('registry resolves exact versions only', () => {
    expect(formatEngine('single-elimination', 1)).toBe(singleEliminationV1);
    expect(formatEngine('round-robin', 1)).toBe(roundRobinV1);
    expect(formatEngine('single-elimination', 2)).toBeUndefined();
    expect(formatEngine('double-elimination', 1)).toBeUndefined();
  });
});

// ───────────────────────────── draw ─────────────────────────────

describe('deterministic draw br-draw/1', () => {
  const seed = 'a'.repeat(64);
  it('is a permutation, reproducible from (field, seed), independent of input order', () => {
    const field = ids(16);
    const a = deterministicDraw(field, seed);
    expect([...a].sort()).toEqual([...field].sort());
    expect(deterministicDraw([...field].reverse(), seed)).toEqual(a);
    expect(deterministicDraw(field, 'b'.repeat(64))).not.toEqual(a);
  });

  it('property: always a permutation; different seeds usually differ', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 64 }), fc.stringMatching(/^[0-9a-f]{64}$/), (n, s) => {
        const d = deterministicDraw(ids(n), s);
        expect(new Set(d)).toEqual(new Set(ids(n)));
        expect(deterministicDraw(ids(n), s)).toEqual(d);
      }),
    );
  });

  it('refuses malformed seeds and duplicate participants', () => {
    expect(() => deterministicDraw(ids(4), 'xyz')).toThrow(/draw seed/);
    expect(() => deterministicDraw([...ids(3), ids(3)[0] as string], seed)).toThrow(/duplicate/);
  });
});

// ───────────────────────────── lifecycles ─────────────────────────────

const EXPECTED: Record<string, Record<string, string[]>> = {
  competition: {
    DRAFT: ['PUBLISHED', 'CANCELLED'],
    PUBLISHED: ['ACTIVE', 'CANCELLED'],
    ACTIVE: ['COMPLETED', 'CANCELLED'],
    COMPLETED: [],
    CANCELLED: [],
  },
  event: {
    DRAFT: ['REGISTRATION_OPEN', 'CANCELLED'],
    REGISTRATION_OPEN: ['REGISTRATION_CLOSED', 'CANCELLED'],
    REGISTRATION_CLOSED: ['REGISTRATION_OPEN', 'FIELD_LOCKED', 'CANCELLED'],
    FIELD_LOCKED: ['IN_PROGRESS', 'CANCELLED'],
    IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
    COMPLETED: [],
    CANCELLED: [],
  },
  registration: {
    REQUESTED: ['CONFIRMED', 'WAITLISTED', 'DECLINED', 'WITHDRAWN'],
    WAITLISTED: ['CONFIRMED', 'DECLINED', 'WITHDRAWN'],
    CONFIRMED: ['WITHDRAWN', 'CANCELLED'],
    DECLINED: [],
    WITHDRAWN: [],
    CANCELLED: [],
  },
  contest: {
    PLANNED: ['SCHEDULED', 'CANCELLED'],
    SCHEDULED: ['IN_PROGRESS', 'CANCELLED'],
    IN_PROGRESS: ['COMPLETED', 'VOID'],
    COMPLETED: ['VOID'],
    CANCELLED: [],
    VOID: [],
  },
  participant: { ACTIVE: ['WITHDRAWN', 'DISQUALIFIED'], WITHDRAWN: [], DISQUALIFIED: [] },
  'team-membership': {
    PROPOSED: ['ACTIVE', 'DECLINED'],
    ACTIVE: ['ENDED'],
    DECLINED: [],
    ENDED: [],
  },
  'catalog-version': { DRAFT: ['PUBLISHED', 'RETIRED'], PUBLISHED: ['RETIRED'], RETIRED: [] },
};

describe('lifecycle transition matrices (every pair checked)', () => {
  const all: Lifecycle<string>[] = [
    CompetitionLifecycle,
    EventLifecycle,
    RegistrationLifecycle,
    ContestLifecycle,
    ParticipantLifecycle,
    TeamMembershipLifecycle,
    CatalogVersionLifecycle,
  ] as Lifecycle<string>[];
  it.each(all.map((lc) => [lc.name, lc] as const))('%s', (name, lc) => {
    const expected = EXPECTED[name] as Record<string, string[]>;
    expect(new Set(lc.states)).toEqual(new Set(Object.keys(expected)));
    for (const from of lc.states) {
      for (const to of lc.states) {
        expect(canTransition(lc, from, to), `${name}: ${from} → ${to}`).toBe(
          (expected[from] ?? []).includes(to),
        );
      }
      expect(isTerminal(lc, from)).toBe((expected[from] ?? []).length === 0);
    }
    expect(canTransition(lc, 'NOT_A_STATE', lc.states[0] as string)).toBe(false);
  });

  it('no path from FIELD_LOCKED back to registration; COMPLETED/CANCELLED are terminal', () => {
    expect(canTransition(EventLifecycle, 'FIELD_LOCKED', 'REGISTRATION_OPEN')).toBe(false);
    expect(canTransition(EventLifecycle, 'FIELD_LOCKED', 'REGISTRATION_CLOSED')).toBe(false);
    for (const lc of [CompetitionLifecycle, EventLifecycle] as Lifecycle<string>[]) {
      expect(isTerminal(lc, 'COMPLETED')).toBe(true);
      expect(isTerminal(lc, 'CANCELLED')).toBe(true);
    }
  });
});

// ───────────────────────────── catalog specs ─────────────────────────────

export const PADEL_SPEC: DisciplineVersionSpec = {
  resultSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['setsWon', 'gamesWon'],
    properties: {
      setsWon: { type: 'integer', minimum: 0, maximum: 5 },
      gamesWon: { type: 'integer', minimum: 0, maximum: 99 },
    },
  },
  metrics: [
    { key: 'setsWon', valueType: 'INTEGER', unit: 'sets' },
    { key: 'gamesWon', valueType: 'INTEGER', unit: 'games' },
  ],
  comparator: {
    outcomeModel: 'WIN_LOSS_DRAW',
    primary: 'HEAD_TO_HEAD_WINNER',
    keys: [
      { metric: 'setsWon', order: 'HIGHER_IS_BETTER' },
      { metric: 'gamesWon', order: 'HIGHER_IS_BETTER' },
    ],
  },
  validation: { bounds: [{ metric: 'setsWon', min: '0', max: '3' }] },
  allowedContestTypes: ['MATCH'],
  participation: { participantKinds: ['TEAM'], lineupSize: { min: 2, max: 2 } },
  evidenceExpectations: ['SIGNED_SCORESHEET'],
};

describe('discipline version specs', () => {
  it('accepts a well-formed spec (padel doubles) and a metric-ranked one (running 5k)', () => {
    expect(validateDisciplineVersionSpec(PADEL_SPEC)).toEqual([]);
    const running: DisciplineVersionSpec = {
      resultSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['elapsedTimeMs'],
        properties: { elapsedTimeMs: { type: 'integer', minimum: 0 } },
      },
      metrics: [{ key: 'elapsedTimeMs', valueType: 'DURATION_MS', unit: 'ms' }],
      comparator: {
        outcomeModel: 'RANKED',
        primary: 'METRICS',
        keys: [{ metric: 'elapsedTimeMs', order: 'LOWER_IS_BETTER' }],
      },
      validation: { bounds: [{ metric: 'elapsedTimeMs', min: '600000' }] },
      allowedContestTypes: ['HEAT'],
      participation: { participantKinds: ['INDIVIDUAL'], lineupSize: { min: 1, max: 1 } },
    };
    expect(validateDisciplineVersionSpec(running)).toEqual([]);
  });

  it('rejects invalid result schemas and comparators', () => {
    const bad = (over: Partial<DisciplineVersionSpec>) =>
      validateDisciplineVersionSpec({ ...PADEL_SPEC, ...over });
    expect(
      bad({
        resultSchema: { type: 'object', additionalProperties: true, properties: {} } as never,
      }),
    ).not.toEqual([]);
    expect(
      bad({
        resultSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { x: { type: 'number' } },
        } as never,
      }),
    ).not.toEqual([]);
    expect(bad({ metrics: [{ key: 'notInSchema', valueType: 'INTEGER', unit: 'x' }] })).not.toEqual(
      [],
    );
    expect(
      bad({
        comparator: {
          ...PADEL_SPEC.comparator,
          keys: [{ metric: 'unknown', order: 'HIGHER_IS_BETTER' }],
        },
      }),
    ).not.toEqual([]);
    expect(
      bad({ comparator: { outcomeModel: 'RANKED', primary: 'HEAD_TO_HEAD_WINNER', keys: [] } }),
    ).not.toEqual([]);
    expect(
      bad({ comparator: { outcomeModel: 'RANKED', primary: 'METRICS', keys: [] } }),
    ).not.toEqual([]);
    expect(
      bad({ comparator: { ...PADEL_SPEC.comparator, primary: 'SCRIPT' as never } }),
    ).not.toEqual([]);
    expect(
      bad({
        comparator: {
          ...PADEL_SPEC.comparator,
          keys: [
            { metric: 'setsWon', order: 'HIGHER_IS_BETTER' },
            { metric: 'setsWon', order: 'LOWER_IS_BETTER' },
          ],
        },
      }),
    ).not.toEqual([]);
    expect(bad({ allowedContestTypes: [] })).not.toEqual([]);
    expect(
      bad({ participation: { participantKinds: ['INDIVIDUAL'], lineupSize: { min: 1, max: 2 } } }),
    ).not.toEqual([]);
    expect(
      bad({ validation: { bounds: [{ metric: 'setsWon', min: '5', max: '1' }] } }),
    ).not.toEqual([]);
    expect(bad({ validation: { bounds: [{ metric: 'setsWon', min: '0.5e3' }] } })).not.toEqual([]);
    expect(bad({ evidenceExpectations: ['lowercase'] })).not.toEqual([]);
    expect(
      validateDisciplineVersionSpec({ ...PADEL_SPEC, script: 'return 1' } as never),
    ).not.toEqual([]);
    expect(
      validateDisciplineVersionSpec({ ...PADEL_SPEC, evidenceExpectations: [null] } as never),
    ).not.toEqual([]);
    expect(
      validateDisciplineVersionSpec({
        ...PADEL_SPEC,
        participation: { participantKinds: ['TEAM'], lineupSize: { min: 1.5, max: 2 } },
      } as never),
    ).not.toEqual([]);
  });

  it('spec hashes are canonical (key order irrelevant) and content-sensitive', () => {
    // same content, reversed key insertion order
    const reordered = Object.fromEntries(
      Object.entries(PADEL_SPEC).reverse(),
    ) as unknown as DisciplineVersionSpec;
    expect(Object.keys(reordered)[0]).not.toBe(Object.keys(PADEL_SPEC)[0]);
    expect(catalogSpecHash('br:discipline-version-spec', reordered)).toBe(
      catalogSpecHash('br:discipline-version-spec', PADEL_SPEC),
    );
    expect(
      catalogSpecHash('br:discipline-version-spec', {
        ...PADEL_SPEC,
        allowedContestTypes: ['MATCH', 'SESSION'],
      }),
    ).not.toBe(catalogSpecHash('br:discipline-version-spec', PADEL_SPEC));
  });

  it('discipline codes are sport-namespaced', () => {
    expect(disciplineBelongsToSport('padel.doubles', 'padel')).toBe(true);
    expect(disciplineBelongsToSport('padel.doubles', 'tennis')).toBe(false);
    expect(disciplineBelongsToSport('padeldoubles', 'padel')).toBe(false);
  });

  it('categories are declared labels with a closed shape', () => {
    expect(
      validateCategory({
        genderCategory: 'MIXED',
        ageCategory: { label: 'U18', maxAge: 17 },
        skillClass: 'A',
      }),
    ).toEqual([]);
    expect(validateCategory({ genderCategory: 'X' })).not.toEqual([]);
    expect(validateCategory({ dob: '2000-01-01' })).not.toEqual([]);
    expect(validateCategory({ ageCategory: { label: 'U18', minAge: 18, maxAge: 10 } })).not.toEqual(
      [],
    );
    expect(validateCategory({ skillClass: 'A\u0000' })).not.toEqual([]);
  });
});

// ───────────────────────────── permissions & hierarchy ─────────────────────────────

describe('competition application permissions', () => {
  it('share no value with BRT capabilities; no staff role bears authority', () => {
    const caps = new Set<string>(ALL_CAPABILITIES);
    expect(caps.size).toBeGreaterThan(5);
    for (const p of Object.values(CompPermission)) expect(caps.has(p)).toBe(false);
    for (const role of Object.keys(STAFF_ROLE_PERMISSIONS))
      expect(role).not.toMatch(/REFEREE|OFFICIAL|JUDGE/);
  });

  it('roles map to the documented permission sets', () => {
    expect(compPermissionsFor(['OWNER']).size).toBe(Object.values(CompPermission).length);
    expect(compPermissionsFor(['ADMIN']).has('COMP_MANAGE_STAFF')).toBe(false);
    expect(compPermissionsFor(['SCHEDULER']).has('COMP_LOCK_FIELD')).toBe(false);
    expect(compPermissionsFor(['REGISTRATION_MANAGER']).has('COMP_MANAGE_SCHEDULE')).toBe(false);
    expect(compPermissionsFor([]).size).toBe(0);
  });
});

describe('hierarchy path → authority scope', () => {
  const C1 = 'c1000000-0000-4000-8000-000000000001' as Uuid;
  const C2 = 'c2000000-0000-4000-8000-000000000002' as Uuid;
  const E1 = 'e1000000-0000-4000-8000-000000000001' as Uuid;
  const E2 = 'e2000000-0000-4000-8000-000000000002' as Uuid;
  const X = 'a1000000-0000-4000-8000-000000000001' as Uuid;
  const R1 = 'b1000000-0000-4000-8000-000000000001' as Uuid;
  const contestIn = (competitionId: string, eventId: string, contestId: string) =>
    pathToScope({
      level: 'CONTEST',
      competitionId,
      eventId,
      roundId: R1,
      contestId,
      sport: 'padel',
      discipline: 'padel.doubles',
    });

  it('a competition grant covers descendants only through their resolved path', () => {
    expect(scopeContains({ competition: [C1] }, contestIn(C1, E1, X))).toBe(true);
    expect(scopeContains({ competition: [C1] }, contestIn(C2, E2, X))).toBe(false);
    expect(scopeContains({ event: [E1] }, contestIn(C1, E1, X))).toBe(true);
    expect(scopeContains({ event: [E1] }, contestIn(C1, E2, X))).toBe(false);
    expect(scopeContains({ contest: [X] }, contestIn(C1, E1, X))).toBe(true);
    expect(
      scopeContains({ contest: [X] }, contestIn(C1, E1, 'a2000000-0000-4000-8000-000000000002')),
    ).toBe(false);
    expect(
      scopeContains({ discipline: ['padel.*'], competition: [C1] }, contestIn(C1, E1, X)),
    ).toBe(true);
    expect(scopeContains({ sport: ['tennis'] }, contestIn(C1, E1, X))).toBe(false);
    // a competition-level request has no sport: a sport-scoped grant fails closed
    expect(
      scopeContains({ sport: ['padel'] }, pathToScope({ level: 'COMPETITION', competitionId: C1 })),
    ).toBe(false);
  });

  it('supplied scopes must state exactly the resolved hierarchy (no claimed ancestry)', () => {
    const path = {
      level: 'CONTEST' as const,
      competitionId: C1,
      eventId: E1,
      roundId: R1,
      contestId: X,
      sport: 'padel',
      discipline: 'padel.doubles',
    };
    expect(scopeMatchesPath({ ...pathToScope(path), recognitionLevel: ['PLATFORM'] }, path)).toBe(
      true,
    );
    expect(scopeMatchesPath({ ...pathToScope(path), competition: [C2] }, path)).toBe(false);
    expect(scopeMatchesPath({ contest: [X] }, path)).toBe(false);
    expect(scopeMatchesPath({ ...pathToScope(path), competition: [C1, C2] }, path)).toBe(false);
  });
});
