-- BRT-10 · Classification derivation (ADR-0047, ADR-0049; BRT-01 result domain §6.1, R-6).
--
-- A classification IS a ResultVersion (results.result_version, `br:result-version-content@2`) and is
-- written ONLY by the existing ResultLedger (T2 submitDraft under br_results). This migration adds no
-- classification write path of its own; it adds the persistence foundation the ledger's later
-- validated submission (Step 6) needs, and the structural guarantees that make a derivation honest:
--
--   ranking.classification_policy                  stable ClassificationPolicy identity
--   ranking.classification_policy_version          immutable declarative br:classification-policy@1
--   ranking.classification_policy_version_status_change   DRAFT (no row) → PUBLISHED → RETIRED
--   results.classification_derivation              one row per `@2` ResultVersion: the pinned policy
--                                                  version + spec hash, DisciplineVersion, engine and
--                                                  inputs digest — EQUAL to content.derivation
--   results.classification_input                   the derivedFrom index: one row per pinned input
--                                                  version (ResultVersion id + content hash + status),
--                                                  EQUAL to an element of content.derivation.derivedFrom
--
-- Guarantees (enforced here, independent of application code):
--   · `@2` content can only belong to a ROUND / EVENT / COMPETITION classification Result, and a `@2`
--     version cannot commit without its derivation row and every derivedFrom input row (no
--     classification without provenance; no provenance that disagrees with the hashed content);
--   · each pinned input is an existing CONTEST ResultVersion with exactly that content hash, currently
--     in exactly the pinned status (v1: classifications derive from CONTEST results only);
--   · the pinned policy version is PUBLISHED, has exactly the pinned spec hash, the same scope type
--     and the same DisciplineVersion as the derivation;
--   · AVERAGE (or any division) and ORDINAL keys can never be stored in a policy (ADR-0049 §1–2).
-- Staleness is never stored (ADR-0047 §5): it is computed from these pins. Nothing here is updated or
-- deleted. Policy mutation happens only through the operator login br_ranking_operator_app →
-- br_ranking_rules. Table classes: A (append-only) for every table here.
CREATE SCHEMA ranking;
REVOKE ALL ON SCHEMA ranking FROM PUBLIC;

-- A · Policy identity (stable code; the name is a label only; the scope type is structural).
CREATE TABLE ranking.classification_policy (
  id                    uuid PRIMARY KEY,
  code                  text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  name                  text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  scope_type            text NOT NULL CHECK (scope_type IN ('ROUND_CLASSIFICATION', 'EVENT_CLASSIFICATION', 'COMPETITION_CLASSIFICATION')),
  created_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL
);

-- A · Immutable policy version: normalized spec and H("classification-policy", …, JCS(spec)).
CREATE TABLE ranking.classification_policy_version (
  id                    uuid PRIMARY KEY,
  policy_id             uuid NOT NULL REFERENCES ranking.classification_policy (id),
  version               integer NOT NULL CHECK (version BETWEEN 1 AND 100000),
  spec                  jsonb NOT NULL CHECK (jsonb_typeof(spec) = 'object' AND octet_length(spec::text) <= 16384),
  spec_schema           text NOT NULL CHECK (spec_schema = 'br:classification-policy@1'),
  spec_hash             platform.content_hash NOT NULL,
  target_engine         text NOT NULL CHECK (target_engine ~ '^classification-engine/[1-9][0-9]{0,3}$'),
  scope_type            text NOT NULL,
  discipline_version_id uuid NOT NULL REFERENCES sports.discipline_version (id),
  primary_comparator    text NOT NULL CHECK (primary_comparator IN ('HEAD_TO_HEAD_WINNER', 'METRICS')),
  minimum_input_status  text NOT NULL CHECK (minimum_input_status IN ('PROVISIONAL', 'OFFICIAL', 'FINAL')),
  created_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL,
  CONSTRAINT classification_policy_version_number_key UNIQUE (policy_id, version),
  CONSTRAINT classification_policy_version_spec_key UNIQUE (policy_id, spec_hash),
  -- Target of the (version, spec hash) pin of a derivation.
  CONSTRAINT classification_policy_version_pin_key UNIQUE (id, spec_hash),
  CHECK (spec->>'targetEngine' = target_engine),
  CHECK (spec->>'scopeType' = scope_type),
  CHECK (spec->>'disciplineVersionId' = discipline_version_id::text),
  CHECK (spec->>'primary' = primary_comparator),
  CHECK (spec->>'minimumInputStatus' = minimum_input_status),
  CHECK (jsonb_typeof(spec->'keys') = 'array'),
  -- Closed aggregation vocabulary (ADR-0049 §2): AVERAGE / any division is never storable.
  CHECK (NOT jsonb_path_exists(spec, '$.keys[*] ? (@.aggregation != "SUM" && @.aggregation != "MAX" && @.aggregation != "MIN")')),
  -- ORDINAL keys cannot be ranked (ADR-0049 §1).
  CHECK (NOT jsonb_path_exists(spec, '$.keys[*] ? (@.order == "ORDINAL")')),
  -- Outcome points exactly for head-to-head policies (ADR-0049 §3).
  CHECK ((primary_comparator = 'HEAD_TO_HEAD_WINNER') = (spec ? 'outcomePoints'))
);

CREATE FUNCTION ranking.assert_classification_policy_version() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('classification-policy:' || NEW.policy_id::text, 0));
  IF NOT EXISTS (SELECT 1 FROM ranking.classification_policy p WHERE p.id = NEW.policy_id AND p.scope_type = NEW.scope_type) THEN
    RAISE EXCEPTION 'a policy version must keep its policy''s scope type' USING ERRCODE = 'BR160';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER classification_policy_version_scope BEFORE INSERT ON ranking.classification_policy_version
  FOR EACH ROW EXECUTE FUNCTION ranking.assert_classification_policy_version();

-- A · Lifecycle facts. No row = DRAFT; PUBLISHED at most once; RETIRED only after PUBLISHED.
CREATE TABLE ranking.classification_policy_version_status_change (
  id                uuid PRIMARY KEY,
  policy_version_id uuid NOT NULL REFERENCES ranking.classification_policy_version (id),
  status            text NOT NULL CHECK (status IN ('PUBLISHED', 'RETIRED')),
  actor_account_id  uuid NOT NULL REFERENCES identity.account (id),
  recorded_at       timestamptz NOT NULL,
  seq               bigint GENERATED ALWAYS AS IDENTITY,
  CONSTRAINT classification_policy_status_once UNIQUE (policy_version_id, status)
);

CREATE VIEW ranking.v_classification_policy_version_current AS
  SELECT v.id AS policy_version_id, v.policy_id,
         COALESCE((SELECT s.status FROM ranking.classification_policy_version_status_change s
                   WHERE s.policy_version_id = v.id ORDER BY s.seq DESC LIMIT 1), 'DRAFT') AS status
  FROM ranking.classification_policy_version v;

CREATE FUNCTION ranking.assert_classification_policy_transition() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cur text;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('classification-policy-version:' || NEW.policy_version_id::text, 0));
  SELECT s.status INTO cur FROM ranking.classification_policy_version_status_change s
    WHERE s.policy_version_id = NEW.policy_version_id ORDER BY s.seq DESC LIMIT 1;
  -- IS NOT DISTINCT FROM: a NULL comparison must never let a DRAFT → RETIRED transition through.
  IF NOT ((cur IS NULL AND NEW.status = 'PUBLISHED')
          OR (cur IS NOT DISTINCT FROM 'PUBLISHED' AND NEW.status = 'RETIRED')) THEN
    RAISE EXCEPTION 'policy version transition % → % is not permitted', COALESCE(cur, 'DRAFT'), NEW.status
      USING ERRCODE = 'BR161';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER classification_policy_version_transition BEFORE INSERT ON ranking.classification_policy_version_status_change
  FOR EACH ROW EXECUTE FUNCTION ranking.assert_classification_policy_transition();

-- ─────────────────── derivation index of `@2` ResultVersions (written by the ledger) ───────────────────

-- A · The derivation header of one classification ResultVersion (ADR-0047 §2).
CREATE TABLE results.classification_derivation (
  result_version_id     uuid PRIMARY KEY REFERENCES results.result_version (id),
  policy_id             uuid NOT NULL REFERENCES ranking.classification_policy (id),
  policy_version_id     uuid NOT NULL,
  policy_spec_hash      platform.content_hash NOT NULL,
  discipline_version_id uuid NOT NULL REFERENCES sports.discipline_version (id),
  engine_version        text NOT NULL CHECK (engine_version ~ '^classification-engine/[1-9][0-9]{0,3}$'),
  inputs_digest         platform.content_hash NOT NULL,
  input_count           integer NOT NULL CHECK (input_count BETWEEN 1 AND 2048),
  recorded_at           timestamptz NOT NULL,
  CONSTRAINT classification_derivation_policy_pin_fk FOREIGN KEY (policy_version_id, policy_spec_hash)
    REFERENCES ranking.classification_policy_version (id, spec_hash)
);
CREATE INDEX classification_derivation_policy_idx ON results.classification_derivation (policy_version_id);

-- A · The derivedFrom index: every exact input version a classification pins (correction impact).
CREATE TABLE results.classification_input (
  classification_version_id uuid NOT NULL REFERENCES results.classification_derivation (result_version_id),
  input_result_version_id   uuid NOT NULL REFERENCES results.result_version (id),
  input_content_hash        platform.content_hash NOT NULL,
  input_status              text NOT NULL CHECK (input_status IN ('PROVISIONAL', 'OFFICIAL', 'FINAL')),
  recorded_at               timestamptz NOT NULL,
  PRIMARY KEY (classification_version_id, input_result_version_id),
  CHECK (classification_version_id <> input_result_version_id)
);
-- "Which classifications depend on ResultVersion X?"
CREATE INDEX classification_input_target_idx ON results.classification_input (input_result_version_id);

-- `@2` content belongs to classification Results only (CONTEST results keep `@1`).
CREATE FUNCTION results.assert_result_version_content_schema() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.content_schema = 'br:result-version-content@2' AND NOT EXISTS (
       SELECT 1 FROM results.result r WHERE r.id = NEW.result_id
         AND r.scope_type IN ('ROUND_CLASSIFICATION', 'EVENT_CLASSIFICATION', 'COMPETITION_CLASSIFICATION')) THEN
    RAISE EXCEPTION 'derived (@2) content belongs to classification Results only' USING ERRCODE = 'BR162';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER result_version_content_schema BEFORE INSERT ON results.result_version
  FOR EACH ROW EXECUTE FUNCTION results.assert_result_version_content_schema();

-- At commit: a `@2` version has its derivation header (no classification without provenance).
CREATE FUNCTION results.assert_classification_has_derivation() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.content_schema = 'br:result-version-content@2' AND NOT EXISTS (
       SELECT 1 FROM results.classification_derivation d WHERE d.result_version_id = NEW.id) THEN
    RAISE EXCEPTION 'a derived (@2) ResultVersion must commit with its derivation' USING ERRCODE = 'BR163';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER result_version_classification_derivation AFTER INSERT ON results.result_version
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION results.assert_classification_has_derivation();

-- The header equals the hashed content.derivation, is written with its version, and pins a PUBLISHED
-- policy version of the same scope type and DisciplineVersion.
CREATE FUNCTION results.assert_classification_derivation() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v record;
  d jsonb;
BEGIN
  SELECT rv.content, rv.content_schema, rv.recorded_at, r.scope_type INTO v
    FROM results.result_version rv JOIN results.result r ON r.id = rv.result_id
    WHERE rv.id = NEW.result_version_id;
  d := v.content->'derivation';
  IF v.content_schema IS DISTINCT FROM 'br:result-version-content@2' OR v.recorded_at IS DISTINCT FROM NEW.recorded_at THEN
    RAISE EXCEPTION 'a derivation belongs to a derived (@2) ResultVersion written in the same transaction'
      USING ERRCODE = 'BR164';
  END IF;
  IF d->'policy'->>'policyId' IS DISTINCT FROM NEW.policy_id::text
     OR d->'policy'->>'policyVersionId' IS DISTINCT FROM NEW.policy_version_id::text
     OR d->'policy'->>'specHash' IS DISTINCT FROM NEW.policy_spec_hash::text
     OR d->>'disciplineVersionId' IS DISTINCT FROM NEW.discipline_version_id::text
     OR d->>'engineVersion' IS DISTINCT FROM NEW.engine_version
     OR d->>'inputsDigest' IS DISTINCT FROM NEW.inputs_digest::text
     OR jsonb_array_length(d->'derivedFrom') IS DISTINCT FROM NEW.input_count THEN
    RAISE EXCEPTION 'derivation columns disagree with the hashed content.derivation' USING ERRCODE = 'BR164';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ranking.classification_policy_version pv
                 JOIN ranking.v_classification_policy_version_current s ON s.policy_version_id = pv.id
                 WHERE pv.id = NEW.policy_version_id AND pv.policy_id = NEW.policy_id
                   AND pv.spec_hash = NEW.policy_spec_hash AND s.status = 'PUBLISHED'
                   AND pv.scope_type = v.scope_type AND pv.discipline_version_id = NEW.discipline_version_id) THEN
    RAISE EXCEPTION 'a derivation needs the PUBLISHED policy version (same spec hash, scope type, DisciplineVersion) it names'
      USING ERRCODE = 'BR165';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER classification_derivation_binding BEFORE INSERT ON results.classification_derivation
  FOR EACH ROW EXECUTE FUNCTION results.assert_classification_derivation();

-- At commit: every derivedFrom element has its input row.
CREATE FUNCTION results.assert_classification_inputs_complete() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (SELECT count(*) FROM results.classification_input i WHERE i.classification_version_id = NEW.result_version_id)
       <> NEW.input_count THEN
    RAISE EXCEPTION 'a derivation must commit with every derivedFrom input' USING ERRCODE = 'BR166';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER classification_derivation_complete AFTER INSERT ON results.classification_derivation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION results.assert_classification_inputs_complete();

-- An input row is an element of the hashed derivedFrom, and names an existing CONTEST ResultVersion
-- with exactly that content hash, currently in exactly the pinned status.
CREATE FUNCTION results.assert_classification_input() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cur_status text;
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM results.classification_derivation d
       JOIN results.result_version rv ON rv.id = d.result_version_id,
       jsonb_array_elements(rv.content->'derivation'->'derivedFrom') x
       WHERE d.result_version_id = NEW.classification_version_id AND d.recorded_at = NEW.recorded_at
         AND x->>'resultVersionId' = NEW.input_result_version_id::text
         AND x->>'contentHash' = NEW.input_content_hash::text
         AND x->>'status' = NEW.input_status) THEN
    RAISE EXCEPTION 'a classification input must be an element of its content.derivation.derivedFrom'
      USING ERRCODE = 'BR167';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM results.result_version rv JOIN results.result r ON r.id = rv.result_id
                 WHERE rv.id = NEW.input_result_version_id AND rv.content_hash = NEW.input_content_hash
                   AND r.scope_type = 'CONTEST') THEN
    RAISE EXCEPTION 'a classification input must be a CONTEST ResultVersion with the pinned content hash'
      USING ERRCODE = 'BR168';
  END IF;
  SELECT t.to_status INTO cur_status FROM results.result_status_transition t
    WHERE t.result_version_id = NEW.input_result_version_id ORDER BY t.recorded_at DESC, t.id DESC LIMIT 1;
  IF cur_status IS DISTINCT FROM NEW.input_status THEN
    RAISE EXCEPTION 'a classification input must currently be in its pinned status' USING ERRCODE = 'BR168';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER classification_input_binding BEFORE INSERT ON results.classification_input
  FOR EACH ROW EXECUTE FUNCTION results.assert_classification_input();

REVOKE ALL ON FUNCTION ranking.assert_classification_policy_version(), ranking.assert_classification_policy_transition(),
  results.assert_result_version_content_schema(), results.assert_classification_has_derivation(),
  results.assert_classification_derivation(), results.assert_classification_inputs_complete(),
  results.assert_classification_input() FROM PUBLIC;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['classification_policy', 'classification_policy_version', 'classification_policy_version_status_change'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON ranking.%I FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON ranking.%I FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation()', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON ranking.%I FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at()', t || '_recorded_at', t);
    -- Definition operator (br_ranking_rules): create, version, publish, retire — nothing else.
    EXECUTE format('GRANT SELECT, INSERT ON ranking.%I TO br_ranking_rules', t);
    -- The ResultLedger (re-derivation + binding checks), the ranking runtime and rebuild: read-only.
    EXECUTE format('GRANT SELECT ON ranking.%I TO br_results, br_rankings, br_rebuild', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['classification_derivation', 'classification_input'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON results.%I FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON results.%I FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation()', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON results.%I FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at()', t || '_recorded_at', t);
    -- ONLY the ResultLedger's module role writes the index, in the submitting transaction.
    EXECUTE format('GRANT SELECT, INSERT ON results.%I TO br_results', t);
    EXECUTE format('GRANT SELECT ON results.%I TO br_rankings, br_rebuild', t);
  END LOOP;
END
$$;
GRANT USAGE ON SCHEMA ranking TO br_ranking_rules, br_results, br_rankings, br_rebuild;
GRANT SELECT ON ranking.v_classification_policy_version_current TO br_ranking_rules, br_results, br_rankings, br_rebuild;
-- The ranking runtime reads classification versions and their pins (dependency index, Step 7).
GRANT USAGE ON SCHEMA results TO br_rankings;

-- Definition operator: exact discipline versions + sport / discipline codes (public catalog facts) to
-- validate a policy against its DisciplineVersion. No results, verification, evidence, attestations,
-- authority, identity or PII.
GRANT USAGE ON SCHEMA sports TO br_ranking_rules;
GRANT SELECT ON sports.sport, sports.discipline, sports.discipline_version, sports.v_discipline_version_current TO br_ranking_rules;
