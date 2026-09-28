import { newId, SIGNER_CLOCK_SKEW_MS, type AuthorityScope } from '@br/domain';
import { anchor, at, facts, grant, principal } from '@br/testkit';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { staticParticipationChecker } from './conflict';
import type { AuthorityFacts } from './facts';
import { validateGrantIssuance as validate, type GrantDraft } from './issuance';

const CLEAR = staticParticipationChecker([], 'test-declared-no-participation');
const validateGrantIssuance = (f: AuthorityFacts, d: GrantDraft, recordedAt: Date) =>
  validate(f, d, recordedAt, CLEAR);
import { scopeContains } from './scope';

const competition = newId();
const base: AuthorityScope = {
  sport: ['padel'],
  recognitionLevel: ['PLATFORM'],
  competition: [competition],
};

function world() {
  const platform = principal('PLATFORM');
  const org = principal('ORGANIZATION');
  const ref = principal('PERSON');
  const a = anchor(platform.id, { recognitionLevel: ['PLATFORM'] });
  const orgGrant = grant({
    grantor: platform.id,
    grantee: org.id,
    capabilities: ['GRANT_AUTHORITY', 'ACCEPT_RESULT'],
    scope: base,
    delegable: ['ACCEPT_RESULT'],
    maxDepth: 2,
    to: at(1000),
  });
  return {
    platform,
    org,
    ref,
    orgGrant,
    f: facts({ principals: [platform, org, ref], anchors: [a], grants: [orgGrant] }),
  };
}

const draftFor = (
  w: ReturnType<typeof world>,
  overrides: Partial<GrantDraft> = {},
): GrantDraft => ({
  grantorPrincipalId: w.org.id,
  granteePrincipalId: w.ref.id,
  parentGrantId: w.orgGrant.id,
  capabilities: ['ACCEPT_RESULT'],
  scope: { ...base, contest: [newId()] },
  delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
  constraints: { mustNotBeParticipant: true },
  effectiveFrom: at(10),
  effectiveTo: at(100),
  ...overrides,
});

describe('grant issuance validation', () => {
  it('accepts a properly narrowed delegated grant', () => {
    const w = world();
    expect(validateGrantIssuance(w.f, draftFor(w), at(10))).toEqual({ ok: true, reason: 'OK' });
  });

  it('no backdating is strict at the exact recording-time boundary (no clock-skew tolerance)', () => {
    const w = world();
    const recordedAt = at(10);
    const issue = (offsetMs: number) =>
      validateGrantIssuance(
        w.f,
        draftFor(w, { effectiveFrom: new Date(recordedAt.getTime() + offsetMs) }),
        recordedAt,
      );
    expect(issue(0)).toEqual({ ok: true, reason: 'OK' }); // effectiveFrom = recordedAt → accept
    expect(issue(1).ok).toBe(true); // future-scheduled → accept
    expect(issue(-1).reason).toBe('BACKDATED'); // one millisecond in the past → reject
    expect(issue(-SIGNER_CLOCK_SKEW_MS).reason).toBe('BACKDATED'); // signer skew never applies here
  });

  it('rejects widening of scope, validity, depth and capabilities', () => {
    const w = world();
    expect(
      validateGrantIssuance(
        w.f,
        draftFor(w, { scope: { sport: ['padel'], recognitionLevel: ['PLATFORM'] } }),
        at(10),
      ).reason,
    ).toBe('SCOPE_WIDENED');
    expect(validateGrantIssuance(w.f, draftFor(w, { effectiveTo: at(2000) }), at(10)).reason).toBe(
      'VALIDITY_WIDENED',
    );
    const deep = draftFor(w, {
      capabilities: ['GRANT_AUTHORITY', 'ACCEPT_RESULT'],
      delegation: { allowed: true, maxDepth: 2, capabilitiesDelegable: ['ACCEPT_RESULT'] },
    });
    expect(validateGrantIssuance(w.f, deep, at(10)).reason).toBe('DEPTH_WIDENED');
    const r = validateGrantIssuance(
      w.f,
      draftFor(w, { capabilities: ['DECLARE_OFFICIAL'] }),
      at(10),
    );
    expect(r.reason).toBe('GRANTOR_NOT_AUTHORIZED');
    expect(r.chainFailure?.reason).toBe('CAPABILITY_NOT_DELEGABLE');
  });

  it('rejects self-grants, inconsistent delegation and foreign parents', () => {
    const w = world();
    expect(
      validateGrantIssuance(w.f, draftFor(w, { granteePrincipalId: w.org.id }), at(10)).reason,
    ).toBe('SELF_GRANT');
    expect(
      validateGrantIssuance(
        w.f,
        draftFor(w, { delegation: { allowed: true, maxDepth: 1, capabilitiesDelegable: [] } }),
        at(10),
      ).reason,
    ).toBe('INCONSISTENT_DELEGATION');
    expect(
      validateGrantIssuance(
        w.f,
        draftFor(w, { grantorPrincipalId: w.ref.id, granteePrincipalId: w.org.id }),
        at(10),
      ).reason,
    ).toBe('PARENT_NOT_HELD_BY_GRANTOR');
  });

  it('a root grant requires the grantor to be an anchor covering the scope', () => {
    const w = world();
    const root = draftFor(w, { grantorPrincipalId: w.org.id, granteePrincipalId: w.ref.id });
    const { parentGrantId: _omit, ...withoutParent } = root;
    const r = validateGrantIssuance(w.f, withoutParent, at(10));
    expect(r.reason).toBe('GRANTOR_NOT_AUTHORIZED');
    expect(r.chainFailure?.reason).toBe('ANCHOR_MISSING');
  });

  it('property: issuance accepts exactly the child scopes contained in the parent scope', () => {
    const w = world();
    const regions = ['CR', 'CR-SJ', 'MX'];
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...regions), { minLength: 1 }),
        fc.boolean(),
        (region, dropCompetition) => {
          const scope: AuthorityScope = dropCompetition
            ? { sport: ['padel'], recognitionLevel: ['PLATFORM'], region }
            : { ...base, region };
          const r = validateGrantIssuance(w.f, draftFor(w, { scope }), at(10));
          expect(r.ok).toBe(scopeContains(w.orgGrant.scope, scope));
        },
      ),
    );
  });

  it('grant issuance is conflict-sensitive and fails closed', () => {
    const w = world();
    // no checker supplied → participation index unavailable → rejected
    expect(validate(w.f, draftFor(w), at(10)).reason).toBe('CONFLICT_CHECK_UNAVAILABLE');
    // the grantor participates in the scope it is granting → rejected
    const draft = draftFor(w);
    const conflicted = staticParticipationChecker([
      { principalId: w.org.id, scope: { competition: [competition] } },
    ]);
    expect(validate(w.f, draft, at(10), conflicted).reason).toBe('GRANTOR_CONFLICTED');
    // declared independent → accepted
    expect(validate(w.f, draft, at(10), CLEAR).ok).toBe(true);
  });
});
