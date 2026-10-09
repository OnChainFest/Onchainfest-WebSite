-- BRT-09 · Record read models (class B projections, ADR-0046). NOT a source of truth: every row is
-- derived from append-only record.* facts (+ category identity + catalog codes) and fully rebuildable
-- by the maintenance login (br_rebuild) with the same function. No PII, no evidence, no authority
-- topology (no anchor ids, anchor fact hashes, grants, principal ids, keys or attestation topology):
-- holder / member ids are public athlete / team ids whose DISPLAY is resolved at read time through
-- the Athlete Passport privacy policy (restricted / private athletes are never named).
--
--   category_card        one card per category: latest version policy (public-safe) + current record
--   mark_card            one card per RecordMark: current status, materialized effective period, label
--   hall_of_fame_entry   the RECORD HALL OF FAME: legitimate record history only — RATIFIED / CANONICAL
--                        (current) and SUPERSEDED (former) marks that actually held the record, of
--                        non-PERSONAL categories. PENDING and RESCINDED marks never appear here (they
--                        stay in mark_card / audit history, explicitly labelled). No induction, score,
--                        popularity or editorial input exists — it is a pure view of record history.
--   athlete_record       Passport projection: HOLDER (athlete-held) / TEAM_MEMBER (credited member of a
--                        TEAM-held mark — the entry references the canonical TEAM mark; no copies)
CREATE SCHEMA record_read;
REVOKE ALL ON SCHEMA record_read FROM PUBLIC;

CREATE TABLE record_read.category_card (
  category_id          uuid PRIMARY KEY,
  code                 text NOT NULL,
  name                 text NOT NULL,
  scope_type           text NOT NULL,
  category_version_id  uuid NOT NULL,
  version              integer NOT NULL,
  lifecycle            text NOT NULL,
  display_name         text NOT NULL,
  sport_code           text,
  discipline_code      text,
  metric_key           text NOT NULL,
  mark_metric_id       text NOT NULL,
  comparator           text,
  tie_policy           text NOT NULL,
  region               text[],
  recognition_level    text NOT NULL,
  minimum_verification_level text NOT NULL,
  platform_review      boolean NOT NULL,
  canonical_keeper     boolean NOT NULL,
  population           jsonb NOT NULL,
  conditions           jsonb NOT NULL,
  effective_from       timestamptz NOT NULL,
  current_value        jsonb,
  current_mark_ids     uuid[] NOT NULL,
  provenance_mix       text[] NOT NULL,
  last_fact_at         timestamptz NOT NULL
);

CREATE TABLE record_read.mark_card (
  record_mark_id          uuid PRIMARY KEY,
  category_id             uuid NOT NULL,
  category_code           text NOT NULL,
  category_version_id     uuid NOT NULL,
  category_version        integer NOT NULL,
  scope_type              text NOT NULL,
  display_name            text NOT NULL,
  record_label            text NOT NULL,
  holder_type             text NOT NULL,
  holder_id               uuid NOT NULL,
  member_athlete_ids      uuid[] NOT NULL,
  value                   jsonb NOT NULL,
  mark_metric_id          text NOT NULL,
  comparator              text NOT NULL,
  tie_policy              text NOT NULL,
  effective_from          timestamptz NOT NULL,
  effective_to            timestamptz,
  status                  text NOT NULL,
  standing                text,
  status_reasons          text[] NOT NULL,
  status_since            timestamptz NOT NULL,
  is_current              boolean NOT NULL,
  ever_held               boolean NOT NULL,
  ratified_at             timestamptz,
  superseded_by_mark_id   uuid,
  region                  text[],
  recognition_level       text NOT NULL,
  sport_code              text,
  discipline_code         text,
  basis_level             text NOT NULL,
  ratification_level      text,
  competition_id          uuid NOT NULL,
  event_id                uuid,
  result_version_id       uuid NOT NULL,
  provenance              text NOT NULL,
  recorded_at             timestamptz NOT NULL
);
CREATE INDEX mark_card_category_idx ON record_read.mark_card (category_id, effective_from, record_mark_id);
CREATE INDEX mark_card_holder_idx ON record_read.mark_card (holder_type, holder_id);

CREATE TABLE record_read.hall_of_fame_entry (
  record_mark_id      uuid PRIMARY KEY,
  category_id         uuid NOT NULL,
  category_code       text NOT NULL,
  scope_type          text NOT NULL CHECK (scope_type <> 'PERSONAL'),
  record_label        text NOT NULL,
  holder_type         text NOT NULL,
  holder_id           uuid NOT NULL,
  member_athlete_ids  uuid[] NOT NULL,
  value               jsonb NOT NULL,
  effective_from      timestamptz NOT NULL,
  effective_to        timestamptz,
  holding             text NOT NULL CHECK (holding IN ('CURRENT', 'FORMER')),
  status              text NOT NULL CHECK (status IN ('RATIFIED', 'CANONICAL', 'SUPERSEDED')),
  sport_code          text,
  discipline_code     text,
  region              text[],
  recognition_level   text NOT NULL,
  provenance          text NOT NULL,
  -- Deterministic cursor key: category code, then chronological order, then id.
  sort_key            text NOT NULL,
  CHECK ((holding = 'CURRENT') = (effective_to IS NULL))
);
CREATE INDEX hall_of_fame_sort_idx ON record_read.hall_of_fame_entry (sort_key);

CREATE TABLE record_read.athlete_record (
  athlete_id     uuid NOT NULL,
  record_mark_id uuid NOT NULL,
  credit_type    text NOT NULL CHECK (credit_type IN ('HOLDER', 'TEAM_MEMBER')),
  PRIMARY KEY (athlete_id, record_mark_id)
);

-- The BRT-01 conceptual RecordMark.achievementId, as a live read-only view over the append-only
-- achievement.record_basis link (the mark row is never mutated to install it). Exposes ids only.
CREATE VIEW record_read.v_record_set_link AS
  SELECT b.record_mark_id, b.achievement_id AS record_set_achievement_id, b.recorded_at
  FROM achievement.record_basis b;

-- Explicit per-table grants: the (auto-updatable) link view is SELECT-only for everyone, so nobody can
-- write achievement.record_basis through it.
GRANT USAGE ON SCHEMA record_read TO br_records, br_rebuild, br_public_read;
GRANT SELECT, INSERT, UPDATE, DELETE ON record_read.category_card, record_read.mark_card,
  record_read.hall_of_fame_entry, record_read.athlete_record TO br_records;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON record_read.category_card, record_read.mark_card,
  record_read.hall_of_fame_entry, record_read.athlete_record TO br_rebuild;
GRANT SELECT ON record_read.category_card, record_read.mark_card, record_read.hall_of_fame_entry,
  record_read.athlete_record, record_read.v_record_set_link TO br_public_read, br_rebuild, br_records;

-- The category operator maintains ONLY the category card of the category it just changed (a
-- projection of its own category facts + the current record, read-only): never a mark card, never
-- the Hall of Fame, never a canonical record fact.
GRANT USAGE ON SCHEMA record_read TO br_record_rules;
GRANT SELECT, INSERT, UPDATE, DELETE ON record_read.category_card TO br_record_rules;
GRANT SELECT ON record.record_mark, record.mark_status_entry, record.v_mark_status TO br_record_rules;
