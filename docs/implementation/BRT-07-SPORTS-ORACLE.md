# BRT-07 — Sports Oracle (snapshot → pure engine → immutable run)

| Field | Value |
|---|---|
| ADRs | [0031](../adr/ADR-0031-verification-is-an-immutable-assessment.md), [0033](../adr/ADR-0033-deterministic-verification-snapshot-and-hash-freshness.md), [0035](../adr/ADR-0035-unsupported-canonical-facts-and-unpersisted-fixtures.md) |
| Code | `packages/verification/src/{snapshot,assemble,context,criteria,engine,public,fixtures}.ts`, `packages/persistence/src/verification-{loader,store,projection}.ts`, `apps/api/src/v1-verification.ts`, `apps/web/app/{verifications,result-versions}` |

## 1. Pipeline

```
canonical facts (results, evidence, attestations, keys, authority, competition, identity mappings, policy)
   │  loadRawVerificationFacts      br_verification, REPEATABLE READ, read-only, superset, any order
   ▼
RawVerificationFacts
   │  assembleSnapshot(raw, asOf, CURRENT|HISTORICAL)   pure
   │    · time consistency (CURRENT: no fact may be recorded after the cutoff)
   │    · cutoff filter (recordedAt ≤ asOf)
   │    · integrity: content hash, descriptors, statements, JWS proofs vs key material, policy hash
   │    · rebuilds the BRT-06 Evidence Bundle (hash kept as run metadata)
   │    · ParticipationIndex (structural facts) · supportedFactKinds = today's producers only
   ▼
VerificationSnapshot  (br:verification-snapshot@1, provenance CANONICAL_ASSEMBLY)
   │  evaluateVerification(snapshot)                     pure: no DB, network, fs, clock, randomness, env
   ▼
VerificationOutcome (br:verification-outcome@1) + VerificationTrace (br:verification-trace@1)
   │  persistRun — idempotent identity, ledger entry, outbox, read model
   ▼
verification.run + verification.run_trace   (class A, immutable)
```

There is **no API or store method that accepts a caller-supplied snapshot**: runs are only ever created from snapshots the service assembled itself.

## 2. VerificationSnapshot (`br:verification-snapshot@1`)

| Member | Content |
|---|---|
| `provenance`, `assembler` | `CANONICAL_ASSEMBLY` / `verification-assembler/1` (fixtures: `REFERENCE_FIXTURE` / `reference-fixture/1`) |
| `policy` | policy id, version id, code, version, `specHash`, the normalized spec |
| `resultVersion` | ids, version number, content hash + schema, submitter principal, `submittedAt`, status **as of the cutoff** (read only), superseding version, scope, entry participant ids |
| `hierarchy` | the resolved path (competition, event, round, contest, sport, discipline, region) from `competition.resolve_scope_path` — never inferred from ids or slugs |
| `discipline` | exact DisciplineVersion id and its primary evidence types |
| `evidence[]` | type, content/descriptor hashes, source kind + principal, generator kind, availability at the cutoff, roles of attachments to **this exact version**, lineage root, `integrity: VERIFIED` |
| `attestations[]` | statement hash, issuer principal/type, key, assurance, `issuedAt`, `signedAt`, claim type/polarity, declared acting role, cited evidence, condition aspects, `status` (ACTIVE / RETRACTED / SUPERSEDED as of the cutoff), `proof: VERIFIED` |
| `sanctions[]`, `identityConfirmations[]`, `ratifications[]`, `t5Transitions[]`, `registeredOfficials[]`, `officialEvidenceSet`, `recordCategory`, `evidenceAssessments[]` | typed BRT-01 facts; **empty in production** (no producer). `registeredOfficials[]` is the V1 registered-official registration (structural; not an AuthorityGrant) |
| `supportedFactKinds[]` | the fact kinds the producer can emit (production: `RESULT_ACCURATE_ATTESTATION`, `CONDITIONS_COMPLIANT_ATTESTATION`) |
| `keys[]` | issuers' keys: validity window, status changes (with `compromisedSince`) known at the cutoff |
| `authority` | principals, anchors (+ status), grants with full parent chains (+ status) known at the cutoff |
| `participation` | `sidesComplete`, `occurrenceWindow` {from?, to}, sides (participant → athletes → principals certainly on the side), per principal: resolution (`RESOLVED` / `UNRESOLVED` / `TEMPORALLY_UNDETERMINED`) + relations with `timing` (`STRUCTURAL` / `DURING_OCCURRENCE` / `UNDETERMINED`) — see [temporal slicing](./BRT-07-INDEPENDENCE-AND-CONFLICTS.md#temporal-slicing-brt-07r) |

No display names, profiles, slugs, contact data or PII; no evidence bytes. **The cutoff (`asOf`) is not a member** — identical facts assembled at two cutoffs are the same input ([ADR-0033](../adr/ADR-0033-deterministic-verification-snapshot-and-hash-freshness.md)). For the same reason the BRT-06 `bundleHash` (which embeds its own asOf) is run metadata, not a member.

`snapshotHash = H("verification-snapshot", br:verification-snapshot@1, JCS)` — every collection is a BR-JSON set, so insertion order never matters (property-tested; vectors `snapshot/reference-world-reordered`).

## 3. Engine

```ts
evaluateVerification(snapshot) → { snapshotHash, outcome, outcomeHash, trace, traceHash }
```

- Engine semantic version **`verification-engine/1`** (persisted on every run; a policy declares its `targetEngine`). Any change of evaluation semantics requires `verification-engine/2`; stored runs keep their own outcome and trace documents.
- The snapshot is re-canonicalized first; a non-canonical snapshot, a policy spec not matching its hash or a foreign engine target is `VERIFICATION_INTEGRITY_FAILURE`.
- Authority uses the unchanged BRT-03 engine (`authorize`) over snapshot facts; the knowledge horizon is "every fact in the snapshot" (a fixed constant), since the assembler already applied the cutoff.

**Outcome** (`br:verification-outcome@1`): engine id/version, `evaluationState`, result version, policy version + spec hash, snapshot hash, optional `highestSatisfiedLevel`, `satisfiedLevels`, per level `status` and its criteria (`criterionId`, `kind`, `status`, `reasons`), `flags` (CONTRADICTING_ATTESTATION, AI_ONLY_EVIDENCE, SUSPECT_ATTESTER, EVIDENCE_UNAVAILABLE, PARTICIPATION_INCOMPLETE), `traceHash`. No clock value, random id or `recordedAt` inside.

**Trace** (`br:verification-trace@1`, internal): per signed fact — claim status, key trust (+ reason), counts; per criterion — kind, level, status, reasons, observed / required counts, supporting attestation and evidence ids, grant and anchor ids, every authority decision (principal, capability, recognition level requested, effective time, authorized, reason, anchor + its recognition levels, grant chain leaf → root, conflict status, BRT-03 proof digest), issuer groups (principal → attestations → classification), source groups and the participation relations used.

`outcomeHash` / `traceHash` are domain-separated like every other hash; the outcome binds the trace hash.

## 4. Persistence (migrations 0013–0015)

| Table | Class | Notes |
|---|---|---|
| `verification.policy` | A | stable code |
| `verification.policy_version` | A | immutable spec + hash + target engine |
| `verification.policy_version_status_change` | A | PUBLISHED once, then RETIRED (`BR090`) |
| `verification.policy_binding` | A | exact DisciplineVersion; no backdating; strictly increasing effective time (`BR091`, `BR092`) |
| `verification.run` | A | `UNIQUE (result_version_id, policy_version_id, engine_version, snapshot_hash)`; `CHECK snapshot_provenance = 'CANONICAL_ASSEMBLY'`; `CHECK evaluated_as_of = recorded_at`; columns bound to the outcome document (`BR093`); PUBLISHED + bound policy with the evaluated spec (`BR094`) |
| `verification.run_trace` | A | same transaction, hash and snapshot as its run (`BR095`) |
| `verification_read.current_verification` | B | latest run per result version (freshness is computed at read, never stored) |
| `verification_read.run_summary` | B | public-safe body per run (from the outcome only) |

Every run also appends a hash-chained ledger entry on the result version's `VERIFICATION` stream (payload `br:verification-run-fact@1`).

**Idempotency / concurrency.** The run identity is `(resultVersion, policyVersion, engineVersion, snapshotHash)`. Evaluation takes an advisory lock on it, re-reads, and inserts only if absent; under REPEATABLE READ a concurrent loser hits the unique constraint and is retried (retryable constraint) into the "existing run" path. 20 concurrent identical evaluations → one run, one `created: true`, no raw SQL error (tested). Unchanged facts → the same run (`created: false`); changed facts → a new run.

## 5. API

| Route | Class | Purpose |
|---|---|---|
| `GET /v1/result-versions/:id/verification` | PUBLIC | Current verification (visible competition/event only): freshness, evaluation state, level + label only when CURRENT, `lastEvaluated` when STALE, levels, next blocked level with fixed public explanations, active-dispute marker |
| `GET /v1/verification-runs/:id/summary` | PUBLIC | Historical run summary (read model; no trace) |
| `GET /v1/verification-policies/:code` | PUBLIC | Published / retired versions (declarative specs are public-safe) |
| `POST /v1/result-versions/:id/verification-runs` | COMP_STAFF | Current evaluation (201 new / 200 existing; `{evaluationState: POLICY_UNAVAILABLE}` when no policy). Closed empty body: `desiredLevel`, `forceLevel`, `manualOverride`, `confidence`, `ignoreConflict`… → 400 |
| `POST /v1/result-versions/:id/verification-replays` | COMP_STAFF | Historical "as known then" evaluation (`asOf` ≤ now; never persisted) |
| `GET /v1/result-versions/:id/verification-runs` | COMP_STAFF | Run history + freshness |
| `GET /v1/verification-runs/:id` | COMP_STAFF | Run detail with the stored outcome + trace (re-hashed on read) |
| `POST /v1/internal/verification-policies`, `…/:id/versions`, `/v1/internal/verification-policy-versions/:id/publish` · `/retire`, `/v1/internal/discipline-versions/:id/verification-policy-bindings` | INTERNAL | Operator flag + dedicated connection (503 without it) |

COMP_STAFF = INTERNAL or an account with `COMP_VIEW_PRIVATE` on the result's competition (organizer OWNER/ADMIN, staff with private view). Requesting an evaluation confers no sporting authority and cannot choose the outcome. Denials return the same 404 as unknown ids and are audited.

Errors: `VERIFICATION_INTEGRITY_FAILURE` 500 (+ fixed reason), `VERIFICATION_TIME_INCONSISTENT` 503, policy validation 400 with `issues[{path, code}]`.

## 6. Time and the clock

- The CURRENT cutoff is **one** database reading: the evaluation transaction's time (`platform.tx_time_ms()`), which is also the run's `recorded_at` and `evaluated_as_of` (CHECK). No browser time, no `signedAt`, no clamp, no slack.
- Verification transactions run under **REPEATABLE READ**: every loader statement sees one snapshot.
- If a visible fact was recorded after the cutoff, the snapshot cannot be coherent — a database clock step backwards, or a commit in the BEGIN → first-statement window — so assembly fails closed with `VERIFICATION_TIME_INCONSISTENT`. The service retries the whole evaluation at most twice (after 300 ms and 900 ms, each attempt a fresh transaction with its own time) and then surfaces the error. Nothing is rewritten or clamped; BRT-03 global time semantics are unchanged.
- Development evidence: on this WSL2 / Docker Desktop host the database clock stepped back by up to ~1 s roughly every 29 s (453 backward samples in a 20-minute monitor, 100 ms sampling). CI runners and NTP-disciplined production hosts do not step backwards; see [development §5](./BRT-07-DEVELOPMENT.md#5-troubleshooting).
- Historical replays accept only `asOf ≤ now`; during a clock step a replay at the latest run's cutoff is correctly refused as "in the future" (the test/demo harness waits with `awaitDbTimePast`, never the product).

## 7. Events and audit

| Event | Aggregate | Payload (ids, hashes, levels, statuses only) |
|---|---|---|
| `VerificationPolicyCreated` | VERIFICATION_POLICY | code |
| `VerificationPolicyVersionCreated` | VERIFICATION_POLICY_VERSION | policyId, version, specHash |
| `VerificationPolicyVersionPublished` / `…Retired` | VERIFICATION_POLICY_VERSION | status, specHash |
| `VerificationPolicyBound` | VERIFICATION_POLICY_VERSION | bindingId, disciplineVersionId, effectiveFrom |
| `VerificationEvaluated` | VERIFICATION_RUN | resultVersionId, policyVersionId, engineVersion, snapshotHash, outcomeHash, evaluationState, highestSatisfiedLevel? |
| `CurrentVerificationChanged` | RESULT_VERSION | resultVersionId, verificationRunId, snapshotHash, policyVersionId, previousLevel?, newLevel? — only when the latest level/state changed |

No achievement, record, ranking, prize or trophy event exists or is emitted (tested). BRT-08 may consume `CurrentVerificationChanged`; BRT-07 does not.

Audit actions: `verification.policy-created`, `…-version-created`, `…-version-published`, `…-version-retired`, `…-policy-bound`, `verification.evaluation-requested` (SUCCEEDED / DENIED / FAILED with the integrity or time reason), `verification.historical-evaluation-requested`, `verification.run-read` / `history-read` (DENIED), `verification.policy-*-denied` (non-operator or no operator connection). Details carry ids, codes and counts only. Audit ≠ verification.

## 8. Public DTO and web surface

`br:public-verification@1` and `br:public-verification-run@1` are built from the outcome's level and criterion **kinds / statuses** only — never the trace — with fixed wording per kind (e.g. `OFFICIAL_DECLARATION` + `INPUT_NOT_SUPPORTED` → "Required canonical event-certification fact (RESULT_OFFICIAL, or RESULT_ACCURATE with an official T5 declaration) is not currently available on the platform."). Exact labels: Claimed, Corroborated, Event Certified, Sanctioned, Ratified; statements read "Corroborated (V1): current canonical facts satisfy policy X vY up to this level." No "Verified ✓", percentage or score.

Web: `/result-versions/[id]/verification` (current, freshness-aware: a STALE run is shown only as "last evaluated … historical, not current") and `/verifications/[runId]` (historical run). Both call PUBLIC endpoints only.
