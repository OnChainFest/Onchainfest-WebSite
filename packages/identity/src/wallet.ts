import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

/**
 * Wallet proof of control (BRT-02 identity & authority §2.2; BRT-04 §21–22).
 *
 * Workflow: prepare challenge → user signs → verify through a WalletProofVerifier → activate.
 * A raw address proves nothing. Challenges are single-use and expire (enforced by persistence).
 */
/**
 * Proof schemes. Each scheme belongs to exactly one network family; BRT-04 supports only EVM
 * (`eip155:<chainId>`). XRPL and other families arrive later as separate adapters/schemes.
 */
export const WalletProofScheme = {
  /** EIP-191 personal_sign by an EVM externally-owned account (production). */
  EIP191_PERSONAL_SIGN: 'eip191-personal-sign',
  /** Development/test pseudo-signature `test-signature:<nonce>` (TEST_VERIFIED only). */
  TEST_SIGNATURE: 'test-signature',
} as const;
export type WalletProofScheme = (typeof WalletProofScheme)[keyof typeof WalletProofScheme];

/** EVM network family: CAIP-2 `eip155:<positive chain id>`. */
const EIP155_NETWORK = /^eip155:[1-9][0-9]{0,31}$/;

export function isEip155Network(network: string): boolean {
  return EIP155_NETWORK.test(network);
}

/** The network family each scheme is valid for. */
export function schemeSupportsNetwork(scheme: WalletProofScheme, network: string): boolean {
  switch (scheme) {
    case 'eip191-personal-sign':
    case 'test-signature':
      return isEip155Network(network);
    default:
      return false;
  }
}

/**
 * Validates and normalizes a wallet target for a scheme: network family must match the scheme and
 * EVM addresses must be 20-byte hex; the returned address is lower-case (the form bound into the
 * challenge). Returns an error reason instead of throwing.
 */
export function normalizeWalletTarget(
  scheme: WalletProofScheme,
  network: string,
  address: string,
):
  | { ok: true; network: string; address: string }
  | { ok: false; reason: 'UNSUPPORTED_NETWORK' | 'INVALID_ADDRESS' } {
  if (!schemeSupportsNetwork(scheme, network)) return { ok: false, reason: 'UNSUPPORTED_NETWORK' };
  if (!isEvmAddress(address)) return { ok: false, reason: 'INVALID_ADDRESS' };
  return { ok: true, network, address: address.toLowerCase() };
}

export interface WalletChallenge {
  readonly challengeId: string;
  readonly network: string; // CAIP-2, e.g. "eip155:8453"
  readonly address: string;
  readonly proofScheme: WalletProofScheme;
  readonly nonce: string;
  readonly purpose: 'wallet-link';
  readonly audience: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly message: string;
}

export type VerifierKind = 'PRODUCTION' | 'TEST';

export interface WalletProofVerifier {
  readonly id: string;
  readonly kind: VerifierKind;
  /** The single proof scheme this verifier implements. Dispatch is by (network family, scheme). */
  readonly scheme: WalletProofScheme;
  supports(network: string): boolean;
  /** Returns true only if `signature` proves control of `challenge.address` over `challenge.message`. */
  verify(challenge: WalletChallenge, signature: string): boolean;
}

/**
 * Canonical challenge text (CAIP-122 / EIP-4361 inspired; plain text so any wallet can sign it).
 * Every binding field (address, network, nonce, purpose, audience, expiry) is inside the signed text.
 */
export function buildChallengeMessage(c: Omit<WalletChallenge, 'message'>): string {
  return [
    `${c.audience} wants you to link this wallet to your Bragging Rights person.`,
    '',
    `Address: ${c.address}`,
    `Network: ${c.network}`,
    `Proof Scheme: ${c.proofScheme}`,
    `Purpose: ${c.purpose}`,
    `Nonce: ${c.nonce}`,
    `Challenge: ${c.challengeId}`,
    `Issued At: ${c.issuedAt.toISOString()}`,
    `Expires At: ${c.expiresAt.toISOString()}`,
  ].join('\n');
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function isEvmAddress(address: string): boolean {
  return EVM_ADDRESS.test(address);
}

/** EIP-191 `personal_sign` digest. */
export function eip191Digest(message: string): Uint8Array {
  const body = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const all = new Uint8Array(prefix.length + body.length);
  all.set(prefix);
  all.set(body, prefix.length);
  return keccak_256(all);
}

/** Ethereum address (lowercase) of an uncompressed/compressed secp256k1 public key. */
export function evmAddressOf(publicKey: Uint8Array): string {
  const uncompressed = secp256k1.Point.fromBytes(publicKey).toBytes(false);
  const hash = keccak_256(uncompressed.slice(1));
  return `0x${Buffer.from(hash.slice(12)).toString('hex')}`;
}

/**
 * Production verifier for EVM externally-owned accounts: EIP-191 personal_sign recovery.
 * Signature = 65 bytes r ‖ s ‖ v (v ∈ {27, 28} or {0, 1}), hex with 0x prefix.
 * Smart-contract wallets (EIP-1271 / EIP-6492) need chain RPC and are deferred.
 */
export const eip155EoaPersonalSignVerifier: WalletProofVerifier = {
  id: 'eip155-eoa-personal-sign',
  kind: 'PRODUCTION',
  scheme: 'eip191-personal-sign',
  supports: isEip155Network,
  verify(challenge, signature) {
    if (
      challenge.proofScheme !== 'eip191-personal-sign' ||
      !isEip155Network(challenge.network) ||
      !isEvmAddress(challenge.address) ||
      !/^0x[0-9a-fA-F]{130}$/.test(signature)
    )
      return false;
    try {
      const bytes = Buffer.from(signature.slice(2), 'hex');
      const v = bytes[64] as number;
      const recovery = v >= 27 ? v - 27 : v;
      if (recovery !== 0 && recovery !== 1) return false;
      const recovered = new Uint8Array(65);
      recovered[0] = recovery;
      recovered.set(bytes.subarray(0, 64), 1);
      const publicKey = secp256k1.recoverPublicKey(recovered, eip191Digest(challenge.message), {
        prehash: false,
      });
      return evmAddressOf(publicKey) === challenge.address.toLowerCase();
    } catch {
      return false;
    }
  },
};

/**
 * Development/test verifier: accepts `test-signature:<nonce>`. Links it verifies are stored as
 * TEST_VERIFIED and presented as test proofs. It refuses to exist in production.
 */
export function createTestWalletVerifier(): WalletProofVerifier {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('the test wallet verifier is not available in production');
  }
  return {
    id: 'test-verifier',
    kind: 'TEST',
    scheme: 'test-signature',
    supports: isEip155Network,
    verify: (challenge, signature) =>
      challenge.proofScheme === 'test-signature' &&
      isEip155Network(challenge.network) &&
      signature === `test-signature:${challenge.nonce}`,
  };
}

/** Test helper: sign a challenge with a secp256k1 secret key exactly as a wallet would. */
export function signEip191ForTest(message: string, secretKey: Uint8Array): string {
  const sig = secp256k1.sign(eip191Digest(message), secretKey, {
    prehash: false,
    format: 'recovered',
  });
  const out = new Uint8Array(65);
  out.set(sig.subarray(1, 65), 0);
  out[64] = (sig[0] as number) + 27;
  return `0x${Buffer.from(out).toString('hex')}`;
}

/** Test helper: a fresh random secp256k1 key and its EVM address (never persisted anywhere). */
export function generateTestWalletKey(): { secretKey: Uint8Array; address: string } {
  const secretKey = secp256k1.utils.randomSecretKey();
  return { secretKey, address: evmAddressOf(secp256k1.getPublicKey(secretKey)) };
}
