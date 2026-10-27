#!/usr/bin/env bash
# ONCF-LOCAL-PILOT-01 · The only way to drive the pilot stack. Every call re-checks the boundary
# before handing the arguments to `docker compose` with the staging file plus the pilot overlay:
#
#   deploy/local-pilot/pilot.sh check            # boundary checks only
#   deploy/local-pilot/pilot.sh up -d --wait postgres
#   deploy/local-pilot/pilot.sh run --rm ops node --import tsx packages/persistence/src/cli/migrate.ts
#
# `config` without --quiet would print credentials, so it is refused.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STATE="${PILOT_STATE_DIR:-$HOME/.local/state/oncf-local-pilot-01}"
ENV_FILE="$STATE/pilot.env"
fail() { echo "pilot: $*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || fail "no $ENV_FILE (run deploy/local-pilot/init-state.sh)"
[ "$(stat -c %a "$ENV_FILE")" = 600 ] || fail "$ENV_FILE must be mode 600"
[ "$(stat -c %a "$STATE")" = 700 ] || fail "$STATE must be mode 700"

# Credential hygiene: only names are ever reported.
if grep -qiE '^[A-Z_]*(SERVICE_ROLE|STRIPE|SECRET_KEY)[A-Z_]*=|^BR_DEV_' "$ENV_FILE"; then
  fail "pilot.env contains a forbidden variable name"
fi
if grep -qiE 'supabase\.co|onchainfest\.xyz|vercel' "$ENV_FILE"; then
  fail "pilot.env references a hosted or production resource"
fi
grep -q '^STAGING_SUPABASE_URL=https://auth\.oncf-pilot\.localhost:8443$' "$ENV_FILE" ||
  fail "STAGING_SUPABASE_URL must be the local pilot auth URL"
grep -q '^STAGING_DOMAIN=oncf-pilot\.localhost:8443$' "$ENV_FILE" ||
  fail "STAGING_DOMAIN must be the local pilot host"

# The pilot must log exactly like staging (STG-01B): the redaction snippet is a verbatim copy.
snippet() { sed -n '/^(redacted_log_format) {$/,/^}$/p' "$1"; }
[ -n "$(snippet "$ROOT/deploy/staging/Caddyfile")" ] || fail "staging redaction snippet not found"
diff <(snippet "$ROOT/deploy/staging/Caddyfile") <(snippet "$HERE/Caddyfile") >/dev/null ||
  fail "deploy/local-pilot/Caddyfile redaction snippet differs from deploy/staging/Caddyfile"

[ "${1:-}" = check ] && { echo "pilot: boundary checks passed"; exit 0; }
if [ "${1:-}" = config ] && ! [[ " $* " =~ \ (--quiet|-q|--services|--volumes|--images|--networks)\  ]]; then
  fail "'config' prints credentials; use 'config --quiet' (or --services/--volumes/--images/--networks)"
fi

exec docker compose -f "$ROOT/deploy/staging/compose.yml" -f "$HERE/compose.yml" \
  --env-file "$ENV_FILE" "$@"
