# ONCF-05D — Results, advancement and stage progression

| | |
|---|---|
| Branch | `feat/oncf-01-auth-wiring` (local, uncommitted; on top of `1442b8a`, ONCF-05C) |
| ADRs | [0064](../adr/ADR-0064-official-results-and-atomic-corrections.md) official results and corrections · [0065](../adr/ADR-0065-advancement-policy-and-slot-facts.md) advancement (builds on 0047, 0054, 0062 and 0063) |
| Migration | `0034_oncf05d_results_and_advancement.sql` (additive, plus the one constraint 0003 reserved for T5–T8) |
| Out of scope (05E) | Courts, lanes as scheduling, tee times, start times, venues, resources, staff scheduling, calendars |

**What this slice makes real.** The full chain now runs end to end:

registered entrant → locked entry → structure → contest → validated result → **official outcome** → classification → **advancement policy** → **resolved destination slot** → next contest.

Every link is explicit, versioned, auditable and permission-controlled. **Sport is data:** the engine interprets plan sources and the pinned policy. No sport identity appears in any engine, store or UI branch.

## 1. Scope and the five pinned axes

| Axis | How it is pinned |
|---|---|
| FORMAT | Structure: the immutable plan's stages, slots, sources and transitions (05B) |
| RULESET | How one contest is scored (05C) |
| CLASSIFICATION POLICY | How a stage or group is ordered (05C) |
| **ADVANCEMENT POLICY** | **How classified entrants fill dependent slots (05D, new)** |
| SCHEDULING PROFILE | When and where (05E) |

The advancement policy is pinned with the scoring axes (`PUT /v1/events/:id/scoring`, `advancementPolicyVersionId`) and frozen at field lock.

## 2. Official-result lifecycle (ADR-0064)

```
draft → T2 SUBMITTED → T3 PROVISIONAL → T5 OFFICIAL
                      ↘ T4 REJECTED
correction (atomic): T7 current → SUPERSEDED  +  T2/T3 new version → PROVISIONAL  (then T5 again)
```

- **Distinct concepts:**
  - raw submission (draft or SUBMITTED);
  - validated result (05C read-back: content re-derives under the pinned ruleset);
  - official outcome (OFFICIAL);
  - classification (computed);
  - advancement decision (a recorded fact).
- **Authority.** Every transition is authorized by Authority Engine grants for the result's exact hierarchy path:

  | Transition | Required capability |
  |---|---|
  | T2 submit | `SUBMIT_RESULT` |
  | T3 accept | `ACCEPT_RESULT` |
  | T5 declare official | `DECLARE_OFFICIAL` |
  | Correction | `CORRECT_RESULT` + `ACCEPT_RESULT` |

  A competition role grants none of these.
- **Over the API:**
  - The caller must be competition staff.
  - Actions run as the caller's own PERSON principal, derived server-side.
  - Score sheets are validated under the pinned ruleset before submission.
- **Advancement reads only results at the policy's minimum status** (OFFICIAL by default). A PROVISIONAL result is visible as "not official yet" and advances nobody.

## 3. Advancement policy model

`br:advancement-policy-spec` (`AdvancementPolicySpec`, catalogued as `sports.advancement_policy_version`; six canonical templates):

| Field | Values | Meaning |
|---|---|---|
| `minimumResultStatus` | OFFICIAL · PROVISIONAL | Results trustworthy enough to consume |
| `commit` | CONFIRM · AUTOMATIC | CONFIRM needs the preview hash; AUTOMATIC still needs an explicit, audited command |
| `heatSemantics` | PLACE_THEN_TIME · OVERALL | Competitive heats (Q by place, then q by time) vs logistic heats (one classification across heats) |
| `boundaryTies` | HOLD · SEED | Ties at a capacity boundary or for an ordered slot: wait for an override, or the better seed takes it |
| `withdrawn` | VACATE · NEXT_BEST | Withdrawn or disqualified entrant: the slot stays empty, or the next eligible entrant takes it (never for direct winner slots) |
| `crossGroupOrder` | `VALUE` / `DIFFERENCE` / `RATIO` keys | Comparing entrants of different groups; checked at pin time against the values the pinned standings template produces |

**Families.** These interpret plan sources; no family is written per sport.

| Plan source / transition | Family |
|---|---|
| `WINNER_OF_CONTEST` / `LOSER_OF_CONTEST` | DIRECT_WINNER / DIRECT_LOSER |
| `RANK_FROM_STAGE` + group | GROUP_RANK |
| `RANK_FROM_STAGE` (single-round stage) · `QUALIFY_BY_PLACE_AND_TIME` | TOP_N |
| `RANK_FROM_STAGE` (multi-round stage) | STAGE_TOTAL |
| `BEST_RANKED_FROM_STAGE` | BEST_N_ACROSS_GROUPS (its declared comparison is the "conditional rank") |
| `CUT` (top N, ties per `includeTies`) · `ELIMINATE_NON_FINISHERS` | CUT |
| Organizer act | MANUAL_OVERRIDE |

**Destinations are declarative.** The crossover (A1 v B2, B1 v A2 …), the lanes of a final and the dynamic rounds are the immutable plan's data. Nothing in code says "A1 plays B2".

## 4. Slot model

| Target | Resolved by | Read through |
|---|---|---|
| Dependent contest slot (`contest_id`, `slot`): winner / loser / rank / best-ranked | Facts of its unit | `v_contest_occupant` |
| Field place (`transition`, `ordinal`) of QUALIFY / CUT / ELIMINATE | Facts of `field:<t>` | `QUALIFIER` slots (`source_ordinal`), or a dynamic round's contest |

Each target exposes its source (type and reference), state, current entrant, proposed entrant (with a reason when not resolvable) and provenance.

**Target states:**

| State | Meaning |
|---|---|
| UNRESOLVED | No fact yet. The proposal may be PENDING (evidence missing), HELD (tie) or ready to confirm |
| RESOLVED / VACANT | The current fact equals what the current evidence proposes |
| STALE | The current fact no longer follows from the current evidence (correction, withdrawal, re-officialization) |
| OVERRIDDEN | An organizer's explicit decision is current |

INVALIDATED and REPLACED appear in the history.

## 5. Provenance

Structured provenance answers "why is this entrant here?". It is stored per assignment inside the canonical decision document, and its digest is stored with every fact:

- **family** and **source** (contest, stage, group, rank, ordinal, transition);
- **result** (contest, result version, content hash, status, outcome, opponent) for direct slots;
- **classification** (stage, group, `throughRound`, document hash, position, tied) for rank, field and cut;
- **heat** (contest, place) for Q-by-place qualifiers;
- **comparison** (every cross-group candidate with the compared values, in decided order) for best-across-groups;
- **candidates** and `decidedBy: SEED` when a tie was held or seed-broken;
- **replaces** for overrides.

The organizer UI renders one line per target (e.g. "Winner of Semifinal · #2 · official result") and the full history.

## 6. Dependency invalidation and corrections

- **Computed on read.** Staleness is computed on read by comparing each current fact's digest with the current preview. It is never stored, so it cannot go stale itself.
- **Correction example:**
  1. The SF1 result is corrected: SUPERSEDED, plus a new PROVISIONAL version.
  2. The final's SF1 slot becomes STALE (not yet consumable under OFFICIAL).
  3. After T5 the preview proposes the true winner.
  4. Confirming appends a new fact.
  5. The old fact stays in the history as INVALIDATED.
- **Propagation.** Staleness propagates: a contest fed by a stale slot reports `UPSTREAM_STALE` to its own dependants.
- **A stale contest cannot start** (`ADVANCEMENT_STALE`). An entrant is never moved into or out of a started contest (`DOWNSTREAM_STARTED`); void or cancel it first.

## 7. Manual overrides

- **Endpoints:**
  - `POST /v1/events/:id/advancement/overrides` (target, participant or vacant, reason);
  - `…/overrides/revoke` (target, reason).
- **Authorization and audit.** Requires `COMP_GENERATE_STRUCTURE` (OWNER / ADMIN). Each act records the occupant and digest it replaces, plus the actor and time (decision row + audit + outbox). The reason is organizer-only.
- **Refusals:** fixed slots, inactive entrants, entrants already placed in the same round or field, and started contests.
- **Interaction with automatic commits.** Automatic commits never touch an overridden target. Revocation restores the latest automatic fact, which is then judged as usual.

## 8. Preview versus commit

`GET /v1/events/:id/advancement` returns every unit with:
- a canonical `br:advancement-decision@1` preview and its hash;
- a `needsCommit` flag;
- per-target states.

`POST …/commit` takes `units[{unitKey, previewHash}]`. A commit is refused when:
- the preview changed (`PREVIEW_CHANGED`);
- the policy is CONFIRM and no hash was sent (`PREVIEW_REQUIRED`);
- a decision for the unit landed meanwhile.

Unchanged evidence writes nothing.

## 9. API

| Route | Gate | Purpose |
|---|---|---|
| `GET /v1/events/:id/advancement` | COMP_VIEW_PRIVATE | State, previews, provenance |
| `GET /v1/events/:id/advancement/history?contest=&slot=` / `?transition=&ordinal=` | COMP_VIEW_PRIVATE | Every fact of one target |
| `POST /v1/events/:id/advancement/commit` | COMP_GENERATE_STRUCTURE | Confirm units |
| `POST /v1/events/:id/advancement/overrides` (`/revoke`) | COMP_GENERATE_STRUCTURE | Explicit, reasoned override and its reversal |
| `GET /v1/contests/:id/results` | COMP_VIEW_PRIVATE | Versions and lifecycle |
| `POST /v1/contests/:id/results` | staff + SUBMIT_RESULT | Validate + submit (T2) |
| `POST /v1/result-versions/:id/accept` | staff + ACCEPT_RESULT | T3 |
| `POST /v1/result-versions/:id/declare-official` | staff + DECLARE_OFFICIAL | T5 |
| `POST /v1/contests/:id/results/corrections` | staff + CORRECT_RESULT + ACCEPT_RESULT | Atomic correction |

- **No arbitrary slot mutation route exists,** and an inventory test proves it.
- **Public responses:** the bracket now carries `resolved: true` and the entrant for filled dependent slots. Provenance, reasons and overrides never appear publicly.
- **Fixed in passing (05C defect):** query parameters are strings on this API (no type coercion). `?throughRound=` on the 05C classification route could never validate; it now takes a digit string, and a test covers it.

## 10. Persistence (`0034`)

| Object | Purpose |
|---|---|
| `results.result_status_transition` CHECK | + T5, T7 |
| `results.assert_supersedes_same_result` | A version supersedes only an earlier version of the same result |
| `sports.advancement_policy*` + current view | Policy catalog (br_catalog writes; others read) |
| `competition.event_scoring.advancement_policy_version_id` | The pin (view recreated) |
| `competition.advancement_decision` | Append-only decisions (canonical document + hash, supersedes, reason for overrides only) |
| `competition.slot_assignment` | Append-only facts; integrity trigger: dependent slot or selecting transition of the same event, participant of the same event |
| `v_slot_assignment_current`, `v_contest_occupant` | Current fact per target; current occupant per contest place |

**Changed readers:**
- ScoringStore's contest context: occupant-aware; vacant contests are excluded; `throughRound` filters contests.
- The start check: occupants plus the stale guard.
- The public projection: occupants for dependent slots and materialized fields.

## 11. UI

- **Structure page.** The scoring panel now pins the advancement policy and shows its basis. The page links to Results & progression.
- **Progression page** (`…/categories/:eventId/progression`):
  - per-unit tables: next-stage place, state, entrant (current, then "now:" if the proposal differs), reason, a "why" line and a History link;
  - Confirm these places (sends the preview hash);
  - Override and Revoke forms (reason required);
  - a history side panel (CURRENT / INVALIDATED / REPLACED, decision kind, reason, provenance);
  - states for a missing policy, no structure, and no advancement required.
- **Public category page.** Filled dependent slots show the entrant with their source ("Group 1 · 2nd"); unresolved slots stay "TBD".

## 12. Proof cases (`packages/persistence/src/oncf05d.int.test.ts`, 13 tests)

| Case | Proven |
|---|---|
| A tennis knockout | Missing / provisional → pending; T5 → winner and loser proposed with result provenance; CONFIRM refuses a missing or wrong hash; commit, then re-run writes nothing; the public bracket shows the finalist without provenance; correction → STALE, then the final can't start, then re-officialize, re-commit, and history marks INVALIDATED; a cancelled source → pending, then a reasoned override (duplicate refused), then revocation; v1 events can't pin |
| B padel groups → knockout | Three-way tie broken by the tied-subset rule; GROUP_RANK into the declared crossover; best second place across three groups by the declared cross-group order |
| C road race (wave) | `NO_ADVANCEMENT_REQUIRED` — no next stage invented |
| D swimming heats → final | OVERALL (logistic): top 8 across heats, a tie for place 8 HELD, then a swim-off override; PLACE_THEN_TIME (competitive): a slow heat's winner qualifies, with heat provenance; deterministic hash |
| E golf multi-round + cut | Cumulative classification `throughRound` 2; top 2 **and ties** gives 3; DNF never continues; round-3 contests materialized; a withdrawal → STALE, then re-commit → VACANT, and classification is not blocked |
| F basketball 3x3 pools → knockout | Team participants fill knockout slots |
| Stepladder (bowling) | One contest fed by a stage-1 rank **and** a stage-2 match winner; each slot resolves from its own stage |
| Concurrency | Two simultaneous commits of one preview: exactly one decision; the other is a conflict |
| Ledger | T5 needs `DECLARE_OFFICIAL`; corrections need both capabilities, refuse identical content and stale targets; database refuses cross-result supersession |

**Edge cases** (unit: `competition/src/advancement/advancement.test.ts`, 21 tests; integration above):

| # | Edge case | # | Edge case |
|---|---|---|---|
| 1 | Two-way tie | 11 | Team entrant |
| 2 | Multi-way tie | 12 | Pair entrant |
| 3 | Tie at the cut | 13 | No next stage |
| 4 | Unresolved source | 14 | Multiple source stages |
| 5 | Missing result | 15 | Best across groups |
| 6 | Non-official result | 16 | Logistic partition |
| 7 | Correction | 17 | Competitive partition |
| 8 | Stale advancement | 18 | DQ / DNF |
| 9 | Override | 19 | Withdrawal before the next stage |
| 10 | Idempotent re-run | 20 | Cancelled source contest |

**API suite** (`apps/api/src/oncf05d.int.test.ts`):
- the full lifecycle over HTTP;
- staff without a grant → 403 `AUTHORITY_DENIED`;
- strangers and the other organizer (IDOR) → 403 on results, history, commit and override;
- the registration manager reads but cannot commit or override;
- a participant cannot read or act;
- the route inventory;
- the public bracket shows no provenance or reason.

## 13. Security model

| Gate | Requirement |
|---|---|
| Reads | `COMP_VIEW_PRIVATE` (competition staff) |
| Decisions (commit, override, revoke) | `COMP_GENERATE_STRUCTURE` (OWNER / ADMIN only) |
| Results | Staff gate **and** the caller's own principal holding the Authority Engine capability for that contest's hierarchy path |

- **No new role or permission.** Every check runs server-side from database facts; nothing is inferred from UI state.
- **Conflict-of-interest checks fail closed** without a configured participation source (`resultConflictChecker`), as everywhere else (BRT-03R).
- **No leaks.** Provenance, reasons and history are never public.

## 14. Concurrency

| Operation | Protection |
|---|---|
| Commit | Advisory lock per event structure; the unit's last decision and every target's current fact are compared with the read used for the preview (`PREVIEW_CHANGED` on any difference) |
| Overrides and revocations | Same lock |
| Corrections | Lock the result stream and state; the named version must be current |

Idempotency keys apply everywhere.

A correction that lands between a preview read and its commit produces a decision that is immediately STALE on the next read. It is surfaced, never silent, and no sleeps or retries are used.

## 15. Known limitations

- **Field-family winners.** Field-family rulesets (pinfall, time) yield RANKED outcomes, not WIN or LOSS. A bowling stepladder match therefore has no automatic winner and needs an override (ADR-0065). A head-to-head pinfall vocabulary is future 05C work.
- **Missed cut.** classification-engine/2 shows entrants who missed a cut as DNS in later cumulative rounds; there is no "MC" status.
- **Not implemented:** T6 FINAL and T8 REVOKED. Ranking and achievement reactors don't subscribe to `ResultOfficial` yet.
- **Ties inside heats.** A tie inside a heat's Q places holds the whole heats → final field (who is left for q is unknown); an override resolves it.
- **Cross-group comparison of uneven groups** uses values as they are (no per-match normalisation); a policy can choose RATIO keys.
- **No cascade on correction.** A correction after a downstream contest started is refused for that contest (`DOWNSTREAM_STARTED`); the organizer voids or cancels it. Played downstream results are never rewritten automatically.

## 16. Exact handoff to ONCF-05E

05E receives:
- **Contests with resolved entrants.** Their occupants come from `v_contest_occupant`, and the start guard refuses stale ones.
- **Materialized dynamic-round contests** with no time, venue or grouping. For per-entrant rounds (golf) there is one contest per field place; 05E groups them into tee groups and times.
- **Committed fields**, for start lists and lane draws as a scheduling concern.

05E owns WHERE and WHEN: courts, lanes as resources, tee times, start times, venue allocation, conflicts, staff and calendars. It must not change who occupies a place: that only changes through an advancement decision or an override.
