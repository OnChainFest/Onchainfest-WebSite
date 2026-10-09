import { sql } from 'kysely';
import type { Db } from './db';
import { resolveResultVersion, resultVersionPath } from './evidence-support';
import { inTransaction, ModuleRole, type TxContext } from './tx';

/**
 * BRT-06 read models (class B). Maintained incrementally by the evidence/attestation command
 * transactions (br_evidence) and fully rebuildable by the maintenance login (br_rebuild) with the
 * SAME functions — from metadata only: rebuilding never touches evidence bytes, the blob store or
 * the evidence cipher (none of which the database can reach).
 */
export async function refreshEvidenceState(ctx: TxContext, evidenceId: string): Promise<void> {
  await sql`DELETE FROM evidence_read.evidence_state WHERE evidence_id = ${evidenceId}`.execute(
    ctx.trx,
  );
  await sql`
    INSERT INTO evidence_read.evidence_state (evidence_id, availability, availability_since, privacy_class, attachment_count)
    SELECT i.id, a.status, a.recorded_at, p.privacy_class,
           (SELECT count(*)::int FROM evidence.attachment t WHERE t.evidence_id = i.id)
    FROM evidence.item i
    JOIN evidence.v_availability_current a ON a.evidence_id = i.id
    JOIN evidence.v_privacy_current p ON p.evidence_id = i.id
    WHERE i.id = ${evidenceId}`.execute(ctx.trx);
}

export async function refreshAttestationCard(ctx: TxContext, attestationId: string): Promise<void> {
  const { rows } = await sql<{
    id: string;
    visibility: string;
    subject_type: string;
    subject_id: string;
    issuer_principal_type: string;
    issuer_organization_id: string | null;
    claim_type: string;
    polarity: string;
    proof_type: string;
    proof_scheme: string;
    issued_at: Date;
    supersedes_attestation_id: string | null;
    evidence_count: number;
    evidence_available_count: number;
    superseded: boolean;
    retraction_reason: string | null;
    retracted_at: Date | null;
  }>`
    SELECT a.id, a.visibility, a.subject_type, a.subject_id, a.issuer_principal_type,
           op.organization_id AS issuer_organization_id, a.claim_type, a.polarity, a.proof_type,
           a.proof_scheme, a.issued_at, a.supersedes_attestation_id,
           (SELECT count(*)::int FROM attestation.attestation_evidence e WHERE e.attestation_id = a.id) AS evidence_count,
           (SELECT count(*)::int FROM attestation.attestation_evidence e
              JOIN evidence.v_availability_current v ON v.evidence_id = e.evidence_id
              WHERE e.attestation_id = a.id AND v.status = 'AVAILABLE') AS evidence_available_count,
           EXISTS (SELECT 1 FROM attestation.attestation s WHERE s.supersedes_attestation_id = a.id) AS superseded,
           r.reason_code AS retraction_reason, r.issued_at AS retracted_at
    FROM attestation.attestation a
    LEFT JOIN organizations.organization_principal op ON op.principal_id = a.issuer_principal_id
    LEFT JOIN attestation.retraction r ON r.attestation_id = a.id
    WHERE a.id = ${attestationId}`.execute(ctx.trx);
  const a = rows[0];
  await sql`DELETE FROM evidence_read.attestation_card WHERE attestation_id = ${attestationId}`.execute(
    ctx.trx,
  );
  if (a === undefined) return;
  const rv = await resolveResultVersion(ctx, a.subject_id);
  if (rv === undefined) return;
  const path = await resultVersionPath(ctx, rv);
  await sql`
    INSERT INTO evidence_read.attestation_card (attestation_id, visibility, subject_type, subject_id, result_id,
      competition_id, event_id, contest_id, issuer_principal_type, issuer_organization_id, claim_type, polarity,
      proof_type, proof_scheme, evidence_count, evidence_available_count, issued_at, supersedes_attestation_id,
      superseded, retracted, retraction_reason, retracted_at)
    VALUES (${a.id}, ${a.visibility}, ${a.subject_type}, ${a.subject_id}, ${rv.resultId},
      ${path?.competitionId ?? null}, ${path?.eventId ?? null}, ${path?.contestId ?? null},
      ${a.issuer_principal_type}, ${a.issuer_organization_id}, ${a.claim_type}, ${a.polarity},
      ${a.proof_type}, ${a.proof_scheme}, ${a.evidence_count}, ${a.evidence_available_count}, ${a.issued_at},
      ${a.supersedes_attestation_id}, ${a.superseded}, ${a.retracted_at !== null}, ${a.retraction_reason},
      ${a.retracted_at})`.execute(ctx.trx);
}

/** Cards whose evidence availability summary depends on this item. */
export async function refreshCardsCitingEvidence(
  ctx: TxContext,
  evidenceId: string,
): Promise<void> {
  const { rows } = await sql<{ attestation_id: string }>`
    SELECT DISTINCT attestation_id FROM attestation.attestation_evidence WHERE evidence_id = ${evidenceId}
    ORDER BY attestation_id`.execute(ctx.trx);
  for (const r of rows) await refreshAttestationCard(ctx, r.attestation_id);
}

/** Full rebuild through the maintenance login (br_rebuild). Idempotent. */
export async function rebuildEvidenceReadModels(
  maintenanceDb: Db,
): Promise<{ evidence: number; attestations: number }> {
  return inTransaction(maintenanceDb, ModuleRole.rebuild, async (ctx) => {
    await sql`TRUNCATE evidence_read.evidence_state, evidence_read.attestation_card`.execute(
      ctx.trx,
    );
    const { rows: items } = await sql<{
      id: string;
    }>`SELECT id FROM evidence.item ORDER BY id`.execute(ctx.trx);
    for (const i of items) await refreshEvidenceState(ctx, i.id);
    const { rows: atts } = await sql<{
      id: string;
    }>`SELECT id FROM attestation.attestation ORDER BY id`.execute(ctx.trx);
    for (const a of atts) await refreshAttestationCard(ctx, a.id);
    return { evidence: items.length, attestations: atts.length };
  });
}

/** Deterministic snapshot of both read models (for incremental-vs-rebuild comparisons). */
export async function snapshotEvidenceReadModels(db: Db): Promise<unknown> {
  return inTransaction(db, ModuleRole.evidence, async (ctx) => ({
    evidenceState: (
      await sql`SELECT * FROM evidence_read.evidence_state ORDER BY evidence_id`.execute(ctx.trx)
    ).rows,
    attestationCards: (
      await sql`SELECT * FROM evidence_read.attestation_card ORDER BY attestation_id`.execute(
        ctx.trx,
      )
    ).rows,
  }));
}
