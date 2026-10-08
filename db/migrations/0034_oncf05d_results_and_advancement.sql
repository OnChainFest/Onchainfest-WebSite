-- ONCF-05D · Official results, corrections and advancement (ADR-0064, ADR-0065).
-- Additive except for the one constraint 0003 announced ("T5–T8 arrive with later migrations"):
--   results.result_status_transition                   · + T5 (PROVISIONAL → OFFICIAL) and T7 (→ SUPERSEDED)
--   sports.advancement_policy / _version (+ status)    · the AdvancementPolicy axis (catalog, versioned, hashed)
--   competition.event_scoring.advancement_policy_version_id · pinned with the scoring axes, frozen at lock
--   competition.advancement_decision                   · append-only decisions (resolution / override / revocation)
--   competition.slot_assignment                        · append-only facts: who occupies a dependent target, and why
--   competition.v_slot_assignment_current, v_contest_occupant · current occupant of every contest slot / field place
-- The plan stays immutable: contestant rows are never updated (0008), dependent targets are resolved
-- by facts. No ranking, standing or qualification table or column is created (QUALIFIED is an
-- Achievement only, BRT-08/10); advancement is in-event progression.

-- ─────────────────────────────── ResultLedger: T5 and T7 ───────────────────────────────

ALTER TABLE results.result_status_transition DROP CONSTRAINT result_status_transition_check;
ALTER TABLE results.result_status_transition ADD CONSTRAINT result_status_transition_check CHECK (
     (transition_code = 'T2' AND from_status IS NULL AND to_status = 'SUBMITTED')
  OR (transition_code = 'T3' AND from_status = 'SUBMITTED' AND to_status = 'PROVISIONAL')
  OR (transition_code = 'T4' AND from_status = 'SUBMITTED' AND to_status = 'REJECTED')
  OR (transition_code = 'T5' AND from_status = 'PROVISIONAL' AND to_status = 'OFFICIAL')
  OR (transition_code = 'T7' AND from_status IN ('PROVISIONAL', 'OFFICIAL') AND to_status = 'SUPERSEDED')
);

-- A version may supersede only an earlier version of the SAME result (corrections never cross results).
CREATE FUNCTION results.assert_supersedes_same_result() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.supersedes_version_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM results.result_version v
       WHERE v.id = NEW.supersedes_version_id AND v.result_id = NEW.result_id AND v.version_number < NEW.version_number) THEN
    RAISE EXCEPTION 'a correction supersedes an earlier version of the same result only' USING ERRCODE = 'BR006';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER result_version_supersedes_same_result BEFORE INSERT ON results.result_version
  FOR EACH ROW EXECUTE FUNCTION results.assert_supersedes_same_result();

-- ─────────────────────────────── AdvancementPolicy catalog ───────────────────────────────

CREATE TABLE sports.advancement_policy (
  id                    uuid PRIMARY KEY,
  code                  text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND length(code) <= 64),
  name                  text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL
);
CREATE TABLE sports.advancement_policy_version (
  id                    uuid PRIMARY KEY,
  policy_id             uuid NOT NULL REFERENCES sports.advancement_policy (id),
  version               integer NOT NULL CHECK (version BETWEEN 1 AND 10000),
  family                text NOT NULL CHECK (family = 'ADVANCEMENT'),
  spec                  jsonb NOT NULL CHECK (jsonb_typeof(spec) = 'object' AND octet_length(spec::text) <= 8192),
  spec_hash             text NOT NULL CHECK (spec_hash ~ '^sha256:[0-9a-f]{64}$'),
  basis                 jsonb NOT NULL CHECK (jsonb_typeof(basis) = 'object' AND octet_length(basis::text) <= 2048),
  created_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL,
  UNIQUE (policy_id, version)
);
CREATE TABLE sports.advancement_policy_version_status_change (
  id                           uuid PRIMARY KEY,
  advancement_policy_version_id uuid NOT NULL REFERENCES sports.advancement_policy_version (id),
  status                       text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
  actor_account_id             uuid,
  recorded_at                  timestamptz NOT NULL,
  seq                          bigint GENERATED ALWAYS AS IDENTITY
);
CREATE VIEW sports.v_advancement_policy_version_current AS
  SELECT DISTINCT ON (advancement_policy_version_id) advancement_policy_version_id, status, recorded_at
  FROM sports.advancement_policy_version_status_change ORDER BY advancement_policy_version_id, seq DESC;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['advancement_policy', 'advancement_policy_version', 'advancement_policy_version_status_change'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON sports.%I FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON sports.%I FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation()', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON sports.%I FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at()', t || '_recorded_at', t);
    EXECUTE format('GRANT SELECT, INSERT ON sports.%I TO br_catalog', t);
    EXECUTE format('GRANT SELECT ON sports.%I TO br_competition, br_public_read, br_rebuild', t);
  END LOOP;
END
$$;
GRANT SELECT ON sports.v_advancement_policy_version_current TO br_catalog, br_competition, br_public_read, br_rebuild;

-- ─────────────────────────────── pin (with the scoring axes) ───────────────────────────────

ALTER TABLE competition.event_scoring
  ADD COLUMN advancement_policy_version_id uuid REFERENCES sports.advancement_policy_version (id);
DROP VIEW competition.v_event_scoring_current;
CREATE VIEW competition.v_event_scoring_current AS
  SELECT DISTINCT ON (event_id) id, event_id, ruleset_version_id, classification_template_version_id, stage_overrides,
         advancement_policy_version_id, pinned_by_account_id, recorded_at
  FROM competition.event_scoring ORDER BY event_id, seq DESC;
GRANT SELECT ON competition.v_event_scoring_current TO br_competition, br_rebuild;

-- ─────────────────────────────── advancement decisions and facts ───────────────────────────────

-- One row per committed decision about one advancement unit ("contest:<id>", "rank:s1:g2",
-- "best:s1:3", "field:t1", "override:<target>"). RESOLUTION is the engine's interpretation of the
-- plan under the pinned policy; OVERRIDE / OVERRIDE_REVOKED are an organizer's explicit, reasoned
-- acts. `document` is the canonical br:advancement-decision@1 (provenance included) and
-- `document_hash` its hash. `reason` is organizer-only (never published).
CREATE TABLE competition.advancement_decision (
  id                            uuid PRIMARY KEY,
  event_id                      uuid NOT NULL REFERENCES competition.event (id),
  unit_key                      text NOT NULL CHECK (unit_key ~ '^[a-z]+:[A-Za-z0-9:_-]{1,120}$'),
  kind                          text NOT NULL CHECK (kind IN ('RESOLUTION', 'OVERRIDE', 'OVERRIDE_REVOKED')),
  advancement_policy_version_id uuid NOT NULL REFERENCES sports.advancement_policy_version (id),
  document                      jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object' AND octet_length(document::text) <= 4000000),
  document_hash                 text NOT NULL CHECK (document_hash ~ '^sha256:[0-9a-f]{64}$'),
  supersedes_decision_id        uuid REFERENCES competition.advancement_decision (id),
  reason                        text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  actor_account_id              uuid NOT NULL REFERENCES identity.account (id),
  recorded_at                   timestamptz NOT NULL,
  seq                           bigint GENERATED ALWAYS AS IDENTITY,
  CHECK ((kind = 'RESOLUTION') = (reason IS NULL))
);
CREATE INDEX advancement_decision_unit_idx ON competition.advancement_decision (event_id, unit_key, seq);

-- One fact per (decision, target): the occupant the decision gives a dependent contest slot or a
-- field place of a transition (NULL participant = decided vacant), with the digest of its
-- br:advancement-assignment@1 (who + why). The latest fact per target is current; every earlier
-- fact stays as history (nothing is overwritten).
CREATE TABLE competition.slot_assignment (
  id             uuid PRIMARY KEY,
  decision_id    uuid NOT NULL REFERENCES competition.advancement_decision (id),
  event_id       uuid NOT NULL REFERENCES competition.event (id),
  contest_id     uuid REFERENCES competition.contest (id),
  slot           integer CHECK (slot IS NULL OR slot BETWEEN 1 AND 64),
  transition_id  uuid REFERENCES competition.stage_transition (id),
  ordinal        integer CHECK (ordinal IS NULL OR ordinal BETWEEN 1 AND 20000),
  participant_id uuid REFERENCES competition.participant (id),
  digest         text NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  recorded_at    timestamptz NOT NULL,
  seq            bigint GENERATED ALWAYS AS IDENTITY,
  CHECK ((contest_id IS NOT NULL AND slot IS NOT NULL AND transition_id IS NULL AND ordinal IS NULL)
      OR (contest_id IS NULL AND slot IS NULL AND transition_id IS NOT NULL AND ordinal IS NOT NULL)),
  UNIQUE (decision_id, contest_id, slot, transition_id, ordinal)
);
CREATE INDEX slot_assignment_slot_idx ON competition.slot_assignment (contest_id, slot, seq) WHERE contest_id IS NOT NULL;
CREATE INDEX slot_assignment_field_idx ON competition.slot_assignment (transition_id, ordinal, seq) WHERE transition_id IS NOT NULL;

-- Integrity: a fact targets a DEPENDENT slot (never a fixed participant) or a field place of a
-- transition of the same event, names a participant of the same event, and belongs to a decision of
-- the same event.
CREATE FUNCTION competition.assert_slot_assignment() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM competition.advancement_decision d WHERE d.id = NEW.decision_id AND d.event_id = NEW.event_id) THEN
    RAISE EXCEPTION 'assignment decision belongs to another event' USING ERRCODE = 'BR006';
  END IF;
  IF NEW.contest_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM competition.contestant ct JOIN competition.contest c ON c.id = ct.contest_id
       WHERE ct.contest_id = NEW.contest_id AND ct.slot = NEW.slot AND c.event_id = NEW.event_id
         AND ct.source_kind IN ('WINNER_OF_CONTEST', 'LOSER_OF_CONTEST', 'RANK_FROM_STAGE', 'BEST_RANKED_FROM_STAGE')) THEN
    RAISE EXCEPTION 'an assignment targets a dependent slot of the same event' USING ERRCODE = 'BR006';
  END IF;
  IF NEW.transition_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM competition.stage_transition t WHERE t.id = NEW.transition_id AND t.event_id = NEW.event_id
         AND t.kind IN ('QUALIFY_BY_PLACE_AND_TIME', 'CUT', 'ELIMINATE_NON_FINISHERS')) THEN
    RAISE EXCEPTION 'a field assignment targets a selecting transition of the same event' USING ERRCODE = 'BR006';
  END IF;
  IF NEW.participant_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM competition.participant p WHERE p.id = NEW.participant_id AND p.event_id = NEW.event_id) THEN
    RAISE EXCEPTION 'assignment participant belongs to another event' USING ERRCODE = 'BR006';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER slot_assignment_integrity BEFORE INSERT ON competition.slot_assignment
  FOR EACH ROW EXECUTE FUNCTION competition.assert_slot_assignment();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['advancement_decision', 'slot_assignment'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON competition.%I FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON competition.%I FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation()', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON competition.%I FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at()', t || '_recorded_at', t);
    EXECUTE format('GRANT SELECT, INSERT ON competition.%I TO br_competition', t);
    EXECUTE format('GRANT SELECT ON competition.%I TO br_rebuild', t);
  END LOOP;
END
$$;

-- Current fact per target.
CREATE VIEW competition.v_slot_assignment_current AS
  SELECT DISTINCT ON (coalesce(contest_id, transition_id), coalesce(slot, ordinal), contest_id IS NULL)
         id, decision_id, event_id, contest_id, slot, transition_id, ordinal, participant_id, digest, recorded_at, seq
  FROM competition.slot_assignment
  ORDER BY coalesce(contest_id, transition_id), coalesce(slot, ordinal), contest_id IS NULL, seq DESC;

-- Current occupant of every contest place (NULL participant: unresolved or decided vacant):
--   · fixed participants and their slots;
--   · dependent slots (winner / loser / rank / best-ranked) → their current fact;
--   · QUALIFIER slots → the current fact of their transition's field place (`source_ordinal`);
--   · contests of a DYNAMIC round with no slots → the current field of the round's transition.
-- Field entries (contest_entry) are fixed entrants and are read from that table directly.
CREATE VIEW competition.v_contest_occupant AS
  SELECT ct.contest_id, ct.slot AS place, ct.source_kind,
         CASE WHEN ct.source_kind = 'PARTICIPANT' THEN ct.participant_id ELSE coalesce(s.participant_id, f.participant_id) END AS participant_id,
         coalesce(s.id, f.id) AS assignment_id
  FROM competition.contestant ct
  LEFT JOIN competition.v_slot_assignment_current s
    ON ct.source_kind IN ('WINNER_OF_CONTEST', 'LOSER_OF_CONTEST', 'RANK_FROM_STAGE', 'BEST_RANKED_FROM_STAGE')
   AND s.contest_id = ct.contest_id AND s.slot = ct.slot
  LEFT JOIN competition.v_slot_assignment_current f
    ON ct.source_kind = 'QUALIFIER' AND f.transition_id = ct.source_transition_id AND f.ordinal = ct.source_ordinal
  UNION ALL
  SELECT c.id AS contest_id, f.ordinal AS place, 'QUALIFIER' AS source_kind, f.participant_id, f.id AS assignment_id
  FROM competition.contest c
  JOIN competition.round r ON r.id = c.round_id AND r.dynamic_transition_key IS NOT NULL
  JOIN competition.stage_transition t ON t.event_id = r.event_id AND t.plan_key = r.dynamic_transition_key
  JOIN competition.v_slot_assignment_current f ON f.transition_id = t.id
  WHERE NOT EXISTS (SELECT 1 FROM competition.contestant x WHERE x.contest_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM competition.contest_entry x WHERE x.contest_id = c.id);
GRANT SELECT ON competition.v_slot_assignment_current, competition.v_contest_occupant TO br_competition, br_rebuild;
