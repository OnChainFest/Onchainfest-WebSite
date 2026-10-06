import { createHash, randomBytes } from 'node:crypto';
import { DomainError, DomainErrorCode, newId, type Uuid } from '@br/domain';
import {
  canAssignRole,
  hasControlCharacters,
  MembershipRole,
  normalizeSlug,
  OrganizationType,
  permissionsForRoles,
  type MembershipVisibility,
  type OrgPermission,
} from '@br/identity';
import { SchemaRef } from '@br/schemas';
import { sql } from 'kysely';
import type { Db } from './db';
import { factHash } from './hashing';
import {
  activeOrgRoles,
  assertPersonOperation,
  identityIdempotency,
  loadControlFacts,
  lockKeys,
  recordAudit,
} from './identity-support';
import { emitEvent } from './outbox';
import { refreshAffiliationsForOrganization, refreshAffiliationsForPerson } from './passport-store';
import { inTransaction, ModuleRole, type TxContext } from './tx';

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface OrganizationProfileInput {
  readonly displayName: string;
  readonly description?: string | null;
  readonly website?: string | null;
  readonly country?: string | null;
  readonly region?: string | null;
  readonly publicContact?: string | null;
}

/** Invitation secrets: 256-bit random, shown once; only `sha256:<hex>` is stored. */
export function hashInvitationToken(token: string): string {
  return `sha256:${createHash('sha256').update(`br-invitation:${token}`).digest('hex')}`;
}

function slugOrThrow(input: string): string {
  const r = normalizeSlug(input);
  if (!r.ok)
    throw new DomainError(
      DomainErrorCode.SLUG_INVALID,
      r.reason === 'RESERVED' ? 'slug is reserved' : 'slug is invalid',
    );
  return r.slug;
}

function validateProfile(
  p: Partial<OrganizationProfileInput>,
  requireName: boolean,
): Partial<OrganizationProfileInput> {
  const bad = (what: string) =>
    new DomainError(DomainErrorCode.INVALID_INPUT, `${what} is invalid`);
  const text = (v: string, max: number, what: string) => {
    const t = v.normalize('NFC').trim();
    if (t.length === 0 || t.length > max || hasControlCharacters(t, { allowNewline: true }))
      throw bad(what);
    return t;
  };
  const out: { -readonly [K in keyof OrganizationProfileInput]?: OrganizationProfileInput[K] } = {};
  if (p.displayName !== undefined) out.displayName = text(p.displayName, 120, 'displayName');
  else if (requireName)
    throw new DomainError(DomainErrorCode.INVALID_INPUT, 'displayName is required');
  if (p.description !== undefined)
    out.description = p.description === null ? null : text(p.description, 2000, 'description');
  if (p.website !== undefined) {
    if (p.website !== null && !/^https:\/\/[^\s<>"]{3,250}$/.test(p.website)) throw bad('website');
    out.website = p.website;
  }
  if (p.country !== undefined) {
    if (p.country !== null && !/^[A-Z]{2}$/.test(p.country)) throw bad('country');
    out.country = p.country;
  }
  if (p.region !== undefined) {
    if (p.region !== null && !/^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(p.region)) throw bad('region');
    out.region = p.region;
  }
  if (p.publicContact !== undefined)
    out.publicContact =
      p.publicContact === null ? null : text(p.publicContact, 200, 'publicContact');
  return out;
}

async function requirePermission(
  ctx: TxContext,
  accountId: string,
  organizationId: string,
  permission: OrgPermission,
): Promise<MembershipRole[]> {
  const roles = await activeOrgRoles(ctx, accountId, organizationId);
  if (!permissionsForRoles(roles).has(permission)) {
    await recordAudit(ctx, {
      actorAccountId: accountId,
      action: `org.${permission}`,
      targetType: 'ORGANIZATION',
      targetId: organizationId,
      outcome: 'DENIED',
    });
    throw new DomainError(DomainErrorCode.FORBIDDEN, 'not permitted');
  }
  return roles;
}

async function membershipStatus(ctx: TxContext, membershipId: string): Promise<string | undefined> {
  const { rows } = await sql<{
    status: string;
  }>`SELECT status FROM organizations.v_membership_current WHERE membership_id = ${membershipId}`.execute(
    ctx.trx,
  );
  return rows[0]?.status;
}

interface MembershipRow {
  id: string;
  organization_id: string;
  person_id: string;
  membership_role: MembershipRole;
  visibility: MembershipVisibility;
}

async function loadMembership(ctx: TxContext, membershipId: string): Promise<MembershipRow> {
  const { rows } = await sql<MembershipRow>`
    SELECT id, organization_id, person_id, membership_role, visibility FROM organizations.membership WHERE id = ${membershipId}`.execute(
    ctx.trx,
  );
  if (rows[0] === undefined)
    throw new DomainError(DomainErrorCode.NOT_FOUND, 'membership not found');
  return rows[0];
}

/** Current ACTIVE owners (used to keep at least one OWNER). */
async function activeOwnerCount(ctx: TxContext, organizationId: string): Promise<number> {
  const { rows } = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM organizations.membership m JOIN organizations.v_membership_current c ON c.membership_id = m.id
    WHERE m.organization_id = ${organizationId} AND m.membership_role = 'OWNER' AND c.status = 'ACTIVE'`.execute(
    ctx.trx,
  );
  return rows[0]?.n ?? 0;
}

/**
 * Organizations context (br_organizations). Membership roles grant APPLICATION permissions only;
 * no command here grants, implies or reads a BRT domain capability.
 */
export class OrganizationStore {
  private readonly db: Db;
  private readonly invitationTtlMs: number;

  constructor(db: Db, options: { invitationTtlMs?: number } = {}) {
    this.db = db;
    this.invitationTtlMs = options.invitationTtlMs ?? INVITATION_TTL_MS;
  }

  private tx<T>(fn: (ctx: TxContext) => Promise<T>): Promise<T> {
    return inTransaction(this.db, ModuleRole.organizations, fn);
  }

  /**
   * Creates the organization, its (separate) ORGANIZATION principal and mapping, public profile,
   * slug and the creator's OWNER membership — atomically. The principal holds no grants: creating
   * an organization confers no sports authority.
   */
  async createOrganization(input: {
    actorAccountId: string;
    orgType: OrganizationType;
    slug: string;
    profile: OrganizationProfileInput;
    idempotencyKey: string;
  }): Promise<{ organizationId: string; principalId: string; slug: string; created: boolean }> {
    if (!Object.values(OrganizationType).includes(input.orgType))
      throw new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid organization type');
    const slug = slugOrThrow(input.slug);
    const profile = validateProfile(input.profile, true);
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{
        organizationId: string;
        principalId: string;
        slug: string;
      }>(ctx, {
        command: 'CreateOrganization',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { orgType: input.orgType, slug, profile },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      const facts = await loadControlFacts(ctx, input.actorAccountId);
      if (!facts.accountActive || facts.selfPersonId === undefined)
        throw new DomainError(DomainErrorCode.FORBIDDEN, 'not permitted');
      await lockKeys(ctx, `org-slug:${slug}`);
      const { rows: taken } = await sql<{
        n: number;
      }>`SELECT count(*)::int AS n FROM organizations.organization_slug WHERE slug = ${slug}`.execute(
        ctx.trx,
      );
      if ((taken[0]?.n ?? 0) > 0)
        throw new DomainError(DomainErrorCode.SLUG_TAKEN, 'slug is not available');

      const organizationId = newId();
      const principalId = newId();
      const label = `organization:${organizationId}`;
      const principalHash = factHash(SchemaRef.principal, {
        principalId,
        principalType: 'ORGANIZATION',
        label,
      });
      await sql`INSERT INTO organizations.organization (id, org_type, created_by_account_id, recorded_at)
        VALUES (${organizationId}, ${input.orgType}, ${input.actorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await sql`INSERT INTO organizations.organization_status_change (id, organization_id, status, actor_account_id, recorded_at)
        VALUES (${newId()}, ${organizationId}, 'ACTIVE', ${input.actorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await sql`INSERT INTO authority.principal (id, principal_type, label, fact_hash, recorded_at)
        VALUES (${principalId}, 'ORGANIZATION', ${label}, ${principalHash}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await sql`INSERT INTO organizations.organization_principal (organization_id, principal_id, recorded_at)
        VALUES (${organizationId}, ${principalId}, ${ctx.txTime})`.execute(ctx.trx);
      await sql`INSERT INTO organizations.organization_profile (organization_id, display_name, description, website, country, region, public_contact, updated_at, updated_by_account_id)
        VALUES (${organizationId}, ${profile.displayName ?? ''}, ${profile.description ?? null}, ${profile.website ?? null}, ${profile.country ?? null},
                ${profile.region ?? null}, ${profile.publicContact ?? null}, ${ctx.txTime}, ${input.actorAccountId})`.execute(
        ctx.trx,
      );
      await sql`INSERT INTO organizations.organization_slug (slug, organization_id, recorded_at) VALUES (${slug}, ${organizationId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      const membershipId = newId();
      await sql`INSERT INTO organizations.membership (id, organization_id, person_id, membership_role, visibility, invited_by_account_id, effective_from, recorded_at)
        VALUES (${membershipId}, ${organizationId}, ${facts.selfPersonId}, 'OWNER', 'MEMBERS', NULL, ${ctx.txTime}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await sql`INSERT INTO organizations.membership_status_change (id, membership_id, status, actor_account_id, recorded_at)
        VALUES (${newId()}, ${membershipId}, 'ACTIVE', ${input.actorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );

      await emitEvent(ctx, {
        eventType: 'PrincipalRegistered',
        aggregateType: 'PRINCIPAL',
        aggregateId: principalId as Uuid,
        payload: { principalType: 'ORGANIZATION', factHash: principalHash },
      });
      await emitEvent(ctx, {
        eventType: 'OrganizationCreated',
        aggregateType: 'ORGANIZATION',
        aggregateId: organizationId as Uuid,
        payload: { orgType: input.orgType, principalId, slug },
      });
      await emitEvent(ctx, {
        eventType: 'MembershipActivated',
        aggregateType: 'MEMBERSHIP',
        aggregateId: membershipId as Uuid,
        payload: { organizationId, role: 'OWNER' },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'organization.created',
        targetType: 'ORGANIZATION',
        targetId: organizationId,
      });
      const response = { organizationId, principalId, slug };
      await idem.record(response);
      return { ...response, created: true };
    });
  }

  async updateProfile(input: {
    actorAccountId: string;
    organizationId: string;
    patch: Partial<OrganizationProfileInput>;
  }): Promise<void> {
    const patch = validateProfile(input.patch, false);
    return this.tx(async (ctx) => {
      await requirePermission(ctx, input.actorAccountId, input.organizationId, 'ORG_EDIT_PROFILE');
      const set = (key: keyof OrganizationProfileInput, col: string) =>
        patch[key] === undefined ? sql.ref(col) : sql`${patch[key] ?? null}`;
      await sql`UPDATE organizations.organization_profile SET
          display_name = ${set('displayName', 'display_name')}, description = ${set('description', 'description')},
          website = ${set('website', 'website')}, country = ${set('country', 'country')}, region = ${set('region', 'region')},
          public_contact = ${set('publicContact', 'public_contact')}, updated_at = ${ctx.txTime}, updated_by_account_id = ${input.actorAccountId}
        WHERE organization_id = ${input.organizationId}`.execute(ctx.trx);
      await emitEvent(ctx, {
        eventType: 'OrganizationProfileUpdated',
        aggregateType: 'ORGANIZATION',
        aggregateId: input.organizationId as Uuid,
        payload: { fields: Object.keys(patch) },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'organization.profile-updated',
        targetType: 'ORGANIZATION',
        targetId: input.organizationId,
        details: { fields: Object.keys(patch) },
      });
    });
  }

  async changeSlug(input: {
    actorAccountId: string;
    organizationId: string;
    slug: string;
  }): Promise<{ slug: string }> {
    const slug = slugOrThrow(input.slug);
    return this.tx(async (ctx) => {
      await requirePermission(ctx, input.actorAccountId, input.organizationId, 'ORG_EDIT_PROFILE');
      await lockKeys(ctx, `org-slug:${slug}`);
      const { rows } = await sql<{
        n: number;
      }>`SELECT count(*)::int AS n FROM organizations.organization_slug WHERE slug = ${slug}`.execute(
        ctx.trx,
      );
      if ((rows[0]?.n ?? 0) > 0)
        throw new DomainError(DomainErrorCode.SLUG_TAKEN, 'slug is not available');
      await sql`INSERT INTO organizations.organization_slug (slug, organization_id, recorded_at) VALUES (${slug}, ${input.organizationId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'organization.slug-changed',
        targetType: 'ORGANIZATION',
        targetId: input.organizationId,
      });
      return { slug };
    });
  }

  /** INTERNAL: organization lifecycle (ACTIVE/SUSPENDED/CLOSED). Never removes the principal mapping. */
  setStatus(input: {
    operatorAccountId: string;
    organizationId: string;
    status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
    reason: string;
  }): Promise<void> {
    return this.tx(async (ctx) => {
      await lockKeys(ctx, `org:${input.organizationId}`);
      const { rows } = await sql<{
        status: string;
      }>`SELECT status FROM organizations.v_organization_current WHERE organization_id = ${input.organizationId}`.execute(
        ctx.trx,
      );
      const current = rows[0]?.status;
      if (current === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'organization not found');
      if (current === 'CLOSED' || current === input.status)
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          `cannot move a ${current} organization to ${input.status}`,
        );
      await sql`INSERT INTO organizations.organization_status_change (id, organization_id, status, reason, actor_account_id, recorded_at)
        VALUES (${newId()}, ${input.organizationId}, ${input.status}, ${input.reason}, ${input.operatorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await refreshAffiliationsForOrganization(ctx, input.organizationId);
      await recordAudit(ctx, {
        actorAccountId: input.operatorAccountId,
        action: `organization.${input.status.toLowerCase()}`,
        targetType: 'ORGANIZATION',
        targetId: input.organizationId,
      });
    });
  }

  // ───────────────────────────── memberships & invitations ─────────────────────────────

  /**
   * Invites a person. Returns the raw token exactly once; an idempotent replay returns the same
   * invitation without the token (it cannot be recovered — only its hash is stored).
   */
  async invite(input: {
    actorAccountId: string;
    organizationId: string;
    personId: string;
    role: MembershipRole;
    visibility: MembershipVisibility;
    idempotencyKey: string;
  }): Promise<{
    membershipId: string;
    invitationId: string;
    expiresAt: Date;
    token: string | null;
  }> {
    if (!Object.values(MembershipRole).includes(input.role))
      throw new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid role');
    if (!['PUBLIC', 'MEMBERS', 'PRIVATE'].includes(input.visibility))
      throw new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid visibility');
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{
        membershipId: string;
        invitationId: string;
        expiresAt: string;
      }>(ctx, {
        command: 'InviteMember',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: {
          organizationId: input.organizationId,
          personId: input.personId,
          role: input.role,
          visibility: input.visibility,
        },
      });
      if (idem.lookup.replay)
        return {
          ...idem.lookup.response,
          expiresAt: new Date(idem.lookup.response.expiresAt),
          token: null,
        };
      const roles = await requirePermission(
        ctx,
        input.actorAccountId,
        input.organizationId,
        'ORG_INVITE_MEMBER',
      );
      if (!canAssignRole(roles, input.role, 'INVITE'))
        throw new DomainError(DomainErrorCode.FORBIDDEN, 'not permitted');
      await lockKeys(ctx, `membership:${input.organizationId}:${input.personId}`);
      const { rows: open } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM organizations.membership m JOIN organizations.v_membership_current c ON c.membership_id = m.id
        WHERE m.organization_id = ${input.organizationId} AND m.person_id = ${input.personId} AND m.membership_role = ${input.role}
          AND c.status IN ('INVITED', 'ACTIVE', 'SUSPENDED')`.execute(ctx.trx);
      if ((open[0]?.n ?? 0) > 0)
        throw new DomainError(
          DomainErrorCode.ALREADY_EXISTS,
          'the person already has this role (or a pending invitation)',
        );
      const membershipId = newId();
      const invitationId = newId();
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(ctx.txTime.getTime() + this.invitationTtlMs);
      try {
        await sql`INSERT INTO organizations.membership (id, organization_id, person_id, membership_role, visibility, invited_by_account_id, effective_from, recorded_at)
          VALUES (${membershipId}, ${input.organizationId}, ${input.personId}, ${input.role}, ${input.visibility}, ${input.actorAccountId}, ${ctx.txTime}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
      } catch (err) {
        if ((err as { code?: string }).code === '23503')
          throw new DomainError(DomainErrorCode.NOT_FOUND, 'person not found');
        throw err;
      }
      await sql`INSERT INTO organizations.membership_status_change (id, membership_id, status, actor_account_id, recorded_at)
        VALUES (${newId()}, ${membershipId}, 'INVITED', ${input.actorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await sql`INSERT INTO organizations.invitation (id, membership_id, token_hash, expires_at, recorded_at)
        VALUES (${invitationId}, ${membershipId}, ${hashInvitationToken(token)}, ${expiresAt}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await emitEvent(ctx, {
        eventType: 'MembershipInvited',
        aggregateType: 'MEMBERSHIP',
        aggregateId: membershipId as Uuid,
        payload: { organizationId: input.organizationId, role: input.role },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'membership.invited',
        targetType: 'MEMBERSHIP',
        targetId: membershipId,
        details: { role: input.role },
      });
      await idem.record({ membershipId, invitationId, expiresAt: expiresAt.toISOString() });
      return { membershipId, invitationId, expiresAt, token };
    });
  }

  /** Accept/decline by token: the invitee (SELF) or their confirmed guardian. Single use; expiring. */
  async respondToInvitation(input: {
    actorAccountId: string;
    token: string;
    accept: boolean;
  }): Promise<{ membershipId: string; status: 'ACTIVE' | 'DECLINED' }> {
    const tokenHash = hashInvitationToken(input.token);
    return this.tx(async (ctx) => {
      await lockKeys(ctx, `invitation:${tokenHash}`);
      const { rows } = await sql<{ id: string; membership_id: string; expires_at: Date }>`
        SELECT id, membership_id, expires_at FROM organizations.invitation WHERE token_hash = ${tokenHash}`.execute(
        ctx.trx,
      );
      const inv = rows[0];
      // Unknown, used and expired tokens are indistinguishable to the caller.
      const invalid = () =>
        new DomainError(DomainErrorCode.INVITATION_INVALID, 'invitation is not valid');
      if (inv === undefined) throw invalid();
      const m = await loadMembership(ctx, inv.membership_id);
      await assertPersonOperation(ctx, input.actorAccountId, m.person_id, 'ACCEPT_MEMBERSHIP');
      const { rows: used } = await sql<{
        outcome: string;
      }>`SELECT outcome FROM organizations.invitation_consumption WHERE invitation_id = ${inv.id}`.execute(
        ctx.trx,
      );
      if (used[0] !== undefined) {
        // Same answer repeated → idempotent success; anything else → invalid.
        const status = used[0].outcome === 'ACCEPTED' ? 'ACTIVE' : 'DECLINED';
        if ((used[0].outcome === 'ACCEPTED') === input.accept)
          return { membershipId: m.id, status };
        throw invalid();
      }
      if (
        ctx.txTime.getTime() >= inv.expires_at.getTime() ||
        (await membershipStatus(ctx, m.id)) !== 'INVITED'
      )
        throw invalid();
      const { rows: org } = await sql<{
        status: string;
      }>`SELECT status FROM organizations.v_organization_current WHERE organization_id = ${m.organization_id}`.execute(
        ctx.trx,
      );
      if (org[0]?.status !== 'ACTIVE') throw invalid();
      const status = input.accept ? 'ACTIVE' : 'DECLINED';
      await sql`INSERT INTO organizations.invitation_consumption (invitation_id, outcome, recorded_at) VALUES (${inv.id}, ${input.accept ? 'ACCEPTED' : 'DECLINED'}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await sql`INSERT INTO organizations.membership_status_change (id, membership_id, status, actor_account_id, recorded_at)
        VALUES (${newId()}, ${m.id}, ${status}, ${input.actorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await refreshAffiliationsForPerson(ctx, m.person_id);
      await emitEvent(ctx, {
        eventType: input.accept ? 'MembershipActivated' : 'MembershipDeclined',
        aggregateType: 'MEMBERSHIP',
        aggregateId: m.id as Uuid,
        payload: { organizationId: m.organization_id, role: m.membership_role },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: `membership.${input.accept ? 'accepted' : 'declined'}`,
        targetType: 'MEMBERSHIP',
        targetId: m.id,
      });
      return { membershipId: m.id, status };
    });
  }

  /** Ends (member leaves / admin removes) or suspends/reactivates a membership. Keeps ≥ 1 OWNER. */
  setMembershipStatus(input: {
    actorAccountId: string;
    membershipId: string;
    status: 'ENDED' | 'SUSPENDED' | 'ACTIVE';
    reason?: string;
  }): Promise<void> {
    return this.tx(async (ctx) => {
      const m = await loadMembership(ctx, input.membershipId);
      await lockKeys(ctx, `org-roster:${m.organization_id}`);
      const current = await membershipStatus(ctx, m.id);
      const facts = await loadControlFacts(ctx, input.actorAccountId);
      const own =
        facts.accountActive &&
        (facts.selfPersonId === m.person_id ||
          facts.activeDependentPersonIds.includes(m.person_id));
      const selfLeaving = own && input.status === 'ENDED';
      if (!selfLeaving)
        await requirePermission(ctx, input.actorAccountId, m.organization_id, 'ORG_REMOVE_MEMBER');
      if (m.membership_role === 'OWNER' && !selfLeaving) {
        const roles = await activeOrgRoles(ctx, input.actorAccountId, m.organization_id);
        if (!roles.includes('OWNER'))
          throw new DomainError(DomainErrorCode.FORBIDDEN, 'not permitted');
      }
      const allowed: Record<string, string[]> = {
        ENDED: ['INVITED', 'ACTIVE', 'SUSPENDED'],
        SUSPENDED: ['ACTIVE'],
        ACTIVE: ['SUSPENDED'],
      };
      if (current === undefined || !allowed[input.status]?.includes(current)) {
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          `cannot move a ${current ?? 'missing'} membership to ${input.status}`,
        );
      }
      if (
        m.membership_role === 'OWNER' &&
        current === 'ACTIVE' &&
        input.status !== 'ACTIVE' &&
        (await activeOwnerCount(ctx, m.organization_id)) <= 1
      ) {
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          'an organization must keep at least one active owner',
        );
      }
      await sql`INSERT INTO organizations.membership_status_change (id, membership_id, status, actor_account_id, reason, recorded_at)
        VALUES (${newId()}, ${m.id}, ${input.status}, ${input.actorAccountId}, ${input.reason ?? null}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await refreshAffiliationsForPerson(ctx, m.person_id);
      if (input.status === 'ENDED') {
        await emitEvent(ctx, {
          eventType: 'MembershipEnded',
          aggregateType: 'MEMBERSHIP',
          aggregateId: m.id as Uuid,
          payload: { organizationId: m.organization_id },
        });
      }
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: `membership.${input.status.toLowerCase()}`,
        targetType: 'MEMBERSHIP',
        targetId: m.id,
      });
    });
  }

  /** A role change ends the membership and starts a new ACTIVE one (the history is preserved). */
  async changeRole(input: {
    actorAccountId: string;
    membershipId: string;
    role: MembershipRole;
    idempotencyKey: string;
  }): Promise<{ membershipId: string }> {
    if (!Object.values(MembershipRole).includes(input.role))
      throw new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid role');
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ membershipId: string }>(ctx, {
        command: 'ChangeMembershipRole',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { membershipId: input.membershipId, role: input.role },
      });
      if (idem.lookup.replay) return idem.lookup.response;
      const m = await loadMembership(ctx, input.membershipId);
      await lockKeys(ctx, `org-roster:${m.organization_id}`);
      const roles = await requirePermission(
        ctx,
        input.actorAccountId,
        m.organization_id,
        'ORG_MANAGE_ROLES',
      );
      if (
        !canAssignRole(roles, input.role, 'CHANGE') ||
        (m.membership_role === 'OWNER' && !roles.includes('OWNER'))
      ) {
        throw new DomainError(DomainErrorCode.FORBIDDEN, 'not permitted');
      }
      if ((await membershipStatus(ctx, m.id)) !== 'ACTIVE')
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          'only active memberships can change role',
        );
      if (m.membership_role === input.role)
        throw new DomainError(
          DomainErrorCode.INVALID_INPUT,
          'the membership already has this role',
        );
      if (m.membership_role === 'OWNER' && (await activeOwnerCount(ctx, m.organization_id)) <= 1) {
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          'an organization must keep at least one active owner',
        );
      }
      await sql`INSERT INTO organizations.membership_status_change (id, membership_id, status, actor_account_id, reason, recorded_at)
        VALUES (${newId()}, ${m.id}, 'ENDED', ${input.actorAccountId}, 'role changed', ${ctx.txTime})`.execute(
        ctx.trx,
      );
      const membershipId = newId();
      await sql`INSERT INTO organizations.membership (id, organization_id, person_id, membership_role, visibility, invited_by_account_id, effective_from, recorded_at)
        VALUES (${membershipId}, ${m.organization_id}, ${m.person_id}, ${input.role}, ${m.visibility}, ${input.actorAccountId}, ${ctx.txTime}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await sql`INSERT INTO organizations.membership_status_change (id, membership_id, status, actor_account_id, recorded_at)
        VALUES (${newId()}, ${membershipId}, 'ACTIVE', ${input.actorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await refreshAffiliationsForPerson(ctx, m.person_id);
      await emitEvent(ctx, {
        eventType: 'MembershipEnded',
        aggregateType: 'MEMBERSHIP',
        aggregateId: m.id as Uuid,
        payload: { organizationId: m.organization_id },
      });
      await emitEvent(ctx, {
        eventType: 'MembershipActivated',
        aggregateType: 'MEMBERSHIP',
        aggregateId: membershipId as Uuid,
        payload: { organizationId: m.organization_id, role: input.role },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'membership.role-changed',
        targetType: 'MEMBERSHIP',
        targetId: membershipId,
        details: { role: input.role },
      });
      await idem.record({ membershipId });
      return { membershipId };
    });
  }

  /** The caller's application permissions in an organization (ACTIVE memberships only). */
  permissions(
    accountId: string,
    organizationId: string,
  ): Promise<{ roles: MembershipRole[]; permissions: OrgPermission[] }> {
    return this.tx(async (ctx) => {
      const roles = await activeOrgRoles(ctx, accountId, organizationId);
      return { roles, permissions: [...permissionsForRoles(roles)].sort() };
    });
  }

  /**
   * Roster for members: active members see PUBLIC+MEMBERS entries; ORG_VIEW_PRIVATE sees all,
   * including pending invitations. Returns ids and roles only (no PII).
   */
  members(input: { actorAccountId: string; organizationId: string }) {
    return this.tx(async (ctx) => {
      const roles = await activeOrgRoles(ctx, input.actorAccountId, input.organizationId);
      if (roles.length === 0) throw new DomainError(DomainErrorCode.FORBIDDEN, 'not permitted');
      const full = permissionsForRoles(roles).has('ORG_VIEW_PRIVATE');
      const { rows } = await sql<{
        id: string;
        person_id: string;
        membership_role: MembershipRole;
        visibility: MembershipVisibility;
        status: string;
        since: Date;
      }>`
        SELECT m.id, m.person_id, m.membership_role, m.visibility, c.status, c.recorded_at AS since
        FROM organizations.membership m JOIN organizations.v_membership_current c ON c.membership_id = m.id
        WHERE m.organization_id = ${input.organizationId}
          AND (${full} OR (c.status = 'ACTIVE' AND m.visibility IN ('PUBLIC', 'MEMBERS')))
        ORDER BY c.recorded_at, m.id`.execute(ctx.trx);
      return rows.map((r) => ({
        membershipId: r.id,
        personId: r.person_id,
        role: r.membership_role,
        visibility: r.visibility,
        status: r.status,
        since: r.since.toISOString(),
      }));
    });
  }

  /**
   * ONCF-01: the caller's own ACTIVE memberships in ACTIVE organizations (onboarding state and the
   * signed-in navigation). Scoped to the account's SELF person; dependants' memberships are not
   * included. Ids, role, slug, type and public display name only (no PII).
   */
  myOrganizations(accountId: string) {
    return this.tx(async (ctx) => {
      const facts = await loadControlFacts(ctx, accountId);
      if (!facts.accountActive || facts.selfPersonId === undefined) return [];
      const { rows } = await sql<{
        membership_id: string;
        organization_id: string;
        membership_role: MembershipRole;
        org_type: string;
        slug: string;
        display_name: string;
      }>`
        SELECT m.id AS membership_id, m.organization_id, m.membership_role, o.org_type, s.slug, p.display_name
        FROM organizations.membership m
        JOIN organizations.v_membership_current mc ON mc.membership_id = m.id AND mc.status = 'ACTIVE'
        JOIN organizations.organization o ON o.id = m.organization_id
        JOIN organizations.v_organization_current oc ON oc.organization_id = o.id AND oc.status = 'ACTIVE'
        JOIN organizations.v_organization_slug_current s ON s.organization_id = o.id
        JOIN organizations.organization_profile p ON p.organization_id = o.id
        WHERE m.person_id = ${facts.selfPersonId}
        ORDER BY m.recorded_at, m.id`.execute(ctx.trx);
      return rows.map((r) => ({
        membershipId: r.membership_id,
        organizationId: r.organization_id,
        role: r.membership_role,
        orgType: r.org_type,
        slug: r.slug,
        displayName: r.display_name,
      }));
    });
  }

  /** Organization id + principal id for internal callers (e.g. authority seeding). */
  principalOf(organizationId: string): Promise<string | undefined> {
    return this.tx(async (ctx) => {
      const { rows } = await sql<{
        principal_id: string;
      }>`SELECT principal_id FROM organizations.organization_principal WHERE organization_id = ${organizationId}`.execute(
        ctx.trx,
      );
      return rows[0]?.principal_id;
    });
  }
}

export interface PublicOrganization {
  readonly organizationId: string;
  readonly slug: string;
  readonly orgType: OrganizationType;
  readonly status: 'ACTIVE' | 'SUSPENDED';
  readonly profile: {
    readonly displayName: string;
    readonly description: string | null;
    readonly website: string | null;
    readonly country: string | null;
    readonly region: string | null;
    readonly publicContact: string | null;
  };
}

/** Public read path (br_public_read): profile/slug/status only. CLOSED organizations are not served. */
export class OrganizationReader {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  bySlug(
    slug: string,
  ): Promise<
    { organization: PublicOrganization; currentSlug: string; redirected: boolean } | undefined
  > {
    const n = normalizeSlug(slug);
    if (!n.ok) return Promise.resolve(undefined);
    return inTransaction(this.db, ModuleRole.publicRead, async (ctx) => {
      const { rows } = await sql<{
        organization_id: string;
        org_type: OrganizationType;
        status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
        current_slug: string;
        display_name: string;
        description: string | null;
        website: string | null;
        country: string | null;
        region: string | null;
        public_contact: string | null;
      }>`
        SELECT o.id AS organization_id, o.org_type, st.status, cur.slug AS current_slug,
               p.display_name, p.description, p.website, p.country, p.region, p.public_contact
        FROM organizations.organization_slug s
        JOIN organizations.organization o ON o.id = s.organization_id
        JOIN organizations.v_organization_current st ON st.organization_id = o.id
        JOIN organizations.v_organization_slug_current cur ON cur.organization_id = o.id
        JOIN organizations.organization_profile p ON p.organization_id = o.id
        WHERE s.slug = ${n.slug}`.execute(ctx.trx);
      const r = rows[0];
      if (r === undefined || r.status === 'CLOSED') return undefined;
      return {
        organization: {
          organizationId: r.organization_id,
          slug: r.current_slug,
          orgType: r.org_type,
          status: r.status,
          profile: {
            displayName: r.display_name,
            description: r.description,
            website: r.website,
            country: r.country,
            region: r.region,
            publicContact: r.public_contact,
          },
        },
        currentSlug: r.current_slug,
        redirected: r.current_slug !== n.slug,
      };
    });
  }
}
