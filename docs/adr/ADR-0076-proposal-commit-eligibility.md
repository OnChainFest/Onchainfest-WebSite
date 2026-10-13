# ADR-0076 — Proposal Commit Eligibility

- **Status:** Accepted (frozen for ONCF-05E-F implementation)
- **Date:** 2026-10-12
- **Origin:** ONCF-05E-F-0 proposal commit architecture and readiness audit ([ONCF-05E-F architecture](../implementation/ONCF-05E-F-ARCHITECTURE.md) § 26, gap F-G1), after PR #14 (ONCF-05E-E-2 read-only preview merged at `b93d57c`). Builds on [ADR-0075](./ADR-0075-scheduler-proposal-engine-v1-semantics.md) and the ONCF-05E-E proposal semantics ([ONCF-05E-E architecture](../implementation/ONCF-05E-E-ARCHITECTURE.md)). **ADR-0066–0075 are not edited.** This ADR narrows the one point ADR-0075 left open; it supersedes no clause.

Decision references `C1`–`C10` are this ADR's; `E1`–`E20` are ADR-0075's.

## 1. Context

ADR-0075 freezes how a proposal is computed and committed:
- a proposal is an ephemeral, content-addressed change set (§ 3), never stored and never a version;
- every run ends in one of five statuses (§ 13): `SUCCESS`, `NOTHING_TO_PLACE`, `INFEASIBLE`, `NO_CANDIDATES`, `SEARCH_EXHAUSTED`;
- commit recomputes the proposal under the per-competition advisory lock, rejects a hash mismatch as `CONCURRENCY_CONFLICT PROPOSAL_STALE`, and otherwise applies "every placement as a draft fact" atomically (§ 16).

**The ambiguity.** A proposal can contain placements while its run status is not `SUCCESS`:
- `INFEASIBLE`: the search completed, and at least one unit is unplaced for a non-budget reason; the other units are placed;
- `SEARCH_EXHAUSTED`: the budget ended, and "decided units stay in the proposal" (§ 13).

ADR-0075 § 16 applies "every placement" with **no status condition**, and § 24 defers "partial commit" without defining it. A literal implementation could therefore commit the placements of an `INFEASIBLE` or `SEARCH_EXHAUSTED` proposal, and could record empty commits (with audit and outbox entries) for `NOTHING_TO_PLACE` and `NO_CANDIDATES`. The ONCF-05E-F-0 audit found no other ADR, code path, schema constraint or test that decides the point, and classified it as gap F-G1, blocking ONCF-05E-F-1.

**Repository evidence** (at `b93d57c`):
- `ProposalStatus` (`packages/competition/src/scheduling/proposal.ts`) is exactly the five statuses above; the status is derived by the engine and is part of the hashed semantic proposal (ADR-0075 § 14).
- No commit path exists yet. The preview (`ScheduleStore.previewProposal`, `POST /v1/schedule-versions/:versionId/proposals/preview`) is read-only and returns every status unchanged.

## 2. Decision

**Proposal generation and proposal commitment are separate phases.** A proposal is a recommendation. It may expose diagnostics and partial placements for preview purposes; that does not make those placements independently authorized. **The proposal is an atomic unit of authorization for commit, and only a `SUCCESS` proposal is committable.**

The commit boundary is:

```
recompute (server) → hash verification → status === SUCCESS → write
```

not:

```
proposal → commit whatever placements exist
```

### C1. Eligibility rule

| Recomputed status | Committable |
|---|---|
| `SUCCESS` | **Yes** |
| `INFEASIBLE` | No |
| `SEARCH_EXHAUSTED` | No |
| `NO_CANDIDATES` | No |
| `NOTHING_TO_PLACE` | No |
| Any status added later | No, unless the ADR that adds it explicitly declares it committable |

`SUCCESS` means: the run completed according to the v1 search semantics (ADR-0075 § 8–13), and every target in the proposal's scope was placed. It does **not** mean publishable: pre-existing base HARD conflicts (reported in `metrics`) are still judged by `validate` / `publish`, unchanged (ADR-0073 B1).

`NOTHING_TO_PLACE` and `NO_CANDIDATES` carry no placements. Refusing them prevents empty commits that would only produce audit and outbox noise.

### C2. No partial commit

ONCF-05E-F does **not** support partial commit of a non-`SUCCESS` proposal.
- An `INFEASIBLE` proposal is never read as "commit whatever the engine managed to place".
- A `SEARCH_EXHAUSTED` proposal is never read as "commit everything found before the budget expired". It is a budget artefact, not a scheduling result.

This is how ADR-0075 § 24's deferred "partial commit" is read: committing any strict subset of a run's targets, including the placed subset of a failed run. Introducing it needs its own ADR.

### C3. Narrower scope is a new proposal

An organizer who wants to commit part of a desired schedule previews again with a narrower `scope` (events or rounds, ADR-0075 § 4). Because scope is part of `baseStateIdentity` (ADR-0075 § 15), that is a **new proposal** with its own status and hash, and it is committable only if it is `SUCCESS`.

Example: a full proposal over 100 targets ends `INFEASIBLE` with 97 placed. The 97 placements cannot be committed. A new proposal scoped to the wanted subset that ends `SUCCESS` can be. Units the engine cannot place may also be placed manually through the existing 05E-C path.

### C4. Failure semantics

- An eligibility failure is the dedicated semantic failure **`PROPOSAL_NOT_COMMITTABLE`**.
- It is raised as the existing domain code `INVALID_TRANSITION` with the fixed reason `PROPOSAL_NOT_COMMITTABLE`, mapped by the existing HTTP map to **409 Conflict**: the request is structurally valid, but the referenced proposal is not eligible for the requested transition. 422 is not used; in this repository 422 is reserved for invitation, challenge and proof flows.
- The API response must let a client distinguish `PROPOSAL_NOT_COMMITTABLE` from `PROPOSAL_STALE` and from other `INVALID_TRANSITION` causes (not a draft, closed competition) by a machine-readable, fixed-vocabulary value. Today `errorBody` exposes `reason` only for an allow-list of integrity codes; ONCF-05E-F-3 extends it for these two fixed reasons. No input value is ever echoed.

### C5. Relationship to stale

`PROPOSAL_STALE` and `PROPOSAL_NOT_COMMITTABLE` are distinct conditions:

| Failure | Meaning | Domain code | HTTP |
|---|---|---|---|
| `PROPOSAL_STALE` | Authoritative state changed; the recomputed `proposalHash` differs from the presented one (ADR-0075 § 16) | `CONCURRENCY_CONFLICT` | 409 |
| `PROPOSAL_NOT_COMMITTABLE` | The hashes match, and the recomputed proposal's status is not `SUCCESS` | `INVALID_TRANSITION` | 409 |

**Order:** the hash comparison runs first. A presented hash that no longer matches is `PROPOSAL_STALE` whatever the recomputed status; eligibility is evaluated only for the proposal that is verified to be the one the client previewed.

### C6. Server-side recomputation; security

ADR-0075 § 16 and § 20 are preserved. The client supplies only the proposal hash and the parameters needed to reproduce the proposal (`versionId`, `scope`, `from`), never placements and never a status. At commit the server, in order:

1. authenticates (human account);
2. authorizes `COMP_MANAGE_SCHEDULE` inside the commit transaction;
3. loads authoritative state under the advisory lock;
4. reconstructs the proposal input with the preview's loader;
5. recomputes the proposal with the same engine;
6. compares the presented hash → `PROPOSAL_STALE` on mismatch;
7. verifies the **recomputed** `status === 'SUCCESS'` → `PROPOSAL_NOT_COMMITTABLE` otherwise;
8. only then writes assignments.

Consequences:
- A client-supplied status is never read. No request field can express one; an unknown field is `INVALID_INPUT`.
- A client cannot turn an `INFEASIBLE` or `SEARCH_EXHAUSTED` proposal into `SUCCESS` by editing the request: the status is hashed (ADR-0075 § 14), so any altered claim fails step 6, and the eligibility decision in step 7 reads only the server's own result.
- The rule is completely sport-neutral: it reads `proposal.status` only, with no `if (sport === …)`, `switch (sport)`, discipline or resource-type branch (ADR-0066 § 5, ADR-0075 § 21).

### C7. Hash unchanged

The proposal hash algorithm (ADR-0075 § 15) is not modified. Commit eligibility, authorization, user identity and transaction identity are **not** added to it. Eligibility is a property of the recomputed status; the hash remains an integrity and identity mechanism, never an authorization.

### C8. Atomicity

A non-committable proposal produces **zero authoritative writes**: no assignment fact, no schedule fact, no commit event, no audit entry, no outbox event and no idempotency record. The refusal is thrown inside the commit transaction before the first write, and the existing `inTransaction` model rolls back everything it touched. Nothing is partially written as a consequence of attempting to commit a non-`SUCCESS` proposal.

### C9. Idempotency unchanged

The 05E-C idempotency mechanism (ADR-0075 § 18) is unchanged; no new mechanism is introduced.

| Case | Result |
|---|---|
| `SUCCESS` + first valid commit | Committed; response stored under the key |
| Same idempotency key replayed | The stored response; nothing written |
| `SUCCESS` + a different key after a successful commit | Normally `PROPOSAL_STALE`: the commit changed the draft watermark |
| Non-`SUCCESS` proposal | Refused; never writes assignments. No idempotency record is stored, so a retry with the same key recomputes and is refused again (or is `PROPOSAL_STALE` if state changed) |

### C10. Versions unchanged

05E-C version semantics and ADR-0070 are unchanged. A committable proposal still writes into the one open DRAFT, as ADR-0075 § 16 defines. This ADR decides only whether a proposal may enter that write path. It creates no proposal version, proposal revision, partial schedule version or special version for failed proposals.

## 3. Required tests (future ONCF-05E-F work)

Not implemented by this ADR. "Writes nothing" is proven with the byte-level competition snapshot the preview suite already uses (assignment facts, versions, audit, outbox, idempotency).

| # | Test |
|---|---|
| A | A `SUCCESS` proposal commits |
| B | An `INFEASIBLE` proposal is rejected with `PROPOSAL_NOT_COMMITTABLE` (409) |
| C | A `SEARCH_EXHAUSTED` proposal is rejected with `PROPOSAL_NOT_COMMITTABLE` (409) |
| D | A rejected `INFEASIBLE` proposal writes zero assignments |
| E | A rejected `SEARCH_EXHAUSTED` proposal writes zero assignments |
| F | A rejected proposal writes no commit event or audit entry |
| G | A rejected proposal writes no outbox event |
| H | A rejected proposal creates or updates no idempotency record |
| I | A narrower scope produces a new `SUCCESS` proposal (new hash), and that proposal commits |
| J | The client cannot override the proposal status (no status field; unknown field → 400; eligibility reads only the recomputation) |
| K | The client cannot submit arbitrary placements (no placement field; unknown field → 400) |
| L | `PROPOSAL_STALE` remains distinct from `PROPOSAL_NOT_COMMITTABLE` (distinct code and reason; stale wins when both apply) |
| M | Rejected-proposal behaviour is atomic (whole snapshot unchanged) |
| N | Cross-sport behaviour is identical (one case per proof sport via the generic shape table; the sport-identity source guard covers the eligibility path) |
| — | `NOTHING_TO_PLACE` and `NO_CANDIDATES` are rejected with `PROPOSAL_NOT_COMMITTABLE` and write nothing |

## Consequences

- Failed or budget-exhausted proposals cannot accidentally become partial authoritative schedules.
- "A committed proposal is the whole answer for its scope" holds for every commit, matching ADR-0071's rule that anything unplaceable is reported, not silently dropped.
- Cost: in a large competition where one unit is infeasible, the organizer must narrow the scope (or place that unit manually) before committing the rest.
- ONCF-05E-F-1 is unblocked. F-0's test matrix rows O, P and Q and the `NOTHING_TO_PLACE` / `NO_CANDIDATES` rows are now determined.

## Rejected Alternatives

| Alternative | Why rejected |
|---|---|
| Literal ADR-0075 § 16 reading: commit the placements of any status | Turns diagnostics into authority; a budget artefact (`SEARCH_EXHAUSTED`) would become authoritative schedule content |
| Commit `INFEASIBLE` placements but not `SEARCH_EXHAUSTED` | Still a partial commit of a failed run; the organizer's acceptance would cover units the proposal reported as unplaceable |
| Client selects a subset of placements to commit | Client-supplied placements (ADR-0075 § 16 rejected alternative); a narrower-scope proposal gives the same result with server authority |
| Empty commits for `NOTHING_TO_PLACE` / `NO_CANDIDATES` | Audit and outbox entries for no change |
| Eligibility inside the proposal hash | Mixes authorization into an identity mechanism; the status is already hashed |
| 422 for non-committable | Not the repository's convention for scheduling transitions; 409 is used for state-dependent refusals |
| Amending ADR-0075 in place | ADRs 0066–0075 are frozen; a narrowing ADR keeps the history explicit |

## Non-Goals

This ADR implements nothing. It adds no code, migration, route, test, error-code registration or catalog row. It does not change the proposal engine, its statuses, its hash, the preview, idempotency, versions or conflict semantics, and it does not edit ADRs 0066–0075.
