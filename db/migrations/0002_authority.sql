-- BRT-03 · Authority context: principals, keys, trust anchors, authority grants and their
-- append-only status histories (BRT-01 verification model §4; BRT-02 identity & authority §4–6).
-- All tables here are class A (append-only). Current state is derived by the engine.
CREATE SCHEMA authority;
REVOKE ALL ON SCHEMA authority FROM PUBLIC;

-- Effective-time rule (BRT-02 §5.1 rules 3–4; BRT-03R): an online authority fact is platform-
-- recorded, so its effective time may equal or follow the trusted transaction time
-- (recorded_at) but never precede it. There is NO clock-skew tolerance here: skew applies only
-- to externally supplied signer/device timestamps (signedAt), never to authority effective time.
-- Compromise declarations are the single, explicit retroactive exception.

CREATE TABLE authority.principal (
  id             uuid PRIMARY KEY,
  principal_type text NOT NULL CHECK (principal_type IN ('PLATFORM', 'ORGANIZATION', 'PERSON', 'SYSTEM')),
  label          text NOT NULL CHECK (length(label) BETWEEN 1 AND 500),
  fact_hash      platform.content_hash NOT NULL,
  recorded_at    timestamptz NOT NULL
);
COMMENT ON COLUMN authority.principal.label IS 'Non-PII operational label. Person PII lives in the future identity vault.';

CREATE TABLE authority.principal_key (
  id                    uuid PRIMARY KEY,
  principal_id          uuid NOT NULL REFERENCES authority.principal (id),
  key_kind              text NOT NULL CHECK (key_kind IN ('WALLET', 'PASSKEY', 'JWK', 'DEVICE', 'KMS')),
  algorithm             text NOT NULL CHECK (algorithm IN ('ES256', 'ES256K', 'EdDSA', 'RS256')),
  -- Public verification material only. Private JWK members and seed/mnemonic fields are refused.
  verification_material jsonb NOT NULL CHECK (
    jsonb_typeof(verification_material) = 'object'
    AND NOT (verification_material ?| ARRAY['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'privateKey',
                                            'private_key', 'secret', 'seed', 'mnemonic'])),
  effective_from        timestamptz NOT NULL,
  effective_to          timestamptz,
  fact_hash             platform.content_hash NOT NULL,
  recorded_at           timestamptz NOT NULL,
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (effective_from >= recorded_at)
);

CREATE TABLE authority.principal_key_status_change (
  id                       uuid PRIMARY KEY,
  key_id                   uuid NOT NULL REFERENCES authority.principal_key (id),
  kind                     text NOT NULL CHECK (kind IN ('ROTATED', 'REVOKED', 'COMPROMISED')),
  effective_from           timestamptz NOT NULL,
  compromised_since        timestamptz,
  reason                   text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  declared_by_principal_id uuid REFERENCES authority.principal (id),
  fact_hash                platform.content_hash NOT NULL,
  recorded_at              timestamptz NOT NULL,
  -- Rotation/revocation are prospective; compromise is retroactive (BRT-02 §5.1 rules 4–5).
  CHECK (
    (kind = 'COMPROMISED' AND compromised_since IS NOT NULL AND effective_from = compromised_since
       AND compromised_since <= recorded_at)
    OR (kind <> 'COMPROMISED' AND compromised_since IS NULL AND effective_from >= recorded_at)
  )
);

CREATE TABLE authority.trust_anchor (
  id                      uuid PRIMARY KEY,
  principal_id            uuid NOT NULL REFERENCES authority.principal (id),
  recognition_scope       jsonb NOT NULL CHECK (jsonb_typeof(recognition_scope -> 'recognitionLevel') = 'array'),
  basis_ref               text NOT NULL,
  governance_decision_ref text NOT NULL,
  effective_from          timestamptz NOT NULL,
  effective_to            timestamptz,
  fact_hash               platform.content_hash NOT NULL UNIQUE,
  recorded_at             timestamptz NOT NULL,
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (effective_from >= recorded_at)
);

-- The PLATFORM principal may only anchor the PLATFORM level, and nobody else may claim it
-- (BRT-01 §4.2; BRT-02 identity & authority §6). Enforced in the database as well as the engine.
CREATE FUNCTION authority.check_anchor_level() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  ptype text;
  platform_only boolean;
BEGIN
  SELECT principal_type INTO ptype FROM authority.principal WHERE id = NEW.principal_id;
  platform_only := NEW.recognition_scope -> 'recognitionLevel' = '["PLATFORM"]'::jsonb;
  IF ptype = 'PLATFORM' AND NOT platform_only THEN
    RAISE EXCEPTION 'the PLATFORM principal may only be anchored at recognition level PLATFORM'
      USING ERRCODE = 'BR010';
  END IF;
  IF ptype <> 'PLATFORM' AND NEW.recognition_scope -> 'recognitionLevel' ? 'PLATFORM' THEN
    RAISE EXCEPTION 'only the PLATFORM principal may be anchored at recognition level PLATFORM'
      USING ERRCODE = 'BR010';
  END IF;
  RETURN NEW;
END
$$;

CREATE TABLE authority.trust_anchor_status_change (
  id             uuid PRIMARY KEY,
  anchor_id      uuid NOT NULL REFERENCES authority.trust_anchor (id),
  kind           text NOT NULL CHECK (kind = 'REVOKED'),
  effective_from timestamptz NOT NULL,
  reason         text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  fact_hash      platform.content_hash NOT NULL,
  recorded_at    timestamptz NOT NULL,
  CHECK (effective_from >= recorded_at)
);

CREATE TABLE authority.authority_grant (
  id                   uuid PRIMARY KEY,
  grantor_principal_id uuid NOT NULL REFERENCES authority.principal (id),
  grantee_principal_id uuid NOT NULL REFERENCES authority.principal (id),
  parent_grant_id      uuid REFERENCES authority.authority_grant (id),
  capabilities         text[] NOT NULL CHECK (
                         cardinality(capabilities) > 0
                         AND capabilities <@ ARRAY['SUBMIT_RESULT', 'ACCEPT_RESULT', 'DECLARE_OFFICIAL',
                           'REVOKE_RESULT', 'ELEVATED_REVOKE', 'CORRECT_RESULT', 'ELEVATED_CORRECT',
                           'ATTEST_RESULT', 'ATTEST_CONDITIONS', 'ATTEST_IDENTITY', 'ATTEST_ELIGIBILITY',
                           'SANCTION', 'RATIFY_RECORD', 'ADJUDICATE_DISPUTE', 'APPEAL_ADJUDICATE',
                           'ASSESS_EVIDENCE', 'GRANT_AUTHORITY']::text[]),
  scope                jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'object'),
  delegation           jsonb NOT NULL CHECK (jsonb_typeof(delegation) = 'object'),
  constraints          jsonb NOT NULL CHECK (jsonb_typeof(constraints) = 'object'),
  effective_from       timestamptz NOT NULL,
  effective_to         timestamptz,
  grant_hash           platform.content_hash NOT NULL UNIQUE,
  -- BRT-02 signature envelope (ADR-0015). Structure only in BRT-03; verification in BRT-04.
  grantor_signature    jsonb CHECK (grantor_signature IS NULL OR jsonb_typeof(grantor_signature) = 'object'),
  recorded_at          timestamptz NOT NULL,
  CHECK (grantor_principal_id <> grantee_principal_id),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  -- No retroactive grants (BRT-02 §5.1 rule 3): strict, no skew.
  CHECK (effective_from >= recorded_at)
);
CREATE INDEX authority_grant_grantee_idx ON authority.authority_grant (grantee_principal_id);

CREATE FUNCTION authority.check_grant_parent() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_grant_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM authority.authority_grant p
    WHERE p.id = NEW.parent_grant_id AND p.grantee_principal_id = NEW.grantor_principal_id
  ) THEN
    RAISE EXCEPTION 'parent grant must be held by the grantor' USING ERRCODE = 'BR011';
  END IF;
  RETURN NEW;
END
$$;

CREATE TABLE authority.authority_grant_status_change (
  id                       uuid PRIMARY KEY,
  grant_id                 uuid NOT NULL REFERENCES authority.authority_grant (id),
  kind                     text NOT NULL CHECK (kind = 'REVOKED'),
  compromise               boolean NOT NULL,
  effective_from           timestamptz NOT NULL,
  reason                   text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  declared_by_principal_id uuid REFERENCES authority.principal (id),
  fact_hash                platform.content_hash NOT NULL,
  recorded_at              timestamptz NOT NULL,
  CHECK ((compromise AND effective_from <= recorded_at)
         OR (NOT compromise AND effective_from >= recorded_at))
);

CREATE TRIGGER trust_anchor_level BEFORE INSERT ON authority.trust_anchor
  FOR EACH ROW EXECUTE FUNCTION authority.check_anchor_level();
CREATE TRIGGER authority_grant_parent BEFORE INSERT ON authority.authority_grant
  FOR EACH ROW EXECUTE FUNCTION authority.check_grant_parent();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['principal', 'principal_key', 'principal_key_status_change', 'trust_anchor',
                           'trust_anchor_status_change', 'authority_grant', 'authority_grant_status_change'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON authority.%I FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON authority.%I FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation()', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON authority.%I FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at()', t || '_recorded_at', t);
    EXECUTE format('GRANT SELECT, INSERT ON authority.%I TO br_authority', t);
    -- Other modules read authority facts to authorize their own commands (shared read, BRT-02 §3.2).
    EXECUTE format('GRANT SELECT ON authority.%I TO br_results', t);
  END LOOP;
END
$$;

GRANT USAGE ON SCHEMA authority TO br_authority, br_results;
