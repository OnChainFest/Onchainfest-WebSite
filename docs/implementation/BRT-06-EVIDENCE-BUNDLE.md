# BRT-06 — Evidence Bundle (BRT-07 handoff)

| Field | Value |
|---|---|
| New ADR | [ADR-0028](../adr/ADR-0028-deterministic-evidence-bundle.md) |
| Code | `packages/evidence/src/bundle.ts` (pure builder), `packages/persistence/src/evidence-reader.ts` (`loadBundleFacts`, `EvidenceBundleService`) |
| API | `GET /v1/result-versions/:resultVersionId/evidence-bundle?asOf=<RFC 3339>` (COMP_STAFF / INTERNAL) |

## 1. Purpose

The Evidence Bundle is the deterministic, hashable **input set** that BRT-07 will evaluate for one exact ResultVersion. It carries facts and references only — never a verdict, level, score, confidence or authority decision.

```
Evidence Bundle + Authority + Discipline policy + source independence + conflicts + rules → Verification (BRT-07)
```

## 2. Shape (`br:evidence-bundle@1`)

```
{
  asOf,                                         -- transaction-time horizon (input, echoed)
  resultVersion: { resultVersionId, resultId, versionNumber, contentHash, contentSchema,
                   scope: { scopeType, scopeTargetId, competitionId?, eventId?, roundId?, contestId?, sport?, discipline?, region? } },
  evidence: [ {                                 -- set sorted by evidenceId
      evidenceId, evidenceType, descriptorHash, contentHash, byteLength, mediaType,
      source: { kind, principalId?, principalType?, capturedAt?, capturedAtAssurance },
      derivation?: { generatorKind, systemId, version, configurationHash? },
      receivedAt, recordedAt,
      availability: { status, since },          -- as of asOf
      privacyClass,                             -- as of asOf
      inclusion: [ATTACHED | CITED | LINEAGE],  -- why it is in the bundle
      attachments?: [ { attachmentId, targetType, targetId, role, recordedAt } ] } ],
  attestations: [ {                             -- set sorted by attestationId; subject = this version
      attestationId, statementHash, issuer: { principalId, principalType, keyId },
      claim, subjectHash, authorityContext?, proof: { proofType, proofScheme, algorithm, assurance, verifierId, proofHash },
      signedAt, expiresAt, issuedAt, recordedAt, evidenceRefs?,
      supersedesAttestationId?, supersededBy?, retraction?: { retractionId, statementHash, keyId, proofHash, reasonCode, issuedAt, recordedAt } } ],
  keys: [ { keyId, principalId, factHash, verificationMaterialHash, keyKind, algorithm, effectiveFrom, effectiveTo?,
            statusChanges?: [ { statusChangeId, kind, effectiveFrom, recordedAt, factHash } ] } ],
  lineage: [ { evidenceId, relation, relatedEvidenceId, relatedDescriptorHash } ]
}
bundleHash = SHA-256("BR" ‖ 0x01 ‖ "evidence-bundle" ‖ 0x00 ‖ "br:evidence-bundle@1" ‖ 0x00 ‖ "br-json/1" ‖ 0x00 ‖ JCS(bundle))
```

**Inclusion.** Evidence attached to the exact version (or to its contest/event, as context) + evidence cited by its attestations + their lineage ancestors (bounded depth 32). Attachments to *other* versions of the same Result are never pulled in; attestations are always about this exact version (pinning, BRT-06 §25).

**What BRT-07 can compute from it:** authority at `issuedAt` (issuer principal, declared acting role/scope, hierarchy ids), key admissibility and retroactive compromise (`keys[].statusChanges` with `recordedAt`), E-4 and source independence (`source`, `derivation`, `lineage`), availability-dependent rules (`EVIDENCE_UNAVAILABLE`), conflicts (AFFIRM/DENY), withdrawals and corrections. It must still load authority facts (grants, anchors) itself — they are not evidence.

### 2.1 Cryptographic handoff (BRT-06R)

Proof bytes are not copied into the bundle; they are **identified exactly**:

| Bundle field | Binds | Where BRT-07 finds the bytes |
|---|---|---|
| `attestations[].statementHash` | the exact canonical statement | `attestation.attestation.statement` (re-hash must match) |
| `attestations[].proof.proofHash` | the exact stored proof (SHA-256 of the RFC 7515 App. F detached JWS `protected..signature`) | `attestation.attestation.proof` (also the ledger fact's `proofDigest`) |
| `attestations[].proof.verifierId` | the production verifier that accepted it at `issuedAt` (`jws-detached/v1`) | — |
| `keys[].verificationMaterialHash` / `factHash` | the exact public JWK and key fact | `authority.principal_key` |
| `keys[].statusChanges[]` | revocation / compromise history with `recordedAt` | `authority.principal_key_status_change` |
| `retraction.proofHash` | the exact signed retraction | `attestation.retraction.proof` |

**What proves successful validation:** an `attestation.attestation` row can only exist if the production verifier accepted the proof in the accepting transaction (DB CHECK `verifier_id = 'jws-detached/v1'`, a trigger requiring an `ACCEPTED` consumption of the single-use challenge for the exact statement hash, and the ledger fact). BRT-07 should still **re-verify** from the identified immutable bytes (statement + proof + key material, all hash-bound by the bundle) rather than trust the row alone — re-verification is cheap and makes verification independent of the acceptance path. Key *trust* (compromise "as known now") is BRT-07's evaluation from `keys[].statusChanges`; it never changes the stored facts.

## 3. Determinism and as-of

- **No clock inside:** `asOf` is an input; a future `asOf` is refused (facts could still arrive → not reproducible). Omitted `asOf` = the request's transaction time, echoed in the response.
- **Transaction-time horizon:** only facts with `recordedAt ≤ asOf` are considered (items, attachments, attestations, retractions, availability/privacy changes, keys, key status changes). History is never erased: `asOf = T1` before a retraction and `asOf = T2` after it give different, reproducible hashes; a compromise recorded after T1 does not change the T1 bundle ("as known then") but does change the current one ("as known now").
- **Order independence:** every collection is a BR-JSON set with a declared sort key; the loader fetches a superset in any order and the pure builder filters and sorts (property-tested with shuffled inputs).
- **Stable identifiers only:** ids, codes, hashes, enum values and platform timestamps — never display names or mutable profile data.
- **Rebuild-safe:** the bundle is built from class A facts, not from projections; rebuilding the read models leaves it byte-identical (tested; demo step 31).

`bundleHash` identifies these exact inputs. It is **not** a verification proof, a truth hash or a blockchain proof.

## 4. Access

Bundles contain content/descriptor hashes and principal ids, so they are not public: competition staff with `COMP_VIEW_PRIVATE` on the result's competition, or INTERNAL (operator). PRIVATE-visibility attestations are included (they are verification inputs). Denials return 404 and are audited.
