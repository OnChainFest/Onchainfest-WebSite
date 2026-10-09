# ADR-0068 — Availability and the scheduling time model (wall-clock intent, IANA zones, server-side conversion, explicit DST rules)

- **Status:** Proposed
- **Date:** 2026-10-08
- **Origin:** ONCF-05E-0 (extends the BRT-05 time model)

## Context

The platform stores instants as UTC (`timestamptz`) and refuses instants without an explicit offset. Competitions and events carry an IANA timezone, and display converts to that zone.

Wall-clock to instant conversion exists only in the web app (`zonedToInstant`). It is tested for summer and winter offsets but not for skipped or repeated local times, and nothing models recurring local hours.

## Decision

1. **Five distinct time concepts:**
   - **instant:** UTC;
   - **local wall-clock time:** date + time without an offset;
   - **IANA timezone;**
   - **recurring rule:** local weekly windows + zone + validity date range;
   - **schedule interval:** start instant, expected end instant, expected duration and changeover, stored explicitly.

   A schedule entry is never just "startAt".
2. **Scheduling intent is preserved.**
   - A schedule assignment stores its UTC interval **and** the zone it was planned in.
   - A recurring availability rule stores local times plus the zone, never pre-converted UTC.
3. **The server owns conversion.**
   - A server-side, tested module converts wall-clock + zone to UTC for availability expansion and organizer local-time input.
   - The web helper becomes presentation-only.
4. **Explicit DST rules:**
   - **Recurring rules:**
     - A window *boundary* in a **skipped** local time moves forward by the gap. Example: 02:30 on a spring-forward day becomes 03:30 local.
     - A boundary in a **repeated** local time takes the **earlier** occurrence.
     - The result is deterministic and documented, with no error, because recurring rules must expand without a human.
   - **One-off organizer input** in local time:
     - a **skipped** time is refused (`LOCAL_TIME_SKIPPED`);
     - a **repeated** time is refused (`LOCAL_TIME_AMBIGUOUS`) unless the caller states the offset.

     A one-off time with an unclear instant is never stored silently.
5. **Availability is separate from scheduling**, layered per resource:
   - recurring local operating hours;
   - date-specific exceptions (open or closed);
   - blackouts or maintenance (with a reason);
   - competition-wide restrictions.

   Precedence: blackout/maintenance > date-specific exception > recurring hours. It expands deterministically to UTC intervals for the competition window.
6. **No stored "reserved" state.** Reservation is derived from schedule assignments (ADR-0070).

## Consequences

- **DST tests are mandatory in 05E-A:** a fixed-offset zone (America/Costa_Rica), a zone with a spring-forward gap and a fall-back fold, and windows crossing midnight.
- **Availability rows are append-only facts.** Edits are new rows, and the current set is a projection.

## Alternatives considered

- **Storing pre-expanded UTC availability only:** rejected; it loses intent and drifts with timezone rule updates.
- **Full RFC 5545 RRULE:** rejected as unnecessary for v1. Weekly local windows plus date exceptions cover the eight proof cases.
- **Silently "fixing" one-off DST-ambiguous inputs:** rejected.
