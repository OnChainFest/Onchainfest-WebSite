#!/usr/bin/env bash
# ONCF-LOCAL-PILOT-01 · Creates the pilot's private state OUTSIDE the repository (never overwrites):
#
#   $PILOT_STATE_DIR (default ~/.local/state/oncf-local-pilot-01, mode 0700)
#     pilot.env      every credential of the pilot, freshly random (0600)
#     tls/ca.key     throwaway local CA (0600) — signs only the two pilot hostnames, valid 30 days
#     tls/ca.crt     its certificate (trusted by the api and web containers only)
#     tls/site.key   leaf key for oncf-pilot.localhost and auth.oncf-pilot.localhost
#     tls/site.crt
#
# Nothing is printed except file names. Requires openssl and node (both already on the workstation).
set -euo pipefail

STATE="${PILOT_STATE_DIR:-$HOME/.local/state/oncf-local-pilot-01}"
case "$STATE" in
  /mnt/*) echo "refusing $STATE: Windows drives ignore file modes; use a Linux path" >&2; exit 1 ;;
esac
if [ -e "$STATE/pilot.env" ]; then
  echo "pilot state already exists in $STATE (remove it deliberately to start over)" >&2
  exit 1
fi
umask 077
mkdir -p "$STATE/tls"
chmod 700 "$STATE" "$STATE/tls"

pw() { openssl rand -hex 32; }

# ── TLS: a CA that exists only for this pilot, and one leaf certificate for both hostnames ──
openssl ecparam -name prime256v1 -genkey -noout -out "$STATE/tls/ca.key" 2>/dev/null
openssl req -x509 -new -key "$STATE/tls/ca.key" -sha256 -days 30 -subj '/CN=ONCF local pilot 01 CA' \
  -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -addext 'nameConstraints=critical,permitted;DNS:oncf-pilot.localhost' \
  -out "$STATE/tls/ca.crt" 2>/dev/null
openssl ecparam -name prime256v1 -genkey -noout -out "$STATE/tls/site.key" 2>/dev/null
openssl req -new -key "$STATE/tls/site.key" -subj '/CN=oncf-pilot.localhost' -out "$STATE/tls/site.csr" 2>/dev/null
cat > "$STATE/tls/site.ext" <<'EXT'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=DNS:oncf-pilot.localhost,DNS:auth.oncf-pilot.localhost
EXT
openssl x509 -req -in "$STATE/tls/site.csr" -CA "$STATE/tls/ca.crt" -CAkey "$STATE/tls/ca.key" \
  -CAcreateserial -days 30 -sha256 -extfile "$STATE/tls/site.ext" -out "$STATE/tls/site.crt" 2>/dev/null
rm -f "$STATE/tls/site.csr" "$STATE/tls/site.ext" "$STATE/tls/ca.srl"
# Caddy runs without CAP_DAC_OVERRIDE, so the mounted leaf key must be readable inside the
# container; the 0700 state directory keeps it private on the host.
chmod 644 "$STATE/tls/site.key" "$STATE/tls/site.crt" "$STATE/tls/ca.crt"

# ── Auth signing material: ES256 private JWK (GoTrue signs with it, the JWKS shows the public
#    half), the legacy HS256 secret GoTrue still requires, and an anon (publishable) key ──
JWT_SECRET="$(pw)"
AUTH_JSON="$(JWT_SECRET="$JWT_SECRET" node --input-type=module -e '
import { generateKeyPairSync, randomUUID, createHmac } from "node:crypto";
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = { ...privateKey.export({ format: "jwk" }), kid: randomUUID(), alg: "ES256", use: "sig", key_ops: ["sign", "verify"] };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: "supabase", role: "anon", iat: now, exp: now + 30 * 86400 })}`;
const sig = createHmac("sha256", process.env.JWT_SECRET).update(body).digest("base64url");
process.stdout.write(JSON.stringify({ keys: JSON.stringify([jwk]), anon: `${body}.${sig}` }));
')"
JWT_KEYS="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).keys)' "$AUTH_JSON")"
ANON_KEY="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).anon)' "$AUTH_JSON")"

{
  echo "# ONCF-LOCAL-PILOT-01 · generated $(date -u +%FT%TZ). Disposable; never reuse elsewhere."
  echo "PILOT_STATE_DIR=$STATE"
  echo "STAGING_IMAGE_TAG=${PILOT_IMAGE_TAG:?set PILOT_IMAGE_TAG (git rev-parse --short=12 HEAD)}"
  echo "STAGING_DOMAIN=oncf-pilot.localhost:8443"
  echo "ACME_EMAIL=unused@oncf-pilot.test"
  echo "STAGING_SUPABASE_URL=https://auth.oncf-pilot.localhost:8443"
  echo "STAGING_SUPABASE_ANON_KEY=$ANON_KEY"
  for name in ADMIN OWNER API VAULT WORKER MAINTENANCE OPERATOR VERIFICATION_OPERATOR \
    ACHIEVEMENT_OPERATOR ACHIEVEMENT_WORKER RECORD_OPERATOR RECORD_WORKER RANKING_OPERATOR \
    RANKING_WORKER; do
    echo "BR_${name}_PASSWORD=$(pw)"
  done
  echo "BR_CATALOG_OPERATOR_ACCOUNT_ID="
  echo "BR_PLATFORM_PRINCIPAL_ID="
  echo "PILOT_AUTH_DB_SUPERUSER_PASSWORD=$(pw)"
  echo "PILOT_AUTH_ADMIN_PASSWORD=$(pw)"
  echo "PILOT_JWT_SECRET=$JWT_SECRET"
  echo "PILOT_JWT_KEYS='$JWT_KEYS'"
} > "$STATE/pilot.env"
chmod 600 "$STATE/pilot.env"
echo "pilot state written to $STATE (pilot.env, tls/ca.crt, tls/site.crt, tls/site.key, tls/ca.key)"
