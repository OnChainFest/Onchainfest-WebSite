import { apiRequest, type ApiResult } from './platform';
import type { CatalogDisciplineVersion } from './tournaments';

/**
 * ONCF-05B pairs and squads (the BRT-05 Team model: a competition identity, never an
 * organization). The caller manages teams it created; members join by consent. The API decides
 * who may manage, invite, accept and register; these helpers only choose what to show.
 */
export type TeamKind = 'PERSISTENT' | 'EVENT_PAIR' | 'EVENT_SQUAD';
export type MembershipStatus = 'PROPOSED' | 'ACTIVE';

export interface MyTeam {
  teamId: string;
  teamKind: TeamKind;
  displayName: string;
  createdAt: string;
  members: {
    membershipId: string;
    athleteId: string;
    status: MembershipStatus;
    athlete: { slug: string; displayName: string } | null;
  }[];
}

export interface MyMembership {
  membershipId: string;
  teamId: string;
  teamName: string;
  teamKind: TeamKind;
  athleteId: string;
  status: MembershipStatus;
}

export function myTeams(token: string): Promise<ApiResult<{ items: MyTeam[] }>> {
  return apiRequest(token, 'GET', '/v1/me/teams');
}

export function myMemberships(token: string): Promise<ApiResult<{ items: MyMembership[] }>> {
  return apiRequest(token, 'GET', '/v1/me/team-memberships');
}

export const TEAM_KIND_LABEL: Record<TeamKind, string> = {
  EVENT_PAIR: 'Pair',
  EVENT_SQUAD: 'Squad',
  PERSISTENT: 'Club side',
};

export function activeMembers(team: MyTeam): MyTeam['members'] {
  return team.members.filter((m) => m.status === 'ACTIVE');
}

/**
 * The minimum ACTIVE members a team needs to enter a category of this discipline: its roster
 * minimum (v2 disciplines) or its lineup minimum (v1). The registration command re-checks.
 */
export function teamMinimum(
  d: Pick<CatalogDisciplineVersion, 'lineupSize' | 'roster'> | undefined,
): number {
  return d?.roster?.min ?? d?.lineupSize.min ?? 1;
}

/** The roster maximum, when the discipline bounds it (shown as guidance; the lock re-checks). */
export function teamMaximum(
  d: Pick<CatalogDisciplineVersion, 'roster'> | undefined,
): number | null {
  return d?.roster?.max ?? null;
}

/** Teams that can enter: enough ACTIVE members, and not above the roster maximum. */
export function eligibleTeams(
  teams: readonly MyTeam[],
  d: Pick<CatalogDisciplineVersion, 'lineupSize' | 'roster'> | undefined,
): MyTeam[] {
  const min = teamMinimum(d);
  const max = teamMaximum(d);
  return teams.filter((t) => {
    const n = activeMembers(t).length;
    return n >= min && (max === null || n <= max);
  });
}

/** Suggested team kind for a discipline: a fixed roster of two is a pair, anything else a squad. */
export function suggestedKind(
  d: Pick<CatalogDisciplineVersion, 'lineupSize' | 'roster'> | undefined,
): TeamKind {
  const min = teamMinimum(d);
  const max = teamMaximum(d) ?? d?.lineupSize.max ?? min;
  return min === 2 && max === 2 ? 'EVENT_PAIR' : 'EVENT_SQUAD';
}
