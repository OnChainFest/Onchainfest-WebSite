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
--                                        br_competition (BRT-05), br_evidence (BRT-06),
--                                        br_verification (BRT-07)
--                          (never br_catalog: catalog mutation has its own login — BRT-05R)
--                          (never br_verification_policy: policy mutation has its own login — BRT-07)
--                                        br_achievements, br_verification_reader (BRT-08)
--                                        br_records (BRT-09)
--                          (never br_record_rules: category mutation has its own login — BRT-09)
--                          (never br_achievement_rules: rule mutation has its own login — BRT-08)
--   br_operator_app LOGIN NOINHERIT → SET br_catalog
--                          (BRT-05R: INTERNAL sport-catalog mutation only; nothing else)
--                          (normal request processing; never the PII vault)
--   br_verification_operator_app LOGIN NOINHERIT → SET br_verification_policy
--                          (BRT-07: INTERNAL verification-policy mutation only; nothing else)
--   br_achievement_operator_app LOGIN NOINHERIT → SET br_achievement_rules
--                          (BRT-08: INTERNAL AchievementRule mutation only; nothing else)
--   br_api_vault    LOGIN NOINHERIT → SET br_identity_private
--                          (BRT-04: the PII vault repository's own connection, nothing else)
--   br_worker_app   LOGIN NOINHERIT → SET br_worker
--                          (outbox consumption, job queue)
--   br_achievement_worker_app LOGIN NOINHERIT → SET br_achievements, br_verification_reader
--                          (BRT-08: the worker's idempotent achievement derivation and current-support
--                          re-assessment reacting to canonical events. Achievement CONSUMES
--                          Verification: the login can never become br_verification (no run, trace,
--                          policy or binding writes); br_verification_reader is SELECT-only.)
--   br_record_operator_app LOGIN NOINHERIT → SET br_record_rules
--                          (BRT-09: INTERNAL RecordCategory administration only — create, version,
--                          publish, retire. It can never pick a holder, set a current record, force
--                          RATIFIED / CANONICAL or touch any sporting fact.)
--   br_record_worker_app LOGIN NOINHERIT → SET br_records, br_verification_reader
--                          (BRT-09: the worker's idempotent record evaluation / current-support
--                          reassessment. Records CONSUME Verification / Achievements read-only: the login
--                          can never become br_verification, br_achievements, br_evidence or br_authority.)
--   br_maintenance  LOGIN NOINHERIT → SET br_rebuild
--                          (projection rebuild; operator/maintenance jobs only)
--   br_probe        LOGIN  development/test only: connected but unprivileged.
--
--   br_authority, br_results, br_worker, br_rebuild,
--   br_identity, br_identity_private, br_organizations, br_public_read,
--   br_catalog (sport catalog writes; reachable only from br_operator_app),
--   br_competition (competition operations),
--   br_evidence (BRT-06 evidence + attestation module; no blob credentials live in the database)
--   br_verification (BRT-07 verification runtime: reads canonical facts, writes only runs + read model)
--   br_verification_policy (BRT-07 policies/bindings; reachable only from br_verification_operator_app)
--   br_achievements (BRT-08 achievement runtime: reads exact sporting/verification facts, writes only
--                    achievement facts + its read model)
--   br_achievement_rules (BRT-08 rules/bindings; reachable only from br_achievement_operator_app)
--   br_verification_reader (BRT-08: SELECT-only view of Verification inputs / runs / traces for
--                    Achievement freshness and governing-recognition reads; writes nothing)
--   br_records (BRT-09 record runtime: reads exact sporting / verification facts and RECORD_SET links,
--                    writes only record facts + record read models)
--   br_record_rules (BRT-09 RecordCategory writer; reachable only from br_record_operator_app)
--                   NOLOGIN module roles (table privileges).
--
-- Memberships are granted WITH INHERIT FALSE, SET TRUE, ADMIN FALSE: a login holds no module
-- privileges until a transaction runs SET LOCAL ROLE, can only switch to its own module roles,
-- and can never grant roles to anyone.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['br_owner', 'br_api', 'br_api_vault', 'br_operator_app', 'br_verification_operator_app', 'br_achievement_operator_app', 'br_achievement_worker_app', 'br_record_operator_app', 'br_record_worker_app', 'br_worker_app', 'br_maintenance', 'br_probe'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', r);
    END IF;
  END LOOP;
  FOREACH r IN ARRAY ARRAY['br_authority', 'br_results', 'br_worker', 'br_rebuild',
                           'br_identity', 'br_identity_private', 'br_organizations', 'br_public_read',
                           'br_catalog', 'br_competition', 'br_evidence',
                           'br_verification', 'br_verification_policy',
                           'br_achievements', 'br_achievement_rules', 'br_verification_reader',
                           'br_records', 'br_record_rules'] LOOP
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
ALTER ROLE br_verification_operator_app NOINHERIT;
ALTER ROLE br_achievement_operator_app NOINHERIT;
ALTER ROLE br_achievement_worker_app NOINHERIT;
ALTER ROLE br_record_operator_app NOINHERIT;
ALTER ROLE br_record_worker_app NOINHERIT;
ALTER ROLE br_worker_app NOINHERIT;
ALTER ROLE br_maintenance NOINHERIT;
ALTER ROLE br_probe NOINHERIT;

-- Converge: remove any membership outside the intended graph.
-- BRT-05R: br_api must never reach the catalog writer (also removes the BRT-05 grant on upgrade).
-- BRT-07: br_api must never reach the verification-policy writer.
-- BRT-08: br_api must never reach the achievement-rule writer.
-- BRT-09: br_api must never reach the record-category writer.
REVOKE br_worker, br_rebuild, br_identity_private, br_catalog, br_verification_policy, br_achievement_rules, br_record_rules FROM br_api;
REVOKE br_owner, br_authority, br_results, br_worker, br_rebuild, br_identity, br_identity_private, br_organizations, br_public_read, br_competition, br_evidence, br_verification, br_verification_policy, br_achievements, br_achievement_rules, br_verification_reader, br_records, br_record_rules FROM br_operator_app;
REVOKE br_owner, br_authority, br_results, br_worker, br_rebuild, br_identity, br_identity_private, br_organizations, br_public_read, br_catalog, br_competition, br_evidence, br_verification, br_achievements, br_achievement_rules, br_verification_reader, br_records, br_record_rules FROM br_verification_operator_app;
REVOKE br_owner, br_authority, br_results, br_worker, br_rebuild, br_identity, br_identity_private, br_organizations, br_public_read, br_catalog, br_competition, br_evidence, br_verification, br_verification_policy, br_achievements, br_verification_reader, br_records, br_record_rules FROM br_achievement_operator_app;
REVOKE br_authority, br_results, br_worker, br_rebuild, br_identity, br_organizations, br_public_read, br_catalog, br_competition, br_evidence, br_verification, br_verification_policy, br_achievements, br_achievement_rules, br_verification_reader, br_records, br_record_rules FROM br_api_vault;
REVOKE br_authority, br_results, br_rebuild, br_identity, br_identity_private, br_organizations, br_public_read, br_catalog, br_competition, br_evidence, br_verification, br_verification_policy, br_achievements, br_achievement_rules, br_verification_reader, br_records, br_record_rules FROM br_worker_app;
REVOKE br_owner, br_authority, br_results, br_worker, br_rebuild, br_identity, br_identity_private, br_organizations, br_public_read, br_catalog, br_competition, br_evidence, br_verification, br_verification_policy, br_achievement_rules, br_records, br_record_rules FROM br_achievement_worker_app;
REVOKE br_authority, br_results, br_worker, br_identity, br_identity_private, br_organizations, br_public_read, br_catalog, br_competition, br_evidence, br_verification, br_verification_policy, br_achievements, br_achievement_rules, br_verification_reader, br_records, br_record_rules FROM br_maintenance;
REVOKE br_authority, br_results, br_worker, br_rebuild, br_identity, br_identity_private, br_organizations, br_public_read, br_catalog, br_competition, br_evidence, br_verification, br_verification_policy, br_achievements, br_achievement_rules, br_verification_reader, br_records, br_record_rules FROM br_probe, br_owner;
REVOKE br_owner, br_authority, br_results, br_worker, br_rebuild, br_identity, br_identity_private, br_organizations, br_public_read, br_catalog, br_competition, br_evidence, br_verification, br_verification_policy, br_achievements, br_achievement_rules, br_verification_reader, br_records FROM br_record_operator_app;
REVOKE br_owner, br_authority, br_results, br_worker, br_rebuild, br_identity, br_identity_private, br_organizations, br_public_read, br_catalog, br_competition, br_evidence, br_verification, br_verification_policy, br_achievements, br_achievement_rules, br_record_rules FROM br_record_worker_app;
REVOKE br_owner FROM br_api, br_api_vault, br_operator_app, br_verification_operator_app, br_achievement_operator_app, br_achievement_worker_app, br_record_operator_app, br_record_worker_app, br_worker_app, br_maintenance, br_probe;

GRANT br_authority, br_results, br_identity, br_organizations, br_public_read, br_competition, br_evidence, br_verification, br_achievements, br_verification_reader, br_records TO br_api WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
GRANT br_catalog TO br_operator_app WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
GRANT br_verification_policy TO br_verification_operator_app WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
GRANT br_achievement_rules TO br_achievement_operator_app WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
GRANT br_identity_private TO br_api_vault WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
GRANT br_worker TO br_worker_app WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
GRANT br_achievements, br_verification_reader TO br_achievement_worker_app WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
GRANT br_record_rules TO br_record_operator_app WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
GRANT br_records, br_verification_reader TO br_record_worker_app WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
GRANT br_rebuild TO br_maintenance WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
