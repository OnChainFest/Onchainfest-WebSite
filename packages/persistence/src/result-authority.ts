import {
  Capability,
  DomainError,
  DomainErrorCode,
  type AuthorityScope,
  type Instant,
  type Uuid,
} from '@br/domain';
import { sql } from 'kysely';
import { AuthorityStore, normalizeScope } from './authority-store';
import { competitionPermissions, loadCompetition } from './competition-support';
import {
  personParticipatesInCompetition,
  platformGrantorChecker,
} from './competition-participation';
import type { Db } from './db';
import { loadControlFacts, recordAudit } from './identity-support';
import { inTransaction, ModuleRole } from './tx';

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
    const held = await this.activeGrants(platformId, granteePrincipalId, scope);
    let grantId: Uuid;
    let created: boolean;
    if (held[0] !== undefined) {
      grantId = held[0];
      created = false;
    } else {
      const store = new AuthorityStore(this.db, {
        conflictChecker: platformGrantorChecker(platformId),
      });
      try {
        const out = await store.issueGrant({
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
        grantId = out.grant.id;
        created = out.created;
      } catch (err) {
        if (!(err instanceof DomainError) || err.code !== DomainErrorCode.IDEMPOTENCY_KEY_REUSED)
          throw err;
        // A concurrent run under the same decision won, or the decision was already spent on a
        // grant that has since been revoked: converge on the winner, or ask for a new decision.
        const now = await this.activeGrants(platformId, granteePrincipalId, scope);
        if (now[0] === undefined)
          throw new DomainError(
            DomainErrorCode.ALREADY_EXISTS,
            'this governance decision was already used for this grantee and competition; a new decision is required',
            { reason: 'GOVERNANCE_DECISION_USED' },
          );
        grantId = now[0];
        created = false;
      }
    }
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
      for (const grantId of await this.activeGrants(platformId, principalId, scope)) {
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

  /** Active (not revoked, not expired, in effect) PLATFORM grants of exactly this scope and these capabilities. */
  private activeGrants(
    platformId: Uuid,
    granteePrincipalId: Uuid,
    scope: AuthorityScope,
  ): Promise<Uuid[]> {
    return inTransaction(this.db, ModuleRole.authority, async (ctx) => {
      const { rows } = await sql<{ id: string }>`
        SELECT g.id FROM authority.authority_grant g
        WHERE g.grantor_principal_id = ${platformId} AND g.grantee_principal_id = ${granteePrincipalId}
          AND g.parent_grant_id IS NULL
          AND g.scope = ${JSON.stringify(scope)}::jsonb
          AND g.capabilities @> ${sql.val([...RESULT_AUTHORITY_CAPABILITIES])}::text[]
          AND g.effective_from <= ${ctx.txTime}
          AND (g.effective_to IS NULL OR g.effective_to > ${ctx.txTime})
          AND NOT EXISTS (SELECT 1 FROM authority.authority_grant_status_change s
                          WHERE s.grant_id = g.id AND s.effective_from <= ${ctx.txTime})
        ORDER BY g.recorded_at, g.id`.execute(ctx.trx);
      return rows.map((r) => r.id as Uuid);
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
