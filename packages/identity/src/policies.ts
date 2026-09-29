/**
 * Resource-level application authorization for persons/athletes (BRT-04 §23, §35).
 * Pure decisions over facts loaded by the persistence layer.
 *
 * Control of a Person:
 *   SELF      the account's own person (account_person_control SELF)
 *   GUARDIAN  the account controls person G (SELF) and G has an ACTIVE (confirmed) guardian
 *             relationship over the dependent. PENDING (merely asserted) relationships give nothing.
 *
 * A guardian does NOT inherit every permission: only the operations listed in
 * GUARDIAN_ALLOWED_OPERATIONS. Private-data access and wallet linking stay SELF-only.
 */
export const PersonOperation = {
  VIEW_PRIVATE_DATA: 'VIEW_PRIVATE_DATA',
  EDIT_PRIVATE_DATA: 'EDIT_PRIVATE_DATA',
  CREATE_ATHLETE: 'CREATE_ATHLETE',
  EDIT_ATHLETE_PROFILE: 'EDIT_ATHLETE_PROFILE',
  SET_VISIBILITY: 'SET_VISIBILITY',
  CLAIM_EXTERNAL_IDENTITY: 'CLAIM_EXTERNAL_IDENTITY',
  LINK_WALLET: 'LINK_WALLET',
  ACCEPT_MEMBERSHIP: 'ACCEPT_MEMBERSHIP',
  END_OWN_MEMBERSHIP: 'END_OWN_MEMBERSHIP',
} as const;
export type PersonOperation = (typeof PersonOperation)[keyof typeof PersonOperation];

export const GUARDIAN_ALLOWED_OPERATIONS: ReadonlySet<PersonOperation> = new Set<PersonOperation>([
  'CREATE_ATHLETE',
  'EDIT_ATHLETE_PROFILE',
  'SET_VISIBILITY',
  'CLAIM_EXTERNAL_IDENTITY',
  'ACCEPT_MEMBERSHIP',
  'END_OWN_MEMBERSHIP',
]);

export interface PersonControlFacts {
  /** The person the account controls as SELF (if any). */
  readonly selfPersonId?: string;
  /** Dependents with an ACTIVE guardian relationship to the account's self person. */
  readonly activeDependentPersonIds: readonly string[];
  /** Account status; a DISABLED account controls nothing. */
  readonly accountActive: boolean;
}

export type ControlBasis = 'SELF' | 'GUARDIAN';

export function controlBasis(
  facts: PersonControlFacts,
  personId: string,
): ControlBasis | undefined {
  if (!facts.accountActive) return undefined;
  if (facts.selfPersonId === personId) return 'SELF';
  if (facts.activeDependentPersonIds.includes(personId)) return 'GUARDIAN';
  return undefined;
}

export function canOperateOnPerson(
  facts: PersonControlFacts,
  personId: string,
  operation: PersonOperation,
): boolean {
  const basis = controlBasis(facts, personId);
  if (basis === 'SELF') return true;
  if (basis === 'GUARDIAN') return GUARDIAN_ALLOWED_OPERATIONS.has(operation);
  return false;
}
