-- BRT-09 · RECORD_SET through the validated BRT-08 Achievement path (BRT-01 §8.2, ADR-0045).
--
-- Minimal extension of BRT-08 (0016–0018 are never edited):
--   · the Achievement vocabulary admits RECORD_SET (rule + fact CHECKs) and the RECORD_CATEGORY scope;
--   · achievement.record_basis (class A) is the append-only, hash-bound LINK from a RECORD_SET
--     Achievement to the exact RecordMark it recognizes: mark id + mark hash, category version + hash,
--     the ratification status entry + the hash of its br:record-ratification@1 document. It is an
--     element of the Achievement's canonical candidate (candidate.record) written in the same
--     transaction; each mark has AT MOST ONE RECORD_SET (UNIQUE record_mark_id) — 20 identical
--     ratification deliveries can never create two;
--   · a RECORD_SET must commit with exactly one link (deferred check), and the link may only name a mark
--     whose latest status is a valid ratification (RATIFIED / CANONICAL) of the same provenance:
--     a PENDING mark can never already have a RECORD_SET.
-- The RecordMark row is NEVER updated to point back at the Achievement; BRT-01's conceptual
-- RecordMark.achievementId is a projection (record_read.mark_card.record_set_achievement_id).
-- There is no insert path other than the validated Achievement writer (achievement-store.ts).
ALTER TABLE achievement.rule
  DROP CONSTRAINT rule_achievement_type_check,
  ADD CONSTRAINT rule_achievement_type_check CHECK (achievement_type IN (
    'EVENT_COMPLETED', 'CONTEST_WON', 'PLACEMENT', 'TITLE', 'PERFORMANCE_THRESHOLD', 'PERSONAL_BEST', 'RECORD_SET'));

ALTER TABLE achievement.achievement
  DROP CONSTRAINT achievement_achievement_type_check,
  ADD CONSTRAINT achievement_achievement_type_check CHECK (achievement_type IN (
    'EVENT_COMPLETED', 'CONTEST_WON', 'PLACEMENT', 'TITLE', 'PERFORMANCE_THRESHOLD', 'PERSONAL_BEST', 'RECORD_SET')),
  DROP CONSTRAINT achievement_scope_type_check,
  ADD CONSTRAINT achievement_scope_type_check CHECK (scope_type IN (
    'CONTEST', 'ROUND', 'EVENT', 'COMPETITION', 'CAREER', 'RECORD_CATEGORY')),
  -- RECORD_SET ⇔ RECORD_CATEGORY scope (the category universe it recognizes).
  ADD CONSTRAINT achievement_record_set_scope CHECK ((achievement_type = 'RECORD_SET') = (scope_type = 'RECORD_CATEGORY'));

-- A · The RECORD_SET → RecordMark link.
CREATE TABLE achievement.record_basis (
  achievement_id        uuid NOT NULL REFERENCES achievement.achievement (id),
  record_mark_id        uuid NOT NULL REFERENCES record.record_mark (id),
  mark_hash             platform.content_hash NOT NULL,
  category_id           uuid NOT NULL REFERENCES record.category (id),
  category_version_id   uuid NOT NULL REFERENCES record.category_version (id),
  category_version_hash platform.content_hash NOT NULL,
  ratification_entry_id uuid NOT NULL REFERENCES record.mark_status_entry (id),
  ratification_hash     platform.content_hash NOT NULL,
  standing              text NOT NULL CHECK (standing IN ('RATIFIED', 'CANONICAL')),
  recorded_at           timestamptz NOT NULL,
  CONSTRAINT record_basis_pkey PRIMARY KEY (achievement_id),
  CONSTRAINT record_basis_mark_key UNIQUE (record_mark_id)
);

CREATE FUNCTION achievement.assert_record_basis() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  a record;
  r jsonb;
  mprov text;
  latest text;
BEGIN
  SELECT x.candidate, x.achievement_type, x.snapshot_provenance, x.holder_type, x.holder_id, x.recorded_at
    INTO a FROM achievement.achievement x WHERE x.id = NEW.achievement_id;
  r := a.candidate->'record';
  IF a.achievement_type IS DISTINCT FROM 'RECORD_SET' OR a.recorded_at IS DISTINCT FROM NEW.recorded_at
     OR r->>'recordMarkId' IS DISTINCT FROM NEW.record_mark_id::text
     OR r->>'markHash' IS DISTINCT FROM NEW.mark_hash::text
     OR r->>'categoryId' IS DISTINCT FROM NEW.category_id::text
     OR r->>'categoryVersionId' IS DISTINCT FROM NEW.category_version_id::text
     OR r->>'categoryVersionHash' IS DISTINCT FROM NEW.category_version_hash::text
     OR r->>'ratificationEntryId' IS DISTINCT FROM NEW.ratification_entry_id::text
     OR r->>'ratificationHash' IS DISTINCT FROM NEW.ratification_hash::text
     OR r->>'standing' IS DISTINCT FROM NEW.standing THEN
    RAISE EXCEPTION 'a record basis must be the record pin of its RECORD_SET candidate' USING ERRCODE = 'BR134';
  END IF;
  SELECT m.provenance INTO mprov FROM record.record_mark m
    WHERE m.id = NEW.record_mark_id AND m.mark_hash = NEW.mark_hash AND m.category_id = NEW.category_id
      AND m.category_version_id = NEW.category_version_id AND m.category_spec_hash = NEW.category_version_hash
      AND m.holder_type = a.holder_type AND m.holder_id = a.holder_id;
  IF mprov IS NULL OR mprov IS DISTINCT FROM a.snapshot_provenance THEN
    RAISE EXCEPTION 'a RECORD_SET must name an existing mark (same hash, category version, holder, provenance)'
      USING ERRCODE = 'BR134';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM record.mark_status_entry s
                 WHERE s.id = NEW.ratification_entry_id AND s.record_mark_id = NEW.record_mark_id
                   AND s.ratification_ref IS NOT NULL AND s.ratification_hash = NEW.ratification_hash
                   AND s.status = NEW.standing) THEN
    RAISE EXCEPTION 'a RECORD_SET must pin the mark''s own ratification entry' USING ERRCODE = 'BR134';
  END IF;
  SELECT s.status INTO latest FROM record.mark_status_entry s
    WHERE s.record_mark_id = NEW.record_mark_id ORDER BY s.seq DESC LIMIT 1;
  IF latest IS NULL OR latest NOT IN ('RATIFIED', 'CANONICAL', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'a RECORD_SET needs a validly ratified mark (never PENDING, never RESCINDED)' USING ERRCODE = 'BR134';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER record_basis_binding BEFORE INSERT ON achievement.record_basis
  FOR EACH ROW EXECUTE FUNCTION achievement.assert_record_basis();

-- At commit: a RECORD_SET Achievement has exactly its one record link (nothing partial).
CREATE FUNCTION achievement.assert_record_set_complete() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.achievement_type = 'RECORD_SET'
     AND (SELECT count(*) FROM achievement.record_basis x WHERE x.achievement_id = NEW.id) <> 1 THEN
    RAISE EXCEPTION 'a RECORD_SET must commit with its record link' USING ERRCODE = 'BR135';
  END IF;
  IF NEW.achievement_type <> 'RECORD_SET' AND NEW.candidate ? 'record' THEN
    RAISE EXCEPTION 'only a RECORD_SET carries a record pin' USING ERRCODE = 'BR135';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER achievement_record_set_complete AFTER INSERT ON achievement.achievement
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION achievement.assert_record_set_complete();

REVOKE ALL ON FUNCTION achievement.assert_record_basis(), achievement.assert_record_set_complete() FROM PUBLIC;

CREATE TRIGGER record_basis_append_only BEFORE UPDATE OR DELETE ON achievement.record_basis
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
CREATE TRIGGER record_basis_no_truncate BEFORE TRUNCATE ON achievement.record_basis
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();
CREATE TRIGGER record_basis_recorded_at BEFORE INSERT ON achievement.record_basis
  FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at();

-- The Achievement writer (br_achievements) writes the link; the record runtime and rebuild only READ
-- it (RecordMark → RECORD_SET projection, dependency index) — never an achievement write.
GRANT SELECT, INSERT ON achievement.record_basis TO br_achievements;
GRANT SELECT ON achievement.record_basis TO br_records, br_rebuild;
GRANT USAGE ON SCHEMA achievement TO br_records;
GRANT SELECT (id, achievement_type, holder_type, holder_id, recorded_at, snapshot_provenance)
  ON achievement.achievement TO br_records;
GRANT SELECT ON achievement.basis_item, achievement.status_entry, achievement.v_achievement_status TO br_records;
