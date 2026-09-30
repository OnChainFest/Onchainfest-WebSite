# BRT-08 — Holders and Crediting

| Field | Value |
|---|---|
| Accepted sources | BRT-01 [verification model §8.1](../domain/BRT-01-VERIFICATION-MODEL.md) (`holder`, `memberCredits[]`), invariant **AC-5**, [padel walkthrough §6](../examples/BRT-01-PADEL-WALKTHROUGH.md), [ADR-0026](../adr/ADR-0026-declared-lineups-are-operational.md) |
| Code | `packages/achievements/src/engine.ts` (holder resolution), `packages/persistence/src/achievement-store.ts` (`validateCandidate`), `achievement.member_credit`, `achievement_read.athlete_achievement` |

## 1. Holder kinds

| Holder | Used when |
|---|---|
| **ATHLETE** | the sporting recognition itself is individual: an INDIVIDUAL participant's title, placement, contest win or completion; an athlete's own performance (threshold, personal best); individual americano classifications |
| **TEAM** | the recognition belongs to a TEAM participant: a pair or team title, placement, win or completion; a team-level performance with no athlete |

The durable public identity is the Athlete or Team id. It is never an Account, a Person or a Participant: the Participant appears only as a basis reference. BRT-01 also lists `PARTICIPANT` as a holder type; BRT-08 never produces it.

## 2. TEAM Achievement = ONE canonical fact + immutable `memberCredits`

This follows BRT-01 §8.1, AC-5 and padel §6: *"One team achievement plus two member credits, **not** three separate achievements."*

```
Achievement { achievementType: TITLE,
              holder: { holderType: TEAM, holderId: team_p7 },
              memberCredits: [ { athleteId: ath_lucia, creditRole: LINEUP_MEMBER },
                               { athleteId: ath_marco, creditRole: LINEUP_MEMBER } ],   ← immutable, sorted, hashed
              basis: [ { resultVersionId, contentHash, verificationRunId, …, participantId: par_p7,
                         creditedLineupHash: H(rv, par_p7, [ath_lucia, ath_marco]) } ] }
```

- **Where credits come from:** exactly the **credited lineup of the basis ResultVersion**, which is Result content under ADR-0026. Credits are never taken from:
  - current or historical Team membership;
  - the roster;
  - the Team manager;
  - the organizer;
  - registration state;
  - the BRT-05 *declared* lineup (`competition.lineup`).
- **Immutability:** credits are canonical, sorted, part of the candidate hash, and stored in the append-only `achievement.member_credit` table. The trigger requires each credit to be an element of the candidate, and a deferred check requires all of them.
- **Identity:** the basis item carries `creditedLineupHash`, so a different credited lineup is a different logical Achievement. It is never a mutation.
- **No lineup:** without a credited lineup (production today: no Result-content lineup producer), the TEAM Achievement carries **no** credits (`memberCreditBasis: CREDITED_LINEUP_UNAVAILABLE`). Athlete credit fails closed; the TEAM recognition remains derivable when the Team participant itself is unambiguous.
- **No derivation group:** none is needed, because one TEAM Achievement *is* the recognition.

**Natural identity (AC-2):** the key is (TITLE, rule version, TEAM holder, scope, basis). Twenty concurrent derivations give **1 TEAM Achievement + 2 member credits + 1 basis item**, tested in the fixture persistence lane and in demo Part C.

## 3. Athlete performances inside a team entry

A Performance with an `athleteId` under a TEAM participant credits that athlete (ATHLETE holder) **only** if the athlete is in the exact credited lineup of that participant for that version. Otherwise the reason is `PERFORMANCE_ATHLETE_NOT_CREDITED` or `CREDITED_LINEUP_UNAVAILABLE`, and nothing is issued. An INDIVIDUAL participant's performance must name that participant's athlete, if it names one at all (`PERFORMANCE_ATHLETE_MISMATCH`).

## 4. Athlete Passport presentation (projection, not duplicates)

`achievement_read.athlete_achievement(athlete_id, achievement_id, credit_type)` has one row per athlete an Achievement is shown to:

- `HOLDER`: the ATHLETE holder;
- `TEAM_MEMBER`: each immutable member credit of a TEAM Achievement. The row references the **canonical TEAM Achievement**; no athlete copy exists.

For example, Lucía's Passport shows "Club Open 2026 — Mixed A Champions" with `creditType: TEAM_MEMBER`, and the item links to the TEAM Achievement. The public API never implies that the athlete is the holder: `holder.holderType` is `TEAM` and credited athletes appear under `memberCredits`.

Athlete display follows the Passport privacy policy. Only PUBLIC, unrestricted, ACTIVE passports are named; otherwise the athlete shows as "Private entrant", with no id.

## 5. Corrections of credits

When a corrected ResultVersion changes the credited lineup:

- the old TEAM Achievement stays immutable ("under ResultVersion V1, these athletes were credited");
- the new version derives a **new** TEAM Achievement with the corrected credits and a supersession link;
- the old one becomes SUPERSEDED.

If the holder no longer qualifies at all, the old one becomes REVOKED. The old credits are never edited (tested: `corrected lineup` fixture test).

## 6. Tests

| Case | Expectation |
|---|---|
| title fixture: Pair A rank 1, Pair B rank 2, lineup A1 / A2 | 1 TEAM Achievement for Pair A; credits A1, A2; never Pair B, the unused roster member, or former / future members or managers (who are not in the snapshot at all); no ATHLETE copies |
| Passport | the A1 and A2 projections show the TEAM title; the unused roster athlete shows nothing |
| concurrency | 20× → 1 Achievement, 2 credits |
| no lineup | TEAM only, no credits |
| changed lineup | different content and a different identity |
