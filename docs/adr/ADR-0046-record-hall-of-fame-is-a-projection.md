# ADR-0046 — The Record Hall of Fame is a rebuildable RecordMark-history projection, not canonical truth

- **Status:** Proposed
- **Date:** 2026-09-30
- **Origin:** BRT-09 stop gate 0C (BRT-01 §9; target capability map M10 / M18)

## Context

BRT-01 defines RecordCategory and RecordMark but no Hall of Fame entity or induction process. The capability map lists "Hall of Fame" under M18 (Media / Historical Archive) without defining it.

## Decision

1. BRT-09 implements a **Record Hall of Fame**: a class-B read model (`record_read.hall_of_fame_entry`) over legitimate RecordMark history — RATIFIED / CANONICAL marks (CURRENT) and SUPERSEDED marks that actually held the record (FORMER) — of non-PERSONAL categories, with value, holder, category, effective period, recognition level / region / sport and the RECORD_SET link.
2. **Never honours:** PENDING_RATIFICATION claims; RESCINDED marks (they stay in the category history / audit, explicitly labelled "rescinded — not a record"); marks that never held the record after replay.
3. **No subjective truth:** no induction, committee, greatness score, popularity ranking or editorial award. SHARED co-holders all appear for the same value / period.
4. **Rebuildable:** truncated and re-derived by the maintenance login from record facts only (tested byte-equal). Public DTOs carry no anchor ids, anchor fact hashes, grants, principal ids, keys, Person / Account ids or private identity; athletes are displayed through the Passport privacy policy.
5. M18's broader historical archive remains future work.

## Consequences

The Hall of Fame can never diverge from canonical record history and can never be edited by hand.
