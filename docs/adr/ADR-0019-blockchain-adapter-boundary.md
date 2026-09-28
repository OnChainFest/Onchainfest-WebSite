# ADR-0019 — Blockchain adapter boundary (ports and adapters); no chain selected yet

- **Status:** Proposed
- **Date:** 2026-09-28
- **Origin:** BRT-02 (implements BRT-01 ADR-0006)

## Context

Legacy repositories targeted Base, and XRPL EVM appeared in config, but nothing was ever deployed (BRT-00 I-1). No BRT-02 requirement forces a chain today.

## Decision

1. **Domain modules talk to four ports:**
   - `AnchoringPort`: Merkle roots;
   - `CredentialPort`: trophy credentials (ids and commitments only);
   - `SettlementPort`: future prize escrow and release;
   - `AuthorityCommitmentPort`: future roots of grant and key state.
2. **Adapters implement ports per network family** (e.g. `evm-generic` configured per chain, `xrpl-native`). They hold signing access and chain logic only, and persist `ExternalChainRef` events (CAIP-2/CAIP-10, tx hash, confirmations, reorg status).
3. **Idempotency across chains** relies on deterministic ids (credential id, payout instruction hash). The contract or ledger side must reject duplicates.
4. **Must remain off-chain:**
   - PII;
   - evidence bytes;
   - result content (hashes only);
   - authority evaluation and verification logic;
   - dispute content;
   - identity links.
5. **Chain selection is deferred.** Triggers for the decision: the first on-chain credential issuance or the first escrow. Anchoring may start on a transparency log or any low-cost network through the same port.

## Consequences

**Benefits:**

- Adding Base, XRPL/XRPL EVM or another network does not touch the domain.
- Sporting truth never waits on a chain.

**Costs:**

- Adapters must normalize finality and reorg semantics across very different networks.
