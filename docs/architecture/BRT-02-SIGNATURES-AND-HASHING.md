# BRT-02 — Canonicalization, Hashing, Signatures & Key Management

| Field | Value |
|---|---|
| Ticket | BRT-02 |
| Status | Proposed — for review |
| Implements | BRT-01 R-1/R-5 (content hashes), [Verification model §2.4, §3](../domain/BRT-01-VERIFICATION-MODEL.md) |
| ADRs | [0014 canonical JSON & hashing](../adr/ADR-0014-canonical-json-and-hashing.md), [0015 signature envelope](../adr/ADR-0015-signature-envelope.md), [0016 key management](../adr/ADR-0016-key-management.md), [0013 identifiers](../adr/ADR-0013-identifier-strategy.md) |

---

## 1. Goals

1. **Two semantically identical objects produce the same hash**, in any language and on any machine.
2. **A hash is unambiguous about *what kind* of object it is.** This is domain separation: a ResultVersion hash can never be confused with an attestation hash.
3. **Signatures work for people and systems that do not use crypto wallets**, as well as for those that do.
4. **Every signature is bound to its purpose, audience, subject and time window**, which prevents replay.
5. **Keys can rotate, expire and be declared compromised**, with a defined effect on past signatures.

---

## 2. Canonical serialization: BR-JSON profile v1

**Decision** ([ADR-0014](../adr/ADR-0014-canonical-json-and-hashing.md)): serialize with **RFC 8785 JSON Canonicalization Scheme (JCS)**, applied to a **restricted JSON profile ("BR-JSON v1")** that removes JCS's weak points for our data.

### 2.1 Why JCS, and why a profile on top

| Option | Assessment |
|---|---|
| **RFC 8785 JCS** | The API and storage format is already JSON. JCS is a published standard with implementations in many languages, gives deterministic key ordering and escaping, and yields human-auditable bytes. **Weak points:** (a) numbers are canonicalized via IEEE-754 double formatting, so decimals like 10.10 are lossy and ambiguous; (b) no Unicode normalization; (c) it does not know which arrays are sets or what "absent" means. **All three are fixed by the profile below.** |
| Deterministic CBOR (RFC 8949 §4.2) | Compact and well-specified, but opaque to humans and less familiar to partners (federations, clubs, auditors). **Accepted as a *device-native* payload format**: devices may sign COSE/CBOR, and the platform hashes the raw bytes as Evidence. |
| EIP-712 typed data | EVM-specific. It is used only as a *wallet signature presentation* (§4.3), never as the canonical hash. |
| Protocol Buffers | Not canonical by specification. |
| Custom format | No independent implementations; high error risk. |

### 2.2 Profile rules

| Aspect | BR-JSON v1 rule |
|---|---|
| **Encoding** | UTF-8, no BOM. JCS output (keys sorted by UTF-16 code units, no insignificant whitespace, JCS string escaping). |
| **Unicode** | All strings are normalized to **NFC** before hashing. Lone surrogates are rejected. Control characters U+0000–U+001F are rejected except `\n` and `\t` in designated free-text fields. |
| **Null** | `null` is **forbidden** (reject). Absent means "not provided". The schema decides which fields are required. |
| **Empty collections** | Optional arrays or objects that are empty **must be omitted**. Required collections may be empty. This leaves a single representation. |
| **Integers** | JSON numbers are allowed **only** as integers in the safe range ±(2⁵³−1): counts, ordinals, ranks, games, pins. |
| **Decimals** | Always **strings** in canonical decimal form: optional `-`, no leading zeros (except `0`), no exponent, no `+`, no `-0`. The fraction has no trailing zeros, **except in `Mark.value`**, whose fraction digits equal the metric's declared `precision` exactly ("10.20" at precision 2 differs from "10.2" at precision 1: precision is semantic). |
| **Durations** | Decimal string in the metric's unit (e.g. seconds with declared precision). Never ISO-8601 duration syntax inside hashed content (it allows multiple equivalent forms). |
| **Timestamps** | RFC 3339 **UTC** with `Z` and exactly **millisecond** precision: `2026-05-14T18:03:07.120Z`. Dates: `YYYY-MM-DD`. Sub-millisecond timing belongs in `Mark` values, not timestamps. Local time zones are stored separately as an IANA zone name when needed. |
| **Identifiers** | Canonical UUID strings, lowercase, hyphenated (`0190f4c2-…`). API prefixes (TypeID rendering, [ADR-0013](../adr/ADR-0013-identifier-strategy.md)) are **never** used inside hashed content. |
| **Hashes inside content** | `"sha256:<64 lowercase hex>"` |
| **Enums** | UPPER_SNAKE ASCII strings exactly as defined by schema |
| **Arrays: order** | Arrays are **ordered** (semantic order: game 1..3, set 1..n, attempts) unless the schema marks them as **sets** with `x-br-set: { sortBy: [<field paths>] }`. Sets are sorted by the declared keys (byte-wise on their canonical JSON) and must not contain duplicates (§2.2a rule 4). Examples: `evidenceRefs`, `entries` (sorted by `participantId`), `capabilities`. |
| **Unknown fields** | Rejected. The schema is closed (`additionalProperties: false`), consistent with BRT-01 R-7. |
| **Booleans** | `true`/`false`. Optional booleans with a default are omitted when equal to the default. |

### 2.2a Normative details (BR-JSON v1)

These rules are precise enough that two independent implementations produce identical bytes. Where a rule says **reject**, the input is invalid, and no normalization may "repair" it.

1. **Object members.**
   - Member names are defined by the schema (ASCII identifiers, case-sensitive).
   - Duplicate member names in input → **reject**.
   - Members are serialized in JCS order: sorted by UTF-16 code units, which for ASCII names equals byte order.
2. **Absent vs null.**
   - `null` anywhere → **reject**.
   - An optional member is either present with a valid value, or absent.
   - An optional array or object that is empty is **removed** by normalization.
   - A member equal to its schema `default` is **removed** by normalization. Schemas used for hashed content must declare defaults explicitly or have none.
3. **Ordered arrays** (the default).
   - Order is preserved exactly as supplied and is semantically meaningful: game 1..3, set 1..n, attempts in order.
   - Duplicates are allowed unless the schema declares `uniqueItems`.
4. **Set arrays** (schema `x-br-set: { sortBy: [jsonPointer…], keyUnique?: boolean }`).
   - **Sort key.** Each element's sort key is the JCS serialization of the JSON array of its `sortBy` values. Elements are sorted by **bytewise comparison of the UTF-8 sort-key bytes**.
   - **Ties** on the sort key are broken by bytewise comparison of each element's full JCS bytes.
   - **Exact duplicate elements → reject.** Duplicates are never silently de-duplicated.
   - If `keyUnique: true`, two elements with the same sort key → **reject**.
5. **Integers.**
   - JSON number tokens are parsed to their mathematical value. The input spelling (`1`, `1.0`, `1e0`) is irrelevant, and canonical output is the JCS rendering (`1`).
   - The value must be integral and within ±(2⁵³−1); otherwise → **reject**.
   - `-0` is rendered as `0` (JCS behavior).
   - Non-integer numbers anywhere → **reject**, because decimals must be strings.
6. **Decimals** (string-typed decimal fields).
   - Canonical form matches `^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$`: no exponent, no `+`, no leading zeros, no trailing fractional zeros, no bare `.`.
   - **Negative zero:** any zero value is rendered `"0"`.
   - Input in another *equivalent* spelling (e.g. `"1.50"`, `"+1.5"`, `"01.5"`) is normalized. Exponent notation → **reject**.
   - A maximum of 38 significant digits.
7. **`Mark.value`** (precision-bearing).
   - The value must have **exactly** `precision` fraction digits (none if precision is 0).
   - More or fewer digits → **reject**. There is no rounding and no padding: the source or adapter must convert explicitly under the metric's declared precision.
   - Zero is `"0.00"`-style (never `"-0.00"`).
8. **Timestamps.**
   - Canonical `YYYY-MM-DDTHH:MM:SS.sssZ`, UTC, exactly 3 fraction digits, years 0001–9999, no leap second (`:60` → reject).
   - Input with a numeric offset is converted to UTC. Input with fewer fraction digits is zero-padded.
   - Input with more than 3 fraction digits: accepted only if the extra digits are all zero; otherwise → **reject** (no truncation or rounding).
   - Dates are `YYYY-MM-DD`.
9. **UUIDs.**
   - Canonical 36-character lowercase hyphenated form (8-4-4-4-12).
   - Uppercase input is lowercased.
   - Braces, `urn:uuid:` prefixes, missing hyphens or TypeID prefixes → **reject** inside hashed content.
10. **Unicode.**
    - Every string (values and member names) is normalized to **NFC**.
    - Lone surrogates → **reject**.
    - U+0000–U+001F → **reject**, except U+0009 and U+000A in schema-designated free-text fields.
    - No other character filtering. Escaping follows JCS.
11. **Unknown fields.** Schemas are closed (`additionalProperties: false`). Unknown members → **reject**.
12. **Schema binding.**
    - The preimage includes `schemaId@schemaVersion` (§3.2).
    - The schema registry immutably binds each `schemaId@version` to the schema document's own content hash (domain `json-schema`), and that binding is anchored.
    - Verifiers must validate against exactly that schema document. A schema cannot change without a new version.
13. **Golden test vectors are mandatory** (§3.4) for every rule above. Each vector gives input, normalized JSON, JCS bytes (hex) and hash, plus reject cases with the expected rule id. Cross-language conformance (at least TypeScript plus one independent implementation) is required before any hash is anchored.

### 2.3 Pipeline: normalize, then verify, then hash

```
input (API / adapter)
  → schema validation (JSON Schema 2020-12, versioned, content-addressed)
  → normalization (NFC, decimal/timestamp canonical forms, omit empties/defaults, sort sets)
  → canonical-profile assertion (rejects anything normalization could not make canonical)
  → JCS serialization
  → hash (with domain separation)
  → store normalized content (so re-hashing stored content reproduces the hash)
```

**Normalization is deterministic and versioned with the profile.** A change to normalization means a new profile version, never a silent change.

---

## 3. Hashing and domain separation

### 3.1 Algorithm

**SHA-256** for all platform content hashes. Reasons:

- universal support: browser WebCrypto, every language, cloud KMS digest inputs, HSMs;
- FIPS approval;
- adequate security margin;
- external verifiers can reproduce it with standard tools.

**Alternatives considered:**

- **Keccak-256** appears only *inside* EVM signature schemes (EIP-712/191), where the scheme requires it.
- **BLAKE3** is faster but less universally supported, and speed is not a bottleneck here.

### 3.2 Preimage construction

```
contentHash = SHA-256(
    "BR" ‖ 0x01                              -- magic + hash-construction version
  ‖ domainTag           ‖ 0x00              -- ASCII, what kind of object
  ‖ schemaId "@" schemaVersion ‖ 0x00       -- ASCII, which schema the payload conforms to
  ‖ profileId           ‖ 0x00              -- "br-json/1"
  ‖ JCS(normalizedPayload)                   -- UTF-8 bytes
)
```

- **Representation.** In APIs and content the hash is written `sha256:<hex>`. On-chain it is `bytes32`.
- **Domain tags** (initial registry, extensible):

| domainTag | Object |
|---|---|
| `result-version-content` | ResultVersion.content |
| `attestation-statement` | Signed statement (§4.1) |
| `authority-grant` | Grant document |
| `grant-status` | Grant revocation or suspension document |
| `key-status` | Key rotation or compromise declaration |
| `discipline-version` / `format-template` / `json-schema` | Catalog definitions |
| `verification-policy` / `achievement-rule` | Policy and rule definitions (the policy code bundle hash is included) |
| `verification-inputs` | `inputsDigest` (see [Verification engine](./BRT-02-VERIFICATION-ENGINE.md)) |
| `system-configuration` | Device or system `configHash` |
| `achievement-basis` | Achievement basis set |
| `prize-terms` / `payout-instruction` | Value-bearing documents |
| `credential-id` | Deterministic trophy credential id |
| `wallet-link` | Wallet link challenge |
| `ledger-row` | Hash-chained ledger rows |
| `ingestion-key` | Ingestion idempotency key |

**Evidence bytes are the exception.** Evidence blobs are hashed as **plain SHA-256 of the raw bytes**, with no domain tag. Anyone must be able to check a video or PDF with `sha256sum`. The EvidenceItem *metadata* record is a separate object.

### 3.3 Merkle trees

Used for AnchorBatch roots and the Achievement `evidenceCommitment`:

- **RFC 6962-style hashing:** `leaf = SHA-256(0x00 ‖ leafData)`, `node = SHA-256(0x01 ‖ left ‖ right)`. The distinct prefixes prevent second-preimage attacks.
- **Leaf data** is the 32-byte domain-separated hash of the item.
- **Ordering.** Anchor batches follow ledger sequence order. Evidence commitments are sorted byte-wise, which gives set semantics.
- **Proofs.** Inclusion proofs are served by the API.

### 3.4 Test vectors

The canonicalization and hashing library must ship **published test vectors**: inputs, normalized JSON, JCS bytes and hashes, including Unicode, decimal and set edge cases. Any second implementation (a federation's verifier, a contract) is validated against them. This is a BRT-03 deliverable.

---

## 4. Signature architecture

### 4.1 The signed statement (scheme-independent)

Every signature signs a **Statement**, a canonical BR-JSON object hashed with domain tag `attestation-statement` (or another purpose-specific tag):

```
Statement {
  v: 1
  purpose: "attestation" | "authority-grant" | "grant-status" | "key-status" | "wallet-link"
         | "result-transition" | "dispute-resolution" | "prize-terms" | "evidence-source"
  audience: "bragging-rights:prod"            -- environment binding (staging signatures invalid in prod)
  issuer: { principalId, keyId }
  subject: { type, id, hash }                 -- binds to exact content (R-5 / A-1)
  claim: { type, polarity, payload? }         -- for attestations
  authorityContext?: { actingRole, scopeRef, grantIds[] }
  evidenceRefs?: [ { id, hash } ]             -- set, sorted
  nonce: "<128-bit random, base64url>"
  signedAt: "<RFC 3339 ms Z>"                 -- signer's claim
  notBefore?: ...
  expiresAt: "<RFC 3339 ms Z>"                -- signature acceptance deadline (replay bound)
}
statementHash = H("attestation-statement", "statement@1", JCS(Statement))
```

### 4.2 Signature envelope: a proof bound to a Statement

([ADR-0015](../adr/ADR-0015-signature-envelope.md))

**What the envelope means.** The common abstraction means *"a cryptographic proof bound to this canonical Statement"*. It does **not** mean that every signer literally signs the same byte string. Each proof type defines its own signing input, which binds `statementHash` in a scheme-specific way. The verifier always recomputes `statementHash` from the canonical Statement first.

```
SignatureEnvelope {
  statement: Statement          -- full canonical object; verifier recomputes statementHash
  statementHash                 -- must equal recomputation
  proofType                     -- DIRECT_SIGNATURE | WALLET_SIGNATURE | WEBAUTHN_ASSERTION | DEVICE_SIGNATURE | PLATFORM_WITNESS
  scheme                        -- concrete scheme within the proof type (see §4.3)
  keyId                         -- PrincipalKey id (for wallets: resolved from the CAIP-10 account)
  proof                         -- scheme-specific proof material (§4.3); never assumed to be "signature over statementHash bytes"
  assurance                     -- HOLDER_KEY | DEVICE_KEY | PLATFORM_WITNESSED — derived by the verifier, never trusted from input
}
```

### 4.3 Proof types

| `proofType` | Schemes | Who | Signing input (what is actually signed) | Stored proof material | Verification |
|---|---|---|---|---|---|
| **DIRECT_SIGNATURE** | `JWS_DETACHED` (ES256, ES256K, EdDSA) | Organization, service, federation and platform (KMS) keys | JWS (RFC 7515) with unencoded detached payload (RFC 7797, `b64:false`); payload = `"bragging-rights/sig/v1:" ‖ hex(statementHash)`; protected header has `alg`, `kid` | Protected header, signature | Standard JOSE verification with the registered public key |
| **WALLET_SIGNATURE** | `EIP712`, `EIP191` | EVM wallets (EOA and smart accounts) | **EIP712:** typed data, domain `{name: "Bragging Rights", version: "1"}` (optional `chainId` if the wallet requires it; not security-relevant), struct `BRStatement { bytes32 statementHash; string purpose; string audience; string summary }`. **EIP191:** `personal_sign` of `"Bragging Rights statement\n" ‖ summary ‖ "\nHash: " ‖ hex(statementHash)`. | Typed data (or message), signature, signer account (CAIP-10) | `ecrecover`, or **EIP-1271** for smart accounts (EIP-6492 if undeployed). The verifier re-renders `summary` and requires equality. |
| **WEBAUTHN_ASSERTION** | `WEBAUTHN` | Passkeys and security keys (officials, organizers, athletes without wallets) | The authenticator signs the **standard WebAuthn assertion**: `authenticatorData ‖ SHA-256(clientDataJSON)`. The Statement is bound *indirectly* through a server-generated **ceremony challenge** (§4.3.1). | See §4.3.1 | See §4.3.1 |
| **DEVICE_SIGNATURE** | `COSE_SIGN1`, `DEVICE_RAW` | Timing and scoring hardware, sensors, certified machine systems | COSE_Sign1 (RFC 9052) with payload = `statementHash` (or a device capture manifest that contains it), **or** a raw ES256/EdDSA signature over the DIRECT_SIGNATURE payload string | COSE structure or raw signature; optional hardware-attestation certificate chain | Device public key from DeviceRegistration; attestation chain if required by device policy |
| **PLATFORM_WITNESS** | `PLATFORM_WITNESS` | Principals without a key | The platform witness key (KMS) signs a `WitnessStatement` (DIRECT_SIGNATURE form) whose subject is the Statement (see §4.3.2) | WitnessStatement + platform signature | Platform witness public key (published) |

#### 4.3.1 WebAuthn ceremony semantics

A passkey does not sign arbitrary application bytes. The Statement is therefore bound through the challenge:

1. **Prepare.** The server canonicalizes the Statement and computes `statementHash`. It then creates a **signing ceremony** record (single-use, short TTL) and derives:
   ```
   challenge = H("webauthn-challenge", "webauthn-challenge@1",
                 JCS({ ceremonyId, statementHash, purpose, audience, nonce, expiresAt, rpId }))
   ```
   Every binding field is also inside the Statement. Duplicating them in the challenge preimage lets a verifier check the binding without trusting server state.
2. **Assert.** The client calls `navigator.credentials.get` with this challenge, `allowCredentials` restricted to the principal's registered passkeys, and `userVerification: "required"` for authority actions.
3. **Store** the complete proof material:
   - credential id and user handle;
   - `authenticatorData`, `clientDataJSON` and the signature, as raw bytes;
   - the challenge preimage fields (`ceremonyId`, etc.);
   - RP ID and origin;
   - the flags observed (UP, UV, BE, BS) and the sign count.
4. **Verify**, at acceptance, and again by any later verifier from stored material plus the registered credential public key:
   - `clientDataJSON.type = "webauthn.get"`;
   - `clientDataJSON.challenge` equals the recomputed challenge, which proves binding to `statementHash`, purpose, audience, nonce and expiry;
   - `clientDataJSON.origin` is in the platform's allowed origins;
   - `authenticatorData.rpIdHash = SHA-256(rpId)`;
   - the UP flag is set, and UV is set when required;
   - the signature verifies over `authenticatorData ‖ SHA-256(clientDataJSON)` with the credential's registered public key (PrincipalKey[PASSKEY]);
   - the ceremony is unused and unexpired (single use, which prevents replay).
5. **Counter and backup semantics.**
   - If the stored and new sign counts are both non-zero and the new count is **not greater**, flag a possible cloned authenticator (`SUSPECT_ATTESTER` input). Do not reject automatically; synced passkeys commonly report 0.
   - The backup-eligible and backed-up flags (BE/BS) are **recorded**. Policy may treat synced (multi-device) passkeys differently from device-bound keys for high-assurance actions; that policy is deferred.

#### 4.3.2 Platform witness never manufactures authority

A `PLATFORM_WITNESS` proof records that *principal P authenticated (method, MFA, time) and asserted Statement S*.

- **The issuer is P, not the platform.** The Authority engine evaluates **P's** grants for the capability and scope. The platform's own authority is irrelevant to the attestation's weight.
- **No authority means no weight.** If P lacks authority, the witnessed attestation is stored with P's actual role and carries no authority weight.
- **The platform principal never appears as issuer** of a witnessed statement, and the witness key has no AuthorityGrants.
- **Bounded assurance.** Witnessed proofs have assurance `PLATFORM_WITNESSED`, which is bounded by BRT-01 (for example, not counted for V4).

### 4.4 Other signed objects

These reuse the same envelope with different `purpose` values:

- AuthorityGrant issuance and revocation;
- key rotation and compromise declarations;
- wallet-link proofs (these use SIWE/CAIP-122 messages, whose statement hash is included);
- dispute resolutions;
- prize terms (funder signature);
- evidence source signatures (device-signed capture manifests).

---

## 5. Replay, rotation, expiry and compromise

| Concern | Mechanism |
|---|---|
| **Replay (same statement resubmitted)** | `statementHash` is unique in the attestation store. An identical resubmission is idempotent and returns the existing record. |
| **Replay (signature reused for another subject, environment or purpose)** | The subject hash, `purpose` and `audience` are inside the signed statement. |
| **Nonce** | `(issuer principalId, nonce)` is unique (DB constraint). The nonce is 128-bit random. The server may pre-issue nonces for human signing flows. |
| **Staleness** | `expiresAt` is required. The platform rejects statements received after `expiresAt`, or with `expiresAt − signedAt` above the policy maximum (e.g. 24 h for humans; configurable per device class for offline devices). |
| **Clock sanity** | Reject `signedAt > receivedAt + skew` (e.g. 5 min). `receivedAt` and `issuedAt` are platform times (§5.1). |
| **Key rotation** | A new key is registered by a statement signed with the **old key** or by an authority over the principal (the org for its members, the grantor, or governance). The old key moves to `ROTATED` with `effective_from`. Signatures by the old key with `issuedAt ≥ effective_from` are rejected. Earlier signatures remain valid. |
| **Key expiry** | `valid_during` on PrincipalKey. The **evaluation time T** (§5.1) must fall inside it. For online actions T is platform-observed `issuedAt`. |
| **Compromise** | A `COMPROMISED` status carries `compromised_since = t₀` (possibly in the past), declared by the principal or by an authority over it. Attestations with **`signedAt ≥ t₀` OR `issuedAt ≥ t₀`** become `SUSPECT` (BRT-01 §4.7). The `issuedAt` clause prevents an attacker from **backdating** `signedAt`. Re-verification of dependents is triggered. |
| **Retroactive grant revocation** | Handled by the Authority engine ([Identity & authority §5.5](./BRT-02-IDENTITY-AND-AUTHORITY.md#55-historical-evaluation)). Signatures stay cryptographically valid, but authority fails "as known now". |
| **Timestamp trust** | `signedAt` is a *claim*. `issuedAt` is trusted to the extent the platform is trusted. **External anchoring** of the attestation ledger provides an independent upper bound ("existed no later than anchor time"). For high-value statements (V4 ratifications, prize terms, record claims), the platform may add an **RFC 3161 timestamp token** from an external timestamp authority. Device clocks are trusted only per DeviceRegistration attestation (`captured_at_assurance`). |

---

### 5.1 Time semantics (normative)

| Timestamp | Kind | Set by | Trusted for |
|---|---|---|---|
| `signedAt` | **Signer assertion** (inside the Statement) | Signer | Nothing on its own. Only consistency checks (`signedAt ≤ receivedAt + skew`) and, for approved offline devices, the capture-time rule below. |
| `expiresAt` | Signer assertion, usually server-proposed at prepare time | Signer / server | Replay bound: rejected if `receivedAt > expiresAt` |
| `capturedAt` (evidence) | Source assertion | Source / device | Per `capturedAtAssurance` only |
| `receivedAt` | **Platform-observed** | API or ingestion edge | When the platform first saw the request |
| `issuedAt` (attestations, BRT-01) | **Platform-observed**: the time the attestation was accepted | Platform, in the accepting transaction | **The authority evaluation time for online actions** |
| `recordedAt` | **Database transaction time** of a ledger row | DB | Bitemporal "as known then" queries; ordering of knowledge |
| `effectiveFrom` / `effectiveTo` (`valid_during`) | **Authority-effective time** of grants, keys, anchors and their status changes | Authority issuing the fact, subject to the constraints below | Whether authority or key validity covered time T |
| `compromisedSince` (t₀) | **Authority-effective time**, deliberately retroactive | Key owner or an authority over the principal | Start of distrust for signatures |

**Rules:**

1. **Evaluation time (online).** Authority and key validity are evaluated at **T = `issuedAt`**, a platform-observed time. A signer-controlled `signedAt` never establishes historical authority by itself. A signer cannot backdate a statement into a window where they held authority or where a key was valid.
2. **Evaluation time (approved offline devices).** When the DeviceRegistration and the discipline/device policy allow offline capture, T may be the device-asserted capture time, only if **all** of the following hold:
   - the capture is device-signed with `capturedAtAssurance ∈ {DEVICE_SIGNED, TRUSTED_TIMESTAMP}` (secure clock, or monotonic counter plus sync evidence);
   - `receivedAt − capturedAt ≤` the policy's maximum offline delay;
   - the device key was valid at T **and** was not revoked or compromised before `receivedAt` with an effect covering T.

   Otherwise T = `issuedAt`.
3. **No retroactive grants.** A grant's `effectiveFrom` must be ≥ its `recordedAt` (minus a small skew). Authority can never be created for the past. The remedy for an unauthorized past act is a new attestation by an authorized principal.
4. **Ordinary revocation and rotation are prospective.** `effectiveFrom ≥ recordedAt`. Acts evaluated at T < `effectiveFrom` remain authorized.
5. **Compromise is retroactive.** `compromisedSince` may precede `recordedAt`. Statements with **`signedAt ≥ t₀` or `issuedAt ≥ t₀`** become SUSPECT. The `issuedAt` clause defeats backdating.
6. **As known now / as known then.** `atTime` selects the **effective-time** point (T). `asOf` selects the **transaction-time** horizon: which facts, by `recordedAt`, are considered.
   - "As known now" (`asOf = now`) includes a compromise recorded in 2027 with `t₀` in 2026, so a 2026 attestation after t₀ fails.
   - "As known then" (`asOf = issuedAt`) excludes it, so it shows the attestation was accepted in good faith.
   - Verification always uses "as known now". Audits and disputes may use both.
7. **Clock skew.** Reject `signedAt > receivedAt + 5 min`. `issuedAt` and `recordedAt` come from the platform or DB clock, which is NTP-disciplined and monitored.

## 6. Key management

([ADR-0016](../adr/ADR-0016-key-management.md))

### 6.1 Platform-managed keys (in cloud KMS or HSM, non-exportable)

| Key | Purpose | Algorithm | Custody & controls |
|---|---|---|---|
| **Platform governance keys** | Sign TrustAnchor decisions, platform-level grants, key-compromise declarations for platform keys | ES256 (P-256), one per governance member | **Individual** keys (KMS or hardware security keys held by named people), **M-of-N quorum** required for anchor decisions. No single operator can create an anchor. |
| **Platform signing key** | Platform-issued attestations: PLATFORM-scope record ratification (via review panel), `REVIEW_COMPLETED`, credential metadata signatures | ES256 | KMS; IAM allows `Sign` only by the Crypto module role; every use is audit-logged; yearly rotation |
| **Platform witness key** | `PLATFORM_WITNESS` signatures | ES256 | Separate KMS key, **separate IAM role** callable only through the witness flow, which requires an MFA-authenticated session; rate-limited; usage audited; quarterly rotation |
| **Anchoring key(s)** | Submit anchor transactions | Per network (e.g. secp256k1 for EVM) | KMS-backed signer (if the network supports KMS signing) or a dedicated low-balance hot wallet. It holds only gas funds, and its compromise cannot alter anchored history. |
| **Settlement keys** (future) | Prize escrow operations | Per network | **Not a single hot key.** Multisig or threshold (e.g. Safe-style M-of-N) with policy-engine co-signing. Decision deferred to the Prize Rail phase. |
| **Integration secrets** | Webhook HMAC secrets, provider API credentials | n/a | Secret manager (not the DB); rotated; per-source |
| **Data-encryption keys** | Envelope encryption of AUTHORITY-ONLY vault fields and private blobs | AES-256-GCM data keys wrapped by KMS | KMS; per-tenant or per-class key hierarchy enables crypto-shredding |
| **Commitment salts** | Per-athlete salt for on-chain commitments (BRT-01 ADR-0009) | random 256-bit | Encrypted in the vault under a KMS key; destroyed on erasure |

### 6.2 Third-party keys (never held by the platform)

| Key | Holder | Platform stores |
|---|---|---|
| Athlete and official wallets | User / wallet provider | Address (CAIP-10), link proofs |
| Passkeys | User's authenticator | Credential id + public key |
| Organization keys | Organization (their hardware key, multisig, their own KMS) | Public key (JWK), rotation history |
| Federation keys | Federation | Public key, anchor binding |
| Device keys | Device secure element / provider | Public key, attestation chain, DeviceRegistration |
| Embedded-wallet keys | Embedded wallet provider (MPC/TEE) | Address + proofs only |

**Hard rule:** no raw private key, seed phrase or mnemonic is ever written to the application database, logs or object storage. Secrets scanning in CI plus a DB column denylist check (e.g. no columns named `private_key`, `mnemonic`, `seed`) guard against regression of BRT-00 C-2.
