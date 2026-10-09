# BRT-02 — Implementation Stack Recommendation

| Field | Value |
|---|---|
| Ticket | BRT-02 |
| Status | Proposed — for review. **Nothing is installed or initialized in BRT-02.** |
| Basis | Requirements in the BRT-02 architecture docs; the ecosystem familiarity found in BRT-00 (TypeScript, Next.js, Supabase/Postgres, viem/wagmi); legacy anti-patterns to avoid (BRT-00 §18–19, §24) |

---

## 1. Recommended now

| Concern | Recommendation | Rationale |
|---|---|---|
| Language | **TypeScript** (strict mode, `noUncheckedIndexedAccess`), a single language across web, api and worker | Ecosystem familiarity; shared domain types; strong libraries for crypto (noble, jose, viem) |
| Runtime | **Node.js active LTS** | Mature; KMS SDKs; WebAuthn server libraries |
| Repo layout | **Monorepo** (pnpm workspaces): `apps/web`, `apps/api`, `apps/worker`, `packages/domain-*` (one per bounded context), `packages/canonical` (BR-JSON + hashing + test vectors), `packages/crypto` (envelope verification, KMS gateway), `packages/authority-engine`, `packages/verification-engine` | Enforces module boundaries (lint rules on imports); lets the engines be packaged for external verifiers |
| Web app | **Next.js** (App Router) for dashboards, passport and public pages, **as a client of the API only** | Familiar; SSR for public SEO pages. **It holds no DB credentials and no domain logic** (legacy padelflow and Poker mixed both). |
| API server | **Node HTTP framework with first-class JSON Schema validation** (e.g. Fastify) in `apps/api` | Framework-independent domain packages; long-lived processes (unlike serverless route handlers, which broke legacy in-memory rate limits); schema-driven validation |
| Worker | `apps/worker`, sharing domain packages; outbox dispatcher + job consumers | Same codebase, separate process and IAM |
| Database | **PostgreSQL** (current major, managed, PITR). **Supabase is acceptable as the managed host** given team familiarity, **with constraints:** no client access to canonical schemas; Data API not exposed for them; service credentials server-side only; RLS as defense in depth. Plain managed Postgres (RDS, Cloud SQL, Neon…) is equally acceptable. | ADR-0011 |
| DB access | **SQL-first**: a typed query builder (e.g. Kysely) + **plain SQL migrations** under a migration tool (e.g. dbmate / node-pg-migrate) | Append-only triggers, privileges, RLS, exclusion constraints and partial unique indexes are first-class in SQL; ORMs obscure them |
| Schema validation | **JSON Schema 2020-12** as the canonical language for domain payloads (discipline result schemas are content-addressed), with **Ajv** at runtime and TypeScript types generated (e.g. TypeBox) | Language-neutral schemas are needed for hashing, external verifiers and adapters. (Zod-only schemas are TS-bound.) |
| Canonicalization / hashing | `packages/canonical`: BR-JSON profile on top of a vetted JCS implementation, SHA-256 via `@noble/hashes` or WebCrypto, with published test vectors | ADR-0014 |
| Signatures | `jose` (JWS), `viem` (EIP-712/191 + EIP-1271/6492 verification), a WebAuthn server library (e.g. SimpleWebAuthn), `@noble/curves` (ES256K/Ed25519 raw), a COSE library for devices | ADR-0015 |
| Jobs / queue | **Postgres-backed queue** (e.g. pg-boss or Graphile Worker) + transactional outbox | ADR-0012 |
| Object storage | **S3-compatible private buckets** (Supabase Storage, S3 or R2), SSE-KMS, object lock for retention classes, pre-signed multipart uploads | ADR-0018 |
| KMS | **Cloud KMS** with asymmetric signing (P-256, and secp256k1 where needed for EVM anchoring), e.g. AWS KMS or Google Cloud KMS; a secret manager for integration secrets | ADR-0016. The vendor choice is a BRT-03 decision. |
| Auth (accounts) | Managed OIDC-capable auth (Supabase Auth if on Supabase, or equivalent) for **Accounts only**; **passkeys** supported; SIWE/CAIP-122 implemented in-app for wallet links and wallet login | Authority never comes from the auth provider |
| API style | REST + JSON, RFC 9457 errors, `/v1`, TypeID-rendered UUIDv7 ids; OpenAPI generated from schemas | [API surface](../api/BRT-02-API-SURFACE.md) |
| Observability | OpenTelemetry (traces, metrics), structured logs **without PII** | |
| Testing | Vitest; **property-based tests** (fast-check) for canonicalization and the authority engine; cross-language hash test vectors; ephemeral Postgres for integration tests (testcontainers) | The authority engine and canonical hashing are the highest-risk code |
| CI | Typecheck, lint (incl. module-boundary rules), tests, secret scanning, dependency audit, **pinned versions** with a lockfile, **no `ignoreBuildErrors`** | BRT-00 M-10 |

---

## 2. Later, when needed

| Technology | Trigger |
|---|---|
| Message broker (NATS JetStream or Kafka) fed by the outbox relay | Multiple independently deployed services, or external high-throughput event consumers |
| Separate Prize settlement service with its own keys and approvals | First real-value settlement |
| Multisig / threshold signing for settlement (Safe-style or MPC) | First on-chain escrow |
| HSM-backed governance keys or hardware security keys for governance signers | First external federation anchor |
| Smart-contract toolchain (Foundry) and audits | First on-chain credential or escrow (the Sports repo's Foundry scaffold is a reference, BRT-00 §20) |
| RFC 3161 timestamp authority integration | V4 ratifications and records |
| Search index (OpenSearch/Meilisearch) | Public discovery at scale |
| Read replicas / CDN for the public API | Public read traffic |
| Time-series / stream storage for sensor data | Continuous sensor ingestion |
| Video processing pipeline (transcode, redaction) as an isolated worker pool | Video evidence at volume |
| Verifiable Credentials (W3C VC 2.0) export of achievements | Partner demand for portable credentials |
| Transparency-log anchoring service (e.g. Sigstore-style log) | Anchoring before a chain is selected |

---

## 3. Not recommended

| Technology / pattern | Why |
|---|---|
| Client-side DB writes with a public/anon key; permissive RLS | BRT-00 C-3, H-16 |
| Storing any user private key, mnemonic or "encrypted wallet credentials" | BRT-00 C-2; ADR-0009; ADR-0016 |
| Microservices from day one | Operational cost without a trust or scale justification (ADR-0010) |
| Next.js route handlers as the core domain API | Couples domain to UI deployment; serverless limitations; legacy precedent of logic sprawl |
| MongoDB or other document DB as the system of record | Weak constraints for a ledger-heavy relational domain (the PadelChain README proposed MongoDB, BRT-00 §9) |
| IPFS or public storage for private evidence | Irrevocable publication |
| Blockchain as the operational database | Cost, privacy, and mutability semantics (chains anchor; they do not store) |
| In-memory rate limiting on serverless | BRT-00 L-2 |
| `latest` dependency pins, ignored type or lint errors | BRT-00 M-10 |
| Remix-only contract imports, deprecated OZ APIs, Hardhat configs mixed across major versions | BRT-00 M-11 |
| Custom password authentication | BRT-00 C-4, H-2, H-3 |
| Mock services reachable in production builds | BRT-00 H-15 |
