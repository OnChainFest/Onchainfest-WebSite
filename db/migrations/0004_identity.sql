-- BRT-04 · Identity: Account, AuthIdentity, Person, Athlete, AthleteProfile, slugs, guardian
-- relationships, external identities, wallet links (proof of control), duplicate-resolution
-- foundation; the isolated PII vault (identity_private); platform audit log.
--
-- Table classes (BRT-02 persistence §3.0):
--   A  append-only facts / status histories (no UPDATE/DELETE/TRUNCATE; triggers)
--   OP mutable operational state (audited where sensitive)
-- Status histories: current status = latest row per entity by `seq` (views v_*_current).
-- Identity lifecycle streams are not in the BRT-02 §5.2 hash-chained stream list; they are
-- append-only but not chained in BRT-04 (see docs/implementation/BRT-04-IDENTITY.md).

-- ─────────────────────────────── platform additions ───────────────────────────────

-- Accountability telemetry (BRT-02 system architecture §12). Never sporting truth.
-- `details` must never contain PII (ids, statuses and field NAMES only).
CREATE TABLE platform.audit_event (
  id               uuid PRIMARY KEY,
  actor_account_id uuid,
  action           text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  target_type      text NOT NULL,
  target_id        uuid,
  outcome          text NOT NULL CHECK (outcome IN ('SUCCEEDED', 'DENIED', 'FAILED')),
  details          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  recorded_at      timestamptz NOT NULL
);
CREATE TRIGGER audit_event_append_only BEFORE UPDATE OR DELETE ON platform.audit_event
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON platform.audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();
CREATE TRIGGER audit_event_recorded_at BEFORE INSERT ON platform.audit_event
  FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at();

GRANT USAGE ON SCHEMA platform TO br_identity, br_identity_private, br_organizations, br_public_read;
GRANT EXECUTE ON FUNCTION platform.tx_time_ms() TO br_identity, br_identity_private, br_organizations, br_public_read;
GRANT SELECT, INSERT ON platform.outbox_event TO br_identity, br_organizations;
GRANT SELECT, INSERT ON platform.command_idempotency TO br_identity, br_identity_private, br_organizations;
GRANT INSERT ON platform.audit_event TO br_identity, br_identity_private, br_organizations;

-- ─────────────────────────────── identity (public-safe) ───────────────────────────────
CREATE SCHEMA identity;
REVOKE ALL ON SCHEMA identity FROM PUBLIC;

CREATE FUNCTION identity.normalized_slug_ok(slug text) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS $$
    SELECT slug ~ '^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$' AND slug !~ '--'
  $$;

-- A · Account: access to the application. Not a human being; no email here.
CREATE TABLE identity.account (
  id          uuid PRIMARY KEY,
  recorded_at timestamptz NOT NULL
);
CREATE TABLE identity.account_status_change (
  id               uuid PRIMARY KEY,
  account_id       uuid NOT NULL REFERENCES identity.account (id),
  status           text NOT NULL CHECK (status IN ('ACTIVE', 'DISABLED')),
  reason           text CHECK (reason IS NULL OR length(reason) <= 500),
  actor_account_id uuid,
  recorded_at      timestamptz NOT NULL,
  seq              bigint GENERATED ALWAYS AS IDENTITY
);

-- A · AuthIdentity: (provider, provider_subject) is the stable authentication identity.
CREATE TABLE identity.auth_identity (
  id               uuid PRIMARY KEY,
  account_id       uuid NOT NULL REFERENCES identity.account (id),
  provider         text NOT NULL CHECK (provider ~ '^[a-z0-9][a-z0-9:._-]{1,99}$'),
  provider_subject text NOT NULL CHECK (length(provider_subject) BETWEEN 1 AND 255),
  email_verified   boolean,
  recorded_at      timestamptz NOT NULL,
  UNIQUE (provider, provider_subject)
);
-- OP · last authentication time (mutable convenience).
CREATE TABLE identity.auth_identity_activity (
  auth_identity_id      uuid PRIMARY KEY REFERENCES identity.auth_identity (id),
  last_authenticated_at timestamptz NOT NULL
);

-- A · Person: a natural person. Existence only — every private attribute lives in identity_private.
CREATE TABLE identity.person (
  id                    uuid PRIMARY KEY,
  created_by_account_id uuid REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL
);

-- A · Account → Person control. BRT-04 implements SELF only; GUARDIAN control is derived from
-- an ACTIVE (confirmed) guardian relationship + the guardian's SELF control (see policies).
CREATE TABLE identity.account_person_control (
  id           uuid PRIMARY KEY,
  account_id   uuid NOT NULL REFERENCES identity.account (id),
  person_id    uuid NOT NULL REFERENCES identity.person (id),
  control_kind text NOT NULL CHECK (control_kind = 'SELF'),
  recorded_at  timestamptz NOT NULL
);
-- One human per account and one self-controlling account per person.
CREATE UNIQUE INDEX account_person_control_self_person ON identity.account_person_control (person_id) WHERE control_kind = 'SELF';
CREATE UNIQUE INDEX account_person_control_self_account ON identity.account_person_control (account_id) WHERE control_kind = 'SELF';

-- A · Athlete: durable sports identity (never email, wallet, username or license number).
-- BRT-04 invariant (strict): every athlete belongs to exactly one Person. Imported/unclaimed
-- athletes (no person) do not exist yet; ingestion will introduce them with an explicit model.
CREATE TABLE identity.athlete (
  id          uuid PRIMARY KEY,
  person_id   uuid NOT NULL REFERENCES identity.person (id),
  recorded_at timestamptz NOT NULL
);
-- Zero or one athlete identity per person (BRT-04).
CREATE UNIQUE INDEX athlete_one_per_person ON identity.athlete (person_id);
CREATE TABLE identity.athlete_status_change (
  id               uuid PRIMARY KEY,
  athlete_id       uuid NOT NULL REFERENCES identity.athlete (id),
  status           text NOT NULL CHECK (status IN ('ACTIVE', 'DEACTIVATED')),
  reason           text CHECK (reason IS NULL OR length(reason) <= 500),
  actor_account_id uuid,
  recorded_at      timestamptz NOT NULL,
  seq              bigint GENERATED ALWAYS AS IDENTITY
);

-- A · Duplicate-resolution foundation: an athlete id may be resolved to a canonical athlete.
-- Historical references (results, memberships) are never rewritten; readers resolve the chain.
CREATE TABLE identity.athlete_identity_resolution (
  id                     uuid PRIMARY KEY,
  athlete_id             uuid NOT NULL UNIQUE REFERENCES identity.athlete (id),
  canonical_athlete_id   uuid NOT NULL REFERENCES identity.athlete (id),
  reason                 text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  actor_account_id       uuid,
  recorded_at            timestamptz NOT NULL,
  CHECK (athlete_id <> canonical_athlete_id)
);

-- OP · AthleteProfile: self-described, mutable, never sporting truth.
CREATE TABLE identity.athlete_profile (
  athlete_id         uuid PRIMARY KEY REFERENCES identity.athlete (id),
  display_name       text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  short_bio          text CHECK (short_bio IS NULL OR length(short_bio) <= 500),
  home_country       text CHECK (home_country IS NULL OR home_country ~ '^[A-Z]{2}$'),
  avatar_ref         text CHECK (avatar_ref IS NULL OR avatar_ref ~ '^media:[0-9a-f-]{36}$'),
  preferred_sports   text[] NOT NULL DEFAULT '{}' CHECK (cardinality(preferred_sports) <= 10),
  profile_visibility text NOT NULL CHECK (profile_visibility IN ('PUBLIC', 'AUTHENTICATED', 'PRIVATE')),
  updated_at         timestamptz NOT NULL,
  updated_by_account_id uuid
);

-- A · Slug claims (history). Current slug = latest claim per athlete. Old slugs stay reserved to
-- the same athlete forever and redirect (no link breakage, no link hijacking).
CREATE TABLE identity.athlete_slug (
  slug        text PRIMARY KEY CHECK (identity.normalized_slug_ok(slug)),
  athlete_id  uuid NOT NULL REFERENCES identity.athlete (id),
  recorded_at timestamptz NOT NULL,
  seq         bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX athlete_slug_athlete_idx ON identity.athlete_slug (athlete_id, seq DESC);

-- A · Guardian relationships: asserted (PENDING) until confirmed (ACTIVE).
CREATE TABLE identity.guardian_relationship (
  id                     uuid PRIMARY KEY,
  guardian_person_id     uuid NOT NULL REFERENCES identity.person (id),
  dependent_person_id    uuid NOT NULL REFERENCES identity.person (id),
  relationship_kind      text NOT NULL CHECK (relationship_kind IN ('PARENT', 'LEGAL_GUARDIAN', 'OTHER_RESPONSIBLE_ADULT')),
  asserted_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  evidence_ref           text CHECK (evidence_ref IS NULL OR length(evidence_ref) <= 200),
  effective_from         timestamptz NOT NULL,
  recorded_at            timestamptz NOT NULL,
  CHECK (guardian_person_id <> dependent_person_id),
  CHECK (effective_from >= recorded_at)
);
CREATE TABLE identity.guardian_relationship_status_change (
  id                     uuid PRIMARY KEY,
  guardian_relationship_id uuid NOT NULL REFERENCES identity.guardian_relationship (id),
  status                 text NOT NULL CHECK (status IN ('PENDING', 'ACTIVE', 'REVOKED', 'ENDED')),
  confirmation_basis     text CHECK (confirmation_basis IS NULL OR confirmation_basis IN ('PLATFORM_REVIEW', 'ORGANIZATION_CONFIRMED', 'DEPENDENT_CONFIRMED')),
  reason                 text CHECK (reason IS NULL OR length(reason) <= 500),
  actor_account_id       uuid,
  recorded_at            timestamptz NOT NULL,
  seq                    bigint GENERATED ALWAYS AS IDENTITY,
  CHECK (status <> 'ACTIVE' OR confirmation_basis IS NOT NULL)
);

-- A · External identities (federation licenses, provider ids…). CLAIMED ≠ CONFIRMED.
CREATE TABLE identity.external_identity (
  id                     uuid PRIMARY KEY,
  athlete_id             uuid NOT NULL REFERENCES identity.athlete (id),
  issuer_organization_id uuid,
  namespace              text NOT NULL CHECK (namespace ~ '^[a-z0-9][a-z0-9:._-]{1,99}$'),
  external_value         text NOT NULL CHECK (length(external_value) BETWEEN 1 AND 200),
  visibility             text NOT NULL CHECK (visibility IN ('PUBLIC', 'PRIVATE')),
  claimed_by_account_id  uuid NOT NULL REFERENCES identity.account (id),
  effective_from         timestamptz NOT NULL,
  recorded_at            timestamptz NOT NULL,
  CHECK (effective_from >= recorded_at)
);
CREATE INDEX external_identity_key_idx ON identity.external_identity (namespace, issuer_organization_id, external_value);
CREATE TABLE identity.external_identity_status_change (
  id                    uuid PRIMARY KEY,
  external_identity_id  uuid NOT NULL REFERENCES identity.external_identity (id),
  status                text NOT NULL CHECK (status IN ('CLAIMED', 'CONFIRMED', 'REVOKED')),
  confirmed_by_organization_id uuid,
  actor_account_id      uuid,
  reason                text CHECK (reason IS NULL OR length(reason) <= 500),
  recorded_at           timestamptz NOT NULL,
  seq                   bigint GENERATED ALWAYS AS IDENTITY,
  CHECK (status <> 'CONFIRMED' OR confirmed_by_organization_id IS NOT NULL)
);

-- A · Wallet proof-of-control challenges (single use, expiring) and their consumption.
CREATE TABLE identity.wallet_link_challenge (
  id          uuid PRIMARY KEY,
  person_id   uuid NOT NULL REFERENCES identity.person (id),
  account_id  uuid NOT NULL REFERENCES identity.account (id),
  network     text NOT NULL CHECK (network ~ '^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$'),
  address     text NOT NULL CHECK (length(address) BETWEEN 3 AND 128),
  visibility  text NOT NULL CHECK (visibility IN ('PUBLIC', 'PRIVATE')),
  nonce       text NOT NULL UNIQUE CHECK (length(nonce) >= 16),
  purpose     text NOT NULL CHECK (purpose = 'wallet-link'),
  -- Proof scheme chosen at challenge time; verification dispatches on (network family, scheme).
  -- BRT-04 schemes are EVM-only: eip155:<chainId> networks and normalized (lower-case) addresses.
  proof_scheme text NOT NULL CHECK (proof_scheme IN ('eip191-personal-sign', 'test-signature')),
  audience    text NOT NULL,
  message     text NOT NULL,
  expires_at  timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  CHECK (expires_at > recorded_at),
  CHECK (network ~ '^eip155:[1-9][0-9]{0,31}$' AND address ~ '^0x[0-9a-f]{40}$')
);
CREATE TABLE identity.wallet_link_challenge_consumption (
  challenge_id uuid PRIMARY KEY REFERENCES identity.wallet_link_challenge (id),
  outcome      text NOT NULL CHECK (outcome IN ('VERIFIED', 'REJECTED')),
  verifier_id  text NOT NULL,
  recorded_at  timestamptz NOT NULL
);

-- A · Wallet links exist only after a successful proof. Address ≠ person ≠ athlete.
-- proof_status TEST_VERIFIED marks links proven by the development/test verifier; it is never
-- presented as a production proof. Private keys / seeds / mnemonics are never stored.
CREATE TABLE identity.wallet_link (
  id           uuid PRIMARY KEY,
  person_id    uuid NOT NULL REFERENCES identity.person (id),
  network      text NOT NULL,
  address      text NOT NULL,
  challenge_id uuid NOT NULL UNIQUE REFERENCES identity.wallet_link_challenge (id),
  verifier_id  text NOT NULL,
  proof_status text NOT NULL CHECK (proof_status IN ('VERIFIED', 'TEST_VERIFIED')),
  proof_scheme text NOT NULL CHECK (proof_scheme IN ('eip191-personal-sign', 'test-signature')),
  -- The accepted signature over the challenge message (public data; re-verifiable at any time).
  proof_signature text NOT NULL CHECK (length(proof_signature) BETWEEN 1 AND 1000),
  visibility   text NOT NULL CHECK (visibility IN ('PUBLIC', 'PRIVATE')),
  recorded_at  timestamptz NOT NULL,
  -- A test-scheme proof is TEST_VERIFIED and nothing else; only the production scheme yields VERIFIED.
  CHECK ((proof_scheme = 'test-signature') = (proof_status = 'TEST_VERIFIED'))
);
CREATE INDEX wallet_link_address_idx ON identity.wallet_link (network, lower(address));
CREATE TABLE identity.wallet_link_status_change (
  id               uuid PRIMARY KEY,
  wallet_link_id   uuid NOT NULL REFERENCES identity.wallet_link (id),
  status           text NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  actor_account_id uuid,
  reason           text CHECK (reason IS NULL OR length(reason) <= 500),
  recorded_at      timestamptz NOT NULL,
  seq              bigint GENERATED ALWAYS AS IDENTITY
);

-- Current-status views.
CREATE VIEW identity.v_account_current AS
  SELECT DISTINCT ON (account_id) account_id, status, recorded_at FROM identity.account_status_change ORDER BY account_id, seq DESC;
CREATE VIEW identity.v_athlete_current AS
  SELECT DISTINCT ON (athlete_id) athlete_id, status, recorded_at FROM identity.athlete_status_change ORDER BY athlete_id, seq DESC;
CREATE VIEW identity.v_athlete_slug_current AS
  SELECT DISTINCT ON (athlete_id) athlete_id, slug, recorded_at FROM identity.athlete_slug ORDER BY athlete_id, seq DESC;
CREATE VIEW identity.v_guardian_relationship_current AS
  SELECT DISTINCT ON (guardian_relationship_id) guardian_relationship_id, status, confirmation_basis, recorded_at
  FROM identity.guardian_relationship_status_change ORDER BY guardian_relationship_id, seq DESC;
CREATE VIEW identity.v_external_identity_current AS
  SELECT DISTINCT ON (external_identity_id) external_identity_id, status, confirmed_by_organization_id, recorded_at
  FROM identity.external_identity_status_change ORDER BY external_identity_id, seq DESC;
CREATE VIEW identity.v_wallet_link_current AS
  SELECT DISTINCT ON (wallet_link_id) wallet_link_id, status, recorded_at FROM identity.wallet_link_status_change ORDER BY wallet_link_id, seq DESC;

-- Append-only enforcement + recorded_at integrity on every class A table.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['account', 'account_status_change', 'auth_identity', 'person', 'account_person_control',
                           'athlete', 'athlete_status_change', 'athlete_identity_resolution', 'athlete_slug',
                           'guardian_relationship', 'guardian_relationship_status_change', 'external_identity',
                           'external_identity_status_change', 'wallet_link_challenge', 'wallet_link_challenge_consumption',
                           'wallet_link', 'wallet_link_status_change'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON identity.%I FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON identity.%I FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation()', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON identity.%I FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at()', t || '_recorded_at', t);
    EXECUTE format('GRANT SELECT, INSERT ON identity.%I TO br_identity', t);
  END LOOP;
END
$$;

GRANT USAGE ON SCHEMA identity TO br_identity, br_organizations, br_rebuild;
GRANT EXECUTE ON FUNCTION identity.normalized_slug_ok(text) TO br_identity;
GRANT SELECT, INSERT, UPDATE ON identity.athlete_profile, identity.auth_identity_activity TO br_identity;
GRANT SELECT ON identity.v_account_current, identity.v_athlete_current, identity.v_athlete_slug_current,
  identity.v_guardian_relationship_current, identity.v_external_identity_current, identity.v_wallet_link_current TO br_identity;
-- Organizations resolve person → athlete (affiliations) and account → person (who acts);
-- read-only, public-safe tables only. (External-identity confirmation is an identity-context
-- command that checks the issuer organization's application permission.)
GRANT SELECT ON identity.athlete, identity.v_athlete_current, identity.account_person_control,
  identity.v_account_current, identity.guardian_relationship, identity.v_guardian_relationship_current TO br_organizations;
-- Passport rebuild reads public-safe identity sources only (never identity_private).
GRANT SELECT ON identity.athlete, identity.athlete_status_change, identity.athlete_profile, identity.athlete_slug,
  identity.guardian_relationship, identity.guardian_relationship_status_change,
  identity.external_identity, identity.external_identity_status_change,
  identity.wallet_link, identity.wallet_link_status_change, identity.athlete_identity_resolution,
  identity.v_athlete_current, identity.v_athlete_slug_current, identity.v_guardian_relationship_current,
  identity.v_external_identity_current, identity.v_wallet_link_current TO br_rebuild;

-- ─────────────────────────────── identity_private (PII vault) ───────────────────────────────
-- Only br_identity_private (assumable solely by the br_api_vault login) can touch this schema.
-- Values are stored as encrypted envelopes produced by the application PII cipher port.
CREATE SCHEMA identity_private;
REVOKE ALL ON SCHEMA identity_private FROM PUBLIC;

CREATE TABLE identity_private.person_private (
  person_id          uuid PRIMARY KEY REFERENCES identity.person (id),
  legal_name_enc     jsonb CHECK (legal_name_enc IS NULL OR jsonb_typeof(legal_name_enc) = 'object'),
  date_of_birth_enc  jsonb CHECK (date_of_birth_enc IS NULL OR jsonb_typeof(date_of_birth_enc) = 'object'),
  email_enc          jsonb CHECK (email_enc IS NULL OR jsonb_typeof(email_enc) = 'object'),
  phone_enc          jsonb CHECK (phone_enc IS NULL OR jsonb_typeof(phone_enc) = 'object'),
  cipher_key_id      text NOT NULL,
  erased_at          timestamptz,
  updated_at         timestamptz NOT NULL,
  CHECK (erased_at IS NULL OR (legal_name_enc IS NULL AND date_of_birth_enc IS NULL AND email_enc IS NULL AND phone_enc IS NULL))
);

GRANT USAGE ON SCHEMA identity_private TO br_identity_private;
GRANT SELECT, INSERT, UPDATE ON identity_private.person_private TO br_identity_private;

-- Vault authorization, evaluated INSIDE the vault transaction (no check-then-use window).
-- SECURITY DEFINER (owner: migration owner) so br_identity_private needs no identity grants; it
-- returns a boolean only. It takes SHARED advisory locks on the keys that identity commands take
-- EXCLUSIVELY when they change control facts (account status: 'account:<id>'; guardian status:
-- 'person-control:<dependent id>'), so a vault operation and a revocation are linearized: the
-- vault operation either completes before the revocation commits, or waits and then sees it.
-- Each statement in this VOLATILE function takes a fresh snapshot (READ COMMITTED), so the
-- control query runs after the locks are held. Private data is SELF-only (guardians never).
CREATE FUNCTION identity_private.authorize_private_data(p_account_id uuid, p_person_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_account_id IS NULL OR p_person_id IS NULL THEN
    RETURN false;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('account:' || p_account_id::text, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('person-control:' || p_person_id::text, 0));
  RETURN EXISTS (
    SELECT 1
    FROM identity.account_person_control c
    JOIN identity.v_account_current a ON a.account_id = c.account_id
    WHERE c.account_id = p_account_id
      AND c.person_id = p_person_id
      AND c.control_kind = 'SELF'
      AND a.status = 'ACTIVE');
END
$$;
REVOKE ALL ON FUNCTION identity_private.authorize_private_data(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity_private.authorize_private_data(uuid, uuid) TO br_identity_private;
