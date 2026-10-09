import { cache } from 'react';
import type { OrgContext } from './org-context';
import { managedCompetition, managedCompetitions, type ManagedCompetition } from './tournaments';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type TournamentResult =
  { kind: 'ok'; data: ManagedCompetition } | { kind: 'not_found' } | { kind: 'unavailable' };

/**
 * One tournament for the organizer area. The API decides access (COMP_VIEW_PRIVATE); a refusal
 * or unknown id is a plain 404. A competition organized by another organization is also a 404
 * here, so a tournament never renders under the wrong organization's chrome.
 */
export const tournamentFor = cache(
  async (ctx: OrgContext, competitionId: string): Promise<TournamentResult> => {
    if (!UUID_RE.test(competitionId)) return { kind: 'not_found' };
    const r = await managedCompetition(ctx.accessToken, competitionId);
    if (r.kind === 'unavailable' || r.kind === 'unauthenticated') return { kind: 'unavailable' };
    if (r.kind === 'error') return { kind: 'not_found' };
    if (r.data.competition.organizerOrganizationId !== ctx.membership.organizationId)
      return { kind: 'not_found' };
    return { kind: 'ok', data: r.data };
  },
);

/** The organization's tournaments, drafts included (ORG_MANAGE_COMPETITIONS). null = unavailable. */
export const tournamentsFor = cache(async (ctx: OrgContext) => {
  const r = await managedCompetitions(ctx.accessToken, ctx.membership.organizationId);
  return r.kind === 'ok' ? r.data.items : null;
});
