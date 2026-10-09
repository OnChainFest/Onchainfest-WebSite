-- ONCF-02 · Organization branding and sports on the public organization profile.
-- Adds three nullable/defaulted columns to organizations.organization_profile (the mutable, public
-- profile row; 0005). No new table, role, grant, trigger or function; 0001–0030 are untouched.
-- Existing table-level grants cover the new columns: br_organizations writes them through
-- OrganizationStore.updateProfile (ORG_EDIT_PROFILE), br_public_read serves them publicly.
--
-- logo_url     · an https image URL chosen by the organization (no upload: there is no production
--                object store yet). Rendered without a referrer.
-- accent_color · brand colour for the public page and the organization area (#rrggbb, lowercase).
-- sports       · free-text sports the organization runs (same shape as athlete preferred_sports).

ALTER TABLE organizations.organization_profile
  ADD COLUMN logo_url text
    CHECK (logo_url IS NULL OR (length(logo_url) <= 500 AND logo_url ~ '^https://[^[:space:]<>"]+$')),
  ADD COLUMN accent_color text
    CHECK (accent_color IS NULL OR accent_color ~ '^#[0-9a-f]{6}$'),
  ADD COLUMN sports text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(sports) <= 10);
