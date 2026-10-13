# ONCF-05E-F — Proposal commit: architecture and readiness audit

| | |
|---|---|
| Status | **Readiness audit (ONCF-05E-F-0). Unblocked: gap F-G1 (§ 26) resolved by [ADR-0076](../adr/ADR-0076-proposal-commit-eligibility.md) — FROZEN.** Implementation: ONCF-05E-F-1, F-2 and F-3 merged; ONCF-05E-F-4 (tests / hardening) implemented (§ 30). ONCF-05E-F-5 Operations API audit: Part II (§§ 31–48). ONCF-05E-F-6 Operations API contract resolution: Part III (§§ 49–57) |
| Baseline | `b93d57c` on `main` (PR #14, ONCF-05E-E-2 read-only preview merged) |
| Contract | ADR-0066–0075 (**unchanged** through F-5; ONCF-05E-F-6 amends ADR-0066 §7, ADR-0070 §§ 8–9 and ADR-0074 D12, Part III) · [ADR-0076](../adr/ADR-0076-proposal-commit-eligibility.md) (commit eligibility, new) · [ONCF-05E architecture](./ONCF-05E-ARCHITECTURE.md) · [ONCF-05E-E architecture](./ONCF-05E-E-ARCHITECTURE.md) §§ 25–27, 34, 35 |
| Migration | None required (§ 21) |
| Not in this phase | Any implementation: commit domain logic, persistence, API, tests. Also scheduler workers, notifications, organizer UI, automatic scheduling, live rescheduling |

This audit compares four sources for the one operation that turns a read-only proposal into authoritative draft content: the ADRs, the code at `b93d57c`, the database schema and the tests. **ADR-0075 is the governing contract. Where this document and an ADR differ, the ADR governs.**

**Classification used for every conclusion:**

| Tag | Meaning |
|---|---|
| **[ADR]** | Frozen by an ADR (clause cited) |
| **[IMPL]** | Already implemented (file cited) |
| **[CODE]** | Derived from existing code: follows necessarily from how the code behaves today |
| **[F-n]** | Proposed for the named implementation slice; consistent with the ADRs, not yet frozen anywhere |
| **[BLOCKED]** | Requires an ADR decision before implementation. The only such item, F-G1, is now resolved by ADR-0076 and retagged **[ADR] 0076** |

## 0. Slice naming collision

- [ADR-free, planning] [ONCF-05E architecture § 16](./ONCF-05E-ARCHITECTURE.md) names **05E-F "Operations API"**: start, complete, cancel and void routes, manual move with reason, unlock. Proposal commit is part of **05E-E** there (preview/commit), and ONCF-05E-E architecture § 34.3–4 hands commit to 05E-E.
- This audit uses the requested name, ONCF-05E-F, for the **commit** work. The operations API described in the master plan is **still unimplemented** and needs its own letter or an explicit re-sequencing. This is a planning decision, not an architecture one; no ADR mentions slice letters.

## 1. Sources read

| Source | What it freezes or contains for commit |
|---|---|
| ADR-0070 §2, §3, §8, §9, §10, §11 | Proposals become draft content only on commit; assignments are append-only facts; locks; preview → hash → commit, advisory lock, version check, idempotency keys; audit + outbox for every proposal commit; `COMP_MANAGE_SCHEDULE` |
| ADR-0071 §5, §6 | Deterministic engine; commit requires the proposal's canonical hash |
| ADR-0073 B1 (I-B1.4) | 05E-E output enters the draft only through a hash-confirmed commit; the published version changes only through publication |
| ADR-0074 D1, D2, D15 | One judge; server-side input; feasibility = zero HARD |
| ADR-0075 §3, §7, §12–§18, §20, §24 | Proposal definition, v1 additive-only, statuses, hashing and base identity, preview/commit flow, provenance, concurrency and idempotency, security, deferred work |
| `packages/competition/src/scheduling/proposal.ts` | `proposeSchedule`, `baseStateIdentity`, `proposalHash`, statuses |
| `packages/competition/src/scheduling/engine.ts`, `report.ts` | Judge input, report `inputs` (the identity's core) |
| `packages/persistence/src/schedule-store.ts` | `evaluationInput` (shared loader), `previewProposal`, `draft()`, `setAssignmentTx`, `publish`, idempotency use |
| `packages/persistence/src/tx.ts`, `identity-support.ts`, `idempotency.ts`, `outbox.ts` | Transaction, isolation and retry; advisory locks; idempotency; outbox |
| `db/migrations/0037` (via ADR-0075 evidence), `0032` | `schedule_assignment` columns and `source` CHECK; append-only roster snapshot |
| `apps/api/src/v1.ts`, `v1-competition.ts` | HTTP status map, `errorBody`, the preview route |
| `packages/persistence/src/oncf05e-e.int.test.ts`, `apps/api/src/oncf05e-e.int.test.ts` | Preview tests (read-only proofs, determinism, statuses) |

## 2. Current 05E architecture (B)

```
05E-A resources + availability ─┐
05E-B scheduling profile pins ──┤
05D occupancy / target states ──┼─▶ evaluationInput (one loader) ─▶ evaluateSchedule (05E-D judge)
05E-C draft + base PUBLISHED ───┘                │                          ▲
                                                 └─▶ proposeSchedule (05E-E, pure) ──┘
                                                          │
                     preview (read-only, implemented) ◀───┘
                     commit  (NOT implemented: this audit)
                     validate / publish (05E-C, unchanged)
```

| Slice | State | Commit-relevant fact |
|---|---|---|
| 05E-A | Merged | Resource revisions and availability facts are append-only; their ids feed the identity [IMPL] |
| 05E-B | Merged | Profile version id + spec hash pinned per event; both feed the identity [IMPL] |
| 05E-C | Merged | One open DRAFT; append-only assignment facts; `setAssignmentTx` is the per-fact write path; staleness only at publish [IMPL] |
| 05E-D | Merged | `evaluateSchedule` is the only judge [ADR-0074 D1, IMPL] |
| 05E-E-1 | Merged | Pure `proposeSchedule` with `baseStateIdentity` and `proposalHash` [IMPL] |
| 05E-E-2 | Merged | `previewProposal`, read-only transaction, `POST …/proposals/preview` [IMPL] |

## 3. Authoritative state model (C)

| Term | Meaning | Source |
|---|---|---|
| Schedule version | A competition-scoped container with status DRAFT, PUBLISHED, SUPERSEDED or DISCARDED, as append-only status facts | [ADR] 0070 §1 |
| Draft | The one open DRAFT version per competition; private; records its base PUBLISHED version | [ADR] 0070 §1 |
| Published | The single public version; `contest_schedule` is its projection | [ADR] 0070 §5 |
| Assignment | An append-only fact within one version; a version's content is the latest fact per contest | [ADR] 0070 §3 |
| Proposal | An immutable, content-addressed change set against an identified base; **not** a version, **not** an assignment, **never stored in v1** | [ADR] 0075 §3 |
| Committed draft | Not a separate concept: the same open draft with additional `MANUAL` facts | [ADR] 0075 §16–17 |

**Commit produces no new concept:** no new version, no new revision type, no proposal row. It appends ordinary assignment facts to the open draft [ADR 0075 §3, §16; rejected alternative "Proposal as a new DRAFT version"].

## 4. Base-state identity (D)

### 4.1 What it hashes [IMPL `proposal.ts` `baseStateIdentity`, ADR 0075 §15]

| Component | Covers |
|---|---|
| `competitionId`, `scheduleVersionId` | Which draft |
| `watermark` | Every current fact id of the draft, **removals and lock/unlock facts included** (each is a new fact via `insertFact`) |
| `basePublishedVersionId` | The draft's base |
| Judge report `inputs` | Per event: profile version id, spec hash, zone, window. Competition zone. Resource revision ids. Availability fact ids. Occupancy digest (place, source kind, 05D state, occupant, fact id). Contest statuses (which also enumerate contests, so newly materialized contests change it) |
| `eventStatuses` | Lifecycle status of every event |
| `latestOffsets` | Latest plan start offset per contest (the expected-end default) |
| `scope`, `from`, strategy, budget | The request and the engine configuration |

### 4.2 Coverage audit against everything the engine reads

| Requested input | Covered by | Verdict |
|---|---|---|
| Schedule draft | `scheduleVersionId`; draft status is checked (non-DRAFT refuses) | Covered [IMPL] |
| Assignments | `watermark` (removals and locks included) | Covered [IMPL] |
| Resources / resource revisions | `resourceRevisionIds` (a revise, retire or reactivate creates a new revision) | Covered [IMPL] |
| Availability | `availabilityFactIds` (additions and revocations are new facts) | Covered [IMPL] |
| Profile pin / version / hash | `profileVersionId`, `specHash` per event | Covered [IMPL] |
| Competition structure | Contests enumerated via `contestStatuses`; plan edges, rounds, stages and contest entries are append-only (`0032` triggers), so for a fixed contest set they cannot change | Covered [CODE] |
| Contest status | `contestStatuses` | Covered [IMPL] |
| Entrant state | Occupants via the occupancy digest. Team rosters are an **append-only snapshot written at field lock** (`0032`, `competition-structure-v2.ts`) in the same transaction as the event's status change, which `eventStatuses` covers | Covered, indirectly [CODE] |
| Dependency graph | Plan edges (immutable) + place feeders (immutable) + 05D place states (occupancy digest) | Covered [CODE] |
| Event state | `eventStatuses`, windows, zones | Covered [IMPL] |
| Relevant published state | `basePublishedVersionId`. A PUBLISHED version's facts never change, and only the open draft can be published, so the base cannot change while the draft is open (§ 13) | Covered [CODE] |
| Competition status | **Not hashed.** The engine reads it only to refuse COMPLETED/CANCELLED (`INCOMPLETE_STATE`), and the store refuses the same before the engine runs | Not needed [CODE] |

**Conclusion [CODE]:** the existing identity is complete for every input the engine reads. **No second identity scheme is needed or proposed.**

Two properties make this sufficient even where an input is only covered indirectly:
1. **Recompute-and-compare is stronger than identity comparison.** Commit compares `proposalHash`, which contains `baseStateIdentity` **and** the placements, statuses and final report. Any change that alters what would be written changes the hash, whether or not the identity names it.
2. **Torn reads cannot be accepted.** The loader runs at READ COMMITTED (§ 12). If a concurrent non-schedule write (resource, availability) commits between loader statements, the commit sees a mixed state whose identity matches neither the old nor the new state, so it cannot equal the preview's identity, and the commit is refused as stale.

### 4.3 Known limitation carried in [ADR 0075 §16, IMPL]

05D target states are computed by 05D under its own module roles **before** the command transaction (`targetStates`), exactly as `validate` and `publish` do. A 05D commit between that read and the lock is not seen by the commit. The written facts are consistent with the 05D state as read. Publication re-judges against current 05D state (`REPORT_STALE` / HARD conflicts), so nothing inconsistent can be published.

## 5. Stale proposal semantics (E)

**Rule [ADR 0075 §16]:** commit reloads authoritative state, recomputes the whole proposal with the same loader and engine, and compares `proposalHash`. **Any difference → `CONCURRENCY_CONFLICT` reason `PROPOSAL_STALE`, nothing written.** Commit never regenerates silently against new state. Choice among "reject / recompute automatically / recompute and compare": **recompute and compare, then reject on difference**. This is frozen, not chosen here.

| Change between preview (state A) and commit (state B) | Changes | Outcome |
|---|---|---|
| A. Another organizer changes an assignment | Watermark | `PROPOSAL_STALE` |
| B. Another organizer changes the draft (lock, unlock, removal, discard) | Watermark; a discarded draft is no longer DRAFT | `PROPOSAL_STALE`; discarded → `INVALID_TRANSITION` `NOT_A_DRAFT` (§ 11) |
| C. A resource is retired (or revised, reactivated, created) | Resource revision ids | `PROPOSAL_STALE` |
| D. Availability changes | Availability fact ids | `PROPOSAL_STALE` |
| E. Profile pin changes | Profile version id / spec hash | `PROPOSAL_STALE` |
| F. Competition structure changes (05D materializes contests) | Contest statuses enumerate contests | `PROPOSAL_STALE` |
| G. Contest status changes | Contest statuses | `PROPOSAL_STALE` |
| H. Entrant state changes (05D occupant resolved, overridden, stale) | Occupancy digest | `PROPOSAL_STALE` (subject to § 4.3) |
| I. Published schedule changes | Only by publishing this draft, which ends the draft | `INVALID_TRANSITION` `NOT_A_DRAFT` |
| J. Another proposal is committed first | Watermark (new facts) | `PROPOSAL_STALE` |
| Event lifecycle or window changes | Event statuses / windows | `PROPOSAL_STALE` |

## 6. Recomputation semantics (F)

- [ADR 0075 §16, §20] **The client never supplies placements.** The request carries only `versionId`, `scope`, `from`, `proposalHash` and an idempotency key.
- [ADR 0075 §16] Commit writes **only what the server recomputed** and found hash-identical. The presented hash is a **claim to compare against**, not data to trust.
- [ADR 0075 §4, § 34.1 of 05E-E] Recompute uses the **same loader** (`evaluationInput`) plus the same extra facts as `previewProposal` (event statuses, latest offsets, base version id) and the **same engine** (`proposeSchedule`, default budget).
- [F-2] The input assembly of `previewProposal` (loader + extra facts + scope check) should be factored into one private function used by preview and commit, so the two cannot drift. Preview behaviour must stay byte-identical.
- [CODE] **`scope` and `from` are required inputs of the recomputation.** They are hashed into the identity, so the commit must receive the same values. Different values give a different hash and a stale refusal, never a different write.

## 7. Proposal hash semantics (G)

| Question | Answer | Tag |
|---|---|---|
| What it covers | The whole canonical body: version, strategy, budget, `baseStateIdentity`, scope, from, placements (with resources, instants, changeover, zone, provisional, SOFT keys), unplaced (with reasons), status, final report hash / validator / coverage / HARD count, metrics | [IMPL] `proposalHash` |
| What it excludes | Diagnostics (judge calls, skips, rebuilds), runtime, timestamps, actor, request ids, database order | [ADR] 0075 §14, [IMPL] |
| Sufficient to identify the proposed state? | Yes: equal hashes ⇒ equal base identity and equal placements (SHA-256, domain-separated, RFC 8785) | [ADR] 0075 §15 |
| Safe to accept from a client? | Only as a value to compare. It never selects what is written; the server writes its own recomputation | [ADR] 0075 §16, §20 |
| Must server recomputation reproduce it? | Yes; that is the commit condition. Determinism is proven by the engine's property tests and the preview's byte-identical repeat tests | [ADR] 0075 §13, [IMPL] tests |
| Authorization by hash? | **Never.** Authorization is re-resolved in the commit transaction (§ 14). A valid hash from stale state fails the comparison (§ 5) | [ADR] 0075 §16, §20 |
| Report hash vs proposal hash | The preview report covers synthetic ids (`proposal:<contestId>`). It is never presented to `publish`; publication computes its own report over real fact ids | [ADR] 0075 §15 |

## 8. Idempotency (H)

**Mechanism [ADR 0075 §18; IMPL `identityIdempotency`]:** the 05E-C pattern. The key is scoped to the actor; the request digest covers the command name and its params; a replay returns the stored first response; the same key with different params is `IDEMPOTENCY_KEY_REUSED` (409). The record is written in the command's own transaction, so a refused or rolled-back commit records nothing.

| Case | Behaviour | Tag |
|---|---|---|
| A. Same request twice at once | Both take the idempotency advisory lock (`idem:<actor>:<key>`); the second waits, then replays the first's response | [CODE] |
| B. Success, response lost, retry with the same key | Replay of the first response (`created: false`); nothing written | [CODE] |
| C. Same proposal hash, **new** key | Recompute now sees the committed facts: the watermark changed and the targets are already placed, so the hash differs → `PROPOSAL_STALE`; nothing written | [CODE] |
| D. Same base state submitted twice | Impossible after a success: the first commit changed the watermark. Before any success it is case A or B | [CODE] |
| E. A different proposal committed between retries | Same key → replay of **this** caller's first response (if it succeeded) or a fresh attempt that is stale. New key → `PROPOSAL_STALE` | [CODE] |

**Conclusion:** commit is **explicitly idempotent** (keys) **and naturally safe against double application** (the watermark changes, so a second application can never match). No new idempotency mechanism is needed.

- [F-2] Command name `CommitScheduleProposal`; params `{versionId, proposalHash, scope, from}` (scope sorted, as the engine canonicalizes it).
- [CODE] As in every 05E-C command, the replay check runs **before** authorization. A replay writes nothing and returns only the caller's own earlier response, so this leaks nothing new. Kept as the established pattern.

## 9. Schedule-version semantics (I)

| Question | Answer | Tag |
|---|---|---|
| New draft version? | **No.** One open draft per competition; commit never opens a draft | [ADR] 0070 §1, 0075 §16 ("A commit never opens a draft") |
| Mutation of the current draft? | Append-only: new assignment facts in the open draft. Nothing is updated in place | [ADR] 0070 §3 |
| Replacement of assignments? | No live assignment is replaced (§ 10) | [ADR] 0075 §7 |
| New revision? | No revision concept exists for versions | [ADR] 0070 |
| New watermark? | Yes, implicitly: the draft's watermark grows by the new fact ids. Not a stored value | [CODE] |
| Published version | Untouched. Publication remains a separate human command (validate → publish) | [ADR] 0073 B1, 0075 §16 |

## 10. Assignment replacement semantics (J)

**v1 is additive-only [ADR 0075 §7]:** commit inserts facts only for target contests, i.e. contests that have **no live assignment** in the open draft. It moves, re-times, re-resources and removes nothing.

| Existing assignment | Effect of commit | Tag |
|---|---|---|
| Units outside the proposal scope | Untouched (not targets) | [ADR] 0075 §4, §7 |
| Manual (`MANUAL`) | Untouched; fixed for the run | [ADR] 0075 §7 |
| Locked | Untouched; `setAssignmentTx` would also refuse it (`ASSIGNMENT_LOCKED`) | [ADR] 0070 §8, [IMPL] |
| Carried (`CARRIED`) | Untouched | [ADR] 0075 §7 |
| Migrated or carried-from-migrated | Untouched | [ADR] 0075 §7 |
| Previously committed proposal facts (`MANUAL`, reason `proposal <hash>`) | Untouched; indistinguishable from manual by design in v1 | [ADR] 0075 §7, §17 |
| Removed in the draft (latest fact `removed = true`) | The contest is unplaced, so it may be placed; the new fact's `replaces_assignment_id` points at the removal fact | [ADR] 0075 §7, [IMPL] `setAssignmentTx` |
| Units the proposal leaves unplaced | Nothing is written for them. They stay without an assignment | [ADR] 0075 §13, §16 |
| Partially placed units | Not targets (`PARTIALLY_PLACED`); untouched | [ADR] 0075 §7 |

**Operation:** **insert** (append facts). Never replace, supersede, version-copy, delete or mark obsolete.

**Fact content [ADR 0075 §5, §17]:** `source = 'MANUAL'`, `actor_account_id` = the committing human, `reason = 'proposal <proposalHash>'` (≈ 80 chars, within the 500-char CHECK), `locked = false`, `removed = false`; resource, start, expected end, changeover and zone from the recomputed placement.

**Write-path equality [F-2, important]:** `setAssignmentTx` derives some values itself. Commit must not write values that differ from the hashed proposal.

| Field | `setAssignmentTx` behaviour | Required at commit |
|---|---|---|
| `expected_end`, `changeover_seconds`, `zone` | Accepts explicit values, else derives defaults | Pass the placement's values explicitly |
| `unit_key` | Always derived (`deriveUnitKeys` with the pinned profile's regrouping) | Assert it equals the placement's `unitKey` |
| `provisional` | Always derived from `v_contest_occupant` | Assert it equals the placement's `provisional`. The engine derives it from 05D target states, a different source, so equality is not guaranteed by construction |

Any mismatch is an internal invariant failure: roll back, write nothing, and return a 500-class error. Never write the store's value silently in place of the hashed one.

## 11. Partial scope (K)

- [ADR 0075 §4] `scope` narrows the **targets only**. The judgment stays competition-wide (ADR-0066 §3), so placements inside the scope are judged against every assignment of the competition.
- [ADR 0075 §7, §16] Committing a scoped proposal writes facts **only for the targets in scope**. In the example (100 contests, scope of 20), it writes at most those 20 and never requires or touches the other 80.
- [CODE] Scoped placements **coexist** with existing assignments. They cannot invalidate another unit at commit time, because the recomputation judged base ⊕ placements and accepted only candidates with no HARD conflict involving a placement (ADR-0075 §10). Pre-existing HARD conflicts of the preserved content remain and are reported in `metrics.baseHardConflicts`; commit neither creates nor fixes them.
- [CODE] Scope has no versioning effect: it is part of the identity and the request, never stored state.

## 12. Atomicity and transaction boundary (R)

**Boundary [ADR 0075 §16; F-2 sequence]:**

```
05D target states (read before the transaction, as validate / publish)        [ADR 0075 §16]
BEGIN (inTransaction, module role competition, READ COMMITTED)
  idempotency lookup → replay returns the first response                       [IMPL pattern]
  draft():  load version · authorize COMP_MANAGE_SCHEDULE · closed competition refused
            · pg_advisory_xact_lock(competition-schedule:<id>) · re-read status = DRAFT   [IMPL]
  ambiguous-draft guard (as preview)                                           [IMPL pattern]
  assemble input (shared with preview) · scope check                           [F-2]
  proposeSchedule(...)  → recomputed proposal                                  [ADR 0075 §16]
  recomputed.proposalHash ≠ presented → CONCURRENCY_CONFLICT PROPOSAL_STALE    [ADR 0075 §16]
  recomputed.status ≠ SUCCESS → INVALID_TRANSITION PROPOSAL_NOT_COMMITTABLE    [ADR 0076 C1, C5]
  for each placement (sorted by contest id):
     setAssignmentTx(...) with explicit values + equality assertions           [ADR 0075 §16, F-2]
       (each emits ScheduleAssignmentChanged + audit schedule.assignment-set)  [IMPL]
  emit ScheduleProposalCommitted + audit schedule.proposal-committed           [ADR 0070 §10, 0075 §16]
  idempotency record                                                           [IMPL pattern]
COMMIT  — any throw above → ROLLBACK of everything, including idempotency
```

- **Existing helpers that suffice [IMPL]:** `inTransaction` (one transaction, module role, rollback on throw, bounded retry on serialization/deadlock); `draft()` (authorization + advisory lock + status re-read); `identityIdempotency`; `setAssignmentTx` (already an in-transaction function, separate from the `setAssignment` wrapper); `emitEvent`; `recordAudit`.
- **Isolation must stay READ COMMITTED [CODE, critical for F-2].** `inTransaction` runs `SELECT platform.tx_time_ms()` before `fn`, and the advisory lock is taken inside `fn`. Under REPEATABLE READ the snapshot would be taken **before** the lock, so a commit that waited for the lock would not see the facts the previous holder committed. Its recomputation could then match the stale preview and write a second set of facts. READ COMMITTED takes a fresh snapshot per statement, so every read after the lock sees the previous holder's facts. F-2 must not pass `isolation: 'repeatable read'`.
- **Retry [IMPL]:** `inTransaction` re-runs `fn` from scratch on a retryable error. That is safe: the recomputation and comparison run again.
- **Lock hold time [CODE, consequence of ADR 0075 §16, §19]:** the recomputation runs under the competition-schedule lock, so a large proposal (up to 10 000 judge calls) blocks every other draft write of that competition for its duration. Resource, availability and pin writes take other locks (`competition-resources:…`) and are not blocked; they make the commit stale instead. Reducing the hold time (recompute before the lock, re-verify only the identity under it) would change §16's wording and needs an ADR. It is recorded, not proposed.
- **Per-fact cost [CODE, F-2 note]:** `setAssignmentTx` re-derives the event's unit keys on every call (`unitKeys` → `contestRows` for the whole event). A commit of n placements in one event costs O(n · contests in event) queries. Hoisting per-event derivations is allowed only if every structural refusal and audit row stays identical.

## 13. Failure at commit time (Q)

Everything runs in one transaction, so **every failure rolls back everything**: assignment facts, outbox events, audit rows written inside the transaction, and the idempotency record. **No partially committed schedule can exist** [ADR 0075 §16 "All or nothing"; IMPL `inTransaction`].

| Failure | Where it surfaces | Rolled back | Remains | Response |
|---|---|---|---|---|
| Database failure | Any statement | Everything | Nothing | 500 |
| Not authenticated | API | — | Nothing | 401 `UNAUTHENTICATED` |
| No `COMP_MANAGE_SCHEDULE` (incl. revoked since preview) | `draft()` → `competition()` → `requireCompPermission` | Everything, including the `DENIED` audit row that helper writes in the same transaction before throwing (as for every command today) | Nothing | 403 `FORBIDDEN` |
| Unknown version / foreign id | `version()` | Everything | Nothing | 404 `NOT_FOUND` |
| Version no longer DRAFT (published, discarded) | `draft()` | Everything | Nothing | 409 `INVALID_TRANSITION` `NOT_A_DRAFT` |
| Competition COMPLETED / CANCELLED | `competition()` | Everything | Nothing | 409 `INVALID_TRANSITION` |
| Stale state (any § 5 change) | Hash comparison | Everything | Nothing | 409 `CONCURRENCY_CONFLICT` `PROPOSAL_STALE` |
| Engine refusal on current state (`INVALID_INPUT`, `INCOMPLETE_STATE`) | `proposeSchedule` | Everything | Nothing | 400 / 409, mapped exactly as preview |
| Resource disappears or retires after recomputation | `setAssignmentTx` re-reads the resource | Everything | Nothing | 409 `INVALID_TRANSITION` `RESOURCE_RETIRED` (or the existing refusal) |
| Conflict appears | Cannot happen inside the transaction for schedule facts (lock). A later availability or 05D change is legitimate post-commit drift, caught at publish | — | — | — |
| Constraint change (profile pin) | Identity → stale | Everything | Nothing | 409 `PROPOSAL_STALE` |
| Serialization failure / deadlock | `inTransaction` retries up to 4 times, then `CONCURRENCY_CONFLICT` | Everything | Nothing | 409 |
| Unique constraint / assignment collision | Not reachable: facts are append-only with fresh UUIDs and there is no uniqueness on (version, contest). The lock serializes writers | Everything | Nothing | 500 if ever reached |
| Version conflict | Covered by the watermark in the identity | Everything | Nothing | 409 `PROPOSAL_STALE` |
| Write-path value differs from the placement (§ 10) | Equality assertion | Everything | Nothing | 500 (internal invariant) |
| Idempotency key reused with other params | `identityIdempotency` | Everything | Nothing | 409 `IDEMPOTENCY_KEY_REUSED` |

## 14. Concurrency (L)

| Scenario | Outcome | Tag |
|---|---|---|
| A and B both preview state S; A commits; B commits | A acquires the lock, recomputes S, writes. B waits on the lock, then (READ COMMITTED) reloads S + A's facts, so the watermark differs → `PROPOSAL_STALE`. B previews again | [ADR] 0075 §16, §18; [CODE] |
| A previews; another user edits the draft; A commits | The edit changed the watermark → `PROPOSAL_STALE` | [ADR] 0075 §16 |
| A commits while a resource or availability write runs | Different locks. Either the write committed before A's loader read it (identity differs → stale) or after (equivalent to the change happening just after the commit; caught at publish) | [CODE] |
| Two commits with the same key | Idempotency lock serializes them; the second replays | [IMPL] |

**Mechanism:** advisory lock per competition schedule (serialization) **+** recomputation and hash comparison (staleness, covering the watermark, i.e. the version check) **+** idempotency keys. **No row locking, no version-number column, no SERIALIZABLE transaction, no new lock** [ADR 0075 §18]. The system never silently overwrites newer state: v1 writes only additive facts, and only when the base is byte-identical to the previewed one.

- [CODE, discrepancy carried in] ADR-0070 §9 promises a version check on draft edits; 05E-C checks staleness only at publish. Commit's recomputation provides the check for proposals without changing 05E-C (as ONCF-05E-E § 26 already records).

## 15. Authorization at commit (M)

- [ADR 0070 §11, 0075 §16, §20] **Both** preview and commit require `COMP_MANAGE_SCHEDULE` (OWNER, ADMIN, SCHEDULER), resolved server-side.
- [IMPL `draft()`] Commit re-resolves authorization **inside the commit transaction**, from current membership and staff facts. It never relies on the preview's authorization. A user whose membership, staff role or competition access was removed after preview is refused with 403.
- [ADR 0075 §20] Commit requires an authenticated human account (`requireAuth`), like every draft edit. No machine path commits or publishes.
- [CODE] There is no event-level access model for scheduling: permission is competition-wide, and scope ids are validated against the competition (`FOREIGN_SCOPE`).

## 16. Resource and availability changes (N)

Preview at T1, change, commit at T2: the change creates a new resource revision or availability fact id, so the identity and the hash differ, and the commit is `PROPOSAL_STALE` [ADR 0075 §16; IMPL]. A valid hash proves nothing about the current state; only the comparison does. A resource retired **after** the recomputation but before the fact insert is refused by `setAssignmentTx` (`RESOURCE_RETIRED`), rolling back everything [IMPL].

## 17. Profile changes (O)

Preview with profile version P1; pin changes to P2; commit: `profileVersionId` and `specHash` are in the identity, so the commit is `PROPOSAL_STALE` [ADR 0069 §1, 0075 §15–16; IMPL]. Profile versions and spec hashes stay as frozen; commit adds nothing to the profile model. In practice a pin is frozen once the field locks (ADR-0069 §1), and only FIELD_LOCKED / IN_PROGRESS events have targets, so this case is mostly theoretical; it is still covered.

## 18. Published-state interaction (P)

- [ADR 0073 B1 I-B1.4, 0075 §16] Commit writes **only** into the open draft. It never writes `contest_schedule`, never changes contest status to SCHEDULED, never publishes and never validates for publication.
- [CODE] The published version cannot change while the draft is open: only the open draft can be published, and publishing makes it non-DRAFT. A commit against a draft that was published or discarded in the meantime is refused by `draft()` (`NOT_A_DRAFT`).
- [IMPL] `publish` still checks `BASE_VERSION_STALE` and `REPORT_STALE`, and recomputes its own report over the real fact ids. Committed proposal facts get no shortcut through publication.

## 19. SEARCH_EXHAUSTED and other statuses

**What the ADRs say:** ADR-0075 §16 says "apply atomically: every placement as a draft fact" with **no status condition**. §13 defines `SEARCH_EXHAUSTED` as "Decided units stay in the proposal". §24 defers "partial commit" without defining it. This was gap **F-G1** (§ 26). **It is now frozen by [ADR-0076](../adr/ADR-0076-proposal-commit-eligibility.md): only `SUCCESS` is committable [ADR 0076 C1].**

| Status | Placements | Literal ADR-0075 §16 reading (superseded by ADR-0076) | ADR-0076 C1 |
|---|---|---|---|
| `SUCCESS` | All targets placed | Commit all | **Committable** |
| `INFEASIBLE` | Some | Commit the placements; unplaced units stay unplaced | Not committable (409) |
| `SEARCH_EXHAUSTED` | Decided units only | Commit the decided placements | Not committable (409) |
| `NO_CANDIDATES` | None | Commit writes zero facts | Not committable (409) |
| `NOTHING_TO_PLACE` | None | Commit writes zero facts | Not committable (409) |

The API and persistence layers **never reinterpret** a status. They read it from the recomputed proposal, after the hash comparison, and apply the one fixed rule [ADR 0076 C5–C6; F-1]. No partial commit: a narrower `scope` is a new proposal [ADR 0076 C2–C3].

## 20. Determinism (U)

- [ADR 0071 §5, 0075 §12–13; IMPL] Same authoritative state + same scope and `from` + same strategy + same budget ⇒ byte-identical proposal and hash. The budget is logical (judge calls), so results never depend on time or machine speed. Proven by `proposal-property.test.ts`, `proposal-sports.test.ts` and the preview's byte-identical repeat tests.
- [ADR 0075 §16] The commit path reproduces the server-side proposal; client placements are never input.
- [CODE] The strategy and budget are server constants (`PROPOSAL_STRATEGY`, `PROPOSAL_BUDGET`) recorded in the hash. A deployment that changes either between preview and commit makes in-flight proposals stale, which is the intended behaviour.

## 21. Audit, outbox and read models (S)

| Effect | Required by | Commit |
|---|---|---|
| Per-fact `ScheduleAssignmentChanged` outbox event + `schedule.assignment-set` audit | ADR-0075 §16 ("Each fact still emits its existing … event"); [IMPL] `setAssignmentTx` | Yes, unchanged |
| One proposal-commit audit + outbox entry | ADR-0070 §10, ADR-0075 §16–17 (`schedule.proposal_committed`) | Yes |
| Notification | ADR-0066 §6 (out of scope) | No |
| Public read-model refresh | ADR-0070 §5: drafts are never public; `refreshEventReadModels` runs only on publish [IMPL] | No |

- [F-2] **Naming.** ADR-0075 writes `schedule.proposal_committed`. Repository conventions are PascalCase outbox types in the closed `DomainEventType` registry (`packages/domain/src/events.ts`, e.g. `ScheduleAssignmentChanged`) and dotted-hyphen audit actions (`schedule.assignment-set`). F-2 maps the ADR name to outbox `ScheduleProposalCommitted` (a registry addition, no migration: `event_type` has no CHECK) and audit `schedule.proposal-committed`. This is a naming mapping, not a semantic change.
- [ADR 0075 §17] The payload/details carry: version id, proposal hash, base-state identity, strategy, budget, placed/unplaced counts and the final report hash. Following the 05E-C convention ("ids, keys, hashes and statuses only") and BRT audit rules: no person ids, no PII.
- [CODE] **Projection invariant:** the outbox events are written in the same transaction as the facts (transactional outbox), and no public projection reads drafts. A partially committed schedule can therefore never be exposed. Consumers of `ScheduleAssignmentChanged` see either all of a commit's events or none.

## 22. API contract recommendation (T)

All [F-3] unless tagged; route placement follows [ADR 0075 §24] and the preview.

```
POST /v1/schedule-versions/:versionId/proposals/commit          COMP_STAFF route group
Header: Idempotency-Key                                          required (as every state-changing
                                                                 05E-C route: v1-competition.ts key(request))
Body (closed; unknown fields → 400):
  { proposalHash: ContentHash,                                   required
    scope?: { eventIds?: uuid[], roundIds?: uuid[] },            same schema as preview
    from?:  ISO-8601 instant (whole seconds) }                   same schema as preview
200: { versionId, competitionId, proposalHash, baseStateIdentity,
       assignmentIds: [{ contestId, assignmentId }] (sorted by contestId),
       placedContests, created }                                 created:false on replay
```

- [ADR 0075 §20] **No placement, resource, profile, availability, feasibility or status field exists in the request.** The body's closed schema enforces it.
- Authentication: session account (`requireAuth`). Authorization: `COMP_MANAGE_SCHEDULE`, resolved in the transaction.
- Proposal identity: `proposalHash`. Base-state identity: implied by the hash; it is never accepted separately, so it cannot be forged independently.
- Idempotency key: the `Idempotency-Key` header, exactly as the other state-changing 05E-C routes.

## 23. HTTP status model (U)

Repository conventions (`apps/api/src/v1.ts` `HTTP_STATUS`) are kept. 422 is used in this codebase only for invitation, challenge and proof verification, never for scheduling state.

| Condition | Domain error | HTTP | Tag |
|---|---|---|---|
| Malformed body, unknown field, bad `from`, foreign scope, engine `INVALID_INPUT` | `INVALID_INPUT` | 400 | [IMPL] preview mapping |
| Not authenticated | `UNAUTHENTICATED` | 401 | [IMPL] |
| No permission (incl. revoked) | `FORBIDDEN` | 403 | [IMPL] |
| Unknown or inaccessible version | `NOT_FOUND` | 404 | [IMPL] |
| Stale proposal / lost race | `CONCURRENCY_CONFLICT` (`PROPOSAL_STALE`) | 409 | [ADR] 0075 §16 |
| Not a draft, closed competition, ambiguous draft, `INCOMPLETE_STATE` | `INVALID_TRANSITION` | 409 | [IMPL] |
| Idempotency key reused | `IDEMPOTENCY_KEY_REUSED` | 409 | [IMPL] |
| Proposal status not `SUCCESS` (hash matched) | `INVALID_TRANSITION` reason `PROPOSAL_NOT_COMMITTABLE` | 409 | [ADR] 0076 C4–C5 |
| "No longer feasible" | Not a separate case: infeasibility under new state changes the hash → `PROPOSAL_STALE` 409. Under unchanged state the recomputation equals the preview | — | [CODE] |
| Unexpected failure, internal invariant | — | 500 | [IMPL] |

- [CODE] `errorBody` exposes `reason` only for an allow-list of integrity codes. For `CONCURRENCY_CONFLICT` and `INVALID_TRANSITION` the client gets the code and the fixed message, exactly as for `publish`'s `REPORT_STALE` today.
- [ADR 0076 C4 → F-3] The response must distinguish `PROPOSAL_NOT_COMMITTABLE` from `PROPOSAL_STALE` and from other `INVALID_TRANSITION` causes by a fixed-vocabulary value: F-3 extends the `reason` allow-list for these two reasons.

## 24. Security model (V)

| Attack | Prevented by | Tag |
|---|---|---|
| A. Modify placement times | No placement field exists; server writes its own recomputation | [ADR] 0075 §16, §20 |
| B. Modify resource ids | Same; `setAssignmentTx` also refuses foreign or RETIRED resources | [ADR], [IMPL] |
| C. Modify profile hash | Not an input; the identity is recomputed from the pinned profile | [ADR] 0075 §15 |
| D. Modify base state | Not an input; only the server-computed identity counts | [ADR] 0075 §15–16 |
| E. Omit conflicts | Conflicts are the judge's output on the server; nothing client-supplied is judged | [ADR] 0074 D14, 0075 §4 |
| F. Submit a valid old proposal | Its hash no longer matches the recomputation → `PROPOSAL_STALE` | [ADR] 0075 §16 |
| G. Another organization's ids | Version and competition authorized together; scope ids validated against the competition with a fixed message; resource and contest cross-competition refusals in `setAssignmentTx` | [IMPL] |
| H. Replay a successful commit | Same key → stored response, no write. New key → stale (watermark changed) | [IMPL], [CODE] |
| I. Race another organizer | Advisory lock + recomputation; the loser is stale | [ADR] 0075 §18 |
| J. Bypass authorization | Re-resolved in the commit transaction; no historical authorization; hash is never authority | [IMPL], [ADR] 0075 §20 |

Logging: counts only; no person or entrant ids beyond the report's [ADR 0075 §20].

## 25. Cross-sport integrity (W)

- [ADR 0066 §5, 0075 §21] Commit is sport-neutral. It loops over generic placements (contest, unit key, resource, instants) and calls the generic write path. No `if (sport === …)`, `switch (sport)`, discipline, format-engine or resource-type branch.
- [F-4] The existing sport-identity source guard must extend to the commit path, and the cross-sport suite must commit one proposal per proof sport (tennis, padel, marathon, swimming, cycling, ten-pin bowling, basketball, golf) using the preview suite's generic `shape` table (EXCLUSIVE_PAIR, GROUPED_EXCLUSIVE, GROUPED_SHARED).

## 26. ADR gap analysis (Z)

**No contradiction was found between ADR-0066–0075, the code, the schema and the tests.** ADR-0075 §16–18 already freeze the commit flow, staleness, provenance, concurrency and idempotency. One genuine gap was found, F-G1, now resolved by ADR-0076.

### F-G1 — Commit eligibility by proposal status — **RESOLVED by [ADR-0076](../adr/ADR-0076-proposal-commit-eligibility.md) (FROZEN)**

**Resolution.** ADR-0076 (Accepted) freezes the proposed decision below: only a server-recomputed `SUCCESS` proposal is committable (C1); no partial commit, a narrower scope is a new proposal (C2–C3); refusal is `INVALID_TRANSITION` `PROPOSAL_NOT_COMMITTABLE`, 409, distinct from and evaluated after `PROPOSAL_STALE` (C4–C5); zero writes on refusal (C8); hash, idempotency and versions unchanged (C7, C9, C10). ADR-0066–0075 are not edited. The audit text below is kept as the record of the gap.

- **Exact ambiguity.** ADR-0075 §16 says commit applies "every placement" if the hash matches, with no status condition. §13 keeps decided placements in `SEARCH_EXHAUSTED` and `INFEASIBLE` proposals. §24 defers "partial commit" without saying whether committing the placements of a non-`SUCCESS` proposal is a partial commit. The requested principle is that only an acceptable successful proposal is commit-eligible. Under the literal §16 reading, `INFEASIBLE` and `SEARCH_EXHAUSTED` placements would be committed, and zero-placement proposals would produce empty commits with audit entries.
- **Affected ADR.** ADR-0075 §13, §16, §24 (and the eligibility half of ADR-0071 §6).
- **Proposed decision.** A proposal is commit-eligible **iff its recomputed status is `SUCCESS`**. Any other status is refused with `INVALID_TRANSITION` reason `PROPOSAL_NOT_COMMITTABLE` (409), nothing written. Committing the placements of an `INFEASIBLE` or `SEARCH_EXHAUSTED` proposal is classified as the deferred "partial commit". The supported path in v1 is to narrow `scope` (events or rounds) until the run is `SUCCESS`, or to place the blocked units manually.
  - Rationale: every placement is HARD-free either way, so this is not a safety question but a product-contract one. `SUCCESS`-only keeps "a committed proposal is the whole answer for its scope", matches ADR-0071's "anything unplaceable is reported", and keeps `SEARCH_EXHAUSTED` (a budget artefact, not a scheduling result) out of authoritative state.
  - Cost: a large competition where one unit is infeasible cannot commit the rest without narrowing scope.
- **Why implementation cannot safely proceed.** The choice changes which commits succeed, the error vocabulary and the F-4 test matrix (P, Q). Choosing it in F-1 would either narrow ADR-0075 §16 silently or implement a reading the requester has rejected.
- **Form of resolution.** A new ADR, approved and written as [ADR-0076](../adr/ADR-0076-proposal-commit-eligibility.md).

### Non-blocking observations (no ADR change)

| # | Observation | Tag |
|---|---|---|
| O1 | Slice naming: master plan 05E-F is the operations API (§ 0) | Planning |
| O2 | `schedule.proposal_committed` naming vs repository conventions; mapped in § 21 | [F-2] |
| O3 | Commit must stay READ COMMITTED (§ 12) | [CODE] → [F-2] |
| O4 | `provisional` is derived from two sources (engine: 05D target states; store: `v_contest_occupant`); assert equality (§ 10) | [F-2] |
| O5 | Lock held during recomputation; reducing it needs an ADR (§ 12) | Deferred |
| O6 | ADR-0070 §9 edit-time version check vs 05E-C publish-only check; covered for proposals by recomputation (§ 14) | Carried in |
| O7 | `errorBody` exposes no `reason` for 409 scheduling codes (§ 23) | [F-3, optional] |
| O8 | Pre-existing, unrelated: `evidence-store.ts` blob insert races on `blob_content_hash_byte_length_key` (`ON CONFLICT (content_hash)` names only the primary key); seen on PR #14 CI node 22 and reproduced locally 4/15 | Separate fix |

## 27. Implementation boundary (Y)

| Slice | Content | Packages | Depends on |
|---|---|---|---|
| **05E-F-0** | This audit | docs | — |
| **05E-F-1** Commit domain logic | Pure eligibility rule over a recomputed proposal (ADR-0076 C1); a pure "commit plan" from a proposal: the ordered fact inputs (contest, resource, start, expected end, changeover, zone, reason `proposal <hash>`) plus the expected `unitKey` / `provisional` for equality checks; unit tests incl. property test "plan = placements, nothing else" | `competition` | ADR-0076 (frozen) |
| **05E-F-2** Persistence transaction | Shared input assembly (preview byte-identical); `ScheduleStore.commitProposal` per § 12; equality assertions; `ScheduleProposalCommitted` + audit; idempotency; READ COMMITTED | `persistence`, `domain` (event type) | F-1 |
| **05E-F-3** API | `POST …/proposals/commit`, closed body, error mapping § 23, route inventory updates (05E-B/C/E inventory tests) | `api` | F-2 |
| **05E-F-4** Tests / hardening | § 28 matrix; cross-sport commits; concurrency tests with real parallel transactions; rollback proofs | all | F-3 |

**Recommendation:** keep F-1 and F-2 separate only if F-1 has real pure logic beyond the eligibility check. The commit plan is small, so **F-1 + F-2 may reasonably merge** into one slice, as 05E-E-2 merged preview persistence and API. F-3 can follow 05E-E-2's precedent and ship with F-2. F-4 should not be deferred: the § 28 cases that prove atomicity and staleness belong with the code they prove. A practical sequence is **F-1+F-2 (domain + persistence + its integration tests)**, then **F-3 (API + HTTP tests + inventories)**.

## 28. Test matrix (X)

Persistence integration unless noted. "Nothing written" is proven by the byte-level competition snapshot the preview suite already uses (assignment facts, versions, audit, outbox, idempotency).

| # | Case | Expected |
|---|---|---|
| A | Happy path: preview `SUCCESS` → commit same hash | Facts = recomputed placements exactly (resource, start, end, changeover, zone, unit key, provisional); `MANUAL`, reason `proposal <hash>`, actor; one `ScheduleAssignmentChanged` per fact + one `ScheduleProposalCommitted`; audits; publish path unchanged |
| B | Stale proposal (each § 5 row A–J and event status/window) | `PROPOSAL_STALE`, nothing written |
| C | Concurrent commits from two connections on the same preview | Exactly one succeeds; the other `PROPOSAL_STALE`; facts = one set |
| D | Replay: same key | Same response, `created: false`, nothing new. Same hash with a new key → `PROPOSAL_STALE`. Same key with different params → `IDEMPOTENCY_KEY_REUSED` |
| E | Resource retired / revised / created between preview and commit | `PROPOSAL_STALE` |
| F | Availability added / revoked between preview and commit | `PROPOSAL_STALE` |
| G | Profile pin changed | `PROPOSAL_STALE` |
| H | Event status changed; competition closed | `PROPOSAL_STALE`; closed → `INVALID_TRANSITION` |
| I | Assignment set / moved / removed / locked / unlocked in the draft | `PROPOSAL_STALE` |
| J | Draft published or discarded before commit | `INVALID_TRANSITION` `NOT_A_DRAFT`; published content untouched |
| K | Permission revoked after preview; stranger; registration manager; SCHEDULER | 403 / 403 / 403 / allowed |
| L | Partial scope (e.g. one event of several) | Facts only for in-scope targets; others untouched; scope differs at commit → stale |
| M | Manual assignments present | Diff of live facts before/after = additions only |
| N | Locked assignments present | Untouched; never re-written |
| O | Units left unplaced | `PROPOSAL_NOT_COMMITTABLE` 409, nothing written [ADR 0076 C1, C8] |
| P | `INFEASIBLE` proposal | `PROPOSAL_NOT_COMMITTABLE` 409, nothing written (ADR-0076 tests B, D, F–H, M) |
| Q | `SEARCH_EXHAUSTED` (budget seam) | `PROPOSAL_NOT_COMMITTABLE` 409, nothing written (ADR-0076 tests C, E, F–H, M) |
| R | Database rollback: a failure injected after k facts (e.g. a resource retired mid-transaction via a probe, or a forced invariant failure) | Zero facts, zero outbox, zero audit, zero idempotency rows |
| S | Projection / outbox consistency | No `contest_schedule` change, no contest status change, no read-model refresh; outbox rows only with the committed facts |
| T | Cross-sport: one commit per proof sport via the `shape` table | Same assertions as A; source guard covers the commit path |
| U | Deterministic repeatability | Two previews and the commit's recomputation give the same hash; commit's `baseStateIdentity` equals the preview's |
| — | `NOTHING_TO_PLACE` / `NO_CANDIDATES` | `PROPOSAL_NOT_COMMITTABLE` 409, nothing written [ADR 0076 C1] |
| — | ADR-0076 § 3 tests I–L, N | Narrower scope → new `SUCCESS` proposal commits; no status or placement field; stale ≠ non-committable (stale wins); cross-sport identical |
| — | Removed-in-draft contest re-placed | Fact with `replaces_assignment_id` = the removal fact |
| — | Equality assertion (unit key / provisional mismatch, forced) | 500-class error, nothing written |
| — | API (F-3) | Closed body; unknown fields 400; no placement field accepted; status mapping § 23; route inventories updated |
| — | Isolation guard (F-2) | A test or source assertion that commit does not run under REPEATABLE READ |

## 29. What this audit does not change

ADR-0066–0075 (ADR-0076 is added, not an edit); 05E-A/B/C/D semantics; the 05E-E algorithm, budgets and statuses; preview behaviour; conflict semantics. No code, migration, package, lockfile or test is changed. No worker, notification, UI, automatic scheduling or live rescheduling is added.

## 30. Readiness status

| Item | State |
|---|---|
| ONCF-05E-F-0 audit | Complete |
| Gap F-G1 (commit eligibility) | **[ADR-0076](../adr/ADR-0076-proposal-commit-eligibility.md) — FROZEN** |
| Other ADR gaps | None; observations O1–O8 need no ADR change |
| ONCF-05E-F-1 commit domain logic | Merged (PR #16) |
| ONCF-05E-F-2 persistence transaction | Merged (PR #17) |
| ONCF-05E-F-3 API | Merged (PR #18) |
| ONCF-05E-F-4 tests / hardening | Implemented (remaining § 28 rows; § 25 shapes asserted on persisted facts) |

**ONCF-05E-F-0 UNBLOCKED — ADR-0076 FROZEN**

---

# Part II — ONCF-05E-F-5: Operations API audit

| | |
|---|---|
| Status | **Audit only (documentation). BLOCKED — CONTRADICTION** (§ 44, § 48): two ADR-level contradictions need a decision; implementation and test gaps are listed in § 43 |
| Date / baseline | 2026-10-13 · `789107c` on `main` (PR #19, ONCF-05E-F-4 merged) |
| Contract | [ONCF-05E architecture](./ONCF-05E-ARCHITECTURE.md) §§ 2, 12–14, 16 (05E-F row), 18.7 · ADR-0066 §1 · ADR-0070 §§2, 3, 7–11 · ADR-0073 B1 · ADR-0074 D4, D12 · ADR-0075 § 6 · [BRT-05 competition engine](./BRT-05-COMPETITION-ENGINE.md) §§ 2, 8, 10, 13 · [ONCF-05E-C](./ONCF-05E-C-SCHEDULE-VERSIONS.md) §§ 3, 5, 8 |
| Changes | None to code, schema, migrations, routes, tests or ADRs. This part is the only change |
| F-6 update | C-1 and C-2 are **RESOLVED CONTRACTUALLY**, and G-5, G-7, G-8, G-9 and G-10 now have contract decisions. All implementation is deferred. See Part III, § 50. The F-5 text below is kept as recorded; notes marked **[F-6]** point to the resolutions |

## 31. Scope and naming

- Part I § 0 (O1) recorded that the master plan's **05E-F "Operations API"** (start, complete, cancel and void routes; manual move with a reason; unlock) was still unimplemented under that letter and needed "its own letter or an explicit re-sequencing". The F series above used the letter F for proposal commit (F-0 to F-4).
- **Planning decision (requester, 2026-10-13):** ONCF-05E-F-5 is an **audit** of that Operations API against the documented contract. Lock is audited together with unlock. The legacy `POST /v1/contests/:contestId/schedule` route is included because it is a second manual-move path.
- This audit implements nothing. Every recommendation (§ 47) is for a later, separately approved slice.

**Tags used in Part II:** **[DOC]** stated by the cited document or ADR · **[IMPL]** observed in code (file cited) · **[TEST]** proven by a test (file:line) · **[UNDEFINED]** no repository source decides it.

## 32. Authoritative sources

| Source | What it establishes for operations |
|---|---|
| ONCF-05E architecture § 2, § 14, § 16 (05E-F row), § 18.7 | Operations in scope: manual moves with reasons, operational contest lifecycle commands over the API. Permissions per action. "Contest lifecycle commands exist only in the store today; exposing them is in scope" (written at baseline `b38d7e2`) |
| ADR-0066 §1 | 05E owns the operational contest lifecycle commands (start, complete, cancel, void) |
| ADR-0070 §2, §3 | LOCKED is an assignment property plus, implicitly, every started contest. Assignments are append-only facts with an actor and **a reason for every manual move** |
| ADR-0070 §7 | A contest becomes `SCHEDULED` when it appears in a published version |
| ADR-0070 §8 | A locked assignment or an IN_PROGRESS-or-later contest is never moved by the engine. Moving a locked assignment manually requires an explicit unlock with a reason |
| ADR-0070 §9 | Concurrency: advisory lock per competition schedule, a version check (base version / last fact), idempotency keys |
| ADR-0070 §10 | Every draft edit, lock or unlock emits an audit entry and an outbox event |
| ADR-0070 §11, ADR-0073 B1 (neighbouring acts) | `COMP_MANAGE_SCHEDULE` (OWNER, ADMIN, SCHEDULER): moves, locks, start/complete. `COMP_CANCEL` (OWNER, ADMIN): cancel/void |
| ADR-0074 D4, D12 | Settled = IN_PROGRESS, COMPLETED. `LOCKED_ASSIGNMENT_VIOLATION`: a settled contest whose draft placement differs from the base PUBLISHED one; "explicitly unlocked assignments are legitimate moves and are not violations" |
| ADR-0065 (via 05D) | A contest with a stale occupant cannot start (start guard, injected) |
| BRT-05 § 8 | Contest transition table; start requires the event IN_PROGRESS and every slot holding an ACTIVE participant; COMPLETED creates no Result |
| BRT-05 § 10, § 13 | Role → permission table; outbox `ContestStarted/Completed/Cancelled/Voided`; audit `contest.status` family |
| ONCF-05E-C §§ 3, 5, 8 | `setAssignment` structural refusals (incl. `ASSIGNMENT_LOCKED`, `CONTEST_STARTED_OR_CLOSED`, `REASON_REQUIRED`, `NOT_A_DRAFT`); `setLock`; route gates; "no unscheduling of a published contest in v1 (cancel it instead)" |

## 33. Operations API inventory

| # | Operation | Route | Store entry point | Lock taken | Idempotency-Key |
|---|---|---|---|---|---|
| 1 | Start | `POST /v1/contests/:contestId/start` | `StructureStore.startContest` → `setContestStatus` (`competition-structure-store.ts:1169`, `:1219`) | `contest:<id>` | **No** |
| 2 | Complete | `POST /v1/contests/:contestId/complete` | `completeContest` → `setContestStatus` | `contest:<id>` | **No** |
| 3 | Cancel | `POST /v1/contests/:contestId/cancel`, body `{reason}` | `cancelContest` → `setContestStatus` | `contest:<id>` | **No** |
| 4 | Void | `POST /v1/contests/:contestId/void`, body `{reason}` | `voidContest` → `setContestStatus` | `contest:<id>` | **No** |
| 5 | Manual move | `PUT /v1/schedule-versions/:versionId/assignments/:contestId` | `ScheduleStore.setAssignment` → `setAssignmentTx` (`schedule-store.ts:1477`, `:1276`) | `competition-schedule:<competitionId>` | Yes |
| 5b | Manual move (legacy) | `POST /v1/contests/:contestId/schedule` | `ScheduleStore.scheduleContest` → `setAssignmentTx` (`:1867`) | `competition-schedule:<competitionId>` | Yes |
| 6 | Lock | `POST /v1/schedule-versions/:versionId/assignments/:contestId/lock` | `ScheduleStore.setLock` (`:1573`) | `competition-schedule:<competitionId>` | Yes |
| 7 | Unlock | `POST /v1/schedule-versions/:versionId/assignments/:contestId/unlock` | `ScheduleStore.setLock` | `competition-schedule:<competitionId>` | Yes |

All eight routes are in the `COMP_STAFF` route group (`apps/api/src/v1-competition.ts:1519`, `:1576`, `:1991`, `:2035`, `:2057`) and call `requireAuth`. The group gates authentication only; authorization is decided in the store from database facts.

## 34. Contract matrix

| Operation | Permission | Body / reason | Source → target | Schedule / assignment implications | Advancement | Audit / outbox | Errors |
|---|---|---|---|---|---|---|---|
| Start | `COMP_MANAGE_SCHEDULE` [DOC 0070 §11] | None | SCHEDULED → IN_PROGRESS [DOC BRT-05 §8]; event IN_PROGRESS, every slot an ACTIVE participant [DOC BRT-05 §8] | The contest becomes implicitly locked [DOC 0070 §2, §8] | Start guard refuses stale occupants [DOC ADR-0065, 0066 §2] | `ContestStarted` + `contest.*` status audit [DOC BRT-05 §13] | 409 invalid state; 403; 404 |
| Complete | `COMP_MANAGE_SCHEDULE` [DOC] | None | IN_PROGRESS → COMPLETED [DOC] | Settled; stays context for the judge [DOC 0074 D4] | Creates no Result, resolves no dependency [DOC BRT-05 §8] | `ContestCompleted` + audit [DOC] | 409; 403; 404 |
| Cancel | `COMP_CANCEL` [DOC] | Reason **required by the route schema**; no 05E document states the requirement [UNDEFINED as contract, IMPL as behaviour] | PLANNED or SCHEDULED → CANCELLED (terminal) [DOC] | Excluded from judging and proposals [DOC 0074 D4, 0075 §6]; a published contest is "unscheduled" only by cancelling it [DOC 05E-C §8]. Effect on the published projection [UNDEFINED] | Source contest resolves nothing (`SOURCE_CANCELLED`) [DOC 05D] | `ContestCancelled` + audit [DOC] | 409; 403; 404; 400 |
| Void | `COMP_CANCEL` [DOC] | Reason required by the route schema [UNDEFINED as contract] | IN_PROGRESS or COMPLETED → VOID (terminal); "operational annulment; decides no result" [DOC BRT-05 §8] | Excluded from judging [DOC 0074 D4] | Decides no result [DOC] | `ContestVoided` + audit [DOC] | 409; 403; 404; 400 |
| Manual move | `COMP_MANAGE_SCHEDULE` [DOC] | Reason required for a move (any change of resource, start, end or changeover) [DOC 0070 §3] | Draft-only; contest PLANNED/SCHEDULED; event FIELD_LOCKED/IN_PROGRESS [DOC 05E-C §3] | New `MANUAL` fact with `replaces_assignment_id`; locked or started → refused [DOC 0070 §8] | Never writes advancement [DOC 0066 §2] | Audit + outbox per edit [DOC 0070 §10] | 400, 403, 404, 409 per 05E-C §3 |
| Lock | `COMP_MANAGE_SCHEDULE` [DOC] | Reason optional [DOC 05E-C §3] | Unlocked → locked, draft only | Locked assignments are never moved [DOC 0070 §8] | — | Audit + outbox [DOC 0070 §10] | 404, 409 |
| Unlock | `COMP_MANAGE_SCHEDULE` [DOC] | Reason **required** [DOC 0070 §8] | Locked → unlocked, draft only | Permits a manual move [DOC 0070 §8]; "explicitly unlocked assignments are … not violations" [DOC 0074 D12] (see § 44 C-1) | — | Audit + outbox [DOC] | 400, 404, 409 |

**Cross-cutting contract points:**
- **Idempotency.** ADR-0070 §9 requires idempotency keys for schedule commands, which covers move, lock and unlock. No 05E or BRT-05 document requires keys for contest lifecycle transitions [UNDEFINED]. The module comment in `v1-competition.ts:55–58` says "Commands that create or change state take an Idempotency-Key"; BRT-05 status transitions (competition, event and contest) consistently do not (§ 39).
- **Stale state.** Lifecycle commands: only the start guard [DOC]. Draft edits: ADR-0070 §9's version check (§ 44 C-2).
- **Transactions.** All-or-nothing per command is the repository pattern (`inTransaction`), not separately documented for lifecycle commands.

**[F-6]** The [UNDEFINED] points above (cancel/void reason, lifecycle idempotency) and the D12 quotation in the Unlock row are recorded as F-5 found them. Their resolution: ADR-0066 §7.1 and §7.3, ADR-0074 D12 as amended (§ 50).

## 35. Implementation trace

| Operation | Route → authorization → validation → domain → persistence → effects | Satisfies the contract? |
|---|---|---|
| Start | Route (`:2035`) → `requireAuth` → **start guard** `advancement.contestBlockers` (injected in `apps/api/src/server.ts:206`), **outside the transaction and before authorization** → `inTransaction` → `lockKeys('contest:<id>')` → load contest, event, competition → `requireCompPermission(COMP_MANAGE_SCHEDULE)` → `canTransition(ContestLifecycle)` (`packages/competition/src/lifecycle.ts:154`) → event IN_PROGRESS → every occupant ACTIVE (`v_contest_occupant`), dynamic round non-empty → insert `contest_status_change` (txTime) → `refreshEventReadModels` → `ContestStarted` → `contest.in-progress` audit | **Partial.** Transitions, preconditions and permission match. The guard order is a defect (§ 38 A-1), and the start guard has the documented 05D read-before-transaction window |
| Complete | Same pipeline, no guard → `ContestCompleted`, `contest.completed`. Response `{contestId, status, result: NOT_AVAILABLE}` | **Yes** for behaviour; tests weak (§ 36) |
| Cancel | Same pipeline, `COMP_CANCEL`, `text(reason, 500)` (NFC, trimmed, non-empty, no control characters) → reason stored on the status fact; **not** in the audit details → `ContestCancelled`, `contest.cancelled` | **Yes** for behaviour; untested at route level, no authorization test |
| Void | Same as cancel → `ContestVoided`, `contest.void` | **Behaviour matches; zero tests** |
| Manual move | Route (`:1519`) → closed body schema → `identityIdempotency` (replay **before** authorization, the 05E-C pattern) → `draft()`: version → `COMP_MANAGE_SCHEDULE` → closed competition refused → `competition-schedule` lock → status re-read (`NOT_A_DRAFT`) → `setAssignmentTx`: instants, labels, reason; contest same competition; event schedulable; contest `EDITABLE_CONTEST` (`CONTEST_STARTED_OR_CLOSED`); zone; venue; profile requirement and resource checks; live locked → `ASSIGNMENT_LOCKED`; move without reason → `REASON_REQUIRED`; unit key; provisional → insert fact → `ScheduleAssignmentChanged` (`SET`/`MOVE`) → `schedule.assignment-set`/`-moved` audit with previous start/resource and reason | **Yes, except ADR-0070 §9's version check** (§ 44 C-2) |
| Manual move (legacy) | Idempotency → contest → competition authorization → `competition-schedule` lock → open draft or create one → `draft()` → `setAssignmentTx` | Same as manual move; it is the same write path |
| Lock / unlock | Reason parsed **before** the transaction (unlock without reason → `INVALID_INPUT REASON_REQUIRED`) → idempotency → `draft()` → live fact required (`NOT_FOUND`) → already in that state → `INVALID_TRANSITION` → insert a copy of the fact with the new `locked` flag → `ScheduleAssignmentChanged` (`LOCK`/`UNLOCK`) → `schedule.assignment-locked`/`-unlocked` audit | **Yes** for ADR-0070 §8; contest status is not checked (§ 43 G-7) |

## 36. Test coverage matrix

A = unit · B = persistence integration · C = API · D = authorization · E = invalid state · F = idempotency · G = concurrency / stale · H = audit / outbox. Setup-only calls are not counted. Source: an exhaustive search of `apps/**` and `packages/**` test files at `789107c`.

| Operation | A | B | C | D | E | F | G | H |
|---|---|---|---|---|---|---|---|---|
| Start | Transition matrix only (`competition/src/competition.test.ts:320`) | `persistence/src/competition.int.test.ts:1105` (happy path, status not asserted), `:1174` | **None** | **None** | Event not IN_PROGRESS (`competition.int.test.ts:1143`), unresolved slot (`:1158`), withdrawn participant (`:1203`) | **None** | Start guard `ADVANCEMENT_STALE` (`oncf05d.int.test.ts:530`) | **None** |
| Complete | Matrix only | `competition.int.test.ts:1148` (no Result, no place filled) | **None** | **None** | **None** | **None** | **None** | **None** |
| Cancel | Matrix only | `oncf05d.int.test.ts:566` (advancement effect), `oncf05e-f.int.test.ts:1836` (proposal staleness) | **None** | **None** | **None** | **None** | Proposal staleness only | **None** |
| Void | Matrix only | **None** | **None** | **None** | **None** | **None** | **None** | **None** |
| Manual move | — | `oncf05e-c.int.test.ts:361`, `:419` (every structural refusal except two), `:664` | `apps/api/src/oncf05e-c.int.test.ts:297–323` | Stranger 403, SCHEDULER 200 (API); not at store level | `REASON_REQUIRED`, `ASSIGNMENT_LOCKED`, `NOT_A_DRAFT` (published, discarded). **`CONTEST_STARTED_OR_CLOSED` and the event-status refusal: none** | **None** | Stale proposal after a move (`oncf05e-f.int.test.ts:1750`) | **None** for manual edits (only for commit-written facts) |
| Manual move (legacy) | — | `competition.int.test.ts:1105`, `oncf05e-c.int.test.ts:849` | `apps/api/src/competition.int.test.ts:482–537`, `oncf05e-c.int.test.ts:360–382` | Stranger 403 (store) | Reason, window | **None** | — | **None** |
| Lock | — | `oncf05e-c.int.test.ts:664` (lock blocks a move; history) | **None** (route inventory only) | **None** | "Already locked", no assignment, `NOT_A_DRAFT`: **none** | **None** | Stale proposal (`oncf05e-f.int.test.ts:881`, `:1787`) | **None** |
| Unlock | — | `oncf05e-c.int.test.ts:701`, `:712` (reason required; move allowed after) | **None** | **None** | Same as lock: **none** | **None** | Stale proposal | **None** |

Also: `apps/api/src/v1.int.test.ts:111` proves 401 for every non-public route (authentication only). The route-inventory tests (`apps/api/src/oncf05e-b.int.test.ts:269`, `oncf05e-c.int.test.ts:392`) list PUT, lock and unlock, but **no inventory lists start, complete, cancel or void**. The implicit lock of started contests is proven only for the engine (`competition/src/scheduling/engine.test.ts:1204`), never for the store refusal.

**Coverage verdict per operation:**

| Operation | Contract | Implementation | Tests | Gap | Severity |
|---|---|---|---|---|---|
| Start | PASS | PARTIAL (A-1) | PARTIAL | No API, authorization, outbox/audit or repeat tests; guard order | Medium |
| Complete | PASS | PASS | PARTIAL | Status, authorization, invalid state, outbox/audit untested | Medium |
| Cancel | PARTIAL (reason, projection undefined) | PARTIAL (G-1) | PARTIAL | No route, `COMP_CANCEL`, invalid-state or audit tests | High (G-1) |
| Void | PASS | PARTIAL (G-1 class) | **MISSING** | Never exercised by any test | High |
| Manual move | CONTRADICTORY (C-2) | PARTIAL | PARTIAL | Version check; two refusals, idempotency, audit untested | Medium |
| Lock | PASS | PASS | PARTIAL | API, authorization, invalid state, idempotency, audit untested | Medium |
| Unlock | CONTRADICTORY (C-1) | PASS for 0070 §8 | PARTIAL | Same as lock | Medium |

## 37. State transition matrix

Contest statuses (migration `0008`, `ContestLifecycle`): `PLANNED`, `SCHEDULED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`, `VOID`. There is no `LIVE` or `VOIDED` state. Contest lifecycle is enforced **only in application code**: the database has a status CHECK and append-only triggers but no transition trigger, and `v_contest_current` takes the fact with the highest `seq`.

| Current | Operation | Result | Writer | Enforced by |
|---|---|---|---|---|
| PLANNED | publish of a version containing it | SCHEDULED | `ScheduleStore.publish` (`schedule-store.ts:1773`) | `c.status === 'PLANNED'` read under the **schedule** lock only |
| PLANNED, SCHEDULED | cancel | CANCELLED | `setContestStatus` | `canTransition` under the **contest** lock |
| PLANNED, SCHEDULED | event or competition cancellation | CANCELLED | `cancelEventFacts` (`competition-store.ts:2025`) | Status read under the **event/competition** locks |
| SCHEDULED | start | IN_PROGRESS | `setContestStatus` | Contest lock, guard, preconditions |
| SCHEDULED | re-publication | SCHEDULED (no fact) | publish | — |
| IN_PROGRESS | complete | COMPLETED | `setContestStatus` | Contest lock |
| IN_PROGRESS, COMPLETED | void | VOID | `setContestStatus` | Contest lock |
| any other pair | any lifecycle command | refused, `INVALID_TRANSITION` "cannot move a X contest to Y" | `transitionError` | Deterministic; tested only by the pure matrix |

| Property | Verdict |
|---|---|
| API accepts only valid source states | The API delegates to the store; no route-level state logic. PASS |
| Domain enforces the same rule | `ContestLifecycle` matches BRT-05 § 8 exactly. PASS [TEST `competition.test.ts:320`] |
| Atomic persistence | One transaction per command, with the status fact, read model, outbox and audit. PASS |
| Repeated requests | A repeat is refused with `INVALID_TRANSITION`; no duplicate side effects. Deterministic, not a replay (§ 39) |
| Unauthorized users cannot force transitions | Store-level permission check inside the transaction. PASS, **untested** (§ 36) |
| Concurrent writers keep the machine valid | **FAIL by inspection (G-1):** three writers use three different locks |

## 38. Authorization audit

| # | Finding | Evidence | Severity |
|---|---|---|---|
| A-1 | **Start guard before authorization.** `startContest` runs `startGuard(contestId)` before the transaction that checks `COMP_MANAGE_SCHEDULE`. `contestBlockers` takes no actor and runs a full 05D `compute` of the event. An authenticated caller without any competition role gets **409 `INVALID_TRANSITION`** ("an entrant of this contest no longer follows…") instead of 403 for a contest with stale entrants. This reveals that the contest exists and is stale, and lets any authenticated account trigger a 05D computation | `competition-structure-store.ts:1169–1176`; `advancement-store.ts:1440` | Medium |
| A-2 | Permissions match ADR-0070 §11 / BRT-05 § 10: start and complete need `COMP_MANAGE_SCHEDULE` (OWNER, ADMIN, SCHEDULER); cancel and void need `COMP_CANCEL` (OWNER, ADMIN); move, lock and unlock need `COMP_MANAGE_SCHEDULE` | `competition-structure-store.ts:1230`; `schedule-store.ts:294` | — (PASS) |
| A-3 | No alternate route bypasses authorization: the legacy schedule route uses the same `competition()` check and write path. No client-supplied actor: the actor is always `requireAuth(request).accountId` | `v1-competition.ts` routes | — (PASS) |
| A-4 | Cross-competition targets: `setAssignmentTx` refuses a contest or resource of another competition (`CROSS_COMPETITION`; database trigger too). Lifecycle commands derive the competition from the contest itself | `schedule-store.ts:382`; 05E-C § 2 | — (PASS) |
| A-5 | Reasons: cancel and void require a non-empty, trimmed reason ≤ 500 characters without control characters (schema + `text`). Unlock requires one (store, after the schema admits `null`). Moves require one when the placement changes | `competition-support.ts:17`; `schedule-store.ts:1586` | — (PASS) |
| A-6 | Idempotency replay happens before authorization in move, lock and unlock (the established 05E-C pattern, Part I § 8). It returns only the caller's own earlier response | `schedule-store.ts:1495`, `:1596` | — (accepted pattern) |
| A-7 | Authorization is **untested** for start, complete, cancel, void, lock and unlock (no 403 case, no SCHEDULER-vs-`COMP_CANCEL` case) | § 36 | Medium (test gap) |
| A-8 | A refused permission writes a `DENIED` audit row that the same transaction then rolls back (pre-existing pattern, Part I § 13) | `competition-support.ts:225` | Low (pre-existing) |

## 39. Idempotency and concurrency audit

| Operation | Repeat (same request) | Lost response, retry | Concurrent same command | Concurrent other writer |
|---|---|---|---|---|
| Start / complete / cancel / void | Second call: 409 `INVALID_TRANSITION` (the state already moved) | 409, not a replay; the client cannot tell its own success from a race lost to another actor | `contest:<id>` lock + re-read: exactly one succeeds | **G-1** |
| Manual move | Same key: stored response, `created: false`; other params: `IDEMPOTENCY_KEY_REUSED` | Replay | Schedule lock serializes. A second move with a **new key** overwrites the first (last write wins; both in history; reason required) | Start between the move's status read and commit: allowed, caught at publish (`LOCKED_ASSIGNMENT_VIOLATION`, ADR-0074 D12) |
| Lock / unlock | Same key: replay. New key: 409 "already locked/unlocked" | Replay | Schedule lock serializes | Not affected by contest status (G-7) |

**G-1 — lifecycle writers are not mutually serialized (by inspection; not reproduced).** Three code paths append `contest_status_change` facts under three different advisory locks:

- `setContestStatus`: `contest:<id>`;
- `publish` (PLANNED → SCHEDULED): `competition-schedule:<id>`;
- `cancelEventFacts` (event or competition cancellation, PLANNED/SCHEDULED → CANCELLED): `event-structure`/`competition` locks.

Each reads the current status (READ COMMITTED), then inserts. There is no transition trigger, and `v_contest_current` takes the highest `seq`. Concrete interleaving:

1. `publish` reads contest X as `PLANNED`;
2. `cancelContest(X)` takes `contest:X`, reads `PLANNED`, inserts `CANCELLED`, commits;
3. `publish` inserts `SCHEDULED` for X and commits.

The current status of X is now `SCHEDULED`, after the terminal `CANCELLED`, which contradicts BRT-05 § 8. The same shape applies to `startContest` against an event cancellation (`SCHEDULED` read by both sides → `IN_PROGRESS` and `CANCELLED` both appended). The window is one statement wide, but nothing prevents it. **Severity High** (lifecycle integrity), **confidence: code inspection only**. Proving it needs a deterministic two-connection test that holds one side between its read and its insert. That test is the first step of the fix slice, not part of this audit.

- **Partial commit:** not possible for any operation (single transaction each).
- **Duplicate side effects on retry:** none. Lifecycle repeats are refused; schedule commands replay.
- **Inconsistent read models:** read models are refreshed in the same transaction as each status fact; G-1 would project whichever fact wins.

## 40. Manual move, lock and unlock

| Aspect | Finding |
|---|---|
| Reason handling | Move: reason required only when resource, start, end or changeover changes (`placement()` comparison); label-only edits need none. Unlock: required. Lock: optional. Remove: required. Matches ADR-0070 §3, §8 and 05E-C § 3 |
| Authorization | `draft()` → `COMP_MANAGE_SCHEDULE` inside the transaction; closed competition refused. PASS |
| Version identity | Path `versionId`; the version must be the open DRAFT (`NOT_A_DRAFT`, re-read after the lock) |
| Proposal interaction | Every move, lock or unlock is a new fact, so it changes the watermark and makes a pending proposal `PROPOSAL_STALE` [TEST `oncf05e-f.int.test.ts:845`, `:1750`]. A committed proposal's facts are ordinary `MANUAL` facts and can be moved, locked or unlocked like any other (ADR-0075 §17) |
| Resource occupancy | Write-time checks are structural only (same competition, ACTIVE, matching type). Overlaps and capacity are recorded, never refused, and judged at validate/publish (05E-C § 3) |
| Revision checks / stale detection | **None at edit time** (§ 44 C-2). Staleness is checked only at publish (`REPORT_STALE`, `BASE_VERSION_STALE`) |
| Immutability | Facts are append-only (triggers); each edit copies the live fact with `replaces_assignment_id` |
| Locked / unlocked | A locked live fact refuses move and remove (`ASSIGNMENT_LOCKED`). The implicit lock of IN_PROGRESS-or-later contests is `CONTEST_STARTED_OR_CLOSED` on move — **untested**. Lock and unlock do not check the contest's status (G-7) |
| Movement after commitment | Allowed (with a reason) while the contest is PLANNED/SCHEDULED and the event is schedulable. After the contest starts, refused. A move made before the start of a contest that then starts under the published schedule makes the draft unpublishable (G-8) |
| Auditability | Move: `schedule.assignment-set`/`-moved` with previous start and resource and the reason. Lock/unlock: `schedule.assignment-locked`/`-unlocked` with the reason. All emit `ScheduleAssignmentChanged`. **None is asserted by a test for manual edits** |
| Deterministic errors | Yes; fixed codes. But `errorBody` exposes no `reason` for `ASSIGNMENT_LOCKED`, `REASON_REQUIRED`, `CONTEST_STARTED_OR_CLOSED` or `NOT_A_DRAFT`, so clients can tell them apart only by message text (G-6, extends Part I O7) |

## 41. Start, complete, cancel and void

| Aspect | Start | Complete | Cancel | Void |
|---|---|---|---|---|
| Authorization | `COMP_MANAGE_SCHEDULE`, after the guard (A-1) | `COMP_MANAGE_SCHEDULE` | `COMP_CANCEL` | `COMP_CANCEL` |
| Source state | SCHEDULED | IN_PROGRESS | PLANNED, SCHEDULED | IN_PROGRESS, COMPLETED |
| Extra preconditions | Event IN_PROGRESS; every occupant ACTIVE; dynamic round has a field; start guard | — | — | — |
| Competition status | Not checked; the event must be IN_PROGRESS | **Not checked** | Not checked (terminal contests refused by the machine) | **Not checked** (G-9) |
| Result interaction | None | Creates no Result, resolves no dependency [TEST `competition.int.test.ts:1161`] | Source resolves nothing (`SOURCE_CANCELLED`) [TEST `oncf05d.int.test.ts:566`] | Decides no result; no test |
| Assignments / projection | Draft unchanged; contest implicitly locked | Unchanged | Draft and published assignments remain; `contest_schedule` keeps the row; the judge and proposals ignore the contest | Same as cancel |
| Atomicity | One transaction | Same | Same | Same |
| Idempotency | Repeat → 409 | Same | Same | Same |
| Audit / outbox | `ContestStarted`, `contest.in-progress` | `ContestCompleted`, `contest.completed` | `ContestCancelled`, `contest.cancelled` (reason only on the status fact) | `ContestVoided`, `contest.void` |
| Cancel vs void | — | — | Before play (PLANNED/SCHEDULED) | After play (IN_PROGRESS/COMPLETED), "operational annulment" |
| Tests | Partial | Happy path | Effects only | **None** |

## 42. Clock-skew issue

The known `authority-store.ts` clock-skew issue (`authorizeIn` uses host time against database transaction time) is **out of scope** and was not touched. No test was run for this documentation-only slice, so no Operations API test was observed to be affected. Contest lifecycle authorization uses `requireCompPermission` (competition staff and organization facts), not `authorizeIn`.

## 43. Identified gaps

| # | Gap | Kind | Severity |
|---|---|---|---|
| G-1 | Lifecycle writers not mutually serialized; a terminal status can be followed by a non-terminal one (§ 39) | Implementation (concurrency), unverified | High |
| G-2 | = A-1: start guard runs before authorization and outside the transaction | Implementation (authorization order) | Medium |
| G-3 | Lifecycle tests: no API tests; no authorization tests; no outbox/audit assertions; invalid-state tests only for start; **void never exercised**; lifecycle routes absent from route inventories | Tests | High (void) / Medium |
| G-4 | Move/lock/unlock tests: lock and unlock never called over HTTP; no authorization tests for lock/unlock; no idempotency replay tests for PUT/lock/unlock; `CONTEST_STARTED_OR_CLOSED` and the event-status refusal never asserted; "already locked/unlocked", no-assignment and `NOT_A_DRAFT` for `setLock` never asserted; no audit/outbox assertion for manual edits | Tests | Medium |
| G-5 | Lifecycle routes take no `Idempotency-Key`: a retry after a lost response returns 409 and the client cannot distinguish its own success from a lost race. No 05E document requires keys here; the module comment implies they should | Contract UNDEFINED | Low |
| G-6 | Fixed-vocabulary refusal reasons (`ASSIGNMENT_LOCKED`, `REASON_REQUIRED`, `CONTEST_STARTED_OR_CLOSED`, `NOT_A_DRAFT`, `ADVANCEMENT_STALE`) are not exposed by `errorBody` | API (extends O7) | Low |
| G-7 | `setLock` does not check contest status: assignments of started, completed, cancelled or void contests can be locked or unlocked. Unlocking a started contest records an "unlocked" fact but cannot make it movable | Contract UNDEFINED | Low |
| G-8 | A contest moved in the draft that then starts under the published schedule makes the draft unpublishable (`LOCKED_ASSIGNMENT_VIOLATION` HARD), and there is no repair path: the move cannot be reverted (`CONTEST_STARTED_OR_CLOSED`) and a published assignment cannot be removed (`PUBLISHED_ASSIGNMENT`). Only discarding the whole draft recovers. The block is intended by ADR-0074 ("a moved-then-started contest always does"); the missing recovery path is not addressed anywhere | Contract UNDEFINED; related to C-1 | Medium |
| G-9 | Complete and void (and cancel of a non-terminal contest) are not refused when the competition is CANCELLED or COMPLETED. Whether closing out an IN_PROGRESS contest of a cancelled competition is allowed is not stated | Contract UNDEFINED | Low |
| G-10 | The cancel/void reason is stored on the status fact but not in the audit details; no document says it must be | Contract UNDEFINED | Low |

**[F-6]** For each gap's status after F-6, see § 50 (G-5, G-7, G-8, G-9, G-10: contract defined) and § 52 (G-1, G-2, G-3, G-4, G-6: still open, not contract questions).

## 44. Identified contradictions

### C-1 — Explicit unlock and `LOCKED_ASSIGNMENT_VIOLATION`

| | |
|---|---|
| Source A | ADR-0074 D12: "Explicitly unlocked assignments are legitimate moves and are not violations." |
| Source B | `packages/competition/src/scheduling/engine.ts:1179` (`checkLocks`): every settled contest whose draft placement differs from the base PUBLISHED placement is a violation; the evaluation input carries no lock or unlock history. ONCF-05E-D-CONFLICT-ENGINE § D12 and `engine.test.ts:1204` describe and test exactly that, without the exemption |
| Exact difference | ADR-0074 exempts explicitly unlocked assignments; the engine has no exemption and no data to apply one |
| Example | Contest X published at 10:00 on court c1. In the draft: lock X, unlock X with a reason, move X to 11:00 (reason). X starts at 10:00 under the published schedule. ADR: not a violation. Engine: `LOCKED_ASSIGNMENT_VIOLATION` (HARD), so the draft cannot be published (and G-8 applies) |
| Consequence | The unlock operation's documented effect on publication is not what the system does. Any implementation slice touching unlock, moves or publication would have to pick one reading |
| Smallest resolution | An ADR amendment (or a new ADR) deciding the sentence: **either** remove/clarify it (settled contests are always compared with the base; explicit unlock only lifts the write-time lock of an unsettled assignment, ADR-0070 §8), which matches the code and needs no implementation; **or** keep the exemption, which needs lock history in the evaluation input, i.e. a report-input change that ADR-0074 D13 governs |
| ADR change required | **Yes.** Not created in this slice |
| **[F-6] Resolution** | **RESOLVED CONTRACTUALLY** by the ADR-0074 D12 amendment. The first option was taken: the exemption sentence is withdrawn, and explicit unlock is a write-time permission only. The engine already behaves this way, so **no implementation change is needed** for C-1 itself. See § 51.1 |

### C-2 — Edit-time version check (carried in, still open)

| | |
|---|---|
| Source A | ADR-0070 §9 ("a version check (`base version` / last fact)"); ONCF-05E architecture § 13 ("base-version checks") |
| Source B | `setAssignment`, `setLock`, `removeAssignment` take no expected base or last-fact id. Staleness is checked only at publish (05E-C § 4) |
| Exact difference | Draft edits are serialized by the schedule lock, but never checked against the state the editor saw |
| Example | Organizers A and B both see X at 10:00. A moves X to 11:00 (reason "court 1 wet"); B, unaware, moves X to 12:00 (reason "TV slot"). Both succeed with different keys; B's move silently replaces A's live placement. Both facts remain in history |
| Consequence | Concurrent manual moves are last-write-wins, which ADR-0070 §9 rules out. Proposal commit is protected by recomputation (Part I § 14); manual moves are not |
| Previously recorded | ONCF-05E-E § 26 and § 36 item 1; Part I § 14 ("discrepancy carried in"). Never resolved |
| Smallest resolution | Either an ADR amendment stating that 05E-C's publish-time checks satisfy §9 for manual edits (no code), or an implementation slice adding an optional expected-last-fact id to the edit commands (an API change) |
| ADR change required | **Yes**, a decision is required either way |
| **[F-6] Resolution** | **RESOLVED CONTRACTUALLY** by the ADR-0070 §9 amendment. Neither F-5 option was taken: publish-time checks do **not** satisfy §9, and the expected last fact is **required**, not optional. **IMPLEMENTATION DEFERRED**: the code still allows last write wins until the hardening slice lands. See § 51.2 |

**Not contradictions:** permissions (§ 38 A-2), the transition table (§ 37), reason requirements (§ 38 A-5), the implicit lock on moves (§ 40), and outbox/audit names (BRT-05 § 13) all match their sources.

## 45. Pre-existing issues (not Operations API defects)

| Issue | Status |
|---|---|
| `authority-store.ts` clock skew (`PRINCIPAL_UNKNOWN`) | Out of scope; untouched (§ 42) |
| `DENIED` audit row rolled back with the refused command (A-8) | Pre-existing pattern across the store layer |
| 05D start guard reads before the command transaction (ONCF-05E-D § 05D states; Part I § 4.3) | Documented limitation; the publish-time judge catches staleness for schedules |
| `evidence-store.ts` blob insert race (Part I O8) | Unrelated; separate fix |

## 46. Out of scope

- Any fix for G-1 to G-10, C-1 or C-2; any new test; any route, permission, error-code or schema change; any ADR.
- Organizer UI (05E-G), public schedule (05E-H), workers, notifications, automatic scheduling, live rescheduling, proposal or commit semantics.
- The clock-skew issue (§ 42).

## 47. Recommended next slices (documentation only; nothing here is approved)

**[F-6]** Slice 1 (ADR decision) was carried out by ONCF-05E-F-6. § 55 replaces this table as the current implementation map. The table is kept as F-5 recorded it.

| Order | Slice | Content | Needs |
|---|---|---|---|
| 1 | ADR decision | Resolve C-1 (unlock vs `LOCKED_ASSIGNMENT_VIOLATION`) and C-2 (edit-time version check); decide G-5, G-7, G-8, G-9 and G-10 where a contract statement is wanted | Requester approval of an ADR |
| 2 | Lifecycle serialization fix | Test-first: a deterministic two-connection test reproducing G-1 (publish vs cancel; start vs event cancel). Then one shared lock discipline for every `contest_status_change` writer, or a database transition guard. Persistence only | Slice 1 not required |
| 3 | Start authorization order | Move the start guard after authorization (G-2/A-1) without changing the guard's semantics | — |
| 4 | Operations API test hardening | G-3 and G-4: HTTP tests for every route; authorization (stranger, registration manager, SCHEDULER, ADMIN, OWNER; `COMP_CANCEL` vs `COMP_MANAGE_SCHEDULE`); every invalid source state; void; outbox/audit assertions; idempotency replay; `CONTEST_STARTED_OR_CLOSED`; lifecycle routes in the route inventory | Tests only |
| 5 | Optional API polish | G-6 reason exposure (as ADR-0076 C4 did for commit); lifecycle idempotency keys if slice 1 requires them | Slice 1 |

## 48. F-5 result

| Item | Classification |
|---|---|
| Start | **PARTIAL** (A-1/G-2, G-1, G-3) |
| Complete | **PARTIAL** (G-3) |
| Cancel | **PARTIAL** (G-1, G-3) |
| Void | **PARTIAL** (G-1 class; **no tests at all**, G-3) |
| Manual move | **CONTRADICTORY** (C-2), otherwise PARTIAL (G-4) |
| Lock | **PARTIAL** (G-4, G-7) |
| Unlock | **CONTRADICTORY** (C-1), otherwise PARTIAL (G-4) |
| Legacy manual move | **PARTIAL** (same write path as manual move; C-2 applies) |
| Nothing | **MISSING**: every documented operation has an implementation |

**ONCF-05E-F-5 — BLOCKED — CONTRADICTION.** The audit is complete. The Operations API is not production-ready: C-1 and C-2 need an ADR decision, G-1 is a high-severity concurrency defect to be proven and fixed, and void has no test coverage.

**[F-6]** The two CONTRADICTORY rows above (manual move, unlock) are now **RESOLVED CONTRACTUALLY**. Their implementation classifications are unchanged until the deferred slices land. See § 57.

---

# Part III — ONCF-05E-F-6: Operations API contract resolution

| | |
|---|---|
| Status | **Contract resolution (documentation and ADR amendments only).** Every finding F-5 marked as a contradiction or UNDEFINED in scope now has a decision (§ 50). The edges still UNDEFINED are listed in § 54. Implementation: **none**, all deferred (§ 55) |
| Date / baseline | 2026-10-13 · `789107c` on `main`. The F-5 audit (Part II) was still uncommitted and is this slice's approved starting state |
| Contract changed | [ADR-0066](../adr/ADR-0066-scheduling-boundary-and-competition-scope.md) §7 (new) · [ADR-0070](../adr/ADR-0070-schedule-versions-publication-and-history.md) §8 and §9 amendments · [ADR-0074](../adr/ADR-0074-conflict-feasibility-engine-v1-semantics.md) D12 amendment |
| Changes | Those three ADRs and this document. No code, test, schema, migration, route, payload, error-response, UI or package change |

## 49. Approach

- **Chain of reasoning.** Each decision runs from F-5 observation to F-6 architectural decision to future implementation (§ 50). Part II is kept as recorded. Points it states that F-6 changes carry **[F-6]** notes; nothing was deleted.
- **Where each decision lives.** Each one is amended into the ADR that already owns the contract. No new ADR was needed:

  | Findings | Owner | Why it owns them |
  |---|---|---|
  | C-1, G-8 | ADR-0074 D12 | It defines `LOCKED_ASSIGNMENT_VIOLATION` and the moved-then-started case |
  | C-2, G-7 | ADR-0070 §8, §9 | It defines locks, unlock and the "`base version` / last fact" concurrency requirement |
  | G-5, G-9, G-10 | ADR-0066 §1 → new §7 | §1 assigns the operational contest lifecycle commands (start, complete, cancel, void) to 05E. ADR-0070 §11 gives only their permissions, and no ADR had stated their command semantics. BRT-05 is an implementation document, not an ADR |

- **Amendment convention.** The ADRs are amended in place, following repository precedent:
  - ADR-0075's in-place "Daily-limit amendment";
  - ADR-0041's "amended by" origin line.

  Each amended ADR gets an **Amended by** line, and its original sentence is quoted where one is withdrawn (ADR-0074 D12).
- **Statements in later ADRs.** ADR-0073 to ADR-0076 say that earlier ADRs are "not edited". Each of those statements describes what that ADR itself did, and each is still true.
- **Status.** All three amended ADRs are **Proposed** (the README: "All records are Proposed until reviewed"). Each amendment states that it has its host ADR's status, so no decision is labelled Accepted while its host is Proposed. ADR-0076 (Accepted) is not touched.
- **ONCF-05E architecture.** It is "Frozen … changes require a new ADR". Its text is **not** edited: no statement in it depends on the withdrawn D12 sentence. §§ 12–13 ("locking … implicit for started contests", "base-version checks and idempotency keys") agree with the amendments, and the phase decomposition (§ 16) is unchanged.

## 50. Decision register

| Finding | F-5 observation (Part II) | F-6 decision | Authoritative source | Contract | Implementation |
|---|---|---|---|---|---|
| **C-1** | ADR-0074 D12 exempted explicitly unlocked assignments; the engine has no exemption and no data for one (§ 44) | Unlock is a **write-time permission** only. Settled contests are always compared with the base PUBLISHED placement, whatever their lock history | ADR-0074 D12 amendment; ADR-0070 §8 amendment | **RESOLVED CONTRACTUALLY** | **Already conforms** (`checkLocks` has no exemption). No change required |
| **C-2** | Manual edits take no expected base or last fact, so last write wins (§ 44) | Manual edits are **optimistic-concurrency** operations. The expected **last fact** is required; a stale edit is refused with `CONCURRENCY_CONFLICT` and writes nothing. This mechanism is separate from idempotency | ADR-0070 §9 amendment | **RESOLVED CONTRACTUALLY** | **IMPLEMENTATION DEFERRED** (§ 55, H-1). The code still allows last write wins |
| **G-5** | Lifecycle routes take no `Idempotency-Key` (§ 39, § 43) | Start, complete, cancel and void take `Idempotency-Key`: replay; `IDEMPOTENCY_KEY_REUSED`; normal state machine for a new key; serialization for concurrent commands | ADR-0066 §7.1 | **CONTRACT DEFINED** | **IMPLEMENTATION DEFERRED** (H-3) |
| **G-7** | `setLock` ignores contest status (§ 40, § 43) | Lock and unlock apply only to `PLANNED`/`SCHEDULED` contests. For `IN_PROGRESS`, `COMPLETED`, `CANCELLED` or `VOID` they are refused with the existing `INVALID_TRANSITION` `CONTEST_STARTED_OR_CLOSED` | ADR-0070 §8 amendment | **CONTRACT DEFINED** | **IMPLEMENTATION DEFERRED** (H-1) |
| **G-8** | A moved-then-started draft is unpublishable and cannot be repaired by edits (§ 43) | An intended hard boundary. Recovery in v1: discard the draft, then open a new one from the published version (existing commands). No repair command | ADR-0074 D12 amendment | **CONTRACT DEFINED** | **None needed.** Both commands exist. Tests: H-5 |
| **G-9** | Complete, void and cancel ignore the competition's status (§ 41, § 43) | Minimum rule: no contest transition may contradict a terminal competition or event. Matrix: start refused; cancel allowed under `CANCELLED`; other terminal cells **UNDEFINED** | ADR-0066 §7.2 | **CONTRACT DEFINED** (partial; § 54) | **IMPLEMENTATION DEFERRED** for the decided cells (H-3) |
| **G-10** | The cancel/void reason is on the status fact, not in the audit details (§ 35, § 43) | Cancel and void reasons are required and are **copied into the audit details**. The status fact is unchanged, and the outbox carries no reason | ADR-0066 §7.3 | **CONTRACT DEFINED** | **IMPLEMENTATION DEFERRED** (H-3) |

## 51. Decisions in detail

The ADR texts govern. This section summarizes them for implementers.

### 51.1 C-1 — Explicit unlock (ADR-0074 D12, ADR-0070 §8)

| | Lock | Unlock | Publication (`LOCKED_ASSIGNMENT_VIOLATION`) |
|---|---|---|---|
| When it acts | At write time | At write time | At validation and publication |
| Effect | Blocks manual moves | Allows a later manual edit | Compares every settled contest with the base PUBLISHED placement |
| Reads lock history? | — | — | **No.** Lock state is not an engine input |

**Example (Part II § 44).** X is published at 10:00 on c1. In the draft, X is locked, unlocked with a reason, and moved to 11:00. X then starts at 10:00.
- Under the amended rule this **is** a `LOCKED_ASSIGNMENT_VIOLATION` (HARD).
- Recovery follows § 51.5.
- Unlock never made X exempt from the comparison.

### 51.2 C-2 — Optimistic concurrency for manual edits (ADR-0070 §9)

- **Commands covered:** set or move (including the legacy `POST /v1/contests/:contestId/schedule`), remove, lock and unlock.
- **Commands not covered:**
  - proposal commit, which keeps its own recomputation (ADR-0075, ADR-0076);
  - publication, which keeps `baseVersionId` and `reportHash`.
- **Identity:**
  - version level: the open draft's id, checked today (`NOT_A_DRAFT`);
  - fact level: the contest's current fact id in that draft, or an explicit "none". This part is new and **required**.
- **Check:** inside the transaction and under the schedule lock. A mismatch gives `CONCURRENCY_CONFLICT` (409) with a reason distinct from `BASE_VERSION_STALE` and `REPORT_STALE`, and writes nothing.
- **Idempotency stays a separate mechanism:**
  - the same key replays without checking again;
  - the expectation is part of the fingerprint;
  - a new key after success is stale and is refused.

**Example (Part II § 44).**
1. A and B both see X's fact *f1*.
2. A moves X, citing *f1*. This succeeds and writes *f2*.
3. B moves X, citing *f1*, with a new key. It gets `CONCURRENCY_CONFLICT`, and A's move stands.
4. B reloads, sees *f2*, and may move again deliberately.

**Implementation consequence.** This is a breaking request-contract change for PUT, remove, lock, unlock and the legacy route. The field's name and shape are left to the slice; the precedent is BRT-02 `ETag` / `If-Match`.

### 51.3 G-5 — Lifecycle idempotency (ADR-0066 §7.1)

| Case | Outcome |
|---|---|
| Same key, same request | Stored first response. Nothing is re-evaluated: no start guard, permission or state check |
| Same key, different request (including a different reason) | `IDEMPOTENCY_KEY_REUSED` |
| New key, after a successful transition | State machine: `INVALID_TRANSITION` (409) |
| Concurrent commands | One transition wins. Serialization across **all** status writers is G-1's job, not idempotency's |

- **Basis:** BRT-02 API surface ("`Idempotency-Key` header is **required** on all POST commands") and the schedule commands' keys.
- **BRT-05 § 15** says "Creating commands take `Idempotency-Key`". That describes BRT-05's implementation and does not forbid keys on transitions, so nothing contradicts this decision.
- **Scope:** competition and event status commands are **not** included.

### 51.4 G-7 — Lock and unlock after start (ADR-0070 §8)

- Allowed only for `PLANNED`/`SCHEDULED` contests.
- Refused for `IN_PROGRESS`, `COMPLETED`, `CANCELLED` and `VOID`, with the refusal 05E-C already defines for that population (`INVALID_TRANSITION` `CONTEST_STARTED_OR_CLOSED`). No new error code.
- Lock and unlock facts already written stay in history and have no effect.
- No exception workflow exists; adding one needs a new ADR.

### 51.5 G-8 — Moved, then started (ADR-0074 D12)

The boundary is intended:
- once the contest starts, its published assignment is authoritative;
- the draft cannot be repaired by editing the started contest;
- no repair command exists or may be added without a new ADR.

**v1 recovery:**
1. `discard` the draft (with a reason);
2. `openDraft`. The base is the current PUBLISHED version, and the started contest's published placement is carried unchanged;
3. redo the other edits that are still wanted.

These are existing 05E-C commands. 05E-C § 8's "no draft reopening after discard" is consistent with this: the recovery opens a **new** draft.

### 51.6 G-9 — Containing competition and event (ADR-0066 §7.2)

| Contest command | Container not terminal | Container `CANCELLED` | Container `COMPLETED` |
|---|---|---|---|
| Start (`SCHEDULED`) | BRT-05 § 8 | **Refused** | **Refused** |
| Cancel (`PLANNED`, `SCHEDULED`) | Allowed | **Allowed** (the target matches the container) | UNDEFINED |
| Complete (`IN_PROGRESS`) | Allowed | UNDEFINED | UNDEFINED |
| Void (`IN_PROGRESS`, `COMPLETED`) | Allowed | UNDEFINED | UNDEFINED |

- "Container" means the containing competition or event.
- Only the six real contest states are used. There is no `LIVE` or `VOIDED`.
- On the UNDEFINED cells, an implementation keeps today's behaviour (the contest state machine only) until an ADR decides them (§ 54).

### 51.7 G-10 — Reasons in audit (ADR-0066 §7.3)

- `contest.cancelled` and `contest.void` audit details carry the same normalized reason the status fact stores.
- Validation is unchanged.
- The reason requirement for cancel and void is now contractual. F-5 § 34 had it as route-schema behaviour only.
- The status fact remains the record of the state.
- `ContestCancelled` and `ContestVoided` outbox payloads are unchanged and carry no reason (BRT-05 § 13).

## 52. F-5 findings not decided by F-6 (still open)

None of these is a contract question. Each is an implementation or test gap under contracts that already exist.

| Finding | Status | Governing contract |
|---|---|---|
| G-1 lifecycle writers not mutually serialized | **STILL OPEN.** High severity, unverified. Not addressed in F-6: no code, test, lock or transaction change | BRT-05 § 8 (terminal is terminal); ADR-0066 §7.1 (concurrent row) |
| G-2 / A-1 start guard before authorization | **STILL OPEN** | ADR-0070 §11 / BRT-05 § 10 |
| G-3, G-4 test gaps | **STILL OPEN** | Part II § 36 |
| G-6 refusal reasons not exposed by `errorBody` | **STILL OPEN.** Not decided by F-6. The new C-2 refusal must be machine-readable (ADR-0070 §9 amendment); whether existing codes gain an exposed reason is a separate API decision | ADR-0076 C4 is precedent for commit only |

## 53. Secondary consistency review

These terms were searched across `docs/`: `LOCKED_ASSIGNMENT_VIOLATION`, explicitly unlocked, unlock, version check, base version, last fact, `Idempotency-Key` / idempotency, start/complete/cancel/void, competition cancelled or closed, reason, Operations API, 05E-F.

| Statement | Location | Verdict |
|---|---|---|
| "Explicitly unlocked assignments are legitimate moves and are not violations" | ADR-0074 D12 | **Changed** (withdrawn, quoted in the amendment) |
| Frozen-now list D1–D16 | ADR-0074 "Frozen vs Deferred" | **Changed** (notes D12 as amended) |
| "ADR-0066–0075 (unchanged)" | This document's header | **Changed** (qualified "through F-5") |
| D12 summaries without the exemption | ONCF-05E-D-CONFLICT-ENGINE (D12 row), ONCF-05E-D-ARCHITECTURE ("Contest moved in draft then started") | Already consistent; unchanged |
| "a moved-then-started contest always does" (block publication) | ADR-0074 Consequences | Consistent; unchanged |
| ADR-0070 §9 vs code "discrepancy" | ONCF-05E-E-ARCHITECTURE § 26 and § 33 "Discrepancies found" item 1 | Historical audit records of a gap that still exists in the code; unchanged. The contract side is now settled by the ADR-0070 §9 amendment |
| "ADR-0070 is not edited" | ONCF-05E-E-ARCHITECTURE § 33 item 2 | Historical: it describes 05E-E. F-6 amends ADR-0070 §8 only about unlock and started contests; the engine-movement point it discusses is unchanged |
| "base-version checks and idempotency keys"; "locking … implicit for started contests" | ONCF-05E architecture §§ 12–13, § 17 P1 | Consistent; unchanged (frozen document, no edit needed) |
| "Creating commands take `Idempotency-Key`" | BRT-05 § 15 | Not contradictory (§ 51.3); unchanged |
| "`Idempotency-Key` … required on all POST commands"; "`If-Match` … on mutable operational updates" | BRT-02 API surface | Supports G-5 and C-2; unchanged |
| Locks and settled contests never moved by the engine | ADR-0075 § 6 | Consistent; unchanged |
| Neighbouring-act permissions | ADR-0073 B1 | Unchanged; F-6 adds no permission |
| "No unscheduling … no draft reopening after discard" | 05E-C § 8 | Consistent with G-8 recovery (new draft, not reopening); unchanged |
| "Unlocking a started contest records an 'unlocked' fact"; lock/unlock "Not affected by contest status" | Part II § 43 G-7, § 39 | Historical F-5 observations of current behaviour. The contract now forbids it (ADR-0070 §8 amendment); the § 43 **[F-6]** note points here |

No contradiction between an F-6 decision and an authoritative source was found.

## 54. Remaining UNDEFINED contract points

| # | Point | Why the sources are insufficient | Must be decided before |
|---|---|---|---|
| U-1 | Complete and void of a contest whose competition or event is `CANCELLED` | BRT-05 § 2's cascade leaves `IN_PROGRESS` contests untouched, and no source says how they close. Refusing both exits strands the contest | Enforcing those cells in H-3 (until then, today's behaviour stands) |
| U-2 | Cancel, complete and void of a contest whose competition or event is `COMPLETED` | No source says whether a `COMPLETED` event may contain contests that are not terminal (BRT-05 § 3 has no such precondition) | Same |
| U-3 | Whether contests cancelled by a competition or event **cascade** carry a reason in their audit | ADR-0066 §7.3 covers the contest commands only. The cascade is a BRT-05 competition/event command | Any slice touching cascade audit |
| U-4 | Effect of contest cancel or void on the **published projection** (`contest_schedule` keeps the row) | Recorded as UNDEFINED in F-5 § 34. Not in F-6's approved scope | 05E-H (public schedule) |
| U-5 | Lock and unlock of a `PLANNED`/`SCHEDULED` contest whose event is no longer schedulable (for example `COMPLETED`) | ADR-0070 §8 (amended) is decided by contest status. The event-status refusal is defined for `setAssignment` only (05E-C § 3) | H-1, if it extends that refusal to `setLock` (low; such contests arise only in the U-2 situation) |

None of these blocks H-1, H-2, H-4 or H-5. Only the U-1 and U-2 cells of H-3 wait for a decision.

## 55. Implementation map (replaces § 47; nothing here is approved)

The labels mean:
- **Ready:** the contract is settled and the slice needs no new architectural decision.
- **Partly ready:** some cells wait on § 54.

The grouping into slices is a recommendation.

| # | Work | Contract | Readiness | Notes |
|---|---|---|---|---|
| H-1 | **Manual-edit hardening**: optimistic concurrency on set/move, remove, lock, unlock and the legacy route (C-2); lock and unlock refused for started or closed contests (G-7) | ADR-0070 §§ 8–9 amendments | **Ready** | Breaking request change on five routes; field shape chosen by the slice. Tests: stale refusal writes nothing; replay vs new key; per-contest granularity; `CONTEST_STARTED_OR_CLOSED` on lock and unlock |
| H-2 | **Lifecycle serialization (G-1)**: test-first, a deterministic two-connection reproduction (publish vs cancel; start vs event cancel), then one serialization covering every `contest_status_change` writer | BRT-05 § 8; ADR-0066 §7.1 | **Ready** (the mechanism is an implementation choice) | Separate slice. F-6 made no lock or transaction change. Should precede or accompany H-3's containing-state checks, because those read statuses that can race |
| H-3 | **Lifecycle command hardening**: `Idempotency-Key` on start, complete, cancel and void (G-5); containing-state enforcement for the decided cells (G-9); reason copied into the audit (G-10) | ADR-0066 §§ 7.1–7.3 | **Partly ready** (U-1 and U-2 cells excluded) | Request contract gains a required header. Audit details change; outbox payloads do not |
| H-4 | **Start authorization order (G-2 / A-1)** | Existing permissions | **Ready** | No contract change. A replay (H-3) must come before the guard |
| H-5 | **Operations API tests (G-3, G-4)**, including void, every invalid source state, the authorization matrix, audit and outbox assertions, route inventories, the G-8 discard-and-reopen recovery and the C-1 unlocked-then-settled case | Part II § 36 + § 51 | **Ready** | Can be split across H-1 to H-4 |
| H-6 | **G-6** exposure of refusal reasons for existing codes | — | **Needs decision** (API) | Optional polish |
| D-1 | **U-1 to U-5** | — | **Needs decision** (ADR) | Only U-1 and U-2 gate implementation (H-3 cells) |

## 56. What F-6 does not change

- No production code, test, migration, schema, route, request or response shape, error code, outbox payload, UI, package, lockfile, environment or generated file.
- No fix for G-1, A-1 or any other gap.
- The scheduler engine is not modified, and lock/unlock behaviour is not modified.
- ADR-0067–0069, ADR-0071–0073, ADR-0075 and ADR-0076 are not edited, and neither are the ONCF-05E, 05E-C, 05E-D or 05E-E documents or BRT-05.
- The Operations API is **not** implemented to this contract. The contract is defined; conformance arrives with H-1 to H-5.

## 57. F-6 result

| Item | Contract (after F-6) | Implementation (unchanged) |
|---|---|---|
| Start | Defined (G-5, G-9 start row) | PARTIAL: G-1, G-2, G-3; no key |
| Complete | Defined except U-1 and U-2 | PARTIAL: G-3; no key |
| Cancel | Defined except U-2 and U-3 | PARTIAL: G-1, G-3; no key; reason not in the audit |
| Void | Defined except U-1 and U-2 | PARTIAL: G-1, G-3 (no tests); no key; reason not in the audit |
| Manual move (incl. legacy) | **RESOLVED** (C-2) | **NON-CONFORMING**: last write wins until H-1 |
| Lock | Defined (G-7) | **NON-CONFORMING**: ignores contest status until H-1 |
| Unlock | **RESOLVED** (C-1, G-7) | Conforms for C-1; non-conforming for G-7 until H-1 |

**ONCF-05E-F-6 — CONTRACT RESOLVED.** C-1 and C-2 are resolved contractually. G-5, G-7, G-8, G-9 (minimum rule and decided cells) and G-10 are defined. The remaining UNDEFINED edges (§ 54) are named, scoped and gate only part of H-3. All implementation is deferred.
