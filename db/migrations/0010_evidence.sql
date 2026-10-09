-- BRT-06 · Evidence: content-addressed blob registry, immutable EvidenceItems (descriptor-bound
-- provenance), append-only availability and privacy histories, immutable lineage and attachments.
--
-- Evidence ≠ Attestation ≠ Result ≠ Verification. Nothing here asserts that anything is true.
--
-- Table classes (BRT-02 persistence §3.0): every table in this schema is A (append-only fact):
-- UPDATE / DELETE / TRUNCATE are rejected by triggers for every role, including the owner.
-- There is no hard-delete path: "deletion" of bytes is an availability fact (ADR-0018), and the
-- item, its descriptor and its content hash remain forever.
--
-- No blob credentials, encryption keys, storage paths or URLs live in the database. Blob storage
-- is an application adapter (EvidenceBlobStore); rows keep an opaque backend id and a non-secret
-- key reference only.
CREATE SCHEMA evidence;
REVOKE ALL ON SCHEMA evidence FROM PUBLIC;

-- A · Blob registry: one row per distinct byte sequence (plain SHA-256 of the raw bytes, ADR-0014
-- exception). Inserted only AFTER the adapter has durably stored and re-checked the bytes, so a
-- committed item can never point at bytes that were never persisted.
CREATE TABLE evidence.blob (
  content_hash platform.content_hash PRIMARY KEY,
  byte_length  bigint NOT NULL CHECK (byte_length >= 0),
  backend      text NOT NULL CHECK (backend ~ '^[a-z0-9-]+/v[0-9]+$'),
  key_ref      text NOT NULL CHECK (key_ref ~ '^[A-Za-z0-9._:-]{1,100}$'),
  recorded_at  timestamptz NOT NULL,
  UNIQUE (content_hash, byte_length)
);

-- A · EvidenceItem: provenance over a blob. The same bytes from two sources are two items over one
-- blob (never collapsed). `descriptor` is the normalized BR-JSON descriptor; `descriptor_hash` its
-- domain-separated hash. Columns duplicate descriptor members for indexing and are checked equal.
-- `provenance_key` is the natural key (BRT-02 persistence §7): the same submitter registering the
-- same bytes from the same source/capture/type gets the existing item back.
CREATE TABLE evidence.item (
  id                      uuid PRIMARY KEY,
  descriptor_version      integer NOT NULL CHECK (descriptor_version = 1),
  descriptor              jsonb NOT NULL CHECK (jsonb_typeof(descriptor) = 'object'),
  descriptor_hash         platform.content_hash NOT NULL UNIQUE,
  content_hash            platform.content_hash NOT NULL,
  byte_length             bigint NOT NULL,
  media_type              text NOT NULL CHECK (media_type IN ('application/json', 'application/pdf', 'image/jpeg',
                            'image/png', 'text/csv', 'text/plain', 'video/mp4')),
  evidence_type           text NOT NULL CHECK (evidence_type IN ('SCORING_SYSTEM_EXPORT', 'TIMING_SYSTEM_EXPORT',
                            'SIGNED_SCORESHEET', 'OFFICIAL_REPORT', 'FEDERATION_RECORD', 'PROVIDER_FEED', 'SENSOR_DATA',
                            'VIDEO', 'IMAGE', 'AUDIO', 'DOCUMENT', 'HISTORICAL_ARCHIVE', 'OFFICIATING_SYSTEM_OUTPUT',
                            'AI_DERIVED', 'MANUAL_ENTRY')),
  -- No TRUSTED / VERIFIED kind exists: the source kind is data, trust is decided later (BRT-07).
  source_kind             text NOT NULL CHECK (source_kind IN ('HUMAN', 'ORGANIZATION', 'DEVICE', 'SCORING_SYSTEM',
                            'TIMING_SYSTEM', 'EXTERNAL_API', 'HISTORICAL_ARCHIVE', 'AI_PIPELINE')),
  source_principal_id     uuid REFERENCES authority.principal (id),
  submitted_by_account_id uuid REFERENCES identity.account (id),
  -- Source assertion (BRT-02 §5.1); platform-observed receipt time; database transaction time.
  -- received_at and recorded_at are two SEPARATE readings of the database clock (receipt before
  -- the blob write, recording in the metadata transaction). No ordering between them is enforced:
  -- it is not guaranteed if the clock steps, and neither value is ever rewritten to force one.
  captured_at             timestamptz,
  received_at             timestamptz NOT NULL,
  initial_privacy_class   text NOT NULL CHECK (initial_privacy_class IN ('PLATFORM_PRIVATE', 'AUTHORITY_ONLY')),
  provenance_key          platform.content_hash NOT NULL UNIQUE,
  recorded_at             timestamptz NOT NULL,
  FOREIGN KEY (content_hash, byte_length) REFERENCES evidence.blob (content_hash, byte_length),
  -- Lets attestation references bind (id, content hash, descriptor hash) together by FK.
  UNIQUE (id, content_hash, descriptor_hash)
);
CREATE INDEX item_content_hash_idx ON evidence.item (content_hash);
CREATE INDEX item_submitter_idx ON evidence.item (submitted_by_account_id);

-- The hashed descriptor and the indexed columns can never disagree.
CREATE FUNCTION evidence.assert_item_consistency() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  d jsonb := NEW.descriptor;
BEGIN
  IF d->>'evidenceId' IS DISTINCT FROM NEW.id::text
     OR d->>'evidenceType' IS DISTINCT FROM NEW.evidence_type
     OR d->'content'->>'sha256' IS DISTINCT FROM NEW.content_hash::text
     OR (d->'content'->>'byteLength')::bigint IS DISTINCT FROM NEW.byte_length
     OR d->'content'->>'mediaType' IS DISTINCT FROM NEW.media_type
     OR d->'source'->>'kind' IS DISTINCT FROM NEW.source_kind
     OR d->'source'->>'principalId' IS DISTINCT FROM NEW.source_principal_id::text
     OR (d->'source'->>'capturedAt')::timestamptz IS DISTINCT FROM NEW.captured_at
     OR (d->'acquisition'->>'receivedAt')::timestamptz IS DISTINCT FROM NEW.received_at THEN
    RAISE EXCEPTION 'evidence item columns disagree with its descriptor' USING ERRCODE = 'BR060';
  END IF;
  IF NEW.evidence_type = 'AI_DERIVED' AND jsonb_array_length(COALESCE(d->'derivation'->'inputs', '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'AI-derived evidence must reference its input evidence (BRT-01 E-4)' USING ERRCODE = 'BR061';
  END IF;
  RETURN NEW;
END
$$;

-- A · Availability (ADR-0018; BRT-02 ingestion §2.4). The first fact of every item is
-- (∅ → AVAILABLE); later facts must start from the current status and follow the implemented
-- transitions. DELETED_* are terminal: the bytes are gone, the item and its hashes are not.
CREATE TABLE evidence.availability_change (
  id               uuid PRIMARY KEY,
  evidence_id      uuid NOT NULL REFERENCES evidence.item (id),
  from_status      text CHECK (from_status IN ('AVAILABLE', 'ARCHIVED', 'RESTRICTED', 'EXPIRED', 'DELETED_BY_RETENTION', 'DELETED_BY_ERASURE')),
  to_status        text NOT NULL CHECK (to_status IN ('AVAILABLE', 'ARCHIVED', 'RESTRICTED', 'EXPIRED', 'DELETED_BY_RETENTION', 'DELETED_BY_ERASURE')),
  reason_code      text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  -- Opaque reference to a legal basis / decision record (never free text, never PII).
  basis_ref        text CHECK (basis_ref IS NULL OR basis_ref ~ '^[A-Za-z0-9:._/-]{1,200}$'),
  actor_account_id uuid,
  fact_hash        platform.content_hash NOT NULL,
  recorded_at      timestamptz NOT NULL,
  seq              bigint GENERATED ALWAYS AS IDENTITY,
  CHECK (from_status IS DISTINCT FROM to_status)
);
CREATE INDEX availability_change_item_idx ON evidence.availability_change (evidence_id, seq DESC);

CREATE FUNCTION evidence.assert_availability_transition() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cur text;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('evidence:' || NEW.evidence_id::text, 0));
  SELECT to_status INTO cur FROM evidence.availability_change WHERE evidence_id = NEW.evidence_id ORDER BY seq DESC LIMIT 1;
  IF cur IS NULL THEN
    IF NEW.from_status IS NOT NULL OR NEW.to_status <> 'AVAILABLE' THEN
      RAISE EXCEPTION 'the first availability fact must be AVAILABLE' USING ERRCODE = 'BR062';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.from_status IS DISTINCT FROM cur OR NOT (
       (cur = 'AVAILABLE' AND NEW.to_status IN ('RESTRICTED', 'DELETED_BY_RETENTION', 'DELETED_BY_ERASURE'))
    OR (cur = 'RESTRICTED' AND NEW.to_status IN ('AVAILABLE', 'DELETED_BY_RETENTION', 'DELETED_BY_ERASURE'))) THEN
    RAISE EXCEPTION 'availability transition % → % is not permitted', cur, NEW.to_status USING ERRCODE = 'BR062';
  END IF;
  RETURN NEW;
END
$$;

-- A · Privacy class history (BRT-01 DB-5: can only be RAISED without the rights holder).
CREATE TABLE evidence.privacy_change (
  id               uuid PRIMARY KEY,
  evidence_id      uuid NOT NULL REFERENCES evidence.item (id),
  from_class       text CHECK (from_class IN ('PLATFORM_PRIVATE', 'AUTHORITY_ONLY')),
  to_class         text NOT NULL CHECK (to_class IN ('PLATFORM_PRIVATE', 'AUTHORITY_ONLY')),
  actor_account_id uuid,
  fact_hash        platform.content_hash NOT NULL,
  recorded_at      timestamptz NOT NULL,
  seq              bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX privacy_change_item_idx ON evidence.privacy_change (evidence_id, seq DESC);

CREATE FUNCTION evidence.assert_privacy_raise() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cur text;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('evidence:' || NEW.evidence_id::text, 0));
  SELECT to_class INTO cur FROM evidence.privacy_change WHERE evidence_id = NEW.evidence_id ORDER BY seq DESC LIMIT 1;
  IF cur IS NULL THEN
    IF NEW.from_class IS NOT NULL THEN
      RAISE EXCEPTION 'the first privacy fact has no previous class' USING ERRCODE = 'BR063';
    END IF;
  ELSIF NEW.from_class IS DISTINCT FROM cur OR NOT (cur = 'PLATFORM_PRIVATE' AND NEW.to_class = 'AUTHORITY_ONLY') THEN
    RAISE EXCEPTION 'evidence privacy can only be raised' USING ERRCODE = 'BR063';
  END IF;
  RETURN NEW;
END
$$;

-- A · Lineage (child → parent). A derived / redacted / transcoded / extracted artefact is always a
-- NEW item; the original is never modified (BRT-01 E-1). Each edge must be declared inside the
-- child's hashed descriptor and name the parent's exact descriptor hash, and parents always predate
-- children (so lineage is acyclic by construction).
CREATE TABLE evidence.relation (
  evidence_id             uuid NOT NULL REFERENCES evidence.item (id),
  relation                text NOT NULL CHECK (relation IN ('DERIVED_FROM', 'REDACTED_FROM', 'TRANSFORMED_FROM', 'SUPERSEDES')),
  related_evidence_id     uuid NOT NULL REFERENCES evidence.item (id),
  related_descriptor_hash platform.content_hash NOT NULL,
  recorded_at             timestamptz NOT NULL,
  PRIMARY KEY (evidence_id, related_evidence_id, relation),
  CHECK (evidence_id <> related_evidence_id)
);
CREATE INDEX relation_related_idx ON evidence.relation (related_evidence_id);

CREATE FUNCTION evidence.assert_relation_declared() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  child_descriptor jsonb;
  child_recorded timestamptz;
  parent_hash text;
  parent_recorded timestamptz;
BEGIN
  SELECT descriptor, recorded_at INTO child_descriptor, child_recorded FROM evidence.item WHERE id = NEW.evidence_id;
  SELECT descriptor_hash, recorded_at INTO parent_hash, parent_recorded FROM evidence.item WHERE id = NEW.related_evidence_id;
  IF parent_hash IS DISTINCT FROM NEW.related_descriptor_hash::text THEN
    RAISE EXCEPTION 'lineage edge names the wrong parent descriptor hash' USING ERRCODE = 'BR064';
  END IF;
  IF child_recorded <> NEW.recorded_at OR parent_recorded > child_recorded THEN
    RAISE EXCEPTION 'lineage is recorded with the child and parents predate it' USING ERRCODE = 'BR064';
  END IF;
  IF NOT (COALESCE(child_descriptor->'lineage', '[]'::jsonb) @> pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'relation', NEW.relation, 'evidenceId', NEW.related_evidence_id::text, 'descriptorHash', NEW.related_descriptor_hash::text))) THEN
    RAISE EXCEPTION 'lineage edge is not declared in the child descriptor' USING ERRCODE = 'BR064';
  END IF;
  RETURN NEW;
END
$$;

-- ─────────────────────────────── narrow cross-context read helpers ───────────────────────────────

-- Exact ResultVersion identity for evidence/attestation binding (SECURITY DEFINER: the evidence
-- role gets no results table grants and can never write results). Returns public-safe ids and
-- hashes only, or NULL (callers fail closed).
CREATE FUNCTION results.resolve_result_version(p_id uuid) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.jsonb_build_object(
    'resultVersionId', v.id, 'resultId', v.result_id, 'versionNumber', v.version_number,
    'contentHash', v.content_hash, 'contentSchema', v.content_schema,
    'scopeType', r.scope_type, 'scopeTargetId', r.scope_target_id)
  FROM results.result_version v JOIN results.result r ON r.id = v.result_id
  WHERE v.id = p_id
$$;
REVOKE ALL ON FUNCTION results.resolve_result_version(uuid) FROM PUBLIC;

-- Application (never authority) roles an account holds on a competition: explicit ACTIVE staff
-- roles of its SELF person, plus OWNER/ADMIN of the ACTIVE organizer organization (mapped as in
-- @br/competition ORGANIZER_ROLE_TO_STAFF_ROLE). Returns role codes only; a DISABLED account or an
-- account without a SELF person holds none.
CREATE FUNCTION competition.account_competition_roles(p_account uuid, p_competition uuid) RETURNS text[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH me AS (
    SELECT c.person_id FROM identity.account_person_control c
    JOIN identity.v_account_current a ON a.account_id = c.account_id
    WHERE c.account_id = p_account AND c.control_kind = 'SELF' AND a.status = 'ACTIVE'
  ), roles AS (
    SELECT s.staff_role AS r FROM competition.competition_staff s
    JOIN competition.v_staff_current v ON v.staff_id = s.id
    WHERE s.competition_id = p_competition AND s.person_id IN (SELECT person_id FROM me) AND v.status = 'ACTIVE'
    UNION
    SELECT m.membership_role FROM competition.competition comp
    JOIN organizations.membership m ON m.organization_id = comp.organizer_organization_id
    JOIN organizations.v_membership_current mc ON mc.membership_id = m.id
    JOIN organizations.v_organization_current o ON o.organization_id = m.organization_id
    WHERE comp.id = p_competition AND m.person_id IN (SELECT person_id FROM me)
      AND mc.status = 'ACTIVE' AND o.status = 'ACTIVE' AND m.membership_role IN ('OWNER', 'ADMIN')
  )
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT r ORDER BY r), '{}') FROM roles
$$;
REVOKE ALL ON FUNCTION competition.account_competition_roles(uuid, uuid) FROM PUBLIC;

-- A · Attachment: "this evidence has been associated with this sporting object" — NEVER "this
-- evidence proves the object is correct". The target must exist; its competition (resolved from
-- the immutable hierarchy, never from client input) is stored for access decisions.
CREATE TABLE evidence.attachment (
  id                     uuid PRIMARY KEY,
  evidence_id            uuid NOT NULL REFERENCES evidence.item (id),
  target_type            text NOT NULL CHECK (target_type IN ('RESULT_VERSION', 'CONTEST', 'EVENT')),
  target_id              uuid NOT NULL,
  role                   text NOT NULL CHECK (role IN ('PRIMARY', 'SUPPORTING', 'CONTEXT')),
  competition_id         uuid NOT NULL,
  attached_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  fact_hash              platform.content_hash NOT NULL,
  recorded_at            timestamptz NOT NULL,
  UNIQUE (evidence_id, target_type, target_id, role)
);
CREATE INDEX attachment_target_idx ON evidence.attachment (target_type, target_id);

-- Cross-target integrity (SECURITY DEFINER so the check can read results/competition facts that
-- the evidence role cannot): the target exists and `competition_id` is its true competition.
CREATE FUNCTION evidence.assert_attachment_target() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  path jsonb;
  rv jsonb;
BEGIN
  IF NEW.target_type = 'RESULT_VERSION' THEN
    rv := results.resolve_result_version(NEW.target_id);
    IF rv IS NULL THEN
      RAISE EXCEPTION 'attachment target does not exist' USING ERRCODE = 'BR065';
    END IF;
    path := competition.resolve_scope_path(
      CASE rv->>'scopeType' WHEN 'CONTEST' THEN 'CONTEST' WHEN 'ROUND_CLASSIFICATION' THEN 'ROUND'
                            WHEN 'EVENT_CLASSIFICATION' THEN 'EVENT' ELSE 'COMPETITION' END,
      (rv->>'scopeTargetId')::uuid);
  ELSE
    path := competition.resolve_scope_path(NEW.target_type, NEW.target_id);
  END IF;
  IF path IS NULL OR (path->>'competitionId')::uuid IS DISTINCT FROM NEW.competition_id THEN
    RAISE EXCEPTION 'attachment target is not in the stated competition hierarchy' USING ERRCODE = 'BR065';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION evidence.assert_attachment_target() FROM PUBLIC;

CREATE TRIGGER item_consistency BEFORE INSERT ON evidence.item
  FOR EACH ROW EXECUTE FUNCTION evidence.assert_item_consistency();
CREATE TRIGGER availability_transition BEFORE INSERT ON evidence.availability_change
  FOR EACH ROW EXECUTE FUNCTION evidence.assert_availability_transition();
CREATE TRIGGER privacy_raise BEFORE INSERT ON evidence.privacy_change
  FOR EACH ROW EXECUTE FUNCTION evidence.assert_privacy_raise();
CREATE TRIGGER relation_declared BEFORE INSERT ON evidence.relation
  FOR EACH ROW EXECUTE FUNCTION evidence.assert_relation_declared();
CREATE TRIGGER attachment_target BEFORE INSERT ON evidence.attachment
  FOR EACH ROW EXECUTE FUNCTION evidence.assert_attachment_target();

-- No function of this module is executable by PUBLIC (trigger functions cannot be called directly,
-- and EXECUTE is only checked when a trigger is created — revoked anyway for least privilege).
REVOKE ALL ON FUNCTION evidence.assert_item_consistency(), evidence.assert_availability_transition(),
  evidence.assert_privacy_raise(), evidence.assert_relation_declared() FROM PUBLIC;

CREATE VIEW evidence.v_availability_current AS
  SELECT DISTINCT ON (evidence_id) evidence_id, to_status AS status, recorded_at, seq
  FROM evidence.availability_change ORDER BY evidence_id, seq DESC;
CREATE VIEW evidence.v_privacy_current AS
  SELECT DISTINCT ON (evidence_id) evidence_id, to_class AS privacy_class, recorded_at, seq
  FROM evidence.privacy_change ORDER BY evidence_id, seq DESC;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['blob', 'item', 'availability_change', 'privacy_change', 'relation', 'attachment'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON evidence.%I FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON evidence.%I FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation()', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON evidence.%I FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at()', t || '_recorded_at', t);
    EXECUTE format('GRANT SELECT, INSERT ON evidence.%I TO br_evidence', t);
    -- Projection rebuild reads metadata only (never bytes; no blob credentials in the database).
    EXECUTE format('GRANT SELECT ON evidence.%I TO br_rebuild', t);
  END LOOP;
END
$$;

-- ─────────────────────────────── grants ───────────────────────────────
GRANT USAGE ON SCHEMA evidence TO br_evidence, br_rebuild;
GRANT SELECT ON evidence.v_availability_current, evidence.v_privacy_current TO br_evidence, br_rebuild;
-- Platform plumbing: ledger (EVIDENCE_ITEM / ATTESTATION streams), outbox, idempotency, audit.
GRANT USAGE ON SCHEMA platform TO br_evidence;
GRANT EXECUTE ON FUNCTION platform.tx_time_ms() TO br_evidence;
GRANT SELECT, INSERT ON platform.ledger_entry TO br_evidence;
GRANT SELECT, INSERT, UPDATE ON platform.stream_head TO br_evidence;
GRANT SELECT, INSERT ON platform.outbox_event TO br_evidence;
GRANT SELECT, INSERT ON platform.command_idempotency TO br_evidence;
GRANT INSERT ON platform.audit_event TO br_evidence;
-- Read-only authority facts needed to verify signatures and describe keys (never writes; never
-- grants, anchors or authority decisions).
GRANT USAGE ON SCHEMA authority TO br_evidence;
GRANT SELECT ON authority.principal, authority.principal_key, authority.principal_key_status_change TO br_evidence;
-- Account status only (public-safe: id + ACTIVE/DISABLED) so a disabled account acts on nothing.
GRANT USAGE ON SCHEMA identity TO br_evidence;
GRANT SELECT ON identity.v_account_current TO br_evidence;
-- Organization Principal mapping (public-safe ids) for issuer labels.
GRANT USAGE ON SCHEMA organizations TO br_evidence;
GRANT SELECT ON organizations.organization_principal TO br_evidence, br_rebuild;
-- Narrow cross-context read helpers (EXECUTE only; no results/competition/identity table grants).
GRANT USAGE ON SCHEMA results, competition TO br_evidence;
GRANT EXECUTE ON FUNCTION results.resolve_result_version(uuid) TO br_evidence, br_rebuild;
GRANT EXECUTE ON FUNCTION competition.resolve_scope_path(text, uuid) TO br_evidence, br_rebuild;
GRANT EXECUTE ON FUNCTION competition.account_competition_roles(uuid, uuid) TO br_evidence;
