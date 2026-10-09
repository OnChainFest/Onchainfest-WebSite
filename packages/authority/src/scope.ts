import { SCOPE_DIMENSIONS, type AuthorityScope, type ScopeDimension } from '@br/domain';

/**
 * Scope algebra (normative for BRT-03; see docs/implementation/BRT-03-FOUNDATION.md §Scope algebra).
 *
 * A scope maps dimensions to non-empty sets of values. An ABSENT dimension is unconstrained
 * (it matches everything); an empty set is not representable (schemas require minItems 1).
 *
 *   covers(d, a, b): does allowed value `a` cover requested value `b` in dimension d?
 *     discipline : "x.*" covers "x", "x.*" and every "x.…"; an exact id covers only itself
 *     region     : "CR" covers "CR" and every subdivision "CR-…"; a subdivision covers itself
 *     other dims : equality (sport, recognitionLevel, competition, event, round, contest)
 *
 *   contains(A, B) ⇔ for every dimension d constrained in A:
 *                      d is constrained in B  ∧  ∀ b ∈ B[d] ∃ a ∈ A[d] : covers(d, a, b)
 *
 * contains is reflexive and transitive (property-tested). A delegated grant's scope must be
 * contained in its parent's scope (anti-widening), and a request is authorized only if the
 * grant scope contains the request scope.
 *
 * Hierarchy is NOT inferred: a scope constraining `event` does not implicitly constrain
 * `competition`. Grants must state every ancestor dimension they rely on; requests are resolved
 * to their full path by the caller (the hierarchy resolver arrives with the Competition module).
 */
export function coversValue(
  dimension: ScopeDimension,
  allowed: string,
  requested: string,
): boolean {
  switch (dimension) {
    case 'discipline':
      if (allowed.endsWith('.*')) {
        const ns = allowed.slice(0, -2);
        return requested === ns || requested === allowed || requested.startsWith(`${ns}.`);
      }
      return requested === allowed;
    case 'region':
      return requested === allowed || (allowed.length === 2 && requested.startsWith(`${allowed}-`));
    default:
      return requested === allowed;
  }
}

export function scopeContains(outer: AuthorityScope, inner: AuthorityScope): boolean {
  for (const dimension of SCOPE_DIMENSIONS) {
    const allowed = outer[dimension] as readonly string[] | undefined;
    if (allowed === undefined) continue;
    const requested = inner[dimension] as readonly string[] | undefined;
    if (requested === undefined) return false;
    for (const value of requested) {
      if (!allowed.some((a) => coversValue(dimension, a, value))) return false;
    }
  }
  return true;
}

/** Dimensions on which `inner` escapes `outer` (diagnostics for SCOPE_WIDENED). */
export function wideningDimensions(outer: AuthorityScope, inner: AuthorityScope): ScopeDimension[] {
  return SCOPE_DIMENSIONS.filter((d) => !scopeContains(pick(outer, d), pick(inner, d)));
}

function pick(scope: AuthorityScope, dimension: ScopeDimension): AuthorityScope {
  const value = scope[dimension];
  return value === undefined ? {} : ({ [dimension]: value } as AuthorityScope);
}
