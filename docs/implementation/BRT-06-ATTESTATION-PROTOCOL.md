# BRT-06 — Attestation Protocol

| Field | Value |
|---|---|
| Implements | BRT-01 [§3 Attestation](../domain/BRT-01-VERIFICATION-MODEL.md), BRT-02 [signatures §4–5](../architecture/BRT-02-SIGNATURES-AND-HASHING.md#4-signature-architecture), ADR-0015 (envelope), ADR-0016 (no custody) |
| New ADRs | [0027](../adr/ADR-0027-person-principal-and-issuer-representation.md) (Person ↔ Principal, representation), [0029](../adr/ADR-0029-attestation-acceptance-without-authority-verdict.md) (acceptance without authority verdict, signed retraction) |
| Code | `packages/evidence/src/{statement,proof,keys}.ts`, `packages/persistence/src/{attestation-store,key-ceremony-store}.ts`, `db/migrations/0011_attestations.sql` |

## 1. What an attestation is

An immutable, signed **claim** by an identified Principal about one **exact** ResultVersion (subject hash = its content hash, A-1/R-5). A stored attestation proves only: *"the holder of this registered key signed this exact statement"*, subject to key validity at the platform-observed acceptance time. It never proves the statement is correct, never carries sporting authority, never creates a Verification and never moves a Result's lifecycle. Conflicting attestations (AFFIRM vs DENY) coexist; BRT-06 chooses no winner.

## 2. Principals: who signs

| Signer | Principal | Representation (application permission) |
|---|---|---|
| A person | explicit `PERSON` principal via `identity.person_principal` (never `Person.id`) | `PERSON_SELF`: ACTIVE account with SELF control |
| An organization | its BRT-04 `ORGANIZATION` principal (`organizations.organization_principal`) | `ORGANIZATION_ADMIN`: account's SELF person is ACTIVE OWNER/ADMIN of the ACTIVE organization |
| Guardian | **the guardian's own** PERSON principal only | a guardian never represents a dependent's principal (no delegation model in BRT-06) |
| SYSTEM / PLATFORM | — | not representable by accounts (adapters later) |

`authority.account_principal_representation(account, principal)` (SECURITY DEFINER, fixed `search_path`, returns a basis or NULL, shared advisory locks with account disabling and roster changes) is the single decision point, re-evaluated at prepare **and** at submit. `identity.ensure_person_principal(account, person)` (SECURITY DEFINER, EXECUTE only for `br_identity`) creates the mapping transactionally; `br_identity` has no authority-table grant. **Account ≠ issuer principal; representation ≠ ATTEST_RESULT.**

## 3. Public-key onboarding (proof of possession)

```
POST /v1/principals/:principalId/keys/prepare  { algorithm: EdDSA|ES256, publicJwk }     (representative)
  → server pre-allocates keyId, stores a key-registration challenge, returns the signing request
POST /v1/principals/:principalId/keys          { challengeId, statementHash?, proof }
  → single use, expiry, audience, representation re-check, proof verified WITH THE NEW PUBLIC KEY
  → authority.principal_key (+ PRINCIPAL_KEY ledger entry, PrincipalKeyRegistered event, audit)
POST /v1/principals/:principalId/keys/:keyId/revoke | /declare-compromised { compromisedSince? }
```

Public JWK only: required members `kty/crv/x[/y]` with **canonical** 32-byte base64url coordinates (P-256 point on the curve); RFC 7517 metadata (`alg` = the algorithm, `use` = `sig`, `key_ops` = [`verify`], `kid`, `ext`) is validated and **discarded** — only the required members are stored; every other member (all private members) is refused at the API, the parser and a DB CHECK. A key already registered to another principal is refused (no key substitution). Key identity is the **RFC 7638 thumbprint** (recomputed from the parsed key, so independent of member order, metadata or spelling); both published test-vector keys (Ed25519 and P-256) are refused by thumbprint in every representation. No test bypass exists in any environment. Registering a key grants no authority.

## 4. The signing ceremony

```
prepare  POST /v1/attestations/prepare  { issuerPrincipalId, keyId, subject{RESULT_VERSION,id}, claim,
                                          authorityContext?, evidenceIds?, supersedesAttestationId?, visibility? }
   server: representation ✓ · key admissible now ✓ · resolves exact subject hash · resolves each cited item's
           content + descriptor hash (actor must be allowed to CITE it) · validates scopeRef ∈ subject hierarchy
           · canonicalizes the EXACT statement · stores a single-use challenge
   ← { challengeId, statement, statementHash, canonicalStatement, signing{protected,payload,signingInput}, expiresAt }
sign     (signer side, private key never leaves it)   signature = Sign(signingInput)
submit   POST /v1/attestations  { challengeId, statement?, statementHash?, proof{DIRECT_SIGNATURE, JWS_DETACHED, protected, signature} }
   server: lock challenge · unused? · same account? · audience = this environment? · not expired (strict) ·
           re-canonicalize stored + echoed statement (tamper ⇒ reject) · representation ✓ · key admissible at T ✓ ·
           proof verifies ✓ → consume ACCEPTED + store attestation, evidence refs, ledger, outbox, audit, card
```

Rejections are **committed** (consumption `REJECTED` with a reason code + DENIED audit) before the error surfaces, so a rejected proof can never be retried against the same challenge.

### 4.1 Statement (`br:attestation-statement@1`, BRT-02 §4.1)

```
{ v: 1, purpose: "attestation", audience: "bragging-rights:<env>",
  issuer:  { principalId, keyId },
  subject: { type: "RESULT_VERSION", id, hash },                 -- exact ResultVersion content hash
  claim:   { type: RESULT_ACCURATE | CONDITIONS_COMPLIANT, polarity: AFFIRM | DENY,
             payload?: { conditions?[{aspect,key,value?,unit?,code?}] (set), reasonCode? } },
  authorityContext?: { actingRole, scopeRef?{level,id} },       -- DECLARED by the signer; evaluated by BRT-07
  evidenceRefs?: [{ evidenceId, contentHash, descriptorHash }] (set, keyUnique, ≤ 64),
  supersedes?:   { attestationId, statementHash },
  nonce:     128-bit base64url (the challenge),
  signedAt:  signer assertion (server-proposed = challenge time),
  expiresAt: challenge expiry (≤ 24 h after signedAt; default TTL 10 min) }
statementHash = SHA-256("BR" ‖ 0x01 ‖ "attestation-statement" ‖ 0x00 ‖ "br:attestation-statement@1" ‖ 0x00 ‖ "br-json/1" ‖ 0x00 ‖ JCS)
```

The claim language is bounded (closed enums; no executable content). Claim shapes: `RESULT_ACCURATE` carries no conditions (a `reasonCode` only with `DENY`); `CONDITIONS_COMPLIANT` needs ≥ 1 observation (value or code). Conditions use generic aspects/keys — no sport-specific columns.

### 4.2 Signing preimage (test-vector-backed)

`DIRECT_SIGNATURE / JWS_DETACHED` (RFC 7515 + RFC 7797, exactly as BRT-02 §4.3 specifies):

```
protected    = BASE64URL(UTF8({"alg":"EdDSA"|"ES256","b64":false,"crit":["b64"],"kid":"<keyId>"}))
payload      = "bragging-rights/sig/v1:" ‖ hex(statementHash)
signingInput = ASCII(protected) ‖ "." ‖ payload
signature    = Ed25519(signingInput) | ECDSA-P256-SHA256(signingInput) as r‖s — 64 bytes, base64url
```

**Standards review (BRT-06R).** RFC 7797 §3: `b64:false` MUST be listed in `crit` — both are required, and `crit` must be exactly `["b64"]` (any other extension fails closed). There is no unprotected header at all (proof members are exactly `protected` + `signature`), so nothing can override the protected `alg`; `alg` must equal the registered key's algorithm (no `none`, no EdDSA↔ES256 confusion) and `kid` must equal the key id; any extra protected member (e.g. `jku`) is refused. RFC 7518 §3.4: ES256 signatures are the fixed 64-byte R‖S form — DER or any other length fails. Ed25519 uses node/OpenSSL verification (canonical S). ECDSA signatures remain malleable (s ↔ n−s); replay protection never relies on signature bytes (single-use challenge + nonce + statement hash). The accepted proof's identity is `proofHash = SHA-256(protected ‖ ".." ‖ signature)` (RFC 7515 App. F detached serialization), recorded in the ledger fact and the Evidence Bundle.

The payload commits to protocol/version; the statement hash commits to purpose, audience, issuer, key, subject, claim, evidence, nonce and expiry; `kid` commits to the key. Nothing display-oriented is signed. Verifier (`jwsDetachedVerifier`): strict proof members, header parsed with duplicate-key rejection and exactly `{alg,b64:false,crit:["b64"],kid}`, `alg` = the key's algorithm, `kid` = the key id, 64-byte signature, node:crypto verification. Assurance `HOLDER_KEY` is derived, never input.

### 4.3 Purposes are domain-separated

| Purpose | Schema | Domain tag |
|---|---|---|
| attestation | `br:attestation-statement@1` | `attestation-statement` |
| attestation-retraction | `br:attestation-retraction-statement@1` | `attestation-retraction` |
| key-registration | `br:key-registration-statement@1` | `key-registration` |

A signature for attestation A cannot be reused for attestation B (different statement hash), a retraction, a key registration, a wallet proof (different scheme/message), another environment (audience), another principal (issuer + kid) or another subject.

## 5. Replay prevention

- random 128-bit nonce, `UNIQUE(issuer, nonce)` on challenges **and** on attestations/retractions;
- single use: `challenge_consumption` PK + `attestation.challenge_id UNIQUE` + a trigger requiring an `ACCEPTED` consumption in the same transaction for the exact statement hash;
- `statement_hash UNIQUE`;
- expiry strict: `issued_at ≤ expires_at` is also a DB CHECK;
- audience bound per deployment (`BR_SIGNATURE_AUDIENCE`, default `bragging-rights:development`; production default `bragging-rights:prod`);
- the challenge is bound to the preparing account.

## 6. Time semantics (BRT-02 §5.1, unchanged)

| Timestamp | Kind | Use |
|---|---|---|
| `signedAt` | signer assertion (server-proposed at prepare) | only to refuse (compromise t₀ ≤ signedAt); never to admit |
| `expiresAt` | server-proposed, signed | online anti-backdating bound |
| `receivedAt` = `issuedAt` = `recordedAt` | ONE reading of the database clock in the accepting transaction (DB CHECK enforces equality) | T for key admissibility |

**Key admissibility at T = issuedAt** (as known at T): key exists, belongs to the issuer, `JWK` EdDSA/ES256, T ∈ validity window, no ROTATED/REVOKED effective ≤ T, no COMPROMISED with t₀ ≤ T or t₀ ≤ signedAt. An older `signedAt` can never resurrect an expired, revoked or compromised key (tested). No clock slack is added.

## 7. After acceptance

- **Compromise later:** the attestation, its signature bytes and statement hash stay unchanged forever. The Evidence Bundle carries the key's validity window and every status change with its `recordedAt`, so BRT-07 can apply "as known now" vs "as known then".
- **Retraction** (signed, `br:attestation-retraction-statement@1`, subject = the exact attestation statement hash, bounded `reasonCode`): only a current representative of the *original issuer principal*, with any admissible key of that principal; at most one per attestation (UNIQUE); concurrent retractions collapse to one (`created: false`). The original row is never updated. **Retracted ≠ false.**
- **Supersession:** a correction is a **new** attestation with `supersedes {attestationId, statementHash}` — same issuer, same Result (possibly a newer version). The original remains pinned to its ResultVersion; no consumer is rewritten; the bundle exposes `supersededBy`.

## 8. What is stored (class A)

`attestation.challenge`, `challenge_consumption`, `attestation`, `attestation_evidence` (composite FK to the item's own (id, content hash, descriptor hash)), `retraction`; `authority.key_registration_challenge`, `key_registration_consumption`; `identity.person_principal`. All append-only; triggers bind every column to the stored statement (BR070–BR078).

## 9. API classification

| Route | Class |
|---|---|
| `GET /v1/attestations/:id`, `GET /v1/result-versions/:id/attestations` | PUBLIC (public-safe card) |
| `POST /v1/attestations/prepare`, `POST /v1/attestations`, retraction prepare/submit, key prepare/submit/revoke/declare-compromised | ISSUER_REPRESENTATIVE (decided in the store) |
| `GET /v1/attestations/:id/detail` | AUTHENTICATED (submitter or representative; signature re-verified on read) |
| `POST /v1/persons/:personId/principal` | SELF |

Errors: `ISSUER_NOT_CONTROLLED` 403, `KEY_NOT_VALID` 422 (with a fixed-vocabulary `reason`), `ATTESTATION_PROOF_INVALID` 422, `ATTESTATION_CHALLENGE_EXPIRED` 422, `ATTESTATION_CHALLENGE_USED` 409, `CHALLENGE_INVALID` 422.

## 10. Public presentation

The public card (`br:public-attestation@1`) shows issuer label (organization display name + slug via the public profile; persons always as "Individual signer"), claim type/polarity, subject ResultVersion id, date received, proof scheme, evidence count/available count and separate trust facets: `signature: VALID_AT_ACCEPTANCE`, `claim: ACTIVE | RETRACTED`, `superseded`, `authority: NOT_EVALUATED`, `sportingVerification: EVALUATED_SEPARATELY` with a `verificationResource` link to `/v1/result-versions/:id/verification` (BRT-07R; a V-level is never copied onto an attestation), plus the notice *"This is a cryptographically signed claim. Sporting verification is evaluated separately."* It never shows statement bytes, nonces, hashes, keys, Person/Account ids or private identity, and it is served only for `PUBLIC` attestations whose competition and event are publicly visible (non-DRAFT). No "Verified" badge exists.
