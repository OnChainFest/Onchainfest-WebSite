-- BRT-10 · Ranking runs and immutable RankingSnapshots (ADR-0048 §4–6, §8; BRT-02 persistence §6;
-- BRT-01 disputes §5.2).
--
--   ranking.run              one deterministic engine evaluation: the exact system version + spec hash,
--                            the inputs digest (br:ranking-run-input@1 hash), the outcome
--                            (br:ranking-run-outcome@1) + hash, engine, as-of sporting cutoff,
--                            publication state, trigger. NOT a snapshot: blocked runs are recorded too.
--   ranking.run_dependency   the dependency index (ResultVersion, VerificationRun, system version) for
--                            correction impact
--   ranking.snapshot         the published, immutable RankingSnapshot (br:ranking-snapshot@1) — a
--                            separate derived artefact, NEVER a ResultVersion, with no lifecycle status;
--                            lineage INITIAL | FOLLOWS (previous_snapshot_id) | CORRECTS
--                            (corrects_snapshot_id)
--   ranking.snapshot_entry   one row per ranked holder: rank, tied, value, comparator trace, basis pins
--
-- Guarantees:
--   · run identity is UNIQUE on (system version, inputs digest): repeating the same inputs creates
--     nothing; the trigger is stored on the run but is not part of any hash;
--   · a snapshot is published only from a PUBLISHABLE run of the same, currently PUBLISHED system
--     version, carries exactly that run's entries, and has AT LEAST ONE entry (an empty run is
--     BLOCKED by the engine with NO_RANKED_ENTRIES; an empty snapshot is not representable);
--   · a correction is a NEW snapshot: lineage pins the prior snapshot by id + hash, each snapshot is
--     followed at most once and corrected at most once, and a system's first snapshot is INITIAL —
--     nothing is ever rewritten (as-published / as-corrected are queries);
--   · CANONICAL entries pin existing FINAL CONTEST ResultVersions (exact content hash) and the
--     canonical VerificationRun of that version.
-- Provenance containment (ADR-0037 pattern): the normal schema accepts ONLY CANONICAL_ASSEMBLY runs
-- and snapshots; REFERENCE_FIXTURE rows exist only in throwaway br_rkfx_ overlay databases.
-- Table classes: A (append-only) for every table here.

-- A · Run.
CREATE TABLE ranking.run (
  id                      uuid PRIMARY KEY,
  system_id               uuid NOT NULL REFERENCES ranking.system (id),
  system_version_id       uuid NOT NULL,
  spec_hash               platform.content_hash NOT NULL,
  engine_version          text NOT NULL CHECK (engine_version ~ '^ranking-engine/[1-9][0-9]{0,3}$'),
  provenance              text NOT NULL,
  input_hash              platform.content_hash NOT NULL,
  outcome_hash            platform.content_hash NOT NULL,
  outcome                 jsonb NOT NULL CHECK (jsonb_typeof(outcome) = 'object' AND octet_length(outcome::text) <= 8388608),
  as_of                   timestamptz NOT NULL,
  publication_state       text NOT NULL CHECK (publication_state IN ('PUBLISHABLE', 'BLOCKED')),
  publication_reasons     text[] NOT NULL DEFAULT '{}' CHECK (cardinality(publication_reasons) <= 32),
  entry_count             integer NOT NULL CHECK (entry_count BETWEEN 0 AND 10000),
  candidate_count         integer NOT NULL CHECK (candidate_count BETWEEN 0 AND 10000),
  -- Why the run was requested: recorded here, never hashed (RankingRunTrigger).
  trigger                 text NOT NULL CHECK (trigger IN ('SYSTEM_VERSION_PUBLISHED', 'UPSTREAM_FACT_CHANGED', 'STAFF_REQUEST', 'SCHEDULED_SWEEP')),
  requested_by_account_id uuid REFERENCES identity.account (id),
  recorded_at             timestamptz NOT NULL,
  CONSTRAINT ranking_run_identity_key UNIQUE (system_version_id, input_hash),
  -- Target of the (run, outcome hash) pin of a snapshot.
  CONSTRAINT run_outcome_pin_key UNIQUE (id, outcome_hash),
  CONSTRAINT run_system_version_pin_fk FOREIGN KEY (system_version_id, spec_hash)
    REFERENCES ranking.system_version (id, spec_hash),
  CONSTRAINT run_canonical_provenance_only CHECK (provenance = 'CANONICAL_ASSEMBLY'),
  CHECK ((publication_state = 'BLOCKED') = (cardinality(publication_reasons) > 0))
);
CREATE INDEX run_system_idx ON ranking.run (system_id, recorded_at DESC);

CREATE FUNCTION ranking.assert_run() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  o jsonb := NEW.outcome;
BEGIN
  IF o->>'engineVersion' IS DISTINCT FROM NEW.engine_version
     OR o->>'provenance' IS DISTINCT FROM NEW.provenance
     OR o->>'inputHash' IS DISTINCT FROM NEW.input_hash::text
     OR o->>'systemVersionId' IS DISTINCT FROM NEW.system_version_id::text
     OR o->>'specHash' IS DISTINCT FROM NEW.spec_hash::text
     OR (o->>'asOf')::timestamptz IS DISTINCT FROM NEW.as_of
     OR o->'publication'->>'state' IS DISTINCT FROM NEW.publication_state
     OR ARRAY(SELECT jsonb_array_elements_text(o->'publication'->'reasons')) IS DISTINCT FROM NEW.publication_reasons
     OR jsonb_array_length(o->'entries') IS DISTINCT FROM NEW.entry_count
     OR jsonb_array_length(o->'candidates') IS DISTINCT FROM NEW.candidate_count THEN
    RAISE EXCEPTION 'run columns disagree with the canonical outcome' USING ERRCODE = 'BR175';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ranking.system_version v WHERE v.id = NEW.system_version_id AND v.system_id = NEW.system_id) THEN
    RAISE EXCEPTION 'a run must name its system version''s own system' USING ERRCODE = 'BR175';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER run_binding BEFORE INSERT ON ranking.run
  FOR EACH ROW EXECUTE FUNCTION ranking.assert_run();

-- A · Dependency index (correction impact): which runs depend on ResultVersion X, VerificationRun Y
-- or system version S.
CREATE TABLE ranking.run_dependency (
  run_id          uuid NOT NULL REFERENCES ranking.run (id),
  dependency_type text NOT NULL CHECK (dependency_type IN ('RESULT_VERSION', 'VERIFICATION_RUN', 'SYSTEM_VERSION')),
  dependency_id   uuid NOT NULL,
  dependency_hash platform.content_hash,
  recorded_at     timestamptz NOT NULL,
  PRIMARY KEY (run_id, dependency_type, dependency_id)
);
CREATE INDEX run_dependency_target_idx ON ranking.run_dependency (dependency_type, dependency_id);

CREATE FUNCTION ranking.assert_run_dependency() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  r record;
BEGIN
  SELECT x.system_version_id, x.spec_hash, x.recorded_at INTO r FROM ranking.run x WHERE x.id = NEW.run_id;
  IF r.recorded_at IS DISTINCT FROM NEW.recorded_at THEN
    RAISE EXCEPTION 'a run dependency is written with its run' USING ERRCODE = 'BR176';
  END IF;
  IF NEW.dependency_type = 'SYSTEM_VERSION'
     AND (NEW.dependency_id <> r.system_version_id OR NEW.dependency_hash IS DISTINCT FROM r.spec_hash) THEN
    RAISE EXCEPTION 'a system-version dependency must be the run''s own version and spec hash' USING ERRCODE = 'BR176';
  END IF;
  IF NEW.dependency_type = 'RESULT_VERSION' AND NOT EXISTS (
       SELECT 1 FROM results.result_version rv
       WHERE rv.id = NEW.dependency_id AND rv.content_hash = NEW.dependency_hash) THEN
    RAISE EXCEPTION 'a result-version dependency must be a canonical version with its content hash' USING ERRCODE = 'BR176';
  END IF;
  IF NEW.dependency_type = 'VERIFICATION_RUN' AND NOT EXISTS (
       SELECT 1 FROM verification.run v WHERE v.id = NEW.dependency_id AND v.outcome_hash = NEW.dependency_hash) THEN
    RAISE EXCEPTION 'a verification-run dependency must be a canonical run with its outcome hash' USING ERRCODE = 'BR176';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER run_dependency_binding BEFORE INSERT ON ranking.run_dependency
  FOR EACH ROW EXECUTE FUNCTION ranking.assert_run_dependency();

-- A · The published snapshot. Its id and recorded_at (publication time) are persistence attributes,
-- never part of the hashed content.
CREATE TABLE ranking.snapshot (
  id                      uuid PRIMARY KEY,
  system_id               uuid NOT NULL REFERENCES ranking.system (id),
  system_version_id       uuid NOT NULL,
  spec_hash               platform.content_hash NOT NULL,
  run_id                  uuid NOT NULL,
  run_input_hash          platform.content_hash NOT NULL,
  run_outcome_hash        platform.content_hash NOT NULL,
  snapshot_hash           platform.content_hash NOT NULL,
  content                 jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object' AND octet_length(content::text) <= 8388608),
  kind                    text NOT NULL CHECK (kind IN ('PLATFORM', 'OFFICIAL')),
  method                  text NOT NULL CHECK (method = 'BEST_MARK'),
  engine_version          text NOT NULL CHECK (engine_version ~ '^ranking-engine/[1-9][0-9]{0,3}$'),
  provenance              text NOT NULL,
  as_of                   timestamptz NOT NULL,
  lineage_kind            text NOT NULL CHECK (lineage_kind IN ('INITIAL', 'FOLLOWS', 'CORRECTS')),
  previous_snapshot_id    uuid REFERENCES ranking.snapshot (id),
  corrects_snapshot_id    uuid REFERENCES ranking.snapshot (id),
  prior_snapshot_hash     platform.content_hash,
  lineage_reasons         text[] NOT NULL DEFAULT '{}' CHECK (cardinality(lineage_reasons) <= 32),
  -- An empty snapshot is not representable (ADR-0048 §5; engine blocker NO_RANKED_ENTRIES).
  entry_count             integer NOT NULL CHECK (entry_count BETWEEN 1 AND 10000),
  published_by_account_id uuid REFERENCES identity.account (id),
  recorded_at             timestamptz NOT NULL,
  CONSTRAINT snapshot_hash_key UNIQUE (snapshot_hash),
  -- One snapshot per run.
  CONSTRAINT snapshot_run_key UNIQUE (run_id),
  CONSTRAINT snapshot_run_pin_fk FOREIGN KEY (run_id, run_outcome_hash) REFERENCES ranking.run (id, outcome_hash),
  CONSTRAINT snapshot_system_version_pin_fk FOREIGN KEY (system_version_id, spec_hash)
    REFERENCES ranking.system_version (id, spec_hash),
  CONSTRAINT snapshot_canonical_provenance_only CHECK (provenance = 'CANONICAL_ASSEMBLY'),
  CHECK (jsonb_typeof(content->'entries') = 'array' AND jsonb_array_length(content->'entries') = entry_count),
  -- Lineage (ADR-0048 §8): INITIAL has no prior; FOLLOWS / CORRECTS pin exactly one prior by id + hash;
  -- only a correction carries reasons.
  CONSTRAINT snapshot_lineage_coherence CHECK (
    (lineage_kind = 'INITIAL' AND previous_snapshot_id IS NULL AND corrects_snapshot_id IS NULL
       AND prior_snapshot_hash IS NULL AND cardinality(lineage_reasons) = 0)
    OR (lineage_kind = 'FOLLOWS' AND previous_snapshot_id IS NOT NULL AND corrects_snapshot_id IS NULL
       AND prior_snapshot_hash IS NOT NULL AND cardinality(lineage_reasons) = 0)
    OR (lineage_kind = 'CORRECTS' AND corrects_snapshot_id IS NOT NULL AND previous_snapshot_id IS NULL
       AND prior_snapshot_hash IS NOT NULL AND cardinality(lineage_reasons) > 0)),
  CHECK (previous_snapshot_id IS DISTINCT FROM id AND corrects_snapshot_id IS DISTINCT FROM id)
);
-- A snapshot is followed at most once and corrected at most once (no forks; as-corrected is unique).
CREATE UNIQUE INDEX snapshot_followed_once ON ranking.snapshot (previous_snapshot_id) WHERE previous_snapshot_id IS NOT NULL;
CREATE UNIQUE INDEX snapshot_corrected_once ON ranking.snapshot (corrects_snapshot_id) WHERE corrects_snapshot_id IS NOT NULL;
CREATE INDEX snapshot_system_idx ON ranking.snapshot (system_id, recorded_at DESC);

CREATE FUNCTION ranking.assert_snapshot() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  c jsonb := NEW.content;
  run record;
  prior_id uuid := COALESCE(NEW.previous_snapshot_id, NEW.corrects_snapshot_id);
BEGIN
  -- Linearized per system: lineage decisions never race.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ranking-snapshot:' || NEW.system_id::text, 0));
  IF c->>'systemId' IS DISTINCT FROM NEW.system_id::text
     OR c->>'systemVersionId' IS DISTINCT FROM NEW.system_version_id::text
     OR c->>'specHash' IS DISTINCT FROM NEW.spec_hash::text
     OR c->>'kind' IS DISTINCT FROM NEW.kind
     OR c->>'method' IS DISTINCT FROM NEW.method
     OR c->>'engineVersion' IS DISTINCT FROM NEW.engine_version
     OR c->>'provenance' IS DISTINCT FROM NEW.provenance
     OR c->>'runInputHash' IS DISTINCT FROM NEW.run_input_hash::text
     OR c->>'runOutcomeHash' IS DISTINCT FROM NEW.run_outcome_hash::text
     OR (c->>'asOf')::timestamptz IS DISTINCT FROM NEW.as_of
     OR c->'lineage'->>'kind' IS DISTINCT FROM NEW.lineage_kind
     OR c->'lineage'->>'priorSnapshotId' IS DISTINCT FROM prior_id::text
     OR c->'lineage'->>'priorSnapshotHash' IS DISTINCT FROM NEW.prior_snapshot_hash::text
     OR ARRAY(SELECT jsonb_array_elements_text(COALESCE(c->'lineage'->'reasons', '[]'::jsonb))) IS DISTINCT FROM NEW.lineage_reasons THEN
    RAISE EXCEPTION 'snapshot columns disagree with the canonical snapshot content' USING ERRCODE = 'BR177';
  END IF;
  -- Published only from a PUBLISHABLE run of the same system version, with exactly its entries.
  SELECT x.system_id, x.system_version_id, x.spec_hash, x.input_hash, x.publication_state, x.outcome
    INTO run FROM ranking.run x WHERE x.id = NEW.run_id;
  IF run.system_id IS DISTINCT FROM NEW.system_id OR run.system_version_id IS DISTINCT FROM NEW.system_version_id
     OR run.spec_hash IS DISTINCT FROM NEW.spec_hash OR run.input_hash IS DISTINCT FROM NEW.run_input_hash
     OR run.publication_state IS DISTINCT FROM 'PUBLISHABLE'
     OR run.outcome->'entries' IS DISTINCT FROM c->'entries'
     OR run.outcome->>'engineVersion' IS DISTINCT FROM NEW.engine_version THEN
    RAISE EXCEPTION 'a snapshot is published only from a PUBLISHABLE run with exactly its entries' USING ERRCODE = 'BR178';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ranking.system_version v
                 JOIN ranking.v_system_version_current s ON s.system_version_id = v.id
                 WHERE v.id = NEW.system_version_id AND v.kind = NEW.kind AND s.status = 'PUBLISHED') THEN
    RAISE EXCEPTION 'a snapshot needs its system version PUBLISHED (and of the same kind)' USING ERRCODE = 'BR178';
  END IF;
  -- Lineage: the prior is a snapshot of the same system with exactly the pinned hash; the first
  -- snapshot of a system is INITIAL and every later one FOLLOWS or CORRECTS a prior.
  IF NEW.lineage_kind = 'INITIAL' THEN
    IF EXISTS (SELECT 1 FROM ranking.snapshot s WHERE s.system_id = NEW.system_id) THEN
      RAISE EXCEPTION 'only the first snapshot of a system is INITIAL' USING ERRCODE = 'BR179';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM ranking.snapshot s
                    WHERE s.id = prior_id AND s.system_id = NEW.system_id AND s.snapshot_hash = NEW.prior_snapshot_hash) THEN
    RAISE EXCEPTION 'lineage must pin a prior snapshot of the same system by id and hash' USING ERRCODE = 'BR179';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER snapshot_binding BEFORE INSERT ON ranking.snapshot
  FOR EACH ROW EXECUTE FUNCTION ranking.assert_snapshot();

-- A · Snapshot entries (one per ranked holder). Never stored on an athlete / team / passport row.
CREATE TABLE ranking.snapshot_entry (
  snapshot_id      uuid NOT NULL REFERENCES ranking.snapshot (id),
  holder_type      text NOT NULL CHECK (holder_type IN ('ATHLETE', 'TEAM')),
  holder_id        uuid NOT NULL,
  rank             integer NOT NULL CHECK (rank BETWEEN 1 AND 1000000),
  tied             boolean NOT NULL,
  value            jsonb NOT NULL CHECK (jsonb_typeof(value) = 'object'),
  comparator_trace jsonb NOT NULL CHECK (jsonb_typeof(comparator_trace) = 'array' AND jsonb_array_length(comparator_trace) = 1),
  basis            jsonb NOT NULL CHECK (jsonb_typeof(basis) = 'array' AND jsonb_array_length(basis) BETWEEN 1 AND 64),
  recorded_at      timestamptz NOT NULL,
  PRIMARY KEY (snapshot_id, holder_type, holder_id)
);
CREATE INDEX snapshot_entry_holder_idx ON ranking.snapshot_entry (holder_type, holder_id);

-- An entry is an element of its snapshot's hashed content, written with the snapshot; CANONICAL basis
-- pins name existing FINAL CONTEST versions and the canonical run of that version.
CREATE FUNCTION ranking.assert_snapshot_entry() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  prov text;
  b jsonb;
  cur_status text;
BEGIN
  SELECT s.provenance INTO prov FROM ranking.snapshot s, jsonb_array_elements(s.content->'entries') e
    WHERE s.id = NEW.snapshot_id AND s.recorded_at = NEW.recorded_at
      AND e->'holder'->>'holderType' = NEW.holder_type AND e->'holder'->>'holderId' = NEW.holder_id::text
      AND (e->>'rank')::integer = NEW.rank AND (e->>'tied')::boolean = NEW.tied
      AND e->'value' = NEW.value AND e->'comparatorTrace' = NEW.comparator_trace AND e->'basis' = NEW.basis;
  IF prov IS NULL THEN
    RAISE EXCEPTION 'a snapshot entry must be an element of its snapshot content' USING ERRCODE = 'BR180';
  END IF;
  IF prov = 'CANONICAL_ASSEMBLY' THEN
    FOR b IN SELECT * FROM jsonb_array_elements(NEW.basis) LOOP
      IF NOT EXISTS (SELECT 1 FROM results.result_version rv JOIN results.result r ON r.id = rv.result_id
                     WHERE rv.id = (b->>'resultVersionId')::uuid AND rv.content_hash = b->>'contentHash'
                       AND r.id = (b->>'resultId')::uuid AND r.scope_type = 'CONTEST') THEN
        RAISE EXCEPTION 'a ranking basis must be a canonical CONTEST ResultVersion with its content hash' USING ERRCODE = 'BR181';
      END IF;
      SELECT t.to_status INTO cur_status FROM results.result_status_transition t
        WHERE t.result_version_id = (b->>'resultVersionId')::uuid ORDER BY t.recorded_at DESC, t.id DESC LIMIT 1;
      IF cur_status IS DISTINCT FROM 'FINAL' THEN
        RAISE EXCEPTION 'a ranking basis must be canonically FINAL' USING ERRCODE = 'BR181';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM verification.run v
                     WHERE v.id = (b->>'verificationRunId')::uuid AND v.result_version_id = (b->>'resultVersionId')::uuid
                       AND v.snapshot_hash::text = b->>'verificationSnapshotHash'
                       AND v.outcome_hash::text = b->>'verificationOutcomeHash'
                       AND v.highest_level = b->>'verificationLevel') THEN
        RAISE EXCEPTION 'a ranking basis must pin the canonical VerificationRun of that version' USING ERRCODE = 'BR181';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER snapshot_entry_binding BEFORE INSERT ON ranking.snapshot_entry
  FOR EACH ROW EXECUTE FUNCTION ranking.assert_snapshot_entry();

-- At commit: every content entry was written (the snapshot is complete).
CREATE FUNCTION ranking.assert_snapshot_complete() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (SELECT count(*) FROM ranking.snapshot_entry e WHERE e.snapshot_id = NEW.id) <> NEW.entry_count THEN
    RAISE EXCEPTION 'a snapshot must commit with every entry' USING ERRCODE = 'BR182';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER snapshot_complete AFTER INSERT ON ranking.snapshot
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ranking.assert_snapshot_complete();

REVOKE ALL ON FUNCTION ranking.assert_run(), ranking.assert_run_dependency(), ranking.assert_snapshot(),
  ranking.assert_snapshot_entry(), ranking.assert_snapshot_complete() FROM PUBLIC;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['run', 'run_dependency', 'snapshot', 'snapshot_entry'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON ranking.%I FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON ranking.%I FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation()', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON ranking.%I FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at()', t || '_recorded_at', t);
    -- Ranking runtime: the only writer (the validated writer arrives in Step 6); rebuild reads.
    EXECUTE format('GRANT SELECT, INSERT ON ranking.%I TO br_rankings', t);
    EXECUTE format('GRANT SELECT ON ranking.%I TO br_rebuild', t);
  END LOOP;
END
$$;

-- Ranking runtime: SELECT-only on the exact canonical facts the binding checks read. It never writes
-- results, verification, evidence, attestations, authority, competition, identity or achievements.
-- (Platform plumbing — outbox / ledger / audit / idempotency — is granted with the writer, Step 6.)
GRANT SELECT ON results.result, results.result_version, results.result_status_transition TO br_rankings;
GRANT USAGE ON SCHEMA verification TO br_rankings;
GRANT SELECT ON verification.run TO br_rankings;
GRANT USAGE ON SCHEMA platform TO br_rankings;
GRANT EXECUTE ON FUNCTION platform.tx_time_ms() TO br_rankings;
GRANT USAGE ON SCHEMA platform TO br_ranking_rules;
GRANT EXECUTE ON FUNCTION platform.tx_time_ms() TO br_ranking_rules;
