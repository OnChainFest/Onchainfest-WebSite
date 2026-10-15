import type { RosterEntry } from './org-context';
import { apiRequest, type ApiResult } from './platform';

/**
 * ONCF-L1 competition staff. Shapes mirror GET /v1/competitions/:id/staff (COMP_VIEW_PRIVATE);
 * assigning and ending go through POST /v1/competitions/:id/staff and
 * DELETE /v1/competition-staff/:id, both gated by COMP_MANAGE_STAFF in the competition store.
 * The labels and descriptions below are explanation only — nothing here decides access.
 */
export type StaffRole = 'OWNER' | 'ADMIN' | 'REGISTRATION_MANAGER' | 'SCHEDULER';

/** The roles the API accepts, in display order. */
export const STAFF_ROLES: readonly StaffRole[] = [
  'OWNER',
  'ADMIN',
  'REGISTRATION_MANAGER',
  'SCHEDULER',
];

export const STAFF_ROLE_LABEL: Record<StaffRole, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  REGISTRATION_MANAGER: 'Registration manager',
  SCHEDULER: 'Scheduler',
};

/** What each role can do, restating the competition permission model (BRT-05). */
export const STAFF_ROLE_DUTY: Record<StaffRole, { summary: string; detail: string }> = {
  OWNER: {
    summary: 'Full tournament control',
    detail: 'Everything an admin can do, plus adding and removing tournament staff.',
  },
  ADMIN: {
    summary: 'Tournament administration',
    detail:
      'Edit, publish and cancel the tournament; run registration, the field, structure and schedule. Cannot change staff.',
  },
  REGISTRATION_MANAGER: {
    summary: 'Registration and participants',
    detail: 'Open and close registration and decide on entries.',
  },
  SCHEDULER: {
    summary: 'Schedule and lineups',
    detail: 'Manage the schedule and lineups.',
  },
};

export const isStaffRole = (v: string): v is StaffRole =>
  (STAFF_ROLES as readonly string[]).includes(v);

export interface StaffEntry {
  staffId: string;
  personId: string;
  role: StaffRole;
  since: string;
  athlete: { slug: string; displayName: string } | null;
}

export function competitionStaff(
  token: string,
  competitionId: string,
): Promise<ApiResult<{ items: StaffEntry[] }>> {
  return apiRequest(token, 'GET', `/v1/competitions/${competitionId}/staff`);
}

/** The permission the store checks for assigning and ending staff. */
export const canManageStaff = (permissions: readonly string[]) =>
  permissions.includes('COMP_MANAGE_STAFF');

/**
 * Organizer-organization OWNER/ADMIN act as tournament OWNER/ADMIN without a staff row
 * (ORGANIZER_ROLE_TO_STAFF_ROLE). Shown so the page explains everyone with access.
 */
export function organizerStaff(roster: readonly RosterEntry[]): RosterEntry[] {
  return roster.filter((m) => m.status === 'ACTIVE' && (m.role === 'OWNER' || m.role === 'ADMIN'));
}

/**
 * People who can be picked for a staff role: ACTIVE organization members, one entry per person
 * (several memberships can share a person). Named by their public athlete profile when they have
 * one; the API resolves the person id and refuses anything else.
 */
export function staffCandidates(
  roster: readonly RosterEntry[],
): { personId: string; label: string }[] {
  const seen = new Map<string, { personId: string; label: string }>();
  for (const m of roster) {
    if (m.status !== 'ACTIVE' || seen.has(m.personId)) continue;
    seen.set(m.personId, {
      personId: m.personId,
      label:
        m.athlete === null
          ? `Member without a public profile (${m.personId.slice(0, 8)})`
          : `${m.athlete.displayName} · /athletes/${m.athlete.slug}`,
    });
  }
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
}
