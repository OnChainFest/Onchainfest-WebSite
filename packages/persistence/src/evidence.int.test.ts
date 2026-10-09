import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashEvidenceBytes } from '@br/canonical';
import { DomainErrorCode, newId } from '@br/domain';
import {
  createDevelopmentEvidenceCipher,
  FilesystemEvidenceBlobStore,
  hashDescriptorDocument,
} from '@br/evidence';
import {
  apiDb,
  declaredNoParticipation,
  newContestResult,
  newTestAccount,
  operatorDb,
  ownerDb,
  seedTestCatalog,
} from '@br/testkit';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthorityStore } from './authority-store';
import { CatalogStore } from './catalog-store';
import {
  CompetitionHierarchyResolver,
  createCompetitionResultLedger,
} from './competition-hierarchy';
import { CompetitionStore } from './competition-store';
import { StructureStore } from './competition-structure-store';
import { EvidenceStore } from './evidence-store';
import { IdentityStore } from './identity-store';
import { OrganizationStore } from './organization-store';

const api = apiDb();
const owner = ownerDb();
const operator = operatorDb();
afterAll(async () => {
  await Promise.all([api, owner, operator].map((d) => d.destroy()));
});

const identity = new IdentityStore(api);
const orgs = new OrganizationStore(api);
const comps = new CompetitionStore(api);
const structure = new StructureStore(api);
const authority = new AuthorityStore(api, { conflictChecker: declaredNoParticipation });
const ledger = createCompetitionResultLedger(api, { conflictChecker: declaredNoParticipation });
const resolver = new CompetitionHierarchyResolver(api);
const root = mkdtempSync(join(tmpdir(), 'br-evidence-int-'));
const EVIDENCE_KEY = `int-${newId()}-${newId()}`;
const blobStore = new FilesystemEvidenceBlobStore({
  root,
  cipher: createDevelopmentEvidenceCipher({ keyMaterial: EVIDENCE_KEY }),
});
const evidence = new EvidenceStore(api, { blobStore });
const noStorage = new EvidenceStore(api); // production posture: no blob backend
const k = () => `k-${newId()}`;
const SENTINEL = `EVIDENCE-CONTENT-SENTINEL-${newId()}`;
const sheet = (s: string) =>
  new TextEncoder().encode(JSON.stringify({ sheet: s, sentinel: SENTINEL }));
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });

let w: Awaited<ReturnType<typeof newContestResult>>;
let other: Awaited<ReturnType<typeof newContestResult>>;
let orgPrincipalId: string;
const count = async (q: string) =>
  Number((await sql.raw<{ n: number }>(q).execute(owner)).rows[0]?.n);

beforeAll(async () => {
  const catalog = await seedTestCatalog(identity, new CatalogStore(operator));
  const deps = { db: api, identity, orgs, comps, structure, authority, ledger, resolver, catalog };
  w = await newContestResult(deps);
  other = await newContestResult(deps); // a different organizer and competition (C2)
  const { rows } = await sql<{ principal_id: string }>`
    SELECT principal_id FROM organizations.organization_principal WHERE organization_id = ${w.organizer.organizationId}`.execute(
    owner,
  );
  orgPrincipalId = rows[0]!.principal_id;
});

const upload = (
  actorAccountId: string,
  bytes: Uint8Array,
  over: Partial<Parameters<EvidenceStore['ingest']>[0]> = {},
) =>
  evidence.ingest({
    actorAccountId,
    idempotencyKey: k(),
    bytes,
    mediaType: 'application/json',
    evidenceType: 'SIGNED_SCORESHEET',
    source: { kind: 'HUMAN' },
    ...over,
  });

describe('ingestion: server-computed hash, blob ≠ item, provenance never collapsed', () => {
  it('the content hash is computed from the exact bytes and the descriptor re-hashes', async () => {
    const bytes = sheet('A');
    const r = await upload(w.organizer.ownerAccountId, bytes);
    expect(r.contentHash).toBe(hashEvidenceBytes(bytes));
    expect(r.byteLength).toBe(bytes.length);
    const { rows } = await sql<{ descriptor: unknown; descriptor_hash: string }>`
      SELECT descriptor, descriptor_hash FROM evidence.item WHERE id = ${r.evidenceId}`.execute(
      owner,
    );
    expect(hashDescriptorDocument(rows[0]!.descriptor).descriptorHash).toBe(
      rows[0]!.descriptor_hash,
    );
    expect(rows[0]!.descriptor_hash).toBe(r.descriptorHash);
  });

  it('same bytes from two sources: ONE blob, TWO items; the same provenance again returns the existing item', async () => {
    const bytes = sheet('B');
    const human = await upload(w.organizer.ownerAccountId, bytes);
    const org = await upload(w.organizer.ownerAccountId, bytes, {
      source: { kind: 'ORGANIZATION', principalId: orgPrincipalId as never },
    });
    const again = await upload(w.organizer.ownerAccountId, bytes);
    expect(human.contentHash).toBe(org.contentHash);
    expect(human.evidenceId).not.toBe(org.evidenceId);
    expect(again).toMatchObject({ evidenceId: human.evidenceId, created: false });
    expect(
      await count(
        `SELECT count(*)::int AS n FROM evidence.blob WHERE content_hash = '${human.contentHash}'`,
      ),
    ).toBe(1);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM evidence.item WHERE content_hash = '${human.contentHash}'`,
      ),
    ).toBe(2);
  });

  it('a non-representative cannot declare an organization source (issuer ≠ account)', async () => {
    const stranger = await newTestAccount(identity);
    await expect(
      upload(stranger.accountId, sheet('C'), {
        source: { kind: 'ORGANIZATION', principalId: orgPrincipalId as never },
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.ISSUER_NOT_CONTROLLED });
  });

  it('idempotency: same key + same request replays; same key + different request is refused', async () => {
    const key = k();
    const a = await evidence.ingest({
      actorAccountId: w.organizer.ownerAccountId,
      idempotencyKey: key,
      bytes: sheet('D'),
      mediaType: 'application/json',
      evidenceType: 'SIGNED_SCORESHEET',
      source: { kind: 'HUMAN' },
    });
    const b = await evidence.ingest({
      actorAccountId: w.organizer.ownerAccountId,
      idempotencyKey: key,
      bytes: sheet('D'),
      mediaType: 'application/json',
      evidenceType: 'SIGNED_SCORESHEET',
      source: { kind: 'HUMAN' },
    });
    expect(b).toEqual(a);
    await expect(
      evidence.ingest({
        actorAccountId: w.organizer.ownerAccountId,
        idempotencyKey: key,
        bytes: sheet('E'),
        mediaType: 'application/json',
        evidenceType: 'SIGNED_SCORESHEET',
        source: { kind: 'HUMAN' },
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.IDEMPOTENCY_KEY_REUSED });
  });

  it('refuses disallowed / spoofed media, oversized bodies, and unimplemented source kinds', async () => {
    const actor = w.organizer.ownerAccountId;
    await expect(
      upload(actor, new TextEncoder().encode('<html>x</html>'), { mediaType: 'text/html' }),
    ).rejects.toMatchObject({ code: DomainErrorCode.EVIDENCE_TYPE_NOT_ALLOWED });
    await expect(
      upload(actor, new TextEncoder().encode('<svg onload=1>'), { mediaType: 'text/plain' }),
    ).rejects.toMatchObject({ code: DomainErrorCode.EVIDENCE_TYPE_NOT_ALLOWED });
    await expect(
      upload(actor, new TextEncoder().encode('MZ...'), { mediaType: 'application/pdf' }),
    ).rejects.toMatchObject({ code: DomainErrorCode.EVIDENCE_TYPE_NOT_ALLOWED });
    await expect(
      upload(actor, new Uint8Array(2 * 1024 * 1024 + 1).fill(0x61), { mediaType: 'text/plain' }),
    ).rejects.toMatchObject({ code: DomainErrorCode.EVIDENCE_TOO_LARGE });
    await expect(
      upload(actor, sheet('F'), { source: { kind: 'TIMING_SYSTEM' } }),
    ).rejects.toMatchObject({ code: DomainErrorCode.INVALID_INPUT });
  });

  it('evidence ingestion never creates or moves a Result', async () => {
    const before = await count(`SELECT count(*)::int AS n FROM results.result_status_transition`);
    const results = await count(`SELECT count(*)::int AS n FROM results.result`);
    await upload(w.organizer.ownerAccountId, sheet('G'), {
      attachTo: { targetType: 'RESULT_VERSION', targetId: w.resultVersionId, role: 'PRIMARY' },
    });
    expect(await count(`SELECT count(*)::int AS n FROM results.result_status_transition`)).toBe(
      before,
    );
    expect(await count(`SELECT count(*)::int AS n FROM results.result`)).toBe(results);
    const { rows } = await sql<{ current_status: string }>`
      SELECT current_status FROM results.result_version_state WHERE result_version_id = ${w.resultVersionId}`.execute(
      owner,
    );
    expect(rows[0]?.current_status).toBe('SUBMITTED');
  });

  it('production posture: without a blob backend ingestion fails closed, metadata still works', async () => {
    const r = await upload(w.organizer.ownerAccountId, sheet('H'));
    await expect(
      noStorage.ingest({
        actorAccountId: w.organizer.ownerAccountId,
        idempotencyKey: k(),
        bytes: sheet('I'),
        mediaType: 'application/json',
        evidenceType: 'SIGNED_SCORESHEET',
        source: { kind: 'HUMAN' },
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.EVIDENCE_STORAGE_UNAVAILABLE });
    expect(
      (await noStorage.metadata({ accountId: w.organizer.ownerAccountId }, r.evidenceId))
        .contentHash,
    ).toBe(r.contentHash);
    await expect(
      noStorage.content({ accountId: w.organizer.ownerAccountId }, r.evidenceId),
    ).rejects.toMatchObject({ code: DomainErrorCode.EVIDENCE_STORAGE_UNAVAILABLE });
  });
});

describe('access control (centralized policy; IDOR-safe)', () => {
  it('another account, another competition’s staff and a participant cannot read private evidence', async () => {
    const r = await upload(w.organizer.ownerAccountId, sheet('J'), {
      attachTo: { targetType: 'RESULT_VERSION', targetId: w.resultVersionId, role: 'PRIMARY' },
    });
    const stranger = await newTestAccount(identity);
    const participant = w.athletes[0]!;
    for (const accountId of [
      stranger.accountId,
      other.organizer.ownerAccountId,
      participant.accountId,
    ]) {
      await expect(evidence.metadata({ accountId }, r.evidenceId)).rejects.toMatchObject({
        code: DomainErrorCode.NOT_FOUND,
      });
      await expect(evidence.content({ accountId }, r.evidenceId)).rejects.toMatchObject({
        code: DomainErrorCode.NOT_FOUND,
      });
    }
    // Unknown ids are indistinguishable from forbidden ones.
    const unknown = await evidence
      .metadata({ accountId: stranger.accountId }, newId())
      .catch((e: Error) => e.message);
    const forbidden = await evidence
      .metadata({ accountId: stranger.accountId }, r.evidenceId)
      .catch((e: Error) => e.message);
    expect(unknown).toBe(forbidden);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'evidence.view-metadata' AND outcome = 'DENIED' AND target_id = '${r.evidenceId}'`,
      ),
    ).toBeGreaterThan(0);
  });

  it('staff of the attached competition may read PLATFORM_PRIVATE evidence; AUTHORITY_ONLY fails closed for staff', async () => {
    const athlete = w.athletes[1]!;
    const r = await upload(athlete.accountId, sheet('K'));
    await expect(
      evidence.metadata({ accountId: w.organizer.ownerAccountId }, r.evidenceId),
    ).rejects.toMatchObject({ code: DomainErrorCode.NOT_FOUND });
    await evidence.attach({
      actorAccountId: athlete.accountId,
      evidenceId: r.evidenceId,
      targetType: 'CONTEST',
      targetId: w.contestId,
      role: 'SUPPORTING',
      idempotencyKey: k(),
    });
    const meta = await evidence.metadata({ accountId: w.organizer.ownerAccountId }, r.evidenceId);
    expect(meta.accessBasis).toBe('COMPETITION_STAFF');
    expect(
      (await evidence.content({ accountId: w.organizer.ownerAccountId }, r.evidenceId)).bytes,
    ).toEqual(sheet('K'));
    await expect(
      evidence.metadata({ accountId: other.organizer.ownerAccountId }, r.evidenceId),
    ).rejects.toMatchObject({ code: DomainErrorCode.NOT_FOUND });
    // staff may read but not attach, restrict or raise privacy
    await expect(
      evidence.attach({
        actorAccountId: w.organizer.ownerAccountId,
        evidenceId: r.evidenceId,
        targetType: 'EVENT',
        targetId: w.eventId,
        role: 'CONTEXT',
        idempotencyKey: k(),
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.NOT_FOUND });
    await evidence.raisePrivacy({
      actorAccountId: athlete.accountId,
      evidenceId: r.evidenceId,
      idempotencyKey: k(),
    });
    await expect(
      evidence.metadata({ accountId: w.organizer.ownerAccountId }, r.evidenceId),
    ).rejects.toMatchObject({ code: DomainErrorCode.NOT_FOUND });
    expect(
      (await evidence.metadata({ accountId: athlete.accountId }, r.evidenceId)).privacyClass,
    ).toBe('AUTHORITY_ONLY');
    // content reads are audited (without content)
    expect(
      await count(
        `SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'evidence.content-read' AND target_id = '${r.evidenceId}'`,
      ),
    ).toBe(1);
  });

  it('attachments resolve the true competition; unknown targets are refused; the DB rejects forged competitions', async () => {
    const r = await upload(w.organizer.ownerAccountId, sheet('L'));
    await expect(
      evidence.attach({
        actorAccountId: w.organizer.ownerAccountId,
        evidenceId: r.evidenceId,
        targetType: 'RESULT_VERSION',
        targetId: newId(),
        role: 'PRIMARY',
        idempotencyKey: k(),
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.NOT_FOUND });
    const once = await evidence.attach({
      actorAccountId: w.organizer.ownerAccountId,
      evidenceId: r.evidenceId,
      targetType: 'RESULT_VERSION',
      targetId: w.resultVersionId,
      role: 'PRIMARY',
      idempotencyKey: k(),
    });
    const twice = await evidence.attach({
      actorAccountId: w.organizer.ownerAccountId,
      evidenceId: r.evidenceId,
      targetType: 'RESULT_VERSION',
      targetId: w.resultVersionId,
      role: 'PRIMARY',
      idempotencyKey: k(),
    });
    expect(twice).toEqual({ attachmentId: once.attachmentId, created: false });
    await expect(
      sql`INSERT INTO evidence.attachment (id, evidence_id, target_type, target_id, role, competition_id, attached_by_account_id, fact_hash, recorded_at)
          VALUES (${newId()}, ${r.evidenceId}, 'CONTEST', ${w.contestId}, 'CONTEXT', ${other.competitionId}, ${w.organizer.ownerAccountId},
                  ${hashEvidenceBytes(new Uint8Array([1]))}, platform.tx_time_ms())`.execute(owner),
    ).rejects.toMatchObject({ code: 'BR065' });
  });
});

describe('availability lifecycle, lineage and immutability', () => {
  it('restricted evidence is not inspectable but its descriptor and hash remain; purge keeps metadata', async () => {
    const bytes = sheet('M');
    const a = await upload(w.organizer.ownerAccountId, bytes);
    const b = await upload(w.organizer.ownerAccountId, bytes, {
      source: { kind: 'ORGANIZATION', principalId: orgPrincipalId as never },
    });
    const actor = { accountId: w.organizer.ownerAccountId };
    await evidence.changeAvailability({
      actor,
      evidenceId: a.evidenceId,
      toStatus: 'RESTRICTED',
      reasonCode: 'RIGHTS_OBJECTION',
      idempotencyKey: k(),
    });
    await expect(evidence.content(actor, a.evidenceId)).rejects.toMatchObject({
      code: DomainErrorCode.EVIDENCE_NOT_AVAILABLE,
    });
    const meta = await evidence.metadata(actor, a.evidenceId);
    expect(meta).toMatchObject({
      contentHash: a.contentHash,
      descriptorHash: a.descriptorHash,
      availability: { status: 'RESTRICTED' },
    });
    await evidence.changeAvailability({
      actor,
      evidenceId: a.evidenceId,
      toStatus: 'AVAILABLE',
      reasonCode: 'DECISION_LIFTED',
      idempotencyKey: k(),
    });
    expect((await evidence.content(actor, a.evidenceId)).bytes).toEqual(bytes);
    // purge is INTERNAL only
    await expect(
      evidence.changeAvailability({
        actor,
        evidenceId: a.evidenceId,
        toStatus: 'DELETED_BY_ERASURE',
        reasonCode: 'ERASURE',
        idempotencyKey: k(),
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.NOT_FOUND });
    await evidence.changeAvailability({
      actor: { internal: true },
      evidenceId: a.evidenceId,
      toStatus: 'DELETED_BY_ERASURE',
      reasonCode: 'ERASURE_ORDER',
      basisRef: 'legal:order/1',
      idempotencyKey: k(),
    });
    expect(await blobStore.exists(a.contentHash)).toBe(true); // item b still serves the same blob
    expect((await evidence.content(actor, b.evidenceId)).bytes).toEqual(bytes);
    await evidence.changeAvailability({
      actor: { internal: true },
      evidenceId: b.evidenceId,
      toStatus: 'DELETED_BY_RETENTION',
      reasonCode: 'RETENTION_ELAPSED',
      basisRef: 'policy:retention/1',
      idempotencyKey: k(),
    });
    expect(await blobStore.exists(a.contentHash)).toBe(false);
    for (const id of [a.evidenceId, b.evidenceId]) {
      await expect(evidence.content(actor, id)).rejects.toMatchObject({
        code: DomainErrorCode.EVIDENCE_NOT_AVAILABLE,
      });
      expect((await evidence.metadata(actor, id)).contentHash).toBe(a.contentHash);
    }
    await expect(
      evidence.changeAvailability({
        actor,
        evidenceId: a.evidenceId,
        toStatus: 'AVAILABLE',
        reasonCode: 'UNDO',
        idempotencyKey: k(),
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.INVALID_TRANSITION });
  });

  it('derived / redacted evidence is a new item with immutable lineage; the original is untouched', async () => {
    const actor = w.organizer.ownerAccountId;
    const original = await upload(actor, sheet('N'));
    const redacted = await upload(
      actor,
      new TextEncoder().encode('{"sheet":"N","redacted":true}'),
      {
        lineage: [{ relation: 'REDACTED_FROM', evidenceId: original.evidenceId }],
      },
    );
    const ocr = await upload(actor, new TextEncoder().encode('{"score":"6-4 6-3"}'), {
      evidenceType: 'AI_DERIVED',
      source: { kind: 'AI_PIPELINE', system: { id: 'ocr.fictional', version: '0.1.0' } },
      derivation: {
        generator: { kind: 'OCR', systemId: 'ocr.fictional', version: '0.1.0' },
        inputEvidenceIds: [redacted.evidenceId],
      },
    });
    const meta = await evidence.metadata({ accountId: actor }, original.evidenceId);
    expect(meta.derivatives).toEqual([
      { relation: 'REDACTED_FROM', childEvidenceId: redacted.evidenceId },
    ]);
    expect((await evidence.metadata({ accountId: actor }, ocr.evidenceId)).lineage).toEqual([
      { relation: 'DERIVED_FROM', parentEvidenceId: redacted.evidenceId },
    ]);
    const stranger = await newTestAccount(identity);
    await expect(
      upload(stranger.accountId, sheet('O'), {
        lineage: [{ relation: 'DERIVED_FROM', evidenceId: original.evidenceId }],
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.NOT_FOUND });
    await expect(
      upload(actor, sheet('P'), { evidenceType: 'AI_DERIVED', source: { kind: 'AI_PIPELINE' } }),
    ).rejects.toMatchObject({ code: DomainErrorCode.INVALID_INPUT });
    // A relation that is not declared in the child's descriptor is rejected by the database.
    await expect(
      sql`INSERT INTO evidence.relation (evidence_id, relation, related_evidence_id, related_descriptor_hash, recorded_at)
          VALUES (${ocr.evidenceId}, 'SUPERSEDES', ${original.evidenceId}, ${original.descriptorHash}, platform.tx_time_ms())`.execute(
        owner,
      ),
    ).rejects.toMatchObject({ code: 'BR064' });
  });

  it('every evidence table is append-only (even for the owner); lifecycle rules hold in the database', async () => {
    const r = await upload(w.organizer.ownerAccountId, sheet('Q'));
    for (const q of [
      `UPDATE evidence.item SET media_type = 'text/plain' WHERE id = '${r.evidenceId}'`,
      `DELETE FROM evidence.item WHERE id = '${r.evidenceId}'`,
      `UPDATE evidence.blob SET byte_length = 1 WHERE content_hash = '${r.contentHash}'`,
      `DELETE FROM evidence.availability_change WHERE evidence_id = '${r.evidenceId}'`,
      `UPDATE evidence.privacy_change SET to_class = 'PLATFORM_PRIVATE' WHERE evidence_id = '${r.evidenceId}'`,
      `TRUNCATE evidence.relation`,
      `TRUNCATE evidence.attachment`,
    ]) {
      await expect(sql.raw(q).execute(owner), q).rejects.toMatchObject({ code: 'BR001' });
    }
    await expect(
      sql`INSERT INTO evidence.privacy_change (id, evidence_id, from_class, to_class, fact_hash, recorded_at)
          VALUES (${newId()}, ${r.evidenceId}, 'AUTHORITY_ONLY', 'PLATFORM_PRIVATE', ${r.contentHash}, platform.tx_time_ms())`.execute(
        owner,
      ),
    ).rejects.toMatchObject({ code: 'BR063' });
    await expect(
      sql`INSERT INTO evidence.availability_change (id, evidence_id, from_status, to_status, reason_code, fact_hash, recorded_at)
          VALUES (${newId()}, ${r.evidenceId}, 'RESTRICTED', 'AVAILABLE', 'FORGED', ${r.contentHash}, platform.tx_time_ms())`.execute(
        owner,
      ),
    ).rejects.toMatchObject({ code: 'BR062' });
  });

  it('the encrypted store never holds plaintext; outbox/audit carry no bytes, paths or keys', async () => {
    await upload(w.organizer.ownerAccountId, sheet('R'));
    for (const f of files(root)) {
      expect(readFileSync(f).includes(Buffer.from(SENTINEL))).toBe(false);
    }
    const outbox = JSON.stringify(
      (await sql`SELECT payload FROM platform.outbox_event`.execute(owner)).rows,
    );
    const audit = JSON.stringify(
      (await sql`SELECT details FROM platform.audit_event`.execute(owner)).rows,
    );
    const rows = JSON.stringify((await sql`SELECT * FROM evidence.blob`.execute(owner)).rows);
    for (const text of [outbox, audit, rows]) {
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain(root);
      expect(text).not.toContain(EVIDENCE_KEY);
    }
  });
});

describe('concurrency (real PostgreSQL)', () => {
  it('20 identical ingestions with the same idempotency key → one EvidenceItem, one response', async () => {
    const key = k();
    const bytes = sheet(`S-${newId()}`);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        evidence.ingest({
          actorAccountId: w.organizer.ownerAccountId,
          idempotencyKey: key,
          bytes,
          mediaType: 'application/json',
          evidenceType: 'SIGNED_SCORESHEET',
          source: { kind: 'HUMAN' },
        }),
      ),
    );
    expect(new Set(results.map((r) => r.evidenceId)).size).toBe(1);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM evidence.item WHERE content_hash = '${hashEvidenceBytes(bytes)}'`,
      ),
    ).toBe(1);
  });

  it('20 independent provenances over identical bytes → one blob, 20 items; no raw SQL errors', async () => {
    const bytes = sheet(`T-${newId()}`);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        upload(w.organizer.ownerAccountId, bytes, {
          source: {
            kind: 'HUMAN',
            externalNamespace: 'fictional-scorer',
            externalId: `sheet-${i}`,
          },
        }),
      ),
    );
    expect(new Set(results.map((r) => r.evidenceId)).size).toBe(20);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM evidence.blob WHERE content_hash = '${hashEvidenceBytes(bytes)}'`,
      ),
    ).toBe(1);
    // the same 20 provenances again (new keys, concurrently) → the same 20 items
    const again = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        upload(w.organizer.ownerAccountId, bytes, {
          source: {
            kind: 'HUMAN',
            externalNamespace: 'fictional-scorer',
            externalId: `sheet-${i}`,
          },
        }),
      ),
    );
    expect(again.every((r) => !r.created)).toBe(true);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM evidence.item WHERE content_hash = '${hashEvidenceBytes(bytes)}'`,
      ),
    ).toBe(20);
  });
});
