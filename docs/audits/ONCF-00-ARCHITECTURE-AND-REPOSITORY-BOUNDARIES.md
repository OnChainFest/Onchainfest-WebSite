# ONCF-00 — Architecture & Repository Boundaries

| | |
|---|---|
| Status | Audit complete. Awaiting architectural review. |
| Date | 2026-10-05 |
| Scope | Read-only audit of `Onchainfest-WebSite`, `bragging-rights` and related local OnChainFest repositories |
| Changes made | This document only. No code, configuration, dependency, database or deployment changes. |
| Gate | **ONCF-01 BLOCKED.** See §21. |

All paths below are relative to `C:\Users\Usuario\source\OnChainFest\` (WSL: `/mnt/c/Users/Usuario/source/OnChainFest/`) unless stated otherwise.

---

## 1. Executive Summary

The audit found the ecosystem is close to the reverse of what the ONCF plan assumed.

1. **`Onchainfest-WebSite` contains no application.** It is a two-page static HTML site (`index.html`, `contact.html`) on Vercel, with no `package.json`, build, backend, database, auth, tests or CI. Every ONCF capability is absent from this repository.
2. **`bragging-rights` already implements most of the OnChainFest sports domain**, to a high engineering standard. It contains:
   - accounts, persons, athletes and guardians;
   - organizations, memberships and invitations;
   - competitions, events, registration, teams, brackets and schedules;
   - a versioned results ledger;
   - evidence, attestations and verification;
   - achievements, records and a hall of fame;
   - rankings and classifications;
   - a public athlete passport.

   The stack is TypeScript, pnpm workspaces, Fastify, Next.js 16, PostgreSQL 18 and Kysely, with 30 SQL migrations and 50 ADRs. 689 unit tests pass and the workspace typecheck is clean.
3. **`bragging-rights` contains no blockchain code at all.** It has no contracts, minting, NFT or token metadata, chain client or IPFS. The only crypto is EIP-191 wallet proof-of-control used to link a wallet to a person. Its own README says "no smart contracts, no NFTs and no blockchain".

   Measured against the frozen boundary in §1 of the ONCF-00 brief, **about 95% of the implemented Bragging Rights code belongs to OnChainFest**, and 0% of the intended Bragging Rights scope exists yet.
4. **The "Live today" claim on the public site is not backed by any self-service product.** The claim reads: "registration, online entry payments, brackets, results, standings and player pages".
   - The closest implementation is `padelflow`. That is a single-tournament **bowling** app built for *Torneo La Negrita CRCC 2025*, later re-skinned as "PadelFlow".
   - It has critical security defects: an unauthenticated admin area, unauthenticated mutation endpoints, open RLS and plaintext custodial keys.
   - No repository links to `onchainfest.xyz`.
5. **The production site (`main`) still shows the old "OnChainFest Studio – Web3, Automation & AI" positioning.** The sports-tournament repositioning exists only on the unmerged branch `feat/onchainfest-sports-platform-landing`. That branch also presents Bragging Rights as "the engine behind rankings, achievements and athlete history", which contradicts the frozen boundary.
6. **Recommended direction (needs your decision before ONCF-01):** consolidate the `bragging-rights` sports-domain monorepo into `Onchainfest-WebSite` as the OnChainFest platform core, preserving history. Then re-scope Bragging Rights to a small digital-artifact module that receives achievement references and owns only chain/token state.

   Rebuilding the sports domain from scratch, or treating `padelflow` as a foundation, would discard the strongest asset in the ecosystem for the weakest.

---

## 2. Repository Baseline

### 2.1 Local directory reality

`C:\Users\Usuario\source` contains `AOC-Ecosystem`, `KnowledgeNest`, `OnChainFest`, `Republika-Network`, `Wedding-Fran-Marilu`, `alignerr-…`, `lbx-…` and `listalaboda.com`. All OnChainFest repositories live under `source\OnChainFest\`, **not** directly under `source\`:

| Repository | Branch | HEAD | Worktree | Remote |
|---|---|---|---|---|
| **Onchainfest-WebSite** | `feat/onchainfest-sports-platform-landing` | `2f36f616027ce13b89396d97e8ee79965a2c2636` | `?? .gitignore` (pre-existing, untracked) | `github.com/OnChainFest/Onchainfest-WebSite` |
| **bragging-rights** | `main` | `9ad10fdf729c1b67871ef8057fcb30454f6ce813` | clean | `github.com/OnChainFest/bragging-rights` |
| padelflow | `main` | `a43c0d0e062c04f9cc9348b6a50f0a95ac31bb5d` | clean | `github.com/OnChainFest/padelflow` |
| Poker | `main` | `61bef9a0c5af35817291385cec404a8adedcd7ce` | clean | `github.com/OnChainFest/Poker` |
| poker-tournament-backend | `main` | `b1de04b5099cdb9377075e794dc647f992064ff9` | clean | `github.com/OnChainFest/poker-tournament-backend` |
| PadelChain | `main` | `4c92b9cbbda125d9bfb387bf4d894d7c91a72e5c` | clean | `github.com/OnChainFest/PadelChain` |
| StrikeChain | `main` | `33ebfccb416c435384073e3b8066c123e6b5bbc8` | clean | `github.com/OnChainFest/StrikeChain` |
| Sports | `main` | `e50bed42297fc9131df3bae08e1373dc332e923b` | clean | `github.com/OnChainFest/Sports` |
| LaNegrita-db | `main` | `a7c8823dc2c8e8e4c18a88a172da837fcea7e6be` | clean | `github.com/OnChainFest/LaNegrita-db` |
| qr-code-hrke | `main` | `5a77ed75d21b149025b868189031fe6a17f12248` | clean | `github.com/OnChainFest/qr-code-hrke` |
| OLMO-Site---PeerProof | `main` | `1c9552d610c1443e561617a6496eab21efa1f7fa` | clean | `github.com/OnChainFest/OLMO-Site---PeerProof` |
| Art-Tokenization | `feat/at-16b-xrpl-funding-bridge` | `8908cee33e5444fc025b27a361282761943ed555` | clean | `github.com/OnChainFest/Art-Tokenization` (unrelated product; not audited) |

### 2.2 Recent history

**`Onchainfest-WebSite`** (`git log --oneline -15`):

```
2f36f61 Swap athlete image for one without BRT branding
a778327 Reposition landing page around sports tournament customer value
d54c4b4 Update index.html
46fdf49 Update index.html
babfd6b Update index.html
76d61aa Create vercel.json
09a952d Update index.html
50c5036 Update index.html
ad092ee Update index.html
c90e52b Update index.html
e0086f9 Delete style.css
b780987 Delete script.js
709cc7b Delete _redirects
24c4b45 Delete index_mobile.html
a47b6b9 Update Responsive.html
```

- The repository has 153 commits in total, almost all "Update index.html" edits made through the GitHub UI.
- Branch state:
  - `main` is at `d54c4b4`.
  - The feature branch is 2 commits ahead of `main` (`contact.html` +206/-…, `index.html` +2085/-…) and is pushed to `origin`.
  - Remote branches `redesign-mobile-v2`, `rediseño-mobile-v2` and `version-estable-anterior` are abandoned earlier designs.

**`bragging-rights`** (`git log --oneline -15`):

```
9ad10fd Merge pull request #8 from OnChainFest/feat/brt-10-integration-tests
91e47b4 test(rankings): add BRT-10 integrated-system integration tests
a4e626f Merge pull request #7 from OnChainFest/feat/brt-10-ranking-seed-demo
90ce80d feat(rankings): add BRT-10 seed and demo
f49b69c Merge pull request #6 from OnChainFest/feat/brt-10-ranking-guards
5788d62 feat(guards): add BRT-10 ranking guardrails
deec31b Merge pull request #5 from OnChainFest/feat/brt-10-ranking-web
06caced feat(web): add BRT-10 ranking and classification surfaces
5de3166 Merge pull request #4 from OnChainFest/feat/brt-10-ranking-api
6129e7c test(rankings): match SQLSTATE 42501 only as a standalone token in the leak scan
36f5d43 fix(testkit): prevent throwaway database teardown races
e94126a feat(rankings): add BRT-10 ranking and classification API
4b33bd0 Merge pull request #3 from OnChainFest/feat/brt-10-classification-worker
82a1cbd feat(rankings): add ranking worker consumer
8a83162 Merge pull request #2 from OnChainFest/feat/brt-10-qualified-achievement
```

BRT-10 (rankings and classifications) is merged in full (Steps 1–15). No BRT-11+ documents exist.

### 2.3 Worktree safety

- `Onchainfest-WebSite` has one pre-existing untracked file, `.gitignore` (content: `.vercel`, `.env*`). It is not part of this work and was left untouched.
- The local `.env.local` contains only `VERCEL_OIDC_TOKEN`, created by the Vercel CLI. It is ignored and was not read beyond the variable name.
- `.vercel/repo.json` links the directory to the Vercel project `onchainfest-web-site`.
- Creating `docs/audits/` cannot interfere with any in-progress work. There is no other uncommitted work, and no build reads `docs/`.

---

## 3. `Onchainfest-WebSite` Current Architecture

| Concern | Reality | Evidence |
|---|---|---|
| Framework | None. Hand-written static HTML with inline `<style>` and one inline `<script>`. | `index.html` (1,667 lines), `contact.html` (181 lines) |
| Language | HTML, CSS and roughly 35 lines of vanilla JS (mobile menu toggle) | `index.html:1627-1663` |
| Package manager / build | **None.** There is no `package.json`, lockfile, bundler or `tsconfig`. | `git ls-files` (19 files) |
| Repository structure | `index.html`, `contact.html`, `favicon.ico`, `logo.png`, `vercel.json` and `img/*.png` (14 images) | `git ls-files` |
| Frontend architecture | One long single-page landing with anchor sections, plus a separate contact page | — |
| Backend / API | **None** | — |
| Database | **None** | — |
| Authentication | **None** | — |
| Deployment | Vercel static hosting, linked to the project `onchainfest-web-site`. `vercel.json` only sets a CSP header. | `vercel.json`, `.vercel/repo.json` |
| Environment variables | None used by the site. `.env.local` holds only the Vercel CLI OIDC token. | `.env.local` (names only) |
| Routes | `/` (`index.html`) and `/contact.html`. Everything else is in-page anchors: `#solutions`, `#how-it-works`, `#organizers`, `#athletes`, `#story`, `#bragging-rights`, `#brt`, `#about`, `#contact`. | `index.html` |
| Components / services / domain models | None. The markup is not componentized; there are no data or services. | — |
| Tests / CI | None. There is no `.github/` directory. | — |
| External integrations | `mailto:` only. The contact form posts with `action="mailto:vicvalch@onchainfest.xyz"`. | `contact.html:142` |
| Canonical domain | `https://www.onchainfest.xyz/` in the canonical URL, OG tags and JSON-LD. The brief refers to `onchainfest.com`. | `index.html:8,14,25`. **UNKNOWN** which domain is authoritative. |

**Orphaned assets.** Ten of the 14 images are not referenced anywhere: `img/brt3.png`, `brts1-3.png`, `music1-3.png`, `raffle1-3.png` and `sports3.png`. The root `logo.png` is also unreferenced; the pages use `img/logo.png`. These are leftovers from the earlier "studio" site.

**Branch reality:**
- `main` (`d54c4b4`, presumably what Vercel production serves; live state not checked over the network) is titled "OnChainFest Studio – Web3, Automation & AI". It lists "2 live ventures: PadelFlow & HRKey" and contains a "View PadelFlow ↗" link whose `href="#"` is dead. Its contact email is `info@onchainfest.com`.
- The feature branch uses `vicvalch@onchainfest.xyz`.

---

## 4. Current Public Website Reality

This section audits branch `feat/onchainfest-sports-platform-landing`, `index.html`.

### 4.1 Structure

- **Navigation:** Solutions · How it works · For Organizers · For Athletes · Bragging Rights · About · **Talk to us** (`contact.html`).
- **Sections, in page order:**
  1. Hero, with the "Tournament day" lifecycle figure 01–07
  2. Problem
  3. For Organizers (6 capability cards)
  4. How it works (4 steps)
  5. For Athletes
  6. Big idea (sample athlete history, labelled "Example")
  7. Powered by Bragging Rights
  8. $BRT "What's next"
  9. Solutions (two audiences)
  10. Why OnChainFest
  11. Final CTA
- **Calls to action:** every primary CTA resolves to `contact.html` or an in-page anchor. There is **no sign-up, login, tournament discovery, tournament page, player page or app link** anywhere.
- **Forms:** `contact.html` is a `mailto:` form that opens the visitor's email client. Nothing is submitted to a server or stored.
- **Live product functionality:** none.
- **Demo or placeholder content:** the athlete history card is labelled "Example" (`index.html:1410`).
- **Copy quality:** "Coming soon" badges are applied consistently to Achievements, Prizes, History, match scheduling and $BRT.

### 4.2 Claim classification

| # | Public claim (location) | Classification | Evidence |
|---|---|---|---|
| 1 | "**Live today:** registration, online entry payments, brackets, results, standings and player pages" (`index.html:1331`) | **STALE / MISLEADING** | No OnChainFest product exists. The closest implementation is `padelflow`, a single-event bowling app: hard-coded to *Torneo La Negrita 2025*, an unauthenticated `/admin`, static `/brackets`, payment by IBAN with manual verification, and Stripe reachable only from the admin. No self-service onboarding exists anywhere. |
| 2 | "Registration … with entry fees paid online" (`:1294`) | **STALE / MISLEADING** | Same as #1. `bragging-rights` has a registration domain but no UI, no auth and no payments. |
| 3 | "Manage brackets and matches without juggling multiple tools" (`:1300`) | **PARTIALLY IMPLEMENTED (not reachable)** | `bragging-rights` has single-elimination and round-robin format engines, a deterministic draw and contest scheduling (`packages/competition`, migration `0008`). It is API-only, with no authenticated users in production. `padelflow` brackets are manual containers. |
| 4 | "Capture results once and keep them organized" (`:1306`) | **PARTIALLY IMPLEMENTED (not reachable)** | `bragging-rights` `results.*` ledger. There is **no HTTP route to submit results**, and the lifecycle stops at PROVISIONAL. |
| 5 | "Turn tournament results into live standings" (`:1312`) | **PARTIALLY IMPLEMENTED (not reachable)** | `bragging-rights` rankings engine (BRT-10). It produces no canonical output while results cannot reach OFFICIAL/FINAL. |
| 6 | "Participant experience … their own player page" (`:1324`) | **PARTIALLY IMPLEMENTED** | `bragging-rights` `apps/web` `/athletes/[slug]` passport, read-only and seeded with fictional data. Not deployed. |
| 7 | Achievements, Prizes, History — "Coming soon" | **PLANNED** | Achievements and records exist in `bragging-rights` (backend). Prizes and history UI do not exist. Correctly flagged. |
| 8 | "Bragging Rights is the technology behind OnChainFest that turns verified tournament results into rankings, achievements and a lasting record" (`:1435-1436`); "The engine behind rankings, achievements and athlete history" (`:1456`); footer "Achievements and rankings powered by Bragging Rights" (`:1622`) | **ACCURATE TO CODE TODAY, BUT CONFLICTS WITH THE FROZEN BOUNDARY** | It describes what `bragging-rights` currently is. Under the target architecture these are OnChainFest capabilities, so the copy will become **STALE** once ONCF-00R is adopted. |
| 9 | "Behind the scenes, Bragging Rights helps make sure that results are properly recorded and only count when they meet the tournament's rules" (`:1439-1440`) | **PARTIALLY IMPLEMENTED; boundary conflict** | Verification engine V0–V4 exists; the production ceiling is V1. In the target architecture this is OnChainFest verification. |
| 10 | "Secure technology that keeps every record safe" (`:1460`) | **MARKETING-ONLY** | No anchoring or chain code exists. |
| 11 | $BRT "still in development and is not available today" (`:1480`) | **PLANNED** (accurate) | No token code in any repository. Poker has an uncompiled `.txt` ERC-721 draft. |
| 12 | "Built for padel & tennis clubs, organizers, academies & leagues" (`:1218-1221`) | **MARKETING-ONLY** | The `bragging-rights` catalog seeds `padel.doubles` and `running.5k`. No tennis. |
| 13 | Athlete section photo of a road race (`:1357`) | Neutral | — |

### 4.3 Consistency of the repositioning

- On the feature branch the sports-tournament-first positioning is internally consistent: organizer value first, athletes second, BR as the technology underneath, $BRT as coming soon.
- It is inconsistent with production (`main`), which still sells a Web3 venture studio, and with the frozen boundary, because BR is framed as the sports engine.
- Claim #1 is the most serious issue: a prospect could reasonably expect to sign up and run a tournament today.

---

## 5. Current Capability Inventory

The **Maturity** column uses this scale:
- **Prod-grade backend**: domain, persistence and tests present, but no production auth or deployment.
- **Prototype**: works for one case, with insecure or hard-coded parts.
- **Mock**: UI only, with fake data.
- **Absent.**

| Capability | Exists? | Maturity | Source files/modules | Persistence | Auth dependency | Reusable? | Target ONCF step |
|---|---|---|---|---|---|---|---|
| Public marketing site | Yes | Static, production | `Onchainfest-WebSite/index.html`, `contact.html` | none | none | Yes (content/design) | ONCF-20 |
| Accounts / login | Model only | Prod-grade backend, **no IdP** | `bragging-rights/packages/identity`, `apps/api/src/auth.ts` (`failClosedAuth`, dev HMAC tokens), migration `0004` (`identity.account`, `auth_identity`) | Postgres | IdP missing | **Yes**: plug an IdP into `AuthAdapter` | ONCF-01 |
| Users / persons / PII vault | Yes | Prod-grade backend (dev-only KMS) | `identity.person`, `identity_private.person_private` (encrypted), `0004` | Postgres | needs ONCF-01 | Yes | ONCF-01/02 |
| Athlete profiles | Yes | Prod-grade backend plus a read-only web passport | `identity.athlete`, `athlete_profile`, `athlete_slug`, `passport.*` (`0004`, `0006`); `apps/web/app/athletes/[slug]` | Postgres | needs ONCF-01 | Yes | ONCF-02 |
| Guardians / minors | Yes | Prod-grade backend | `identity.guardian_relationship` | Postgres | needs ONCF-01 | Yes | ONCF-02 |
| Organizations / clubs | Yes | Prod-grade backend | `organizations.organization` (typed: CLUB, ACADEMY, LEAGUE, FEDERATION, EVENT_ORGANIZER, VENUE …), `organization_profile`, `organization_slug` (`0005`) | Postgres | needs ONCF-01 | Yes | ONCF-03 |
| Memberships | Yes | Prod-grade backend | `organizations.membership` (OWNER/ADMIN/MEMBER/ATHLETE/COACH/OFFICIAL/STAFF), `packages/identity/src/permissions.ts` | Postgres | needs ONCF-01 | Yes | ONCF-05 |
| Invitations | Yes | Prod-grade backend | `organizations.invitation` (token_hash), `invitation_consumption`; `POST /v1/organizations/:id/invitations` | Postgres | needs ONCF-01 | Yes | ONCF-05 |
| Org public page | Partial | Backend plus a read-only web page | `GET /v1/organizations/:slug`; `apps/web/app/organizations/[slug]` | Postgres | none (public) | Yes (data); the builder is absent | ONCF-04 |
| Tournaments | Yes | Prod-grade backend | `competition.competition`, `event`, `event_profile` (`0008`); `POST /v1/competitions` (ORG_ADMIN) | Postgres | needs ONCF-01 | Yes | ONCF-06 |
| Tournament public pages | Partial | Read-only web | `apps/web/app/competitions/[slug]/…`; `competition_read.*` (`0009`) | Postgres | none | Yes | ONCF-07 |
| Registration | Yes | Prod-grade backend | `competition.registration`, `participant`, capacity triggers; SELF registration routes | Postgres | needs ONCF-01 | Yes | ONCF-08 |
| Brackets / draws / matches | Yes | Prod-grade backend | `packages/competition` (single elimination, round robin, deterministic draw), `round`, `contest`, `contestant`, `contest_schedule`, `lineup` | Postgres | needs ONCF-01 | Yes | ONCF-09 |
| Results | Partial | Ledger present; **no submit route; stops at PROVISIONAL** | `results.*` (`0003`), `packages/persistence/src/result-ledger.ts` (CLI/seed only) | Postgres (append-only, hash-chained) | needs ONCF-01 plus authority grants | Yes, but needs completion | ONCF-10 |
| Evidence / attestations | Yes | Prod-grade backend (dev-only blob store) | `evidence.*`, `attestation.*` (`0010`, `0011`), `packages/evidence` | Postgres plus a dev blob directory | needs ONCF-01 | Yes | ONCF-10 |
| Verification | Yes | Engine V0–V4; production ceiling V1 | `packages/verification`, `verification.*` (`0013`–`0015`) | Postgres | COMP_STAFF | Yes | ONCF-10 |
| Classifications | Yes | Prod-grade backend | `results.classification_derivation` (`0023`), ADR-0047 | Postgres | INTERNAL/operator | Yes | ONCF-11 |
| Rankings / leaderboards | Yes | Prod-grade backend (BRT-10) | `packages/rankings`, `ranking.*` (`0024`, `0025`), `ranking_read.leaderboard_entry` (`0028`); public `/v1/ranking-*` | Postgres | public reads | Yes | ONCF-11 |
| Achievements | Yes | Prod-grade backend; produces zero canonical output until results reach OFFICIAL | `packages/achievements`, `achievement.*` (`0016`–`0018`, `0027`); worker consumer `achievements.derive` | Postgres | worker | Yes | ONCF-12 |
| Records / hall of fame | Yes | Prod-grade backend | `packages/records`, `record.*` (`0019`–`0022`) | Postgres | worker | Yes | ONCF-12 |
| Athlete history | Partial | Passport read model | `passport.athlete_card`, `achievement_read.athlete_achievement`, `record_read.athlete_record` | Postgres | public | Yes | ONCF-12 |
| Organizer dashboard | No (BR); mock (padelflow `/mvp`, Sports) | Absent or mock | `padelflow/public/mvp/dashboard.html` (localStorage) | none | — | Reference only | ONCF-13 |
| Athlete dashboard | No; prototype (padelflow `/dashboard/[id]`, which leaks other players' data) | Prototype | `padelflow/app/dashboard/[id]` | Supabase | none | No | ONCF-14 |
| Rewards / prizes | No | Absent. Reserved `PRIZE_ENTITLEMENT` / `TROPHY` ledger stream types are unused. | `bragging-rights` `0001_platform`; `poker-tournament-backend/contracts/PrizeDistribution.sol` (double-pay bug) | — | — | Reserve only | ONCF-15 |
| Payments / Stripe | Prototype | Prototype | `padelflow/app/api/stripe/{create-checkout,webhook}`, `lib/stripe-config.ts`; Poker RLUSD-on-Base monitor | Supabase | admin only | Adapt the webhook pattern | ONCF-18 |
| Wallets | Partial | BR: EIP-191 proof-of-control. padelflow: unused wagmi config plus **plaintext custodial keys**. | `bragging-rights/packages/identity/src/wallet.ts`, `identity.wallet_link*`; `padelflow/lib/wallet-service.ts` | Postgres / Supabase | SELF | BR proof: yes. padelflow custody: **never**. | ONCF-17 |
| NFTs / BRT | No (BR). Drafts elsewhere. | Not deployed | `padelflow/contracts/PadelFlowNFTTrophy.sol` (ERC-721, onlyOwner, transferable, no tests, all addresses blank); `Poker/contracts/simplified_brt_contract.txt` (uncompiled) | — | — | Adapt or reference | ONCF-16 |

---

## 6. Current Domain Model

`Onchainfest-WebSite` has **no domain entities.** The authoritative existing model is `bragging-rights`. All entities use UUIDv7 primary keys and an append-only status-change pattern (`*_status_change` tables plus `v_*_current` views; `platform.reject_mutation` triggers block UPDATE and DELETE).

### 6.1 Domain map (as implemented in `bragging-rights`)

```text
identity.account ──1:1── identity.auth_identity (provider, provider_subject)
      │ account_person_control (SELF)
      ▼
identity.person ──1:1── identity_private.person_private (encrypted PII)
      │            ├── guardian_relationship ── person
      │            ├── external_identity (federation licence…)
      │            └── wallet_link (eip155 address, EIP-191 proof)
      ├──1:1── identity.athlete ── athlete_profile, athlete_slug, athlete_identity_resolution (merge)
      └──1:1── authority.principal (PERSON)  ── principal_key, authority_grant, trust_anchor

organizations.organization (typed) ──1:1── authority.principal (ORGANIZATION)
      ├── organization_profile, organization_slug
      ├── membership (person, role) ── invitation (token_hash) ── invitation_consumption
      └── (organizer of) competition.competition

sports.sport → discipline → discipline_version (spec)    format_template → format_version

competition.competition (organizer_organization_id) ── competition_staff, competition_slug
      └── event (discipline_version, format_version, INDIVIDUAL|TEAM)
             ├── registration (athlete_id | team_id) → participant
             ├── event_seeding, event_plan → round → contest → contestant
             └── contest_schedule (venue_organization_id), lineup

results.result (scope CONTEST | *_CLASSIFICATION) → result_version (content, content_hash)
      ├── evidence.item / attestation.attestation (signed claims about a result_version)
      └── verification.run (policy_version, V0..V4)
             └── achievement.achievement (holder ATHLETE|TEAM, type, basis) → member_credit
                    ├── record.record_mark → hall_of_fame
                    └── ranking.system_version → run → snapshot → snapshot_entry (leaderboard)
                                                └── achievement QUALIFIED (qualification_basis)

platform.ledger_entry (hash chain; reserved PRIZE_ENTITLEMENT, TROPHY) · outbox_event · job · command_idempotency
```

### 6.2 Entity census

| Current entity | Location | Real domain or UI convenience | Source of truth today | Conflict with target architecture |
|---|---|---|---|---|
| Account / AuthIdentity | `identity.account`, `auth_identity` (`0004`) | Real | BR | Belongs to OnChainFest (OCF) |
| Person | `identity.person` | Real | BR | OCF |
| Athlete (1:1 Person) | `identity.athlete` | Real; **correctly separated from User** | BR | OCF |
| PersonPrivate | `identity_private.person_private` | Real (PII vault) | BR | OCF |
| WalletLink | `identity.wallet_link` | Real | BR | OCF (athlete-wallet association); BR consumes it |
| Organization / Membership / Invitation | `organizations.*` (`0005`) | Real | BR | OCF |
| Principal / AuthorityGrant / TrustAnchor | `authority.*` (`0002`) | Real (sporting authority, delegation and signatures) | BR | OCF. Could also identify BR's minting issuer. **Design decision.** |
| Sport / Discipline / Format | `sports.*` (`0007`) | Real | BR | OCF |
| Competition / Event / Round / Contest | `competition.*` (`0008`) | Real (= Tournament / Category / Round / Match) | BR | OCF. Naming: "Competition" = Tournament, "Event" = category/division. |
| Registration / Participant / Team / Lineup | `competition.*` | Real | BR | OCF |
| Result / ResultVersion | `results.*` (`0003`) | Real, immutable and versioned | BR | OCF |
| Evidence / Attestation | `evidence.*`, `attestation.*` | Real | BR | OCF |
| VerificationRun / Policy | `verification.*` | Real | BR | OCF |
| Achievement (incl. QUALIFIED, RECORD_SET) | `achievement.*` | Real (sporting record) | BR | OCF |
| RecordMark / Category | `record.*` | Real | BR | OCF |
| RankingSystem / Snapshot / Classification | `ranking.*`, `results.classification_*` | Real | BR | OCF |
| Passport | `passport.*` (`0006`) | **Read model** (projection) | Derived | OCF; BR may contribute an "artifacts" section |
| `*_read.*` cards | `competition_read`, `ranking_read`, … | Read models | Derived | Follow their source |
| Ledger / Outbox / Job / Idempotency | `platform.*` (`0001`) | Infrastructure | BR | Shared infrastructure; goes with the platform core |
| `players` (padelflow) | `padelflow/scripts/SETUP_SUPABASE_COMPLETE.sql` | Conflates person, registration and payment in one row; email globally unique; no `tournament_id` | Supabase (padelflow) | **Do not use** |
| `tournaments`, `tournament_brackets`, `player_series`, `player_standings` (padelflow) | same | Bowling-specific | Supabase | Reference only |
| `tournaments`, `tournament_registrations`, `tournament_invitations`, `prize_distributions` (Poker) | `Poker/supabase_schema.sql` | Real but single-series | Supabase | Reference only |

**Expected future concepts versus reality:**
- Already present in BR: User/Account, Athlete, AthleteProfile, Organization, OrganizationMember, Invitation, Tournament (as Competition/Event), TournamentRegistration, Participant, Competition/Match (Contest), Result, ResultVerification, Classification, Ranking, Achievement, AthleteHistory (passport) and WalletAssociation.
- Missing: **RewardDefinition, RewardEligibility and RewardAward** (reserved ledger stream only), payments/entry fees, and subscriptions.

---

## 7. Identity / Auth Reality

| Question | `Onchainfest-WebSite` | `bragging-rights` | `padelflow` |
|---|---|---|---|
| Authentication exists? | No | **Seam only.** `AuthAdapter` interface (`apps/api/src/auth.ts:11`). Production is `failClosedAuth`, so every non-PUBLIC route returns 401. Dev uses HMAC bearer tokens (`BR_DEV_AUTH=1`). | Single env-var admin; 4–5 competing implementations |
| Provider | — | None. `AuthIdentity(provider, provider_subject)` is provider-agnostic; only `test` is used. | Custom |
| Session model | — | Stateless bearer per request (dev) | Unsigned base64 cookie, `secure:false` (**forgeable**) |
| User model | — | `identity.account` → `person` (SELF control) | None (no player accounts) |
| Authorization model | — | Three layers (ADR-0020): endpoint class (PUBLIC/AUTHENTICATED/SELF/GUARDIAN/ORG_MEMBER/ORG_ADMIN/COMP_STAFF/ISSUER_REPRESENTATIVE/INTERNAL), then org permissions (`OrgPermission`), then the Authority Engine (capability grants) for sporting facts. DB role separation (35 Postgres roles). | None effective |
| Roles | — | Membership roles OWNER/ADMIN/STAFF/COACH/OFFICIAL/ATHLETE/MEMBER | admin only |
| Organization membership | — | Yes | No |
| Athlete identity | — | `identity.athlete`, 1:1 with Person and **distinct from Account** (supports guardians managing minors) | `players` row |
| User and athlete conflated? | — | **No** | Yes |
| Anonymous participants? | — | Not as accounts, but a guardian-managed athlete can exist without its own login | Yes (all registrants are anonymous) |
| Email identity assumed? | — | No. Email is optional encrypted PII. | Yes (UNIQUE email) |
| Wallet identity assumed? | — | No. Wallets are linked *to* a person via EIP-191 proof. `AuthenticationMethod` lists `'WALLET'` but it is unimplemented. | No |
| Security shortcuts | — | Dev DB passwords as code fallbacks (`packages/persistence/src/config.ts`), refused only when `NODE_ENV=production`. Dev-only PII cipher key ("NOT a KMS"). | Critical (see §19) |

**Conclusion.** `bragging-rights` provides a reusable, correctly separated identity model with a clean seam for an identity provider. **No real identity provider has been chosen or integrated anywhere.** That choice is the core of ONCF-01.

---

## 8. Organization / Tenancy Reality

| Question | Answer | Evidence |
|---|---|---|
| Can multiple organizations coexist? | **Yes** in BR. No in padelflow or the website. | `organizations.organization`; padelflow has no org entity |
| Is data scoped to an organization? | Partially. Competitions carry `organizer_organization_id`; teams have `organization_id`; schedules have `venue_organization_id`. Athletes are **global** (correct: athletes span clubs). | `0008` |
| Notion of organizer? | Yes: the competition's organizer org plus `competition_staff` | `0008`, COMP_STAFF endpoint class |
| Permissions organization-scoped? | Yes: `OrgPermission` derived from active memberships; COMP_STAFF derived from DB facts | `packages/identity/src/permissions.ts` |
| Tournament records tenant-scoped? | By FK to the organizer org. **No RLS, no `tenant_id`**; isolation is enforced in application stores. | 0 `CREATE POLICY` across 30 migrations |
| URLs organization-aware? | Global slugs: `/organizations/:slug`, `/competitions/:slug`. Competitions are not nested under orgs. | `apps/web/app` |
| Branding configurable? | Profile fields only (`organization_profile`). No themes or logos-as-assets. | `0005` |
| Independent org websites? | No | — |
| Globally assumed IDs? | UUIDv7 everywhere; no hard-coded IDs | `packages/domain/src/ids.ts` |
| Singleton assumptions? | **Website:** the whole site is OnChainFest's own. **padelflow:** one implicit tournament, hard-coded "2 al 9 de agosto 2025", CRC prices, Stripe product "Torneo La Negrita 2025". **BR:** none. | `padelflow/app/api/register-player/route.ts` |
| Hard-coded clubs or tournaments? | BR seeds are fictional and refused in production (`club-ficticio-padel`, `fictional-padel-open`). padelflow is hard-coded to La Negrita. | seeds; padelflow |

**What blocks Clubs A, B and C sharing the platform today:**
1. No production authentication.
2. No deployment.
3. Tenant isolation is application-enforced only. That is acceptable, but it must be covered by tests per route before real multi-club data.
4. No org-scoped URL namespace or branding.

The BR model itself does **not** block multi-club use. padelflow cannot support it without a rewrite.

---

## 9. Tournament Capability Reality

Lifecycle in `bragging-rights` (with `padelflow` for comparison):

| Stage | `bragging-rights` | `padelflow` |
|---|---|---|
| Create tournament | **Implemented** (API: `POST /v1/competitions` ORG_ADMIN; events via COMP_STAFF). No UI. | Simulated (`public/mvp` localStorage) |
| Publish | **Partial.** Competition/event lifecycles and public read cards exist; there is no explicit organizer "publish" UX. | Missing |
| Registration | **Implemented** (SELF registration, capacity and single-entry triggers, registration window) | Implemented for one bowling event (anonymous) |
| Participant acceptance | **Implemented** (COMP_STAFF registration decision, lock-field, withdraw, disqualify) | Partial (unauthenticated payment-status flip) |
| Competition (draw, brackets, matches, schedule) | **Implemented** (seed, generate-plan, single elimination, round robin, contest schedule, lineups) | Partial or mock (manual containers; static public page) |
| Results | **Partial.** Versioned ledger with authority checks, but **no HTTP submission route** (CLI/seed only) and transitions only T2–T4 (SUBMITTED → PROVISIONAL/REJECTED). OFFICIAL and FINAL are not reachable. | Implemented for bowling (unauthenticated) |
| Verification | **Implemented** engine V0–V4; honest production ceiling **V1** | Missing |
| Classification | **Implemented** (derived ResultVersions, ADR-0047) | Missing |
| Ranking | **Implemented** (BRT-10 snapshots and leaderboards) | Per-event standings only |
| Achievement | **Implemented** engine. **Zero canonical output in practice** until results reach OFFICIAL. QUALIFIED is fail-closed. | Schema only |

No external module provides tournament functionality to the website. The relationship is that **the website markets capabilities that live, in partial form, in `bragging-rights` (backend) and `padelflow` (one-off).**

### 9.1 PadelFlow and other existing sports logic (§13 of the brief)

`padelflow` is **not padel**. It is the *Torneo La Negrita CRCC 2025* bowling app (`LaNegrita-db/README.md` confirms the origin), later rebranded at the landing-page level only.

| Capability | Verdict | Reason |
|---|---|---|
| Player registration | REFERENCE ONLY | Conflated `players` row, bowling fields, global unique email |
| Tournament setup | REFERENCE ONLY (`/mvp` UX), REIMPLEMENT backend | localStorage only. BR already has the backend. |
| Categories | DO NOT USE | Bowling handicap/scratch/senior in JSON |
| Brackets | DO NOT USE | Manual containers; static public page. BR has format engines. |
| Matches | — | Absent |
| Scores / results | REFERENCE ONLY | 0–300 bowling games |
| Winners / standings | REFERENCE ONLY | Single-event pin totals |
| Payments (Stripe) | **ADAPT** | Signature-verified webhook and `lib/stripe-config.ts` are a reasonable start for ONCF-18 |
| Public tournament pages | DO NOT USE | Hard-coded |
| NFT trophy contract (`contracts/PadelFlowNFTTrophy.sol`) | **ADAPT** (for BR, ONCF-16) | Clean OpenZeppelin 5 ERC-721. Needs a minter role instead of `onlyOwner`, a soulbound decision, tests and deployment. |
| IPFS metadata (`lib/ipfs/*`) | ADAPT (ONCF-16) | Server-side Pinata metadata builder |
| Email service (`lib/email-service.ts`) | ADAPT | Generic Resend/SMTP |
| shadcn UI (`components/ui`) | REUSE AS-IS | Standard |
| Auth, custodial wallets, debug pages, open RLS | **DO NOT USE** | Insecure (§19) |

**Other repositories:**
- **Poker:** REFERENCE ONLY. It is the only repository with real "OnChainFest" and "Bragging Rights Tokens" branding. It has invite-code registration, an RLUSD payment monitor and email queue ideas; its NFT minting is a stub.
- **poker-tournament-backend:** REFERENCE ONLY. Its `PrizeDistribution.sol` has a double-pay bug; do not use it.
- **Sports:** REFERENCE ONLY. `main` is broken; it has a Foundry project and an escrow contract with bugs.
- **PadelChain / StrikeChain:** DO NOT USE (mock UIs, duplicates of each other).
- **OLMO-Site---PeerProof, qr-code-hrke:** unrelated.

---

## 10. Bragging Rights Repository Reality

| Concern | Reality |
|---|---|
| Architecture | **Modular monolith** (ADR-0010) with a transactional outbox (ADR-0012) and PostgreSQL as system of record (ADR-0011) |
| Stack | TypeScript 6 ESM; Fastify 5 API (`apps/api`, run with `tsx`); Next.js 16 App Router web (`apps/web`); polling worker (`apps/worker`); pnpm 10 workspaces; Node ≥ 22.13; PostgreSQL 18.3 with `pg` and Kysely (no ORM); custom SQL migration runner with checksums |
| Packages | `@br/canonical`, `domain`, `schemas`, `authority`, `identity`, `competition`, `evidence`, `verification`, `achievements`, `records`, `rankings`, `persistence` (depends on every domain package), `testkit` |
| Database | 30 migrations, schema-per-module, 35 Postgres roles (14 LOGIN, 21 NOLOGIN), append-only status tables, hash-chained ledger, **no RLS**, many SECURITY DEFINER functions |
| APIs | About 110 `/v1` routes across identity, organizations, competition, evidence, verification, achievements, records and rankings. **No routes** for result submission or acceptance, authority grants or trust anchors. |
| Worker / events | Outbox consumers `achievements.derive`, `records.evaluate`, `rankings.react` and `dev.event-log`; `platform.job` claim loop; about 110 `DomainEventType`s. Comment: "No qualification / prize / trophy consumer exists". |
| Ranking logic | `packages/rankings`: BEST_MARK, shared ties, immutable snapshots, qualification basis |
| Achievement logic | `packages/achievements`: rules, snapshots, team member credits, supersession, QUALIFIED |
| Token / NFT logic | **None.** Grep hits for "mint" and "nft" are guards that **assert absence** (`tooling/check-no-manual-ranking.mjs:175`, `check-no-manual-record.mjs:60`, `packages/testkit/src/index.ts:942-959`). |
| Metadata model | None for tokens. BR-JSON canonicalization and domain-separated SHA-256 (`@br/canonical`, ADR-0014) are suitable for future commitments. |
| Minting / ownership / chain | None. Planned only: ADR-0006 (chain-agnostic core), ADR-0009 (no PII on-chain), ADR-0019 (Anchoring/Credential/Settlement ports; "Chain selection is deferred"). |
| Wallet assumptions | EVM `eip155:*` addresses, EIP-191 `personal_sign` proof (`packages/identity/src/wallet.ts`); the seed uses Base Sepolia `84532` |
| Public interfaces | Public read API plus the read-only `apps/web` explorer (athletes, organizations, competitions, attestations, verifications, achievements, records, hall of fame, rankings) |
| Current BRT-10 work | Complete: classification worker, ranking API, web surfaces, guards, seed/demo, integration tests (PRs #2–#8) |
| Tests | 41 unit test files (689 tests, passing); 39 integration files (need live Postgres); golden vectors cross-checked in Python; 6 lint guard scripts |
| CI | `.github/workflows/ci.yml`: Postgres service, format, lint and guards, typecheck, unit, vectors, migrate, integration, demos (BRT-03 to BRT-07 only), worker smoke run, web build |
| Deployment | **None.** `docker-compose.yml` is "local development database only". |
| Self-description | `package.json`: "verified sports achievement infrastructure". `docs/architecture/BRT-TARGET-CAPABILITY-MAP.md`: "a global infrastructure for verified sports achievement, competition and rewards" (modules M1–M21, including Competition Engine, Registration, Prize Rail and Trophy House). README: "no smart contracts, no NFTs and no blockchain". |
| OnChainFest mentions | Archaeology docs only (`docs/archaeology/BRT-00-*`): the original $BRT definition was "exclusive NFTs awarded only to tournament champions using the OnChainFest system". **There is no OnChainFest integration plan.** |

---

## 11. Bragging Rights Boundary Violations

Legend: **A** correctly belongs in BR · **B** move to OnChainFest · **C** split · **D** deprecate eventually · **E** needs a design decision.

| BR capability | Class | Notes |
|---|---|---|
| Accounts, AuthIdentity, Person, PII vault, guardians | **B** | User identity is OnChainFest's |
| Athletes, profiles, slugs, external identities, merge | **B** | Athlete identity is OnChainFest's |
| Organizations, memberships, invitations | **B** | Explicitly OnChainFest's |
| Sport catalog, competitions, events, registration, teams, brackets, schedules, lineups | **B** | Tournament domain |
| Results ledger | **B** | Results |
| Evidence and attestations | **B** | Part of result verification |
| Verification engine and runs | **B** | Verification |
| Achievements (incl. QUALIFIED, RECORD_SET) | **B** | Sporting record |
| Records and hall of fame | **B** | Sporting history |
| Rankings, classifications, snapshots, leaderboards | **B** | Explicitly OnChainFest's |
| Athlete passport | **C** | OCF owns the passport; BR contributes an "artifacts held" read model |
| Wallet link and EIP-191 proof | **C** | OCF owns the athlete–wallet association (§23). The signature-verification utility is chain logic that BR may host as a library. |
| Authority engine (principals, keys, grants, trust anchors) | **E** | Sporting authority (who may declare OFFICIAL) is OCF's. The principal/key machinery (`key_kind WALLET`, `ES256K`) could also model BR's minting issuer. Decide in ONCF-16. |
| `@br/canonical` (BR-JSON, hashing, vectors) | **C** | Shared library. OCF uses it for sporting-fact hashes; BR for metadata commitments. |
| `platform.*` outbox, ledger, idempotency, jobs | **C** | Platform infrastructure; goes with the core. BR's mint jobs reuse it. |
| Reserved ledger streams `TROPHY`, `PRIZE_ENTITLEMENT` | **A** (`TROPHY` → artifact), **B** (`PRIZE_ENTITLEMENT` → OCF reward ledger) | Both unused |
| ADR-0006, 0009, 0019 | **A** | The only artefacts already aligned with BR's target scope |
| `apps/web` explorer | **B** (D for BR) | Displays OCF data |
| Guards forbidding prize, trophy, NFT and mint identifiers | **D / adjust** | Will block BR's own future work once BR is re-scoped |
| Capability map M12 Prize Rail / M13 Trophy House | M12 **B** (reward engine), M13 **A** | Doc rewrite needed |
| Minting, token metadata, token identity, on-chain ownership, chain client | **A — NOT IMPLEMENTED** | Greenfield |

**Summary of violations.** The repository named Bragging Rights is today the sports system of record for every concept that §1 of the brief reserves for OnChainFest. Its documentation (README, `BRT-TARGET-CAPABILITY-MAP.md`, `package.json` description) frames BR as the whole platform. These are documented violations only; nothing was changed.

---

## 12. System-of-Record Matrix

| Domain concept | Proposed system of record | Current location | Complication |
|---|---|---|---|
| User account | **OnChainFest** | BR `identity.account` | No IdP yet |
| Athlete profile | **OnChainFest** | BR `identity.athlete*` | — |
| Organization | **OnChainFest** | BR `organizations.organization` | — |
| Membership | **OnChainFest** | BR `organizations.membership` | — |
| Tournament | **OnChainFest** | BR `competition.competition` / `event` | Naming (Competition/Event vs Tournament/Category) |
| Registration | **OnChainFest** | BR `competition.registration` | No payments linkage |
| Competition (draw, matches) | **OnChainFest** | BR `competition.round/contest` | — |
| Result | **OnChainFest** | BR `results.*` | Lifecycle incomplete (no OFFICIAL/FINAL) |
| Verification | **OnChainFest** | BR `verification.*`, `attestation.*` | Production ceiling V1 |
| Ranking | **OnChainFest** | BR `ranking.*` | — |
| Classification | **OnChainFest** | BR `results.classification_*` | — |
| Achievement | **OnChainFest** | BR `achievement.*` | — |
| Athlete history | **OnChainFest** | BR `passport.*`, `record.*`, `achievement_read.*` | — |
| Reward eligibility | **OnChainFest** | none | Greenfield |
| Reward award / ledger | **OnChainFest** | reserved `PRIZE_ENTITLEMENT` stream | Greenfield |
| Wallet association | **OnChainFest** | BR `identity.wallet_link` | EIP-191 verifier is chain logic (shared library) |
| NFT/token metadata | **Bragging Rights** | none (padelflow `lib/ipfs` draft) | Must contain only non-PII references (ADR-0009) |
| Minted token identity | **Bragging Rights** | none | — |
| Blockchain ownership | **Bragging Rights** (read model of chain state); the chain is the ultimate truth | none | Transferable tokens would make ownership diverge from the athlete. Soulbound vs transferable is open (`BRT-00-REPOSITORY-ARCHAEOLOGY.md:834`). |

---

## 13. Reuse / Adapt / Migrate / Rebuild Matrix

| Asset | Repository | Action | Reason |
|---|---|---|---|
| Domain packages (`canonical`, `domain`, `schemas`, `authority`, `identity`, `competition`, `evidence`, `verification`, `achievements`, `records`, `rankings`) | bragging-rights | **MIGRATE into Onchainfest-WebSite (history-preserving)** | Tested, coherent, matches ONCF-01 to ONCF-12 |
| `persistence`, `testkit`, `db/migrations`, `db/bootstrap` | bragging-rights | **MIGRATE** | System of record for the above |
| `apps/api` (Fastify), `apps/worker` | bragging-rights | **MIGRATE** | The API surface already exists |
| `apps/web` (Next.js 16 explorer) | bragging-rights | **ADAPT** into the OnChainFest web app (public plus `/app`) | Right framework; pages are a demo explorer |
| CI workflow and guards | bragging-rights | **MIGRATE**, then adjust the token-name guards | Quality bar worth keeping |
| ADRs 0001–0050 | bragging-rights | **MIGRATE** as OnChainFest ADRs; keep 0006/0009/0019 as BR ADRs | — |
| Capability map, README | bragging-rights | **REWRITE** | Frames BR as the whole platform |
| Static marketing pages | Onchainfest-WebSite | **ADAPT** into the web app's public routes (ONCF-20) | Content is good; no componentization |
| Orphaned images (10) and root `logo.png` | Onchainfest-WebSite | **DELETE eventually** | Unreferenced |
| Stripe webhook pattern | padelflow | **ADAPT** (ONCF-18) | Signature handling is correct |
| ERC-721 trophy contract and IPFS helpers | padelflow | **ADAPT** for BR (ONCF-16) | Best existing chain code |
| Email service | padelflow / Poker | **ADAPT** | Generic |
| Registration, invite and payment-monitor ideas; `/mvp` wizard UX and i18n | Poker / padelflow | **REFERENCE ONLY** | — |
| Auth, custodial wallets, RLS policies, debug pages | padelflow | **DO NOT USE** | Insecure |
| `PrizeDistribution.sol` | poker-tournament-backend | **DO NOT USE** | Double-pay bug |
| PadelChain, StrikeChain, Sports | — | **DO NOT USE / REFERENCE ONLY** | Mocks |

---

## 14. Proposed Target Architecture

### 14.1 Principles

- **One repository, one modular monolith, one Postgres.** This continues ADR-0010 and ADR-0011 rather than introducing services.
- Keep the existing BR package boundaries; they already are clean domain boundaries.
- **Bragging Rights becomes a bounded module** (packages plus its own DB schema) inside the same workspace. It talks to the sports core only through outbox events and a narrow port. It can be extracted to a service later if chain operations require it (key custody, separate deploy cadence).
- Smart contracts live in their own workspace folder with their own toolchain (Foundry or Hardhat), isolated from the app build.

### 14.2 Proposed tree (after ONCF-00R)

```text
Onchainfest-WebSite/
├── apps/
│   ├── web/                 # Next.js (from bragging-rights/apps/web)
│   │   └── app/
│   │       ├── (public)/    # marketing (ported index/contact), /tournaments, /organizations, /athletes
│   │       └── app/         # authenticated: athlete, organizer, org admin, dashboards (ONCF-01+)
│   ├── api/                 # Fastify /v1 (from bragging-rights/apps/api)
│   └── worker/              # outbox consumers + jobs (from bragging-rights/apps/worker)
├── packages/
│   ├── canonical/ domain/ schemas/            # shared kernel
│   ├── identity/ authority/                   # ONCF-01..05
│   ├── competition/                           # ONCF-06..09
│   ├── evidence/ verification/                # ONCF-10
│   ├── rankings/ achievements/ records/       # ONCF-11..12
│   ├── rewards/                               # ONCF-15 (new)
│   ├── payments/                              # ONCF-18 (new)
│   ├── bragging-rights/                       # ONCF-16 (new): artifact domain + chain adapter port
│   ├── persistence/ testkit/
├── contracts/               # ONCF-16: Solidity workspace (adapted from padelflow trophy contract)
├── db/
│   ├── bootstrap/
│   └── migrations/          # continues 0001..0030; BR artifact schema added later as `artifact.*`
├── docs/
│   ├── adr/  implementation/  architecture/
│   └── audits/ONCF-00-ARCHITECTURE-AND-REPOSITORY-BOUNDARIES.md
├── legacy-site/             # current index.html/contact.html/img until ported (or served from apps/web/public)
├── .github/workflows/ci.yml
├── package.json  pnpm-workspace.yaml  tsconfig.base.json
```

### 14.3 Deployment shape (proportionate)

- **Web:** `apps/web` on Vercel. This reuses the existing `onchainfest-web-site` project, changing its root directory and build settings.
- **API and worker:** one container host running two processes.
- **Postgres:** a managed instance.
  - BR's role bootstrap (`db/bootstrap/roles.sql`) creates 35 roles and requires `CREATEROLE`. Some managed providers restrict this, so the provider choice must be validated in ONCF-00R or ONCF-01. **Decision required.**

### 14.4 Alternatives considered

- **Keep the sports domain in `bragging-rights` and have OnChainFest call it as a service.** Rejected: it makes BR the source of truth for everything the brief says BR must not own.
- **Rebuild the domain from scratch in `Onchainfest-WebSite`.** Rejected: it discards about 72k lines of tested domain code for no gain.
- **Use the `bragging-rights` repository itself as the platform repo** (rename it later and move the website in). This is viable and avoids a history transplant, but contradicts the brief's frozen "`Onchainfest-WebSite` is the candidate home" and requires a rename. It remains **Option B** in §21.

---

## 15. Public Website vs Application Boundary

One Next.js app on one domain (`onchainfest.xyz`; **confirm** whether `.com` is canonical), with route groups.

| Surface | Routes | Auth | Rendering |
|---|---|---|---|
| Marketing | `/`, `/organizers`, `/athletes`, `/pricing`, `/contact`, `/bragging-rights` | none | static / ISR |
| Tournament discovery | `/tournaments`, `/tournaments/[slug]`, `/tournaments/[slug]/[event]` (brackets, schedule, results, standings) | none | ISR from public API reads |
| Organization pages | `/o/[orgSlug]`, with an org-scoped tournament list | none | ISR |
| Athlete public profile | `/athletes/[slug]` (passport; privacy-controlled, minors protected via guardian rules) | none | ISR |
| Rankings | `/rankings/[system]` | none | ISR |
| Auth | `/sign-in`, `/sign-up`, `/auth/callback` | — | dynamic |
| Athlete app | `/app` (home), `/app/profile`, `/app/registrations`, `/app/history`, `/app/rewards`, `/app/wallet` | athlete session | dynamic |
| Organizer app | `/app/orgs/[orgSlug]/…` (settings, page builder, members, tournaments, operations, results, verification) | org membership + `OrgPermission` | dynamic |
| Platform operator | `/app/ops/…` (catalog, policies, rules) | INTERNAL | dynamic |

**Rationale:**
- A single `/app` prefix makes the auth boundary a single middleware matcher.
- `/o/[orgSlug]` keeps org namespaces from colliding with marketing paths.
- Public pages read only BR PUBLIC endpoints, which already exist.

---

## 16. OnChainFest ↔ Bragging Rights Integration Boundary

### 16.1 Mechanism

The recommended mechanism is an **in-process module plus transactional outbox plus job.**

- OnChainFest writes an `ArtifactRequested` outbox event in the same transaction that records the reward award (ONCF-15).
- A BR worker consumer claims it as a `platform.job`.
- The consumer calls the chain adapter (ADR-0019 port), records the result in its own `artifact.*` schema, and emits `ArtifactIssued` or `ArtifactFailed`.

This choice follows from the repositories:
- The outbox, job queue and idempotency infrastructure already exist and are tested (`platform.outbox_event`, `outbox_consumption`, `job`, `command_idempotency`).
- Minting is slow, retryable and must not hold a sports-domain transaction open.
- A separate network service would add deployment and authentication cost with no current benefit.

**Extraction trigger:** if signer key custody requires a separate trust zone (HSM/KMS, an isolated deploy), move the `packages/bragging-rights` consumer into its own deployable. The contract below stays the same.

### 16.2 Minimum contract

OnChainFest requires the following from Bragging Rights:

```text
requestArtifact({
  idempotencyKey,
  subject: { kind: 'ACHIEVEMENT' | 'REWARD_AWARD', id, contentHash },  // OCF ids + hashes, no PII
  recipient: { walletAssociationId, network, address },               // resolved by OCF
  template: artifactTemplateCode,                                      // e.g. tournament-champion
  publicFacts: { … }                                                   // non-PII display facts OCF approves
}) -> artifactRequestId

getArtifact(artifactId | artifactRequestId) -> { status, network, contract, tokenId, metadataUri, txHash, owner? }
listArtifactsBySubject(subjectId) -> Artifact[]
listArtifactsByRecipient(walletAssociationId) -> Artifact[]
events: ArtifactIssued, ArtifactFailed, ArtifactOwnershipChanged (if transferable)
```

**BR must not:**
- read `identity`, `competition`, `results`, `achievement` or `ranking` tables;
- decide eligibility;
- hold PII.

**BR receives** OCF identifiers and content hashes (UUIDv7 plus `identity_hash`, `content_hash`, `snapshot_hash`), which the existing ADR-0013 and ADR-0014 conventions already provide.

---

## 17. Data Migration Requirements

| Current object/data | Current owner | Correct future owner | Migration required? | Dependency risk | Recommended ONCF step |
|---|---|---|---|---|---|
| All `bragging-rights` code (packages, apps, tooling, CI, ADRs) | bragging-rights repo | Onchainfest-WebSite | **Yes: code move with history** (`git subtree` or `filter-repo` merge) | Medium. Path changes and workspace root merge. The website has no build, so there are no conflicts. | **ONCF-00R** |
| Schemas `identity`, `identity_private`, `organizations`, `passport`, `sports`, `competition(_read)`, `results`, `evidence(_read)`, `attestation`, `verification(_read)`, `achievement(_read)`, `record(_read)`, `ranking(_read)`, `authority`, `platform` | BR database | OnChainFest database | **Schema moves with the code; no data migration.** There is no deployed BR database; seeds are fictional and refused in production. | Low (no production data exists, per the absence of any deployment config) | ONCF-00R |
| DB naming (`bragging_rights` DB, `br_*` roles, `br_migrations`, `BR_*` env vars, `@br/*` scope) | BR | OCF | **Optional rename.** Recommended *not* to rename in ONCF-00R; schedule a separate cosmetic step if wanted. | High churn (35 roles, checksummed migrations) | ONCF-00R2 (optional) |
| La Negrita 2025 players, results and payments | padelflow Supabase | OCF (historical import), if business-relevant | **Optional** | PII (passport numbers) and bowling-specific shape; production state UNKNOWN | Post-ONCF-12, if wanted |
| Poker series registrations | Poker Supabase | OCF (historical), if wanted | Optional | Single commit, unknown live state | Post-ONCF-12 |
| Historical BRT artifacts | none deployed | BR | **None.** No contract was ever deployed (padelflow `contracts/addresses.json` is all blank; Poker's contract is `.txt`). | None | — |

**Identifier preservation:** UUIDv7 ids and content hashes in BR are immutable and append-only. Keep them unchanged during the transplant so that any future artifact can reference `achievement.id` and `identity_hash` directly. Slugs are mutable and must never be token references.

---

## 18. Security / Trust Boundaries

| Trust boundary | Current state | Conflation or gap |
|---|---|---|
| Authenticated user | BR: `AuthAdapter` seam, fail-closed. Website: none. padelflow: forgeable cookie. | No IdP anywhere |
| Athlete identity | BR: Athlete is separate from Account and supports guardians | Good separation |
| Organization operator | BR: membership roles to `OrgPermission` | Application-level only (no RLS) |
| Organizer permissions | BR: COMP_STAFF from DB facts | OK |
| Result submitter | BR: Authority Engine `SUBMIT_RESULT` grant | **No HTTP route.** Grants are issued only by CLI. |
| Result verifier | BR: verification runs (COMP_STAFF) plus attestations (ISSUER_REPRESENTATIVE, JWS) | Ceiling V1. Attestation keys are JWK-only. |
| Reward issuer | none | Greenfield |
| Wallet owner | BR: EIP-191 proof-of-control | padelflow **custodial plaintext keys** (do not use) |
| Blockchain signer | none in BR. padelflow/Poker: owner EOA from `PRIVATE_KEY`. | Future BR needs KMS-held minter keys, never an app-server env var |
| Payment provider | padelflow Stripe (admin-only path) | No payments in BR |
| Bragging Rights service | — | Should receive only the §16 contract (no DB access to sports schemas) |

**Conflations today:**
1. BR's Authority Engine models both sporting authority and potential signing identity (`key_kind WALLET`).
2. padelflow conflates user, athlete, registrant and payer in one row, and admin with "anyone with the URL".

---

## 19. Technical Debt & Blockers

### P0 — blocks safe continuation

- **P0-1. No canonical platform location decided.** The domain lives in a repository whose name and docs contradict its target role, and the "home" repository has no application scaffold. ONCF-01 cannot pick an auth integration point until this is resolved. (§14, §21)
- **P0-2 (ecosystem, outside the ONCF code path). Live credential exposure in sibling repositories.** These do not block ONCF-01 code, but they are urgent operational risks:
  - `qr-code-hrke` commit `6fb817d` added an `.env.local` containing a Supabase service-role key. Commit `1d4cbe5` deleted the file, but the key remains in history. **Rotate the key.**
  - If the padelflow/La Negrita deployment is still live, `POST /api/auth/test-credentials` returns the admin password, `/admin` is unauthenticated, RLS allows public writes, and `player_wallets` may hold plaintext private keys. Take it down or lock it down.

### P1 — fix before the relevant feature

- **P1-1. No identity provider** (BR `failClosedAuth`). Prerequisite of ONCF-01.
- **P1-2. Result lifecycle stops at PROVISIONAL**, and there is no result submission or acceptance route and no grant-issuance API. Achievements and rankings therefore produce zero canonical output. Prerequisite of ONCF-10 to ONCF-12.
- **P1-3. "Live today" marketing claim is misleading** (`index.html:1331`, `:1294`). Fix before any outreach that relies on the feature branch.
- **P1-4. Bragging Rights copy contradicts the frozen boundary** (`index.html:1435-1440`, `:1456`, `:1622`). Fix with ONCF-20, or earlier if the branch is merged.
- **P1-5. No deployment target for API, worker or Postgres**, and managed-Postgres compatibility with the 35-role bootstrap is unverified.
- **P1-6. Dev DB password fallbacks** in `bragging-rights/packages/persistence/src/config.ts` are used whenever `NODE_ENV` is not `production`. A misconfigured deploy would silently use them.
- **P1-7. No production KMS or evidence store** (dev-only cipher key and blob directory). Prerequisite of ONCF-02 (PII) and ONCF-10 (evidence).
- **P1-8. Tenant isolation is application-enforced only**, with no RLS. Add per-route cross-org negative tests before real multi-club data (ONCF-03/05).

### P2 — architectural debt

- **P2-1.** The `@br/persistence` god package depends on every domain package.
- **P2-2.** CI does not run the BRT-08/09/10 demos or seeds.
- **P2-3.** 49 of 50 ADRs are still "Proposed".
- **P2-4.** Guards forbid `nft`, `mint` and `trophy` identifiers; they must be scoped before ONCF-16.
- **P2-5.** Naming mismatch: Competition/Event in code versus Tournament/Category in product language. Pick a glossary and do not rename tables.
- **P2-6.** Ubiquitous `br_*` and `BR_*` naming inside the OnChainFest core.
- **P2-7.** The production branch `main` of the website is unmerged with the repositioning; there are three abandoned remote design branches.
- **P2-8.** Canonical domain ambiguity (`onchainfest.xyz` versus `.com`; `info@onchainfest.com` on `main` versus `vicvalch@onchainfest.xyz` on the branch).

### P3 — cleanup and polish

- **P3-1.** Ten orphaned images plus the root `logo.png`.
- **P3-2.** The `.gitignore` in `Onchainfest-WebSite` is untracked (pre-existing). Commit it so `.env.local` and `.vercel` stay ignored for every clone.
- **P3-3.** The `mailto:` contact form loses leads that arrive without an email client.
- **P3-4.** padelflow, PadelChain, StrikeChain and Sports: archive or mark as legacy to avoid confusion.

---

## 20. Validated ONCF Roadmap

**The sequence remains valid as a product order.** Most backend phases change from *build* to *adopt, productize and close gaps*. Inserted steps are marked ➕.

| Step | Status after audit | Adjustment |
|---|---|---|
| ONCF-00 Architecture & Boundaries | Done (this document) | — |
| ➕ **ONCF-00R Platform Core Consolidation** | **Required before ONCF-01** | Transplant the `bragging-rights` monorepo into `Onchainfest-WebSite` with history. Move the static site under the web app (unchanged content). Keep `br_*` DB naming. CI green. Re-scope BR docs. No behaviour changes. |
| ➕ ONCF-00S Ecosystem Security Hygiene | Recommended now, in parallel (not code in this repo) | Rotate the qr-code-hrke Supabase key. Decommission or lock the padelflow/La Negrita deployment. Confirm `player_wallets` contents. |
| ➕ ONCF-00M Marketing Truth Fix | Recommended before merging the landing branch | Correct the "Live today" claim and the BR "engine" framing. Copy only. |
| ONCF-01 Identity & Accounts | Model exists | Choose an IdP and implement `AuthAdapter`. Add sign-up/sign-in UI, session handling and the `/app` boundary. Wire production DB credentials and a KMS for the PII vault. |
| ONCF-02 Athlete Profiles | Backend exists | UI, privacy controls, guardian flows |
| ONCF-03 Organizations | Backend exists | Self-service creation UI; cross-org isolation tests |
| ONCF-04 Organization Website Builder | Profile/slug only | Branding assets, sections, `/o/[slug]` pages |
| ONCF-05 Memberships & Invitations | Backend exists | Email delivery (needs an email provider), invite acceptance UI |
| ONCF-06 Tournament Creation | Backend exists | Organizer UI; catalog seeding for real sports (padel, tennis) |
| ONCF-07 Tournament Public Pages | Read API exists | Production public pages |
| ONCF-08 Registration | Backend exists | UI. Entry-fee hook (payments arrive in ONCF-18, or move Stripe forward; see note). |
| ONCF-09 Competition | Engines exist | Operator UI, schedule management |
| ONCF-10 Results & Verification | **Gap** | ➕ Add result submission and acceptance routes, OFFICIAL/FINAL transitions, grant issuance and production evidence storage. This is the largest backend gap. |
| ONCF-11 Rankings & Classification | Exists | Production systems per sport |
| ONCF-12 Achievements & Athlete History | Exists | Enable QUALIFIED producer; history UI |
| ONCF-13 / 14 Dashboards | Absent | As planned |
| ONCF-15 Rewards Engine | Absent | New `packages/rewards`; use the reserved `PRIZE_ENTITLEMENT` ledger stream |
| ONCF-16 Bragging Rights Integration | BR scope absent | Interpret as §16. New `packages/bragging-rights` plus `contracts/` (adapt the padelflow ERC-721). Decide soulbound vs transferable. KMS signer. **No tokenomics.** |
| ONCF-17 Embedded Wallets | EIP-191 linking exists | Embedded wallet provider; never custodial plaintext keys |
| ONCF-18 Payments | Prototype elsewhere | Adapt the padelflow Stripe webhook pattern |
| ONCF-19 / 20 | As planned | ONCF-20 replaces the legacy static pages |

**Note on payments.** The website claims online entry payments and clubs will expect them at registration. Consider moving a minimal Stripe entry-fee capability (ONCF-18a) to directly after ONCF-08. This is a product decision; it is not required by the architecture.

---

## 21. Exact Entry Conditions for ONCF-01

| Required knowledge | Status | Finding |
|---|---|---|
| Canonical repository location | **Not satisfied** | The recommendation is `Onchainfest-WebSite`, but the code that ONCF-01 must extend lives in `bragging-rights`. **Needs your decision:** Option A (transplant into `Onchainfest-WebSite`, recommended) or Option B (make `bragging-rights` the platform repo and rename it later). |
| Canonical application architecture | Known (proposed) | Modular monolith: Next.js web, Fastify API, worker, Postgres (§14) |
| Where authenticated surfaces belong | Known (proposed) | `/app/**` in the same Next.js app (§15) |
| Existing auth reality | Known | No IdP; `AuthAdapter` seam; fail-closed in production; dev HMAC tokens |
| Source of truth for users | Known | `identity.account` + `auth_identity` → `person` (BR model, moving to OCF) |
| Source of truth for athlete identity | Known | `identity.athlete` (1:1 person, separate from account) |
| Organization/tenant direction | Known | Org-scoped via memberships and organizer FKs; global athletes; application-enforced isolation; RLS deferred |
| Database/persistence direction | Partially | PostgreSQL + Kysely + SQL migrations (keep). **Hosting provider not chosen** (role-bootstrap compatibility). |
| Existing user/auth code reusable? | Known | Yes: the identity model, endpoint classes and permissions are reusable. Do not reuse any padelflow/Poker auth. |
| Prerequisite remediation required? | **Yes** | ONCF-00R |

### Gate

```text
ONCF-01 BLOCKED
```

**Blockers:**
1. The platform core (identity model, `AuthAdapter`, API) is not in the canonical repository, and the canonical repository has no application scaffold. Implementing ONCF-01 in either place now would mean doing it again, or cementing Bragging Rights as the sports system of record.
2. Option A or B (above) requires an explicit decision, because it involves moving or renaming repositories, which ONCF-00 forbids.

**Smallest remediation prompt: ONCF-00R — Platform Core Consolidation.**

> Import `OnChainFest/bragging-rights@9ad10fd` into `Onchainfest-WebSite` on a new branch from `main`, preserving history (`git subtree add` or a `filter-repo` merge), at the workspace root (`apps/`, `packages/`, `db/`, `tooling/`, `docs/`).
>
> Relocate the current `index.html`, `contact.html` and `img/` unchanged so the existing Vercel deployment keeps serving them, for example as `legacy-site/` with Vercel's root directory updated in a separately reviewed step.
>
> Do not change domain code, migrations, DB names or `@br/*` scopes. Re-run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration` and CI, and require all to be green.
>
> Add an ADR "OnChainFest owns the sports domain; Bragging Rights is re-scoped to digital artifacts". Mark the `bragging-rights` README and capability map as superseded.
>
> Leave the `bragging-rights` repository untouched (no deletion and no archive) until the transplant is reviewed.
>
> In the same step, record the managed-Postgres choice, or explicitly defer it to ONCF-01.

Once ONCF-00R merges and the hosting choice is recorded, ONCF-01 becomes: *choose and integrate an IdP behind `AuthAdapter`, and add the `/app` boundary.*

---

## 22. Final Decision Matrix

| Capability | Current repository | Future owner | Action | ONCF phase |
|---|---|---|---|---|
| Identity | bragging-rights (`identity.account`, `auth_identity`; no IdP) | OnChainFest | Migrate (00R); integrate an IdP behind `AuthAdapter` | 00R → 01 |
| Athlete profile | bragging-rights (`identity.athlete*`, `passport.*`) | OnChainFest | Migrate; build UI and privacy controls | 00R → 02 |
| Organization | bragging-rights (`organizations.organization`, profile, slug) | OnChainFest | Migrate; self-service UI; isolation tests | 00R → 03 |
| Membership | bragging-rights (`organizations.membership`, `OrgPermission`) | OnChainFest | Migrate; UI | 00R → 05 |
| Tournament | bragging-rights (`competition.competition`/`event`); padelflow (bowling, do not use) | OnChainFest | Migrate BR; organizer UI | 00R → 06/07 |
| Registration | bragging-rights (`competition.registration`, `participant`) | OnChainFest | Migrate; UI; payments hook | 00R → 08 |
| Competition | bragging-rights (format engines, rounds, contests, schedules) | OnChainFest | Migrate; operator UI | 00R → 09 |
| Results | bragging-rights (`results.*`; no submit route; stops at PROVISIONAL) | OnChainFest | Migrate; **complete the lifecycle and routes** | 00R → 10 |
| Verification | bragging-rights (`verification.*`, `attestation.*`, `evidence.*`; ceiling V1) | OnChainFest | Migrate; production evidence store and KMS | 00R → 10 |
| Ranking | bragging-rights (`ranking.*`, BRT-10) | OnChainFest | Migrate; production ranking systems | 00R → 11 |
| Classification | bragging-rights (`results.classification_*`) | OnChainFest | Migrate | 00R → 11 |
| Achievement | bragging-rights (`achievement.*`; zero canonical output until OFFICIAL results) | OnChainFest | Migrate; enable via ONCF-10 | 00R → 12 |
| Athlete history | bragging-rights (`passport.*`, `record.*`, read models) | OnChainFest | Migrate; history UI | 00R → 12/14 |
| Reward definition | none | OnChainFest | Build (`packages/rewards`) | 15 |
| Reward eligibility | none | OnChainFest | Build | 15 |
| Reward ledger | none (reserved `PRIZE_ENTITLEMENT` stream in `platform.ledger_entry`) | OnChainFest | Build on the existing hash-chained ledger | 15 |
| Wallet association | bragging-rights (`identity.wallet_link*`, EIP-191) | OnChainFest (verifier utility shared with BR) | Migrate; embedded wallet later; never custodial plaintext | 00R → 17 |
| Bragging Rights metadata | none in BR (padelflow `lib/ipfs` draft) | Bragging Rights | Build in `packages/bragging-rights`; adapt padelflow IPFS helpers; no PII (ADR-0009) | 16 |
| NFT minting | none in BR (padelflow `PadelFlowNFTTrophy.sol` undeployed; Poker `.txt` draft) | Bragging Rights | Adapt the padelflow contract (minter role, soulbound decision, tests); KMS signer; outbox-driven job | 16 |
| Blockchain ownership | none | Bragging Rights (read model of chain state) | Build (indexer/read model); no tokenomics | 16 |

---

## Appendix A — Qualification

Read-only validation was run in the repositories. No packages were installed.

| Command | Repository | Result | Exit | Related to ONCF-00? |
|---|---|---|---|---|
| `ls package.json tsconfig.json .github` | Onchainfest-WebSite | None exist, so there is **no build, lint or test command to run** | 2 (expected) | No (inherited: no toolchain) |
| `python3 -c "json.load(open('vercel.json'))"` | Onchainfest-WebSite | `vercel.json` is valid JSON | 0 | No |
| Python `html.parser` tag-balance check plus JSON-LD parse plus in-page anchor check | Onchainfest-WebSite | `index.html` and `contact.html`: 0 unbalanced tags; JSON-LD valid; all in-page `href="#…"` targets exist | 0 | No |
| `pnpm test` (vitest unit project, no DB) | bragging-rights | 41 files, **689 tests passed** | 0 | No |
| `pnpm typecheck` | bragging-rights | Passed | 0 | No |
| `pnpm test:integration` | bragging-rights | **Not run.** It requires a live Postgres (docker-compose) and resets a database. | — | — |
| padelflow `next build`/`jest` | padelflow | **Not run** (outside scope; no runtime changes made) | — | — |

`git status --short` in `bragging-rights` was still clean after the test runs.

## Appendix B — Evidence sources

- **Website:** `index.html`, `contact.html`, `vercel.json`, `.vercel/repo.json`, `git show main:index.html`, `git log`.
- **bragging-rights:**
  - code: `README.md:18`, `package.json`, `apps/api/src/auth.ts:11-20,147-148`, `apps/api/src/v1*.ts`, `apps/worker/src/main.ts`, `packages/*/src`
  - database: `db/migrations/0001`–`0030`, `db/bootstrap/roles.sql`
  - docs: `docs/adr/0001`–`0050`, `docs/implementation/BRT-03`–`BRT-10`, `docs/architecture/BRT-TARGET-CAPABILITY-MAP.md`, `docs/archaeology/BRT-00-*`
  - CI: `.github/workflows/ci.yml`
- **padelflow:** `app/admin/page.tsx` (no guard), `app/api/**`, `scripts/SETUP_SUPABASE_COMPLETE.sql`, `scripts/create-wallet-and-validation-tables.sql`, `contracts/PadelFlowNFTTrophy.sol`, `contracts/addresses.json`, `lib/ipfs/*`, `lib/wallet-service.ts`, `next.config.js:7`, `middleware.ts`, `public/mvp/*`.
- **Poker:** `supabase_schema.sql`, `contracts/simplified_brt_contract.txt`, `src/lib/flexible-nft-service.ts`.
- **Other repositories:**
  - `poker-tournament-backend/contracts/PrizeDistribution.sol`
  - `qr-code-hrke` commits `6fb817d` and `1d4cbe5` (file names only; no secret values were read into this document)
  - `LaNegrita-db/README.md`
