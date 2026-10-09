import { compPermissionsFor, type StaffRole } from '@br/competition';
import {
  DomainError,
  DomainErrorCode,
  type EvidenceAvailability,
  type EvidencePrivacyClass,
  type KeyStatusChange,
  type PrincipalKey,
  type Uuid,
} from '@br/domain';
import {
  decideEvidenceAccess,
  isIssuerRepresentation,
  type EvidenceAccessDecision,
  type EvidenceAccessFacts,
  type EvidencePurpose,
  type IssuerRepresentation,
} from '@br/evidence';
import { sql } from 'kysely';
import type { TxContext } from './tx';

/**
 * BRT-06 shared persistence helpers. Everything runs inside the caller's transaction so that the
 * access/representation decision and the effect it authorizes see the same facts.
 */

export const evidenceNotFound = () =>
  new DomainError(DomainErrorCode.NOT_FOUND, 'evidence not found');

/** Result of a command that must COMMIT a denial/rejection record before surfacing the error. */
export type Committed<T> = { readonly ok: T } | { readonly error: DomainError };

export function unwrap<T>(r: Committed<T>): T {
  if ('error' in r) throw r.error;
  return r.ok;
}

export interface ItemRow {
  readonly id: string;
  readonly descriptor: Record<string, unknown>;
  readonly descriptor_hash: string;
  readonly content_hash: string;
  readonly byte_length: number;
  readonly media_type: string;
  readonly evidence_type: string;
  readonly source_kind: string;
  readonly source_principal_id: string | null;
  readonly submitted_by_account_id: string | null;
  readonly captured_at: Date | null;
  readonly received_at: Date;
  readonly recorded_at: Date;
  readonly availability: EvidenceAvailability;
  readonly availability_since: Date;
  readonly privacy_class: EvidencePrivacyClass;
}

export async function loadItem(ctx: TxContext, evidenceId: string): Promise<ItemRow | undefined> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(evidenceId))
    return undefined;
  const { rows } = await sql<ItemRow>`
    SELECT i.id, i.descriptor, i.descriptor_hash, i.content_hash, i.byte_length::int AS byte_length, i.media_type,
           i.evidence_type, i.source_kind, i.source_principal_id, i.submitted_by_account_id, i.captured_at,
           i.received_at, i.recorded_at, a.status AS availability, a.recorded_at AS availability_since,
           p.privacy_class
    FROM evidence.item i
    JOIN evidence.v_availability_current a ON a.evidence_id = i.id
    JOIN evidence.v_privacy_current p ON p.evidence_id = i.id
    WHERE i.id = ${evidenceId}`.execute(ctx.trx);
  return rows[0];
}

export async function accountActive(ctx: TxContext, accountId: string): Promise<boolean> {
  const { rows } = await sql<{ status: string }>`
    SELECT status FROM identity.v_account_current WHERE account_id = ${accountId}`.execute(ctx.trx);
  return rows[0]?.status === 'ACTIVE';
}

/** DB-evaluated issuer representation (authority.account_principal_representation). */
export async function representation(
  ctx: TxContext,
  accountId: string,
  principalId: string,
): Promise<IssuerRepresentation | undefined> {
  const { rows } = await sql<{ r: string | null }>`
    SELECT authority.account_principal_representation(${accountId}::uuid, ${principalId}::uuid) AS r`.execute(
    ctx.trx,
  );
  const r = rows[0]?.r;
  return isIssuerRepresentation(r) ? r : undefined;
}

/** Application permissions (COMP_*) of an account on a competition — never capabilities. */
export async function competitionPermissionSet(
  ctx: TxContext,
  accountId: string,
  competitionId: string,
): Promise<ReadonlySet<string>> {
  const { rows } = await sql<{ roles: StaffRole[] }>`
    SELECT competition.account_competition_roles(${accountId}::uuid, ${competitionId}::uuid) AS roles`.execute(
    ctx.trx,
  );
  return compPermissionsFor(rows[0]?.roles ?? []);
}

export type EvidenceActor = { readonly accountId: string } | { readonly internal: true };

export async function attachedCompetitions(ctx: TxContext, evidenceId: string): Promise<string[]> {
  const { rows } = await sql<{ competition_id: string }>`
    SELECT DISTINCT competition_id FROM evidence.attachment WHERE evidence_id = ${evidenceId}
    ORDER BY competition_id`.execute(ctx.trx);
  return rows.map((r) => r.competition_id);
}

/** Loads the facts the central policy needs and decides. */
export async function evidenceAccess(
  ctx: TxContext,
  actor: EvidenceActor,
  item: ItemRow,
  purpose: EvidencePurpose,
): Promise<EvidenceAccessDecision> {
  const competitions = await attachedCompetitions(ctx, item.id);
  const evidence = {
    submittedByAccountId: item.submitted_by_account_id,
    privacyClass: item.privacy_class,
    attachedCompetitionIds: competitions,
  };
  if ('internal' in actor) {
    return decideEvidenceAccess({ evidence, actor: { kind: 'INTERNAL_SYSTEM' } }, purpose);
  }
  const active = await accountActive(ctx, actor.accountId);
  const permissions = new Map<string, ReadonlySet<string>>();
  for (const c of competitions)
    permissions.set(c, await competitionPermissionSet(ctx, actor.accountId, c));
  const facts: EvidenceAccessFacts = {
    evidence,
    actor: {
      kind: 'ACCOUNT',
      accountId: actor.accountId,
      accountActive: active,
      representsSource:
        active &&
        item.source_principal_id !== null &&
        (await representation(ctx, actor.accountId, item.source_principal_id)) !== undefined,
      competitionPermissions: permissions,
    },
  };
  return decideEvidenceAccess(facts, purpose);
}

// ───────────────────────────── result versions & hierarchy ─────────────────────────────

export interface ResolvedResultVersion {
  readonly resultVersionId: string;
  readonly resultId: string;
  readonly versionNumber: number;
  readonly contentHash: string;
  readonly contentSchema: string;
  readonly scopeType:
    'CONTEST' | 'ROUND_CLASSIFICATION' | 'EVENT_CLASSIFICATION' | 'COMPETITION_CLASSIFICATION';
  readonly scopeTargetId: string;
}

export interface ScopePath {
  readonly level: string;
  readonly competitionId?: string;
  readonly eventId?: string;
  readonly roundId?: string;
  readonly contestId?: string;
  readonly sport?: string;
  readonly discipline?: string;
  readonly region?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function resolveResultVersion(
  ctx: TxContext,
  id: string,
): Promise<ResolvedResultVersion | undefined> {
  if (!UUID.test(id)) return undefined;
  const { rows } = await sql<{ rv: ResolvedResultVersion | null }>`
    SELECT results.resolve_result_version(${id}::uuid) AS rv`.execute(ctx.trx);
  return rows[0]?.rv ?? undefined;
}

const LEVEL: Record<ResolvedResultVersion['scopeType'], string> = {
  CONTEST: 'CONTEST',
  ROUND_CLASSIFICATION: 'ROUND',
  EVENT_CLASSIFICATION: 'EVENT',
  COMPETITION_CLASSIFICATION: 'COMPETITION',
};

export async function scopePath(
  ctx: TxContext,
  level: string,
  id: string,
): Promise<ScopePath | undefined> {
  if (!UUID.test(id)) return undefined;
  const { rows } = await sql<{ path: ScopePath | null }>`
    SELECT competition.resolve_scope_path(${level}, ${id}::uuid) AS path`.execute(ctx.trx);
  return rows[0]?.path ?? undefined;
}

export async function resultVersionPath(
  ctx: TxContext,
  rv: ResolvedResultVersion,
): Promise<ScopePath | undefined> {
  return scopePath(ctx, LEVEL[rv.scopeType], rv.scopeTargetId);
}

// ───────────────────────────── keys ─────────────────────────────

export async function loadKeyFacts(
  ctx: TxContext,
  keyId: string,
): Promise<{ key?: PrincipalKey & { factHash: string }; statusChanges: KeyStatusChange[] }> {
  if (!UUID.test(keyId)) return { statusChanges: [] };
  const { rows } = await sql<{
    id: string;
    principal_id: string;
    key_kind: string;
    algorithm: string;
    verification_material: Record<string, string>;
    effective_from: Date;
    effective_to: Date | null;
    fact_hash: string;
    recorded_at: Date;
  }>`SELECT * FROM authority.principal_key WHERE id = ${keyId}`.execute(ctx.trx);
  const k = rows[0];
  const { rows: changes } = await sql<{
    id: string;
    key_id: string;
    kind: string;
    effective_from: Date;
    compromised_since: Date | null;
    reason: string;
    recorded_at: Date;
  }>`SELECT * FROM authority.principal_key_status_change WHERE key_id = ${keyId} ORDER BY recorded_at, id`.execute(
    ctx.trx,
  );
  return {
    ...(k === undefined
      ? {}
      : {
          key: {
            id: k.id as Uuid,
            principalId: k.principal_id as Uuid,
            keyKind: k.key_kind as PrincipalKey['keyKind'],
            algorithm: k.algorithm as PrincipalKey['algorithm'],
            verificationMaterial: k.verification_material,
            effectiveFrom: k.effective_from,
            ...(k.effective_to === null ? {} : { effectiveTo: k.effective_to }),
            recordedAt: k.recorded_at,
            factHash: k.fact_hash,
          },
        }),
    statusChanges: changes.map((c) =>
      c.kind === 'COMPROMISED'
        ? {
            id: c.id as Uuid,
            keyId: c.key_id as Uuid,
            kind: 'COMPROMISED' as const,
            compromisedSince: c.compromised_since as Date,
            recordedAt: c.recorded_at,
            reason: c.reason,
          }
        : {
            id: c.id as Uuid,
            keyId: c.key_id as Uuid,
            kind: c.kind as 'ROTATED' | 'REVOKED',
            effectiveFrom: c.effective_from,
            recordedAt: c.recorded_at,
            reason: c.reason,
          },
    ),
  };
}

export async function principalType(
  ctx: TxContext,
  principalId: string,
): Promise<string | undefined> {
  if (!UUID.test(principalId)) return undefined;
  const { rows } = await sql<{ principal_type: string }>`
    SELECT principal_type FROM authority.principal WHERE id = ${principalId}`.execute(ctx.trx);
  return rows[0]?.principal_type;
}
