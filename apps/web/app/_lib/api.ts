/** Minimal public-API client for server components (PUBLIC endpoints only; no credentials). */
export const API_BASE = process.env.BR_API_URL ?? 'http://127.0.0.1:4000';

export type Provenance =
  | 'SELF_DECLARED'
  | 'ACCOUNT_VERIFIED'
  | 'ORGANIZATION_CONFIRMED'
  | 'PROOF_OF_CONTROL'
  | 'TEST_PROOF'
  | 'AUTHORITY_VERIFIED'
  | 'SYSTEM_DERIVED';

export interface Attributed<T> {
  value: T;
  provenance: Provenance;
}

export interface Section<T> {
  status: 'AVAILABLE' | 'NOT_AVAILABLE';
  reason?: string;
  items: T[];
}

import type { PassportAchievement } from './achievement';

export interface AthletePassport {
  schema: string;
  athlete: {
    id: string;
    slug: string;
    displayName: Attributed<string>;
    bio?: Attributed<string>;
    homeCountry?: Attributed<string>;
    preferredSports: Attributed<string[]>;
  };
  affiliations: Section<{
    organizationSlug: string;
    organizationName: Attributed<string>;
    organizationType: string;
    role: Attributed<string>;
    since: string;
  }>;
  externalIdentities: Section<{
    namespace: string;
    value: string;
    status: string;
    provenance: Provenance;
  }>;
  wallets: Section<{
    network: string;
    address: string;
    proofStatus: string;
    provenance: Provenance;
  }>;
  verifiedAchievements: Section<PassportAchievement>;
  records: Section<never>;
  competitionHistory: Section<never>;
  careerStats: Section<never>;
  trophies: Section<never>;
}

export interface PublicOrganization {
  organization: {
    organizationId: string;
    slug: string;
    orgType: string;
    status: string;
    profile: {
      displayName: string;
      description: string | null;
      website: string | null;
      country: string | null;
      region: string | null;
      publicContact: string | null;
      provenance: Provenance;
    };
    authority: { status: 'NOT_AVAILABLE'; reason: string };
  };
  affiliations: Section<{
    athleteSlug: string;
    displayName: string;
    role: string;
    since: string;
    provenance: Provenance;
  }>;
  canonicalSlug: string;
  redirected: boolean;
}

export type Fetched<T> = { kind: 'ok'; data: T } | { kind: 'not_found' } | { kind: 'unavailable' };

export async function getPublic<T>(path: string): Promise<Fetched<T>> {
  try {
    const res = await fetch(`${API_BASE}${path}`, { cache: 'no-store' });
    if (res.status === 404) return { kind: 'not_found' };
    if (!res.ok) return { kind: 'unavailable' };
    return { kind: 'ok', data: (await res.json()) as T };
  } catch {
    return { kind: 'unavailable' };
  }
}
