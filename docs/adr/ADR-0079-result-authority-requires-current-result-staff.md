# ADR-0079 — Result authority requires current result-staff eligibility at action time

- **Status:** Proposed
- **Date:** 2026-10-22 (amended 2026-10-26: §2.3 eligibility binding, issue #41)
- **Origin:** ONCF WP-P0-3 (QA defect D-16, ONCF-QA-05 §D.3). Decision Q3 (re-promotion) adopted by the owner on 2026-10-22, §2.3.
- **Amends:** [ADR-0077](./ADR-0077-governance-issued-competition-result-authority.md) §2.4 ("Losing the staff role") and §4 (the third rejected alternative). Nothing else in ADR-0077 changes, and it is not edited.

## 1. Context

ADR-0077 §2.3 issues a competition result grant only to a person who currently holds the OWNER or ADMIN staff role of that competition. §2.4 then deliberately keeps the grant when that role is lost, on one premise: "Result actions over the API stop at once anyway, because every result route keeps the staff gate."

The premise does not hold.

- **The real gate is weaker.** The staff gate on the result routes is `COMP_VIEW_PRIVATE` (`ContestResultService.actor`). SCHEDULER and REGISTRATION_MANAGER hold it too.
- **Nothing else checks the role.** The Authority Engine checks capability, scope, validity, revocation and conflict of interest. It does not check the staff role.
- **Consequence (D-16).** An ADMIN demoted to SCHEDULER keeps correcting official results until an operator revokes the grant. QA-03 SCOR-029 reproduced this.
- **The pre-check is in the wrong transaction.** The existing gate also runs before the ledger transaction, in its own transaction, which leaves a check-then-act window.

## 2. Decision

### 2.1 The staff gate is the result-staff predicate, checked inside the result transaction

Every competition-scoped result write is authorized only if both of these hold:

1. **The grant.** The Authority Engine authorizes the caller's PERSON principal, unchanged (ADR-0064, ADR-0077).
2. **The current role.** At that moment, the caller's account holds an ACTIVE competition role in `RESULT_AUTHORITY_STAFF_ROLES` (OWNER or ADMIN) for the competition of the result's scope target. This is the same predicate as the ADR-0077 §2.3 issuance check (`competitionPermissions`):
   - explicit competition staff, or
   - OWNER/ADMIN of the organizer organization (the organization must be ACTIVE).

   The account must be ACTIVE with a SELF person.

The writes covered are submit (T2), accept (T3), reject (T4), declare official (T5) and correct (T7).

A refusal is `AUTHORITY_DENIED` (HTTP 403) with reason `NOT_RESULT_STAFF`, and no version, transition, outbox event or decision is written. If any fact cannot be read, the check fails closed.

**What can still be written (as before this ADR).** Staff who pass `COMP_VIEW_PRIVATE` can still create a contest's stable Result identity and an unsubmitted draft before the refusal. These are not versions or decisions, and they are not visible. Closing that is out of scope here.

**Where it runs.** The check runs inside the ledger command's `br_results` transaction:
- after the idempotency replay and the scope and mutability preconditions (`contest:<id>`, ADR-0078 §2.2, WP-P0-1);
- before the Authority Engine call and the stream head.

**Binding.** The application composition binds the check to the acting account: `createCompetitionResultLedger(db, { actorAccountId })`, built per action by `ContestResultService`, the only production write path.

**Guard.** `tooling/check-result-ledger-composition.mjs` (`pnpm lint`) refuses any `createCompetitionResultLedger(` call in `apps/*` or in the persistence services that names no `actorAccountId`, so a new composition cannot skip the check by omission. CLI demos, seeds and tests use fixture principals with no account and are exempt.

**This is not a second permission system.** It is the existing ADR-0077 §2.3 eligibility predicate, evaluated again at use, not only at issuance:
- A staff role still never creates, widens or substitutes for a grant. `CompPermission ∩ Capability = ∅` holds.
- The rejected alternative in ADR-0077 §4 was deriving sporting authority from staff roles inside the ledger. Requiring both is not that.

### 2.2 Serialization

The predicate is read after taking, in shared mode and in one sorted call, the advisory keys that the eligibility-changing commands take exclusively:

| Key | Exclusive holder |
|---|---|
| `account:<account>` | account disable (as for the vault, migration 0004) |
| `competition-staff:<competition>:<person>` | `assignStaff`, and now `endStaff` |
| `org-roster:<organization>` | membership role and status changes (as for attestations, migration 0011) |
| `org:<organization>` | organization status changes |

The resulting order:
- A demotion committed before the result transaction reads the predicate is always observed.
- A demotion that starts while a result transaction holds the keys waits until that transaction commits.
- After the demotion commits, no further result command by that person can succeed.

**Lock order:** idempotency key → `contest:<id>` → the shared eligibility keys (one sorted call) → the result stream head.

**Constraint for a future classification producer.** A classification submission (EVENT or ROUND scope) takes no `contest:` lock in `assertMutable`. Its inputs' `contest:` keys are taken later, in `assertInputsPlayed`, after the eligibility keys. No production code submits classifications today. A producer added later must take its inputs' contest keys before the eligibility keys. Otherwise a roster change queued between two such transactions turns into a `deadlock_timeout` delay.

Each exclusive holder above takes exactly one of these keys and no `contest:` or result lock, so no cycle can form. `endStaff` previously took no lock; it now takes its staff key. That is its only change.

### 2.3 Losing and regaining the role (amends ADR-0077 §2.4)

- **Losing the role.** Grants are still not revoked automatically, and the operational layer still writes no authority facts. Result actions stop at once because of §2.1. The runbook still requires the operator to revoke the grant, so that the authority record matches.
- **Replay.** An idempotent replay of a command that succeeded before the role was lost returns its recorded answer and writes nothing. A replay is not a new decision.
- **Re-promotion (decision Q3, adopted; enforced exactly, including under concurrency).** Once a person loses result-staff eligibility, a grant that relied on it never becomes usable again by re-promotion. Exercising result authority again needs a fresh, explicit operator grant (a new governance decision). The rule is stated over the grant's own eligibility basis, not over timestamps:

  > A result write is authorized only if the grant the Authority Engine authorizes it by is an ADR-0077 grant **bound at issuance to the actor's eligibility in that competition, and that binding still holds**: the account's status history has no change since, and at least one bound basis has no change since (for a membership, the organization's history neither).

  A refusal is `AUTHORITY_DENIED` (HTTP 403) with reason `GRANT_ELIGIBILITY_STALE`, and nothing is written.

**Security rationale.** A grant is an operator's decision about a person *in a role*. Demotion or removal ends the conditions under which that decision was made. If re-promotion revived the grant, a staff edit by any organizer OWNER/ADMIN would silently re-arm platform-issued authority, with no new governance decision and no authority fact recording it. Requiring a fresh grant keeps the operator, not the roster, as the only source of result authority (ADR-0077 §2.1), and makes every period of result authority traceable to its own grant.

**Why not transaction-start timestamps (the first WP-P0-3 cut).** That cut compared the grant's `recorded_at` with the start of the actor's uninterrupted eligibility rebuilt from the histories. Every `recorded_at` is its transaction's *start*, and commands take their advisory locks after starting, so a change that waited on a lock is stamped before changes it commits after. Within one entity, `seq` restores the order; across the grant, staff, membership, organization and account tables there is no common commit order. Two confirmed cases broke Q3 without any clock anomaly (issue #41): a demotion and a re-promotion that both wait behind an issuance (both stamped before the grant they commit after), and a demotion and a promotion on different bases (staff row and membership) whose start order is the reverse of their commit order. No timestamp rule can be exact here.

**The binding contract (migration 0038, `competition.result_grant_eligibility`).** One append-only row per ADR-0077 grant, written by the issuance and by nothing else:

| Field | Meaning |
|---|---|
| `grant_id` | the authorized grant (FK `authority.authority_grant`) |
| `competition_id`, `account_id`, `person_id`, `organization_id` | where and to whom it was issued (the organizer organization) |
| `account_changes` | number of `identity.account_status_change` rows of the account at issuance |
| `organization_changes` | number of `organizations.organization_status_change` rows of the organizer at issuance |
| `bases` | each OWNER/ADMIN basis ACTIVE at issuance: `{ kind: STAFF \| MEMBERSHIP, id, changes }`, the explicit staff row or membership and its number of status changes |

Histories are append-only, so a count only grows: "this entity has exactly N changes" means "nothing happened to it since". Every producer of those histories writes them while holding that entity's eligibility key exclusively (§2.2), and the issuance and every result command read them holding the keys shared. A count is therefore decided in commit order. No timestamp is compared across transactions.

| Basis | History | Interruptions that add a change |
|---|---|---|
| Explicit competition staff (OWNER/ADMIN row) | `competition_staff_status_change` | ACTIVE → ENDED (terminal; re-assignment is a new, unbound row) |
| Organizer membership (OWNER/ADMIN) | `membership_status_change` (read by `br_identity`) | ENDED, SUSPENDED → ACTIVE; a role change ends the row and starts a new, unbound one |
| Organizer organization ACTIVE (membership bases only) | `organization_status_change` | ACTIVE ↔ SUSPENDED |
| Account ACTIVE | `account_status_change` | DISABLED (no re-enable path today) |

**Fail-closed role-change policy (owner decision, 2026-10-26).** A grant is preserved while at least one basis recorded at issuance remains unchanged and eligible. Anything else needs a fresh grant, including cases where the person never stopped being eligible:
- an organization role change ADMIN → OWNER (the membership row is replaced);
- a cross-basis handoff (explicit ADMIN, then also organization ADMIN, then the explicit row ends) when the grant was issued before the second basis existed;
- demotion or removal followed by re-promotion; a membership or the organization suspended then reactivated.

A grant issued while the person held two bases survives the loss of either one. No continuation heuristic (for example comparing `xmin`) is applied.

**Origin.** For competition result writes, only grants verifiably from the ADR-0077 chain are accepted: the engine's chain must be exactly one root grant (ADR-0077 grants are not delegable) with a binding row for this competition, account and person. A grant without a binding (issued before 0038, issued outside the governance command, or by another PLATFORM anchor) is refused with the same reason. There is no timestamp fallback.

**Where it runs.** In the same place and under the same shared keys as §2.1. Before the Authority Engine, the gate reads the eligibility snapshot (the four histories' counts and current status, each by the module role that owns it). After the engine has authorized, it checks the grant the engine authorized by against its binding and that snapshot. This covers every Authority Engine call of submit, transition and correct (correct checks both of its capabilities). The keys stay held to the end of the result transaction, so the snapshot is current at the check.

**Issuance (ADR-0077 §2.3 command).** Limited to result authority:
- **Issuances for one grantee serialize.** The locked transaction first takes `result-authority-issue:<competition>:<person>` exclusively (taken by nothing else, always before the eligibility keys), so a concurrent run under the same or another decision waits and then converges on the committed, bound grant.
- **The read, the grant and its binding cannot be split.** It then takes the eligibility keys in shared mode, re-checks eligibility, reads the snapshot, and keeps the keys until the grant and its binding have committed. In commit order, a demotion or re-promotion falls entirely before the issuance (refused, or bound to the new eligibility) or entirely after it (the binding no longer holds). Nothing inside that transaction takes the eligibility keys. It is not retried, because its body commits other transactions.
- **A stale or unbound grant is never reused or re-bound.** The command converges only on an ACTIVE grant whose binding holds. Any other ACTIVE grant of that grantee from the same PLATFORM grantor and scope (stale binding, or none: legacy) is revoked prospectively, with a recorded reason (`not bound to the grantee's current OWNER/ADMIN eligibility`), audited (`authority.result-grant.stale-revoked`) as soon as it commits. A binding is written only for a grant created by this very act (`created: true`); an existing grant handed back by an idempotent replay is refused. A governance decision already spent cannot be reused (`GOVERNANCE_DECISION_USED`); a new decision is required. If a grant committed but its binding did not (the outer transaction failed), that grant is unusable and is revoked by the next issuance; it is never bound after the fact.

**Interactions.**
- **Replay.** Unchanged: an idempotent replay returns its recorded answer before any check and writes nothing. A replay is not a decision.
- **Active grants at deploy.** Every grant issued before migration 0038 has no binding and is refused from deploy until the operator re-issues it (§3, rollout). This is intended: no pre-0038 grant can be proven to rest on current eligibility.
- **Races.** A demotion → re-promotion cycle and a result command serialize on the eligibility keys: the command sees the role before the demotion, during the gap (`NOT_RESULT_STAFF`), or after the re-promotion (`GRANT_ELIGIBILITY_STALE`). An issuance and a queued demotion and re-promotion: the grant is bound before the demotion and never holds again. Changes on different bases in either commit order: the old grant never holds again.

**Rejected alternatives.**
- *Transaction-start timestamp continuity* (the first cut): not exact under concurrency, see above.
- *Revoking grants from the staff and membership commands.* That makes the operational roster write authority facts in another module's ledger, from several producers (staff, membership, organization, account), with as-of revocation semantics that a queued result transaction can still read past, and it is what ADR-0077 §2.4 deliberately avoided.
- *An eligibility epoch per (competition, person).* Also exact, but every producer must increment it in its own transaction, organization status changes for every member at once.
- *A grant-model field.* `constraints` is a fixed domain type hashed into the grant; the binding table needs no grant-model or Authority Engine change.
- *Changing the Authority Engine to prefer newer grants.* The engine is shared by every capability. A narrow rule at the result composition was preferred.

### 2.4 Unchanged

- Revocation and expiry and their semantics. Issuance changes only as described in §2.3.
- Revocation stays prospective and is evaluated as of the command's transaction time (BRT-03). A use whose transaction began before a concurrent revocation was recorded is decided as of that earlier time. This is recorded as a known residual, not changed here.
  - **Residual: backwards clock steps.** The same as-of rule means a database clock that steps backwards can hide a committed revocation for the length of the step. In WP-P0-3 testing, a submit that began 2.5 s (host time) after a committed revocation was stamped 0.11 s *before* it, and was authorized. The development VM clock was observed stepping back by about 2.6 s. Managed production databases are not expected to step like this. Hardening (for example, evaluating revocations as known at statement time, or a monotonic transaction time) belongs to BRT-03, not here.
  - **No such window for the staff role or the binding.** The role check of §2.1 and the binding check of §2.3 read current committed facts under locks, not facts as of the transaction time, so a clock step cannot hide a demotion or an interruption.
  - **Residual: over-denial with grants from other sources.** The engine tries candidate grants oldest first and returns the first valid one. The issuance revokes stale grants only from the same PLATFORM grantor, for exactly the competition scope. A grant from another source therefore keeps being chosen, and refused, even after a fresh ADR-0077 grant exists. This fails closed. Production has one source, the ADR-0077 command. Otherwise the operator revokes the other grant.
  - **Residual: the issuance hold.** The hold keeps the shared eligibility keys while the issuance commits other transactions on other pool connections (principal, grant, revocations, audit). Nothing in it takes those keys. If a future change made an inner call take one, even shared, it could queue behind a waiting exclusive holder and hang in a way the database cannot detect. Any change to the issuance body must keep that property. Each issuance in flight uses two pool connections at once; under a small pool and many concurrent issuances this can exhaust the pool (operator commands are rare and sequential; not a request path).
  - **Residual: membership gains are not serialized with the gate.** Accepting an invitation (`respondToInvitation`) can make a person eligible and takes no eligibility key. Gains cannot revive a grant (a new membership row is never bound retroactively), and the D-16 gate reads the current state, so this only affects when a gain becomes visible.
- The participation conflict checker and its pre-transaction read (ADR-0077 §3, "small time-of-check window").
- The D-14 lifecycle precondition, D-15/D-18 score-sheet validation, idempotency, audit and the public read paths.

## 3. Consequences

- **Benefit:** a demoted or removed person can no longer change results with a grant issued for their previous role, and re-promotion does not silently restore it.
- **Cost: write serialization.** Result writes by members of one organization serialize briefly with that organization's roster changes. Shared mode lets result writes run concurrently with each other.
- **Cost: an extra read.** Each result write performs one more read of the staff and membership facts.
- **Cost: one more table read.** Each result write reads the authorizing grant's binding (one row by primary key) in addition to the eligibility histories.
- **Cost: more fresh grants.** Role changes that replace a membership row, and cross-basis handoffs, need an operator re-issue (fail closed, §2.3).
- **Migration prerequisite:** migration `0038` (one additive, append-only table) must be applied before this code runs; the code fails closed without it (the binding read errors, so every gated result write is refused). Apply it only through the reviewed migration procedure, never ad hoc.
- **Rollout:** before deploying, list (read-only) the active ADR-0077 result grants (`pnpm authority:results list`, or the grants view). Every one of them is unbound and is refused from deploy. Right after deploy, the operator re-issues a grant, under a new governance decision, to each person who must keep acting; the issuance revokes the old unbound grant (audited) and binds the new one. Plan the window: no gated result write succeeds for a person between deploy and their re-issue.
- **Operations:** after any demotion, the operator still revokes (runbook). After a re-promotion, a role change that replaces a membership, a suspension and reactivation, or a cross-basis handoff, the operator issues a fresh grant under a new governance decision. Re-using the old decision is refused.
- **Rollback:** revert the code; the table is additive and may stay (nothing else reads it). Grants issued under 0038 remain valid grants under the previous version; stale grants revoked by issuance stay revoked (prospective, audited), which is correct under either version. Dropping the table is not part of a rollback.
