-- BRT-10 Step 10 · Ranking worker: read the round → event link (ADR-0047 §5; BRT-10 history §2.1).
-- GRANTS ONLY: no table, column, constraint, trigger, function or view is created or changed here, and
-- 0001–0028 are untouched.
--
-- The Step 10 worker (login br_ranking_worker_app) calls ClassificationStalenessService.emitStale under
-- br_rankings: the login can never become br_results (db/bootstrap/roles.sql). Computing the staleness
-- of a ROUND_CLASSIFICATION re-assembles its scope, which reads competition.round (id, event_id) to
-- reach the round's event and DisciplineVersion. br_rankings already reads results, the derivedFrom
-- index, classification policy versions, events, contests, DisciplineVersions and the outbox (0023,
-- 0025, 0026); the round link is the only missing fact. This is exactly the column grant br_results
-- holds for the same assembly (0026). Ids only — no names, schedules, byes or venues.
--
-- br_rankings stays read-only on competition; no PUBLIC grant; no SECURITY DEFINER; no UPDATE / DELETE /
-- TRUNCATE grant. Independent of 0027 / 0028, so it applies in any order relative to them.

GRANT SELECT (id, event_id) ON competition.round TO br_rankings;
