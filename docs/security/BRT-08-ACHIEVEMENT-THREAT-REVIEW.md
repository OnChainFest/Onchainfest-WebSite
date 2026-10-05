# BRT-08 — Verified Achievement Threat Review

| Field | Value |
|---|---|
| Scope | Rules and bindings, derivation snapshots, pure engine, validated writer, status history, dependency index, read models, public DTOs, Passport, APIs, worker, roles, the fixture lanes, the web surface |
| Builds on | [BRT-02 threat model](./BRT-02-THREAT-MODEL.md), [BRT-07 review](./BRT-07-VERIFICATION-THREAT-REVIEW.md) |
| Tests | `packages/achievements/src/*.test.ts`, `packages/persistence/src/achievement{,-fixture,-roles}.int.test.ts`, `apps/api/src/achievements.int.test.ts`, the updated `security` / `hardening` / `competition-roles` / `identity` / `attestation` integration tests, `pnpm demo:achievements`, `tooling/check-no-manual-achievement.mjs` |

Legend: **M** mitigated (with proof) · **P** partially mitigated · **D** deferred.

| # | Threat | Status | Mitigation | Proof |
|---|---|---|---|---|
| 1 | Manual Achievement forgery | M | No award, force or manual route or method. The only writer re-derives the candidate from its snapshot. DB triggers bind columns to the candidate and check upstream canonical facts. | lint guard; API tests (`POST /v1/achievements` → 404, closed bodies → 400); demo step 9 |
| 2 | Winner / title forgery | M | Titles come only from explicit classification ranks (never status, order, slug or name). A CANONICAL_ASSEMBLY snapshot must equal the canonical re-assembly. | engine tests (`no winner inference`); `forged CANONICAL_ASSEMBLY snapshot` test |
| 3 | Holder substitution | M | Holder resolved from snapshot participants; `validateCandidate` re-checks team / athlete; identity and candidate hashes | fixture test `forged candidates never validate` |
| 4 | Lineup inflation / unused roster member credited | M | Credits come only from the credited lineup in Result content (ADR-0026; never the declared lineup, roster or membership). They are immutable and hashed, and the trigger requires them to be candidate elements. | engine + fixture tests; demo steps 10 and 16 |
| 5 | VerificationRun substitution | M | The basis pins run id + snapshot / outcome hashes + level. The trigger checks run ↔ version, the hashes and `highest_level` against `verification.run`. | trigger BR129; forged-snapshot test |
| 6 | Stale verification issuance | M | BRT-07 hash-based freshness computed in the derivation transaction; only CURRENT issues | engine test; API / demo (`VERIFICATION_STALE`) |
| 7 | Verification-floor downgrade (rule or request) | M | Floors enforced at version creation and publication, then again in the engine (`effectiveRequirements`) and the DB (BR127). Requests carry no level. | rule tests; store test; API 400 |
| 8 | Rule tampering | M | Versions are append-only (including for the owner); the spec hash is re-validated at publication and on every derivation (`RULE_HASH_MISMATCH`); the trigger requires the PUBLISHED version with the same spec hash | roles test (UPDATE → BR001); engine integrity test |
| 9 | Rule backdating / retroactive manufacture | M | `effective_from ≥ recorded_at` (CHECK + store); a binding applies only to versions submitted while it is in force | store / direct-SQL tests; `late rule` test |
| 10 | Rule mutation after publication | M | Immutable versions; status only DRAFT → PUBLISHED → RETIRED (BR111) | tests |
| 11 | Metric substitution / cross-discipline confusion | M | The rule names the exact DisciplineVersion plus metric key and `markMetricId`; unit and precision checked; no unit conversion; exact decimals; PB only within one DisciplineVersion | rule and engine tests (wrong metric / DV / unit) |
| 12 | qualifyingValue forgery | M | Must equal the source Performance mark byte for byte (engine + writer + candidate hash) | fixture forge test; threshold persistence test |
| 13 | Basis hash substitution | M | Content hash re-derived from stored content (`CONTENT_HASH_MISMATCH`); trigger BR128 | loader + trigger |
| 14 | Duplicate issuance | M | `UNIQUE(identity_hash)` (AC-2); advisory lock | repeat tests |
| 15 | Concurrent duplicate derivation | M | Retryable constraint → the "existing" path; no raw error | 20× concurrency test and demo: 1 Achievement + 2 credits |
| 16 | Correction not propagating | M | Dependency index; re-assessment on re-derivation and worker events; supersession links | correction / lineup / flip tests |
| 17 | Revoked Result basis still shown current | M | `assessSupport` → REVOKED; the public DTO shows it as historical | revocation test |
| 18 | Key compromise / stale verification not propagating | M | Reads re-assess non-terminal Achievements **live** (BRT-07 freshness of the pinned run; fail closed). The worker records re-assessments on every staleness-causing event (idempotent). A stale pinned run is never shown as current (BRT-08R) | fixture staleness test (no new run); canonical worker-login STALE test |
| 19 | Synthetic fixture persistence | M | Normal schema CHECK (`CANONICAL_ASSEMBLY` only); overlay is test-only, name-guarded and owner-only; no runtime role can ALTER; fixtures never touch upstream tables; public reader filters provenance too | hard-boundary tests (normal vs overlay DB); roles tests; demo Part C |
| 20 | PII leakage | M | Snapshots and events contain ids only; the public DTO names athletes only through the Passport policy ("Private entrant" otherwise); no Person / Account / Auth ids | API sentinel scan; demo leak scan |
| 21 | Private evidence / authority topology leakage | M | `br_achievements` cannot read evidence or attestations, and reads `authority.trust_anchor` only as `(id, fact_hash, recognition_scope)`. DTOs carry no evidence / attestation / grant / key / anchor ids and no anchor fact hash; governing recognition is public as level + region + sport only | roles tests; fixture-DB DTO test |
| 22 | Cross-schema write escalation | M | `br_achievements` writes only `achievement.*`, `achievement_read.*`, its ledger stream, outbox and audit; narrow read grants (`identity.athlete(id)` column only) | roles tests (13 forbidden writes, 12 forbidden reads; anchor fact columns only) |
| 23 | Operator role escalation | M | `br_achievement_operator_app` → `br_achievement_rules` only; `br_api` cannot SET it; 503 without the login; no fallback | roles tests; API 403 / 401 / 503 |
| 24 | Generic Achievement insert path | M | No exported insert; the lane entry points validate and live on a separate subpath forbidden to `apps/*` (except the labelled demo) | lint guard |
| 25 | Record / Prize / Trophy / Ranking side effects too early | M | None exist or are emitted; the guard scans BRT-08 code and migrations | guard; demo step 9; attestation test update |
| 26 | Achievement runtime gaining Verification write authority | M | BRT-08R: the worker login → `br_achievements` + SELECT-only `br_verification_reader`, never `br_verification`. `br_achievements` reads only `verification.run`. The reader has no write privilege anywhere (checked from `information_schema`) | roles tests A–G; security graph |
| 31 | Evidence basis not provable from the Achievement | M | Explicit `evidenceCommitment` over the pinned runs' Evidence Bundles (not the broader snapshot hash), reproducible at the bundle asOf; the trigger checks the bundle hash against `verification.run` | unit + canonical reproducibility test; vectors + Python recomputation |
| 32 | Recognition-scope inflation ("National Champion" on a platform event; NATIONAL(PE) backing NATIONAL(CR); a padel authority backing tennis) | M | Structural `recognitionClaim {level, region?}` (V3+, TITLE / PLACEMENT; no label parsing) + label-word ceiling. The engine gate applies BRT-03 `scopeContains` over level, sport, discipline and region against the pinned governing scope. That scope is reconstructed from the immutable, re-hashed anchor fact that the pinned trace names; anchor status and grants are never read. Unknown scope fails closed. The scope is in the snapshot / candidate hashes, and trigger BR133 checks the anchor fact for canonical rows (BRT-08R-F) | `governing.test.ts` AC-4 matrix 1–11; fixture-DB AC-4 tests; canonical anchor-fact test (revocation does not change it; mismatch / unknown fail closed); vector `national-title-v3-wrong-region` |
| 27 | Recognition-claiming labels ("National Champion") | M | `DISPLAY_NAME_CLAIMS_RECOGNITION` (AC-4) | rule + API tests |
| 28 | "Verified ✓" overstatement / "Achievement is V2" | M | Fixed wording: "Derived from a V2 Event Certified result"; non-ACTIVE shown as historical | unit tests; web |
| 29 | Denial of service (derivation and now public reads re-assemble BRT-07 snapshots; PB comparisons each compute freshness) | P | Bounded comparison sets (≤ 200), sweeps (≤ 500) and Passport items; rate limiting / caching deferred | — |
| 30 | Duplicate JSON keys in rule specs over HTTP | P | The closed schema canonicalizes; a duplicate can only select a valid value that is then hashed and shown exactly; strict parsing is available to text inputs | documented |

**SECURITY DEFINER inventory change.** No new definer functions. `br_achievements` and (BRT-08R) the SELECT-only `br_verification_reader` gained EXECUTE on the existing, STABLE, read-only resolvers `results.resolve_result_version(uuid)`, `competition.resolve_scope_path(text, uuid)` and `competition.account_competition_roles(uuid, uuid)`. The inventory in `hardening.int.test.ts` / `competition-roles.int.test.ts` is updated. New INVOKER trigger functions, each with a fixed `search_path` and no PUBLIC EXECUTE:

- `achievement.assert_rule_version`
- `achievement.assert_rule_transition`
- `achievement.assert_rule_binding`
- `achievement.assert_achievement`
- `achievement.assert_basis_item`
- `achievement.assert_member_credit`
- `achievement.assert_achievement_complete`
- `achievement.assert_supersession`
- `achievement.assert_status_entry`

Plus the IMMUTABLE helper `achievement.level_index`.

**Residual risks / deferred:**

- No production producer exists for V2, OFFICIAL/FINAL, holds, credited lineups or T7/T8, so canonical issuance is unreachable by design.
- COMPETITION_CLASSIFICATION titles need an event DisciplineVersion (they are not derivable canonically today).
- Public status is assessed live per read, which costs a freshness assembly (#29).
- Authority precedence for disputes is not modelled.
