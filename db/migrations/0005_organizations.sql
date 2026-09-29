-- BRT-04 · Organizations: stable identity, public profile, slugs, explicit ORGANIZATION Principal
-- mapping, operational memberships (application permissions only — never sports authority)
-- and invitation tokens (hashed, expiring, single use).
CREATE SCHEMA organizations;
REVOKE ALL ON SCHEMA organizations FROM PUBLIC;

-- A · Organization. TEAM is intentionally NOT a type: BRT-01 defines Team as a competition
-- identity (persistent side or ad-hoc pair); see docs/implementation/BRT-04-ORGANIZATIONS.md.
-- `org_type` is descriptive only: FEDERATION does not confer any authority (TrustAnchor does).
CREATE TABLE organizations.organization (
  id                    uuid PRIMARY KEY,
  org_type              text NOT NULL CHECK (org_type IN ('FEDERATION', 'GOVERNING_BODY', 'LEAGUE', 'CLUB', 'ACADEMY',
                          'EVENT_ORGANIZER', 'VENUE', 'SPONSOR', 'BRAND', 'SERVICE_PROVIDER', 'OTHER')),
  created_by_account_id uuid NOT NULL REFERENCES identity.account (id),
  recorded_at           timestamptz NOT NULL
);
CREATE TABLE organizations.organization_status_change (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations.organization (id),
  status           text NOT NULL CHECK (status IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  reason           text CHECK (reason IS NULL OR length(reason) <= 500),
  actor_account_id uuid,
  recorded_at      timestamptz NOT NULL,
  seq              bigint GENERATED ALWAYS AS IDENTITY
);

-- A · Explicit mapping to the ORGANIZATION Principal (never the same id). Closing or deleting a
-- public profile never removes this mapping or the principal's authority history.
-- The composite FK makes "the mapped principal is of type ORGANIZATION" a database fact
-- (additive index on authority.principal; BRT-03 migrations are not modified).
CREATE UNIQUE INDEX principal_id_type ON authority.principal (id, principal_type);
CREATE TABLE organizations.organization_principal (
  organization_id uuid PRIMARY KEY REFERENCES organizations.organization (id),
  principal_id    uuid NOT NULL UNIQUE,
  principal_type  text NOT NULL DEFAULT 'ORGANIZATION' CHECK (principal_type = 'ORGANIZATION'),
  recorded_at     timestamptz NOT NULL,
  CHECK (organization_id <> principal_id),
  FOREIGN KEY (principal_id, principal_type) REFERENCES authority.principal (id, principal_type)
);

-- Every organization has its principal mapping at commit time (exactly one: PK above). A deferred
-- constraint trigger, so creation can insert the organization first within the same transaction.
CREATE FUNCTION organizations.assert_organization_principal() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organizations.organization_principal WHERE organization_id = NEW.id) THEN
    RAISE EXCEPTION 'organization % has no ORGANIZATION principal mapping', NEW.id USING ERRCODE = 'BR002';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER organization_requires_principal
  AFTER INSERT ON organizations.organization
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION organizations.assert_organization_principal();

-- OP · Public profile (self-described; implies no recognition or authority).
CREATE TABLE organizations.organization_profile (
  organization_id  uuid PRIMARY KEY REFERENCES organizations.organization (id),
  display_name     text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  description      text CHECK (description IS NULL OR length(description) <= 2000),
  website          text CHECK (website IS NULL OR website ~ '^https://[^\s<>"]{3,250}$'),
  logo_ref         text CHECK (logo_ref IS NULL OR logo_ref ~ '^media:[0-9a-f-]{36}$'),
  country          text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  region           text CHECK (region IS NULL OR region ~ '^[A-Z]{2}-[A-Z0-9]{1,3}$'),
  public_contact   text CHECK (public_contact IS NULL OR length(public_contact) <= 200),
  updated_at       timestamptz NOT NULL,
  updated_by_account_id uuid
);

-- A · Slug history (same semantics as athlete slugs).
CREATE TABLE organizations.organization_slug (
  slug            text PRIMARY KEY CHECK (identity.normalized_slug_ok(slug)),
  organization_id uuid NOT NULL REFERENCES organizations.organization (id),
  recorded_at     timestamptz NOT NULL,
  seq             bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX organization_slug_org_idx ON organizations.organization_slug (organization_id, seq DESC);

-- A · Membership: operational relationship Person ↔ Organization. The role is immutable per
-- membership row; a role change ends the membership and starts a new one (history preserved).
CREATE TABLE organizations.membership (
  id                    uuid PRIMARY KEY,
  organization_id       uuid NOT NULL REFERENCES organizations.organization (id),
  person_id             uuid NOT NULL REFERENCES identity.person (id),
  membership_role       text NOT NULL CHECK (membership_role IN ('OWNER', 'ADMIN', 'MEMBER', 'ATHLETE', 'COACH', 'OFFICIAL', 'STAFF')),
  visibility            text NOT NULL CHECK (visibility IN ('PUBLIC', 'MEMBERS', 'PRIVATE')),
  invited_by_account_id uuid REFERENCES identity.account (id),
  effective_from        timestamptz NOT NULL,
  recorded_at           timestamptz NOT NULL,
  CHECK (effective_from >= recorded_at)
);
CREATE INDEX membership_org_idx ON organizations.membership (organization_id);
CREATE INDEX membership_person_idx ON organizations.membership (person_id);
CREATE TABLE organizations.membership_status_change (
  id               uuid PRIMARY KEY,
  membership_id    uuid NOT NULL REFERENCES organizations.membership (id),
  status           text NOT NULL CHECK (status IN ('INVITED', 'ACTIVE', 'DECLINED', 'SUSPENDED', 'ENDED')),
  actor_account_id uuid,
  reason           text CHECK (reason IS NULL OR length(reason) <= 500),
  recorded_at      timestamptz NOT NULL,
  seq              bigint GENERATED ALWAYS AS IDENTITY
);

-- A · Invitation tokens: only a SHA-256 hash of the secret is stored; single use; expiring.
CREATE TABLE organizations.invitation (
  id            uuid PRIMARY KEY,
  membership_id uuid NOT NULL UNIQUE REFERENCES organizations.membership (id),
  token_hash    text NOT NULL UNIQUE CHECK (token_hash ~ '^sha256:[0-9a-f]{64}$'),
  expires_at    timestamptz NOT NULL,
  recorded_at   timestamptz NOT NULL,
  CHECK (expires_at > recorded_at)
);
CREATE TABLE organizations.invitation_consumption (
  invitation_id uuid PRIMARY KEY REFERENCES organizations.invitation (id),
  outcome       text NOT NULL CHECK (outcome IN ('ACCEPTED', 'DECLINED')),
  recorded_at   timestamptz NOT NULL
);

CREATE VIEW organizations.v_organization_current AS
  SELECT DISTINCT ON (organization_id) organization_id, status, recorded_at
  FROM organizations.organization_status_change ORDER BY organization_id, seq DESC;
CREATE VIEW organizations.v_organization_slug_current AS
  SELECT DISTINCT ON (organization_id) organization_id, slug, recorded_at
  FROM organizations.organization_slug ORDER BY organization_id, seq DESC;
CREATE VIEW organizations.v_membership_current AS
  SELECT DISTINCT ON (membership_id) membership_id, status, recorded_at
  FROM organizations.membership_status_change ORDER BY membership_id, seq DESC;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organization', 'organization_status_change', 'organization_principal', 'organization_slug',
                           'membership', 'membership_status_change', 'invitation', 'invitation_consumption'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON organizations.%I FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON organizations.%I FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation()', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON organizations.%I FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at()', t || '_recorded_at', t);
    EXECUTE format('GRANT SELECT, INSERT ON organizations.%I TO br_organizations', t);
  END LOOP;
END
$$;

GRANT USAGE ON SCHEMA organizations TO br_organizations, br_identity, br_rebuild, br_public_read;
GRANT SELECT, INSERT, UPDATE ON organizations.organization_profile TO br_organizations;
GRANT EXECUTE ON FUNCTION identity.normalized_slug_ok(text) TO br_organizations;
GRANT SELECT ON organizations.v_organization_current, organizations.v_organization_slug_current,
  organizations.v_membership_current TO br_organizations;
-- Creating an organization registers its ORGANIZATION principal in the same transaction:
-- a narrow cross-context write (principal rows only; no grants, anchors or keys).
GRANT USAGE ON SCHEMA authority TO br_organizations;
GRANT SELECT, INSERT ON authority.principal TO br_organizations;
-- Identity reads organization membership to compute application permissions and passports.
GRANT SELECT ON organizations.organization, organizations.membership, organizations.membership_status_change,
  organizations.v_membership_current, organizations.v_organization_current TO br_identity;
-- Passport rebuild (maintenance) reads public-safe organization sources.
GRANT SELECT ON organizations.organization, organizations.organization_profile, organizations.membership,
  organizations.membership_status_change, organizations.organization_status_change, organizations.organization_slug,
  organizations.v_membership_current, organizations.v_organization_current, organizations.v_organization_slug_current TO br_rebuild;
-- Public read path: public organization profile and current slug/status only (no memberships
-- table: public affiliations are served from the passport projection).
GRANT SELECT ON organizations.organization, organizations.organization_profile, organizations.organization_slug,
  organizations.v_organization_current, organizations.v_organization_slug_current TO br_public_read;
