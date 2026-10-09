-- BRT-05 · Sport catalog: Sport → Discipline → DisciplineVersion, FormatTemplate → FormatVersion.
-- Sports, disciplines and formats are DATA (never columns). Versions pin semantics and are
-- immutable from creation; only PUBLISHED versions can be pinned by an Event. Catalog mutation is
-- INTERNAL/operator-only (module role br_catalog); organizers only read the catalog.
--
-- Table classes (BRT-02 persistence §3.0):
--   A  append-only facts / status histories (no UPDATE/DELETE/TRUNCATE; triggers)

CREATE SCHEMA sports;
REVOKE ALL ON SCHEMA sports FROM PUBLIC;

-- A · Sport (e.g. "padel"). Code format = authority `sport` scope dimension.
CREATE TABLE sports.sport (
  id                    uuid PRIMARY KEY,
  code                  text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9]+(?:[-_][a-z0-9]+)*$' AND length(code) <= 64),
  name                  text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  created_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL
);

-- A · Discipline (e.g. "padel.doubles"): sport-namespaced dotted code (authority `discipline`).
CREATE TABLE sports.discipline (
  id                    uuid PRIMARY KEY,
  sport_id              uuid NOT NULL REFERENCES sports.sport (id),
  code                  text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)+$' AND length(code) <= 128),
  name                  text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  created_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL
);
-- The discipline code must live in its sport's namespace.
CREATE FUNCTION sports.assert_discipline_namespace() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sports.sport s WHERE s.id = NEW.sport_id AND NEW.code LIKE s.code || '.%') THEN
    RAISE EXCEPTION 'discipline code % is not in its sport namespace', NEW.code USING ERRCODE = 'BR005';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER discipline_namespace BEFORE INSERT ON sports.discipline
  FOR EACH ROW EXECUTE FUNCTION sports.assert_discipline_namespace();

-- A · DisciplineVersion: the full spec (result schema, metrics, comparator, validation, allowed
-- contest types, participation, evidence expectations) is immutable from creation.
CREATE TABLE sports.discipline_version (
  id                    uuid PRIMARY KEY,
  discipline_id         uuid NOT NULL REFERENCES sports.discipline (id),
  version               integer NOT NULL CHECK (version BETWEEN 1 AND 10000),
  spec                  jsonb NOT NULL CHECK (jsonb_typeof(spec) = 'object' AND octet_length(spec::text) <= 65536),
  spec_hash             text NOT NULL CHECK (spec_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL,
  UNIQUE (discipline_id, version)
);
CREATE TABLE sports.discipline_version_status_change (
  id                    uuid PRIMARY KEY,
  discipline_version_id uuid NOT NULL REFERENCES sports.discipline_version (id),
  status                text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
  actor_account_id      uuid,
  recorded_at           timestamptz NOT NULL,
  seq                   bigint GENERATED ALWAYS AS IDENTITY
);

-- A · FormatTemplate (e.g. "single-elimination") and FormatVersion (pins an exact engine version
-- and the BR-JSON schema of per-event configuration). Structure ≠ sporting rules.
CREATE TABLE sports.format_template (
  id                    uuid PRIMARY KEY,
  code                  text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND length(code) <= 64),
  name                  text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  created_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL
);
CREATE TABLE sports.format_version (
  id                    uuid PRIMARY KEY,
  template_id           uuid NOT NULL REFERENCES sports.format_template (id),
  version               integer NOT NULL CHECK (version BETWEEN 1 AND 10000),
  engine_id             text NOT NULL CHECK (engine_id ~ '^[a-z0-9-]+$' AND length(engine_id) <= 64),
  engine_version        integer NOT NULL CHECK (engine_version BETWEEN 1 AND 1000),
  configuration_schema  jsonb NOT NULL CHECK (jsonb_typeof(configuration_schema) = 'object' AND octet_length(configuration_schema::text) <= 16384),
  spec_hash             text NOT NULL CHECK (spec_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL,
  UNIQUE (template_id, version)
);
CREATE TABLE sports.format_version_status_change (
  id                uuid PRIMARY KEY,
  format_version_id uuid NOT NULL REFERENCES sports.format_version (id),
  status            text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
  actor_account_id  uuid,
  recorded_at       timestamptz NOT NULL,
  seq               bigint GENERATED ALWAYS AS IDENTITY
);

CREATE VIEW sports.v_discipline_version_current AS
  SELECT DISTINCT ON (discipline_version_id) discipline_version_id, status, recorded_at
  FROM sports.discipline_version_status_change ORDER BY discipline_version_id, seq DESC;
CREATE VIEW sports.v_format_version_current AS
  SELECT DISTINCT ON (format_version_id) format_version_id, status, recorded_at
  FROM sports.format_version_status_change ORDER BY format_version_id, seq DESC;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sport', 'discipline', 'discipline_version', 'discipline_version_status_change',
                           'format_template', 'format_version', 'format_version_status_change'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON sports.%I FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON sports.%I FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation()', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON sports.%I FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at()', t || '_recorded_at', t);
    EXECUTE format('GRANT SELECT, INSERT ON sports.%I TO br_catalog', t);
  END LOOP;
END
$$;

-- br_catalog: the only writer (INTERNAL / operator commands).
GRANT USAGE ON SCHEMA platform TO br_catalog;
GRANT EXECUTE ON FUNCTION platform.tx_time_ms() TO br_catalog;
GRANT SELECT, INSERT ON platform.outbox_event TO br_catalog;
GRANT SELECT, INSERT ON platform.command_idempotency TO br_catalog;
GRANT INSERT ON platform.audit_event TO br_catalog;
GRANT USAGE ON SCHEMA sports TO br_catalog;
GRANT SELECT ON sports.v_discipline_version_current, sports.v_format_version_current TO br_catalog;

-- Readers: competition operations (pin versions), the public read path (catalog listing and
-- event pages), and projection rebuilds. None may write the catalog.
GRANT USAGE ON SCHEMA sports TO br_competition, br_public_read, br_rebuild;
GRANT SELECT ON ALL TABLES IN SCHEMA sports TO br_competition, br_public_read, br_rebuild;
