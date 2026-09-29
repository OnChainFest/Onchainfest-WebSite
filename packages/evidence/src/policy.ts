import type { EvidencePrivacyClass } from '@br/domain';

/**
 * Centralized evidence access policy (BRT-06 §50; BRT-02 data access model). Pure decisions over
 * facts the persistence layer loads INSIDE the command/read transaction — HTTP handlers never
 * decide. Application access ≠ sporting authority: nothing here grants or implies a Capability.
 *
 *   basis                   who                                               may
 *   SUBMITTER               the account that submitted the item               everything but PURGE
 *   SOURCE_REPRESENTATIVE   an account that represents the source Principal   everything but PURGE
 *                           (org OWNER/ADMIN, or SELF for a PERSON principal)
 *   COMPETITION_STAFF       COMP_VIEW_PRIVATE on a competition the item is    VIEW / READ / CITE,
 *                           attached to (via its exact target's hierarchy)     PLATFORM_PRIVATE only
 *   INTERNAL_SYSTEM         platform-internal processes (no HTTP path)        everything
 *
 * AUTHORITY_ONLY evidence needs an authority grant covering the purpose (ASSESS_EVIDENCE,
 * ADJUDICATE_DISPUTE…); that evaluation is not implemented yet, so it FAILS CLOSED for staff.
 * Denials are indistinguishable from "not found" at the API (no existence oracle).
 */
export const EvidencePurpose = {
  VIEW_METADATA: 'VIEW_METADATA',
  READ_CONTENT: 'READ_CONTENT',
  /** Reference the item (id + hashes) inside a signed statement or as a lineage parent. */
  CITE: 'CITE',
  ATTACH: 'ATTACH',
  RESTRICT: 'RESTRICT',
  RESTORE: 'RESTORE',
  RAISE_PRIVACY: 'RAISE_PRIVACY',
  PURGE: 'PURGE',
} as const;
export type EvidencePurpose = (typeof EvidencePurpose)[keyof typeof EvidencePurpose];

export type EvidenceAccessBasis =
  'SUBMITTER' | 'SOURCE_REPRESENTATIVE' | 'COMPETITION_STAFF' | 'INTERNAL_SYSTEM';

export interface EvidenceAccessFacts {
  readonly evidence: {
    readonly submittedByAccountId: string | null;
    readonly privacyClass: EvidencePrivacyClass;
    /** Competitions resolved (at attach time) from the exact attachment targets. */
    readonly attachedCompetitionIds: readonly string[];
  };
  readonly actor:
    | {
        readonly kind: 'ACCOUNT';
        readonly accountId: string;
        readonly accountActive: boolean;
        /** The account currently represents the item's source Principal (DB-evaluated). */
        readonly representsSource: boolean;
        /** Application permissions per competition (COMP_*), from staff/organizer roles. */
        readonly competitionPermissions: ReadonlyMap<string, ReadonlySet<string>>;
      }
    | { readonly kind: 'INTERNAL_SYSTEM' };
}

export type EvidenceAccessDecision =
  { readonly allowed: true; readonly basis: EvidenceAccessBasis } | { readonly allowed: false };

const STAFF_PURPOSES: ReadonlySet<EvidencePurpose> = new Set<EvidencePurpose>([
  'VIEW_METADATA',
  'READ_CONTENT',
  'CITE',
]);

export function decideEvidenceAccess(
  facts: EvidenceAccessFacts,
  purpose: EvidencePurpose,
): EvidenceAccessDecision {
  const { actor, evidence } = facts;
  if (actor.kind === 'INTERNAL_SYSTEM') return { allowed: true, basis: 'INTERNAL_SYSTEM' };
  if (!actor.accountActive || purpose === 'PURGE') return { allowed: false };
  if (evidence.submittedByAccountId !== null && evidence.submittedByAccountId === actor.accountId)
    return { allowed: true, basis: 'SUBMITTER' };
  if (actor.representsSource) return { allowed: true, basis: 'SOURCE_REPRESENTATIVE' };
  if (
    STAFF_PURPOSES.has(purpose) &&
    evidence.privacyClass === 'PLATFORM_PRIVATE' &&
    evidence.attachedCompetitionIds.some(
      (c) => actor.competitionPermissions.get(c)?.has('COMP_VIEW_PRIVATE') === true,
    )
  ) {
    return { allowed: true, basis: 'COMPETITION_STAFF' };
  }
  return { allowed: false };
}

/**
 * Issuer representation (BRT-06 §40–46): the database decides, inside the transaction, whether an
 * authenticated account may act for a Principal. Only two bases exist:
 *   PERSON_SELF         the Principal is the PERSON principal of the account's SELF person
 *   ORGANIZATION_ADMIN  the Principal is an ORGANIZATION principal and the account's SELF person is
 *                       an ACTIVE OWNER/ADMIN of that ACTIVE organization
 * A guardian is never a basis for a dependent's Principal; SYSTEM/PLATFORM principals have no
 * account representation. Representation is an APPLICATION permission — never ATTEST_RESULT or
 * any other sporting capability, and never a verification.
 */
export type IssuerRepresentation = 'PERSON_SELF' | 'ORGANIZATION_ADMIN';

export function isIssuerRepresentation(value: unknown): value is IssuerRepresentation {
  return value === 'PERSON_SELF' || value === 'ORGANIZATION_ADMIN';
}
