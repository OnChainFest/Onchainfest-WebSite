# BRT-10 — Classifications (derived ResultVersions)

Status: engine implemented (Step 3); ledger submission implemented (Step 6); computed staleness, correction impact and `ClassificationStale` implemented (Step 7); the worker that calls the emitter (`rankings.react`) implemented (Step 10). Decision record: [ADR-0047](../adr/ADR-0047-classifications-are-derived-result-versions-submitted-through-the-ledger.md); ordering: [ADR-0049](../adr/ADR-0049-explicit-comparator-aggregation-and-shared-ties.md).

## 1. What a classification is

A classification is a ResultVersion of a Result with scope `ROUND_CLASSIFICATION`, `EVENT_CLASSIFICATION` or `COMPETITION_CLASSIFICATION`. Its content is `br:result-version-content@2`: `@1` plus `derivation`, which carries:

- `derivedFrom[]` (`{resultVersionId, contentHash, status}`);
- `policy` (`{policyId, policyVersionId, specHash}`);
- `disciplineVersionId`, `engineVersion` and `inputsDigest`.

A classification answers: what was ranked, under which policy and comparator, from which exact inputs, and with which hash.

Each entry is `{participantId, outcome: RANKED, rank, tied, tieBreakKeys}`. No `primaryMark` is written, because an aggregated or points value is not a canonical Performance Mark. No source Result content is copied.

## 2. ClassificationPolicy

`br:classification-policy@1` is versioned and immutable. It declares:

- the scope it applies to;
- the input minimum status (floor PROVISIONAL);
- per comparator key: `metric` (the DV key), `markMetricId` (the canonical `Mark.metricId` the key is recorded under), order, source (`ENTRY_PRIMARY_MARK | PERFORMANCE`) and aggregation (`SUM | MAX | MIN`);
- for `HEAD_TO_HEAD_WINNER` disciplines, the points per outcome.

`markMetricId` was added in Step 3. The DisciplineVersion declares metric keys but no `Mark.metricId` mapping, so the policy declares it, just as ranking universes, record categories and achievement rules already do (`{key, markMetricId}`).

## 3. Engine (`deriveClassification`, Step 3)

The input `br:classification-derivation-input@1` contains:

- the policy (embedded spec + hash);
- the pinned DisciplineVersion (id, catalog spec hash, metrics, comparator);
- the scope (`scopeType`, `scopeId`, the `contestIds` the hierarchy resolves into it);
- the current version of each input Result, with its exact `@1` content.

The engine runs these steps:

1. **Definition.** The policy re-validates and re-hashes to `specHash` (`SPEC_HASH_MISMATCH`). It must be coherent with the pinned DV (`classificationPolicyDisciplineIssues`: `DISCIPLINE_VERSION_MISMATCH`, `COMPARATOR_MISMATCH`, `METRIC_UNKNOWN`) and with the scope type (`RESULT_SCOPE_MISMATCH`). An `ORDINAL` key gives `POLICY_UNSUPPORTED` plus the validator's `COMPARATOR_UNDEFINED`. `AVERAGE` cannot be represented, so it is refused before sealing as `POLICY_UNSUPPORTED`.
2. **Inputs.** Each input must be a CONTEST version of a contest in scope, not superseded, revoked or rejected, at or above the policy minimum, and its content must re-hash to its pin (`CONTENT_HASH_MISMATCH`). An excluded input carries its reasons plus `CLASSIFICATION_INPUT_INADMISSIBLE`. Two admissible versions of one contest are both excluded; neither is chosen. A contest in scope with no admitted input gives `CLASSIFICATION_INPUT_MISSING`. Any blocker blocks the whole derivation. There are no partial tables.
3. **Values.** Participants are the entries of the admitted inputs. For each key, every contest a participant appears in must give at least one value from the declared source (`COMPARATOR_INPUT_MISSING` otherwise, never 0 or worst). For `PERFORMANCE`, the values are the participant's valid performances with the key's `markMetricId`. For `ENTRY_PRIMARY_MARK`, a primary mark of another metric gives `METRIC_MISMATCH`. Unit and precision must match the DV `MetricSpec` (`METRIC_UNIT_MISMATCH`, `METRIC_PRECISION_MISMATCH`). One key has one precision across the table (otherwise `METRIC_PRECISION_MISMATCH`), so no value is ever re-scaled.
4. **Aggregation.** `SUM` is exact decimal addition at the shared precision. `MAX` / `MIN` are the numerically largest / smallest value (exact comparison); the key's order then decides which is better. Nothing divides, so nothing rounds. Because every appearance must supply a value, ADR-0049 §4's "SUM over zero inputs" case cannot arise. For `HEAD_TO_HEAD_WINNER`, the leading trace item is `{key: 'outcomePoints', order: HIGHER_IS_BETTER, value: SUM of declared points}`. An encountered outcome with no declared points gives `POLICY_UNSUPPORTED`. The policy may declare a subset of outcomes.
5. **Ordering.** Ordering is lexicographic over the trace in declared order. Participants equal on every key share a competition-style rank (1, 1, 3), asserted with `checkSharedRanks`.

The outcome accounts for every input (`ADMITTED | EXCLUDED` + reasons), every missing contest and every blocked participant. A `PROPOSED` outcome carries the `@2` content and its hash.

**Tie-break trace.** Each trace item is `{key, order, value}` (BRT-01 §6.2 `tieBreakKeys`). It is explanatory provenance, not a metric. Outcome points are policy-derived, not sporting Marks, so they are never encoded as a `Mark`, and no platform metric id is reserved for them. `outcomePoints` is a trace key only, and its meaning is positional: it is the first item iff the policy's `primary` is `HEAD_TO_HEAD_WINNER`.

## 4. Submission path (implemented, Step 6)

1. **Propose (read-only).** `ResultLedger.proposeClassification(resultId)` re-assembles the canonical input (`classification-loader.ts`) and runs `deriveClassification`. It writes nothing. A later COMP_STAFF read endpoint (Step 11) exposes it.
2. **Draft.** The content schema of a draft is `@2` iff the content carries `derivation` (the `@1` schema is closed, so `derivation` can never be `@1`). `@1` drafts are hashed and validated exactly as before. Malformed `@2` content is refused by the closed schema before a draft exists.
3. **T2 (`submitDraft`).** A principal holding `SUBMIT_RESULT` for the classification's scope submits the draft. The existing checks run unchanged: hierarchy scope match, authority, idempotency, stream serialization, content dedupe. For `@2` content the ledger then, in the same transaction:
   - refuses `@2` on a non-classification Result (`INVALID_INPUT`, reason `NOT_A_CLASSIFICATION_RESULT`; BR162 also refuses it in the database);
   - re-assembles the canonical input and re-runs the engine. Any failure is `CLASSIFICATION_DERIVATION_MISMATCH` with a reason: `POLICY_UNAVAILABLE`, `CLASSIFICATION_POLICY_AMBIGUOUS`, `DISCIPLINE_VERSION_MISMATCH`, `CLASSIFICATION_INPUT_MISSING`, `DERIVATION_BLOCKED` (+ the engine blockers) or `CONTENT_MISMATCH` (+ the canonical content hash). Ranks, ties, trace values, pins, policy and hash must be byte-equal to the canonical proposal: a caller-provided rank table is never trusted;
   - refuses replacement of a current classification (`CURRENT_VERSION_CONFLICT`, reason `CLASSIFICATION_REPLACEMENT_REQUIRES_CORRECTION`). Identical content is handled earlier as a duplicate;
   - inserts the `@2` ResultVersion (`content_schema = br:result-version-content@2`) and, in the same transaction, `results.classification_derivation` plus one `results.classification_input` per `derivedFrom` pin. BR163–BR168 bind both to the hashed content and to the live input versions.
4. **T3** acceptance requires `ACCEPT_RESULT`, unchanged. There is no automatic acceptance.

There is no other write path. The writer never inserts a ResultVersion directly.

### 4.1 Canonical input assembly and policy binding

`assembleClassificationInput` runs under `br_results` (read-only on what it loads):

- **Scope.** The classification Result's round / event / competition and **every** contest the explicit hierarchy resolves into it (ADR-0025). No contest is filtered by status. A contest without a current result blocks the derivation (`CLASSIFICATION_INPUT_MISSING`).
- **DisciplineVersion.** The single DisciplineVersion of the scope's events. A competition whose events use different DisciplineVersions fails closed (`DISCIPLINE_VERSION_MISMATCH`); events are never silently filtered. This definition check runs before the input check.
- **Policy (unique-or-fail).** The single PUBLISHED, not-RETIRED ClassificationPolicy version for (scope type, that exact DisciplineVersion). None ⇒ `POLICY_UNAVAILABLE`; more than one ⇒ `CLASSIFICATION_POLICY_AMBIGUOUS`. There is no precedence rule, no "latest" and no submitter choice. Retiring the extra version restores a unique binding. No binding table is needed: (scope type, DisciplineVersion) is already structural on `classification_policy_version`.
- **Inputs.** For each contest Result, every version whose latest append-only status is PROVISIONAL / OFFICIAL / FINAL (never read from a projection), with its exact `@1` content and hash. The engine re-hashes each and re-checks admissibility.

The persisted derivation proves the chain **scope → policy version → policy spec hash → DisciplineVersion → exact input ResultVersions → exact input content hashes → derived content → content hash**. `inputs_digest` is the hash of the full canonical input: scope + contest ids, policy spec, DisciplineVersion id + catalog spec hash, and every input with its content.

### 4.2 Idempotency and events

- The same draft + idempotency key replays the stored response. A new draft with identical content resolves to the existing version (`created: false`). Concurrent identical submissions serialize on the Result's ledger stream and produce one version.
- `ResultSubmitted` (outbox) carries `contentSchema` and `classification: {policyVersionId, inputsDigest, inputCount}` for `@2` versions. A refused submission leaves no version, derivation, input row or event.

Tests: `packages/persistence/src/rankings-writer.int.test.ts` ("classification @2 through the ResultLedger").

## 5. Staleness and replacement

- Staleness is computed, never stored. No `isStale` member exists anywhere. A version is stale when a pinned input is no longer current, or when the admissible input set (under its **pinned** policy) changed; an unknown state counts as stale. `ClassificationStale` is emitted at most once per (version, staleDigest). Details: [history and corrections §2](./BRT-10-HISTORY-AND-CORRECTIONS.md#2-classification-staleness) (Step 7).
- Step 3 exposes the dependencies:
  - `classificationDependencies(content)` returns the exact `derivation`. `@1` content gives `CLASSIFICATION_PROVENANCE_UNAVAILABLE`.
  - `classificationCorrectionImpact(derivation, current)` lists the pins that are no longer current. Unknown currency counts as affected. Since Step 7: one entry per pin, ordered by `resultVersionId`, whatever the input order. A repeated or malformed `derivedFrom` makes `classificationDependencies` return `CLASSIFICATION_PROVENANCE_UNAVAILABLE` (the set is key-unique; provenance is never partially read).
- Replacing a current (accepted) classification requires a T7 correction, which has no producer. `assessClassificationReplacement(newHash, current)` therefore returns `REPLACEMENT_BLOCKED` with `CLASSIFICATION_REPLACEMENT_REQUIRES_CORRECTION`. It returns `IDENTICAL_TO_CURRENT` when nothing changed. The re-derived proposal is a new derived content with intact `derivedFrom`. The old version is never mutated.

## 5.1 Read model (Step 8)

`ranking_read.classification_card` / `classification_entry` project each derived (`@2`) version: the derivation header, the sorted pinned input ids, the content hash, and the version's latest append-only status. Ranks, ties and the trace are copied byte for byte from the immutable content and are never re-ranked. The ResultLedger refreshes them in its own transaction (T2 and every transition). They are rebuildable by `br_rebuild`, readable by `br_public_read`, and carry no staleness. See [development § read models](./BRT-10-DEVELOPMENT.md#read-models-step-8).

## 6. Team / individual

Holder type follows the Event's `entrant_kind`. Team classifications rank the TEAM participant. Member credit stays with BRT-08 lineup rules (ADR-0039).

## 7. Not progression

A classification never writes `advancement`, resolves `WINNER_OF` / `RANK_FROM_STAGE` slots, or seeds rounds (ADR-0008, ADR-0024).
