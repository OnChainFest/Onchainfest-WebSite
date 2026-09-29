# BRT-04 — Identity

Status: **implemented (development foundation)** · Phase: BRT-04 · Builds on: BRT-02 `BRT-02-IDENTITY-AND-AUTHORITY.md`, ADR-0009, ADR-0016, ADR-0020 · New ADRs: [0021](../adr/ADR-0021-account-person-control-and-person-keyed-membership.md), [0023](../adr/ADR-0023-pii-vault-login-isolation.md)

This document describes what BRT-04 actually implements for accounts, persons, athletes, guardians, external identities and wallets. It also covers where it interprets BRT-02, and what is intentionally left out.

## 1. The four distinctions

| Concept | Implemented as | Is **not** |
|---|---|---|
| **Account** | `identity.account` + `account_status_change` (ACTIVE/DISABLED) | A person. An account can exist without any person (a fresh sign-in). |
| **AuthIdentity** | `identity.auth_identity` — `(provider, provider_subject)` UNIQUE | An e-mail address. The stable identity is always the provider pair. |
| **Person** | `identity.person` (existence only) + `identity_private.person_private` (vault) | An athlete, or an account. |
| **Athlete** | `identity.athlete` (sporting identity; `person_id` **NOT NULL**, one athlete per person — see §4) + mutable `identity.athlete_profile` | A wallet, or a verified record. |
| **Wallet** | `identity.wallet_link` (proof of control of an address at a time) | An identity. Keys are never stored. |

Account ↔ Person control is explicit (`identity.account_person_control`):

- **SELF:** at most one per account and one per person (partial unique indexes).
- **GUARDIAN:** never stored as control. It is *derived* from an **ACTIVE** guardian relationship plus the guardian account's own SELF control.

The whole policy lives in `packages/identity/src/policies.ts` (`canOperateOnPerson`):

| Operation | SELF | GUARDIAN (confirmed) | anyone else |
|---|---|---|---|
| VIEW/EDIT_PRIVATE_DATA | ✔ | ✘ | ✘ |
| LINK_WALLET | ✔ | ✘ | ✘ |
| CREATE_ATHLETE, EDIT_ATHLETE_PROFILE, SET_VISIBILITY, CLAIM_EXTERNAL_IDENTITY, ACCEPT_MEMBERSHIP, END_OWN_MEMBERSHIP | ✔ | ✔ | ✘ |

A DISABLED account controls nothing. Every action taken through GUARDIAN control writes an `audit_event` of type `guardian.acted-on-behalf` (BRT-02 §2.3 "on behalf of").

## 2. Authentication boundary

- `AuthContext` (`packages/identity/src/auth.ts`) is produced only by an **`AuthAdapter`** (`apps/api/src/auth.ts`). The adapter resolves the provider pair through `IdentityStore.signIn`. First sign-in creates an Account and AuthIdentity (no person). Later sign-ins return the same account, and concurrent first sign-ins converge on one account (advisory lock on the pair).
- **Production:** `authFromEnvironment` returns `failClosedAuth`. No identity provider is integrated yet, so every non-PUBLIC endpoint answers **401**. There is no bypass.
- **Development / test:** `createDevTokenAuth` accepts `Bearer brdev.<payload>.<HMAC-SHA256>` tokens, mapped to provider `test`. The optional `op` claim marks a development platform operator for INTERNAL endpoints.
  - It is wired only when `BR_DEV_AUTH=1` and `NODE_ENV≠production`. Constructing it, or minting a token, throws in production.
  - **There is no built-in secret.** The HMAC secret must be injected (tests, harnesses) or set in `BR_DEV_AUTH_SECRET`. It needs at least 32 characters and at least 10 distinct characters.
  - With `BR_DEV_AUTH=1` and no valid secret, the API **refuses to start** with an actionable error. The `dev-token` CLI exits with status 2 unless `BR_DEV_AUTH=1` and a valid secret are set.
  - The in-process demo uses a random per-run secret that never leaves the process.
- **`X-User-Id`, `X-Account-Id` and similar headers are ignored.** The integration suite sends them to every non-PUBLIC route and expects 401.

## 3. Person and the PII vault

- Private attributes (legal name, date of birth, e-mail, phone) live only in `identity_private.person_private`, as **AES-256-GCM envelopes** (`{alg,keyId,iv,ct,tag}`, with the field name as AAD).
- **Only** the `br_identity_private` role can touch that schema, and **only** the new `br_api_vault` login can assume it (NOINHERIT, `SET TRUE`, no admin). The API login (`br_api`), the worker, maintenance (rebuild), probe and PUBLIC cannot reach it. This is verified by `identity-roles.int.test.ts`.
- **Authorization happens inside the vault transaction (BRT-04R).**
  - **Problem.** BRT-04 originally checked SELF permission on the `br_api` connection, then accessed the vault in a second transaction on `br_api_vault`. A revocation, such as `disableAccount`, committing between the two could let a read or write run against revoked control.
  - **Fix.** `PersonPrivateDataService` (`packages/persistence/src/vault-store.ts`) now calls `identity_private.authorize_private_data(account, person)` as the first statement of each vault transaction. The function is:
    - `SECURITY DEFINER`, owned by the migration owner, with `search_path = pg_catalog, pg_temp`;
    - executable **only** by `br_identity_private`;
    - boolean-only — it exposes no rows.
  - **What it checks:** SELF control by an ACTIVE account. Guardians never access private data.
  - **Why there is no window.** Before querying, the function takes **shared** advisory locks on `account:<id>` and `person-control:<person>`. Identity commands that change control facts take those keys **exclusively**: `disableAccount` takes the account key, and guardian status changes take the dependent's person key.
    - An in-flight revocation makes the vault operation wait, and it then observes the revocation.
    - A vault operation already holding the lock makes the revocation wait until the vault transaction commits.
    - Each statement of the VOLATILE function uses a fresh READ COMMITTED snapshot, so the control query runs after the locks are held.
  - The vault role still has **no** SELECT on any identity table.
  - **SELF control itself is append-only.** BRT-04 has no command that removes it; its effective revocation is account DISABLED.
  - **Tests** (`identity.int.test.ts`, "BRT-04R · vault authorization"): SELF, unrelated account, guardian ACTIVE and revoked, disabled account, write/erase after revocation, both race orders, and the function's security attributes and grants.
  - Denied attempts are audited as `DENIED`.
  - Guardians cannot read or write a dependent's private data.
- **Encryption scope — stated precisely.** `createDevelopmentPiiCipher` protects vault rows against anyone without the key, for example a database dump. It is **not a KMS**, has no rotation, and **refuses to run in production**. No stronger guarantee is claimed.
  - **There is no built-in key.** Key material must be passed explicitly or set in `BR_VAULT_DEV_KEY`, with at least 32 characters; otherwise it fails closed with an actionable error.
  - A random in-memory key is produced **only** when `{ ephemeral: true }` is requested explicitly. The in-process demo does this when no key is set; its private rows are then unreadable after the run, by design.
  - The API constructs the development cipher only when `BR_VAULT_DEV_KEY` is set. Otherwise, and always in production, the vault service is not registered and private-data endpoints return **503 PRIVATE_DATA_UNAVAILABLE**.
- **Erasure** nulls every encrypted field and sets `erased_at`. The vault role cannot `DELETE`. Public sporting history is not touched.
- **Consistency:** the person row (identity login) and the vault row (vault login) are written in two transactions (authorization, however, is no longer split — see above). The vault write is an idempotent upsert, so a retry converges. A person can therefore briefly exist without private data. This is the accepted consequence of login isolation (ADR-0023).
- **No PII anywhere else.** Outbox payloads, audit `details`, idempotency request digests, passport rows, API errors and logs carry ids, statuses and field *names* only. Idempotency fingerprints of private data must use `PiiCipher.fingerprint` (HMAC), never a plain hash. Tests scan the outbox, audit, idempotency and passport tables, and serialized API responses, for the seeded PII values.

## 4. Athletes, profiles and slugs

- `createAthlete` (SELF or confirmed GUARDIAN) creates the athlete, its ACTIVE status, first slug and profile, and refreshes the passport, in one transaction. It is idempotent, and there is at most one athlete per person.
- The **profile** (`athlete_profile`, OP) is self-described: display name ≤ 80, bio ≤ 500, ISO country, avatar reference (`media:<uuid>`), ≤ 10 sport ids, and visibility PUBLIC / AUTHENTICATED / PRIVATE. Text is NFC-normalized and control characters are refused. Nothing in a profile can create a verified fact.
- **Slugs** (`packages/identity/src/slug.ts`) are processed in this order:
  1. NFKC normalization, lower-casing and trimming.
  2. Spaces and underscores become `-`, and repeated hyphens collapse to one.
  3. The result must match `^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$`.
  4. The result must not be in `RESERVED_SLUGS` (api, admin, official, verified, …).

  Lookups are case-insensitive through the same normalization.
- **Slug history.** Each claim is an append-only row, `identity.athlete_slug` (PK = slug). The current slug is the latest claim. A former slug stays bound to its athlete **forever**: it resolves with `redirected: true` (the web issues a 308), and nobody — including the same athlete — can re-claim it. Concurrent claims of one slug are serialized by an advisory lock and the PK, and exactly one wins (`SLUG_TAKEN` for the others).
- **Athlete ↔ Person invariant (BRT-04R, strict).** Every athlete has exactly one Person: `identity.athlete.person_id` is **NOT NULL**, with a unique index for one athlete per person.
  - BRT-04 has no import or ingestion workflow, so a person-less athlete would have no defined owner, controller or publication rule. Null is therefore not allowed to carry hidden meaning.
  - Self-service creation requires SELF or confirmed GUARDIAN control of an existing person. An unknown or uncontrolled person gives FORBIDDEN.
  - Imported or unclaimed athletes, and claim/merge flows, are deferred. They will arrive with an explicit origin/claim model and their own migration.
  - Tested by the database NOT NULL check and by the store.
- **Duplicate resolution (foundation).** `athlete_identity_resolution` maps an athlete id to a canonical athlete id (INTERNAL, audited). Chains are refused at write time. History is never rewritten, and readers follow the link (`canonicalAthleteId`).

## 5. Guardians and minors

- `createPerson(relation: DEPENDENT)` creates a person with no SELF control, plus a guardian relationship in state **PENDING (asserted)**. `assertGuardianRelationship` does the same for an existing person.
- **An asserted relationship grants nothing.** Only **ACTIVE** relationships grant GUARDIAN control. `ACTIVE` requires a `confirmation_basis` (PLATFORM_REVIEW, ORGANIZATION_CONFIRMED or DEPENDENT_CONFIRMED), enforced by a CHECK. In BRT-04 only the INTERNAL operator endpoint confirms. Guardians or operators can revoke.
- **Minor privacy default.** An athlete whose person is the dependent of any PENDING or ACTIVE guardian relationship is **restricted**:
  - the passport is not served at all (it looks the same as "not found"), whatever visibility is set;
  - external identities, wallets and affiliations are not projected.

  Dependents' athletes are also created PRIVATE by default.
- **Limitation (documented, not hidden).** Minority is *not* derived from date of birth. The DOB lives in the vault, which the passport path cannot read, and the age threshold is still an open policy question (BRT-02 §2.3). A minor who registers alone, with no guardian relationship, is not detected. Consent records (BRT-02 `consent_record_ids`) are not implemented.

## 6. External identities

`external_identity` records a namespace, an optional issuer organization, a value, a visibility and the claimant. Its lifecycle is **CLAIMED → CONFIRMED → REVOKED** (append-only status changes):

- **Claiming** (SELF / GUARDIAN) always yields **CLAIMED**. Typing an identifier never confirms it.
- **Confirming** requires the application permission `ORG_CONFIRM_EXTERNAL_ID` in the **issuer** organization. The status row must carry `confirmed_by_organization_id` (CHECK). The same `(namespace, issuer, value)` cannot be CONFIRMED for two athletes (checked under a lock).
- **Revoking:** the owner (or guardian) or the issuer can revoke.
- In the passport, CLAIMED is labelled `SELF_DECLARED` and CONFIRMED is labelled `ORGANIZATION_CONFIRMED`. Neither is `AUTHORITY_VERIFIED`: an application permission is not sports authority.

## 7. Wallet links (proof of control)

1. **`prepareWalletLink`** (SELF only; guardians cannot link wallets) stores a **single-use, 10-minute** challenge.
   - **Network boundary (BRT-04R).** The challenge names a **proof scheme**, and each scheme belongs to exactly one network family. BRT-04 has two: `eip191-personal-sign` (production, the default) and `test-signature` (development). Both are **EVM-only**:
     - the network must be `eip155:<positive chainId>`, and the address must be 20-byte hex;
     - `normalizeWalletTarget` refuses anything else before a challenge exists. Rejected examples: `xrpl:0`, `solana:…`, `eip155:0`, `eip155:abc`, and malformed addresses;
     - the address is stored and signed in **lower-case**;
     - a challenge is refused unless a verifier for `(scheme, network)` is configured.
   - The API DTO enforces the same patterns, and the database CHECKs them on `wallet_link_challenge`.
   - The challenge is bound to the person, account, network, address, scheme, a 128-bit random nonce, purpose `wallet-link` and audience. All of these are in the signed text (`buildChallengeMessage`).
   - The format is CAIP-122 / EIP-4361 *inspired*; strict SIWE parsing compatibility is not claimed.
   - XRPL and other families will come later as separate schemes and adapters.
2. **`verifyWalletLink`** locks the challenge, then checks, in order:
   - the challenge belongs to the caller's account;
   - it has not been consumed;
   - it has not expired.

   It then dispatches to **the single verifier for the challenge's persisted (network family, scheme)**, never by address shape; configuring two verifiers for one scheme is refused. The challenge is **consumed on the first attempt**, whether it succeeds or fails, so replays fail.

   Only a successful proof creates a `wallet_link`, which stores the verifier id, scheme, accepted `proof_signature`, `proof_status` and ACTIVE status. Two database CHECKs back this up:
   - `(proof_scheme = 'test-signature') ⇔ (proof_status = 'TEST_VERIFIED')`;
   - both verifiers also re-check scheme and network family themselves.
3. **`eip155EoaPersonalSignVerifier`** (PRODUCTION): EIP-191 `personal_sign` recovery with secp256k1 (`@noble/curves`), comparing the recovered address. It is validated against the public web3.js vector. Smart-contract wallets (EIP-1271/6492) are not supported yet.
4. **`createTestWalletVerifier`** (TEST, scheme `test-signature`, EVM networks only) accepts `test-signature:<nonce>`, and only on test-scheme challenges. Its links are **`TEST_VERIFIED`** and never `VERIFIED`. Production defences:
   - the verifier factory throws in production;
   - `IdentityStore` refuses any non-PRODUCTION verifier when constructed in production;
   - `verifyWalletLink` refuses TEST verifiers at use time in production;
   - the API wires the test verifier only with development auth;
   - the public passport suppresses `TEST_VERIFIED` in production (see BRT-04-ATHLETE-PASSPORT §1).

   A production-only store neither offers the test scheme nor accepts test signatures (tested).
5. No private keys, seed phrases or mnemonics are ever accepted or stored. The `check-no-key-material` guard still scans all migrations.

## 8. Facts, events, audit, idempotency

- Identity and organization facts are append-only **class A** tables (`reject_mutation`, `assert_recorded_at` triggers). They are not hash-chained ledgers. Status histories use a `seq` identity column plus `DISTINCT ON` "current" views. Profiles and `auth_identity_activity` are mutable **OP** rows.
- **Outbox events** (`packages/domain/src/events.ts`) cover the account, person, athlete, organization, membership, guardian, wallet and external-identity lifecycles. Their payloads contain ids, statuses, roles, slugs and namespaces only.
- **Audit** (`platform.audit_event`, append-only) is written by identity, organizations and the vault. Runtime roles have INSERT but **no SELECT** on it: accountability is write-only for the application.
- **Idempotency.** Every creating command takes an `Idempotency-Key`. The fingerprint is (command, actor, SHA-256 digest of parameters) under schema `br:cmd-identity@1`. Replays return the stored response, and a reused key with different parameters fails with `IDEMPOTENCY_KEY_REUSED`. Concurrency tests cover same-key athlete creation, slug races, concurrent invitation acceptance, concurrent wallet verification and concurrent first sign-in.

## 9. Interpretations of BRT-02 (no contradiction; recorded)

| BRT-02 text | BRT-04 implementation | Why |
|---|---|---|
| `Account.person_id` | `account_person_control(kind = SELF)` | Same 1:1 meaning. It keeps Account and Person independently creatable and leaves room for delegated kinds (ADR-0021). |
| `OrganizationMembership(account_id, roles OWNER/ADMIN/STAFF/VIEWER)` | Membership keyed on **person**, roles OWNER/ADMIN/MEMBER/ATHLETE/COACH/OFFICIAL/STAFF | Memberships must describe athlete affiliations and be acceptable by a guardian. Permissions still resolve through the caller's SELF person. VIEWER ≈ MEMBER (ADR-0021). |
| GuardianLink basis `PARENT, LEGAL_GUARDIAN, CLUB_DELEGATE?` | `PARENT, LEGAL_GUARDIAN, OTHER_RESPONSIBLE_ADULT` plus an explicit asserted/confirmed lifecycle | The club-delegate case is modelled as an organization-confirmed relationship, not as a kind. |
| WalletLinkProof table | Challenge (message) + consumption + `wallet_link.proof_signature` | Same information, re-verifiable; no separate table. |
| `Person.is_minor` derived from DOB | Not implemented (see §5) | DOB is vault-only; policy threshold undecided. |

## 10. Out of scope (BRT-05+)

Real identity providers (OIDC, passkeys, e-mail links), KMS-backed PII encryption and rotation, consent records, DOB-based minority, EIP-1271 smart-wallet proofs, merge UX for duplicates, account deletion/pseudonymization flows, avatars/media upload, and any competition, result or achievement data in the passport.
