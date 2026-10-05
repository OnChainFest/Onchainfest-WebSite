# BRT-07 — Participation, Independence and Conflicts

| Field | Value |
|---|---|
| ADR | [0034](../adr/ADR-0034-conservative-independence-and-structural-participation.md) |
| Code | `packages/verification/src/assemble.ts` (`ParticipationIndex`), `packages/verification/src/criteria.ts` (V1 / V4 grouping), `packages/persistence/src/verification-loader.ts` (`loadRawParticipation`) |

## 1. The participation resolver

A deterministic resolver over **existing canonical facts** — not a second source of truth, not a stored projection: it is recomputed inside every snapshot from class-A rows known at the cutoff.

| Input (ids and times only) | Source |
|---|---|
| Contest slots (participant or unresolved dependency) | `competition.contestant` |
| Participants (INDIVIDUAL athlete / TEAM) | `competition.participant` |
| Athlete → Person | `identity.athlete` |
| Team memberships, with their first ACTIVE time | `competition.team_membership` + status changes |
| Team managers; team affiliation label | `competition.team_manager`, `competition.team.organization_id` |
| Declared lineups for this contest | `competition.lineup` / `lineup_member` |
| Guardians of participating persons, with their full status history and `effective_from` | `identity.guardian_relationship` + status changes |
| Person ↔ PERSON Principal (explicit, never `Person.id`) | `identity.person_principal` |
| Organization ↔ ORGANIZATION Principal | `organizations.organization_principal` |
| Organizer organization; its OWNER/ADMIN persons | `competition.competition`, `organizations.membership` |
| Operational competition staff (full ACTIVE / ENDED history) | `competition.competition_staff` + status changes |
| Contest occurrence (first IN_PROGRESS / COMPLETED) | `competition.contest_status_change` |

No name, profile, slug, contact, date of birth, vault, wallet, external identity or auth-identity table is read (`br_verification` has no grant on any of them — tested).

It answers, as known at the cutoff: which PERSON principal corresponds to an athlete participant; which principals are on each participant's side; whether an issuer's person is a participant, a member of a participating team, a declared lineup member, a team manager or a guardian; whether an issuer organization organizes the competition or labels a participating team; whether an issuer person is an organizer admin or competition staff; and whether participation is unknown (unmapped principal) or incomplete (unresolved contest slot).

Relations (`ParticipationRelation`): `SELF_PARTICIPANT`, `TEAM_MEMBER_OF_PARTICIPANT`, `LINEUP_MEMBER_OF_PARTICIPANT`, `TEAM_MANAGER_OF_PARTICIPANT`, `GUARDIAN_OF_PARTICIPANT`, `TEAM_AFFILIATED_ORGANIZATION` (side relations, carrying a participant id), `ORGANIZER_ORGANIZATION`, `ORGANIZER_ORGANIZATION_ADMIN`, `COMPETITION_STAFF`.

**Relations are facts; they do not disqualify by themselves.** The conflict rule decides ([authority §4](./BRT-07-AUTHORITY-EVALUATION.md#4-conflict-of-interest)), and independence rules decide what counts for V1 / V4.

### Temporal slicing (BRT-07R)

Relations are evaluated **at the sporting occurrence** of the contest, using only facts known at the cutoff (a status fact recorded after `asOf` does not exist for that evaluation, so a historical replay never uses later knowledge). Status times are the platform's transaction times.

**Occurrence window W = [from, to]:**

- `from` is the first `IN_PROGRESS` contest status fact known at the cutoff. If there is none, it is unknown.
- `to` is the earlier of the first `COMPLETED` fact and the ResultVersion's `submittedAt`, because a result cannot describe play that had not happened yet.
- Classification scopes have no contest facts: `from` is unknown and `to` is the submission time.
- A `from` later than `to` is contradictory. It is treated as unknown, never clamped.
- W is recorded in the snapshot as `participation.occurrenceWindow`.

| Relation | Time it is judged at | Source of the interval |
|---|---|---|
| `SELF_PARTICIPANT` (direct Participant) | **STRUCTURAL**: timeless for this subject | `participant` |
| `LINEUP_MEMBER_OF_PARTICIPANT` | **STRUCTURAL**: the exact lineup declared for *this* contest, which takes precedence (a lineup member of P is never re-judged by membership in P's team) | `lineup`, `lineup_member` |
| `TEAM_AFFILIATED_ORGANIZATION`, `ORGANIZER_ORGANIZATION` | **STRUCTURAL** (team / competition attribute) | `team.organization_id`, `competition` |
| `TEAM_MEMBER_OF_PARTICIPANT` | W | `[ACTIVE, ENDED/DECLINED)` membership status facts |
| `TEAM_MANAGER_OF_PARTICIPANT` | W | `[recorded_at, ∞)` (no end fact exists) |
| `GUARDIAN_OF_PARTICIPANT` | W, combined with the dependent's own relation | `[max(ACTIVE, effective_from), REVOKED/ENDED)` |
| `ORGANIZER_ORGANIZATION_ADMIN` | W | OWNER/ADMIN membership `[ACTIVE, SUSPENDED/ENDED/DECLINED)` |
| `COMPETITION_STAFF` | W | `[ACTIVE, ENDED)` staff status facts |
| Person ↔ Principal, Organization ↔ Principal | identity bindings known at the cutoff (never `Person.id == Principal.id`) | `person_principal`, `organization_principal` |
| Key trust and sporting authority | the attestation's `issuedAt` (unchanged) | keys, grants, anchors |
| Registered official (V1) | the attestation's `issuedAt` within the registration interval | `REGISTERED_OFFICIAL` (no producer) |

An interval `[s, e)` is classified against W as follows:

- **DURING_OCCURRENCE** when it certainly overlaps W (`s ≤ to` and `e > from`), even partially.
- **Dropped entirely** when it certainly misses W, because it began after the occurrence or ended before play began. The relation is not a relation at all.
- **UNDETERMINED** otherwise. An example is a membership that ended while the occurrence start is unknown.

A principal with any undetermined relation is `TEMPORALLY_UNDETERMINED`:

- It is never proven independent: V1 reports `PARTICIPATION_UNKNOWN` / `RELATION_TIME_UNDETERMINED`.
- It is never cleared: its conflict check is `UNAVAILABLE`.
- It is never treated as "conflicted forever": the undetermined relation does not place it on a side.
- **A certain prohibited relation still conflicts regardless.** A direct Participant, for example, is `CONFLICTED` even if another of its relations is undetermined.

**Resolution.** PLATFORM and SYSTEM principals are RESOLVED with no relations, because they can never be athletes or teams. A PERSON principal needs its explicit Person mapping, and an ORGANIZATION principal needs its organization mapping. Without the mapping it is UNRESOLVED. With the mapping, it is RESOLVED when every time-bounded relation is decided, and TEMPORALLY_UNDETERMINED otherwise.

## 2. Issuer independence (V1)

| Rule | Implementation |
|---|---|
| Two keys of one principal = one issuer | grouping by `issuerPrincipalId`, never by key |
| Many attestations of one principal = one issuer | same group; the trace lists every attestation id of the group |
| Submitter never corroborates itself | `SUBMITTER_SELF` |
| Submitter-side principal is not independent | any shared side (`SAME_SIDE_AS_SUBMITTER`) — teammates, lineup members, managers, guardians, affiliated organization |
| Counterparty counts | a side not shared with the submitter (`COUNTERPARTY`), only if the submitter's side is known |
| Non-participants count only as **registered officials** | a structural `REGISTERED_OFFICIAL` fact covering the hierarchy at `issuedAt`, on no side, conflict check CLEAR (`REGISTERED_OFFICIAL`). **No authority is consulted**: an `ATTEST_RESULT` grant never creates a registered official. No production producer exists, so production traces `NOT_SUPPORTED_REGISTERED_OFFICIAL` and such issuers are `NO_STANDING` |
| Unknown never counts | `PARTICIPATION_UNKNOWN`, `SUBMITTER_SIDE_UNKNOWN` → criterion `UNKNOWN` if unknowns could reach the minimum, else `FAIL` |
| Not inferred from | different keys, accounts, e-mails or evidence hashes |

Example trace (demo step 15):

```
A1 (athlete A, key 1) → principal PA → SUBMITTER_SELF
B1 (athlete B, key 1) → principal PB ┐
B2 (athlete B, key 2) → principal PB ┘→ COUNTERPARTY      independent issuer count = 1 (not 2)
```

## 3. Source independence (V4)

| Rule | Implementation |
|---|---|
| Derived / redacted / transformed / superseding copies are not new sources | each item maps to its lineage root (`provenanceRootId`, deterministic when several parents exist) |
| Same bytes ≠ same source; different item ≠ different source | identity is the root's stable **source principal**, not content hash or item id |
| Principals on one participant side are one source | side grouping (`SIDE:<participant>`) |
| Unknown provenance never counts | a root without source principal, or an unresolved principal → `UNKNOWN_PROVENANCE` |
| Generic machine derivation never counts | `AI_DERIVED` / `AI_PIPELINE` / AI or OCR generator → `GENERIC_MACHINE_DERIVED` |
| Provider identities | not invented: when future integrations supply durable provider identities they can refine this rule |

## 4. Disputes and contradictions

- A **dispute claim** is an active, key-trusted `RESULT_ACCURATE` / `DENY` (BRT-06: a DENY attestation is a dispute claim, not a Dispute entity — ADR-0007 is untouched). Dispute entities / holds have no producer; per BRT-01 §1.3 holds never change the level anyway.
- A counterparty DENY blocks V1 unless the same evaluation fully meets the V2 certification exception, meaning `OFFICIAL_DECLARATION` and `NO_AUTHORIZED_DENY` both pass. The trace says so explicitly ([ADR-0036](../adr/ADR-0036-counterparty-deny-outranked-only-by-certification.md)). an authorized non-participant DENY blocks V2; `NO_ACTIVE_DISPUTE` (policy-optional) blocks its level on any dispute claim. The public DTO shows only `activeDispute: true` — never the claims or their issuers.
- Conflicting claims are never resolved by timestamp, organization type or display label. Retraction (signed, BRT-06) and supersession make a claim stop counting in new evaluations; old runs are immutable (tested: dispute → V0, retraction → V1).
