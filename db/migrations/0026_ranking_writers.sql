-- BRT-10 · Writer plumbing for the validated BRT-10 writers (ADR-0047 §3, ADR-0048 §5–6; BRT-02
-- persistence §5.4, §7). GRANTS ONLY: no table, column, constraint, trigger, function or view is
-- created or changed here, and 0001–0025 are untouched.
--
-- 0023–0025 created the ranking / classification tables with "nobody can write yet beyond the
-- module role" grants and deliberately deferred the platform plumbing to the writer step. This
-- migration grants exactly what the three validated writers need:
--
--   br_results        (ResultLedger, T2 `@2` submission) READ-ONLY structural facts to re-assemble a
--                     classification's canonical inputs inside the submitting transaction: the exact
--                     contests of the scope (contest → round → event → competition ids) and the pinned
--                     DisciplineVersion (id, spec, catalog spec hash). Ids and catalog data only — no
--                     names, PII, schedules or venues. It writes nothing new (its derivation-index
--                     INSERT grants are 0023's).
--   br_ranking_rules  (RankingSystem / ClassificationPolicy operator) outbox, idempotency and audit,
--                     plus the owner trust anchor's validity window and REVOKED status facts, so an
--                     OFFICIAL owner can only be a currently-anchored principal (never fabricated),
--                     and competition ids, so a universe's competition set names real competitions.
--   br_rankings       (ranking run / snapshot writer) outbox and audit (runs and snapshots are
--                     idempotent on their natural keys, so no command-idempotency grant), plus the
--                     read-only canonical facts a run re-assembly needs (mirroring br_records, 0020):
--                     result-version resolution, the competition path, participants / holders,
--                     contest occurrence and the DisciplineVersion. BRT-07 freshness and run traces
--                     are read under the SELECT-only br_verification_reader in the same transaction.
--
-- No ledger stream is added: rankings are class-A, hash-pinned tables in their own right (BRT-02
-- persistence §2 table classes; the 0001 stream_type vocabulary is unchanged). br_api reaches neither
-- ranking role; no PUBLIC grant; no SECURITY DEFINER function; no UPDATE / DELETE / TRUNCATE grant.

-- ─────────────────────── br_results: classification re-derivation (read-only) ───────────────────────
GRANT USAGE ON SCHEMA sports TO br_results;
GRANT SELECT (id, spec, spec_hash) ON sports.discipline_version TO br_results;
-- USAGE ON SCHEMA competition was granted to br_results in 0008 (scope-path resolution).
GRANT SELECT (id, competition_id, discipline_version_id) ON competition.event TO br_results;
GRANT SELECT (id, event_id) ON competition.round TO br_results;
GRANT SELECT (id, event_id, round_id) ON competition.contest TO br_results;

-- ─────────────────────── br_ranking_rules: definition operator plumbing ───────────────────────
GRANT SELECT, INSERT ON platform.outbox_event TO br_ranking_rules;
GRANT SELECT, INSERT ON platform.command_idempotency TO br_ranking_rules;
GRANT INSERT ON platform.audit_event TO br_ranking_rules;
-- Owner anchor validity (0024 granted id, principal_id, recognition_scope).
GRANT SELECT (effective_from, effective_to) ON authority.trust_anchor TO br_ranking_rules;
GRANT SELECT (anchor_id, kind, effective_from) ON authority.trust_anchor_status_change TO br_ranking_rules;
-- A universe's competition set names real competitions only (ids, nothing else).
GRANT USAGE ON SCHEMA competition TO br_ranking_rules;
GRANT SELECT (id) ON competition.competition TO br_ranking_rules;

-- ─────────────────────── br_rankings: run / snapshot writer plumbing ───────────────────────
GRANT SELECT, INSERT ON platform.outbox_event TO br_rankings;
GRANT INSERT ON platform.audit_event TO br_rankings;

-- Canonical candidate facts (read-only; 0023/0025 granted results.result, result_version,
-- result_status_transition, verification.run and USAGE on results / verification).
GRANT EXECUTE ON FUNCTION results.resolve_result_version(uuid) TO br_rankings;
GRANT USAGE ON SCHEMA competition TO br_rankings;
GRANT EXECUTE ON FUNCTION competition.resolve_scope_path(text, uuid) TO br_rankings;
GRANT SELECT ON competition.event, competition.participant, competition.contest,
  competition.contest_status_change TO br_rankings;
GRANT USAGE ON SCHEMA sports TO br_rankings;
GRANT SELECT ON sports.sport, sports.discipline, sports.discipline_version TO br_rankings;
