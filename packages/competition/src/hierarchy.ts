import type { AuthorityScope, RecognitionLevel } from '@br/domain';

/**
 * Competition hierarchy as the Authority Engine needs it (BRT-01 verification model §4.4).
 *
 * The engine's scope algebra deliberately does NOT infer ancestry: a grant constraining
 * `competition` covers a request only if the request itself carries that competition. The
 * resolver therefore turns a target (competition / event / round / contest) into its FULL path
 * from database relationships — never from id or slug prefixes — and callers pass that path as
 * the request scope. A grant scoped to competition C1 then covers every event, round and contest
 * whose resolved path contains C1, and nothing in a sibling competition.
 *
 * Recognition level is not a structural fact of the hierarchy (it depends on sanctioning and
 * policy), so the resolver never invents it; callers that need it supply it explicitly.
 */
export type HierarchyLevel = 'COMPETITION' | 'EVENT' | 'ROUND' | 'CONTEST';

export interface HierarchyPath {
  readonly level: HierarchyLevel;
  readonly competitionId: string;
  /** ISO 3166 region of the competition, when declared. */
  readonly region?: string;
  /** Present from EVENT level down (a competition may span several sports). */
  readonly sport?: string;
  readonly discipline?: string;
  readonly eventId?: string;
  readonly roundId?: string;
  readonly contestId?: string;
}

/** Request scope (singleton sets) for a resolved path. */
export function pathToScope(
  path: HierarchyPath,
  extra: { recognitionLevel?: RecognitionLevel } = {},
): AuthorityScope {
  const one = (v: string | undefined) => (v === undefined ? undefined : [v]);
  const scope: Record<string, readonly string[] | undefined> = {
    sport: one(path.sport),
    discipline: one(path.discipline),
    region: one(path.region),
    recognitionLevel: one(extra.recognitionLevel),
    competition: one(path.competitionId),
    event: one(path.eventId),
    round: one(path.roundId),
    contest: one(path.contestId),
  };
  return Object.fromEntries(
    Object.entries(scope).filter(([, v]) => v !== undefined),
  ) as AuthorityScope;
}

/** The hierarchy dimensions a caller-supplied scope must match exactly for a target. */
export const HIERARCHY_DIMENSIONS = [
  'sport',
  'discipline',
  'region',
  'competition',
  'event',
  'round',
  'contest',
] as const;

/**
 * True when `supplied` states exactly the resolved hierarchy of the target (each hierarchy
 * dimension equal as a singleton, or absent in both). Extra non-hierarchy dimensions such as
 * `recognitionLevel` are allowed. Used to stop callers from claiming a different ancestry.
 */
export function scopeMatchesPath(supplied: AuthorityScope, path: HierarchyPath): boolean {
  const expected = pathToScope(path);
  return HIERARCHY_DIMENSIONS.every((d) => {
    const a = supplied[d] as readonly string[] | undefined;
    const b = expected[d] as readonly string[] | undefined;
    if (a === undefined || b === undefined) return a === b;
    return a.length === 1 && b.length === 1 && a[0] === b[0];
  });
}
