# BRT-02 — Data Access Model (RLS, Application Authorization, Domain Authority)

| Field | Value |
|---|---|
| Ticket | BRT-02 |
| Status | Proposed — for review. **No SQL policies are written here.** |
| Implements | BRT-01 [Data boundaries](../architecture/BRT-01-DATA-BOUNDARIES.md) (privacy classes, DB-1…DB-6) |
| ADR | [0020 three-layer authorization](../adr/ADR-0020-three-layer-authorization.md) |

---

## 1. Three layers, three purposes

| Layer | Purpose | Enforces | Must NOT be used for |
|---|---|---|---|
| **Database RLS and privileges** | *Blast-radius limitation and defense in depth.* Even a buggy or compromised API process cannot read or write outside its lane. | Deny-all default; per-module roles; the PII vault is readable only by the vault role; row filters for tenant and ownership on sensitive tables; no UPDATE/DELETE on ledgers | Domain authority decisions: grant chains and time-bounded capability. They are too complex for, and not auditable in, SQL policies. |
| **Application authorization** | *Who may use which endpoint or screen*, based on authenticated account, organization membership (RBAC), ownership and guardianship | Dashboard roles (OWNER, ADMIN, STAFF, VIEWER); "own data" access; on-behalf-of for guardians; rate limits; step-up MFA | Deciding whether a result is official or an attestation counts |
| **Domain Authority Engine** | *Whether a principal can exercise a capability over a scope at a time* | BRT-01 §4.5 rules: anchors, grants, delegation, scope, validity, revocation, conflict of interest | UI permissions or data visibility |

**Example.** A club staff member (ADMIN membership) edits the tournament schedule. That is allowed by layer 2. The same person declaring a result official requires a `DECLARE_OFFICIAL` grant, checked by layer 3. Their session can reach the relevant tables only because the Results module role is allowed to insert, which is layer 1. In a single request, all three layers answer different questions.

---

## 2. Database access topology

| DB role | Used by | Can |
|---|---|---|
| `app_<module>` (one per bounded context) | api/worker code of that module | SELECT/INSERT on own ledger (class A) tables; SELECT/INSERT/UPDATE on own projection (class B) and operational tables; SELECT on explicitly shared views of other modules |
| `app_vault` | Identity module's vault service only | Access PII vault tables; decrypt via KMS data keys (AUTHORITY-ONLY fields need an extra KMS permission) |
| `app_public_read` | Public read API | SELECT on public read-model views only |
| `app_audit_writer` | All modules (through a function) | INSERT into audit only |
| `rebuild` | Projection and cache rebuild jobs (audited) | Write class B projections and class C caches; read class A; **no** write on class A |
| `owner_migrations` | Migration pipeline | DDL; never used at runtime; break-glass with approvals |
| **No `anon` / client role on canonical schemas** | — | Clients never connect to the DB. If hosted on Supabase, the public PostgREST/Data API is **not exposed** for canonical schemas (BRT-00 C-3 lesson). |

**RLS in this topology** filters rows *within* a module role's reach. The request context (account id, principal id, organization ids, purpose) is set per transaction through session variables by the API.

---

## 3. Access matrix by data category

| Data category | Class (BRT-01) | RLS (layer 1) | App authz (layer 2) | Domain authority (layer 3) |
|---|---|---|---|---|
| **Athlete private data** (legal name, DOB, contact) | PLATFORM-PRIVATE | Vault only; row filter `person_id = ctx.person_id` or organizer-of-entry with purpose `EVENT_OPERATION` within the retention window | Self; guardian (on-behalf-of); organizer staff for own event participants (contact only, purpose-bound) | — (not an authority question) |
| **Public athlete profile** | PUBLIC (as chosen) | Public read view of the athlete's chosen display fields only; minors are excluded unless consent flags are set | Anyone | — |
| **Organization data** (profile, members) | PUBLIC profile; PLATFORM-PRIVATE membership details | Membership rows readable by the org's members | Org roles | — |
| **Organization KYB documents** | AUTHORITY-ONLY | Vault; KMS decrypt requires the verification-reviewer role | Platform verification reviewers only | — |
| **Competition operations** (config, schedules, draws) | PUBLIC once published; drafts private | Org-scoped for drafts | Org roles (edit before freeze points) | Freeze-point overrides need domain capability (e.g. `CORRECT_RESULT` for post-start contestant changes) |
| **Results and trust ledgers** | PUBLIC (ids, marks, attestation metadata) | Insert-only for owning module; public read views | Submit, accept and declare endpoints require an authenticated principal | **All transitions and attestations** |
| **Evidence metadata** | PUBLIC hash plus type; other metadata per class | Row filter by privacy class | Uploader; organizer for own events; parties to the contest (PLATFORM_PRIVATE) | AUTHORITY_ONLY reads require a grant covering the purpose (`ASSESS_EVIDENCE`, `ADJUDICATE_DISPUTE`, `ATTEST_IDENTITY`) |
| **Evidence bytes** | per item | Not in DB; signed URLs only | As above; plus signed-URL TTL ≤ 5 min | As above |
| **Minor data** (DOB, consent, media) | AUTHORITY-ONLY / PLATFORM-PRIVATE | Vault; separate KMS key; row filter includes a guardian link check | Guardian; the minor (per policy); organizer limited to eligibility outcome only (not DOB) | `ATTEST_ELIGIBILITY` principals see the documents needed for eligibility, access-logged |
| **Authority operations** (grants, anchors, keys) | PUBLIC (grant existence, scope, capability, validity, issuer); private: governance deliberations | Insert-only (Authority module) | Grant endpoints are available to principals only | Grantor authority checked for every grant or revoke |
| **Disputes** | Existence and status PUBLIC; content PLATFORM-PRIVATE or AUTHORITY-ONLY | Row filter: filer, parties, adjudicator | Parties may view their dispute; adjudicator console | `ADJUDICATE_DISPUTE` / `APPEAL_ADJUDICATE` to act |
| **Prize financial data** (terms, entitlements, payout instructions, beneficiary payout details) | Terms PUBLIC (amounts, slots); beneficiary payout details PLATFORM-PRIVATE; KYC AUTHORITY-ONLY | Prize module role only; beneficiary rows filtered by beneficiary | Beneficiary; funder (aggregate); finance operators with step-up MFA | Eligibility per the verification permission matrix; execution per PrizeTerms policy |
| **Audit log** | PLATFORM-PRIVATE | Audit readers (read-only), no updates | Security operators | — |

---

## 4. Purpose binding

Sensitive reads (PLATFORM-PRIVATE beyond "own data", and all AUTHORITY-ONLY reads) must declare a **purpose**: `EVENT_OPERATION`, `ELIGIBILITY_CHECK`, `DISPUTE_ADJUDICATION`, `IDENTITY_VERIFICATION`, `PRIZE_FULFILMENT`, `LEGAL_REQUEST` or `SECURITY_INCIDENT`.

- **Recording.** The purpose is recorded in the audit event.
- **Checking.** For AUTHORITY-ONLY reads, the purpose must match a capability in a valid grant (layer 3), or a platform compliance role for the last two purposes.

---

## 5. Minors

These rules are structural. Jurisdiction-specific policy is out of scope.

- **Public visibility is off by default:** public views exclude minors unless a `consent_public_profile` flag, backed by a guardian consent record, is present.
- **Minors' media** is AUTHORITY-ONLY until consent.
- **No credential issuance to a minor's wallet** without a guardian consent record (checked by the Trophies module before calling the CredentialPort).
- **Organizers see an eligibility outcome** ("eligible for U18 category"), not the DOB.

---

## 6. Erasure and crypto-shredding

1. An erasure request (verified) goes to the Identity module.
2. Vault PII is deleted or pseudonymized. Account and AuthenticationIdentities are deleted. WalletLinks are closed.
3. The per-athlete commitment salt is destroyed, which makes on-chain commitments unlinkable (BRT-01 ADR-0009).
4. The Athlete becomes a tombstone alias. Ledgers keep ids and hashes only (no PII), so sporting facts can remain as anonymous history, subject to the legal basis decision (open).
5. Evidence items whose privacy class indicates personal content have their blobs deleted unless under retention lock (e.g. an open dispute or record support). The decision is logged.
