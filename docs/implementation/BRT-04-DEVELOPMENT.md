# BRT-04 — Development Guide

Extends [BRT-03-DEVELOPMENT.md](./BRT-03-DEVELOPMENT.md): prerequisites, Windows + WSL notes and everyday commands still apply. All commands run from the repository root.

## 1. What changed for developers

| Area | BRT-04 addition |
|---|---|
| Packages | `@br/identity` (pure domain: slugs, policies, permissions, passport DTO, wallet proof, PII cipher port) |
| Persistence | `IdentityStore`, `OrganizationStore`, `PersonPrivateDataService`, `PassportReader`, `OrganizationReader`, `rebuildPassports` |
| Migrations | `0004_identity.sql`, `0005_organizations.sql`, `0006_passport.sql` (BRT-03 migrations untouched) |
| DB roles | module roles `br_identity`, `br_identity_private`, `br_organizations`, `br_public_read`; login `br_api_vault` |
| API | `/v1` endpoints (classification table below); `/health` and `/ready` unchanged in behaviour |
| Web | `/athletes/[slug]`, `/organizations/[slug]` |

## 2. Setup

```bash
pnpm install
pnpm db:up                   # or on WSL without the Docker socket: docker.exe compose up -d --wait postgres
pnpm db:bootstrap            # now also creates br_api_vault and the BRT-04 module roles
pnpm db:migrate              # applies 0001–0006
# There are no built-in development secrets. Generate your own, once per machine, and keep them
# outside the repository (e.g. in your shell profile or an untracked .env loaded by your shell):
export BR_VAULT_DEV_KEY=$(openssl rand -hex 32)      # PII vault key (dev cipher; NOT a KMS)
export BR_DEV_AUTH_SECRET=$(openssl rand -hex 32)    # HMAC secret for development bearer tokens
pnpm db:seed:identity        # optional: fictional athletes/orgs (idempotent; needs BR_VAULT_DEV_KEY)
```

Keep `BR_VAULT_DEV_KEY` stable. Vault rows written with one key cannot be read with another, and reads fail closed with `PRIVATE_DATA_UNAVAILABLE`.

`pnpm db:reset` also drops the BRT-04 schemas (`passport`, `organizations`, `identity_private`, `identity`).

### Environment (`.env.example`)

| Variable | Purpose | Production |
|---|---|---|
| `BR_VAULT_DATABASE_URL` | PII vault login (`br_api_vault`) | required |
| `BR_VAULT_DEV_KEY` | development PII cipher key material (**required** for vault endpoints and the seed; ≥ 32 chars; no default) | **refused**: dev cipher throws; vault endpoints answer 503 |
| `BR_DEV_AUTH=1` | enables development bearer tokens | **ignored**: auth fails closed |
| `BR_DEV_AUTH_SECRET` | HMAC secret for dev tokens (**required** when `BR_DEV_AUTH=1`; ≥ 32 chars; no default — the API refuses to start without it) | refused |
| `BR_API_URL` | web → API base URL | set per deployment |

## 3. Running the API and web with development auth

```bash
# BR_VAULT_DEV_KEY and BR_DEV_AUTH_SECRET exported as in §2
BR_DEV_AUTH=1 pnpm dev:api                    # http://127.0.0.1:4000
pnpm dev:web                                  # http://localhost:3000
TOKEN=$(BR_DEV_AUTH=1 pnpm -s --filter @br/api dev-token seed:ana)   # same secret as the API
curl -s localhost:4000/v1/me -H "authorization: Bearer $TOKEN"
curl -s localhost:4000/v1/athletes/ana-ficticia | jq .passport.athlete
open http://localhost:3000/athletes/ana-ficticia
open http://localhost:3000/organizations/club-ficticio-padel
```

Operator tokens (INTERNAL endpoints) come from `dev-token <subject> --operator`. With `BR_DEV_AUTH=1`, the API also registers the **test wallet verifier**:

- a challenge requested with `"proofScheme": "test-signature"` accepts `test-signature:<nonce>`;
- it produces `TEST_VERIFIED` links, labelled as test proofs, and these are suppressed in production;
- default challenges (`eip191-personal-sign`) require a real EIP-191 signature and produce `VERIFIED`.

Wallet challenges accept only `eip155:<chainId>` networks and 20-byte hex addresses.

## 4. `/v1` endpoints

| Method & path | Class | Notes |
|---|---|---|
| `GET /v1/athletes/:slug` | PUBLIC | passport + `canonicalSlug` + `redirected` |
| `GET /v1/organizations/:slug` | PUBLIC | profile, `authority: NOT_AVAILABLE`, public athletes |
| `GET /v1/me` | AUTHENTICATED | account, SELF person, guardian relationships, athletes |
| `POST /v1/persons` | AUTHENTICATED | `relation: SELF \| DEPENDENT` (dependent ⇒ PENDING guardian) · Idempotency-Key |
| `POST /v1/athletes` | GUARDIAN | SELF or confirmed guardian · Idempotency-Key |
| `PATCH /v1/athletes/:athleteId/profile` | GUARDIAN | |
| `PUT /v1/athletes/:athleteId/slug` | GUARDIAN | |
| `POST /v1/athletes/:athleteId/external-identities` | GUARDIAN | always CLAIMED · Idempotency-Key |
| `DELETE /v1/external-identities/:id` | GUARDIAN | owner, guardian or issuer |
| `POST /v1/guardian-relationships` | AUTHENTICATED | asserts PENDING · Idempotency-Key |
| `DELETE /v1/guardian-relationships/:id` | GUARDIAN | the guardian revokes |
| `GET/PUT/DELETE /v1/persons/:personId/private` | SELF | vault; `cache-control: no-store`; 503 without a cipher |
| `POST /v1/persons/:personId/wallet-challenges` | SELF | Idempotency-Key |
| `POST /v1/wallet-links` | SELF | verify signature · Idempotency-Key |
| `DELETE /v1/wallet-links/:id` | SELF | |
| `POST /v1/invitations/accept`, `/decline` | SELF | invitee or confirmed guardian |
| `POST /v1/organizations` | AUTHENTICATED | requires a SELF person · Idempotency-Key |
| `GET /v1/organizations/:organizationId/permissions` | AUTHENTICATED | caller's roles and permissions |
| `GET /v1/organizations/:organizationId/members` | ORG_MEMBER | ids and roles only |
| `PATCH /v1/organizations/:organizationId/profile` | ORG_ADMIN | ORG_EDIT_PROFILE |
| `POST /v1/organizations/:organizationId/invitations` | ORG_ADMIN | token returned once · Idempotency-Key |
| `PUT /v1/memberships/:id/status` | ORG_ADMIN | members may end their own |
| `POST /v1/memberships/:id/role` | ORG_ADMIN | Idempotency-Key |
| `POST /v1/external-identities/:id/confirm` | ORG_ADMIN | issuer org only |
| `POST /v1/internal/guardian-relationships/:id/confirm` | INTERNAL | operator flag |
| `POST /v1/internal/accounts/:id/disable` | INTERNAL | |
| `POST /v1/internal/organizations/:id/status` | INTERNAL | |
| `POST /v1/internal/athletes/:id/resolution` | INTERNAL | duplicate resolution |

How the classes are enforced:

- **At the edge:** authentication runs in `onRequest`, *before* DTO validation, so unauthenticated callers only ever see 401. INTERNAL additionally needs the operator flag.
- **In the stores:** SELF, GUARDIAN, ORG_MEMBER and ORG_ADMIN are decided inside the command transaction, from database facts.
- **DTOs** are JSON schemas with `additionalProperties: false`. Fastify's Ajv is configured with `removeAdditional: false` and `coerceTypes: false`, so unknown fields are refused, not stripped.
- **Errors:** `{ error: { code, message } }` with a fixed status map. Unknown errors become `500 INTERNAL` with no SQL detail.
- **Logs** redact the `authorization`, `cookie` and `idempotency-key` headers and never include bodies.

## 5. Tests

| Suite | File(s) | Covers |
|---|---|---|
| unit | `packages/identity/src/identity.test.ts` | slug normalization (property-based), reserved words, permission ≠ capability, role assignment, guardian policy, passport provenance / NOT_AVAILABLE / determinism / visibility, EIP-191 vector (web3.js), challenge binding, test verifier, PII cipher (no built-in key, ephemeral), network/scheme boundary, TEST_PROOF policy |
| unit | `apps/api/src/auth.test.ts` | dev auth: no built-in secret, weak secrets refused, BR_DEV_AUTH gating, production refusal, `dev-token` CLI failures |
| integration | `packages/persistence/src/identity.int.test.ts` | accounts, athletes, slugs + races, guardians/minors, orgs, invitations (+ concurrency, expiry), external ids, wallets (+ replay, expiry, concurrency, re-verification), vault, PII scans, rebuild equivalence |
| integration | `packages/persistence/src/identity-roles.int.test.ts` | vault isolation, public-read limits, context boundaries, append-only (owner too), audit write-only, maintenance/probe/PUBLIC |
| integration | `packages/persistence/src/security.int.test.ts` | the complete login → role graph (updated for BRT-04) |
| integration | `apps/api/src/v1.int.test.ts` | classification, 401 everywhere without auth, X-User-Id ignored, forged/expired tokens, INTERNAL, production fail-closed, DTO strictness, SELF/GUARDIAN/ORG flows, wallet labels, wallet network boundary, error hygiene |
| integration | `apps/api/src/privacy.int.test.ts` | sentinel regression: distinctive private values never appear in public DTOs, outbox, audit, idempotency, projections or captured logs |
| integration | `identity.int.test.ts` → "BRT-04R" blocks | vault authorization inside the vault transaction (incl. both race orders), athlete↔person invariant, organization↔principal consistency, TEST_PROOF production safety |

## 6. Acceptance walkthrough

```bash
pnpm demo:foundation      # BRT-03 (unchanged)
pnpm demo:identity        # BRT-04: 20 steps through the real /v1 surface (in-process), fictional data
```

The demo generates a random dev-auth secret per run. It uses `BR_VAULT_DEV_KEY` if set; otherwise it explicitly requests an **ephemeral** vault key, so its private rows are unreadable after the run.

`demo:identity` exits non-zero unless all 20 steps run. Step 20 rebuilds the passport projection with the maintenance login, checks it is identical to the incremental one, and scans the outbox for the demo's PII (expected: 0).
