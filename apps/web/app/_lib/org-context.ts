import { cache } from 'react';
import { appContext } from './app-context';
import { API_BASE, type PublicCompetitionCard, type PublicOrganization } from './api';
import { apiRequest, type MyOrganization } from './platform';

/**
 * ONCF-02 organization area context. Access is decided by the platform: the organization must be
 * one of the caller's ACTIVE memberships (GET /v1/me/organizations) and every capability comes from
 * GET /v1/organizations/:id/permissions. The UI hides what the caller cannot do; the API still
 * rejects it.
 */
export type OrgPermission =
  | 'ORG_VIEW_PRIVATE'
  | 'ORG_EDIT_PROFILE'
  | 'ORG_INVITE_MEMBER'
  | 'ORG_REMOVE_MEMBER'
  | 'ORG_MANAGE_ROLES'
  | 'ORG_CONFIRM_EXTERNAL_ID'
  | 'ORG_MANAGE_COMPETITIONS';

export interface RosterEntry {
  membershipId: string;
  personId: string;
  role: string;
  visibility: string;
  status: string;
  since: string;
  invitationExpiresAt: string | null;
  athlete: { slug: string; displayName: string } | null;
}

export interface OrgContext {
  readonly accessToken: string;
  readonly selfPersonId: string | null;
  readonly membership: MyOrganization;
  readonly roles: string[];
  readonly permissions: ReadonlySet<OrgPermission>;
  readonly profile: PublicOrganization['organization'] | null;
}

export type OrgContextResult =
  { kind: 'ok'; ctx: OrgContext } | { kind: 'not_member' } | { kind: 'unavailable' };

export const orgContext = cache(async (slug: string): Promise<OrgContextResult> => {
  const app = await appContext();
  if (app.kind !== 'ok') return { kind: 'unavailable' };
  // Several memberships (e.g. OWNER + ATHLETE) can exist in one organization; any ACTIVE one admits.
  const membership = app.account.organizations.find((o) => o.slug === slug);
  if (membership === undefined) return { kind: 'not_member' };
  const token = app.session.accessToken;
  const [perms, profile] = await Promise.all([
    apiRequest<{ roles: string[]; permissions: OrgPermission[] }>(
      token,
      'GET',
      `/v1/organizations/${membership.organizationId}/permissions`,
    ),
    publicOrganization(membership.slug),
  ]);
  if (perms.kind !== 'ok') return { kind: 'unavailable' };
  return {
    kind: 'ok',
    ctx: {
      accessToken: token,
      selfPersonId: app.account.me.selfPersonId,
      membership,
      roles: perms.data.roles,
      permissions: new Set(perms.data.permissions),
      profile: profile?.organization ?? null,
    },
  };
});

export async function publicOrganization(slug: string): Promise<PublicOrganization | null> {
  try {
    const res = await fetch(`${API_BASE}/v1/organizations/${encodeURIComponent(slug)}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? ((await res.json()) as PublicOrganization) : null;
  } catch {
    return null;
  }
}

export async function publicCompetitions(slug: string): Promise<PublicCompetitionCard[] | null> {
  try {
    const res = await fetch(
      `${API_BASE}/v1/organizations/${encodeURIComponent(slug)}/competitions`,
      { cache: 'no-store', signal: AbortSignal.timeout(10_000) },
    );
    return res.ok ? ((await res.json()) as { items: PublicCompetitionCard[] }).items : null;
  } catch {
    return null;
  }
}

export async function roster(ctx: OrgContext): Promise<RosterEntry[] | null> {
  const r = await apiRequest<{ items: RosterEntry[] }>(
    ctx.accessToken,
    'GET',
    `/v1/organizations/${ctx.membership.organizationId}/members`,
  );
  return r.kind === 'ok' ? r.data.items : null;
}

/** Profile completeness from public fields only (no fabricated scoring inputs). */
export function profileChecklist(profile: OrgContext['profile']) {
  const p = profile?.profile;
  return [
    { key: 'logo', label: 'Logo', done: Boolean(p?.logoUrl) },
    { key: 'description', label: 'Description', done: Boolean(p?.description) },
    { key: 'sports', label: 'Sports', done: (p?.sports?.length ?? 0) > 0 },
    { key: 'contact', label: 'Public contact', done: Boolean(p?.publicContact) },
    { key: 'website', label: 'Website', done: Boolean(p?.website) },
    { key: 'country', label: 'Country', done: Boolean(p?.country) },
  ];
}

export const ROLE_LABEL: Record<string, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  STAFF: 'Staff',
  COACH: 'Coach',
  OFFICIAL: 'Official',
  ATHLETE: 'Athlete',
  MEMBER: 'Member',
};

export const ORG_TYPE_LABEL: Record<string, string> = {
  CLUB: 'Club',
  ACADEMY: 'Academy',
  LEAGUE: 'League',
  EVENT_ORGANIZER: 'Event organizer',
  FEDERATION: 'Federation',
  GOVERNING_BODY: 'Governing body',
  VENUE: 'Venue',
};

/** Roles the caller may assign — mirrors canAssignRole (the API enforces it regardless). */
export function assignableRoles(ctx: OrgContext, action: 'INVITE' | 'CHANGE'): string[] {
  const need = action === 'INVITE' ? 'ORG_INVITE_MEMBER' : 'ORG_MANAGE_ROLES';
  if (!ctx.permissions.has(need)) return [];
  const base = ['ADMIN', 'STAFF', 'COACH', 'OFFICIAL', 'ATHLETE', 'MEMBER'];
  return ctx.roles.includes('OWNER') ? ['OWNER', ...base] : base;
}
