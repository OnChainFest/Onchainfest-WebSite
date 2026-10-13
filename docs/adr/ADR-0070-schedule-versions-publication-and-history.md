# ADR-0070 — Schedule versions, private drafts, validated publication, locks and append-only history

- **Status:** Proposed
- **Date:** 2026-10-08
- **Origin:** ONCF-05E-0 (supersedes the immediate-publication behaviour of BRT-05 `scheduleContest`; follows ADR-0031 / ADR-0065 patterns)
- **Amended by:** ONCF-05E-F-6 (2026-10-13): §8 (lock and unlock only for contests that have not started; unlock grants permission to edit, nothing more) and §9 (optimistic concurrency for manual edits). Source: [ONCF-05E-F architecture](../implementation/ONCF-05E-F-ARCHITECTURE.md) Part III, findings C-1, C-2 and G-7. The amendment has this ADR's status.

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

   **§8 amendment** (ONCF-05E-F-6, findings C-1 and G-7):
   - **What unlock does.** It only permits a later manual edit of the assignment. It does not affect whether the resulting draft can be published: [ADR-0074](./ADR-0074-conflict-feasibility-engine-v1-semantics.md) D12 (as amended) judges settled contests on their placement alone, whatever their lock history.
   - **When lock and unlock apply.** They are draft scheduling operations, valid only on assignments of contests that are `PLANNED` or `SCHEDULED`.
   - **Started or closed contests.** Once a contest is `IN_PROGRESS`, `COMPLETED`, `CANCELLED` or `VOID`, its assignment can no longer change for scheduling purposes:
     - lock and unlock of its assignment are refused and write nothing;
     - the refusal is the one 05E-C already defines for edits to that same set of contests: `INVALID_TRANSITION` `CONTEST_STARTED_OR_CLOSED` (05E-C § 3);
     - an unlock can never make such a contest editable.
   - **Facts already written.** Lock and unlock facts already recorded for such contests stay in the append-only history. They have no effect on what can be edited or published.
   - **No exception workflow.** v1 has no way to edit a started contest's assignment. Adding one requires a new ADR.
9. **Concurrency** follows the 05D precedent:
   - preview → hash → commit, rejected if stale;
   - plus an advisory lock per competition schedule, a version check (`base version` / last fact), and idempotency keys.

   **§9 amendment — optimistic concurrency for manual edits** (ONCF-05E-F-6, finding C-2):
   - **Rule.** Every manual edit is an optimistic-concurrency operation. It succeeds only if the state the organizer last saw is still current. A newer manual edit is never silently overwritten: last write wins is not allowed.
   - **Commands it covers.** Every manual command that appends an assignment fact to a draft:
     - set or move, including the legacy `POST /v1/contests/:id/schedule` path;
     - remove;
     - lock;
     - unlock.

     No manual write path may bypass the check.
   - **Commands it does not change:**
     - **Proposal commit** keeps its own check: server recomputation against the base-state identity ([ADR-0075](./ADR-0075-scheduler-proposal-engine-v1-semantics.md), [ADR-0076](./ADR-0076-proposal-commit-eligibility.md)).
     - **Publication** keeps `baseVersionId` and `reportHash` (05E-C § 4).
   - **Expected identity** — the "`base version` / last fact" of this section:
     - **Version level.** The draft being edited is named by its version id and must still be the open draft. This check already exists (`NOT_A_DRAFT`). A draft discarded and reopened has a new id, so an edit aimed at the old draft can never land in the new one.
     - **Fact level (new).** The command must state the contest's **last fact**: the id of that contest's current fact in the draft (a removal fact counts), or an explicit statement that the contest had none.
     - The fact-level expectation is **required**. A command without it is refused as invalid input. The server never assumes "whatever is current", because that would bring last write wins back.
   - **The check.**
     - It runs inside the command's transaction, under the competition-schedule advisory lock, after the draft is re-read.
     - If the stated last fact is not the contest's current fact, the command is refused with `CONCURRENCY_CONFLICT` (409). This is the class 05E-C § 4 uses for stale publications. The reason must be machine-readable and distinct from `BASE_VERSION_STALE` and `REPORT_STALE`.
     - A refused command writes nothing: no fact, no audit entry, no outbox event.
     - The check is per contest. Edits to *other* contests in the same draft do not make a command stale.
   - **Idempotency is a separate mechanism.**

     | | Idempotency key | Optimistic concurrency |
     |---|---|---|
     | Question it answers | Is this the same command again? | Is the state this command was based on still current? |
     | On a match | Returns the stored first response, with no new check and no write | The command proceeds |
     | On a mismatch | Same key with a different request: `IDEMPOTENCY_KEY_REUSED` | `CONCURRENCY_CONFLICT` |

     - The stated last fact is part of the request, so it is part of the idempotency fingerprint.
     - A retry with the **same** key after a lost response returns the original result.
     - A retry with a **new** key after the original succeeded is stale, because the original replaced the stated fact. It is refused, which is the correct outcome. A client that wants a safe retry reuses its key.
   - **Not decided here:** the request field's name and shape, and the reason string. Both belong to the implementation slice. The repository's conceptual precedent is the [BRT-02 API surface](../api/BRT-02-API-SURFACE.md) `ETag` / `If-Match` convention. Whatever shape is chosen must carry exactly the fact-level identity defined above.
   - **Implementation status.** Not implemented. Until the Operations API hardening slice lands, manual edits do not conform to this rule (ONCF-05E-F-5, C-2).
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
