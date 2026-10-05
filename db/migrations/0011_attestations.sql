-- BRT-06 · Attestations: single-use signing ceremonies, immutable signed claims, their exact
-- evidence references and signed retractions; the explicit Person ↔ PERSON Principal mapping; the
-- account → issuer-Principal representation check; the public-key registration ceremony.
--
-- Attestation ≠ Verification. A stored attestation proves only "this registered key signed this
-- exact statement" (cryptographically verified at acceptance). It carries no authority verdict and
-- never changes a Result's lifecycle. Conflicting attestations coexist.
--
-- Table classes: every table here is A (append-only). Challenges are append-only too: their
-- single use is the separate consumption fact (PK = challenge id), never an UPDATE.

-- ─────────────────────────────── Person ↔ PERSON Principal ───────────────────────────────

-- A · Explicit, stable mapping (never Person.id = Principal.id). One PERSON principal per person;
-- the composite FK makes "the mapped principal is of type PERSON" a database fact. Never deleted.
CREATE TABLE identity.person_principal (
  person_id      uuid PRIMARY KEY REFERENCES identity.person (id),
  principal_id   uuid NOT NULL UNIQUE,
  principal_type text NOT NULL DEFAULT 'PERSON' CHECK (principal_type = 'PERSON'),
  recorded_at    timestamptz NOT NULL,
  CHECK (person_id <> principal_id),
  FOREIGN KEY (principal_id, principal_type) REFERENCES authority.principal (id, principal_type)
);
CREATE TRIGGER person_principal_append_only BEFORE UPDATE OR DELETE ON identity.person_principal
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
CREATE TRIGGER person_principal_no_truncate BEFORE TRUNCATE ON identity.person_principal
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();
CREATE TRIGGER person_principal_recorded_at BEFORE INSERT ON identity.person_principal
  FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at();

-- Narrow, transactional creation of a person's PERSON principal (SECURITY DEFINER, like the
-- BRT-04/05 constrained cross-context functions): the identity role gets NO authority-table grant.
-- Only an ACTIVE account with SELF control of the person may create it (a guardian cannot create a
-- dependent's signing principal). Idempotent: returns the existing mapping. The principal fact hash
-- is computed here exactly as `factHash(br:principal@1, {principalId, principalType, label})`
-- (a flat ASCII object, so JCS is its sorted-key JSON; verified against the TypeScript canonicalizer
-- by tests). Output: the principal id only, or NULL when not permitted.
CREATE FUNCTION identity.ensure_person_principal(p_account uuid, p_person uuid) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_principal uuid;
  v_now timestamptz := platform.tx_time_ms();
  v_label constant text := 'person-principal';
  v_hash text;
BEGIN
  IF p_account IS NULL OR p_person IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('account:' || p_account::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('person-principal:' || p_person::text, 0));
  IF NOT EXISTS (
    SELECT 1 FROM identity.account_person_control c
    JOIN identity.v_account_current a ON a.account_id = c.account_id
    WHERE c.account_id = p_account AND c.person_id = p_person AND c.control_kind = 'SELF' AND a.status = 'ACTIVE'
  ) THEN
    RETURN NULL;
  END IF;
  SELECT principal_id INTO v_principal FROM identity.person_principal WHERE person_id = p_person;
  IF v_principal IS NOT NULL THEN
    RETURN v_principal;
  END IF;
  v_principal := uuidv7();
  v_hash := 'sha256:' || encode(sha256(
      convert_to('BR', 'UTF8') || '\x01'::bytea || convert_to('ledger-fact', 'UTF8') || '\x00'::bytea
    || convert_to('br:principal@1', 'UTF8') || '\x00'::bytea || convert_to('br-json/1', 'UTF8') || '\x00'::bytea
    || convert_to('{"label":"' || v_label || '","principalId":"' || v_principal::text || '","principalType":"PERSON"}', 'UTF8')), 'hex');
  INSERT INTO authority.principal (id, principal_type, label, fact_hash, recorded_at)
    VALUES (v_principal, 'PERSON', v_label, v_hash, v_now);
  INSERT INTO identity.person_principal (person_id, principal_id, recorded_at) VALUES (p_person, v_principal, v_now);
  INSERT INTO platform.outbox_event (id, event_type, event_version, aggregate_type, aggregate_id, payload, recorded_at)
    VALUES (uuidv7(), 'PrincipalRegistered', 1, 'PRINCIPAL', v_principal,
            jsonb_build_object('principalType', 'PERSON', 'factHash', v_hash), v_now),
           (uuidv7(), 'PersonPrincipalMapped', 1, 'PRINCIPAL', v_principal,
            jsonb_build_object('principalType', 'PERSON'), v_now);
  RETURN v_principal;
END
$$;
REVOKE ALL ON FUNCTION identity.ensure_person_principal(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.ensure_person_principal(uuid, uuid) TO br_identity;
GRANT SELECT ON identity.person_principal TO br_identity;

-- ─────────────────────────────── issuer representation ───────────────────────────────

-- May this authenticated account act for this Principal in the application? Returns
--   'PERSON_SELF'         the PERSON principal of the account's own SELF person
--   'ORGANIZATION_ADMIN'  an ORGANIZATION principal whose ACTIVE organization has the account's
--                         SELF person as ACTIVE OWNER/ADMIN
-- or NULL. Guardians never represent a dependent's principal; SYSTEM/PLATFORM principals are never
-- representable by an account. This is an APPLICATION permission — it never implies a sporting
-- capability (ATTEST_RESULT…), which only AuthorityGrants carry. Shared advisory locks linearize it
-- with account disabling ('account:') and roster changes ('org-roster:').
CREATE FUNCTION authority.account_principal_representation(p_account uuid, p_principal uuid) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_person uuid;
  v_org uuid;
BEGIN
  IF p_account IS NULL OR p_principal IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('account:' || p_account::text, 0));
  SELECT c.person_id INTO v_person FROM identity.account_person_control c
    JOIN identity.v_account_current a ON a.account_id = c.account_id
    WHERE c.account_id = p_account AND c.control_kind = 'SELF' AND a.status = 'ACTIVE';
  IF v_person IS NULL THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM identity.person_principal WHERE principal_id = p_principal AND person_id = v_person) THEN
    RETURN 'PERSON_SELF';
  END IF;
  SELECT organization_id INTO v_org FROM organizations.organization_principal WHERE principal_id = p_principal;
  IF v_org IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('org-roster:' || v_org::text, 0));
  IF EXISTS (
    SELECT 1 FROM organizations.membership m
    JOIN organizations.v_membership_current mc ON mc.membership_id = m.id
    JOIN organizations.v_organization_current o ON o.organization_id = m.organization_id
    WHERE m.organization_id = v_org AND m.person_id = v_person AND mc.status = 'ACTIVE'
      AND o.status = 'ACTIVE' AND m.membership_role IN ('OWNER', 'ADMIN')
  ) THEN
    RETURN 'ORGANIZATION_ADMIN';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION authority.account_principal_representation(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authority.account_principal_representation(uuid, uuid) TO br_authority, br_evidence;

-- ─────────────────────────────── public-key registration ceremony ───────────────────────────────

-- A · Proof-of-possession challenge for registering a PUBLIC key (never a private key: the
-- material CHECK refuses private JWK members, like authority.principal_key). The key id is
-- pre-allocated and bound into the signed statement; the new key itself must sign it.
CREATE TABLE authority.key_registration_challenge (
  id                    uuid PRIMARY KEY,
  principal_id          uuid NOT NULL REFERENCES authority.principal (id),
  account_id            uuid NOT NULL,
  key_id                uuid NOT NULL UNIQUE,
  key_kind              text NOT NULL CHECK (key_kind = 'JWK'),
  algorithm             text NOT NULL CHECK (algorithm IN ('EdDSA', 'ES256')),
  verification_material jsonb NOT NULL CHECK (
    jsonb_typeof(verification_material) = 'object'
    AND NOT (verification_material ?| ARRAY['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'privateKey',
                                            'private_key', 'secret', 'seed', 'mnemonic'])),
  effective_to          timestamptz,
  statement             jsonb NOT NULL CHECK (jsonb_typeof(statement) = 'object'),
  statement_hash        platform.content_hash NOT NULL UNIQUE,
  nonce                 text NOT NULL UNIQUE CHECK (nonce ~ '^[A-Za-z0-9_-]{22}$'),
  audience              text NOT NULL CHECK (audience ~ '^bragging-rights:[a-z0-9-]{1,32}$'),
  expires_at            timestamptz NOT NULL,
  recorded_at           timestamptz NOT NULL,
  CHECK (expires_at > recorded_at)
);
CREATE TABLE authority.key_registration_consumption (
  challenge_id uuid PRIMARY KEY REFERENCES authority.key_registration_challenge (id),
  outcome      text NOT NULL CHECK (outcome IN ('ACCEPTED', 'REJECTED')),
  reason_code  text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  recorded_at  timestamptz NOT NULL
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['key_registration_challenge', 'key_registration_consumption'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON authority.%I FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON authority.%I FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation()', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON authority.%I FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at()', t || '_recorded_at', t);
    EXECUTE format('GRANT SELECT, INSERT ON authority.%I TO br_authority', t);
  END LOOP;
END
$$;
-- The key-ceremony module records its own audit telemetry.
GRANT INSERT ON platform.audit_event TO br_authority;
GRANT SELECT, INSERT ON platform.command_idempotency TO br_authority;

-- ─────────────────────────────── attestations ───────────────────────────────
CREATE SCHEMA attestation;
REVOKE ALL ON SCHEMA attestation FROM PUBLIC;

-- A · Signing ceremony challenge: the server canonicalized the EXACT statement (nonce, audience,
-- purpose, issuer, key, subject, expiry inside) before anyone signed. Single use = one
-- consumption row. (issuer, nonce) is unique across purposes (BRT-02 §5 replay control).
CREATE TABLE attestation.challenge (
  id                    uuid PRIMARY KEY,
  purpose               text NOT NULL CHECK (purpose IN ('attestation', 'attestation-retraction')),
  account_id            uuid NOT NULL REFERENCES identity.account (id),
  issuer_principal_id   uuid NOT NULL REFERENCES authority.principal (id),
  key_id                uuid NOT NULL REFERENCES authority.principal_key (id),
  target_attestation_id uuid,
  statement             jsonb NOT NULL CHECK (jsonb_typeof(statement) = 'object'),
  statement_hash        platform.content_hash NOT NULL UNIQUE,
  nonce                 text NOT NULL CHECK (nonce ~ '^[A-Za-z0-9_-]{22}$'),
  audience              text NOT NULL CHECK (audience ~ '^bragging-rights:[a-z0-9-]{1,32}$'),
  visibility            text CHECK (visibility IN ('PUBLIC', 'PRIVATE')),
  expires_at            timestamptz NOT NULL,
  recorded_at           timestamptz NOT NULL,
  UNIQUE (issuer_principal_id, nonce),
  CHECK (expires_at > recorded_at),
  CHECK ((purpose = 'attestation') = (target_attestation_id IS NULL)),
  CHECK ((purpose = 'attestation') = (visibility IS NOT NULL))
);

CREATE TABLE attestation.challenge_consumption (
  challenge_id uuid PRIMARY KEY REFERENCES attestation.challenge (id),
  outcome      text NOT NULL CHECK (outcome IN ('ACCEPTED', 'REJECTED', 'ALREADY_RETRACTED')),
  reason_code  text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  recorded_at  timestamptz NOT NULL
);

-- A · Attestation: immutable signed claim. The full canonical statement is stored (re-hashing it
-- reproduces statement_hash); the proof material is stored in full for later re-verification.
-- received_at = issued_at = recorded_at: ONE reading of the database clock in the accepting
-- transaction (BRT-01 issuedAt), which must not be after the signed expiresAt (replay bound).
CREATE TABLE attestation.attestation (
  id                        uuid PRIMARY KEY,
  statement                 jsonb NOT NULL CHECK (jsonb_typeof(statement) = 'object'),
  statement_schema          text NOT NULL CHECK (statement_schema = 'br:attestation-statement@1'),
  statement_hash            platform.content_hash NOT NULL UNIQUE,
  audience                  text NOT NULL,
  issuer_principal_id       uuid NOT NULL REFERENCES authority.principal (id),
  issuer_principal_type     text NOT NULL CHECK (issuer_principal_type IN ('PLATFORM', 'ORGANIZATION', 'PERSON', 'SYSTEM')),
  key_id                    uuid NOT NULL REFERENCES authority.principal_key (id),
  subject_type              text NOT NULL CHECK (subject_type = 'RESULT_VERSION'),
  subject_id                uuid NOT NULL,
  subject_hash              platform.content_hash NOT NULL,
  claim_type                text NOT NULL CHECK (claim_type IN ('RESULT_ACCURATE', 'CONDITIONS_COMPLIANT')),
  polarity                  text NOT NULL CHECK (polarity IN ('AFFIRM', 'DENY')),
  nonce                     text NOT NULL,
  signed_at                 timestamptz NOT NULL,
  expires_at                timestamptz NOT NULL,
  proof_type                text NOT NULL CHECK (proof_type = 'DIRECT_SIGNATURE'),
  proof_scheme              text NOT NULL CHECK (proof_scheme = 'JWS_DETACHED'),
  proof_algorithm           text NOT NULL CHECK (proof_algorithm IN ('EdDSA', 'ES256')),
  proof                     jsonb NOT NULL CHECK (jsonb_typeof(proof) = 'object'),
  verifier_id               text NOT NULL CHECK (verifier_id = 'jws-detached/v1'),
  assurance                 text NOT NULL CHECK (assurance IN ('HOLDER_KEY', 'DEVICE_KEY')),
  challenge_id              uuid NOT NULL UNIQUE REFERENCES attestation.challenge (id),
  submitted_by_account_id   uuid NOT NULL REFERENCES identity.account (id),
  visibility                text NOT NULL CHECK (visibility IN ('PUBLIC', 'PRIVATE')),
  supersedes_attestation_id uuid REFERENCES attestation.attestation (id),
  received_at               timestamptz NOT NULL,
  issued_at                 timestamptz NOT NULL,
  recorded_at               timestamptz NOT NULL,
  UNIQUE (issuer_principal_id, nonce),
  -- One atomic observation: receipt, acceptance (issuedAt) and recording are the SAME database
  -- clock reading of the single accepting transaction (no second clock, no ordering assumption).
  CHECK (received_at = issued_at AND issued_at = recorded_at),
  CHECK (issued_at <= expires_at),
  CHECK (supersedes_attestation_id IS DISTINCT FROM id)
);
CREATE INDEX attestation_subject_idx ON attestation.attestation (subject_type, subject_id);
CREATE INDEX attestation_issuer_idx ON attestation.attestation (issuer_principal_id);

ALTER TABLE attestation.challenge
  ADD CONSTRAINT challenge_target_attestation_fk FOREIGN KEY (target_attestation_id) REFERENCES attestation.attestation (id);

-- A · Exact evidence references of an attestation: (item, content hash, descriptor hash) must be
-- the item's own (composite FK), so a reference can never name one item with another's hashes.
CREATE TABLE attestation.attestation_evidence (
  attestation_id  uuid NOT NULL REFERENCES attestation.attestation (id),
  evidence_id     uuid NOT NULL,
  content_hash    platform.content_hash NOT NULL,
  descriptor_hash platform.content_hash NOT NULL,
  recorded_at     timestamptz NOT NULL,
  PRIMARY KEY (attestation_id, evidence_id),
  FOREIGN KEY (evidence_id, content_hash, descriptor_hash) REFERENCES evidence.item (id, content_hash, descriptor_hash)
);
CREATE INDEX attestation_evidence_item_idx ON attestation.attestation_evidence (evidence_id);

-- A · Signed retraction: the issuer withdrew this exact attestation. The original row is never
-- touched. At most one retraction per attestation. Retracted ≠ false.
CREATE TABLE attestation.retraction (
  id                      uuid PRIMARY KEY,
  attestation_id          uuid NOT NULL UNIQUE REFERENCES attestation.attestation (id),
  statement               jsonb NOT NULL CHECK (jsonb_typeof(statement) = 'object'),
  statement_schema        text NOT NULL CHECK (statement_schema = 'br:attestation-retraction-statement@1'),
  statement_hash          platform.content_hash NOT NULL UNIQUE,
  issuer_principal_id     uuid NOT NULL REFERENCES authority.principal (id),
  key_id                  uuid NOT NULL REFERENCES authority.principal_key (id),
  reason_code             text NOT NULL CHECK (reason_code IN ('ISSUER_ERROR', 'SUPERSEDED_BY_CORRECTION', 'WITHDRAWN', 'OTHER')),
  nonce                   text NOT NULL,
  signed_at               timestamptz NOT NULL,
  expires_at              timestamptz NOT NULL,
  proof_type              text NOT NULL CHECK (proof_type = 'DIRECT_SIGNATURE'),
  proof_scheme            text NOT NULL CHECK (proof_scheme = 'JWS_DETACHED'),
  proof_algorithm         text NOT NULL CHECK (proof_algorithm IN ('EdDSA', 'ES256')),
  proof                   jsonb NOT NULL CHECK (jsonb_typeof(proof) = 'object'),
  verifier_id             text NOT NULL CHECK (verifier_id = 'jws-detached/v1'),
  challenge_id            uuid NOT NULL UNIQUE REFERENCES attestation.challenge (id),
  submitted_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  received_at             timestamptz NOT NULL,
  issued_at               timestamptz NOT NULL,
  recorded_at             timestamptz NOT NULL,
  UNIQUE (issuer_principal_id, nonce),
  -- One atomic observation: receipt, acceptance (issuedAt) and recording are the SAME database
  -- clock reading of the single accepting transaction (no second clock, no ordering assumption).
  CHECK (received_at = issued_at AND issued_at = recorded_at),
  CHECK (issued_at <= expires_at)
);

-- Structural binding checks (SECURITY DEFINER: reads the exact ResultVersion hash).
--  · the stored columns equal the stored statement;
--  · the subject hash is the exact ResultVersion content hash (A-1 / R-5);
--  · the issuer principal type is the principal's real type;
--  · the challenge was consumed as ACCEPTED in this transaction for this exact statement;
--  · a supersession names an earlier attestation of the SAME issuer on the SAME Result.
CREATE FUNCTION attestation.assert_attestation_binding() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  s jsonb := NEW.statement;
  rv jsonb;
  prev record;
BEGIN
  IF s->>'purpose' IS DISTINCT FROM 'attestation'
     OR s->>'audience' IS DISTINCT FROM NEW.audience
     OR s->'issuer'->>'principalId' IS DISTINCT FROM NEW.issuer_principal_id::text
     OR s->'issuer'->>'keyId' IS DISTINCT FROM NEW.key_id::text
     OR s->'subject'->>'type' IS DISTINCT FROM NEW.subject_type
     OR s->'subject'->>'id' IS DISTINCT FROM NEW.subject_id::text
     OR s->'subject'->>'hash' IS DISTINCT FROM NEW.subject_hash::text
     OR s->'claim'->>'type' IS DISTINCT FROM NEW.claim_type
     OR s->'claim'->>'polarity' IS DISTINCT FROM NEW.polarity
     OR s->>'nonce' IS DISTINCT FROM NEW.nonce
     OR (s->>'signedAt')::timestamptz IS DISTINCT FROM NEW.signed_at
     OR (s->>'expiresAt')::timestamptz IS DISTINCT FROM NEW.expires_at
     OR s->'supersedes'->>'attestationId' IS DISTINCT FROM NEW.supersedes_attestation_id::text THEN
    RAISE EXCEPTION 'attestation columns disagree with the signed statement' USING ERRCODE = 'BR070';
  END IF;
  rv := results.resolve_result_version(NEW.subject_id);
  IF rv IS NULL OR rv->>'contentHash' IS DISTINCT FROM NEW.subject_hash::text THEN
    RAISE EXCEPTION 'attestation subject is not an exact ResultVersion' USING ERRCODE = 'BR071';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM authority.principal p WHERE p.id = NEW.issuer_principal_id AND p.principal_type = NEW.issuer_principal_type)
     OR NOT EXISTS (SELECT 1 FROM authority.principal_key k WHERE k.id = NEW.key_id AND k.principal_id = NEW.issuer_principal_id) THEN
    RAISE EXCEPTION 'attestation issuer / key binding is invalid' USING ERRCODE = 'BR072';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM attestation.challenge c JOIN attestation.challenge_consumption u ON u.challenge_id = c.id
    WHERE c.id = NEW.challenge_id AND c.purpose = 'attestation' AND c.statement_hash = NEW.statement_hash
      AND c.issuer_principal_id = NEW.issuer_principal_id AND c.key_id = NEW.key_id
      AND u.outcome = 'ACCEPTED' AND u.recorded_at = NEW.recorded_at) THEN
    RAISE EXCEPTION 'attestation was not accepted through its single-use challenge' USING ERRCODE = 'BR073';
  END IF;
  IF NEW.supersedes_attestation_id IS NOT NULL THEN
    SELECT a.issuer_principal_id, a.statement_hash, (results.resolve_result_version(a.subject_id))->>'resultId' AS result_id
      INTO prev FROM attestation.attestation a WHERE a.id = NEW.supersedes_attestation_id;
    IF prev IS NULL OR prev.issuer_principal_id <> NEW.issuer_principal_id
       OR prev.statement_hash::text IS DISTINCT FROM s->'supersedes'->>'statementHash'
       OR prev.result_id IS DISTINCT FROM rv->>'resultId' THEN
      RAISE EXCEPTION 'an attestation may only supersede an earlier one of the same issuer on the same Result' USING ERRCODE = 'BR074';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION attestation.assert_attestation_binding() FROM PUBLIC;

CREATE FUNCTION attestation.assert_retraction_binding() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  s jsonb := NEW.statement;
  original record;
BEGIN
  SELECT issuer_principal_id, statement_hash INTO original FROM attestation.attestation WHERE id = NEW.attestation_id;
  IF original IS NULL OR original.issuer_principal_id <> NEW.issuer_principal_id THEN
    RAISE EXCEPTION 'only the original issuer can retract an attestation' USING ERRCODE = 'BR075';
  END IF;
  IF s->>'purpose' IS DISTINCT FROM 'attestation-retraction'
     OR s->'issuer'->>'principalId' IS DISTINCT FROM NEW.issuer_principal_id::text
     OR s->'issuer'->>'keyId' IS DISTINCT FROM NEW.key_id::text
     OR s->'subject'->>'type' IS DISTINCT FROM 'ATTESTATION'
     OR s->'subject'->>'id' IS DISTINCT FROM NEW.attestation_id::text
     OR s->'subject'->>'hash' IS DISTINCT FROM original.statement_hash::text
     OR s->>'reasonCode' IS DISTINCT FROM NEW.reason_code
     OR s->>'nonce' IS DISTINCT FROM NEW.nonce
     OR (s->>'signedAt')::timestamptz IS DISTINCT FROM NEW.signed_at
     OR (s->>'expiresAt')::timestamptz IS DISTINCT FROM NEW.expires_at THEN
    RAISE EXCEPTION 'retraction columns disagree with the signed statement' USING ERRCODE = 'BR076';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM attestation.challenge c JOIN attestation.challenge_consumption u ON u.challenge_id = c.id
    WHERE c.id = NEW.challenge_id AND c.purpose = 'attestation-retraction' AND c.statement_hash = NEW.statement_hash
      AND c.target_attestation_id = NEW.attestation_id AND u.outcome = 'ACCEPTED' AND u.recorded_at = NEW.recorded_at) THEN
    RAISE EXCEPTION 'retraction was not accepted through its single-use challenge' USING ERRCODE = 'BR077';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION attestation.assert_evidence_reference() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  s jsonb;
  rec timestamptz;
BEGIN
  SELECT statement, recorded_at INTO s, rec FROM attestation.attestation WHERE id = NEW.attestation_id;
  IF rec IS DISTINCT FROM NEW.recorded_at OR NOT (COALESCE(s->'evidenceRefs', '[]'::jsonb) @> pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('evidenceId', NEW.evidence_id::text, 'contentHash', NEW.content_hash::text,
                                    'descriptorHash', NEW.descriptor_hash::text))) THEN
    RAISE EXCEPTION 'evidence reference is not part of the signed statement' USING ERRCODE = 'BR078';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION attestation.assert_retraction_binding(), attestation.assert_evidence_reference() FROM PUBLIC;

CREATE TRIGGER attestation_binding BEFORE INSERT ON attestation.attestation
  FOR EACH ROW EXECUTE FUNCTION attestation.assert_attestation_binding();
CREATE TRIGGER retraction_binding BEFORE INSERT ON attestation.retraction
  FOR EACH ROW EXECUTE FUNCTION attestation.assert_retraction_binding();
CREATE TRIGGER attestation_evidence_reference BEFORE INSERT ON attestation.attestation_evidence
  FOR EACH ROW EXECUTE FUNCTION attestation.assert_evidence_reference();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['challenge', 'challenge_consumption', 'attestation', 'attestation_evidence', 'retraction'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON attestation.%I FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON attestation.%I FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation()', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON attestation.%I FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at()', t || '_recorded_at', t);
    EXECUTE format('GRANT SELECT, INSERT ON attestation.%I TO br_evidence', t);
    EXECUTE format('GRANT SELECT ON attestation.%I TO br_rebuild', t);
  END LOOP;
END
$$;
GRANT USAGE ON SCHEMA attestation TO br_evidence, br_rebuild;
