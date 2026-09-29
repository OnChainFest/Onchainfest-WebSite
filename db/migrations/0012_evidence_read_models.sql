-- BRT-06 · Evidence & attestation read models (class B projections). NOT a source of truth: every
-- row is derived from the append-only `evidence` / `attestation` facts, maintained by the owning
-- command transactions and fully rebuildable by the maintenance login (br_rebuild) from metadata
-- alone — rebuilding never needs evidence bytes or the evidence cipher.
CREATE SCHEMA evidence_read;
REVOKE ALL ON SCHEMA evidence_read FROM PUBLIC;

-- Current evidence lifecycle state (internal convenience; never served publicly).
CREATE TABLE evidence_read.evidence_state (
  evidence_id        uuid PRIMARY KEY,
  availability       text NOT NULL,
  availability_since timestamptz NOT NULL,
  privacy_class      text NOT NULL,
  attachment_count   integer NOT NULL
);

-- Public-safe attestation card: metadata of a cryptographically signed CLAIM. Deliberately absent:
-- statement/proof bytes, nonces, content/descriptor hashes of evidence, key material, account ids,
-- person ids and private identifiers. Only PUBLIC-visibility attestations are served, and only
-- when the subject's competition and event are publicly visible (non-DRAFT) — checked at read time.
CREATE TABLE evidence_read.attestation_card (
  attestation_id            uuid PRIMARY KEY,
  visibility                text NOT NULL,
  subject_type              text NOT NULL,
  subject_id                uuid NOT NULL,
  result_id                 uuid NOT NULL,
  competition_id            uuid,
  event_id                  uuid,
  contest_id                uuid,
  issuer_principal_type     text NOT NULL,
  issuer_organization_id    uuid,
  claim_type                text NOT NULL,
  polarity                  text NOT NULL,
  proof_type                text NOT NULL,
  proof_scheme              text NOT NULL,
  evidence_count            integer NOT NULL,
  evidence_available_count  integer NOT NULL,
  issued_at                 timestamptz NOT NULL,
  supersedes_attestation_id uuid,
  superseded                boolean NOT NULL,
  retracted                 boolean NOT NULL,
  retraction_reason         text,
  retracted_at              timestamptz
);
CREATE INDEX attestation_card_subject_idx ON evidence_read.attestation_card (subject_id);

GRANT USAGE ON SCHEMA evidence_read TO br_evidence, br_rebuild, br_public_read;
-- Incremental maintenance by the owning command transactions.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA evidence_read TO br_evidence;
-- Full rebuild (maintenance only).
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA evidence_read TO br_rebuild;
-- Public read path: the public-safe card only (never evidence state).
GRANT SELECT ON evidence_read.attestation_card TO br_public_read;
