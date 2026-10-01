-- Per-database hardening (run by an administrator for each database). Idempotent.
-- :"dbname" is substituted by tooling with a quoted identifier.
REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"dbname" TO br_owner, br_api, br_api_vault, br_operator_app, br_verification_operator_app, br_achievement_operator_app, br_achievement_worker_app, br_record_operator_app, br_record_worker_app, br_worker_app, br_maintenance, br_probe;
GRANT CREATE, TEMPORARY ON DATABASE :"dbname" TO br_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'br_runtime') THEN
    EXECUTE format('REVOKE ALL ON DATABASE %I FROM br_runtime', current_database());
  END IF;
END
$$;
