# ADR-0037 — Reference Achievement persistence fixtures live only in throwaway databases

- **Status:** Proposed
- **Date:** 2026-09-30
- **Origin:** BRT-08 (cites ADR-0035 and ADR-0026; neither is changed)

## Context

No canonical producer can reach an Achievement today: V2 needs `RESULT_OFFICIAL` / T5 (ADR-0035), titles need FINAL (T5/T6), every type needs hold facts (no Dispute producer), and team credits need the credited lineup inside Result content (ADR-0026). BRT-08 must still prove its OWN persistence mechanics: hashing, basis storage, memberCredits, natural idempotency, 20× concurrency, the dependency index, the status history, supersession / revocation and read-model rebuild.

Two alternatives were rejected: writing synthetic V2 `verification.run` / FINAL / lineup rows into upstream tables (which would fabricate sporting truth and mislabel it `CANONICAL_ASSEMBLY`), and not testing persistence at all.

## Decision

**Reference Achievement persistence fixtures are allowed only in a throwaway database whose normal production provenance constraint has been altered by a test-only post-migration overlay. Upstream synthetic sporting facts are never persisted.**

1. The normal schema accepts only `snapshot_provenance = 'CANONICAL_ASSEMBLY'` (achievement) and `assessment_provenance = 'CANONICAL_ASSEMBLY'` (status entry), via named CHECK constraints. The database enforces this, not the application.
2. `packages/testkit/sql/achievement-fixture-overlay.sql` drops exactly those two constraints and allows `REFERENCE_FIXTURE`. It is NOT a migration. It refuses to run unless `current_database()` matches `br_achfx_<12 hex>`. Only the test harness installs it, as the migration owner, into a database it has just created and will drop. Nothing else can install it: `db:bootstrap`, `db:migrate`, the seeds, the API, the worker, `br_api`, `br_achievements`, the operator logins, maintenance and the worker are all excluded. No runtime role can ALTER achievement tables, and no SQL function installs the overlay (tested).
3. The fixture harness overlays the missing derivation inputs **in memory** (a typed `REFERENCE_FIXTURE` AchievementDerivationSnapshot / support-facts document). It persists through the SAME validated writer as production: the candidate is re-derived from the snapshot and every basis element is re-checked. No upstream canonical table (results, verification, attestation, evidence, competition, identity) receives a synthetic row.
4. Basis references to upstream facts are hash-committed in the Achievement. For `CANONICAL_ASSEMBLY` rows they are also checked against the live canonical rows by trigger (ResultVersion content hash, VerificationRun ↔ version, run hashes, run level, current status, holder existence). Rule / DisciplineVersion references are foreign keys in both lanes, because rules are real in the fixture database too. No fake parent rows are ever created.
5. The API, web and worker never connect to a fixture database. Demo Part C creates a throwaway database, prints *REFERENCE FIXTURE PERSISTENCE ENVIRONMENT / NOT CANONICAL SPORTING TRUTH / DATABASE WILL BE DESTROYED*, and drops it.

## Consequences

BRT-08 persistence is provable today without weakening ADR-0035 or ADR-0026. The costs: two provenance columns, a test-only DDL file, and slower integration tests (each throwaway database runs the full migrations).
