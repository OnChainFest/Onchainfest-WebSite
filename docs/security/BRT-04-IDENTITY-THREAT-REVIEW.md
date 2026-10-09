# BRT-04 — Identity, Passport & Organizations: Threat Review

Scope: the code added in BRT-04 (identity, organizations, passport, vault, `/v1` API, public web pages). Baseline: `BRT-02-THREAT-MODEL.md`, `BRT-02-DATA-ACCESS-MODEL.md`, BRT-03R role graph.

Status legend:

- **Mitigated:** a control exists and is tested.
- **Partial:** a control exists with a known gap.
- **Accepted:** a documented residual risk.

## 1. Authentication and impersonation

| # | Threat | Control | Test evidence | Status |
|---|---|---|---|---|
| A1 | Client-asserted identity (`X-User-Id`, `X-Account-Id`, body `accountId`) | Identity only from `AuthAdapter`. No header is read. DTOs refuse unknown fields. | `v1.int.test.ts` — every non-PUBLIC route × spoofing headers → 401 | Mitigated |
| A2 | Development auth reachable in production | `authFromEnvironment` returns `failClosedAuth` in production. `createDevTokenAuth` and `mintDevToken` throw there. | `v1.int.test.ts` "production fails closed"; `auth.test.ts` | Mitigated |
| A2b | Repository-known development secret silently used as HMAC or encryption key (BRT-04R) | **No built-in secrets.** The dev-auth secret must be injected or set in `BR_DEV_AUTH_SECRET` (≥ 32 chars, ≥ 10 distinct), and the API refuses to start with `BR_DEV_AUTH=1` and no valid secret. The PII dev key must be passed or set in `BR_VAULT_DEV_KEY` (≥ 32 chars), or an ephemeral key must be requested explicitly. CI generates random secrets per run. `.env.example` ships empty values. | `auth.test.ts`, identity unit tests (fail-closed cases, `dev-token` CLI) | Mitigated |
| A3 | Forged or tampered dev token (e.g. setting `op: true`) | HMAC-SHA256 over the payload, constant-time compare, expiry | forged / tampered / expired → 401 | Mitigated |
| A4 | Unauthenticated schema probing | Authentication runs in `onRequest`, before validation | 401 (not 400) for empty bodies on every protected route | Mitigated |
| A5 | Duplicate accounts through a sign-in race | Advisory lock on the provider pair plus UNIQUE `(provider, provider_subject)` | concurrent first sign-in → one account | Mitigated |
| A6 | No production IdP | None yet: production cannot authenticate at all | — | **Accepted** (fails closed; BRT-05+) |

## 2. Authorization

| # | Threat | Control | Status |
|---|---|---|---|
| Z1 | Editing another athlete, their slug, wallets or identities | `assertPersonOperation` inside the command transaction, from DB facts | Mitigated (tested via store and API) |
| Z2 | Self-asserted guardianship used to control an adult or a minor | Only **ACTIVE** relationships grant control. ACTIVE needs a `confirmation_basis` (CHECK), and only operators confirm in BRT-04. | Mitigated (tested) |
| Z3 | Guardian reads a dependent's PII or links wallets for a minor | The guardian operation set excludes both | Mitigated (tested) |
| Z4 | Org membership mistaken for sports authority | Disjoint vocabularies (compile-time guard and test). Org principals get no grants or anchors. `br_organizations` can INSERT only `authority.principal`. | Mitigated (tested) |
| Z5 | Privilege escalation to OWNER; locking out the last owner | `canAssignRole` (OWNER only by OWNER); last-active-owner invariant | Mitigated (tested) |
| Z6 | Self-confirmation of external identifiers | Confirmation needs `ORG_CONFIRM_EXTERNAL_ID` in the **issuer** org, and the CHECK requires the confirming org id | Mitigated (tested) |
| Z7 | Suspended or disabled actors keep acting | Permissions come from ACTIVE memberships of ACTIVE orgs by ACTIVE accounts | Mitigated |
| Z8 | TOCTOU between the SELF check and the vault access | **Fixed in BRT-04R.** Authorization runs inside the vault transaction: `identity_private.authorize_private_data`, SECURITY DEFINER, fixed `search_path`, EXECUTE only for `br_identity_private`, boolean-only. It holds shared advisory locks that revocations (`disableAccount`, guardian status changes) take exclusively, so vault operations and revocations are linearized. | Mitigated (tested: both race orders, disabled, guardian ACTIVE/revoked, unrelated, write after revocation) |

## 3. Privacy and PII

| # | Threat | Control | Status |
|---|---|---|---|
| P1 | API or public path reads PII | PII only in `identity_private`. Only `br_identity_private` can read it, via the `br_api_vault` login. `br_api` cannot assume it. | Mitigated (`identity-roles.int.test.ts`) |
| P2 | PII in events, audit, idempotency records, projections, errors, logs | Payloads use ids and field names only. Idempotency uses param digests. Errors carry fixed messages. Log redaction applies. | Mitigated (scans in tests and demo) |
| P3 | Database dump exposes PII | AES-256-GCM envelopes with field-bound AAD | **Partial:** the development key comes from an env var, not a KMS, with no rotation. Production refuses the dev cipher, so private-data endpoints return 503 until a KMS cipher exists. |
| P4 | Minor's profile exposed publicly | Dependents' passports are `restricted` (not served; no identities, wallets or affiliations) and created PRIVATE | Mitigated for **known** dependents |
| P5 | Minor registering alone (no guardian) | Not detectable: DOB is vault-only and the age policy is undecided | **Accepted** (documented in BRT-04-IDENTITY §5) |
| P6 | Enumerating private or restricted athletes | Hidden, restricted and unknown all return the same 404 body | Mitigated (tested) |
| P7 | Former slug leaks the new identity | A former slug redirects to the current one by design, which links old and new names | **Accepted** (users are informed that slugs redirect) |
| P8 | Erasure incomplete | Vault fields are nulled with `erased_at`. Public sporting history is intentionally kept. The auth identity is kept for accountability. | Partial (account deletion/pseudonymization flow is BRT-05+) |

## 4. Wallet proof of control

| # | Threat | Control | Status |
|---|---|---|---|
| W1 | Replay of a signature or challenge | Single-use challenge, consumed on the first attempt (success or failure). Lock plus consumption PK. | Mitigated (tested, including concurrency) |
| W2 | Cross-account or cross-address use of a challenge | Challenge bound to account, person, address, network, purpose, audience and nonce; all are in the signed text | Mitigated (tested) |
| W3 | Stale challenge | 10-minute expiry against DB transaction time | Mitigated (tested) |
| W4 | Test proof presented as real | The TEST verifier yields `TEST_VERIFIED` → `TEST_PROOF` label. It is unconstructible in production and not wired without dev auth. A production-only store rejects test signatures. | Mitigated (tested) |
| W5 | Key custody | No key material is accepted or stored. The key-material migration guard is still active. | Mitigated |
| W6 | Smart-contract wallets | No EIP-1271/6492 support: such wallets cannot link | Accepted (fails closed) |
| W8 | A verifier applied to a network or scheme it does not cover (BRT-04R) | Dispatch by the challenge's persisted (network family, proof scheme). Both BRT-04 schemes are `eip155:<chainId>`-only. Checks are layered: `normalizeWalletTarget`, the API DTO pattern, DB CHECKs on challenge and link, and the verifiers re-check scheme and family. Addresses are normalized to lower-case and signed. At most one verifier per scheme. | Mitigated (unit and API tests: non-EVM, malformed networks and addresses, cross-network, nonce and address replay, scheme crossing) |
| W9 | TEST_PROOF shown in production (BRT-04R) | Production refuses TEST verifiers at construction and at use. DB CHECK: `test-signature ⇔ TEST_VERIFIED`. The passport suppresses `TEST_VERIFIED` in production regardless of options and never maps it to `PROOF_OF_CONTROL`. | Mitigated (tested) |
| W7 | Address reuse across persons | Allowed: two persons may prove the same address, e.g. a shared wallet. The passport shows the proof, not uniqueness. | Accepted (documented) |

## 4b. Athlete ↔ Person and Organization ↔ Principal (BRT-04R)

| # | Threat | Control | Status |
|---|---|---|---|
| O1 | Person-less athlete with undefined owner or publication semantics | `identity.athlete.person_id` NOT NULL (strict BRT-04 invariant); imported/unclaimed athletes are deferred to an explicit model | Mitigated (DB + store tests) |
| O2 | Organization without principal mapping, a mapping to a non-ORGANIZATION principal, or orphan principals | Deferred constraint trigger (no unmapped org can commit), composite FK on (id, principal_type), PK and UNIQUE on the mapping, single-transaction creation | Mitigated (tested, incl. concurrent creation) |

## 5. Invitations

| # | Threat | Control | Status |
|---|---|---|---|
| I1 | Token theft from the database | Only the SHA-256 hash is stored (CHECK on its format); 256-bit tokens | Mitigated (tested: the raw token is absent from the table) |
| I2 | Token guessing or oracle | 256-bit entropy; one generic `INVITATION_INVALID` for unknown, used, expired and inactive-org tokens | Mitigated |
| I3 | Token used by the wrong person | Accept/decline requires SELF or confirmed GUARDIAN control over the invited person | Mitigated (tested) |
| I4 | Double acceptance | Single-use consumption PK plus lock | Mitigated (concurrency tested) |
| I5 | Token lost after the first response | Not recoverable by design (a replay returns `token: null`) | Accepted |
| I6 | Token in logs | Tokens exist only in the response body; logs never include bodies | Mitigated |

## 6. Database roles

| # | Threat | Control | Status |
|---|---|---|---|
| D1 | Role graph drift | Exact membership graph asserted (`security.int.test.ts`); all grants `INHERIT FALSE, SET TRUE, ADMIN FALSE` | Mitigated |
| D2 | Public read path over-privileged | `br_public_read` can SELECT passport tables and the public org profile only; no writes | Mitigated (tested) |
| D3 | Maintenance reading PII or auth identities | `br_rebuild` has no grant on `identity_private`, `auth_identity` or `account` | Mitigated (tested) |
| D4 | Tampering with identity and org history | Append-only and recorded_at triggers; the owner is also stopped | Mitigated (tested with real rows) |
| D5 | Application reading audit data | Runtime roles have INSERT only on `platform.audit_event` | Mitigated (tested) |
| D6 | Cross-context writes | Identity cannot write org facts and vice versa. Orgs write only `passport.affiliation` in the projection. | Mitigated (tested) |

## 7. Web

| # | Threat | Control | Status |
|---|---|---|---|
| X1 | XSS through profile text | React escapes all text. Control characters are refused at write. No `dangerouslySetInnerHTML`. | Mitigated |
| X2 | Malicious organization website link | Only `https://` URLs are accepted (API and DB CHECK); `rel="nofollow noopener noreferrer ugc"` | Mitigated |
| X3 | Over-claiming trust in the UI | Provenance badges on every fact; NOT_AVAILABLE sections explained; disclaimers on both pages | Mitigated (review) |

## 8. Residual items for later phases

1. A real IdP (OIDC or passkeys) with session management and MFA assurance.
2. A KMS-backed `PiiCipher` with key ids and rotation, and re-encryption jobs.
3. DOB-based minority and consent records, with a jurisdiction policy.
4. Account deletion and pseudonymization.
5. EIP-1271/6492 wallet proofs.
6. Rate limiting and abuse controls on sign-in, invitations and challenges.
7. A duplicate-resolution review workflow and UI.
