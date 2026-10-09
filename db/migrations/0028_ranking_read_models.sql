-- BRT-10 · Ranking & classification read models (class B projections, ADR-0048 §9, ADR-0046 pattern).
-- NOT a source of truth. Every row is derived from the immutable class-A facts of 0023–0025
-- (+ the ResultLedger's append-only status transitions) and is fully rebuildable by the maintenance
-- login (br_rebuild) with the same functions as the incremental refresh, which runs inside each
-- writer's own transaction. Rows carry copies of the canonical hashes (never recomputed here).
--
-- Deliberately ABSENT:
--   · staleness — computed at read time from the exact pins (ADR-0047 §5, ADR-0048 §8); never stored;
--   · any "current ranking" / is_current flag — as-published / as-corrected are queries over the
--     projected lineage (chain_position, corrected_by_snapshot_id), which is itself derived;
--   · basis topology (result / verification run ids, evidence commitments, hold) and owner principal /
--     anchor ids on public cards; requested_by account ids anywhere;
--   · athlete / passport projections (holders are canonical ids; display is resolved later).
--
-- Numbering: 0027 stays reserved for QUALIFIED (Step 9) and must not reference any object created here.
--
--   system_card           one card per RankingSystem: latest version, lifecycle, published version,
--                         universe summary, computed label            (writer: br_ranking_rules)
--   run_card              one card per ranking run (STAFF ONLY)       (writer: br_rankings)
--   run_candidate         every candidate of a run with state + blockers (STAFF ONLY)
--   snapshot_card         one card per published snapshot: hashes, lineage, chain position, the
--                         snapshot that corrects it                    (writer: br_rankings)
--   leaderboard_entry     one row per ranked holder of a snapshot: rank, tied, value, trace
--   classification_card   one card per derived (`@2`) classification ResultVersion: derivation pins
--                         and the version's latest append-only status  (writer: br_results / ledger)
--   classification_entry  one row per ranked participant of that version
CREATE SCHEMA ranking_read;
REVOKE ALL ON SCHEMA ranking_read FROM PUBLIC;

CREATE TABLE ranking_read.system_card (
  system_id                  uuid PRIMARY KEY,
  code                       text NOT NULL,
  name                       text NOT NULL,
  kind                       text NOT NULL CHECK (kind IN ('PLATFORM', 'OFFICIAL')),
  -- ADR-0048 §7: PLATFORM is always the platform label; OFFICIAL recognition wording needs a published
  -- snapshot (no producer), so it is NULL.
  label                      text,
  latest_version_id          uuid NOT NULL,
  latest_version             integer NOT NULL,
  latest_lifecycle           text NOT NULL CHECK (latest_lifecycle IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
  latest_spec_hash           text NOT NULL,
  published_version_id       uuid,
  published_version          integer,
  display_name               text NOT NULL,
  method                     text NOT NULL,
  discipline_version_id      uuid NOT NULL,
  metric_key                 text NOT NULL,
  mark_metric_id             text NOT NULL,
  holder_type                text NOT NULL,
  recognition_level          text NOT NULL,
  minimum_verification_level text NOT NULL,
  effective_from             timestamptz NOT NULL,
  created_at                 timestamptz NOT NULL,
  CHECK ((kind = 'PLATFORM') = (label IS NOT NULL))
);

CREATE TABLE ranking_read.run_card (
  run_id              uuid PRIMARY KEY,
  system_id           uuid NOT NULL,
  system_version_id   uuid NOT NULL,
  system_version      integer NOT NULL,
  spec_hash           text NOT NULL,
  engine_version      text NOT NULL,
  provenance          text NOT NULL,
  input_hash          text NOT NULL,
  outcome_hash        text NOT NULL,
  as_of               timestamptz NOT NULL,
  publication_state   text NOT NULL CHECK (publication_state IN ('PUBLISHABLE', 'BLOCKED')),
  publication_reasons text[] NOT NULL,
  entry_count         integer NOT NULL,
  candidate_count     integer NOT NULL,
  trigger             text NOT NULL,
  recorded_at         timestamptz NOT NULL
);
CREATE INDEX run_card_system_idx ON ranking_read.run_card (system_id, recorded_at, run_id);

CREATE TABLE ranking_read.run_candidate (
  run_id            uuid NOT NULL,
  result_version_id uuid NOT NULL,
  participant_id    uuid NOT NULL,
  ordinal           integer NOT NULL,
  state             text NOT NULL,
  reasons           text[] NOT NULL,
  PRIMARY KEY (run_id, result_version_id, participant_id, ordinal)
);

CREATE TABLE ranking_read.snapshot_card (
  snapshot_id              uuid PRIMARY KEY,
  system_id                uuid NOT NULL,
  system_version_id        uuid NOT NULL,
  system_version           integer NOT NULL,
  spec_hash                text NOT NULL,
  run_id                   uuid NOT NULL,
  run_input_hash           text NOT NULL,
  run_outcome_hash         text NOT NULL,
  snapshot_hash            text NOT NULL,
  kind                     text NOT NULL,
  method                   text NOT NULL,
  engine_version           text NOT NULL,
  provenance               text NOT NULL,
  as_of                    timestamptz NOT NULL,
  lineage_kind             text NOT NULL CHECK (lineage_kind IN ('INITIAL', 'FOLLOWS', 'CORRECTS')),
  prior_snapshot_id        uuid,
  prior_snapshot_hash      text,
  lineage_reasons          text[] NOT NULL,
  -- 1 for INITIAL, prior + 1 otherwise: as-published = ORDER BY chain_position.
  chain_position           integer NOT NULL CHECK (chain_position >= 1),
  -- The snapshot whose corrects_snapshot_id is this one: as-corrected = WHERE corrected_by IS NULL.
  corrected_by_snapshot_id uuid,
  entry_count              integer NOT NULL,
  published_at             timestamptz NOT NULL,
  UNIQUE (system_id, chain_position),
  CHECK ((lineage_kind = 'INITIAL') = (prior_snapshot_id IS NULL AND chain_position = 1))
);

CREATE TABLE ranking_read.leaderboard_entry (
  snapshot_id      uuid NOT NULL,
  holder_type      text NOT NULL CHECK (holder_type IN ('ATHLETE', 'TEAM')),
  holder_id        uuid NOT NULL,
  rank             integer NOT NULL CHECK (rank >= 1),
  tied             boolean NOT NULL,
  value            jsonb NOT NULL,
  comparator_trace jsonb NOT NULL,
  basis_count      integer NOT NULL CHECK (basis_count >= 1),
  PRIMARY KEY (snapshot_id, holder_type, holder_id)
);
CREATE INDEX leaderboard_entry_rank_idx ON ranking_read.leaderboard_entry (snapshot_id, rank, holder_type, holder_id);

CREATE TABLE ranking_read.classification_card (
  classification_version_id uuid PRIMARY KEY,
  result_id                 uuid NOT NULL,
  scope_type                text NOT NULL CHECK (scope_type IN ('ROUND_CLASSIFICATION', 'EVENT_CLASSIFICATION', 'COMPETITION_CLASSIFICATION')),
  scope_target_id           uuid NOT NULL,
  version_number            integer NOT NULL,
  content_schema            text NOT NULL CHECK (content_schema = 'br:result-version-content@2'),
  content_hash              text NOT NULL,
  policy_id                 uuid NOT NULL,
  policy_version_id         uuid NOT NULL,
  policy_spec_hash          text NOT NULL,
  discipline_version_id     uuid NOT NULL,
  engine_version            text NOT NULL,
  inputs_digest             text NOT NULL,
  input_count               integer NOT NULL,
  pinned_input_ids          uuid[] NOT NULL,
  -- The version's latest append-only status (never a stale / current flag).
  status                    text NOT NULL,
  status_since              timestamptz NOT NULL,
  submitted_at              timestamptz NOT NULL,
  CHECK (cardinality(pinned_input_ids) = input_count)
);
CREATE INDEX classification_card_result_idx ON ranking_read.classification_card (result_id, version_number);
CREATE INDEX classification_card_scope_idx ON ranking_read.classification_card (scope_type, scope_target_id);

CREATE TABLE ranking_read.classification_entry (
  classification_version_id uuid NOT NULL,
  participant_id            uuid NOT NULL,
  rank                      integer NOT NULL CHECK (rank >= 1),
  tied                      boolean NOT NULL,
  tie_break_keys            jsonb NOT NULL,
  PRIMARY KEY (classification_version_id, participant_id)
);
CREATE INDEX classification_entry_rank_idx ON ranking_read.classification_entry (classification_version_id, rank, participant_id);

-- Least privilege: each writer maintains only the projections of the facts it writes, inside its own
-- transaction; br_rebuild truncates and re-derives everything; br_public_read reads the public cards
-- only (run cards / candidates reveal excluded results and blockers: STAFF ONLY, exposure decided by
-- the API step). No PUBLIC grant, no function, no SECURITY DEFINER.
GRANT USAGE ON SCHEMA ranking_read TO br_ranking_rules, br_rankings, br_results, br_rebuild, br_public_read;
GRANT SELECT, INSERT, UPDATE, DELETE ON ranking_read.system_card TO br_ranking_rules;
GRANT SELECT, INSERT, UPDATE, DELETE ON ranking_read.run_card, ranking_read.run_candidate,
  ranking_read.snapshot_card, ranking_read.leaderboard_entry TO br_rankings;
GRANT SELECT, INSERT, UPDATE, DELETE ON ranking_read.classification_card,
  ranking_read.classification_entry TO br_results;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ranking_read.system_card, ranking_read.run_card,
  ranking_read.run_candidate, ranking_read.snapshot_card, ranking_read.leaderboard_entry,
  ranking_read.classification_card, ranking_read.classification_entry TO br_rebuild;
GRANT SELECT ON ranking_read.system_card, ranking_read.snapshot_card, ranking_read.leaderboard_entry,
  ranking_read.classification_card, ranking_read.classification_entry TO br_public_read;
