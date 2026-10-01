-- BRT-09 · RecordCategories (BRT-01 verification model §9.1, ADR-0043): stable category identities,
-- immutable declarative category versions (br:record-category-version@1) and an append-only
-- DRAFT → PUBLISHED → RETIRED lifecycle.
--
-- A RecordCategoryVersion is DATA: an exact comparison universe (DisciplineVersion, metric, scope,
-- population, conditions, tie policy) + a recognition policy (floor, recognizing authority scope,
-- explicit canonical keeper, effectiveFrom). It is validated by @br/records (BRT-01 §7 floors, scope ↔
-- recognition coherence, model-enforced naming) before a version row can exist and again at
-- publication; the database adds the structural guarantees:
--   · every version of a category shares ONE comparison universe (universe_hash) — a different
--     universe is a different category, so historical marks are never reinterpreted (BR141);
--   · published versions are immutable; publication never backdates (effective_from ≥ publication,
--     BR142); retirement prevents NEW use and never touches a historical RecordMark.
-- PERSONAL categories do not exist in BRT-09 v1: personal bests are the BRT-08 PERSONAL_BEST
-- Achievement (no second PB engine, no invented PERSONAL ratifier).
--
-- Table classes: A (append-only) for every table here. Category mutation happens only through the
-- dedicated operator login br_record_operator_app → br_record_rules.
CREATE SCHEMA record;
REVOKE ALL ON SCHEMA record FROM PUBLIC;

-- A · Category identity (stable code; the name is a label only; the scope type is structural).
CREATE TABLE record.category (
  id                    uuid PRIMARY KEY,
  code                  text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  name                  text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  scope_type            text NOT NULL CHECK (scope_type IN ('VENUE', 'COMPETITION', 'LEAGUE', 'PLATFORM', 'NATIONAL', 'CONTINENTAL', 'WORLD')),
  created_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL
);

-- A · Immutable category version: normalized spec, H("record-category-version", …, JCS(spec)), the
-- comparison-universe hash, and the exact DisciplineVersion / metric it compares.
CREATE TABLE record.category_version (
  id                    uuid PRIMARY KEY,
  category_id           uuid NOT NULL REFERENCES record.category (id),
  version               integer NOT NULL CHECK (version BETWEEN 1 AND 100000),
  spec                  jsonb NOT NULL CHECK (jsonb_typeof(spec) = 'object' AND octet_length(spec::text) <= 16384),
  spec_schema           text NOT NULL CHECK (spec_schema = 'br:record-category-version@1'),
  spec_hash             platform.content_hash NOT NULL,
  universe_hash         platform.content_hash NOT NULL,
  target_engine         text NOT NULL CHECK (target_engine ~ '^record-engine/[1-9][0-9]{0,3}$'),
  scope_type            text NOT NULL,
  discipline_version_id uuid NOT NULL REFERENCES sports.discipline_version (id),
  metric_key            text NOT NULL,
  mark_metric_id        text NOT NULL,
  effective_from        timestamptz NOT NULL,
  created_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL,
  CONSTRAINT category_version_number_key UNIQUE (category_id, version),
  CONSTRAINT category_version_spec_key UNIQUE (category_id, spec_hash),
  CHECK (spec->>'targetEngine' = target_engine),
  CHECK (spec->'scope'->>'scopeType' = scope_type),
  CHECK (spec->'universe'->>'disciplineVersionId' = discipline_version_id::text),
  CHECK (spec->'universe'->'metric'->>'key' = metric_key),
  CHECK (spec->'universe'->'metric'->>'markMetricId' = mark_metric_id),
  CHECK ((spec->>'effectiveFrom')::timestamptz = effective_from)
);

CREATE FUNCTION record.assert_category_version() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('record-category:' || NEW.category_id::text, 0));
  IF NOT EXISTS (SELECT 1 FROM record.category c WHERE c.id = NEW.category_id AND c.scope_type = NEW.scope_type) THEN
    RAISE EXCEPTION 'a category version must keep its category''s scope type' USING ERRCODE = 'BR140';
  END IF;
  -- One comparison universe per category (ADR-0043): marks of every version stay comparable and a
  -- new version can never silently reinterpret historical marks.
  IF EXISTS (SELECT 1 FROM record.category_version v
             WHERE v.category_id = NEW.category_id AND v.universe_hash <> NEW.universe_hash) THEN
    RAISE EXCEPTION 'a new version cannot change the category comparison universe (create a new category)'
      USING ERRCODE = 'BR141';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER category_version_universe BEFORE INSERT ON record.category_version
  FOR EACH ROW EXECUTE FUNCTION record.assert_category_version();

-- A · Lifecycle facts. No row = DRAFT; PUBLISHED at most once (never backdated); RETIRED only after
-- PUBLISHED. Retirement prevents new evaluation under the version; it never rewrites a mark.
CREATE TABLE record.category_version_status_change (
  id                  uuid PRIMARY KEY,
  category_version_id uuid NOT NULL REFERENCES record.category_version (id),
  status              text NOT NULL CHECK (status IN ('PUBLISHED', 'RETIRED')),
  actor_account_id    uuid NOT NULL REFERENCES identity.account (id),
  recorded_at         timestamptz NOT NULL,
  seq                 bigint GENERATED ALWAYS AS IDENTITY,
  CONSTRAINT category_version_status_once UNIQUE (category_version_id, status)
);

CREATE VIEW record.v_category_version_current AS
  SELECT v.id AS category_version_id, v.category_id,
         COALESCE((SELECT s.status FROM record.category_version_status_change s
                   WHERE s.category_version_id = v.id ORDER BY s.seq DESC LIMIT 1), 'DRAFT') AS status,
         (SELECT s.recorded_at FROM record.category_version_status_change s
          WHERE s.category_version_id = v.id AND s.status = 'PUBLISHED') AS published_at
  FROM record.category_version v;

CREATE FUNCTION record.assert_category_transition() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cur text;
  eff timestamptz;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('record-category-version:' || NEW.category_version_id::text, 0));
  SELECT s.status INTO cur FROM record.category_version_status_change s
    WHERE s.category_version_id = NEW.category_version_id ORDER BY s.seq DESC LIMIT 1;
  IF NOT ((cur IS NULL AND NEW.status = 'PUBLISHED') OR (cur = 'PUBLISHED' AND NEW.status = 'RETIRED')) THEN
    RAISE EXCEPTION 'category version transition % → % is not permitted', COALESCE(cur, 'DRAFT'), NEW.status
      USING ERRCODE = 'BR143';
  END IF;
  IF NEW.status = 'PUBLISHED' THEN
    SELECT v.effective_from INTO eff FROM record.category_version v WHERE v.id = NEW.category_version_id;
    -- No backdating: a category created today never declares a past performance a record.
    IF eff < NEW.recorded_at THEN
      RAISE EXCEPTION 'a category version cannot take effect before it is published' USING ERRCODE = 'BR142';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER category_version_transition BEFORE INSERT ON record.category_version_status_change
  FOR EACH ROW EXECUTE FUNCTION record.assert_category_transition();

REVOKE ALL ON FUNCTION record.assert_category_version(), record.assert_category_transition() FROM PUBLIC;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['category', 'category_version', 'category_version_status_change'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON record.%I FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON record.%I FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation()', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON record.%I FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at()', t || '_recorded_at', t);
    -- Category operator (br_record_rules): create, version, publish, retire — nothing else.
    EXECUTE format('GRANT SELECT, INSERT ON record.%I TO br_record_rules', t);
    -- Record runtime, the RECORD_SET derivation (Achievement module) and rebuild: read-only.
    EXECUTE format('GRANT SELECT ON record.%I TO br_records, br_achievements, br_rebuild', t);
  END LOOP;
END
$$;
GRANT USAGE ON SCHEMA record TO br_record_rules, br_records, br_achievements, br_rebuild;
GRANT SELECT ON record.v_category_version_current TO br_record_rules, br_records, br_achievements, br_rebuild;

-- Category operator plumbing: platform time, outbox, audit, idempotency; exact PUBLISHED discipline
-- versions + sport / discipline codes (public catalog facts) to validate metric / sport references;
-- competition identities to validate a COMPETITION series. No results, verification, evidence,
-- attestations, authority, identity or PII — and no record-mark table at all.
GRANT USAGE ON SCHEMA platform TO br_record_rules;
GRANT EXECUTE ON FUNCTION platform.tx_time_ms() TO br_record_rules;
GRANT SELECT, INSERT ON platform.outbox_event TO br_record_rules;
GRANT SELECT, INSERT ON platform.command_idempotency TO br_record_rules;
GRANT INSERT ON platform.audit_event TO br_record_rules;
GRANT USAGE ON SCHEMA sports TO br_record_rules;
GRANT SELECT ON sports.sport, sports.discipline, sports.discipline_version, sports.v_discipline_version_current TO br_record_rules;
GRANT USAGE ON SCHEMA competition TO br_record_rules;
GRANT SELECT ON competition.competition TO br_record_rules;
