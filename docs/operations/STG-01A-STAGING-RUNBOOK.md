# STG-01A — Isolated staging runbook (single VM)

| | |
|---|---|
| Status | Source only. **Nothing is provisioned or deployed.** No staging VM, DNS record, Supabase project or SMTP account exists yet. |
| Purpose | Run one complete four-player tennis pilot on an environment fully separate from production. |
| Artifacts | `deploy/staging/compose.yml`, `deploy/staging/Caddyfile`, `deploy/staging/.env.example`, `deploy/staging/preflight.sh`, `deploy/staging/sql/f1-foreign-result-grants.sql`, `deploy/staging/sql/f3-timeouts.sql`, the `web` target in `Dockerfile`, `.github/workflows/staging-infra.yml` |
| Builds on | [LAUNCH-02 runbook](LAUNCH-02-PRODUCTION-RUNBOOK.md) (environment contract, result-authority operations) and [ONCF-01](../implementation/ONCF-01-AUTH-UX.md) (Supabase settings) |

## 1. Topology

One Linux VM runs everything with Docker Compose. Supabase (a separate **staging** project) provides authentication only.

| Service | Image | Networks | Published | Notes |
|---|---|---|---|---|
| `caddy` | `caddy:2.11.7-alpine` | `edge` | 80, 443 (TCP and UDP) | Automatic Let's Encrypt TLS for `STAGING_DOMAIN`, HTTP→HTTPS, routes only to `web`, `X-Robots-Tag: noindex` |
| `web` | `Dockerfile --target web` | `edge`, `app` | none | `next start`; calls the API server-side at `http://api:8080` |
| `api` | `Dockerfile --target api` | `data`, `app`, `api-egress` | none | Healthy only when `/ready` is 200 (database reachable, every migration applied). Egress only for the Supabase JWKS |
| `worker` | `Dockerfile --target worker` | `data` | none | Achievements, records and rankings consumers. No internet egress |
| `postgres` | `postgres:18.3-alpine` | `data` | none | The exact image CI and the QA environment use. Volume `pgdata` |
| `ops` | the api image | `data` | none | Profile `ops`: **never started by `up`**. Runs bootstrap, migrations, catalog and `authority:results` only when invoked |

- `data` and `app` are `internal` networks: no egress and no published port. The database is reachable only from `api`, `worker` and `ops`.
- Browsers reach only Caddy, which reaches only `web`. The API sends no CORS headers and no browser-side code calls it (ONCF-01 / LAUNCH-02 §1), so no same-origin API proxy is needed.
- Every database URL is composed in `compose.yml` and points at `postgres:5432/onchainfest`. A service cannot be configured against another environment's database.
- `BR_SIGNATURE_AUDIENCE` is fixed to `bragging-rights:staging` and `BR_AUTH_PROVIDER` to `supabase`. Development auth, the dev vault key and the dev evidence store are never set; the API refuses them in production mode anyway.
- Every container keeps logs in rotated JSON files (5 × 10 MB per service).
- Private data and evidence uploads answer 503 by design (ADR-0030). The tournament lifecycle does not use them.
- There is no payment processing anywhere in the platform.

## 2. Prerequisites (manual; each needs account access or payment approval)

| # | Item | Requirement |
|---|---|---|
| P1 | VM | x86_64 Linux, **2 vCPU / 4 GB RAM / ≥ 40 GB disk** (images are built on the VM; `next build` and `pnpm install` are the memory peak). Docker Engine with the Compose v2 plugin, `git`, `openssl`. A public IPv4 address. |
| P2 | Firewall | Inbound 80/tcp, 443/tcp, 443/udp from anywhere; 22/tcp from operator addresses only. Use the provider's cloud firewall: ports published by Docker bypass `ufw`. Nothing else inbound. |
| P3 | DNS | `STAGING_DOMAIN` (for example `staging.<your-domain>`, never `onchainfest.xyz` or `www.onchainfest.xyz`) as an A (and optionally AAAA) record pointing at the VM, **before** the first start. |
| P4 | Supabase staging project | A new project used for nothing else (see §3). |
| P5 | Email delivery | A transactional email provider configured as the project's custom SMTP, with SPF/DKIM on the sending domain. Supabase's built-in email delivers only to the project team's addresses, at about 2 messages per hour, so real pilot participants cannot sign up without it. |
| P6 | Repository access on the VM | A **read-only** deploy key for this repository, or a `git archive` of the exact commit copied to the VM. |
| P7 | Governance records | Recorded outside the platform before the anchor and each result grant (LAUNCH-02 §6). |
| P8 | Operators | Named people with SSH access. Holding the VM is the effective authorization for result authority (ADR-0077 §2.7). |

## 3. Supabase staging project settings

Apply exactly ONCF-01 §3 ("Against a real Supabase project"), with the staging origin:

- JWT signing keys: **asymmetric** (ES256 or RS256) as the current key. The API rejects HS256.
- Confirm email: **on**. Anonymous sign-ins: **off**. Minimum password length 8, letters and digits.
- Site URL: `https://<STAGING_DOMAIN>`.
- Redirect allow-list: `https://<STAGING_DOMAIN>/auth/callback**` and `https://<STAGING_DOMAIN>/auth/confirm**`.
- Custom SMTP (P5). Optionally the ONCF-01 email templates so links work in another browser.
- `STAGING_SUPABASE_URL` = `https://<project-ref>.supabase.co` (the token `iss` without `/auth/v1`); `STAGING_SUPABASE_ANON_KEY` = the publishable (anon) key. **Never** the service-role or secret key: the web app never needs it and the preflight refuses it.

## 4. First deployment

Run everything on the VM from the repository root, as an operator. Each step is separately authorized.

1. **Check out the exact commit** that CI qualified (`ci`, `containers` and `staging-infra` green on it):

   ```sh
   git fetch origin && git checkout --detach <commit>
   ```

2. **Create the environment file** and fill it (passwords: `openssl rand -hex 32` each, all different):

   ```sh
   cp deploy/staging/.env.example deploy/staging/.env && chmod 600 deploy/staging/.env
   # STAGING_IMAGE_TAG=$(git rev-parse --short=12 HEAD)
   ```

3. **Preflight** (refuses placeholders, development or production markers, weak or reused passwords, a secret Supabase key, the marketing domain):

   ```sh
   deploy/staging/preflight.sh
   alias stg='docker compose -f deploy/staging/compose.yml --env-file deploy/staging/.env'
   stg config --quiet
   ```

   `stg config` without `--quiet` prints secrets: do not run it where output is recorded.

4. **Build** the images on the VM (`api`, `worker`, `web`; `ops` reuses the api image): `stg build`.
5. **Start the database only**: `stg up -d --wait postgres`.
6. **Bootstrap roles and hardening** (idempotent; re-running rotates passwords to the values in `.env`):

   ```sh
   stg run --rm ops node --import tsx packages/persistence/src/cli/bootstrap.ts
   ```

7. **Migrate** (explicit, never on start; forward-only):

   ```sh
   stg run --rm ops node --import tsx packages/persistence/src/cli/migrate.ts
   stg run --rm --no-deps worker node --import tsx apps/worker/src/main.ts --check   # expect "ready"
   ```

8. **Start the stack**: `stg up -d --wait`. Caddy obtains the certificate on first start (P2 and P3 must already be in place).
9. **Verify** (LAUNCH-02 §5):
   - `https://<STAGING_DOMAIN>/` answers 200 over a valid certificate and shows `API: ok`.
   - `stg exec -T api node -e "fetch('http://127.0.0.1:8080/ready').then(r=>r.text()).then(console.log)"` prints `{"status":"ready"}`.
   - `/v1/me` without a token answers 401 (same command with `/v1/me`).
   - From outside the VM, ports 5432, 8080 and 3000 are closed.
   - `stg ps` shows every service running, `api` and `web` healthy.
10. **Platform setup** (LAUNCH-02 §3.6–3.7):
    1. The operator signs up and signs in once through the web app, so the operator's platform account exists. Read its account id read-only (`SELECT id FROM identity.account`; it is the only account at this point) and set `BR_CATALOG_OPERATOR_ACCOUNT_ID` in `.env`.
    2. Catalog: `stg run --rm ops node --import tsx packages/persistence/src/cli/provision-catalog.ts --operator-account <uuid>`.
    3. Anchor, after its governance record: `stg run --rm ops node --import tsx packages/persistence/src/cli/result-authority.ts bootstrap-anchor --governance-ref <ref> --basis-ref <ref>`. Store the printed id as `BR_PLATFORM_PRINCIPAL_ID`.
11. **F1 and F3 preflights** (§7) before any result grant.
12. **Result grants** only through `authority:results grant`, one at a time, each under a new governance reference (LAUNCH-02 §6). Nothing in this stack issues grants automatically.

## 5. Routine operations

| Task | Command (`stg` alias from §4.3) |
|---|---|
| Status | `stg ps` |
| Logs | `stg logs --tail 200 -f <service>` (operators on the VM only; rotated, 5 × 10 MB per service). Caddy access logs redact Cookie and Authorization. Never paste `stg config` output or `.env` into tickets. |
| Stop / start | `stg stop` / `stg up -d --wait` (data stays in the `pgdata` volume) |
| Shut down | `stg down` (keeps volumes). **Never** `down -v` unless the environment is being destroyed: it deletes the database. |
| Deploy a new commit | Check it out, update `STAGING_IMAGE_TAG`, preflight, `stg build`, take a backup (§6), run migrations through `ops` if the commit ships new ones, then `stg up -d --wait`. Schedule outside live result entry. |
| Roll back the application | Set `STAGING_IMAGE_TAG` to the previous commit (its images are still on the VM) and `stg up -d --wait`. Migrations are forward-only; schema rollback means a restore (§6). |
| Rotate a database password | Change it in `.env`, re-run the bootstrap (§4.6), then `stg up -d --wait`. `BR_ADMIN_PASSWORD` is set only when the volume is first initialized; change it with `ALTER ROLE br_admin PASSWORD …` inside `psql` before editing `.env`. |
| Operator SQL (read-only) | `stg exec -T postgres psql -U br_admin -d onchainfest -X`, then `BEGIN READ ONLY;` before any query |

## 6. Backup and restore

Backups are logical dumps of the `onchainfest` database. Roles and passwords are not in the dump; the bootstrap recreates them.

```sh
mkdir -p deploy/staging/backups && chmod 700 deploy/staging/backups
stg exec -T postgres pg_dump -U br_admin -Fc onchainfest > deploy/staging/backups/onchainfest-$(date -u +%Y%m%dT%H%M%SZ).dump
```

- Take one before every deployment, before and after the pilot, and daily during it (cron on the VM).
- Copy dumps off the VM (object storage or the operator's encrypted storage). Dumps contain account and registration data: keep them access-controlled and delete them when the pilot ends.
- `deploy/staging/backups/` is git-ignored.

**Restore** (replaces the staging database; stop writers first):

```sh
stg stop caddy web worker api
stg exec -T postgres dropdb -U br_admin onchainfest
stg run --rm ops node --import tsx packages/persistence/src/cli/bootstrap.ts      # recreates and hardens it
stg exec -T postgres pg_restore -U br_admin -d onchainfest --exit-on-error < deploy/staging/backups/<file>.dump
stg up -d --wait
```

CI (`staging-infra`) proves the dump/bootstrap/restore mechanics on every run by restoring into a scratch database and comparing the applied migrations.

## 7. Security preflights F1 and F3 (PR #42 final security review)

Run both before the first result grant, and F1 again before each result session.

### F1 — no unbound result grant can shadow the bound ADR-0077 grant

```sh
stg exec -T postgres psql -U br_admin -d onchainfest -v ON_ERROR_STOP=1 -X < deploy/staging/sql/f1-foreign-result-grants.sql
```

- Read-only (`BEGIN READ ONLY … ROLLBACK`). The first result must be `(0 rows)`.
- On a fresh staging database the only result-grant issuer is `authority:results grant`. Keep it that way: **never** run the demo or seed commands (`demo:*`, `db:seed:*`) against staging (F5: the composition guard does not cover CLIs).
- A row means an unbound grant: either an interrupted issuance (LAUNCH-02 §6 step 7) or a foreign grant. Stop result entry and resolve it with `authority:results revoke` / a fresh `grant` under a new governance reference.

### F3 — lock and idle-transaction timeouts

```sh
stg exec -T postgres psql -U br_admin -d onchainfest -v ON_ERROR_STOP=1 -X < deploy/staging/sql/f3-timeouts.sql
```

The script only **reports** server defaults, per-role/per-database overrides and sessions currently idle in a transaction or waiting on a lock. On a fresh stack every timeout is `0` (disabled) and there are no overrides: nothing in the code, `roles.sql` or `database.sql` sets them.

**No value is chosen or applied by STG-01A.** Choosing values needs a compatibility review, because both settings change application behaviour. Items the review must settle, from the source at `95477fe`:

1. **`lock_timeout` also bounds advisory-lock waits.** Result commands, the eligibility gate and grant issuance serialize on `pg_advisory_xact_lock` keys. A timeout raises SQLSTATE `55P03` (`lock_not_available`). `packages/persistence/src/tx.ts` retries only `40001` and `40P01`, so `55P03` is not retried and would surface as an error response (expected 500) to an organizer or scorer under contention. The review must decide the value relative to the longest legitimate lock hold (the D-13B / Q3 concurrency jobs give the contention shape), and whether a fail-fast error is acceptable.
2. **`idle_in_transaction_session_timeout` terminates the session.** The pools (`createDb`, `packages/persistence/src/db.ts`) attach no `error` listener. The review must confirm how `pg`/Kysely behave when a checked-out client's session is terminated (error surfaced to the request, client discarded) and that no process exits on an unhandled `error` event.
3. **Scope.** Prefer per-login settings (`ALTER ROLE br_api SET …`) over server-wide ones. `authority:results` uses the `br_api` login, so a `br_api` setting also bounds a stalled issuance (the F3 scenario). Decide separately for `br_owner` (migrations take long locks legitimately) and the worker logins.
4. **Procedure.** Apply through a reviewed change (a bootstrap change in a PR, or a recorded manual `ALTER ROLE` on staging only), re-run `f3-timeouts.sql`, then exercise result entry and a grant under contention on staging before the pilot.

Until the review is done, F3 is mitigated operationally: issue grants one at a time, never leave an `authority:results` command or a `psql` transaction open, and check `f3-timeouts.sql` section 3 for stalled sessions if result entry hangs.

## 8. Isolation rules

- No production credential, database, Supabase project or domain is ever used here. The staging Supabase project, VM, DNS name and every password are new.
- `.env` lives only on the VM, mode `0600`, owned by the operator. It is git-ignored and excluded from the image build context (`.dockerignore`).
- The stack never migrates, bootstraps, provisions the catalog or grants result authority on start. Those run only through `ops`, by a person.
- No workflow deploys this stack, pushes its images or holds its secrets. `staging-infra` builds and runs it on a throwaway GitHub runner with random credentials and placeholder public values.
- The static marketing site (`vercel-deploy.yml`, Vercel project `onchainfest-web-site`) is unrelated and unchanged.

## 9. Resources

| Service | Memory limit | Notes |
|---|---|---|
| postgres | 1 GB | Default PostgreSQL settings; pilot data volume is tiny |
| api | 768 MB | TypeScript through `tsx` |
| web | 768 MB | `next start` |
| worker | 512 MB | |
| caddy | 128 MB | |

- Total limits are 3.2 GB, inside 4 GB. Idle usage measured by `staging-infra` is published in each run's summary.
- Building on the VM needs headroom outside these limits (dependency install and `next build`): build while the stack is stopped on a 4 GB VM if memory is tight, or add swap.
- Disk: images (built from the full workspace, development dependencies included), the database volume, rotated logs and local dumps. 40 GB is ample for the pilot.

## 10. Teardown after the pilot

1. Final backup (§6), kept only as long as the pilot evidence requires.
2. `stg down -v` (deletes the database and certificates), then delete the VM, the DNS record, the Supabase staging project and the SMTP credentials.
3. Revoke the deploy key and operator SSH access.
