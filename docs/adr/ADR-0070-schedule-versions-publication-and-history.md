# ADR-0070 — Schedule versions, private drafts, validated publication, locks and append-only history

- **Status:** Proposed
- **Date:** 2026-10-08
- **Origin:** ONCF-05E-0 (supersedes the immediate-publication behaviour of BRT-05 `scheduleContest`; follows ADR-0031 / ADR-0065 patterns)

## Context

`competition.contest_schedule` is overwritten in place, and every write is public at once, through the read-model refresh. The audit record keeps only the new and previous start times.

Organizers need a private working schedule, validation before publication, and an auditable history.

## Decision

1. **Schedule versions per competition:**

   | Status | Meaning |
   |---|---|
   | `DRAFT` | Private, editable; at most one open draft per competition |
   | `PUBLISHED` | The single public version |
   | `SUPERSEDED` | Replaced by a later publication |
   | `DISCARDED` | An abandoned draft |

   - Statuses are append-only status facts.
   - A draft is created from the published version (or empty) and records its base version.
2. **Mapping the conceptual lifecycle:**

   | Conceptual state | Representation |
   |---|---|
   | DRAFT | A stored status |
   | VALIDATED / PROPOSED | **Computed:** a draft's conflict report has no hard conflicts. The report hash is recorded at publication. Proposals are previews that become draft content only on commit |
   | PUBLISHED | A stored status |
   | LOCKED | A property of an **assignment** (`locked`), plus implicitly every contest that has started |

3. **Assignments are append-only facts within a version.** Each records:
   - contest;
   - resource(s);
   - start, expected end, changeover;
   - zone;
   - provisional flag (for occupants not yet resolved);
   - locked flag;
   - the actor;
   - a **reason** for every manual move;
   - the previous assignment it replaces.

   The current content of a version is the latest fact per contest.
4. **Publication:**
   - requires zero hard conflicts at publication time;
   - soft conflicts must be explicitly acknowledged, and the acknowledgement is recorded;
   - the draft becomes `PUBLISHED` and the previous published version `SUPERSEDED`, atomically.
5. **Public readers see only the published version.** `contest_schedule` becomes the **projection of the published version**, so existing public reads keep working. A draft is never readable publicly.
6. **Existing route.** In 05E-C, `POST /v1/contests/:id/schedule` stops writing the public schedule directly and edits the draft instead.
   - Existing `contest_schedule` rows are migrated into an initial PUBLISHED version, so nothing currently public disappears.
   - The behaviour change is documented in 05E-C.
7. **Contest status.** A contest becomes `SCHEDULED` when it appears in a published version (not on a draft edit).
8. **Locks:**
   - A locked assignment, or a contest that is IN_PROGRESS or later, is never moved by the proposal engine.
   - Moving a locked assignment manually requires an explicit unlock with a reason.
9. **Concurrency** follows the 05D precedent:
   - preview → hash → commit, rejected if stale;
   - plus an advisory lock per competition schedule, a version check (`base version` / last fact), and idempotency keys.
10. **Audit:** every draft edit, proposal commit, lock or unlock, publication and discard emits an audit entry and an outbox event. History answers what, when, which resource, previous vs new time/resource/venue, who, why and in which version.
11. **Permissions** reuse the existing model:

    | Permission | Holders | Covers |
    |---|---|---|
    | `COMP_MANAGE_SCHEDULE` | OWNER, ADMIN, SCHEDULER | Drafts, proposals, moves, locks, **publication**, start/complete |
    | `COMP_EDIT` | OWNER, ADMIN | Resources, availability, profile pin |
    | `COMP_CANCEL` | OWNER, ADMIN | Cancel/void |

    - **Publication authority:** publishing is part of operating the schedule, which is exactly the SCHEDULER role's purpose. A separate publish permission is added only if implementation or product evidence shows SCHEDULER must not publish.
    - No scheduling permission grants authority over scoring, results, advancement or referee decisions.

## Consequences

- **Two schedules at once:** the organizer can prepare version n+1 while version n stays public.
- **No data loss:** schedule history is complete, and nothing is overwritten.

## Alternatives considered

- **A `draft` flag on `contest_schedule`:** rejected (no history, no atomic publication).
- **Per-contest publication:** rejected. A schedule must be validated and published as a coherent whole.
