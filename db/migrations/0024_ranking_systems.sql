-- BRT-10 · Ranking systems (ADR-0048 §1–3, §6; BRT-01 verification model §7, §10; BRT-02 persistence §6).
--
-- A RankingSystem is a stable identity (code + kind PLATFORM | OFFICIAL) owning immutable, declarative
-- versions (br:ranking-system-version@1), with an append-only DRAFT → PUBLISHED → RETIRED lifecycle:
--
--   ranking.system                       stable identity; the kind is structural
--   ranking.system_version               the normalized spec + H("ranking-system-version", …) + the
--                                        universe hash H("ranking-universe", …), with the universe,
--                                        floor, recognition and owner columns bound to the spec
--   ranking.system_version_status_change lifecycle facts
--
-- The spec is validated by @br/rankings (raise-only BRT-01 §7 floors, kind ↔ recognition ↔ owner,
-- BEST_MARK single comparable key equal to the DisciplineVersion order, model-enforced naming) before
-- a version row can exist; the database adds the structural guarantees:
--   · ONE universe per system: every version shares the universe hash, the kind and the owner; a
--     different universe or owner is a different system, so no version can reinterpret a historical
--     snapshot (ADR-0048 §1);
--   · BEST_MARK only, CONTEST scope only, FINAL only; PLATFORM ⇒ PLATFORM recognition, no owner, floor
--     ≥ V2; OFFICIAL ⇒ an owner principal whose trust anchor is named, non-PLATFORM recognition, floor
--     ≥ V3 (the floors can be raised, never lowered);
--   · published versions are immutable and never backdated (effective_from ≥ publication).
-- OFFICIAL publication of SNAPSHOTS still fails closed (no owner-publication producer); this migration
-- only stores definitions. Table classes: A (append-only) for every table here. Definition mutation
-- happens only through the operator login br_ranking_operator_app → br_ranking_rules.

-- A · System identity.
CREATE TABLE ranking.system (
  id                    uuid PRIMARY KEY,
  code                  text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  name                  text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind                  text NOT NULL CHECK (kind IN ('PLATFORM', 'OFFICIAL')),
  created_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL
);

-- A · Immutable system version.
CREATE TABLE ranking.system_version (
  id                         uuid PRIMARY KEY,
  system_id                  uuid NOT NULL REFERENCES ranking.system (id),
  version                    integer NOT NULL CHECK (version BETWEEN 1 AND 100000),
  spec                       jsonb NOT NULL CHECK (jsonb_typeof(spec) = 'object' AND octet_length(spec::text) <= 16384),
  spec_schema                text NOT NULL CHECK (spec_schema = 'br:ranking-system-version@1'),
  spec_hash                  platform.content_hash NOT NULL,
  universe_hash              platform.content_hash NOT NULL,
  target_engine              text NOT NULL CHECK (target_engine ~ '^ranking-engine/[1-9][0-9]{0,3}$'),
  kind                       text NOT NULL CHECK (kind IN ('PLATFORM', 'OFFICIAL')),
  method                     text NOT NULL CHECK (method = 'BEST_MARK'),
  discipline_version_id      uuid NOT NULL REFERENCES sports.discipline_version (id),
  metric_key                 text NOT NULL,
  mark_metric_id             text NOT NULL,
  holder_type                text NOT NULL CHECK (holder_type IN ('ATHLETE', 'TEAM')),
  minimum_verification_level text NOT NULL CHECK (minimum_verification_level IN ('V2', 'V3', 'V4')),
  recognition_level          text NOT NULL CHECK (recognition_level IN ('PLATFORM', 'CLUB', 'REGIONAL', 'NATIONAL', 'CONTINENTAL', 'WORLD')),
  owner_principal_id         uuid REFERENCES authority.principal (id),
  owner_anchor_id            uuid REFERENCES authority.trust_anchor (id),
  effective_from             timestamptz NOT NULL,
  created_by_account_id      uuid NOT NULL REFERENCES identity.account (id),
  recorded_at                timestamptz NOT NULL,
  CONSTRAINT system_version_number_key UNIQUE (system_id, version),
  CONSTRAINT system_version_spec_key UNIQUE (system_id, spec_hash),
  -- Target of the (version, spec hash) pin of runs and snapshots.
  CONSTRAINT system_version_pin_key UNIQUE (id, spec_hash),
  CHECK (spec->>'targetEngine' = target_engine),
  CHECK (spec->>'kind' = kind),
  CHECK (spec->>'method' = method),
  CHECK (spec->'universe'->>'disciplineVersionId' = discipline_version_id::text),
  CHECK (spec->'universe'->'metric'->>'key' = metric_key),
  CHECK (spec->'universe'->'metric'->>'markMetricId' = mark_metric_id),
  CHECK (spec->'universe'->>'holderType' = holder_type),
  CHECK (spec->'universe'->>'resultScope' = 'CONTEST'),
  CHECK (spec->'requirements'->>'minimumResultStatus' = 'FINAL'),
  CHECK (spec->'requirements'->>'minimumVerificationLevel' = minimum_verification_level),
  CHECK (spec->'recognition'->>'level' = recognition_level),
  CHECK (spec->'owner'->>'principalId' IS NOT DISTINCT FROM owner_principal_id::text),
  CHECK (spec->'owner'->>'anchorId' IS NOT DISTINCT FROM owner_anchor_id::text),
  CHECK ((spec->>'effectiveFrom')::timestamptz = effective_from),
  -- BEST_MARK ranks on exactly one comparable key: the universe metric (ADR-0049 §6).
  CHECK (jsonb_array_length(spec->'comparator'->'keys') = 1),
  CHECK (spec->'comparator'->'keys'->0->>'metric' = metric_key),
  CHECK (spec->'comparator'->'keys'->0->>'order' IN ('HIGHER_IS_BETTER', 'LOWER_IS_BETTER')),
  -- BRT-01 §7 floors per kind, raise-only; the platform never masquerades as an owner (ADR-0048 §3, §6).
  CONSTRAINT system_version_kind_coherence CHECK (
    (kind = 'PLATFORM' AND recognition_level = 'PLATFORM' AND owner_principal_id IS NULL AND owner_anchor_id IS NULL
       AND minimum_verification_level IN ('V2', 'V3', 'V4'))
    OR (kind = 'OFFICIAL' AND recognition_level <> 'PLATFORM' AND owner_principal_id IS NOT NULL AND owner_anchor_id IS NOT NULL
       AND minimum_verification_level IN ('V3', 'V4')))
);

CREATE FUNCTION ranking.assert_system_version() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ranking-system:' || NEW.system_id::text, 0));
  IF NOT EXISTS (SELECT 1 FROM ranking.system s WHERE s.id = NEW.system_id AND s.kind = NEW.kind) THEN
    RAISE EXCEPTION 'a system version must keep its system''s kind' USING ERRCODE = 'BR170';
  END IF;
  -- One universe and one owner per system (ADR-0048 §1): a new version never reinterprets history.
  IF EXISTS (SELECT 1 FROM ranking.system_version v
             WHERE v.system_id = NEW.system_id
               AND (v.universe_hash <> NEW.universe_hash
                    OR v.owner_principal_id IS DISTINCT FROM NEW.owner_principal_id
                    OR v.owner_anchor_id IS DISTINCT FROM NEW.owner_anchor_id)) THEN
    RAISE EXCEPTION 'a new version cannot change the ranking universe or owner (create a new system)'
      USING ERRCODE = 'BR171';
  END IF;
  -- OFFICIAL: the named trust anchor belongs to the owner principal (its recognition coverage is
  -- re-checked by @br/rankings; a PLATFORM anchor can never own an OFFICIAL system).
  IF NEW.kind = 'OFFICIAL' AND NOT EXISTS (
       SELECT 1 FROM authority.trust_anchor a
       WHERE a.id = NEW.owner_anchor_id AND a.principal_id = NEW.owner_principal_id
         AND NOT (a.recognition_scope->'recognitionLevel' ? 'PLATFORM')) THEN
    RAISE EXCEPTION 'an OFFICIAL owner must be the principal of a non-PLATFORM trust anchor' USING ERRCODE = 'BR172';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER system_version_binding BEFORE INSERT ON ranking.system_version
  FOR EACH ROW EXECUTE FUNCTION ranking.assert_system_version();

-- A · Lifecycle facts. No row = DRAFT; PUBLISHED at most once (never backdated); RETIRED only after.
CREATE TABLE ranking.system_version_status_change (
  id                uuid PRIMARY KEY,
  system_version_id uuid NOT NULL REFERENCES ranking.system_version (id),
  status            text NOT NULL CHECK (status IN ('PUBLISHED', 'RETIRED')),
  actor_account_id  uuid NOT NULL REFERENCES identity.account (id),
  recorded_at       timestamptz NOT NULL,
  seq               bigint GENERATED ALWAYS AS IDENTITY,
  CONSTRAINT system_version_status_once UNIQUE (system_version_id, status)
);

CREATE VIEW ranking.v_system_version_current AS
  SELECT v.id AS system_version_id, v.system_id,
         COALESCE((SELECT s.status FROM ranking.system_version_status_change s
                   WHERE s.system_version_id = v.id ORDER BY s.seq DESC LIMIT 1), 'DRAFT') AS status,
         (SELECT s.recorded_at FROM ranking.system_version_status_change s
          WHERE s.system_version_id = v.id AND s.status = 'PUBLISHED') AS published_at
  FROM ranking.system_version v;

CREATE FUNCTION ranking.assert_system_version_transition() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cur text;
  eff timestamptz;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ranking-system-version:' || NEW.system_version_id::text, 0));
  SELECT s.status INTO cur FROM ranking.system_version_status_change s
    WHERE s.system_version_id = NEW.system_version_id ORDER BY s.seq DESC LIMIT 1;
  -- IS NOT DISTINCT FROM: a NULL comparison must never let a DRAFT → RETIRED transition through.
  IF NOT ((cur IS NULL AND NEW.status = 'PUBLISHED')
          OR (cur IS NOT DISTINCT FROM 'PUBLISHED' AND NEW.status = 'RETIRED')) THEN
    RAISE EXCEPTION 'system version transition % → % is not permitted', COALESCE(cur, 'DRAFT'), NEW.status
      USING ERRCODE = 'BR173';
  END IF;
  IF NEW.status = 'PUBLISHED' THEN
    SELECT v.effective_from INTO eff FROM ranking.system_version v WHERE v.id = NEW.system_version_id;
    -- No backdating (ADR-0048 §1): performances before publication never enter a new version.
    IF eff < NEW.recorded_at THEN
      RAISE EXCEPTION 'a system version cannot take effect before it is published' USING ERRCODE = 'BR174';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER system_version_transition BEFORE INSERT ON ranking.system_version_status_change
  FOR EACH ROW EXECUTE FUNCTION ranking.assert_system_version_transition();

REVOKE ALL ON FUNCTION ranking.assert_system_version(), ranking.assert_system_version_transition() FROM PUBLIC;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['system', 'system_version', 'system_version_status_change'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON ranking.%I FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON ranking.%I FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation()', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON ranking.%I FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at()', t || '_recorded_at', t);
    -- Definition operator: create, version, publish, retire — nothing else.
    EXECUTE format('GRANT SELECT, INSERT ON ranking.%I TO br_ranking_rules', t);
    -- Ranking runtime and rebuild: read-only.
    EXECUTE format('GRANT SELECT ON ranking.%I TO br_rankings, br_rebuild', t);
  END LOOP;
END
$$;
GRANT SELECT ON ranking.v_system_version_current TO br_ranking_rules, br_rankings, br_rebuild;

-- Definition operator: the OFFICIAL owner's anchor identity + recognition scope (to validate
-- coverage; ADR-0048 §6). Never grants, keys, statements or any write.
GRANT USAGE ON SCHEMA authority TO br_ranking_rules;
GRANT SELECT (id, principal_id, recognition_scope) ON authority.trust_anchor TO br_ranking_rules;
