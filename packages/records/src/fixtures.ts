import { createHash } from 'node:crypto';
import {
  ALL_RECORD_FACT_KINDS,
  type PopulationDimension,
  type RecognitionLevel,
  type RecordFactKind,
  type RecordScopeType,
  type RecordStanding,
  type ResultVersionStatus,
  type TiePolicy,
  type VerificationLevel,
} from '@br/domain';
import {
  RECORD_ENGINE_VERSION,
  validateRecordCategorySpec,
  type ConditionRequirement,
  type RecordCategorySpec,
  type RecordPopulation,
} from './category';
import { markIdentityOf } from './engine';
import type {
  RatificationFact,
  RecordEvaluationSnapshot,
  SnapshotAuthorityFacts,
  SnapshotKeyFact,
  StandingMark,
} from './snapshot';

/**
 * REFERENCE ENGINE FIXTURE — NOT PERSISTED SPORTING TRUTH.
 *
 * Typed, in-memory, fully synthetic RecordEvaluationSnapshots. They carry facts the platform cannot
 * produce yet (FINAL status, V3 / V4 verification, hold state, population / condition / membership
 * facts, RECORD_RATIFIED / REVIEW_COMPLETED ratifications and the authority behind them) solely to
 * prove the record engine's semantics. Every snapshot has `provenance: REFERENCE_FIXTURE`; the
 * normal database schema refuses anything derived from one. Deterministic ids from labels: no
 * clock, randomness, database or environment. Import explicitly from `@br/records/fixtures`.
 */
export const RECORD_FIXTURE_LABEL = 'REFERENCE ENGINE FIXTURE — NOT PERSISTED SPORTING TRUTH';

export function rfxId(label: string): string {
  const h = createHash('sha256').update(`br-record-fixture:${label}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export const rfxHash = (label: string) =>
  `sha256:${createHash('sha256').update(`br-record-fixture-hash:${label}`).digest('hex')}`;
const T0 = Date.parse('2026-06-01T08:00:00.000Z');
/** Fixture instant, minutes after the fixture epoch. */
export const rfxTime = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

export const RFX = {
  runningDv: rfxId('dv-running-100m'),
  bowlingDv: rfxId('dv-bowling-series'),
  padelDv: rfxId('dv-padel-doubles'),
  competition: rfxId('competition-la-negrita-2026'),
  competition2: rfxId('competition-la-negrita-2027'),
  otherCompetition: rfxId('competition-other'),
  event: rfxId('event'),
  contest: rfxId('contest'),
  venue: rfxId('venue-crcc-lanes'),
  league: rfxId('league-fictional'),
  keeperPrincipal: rfxId('principal:federation-keeper'),
} as const;

export const RUNNING_METRICS = [
  { key: 'elapsedTimeMs', valueType: 'DURATION_MS', unit: 'ms', order: 'LOWER_IS_BETTER' },
] as const;
export const BOWLING_METRICS = [
  { key: 'seriesPins', valueType: 'INTEGER', unit: 'pins', order: 'HIGHER_IS_BETTER' },
] as const;

export interface CategoryFixtureOptions {
  readonly scopeType?: RecordScopeType;
  readonly sport?: 'running' | 'bowling';
  readonly tiePolicy?: TiePolicy;
  readonly minimumVerificationLevel?: VerificationLevel;
  readonly population?: RecordPopulation;
  readonly conditions?: readonly ConditionRequirement[];
  readonly region?: readonly string[];
  readonly recognitionLevel?: RecognitionLevel;
  readonly platformReview?: boolean;
  readonly canonicalKeeper?: boolean;
  readonly effectiveFrom?: string;
  readonly competitionIds?: readonly string[];
  readonly displayName?: string;
  readonly holderType?: 'ATHLETE' | 'TEAM';
  /** Persistence fixture lane: the real DisciplineVersion and its catalog codes. */
  readonly disciplineVersionId?: string;
  readonly sportCode?: string;
}

/** A valid fictional category spec for a scope (bowling series pins or running 100 m time). */
export function categorySpec(o: CategoryFixtureOptions = {}): RecordCategorySpec {
  const st = o.scopeType ?? 'COMPETITION';
  const sport = o.sport ?? 'running';
  const running = sport === 'running';
  const region =
    o.region ??
    (st === 'NATIONAL' ? ['CR'] : st === 'CONTINENTAL' ? ['CR', 'PA', 'NI'] : undefined);
  const floor: VerificationLevel =
    st === 'NATIONAL' || st === 'CONTINENTAL' || st === 'WORLD' ? 'V4' : 'V3';
  const recognitionLevel: RecognitionLevel =
    o.recognitionLevel ??
    (st === 'NATIONAL' || st === 'CONTINENTAL' || st === 'WORLD'
      ? st
      : st === 'PLATFORM'
        ? 'PLATFORM'
        : 'CLUB');
  return {
    targetEngine: RECORD_ENGINE_VERSION,
    displayName:
      o.displayName ??
      (st === 'PLATFORM'
        ? running
          ? '100 m time'
          : 'Series pins'
        : running
          ? 'Fictional 100 m record'
          : 'Fictional series pins record'),
    scope: {
      scopeType: st,
      ...(st === 'COMPETITION' ? { competitionIds: o.competitionIds ?? [RFX.competition] } : {}),
      ...(st === 'VENUE' ? { venueOrganizationId: RFX.venue } : {}),
      ...(st === 'LEAGUE' ? { leagueOrganizationId: RFX.league } : {}),
      ...(region === undefined || (st !== 'NATIONAL' && st !== 'CONTINENTAL') ? {} : { region }),
    },
    universe: {
      disciplineVersionId: o.disciplineVersionId ?? (running ? RFX.runningDv : RFX.bowlingDv),
      metric: running
        ? { key: 'elapsedTimeMs', markMetricId: 'athletics.100m.time' }
        : { key: 'seriesPins', markMetricId: 'bowling.series.pins' },
      resultScope: 'CONTEST',
      holderType: o.holderType ?? 'ATHLETE',
    },
    tiePolicy: o.tiePolicy ?? 'SHARED',
    population: o.population ?? {},
    conditions: o.conditions ?? [],
    requirements: {
      minimumVerificationLevel: o.minimumVerificationLevel ?? floor,
      minimumResultStatus: 'FINAL',
    },
    recognition: {
      level: recognitionLevel,
      sport: [o.sportCode ?? (running ? 'athletics' : 'bowling')],
      ...(region === undefined || (st !== 'NATIONAL' && st !== 'CONTINENTAL') ? {} : { region }),
    },
    ...(o.platformReview === undefined ? {} : { platformReview: o.platformReview }),
    ...(o.canonicalKeeper === true
      ? { canonicalKeeper: { principalId: RFX.keeperPrincipal, registryRef: 'NATIONAL-LIST' } }
      : {}),
    effectiveFrom: o.effectiveFrom ?? rfxTime(0),
  };
}

export interface CategoryIdentity {
  readonly categoryId: string;
  readonly code: string;
  readonly categoryVersionId: string;
  readonly version: number;
}

export function fixtureCategory(
  spec: RecordCategorySpec,
  label: string,
  version = 1,
  identity?: CategoryIdentity,
  lifecycle: 'DRAFT' | 'PUBLISHED' | 'RETIRED' = 'PUBLISHED',
): RecordEvaluationSnapshot['category'] {
  const v = validateRecordCategorySpec(spec);
  if (!v.ok) throw new Error(`invalid fixture category ${label}: ${JSON.stringify(v.issues)}`);
  return {
    categoryId: identity?.categoryId ?? rfxId(`category:${label}`),
    code: identity?.code ?? `fixture-${label.toLowerCase()}`,
    categoryVersionId: identity?.categoryVersionId ?? rfxId(`category:${label}:v${version}`),
    version: identity?.version ?? version,
    specHash: v.specHash,
    spec: v.spec,
    lifecycle,
  };
}

// ───────────────────────────── authority world (for ratification) ─────────────────────────────

export interface AuthorityWorldOptions {
  /** Anchor recognition (default: covers exactly the category's recognition scope). */
  readonly anchorLevel?: RecognitionLevel;
  readonly anchorRegion?: readonly string[];
  readonly anchorSport?: readonly string[];
  /** The ratifier's grant scope overrides (default: the anchor scope). */
  readonly grantRegion?: readonly string[];
  readonly grantSport?: readonly string[];
  readonly grantCapabilities?: readonly ('RATIFY_RECORD' | 'ATTEST_RESULT')[];
  readonly grantValidTo?: string;
  readonly grantRevokedAt?: string;
  /** The ratifier's own principal type (PERSON by default). */
  readonly ratifierType?: 'PERSON' | 'ORGANIZATION' | 'SYSTEM' | 'PLATFORM';
  /** The ratifier is the designated canonical keeper principal. */
  readonly ratifierIsKeeper?: boolean;
  /** Anchor principal is the PLATFORM principal (PLATFORM-level recognition). */
  readonly platformAnchor?: boolean;
  readonly keyRevokedAt?: string;
}

export interface AuthorityWorld {
  readonly ratifierPrincipalId: string;
  readonly ratifierType: 'PERSON' | 'ORGANIZATION' | 'SYSTEM' | 'PLATFORM';
  readonly keyId: string;
  readonly authority: SnapshotAuthorityFacts;
  readonly keys: readonly SnapshotKeyFact[];
}

/** A synthetic anchor → ratifier grant chain for RATIFY_RECORD (fixture only). */
export function authorityWorld(
  spec: RecordCategorySpec,
  o: AuthorityWorldOptions = {},
  label = 'world',
): AuthorityWorld {
  const level = o.anchorLevel ?? spec.recognition.level;
  const platform = o.platformAnchor ?? level === 'PLATFORM';
  const anchorPrincipal = rfxId(`${label}:anchor-principal:${platform ? 'platform' : level}`);
  const ratifier = o.ratifierIsKeeper === true ? RFX.keeperPrincipal : rfxId(`${label}:ratifier`);
  const region = o.anchorRegion ?? spec.recognition.region;
  const sport = o.anchorSport ?? spec.recognition.sport;
  const anchorScope = {
    recognitionLevel: [level],
    ...(sport === undefined ? {} : { sport: [...sport] }),
    ...(region === undefined ? {} : { region: [...region] }),
  };
  const grantScope = {
    recognitionLevel: [level],
    sport: [...(o.grantSport ?? sport ?? [])],
    ...((o.grantRegion ?? region) === undefined
      ? {}
      : { region: [...(o.grantRegion ?? region ?? [])] }),
  };
  const grantId = rfxId(`${label}:grant`);
  const keyId = rfxId(`${label}:key`);
  return {
    ratifierPrincipalId: ratifier,
    ratifierType: o.ratifierType ?? 'PERSON',
    keyId,
    authority: {
      principals: [
        {
          principalId: anchorPrincipal,
          principalType: platform ? 'PLATFORM' : 'ORGANIZATION',
          recordedAt: rfxTime(-100),
        },
        {
          principalId: ratifier,
          principalType: o.ratifierType ?? 'PERSON',
          recordedAt: rfxTime(-100),
        },
      ],
      anchors: [
        {
          anchorId: rfxId(`${label}:anchor`),
          principalId: anchorPrincipal,
          recognitionScope: anchorScope as never,
          factHash: rfxHash(`${label}:anchor-fact`),
          effectiveFrom: rfxTime(-100),
          recordedAt: rfxTime(-100),
        },
      ],
      grants: [
        {
          grantId,
          grantorPrincipalId: anchorPrincipal,
          granteePrincipalId: ratifier,
          capabilities: [...(o.grantCapabilities ?? ['RATIFY_RECORD'])],
          scope: grantScope as never,
          delegation: { allowed: false, maxDepth: 0 },
          grantHash: rfxHash(`${label}:grant`),
          effectiveFrom: rfxTime(-100),
          ...(o.grantValidTo === undefined ? {} : { effectiveTo: o.grantValidTo }),
          recordedAt: rfxTime(-100),
        },
      ],
      ...(o.grantRevokedAt === undefined
        ? {}
        : {
            grantStatusChanges: [
              {
                statusChangeId: rfxId(`${label}:grant-revoked`),
                grantId,
                compromise: false,
                effectiveFrom: o.grantRevokedAt,
                recordedAt: o.grantRevokedAt,
              },
            ],
          }),
    },
    keys: [
      {
        keyId,
        principalId: ratifier,
        keyKind: 'JWK',
        algorithm: 'EdDSA',
        factHash: rfxHash(`${label}:key-fact`),
        effectiveFrom: rfxTime(-100),
        recordedAt: rfxTime(-100),
        ...(o.keyRevokedAt === undefined
          ? {}
          : {
              statusChanges: [
                {
                  statusChangeId: rfxId(`${label}:key-revoked`),
                  kind: 'REVOKED',
                  effectiveFrom: o.keyRevokedAt,
                  recordedAt: o.keyRevokedAt,
                },
              ],
            }),
      },
    ],
  };
}

// ───────────────────────────── snapshots ─────────────────────────────

export interface PerformanceFixture {
  /** ResultVersion label (distinct labels ⇒ distinct versions / hashes). */
  readonly rv: string;
  readonly athlete?: string;
  readonly value: string;
  /** Sporting time (minutes after the fixture epoch). */
  readonly minute: number;
  readonly status?: Exclude<ResultVersionStatus, 'DRAFT'>;
  readonly level?: VerificationLevel;
  readonly verificationState?: 'CURRENT' | 'STALE' | 'NOT_EVALUATED' | 'POLICY_UNAVAILABLE';
  readonly valid?: boolean;
  readonly competitionId?: string;
  readonly supersededBy?: string;
  /** ResultVersion label this version corrects (the upstream correction fact). */
  readonly supersedes?: string;
  readonly team?: string;
  readonly v4CategoryIds?: readonly string[];
  /** Absolute sporting time (persistence fixtures: after the category's real effectiveFrom). */
  readonly occurredAt?: string;
}

export interface SnapshotFixtureOptions {
  readonly category: RecordEvaluationSnapshot['category'];
  readonly performance: PerformanceFixture;
  readonly unsupported?: readonly RecordFactKind[];
  readonly hold?: boolean;
  readonly population?: Partial<Record<PopulationDimension, string>>;
  readonly conditions?: RecordEvaluationSnapshot['conditions'];
  readonly memberships?: RecordEvaluationSnapshot['memberships'];
  readonly currentMarks?: readonly StandingMark[];
  readonly creditedLineup?: readonly string[];
  /** Ratify this pending mark (RATIFY mode). */
  readonly pending?: { readonly recordMarkId: string; readonly markHash: string };
  readonly ratification?: Partial<RatificationFact> | null;
  readonly world?: AuthorityWorld;
  readonly conflicted?: readonly string[];
  /** Persistence fixture lane: real catalog codes of the DisciplineVersion. */
  readonly discipline?: { readonly sport: string; readonly discipline: string };
  /** Persistence fixture lane: real athlete / team ids (by label). */
  readonly holderIds?: Readonly<Record<string, string>>;
}

export function performanceValue(spec: RecordCategorySpec, value: string) {
  return spec.universe.metric.markMetricId === 'athletics.100m.time'
    ? { metricId: spec.universe.metric.markMetricId, value, unit: 'ms', precision: 0 }
    : { metricId: spec.universe.metric.markMetricId, value, unit: 'pins', precision: 0 };
}

/** One performance of one athlete (INDIVIDUAL) or a team (TEAM), against one category version. */
export function recordSnapshot(o: SnapshotFixtureOptions): RecordEvaluationSnapshot {
  const spec = o.category.spec;
  const p = o.performance;
  const running = spec.universe.metric.markMetricId === 'athletics.100m.time';
  const athlete = p.athlete ?? 'athlete-a';
  const team = p.team;
  const participantId = rfxId(`participant:${team ?? athlete}:${p.rv}`);
  const holder =
    team === undefined
      ? {
          holderType: 'ATHLETE' as const,
          holderId: o.holderIds?.[athlete] ?? rfxId(`athlete:${athlete}`),
        }
      : { holderType: 'TEAM' as const, holderId: o.holderIds?.[team] ?? rfxId(`team:${team}`) };
  const occurredAt = p.occurredAt ?? rfxTime(p.minute);
  const mark = performanceValue(spec, p.value);
  const level = p.level ?? (spec.requirements.minimumVerificationLevel === 'V4' ? 'V4' : 'V3');
  const run = `${p.rv}:run`;
  const unsupported = new Set(o.unsupported ?? []);
  const kinds = ALL_RECORD_FACT_KINDS.filter((k) => !unsupported.has(k));
  const pendingIdentity =
    o.pending === undefined
      ? undefined
      : markIdentityOf({
          categoryId: o.category.categoryId,
          holder,
          value: mark,
          resultVersionId: rfxId(`rv:${p.rv}`),
          contentHash: rfxHash(`content:${p.rv}`),
          participantId,
          performanceOrdinal: 1,
        }).identityHash;
  const world = o.world;
  const ratification: RatificationFact | undefined =
    o.pending === undefined || o.ratification === null
      ? undefined
      : {
          provenance: 'REFERENCE_FIXTURE',
          kind: 'RECORD_RATIFIED',
          ref: rfxId(`ratification:${p.rv}`),
          polarity: 'AFFIRM',
          status: 'ACTIVE',
          subject: {
            subjectType: 'RECORD_MARK',
            subjectId: o.pending.recordMarkId,
            subjectHash: o.pending.markHash,
          },
          issuerPrincipalId: world?.ratifierPrincipalId ?? rfxId('nobody'),
          issuerPrincipalType: world?.ratifierType ?? 'PERSON',
          keyId: world?.keyId ?? rfxId('no-key'),
          assurance: 'HOLDER_KEY',
          issuedAt: new Date(Date.parse(occurredAt) + 500 * 60_000).toISOString(),
          ...(o.ratification ?? {}),
        };
  const population = Object.entries(o.population ?? {}).map(([dimension, value]) => ({
    dimension: dimension as PopulationDimension,
    value: value as string,
  }));
  return {
    provenance: 'REFERENCE_FIXTURE',
    assembler: 'reference-fixture/1',
    supportedFactKinds: kinds,
    category: o.category,
    discipline: {
      disciplineVersionId: spec.universe.disciplineVersionId,
      sport: o.discipline?.sport ?? (running ? 'athletics' : 'bowling'),
      discipline: o.discipline?.discipline ?? (running ? 'athletics.100m' : 'bowling.series'),
      metrics: running ? RUNNING_METRICS : BOWLING_METRICS,
    },
    performance: {
      resultVersionId: rfxId(`rv:${p.rv}`),
      resultId: rfxId(`result:${p.rv}`),
      contentHash: rfxHash(`content:${p.rv}`),
      scopeType: 'CONTEST',
      status: p.status ?? 'FINAL',
      ...(p.supersedes === undefined ? {} : { supersedesVersionId: rfxId(`rv:${p.supersedes}`) }),
      ...(p.supersededBy === undefined
        ? {}
        : { supersededByVersionId: rfxId(`rv:${p.supersededBy}`) }),
      competitionId: p.competitionId ?? RFX.competition,
      eventId: RFX.event,
      contestId: rfxId(`contest:${p.rv}`),
      participantId,
      participantKind: team === undefined ? 'INDIVIDUAL' : 'TEAM',
      ...(team === undefined ? { athleteId: holder.holderId } : { teamId: holder.holderId }),
      ordinal: 1,
      mark,
      valid: p.valid ?? true,
      occurredAt,
    },
    verification: {
      state: p.verificationState ?? 'CURRENT',
      runId: rfxId(`run:${run}`),
      policyVersionId: rfxId('policy-v1'),
      snapshotHash: rfxHash(`verification-snapshot:${run}`),
      outcomeHash: rfxHash(`verification-outcome:${run}`),
      level,
      evidenceBundleHash: rfxHash(`evidence-bundle:${run}`),
      evaluatedAsOf: new Date(Date.parse(occurredAt) + 30 * 60_000).toISOString(),
      ...(level === 'V4'
        ? { ratifiedRecordCategoryIds: p.v4CategoryIds ?? [o.category.categoryId] }
        : {}),
    },
    ...(unsupported.has('HOLD_STATE') ? {} : { hold: { active: o.hold ?? false } }),
    ...(o.memberships === undefined
      ? {
          memberships: {
            venueOrganizationId: RFX.venue,
            leagueOrganizationId: RFX.league,
            regionEligibility: spec.scope.region ?? ['CR'],
          },
        }
      : { memberships: o.memberships }),
    ...(population.length === 0 ? {} : { population }),
    ...(o.conditions === undefined ? {} : { conditions: o.conditions }),
    ...(team === undefined
      ? {}
      : {
          creditedLineup: {
            athleteIds: o.creditedLineup ?? [
              rfxId(`athlete:${team}-1`),
              rfxId(`athlete:${team}-2`),
            ],
          },
        }),
    currentMarks: o.currentMarks ?? [],
    ...(o.pending === undefined
      ? {}
      : {
          pendingMark: {
            recordMarkId: o.pending.recordMarkId,
            markHash: o.pending.markHash,
            identityHash: pendingIdentity as string,
            effectiveFrom: occurredAt,
          },
        }),
    ...(ratification === undefined ? {} : { ratification }),
    ...(world === undefined ? {} : { authority: world.authority, keys: world.keys }),
    participation: { conflictedPrincipalIds: [...(o.conflicted ?? [])] },
  } as RecordEvaluationSnapshot;
}

/** A standing (current) mark of the category, for comparison inputs. */
export function standingMark(
  spec: RecordCategorySpec,
  label: string,
  value: string,
  minute: number,
  standing: RecordStanding = 'RATIFIED',
  athlete = label,
): StandingMark {
  return {
    recordMarkId: rfxId(`mark:${label}`),
    markHash: rfxHash(`mark:${label}`),
    holder: { holderType: 'ATHLETE', holderId: rfxId(`athlete:${athlete}`) },
    value: performanceValue(spec, value),
    effectiveFrom: rfxTime(minute),
    standing,
  };
}
