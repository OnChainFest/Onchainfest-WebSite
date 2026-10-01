# BRT-09 — Record Threat Review

| Threat | Control | Evidence |
|---|---|---|
| Fake record holder / value substitution | holder resolved from canonical participant; value byte-equal to the Performance Mark; writer re-runs the engine; trigger binds columns to candidate (BR150) | engine + persistence tests (`METRIC_MISMATCH`, `PENDING_MARK_BASIS_MISMATCH`), Python vector checker |
| Metric substitution / wrong comparator | category pins exact metric + DV; comparator from the DV metric order only; `METRIC_NOT_COMPARABLE` | category / engine tests, HIGHER/LOWER tests |
| Wrong category / universe drift | one universe per category (BR141), versions immutable, pinned on every mark | category tests, ADR-0043 |
| Handicap → scratch contamination | typed population facts; `HANDICAP_VALUE_IN_SCRATCH_CATEGORY`; absence ≠ scratch | engine + persistence tests |
| Wrong region / wrong sport / PLATFORM claiming NATIONAL/WORLD | RATIFY_RECORD over structural scope; anchor must cover level+region+sport; PLATFORM scope only PLATFORM recognition | engine tests, demo Part B |
| Fake canonical keeper / PLATFORM CANONICAL | explicit designation; BR157 in DB; validator refuses PLATFORM keeper | engine + DB tests |
| Ratification forgery / replay / wrong subject hash | subject must equal the pending mark hash (engine + BR156); unique ratification per mark / per ref; normal schema requires a canonical attestation (none can exist) | fixture concurrency test, DB tests |
| Stale Achievement / stale verification source | CURRENT run at the floor required; live support at read | engine + support tests |
| Temporary suspension treated as rescission | SUSPENDED never rescinds; only basis invalidation does | support + persistence tests |
| History rewrite | class-A tables reject UPDATE / DELETE / TRUNCATE (owner too) | persistence tests |
| Tie race / duplicate current record | per-category serialization; identity UNIQUE; replay-derived current | 20-way and SHARED concurrency tests |
| Rescinded mark displayed as valid | Hall of Fame excludes; labels "rescinded — not a record" | fixture tests, demo |
| Fixture escape | normal-schema CHECKs; overlays only in `br_recfx_*`; apps cannot import lanes | containment test, guard |
| Operator force-record | `br_record_rules` cannot write marks / statuses; no route | role tests |
| Worker cross-module writes | record worker never holds br_achievements / br_verification / br_evidence / br_authority | role tests |
| PII / authority topology leakage | DTOs omit ids / hashes / grants / keys; athletes via Passport policy | API leak scan |
| Retroactive category rewrite / backdating | effectiveFrom ≥ publication (BR142); sporting-time gating | category tests |
| DoS from replay | replay bounded (10 000 marks / category; schema bound); page size ≤ 50 | code bounds |

Residual risks: production producers for FINAL / V3 / V4 / holds / ratification are absent (records unreachable — honest); LEAGUE / VENUE membership facts undefined; RECORD_SET derivation is eventually consistent with ratification (separate validated transaction by design).
