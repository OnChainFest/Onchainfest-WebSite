-- ONCF-05B · Competition domain model for the eight canonical sports (ADR-0053 … ADR-0058).
-- Additive only: 0001–0031 are untouched and every existing row keeps its meaning. Events pinned to
-- a v1 DisciplineVersion keep producing v1 field / seeding / plan documents through the BRT-05 path.
--
--   stage, stage_transition          · stage graphs (groups → knockout, heats → final, cuts) (ADR-0054)
--   round.stage_id / group_key / dynamic_transition_key, contest.partition_key
--   contestant: new dependency sources (best-ranked across groups, heat qualifiers) + stage refs
--   contest_entry                     · field entries without the 64-slot ceiling (road races)
--   registration_entry_attribute      · declared entry attributes (entry time, average, handicap …) (ADR-0056)
--   participant_entry_attribute       · the attributes frozen into the field at lock
--   participant_roster_member         · TEAM roster snapshot at field lock (ADR-0057)
--   event_field.field_version, event_seeding v2 (methods, document), event_plan.plan_version
-- All class A additions are append-only with recorded_at = transaction time, like 0008.

-- ─────────────────────────────── stage graph ───────────────────────────────

CREATE TABLE competition.stage (
  id               uuid PRIMARY KEY,
  event_id         uuid NOT NULL REFERENCES competition.event_plan (event_id),
  plan_key         text NOT NULL CHECK (plan_key ~ '^s[0-9]{1,2}$'),
  sequence         integer NOT NULL CHECK (sequence BETWEEN 1 AND 16),
  primitive        text NOT NULL CHECK (primitive IN ('KNOCKOUT', 'ROUND_ROBIN', 'FIELD', 'HEATS')),
  label            text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  partition_kind   text CHECK (partition_kind IN ('LOGISTIC', 'COMPETITIVE')),
  partition_method text CHECK (partition_method IN ('SINGLE_START', 'WAVE_START', 'INTERVAL_START',
                                                    'LANE_HEATS', 'GROUPED_ENTRANTS', 'GROUPS')),
  recorded_at      timestamptz NOT NULL,
  UNIQUE (event_id, plan_key),
  UNIQUE (event_id, sequence),
  UNIQUE (id, event_id),
  CHECK ((partition_kind IS NULL) = (partition_method IS NULL))
);

-- Unresolved cross-stage transition (resolution facts arrive with advancement, ONCF-05D).
CREATE TABLE competition.stage_transition (
  id                   uuid PRIMARY KEY,
  event_id             uuid NOT NULL REFERENCES competition.event_plan (event_id),
  plan_key             text NOT NULL CHECK (plan_key ~ '^t[0-9]{1,2}$'),
  kind                 text NOT NULL CHECK (kind IN ('RANK_FROM_GROUP', 'QUALIFY_BY_PLACE_AND_TIME', 'CUT',
                                                     'ELIMINATE_NON_FINISHERS', 'STEPLADDER', 'RANK_TO_BRACKET')),
  from_stage_id        uuid NOT NULL,
  to_stage_id          uuid NOT NULL,
  after_round_plan_key text CHECK (after_round_plan_key IS NULL OR length(after_round_plan_key) <= 40),
  params               jsonb NOT NULL CHECK (jsonb_typeof(params) = 'object'),
  recorded_at          timestamptz NOT NULL,
  UNIQUE (event_id, plan_key),
  UNIQUE (id, event_id),
  FOREIGN KEY (from_stage_id, event_id) REFERENCES competition.stage (id, event_id),
  FOREIGN KEY (to_stage_id, event_id) REFERENCES competition.stage (id, event_id)
);

ALTER TABLE competition.round
  ADD COLUMN stage_id uuid REFERENCES competition.stage (id),
  ADD COLUMN group_key text CHECK (group_key IS NULL OR group_key ~ '^g[0-9]{1,2}$'),
  ADD COLUMN dynamic_transition_key text
    CHECK (dynamic_transition_key IS NULL OR dynamic_transition_key ~ '^t[0-9]{1,2}$');

ALTER TABLE competition.contest
  ADD COLUMN partition_key text CHECK (partition_key IS NULL OR partition_key ~ '^[a-z][0-9]{1,5}$');

-- Dependency sources (ADR-0054). v1 RANK_FROM_STAGE rows (no stage reference) stay valid.
ALTER TABLE competition.contestant
  DROP CONSTRAINT contestant_source_kind_check,
  DROP CONSTRAINT contestant_check,
  ADD COLUMN source_stage_id uuid REFERENCES competition.stage (id),
  ADD COLUMN source_group_key text CHECK (source_group_key IS NULL OR source_group_key ~ '^g[0-9]{1,2}$'),
  ADD COLUMN source_ordinal integer CHECK (source_ordinal IS NULL OR source_ordinal >= 1),
  ADD COLUMN source_transition_id uuid REFERENCES competition.stage_transition (id),
  ADD CONSTRAINT contestant_source_kind_check CHECK (source_kind IN (
    'PARTICIPANT', 'WINNER_OF_CONTEST', 'LOSER_OF_CONTEST', 'RANK_FROM_STAGE', 'BEST_RANKED_FROM_STAGE', 'QUALIFIER')),
  ADD CONSTRAINT contestant_check CHECK (
       (source_kind = 'PARTICIPANT' AND participant_id IS NOT NULL AND source_contest_id IS NULL AND source_rank IS NULL
          AND source_stage_id IS NULL AND source_ordinal IS NULL AND source_transition_id IS NULL)
    OR (source_kind IN ('WINNER_OF_CONTEST', 'LOSER_OF_CONTEST') AND participant_id IS NULL AND source_contest_id IS NOT NULL
          AND source_rank IS NULL AND source_stage_id IS NULL AND source_ordinal IS NULL AND source_transition_id IS NULL)
    OR (source_kind = 'RANK_FROM_STAGE' AND participant_id IS NULL AND source_contest_id IS NULL AND source_rank IS NOT NULL
          AND source_ordinal IS NULL AND source_transition_id IS NULL)
    OR (source_kind = 'BEST_RANKED_FROM_STAGE' AND participant_id IS NULL AND source_contest_id IS NULL
          AND source_rank IS NOT NULL AND source_ordinal IS NOT NULL AND source_stage_id IS NOT NULL AND source_transition_id IS NULL)
    OR (source_kind = 'QUALIFIER' AND participant_id IS NULL AND source_contest_id IS NULL AND source_rank IS NULL
          AND source_ordinal IS NOT NULL AND source_transition_id IS NOT NULL));

-- Field entries: FIELD contests (mass start, waves, time trials, stages) hold any number of entrants.
CREATE TABLE competition.contest_entry (
  contest_id           uuid NOT NULL REFERENCES competition.contest (id),
  participant_id       uuid NOT NULL REFERENCES competition.participant (id),
  start_order          integer NOT NULL CHECK (start_order BETWEEN 1 AND 20000),
  start_offset_seconds integer CHECK (start_offset_seconds IS NULL OR start_offset_seconds >= 0),
  recorded_at          timestamptz NOT NULL,
  PRIMARY KEY (contest_id, participant_id),
  UNIQUE (contest_id, start_order)
);
CREATE INDEX contest_entry_participant_idx ON competition.contest_entry (participant_id);

-- Same-event integrity, extended to the new references (stages, transitions, entries).
CREATE OR REPLACE FUNCTION competition.assert_same_event() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ev uuid;
BEGIN
  IF TG_TABLE_NAME = 'contest' THEN
    IF NOT EXISTS (SELECT 1 FROM competition.round r WHERE r.id = NEW.round_id AND r.event_id = NEW.event_id) THEN
      RAISE EXCEPTION 'contest round belongs to another event' USING ERRCODE = 'BR006';
    END IF;
  ELSIF TG_TABLE_NAME = 'round' THEN
    IF NEW.stage_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM competition.stage s WHERE s.id = NEW.stage_id AND s.event_id = NEW.event_id) THEN
      RAISE EXCEPTION 'round stage belongs to another event' USING ERRCODE = 'BR006';
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
    IF NEW.source_stage_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM competition.stage s WHERE s.id = NEW.source_stage_id AND s.event_id = ev) THEN
      RAISE EXCEPTION 'contestant stage dependency belongs to another event' USING ERRCODE = 'BR006';
    END IF;
    IF NEW.source_transition_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM competition.stage_transition t WHERE t.id = NEW.source_transition_id AND t.event_id = ev) THEN
      RAISE EXCEPTION 'contestant transition dependency belongs to another event' USING ERRCODE = 'BR006';
    END IF;
  ELSIF TG_TABLE_NAME = 'contest_entry' THEN
    SELECT event_id INTO ev FROM competition.contest WHERE id = NEW.contest_id;
    IF NOT EXISTS (SELECT 1 FROM competition.participant p WHERE p.id = NEW.participant_id AND p.event_id = ev) THEN
      RAISE EXCEPTION 'contest entry participant belongs to another event' USING ERRCODE = 'BR006';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER round_same_event BEFORE INSERT ON competition.round FOR EACH ROW EXECUTE FUNCTION competition.assert_same_event();
CREATE TRIGGER contest_entry_same_event BEFORE INSERT ON competition.contest_entry FOR EACH ROW EXECUTE FUNCTION competition.assert_same_event();

ALTER TABLE competition.event_plan
  ADD COLUMN plan_version integer NOT NULL DEFAULT 1 CHECK (plan_version IN (1, 2));

-- ─────────────────────────────── entry attributes and roster ───────────────────────────────

-- Declared before the lock by the entrant or the organizer. Latest per (registration, key, member)
-- is current; a NULL value clears it. Declared, never verified (ADR-0056).
CREATE TABLE competition.registration_entry_attribute (
  id                     uuid PRIMARY KEY,
  registration_id        uuid NOT NULL,
  event_id               uuid NOT NULL,
  attribute_key          text NOT NULL CHECK (attribute_key ~ '^[a-z][A-Za-z0-9]{0,31}$'),
  athlete_id             uuid REFERENCES identity.athlete (id),
  value                  text CHECK (value IS NULL OR length(value) BETWEEN 1 AND 64),
  declared_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at            timestamptz NOT NULL,
  seq                    bigint GENERATED ALWAYS AS IDENTITY,
  FOREIGN KEY (registration_id, event_id) REFERENCES competition.registration (id, event_id)
);
CREATE INDEX registration_entry_attribute_reg_idx ON competition.registration_entry_attribute (registration_id);
CREATE VIEW competition.v_registration_entry_attribute_current AS
  SELECT registration_id, event_id, attribute_key, athlete_id, value, recorded_at FROM (
    SELECT DISTINCT ON (registration_id, attribute_key, athlete_id)
           registration_id, event_id, attribute_key, athlete_id, value, recorded_at
    FROM competition.registration_entry_attribute
    ORDER BY registration_id, attribute_key, athlete_id, seq DESC) cur
  WHERE value IS NOT NULL;

-- Frozen at field lock (hashed into br:competition-field@2).
CREATE TABLE competition.participant_entry_attribute (
  participant_id uuid NOT NULL REFERENCES competition.participant (id),
  attribute_key  text NOT NULL CHECK (attribute_key ~ '^[a-z][A-Za-z0-9]{0,31}$'),
  athlete_id     uuid REFERENCES identity.athlete (id),
  value          text NOT NULL CHECK (length(value) BETWEEN 1 AND 64),
  recorded_at    timestamptz NOT NULL,
  UNIQUE NULLS NOT DISTINCT (participant_id, attribute_key, athlete_id)
);

-- TEAM roster snapshot at field lock: the ACTIVE members the entrant entered with (ADR-0057).
CREATE TABLE competition.participant_roster_member (
  participant_id uuid NOT NULL REFERENCES competition.participant (id),
  athlete_id     uuid NOT NULL REFERENCES identity.athlete (id),
  recorded_at    timestamptz NOT NULL,
  PRIMARY KEY (participant_id, athlete_id)
);

ALTER TABLE competition.event_field
  ADD COLUMN field_version integer NOT NULL DEFAULT 1 CHECK (field_version IN (1, 2));

-- ─────────────────────────────── seeding v2 (ADR-0058) ───────────────────────────────

ALTER TABLE competition.event_seeding
  DROP CONSTRAINT event_seeding_method_check,
  DROP CONSTRAINT event_seeding_check,
  ADD COLUMN seeding_version integer NOT NULL DEFAULT 1 CHECK (seeding_version IN (1, 2)),
  ADD COLUMN seeding_document jsonb CHECK (seeding_document IS NULL OR jsonb_typeof(seeding_document) = 'object'),
  ADD CONSTRAINT event_seeding_method_check
    CHECK (method IN ('MANUAL', 'DETERMINISTIC_DRAW', 'RANKED_THEN_DRAWN', 'BY_ENTRY_ATTRIBUTE')),
  ADD CONSTRAINT event_seeding_check
    CHECK ((method = 'MANUAL') = (draw_seed IS NULL AND draw_algorithm IS NULL)),
  ADD CONSTRAINT event_seeding_version_check
    CHECK ((seeding_version = 2) = (seeding_document IS NOT NULL)
       AND (seeding_version = 2 OR method IN ('MANUAL', 'DETERMINISTIC_DRAW')));

-- ─────────────────────────────── append-only + grants ───────────────────────────────

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stage', 'stage_transition', 'contest_entry', 'registration_entry_attribute',
                           'participant_entry_attribute', 'participant_roster_member'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON competition.%I FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON competition.%I FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation()', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON competition.%I FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at()', t || '_recorded_at', t);
    EXECUTE format('GRANT SELECT, INSERT ON competition.%I TO br_competition', t);
    EXECUTE format('GRANT SELECT ON competition.%I TO br_rebuild', t);
  END LOOP;
END
$$;
GRANT SELECT ON competition.v_registration_entry_attribute_current TO br_competition, br_rebuild;

-- ─────────────────────────────── read models (class B; rebuildable) ───────────────────────────────

ALTER TABLE competition_read.round_card
  ADD COLUMN stage_key text,
  ADD COLUMN stage_label text,
  ADD COLUMN stage_primitive text,
  ADD COLUMN partition_kind text,
  ADD COLUMN group_key text,
  ADD COLUMN dynamic_transition_key text;
ALTER TABLE competition_read.contest_card
  ADD COLUMN partition_key text,
  ADD COLUMN entry_count integer NOT NULL DEFAULT 0,
  -- [{participantId, position, startOffsetSeconds?}] (ids only; names resolved at read time)
  ADD COLUMN entries jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Ordered lineups (relay legs, Baker frame order): the declared position of each member.
ALTER TABLE competition.lineup_member
  ADD COLUMN ordinal integer CHECK (ordinal IS NULL OR ordinal BETWEEN 1 AND 100);
