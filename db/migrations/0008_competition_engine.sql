-- BRT-05 · Competition & Event engine (BRT-01 result domain §5; BRT-02 Competition +
-- Participation modules). OPERATIONS ONLY: nothing here states a result, a verification, a
-- record, a ranking or a prize. Competition/Event/Contest statuses are operational.
--
--   Competition → Event → Round → Contest → Contestant
--   Registration (entry request) → Participant (event-scoped competition identity)
--   Team (competition identity ≠ Organization) → TeamMembership (temporal) ≠ Lineup (per contest)
--
-- Table classes: A append-only facts/status histories · OP mutable operational state.
-- BRT-02 lists Competition and Participation as two modules; BRT-05 implements them as one
-- bounded operating context (module role br_competition) because field locking must create
-- Participants atomically with the lock (see docs/implementation/BRT-05-COMPETITION-ENGINE.md).

CREATE SCHEMA competition;
REVOKE ALL ON SCHEMA competition FROM PUBLIC;

-- ─────────────────────────────── competition ───────────────────────────────

-- A · Competition identity; organized by an Organization (never the same identity).
CREATE TABLE competition.competition (
  id                        uuid PRIMARY KEY,
  organizer_organization_id uuid NOT NULL REFERENCES organizations.organization (id),
  created_by_account_id     uuid NOT NULL REFERENCES identity.account (id),
  recorded_at               timestamptz NOT NULL
);
-- OP · Profile metadata (name changes never change identity). Times are UTC timestamptz; the
-- IANA timezone is display context only.
CREATE TABLE competition.competition_profile (
  competition_id        uuid PRIMARY KEY REFERENCES competition.competition (id),
  name                  text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description           text CHECK (description IS NULL OR length(description) <= 2000),
  location_label        text CHECK (location_label IS NULL OR length(location_label) <= 120),
  region_code           text CHECK (region_code IS NULL OR region_code ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'),
  timezone              text NOT NULL CHECK (length(timezone) BETWEEN 1 AND 64),
  starts_at             timestamptz,
  ends_at               timestamptz,
  website               text CHECK (website IS NULL OR website ~ '^https://[^\s<>"]{3,250}$'),
  image_ref             text CHECK (image_ref IS NULL OR image_ref ~ '^media:[0-9a-f-]{36}$'),
  updated_at            timestamptz NOT NULL,
  updated_by_account_id uuid,
  CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at >= starts_at)
);
-- A · Slug history (normalized, reserved-safe; former slugs redirect, never re-claimable).
CREATE TABLE competition.competition_slug (
  slug           text PRIMARY KEY CHECK (identity.normalized_slug_ok(slug)),
  competition_id uuid NOT NULL REFERENCES competition.competition (id),
  recorded_at    timestamptz NOT NULL,
  seq            bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX competition_slug_comp_idx ON competition.competition_slug (competition_id, seq DESC);
CREATE TABLE competition.competition_status_change (
  id               uuid PRIMARY KEY,
  competition_id   uuid NOT NULL REFERENCES competition.competition (id),
  status           text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'ACTIVE', 'COMPLETED', 'CANCELLED')),
  reason           text CHECK (reason IS NULL OR length(reason) <= 500),
  actor_account_id uuid,
  recorded_at      timestamptz NOT NULL,
  seq              bigint GENERATED ALWAYS AS IDENTITY
);
-- A · Operational staff (application permissions only; no authority-bearing role exists).
CREATE TABLE competition.competition_staff (
  id                     uuid PRIMARY KEY,
  competition_id         uuid NOT NULL REFERENCES competition.competition (id),
  person_id              uuid NOT NULL REFERENCES identity.person (id),
  staff_role             text NOT NULL CHECK (staff_role IN ('OWNER', 'ADMIN', 'REGISTRATION_MANAGER', 'SCHEDULER')),
  assigned_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at            timestamptz NOT NULL
);
CREATE TABLE competition.competition_staff_status_change (
  id               uuid PRIMARY KEY,
  staff_id         uuid NOT NULL REFERENCES competition.competition_staff (id),
  status           text NOT NULL CHECK (status IN ('ACTIVE', 'ENDED')),
  actor_account_id uuid,
  recorded_at      timestamptz NOT NULL,
  seq              bigint GENERATED ALWAYS AS IDENTITY
);

-- ─────────────────────────────── event ───────────────────────────────

-- A · Event pins EXACT catalog versions and its canonical format configuration at creation.
CREATE TABLE competition.event (
  id                    uuid PRIMARY KEY,
  competition_id        uuid NOT NULL REFERENCES competition.competition (id),
  discipline_version_id uuid NOT NULL REFERENCES sports.discipline_version (id),
  format_version_id     uuid NOT NULL REFERENCES sports.format_version (id),
  entrant_kind          text NOT NULL CHECK (entrant_kind IN ('INDIVIDUAL', 'TEAM')),
  format_config         jsonb NOT NULL CHECK (jsonb_typeof(format_config) = 'object' AND octet_length(format_config::text) <= 8192),
  format_config_hash    text NOT NULL CHECK (format_config_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL
);
CREATE INDEX event_competition_idx ON competition.event (competition_id);
-- OP · Event operational settings.
CREATE TABLE competition.event_profile (
  event_id               uuid PRIMARY KEY REFERENCES competition.event (id),
  name                   text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  category               jsonb NOT NULL CHECK (jsonb_typeof(category) = 'object' AND octet_length(category::text) <= 4096),
  capacity               integer CHECK (capacity IS NULL OR capacity BETWEEN 1 AND 4096),
  registration_mode      text NOT NULL CHECK (registration_mode IN ('AUTO_CONFIRM', 'ORGANIZER_APPROVAL')),
  registration_opens_at  timestamptz,
  registration_closes_at timestamptz,
  starts_at              timestamptz,
  ends_at                timestamptz,
  timezone               text NOT NULL CHECK (length(timezone) BETWEEN 1 AND 64),
  updated_at             timestamptz NOT NULL,
  updated_by_account_id  uuid,
  CHECK (registration_opens_at IS NULL OR registration_closes_at IS NULL OR registration_closes_at > registration_opens_at),
  CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at >= starts_at)
);
-- A · Event slugs are scoped to their competition.
CREATE TABLE competition.event_slug (
  competition_id uuid NOT NULL REFERENCES competition.competition (id),
  slug           text NOT NULL CHECK (identity.normalized_slug_ok(slug)),
  event_id       uuid NOT NULL REFERENCES competition.event (id),
  recorded_at    timestamptz NOT NULL,
  seq            bigint GENERATED ALWAYS AS IDENTITY,
  PRIMARY KEY (competition_id, slug)
);
CREATE TABLE competition.event_status_change (
  id               uuid PRIMARY KEY,
  event_id         uuid NOT NULL REFERENCES competition.event (id),
  status           text NOT NULL CHECK (status IN ('DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'FIELD_LOCKED',
                                                   'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
  reason           text CHECK (reason IS NULL OR length(reason) <= 500),
  actor_account_id uuid,
  recorded_at      timestamptz NOT NULL,
  seq              bigint GENERATED ALWAYS AS IDENTITY
);

-- ─────────────────────────────── teams ───────────────────────────────

-- A · Team: a competition-side identity (persistent squad, event pair, event squad). NOT an
-- Organization; an optional organization_id is an affiliation label that confers nothing.
CREATE TABLE competition.team (
  id                    uuid PRIMARY KEY,
  team_kind             text NOT NULL CHECK (team_kind IN ('PERSISTENT', 'EVENT_PAIR', 'EVENT_SQUAD')),
  organization_id       uuid REFERENCES organizations.organization (id),
  created_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL
);
-- OP · Public team name (teams are publicly named by design).
CREATE TABLE competition.team_profile (
  team_id      uuid PRIMARY KEY REFERENCES competition.team (id),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  updated_at   timestamptz NOT NULL
);
-- A · Operational team managers (application authorization only).
CREATE TABLE competition.team_manager (
  team_id     uuid NOT NULL REFERENCES competition.team (id),
  person_id   uuid NOT NULL REFERENCES identity.person (id),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (team_id, person_id)
);
-- A · Temporal membership: Athlete ∈ Team during [ACTIVE status time, ENDED status time).
CREATE TABLE competition.team_membership (
  id                     uuid PRIMARY KEY,
  team_id                uuid NOT NULL REFERENCES competition.team (id),
  athlete_id             uuid NOT NULL REFERENCES identity.athlete (id),
  member_role            text CHECK (member_role IS NULL OR member_role ~ '^[A-Z][A-Z_]{1,31}$'),
  proposed_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at            timestamptz NOT NULL
);
CREATE INDEX team_membership_team_idx ON competition.team_membership (team_id);
CREATE INDEX team_membership_athlete_idx ON competition.team_membership (athlete_id);
CREATE TABLE competition.team_membership_status_change (
  id                 uuid PRIMARY KEY,
  team_membership_id uuid NOT NULL REFERENCES competition.team_membership (id),
  status             text NOT NULL CHECK (status IN ('PROPOSED', 'ACTIVE', 'DECLINED', 'ENDED')),
  actor_account_id   uuid,
  recorded_at        timestamptz NOT NULL,
  seq                bigint GENERATED ALWAYS AS IDENTITY
);

-- ─────────────────────────────── registration & participants ───────────────────────────────

-- A · Registration: a request to enter an Event (not yet a Participant). XOR entrant.
CREATE TABLE competition.registration (
  id                     uuid PRIMARY KEY,
  event_id               uuid NOT NULL REFERENCES competition.event (id),
  entrant_type           text NOT NULL CHECK (entrant_type IN ('INDIVIDUAL', 'TEAM')),
  athlete_id             uuid REFERENCES identity.athlete (id),
  team_id                uuid REFERENCES competition.team (id),
  requested_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  -- Category eligibility is declared by the entrant; BRT-05 verifies nothing.
  eligibility_declared   boolean NOT NULL,
  recorded_at            timestamptz NOT NULL,
  CHECK ((entrant_type = 'INDIVIDUAL' AND athlete_id IS NOT NULL AND team_id IS NULL)
      OR (entrant_type = 'TEAM' AND team_id IS NOT NULL AND athlete_id IS NULL)),
  UNIQUE (id, event_id)
);
CREATE INDEX registration_event_idx ON competition.registration (event_id);
CREATE TABLE competition.registration_status_change (
  id                uuid PRIMARY KEY,
  registration_id   uuid NOT NULL REFERENCES competition.registration (id),
  event_id          uuid NOT NULL REFERENCES competition.event (id),
  status            text NOT NULL CHECK (status IN ('REQUESTED', 'WAITLISTED', 'CONFIRMED', 'DECLINED', 'WITHDRAWN', 'CANCELLED')),
  -- Provenance of eligibility on confirmation: declared by the entrant, or accepted by an organizer.
  eligibility_basis text CHECK (eligibility_basis IS NULL OR eligibility_basis IN ('DECLARED', 'ORGANIZER_ACCEPTED')),
  reason            text CHECK (reason IS NULL OR length(reason) <= 500),
  actor_account_id  uuid,
  recorded_at       timestamptz NOT NULL,
  seq               bigint GENERATED ALWAYS AS IDENTITY,
  CHECK (status <> 'CONFIRMED' OR eligibility_basis IS NOT NULL),
  -- the status row's event is the registration's event (capacity accounting cannot be misdirected)
  FOREIGN KEY (registration_id, event_id) REFERENCES competition.registration (id, event_id)
);
CREATE INDEX registration_status_event_idx ON competition.registration_status_change (event_id, registration_id, seq DESC);

-- A · The locked field: one per event; hash of the canonical participant set.
CREATE TABLE competition.event_field (
  event_id          uuid PRIMARY KEY REFERENCES competition.event (id),
  field_hash        text NOT NULL CHECK (field_hash ~ '^sha256:[0-9a-f]{64}$'),
  participant_count integer NOT NULL CHECK (participant_count >= 0),
  locked_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at       timestamptz NOT NULL
);
-- A · Participant: "this entrant in this Event" — distinct from Athlete and from Team. XOR.
CREATE TABLE competition.participant (
  id               uuid PRIMARY KEY,
  event_id         uuid NOT NULL REFERENCES competition.event (id),
  participant_kind text NOT NULL CHECK (participant_kind IN ('INDIVIDUAL', 'TEAM')),
  athlete_id       uuid REFERENCES identity.athlete (id),
  team_id          uuid REFERENCES competition.team (id),
  registration_id  uuid NOT NULL UNIQUE REFERENCES competition.registration (id),
  recorded_at      timestamptz NOT NULL,
  CHECK ((participant_kind = 'INDIVIDUAL' AND athlete_id IS NOT NULL AND team_id IS NULL)
      OR (participant_kind = 'TEAM' AND team_id IS NOT NULL AND athlete_id IS NULL)),
  FOREIGN KEY (registration_id, event_id) REFERENCES competition.registration (id, event_id)
);
CREATE INDEX participant_event_idx ON competition.participant (event_id);
CREATE TABLE competition.participant_status_change (
  id               uuid PRIMARY KEY,
  participant_id   uuid NOT NULL REFERENCES competition.participant (id),
  status           text NOT NULL CHECK (status IN ('ACTIVE', 'WITHDRAWN', 'DISQUALIFIED')),
  reason           text CHECK (reason IS NULL OR length(reason) <= 500),
  -- DISQUALIFIED is an operational exclusion that must cite a reference (not a verified sanction).
  reference        text CHECK (reference IS NULL OR length(reference) <= 200),
  actor_account_id uuid,
  recorded_at      timestamptz NOT NULL,
  seq              bigint GENERATED ALWAYS AS IDENTITY,
  CHECK (status <> 'DISQUALIFIED' OR (reason IS NOT NULL AND reference IS NOT NULL))
);

-- A · Seeding: once per event, tied to the locked field (seed tampering is visible).
CREATE TABLE competition.event_seeding (
  event_id         uuid PRIMARY KEY REFERENCES competition.event_field (event_id),
  field_hash       text NOT NULL CHECK (field_hash ~ '^sha256:[0-9a-f]{64}$'),
  method           text NOT NULL CHECK (method IN ('MANUAL', 'DETERMINISTIC_DRAW')),
  draw_algorithm   text CHECK (draw_algorithm IS NULL OR draw_algorithm ~ '^[a-z0-9-]+/[0-9]+$'),
  draw_seed        text CHECK (draw_seed IS NULL OR draw_seed ~ '^[0-9a-f]{64}$'),
  seed_order       uuid[] NOT NULL,
  seeding_hash     text NOT NULL CHECK (seeding_hash ~ '^sha256:[0-9a-f]{64}$'),
  seeded_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at      timestamptz NOT NULL,
  CHECK ((method = 'DETERMINISTIC_DRAW') = (draw_seed IS NOT NULL AND draw_algorithm IS NOT NULL))
);

-- A · EventPlan: one immutable generated plan per event (no silent regeneration/overwrite).
-- plan_document preserves the historical structure independently of later engine code.
CREATE TABLE competition.event_plan (
  event_id        uuid PRIMARY KEY REFERENCES competition.event_seeding (event_id),
  engine_id       text NOT NULL,
  engine_version  integer NOT NULL,
  input_hash      text NOT NULL CHECK (input_hash ~ '^sha256:[0-9a-f]{64}$'),
  plan_hash       text NOT NULL CHECK (plan_hash ~ '^sha256:[0-9a-f]{64}$'),
  plan_document   jsonb NOT NULL CHECK (jsonb_typeof(plan_document) = 'object'),
  generated_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at     timestamptz NOT NULL
);

-- ─────────────────────────────── structure ───────────────────────────────

-- A · Round (BRT-01 §5.3 roundType). Labels are presentation; sequence/type are structure.
-- No Stage entity in BRT-05 (single-stage formats only; see BRT-05-FORMAT-ENGINE.md).
CREATE TABLE competition.round (
  id          uuid PRIMARY KEY,
  event_id    uuid NOT NULL REFERENCES competition.event_plan (event_id),
  plan_key    text NOT NULL,
  sequence    integer NOT NULL CHECK (sequence >= 1),
  round_type  text NOT NULL CHECK (round_type IN ('QUALIFYING', 'GROUP', 'HEAT', 'KNOCKOUT', 'REPECHAGE', 'FINAL', 'SESSION')),
  label       text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  byes        uuid[] NOT NULL DEFAULT '{}',
  recorded_at timestamptz NOT NULL,
  UNIQUE (event_id, sequence),
  UNIQUE (event_id, plan_key)
);
-- A · Contest: the atomic competitive unit (BRT-01 §5.4); owned by exactly one Round.
CREATE TABLE competition.contest (
  id           uuid PRIMARY KEY,
  event_id     uuid NOT NULL REFERENCES competition.event (id),
  round_id     uuid NOT NULL REFERENCES competition.round (id),
  plan_key     text NOT NULL,
  sequence     integer NOT NULL CHECK (sequence >= 1),
  contest_type text NOT NULL CHECK (contest_type IN ('MATCH', 'HEAT', 'SERIES', 'ATTEMPT_SET', 'ROUTINE', 'SESSION')),
  recorded_at  timestamptz NOT NULL,
  UNIQUE (event_id, sequence),
  UNIQUE (event_id, plan_key)
);
-- A · Contestant: a slot of a Contest; either a Participant or an UNRESOLVED dependency.
-- Resolution of dependencies is not implemented in BRT-05 (it will be an append-only resolution
-- fact backed by a trustworthy outcome); rows here are never updated.
CREATE TABLE competition.contestant (
  id                uuid PRIMARY KEY,
  contest_id        uuid NOT NULL REFERENCES competition.contest (id),
  slot              integer NOT NULL CHECK (slot BETWEEN 1 AND 64),
  source_kind       text NOT NULL CHECK (source_kind IN ('PARTICIPANT', 'WINNER_OF_CONTEST', 'LOSER_OF_CONTEST', 'RANK_FROM_STAGE')),
  participant_id    uuid REFERENCES competition.participant (id),
  source_contest_id uuid REFERENCES competition.contest (id),
  source_rank       integer CHECK (source_rank IS NULL OR source_rank >= 1),
  recorded_at       timestamptz NOT NULL,
  UNIQUE (contest_id, slot),
  CHECK ((source_kind = 'PARTICIPANT' AND participant_id IS NOT NULL AND source_contest_id IS NULL AND source_rank IS NULL)
      OR (source_kind IN ('WINNER_OF_CONTEST', 'LOSER_OF_CONTEST') AND participant_id IS NULL AND source_contest_id IS NOT NULL AND source_rank IS NULL)
      OR (source_kind = 'RANK_FROM_STAGE' AND participant_id IS NULL AND source_contest_id IS NULL AND source_rank IS NOT NULL))
);
CREATE INDEX contestant_participant_idx ON competition.contestant (participant_id);

-- Structural integrity: contests, contestants, participants and dependencies never cross events.
CREATE FUNCTION competition.assert_same_event() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ev uuid;
BEGIN
  IF TG_TABLE_NAME = 'contest' THEN
    IF NOT EXISTS (SELECT 1 FROM competition.round r WHERE r.id = NEW.round_id AND r.event_id = NEW.event_id) THEN
      RAISE EXCEPTION 'contest round belongs to another event' USING ERRCODE = 'BR006';
    END IF;
  ELSIF TG_TABLE_NAME = 'contestant' THEN
    SELECT event_id INTO ev FROM competition.contest WHERE id = NEW.contest_id;
    IF NEW.participant_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM competition.participant p WHERE p.id = NEW.participant_id AND p.event_id = ev) THEN
      RAISE EXCEPTION 'contestant participant belongs to another event' USING ERRCODE = 'BR006';
    END IF;
    IF NEW.source_contest_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM competition.contest c WHERE c.id = NEW.source_contest_id AND c.event_id = ev AND c.id <> NEW.contest_id) THEN
      RAISE EXCEPTION 'contestant dependency must be another contest of the same event' USING ERRCODE = 'BR006';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER contest_same_event BEFORE INSERT ON competition.contest FOR EACH ROW EXECUTE FUNCTION competition.assert_same_event();
CREATE TRIGGER contestant_same_event BEFORE INSERT ON competition.contestant FOR EACH ROW EXECUTE FUNCTION competition.assert_same_event();

-- OP · Contest scheduling (UTC timestamptz; changes are audited by the application).
CREATE TABLE competition.contest_schedule (
  contest_id            uuid PRIMARY KEY REFERENCES competition.contest (id),
  scheduled_start       timestamptz NOT NULL,
  scheduled_end         timestamptz,
  venue_organization_id uuid REFERENCES organizations.organization (id),
  location_label        text CHECK (location_label IS NULL OR length(location_label) <= 120),
  court_label           text CHECK (court_label IS NULL OR length(court_label) <= 40),
  updated_at            timestamptz NOT NULL,
  updated_by_account_id uuid NOT NULL,
  CHECK (scheduled_end IS NULL OR scheduled_end > scheduled_start)
);
CREATE TABLE competition.contest_status_change (
  id               uuid PRIMARY KEY,
  contest_id       uuid NOT NULL REFERENCES competition.contest (id),
  status           text NOT NULL CHECK (status IN ('PLANNED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'VOID')),
  reason           text CHECK (reason IS NULL OR length(reason) <= 500),
  actor_account_id uuid,
  recorded_at      timestamptz NOT NULL,
  seq              bigint GENERATED ALWAYS AS IDENTITY
);

-- A · Declared lineup (BRT-02 "Lineup drafts"): athletes fielded for a Participant in a Contest.
-- The latest declaration per (contest, participant) is current; a replacement is a new row.
-- It is operational: the lineup credited by achievements remains part of Result content (BRT-01).
CREATE TABLE competition.lineup (
  id                      uuid PRIMARY KEY,
  contest_id              uuid NOT NULL REFERENCES competition.contest (id),
  participant_id          uuid NOT NULL REFERENCES competition.participant (id),
  submitted_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at             timestamptz NOT NULL,
  seq                     bigint GENERATED ALWAYS AS IDENTITY
);
CREATE TABLE competition.lineup_member (
  lineup_id   uuid NOT NULL REFERENCES competition.lineup (id),
  athlete_id  uuid NOT NULL REFERENCES identity.athlete (id),
  member_role text CHECK (member_role IS NULL OR member_role ~ '^[A-Z][A-Z_]{1,31}$'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (lineup_id, athlete_id)
);

-- ─────────────────────────────── current-state views ───────────────────────────────
CREATE VIEW competition.v_competition_current AS
  SELECT DISTINCT ON (competition_id) competition_id, status, recorded_at FROM competition.competition_status_change ORDER BY competition_id, seq DESC;
CREATE VIEW competition.v_competition_slug_current AS
  SELECT DISTINCT ON (competition_id) competition_id, slug, recorded_at FROM competition.competition_slug ORDER BY competition_id, seq DESC;
CREATE VIEW competition.v_staff_current AS
  SELECT DISTINCT ON (staff_id) staff_id, status, recorded_at FROM competition.competition_staff_status_change ORDER BY staff_id, seq DESC;
CREATE VIEW competition.v_event_current AS
  SELECT DISTINCT ON (event_id) event_id, status, recorded_at FROM competition.event_status_change ORDER BY event_id, seq DESC;
CREATE VIEW competition.v_event_slug_current AS
  SELECT DISTINCT ON (event_id) event_id, competition_id, slug, recorded_at FROM competition.event_slug ORDER BY event_id, seq DESC;
CREATE VIEW competition.v_team_membership_current AS
  SELECT DISTINCT ON (team_membership_id) team_membership_id, status, recorded_at FROM competition.team_membership_status_change ORDER BY team_membership_id, seq DESC;
CREATE VIEW competition.v_registration_current AS
  SELECT DISTINCT ON (registration_id) registration_id, event_id, status, eligibility_basis, recorded_at FROM competition.registration_status_change ORDER BY registration_id, seq DESC;
CREATE VIEW competition.v_participant_current AS
  SELECT DISTINCT ON (participant_id) participant_id, status, recorded_at FROM competition.participant_status_change ORDER BY participant_id, seq DESC;
CREATE VIEW competition.v_contest_current AS
  SELECT DISTINCT ON (contest_id) contest_id, status, recorded_at FROM competition.contest_status_change ORDER BY contest_id, seq DESC;
CREATE VIEW competition.v_lineup_current AS
  SELECT DISTINCT ON (contest_id, participant_id) id AS lineup_id, contest_id, participant_id, recorded_at FROM competition.lineup ORDER BY contest_id, participant_id, seq DESC;

-- ─────────────────────────────── database-level guards ───────────────────────────────

-- Capacity: confirmed registrations never exceed capacity, even if application code forgets its
-- lock. The trigger itself serializes per event (advisory lock) and counts with a fresh snapshot.
CREATE FUNCTION competition.enforce_event_capacity() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cap integer;
  confirmed integer;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('event-capacity:' || NEW.event_id::text, 0));
  SELECT capacity INTO cap FROM competition.event_profile WHERE event_id = NEW.event_id;
  IF cap IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO confirmed FROM competition.v_registration_current v WHERE v.event_id = NEW.event_id AND v.status = 'CONFIRMED';
  IF confirmed > cap THEN
    RAISE EXCEPTION 'event capacity exceeded' USING ERRCODE = 'BR003';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER registration_capacity AFTER INSERT ON competition.registration_status_change
  FOR EACH ROW WHEN (NEW.status = 'CONFIRMED') EXECUTE FUNCTION competition.enforce_event_capacity();

-- One active registration per entrant per event (REQUESTED / WAITLISTED / CONFIRMED).
CREATE FUNCTION competition.enforce_single_active_entry() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'event-entrant:' || NEW.event_id::text || ':' || coalesce(NEW.athlete_id, NEW.team_id)::text, 0));
  IF EXISTS (
      SELECT 1 FROM competition.registration r
      JOIN competition.v_registration_current v ON v.registration_id = r.id
      WHERE r.event_id = NEW.event_id AND r.id <> NEW.id
        AND (r.athlete_id = NEW.athlete_id OR r.team_id = NEW.team_id)
        AND v.status IN ('REQUESTED', 'WAITLISTED', 'CONFIRMED')) THEN
    RAISE EXCEPTION 'entrant already has an active registration in this event' USING ERRCODE = 'BR004';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER registration_single_active BEFORE INSERT ON competition.registration
  FOR EACH ROW EXECUTE FUNCTION competition.enforce_single_active_entry();

-- Append-only + recorded_at for every class A table.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['competition', 'competition_slug', 'competition_status_change', 'competition_staff',
                           'competition_staff_status_change', 'event', 'event_slug', 'event_status_change',
                           'team', 'team_manager', 'team_membership', 'team_membership_status_change',
                           'registration', 'registration_status_change', 'event_field', 'participant',
                           'participant_status_change', 'event_seeding', 'event_plan', 'round', 'contest',
                           'contestant', 'contest_status_change', 'lineup', 'lineup_member'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON competition.%I FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON competition.%I FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation()', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON competition.%I FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at()', t || '_recorded_at', t);
    EXECUTE format('GRANT SELECT, INSERT ON competition.%I TO br_competition', t);
  END LOOP;
END
$$;

-- ─────────────────────────────── hierarchy resolver ───────────────────────────────
-- Resolves a competition / event / round / contest to its full scope path from relationships
-- (never from id or slug prefixes). SECURITY DEFINER so authority and result contexts can
-- resolve hierarchy without table grants; returns public-safe ids and catalog codes only, or
-- NULL (callers fail closed). Ancestry is immutable (append-only tables), so a cancelled entity
-- keeps its historical ancestry.
CREATE FUNCTION competition.resolve_scope_path(p_kind text, p_id uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_contest uuid;
  v_round uuid;
  v_event uuid;
  v_comp uuid;
  v_sport text;
  v_disc text;
  v_region text;
BEGIN
  IF p_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_kind = 'CONTEST' THEN
    SELECT c.id, c.round_id, c.event_id INTO v_contest, v_round, v_event FROM competition.contest c WHERE c.id = p_id;
    IF v_contest IS NULL THEN RETURN NULL; END IF;
  ELSIF p_kind = 'ROUND' THEN
    SELECT r.id, r.event_id INTO v_round, v_event FROM competition.round r WHERE r.id = p_id;
    IF v_round IS NULL THEN RETURN NULL; END IF;
  ELSIF p_kind = 'EVENT' THEN
    SELECT e.id INTO v_event FROM competition.event e WHERE e.id = p_id;
    IF v_event IS NULL THEN RETURN NULL; END IF;
  ELSIF p_kind = 'COMPETITION' THEN
    SELECT c.id INTO v_comp FROM competition.competition c WHERE c.id = p_id;
    IF v_comp IS NULL THEN RETURN NULL; END IF;
  ELSE
    RETURN NULL;
  END IF;
  IF v_event IS NOT NULL THEN
    SELECT e.competition_id, s.code, d.code INTO v_comp, v_sport, v_disc
    FROM competition.event e
    JOIN sports.discipline_version dv ON dv.id = e.discipline_version_id
    JOIN sports.discipline d ON d.id = dv.discipline_id
    JOIN sports.sport s ON s.id = d.sport_id
    WHERE e.id = v_event;
  END IF;
  SELECT p.region_code INTO v_region FROM competition.competition_profile p WHERE p.competition_id = v_comp;
  RETURN jsonb_strip_nulls(jsonb_build_object(
    'level', p_kind,
    'competitionId', v_comp,
    'region', v_region,
    'sport', v_sport,
    'discipline', v_disc,
    'eventId', v_event,
    'roundId', v_round,
    'contestId', v_contest));
END
$$;
REVOKE ALL ON FUNCTION competition.resolve_scope_path(text, uuid) FROM PUBLIC;
GRANT USAGE ON SCHEMA competition TO br_authority, br_results;
GRANT EXECUTE ON FUNCTION competition.resolve_scope_path(text, uuid) TO br_competition, br_authority, br_results;

-- ─────────────────────────────── grants ───────────────────────────────
GRANT USAGE ON SCHEMA competition TO br_competition, br_rebuild;
GRANT SELECT, INSERT, UPDATE ON competition.competition_profile, competition.event_profile, competition.team_profile,
  competition.contest_schedule TO br_competition;
GRANT SELECT ON ALL TABLES IN SCHEMA competition TO br_competition;
GRANT EXECUTE ON FUNCTION identity.normalized_slug_ok(text) TO br_competition;
-- Platform plumbing.
GRANT USAGE ON SCHEMA platform TO br_competition;
GRANT EXECUTE ON FUNCTION platform.tx_time_ms() TO br_competition;
GRANT SELECT, INSERT ON platform.outbox_event TO br_competition;
GRANT SELECT, INSERT ON platform.command_idempotency TO br_competition;
GRANT INSERT ON platform.audit_event TO br_competition;
-- Control and permission facts it must read (public-safe identity and organization tables only;
-- never identity_private, auth identities or authority tables).
GRANT USAGE ON SCHEMA identity, organizations TO br_competition;
GRANT SELECT ON identity.person, identity.athlete, identity.v_athlete_current, identity.account_person_control,
  identity.v_account_current, identity.guardian_relationship, identity.v_guardian_relationship_current TO br_competition;
GRANT SELECT ON organizations.organization, organizations.v_organization_current, organizations.membership,
  organizations.v_membership_current TO br_competition;
-- Rebuild reads canonical competition facts (public-safe; no PII lives here).
GRANT SELECT ON ALL TABLES IN SCHEMA competition TO br_rebuild;
