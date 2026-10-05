# BRT-01 Walkthrough B — Padel Tournament

| Field | Value |
|---|---|
| Ticket | BRT-01 |
| Purpose | Validate the canonical model on a head-to-head, pair-based, multi-stage sport |
| Legacy sources (read-only) | `../padelflow/public/mvp/app.js` L293–393 (format configuration vocabulary), `../padelflow/lib/ipfs/metadata.ts` (trophy attributes) |
| Legacy caveat | BRT-00 found **no padel match or score engine** anywhere. Legacy padel is configuration only: americano points, round-robin groups/qualifiers, best-of-N sets, super tie-break. This walkthrough therefore uses legacy *vocabulary* on an illustrative tournament. |

All identifiers, athletes and values below are illustrative.

---

## 1. Ontology

```
Sport:       padel
Discipline:  padel.doubles
DisciplineVersion: padel.doubles@1
  Outcome model: WIN_LOSS (DRAW only in formats that allow it, e.g. americano timed matches)
  Metrics:
    padel.match.sets        INTEGER, sets, HIGHER_IS_BETTER
    padel.match.games       INTEGER, games, HIGHER_IS_BETTER            (tie-break key in group tables)
    padel.americano.points  INTEGER, pts, HIGHER_IS_BETTER              (americano only)
  Result schema (MATCH):
    entries[].components = { sets: [ {games: int, tiebreak?: int} ], superTiebreak?: int }
    validation: a set is won 6–≤4, 7–5 or 7–6 (with tiebreak points); best-of-N per format params;
                the super tie-break (to 10, win by 2) replaces the deciding set when enabled   ← legacy option
  Primary evidence types: OFFICIAL_REPORT (referee app entry / scorecard), SIGNED_SCORESHEET, VIDEO
  Official evidence set:  one of { referee OFFICIAL_REPORT, SIGNED_SCORESHEET signed by both pairs }
FormatTemplates (vocabulary from legacy wizard):
  padel.groups_then_knockout@1   params {groups: 4, teamsPerGroup: 4, qualifiersPerGroup: 2, matchFormat: best_of_3, superTiebreak: true}
  padel.knockout@1               params {drawSize: 8..64}
  padel.americano@1              params {players: 16, matchMinutes: 20, points: {win: 3, draw: 1, loss: 0}}  ← legacy defaults
```

---

## 2. Structure: groups then knockout

```
Competition cmp_open_2026         "Club Open 2026"   organizer: org_club_x   (sanctioned? see §6)
 └─ Event evt_mixed_a             discipline padel.doubles@1, category {gender: MIXED, level: A}
      format padel.groups_then_knockout@1 (16 pairs, 4 groups, top-2 qualify)
      ├─ Round rnd_grp_A .. rnd_grp_D   GROUP       (6 MATCH contests each)
      ├─ Round rnd_qf                   KNOCKOUT    (4 MATCH contests; slots seeded from group classifications)
      ├─ Round rnd_sf                   KNOCKOUT
      └─ Round rnd_final                FINAL
```

**Participants (pairs):**

- `par_p7` has `kind = TEAM` and `teamId = team_p7`. That is an **ad-hoc Team** (the pair) with members `[ath_lucia, ath_marco]`.
- The Team is an identity that can persist across tournaments. If the same pair enters again, the same `teamId` is reused, so the pair itself can accumulate history.
- `par_p3` is `team_p3` with members `[ath_sofia, ath_diego]`.

**Contest:** `ctt_qf_2` has `contestType = MATCH`, with Contestants `{par_p7, side A}` and `{par_p3, side B}`, and court 2.

---

## 3. The match result

```
Result res_qf_2   scope: CONTEST, target: ctt_qf_2
ResultVersion rv_qf_2_v1
  status: SUBMITTED → PROVISIONAL → OFFICIAL → FINAL
  content:
    entries: [
      { participantId: par_p7, outcome: WIN,  components: { sets: [{games:6},{games:3}], superTiebreak: 10 },
        primaryMark: {padel.match.sets, 2},
        advancement: { toRoundId: rnd_sf, toContestId: ctt_sf_1, slot: A } },
      { participantId: par_p3, outcome: LOSS, components: { sets: [{games:4},{games:6}], superTiebreak: 8 },
        primaryMark: {padel.match.sets, 1} } ]
    lineups: [ {participantId: par_p7, athletes: [ath_lucia, ath_marco]},
               {participantId: par_p3, athletes: [ath_sofia, ath_diego]} ]
    incidents?: [ … optional point-level or code-violation incidents … ]
  contentHash: h(rv_qf_2_v1)
```

**How the score validates.** The discipline schema checks the score:

- 6–4 is a valid set; 3–6 is a valid set.
- The third set is replaced by a super tie-break, and 10–8 is valid (to 10, win by 2).
- The validated result is 2 sets to 1 for side A.

The core never saw the word "set". It only stored a schema-validated `components` object.

---

## 4. Evidence, attestation and authority

**Authority** (unsanctioned club event, platform-anchored):

```
Platform anchor (padel, GLOBAL, PLATFORM)
  └─ g_clubx → org_club_x {ACCEPT_RESULT, DECLARE_OFFICIAL, CORRECT_RESULT, ADJUDICATE_DISPUTE, GRANT_AUTHORITY; scope: competition=cmp_open_2026}
        ├─ g_ref_r → person_referee_r  {ATTEST_RESULT, ACCEPT_RESULT, SUBMIT_RESULT; scope: event=evt_mixed_a, round ∈ {rnd_qf, rnd_sf, rnd_final}}
        └─ g_desk  → person_desk_d     {ACCEPT_RESULT, SUBMIT_RESULT; scope: event=evt_mixed_a, rounds=groups}
```

**Scoping.** `person_referee_r` **cannot** attest anything in another tournament, or even in this event's group stage: rule 4 of authority evaluation (verification model §4.5).

| Step | Actor (role) | Action | Evidence |
|---|---|---|---|
| 1 | Lucía (PARTICIPANT, side A) | Drafts and submits rv_qf_2_v1 (T1/T2) | `ev_card_qf2`: a photo of the scorecard |
| 2 | Sofía (OPPONENT, side B) | `RESULT_ACCURATE` AFFIRM on rv_qf_2_v1 | — |
| 3 | The event's auto-accept rule "both sides confirm" | T3 → PROVISIONAL. **Advancement applies:** `par_p7` is seeded into `ctt_sf_1` slot A. | — |
| 4 | Referee R (OFFICIAL) | `RESULT_ACCURATE` AFFIRM + `RESULT_OFFICIAL` (T5) | `ev_ref_report_qf2`: the referee app report (OFFICIAL_REPORT) |
| 5 | System | Under this competition's *illustrative* policy, the QF protest window closes when `ctt_sf_1` starts → T6 FINAL | — |

**Protest-window policy (illustrative).** "A bracket match's protest window closes when the next dependent contest starts" is a **competition policy chosen for this example**. It is not a platform or domain rule. The core supports configurable windows and closing conditions (result domain §5.1); another competition could use a fixed duration or explicit closure instead.

**Verification progression:**

| After step | Level | Reason |
|---|---|---|
| 1 | V0 | Submitter only |
| 2 | V1 | The opponent (independent of the submitter) corroborates |
| 4 | **V2** | Primary evidence (OFFICIAL_REPORT); a scoped, non-conflicted official declared it official; valid chain Platform → org_club_x → referee |

**What if the losing pair disagrees?**

- Sofía issues a `RESULT_ACCURATE` **DENY** instead of step 2. The result stays V0 with the `CONTRADICTING_ATTESTATION` flag.
- The event policy "both sides confirm" does not auto-accept.
- The desk or referee accepts manually (T3) after checking the scorecard. Under this example's policy, Sofía may file an ORDINARY dispute before the semi-final starts. An admitted dispute places a **hold**, which blocks T5/T6 and every achievement.
- **Operational note.** Whether the semi-final may start while a QF dispute is open is a *competition rule*. The model provides the hold signal; the Competition Engine enforces the rule ([ADR-0008](../adr/ADR-0008-operational-progression-decoupled-from-verification.md)).

---

## 5. Classifications and advancement

**Group tables.** Each group gets a **ROUND_CLASSIFICATION** Result:

- `derivedFrom` the 6 group match versions;
- comparator from the FormatTemplate: `wins desc → set difference desc → game difference desc → head-to-head`.

**Seeding.** The knockout seeding (group winners vs runners-up) is the FormatTemplate's advancement rule. It is applied operationally on PROVISIONAL group classifications, which in turn require all 6 group matches to be PROVISIONAL.

**Event classification.** The **EVENT_CLASSIFICATION** Result ranks the final winner 1st and the loser 2nd. Both losing semi-finalists are ranked 3rd (shared) unless a bronze match is configured. It is `derivedFrom` the final and semi-final versions. R-6 requires those to be OFFICIAL before the classification is OFFICIAL, and FINAL before it is FINAL.

---

## 6. Achievements

| Achievement | Holder | Basis | Level / status | Notes |
|---|---|---|---|---|
| `CONTEST_WON` (QF) | `team_p7`; member credits: Lucía, Marco (via Lineup) | rv_qf_2_v1 | V2 + FINAL | One team achievement plus two member credits, **not** three separate achievements. AC-5. |
| `TITLE` "Club Open 2026 — Mixed A Champions" | `team_p7`; member credits | FINAL event classification | V2 + FINAL | Credited to each athlete's passport through `memberCredits` |
| `PLACEMENT` (runner-up, 3rd) | Respective teams | Event classification | V2 + FINAL | |
| `EVENT_COMPLETED` | All 16 pairs | Event classification | V1 + OFFICIAL | |

**Legacy caveat.** The legacy trophy metadata had a `Partner` attribute (`../padelflow/lib/ipfs/metadata.ts`). In the new model, partner identity comes from `memberCredits` and the Lineup, not from a free-text field.

**What V3 would require.** Suppose a national padel federation is a trust anchor and sanctions the event (`COMPETITION_SANCTIONED`), and the referees' grants chain from the federation (Federation → org_club_x → referee) instead of from the platform anchor. Add check-in `IDENTITY_CONFIRMED` for all athletes, and results reach **V3**. Titles and ranking points in the federation's ranking then become permissible.

---

## 7. Variant: americano (individual rotation)

In an americano, athletes rotate partners every match. Each athlete accumulates **individual** points: 3 for a win, 1 for a draw, 0 for a loss (legacy defaults), over timed matches (20 min).

- **Participants** are `kind = INDIVIDUAL`, one per athlete.
- **Each Contest** is a MATCH whose two Contestant slots are **temporary pairs**. The rotation is generated by the FormatTemplate. The Lineup records which two individual Participants formed each side.
- **ResultEntry is per participant (4 per match).** The entries for both athletes on the winning side each get `outcome: WIN` and `components: {gamesFor, gamesAgainst}`. Timed matches allow `DRAW`.
- **The round/event classification** ranks individuals by `padel.americano.points` (then games difference), derived from all match versions.

**No model change was needed.** The difference between pair events and individual americano is entirely in `Participant.kind`, the FormatTemplate and the Discipline comparator.

---

## 8. Correction scenario (bracket already advanced)

1. After the semi-final has started, the desk notices that the QF score was typed with sides swapped.
2. Under this competition's illustrative policy, the ORDINARY protest window for the QF closed at SF start. Only a `LATE` ruling by an authority with elevated capability is possible, and the model requires the authority to choose a sporting remedy.
3. **If the error is clerical and the winner does not change** (e.g. the games were mistyped but P7 still won):
   - a `CLERICAL` correction creates rv_qf_2_v2, which supersedes v1;
   - `CONTEST_WON` is reissued with `supersedes` (continuity);
   - the bracket is unaffected.
4. **If the winner would change:** the authority must rule. Options include voiding the SF (a revocation of that contest's result) and ordering a replay. Each step is an attested correction or revocation, and the downstream impact report lists affected achievements. Prize entitlements, if any, stay `HELD`, because nothing pays before the event classification is FINAL (disputes doc §5.5–5.6).

---

## 9. Conclusion

Padel (pairs, sets, super tie-break, groups → knockout, americano rotation) fits the **same** canonical entities as bowling:

- **Contest `MATCH`** instead of `SERIES`;
- **`WIN_LOSS`** outcomes instead of `RANKED`;
- **schema-typed `components`** instead of games arrays;
- **TEAM participants** with Lineups instead of individuals.

No padel-specific field entered the core.
