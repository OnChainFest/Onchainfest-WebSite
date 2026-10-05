# BRT-07 — Development Guide

Extends [BRT-06-DEVELOPMENT.md](./BRT-06-DEVELOPMENT.md) (and, through it, BRT-03–05): prerequisites, WSL notes, explicit development secrets and everyday commands still apply. All commands run from the repository root.

## 1. What changed for developers

| Area | BRT-07 addition |
|---|---|
| Packages | `@br/verification` (pure): policy model + validation, snapshot model + hashing, assembler (integrity, cutoff, participation index), V0–V4 engine, public explanation; `@br/verification/fixtures` — REFERENCE ENGINE FIXTURES (tests / demo only, never persisted) |
| Domain | `VerificationLevel` (V0–V4 only), `EvaluationState`, `VerificationFreshness`, `CriterionKind`, `CriterionStatus`, `CanonicalFactKind`, `ParticipationRelation`, errors `VERIFICATION_INTEGRITY_FAILURE` / `VERIFICATION_TIME_INCONSISTENT`, events |
| Persistence | `VerificationPolicyStore` (operator connection), `VerificationService`, `VerificationPublicReader`, `loadRawVerificationFacts`, `rebuildVerificationReadModels`; `inTransaction(…, { isolation: 'repeatable read' })` |
| Migrations | `0013_verification_policy.sql`, `0014_verification_runs.sql`, `0015_verification_read_models.sql` (0001–0012 untouched) |
| DB roles | `br_verification` (via `br_api`), `br_verification_policy` (only via the new login `br_verification_operator_app`) |
| API | `/v1/result-versions/:id/verification`, `…/verification-runs`, `…/verification-replays`, `/v1/verification-runs/:id[/summary]`, `/v1/verification-policies/:code`, INTERNAL policy routes; `/health` reports `phase: BRT-07` |
| Web | `/result-versions/[id]/verification`, `/verifications/[runId]` |
| Vectors | `packages/verification/test-vectors/brt-07.vectors.json` + independent Python checker |
| Guards | `tooling/check-no-manual-verification.mjs` (in `pnpm lint`) |

## 2. Environment

```bash
# BRT-07: optional verification-policy operator login (→ br_verification_policy only).
# The API enables INTERNAL policy mutation only when this is set; seeds/demo use the local dev login.
export BR_VERIFICATION_OPERATOR_DATABASE_URL=postgres://br_verification_operator_app:br_verification_operator_app_dev_only@localhost:55432/bragging_rights
```

## 3. Setup and commands

```bash
pnpm db:bootstrap            # creates br_verification, br_verification_policy, br_verification_operator_app
pnpm db:migrate              # applies 0013–0015
pnpm db:seed:competition && pnpm db:seed:evidence
pnpm db:seed:verification    # reference policy + binding + one real run (idempotent); honestly V0 — the seeded
                             # version's submitter is an unmapped referee and no registered-official producer exists
pnpm demo:verification       # 60-step walkthrough: Part A real flow, Part B labelled fixtures, real-data semantics
pnpm vectors:generate:brt07  # regenerate BRT-07 vectors (review the diff)
pnpm vectors:check           # all vectors + the three independent Python checkers
```

## 4. Evaluating by hand

```bash
BR_DEV_AUTH=1 BR_VERIFICATION_OPERATOR_DATABASE_URL=… pnpm dev:api
ORG=$(BR_DEV_AUTH=1 pnpm -s --filter @br/api dev-token seed:comp-organizer)
curl -s -X POST localhost:4000/v1/result-versions/<rvId>/verification-runs -H "authorization: Bearer $ORG" -H 'content-type: application/json' -d '{}' | jq .
curl -s localhost:4000/v1/result-versions/<rvId>/verification | jq .      # public, freshness-aware
pnpm dev:web   # http://localhost:3000/result-versions/<rvId>/verification
```

## 5. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `503 VERIFICATION_TIME_INCONSISTENT` | The evaluation cutoff predates facts that are already recorded. On WSL2 / Docker Desktop the VM clock is corrected by stepping it back (measured here: up to ~1 s every ~29 s). The service retries twice (0.3 s, 0.9 s) with a fresh cutoff and then fails closed — nothing is clamped. Re-run; keep database hosts NTP-disciplined and monotonic. |
| `400` "asOf cannot be in the future" on a replay right after an evaluation | Same clock step: the previous run's cutoff is momentarily ahead of the database clock. Wait a second (tests/demo use the harness helper `awaitDbTimePast`). |
| `GRANT_INVALID: UNKNOWN_PRINCIPAL` / `PRINCIPAL_UNKNOWN` in fixtures right after creating a principal | The same clock step, in the unchanged BRT-03 path (documented since BRT-06). Re-run. |
| `{ evaluationState: 'POLICY_UNAVAILABLE' }` | No PUBLISHED policy version is bound to the event's exact DisciplineVersion (no fallback by design). Seed or bind one. |
| `503 INTERNAL_CAPABILITY_UNAVAILABLE` on policy routes | No `BR_VERIFICATION_OPERATOR_DATABASE_URL` (by design; no fallback to the API login). |
| `500 VERIFICATION_INTEGRITY_FAILURE` + `reason` | A stored fact contradicts its hash or signature (`STATEMENT_HASH_MISMATCH`, `SIGNATURE_INVALID`, `DESCRIPTOR_HASH_MISMATCH`, `CONTENT_HASH_MISMATCH`, `POLICY_HASH_MISMATCH`, `RUN_HASH_MISMATCH`). Investigate; no run is produced. |
| V2 never reached on real data | Expected: `RESULT_OFFICIAL` / T5 / EvidenceAssessment producers do not exist yet ([model §4–5](./BRT-07-VERIFICATION-MODEL.md#4-real-production-ceiling-today)). |
