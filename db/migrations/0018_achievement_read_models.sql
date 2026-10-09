-- BRT-08 · Achievement read models (class B projections). NOT a source of truth: every row is derived
-- from append-only achievement.* facts (+ rule identity) and fully rebuildable by the maintenance
-- login (br_rebuild) with the same functions. No PII, no evidence, no authority topology, no private
-- attestation ids: holder / member ids are public athlete / team ids whose DISPLAY is resolved at read
-- time through the Athlete Passport privacy policy (restricted / private athletes are never named).
CREATE SCHEMA achievement_read;
REVOKE ALL ON SCHEMA achievement_read FROM PUBLIC;

-- One card per Achievement with its CURRENT status (latest status entry).
CREATE TABLE achievement_read.achievement_card (
  achievement_id        uuid PRIMARY KEY,
  achievement_type      text NOT NULL,
  display_name          text NOT NULL,
  rule_code             text NOT NULL,
  rule_version          integer NOT NULL,
  engine_version        text NOT NULL,
  holder_type           text NOT NULL,
  holder_id             uuid NOT NULL,
  member_athlete_ids    uuid[] NOT NULL,
  scope_type            text NOT NULL,
  scope_id              uuid NOT NULL,
  competition_id        uuid NOT NULL,
  event_id              uuid,
  contest_id            uuid,
  discipline_version_id uuid NOT NULL,
  sport_code            text,
  discipline_code       text,
  basis_level           text NOT NULL,
  basis_result_version_ids uuid[] NOT NULL,
  qualifying_value      jsonb,
  -- AC-4 public wording: the LEVEL and the public region / sport scope only (the anchor id and fact
  -- hash stay in the canonical fact; no grant or chain topology is projected).
  governing_recognition_level text,
  governing_recognition_region text[],
  governing_recognition_sport text[],
  evidence_commitment   text NOT NULL,
  status                text NOT NULL,
  status_reasons        text[] NOT NULL,
  superseded_by         uuid,
  supersedes            uuid[] NOT NULL,
  status_since          timestamptz NOT NULL,
  provenance            text NOT NULL,
  recorded_at           timestamptz NOT NULL
);
CREATE INDEX achievement_card_holder_idx ON achievement_read.achievement_card (holder_type, holder_id);

-- Athlete Passport projection: the athletes an Achievement is presented to. HOLDER for ATHLETE-held
-- Achievements; TEAM_MEMBER for each immutable memberCredit of a TEAM-held Achievement (the entry
-- references the canonical TEAM Achievement — no athlete copy exists).
CREATE TABLE achievement_read.athlete_achievement (
  athlete_id     uuid NOT NULL,
  achievement_id uuid NOT NULL,
  credit_type    text NOT NULL CHECK (credit_type IN ('HOLDER', 'TEAM_MEMBER')),
  PRIMARY KEY (athlete_id, achievement_id)
);

GRANT USAGE ON SCHEMA achievement_read TO br_achievements, br_rebuild, br_public_read;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA achievement_read TO br_achievements;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA achievement_read TO br_rebuild;
GRANT SELECT ON ALL TABLES IN SCHEMA achievement_read TO br_public_read;
