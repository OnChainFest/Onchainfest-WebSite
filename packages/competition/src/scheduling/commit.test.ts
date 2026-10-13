import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { ResourceType } from '../capabilities';
import { RESOURCE_TYPE_DEFAULT_OCCUPANCY_MODE } from '../resources/resource';
import {
  planProposalCommit,
  planProposalCommitWithBudget,
  type ProposalCommitRequest,
  type ProposalCommitResult,
} from './commit';
import { at, HOUR, must, spec, T0, World } from './engine.fixture';
import type { SchedulingProfileSpec } from './profile';
import {
  proposalHash,
  proposeSchedule,
  proposeScheduleWithBudget,
  type ScheduleProposal,
  type ScheduleProposalInput,
} from './proposal';
import { SCHEDULING_PROFILE_TEMPLATES } from './templates';

/**
 * ONCF-05E-F-1 commit decision (ADR-0075 § 16–17, ADR-0076). Every proposal here is produced by the
 * real engine and judged by the real 05E-D judge; nothing is mocked.
 */

const DAY = 24 * HOUR;
const S = (ms: number) => Math.floor(ms / 1000);

function world(
  profile: SchedulingProfileSpec | null = spec({}),
  o: { windowEndMs?: number } = {},
): World {
  return new World().event('e1', {
    profile,
    windowStartMs: T0,
    windowEndMs: o.windowEndMs ?? T0 + 3 * DAY,
  });
}

type Contest = Parameters<World['contest']>[1];
const planned = (w: World, id: string, o: Contest = {}) =>
  w.contest(id, { status: 'PLANNED', ...o });

function input(
  w: World,
  o: Partial<Omit<ScheduleProposalInput, 'judge'>> = {},
): ScheduleProposalInput {
  return {
    judge: w.input(),
    draftStatus: 'DRAFT',
    competitionStatus: 'IN_PROGRESS',
    basePublishedVersionId: 'version-1',
    eventStatuses: w.events.map((e) => ({ eventId: e.id, status: 'FIELD_LOCKED' })),
    latestOffsets: w.contests.map((c) => ({ contestId: c.id, seconds: 0 })),
    ...o,
  };
}

const commit = (i: ScheduleProposalInput, proposalHash: string) =>
  planProposalCommit(i, { proposalHash });

function plan(r: ProposalCommitResult) {
  if (!r.ok) throw new Error(`expected a plan, got ${JSON.stringify(r.refusal)}`);
  return r.plan;
}
function refusal(r: ProposalCommitResult) {
  if (r.ok) throw new Error('expected a refusal, got a plan');
  // A refusal carries no plan and no placements of any kind.
  expect(Object.keys(r).sort()).toEqual(['ok', 'refusal']);
  return r.refusal;
}

/** The facts a commit writes are exactly the proposal's placements, minus report-only SOFT keys. */
const asFacts = (p: ScheduleProposal) =>
  p.placements.map(({ softConflictKeys: _, ...fact }) => fact);

/** What 05E-F-2 will do with a plan, simulated on the fixture: append one fact per placement. */
function apply(w: World, p: ReturnType<typeof plan>) {
  for (const f of p.facts)
    w.assign(f.contestId, {
      id: `fact-${f.contestId}`,
      resource: f.resourceId,
      startMs: f.start * 1000,
      endMs: f.expectedEnd * 1000,
      changeover: f.changeoverSeconds,
      unitKey: f.unitKey,
    });
}

/** Two matches, one court, a one-hour window: m1 is placed, m2 cannot be (INFEASIBLE). */
function infeasible() {
  const w = world(spec({}), { windowEndMs: T0 + HOUR }).resource('c1');
  for (const e of ['a', 'b', 'c', 'd']) w.entrant(e);
  planned(w, 'm1', { entrants: ['a', 'b'] });
  planned(w, 'm2', { entrants: ['c', 'd'] });
  return w;
}

/** Run budget 2: m1 is placed, m2 is BUDGET_EXHAUSTED (SEARCH_EXHAUSTED). */
const SMALL_BUDGET = { maxEvaluations: 2, maxEvaluationsPerUnit: 500 };
function exhausted() {
  const w = world().resource('c1');
  for (const e of ['a', 'b', 'c', 'd', 'e', 'f']) w.entrant(e);
  w.contest('m0', { entrants: ['a', 'b'] }).assign('m0', { resource: 'c1', start: 0, end: 60 });
  planned(w, 'm1', { entrants: ['a', 'c'] });
  planned(w, 'm2', { entrants: ['e', 'f'] });
  return w;
}

/** Two matches on two courts plus a preserved, already-assigned match. */
function successWorld() {
  const w = world(spec({ changeoverSeconds: 600 }))
    .resource('c1')
    .resource('c2');
  for (const e of ['a', 'b', 'c', 'd', 'e', 'f']) w.entrant(e);
  w.contest('m0', { entrants: ['e', 'f'] }).assign('m0', { resource: 'c1', start: 0, end: 60 });
  planned(w, 'm1', { entrants: ['a', 'b'] });
  planned(w, 'm2', { entrants: ['c', 'd'] });
  return w;
}

// ───────────────────────────── A / F. SUCCESS commits ─────────────────────────────

describe('A/F. a SUCCESS proposal with the matching hash yields its commit plan', () => {
  it('the plan is exactly the recomputed placements, with the proposal identity', () => {
    const w = successWorld();
    const p = proposeSchedule(input(w));
    expect(p.status).toBe('SUCCESS');
    expect(p.placements.length).toBe(2);
    const r = plan(commit(input(w), p.proposalHash));
    expect(r).toEqual({
      competitionId: 'comp-1',
      scheduleVersionId: 'version-2',
      proposalHash: p.proposalHash,
      baseStateIdentity: p.baseStateIdentity,
      strategy: p.strategy,
      budget: p.budget,
      reportHash: p.report.reportHash,
      reason: `proposal ${p.proposalHash}`,
      facts: asFacts(p),
      placedUnits: 2,
      placedContests: 2,
      unplacedUnits: 0,
    });
  });

  it('facts are sorted by contest id and carry every assignment-level value', () => {
    const w = successWorld();
    const p = proposeSchedule(input(w));
    const facts = plan(commit(input(w), p.proposalHash)).facts;
    expect(facts.map((f) => f.contestId)).toEqual(['m1', 'm2']);
    for (const f of facts)
      expect(Object.keys(f).sort()).toEqual([
        'changeoverSeconds',
        'contestId',
        'expectedEnd',
        'provisional',
        'resourceId',
        'start',
        'unitKey',
        'zone',
      ]);
    expect(facts[0]).toMatchObject({ changeoverSeconds: 600, zone: 'UTC', provisional: false });
  });

  it('the provenance reason is deterministic and within the 500-character CHECK', () => {
    const w = successWorld();
    const p = proposeSchedule(input(w));
    const { reason } = plan(commit(input(w), p.proposalHash));
    expect(reason).toMatch(/^proposal sha256:[0-9a-f]{64}$/);
    expect(reason.length).toBeLessThanOrEqual(500);
  });

  it('a provisional placement stays provisional in the plan (unresolved place)', () => {
    const w = world().resource('c1').resource('c2');
    for (const e of ['a', 'b', 'c', 'd']) w.entrant(e);
    w.contest('f1', { entrants: ['a', 'b'] }).assign('f1', { resource: 'c1', start: 0, end: 60 });
    w.contest('f2', { entrants: ['c', 'd'] }).assign('f2', { resource: 'c2', start: 0, end: 60 });
    planned(w, 'final', { round: 'r2', roundSeq: 2 });
    w.place('final', 1, { feeders: ['f1'] }).place('final', 2, { feeders: ['f2'] });
    const p = proposeSchedule(input(w));
    expect(p.status).toBe('SUCCESS');
    const facts = plan(commit(input(w), p.proposalHash)).facts;
    expect(facts).toEqual([expect.objectContaining({ contestId: 'final', provisional: true })]);
  });
});

// ───────────────────────────── B–E. no partial commit (ADR-0076 C1–C2) ─────────────────────────────

describe('B–E. only SUCCESS is committable; partial placements never become a plan', () => {
  it('B/D. INFEASIBLE with a placed unit: PROPOSAL_NOT_COMMITTABLE, no plan', () => {
    const w = infeasible();
    const p = proposeSchedule(input(w));
    expect(p.status).toBe('INFEASIBLE');
    expect(p.placements.map((x) => x.contestId)).toEqual(['m1']);
    expect(refusal(commit(input(w), p.proposalHash))).toEqual({
      reason: 'PROPOSAL_NOT_COMMITTABLE',
      code: 'INVALID_TRANSITION',
      status: 'INFEASIBLE',
    });
  });

  it('C/E. SEARCH_EXHAUSTED with a placed unit: PROPOSAL_NOT_COMMITTABLE, no plan', () => {
    const w = exhausted();
    const p = proposeScheduleWithBudget(input(w), SMALL_BUDGET);
    expect(p.status).toBe('SEARCH_EXHAUSTED');
    expect(p.placements.map((x) => x.contestId)).toEqual(['m1']);
    const r = planProposalCommitWithBudget(
      input(w),
      { proposalHash: p.proposalHash },
      SMALL_BUDGET,
    );
    expect(refusal(r)).toEqual({
      reason: 'PROPOSAL_NOT_COMMITTABLE',
      code: 'INVALID_TRANSITION',
      status: 'SEARCH_EXHAUSTED',
    });
  });

  it('SEARCH_EXHAUSTED from a per-unit budget is refused the same way', () => {
    const budget = { maxEvaluations: 100, maxEvaluationsPerUnit: 1 };
    const w = exhausted();
    const p = proposeScheduleWithBudget(input(w), budget);
    expect(p.status).toBe('SEARCH_EXHAUSTED');
    expect(
      refusal(planProposalCommitWithBudget(input(w), { proposalHash: p.proposalHash }, budget)),
    ).toMatchObject({ reason: 'PROPOSAL_NOT_COMMITTABLE', status: 'SEARCH_EXHAUSTED' });
  });

  it('NOTHING_TO_PLACE and NO_CANDIDATES are refused (no empty commits)', () => {
    const nothing = world().resource('c1');
    nothing.entrant('a').entrant('b');
    nothing.contest('m0', { entrants: ['a', 'b'] }).assign('m0', { resource: 'c1' });
    const none = world(spec({ resourceType: 'PADEL_COURT' })).resource('c1');
    none.entrant('a').entrant('b');
    planned(none, 'm1', { entrants: ['a', 'b'] });
    for (const [w, status] of [
      [nothing, 'NOTHING_TO_PLACE'],
      [none, 'NO_CANDIDATES'],
    ] as const) {
      const p = proposeSchedule(input(w));
      expect(p.status).toBe(status);
      expect(refusal(commit(input(w), p.proposalHash))).toEqual({
        reason: 'PROPOSAL_NOT_COMMITTABLE',
        code: 'INVALID_TRANSITION',
        status,
      });
    }
  });
});

// ───────────────────────────── G / K / U. staleness (ADR-0075 § 16) ─────────────────────────────

describe('G/K/U. a hash that does not match the recomputation is PROPOSAL_STALE', () => {
  const STALE = { reason: 'PROPOSAL_STALE', code: 'CONCURRENCY_CONFLICT' };

  it('G. a different or malformed hash', () => {
    const w = successWorld();
    for (const h of [`sha256:${'0'.repeat(64)}`, 'not-a-hash', ''])
      expect(refusal(commit(input(w), h))).toEqual(STALE);
  });

  it('4. a hash previewed on an earlier authoritative state', () => {
    const edits: [string, (w: World) => void][] = [
      ['assignment added', (w) => w.contest('x', {}).assign('x', { resource: 'c2', start: 999 })],
      ['resource added', (w) => w.resource('c3')],
      [
        'resource retired',
        (w) => (w.resources[1] = { ...must(w.resources[1]), status: 'RETIRED' }),
      ],
      [
        'availability fact',
        (w) => w.fact('closed', 'c1', { kind: 'DATE_CLOSED', date: '2026-11-20' }),
      ],
    ];
    for (const [name, edit] of edits) {
      const w = successWorld();
      const p = proposeSchedule(input(w));
      edit(w);
      expect(refusal(commit(input(w), p.proposalHash)), name).toEqual(STALE);
    }
  });

  it('U. a changed profile pin (version or spec hash) makes the proposal stale', () => {
    const w = successWorld();
    const p = proposeSchedule(input(w));
    const e = must(w.events[0]);
    const pinned = e.profile as NonNullable<typeof e.profile>;
    w.events[0] = { ...e, profile: { ...pinned, versionId: 'pv-other' } };
    expect(refusal(commit(input(w), p.proposalHash))).toEqual(STALE);
  });

  it('U. a changed event status makes the proposal stale', () => {
    const w = successWorld();
    const p = proposeSchedule(input(w));
    const changed = input(w, { eventStatuses: [{ eventId: 'e1', status: 'IN_PROGRESS' }] });
    expect(refusal(commit(changed, p.proposalHash))).toEqual(STALE);
  });

  it('K/3. a changed scope or `from` cannot reuse the old hash', () => {
    const w = successWorld().event('e2', { profile: spec({}), windowStartMs: T0 });
    const p = proposeSchedule(input(w));
    expect(refusal(commit(input(w, { scope: { eventIds: ['e1'] } }), p.proposalHash))).toEqual(
      STALE,
    );
    expect(refusal(commit(input(w, { scope: { roundIds: ['r1'] } }), p.proposalHash))).toEqual(
      STALE,
    );
    expect(refusal(commit(input(w, { fromMs: at(60) }), p.proposalHash))).toEqual(STALE);
    const scoped = proposeSchedule(input(w, { scope: { eventIds: ['e1'] } }));
    expect(scoped.proposalHash).not.toBe(p.proposalHash);
    expect(refusal(commit(input(w), scoped.proposalHash))).toEqual(STALE);
  });

  it('stale wins over not-committable (ADR-0076 C5): a changed INFEASIBLE base is stale', () => {
    const w = infeasible();
    const p = proposeSchedule(input(w));
    expect(p.status).toBe('INFEASIBLE');
    w.entrant('z');
    planned(w, 'm3', { entrants: ['z', 'a'] });
    expect(refusal(commit(input(w), p.proposalHash))).toEqual(STALE);
  });

  it('stale never commits a different proposal: a now-SUCCESS recomputation is still refused', () => {
    const w = infeasible();
    const p = proposeSchedule(input(w));
    w.resource('c2'); // m2 now fits: the current proposal would be SUCCESS
    expect(proposeSchedule(input(w)).status).toBe('SUCCESS');
    expect(refusal(commit(input(w), p.proposalHash))).toEqual(STALE);
  });

  it('10. a duplicate commit after the plan was applied is stale (the watermark changed)', () => {
    const w = successWorld();
    const p = proposeSchedule(input(w));
    const first = plan(commit(input(w), p.proposalHash));
    apply(w, first);
    expect(refusal(commit(input(w), p.proposalHash))).toEqual(STALE);
  });
});

// ───────────────────────────── H / L / M. the client is never authority ─────────────────────────────

describe('H/L/M. client placements and status are never read', () => {
  it('H/1. extra request fields (placements, status) change nothing', () => {
    const w = successWorld();
    const p = proposeSchedule(input(w));
    const forged = {
      proposalHash: p.proposalHash,
      status: 'SUCCESS',
      placements: [{ contestId: 'm1', resourceId: 'c2', start: 1, expectedEnd: 2 }],
      facts: [{ contestId: 'm0', resourceId: 'c2', start: 1 }],
    } as unknown as ProposalCommitRequest;
    expect(planProposalCommit(input(w), forged)).toEqual(commit(input(w), p.proposalHash));
    const facts = plan(planProposalCommit(input(w), forged)).facts;
    expect(facts).toEqual(asFacts(p));
  });

  it('1. a hash computed over altered placements is stale', () => {
    const w = successWorld();
    const { proposalHash: _, diagnostics: __, ...body } = proposeSchedule(input(w));
    const moved = {
      ...body,
      placements: body.placements.map((x) => ({ ...x, start: x.start + 3600 })),
    };
    expect(refusal(commit(input(w), proposalHash(moved))).reason).toBe('PROPOSAL_STALE');
  });

  it('M/2. a hash computed over a status forged to SUCCESS is stale; the real one is refused', () => {
    for (const [w, budget] of [
      [infeasible(), undefined],
      [exhausted(), SMALL_BUDGET],
    ] as const) {
      const real =
        budget === undefined
          ? proposeSchedule(input(w))
          : proposeScheduleWithBudget(input(w), budget);
      const { proposalHash: _, diagnostics: __, ...body } = real;
      const forgedHash = proposalHash({ ...body, status: 'SUCCESS', unplaced: [] });
      const run = (h: string) =>
        budget === undefined
          ? commit(input(w), h)
          : planProposalCommitWithBudget(input(w), { proposalHash: h }, budget);
      expect(refusal(run(forgedHash)).reason).toBe('PROPOSAL_STALE');
      // L: the status decided is the recomputation's, for the genuine hash.
      expect(refusal(run(real.proposalHash))).toMatchObject({
        reason: 'PROPOSAL_NOT_COMMITTABLE',
        status: real.status,
      });
    }
  });
});

// ───────────────────────────── I. existing assignments ─────────────────────────────

describe('I/7. existing live assignments are never in the plan (ADR-0075 § 7)', () => {
  it('only contests without a live assignment are planned; preserved ones are untouched', () => {
    const w = successWorld();
    w.contest('locked', {}).assign('locked', { resource: 'c2', start: 0, end: 60 });
    planned(w, 'half-1', { round: 'rg', grouped: true, partitionKey: 'g' });
    planned(w, 'half-2', { round: 'rg', grouped: true, partitionKey: 'g' });
    w.assign('half-1', { resource: 'c1', start: 600, end: 660 }); // a partially placed unit
    const p = proposeSchedule(input(w));
    expect(p.status).toBe('SUCCESS');
    const facts = plan(commit(input(w), p.proposalHash)).facts;
    expect(facts.map((f) => f.contestId)).toEqual(['m1', 'm2']);
    const live = new Set(w.assignments.map((a) => a.contestId));
    for (const f of facts) expect(live.has(f.contestId)).toBe(false);
    expect(p.unplaced).toEqual([expect.objectContaining({ reason: 'PARTIALLY_PLACED' })]);
  });

  it('a contest whose draft assignment was removed (no live fact) may be planned', () => {
    const w = successWorld();
    w.assignments.splice(0, w.assignments.length); // m0's assignment removed in the draft
    const p = proposeSchedule(input(w));
    // m0 is SCHEDULED in the fixture (published-scheduled): not E's to place, so not in the plan.
    const facts = plan(commit(input(w), p.proposalHash)).facts;
    expect(facts.map((f) => f.contestId)).toEqual(['m1', 'm2']);
  });
});

// ───────────────────────────── J. scope ─────────────────────────────

describe('J. a narrower scope is a new proposal with its own plan (ADR-0076 C3)', () => {
  function twoEvents() {
    const w = world().resource('c1').resource('c2');
    w.event('e2', { profile: spec({}), windowStartMs: T0, windowEndMs: T0 + 3 * DAY });
    for (const e of ['a', 'b', 'c', 'd']) w.entrant(e);
    planned(w, 'm1', { entrants: ['a', 'b'] });
    planned(w, 'm2', { event: 'e2', round: 'r2', entrants: ['c', 'd'] });
    return w;
  }

  it('event scope plans only the scoped event; round scope only the scoped round', () => {
    const w = twoEvents();
    for (const [scope, contests] of [
      [{ eventIds: ['e2'] }, ['m2']],
      [{ roundIds: ['r1'] }, ['m1']],
      [{ eventIds: ['e1', 'e2'] }, ['m1', 'm2']],
    ] as const) {
      const i = input(w, { scope });
      const p = proposeSchedule(i);
      expect(p.status).toBe('SUCCESS');
      expect(plan(commit(i, p.proposalHash)).facts.map((f) => f.contestId)).toEqual(contests);
    }
  });

  it('an INFEASIBLE full proposal; the narrower SUCCESS proposal commits', () => {
    const w = infeasible();
    const full = proposeSchedule(input(w));
    expect(full.status).toBe('INFEASIBLE');
    w.contests.splice(1, 1, { ...must(w.contests[1]), roundId: 'r9' });
    const all = proposeSchedule(input(w));
    expect(all.status).toBe('INFEASIBLE');
    const i = input(w, { scope: { roundIds: ['r1'] } });
    const narrow = proposeSchedule(i);
    expect(narrow.status).toBe('SUCCESS');
    expect(narrow.proposalHash).not.toBe(all.proposalHash);
    expect(plan(commit(i, narrow.proposalHash)).facts.map((f) => f.contestId)).toEqual(['m1']);
    expect(refusal(commit(input(w), all.proposalHash)).reason).toBe('PROPOSAL_NOT_COMMITTABLE');
  });
});

// ───────────────────────────── N / O. state refusals ─────────────────────────────

describe('N/O. a version that is not the open draft, or a closed competition, is refused', () => {
  it('N/8. NOT_A_DRAFT for a published, superseded or discarded version', () => {
    const w = successWorld();
    const p = proposeSchedule(input(w));
    for (const status of ['PUBLISHED', 'SUPERSEDED', 'DISCARDED'])
      expect(refusal(commit(input(w, { draftStatus: status }), p.proposalHash))).toEqual({
        reason: 'NOT_A_DRAFT',
        code: 'INVALID_TRANSITION',
        status,
      });
  });

  it('O/9. COMPETITION_CLOSED for a COMPLETED or CANCELLED competition', () => {
    const w = successWorld();
    const p = proposeSchedule(input(w));
    for (const status of ['COMPLETED', 'CANCELLED'])
      expect(refusal(commit(input(w, { competitionStatus: status }), p.proposalHash))).toEqual({
        reason: 'COMPETITION_CLOSED',
        code: 'INVALID_TRANSITION',
        status,
      });
  });

  it('engine refusals on the current state are INVALID_INPUT, never a plan', () => {
    const w = successWorld();
    const p = proposeSchedule(input(w));
    expect(
      refusal(commit(input(w, { scope: { eventIds: ['foreign'] } }), p.proposalHash)),
    ).toMatchObject({ reason: 'INVALID_INPUT', code: 'INVALID_INPUT' });
    expect(refusal(commit(input(w, { fromMs: T0 + 1 }), p.proposalHash))).toMatchObject({
      reason: 'INVALID_INPUT',
    });
  });
});

// ───────────────────────────── P–T. cross-sport, grouped and resource modes ─────────────────────────────

describe('P. cross-sport: every canonical profile template commits through the same rule', () => {
  const cases = SCHEDULING_PROFILE_TEMPLATES.map((t) => {
    const type = must(t.spec.requirements[0]).resourceType as ResourceType;
    return { code: t.code, spec: t.spec, type, mode: RESOURCE_TYPE_DEFAULT_OCCUPANCY_MODE[type] };
  });

  it('covers every canonical template and both occupancy modes', () => {
    expect(cases).toHaveLength(SCHEDULING_PROFILE_TEMPLATES.length);
    expect(cases.length).toBeGreaterThanOrEqual(8);
    expect(new Set(cases.map((c) => c.mode))).toEqual(new Set(['EXCLUSIVE', 'SHARED']));
  });

  it.each(cases)('$code ($mode): SUCCESS commits exactly its placements', (c) => {
    const w = world(c.spec, { windowEndMs: T0 + 7 * DAY });
    for (const r of ['r-1', 'r-2'])
      w.resource(r, { type: c.type, mode: c.mode, capacity: c.mode === 'SHARED' ? 1000 : 4 });
    for (const e of ['a', 'b', 'c', 'd']) w.entrant(e);
    planned(w, 'u1', { type: 'SERIES', entrants: ['a', 'b'] });
    planned(w, 'u2', { type: 'SERIES', entrants: ['c', 'd'] });
    const p = proposeSchedule(input(w));
    expect(p.status, JSON.stringify(p.unplaced)).toBe('SUCCESS');
    const r = plan(commit(input(w), p.proposalHash));
    expect(r.facts).toEqual(asFacts(p));
    expect(r.facts.map((f) => f.contestId)).toEqual(['u1', 'u2']);
    // And the same template refuses a failure identically.
    const bad = world(c.spec, { windowEndMs: T0 + 60_000 });
    bad.resource('r-1', { type: c.type, mode: c.mode, capacity: 1000 });
    bad.entrant('a').entrant('b');
    planned(bad, 'u1', { type: 'SERIES', entrants: ['a', 'b'] });
    const q = proposeSchedule(input(bad));
    expect(q.status).not.toBe('SUCCESS');
    expect(refusal(commit(input(bad), q.proposalHash)).reason).toBe('PROPOSAL_NOT_COMMITTABLE');
  });
});

describe('Q–T. grouped units, golf tee groups, bowling squads, SHARED and EXCLUSIVE resources', () => {
  const squad = (w: World, n: number, key: string) => {
    for (let i = 1; i <= n; i++) {
      w.entrant(`${key}-${i}`);
      planned(w, `s-${key}-${i}`, {
        grouped: true,
        partitionKey: key,
        type: 'SERIES',
        entrants: [`${key}-${i}`],
      });
    }
  };

  it('Q/S/T. a bowling squad keeps one start, packed over EXCLUSIVE lane pairs with changeover', () => {
    const bowling = spec({
      resourceType: 'BOWLING_LANE_PAIR',
      capacityUnit: 'ENTRANT',
      changeoverSeconds: 900,
    });
    const w = world(bowling);
    for (const id of ['p1', 'p2']) w.resource(id, { type: 'BOWLING_LANE_PAIR', capacity: 4 });
    squad(w, 8, 't1');
    const p = proposeSchedule(input(w));
    expect(p.status).toBe('SUCCESS');
    const facts = plan(commit(input(w), p.proposalHash)).facts;
    expect(facts).toHaveLength(8);
    expect(new Set(facts.map((f) => f.unitKey))).toEqual(new Set(['partition:r1:t1']));
    expect(new Set(facts.map((f) => f.start))).toEqual(new Set([S(T0)]));
    expect(new Set(facts.map((f) => f.changeoverSeconds))).toEqual(new Set([900]));
    const perPair = new Map<string, number>();
    for (const f of facts) perPair.set(f.resourceId, (perPair.get(f.resourceId) ?? 0) + 1);
    expect(Object.fromEntries(perPair)).toEqual({ p1: 4, p2: 4 });
  });

  it('R/T. golf tee groups share one SHARED course, each group with one start', () => {
    const golf = spec({
      resourceType: 'GOLF_COURSE',
      capacityUnit: 'ENTRANT',
      startSpacingSeconds: 600,
      concurrentStarts: 1,
      expectedDurationSeconds: 4 * 3_600,
    });
    const w = world(golf).resource('g1', { type: 'GOLF_COURSE', mode: 'SHARED', capacity: 100 });
    squad(w, 3, 'g1');
    squad(w, 3, 'g2');
    const p = proposeSchedule(input(w));
    expect(p.status).toBe('SUCCESS');
    const facts = plan(commit(input(w), p.proposalHash)).facts;
    expect(facts).toHaveLength(6);
    expect(new Set(facts.map((f) => f.resourceId))).toEqual(new Set(['g1']));
    const starts = new Map<string, Set<number>>();
    for (const f of facts) starts.set(f.unitKey, (starts.get(f.unitKey) ?? new Set()).add(f.start));
    expect([...starts.values()].map((s) => s.size)).toEqual([1, 1]);
    const [a, b] = [...starts.values()].map((s) => [...s][0] as number).sort((x, y) => x - y);
    expect(must(b) - must(a)).toBe(600);
  });
});

// ───────────────────────────── V–Z. purity, determinism, hand-off ─────────────────────────────

describe('V–Z. pure, deterministic, safe to hand to the persistence transaction', () => {
  it('X. same inputs give byte-identical plans', () => {
    const a = commit(input(successWorld()), proposeSchedule(input(successWorld())).proposalHash);
    const b = commit(input(successWorld()), proposeSchedule(input(successWorld())).proposalHash);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('Y. reads no clock and no randomness', () => {
    const w = successWorld();
    const p = proposeSchedule(input(w));
    const now = vi.spyOn(Date, 'now');
    const random = vi.spyOn(Math, 'random');
    try {
      plan(commit(input(w), p.proposalHash));
      expect(now).not.toHaveBeenCalled();
      expect(random).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
      random.mockRestore();
    }
  });

  it('Z. the plan is plain data: it survives a JSON round trip unchanged', () => {
    const w = successWorld();
    const r = plan(commit(input(w), proposeSchedule(input(w)).proposalHash));
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });

  it('the input is not mutated', () => {
    const w = successWorld();
    const i = input(w);
    const before = JSON.stringify(i);
    commit(i, proposeSchedule(i).proposalHash);
    expect(JSON.stringify(i)).toBe(before);
  });

  it('V/W/23. commit.ts: no sport, no I/O, no persistence, no clock, no read model', () => {
    const src = readFileSync(fileURLToPath(new URL('./commit.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(
      /tennis|padel|golf|swim|bowling|basketball|wheelchair|cycling|marathon|running|sport\s*===|switch\s*\(\s*sport|discipline\s*===|typeCode\s*===/i,
    );
    expect(src).not.toMatch(
      /@br\/persistence|kysely|\bsql`|node:|fetch\(|Date\.now|new Date\(|Math\.random|randomUUID|newId\(/,
    );
    expect(src).not.toMatch(/contest_schedule|refreshEventReadModels|emitEvent|recordAudit/);
    // The eligibility rule reads the recomputed status only.
    expect(src).toMatch(/proposeScheduleWithBudget\(input, budget\)/);
    expect(src).not.toMatch(/request\.status|request\.placements/);
  });
});
