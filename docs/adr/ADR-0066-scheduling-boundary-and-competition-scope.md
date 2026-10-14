# ADR-0066 — Scheduling boundary: 05E owns WHERE and WHEN, at competition scope

- **Status:** Proposed
- **Date:** 2026-10-08
- **Origin:** ONCF-05E-0 (executes ONCF-05A §27; extends ADR-0055)
- **Amended by:** ONCF-05E-F-6 (2026-10-13): adds §7, the command contract for the operational contest lifecycle commands that §1 assigns to 05E. Source: [ONCF-05E-F architecture](../implementation/ONCF-05E-F-ARCHITECTURE.md) Part III, findings G-5, G-9 and G-10. The amendment has this ADR's status.

## Context

ONCF-05B–05D produce the immutable plan, scored and classified results, and committed advancement facts. Scheduling is the remaining operational layer.

Its boundary has to be frozen before code exists, for three reasons:
- the same athlete can enter several events of one competition;
- some groupings are intrinsic to a format while others depend on results;
- `contest_schedule` already exists as an immediately public, overwritten-in-place table.

## Decision

1. **Ownership.**
   - 05D answers "who plays against whom".
   - **05E answers "who plays where and when".**
   - 05E owns time, resource assignment, availability, expected duration, changeover, rest, scheduling conflicts, dependency-aware ordering, proposals, schedule versions, publication, operational changes and the operational contest lifecycle commands (start, complete, cancel, void).
2. **05E never decides** scores, winners, classification, qualification, advancement, eligibility or authority/referee matters. It **consumes** advancement state (`v_contest_occupant`, target states, the 05D start guard) and never writes it.
3. **Competition scope.** A schedule, its conflict check and its proposal cover a whole **competition**, not one event, because one athlete or team can occupy contests in several events. Events still pin their own SchedulingProfile (ADR-0069).
4. **Grouping ownership** (extends ADR-0055):
   - **Intrinsic grouping is 05B's**, fixed in the immutable plan: initial waves, initial heats, round-1 tee groups, bowling qualifying blocks, time-trial order and offsets.
   - **Result-dependent operational grouping may be done by 05E**, only from occupants 05D resolved. Example: grouping the entrants of a post-cut round, which 05D materialized without groups.
   - 05E may decide **when** a resolved group starts and how resolved entrants are grouped for start times. It never decides **who** belongs to the round.
   - Any grouping rule is generic, driven by SchedulingProfile data.
5. **Sport is data** (ADR-0053). No scheduler, resource engine, store, table or endpoint is per sport. The pipeline is generic:

   discipline → format → ruleset → **SchedulingProfile** → resource requirements → generic scheduler.

6. **Out of scope for 05E:** live scoring, live timing, referee assignment, sporting authority, check-in, notifications, payments, ticketing, spectators, broadcast, awards, sponsors, $BRT rewards, marketplace, gift cards and prize fulfilment.
7. **Operational contest lifecycle commands — command contract** (amendment, ONCF-05E-F-6). §1 makes start, complete, cancel and void 05E commands. Until now, no ADR stated how they behave as commands. The following is unchanged:
   - the transition table and preconditions ([BRT-05](../implementation/BRT-05-COMPETITION-ENGINE.md) § 8);
   - the permissions: start and complete need `COMP_MANAGE_SCHEDULE`, cancel and void need `COMP_CANCEL` ([ADR-0070](./ADR-0070-schedule-versions-publication-and-history.md) §11);
   - the outbox events and the `contest.*` audit family (BRT-05 § 13).

   **7.1 Idempotency (G-5).** Start, complete, cancel and void are state-changing commands, so each takes an **`Idempotency-Key`**. This follows the repository rule that the header is required on POST commands ([BRT-02 API surface](../api/BRT-02-API-SURFACE.md)), and the schedule commands' use of keys (ADR-0070 §9). The fingerprint is the existing one: command, actor, and a digest of the parameters, including the cancel or void reason.

   | Case | Outcome |
   |---|---|
   | Same key, same request | Replays the stored first response. Nothing is written, and no precondition, start guard, permission or state check is evaluated again |
   | Same key, materially different request (other contest, other command, other reason) | `IDEMPOTENCY_KEY_REUSED`, deterministic. Nothing is written |
   | Different key, after the transition succeeded | Handled as a new command by the state machine. A repeated transition is refused with `INVALID_TRANSITION` (409), as today |
   | Concurrent commands on one contest | Serialized by the lifecycle concurrency mechanism: exactly one transition from a given state wins, and the others see the new state. With the same key, the command takes effect at most once |

   - Idempotency does not replace serialization. One lock discipline (or database guard) covering **every** writer of contest status facts is the separate G-1 fix (ONCF-05E-F-5 § 39). This amendment does not choose that mechanism.
   - Competition and event status commands are outside this amendment.

   **7.2 Containing competition and event (G-9).** A contest command must respect the lifecycle of the competition and event that contain it.
   - **Minimum rule.** When the containing competition or event is terminal (`COMPLETED` or `CANCELLED`), no contest command may make a transition that contradicts that terminal state.
   - **Contest states are only** `PLANNED`, `SCHEDULED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED` and `VOID` (BRT-05 § 8). Competition states are BRT-05 § 2's; event states are BRT-05 § 3's. No state is added.

   | Contest command (source states, BRT-05 § 8) | Competition and event not terminal | Competition or event `CANCELLED` | Competition or event `COMPLETED` |
   |---|---|---|---|
   | Start (`SCHEDULED`) | BRT-05 § 8 preconditions (event `IN_PROGRESS`, every slot holding an ACTIVE participant) | **Refused** | **Refused** |
   | Cancel (`PLANNED`, `SCHEDULED`) | Allowed | **Allowed**: the target is the containing entity's own terminal state, and the state a competition cancellation's cascade already requires (BRT-05 § 2) | **UNDEFINED** |
   | Complete (`IN_PROGRESS`) | Allowed | **UNDEFINED** | **UNDEFINED** |
   | Void (`IN_PROGRESS`, `COMPLETED`) | Allowed | **UNDEFINED** | **UNDEFINED** |

   - **Start refused.** This already follows from BRT-05:
     - start requires the event `IN_PROGRESS`;
     - a cancelled competition cancels every non-terminal event (BRT-05 § 2);
     - a competition can be `COMPLETED` only when every event is terminal (BRT-05 § 2).

     The amendment makes this a rule of the command itself, independent of that chain of reasoning, because G-1 shows that statuses read separately can race.
   - **Why the UNDEFINED cells stay undefined.**
     - BRT-05 § 2's cascade cancels only `PLANNED` and `SCHEDULED` contests. It deliberately leaves `IN_PROGRESS` contests alone, and no source says how they close afterwards. `COMPLETED` and `VOID` are the only exits from `IN_PROGRESS`, so refusing both would leave such a contest `IN_PROGRESS` forever, while allowing them is not shown to be consistent with the terminal container.
     - No source states whether a `COMPLETED` event may contain contests that are not terminal.
     - These cells need a future ADR. Until then, an implementation keeps today's behaviour for them: only the contest state machine applies. It must not invent a refusal.

   **7.3 Reasons in the audit trail (G-10).**
   - **Reasons are required.** Cancel and void require a human-provided reason. Validation is unchanged: NFC, trimmed, non-empty, at most 500 characters, no control characters.
   - **Where the reason is kept.**
     - The status fact still records the lifecycle state, and still records the reason.
     - The `contest.cancelled` and `contest.void` audit entries must **also** carry the same reason value in their details. The human explanation is then visible in the audit trail without reading status facts back.
     - The audit copy is telemetry, never authority (BRT-05 § 13). The status fact remains the source of the contest's state.
   - **Outbox events are unchanged.** `ContestCancelled` and `ContestVoided` do not carry the reason. BRT-05 § 13 limits outbox payloads to ids, statuses, slugs, hashes and counts.
   - **Not covered:** contests cancelled by a competition or event cancellation's cascade (BRT-05 § 2). This amendment does not decide whether their audit entries carry a reason.

   **7.4 Implementation status.** Not implemented. §§ 7.1–7.3 belong to later Operations API hardening slices. Nothing in this amendment changes a route, schema, migration, payload or test by itself.

## Consequences

- An event-scoped scheduler is a defect: it would hide cross-event participant conflicts.
- A post-cut round can be scheduled only after its field is committed (ADR-0065), and only from that field.
- **The ADR-0055 / 05D gap is closed by this decision.** Round-1 tee groups come from the plan, while post-cut grouping (which 05D left to 05E) is a 05E scheduling-grouping policy.

## Alternatives considered

- **Event-scoped scheduling:** rejected (misses cross-event conflicts).
- **05E re-deriving fields from classifications:** rejected (it would duplicate and contradict 05D).
