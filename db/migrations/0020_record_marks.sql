-- BRT-09 · RecordMarks (BRT-01 verification model §9.2–9.4, disputes §5.3, ADR-0044, ADR-0045).
--
-- A RecordMark is the append-only historical fact that a VERIFIED IMMUTABLE PERFORMANCE held record
-- standing in one exact RecordCategory universe. Nothing here is ever updated or deleted:
--   record.record_mark           the immutable mark content (hash-bound candidate): category version,
--                                exact Performance basis (ResultVersion + content hash + pinned
--                                VerificationRun + evidence commitment + governing recognition), exact
--                                value, holder, metric, comparator, tie policy, SPORTING effectiveFrom
--   record.mark_member_credit    TEAM credits (AC-5) — provenance, never separate athlete marks
--   record.mark_status_entry     BRT-01 statusHistory: PENDING_RATIFICATION → RATIFIED / CANONICAL →
--                                SUPERSEDED (effectiveTo) → restored (RC-3) … → RESCINDED. The closed
--                                effectiveTo stays in history; a restoration re-opens the period with a
--                                NEW entry. Ratification entries pin the br:record-ratification@1 doc.
--   record.mark_supersession     append-only links (better mark / correction replacement)
--   record.mark_dependency       the dependency index (ResultVersion, VerificationRun, category version,
--                                ratification, corrected mark) for correction impact
--   record.evaluation            every record-engine evaluation (snapshot + outcome hashes, state,
--                                blockers, the standing marks considered) — the reproducible audit trail
--
-- The mark row NEVER carries an achievementId: the RECORD_SET Achievement points at the mark through
-- its own immutable, hash-bound pin (achievement.record_basis, 0021) — no circular mutable reference.
--
-- Provenance containment (ADR-0037 pattern): the normal schema accepts ONLY CANONICAL_ASSEMBLY marks,
-- evaluations and assessments, and ONLY CANONICAL_ATTESTATION ratifications — which must name a BRT-06
-- attestation of claim type RECORD_RATIFIED / REVIEW_COMPLETED about THIS mark. BRT-06 admits neither
-- claim type (deferred BRT-06R), so a normal database can hold ZERO ratified marks today: the honest
-- production ceiling. REFERENCE_FIXTURE rows exist only in throwaway overlay databases.
--
-- Table classes: A (append-only) for every table here.

-- A · The mark.
CREATE TABLE record.record_mark (
  id                       uuid PRIMARY KEY,
  identity_hash            platform.content_hash NOT NULL,
  mark_hash                platform.content_hash NOT NULL,
  candidate                jsonb NOT NULL CHECK (jsonb_typeof(candidate) = 'object' AND octet_length(candidate::text) <= 32768),
  category_id              uuid NOT NULL REFERENCES record.category (id),
  category_version_id      uuid NOT NULL REFERENCES record.category_version (id),
  category_spec_hash       platform.content_hash NOT NULL,
  scope_type               text NOT NULL,
  engine_version           text NOT NULL CHECK (engine_version ~ '^record-engine/[1-9][0-9]{0,3}$'),
  holder_type              text NOT NULL CHECK (holder_type IN ('ATHLETE', 'TEAM')),
  holder_id                uuid NOT NULL,
  value                    jsonb NOT NULL CHECK (jsonb_typeof(value) = 'object'),
  mark_metric_id           text NOT NULL,
  comparator               text NOT NULL CHECK (comparator IN ('HIGHER_IS_BETTER', 'LOWER_IS_BETTER')),
  tie_policy               text NOT NULL CHECK (tie_policy IN ('SHARED', 'FIRST_ACHIEVED')),
  result_version_id        uuid NOT NULL,
  content_hash             platform.content_hash NOT NULL,
  participant_id           uuid NOT NULL,
  performance_ordinal      integer NOT NULL CHECK (performance_ordinal >= 1),
  verification_run_id      uuid NOT NULL,
  basis_level              text NOT NULL CHECK (basis_level IN ('V2', 'V3', 'V4')),
  evidence_commitment      platform.content_hash NOT NULL,
  competition_id           uuid NOT NULL,
  event_id                 uuid,
  discipline_version_id    uuid NOT NULL REFERENCES sports.discipline_version (id),
  -- The SPORTING effective time (the performance), never ratification / insertion time.
  effective_from           timestamptz NOT NULL,
  evaluation_snapshot_hash platform.content_hash NOT NULL,
  evaluation_outcome_hash  platform.content_hash NOT NULL,
  provenance               text NOT NULL,
  requested_by_account_id  uuid REFERENCES identity.account (id),
  recorded_at              timestamptz NOT NULL,
  CONSTRAINT record_mark_identity_key UNIQUE (identity_hash),
  CONSTRAINT record_mark_canonical_provenance_only CHECK (provenance = 'CANONICAL_ASSEMBLY')
);
CREATE INDEX record_mark_category_idx ON record.record_mark (category_id, effective_from, id);
CREATE INDEX record_mark_holder_idx ON record.record_mark (holder_type, holder_id);
CREATE INDEX record_mark_rv_idx ON record.record_mark (result_version_id);
CREATE INDEX record_mark_run_idx ON record.record_mark (verification_run_id);

-- A · TEAM member credits (AC-5): immutable content of the TEAM mark, never separate athlete marks.
CREATE TABLE record.mark_member_credit (
  record_mark_id uuid NOT NULL REFERENCES record.record_mark (id),
  athlete_id     uuid NOT NULL,
  credit_role    text NOT NULL CHECK (credit_role IN ('LINEUP_MEMBER')),
  recorded_at    timestamptz NOT NULL,
  PRIMARY KEY (record_mark_id, athlete_id)
);
CREATE INDEX mark_member_credit_athlete_idx ON record.mark_member_credit (athlete_id);

-- A · Supersession links (a better mark, or the corrected replacement of a mark).
CREATE TABLE record.mark_supersession (
  superseded_mark_id  uuid NOT NULL REFERENCES record.record_mark (id),
  superseding_mark_id uuid NOT NULL REFERENCES record.record_mark (id),
  kind                text NOT NULL CHECK (kind IN ('BETTER_MARK', 'CORRECTION')),
  recorded_at         timestamptz NOT NULL,
  CONSTRAINT mark_supersession_pkey PRIMARY KEY (superseded_mark_id, superseding_mark_id),
  CHECK (superseded_mark_id <> superseding_mark_id)
);
CREATE INDEX mark_supersession_superseding_idx ON record.mark_supersession (superseding_mark_id);

-- A · Status history (BRT-01 §9.2 statusHistory + RC-3 effective history).
CREATE TABLE record.mark_status_entry (
  id                       uuid PRIMARY KEY,
  record_mark_id           uuid NOT NULL REFERENCES record.record_mark (id),
  status                   text NOT NULL CHECK (status IN ('PENDING_RATIFICATION', 'RATIFIED', 'CANONICAL', 'SUPERSEDED', 'RESCINDED')),
  reasons                  text[] NOT NULL DEFAULT '{}' CHECK (cardinality(reasons) <= 32),
  -- SUPERSEDED: when the holding ended (the successor's sporting effectiveFrom) and by whom.
  effective_to             timestamptz,
  superseded_by_mark_id    uuid REFERENCES record.record_mark (id),
  -- RATIFIED / CANONICAL by authority (restoration = false) or re-opened by replay (restoration = true).
  restoration              boolean NOT NULL DEFAULT false,
  ratification             jsonb CHECK (ratification IS NULL OR jsonb_typeof(ratification) = 'object'),
  ratification_hash        platform.content_hash,
  ratification_provenance  text,
  ratification_ref         uuid,
  evaluation_snapshot_hash platform.content_hash,
  evaluation_outcome_hash  platform.content_hash,
  verification_run_id      uuid,
  -- The level of the run pinned at that transition (a copy of the immutable run fact, never an input).
  ratification_run_level   text CHECK (ratification_run_level IS NULL OR ratification_run_level IN ('V2', 'V3', 'V4')),
  replay_hash              platform.content_hash,
  support_facts_hash       platform.content_hash,
  assessment_provenance    text NOT NULL,
  recorded_at              timestamptz NOT NULL,
  seq                      bigint GENERATED ALWAYS AS IDENTITY,
  CONSTRAINT mark_status_canonical_provenance_only CHECK (assessment_provenance = 'CANONICAL_ASSEMBLY'),
  CONSTRAINT mark_status_canonical_ratification_only CHECK (ratification_provenance IS NULL OR ratification_provenance = 'CANONICAL_ATTESTATION'),
  CHECK ((status = 'SUPERSEDED') = (superseded_by_mark_id IS NOT NULL)),
  CHECK ((status = 'SUPERSEDED') = (effective_to IS NOT NULL)),
  CHECK (NOT restoration OR status IN ('RATIFIED', 'CANONICAL')),
  CHECK ((status IN ('RATIFIED', 'CANONICAL')) = (ratification_hash IS NOT NULL)),
  CHECK ((status IN ('RATIFIED', 'CANONICAL') AND NOT restoration) = (ratification_ref IS NOT NULL)),
  CHECK ((ratification_ref IS NULL) = (ratification IS NULL) AND (ratification_ref IS NULL) = (ratification_provenance IS NULL))
);
CREATE INDEX mark_status_entry_mark_idx ON record.mark_status_entry (record_mark_id, seq DESC);
-- 20 identical ratification deliveries ⇒ ONE transition: a ratification ratifies at most one mark,
-- and a mark is ratified by authority at most once (restorations re-open, they never re-ratify).
CREATE UNIQUE INDEX mark_status_ratification_once ON record.mark_status_entry (ratification_ref)
  WHERE ratification_ref IS NOT NULL;
CREATE UNIQUE INDEX mark_status_ratified_once_per_mark ON record.mark_status_entry (record_mark_id)
  WHERE ratification_ref IS NOT NULL;

CREATE VIEW record.v_mark_status AS
  SELECT m.id AS record_mark_id,
         (SELECT s.status FROM record.mark_status_entry s WHERE s.record_mark_id = m.id ORDER BY s.seq DESC LIMIT 1) AS status
  FROM record.record_mark m;

-- A · Dependency index (correction impact): which marks depend on ResultVersion X, VerificationRun Y,
-- category version C, ratification R, or replace mark M.
CREATE TABLE record.mark_dependency (
  record_mark_id  uuid NOT NULL REFERENCES record.record_mark (id),
  dependency_type text NOT NULL CHECK (dependency_type IN ('RESULT_VERSION', 'VERIFICATION_RUN', 'CATEGORY_VERSION', 'RATIFICATION', 'CORRECTS_MARK')),
  dependency_id   uuid NOT NULL,
  dependency_hash platform.content_hash,
  recorded_at     timestamptz NOT NULL,
  PRIMARY KEY (record_mark_id, dependency_type, dependency_id)
);
CREATE INDEX mark_dependency_target_idx ON record.mark_dependency (dependency_type, dependency_id);

-- A · Every record-engine evaluation (reproducible audit; the comparison basis considered).
CREATE TABLE record.evaluation (
  id                   uuid PRIMARY KEY,
  category_id          uuid NOT NULL REFERENCES record.category (id),
  category_version_id  uuid NOT NULL REFERENCES record.category_version (id),
  result_version_id    uuid NOT NULL,
  participant_id       uuid NOT NULL,
  performance_ordinal  integer NOT NULL CHECK (performance_ordinal >= 1),
  mode                 text NOT NULL CHECK (mode IN ('ESTABLISH', 'RATIFY')),
  state                text NOT NULL CHECK (state IN ('QUALIFIES', 'DOES_NOT_QUALIFY', 'PENDING_REQUIRED_FACTS', 'INELIGIBLE', 'INTEGRITY_FAILURE')),
  reasons              text[] NOT NULL DEFAULT '{}' CHECK (cardinality(reasons) <= 64),
  considered_mark_ids  uuid[] NOT NULL DEFAULT '{}',
  record_mark_id       uuid REFERENCES record.record_mark (id),
  engine_version       text NOT NULL CHECK (engine_version ~ '^record-engine/[1-9][0-9]{0,3}$'),
  snapshot_hash        platform.content_hash NOT NULL,
  outcome_hash         platform.content_hash NOT NULL,
  outcome              jsonb NOT NULL CHECK (jsonb_typeof(outcome) = 'object' AND octet_length(outcome::text) <= 65536),
  provenance           text NOT NULL,
  recorded_at          timestamptz NOT NULL,
  CONSTRAINT record_evaluation_identity_key UNIQUE (category_version_id, snapshot_hash, mode),
  CONSTRAINT record_evaluation_canonical_provenance_only CHECK (provenance = 'CANONICAL_ASSEMBLY')
);
CREATE INDEX record_evaluation_rv_idx ON record.evaluation (result_version_id, participant_id, performance_ordinal);
CREATE INDEX record_evaluation_category_idx ON record.evaluation (category_id, recorded_at DESC);

-- ─────────────────────────────── structural bindings ───────────────────────────────

CREATE FUNCTION record.level_index(level text) RETURNS integer
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.array_position(ARRAY['V0', 'V1', 'V2', 'V3', 'V4'], level)
$$;

-- Columns equal the canonical candidate; the category version it names is PUBLISHED (same spec hash)
-- NOW; for CANONICAL_ASSEMBLY rows every upstream reference matches live canonical facts.
CREATE FUNCTION record.assert_record_mark() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  c jsonb := NEW.candidate;
  b jsonb := NEW.candidate->'basis';
  cur_status text;
BEGIN
  IF c->>'provenance' IS DISTINCT FROM NEW.provenance
     OR c->>'engineVersion' IS DISTINCT FROM NEW.engine_version
     OR c->'category'->>'categoryId' IS DISTINCT FROM NEW.category_id::text
     OR c->'category'->>'categoryVersionId' IS DISTINCT FROM NEW.category_version_id::text
     OR c->'category'->>'specHash' IS DISTINCT FROM NEW.category_spec_hash::text
     OR c->>'scopeType' IS DISTINCT FROM NEW.scope_type
     OR c->'holder'->>'holderType' IS DISTINCT FROM NEW.holder_type
     OR c->'holder'->>'holderId' IS DISTINCT FROM NEW.holder_id::text
     OR c->'value' IS DISTINCT FROM NEW.value
     OR c->'value'->>'metricId' IS DISTINCT FROM NEW.mark_metric_id
     OR c->'metric'->>'markMetricId' IS DISTINCT FROM NEW.mark_metric_id
     OR c->>'comparator' IS DISTINCT FROM NEW.comparator
     OR c->>'tiePolicy' IS DISTINCT FROM NEW.tie_policy
     OR b->>'resultVersionId' IS DISTINCT FROM NEW.result_version_id::text
     OR b->>'contentHash' IS DISTINCT FROM NEW.content_hash::text
     OR b->>'participantId' IS DISTINCT FROM NEW.participant_id::text
     OR (b->>'performanceOrdinal')::integer IS DISTINCT FROM NEW.performance_ordinal
     OR b->>'verificationRunId' IS DISTINCT FROM NEW.verification_run_id::text
     OR c->>'basisLevel' IS DISTINCT FROM NEW.basis_level
     OR c->>'evidenceCommitment' IS DISTINCT FROM NEW.evidence_commitment::text
     OR c->'context'->>'competitionId' IS DISTINCT FROM NEW.competition_id::text
     OR c->'context'->>'eventId' IS DISTINCT FROM NEW.event_id::text
     OR c->'context'->>'disciplineVersionId' IS DISTINCT FROM NEW.discipline_version_id::text
     OR (c->>'effectiveFrom')::timestamptz IS DISTINCT FROM NEW.effective_from THEN
    RAISE EXCEPTION 'record mark columns disagree with the canonical candidate' USING ERRCODE = 'BR150';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM record.category_version v
                 JOIN record.v_category_version_current s ON s.category_version_id = v.id
                 WHERE v.id = NEW.category_version_id AND v.category_id = NEW.category_id AND s.status = 'PUBLISHED'
                   AND v.spec_hash = NEW.category_spec_hash AND v.scope_type = NEW.scope_type
                   AND v.discipline_version_id = NEW.discipline_version_id AND v.mark_metric_id = NEW.mark_metric_id
                   AND v.effective_from <= NEW.effective_from) THEN
    RAISE EXCEPTION 'a record mark needs the PUBLISHED category version (same spec hash, universe, effective period) it names'
      USING ERRCODE = 'BR151';
  END IF;
  IF NEW.provenance = 'CANONICAL_ASSEMBLY' THEN
    IF NOT EXISTS (SELECT 1 FROM results.result_version rv
                   WHERE rv.id = NEW.result_version_id AND rv.content_hash = NEW.content_hash) THEN
      RAISE EXCEPTION 'record basis ResultVersion / content hash is not canonical' USING ERRCODE = 'BR152';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM verification.run r
                   WHERE r.id = NEW.verification_run_id AND r.result_version_id = NEW.result_version_id
                     AND r.snapshot_hash::text = b->>'verificationSnapshotHash'
                     AND r.outcome_hash::text = b->>'verificationOutcomeHash'
                     AND r.evidence_bundle_hash::text = b->>'evidenceBundleHash'
                     AND r.evaluated_as_of = (b->>'evidenceBundleAsOf')::timestamptz
                     AND r.highest_level = NEW.basis_level) THEN
      RAISE EXCEPTION 'record basis VerificationRun does not match the canonical run of that version' USING ERRCODE = 'BR152';
    END IF;
    SELECT t.to_status INTO cur_status FROM results.result_status_transition t
      WHERE t.result_version_id = NEW.result_version_id ORDER BY t.recorded_at DESC, t.id DESC LIMIT 1;
    IF cur_status IS DISTINCT FROM 'FINAL' OR cur_status IS DISTINCT FROM b->>'resultStatus' THEN
      RAISE EXCEPTION 'record basis result is not canonically FINAL' USING ERRCODE = 'BR152';
    END IF;
    IF (NEW.holder_type = 'ATHLETE' AND NOT EXISTS (SELECT 1 FROM identity.athlete x WHERE x.id = NEW.holder_id))
       OR (NEW.holder_type = 'TEAM' AND NOT EXISTS (SELECT 1 FROM competition.team x WHERE x.id = NEW.holder_id))
       OR NOT EXISTS (SELECT 1 FROM competition.competition x WHERE x.id = NEW.competition_id) THEN
      RAISE EXCEPTION 'record holder / competition is not canonical' USING ERRCODE = 'BR152';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER record_mark_binding BEFORE INSERT ON record.record_mark
  FOR EACH ROW EXECUTE FUNCTION record.assert_record_mark();

CREATE FUNCTION record.assert_mark_member_credit() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  prov text;
BEGIN
  SELECT m.provenance INTO prov FROM record.record_mark m, jsonb_array_elements(m.candidate->'memberCredits') x
    WHERE m.id = NEW.record_mark_id AND m.recorded_at = NEW.recorded_at AND m.holder_type = 'TEAM'
      AND x->>'athleteId' = NEW.athlete_id::text AND x->>'creditRole' = NEW.credit_role;
  IF prov IS NULL THEN
    RAISE EXCEPTION 'a member credit must be an element of its TEAM mark candidate' USING ERRCODE = 'BR153';
  END IF;
  IF prov = 'CANONICAL_ASSEMBLY' AND NOT EXISTS (SELECT 1 FROM identity.athlete x WHERE x.id = NEW.athlete_id) THEN
    RAISE EXCEPTION 'credited athlete is not canonical' USING ERRCODE = 'BR153';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER mark_member_credit_binding BEFORE INSERT ON record.mark_member_credit
  FOR EACH ROW EXECUTE FUNCTION record.assert_mark_member_credit();

-- At commit: every candidate member credit was written and the mark has its initial PENDING entry.
CREATE FUNCTION record.assert_mark_complete() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (SELECT count(*) FROM record.mark_member_credit x WHERE x.record_mark_id = NEW.id)
        <> COALESCE(jsonb_array_length(NEW.candidate->'memberCredits'), 0)
     OR NOT EXISTS (SELECT 1 FROM record.mark_status_entry s WHERE s.record_mark_id = NEW.id) THEN
    RAISE EXCEPTION 'a record mark must commit with its member credits and an initial status' USING ERRCODE = 'BR154';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER record_mark_complete AFTER INSERT ON record.record_mark
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION record.assert_mark_complete();

CREATE FUNCTION record.assert_mark_supersession() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
      SELECT 1 FROM record.record_mark o JOIN record.record_mark n ON n.id = NEW.superseding_mark_id
      WHERE o.id = NEW.superseded_mark_id AND o.category_id = n.category_id AND o.provenance = n.provenance) THEN
    RAISE EXCEPTION 'a supersession links two marks of the same category and provenance' USING ERRCODE = 'BR158';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER mark_supersession_binding BEFORE INSERT ON record.mark_supersession
  FOR EACH ROW EXECUTE FUNCTION record.assert_mark_supersession();

-- Status history: linearized per CATEGORY (one writer at a time — SHARED ties can never race into
-- FIRST_ACHIEVED); provenance equals the mark's; the first entry is PENDING_RATIFICATION; transitions
-- follow BRT-01 §9.2 / RC-3; ratification by authority only through a canonical attestation about
-- THIS mark (normal schema); CANONICAL only for an explicitly designated, non-PLATFORM keeper.
CREATE FUNCTION record.assert_mark_status() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  m record;
  cur text;
  spec jsonb;
  first_ratification platform.content_hash;
BEGIN
  SELECT rm.provenance, rm.category_id, rm.category_version_id, rm.mark_hash INTO m
    FROM record.record_mark rm WHERE rm.id = NEW.record_mark_id;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('record-mark-status:' || m.category_id::text, 0));
  IF m.provenance IS DISTINCT FROM NEW.assessment_provenance THEN
    RAISE EXCEPTION 'a status entry must have its mark''s provenance' USING ERRCODE = 'BR155';
  END IF;
  SELECT s.status INTO cur FROM record.mark_status_entry s WHERE s.record_mark_id = NEW.record_mark_id ORDER BY s.seq DESC LIMIT 1;
  IF NOT (
       (cur IS NULL AND NEW.status = 'PENDING_RATIFICATION')
    OR (cur = 'PENDING_RATIFICATION' AND NEW.status IN ('RATIFIED', 'CANONICAL', 'RESCINDED') AND NOT NEW.restoration)
    OR (cur = 'RATIFIED' AND NEW.status IN ('SUPERSEDED', 'RESCINDED'))
    OR (cur = 'CANONICAL' AND NEW.status IN ('SUPERSEDED', 'RESCINDED'))
    OR (cur = 'SUPERSEDED' AND NEW.status IN ('SUPERSEDED', 'RESCINDED'))
    OR (cur = 'SUPERSEDED' AND NEW.status IN ('RATIFIED', 'CANONICAL') AND NEW.restoration)
  ) THEN
    RAISE EXCEPTION 'record mark status % cannot follow %', NEW.status, COALESCE(cur, 'creation') USING ERRCODE = 'BR155';
  END IF;
  IF NEW.status IN ('RATIFIED', 'CANONICAL') AND NOT NEW.restoration THEN
    IF NEW.ratification->>'recordMarkId' IS DISTINCT FROM NEW.record_mark_id::text
       OR NEW.ratification->>'markHash' IS DISTINCT FROM m.mark_hash::text
       OR NEW.ratification->>'subjectHash' IS DISTINCT FROM m.mark_hash::text
       OR NEW.ratification->>'ref' IS DISTINCT FROM NEW.ratification_ref::text
       OR NEW.ratification->>'provenance' IS DISTINCT FROM NEW.ratification_provenance
       OR NEW.ratification->>'standing' IS DISTINCT FROM NEW.status THEN
      RAISE EXCEPTION 'a ratification must bind to this exact mark hash' USING ERRCODE = 'BR156';
    END IF;
    IF NEW.ratification_provenance = 'CANONICAL_ATTESTATION' AND NOT EXISTS (
         SELECT 1 FROM attestation.attestation a
         WHERE a.id = NEW.ratification_ref AND a.subject_type = 'RECORD_MARK' AND a.subject_id = NEW.record_mark_id
           AND a.claim_type IN ('RECORD_RATIFIED', 'REVIEW_COMPLETED')) THEN
      RAISE EXCEPTION 'a canonical ratification must be a RECORD_RATIFIED / REVIEW_COMPLETED attestation about this mark'
        USING ERRCODE = 'BR156';
    END IF;
  END IF;
  IF NEW.restoration THEN
    -- RC-3: a restoration re-opens the period of a mark that WAS ratified — never a new ratification.
    SELECT s.ratification_hash INTO first_ratification FROM record.mark_status_entry s
      WHERE s.record_mark_id = NEW.record_mark_id AND s.ratification_ref IS NOT NULL;
    IF first_ratification IS NULL OR first_ratification IS DISTINCT FROM NEW.ratification_hash THEN
      RAISE EXCEPTION 'a restoration must re-open the mark''s own ratification' USING ERRCODE = 'BR156';
    END IF;
  END IF;
  IF NEW.status = 'CANONICAL' THEN
    SELECT v.spec INTO spec FROM record.category_version v WHERE v.id = m.category_version_id;
    IF spec->'canonicalKeeper' IS NULL OR spec->'scope'->>'scopeType' = 'PLATFORM'
       OR spec->'recognition'->>'level' = 'PLATFORM' THEN
      RAISE EXCEPTION 'CANONICAL needs an explicitly designated, non-PLATFORM canonical keeper' USING ERRCODE = 'BR157';
    END IF;
  END IF;
  IF NEW.status = 'SUPERSEDED' AND NOT EXISTS (SELECT 1 FROM record.mark_supersession x
      WHERE x.superseded_mark_id = NEW.record_mark_id AND x.superseding_mark_id = NEW.superseded_by_mark_id) THEN
    RAISE EXCEPTION 'SUPERSEDED needs a supersession link' USING ERRCODE = 'BR155';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER mark_status_entry_binding BEFORE INSERT ON record.mark_status_entry
  FOR EACH ROW EXECUTE FUNCTION record.assert_mark_status();

CREATE FUNCTION record.assert_mark_dependency() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.dependency_type = 'CATEGORY_VERSION' AND NOT EXISTS (
       SELECT 1 FROM record.record_mark m WHERE m.id = NEW.record_mark_id AND m.category_version_id = NEW.dependency_id) THEN
    RAISE EXCEPTION 'a category-version dependency must be the mark''s own version' USING ERRCODE = 'BR159';
  END IF;
  IF NEW.dependency_type = 'RESULT_VERSION' AND NOT EXISTS (
       SELECT 1 FROM record.record_mark m WHERE m.id = NEW.record_mark_id AND m.result_version_id = NEW.dependency_id) THEN
    RAISE EXCEPTION 'a result-version dependency must be the mark''s own basis' USING ERRCODE = 'BR159';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER mark_dependency_binding BEFORE INSERT ON record.mark_dependency
  FOR EACH ROW EXECUTE FUNCTION record.assert_mark_dependency();

REVOKE ALL ON FUNCTION record.assert_record_mark(), record.assert_mark_member_credit(),
  record.assert_mark_complete(), record.assert_mark_supersession(), record.assert_mark_status(),
  record.assert_mark_dependency(), record.level_index(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record.level_index(text) TO br_records, br_rebuild;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['record_mark', 'mark_member_credit', 'mark_supersession', 'mark_status_entry',
                           'mark_dependency', 'evaluation'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON record.%I FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON record.%I FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation()', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON record.%I FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at()', t || '_recorded_at', t);
    EXECUTE format('GRANT SELECT, INSERT ON record.%I TO br_records', t);
    EXECUTE format('GRANT SELECT ON record.%I TO br_rebuild', t);
  END LOOP;
END
$$;
GRANT SELECT ON record.v_mark_status TO br_records, br_rebuild, br_achievements;
-- The RECORD_SET derivation (Achievement module) reads the exact mark and its ratification entry.
GRANT SELECT ON record.record_mark, record.mark_status_entry TO br_achievements;

-- ─────────────────────── record runtime: narrow read-only inputs ───────────────────────
-- br_records READS the exact canonical facts an evaluation needs (read-only direct grants on the exact
-- tables; no module membership) and WRITES only record facts, its read models, its ledger stream,
-- outbox events and audit rows. It never writes results, verification, evidence, attestations,
-- authority, competition, identity, achievements, rankings, prizes or trophies; it never reads
-- identity_private, evidence bytes / storage, profiles or keys. BRT-07 freshness and the pinned run
-- trace are read under the SELECT-only br_verification_reader in the same transaction.
GRANT USAGE ON SCHEMA platform TO br_records;
GRANT EXECUTE ON FUNCTION platform.tx_time_ms() TO br_records;
GRANT SELECT, INSERT ON platform.ledger_entry TO br_records;
GRANT SELECT, INSERT, UPDATE ON platform.stream_head TO br_records;
GRANT SELECT, INSERT ON platform.outbox_event TO br_records;
GRANT SELECT, INSERT ON platform.command_idempotency TO br_records;
GRANT INSERT ON platform.audit_event TO br_records;

GRANT USAGE ON SCHEMA results TO br_records;
GRANT SELECT ON results.result, results.result_version, results.result_status_transition TO br_records;
GRANT EXECUTE ON FUNCTION results.resolve_result_version(uuid) TO br_records;

GRANT USAGE ON SCHEMA verification TO br_records;
GRANT SELECT ON verification.run TO br_records;
GRANT USAGE ON SCHEMA authority TO br_records;
GRANT SELECT (id, fact_hash, recognition_scope) ON authority.trust_anchor TO br_records;
-- Ratification consumer (deferred producer): only the columns that bind a claim to its subject.
GRANT USAGE ON SCHEMA attestation TO br_records;
GRANT SELECT (id, subject_type, subject_id, claim_type) ON attestation.attestation TO br_records;

GRANT USAGE ON SCHEMA competition TO br_records;
GRANT EXECUTE ON FUNCTION competition.resolve_scope_path(text, uuid) TO br_records;
GRANT EXECUTE ON FUNCTION competition.account_competition_roles(uuid, uuid) TO br_records;
GRANT SELECT ON competition.competition, competition.v_competition_current, competition.event,
  competition.v_event_current, competition.participant, competition.team, competition.contest,
  competition.contest_status_change TO br_records;

GRANT USAGE ON SCHEMA sports TO br_records;
GRANT SELECT ON sports.sport, sports.discipline, sports.discipline_version TO br_records;

GRANT USAGE ON SCHEMA identity TO br_records;
GRANT SELECT (id) ON identity.athlete TO br_records;
