import type { Capability } from '@br/domain';
import type { MembershipRole } from './model';

/**
 * Organization APPLICATION permissions (BRT-04 §16). These govern what an account may do in the
 * application on behalf of an organization (edit its profile, manage its roster). They are a
 * distinct vocabulary from BRT domain capabilities (DECLARE_OFFICIAL, ACCEPT_RESULT…), which are
 * only ever granted through the Authority Engine. No function maps one to the other.
 */
export const OrgPermission = {
  ORG_VIEW_PRIVATE: 'ORG_VIEW_PRIVATE',
  ORG_EDIT_PROFILE: 'ORG_EDIT_PROFILE',
  ORG_INVITE_MEMBER: 'ORG_INVITE_MEMBER',
  ORG_REMOVE_MEMBER: 'ORG_REMOVE_MEMBER',
  ORG_MANAGE_ROLES: 'ORG_MANAGE_ROLES',
  ORG_CONFIRM_EXTERNAL_ID: 'ORG_CONFIRM_EXTERNAL_ID',
  /** BRT-05: create and operate competitions organized by this organization (application-level only). */
  ORG_MANAGE_COMPETITIONS: 'ORG_MANAGE_COMPETITIONS',
} as const;
export type OrgPermission = (typeof OrgPermission)[keyof typeof OrgPermission];

/** Compile-time guard: the two vocabularies share no value. */
type Overlap = Extract<OrgPermission, Capability>;
export const ORG_PERMISSIONS_ARE_NOT_CAPABILITIES: [Overlap] extends [never] ? true : never = true;

const ALL: readonly OrgPermission[] = Object.values(OrgPermission);

export const ROLE_PERMISSIONS: Readonly<Record<MembershipRole, readonly OrgPermission[]>> = {
  OWNER: ALL,
  ADMIN: ALL,
  STAFF: ['ORG_VIEW_PRIVATE'],
  COACH: [],
  OFFICIAL: [],
  ATHLETE: [],
  MEMBER: [],
};

/** Permissions from the caller's ACTIVE memberships only (ended/invited/suspended give nothing). */
export function permissionsForRoles(
  activeRoles: readonly MembershipRole[],
): ReadonlySet<OrgPermission> {
  return new Set(activeRoles.flatMap((r) => ROLE_PERMISSIONS[r]));
}

/**
 * Assigning a role: only an OWNER may assign (or change to/from) OWNER; otherwise inviting needs
 * ORG_INVITE_MEMBER and changing an existing member's role needs ORG_MANAGE_ROLES.
 */
export function canAssignRole(
  actorRoles: readonly MembershipRole[],
  role: MembershipRole,
  action: 'INVITE' | 'CHANGE',
): boolean {
  if (role === 'OWNER') return actorRoles.includes('OWNER');
  const perms = permissionsForRoles(actorRoles);
  return action === 'INVITE' ? perms.has('ORG_INVITE_MEMBER') : perms.has('ORG_MANAGE_ROLES');
}
