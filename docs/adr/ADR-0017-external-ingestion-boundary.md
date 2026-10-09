# ADR-0017 — External ingestion boundary: adapters never write canonical tables

- **Status:** Proposed
- **Date:** 2026-09-28
- **Origin:** BRT-02

## Context

Future sources include data providers, federations, timing and scoring hardware, club software, uploads and AI or officiating systems. The legacy integrations trusted unauthenticated webhooks, and turned a boolean into settlement (BRT-00 C-8, M-8).

## Decision

1. **Pipeline:** Source → Adapter (versioned, bound to a SYSTEM/ORGANIZATION principal) → **RawIngestionEnvelope** → validation → normalization → **NormalizedCandidate** → a domain command executed **as the source principal** under normal authority checks, or a review task.
2. **Raw payloads are preserved as Evidence.** Envelopes record the adapter version, the source ids, the raw payload hash, the schema, the transport authentication result and the timestamps.
3. **Idempotency key:** `H(sourcePrincipalId ‖ externalEventId ‖ payloadHash)`. A changed payload under the same external id becomes a correction *candidate*, never an overwrite.
4. **Webhooks:** raw-body HMAC, a timestamp window and nonces. No state-moving test endpoints in production.
5. **Unresolved identity mappings** go to review. The platform never signs as a provider.

## Consequences

**Benefits:**

- Every canonical fact is traceable to raw bytes and to an accountable principal.
- The same trust rules apply to machines and humans.

**Costs:**

- Mapping and review tooling is required.
