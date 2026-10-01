# BRT-09 — Ratification (consumer only; producer deferred)

ADR: [0045](../adr/ADR-0045-record-set-via-append-only-recognition-linkage.md).

## 1. Producer status

BRT-06 accepts only `RESULT_ACCURATE` / `CONDITIONS_COMPLIANT` claims on `RESULT_VERSION` subjects (`0011_attestations.sql` CHECKs). There is **no canonical RECORD_RATIFIED / REVIEW_COMPLETED producer**. BRT-09 does not extend BRT-06, does not fabricate ratifications and writes nothing into BRT-06 tables. **Deferred upstream dependency: BRT-06R** (record-ratification ceremony on a `RECORD_MARK` subject with the existing signing / replay / evidence / subject-hash protocol).

## 2. What BRT-09 consumes

A typed ratification fact: `{provenance, kind RECORD_RATIFIED | REVIEW_COMPLETED, ref, polarity, status, subject {RECORD_MARK, markId, markHash}, issuer principal + type, keyId, assurance, issuedAt, signedAt?}` with the authority facts (principals, keys, anchors, grants, status changes) and participation facts.

## 3. Rules (RATIFY mode)

- the mark must be PENDING_RATIFICATION; subject id and **hash** must be the exact pending mark (`RATIFICATION_SUBJECT_HASH_MISMATCH` otherwise);
- AFFIRM, ACTIVE, human issuer (PERSON / ORGANIZATION; `RATIFIER_NOT_HUMAN`);
- `RATIFY_RECORD` authorized by the BRT-03 engine over the category's structural scope: sport, discipline, recognition level, region, (COMPETITION) competition; the chain must root in an anchor covering every dimension — NATIONAL(PE) never ratifies NATIONAL(CR); a wrong sport fails; a PLATFORM anchor never covers NATIONAL / WORLD; expired / revoked grants, revoked / compromised keys and conflicted principals fail; unknown participation fails closed (`CONFLICT_CHECK_UNAVAILABLE`);
- V4 categories: CURRENT V4 that counted this category's ratification (`V4_NOT_ESTABLISHED_FOR_CATEGORY`), and never PLATFORM_WITNESSED (`RATIFICATION_ASSURANCE_INSUFFICIENT`) — a ratification alone never bypasses V4;
- PLATFORM: V3, or V2 + REVIEW_COMPLETED when the category opted in (`PLATFORM_REVIEW_REQUIRED_BELOW_V3`); never anywhere else;
- every other gate is re-evaluated at ratification time (status, verification, hold, population, conditions, comparison).

**Standing:** CANONICAL iff the category designates a canonical keeper, the scope is not PLATFORM, the kind is RECORD_RATIFIED and the issuer is that keeper; otherwise RATIFIED. A NATIONAL authority without designation ⇒ RATIFIED at most.

## 4. Persistence

The RATIFIED / CANONICAL entry pins `br:record-ratification@1` (+ hash). Unique indexes: one ratification per mark, one mark per ratification ref — 20 concurrent identical deliveries ⇒ one transition. The normal schema accepts only `CANONICAL_ATTESTATION` provenance naming an existing RECORD_RATIFIED / REVIEW_COMPLETED attestation about the mark (impossible today). No manual toggle, route or method exists.
