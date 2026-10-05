-- BRT-03 · Platform primitives: time helpers, append-only protection, per-stream hash-chained
-- ledger (BRT-02 persistence §5.2), transactional outbox (ADR-0012), command idempotency,
-- development job queue.
CREATE SCHEMA platform;
REVOKE ALL ON SCHEMA platform FROM PUBLIC;

-- Platform time: the database transaction time truncated to milliseconds (BR-JSON precision).
-- Every fact in one transaction shares this recordedAt.
CREATE FUNCTION platform.tx_time_ms() RETURNS timestamptz
  LANGUAGE sql STABLE AS $$ SELECT date_trunc('milliseconds', now()) $$;

-- Class A tables: reject UPDATE / DELETE / TRUNCATE for every role, including the owner.
CREATE FUNCTION platform.reject_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %.%: % is not permitted', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'BR001';
END
$$;

-- recordedAt is database transaction time; applications must use it (they read it via
-- platform.tx_time_ms() to include it in hashes) and cannot forge it.
CREATE FUNCTION platform.assert_recorded_at() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.recorded_at IS DISTINCT FROM platform.tx_time_ms() THEN
    RAISE EXCEPTION 'recorded_at must equal the transaction time (got %, expected %)',
      NEW.recorded_at, platform.tx_time_ms() USING ERRCODE = 'BR002';
  END IF;
  RETURN NEW;
END
$$;

CREATE DOMAIN platform.content_hash AS text CHECK (VALUE ~ '^sha256:[0-9a-f]{64}$');

CREATE TABLE platform.ledger_entry (
  id            uuid PRIMARY KEY,
  stream_id     uuid NOT NULL,
  stream_type   text NOT NULL CHECK (stream_type IN (
                  'RESULT', 'VERIFICATION', 'ATTESTATION', 'EVIDENCE_ITEM', 'PRINCIPAL_KEY',
                  'AUTHORITY_GRANT', 'TRUST_ANCHOR', 'DISPUTE', 'ACHIEVEMENT', 'RECORD_CATEGORY',
                  'PRIZE_ENTITLEMENT', 'TROPHY')),
  sequence      bigint NOT NULL CHECK (sequence >= 1),
  previous_hash platform.content_hash NOT NULL,
  entry_hash    platform.content_hash NOT NULL UNIQUE,
  payload_hash  platform.content_hash NOT NULL,
  event_type    text NOT NULL,
  fact_table    text NOT NULL,
  fact_row_id   uuid NOT NULL,
  recorded_at   timestamptz NOT NULL,
  UNIQUE (stream_id, sequence),
  UNIQUE (fact_table, fact_row_id)
);
COMMENT ON TABLE platform.ledger_entry IS 'Class A: per-stream hash chain. No global chain.';

-- Class B projection: current chain head per stream. Rebuildable from ledger_entry.
CREATE TABLE platform.stream_head (
  stream_id     uuid PRIMARY KEY,
  stream_type   text NOT NULL,
  last_sequence bigint NOT NULL CHECK (last_sequence >= 0),
  last_hash     platform.content_hash NOT NULL,
  updated_at    timestamptz NOT NULL
);
COMMENT ON TABLE platform.stream_head IS 'Class B projection (not truth).';

-- Class A: domain events, written in the same transaction as the facts they describe.
CREATE TABLE platform.outbox_event (
  id                 uuid PRIMARY KEY,
  event_type         text NOT NULL,
  event_version      integer NOT NULL CHECK (event_version >= 1),
  aggregate_type     text NOT NULL,
  aggregate_id       uuid NOT NULL,
  actor_principal_id uuid,
  causation_id       text,
  correlation_id     text,
  payload            jsonb NOT NULL,
  recorded_at        timestamptz NOT NULL
);
CREATE INDEX outbox_event_aggregate_idx ON platform.outbox_event (aggregate_type, aggregate_id);

-- Class A: per-consumer processing receipts (consumer idempotency; effectively-once effects).
CREATE TABLE platform.outbox_consumption (
  consumer     text NOT NULL,
  event_id     uuid NOT NULL REFERENCES platform.outbox_event (id),
  recorded_at  timestamptz NOT NULL DEFAULT platform.tx_time_ms(),
  PRIMARY KEY (consumer, event_id)
);

-- Class A: command idempotency. Same (scope, key) + same request hash ⇒ same response;
-- same (scope, key) + different request hash ⇒ rejected.
CREATE TABLE platform.command_idempotency (
  scope          text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  command_type   text NOT NULL,
  request_hash   platform.content_hash NOT NULL,
  response       jsonb NOT NULL,
  recorded_at    timestamptz NOT NULL,
  PRIMARY KEY (scope, idempotency_key)
);

-- Operational (mutable): minimal development job queue for the worker skeleton.
CREATE TABLE platform.job (
  id          uuid PRIMARY KEY,
  kind        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  status      text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RUNNING', 'DONE', 'FAILED')),
  attempts    integer NOT NULL DEFAULT 0,
  run_after   timestamptz NOT NULL DEFAULT now(),
  locked_by   text,
  locked_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX job_pending_idx ON platform.job (run_after) WHERE status = 'PENDING';

-- Append-only enforcement.
CREATE TRIGGER ledger_entry_append_only BEFORE UPDATE OR DELETE ON platform.ledger_entry
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
CREATE TRIGGER ledger_entry_no_truncate BEFORE TRUNCATE ON platform.ledger_entry
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();
CREATE TRIGGER ledger_entry_recorded_at BEFORE INSERT ON platform.ledger_entry
  FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at();

CREATE TRIGGER outbox_event_append_only BEFORE UPDATE OR DELETE ON platform.outbox_event
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
CREATE TRIGGER outbox_event_no_truncate BEFORE TRUNCATE ON platform.outbox_event
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();
CREATE TRIGGER outbox_event_recorded_at BEFORE INSERT ON platform.outbox_event
  FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at();

CREATE TRIGGER outbox_consumption_append_only BEFORE UPDATE OR DELETE ON platform.outbox_consumption
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
CREATE TRIGGER outbox_consumption_no_truncate BEFORE TRUNCATE ON platform.outbox_consumption
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();

CREATE TRIGGER command_idempotency_append_only BEFORE UPDATE OR DELETE ON platform.command_idempotency
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
CREATE TRIGGER command_idempotency_no_truncate BEFORE TRUNCATE ON platform.command_idempotency
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();
CREATE TRIGGER command_idempotency_recorded_at BEFORE INSERT ON platform.command_idempotency
  FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at();

-- Privileges. Module roles never receive UPDATE/DELETE/TRUNCATE on class A tables.
GRANT USAGE ON SCHEMA platform TO br_authority, br_results, br_worker, br_rebuild;
GRANT EXECUTE ON FUNCTION platform.tx_time_ms() TO br_authority, br_results, br_worker, br_rebuild;
GRANT SELECT, INSERT ON platform.ledger_entry TO br_authority, br_results;
GRANT SELECT ON platform.ledger_entry TO br_worker, br_rebuild;
GRANT SELECT, INSERT, UPDATE ON platform.stream_head TO br_authority, br_results;
GRANT SELECT ON platform.stream_head TO br_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.stream_head TO br_rebuild;
GRANT SELECT, INSERT ON platform.outbox_event TO br_authority, br_results;
GRANT SELECT ON platform.outbox_event TO br_worker;
GRANT SELECT, INSERT ON platform.outbox_consumption TO br_worker;
GRANT SELECT, INSERT ON platform.command_idempotency TO br_authority, br_results;
GRANT SELECT, INSERT, UPDATE ON platform.job TO br_worker;
