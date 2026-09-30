# BRT-08 — Derivation Engine (snapshot → pure engine → candidate → immutable Achievement)

| Field | Value |
|---|---|
| ADRs | [0039](../adr/ADR-0039-achievement-basis-pins-exact-current-verification.md), [0037](../adr/ADR-0037-reference-achievement-persistence-fixtures-in-throwaway-databases.md) |
| Code | `packages/achievements/src/{snapshot,engine,marks,support,public,fixtures}.ts`, `packages/persistence/src/achievement-{loader,store,projection}.ts` |

## 1. Pipeline

```
canonical facts                         ResultVersion (content re-hashed) · status from transitions · supersession ·
   │                                    participants · contest occurrence · BRT-07 run + hash-based freshness
   │  loadVersionFacts / applicableRules / verificationSummary      br_achievements, REPEATABLE READ, one cutoff
   │  (freshness under br_verification in the SAME transaction — withModuleRole, read-only use)
   ▼
AchievementDerivationSnapshot (br:achievement-derivation-snapshot@1, provenance CANONICAL_ASSEMBLY)
   │  deriveAchievements(snapshot)      pure: no DB, network, fs, clock, randomness, env; never re-verifies
   ▼
DerivationOutcome (br:achievement-derivation-outcome@1): gates · per-subject sporting evaluation · candidates
   │  insertDerived — re-derives, validates every basis element, natural identity, DB trigger checks upstream facts
   ▼
achievement.achievement + basis_item + member_credit + status_entry (ACTIVE) + ledger (ACHIEVEMENT stream) + outbox
```

The service accepts only an exact ResultVersion id. No API accepts a snapshot, candidate, holder, type, qualifying value, level, force flag or override.

## 2. Snapshot

Members:

- `provenance` and `assembler`;
- the exact `rule`: ids, code, version, spec, spec hash, binding;
- `supportedFactKinds`: production supports `RESULT_STATUS`, `VERIFICATION` and `CONTEST_OCCURRENCE`, **not** `HOLD_STATE` or `CREDITED_LINEUP`;
- the DisciplineVersion metric set, with value type, unit and comparator order;
- the hierarchy ids;
- the exact ResultVersion: id, content hash, scope, submittedAt, status, supersedes / supersededBy;
- the BRT-07 `verification` summary: state CURRENT / STALE / NOT_EVALUATED / POLICY_UNAVAILABLE, run id, snapshot hash, outcome hash, level;
- `hold` (only when supported);
- entries, performances and participants (ids, kinds, athlete / team ids);
- `creditedLineups` (only when supported);
- `occurrence` (contest start);
- `comparisons` (PB only).

The snapshot contains no names, slugs, PII, evidence or authority topology. All collections are BR-JSON sets, so insertion order never changes the hash. The cutoff is metadata, never a member.

`snapshotHash = H("achievement-derivation-snapshot", …)`.

## 3. Engine (`achievement-engine/1`)

`deriveAchievements(snapshot) → { snapshotHash, outcome, outcomeHash }`

- **Integrity first.** A non-canonical snapshot, a rule spec that does not match its hash, or a foreign engine target raises `ACHIEVEMENT_INTEGRITY_FAILURE`. None of these produce a derivation.
- **Gates**, all of which must PASS for any candidate:

  | Gate | Fails with |
  |---|---|
  | RULE_APPLICABILITY | `RULE_DISCIPLINE_VERSION_MISMATCH`, `RESULT_SCOPE_MISMATCH` |
  | RESULT_STATUS | `RESULT_SUPERSEDED`, `RESULT_REVOKED`, `RESULT_REJECTED`, `RESULT_STATUS_BELOW_REQUIRED`, `RESULT_STATUS_UNAVAILABLE` |
  | VERIFICATION | `VERIFICATION_STALE`, `VERIFICATION_NOT_EVALUATED`, `VERIFICATION_POLICY_UNAVAILABLE`, `VERIFICATION_LEVEL_BELOW_REQUIRED` |
  | HOLD_STATE | `HOLD_ACTIVE`, `HOLD_STATE_UNAVAILABLE` (the absence of a hold is never assumed) |
  | OCCURRENCE (PB) | `OCCURRENCE_TIME_UNKNOWN` |

- **Sporting evaluation** is independent of the gates. For each subject (participant or performance), the trace says whether the facts qualify. This lets the trace say "facts match; floor unmet", and lets the demo show `wouldQualify = 1` with zero Achievements.
- **Candidates** exist only when every gate passes. The candidate hash is `H("achievement-candidate", …)` and the identity hash is `H("achievement-identity", {type, ruleVersionId, holder, scope, basis})`. The engine never assigns ids.
- **Trace:** the outcome (gates, subjects, candidates) is canonical and hashed. The same snapshot always gives the same outcome hash (vectors, property tests).

## 4. Numeric semantics

Marks are canonical decimal strings with exactly `precision` fraction digits. Comparisons use scaled BigInts (`compareDecimal`), never floating point.

- INTEGER and DURATION_MS require precision 0; DURATION_MS values are non-negative.
- The unit must equal the catalog unit. Nothing is converted.
- Thresholds are canonical decimals and must fit the value type.
- A personal best uses the DisciplineVersion comparator order. It never assumes that higher is better: LOWER_IS_BETTER and ORDINAL prefer smaller values.
- `qualifyingValue` is stored byte-equal to the source mark; formatting happens in the read layer only.

## 5. Personal best (implemented; athlete-local, reproducible)

- **Subject:** in the basis version, only the athlete's best performance of the rule's `markMetricId` is a PB candidate. A tie within the version goes to the lowest ordinal, deterministically.
- **Eligible prior comparison set:** performances of the **same athlete** in the **same exact DisciplineVersion** and the same `markMetricId` and unit, where the performance:
  - is valid;
  - comes from a contest whose occurrence started **strictly before** this contest's start;
  - has a status satisfying the rule (OFFICIAL / FINAL);
  - has a **CURRENT** verification at or above the rule's level;
  - belongs to a version that is not superseded.

  Cross-DisciplineVersion comparison is never made.
- **Decision:**
  - no eligible prior → PB only if `firstEligibleEstablishesBest` (explicit policy);
  - strictly better than the best eligible prior → PB;
  - equal → `PB_EQUALS_CURRENT_BEST` (strict tie policy);
  - worse → `PB_NOT_IMPROVED`.
- **Reproducibility:** `comparisonSetHash = H("achievement-comparison-set", {athlete, DV, metric, items[rv, contentHash, participant, ordinal, value, run]})` is committed in the candidate and stored. A replay of an old PB uses its pinned set, never today's history.
- **Not a record:** the scope is `CAREER` / DisciplineVersion. There is no record category or record vocabulary.

## 6. Persistence (`insertDerived` — the only writer)

The writer runs these steps in order:

1. **Validate (§98):**
   - the derivation reproduces from the snapshot, with the same outcome hash;
   - the candidate is among the derived ones;
   - the candidate and identity hashes recompute;
   - provenance and engine match;
   - the rule equals the snapshot rule;
   - every basis element equals the snapshot facts, with a CURRENT run;
   - the participant and performance exist;
   - the qualifying value equals the source mark;
   - the TEAM holder equals the participant's team and the credits equal the credited lineup, or the ATHLETE holder is supported by the participant / lineup.
2. **Serialize:** an advisory lock on the identity hash, then SELECT-existing, then INSERT. The `UNIQUE(identity_hash)` constraint is retryable (`achievement_identity_key`). Twenty concurrent callers converge on one row and all receive the same id.
3. **Database checks** (the `achievement_binding` trigger):
   - columns equal the candidate;
   - the rule version is PUBLISHED, with the same spec hash, type and DisciplineVersion;
   - the basis level meets the rule's level;
   - for CANONICAL_ASSEMBLY rows: the ResultVersion content hash, run ↔ version, run snapshot / outcome hashes, run `highest_level` and current lifecycle status match live canonical facts, and the holder and competition exist.
4. **Deferred completeness check:** every basis item, member credit and initial status entry is committed.
5. **Record:** a hash-chained ACHIEVEMENT ledger entry (`br:achievement-fact@1`), the `AchievementDerived` outbox event, and a read-model refresh, all in the same transaction.

## 7. Transactions and time

Derivation runs under REPEATABLE READ with one cutoff.

- BRT-07 freshness, and the pinned run's outcome / trace for the governing recognition, are read in the same transaction under the **SELECT-only `br_verification_reader`** via `SET LOCAL ROLE` (`withModuleRole`). **Achievement consumes Verification and never produces it** ([ADR-0042](../adr/ADR-0042-achievement-consumes-verification-read-only-and-live-current-support.md)). No achievement path can become `br_verification`, and stored outcome / trace documents are re-hashed before use (`RUN_HASH_MISMATCH`).
- A clock step raises `VERIFICATION_TIME_INCONSISTENT`, which gets two bounded retries with a fresh cutoff (the BRT-07 policy). Nothing is clamped.

## 8. Worker

`achievements.derive` consumes canonical events on the dedicated login `br_achievement_worker_app` (→ `br_achievements`, `br_verification_reader` — SELECT only). It can never write runs, traces, policies or bindings, and the generic `br_worker_app` gains nothing.

| Events | Reaction |
|---|---|
| `VerificationEvaluated`, `AchievementRuleBound`, `ResultSubmitted`, `ResultProvisional` (carrying a result version) | derive for that version, then re-assess its dependents |
| key / grant / anchor / attestation / evidence / policy changes | re-assess the current support of non-terminal canonical Achievements (bounded sweep) |

At-least-once delivery produces exactly-once logical effects through the natural identity (tested by replaying events). There is no fixture job, flag or event.

## 8a. Cutoff / asOf semantics (BRT-08R audit)

The derivation cutoff is **not** a snapshot member, and it is genuinely non-semantic: every temporal resolution happens **before sealing** and is captured as hashed facts. The engine reads no clock (a source-scan test covers this, and `vi.setSystemTime` shows identical outputs in 2020 and 2099).

| Temporal input | Where it is resolved | In the hash as |
|---|---|---|
| rule applicability (binding in force at submission) | loader, from `submittedAt` vs binding `effective_from` / `recorded_at` | `rule.bindingId` + `resultVersion.submittedAt` |
| verification currentness | loader (BRT-07 freshness at the transaction cutoff) | `verification.state`, `runId`, hashes, level |
| run cutoff / evidence basis | the pinned run | `verification.evaluatedAsOf`, `evidenceBundleHash` |
| result eligibility | append-only transitions / supersession at the cutoff | `resultVersion.status`, `supersededByVersionId` |
| PB comparison time | contest occurrence facts | `occurrence.startedAt`, `comparisons[].occurredAt` + each comparison's status / verification |

Two snapshots with the same `snapshotHash` are the same canonical document, so the engine produces identical outcomes, candidates and candidate hashes (determinism tests plus the clock test). Changing any temporal fact changes the snapshot hash (test). `recordedAt` is persistence metadata and is never part of the candidate.

## 9. Engine version policy

Any change of derivation semantics requires `achievement-engine/2`. Stored Achievements keep their engine version and candidate document and are never re-rendered with newer code.
