-- BRT-03 · Results context minimum: stable Result identity, immutable ResultVersion snapshots,
-- append-only status transitions (T2–T4), mutable drafts, and class B projections.
-- BRT-01 result domain §6–8; BRT-02 persistence §3.0, §4.1, §5.4.
CREATE SCHEMA results;
REVOKE ALL ON SCHEMA results FROM PUBLIC;

-- Class A: logical identity of "the outcome of X".
CREATE TABLE results.result (
  id              uuid PRIMARY KEY,
  scope_type      text NOT NULL CHECK (scope_type IN ('CONTEST', 'ROUND_CLASSIFICATION', 'EVENT_CLASSIFICATION', 'COMPETITION_CLASSIFICATION')),
  scope_target_id uuid NOT NULL,
  fact_hash       platform.content_hash NOT NULL,
  recorded_at     timestamptz NOT NULL,
  UNIQUE (scope_type, scope_target_id)
);

-- Operational (mutable): drafts are editable until submitted (BRT-02 persistence §3.2).
CREATE TABLE results.result_draft (
  id                   uuid PRIMARY KEY,
  result_id            uuid NOT NULL REFERENCES results.result (id),
  author_principal_id  uuid NOT NULL REFERENCES authority.principal (id),
  discipline_version_ref text NOT NULL CHECK (length(discipline_version_ref) BETWEEN 1 AND 200),
  content              jsonb NOT NULL,
  submitted_version_id uuid,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Class A: immutable snapshot. Content and hash never change after insertion (R-1).
CREATE TABLE results.result_version (
  id                         uuid PRIMARY KEY,
  result_id                  uuid NOT NULL REFERENCES results.result (id),
  version_number             integer NOT NULL CHECK (version_number >= 1),
  discipline_version_ref     text NOT NULL CHECK (length(discipline_version_ref) BETWEEN 1 AND 200),
  content_schema             text NOT NULL,
  content                    jsonb NOT NULL,
  content_hash               platform.content_hash NOT NULL,
  submitted_by_principal_id  uuid NOT NULL REFERENCES authority.principal (id),
  supersedes_version_id      uuid REFERENCES results.result_version (id),
  fact_hash                  platform.content_hash NOT NULL,
  recorded_at                timestamptz NOT NULL,
  UNIQUE (result_id, version_number),
  -- Identical content cannot be submitted twice for the same Result.
  UNIQUE (result_id, content_hash)
);

ALTER TABLE results.result_draft
  ADD CONSTRAINT result_draft_submitted_version_fk FOREIGN KEY (submitted_version_id) REFERENCES results.result_version (id);

-- Class A: lifecycle facts. Each version enters each status at most once; no backward moves (R-3).
CREATE TABLE results.result_status_transition (
  id                         uuid PRIMARY KEY,
  result_version_id          uuid NOT NULL REFERENCES results.result_version (id),
  from_status                text,
  to_status                  text NOT NULL,
  transition_code            text NOT NULL,
  actor_principal_id         uuid NOT NULL REFERENCES authority.principal (id),
  authorization_proof_digest platform.content_hash NOT NULL,
  reason                     text,
  fact_hash                  platform.content_hash NOT NULL,
  recorded_at                timestamptz NOT NULL,
  UNIQUE (result_version_id, to_status),
  -- Transitions implemented in BRT-03 (T5–T8 arrive with later migrations).
  CHECK (
    (transition_code = 'T2' AND from_status IS NULL AND to_status = 'SUBMITTED')
    OR (transition_code = 'T3' AND from_status = 'SUBMITTED' AND to_status = 'PROVISIONAL')
    OR (transition_code = 'T4' AND from_status = 'SUBMITTED' AND to_status = 'REJECTED')
  )
);

-- Class B projection: current status per version (not truth; rebuildable).
CREATE TABLE results.result_version_state (
  result_version_id uuid PRIMARY KEY REFERENCES results.result_version (id),
  result_id         uuid NOT NULL REFERENCES results.result (id),
  current_status    text NOT NULL CHECK (current_status IN ('SUBMITTED', 'PROVISIONAL', 'OFFICIAL', 'FINAL', 'REJECTED', 'SUPERSEDED', 'REVOKED')),
  hold              boolean NOT NULL DEFAULT false,
  updated_at        timestamptz NOT NULL
);
-- Invariant R-2: at most one current-eligible version per Result.
CREATE UNIQUE INDEX result_version_state_one_current
  ON results.result_version_state (result_id)
  WHERE current_status IN ('PROVISIONAL', 'OFFICIAL', 'FINAL');

-- Class B projection: current version pointer per Result.
CREATE TABLE results.result_state (
  result_id          uuid PRIMARY KEY REFERENCES results.result (id),
  current_version_id uuid REFERENCES results.result_version (id),
  latest_version_number integer NOT NULL DEFAULT 0,
  updated_at         timestamptz NOT NULL
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['result', 'result_version', 'result_status_transition'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON results.%I FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON results.%I FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation()', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON results.%I FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at()', t || '_recorded_at', t);
    EXECUTE format('GRANT SELECT, INSERT ON results.%I TO br_results', t);
    EXECUTE format('GRANT SELECT ON results.%I TO br_rebuild', t);
  END LOOP;
END
$$;

GRANT USAGE ON SCHEMA results TO br_results, br_rebuild;
-- Drafts: operational, owned by the results module.
GRANT SELECT, INSERT, UPDATE ON results.result_draft TO br_results;
-- Projections: writable only by the owning module (and the audited rebuild role).
GRANT SELECT, INSERT, UPDATE ON results.result_version_state, results.result_state TO br_results;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON results.result_version_state, results.result_state TO br_rebuild;
