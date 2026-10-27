-- STG-01A · F3 preflight (read-only). PR #42 security review finding F3: a stalled issuance or
-- result transaction holding advisory locks can block an organizer's result writes, and nothing
-- in the code sets lock_timeout or idle_in_transaction_session_timeout.
--
-- This only REPORTS the effective values; it changes nothing. Values are chosen and applied
-- separately, after the compatibility review in docs/operations/STG-01A-STAGING-RUNBOOK.md §7.
--
--   docker compose exec -T postgres psql -U br_admin -d onchainfest -v ON_ERROR_STOP=1 \
--     < deploy/staging/sql/f3-timeouts.sql
BEGIN READ ONLY;

-- 1 · Server-wide values and where they come from (0 = disabled).
SELECT name, setting, unit, source
  FROM pg_settings
 WHERE name IN ('lock_timeout', 'idle_in_transaction_session_timeout', 'statement_timeout',
                'transaction_timeout', 'deadlock_timeout')
 ORDER BY name;

-- 2 · Per-login and per-database overrides (ALTER ROLE / ALTER DATABASE … SET).
SELECT coalesce(r.rolname, '(every role)') AS role,
       coalesce(d.datname, '(every database)') AS database,
       s.setconfig
  FROM pg_db_role_setting s
  LEFT JOIN pg_roles r ON r.oid = s.setrole
  LEFT JOIN pg_database d ON d.oid = s.setdatabase
 ORDER BY 1, 2;

-- 3 · Sessions idle inside a transaction or waiting on a lock right now (advisory locks included).
SELECT a.pid,
       a.usename,
       a.state,
       a.wait_event_type,
       a.wait_event,
       now() - a.xact_start AS transaction_age,
       now() - a.state_change AS state_age,
       pg_blocking_pids(a.pid) AS blocked_by
  FROM pg_stat_activity a
 WHERE a.datname = current_database()
   AND (a.state LIKE 'idle in transaction%' OR a.wait_event_type = 'Lock')
 ORDER BY a.xact_start;

ROLLBACK;
