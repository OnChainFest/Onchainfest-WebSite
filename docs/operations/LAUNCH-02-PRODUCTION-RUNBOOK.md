# LAUNCH-02 — Production and staging runbook

| | |
|---|---|
| Status | Repository-side ready. **Nothing has been deployed** and no provider resource exists in Git. |
| ADR | [0077](../adr/ADR-0077-governance-issued-competition-result-authority.md) (result authority); builds on [0052](../adr/ADR-0052-supabase-auth-is-the-identity-provider-behind-the-auth-adapter.md) (auth) and [0030](../adr/ADR-0030-development-encrypted-evidence-store-and-fail-closed-production.md) (fail-closed evidence) |
| Artifacts | `Dockerfile` (`api`, `worker` targets), `.dockerignore`, `.github/workflows/containers.yml`, `.github/workflows/db-migrate.yml`, `.env.example` |

This runbook lets an engineer stand up **staging** and **production** without private credentials in the repository. Every value marked *secret* lives only in the deployment platform's secret store and in the GitHub Environment of the same name.

## 1. Topology

| Component | Runs as | Hosting (provider-neutral) | Database login(s) |
|---|---|---|---|
| Marketing site | static files | Vercel project `onchainfest-web-site` (unchanged; `vercel-deploy.yml`) | none |
| `apps/web` (Next.js) | `next build` / `next start` | Any Node 22 host; ONCF-00A proposes its own Vercel project | none (calls the API server-side) |
| API | `Dockerfile --target api` | Any container host behind TLS | `br_api`, `br_api_vault` (+ optional operator logins) |
| Worker | `Dockerfile --target worker` | Any container host, one long-running replica | `br_worker_app` (+ optional dedicated worker logins) |
| PostgreSQL 18 | managed or self-hosted | Must allow custom roles, `NOINHERIT`, `SET ROLE`, `SECURITY DEFINER` and advisory locks | `br_admin` (bootstrap), `br_owner` (migrations) |
| Supabase Auth | Supabase project | Supabase | none (JWKS only) |

Browsers talk **only** to `apps/web`. The API and Supabase are called server-side, so the API sends no CORS headers and stays reachable only from `apps/web` and operators (private network or allow-list recommended).

Use one Supabase project, one database and one signature audience **per environment**. Never share them between staging and production: the audience is bound into every signed statement, so staging signatures are invalid in production.

## 2. Environment contract

Production behaviour is selected by `NODE_ENV=production`. Every process validates its configuration at start and **refuses to start** when something required is missing or a development value is present. Errors name variables, never values.

### 2.1 API (`apps/api`; validated by `apps/api/src/config.ts`)

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | yes | `production` (the image sets it) |
| `HOST`, `PORT` | image defaults `0.0.0.0` / `8080` | `PORT` 1–65535 |
| `BR_API_DATABASE_URL` | yes, *secret* | `br_api` login, with `sslmode` as the provider requires |
| `BR_VAULT_DATABASE_URL` | yes, *secret* | `br_api_vault` login. `/ready` checks it |
| `BR_AUTH_PROVIDER` | yes | must be `supabase` |
| `BR_SUPABASE_URL` | yes | `https://<project>.supabase.co`, or the custom auth domain that appears in the token `iss` |
| `BR_SIGNATURE_AUDIENCE` | yes | `bragging-rights:staging` / `bragging-rights:prod`; never `…:development` |
| `BR_OPERATOR_DATABASE_URL` | optional, *secret* | Enables INTERNAL catalog mutation (otherwise 503) |
| `BR_VERIFICATION_OPERATOR_DATABASE_URL`, `BR_ACHIEVEMENT_OPERATOR_DATABASE_URL`, `BR_RECORD_OPERATOR_DATABASE_URL` | optional, *secret* | Enable the matching INTERNAL rule endpoints (otherwise 503) |
| `BR_DEV_AUTH`, `BR_DEV_AUTH_SECRET`, `BR_VAULT_DEV_KEY`, `BR_EVIDENCE_DEV_KEY`, `BR_EVIDENCE_DEV_DIR` | **must be unset** | Development-only; production refuses them |

Never set admin, owner, worker or maintenance URLs on the API.

### 2.2 Worker (`apps/worker`)

| Variable | Required | Notes |
|---|---|---|
| `BR_WORKER_DATABASE_URL` | yes, *secret* | `br_worker_app` |
| `BR_ACHIEVEMENT_WORKER_DATABASE_URL`, `BR_RECORD_WORKER_DATABASE_URL`, `BR_RANKING_WORKER_DATABASE_URL` | yes for a complete platform, *secret* | Without them the consumer is skipped |
| `BR_WORKER_REQUIRED_CONSUMERS` | recommended | `achievements.derive,records.evaluate,rankings.react`. The worker refuses to start when any of them is disabled |

### 2.3 Web (`apps/web`)

| Variable | Required | Notes |
|---|---|---|
| `BR_API_URL` | yes | Private API origin (server-side only) |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | The publishable key only; **never** the service-role key |
| `NEXT_PUBLIC_SITE_URL` | yes | The app origin; email links fail closed without it |
| `NEXT_PUBLIC_MARKETING_URL` | optional | Defaults to `https://www.onchainfest.xyz` |

Security headers come from `apps/web/app/_lib/security-headers.ts`: CSP with `connect-src` and `form-action` limited to `'self'`, anti-framing, nosniff, and HSTS in production.

### 2.4 Operator commands (run from the `api` image or a checkout; never from the API process)

| Command | Variables |
|---|---|
| `pnpm db:bootstrap` | `BR_ADMIN_DATABASE_URL`, `BR_DATABASE_NAME`, and the 13 `BR_*_PASSWORD` values (each at least 24 characters; listed in `.env.example`), all *secret* |
| `pnpm db:migrate` | `BR_OWNER_DATABASE_URL` (*secret*) |
| `pnpm db:catalog:provision` | `BR_OPERATOR_DATABASE_URL` (*secret*), `BR_CATALOG_OPERATOR_ACCOUNT_ID` |
| `pnpm authority:results …` | `BR_API_DATABASE_URL` (*secret*), `BR_PLATFORM_PRINCIPAL_ID` |

## 3. One-time environment setup (manual, per environment)

1. **PostgreSQL.**
   - Create a database server (PostgreSQL 18).
   - Note the administrator connection that can create roles.
   - Validate the role model on the chosen provider **before** relying on it. ONCF-00R §14 is still open: about 15 logins, `NOINHERIT` + `SET ROLE`, `SECURITY DEFINER`, and session-mode pooling (transaction pooling breaks `SET LOCAL ROLE` and advisory locks).
2. **Bootstrap roles and hardening** (idempotent; it also rotates passwords when re-run):

   ```sh
   NODE_ENV=production BR_DATABASE_NAME=onchainfest \
   BR_ADMIN_DATABASE_URL=… BR_OWNER_PASSWORD=… BR_API_PASSWORD=… (all 13) \
   pnpm db:bootstrap
   ```

   This creates the roles from `db/bootstrap/roles.sql` and sets one password per login. It also creates the database if missing and revokes PUBLIC access. `br_probe` gets no password.
3. **Store the per-login connection URLs** in the platform secret store (API, worker) and in the GitHub Environment `staging` / `production` (`BR_OWNER_DATABASE_URL`, `BR_OPERATOR_DATABASE_URL`, `BR_CATALOG_OPERATOR_ACCOUNT_ID`). GitHub Environments must exist with those names. Add required reviewers on `production`.
4. **Supabase project.** Configure it exactly as [ONCF-01 §3](../implementation/ONCF-01-AUTH-UX.md):
   - asymmetric (ES256/RS256) JWT signing keys;
   - Site URL = `NEXT_PUBLIC_SITE_URL`;
   - redirect allow-list `<site>/auth/callback**` and `<site>/auth/confirm**`;
   - confirm email on;
   - anonymous sign-ins off.
5. **Migrate:** GitHub → Actions → `db-migrate` → environment, run. Or `NODE_ENV=production BR_OWNER_DATABASE_URL=… pnpm db:migrate`.
6. **Catalog provisioning:**
   - Sign in once through the deployed web app to create the operator's platform account.
   - Run `db-migrate` with `provision_catalog: true`, or `pnpm db:catalog:provision --operator-account <uuid>`. It is idempotent. Exit 2 means catalog conflicts the operator must resolve.
7. **Platform trust anchor** (ADR-0077 §2.1). Do this once per environment, after a recorded governance decision:

   ```sh
   pnpm authority:results bootstrap-anchor --governance-ref gov:2026-10:platform-anchor --basis-ref charter:platform-v1
   ```

   Store the printed `platformPrincipalId` as `BR_PLATFORM_PRINCIPAL_ID`. Re-running with the same reference returns the same anchor.

## 4. Deploying a version

1. CI (`ci`) and `containers` are green on the commit.
2. **Migrations first** (`db-migrate`). Migrations are forward-only and must stay expand-only: the running API must keep working on the new schema. A new API version is not ready (`/ready` 503 `pending_migrations`) until its migrations are applied.
3. Build and push the `api` and `worker` images to the chosen registry, tagged with the commit SHA. There is no registry or push in this repository yet.
4. Roll out the API, gating traffic on `GET /ready`; `GET /health` is liveness only.
5. Roll out the worker. Run `node --import tsx apps/worker/src/main.ts --check` as a pre-start or init step: it exits 1 when the database is unreachable, migrations are pending, or a required consumer is disabled.
6. Deploy `apps/web` with the §2.3 variables.

## 5. Verification

| Check | Expected |
|---|---|
| `GET /health` | 200 `{status:"ok"}` |
| `GET /ready` | 200 `{status:"ready"}`. 503 reasons: `database_unavailable`, `pending_migrations` (with the list), `vault_database_unavailable` |
| Response headers | `content-security-policy: default-src 'none'…`, `x-frame-options: DENY`, `strict-transport-security` (production), no `access-control-*` |
| `GET /v1/me` without a token | 401 |
| Worker `--check` | `{"status":"ready","consumers":[…all enabled…]}`, exit 0 |
| Private data / evidence upload | 503 `PRIVATE_DATA_UNAVAILABLE` / `EVIDENCE_STORAGE_UNAVAILABLE`. **Expected**: no KMS or object store exists yet (ADR-0030) |
| `pnpm authority:results list --competition <id>` | Grants with status `ACTIVE`, `REVOKED`, `EXPIRED` or `SCHEDULED` |

## 6. Result authority operations (ADR-0077)

**Trust boundary (ADR-0077 §2.7).** Read this before running any step below:

- `authority:results` is authorized only by possession of the API database credential plus access to a controlled environment. It has no operator identity, no MFA and no independent approval step.
- Restrict `BR_API_DATABASE_URL` to the API runtime and named operators.
- Run `authority:results` only from a controlled environment.
- The `--governance-ref` value is format-validated audit metadata. It is recorded in the audit trail and keys idempotency. It is **not** checked against any governance record or approver list. The governance record itself lives outside the platform and must be kept by the operator.

The organizer asks the platform to enable results for a tournament. The operator then works through these steps:

1. **Record the governance decision outside the platform.** Note who asked, who approved and which competition, then use its identifier as `--governance-ref`. The reference must contain no personal data. The platform stores it but cannot verify it.
2. **Confirm the competition.** It must be `PUBLISHED` or `ACTIVE`, and the grantee must be an OWNER or ADMIN of it (organizer-organization OWNER/ADMIN, or explicit competition staff).
3. **Grant:**

   ```sh
   pnpm authority:results grant --competition <uuid> --account <grantee account uuid> --governance-ref gov:…
   ```

   Refusals (exit 3):
   - `NOT_RESULT_STAFF`;
   - `GRANTEE_PARTICIPATES`;
   - `COMPETITION_NOT_OPERATING`;
   - `NOT_A_PLATFORM_PRINCIPAL`;
   - `GOVERNANCE_DECISION_USED` (re-granting after a revocation needs a new decision).

   A repeated grant returns the existing one (`created: false`).
4. **Revoke when a person stops running results** (role removed, staff ended, end of event):

   ```sh
   pnpm authority:results revoke --competition <uuid> --account <uuid> --governance-ref gov:… --reason "…"
   ```

   Revocation is prospective. Ending a staff role already stops that person's result actions over the API at once, but the grant stays until revoked, so always revoke.
5. **Know what the grant allows.** It covers submit, accept, declare official and correct for every contest of **that competition only**. It is never delegable. Accept, declare and correct are refused while the person participates in the competition (`CONFLICT_OF_INTEREST`).

## 7. Rollback

| Situation | Action |
|---|---|
| Bad API / worker release | Redeploy the previous image tag. Expand-only migrations keep the old code compatible |
| Bad migration | **No down migrations.** Ship a new forward migration. Restore from the provider's point-in-time backup only as a last resort, accepting data loss after the restore point |
| Wrong result grant | `authority:results revoke` (prospective, audited). Results already declared stay attributable to the grant that authorized them |
| Compromised operator credential | Rotate passwords by re-running `db:bootstrap` with new `BR_*_PASSWORD` values, then update the secret stores. Review `platform.audit_event` rows `authority.result-grant.*` |
| Web release | Redeploy the previous build. It has no schema coupling |

## 8. Manual work that cannot live in Git

- Choose and create the API/worker container host, registry, TLS and private network, then add a deploy workflow for it.
- Create the managed PostgreSQL instance, and validate role-model and pooling compatibility (ONCF-00R §14).
- Set up backups / point-in-time recovery and their retention.
- Create the Supabase projects (staging, production) and configure them (§3.4).
- Create the GitHub Environments `staging` and `production` with secrets and reviewers.
- Create a Vercel (or other) project for `apps/web`, with its domain and environment variables.
- Write the governance decision records for the platform anchor and each result grant.
- Run first sign-in for the operator account, catalog provisioning and the anchor bootstrap.
- Monitoring and alerting on `/ready`, worker logs and the outbox backlog. None is configured.

## 9. Known limitations

- **PII vault and evidence bytes** stay unavailable in production (503) until a KMS-backed cipher and an object store exist (ADR-0030).
- **Web rate limiting** is per instance and in memory (ONCF-01 §4).
- **`authority:results` uses the API login.** Holding the API credential is the effective authorization for result authority, as it already was before LAUNCH-02. Future work (none of it exists yet; ADR-0077 §2.7):
  - a dedicated least-privilege authority-operator login;
  - validated governance records with approvers;
  - operator identity attribution in audit rows.
- **The image runs TypeScript through `tsx`** and therefore ships development dependencies. A compiled build would shrink it.
- **Only PLATFORM-level recognition** is available for results. A federation anchor is needed for anything higher.
