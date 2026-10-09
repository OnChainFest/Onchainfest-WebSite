import { parseUuid, type AuthorityScope } from '@br/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { anchor, at, facts, grant, principal } from '@br/testkit';
import { authorize } from './engine';
import { coversValue, scopeContains } from './scope';

const C1 = parseUuid('0190f4c2-3b7a-7c21-9d4e-5f6a7b8c9d01');
const C2 = parseUuid('0190f4c2-3b7a-7c21-9d4e-5f6a7b8c9d02');

const values = {
  sport: ['padel', 'bowling', 'tennis'],
  discipline: [
    'athletics.*',
    'athletics.100m',
    'athletics.sprint.*',
    'athletics.sprint.60m',
    'padel.doubles',
    'padel.*',
  ],
  region: ['CR', 'CR-SJ', 'CR-A', 'MX', 'MX-CMX'],
  recognitionLevel: ['CLUB', 'NATIONAL', 'PLATFORM'],
  competition: [C1, C2],
  event: [C1, C2],
  round: [C1, C2],
  contest: [C1, C2],
} as const;

const scopeArb: fc.Arbitrary<AuthorityScope> = fc.record(
  Object.fromEntries(
    Object.entries(values).map(([k, vs]) => [
      k,
      fc.uniqueArray(fc.constantFrom(...vs), { minLength: 1, maxLength: 3 }),
    ]),
  ),
  { requiredKeys: [] },
) as fc.Arbitrary<AuthorityScope>;

describe('scope algebra', () => {
  it('value coverage rules', () => {
    expect(coversValue('discipline', 'athletics.*', 'athletics.100m')).toBe(true);
    expect(coversValue('discipline', 'athletics.*', 'athletics')).toBe(true);
    expect(coversValue('discipline', 'athletics.*', 'athletics.sprint.*')).toBe(true);
    expect(coversValue('discipline', 'athletics.100m', 'athletics.*')).toBe(false);
    expect(coversValue('discipline', 'athletics.*', 'athleticsx.100m')).toBe(false);
    expect(coversValue('region', 'CR', 'CR-SJ')).toBe(true);
    expect(coversValue('region', 'CR-SJ', 'CR')).toBe(false);
    expect(coversValue('region', 'C', 'CR')).toBe(false);
    expect(coversValue('sport', 'padel', 'padel')).toBe(true);
  });

  it('absent dimensions are unconstrained; constrained dimensions must be present in the inner scope', () => {
    expect(scopeContains({}, { sport: ['padel'] })).toBe(true);
    expect(scopeContains({ sport: ['padel'] }, {})).toBe(false);
    expect(scopeContains({ sport: ['padel', 'tennis'] }, { sport: ['padel'] })).toBe(true);
    expect(scopeContains({ sport: ['padel'] }, { sport: ['padel', 'tennis'] })).toBe(false);
    // hierarchy is not inferred: event without competition does not satisfy a competition constraint
    expect(scopeContains({ competition: [C1] }, { event: [C2] })).toBe(false);
  });

  it('reflexivity: every scope contains itself', () => {
    fc.assert(fc.property(scopeArb, (a) => scopeContains(a, a)));
  });

  it('transitivity: A ⊇ B ∧ B ⊇ C ⇒ A ⊇ C', () => {
    // Build B by narrowing A and C by narrowing B (with refinements such as CR → CR-SJ and
    // athletics.* → athletics.100m), then assert containment composes; also check the
    // implication on unconstrained random triples.
    const refinements: Record<string, string[]> = {
      'athletics.*': ['athletics.100m', 'athletics.sprint.*', 'athletics.sprint.60m'],
      'athletics.sprint.*': ['athletics.sprint.60m'],
      'padel.*': ['padel.doubles'],
      CR: ['CR-SJ', 'CR-A'],
      MX: ['MX-CMX'],
    };
    const narrow = (
      scope: AuthorityScope,
      extra: AuthorityScope,
      pickSeed: number,
    ): AuthorityScope => {
      const out: Record<string, readonly string[]> = {
        ...(extra as Record<string, readonly string[]>),
      };
      for (const [k, vs] of Object.entries(scope as Record<string, readonly string[]>)) {
        const chosen = vs[pickSeed % vs.length] as string;
        const refined = refinements[chosen];
        out[k] = [refined === undefined ? chosen : (refined[pickSeed % refined.length] as string)];
      }
      return out as AuthorityScope;
    };
    fc.assert(
      fc.property(scopeArb, scopeArb, scopeArb, fc.nat(), fc.nat(), (a, e1, e2, s1, s2) => {
        const b = narrow(a, e1, s1);
        const c = narrow(b, e2, s2);
        expect(scopeContains(a, b)).toBe(true);
        expect(scopeContains(b, c)).toBe(true);
        expect(scopeContains(a, c)).toBe(true);
      }),
      { numRuns: 1000 },
    );
    fc.assert(
      fc.property(
        scopeArb,
        scopeArb,
        scopeArb,
        (a, b, c) => !(scopeContains(a, b) && scopeContains(b, c)) || scopeContains(a, c),
      ),
      { numRuns: 3000 },
    );
  });

  it('narrowing never escapes: adding dimensions or removing values stays contained', () => {
    fc.assert(
      fc.property(scopeArb, scopeArb, (parent, extra) => {
        // child = parent with each constrained set reduced to its first value, plus extra dimensions
        const child: Record<string, readonly string[]> = {
          ...(extra as Record<string, readonly string[]>),
        };
        for (const [k, vs] of Object.entries(parent as Record<string, readonly string[]>))
          child[k] = vs.slice(0, 1);
        return scopeContains(parent, child as AuthorityScope);
      }),
    );
  });

  it('anti-widening: a stored child grant that escapes its parent never authorizes (chain re-walk)', () => {
    fc.assert(
      fc.property(scopeArb, scopeArb, (parentScope, childScope) => {
        fc.pre(!scopeContains(parentScope, childScope));
        const fed = principal('ORGANIZATION');
        const org = principal('ORGANIZATION');
        const ref = principal('PERSON');
        const parent = grant({
          grantor: fed.id,
          grantee: org.id,
          capabilities: ['GRANT_AUTHORITY', 'ACCEPT_RESULT'],
          scope: parentScope,
          delegable: ['ACCEPT_RESULT'],
        });
        const child = grant({
          grantor: org.id,
          grantee: ref.id,
          parent: parent.id,
          capabilities: ['ACCEPT_RESULT'],
          scope: childScope,
        });
        const d = authorize(
          facts({
            principals: [fed, org, ref],
            anchors: [anchor(fed.id, { recognitionLevel: ['CLUB', 'NATIONAL'] })],
            grants: [parent, child],
          }),
          {
            principalId: ref.id,
            capability: 'ACCEPT_RESULT',
            scope: childScope,
            atTime: at(1),
            asOf: at(1),
          },
        );
        expect(d.authorized).toBe(false);
        expect(d.reason).toBe('SCOPE_WIDENED');
      }),
    );
  });
});
