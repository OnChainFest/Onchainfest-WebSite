import { hashEvidenceBytes } from '@br/canonical';
import { canChangeAvailability, DomainErrorCode, newId, type Uuid } from '@br/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildEvidenceDescriptor,
  checkEvidenceMedia,
  decideEvidenceAccess,
  decodeStrictBase64,
  hashDescriptorDocument,
  type EvidenceAccessFacts,
  type EvidenceDescriptorInput,
} from './index';

const bytes = new TextEncoder().encode('{"score":"6-4 6-3"}');
const T = new Date('2026-05-14T18:03:07.120Z');

const base = (over: Partial<EvidenceDescriptorInput> = {}): EvidenceDescriptorInput => ({
  evidenceId: '0190f4c2-0000-7000-8000-000000000001' as Uuid,
  evidenceType: 'SIGNED_SCORESHEET',
  contentHash: hashEvidenceBytes(bytes),
  byteLength: bytes.length,
  mediaType: 'application/json',
  source: { kind: 'HUMAN', capturedAt: new Date('2026-05-14T18:00:00.000Z') },
  acquisition: { method: 'REFERENCE_UPLOAD', receivedAt: T },
  ...over,
});

describe('EvidenceDescriptor canonicalization and hashing', () => {
  it('content hash is plain SHA-256 of the exact bytes (sha256sum-compatible)', () => {
    expect(hashEvidenceBytes(new TextEncoder().encode('abc'))).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('same semantic descriptor → same canonical bytes and hash, whatever the member order', () => {
    const a = buildEvidenceDescriptor(base());
    const doc = JSON.parse(a.canonicalText) as Record<string, unknown>;
    const reversed = Object.fromEntries(Object.entries(doc).reverse());
    const b = hashDescriptorDocument(reversed);
    expect(b.descriptorHash).toBe(a.descriptorHash);
    expect(b.canonicalText).toBe(a.canonicalText);
  });

  it('property: object-key reordering never changes the hash', () => {
    const doc = JSON.parse(buildEvidenceDescriptor(base()).canonicalText) as Record<
      string,
      unknown
    >;
    const expected = hashDescriptorDocument(doc).descriptorHash;
    fc.assert(
      fc.property(
        fc.shuffledSubarray(Object.keys(doc), { minLength: Object.keys(doc).length }),
        (keys) => {
          const shuffled = Object.fromEntries(keys.map((k) => [k, doc[k]]));
          return hashDescriptorDocument(shuffled).descriptorHash === expected;
        },
      ),
    );
  });

  it('property: changing any committed field changes the hash', () => {
    const h = buildEvidenceDescriptor(base()).descriptorHash;
    const variants: Partial<EvidenceDescriptorInput>[] = [
      { evidenceId: newId() },
      { evidenceType: 'OFFICIAL_REPORT' },
      { contentHash: hashEvidenceBytes(new Uint8Array([1])) },
      { byteLength: bytes.length + 1 },
      { mediaType: 'text/plain' },
      { source: { kind: 'ORGANIZATION', principalId: newId() } },
      { source: { kind: 'HUMAN', capturedAt: new Date('2026-05-14T17:00:00.000Z') } },
      { acquisition: { method: 'REFERENCE_UPLOAD', receivedAt: new Date(T.getTime() + 1) } },
    ];
    for (const v of variants) expect(buildEvidenceDescriptor(base(v)).descriptorHash).not.toBe(h);
  });

  it('two sources over the same bytes are two different descriptors (provenance is never collapsed)', () => {
    const a = buildEvidenceDescriptor(base({ evidenceId: newId(), source: { kind: 'HUMAN' } }));
    const b = buildEvidenceDescriptor(
      base({ evidenceId: newId(), source: { kind: 'ORGANIZATION', principalId: newId() } }),
    );
    expect(a.descriptor.content.sha256).toBe(b.descriptor.content.sha256);
    expect(a.descriptorHash).not.toBe(b.descriptorHash);
  });

  it('refuses unverifiable capture assurance, future captures and unknown members', () => {
    expect(() =>
      buildEvidenceDescriptor(
        base({ source: { kind: 'DEVICE', capturedAtAssurance: 'DEVICE_SIGNED' } }),
      ),
    ).toThrow(/SOURCE_CLAIMED/);
    expect(() =>
      buildEvidenceDescriptor(
        base({ source: { kind: 'HUMAN', capturedAt: new Date(T.getTime() + 10 * 60_000) } }),
      ),
    ).toThrow(/capturedAt/);
    const doc = JSON.parse(buildEvidenceDescriptor(base()).canonicalText) as Record<
      string,
      unknown
    >;
    expect(() => hashDescriptorDocument({ ...doc, trusted: true })).toThrow(/rejected/);
    expect(() =>
      hashDescriptorDocument({ ...doc, source: { ...(doc.source as object), kind: 'TRUSTED' } }),
    ).toThrow(/rejected/);
  });

  it('machine-derived evidence must name its generator and inputs (E-4) and inputs are lineage', () => {
    const parent = {
      evidenceId: newId(),
      descriptorHash: buildEvidenceDescriptor(base()).descriptorHash,
    };
    expect(() =>
      buildEvidenceDescriptor(
        base({ evidenceType: 'AI_DERIVED', source: { kind: 'AI_PIPELINE' } }),
      ),
    ).toThrow(/AI-derived/);
    const derivation = {
      generator: { kind: 'OCR' as const, systemId: 'ocr.fictional', version: '1.0.0' },
      inputs: [{ evidenceId: parent.evidenceId, contentHash: hashEvidenceBytes(bytes) }],
    };
    expect(() =>
      buildEvidenceDescriptor(
        base({ evidenceType: 'AI_DERIVED', source: { kind: 'AI_PIPELINE' }, derivation }),
      ),
    ).toThrow(/lineage/);
    const ok = buildEvidenceDescriptor(
      base({
        evidenceType: 'AI_DERIVED',
        source: { kind: 'AI_PIPELINE' },
        derivation,
        lineage: [{ relation: 'DERIVED_FROM', ...parent }],
      }),
    );
    expect(ok.descriptor.lineage).toHaveLength(1);
  });

  it('lineage is a set: order-independent, duplicates rejected, no self-parent', () => {
    const p1 = {
      relation: 'DERIVED_FROM' as const,
      evidenceId: newId(),
      descriptorHash: hashEvidenceBytes(new Uint8Array([1])),
    };
    const p2 = {
      relation: 'REDACTED_FROM' as const,
      evidenceId: newId(),
      descriptorHash: hashEvidenceBytes(new Uint8Array([2])),
    };
    expect(buildEvidenceDescriptor(base({ lineage: [p1, p2] })).descriptorHash).toBe(
      buildEvidenceDescriptor(base({ lineage: [p2, p1] })).descriptorHash,
    );
    expect(() => buildEvidenceDescriptor(base({ lineage: [p1, p1] }))).toThrow();
    expect(() =>
      buildEvidenceDescriptor(base({ lineage: [{ ...p1, evidenceId: base().evidenceId }] })),
    ).toThrow(/own lineage/);
  });
});

describe('media safety (bounded reference ingestion)', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  it('accepts allow-listed types whose leading bytes match', () => {
    expect(checkEvidenceMedia('application/json', enc(' {"a":1}')).ok).toBe(true);
    expect(checkEvidenceMedia('text/plain', enc('score 6-4')).ok).toBe(true);
    expect(checkEvidenceMedia('application/pdf', enc('%PDF-1.7\n...')).ok).toBe(true);
    expect(
      checkEvidenceMedia(
        'image/png',
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]),
      ).ok,
    ).toBe(true);
    expect(checkEvidenceMedia('image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0])).ok).toBe(
      true,
    );
    expect(
      checkEvidenceMedia('video/mp4', new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69]))
        .ok,
    ).toBe(true);
  });
  it('refuses active content, executables, archives and spoofed labels', () => {
    for (const t of [
      'text/html',
      'image/svg+xml',
      'application/javascript',
      'application/zip',
      'text/plain; charset=utf-8',
    ])
      expect(checkEvidenceMedia(t, enc('x'))).toEqual({ ok: false, reason: 'TYPE_NOT_ALLOWED' });
    expect(checkEvidenceMedia('text/plain', enc('<html><script>alert(1)</script>')).ok).toBe(false);
    expect(checkEvidenceMedia('text/plain', enc('  <svg onload=x>')).ok).toBe(false);
    expect(checkEvidenceMedia('application/json', enc('<?xml?>')).ok).toBe(false);
    expect(checkEvidenceMedia('application/pdf', enc('<html>')).ok).toBe(false);
    expect(checkEvidenceMedia('image/png', enc('MZ\x90\x00')).ok).toBe(false);
    expect(checkEvidenceMedia('text/plain', new Uint8Array([0x50, 0x4b, 0x03, 0x04])).ok).toBe(
      false,
    );
    expect(checkEvidenceMedia('text/plain', new Uint8Array([0x61, 0x00, 0x62])).ok).toBe(false);
    expect(checkEvidenceMedia('text/plain', new Uint8Array([0xc3, 0x28])).ok).toBe(false);
    expect(checkEvidenceMedia('text/plain', new Uint8Array())).toEqual({
      ok: false,
      reason: 'EMPTY',
    });
  });
  it('base64 decoding is strict', () => {
    expect(decodeStrictBase64('YWJj')).toEqual(new Uint8Array([0x61, 0x62, 0x63]));
    for (const bad of ['YWJ', 'YW Jj', 'YWJj\n', '****', 'YQ=a'])
      expect(decodeStrictBase64(bad)).toBeUndefined();
  });
});

describe('availability lifecycle (append-only, ADR-0018)', () => {
  it('implements restrict/restore and terminal deletion only', () => {
    expect(canChangeAvailability('AVAILABLE', 'RESTRICTED')).toBe(true);
    expect(canChangeAvailability('RESTRICTED', 'AVAILABLE')).toBe(true);
    expect(canChangeAvailability('AVAILABLE', 'DELETED_BY_ERASURE')).toBe(true);
    expect(canChangeAvailability('DELETED_BY_ERASURE', 'AVAILABLE')).toBe(false);
    expect(canChangeAvailability('DELETED_BY_RETENTION', 'RESTRICTED')).toBe(false);
    expect(canChangeAvailability('AVAILABLE', 'ARCHIVED')).toBe(false);
  });
});

describe('centralized evidence access policy', () => {
  const facts = (over: {
    submitter?: string | null;
    privacy?: 'PLATFORM_PRIVATE' | 'AUTHORITY_ONLY';
    attached?: string[];
    actor?: string;
    represents?: boolean;
    perms?: Record<string, string[]>;
    active?: boolean;
  }): EvidenceAccessFacts => ({
    evidence: {
      submittedByAccountId: over.submitter === undefined ? 'A' : over.submitter,
      privacyClass: over.privacy ?? 'PLATFORM_PRIVATE',
      attachedCompetitionIds: over.attached ?? [],
    },
    actor: {
      kind: 'ACCOUNT',
      accountId: over.actor ?? 'A',
      accountActive: over.active ?? true,
      representsSource: over.represents ?? false,
      competitionPermissions: new Map(
        Object.entries(over.perms ?? {}).map(([k, v]) => [k, new Set(v)]),
      ),
    },
  });
  it('submitter and source representative: all but purge', () => {
    expect(decideEvidenceAccess(facts({}), 'READ_CONTENT')).toEqual({
      allowed: true,
      basis: 'SUBMITTER',
    });
    expect(decideEvidenceAccess(facts({ actor: 'B', represents: true }), 'ATTACH')).toEqual({
      allowed: true,
      basis: 'SOURCE_REPRESENTATIVE',
    });
    expect(decideEvidenceAccess(facts({}), 'PURGE').allowed).toBe(false);
  });
  it('another account cannot read private evidence (IDOR)', () => {
    for (const p of ['VIEW_METADATA', 'READ_CONTENT', 'CITE', 'ATTACH', 'RESTRICT'] as const)
      expect(decideEvidenceAccess(facts({ actor: 'B' }), p).allowed).toBe(false);
  });
  it('competition staff: only for competitions the item is attached to, PLATFORM_PRIVATE only, read-only', () => {
    const staffC1 = { actor: 'S', attached: ['C1'], perms: { C1: ['COMP_VIEW_PRIVATE'] } };
    expect(decideEvidenceAccess(facts(staffC1), 'READ_CONTENT')).toEqual({
      allowed: true,
      basis: 'COMPETITION_STAFF',
    });
    expect(decideEvidenceAccess(facts(staffC1), 'ATTACH').allowed).toBe(false);
    expect(
      decideEvidenceAccess(facts({ ...staffC1, attached: ['C2'] }), 'READ_CONTENT').allowed,
    ).toBe(false);
    expect(
      decideEvidenceAccess(facts({ ...staffC1, privacy: 'AUTHORITY_ONLY' }), 'READ_CONTENT')
        .allowed,
    ).toBe(false);
    expect(
      decideEvidenceAccess(
        facts({ ...staffC1, perms: { C1: ['COMP_MANAGE_SCHEDULE'] } }),
        'READ_CONTENT',
      ).allowed,
    ).toBe(false);
  });
  it('a disabled account gets nothing; internal system access is explicit', () => {
    expect(decideEvidenceAccess(facts({ active: false }), 'VIEW_METADATA').allowed).toBe(false);
    expect(
      decideEvidenceAccess({ ...facts({}), actor: { kind: 'INTERNAL_SYSTEM' } }, 'PURGE'),
    ).toEqual({ allowed: true, basis: 'INTERNAL_SYSTEM' });
  });
  it('error vocabulary exists for fail-closed storage', () => {
    expect(DomainErrorCode.EVIDENCE_STORAGE_UNAVAILABLE).toBe('EVIDENCE_STORAGE_UNAVAILABLE');
  });
});
