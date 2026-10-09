# ADR-0029 — Attestation acceptance without an authority verdict; server-canonicalized ceremony; signed retraction

- **Status:** Proposed
- **Date:** 2026-09-29
- **Origin:** BRT-06 (ADR-0002, ADR-0015, ADR-0016; BRT-01 A-2/A-3/A-4; BRT-02 signatures §4–5)

## Context

BRT-02 notes both "authority evaluated before acceptance" (system architecture) and "attestations are always stored, even when unauthorized" (identity & authority §5, API surface); BRT-01 A-4 determines weight at verification time. Grants expire, anchors change and compromise is retroactive, so an authority result frozen at acceptance would be stale or misleading. Signers need a ceremony that binds exactly what they sign and cannot be replayed.

## Decision

1. **Acceptance criteria** are exactly: an authenticated account that represents the issuer (ADR-0027), a key of that issuer admissible at the platform-observed acceptance time, and a valid production proof over the exact server-canonicalized statement through a single-use, expiring, audience- and purpose-bound challenge. **No authority decision is evaluated or stored**; the signer's `authorityContext` is recorded as a declaration. BRT-07 evaluates authority.
2. **Ceremony:** prepare (server resolves the subject hash and evidence hashes, proposes `nonce`, `signedAt`, `expiresAt`, canonicalizes, stores a challenge) → external signing of the documented JWS_DETACHED input → submit (re-canonicalize, verify challenge, representation, key and proof; commit rejections as consumed). Proof scheme: DIRECT_SIGNATURE / JWS_DETACHED with EdDSA (Ed25519) or ES256 over the existing PrincipalKey model; no test-only scheme exists.
3. **`signedAt` is server-proposed** at prepare and remains a signer assertion that can only restrict (compromise t₀ ≤ signedAt), never admit; the challenge expiry is the online anti-backdating bound; no new clock slack.
4. **Retraction is a signed statement** (`br:attestation-retraction-statement@1`, domain `attestation-retraction`) over the exact attestation statement hash, by the original issuer principal; append-only, one per attestation. Retracted ≠ false. **Supersession** is a new attestation naming the superseded one (same issuer, same Result).
5. Accepted attestations are never updated or deleted, including after key compromise.

## Consequences

- A cryptographically valid claim from an issuer without any grant is stored (e.g. a participant's DENY) and weighed later.
- Public presentation must always separate signature validity, claim status, authority (not evaluated) and verification (not implemented).
- Additional schemes (WebAuthn, wallet, device, platform witness) plug in as new verifiers with their own ceremonies.

## Alternatives considered

- **Require ATTEST_RESULT to store:** rejected (loses contradictory/participant claims; freezes stale verdicts).
- **Client-built statements:** rejected (ambiguous canonicalization, weaker binding).
- **Unsigned (application-level) retraction:** rejected (weaker than the claim it withdraws; tamperable).
