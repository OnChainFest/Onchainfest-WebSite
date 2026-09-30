-- BRT-07 · Verification read models (class B projections). NOT a source of truth: every row is
-- derived from append-only verification.run facts (+ policy identity), maintained by the evaluating
-- transaction and fully rebuildable by the maintenance login (br_rebuild) from verification metadata
-- alone — no PII, no evidence bytes, no evidence cipher, no authority topology.
--
-- Freshness (CURRENT / STALE) is NOT stored: it is recomputed at read time by comparing the current
-- snapshot hash with the latest run's snapshot hash (a stored freshness would itself go stale).
CREATE SCHEMA verification_read;
REVOKE ALL ON SCHEMA verification_read FROM PUBLIC;

-- Latest run per exact ResultVersion (any policy version; freshness decides how it may be shown).
CREATE TABLE verification_read.current_verification (
  result_version_id uuid PRIMARY KEY,
  run_id            uuid NOT NULL,
  policy_version_id uuid NOT NULL,
  policy_code       text NOT NULL,
  policy_version    integer NOT NULL,
  engine_version    text NOT NULL,
  evaluation_state  text NOT NULL,
  highest_level     text,
  snapshot_hash     text NOT NULL,
  evaluated_as_of   timestamptz NOT NULL,
  active_dispute    boolean NOT NULL,
  competition_id    uuid NOT NULL,
  event_id          uuid,
  contest_id        uuid
);

-- Public-safe summary of every run: level lines, the next blocked level with fixed public wording,
-- the active-dispute marker. Derived from the outcome document only (never from the trace).
CREATE TABLE verification_read.run_summary (
  run_id            uuid PRIMARY KEY,
  result_version_id uuid NOT NULL,
  competition_id    uuid NOT NULL,
  event_id          uuid,
  contest_id        uuid,
  policy_code       text NOT NULL,
  policy_version    integer NOT NULL,
  engine_version    text NOT NULL,
  evaluation_state  text NOT NULL,
  highest_level     text,
  evaluated_as_of   timestamptz NOT NULL,
  public_body       jsonb NOT NULL CHECK (jsonb_typeof(public_body) = 'object')
);
CREATE INDEX run_summary_rv_idx ON verification_read.run_summary (result_version_id, evaluated_as_of DESC);

GRANT USAGE ON SCHEMA verification_read TO br_verification, br_rebuild, br_public_read;
-- Incremental maintenance by the evaluating transaction.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA verification_read TO br_verification;
-- Full rebuild (maintenance only).
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA verification_read TO br_rebuild;
-- Public read path: public-safe run summaries only.
GRANT SELECT ON verification_read.run_summary TO br_public_read;
