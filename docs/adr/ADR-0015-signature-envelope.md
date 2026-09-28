# ADR-0015 — Multi-scheme signature envelope over a canonical Statement

- **Status:** Proposed
- **Date:** 2026-09-28
- **Origin:** BRT-02

## Context

Signers include:

- EVM wallets (EOA and smart accounts);
- officials without wallets;
- organizations with their own keys;
- devices;
- the platform witness.

BRT-01 requires attestations bound to subject hashes (A-1), plus signature-assurance levels (§3.3). Sports authorities must not be forced to use crypto wallets.

## Decision

1. **Every signature signs a canonical `Statement`.** Its fields are: `purpose`, `audience`, `issuer {principalId, keyId}`, `subject {type, id, hash}`, `claim`, `authorityContext`, `evidenceRefs`, `nonce`, `signedAt`, `expiresAt`. It is hashed with domain tag `attestation-statement` (or a purpose-specific tag).
2. **The `SignatureEnvelope`** carries: the statement, `statementHash`, `proofType`, `scheme`, `keyId`, and a scheme-specific `proof`. Assurance is **derived by the verifier**, never trusted from input.
2a. **The envelope is "a cryptographic proof bound to the Statement"**, not "a signature over identical bytes". Proof types are `DIRECT_SIGNATURE`, `WALLET_SIGNATURE`, `WEBAUTHN_ASSERTION` (the standard assertion over `authenticatorData ‖ SHA-256(clientDataJSON)`, with the Statement bound through a server-generated, single-use ceremony challenge derived from statementHash, purpose, audience, nonce and expiry), `DEVICE_SIGNATURE` and `PLATFORM_WITNESS`. Proof material is scheme-specific and stored in full for later re-verification ([Signatures §4.2–4.3](../architecture/BRT-02-SIGNATURES-AND-HASHING.md#42-signature-envelope-a-proof-bound-to-a-statement)).
2b. **A platform witness never manufactures authority.** The issuer remains the witnessed principal, whose own grants are evaluated.
2c. **Time.** Authority is evaluated at platform-observed `issuedAt`. `signedAt` is only a signer assertion (except the approved-offline-device rule) ([Signatures §5.1](../architecture/BRT-02-SIGNATURES-AND-HASHING.md#51-time-semantics-normative)).
3. **Supported schemes:**
   - `JWS_DETACHED` (RFC 7515/7797: ES256, ES256K, EdDSA);
   - `EIP712`, with EIP-1271/6492 for smart accounts;
   - `EIP191` as a fallback;
   - `WEBAUTHN` (passkey assertion ceremony; the challenge binds the Statement; user verification required);
   - `COSE_SIGN1` / `DEVICE_RAW` for devices;
   - `PLATFORM_WITNESS` (MFA-bound, KMS witness key).
4. **Replay controls:**
   - `(issuer, nonce)` is unique, and `statementHash` is unique;
   - audience, purpose and subject binding;
   - a mandatory `expiresAt`;
   - clock-skew checks.
5. **Compromise:** a statement is SUSPECT if `signedAt ≥ t₀` **or** `issuedAt ≥ t₀`, which defeats backdating.

## Consequences

**Benefits:**

- Wallet users, passkey users, organizations and devices all interoperate.
- One verification path.
- A future scheme is added by registering a new `scheme`.

**Costs:**

- Several verification libraries to maintain and test.
- A human-readable summary rendering for wallets must be consistent (the verifier checks it).

## Alternatives considered

- **EIP-712 only:** excludes non-wallet authorities.
- **JWS only:** poor wallet UX, and no smart-account support.
- **W3C Verifiable Credentials as the sole format:** heavier. It can be offered as an *export* later.
