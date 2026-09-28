# BRT-03 — Development Guide

All commands run from the repository root.

## 1. Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 22 LTS (`.nvmrc`); 24 also supported | `engines: >=22.13 <25` |
| pnpm | 10.34.5 (pinned via `packageManager`) | `corepack enable` provides it |
| Docker | with Compose v2 | PostgreSQL 18.3 only |
| Python | 3.10+ | Golden-vector reference checker |

### Windows + WSL

When running the repository commands from WSL:

1. **Docker Desktop must be running.**
2. **Enable WSL integration** for your distro: Docker Desktop → Settings → Resources → WSL Integration.
3. **Check both sides.** Before `pnpm db:up`, `docker version` inside WSL must show both **Client** and **Server**.
4. **If `/var/run/docker.sock` is missing in WSL** while Docker works from Windows:
   - enable WSL Integration for the distro;
   - restart WSL by running `wsl --shutdown` from PowerShell;
   - reopen the WSL terminal.

## 2. First-time setup

```bash
git clone <repo> bragging-rights && cd bragging-rights
corepack enable
pnpm install                 # exact versions from pnpm-lock.yaml
pnpm db:up                   # docker compose: postgres on localhost:55432 (creates bragging_rights + bragging_rights_test)
pnpm db:bootstrap            # logins br_owner/br_api/br_worker_app/br_maintenance/br_probe + module roles; revokes PUBLIC access; sets dev passwords
pnpm db:migrate              # applies db/migrations/*.sql to bragging_rights as br_owner
```

**Credentials** are development-only defaults that match `docker-compose.yml`. They can be overridden with the variables in `.env.example`. With `NODE_ENV=production`, explicit URLs are required and development passwords are refused.

## 3. Everyday commands

| Purpose | Command |
|---|---|
| Unit, property and golden-vector tests | `pnpm test` |
| Integration tests (resets and migrates `bragging_rights_test` automatically) | `pnpm test:integration` |
| All tests | `pnpm test:all` |
| Golden vectors: reproduce + independent Python checker | `pnpm vectors:check` |
| Regenerate vectors after an **intentional** protocol change | `pnpm vectors:generate` (then review the diff) |
| Lint (ESLint + key-material guard) | `pnpm lint` |
| Format check / write | `pnpm format:check` / `pnpm format` |
| Typecheck every workspace | `pnpm typecheck` |
| Acceptance walkthrough (steps 7–17) | `pnpm demo:foundation` |
| Development seed (PLATFORM principal + PLATFORM anchor) | `pnpm db:seed` |

## 4. Running the apps

```bash
pnpm dev:api                 # http://127.0.0.1:4000/health and /ready
pnpm dev:worker              # polls the outbox (consumer dev.event-log) and the job queue
pnpm dev:web                 # http://localhost:3000 — "Bragging Rights · Foundation build active"
pnpm --filter @br/worker exec tsx src/main.ts --once   # a single worker round
```

`/ready` returns `503` until the database is reachable and every migration is applied.

## 5. Resetting

```bash
pnpm db:reset                          # dev DB: drop canonical schemas, re-bootstrap, re-migrate
pnpm db:reset bragging_rights_test     # test DB (integration tests also do this automatically)
pnpm db:down                           # stop the container (data volume kept)
docker compose down -v                 # stop and delete all local data
```

Ledger tables are append-only even for the owner role. That is why resets drop the schemas (as the administrator) instead of deleting rows.

## 6. Adding a migration

1. Create `db/migrations/NNNN_description.sql` with the next number. Applied files are immutable: the runner stores a checksum and refuses modified files.
2. Classify every new table as class A (ledger), class B (projection), class C (cache) or operational (BRT-02 persistence §3.0).
3. Class A tables need three things:
   - `platform.reject_mutation()` UPDATE/DELETE and TRUNCATE triggers;
   - `platform.assert_recorded_at()` on insert;
   - `SELECT, INSERT` grants only.
4. Grant privileges to the owning module role only. Never grant to `PUBLIC`.
5. Never add columns for private key material. `pnpm lint` runs `tooling/check-no-key-material.mjs`.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `permission denied for table …` from application code | The transaction did not assume the right module role; use `inTransaction(db, ModuleRole.x, …)` |
| `permission denied to set role …` | The connection's login may not assume that module role (api → authority/results, worker → worker, maintenance → rebuild). Use the matching `databaseUrls()` entry. |
| `CONFLICT_CHECK_UNAVAILABLE` | Conflict-sensitive actions fail closed without participation data; pass an explicit `conflictChecker` (tests: `declaredNoParticipation`) |
| `BR002 recorded_at must equal the transaction time` | Use `ctx.txTime` for `recorded_at` and in hashes |
| `/ready` → `pending_migrations` | Run `pnpm db:migrate` (it also grants readiness access to `br_api` and `br_worker_app`) |
| `pnpm db:up` fails with `/var/run/docker.sock: no such file or directory` (WSL) | Docker Desktop's WSL Integration is not enabled for this distro. Enable it and run `wsl --shutdown` from PowerShell (see §1 Windows + WSL). |
| Port 55432 in use | Change the host port in `docker-compose.yml` and set the `BR_*_DATABASE_URL` variables |
| Line-ending warnings on Windows | `.gitattributes` normalizes to LF; run `git add --renormalize .` once if needed |
