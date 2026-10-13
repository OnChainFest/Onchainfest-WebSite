# ONCF-05E-F — Proposal commit: architecture and readiness audit

| | |
|---|---|
| Status | **Readiness audit (ONCF-05E-F-0). Unblocked: gap F-G1 (§ 26) resolved by [ADR-0076](../adr/ADR-0076-proposal-commit-eligibility.md) — FROZEN.** Implementation: ONCF-05E-F-1, F-2 and F-3 merged; ONCF-05E-F-4 (tests / hardening) implemented (§ 30) |
| Baseline | `b93d57c` on `main` (PR #14, ONCF-05E-E-2 read-only preview merged) |
| Contract | ADR-0066–0075 (**unchanged**) · [ADR-0076](../adr/ADR-0076-proposal-commit-eligibility.md) (commit eligibility, new) · [ONCF-05E architecture](./ONCF-05E-ARCHITECTURE.md) · [ONCF-05E-E architecture](./ONCF-05E-E-ARCHITECTURE.md) §§ 25–27, 34, 35 |
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
