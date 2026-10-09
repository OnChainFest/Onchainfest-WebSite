-- ONCF-05E-B · SchedulingProfile v1 (ADR-0069, ADR-0072). Additive:
--   sports.scheduling_profile / _version (+ status)      · the SchedulingProfile axis (catalog, versioned, hashed)
--   competition.event_scoring.scheduling_profile_version_id · pinned with the scoring axes, frozen at lock
-- Catalog rows follow 0033/0034: immutable versions, DRAFT → PUBLISHED → RETIRED as append-only
-- facts, br_catalog the only writer. The spec is stored in its canonical form (requirements in a
-- content-derived order) and `spec_hash = catalogSpecHash('br:scheduling-profile-spec', spec)`.
-- `spec_version` is the spec's SHAPE (`specVersion`), distinct from the catalog `version` (content).
-- No schedule, assignment, conflict or occupancy table is created here (05E-C/D/E).

CREATE TABLE sports.scheduling_profile (
  id                    uuid PRIMARY KEY,
  code                  text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND length(code) <= 64),
  name                  text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL
);
CREATE TABLE sports.scheduling_profile_version (
  id                    uuid PRIMARY KEY,
  profile_id            uuid NOT NULL REFERENCES sports.scheduling_profile (id),
  version               integer NOT NULL CHECK (version BETWEEN 1 AND 10000),
  spec_version          integer NOT NULL CHECK (spec_version = 1),
  spec                  jsonb NOT NULL CHECK (
                          jsonb_typeof(spec) = 'object' AND octet_length(spec::text) <= 16384
                          AND spec -> 'specVersion' = to_jsonb(spec_version)
                          AND jsonb_typeof(spec -> 'requirements') = 'array'
                          AND jsonb_array_length(spec -> 'requirements') BETWEEN 1 AND 32),
  spec_hash             text NOT NULL CHECK (spec_hash ~ '^sha256:[0-9a-f]{64}$'),
  basis                 jsonb NOT NULL CHECK (jsonb_typeof(basis) = 'object' AND octet_length(basis::text) <= 2048),
  created_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL,
  UNIQUE (profile_id, version),
  -- Identical content is one version: a semantic change is always a new spec (and hash).
  UNIQUE (profile_id, spec_hash)
);
CREATE TABLE sports.scheduling_profile_version_status_change (
  id                            uuid PRIMARY KEY,
  scheduling_profile_version_id uuid NOT NULL REFERENCES sports.scheduling_profile_version (id),
  status                        text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
  actor_account_id              uuid,
  recorded_at                   timestamptz NOT NULL,
  seq                           bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX scheduling_profile_version_status_idx
  ON sports.scheduling_profile_version_status_change (scheduling_profile_version_id, seq);
CREATE VIEW sports.v_scheduling_profile_version_current AS
  SELECT DISTINCT ON (scheduling_profile_version_id) scheduling_profile_version_id, status, recorded_at
  FROM sports.scheduling_profile_version_status_change ORDER BY scheduling_profile_version_id, seq DESC;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['scheduling_profile', 'scheduling_profile_version', 'scheduling_profile_version_status_change'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON sports.%I FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON sports.%I FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation()', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON sports.%I FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at()', t || '_recorded_at', t);
    EXECUTE format('GRANT SELECT, INSERT ON sports.%I TO br_catalog', t);
    EXECUTE format('GRANT SELECT ON sports.%I TO br_competition, br_public_read, br_rebuild', t);
  END LOOP;
END
$$;
GRANT SELECT ON sports.v_scheduling_profile_version_current TO br_catalog, br_competition, br_public_read, br_rebuild;

-- ─────────────────────────────── pin (with the scoring axes) ───────────────────────────────

ALTER TABLE competition.event_scoring
  ADD COLUMN scheduling_profile_version_id uuid REFERENCES sports.scheduling_profile_version (id);
DROP VIEW competition.v_event_scoring_current;
CREATE VIEW competition.v_event_scoring_current AS
  SELECT DISTINCT ON (event_id) id, event_id, ruleset_version_id, classification_template_version_id, stage_overrides,
         advancement_policy_version_id, scheduling_profile_version_id, pinned_by_account_id, recorded_at
  FROM competition.event_scoring ORDER BY event_id, seq DESC;
GRANT SELECT ON competition.v_event_scoring_current TO br_competition, br_rebuild;

-- The store checks the same rules first; the database refuses what bypasses it:
--   · only a PUBLISHED profile version can be pinned (a DRAFT or RETIRED one cannot);
--   · once the event's field is locked (any status past REGISTRATION_CLOSED) the profile pin is frozen.
CREATE FUNCTION competition.assert_event_scheduling_profile_pin() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  current_profile uuid;
  event_status text;
BEGIN
  IF NEW.scheduling_profile_version_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM sports.v_scheduling_profile_version_current c
       WHERE c.scheduling_profile_version_id = NEW.scheduling_profile_version_id AND c.status = 'PUBLISHED') THEN
    RAISE EXCEPTION 'only a PUBLISHED scheduling profile version can be pinned' USING ERRCODE = 'BR006';
  END IF;
  SELECT s.scheduling_profile_version_id INTO current_profile
    FROM competition.event_scoring s WHERE s.event_id = NEW.event_id ORDER BY s.seq DESC LIMIT 1;
  SELECT e.status INTO event_status FROM competition.v_event_current e WHERE e.event_id = NEW.event_id;
  IF event_status NOT IN ('DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED')
     AND NEW.scheduling_profile_version_id IS DISTINCT FROM current_profile THEN
    RAISE EXCEPTION 'the scheduling profile pin is frozen once the field is locked' USING ERRCODE = 'BR006';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER event_scoring_scheduling_profile_pin BEFORE INSERT ON competition.event_scoring
  FOR EACH ROW EXECUTE FUNCTION competition.assert_event_scheduling_profile_pin();
