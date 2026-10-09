# ONCF-05E-A — Resources and availability

| | |
|---|---|
| Branch | `feat/oncf-01-auth-wiring` (local, uncommitted; on top of `ad984bc`, ONCF-05E-0) |
| Contract | [ONCF-05E architecture](./ONCF-05E-ARCHITECTURE.md) (frozen) · [ADR-0066](../adr/ADR-0066-scheduling-boundary-and-competition-scope.md) · [ADR-0067](../adr/ADR-0067-generic-competition-scoped-resources.md) · [ADR-0068](../adr/ADR-0068-availability-and-scheduling-time-model.md) |
| Migration | `0035_oncf05e_a_resources_and_availability.sql` (additive; 0001–0034 untouched) |
| Not in this phase | SchedulingProfile (05E-B) · schedule versions, publication, locks, `contest_schedule` changes (05E-C) · conflict engine (05E-D) · proposals (05E-E) · operations API (05E-F) · UI (05E-G/H) |

**What this phase answers.** What resources a competition has, of what type, with what capacity and physical overlap, and when each one is intrinsically available. It never answers whether a resource is assigned to a contest: occupancy will be derived from schedules (05E-C) and is never stored.

## 1. Domain (`@br/competition`, `src/resources/`)

| Module | Content |
|---|---|
| `interval.ts` | **The one canonical interval primitive:** half-open `[start, end)` on epoch ms — `overlaps`, `union` (touching intervals merge), `intersect`, `subtract`, `covers`. Every later 05E phase uses it |
| `zoned.ts` | **Server-side wall-clock ↔ instant conversion** (ADR-0068): `resolve` (NORMAL / SKIPPED with the gap / REPEATED with both instants), `resolveRecurring`, `resolveStrict`, IANA validation, local date helpers. Uses the runtime tz database |
| `resource.ts` | Per-type **attribute schemas** as data (`RESOURCE_TYPE_ATTRIBUTES`, closed: unknown attributes are refused), `validateResource`, `occupancyOf` (capacity 1 = EXCLUSIVE, N = SHARED_CAPACITY), `sharesSpace` (physical overlap) |
| `availability.ts` | Availability facts, `validateAvailabilityFact`, **precedence-encoded** `effectiveAvailability(input, from, to)` and `isResourceAvailable(input, interval)` |

**Resource types** reuse the existing catalog vocabulary (`ResourceType` in `capabilities.ts`, declared per discipline since 05B): TENNIS_COURT, PADEL_COURT, BASKETBALL_COURT, BASKETBALL_HALF_COURT, BOWLING_LANE_PAIR (ten-pin), POOL, TRACK, ROAD_COURSE, OPEN_WATER_COURSE, CYCLING_COURSE and GOLF_COURSE. No new vocabulary was introduced, and there are no per-sport classes, stores or columns.

**Lanes inside a heat stay slots** (05B seeding). The pool or track is the resource.

### Physical overlap: the exclusivity group as a key set

ADR-0067's example is a full basketball court with its two half courts: booking the full court must block both halves, but the halves must not block each other. A single group key cannot express that.

A single key makes the halves mutually exclusive, so each resource carries a **set of exclusivity keys**. Two resources share space iff they are the same resource or their key sets intersect:

| Resource | Keys |
|---|---|
| Full court | `{main-a, main-b}` |
| Half A | `{main-a}` |
| Half B | `{main-b}` |

The full court overlaps each half; the halves overlap nothing. This is the representation of ADR-0067's group: same meaning, no sport code, no join table (a `text[]` column).

## 2. Availability semantics (ADR-0068)

| Fact (append-only) | Content | Scope |
|---|---|---|
| `WEEKLY` | ISO weekday (1 = Mon … 7 = Sun), local `start`–`end` (`end ≤ start` crosses midnight; `24:00` = end of day), optional `validFrom` / `validTo` | Resource or competition |
| `DATE_OPEN` | A local date's window(s); they **replace** the weekly windows for that date | Resource or competition |
| `DATE_CLOSED` | The local date is closed | Resource or competition |
| `BLACKOUT` / `MAINTENANCE` | Absolute UTC interval + mandatory reason | Resource or competition |

- **Removal** is an explicit revocation fact with a reason. Nothing is deleted or updated.
- **Duplicates:** an identical current fact is refused (`DUPLICATE_AVAILABILITY`).

### Precedence (encoded in `effectiveAvailability`, tested)

1. **Retired:** a `RETIRED` resource is never available.
2. **Per local date, per layer:** `DATE_CLOSED` > `DATE_OPEN` > `WEEKLY`. A layer with **no `WEEKLY` window at all** is treated as **unrestricted** on dates without an exception (see "Unrestricted is not guaranteed" below).
3. **Effective availability** = resource layer ∩ competition-wide layer. This is the competition restriction, e.g. 08:00–22:00 ∩ 10:00–18:00.
4. **Blackouts:** minus every `BLACKOUT` / `MAINTENANCE`, resource-level and competition-wide.

**Lifecycle is not availability.** An ACTIVE resource with a maintenance blackout stays ACTIVE.

### Unrestricted is not guaranteed

When a resource, or the competition, has **no weekly window at all**, 05E-A returns it as **unrestricted**: no availability constraint has been declared, so none is applied. This is the only meaning of an "available" answer in that case.

- **What it does not say:** it is **not** a statement of guaranteed operational availability. Nobody has confirmed the facility is open, staffed or usable at those times; the system has only found nothing that restricts it.
- **Why this default:** a newly created resource is not artificially unusable, and a competition that declares no restriction restricts nothing. The answer stays deterministic either way.
- **Later phases decide whether that is enough:** 05E-B, 05E-C and 05E-E may require **explicitly configured operational availability** — at least one declared window for the resource (and/or competition) over the period being scheduled — when their scheduling rules determine it is necessary, and refuse or flag scheduling on an unrestricted resource. That requirement belongs to those phases (e.g. as SchedulingProfile data or a schedule-validation rule).
- **What 05E-A already gives them:** the declared facts are available to tell "unrestricted" from "declared open" (`GET …/availability?resource=` lists them; a layer with zero `WEEKLY` facts is unrestricted on every date that has no `DATE_OPEN` / `DATE_CLOSED` exception).
- **What 05E-A does not do:** add any scheduler behaviour, and the domain semantics above are unchanged.

## 3. Time model and timezones

- **Instants:** stored as UTC (`timestamptz`). Received instants must carry an explicit offset (`instantOrThrow`); `2026-11-16T15:00:00` without an offset is refused.
- **Local rules:** stored as wall-clock text (`HH:MM`) and dates, never pre-converted.
- **Zone resolution:**
  - A resource's zone is its own `timezone` when declared, otherwise the competition's zone (inherited explicitly, `NULL` = inherit, not copied).
  - Competition-wide rules use the competition zone.
- **Allowed zone names:** IANA `Area/Location` names or `UTC` only, confirmed by the runtime database. Abbreviations (`CST`, `EST`), bare offsets and unknown names are refused. The competition's own zone keeps its existing BRT-05 validator.
- **DST rules (ADR-0068):**
  - **Recurring rules:** a skipped local boundary moves forward by the gap; a repeated one takes the earlier occurrence. For example, 02:30 on 2026-03-08 in New York → 03:30 EDT.
  - **One-off local input** (`resolveStrict`): a skipped time is refused (`LOCAL_TIME_SKIPPED`); a repeated time is refused (`LOCAL_TIME_AMBIGUOUS`) unless an offset selects one occurrence (`OFFSET_MISMATCH` if it matches neither). The resolver ships now for 05E-C/G; no 05E-A endpoint takes one-off local times.

## 4. API (`apps/api/src/v1-competition.ts`)

| Route | Gate | Purpose |
|---|---|---|
| `GET /v1/competitions/:competitionId/resources` | COMP_VIEW_PRIVATE | Current resources |
| `POST /v1/competitions/:competitionId/resources` | COMP_EDIT, idempotent | Create (`typeCode`, `label`, `attributes`, `capacity`, `exclusivityKeys`, venue, location, `timezone`) |
| `GET /v1/resources/:resourceId` | COMP_VIEW_PRIVATE | Current revision + full revision history |
| `PUT /v1/resources/:resourceId` | COMP_EDIT, idempotent | New revision (type immutable) |
| `POST /v1/resources/:resourceId/retire` · `/reactivate` | COMP_EDIT, idempotent, reason | Lifecycle |
| `GET /v1/competitions/:competitionId/availability?resource=` | COMP_VIEW_PRIVATE | Current facts (a resource's plus the competition-wide ones) |
| `POST /v1/competitions/:competitionId/availability` | COMP_EDIT, idempotent | Add a fact (`resourceId` or `null` for competition-wide) |
| `POST /v1/availability/:availabilityId/revoke` | COMP_EDIT, idempotent, reason | Revoke a fact |
| `GET /v1/resources/:resourceId/availability?from=&to=` | COMP_VIEW_PRIVATE | Effective intervals (≤ 400 days) |
| `GET /v1/resources/:resourceId/availability/check?start=&end=` | COMP_VIEW_PRIVATE | `{available, gaps}`: resource availability only |

- **No occupancy, reservation, booking or schedule route exists**; an inventory test proves it.
- **Query values** are strings (no type coercion on this API).

## 5. Permissions

| Action | Permission | Roles |
|---|---|---|
| Configure resources and availability | `COMP_EDIT` | OWNER, ADMIN |
| Read | `COMP_VIEW_PRIVATE` | All competition staff |

- **No new permission.** SCHEDULER (`COMP_MANAGE_SCHEDULE`) and REGISTRATION_MANAGER can read but not configure, and tests prove both.
- **Scope is server-side.** Every operation resolves the competition from the database: a resource id sent under another competition is NOT_FOUND, and the database also refuses a cross-competition fact (BR006 trigger).
- **Terminal competitions:** COMPLETED and CANCELLED competitions are read-only.

## 6. Persistence (`0035`)

| Object | Purpose |
|---|---|
| `competition.resource` | Identity: competition, `type_code` (CHECK = catalog vocabulary), creator. The type never changes |
| `competition.resource_revision` | Append-only revisions: label, attributes (jsonb ≤ 2 KB), capacity 1–100 000, `exclusivity_keys text[]` (≤ 8, pattern-checked), venue organization, location label, timezone (`NULL` = inherit), status ACTIVE / RETIRED + reason, actor |
| `competition.v_resource_current` | Latest revision per resource |
| `competition.resource_availability` | Append-only facts; a per-kind shape CHECK keeps local rules as wall-clock and periods as instants + reason; `resource_id NULL` = competition-wide |
| `competition.resource_availability_revocation` | One revocation per fact (PK), with reason and actor |
| `competition.v_resource_availability_current` | Facts not revoked |

**Database integrity:**
- append-only, no-truncate and `recorded_at` triggers on all four tables;
- a same-competition trigger on availability;
- grants: `br_competition` SELECT and INSERT only; `br_rebuild` SELECT.

**Indexes:**

| Index | Why |
|---|---|
| `resource_competition_idx` | Every scheduling read starts from "this competition's resources" |
| `resource_revision_current_idx` | `(resource_id, seq DESC)` for the current-revision view |
| `resource_availability_resource_idx` | Facts per resource plus the competition layer |
| `resource_availability_period_idx` | Partial, blackout/maintenance by `(resource_id, starts_at, ends_at)`: 05E-D/E will ask "which periods touch this window" for many resources |

**Rollback:** migrations are forward-only in this repository. 0035 is purely additive, and no existing table, view or route changed. `contest_schedule` and `POST /v1/contests/:id/schedule` are untouched (05E-C).

## 7. Auditability

Every change writes `platform.audit_event` (actor, action, target, details) and an outbox event, in the same transaction:

| Change | Audit action | Event |
|---|---|---|
| Create | `resource.created` | `ResourceCreated` |
| Revise | `resource.revised` (+ changed field names) | `ResourceRevised` |
| Retire / reactivate | `resource.retired` / `resource.reactivated` (+ reason in the revision) | `ResourceRetired` / `ResourceReactivated` |
| Add availability | `availability.added` | `AvailabilityAdded` |
| Revoke availability | `availability.revoked` (+ reason in the revocation) | `AvailabilityRevoked` |

The revision and fact tables themselves are the history: who, when, what, why.

## 8. Tests

| Suite | Count | Covers |
|---|---|---|
| `competition/src/resources/resources.test.ts` | 24 | Interval semantics (J/K); Costa Rica; New York normal / spring-forward / fall-back / explicit offsets / weekly rule across DST / window spanning the gap; IANA validation; matrix A–I; no-rule default; midnight crossing; 24:00; 14-day interval; whole-window blackout; overlapping open exceptions; validation; eight sports; capacity; exclusivity keys |
| `persistence/src/oncf05e-a.int.test.ts` | 10 | Eight sports through one API; validation; revisions, lifecycle, reasons, reuse of a retired label; append-only enforcement; idempotent retry; precedence through the store; DST zone and per-resource zone; duplicates, revocation, domain validation; scheduler and registration manager can't configure; cross-organization denial (read, revise, check, attach); database cross-competition refusal; cancelled competition is read-only |
| `apps/api/src/oncf05e-a.int.test.ts` | 2 | Full lifecycle over HTTP with every refusal (stranger, other organizer, scheduler, bad type, zone, capacity, missing offset, unknown fact field, empty reason); idempotent retry 201 → 200; route inventory (no occupancy or schedule surface) |

## 9. Known limitations

- **Recurring rules** are weekly windows plus date exceptions. Anything richer (e.g. "every other Tuesday") needs an ADR (ADR-0068 alternative).
- **Golf course detail:** hole-by-hole par and stroke index are not resource attributes yet. They still travel on the scorecard (05C); moving them to the resource is a future step.
- **Venue:** a venue is an optional organization plus label. There is no facility hierarchy (ADR-0067).
- **Capacity meaning:** a capacity unit has no meaning until SchedulingProfile requirements declare it (05E-B).
- **Unrestricted ≠ operationally confirmed:** a resource without declared windows evaluates as unrestricted, not as confirmed open. Requiring explicit operational availability is left to the scheduling phases (§2).
- **Not here:** availability does not consider schedules, participants or dependencies (05E-C/D).
