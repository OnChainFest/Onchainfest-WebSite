# ONCF-00A — Platform Reuse Audit (pre-implementation)

| | |
|---|---|
| Date | 2026-10-06 |
| Branch audited | `feat/oncf-00r-platform-core-consolidation` @ `c41bc50` (PR #5, open) plus `origin/main` @ `1fbb6bf` and `origin/feat/auth-onboarding-foundation` @ `b233abf` (PR #7, draft) |
| External repos | PMFreak `Republika-Network/pmfreak` `main` @ `97a3bb57`; HRkey `Republika-Network/HRkey-App` `main` @ `dcf5540` (read-only clone) |
| Builds on | [ONCF-00](./ONCF-00-ARCHITECTURE-AND-REPOSITORY-BOUNDARIES.md) and [ONCF-00R](./ONCF-00R-PLATFORM-CORE-CONSOLIDATION.md). This document re-verifies their claims against current code and adds what changed since: PR #6, PR #7, PMFreak and HRkey. |
| Changes made | This document only. Nothing was pushed, merged, installed or run against a database. |

---

## 1. What changed since ONCF-00R (read this first)

1. **A second auth stack is in flight: PR #7 `feat/auth-onboarding-foundation` (draft).** It conflicts with the platform core:
   - It adds a separate root-level Next.js app with `npm`, its own `package.json` (`onchainfest-web`, Next 16.3.2) and `src/app/*`. The pnpm workspace root `package.json` and `apps/web` (Next 16.3.6) already occupy that space, so the two cannot coexist on merge.
   - It uses Supabase Auth directly from Next. Nothing reaches the API's `AuthAdapter`, `identity.account` / `auth_identity`, `POST /v1/persons`, `/v1/athletes` or `/v1/organizations`.
   - The organization exists only as `user_metadata.organization_name`. The account type is `user_metadata.account_type`, which users can edit themselves: the same anti-pattern found in both PMFreak and HRkey (§7).
   - The onboarding screens are inert placeholders: "Continue · wiring next", with no persistence.
   - **Its parts are reusable (UI, flow shape, Supabase SSR client, safe redirect). Its architecture is a parallel implementation and must not merge as is** (§9).
2. **The repository is public and the platform core is already published.** `OnChainFest/Onchainfest-WebSite` is `PUBLIC` (`gh repo view`). The ONCF-00R branch is pushed as PR #5, so the formerly private `bragging-rights` source, history and `docs/security/*` threat reviews are now public. ONCF-00R §7.2 says "repository stays private", which is incorrect. Its P0 visibility decision has in effect been made by the push. **The owner must confirm this is acceptable.** No secret values were found; the dev credentials in `.env.example`, `docker-compose.yml` and `ci.yml` are documented as dev-only.
3. **PR #5 CI is green, including integration tests.** `foundation (node 22)` and `(node 24)` pass, and that job bootstraps a disposable Postgres and runs `test:integration`. This resolves the ONCF-00R §11 "integration not run" gap. Only the `vercel preview` job fails, at its `Deploy (preview)` step. The uncommitted change to `.github/workflows/vercel-deploy.yml` (check out the PR head SHA, not the merge commit) targets that failure; it is not yet committed or verified.
4. **`origin/main` moved to `1fbb6bf` (PR #6, visual-first homepage).** The new homepage still says "Coming soon" on Prizes, step 03 "Celebrate" and step 04 "Athletes · coming soon" (`index.html:428,468,474`). Its CTAs are still `contact.html` only: no sign-in, sign-up or app link. PR #5's `index.html` is the pre-PR-#6 version, so PR #5 needs a rebase or merge of `main` before merging.
5. **One ONCF-00 claim is out of date:** invitation acceptance **does** exist over HTTP (`POST /v1/invitations/accept`, `/decline`, SELF; `apps/api/src/v1.ts:473-480`). Only email delivery is missing.

---

## 2. Current architecture map

```text
                         onchainfest.xyz  (Vercel project onchainfest-web-site, static)
                         ├─ index.html, contact.html, img/   ← public marketing site (LIVE)
                         └─ deployed by .github/workflows/vercel-deploy.yml (.vercelignore allowlist;
                            artifact-verify step rejects anything else)

  pnpm workspace (NOT deployed anywhere)
  ┌───────────────────────────────────────────────────────────────────────────────────┐
  │ apps/web    @br/web     Next 16.3.6, 17 read-only public pages, no auth, no forms  │
  │                         server fetch → BR_API_URL (default http://127.0.0.1:4000)  │
  │ apps/api    @br/api     Fastify 5, 146 /v1 routes + /health /ready                 │
  │                         AuthAdapter seam: prod = failClosedAuth, dev = HMAC tokens  │
  │ apps/worker @br/worker  outbox consumers: achievements.derive, records.evaluate,    │
  │                         rankings.react, dev.event-log                               │
  │ packages/   canonical domain schemas · identity authority · competition ·          │
  │             evidence verification · achievements records rankings ·               │
  │             persistence (Kysely stores, migrations runner) · testkit              │
  │ db/         migrations 0001–0030, bootstrap (35 roles), docker init               │
  └───────────────────────────────────────────────────────────────────────────────────┘
                 │ PostgreSQL 18 (local docker / CI service container only)

  In flight, outside the workspace: PR #7 root Next app + Supabase Auth (§1.1)
```

---

## 3. Audit by area

Maturity legend:
- **Ready**: code, tests and CI green; usable once deployed.
- **Backend-only**: API exists; there is no UI and no hosted deployment.
- **Partial**: material gaps.
- **Absent.**

| # | Area | Status | Evidence | Gap |
|---|---|---|---|---|
| 1 | Public website | **Ready (live)** | `index.html` (`origin/main` 1fbb6bf), `contact.html`, Vercel CLI workflow | "Coming soon" copy (§1.4). `mailto:` contact form. No link to the app. PR #5 is behind `main`. |
| 2 | Platform core | **Ready as code, not deployed** | 146 routes; 40 unit test files (689 tests) and 39 integration files, all green in CI | No hosting for the API, worker or Postgres. No KMS (private-data routes return 503 in production, `apps/api/src/main.ts:41-46`). No evidence blob store (503, `:48-51`). |
| 3 | Auth / identity seams | **Partial: seam ready, no IdP** | `AuthAdapter` (`apps/api/src/auth.ts:11-14`). `IdentityStore.signIn` auto-provisions an account and `auth_identity`, idempotently (`packages/persistence/src/identity-store.ts:120-160`). `AuthContext` (`packages/identity/src/auth.ts:8-17`). | Needs a real IdP adapter, web sign-in/up and session handling, and an `/app` boundary |
| 4 | Org / membership / permissions | **Backend-only** | `POST /v1/organizations` (AUTHENTICATED). Members, profile, invitations, accept/decline, role and status changes. 7 `OrgPermission`s with role mapping (`packages/identity/src/permissions.ts`). 9 endpoint classes (`v1.ts:24-37`). | UI. Email delivery for invites. Cross-org negative tests per route (no RLS by design). |
| 5 | Athlete / passport / profile | **Backend + read-only page** | `POST /v1/persons`, `POST /v1/athletes` (GUARDIAN), profile, slug, external ids, guardians, wallet links (EIP-191). `apps/web/app/athletes/[slug]`. | Self-service onboarding UI. Privacy controls UI. Production PII cipher. |
| 6 | Competition / tournament / event | **Backend-only** | `v1-competition.ts` (51 routes): create, publish/activate/complete, events, registration windows | Organizer UI. A real sport catalog (seeds are only `padel.doubles` and `running.5k`). |
| 7 | Registration / bracket / result / verification | Registration and brackets **backend-only**. **Results: Partial (largest gap).** Verification **backend-only**. | SELF registration, staff decisions, seeding, single-elimination and round-robin plans, scheduling, lineups. Verification engine V0–V4 (production ceiling V1). | **No HTTP route submits or accepts results.** The ledger stops at PROVISIONAL (`result-ledger.ts:128,543`). T5 (PROVISIONAL→OFFICIAL), T6 (→FINAL), T7 and T8 are not implemented (`packages/domain/src/results.ts:28-31`). There is no authority-grant API. Contest complete returns `SOURCE_NOT_IMPLEMENTED` (`v1-competition.ts:834-838`). |
| 8 | Achievements / rankings / records ("Bragging Rights" work) | **Backend-only, engines complete** | Packages, worker consumers, public read routes, 4 web surfaces | Produces **zero canonical output** until results reach OFFICIAL (depends on #7). No rewards or prizes engine. No token code (correct per constraints). |
| 9 | Frontend screens | **Partial** | `apps/web`: 17 public read pages (athletes, organizations, competitions, events, rankings, records, hall of fame, verifications, attestations). PR #7: signup chooser, athlete and org signup, sign-in, confirm email, pricing, 2 placeholder onboarding pages. | No authenticated pages anywhere in the workspace. No organizer or athlete app. |
| 10 | DB / schema / API boundaries | **Ready** | Schema per module, append-only status tables, hash-chained ledger, outbox, idempotency, 35 DB roles, many `BR_*_DATABASE_URL`s | Managed-Postgres provider not chosen (needs ~35 roles, `SECURITY DEFINER`, session pooling; ONCF-00R §14). |
| 11 | Tests and CI | **Ready** | `ci.yml` `foundation` matrix (Node 22/24): format, lint, 6 guards, typecheck, unit, vectors, bootstrap, migrate, integration, demos, seed idempotency, worker smoke, web build. `vercel-deploy.yml`. GitGuardian. | The preview deploy fails (§1.3). CI does not run the BRT-08/09/10 demos. PR #7 has no tests and is not part of CI. |
| 12 | PMFreak patterns | **Proven, reusable with adaptation** | §7.1 | Must not copy its known defects (§7.1) |
| 13 | HRkey patterns | **Partially reusable** | §7.2 | Several insecure patterns (§7.2) |

---

## 4. Production-ready (today)

- The public static website and its CI/CD to Vercel. Production deploys on push to `main`; preview deploys are pending the §1.3 fix.
- The platform core **as code**: domain packages, migrations, API, worker, guards, golden vectors and CI. It is not production-ready as a **service**, because it has no IdP, no hosting, no KMS and no blob store.

## 5. Partial

- Auth: the seam exists, but no IdP is wired in. PR #7 is a disconnected Supabase flow.
- Results lifecycle: stops at PROVISIONAL. It has no submit or accept route and no grant API.
- Verification: production ceiling is V1.
- Achievements, rankings and records: complete engines with no real input, because of the gap above.
- Org public pages and the passport: read-only; no builder or branding.
- Invitations: the accept route exists, but nothing delivers the email.

## 6. Missing

- An IdP adapter, web session handling, sign-in/up/reset in the workspace web app, and an `/app` route boundary.
- Every authenticated screen: athlete onboarding and home, organizer onboarding, org admin, tournament creation, registration management, draws, results entry and verification queue.
- Result submission and acceptance routes, OFFICIAL/FINAL transitions, and authority-grant issuance.
- Hosting for the API, worker and Postgres. A KMS for the PII cipher and an evidence blob store.
- Transactional email (invites, confirmations).
- Payments and subscriptions (PR #7 pricing page is a shell), a rewards/prizes engine, and dashboards.
- Explicitly out of scope: $BRT tokenomics, minting and contracts.

---

## 7. Reusable auth patterns from PMFreak and HRkey

Both products use **Supabase Auth** (email/password; HRkey also uses Google OAuth). PMFreak's `@supabase/ssr` and Next 16 versions match PR #7 exactly.

### 7.1 PMFreak (`Republika-Network/pmfreak` @ 97a3bb57)

| Pattern | File | Verdict |
|---|---|---|
| Copy rotated refresh-token cookies onto every redirect | `src/proxy.ts:36-40` | Reuse |
| Route-policy table, protected by default; API routes authenticate per handler | `src/lib/auth/route-policy-registry.ts` | Reuse |
| `next=` validation (control chars, `//`, origin parse, blocklist + allowlist) | `src/lib/auth/validate-continuation-route.ts:10-31` | Adapt. It is stronger than PR #7's `safe-redirect.ts`. |
| Pure post-auth destination function (unfinished onboarding overrides `next`) | `src/lib/auth/resolve-post-auth-destination.ts` | Reuse |
| Onboarding state **derived from real rows**, never a "completed" flag | `resolve-onboarding-state.ts`, `onboarding-route-map.ts` | Adapt: derive from `/v1/me` (account → persons, athletes, memberships) |
| Signup role pinned to the minimum | `signup/build-signup-profile.ts` | Reuse |
| POST-only logout | `app/logout/route.ts` | Reuse |
| Hashed, single-use, email-bound invites | `lib/workspace-team.ts` | Already present in the core (`organization-store.ts:41-42,374-388`), so **do not rebuild**. Add the email-match check if it is missing. |
| Stripe webhook verification plus idempotent event ledger, billing separate from auth | `stripe-webhook-verification.ts`, `billing.ts` | Adapt later (payments step) |
| **Do not copy** | Billing keyed on user-editable `user_metadata.company_id` (IDOR); admin by email domain (includes `@onchainfest.xyz`); unverified `getSession()` fallback in the proxy; no rate limit on `/api/login`; client-side password reset with no recovery-session check; service-role reads during onboarding | — |

### 7.2 HRkey (`Republika-Network/HRkey-App` @ dcf5540)

| Pattern | File | Verdict |
|---|---|---|
| Bearer token → IdP verify → internal user → `req.user` | `backend/middleware/auth.js:61-147` | Adapt. **This is the shape of the OnChainFest `AuthAdapter`.** Verify the JWT locally (JWKS) and resolve through `IdentityStore.signIn`. Never default a role when the internal record is missing. |
| Role and ownership guards | `backend/middleware/auth.js:156-330` | Concept only. The core already has endpoint classes and `OrgPermission`. |
| Account-type-aware post-auth router (type → onboarding complete? → dashboard) | `HRkey/src/lib/auth/profile-service.ts:60-90` | Adapt: decide from server rows, not metadata or localStorage |
| Test-auth bypass behind two flags | `auth.js:44-82` | Not needed. The core already has fail-closed dev HMAC tokens and injectable adapters. |
| One wallet per user / one user per address | `walletsController.js:74-110` | The core already has EIP-191 wallet linking. Do not rebuild. |
| **Do not copy** | localStorage-only session with a no-op middleware; service-role Next routes that take `userId` from the body; open-INSERT and self-referencing RLS; custodial keys encrypted with a key derived from `userId` and a static salt; wallet signatures with no nonce, and smart-wallet linking unverified; account type taken from localStorage or `user_metadata` | — |

---

## 8. Reuse vs extend

| Reuse as is | Extend |
|---|---|
| `identity.account` / `auth_identity` and `IdentityStore.signIn` (auto-provisioning) | `apps/api/src/auth.ts`: add a Supabase JWT `AuthAdapter` (JWKS verify, then `signIn({provider:'supabase', providerSubject: sub, emailVerified, method:'EMAIL_LINK'|'OIDC'})`). The method enum may need a `PASSWORD` value; that is a small decision. |
| Endpoint classes, `OrgPermission`, membership roles | `apps/web`: add sign-in/up/callback/logout, session proxy and `/app/**`. Port PR #7's screens and CSS, and PMFreak's session patterns. |
| `/v1/persons`, `/v1/athletes`, `/v1/organizations`, invitations accept/decline | Onboarding resolver over `/v1/me`. Extend `/v1/me` only if it doesn't already return persons, athletes and memberships. |
| Competition, registration, draw and scheduling routes | Organizer and athlete UIs on top of them |
| Verification, achievements, records and rankings engines and read routes | Results: submit/accept routes, T5/T6 transitions, grant API |
| Outbox, worker, ledger, idempotency | Email delivery consumer (invites) |
| CI workflow and guards | Add `apps/web` auth tests. Add the BRT-08/09/10 demos to CI. |
| Static marketing site | Replace "Coming soon" copy with real links as each capability ships. Add sign-in/sign-up links once `/app` is live. |

---

## 9. Boundary recommendation for PR #7 (decision needed)

Keep the marketing site and the application separate, as you asked:

- **Marketing:** stays the static site on `onchainfest.xyz`, deployed exactly as today. Do **not** wrap it in a Next app with a `/` → `home.html` rewrite, as PR #7 does. That couples the two.
- **Application:** `apps/web` in the pnpm workspace, deployed as its own Vercel project (for example `app.onchainfest.xyz`). Auth, onboarding and `/app/**` live there.
- **IdP:** Supabase Auth is the pragmatic choice. It is already proven in PMFreak and HRkey, and PR #7 already uses it. Use it **only as the IdP**: identity, organizations, athletes and roles stay in the platform Postgres through the API, and `user_metadata` is never trusted for authorization. This choice is not yet recorded in an ADR; record it as part of ONCF-01.
- **PR #7:** do not merge it as is. Move its UI into `apps/web` and wire every step to `/v1` routes. Then close the PR.

---

## 10. Recommended implementation order

0. **Gates (no feature code):**
   - (a) Confirm that the public visibility of the platform source is acceptable (§1.2).
   - (b) Commit and verify the `vercel-deploy.yml` preview fix.
   - (c) Bring PR #5 up to date with `main` (PR #6 homepage), then review and merge it.
   - (d) Freeze PR #7 as reference only.
   - (e) Pick hosting for the API, worker and Postgres (ONCF-00R §14 role requirements) and a KMS for the PII cipher. This blocks any live login, because private-data routes return 503 without a cipher.
1. **ONCF-01 Auth:**
   - Supabase JWT `AuthAdapter` in `apps/api` and `IdentityStore.signIn`, with tests using an injected JWKS.
   - In `apps/web`: sign-up (athlete or organization chooser), sign-in, confirm, callback, POST logout, reset with recovery-session check, and rate limiting.
   - A Next proxy with a protected-by-default `/app/**` and PMFreak's cookie-on-redirect fix.
2. **ONCF-02 Onboarding:**
   - A resolver derived from rows.
   - Athlete path: `POST /v1/persons` → `POST /v1/athletes`.
   - Organization path: `POST /v1/organizations`.
   - Organization pricing and payment stays a separate later step and is not a sign-up gate.
3. **ONCF-03/05 Organization admin:** profile, members, roles, invitations. Add an email delivery consumer and the accept-invite page. Add cross-org negative tests.
4. **ONCF-06/07 Tournaments:** organizer create, edit and publish of competitions and events, and real sport catalog entries (padel, tennis). Public pages already exist; restyle them.
5. **ONCF-08 Registration:** athlete self-registration and staff decisions UI. Decide whether entry-fee payments move forward.
6. **ONCF-09 Competition operations:** seeding, draw, plan generation, schedule and lineups UI.
7. **ONCF-10 Results & verification (largest backend gap):**
   - result submit and accept routes;
   - T5/T6 OFFICIAL/FINAL transitions;
   - authority-grant issuance API;
   - production evidence blob store;
   - results entry and verification UI.
8. **ONCF-11/12 Rankings, achievements and history:** these light up automatically once results reach OFFICIAL. Add athlete history and rankings in the app.
9. **ONCF-13/14 Dashboards.** Then rewards (ONCF-15) and payments (ONCF-18). Bragging Rights and $BRT stay deferred.

---

## 11. DO NOT REBUILD

- Accounts, auth identities, persons, athletes, guardians, PII vault (`packages/identity`, migration `0004`)
- `AuthAdapter` seam, endpoint classes, `OrgPermission`, membership roles
- Organizations, memberships, invitations **including accept/decline**, and hashed invite tokens
- Wallet linking with EIP-191 proof
- Sport catalog, competitions, events, registration with capacity and waitlist, teams, lineups
- Single-elimination and round-robin engines, deterministic draw, contest scheduling
- Results ledger (extend it; do not replace it)
- Evidence, attestations, verification engine V0–V4
- Achievements (incl. QUALIFIED), records and hall of fame, rankings and classifications
- Public read pages in `apps/web` (passport, organizations, competitions, rankings, records)
- Outbox, worker, jobs, idempotency, hash-chained ledger, migration runner, testkit, CI guards
- The public marketing site and its Vercel deploy workflow
- A second Next.js app or a second auth or user model (PR #7's root app, Supabase `user_metadata` as the source of truth)

## 12. NEXT IMPLEMENTATION

1. Commit the `vercel-deploy.yml` preview fix. Update PR #5 with `main`, get it green, then review and merge.
2. Confirm repo visibility. Choose API/worker/Postgres hosting and the PII KMS.
3. Write the ONCF-01 ADR: Supabase Auth as IdP only, mapped through `AuthAdapter` → `IdentityStore.signIn`.
4. Implement `SupabaseJwtAuthAdapter` in `apps/api/src/auth.ts`, with unit and integration tests.
5. Port PR #7's auth screens into `apps/web`, adding PMFreak session, proxy, `next=`, logout and reset patterns, and the `/app/**` boundary.
6. Build the onboarding resolver from rows, wiring athlete onboarding to `/v1/persons` + `/v1/athletes` and organization onboarding to `/v1/organizations`.
7. Close PR #7 once its UI has been ported.
