# BRT-06 — Development Guide

Extends [BRT-05-DEVELOPMENT.md](./BRT-05-DEVELOPMENT.md), [BRT-04-DEVELOPMENT.md](./BRT-04-DEVELOPMENT.md) and [BRT-03-DEVELOPMENT.md](./BRT-03-DEVELOPMENT.md): prerequisites, Windows + WSL notes (including the `docker.exe compose` workaround when `/var/run/docker.sock` is missing), explicit development secrets and everyday commands still apply. All commands run from the repository root.

## 1. What changed for developers

| Area | BRT-06 addition |
|---|---|
| Packages | `@br/evidence` (pure + node:crypto/fs): descriptors, media safety, signed statements, JWS_DETACHED verifier, key admissibility, access policy, Evidence Bundle builder, EvidenceCipher, blob-store ports + encrypted filesystem dev store; `@br/domain` evidence vocabulary |
| Persistence | `EvidenceStore`, `AttestationStore`, `PrincipalKeyCeremony`, `PersonPrincipalService`, `EvidenceBundleService`, `AttestationPublicReader`, `rebuildEvidenceReadModels`; `insertPrincipalKey` / `insertKeyStatusChange` extracted from `AuthorityStore` (behaviour unchanged) |
| Migrations | `0010_evidence.sql`, `0011_attestations.sql`, `0012_evidence_read_models.sql` (0001–0009 untouched) |
| DB roles | Module role `br_evidence` (assumable only by `br_api`); narrow SECURITY DEFINER helpers `results.resolve_result_version`, `competition.account_competition_roles`, `authority.account_principal_representation`, `identity.ensure_person_principal`; `br_public_read` reads `evidence_read.attestation_card` only |
| API | Evidence / attestation / key / bundle routes (see [protocol](./BRT-06-ATTESTATION-PROTOCOL.md) §9); new class `ISSUER_REPRESENTATIVE`; new error codes; `/health` reports `phase: BRT-06` |
| Web | `/attestations/[id]` — signed-claim trust explorer |
| Vectors | `packages/evidence/test-vectors/brt-06.vectors.json` + Python checker; the 58 BR-JSON v1 vectors are unchanged |
| Guards | `tooling/check-no-key-material.mjs` now also scans the repository for PEM/JWK private keys, seed phrases, committed dev secrets and literal cipher keys in production code |

## 2. Environment

```bash
# No built-in keys: generate your own per machine; never commit them.
export BR_VAULT_DEV_KEY=$(openssl rand -hex 32)
export BR_DEV_AUTH_SECRET=$(openssl rand -hex 32)
# BRT-06 persistent development evidence store (both required; the key must differ from the vault key)
export BR_EVIDENCE_DEV_DIR="$HOME/.bragging-rights/evidence-dev"     # absolute path
export BR_EVIDENCE_DEV_KEY=$(openssl rand -hex 32)
# Optional: signature audience (environment binding); default bragging-rights:development
export BR_SIGNATURE_AUDIENCE=bragging-rights:development
```

Without `BR_EVIDENCE_DEV_DIR` + `BR_EVIDENCE_DEV_KEY` the API runs with the fail-closed store: evidence upload/content answer 503 `EVIDENCE_STORAGE_UNAVAILABLE`; everything else works. Changing `BR_EVIDENCE_DEV_KEY` makes existing blobs unreadable (fail closed); remove the directory with the database when you reset.

## 3. Setup

```bash
pnpm install
pnpm db:up                  # or: docker.exe compose up -d --wait postgres
pnpm db:bootstrap           # also creates br_evidence
pnpm db:migrate             # applies 0001–0012
pnpm db:seed:competition    # prerequisite of the evidence seed
pnpm db:seed:evidence       # fictional score sheet + signed confirmation (idempotent; run twice → same output)
```

`pnpm db:reset` also drops `evidence_read`, `attestation` and `evidence`; delete `$BR_EVIDENCE_DEV_DIR` too.

## 4. Commands

| Purpose | Command |
|---|---|
| BRT-06 acceptance walkthrough (40 steps; fictional; random dev-auth secret, temp encrypted store, in-memory keys) | `pnpm demo:evidence` |
| Evidence seed (idempotent) | `pnpm db:seed:evidence` |
| Regenerate BRT-06 vectors | `pnpm vectors:generate:brt06` |
| All vectors + both independent checkers | `pnpm vectors:check` |
| Unit / integration | `pnpm test` / `pnpm test:integration` |

## 5. Signing by hand (curl)

```bash
BR_DEV_AUTH=1 pnpm dev:api
ORG=$(BR_DEV_AUTH=1 pnpm -s --filter @br/api dev-token seed:comp-organizer)
# 1. prepare key registration → sign .signing.signingInput with YOUR private key (Ed25519, base64url) → submit
curl -s -X POST localhost:4000/v1/principals/<orgPrincipalId>/keys/prepare -H "authorization: Bearer $ORG" \
  -H 'idempotency-key: key-prep-1' -H 'content-type: application/json' \
  -d '{"algorithm":"EdDSA","publicJwk":{"kty":"OKP","crv":"Ed25519","x":"<43 chars>"}}'
# 2. prepare an attestation, sign .signing.signingInput, submit {challengeId, proof:{proofType,scheme,protected,signature}}
# 3. public card
curl -s localhost:4000/v1/attestations/<attestationId> | jq .
pnpm dev:web   # http://localhost:3000/attestations/<attestationId>
```

The platform never sees or stores the private key. `createEphemeralSigner` (tests/demo/seed only, refuses production) plays the external signer in-process.

## 6. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `503 EVIDENCE_STORAGE_UNAVAILABLE` | No dev store configured (by design in production). Set both `BR_EVIDENCE_DEV_*` variables. |
| `409 EVIDENCE_NOT_AVAILABLE` | Item is RESTRICTED/DELETED, or the blob cannot be decrypted (key changed / file missing) — fail closed. |
| `422 KEY_NOT_VALID` + `reason` | `KEY_UNKNOWN`, `KEY_NOT_OWNED`, `KEY_REVOKED`, `KEY_COMPROMISED`, `KEY_NOT_VALID_AT_TIME`, `KEY_ALGORITHM_UNSUPPORTED`. |
| `422 ATTESTATION_PROOF_INVALID` | Signature over the wrong input, wrong key/kid, tampered echo, or a different audience. The challenge is consumed; prepare again. |
| `409 ATTESTATION_CHALLENGE_USED` | Replay; prepare a new challenge. |
| Demo fails once with `AUTHORITY_DENIED: PRINCIPAL_UNKNOWN` right after an idle period (WSL/Docker Desktop) | Environment concern: the Docker VM clock stepped backwards between two transactions and the (unchanged) BRT-03 model evaluates authority at DB `now()`. BRT-06 never rewrites timestamps to hide this. Re-run; in deployments keep the database host clock NTP-disciplined and monotonic. |
