#!/usr/bin/env bash
# STG-01A · Staging environment preflight. Run before every `docker compose build` / `up`:
#
#   deploy/staging/preflight.sh [path/to/.env]      (default: deploy/staging/.env)
#
# Fails closed (exit 1) unless the environment file:
#   - is mode 0600 and holds exactly the names of .env.example (no unknown or development names);
#   - has no placeholder left, and every required value set;
#   - has URL-safe passwords of at least 24 characters, all distinct;
#   - targets a staging hostname (never the marketing domain) and a Supabase project URL, with a
#     publishable key (never a service-role / secret key);
#   - names a commit as the image tag.
# Problems are reported by variable name only. Values are never printed.
# STG_PREFLIGHT_ALLOW_LOCALHOST=1 accepts STAGING_DOMAIN=localhost (CI smoke test only).
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
env_file=${1:-"$here/.env"}
template="$here/.env.example"
problems=()
problem() { problems+=("$1"); }

if [ ! -f "$env_file" ]; then
  echo "preflight: $env_file not found (copy .env.example and fill it in)" >&2
  exit 1
fi
mode=$(stat -c '%a' "$env_file")
[ "$mode" = 600 ] || problem "environment file mode is $mode, expected 600"

declare -A value=()
line_no=0
while IFS= read -r line || [ -n "$line" ]; do
  line_no=$((line_no + 1))
  case "$line" in '' | '#'*) continue ;; esac
  if [[ ! "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]]; then
    problem "line $line_no is not NAME=value"
    continue
  fi
  name=${BASH_REMATCH[1]}
  [ -z "${value[$name]+set}" ] || problem "$name is defined more than once"
  value[$name]=${BASH_REMATCH[2]}
done <"$env_file"

mapfile -t expected < <(sed -nE 's/^([A-Z][A-Z0-9_]*)=.*/\1/p' "$template")
optional=" BR_CATALOG_OPERATOR_ACCOUNT_ID BR_PLATFORM_PRINCIPAL_ID "
declare -A known=()
for name in "${expected[@]}"; do
  known[$name]=1
  if [ -z "${value[$name]+set}" ]; then
    problem "$name is missing"
  elif [ -z "${value[$name]}" ] && [[ "$optional" != *" $name "* ]]; then
    problem "$name is empty"
  fi
done
for name in "${!value[@]}"; do
  case "$name" in
    BR_DEV_* | *_DEV_KEY | *_DEV_DIR | *STRIPE* | *SERVICE_ROLE* | *SECRET_KEY*)
      problem "$name is forbidden in staging"
      ;;
    *) [ -n "${known[$name]+set}" ] || problem "$name is not in .env.example" ;;
  esac
done

v() { printf '%s' "${value[$1]-}"; }
for name in "${!value[@]}"; do
  case "$(v "$name")" in *__REPLACE__* | *'<'*'>'*) problem "$name still holds a placeholder" ;; esac
  case "$(v "$name")" in
    *[\"\'\ ]*) problem "$name must not contain quotes or spaces" ;;
  esac
done

# Passwords: URL-safe (they are embedded in connection URLs), long, never a development value,
# never shared between logins.
declare -A seen=()
for name in "${expected[@]}"; do
  case "$name" in *_PASSWORD) ;; *) continue ;; esac
  p=$(v "$name")
  [ -n "$p" ] || continue
  [[ "$p" =~ ^[A-Za-z0-9_-]{24,}$ ]] || problem "$name must be at least 24 URL-safe characters"
  [[ "$p" != *_dev_only ]] || problem "$name is a development password"
  if [ -n "${seen[$p]+set}" ]; then problem "$name reuses the password of ${seen[$p]}"; else seen[$p]=$name; fi
done

tag=$(v STAGING_IMAGE_TAG)
[ -z "$tag" ] || [[ "$tag" =~ ^[0-9a-f]{7,40}$ ]] || problem "STAGING_IMAGE_TAG must be a git commit (hex)"

domain=$(v STAGING_DOMAIN)
domain_lc=${domain,,}
if [ "$domain_lc" = localhost ] && [ "${STG_PREFLIGHT_ALLOW_LOCALHOST:-}" = 1 ]; then
  :
elif [ -n "$domain" ]; then
  [[ "$domain_lc" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]] ||
    problem "STAGING_DOMAIN must be a fully qualified hostname"
  case "$domain_lc" in
    onchainfest.xyz | www.onchainfest.xyz) problem "STAGING_DOMAIN must not be the marketing domain" ;;
  esac
fi

email=$(v ACME_EMAIL)
[ -z "$email" ] || [[ "$email" =~ ^[^@]+@[^@]+\.[^@]+$ ]] || problem "ACME_EMAIL must be an email address"

url=$(v STAGING_SUPABASE_URL)
[ -z "$url" ] || [[ "$url" =~ ^https://[a-z0-9-]+(\.[a-z0-9-]+)+$ ]] ||
  problem "STAGING_SUPABASE_URL must be an https origin without a path (https://<ref>.supabase.co)"

# The anon key must be publishable: a legacy JWT whose role is "anon", or an sb_publishable_ key.
key=$(v STAGING_SUPABASE_ANON_KEY)
if [ -n "$key" ]; then
  case "$key" in
    sb_publishable_*) ;;
    sb_secret_*) problem "STAGING_SUPABASE_ANON_KEY is a secret key, not the publishable key" ;;
    *.*.*)
      payload=$(printf '%s' "$key" | cut -d. -f2 | tr '_-' '/+')
      while [ $((${#payload} % 4)) -ne 0 ]; do payload="$payload="; done
      role=$(printf '%s' "$payload" | base64 -d 2>/dev/null | sed -nE 's/.*"role" *: *"([^"]*)".*/\1/p')
      [ "$role" = anon ] || problem "STAGING_SUPABASE_ANON_KEY is not an anon (publishable) key"
      ;;
    *) problem "STAGING_SUPABASE_ANON_KEY is not a recognised Supabase publishable key" ;;
  esac
fi

uuid='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
for name in BR_CATALOG_OPERATOR_ACCOUNT_ID BR_PLATFORM_PRINCIPAL_ID; do
  id=$(v "$name")
  [ -z "$id" ] || [[ "$id" =~ $uuid ]] || problem "$name must be a UUID"
done

if [ "${#problems[@]}" -gt 0 ]; then
  echo "preflight: REFUSED ($env_file)" >&2
  printf '  - %s\n' "${problems[@]}" >&2
  exit 1
fi
echo "preflight: ok ($env_file)"
