-- ONCF-05C · Scoring catalog and event scoring pins (ADR-0059, ADR-0060, ADR-0062, ADR-0063).
-- Additive only: 0001–0032 are untouched. No result, ranking or classification data is written or
-- stored here: contest results stay in the ResultLedger (results.*), and stage classifications are
-- computed on read by classification-engine/2 (ADR-0047: the engine proposes, an authority submits).
--
--   sports.ruleset / ruleset_version (+ status)                          · the Ruleset axis (how ONE contest is decided)
--   sports.classification_template / classification_template_version (+ status) · ClassificationPolicy v2 versions
--   competition.event_scoring                                            · which versions an event is scored under
-- Catalog rows follow 0007: immutable versions, DRAFT → PUBLISHED → RETIRED as append-only facts,
-- br_catalog the only writer, everyone else read-only.

CREATE TABLE sports.ruleset (
  id                    uuid PRIMARY KEY,
  code                  text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND length(code) <= 64),
  name                  text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL
);
CREATE TABLE sports.ruleset_version (
  id                    uuid PRIMARY KEY,
  ruleset_id            uuid NOT NULL REFERENCES sports.ruleset (id),
  version               integer NOT NULL CHECK (version BETWEEN 1 AND 10000),
  family                text NOT NULL CHECK (family IN ('SETS_OF_GAMES', 'TIMED_PERIODS', 'TIMED_OR_TARGET', 'ELAPSED_TIME',
                                                         'FINISH_ORDER_WITH_TIME', 'LAPS_AND_TIME', 'FRAMES_PINFALL',
                                                         'STROKES', 'STABLEFORD', 'MATCH_PLAY_HOLES')),
  spec                  jsonb NOT NULL CHECK (jsonb_typeof(spec) = 'object' AND octet_length(spec::text) <= 16384),
  spec_hash             text NOT NULL CHECK (spec_hash ~ '^sha256:[0-9a-f]{64}$'),
  -- GOVERNING_RULE (with its source) or COMMON_PRACTICE (with a note): shown to organizers.
  basis                 jsonb NOT NULL CHECK (jsonb_typeof(basis) = 'object' AND octet_length(basis::text) <= 2048),
  created_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL,
  UNIQUE (ruleset_id, version)
);
CREATE TABLE sports.ruleset_version_status_change (
  id                 uuid PRIMARY KEY,
  ruleset_version_id uuid NOT NULL REFERENCES sports.ruleset_version (id),
  status             text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
  actor_account_id   uuid,
  recorded_at        timestamptz NOT NULL,
  seq                bigint GENERATED ALWAYS AS IDENTITY
);

CREATE TABLE sports.classification_template (
  id                    uuid PRIMARY KEY,
  code                  text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_]+$' AND length(code) <= 64),
  name                  text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL
);
CREATE TABLE sports.classification_template_version (
  id                    uuid PRIMARY KEY,
  template_id           uuid NOT NULL REFERENCES sports.classification_template (id),
  version               integer NOT NULL CHECK (version BETWEEN 1 AND 10000),
  family                text NOT NULL CHECK (family IN ('STANDINGS', 'METRIC')),
  spec                  jsonb NOT NULL CHECK (jsonb_typeof(spec) = 'object' AND octet_length(spec::text) <= 16384),
  spec_hash             text NOT NULL CHECK (spec_hash ~ '^sha256:[0-9a-f]{64}$'),
  basis                 jsonb NOT NULL CHECK (jsonb_typeof(basis) = 'object' AND octet_length(basis::text) <= 2048),
  created_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL,
  UNIQUE (template_id, version)
);
CREATE TABLE sports.classification_template_version_status_change (
  id                                 uuid PRIMARY KEY,
  classification_template_version_id uuid NOT NULL REFERENCES sports.classification_template_version (id),
  status                             text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
  actor_account_id                   uuid,
  recorded_at                        timestamptz NOT NULL,
  seq                                bigint GENERATED ALWAYS AS IDENTITY
);

CREATE VIEW sports.v_ruleset_version_current AS
  SELECT DISTINCT ON (ruleset_version_id) ruleset_version_id, status, recorded_at
  FROM sports.ruleset_version_status_change ORDER BY ruleset_version_id, seq DESC;
CREATE VIEW sports.v_classification_template_version_current AS
  SELECT DISTINCT ON (classification_template_version_id) classification_template_version_id, status, recorded_at
  FROM sports.classification_template_version_status_change ORDER BY classification_template_version_id, seq DESC;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ruleset', 'ruleset_version', 'ruleset_version_status_change', 'classification_template',
                           'classification_template_version', 'classification_template_version_status_change'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON sports.%I FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON sports.%I FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation()', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON sports.%I FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at()', t || '_recorded_at', t);
    EXECUTE format('GRANT SELECT, INSERT ON sports.%I TO br_catalog', t);
    EXECUTE format('GRANT SELECT ON sports.%I TO br_competition, br_public_read, br_rebuild', t);
  END LOOP;
END
$$;
GRANT SELECT ON sports.v_ruleset_version_current, sports.v_classification_template_version_current
  TO br_catalog, br_competition, br_public_read, br_rebuild;

-- ─────────────────────────────── event scoring pin ───────────────────────────────

-- Which RulesetVersion (and, for stages that produce a table, which ClassificationTemplateVersion)
-- an event is scored under, with optional per-stage overrides ({"s1": {...}}). Append-only; the
-- latest row is current until the field locks — then it is frozen (enforced by the store).
CREATE TABLE competition.event_scoring (
  id                                 uuid PRIMARY KEY,
  event_id                           uuid NOT NULL REFERENCES competition.event (id),
  ruleset_version_id                 uuid NOT NULL REFERENCES sports.ruleset_version (id),
  classification_template_version_id uuid REFERENCES sports.classification_template_version (id),
  stage_overrides                    jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(stage_overrides) = 'object' AND octet_length(stage_overrides::text) <= 4096),
  pinned_by_account_id               uuid NOT NULL REFERENCES identity.account (id),
  recorded_at                        timestamptz NOT NULL,
  seq                                bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX event_scoring_event_idx ON competition.event_scoring (event_id, seq);
CREATE VIEW competition.v_event_scoring_current AS
  SELECT DISTINCT ON (event_id) id, event_id, ruleset_version_id, classification_template_version_id, stage_overrides,
         pinned_by_account_id, recorded_at
  FROM competition.event_scoring ORDER BY event_id, seq DESC;
CREATE TRIGGER event_scoring_append_only BEFORE UPDATE OR DELETE ON competition.event_scoring
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
CREATE TRIGGER event_scoring_no_truncate BEFORE TRUNCATE ON competition.event_scoring
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();
CREATE TRIGGER event_scoring_recorded_at BEFORE INSERT ON competition.event_scoring
  FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at();
GRANT SELECT, INSERT ON competition.event_scoring TO br_competition;
GRANT SELECT ON competition.event_scoring, competition.v_event_scoring_current TO br_rebuild;
GRANT SELECT ON competition.v_event_scoring_current TO br_competition;
