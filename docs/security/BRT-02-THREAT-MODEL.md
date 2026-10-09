# BRT-02 — Threat Model

| Field | Value |
|---|---|
| Ticket | BRT-02 |
| Status | Proposed — for review |
| Inputs | [BRT-00 §18 security findings](../archaeology/BRT-00-REPOSITORY-ARCHAEOLOGY.md#18-security-findings), BRT-01 trust architecture, BRT-02 architecture docs |
| Method | Asset-centric, STRIDE-informed, with each threat mapped to prevention, detection and recovery |

**Severity** is inherent risk if the control were absent, scaled by impact on trust and value: **CRITICAL / HIGH / MEDIUM / LOW**.

---

## 1. Assets

| ID | Asset | Why it matters |
|---|---|---|
| AS-1 | Result ledger integrity (versions, transitions) | The root of all trust |
| AS-2 | Attestation authenticity and authority | Determines verification levels |
| AS-3 | Authority graph (anchors, grants, keys) | Controls who can certify anything |
| AS-4 | Evidence integrity and confidentiality | Proof, and privacy of media and documents |
| AS-5 | Consequences: achievements, records, rankings | Public reputation |
| AS-6 | Prize value and payout instructions | Money |
| AS-7 | Trophy credentials | Public, possibly tradable representations |
| AS-8 | PII vault (incl. minors) | Legal and ethical obligations |
| AS-9 | Platform keys (governance, signing, witness, anchoring, settlement) | Catastrophic if abused |
| AS-10 | Account and wallet links | Impersonation vector |

## 2. Trust boundaries

1. Internet → API (untrusted clients)
2. External sources → ingestion adapters (semi-trusted, identity-bound)
3. API/worker → Postgres (runtime roles vs owner role)
4. API/worker → KMS (signing permissions)
5. Worker → blockchain networks
6. Platform operators and DBAs → production data (privileged insiders)
7. Devices and certified systems → ingestion (physical-world boundary)

---

## 3. Threats

| ID | Threat | Sev | Asset | Attacker | Attack | Prevention | Detection | Recovery |
|---|---|---|---|---|---|---|---|---|
| T-1 | **Fake results** | HIGH | AS-1, AS-5 | Athlete, outsider | Submits fabricated scores for a contest, or invents a contest | Submission requires `SUBMIT_RESULT` or participant standing; V0 has no consequences; V1 needs independent corroboration; V2 needs an official declaration by a scoped, non-conflicted authority plus primary evidence | Outlier-value flags; contradicting attestations; organizer queues | Reject (T4) or revoke (T8); downstream impact recompute |
| T-2 | **Organizer fraud / self-certification** | CRITICAL | AS-1, AS-5, AS-6 | Organizer | Organizer enters and wins own event, certifies it, and collects the prize (the legacy StrikeChain pattern, BRT-00 H-1) | Conflict-of-interest rule in the Authority engine (participant ⇒ PARTICIPANT weight only); prize terms can demand V3 or independent officials; funder ≠ certifier checks in prize policy | Participation index vs grant holders; anomaly reports (organizer's team always wins) | Dispute, `AUTHORITY_OVERRIDE`, grant revocation; prize entitlement held or adjusted |
| T-3 | **Athlete impersonation** | HIGH | AS-10, AS-5 | Rival, fraudster | Registers as someone else to claim their history, or competes under another identity | Athlete ≠ Account; claiming requires identity proofs; `IDENTITY_CONFIRMED` at check-in required for V3; merge/claim flows reviewed | Duplicate-identity heuristics; ExternalIdentifier conflicts | Unlink claim; MergeRecord reversal; affected achievements re-derived |
| T-4 | **Wallet hijacking** | HIGH | AS-10, AS-7, AS-6 | Phisher | Steals an athlete's wallet, then redirects trophies or payouts | Wallet is not identity; payouts require an account-level step-up (MFA) plus a cooling-off period after a new WalletLink; trophies bind to achievements (reissue possible); non-custodial | New-link alerts to all verified channels; unusual payout destination change | Unlink; credential revoke-and-reissue to the new wallet (soulbound class); payout hold |
| T-5 | **Compromised referee / official key** | HIGH | AS-2 | External attacker | Signs false attestations with a stolen passkey or wallet | Scoped, short-lived grants; UV-required passkeys; expiry windows on statements; officials' grants are event-scoped | Unusual signing volume or scope; attestations outside the event schedule | `COMPROMISED` with t₀ ⇒ attestations SUSPECT ⇒ re-verification ⇒ suspensions (BRT-01 §4.2) |
| T-6 | **Compromised federation / anchor key** | CRITICAL | AS-3 | Nation-state-level or insider attacker | Issues rogue grants or sanctions at national scope | Anchor-level actions require **M-of-N** signatures by federation-designated keys (anchor policy); grant issuance rate limits; platform governance co-signature for anchor-scope changes | Grant-graph anomaly monitoring; new grants at anchor depth 1 are notified to the governance quorum | Anchor key compromise ⇒ retroactive revocation cascade; mass re-verification (batched); public incident notice |
| T-7 | **Malicious data provider** | HIGH | AS-1, AS-2 | Provider or insider | Feeds false results at scale | Provider grants scoped to leagues or disciplines; provider data alone ≤ policy-defined level; V3/V4 need official or independent sources; raw payload preserved | Cross-source disagreement flags; officials' DENY; statistical anomaly | Grant revoke (retroactive if fraud); SUSPECT cascade |
| T-8 | **Evidence tampering** | HIGH | AS-4 | Uploader, insider | Alters a scoresheet photo or video after the fact | Content-addressed blobs; hash at ingestion; object lock for retention classes; derived evidence is always new with provenance; device signatures for certified sources | Integrity sweeps (re-hash); hash mismatch vs anchored digests | `INTEGRITY_FAILED` assessment ⇒ re-verification; restore from replica |
| T-9 | **Replayed attestation** | MEDIUM | AS-2 | Anyone | Reuses a valid signature for another result or environment | Statement binds subject hash, purpose, audience, nonce, `expiresAt`; unique `(issuer, nonce)` and `statementHash` | Rejected-replay metrics | n/a (prevented) |
| T-10 | **Duplicate payout** | CRITICAL | AS-6 | Bug, attacker, retry storm | Pays the same entitlement twice (legacy `claimPrize` pattern, BRT-00 C-6) | One live entitlement per slot; one `payout_instruction` per entitlement (UQ); deterministic external idempotency key; settlement contract or PSP deduplication; the PAID state is terminal | Reconciliation job (ledger vs rail); alerts on any second instruction attempt | `ADJUSTMENT_REQUIRED` (BRT-01 disputes §5.5); no automatic clawback |
| T-11 | **Duplicate trophy** | HIGH | AS-7 | Bug, attacker | Mints twice for one achievement, or to two holders | `UQ(trophy_class_id, achievement_id)`; deterministic `credential_id`, so the contract rejects a duplicate id; mint only from an ACTIVE achievement meeting the matrix | Chain-ref reconciliation | Revoke the extra credential; registry is the source of truth |
| T-12 | **Unauthorized grant escalation** | CRITICAL | AS-3 | Organizer, official | Delegates beyond own scope or capability, or grants self more authority | Engine enforces scope narrowing, delegable capabilities, depth limits and grantor authority at issuance **and** at every evaluation (chain re-walk); a self-grant is rejected (grantor ≠ grantee unless governance) | Graph invariants job; alerts on depth or scope anomalies | Revoke; re-verify dependents |
| T-13 | **Database administrator tampering** | CRITICAL | AS-1, AS-2, AS-3 | Privileged insider | Edits ledger rows directly (bypassing the app) | Runtime roles cannot UPDATE or DELETE ledgers; owner role break-glass only, with approvals; hash-chained ledgers; **external anchoring** of Merkle roots; signatures are verifiable independently of the DB | Chain-verification job; anchor mismatch; external verifiers re-checking signatures | Restore from PITR plus anchored proofs; incident disclosure |
| T-14 | **Malicious platform operator** | HIGH | AS-3, AS-9, AS-1 | Insider with operator access | Creates rogue anchors, uses the witness key, forges platform attestations | Anchor creation needs an M-of-N governance quorum; witness key usable only via the MFA-bound flow (IAM separation); operator RBAC cannot sign domain statements; all KMS usage logged to an external, tamper-evident log; PLATFORM anchor can never claim national/world scope | KMS log review; witness statements without a matching user session; periodic external audit | Revoke platform keys and rotate; mark attestations SUSPECT; disclosure |
| T-15 | **Device spoofing** | HIGH | AS-2, AS-4 | Attacker with network access | Impersonates a timing or scoring device | Device keys in secure hardware where possible; DeviceRegistration with hardware attestation; approval bound to `configHash`; mTLS/signature on ingest | Signature failures; config-hash drift; impossible timings | Device key COMPROMISED ⇒ SUSPECT cascade |
| T-16 | **AI evidence manipulation** (deepfake media, adversarial inputs to a CV pipeline) | HIGH | AS-4, AS-1 | Motivated competitor | Submits synthetic video, or manipulates inputs so the AI misreads | E-4: generic `AI_DERIVED` evidence never sole primary evidence at V2+; certified systems require device-signed capture (provenance at source); model and version recorded; human review on flags | Confidence thresholds; provenance gaps (unsigned media); cross-source disagreement | `MANIPULATED` assessment; re-verification |
| T-17 | **Sybil accounts** | MEDIUM | AS-5 | Farmer | Many accounts self-report or cross-corroborate to farm V1 achievements and leaderboards | V1 corroboration must come from a **counterparty in the same contest** (with participant entries created by the organizer), or an official; community boards labelled; rate limits; optional proof-of-personhood for community features | Graph analysis of mutual corroboration clusters | Purge from community boards; account sanctions |
| T-18 | **Webhook / ingestion forgery** | HIGH | AS-1 | Outsider | Forges a provider webhook (legacy Art-Tokenization always-true HMAC, BRT-00 C-8) | Raw-body HMAC; timestamp window; nonce; source principal binding; no "test" endpoints that move state in production | Signature-failure alerts | Reject; rotate secret |
| T-19 | **Client-side privilege abuse** (legacy anon-key writes, BRT-00 C-3) | CRITICAL | AS-1, AS-8 | Anyone | Writes directly to DB tables with a public key | No client DB access to canonical schemas; the API is the only writer; RLS deny-all as defense in depth; publicly exposed PostgREST disabled for canonical schemas | Denied-access audit | n/a |
| T-20 | **PII exfiltration** | HIGH | AS-8 | Outsider, insider | Dumps athlete PII or minors' data | PII vault separation; field encryption for AUTHORITY_ONLY; least-privilege roles; no PII in events, logs or chain; access logging on reads | Anomalous read volume | Key rotation; breach process; crypto-shredding where applicable |
| T-21 | **Dispute abuse / griefing** | MEDIUM | AS-5, AS-6 | Losing party | Floods disputes to hold prizes indefinitely | Standing and admissibility checks; windows; holds only on *admitted* disputes; adjudication SLAs; appeal limits | Dispute rate per filer | Dismissal; sanctions per competition rules |
| T-22 | **Anchoring / chain adapter compromise** | MEDIUM | AS-9 | Attacker | Steals the anchoring hot key | Anchoring key holds gas only; anchors are *additive* (they cannot alter history); settlement keys separate (multisig) | Unexpected transactions | Rotate key; re-anchor |

---

## 4. Highest risks and required controls before the first production use

1. **T-2 / T-12: organizer fraud and grant escalation.** The Authority engine, with its conflict-of-interest and chain re-walk, is a **launch blocker**. Its test suite must include every BRT-00 H-1 variant.
2. **T-10 / T-11: duplicate payout and trophy.** Unique constraints plus deterministic ids plus rail-level deduplication. These must exist **before** any value or credential integration.
3. **T-13 / T-14: insider tampering.** Append-only privileges, hash chains and external anchoring from day one. The anchoring target can be a transparency log before any chain is chosen.
4. **T-19 / T-20: legacy data-exposure patterns.** No client DB access, and a PII vault.
5. **T-6: anchor key compromise.** M-of-N anchor policies must be in place before the first external federation anchor is recognized.

## 5. Legacy findings → controls traceability

| BRT-00 finding | Control in BRT-02 |
|---|---|
| C-1 committed service-role key | Secret manager only; CI secret scanning; no service keys client-side |
| C-2 plaintext keys and mnemonics | Non-custodial rule; column denylist; KMS only for platform keys |
| C-3 world-writable RLS | API-only writes; deny-all RLS; module roles |
| C-4 password disclosure / H-2 default creds | Managed auth provider; no custom password handling; no debug routes in prod builds |
| C-5 / C-6 / C-7 escrow drain, double pay, owner drain | Prize Rail invariants (T-10); settlement multisig; no owner-drain paths (Prize Rail phase) |
| C-8 unauthenticated release endpoints | T-18 controls; no state-moving test endpoints |
| H-1 self-certification | T-2 controls |
| H-10 payment double-credit | Payment-rail events through ingestion with idempotency |
| H-15 mocks presented as production | "Honest status" principle: simulated or test adapters run only in non-production environments. Their statements carry a non-production `audience`, so their signatures are invalid in production. Production builds contain no mock adapters. |
| M-4 PII on-chain | ADR-0009 + CredentialPort accepts only ids and commitments |
| M-10 ignored build errors / `latest` pins | Stack policy ([Implementation stack](../architecture/BRT-02-IMPLEMENTATION-STACK.md)) |
