# BRT-02 — Identity, Organizations & Authority Engine

| Field | Value |
|---|---|
| Ticket | BRT-02 |
| Status | Proposed — for review |
| Implements | BRT-01 [Verification model §4](../domain/BRT-01-VERIFICATION-MODEL.md) (Principals, TrustAnchors, AuthorityGrants), [Data boundaries](./BRT-01-DATA-BOUNDARIES.md) |
| ADRs | [0016 key management](../adr/ADR-0016-key-management.md), [0020 three-layer authorization](../adr/ADR-0020-three-layer-authorization.md), [0015 signature envelope](../adr/ADR-0015-signature-envelope.md) |

---

## 1. The separation this design enforces

```
Person      a human being (PII lives here, in the vault)
  ├─ Account (1..n)          a login container for the platform
  │    └─ AuthenticationIdentity (1..n)  email+password/magic link, Google/OIDC, passkey, SIWE wallet login
  ├─ Athlete (0..1 per sport-persona policy; normally 0..1)   the sporting identity; no PII
  │    └─ ExternalIdentifier (0..n)   federation ID, timing-chip ID, provider athlete ID
  ├─ WalletLink (0..n)       proven control of an address (never a key)
  ├─ GuardianLink (0..n)     guardian ↔ minor relationships
  ├─ OrganizationMembership (0..n)   dashboard/operational membership in an Organization
  └─ Principal[PERSON] (0..1)  created when the person must sign domain attestations
         └─ PrincipalKey (0..n)  wallet-linked key, passkey, JWK
```

| Must not be equal | Why |
|---|---|
| **Person ≠ wallet** | People lose, rotate and multiply wallets. Wallets are pseudonymous and transferable. A wallet is only *evidence of control* at a point in time. |
| **Athlete ≠ account** | An athlete can exist before having any account (e.g. imported historical results, or a minor managed by a guardian). An account can manage several athletes (a guardian). Accounts can be deleted without deleting sporting history (pseudonymization). |
| **Account ≠ principal** | Logging in grants no domain authority. Authority comes only from AuthorityGrants to a Principal. |
| **Membership ≠ authority** | Being "staff of Club X" in the dashboard does not let you sign for Club X. |

---

## 2. Identity entities

| Entity | Key fields | Notes |
|---|---|---|
| **Person** (vault) | `person_id`, legal name, DOB, contact, nationality, `is_minor` (derived), `pseudonymized_at` | PLATFORM-PRIVATE or AUTHORITY-ONLY per BRT-01 data boundaries §3 |
| **Account** | `account_id`, `person_id`, status, created/deleted | May be deleted; the Person is then pseudonymized if there is no legal basis to keep it |
| **AuthenticationIdentity** | `auth_identity_id`, `account_id`, method (`EMAIL`, `OIDC:<issuer>`, `PASSKEY`, `SIWE`), subject, verified_at | The auth provider handles credentials; the platform stores provider subject ids only |
| **Athlete** | `athlete_id`, `person_id` (nullable for historical, unclaimed athletes), public display name/alias, visibility settings, `claimed_at` | Referenced by all result content (R-9) |
| **ExternalIdentifier** | `ext_id`, `holder_type` (ATHLETE, ORGANIZATION, CONTEST, COMPETITION…), `holder_id`, `namespace` (issuer principal or registry, e.g. `fed:cr-padel`, `timing:provider-x`), `value`, `valid_during`, `verification_status` (UNVERIFIED, ISSUER_CONFIRMED) | Used by ingestion mapping. `value` may be PII-adjacent (a federation license number), so it is PLATFORM-PRIVATE by default. |
| **WalletLink** | `wallet_link_id`, `person_id`, `account` (CAIP-10: `eip155:8453:0xabc…`, `xrpl:0:r…`), `proof_id`, `linked_during`, `visibility` (PRIVATE, PUBLIC) | No keys stored |
| **WalletLinkProof** | `proof_id`, message (canonical), signature, scheme, nonce, issued_at, verified_at | Append-only |
| **GuardianLink** | `guardian_person_id`, `minor_person_id`, `basis` (PARENT, LEGAL_GUARDIAN, CLUB_DELEGATE?), `valid_during`, `consent_record_ids` | Consent records are AUTHORITY-ONLY. The jurisdiction-specific policy is *not* encoded here, only the structure. |
| **OrganizationMembership** | `account_id`, `organization_id`, dashboard roles, `valid_during` | RBAC for the UI only |

### 2.1 One athlete, many identifiers

Example: Ana has email login, Google login, wallets A and B, a federation license and a timing-chip id.

```
Person(ana)
 ├ Account(acc_1) ─ AuthIdentity(EMAIL ana@…) ─ AuthIdentity(OIDC google sub=…)
 ├ WalletLink(eip155:*:0xA…, proof p1)  WalletLink(eip155:*:0xB…, proof p2)
 └ Athlete(ath_ana)
     ├ ExternalIdentifier(fed:cr-bowling, "L-1234", ISSUER_CONFIRMED)
     └ ExternalIdentifier(timing:provider-x, "chip 88812", UNVERIFIED)
```

- **One Athlete regardless of login or wallet.** Ana stays a single Athlete however she logs in and whichever wallet she uses.
- **Merge.** Duplicate athletes, created for example by an import, are merged by a **MergeRecord**. The losing id becomes an alias of the surviving id, and references are resolved via the alias table. Result content is never rewritten, because result versions are immutable.

### 2.2 Wallet linking (proof of control)

1. **Challenge.** The platform issues a challenge: a canonical message following **SIWE (EIP-4361)** for EVM, or the chain-agnostic **CAIP-122** form for other namespaces. The message contains the domain, account, statement "Link this wallet to your Bragging Rights account", a nonce (single use, 10-minute TTL), issued-at, the chain namespace, and a `purpose=wallet-link`.
2. **Signing.** The wallet signs the message.
   - Externally owned accounts use a standard signature (EIP-191).
   - Smart accounts are verified via **EIP-1271**. For accounts not yet deployed, EIP-6492 is used.
3. **Verification and storage.** The platform verifies the signature and stores a `WalletLinkProof` plus a `WalletLink`. The nonce is burned.
4. **Unlinking** closes `linked_during`. Proofs remain in history.
5. **Embedded wallets** (provider-custodied, MPC or smart accounts) are allowed. The platform records only the address and proof. Custody belongs to the provider, and **the platform never holds the key**.

### 2.3 Minors and guardians (structural only)

- `Person.is_minor` is **derived** from DOB and a jurisdiction policy parameter (the threshold is an open policy question).
- A minor's Account (if any) has capabilities limited by policy, and a GuardianLink is required for consent-gated actions: public profile, media consent, credential issuance.
- Guardians act *on behalf of* a minor through their own Account. Every such action is audit-tagged `on_behalf_of`.
- A minor never gets a WalletLink for credential issuance without recorded guardian consent (BRT-01 data boundaries §3).
- When a minor reaches majority, a policy job queues a "confirm your data and consents" flow. Consents do not auto-transfer.

---

## 3. Organizations as principals

### 3.1 Entities

| Entity | Purpose |
|---|---|
| **Organization** | Club, organizer, league, federation, venue, timing provider, scoring provider, officiating provider, data provider, sponsor. Profile plus type(s). |
| **OrganizationVerification** | KYB record: level (UNVERIFIED, DOMAIN_VERIFIED, DOCUMENT_VERIFIED, GOVERNANCE_VERIFIED), evidence refs (AUTHORITY-ONLY), verifier, validity |
| **Principal[ORGANIZATION]** | Created when the organization must hold or grant authority or sign |
| **PrincipalKey** (org) | Organization-held keys: JWK (P-256 or Ed25519) or a wallet (EOA, multisig or smart account) |
| **OrganizationMembership** | Accounts that operate the dashboard (roles: OWNER, ADMIN, STAFF, VIEWER) |
| **AuthorityGrant** (org → person) | The *only* way a person acts with the organization's authority |

### 3.2 How an organization acts

| Mode | Mechanism | Assurance (BRT-01 §3.3) |
|---|---|---|
| **A. Organization key** | The org signs with its own key (held by the org: hardware key, multisig, their own KMS) | HOLDER_KEY |
| **B. Delegated person** | The org principal grants a Person principal a scoped capability (e.g. `DECLARE_OFFICIAL` for competition X). The person signs with their own key (passkey or wallet). | HOLDER_KEY (the person's) |
| **C. Delegated person, platform-witnessed** | As in B, but the person has no key. They authenticate with MFA, and the platform witness key signs the "P asserted C at T" record. | PLATFORM_WITNESSED |
| **D. Organization system** | The org's SYSTEM principal (a scoring server) signs with a device or service key under a grant | DEVICE_KEY |

**A dashboard ADMIN membership alone gives none of these.**

To create the first grant, the organization's *own* principal must act: mode A, or a governance-approved bootstrap. The bootstrap is: the platform-verified organization owner receives an initial `GRANT_AUTHORITY` grant under the org's anchor or accreditation, recorded as a governance decision.

### 3.3 Organization verification versus trust anchoring

These are separate decisions:

- **KYB verification** answers "is this really Club X?".
- **Trust anchoring** answers "do we recognize Club X, or Federation Y, as a root authority for scope S?". This is a **governance decision** (TrustAnchor), requiring GOVERNANCE_VERIFIED KYB plus evidence of mandate.

Most organizations are **not** anchors. They receive grants *under* an anchor: the platform anchor (level PLATFORM), or a federation anchor.

---

## 4. Principals and keys

| Principal type | Created for | Key kinds |
|---|---|---|
| PLATFORM | Bragging Rights governance | KMS keys only (see [ADR-0016](../adr/ADR-0016-key-management.md)) |
| ORGANIZATION | Orgs that grant or sign | JWK, WALLET (incl. multisig and smart accounts) |
| PERSON | Officials, organizers' delegates, athletes signing participant attestations | PASSKEY (WebAuthn), WALLET, JWK; or none (platform-witnessed) |
| SYSTEM | Devices, scoring and timing systems, provider feeds, AI pipelines | DEVICE (hardware-bound where possible), JWK (service) |

- **Key lifecycle:** `ACTIVE → ROTATED | REVOKED | COMPROMISED`. See [Signatures §5](./BRT-02-SIGNATURES-AND-HASHING.md#5-replay-rotation-expiry-and-compromise).
- **A principal may hold multiple keys**, and each attestation names the `keyId` used.

---

## 5. Authorization engine

### 5.1 Three layers ([ADR-0020](../adr/ADR-0020-three-layer-authorization.md))

| Layer | Question | Examples | Where |
|---|---|---|---|
| **1. Database RLS** | "Can this DB session see or insert this row at all?" | Deny-all by default; the PII vault is readable only by the vault role; athletes read their own private rows | Postgres |
| **2. Application authorization (RBAC + ownership)** | "Can this account use this endpoint or screen for this organization?" | An OrganizationMembership ADMIN can edit the competition schedule | API middleware |
| **3. Domain Authority Engine** | "Is principal X authorized to exercise capability C over scope S at time T?" | `DECLARE_OFFICIAL`, `ATTEST_RESULT`, `RATIFY_RECORD`, `ADJUDICATE_DISPUTE` | Authority module (pure evaluator plus store) |

**Every trust-layer action needs layer 3.** Layers 1 and 2 can never substitute for it.

### 5.2 The question

> *Was Principal X authorized to issue claim Y over Contest Z at timestamp T?*

It is answered by `authorize(request)`:

```
AuthorizationRequest {
  principalId, keyId, capability, claimType?,
  scopeRef: { kind: CONTEST, id: Z },      // resolved to the full scope path
  atTime: T,                               // effective time: platform-observed issuedAt (offline-device exception per Signatures §5.1)
  asOf: now | T'                           // knowledge time: "as known now" (default) or "as known then"
}
→ AuthorizationDecision {
  decision: ALLOW | DENY,
  reasons[],                              // machine-readable
  chain: [anchorId, grantId@hash, …],     // proof
  conflict: { isParticipant: bool, basis },
  evaluatedAt, asOf, engineVersion
}
```

### 5.3 Scope resolution

`scopeRef` is expanded to a **scope path** using the Competition hierarchy at time T:

```
{ sport, discipline, region, level, competitionId, eventId, roundId, contestId }
```

Grant scopes are stored normalized to the same shape. **Containment** means that every field set in the grant's scope equals the path's field (or is a prefix, for discipline namespaces such as `athletics.*`), and region containment follows ISO 3166 hierarchy (country ⊇ subdivision).

### 5.4 Evaluation algorithm (conceptual)

```
1. keys:     key(keyId) belongs to principalId; valid at T; not ROTATED/REVOKED with effective_from ≤ T; not COMPROMISED where
             compromised_since ≤ signedAt or ≤ issuedAt (as known at asOf) — see Signatures §5.1
2. conflict: participation index — is principalId (or a person it represents) a Participant / team member / lineup member
             in any scope containing Z at T?  → if yes, capability limited to PARTICIPANT/OPPONENT roles (A-5, rule 7)
3. grants:   candidate grants G where grantee = principalId, capability ∈ G.capabilities, scopePath ⊆ G.scope,
             T ∈ G.valid_during, and no revocation with effective_from ≤ T (as known at asOf)
4. chain:    for each candidate, walk parent_grant_id / grantor upward:
               each hop: grantor held GRANT_AUTHORITY + capability delegable, scope narrowing holds,
               depth ≤ every hop's maxDepth, hop valid at T (not at issuance time of child only — at T)
             terminate at a TrustAnchor for grantor principal whose recognition_scope ⊇ scopePath and valid at T
5. decision: ALLOW if any chain succeeds; record the first successful chain as the proof (deterministic ordering by grant id)
```

- **Graph size.** The chain graph is small: depth is typically ≤ 4, and grants per principal are few. Recursive CTEs are sufficient.
- **Closure cache.** Resolution is kept fast by an **authority closure cache**: principal → (capability, scope, validity interval, chain), rebuilt incrementally on grant, key and anchor events. The cache is disposable (Persistence §3.5).

### 5.5 Historical evaluation

- **Bitemporal store.** Grants, keys, anchors and their status changes each carry `valid_during`/`effective_from` (valid time) and `recorded_at` (transaction time).
- **Time axes.** `atTime` is effective time (T, normally platform-observed `issuedAt`); `asOf` is transaction time (`recordedAt` horizon). Full rules: [Signatures §5.1](./BRT-02-SIGNATURES-AND-HASHING.md#51-time-semantics-normative). Grants cannot be recorded with a past `effectiveFrom`.
- **Default evaluation is "as known now".** `asOf = now` evaluates validity at T using everything known now. A compromise declared in 2027, effective from a time in 2026, therefore invalidates 2026 attestations after t₀ (BRT-01 §4.7).
- **Reconstruction.** `asOf = T` answers "what did the system believe at the time?". This is used for audits and disputes ("the organizer acted in good faith").
- **Authorization proofs.** At acceptance, the decision is persisted as an `authorization_proof`. The **Verification engine does not trust stored proofs blindly**: it re-evaluates "as known now" when authority inputs change ([Verification engine](./BRT-02-VERIFICATION-ENGINE.md)).

### 5.6 Where the engine is called

| Action | Capability checked |
|---|---|
| Submit / accept / declare / revoke / correct result | `SUBMIT_RESULT`, `ACCEPT_RESULT`, `DECLARE_OFFICIAL`, `REVOKE_RESULT`/`ELEVATED_REVOKE`, `CORRECT_RESULT`/`ELEVATED_CORRECT` |
| Accept attestation (weighting) | per claim type (BRT-01 §3.2/§4.4) |
| Create grant | grantor holds `GRANT_AUTHORITY` for a superset scope, and delegation limits allow it |
| Evidence assessment | `ASSESS_EVIDENCE` |
| Dispute admit / resolve / appeal | `ADJUDICATE_DISPUTE` / `APPEAL_ADJUDICATE` |
| Record ratification | `RATIFY_RECORD` |
| Sanction | `SANCTION` |

**Attestations are always stored, even when unauthorized.** An attestation from a principal *without* sufficient authority for its role is accepted **as data** with its actual role (e.g. PARTICIPANT), and the Verification engine weighs it accordingly. It is rejected only when the signature is invalid or the request is malformed. This preserves BRT-01's "contradictory attestations allowed".

### 5.7 Grant issuance flow

1. The grantor principal requests a grant through the API.
2. The engine checks the grantor's authority (`GRANT_AUTHORITY`, scope ⊆, delegation depth, delegable capabilities).
3. The grant document is canonicalized and hashed (`grant_hash`), then signed by the grantor using one of the §3.2 modes. The signature envelope (`purpose = authority-grant`) is stored on the grant row; see the note below.
4. Status ledger → ACTIVE. The event `AuthorityGrantIssued` fires and the closure cache is updated.

> **Note on BRT-01 claim types.** BRT-01 §3.2 does not list an `AUTHORITY_GRANTED` claim type. BRT-02 records grant signatures in the **same signature envelope** ([Signatures](./BRT-02-SIGNATURES-AND-HASHING.md)) with `purpose = authority-grant`, stored on the grant row itself rather than as an Attestation entity. **No BRT-01 change is needed.** The grant is the signed object.

**Revocation** is signed by the grantor, a higher authority in the chain, or platform governance (for compromise). It carries `effective_from` and the `compromise` flag, and cascades to children.

---

## 6. TrustAnchor governance (implementation hooks)

- **TrustAnchors are created only through a GovernanceDecision record.** The record holds proposal, evidence of mandate, approvers and a quorum of platform governance signers (KMS-backed individual keys, or a multisig).
- **The platform anchor itself is a TrustAnchor row with `levels = [PLATFORM]`.** There is **no code path** that allows the PLATFORM principal to hold an anchor with NATIONAL, CONTINENTAL or WORLD level. That is enforced by a DB check constraint and an engine assertion (BRT-01 §4.2).
- **Anchor recognition changes** (scope reduction, revocation) are ledgered and trigger re-verification of dependents.

---

## 7. SYSTEM principals, devices and certified machines

This implements the readiness required by BRT-01 verification model §2.6 without deciding the machine-trust policy.

```
Principal[SYSTEM]  (e.g. "Provider X timing system unit 17", "Club Y lane scoring L7-8", "Line-call system at Court 1")
 ├─ DeviceRegistration        deviceId, manufacturer, model, serial (hashed), hardware attestation chain (if available),
 │                            public key(s) → PrincipalKey[DEVICE], registeredBy (org principal), valid_during
 ├─ SystemConfiguration (versioned, content-addressed)
 │     configHash = H(canonical {softwareVersion, firmwareVersion, modelId?, modelVersion?, parameters, calibrationProfile})
 ├─ Approval / calibration    Attestation(CONDITIONS_COMPLIANT, subject = SystemConfiguration configHash (+ deviceId), validity window)
 │                            issued by a principal with ATTEST_CONDITIONS for the discipline/venue scope
 ├─ AuthorityGrant(s)         e.g. {ATTEST_RESULT} scope: discipline=tennis.*, venue=V, competition=C
 └─ Outputs
       raw evidence (VIDEO / SENSOR_DATA)             sourcePrincipal = system, deviceId, configHash, DEVICE_SIGNED
       derived decision (OFFICIATING_SYSTEM_OUTPUT)   derivedFrom raw evidence; Incident linkage; device-signed
       SYSTEM attestation (RESULT_ACCURATE / Incident claims) referencing the above
```

The Verification engine can check the conditions in BRT-01 §2.6 mechanically:

- registered device;
- device-signed output;
- a grant covering the scope;
- a valid approval attestation over the *same* `configHash` recorded in the evidence;
- policy recognition;
- corroboration.

A generic AI pipeline is also a SYSTEM principal, but with `source_kind = AI_PIPELINE`. Its outputs are typed `AI_DERIVED`, so E-4 applies automatically.
