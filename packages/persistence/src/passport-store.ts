import {
  AFFILIATION_ROLES,
  assemblePassport,
  isPassportVisible,
  isPublicAttribute,
  slugLookupKey,
  type AthletePassportV1,
  type AttributeVisibility,
  type MembershipRole,
  type OrganizationType,
  type PassportSource,
  type TestProofPolicy,
  type ProfileVisibility,
  type Viewer,
  type WalletProofStatus,
} from '@br/identity';
import { sql } from 'kysely';
import type { Db } from './db';
import { inTransaction, ModuleRole, type TxContext } from './tx';

/**
 * Athlete Passport projection (class B). Every row is derived from identity/organizations tables
 * and holds public-safe data only; nothing here is read from identity_private.
 *
 *   refreshAthletePassport  identity commands (br_identity): card, identities, wallets, affiliations
 *   refreshAffiliations     identity or organization commands: affiliations of one athlete
 *   rebuildPassports        maintenance login (br_rebuild): truncate + re-derive everything
 */

/** A person with any PENDING or ACTIVE guardian relationship is a dependent: restricted by default. */
async function isRestricted(ctx: TxContext, personId: string): Promise<boolean> {
  const { rows } = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM identity.guardian_relationship g
    JOIN identity.v_guardian_relationship_current c ON c.guardian_relationship_id = g.id
    WHERE g.dependent_person_id = ${personId} AND c.status IN ('PENDING', 'ACTIVE')`.execute(
    ctx.trx,
  );
  return (rows[0]?.n ?? 0) > 0;
}

export async function refreshAthletePassport(ctx: TxContext, athleteId: string): Promise<void> {
  const { rows } = await sql<{
    person_id: string;
    status: string;
    slug: string;
    display_name: string;
    short_bio: string | null;
    home_country: string | null;
    avatar_ref: string | null;
    preferred_sports: string[];
    profile_visibility: ProfileVisibility;
    updated_at: Date;
  }>`
    SELECT a.person_id, s.status, sl.slug, p.display_name, p.short_bio, p.home_country, p.avatar_ref,
           p.preferred_sports, p.profile_visibility, p.updated_at
    FROM identity.athlete a
    JOIN identity.v_athlete_current s ON s.athlete_id = a.id
    JOIN identity.v_athlete_slug_current sl ON sl.athlete_id = a.id
    JOIN identity.athlete_profile p ON p.athlete_id = a.id
    WHERE a.id = ${athleteId}`.execute(ctx.trx);
  const a = rows[0];
  await sql`DELETE FROM passport.external_identity WHERE athlete_id = ${athleteId}`.execute(
    ctx.trx,
  );
  await sql`DELETE FROM passport.wallet WHERE athlete_id = ${athleteId}`.execute(ctx.trx);
  await sql`DELETE FROM passport.athlete_slug WHERE athlete_id = ${athleteId}`.execute(ctx.trx);
  if (a === undefined) {
    await sql`DELETE FROM passport.affiliation WHERE athlete_id = ${athleteId}`.execute(ctx.trx);
    await sql`DELETE FROM passport.athlete_card WHERE athlete_id = ${athleteId}`.execute(ctx.trx);
    return;
  }
  const restricted = await isRestricted(ctx, a.person_id);
  const { rows: canonical } = await sql<{ canonical_athlete_id: string }>`
    SELECT canonical_athlete_id FROM identity.athlete_identity_resolution WHERE athlete_id = ${athleteId}`.execute(
    ctx.trx,
  );
  await sql`
    INSERT INTO passport.athlete_card (athlete_id, slug, display_name, short_bio, home_country, avatar_ref, preferred_sports,
      profile_visibility, restricted, athlete_status, canonical_athlete_id, source_updated_at)
    VALUES (${athleteId}, ${a.slug}, ${a.display_name}, ${a.short_bio}, ${a.home_country}, ${a.avatar_ref}, ${a.preferred_sports},
      ${a.profile_visibility}, ${restricted}, ${a.status}, ${canonical[0]?.canonical_athlete_id ?? null}, ${a.updated_at})
    ON CONFLICT (athlete_id) DO UPDATE SET slug = EXCLUDED.slug, display_name = EXCLUDED.display_name,
      short_bio = EXCLUDED.short_bio, home_country = EXCLUDED.home_country, avatar_ref = EXCLUDED.avatar_ref,
      preferred_sports = EXCLUDED.preferred_sports, profile_visibility = EXCLUDED.profile_visibility,
      restricted = EXCLUDED.restricted, athlete_status = EXCLUDED.athlete_status,
      canonical_athlete_id = EXCLUDED.canonical_athlete_id, source_updated_at = EXCLUDED.source_updated_at`.execute(
    ctx.trx,
  );
  await sql`INSERT INTO passport.athlete_slug (slug, athlete_id)
    SELECT slug, athlete_id FROM identity.athlete_slug WHERE athlete_id = ${athleteId}`.execute(
    ctx.trx,
  );

  const { rows: ext } = await sql<{
    id: string;
    namespace: string;
    issuer_organization_id: string | null;
    external_value: string;
    visibility: AttributeVisibility;
    status: string;
  }>`
    SELECT e.id, e.namespace, e.issuer_organization_id, e.external_value, e.visibility, c.status
    FROM identity.external_identity e JOIN identity.v_external_identity_current c ON c.external_identity_id = e.id
    WHERE e.athlete_id = ${athleteId}`.execute(ctx.trx);
  for (const e of ext) {
    if (e.status === 'REVOKED' || !isPublicAttribute(e.visibility, restricted)) continue;
    await sql`INSERT INTO passport.external_identity (external_identity_id, athlete_id, namespace, issuer_organization_id, external_value, status)
      VALUES (${e.id}, ${athleteId}, ${e.namespace}, ${e.issuer_organization_id}, ${e.external_value}, ${e.status})`.execute(
      ctx.trx,
    );
  }

  if (a.person_id !== null) {
    const { rows: wallets } = await sql<{
      id: string;
      network: string;
      address: string;
      proof_status: WalletProofStatus;
      visibility: AttributeVisibility;
      status: string;
    }>`
      SELECT w.id, w.network, w.address, w.proof_status, w.visibility, c.status
      FROM identity.wallet_link w JOIN identity.v_wallet_link_current c ON c.wallet_link_id = w.id
      WHERE w.person_id = ${a.person_id}`.execute(ctx.trx);
    for (const w of wallets) {
      if (w.status !== 'ACTIVE' || !isPublicAttribute(w.visibility, restricted)) continue;
      await sql`INSERT INTO passport.wallet (wallet_link_id, athlete_id, network, address, proof_status)
        VALUES (${w.id}, ${athleteId}, ${w.network}, ${w.address}, ${w.proof_status})`.execute(
        ctx.trx,
      );
    }
  }
  await refreshAffiliations(ctx, athleteId);
}

/** Public affiliations: ACTIVE, PUBLIC-visibility memberships with athlete-facing roles, active orgs, unrestricted athletes. */
export async function refreshAffiliations(ctx: TxContext, athleteId: string): Promise<void> {
  await sql`DELETE FROM passport.affiliation WHERE athlete_id = ${athleteId}`.execute(ctx.trx);
  const { rows: card } = await sql<{ restricted: boolean }>`
    SELECT restricted FROM passport.athlete_card WHERE athlete_id = ${athleteId}`.execute(ctx.trx);
  if (card[0] === undefined || card[0].restricted) return;
  const { rows } = await sql<{
    id: string;
    organization_id: string;
    membership_role: MembershipRole;
    since: Date;
  }>`
    SELECT m.id, m.organization_id, m.membership_role, mc.recorded_at AS since
    FROM identity.athlete a
    JOIN organizations.membership m ON m.person_id = a.person_id
    JOIN organizations.v_membership_current mc ON mc.membership_id = m.id
    JOIN organizations.v_organization_current oc ON oc.organization_id = m.organization_id
    WHERE a.id = ${athleteId} AND mc.status = 'ACTIVE' AND m.visibility = 'PUBLIC' AND oc.status = 'ACTIVE'`.execute(
    ctx.trx,
  );
  for (const m of rows) {
    if (!AFFILIATION_ROLES.includes(m.membership_role)) continue;
    await sql`INSERT INTO passport.affiliation (membership_id, athlete_id, organization_id, membership_role, since)
      VALUES (${m.id}, ${athleteId}, ${m.organization_id}, ${m.membership_role}, ${m.since})`.execute(
      ctx.trx,
    );
  }
}

/** Organization-context entry point: refresh the affiliations of the person's athlete, if any. */
export async function refreshAffiliationsForPerson(
  ctx: TxContext,
  personId: string,
): Promise<void> {
  const { rows } = await sql<{
    id: string;
  }>`SELECT id FROM identity.athlete WHERE person_id = ${personId}`.execute(ctx.trx);
  for (const r of rows) await refreshAffiliations(ctx, r.id);
}

/** Organization-context: an organization's status/profile changed — refresh every affected athlete's affiliations. */
export async function refreshAffiliationsForOrganization(
  ctx: TxContext,
  organizationId: string,
): Promise<void> {
  const { rows } = await sql<{ id: string }>`
    SELECT DISTINCT a.id FROM organizations.membership m JOIN identity.athlete a ON a.person_id = m.person_id
    WHERE m.organization_id = ${organizationId}`.execute(ctx.trx);
  for (const r of rows) await refreshAffiliations(ctx, r.id);
}

/** Full rebuild from canonical sources. Maintenance login only (br_rebuild); no PII access needed. */
export function rebuildPassports(maintenanceDb: Db): Promise<{ athletes: number }> {
  return inTransaction(maintenanceDb, ModuleRole.rebuild, async (ctx) => {
    await sql`TRUNCATE passport.affiliation, passport.external_identity, passport.wallet, passport.athlete_slug, passport.athlete_card`.execute(
      ctx.trx,
    );
    const { rows } = await sql<{ id: string }>`SELECT id FROM identity.athlete ORDER BY id`.execute(
      ctx.trx,
    );
    for (const r of rows) await refreshAthletePassport(ctx, r.id);
    return { athletes: rows.length };
  });
}

// ───────────────────────────── public read path (br_public_read) ─────────────────────────────

export interface SlugResolution {
  readonly athleteId: string;
  readonly currentSlug: string;
  /** True when the requested slug is a former slug (clients should redirect). */
  readonly redirected: boolean;
}

async function loadSource(ctx: TxContext, athleteId: string): Promise<PassportSource | undefined> {
  const { rows: cards } = await sql<{
    athlete_id: string;
    slug: string;
    display_name: string;
    short_bio: string | null;
    home_country: string | null;
    avatar_ref: string | null;
    preferred_sports: string[];
    profile_visibility: ProfileVisibility;
    restricted: boolean;
    athlete_status: string;
  }>`SELECT athlete_id, slug, display_name, short_bio, home_country, avatar_ref, preferred_sports, profile_visibility, restricted, athlete_status
     FROM passport.athlete_card WHERE athlete_id = ${athleteId}`.execute(ctx.trx);
  const c = cards[0];
  if (c === undefined) return undefined;
  const { rows: affiliations } = await sql<{
    organization_id: string;
    slug: string;
    display_name: string;
    org_type: OrganizationType;
    membership_role: MembershipRole;
    since: Date;
  }>`SELECT a.organization_id, s.slug, p.display_name, o.org_type, a.membership_role, a.since
     FROM passport.affiliation a
     JOIN organizations.organization o ON o.id = a.organization_id
     JOIN organizations.organization_profile p ON p.organization_id = a.organization_id
     JOIN organizations.v_organization_slug_current s ON s.organization_id = a.organization_id
     WHERE a.athlete_id = ${athleteId}`.execute(ctx.trx);
  const { rows: ext } = await sql<{
    namespace: string;
    issuer_organization_id: string | null;
    external_value: string;
    status: 'CLAIMED' | 'CONFIRMED';
  }>`
    SELECT namespace, issuer_organization_id, external_value, status FROM passport.external_identity WHERE athlete_id = ${athleteId}`.execute(
    ctx.trx,
  );
  const { rows: wallets } = await sql<{
    network: string;
    address: string;
    proof_status: WalletProofStatus;
  }>`
    SELECT network, address, proof_status FROM passport.wallet WHERE athlete_id = ${athleteId}`.execute(
    ctx.trx,
  );
  return {
    card: {
      athleteId: c.athlete_id,
      slug: c.slug,
      displayName: c.display_name,
      shortBio: c.short_bio,
      homeCountry: c.home_country,
      avatarRef: c.avatar_ref,
      preferredSports: c.preferred_sports,
      profileVisibility: c.profile_visibility,
      restricted: c.restricted,
      athleteStatus: c.athlete_status,
    },
    affiliations: affiliations.map((a) => ({
      organizationId: a.organization_id,
      organizationSlug: a.slug,
      organizationName: a.display_name,
      organizationType: a.org_type,
      role: a.membership_role,
      since: a.since,
    })),
    externalIdentities: ext.map((e) => ({
      namespace: e.namespace,
      issuerOrganizationId: e.issuer_organization_id,
      value: e.external_value,
      status: e.status,
    })),
    wallets: wallets.map((w) => ({
      network: w.network,
      address: w.address,
      proofStatus: w.proof_status,
    })),
  };
}

/**
 * Public read path. Test proofs (TEST_VERIFIED) are labelled TEST_PROOF outside production and
 * SUPPRESSED in production — fail-safe even if development data reached a production database.
 */
export class PassportReader {
  private readonly db: Db;
  private readonly testProofs: TestProofPolicy;

  constructor(db: Db, options: { testProofs?: TestProofPolicy } = {}) {
    this.db = db;
    const production = process.env.NODE_ENV === 'production';
    // Production can never be configured to show test proofs.
    this.testProofs = production ? 'SUPPRESS' : (options.testProofs ?? 'LABEL');
  }

  /** Public passport by athlete id; undefined for unknown, private, restricted or inactive athletes (indistinguishable). */
  passport(athleteId: string, viewer: Viewer): Promise<AthletePassportV1 | undefined> {
    return inTransaction(this.db, ModuleRole.publicRead, async (ctx) => {
      const source = await loadSource(ctx, athleteId);
      if (source === undefined || !isPassportVisible(source.card, viewer)) return undefined;
      return assemblePassport(source, { testProofs: this.testProofs });
    });
  }

  /** Slug → passport. Former slugs resolve to the athlete and report `redirected` (clients redirect). */
  bySlug(
    slug: string,
    viewer: Viewer,
  ): Promise<{ passport: AthletePassportV1; resolution: SlugResolution } | undefined> {
    const key = slugLookupKey(slug);
    if (key === undefined) return Promise.resolve(undefined);
    return inTransaction(this.db, ModuleRole.publicRead, async (ctx) => {
      const { rows } = await sql<{
        athlete_id: string;
      }>`SELECT athlete_id FROM passport.athlete_slug WHERE slug = ${key}`.execute(ctx.trx);
      const id = rows[0]?.athlete_id;
      if (id === undefined) return undefined;
      const source = await loadSource(ctx, id);
      if (source === undefined || !isPassportVisible(source.card, viewer)) return undefined;
      return {
        passport: assemblePassport(source, { testProofs: this.testProofs }),
        resolution: {
          athleteId: id,
          currentSlug: source.card.slug,
          redirected: source.card.slug !== key,
        },
      };
    });
  }

  /** Public affiliations of an organization (visible athletes only). */
  organizationAffiliations(
    organizationId: string,
  ): Promise<{ athleteSlug: string; displayName: string; role: MembershipRole; since: string }[]> {
    return inTransaction(this.db, ModuleRole.publicRead, async (ctx) => {
      const { rows } = await sql<{
        slug: string;
        display_name: string;
        membership_role: MembershipRole;
        since: Date;
      }>`
        SELECT c.slug, c.display_name, a.membership_role, a.since
        FROM passport.affiliation a JOIN passport.athlete_card c ON c.athlete_id = a.athlete_id
        WHERE a.organization_id = ${organizationId} AND c.profile_visibility = 'PUBLIC' AND NOT c.restricted AND c.athlete_status = 'ACTIVE'
        ORDER BY c.slug, a.membership_role`.execute(ctx.trx);
      return rows.map((r) => ({
        athleteSlug: r.slug,
        displayName: r.display_name,
        role: r.membership_role,
        since: r.since.toISOString(),
      }));
    });
  }
}

/** Snapshot of all projection rows (deterministic order) for rebuild comparisons. */
export function snapshotPassports(db: Db, role: ModuleRole = ModuleRole.publicRead) {
  return inTransaction(db, role, async (ctx) => ({
    cards: (await sql`SELECT * FROM passport.athlete_card ORDER BY athlete_id`.execute(ctx.trx))
      .rows,
    slugs: (await sql`SELECT * FROM passport.athlete_slug ORDER BY slug`.execute(ctx.trx)).rows,
    affiliations: (
      await sql`SELECT * FROM passport.affiliation ORDER BY membership_id`.execute(ctx.trx)
    ).rows,
    externalIdentities: (
      await sql`SELECT * FROM passport.external_identity ORDER BY external_identity_id`.execute(
        ctx.trx,
      )
    ).rows,
    wallets: (await sql`SELECT * FROM passport.wallet ORDER BY wallet_link_id`.execute(ctx.trx))
      .rows,
  }));
}

export type { SlugResolution as AthleteSlugResolution };
