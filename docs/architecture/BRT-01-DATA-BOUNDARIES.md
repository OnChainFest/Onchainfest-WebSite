# BRT-01 — Data Boundaries: Privacy, PII and On-chain / Off-chain

| Field | Value |
|---|---|
| Ticket | BRT-01 |
| Status | Proposed — for review |
| Related ADRs | [0006 chain-agnostic core](../adr/ADR-0006-chain-agnostic-domain-core.md), [0009 no PII on-chain](../adr/ADR-0009-no-pii-on-chain.md) |
| Chain choice | **Not decided.** Nothing here depends on Base, XRPL EVM or any specific chain. |

---

## 1. Why this matters: the BRT-00 findings

- **PII on-chain.** `../padelflow/contracts/PadelFlowNFTTrophy.sol` stores `winnerName` and `tournamentName` in contract storage. That puts personal names on an immutable public ledger, where they can never be erased (BRT-00 M-4).
- **Credentials in the application database.** Legacy databases stored wallet private keys and mnemonics (padelflow `player_wallets`, Poker `coinbase_wallet_credentials`).
- **Personal data readable by anyone.** Passport numbers, phone numbers and emergency contacts were readable through `USING (true)` RLS (BRT-00 C-2, C-3), and an HR promo exposed registrant emails through anon SELECT (H-16).
- **Bowling registration data.** The legacy bowling registration collected passport number, nationality, gender, phone, email and emergency contacts (`../padelflow/app/api/register-player/route.ts` L17).
- **What the platform must hold anyway.** A real registration flow still needs much of that data. The data exists; the job is to put it behind the correct boundaries.

## 2. Privacy classes

| Class | Who can read | Where it lives | Examples |
|---|---|---|---|
| **PUBLIC** | Anyone | Off-chain public API; may be mirrored or anchored | Competition, event and round metadata; result content (ids, marks, outcomes); achievement records; verification levels; attestation *metadata* (issuer principal, role, claim type, time); public display name/alias **as chosen by the athlete** |
| **PLATFORM-PRIVATE** | The data subject, the platform (least-privilege services) and, per purpose, the organizer of the athlete's own events | Off-chain, encrypted at rest, row-level access by role | Legal name (when not chosen as display name), email, phone, contact details, full date of birth, emergency contacts, payment references, IP/device logs, wallet ↔ person link (unless the athlete publishes it) |
| **AUTHORITY-ONLY** | Principals with an authority grant covering the purpose (identity check, eligibility, dispute adjudication, anti-doping), plus the platform's compliance function | Off-chain, separately encrypted, access-logged | Identity documents (passport/ID scans and numbers), medical or anti-doping data, guardian consent documents, raw evidence involving minors, disciplinary files, raw evidence marked `AUTHORITY_ONLY` |
| **CRYPTOGRAPHIC-COMMITMENT-ONLY** | Nobody reads the underlying data from the commitment. Anyone can *verify* a disclosed value against it. | The commitment may be public or on-chain; the preimage is held off-chain under one of the classes above | Salted hashes of athlete subject identifiers, evidence hashes, result content hashes, Merkle roots of achievement bases, age-eligibility commitments |

## 3. Personal data rules

| Data | Default class | Rules |
|---|---|---|
| **Legal name** | PLATFORM-PRIVATE | The athlete chooses a public display name; it may be their legal name. For minors the default display is a pseudonymous alias. **Never on-chain.** Never inside result content; results reference `athleteId` only (R-9). |
| **Date of birth** | PLATFORM-PRIVATE; AUTHORITY-ONLY for the document proving it | Age-group eligibility is expressed as an `ELIGIBILITY_CONFIRMED` attestation ("athlete in U18 on the event date"), not by publishing the DOB. A derived **age group label** may be PUBLIC when needed for results in age categories. |
| **Minors** | — | Treated as a stricter regime: guardian consent recorded (AUTHORITY-ONLY) before any public display; public profile **off by default**; alias display; no media evidence containing a minor above PLATFORM-PRIVATE without consent; **no on-chain artefact that references a minor's wallet or identity** unless the guardian opts in after the minor reaches the age threshold. The age threshold is jurisdiction-dependent and is an open question. |
| **Contact info** (email, phone, address) | PLATFORM-PRIVATE | Never in results, attestations or evidence metadata. Organizers see contact data only for their own events' participants and only for event operation. |
| **Identity documents** | AUTHORITY-ONLY | Stored only if strictly needed; otherwise verified and discarded, keeping only the resulting `IDENTITY_CONFIRMED` attestation. Retention limits apply. |
| **Addresses** | PLATFORM-PRIVATE | Needed only for prize fulfilment or tax; purpose-bound. |
| **Raw evidence** | Per item: default PLATFORM-PRIVATE; AUTHORITY-ONLY if it contains minors, documents or medical data; PUBLIC only when the rights holder releases it | Public verifiability comes from `contentHash` + attestations, not from publishing the bytes (E-6). |
| **Wallet addresses** | PLATFORM-PRIVATE link; PUBLIC if the athlete links publicly | A wallet is pseudonymous but linkable. Credential issuance to a wallet is an athlete opt-in. |
| **Gender category** | PUBLIC as the *category* the entry competed in; the athlete's personal gender data is PLATFORM-PRIVATE | Categories are competition constructs; personal attributes are not published. |
| **IP / device / session logs** | PLATFORM-PRIVATE, short retention | Legacy stored these without disclosure (BRT-00 L-5). |

**Erasure versus immutable history.** Result and achievement records are durable history, but they hold only ids, so erasure works in three steps:

1. The person record and the id ↔ person link are deleted, or the athlete is **pseudonymized** to a tombstone alias.
2. The per-athlete **salt** used in any commitment is destroyed (crypto-shredding). Any on-chain commitment then becomes permanently unlinkable to the person.
3. Sporting facts may remain as anonymous history, subject to the legal basis for retention, which is an open question.

## 4. On-chain versus off-chain classification

**Legend:**

- **ON-CHAIN**: authoritative state lives on a ledger.
- **OFF-CHAIN**: platform or database only.
- **OFF-CHAIN + HASH ON-CHAIN**: the data lives off-chain, and a hash, commitment or Merkle root is anchored.
- **EVENT ONLY**: an on-chain event or log is emitted for transparency, with no contract state.
- **NOT YET DECIDED**: deferred to BRT-02 or a later phase.

**Default anchoring pattern.** Periodic **batch anchoring**: a Merkle root over new or changed trust-layer records (result version hashes, attestation hashes, status changes) is posted to the chosen ledger. Individual items are proven by Merkle inclusion. Ledger cost then stays independent of volume, and nothing personal is revealed.

| Domain object | Classification | Rationale |
|---|---|---|
| Sport, Discipline, DisciplineVersion, Metric, FormatTemplate | OFF-CHAIN (+ hash of each published DisciplineVersion) | Reference data. Hashing the version pins the rules a result was validated against. |
| Competition, Event, Round, Contest (schedule, config) | OFF-CHAIN | Operational, high churn |
| Participant / entry | OFF-CHAIN | Contains eligibility and entry attributes; only ids ever surface |
| Team, Lineup | OFF-CHAIN | Lineup is inside result content, and therefore inside its hash |
| ResultVersion content | OFF-CHAIN + HASH ON-CHAIN (batched) | The immutable content hash makes silent mutation detectable |
| Result status transitions | OFF-CHAIN + HASH ON-CHAIN (in the batch) | Makes the lifecycle history tamper-evident |
| EvidenceItem bytes | OFF-CHAIN | Size and privacy (E-5) |
| EvidenceItem metadata | OFF-CHAIN + HASH ON-CHAIN (contentHash included in the batch) | Proves the evidence existed by anchoring time |
| Attestation | OFF-CHAIN + HASH ON-CHAIN (batched); the signature is verifiable off-chain | Signatures are self-verifying; the anchor adds a time bound. Writing individual on-chain attestations (e.g. an attestation-service registry) is **NOT YET DECIDED**. |
| Principal public keys, TrustAnchor, AuthorityGrant | OFF-CHAIN + HASH ON-CHAIN; **NOT YET DECIDED** whether the key and grant registry should itself be ON-CHAIN | An on-chain authority registry would let contracts verify attestation authority trustlessly (needed for the Prize Rail). The trade-off is cost and governance complexity. |
| Grant / key revocations | OFF-CHAIN + HASH ON-CHAIN (priority anchoring, not waiting for the batch) | Revocations must be quickly provable |
| Verification (assessment records) | OFF-CHAIN + HASH ON-CHAIN (batched) | Computed; reproducible from inputs + policy version |
| VerificationPolicy versions | OFF-CHAIN + HASH ON-CHAIN | Pins the rules used |
| Achievement | OFF-CHAIN + HASH ON-CHAIN (the `evidenceCommitment` and status in the batch) | Canonical registry off-chain; tamper-evident |
| Credential / trophy representation of an achievement | ON-CHAIN (token or credential) **when issued**, containing only `achievementId`, `evidenceCommitment`, class and issuer, **no PII**; metadata resolves off-chain | Representation, not source of truth. Soulbound vs transferable is **NOT YET DECIDED** (open question). |
| RecordCategory | OFF-CHAIN | Reference data |
| RecordMark status changes | OFF-CHAIN + HASH ON-CHAIN | |
| Dispute (content) | OFF-CHAIN | May contain personal and sensitive material |
| Dispute opened / resolved | EVENT ONLY or hashed in the batch (**NOT YET DECIDED**) | Transparency that a hold exists, which matters for on-chain prize contracts |
| Correction | OFF-CHAIN + HASH ON-CHAIN | Links old and new version hashes |
| PrizeTerms, PrizeEntitlement, escrowed value | **ON-CHAIN** for escrowed value and settlement state (future Prize Rail); terms hashed | Value custody should not depend on platform honesty. Design is deferred to the Prize Rail phase. |
| Person/Athlete identity, PII | **OFF-CHAIN only** | [ADR-0009](../adr/ADR-0009-no-pii-on-chain.md) |
| Athlete subject identifier in on-chain artefacts | CRYPTOGRAPHIC-COMMITMENT-ONLY (salted hash) or the athlete's chosen wallet (opt-in) | Enables proofs without identifying anyone by default |
| Media / historical archive | OFF-CHAIN (+ hash) | |

## 5. Rules

| ID | Rule |
|---|---|
| DB-1 | No personally identifiable information (names, DOB, contact data, document numbers, faces or voices, precise location traces) is written to any ledger. An exception needs an ADR stating a compelling reason, data-subject consent, and an erasure analysis. |
| DB-2 | On-chain artefacts reference off-chain records by id and hash only. Salted commitments are used wherever an athlete must be referenced. |
| DB-3 | Every read path to PLATFORM-PRIVATE or AUTHORITY-ONLY data is access-logged. Default RLS is deny-all with purpose-specific grants. This is the inverse of the legacy `USING (true)` pattern. |
| DB-4 | No private keys or mnemonics of users are ever stored. Platform service keys (issuer, witness, relayer, anchoring) live in KMS/HSM. The platform can *witness* a human's assertion (`PLATFORM_WITNESSED`) without holding that human's key. |
| DB-5 | Evidence privacy class is set at ingestion and can only be *raised* (made more restrictive) without the rights holder's action. |
| DB-6 | Organizer access to participant PII is scoped to their own competitions and to operational purposes, with retention limits after the competition closes. |

## 6. Chain-agnosticism

The domain requires only four capabilities from any ledger:

1. Post a 32-byte digest with a timestamp (anchoring).
2. Verify common signature schemes, or accept verified proofs (for Prize Rail settlement).
3. Hold escrowed value with programmable release (Prize Rail).
4. Represent credentials/tokens (Trophy House).

- **Candidates.** Base and XRPL EVM (both named in BRT-00 legacy configurations) satisfy these, as would others.
- **Deferred decision.** The chain decision belongs to BRT-02 or a later phase and is recorded in its own ADR.
- **Domain ids are chain-independent.** A chain address or token id is an *external reference* attached to a domain object, never its identity.
