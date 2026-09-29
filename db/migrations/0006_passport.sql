-- BRT-04 · Athlete Passport read model (class B projection). NOT a source of truth: every row is
-- derived from identity/organizations tables and can be rebuilt by the maintenance login
-- (br_rebuild) without any access to identity_private. Contains public-safe data only.
CREATE SCHEMA passport;
REVOKE ALL ON SCHEMA passport FROM PUBLIC;

CREATE TABLE passport.athlete_card (
  athlete_id         uuid PRIMARY KEY,
  slug               text NOT NULL,
  display_name       text NOT NULL,
  short_bio          text,
  home_country       text,
  avatar_ref         text,
  preferred_sports   text[] NOT NULL,
  profile_visibility text NOT NULL CHECK (profile_visibility IN ('PUBLIC', 'AUTHENTICATED', 'PRIVATE')),
  -- Dependents are restricted by default; the reason is never exposed publicly.
  restricted         boolean NOT NULL,
  athlete_status     text NOT NULL,
  canonical_athlete_id uuid,
  source_updated_at  timestamptz NOT NULL
);
CREATE UNIQUE INDEX athlete_card_slug ON passport.athlete_card (slug);

-- All slugs ever claimed by visible athletes (current + former) → redirects without link breakage.
CREATE TABLE passport.athlete_slug (
  slug       text PRIMARY KEY,
  athlete_id uuid NOT NULL
);
CREATE INDEX passport_athlete_slug_athlete_idx ON passport.athlete_slug (athlete_id);

-- Affiliations: ACTIVE memberships with PUBLIC visibility and an athlete-facing role.
CREATE TABLE passport.affiliation (
  membership_id    uuid PRIMARY KEY,
  athlete_id       uuid NOT NULL,
  organization_id  uuid NOT NULL,
  membership_role  text NOT NULL,
  since            timestamptz NOT NULL
);
CREATE INDEX affiliation_athlete_idx ON passport.affiliation (athlete_id);
CREATE INDEX affiliation_org_idx ON passport.affiliation (organization_id);

-- External identities with PUBLIC visibility and not REVOKED.
CREATE TABLE passport.external_identity (
  external_identity_id   uuid PRIMARY KEY,
  athlete_id             uuid NOT NULL,
  namespace              text NOT NULL,
  issuer_organization_id uuid,
  external_value         text NOT NULL,
  status                 text NOT NULL CHECK (status IN ('CLAIMED', 'CONFIRMED'))
);
CREATE INDEX passport_ext_athlete_idx ON passport.external_identity (athlete_id);

-- Wallet links with PUBLIC visibility and ACTIVE status.
CREATE TABLE passport.wallet (
  wallet_link_id uuid PRIMARY KEY,
  athlete_id     uuid NOT NULL,
  network        text NOT NULL,
  address        text NOT NULL,
  proof_status   text NOT NULL CHECK (proof_status IN ('VERIFIED', 'TEST_VERIFIED'))
);
CREATE INDEX passport_wallet_athlete_idx ON passport.wallet (athlete_id);

GRANT USAGE ON SCHEMA passport TO br_identity, br_organizations, br_rebuild, br_public_read;
-- Incremental maintenance by the owning command transactions.
--   identity commands refresh an athlete's whole passport (card, affiliations, identities, wallets);
--   organization commands refresh only the affiliations of the athlete a membership concerns.
GRANT SELECT, INSERT, UPDATE, DELETE ON passport.athlete_card, passport.athlete_slug, passport.affiliation, passport.external_identity, passport.wallet TO br_identity;
GRANT SELECT, INSERT, UPDATE, DELETE ON passport.affiliation TO br_organizations;
GRANT SELECT ON passport.athlete_card TO br_organizations;
-- Full rebuild (maintenance only).
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA passport TO br_rebuild;
-- Public read path.
GRANT SELECT ON ALL TABLES IN SCHEMA passport TO br_public_read;
