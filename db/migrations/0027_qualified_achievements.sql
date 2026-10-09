-- BRT-10 Step 9 · QUALIFIED through the validated BRT-08 Achievement path (BRT-01 §7, §8.2; ADR-0050).
--
-- Minimal extension of BRT-08 using the RECORD_SET recipe (0016–0026 are never edited):
--   · the Achievement vocabulary admits QUALIFIED (rule + fact CHECKs). A QUALIFIED Achievement is
--     scoped to its TARGET competition (scope COMPETITION = context competition) and is derived only
--     by achievement-engine/3;
--   · achievement.qualification_basis (class A) is the append-only, hash-bound LINK from a QUALIFIED
--     Achievement to its exact qualifying position: target, N, rank / tie, the published ranking
--     snapshot (system, version, id + hash) OR the classification ResultVersion (id + content hash +
--     policy version), the br:qualification-basis@1 hash and the target authority's adoption. It is
--     the `qualification` element of the Achievement's canonical candidate, written in the same
--     transaction. The database enforces rank ≤ N, the kind ↔ position coherence and that the link
--     equals the candidate pin;
--   · a QUALIFIED must commit with exactly one link (deferred check), and at most ONE non-terminal
--     (ACTIVE / SUSPENDED) QUALIFIED exists per (rule, holder, target, provenance): a later snapshot
--     never adds a second one — only a correction supersedes it (decision, Step 9);
--   · TARGET_QUALIFICATION_AUTHORITY has NO canonical producer (ADR-0050 §4): the binding trigger
--     REFUSES every CANONICAL_ASSEMBLY QUALIFIED (fail closed, BR184), and the provenance CHECK admits
--     CANONICAL_ASSEMBLY only, so the normal schema holds ZERO QUALIFIED Achievements. Fixture rows
--     exist only in throwaway br_rkfx_ databases carrying the test-only overlays.
--
-- Dependency boundary: this migration reads canonical class-A facts only (ranking.snapshot /
-- snapshot_entry, results.*). It never references ranking_read.* (0028, a projection that a fresh
-- database creates AFTER this file): no foreign key, view, grant or function touches that schema.
-- No ranking, classification, result or verification row is ever written by the Achievement runtime.
ALTER TABLE achievement.rule
  DROP CONSTRAINT rule_achievement_type_check,
  ADD CONSTRAINT rule_achievement_type_check CHECK (achievement_type IN (
    'EVENT_COMPLETED', 'CONTEST_WON', 'PLACEMENT', 'TITLE', 'PERFORMANCE_THRESHOLD', 'PERSONAL_BEST', 'RECORD_SET',
    'QUALIFIED'));

ALTER TABLE achievement.achievement
  DROP CONSTRAINT achievement_achievement_type_check,
  ADD CONSTRAINT achievement_achievement_type_check CHECK (achievement_type IN (
    'EVENT_COMPLETED', 'CONTEST_WON', 'PLACEMENT', 'TITLE', 'PERFORMANCE_THRESHOLD', 'PERSONAL_BEST', 'RECORD_SET',
    'QUALIFIED')),
  -- QUALIFIED ⇒ scoped to the target competition; engine/3; never below the V3 floor (BRT-01 §7, no
  -- downgrade); no qualifying value, comparison set or event.
  ADD CONSTRAINT achievement_qualified_shape CHECK (achievement_type <> 'QUALIFIED' OR (
    scope_type = 'COMPETITION' AND scope_id = competition_id AND event_id IS NULL
    AND qualifying_value IS NULL AND comparison_set_hash IS NULL
    AND engine_version = 'achievement-engine/3' AND basis_level IN ('V3', 'V4')));

-- A · The QUALIFIED → qualifying-position link.
CREATE TABLE achievement.qualification_basis (
  achievement_id                   uuid NOT NULL REFERENCES achievement.achievement (id),
  rule_id                          uuid NOT NULL REFERENCES achievement.rule (id),
  holder_type                      text NOT NULL CHECK (holder_type IN ('ATHLETE', 'TEAM')),
  holder_id                        uuid NOT NULL,
  target_competition_id            uuid NOT NULL,
  basis_kind                       text NOT NULL CHECK (basis_kind IN ('RANKING_SNAPSHOT_POSITION', 'CLASSIFICATION_POSITION')),
  qualifying_ranks                 integer NOT NULL CHECK (qualifying_ranks BETWEEN 1 AND 10000),
  rank                             integer NOT NULL CHECK (rank BETWEEN 1 AND 1000000),
  tied                             boolean NOT NULL,
  ranking_system_id                uuid,
  ranking_system_version_id        uuid,
  snapshot_id                      uuid,
  snapshot_hash                    platform.content_hash,
  classification_version_id        uuid,
  classification_content_hash      platform.content_hash,
  classification_policy_version_id uuid,
  basis_hash                       platform.content_hash NOT NULL,
  target_adoption_id               uuid NOT NULL,
  target_adoption_hash             platform.content_hash NOT NULL,
  provenance                       text NOT NULL,
  recorded_at                      timestamptz NOT NULL,
  CONSTRAINT qualification_basis_pkey PRIMARY KEY (achievement_id),
  -- Threshold semantics in the database: every holder whose (shared) rank is ≤ N, never N + 1.
  CONSTRAINT qualification_basis_rank_within_qualifying_ranks CHECK (rank <= qualifying_ranks),
  CONSTRAINT qualification_basis_kind_coherence CHECK (
    (basis_kind = 'RANKING_SNAPSHOT_POSITION'
       AND ranking_system_id IS NOT NULL AND ranking_system_version_id IS NOT NULL
       AND snapshot_id IS NOT NULL AND snapshot_hash IS NOT NULL
       AND classification_version_id IS NULL AND classification_content_hash IS NULL
       AND classification_policy_version_id IS NULL)
    OR (basis_kind = 'CLASSIFICATION_POSITION'
       AND ranking_system_id IS NULL AND ranking_system_version_id IS NULL
       AND snapshot_id IS NULL AND snapshot_hash IS NULL
       AND classification_version_id IS NOT NULL AND classification_content_hash IS NOT NULL
       AND classification_policy_version_id IS NOT NULL)),
  CONSTRAINT qualification_basis_canonical_provenance_only CHECK (provenance = 'CANONICAL_ASSEMBLY')
);
CREATE INDEX qualification_basis_family_idx
  ON achievement.qualification_basis (rule_id, holder_type, holder_id, target_competition_id);
-- Dependency index: which QUALIFIED Achievements rest on snapshot S / classification version C.
CREATE INDEX qualification_basis_snapshot_idx ON achievement.qualification_basis (snapshot_id);
CREATE INDEX qualification_basis_classification_idx ON achievement.qualification_basis (classification_version_id);

CREATE FUNCTION achievement.assert_qualification_basis() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  a record;
  q jsonb;
  rq jsonb;
BEGIN
  SELECT x.candidate, x.achievement_type, x.snapshot_provenance, x.rule_id, x.holder_type, x.holder_id,
         x.scope_id, x.recorded_at, x.rule_version_id
    INTO a FROM achievement.achievement x WHERE x.id = NEW.achievement_id;
  q := a.candidate->'qualification';
  SELECT v.spec->'criterion'->'qualification' INTO rq FROM achievement.rule_version v WHERE v.id = a.rule_version_id;
  IF a.achievement_type IS DISTINCT FROM 'QUALIFIED' OR a.recorded_at IS DISTINCT FROM NEW.recorded_at
     OR a.snapshot_provenance IS DISTINCT FROM NEW.provenance OR a.rule_id IS DISTINCT FROM NEW.rule_id
     OR a.holder_type IS DISTINCT FROM NEW.holder_type OR a.holder_id IS DISTINCT FROM NEW.holder_id
     OR a.scope_id IS DISTINCT FROM NEW.target_competition_id
     OR q->>'targetCompetitionId' IS DISTINCT FROM NEW.target_competition_id::text
     OR q->>'kind' IS DISTINCT FROM NEW.basis_kind
     OR (q->>'qualifyingRanks')::integer IS DISTINCT FROM NEW.qualifying_ranks
     OR q->>'basisHash' IS DISTINCT FROM NEW.basis_hash::text
     OR q->'targetAuthority'->>'adoptionId' IS DISTINCT FROM NEW.target_adoption_id::text
     OR q->'targetAuthority'->>'adoptionHash' IS DISTINCT FROM NEW.target_adoption_hash::text
     OR (NEW.basis_kind = 'RANKING_SNAPSHOT_POSITION' AND (
           q->'ranking'->>'systemId' IS DISTINCT FROM NEW.ranking_system_id::text
           OR q->'ranking'->>'systemVersionId' IS DISTINCT FROM NEW.ranking_system_version_id::text
           OR q->'ranking'->>'snapshotId' IS DISTINCT FROM NEW.snapshot_id::text
           OR q->'ranking'->>'snapshotHash' IS DISTINCT FROM NEW.snapshot_hash::text
           OR (q->'ranking'->>'rank')::integer IS DISTINCT FROM NEW.rank
           OR (q->'ranking'->>'tied')::boolean IS DISTINCT FROM NEW.tied
           OR q ? 'classification'))
     OR (NEW.basis_kind = 'CLASSIFICATION_POSITION' AND (
           q->'classification'->>'resultVersionId' IS DISTINCT FROM NEW.classification_version_id::text
           OR q->'classification'->>'contentHash' IS DISTINCT FROM NEW.classification_content_hash::text
           OR q->'classification'->>'policyVersionId' IS DISTINCT FROM NEW.classification_policy_version_id::text
           OR (q->'classification'->>'rank')::integer IS DISTINCT FROM NEW.rank
           OR (q->'classification'->>'tied')::boolean IS DISTINCT FROM NEW.tied
           OR q ? 'ranking')) THEN
    RAISE EXCEPTION 'a qualification basis must be the qualification pin of its QUALIFIED candidate' USING ERRCODE = 'BR183';
  END IF;
  -- The target, the threshold N and the pinned source are the RULE VERSION's own declaration: never
  -- a lowered threshold, another target, another system version or another policy version.
  IF rq IS NULL OR rq->>'targetCompetitionId' IS DISTINCT FROM NEW.target_competition_id::text
     OR (rq->>'qualifyingRanks')::integer IS DISTINCT FROM NEW.qualifying_ranks
     OR rq->'source'->>'kind' IS DISTINCT FROM NEW.basis_kind
     OR (NEW.basis_kind = 'RANKING_SNAPSHOT_POSITION' AND (
           rq->'source'->>'rankingSystemId' IS DISTINCT FROM NEW.ranking_system_id::text
           OR rq->'source'->>'rankingSystemVersionId' IS DISTINCT FROM NEW.ranking_system_version_id::text))
     OR (NEW.basis_kind = 'CLASSIFICATION_POSITION'
         AND rq->'source'->>'policyVersionId' IS DISTINCT FROM NEW.classification_policy_version_id::text) THEN
    RAISE EXCEPTION 'a qualification basis must be its rule version''s target, threshold and source' USING ERRCODE = 'BR183';
  END IF;
  -- A ranking position names an existing snapshot of the same provenance (exact id, hash, system
  -- version) in which this holder holds exactly this (shared) rank. Never a run, never a projection.
  IF NEW.basis_kind = 'RANKING_SNAPSHOT_POSITION' AND NOT EXISTS (
       SELECT 1 FROM ranking.snapshot s JOIN ranking.snapshot_entry e ON e.snapshot_id = s.id
       WHERE s.id = NEW.snapshot_id AND s.snapshot_hash = NEW.snapshot_hash
         AND s.system_id = NEW.ranking_system_id AND s.system_version_id = NEW.ranking_system_version_id
         AND s.provenance = NEW.provenance
         AND e.holder_type = NEW.holder_type AND e.holder_id = NEW.holder_id
         AND e.rank = NEW.rank AND e.tied = NEW.tied) THEN
    RAISE EXCEPTION 'a QUALIFIED must name a published snapshot of its provenance where the holder holds that rank'
      USING ERRCODE = 'BR183';
  END IF;
  -- ADR-0050 §4: the target competition's authority adopting the rule has NO canonical producer, so no
  -- canonical QUALIFIED can exist — whatever a caller writes. (Fixture rows: overlay databases only.)
  IF NEW.provenance = 'CANONICAL_ASSEMBLY' THEN
    RAISE EXCEPTION 'QUALIFIED needs TARGET_QUALIFICATION_AUTHORITY, which has no canonical producer'
      USING ERRCODE = 'BR184';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER qualification_basis_binding BEFORE INSERT ON achievement.qualification_basis
  FOR EACH ROW EXECUTE FUNCTION achievement.assert_qualification_basis();

-- At commit: a QUALIFIED Achievement has exactly its one qualification link (nothing partial), and
-- only a QUALIFIED carries a qualification pin.
CREATE FUNCTION achievement.assert_qualified_complete() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.achievement_type = 'QUALIFIED'
     AND (SELECT count(*) FROM achievement.qualification_basis x WHERE x.achievement_id = NEW.id) <> 1 THEN
    RAISE EXCEPTION 'a QUALIFIED must commit with its qualification link' USING ERRCODE = 'BR185';
  END IF;
  IF NEW.achievement_type <> 'QUALIFIED' AND NEW.candidate ? 'qualification' THEN
    RAISE EXCEPTION 'only a QUALIFIED carries a qualification pin' USING ERRCODE = 'BR185';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER achievement_qualified_complete AFTER INSERT ON achievement.achievement
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION achievement.assert_qualified_complete();

-- At commit: at most one non-terminal QUALIFIED per (rule, holder, target, provenance). A newer one
-- may only exist once the older one is SUPERSEDED or REVOKED (statuses only ever become terminal).
CREATE FUNCTION achievement.assert_qualified_single() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (SELECT count(*) FROM achievement.qualification_basis x
      JOIN achievement.v_achievement_status st ON st.achievement_id = x.achievement_id
      WHERE x.rule_id = NEW.rule_id AND x.holder_type = NEW.holder_type AND x.holder_id = NEW.holder_id
        AND x.target_competition_id = NEW.target_competition_id AND x.provenance = NEW.provenance
        AND st.status IN ('ACTIVE', 'SUSPENDED')) > 1 THEN
    RAISE EXCEPTION 'one non-terminal QUALIFIED per rule, holder and target competition' USING ERRCODE = 'BR185';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER qualification_basis_single AFTER INSERT ON achievement.qualification_basis
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION achievement.assert_qualified_single();

REVOKE ALL ON FUNCTION achievement.assert_qualification_basis(), achievement.assert_qualified_complete(),
  achievement.assert_qualified_single() FROM PUBLIC;

CREATE TRIGGER qualification_basis_append_only BEFORE UPDATE OR DELETE ON achievement.qualification_basis
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
CREATE TRIGGER qualification_basis_no_truncate BEFORE TRUNCATE ON achievement.qualification_basis
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();
CREATE TRIGGER qualification_basis_recorded_at BEFORE INSERT ON achievement.qualification_basis
  FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at();

-- The Achievement writer (br_achievements) writes the link; rebuild only reads it. No PUBLIC grant.
GRANT SELECT, INSERT ON achievement.qualification_basis TO br_achievements;
GRANT SELECT ON achievement.qualification_basis TO br_rebuild;

-- ─────────────── achievement runtime: narrow, READ-ONLY qualification inputs ───────────────
-- The canonical QUALIFIED assembler reads the exact class-A ranking / classification facts it pins
-- (system version, run, published snapshot + entries, classification derivation header + inputs,
-- classification policy versions) and the round of a classification scope's hierarchy. SELECT only:
-- the Achievement runtime never writes a ranking, snapshot, classification, result or verification.
GRANT USAGE ON SCHEMA ranking TO br_achievements;
GRANT SELECT ON ranking.system, ranking.system_version, ranking.run, ranking.snapshot, ranking.snapshot_entry,
  ranking.classification_policy_version, ranking.v_classification_policy_version_current TO br_achievements;
GRANT SELECT ON results.classification_derivation, results.classification_input TO br_achievements;
GRANT SELECT ON competition.round TO br_achievements;

-- Rule operator: a QUALIFIED rule's references (target competition, ranking system version,
-- classification scope + policy version) must name real canonical rows before a version can exist.
GRANT USAGE ON SCHEMA ranking TO br_achievement_rules;
GRANT SELECT (id, system_id, discipline_version_id) ON ranking.system_version TO br_achievement_rules;
GRANT SELECT (id, scope_type, discipline_version_id) ON ranking.classification_policy_version
  TO br_achievement_rules;
