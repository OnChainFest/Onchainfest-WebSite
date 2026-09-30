# ADR-0041 — Achievement evidenceCommitment and governingAuthority are explicit, pinned content

- **Status:** Proposed
- **Date:** 2026-09-30
- **Origin:** BRT-08R, amended by BRT-08R-F (regional recognition scope) (BRT-01 §8.1 `evidenceCommitment`, `governingAuthority`; AC-4; ADR-0028, ADR-0031, ADR-0033; BRT-03 scope algebra)

## Context

BRT-01 §8.1 defines two Achievement members:

- `evidenceCommitment`: "Merkle root over (basis contentHashes, attestation ids+hashes, evidence hashes)", so downstream systems can prove which evidence and attestation basis supported a recognition;
- `governingAuthority`: the anchor-rooted authority backing the basis. AC-4 uses it: a title may only claim a scope that authority's anchor recognizes.

BRT-08 first mapped `evidenceCommitment` to the pinned VerificationRun `snapshotHash`. That is **not** the same concept. The VerificationSnapshot (`br:verification-snapshot@1`) commits to a much broader document: the policy spec, the resolved hierarchy, authority principals / anchors / grants with their status changes, participation relations, key facts, supported fact kinds and typed V2–V4 facts, besides the evidence and attestations. Its purpose is evaluation identity and freshness, not proof of the evidence basis. A change of an unrelated grant or policy binding changes it, while the evidence basis did not change.

## Decision

1. **evidenceCommitment** = `H("achievement-evidence-commitment", br:achievement-evidence-commitment@1, {basis: [{resultVersionId, contentHash, verificationRunId, evidenceBundleHash, evidenceBundleAsOf}]})`. It is stored in the immutable candidate and as a bound column.
   - `evidenceBundleHash` / `evidenceBundleAsOf` are the pinned run's **BRT-06 Evidence Bundle** (`br:evidence-bundle@1`, ADR-0028) and its cutoff. Both are already persisted on `verification.run` and checked by the Achievement trigger for canonical rows.
   - The Evidence Bundle is exactly the evidence / attestation basis:
     - the ResultVersion content hash;
     - every evidence item (ids, content and descriptor hashes, lineage, availability / privacy at asOf);
     - every attestation about the version (ids, statement hashes, proofs, retraction / supersession);
     - the signing keys needed to validate them.

     It contains no verdict, policy, authority decision or participation.
   - The bundle is rebuilt deterministically from immutable BRT-06 facts at its asOf, so anyone can reproduce the committed document and prove inclusion by presenting it. This is a canonical-document commitment; a Merkle path is an implementation option BRT-01 leaves open.
   - No evidence bytes are copied and no new primitive is introduced.
2. **governingAuthority** = `{recognitionLevel, anchorId, source: CERTIFICATION | SANCTION, anchorFactHash, recognitionScope}`, pinned in the candidate. The decision (`recognitionLevel`, `anchorId`, `source`) is derived **only** from the pinned run's immutable, hash-bound outcome and trace:
   - V3 → the authorized SANCTION decision of the passing COMPETITION_SANCTIONED criterion;
   - V2 → the authorized DECLARE_OFFICIAL / ATTEST_RESULT decision of the passing OFFICIAL_DECLARATION criterion (a platform-only anchor gives PLATFORM);
   - V0 / V1 → none.

   **Region / sport scope (BRT-08R-F).** The persisted trace does **not** record the anchor's region or sport: a `TraceDecision` carries `anchorId` and `anchorLevels` only. Those facts live in the anchor's own BRT-03 fact — class A, append-only `authority.trust_anchor` (`recognition_scope`, `fact_hash` over `br:trust-anchor@1`). The loader reads that row by the pinned `anchorId` (SELECT-only `br_verification_reader`), **recomputes its fact hash**, and requires its recognition levels to equal the trace's `anchorLevels`. Any mismatch or a missing row is `ACHIEVEMENT_INTEGRITY_FAILURE`. The scope is then pinned as `recognitionScope` together with `anchorFactHash`.
   - Anchor **status** (revocation, suspension; a separate table) and grants are never read. The pinned scope is the one the run was decided under, not today's authority state.
   - Because the scope is in the snapshot and candidate, changing the governing region (e.g. CR → PE) changes both hashes.
   - The DB trigger (BR133) re-checks canonical rows: `governing_anchor_fact_hash` and the pinned scope must equal the immutable anchor fact. `br_achievements` gets column-level SELECT on `authority.trust_anchor (id, fact_hash, recognition_scope)` only.

   Today's authority state is never consulted, so later grant or anchor changes cannot rewrite it.
3. **AC-4 enforcement.** A rule may name a recognition scope only through the structural `recognitionClaim {level, region?}`. `level` is REGIONAL, NATIONAL, CONTINENTAL or WORLD; `region` is a set of ISO 3166 codes, the same vocabulary as authority scopes. Constraints:
   - only for TITLE / PLACEMENT, and only with V3+ (BRT-01 §8.2);
   - WORLD has no region; NATIONAL names exactly one country; REGIONAL names exactly one region or subdivision; CONTINENTAL names an explicit country set. Continents are expressed as their country sets, because the canonical vocabulary has no continent tokens;
   - label words must not exceed the claim, and words claiming other standing are always refused. Labels are never parsed for security.

   The engine gate `GOVERNING_RECOGNITION` builds the requested scope `{recognitionLevel: [claim.level], sport, discipline, region: claim.region}` from the claim and the snapshot's sport / discipline. It then applies **the BRT-03 authority containment** (`scopeContains`, `wideningDimensions` from `@br/authority`) against the pinned `recognitionScope`:
   - a region covers its subdivisions ("CR" ⊇ "CR-SJ"), never the reverse;
   - sibling regions never cross, so NATIONAL(PE) does not back NATIONAL(CR);
   - an absent dimension is unconstrained;
   - levels are a set, not a ladder.

   Blockers:
   - an unknown scope → `GOVERNING_RECOGNITION_SCOPE_UNKNOWN` (fail closed);
   - PLATFORM → `RECOGNITION_PLATFORM_CANNOT_BACK_CLAIM`;
   - no pinned decision → `GOVERNING_RECOGNITION_UNAVAILABLE`;
   - uncovered dimensions → `RECOGNITION_{LEVEL,SPORT,DISCIPLINE,REGION}_NOT_COVERED`;
   - a sanction authorized below the claim → `RECOGNITION_BELOW_CLAIMED_SCOPE`.
4. The public DTO exposes the recognition **level, region and sport** and fixed wording only. It never exposes anchor ids, anchor fact hashes, grant ids, principal ids or the grant chain.

## Consequences

The Achievement is self-describing about its evidence basis and naming backing, reproducibly and forever. Costs:

- two more candidate members;
- a scope lookup of one immutable anchor fact per derivation / read, re-hashed;
- the trace itself still does not carry the region. Reconstruction depends on the anchor fact's immutability (BRT-03 class A, `platform.reject_mutation`) and its fact hash, both of which are verified.
