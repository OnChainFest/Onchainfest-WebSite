import {
  DomainError,
  DomainErrorCode,
  type EvidenceAvailability,
  type EvidencePrivacyClass,
} from '@br/domain';
import {
  buildEvidenceBundle,
  detachedJwsHash,
  type AttestationStatement,
  type BundleFacts,
  type EvidenceBundleResult,
} from '@br/evidence';
import { sql } from 'kysely';
import type { Db } from './db';
import {
  competitionPermissionSet,
  resolveResultVersion,
  resultVersionPath,
  type EvidenceActor,
} from './evidence-support';
import { keyMaterialHash } from './hashing';
import { recordAudit } from './identity-support';
import { inTransaction, ModuleRole, type TxContext } from './tx';

/**
 * BRT-06 → BRT-07 handoff: loads the immutable facts for one exact ResultVersion and builds the
 * deterministic Evidence Bundle (pure builder in @br/evidence). Reads metadata only — never bytes.
 * Access: application staff with COMP_VIEW_PRIVATE on the result's competition, or INTERNAL.
 * The bundle contains no verdict; building it changes nothing.
 */
export class EvidenceBundleService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  build(input: {
    readonly actor: EvidenceActor;
    readonly resultVersionId: string;
    /** Transaction-time horizon; defaults to now. Future horizons are refused (not reproducible). */
    readonly asOf?: Date;
  }): Promise<EvidenceBundleResult & { readonly asOf: string }> {
    return inTransaction(this.db, ModuleRole.evidence, async (ctx) => {
      const rv = await resolveResultVersion(ctx, input.resultVersionId);
      const path = rv === undefined ? undefined : await resultVersionPath(ctx, rv);
      let allowed = 'internal' in input.actor;
      if (!allowed && path?.competitionId !== undefined && 'accountId' in input.actor) {
        allowed = (
          await competitionPermissionSet(ctx, input.actor.accountId, path.competitionId)
        ).has('COMP_VIEW_PRIVATE');
      }
      if (rv === undefined || !allowed) {
        await recordAudit(ctx, {
          actorAccountId: 'accountId' in input.actor ? input.actor.accountId : undefined,
          action: 'evidence.bundle-read',
          targetType: 'RESULT_VERSION',
          outcome: 'DENIED',
        });
        return { denied: true as const };
      }
      const asOf = input.asOf ?? ctx.txTime;
      if (asOf.getTime() > ctx.txTime.getTime())
        throw new DomainError(DomainErrorCode.INVALID_INPUT, 'asOf cannot be in the future');
      const facts = await loadBundleFacts(ctx, rv.resultVersionId);
      return { ...buildEvidenceBundle(facts, asOf), asOf: asOf.toISOString() };
    }).then((r) => {
      if ('denied' in r)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'result version not found');
      return r;
    });
  }
}

/**
 * Loads a SUPERSET of the relevant facts (all history, every recordedAt); the pure builder applies
 * the asOf horizon, reachability and ordering, so loading order can never affect the output.
 */
export async function loadBundleFacts(
  ctx: TxContext,
  resultVersionId: string,
): Promise<BundleFacts> {
  const rv = await resolveResultVersion(ctx, resultVersionId);
  if (rv === undefined)
    throw new DomainError(DomainErrorCode.NOT_FOUND, 'result version not found');
  const path = await resultVersionPath(ctx, rv);
  const targets: [string, string][] = [['RESULT_VERSION', rv.resultVersionId]];
  if (path?.contestId !== undefined) targets.push(['CONTEST', path.contestId]);
  if (path?.eventId !== undefined) targets.push(['EVENT', path.eventId]);

  const attachments = (
    await sql<{
      id: string;
      evidence_id: string;
      target_type: string;
      target_id: string;
      role: string;
      recorded_at: Date;
    }>`SELECT id, evidence_id, target_type, target_id, role, recorded_at FROM evidence.attachment
       WHERE (target_type, target_id) IN (${sql.join(targets.map(([t, i]) => sql`(${t}, ${i}::uuid)`))})`.execute(
      ctx.trx,
    )
  ).rows;

  const attestations = (
    await sql<{
      id: string;
      statement: AttestationStatement;
      statement_hash: string;
      issuer_principal_type: string;
      proof_algorithm: string;
      proof_type: string;
      proof_scheme: string;
      assurance: string;
      verifier_id: string;
      proof: { protected: string; signature: string };
      issued_at: Date;
      recorded_at: Date;
      supersedes_attestation_id: string | null;
    }>`SELECT id, statement, statement_hash, issuer_principal_type, proof_algorithm, proof_type, proof_scheme,
              assurance, verifier_id, proof, issued_at, recorded_at, supersedes_attestation_id
       FROM attestation.attestation WHERE subject_type = 'RESULT_VERSION' AND subject_id = ${rv.resultVersionId}`.execute(
      ctx.trx,
    )
  ).rows;

  // Reachable evidence: attached + cited, then the lineage closure (bounded recursive query).
  const seeds = [
    ...new Set([
      ...attachments.map((a) => a.evidence_id),
      ...attestations.flatMap((a) => (a.statement.evidenceRefs ?? []).map((r) => r.evidenceId)),
    ]),
  ];
  const ids =
    seeds.length === 0
      ? []
      : (
          await sql<{ id: string }>`
            WITH RECURSIVE closure(id, depth) AS (
              SELECT unnest(${seeds}::uuid[]), 0
              UNION
              SELECT r.related_evidence_id, c.depth + 1 FROM evidence.relation r JOIN closure c ON r.evidence_id = c.id
              WHERE c.depth < 32
            ) SELECT DISTINCT id FROM closure`.execute(ctx.trx)
        ).rows.map((r) => r.id);

  const items =
    ids.length === 0
      ? []
      : (
          await sql<{
            id: string;
            descriptor: {
              source: Record<string, unknown>;
              derivation?: {
                generator: {
                  kind: string;
                  systemId: string;
                  version: string;
                  configurationHash?: string;
                };
              };
              lineage?: { relation: string; evidenceId: string; descriptorHash: string }[];
            };
            descriptor_hash: string;
            content_hash: string;
            byte_length: number;
            media_type: string;
            evidence_type: string;
            source_principal_id: string | null;
            source_principal_type: string | null;
            received_at: Date;
            recorded_at: Date;
          }>`SELECT i.id, i.descriptor, i.descriptor_hash, i.content_hash, i.byte_length::int AS byte_length, i.media_type,
                    i.evidence_type, i.source_principal_id, p.principal_type AS source_principal_type,
                    i.received_at, i.recorded_at
             FROM evidence.item i LEFT JOIN authority.principal p ON p.id = i.source_principal_id
             WHERE i.id = ANY(${ids}::uuid[])`.execute(ctx.trx)
        ).rows;

  const availability =
    ids.length === 0
      ? []
      : (
          await sql<{
            evidence_id: string;
            to_status: EvidenceAvailability;
            recorded_at: Date;
            seq: number;
          }>`
            SELECT evidence_id, to_status, recorded_at, seq FROM evidence.availability_change
            WHERE evidence_id = ANY(${ids}::uuid[])`.execute(ctx.trx)
        ).rows;
  const privacy =
    ids.length === 0
      ? []
      : (
          await sql<{
            evidence_id: string;
            to_class: EvidencePrivacyClass;
            recorded_at: Date;
            seq: number;
          }>`
            SELECT evidence_id, to_class, recorded_at, seq FROM evidence.privacy_change
            WHERE evidence_id = ANY(${ids}::uuid[])`.execute(ctx.trx)
        ).rows;

  const attestationIds = attestations.map((a) => a.id);
  const retractions =
    attestationIds.length === 0
      ? []
      : (
          await sql<{
            id: string;
            attestation_id: string;
            statement_hash: string;
            key_id: string;
            proof: { protected: string; signature: string };
            reason_code: string;
            issued_at: Date;
            recorded_at: Date;
          }>`SELECT id, attestation_id, statement_hash, key_id, proof, reason_code, issued_at, recorded_at
             FROM attestation.retraction WHERE attestation_id = ANY(${attestationIds}::uuid[])`.execute(
            ctx.trx,
          )
        ).rows;

  const keyIds = [
    ...new Set([
      ...attestations.map((a) => a.statement.issuer.keyId),
      ...retractions.map((r) => r.key_id),
    ]),
  ];
  const keys =
    keyIds.length === 0
      ? []
      : (
          await sql<{
            id: string;
            principal_id: string;
            fact_hash: string;
            verification_material: Record<string, string>;
            key_kind: string;
            algorithm: string;
            effective_from: Date;
            effective_to: Date | null;
            recorded_at: Date;
          }>`SELECT id, principal_id, fact_hash, verification_material, key_kind, algorithm, effective_from, effective_to, recorded_at
             FROM authority.principal_key WHERE id = ANY(${keyIds}::uuid[])`.execute(ctx.trx)
        ).rows;
  const keyChanges =
    keyIds.length === 0
      ? []
      : (
          await sql<{
            id: string;
            key_id: string;
            kind: string;
            effective_from: Date;
            recorded_at: Date;
            fact_hash: string;
          }>`SELECT id, key_id, kind, effective_from, recorded_at, fact_hash
             FROM authority.principal_key_status_change WHERE key_id = ANY(${keyIds}::uuid[])`.execute(
            ctx.trx,
          )
        ).rows;

  const opt = <K extends string, V>(k: K, v: V | null | undefined) =>
    v === null || v === undefined ? {} : ({ [k]: v } as Record<K, V>);
  return {
    resultVersion: {
      resultVersionId: rv.resultVersionId,
      resultId: rv.resultId,
      versionNumber: rv.versionNumber,
      contentHash: rv.contentHash,
      contentSchema: rv.contentSchema,
      scope: {
        scopeType: rv.scopeType,
        scopeTargetId: rv.scopeTargetId,
        ...opt('competitionId', path?.competitionId),
        ...opt('eventId', path?.eventId),
        ...opt('roundId', path?.roundId),
        ...opt('contestId', path?.contestId),
        ...opt('sport', path?.sport),
        ...opt('discipline', path?.discipline),
        ...opt('region', path?.region),
      },
    },
    evidence: items.map((i) => {
      const s = i.descriptor.source;
      const g = i.descriptor.derivation?.generator;
      return {
        evidenceId: i.id,
        evidenceType: i.evidence_type,
        descriptorHash: i.descriptor_hash,
        contentHash: i.content_hash,
        byteLength: i.byte_length,
        mediaType: i.media_type,
        source: {
          kind: String(s.kind),
          ...opt('principalId', i.source_principal_id),
          ...opt('principalType', i.source_principal_type),
          ...opt(
            'capturedAt',
            typeof s.capturedAt === 'string' ? new Date(s.capturedAt) : undefined,
          ),
          capturedAtAssurance: String(s.capturedAtAssurance),
        },
        ...opt(
          'derivation',
          g === undefined
            ? undefined
            : {
                generatorKind: g.kind,
                systemId: g.systemId,
                version: g.version,
                ...opt('configurationHash', g.configurationHash),
              },
        ),
        lineage: i.descriptor.lineage ?? [],
        receivedAt: i.received_at,
        recordedAt: i.recorded_at,
      };
    }),
    availabilityChanges: availability.map((a) => ({
      evidenceId: a.evidence_id,
      toStatus: a.to_status,
      recordedAt: a.recorded_at,
      seq: Number(a.seq),
    })),
    privacyChanges: privacy.map((p) => ({
      evidenceId: p.evidence_id,
      toClass: p.to_class,
      recordedAt: p.recorded_at,
      seq: Number(p.seq),
    })),
    attachments: attachments.map((a) => ({
      attachmentId: a.id,
      evidenceId: a.evidence_id,
      targetType: a.target_type,
      targetId: a.target_id,
      role: a.role,
      recordedAt: a.recorded_at,
    })),
    attestations: attestations.map((a) => ({
      attestationId: a.id,
      statementHash: a.statement_hash,
      statement: a.statement,
      issuerPrincipalType: a.issuer_principal_type,
      algorithm: a.proof_algorithm,
      proofType: a.proof_type,
      proofScheme: a.proof_scheme,
      assurance: a.assurance,
      verifierId: a.verifier_id,
      proofHash: detachedJwsHash(a.proof),
      issuedAt: a.issued_at,
      recordedAt: a.recorded_at,
      ...opt('supersedesAttestationId', a.supersedes_attestation_id),
    })),
    retractions: retractions.map((r) => ({
      retractionId: r.id,
      attestationId: r.attestation_id,
      statementHash: r.statement_hash,
      keyId: r.key_id,
      proofHash: detachedJwsHash(r.proof),
      reasonCode: r.reason_code,
      issuedAt: r.issued_at,
      recordedAt: r.recorded_at,
    })),
    keys: keys.map((k) => ({
      keyId: k.id,
      principalId: k.principal_id,
      factHash: k.fact_hash,
      verificationMaterialHash: keyMaterialHash(k.verification_material),
      keyKind: k.key_kind,
      algorithm: k.algorithm,
      effectiveFrom: k.effective_from,
      ...opt('effectiveTo', k.effective_to),
      recordedAt: k.recorded_at,
    })),
    keyStatusChanges: keyChanges.map((c) => ({
      statusChangeId: c.id,
      keyId: c.key_id,
      kind: c.kind,
      effectiveFrom: c.effective_from,
      recordedAt: c.recorded_at,
      factHash: c.fact_hash,
    })),
  };
}

// ───────────────────────────── public-safe attestation cards ─────────────────────────────

/** Public attestation DTO: a signed CLAIM's metadata — never "verified", never private data. */
export interface PublicAttestationV1 {
  readonly schema: 'br:public-attestation@1';
  readonly attestationId: string;
  readonly kind: 'CRYPTOGRAPHICALLY_SIGNED_CLAIM';
  readonly notice: string;
  readonly issuer: {
    readonly type: 'ORGANIZATION' | 'INDIVIDUAL' | 'SYSTEM';
    readonly label: string;
    readonly organizationSlug?: string;
  };
  readonly claim: { readonly type: string; readonly polarity: string };
  readonly subject: {
    readonly type: string;
    readonly resultVersionId: string;
    readonly resultId: string;
  };
  readonly issuedOn: string;
  readonly proof: { readonly proofType: string; readonly scheme: string };
  readonly evidence: { readonly count: number; readonly available: number };
  readonly trust: {
    readonly signature: 'VALID_AT_ACCEPTANCE';
    readonly claim: 'ACTIVE' | 'RETRACTED';
    readonly superseded: boolean;
    /** Whether the signing key is trustworthy NOW (compromise, revocation) is BRT-07's evaluation. */
    readonly keyTrust: 'NOT_EVALUATED';
    readonly authority: 'NOT_EVALUATED';
    readonly sportingVerification: 'NOT_IMPLEMENTED';
  };
  readonly retraction?: { readonly reasonCode: string; readonly retractedOn: string };
  readonly supersedesAttestationId?: string;
}

export const SIGNED_CLAIM_NOTICE =
  'This is a cryptographically signed claim. Sporting verification is evaluated separately.';

/** Public read path (br_public_read): the projection plus public organization profiles only. */
export class AttestationPublicReader {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private async cards(where: 'id' | 'subject', value: string): Promise<PublicAttestationV1[]> {
    if (!/^[0-9a-f-]{36}$/.test(value)) return [];
    return inTransaction(this.db, ModuleRole.publicRead, async (ctx) => {
      const { rows } = await sql<{
        attestation_id: string;
        subject_type: string;
        subject_id: string;
        result_id: string;
        issuer_principal_type: string;
        claim_type: string;
        polarity: string;
        proof_type: string;
        proof_scheme: string;
        evidence_count: number;
        evidence_available_count: number;
        issued_at: Date;
        supersedes_attestation_id: string | null;
        superseded: boolean;
        retracted: boolean;
        retraction_reason: string | null;
        retracted_at: Date | null;
        org_name: string | null;
        org_slug: string | null;
      }>`
        SELECT c.*, CASE WHEN os.status = 'ACTIVE' THEN p.display_name END AS org_name,
               CASE WHEN os.status = 'ACTIVE' THEN s.slug END AS org_slug
        FROM evidence_read.attestation_card c
        JOIN competition_read.competition_card cc ON cc.competition_id = c.competition_id AND cc.status <> 'DRAFT'
        JOIN competition_read.event_summary es ON es.event_id = c.event_id AND es.status <> 'DRAFT'
        LEFT JOIN organizations.organization_profile p ON p.organization_id = c.issuer_organization_id
        LEFT JOIN organizations.v_organization_current os ON os.organization_id = c.issuer_organization_id
        LEFT JOIN organizations.v_organization_slug_current s ON s.organization_id = c.issuer_organization_id
        WHERE c.visibility = 'PUBLIC' AND ${where === 'id' ? sql`c.attestation_id = ${value}::uuid` : sql`c.subject_id = ${value}::uuid`}
        ORDER BY c.issued_at, c.attestation_id`.execute(ctx.trx);
      return rows.map((r): PublicAttestationV1 => {
        const issuer: PublicAttestationV1['issuer'] =
          r.issuer_principal_type === 'ORGANIZATION' && r.org_name !== null
            ? {
                type: 'ORGANIZATION',
                label: r.org_name,
                ...(r.org_slug === null ? {} : { organizationSlug: r.org_slug }),
              }
            : r.issuer_principal_type === 'PERSON'
              ? { type: 'INDIVIDUAL', label: 'Individual signer' }
              : r.issuer_principal_type === 'ORGANIZATION'
                ? { type: 'ORGANIZATION', label: 'Organization signer' }
                : { type: 'SYSTEM', label: 'System signer' };
        return {
          schema: 'br:public-attestation@1',
          attestationId: r.attestation_id,
          kind: 'CRYPTOGRAPHICALLY_SIGNED_CLAIM',
          notice: SIGNED_CLAIM_NOTICE,
          issuer,
          claim: { type: r.claim_type, polarity: r.polarity },
          subject: { type: r.subject_type, resultVersionId: r.subject_id, resultId: r.result_id },
          issuedOn: r.issued_at.toISOString().slice(0, 10),
          proof: { proofType: r.proof_type, scheme: r.proof_scheme },
          evidence: { count: r.evidence_count, available: r.evidence_available_count },
          trust: {
            signature: 'VALID_AT_ACCEPTANCE',
            claim: r.retracted ? 'RETRACTED' : 'ACTIVE',
            superseded: r.superseded,
            keyTrust: 'NOT_EVALUATED',
            authority: 'NOT_EVALUATED',
            sportingVerification: 'NOT_IMPLEMENTED',
          },
          ...(r.retracted && r.retracted_at !== null
            ? {
                retraction: {
                  reasonCode: r.retraction_reason ?? 'OTHER',
                  retractedOn: r.retracted_at.toISOString().slice(0, 10),
                },
              }
            : {}),
          ...(r.supersedes_attestation_id === null
            ? {}
            : { supersedesAttestationId: r.supersedes_attestation_id }),
        };
      });
    });
  }

  async attestation(attestationId: string): Promise<PublicAttestationV1 | undefined> {
    return (await this.cards('id', attestationId))[0];
  }

  resultVersionAttestations(resultVersionId: string): Promise<PublicAttestationV1[]> {
    return this.cards('subject', resultVersionId);
  }
}
