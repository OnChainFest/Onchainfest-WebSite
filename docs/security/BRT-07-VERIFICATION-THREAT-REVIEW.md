# BRT-07 — Verification Engine Threat Review

| Field | Value |
|---|---|
| Scope | Policies and bindings, snapshot assembly, pure engine, runs, freshness, read models, public DTOs, APIs, roles, web surface |
| Builds on | [BRT-02 threat model](./BRT-02-THREAT-MODEL.md), [BRT-05](./BRT-05-COMPETITION-THREAT-REVIEW.md), [BRT-06](./BRT-06-EVIDENCE-ATTESTATION-THREAT-REVIEW.md) |
| Tests | `packages/verification/src/*.test.ts`, `packages/persistence/src/verification{,-roles}.int.test.ts`, `apps/api/src/verification.int.test.ts`, updated `security` / `hardening` / `competition-roles` integration tests, `pnpm demo:verification` |

Legend: **M** mitigated (with proof) · **P** partially · **D** deferred.

| # | Threat | Status | Mitigation | Proof |
|---|---|---|---|---|
| 1 | Manual level forgery | M | Levels exist only in engine outcomes; no setter / override / force code path; closed request schemas; runs only from self-assembled snapshots; DB binds run columns to the outcome document (BR093) | lint guard (+ probe); API 400 tests for `desiredLevel`/`forceLevel`/`manualOverride`/`confidence`/`ignoreConflict` |
| 2 | Policy tampering | M | Versions immutable (append-only incl. owner); spec hash re-validated at publication and on every snapshot/evaluation (POLICY_HASH_MISMATCH) | roles test (owner UPDATE → BR001); engine + assembler integrity tests |
| 3 | Policy backdating | M | `effective_from ≥ recorded_at` CHECK (strict), store BACKDATING_REJECTED, strictly increasing bindings | roles test (direct SQL 23514); API test |
| 4 | Phantom unsupported facts | M | Production `supportedFactKinds` = today's producers only; unsupported kinds → INPUT_NOT_SUPPORTED, never defaulted, inferred or manufactured | integration + demo (V2 INPUT_NOT_SUPPORTED) |
| 5 | Synthetic fixture leakage into production | M | Fixtures under a separate entry point, `provenance: REFERENCE_FIXTURE`; no API/store accepts a snapshot; DB CHECK `snapshot_provenance = 'CANONICAL_ASSEMBLY'` | direct-insert test (23514); demo step 30/59 |
| 6 | Authority replay / later grant back-authorizing | M | BRT-03 authorization at the fact's `issuedAt`; grants never backdated | engine + real-grant tests (`GRANT_NOT_VALID_AT_TIME`) |
| 7 | Expired / revoked grant | M | Validity windows; ordinary revocation prospective, compromise retroactive | engine + integration tests |
| 8 | Scope widening / sibling scope borrowing | M | BRT-03 exact containment over the DB-resolved hierarchy (never ids/slugs) | engine + integration + demo step 53 |
| 9 | RecognitionLevel vs VerificationLevel confusion | M | Disjoint values, compile-time guard, separate ranking helpers | unit test |
| 10 | Organization-type authority spoofing | M | `org_type` never read by the engine; FEDERATION organization without grants has NO_STANDING / no certification | integration + engine tests |
| 11 | Competition operational role → authority | M | Staff / organizer admin are relations only; authority needs grants | integration + engine tests |
| 12 | Corroboration Sybil (many attestations / keys) | M | Principal-based issuer groups | tests, demo step 15 |
| 13 | Duplicate attestations | M | Set semantics; groups by principal | engine tests |
| 14 | Derived-evidence inflation | M | Lineage roots + source principals | engine tests (V4) |
| 15 | Missing participation index | M | Real structural resolver from canonical facts (BRT-07) | participation unit tests; real-data V1 tests |
| 16 | Unknown conflict interpreted as safe | M | Unresolved principal / unresolved slot → UNAVAILABLE / UNKNOWN (never CLEAR, never PASS) | engine + integration tests |
| 17 | Active dispute suppression | M | Counting DENY claims always evaluated; public `activeDispute`; retraction requires a signed statement | dispute tests, demo 31–35 |
| 18 | Retracted support reuse | M | Retraction → RETRACTED status at the cutoff; supersession → SUPERSEDED | tests |
| 19 | Key compromise | M | Retroactive compromise → SUSPECT; stale detection; history intact | integration + demo 36–38 |
| 20 | Stale verification presented as current | M | Hash-based freshness; STALE shows only `lastEvaluated`; web says "historical, not current" | API + integration tests |
| 21 | Policy drift | M | Runs pinned to policy version + spec hash; new binding → STALE; old runs keep their documents | policy-change tests |
| 22 | Snapshot nondeterminism | M | Sets, canonical scalars, cutoff as metadata, no clock/random/env in the engine; REPEATABLE READ loading | property tests, vectors, demo 42–45 |
| 23 | Trace / outcome tampering | M | Documents stored with hashes; re-hashed on read (RUN_HASH_MISMATCH); append-only; ledger-chained | code path + trigger tests |
| 24 | Result mutation by verification | M | No write privilege on results; no transition code | role tests; demo 21 |
| 25 | Bracket mutation | M | No write privilege on competition | role tests; demo 22 |
| 26 | PII leakage | M | No PII tables readable by `br_verification`; public DTOs from outcome only; sentinel scans | role + API sentinel tests; demo 49 |
| 27 | Evidence leakage | M | No evidence bytes, blob registry or cipher; public DTOs carry no evidence hashes/ids | role tests; public DTO tests |
| 28 | Cross-schema privilege escalation | M | Read-only direct grants on exact tables; module roles members of nothing; operator login reaches only its role | `verification-roles.int.test.ts`, `security.int.test.ts` |
| 29 | SECURITY DEFINER abuse | M | No new definer function; the verification triggers are INVOKER with fixed `search_path` and no PUBLIC EXECUTE; existing resolvers gained one narrow grantee each (inventory updated) | roles + hardening tests |
| 30 | Clock rollback | M (env.) | Single DB-time cutoff; REPEATABLE READ; fail closed (VERIFICATION_TIME_INCONSISTENT) after two bounded retries; no clamping | assembler tests; measured WSL clock steps (~1 s / ~29 s) |
| 31 | AI-only certification | M | E-4 is a non-bypassable engine rule | engine tests; demo 55 |
| 32 | Manual override endpoints | M | None exist; guard scans | lint guard |
| 33 | Generic "Verified" overstatement | M | Exact labels with level; fixed public wording; no score | DTO/unit tests |
| 34 | Denial of service (expensive public freshness reads re-assemble snapshots) | D | Bounded collections in schemas; rate limiting / caching deferred | — |
| 35 | Stale BRT-06 wording on attestation cards | M | BRT-07R: the cards now say `sportingVerification: EVALUATED_SEPARATELY` and link `verificationResource` (`/v1/result-versions/:id/verification`). No V-level is ever copied onto an attestation, and no `NOT_IMPLEMENTED` remains on the card or web | persistence + API regression tests |
| 36 | ATTEST_RESULT grant used as a V1 "registered official" | M | V1 consults no authority. Registered official is a distinct structural fact (`REGISTERED_OFFICIAL`, no producer → `NOT_SUPPORTED_REGISTERED_OFFICIAL`) | engine tests A–F, integration |
| 37 | Stale or future memberships counted as teammates ("conflicted forever") | M | Relations are time-sliced at the occurrence window. An undecidable overlap is UNKNOWN, never CLEAR, and a direct participant always conflicts | assembler + engine + integration tests |
| 38 | Clock slack widening key/grant validity | M | No tolerance anywhere in verification (source-scan test). Only whole-evaluation retries with a fresh cutoff | `clock.test.ts` |

**SECURITY DEFINER inventory change.** No new definer functions. EXECUTE newly granted to `br_verification` on `results.resolve_result_version(uuid)`, `competition.resolve_scope_path(text, uuid)` and `competition.account_competition_roles(uuid, uuid)` (all STABLE, read-only, typed parameters, ids/codes only). New INVOKER trigger functions: `verification.assert_policy_transition`, `assert_policy_binding`, `assert_run_binding`, `assert_trace_binding`.

**Residual risks / deferred:** the occurrence window uses transaction-time contest status facts. An operator who records IN_PROGRESS late narrows the window, and an absent IN_PROGRESS leaves ended relations UNDETERMINED (fail closed). No registered-official producer exists; authority precedence among authorized deniers is not modelled (any authorized DENY blocks); certified-machine evidence paths (§2.6) have no producer; a historical replay at a run's cutoff can differ from the run if a transaction that began before the cutoff committed after it (recorded_at = transaction start, BRT-03 design) — the run's own snapshot hash remains authoritative; public freshness re-assembles a snapshot per request (cost).
