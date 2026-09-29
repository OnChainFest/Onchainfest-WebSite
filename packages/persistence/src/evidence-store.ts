import {
  canChangeAvailability,
  DELETED_AVAILABILITY,
  DomainError,
  DomainErrorCode,
  newId,
  type EvidenceAttachmentRole,
  type EvidenceAttachmentTarget,
  type EvidenceAvailability,
  type EvidencePrivacyClass,
  type EvidenceRelationKind,
  type EvidenceType,
  type Uuid,
} from '@br/domain';
import {
  buildEvidenceDescriptor,
  checkEvidenceMedia,
  MAX_REFERENCE_UPLOAD_BYTES,
  unavailableEvidenceBlobStore,
  type DerivationInput,
  type EvidenceBlobStore,
  type EvidenceSourceInput,
  type LineageEdgeInput,
} from '@br/evidence';
import { SchemaRef } from '@br/schemas';
import { sql } from 'kysely';
import type { Db } from './db';
import {
  accountActive,
  evidenceAccess,
  evidenceNotFound,
  loadItem,
  representation,
  resolveResultVersion,
  resultVersionPath,
  scopePath,
  unwrap,
  type Committed,
  type EvidenceActor,
  type ItemRow,
} from './evidence-support';
import { refreshCardsCitingEvidence, refreshEvidenceState } from './evidence-projection';
import { factHash } from './hashing';
import { identityIdempotency, lockKeys, payloadDigest, recordAudit } from './identity-support';
import { openStream, StreamType } from './ledger';
import { emitEvent } from './outbox';
import { inTransaction, ModuleRole, type TxContext } from './tx';

/**
 * BRT-06 Evidence module (br_evidence). Evidence ≠ truth: nothing here creates, transitions or
 * verifies a Result, and no evidence event means "verified".
 *
 * Storage atomicity (DB and blob store are not one transaction):
 *   1. read the platform-observed receipt time;
 *   2. the blob store computes SHA-256 of the exact bytes, encrypts, durably writes and re-checks;
 *   3. only then does the metadata transaction commit the blob registry row and the EvidenceItem.
 * A crash between 2 and 3 leaves an unreferenced (encrypted) blob — acceptable and eligible for
 * garbage collection. A committed item pointing at bytes that were never stored cannot happen.
 */
export interface IngestEvidenceInput {
  readonly actorAccountId: string;
  readonly idempotencyKey: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly evidenceType: EvidenceType;
  readonly source: EvidenceSourceInput;
  readonly privacyClass?: EvidencePrivacyClass;
  readonly derivation?: Omit<DerivationInput, 'inputs'> & {
    readonly inputEvidenceIds: readonly string[];
  };
  readonly lineage?: readonly {
    readonly relation: EvidenceRelationKind;
    readonly evidenceId: string;
  }[];
  readonly attachTo?: {
    readonly targetType: EvidenceAttachmentTarget;
    readonly targetId: string;
    readonly role: EvidenceAttachmentRole;
  };
}

export interface IngestEvidenceOutcome {
  readonly evidenceId: string;
  readonly descriptorHash: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly mediaType: string;
  /** False when the same submitter already registered the same bytes with the same provenance. */
  readonly created: boolean;
  readonly attachmentId?: string;
}

/** Source kinds an application account may declare in BRT-06 (device/provider adapters: later). */
const ACCOUNT_SOURCE_KINDS = new Set(['HUMAN', 'ORGANIZATION', 'AI_PIPELINE']);

export class EvidenceStore {
  private readonly db: Db;
  private readonly blobs: EvidenceBlobStore;

  constructor(db: Db, options: { blobStore?: EvidenceBlobStore } = {}) {
    this.db = db;
    this.blobs = options.blobStore ?? unavailableEvidenceBlobStore;
  }

  /**
   * Platform-observed receipt time (BRT-02 §5.1 `receivedAt`): the database clock
   * (`platform.tx_time_ms()`) read in its own transaction BEFORE the bytes are stored — the same
   * authoritative clock as `recordedAt`, but a different, earlier reading. Protected only so tests
   * can simulate a clock that stepped backwards between the two readings.
   */
  protected observeReceipt(): Promise<Date> {
    return this.tx(async (ctx) => ctx.txTime);
  }

  get storageAvailable(): boolean {
    return this.blobs.available;
  }

  private tx<T>(fn: (ctx: TxContext) => Promise<T>): Promise<T> {
    return inTransaction(this.db, ModuleRole.evidence, fn);
  }

  // ───────────────────────────── ingestion ─────────────────────────────

  async ingest(input: IngestEvidenceInput): Promise<IngestEvidenceOutcome> {
    if (!this.blobs.available) {
      throw new DomainError(
        DomainErrorCode.EVIDENCE_STORAGE_UNAVAILABLE,
        'evidence storage is not configured (production object storage + KMS are not implemented yet)',
      );
    }
    if (input.bytes.length > MAX_REFERENCE_UPLOAD_BYTES)
      throw new DomainError(DomainErrorCode.EVIDENCE_TOO_LARGE, 'evidence exceeds the size limit');
    const media = checkEvidenceMedia(input.mediaType, input.bytes);
    if (!media.ok) {
      throw new DomainError(
        DomainErrorCode.EVIDENCE_TYPE_NOT_ALLOWED,
        media.reason === 'EMPTY'
          ? 'evidence content is empty'
          : 'media type is not allowed or does not match the content',
      );
    }
    if (!ACCOUNT_SOURCE_KINDS.has(input.source.kind)) {
      throw new DomainError(
        DomainErrorCode.INVALID_INPUT,
        'this source kind needs a registered ingestion adapter (not available yet)',
      );
    }
    if (input.source.kind === 'ORGANIZATION' && input.source.principalId === undefined)
      throw new DomainError(
        DomainErrorCode.INVALID_INPUT,
        'organization evidence names its principal',
      );
    if (input.source.kind === 'AI_PIPELINE' && input.source.principalId !== undefined)
      throw new DomainError(
        DomainErrorCode.INVALID_INPUT,
        'AI pipeline principals need an adapter',
      );

    // 1. platform-observed receipt time, 2. durable blob, 3. metadata.
    const receivedAt = await this.observeReceipt();
    const blob = await this.blobs.put(input.bytes, { maxBytes: MAX_REFERENCE_UPLOAD_BYTES });

    const r = await this.tx(async (ctx): Promise<Committed<IngestEvidenceOutcome>> => {
      // BRT-06R: the receipt observation is stored VERBATIM. It and recordedAt are two separate
      // readings of the database clock (two transactions), so no ordering between them is assumed
      // or enforced, and nothing ever rewrites either one (no clamp, no slack).
      const observedAt = receivedAt;
      const idem = await identityIdempotency<IngestEvidenceOutcome>(ctx, {
        command: 'IngestEvidence',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: {
          contentHash: blob.contentHash,
          byteLength: blob.byteLength,
          mediaType: media.mediaType,
          evidenceType: input.evidenceType,
          source: input.source,
          privacyClass: input.privacyClass ?? 'PLATFORM_PRIVATE',
          derivation: input.derivation,
          lineage: input.lineage,
          attachTo: input.attachTo,
        },
      });
      if (idem.lookup.replay) return { ok: idem.lookup.response };
      if (!(await accountActive(ctx, input.actorAccountId)))
        throw new DomainError(DomainErrorCode.FORBIDDEN, 'not permitted');
      if (input.source.principalId !== undefined) {
        const basis = await representation(ctx, input.actorAccountId, input.source.principalId);
        const expected =
          input.source.kind === 'ORGANIZATION' ? 'ORGANIZATION_ADMIN' : 'PERSON_SELF';
        if (basis !== expected) {
          await recordAudit(ctx, {
            actorAccountId: input.actorAccountId,
            action: 'evidence.source-representation-denied',
            targetType: 'PRINCIPAL',
            targetId: input.source.principalId,
            outcome: 'DENIED',
          });
          return {
            error: new DomainError(
              DomainErrorCode.ISSUER_NOT_CONTROLLED,
              'the account cannot represent this source principal',
            ),
          };
        }
      }

      // Lineage parents must be citable by the actor; derivation inputs are lineage parents too.
      const edges = new Map<string, LineageEdgeInput>();
      const parents = new Map<string, ItemRow>();
      const wanted = [
        ...(input.lineage ?? []),
        ...(input.derivation?.inputEvidenceIds ?? []).map((evidenceId) => ({
          relation: 'DERIVED_FROM' as const,
          evidenceId,
        })),
      ];
      for (const l of wanted) {
        const parent = parents.get(l.evidenceId) ?? (await loadItem(ctx, l.evidenceId));
        if (
          parent === undefined ||
          !(await evidenceAccess(ctx, { accountId: input.actorAccountId }, parent, 'CITE')).allowed
        )
          throw evidenceNotFound();
        parents.set(parent.id, parent);
        const key = `${parent.id}:${l.relation}`;
        if (!edges.has(key)) {
          edges.set(key, {
            relation: l.relation,
            evidenceId: parent.id as Uuid,
            descriptorHash: parent.descriptor_hash,
          });
        }
      }
      const evidenceId = newId();
      const hashed = buildEvidenceDescriptor({
        evidenceId,
        evidenceType: input.evidenceType,
        contentHash: blob.contentHash,
        byteLength: blob.byteLength,
        mediaType: media.mediaType,
        source: input.source,
        acquisition: {
          method: wanted.length > 0 ? 'PLATFORM_DERIVATION' : 'REFERENCE_UPLOAD',
          receivedAt: observedAt,
        },
        ...(input.derivation === undefined
          ? {}
          : {
              derivation: {
                generator: input.derivation.generator,
                ...(input.derivation.generatedAt === undefined
                  ? {}
                  : { generatedAt: input.derivation.generatedAt }),
                inputs: input.derivation.inputEvidenceIds.map((id) => ({
                  evidenceId: id as Uuid,
                  contentHash: (parents.get(id) as ItemRow).content_hash,
                })),
              },
            }),
        lineage: [...edges.values()],
      });
      // Natural key (BRT-02 persistence §7): same submitter + same bytes + same source/capture +
      // same type ⇒ the existing item. Different provenance over the same bytes ⇒ a new item.
      const provenanceKey = payloadDigest({
        contentHash: blob.contentHash,
        evidenceType: input.evidenceType,
        source: (hashed.descriptor as { source: unknown }).source,
        submittedByAccountId: input.actorAccountId,
      });
      await lockKeys(ctx, `evidence-provenance:${provenanceKey}`);
      const { rows: existing } = await sql<{ id: string }>`
        SELECT id FROM evidence.item WHERE provenance_key = ${provenanceKey}`.execute(ctx.trx);
      if (existing[0] !== undefined) {
        const item = (await loadItem(ctx, existing[0].id)) as ItemRow;
        const response: IngestEvidenceOutcome = {
          evidenceId: item.id,
          descriptorHash: item.descriptor_hash,
          contentHash: item.content_hash,
          byteLength: item.byte_length,
          mediaType: item.media_type,
          created: false,
        };
        await idem.record(response);
        return { ok: response };
      }

      await sql`INSERT INTO evidence.blob (content_hash, byte_length, backend, key_ref, recorded_at)
        VALUES (${blob.contentHash}, ${blob.byteLength}, ${blob.backend}, ${blob.keyId}, ${ctx.txTime})
        ON CONFLICT (content_hash) DO NOTHING`.execute(ctx.trx);
      await sql`INSERT INTO evidence.item (id, descriptor_version, descriptor, descriptor_hash, content_hash, byte_length,
          media_type, evidence_type, source_kind, source_principal_id, submitted_by_account_id, captured_at, received_at,
          initial_privacy_class, provenance_key, recorded_at)
        VALUES (${evidenceId}, 1, ${JSON.stringify(hashed.descriptor)}, ${hashed.descriptorHash}, ${blob.contentHash},
          ${blob.byteLength}, ${media.mediaType}, ${input.evidenceType}, ${input.source.kind},
          ${input.source.principalId ?? null}, ${input.actorAccountId}, ${input.source.capturedAt ?? null},
          ${observedAt}, ${input.privacyClass ?? 'PLATFORM_PRIVATE'}, ${provenanceKey}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      for (const e of edges.values()) {
        await sql`INSERT INTO evidence.relation (evidence_id, relation, related_evidence_id, related_descriptor_hash, recorded_at)
          VALUES (${evidenceId}, ${e.relation}, ${e.evidenceId}, ${e.descriptorHash}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
      }
      const stream = await openStream(ctx, evidenceId, StreamType.EVIDENCE_ITEM);
      await stream.append({
        eventType: 'EVIDENCE_ADDED',
        factTable: 'evidence.item',
        factRowId: evidenceId,
        payloadHash: hashed.descriptorHash,
      });
      await this.appendAvailability(ctx, stream, evidenceId, undefined, 'AVAILABLE', 'INGESTED', {
        actorAccountId: input.actorAccountId,
      });
      await this.appendPrivacy(
        ctx,
        stream,
        evidenceId,
        undefined,
        input.privacyClass ?? 'PLATFORM_PRIVATE',
        input.actorAccountId,
      );
      let attachmentId: string | undefined;
      if (input.attachTo !== undefined) {
        attachmentId = await this.insertAttachment(
          ctx,
          stream,
          evidenceId,
          input.actorAccountId,
          input.attachTo,
        );
      }
      await stream.close();
      await emitEvent(ctx, {
        eventType: 'EvidenceAdded',
        aggregateType: 'EVIDENCE_ITEM',
        aggregateId: evidenceId,
        payload: {
          descriptorHash: hashed.descriptorHash,
          evidenceType: input.evidenceType,
          sourceKind: input.source.kind,
          mediaType: media.mediaType,
          byteLength: blob.byteLength,
        },
      });
      if (edges.size > 0) {
        await emitEvent(ctx, {
          eventType: 'EvidenceDerived',
          aggregateType: 'EVIDENCE_ITEM',
          aggregateId: evidenceId,
          payload: {
            parents: [...edges.values()].map((e) => ({
              evidenceId: e.evidenceId,
              relation: e.relation,
            })),
          },
        });
      }
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'evidence.upload',
        targetType: 'EVIDENCE_ITEM',
        targetId: evidenceId,
        details: {
          evidenceType: input.evidenceType,
          mediaType: media.mediaType,
          byteLength: blob.byteLength,
        },
      });
      await refreshEvidenceState(ctx, evidenceId);
      const response: IngestEvidenceOutcome = {
        evidenceId,
        descriptorHash: hashed.descriptorHash,
        contentHash: blob.contentHash,
        byteLength: blob.byteLength,
        mediaType: media.mediaType,
        created: true,
        ...(attachmentId === undefined ? {} : { attachmentId }),
      };
      await idem.record(response);
      return { ok: response };
    });
    return unwrap(r);
  }

  private async appendAvailability(
    ctx: TxContext,
    stream: Awaited<ReturnType<typeof openStream>>,
    evidenceId: string,
    from: EvidenceAvailability | undefined,
    to: EvidenceAvailability,
    reasonCode: string,
    meta: { actorAccountId?: string; basisRef?: string },
  ): Promise<void> {
    const id = newId();
    const hash = factHash(SchemaRef.evidenceLifecycleFact, {
      factId: id,
      evidenceId,
      kind: 'AVAILABILITY',
      ...(from === undefined ? {} : { fromStatus: from }),
      toStatus: to,
      reasonCode,
    });
    await sql`INSERT INTO evidence.availability_change (id, evidence_id, from_status, to_status, reason_code, basis_ref,
        actor_account_id, fact_hash, recorded_at)
      VALUES (${id}, ${evidenceId}, ${from ?? null}, ${to}, ${reasonCode}, ${meta.basisRef ?? null},
        ${meta.actorAccountId ?? null}, ${hash}, ${ctx.txTime})`.execute(ctx.trx);
    await stream.append({
      eventType: `EVIDENCE_AVAILABILITY_${to}`,
      factTable: 'evidence.availability_change',
      factRowId: id as Uuid,
      payloadHash: hash,
    });
  }

  private async appendPrivacy(
    ctx: TxContext,
    stream: Awaited<ReturnType<typeof openStream>>,
    evidenceId: string,
    from: EvidencePrivacyClass | undefined,
    to: EvidencePrivacyClass,
    actorAccountId: string | undefined,
  ): Promise<void> {
    const id = newId();
    const hash = factHash(SchemaRef.evidenceLifecycleFact, {
      factId: id,
      evidenceId,
      kind: 'PRIVACY',
      ...(from === undefined ? {} : { fromClass: from }),
      toClass: to,
    });
    await sql`INSERT INTO evidence.privacy_change (id, evidence_id, from_class, to_class, actor_account_id, fact_hash, recorded_at)
      VALUES (${id}, ${evidenceId}, ${from ?? null}, ${to}, ${actorAccountId ?? null}, ${hash}, ${ctx.txTime})`.execute(
      ctx.trx,
    );
    await stream.append({
      eventType: 'EVIDENCE_PRIVACY_CLASS',
      factTable: 'evidence.privacy_change',
      factRowId: id as Uuid,
      payloadHash: hash,
    });
  }

  /** Resolves the target's TRUE competition from the immutable hierarchy (never client input). */
  private async targetCompetition(
    ctx: TxContext,
    targetType: EvidenceAttachmentTarget,
    targetId: string,
  ): Promise<string> {
    let competitionId: string | undefined;
    if (targetType === 'RESULT_VERSION') {
      const rv = await resolveResultVersion(ctx, targetId);
      competitionId =
        rv === undefined ? undefined : (await resultVersionPath(ctx, rv))?.competitionId;
    } else {
      competitionId = (await scopePath(ctx, targetType, targetId))?.competitionId;
    }
    if (competitionId === undefined)
      throw new DomainError(DomainErrorCode.NOT_FOUND, 'attachment target not found');
    return competitionId;
  }

  private async insertAttachment(
    ctx: TxContext,
    stream: Awaited<ReturnType<typeof openStream>>,
    evidenceId: string,
    actorAccountId: string,
    target: NonNullable<IngestEvidenceInput['attachTo']>,
  ): Promise<string> {
    const competitionId = await this.targetCompetition(ctx, target.targetType, target.targetId);
    const id = newId();
    const hash = factHash(SchemaRef.evidenceLifecycleFact, {
      factId: id,
      evidenceId,
      kind: 'ATTACHMENT',
      targetType: target.targetType,
      targetId: target.targetId,
      role: target.role,
    });
    await sql`INSERT INTO evidence.attachment (id, evidence_id, target_type, target_id, role, competition_id,
        attached_by_account_id, fact_hash, recorded_at)
      VALUES (${id}, ${evidenceId}, ${target.targetType}, ${target.targetId}, ${target.role}, ${competitionId},
        ${actorAccountId}, ${hash}, ${ctx.txTime})`.execute(ctx.trx);
    await stream.append({
      eventType: 'EVIDENCE_ATTACHED',
      factTable: 'evidence.attachment',
      factRowId: id as Uuid,
      payloadHash: hash,
    });
    await emitEvent(ctx, {
      eventType: 'EvidenceAttached',
      aggregateType: 'EVIDENCE_ITEM',
      aggregateId: evidenceId as Uuid,
      payload: {
        attachmentId: id,
        targetType: target.targetType,
        targetId: target.targetId,
        role: target.role,
      },
    });
    return id;
  }

  /** Loads an item the actor may act on; otherwise audits the denial and answers NOT_FOUND. */
  private async authorized(
    ctx: TxContext,
    actor: EvidenceActor,
    evidenceId: string,
    purpose: Parameters<typeof evidenceAccess>[3],
  ): Promise<{ item: ItemRow; basis: string } | undefined> {
    const item = await loadItem(ctx, evidenceId);
    const decision =
      item === undefined ? undefined : await evidenceAccess(ctx, actor, item, purpose);
    if (item === undefined || decision === undefined || !decision.allowed) {
      await recordAudit(ctx, {
        actorAccountId: 'accountId' in actor ? actor.accountId : undefined,
        action: `evidence.${purpose.toLowerCase().replaceAll('_', '-')}`,
        targetType: 'EVIDENCE_ITEM',
        // Unknown ids are not echoed into telemetry as foreign keys; the attempt is still recorded.
        targetId: item?.id,
        outcome: 'DENIED',
      });
      return undefined;
    }
    return { item, basis: decision.basis };
  }

  // ───────────────────────────── attach ─────────────────────────────

  /** "Associated with" — never "proves". Idempotent per (item, target, role). */
  async attach(input: {
    readonly actorAccountId: string;
    readonly evidenceId: string;
    readonly targetType: EvidenceAttachmentTarget;
    readonly targetId: string;
    readonly role: EvidenceAttachmentRole;
    readonly idempotencyKey: string;
  }): Promise<{ attachmentId: string; created: boolean }> {
    const r = await this.tx(
      async (ctx): Promise<Committed<{ attachmentId: string; created: boolean }>> => {
        const idem = await identityIdempotency<{ attachmentId: string; created: boolean }>(ctx, {
          command: 'AttachEvidence',
          actorAccountId: input.actorAccountId,
          idempotencyKey: input.idempotencyKey,
          params: {
            evidenceId: input.evidenceId,
            targetType: input.targetType,
            targetId: input.targetId,
            role: input.role,
          },
        });
        if (idem.lookup.replay) return { ok: idem.lookup.response };
        const ok = await this.authorized(
          ctx,
          { accountId: input.actorAccountId },
          input.evidenceId,
          'ATTACH',
        );
        if (ok === undefined) return { error: evidenceNotFound() };
        await lockKeys(ctx, `evidence:${input.evidenceId}`);
        const { rows } = await sql<{ id: string }>`
        SELECT id FROM evidence.attachment WHERE evidence_id = ${input.evidenceId} AND target_type = ${input.targetType}
          AND target_id = ${input.targetId} AND role = ${input.role}`.execute(ctx.trx);
        if (rows[0] !== undefined) {
          const response = { attachmentId: rows[0].id, created: false };
          await idem.record(response);
          return { ok: response };
        }
        const stream = await openStream(ctx, input.evidenceId as Uuid, StreamType.EVIDENCE_ITEM);
        const attachmentId = await this.insertAttachment(
          ctx,
          stream,
          input.evidenceId,
          input.actorAccountId,
          input,
        );
        await stream.close();
        await recordAudit(ctx, {
          actorAccountId: input.actorAccountId,
          action: 'evidence.attach',
          targetType: 'EVIDENCE_ITEM',
          targetId: input.evidenceId,
          details: { targetType: input.targetType, role: input.role },
        });
        await refreshEvidenceState(ctx, input.evidenceId);
        const response = { attachmentId, created: true };
        await idem.record(response);
        return { ok: response };
      },
    );
    return unwrap(r);
  }

  // ───────────────────────────── availability & privacy ─────────────────────────────

  /**
   * Append-only availability change. RESTRICTED / AVAILABLE: submitter or source representative.
   * DELETED_BY_RETENTION / DELETED_BY_ERASURE ("purge"): INTERNAL only; the descriptor, content
   * hash and every reference remain, only the bytes go (never presented as inspectable again).
   */
  async changeAvailability(input: {
    readonly actor: EvidenceActor;
    readonly evidenceId: string;
    readonly toStatus: 'RESTRICTED' | 'AVAILABLE' | 'DELETED_BY_RETENTION' | 'DELETED_BY_ERASURE';
    readonly reasonCode: string;
    readonly basisRef?: string;
    readonly idempotencyKey: string;
  }): Promise<{ availability: EvidenceAvailability; changed: boolean }> {
    const purpose =
      input.toStatus === 'RESTRICTED'
        ? 'RESTRICT'
        : input.toStatus === 'AVAILABLE'
          ? 'RESTORE'
          : 'PURGE';
    if (!/^[A-Z][A-Z0-9_]{0,39}$/.test(input.reasonCode))
      throw new DomainError(
        DomainErrorCode.INVALID_INPUT,
        'reasonCode must be an UPPER_SNAKE code',
      );
    const actorKey = 'accountId' in input.actor ? input.actor.accountId : 'internal';
    const r = await this.tx(
      async (
        ctx,
      ): Promise<
        Committed<{ availability: EvidenceAvailability; changed: boolean; purgeHash?: string }>
      > => {
        const idem = await identityIdempotency<{
          availability: EvidenceAvailability;
          changed: boolean;
        }>(ctx, {
          command: 'ChangeEvidenceAvailability',
          actorAccountId:
            actorKey === 'internal' ? '00000000-0000-0000-0000-000000000000' : actorKey,
          idempotencyKey: input.idempotencyKey,
          params: {
            evidenceId: input.evidenceId,
            toStatus: input.toStatus,
            reasonCode: input.reasonCode,
            basisRef: input.basisRef,
          },
        });
        if (idem.lookup.replay) return { ok: idem.lookup.response };
        const ok = await this.authorized(ctx, input.actor, input.evidenceId, purpose);
        if (ok === undefined) return { error: evidenceNotFound() };
        await lockKeys(ctx, `evidence:${input.evidenceId}`);
        const current = (await loadItem(ctx, input.evidenceId)) as ItemRow;
        if (current.availability === input.toStatus) {
          const response = { availability: current.availability, changed: false };
          await idem.record(response);
          return { ok: response };
        }
        if (!canChangeAvailability(current.availability, input.toStatus)) {
          return {
            error: new DomainError(
              DomainErrorCode.INVALID_TRANSITION,
              `cannot move ${current.availability} evidence to ${input.toStatus}`,
            ),
          };
        }
        if (input.toStatus === 'AVAILABLE' && !(await this.blobs.exists(current.content_hash))) {
          return {
            error: new DomainError(
              DomainErrorCode.EVIDENCE_NOT_AVAILABLE,
              'evidence content is not available',
            ),
          };
        }
        const stream = await openStream(ctx, input.evidenceId as Uuid, StreamType.EVIDENCE_ITEM);
        await this.appendAvailability(
          ctx,
          stream,
          input.evidenceId,
          current.availability,
          input.toStatus,
          input.reasonCode,
          {
            ...('accountId' in input.actor ? { actorAccountId: input.actor.accountId } : {}),
            ...(input.basisRef === undefined ? {} : { basisRef: input.basisRef }),
          },
        );
        await stream.close();
        await emitEvent(ctx, {
          eventType: 'EvidenceAvailabilityChanged',
          aggregateType: 'EVIDENCE_ITEM',
          aggregateId: input.evidenceId as Uuid,
          payload: { from: current.availability, to: input.toStatus, reasonCode: input.reasonCode },
        });
        await recordAudit(ctx, {
          actorAccountId: 'accountId' in input.actor ? input.actor.accountId : undefined,
          action: 'evidence.availability-change',
          targetType: 'EVIDENCE_ITEM',
          targetId: input.evidenceId,
          details: { from: current.availability, to: input.toStatus, reasonCode: input.reasonCode },
        });
        await refreshEvidenceState(ctx, input.evidenceId);
        await refreshCardsCitingEvidence(ctx, input.evidenceId);
        // Bytes may be purged only when NO item over the same blob can still serve them.
        let purgeHash: string | undefined;
        if ((DELETED_AVAILABILITY as readonly string[]).includes(input.toStatus)) {
          const { rows } = await sql<{ n: number }>`
            SELECT count(*)::int AS n FROM evidence.item i JOIN evidence.v_availability_current a ON a.evidence_id = i.id
            WHERE i.content_hash = ${current.content_hash}
              AND a.status NOT IN ('DELETED_BY_RETENTION', 'DELETED_BY_ERASURE')`.execute(ctx.trx);
          if ((rows[0]?.n ?? 0) === 0) purgeHash = current.content_hash;
        }
        const response = { availability: input.toStatus, changed: true };
        await idem.record(response);
        return { ok: { ...response, ...(purgeHash === undefined ? {} : { purgeHash }) } };
      },
    );
    const out = unwrap(r);
    if ('purgeHash' in out && typeof out.purgeHash === 'string') {
      // After commit: a failure leaves an orphan blob (never served: every item is DELETED_*).
      await this.blobs.purge(out.purgeHash).catch(() => undefined);
    }
    return { availability: out.availability, changed: out.changed };
  }

  /** PLATFORM_PRIVATE → AUTHORITY_ONLY (BRT-01 DB-5: privacy can only be raised). */
  async raisePrivacy(input: {
    readonly actorAccountId: string;
    readonly evidenceId: string;
    readonly idempotencyKey: string;
  }): Promise<{ privacyClass: EvidencePrivacyClass; changed: boolean }> {
    const r = await this.tx(
      async (ctx): Promise<Committed<{ privacyClass: EvidencePrivacyClass; changed: boolean }>> => {
        const idem = await identityIdempotency<{
          privacyClass: EvidencePrivacyClass;
          changed: boolean;
        }>(ctx, {
          command: 'RaiseEvidencePrivacy',
          actorAccountId: input.actorAccountId,
          idempotencyKey: input.idempotencyKey,
          params: { evidenceId: input.evidenceId },
        });
        if (idem.lookup.replay) return { ok: idem.lookup.response };
        const ok = await this.authorized(
          ctx,
          { accountId: input.actorAccountId },
          input.evidenceId,
          'RAISE_PRIVACY',
        );
        if (ok === undefined) return { error: evidenceNotFound() };
        await lockKeys(ctx, `evidence:${input.evidenceId}`);
        const current = (await loadItem(ctx, input.evidenceId)) as ItemRow;
        if (current.privacy_class === 'AUTHORITY_ONLY') {
          const response = { privacyClass: current.privacy_class, changed: false };
          await idem.record(response);
          return { ok: response };
        }
        const stream = await openStream(ctx, input.evidenceId as Uuid, StreamType.EVIDENCE_ITEM);
        await this.appendPrivacy(
          ctx,
          stream,
          input.evidenceId,
          'PLATFORM_PRIVATE',
          'AUTHORITY_ONLY',
          input.actorAccountId,
        );
        await stream.close();
        await emitEvent(ctx, {
          eventType: 'EvidencePrivacyRaised',
          aggregateType: 'EVIDENCE_ITEM',
          aggregateId: input.evidenceId as Uuid,
          payload: { from: 'PLATFORM_PRIVATE', to: 'AUTHORITY_ONLY' },
        });
        await recordAudit(ctx, {
          actorAccountId: input.actorAccountId,
          action: 'evidence.visibility-change',
          targetType: 'EVIDENCE_ITEM',
          targetId: input.evidenceId,
          details: { from: 'PLATFORM_PRIVATE', to: 'AUTHORITY_ONLY' },
        });
        await refreshEvidenceState(ctx, input.evidenceId);
        const response = { privacyClass: 'AUTHORITY_ONLY' as const, changed: true };
        await idem.record(response);
        return { ok: response };
      },
    );
    return unwrap(r);
  }

  // ───────────────────────────── authorized reads ─────────────────────────────

  /**
   * Authorized metadata (never public). Private external identifiers and device ids are shown only
   * to the submitter / source representative, never to competition staff. Denials are audited and
   * indistinguishable from unknown ids.
   */
  async metadata(actor: EvidenceActor, evidenceId: string): Promise<EvidenceMetadataV1> {
    const r = await this.tx(async (ctx): Promise<Committed<EvidenceMetadataV1>> => {
      const ok = await this.authorized(ctx, actor, evidenceId, 'VIEW_METADATA');
      if (ok === undefined) return { error: evidenceNotFound() };
      const { item, basis } = ok;
      const { rows: attachments } = await sql<{
        id: string;
        target_type: string;
        target_id: string;
        role: string;
        recorded_at: Date;
      }>`SELECT id, target_type, target_id, role, recorded_at FROM evidence.attachment WHERE evidence_id = ${item.id} ORDER BY id`.execute(
        ctx.trx,
      );
      const { rows: lineage } = await sql<{ relation: string; related_evidence_id: string }>`
        SELECT relation, related_evidence_id FROM evidence.relation WHERE evidence_id = ${item.id}
        ORDER BY related_evidence_id, relation`.execute(ctx.trx);
      const { rows: children } = await sql<{ relation: string; evidence_id: string }>`
        SELECT relation, evidence_id FROM evidence.relation WHERE related_evidence_id = ${item.id}
        ORDER BY evidence_id, relation`.execute(ctx.trx);
      const source = { ...(item.descriptor.source as Record<string, unknown>) };
      if (basis === 'COMPETITION_STAFF') {
        delete source.externalNamespace;
        delete source.externalId;
        delete source.deviceId;
      }
      return {
        ok: {
          schema: 'br:evidence-metadata@1',
          evidenceId: item.id,
          statement:
            'Evidence is an artefact with provenance. It asserts nothing and is not a verification.',
          evidenceType: item.evidence_type,
          mediaType: item.media_type,
          byteLength: item.byte_length,
          contentHash: item.content_hash,
          descriptorHash: item.descriptor_hash,
          source,
          receivedAt: item.received_at.toISOString(),
          recordedAt: item.recorded_at.toISOString(),
          availability: { status: item.availability, since: item.availability_since.toISOString() },
          privacyClass: item.privacy_class,
          attachments: attachments.map((a) => ({
            attachmentId: a.id,
            targetType: a.target_type,
            targetId: a.target_id,
            role: a.role,
            meaning: 'ASSOCIATED_WITH',
            recordedAt: a.recorded_at.toISOString(),
          })),
          lineage: lineage.map((l) => ({
            relation: l.relation,
            parentEvidenceId: l.related_evidence_id,
          })),
          derivatives: children.map((c) => ({
            relation: c.relation,
            childEvidenceId: c.evidence_id,
          })),
          accessBasis: basis,
        },
      };
    });
    return unwrap(r);
  }

  /** Raw bytes for an authorized viewer; every successful read is audited (committed first). */
  async content(
    actor: EvidenceActor,
    evidenceId: string,
  ): Promise<{ bytes: Uint8Array; mediaType: string; contentHash: string }> {
    const r = await this.tx(async (ctx): Promise<Committed<ItemRow>> => {
      const ok = await this.authorized(ctx, actor, evidenceId, 'READ_CONTENT');
      if (ok === undefined) return { error: evidenceNotFound() };
      if (ok.item.availability !== 'AVAILABLE') {
        return {
          error: new DomainError(
            DomainErrorCode.EVIDENCE_NOT_AVAILABLE,
            'evidence content is not available',
            {
              availability: ok.item.availability,
            },
          ),
        };
      }
      await recordAudit(ctx, {
        actorAccountId: 'accountId' in actor ? actor.accountId : undefined,
        action: 'evidence.content-read',
        targetType: 'EVIDENCE_ITEM',
        targetId: ok.item.id,
        details: { basis: ok.basis },
      });
      return { ok: ok.item };
    });
    const item = unwrap(r);
    // Fails closed (missing / corrupt / wrong key / swapped object ⇒ EVIDENCE_NOT_AVAILABLE).
    const bytes = await this.blobs.get(item.content_hash);
    return { bytes, mediaType: item.media_type, contentHash: item.content_hash };
  }
}

export interface EvidenceMetadataV1 {
  readonly schema: 'br:evidence-metadata@1';
  readonly evidenceId: string;
  readonly statement: string;
  readonly evidenceType: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly contentHash: string;
  readonly descriptorHash: string;
  readonly source: Record<string, unknown>;
  readonly receivedAt: string;
  readonly recordedAt: string;
  readonly availability: { readonly status: string; readonly since: string };
  readonly privacyClass: string;
  readonly attachments: readonly {
    attachmentId: string;
    targetType: string;
    targetId: string;
    role: string;
    meaning: 'ASSOCIATED_WITH';
    recordedAt: string;
  }[];
  readonly lineage: readonly { relation: string; parentEvidenceId: string }[];
  readonly derivatives: readonly { relation: string; childEvidenceId: string }[];
  readonly accessBasis: string;
}
