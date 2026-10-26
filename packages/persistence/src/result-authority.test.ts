import { describe, expect, it } from 'vitest';
import {
  bindingFrom,
  bindingHolds,
  type EligibilitySnapshot,
  type EligibilityVersion,
} from './result-authority';

/**
 * WP-P0-3 Q3 (ADR-0079 §2.3): a grant is bound to the eligibility rows it was issued on, each with
 * its status-change count; it holds while the account and at least one bound basis (a membership
 * also with the organization) have no change since. No timestamp is involved.
 */
const v = (id: string, changes = 1, active = true): EligibilityVersion => ({ id, changes, active });
const snap = (h: Partial<EligibilitySnapshot>): EligibilitySnapshot => ({
  account: v('acct'),
  organization: v('org'),
  staff: [],
  memberships: [],
  ...h,
});
/** The binding issued on `at`, judged against `now`. */
const holds = (at: Partial<EligibilitySnapshot>, now: Partial<EligibilitySnapshot>) => {
  const b = bindingFrom(snap(at));
  if (b === undefined) throw new Error('not eligible at issuance');
  return bindingHolds(b, snap(now));
};

describe('bindingFrom (ADR-0079 §2.3)', () => {
  it('binds every ACTIVE basis with its change count, and the account and organization counts', () => {
    expect(
      bindingFrom(
        snap({
          account: v('acct', 1),
          organization: v('org', 3),
          staff: [v('s1', 1), v('s2', 2, false)],
          memberships: [v('m1', 2)],
        }),
      ),
    ).toEqual({
      accountChanges: 1,
      organizationChanges: 3,
      bases: [
        { kind: 'STAFF', id: 's1', changes: 1 },
        { kind: 'MEMBERSHIP', id: 'm1', changes: 2 },
      ],
    });
  });

  it('not eligible: no basis, only ended bases, a disabled account, memberships of a suspended organization', () => {
    expect(bindingFrom(snap({}))).toBeUndefined();
    expect(bindingFrom(snap({ staff: [v('s1', 2, false)] }))).toBeUndefined();
    expect(bindingFrom(snap({ account: v('acct', 2, false), staff: [v('s1')] }))).toBeUndefined();
    expect(
      bindingFrom(snap({ organization: v('org', 2, false), memberships: [v('m1')] })),
    ).toBeUndefined();
    // An explicit staff row does not depend on the organization's status.
    expect(bindingFrom(snap({ organization: v('org', 2, false), staff: [v('s1')] }))).toBeDefined();
  });
});

describe('bindingHolds (ADR-0079 §2.3)', () => {
  it('holds while nothing it rests on has changed, whatever else happens', () => {
    expect(holds({ staff: [v('s1')] }, { staff: [v('s1')] })).toBe(true);
    // Unrelated bases appear and change: irrelevant.
    expect(
      holds(
        { staff: [v('s1')] },
        { staff: [v('s1'), v('s9', 2, false)], memberships: [v('m1', 3)] },
      ),
    ).toBe(true);
    // A staff basis does not depend on the organization history.
    expect(holds({ staff: [v('s1')] }, { staff: [v('s1')], organization: v('org', 3) })).toBe(true);
  });

  it('two bound bases: losing one keeps the grant while the other is unchanged', () => {
    const at = { staff: [v('s1')], memberships: [v('m1')] };
    expect(holds(at, { staff: [v('s1', 2, false)], memberships: [v('m1')] })).toBe(true);
    expect(holds(at, { staff: [v('s1')], memberships: [v('m1', 2, false)] })).toBe(true);
    expect(holds(at, { staff: [v('s1', 2, false)], memberships: [v('m1', 2, false)] })).toBe(false);
  });

  it('demotion then re-promotion never restores it: a reactivated row has more changes, a new row is unbound', () => {
    const at = { staff: [v('s1')] };
    // Same row ended, then (were it reactivated) active again with more changes.
    expect(holds(at, { staff: [v('s1', 3)] })).toBe(false);
    // Ended, and a new ADMIN row assigned.
    expect(holds(at, { staff: [v('s1', 2, false), v('s2')] })).toBe(false);
  });

  it('a membership replaced by a role change (ADMIN → OWNER) needs a fresh grant (fail closed)', () => {
    expect(holds({ memberships: [v('m1')] }, { memberships: [v('m1', 2, false), v('m2')] })).toBe(
      false,
    );
  });

  it('a cross-basis handoff keeps no grant whose own bases were all lost', () => {
    expect(
      holds({ staff: [v('s1')] }, { staff: [v('s1', 2, false)], memberships: [v('m1')] }),
    ).toBe(false);
  });

  it('suspension and reactivation of a membership or of the organization refuse a membership-bound grant', () => {
    const at = { memberships: [v('m1')] };
    expect(holds(at, { memberships: [v('m1', 3)] })).toBe(false);
    expect(holds(at, { memberships: [v('m1')], organization: v('org', 3) })).toBe(false);
    expect(holds(at, { memberships: [v('m1')], organization: v('org', 2, false) })).toBe(false);
  });

  it('any account status change refuses, whatever the bases', () => {
    const at = { staff: [v('s1')] };
    expect(holds(at, { staff: [v('s1')], account: v('acct', 2, false) })).toBe(false);
    expect(holds(at, { staff: [v('s1')], account: v('acct', 3) })).toBe(false);
  });
});
