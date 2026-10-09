-- BRT-08 · Immutable Verified Achievements (BRT-01 verification model §8, disputes §5.1, ADR-0001).
--
--   (achievement_type, rule_version, holder, scope, basis set) = one logical Achievement   (AC-2)
--
-- An Achievement is a DERIVED recognition: one row per logical Achievement holding the exact canonical
-- candidate document the pure engine produced (hash-bound), its basis items (which double as the
-- queryable dependency index), the immutable TEAM memberCredits (AC-5: from the exact credited lineup
-- of the basis ResultVersion — ONE Achievement per team title, never one per athlete), an append-only
-- status history (ACTIVE / SUSPENDED / SUPERSEDED / REVOKED) and supersession links. Nothing is ever
-- updated or deleted; a correction produces a NEW Achievement that supersedes the old one.
--
-- Provenance containment: the normal schema accepts ONLY snapshot_provenance = 'CANONICAL_ASSEMBLY'
-- (named CHECK constraints). REFERENCE_FIXTURE rows can exist solely in throwaway test databases
-- whose owner applied the test-only overlay (packages/testkit/sql/achievement-fixture-overlay.sql);
-- that overlay is not a migration, is not reachable from any runtime role, seed, API or worker.
--
-- Referential integrity: rule versions and discipline versions (produced by the platform in both
-- lanes) are FOREIGN KEYS. Upstream sporting facts (ResultVersion, VerificationRun, holder, credited
-- athletes, competition) are checked by the INVOKER trigger against the live canonical rows for every
-- CANONICAL_ASSEMBLY Achievement — content hash, run ↔ version, run snapshot/outcome hashes, run
-- level, current lifecycle status — and are hash-committed by the candidate document itself. Fixture
-- rows (overlay DBs only) are hash-committed but never get fabricated upstream parent rows.
--
-- Table classes: A (append-only) for every table here.
CREATE TABLE achievement.achievement (
  id                       uuid PRIMARY KEY,
  identity_hash            platform.content_hash NOT NULL,
  candidate_hash           platform.content_hash NOT NULL,
  candidate                jsonb NOT NULL CHECK (jsonb_typeof(candidate) = 'object' AND octet_length(candidate::text) <= 32768),
  achievement_type         text NOT NULL CHECK (achievement_type IN ('EVENT_COMPLETED', 'CONTEST_WON', 'PLACEMENT', 'TITLE', 'PERFORMANCE_THRESHOLD', 'PERSONAL_BEST')),
  rule_id                  uuid NOT NULL REFERENCES achievement.rule (id),
  rule_version_id          uuid NOT NULL REFERENCES achievement.rule_version (id),
  engine_version           text NOT NULL CHECK (engine_version ~ '^achievement-engine/[1-9][0-9]{0,3}$'),
  holder_type              text NOT NULL CHECK (holder_type IN ('ATHLETE', 'TEAM')),
  holder_id                uuid NOT NULL,
  scope_type               text NOT NULL CHECK (scope_type IN ('CONTEST', 'ROUND', 'EVENT', 'COMPETITION', 'CAREER')),
  scope_id                 uuid NOT NULL,
  competition_id           uuid NOT NULL,
  event_id                 uuid,
  discipline_version_id    uuid NOT NULL REFERENCES sports.discipline_version (id),
  basis_level              text NOT NULL CHECK (basis_level IN ('V0', 'V1', 'V2', 'V3', 'V4')),
  qualifying_value         jsonb CHECK (qualifying_value IS NULL OR jsonb_typeof(qualifying_value) = 'object'),
  comparison_set_hash      platform.content_hash,
  -- BRT-01 §8.1 evidenceCommitment: H(achievement-evidence-commitment, basis → pinned runs' BRT-06
  -- Evidence Bundles). governingAuthority: the recognition pinned from the basis run's immutable trace.
  evidence_commitment      platform.content_hash NOT NULL,
  governing_recognition_level text CHECK (governing_recognition_level IN ('PLATFORM', 'CLUB', 'REGIONAL', 'NATIONAL', 'CONTINENTAL', 'WORLD')),
  governing_anchor_id      uuid,
  -- AC-4: the governing anchor's IMMUTABLE BRT-03 fact hash (its recognition scope: level, region, sport).
  governing_anchor_fact_hash platform.content_hash,
  snapshot_provenance      text NOT NULL,
  derivation_snapshot_hash platform.content_hash NOT NULL,
  derivation_outcome_hash  platform.content_hash NOT NULL,
  requested_by_account_id  uuid REFERENCES identity.account (id),
  recorded_at              timestamptz NOT NULL,
  CONSTRAINT achievement_identity_key UNIQUE (identity_hash),
  CONSTRAINT achievement_canonical_provenance_only CHECK (snapshot_provenance = 'CANONICAL_ASSEMBLY')
);
CREATE INDEX achievement_holder_idx ON achievement.achievement (holder_type, holder_id);
CREATE INDEX achievement_family_idx ON achievement.achievement (achievement_type, rule_id, holder_type, holder_id, scope_type, scope_id);

-- A · Basis items = the dependency index: which Achievements depend on ResultVersion X, on
-- VerificationRun Y, on Performance (X, participant, ordinal), on classification version C.
CREATE TABLE achievement.basis_item (
  achievement_id            uuid NOT NULL REFERENCES achievement.achievement (id),
  result_version_id         uuid NOT NULL,
  content_hash              platform.content_hash NOT NULL,
  result_status             text NOT NULL,
  verification_run_id       uuid NOT NULL,
  verification_snapshot_hash platform.content_hash NOT NULL,
  verification_outcome_hash platform.content_hash NOT NULL,
  pinned_run_level        text NOT NULL CHECK (pinned_run_level IN ('V0', 'V1', 'V2', 'V3', 'V4')),
  participant_id            uuid NOT NULL,
  performance_ordinal       integer CHECK (performance_ordinal IS NULL OR performance_ordinal >= 1),
  credited_lineup_hash      platform.content_hash,
  evidence_bundle_hash      platform.content_hash NOT NULL,
  evidence_bundle_as_of     timestamptz NOT NULL,
  recorded_at               timestamptz NOT NULL,
  PRIMARY KEY (achievement_id, result_version_id, participant_id)
);
CREATE INDEX basis_item_rv_idx ON achievement.basis_item (result_version_id);
CREATE INDEX basis_item_run_idx ON achievement.basis_item (verification_run_id);
CREATE INDEX basis_item_perf_idx ON achievement.basis_item (result_version_id, participant_id, performance_ordinal);

-- A · Immutable TEAM member credits (BRT-01 §8.1 memberCredits, AC-5), part of the hashed content.
CREATE TABLE achievement.member_credit (
  achievement_id uuid NOT NULL REFERENCES achievement.achievement (id),
  athlete_id     uuid NOT NULL,
  credit_role    text NOT NULL CHECK (credit_role IN ('LINEUP_MEMBER')),
  recorded_at    timestamptz NOT NULL,
  PRIMARY KEY (achievement_id, athlete_id)
);
CREATE INDEX member_credit_athlete_idx ON achievement.member_credit (athlete_id);

-- A · Supersession links: a newer Achievement (same type / rule / holder / scope, new basis) that
-- replaces an older one. The older fact is never modified.
CREATE TABLE achievement.supersession (
  superseded_id  uuid NOT NULL REFERENCES achievement.achievement (id),
  superseding_id uuid NOT NULL REFERENCES achievement.achievement (id),
  recorded_at    timestamptz NOT NULL,
  PRIMARY KEY (superseded_id, superseding_id),
  CHECK (superseded_id <> superseding_id)
);
CREATE INDEX supersession_superseding_idx ON achievement.supersession (superseding_id);

-- A · Status history (BRT-01 §8.1 statusHistory). Each entry commits to the hash of the support facts
-- it was assessed from; the latest entry is the current status (projected in achievement_read).
CREATE TABLE achievement.status_entry (
  id                    uuid PRIMARY KEY,
  achievement_id        uuid NOT NULL REFERENCES achievement.achievement (id),
  status                text NOT NULL CHECK (status IN ('ACTIVE', 'SUSPENDED', 'SUPERSEDED', 'REVOKED')),
  reasons               text[] NOT NULL DEFAULT '{}' CHECK (cardinality(reasons) <= 16),
  superseded_by         uuid REFERENCES achievement.achievement (id),
  support_facts_hash    platform.content_hash NOT NULL,
  assessment_provenance text NOT NULL,
  recorded_at           timestamptz NOT NULL,
  seq                   bigint GENERATED ALWAYS AS IDENTITY,
  CONSTRAINT status_entry_canonical_provenance_only CHECK (assessment_provenance = 'CANONICAL_ASSEMBLY'),
  CHECK ((status = 'SUPERSEDED') = (superseded_by IS NOT NULL))
);
CREATE INDEX status_entry_achievement_idx ON achievement.status_entry (achievement_id, seq DESC);

CREATE VIEW achievement.v_achievement_status AS
  SELECT a.id AS achievement_id,
         (SELECT s.status FROM achievement.status_entry s WHERE s.achievement_id = a.id ORDER BY s.seq DESC LIMIT 1) AS status
  FROM achievement.achievement a;

-- ─────────────────────────────── structural bindings ───────────────────────────────

CREATE FUNCTION achievement.level_index(level text) RETURNS integer
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.array_position(ARRAY['V0', 'V1', 'V2', 'V3', 'V4'], level)
$$;

-- Columns equal the canonical candidate; the rule version is the PUBLISHED one it names; for
-- CANONICAL_ASSEMBLY rows every upstream reference matches live canonical facts.
CREATE FUNCTION achievement.assert_achievement() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  c jsonb := NEW.candidate;
  b jsonb;
  spec jsonb;
  cur_status text;
BEGIN
  IF c->>'achievementType' IS DISTINCT FROM NEW.achievement_type
     OR c->>'provenance' IS DISTINCT FROM NEW.snapshot_provenance
     OR c->>'engineVersion' IS DISTINCT FROM NEW.engine_version
     OR c->'rule'->>'ruleId' IS DISTINCT FROM NEW.rule_id::text
     OR c->'rule'->>'ruleVersionId' IS DISTINCT FROM NEW.rule_version_id::text
     OR c->'holder'->>'holderType' IS DISTINCT FROM NEW.holder_type
     OR c->'holder'->>'holderId' IS DISTINCT FROM NEW.holder_id::text
     OR c->'scope'->>'scopeType' IS DISTINCT FROM NEW.scope_type
     OR c->'scope'->>'scopeId' IS DISTINCT FROM NEW.scope_id::text
     OR c->'context'->>'competitionId' IS DISTINCT FROM NEW.competition_id::text
     OR c->'context'->>'eventId' IS DISTINCT FROM NEW.event_id::text
     OR c->'context'->>'disciplineVersionId' IS DISTINCT FROM NEW.discipline_version_id::text
     OR c->>'basisLevel' IS DISTINCT FROM NEW.basis_level
     OR c->'qualifyingValue' IS DISTINCT FROM NEW.qualifying_value
     OR c->>'comparisonSetHash' IS DISTINCT FROM NEW.comparison_set_hash::text
     OR c->>'evidenceCommitment' IS DISTINCT FROM NEW.evidence_commitment::text
     OR c->'governingAuthority'->>'recognitionLevel' IS DISTINCT FROM NEW.governing_recognition_level
     OR c->'governingAuthority'->>'anchorId' IS DISTINCT FROM NEW.governing_anchor_id::text
     OR c->'governingAuthority'->>'anchorFactHash' IS DISTINCT FROM NEW.governing_anchor_fact_hash::text
     OR jsonb_typeof(c->'basis') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'basis') < 1 THEN
    RAISE EXCEPTION 'achievement columns disagree with the canonical candidate' USING ERRCODE = 'BR120';
  END IF;
  SELECT v.spec INTO spec FROM achievement.rule_version v
    JOIN achievement.v_rule_version_current s ON s.rule_version_id = v.id
    WHERE v.id = NEW.rule_version_id AND v.rule_id = NEW.rule_id AND s.status = 'PUBLISHED'
      AND v.spec_hash::text = c->'rule'->>'specHash' AND v.achievement_type = NEW.achievement_type
      AND v.discipline_version_id = NEW.discipline_version_id;
  IF spec IS NULL THEN
    RAISE EXCEPTION 'an achievement needs the PUBLISHED rule version (same spec hash) it names' USING ERRCODE = 'BR126';
  END IF;
  FOR b IN SELECT * FROM jsonb_array_elements(c->'basis') LOOP
    IF achievement.level_index(b->>'verificationLevel')
       < achievement.level_index(spec->'requirements'->>'minimumVerificationLevel') THEN
      RAISE EXCEPTION 'basis verification level is below the rule requirement' USING ERRCODE = 'BR127';
    END IF;
  END LOOP;
  IF NEW.snapshot_provenance = 'CANONICAL_ASSEMBLY' THEN
    FOR b IN SELECT * FROM jsonb_array_elements(c->'basis') LOOP
      IF NOT EXISTS (SELECT 1 FROM results.result_version rv
                     WHERE rv.id = (b->>'resultVersionId')::uuid AND rv.content_hash::text = b->>'contentHash') THEN
        RAISE EXCEPTION 'basis ResultVersion / content hash is not canonical' USING ERRCODE = 'BR128';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM verification.run r
                     WHERE r.id = (b->>'verificationRunId')::uuid AND r.result_version_id = (b->>'resultVersionId')::uuid
                       AND r.snapshot_hash::text = b->>'verificationSnapshotHash'
                       AND r.outcome_hash::text = b->>'verificationOutcomeHash'
                       AND r.evidence_bundle_hash::text = b->>'evidenceBundleHash'
                       AND r.evaluated_as_of = (b->>'evidenceBundleAsOf')::timestamptz
                       AND r.highest_level = b->>'verificationLevel') THEN
        RAISE EXCEPTION 'basis VerificationRun does not match the canonical run of that version' USING ERRCODE = 'BR129';
      END IF;
      SELECT t.to_status INTO cur_status FROM results.result_status_transition t
        WHERE t.result_version_id = (b->>'resultVersionId')::uuid ORDER BY t.recorded_at DESC, t.id DESC LIMIT 1;
      IF cur_status IS DISTINCT FROM b->>'resultStatus' THEN
        RAISE EXCEPTION 'basis result status is not the canonical current status' USING ERRCODE = 'BR130';
      END IF;
    END LOOP;
    IF (NEW.holder_type = 'ATHLETE' AND NOT EXISTS (SELECT 1 FROM identity.athlete x WHERE x.id = NEW.holder_id))
       OR (NEW.holder_type = 'TEAM' AND NOT EXISTS (SELECT 1 FROM competition.team x WHERE x.id = NEW.holder_id))
       OR NOT EXISTS (SELECT 1 FROM competition.competition x WHERE x.id = NEW.competition_id) THEN
      RAISE EXCEPTION 'achievement holder / competition is not canonical' USING ERRCODE = 'BR131';
    END IF;
    -- AC-4: the pinned governing recognition scope is exactly the immutable anchor fact's scope.
    IF NEW.governing_anchor_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM authority.trust_anchor ta
         WHERE ta.id = NEW.governing_anchor_id AND ta.fact_hash = NEW.governing_anchor_fact_hash
           AND ta.recognition_scope = c->'governingAuthority'->'recognitionScope') THEN
      RAISE EXCEPTION 'governing recognition scope is not the pinned anchor fact' USING ERRCODE = 'BR133';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER achievement_binding BEFORE INSERT ON achievement.achievement
  FOR EACH ROW EXECUTE FUNCTION achievement.assert_achievement();

-- Every basis item / member credit row is an element of its achievement's candidate, written in the
-- achievement's own transaction.
CREATE FUNCTION achievement.assert_basis_item() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
      SELECT 1 FROM achievement.achievement a, jsonb_array_elements(a.candidate->'basis') b
      WHERE a.id = NEW.achievement_id AND a.recorded_at = NEW.recorded_at
        AND b->>'resultVersionId' = NEW.result_version_id::text AND b->>'contentHash' = NEW.content_hash::text
        AND b->>'resultStatus' = NEW.result_status AND b->>'verificationRunId' = NEW.verification_run_id::text
        AND b->>'verificationSnapshotHash' = NEW.verification_snapshot_hash::text
        AND b->>'verificationOutcomeHash' = NEW.verification_outcome_hash::text
        AND b->>'verificationLevel' = NEW.pinned_run_level AND b->>'participantId' = NEW.participant_id::text
        AND (b->>'performanceOrdinal')::integer IS NOT DISTINCT FROM NEW.performance_ordinal
        AND b->>'creditedLineupHash' IS NOT DISTINCT FROM NEW.credited_lineup_hash::text
        AND b->>'evidenceBundleHash' = NEW.evidence_bundle_hash::text
        AND (b->>'evidenceBundleAsOf')::timestamptz = NEW.evidence_bundle_as_of) THEN
    RAISE EXCEPTION 'a basis item must be an element of its achievement candidate' USING ERRCODE = 'BR121';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER basis_item_binding BEFORE INSERT ON achievement.basis_item
  FOR EACH ROW EXECUTE FUNCTION achievement.assert_basis_item();

CREATE FUNCTION achievement.assert_member_credit() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  prov text;
BEGIN
  SELECT a.snapshot_provenance INTO prov FROM achievement.achievement a, jsonb_array_elements(a.candidate->'memberCredits') m
    WHERE a.id = NEW.achievement_id AND a.recorded_at = NEW.recorded_at AND a.holder_type = 'TEAM'
      AND m->>'athleteId' = NEW.athlete_id::text AND m->>'creditRole' = NEW.credit_role;
  IF prov IS NULL THEN
    RAISE EXCEPTION 'a member credit must be an element of its TEAM achievement candidate' USING ERRCODE = 'BR122';
  END IF;
  IF prov = 'CANONICAL_ASSEMBLY' AND NOT EXISTS (SELECT 1 FROM identity.athlete x WHERE x.id = NEW.athlete_id) THEN
    RAISE EXCEPTION 'credited athlete is not canonical' USING ERRCODE = 'BR122';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER member_credit_binding BEFORE INSERT ON achievement.member_credit
  FOR EACH ROW EXECUTE FUNCTION achievement.assert_member_credit();

-- At commit: every candidate basis item and member credit was written (nothing partial).
CREATE FUNCTION achievement.assert_achievement_complete() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (SELECT count(*) FROM achievement.basis_item b WHERE b.achievement_id = NEW.id) <> jsonb_array_length(NEW.candidate->'basis')
     OR (SELECT count(*) FROM achievement.member_credit m WHERE m.achievement_id = NEW.id)
        <> COALESCE(jsonb_array_length(NEW.candidate->'memberCredits'), 0)
     OR NOT EXISTS (SELECT 1 FROM achievement.status_entry s WHERE s.achievement_id = NEW.id) THEN
    RAISE EXCEPTION 'an achievement must commit with all its basis items, member credits and an initial status'
      USING ERRCODE = 'BR132';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER achievement_complete AFTER INSERT ON achievement.achievement
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION achievement.assert_achievement_complete();

CREATE FUNCTION achievement.assert_supersession() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
      SELECT 1 FROM achievement.achievement o JOIN achievement.achievement n ON n.id = NEW.superseding_id
      WHERE o.id = NEW.superseded_id AND o.achievement_type = n.achievement_type AND o.rule_id = n.rule_id
        AND o.holder_type = n.holder_type AND o.holder_id = n.holder_id AND o.scope_type = n.scope_type
        AND o.scope_id = n.scope_id AND o.snapshot_provenance = n.snapshot_provenance) THEN
    -- (No wall-clock comparison: both rows exist — the superseded one committed earlier or in this
    -- same transaction — which already orders them; a database clock step must not reject a link.)
    RAISE EXCEPTION 'a supersession links two achievements of the same type, rule, holder and scope' USING ERRCODE = 'BR125';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER supersession_binding BEFORE INSERT ON achievement.supersession
  FOR EACH ROW EXECUTE FUNCTION achievement.assert_supersession();

-- Status history: linearized per achievement; provenance equals the achievement's; the first entry
-- is ACTIVE; nothing follows a terminal status; SUPERSEDED needs its supersession link.
CREATE FUNCTION achievement.assert_status_entry() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  prov text;
  cur text;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('achievement-status:' || NEW.achievement_id::text, 0));
  SELECT a.snapshot_provenance INTO prov FROM achievement.achievement a WHERE a.id = NEW.achievement_id;
  IF prov IS DISTINCT FROM NEW.assessment_provenance THEN
    RAISE EXCEPTION 'a status assessment must have its achievement''s provenance' USING ERRCODE = 'BR123';
  END IF;
  SELECT s.status INTO cur FROM achievement.status_entry s WHERE s.achievement_id = NEW.achievement_id ORDER BY s.seq DESC LIMIT 1;
  IF (cur IS NULL AND NEW.status <> 'ACTIVE') OR cur IN ('SUPERSEDED', 'REVOKED') THEN
    RAISE EXCEPTION 'status % cannot follow %', NEW.status, COALESCE(cur, 'issuance') USING ERRCODE = 'BR124';
  END IF;
  IF NEW.status = 'SUPERSEDED' AND NOT EXISTS (SELECT 1 FROM achievement.supersession x
      WHERE x.superseded_id = NEW.achievement_id AND x.superseding_id = NEW.superseded_by) THEN
    RAISE EXCEPTION 'SUPERSEDED needs a supersession link' USING ERRCODE = 'BR124';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER status_entry_binding BEFORE INSERT ON achievement.status_entry
  FOR EACH ROW EXECUTE FUNCTION achievement.assert_status_entry();

REVOKE ALL ON FUNCTION achievement.assert_achievement(), achievement.assert_basis_item(),
  achievement.assert_member_credit(), achievement.assert_achievement_complete(),
  achievement.assert_supersession(), achievement.assert_status_entry(), achievement.level_index(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION achievement.level_index(text) TO br_achievements, br_rebuild;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['achievement', 'basis_item', 'member_credit', 'supersession', 'status_entry'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON achievement.%I FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON achievement.%I FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation()', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON achievement.%I FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at()', t || '_recorded_at', t);
    EXECUTE format('GRANT SELECT, INSERT ON achievement.%I TO br_achievements', t);
    EXECUTE format('GRANT SELECT ON achievement.%I TO br_rebuild', t);
  END LOOP;
END
$$;
GRANT SELECT ON achievement.v_achievement_status TO br_achievements, br_rebuild;

-- ─────────────────────── achievement runtime: narrow read-only inputs ───────────────────────
-- br_achievements READS the exact canonical facts a derivation needs (read-only direct grants on the
-- exact tables; no module membership) and WRITES only achievement facts, its read model, its ledger
-- stream, outbox events and audit rows. It never writes results, verification, evidence, attestations,
-- authority, competition, identity or the catalog; it never reads identity_private, accounts' auth
-- identities, profiles, evidence or attestations. Its ONLY verification read is verification.run
-- (the basis trigger). BRT-07 freshness / the pinned run's trace are read under the READ-ONLY role
-- br_verification_reader in the same transaction (see below) — Achievement consumes Verification and
-- never produces it: no achievement login can become br_verification.
GRANT USAGE ON SCHEMA platform TO br_achievements;
GRANT EXECUTE ON FUNCTION platform.tx_time_ms() TO br_achievements;
GRANT SELECT, INSERT ON platform.ledger_entry TO br_achievements;
GRANT SELECT, INSERT, UPDATE ON platform.stream_head TO br_achievements;
GRANT SELECT, INSERT ON platform.outbox_event TO br_achievements;
GRANT SELECT, INSERT ON platform.command_idempotency TO br_achievements;
GRANT INSERT ON platform.audit_event TO br_achievements;

GRANT USAGE ON SCHEMA results TO br_achievements;
GRANT SELECT ON results.result, results.result_version, results.result_status_transition TO br_achievements;
GRANT EXECUTE ON FUNCTION results.resolve_result_version(uuid) TO br_achievements;

GRANT USAGE ON SCHEMA verification TO br_achievements;
GRANT SELECT ON verification.run TO br_achievements;
-- AC-4 (BR133): the immutable anchor fact columns only — never anchor status, grants or keys.
GRANT USAGE ON SCHEMA authority TO br_achievements;
GRANT SELECT (id, fact_hash, recognition_scope) ON authority.trust_anchor TO br_achievements;

GRANT USAGE ON SCHEMA competition TO br_achievements;
GRANT EXECUTE ON FUNCTION competition.resolve_scope_path(text, uuid) TO br_achievements;
GRANT EXECUTE ON FUNCTION competition.account_competition_roles(uuid, uuid) TO br_achievements;
GRANT SELECT ON competition.competition, competition.v_competition_current, competition.event,
  competition.v_event_current, competition.participant, competition.team, competition.contest,
  competition.contest_status_change TO br_achievements;

GRANT USAGE ON SCHEMA sports TO br_achievements;
GRANT SELECT ON sports.sport, sports.discipline, sports.discipline_version TO br_achievements;

GRANT USAGE ON SCHEMA identity TO br_achievements;
GRANT SELECT (id) ON identity.athlete TO br_achievements;

-- ─────────────── br_verification_reader: the READ-ONLY interface to Verification ───────────────
-- Exactly the SELECT set BRT-07 hash-based freshness needs to re-assemble a current snapshot (the same
-- tables br_verification reads) plus the pinned run and its trace — and NOTHING writable: no INSERT,
-- UPDATE, DELETE or TRUNCATE anywhere, no read model, no ledger, no outbox, no audit. Reachable from
-- br_api and br_achievement_worker_app (SET only). It can never create a VerificationRun, a trace or a
-- policy / binding.
GRANT USAGE ON SCHEMA platform, results, competition, sports, identity, organizations, authority, evidence,
  attestation, verification TO br_verification_reader;
GRANT EXECUTE ON FUNCTION platform.tx_time_ms() TO br_verification_reader;
GRANT SELECT ON results.result, results.result_version, results.result_status_transition TO br_verification_reader;
GRANT EXECUTE ON FUNCTION results.resolve_result_version(uuid) TO br_verification_reader;
GRANT EXECUTE ON FUNCTION competition.resolve_scope_path(text, uuid) TO br_verification_reader;
GRANT EXECUTE ON FUNCTION competition.account_competition_roles(uuid, uuid) TO br_verification_reader;
GRANT SELECT ON competition.competition, competition.v_competition_current, competition.event,
  competition.v_event_current, competition.contestant, competition.participant,
  competition.team, competition.team_manager, competition.team_membership, competition.team_membership_status_change,
  competition.lineup, competition.lineup_member, competition.competition_staff,
  competition.competition_staff_status_change, competition.contest_status_change TO br_verification_reader;
GRANT SELECT ON sports.discipline_version TO br_verification_reader;
GRANT SELECT ON identity.athlete, identity.person_principal, identity.guardian_relationship,
  identity.guardian_relationship_status_change TO br_verification_reader;
GRANT SELECT ON organizations.organization_principal, organizations.membership,
  organizations.membership_status_change TO br_verification_reader;
GRANT SELECT ON authority.principal, authority.principal_key, authority.principal_key_status_change,
  authority.trust_anchor, authority.trust_anchor_status_change, authority.authority_grant,
  authority.authority_grant_status_change TO br_verification_reader;
GRANT SELECT ON evidence.item, evidence.attachment, evidence.availability_change, evidence.privacy_change,
  evidence.relation TO br_verification_reader;
GRANT SELECT ON attestation.attestation, attestation.retraction, attestation.attestation_evidence TO br_verification_reader;
GRANT SELECT ON verification.policy, verification.policy_version, verification.policy_version_status_change,
  verification.policy_binding, verification.v_policy_version_current, verification.run, verification.run_trace
  TO br_verification_reader;
