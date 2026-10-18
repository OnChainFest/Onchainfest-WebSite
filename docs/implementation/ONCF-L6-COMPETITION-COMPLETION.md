# ONCF-L6 — Competition completion (V1 closure)

Decision record: [ADR-0078](../adr/ADR-0078-event-completion-settles-the-sporting-outcome.md). This document describes what was built and how to check existing data. It sets no new rule.

## The loop

1. Official results.
2. `event-outcome/1` (standings and outcome, derived on read).
3. Category completion.
4. Results freeze.
5. Tournament completion.
6. Public official outcome.

## Where things live

| Concern | Code |
|---|---|
| Winner rule (shared with advancement) | `packages/competition/src/advancement/resolve.ts` · `contestDecision` |
| Outcome engine (pure) | `packages/rankings/src/event-outcome.ts` · `eventOutcome`, `podium` |
| Assembly, settlement, public and staff reads | `packages/persistence/src/event-outcome-store.ts` · `EventOutcomeStore`, `eventSettlementIn` |
| Category completion guard | `packages/persistence/src/competition-store.ts` · `completeEvent` → `assertOutcomeSettled` |
| Competition completion rule, `createEvent` lock | `packages/persistence/src/competition-store.ts` · `setCompetitionStatus`, `createEvent` |
| Results freeze | `packages/persistence/src/result-ledger.ts` (`ResultScopeValidator.assertMutable`), `competition-hierarchy.ts` |
| Match commands under a finished category | `packages/persistence/src/competition-structure-store.ts` · `setContestStatus` |
| Routes | `GET /v1/competitions/:slug/events/:eventSlug/outcome` and `GET /v1/competitions/:slug/outcome` (PUBLIC); `GET /v1/events/:eventId/outcome` (COMP_STAFF) |
| Refusal reasons (409) | `apps/api/src/v1.ts` · `RESULTS_FROZEN`, `CONTESTS_OPEN`, `RESULTS_NOT_OFFICIAL`, `OUTCOME_UNDECIDED`, `EVENTS_OPEN`, `NO_COMPLETED_EVENT`, `EVENT_FINISHED` (plus `CONCURRENCY_CONFLICT` / `OUTCOME_INPUTS_CHANGED`) |
| Web | Results (category outcome panel, frozen rows), Operations (completion pre-block), Hub (completed summary), public competition and event pages |

## Outcome rules by format

| Final stage (highest sequence) | Kind | Decided when | Podium |
|---|---|---|---|
| KNOCKOUT | KNOCKOUT | the FINAL round's single contest has an official result with exactly one WIN or WALKOVER_WIN | 1 = winner, 2 = loser. 3 and 4 come from the play-off fed by the losers of the final's feeders. If there is no play-off, or it was cancelled or voided, those losers share 3rd |
| KNOCKOUT fed by a STEPLADDER transition | STEPLADDER | as KNOCKOUT | 1, 2, and 3 = the loser of the match that fed the final (none when K = 2) |
| ROUND_ROBIN, one group | STANDINGS | every contest that is not CANCELLED, VOID or vacant is an official classification input | classification positions of CLASSIFIED entries (shared positions stay shared) |
| ROUND_ROBIN, several groups | GROUPS | every group as above | none (no champion across groups) |
| FIELD / HEATS | METRIC | as STANDINGS, and no dynamic round is still unmaterialized | as STANDINGS (non-finishers are never on the podium) |
| no stage graph (v1 engines) | — | NOT_SUPPORTED | none; completion relies on settlement alone |

**What blocks completion.** UNDECIDED blocks it: a final that is DRAW, VOID or CANCELLED, has a vacant finalist, or whose result names other entrants. PENDING blocks it too. The organizer records a deciding result or cancels the category.

**Notes on DECIDED outcomes.** A `TIE_UNBROKEN_LOT` note marks a shared position that only an organizer lot could separate. No lot input is stored; that is V2.

## Known limits (unchanged 05C semantics)

**A cancelled or voided contest can still count.** If such a contest still carries an OFFICIAL result, classification-engine/2 counts it: `ScoringStore.classification` does not filter contests by status. The engine itself was not changed in L6 (ADR-0078 scope). In practice:

- a VOID contest normally has no official result;
- a correction is the way to change one;
- after completion, nothing can change.

## Grandfathered data (ADR-0078 §2.8)

Before L6, a category could be completed with open matches or non-official results. L6 repairs nothing: such categories are frozen as they are, and their outcome reads PENDING or UNDECIDED. To list them, run the following as the database owner (read-only):

```sql
-- COMPLETED categories with a match that is not terminal, or a completed match without a current
-- OFFICIAL / FINAL result.
SELECT e.id AS event_id, e.competition_id, c.id AS contest_id, cs.status AS contest_status,
       vs.current_status AS current_result_status
FROM competition.event e
JOIN competition.v_event_current es ON es.event_id = e.id AND es.status = 'COMPLETED'
JOIN competition.contest c ON c.event_id = e.id
JOIN competition.v_contest_current cs ON cs.contest_id = c.id
LEFT JOIN results.result r ON r.scope_type = 'CONTEST' AND r.scope_target_id = c.id
LEFT JOIN results.result_state rs ON rs.result_id = r.id
LEFT JOIN results.result_version_state vs ON vs.result_version_id = rs.current_version_id
WHERE cs.status IN ('PLANNED', 'SCHEDULED', 'IN_PROGRESS')
   OR (cs.status = 'COMPLETED' AND (vs.current_status IS NULL OR vs.current_status NOT IN ('OFFICIAL', 'FINAL')))
ORDER BY e.competition_id, e.id, c.id;

-- COMPLETED competitions without any COMPLETED category.
SELECT co.id AS competition_id
FROM competition.competition co
JOIN competition.v_competition_current cc ON cc.competition_id = co.id AND cc.status = 'COMPLETED'
WHERE NOT EXISTS (
  SELECT 1 FROM competition.event e JOIN competition.v_event_current es ON es.event_id = e.id
  WHERE e.competition_id = co.id AND es.status = 'COMPLETED');
```

## Not in L6 (V2)

L6 does not include:

- prizes and awards
- payouts and settlement
- BRT
- NFTs
- wallets
- the sponsor and provider marketplace
- achievement issuance from outcomes
- cross-competition rankings
- stored (submitted) classification versions
- disputes
- FINAL / REVOKED result states
- reopening
- lot persistence
