# ADR-0079 — Result authority requires current result-staff eligibility at action time

- **Status:** Proposed
- **Date:** 2026-10-22
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
- **Re-promotion (decision Q3, adopted; enforced for sequential changes, see the §2.4 residual for concurrent ones).** Once a person loses result-staff eligibility, a grant that relied on it never becomes usable again by re-promotion. Exercising result authority again needs a fresh, explicit operator grant (a new governance decision). The rule is stated over continuity, not over events:

  > A result write is authorized only if the grant the Authority Engine authorizes it by was recorded **at or after the start of the actor's current, uninterrupted OWNER/ADMIN eligibility** in that competition.

  A refusal is `AUTHORITY_DENIED` (HTTP 403) with reason `GRANT_PREDATES_ELIGIBILITY`, and nothing is written.

**Security rationale.** A grant is an operator's decision about a person *in a role*. Demotion or removal ends the conditions under which that decision was made. If re-promotion revived the grant, a staff edit by any organizer OWNER/ADMIN would silently re-arm platform-issued authority, with no new governance decision and no authority fact recording it. Requiring a fresh grant keeps the operator, not the roster, as the only source of result authority (ADR-0077 §2.1), and makes every period of result authority traceable to its own grant.

**How continuity is determined (no new data).** All eligibility bases have append-only, timestamped histories, and none of them is rewritten:

| Basis | History used | Can it become ACTIVE again? |
|---|---|---|
| Explicit competition staff (OWNER/ADMIN row) | `competition_staff_status_change` | No: ACTIVE → ENDED is terminal; re-assignment is a new row |
| Organizer membership (OWNER/ADMIN) | `membership_status_change` (read by `br_identity`, which already reads it) | Yes: ACTIVE ↔ SUSPENDED. A role change ends the row and starts a new one |
| Organizer organization ACTIVE | `v_organization_current.recorded_at` | Yes: ACTIVE ↔ SUSPENDED |
| Account ACTIVE | `v_account_current.recorded_at` | No path today; handled the same way |

Each history is read by the module role that owns it, in `seq` (commit) order. `recorded_at` is the transaction's start, and commands take their advisory lock after starting, so a change that waited on a lock can be stamped before a change it committed after. Times are therefore made non-decreasing in `seq` order within each entity, and a period reopened after a closing change starts strictly after it: an entity's reactivation never touches, or merges with, its own earlier period. A membership counts only while the organization is ACTIVE, and every basis only while the account is. The ACTIVE spans of all bases are merged; **overlapping or touching spans of different bases are one continuous eligibility**. So these are not interruptions and need no new grant:
- an organization role change ADMIN → OWNER (one command ends one membership and starts the next at the same instant);
- a handoff between bases (explicit ADMIN, then also organization ADMIN, then the explicit row ends).

These are interruptions and need a new grant: demotion or removal followed by re-assignment; organization role MEMBER then ADMIN again; a membership suspended then reactivated; the organization suspended then reactivated.

**Where it runs.** In the same place and under the same shared keys as §2.1. The gate computes the start of the current eligibility before the Authority Engine. Once the engine has authorized, it checks the grant the engine authorized by (the leaf of its chain) and any other grant of that chain held by the same principal (a self-delegation). This covers every Authority Engine call of submit, transition and correct (correct checks both of its capabilities).

**Issuance (ADR-0077 §2.3 command).** Two changes, both limited to result authority:
- **The check and the write cannot be split.** After its existing pre-check, the command opens a transaction that takes the same eligibility keys in shared mode, re-checks eligibility, and keeps them until the grant has committed. In commit order, a demotion or re-promotion therefore falls entirely before the issuance (the grant is refused) or entirely after it (the grant predates the new eligibility). The timestamps can disagree with that order when both a demotion and a re-promotion wait behind the hold (§2.4 residual). Nothing inside that transaction takes those keys, so it cannot deadlock against a queued exclusive holder. It is not retried, because its body commits other transactions.
- **A stale grant is never reused.** The command used to converge on any existing ACTIVE equivalent grant. It now converges only on one recorded at or after the current eligibility. Any older ACTIVE grant of that grantee and competition is revoked prospectively, with a recorded reason (`issued before the grantee's current OWNER/ADMIN eligibility`), and the revocation is audited (`authority.result-grant.stale-revoked`) as soon as it commits, even if the issuance is then refused. That revocation changes no permission: such a grant is already refused by the rule above. It does mean the authority record says what is true. A governance decision already spent on the stale grant cannot be reused (`GOVERNANCE_DECISION_USED`); a new decision is required.

**Interactions.**
- **Replay.** Unchanged: an idempotent replay returns its recorded answer before any check and writes nothing. A replay is not a decision.
- **Active grants at deploy.** A grant issued while its holder was eligible stays usable as long as that eligibility has been continuous since. A grant whose holder had an interruption after it was issued becomes unusable at deploy, which is the intended effect.
- **Grants not issued by the ADR-0077 command** (tests and fixtures only; no route issues grants, `check-no-manual-authority`) follow the same rule: they must be recorded after the holder's current eligibility began.
- **Races.** A demotion → re-promotion cycle and a result command serialize on the staff key: the command sees the role before the demotion, during the gap (`NOT_RESULT_STAFF`), or after re-promotion (`GRANT_PREDATES_ELIGIBILITY`). An issuance and a demotion serialize on the same key. Two eligibility changes for the same person that overlap in time are the §2.4 residual.

**Rejected alternatives.**
- *Revoking grants from the staff and membership commands.* That makes the operational roster write authority facts in another module's ledger, from several producers (staff, membership, organization, account), and it is what ADR-0077 §2.4 deliberately avoided. The continuity rule needs no writes on demotion.
- *Binding each grant to the staff row or membership it was issued under.* That is exact and clock-independent, but it needs a new table or a grant-model field (a migration and a grant-model change). The continuity rule reaches the same outcome from existing facts. It remains the upgrade path if clock independence is required (§2.4).
- *Changing the Authority Engine to prefer newer grants.* The engine is shared by every capability. A narrow rule at the result composition was preferred.

### 2.4 Unchanged

- Revocation and expiry and their semantics. Issuance changes only as described in §2.3 (eligibility held until the grant commits; stale grants revoked, never reused).
- Revocation stays prospective and is evaluated as of the command's transaction time (BRT-03). A use whose transaction began before a concurrent revocation was recorded is decided as of that earlier time. This is recorded as a known residual, not changed here.
  - **Residual: backwards clock steps.** The same as-of rule means a database clock that steps backwards can hide a committed revocation for the length of the step. In WP-P0-3 testing, a submit that began 2.5 s (host time) after a committed revocation was stamped 0.11 s *before* it, and was authorized. The development VM clock was observed stepping back by about 2.6 s. Managed production databases are not expected to step like this. Hardening (for example, evaluating revocations as known at statement time, or a monotonic transaction time) belongs to BRT-03, not here.
  - **No such window for the staff role.** The role check of §2.1 reads current committed facts under locks, not facts as of the transaction time, so a clock step cannot hide a demotion.
  - **Residual: concurrent eligibility changes on different bases (Q3 not fully enforced).** The continuity rule orders events by `recorded_at`, which is each transaction's start time. Commit order within one entity is restored from `seq` (above). Across different entities there is no common commit order, and no clock step is needed for the timestamps to disagree with it. Two cases:
    - A demotion and a re-promotion that run concurrently on different bases. Example: the explicit OWNER assignment starts before the organization ADMIN membership's end and commits after it. The history then shows overlapping spans, and an earlier grant counts as continuous although the person was briefly ineligible in commit order. The D-16 gate itself refused them during that moment.
    - A demotion and a re-promotion that both start while an issuance holds the eligibility keys, so both wait behind it. Both can be stamped before the new grant they commit after.

    Both need two eligibility changes for the same person to overlap in time (two staff or roster commands in flight together, or both racing an issuance). Sequential lifecycles, including every case the tests exercise, are enforced. Closing this exactly needs an ordering that does not depend on transaction start times: binding each grant to the eligibility basis it was issued under (a table or grant field, so a migration and a grant-model change), or an eligibility epoch per (competition, person) incremented in the same transaction as every loss. **Recommended as a separate security remediation;** it is not done here.
  - **Residual: clock steps.** The same timestamp comparison means a backwards clock step between a grant and a later re-promotion can make the stale grant look fresh, or a fresh grant look stale. The second case fails closed. Comparisons are exact at the stored millisecond precision (`platform.tx_time_ms`).
  - **Residual: over-denial with grants from other sources.** The engine tries candidate grants oldest first and returns the first valid one. The issuance revokes stale grants only from the same PLATFORM grantor, for exactly the competition scope. A stale grant from another source therefore keeps being chosen, and refused, even after a fresh ADR-0077 grant exists. This fails closed. Production has one source, the ADR-0077 command. Otherwise the operator revokes the other grant.
  - **Residual: the issuance hold.** The hold keeps the shared eligibility keys while the issuance commits other transactions on another pool connection. Nothing in it takes those keys. If a future change made an inner call take one, even shared, it could queue behind a waiting exclusive holder and hang in a way the database cannot detect. Any change to the issuance body must keep that property.
- The participation conflict checker and its pre-transaction read (ADR-0077 §3, "small time-of-check window").
- The D-14 lifecycle precondition, D-15/D-18 score-sheet validation, idempotency, audit and the public read paths.

## 3. Consequences

- **Benefit:** a demoted or removed person can no longer change results with a grant issued for their previous role, and re-promotion does not silently restore it.
- **Cost: write serialization.** Result writes by members of one organization serialize briefly with that organization's roster changes. Shared mode lets result writes run concurrently with each other.
- **Cost: an extra read.** Each result write performs one more read of the staff and membership facts.
- **Rollout:** before deploying, list (read-only) the active result grants whose holder is no longer OWNER/ADMIN, or whose holder's eligibility was interrupted after issuance. Those holders lose result access at deploy time, which is the intended effect. The operator then revokes their grants, and issues fresh ones to people who should keep acting.
- **Operations:** after any demotion, the operator still revokes (runbook). After a re-promotion, the operator issues a fresh grant under a new governance decision. Re-using the old decision is refused.
- **Rollback:** revert. No schema changes. Stale grants revoked by issuance stay revoked (prospective, audited), which is correct under either version.
