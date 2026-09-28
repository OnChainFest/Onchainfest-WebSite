# Bragging Rights

Bragging Rights is being built as infrastructure for **verified sports achievement**. The core is a trust chain that answers _"why should anyone trust that this athlete achieved this result?"_:

```
Result → Evidence → Attestation → Verification → Verified Achievement → consequences
```

The architecture and domain are specified in [`docs/`](./docs):

- BRT-00 archaeology;
- the BRT-01 domain model;
- the BRT-02 platform architecture and ADR-0001…0020.

## What exists today (BRT-03 — technical kernel)

This repository contains **only the technical foundation**. There is no product UI, no athlete passport, no tournament screens, no smart contracts, no NFTs and no blockchain or external-API integration.

| Implemented                                                                                                                                                                                                                                        | Where                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| BR-JSON v1 canonicalization and domain-separated SHA-256 hashing, with 58 golden vectors and an independent Python reference checker                                                                                                               | `packages/canonical`          |
| Foundational domain types: principals, keys, anchors, grants, scopes, capabilities, results, versions, refs, events; UUIDv7/TypeID ids; time model                                                                                                 | `packages/domain`             |
| Authority kernel: scope algebra, grant-chain evaluation, delegation, revocation, time semantics, explainable decisions with proof digests                                                                                                          | `packages/authority`          |
| PostgreSQL persistence: SQL migrations, module roles, append-only ledgers, per-stream hash chains, projections and rebuild, transactional outbox, command idempotency, authority store, result ledger (DRAFT → SUBMITTED → PROVISIONAL / REJECTED) | `packages/persistence`, `db/` |
| Versioned BR-JSON schemas                                                                                                                                                                                                                          | `packages/schemas`            |
| API scaffold (`/health`, `/ready`), worker skeleton (outbox + job claim), minimal web placeholder                                                                                                                                                  | `apps/`                       |

## Quick start

Prerequisites: Node.js 22 LTS (24 also supported), pnpm 10 (via Corepack), Docker, Python 3.

```bash
corepack enable
pnpm install
pnpm db:up          # PostgreSQL 18 on localhost:55432
pnpm db:bootstrap   # roles + database hardening (dev passwords)
pnpm db:migrate     # SQL migrations
pnpm test           # unit + property tests + golden vectors
pnpm test:integration
pnpm demo:foundation  # acceptance walkthrough against the dev database
```

Exact commands, resets and troubleshooting are in [`docs/implementation/BRT-03-DEVELOPMENT.md`](./docs/implementation/BRT-03-DEVELOPMENT.md). The code-to-ADR map is in [`docs/implementation/BRT-03-FOUNDATION.md`](./docs/implementation/BRT-03-FOUNDATION.md).

## Repository layout

```
apps/        api (Fastify), worker, web (Next.js placeholder)
packages/    canonical, domain, authority, persistence, schemas, testkit
db/          bootstrap (roles), migrations (plain SQL), docker init
docs/        archaeology, domain, architecture, security, api, adr, implementation
tooling/     CI helpers and repository guards
```
