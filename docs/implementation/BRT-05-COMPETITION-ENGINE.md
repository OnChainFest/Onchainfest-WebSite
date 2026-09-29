# BRT-05 — Competition & Event Engine

Status: **implemented (operating layer)** · Phase: BRT-05 · Builds on: BRT-01 result domain §5 (operations layer), ADR-0008, ADR-0020, BRT-04 identity/organizations · New ADRs: [0024](../adr/ADR-0024-deterministic-format-engines-and-immutable-event-plans.md), [0025](../adr/ADR-0025-explicit-competition-hierarchy-resolution.md), [0026](../adr/ADR-0026-declared-lineups-are-operational.md) · Migrations: `0008_competition_engine.sql`, `0009_competition_read_models.sql`

BRT-05 implements the **operating** half of "the operating and trust layer for competitive sports": organize, register, structure, schedule, participate.

**Nothing here produces sporting truth.** No Result is declared, accepted, verified, ranked or rewarded by any competition operation, and every status is operational.

```
Competition → Event → Round → Contest → Contestant (slot)
Registration (request) → Participant (event-scoped identity) ≠ Athlete ≠ Team
Team (competition identity ≠ Organization) → TeamMembership (temporal) ≠ Lineup (per contest)
```

## 1. Tables and classification

| Schema.table | Class | Purpose |
|---|---|---|
| `sports.*` (7 tables) | A | Catalog: see [BRT-05-SPORT-CATALOG.md](./BRT-05-SPORT-CATALOG.md) |
| `competition.competition` | A | Identity, organizer organization, creator |
| `competition.competition_profile` | OP | Name, description, location label, region, IANA timezone, UTC dates, https website |
| `competition.competition_slug` | A | Slug history (redirects; never re-claimable) |
| `competition.competition_status_change` | A | Lifecycle |
| `competition.competition_staff` + `_status_change` | A | Operational staff roles |
| `competition.event` | A | Pinned DisciplineVersion + FormatVersion, entrant kind, canonical format config + hash |
| `competition.event_profile` | OP | Name, category, capacity, registration mode/window, dates, timezone |
| `competition.event_slug` | A | Slugs scoped to the competition |
| `competition.event_status_change` | A | Lifecycle |
| `competition.team`, `team_manager`, `team_membership` + `_status_change` | A | Teams and temporal membership |
| `competition.team_profile` | OP | Public team name |
| `competition.registration` + `_status_change` | A | Entry requests |
| `competition.event_field` | A | Locked field hash + count |
| `competition.participant` + `_status_change` | A | Event-scoped competition identities |
| `competition.event_seeding` | A | Seeding fact (method, draw seed, order, hash) |
| `competition.event_plan` | A | Immutable generated plan (document + hashes) |
| `competition.round`, `contest`, `contestant` | A | Materialized structure |
| `competition.contest_schedule` | OP | Schedule, venue, labels (changes audited) |
| `competition.contest_status_change` | A | Contest lifecycle |
| `competition.lineup` + `lineup_member` | A | Declared lineups (latest per contest + participant is current) |
| `competition_read.*` (7 tables) | B | Public projections, rebuildable ([§11](#11-read-models-and-rebuild)) |

All class A tables have append-only and `recorded_at = transaction time` triggers; the owner is also stopped. There are no cascading deletes anywhere.

## 2. Competition

- An organized edition **organized by** an Organization (`organizer_organization_id`). It is never the same identity as the organization.
- Creating one requires **`ORG_MANAGE_COMPETITIONS`** in an ACTIVE organizer organization. This new BRT-04 organization permission is held by OWNER and ADMIN.
- Slugs are normalized (BRT-04 rules, reserved words refused) and kept in a history table. A former slug keeps resolving and the web issues a 308. Concurrent claims of one slug: exactly one wins (tested with 6 concurrent creations; no orphans).
- Lifecycle:

| From | To | Extra preconditions |
|---|---|---|
| DRAFT | PUBLISHED, CANCELLED | — |
| PUBLISHED | ACTIVE, CANCELLED | — |
| ACTIVE | COMPLETED, CANCELLED | COMPLETED requires every event to be COMPLETED or CANCELLED |
| COMPLETED, CANCELLED | — | terminal |

- **COMPLETED does not mean results are final or verified.**
- Cancellation appends CANCELLED facts to every non-terminal event and to their PLANNED/SCHEDULED contests. Nothing is deleted: participants, registrations, memberships and plans remain.
- Publicly, DRAFT competitions return 404, while CANCELLED ones are served and marked.

## 3. Event

- Pins **exact PUBLISHED** catalog versions at creation (A).
- The engine's contest type must be allowed by the discipline. For example, a HEAT-only running discipline cannot use a MATCH format (tested).
- The entrant kind (`INDIVIDUAL` or `TEAM`) must be one of the discipline's participant kinds.
- The format configuration is validated against the FormatVersion's BR-JSON schema. It is canonicalized, frozen with the event and hashed (`format_config_hash`). Unknown fields are refused.
- The **category** holds declared, structured labels: gender category, age label with bounds, skill/weight class, division, classification, up to 8 custom labels. BRT-05 **never** infers or verifies sex, age, licence or ranking, and never reads the vault.
- Eligibility is recorded per confirmation as `DECLARED` (auto-confirm) or `ORGANIZER_ACCEPTED`, and the entrant must declare eligibility to register.
- Settings are editable until the field locks, but capacity and registration mode change only while DRAFT. Event dates must fall inside the competition dates when both are set.

| From | To | Extra preconditions |
|---|---|---|
| DRAFT | REGISTRATION_OPEN, CANCELLED | Opening requires the competition to be PUBLISHED or ACTIVE |
| REGISTRATION_OPEN | REGISTRATION_CLOSED, CANCELLED | — |
| REGISTRATION_CLOSED | REGISTRATION_OPEN, FIELD_LOCKED, CANCELLED | FIELD_LOCKED via `lockField` only |
| FIELD_LOCKED | IN_PROGRESS, CANCELLED | IN_PROGRESS requires a generated plan and an ACTIVE competition |
| IN_PROGRESS | COMPLETED, CANCELLED | COMPLETED is an organizer command; never automatic |

- There is **no path from FIELD_LOCKED back to registration**.
- IN_PROGRESS and COMPLETED do not mean official or verified results.

## 4. Registration, capacity and waitlist

- **XOR entrant:** an athlete or a team, never both. This is enforced by a DB CHECK and by the API/store.
- Lifecycle: `REQUESTED → CONFIRMED | WAITLISTED | DECLINED | WITHDRAWN`; `WAITLISTED → CONFIRMED | DECLINED | WITHDRAWN`; `CONFIRMED → WITHDRAWN | CANCELLED`. Every transition is a status fact.
- **AUTO_CONFIRM:** `REQUESTED` then, in the same transaction, `CONFIRMED` if there is capacity, else `WAITLISTED`.
- **ORGANIZER_APPROVAL:** stays `REQUESTED`. An organizer confirming when the event is full gets `CAPACITY_REACHED`.
- **Who registers:**
  - Individual: SELF or confirmed GUARDIAN of the athlete's person. This uses the new BRT-04 person operation `REGISTER_FOR_EVENT`.
  - Team: a TeamManager.
  - The athlete must be ACTIVE, and teams need at least `lineupSize.min` active members.
- **One active entry per athlete per event**, individually or through any team: checked in the store under the capacity lock. A DB trigger (`BR004`) also serializes per entrant and refuses a second active registration.
- **Capacity is never exceeded**, by two independent layers:
  1. Every capacity-affecting command takes the per-event advisory lock `event-capacity:<id>`, then decides confirm or waitlist.
  2. An AFTER INSERT trigger on CONFIRMED status rows takes the same lock, counts with a fresh snapshot and raises `BR003`.
  - Composite FKs make a status row's `event_id` equal its registration's, so accounting cannot be misdirected.
  - Tested: 20 simultaneous registrations at capacity 4 → exactly 4 CONFIRMED and 16 WAITLISTED. A raw fifth CONFIRMED insert is refused by the database.
- **Withdrawal before the lock:** by the entrant, or by an organizer (audited). If a confirmed place frees in AUTO_CONFIRM, the earliest WAITLISTED entry (by `recorded_at`, then id) is promoted automatically. After the lock, registrations are frozen.
- **Idempotency:** 20 identical attempts with one key give one registration. The same key with a different request gives `IDEMPOTENCY_KEY_REUSED`.

## 5. Participant

- "This entrant in this Event": created **only** by `lockField`, one per CONFIRMED registration (`registration_id` UNIQUE, composite FK on the event).
- The same athlete in two events has two Participants (tested). A team participant references the Team, never an Organization.
- Status: `ACTIVE → WITHDRAWN | DISQUALIFIED`.
  - `DISQUALIFIED` requires a reason and a reference (CHECK). It is an **operational exclusion**, not a verified sporting sanction.
  - Withdrawal after the plan keeps the participant's bracket slot and history. No walkover, forfeit or result is created, and a contest with a withdrawn participant cannot start (tested).

## 6. Team and TeamMembership

- **Team** is a competition-side identity (BRT-01 §5.6): `PERSISTENT`, `EVENT_PAIR` or `EVENT_SQUAD`.
  - It is **not an Organization**.
  - The optional `organization_id` is an affiliation label; setting it requires `ORG_MANAGE_COMPETITIONS` there, and it confers nothing.
- **Management** is the explicit `team_manager` relation (the creator's SELF person). It is never inferred from wallets, organization roles or authority.
- **TeamMembership** is temporal: `PROPOSED → ACTIVE | DECLINED`, `ACTIVE → ENDED`.
  - A manager's proposal needs the athlete side (SELF or confirmed guardian) to accept, unless the manager already controls that athlete.
  - Membership at time *t* is the latest status with `recorded_at ≤ t` = ACTIVE (`activeTeamMembers`).
  - Ending is prospective; history remains (tested).

## 7. Field lock, seeding and plan

- **Field lock:**
  - Materializes Participants in the same transaction as the FIELD_LOCKED status.
  - Hashes the canonical set (`br:competition-field`, keyed by participant id) into `event_field`.
  - Waitlisted, pending and withdrawn entries never enter.
- **Seeding** happens **once** per event, tied to the field hash (`event_seeding` PK = event):
  - `MANUAL`: an exact permutation of the field, or refused.
  - `DETERMINISTIC_DRAW`: a 32-byte CSPRNG seed is generated and **persisted**, and the order is `br-draw/1`. Anyone with (field, seed) can reproduce it (tested). It is **not** a provably fair draw (see threat review).
- **EventPlan** (ADR-0024): one immutable plan per event, generated from the pinned versions, the exact engine version, the field, the seeding and the config.
  - Stores `input_hash`, `plan_hash` and the full `plan_document` (the historical structure).
  - Repeating returns the existing plan. A different input is refused; nothing is overwritten.
  - Six concurrent generations yield one plan and no duplicate rounds or contests.
  - **No field amendment after the lock** in BRT-05: the safest policy. Amendment and rebuild need an explicit future workflow.

## 8. Round, Stage, Contest, Contestant

- **Round** is required (BRT-01: a Contest is owned by exactly one Round): `round_type` from BRT-01 plus a stable `sequence` and `plan_key`. Labels ("Semifinal", "Round 2") are presentation only. Round-robin byes are stored on the round.
- **No Stage entity.** Both BRT-05 formats are single-stage, and `roundType` + `sequence` express them fully. A Stage (group → knockout, qualification → final) will arrive with the first multi-stage format rather than as an unused table.
- **Contest types** come from BRT-01 (`MATCH`, `HEAT`, `SERIES`, `ATTEMPT_SET`, `ROUTINE`, `SESSION`). A match is a Contest of type MATCH.

| From | To | Notes |
|---|---|---|
| PLANNED | SCHEDULED, CANCELLED | Created by plan generation; the first schedule moves it to SCHEDULED |
| SCHEDULED | IN_PROGRESS, CANCELLED | Re-scheduling keeps SCHEDULED. Start requires the event IN_PROGRESS and **every slot holding an ACTIVE participant** |
| IN_PROGRESS | COMPLETED, VOID | COMPLETED = the activity ended operationally |
| COMPLETED | VOID | Operational annulment; decides no result |

- **COMPLETED ≠ Result FINAL/VERIFIED.** Completing a contest creates no Result and resolves no dependency (tested).
- **Contestant** sources are `PARTICIPANT`, `WINNER_OF_CONTEST`, `LOSER_OF_CONTEST` and `RANK_FROM_STAGE`, with CHECK-enforced shapes.
  - A trigger (`BR006`) keeps participants and dependencies within the same event.
  - **Resolution is not implemented:** dependent slots stay unresolved. No organizer command can set them, and rows are append-only.
  - ADR-0008 allows future progression on *provisional* results under event policy; that belongs with the Result/verification work.

## 9. Scheduling and lineups

- **Scheduling:**
  - `scheduledStart`/`scheduledEnd` are ISO-8601 instants **with an offset** (naive local times are refused), stored as `timestamptz`. The IANA timezone (validated by the runtime tz database) is display context.
  - The start/end must fall within the event window, or the competition window when the event has none.
  - A venue organization (optional; must exist and be ACTIVE), `locationLabel` and `courtLabel` can be set.
  - Changes are audited (`contest.scheduled` / `contest.rescheduled` with the previous start). No authority effect is backdated through scheduling.
- **Lineups** are **declared operational lineups** (ADR-0026; BRT-02 "Lineup drafts"):
  - The participant must occupy a resolved slot of the contest and be ACTIVE.
  - An individual participant fields exactly its athlete. A team fields ACTIVE team members at submission time, within the discipline's `lineupSize`.
  - The submitter is the entrant (athlete controller / team manager) or staff with `COMP_MANAGE_LINEUPS`.
  - Lineups close when the contest starts. A replacement is a new row, audited as `lineup.replaced`.
  - A lineup never changes TeamMembership. The lineup credited by achievements remains part of Result content (BRT-01).

## 10. Operational permissions (never authority)

`CompPermission` values (a compile-time guard plus a unit test prove they share nothing with BRT capabilities):

`COMP_VIEW_PRIVATE`, `COMP_EDIT`, `COMP_PUBLISH`, `COMP_MANAGE_STAFF`, `COMP_OPEN_REGISTRATION`, `COMP_CLOSE_REGISTRATION`, `COMP_MANAGE_REGISTRATIONS`, `COMP_LOCK_FIELD`, `COMP_GENERATE_STRUCTURE`, `COMP_MANAGE_SCHEDULE`, `COMP_MANAGE_LINEUPS`, `COMP_CANCEL`.

| Staff role | Permissions |
|---|---|
| OWNER | all |
| ADMIN | all except `COMP_MANAGE_STAFF` |
| REGISTRATION_MANAGER | view private, open/close registration, manage registrations |
| SCHEDULER | view private, manage schedule, manage lineups |

- An ACTIVE OWNER or ADMIN of the (ACTIVE) organizer organization acts as competition OWNER or ADMIN; other organization roles confer nothing.
- **There is no REFEREE or OFFICIAL staff role**; assigning one is refused (tested).
- Proofs that organizing does not mean authority are listed in [BRT-05-AUTHORITY-HIERARCHY.md](./BRT-05-AUTHORITY-HIERARCHY.md) §5.

## 11. Read models and rebuild

`competition_read` (class B) holds:
- `competition_card` and `competition_slug`;
- `event_summary` and `event_slug`;
- `event_entry`: CONFIRMED registrations and all participants;
- `round_card`;
- `contest_card`: slots as JSON, with unresolved dependencies kept as dependencies.

Maintenance and rebuild:
- Each command refreshes the affected rows in its own transaction.
- `rebuildCompetitionReadModels` (maintenance login, `br_rebuild`) truncates and re-derives everything from canonical facts. Timestamps come from facts, so the rebuilt snapshot is **identical** (tested; demo step 30).
- Plans are never regenerated: structure comes from the persisted rounds, contests and contestants.
- The projections hold ids and public-safe operational data only. **Athlete names are not copied.**

## 12. Privacy and public DTOs

- The public reader (`br_public_read`) resolves athlete display **at read time** from the Athlete Passport card. An athlete is shown only if ACTIVE, not restricted and `PUBLIC`; otherwise the DTO says `PRIVATE_ENTRANT`, with no name, slug or reason.
- This keeps BRT-04 dependent/minor behaviour intact: a guardian-registered minor appears only as a private entrant (tested).
- Team names are public by design.
- Waitlisted and pending entries are counted, never listed.
- DTOs never contain account ids, person ids, auth subjects, legal names, DOB, contact data, guardian data, private wallets or private external identifiers. Sentinel tests cover the public DTOs, outbox, audit details, read models and captured logs.
- `results`, `standings`, contest `result` and competition `authority` are always `NOT_AVAILABLE`, never an empty podium.

## 13. Events and audit

**Outbox events** (ids, statuses, slugs, hashes, counts only; no PII):
- **Catalog:** SportCreated, DisciplineCreated, DisciplineVersionCreated/Published/Retired, FormatTemplateCreated, FormatVersionCreated/Published/Retired.
- **Competition and event:** CompetitionCreated, CompetitionPublished, CompetitionStatusChanged, CompetitionStaffAssigned/Ended, EventCreated, EventStatusChanged.
- **Registration and field:** RegistrationOpened/Closed/Requested/Confirmed/Waitlisted/Declined/Withdrawn/Cancelled, EventFieldLocked, ParticipantsMaterialized, ParticipantWithdrawn/Disqualified.
- **Structure:** EventSeeded, EventPlanGenerated.
- **Teams:** TeamCreated, TeamMembershipProposed/Activated/Declined/Ended.
- **Contests and lineups:** ContestScheduled/Started/Completed/Cancelled/Voided, LineupSubmitted.
- **Never emitted:** ResultVerified, RecordRatified or PrizePaid.

**Audit** (write-only for runtime roles; telemetry, **not** authority):
- `competition.*`: created, status, staff, slug; DENIED attempts are also recorded.
- `event.*`: created, settings, field-locked, seeded, plan-generated, status.
- `registration.*`: organizer decisions, withdrawn-by-organizer.
- `participant.*`: including by-organizer.
- `contest.*`: scheduled, rescheduled, status.
- `lineup.submitted|replaced`, `team.*`, `catalog.*`.

## 14. Database roles

| Role | BRT-05 privileges |
|---|---|
| `br_catalog` (new; **only** the dedicated login `br_operator_app` may SET — BRT-05R) | SELECT/INSERT on `sports.*`; platform outbox, idempotency, audit INSERT |
| `br_competition` (new; `br_api` may SET) | SELECT/INSERT on `competition.*` A tables, UPDATE on OP tables, all on `competition_read`, SELECT on `sports.*` and the public-safe identity/organization control facts. **No** vault, auth identities, authority tables or results |
| `br_public_read` | + SELECT on `sports.*` and `competition_read.*` (read-only) |
| `br_rebuild` | + SELECT on `sports.*` and `competition.*`, all incl. TRUNCATE on `competition_read.*` |
| `br_authority`, `br_results` | + EXECUTE on `competition.resolve_scope_path` only |

The full login graph is asserted in `security.int.test.ts`. BRT-05-specific isolation is asserted in `competition-roles.int.test.ts`.

## 15. API

Command-style endpoints; there is no status PATCH. Creating commands take `Idempotency-Key`. Classes are enforced at the edge (authentication, operator flag) and in the stores (SELF, COMP_STAFF, ORG_ADMIN).

| Method & path | Class |
|---|---|
| `GET /v1/catalog` | PUBLIC |
| `GET /v1/competitions/:slug` | PUBLIC |
| `GET /v1/competitions/:slug/events/:eventSlug` (+ `/participants`, `/schedule`, `/bracket`) | PUBLIC |
| `POST /v1/internal/catalog/sports`, `/sports/:sportId/disciplines`, `/disciplines/:disciplineId/versions`, `/format-templates`, `/format-templates/:formatTemplateId/versions` | INTERNAL |
| `POST /v1/internal/catalog/discipline-versions/:id/{publish,retire}`, `/format-versions/:id/{publish,retire}` | INTERNAL |
| `POST /v1/competitions` | ORG_ADMIN |
| `GET /v1/competitions/:competitionId/permissions` | AUTHENTICATED |
| `PUT /v1/competitions/:competitionId/{profile,slug}` | COMP_STAFF |
| `POST /v1/competitions/:competitionId/{publish,activate,complete,cancel}` | COMP_STAFF |
| `POST /v1/competitions/:competitionId/staff`, `DELETE /v1/competition-staff/:staffId` | COMP_STAFF |
| `POST /v1/competitions/:competitionId/events`, `PUT /v1/events/:eventId/settings` | COMP_STAFF |
| `POST /v1/events/:eventId/{open-registration,close-registration,start,complete,cancel,lock-field,seed,generate-plan}` | COMP_STAFF |
| `POST /v1/registrations/:registrationId/decision` | COMP_STAFF |
| `POST /v1/participants/:participantId/disqualify` | COMP_STAFF |
| `POST /v1/contests/:contestId/{schedule,start,complete,cancel,void}` | COMP_STAFF |
| `POST /v1/events/:eventId/registrations`, `/v1/registrations/:registrationId/withdraw`, `/v1/participants/:participantId/withdraw` | SELF |
| `POST /v1/contests/:contestId/lineups` | SELF (or staff with COMP_MANAGE_LINEUPS) |
| `POST /v1/teams`, `/v1/teams/:teamId/members` | AUTHENTICATED |
| `POST /v1/team-memberships/:membershipId/{accept,decline,end}` | SELF |

DTOs are closed JSON schemas: unknown fields are refused, never stripped. `CAPACITY_REACHED` maps to 409.

## 16. Web

| Page | Content |
|---|---|
| `/competitions/[slug]` | Name, organizer (linked), dates in the competition timezone, status, events, "Results & sporting authority: not available yet" |
| `/competitions/[slug]/events/[eventSlug]` | Discipline and format (engine), registration status, counts and capacity, participants (Passport links or "Private entrant"), schedule, bracket/structure, and field/seeding/plan hashes |

- Unresolved slots render as "TBD (winner of contest #n)".
- Results render as "Not available yet".
- Old or cased slugs get a 308 redirect.
- There is **no admin UI** in BRT-05: operations use the command API, the seed and the demo.

## 17. Interpretation notes (no contradiction found; recorded)

- **One operating context.** BRT-02 lists *Competition* and *Participation* as two modules. BRT-05 implements them as one bounded operating context: role `br_competition`, schemas `competition` + `competition_read`. The reason is that field locking must create Participants atomically with the lock, and plan generation must reference them. Separation is kept at table level.
- **Lineup** in BRT-05 is the operational declaration (BRT-02 "Lineup drafts"). BRT-01's credited Lineup remains part of Result content (ADR-0026).
- **Contest `round_id` is required**, following BRT-01 ("owned by exactly one Round"), rather than optional as in the BRT-05 prompt sketch.
- **Not new ADRs:** Team ≠ Organization and Participant ≠ Athlete/Team are already decided in BRT-01 §5.5–5.6. Operational permissions ≠ authority is ADR-0020 plus the BRT-04 organization-permission pattern.

## 18. Known limitations (BRT-06+)

- No automatic progression or dependency resolution.
- No standings, rankings or results UI.
- No field amendment, substitution or plan versioning.
- No multi-stage formats (Stage), heats, double elimination or qualification + final.
- No participation-backed conflict-of-interest checker (no person ↔ principal mapping).
- No provably fair draw (commit–reveal).
- No retirement of sports or disciplines.
- No team rename.
- No admin UI.
- No rate limiting.
