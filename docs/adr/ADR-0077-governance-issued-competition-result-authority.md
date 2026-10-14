# ADR-0077 — Governance-issued competition result authority

- **Status:** Accepted (frozen for LAUNCH-02)
- **Date:** 2026-10-14
- **Origin:** LAUNCH-02 (production foundation and results authority). Builds on [ADR-0004](./ADR-0004-scoped-authority-and-delegation.md), [ADR-0020](./ADR-0020-three-layer-authorization.md), [ADR-0025](./ADR-0025-explicit-competition-hierarchy-resolution.md), [ADR-0027](./ADR-0027-person-principal-and-issuer-representation.md) and [ADR-0064](./ADR-0064-official-results-and-atomic-corrections.md). **No earlier ADR is edited.** This ADR adds a production issuance path inside the existing model. It does not change who may hold authority or how authority is evaluated.

## 1. Context

ADR-0064 made the result lifecycle real behind two gates: the competition-staff gate (`COMP_VIEW_PRIVATE`) and Authority Engine grants for the contest's exact hierarchy path. Two gaps keep a real organizer from using it in production:

1. **No production issuance path.** The only code that recognizes a trust anchor or issues a grant lives in demos, seeds and tests (`demo-foundation.ts`, `seed-dev.ts`, `seed-evidence.ts`, `oncf05d.int.test.ts`).
2. **No production conflict-of-interest source.** The production API passes no `resultConflictChecker`. Every capability except `SUBMIT_RESULT` is conflict-sensitive (BRT-03R), so `ACCEPT_RESULT`, `DECLARE_OFFICIAL` and `CORRECT_RESULT` always fail closed with `CONFLICT_CHECK_UNAVAILABLE`, even with a valid grant. BRT-05 §6 recorded the participation-backed checker as deferred.

The architecture forbids the shortcut of deriving authority from staff roles:

- ADR-0064 §7: operational permissions never become sporting authority;
- BRT-02 §3.2: a dashboard ADMIN membership alone gives no authority, and the first grant is a governance-approved bootstrap;
- `packages/competition/src/permissions.ts`: no function maps `CompPermission` onto `Capability`;
- `competition-authority.int.test.ts`: competition operations create no grants or anchors.

## 2. Decision

### 2.1 Platform trust anchor

1. The platform's root is one PLATFORM principal recognized as a trust anchor at `recognitionLevel: [PLATFORM]` only (BRT-03 `ANCHOR_LEVEL_FORBIDDEN` is unchanged).
2. It is created by an **operator command** (`pnpm authority:results bootstrap-anchor`) that requires a `governanceDecisionRef` and a `basisRef`. These references are format-validated (3–128 characters from `[A-Za-z0-9._:/-]`, which also keeps personal data out) and recorded on the anchor and in the audit trail. The system does **not** verify that a matching governance record exists or who approved it (§2.7).
3. The command is idempotent by `governanceDecisionRef`. Running it again returns the existing anchor. A revoked anchor is reported, never silently replaced.

### 2.2 Competition result grant

| Field | Value |
|---|---|
| Grantor | the anchored PLATFORM principal |
| Grantee | the staff member's own PERSON principal (`identity.ensure_person_principal`, SELF person; ADR-0027) |
| Capabilities | `SUBMIT_RESULT`, `ACCEPT_RESULT`, `DECLARE_OFFICIAL`, `CORRECT_RESULT` (exactly the four that ADR-0064 requires) |
| Scope | `{ recognitionLevel: [PLATFORM], competition: [C] }` (one competition; no organization-wide scope exists in the scope algebra) |
| Delegation | none (`allowed: false`, `maxDepth: 0`) |
| Constraints | `mustNotBeParticipant: true` |
| Validity | from issuance (never backdated), optionally until an explicit `effectiveTo` |

The grant is issued only by `pnpm authority:results grant`, run by a platform operator. **No HTTP route issues, revokes or lists grants.** The `check-no-manual-authority` guard enforces this.

### 2.3 Issuance preconditions

All of these are checked in the database, as of the issuance time. Each failure writes nothing except a `DENIED` audit row.

1. The competition exists and is `PUBLISHED` or `ACTIVE`. A `DRAFT`, `COMPLETED` or `CANCELLED` competition is refused (`COMPETITION_NOT_OPERATING`).
2. The grantee account is active and currently holds the **OWNER or ADMIN** staff role of that competition, either as explicit competition staff or as OWNER/ADMIN of the organizer organization (`competitionPermissions`). REGISTRATION_MANAGER and SCHEDULER never qualify (`NOT_RESULT_STAFF`).
3. The grantee's SELF person does not participate in the competition (§2.5; `GRANTEE_PARTICIPATES`).
4. The grantor is a PLATFORM principal. The BRT-03 issuance validation then proves the anchor chain, scope and validity, unchanged.

**The staff role is an eligibility precondition, not the source of authority.** Authority exists only as the recorded grant. A staff assignment never creates a grant (the existing invariant test still holds). An operator act, carrying a governance reference, does.

### 2.4 Idempotency, audit and revocation

- **Convergence.** If the grantee already holds an active grant from the platform principal with exactly this scope and these capabilities, issuance returns it and creates nothing. Otherwise `issueGrant` runs with the idempotency key `result-authority:<competition>:<principal>:<governanceDecisionRef>`, so a repeated or concurrent command never creates two grants for one reference. Re-granting after a revocation needs a new governance reference.
- **Audit.** Each act appends to the existing ledgers: the grant fact, its ledger stream and the `AuthorityGrantIssued` / `AuthorityGrantRevoked` outbox events. A `platform.audit_event` row (`authority.result-grant.*`) records the competition, grantee principal, grant ids and `governanceDecisionRef`, with ids only and no PII.
- **Revocation** (`pnpm authority:results revoke`) is ordinary BRT-03 revocation, made by the platform grantor. It is prospective, so results declared before it keep their authorization. It applies to every active grant of that grantee for that competition.
- **Losing the staff role.** Grants are not revoked automatically: the operational and sporting layers stay separate, and nothing in the operational layer writes authority facts. Result actions over the API stop at once anyway, because every result route keeps the staff gate. The operator runbook requires revocation whenever result staff are removed.

- **What the governance reference is.** It is recorded on every anchor and grant act in the audit trail and keys the idempotency above. It is format-validated only. The system does not check that a governance record exists, nor the identity of its approvers. It therefore provides audit correlation and idempotency, **not** an independently enforced governance authorization control. A validated governance-record system with approvers is future work.

### 2.5 Competition participation conflict checker

`competition-participation/1` is a `ConflictOfInterestChecker` built per result action from database facts read just before the ledger call:

- **CONFLICTED** when the actor's athlete has any registration, participant entry, team membership in a registered team, frozen roster entry or declared lineup entry in **any** event of the contest's competition. This is BRT-01 rule 7 (SELF_PARTICIPANT, TEAM_MEMBER_OF_PARTICIPANT, LINEUP_MEMBER_OF_PARTICIPANT), widened to the whole competition and including withdrawn or declined entries. Being over-inclusive can only deny.
- **CLEAR** when none of these exists. A person without an athlete cannot be a participant.
- **UNAVAILABLE** for any other principal, or for a scope that is not exactly that competition. This fails closed.

The production API enables it explicitly (`resultParticipationIndex`). An explicitly injected checker (tests) still takes precedence. Without either, behaviour is unchanged: conflict-sensitive actions fail closed. The same check gates issuance (§2.3.3).

### 2.6 What stays unchanged

- The ResultLedger, the T2 / T3 / T5 / T7 transitions and their capabilities, the hierarchy scope validator (`SCOPE_HIERARCHY_MISMATCH`), the staff gate and the caller-derived PERSON principal.
- `CompPermission ∩ Capability = ∅`. No staff role is authority-bearing.
- Demo, seed and test authority fixtures.

### 2.7 Trust boundary

- **Who may run the operator command.** The operator is authorized by possession of the API database credential (`BR_API_DATABASE_URL`) and access to a controlled execution environment that can reach the database. Nothing else gates it.
- **No operator identity.** The command does not authenticate an operator identity. It has no MFA and no independent approval step. Audit rows carry no actor account.
- **No new privilege.** Before LAUNCH-02, the API login (`br_api` → `br_authority`) could already write authority facts (principals, anchors, grants) through `AuthorityStore` or SQL. This slice does not create a new privilege escalation, and the command gains nothing the API process lacks.
- **What LAUNCH-02 adds at the application level:**
  - no HTTP issuance path;
  - staff eligibility checks (OWNER/ADMIN of that competition);
  - competition-state checks (PUBLISHED or ACTIVE);
  - participant exclusion;
  - the PLATFORM grantor requirement;
  - auditing and idempotency;
  - the `check-no-manual-authority` guard.

  These controls protect against operator mistakes and against request-path abuse. They do not constrain someone who already holds the API credential and bypasses the command.
- **Future hardening (none of it exists yet):**
  - a dedicated least-privilege authority-operator database login;
  - validated governance records with approvers;
  - operator identity attribution in audit rows.

## 3. Consequences

**Benefits:**

- A real organizer's OWNER/ADMIN staff can submit, accept, declare and correct results in production, scoped to one competition.
- Every grant carries a governance reference recorded in the audit trail. The reference is format-validated, not verified against a governance record (§2.7).
- Cross-competition and cross-organization use is refused by scope (`SCOPE_NOT_COVERED`) and by the staff gate.

**Costs and limits:**

- **Issuance is an operator act, not self-service.** Organization-principal delegation (BRT-02 §3.2 mode B) remains future work.
- **Small time-of-check window.** Issuance preconditions and the conflict snapshot are read in a transaction separate from the grant or ledger write. A registration committed in that window is not seen. The staff gate is re-checked on every request.
- **Same login as the API.** The CLI uses the API database login (`br_api` → `br_authority`, `br_competition`, `br_identity`). It gains no privilege the API process lacks, and the credential remains the effective trust boundary (§2.7). A dedicated authority-operator login is future least-privilege work.
- **PLATFORM-level authority only.** The resulting results are attributable to the platform anchor, so they can never claim NATIONAL / CONTINENTAL / WORLD recognition. That needs a federation anchor.

## 4. Alternatives considered

- **Derive grants automatically from staff roles at a lifecycle event (for example field lock):** rejected. It contradicts ADR-0064 §7, BRT-02 §3.2 and BRT-05 §5, and turns RBAC into authority (ADR-0004).
- **Organization-principal delegation over HTTP:** deferred. It needs a new trust bridge (a membership acting as the organization principal) and a grant endpoint.
- **A competition-wide "staff" permission check inside the ledger:** rejected. It is a second permission system.
