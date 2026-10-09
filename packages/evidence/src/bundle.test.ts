import { hashEvidenceBytes } from '@br/canonical';
import { newId, type Uuid } from '@br/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildAttestationStatement, buildEvidenceBundle, type BundleFacts } from './index';

const t = (m: number) => new Date(Date.UTC(2026, 4, 14, 18, 0, 0) + m * 60_000);
const h = (s: string) => hashEvidenceBytes(new TextEncoder().encode(s));

function world() {
  const rv = newId();
  const contest = newId();
  const e1 = newId();
  const e2 = newId();
  const e3 = newId(); // derived from e1
  const keyId = newId();
  const principalId = newId();
  const statement = (over: { nonce: string; polarity: 'AFFIRM' | 'DENY'; refs: string[] }) =>
    buildAttestationStatement({
      audience: 'bragging-rights:test',
      issuer: { principalId: principalId as Uuid, keyId: keyId as Uuid },
      subject: { type: 'RESULT_VERSION', id: rv as Uuid, hash: h('rv') },
      claim: { type: 'RESULT_ACCURATE', polarity: over.polarity },
      evidenceRefs: over.refs.map((id) => ({
        evidenceId: id as Uuid,
        contentHash: h(`c${id}`),
        descriptorHash: h(`d${id}`),
      })),
      nonce: over.nonce,
      signedAt: t(10),
      expiresAt: t(20),
    });
  const a1 = statement({ nonce: 'AAAAAAAAAAAAAAAAAAAAAA', polarity: 'AFFIRM', refs: [e1] });
  const a2 = statement({ nonce: 'BAAAAAAAAAAAAAAAAAAAAA', polarity: 'DENY', refs: [e2] });
  const item = (
    id: string,
    recorded: number,
    lineage: BundleFacts['evidence'][number]['lineage'] = [],
  ) => ({
    evidenceId: id,
    evidenceType: 'SIGNED_SCORESHEET',
    descriptorHash: h(`d${id}`),
    contentHash: h(`c${id}`),
    byteLength: 10,
    mediaType: 'application/json',
    source: { kind: 'HUMAN', capturedAtAssurance: 'SOURCE_CLAIMED' },
    lineage,
    receivedAt: t(recorded),
    recordedAt: t(recorded),
  });
  const facts: BundleFacts = {
    resultVersion: {
      resultVersionId: rv,
      resultId: newId(),
      versionNumber: 1,
      contentHash: h('rv'),
      contentSchema: 'br:result-version-content@1',
      scope: {
        scopeType: 'CONTEST',
        scopeTargetId: contest,
        contestId: contest,
        competitionId: newId(),
        eventId: newId(),
      },
    },
    evidence: [
      item(e1, 1),
      item(e2, 2),
      item(e3, 3, [{ relation: 'REDACTED_FROM', evidenceId: e1, descriptorHash: h(`d${e1}`) }]),
      item(newId(), 4), // unrelated: never included
    ],
    availabilityChanges: [e1, e2, e3].flatMap((id, i) => [
      { evidenceId: id, toStatus: 'AVAILABLE' as const, recordedAt: t(i + 1), seq: i * 10 + 1 },
    ]),
    privacyChanges: [e1, e2, e3].map((id, i) => ({
      evidenceId: id,
      toClass: 'PLATFORM_PRIVATE' as const,
      recordedAt: t(i + 1),
      seq: i * 10 + 1,
    })),
    attachments: [
      {
        attachmentId: newId(),
        evidenceId: e3,
        targetType: 'RESULT_VERSION',
        targetId: rv,
        role: 'PRIMARY',
        recordedAt: t(5),
      },
      {
        attachmentId: newId(),
        evidenceId: e2,
        targetType: 'RESULT_VERSION',
        targetId: newId(),
        role: 'PRIMARY',
        recordedAt: t(5),
      },
    ],
    attestations: [
      {
        attestationId: newId(),
        statementHash: a1.statementHash,
        statement: a1.statement,
        issuerPrincipalType: 'ORGANIZATION',
        algorithm: 'EdDSA',
        proofType: 'DIRECT_SIGNATURE',
        proofScheme: 'JWS_DETACHED',
        assurance: 'HOLDER_KEY',
        verifierId: 'jws-detached/v1',
        proofHash: h('proof'),
        issuedAt: t(10),
        recordedAt: t(10),
      },
      {
        attestationId: newId(),
        statementHash: a2.statementHash,
        statement: a2.statement,
        issuerPrincipalType: 'ORGANIZATION',
        algorithm: 'EdDSA',
        proofType: 'DIRECT_SIGNATURE',
        proofScheme: 'JWS_DETACHED',
        assurance: 'HOLDER_KEY',
        verifierId: 'jws-detached/v1',
        proofHash: h('proof'),
        issuedAt: t(30),
        recordedAt: t(30),
      },
    ],
    retractions: [],
    keys: [
      {
        keyId,
        principalId,
        factHash: h('key'),
        verificationMaterialHash: h('material'),
        keyKind: 'JWK',
        algorithm: 'EdDSA',
        effectiveFrom: t(0),
        recordedAt: t(0),
      },
    ],
    keyStatusChanges: [],
  };
  return { facts, e1, e2, e3, keyId };
}

const shuffle = <T>(xs: readonly T[], seed: number): T[] => {
  const out = [...xs];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
};

describe('deterministic Evidence Bundle', () => {
  it('same facts + same asOf ⇒ identical canonical bytes and hash; no verdict inside', () => {
    const { facts } = world();
    const a = buildEvidenceBundle(facts, t(40));
    const b = buildEvidenceBundle(facts, t(40));
    expect(a.canonicalText).toBe(b.canonicalText);
    expect(a.bundleHash).toBe(b.bundleHash);
    expect(a.canonicalText).not.toMatch(/"(level|verdict|verified|score|trust|V[0-4])"/);
  });

  it('includes attached, cited and lineage evidence only; conflicting attestations coexist', () => {
    const { facts, e1, e2, e3 } = world();
    const b = buildEvidenceBundle(facts, t(40)).bundle as {
      evidence: { evidenceId: string; inclusion: string[] }[];
      attestations: { claim: { polarity: string } }[];
      lineage: unknown[];
    };
    const by = Object.fromEntries(b.evidence.map((e) => [e.evidenceId, e.inclusion]));
    expect(Object.keys(by).sort()).toEqual([e1, e2, e3].sort());
    expect(by[e1]).toEqual(['CITED', 'LINEAGE']);
    expect(by[e2]).toEqual(['CITED']); // its attachment to ANOTHER version is not pulled in
    expect(by[e3]).toEqual(['ATTACHED']);
    expect(b.attestations.map((a) => a.claim.polarity).sort()).toEqual(['AFFIRM', 'DENY']);
    expect(b.lineage).toHaveLength(1);
  });

  it('property: output never depends on load / insertion order', () => {
    const { facts } = world();
    const expected = buildEvidenceBundle(facts, t(40)).bundleHash;
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (seed) => {
        const shuffled: BundleFacts = {
          ...facts,
          evidence: shuffle(facts.evidence, seed),
          attachments: shuffle(facts.attachments, seed + 1),
          attestations: shuffle(facts.attestations, seed + 2),
          availabilityChanges: shuffle(facts.availabilityChanges, seed + 3),
          privacyChanges: shuffle(facts.privacyChanges, seed + 4),
        };
        return buildEvidenceBundle(shuffled, t(40)).bundleHash === expected;
      }),
      { numRuns: 50 },
    );
  });

  it('as-of semantics: history is never erased, and one logical fact changes the hash', () => {
    const { facts, e1, keyId } = world();
    const atT1 = buildEvidenceBundle(facts, t(15));
    const atT2 = buildEvidenceBundle(facts, t(40));
    expect(atT1.bundleHash).not.toBe(atT2.bundleHash); // A2 recorded at t(30)
    expect((atT1.bundle as { attestations: unknown[] }).attestations).toHaveLength(1);

    const a1 = facts.attestations[0]!;
    const retracted: BundleFacts = {
      ...facts,
      retractions: [
        {
          retractionId: newId(),
          attestationId: a1.attestationId,
          statementHash: h('ret'),
          proofHash: h('retraction-proof'),
          keyId,
          reasonCode: 'WITHDRAWN',
          issuedAt: t(50),
          recordedAt: t(50),
        },
      ],
    };
    expect(buildEvidenceBundle(retracted, t(40)).bundleHash).toBe(atT2.bundleHash); // not yet known
    const after = buildEvidenceBundle(retracted, t(60));
    expect(after.bundleHash).not.toBe(atT2.bundleHash);
    expect(after.canonicalText).toContain('"retraction"');

    const restricted: BundleFacts = {
      ...facts,
      availabilityChanges: [
        ...facts.availabilityChanges,
        { evidenceId: e1, toStatus: 'RESTRICTED', recordedAt: t(35), seq: 99 },
      ],
    };
    expect(buildEvidenceBundle(restricted, t(40)).bundleHash).not.toBe(atT2.bundleHash);
    expect(buildEvidenceBundle(restricted, t(34)).bundleHash).toBe(
      buildEvidenceBundle(facts, t(34)).bundleHash,
    );

    const compromised: BundleFacts = {
      ...facts,
      keyStatusChanges: [
        {
          statusChangeId: newId(),
          keyId,
          kind: 'COMPROMISED',
          effectiveFrom: t(5),
          recordedAt: t(45),
          factHash: h('ks'),
        },
      ],
    };
    expect(buildEvidenceBundle(compromised, t(40)).bundleHash).toBe(atT2.bundleHash); // "as known then"
    expect(buildEvidenceBundle(compromised, t(50)).canonicalText).toContain('COMPROMISED'); // "as known now"
  });
});
