import type { AuthorityScope, Instant, Uuid } from '@br/domain';
import type { CheckerResult, ConflictOfInterestChecker } from './facts';
import { scopeContains } from './scope';

/** A declared participation: `principalId` participates in (at least) `scope` during [from, to). */
export interface ParticipationDeclaration {
  readonly principalId: Uuid;
  readonly scope: AuthorityScope;
  readonly from?: Instant;
  readonly to?: Instant;
}

/**
 * Checker backed by an explicit, caller-supplied list of participations.
 *
 * Intended for tests, development fixtures and the foundation demo, where participation is
 * declared explicitly. It is NOT the production participation index (Participation context,
 * BRT-04+). Its `id` is recorded in every decision/proof so evidence of which data source
 * answered is never lost. A principal is CONFLICTED when any of its declarations, active at
 * `atTime`, contains the requested scope; otherwise CLEAR.
 */
export function staticParticipationChecker(
  declarations: readonly ParticipationDeclaration[],
  id = 'static-participation-list',
): ConflictOfInterestChecker {
  return {
    id,
    check(principalId: Uuid, scope: AuthorityScope, atTime: Instant): CheckerResult {
      const t = atTime.getTime();
      const conflicted = declarations.some(
        (d) =>
          d.principalId === principalId &&
          (d.from === undefined || d.from.getTime() <= t) &&
          (d.to === undefined || t < d.to.getTime()) &&
          scopeContains(d.scope, scope),
      );
      return conflicted ? 'CONFLICTED' : 'CLEAR';
    },
  };
}
