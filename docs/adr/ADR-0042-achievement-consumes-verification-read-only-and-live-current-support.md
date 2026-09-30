# ADR-0042 — Achievement consumes Verification through a read-only role; current support is assessed live

- **Status:** Proposed
- **Date:** 2026-09-30
- **Origin:** BRT-08R (ADR-0031, ADR-0033, ADR-0040)

## Context

Issuing an Achievement needs BRT-07 hash-based freshness, which re-assembles a verification snapshot and reads every verification input. BRT-08 first ran that step under `br_verification` and gave the achievement worker login membership in it. `br_verification` can INSERT VerificationRuns and traces and write the verification read model, so the Achievement worker could have produced Verification.

The first design also recorded current support only when an event-driven re-assessment ran. Between a staleness-causing fact (e.g. a key compromise) and that re-assessment, a read could present an Achievement as currently supported while its pinned run was already STALE.

## Decision

1. **Achievement consumes Verification and never produces it.** A new NOLOGIN role, `br_verification_reader`, holds exactly the SELECT set BRT-07 freshness needs (the same tables `br_verification` reads) plus `verification.run` / `run_trace`, and read-only EXECUTE on the three STABLE resolvers. It has no INSERT / UPDATE / DELETE / TRUNCATE anywhere (tested from `information_schema`).
   - `br_achievement_worker_app` → `br_achievements`, `br_verification_reader`. It can never become `br_verification`.
   - `br_api` also holds SET on the reader; the achievement runtime uses the reader, not `br_verification`.
   - `br_achievements` itself reads only `verification.run` (the basis trigger).
2. **Current support is assessed live at read time.** Public Achievement detail and the Athlete Passport re-assess every non-terminal canonical Achievement from live canonical facts: status, supersession, and BRT-07 freshness of the pinned run. An Achievement whose pinned run is not CURRENT is never presented as currently supported, even before any event. If assessment fails, it is presented as not currently supported (fail closed). Reads never write.
3. **Event-driven recording:** the worker re-assesses and appends status entries on every canonical event that can stale a run or change a basis:
   - key status;
   - grant issued / revoked;
   - anchor recognized / changed;
   - evidence added / attached / derived / availability / privacy;
   - attestation issued / retracted / superseded;
   - policy bound;
   - verification evaluated / current verification changed;
   - result submitted.

   This is idempotent under replay.
4. A re-assessment is a pure function (`assessSupport`) of support facts. Support facts come from the canonical source, or, in the throwaway fixture database only, from a REFERENCE_FIXTURE source. The DB binds a status entry's provenance to its Achievement's (BR123), and the normal schema accepts only CANONICAL_ASSEMBLY.

## Consequences

Stale verification is never shown as current, and the Achievement runtime cannot write Verification. Costs: public reads of non-terminal Achievements pay a live freshness assembly (as BRT-07 public freshness already does), and one more NOLOGIN role.
