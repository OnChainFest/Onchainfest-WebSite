# ONCF-05B — Competition domain model for the eight canonical sports

| | |
|---|---|
| Branch | `feat/oncf-01-auth-wiring` (local, uncommitted; on top of `7bff8e0`, ONCF-04) |
| Design | [ONCF-05A](../architecture/ONCF-05A-SPORTS-AND-COMPETITION-ENGINE.md) (approved; wheelchair basketball confirmed as basketball modality 3) |
| ADRs | [0053](../adr/ADR-0053-capability-driven-compatibility-no-sport-branching.md) capabilities · [0054](../adr/ADR-0054-stage-graph-plans-and-field-entries.md) stage graphs · [0055](../adr/ADR-0055-logistic-vs-competitive-partitions.md) partitions · [0056](../adr/ADR-0056-declared-entry-attributes.md) entry attributes · [0057](../adr/ADR-0057-roster-snapshot-at-field-lock.md) roster snapshot · [0058](../adr/ADR-0058-seeding-v2.md) seeding v2 · [0059](../adr/ADR-0059-ruleset-is-a-versioned-axis.md) ruleset axis · [0060](../adr/ADR-0060-classification-policy-v2-vocabulary.md) classification v2 · [0061](../adr/ADR-0061-discipline-granularity.md) discipline granularity |
| Migration | `0032_oncf05b_stage_graphs.sql` (additive; 0001–0031 untouched) |
| Out of scope (by design) | Score validation and classification computation (05C); result entry, timing import, advancement (05D); scheduling and resources (05E); any non-canonical sport |

**What this slice delivers.**

- The competition **domain model for all eight sports**: tennis, padel, running, swimming, cycling, bowling, basketball and golf.
- The domain model covers:
  - 24 modalities;
  - 24 formats;
  - the full 72-cell capability matrix, computed from catalog data.
- **Executable structure** (field lock → seeding → immutable plan → public structure) for the six proof cases A–F.

**Binding rule.** No engine, store or UI branches on sport identity. Sports are versioned data, capabilities and parameters (ADR-0053).

## 1. Domain model (`@br/competition`, `@br/rankings`, `@br/schemas`)

| Piece | File | What it is |
|---|---|---|
| Capabilities | `competition/src/capabilities.ts` | `providedCapabilities(dv)` (v2 declared; v1 derived conservatively), `engineRequirements(engine)`, `capabilityIssues()`; vocabularies for start methods, partition kinds, resource types and entry-attribute value types |
| DisciplineVersion spec v2 | `competition/src/catalog.ts` | `specVersion: 2` + `capabilities` + `entryAttributes` + participation `roster` / `lineupOrdered` / `onCourt` / `substitution` / `composition` / `lineupConstraint`. v2-only keys are refused in v1 specs, so v1 spec hashes are unchanged |
| Ruleset vocabulary | `competition/src/ruleset.ts` | 10 sport-neutral families with closed, bounded parameters, plus 18 templates, each labelled GOVERNING_RULE (source) or COMMON_PRACTICE. **Validation only** (executed in 05C) |
| ClassificationPolicy v2 vocabulary | `rankings/src/classification-policy-v2.ts` | STANDINGS and METRIC families, terminal-rule requirement, and 11 cited templates (`itf_rr`, `fip_groups`, `fiba_5x5`, `fiba_3x3`, `ibf_bowling_rr`, `road_race`, `swim_time`, `golf_stroke`, `golf_stableford`, `bowling_pinfall`, `cycling_gc`). **Validation only** (engine in 05C; ADR-0047 unchanged) |
| Plan v2 | `competition/src/format/plan-v2.ts` | Stages, transitions, rounds with stage/group/dynamic entry, contests with partition, slots with stage/group/transition sources, field entries |
| Stage primitives | `competition/src/format/stages.ts` | KNOCKOUT (byes, third place, stepladder), ROUND_ROBIN (even groups, serpentine, two-entrant double round robin, crossover entrants), FIELD (blocks, entries, start offsets), HEATS (circle / zigzag composition, centre-out lanes) |
| Format engines | `competition/src/format/engines-v2.ts` | 11 capability-declaring engines (§2) |
| Seeding v2 | `competition/src/seeding.ts` | `computeSeeding()`: MANUAL, DETERMINISTIC_DRAW, RANKED_THEN_DRAWN (banded), BY_ENTRY_ATTRIBUTE; sources; overrides; exact decimal comparison |
| v2 documents | `schemas/src/competition-v2.ts`, `format/registry.ts` | `br:competition-field@2`, `-seeding@2`, `-plan-input@2`, `-plan@2` (fields up to 20,000). v1 schemas and golden vectors are untouched |
| Canonical catalog | `competition/src/catalog-manifest.ts` | 8 sports, 21 disciplines (24 modalities via categories), version histories, 11 format templates, and `CANONICAL_DESIGN_MATRIX` (8 × 3 × 3) |

## 2. Format engines (sport-neutral templates)

| Engine | Primitive graph | Requires (ADR-0053) | Used by (design matrix) |
|---|---|---|---|
| `single-elimination/2` | KNOCKOUT (explicit draw size, third place) | MATCH | tennis, padel, basketball |
| `round-robin/2` | ROUND_ROBIN (1..n competitive groups) | MATCH, COMPETITIVE | tennis, padel, basketball, bowling match play |
| `groups-knockout/1` | ROUND_ROBIN → RANK_FROM_GROUP (+ best-ranked) → KNOCKOUT | MATCH, COMPETITIVE | tennis RR → KO, padel, basketball pools → KO |
| `mass-start/1` | FIELD (one start; entries) | HEAT, SINGLE_START | running, cycling, open water |
| `wave-start/1` | FIELD (logistic waves) | HEAT, WAVE_START, LOGISTIC | running |
| `timed-finals/1` | FIELD (logistic lane heats) | HEAT, LANE_HEATS, LOGISTIC, `entryTimeMs` | swimming |
| `heats-final/1` | HEATS → QUALIFY_BY_PLACE_AND_TIME → FIELD final | HEAT, LANE_HEATS, COMPETITIVE, `entryTimeMs` | running track/relay, swimming |
| `interval-start/1` | FIELD (start offsets) | SESSION, INTERVAL_START | cycling ITT |
| `multi-round/1` | FIELD × k rounds (+ CUT / ELIMINATE_NON_FINISHERS → dynamic rounds) | SERIES\|HEAT\|SESSION, multi-round | cycling GC, bowling aggregate, golf leaderboard |
| `stableford/1` | as multi-round | SERIES, STABLEFORD family | golf |
| `qualifying-knockout/1` | FIELD qualifying → STEPLADDER \| RANK_TO_BRACKET → KNOCKOUT | SERIES + MATCH | bowling, golf match play |

`single-elimination/1` and `round-robin/1` are unchanged and remain pinnable. The provisioner adds v2 as a later version in their history.

## 3. Persistence (migration `0032`)

- **New append-only tables** (recorded_at = transaction time; append-only even for the owner; `br_competition` SELECT/INSERT; `br_rebuild` SELECT):
  - `stage`
  - `stage_transition`
  - `contest_entry`
  - `registration_entry_attribute`, with the view `v_registration_entry_attribute_current`
  - `participant_entry_attribute`
  - `participant_roster_member`
- **New nullable columns:**
  - `round.stage_id`, `round.group_key`, `round.dynamic_transition_key`;
  - `contest.partition_key`;
  - `contestant.source_stage_id`, `contestant.source_group_key`, `contestant.source_ordinal`, `contestant.source_transition_id`;
  - `lineup_member.ordinal`.
- **Version columns:** `event_field.field_version`, `event_seeding.seeding_version` and `event_seeding.seeding_document`, `event_plan.plan_version`.
- **Relaxed and extended CHECKs:**
  - contestant source kinds;
  - seeding methods and draw seed;
  - seeding version ⇔ document.

  The same-event trigger covers stages, transitions and entries.
- **Store paths** (`competition-structure-store.ts` + `competition-structure-v2.ts`):
  - `lockField`: a v2 discipline snapshots rosters (bounded by `roster`) and the current declared attributes; `FIELD_INCOMPLETE` refuses the lock.
  - `seedField`: v2 when a v2 feature is requested or the field is v2.
  - `generatePlan`: v2 engines are capability-checked and materialized with bulk entry inserts.
  - `submitLineup`: v2 fields use the frozen roster; ordered lineups store each member's ordinal.
  - New commands and reads: `declareEntryAttributes`, `entryAttributes`, `readiness`, `lockedField`, `previewPlan`.
- **Unchanged v1 paths.** Every v1 path produces the exact BRT-05 documents and hashes (tested).
- **Catalog:**
  - `createEvent` and `GET /v1/catalog` use the capability rule. v1 engines keep the BRT-05 error message.
  - The provisioner walks version histories: existing versions must belong to the history, and missing later versions are created and published deliberately.
  - The dev seed adds `running.5k` (dev-only) to the canonical `running` sport.
- **Teams:**
  - `TeamStore.myTeams` and `myMemberships` (reads).
  - A v2 team registration needs `roster.min` ACTIVE members.
- **Read models:**
  - `round_card` gains its stage, group and dynamic transition.
  - `contest_card` gains its partition, entry count and entries (ids only).
  - A rebuild reproduces them identically (tested).

## 4. API (`apps/api/src/v1-competition.ts`)

| Route | Class | Purpose |
|---|---|---|
| `POST /v1/events/:id/seed` | COMP_STAFF | + `RANKED_THEN_DRAWN` / `BY_ENTRY_ATTRIBUTE`, `seeds`, `banded`, `attributeKey`, `direction`, `source`, `overrides` |
| `GET /v1/events/:id/readiness` | COMP_STAFF | Derived checklist (blockers / warnings); no lifecycle change |
| `GET /v1/events/:id/field` | COMP_STAFF | Locked field with seed, roster size and frozen declared attributes (roster-rule naming) |
| `GET /v1/events/:id/plan-preview` | COMP_STAFF | Pure preview of the plan the pinned engine would generate; nothing persisted |
| `GET`/`POST /v1/registrations/:id/entry-attributes` | SELF (entrant or staff) | Declared entry attributes before the lock (Idempotency-Key on POST) |
| `GET /v1/me/teams`, `GET /v1/me/team-memberships` | AUTHENTICATED | Team reads for pair / squad entry |
| `GET …/bracket` (public) | PUBLIC | + stage, group, dynamic entry, partition, field entries, v2 slot kinds. **Declared values are never published** |

## 5. Web

Every page is driven by catalog data and API responses: roster, entry attributes and capabilities. No page branches on sport.

| Surface | Route | What it does |
|---|---|---|
| **Structure** (organizer) | `/app/orgs/[slug]/tournaments/[competitionId]/categories/[eventId]/structure` | Readiness checklist; lock the field (COMP_LOCK_FIELD); seed it (COMP_GENERATE_STRUCTURE); locked-field table; plan preview; generate the plan (see below) |
| **Teams** | `/app/teams` (nav "Teams") | Teams I manage with member consent status; create a pair or squad; invite by athlete address (resolved through the public passport); accept or decline pending invitations; safe `next=` back to a registration |
| **Team entry** | `/app/register/[slug]/[eventSlug]` | TEAM categories open the flow: pick one of my teams. Teams outside the discipline roster bounds are shown disabled. The existing `registerAction` takes an athlete or a team |
| **Entry details** | athlete registration page; organizer registration detail | Declared values per the discipline (durations typed as m:ss.hh, sent as ms; MEMBER values per member for the team manager). Declarable until the field locks; organizer read-only. Always labelled "Declared · not verified" |
| **Public category page** | `/competitions/[slug]/events/[eventSlug]` | Rounds grouped under their stage (ranked within groups vs across them); partition chips (wave / heat / start group / group); field entries (first 50, then "and N more") with start offsets; dependencies read as "Group A · 1st", "Best 3rd #1", "Qualifier #3"; dynamic rounds say "Field set after the previous round's results". v1 rendering is unchanged |

**The Structure page's controls:**

- **Seeding** offers three methods:
  - random draw;
  - seeds then draw: a seed number per participant, banded or not;
  - by a declared value: the discipline's numeric per-entrant attributes, lowest or highest first.

  The form also takes a declared source label and date, plus up to three overrides, each with a reason.
- **Locked-field table:** seed, entrant (or "Private entrant" / team name), roster size, declared values.
- **Plan preview:** stages, rounds and contests; dynamic rounds are labelled.
- **Generate** requires an explicit "this is permanent" confirmation, then links to the public page. The category page's Lifecycle panel links here from REGISTRATION_CLOSED onward.

**Web limitations:**

- Lanes and positions are shown as numbers, without lane-band labels.
- Organizers read declared values but do not edit them.
- Staff see member-scope values as "Member n", because there is no team-member read for staff.

## 6. Proof cases (structure, ONCF-05B)

| Case | Proven by | What is asserted |
|---|---|---|
| A — tennis singles, single elimination | `oncf05b.test.ts`, `oncf05b.int.test.ts` | A 24-entrant draw in a 32 bracket gives 8 banded seeds byes and 23 matches; third place; draw-size guard; v1 events unchanged |
| B — padel doubles, groups → knockout | both | Pair entrants; rosters frozen (16 rows); COMPETITIVE groups; RANK_FROM_STAGE slots with stage and group; 1A–2B crossover; two-pair groups play twice |
| C — running road race, wave start | both + API | 150 (unit: 2,500) entrants in LOGISTIC waves via `contest_entry`; attributes frozen at lock; refused after lock |
| D — swimming individual, heats → final | both + API | Entry-time seeding; lanes 4,5,3,6,2,7,1,8; ≥ 3 in heat 1; 8 QUALIFIER final slots; values private |
| E — golf stroke play, multi-round + cut | both | Tee groups (LOGISTIC, GROUPED_ENTRANTS); rounds 3–4 dynamic on CUT t1 (top N and ties); stage races eliminate non-finishers |
| F — basketball 3x3, pools → knockout | both | 20 teams → 4 pools → QF/SF/3rd/F; roster 3–4 frozen; a late member is refused in lineups; out-of-bounds roster refuses the lock |

## 7. Tests

- **Unit:**
  - `packages/competition/src/oncf05b.test.ts` (41): the catalog; the 72-cell matrix (61 ✓ / the 11 approved ✘, each explained by a capability); every engine's plan canonicalizes as `br:competition-plan@2` and is deterministic; proof cases A–F; seeding; rulesets.
  - `packages/rankings/src/classification-policy-v2.test.ts` (3).
  - Updated: `catalog-manifest.test.ts` (version histories), `competition.test.ts` (registry now has `single-elimination/2`).
- **Integration:**
  - `packages/persistence/src/oncf05b.int.test.ts` (12): A–F through the stores; v1 invariance; seeding overrides hashed and audited; capability refusal at `createEvent`; read-model rebuild; append-only.
  - `catalog-provisioning.int.test.ts`: the eight-sport canonical catalog; upgrade from an ONCF-03A catalog without conflicts.
  - `apps/api/src/oncf05b.int.test.ts` (2): entry attributes and seeding v2 over HTTP; team reads and pair registration.
- **Web:** `app/_tests/structure-teams.test.tsx` (26 new) plus the updated registration tests. Web total: 219/219. `next build` succeeds.

## 8. Known limitations and deliberate deviations

- **Rulesets and ClassificationPolicy v2** are vocabulary and validation only. Pinning, score validation and classification computation are ONCF-05C.
- **No resolution yet.** Dependent slots, transitions and dynamic rounds stay unresolved until advancement (ONCF-05D).
- **Track lanes.** Lanes in `heats-final/1` heats are assigned centre-out by rank in every round. World Athletics draws round-1 lanes by lot (TR 20). That deviation is accepted until a lane-draw policy exists.
- **Band draws.** Within-band seed draws and the unseeded draw shuffle their own sorted subsets with the same persisted seed (`br-draw/1`). This is reproducible but does not use independent streams (provably fair draws remain future work).
- **Later rounds.** Per-entrant contests after round 1 carry no tee group or squad. Grouping later rounds (often by score) is a scheduling decision (ONCF-05E).
- **Withdrawals.** Field entries never block a contest start; a withdrawn entrant in a mass field is a non-starter.
- **Lineup constraint.** The wheelchair `lineupConstraint` (Σ classification points ≤ 14.0) and `onCourt` are recorded, not validated.
- **Roster amendments** after the lock (late signings, injury replacements) have no command yet.
- **Entry-attribute declarations** are audited (keys only), with no outbox event.
- **Scale.** Very large per-entrant fields (SERIES contests) materialize one contest per entrant per round; tested at golf scale (144 × 2).
