# ONCF-05E-B — SchedulingProfile v1

| | |
|---|---|
| Branch | local, uncommitted; on top of `f685984` (`main`, ONCF-05E-B-0 + web typecheck fix) |
| Contract | [ONCF-05E architecture](./ONCF-05E-ARCHITECTURE.md) (frozen) · [ADR-0069](../adr/ADR-0069-scheduling-profile-is-a-versioned-axis.md) · [ADR-0072](../adr/ADR-0072-scheduling-profile-spec-v1.md) (spec v1, frozen; unchanged by this phase) |
| Migration | `0036_oncf05e_b_scheduling_profile.sql` (additive; 0001–0035 untouched) |
| Not in this phase | schedule versions, assignments, publication (05E-C) · conflict engine (05E-D) · proposal engine (05E-E) · operations API (05E-F) · organizer scheduling UI (05E-G) · public schedule (05E-H) |

**What this phase answers.** HOW a contest is operationally scheduled, as reusable, versioned catalog data:
- expected duration;
- changeover;
- start spacing and concurrent starts;
- rest;
- dependency lead;
- daily limits;
- post-cut regrouping;
- the resource type a contest needs and what it consumes of that resource's capacity.

**What this phase does not answer.** It never says WHEN or WHERE a contest happens: nothing here assigns a resource or an instant, checks a conflict or proposes a schedule.

## 1. Domain model (`@br/competition`, `src/scheduling/`)

| Module | Content |
|---|---|
| `profile.ts` | `SchedulingProfileSpec` v1, its selector and requirement types, `validateSchedulingProfileSpec`, `canonicalSchedulingProfileSpec`, `schedulingProfileSpecHash`, `resolveRequirement`, `schedulingProfileCompatibility`, `producedContestTypes` |
| `templates.ts` | `SCHEDULING_PROFILE_TEMPLATES`: the canonical catalog templates (data, each with a basis) |

The spec is exactly ADR-0072 §7, with no additional fields:

```ts
SchedulingProfileSpec {
  specVersion: 1;                                  // the spec's SHAPE
  requirements: SchedulingRequirement[];           // 1–32, exactly one default
  regrouping?: { groupSize: 1–64; order: FIELD_ORDINAL_ASC | FIELD_ORDINAL_DESC };
}
SchedulingRequirement {
  selector: { contestType?; roundType?; stagePrimitive? };   // 05B vocabulary only; {} = default
  resourceType: ResourceType;                       // catalog vocabulary (05B/05E-A); one resource per unit
  capacityUnit: CONTEST | ENTRANT;
  expectedDurationSeconds: 1–86 400;                // from EACH start to that start's finish
  changeoverSeconds: 0–86 400;
  startSpacingSeconds?: 1–86 400;                   // shared-capacity resources
  concurrentStarts?: 1–64 (default 1);
  rest?: { minimumSeconds: 0–604 800; enforcement: HARD | SOFT };
  dependencyLeadSeconds?: 0–604 800;
  maxUnitsPerEntrantPerDay?: { value: 1–100; enforcement: HARD | SOFT };
}
```

- **Durations are integer seconds.** Fractions, strings, milliseconds and negative values are refused. Each field has a closed upper bound; a single unit never spans more than a day.
- **Typed validation at the boundary.** Every spec is validated before it is hashed, stored, published or pinned. Unknown keys are refused, never stripped (`requiredCapacity`, `quantity`, `sessions` included).
- **Generic only.** Validation covers types, signs, bounds, closed keys and selector uniqueness. Feasibility against a concrete resource (e.g. spacing versus capacity) is left to 05E-D/E, as ADR-0072 §7 freezes.
- **Scheduling unit.**
  - The unit is one contest by default.
  - Where a stage's logistic partition is `GROUPED_ENTRANTS` (tee groups, bowling squads), the contests sharing a partition key within a round form one unit.
  - That grouping is 05B plan data, consumed by later engines. It is **not** a profile field, and no per-sport unit type exists.
- **Hard/soft.** `rest` and `maxUnitsPerEntrantPerDay` carry `HARD | SOFT` enforcement, which feeds ADR-0071's conflict split later.

### Selectors and precedence (ADR-0072 §6)

| Rule | Implementation |
|---|---|
| Exactly one default (empty selector) | Validation refuses 0 or ≥ 2 defaults |
| Valid dimensions only | `contestType` (ContestType), `roundType` (RoundType), `stagePrimitive` (StagePrimitive). Anything else is refused (e.g. `sport`) |
| Most specific wins | `resolveRequirement` picks the matching requirement with the most specified fields. A contest without a stage primitive (v1 plan) never matches a stage-primitive selector |
| Equal specificity is invalid | Two requirements with the same number of fields that **some** contest could match together are refused. They overlap when no dimension is specified by both with different values. The refusal holds even if a more specific requirement covers the intersection: there is no hidden tie-break |
| Order independence | Resolution never consults position. An unvalidated tie returns `AMBIGUOUS` with the indexes and is never broken by order |

### Capacity units (ADR-0072 §8)

The **resource** holds the capacity value (05E-A). The requirement only declares what one unit consumes:

| Unit | Consumption | Examples |
|---|---|---|
| `CONTEST` | 1 per scheduled contest | Courts, a pool booked for heats, a stepladder match on a lane pair |
| `ENTRANT` | 1 per entrant of the unit | Runners on a course, players on a golf course, bowlers per lane pair |

There is no `requiredCapacity`, no quantity, and no exclusivity field in the profile:
- resource identity, capacity values, attributes and exclusivity keys stay on the resource;
- opening hours, exceptions and blackouts stay in availability.

ADR-0072 fixes "one resource per unit", so v1 has no quantity field.

## 2. Versioning, canonicalization and hashing

| Concept | Where | Meaning |
|---|---|---|
| `specVersion` (spec) / `spec_version` (column) | Spec and version row | The **shape** of the spec (v1). The database checks that the column equals `spec.specVersion` |
| `version` | `sports.scheduling_profile_version` | The catalog **content** version under a profile code (1, 2, …) |
| `spec_hash` | Version row | `catalogSpecHash('br:scheduling-profile-spec', canonical spec)` (ADR-0072 §1) |

The profile reuses the existing catalog-kind infrastructure; there is no parallel versioning system. It is a fourth kind (`'scheduling-profile'`) in `CatalogStore`'s scoring-kind table, and gets the following from it:
- the code, immutable versions and basis;
- the DRAFT → PUBLISHED → RETIRED status facts;
- idempotency, audit and outbox events;
- lookup-first provisioning.

**Canonical form** (`canonicalSchedulingProfileSpec`; the stored spec *is* the canonical form):

| Property | How it is made canonical |
|---|---|
| Requirement order | Content-derived order: specificity, then each dimension's value. Never declaration or database order; the default is always first |
| Optional values | Absent optional values are omitted |
| `concurrentStarts` | The default is made explicit (absent ≡ 1) |
| Property order | Irrelevant (JCS) |

Equivalent specs therefore have one hash. An invalid spec cannot be canonicalized or hashed at all.

| Proof (domain tests) | Result |
|---|---|
| Equivalent objects / reversed property order | Same canonical form, same hash |
| Every permutation of the requirements (property test) | Same canonical form, same hash |
| Changed duration, changeover, resource type, capacity unit, selector, rest, regrouping | Eight distinct hashes, all different from the original |
| Ambiguous profile | `canonicalSchedulingProfileSpec` / `schedulingProfileSpecHash` throw; creation is refused (`INVALID_INPUT`) |

## 3. Publication and immutability

- **Lifecycle:** DRAFT → PUBLISHED → RETIRED, as append-only status facts; `br_catalog` (operator) is the only writer.
- **Creation** validates the spec and refuses an invalid one before any write.
- **Publication** re-validates the *stored* spec and re-derives its hash, so a row written behind the store (e.g. an ambiguous spec inserted by the owner) cannot be published.
- **Only PUBLISHED versions** are listed (`GET /v1/catalog`), served (`GET /v1/catalog/scheduling-profiles/:id`) and pinnable. DRAFT and RETIRED versions return 404 and refuse a pin.
- **Retiring** a version leaves existing pins pointing at their exact version id; only new pins are refused.
- **Database immutability:**
  - `reject_mutation` triggers refuse UPDATE, DELETE and TRUNCATE on all three tables;
  - `UNIQUE (profile_id, version)` fixes version identity;
  - `UNIQUE (profile_id, spec_hash)` makes identical content one version (re-sending a reordered spec is `ALREADY_EXISTS`);
  - CHECKs constrain the spec shape, size, requirement count and hash format;
  - the application role cannot write the catalog at all.
- **A semantic change is a new version.** Provisioning that finds different content under an existing code reports a conflict and never edits a version.

## 4. Provisioning

`CatalogManifest.schedulingProfiles` (version histories, oldest first) is applied lookup-first by `CatalogStore.provision`. `CANONICAL_CATALOG` carries `SCHEDULING_PROFILE_TEMPLATES`, so `pnpm db:catalog:provision` provisions them with the rest of the catalog:
- a re-run is `UNCHANGED`;
- drift is a conflict (exit code 2).

**Canonical templates.** No governing body fixes slot lengths, changeovers or rest for these shapes, so every basis is COMMON_PRACTICE with a note.

| Code | Requirements (selector → resource · unit · key values) |
|---|---|
| `tennis-court-match` | default → TENNIS_COURT · CONTEST · 5 400 s, changeover 600, rest 3 600 SOFT, lead 900, ≤ 2/day SOFT |
| `padel-court-match` | default → PADEL_COURT · CONTEST · 5 400 s, changeover 600, rest 3 600 SOFT, lead 900, ≤ 3/day SOFT |
| `road-course-waves` | default → ROAD_COURSE · ENTRANT · occupancy 21 600 s, **wave spacing 900 s**, 1/day HARD |
| `pool-heats` | default → POOL · CONTEST · heat 300 s, changeover 60, rest 1 800 SOFT, lead 1 800 |
| `cycling-course-stage` | default → CYCLING_COURSE · ENTRANT · 18 000 s, changeover 1 800, spacing 300, 1/day HARD · `{contestType: SESSION}` → 3 600 s per rider, changeover 900, 1/day HARD |
| `bowling-lane-pair-blocks` | default → BOWLING_LANE_PAIR · ENTRANT · block 9 000 s, changeover 900, rest 1 800 SOFT · `{contestType: MATCH}` → CONTEST · 1 200 s, changeover 300, lead 300 |
| `basketball-court-game` | default → BASKETBALL_COURT · CONTEST · 7 200 s, changeover 900, rest 10 800 SOFT, lead 1 800, 1/day SOFT |
| `basketball-half-court-3x3` | default → BASKETBALL_HALF_COURT · CONTEST · 1 500 s, changeover 300, rest 1 200 SOFT |
| `golf-course-tee-groups` | default → GOLF_COURSE · ENTRANT · round 14 400 s, **spacing 600 s**, 2 concurrent starts, 1/day HARD · `{contestType: MATCH}` → 14 400 s, spacing 600, lead 1 800, ≤ 2/day SOFT · regrouping {3, FIELD_ORDINAL_DESC} |

No discipline, sport or format was added to the catalog for this phase.

## 5. Event pinning and field lock

- **The pin is a reference, never a copy.** It is a nullable `scheduling_profile_version_id` column on `competition.event_scoring`, set through the existing scoring pin (ADR-0072 §3):
  - `PUT /v1/events/:eventId/scoring` with `schedulingProfileVersionId`;
  - `ScoringStore.pinScoring`.
- **No separate scheduling lifecycle.** A new pin is a new append-only row, so re-pinning or unpinning before lock leaves history. `v_event_scoring_current` exposes the column.
- **Authority** is the existing `COMP_EDIT` (OWNER, ADMIN):
  - SCHEDULER and REGISTRATION_MANAGER, non-members and other organizations get 403;
  - reads use the existing `COMP_VIEW_PRIVATE` (`GET /v1/events/:eventId/scoring` returns `schedulingProfile`).
- **Before field lock** (DRAFT, REGISTRATION_OPEN, REGISTRATION_CLOSED): editable, exactly like the other axes.
- **After field lock:** frozen.
  - The store refuses with `INVALID_TRANSITION` (409).
  - **The database also refuses** a row that changes the profile pin once the event is past REGISTRATION_CLOSED (trigger `event_scoring_scheduling_profile_pin`, BR006). The same trigger refuses a pin of a non-PUBLISHED version.
- **No per-event overrides.** The event uses the version exactly as published (ADR-0072 §3).

## 6. Compatibility (pin time; ADR-0069 §4, ADR-0072 §6)

`schedulingProfileCompatibility(spec, providedCapabilities(discipline), producedContestTypes(engine, allowedContestTypes))` uses data only:

1. **The spec is valid.** It is re-validated at pin time, and the stored hash must re-derive.
2. **Resource types:** every requirement's resource type is one the discipline declares in `capabilities.resourceTypes`.
   - A v1 discipline declares none, so it can never pin a profile.
   - Otherwise the result is `CAPABILITY_MISMATCH` (400, the message names the missing type, never the sport).
3. **Format coverage:** every contest type the FormatVersion's engine produces for the discipline resolves to a requirement. With exactly one default this always holds, so the check is the fail-closed guard ADR-0072 asks for, not a second rule.

- **Ruleset.** ADR-0069/0072 define no ruleset ↔ profile relationship: playing time is not an operational slot length, and durations are never derived from the ruleset. No ruleset compatibility check exists, by design.
- **Catalog read.** `GET /v1/catalog` adds `compatibleSchedulingProfileVersionIds` per discipline version (rule 2).

## 7. API (`apps/api/src/v1-competition.ts`)

| Route | Gate | Change |
|---|---|---|
| `GET /v1/catalog` | PUBLIC | + `schedulingProfileVersions` (PUBLISHED only), + per-discipline `compatibleSchedulingProfileVersionIds` |
| `GET /v1/catalog/scheduling-profiles/:versionId` | PUBLIC | **New.** One PUBLISHED version (`versionId, code, name, version, specVersion, specHash, spec, basis`); 404 otherwise |
| `PUT /v1/events/:eventId/scoring` | COMP_EDIT (store) | + optional `schedulingProfileVersionId` (uuid or null) |
| `GET /v1/events/:eventId/scoring` | COMP_VIEW_PRIVATE (store) | + `schedulingProfile` |

- **No profile write route.** Profiles are provisioned by the operator (`br_catalog`); organizers cannot author, copy or edit them (ADR-0072 §2).
- **No scheduling surface.** There is no schedule generation, resource assignment, conflict, proposal or optimization route. An inventory test proves it.

## 8. Web

- **No scheduling UI.** The organizer Structure page's existing Scoring form re-sends the whole pin, so it now carries the pinned profile id in a hidden field. Without it, changing the ruleset there would silently unpin the profile.
- **Read-only display.** The Scoring panel shows the pinned profile (name, version, basis) when one is set.
- **Selection comes later.** Choosing a profile in the UI is left to the scheduling UX (05E-G); pinning is API-level now.
- **Fresh checkout.** No dependency on generated files (`next-env.d.ts`, `.next`) was introduced, and `pnpm typecheck` passes for `apps/web`.

## 9. Sport proof (domain and persistence tests)

One spec type and one store pin every category. Only values differ.

| Sport | Proven |
|---|---|
| Tennis | TENNIS_COURT · CONTEST (sequential on an exclusive court; no shared-capacity spacing) · match duration · changeover · soft rest |
| Padel | PADEL_COURT · CONTEST · doubles (participation is the discipline's, `lineupSize 2`) · duration · changeover · rest |
| Running / marathon | ROAD_COURSE · ENTRANT. **Course occupancy (`expectedDurationSeconds` 21 600) and wave spacing (`startSpacingSeconds` 900) are independent:** changing either leaves the other unchanged, and all three variants hash differently. Wave size stays the format's |
| Swimming | **POOL is the resource; lanes are plan slots.** No lane resource type exists, the spec has no lane concept, and the unit is CONTEST (one heat at a time). Heat duration and changeover are declared; spacing on an exclusive pool is occupancy + changeover (ADR-0072 §7), so no `startSpacingSeconds` is set |
| Cycling | CYCLING_COURSE · ENTRANT · stage duration · start spacing · `{contestType: SESSION}` for time trials. Per-rider interval starts stay the plan's `startOffsetSeconds` |
| Ten-pin bowling | BOWLING_LANE_PAIR. The **grouped squad block** is ENTRANT with a 9 000 s block; the squad itself is the plan's GROUPED_ENTRANTS partition, with no grouping field in the profile. The **stepladder match** is `{contestType: MATCH}` → CONTEST. There is no bowling-specific engine |
| Basketball | BASKETBALL_COURT · CONTEST · game duration · changeover · team rest |
| Wheelchair basketball | Pins **the same `basketball-court-game` version** as 5v5 (asserted equal). Its classification-points constraint stays in the discipline |
| Golf | GOLF_COURSE · ENTRANT · tee groups (plan) · 2 concurrent starts · regrouping after a cut. **Round duration (14 400 s) and start spacing (600 s) are independent:** each changes alone, and all three hash differently |
| 3x3 (also covered) | BASKETBALL_HALF_COURT profile; the full-court profile is refused for 3x3 (capability mismatch) |

## 10. Persistence (`0036`)

| Object | Purpose |
|---|---|
| `sports.scheduling_profile` | Code (kebab), name, creator |
| `sports.scheduling_profile_version` | `version`, `spec_version` (= 1, = `spec.specVersion`), canonical `spec` (≤ 16 KB, 1–32 requirements), `spec_hash`, `basis`; unique version and unique content per profile |
| `sports.scheduling_profile_version_status_change` (+ `v_scheduling_profile_version_current`) | Append-only DRAFT / PUBLISHED / RETIRED |
| `competition.event_scoring.scheduling_profile_version_id` | The pin (FK); the view is recreated |
| `competition.assert_event_scheduling_profile_pin()` | Pin integrity: PUBLISHED only; frozen after field lock |

- **Grants:** `br_catalog` SELECT and INSERT; `br_competition`, `br_public_read` and `br_rebuild` SELECT.
- **Events:** `SchedulingProfileVersionCreated / Published / Retired` (aggregate `SCHEDULING_PROFILE_VERSION`). `EventScoringPinned` gains `schedulingProfileVersionId`.
- **Rollback:** forward-only like every migration here. 0036 is additive.

## 11. Tests

| Suite | Count | Covers |
|---|---|---|
| `competition/src/scheduling/scheduling-profile.test.ts` | 32 | Validation (schemaVersion, closed keys, integer seconds, bounds, capacity units, regrouping) · selector matrix A–J (incl. permutation property tests) · canonicalization / hashing 1–7 · compatibility (match, mismatch, v1, coverage, every sport's design format) · sport proof incl. the golf, running, swimming and bowling critical tests · source contains no sport identity |
| `persistence/src/oncf05e-b.int.test.ts` | 11 | Canonical storage and hash · schemaVersion vs version · DRAFT → PUBLISHED → RETIRED (listing, serving, pinning; DB refuses a DRAFT pin) · DB immutability (UPDATE / DELETE / TRUNCATE; app role cannot write) · content uniqueness incl. reordered selectors · invalid profiles refused at creation and at publish (incl. an owner-inserted ambiguous row) · provisioning re-run and drift conflict · nine proof categories pinned · reference-only, append-only pin history · capability mismatch and v1 refusal · COMP_EDIT vs SCHEDULER / REGISTRATION_MANAGER / non-member / other organization · freeze at field lock (store and DB) |
| `apps/api/src/oncf05e-b.int.test.ts` | 3 | Catalog listing and per-discipline compatibility, single-version read (published 200, draft / unknown 404, bad id 400) · pin over HTTP in DRAFT and REGISTRATION_OPEN, incompatibility 400, unpublished 400, scheduler / stranger / other organizer 403, field lock 409 with the pin preserved · route inventory (no schedule-generation surface) |

## 12. Boundaries and out of scope

| Owner | Keeps |
|---|---|
| Format (05B) | Structure, rounds, groups, waves, heats, tee groups, squads, interval offsets and lanes |
| Ruleset (05C) | Scoring and playing time |
| Advancement (05D) | Feeders, cuts and occupants. The profile only adds `dependencyLeadSeconds` timing and the ordering-only `regrouping` |
| Resources (05E-A) | Identity, capacity values, attributes and exclusivity |
| Availability (05E-A) | Windows and zones |

**Explicitly not implemented:**
- schedules, assignments, time slots, calendars;
- overlap, resource, capacity or availability collision checks;
- conflict resolution, proposals, optimization or backtracking;
- schedule publication;
- organizer scheduling screens;
- organizer-authored or event-overridden profiles (would need a new ADR).
