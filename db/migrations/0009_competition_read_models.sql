-- BRT-05 · Competition public read models (class B projections). NOT a source of truth: every row
-- is derived from `competition` / `sports` / `organizations` facts, maintained by the owning
-- command transactions and fully rebuildable by the maintenance login (br_rebuild) without any
-- identity_private access. Athlete names are NOT copied here: the public reader resolves them at
-- read time from the Athlete Passport card, so BRT-04 visibility/restriction always applies.

CREATE SCHEMA competition_read;
REVOKE ALL ON SCHEMA competition_read FROM PUBLIC;

-- Competition page header (DRAFT competitions are projected but never served publicly).
CREATE TABLE competition_read.competition_card (
  competition_id            uuid PRIMARY KEY,
  slug                      text NOT NULL,
  name                      text NOT NULL,
  description               text,
  status                    text NOT NULL,
  timezone                  text NOT NULL,
  starts_at                 timestamptz,
  ends_at                   timestamptz,
  location_label            text,
  organizer_organization_id uuid NOT NULL
);
CREATE UNIQUE INDEX competition_card_slug ON competition_read.competition_card (slug);

-- All slugs ever claimed by a competition (former slugs redirect).
CREATE TABLE competition_read.competition_slug (
  slug           text PRIMARY KEY,
  competition_id uuid NOT NULL
);

-- Event summary (pinned catalog versions resolved to public codes/names).
CREATE TABLE competition_read.event_summary (
  event_id               uuid PRIMARY KEY,
  competition_id         uuid NOT NULL,
  slug                   text NOT NULL,
  name                   text NOT NULL,
  status                 text NOT NULL,
  entrant_kind           text NOT NULL,
  sport_code             text NOT NULL,
  sport_name             text NOT NULL,
  discipline_code        text NOT NULL,
  discipline_name        text NOT NULL,
  discipline_version     integer NOT NULL,
  format_code            text NOT NULL,
  format_name            text NOT NULL,
  format_version         integer NOT NULL,
  engine                 text NOT NULL,
  category               jsonb NOT NULL,
  capacity               integer,
  confirmed_count        integer NOT NULL,
  waitlist_count         integer NOT NULL,
  participant_count      integer NOT NULL,
  registration_opens_at  timestamptz,
  registration_closes_at timestamptz,
  starts_at              timestamptz,
  ends_at                timestamptz,
  timezone               text NOT NULL,
  field_hash             text,
  seeding_method         text,
  draw_algorithm         text,
  draw_seed              text,
  seeding_hash           text,
  plan_engine            text,
  plan_input_hash        text,
  plan_hash              text,
  plan_generated_at      timestamptz
);
CREATE UNIQUE INDEX event_summary_slug ON competition_read.event_summary (competition_id, slug);

-- Event slug history (scoped to the competition).
CREATE TABLE competition_read.event_slug (
  competition_id uuid NOT NULL,
  slug           text NOT NULL,
  event_id       uuid NOT NULL,
  PRIMARY KEY (competition_id, slug)
);

-- Public entries: CONFIRMED registrations (and, after the lock, their Participants). Waitlisted
-- or pending entries are only counted, never listed. Team names are public by design.
CREATE TABLE competition_read.event_entry (
  registration_id    uuid PRIMARY KEY,
  event_id           uuid NOT NULL,
  entrant_type       text NOT NULL,
  athlete_id         uuid,
  team_id            uuid,
  team_name          text,
  registration_status text NOT NULL,
  confirmed_at       timestamptz NOT NULL,
  participant_id     uuid,
  participant_status text,
  seed               integer
);
CREATE INDEX event_entry_event_idx ON competition_read.event_entry (event_id);

-- Structure: rounds (with round-robin byes) and contests (with unresolved dependencies as-is).
CREATE TABLE competition_read.round_card (
  round_id   uuid PRIMARY KEY,
  event_id   uuid NOT NULL,
  sequence   integer NOT NULL,
  round_type text NOT NULL,
  label      text NOT NULL,
  byes       uuid[] NOT NULL
);
CREATE INDEX round_card_event_idx ON competition_read.round_card (event_id);

CREATE TABLE competition_read.contest_card (
  contest_id            uuid PRIMARY KEY,
  event_id              uuid NOT NULL,
  round_id              uuid NOT NULL,
  sequence              integer NOT NULL,
  contest_type          text NOT NULL,
  status                text NOT NULL,
  scheduled_start       timestamptz,
  scheduled_end         timestamptz,
  venue_organization_id uuid,
  location_label        text,
  court_label           text,
  -- [{slot, kind: PARTICIPANT, participantId} | {slot, kind: WINNER_OF_CONTEST|LOSER_OF_CONTEST, contestId, contestSequence}]
  slots                 jsonb NOT NULL
);
CREATE INDEX contest_card_event_idx ON competition_read.contest_card (event_id);

GRANT USAGE ON SCHEMA competition_read TO br_competition, br_rebuild, br_public_read;
-- Incremental maintenance by the owning command transactions.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA competition_read TO br_competition;
-- Full rebuild (maintenance only).
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA competition_read TO br_rebuild;
-- Public read path: read-only.
GRANT SELECT ON ALL TABLES IN SCHEMA competition_read TO br_public_read;
-- Rebuild resolves organizer/venue presence from public organization tables it can already read.
