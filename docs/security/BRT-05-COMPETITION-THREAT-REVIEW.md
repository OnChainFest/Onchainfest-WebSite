# BRT-05 — Competition & Event Engine: Threat Review

**Scope:** the code added in BRT-05: sport catalog, competition/event operations, teams, registration, field/seeding/plan, contests, lineups, hierarchy resolver, result linkage, the `/v1` competition API and the public web pages.

**Baseline:** `BRT-02-THREAT-MODEL.md`, `BRT-04-IDENTITY-THREAT-REVIEW.md`.

**Status:**
- **Mitigated:** a control exists and is tested.
- **Partial:** a control exists with a known gap.
- **Accepted:** a documented residual risk.

## 1. Threats

| # | Threat | Control | Evidence | Status |
|---|---|---|---|---|
| C1 | Unauthorized competition editing | Every command checks `CompPermission` in-transaction from DB facts (staff roles; OWNER/ADMIN of the ACTIVE organizer org). Denials are audited. Authentication runs before DTO validation (401). | `competition.int` (member cannot create/publish), `competition.int` API 401/403 | Mitigated |
| C2 | Organization admin escalates into sports authority | Disjoint vocabularies (compile-time guard + test). Competition operations write no authority tables; `br_competition` has no authority grants. No OFFICIAL/REFEREE staff roles. | `competition-authority.int` (0 grants/anchors created; organizer principal denied ACCEPT_RESULT/DECLARE_OFFICIAL/ATTEST_RESULT/RATIFY_RECORD; FEDERATION denied); demo step 8 | Mitigated |
| C3 | Duplicate registration | Command idempotency; one active entry per athlete per event (individually or via teams) under lock; DB trigger `BR004` | 20 same-key attempts → 1; other keys → ALREADY_EXISTS; overlapping team refused | Mitigated |
| C4 | Capacity race / overbooking | Per-event advisory lock for decisions + AFTER INSERT trigger `BR003` (same lock, fresh snapshot); composite FK ties status rows to their registration's event | 20 concurrent vs capacity 4 → exactly 4; raw 5th CONFIRMED refused by the DB | Mitigated |
| C5 | Waitlist manipulation | Automatic promotion is FIFO (`recorded_at`, id) and only in AUTO_CONFIRM. Organizer promotion is audited and capacity-checked. Registrations freeze at the lock. | Promotion test; `CAPACITY_REACHED` test | Partial: organizers with `COMP_MANAGE_REGISTRATIONS` can confirm out of order (by design, audited) |
| C6 | Participant substitution | Participants only come from CONFIRMED registrations at the lock (UNIQUE registration, composite FK). No substitution command; tables append-only. | Lock test; append-only tests | Mitigated (substitution workflow deferred) |
| C7 | Team hijacking | Explicit TeamManager relation. Membership needs athlete-side consent unless the manager controls the athlete. An organization label needs `ORG_MANAGE_COMPETITIONS`. | Team tests (stranger cannot add; manager cannot accept for athlete) | Mitigated |
| C8 | Lineup spoofing | Only the entrant controller or `COMP_MANAGE_LINEUPS`. Lineup athletes must be the individual's athlete or ACTIVE team members; size per discipline. Closes at contest start. Replacements audited. | Lineup tests; API lineup test; demo step 22 | Mitigated |
| C9 | Field mutation after lock | FIELD_LOCKED has no path back. Registration commands refuse locked events. Participants and field hash are append-only. | Lock test | Mitigated |
| C10 | Bracket regeneration | One plan per event (PK); replay returns the stored plan; different input refused; append-only even for the owner; rebuilds never regenerate | Concurrent generation test; owner UPDATE/DELETE → `BR001` | Mitigated |
| C11 | Seed tampering | Seeding once per event, tied to the field hash; draw seed persisted and reproducible; hashes chained into the plan input | Seeding tests (reproduce order; second seeding refused; owner UPDATE refused) | Partial: the draw is not provably fair (see §2) |
| C12 | Schedule tampering | `COMP_MANAGE_SCHEDULE` only; window validation; offset-bearing instants only; every change audited with the previous start | Scheduling tests | Mitigated |
| C13 | IDOR | Every id-addressed command re-derives permission from the target's competition. Public reads resolve by slug and serve projections only. UUID params validated. | Stranger 403 tests; public-read role tests | Mitigated |
| C14 | PII leakage | Projections hold no names or PII; `br_competition`/`br_public_read`/`br_rebuild` have no vault or auth-identity grants; events and audit carry ids and statuses only; logs never include bodies | Sentinel test (DTOs, outbox, audit, read models, logs); role tests; demo step 31 | Mitigated |
| C15 | Minor/dependent leakage | Athlete display resolved at read time from the Passport card: restricted/private/inactive → `PRIVATE_ENTRANT` with no reason | API test (guardian-registered minor shown as private entrant; slug and name absent) | Mitigated |
| C16 | Slug collision / squatting | Normalized, reserved-safe slugs; history PK (never re-claimable); lock + PK on concurrent claims; event slugs scoped per competition | Slug race test (6 → 1, no orphans) | Mitigated |
| C17 | Format-engine nondeterminism | Pure engines, versioned; input and output hashes over canonical documents; property tests | SE 2..64 / RR 2..40 property tests; identical plan hashes | Mitigated |
| C18 | Hierarchy privilege widening | Paths from DB relationships (SECURITY DEFINER resolver), never prefixes; exact BRT-03 algebra; result scopes must match the resolved hierarchy | C1/E1/A containment tests; borrowed-ancestry submission refused | Mitigated |
| C19 | Cross-competition authority leakage | Competition grants only cover paths containing that competition, even with the same organizer | C1 grant does not cover C2/D; demo step 28 | Mitigated |
| C20 | Fake winner injection | No command sets a winner or resolves a slot; contestant rows append-only; contests create no Results; no auto-accept or verify | Tests: contest completion resolves nothing and creates no Result; results count 0 (demo step 29) | Mitigated |
| C21 | Future-slot manipulation | Dependency slots stay unresolved; a contest cannot start with unresolved or inactive slots; same-event trigger `BR006` | Start-refused tests | Mitigated |
| C22 | Orphan rounds/contests | Plan, rounds, contests and contestants written in one transaction; FKs + same-event trigger; cancellation appends facts and deletes nothing | Concurrent plan test (no duplicates); cancellation test | Mitigated |
| C23 | Rebuild corruption | Rebuild is a pure function of canonical facts (fact timestamps) on the maintenance login; truncate + rederive in one transaction; equivalence asserted | Rebuild equivalence tests; demo step 30 | Mitigated |
| C24 | Catalog redefinition by organizers or through a compromised API credential | Catalog writes only through `br_catalog`, reachable **only** from the dedicated `br_operator_app` login (BRT-05R); `br_api` cannot SET it. INTERNAL endpoints need the operator flag **and** the operator connection (503 fail-closed without it, no fallback). Versions immutable; only PUBLISHED pinnable; events pin exact versions | `competition-roles.int` (12 role properties, NOINHERIT, membership list); API tests: 403 non-operator, 401 forged / X-User-Id, 503 without operator DB, 201 with it | Mitigated |

## 2. Residual and deferred items

1. **Draw fairness.** `br-draw/1` is reproducible and tamper-evident, **not provably fair**: the platform chose the seed and could, in principle, have discarded seeds. Commit–reveal or an external randomness beacon is deferred.
2. **Waitlist visibility.** Staff with `COMP_VIEW_PRIVATE` and the database see the full waitlist order; the public sees counts only. Accepted.
3. **Team names are public by design.** A manager could put a personal name in a team name; this cannot be prevented technically. Accepted.
4. **No participation-backed conflict-of-interest checker.** There is no person ↔ principal mapping yet, so conflict-sensitive capabilities still require an explicit checker (fail-closed default). Deferred.
5. **Database clock monotonicity.** BRT-03 time semantics assume a monotonic DB clock. A ~1 s backward step was observed on Docker Desktop/WSL (see BRT-05-DEVELOPMENT §6). The effect is fail-closed (facts briefly "not yet known"). Deploy with slewing NTP; a monotonic platform clock is deferred.
6. **No rate limiting** on registration, team or slug endpoints. Deferred (as in BRT-04).
7. **No amendment workflow.** A field or plan cannot change after the lock or plan; errors require cancellation. Deferred, deliberately conservative.
8. **Organizer-declared region and category labels are unverified.** They only narrow authority matching or describe the event, and never widen anything. Accepted.
