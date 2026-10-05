# BRT-07 — Verification Model (V0–V4, as implemented)

| Field | Value |
|---|---|
| Ticket | BRT-07 — Verification Engine / Sports Oracle |
| Implements | BRT-01 [verification model §5–6](../domain/BRT-01-VERIFICATION-MODEL.md), [disputes §1.3, §4](../domain/BRT-01-DISPUTES-AND-CORRECTIONS.md); BRT-02 [verification engine](../architecture/BRT-02-VERIFICATION-ENGINE.md); ADR-0002, ADR-0005 |
| New ADRs | [0031](../adr/ADR-0031-verification-is-an-immutable-assessment.md) · [0032](../adr/ADR-0032-declarative-verification-policies-bound-to-discipline-versions.md) · [0033](../adr/ADR-0033-deterministic-verification-snapshot-and-hash-freshness.md) · [0034](../adr/ADR-0034-conservative-independence-and-structural-participation.md) · [0035](../adr/ADR-0035-unsupported-canonical-facts-and-unpersisted-fixtures.md) · [0036](../adr/ADR-0036-counterparty-deny-outranked-only-by-certification.md) |
| Code | `packages/domain/src/verification.ts` (vocabulary), `packages/verification` (pure engine), `packages/persistence/src/verification-*.ts`, `db/migrations/0013–0015` |

Companion documents: [policy](./BRT-07-VERIFICATION-POLICY.md) · [sports oracle](./BRT-07-SPORTS-ORACLE.md) · [authority evaluation](./BRT-07-AUTHORITY-EVALUATION.md) · [independence & conflicts](./BRT-07-INDEPENDENCE-AND-CONFLICTS.md) · [development](./BRT-07-DEVELOPMENT.md) · [threat review](../security/BRT-07-VERIFICATION-THREAT-REVIEW.md).

---

## 1. What the Oracle answers

> Given this exact ResultVersion, this exact evidence / attestation state, this exact authority state, this exact participation / conflict state and this exact published policy version, which verification level does the result satisfy?

It is **facts + policy + deterministic evaluation = assessment**. There is no probability, confidence, trust score, weight or "likely true" anywhere — in types, schemas, DTOs, tables or traces (enforced by `tooling/check-no-manual-verification.mjs`, schema closure and tests).

| Kept separate | How |
|---|---|
| Result ≠ Verification; ResultStatus ≠ VerificationLevel | No `verified` / `verification_level` column exists (guard); verification reads status and never transitions a Result (tests + demo steps 21–22) |
| VerificationLevel ≠ RecognitionLevel | Disjoint string values (`V0…V4` vs `CLUB…PLATFORM`); compile-time guard `VERIFICATION_LEVEL_IS_NOT_RECOGNITION_LEVEL`; separate ordering functions |
| Evidence / Attestation / signature validity ≠ key trust ≠ authority ≠ level | Proofs are re-verified by the assembler; key trust and BRT-03 authority are separate evaluations inside the engine; a level exists only in an outcome |
| Level ≠ record / ranking / prize / trophy | Verification emits no consequence events and creates no consequence rows |
| Freshness ≠ level; evaluation state ≠ level | `VerificationFreshness` and `EvaluationState` are separate enums |

## 2. Types

- **`VerificationLevel`** — exactly `V0 CLAIMED`, `V1 CORROBORATED`, `V2 EVENT_CERTIFIED`, `V3 SANCTIONED`, `V4 RATIFIED`. There is **no `NO_LEVEL`**.
- **`EvaluationState`** (outside the level): `EVALUATED` (V0 holds; the highest satisfied level is reported), `INSUFFICIENT_INPUT` (V0's claim prerequisites cannot be established — `highestSatisfiedLevel` is absent), and the service-level states `POLICY_UNAVAILABLE` (no published policy bound to the exact DisciplineVersion — fail closed, no fallback) and `NOT_EVALUATED` (no run yet).
- **Integrity failures are not states.** A stored fact that contradicts its hash or signature raises `VERIFICATION_INTEGRITY_FAILURE` (HTTP 500) and produces no run. A cutoff that predates already-recorded facts raises `VERIFICATION_TIME_INCONSISTENT` (HTTP 503).
- **Criterion status**: `PASS`, `FAIL`, `INSUFFICIENT`, `UNKNOWN`, `INPUT_NOT_SUPPORTED`, `NOT_APPLICABLE`. Only `PASS` passes. `UNKNOWN` never passes a criterion that needs certainty.

## 3. Exact level semantics

Levels are cumulative: a level is **SATISFIED** only if all of its criteria PASS **and** the level below is SATISFIED in the same evaluation. The first unsatisfied level is **BLOCKED**; higher levels are **NOT_REACHED** (their criteria are still evaluated and traced). Levels a policy does not define are **NOT_DEFINED**.

### V0 — CLAIMED (`CLAIM_BOUND`)

A structurally valid, hash-bound, submitted claim: the snapshot's ResultVersion content hash was re-derived from the stored content (integrity), and the submitting principal is known in the authority facts at the cutoff. Nothing else. **Lifecycle status is orthogonal**: SUBMITTED, PROVISIONAL, OFFICIAL, FINAL, REJECTED, SUPERSEDED and REVOKED versions are evaluated identically (a FINAL result with consistent facts is at least V0; a REJECTED one may still be V1 — consumers combine status and level through the BRT-01 §7 permission matrix, never through the level alone). If V0 cannot be established the state is `INSUFFICIENT_INPUT` with no level. With real data this cannot happen short of an integrity failure (foreign keys guarantee the submitter), so it is exercised by engine fixtures.

### V1 — CORROBORATED (`INDEPENDENT_CORROBORATION`, `NO_COUNTERPARTY_DENY`)

- **≥ N independent issuers** (policy `minIssuers`, floor 1) of an active, key-trusted `RESULT_ACCURATE` / `AFFIRM` about this exact version. Independence is **principal-based** ([independence](./BRT-07-INDEPENDENCE-AND-CONFLICTS.md)): all keys and all attestations of one principal are one issuer group. A group counts when its principal is:
  - a **counterparty** — structurally on a participant side that is not the submitter's (requires the submitter's side to be known), or
  - a **registered official**: on no side, with no prohibited relation (conflict check CLEAR), and holding a `REGISTERED_OFFICIAL` fact. That fact is a **structural** registration covering the competition, event or contest, with an interval containing the attestation's `issuedAt`.
  - BRT-01 sets V1's authority requirement to **none**. The criterion consults no AuthorityGrant. An `ATTEST_RESULT` grant is sporting authority, used at V2, and never makes a principal a registered official.
  - **Producer gap:** the repository has no producer of registered-official facts (no official registry, by design). Production snapshots therefore do not support `REGISTERED_OFFICIAL`. The criterion reports `NOT_SUPPORTED_REGISTERED_OFFICIAL`, and such issuers are classified `NO_STANDING`. Counterparty corroboration is unaffected and keeps V1 reachable. The registered-official path is proven with reference fixtures and a vector.
  - The submitter never corroborates itself. These never count either: principals on the submitter's side, unaffiliated third parties (organizer admins, staff, a FEDERATION-typed organization, holders of an ATTEST_RESULT grant), and unresolved or temporally undetermined principals.
- **No unresolved counterparty DENY.** An active, key-trusted `RESULT_ACCURATE` / `DENY` blocks V1 when it comes from a participant-side principal or from the submitter. An unresolved denier fails closed.
  - **Exception (BRT-01 §5.3, [ADR-0036](../adr/ADR-0036-counterparty-deny-outranked-only-by-certification.md), Accepted):** the deny no longer blocks when the same evaluation fully meets the V2 certification exception, meaning `OFFICIAL_DECLARATION` = PASS **and** `NO_AUTHORIZED_DENY` = PASS. This keeps V2 ⇒ V1 ⇒ V0.
  - The trace is explicit. When the exception applies it shows `COUNTERPARTY_DENY_PRESENT`, `COUNTERPARTY_DENY_OUTRANKED_BY_CERTIFICATION`, `V2_OFFICIAL_DECLARATION_PASSED` and `V2_NO_AUTHORIZED_DENY_PASSED`. Otherwise it shows `COUNTERPARTY_DENY` and `V2_CERTIFICATION_EXCEPTION_NOT_MET`.
  - An authorized official DENY is never outranked.
- Classifications (non-CONTEST scopes) carry a structural criterion `DERIVED_INPUT_LEVELS` at V1+: the BRT-03 content has no `derivedFrom`, so it is `INPUT_NOT_SUPPORTED` and classifications cannot pass V1 today (BRT-01 R-6).

### V2 — EVENT_CERTIFIED

| Criterion | Exact rule |
|---|---|
| `PRIMARY_EVIDENCE` | ≥ `minItems` evidence items attached to **this exact version** with role `PRIMARY`, of a type the event's pinned DisciplineVersion lists in `evidenceExpectations`, with availability in the policy set (default `AVAILABLE`/`ARCHIVED`), not invalidated. **E-4 (non-bypassable): if every counted item is generic machine-derived** (`AI_DERIVED` type, `AI_PIPELINE` source, AI/OCR generator) **the criterion fails** (`AI_ONLY_EVIDENCE`). |
| `PRIMARY_EVIDENCE_INTEGRITY` | Every counted item's descriptor and content hash were re-verified by the assembler (source signatures do not exist in BRT-06 → `SOURCE_SIGNATURE_NOT_APPLICABLE`). |
| `NO_INVALIDATING_ASSESSMENT` | No `INTEGRITY_FAILED` / `MANIPULATED` / `WRONG_SUBJECT` assessment on primary evidence. **No EvidenceAssessment producer exists**, so absence cannot be distinguished from "unassessable": `INPUT_NOT_SUPPORTED` (fail closed). |
| `OFFICIAL_DECLARATION` | Path A: an active `RESULT_OFFICIAL` / AFFIRM whose issuer is authorized for `DECLARE_OFFICIAL` or `ATTEST_RESULT` (policy may narrow). Path B: an active `RESULT_ACCURATE` / AFFIRM by such an authorized issuer **and** a T5 (PROVISIONAL → OFFICIAL) record whose actor is authorized for `DECLARE_OFFICIAL`. **Never** simplified to "RESULT_ACCURATE + ATTEST_RESULT". Neither `RESULT_OFFICIAL` nor T5 has a producer → `INPUT_NOT_SUPPORTED`. |
| `NO_AUTHORIZED_DENY` | No active DENY by a non-participant authorized for `ATTEST_RESULT`/`DECLARE_OFFICIAL`. Precedence ("equal or higher") is not modelled, so **any** authorized DENY blocks (conservative); a denier whose conflict status is unknown → `UNKNOWN`. |

### V3 — SANCTIONED

| Criterion | Exact rule |
|---|---|
| `COMPETITION_SANCTIONED` | An active `COMPETITION_SANCTIONED` / AFFIRM on this competition or event, whose issuer is authorized for `SANCTION` at the recognition level the sanction declares, which must be ≥ `minRecognitionLevel` (floor REGIONAL) and never PLATFORM (`RECOGNITION_PLATFORM_CEILING`). An authorized sanction DENY blocks. |
| `CERTIFICATION_ROOTED_IN_SANCTION` | The V2 certifying authority (path A declarer or path B T5 actor) is authorized at a recognition level ≥ the sanction's (non-platform), or roots in the same anchor. A PLATFORM-rooted certification never satisfies it. |
| `OFFICIAL_EVIDENCE_SET` | Every type of the discipline's official evidence set is present (PRIMARY/SUPPORTING, available, not invalidated). |
| `IDENTITY_CONFIRMED` | Every athlete of every participant named by the version's entries has an active `IDENTITY_CONFIRMED` by an issuer authorized for `ATTEST_IDENTITY`; incomplete participation → `UNKNOWN`. |

### V4 — RATIFIED

| Criterion | Exact rule |
|---|---|
| `CONDITIONS_COMPLIANT` | Needs the record category (its required condition aspects). Every required aspect is covered by an active `CONDITIONS_COMPLIANT` / AFFIRM from a non-participant authorized for `ATTEST_CONDITIONS`; an authorized conditions DENY blocks. (`CONDITIONS_COMPLIANT` attestations **are** producible today; the record category is not → `INPUT_NOT_SUPPORTED`.) |
| `INDEPENDENT_PRIMARY_SOURCES` | ≥ `minSources` (floor 2) independent sources among counted primary evidence: lineage roots, identified by the root's stable source principal (principals on one participant side collapse to that side); unknown provenance and generic machine derivation never add a source. |
| `NON_WITNESSED_SIGNATURES` | Every signed fact supporting a passing V1–V4 criterion is `HOLDER_KEY` or `DEVICE_KEY` — never `PLATFORM_WITNESSED`. |
| `RECORD_RATIFIED` | An active `RECORD_RATIFIED` or `REVIEW_COMPLETED` for the record category by a **human** principal (PERSON/ORGANIZATION) authorized for `RATIFY_RECORD` at the category's recognition level. A PLATFORM review panel can ratify only PLATFORM-scope categories (anchor rules). No generic "Result ratification": without a record category there is nothing to ratify. |

## 4. Real production ceiling (today)

Using only facts today's canonical producers create (BRT-06 `RESULT_ACCURATE` and `CONDITIONS_COMPLIANT` attestations, evidence, grants, anchors, keys, participation):

| Level | Reachable with real data? | Why |
|---|---|---|
| V0 | **Yes** | Every submitted version |
| V1 | **Yes** | Counterparty corroboration (with a mapped submitter; real, time-sliced participation index), proven by integration tests and the demo. The registered-official path is unavailable (no producer), and ATTEST_RESULT grants never substitute for it. The dev seed's version is submitted by an unmapped referee, so it honestly stays V0. |
| V2 | **No** | `OFFICIAL_DECLARATION` and `NO_INVALIDATING_ASSESSMENT` → `INPUT_NOT_SUPPORTED`. Primary evidence, integrity and no-authorized-deny *can* pass on real data (demo step 19 shows exactly these two blockers). |
| V3 | **No** | V2 blocked; no sanction, identity or official-evidence-set producer |
| V4 | **No** | V3 blocked; no record category or ratification producer |

This is architecturally correct: "complete" means the evaluator implements the accepted semantics, not that every level is reachable by today's data.

## 5. Future canonical producers (not designed in BRT-07)

The engine consumes these when they exist; BRT-07 neither owns nor designs their storage or APIs:

| Canonical fact | Unblocks |
|---|---|
| Registered-official registration (`REGISTERED_OFFICIAL`: principal, competition/event/contest subject, interval) — a structural fact, **not** an AuthorityGrant | V1 registered-official path |
| `RESULT_OFFICIAL` attestation | V2 path A |
| T5 PROVISIONAL → OFFICIAL transition (with authority proof) | V2 path B |
| `EvidenceAssessment` | V2 `NO_INVALIDATING_ASSESSMENT` |
| `COMPETITION_SANCTIONED` attestation (competition/event subject + recognition level) | V3 |
| `IDENTITY_CONFIRMED` attestation (athlete subject) | V3 |
| Discipline official evidence-set declaration | V3 |
| Record category (recognition level + required condition aspects) | V4 |
| `RECORD_RATIFIED` / `REVIEW_COMPLETED` attestations | V4 |
| Classification `derivedFrom` input levels | V1+ for classifications |
| Certified machine evidence (§2.6: device keys, approved configuration) | Optional machine paths |

Each arrives as a new `CanonicalFactKind` in the production assembler's `supportedFactKinds` (a new assembler version) — never by weakening a criterion.

## 6. Freshness, history and as-of

- **Runs are immutable.** A later run may carry another level; no run is rewritten. The outcome and trace documents the run was produced with are stored and re-hashed on read; history is never re-rendered with newer engine code.
- **Freshness is hash-based** (`CURRENT` / `STALE` / `NOT_EVALUATED`): the current snapshot is assembled from current facts and its hash compared with the latest run's; a policy-binding change or an engine-version change also makes the latest run STALE. STALE ≠ FAILED; a stale level is never presented as current (only `lastEvaluated`).
- **Historical as-of** (`verification-replays`): cutoff T ≤ now; facts recorded after T are invisible (later retractions, compromises, grants). Never persisted; the response names the persisted run with the same identity, if any. Current evaluations see every retroactive compromise known now.
- **Clock safety**: no clamping. See [sports oracle §6](./BRT-07-SPORTS-ORACLE.md#6-time-and-the-clock).
