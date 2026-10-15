# LAUNCH-02 — Production foundation and results authority

| | |
|---|---|
| ADR | [0077](../adr/ADR-0077-governance-issued-competition-result-authority.md) |
| Operations | [LAUNCH-02 production runbook](../operations/LAUNCH-02-PRODUCTION-RUNBOOK.md) |
| Out of scope | Results/scheduling/operations UI, tournament website, page builder, payments, BRT, XRPL, Lightning, blockchain, Verified-tier features |

## 1. What this slice makes real

A real organizer's tournament staff can run the ADR-0064 result lifecycle (`SUBMITTED → PROVISIONAL → OFFICIAL`, plus atomic corrections) in production. The authority path has no demo CLI, seed, fixture or SQL shortcut:

```
governance decision ─▶ pnpm authority:results bootstrap-anchor   (once: PLATFORM anchor)
governance decision ─▶ pnpm authority:results grant              (per competition, per OWNER/ADMIN)
                         └─ preconditions: competition PUBLISHED/ACTIVE · grantee OWNER/ADMIN staff ·
                            grantee not a participant · grantor is the anchored PLATFORM principal
API result routes ─▶ staff gate (COMP_VIEW_PRIVATE) ─▶ ResultLedger ─▶ Authority Engine
                         └─ conflict check: competition-participation/1 (database facts, per action)
```

## 2. Authority model

| Question | Answer |
|---|---|
| Trust anchor | One PLATFORM principal, recognized at `recognitionLevel: [PLATFORM]` under a governance decision reference |
| Grant | PLATFORM → the staff member's own PERSON principal |
| Capabilities | `SUBMIT_RESULT`, `ACCEPT_RESULT`, `DECLARE_OFFICIAL`, `CORRECT_RESULT` |
| Scope | `{ recognitionLevel: [PLATFORM], competition: [C] }`. One competition. The scope algebra has no organization dimension, so nothing wider is possible without a federation |
| Delegation | None |
| Trigger | An explicit operator act (`authority:results grant`). **No lifecycle event and no staff assignment creates authority**: BRT-05 §5 and ADR-0064 §7 are unchanged, and `competition-authority.int.test.ts` still proves it |
| Eligibility | OWNER or ADMIN of the competition (organizer-organization role or explicit staff). REGISTRATION_MANAGER and SCHEDULER never qualify |
| Issuer authorization | Only the operator command can reach `ResultAuthorityGovernance`. No HTTP route issues, revokes or lists authority (`check-no-manual-authority` guard + route inventory test) |
| Idempotency | An equivalent active grant converges (`created: false`). The idempotency key is per governance decision, so concurrent runs create one grant. A spent decision cannot re-grant after revocation |
| Audit | Grant fact + ledger stream + `AuthorityGrantIssued`/`Revoked` outbox events + `platform.audit_event` (`authority.result-grant.issued` / `already-held` / `revoked`, `DENIED` refusals) carrying the governance reference; ids only |
| Revocation | `authority:results revoke`: prospective BRT-03 revocation by the platform grantor. Losing the staff role blocks API result actions immediately through the staff gate; the grant itself is revoked explicitly by the operator (runbook §6) |
| Isolation | Scope `SCOPE_NOT_COVERED` for any other competition, including the same organizer's. The hierarchy validator refuses borrowed ancestry. The staff gate refuses other organizations (IDOR) |
| Conflict of interest | `competition-participation/1` (`packages/persistence/src/competition-participation.ts`). CONFLICTED when the actor's athlete has any registration, participant entry, membership of a registered team, roster entry or lineup entry in the competition. CLEAR otherwise. UNAVAILABLE for any other principal or scope. The production API enables it (`resultParticipationIndex`) |

Unchanged: the ResultLedger, transitions and capabilities, the staff gate, the caller-derived PERSON principal, `CompPermission ∩ Capability = ∅`, and the demo, seed and test authority fixtures.

## 3. Production foundation

| Area | Change |
|---|---|
| Least-privilege credentials | `apiDatabaseUrl`, `vaultDatabaseUrl`, `workerDatabaseUrl`, `ownerDatabaseUrl`, `adminDatabaseUrl`: each production process needs only its own login (previously every process needed all seven URLs, admin included) |
| Production bootstrap | `NODE_ENV=production pnpm db:bootstrap`: one named database, explicit passwords of at least 24 characters per login (`productionRolePasswords`), no development fallback, no test database |
| API startup | `loadApiRuntimeConfig` refuses production without Supabase auth, the API/vault URLs or an explicit non-development signature audience, and refuses development-only variables |
| API headers | Baseline CSP / anti-framing / nosniff / CORP on every response (route-specific headers kept); HSTS in production; no CORS |
| Readiness | `/ready` also checks the vault login (`vault_database_unavailable`). The worker gains `--check` (database, migrations, consumer table) and `BR_WORKER_REQUIRED_CONSUMERS` |
| Web headers | CSP, anti-framing, nosniff, Permissions-Policy, HSTS (production) via `next.config.ts` |
| Containers | `Dockerfile` (`api`, `worker`), `.dockerignore` allowlist, `containers.yml` (build + fail-closed smoke, no push) |
| Migrations | `db-migrate.yml`: manual, per GitHub Environment, optional catalog provisioning |

## 4. Tests

| Test | Proves |
|---|---|
| `packages/persistence/src/result-authority.int.test.ts` | Anchor idempotency and revoked-anchor refusal. Exact grant document (capabilities, scope, no delegation, constraints). Audit, outbox and ledger stream. All four capabilities authorize over a C1 contest, none over sibling C2, no ratification. Sequential and concurrent convergence to one grant. Refusal of REGISTRATION_MANAGER, SCHEDULER, a stranger, another organization's OWNER and an account without a person, each audited with no grant written. Participant refused, the same person allowed elsewhere. DRAFT competition, non-PLATFORM and unanchored grantors refused. Prospective revocation, list status, spent-decision refusal and re-grant |
| `apps/api/src/launch02.int.test.ts` | Over HTTP with the production composition: staff without a grant denied. OWNER submits and accepts, ADMIN declares OFFICIAL, correction plus re-officialization. Other organization and registration manager denied. The pre-LAUNCH-02 composition still fails closed (`CONFLICT_CHECK_UNAVAILABLE`). A participating ADMIN is refused acceptance (`CONFLICT_OF_INTEREST`). An ended staff role is refused (`FORBIDDEN`). No grant or anchor route exists |
| `competition-participation.test.ts`, `launch02-config.test.ts`, `apps/api/src/config.test.ts`, `apps/api/src/server-hardening.test.ts`, `apps/worker/src/config.test.ts`, `apps/web/app/_lib/security-headers.test.ts` | Checker semantics. Per-login URLs and production passwords. API configuration refusals. `/ready` 503, headers and absence of CORS. Required worker consumers. Web CSP |
| `tooling/guards.test.ts` (`check-no-manual-authority`) | The guard passes on the repository and catches grant calls in apps, grant routes, raw `authority.*` writes and governance use outside its command |
