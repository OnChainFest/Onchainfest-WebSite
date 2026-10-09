# ADR-0031 — Verification is an immutable, append-only assessment; current state is a projection

- **Status:** Proposed
- **Date:** 2026-09-29
- **Origin:** BRT-07 (ADR-0002, ADR-0005; BRT-02 verification engine, persistence §4.5)

## Context

BRT-01 defines verification as a computed, re-computable assessment — never a writable flag — whose level may go down. The legacy failure (BRT-00 §17) was a mutable "verified" boolean driving consequences.

## Decision

1. No mutable `verified` / `verification_level` column exists on any Result table (lint guard).
2. A **VerificationRun** (`verification.run` + `run_trace`, class A) records one evaluation of one exact ResultVersion under one PUBLISHED policy version and one engine semantic version, with its snapshot, outcome and trace hashes and the outcome / trace documents themselves. Identity: `(resultVersion, policyVersion, engineVersion, snapshotHash)`; identical inputs → one run.
3. Runs are only produced from snapshots the service assembled from canonical facts (`snapshot_provenance = 'CANONICAL_ASSEMBLY'` CHECK); persisted runs are current evaluations (`evaluated_as_of = recorded_at`). Historical "as known then" evaluations are returned, never stored.
4. A later run may carry a different level; nothing is rewritten. The current state (`verification_read.current_verification`) is a rebuildable projection; freshness is computed at read time.
5. The engine semantic version is persisted; changing semantics requires a new version. Historical traces are never re-rendered with newer code.
6. Verification never transitions a Result, advances a bracket or creates achievements, records, rankings, prizes or trophies.

## Consequences

Auditable, reproducible history; honest downgrades. Costs: storage of outcome/trace documents; consumers must combine status, level, freshness and holds explicitly.

## Alternatives considered

- **Level column on results:** rejected (the BRT-00 anti-pattern).
- **Overwriting a "current verification" row:** rejected (loses history and reproducibility).
