# ADR-0064 — Official results and atomic corrections in the ResultLedger (T5, T7)

- **Status:** Proposed
- **Date:** 2026-10-08
- **Origin:** ONCF-05D (completes BRT-01 §7; `0003` reserved T5–T8 "for later migrations")

## Context

Advancement must consume only trustworthy outcomes. The ledger declared OFFICIAL, SUPERSEDED, the T5–T8 transitions and the `DECLARE_OFFICIAL` / `CORRECT_RESULT` capabilities, but implemented only T2–T4. Downstream engines (achievements, records, rankings) already model OFFICIAL, SUPERSEDED and `supersededByVersionId`.

## Decision

1. **T5 PROVISIONAL → OFFICIAL.** Authorized as `DECLARE_OFFICIAL` for the result's exact hierarchy path. The current version is unchanged.
2. **T7 → SUPERSEDED, only inside an atomic correction** (`ResultLedger.correct`), in one transaction:
   - The draft becomes a new version with `supersedes_version_id` = the CURRENT version (an optimistic check: a stale correction is `CURRENT_VERSION_CONFLICT`).
   - T7 moves the old version (PROVISIONAL or OFFICIAL) to SUPERSEDED.
   - T2 + T3 make the new version current and PROVISIONAL.
   - It requires `CORRECT_RESULT` **and** `ACCEPT_RESULT`, plus a reason, and the content must change.
3. **There is never a pending correction.** A version references another as superseded only once the supersession has happened. This is exactly what the achievement loader already assumes when it treats "a version superseding v exists" as "v is superseded".
4. **Re-officialization is explicit.** A corrected version is PROVISIONAL and must be declared OFFICIAL again (T5).
5. **Events.** T5 emits `ResultOfficial`. A correction emits `ResultSuperseded` (old version) and the existing `ResultProvisional` (new version), so existing consumers re-evaluate without changes.
6. **Database facts.**
   - The transition CHECK admits T5 and T7.
   - A trigger refuses a version that supersedes anything but an earlier version of the same result.
7. **API.** Result actions run as the caller's own PERSON principal (SELF person; `identity.ensure_person_principal`), never a client-supplied one, behind the competition-staff gate. Operational permissions never become sporting authority (BRT-05).

## Consequences

- **Hashes unchanged.** No vector or existing hash changes: the transition-fact schema already enumerated T2–T8, and the version-fact schema already had `supersedesVersionId`.
- **Not implemented here:** T6 (FINAL) and T8 (REVOKED) are not required by in-event progression.
- **Reactors not changed:** ranking and achievement reactors don't subscribe to `ResultOfficial` yet. Recorded as a handoff, not changed here.
