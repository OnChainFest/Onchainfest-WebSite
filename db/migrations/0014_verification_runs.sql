-- BRT-07 · Immutable VerificationRuns: one deterministic assessment of one exact ResultVersion under
-- one PUBLISHED policy version and one engine semantic version, over a snapshot assembled from REAL
-- canonical facts. The run stores the canonical outcome and trace documents it was produced with, so
-- history is never re-rendered with newer engine code.
--
--   (result_version_id, policy_version_id, engine_version, snapshot_hash) = one logical run
--
-- Table classes: A (append-only) for runs and traces. A later run may carry a different level; no
-- run is ever rewritten. Only CANONICAL_ASSEMBLY snapshots can be persisted (DB CHECK): synthetic
-- REFERENCE_FIXTURE snapshots can never become sporting truth.
CREATE TABLE verification.run (
  id                      uuid PRIMARY KEY,
  result_version_id       uuid NOT NULL REFERENCES results.result_version (id),
  policy_version_id       uuid NOT NULL REFERENCES verification.policy_version (id),
  policy_binding_id       uuid NOT NULL REFERENCES verification.policy_binding (id),
  engine_id               text NOT NULL CHECK (engine_id ~ '^[a-z0-9-]{1,64}$'),
  engine_version          text NOT NULL CHECK (engine_version ~ '^verification-engine/[1-9][0-9]{0,3}$'),
  assembler_version       text NOT NULL CHECK (assembler_version ~ '^verification-assembler/[1-9][0-9]{0,3}$'),
  snapshot_provenance     text NOT NULL CHECK (snapshot_provenance = 'CANONICAL_ASSEMBLY'),
  evaluated_as_of         timestamptz NOT NULL,
  snapshot_hash           platform.content_hash NOT NULL,
  policy_spec_hash        platform.content_hash NOT NULL,
  evidence_bundle_hash    platform.content_hash NOT NULL,
  outcome                 jsonb NOT NULL CHECK (jsonb_typeof(outcome) = 'object' AND octet_length(outcome::text) <= 65536),
  outcome_hash            platform.content_hash NOT NULL,
  trace_hash              platform.content_hash NOT NULL,
  evaluation_state        text NOT NULL CHECK (evaluation_state IN ('EVALUATED', 'INSUFFICIENT_INPUT')),
  highest_level           text CHECK (highest_level IN ('V0', 'V1', 'V2', 'V3', 'V4')),
  requested_by_account_id uuid REFERENCES identity.account (id),
  recorded_at             timestamptz NOT NULL,
  CONSTRAINT run_identity_key UNIQUE (result_version_id, policy_version_id, engine_version, snapshot_hash),
  -- Persisted runs are CURRENT evaluations: the cutoff is the recording transaction's own time.
  CHECK (evaluated_as_of = recorded_at),
  CHECK ((evaluation_state = 'EVALUATED') = (highest_level IS NOT NULL))
);
CREATE INDEX run_result_version_idx ON verification.run (result_version_id, recorded_at DESC, id DESC);

-- A · The canonical trace document of a run (internal: principal / grant / evidence references).
CREATE TABLE verification.run_trace (
  run_id      uuid PRIMARY KEY REFERENCES verification.run (id),
  trace       jsonb NOT NULL CHECK (jsonb_typeof(trace) = 'object' AND octet_length(trace::text) <= 1048576),
  trace_hash  platform.content_hash NOT NULL,
  recorded_at timestamptz NOT NULL
);

-- Structural binding: stored columns equal the canonical outcome document; the policy version is
-- PUBLISHED, its spec hash is the one evaluated, and the binding belongs to it.
CREATE FUNCTION verification.assert_run_binding() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  o jsonb := NEW.outcome;
BEGIN
  IF o->>'snapshotHash' IS DISTINCT FROM NEW.snapshot_hash::text
     OR o->>'traceHash' IS DISTINCT FROM NEW.trace_hash::text
     OR o->>'policySpecHash' IS DISTINCT FROM NEW.policy_spec_hash::text
     OR o->>'policyVersionId' IS DISTINCT FROM NEW.policy_version_id::text
     OR o->>'resultVersionId' IS DISTINCT FROM NEW.result_version_id::text
     OR o->>'engineVersion' IS DISTINCT FROM NEW.engine_version
     OR o->>'engineId' IS DISTINCT FROM NEW.engine_id
     OR o->>'evaluationState' IS DISTINCT FROM NEW.evaluation_state
     OR o->>'highestSatisfiedLevel' IS DISTINCT FROM NEW.highest_level THEN
    RAISE EXCEPTION 'verification run columns disagree with the outcome document' USING ERRCODE = 'BR093';
  END IF;
  IF NOT EXISTS (
      SELECT 1 FROM verification.policy_version v
      JOIN verification.v_policy_version_current c ON c.policy_version_id = v.id
      JOIN verification.policy_binding b ON b.policy_version_id = v.id
      WHERE v.id = NEW.policy_version_id AND c.status = 'PUBLISHED' AND v.spec_hash = NEW.policy_spec_hash
        AND b.id = NEW.policy_binding_id) THEN
    RAISE EXCEPTION 'a verification run needs a PUBLISHED, bound policy version with the evaluated spec'
      USING ERRCODE = 'BR094';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER run_binding BEFORE INSERT ON verification.run
  FOR EACH ROW EXECUTE FUNCTION verification.assert_run_binding();

CREATE FUNCTION verification.assert_trace_binding() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM verification.run r WHERE r.id = NEW.run_id AND r.trace_hash = NEW.trace_hash
                 AND r.snapshot_hash::text = NEW.trace->>'snapshotHash' AND r.recorded_at = NEW.recorded_at) THEN
    RAISE EXCEPTION 'a run trace must belong to its run (same transaction, hash and snapshot)' USING ERRCODE = 'BR095';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER run_trace_binding BEFORE INSERT ON verification.run_trace
  FOR EACH ROW EXECUTE FUNCTION verification.assert_trace_binding();
REVOKE ALL ON FUNCTION verification.assert_run_binding(), verification.assert_trace_binding() FROM PUBLIC;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['run', 'run_trace'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON verification.%I FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON verification.%I FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation()', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON verification.%I FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at()', t || '_recorded_at', t);
    EXECUTE format('GRANT SELECT, INSERT ON verification.%I TO br_verification', t);
    EXECUTE format('GRANT SELECT ON verification.%I TO br_rebuild', t);
  END LOOP;
END
$$;

-- ─────────────────────────────── verification runtime: narrow read-only inputs ───────────────────────────────
-- br_verification READS the canonical facts a snapshot needs (read-only direct grants on the exact
-- tables; no module membership) and WRITES only its own runs, traces, read model, ledger stream,
-- outbox events and audit rows. It never writes results, evidence, attestations, authority,
-- competition, identity or the catalog, and never reads identity_private, accounts' auth identities,
-- profiles, slugs or display names.
GRANT USAGE ON SCHEMA platform TO br_verification;
GRANT EXECUTE ON FUNCTION platform.tx_time_ms() TO br_verification;
GRANT SELECT, INSERT ON platform.ledger_entry TO br_verification;
GRANT SELECT, INSERT, UPDATE ON platform.stream_head TO br_verification;
GRANT SELECT, INSERT ON platform.outbox_event TO br_verification;
GRANT INSERT ON platform.audit_event TO br_verification;

GRANT USAGE ON SCHEMA results TO br_verification;
GRANT SELECT ON results.result, results.result_version, results.result_status_transition TO br_verification;
GRANT EXECUTE ON FUNCTION results.resolve_result_version(uuid) TO br_verification;

GRANT USAGE ON SCHEMA competition TO br_verification;
GRANT EXECUTE ON FUNCTION competition.resolve_scope_path(text, uuid) TO br_verification;
GRANT EXECUTE ON FUNCTION competition.account_competition_roles(uuid, uuid) TO br_verification;
GRANT SELECT ON competition.competition, competition.v_competition_current, competition.event,
  competition.v_event_current, competition.contestant, competition.participant,
  competition.team, competition.team_manager, competition.team_membership, competition.team_membership_status_change,
  competition.lineup, competition.lineup_member, competition.competition_staff,
  competition.competition_staff_status_change, competition.contest_status_change TO br_verification;

GRANT USAGE ON SCHEMA sports TO br_verification;
GRANT SELECT ON sports.discipline_version TO br_verification;

GRANT USAGE ON SCHEMA identity TO br_verification;
GRANT SELECT ON identity.athlete, identity.person_principal, identity.guardian_relationship,
  identity.guardian_relationship_status_change TO br_verification;

GRANT USAGE ON SCHEMA organizations TO br_verification;
GRANT SELECT ON organizations.organization_principal, organizations.membership,
  organizations.membership_status_change TO br_verification;

GRANT USAGE ON SCHEMA authority TO br_verification;
GRANT SELECT ON authority.principal, authority.principal_key, authority.principal_key_status_change,
  authority.trust_anchor, authority.trust_anchor_status_change, authority.authority_grant,
  authority.authority_grant_status_change TO br_verification;

GRANT USAGE ON SCHEMA evidence TO br_verification;
GRANT SELECT ON evidence.item, evidence.attachment, evidence.availability_change, evidence.privacy_change,
  evidence.relation TO br_verification;

GRANT USAGE ON SCHEMA attestation TO br_verification;
GRANT SELECT ON attestation.attestation, attestation.retraction, attestation.attestation_evidence TO br_verification;
