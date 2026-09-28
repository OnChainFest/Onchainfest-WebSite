# ADR-0006 — Chain-agnostic domain core

- **Status:** Proposed
- **Date:** 2026-09-28

## Context

- The legacy code targeted Base (Poker, poker-backend, padelflow, Art) and configured XRPL EVM in one Hardhat file (padelflow). Nothing was ever deployed (BRT-00 I-1).
- RLUSD was assumed on Base without verification (BRT-00 I-2).
- There is therefore **no unavoidable chain dependency.**
- The vision frames NFTs and credentials as *representations*, not the source of truth.

## Decision

1. **Domain identities are platform ids.** Chain addresses and token ids are *external references* attached to domain objects.
2. **Signatures are pluggable.** The domain records `signature.scheme` (EIP-712, JWS, WebAuthn, COSE, etc.) and verifies accordingly.
3. **Ledger capabilities the domain needs:**
   - anchoring a 32-byte digest;
   - verifying signatures or proofs (for settlement);
   - escrow with programmable release;
   - credential/token representation.

   Anything meeting these is acceptable.
4. **Default anchoring is batched Merkle roots** of trust-layer records. Value custody (Prize Rail) is the only area where on-chain *state* is expected.
5. **The chain choice is a separate, later ADR** (BRT-02 or later).

## Consequences

**Benefits:**

- No lock-in.
- Multi-chain representation is possible (e.g. a credential on one chain, settlement on another).
- The domain can be built and tested without a chain.

**Costs:**

- Contract-level verification of attestations will need a bridge from the off-chain authority registry to on-chain verification. The form of that bridge is an open question.
