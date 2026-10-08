import { getPublic, type Fetched } from './api';
import { apiRequest, type ApiResult } from './platform';

/**
 * ONCF-03A tournament data for the organizer area (a tournament is a canonical Competition; its
 * categories are Events). Shapes mirror the API; the API decides access (ORG_MANAGE_COMPETITIONS
 * for the organization list, COMP_VIEW_PRIVATE for one competition) and every rule.
 */
export type CompetitionStatus = 'DRAFT' | 'PUBLISHED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
export type EventStatus =
  | 'DRAFT'
  | 'REGISTRATION_OPEN'
  | 'REGISTRATION_CLOSED'
  | 'FIELD_LOCKED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED';
export type EntrantKind = 'INDIVIDUAL' | 'TEAM';

export interface ManagedCompetitionCard {
  id: string;
  slug: string;
  name: string;
  status: CompetitionStatus;
  startsAt: string | null;
  endsAt: string | null;
  timezone: string;
  locationLabel: string | null;
  regionCode: string | null;
  eventCount: number;
  cancelledEventCount: number;
  createdAt: string;
  updatedAt: string;
  statusChangedAt: string;
}

export interface ManagedEvent {
  id: string;
  slug: string;
  status: EventStatus;
  entrantKind: EntrantKind;
  discipline: {
    versionId: string;
    sport: { code: string; name: string };
    code: string;
    name: string;
    version: number;
  };
  format: { versionId: string; code: string; name: string; version: number; engine: string };
  formatConfig: Record<string, unknown>;
  settings: {
    name: string;
    category: Record<string, unknown>;
    capacity: number | null;
    registrationMode: 'AUTO_CONFIRM' | 'ORGANIZER_APPROVAL';
    registrationOpensAt: string | null;
    registrationClosesAt: string | null;
    startsAt: string | null;
    endsAt: string | null;
    timezone: string;
  };
  counts: { confirmed: number; waitlisted: number; participants: number };
  editable: { settings: boolean; capacityAndRegistrationMode: boolean };
  nextStatuses: EventStatus[];
  createdAt: string;
  updatedAt: string;
  statusChangedAt: string;
}

export interface ManagedCompetition {
  competition: {
    id: string;
    slug: string;
    organizerOrganizationId: string;
    status: CompetitionStatus;
    profile: {
      name: string;
      description: string | null;
      locationLabel: string | null;
      regionCode: string | null;
      timezone: string;
      startsAt: string | null;
      endsAt: string | null;
      website: string | null;
    };
    editable: { profile: boolean; addEvents: boolean };
    nextStatuses: CompetitionStatus[];
    createdAt: string;
    updatedAt: string;
    statusChangedAt: string;
  };
  events: ManagedEvent[];
  access: { staffRoles: string[]; permissions: string[] };
}

export interface CatalogDisciplineVersion {
  disciplineVersionId: string;
  sport: { code: string; name: string };
  discipline: { code: string; name: string };
  version: number;
  specHash: string;
  participantKinds: EntrantKind[];
  lineupSize: { min: number; max: number };
  allowedContestTypes: string[];
  compatibleFormatVersionIds: string[];
  /** ONCF-05B (may be absent on older API builds): capabilities, roster and declared attributes. */
  capabilities?: {
    contestTypes: string[];
    participantKinds: EntrantKind[];
    rulesetFamilies: string[];
    partitionKinds: string[];
    startMethods: string[];
    multiRound: boolean;
    resourceTypes: string[];
    entryAttributes: { key: string; valueType: EntryAttributeValueType }[];
  };
  roster?: { min: number; max: number } | null;
  entryAttributes?: EntryAttributeSpec[];
  /** ONCF-05C: published ruleset versions whose family this discipline provides. */
  compatibleRulesetVersionIds?: string[];
}

/** ONCF-05C: a published ruleset or classification template version, with its basis. */
export interface CatalogScoringVersion {
  versionId: string;
  code: string;
  name: string;
  version: number;
  family: string;
  specHash: string;
  basis: { kind: 'GOVERNING_RULE'; source: string } | { kind: 'COMMON_PRACTICE'; note: string };
}

export type EntryAttributeValueType = 'DURATION_MS' | 'INTEGER' | 'DECIMAL' | 'TEXT';

/** A value the discipline lets entrants declare at entry (seeding, handicap, start lists). */
export interface EntryAttributeSpec {
  key: string;
  valueType: EntryAttributeValueType;
  scope: 'PARTICIPANT' | 'MEMBER';
  required: boolean;
  min?: string;
  max?: string;
}

export interface CatalogFormatVersion {
  formatVersionId: string;
  format: { code: string; name: string };
  version: number;
  engine: string;
  contestType: string | null;
  configurationSchema: Record<string, unknown>;
  /** ONCF-05B: the capabilities the format requires (null: engine not in this API build). */
  requires?: Record<string, unknown> | null;
}

export interface Catalog {
  disciplineVersions: CatalogDisciplineVersion[];
  formatVersions: CatalogFormatVersion[];
  rulesetVersions?: CatalogScoringVersion[];
  classificationTemplateVersions?: CatalogScoringVersion[];
}

export function managedCompetitions(
  token: string,
  organizationId: string,
): Promise<ApiResult<{ items: ManagedCompetitionCard[] }>> {
  return apiRequest(token, 'GET', `/v1/organizations/${organizationId}/competitions/manage`);
}

export function managedCompetition(
  token: string,
  competitionId: string,
): Promise<ApiResult<ManagedCompetition>> {
  return apiRequest(token, 'GET', `/v1/competitions/${competitionId}/manage`);
}

/** The published catalog (public). Valid pairs come from `compatibleFormatVersionIds`. */
export function tournamentCatalog(): Promise<Fetched<Catalog>> {
  return getPublic<Catalog>('/v1/catalog');
}

/** The catalog version an event pins (public reads name it by discipline code + version). */
export function catalogDiscipline(
  catalog: Catalog,
  code: string,
  version: number,
): CatalogDisciplineVersion | undefined {
  return catalog.disciplineVersions.find(
    (d) => d.discipline.code === code && d.version === version,
  );
}
