-- BRT-10 Step 11 · Staff ranking-run reader (ADR-0048 §9; BRT-10 development § API).
-- GRANTS ONLY: no table, column, constraint, trigger, function or view is created or changed here, and
-- 0001–0029 are untouched.
--
-- The INTERNAL route GET /v1/internal/ranking-runs/:runId shows a run card and every candidate with its
-- state and blockers (ranking_read.run_card / run_candidate, 0028). Those projections reveal excluded
-- results, so br_public_read never reads them; until now only br_rankings (the worker's writer role)
-- and br_rebuild could. The API login must never become br_rankings, so the read goes through a
-- dedicated NOLOGIN role, br_ranking_staff_reader (created by db/bootstrap/roles.sql, SET-only member of
-- br_api), that can SELECT exactly these two projections and nothing else: no canonical ranking table,
-- no definition table, no other module's table, no write of any kind.
--
-- No PUBLIC grant; no SECURITY DEFINER; no INSERT / UPDATE / DELETE / TRUNCATE; no ownership.

GRANT USAGE ON SCHEMA ranking_read TO br_ranking_staff_reader;
GRANT SELECT ON ranking_read.run_card, ranking_read.run_candidate TO br_ranking_staff_reader;
