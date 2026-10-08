-- ONCF-05E-A · Competition resources and availability (ADR-0066, ADR-0067, ADR-0068).
-- Additive only: 0001–0034 are untouched; contest_schedule and POST /v1/contests/:id/schedule are
-- NOT changed here (that is 05E-C). Nothing here stores occupancy or a "reserved" state: occupancy
-- is derived from schedules later. No column name matches the ranking guards.
--
--   competition.resource                 · identity of a competition-scoped resource (type fixed at creation)
--   competition.resource_revision        · append-only revisions: label, attributes, capacity, exclusivity
--                                          keys, venue, zone, lifecycle (ACTIVE / RETIRED) + reason
--   competition.v_resource_current       · the current revision of every resource
--   competition.resource_availability    · append-only availability facts (WEEKLY, DATE_OPEN, DATE_CLOSED,
--                                          BLACKOUT, MAINTENANCE); resource_id NULL = competition-wide
--   competition.resource_availability_revocation · a fact stops applying (with a reason); never deleted
--   competition.v_resource_availability_current  · facts that still apply

CREATE TABLE competition.resource (
  id                    uuid PRIMARY KEY,
  competition_id        uuid NOT NULL REFERENCES competition.competition (id),
  -- The catalog ResourceType vocabulary (packages/competition capabilities.ts): data, not code.
  type_code             text NOT NULL CHECK (type_code IN ('TENNIS_COURT', 'PADEL_COURT', 'BASKETBALL_COURT',
                          'BASKETBALL_HALF_COURT', 'BOWLING_LANE_PAIR', 'POOL', 'TRACK', 'ROAD_COURSE',
                          'OPEN_WATER_COURSE', 'CYCLING_COURSE', 'GOLF_COURSE')),
  created_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL
);
-- Every scheduling read starts from "the resources of this competition".
CREATE INDEX resource_competition_idx ON competition.resource (competition_id);

CREATE TABLE competition.resource_revision (
  id                    uuid PRIMARY KEY,
  resource_id           uuid NOT NULL REFERENCES competition.resource (id),
  revision              integer NOT NULL CHECK (revision >= 1),
  label                 text NOT NULL CHECK (length(label) BETWEEN 1 AND 80 AND label = btrim(label)),
  attributes            jsonb NOT NULL CHECK (jsonb_typeof(attributes) = 'object' AND octet_length(attributes::text) <= 2048),
  capacity              integer NOT NULL CHECK (capacity BETWEEN 1 AND 100000),
  -- Physical overlap: two resources share space iff their key sets intersect (ADR-0067 group as a key set).
  exclusivity_keys      text[] NOT NULL DEFAULT '{}'
                          CHECK (cardinality(exclusivity_keys) <= 8
                                 AND array_to_string(exclusivity_keys, ',') ~ '^([a-z0-9][a-z0-9-]{0,39}(,|$))*$'),
  venue_organization_id uuid REFERENCES organizations.organization (id),
  location_label        text CHECK (location_label IS NULL OR length(location_label) BETWEEN 1 AND 120),
  -- NULL: the competition's zone (inherited explicitly, not copied).
  timezone              text CHECK (timezone IS NULL OR length(timezone) BETWEEN 1 AND 64),
  status                text NOT NULL CHECK (status IN ('ACTIVE', 'RETIRED')),
  reason                text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  actor_account_id      uuid NOT NULL REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL,
  seq                   bigint GENERATED ALWAYS AS IDENTITY,
  UNIQUE (resource_id, revision)
);
-- Current revision lookup (DISTINCT ON resource_id ORDER BY seq DESC).
CREATE INDEX resource_revision_current_idx ON competition.resource_revision (resource_id, seq DESC);

CREATE VIEW competition.v_resource_current AS
  SELECT DISTINCT ON (rv.resource_id)
         r.id AS resource_id, r.competition_id, r.type_code, rv.revision, rv.label, rv.attributes, rv.capacity,
         rv.exclusivity_keys, rv.venue_organization_id, rv.location_label, rv.timezone, rv.status, rv.recorded_at
  FROM competition.resource_revision rv JOIN competition.resource r ON r.id = rv.resource_id
  ORDER BY rv.resource_id, rv.seq DESC;

CREATE TABLE competition.resource_availability (
  id                    uuid PRIMARY KEY,
  competition_id        uuid NOT NULL REFERENCES competition.competition (id),
  resource_id           uuid REFERENCES competition.resource (id),
  kind                  text NOT NULL CHECK (kind IN ('WEEKLY', 'DATE_OPEN', 'DATE_CLOSED', 'BLACKOUT', 'MAINTENANCE')),
  weekday               smallint CHECK (weekday IS NULL OR weekday BETWEEN 1 AND 7),
  local_date            date,
  local_start           text CHECK (local_start IS NULL OR local_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  local_end             text CHECK (local_end IS NULL OR local_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$|^24:00$'),
  valid_from            date,
  valid_to              date,
  starts_at             timestamptz,
  ends_at               timestamptz,
  reason                text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  created_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL,
  -- Shape per kind: local rules carry wall-clock times (never pre-converted); absolute periods carry
  -- instants and a reason.
  CHECK (
       (kind = 'WEEKLY' AND weekday IS NOT NULL AND local_start IS NOT NULL AND local_end IS NOT NULL
          AND local_date IS NULL AND starts_at IS NULL AND ends_at IS NULL
          AND (valid_from IS NULL OR valid_to IS NULL OR valid_to >= valid_from))
    OR (kind = 'DATE_OPEN' AND local_date IS NOT NULL AND local_start IS NOT NULL AND local_end IS NOT NULL
          AND weekday IS NULL AND valid_from IS NULL AND valid_to IS NULL AND starts_at IS NULL AND ends_at IS NULL)
    OR (kind = 'DATE_CLOSED' AND local_date IS NOT NULL AND weekday IS NULL AND local_start IS NULL AND local_end IS NULL
          AND valid_from IS NULL AND valid_to IS NULL AND starts_at IS NULL AND ends_at IS NULL)
    OR (kind IN ('BLACKOUT', 'MAINTENANCE') AND starts_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at > starts_at
          AND reason IS NOT NULL AND weekday IS NULL AND local_date IS NULL AND local_start IS NULL AND local_end IS NULL
          AND valid_from IS NULL AND valid_to IS NULL)
  )
);
-- Availability of one resource (and the competition-wide layer, resource_id NULL) for evaluation.
CREATE INDEX resource_availability_resource_idx ON competition.resource_availability (competition_id, resource_id);
-- Absolute periods by time: future scheduling asks "which blackouts touch this window?" for many resources.
CREATE INDEX resource_availability_period_idx ON competition.resource_availability (resource_id, starts_at, ends_at)
  WHERE kind IN ('BLACKOUT', 'MAINTENANCE');

CREATE TABLE competition.resource_availability_revocation (
  availability_id  uuid PRIMARY KEY REFERENCES competition.resource_availability (id),
  reason           text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  actor_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at      timestamptz NOT NULL
);

CREATE VIEW competition.v_resource_availability_current AS
  SELECT a.* FROM competition.resource_availability a
  WHERE NOT EXISTS (SELECT 1 FROM competition.resource_availability_revocation x WHERE x.availability_id = a.id);

-- Integrity: a resource-level fact belongs to a resource of the same competition.
CREATE FUNCTION competition.assert_availability_same_competition() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.resource_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM competition.resource r WHERE r.id = NEW.resource_id AND r.competition_id = NEW.competition_id) THEN
    RAISE EXCEPTION 'availability resource belongs to another competition' USING ERRCODE = 'BR006';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER resource_availability_same_competition BEFORE INSERT ON competition.resource_availability
  FOR EACH ROW EXECUTE FUNCTION competition.assert_availability_same_competition();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['resource', 'resource_revision', 'resource_availability', 'resource_availability_revocation'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON competition.%I FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON competition.%I FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation()', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON competition.%I FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at()', t || '_recorded_at', t);
    EXECUTE format('GRANT SELECT, INSERT ON competition.%I TO br_competition', t);
    EXECUTE format('GRANT SELECT ON competition.%I TO br_rebuild', t);
  END LOOP;
END
$$;
GRANT SELECT ON competition.v_resource_current, competition.v_resource_availability_current TO br_competition, br_rebuild;
