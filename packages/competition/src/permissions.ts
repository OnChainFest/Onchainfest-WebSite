import type { Capability } from '@br/domain';

/**
 * Competition APPLICATION permissions (BRT-05). They govern who may operate a competition in the
 * application: edit it, run registration, lock the field, generate structure, schedule contests.
 * They are a vocabulary disjoint from BRT domain capabilities (ACCEPT_RESULT, DECLARE_OFFICIAL,
 * ATTEST_RESULT, RATIFY_RECORD…), which only the Authority Engine grants. No function maps one
 * onto the other, and no staff role is authority-bearing (there is no REFEREE/OFFICIAL role).
 */
export const CompPermission = {
  COMP_VIEW_PRIVATE: 'COMP_VIEW_PRIVATE',
  COMP_EDIT: 'COMP_EDIT',
  COMP_PUBLISH: 'COMP_PUBLISH',
  COMP_MANAGE_STAFF: 'COMP_MANAGE_STAFF',
  COMP_OPEN_REGISTRATION: 'COMP_OPEN_REGISTRATION',
  COMP_CLOSE_REGISTRATION: 'COMP_CLOSE_REGISTRATION',
  COMP_MANAGE_REGISTRATIONS: 'COMP_MANAGE_REGISTRATIONS',
  COMP_LOCK_FIELD: 'COMP_LOCK_FIELD',
  COMP_GENERATE_STRUCTURE: 'COMP_GENERATE_STRUCTURE',
  COMP_MANAGE_SCHEDULE: 'COMP_MANAGE_SCHEDULE',
  COMP_MANAGE_LINEUPS: 'COMP_MANAGE_LINEUPS',
  COMP_CANCEL: 'COMP_CANCEL',
} as const;
export type CompPermission = (typeof CompPermission)[keyof typeof CompPermission];

/** Compile-time guard: the two vocabularies share no value. */
type Overlap = Extract<CompPermission, Capability>;
export const COMP_PERMISSIONS_ARE_NOT_CAPABILITIES: [Overlap] extends [never] ? true : never = true;

export const StaffRole = {
  OWNER: 'OWNER',
  ADMIN: 'ADMIN',
  REGISTRATION_MANAGER: 'REGISTRATION_MANAGER',
  SCHEDULER: 'SCHEDULER',
} as const;
export type StaffRole = (typeof StaffRole)[keyof typeof StaffRole];

const ALL: readonly CompPermission[] = Object.values(CompPermission);

export const STAFF_ROLE_PERMISSIONS: Readonly<Record<StaffRole, readonly CompPermission[]>> = {
  OWNER: ALL,
  ADMIN: ALL.filter((p) => p !== 'COMP_MANAGE_STAFF'),
  REGISTRATION_MANAGER: [
    'COMP_VIEW_PRIVATE',
    'COMP_OPEN_REGISTRATION',
    'COMP_CLOSE_REGISTRATION',
    'COMP_MANAGE_REGISTRATIONS',
  ],
  SCHEDULER: ['COMP_VIEW_PRIVATE', 'COMP_MANAGE_SCHEDULE', 'COMP_MANAGE_LINEUPS'],
};

/**
 * Organizer-organization roles that operate the organization's competitions: an ACTIVE OWNER or
 * ADMIN of the organizer organization acts as competition OWNER / ADMIN. Other organization roles
 * (MEMBER, ATHLETE, COACH, OFFICIAL, STAFF) confer nothing here.
 */
export const ORGANIZER_ROLE_TO_STAFF_ROLE: Readonly<Partial<Record<string, StaffRole>>> = {
  OWNER: 'OWNER',
  ADMIN: 'ADMIN',
};

export function compPermissionsFor(staffRoles: readonly StaffRole[]): ReadonlySet<CompPermission> {
  return new Set(staffRoles.flatMap((r) => STAFF_ROLE_PERMISSIONS[r]));
}
