import { describe, expect, it } from 'vitest';
import { continuousEligibilitySince, type EligibilityChange } from './result-authority';

/**
 * WP-P0-3 Q3 (ADR-0079 §2.3): the continuity start computed from the append-only histories. Rows
 * are given in `seq` (commit) order; `at` is the transaction START (`recorded_at`), which can run
 * backwards across a lock wait.
 */
const at = (ms: number) => new Date(Date.UTC(2027, 0, 1) + ms);
const ch = (id: string, status: string, ms: number): EligibilityChange => ({
  id,
  status,
  at: at(ms),
});
const active = (id: string, ms = 0) => [ch(id, 'ACTIVE', ms)];
const since = (h: Partial<Parameters<typeof continuousEligibilitySince>[0]>) =>
  continuousEligibilitySince({
    account: active('acct'),
    organization: active('org'),
    staff: [],
    memberships: [],
    ...h,
  })?.getTime();
const T = (ms: number) => at(ms).getTime();

describe('continuousEligibilitySince (ADR-0079 §2.3)', () => {
  it('one explicit staff row: its activation', () => {
    expect(since({ staff: [ch('s1', 'ACTIVE', 100)] })).toBe(T(100));
  });

  it('not eligible: no basis, an ended basis, a disabled account, a suspended organization', () => {
    expect(since({})).toBeUndefined();
    expect(since({ staff: [ch('s1', 'ACTIVE', 100), ch('s1', 'ENDED', 200)] })).toBeUndefined();
    expect(
      since({
        staff: active('s1', 100),
        account: [ch('acct', 'ACTIVE', 0), ch('acct', 'DISABLED', 50)],
      }),
    ).toBeUndefined();
    expect(
      since({
        memberships: active('m1', 100),
        organization: [ch('org', 'ACTIVE', 0), ch('org', 'SUSPENDED', 50)],
      }),
    ).toBeUndefined();
  });

  it('demotion then re-assignment: a new row, so eligibility restarts', () => {
    expect(
      since({ staff: [ch('s1', 'ACTIVE', 100), ch('s1', 'ENDED', 200), ch('s2', 'ACTIVE', 300)] }),
    ).toBe(T(300));
  });

  it('a membership role change ends one row and starts the next at the same instant: continuous', () => {
    expect(
      since({
        memberships: [ch('m1', 'ACTIVE', 100), ch('m1', 'ENDED', 200), ch('m2', 'ACTIVE', 200)],
      }),
    ).toBe(T(100));
  });

  it('a handoff between bases that overlap is continuous', () => {
    expect(
      since({
        staff: [ch('s1', 'ACTIVE', 100), ch('s1', 'ENDED', 300)],
        memberships: active('m1', 200),
      }),
    ).toBe(T(100));
  });

  it('a membership suspended then reactivated restarts at the reactivation', () => {
    expect(
      since({
        memberships: [ch('m1', 'ACTIVE', 100), ch('m1', 'SUSPENDED', 200), ch('m1', 'ACTIVE', 300)],
      }),
    ).toBe(T(300));
  });

  it('an organization suspended then reactivated clips its memberships, not explicit staff', () => {
    const organization = [
      ch('org', 'ACTIVE', 0),
      ch('org', 'SUSPENDED', 200),
      ch('org', 'ACTIVE', 300),
    ];
    expect(since({ organization, memberships: active('m1', 100) })).toBe(T(300));
    expect(since({ organization, staff: active('s1', 100) })).toBe(T(100));
  });

  it('commit order wins over transaction-start stamps: a reactivation that waited is not continuous', () => {
    // The suspension (stamped 200) committed before the reactivation that started earlier (150).
    expect(
      since({
        memberships: [ch('m1', 'ACTIVE', 100), ch('m1', 'SUSPENDED', 200), ch('m1', 'ACTIVE', 150)],
      }),
    ).toBe(T(201));
    const organization = [
      ch('org', 'ACTIVE', 0),
      ch('org', 'SUSPENDED', 200),
      ch('org', 'ACTIVE', 150),
    ];
    expect(since({ organization, memberships: active('m1', 100) })).toBe(T(201));
    const account = [
      ch('acct', 'ACTIVE', 0),
      ch('acct', 'DISABLED', 200),
      ch('acct', 'ACTIVE', 150),
    ];
    expect(since({ account, staff: active('s1', 100) })).toBe(T(201));
  });

  it('a closing change stamped before its opening (lock wait) drops the period, never extends it', () => {
    expect(
      since({
        staff: [ch('s1', 'ACTIVE', 300), ch('s1', 'ENDED', 250), ch('s2', 'ACTIVE', 400)],
      }),
    ).toBe(T(400));
  });

  it('INVITED and DECLINED never open a span; ACTIVE after INVITED does', () => {
    expect(
      since({ memberships: [ch('m1', 'INVITED', 100), ch('m1', 'DECLINED', 200)] }),
    ).toBeUndefined();
    expect(since({ memberships: [ch('m1', 'INVITED', 100), ch('m1', 'ACTIVE', 200)] })).toBe(
      T(200),
    );
  });
});
