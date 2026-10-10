-- ONCF-05E-C · Schedule versions, assignments, publication (ADR-0070, ADR-0071, ADR-0073).
-- Additive: 0001–0036 are untouched. No feasibility logic lives here (that is the 05E-D engine):
-- the database only keeps the schedule model's structural integrity.
--
--   resource_revision.occupancy_mode         · declared simultaneous occupancy EXCLUSIVE | SHARED (ADR-0073 B2)
--   competition.schedule_version             · one competition schedule version (number, base version)
--   competition.schedule_version_status_change · append-only DRAFT → PUBLISHED → SUPERSEDED | DRAFT → DISCARDED
--   competition.schedule_assignment          · append-only per-contest facts: ≤ 1 resource, concrete interval,
--                                              stored changeover, unit key, provisional / locked / removed flags
--   competition.schedule_publication         · the report (hash, coverage, acknowledgements) a publication used
--   contest_schedule.resource_id             · the published projection now also carries the resource
-- No column name matches the ranking guards.

-- ───────────────────────── resource occupancy mode (ADR-0073 B2) ─────────────────────────

-- Write-time default per catalog resource type: vocabulary DATA, identical to
-- RESOURCE_TYPE_DEFAULT_OCCUPANCY_MODE in @br/competition (a test compares them). Engines never call
-- it: they read the mode stored on the revision.
CREATE FUNCTION competition.default_occupancy_mode(type_code text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN type_code IN ('TENNIS_COURT', 'PADEL_COURT', 'BASKETBALL_COURT', 'BASKETBALL_HALF_COURT',
                       'BOWLING_LANE_PAIR', 'POOL', 'TRACK') THEN 'EXCLUSIVE'
    WHEN type_code IN ('ROAD_COURSE', 'OPEN_WATER_COURSE', 'CYCLING_COURSE', 'GOLF_COURSE') THEN 'SHARED'
  END
$$;

ALTER TABLE competition.resource_revision ADD COLUMN occupancy_mode text;

-- ONE-TIME MIGRATION EXCEPTION (documented in docs/implementation/ONCF-05E-C-SCHEDULE-VERSIONS.md):
-- every existing revision receives an explicit, deterministic value from the type default. The
-- append-only trigger is disabled ONLY for this single UPDATE, inside this migration's transaction
-- (the runner wraps each file in BEGIN/COMMIT), and re-enabled before anything else runs. No
-- synthetic revision and no actor is fabricated; afterwards the column is NOT NULL and the table is
-- append-only again for every role.
ALTER TABLE competition.resource_revision DISABLE TRIGGER resource_revision_append_only;
UPDATE competition.resource_revision rv
   SET occupancy_mode = competition.default_occupancy_mode(r.type_code)
  FROM competition.resource r
 WHERE r.id = rv.resource_id;
ALTER TABLE competition.resource_revision ENABLE TRIGGER resource_revision_append_only;
ALTER TABLE competition.resource_revision
  ALTER COLUMN occupancy_mode SET NOT NULL,
  ADD CONSTRAINT resource_revision_occupancy_mode CHECK (occupancy_mode IN ('EXCLUSIVE', 'SHARED'));

-- Appended columns only (existing readers keep their shape).
CREATE OR REPLACE VIEW competition.v_resource_current AS
  SELECT DISTINCT ON (rv.resource_id)
         r.id AS resource_id, r.competition_id, r.type_code, rv.revision, rv.label, rv.attributes, rv.capacity,
         rv.exclusivity_keys, rv.venue_organization_id, rv.location_label, rv.timezone, rv.status, rv.recorded_at,
         rv.occupancy_mode, rv.id AS revision_id
  FROM competition.resource_revision rv JOIN competition.resource r ON r.id = rv.resource_id
  ORDER BY rv.resource_id, rv.seq DESC;

-- ───────────────────────── schedule versions (ADR-0070 §1) ─────────────────────────

CREATE TABLE competition.schedule_version (
  id                    uuid PRIMARY KEY,
  competition_id        uuid NOT NULL REFERENCES competition.competition (id),
  version_number        integer NOT NULL CHECK (version_number >= 1),
  -- The published version a draft was opened from (NULL: an empty start or the migrated version 1).
  base_version_id       uuid REFERENCES competition.schedule_version (id),
  -- NULL only for the version 0037 migrates from contest_schedule.
  created_by_account_id uuid REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL,
  UNIQUE (competition_id, version_number),
  UNIQUE (id, competition_id)
);
CREATE INDEX schedule_version_competition_idx ON competition.schedule_version (competition_id);

CREATE TABLE competition.schedule_version_status_change (
  id               uuid PRIMARY KEY,
  version_id       uuid NOT NULL REFERENCES competition.schedule_version (id),
  status           text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'SUPERSEDED', 'DISCARDED')),
  reason           text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  actor_account_id uuid REFERENCES identity.account (id),
  recorded_at      timestamptz NOT NULL,
  seq              bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX schedule_version_status_change_idx
  ON competition.schedule_version_status_change (version_id, seq DESC);

CREATE VIEW competition.v_schedule_version_current AS
  SELECT DISTINCT ON (sc.version_id)
         v.id AS version_id, v.competition_id, v.version_number, v.base_version_id, v.created_by_account_id,
         v.recorded_at, sc.status, sc.reason AS status_reason, sc.actor_account_id AS status_actor_account_id,
         sc.recorded_at AS status_recorded_at
  FROM competition.schedule_version_status_change sc
  JOIN competition.schedule_version v ON v.id = sc.version_id
  ORDER BY sc.version_id, sc.seq DESC;

-- Legal status transitions; at most one DRAFT and one PUBLISHED version per competition. DISCARDED
-- and SUPERSEDED are terminal (a discarded draft is never reopened). Serialized with the store's
-- per-competition advisory lock key.
CREATE FUNCTION competition.assert_schedule_version_status() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  comp uuid;
  cur  text;
BEGIN
  SELECT competition_id INTO comp FROM competition.schedule_version WHERE id = NEW.version_id;
  PERFORM pg_advisory_xact_lock(hashtextextended('competition-schedule:' || comp::text, 0));
  SELECT status INTO cur FROM competition.schedule_version_status_change
   WHERE version_id = NEW.version_id ORDER BY seq DESC LIMIT 1;
  IF NOT ((cur IS NULL AND NEW.status IN ('DRAFT', 'PUBLISHED'))
          OR (cur = 'DRAFT' AND NEW.status IN ('PUBLISHED', 'DISCARDED'))
          OR (cur = 'PUBLISHED' AND NEW.status = 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'schedule version cannot move from % to %', coalesce(cur, 'nothing'), NEW.status
      USING ERRCODE = 'BR006';
  END IF;
  IF NEW.status IN ('DRAFT', 'PUBLISHED') AND EXISTS (
       SELECT 1 FROM competition.v_schedule_version_current c
        WHERE c.competition_id = comp AND c.status = NEW.status AND c.version_id <> NEW.version_id) THEN
    RAISE EXCEPTION 'the competition already has a % schedule version', NEW.status USING ERRCODE = 'BR006';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER schedule_version_status_transition BEFORE INSERT ON competition.schedule_version_status_change
  FOR EACH ROW EXECUTE FUNCTION competition.assert_schedule_version_status();

-- ───────────────────────── assignments (ADR-0070 §3, ADR-0073 B8/B9) ─────────────────────────

CREATE TABLE competition.schedule_assignment (
  id                     uuid PRIMARY KEY,
  version_id             uuid NOT NULL,
  competition_id         uuid NOT NULL,
  contest_id             uuid NOT NULL REFERENCES competition.contest (id),
  -- Exactly one identified resource per contest assignment, or none (time-only / migrated).
  resource_id            uuid REFERENCES competition.resource (id),
  -- Concrete interval (whole seconds for every new placement; migrated rows keep their legacy instants).
  starts_at              timestamptz NOT NULL,
  expected_end           timestamptz,
  -- Stored changeover: authoritative for the conflict engine (never recomputed from the profile).
  changeover_seconds     integer NOT NULL CHECK (changeover_seconds BETWEEN 0 AND 86400),
  -- The IANA zone the assignment was planned in (ADR-0068 §2).
  zone                   text NOT NULL CHECK (length(zone) BETWEEN 1 AND 64),
  unit_key               text CHECK (unit_key IS NULL OR unit_key ~
                           '^(contest:[0-9a-f-]{36}|partition:[0-9a-f-]{36}:[a-z][0-9]{1,5}|regroup:[0-9a-f-]{36}:[0-9]{1,5})$'),
  provisional            boolean NOT NULL,
  locked                 boolean NOT NULL,
  removed                boolean NOT NULL,
  venue_organization_id  uuid REFERENCES organizations.organization (id),
  location_label         text CHECK (location_label IS NULL OR length(location_label) BETWEEN 1 AND 120),
  court_label            text CHECK (court_label IS NULL OR length(court_label) BETWEEN 1 AND 40),
  reason                 text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  replaces_assignment_id uuid REFERENCES competition.schedule_assignment (id),
  source                 text NOT NULL CHECK (source IN ('MANUAL', 'CARRIED', 'MIGRATED')),
  actor_account_id       uuid REFERENCES identity.account (id),
  recorded_at            timestamptz NOT NULL,
  seq                    bigint GENERATED ALWAYS AS IDENTITY,
  FOREIGN KEY (version_id, competition_id) REFERENCES competition.schedule_version (id, competition_id),
  CHECK (expected_end IS NULL OR expected_end > starts_at),
  -- New placements are whole seconds; migrated rows and their carried copies keep the legacy instant.
  CHECK (source <> 'MANUAL' OR (starts_at = date_trunc('second', starts_at)
                                AND (expected_end IS NULL OR expected_end = date_trunc('second', expected_end)))),
  -- Only legacy rows may lack a unit key (ADR-0073 B9; 05E-D recomputes them).
  CHECK (unit_key IS NOT NULL OR source <> 'MANUAL'),
  CHECK (actor_account_id IS NOT NULL OR source = 'MIGRATED')
);
CREATE INDEX schedule_assignment_current_idx
  ON competition.schedule_assignment (version_id, contest_id, seq DESC);
CREATE INDEX schedule_assignment_contest_idx ON competition.schedule_assignment (contest_id);

CREATE VIEW competition.v_schedule_assignment_current AS
  SELECT DISTINCT ON (a.version_id, a.contest_id) a.*
  FROM competition.schedule_assignment a
  ORDER BY a.version_id, a.contest_id, a.seq DESC;

-- Structural integrity: new facts go only into an open DRAFT; the contest and the resource belong to
-- the version's competition. (Feasibility is never judged here.)
CREATE FUNCTION competition.assert_schedule_assignment() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  st text;
BEGIN
  SELECT status INTO st FROM competition.v_schedule_version_current WHERE version_id = NEW.version_id;
  IF NEW.source <> 'MIGRATED' AND st IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'assignments are recorded only in an open draft (version is %)', coalesce(st, 'missing')
      USING ERRCODE = 'BR006';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM competition.contest c JOIN competition.event e ON e.id = c.event_id
                  WHERE c.id = NEW.contest_id AND e.competition_id = NEW.competition_id) THEN
    RAISE EXCEPTION 'assignment contest belongs to another competition' USING ERRCODE = 'BR006';
  END IF;
  IF NEW.resource_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM competition.resource r WHERE r.id = NEW.resource_id AND r.competition_id = NEW.competition_id) THEN
    RAISE EXCEPTION 'assignment resource belongs to another competition' USING ERRCODE = 'BR006';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER schedule_assignment_integrity BEFORE INSERT ON competition.schedule_assignment
  FOR EACH ROW EXECUTE FUNCTION competition.assert_schedule_assignment();

-- ───────────────────────── publication (ADR-0070 §4, ADR-0073 B1) ─────────────────────────

CREATE TABLE competition.schedule_publication (
  version_id                uuid PRIMARY KEY REFERENCES competition.schedule_version (id),
  competition_id            uuid NOT NULL REFERENCES competition.competition (id),
  superseded_version_id     uuid REFERENCES competition.schedule_version (id),
  report_hash               text NOT NULL CHECK (report_hash ~ '^sha256:[0-9a-f]{64}$'),
  report                    jsonb NOT NULL CHECK (jsonb_typeof(report) = 'object'),
  coverage                  text[] NOT NULL,
  acknowledged_conflict_keys text[] NOT NULL,
  actor_account_id          uuid NOT NULL REFERENCES identity.account (id),
  recorded_at               timestamptz NOT NULL
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['schedule_version', 'schedule_version_status_change', 'schedule_assignment',
                           'schedule_publication'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON competition.%I FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON competition.%I FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation()', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON competition.%I FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at()', t || '_recorded_at', t);
    EXECUTE format('GRANT SELECT, INSERT ON competition.%I TO br_competition', t);
    EXECUTE format('GRANT SELECT ON competition.%I TO br_rebuild', t);
  END LOOP;
END
$$;
GRANT SELECT ON competition.v_schedule_version_current, competition.v_schedule_assignment_current
  TO br_competition, br_rebuild;

-- ───────────────────────── the published projection ─────────────────────────

-- contest_schedule stays the public schedule and becomes the projection of the PUBLISHED version
-- (ADR-0070 §5). It also carries the published resource reference (court_label stays display text).
ALTER TABLE competition.contest_schedule ADD COLUMN resource_id uuid REFERENCES competition.resource (id);

-- ───────────────────────── legacy migration (ADR-0070 §6) ─────────────────────────

-- Every competition with contest_schedule rows and no schedule version receives version 1, PUBLISHED,
-- whose MIGRATED assignments reproduce the rows exactly: no resource, the original instants, the
-- original (possibly NULL) end — never an invented duration — no unit key, the original labels and
-- the original actor. Nothing currently public changes. A function, so tests can exercise it.
CREATE FUNCTION competition.migrate_legacy_contest_schedule() RETURNS integer
  LANGUAGE plpgsql AS $$
DECLARE
  comp uuid;
  ver  uuid;
  n    integer := 0;
BEGIN
  FOR comp IN
    SELECT DISTINCT e.competition_id
      FROM competition.contest_schedule cs
      JOIN competition.contest c ON c.id = cs.contest_id
      JOIN competition.event e ON e.id = c.event_id
     WHERE NOT EXISTS (SELECT 1 FROM competition.schedule_version v WHERE v.competition_id = e.competition_id)
     ORDER BY 1
  LOOP
    ver := uuidv7();
    INSERT INTO competition.schedule_version (id, competition_id, version_number, base_version_id,
                                              created_by_account_id, recorded_at)
      VALUES (ver, comp, 1, NULL, NULL, platform.tx_time_ms());
    INSERT INTO competition.schedule_version_status_change (id, version_id, status, reason, actor_account_id, recorded_at)
      VALUES (uuidv7(), ver, 'PUBLISHED', 'migrated from contest_schedule (ONCF-05E-C)', NULL, platform.tx_time_ms());
    INSERT INTO competition.schedule_assignment
        (id, version_id, competition_id, contest_id, resource_id, starts_at, expected_end, changeover_seconds, zone,
         unit_key, provisional, locked, removed, venue_organization_id, location_label, court_label, reason,
         replaces_assignment_id, source, actor_account_id, recorded_at)
      SELECT uuidv7(), ver, comp, cs.contest_id, NULL, cs.scheduled_start, cs.scheduled_end, 0, p.timezone,
             NULL, false, false, false, cs.venue_organization_id, cs.location_label, cs.court_label, NULL,
             NULL, 'MIGRATED', cs.updated_by_account_id, platform.tx_time_ms()
        FROM competition.contest_schedule cs
        JOIN competition.contest c ON c.id = cs.contest_id
        JOIN competition.event e ON e.id = c.event_id
        JOIN competition.event_profile p ON p.event_id = e.id
       WHERE e.competition_id = comp
       ORDER BY c.event_id, c.sequence;
    n := n + 1;
  END LOOP;
  RETURN n;
END
$$;
SELECT competition.migrate_legacy_contest_schedule();
REVOKE ALL ON FUNCTION competition.migrate_legacy_contest_schedule() FROM PUBLIC;
