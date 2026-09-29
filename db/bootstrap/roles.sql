-- Role bootstrap (run by an administrator, never by applications). Idempotent and convergent:
-- re-running it also removes memberships that are no longer part of the role graph.
-- Passwords are set separately by tooling (packages/persistence/src/cli/bootstrap.ts).
--
-- Login → module-role graph (BRT-03R; see docs/implementation/BRT-03-FOUNDATION.md §6):
--
--   br_owner        LOGIN  owns schemas/tables; runs migrations only. Not a member of anything,
--                          and no runtime login is a member of it.
--   br_api          LOGIN NOINHERIT → SET br_authority, br_results, br_identity,
--                                        br_organizations, br_public_read,
--                                        br_competition (BRT-05)
--                          (never br_catalog: catalog mutation has its own login — BRT-05R)
--   br_operator_app LOGIN NOINHERIT → SET br_catalog
--                          (BRT-05R: INTERNAL sport-catalog mutation only; nothing else)
--                          (normal request processing; never the PII vault)
--   br_api_vault    LOGIN NOINHERIT → SET br_identity_private
--                          (BRT-04: the PII vault repository's own connection, nothing else)
--   br_worker_app   LOGIN NOINHERIT → SET br_worker
--                          (outbox consumption, job queue)
--   br_maintenance  LOGIN NOINHERIT → SET br_rebuild
--                          (projection rebuild; operator/maintenance jobs only)
--   br_probe        LOGIN  development/test only: connected but unprivileged.
--
--   br_authority, br_results, br_worker, br_rebuild,
--   br_identity, br_identity_private, br_organizations, br_public_read,
--   br_catalog (sport catalog writes; reachable only from br_operator_app),
--   br_competition (competition operations)
--                   NOLOGIN module roles (table privileges).
--
-- Memberships are granted WITH INHERIT FALSE, SET TRUE, ADMIN FALSE: a login holds no module
-- privileges until a transaction runs SET LOCAL ROLE, can only switch to its own module roles,
-- and can never grant roles to anyone.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['br_owner', 'br_api', 'br_api_vault', 'br_operator_app', 'br_worker_app', 'br_maintenance', 'br_probe'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', r);
    END IF;
  END LOOP;
  FOREACH r IN ARRAY ARRAY['br_authority', 'br_results', 'br_worker', 'br_rebuild',
                           'br_identity', 'br_identity_private', 'br_organizations', 'br_public_read',
                           'br_catalog', 'br_competition'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', r);
    END IF;
  END LOOP;

  -- Retire the pre-BRT-03R shared runtime login if it exists (it could assume every module role).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'br_runtime') THEN
    REVOKE br_authority, br_results, br_worker, br_rebuild FROM br_runtime;
    ALTER ROLE br_runtime NOLOGIN;
  END IF;
END
$$;

ALTER ROLE br_api NOINHERIT;
ALTER ROLE br_api_vault NOINHERIT;
ALTER ROLE br_operator_app NOINHERIT;
ALTER ROLE br_worker_app NOINHERIT;
ALTER ROLE br_maintenance NOINHERIT;
ALTER ROLE br_probe NOINHERIT;

-- Converge: remove any membership outside the intended graph.
-- BRT-05R: br_api must never reach the catalog writer (also removes the BRT-05 grant on upgrade).
REVOKE br_worker, br_rebuild, br_identity_private, br_catalog FROM br_api;
REVOKE br_owner, br_authority, br_results, br_worker, br_rebuild, br_identity, br_identity_private, br_organizations, br_public_read, br_competition FROM br_operator_app;
REVOKE br_authority, br_results, br_worker, br_rebuild, br_identity, br_organizations, br_public_read, br_catalog, br_competition FROM br_api_vault;
REVOKE br_authority, br_results, br_rebuild, br_identity, br_identity_private, br_organizations, br_public_read, br_catalog, br_competition FROM br_worker_app;
REVOKE br_authority, br_results, br_worker, br_identity, br_identity_private, br_organizations, br_public_read, br_catalog, br_competition FROM br_maintenance;
REVOKE br_authority, br_results, br_worker, br_rebuild, br_identity, br_identity_private, br_organizations, br_public_read, br_catalog, br_competition FROM br_probe, br_owner;
REVOKE br_owner FROM br_api, br_api_vault, br_operator_app, br_worker_app, br_maintenance, br_probe;

GRANT br_authority, br_results, br_identity, br_organizations, br_public_read, br_competition TO br_api WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
GRANT br_catalog TO br_operator_app WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
GRANT br_identity_private TO br_api_vault WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
GRANT br_worker TO br_worker_app WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
GRANT br_rebuild TO br_maintenance WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
