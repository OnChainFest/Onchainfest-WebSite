# ADR-0078: Event completion settles the sporting outcome (V1)

- **Status:** Accepted
- **Date:** 2026-10-17
- **Origin:** ONCF-L6 (competition completion, V1 closure). Builds on [ADR-0047](./ADR-0047-classifications-are-derived-result-versions-submitted-through-the-ledger.md), [ADR-0060](./ADR-0060-classification-policy-v2-vocabulary.md), [ADR-0064](./ADR-0064-official-results-and-atomic-corrections.md), [ADR-0065](./ADR-0065-advancement-policy-and-slot-facts.md) and [ADR-0066](./ADR-0066-scheduling-boundary-and-competition-scope.md). It **amends** ADR-0066 §7.2 (the UNDEFINED cells) and the BRT-05 completion semantics (`docs/implementation/BRT-05-COMPETITION-ENGINE.md` §2–§3). No other ADR is edited.

## 1. Context

Before L6, completing an event or a competition was operational only:

- `completeEvent` checked the event lifecycle and nothing else. A category could be COMPLETED with PLANNED contests, matches without a result, or results that were only SUBMITTED or PROVISIONAL.
- Results stayed fully mutable after completion. Submit, accept, declare-official and correct had no event-status check anywhere, and the organizer Results page kept COMPLETED categories editable.
- `completeCompetition` required every event to be terminal, so a competition whose only categories were cancelled could become COMPLETED.
- `createEvent` checked the competition status without a lock, so a concurrent completion or cancellation could commit and still receive a new DRAFT event.
- ADR-0066 §7.2 left contest complete, void and cancel under a COMPLETED or CANCELLED event UNDEFINED.
- Nothing turned official results into a final standing, podium or public outcome. BRT-05 said completion "does not mean results are final".

The V1 closure loop needs: official results, then standings and outcome, then category completion, then a results freeze, then competition completion, then a public official outcome.

## 2. Decision

### 2.1 Event COMPLETED means "operationally finished and sporting outcome settled"

An event may move IN_PROGRESS → COMPLETED only when, under the event's lifecycle locks:

1. **Every contest is terminal.** CANCELLED and VOID contests need no result. PLANNED, SCHEDULED and IN_PROGRESS contests refuse completion (`CONTESTS_OPEN`). The organizer cancels an unplayed contest first.
2. **Every COMPLETED contest has a current OFFICIAL or FINAL result.** A missing result, or a current version that is only SUBMITTED or PROVISIONAL, refuses completion (`RESULTS_NOT_OFFICIAL`).
   - Walkovers and retirements are ordinary official results.
   - Byes are structural and create no contest.
   - A dangling SUBMITTED version that is not current does not block. No route rejects it, and the freeze (§2.2) makes it inert.
3. **The outcome is determined.** `event-outcome/1` (§2.5) must be DECIDED, GROUPS or NOT_SUPPORTED.
   - PENDING or UNDECIDED refuse completion (`OUTCOME_UNDECIDED`). An example is a knockout final that is a DRAW, VOID, CANCELLED, or has a vacant finalist.
   - The organizer records a deciding result or cancels the category.
4. **Inputs cannot drift.** The outcome is computed before the transaction. Inside the transaction, the contest statuses and current result versions it read must equal those read under the locks; otherwise completion is refused with `CONCURRENCY_CONFLICT`. Statuses and current versions only move forward, so equal fingerprints mean nothing changed in between.

**Errors.** Refusals use `INVALID_TRANSITION` (409), with `details.reason` as one of the fixed values above. Those values are exposed through the API error allowlist. The lifecycle check (`canTransition`) still runs first, so terminal-state messages are unchanged.

### 2.2 Results freeze at COMPLETED and at CANCELLED

Once an event is COMPLETED or CANCELLED, no submit (T2), accept (T3), reject (T4), declare-official (T5) or correction (T7) succeeds on a CONTEST-scoped result of that event. The refusal is `INVALID_TRANSITION` with `reason: RESULTS_FROZEN` and `{ eventStatus }`.

- **Where it is enforced:** in the result ledger, through the scope validator (`ResultScopeValidator.assertMutable`), inside the same br_results transaction as the write.
  - It runs after the idempotency replay check, so a replay of a command that succeeded before the freeze still returns its recorded outcome.
  - It runs before the stream head is opened.
  - It is not a service-level check: `ContestResultService` runs several transactions, and a check there would be check-then-act.
- **How it reads:**
  1. It takes the contest's lifecycle lock `contest:<id>`.
  2. It reads the event status under `br_competition` through `withModuleRole`. No new grant and no migration are needed: the API login already holds SET on both roles.
  3. `completeEvent` holds every contest lock of the event while it validates, so a result write is either fully before the completion (and validated by it) or sees the COMPLETED event.
- **What it does not cover:**
  - EVENT_CLASSIFICATION and other non-contest scopes are **not** frozen; later derivations from a completed event stay legitimate (V2).
  - `rebuildResultProjections` replays history and is not guarded.
  - A ledger built without the scope validator (BRT-03 demos and tests) keeps its previous behaviour. Application code cannot build one (`check-result-ledger-composition`).

### 2.3 Contest commands under a finished event (amends ADR-0066 §7.2)

Contest complete, void and cancel are **refused** when the containing event is COMPLETED or CANCELLED (`INVALID_TRANSITION`, `reason: EVENT_FINISHED`). Start was already refused.

- **COMPLETED event:** §2.1 guarantees it has no non-terminal contest, so nothing is left without an exit.
- **CANCELLED event:** an IN_PROGRESS contest stays IN_PROGRESS as history. The cancellation cascade still cancels only PLANNED and SCHEDULED contests (BRT-05 §2 unchanged). This replaces "keep today's behaviour" in ADR-0066 §7.2 with an explicit rule: a finished container is final.

### 2.4 Competition COMPLETED

A competition may become COMPLETED only when:

- every event is terminal (otherwise `EVENTS_OPEN`); and
- **at least one** event is COMPLETED (otherwise `NO_COMPLETED_EVENT`). A competition whose categories were all cancelled has no sporting outcome; it is cancelled instead.

Beyond that, competition completion relies on the event invariant (§2.1–§2.3): it reads no results and takes no event or contest lock.

`createEvent` now takes the `competition:<id>` lock after its idempotency replay and re-reads the competition under it. An event can therefore never be created in a competition that completed or was cancelled concurrently.

### 2.5 Outcome and standings are derived on read; OFFICIAL is the public floor

`eventOutcome` (`packages/rankings/src/event-outcome.ts`, engine `event-outcome/1`) is pure and deterministic. Its output is hashed, never stored.

- **Inputs:**
  - the event's stage graph;
  - the classification-engine/2 document(s) of the final stage, read at an explicit `floor: 'OFFICIAL'` (OFFICIAL includes FINAL), never at the template's default PROVISIONAL;
  - the current official contest results.
- **Final stage:** the stage with the highest `sequence`, never "the round typed FINAL", because a qualifying stage also ends with a FINAL round.
- **Kinds:**
  - KNOCKOUT and STEPLADDER: from the final, using the advancement winner rule (`contestDecision`: WIN or WALKOVER_WIN against exactly one other entrant).
  - STANDINGS: one round-robin table.
  - METRIC: field formats.
  - GROUPS: several round-robin groups and no knockout; one table per group and **no invented champion**.
  - NOT_SUPPORTED: v1 engines, which have no stage graph; completion then relies on settlement alone.
- **Podium:** the placements with `position ≤ 3`. Shared positions stay shared: 1, 1, 3 means two first places, **no** second place, and one third place.
  - Without a third-place play-off, both semifinal losers share third (`tied: true`).
  - Places below the podium are not ranked for knockout formats (per-round results remain).
  - An ORGANIZER_LOT tie stays shared with `TIE_UNBROKEN_LOT`, because no lot input is stored (lot persistence is V2).
- **Standings** are not persisted. Once an event is COMPLETED its inputs cannot change (§2.2–§2.3; advancement and scheduling were already closed under finished events), so the derived document and its hash are stable.
- **Public reads** expose only OFFICIAL and FINAL content:
  - a contest below the floor appears without any outcome, and without saying that a lower-status version exists;
  - no result version ids, provenance, holds or evidence;
  - the podium is withheld until the category is COMPLETED.

### 2.6 Trust boundary

An official result and the outcome derived from it are **organizer-declared and not independently verified**. Public and organizer surfaces say so ("Official (organizer-declared), not independently verified"). Verification levels (BRT-07) are unchanged.

### 2.7 What does not change

- **No new lifecycle states.** There is no FINAL, CLOSED or ARCHIVED event or competition state, and no REVOKED result state.
- **No reopening** of a completed event or competition.
- **Contest COMPLETED ≠ result FINAL** (BRT-05 §8). Result statuses keep their meaning.
- **H-2 lock order is extended, not changed:** idempotency → `competition:<id>` → `event-capacity` < `event-structure` → `contest:<id>…` → `event-read-model:<id>` (R1 leaf).
  - `completeEvent` now takes all of its contests' locks in one sorted batch, in the tier the cancellation cascade already used.
  - A result transaction takes one `contest:<id>` lock after its draft row and idempotency lock, and before its stream head. No competition-side transaction waits on result rows, so no cycle exists.
  - Contest and result commands take no event-level lock (per-contest serialization stays).
- **R1:** no new read model or projection.
- **Rewards stay V2.** Prizes, awards, payouts, BRT, NFTs, wallets, marketplace items, achievement issuance and stored classification versions are out of scope; nothing here creates them or prepares for them.

### 2.8 Existing data

L4 allowed loose completion, so a database may already hold COMPLETED events with open contests or non-official results. L6 **grandfathers** them and repairs nothing:

- they are frozen as they are;
- their outcome reads PENDING or UNDECIDED honestly.

A read-only audit query is in `docs/implementation/ONCF-L6-COMPETITION-COMPLETION.md`.

## 3. Consequences

- Completing a category is irreversible and settles its result: corrections are impossible afterwards. Organizers must correct before completing.
- Unplayed contests (for example an unused third-place play-off or an empty dynamic round) must be cancelled before the category completes.
- Fixtures that completed categories with open contests, or competitions with only cancelled categories, now construct those states explicitly as legacy data, or reach them legitimately.
- Every completion and every result write pays one extra lock and one or two status reads.
- Public pages show official match results and live standings while a category runs, and the podium once it completes.

## 4. Alternatives

- **New FINAL / CLOSED states.** Rejected: COMPLETED already exists and is terminal. A second terminal state would duplicate it and require migrations and new UI.
- **Stored EVENT_CLASSIFICATION versions as the outcome.** Rejected for V1: it needs an authority workflow (ADR-0047) and a persistence model, while derived-on-read is deterministic once inputs are frozen. It remains a V2 option.
- **Freeze check in `ContestResultService`.** Rejected: it runs in a separate transaction (time-of-check/time-of-use) and misses the other validator-composed callers (testkit, seed CLI).
- **A SECURITY DEFINER status function.** Rejected: it needs a migration. `withModuleRole` already has precedent (`ranking-api-reader.ts`) and stays within existing grants.
- **An exclusive event lock in result commands.** Rejected: it would serialize every result of a category, contradicting H-2's per-contest lock (test W).
- **Rewards and prizes with completion.** Rejected: out of scope for V1 (§2.7).
