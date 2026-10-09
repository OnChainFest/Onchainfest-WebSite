# BRT-06 — Evidence & Attestation Threat Review

| Field | Value |
|---|---|
| Scope | Evidence ingestion/storage/access, attestation ceremony, key onboarding, retraction, Evidence Bundle, public DTOs, roles |
| Builds on | [BRT-02 threat model](./BRT-02-THREAT-MODEL.md), [BRT-04 identity review](./BRT-04-IDENTITY-THREAT-REVIEW.md), [BRT-05 competition review](./BRT-05-COMPETITION-THREAT-REVIEW.md) |
| Tests | `packages/evidence/src/*.test.ts`, `packages/persistence/src/{evidence,attestation,evidence-roles}.int.test.ts`, `apps/api/src/evidence.int.test.ts`, `pnpm demo:evidence` |

Legend: **M** mitigated in BRT-06 (with the proving test) · **P** partially mitigated · **D** deferred (explicit).

| # | Threat | Status | Mitigation | Proof |
|---|---|---|---|---|
| 1 | Malicious upload (HTML/script, SVG script, executables) | M (scanning D) | Media allow-list without parameters; leading-byte checks; markup-first text refused; PE/ELF/Mach-O/shebang refused; bytes never parsed/rendered/executed; downloads `attachment` + `nosniff` + CSP `sandbox` + `no-store`. Production malware scanning deferred. | media unit tests; API 415 test; content-header test |
| 2 | Path traversal | M | Paths derived only from a validated `sha256:<64 hex>`; resolved path must stay under the root; rows hold no paths | storage test "path traversal" |
| 3 | Content-type spoofing | M | Declared type must match magic/UTF-8 checks; mismatch → `EVIDENCE_TYPE_NOT_ALLOWED` | media tests (PDF label on HTML, PNG label on MZ) |
| 4 | Oversized evidence / archive bombs | M | 2 MiB reference cap, route `bodyLimit`, streaming `maxBytes`; archives/compressed streams refused | 413 API test; store `EVIDENCE_TOO_LARGE` |
| 5 | Evidence replacement | M | Content-addressed, immutable items; append-only tables (owner too); a changed file is a new item with lineage; read re-hashes plaintext against the address | BR001 tests; swapped-object storage test |
| 6 | Blob hash-collision assumptions | M (assumption documented) | SHA-256 second-preimage resistance assumed (ADR-0014); dedupe only by full 256-bit hash; provenance never deduplicated by hash; items bind (id, content hash, descriptor hash) | provenance tests |
| 7 | Private evidence leakage | M | Default `PLATFORM_PRIVATE`; no raw public path; public card has counts only; sentinels absent from public DTOs, outbox, audit, idempotency, read models, blob registry, logs, disk | API sentinel test; demo step 39 |
| 8 | Cross-tenant access / IDOR | M | Central policy in-transaction; staff only via attachments to their competition; unknown ≡ forbidden (same 404 body); denials audited | IDOR tests (account, C2 staff, participant) |
| 9 | Minor privacy | M | No age inference, no vault access from `br_evidence` (role test); person issuers shown as "Individual signer"; guardians cannot sign as or register keys for dependents | guardian test; role test |
| 10 | Signature replay | M | 128-bit nonce, single-use consumption (PK + UNIQUE + trigger), `UNIQUE(issuer, nonce)`, `statement_hash UNIQUE`, strict expiry, account binding | replay tests; 20× concurrent submission |
| 11 | Signature substitution | M | kid = registered key id in the protected header; key must belong to the issuer; key already bound to another principal refused at registration | wrong-kid / foreign-key tests |
| 12 | Wrong-audience replay | M | Audience inside the statement + per-deployment check at submit | staging→dev test; vector `signing-tamper-audience` |
| 13 | Key compromise | M (evaluation D) | Compromise declarations are append-only and retroactive; admissibility refuses compromised keys at acceptance; history is never rewritten; the bundle exposes status changes with `recordedAt` for BRT-07 | retroactive compromise test; demo step 38 |
| 14 | Signer timestamp backdating | M | `signedAt` is server-proposed and only restricts; admissibility at platform `issuedAt`; `issued_at ≤ expires_at` CHECK; no new skew | key-admissibility unit tests |
| 15 | Issuer impersonation | M | DB representation function at prepare and submit; ISSUER_NOT_CONTROLLED audited | stranger tests |
| 16 | Org-admin vs authority confusion | M | Representation is an application permission; no grant/anchor is ever created; `ATTEST_RESULT` denied; FEDERATION `org_type` confers nothing; DTOs say `authority: NOT_EVALUATED` | authority-separation tests; demo step 37 |
| 17 | Guardian impersonation | M | `ensure_person_principal` is SELF-only; representation has no guardian basis | guardian test |
| 18 | Attestation tampering | M | Server-canonicalized statement; echo re-canonicalized; triggers bind columns to the stored statement; statement re-hash on read + signature re-verification | tamper unit/integration/API tests; vectors |
| 19 | Retraction tampering | M | Signed retraction bound to the exact attestation statement hash; only the original issuer principal; UNIQUE per attestation; trigger binding | retraction tests; 20× concurrent retraction |
| 20 | Evidence deletion | M | No hard delete for any role; deletion = availability fact; descriptor/hash/references remain; purge is INTERNAL and blob purge waits for every item over the blob | availability tests |
| 21 | Orphan blobs | P | Blob-first ordering prevents dangling item pointers; orphans after a crash are encrypted and unreferenced; GC job deferred | storage-atomicity design |
| 22 | Public hash correlation | M | Public DTOs omit content, descriptor and statement hashes, nonces and keys | card regex test |
| 23 | Log leakage | M | Logs redact auth headers; no bodies logged; error bodies never echo values; sentinel scan over captured log lines | API sentinel test |
| 24 | Outbox leakage | M | Outbox payloads carry ids, hashes, statuses and enums only; sentinel scan | integration + API tests |
| 25 | Test-verifier leakage | M | There is **no** test-only attestation proof scheme; DB CHECKs allow only `JWS_DETACHED` + `jws-detached/v1`; `createEphemeralSigner` (signer side) refuses production; the public vector key is never registrable | CHECK constraints; vector-key test |
| 26 | Evidence-bundle nondeterminism | M | Pure builder, sets with declared sort keys, explicit asOf, future asOf refused, stable ids only; shuffled-input property test; rebuild-identity test | bundle unit + integration tests; demo step 31 |
| 27 | Private key custody | M | Public JWK only (closed schemas, verifier, DB CHECK); repository guard for PEM/JWK/seed/dev secrets; no keys in rows/logs/outbox | key tests; guard probe |
| 28 | Role escalation | M | `br_evidence` reachable only from `br_api`; cannot read identity_private/auth identities or write authority/results/competition; worker/vault/operator/maintenance/probe cannot assume it; no role configuration holds secrets | `evidence-roles.int.test.ts`; exact graph in `security.int.test.ts` |
| 29 | Denial of service (bulk uploads, challenge spam) | D | Size caps only; rate limiting deferred | — |
| 30 | Non-monotonic DB clock (VM time step) | M (env. concern) | BRT-06 never rewrites a timestamp and assumes no ordering between separate clock readings (BRT-06R removed the receipt clamp and the cross-transaction CHECK); attestation times are one atomic reading. The pre-existing BRT-03 authority evaluation at DB `now()` can deny right after a backwards step — a deployment/environment concern (keep DB hosts NTP-disciplined; observed once under WSL/Docker Desktop) | `hardening.int.test.ts` §1; development guide §6 |

**Residual risks / deferred:** production object store + KMS + signed URLs; malware scanning; legal hold / retention schedules / cold tiers; blob GC; WebAuthn, wallet and device proof schemes; platform witness; authority-grant-based access to AUTHORITY_ONLY evidence; rate limiting; RFC 3161 timestamps; external anchoring.

## BRT-06R — final trust-boundary & cryptographic hardening

**Time.** The receipt clamp (`observedAt = min(receivedAt, txTime)`) and `CHECK (received_at <= recorded_at)` were removed: they compared two independent readings of the database clock and would have rewritten an observed time after a clock step. `received_at` is stored and hashed verbatim; attestation `received_at = issued_at = recorded_at` is one reading (DB equality CHECK). `SIGNER_CLOCK_SKEW_MS` is used only for the source-asserted `capturedAt` (scan test). Key admissibility is unchanged (platform `issuedAt`; `signedAt` only restricts).

**Person ↔ Principal.** PK(person) + UNIQUE(principal) + composite FK `(principal_id, 'PERSON') → authority.principal(id, principal_type)` + FK person + append-only triggers + `person_id <> principal_id`. Creation only through `identity.ensure_person_principal` (SELF, ACTIVE account, exclusive advisory lock per person, single transaction). Proven: 20 concurrent calls → one principal, one mapping, zero orphans; raw PERSON→ORGANIZATION, shared-principal, second-principal and dangling mappings rejected (23503/23505); UPDATE/DELETE rejected (BR001); `br_identity` cannot insert principals or mappings directly.

**SECURITY DEFINER inventory** (all owned by `br_owner`, `search_path = pg_catalog, pg_temp`, PUBLIC revoked; proven in `hardening.int.test.ts` §3 by catalog inspection and direct SQL per role):

| Function | Volatility | EXECUTE | Reads | Writes | Returns | Why each grantee |
|---|---|---|---|---|---|---|
| `results.resolve_result_version(uuid)` | STABLE | br_evidence, br_rebuild | results.result_version, results.result | — | ids, version number, content hash, content schema, scope type/target | evidence: pin/attach/attest exact versions; rebuild: metadata-only card rebuild |
| `competition.resolve_scope_path(text, uuid)` (BRT-05; newly exposed) | STABLE | br_authority, br_competition, br_results (BRT-05) + br_evidence, br_rebuild | competition.contest/round/event/competition/competition_profile, sports.* | — | ids + sport/discipline/region codes | evidence: attachment competition + bundle scope; rebuild: card hierarchy ids |
| `competition.account_competition_roles(uuid, uuid)` | STABLE | br_evidence | identity.account_person_control, v_account_current; competition.competition_staff, v_staff_current, competition; organizations.membership, v_membership_current, v_organization_current | — | staff-role codes (application permissions only) | evidence access policy for competition staff |
| `authority.account_principal_representation(uuid, uuid)` | VOLATILE (advisory locks only) | br_authority, br_evidence | identity.account_person_control, v_account_current, person_principal; organizations.organization_principal, membership, v_membership_current, v_organization_current | — | `PERSON_SELF` / `ORGANIZATION_ADMIN` / NULL | authority: key ceremony; evidence: issuer/source representation |
| `identity.ensure_person_principal(uuid, uuid)` | VOLATILE | br_identity | identity.account_person_control, v_account_current, person_principal | authority.principal, identity.person_principal, platform.outbox_event (exactly these) | principal id or NULL | identity owns the person → principal mapping |
| `evidence.assert_attachment_target()` | trigger | — (not callable) | results/competition via the resolvers | — | row | cross-target integrity check |
| `attestation.assert_attestation_binding()` | trigger | — (not callable) | attestation.*, authority.principal/principal_key, resolver | — | row | statement/column/challenge/subject binding |

No other role (vault, operator, worker, public read, organizations, probe) can call any of them; STABLE helpers cannot write, and neither `br_evidence` nor `br_rebuild` can mutate results, competition, authority or evidence facts (direct SQL tests). None accepts SQL text or identifiers — every parameter is a typed uuid (or the fixed hierarchy level of `resolve_scope_path`).

**JWS / keys.** See [attestation protocol §4.2](../implementation/BRT-06-ATTESTATION-PROTOCOL.md#42-signing-preimage-test-vector-backed) (standards review) and §3 (RFC 7638 identity). Vectors now cover EdDSA **and** ES256 (accept, tamper, header rules, DER/length, key substitution) and JWK identity; the independent Python checker verifies the actual signatures with its own Ed25519 and P-256 ECDSA implementations (a corrupted signature makes it fail).
