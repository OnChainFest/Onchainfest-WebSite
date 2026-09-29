import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import { isContentHash, parseStrictJson } from '@br/canonical';
import type { SignatureAssurance } from '@br/domain';

/**
 * DIRECT_SIGNATURE / JWS_DETACHED proof scheme (BRT-02 §4.3; ADR-0015) — the production signer
 * scheme of BRT-06, over the existing PrincipalKey model (key_kind JWK, algorithm EdDSA or ES256).
 *
 * Exactly what is signed (the "signing preimage", test-vector-backed):
 *
 *   payload       = "bragging-rights/sig/v1:" ‖ hex(statementHash)            (ASCII)
 *   protected     = BASE64URL(UTF8({"alg":<alg>,"b64":false,"crit":["b64"],"kid":<keyId>}))
 *   signingInput  = ASCII(protected) ‖ "." ‖ payload                           (RFC 7515 + RFC 7797)
 *   signature     = Ed25519(signingInput)            for alg EdDSA  (64 bytes, base64url)
 *                 = ECDSA-P256-SHA256(signingInput)  for alg ES256  (r ‖ s, 64 bytes, base64url)
 *
 * `statementHash` is domain-separated and commits to protocol version, purpose, audience, issuer,
 * key, subject, claim, evidence references, nonce (challenge) and expiry — so the proof binds all
 * of them. Nothing display-oriented is ever signed.
 *
 * A valid proof means only: "the holder of this registered key signed this exact statement".
 * It never means the statement is correct, nor that the signer has sporting authority.
 */
export const SIGNATURE_PAYLOAD_PREFIX = 'bragging-rights/sig/v1:';
export const JWS_ALGORITHMS = ['EdDSA', 'ES256'] as const;
export type JwsAlgorithm = (typeof JWS_ALGORITHMS)[number];

const MAX_PROTECTED_LENGTH = 256;
const SIGNATURE_B64_LENGTH = 86; // 64 bytes, base64url without padding
const B64URL = /^[A-Za-z0-9_-]+$/;

export function signaturePayload(statementHash: string): string {
  if (!isContentHash(statementHash)) throw new TypeError('not a sha256 content hash');
  return `${SIGNATURE_PAYLOAD_PREFIX}${statementHash.slice('sha256:'.length)}`;
}

/** The protected header the platform proposes (members in JCS order). */
export function protectedHeaderFor(alg: JwsAlgorithm, kid: string): string {
  return Buffer.from(JSON.stringify({ alg, b64: false, crit: ['b64'], kid }), 'utf8').toString(
    'base64url',
  );
}

export function jwsSigningInput(protectedB64: string, statementHash: string): Buffer {
  return Buffer.from(`${protectedB64}.${signaturePayload(statementHash)}`, 'ascii');
}

export interface SigningRequest {
  readonly proofType: 'DIRECT_SIGNATURE';
  readonly scheme: 'JWS_DETACHED';
  readonly alg: JwsAlgorithm;
  readonly kid: string;
  readonly protected: string;
  readonly payload: string;
  /** ASCII text to sign with the private key, held by the signer only. */
  readonly signingInput: string;
}

export function signingRequest(
  alg: JwsAlgorithm,
  kid: string,
  statementHash: string,
): SigningRequest {
  const protectedB64 = protectedHeaderFor(alg, kid);
  return {
    proofType: 'DIRECT_SIGNATURE',
    scheme: 'JWS_DETACHED',
    alg,
    kid,
    protected: protectedB64,
    payload: signaturePayload(statementHash),
    signingInput: jwsSigningInput(protectedB64, statementHash).toString('ascii'),
  };
}

// ───────────────────────────── public keys ─────────────────────────────

const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;

/** A 32-byte coordinate in CANONICAL base64url (RFC 7515 §2: no padding, no stray trailing bits). */
function canonicalCoordinate(value: unknown): value is string {
  if (typeof value !== 'string' || !B64URL_32.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === value;
}

/**
 * Optional JWK metadata tolerated on INPUT for interoperability (RFC 7517 §4). It is validated,
 * never stored (only the required public members are kept) and never influences verification or
 * key identity. Anything else — including every private member — is refused.
 */
const METADATA_MEMBERS = new Set(['alg', 'use', 'key_ops', 'kid', 'ext']);

function metadataOk(alg: string, material: Readonly<Record<string, unknown>>): boolean {
  if (material.alg !== undefined && material.alg !== alg) return false;
  if (material.use !== undefined && material.use !== 'sig') return false;
  if (material.ext !== undefined && typeof material.ext !== 'boolean') return false;
  if (material.kid !== undefined && (typeof material.kid !== 'string' || material.kid.length > 200))
    return false;
  if (
    material.key_ops !== undefined &&
    !(Array.isArray(material.key_ops) && material.key_ops.every((o) => o === 'verify'))
  )
    return false;
  return true;
}

/**
 * Validates PUBLIC verification material for a JWS algorithm:
 *   EdDSA → kty OKP, crv Ed25519, x = 32 bytes (canonical base64url)
 *   ES256 → kty EC,  crv P-256,   x, y = 32 bytes each (canonical base64url), point on the curve
 * Closed member sets (plus validated metadata): private or unexpected members (d, p, q, k…) are
 * refused, so a private key cannot be stored by mistake. Returns the NORMALIZED public JWK (required
 * members only) and the node KeyObject used for verification.
 */
export function parsePublicJwk(
  alg: string,
  material: Readonly<Record<string, unknown>>,
): { ok: true; jwk: Record<string, string>; key: KeyObject } | { ok: false } {
  const required =
    alg === 'EdDSA' ? ['crv', 'kty', 'x'] : alg === 'ES256' ? ['crv', 'kty', 'x', 'y'] : undefined;
  if (required === undefined) return { ok: false };
  const members = Object.keys(material);
  if (!required.every((m) => members.includes(m))) return { ok: false };
  if (members.some((m) => !required.includes(m) && !METADATA_MEMBERS.has(m))) return { ok: false };
  if (!metadataOk(alg, material)) return { ok: false };
  let jwk: Record<string, string>;
  if (alg === 'EdDSA') {
    if (material.kty !== 'OKP' || material.crv !== 'Ed25519' || !canonicalCoordinate(material.x))
      return { ok: false };
    jwk = { kty: 'OKP', crv: 'Ed25519', x: material.x };
  } else {
    if (material.kty !== 'EC' || material.crv !== 'P-256') return { ok: false };
    if (!canonicalCoordinate(material.x) || !canonicalCoordinate(material.y)) return { ok: false };
    jwk = { kty: 'EC', crv: 'P-256', x: material.x, y: material.y };
  }
  try {
    // Rejects points not on the curve (and the identity / invalid encodings).
    return { ok: true, jwk, key: createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' }) };
  } catch {
    return { ok: false };
  }
}

/**
 * RFC 7638 JWK thumbprint (SHA-256, base64url) over the REQUIRED public members in lexicographic
 * order, recomputed from the KeyObject's own export — so it identifies the public key itself,
 * independent of member order, metadata or input spelling.
 */
export function jwkThumbprint(key: KeyObject): string {
  const e = key.export({ format: 'jwk' }) as Record<string, string>;
  const canonical =
    e.kty === 'OKP'
      ? `{"crv":"${e.crv}","kty":"OKP","x":"${e.x}"}`
      : e.kty === 'EC'
        ? `{"crv":"${e.crv}","kty":"EC","x":"${e.x}","y":"${e.y}"}`
        : undefined;
  if (canonical === undefined) throw new TypeError('unsupported key type');
  return createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

/**
 * RFC 7638 thumbprints of the published BRT-06 test-vector keys. Their private halves are PUBLIC by
 * design (derived from documented labels in packages/evidence/scripts/vectors.ts), so these keys can
 * never be registered as PrincipalKeys, in any representation.
 */
export const PUBLISHED_VECTOR_KEY_THUMBPRINTS: readonly string[] = [
  'vaNSz0hhMGFdIIEtx9sBHxsmNF1BTC8SjbjrIC3M70A', // Ed25519 vector key
  'MKXA3oYxsrF3ZBGzdKCPa5hWRn5geEYCeccOMuCSGyw', // P-256 vector key
];

export function isPublishedVectorKey(key: KeyObject): boolean {
  return PUBLISHED_VECTOR_KEY_THUMBPRINTS.includes(jwkThumbprint(key));
}

// ───────────────────────────── verification ─────────────────────────────

export interface ProofMaterial {
  readonly protected: string;
  readonly signature: string;
}

export type ProofFailure =
  | 'MALFORMED_PROOF'
  | 'HEADER_MISMATCH'
  | 'UNSUPPORTED_ALGORITHM'
  | 'BAD_KEY_MATERIAL'
  | 'SIGNATURE_INVALID';

export type ProofVerification =
  | { readonly ok: true; readonly assurance: SignatureAssurance; readonly verifierId: string }
  | { readonly ok: false; readonly reason: ProofFailure };

export interface VerifyProofInput {
  readonly statementHash: string;
  readonly keyId: string;
  readonly keyKind: string;
  readonly algorithm: string;
  readonly verificationMaterial: Readonly<Record<string, unknown>>;
  readonly proof: unknown;
}

/**
 * AttestationProofVerifier port: proves signature validity, statement binding (the payload IS the
 * statement hash), key binding (kid = the registered key id) and — through the statement hash —
 * audience/purpose binding. It never evaluates sporting truth or authority.
 */
export interface AttestationProofVerifier {
  readonly id: string;
  /** Only PRODUCTION verifiers exist in BRT-06 (no test-only proof scheme at all). */
  readonly kind: 'PRODUCTION';
  readonly proofType: 'DIRECT_SIGNATURE';
  readonly scheme: 'JWS_DETACHED';
  verify(input: VerifyProofInput): ProofVerification;
}

function parseProof(proof: unknown): ProofMaterial | undefined {
  if (typeof proof !== 'object' || proof === null || Array.isArray(proof)) return undefined;
  const p = proof as Record<string, unknown>;
  if (Object.keys(p).sort().join(',') !== 'protected,signature') return undefined;
  if (typeof p.protected !== 'string' || typeof p.signature !== 'string') return undefined;
  if (p.protected.length === 0 || p.protected.length > MAX_PROTECTED_LENGTH) return undefined;
  if (!B64URL.test(p.protected)) return undefined;
  if (p.signature.length !== SIGNATURE_B64_LENGTH || !B64URL.test(p.signature)) return undefined;
  return { protected: p.protected, signature: p.signature };
}

function headerMatches(protectedB64: string, alg: string, kid: string): boolean {
  let header: unknown;
  try {
    header = parseStrictJson(Buffer.from(protectedB64, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  if (typeof header !== 'object' || header === null || Array.isArray(header)) return false;
  const h = header as Record<string, unknown>;
  return (
    Object.keys(h).sort().join(',') === 'alg,b64,crit,kid' &&
    h.alg === alg &&
    h.kid === kid &&
    h.b64 === false &&
    Array.isArray(h.crit) &&
    h.crit.length === 1 &&
    h.crit[0] === 'b64'
  );
}

export const jwsDetachedVerifier: AttestationProofVerifier = {
  id: 'jws-detached/v1',
  kind: 'PRODUCTION',
  proofType: 'DIRECT_SIGNATURE',
  scheme: 'JWS_DETACHED',
  verify(input) {
    const proof = parseProof(input.proof);
    if (proof === undefined) return { ok: false, reason: 'MALFORMED_PROOF' };
    if (!(JWS_ALGORITHMS as readonly string[]).includes(input.algorithm))
      return { ok: false, reason: 'UNSUPPORTED_ALGORITHM' };
    if (input.keyKind !== 'JWK') return { ok: false, reason: 'UNSUPPORTED_ALGORITHM' };
    if (!headerMatches(proof.protected, input.algorithm, input.keyId))
      return { ok: false, reason: 'HEADER_MISMATCH' };
    const parsed = parsePublicJwk(input.algorithm, input.verificationMaterial);
    if (!parsed.ok) return { ok: false, reason: 'BAD_KEY_MATERIAL' };
    const signature = Buffer.from(proof.signature, 'base64url');
    if (signature.length !== 64) return { ok: false, reason: 'MALFORMED_PROOF' };
    let valid: boolean;
    try {
      const data = jwsSigningInput(proof.protected, input.statementHash);
      valid =
        input.algorithm === 'EdDSA'
          ? cryptoVerify(null, data, parsed.key, signature)
          : cryptoVerify('sha256', data, { key: parsed.key, dsaEncoding: 'ieee-p1363' }, signature);
    } catch {
      valid = false;
    }
    return valid
      ? { ok: true, assurance: 'HOLDER_KEY', verifierId: jwsDetachedVerifier.id }
      : { ok: false, reason: 'SIGNATURE_INVALID' };
  },
};

// ───────────────────────────── signer side (tests / demo only) ─────────────────────────────

export interface EphemeralSigner {
  readonly algorithm: JwsAlgorithm;
  /** Public JWK only — the private key never leaves this closure and is never persisted. */
  readonly publicJwk: Readonly<Record<string, string>>;
  signJws(kid: string, statementHash: string): ProofMaterial;
  /** Signs an arbitrary JWS signing input (for tamper tests). */
  signRaw(signingInput: string): string;
}

/**
 * Generates an in-memory key pair, as an external signer (wallet, HSM, organization KMS) would.
 * For tests, the demo and the development seed. BRT never stores private keys (ADR-0016); this
 * helper refuses production so that platform code can never become a signer for someone else.
 */
export function createEphemeralSigner(algorithm: JwsAlgorithm = 'EdDSA'): EphemeralSigner {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ephemeral signers are for tests and demos only');
  }
  const { publicKey, privateKey } =
    algorithm === 'EdDSA'
      ? generateKeyPairSync('ed25519')
      : generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const exported = publicKey.export({ format: 'jwk' }) as Record<string, string>;
  const publicJwk: Record<string, string> =
    algorithm === 'EdDSA'
      ? { kty: 'OKP', crv: 'Ed25519', x: exported.x as string }
      : { kty: 'EC', crv: 'P-256', x: exported.x as string, y: exported.y as string };
  const signRaw = (signingInput: string) =>
    (algorithm === 'EdDSA'
      ? cryptoSign(null, Buffer.from(signingInput, 'ascii'), privateKey)
      : cryptoSign('sha256', Buffer.from(signingInput, 'ascii'), {
          key: privateKey,
          dsaEncoding: 'ieee-p1363',
        })
    ).toString('base64url');
  return {
    algorithm,
    publicJwk,
    signRaw,
    signJws(kid, statementHash) {
      const protectedB64 = protectedHeaderFor(algorithm, kid);
      return {
        protected: protectedB64,
        signature: signRaw(jwsSigningInput(protectedB64, statementHash).toString('ascii')),
      };
    },
  };
}

/**
 * Identity of an exact JWS_DETACHED proof: SHA-256 of its detached compact serialization
 * (RFC 7515 Appendix F: ASCII(protected) ‖ ".." ‖ ASCII(signature)). Used as the ledger
 * `proofDigest` and the bundle `proofHash`, so BRT-07 can match the stored proof bytes exactly.
 */
export function detachedJwsHash(proof: ProofMaterial): string {
  return `sha256:${createHash('sha256').update(`${proof.protected}..${proof.signature}`, 'ascii').digest('hex')}`;
}

/** Re-verifies stored proof material against a registered key (read-time "is it valid?"). */
export function verifyStoredProof(
  verifier: AttestationProofVerifier,
  input: {
    readonly statementHash: string;
    readonly key: {
      readonly id: string;
      readonly keyKind: string;
      readonly algorithm: string;
      readonly verificationMaterial: Readonly<Record<string, unknown>>;
    };
    readonly proof: unknown;
  },
): boolean {
  return verifier.verify({
    statementHash: input.statementHash,
    keyId: input.key.id,
    keyKind: input.key.keyKind,
    algorithm: input.key.algorithm,
    verificationMaterial: input.key.verificationMaterial,
    proof: input.proof,
  }).ok;
}
