# BRT-02 — API Surface (Conceptual)

| Field | Value |
|---|---|
| Ticket | BRT-02 |
| Status | Proposed — for review. This is a conceptual surface only; OpenAPI is deferred to BRT-03. |
| Related | [Identity & authority](../architecture/BRT-02-IDENTITY-AND-AUTHORITY.md), [Signatures](../architecture/BRT-02-SIGNATURES-AND-HASHING.md), [Data access model](../security/BRT-02-DATA-ACCESS-MODEL.md), [Persistence §7 idempotency](../architecture/BRT-02-PERSISTENCE-ARCHITECTURE.md#7-idempotency-model) |

---

## 1. Style and conventions

| Topic | Decision |
|---|---|
| Style | Resource-oriented **HTTP + JSON** (REST). Lifecycle transitions are explicit **command sub-resources** (`POST …/declare-official`), never generic `PATCH status`. |
| Versioning | URL major version `/v1`. Changes within a major version are additive only. Payload schemas carry `schemaId@version`. Deprecation is announced with `Sunset` headers. |
| IDs | TypeID rendering of UUIDv7 in APIs (`result_01j…`, `rv_01j…`) per [ADR-0013](../adr/ADR-0013-identifier-strategy.md). Content hashes are `sha256:<hex>`. |
| Idempotency | `Idempotency-Key` header is **required** on all POST commands. Natural keys are also enforced server-side. |
| Concurrency | `ETag` = version id or content hash; `If-Match` is required on mutable operational updates |
| Pagination | Cursor-based (UUIDv7 ordering), `limit` ≤ 200 |
| Errors | RFC 9457 Problem Details, with a machine-readable `code` (e.g. `AUTHORITY_DENIED`, `HOLD_ACTIVE`, `NON_CANONICAL_PAYLOAD`) |
| Time | RFC 3339 UTC |
| Auth | Session (web) or OAuth2 bearer (API clients); step-up MFA for sensitive operations; signed statements for trust actions |
| Public caching | Public GETs are cacheable; immutable resources (result versions, attestations, verifications) carry `Cache-Control: immutable` |

### 1.1 Signing flow for trust actions (two-step)

```
1. POST /v1/statements:prepare     { purpose, subject, claim, … }
   → { statement (canonical), statementHash, summary, nonce, expiresAt, eip712TypedData?, webauthnChallenge? }
2. Client signs (wallet / passkey / org key / device), or chooses platform witness (MFA step-up)
3. POST /v1/attestations           { envelope }              (or the transition endpoint that embeds the envelope)
   → 201 Attestation + authorization decision summary
```

**The server never signs on behalf of a user's key.** `PLATFORM_WITNESS` is an explicit, MFA-gated option and is labelled as such.

---

## 2. Audiences

| Audience | Authentication | Scope |
|---|---|---|
| **Public** | None / API key for rate tiers | Published competitions, results (current and historical versions), attestation metadata, verifications, achievements, records, rankings, public profiles, anchor proofs |
| **Athlete** | Account session | Own profile, privacy, wallets, claims, participant attestations, disputes as a party, own entitlements |
| **Organizer** | Account + org membership (RBAC) **plus** domain grants for trust actions | Competition operations, entries, result submission and acceptance, evidence upload |
| **Authority** | Account + principal + **domain grants**; signatures required | Declare official, attest, sanction, ratify, adjudicate, grant or revoke authority, assess evidence |
| **Integration / System** | Source principal credentials (HMAC, mTLS, OAuth client, device signatures) | Ingestion endpoints only |
| **Internal / Operator** | Operator SSO + RBAC + step-up; network-restricted | Review queues, governance proposals, rebuild jobs, support tooling (**cannot sign domain statements**) |

---

## 3. Resource groups

`P` = public read; `A` = athlete; `O` = organizer; `Au` = authority (grant-checked); `S` = system/integration; `I` = internal.

### 3.1 Catalog and organizations

| Endpoint | Aud. | Notes |
|---|---|---|
| `GET /v1/sports`, `/sports/{id}/disciplines`, `/disciplines/{id}/versions/{v}` | P | Includes JSON schemas, metrics and the content hash |
| `GET /v1/format-templates`, `/verification-policies/{id}/versions/{v}` | P | Policies are public, so trust rules are transparent |
| `GET/POST /v1/organizations`, `POST /organizations/{id}/verification-requests` | P / O | KYB documents go to the vault |
| `GET/POST/DELETE /v1/organizations/{id}/memberships` | O | RBAC only |

### 3.2 Identity and athletes

| Endpoint | Aud. | Notes |
|---|---|---|
| `GET /v1/me`, `PATCH /me/privacy` | A | |
| `POST /v1/me/wallet-links:challenge`, `POST /me/wallet-links` | A | SIWE/CAIP-122 proof of control |
| `DELETE /v1/me/wallet-links/{id}` | A | Closes the link |
| `POST /v1/me/guardianships`, `POST /me/guardianships/{id}/consents` | A | Guardian flows |
| `GET /v1/athletes/{id}` | P | Public profile (consent-aware) |
| `GET /v1/athletes/{id}/achievements`, `/records`, `/results` | P | |
| `POST /v1/athletes/{id}/claims` | A | Claim an unclaimed (imported) athlete; reviewed |

### 3.3 Competition operations

| Endpoint | Aud. | Notes |
|---|---|---|
| `GET /v1/competitions`, `/competitions/{id}` | P | Published only |
| `POST /v1/competitions`, `PATCH /competitions/{id}` | O | Governance profile, protest-window configuration |
| `POST /v1/competitions/{id}/events`, `…/events/{id}/rounds`, `…/rounds/{id}/contests` | O | |
| `POST /v1/events/{id}/participants`, `POST /participants/{id}/withdraw` | O / A | Registration linkage |
| `POST /v1/contests/{id}:start`, `:complete` | O | Freeze points; emits events |
| `GET /v1/contests/{id}` | P | Contestants, schedule, current result |

### 3.4 Results

| Endpoint | Aud. | Notes |
|---|---|---|
| `POST /v1/contests/{id}/result-drafts`, `PATCH /result-drafts/{id}` | O / A / Au | Mutable drafts (T1) |
| `POST /v1/result-drafts/{id}:submit` | O / A / Au | T2; returns ResultVersion + `contentHash` |
| `POST /v1/result-versions/{id}:accept` / `:reject` | Au | T3/T4 (`ACCEPT_RESULT`) |
| `POST /v1/result-versions/{id}:declare-official` | Au | T5; body includes the signed `RESULT_OFFICIAL` envelope |
| `POST /v1/result-versions/{id}:finalize` | Au | Early T6 (waiver); normally automatic |
| `POST /v1/result-versions/{id}:revoke` | Au | T8 (elevated when FINAL) |
| `GET /v1/results/{id}`, `/results/{id}/versions`, `/result-versions/{id}` | P | Full history; status transitions; hold flag |
| `GET /v1/result-versions/{id}/verification` | P | Current verification with criteria (explainable) |

### 3.5 Evidence

| Endpoint | Aud. | Notes |
|---|---|---|
| `POST /v1/evidence:upload-url` | O / A / Au | Pre-signed multipart; declared hash |
| `POST /v1/evidence` | O / A / Au / S | Commit an EvidenceItem after hash verification; subject links |
| `GET /v1/evidence/{id}` | P (metadata per class) | |
| `POST /v1/evidence/{id}:access` | A / O / Au | Returns a short-lived signed URL after class and purpose checks (audited) |
| `POST /v1/evidence/{id}/assessments` | Au | `ASSESS_EVIDENCE` |

### 3.6 Attestations, verification and authority

| Endpoint | Aud. | Notes |
|---|---|---|
| `POST /v1/statements:prepare` | A / Au / S | See §1.1 |
| `POST /v1/attestations`, `GET /attestations/{id}` | A / Au / S ; P | Accepted even if the authority is insufficient for the claimed role (stored with the actual role) |
| `POST /v1/attestations/{id}:revoke` | Au (issuer or higher) | |
| `GET /v1/verifications/{id}` | P | |
| `GET /v1/principals/{id}`, `/principals/{id}/keys` | P | Public keys and status history |
| `POST /v1/principals/{id}/keys`, `…/keys/{kid}:rotate`, `:declare-compromised` | Au | Signed statements |
| `GET /v1/grants`, `POST /grants`, `POST /grants/{id}:revoke` | P / Au | |
| `GET /v1/authorization:check?principal=&capability=&scope=&at=&asOf=` | P (rate-limited) | Explainable authorization decision, for third-party verifiers |
| `GET /v1/trust-anchors` | P | |
| `POST /v1/governance/anchor-proposals`, `…:approve` | I (governance signers) | M-of-N |
| `POST /v1/systems`, `/systems/{id}/devices`, `/systems/{id}/configurations` | O / Au | SYSTEM principals, DeviceRegistration, SystemConfiguration |

### 3.7 Disputes and corrections

| Endpoint | Aud. | Notes |
|---|---|---|
| `POST /v1/disputes` | A / O / Au | Standing checked |
| `GET /v1/disputes/{id}` | P (status) / parties (content) | |
| `POST /v1/disputes/{id}:admit`, `:reject`, `:resolve`, `:appeal`, `:withdraw` | Au / parties | Resolution requires a signed envelope |
| `POST /v1/results/{id}/corrections` | Au | New version + correction + downstream impact |
| `GET /v1/corrections/{id}` | P | Includes the diff and impact summary |

### 3.8 Consequences

| Endpoint | Aud. | Notes |
|---|---|---|
| `GET /v1/achievements`, `/achievements/{id}` | P | Basis, level, status history, evidence commitment + proofs |
| `GET /v1/record-categories`, `/records/{categoryId}/marks` | P | Naming follows the recognizing authority's scope |
| `POST /v1/record-marks/{id}:ratify` | Au | `RATIFY_RECORD`, signed |
| `GET /v1/rankings/{systemId}/snapshots`, `?view=as-published\|as-corrected` | P | |
| `POST /v1/competitions/{id}/prize-terms` | O / funder | Signed by the funder; immutable once funded |
| `GET /v1/prize-terms/{id}` | P | |
| `GET /v1/me/entitlements` | A | |
| `POST /v1/entitlements/{id}:request-payout` | A | Step-up MFA; creates **the** payout instruction (idempotent); executes only per terms and eligibility |
| `GET /v1/trophies/{id}`, `/trophy-classes` | P | Status resolved live from the achievement |
| `POST /v1/achievements/{id}/trophies` | A / O | Requests issuance (idempotent per class) |

### 3.9 Integrations and platform

| Endpoint | Aud. | Notes |
|---|---|---|
| `POST /v1/ingest/{adapterId}` | S | Webhook/push; raw-body HMAC or signatures |
| `GET /v1/ingest/envelopes/{id}` | S / I | Status |
| `GET /v1/anchors/batches/{id}`, `/anchors/proofs?ledger=&rowId=` | P | Merkle inclusion proofs and chain refs |
| `GET /v1/events` (later: webhooks subscriptions) | Developer (authorized) | Public domain-event feed without PII |
| `GET /internal/review-tasks`, `POST /internal/rebuild/*` | I | Operator tooling |

---

## 4. Explicitly absent endpoints

- No endpoint sets a verification level, an achievement or a record mark directly. These are only ever **derived**.
- No endpoint updates a submitted result version.
- No generic "admin override" endpoint. Overrides are elevated, signed domain commands (`AUTHORITY_OVERRIDE` corrections) subject to the authority engine.
- No debug or test endpoints in production builds (BRT-00 C-4, C-8).
