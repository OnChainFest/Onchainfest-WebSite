-- BRT-08 · AchievementRules: stable rule identities, immutable declarative rule versions
-- (br:achievement-rule@1), an append-only DRAFT → PUBLISHED → RETIRED lifecycle, and append-only,
-- never-backdated bindings of PUBLISHED versions to an EXACT DisciplineVersion (optionally narrowed to
-- one Competition / Event).
--
-- Rules are DATA (closed criterion vocabulary; no SQL, scripts, expressions or plugins). They are
-- validated by @br/achievements (including the BRT-01 platform floors) before a version row can exist
-- and again at publication; the database adds the structural guarantees.
--
-- Table classes: every table here is A (append-only). Rule mutation happens only through the
-- dedicated operator login br_achievement_operator_app → br_achievement_rules.
CREATE SCHEMA achievement;
REVOKE ALL ON SCHEMA achievement FROM PUBLIC;

-- A · Rule identity (stable code; the name is a label only).
CREATE TABLE achievement.rule (
  id                    uuid PRIMARY KEY,
  code                  text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  name                  text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  achievement_type      text NOT NULL CHECK (achievement_type IN ('EVENT_COMPLETED', 'CONTEST_WON', 'PLACEMENT', 'TITLE', 'PERFORMANCE_THRESHOLD', 'PERSONAL_BEST')),
  created_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL
);

-- A · Immutable rule version: normalized spec, H("achievement-rule", br:achievement-rule@1, JCS),
-- the engine semantics it targets and the exact DisciplineVersion it is written for.
CREATE TABLE achievement.rule_version (
  id                    uuid PRIMARY KEY,
  rule_id               uuid NOT NULL REFERENCES achievement.rule (id),
  version               integer NOT NULL CHECK (version BETWEEN 1 AND 100000),
  spec                  jsonb NOT NULL CHECK (jsonb_typeof(spec) = 'object' AND octet_length(spec::text) <= 16384),
  spec_schema           text NOT NULL CHECK (spec_schema = 'br:achievement-rule@1'),
  spec_hash             platform.content_hash NOT NULL,
  target_engine         text NOT NULL CHECK (target_engine ~ '^achievement-engine/[1-9][0-9]{0,3}$'),
  achievement_type      text NOT NULL,
  discipline_version_id uuid NOT NULL REFERENCES sports.discipline_version (id),
  created_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL,
  CONSTRAINT rule_version_number_key UNIQUE (rule_id, version),
  CONSTRAINT rule_version_spec_key UNIQUE (rule_id, spec_hash),
  CHECK (spec->>'targetEngine' = target_engine),
  CHECK (spec->>'achievementType' = achievement_type),
  CHECK (spec->>'disciplineVersionId' = discipline_version_id::text)
);

CREATE FUNCTION achievement.assert_rule_version() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM achievement.rule r WHERE r.id = NEW.rule_id AND r.achievement_type = NEW.achievement_type) THEN
    RAISE EXCEPTION 'a rule version must keep its rule''s achievement type' USING ERRCODE = 'BR110';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER rule_version_type BEFORE INSERT ON achievement.rule_version
  FOR EACH ROW EXECUTE FUNCTION achievement.assert_rule_version();

-- A · Lifecycle facts. No row = DRAFT; PUBLISHED at most once; RETIRED only after PUBLISHED.
CREATE TABLE achievement.rule_version_status_change (
  id               uuid PRIMARY KEY,
  rule_version_id  uuid NOT NULL REFERENCES achievement.rule_version (id),
  status           text NOT NULL CHECK (status IN ('PUBLISHED', 'RETIRED')),
  actor_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at      timestamptz NOT NULL,
  seq              bigint GENERATED ALWAYS AS IDENTITY,
  CONSTRAINT rule_version_status_once UNIQUE (rule_version_id, status)
);

CREATE VIEW achievement.v_rule_version_current AS
  SELECT v.id AS rule_version_id, v.rule_id,
         COALESCE((SELECT s.status FROM achievement.rule_version_status_change s
                   WHERE s.rule_version_id = v.id ORDER BY s.seq DESC LIMIT 1), 'DRAFT') AS status
  FROM achievement.rule_version v;

CREATE FUNCTION achievement.assert_rule_transition() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cur text;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('achievement-rule-version:' || NEW.rule_version_id::text, 0));
  SELECT s.status INTO cur FROM achievement.rule_version_status_change s
    WHERE s.rule_version_id = NEW.rule_version_id ORDER BY s.seq DESC LIMIT 1;
  IF NOT ((cur IS NULL AND NEW.status = 'PUBLISHED') OR (cur = 'PUBLISHED' AND NEW.status = 'RETIRED')) THEN
    RAISE EXCEPTION 'rule version transition % → % is not permitted', COALESCE(cur, 'DRAFT'), NEW.status
      USING ERRCODE = 'BR111';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER rule_version_transition BEFORE INSERT ON achievement.rule_version_status_change
  FOR EACH ROW EXECUTE FUNCTION achievement.assert_rule_transition();

-- A · Binding of a PUBLISHED rule version to its EXACT DisciplineVersion, optionally narrowed to one
-- Competition or Event (never broadened). History is append-only: per (rule, scope) the binding in
-- force at time T is the latest with effective_from ≤ T; no backdating (strict); effective times
-- strictly increase per (rule, scope) so two versions of one rule never apply at the same instant.
-- A binding applies to ResultVersions SUBMITTED while it is in force (no retroactive derivation).
CREATE TABLE achievement.rule_binding (
  id                    uuid PRIMARY KEY,
  rule_id               uuid NOT NULL REFERENCES achievement.rule (id),
  rule_version_id       uuid NOT NULL REFERENCES achievement.rule_version (id),
  discipline_version_id uuid NOT NULL REFERENCES sports.discipline_version (id),
  competition_id        uuid REFERENCES competition.competition (id),
  event_id              uuid REFERENCES competition.event (id),
  scope_key             text GENERATED ALWAYS AS (discipline_version_id::text || ':' || COALESCE(competition_id::text, '*') || ':' || COALESCE(event_id::text, '*')) STORED,
  effective_from        timestamptz NOT NULL,
  actor_account_id      uuid NOT NULL REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL,
  seq                   bigint GENERATED ALWAYS AS IDENTITY,
  CHECK (effective_from >= recorded_at),
  CHECK (event_id IS NULL OR competition_id IS NOT NULL)
);
CREATE INDEX rule_binding_dv_idx ON achievement.rule_binding (discipline_version_id, effective_from DESC, seq DESC);

CREATE FUNCTION achievement.assert_rule_binding() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  latest timestamptz;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('achievement-binding:' || NEW.rule_id::text || ':' || NEW.discipline_version_id::text, 0));
  IF NOT EXISTS (SELECT 1 FROM achievement.v_rule_version_current c
                 JOIN achievement.rule_version v ON v.id = c.rule_version_id
                 WHERE c.rule_version_id = NEW.rule_version_id AND c.status = 'PUBLISHED'
                   AND v.rule_id = NEW.rule_id AND v.discipline_version_id = NEW.discipline_version_id) THEN
    RAISE EXCEPTION 'only a PUBLISHED version of this rule, for this exact discipline version, can be bound'
      USING ERRCODE = 'BR112';
  END IF;
  IF NEW.event_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM competition.event e WHERE e.id = NEW.event_id AND e.competition_id = NEW.competition_id
        AND e.discipline_version_id = NEW.discipline_version_id) THEN
    RAISE EXCEPTION 'a narrowed binding must name an event of that competition under the same discipline version'
      USING ERRCODE = 'BR114';
  END IF;
  SELECT max(b.effective_from) INTO latest FROM achievement.rule_binding b
    WHERE b.rule_id = NEW.rule_id AND b.discipline_version_id = NEW.discipline_version_id
      AND b.competition_id IS NOT DISTINCT FROM NEW.competition_id AND b.event_id IS NOT DISTINCT FROM NEW.event_id;
  IF latest IS NOT NULL AND NEW.effective_from <= latest THEN
    RAISE EXCEPTION 'a binding must take effect strictly after the previous binding of this rule for this scope'
      USING ERRCODE = 'BR113';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER rule_binding_rules BEFORE INSERT ON achievement.rule_binding
  FOR EACH ROW EXECUTE FUNCTION achievement.assert_rule_binding();

REVOKE ALL ON FUNCTION achievement.assert_rule_version(), achievement.assert_rule_transition(),
  achievement.assert_rule_binding() FROM PUBLIC;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rule', 'rule_version', 'rule_version_status_change', 'rule_binding'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON achievement.%I FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON achievement.%I FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation()', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON achievement.%I FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at()', t || '_recorded_at', t);
    -- Rule operator (br_achievement_rules): create, version, publish, retire, bind — nothing else.
    EXECUTE format('GRANT SELECT, INSERT ON achievement.%I TO br_achievement_rules', t);
    -- Achievement runtime and rebuild: read-only.
    EXECUTE format('GRANT SELECT ON achievement.%I TO br_achievements, br_rebuild', t);
  END LOOP;
END
$$;
GRANT USAGE ON SCHEMA achievement TO br_achievement_rules, br_achievements, br_rebuild;
GRANT SELECT ON achievement.v_rule_version_current TO br_achievement_rules, br_achievements, br_rebuild;

-- Rule operator plumbing: platform time, outbox, audit, idempotency; exact PUBLISHED discipline
-- versions (public catalog facts) to validate metric references; competition / event identities to
-- narrow a binding. No results, verification, evidence, authority, identity or PII.
GRANT USAGE ON SCHEMA platform TO br_achievement_rules;
GRANT EXECUTE ON FUNCTION platform.tx_time_ms() TO br_achievement_rules;
GRANT SELECT, INSERT ON platform.outbox_event TO br_achievement_rules;
GRANT SELECT, INSERT ON platform.command_idempotency TO br_achievement_rules;
GRANT INSERT ON platform.audit_event TO br_achievement_rules;
GRANT USAGE ON SCHEMA sports TO br_achievement_rules;
GRANT SELECT ON sports.discipline_version, sports.v_discipline_version_current TO br_achievement_rules;
GRANT USAGE ON SCHEMA competition TO br_achievement_rules;
GRANT SELECT ON competition.competition, competition.event TO br_achievement_rules;
