# ONCF-LOCAL-PILOT · Isolated local tournament pilot

A disposable, loopback-only copy of the STG-01A staging stack on one workstation, with a local
Supabase Auth, for playing a complete tournament through the real web application at no cost.
ONCF-LOCAL-PILOT-01 (2026-10-27) used it to play a four-player singles tennis tournament from
organizer onboarding to a public champion.

It is **not** staging and never deploys anything. Staging is `deploy/staging/` and
[STG-01A-STAGING-RUNBOOK.md](STG-01A-STAGING-RUNBOOK.md).

## 1. What it is

`deploy/local-pilot/compose.yml` is an **overlay** applied after `deploy/staging/compose.yml`. It
reuses the staging images, networks and hardening, and changes only what a workstation needs:

| Area | Staging | Local pilot |
| --- | --- | --- |
| Compose project | `onchainfest-staging` | `oncf-local-pilot-01` (own containers, networks, volumes) |
| Edge | Caddy on 0.0.0.0:80/443, ACME | Caddy on **127.0.0.1:8443** only, throwaway local CA |
| Auth | hosted Supabase project | local GoTrue (the Supabase CLI image) + its own Postgres + Mailpit, behind the same Caddy at `https://auth.oncf-pilot.localhost:8443/auth/v1` |
| API auth | `NODE_ENV=production`, JWKS ES256/RS256 | unchanged: same verifier, same production mode |
| Signature audience | `bragging-rights:staging` | `bragging-rights:local-pilot` |
| Web sign-ups per IP per hour | 5 (default) | 10 (`AUTH_SIGNUP_LIMIT_PER_IP`, D-P5) |
| API egress | internet (JWKS) | none (`api-egress` is internal; only the auth proxy) |
| Email | custom SMTP | Mailpit, `http://127.0.0.1:58025`; nothing is ever delivered |
| Logs | STG-01B redaction | the same snippet, verbatim (`pilot.sh` refuses to run if it drifts) |

GoTrue's admin API is not routed (403): accounts exist only through sign-up plus the confirmation
email. Nothing in the overlay seeds users, grants or results.

**Requirement:** D-P1 (`publicOrigin` for auth-link and sign-out redirects behind a proxy) must be in
the checked-out code; without it email confirmation and sign-out fail behind Caddy.

## 2. Prerequisites

Docker with Compose ≥ 2.24 (for `!override`), `openssl`, `node` ≥ 22, about 4 GB of disk for images
and 4 GB of RAM headroom. Ports 127.0.0.1:8443 and 127.0.0.1:58025 must be free. A Chromium-based
browser resolves `*.localhost` to the loopback address by itself; accept the pilot certificate
warning (or import `tls/ca.crt` into a throwaway browser profile).

## 3. First start

All private state lives outside the repository, by default in `~/.local/state/oncf-local-pilot-01`
(`PILOT_STATE_DIR` overrides it; it must be a Linux path, not `/mnt/c`, so file modes hold).

```sh
export PILOT_IMAGE_TAG=$(git rev-parse --short=12 HEAD)
deploy/local-pilot/init-state.sh           # random credentials, local CA, ES256 auth key; never overwrites
deploy/local-pilot/pilot.sh check          # boundary checks
deploy/local-pilot/pilot.sh build api worker web
deploy/local-pilot/pilot.sh up -d --wait --no-build postgres auth-db mailpit auth
deploy/local-pilot/pilot.sh run --rm ops node --import tsx packages/persistence/src/cli/bootstrap.ts
deploy/local-pilot/pilot.sh run --rm ops node --import tsx packages/persistence/src/cli/migrate.ts
deploy/local-pilot/pilot.sh run --rm --no-deps worker node --import tsx apps/worker/src/main.ts --check
deploy/local-pilot/pilot.sh up -d --wait --no-build
```

Open `https://oncf-pilot.localhost:8443`. Confirmation emails appear in Mailpit.

Platform setup follows STG-01A §4 step 10 and §7 with `pilot.sh` in place of `stg`: the operator signs
up and signs in once; read its account id read-only; `provision-catalog.ts --operator-account <id>`;
`result-authority.ts bootstrap-anchor` under a recorded governance reference; F1/F3 with
`deploy/staging/sql/*.sql`; result grants only through `result-authority.ts grant`, one governance
reference each. Put `BR_CATALOG_OPERATOR_ACCOUNT_ID` and `BR_PLATFORM_PRINCIPAL_ID` in `pilot.env`.

`pilot.sh config` without `--quiet`/`--services`/`--volumes`/`--images`/`--networks` is refused
because it would print credentials.

## 4. Verify isolation

- `pilot.sh ps`: only `caddy` (127.0.0.1:8443) and `mailpit` (127.0.0.1:58025) publish ports.
- From the API container, `fetch('https://example.com')` fails (no egress) and the auth JWKS answers
  200 with one public EC key.
- `/v1/me` without a token answers 401; `https://auth.oncf-pilot.localhost:8443/auth/v1/admin/users`
  answers 403.
- `docker compose ls` shows other projects unchanged; no command here prunes or touches them.

## 5. Preserve the data

The pilot's data lives in the `oncf-local-pilot-01_pgdata` and `oncf-local-pilot-01_auth-pgdata`
volumes. Nothing in this runbook removes them.

- **Pause / resume:** `pilot.sh stop` / `pilot.sh up -d --wait --no-build`. Never `down --volumes`
  unless the teardown below is decided.
- **Backup while running** (read-only, into the private state directory):

  ```sh
  S=${PILOT_STATE_DIR:-$HOME/.local/state/oncf-local-pilot-01}; mkdir -p -m 700 "$S/backups"
  TS=$(date -u +%Y%m%dT%H%M%SZ)
  deploy/local-pilot/pilot.sh exec -T postgres pg_dump -U br_admin -Fc onchainfest > "$S/backups/onchainfest-$TS.dump"
  deploy/local-pilot/pilot.sh exec -T auth-db pg_dump -U postgres -Fc -n auth postgres > "$S/backups/auth-$TS.dump"
  chmod 600 "$S"/backups/*.dump
  ```

- **Evidence** (screenshots, read-only SQL, logs) also belongs in the state directory, never in the
  repository; `deploy/local-pilot/.gitignore` blocks `*.env`, `tls/` and `evidence/` as a backstop.
- All pilot users sign up from one loopback address. The overlay sizes the web sign-up limiter for
  that (D-P5: `AUTH_SIGNUP_LIMIT_PER_IP=10` per hour instead of the default 5; the app accepts 1–30
  and keeps 5 for anything else). The limiter is in memory per web instance, so restarting `web`
  also resets it; that is no longer needed for a seven-account tournament.

## 6. Teardown (only when decided)

Affects only this project:

```sh
deploy/local-pilot/pilot.sh down --volumes
docker image rm oncf-local-pilot-01-{api,worker,web}:$PILOT_IMAGE_TAG
rm -rf ~/.local/state/oncf-local-pilot-01      # after archiving evidence and backups
```
