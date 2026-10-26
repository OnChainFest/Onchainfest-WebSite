import {
  Capability,
  DomainError,
  DomainErrorCode,
  type AuthorityScope,
  type Instant,
  type Uuid,
} from '@br/domain';
import { ORGANIZER_ROLE_TO_STAFF_ROLE } from '@br/competition';
import { sql } from 'kysely';
import { AuthorityStore, normalizeScope } from './authority-store';
import {
  competitionPermissions,
  loadCompetition,
  type CompetitionRow,
} from './competition-support';
import {
  personParticipatesInCompetition,
  platformGrantorChecker,
} from './competition-participation';
import type { Db } from './db';
import { loadControlFacts, lockKeys, lockKeysShared, recordAudit } from './identity-support';
import { inTransaction, ModuleRole, withModuleRole, type TxContext } from './tx';

/**
 * ADR-0077: governance-issued competition result authority.
 *
 * A platform OPERATOR, acting under a recorded governance decision, anchors the PLATFORM principal
 * once and then grants a competition's OWNER/ADMIN staff member the four ADR-0064 result
 * capabilities for that one competition. The staff role is a precondition checked here. It is never
 * the source of authority: authority exists only as the recorded grant, and no HTTP route reaches
 * this class (tooling/check-no-manual-authority.mjs).
 */
export const RESULT_AUTHORITY_CAPABILITIES: readonly Capability[] = [
  Capability.SUBMIT_RESULT,
  Capability.ACCEPT_RESULT,
  Capability.DECLARE_OFFICIAL,
  Capability.CORRECT_RESULT,
];

/** Competition staff roles eligible for result authority (never REGISTRATION_MANAGER / SCHEDULER). */
export const RESULT_AUTHORITY_STAFF_ROLES = ['OWNER', 'ADMIN'] as const;

/** Organization roles that make a member competition OWNER / ADMIN of the organizer's competitions. */
const RESULT_AUTHORITY_ORG_ROLES = Object.entries(ORGANIZER_ROLE_TO_STAFF_ROLE)
  .filter(([, staff]) => (RESULT_AUTHORITY_STAFF_ROLES as readonly string[]).includes(staff ?? ''))
  .map(([org]) => org);

/**
 * ADR-0079 §2.2: the keys every change of a result-staff eligibility basis takes exclusively. Result
 * commands and the issuance below hold them shared, in one sorted call.
 */
export function resultStaffEligibilityKeys(
  accountId: string,
  competition: Pick<CompetitionRow, 'id' | 'organizerOrganizationId'>,
  personId: string,
): string[] {
  return [
    `account:${accountId}`,
    `competition-staff:${competition.id}:${personId}`,
    `org-roster:${competition.organizerOrganizationId}`,
    `org:${competition.organizerOrganizationId}`,
  ];
}

/** One eligibility entity's status history: its row id, how many status changes it has, and
 * whether the latest one is ACTIVE. Histories are append-only, so the count only ever grows. */
export interface EligibilityVersion {
  readonly id: string;
  readonly changes: number;
  readonly active: boolean;
}

/** The result-staff eligibility facts of one account in one competition, read under the keys. */
export interface EligibilitySnapshot {
  readonly account: EligibilityVersion;
  readonly organization: EligibilityVersion;
  /** Explicit OWNER / ADMIN staff rows of the competition. */
  readonly staff: readonly EligibilityVersion[];
  /** OWNER / ADMIN memberships of the organizer organization. */
  readonly memberships: readonly EligibilityVersion[];
}

/** A basis the grant was issued on: the row and its status-change count at issuance. */
export interface EligibilityBasis {
  readonly kind: 'STAFF' | 'MEMBERSHIP';
  readonly id: string;
  readonly changes: number;
}

/**
 * WP-P0-3 Q3 (ADR-0079 §2.3): what an ADR-0077 grant was issued on. Each entity's status history is
 * written only while its producer holds that entity's eligibility key exclusively, and the issuance
 * and every result command read it holding the key shared, so "this history has exactly N changes"
 * is decided in commit order. No transaction-start timestamp is compared across transactions.
 */
export interface EligibilityBinding {
  readonly accountChanges: number;
  readonly organizationChanges: number;
  readonly bases: readonly EligibilityBasis[];
}

const version = (v: EligibilityVersion) => ({ id: v.id, changes: v.changes });

/**
 * The binding a grant issued now would carry: every currently ACTIVE basis (a membership only while
 * the organization is ACTIVE), for an ACTIVE account. Undefined when the account holds none.
 */
export function bindingFrom(s: EligibilitySnapshot): EligibilityBinding | undefined {
  if (!s.account.active) return undefined;
  const bases: EligibilityBasis[] = [
    ...s.staff.filter((v) => v.active).map((v) => ({ kind: 'STAFF' as const, ...version(v) })),
    ...(s.organization.active
      ? s.memberships
          .filter((v) => v.active)
          .map((v) => ({ kind: 'MEMBERSHIP' as const, ...version(v) }))
      : []),
  ];
  return bases.length === 0
    ? undefined
    : {
        accountChanges: s.account.changes,
        organizationChanges: s.organization.changes,
        bases,
      };
}

/**
 * Whether the eligibility a grant was issued on still holds, uninterrupted: the account has no
 * status change since, and at least one bound basis has none either (a membership also needs the
 * organization unchanged). Any loss — demotion, removal, suspension, a role change that replaces the
 * row — adds a change, so a later re-promotion never restores the grant: a fresh one is required.
 */
export function bindingHolds(b: EligibilityBinding, s: EligibilitySnapshot): boolean {
  if (!s.account.active || s.account.changes !== b.accountChanges) return false;
  return b.bases.some((basis) => {
    const now = (basis.kind === 'STAFF' ? s.staff : s.memberships).find((v) => v.id === basis.id);
    if (now === undefined || !now.active || now.changes !== basis.changes) return false;
    return (
      basis.kind === 'STAFF' ||
      (s.organization.active && s.organization.changes === b.organizationChanges)
    );
  });
}

/**
 * The account's result-staff eligibility facts in the competition. Each history is read by the
 * module role that owns it (staff: competition; account and memberships: identity, which already
 * reads memberships for permissions; organization status: organizations). The caller holds the
 * eligibility keys, so none of them changes meanwhile.
 */
export async function resultEligibilitySnapshot(
  ctx: TxContext,
  accountId: string,
  competition: Pick<CompetitionRow, 'id' | 'organizerOrganizationId'>,
  personId: string,
): Promise<EligibilitySnapshot> {
  const org = competition.organizerOrganizationId;
  const none = (id: string): EligibilityVersion => ({ id, changes: 0, active: false });
  const staff = await sql<EligibilityVersion>`
    SELECT s.id, count(*)::int AS changes, (array_agg(c.status ORDER BY c.seq DESC))[1] = 'ACTIVE' AS active
    FROM competition.competition_staff s
    JOIN competition.competition_staff_status_change c ON c.staff_id = s.id
    WHERE s.competition_id = ${competition.id} AND s.person_id = ${personId}
      AND s.staff_role = ANY(${sql.val([...RESULT_AUTHORITY_STAFF_ROLES])}::text[])
    GROUP BY s.id ORDER BY s.id`.execute(ctx.trx);
  const identity = await withModuleRole(ctx, ModuleRole.identity, async (ictx) => ({
    account: await sql<EligibilityVersion>`
      SELECT account_id AS id, count(*)::int AS changes, (array_agg(status ORDER BY seq DESC))[1] = 'ACTIVE' AS active
      FROM identity.account_status_change WHERE account_id = ${accountId}
      GROUP BY account_id`.execute(ictx.trx),
    memberships: await sql<EligibilityVersion>`
      SELECT m.id, count(*)::int AS changes, (array_agg(c.status ORDER BY c.seq DESC))[1] = 'ACTIVE' AS active
      FROM organizations.membership m
      JOIN organizations.membership_status_change c ON c.membership_id = m.id
      WHERE m.organization_id = ${org} AND m.person_id = ${personId}
        AND m.membership_role = ANY(${sql.val(RESULT_AUTHORITY_ORG_ROLES)}::text[])
      GROUP BY m.id ORDER BY m.id`.execute(ictx.trx),
  }));
  const organization = await withModuleRole(ctx, ModuleRole.organizations, (octx) =>
    sql<EligibilityVersion>`
      SELECT organization_id AS id, count(*)::int AS changes, (array_agg(status ORDER BY seq DESC))[1] = 'ACTIVE' AS active
      FROM organizations.organization_status_change WHERE organization_id = ${org}
      GROUP BY organization_id`.execute(octx.trx),
  );
  return {
    account: identity.account.rows[0] ?? none(accountId),
    organization: organization.rows[0] ?? none(org),
    staff: staff.rows,
    memberships: identity.memberships.rows,
  };
}

/** A stored binding (`competition.result_grant_eligibility`), with whom and where it was issued. */
export interface StoredEligibilityBinding extends EligibilityBinding {
  readonly grantId: string;
  readonly competitionId: string;
  readonly accountId: string;
  readonly personId: string;
}

/** The stored bindings of these grants (none for a grant the ADR-0077 issuance did not bind). */
export async function grantEligibilityBindings(
  ctx: TxContext,
  grantIds: readonly string[],
): Promise<Map<string, StoredEligibilityBinding>> {
  if (grantIds.length === 0) return new Map();
  const { rows } = await sql<{
    grant_id: string;
    competition_id: string;
    account_id: string;
    person_id: string;
    account_changes: number;
    organization_changes: number;
    bases: EligibilityBasis[];
  }>`
    SELECT grant_id, competition_id, account_id, person_id, account_changes, organization_changes, bases
    FROM competition.result_grant_eligibility WHERE grant_id = ANY(${sql.val([...grantIds])}::uuid[])`.execute(
    ctx.trx,
  );
  return new Map(
    rows.map((r) => [
      r.grant_id,
      {
        grantId: r.grant_id,
        competitionId: r.competition_id,
        accountId: r.account_id,
        personId: r.person_id,
        accountChanges: r.account_changes,
        organizationChanges: r.organization_changes,
        bases: r.bases,
      },
    ]),
  );
}

const OPERATING_STATUSES = ['PUBLISHED', 'ACTIVE'];
const REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/;

function governanceRef(value: string, what: string): string {
  if (!REF.test(value))
    throw new DomainError(
      DomainErrorCode.INVALID_INPUT,
      `${what} must be a 3-128 character reference ([A-Za-z0-9._:/-]); never personal data`,
    );
  return value;
}

export function competitionResultScope(competitionId: string): AuthorityScope {
  return normalizeScope({ recognitionLevel: ['PLATFORM'], competition: [competitionId as Uuid] });
}

export interface ResultAuthorityGrantView {
  readonly grantId: Uuid;
  readonly granteePrincipalId: Uuid;
  readonly grantorPrincipalId: Uuid;
  readonly capabilities: readonly string[];
  readonly effectiveFrom: Instant;
  readonly effectiveTo: Instant | null;
  readonly recordedAt: Instant;
  readonly status: 'ACTIVE' | 'REVOKED' | 'EXPIRED' | 'SCHEDULED';
}

export class ResultAuthorityGovernance {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Recognizes the PLATFORM principal as the PLATFORM-level trust anchor under a governance
   * decision. Idempotent by `governanceDecisionRef`: a second run returns the existing anchor. A
   * revoked anchor is refused, never replaced silently.
   */
  async bootstrapPlatformAnchor(input: {
    governanceDecisionRef: string;
    basisRef: string;
    label?: string;
  }): Promise<{ platformPrincipalId: Uuid; anchorId: Uuid; created: boolean }> {
    const ref = governanceRef(input.governanceDecisionRef, 'governanceDecisionRef');
    const basis = governanceRef(input.basisRef, 'basisRef');
    const existing = await inTransaction(this.db, ModuleRole.authority, async (ctx) => {
      const { rows } = await sql<{ anchor_id: string; principal_id: string; revoked: boolean }>`
        SELECT a.id AS anchor_id, a.principal_id,
               EXISTS (SELECT 1 FROM authority.trust_anchor_status_change s WHERE s.anchor_id = a.id) AS revoked
        FROM authority.trust_anchor a JOIN authority.principal p ON p.id = a.principal_id
        WHERE a.governance_decision_ref = ${ref} AND p.principal_type = 'PLATFORM'
        ORDER BY a.recorded_at LIMIT 1`.execute(ctx.trx);
      return rows[0];
    });
    if (existing !== undefined) {
      if (existing.revoked)
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          'the anchor recognized under this governance decision has been revoked; a new decision is required',
          { reason: 'ANCHOR_REVOKED' },
        );
      return {
        platformPrincipalId: existing.principal_id as Uuid,
        anchorId: existing.anchor_id as Uuid,
        created: false,
      };
    }
    const store = new AuthorityStore(this.db);
    const platform = await store.registerPrincipal({
      principalType: 'PLATFORM',
      label: input.label ?? 'OnChainFest platform',
    });
    const { anchorId } = await store.recognizeTrustAnchor({
      principalId: platform.id,
      recognitionScope: { recognitionLevel: ['PLATFORM'] },
      basisRef: basis,
      governanceDecisionRef: ref,
    });
    await this.audit('authority.platform-anchor.recognized', 'SUCCEEDED', undefined, {
      platformPrincipalId: platform.id,
      anchorId,
      governanceDecisionRef: ref,
    });
    return { platformPrincipalId: platform.id, anchorId, created: true };
  }

  /**
   * Grants the four ADR-0064 result capabilities for one competition to the grantee account's own
   * PERSON principal. Converges when an equivalent active grant exists. Preconditions (ADR-0077
   * §2.3): the competition is PUBLISHED or ACTIVE; the grantee is OWNER or ADMIN staff of it; the
   * grantee does not participate in it; the grantor is a PLATFORM principal.
   */
  async grantCompetitionResultAuthority(input: {
    platformPrincipalId: string;
    competitionId: string;
    granteeAccountId: string;
    governanceDecisionRef: string;
    effectiveTo?: Instant;
  }): Promise<{ grantId: Uuid; granteePrincipalId: Uuid; created: boolean }> {
    const ref = governanceRef(input.governanceDecisionRef, 'governanceDecisionRef');
    const platformId = await this.platformPrincipal(input.platformPrincipalId);
    const eligibility = await inTransaction(this.db, ModuleRole.competition, async (ctx) => {
      const competition = await loadCompetition(ctx, input.competitionId);
      // A denial is audited and committed; the error is thrown after the transaction.
      const deny = async (
        reason: string,
        message: string,
        code: DomainErrorCode = DomainErrorCode.FORBIDDEN,
      ) => {
        await recordAudit(ctx, {
          action: 'authority.result-grant.issue',
          targetType: 'COMPETITION',
          targetId: competition.id,
          outcome: 'DENIED',
          details: { reason, granteeAccountId: input.granteeAccountId, governanceDecisionRef: ref },
        });
        return { denied: new DomainError(code, message, { reason }) };
      };
      if (!OPERATING_STATUSES.includes(competition.status))
        return deny(
          'COMPETITION_NOT_OPERATING',
          `result authority is issued only for PUBLISHED or ACTIVE competitions (is ${competition.status})`,
          DomainErrorCode.INVALID_TRANSITION,
        );
      const { staffRoles } = await competitionPermissions(ctx, input.granteeAccountId, competition);
      const eligibleRoles = staffRoles.filter((r) =>
        (RESULT_AUTHORITY_STAFF_ROLES as readonly string[]).includes(r),
      );
      if (eligibleRoles.length === 0)
        return deny(
          'NOT_RESULT_STAFF',
          'the grantee is not OWNER or ADMIN staff of this competition',
        );
      const facts = await loadControlFacts(ctx, input.granteeAccountId);
      const personId = facts.selfPersonId as string; // present: staff roles require a SELF person
      if (await personParticipatesInCompetition(ctx, personId, competition.id))
        return deny(
          'GRANTEE_PARTICIPATES',
          'the grantee participates in this competition and cannot hold its result authority',
        );
      return { competitionId: competition.id, personId, eligibleRoles };
    });
    if ('denied' in eligibility) throw eligibility.denied;

    const granteePrincipalId = await inTransaction(this.db, ModuleRole.identity, async (ctx) => {
      const { rows } = await sql<{ p: string }>`
        SELECT identity.ensure_person_principal(${input.granteeAccountId}::uuid, ${eligibility.personId}::uuid) AS p`.execute(
        ctx.trx,
      );
      return rows[0]?.p as Uuid;
    });

    const scope = competitionResultScope(eligibility.competitionId);
    // WP-P0-3 Q3 (ADR-0079 §2.3): the grant is decided, written and bound to the eligibility it
    // relies on while that eligibility is held. This transaction keeps the eligibility keys (shared)
    // until the grant and its binding have committed, so no demotion or re-promotion falls between
    // the read and the binding. Issuances for one grantee serialize on their own key first (taken
    // only here, before the eligibility keys), so a concurrent run converges on a committed,
    // bound grant. It is not retried: its body commits other transactions. Nothing in that body
    // takes the eligibility keys.
    const issued = await inTransaction(
      this.db,
      ModuleRole.competition,
      async (ctx) => {
        const competition = await loadCompetition(ctx, eligibility.competitionId);
        await lockKeys(ctx, `result-authority-issue:${competition.id}:${eligibility.personId}`);
        await lockKeysShared(
          ctx,
          ...resultStaffEligibilityKeys(input.granteeAccountId, competition, eligibility.personId),
        );
        const self = (await loadControlFacts(ctx, input.granteeAccountId)).selfPersonId;
        const { staffRoles } = await competitionPermissions(
          ctx,
          input.granteeAccountId,
          competition,
        );
        const snapshot =
          self === eligibility.personId &&
          staffRoles.some((r) => (RESULT_AUTHORITY_STAFF_ROLES as readonly string[]).includes(r))
            ? await resultEligibilitySnapshot(
                ctx,
                input.granteeAccountId,
                competition,
                eligibility.personId,
              )
            : undefined;
        const binding = snapshot === undefined ? undefined : bindingFrom(snapshot);
        if (snapshot === undefined || binding === undefined) {
          await recordAudit(ctx, {
            action: 'authority.result-grant.issue',
            targetType: 'COMPETITION',
            targetId: competition.id,
            outcome: 'DENIED',
            details: {
              reason: 'NOT_RESULT_STAFF',
              granteeAccountId: input.granteeAccountId,
              governanceDecisionRef: ref,
            },
          });
          return {
            denied: new DomainError(
              DomainErrorCode.FORBIDDEN,
              'the grantee is not OWNER or ADMIN staff of this competition',
              { reason: 'NOT_RESULT_STAFF' },
            ),
          };
        }
        // A held grant whose binding no longer holds (or that has none: a legacy or foreign grant)
        // is refused by the ledger (GRANT_ELIGIBILITY_STALE), so it is never reused or re-bound; it
        // is revoked, prospectively.
        const held = await this.activeGrants(platformId, granteePrincipalId, scope);
        const bindings = await grantEligibilityBindings(
          ctx,
          held.map((g) => g.id),
        );
        const holds = (grantId: string) => {
          const b = bindings.get(grantId);
          return (
            b !== undefined &&
            b.competitionId === competition.id &&
            b.accountId === input.granteeAccountId &&
            b.personId === eligibility.personId &&
            bindingHolds(b, snapshot)
          );
        };
        const stale = held.filter((g) => !holds(g.id)).map((g) => g.id);
        const authority = new AuthorityStore(this.db);
        for (const grantId of stale)
          await authority.revokeGrant({
            grantId,
            actorPrincipalId: platformId,
            reason: `not bound to the grantee's current OWNER/ADMIN eligibility [governance:${ref}]`,
          });
        // Audited as soon as committed: the issuance below may still be refused.
        if (stale.length > 0)
          await this.audit('authority.result-grant.stale-revoked', 'SUCCEEDED', competition.id, {
            revokedGrantIds: stale,
            granteePrincipalId,
            granteeAccountId: input.granteeAccountId,
            platformPrincipalId: platformId,
            governanceDecisionRef: ref,
          });
        const current = held.find((g) => holds(g.id));
        if (current !== undefined) return { grantId: current.id, created: false };
        const decisionUsed = () =>
          new DomainError(
            DomainErrorCode.ALREADY_EXISTS,
            'this governance decision was already used for this grantee and competition; a new decision is required',
            { reason: 'GOVERNANCE_DECISION_USED' },
          );
        const store = new AuthorityStore(this.db, {
          conflictChecker: platformGrantorChecker(platformId),
        });
        let out: Awaited<ReturnType<typeof store.issueGrant>>;
        try {
          out = await store.issueGrant({
            actorPrincipalId: platformId,
            grantorPrincipalId: platformId,
            granteePrincipalId,
            capabilities: RESULT_AUTHORITY_CAPABILITIES,
            scope,
            delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
            constraints: { mustNotBeParticipant: true },
            ...(input.effectiveTo === undefined ? {} : { effectiveTo: input.effectiveTo }),
            idempotencyKey: `result-authority:${eligibility.competitionId}:${granteePrincipalId}:${ref}`,
          });
        } catch (err) {
          // The decision was already spent on a grant that is no longer bound to current
          // eligibility (a committed, bound one was converged on above).
          if (err instanceof DomainError && err.code === DomainErrorCode.IDEMPOTENCY_KEY_REUSED)
            throw decisionUsed();
          throw err;
        }
        // Only a grant created by this act is bound, now, to what was read under the keys: an
        // existing grant handed back by a replay is never bound after the fact.
        if (!out.created) throw decisionUsed();
        await sql`INSERT INTO competition.result_grant_eligibility (grant_id, competition_id, account_id,
                    person_id, organization_id, account_changes, organization_changes, bases, recorded_at)
          VALUES (${out.grant.id}, ${competition.id}, ${input.granteeAccountId}, ${eligibility.personId},
                  ${competition.organizerOrganizationId}, ${binding.accountChanges},
                  ${binding.organizationChanges}, ${JSON.stringify(binding.bases)}::jsonb, ${ctx.txTime})`.execute(
          ctx.trx,
        );
        return { grantId: out.grant.id, created: true };
      },
      1,
    );
    if ('denied' in issued) throw issued.denied;
    const { grantId, created } = issued;
    await this.audit(
      created ? 'authority.result-grant.issued' : 'authority.result-grant.already-held',
      'SUCCEEDED',
      eligibility.competitionId,
      {
        grantId,
        granteePrincipalId,
        granteeAccountId: input.granteeAccountId,
        platformPrincipalId: platformId,
        staffRoles: eligibility.eligibleRoles,
        governanceDecisionRef: ref,
      },
    );
    return { grantId, granteePrincipalId, created };
  }

  /**
   * Revokes (prospectively) every active ADR-0077 grant the account's PERSON principal holds for
   * the competition. It does not require the grantee to still be staff: removing staff is exactly
   * when this runs.
   */
  async revokeCompetitionResultAuthority(input: {
    platformPrincipalId: string;
    competitionId: string;
    granteeAccountId: string;
    governanceDecisionRef: string;
    reason: string;
  }): Promise<{ revokedGrantIds: Uuid[] }> {
    const ref = governanceRef(input.governanceDecisionRef, 'governanceDecisionRef');
    const reason = input.reason.trim();
    if (reason.length === 0 || reason.length > 500)
      throw new DomainError(
        DomainErrorCode.INVALID_INPUT,
        'a reason (1-500 characters) is required',
      );
    const platformId = await this.platformPrincipal(input.platformPrincipalId);
    const principals = await inTransaction(this.db, ModuleRole.identity, async (ctx) => {
      const { rows } = await sql<{ principal_id: string }>`
        SELECT pp.principal_id FROM identity.person_principal pp
        JOIN identity.account_person_control apc ON apc.person_id = pp.person_id
        WHERE apc.account_id = ${input.granteeAccountId} AND apc.control_kind = 'SELF'`.execute(
        ctx.trx,
      );
      return rows.map((r) => r.principal_id as Uuid);
    });
    const scope = competitionResultScope(input.competitionId);
    const store = new AuthorityStore(this.db);
    const revokedGrantIds: Uuid[] = [];
    for (const principalId of principals) {
      for (const { id: grantId } of await this.activeGrants(platformId, principalId, scope)) {
        await store.revokeGrant({
          grantId,
          actorPrincipalId: platformId,
          reason: `${reason} [governance:${ref}]`,
        });
        revokedGrantIds.push(grantId);
      }
    }
    await this.audit('authority.result-grant.revoked', 'SUCCEEDED', input.competitionId, {
      granteeAccountId: input.granteeAccountId,
      platformPrincipalId: platformId,
      revokedGrantIds,
      governanceDecisionRef: ref,
    });
    return { revokedGrantIds };
  }

  /** Every ADR-0077 grant of the competition with its current status, for audit. Ids only. */
  async listCompetitionResultAuthority(competitionId: string): Promise<ResultAuthorityGrantView[]> {
    const scope = competitionResultScope(competitionId);
    return inTransaction(this.db, ModuleRole.authority, async (ctx) => {
      const { rows } = await sql<{
        id: string;
        grantor_principal_id: string;
        grantee_principal_id: string;
        capabilities: string[];
        effective_from: Date;
        effective_to: Date | null;
        recorded_at: Date;
        revoked: boolean;
      }>`
        SELECT g.id, g.grantor_principal_id, g.grantee_principal_id, g.capabilities, g.effective_from,
               g.effective_to, g.recorded_at,
               EXISTS (SELECT 1 FROM authority.authority_grant_status_change s
                       WHERE s.grant_id = g.id AND s.effective_from <= ${ctx.txTime}) AS revoked
        FROM authority.authority_grant g JOIN authority.principal p ON p.id = g.grantor_principal_id
        WHERE p.principal_type = 'PLATFORM' AND g.parent_grant_id IS NULL
          AND g.scope = ${JSON.stringify(scope)}::jsonb
        ORDER BY g.recorded_at, g.id`.execute(ctx.trx);
      const now = ctx.txTime.getTime();
      return rows.map((r) => ({
        grantId: r.id as Uuid,
        granteePrincipalId: r.grantee_principal_id as Uuid,
        grantorPrincipalId: r.grantor_principal_id as Uuid,
        capabilities: r.capabilities,
        effectiveFrom: r.effective_from,
        effectiveTo: r.effective_to,
        recordedAt: r.recorded_at,
        status: r.revoked
          ? 'REVOKED'
          : r.effective_to !== null && r.effective_to.getTime() <= now
            ? 'EXPIRED'
            : r.effective_from.getTime() > now
              ? 'SCHEDULED'
              : 'ACTIVE',
      }));
    });
  }

  private async platformPrincipal(id: string): Promise<Uuid> {
    return inTransaction(this.db, ModuleRole.authority, async (ctx) => {
      const { rows } = await sql<{ principal_type: string }>`
        SELECT principal_type FROM authority.principal WHERE id = ${id}::uuid`.execute(ctx.trx);
      if (rows[0]?.principal_type !== 'PLATFORM')
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'platform principal not found', {
          reason: 'NOT_A_PLATFORM_PRINCIPAL',
        });
      return id as Uuid;
    });
  }

  /** Active (not revoked, not expired, in effect) PLATFORM grants of exactly this scope and these capabilities, oldest first. */
  private activeGrants(
    platformId: Uuid,
    granteePrincipalId: Uuid,
    scope: AuthorityScope,
  ): Promise<{ id: Uuid; recordedAt: Date }[]> {
    return inTransaction(this.db, ModuleRole.authority, async (ctx) => {
      const { rows } = await sql<{ id: string; recorded_at: Date }>`
        SELECT g.id, g.recorded_at FROM authority.authority_grant g
        WHERE g.grantor_principal_id = ${platformId} AND g.grantee_principal_id = ${granteePrincipalId}
          AND g.parent_grant_id IS NULL
          AND g.scope = ${JSON.stringify(scope)}::jsonb
          AND g.capabilities @> ${sql.val([...RESULT_AUTHORITY_CAPABILITIES])}::text[]
          AND g.effective_from <= ${ctx.txTime}
          AND (g.effective_to IS NULL OR g.effective_to > ${ctx.txTime})
          AND NOT EXISTS (SELECT 1 FROM authority.authority_grant_status_change s
                          WHERE s.grant_id = g.id AND s.effective_from <= ${ctx.txTime})
        ORDER BY g.recorded_at, g.id`.execute(ctx.trx);
      return rows.map((r) => ({ id: r.id as Uuid, recordedAt: r.recorded_at }));
    });
  }

  private audit(
    action: string,
    outcome: 'SUCCEEDED' | 'DENIED',
    competitionId: string | undefined,
    details: Record<string, string | readonly string[]>,
  ): Promise<void> {
    return inTransaction(this.db, ModuleRole.authority, (ctx) =>
      recordAudit(ctx, {
        action,
        targetType: competitionId === undefined ? 'TRUST_ANCHOR' : 'COMPETITION',
        ...(competitionId === undefined ? {} : { targetId: competitionId }),
        outcome,
        details,
      }),
    );
  }
}
