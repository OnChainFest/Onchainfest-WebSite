# ONCF-00R — Platform Core Consolidation

| | |
|---|---|
| Status | Consolidation complete on a local branch. Awaiting architectural review. **Not pushed, not merged.** |
| Date | 2026-10-05 |
| Decision implemented | ONCF-00 **Option A**: `Onchainfest-WebSite` is the canonical OnChainFest platform repository |
| Branch | `feat/oncf-00r-platform-core-consolidation` (no upstream configured) |
| Behavior changes | **None** (see §5 and §7) |
| Gate | **ONCF-01 BLOCKED**, on review and publication decisions only; no code remediation needed. See §15. |

---

## 1. Source baseline

| Item | Value |
|---|---|
| Path | `C:\Users\Usuario\source\OnChainFest\bragging-rights` |
| Remote | `github.com/OnChainFest/bragging-rights` (**private**) |
| Branch | `main`, clean worktree |
| HEAD | `9ad10fdf729c1b67871ef8057fcb30454f6ce813` (Merge PR #8, `feat/brt-10-integration-tests`) |
| Commits | 28 (first: `37af7fb` 2026-09-28; last: `9ad10fd` 2026-10-04) |
| Branches | 9 local and 10 remote feature branches, **all ancestors of `main`**. No tags. |
| CI on HEAD | GitHub Actions `ci` **success** on `9ad10fd`. This covers format, lint, typecheck, unit, vectors, bootstrap, migrate, **integration**, demos, seeds, worker smoke and web build. |
| Unit baseline (re-run locally, ONCF-00R) | **41 files / 689 tests passed** |
| Typecheck baseline (re-run locally) | `pnpm typecheck` exit 0 (16 workspace projects) |

## 2. Destination baseline

| Item | Value |
|---|---|
| Path | `C:\Users\Usuario\source\OnChainFest\Onchainfest-WebSite` |
| Remote | `github.com/OnChainFest/Onchainfest-WebSite` (**public**) |
| Branch at start | `feat/onchainfest-sports-platform-landing` @ `2f36f616027ce13b89396d97e8ee79965a2c2636` |
| Local `main` | `d54c4b4` (stale; left untouched) |
| `origin/main` after `git fetch` | `b700197`, "Merge pull request #4 from OnChainFest/feat/onchainfest-sports-platform-landing" |
| Tracked content | `index.html`, `contact.html`, `favicon.ico`, `logo.png`, `img/*` (14 PNGs), `vercel.json` |
| Pre-existing untracked work | `.gitignore` (`.vercel`, `.env*`) and `docs/audits/ONCF-00-ARCHITECTURE-AND-REPOSITORY-BOUNDARIES.md` |
| Ignored local files | `.env.local`, `.vercel/` (Vercel project link `onchainfest-web-site`, directory `.`) |

Pre-existing untracked work was handled as follows:

- **ONCF-00 audit:** left untracked and byte-identical. SHA-256 is `b65a062f…4361` before and after.
- **Untracked `.gitignore`:** it occupied the same path as the source repository's tracked `.gitignore`.
  - It was backed up and moved aside to the session scratchpad.
  - Its rules were carried into the tracked file. `.env*` is already covered by `.env` + `.env.*` (`.env.local` is verified ignored). `.vercel` was added explicitly.
  - Nothing was deleted. No `git clean`, `reset --hard`, `checkout .` or `restore .` was run.

## 3. Branch strategy and history-preservation strategy

### 3.1 Base branch

During ONCF-00R, `git fetch` showed that the landing-page branch had **already been merged into `origin/main`** upstream (PR #4, `b700197`). That merge happened outside this phase. The landing copy is therefore already the canonical website baseline, not a side branch.

- **Base:** `origin/main` @ `b700197`.
  - Not the stale local `main` (`d54c4b4`): branching from it would base the consolidation on superseded website content.
  - Not `feat/onchainfest-sports-platform-landing` itself.
- **Independence:** the platform consolidation touches none of `index.html`, `contact.html` or `img/`, so it does not depend on the landing copy.
- **Upstream:** the branch was created with `--no-track`, so no accidental `git push` can target `main`.

### 3.2 Method: root-level unrelated-histories merge

```bash
git switch --no-track -c feat/oncf-00r-platform-core-consolidation origin/main
git fetch ../bragging-rights main                      # FETCH_HEAD = 9ad10fd…
git merge --allow-unrelated-histories --no-ff FETCH_HEAD
```

Why this method, rather than `subtree` or `filter-repo`:

| Requirement | Result |
|---|---|
| No path collisions | Zero tracked-file collisions and **zero top-level directory overlap** between `origin/main` and source `main` (verified with `comm` on both trees). |
| Approved layout | The source repository already uses the approved layout (`apps/{api,web,worker}`, `packages/<domain>`, `db/`, `docs/`). A subdirectory import (`subtree --prefix`) would put the core under a misleading prefix such as `bragging-rights/packages/…`, which would need a second move. |
| Source history | **Every source commit keeps its original SHA** (for example `1a5bf78bf2b3…` is identical in both repositories). Commit graph, PR merge commits #1–#8, authors and dates are intact. `git log`, `git log --follow` and `git blame` work on the original paths with no rename heuristics. |
| Destination history | Untouched: 154 website commits, no rewrite. |
| Rejected: `filter-repo` | It rewrites SHAs, which would break the link to the private source repository's PRs and CI runs. It is not needed when paths already fit. |
| Rejected: copy/paste | It loses all history. |
| Source repository | Read-only throughout (`git fetch` from it writes only to the destination). |

Result: `HEAD` has 183 commits (154 website + 28 source + 1 import merge, `8416ba0`). Excluding website files, the imported tree is **byte-identical** to source `9ad10fd`: `git diff 9ad10fd 8416ba0` is empty for all platform paths.

## 4. Files and packages imported

Everything tracked in source `main` was imported: 548 files. Classification by top-level entry:

| Source path | Classification | Notes |
|---|---|---|
| `apps/api` (`@br/api`) | MOVE INTO PLATFORM CORE | Fastify API. Covers `/v1` identity, organizations, competition, evidence, verification, achievements, records and rankings. Holds the `AuthAdapter` seam. |
| `apps/worker` (`@br/worker`) | MOVE INTO PLATFORM CORE | Transactional-outbox consumer (achievements, records, rankings). |
| `apps/web` (`@br/web`) | MOVE INTO PLATFORM CORE | Next.js 16 public read surfaces: passport, organizations, competitions, hall of fame, rankings and verifications. It is **not** the marketing site. |
| `packages/domain`, `packages/canonical`, `packages/schemas` | MOVE INTO PLATFORM CORE | Shared kernel: ids, events, time, BR-JSON canonicalization and hashing, JSON schemas. |
| `packages/identity` | MOVE INTO PLATFORM CORE | Accounts, auth identities, persons, athletes, guardians, PII vault policy, passport, permissions and auth context. `wallet.ts` is REQUIRES REVIEW (ONCF-16/17), see ADR-0051. |
| `packages/authority` | MOVE INTO PLATFORM CORE | Scoped authority, grants and delegation. |
| `packages/competition` | MOVE INTO PLATFORM CORE | Sport catalog, competitions and events, registration, teams and lineups, format engines (brackets, round-robin), contests and the results ledger. |
| `packages/evidence`, `packages/verification` | MOVE INTO PLATFORM CORE | Evidence, attestations and the V0–V4 verification engine. |
| `packages/achievements`, `packages/records`, `packages/rankings` | MOVE INTO PLATFORM CORE | Achievements (incl. QUALIFIED), records and hall of fame, rankings and classifications. |
| `packages/persistence` | MOVE INTO PLATFORM CORE | Kysely stores, projections, migration runner, bootstrap, seeds and demos. |
| `packages/testkit` | MOVE INTO PLATFORM CORE | Test helpers and throwaway databases. |
| `db/migrations` (0001–0030), `db/bootstrap`, `db/docker` | MOVE INTO PLATFORM CORE | Unchanged (see §8). |
| `docs/adr` (ADR-0001…0050), `docs/{api,architecture,domain,examples,implementation,security,archaeology}` | MOVE INTO PLATFORM CORE | Paths kept unchanged to preserve history. ADR-0051 added. |
| `tooling/` (guard scripts, integration setup) | MOVE INTO PLATFORM CORE | Unchanged. |
| Root configuration: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `.editorconfig`, `.npmrc`, `.nvmrc`, `.gitattributes`, `.env.example` | MOVE INTO PLATFORM CORE | Only `package.json` metadata, `.prettierignore` and `.gitignore` changed (see §7). |
| `.github/workflows/ci.yml` | MOVE INTO PLATFORM CORE | Will run on push to this repository. It uses a disposable Postgres service container. |
| `README.md` | MOVE BUT RENAME LATER | Still titled "Bragging Rights". An OnChainFest ownership preamble was added; the full rewrite is deferred. |
| `docker-compose.yml` (`name: bragging-rights`) | KEEP TEMPORARILY | The compose project, volume and DB names are local-dev identifiers. Renaming them would orphan existing local volumes. |
| `@br/*` package scope | MOVE BUT RENAME LATER | Naming debt (§13). |
| `node_modules/`, local build output | DO NOT IMPORT | Untracked in the source repository; reinstalled from the unchanged lockfile. |
| Source feature branches | DO NOT IMPORT (separately) | All are already contained in `main`. |

Nothing tracked was left behind, so nothing needed an explicit DO NOT IMPORT decision.

## 5. Ownership changes

- **Repository ownership.** The sports-platform core now lives in the canonical OnChainFest repository. Ownership is recorded in [ADR-0051](../adr/ADR-0051-onchainfest-owns-the-sports-domain.md) (Proposed).
- **Physical placement.** Code sits under platform-level `apps/` and `packages/<domain>/` directories, not under any `bragging-rights` namespace.
- **Root workspace package.** Renamed from `bragging-rights` to `onchainfest`, with an updated description. This is metadata only: the name is absent from `pnpm-lock.yaml` and no package depends on it.
- **README and capability map.** `README.md` carries an OnChainFest ownership preamble. `docs/architecture/BRT-TARGET-CAPABILITY-MAP.md` is marked as superseded framing. Both are otherwise unchanged.
- **Reserved boundary.** `packages/bragging-rights/` is reserved by ADR-0051 for the future digital-artifact context, which owns token metadata, minting, token identity, the chain ownership read model and chain adapters. **It was not created.** No blockchain, token or minting code exists, which matches ONCF-00.

## 6. Target structure

The source layout already matched the approved directional tree, so no files were moved:

```text
Onchainfest-WebSite/
├── index.html, contact.html, favicon.ico, logo.png, img/, vercel.json   ← public website (unchanged)
├── .vercelignore                                                          ← NEW: website deploy allowlist
├── apps/
│   ├── api/        @br/api      Fastify API (+ AuthAdapter seam)
│   ├── web/        @br/web      Next.js platform read surfaces
│   └── worker/     @br/worker   outbox consumer
├── packages/
│   ├── domain/ canonical/ schemas/                 shared kernel
│   ├── identity/                                   accounts, persons, athletes, guardians, passport, auth context
│   ├── authority/                                  scoped authority & delegation
│   ├── competition/                                catalog, competitions, registration, brackets, results ledger
│   ├── evidence/ verification/                     evidence, attestation, verification engine
│   ├── achievements/ records/ rankings/            achievements, records/HoF, rankings/classifications
│   ├── persistence/                                Postgres stores, migration runner, bootstrap, seeds
│   └── testkit/
│   (bragging-rights/ — RESERVED, not created; ADR-0051)
├── db/{migrations (0001–0030), bootstrap, docker/init}
├── docs/{adr, api, architecture, archaeology, audits, domain, examples, implementation, security}
├── tooling/
└── package.json, pnpm-workspace.yaml, pnpm-lock.yaml, tsconfig.base.json, vitest.config.ts, …
```

Deviations from the ONCF-00 directional tree, all deferred deliberately:

| ONCF-00 target | Current reality | Reason |
|---|---|---|
| `packages/organizations` | Organizations live in `packages/identity` (model and permissions), `packages/persistence/src/organization-store.ts` and migration `0005`. | Extracting a package changes imports across packages, which is a refactor. |
| `packages/rewards` | Absent | Rewards are out of scope for ONCF-00R. |
| `packages/evidence`, `domain`, `canonical`, `schemas`, `persistence`, `testkit` | Not in the ONCF-00 tree | They exist and are load-bearing. They were kept. |
| Website moved to `legacy-site/`, with the Vercel root directory changed | Website kept at the root | No Vercel dashboard change is needed, and production output stays identical (§7.1). |

## 7. Package and workspace changes

Delta on top of the import merge. All changes are mechanical; none touch domain code.

| File | Change | Why |
|---|---|---|
| `package.json` | `name` `bragging-rights` → `onchainfest`, plus a new `description` | Root ownership (§5). |
| `.gitignore` | Source file, plus `.vercel` | Carries over the website's local ignore rule. |
| `.prettierignore` | Adds `/index.html`, `/contact.html`, `/vercel.json` | Without this, `pnpm format:check`, and therefore CI, fails on the website files. The website must not be reformatted. |
| `.vercelignore` | **New.** Allowlist of the website files only. | See §7.1. |
| `README.md`, `docs/adr/README.md`, `docs/architecture/BRT-TARGET-CAPABILITY-MAP.md`, `docs/adr/ADR-0051-…` | Documentation | Ownership. |
| `pnpm-lock.yaml` | **Unchanged** | `pnpm install --frozen-lockfile` succeeded with the pinned pnpm 10.34.5 from `packageManager`. |

No dependency was added, removed or upgraded, and no package manager was mixed in.

### 7.1 Public website deploy compatibility

Before ONCF-00R, Vercel project `onchainfest-web-site` deployed the repository root as a static site with no `package.json` and no build.

After consolidation, the root holds a pnpm workspace. Without a guard, Vercel would:

- detect `package.json` and `pnpm-lock.yaml` and attempt `pnpm install` (engine-strict, about 220 packages);
- with no output directory, serve **the whole repository root** publicly, including `packages/`, `apps/`, `db/`, `docs/security/*` and `.env.example`.

`.vercelignore` uploads only `index.html`, `contact.html`, `favicon.ico`, `logo.png`, `img/` and `vercel.json`. That is exactly the previously deployed set. Without `package.json`, no install or framework detection occurs.

Verified locally:

- The committed blobs of all website files are identical in `HEAD` and `origin/main`.
- The imported `.gitattributes` (`* text=auto eol=lf`) causes no renormalization, because the website blobs were already stored as LF.

**Not verifiable locally:** whether the Git-integration deployment honors `.vercelignore` exactly as intended. **Before merging, inspect the Vercel preview deployment of this branch:**

- the build log shows no install step;
- `/` and `/contact.html` render;
- `/package.json` and `/docs/adr/README.md` return 404.

Fallback if needed: set `"installCommand": ""`, `"buildCommand": ""` and `"framework": null` in `vercel.json`. Alternatively, follow the ONCF-00 `legacy-site/` plus root-directory route as a separately reviewed step.

## 8. Database migration handling

- **Preserved:** all 30 migrations `db/migrations/0001_platform.sql` … `0030_ranking_staff_reader.sql`, plus `db/bootstrap/{roles,database}.sql` and `db/docker/init/01-create-test-db.sql`. They are byte-identical to the source and keep their full per-file history.
- **Not done:** no squashing, renumbering, rewriting or semantic change.
- **Not executed:** no migration was run against any database during ONCF-00R.
- **Database identifiers unchanged:** `bragging_rights`, `bragging_rights_test` and the `br_*` roles. Changing them would change runtime behavior.

## 9. Tests

| Check | Source (`bragging-rights`) | Consolidated branch |
|---|---|---|
| `pnpm test` (vitest project `unit`) | 41 files / 689 passed | **41 files / 689 passed** |
| Test files changed | — | **None** |

## 10. Typecheck and other validation

| Check | Result |
|---|---|
| `pnpm typecheck` (16 workspace projects) | **Pass** (exit 0) |
| `pnpm lint` (ESLint `--max-warnings=0` + 6 repository guards: key material, result-ledger composition, no manual verification/achievement/record/ranking) | **Pass** |
| `pnpm format:check` | **Pass** (after the `.prettierignore` website entries in §7) |
| `pnpm vectors:check` (BR-JSON v1, BRT-06…BRT-10 golden vectors, reproduced, plus independent Python reference checkers) | **Pass** (exit 0) |
| `pnpm --filter @br/web build` (Next.js 16) | **Pass** (18 routes) |
| `pnpm install --frozen-lockfile` | **Pass**; lockfile unchanged |

## 11. Integration-test status

```text
NOT RUN — unsafe without disposable test database
```

Reasons:

- `packages/persistence/src/config.ts` hard-codes `localhost:55432` as the development host. Redirecting it means overriding about 15 separate `BR_*_DATABASE_URL` variables, and missing one would silently fall back to `localhost:55432`.
- `pnpm db:bootstrap` changes **cluster-wide** roles. The integration `globalSetup` resets the `bragging_rights_test` database.
- The only Postgres on `localhost:55432` is the existing `bragging-rights-postgres-1` container, which has been running for three days with a persistent `br-pgdata` volume. It is the user's development cluster and cannot be proven disposable.

Mitigating evidence: the imported platform tree is byte-identical to `9ad10fd`, whose GitHub Actions run (incl. bootstrap, migrate from clean, `pnpm test:integration`, demos and seeds) **succeeded**.

The safe way to qualify integration tests in this repository is its own CI. `ci.yml` runs them against a disposable `postgres:18.3-alpine` service container on push or PR. That depends on the publication decision in §15.

## 12. Git-history verification

All commands below were run on `feat/oncf-00r-platform-core-consolidation`.

```text
$ git log --follow --format='%h %ad %s' --date=short -- packages/rankings/src/ranking-engine.ts
700d82f 2026-10-02 feat(rankings): add ranking read models

$ git log --format='%h %ad %s' --date=short -- packages/rankings
e94126a 2026-10-03 feat(rankings): add BRT-10 ranking and classification API
62ba937 2026-10-02 feat(qualification): add qualified achievement
700d82f 2026-10-02 feat(rankings): add ranking read models

$ git log --follow --oneline -- db/migrations/0004_identity.sql
1e87ac4 feat: add identity athlete passport and organizations

$ git log --oneline -- db/migrations          (11 commits, 1a5bf78 … e94126a)

$ git log --follow --oneline -- apps/api/src/auth.ts
1e87ac4 feat: add identity athlete passport and organizations

$ git log --follow --oneline -- apps/api/src/v1-rankings.ts
e94126a feat(rankings): add BRT-10 ranking and classification API

$ git log --follow --oneline -- docs/adr/ADR-0010-modular-monolith.md
984585f docs: define platform architecture and trust infrastructure

$ git blame -L 1,1 apps/api/src/auth.ts
1e87ac47 (Victor Valverde 2026-09-28 20:07:30 -0600 1) import { createHmac, timingSafeEqual } from 'node:crypto';

$ git rev-parse 1a5bf78   # identical SHA in both repositories
1a5bf78bf2b3ebd5823685de245b74644ab1f9b6
```

The import is **not** a single "initial import" commit. All 28 source commits are ancestors of `HEAD`.

## 13. Unresolved naming debt

Deferred deliberately, because each item is either an identifier or a broad rename:

| Name | Where | Risk if renamed | Defer to |
|---|---|---|---|
| `bragging-rights/sig/v1:` signature domain tag | `packages/evidence` (proof/attestation), vectors | **Hashed and signed.** Invalidates existing signatures and golden vectors. | Explicit decision (new `sig/v2` tag, never in place) |
| `bragging-rights:<env>` signature audiences (`BR_SIGNATURE_AUDIENCE`) | evidence, api, `.env.example` | Signed into statements | Same as above |
| `bragging-rights-{verification,achievement,record,ranking}-engine`, `bragging-rights-api` | engine and issuer ids | Persisted and hashed into snapshots and vectors | Same as above |
| `bragging_rights` / `bragging_rights_test` databases, `br_*` roles (35 roles), `BR_*` env vars | persistence config, bootstrap, migrations (grants), CI | Database identity and grants | When the hosting provider is selected |
| `@br/*` package scope (16 packages) | every import | Broad mechanical rename. No runtime semantics, but large diff. | A dedicated rename PR |
| `README.md` title, BRT-NN doc ids, `docker-compose.yml` project name | docs and local dev | Low | Documentation pass |
| Root `README.md` "Bragging Rights is being built as infrastructure for verified sports achievement" | README | Misleading framing (mitigated by the preamble and ADR-0051) | Documentation pass |

## 14. Unresolved database-provider concern

The authorization model was preserved, not redesigned. Requirements a production Postgres provider must meet:

1. **Roles.** It must allow creating about 35 roles, both NOLOGIN group roles and LOGIN NOINHERIT logins, with `SET ROLE` membership graphs.
   - Since PG16, `CREATEROLE` grants admin only on roles the creator made, so the bootstrap admin must create all `br_*` roles itself.
   - Roles are created `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`.
   - No `SUPERUSER`, `ALTER SYSTEM` or `CREATE EXTENSION` is required (checked by grep in bootstrap and migrations).
2. **Databases.** It must allow per-database `REVOKE ALL … FROM PUBLIC` and `REVOKE ALL ON SCHEMA public FROM PUBLIC`. CI and tests expect a second database (`bragging_rights_test`) in the same cluster.
3. **Functions and locks.** `SECURITY DEFINER` functions owned by `br_owner` are used, and advisory locks (`pg_advisory_xact_lock*`) are used.
4. **Version.** Development and CI use PostgreSQL 18.3.
5. **Connection model.** The bootstrap sets per-role passwords, and the application uses about 15 distinct login URLs. The provider and pooler must support many logins, and `SET ROLE` must survive pooling. Session pooling works; transaction pooling needs review.
6. **Fail-open risk.** P1-6 from ONCF-00 remains: development password fallbacks apply whenever `NODE_ENV !== 'production'`.

**Effect on ONCF-01:** this does not block ONCF-01 as long as ONCF-01 is developed and tested against the local or CI cluster. It does block **deploying** the API, worker or authentication to any hosted environment. The provider decision is explicitly deferred to the first hosted deployment, not decided here.

## 15. ONCF-01 entry readiness

| Condition | Status |
|---|---|
| Platform core has one canonical repository | **Yes, locally.** On this branch; becomes canonical upstream once merged. |
| Source history preserved sufficiently | **Yes.** Original SHAs and full graph (§12). |
| Packages resolve | **Yes.** Frozen-lockfile install; typecheck, lint and build are green. |
| Tests pass | **Unit: yes** (41/689). **Integration: not run here** (§11); green in the source CI on the identical tree. |
| Typecheck passes | **Yes** |
| Existing migrations available | **Yes.** 0001–0030, unchanged. |
| User/account domain location clear | **Yes.** `packages/identity` (`model.ts`, `auth.ts`, `permissions.ts`, `policies.ts`); `identity.account`, `auth_identity`, `person`, `account_person_control` (migration `0004`); `packages/persistence/src/identity-store.ts` (`signIn(provider, providerSubject)`). |
| Auth extension point clear | **Yes.** The `AuthAdapter` interface in `apps/api/src/auth.ts`. Production default is `failClosedAuth`; development uses HMAC tokens. ONCF-01 adds an IdP adapter that resolves through `IdentityStore.signIn`. |
| No repository-boundary ambiguity | **Not yet.** The consolidation is unreviewed and unmerged, so upstream `main` still lacks the core and `bragging-rights` remains the de facto upstream. |

```text
ONCF-01 BLOCKED
```

Every technical condition is met on the branch. The remaining blockers are review and publication decisions; no code change is needed.

1. **Repository visibility decision (P0, before any push).** `bragging-rights` is **private**; `Onchainfest-WebSite` is **public**. Pushing this branch publishes the whole platform source, its full commit history, the threat reviews in `docs/security/*` and the development-only credentials in `.env.example`, `docker-compose.yml` and `ci.yml`. The owner must choose one:
   - make `Onchainfest-WebSite` private, after checking that the Vercel plan supports private-org repositories; or
   - explicitly approve publishing the platform source.
2. **Qualify on the canonical remote.** Push the branch and open a PR against `main`. CI then runs the integration suite against a disposable Postgres, and Vercel produces a preview to verify `.vercelignore` (§7.1).
3. **Architectural review and merge** of this branch to `main`. ADR-0051 moves from Proposed to Accepted.

Once these three steps are done, ONCF-01 is: *integrate an IdP behind `AuthAdapter` in `apps/api/src/auth.ts` and extend `packages/identity`*. The Postgres hosting provider is not a prerequisite for that work (§14).

## 16. External P0/P1 actions (out of scope; not touched)

These come from ONCF-00 and are recorded here only. No other repository was modified.

- **P0:** the Supabase **service-role key** committed in `qr-code-hrke` history (`6fb817d`) must be **rotated**.
- **P0:** `padelflow` / La Negrita deployment. If it is live, it exposes:
  - unauthenticated `/admin` and mutation endpoints;
  - `POST /api/auth/test-credentials`;
  - open RLS;
  - plaintext custodial keys in `player_wallets`.

  Take it down or lock it down.
- **P1:** ONCF-00 P1-1 … P1-6 remain open (IdP, result lifecycle, website claims, BR copy, deployment target, development password fallbacks).

## 17. Source repository status

`bragging-rights` was used read-only:

- No commits, branch changes or pushes.
- It was not deleted or archived.
- `main` is still `9ad10fd`, with a clean worktree.

The only local side effects there are the ignored test runner and TypeScript caches from the baseline re-run.

## 18. Changes in this phase

- Branch `feat/oncf-00r-platform-core-consolidation`, two commits on top of `origin/main`:
  1. `chore(oncf-00r): import bragging-rights platform core with full history`: the unrelated-histories merge.
  2. The follow-up commit with the deploy compatibility, ignore files, root package metadata and ownership docs (§7), plus this audit.
- Not pushed. Not merged. Local `main` untouched. No production deployment touched. No database touched.
