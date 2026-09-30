import type {
  AttributeVisibility,
  ExternalIdentityStatus,
  MembershipRole,
  OrganizationType,
  ProfileVisibility,
  WalletProofStatus,
} from './model';
import { Provenance } from './model';

/**
 * Athlete Passport — public DTO (version 1).
 *
 * The passport is a READ MODEL assembled from the passport projection (itself rebuildable from
 * identity/organizations tables). It is never a source of sporting truth.
 *
 * Every field carries a provenance class. Sections backed by sources that do not exist yet
 * (verified achievements, records, competitions, trophies, career stats) report
 * `status: 'NOT_AVAILABLE'` — distinct from `status: 'AVAILABLE'` with an empty list, which means
 * "the source exists and there is nothing to show".
 */
export const PASSPORT_SCHEMA = 'br:athlete-passport@1';

export interface Attributed<T> {
  readonly value: T;
  readonly provenance: Provenance;
}

export type SectionStatus = 'AVAILABLE' | 'NOT_AVAILABLE';

export interface Section<T> {
  readonly status: SectionStatus;
  /** Why a section is not available (stable machine-readable reason). */
  readonly reason?: 'SOURCE_NOT_IMPLEMENTED';
  readonly items: readonly T[];
}

export interface PassportAffiliation {
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly organizationName: Attributed<string>;
  readonly organizationType: OrganizationType;
  readonly role: Attributed<MembershipRole>;
  readonly since: string;
}

export interface PassportExternalIdentity {
  readonly namespace: string;
  readonly issuerOrganizationId?: string;
  readonly value: string;
  readonly status: Exclude<ExternalIdentityStatus, 'REVOKED'>;
  readonly provenance: Provenance;
}

export interface PassportWallet {
  readonly network: string;
  readonly address: string;
  readonly proofStatus: WalletProofStatus;
  readonly provenance: Provenance;
}

/**
 * BRT-08 Verified Achievements section item — PRESENTATION ONLY. Built from the canonical Achievement
 * read model; the passport never derives Achievement truth. A TEAM Achievement reaches a credited
 * athlete through its immutable memberCredits (`creditType: TEAM_MEMBER`): the athlete is shown the
 * canonical TEAM Achievement, never an athlete copy, and is never presented as its holder.
 */
export interface PassportVerifiedAchievement {
  readonly achievementId: string;
  readonly type: string;
  readonly typeLabel: string;
  readonly displayName: string;
  readonly creditType: 'HOLDER' | 'TEAM_MEMBER';
  readonly holderType: 'ATHLETE' | 'TEAM';
  readonly teamName?: string;
  readonly sport?: string;
  readonly discipline?: string;
  readonly competitionName: string;
  readonly eventName?: string;
  readonly qualifyingValue?: string;
  /** The verification level of the BASIS result at derivation — never "the achievement's level". */
  readonly verificationLevelAtDerivation: string;
  readonly derivedFrom: string;
  readonly currentSupport: 'ACTIVE' | 'SUSPENDED' | 'SUPERSEDED' | 'REVOKED';
  readonly currentlySupported: boolean;
  readonly rule: { readonly code: string; readonly version: number };
  readonly derivedAt: string;
  readonly provenance: Provenance;
}

export interface AthletePassportV1 {
  readonly schema: typeof PASSPORT_SCHEMA;
  readonly athlete: {
    readonly id: string;
    readonly slug: string;
    readonly displayName: Attributed<string>;
    readonly bio?: Attributed<string>;
    readonly homeCountry?: Attributed<string>;
    readonly avatarRef?: Attributed<string>;
    readonly preferredSports: Attributed<readonly string[]>;
  };
  readonly affiliations: Section<PassportAffiliation>;
  readonly externalIdentities: Section<PassportExternalIdentity>;
  readonly wallets: Section<PassportWallet>;
  /** BRT-08: canonical Achievement read model (derived recognitions; never fabricated). */
  readonly verifiedAchievements: Section<PassportVerifiedAchievement>;
  /** Future sources. Never fabricated. */
  readonly records: Section<never>;
  readonly competitionHistory: Section<never>;
  readonly careerStats: Section<never>;
  readonly trophies: Section<never>;
}

/** Projection rows as read by the public read path (public-safe by construction). */
export interface PassportSource {
  readonly card: {
    readonly athleteId: string;
    readonly slug: string;
    readonly displayName: string;
    readonly shortBio: string | null;
    readonly homeCountry: string | null;
    readonly avatarRef: string | null;
    readonly preferredSports: readonly string[];
    readonly profileVisibility: ProfileVisibility;
    readonly restricted: boolean;
    readonly athleteStatus: string;
  };
  readonly affiliations: readonly {
    readonly organizationId: string;
    readonly organizationSlug: string;
    readonly organizationName: string;
    readonly organizationType: OrganizationType;
    readonly role: MembershipRole;
    readonly since: Date;
  }[];
  readonly externalIdentities: readonly {
    readonly namespace: string;
    readonly issuerOrganizationId: string | null;
    readonly value: string;
    readonly status: 'CLAIMED' | 'CONFIRMED';
  }[];
  readonly wallets: readonly {
    readonly network: string;
    readonly address: string;
    readonly proofStatus: WalletProofStatus;
  }[];
  /** BRT-08 Achievement read-model rows for this athlete (undefined ⇒ source unavailable). */
  readonly achievements?: readonly Omit<PassportVerifiedAchievement, 'provenance'>[];
}

export interface Viewer {
  readonly authenticated: boolean;
}

/** Whether a viewer may see this passport at all. Restricted/private passports are indistinguishable from absent ones. */
export function isPassportVisible(card: PassportSource['card'], viewer: Viewer): boolean {
  if (card.athleteStatus !== 'ACTIVE' || card.restricted) return false;
  if (card.profileVisibility === 'PUBLIC') return true;
  if (card.profileVisibility === 'AUTHENTICATED') return viewer.authenticated;
  return false;
}

const notImplemented: Section<never> = {
  status: 'NOT_AVAILABLE',
  reason: 'SOURCE_NOT_IMPLEMENTED',
  items: [],
};
const self = <T>(value: T): Attributed<T> => ({ value, provenance: Provenance.SELF_DECLARED });

const byString =
  <T>(key: (t: T) => string) =>
  (a: T, b: T) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;

/**
 * How development/test wallet proofs (TEST_VERIFIED) are presented:
 * - `LABEL`: shown with provenance TEST_PROOF (development and test environments);
 * - `SUPPRESS`: omitted entirely (production, and the fail-safe default).
 * TEST_VERIFIED is never mapped to PROOF_OF_CONTROL.
 */
export type TestProofPolicy = 'LABEL' | 'SUPPRESS';

/** Explicit, exhaustive provenance mapping for wallet proofs (undefined ⇒ not presentable). */
export function walletProofProvenance(
  proofStatus: WalletProofStatus,
  policy: TestProofPolicy,
): Provenance | undefined {
  switch (proofStatus) {
    case 'VERIFIED':
      return Provenance.PROOF_OF_CONTROL;
    case 'TEST_VERIFIED':
      return policy === 'LABEL' ? Provenance.TEST_PROOF : undefined;
    default:
      return undefined;
  }
}

/** Pure, deterministic assembly (stable ordering) — used by the API and by rebuild tests. */
export function assemblePassport(
  source: PassportSource,
  options: { testProofs?: TestProofPolicy } = {},
): AthletePassportV1 {
  const testProofs = options.testProofs ?? 'SUPPRESS';
  const c = source.card;
  return {
    schema: PASSPORT_SCHEMA,
    athlete: {
      id: c.athleteId,
      slug: c.slug,
      displayName: self(c.displayName),
      ...(c.shortBio === null ? {} : { bio: self(c.shortBio) }),
      ...(c.homeCountry === null ? {} : { homeCountry: self(c.homeCountry) }),
      ...(c.avatarRef === null ? {} : { avatarRef: self(c.avatarRef) }),
      preferredSports: self([...c.preferredSports]),
    },
    affiliations: {
      status: 'AVAILABLE',
      items: [...source.affiliations]
        .sort(byString((a) => `${a.organizationSlug}|${a.role}`))
        .map((a) => ({
          organizationId: a.organizationId,
          organizationSlug: a.organizationSlug,
          organizationName: self(a.organizationName), // the organization's own self-description
          organizationType: a.organizationType,
          role: { value: a.role, provenance: Provenance.ORGANIZATION_CONFIRMED },
          since: a.since.toISOString(),
        })),
    },
    externalIdentities: {
      status: 'AVAILABLE',
      items: [...source.externalIdentities]
        .sort(byString((e) => `${e.namespace}|${e.value}`))
        .map((e) => ({
          namespace: e.namespace,
          ...(e.issuerOrganizationId === null
            ? {}
            : { issuerOrganizationId: e.issuerOrganizationId }),
          value: e.value,
          status: e.status,
          provenance:
            e.status === 'CONFIRMED' ? Provenance.ORGANIZATION_CONFIRMED : Provenance.SELF_DECLARED,
        })),
    },
    wallets: {
      status: 'AVAILABLE',
      items: [...source.wallets].sort(byString((w) => `${w.network}|${w.address}`)).flatMap((w) => {
        const provenance = walletProofProvenance(w.proofStatus, testProofs);
        return provenance === undefined
          ? []
          : [{ network: w.network, address: w.address, proofStatus: w.proofStatus, provenance }];
      }),
    },
    verifiedAchievements:
      source.achievements === undefined
        ? notImplemented
        : {
            status: 'AVAILABLE',
            items: source.achievements.map((a) => ({
              ...a,
              provenance: Provenance.SYSTEM_DERIVED,
            })),
          },
    records: notImplemented,
    competitionHistory: notImplemented,
    careerStats: notImplemented,
    trophies: notImplemented,
  };
}

/** Public attribute filter used by the projection (dependents never expose identities/wallets). */
export function isPublicAttribute(visibility: AttributeVisibility, restricted: boolean): boolean {
  return visibility === 'PUBLIC' && !restricted;
}
