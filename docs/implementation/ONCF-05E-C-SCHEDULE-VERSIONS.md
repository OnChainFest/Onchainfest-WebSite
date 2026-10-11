# ONCF-05E-C — Schedule versions, assignments and publication

| | |
|---|---|
| Branch | `feat/oncf-05e-c-schedule-versions` (local, uncommitted; on top of `b8c6ea5`, ADR-0073) |
| Contract | [ONCF-05E architecture](./ONCF-05E-ARCHITECTURE.md) · [ADR-0070](../adr/ADR-0070-schedule-versions-publication-and-history.md) · [ADR-0071](../adr/ADR-0071-conflict-semantics-and-deterministic-proposals.md) · [ADR-0072](../adr/ADR-0072-scheduling-profile-spec-v1.md) · [ADR-0073](../adr/ADR-0073-scheduling-semantics-clarifications-resource-occupancy-model.md) (all unchanged by this phase) |
| Migration | `0037_oncf05e_c_schedule_versions.sql` (additive; 0001–0036 untouched) |
| Not in this phase | conflict / feasibility engine (05E-D) · proposals (05E-E) · operations API (05E-F) · organizer scheduling UI (05E-G) · public schedule UI changes (05E-H) |

**What this phase answers.** What the competition's schedule *is*, version by version: which contest is placed where and when, by whom and why; what is private and what is public; and what a publication checked. It never answers whether a schedule is feasible: overlap, capacity, start spacing, concurrent starts, participants, rest, dependency lead, availability and daily limits are the 05E-D engine's.

## 1. Domain (`@br/competition`)

| Module | Content |
|---|---|
| `scheduling/report.ts` | **The conflict-report contract** (ADR-0071 + ADR-0073 B7): all 22 codes (ADR-0071's 16 + ADR-0073's six), fixed or enforcement-dependent severity, certainty, the conflict and report shapes, `canonicalScheduleReport` (sorted inputs, canonical conflicts, pairwise de-duplication, the frozen seven-key order), `conflictKey` (what a publication acknowledges), `scheduleReportHash` (RFC 8785 JCS + SHA-256, domain-separated like `catalogSpecHash`), `reportVerdict` |
| `scheduling/units.ts` | `deriveUnitKeys` (ADR-0073 B9): `contest:<id>` · `partition:<round>:<key>` (plan partition, or the **inherited** key of the same entrant in the nearest earlier round of a GROUPED_ENTRANTS stage) · `regroup:<round>:<n>` (profile regrouping over 05D field ordinals in a dynamic round) |
| `scheduling/assignment.ts` | Whole-second instants, `defaultExpectedEnd` (start + latest plan offset + expected duration), `blockingEnd` (changeover only on EXCLUSIVE resources) and the **baseline validator** |
| `resources/resource.ts` | `OccupancyMode` (`EXCLUSIVE \| SHARED`) and `RESOURCE_TYPE_DEFAULT_OCCUPANCY_MODE` (write-time defaults only) |

No module branches on sport identity; a source-level test enforces it for the new files.

### The baseline validator (the validator in force in 05E-C)

ADR-0073 I-B1.3: until 05E-D lands, publication runs a baseline validator whose report declares exactly what it covers:

| Code | Severity | Rule |
|---|---|---|
| `INCOMPLETE_ASSIGNMENT` | SOFT | No expected end, or no resource where the event's pinned profile requires one (I-B8.3) |
| `OUTSIDE_EVENT_WINDOW` | HARD | Start before the event's declared window, or end after it (event window, else the competition's — the window the BRT-05 route used to enforce at write time) |
| `RESOURCE_TYPE_MISMATCH` | HARD | The resource's type differs from the governing requirement's |

Coverage is exactly these three codes. A report never claims anything about any other code; 05E-D replaces the validator behind the same contract.

## 2. Persistence (`0037`)

| Object | Purpose |
|---|---|
| `resource_revision.occupancy_mode` | Declared simultaneous occupancy, NOT NULL, `EXCLUSIVE \| SHARED`; exposed by `v_resource_current` (with `revision_id`) |
| `schedule_version` | Competition, version number, base version, creator (NULL only for the migrated version 1) |
| `schedule_version_status_change` (+ `v_schedule_version_current`) | Append-only `DRAFT → PUBLISHED → SUPERSEDED`, `DRAFT → DISCARDED`. A trigger allows only these transitions, at most one DRAFT and one PUBLISHED per competition, serialized with the store's advisory-lock key |
| `schedule_assignment` (+ `v_schedule_assignment_current`) | Append-only per-contest facts: **at most one `resource_id`**, `starts_at`, `expected_end`, stored `changeover_seconds`, planning `zone`, `unit_key`, `provisional` / `locked` / `removed`, display labels, `reason`, `replaces_assignment_id`, `source` (`MANUAL`, `CARRIED`, `MIGRATED`), actor. The current content of a version is the latest fact per contest |
| `schedule_publication` | Per publication: report hash, the canonical report, coverage, acknowledged conflict keys, superseded version, actor |
| `contest_schedule.resource_id` | The published projection also carries the resource |

**Database integrity:** append-only, no-truncate and `recorded_at` triggers on the four new tables; an assignment trigger accepts new facts only into an open DRAFT and only for a contest and resource of the version's competition; CHECKs keep new placements on whole seconds, `expected_end > starts_at`, a unit key on every `MANUAL` fact and an actor on every non-migrated fact. Grants: `br_competition` SELECT + INSERT; `br_rebuild` SELECT.

### One-time migration exception: the occupancy-mode backfill

`resource_revision` is append-only for every role. ADR-0073 requires an explicit stored mode on every revision, so 0037 performs one documented exception, inside the migration's own transaction:

1. add the nullable column;
2. `DISABLE TRIGGER resource_revision_append_only`;
3. one `UPDATE` setting `occupancy_mode = competition.default_occupancy_mode(type_code)` (the same table as `RESOURCE_TYPE_DEFAULT_OCCUPANCY_MODE`; a test compares them);
4. `ENABLE TRIGGER` immediately;
5. `SET NOT NULL` and the `EXCLUSIVE | SHARED` CHECK.

No synthetic revision and no actor is fabricated. Afterwards the table is append-only again (tested), and the stored value is authoritative for future scheduling.

### Legacy migration

`competition.migrate_legacy_contest_schedule()` (run once by 0037; owner-only) gives every competition with `contest_schedule` rows and no schedule version a **version 1, PUBLISHED**, whose `MIGRATED` assignments reproduce the rows exactly:

- no resource; the original instants (sub-second legacy instants are kept); the original end, **NULL included — no invented duration**;
- no unit key (legacy rows cannot derive B9 units safely; 05E-D recomputes them);
- the original labels and actor; status actor NULL with reason `migrated from contest_schedule (ONCF-05E-C)`.

Nothing currently public changes. A missing end is reported as `INCOMPLETE_ASSIGNMENT`, never treated as complete. Rescheduling continues through a draft carried from version 1.

## 3. Commands (`ScheduleStore`)

| Command | Permission | Behaviour |
|---|---|---|
| `openDraft` | COMP_MANAGE_SCHEDULE | New DRAFT; base = current PUBLISHED; its assignments copied as `CARRIED` facts. A second open draft is refused (`DRAFT_OPEN`) |
| `setAssignment` | COMP_MANAGE_SCHEDULE | Records the concrete placement (below) |
| `removeAssignment` | COMP_MANAGE_SCHEDULE, reason | Draft-only assignments only; a published contest's assignment is refused (`PUBLISHED_ASSIGNMENT`) |
| `setLock` | COMP_MANAGE_SCHEDULE | Lock (reason optional) / unlock (reason required) |
| `validate` | COMP_MANAGE_SCHEDULE | The canonical report, its hash, and each conflict's key |
| `publish` | COMP_MANAGE_SCHEDULE, human | § 4 |
| `discard` | COMP_MANAGE_SCHEDULE, reason | DRAFT → DISCARDED, terminal |
| `listVersions`, `getVersion` | COMP_VIEW_PRIVATE | Versions; content, status history, every fact (history), publication record |

**`setAssignment` — structural refusals only:**

| Refusal | Code / reason |
|---|---|
| Unknown contest / resource | NOT_FOUND |
| Contest or resource of another competition | INVALID_INPUT `CROSS_COMPETITION` (and the database trigger) |
| Profile-pinned event without a resource | INVALID_INPUT `RESOURCE_REQUIRED` |
| Resource type ≠ the governing requirement's | INVALID_INPUT `RESOURCE_TYPE_MISMATCH` |
| RETIRED resource | INVALID_TRANSITION `RESOURCE_RETIRED` |
| Non-whole-second, offset-less or malformed instant; end ≤ start; changeover outside 0–86 400 | INVALID_INPUT |
| Locked assignment | INVALID_TRANSITION `ASSIGNMENT_LOCKED` |
| Contest IN_PROGRESS or later (implicitly locked), CANCELLED or VOID | INVALID_TRANSITION `CONTEST_STARTED_OR_CLOSED` |
| Event not FIELD_LOCKED / IN_PROGRESS | INVALID_TRANSITION |
| A move (resource, start, end or changeover changes) without a reason | INVALID_INPUT `REASON_REQUIRED` |
| Version not an open DRAFT | INVALID_TRANSITION `NOT_A_DRAFT` |

Overlaps, capacity, spacing, participants, rest, dependencies, availability and daily limits are **recorded, never refused** (tested: two semifinals on one court at one time; a fifth bowler on a four-seat pair).

**Concrete values.** With a pinned profile, the omitted end defaults to start + the contest's latest plan offset + `expectedDurationSeconds`, and the omitted changeover to the requirement's `changeoverSeconds`; both are **stored** and never recomputed. Without a profile, a time-only assignment is allowed and the changeover defaults to 0. The zone defaults to the event's. `provisional` is true when a place is unresolved at write time. The unit key is derived (§ 1) and recorded on every non-migrated fact.

## 4. Publication (ADR-0070 §4, ADR-0073 B1)

**Authority:** an authenticated human account (the permission model requires an active account with a SELF person) holding `COMP_MANAGE_SCHEDULE` — OWNER, ADMIN, SCHEDULER — through the explicit command. No new permission. Nothing else publishes: proposal commits, draft edits, jobs, timers, outbox consumers and operator roles have no path to it.

**Preconditions** (all inside one transaction under the per-competition advisory lock):

1. the competition is not COMPLETED or CANCELLED;
2. the version is the open DRAFT;
3. `baseVersionId` equals both the draft's base and the current PUBLISHED version (`CONCURRENCY_CONFLICT BASE_VERSION_STALE`);
4. `reportHash` equals the report recomputed over exactly the draft's current content (`CONCURRENCY_CONFLICT REPORT_STALE`);
5. zero HARD conflicts (`INVALID_TRANSITION HARD_CONFLICTS`);
6. the acknowledged keys are **exactly** the SOFT conflicts' keys (`INVALID_INPUT ACKNOWLEDGEMENT_MISMATCH`, listing missing and unknown); a key is bound to its conflict's content, so an acknowledgement never carries over to a different report;
7. the idempotency key (a retry returns the first response, `created: false`).

**Effects, atomically:** the previous PUBLISHED version SUPERSEDED; the draft PUBLISHED; the publication record; `contest_schedule` upserted for contests whose published placement is new or moved (with `resource_id`); PLANNED contests in the version become SCHEDULED (ADR-0070 §7); read models refreshed; `ContestScheduled` + `contest.scheduled` / `contest.rescheduled` audit **only for new or moved contests** (unchanged carried assignments emit nothing); `ScheduleVersionPublished` + `schedule.published` audit with actor, version, superseded version, report hash, coverage and acknowledged keys.

Public readers see only `contest_schedule` (the PUBLISHED projection); drafts are never readable publicly.

## 5. API (`apps/api/src/v1-competition.ts`)

| Route | Gate |
|---|---|
| `GET /v1/competitions/:competitionId/schedule/versions` | COMP_VIEW_PRIVATE |
| `POST /v1/competitions/:competitionId/schedule/drafts` | COMP_MANAGE_SCHEDULE, idempotent (201 / 200) |
| `GET /v1/schedule-versions/:versionId` | COMP_VIEW_PRIVATE |
| `PUT /v1/schedule-versions/:versionId/assignments/:contestId` | COMP_MANAGE_SCHEDULE, idempotent |
| `POST /v1/schedule-versions/:versionId/assignments/:contestId/remove` · `/lock` · `/unlock` | COMP_MANAGE_SCHEDULE, idempotent |
| `POST /v1/schedule-versions/:versionId/validate` | COMP_MANAGE_SCHEDULE |
| `POST /v1/schedule-versions/:versionId/publish` | COMP_MANAGE_SCHEDULE, idempotent; body `{baseVersionId, reportHash, acknowledgedConflictKeys}` |
| `POST /v1/schedule-versions/:versionId/discard` | COMP_MANAGE_SCHEDULE, idempotent, reason |

No conflict-engine, proposal, optimization or auto-publication route exists; the inventory tests prove it.

## 6. Compatibility changes

| Surface | Before | Now |
|---|---|---|
| `POST /v1/contests/:id/schedule` (`StructureStore.scheduleContest`) | Overwrote `contest_schedule` (public at once) and set the contest SCHEDULED | **Edits the open draft** (opening one from the published version when none is open) through the one `ScheduleStore` implementation; **never publishes**. Optional `resourceId` and `reason` added; **moving an existing assignment requires `reason`**. Response: `{contestId, status, versionId, assignmentId, created}` — `status` is the contest's current status (PLANNED until a publication) |
| Event-window check | Refused at write time | Reported as HARD `OUTSIDE_EVENT_WINDOW` by the baseline validator: it blocks publication instead of the write |
| Instants | Any millisecond | New placements are whole seconds |
| Resource reads | `occupancy` (capacity-derived) | `occupancy` **kept**, documented as legacy descriptive data; **`occupancyMode`** added. Capacity never determines exclusivity; 05E-D/E must read `occupancyMode` only |
| Resource create / revise | — | Optional `occupancyMode`: omitted → the type default on create, the current value on revise; changes are audited (`changed: ['occupancyMode']`) and copied on retire / reactivate |
| `ContestScheduled` | On every route call | At publication, for new or moved contests only |
| Callers updated | — | The testkit timed fixture (new `publishSchedule` test helper), two `competition.int` tests and the `demo:competition` CLI now publish; the 05E-B route inventory test now lists the 05E-C surface (still no conflict-engine, proposal or generation route) |

## 7. Tests

| Suite | Count | Covers |
|---|---|---|
| `competition/src/scheduling/schedule-model.test.ts` | 18 | Default modes; the 22 codes and severities; the seven-key order; pairwise de-duplication; hash order-independence and content sensitivity (property test); severity / unknown-code / coverage refusals; verdict and acknowledgement keys; units: a 24-entrant squad, inherited round-2 groups, regroup ASC / DESC, singleton fallbacks, waves; interval defaults; changeover blocking; the baseline validator (coverage, overlaps not judged, INCOMPLETE, window, type); no sport identity in the new sources |
| `persistence/src/oncf05e-c.int.test.ts` | 17 | Draft creation and uniqueness; concrete end, changeover, unit key, provisional, one resource; every structural refusal; overlaps recorded; draft invisibility; publication authority (stranger, registration manager, person-less account refused; SCHEDULER publishes); stale report and base version; atomic publication, projection, SCHEDULED, audit, outbox, idempotent replay; carried drafts, reasons, locks, unlock, published-assignment removal refused, selective `ContestScheduled`, history; discard terminal; DB append-only and draft-only triggers; SOFT acknowledgement exactness, HARD blocking, acknowledgement bound to its report; a 24-bowler squad on six EXCLUSIVE lane pairs; golf round-2 inheritance; occupancy mode defaults / overrides / revise / retire / audit; backfill determinism; legacy migration |
| `apps/api/src/oncf05e-c.int.test.ts` | 2 | The full flow over HTTP with every refusal, the legacy route on a new draft, and the route inventory |

## 8. Known limitations

- **Feasibility is not checked yet.** Until 05E-D, publication blocks only the baseline's HARD codes; every publication records its coverage, so nothing is claimed beyond it.
- **Regrouping is exercised by domain tests.** The persistence suite covers plan partitions and inheritance; dynamic-round regrouping needs a committed 05D cut and is proven on the pure function the store calls.
- **Migrated rows** keep NULL unit keys and may keep sub-second instants; their carried copies do too. New placements are whole seconds.
- **No unscheduling** of a published contest in v1 (cancel it instead); no draft reopening after discard.
- **Consumption** (CONTEST / ENTRANT units) is not stored: 05E-D derives it from the plan and 05D facts.
