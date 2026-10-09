import { createHash } from 'node:crypto';
import { DomainError, DomainErrorCode, newId } from '@br/domain';
import {
  canOperateOnPerson,
  controlBasis,
  permissionsForRoles,
  type MembershipRole,
  type OrgPermission,
  type PersonControlFacts,
  type PersonOperation,
} from '@br/identity';
import { SchemaRef } from '@br/schemas';
import { sql } from 'kysely';
import { checkIdempotency, recordIdempotency, type IdempotencySpec } from './idempotency';
import type { TxContext } from './tx';

/** Serializes concurrent commands on the same logical keys (sorted to avoid deadlocks). */
export async function lockKeys(ctx: TxContext, ...keys: string[]): Promise<void> {
  for (const key of [...new Set(keys)].sort()) {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(ctx.trx);
  }
}

/** Accountability telemetry (never sporting truth). `details` must never contain PII. */
export async function recordAudit(
  ctx: TxContext,
  entry: {
    actorAccountId?: string | undefined;
    action: string;
    targetType: string;
    targetId?: string | undefined;
    outcome?: 'SUCCEEDED' | 'DENIED' | 'FAILED';
    details?: Record<string, string | number | boolean | readonly string[]>;
  },
): Promise<void> {
  await sql`INSERT INTO platform.audit_event (id, actor_account_id, action, target_type, target_id, outcome, details, recorded_at)
    VALUES (${newId()}, ${entry.actorAccountId ?? null}, ${entry.action}, ${entry.targetType}, ${entry.targetId ?? null},
            ${entry.outcome ?? 'SUCCEEDED'}, ${JSON.stringify(entry.details ?? {})}, ${ctx.txTime})`.execute(
    ctx.trx,
  );
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, stable((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** Internal command-parameter digest (not a protocol hash). Callers must not pass raw PII. */
export function payloadDigest(params: unknown): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(stable(params)))
    .digest('hex')}`;
}

export interface IdentityCommand {
  readonly command: string;
  readonly actorAccountId: string;
  readonly idempotencyKey: string;
  readonly params: unknown;
}

/** BRT-03 idempotency for identity/organization commands (fingerprint = command, actor, digest). */
export async function identityIdempotency<R>(ctx: TxContext, cmd: IdentityCommand) {
  const spec: IdempotencySpec = {
    scope: cmd.actorAccountId,
    key: cmd.idempotencyKey,
    commandType: cmd.command,
    requestSchema: SchemaRef.cmdIdentity,
    request: {
      command: cmd.command,
      actorAccountId: cmd.actorAccountId,
      payloadDigest: payloadDigest(cmd.params),
    },
  };
  const lookup = await checkIdempotency<R>(ctx, spec);
  return {
    lookup,
    record: (response: R) =>
      lookup.replay
        ? Promise.resolve()
        : recordIdempotency(ctx, spec, lookup.requestHash, response),
  };
}

/** Loads who an account controls: SELF person + ACTIVE (confirmed) guardian dependents. */
export async function loadControlFacts(
  ctx: TxContext,
  accountId: string,
): Promise<PersonControlFacts> {
  const { rows: status } = await sql<{ status: string }>`
    SELECT status FROM identity.v_account_current WHERE account_id = ${accountId}`.execute(ctx.trx);
  const { rows: self } = await sql<{ person_id: string }>`
    SELECT person_id FROM identity.account_person_control WHERE account_id = ${accountId} AND control_kind = 'SELF'`.execute(
    ctx.trx,
  );
  const selfPersonId = self[0]?.person_id;
  let dependents: string[] = [];
  if (selfPersonId !== undefined) {
    const { rows } = await sql<{ dependent_person_id: string }>`
      SELECT g.dependent_person_id FROM identity.guardian_relationship g
      JOIN identity.v_guardian_relationship_current c ON c.guardian_relationship_id = g.id
      WHERE g.guardian_person_id = ${selfPersonId} AND c.status = 'ACTIVE'`.execute(ctx.trx);
    dependents = rows.map((r) => r.dependent_person_id);
  }
  return {
    ...(selfPersonId === undefined ? {} : { selfPersonId }),
    activeDependentPersonIds: dependents,
    accountActive: status[0]?.status === 'ACTIVE',
  };
}

/**
 * Throws FORBIDDEN (no detail about why) unless the account may perform `op` on the person.
 * Actions taken through GUARDIAN control are audit-tagged "on behalf of" (BRT-02 §2.3).
 */
export async function assertPersonOperation(
  ctx: TxContext,
  accountId: string,
  personId: string,
  op: PersonOperation,
): Promise<PersonControlFacts> {
  const facts = await loadControlFacts(ctx, accountId);
  if (!canOperateOnPerson(facts, personId, op)) {
    throw new DomainError(DomainErrorCode.FORBIDDEN, 'not permitted');
  }
  if (controlBasis(facts, personId) === 'GUARDIAN') {
    await recordAudit(ctx, {
      actorAccountId: accountId,
      action: 'guardian.acted-on-behalf',
      targetType: 'PERSON',
      targetId: personId,
      details: { operation: op, onBehalfOfPersonId: personId },
    });
  }
  return facts;
}

/** Roles held by the account's SELF person in an organization (ACTIVE memberships only). */
export async function activeOrgRoles(
  ctx: TxContext,
  accountId: string,
  organizationId: string,
): Promise<MembershipRole[]> {
  const facts = await loadControlFacts(ctx, accountId);
  if (!facts.accountActive || facts.selfPersonId === undefined) return [];
  const { rows } = await sql<{ membership_role: MembershipRole }>`
    SELECT m.membership_role FROM organizations.membership m
    JOIN organizations.v_membership_current c ON c.membership_id = m.id
    JOIN organizations.v_organization_current o ON o.organization_id = m.organization_id
    WHERE m.organization_id = ${organizationId} AND m.person_id = ${facts.selfPersonId}
      AND c.status = 'ACTIVE' AND o.status = 'ACTIVE'`.execute(ctx.trx);
  return rows.map((r) => r.membership_role);
}

export async function hasOrgPermission(
  ctx: TxContext,
  accountId: string,
  organizationId: string,
  permission: OrgPermission,
): Promise<boolean> {
  return permissionsForRoles(await activeOrgRoles(ctx, accountId, organizationId)).has(permission);
}

export function pgConstraint(err: unknown): string | undefined {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' ? e.constraint : undefined;
}
