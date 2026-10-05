-- BRT-07 · Verification policies: stable policy identities, immutable declarative policy versions
-- (br:verification-policy@1), an append-only DRAFT → PUBLISHED → RETIRED lifecycle, and append-only
-- bindings of PUBLISHED versions to EXACT DisciplineVersions.
--
-- Policies are DATA (closed criterion vocabulary; no SQL, scripts, expressions or plugins). They are
-- validated by @br/verification before a version row can exist; the database adds the structural
-- guarantees: immutability, no backdating, no ambiguous overlapping bindings.
--
-- Table classes: every table here is A (append-only). Lifecycle and bindings are facts, never UPDATEs.
-- Verification ≠ Result state: nothing in this schema (or any other) adds a verified / level column
-- to results.
CREATE SCHEMA verification;
REVOKE ALL ON SCHEMA verification FROM PUBLIC;

-- A · Policy identity (stable code; names are labels only).
CREATE TABLE verification.policy (
  id                    uuid PRIMARY KEY,
  code                  text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  name                  text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL
);

-- A · Immutable policy version: the normalized spec, its domain-separated hash
-- H("verification-policy", br:verification-policy@1, JCS) and the engine semantics it targets.
-- Immutable from creation (append-only for every role, including the owner).
CREATE TABLE verification.policy_version (
  id                    uuid PRIMARY KEY,
  policy_id             uuid NOT NULL REFERENCES verification.policy (id),
  version               integer NOT NULL CHECK (version BETWEEN 1 AND 100000),
  spec                  jsonb NOT NULL CHECK (jsonb_typeof(spec) = 'object' AND octet_length(spec::text) <= 32768),
  spec_schema           text NOT NULL CHECK (spec_schema = 'br:verification-policy@1'),
  spec_hash             platform.content_hash NOT NULL,
  target_engine         text NOT NULL CHECK (target_engine ~ '^verification-engine/[1-9][0-9]{0,3}$'),
  created_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL,
  CONSTRAINT policy_version_number_key UNIQUE (policy_id, version),
  CONSTRAINT policy_version_spec_key UNIQUE (policy_id, spec_hash),
  CHECK (spec->>'targetEngine' = target_engine)
);

-- A · Lifecycle facts. No row = DRAFT; PUBLISHED at most once; RETIRED only after PUBLISHED.
CREATE TABLE verification.policy_version_status_change (
  id                uuid PRIMARY KEY,
  policy_version_id uuid NOT NULL REFERENCES verification.policy_version (id),
  status            text NOT NULL CHECK (status IN ('PUBLISHED', 'RETIRED')),
  actor_account_id  uuid NOT NULL REFERENCES identity.account (id),
  recorded_at       timestamptz NOT NULL,
  seq               bigint GENERATED ALWAYS AS IDENTITY,
  CONSTRAINT policy_version_status_once UNIQUE (policy_version_id, status)
);

CREATE VIEW verification.v_policy_version_current AS
  SELECT v.id AS policy_version_id, v.policy_id,
         COALESCE((SELECT s.status FROM verification.policy_version_status_change s
                   WHERE s.policy_version_id = v.id ORDER BY s.seq DESC LIMIT 1), 'DRAFT') AS status
  FROM verification.policy_version v;

-- Lifecycle transitions are linearized per version (advisory lock) and must follow
-- DRAFT → PUBLISHED → RETIRED; the UNIQUE constraint is the second line of defence.
CREATE FUNCTION verification.assert_policy_transition() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cur text;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('verification-policy-version:' || NEW.policy_version_id::text, 0));
  SELECT s.status INTO cur FROM verification.policy_version_status_change s
    WHERE s.policy_version_id = NEW.policy_version_id ORDER BY s.seq DESC LIMIT 1;
  IF NOT ((cur IS NULL AND NEW.status = 'PUBLISHED') OR (cur = 'PUBLISHED' AND NEW.status = 'RETIRED')) THEN
    RAISE EXCEPTION 'policy version transition % → % is not permitted', COALESCE(cur, 'DRAFT'), NEW.status
      USING ERRCODE = 'BR090';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER policy_version_transition BEFORE INSERT ON verification.policy_version_status_change
  FOR EACH ROW EXECUTE FUNCTION verification.assert_policy_transition();

-- A · Binding of a PUBLISHED policy version to an EXACT DisciplineVersion (never a sport, a mutable
-- discipline or a name). Append-only history: the binding in force at time T is the latest one with
-- effective_from ≤ T (as known at T). No backdating (strict, no skew). Effective times strictly
-- increase per DisciplineVersion, so two bindings can never apply at the same instant.
CREATE TABLE verification.policy_binding (
  id                    uuid PRIMARY KEY,
  discipline_version_id uuid NOT NULL REFERENCES sports.discipline_version (id),
  policy_version_id     uuid NOT NULL REFERENCES verification.policy_version (id),
  effective_from        timestamptz NOT NULL,
  actor_account_id      uuid NOT NULL REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL,
  seq                   bigint GENERATED ALWAYS AS IDENTITY,
  CHECK (effective_from >= recorded_at)
);
CREATE INDEX policy_binding_dv_idx ON verification.policy_binding (discipline_version_id, effective_from DESC, seq DESC);

CREATE FUNCTION verification.assert_policy_binding() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  latest timestamptz;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('verification-binding:' || NEW.discipline_version_id::text, 0));
  IF NOT EXISTS (SELECT 1 FROM verification.v_policy_version_current c
                 WHERE c.policy_version_id = NEW.policy_version_id AND c.status = 'PUBLISHED') THEN
    RAISE EXCEPTION 'only a PUBLISHED policy version can be bound' USING ERRCODE = 'BR091';
  END IF;
  SELECT max(b.effective_from) INTO latest FROM verification.policy_binding b
    WHERE b.discipline_version_id = NEW.discipline_version_id;
  IF latest IS NOT NULL AND NEW.effective_from <= latest THEN
    RAISE EXCEPTION 'a binding must take effect strictly after the previous binding for this discipline version'
      USING ERRCODE = 'BR092';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER policy_binding_rules BEFORE INSERT ON verification.policy_binding
  FOR EACH ROW EXECUTE FUNCTION verification.assert_policy_binding();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['policy', 'policy_version', 'policy_version_status_change', 'policy_binding'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON verification.%I FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON verification.%I FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation()', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON verification.%I FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at()', t || '_recorded_at', t);
    -- Policy operator (br_verification_policy): create, publish, retire, bind — nothing else.
    EXECUTE format('GRANT SELECT, INSERT ON verification.%I TO br_verification_policy', t);
    -- Verification runtime and rebuild: read-only.
    EXECUTE format('GRANT SELECT ON verification.%I TO br_verification, br_rebuild', t);
  END LOOP;
END
$$;
REVOKE ALL ON FUNCTION verification.assert_policy_transition(), verification.assert_policy_binding() FROM PUBLIC;
GRANT USAGE ON SCHEMA verification TO br_verification_policy, br_verification, br_rebuild;
GRANT SELECT ON verification.v_policy_version_current TO br_verification_policy, br_verification, br_rebuild;

-- Policy operator plumbing: platform time, outbox, audit, idempotency; exact discipline versions
-- (public catalog facts) to bind against. No results, evidence, authority, competition or PII.
GRANT USAGE ON SCHEMA platform TO br_verification_policy;
GRANT EXECUTE ON FUNCTION platform.tx_time_ms() TO br_verification_policy;
GRANT SELECT, INSERT ON platform.outbox_event TO br_verification_policy;
GRANT SELECT, INSERT ON platform.command_idempotency TO br_verification_policy;
GRANT INSERT ON platform.audit_event TO br_verification_policy;
GRANT USAGE ON SCHEMA sports TO br_verification_policy;
GRANT SELECT ON sports.discipline_version, sports.v_discipline_version_current TO br_verification_policy;
