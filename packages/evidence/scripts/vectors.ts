import { readFileSync } from 'node:fs';
import {
  createECDH,
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CanonicalError } from '@br/canonical';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';
import { jwkThumbprint, parsePublicJwk, protectedHeaderFor, signaturePayload } from '../src/proof';

/**
 * BRT-06 cross-language test vectors: EvidenceDescriptor hash, AttestationStatement hash (plus
 * retraction and key-registration statements) and the JWS_DETACHED signing preimage, with accepted
 * and rejected/tampered cases. Everything is deterministic (fixed ids, times, nonces, and a
 * DELIBERATELY PUBLIC Ed25519 test key derived from the documented label below, so the Ed25519
 * signatures are reproducible). That key can never be registered as a PrincipalKey.
 *
 * The existing BR-JSON v1 corpus (packages/canonical/test-vectors) is untouched.
 */
export const VECTORS_FILE = fileURLToPath(
  new URL('../test-vectors/brt-06.vectors.json', import.meta.url),
);
export const VECTOR_KEY_LABEL = 'BRT-06 PUBLIC TEST VECTOR KEY - NOT SECRET - NEVER REGISTER';
export const ES256_VECTOR_KEY_LABEL =
  'BRT-06 PUBLIC ES256 TEST VECTOR KEY - NOT SECRET - NEVER REGISTER';
const P256_N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

export interface VectorKey {
  readonly alg: 'EdDSA' | 'ES256';
  readonly privateKey: KeyObject;
  readonly publicJwk: Record<string, string>;
  readonly derivation: string;
}

/** Ed25519 key from a 32-byte seed = SHA-256(label) (RFC 8410 PKCS#8 wrapping). */
export function vectorKey(): VectorKey {
  const seed = createHash('sha256').update(VECTOR_KEY_LABEL, 'utf8').digest();
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const jwk = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  return {
    alg: 'EdDSA',
    privateKey,
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x as string },
    derivation: `Ed25519 seed = SHA-256(UTF-8 "${VECTOR_KEY_LABEL}")`,
  };
}

/** P-256 key with d = (SHA-256(label) mod (n − 1)) + 1. */
export function es256VectorKey(): VectorKey {
  const h = BigInt(
    `0x${createHash('sha256').update(ES256_VECTOR_KEY_LABEL, 'utf8').digest('hex')}`,
  );
  const d = Buffer.from(((h % (P256_N - 1n)) + 1n).toString(16).padStart(64, '0'), 'hex');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  const point = ecdh.getPublicKey(); // 04 ‖ x ‖ y
  const x = point.subarray(1, 33).toString('base64url');
  const y = point.subarray(33, 65).toString('base64url');
  const privateKey = createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x, y, d: d.toString('base64url') },
    format: 'jwk',
  });
  return {
    alg: 'ES256',
    privateKey,
    publicJwk: { kty: 'EC', crv: 'P-256', x, y },
    derivation: `P-256 d = (SHA-256(UTF-8 "${ES256_VECTOR_KEY_LABEL}") mod (n - 1)) + 1`,
  };
}

/** ECDSA signatures are randomized: a committed ES256 signature is reused while it still verifies. */
function previousSignatures(): Map<string, string> {
  try {
    const doc = JSON.parse(readFileSync(VECTORS_FILE, 'utf8')) as {
      signing?: { alg: string; signingInput: string; signature: string }[];
    };
    const map = new Map<string, string>();
    // First entry per input wins (DER/truncated reject vectors reuse the accept input on purpose).
    for (const v of doc.signing ?? [])
      if (v.alg === 'ES256' && !map.has(v.signingInput)) map.set(v.signingInput, v.signature);
    return map;
  } catch {
    return new Map();
  }
}

function signWith(key: VectorKey, input: string, previous: Map<string, string>): string {
  const data = Buffer.from(input, 'ascii');
  if (key.alg === 'EdDSA') return sign(null, data, key.privateKey).toString('base64url');
  const old = previous.get(input);
  const publicKey = createPublicKey({ key: key.publicJwk, format: 'jwk' });
  if (
    old !== undefined &&
    verify(
      'sha256',
      data,
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(old, 'base64url'),
    )
  )
    return old;
  return sign('sha256', data, { key: key.privateKey, dsaEncoding: 'ieee-p1363' }).toString(
    'base64url',
  );
}

/** DER encoding of an r‖s signature (what JWS forbids). */
function toDer(rs: Buffer): Buffer {
  const int = (b: Buffer) => {
    let v = b;
    while (v.length > 1 && v[0] === 0 && (v[1] as number) < 0x80) v = v.subarray(1);
    if ((v[0] as number) >= 0x80) v = Buffer.concat([Buffer.from([0]), v]);
    return Buffer.concat([Buffer.from([0x02, v.length]), v]);
  };
  const body = Buffer.concat([int(rs.subarray(0, 32)), int(rs.subarray(32))]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

const EVIDENCE_A = '0190f4c2-6f1a-7c3e-8a51-000000000a01';
const EVIDENCE_B = '0190f4c2-6f1a-7c3e-8a51-000000000b02';
const RESULT_VERSION = '0190f4c2-6f1a-7c3e-8a51-0000000000e1';
const PRINCIPAL = '0190f4c2-6f1a-7c3e-8a51-0000000000c1';
const KEY = '0190f4c2-6f1a-7c3e-8a51-0000000000d1';
const hashOf = (s: string) => `sha256:${createHash('sha256').update(s, 'utf8').digest('hex')}`;

type Kind =
  | 'evidence-descriptor'
  | 'attestation-statement'
  | 'attestation-retraction-statement'
  | 'key-registration-statement';
const KINDS: Record<Kind, { schema: { id: string; version: number }; domainTag: string }> = {
  'evidence-descriptor': {
    schema: SchemaRef.evidenceDescriptor,
    domainTag: DomainTag.evidenceDescriptor,
  },
  'attestation-statement': {
    schema: SchemaRef.attestationStatement,
    domainTag: DomainTag.attestationStatement,
  },
  'attestation-retraction-statement': {
    schema: SchemaRef.attestationRetractionStatement,
    domainTag: DomainTag.attestationRetraction,
  },
  'key-registration-statement': {
    schema: SchemaRef.keyRegistrationStatement,
    domainTag: DomainTag.keyRegistration,
  },
};

const descriptor = {
  source: {
    capturedAtAssurance: 'SOURCE_CLAIMED',
    kind: 'ORGANIZATION',
    principalId: PRINCIPAL,
    capturedAt: '2026-05-14T20:00:00+02:00',
  },
  evidenceType: 'SIGNED_SCORESHEET',
  evidenceId: EVIDENCE_A,
  content: {
    mediaType: 'application/pdf',
    byteLength: 48213,
    sha256: hashOf('fictional score sheet bytes'),
  },
  acquisition: { receivedAt: '2026-05-14T18:03:07.12Z', method: 'REFERENCE_UPLOAD' },
};
const derived = {
  evidenceId: EVIDENCE_B,
  evidenceType: 'AI_DERIVED',
  content: {
    sha256: hashOf('fictional ocr output'),
    byteLength: 311,
    mediaType: 'application/json',
  },
  source: {
    kind: 'AI_PIPELINE',
    system: { id: 'ocr.fictional', version: '0.1.0' },
    capturedAtAssurance: 'SOURCE_CLAIMED',
  },
  acquisition: { method: 'PLATFORM_DERIVATION', receivedAt: '2026-05-14T18:05:00.000Z' },
  derivation: {
    generator: { kind: 'OCR', systemId: 'ocr.fictional', version: '0.1.0' },
    inputs: [{ evidenceId: EVIDENCE_A, contentHash: hashOf('fictional score sheet bytes') }],
  },
  lineage: [
    {
      relation: 'REDACTED_FROM',
      evidenceId: EVIDENCE_A,
      descriptorHash: hashOf('parent-descriptor'),
    },
    {
      relation: 'DERIVED_FROM',
      evidenceId: EVIDENCE_A,
      descriptorHash: hashOf('parent-descriptor'),
    },
  ],
};
const refA = {
  evidenceId: EVIDENCE_A,
  contentHash: hashOf('fictional score sheet bytes'),
  descriptorHash: hashOf('descriptor-a'),
};
const refB = {
  evidenceId: EVIDENCE_B,
  contentHash: hashOf('fictional ocr output'),
  descriptorHash: hashOf('descriptor-b'),
};
const statement = {
  v: 1,
  purpose: 'attestation',
  audience: 'bragging-rights:prod',
  issuer: { principalId: PRINCIPAL, keyId: KEY },
  subject: { type: 'RESULT_VERSION', id: RESULT_VERSION, hash: hashOf('result-version-content') },
  claim: { type: 'RESULT_ACCURATE', polarity: 'AFFIRM' },
  authorityContext: { actingRole: 'OFFICIAL' },
  evidenceRefs: [refA, refB],
  nonce: 'q4Zr0f1sQ0-8b7dDk2JH3g',
  signedAt: '2026-05-14T18:10:00.000Z',
  expiresAt: '2026-05-14T18:20:00.000Z',
};

interface Vector {
  id: string;
  kind: Kind;
  description: string;
  input: unknown;
  expect: 'accept' | 'reject';
  schema: { id: string; version: number };
  domainTag: string;
  normalized?: unknown;
  canonical?: string;
  hash?: string;
  error?: string;
}

function canonicalVector(id: string, kind: Kind, description: string, input: unknown): Vector {
  const k = KINDS[kind];
  const base = { id, kind, description, input, schema: k.schema, domainTag: k.domainTag };
  try {
    const r = platformCanonicalizer().hashCanonical(
      k.domainTag,
      k.schema.id,
      k.schema.version,
      input,
    );
    return {
      ...base,
      expect: 'accept',
      normalized: r.normalized,
      canonical: r.canonicalText,
      hash: r.contentHash,
    };
  } catch (err) {
    if (err instanceof CanonicalError) return { ...base, expect: 'reject', error: err.code };
    throw err;
  }
}

export function generateBrt06Vectors() {
  const canonical: Vector[] = [
    canonicalVector(
      'descriptor-basic',
      'evidence-descriptor',
      'Organization-sourced score sheet; members out of order, capturedAt with an offset',
      descriptor,
    ),
    canonicalVector(
      'descriptor-derived-lineage',
      'evidence-descriptor',
      'AI-derived (OCR) item with generator, inputs and a lineage SET given out of order',
      derived,
    ),
    canonicalVector(
      'descriptor-derived-lineage-sorted',
      'evidence-descriptor',
      'Same as descriptor-derived-lineage with lineage pre-sorted (same hash)',
      { ...derived, lineage: [...derived.lineage].reverse() },
    ),
    canonicalVector(
      'descriptor-reject-unknown-member',
      'evidence-descriptor',
      'A "trusted" member does not exist (closed schema)',
      { ...descriptor, trusted: true },
    ),
    canonicalVector(
      'descriptor-reject-trusted-kind',
      'evidence-descriptor',
      'No TRUSTED / VERIFIED source kind exists',
      { ...descriptor, source: { ...descriptor.source, kind: 'TRUSTED' } },
    ),
    canonicalVector(
      'descriptor-reject-duplicate-lineage',
      'evidence-descriptor',
      'Duplicate lineage edges are rejected, never de-duplicated',
      { ...derived, lineage: [derived.lineage[0], derived.lineage[0]] },
    ),
    canonicalVector(
      'descriptor-reject-client-hash',
      'evidence-descriptor',
      'A content hash must be sha256:<64 lowercase hex>',
      { ...descriptor, content: { ...descriptor.content, sha256: 'SHA256:ABC' } },
    ),
    canonicalVector(
      'statement-basic',
      'attestation-statement',
      'RESULT_ACCURATE / AFFIRM over an exact ResultVersion, citing two evidence items',
      statement,
    ),
    canonicalVector(
      'statement-evidence-order',
      'attestation-statement',
      'Same statement with evidenceRefs reversed (a set: same hash)',
      { ...statement, evidenceRefs: [refB, refA] },
    ),
    canonicalVector(
      'statement-conditions',
      'attestation-statement',
      'CONDITIONS_COMPLIANT observation (wind +1.2 m/s normalizes to "1.2")',
      {
        ...statement,
        claim: {
          type: 'CONDITIONS_COMPLIANT',
          polarity: 'AFFIRM',
          payload: {
            conditions: [{ aspect: 'WIND', key: 'wind.speed', value: '+1.20', unit: 'm/s' }],
          },
        },
      },
    ),
    canonicalVector(
      'statement-reject-duplicate-ref',
      'attestation-statement',
      'Duplicate evidence references are rejected',
      { ...statement, evidenceRefs: [refA, refA] },
    ),
    canonicalVector(
      'statement-reject-verified-claim',
      'attestation-statement',
      'There is no "verified" claim type',
      { ...statement, claim: { type: 'RESULT_VERIFIED', polarity: 'AFFIRM' } },
    ),
    canonicalVector(
      'statement-reject-wrong-purpose',
      'attestation-statement',
      'An attestation statement must declare purpose "attestation"',
      { ...statement, purpose: 'key-registration' },
    ),
    canonicalVector(
      'retraction-basic',
      'attestation-retraction-statement',
      'Signed retraction of an exact attestation statement',
      {
        v: 1,
        purpose: 'attestation-retraction',
        audience: 'bragging-rights:prod',
        issuer: { principalId: PRINCIPAL, keyId: KEY },
        subject: {
          type: 'ATTESTATION',
          id: '0190f4c2-6f1a-7c3e-8a51-0000000000f1',
          hash: hashOf('attestation-statement'),
        },
        reasonCode: 'WITHDRAWN',
        nonce: 'r4Zr0f1sQ0-8b7dDk2JH3g',
        signedAt: '2026-05-15T09:00:00.000Z',
        expiresAt: '2026-05-15T09:10:00.000Z',
      },
    ),
    canonicalVector(
      'key-registration-basic',
      'key-registration-statement',
      'Proof-of-possession statement for a public key',
      {
        v: 1,
        purpose: 'key-registration',
        audience: 'bragging-rights:prod',
        principalId: PRINCIPAL,
        key: {
          keyId: KEY,
          keyKind: 'JWK',
          algorithm: 'EdDSA',
          verificationMaterialHash: hashOf('public-jwk'),
        },
        nonce: 'k4Zr0f1sQ0-8b7dDk2JH3g',
        signedAt: '2026-05-14T17:00:00.000Z',
        expiresAt: '2026-05-14T17:10:00.000Z',
      },
    ),
  ];
  const signed = canonical.find((v) => v.id === 'statement-basic') as Vector & { hash: string };
  const keys = { eddsa: vectorKey(), es256: es256VectorKey() };
  const previous = previousSignatures();
  const tamper = (id: string, description: string, doc: unknown) => ({
    id,
    description,
    statementHash: canonicalVector(`tamper-${id}`, 'attestation-statement', description, doc)
      .hash as string,
  });
  const tampers = [
    tamper('result-version', 'ResultVersion id changed', {
      ...statement,
      subject: { ...statement.subject, id: '0190f4c2-6f1a-7c3e-8a51-0000000000e2' },
    }),
    tamper('evidence-id', 'One evidence id changed', {
      ...statement,
      evidenceRefs: [{ ...refA, evidenceId: '0190f4c2-6f1a-7c3e-8a51-000000000a09' }, refB],
    }),
    tamper('content-hash', 'One evidence content hash changed', {
      ...statement,
      evidenceRefs: [{ ...refA, contentHash: hashOf('other bytes') }, refB],
    }),
    tamper('issuer', 'Issuer principal changed', {
      ...statement,
      issuer: { ...statement.issuer, principalId: '0190f4c2-6f1a-7c3e-8a51-0000000000c2' },
    }),
    tamper('subject-hash', 'Subject content hash changed', {
      ...statement,
      subject: { ...statement.subject, hash: hashOf('other result') },
    }),
    tamper('claim', 'Claim polarity changed', {
      ...statement,
      claim: { type: 'RESULT_ACCURATE', polarity: 'DENY' },
    }),
    tamper('audience', 'Audience changed (staging signature replayed in prod)', {
      ...statement,
      audience: 'bragging-rights:staging',
    }),
    tamper('nonce', 'Nonce (challenge) changed', { ...statement, nonce: 'Z4Zr0f1sQ0-8b7dDk2JH3g' }),
  ];
  const header = (h: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(h), 'utf8').toString('base64url');
  const input = (protectedB64: string, statementHash: string) =>
    `${protectedB64}.${signaturePayload(statementHash)}`;
  interface SigningVector {
    id: string;
    description: string;
    expect: 'accept' | 'reject';
    key: 'eddsa' | 'es256';
    alg: string;
    keyId: string;
    statementHash: string;
    protected: string;
    signingInput: string;
    signature: string;
    rule?: string;
  }
  const signing: SigningVector[] = [];
  for (const [name, key] of Object.entries(keys) as ['eddsa' | 'es256', VectorKey][]) {
    const p = protectedHeaderFor(key.alg, KEY);
    const good = signWith(key, input(p, signed.hash), previous);
    const base = { key: name, alg: key.alg, keyId: KEY, protected: p };
    signing.push({
      ...base,
      id: `${name}-accept`,
      description: `JWS_DETACHED ${key.alg} over the statement-basic hash with the public vector key`,
      expect: 'accept',
      statementHash: signed.hash,
      signingInput: input(p, signed.hash),
      signature: good,
    });
    // Tampered statements: the ORIGINAL signature must not verify.
    for (const t of name === 'eddsa' ? tampers : tampers.slice(0, 3))
      signing.push({
        ...base,
        id: `${name}-tamper-${t.id}`,
        description: `${t.description}: the original signature must NOT verify`,
        expect: 'reject',
        statementHash: t.statementHash,
        signingInput: input(p, t.statementHash),
        signature: good,
        rule: 'SIGNATURE',
      });
    // Header rules (RFC 7515/7797): the signature IS valid over these headers, the header is not.
    const headerCases: [string, string, Record<string, unknown>][] = [
      [
        'header-kid',
        'kid names another key id',
        { alg: key.alg, b64: false, crit: ['b64'], kid: '0190f4c2-6f1a-7c3e-8a51-0000000000d2' },
      ],
      [
        'header-no-crit',
        'b64:false without crit (RFC 7797 §6 requires crit)',
        { alg: key.alg, b64: false, kid: KEY },
      ],
      [
        'header-b64-true',
        'b64:true (the raw hash would be base64url-encoded, not the detached payload)',
        { alg: key.alg, b64: true, crit: ['b64'], kid: KEY },
      ],
      [
        'header-extra-crit',
        'crit lists an unsupported extension',
        { alg: key.alg, b64: false, crit: ['b64', 'exp'], exp: 1, kid: KEY },
      ],
      [
        'header-extra-member',
        'an extra protected member (jku) could redirect key discovery',
        { alg: key.alg, b64: false, crit: ['b64'], jku: 'https://attacker.example', kid: KEY },
      ],
      ['header-alg-none', 'alg "none"', { alg: 'none', b64: false, crit: ['b64'], kid: KEY }],
      [
        'header-alg-confusion',
        'alg names the other algorithm than the registered key',
        { alg: key.alg === 'EdDSA' ? 'ES256' : 'EdDSA', b64: false, crit: ['b64'], kid: KEY },
      ],
    ];
    for (const [id, description, h] of headerCases) {
      const hp = header(h);
      signing.push({
        ...base,
        id: `${name}-${id}`,
        description,
        expect: 'reject',
        protected: hp,
        statementHash: signed.hash,
        signingInput: input(hp, signed.hash),
        signature: signWith(key, input(hp, signed.hash), previous),
        rule: 'HEADER',
      });
    }
  }
  const es = keys.es256;
  const esP = protectedHeaderFor('ES256', KEY);
  const esGood = signing.find((v) => v.id === 'es256-accept')?.signature as string;
  signing.push({
    id: 'es256-der-signature',
    description: 'ES256 signature DER-encoded instead of the fixed 64-byte R‖S (RFC 7518 §3.4)',
    expect: 'reject',
    key: 'es256',
    alg: 'ES256',
    keyId: KEY,
    protected: esP,
    statementHash: signed.hash,
    signingInput: input(esP, signed.hash),
    signature: toDer(Buffer.from(esGood, 'base64url')).toString('base64url'),
    rule: 'ENCODING',
  });
  signing.push({
    id: 'es256-truncated-signature',
    description: 'ES256 signature of 63 bytes',
    expect: 'reject',
    key: 'es256',
    alg: 'ES256',
    keyId: KEY,
    protected: esP,
    statementHash: signed.hash,
    signingInput: input(esP, signed.hash),
    signature: Buffer.from(esGood, 'base64url').subarray(1).toString('base64url'),
    rule: 'ENCODING',
  });
  const edGood = signing.find((v) => v.id === 'eddsa-accept')?.signature as string;
  signing.push({
    id: 'key-substitution-eddsa-signature-es256-key',
    description: 'A valid EdDSA signature presented against the ES256 key (alg/key confusion)',
    expect: 'reject',
    key: 'es256',
    alg: 'ES256',
    keyId: KEY,
    protected: protectedHeaderFor('EdDSA', KEY),
    statementHash: signed.hash,
    signingInput: input(protectedHeaderFor('EdDSA', KEY), signed.hash),
    signature: edGood,
    rule: 'HEADER',
  });
  void es;

  // Public-key identity (RFC 7638) and strict JWK validation.
  const edJwk = keys.eddsa.publicJwk;
  const esJwk = keys.es256.publicJwk;
  const nonCanonicalX = (() => {
    const b = Buffer.from(edJwk.x as string, 'base64url');
    const s43 = b.toString('base64url');
    // flip the unused low bits of the final character (same 32 bytes, different spelling)
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(s43[42] as string);
    return s43.slice(0, 42) + (alphabet[(last & ~3) | ((last & 3) ^ 1)] as string);
  })();
  const keyCases: {
    id: string;
    description: string;
    alg: 'EdDSA' | 'ES256';
    jwk: Record<string, unknown>;
  }[] = [
    { id: 'jwk-eddsa', description: 'Ed25519 public vector key', alg: 'EdDSA', jwk: edJwk },
    {
      id: 'jwk-eddsa-reordered',
      description: 'Same key, members reordered',
      alg: 'EdDSA',
      jwk: { x: edJwk.x, kty: 'OKP', crv: 'Ed25519' },
    },
    {
      id: 'jwk-eddsa-metadata',
      description: 'Same key with RFC 7517 metadata (alg/use/key_ops/kid)',
      alg: 'EdDSA',
      jwk: { ...edJwk, alg: 'EdDSA', use: 'sig', key_ops: ['verify'], kid: 'anything' },
    },
    { id: 'jwk-es256', description: 'P-256 public vector key', alg: 'ES256', jwk: esJwk },
    {
      id: 'jwk-es256-reordered',
      description: 'Same key, members reordered + metadata',
      alg: 'ES256',
      jwk: { y: esJwk.y, x: esJwk.x, crv: 'P-256', kty: 'EC', use: 'sig' },
    },
    {
      id: 'jwk-reject-private-member',
      description: 'A private member (d) is present',
      alg: 'EdDSA',
      jwk: { ...edJwk, d: 'fake-private-member' },
    },
    {
      id: 'jwk-reject-noncanonical-x',
      description: 'x spelled with non-zero unused trailing bits',
      alg: 'EdDSA',
      jwk: { ...edJwk, x: nonCanonicalX },
    },
    {
      id: 'jwk-reject-curve-substitution',
      description: 'OKP key presented for ES256',
      alg: 'ES256',
      jwk: edJwk,
    },
    {
      id: 'jwk-reject-short-x',
      description: 'x of 31 bytes',
      alg: 'EdDSA',
      jwk: { ...edJwk, x: Buffer.alloc(31, 7).toString('base64url') },
    },
    {
      id: 'jwk-reject-wrong-kty',
      description: 'kty EC with crv Ed25519',
      alg: 'EdDSA',
      jwk: { ...edJwk, kty: 'EC' },
    },
  ];
  const keyVectors = keyCases.map((c) => {
    const parsed = parsePublicJwk(c.alg, c.jwk);
    return parsed.ok
      ? { ...c, expect: 'accept' as const, thumbprint: jwkThumbprint(parsed.key) }
      : { ...c, expect: 'reject' as const };
  });

  return {
    suite: 'brt-06',
    profile: 'br-json/1',
    description:
      'BRT-06 evidence & attestation vectors. Canonical hashes: SHA-256("BR" || 0x01 || domainTag || 0x00 || schemaId "@" version || 0x00 || "br-json/1" || 0x00 || JCS(normalized)). Evidence BYTES are plain SHA-256 (sha256sum). Signing input (RFC 7515 + RFC 7797, b64:false): protected || "." || "bragging-rights/sig/v1:" || hex(statementHash). EdDSA = Ed25519; ES256 = ECDSA P-256/SHA-256 with a fixed 64-byte R||S signature. Key identity: RFC 7638 thumbprint.',
    equalHashGroups: [
      ['descriptor-derived-lineage', 'descriptor-derived-lineage-sorted'],
      ['statement-basic', 'statement-evidence-order'],
    ],
    equalThumbprintGroups: [
      ['jwk-eddsa', 'jwk-eddsa-reordered', 'jwk-eddsa-metadata'],
      ['jwk-es256', 'jwk-es256-reordered'],
    ],
    vectorKeys: Object.fromEntries(
      Object.entries(keys).map(([n, k]) => [
        n,
        {
          alg: k.alg,
          derivation: k.derivation,
          warning:
            'PUBLIC by design. Never register this key; the platform refuses it by RFC 7638 thumbprint.',
          publicJwk: k.publicJwk,
          thumbprint: jwkThumbprint(createPublicKey({ key: k.publicJwk, format: 'jwk' })),
        },
      ]),
    ),
    canonical,
    signing,
    keys: keyVectors,
  };
}

export function serialize(doc: unknown): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
