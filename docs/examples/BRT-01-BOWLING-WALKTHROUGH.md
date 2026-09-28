# BRT-01 Walkthrough A — La Negrita Bowling

| Field | Value |
|---|---|
| Ticket | BRT-01 |
| Purpose | Validate the canonical model against the only real operated event found in BRT-00 |
| Legacy sources (read-only) | `../padelflow/scripts/create-results-system-fixed.sql`, `../padelflow/scripts/SETUP_SUPABASE_COMPLETE.sql`, `../padelflow/app/api/register-player/route.ts`, `../LaNegrita-db/README.md` |

All identifiers, athletes and values below are **illustrative**. No legacy data was read or copied; only the legacy *structures* are modelled.

---

## 1. What the legacy system actually had

| Legacy structure | Where | Meaning |
|---|---|---|
| Competition "Torneo La Negrita 2025", organizer "CRCC" | `SETUP_SUPABASE_COMPLETE.sql` L150–153 (seed); `../LaNegrita-db/README.md` | One tournament |
| Rounds `1 Ronda Clasificatoria`, `2–10 Llaves A…I` | `create-results-system-fixed.sql` L86–96 | A qualifying round followed by nine "llaves" stages |
| `player_series(player_id, round_id, series_number, game_1, game_2, game_3)`, with each game `0..300` and a generated `total_score` and `average_score` | same file, L17–42 | A **series** of 3 games per bowler per round; re-entries are possible via `series_number` |
| `player_standings` ordered by `average_score DESC, total_pins DESC, highest_series DESC` | same file, around L146 | Round standings comparator |
| Registration category flags: `handicap`, `senior`, `scratch`, `reenganche`, `marathon`, `desperate`; player `handicap_average` | `register-player/route.ts` L102–113, L140; `SETUP_SUPABASE_COMPLETE.sql` L62 | Divisions and side events; the handicap basis is the entering average |
| Achievements `PERFECT_GAME` (any game = 300) and `HIGH_SERIES` (`total_score > 250`) | `create-results-system-fixed.sql` around L161–201 | Hard-coded threshold triggers |
| Evidence | none | Scores were typed into an **unauthenticated** API (`../padelflow/app/api/results/add-series`) |

**Interpretation caveats.** The legacy code does not define these, so they are open questions (§9):

- whether "Llaves A–I" are sequential elimination stages or parallel flights;
- what `reenganche` (re-entry), `marathon` and `desperate` mean.

---

## 2. Ontology

```
Sport:       bowling
Discipline:  bowling.tenpin.singles
DisciplineVersion: bowling.tenpin.singles@1
  Metrics:
    bowling.game.pins        INTEGER, pins, 0..300, HIGHER_IS_BETTER
    bowling.series.pins      INTEGER, pins, HIGHER_IS_BETTER            (sum of games in a SERIES contest)
    bowling.series.hdcp_pins INTEGER, pins, HIGHER_IS_BETTER            (series + handicap × games; handicap events only)
    bowling.round.average    DECIMAL(2), pins, HIGHER_IS_BETTER
  Result schema (SERIES contest): entries[].components = { games: [int×N], handicapPerGame?: int }
                                  performances[] = one per game (ordinal 1..N), optional frames[]
  Comparator (round classification): average desc → total pins desc → highest series desc   ← legacy
  Primary evidence types: SCORING_SYSTEM_EXPORT, SIGNED_SCORESHEET
  Official evidence set:  SCORING_SYSTEM_EXPORT + SIGNED_SCORESHEET (or SIGNED_SCORESHEET alone if no scoring system — policy flag)
  Rule hooks: perfect_game = 300; high_series_threshold = <parameter; legacy value 250 — see §9>
FormatTemplate: bowling.qualifying_then_stages@1  (qualifying SERIES contests → ranked cut → stage rounds)
```

**Handicap.** The handicap formula (e.g. a percentage of the difference from a base) is a **DisciplineVersion or Event parameter**, not a column. The *basis*, the entering average, is a **Participant entry attribute** backed by evidence (§5).

---

## 3. Structure

```
Competition  cmp_lanegrita_2025      "Torneo La Negrita 2025"   organizer: org_crcc
 ├─ Event   evt_scratch              discipline bowling.tenpin.singles@1, category {handicapMode: SCRATCH}
 ├─ Event   evt_handicap             category {handicapMode: HANDICAP}, params {handicap formula}
 ├─ Event   evt_senior               category {ageGroup: SENIOR (threshold TBD), handicapMode: SCRATCH|HANDICAP?}
 └─ Event   evt_side_*               reenganche / marathon / desperate (definitions TBD)

Event evt_scratch
 ├─ Round rnd_q    QUALIFYING  "Ronda Clasificatoria"
 │    └─ Contest per bowler per series: ctt_q_<athlete>_s1 (SERIES, 3 games, lane pair 7–8)
 │                                       ctt_q_<athlete>_s2  (re-entry series, if category allows — R-8 exception)
 ├─ Round rnd_llave_a  "Llaves A"  … rnd_llave_i "Llaves I"
 └─ Results:
      contest results (one per SERIES contest)
      round classification for rnd_q (derivedFrom all rnd_q contest results)
      event classification (derivedFrom final round classification)
```

**Participants.** `par_…` references `athleteId`; entry attributes `{ handicapBasis: { average: 172, source: "league average 2024-25", evidenceRef: ev_avg_… }, categories: [...] }`.

**One athlete, several events.** A bowler registered for scratch and handicap is **one Athlete with a Participant in each Event**. The *same physical series* can count for both events: one Contest result, referenced by both events' round classifications. The Contest is owned by one Round (e.g. evt_scratch / rnd_q). The handicap Event declares, in its format parameters, that its qualifying classification *derives from* those contests (**cross-event derivation**, result domain §5.4). The legacy code handled this implicitly with category flags on the player row.

---

## 4. Result of one series

```
Result res_q_ana_s1   scope: CONTEST, target: ctt_q_ana_s1
ResultVersion rv_q_ana_s1_v1
  status: SUBMITTED → PROVISIONAL → OFFICIAL → FINAL
  content:
    entries: [{ participantId: par_ana_scratch, outcome: RANKED,
                primaryMark: {bowling.series.pins, 612},
                components: { games: [212, 300, 100] } }]
    performances: [
      { performanceId: perf_ana_g1, ordinal: 1, mark: {bowling.game.pins, 212} },
      { performanceId: perf_ana_g2, ordinal: 2, mark: {bowling.game.pins, 300} },
      { performanceId: perf_ana_g3, ordinal: 3, mark: {bowling.game.pins, 100} } ]
    conditions: { laneIds: ["L7","L8"], oilPattern?: "…" }
  contentHash: h(rv_q_ana_s1_v1)
```

**No PII.** The result contains no name; `par_ana_scratch` resolves to an athlete id.

**The handicap event** does not need a different contest. Its round classification derives `bowling.series.hdcp_pins` from the same contest result plus the participant's handicap basis, using the Event's handicap rule. The derivation rule is part of the classification version (`derivationRuleId`), so it is auditable.

---

## 5. Evidence

| Evidence | Type | Source | Class |
|---|---|---|---|
| `ev_lane7_export` | `SCORING_SYSTEM_EXPORT` (frame-by-frame file) | `SYSTEM` principal `sys_crcc_scoring_L7-8`, `DEVICE_KEY`-signed if the scoring system supports it; otherwise uploaded by the lane official | PLATFORM_PRIVATE (bytes); hash public |
| `ev_sheet_ana_s1` | `SIGNED_SCORESHEET` (photo) | Lane official uploads; the sheet carries the bowler's and scorer's signatures | PLATFORM_PRIVATE |
| `ev_avg_ana` | `DOCUMENT` (league average certificate) | Bowler or league | AUTHORITY_ONLY if it contains ID numbers; otherwise PLATFORM_PRIVATE |
| `ev_lane_cert` | `DOCUMENT` (lane certification) | Venue or federation | PUBLIC |

---

## 6. Attestations and authority

**Authority chain.** The platform anchor is `level=PLATFORM`. An accredited organizer is recognized under it. If a national bowling federation later becomes an anchor, the chain would root there instead, which enables V3.

```
Platform anchor (bowling, GLOBAL, PLATFORM)
  └─ grant g_crcc → org_crcc  {ACCEPT_RESULT, DECLARE_OFFICIAL, CORRECT_RESULT, GRANT_AUTHORITY, ADJUDICATE_DISPUTE; scope: competition=cmp_lanegrita_2025; depth 1}
        ├─ grant g_off1 → person_lane_official_1 {SUBMIT_RESULT, ATTEST_RESULT, ACCEPT_RESULT; scope: round=rnd_q; valid: tournament dates}
        └─ grant g_sys  → sys_crcc_scoring_L7-8  {ATTEST_RESULT; scope: competition=cmp_lanegrita_2025}
```

| # | Attestation | Issuer (role) | Subject | Evidence | Assurance |
|---|---|---|---|---|---|
| 1 | `RESULT_ACCURATE` AFFIRM | `sys_crcc_scoring_L7-8` (SYSTEM) | rv_q_ana_s1_v1 | ev_lane7_export | DEVICE_KEY |
| 2 | `RESULT_ACCURATE` AFFIRM | Ana (PARTICIPANT), signing the sheet digitally | rv_q_ana_s1_v1 | ev_sheet_ana_s1 | HOLDER_KEY or PLATFORM_WITNESSED |
| 3 | `RESULT_ACCEPTED` | lane official 1 (OFFICIAL) | rv_q_ana_s1_v1 | — | PLATFORM_WITNESSED |
| 4 | `RESULT_OFFICIAL` | org_crcc (ORGANIZER), declared when the round closes | rv_q_ana_s1_v1 | ev_sheet_ana_s1, ev_lane7_export | HOLDER_KEY |
| 5 | `ELIGIBILITY_CONFIRMED` (handicap basis 172 valid) | org_crcc | Participant entry par_ana_handicap | ev_avg_ana | HOLDER_KEY |

**Conflict of interest.** If the lane official were also bowling in the tournament, rule 7 of the authority evaluation would demote their attestations on *their own* contests to PARTICIPANT weight.

---

## 7. Verification

| Stage | Level | Why |
|---|---|---|
| After #1 only (system attestation) | V1 | Independent of the submitter (the submitter was the official, the attester the system); no DECLARE_OFFICIAL yet |
| After #4 | **V2 EVENT_CERTIFIED** | Primary evidence present (export and sheet), integrity checks pass, and there is a valid chain `Platform → org_crcc`, non-conflicted |
| V3? | Not reachable today | No sanctioning-body anchor. If a national federation anchor sanctions the competition (`COMPETITION_SANCTIONED`) and check-in `IDENTITY_CONFIRMED` exists, then V3 |
| V4? | Only for a record claim | Would need the lane certification (`CONDITIONS_COMPLIANT`), two independent primary sources (device-signed export **and** signed sheet), and a human ratification by the recognizing authority |

---

## 8. Achievements and records

| Achievement | Rule | Basis | Level needed | Result |
|---|---|---|---|---|
| `PERFORMANCE_THRESHOLD` "Perfect Game" | `bowling.perfect_game@1`: a Performance with `bowling.game.pins = 300` in a valid game | rv_q_ana_s1_v1 · perf_ana_g2 | V2 + FINAL | Issued to Ana; `qualifyingValue = 300`; `governingAuthority = org_crcc` |
| `EVENT_COMPLETED` | Classified in the event classification | event classification version | V1 + OFFICIAL | Issued |
| `TITLE` "Torneo La Negrita 2025 — Scratch Champion" | rank 1 in the evt_scratch classification | FINAL event classification version | V2 + FINAL | Issued to the winner. **It may not be named "National Champion"** (AC-4) |
| `HIGH_SERIES` | Parameterized threshold on `bowling.series.pins` | — | V2 | See §9: the legacy threshold (> 250 for 3 games) looks wrong, so this is a rule-parameter decision, not a model change |

**Records** (RecordCategory examples):

| Category | Population | Recognizing authority | Min level | Label allowed |
|---|---|---|---|---|
| `bowling.series.pins` / COMPETITION scope `cmp series: La Negrita` / SCRATCH | Bowlers in any La Negrita edition, scratch only (RC-4 excludes handicap totals) | org_crcc | V3 (matrix floor for COMPETITION scope; not reachable without a sanctioning anchor, see §7). The "V2 + platform review" alternative applies only to PLATFORM-scope categories. | "La Negrita tournament record" |
| `bowling.game.pins` / VENUE scope `CRCC lanes` | Games on CRCC lanes in certified conditions | venue operator (if granted `RATIFY_RECORD`) | V3 | "CRCC venue record" |
| `bowling.series.pins` / PERSONAL | Ana's own verified series | none | V2 + OFFICIAL | "Personal best" |
| National record | — | **Only a national bowling federation anchor** | V4 | "National record" (**not available** in the La Negrita setup) |

**A perfect game can never be improved**, so it is not a *record* in the comparative sense. It is a threshold achievement. A "first perfect game in La Negrita history" is a separate rule type (a first occurrence within a scope) that can be added later without model changes.

---

## 9. Findings and open items

1. **HIGH_SERIES threshold.** Legacy uses `total_score > 250` for a *3-game* series (`create-results-system-fixed.sql` around L182). That is an 83-pin average and is likely a bug: probably a per-game threshold, or a series threshold such as 700. In the new model this is a versioned rule parameter; the organizer must decide the value.
2. **Semantics to confirm with the organizer:**
   - the format of "Llaves A–I" (sequential stages, parallel flights, or bracket groups);
   - `reenganche` (re-entry rules: best series or cumulative?);
   - `marathon` and `desperate` (side-event definitions);
   - the senior age threshold and the handicap formula.
3. **Legacy data would be low-trust if imported.** Legacy scores were entered through an unauthenticated API with no evidence. Any import would be `HISTORICAL_ARCHIVE` / `MANUAL_ENTRY` evidence, with results at V0 or V1 unless the organizer re-attests them against paper scoresheets.
4. **Shared contests across events.** Scratch and handicap classifications derive from the same series results. The model supports this via `derivedFrom`, with no duplication.

**Conclusion.** Bowling fits the canonical model with **zero bowling-specific core fields**. All specifics live in DisciplineVersion metrics, the result schema, the comparator, the FormatTemplate, category constraints and rule hooks.
