# ADR-0009 — No PII on-chain; crypto-shreddable commitments

- **Status:** Proposed
- **Date:** 2026-09-28

## Context

- **PII on-chain.** `PadelFlowNFTTrophy.sol` stored `winnerName` on-chain (BRT-00 M-4).
- **Sensitive data exposed in legacy databases.** Passports, phone numbers and emergency contacts sat under permissive RLS. Private keys and mnemonics were stored in plaintext (C-2, C-3).
- **Minors.** Sports platforms routinely include minors.
- **Immutable ledgers versus erasure rights.** Ledgers cannot honour data-subject erasure.

## Decision

1. **No PII on any ledger.** This covers names, DOB, contact data, document numbers, biometric media and precise location traces. An exception requires its own ADR.
2. **How on-chain artefacts identify athletes.** They reference athletes only by:
   - a **salted commitment** (with a per-athlete salt held off-chain), or
   - a wallet the athlete explicitly chose to publish.
3. **Erasure** destroys the salt and the identity link (crypto-shredding). Sporting facts may remain as anonymous history.
4. **Privacy classes:** PUBLIC, PLATFORM-PRIVATE, AUTHORITY-ONLY, CRYPTOGRAPHIC-COMMITMENT-ONLY. Deny-by-default access.
5. **Minors:** alias display and public profile off by default. No on-chain artefact without guardian consent.
6. **No storage of user private keys or mnemonics, ever.**

## Consequences

**Benefits:**

- Compliance headroom (GDPR-style regimes, Costa Rica Law 8968).
- Safe public verifiability via hashes and attestations.

**Costs:**

- Public trophy metadata cannot show legal names on-chain. Display names resolve off-chain.
- Some third-party NFT displays will show aliases only.
