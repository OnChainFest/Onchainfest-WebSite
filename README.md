# Bragging Rights

Bragging Rights is being built as infrastructure for **verified sports achievement**. The core is a trust chain that answers _"why should anyone trust that this athlete achieved this result?"_:

```
Result → Evidence → Attestation → Verification → Verified Achievement → consequences
```

The architecture and domain are specified in [`docs/`](./docs):

- BRT-00 archaeology;
- the BRT-01 domain model;
- the BRT-02 platform architecture and ADR-0001…0020;
- implementation ADRs 0021…0042 (BRT-04…BRT-08R).

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

### Later phases

- **BRT-04:** identity, Athlete Passport and organizations. See [`docs/implementation/BRT-04-IDENTITY.md`](./docs/implementation/BRT-04-IDENTITY.md).
- **BRT-05:** sport catalog and the competition & event operating layer: versioned disciplines and formats, competitions, events, registration with capacity/waitlist, teams, deterministic single-elimination and round-robin plans, scheduling, declared lineups, a hierarchy resolver for authority scopes, and public competition pages. It is operational only: no results are declared or verified. See [`docs/implementation/BRT-05-COMPETITION-ENGINE.md`](./docs/implementation/BRT-05-COMPETITION-ENGINE.md).
- **BRT-06:** the Evidence & Attestation layer (start of the Sports Truth Layer): content-addressed, encrypted evidence storage with provenance, lineage and an append-only availability lifecycle; explicit Person/Organization signing principals; public-key onboarding with proof of possession; a single-use challenge ceremony for cryptographically signed claims (JWS_DETACHED, EdDSA/ES256) about exact ResultVersions; signed retractions; and a deterministic Evidence Bundle for BRT-07. A signed claim is **not** a verification: nothing in BRT-06 evaluates authority or truth. See [`docs/implementation/BRT-06-EVIDENCE-MODEL.md`](./docs/implementation/BRT-06-EVIDENCE-MODEL.md) and [`BRT-06-ATTESTATION-PROTOCOL.md`](./docs/implementation/BRT-06-ATTESTATION-PROTOCOL.md).
- **BRT-07:** the Verification Engine / Sports Oracle: declarative, versioned verification policies bound to exact DisciplineVersions; a deterministic, hashable VerificationSnapshot assembled from canonical facts (signatures and hashes re-verified, real, occurrence-time-sliced participation / independence / conflict resolution, temporal BRT-03 authority); a pure V0–V4 evaluator with explanation traces; immutable, idempotent VerificationRuns with hash-based freshness and historical as-of replay; public-safe DTOs and a minimal web explorer. No scores or confidences. With today's canonical producers the honest production ceiling is **V1 Corroborated**, reached through counterparty corroboration (V1 needs no authority, and the BRT-01 registered-official path has no producer yet); V2–V4 are proven with typed reference fixtures that are never persisted. See [`docs/implementation/BRT-07-VERIFICATION-MODEL.md`](./docs/implementation/BRT-07-VERIFICATION-MODEL.md).
- **BRT-08:** Verified Achievements: declarative, versioned AchievementRules (closed criterion vocabulary, BRT-01 platform floors, bound without retroactivity to exact DisciplineVersions); a deterministic AchievementDerivationSnapshot and a pure engine producing candidates with an exact basis (ResultVersion + hash, CURRENT VerificationRun, Performance, credited lineup); immutable, idempotent Achievements (one TEAM Achievement with immutable `memberCredits` for a team title — BRT-01 AC-5); an append-only status history (ACTIVE / SUSPENDED / SUPERSEDED / REVOKED) with a dependency index for corrections; public DTOs and the Athlete Passport section. With today's canonical producers the honest output is **zero Achievements** (no V2, OFFICIAL/FINAL, hold facts or credited lineups yet); semantics are proven with in-memory reference fixtures and persistence mechanics in throwaway fixture databases. See [`docs/implementation/BRT-08-ACHIEVEMENT-MODEL.md`](./docs/implementation/BRT-08-ACHIEVEMENT-MODEL.md).

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
packages/    canonical, domain, authority, identity, competition, evidence, verification, persistence, schemas, testkit
db/          bootstrap (roles), migrations (plain SQL), docker init
docs/        archaeology, domain, architecture, security, api, adr, implementation
tooling/     CI helpers and repository guards
```
