import { CanonicalError, type ContentHash } from '@br/canonical';
import { compareDecimal, evidenceCommitmentOf, precisionFits } from '@br/achievements';
import {
  authorize,
  staticParticipationChecker,
  type AnchorFact,
  type AuthorityFacts,
  type ConflictOfInterestChecker,
  type KeyFact,
} from '@br/authority';
import {
  resultStatusSatisfies,
  verificationLevelIndex,
  type AuthorityGrant,
  type AuthorityScope,
  type GrantStatusChange,
  type HolderType,
  type KeyStatusChange,
  type Mark,
  type MemberCreditRole,
  type Principal,
  type RecordEvaluationState,
  type RecordProvenance,
  type RecordScopeType,
  type RecordStanding,
  type TiePolicy,
  type TrustAnchorStatusChange,
  type Uuid,
  type VerificationLevel,
} from '@br/domain';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';
import {
  categoryFloor,
  RECORD_ENGINE_VERSION,
  requiresV4,
  validateRecordCategorySpec,
  type RecordCategorySpec,
} from './category';
import {
  recordIntegrity,
  sealRecordSnapshot,
  type GoverningRecognition,
  type RecordEvaluationSnapshot,
  type StandingMark,
} from './snapshot';

/**
 * The pure, deterministic record engine (BRT-09 §32):
 *
 *   evaluateRecord(snapshot) → { snapshotHash, outcome, outcomeHash }
 *
 * No database, network, filesystem, clock, randomness or environment. It never assigns a RecordMark
 * id (persistence does) and never re-runs verification (it consumes the BRT-07 summary).
 *
 * Two modes, decided by the snapshot:
 *   ESTABLISH  no pendingMark: may the verified Performance become a PENDING_RATIFICATION mark?
 *   RATIFY     pendingMark + ratification: may that exact pending mark become RATIFIED / CANONICAL?
 *
 * Outcome states (strongly typed; never a probability):
 *   INTEGRITY_FAILURE       the snapshot contradicts itself (category hash, metric, holder, scope,
 *                           pending-mark basis, standing marks violating RC-1) — nothing persists
 *   INELIGIBLE              outside the comparison universe (population, conditions, scope,
 *                           effective period, retired / unpublished version, invalid performance)
 *   DOES_NOT_QUALIFY        not better than the record standing at the performance's sporting time
 *                           (or equal under FIRST_ACHIEVED)
 *   PENDING_REQUIRED_FACTS  a required fact is missing or below its floor (status, verification,
 *                           hold, population / conditions / membership facts, ratification)
 *   QUALIFIES               PENDING_RATIFICATION (ESTABLISH) or RATIFIED / CANONICAL (RATIFY)
 *
 * Precedence: INTEGRITY_FAILURE > INELIGIBLE > DOES_NOT_QUALIFY > PENDING_REQUIRED_FACTS > QUALIFIES.
 * Changing ANY evaluation semantics requires a new engine version (record-engine/2).
 */
export type RecordGateName =
  | 'INTEGRITY'
  | 'CATEGORY'
  | 'EFFECTIVE_PERIOD'
  | 'UNIVERSE'
  | 'RESULT_STATUS'
  | 'SCOPE_MEMBERSHIP'
  | 'POPULATION'
  | 'CONDITIONS'
  | 'HOLD_STATE'
  | 'VERIFICATION'
  | 'HOLDER'
  | 'COMPARISON'
  | 'RATIFICATION';

type GateClass = 'INTEGRITY' | 'INELIGIBLE' | 'COMPARISON' | 'PENDING';

export interface RecordGate {
  readonly gate: RecordGateName;
  readonly status: 'PASS' | 'FAIL';
  readonly reasons?: readonly string[];
}

export type Relation =
  | 'NO_CURRENT_RECORD'
  | 'BETTER'
  | 'EQUAL_SHARED'
  | 'EQUAL_FIRST_ACHIEVED_EARLIER'
  | 'EQUAL'
  | 'WORSE';

export interface ConsideredMark {
  readonly recordMarkId: string;
  readonly markHash: string;
  readonly value: Mark;
}

export interface RecordBasisItem {
  readonly resultVersionId: string;
  readonly contentHash: string;
  readonly resultStatus: string;
  readonly verificationRunId: string;
  readonly verificationSnapshotHash: string;
  readonly verificationOutcomeHash: string;
  readonly verificationLevel: VerificationLevel;
  readonly participantId: string;
  readonly performanceOrdinal: number;
  readonly evidenceBundleHash: string;
  readonly evidenceBundleAsOf: string;
}

/** The content of one RecordMark (`br:record-mark@1`). */
export interface RecordMarkCandidate {
  readonly provenance: RecordProvenance;
  readonly engineVersion: string;
  readonly category: {
    readonly categoryId: string;
    readonly code: string;
    readonly categoryVersionId: string;
    readonly version: number;
    readonly specHash: string;
  };
  readonly scopeType: RecordScopeType;
  readonly tiePolicy: TiePolicy;
  readonly comparator: 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER';
  readonly metric: { readonly key: string; readonly markMetricId: string };
  readonly value: Mark;
  readonly holder: { readonly holderType: HolderType; readonly holderId: string };
  readonly memberCreditBasis: 'NOT_APPLICABLE' | 'CREDITED_LINEUP' | 'CREDITED_LINEUP_UNAVAILABLE';
  readonly memberCredits?: readonly {
    readonly athleteId: string;
    readonly creditRole: MemberCreditRole;
  }[];
  readonly basis: RecordBasisItem;
  readonly basisLevel: VerificationLevel;
  readonly evidenceCommitment: string;
  readonly governingRecognition?: GoverningRecognition;
  readonly context: {
    readonly competitionId: string;
    readonly eventId?: string;
    readonly contestId?: string;
    readonly disciplineVersionId: string;
    readonly sport?: string;
    readonly discipline?: string;
  };
  readonly effectiveFrom: string;
  readonly comparison: {
    readonly relation: Relation;
    readonly currentMarks: readonly ConsideredMark[];
  };
}

export interface RecordEvaluationOutcome {
  readonly engineVersion: string;
  readonly snapshotHash: string;
  readonly provenance: RecordProvenance;
  readonly categoryVersionId: string;
  readonly resultVersionId: string;
  readonly participantId: string;
  readonly performanceOrdinal: number;
  readonly mode: 'ESTABLISH' | 'RATIFY';
  readonly state: RecordEvaluationState;
  readonly markStatus?: 'PENDING_RATIFICATION' | RecordStanding;
  readonly gates: readonly RecordGate[];
  readonly comparison?: {
    readonly comparator: 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER';
    readonly tiePolicy: TiePolicy;
    readonly candidateValue: Mark;
    readonly relation: Relation;
    readonly currentMarks: readonly ConsideredMark[];
    readonly displaces: readonly string[];
  };
  readonly candidate?: {
    readonly candidateHash: string;
    readonly identityHash: string;
    readonly candidate: RecordMarkCandidate;
  };
  readonly ratification?: {
    readonly ref: string;
    readonly kind: 'RECORD_RATIFIED' | 'REVIEW_COMPLETED';
    readonly standing: RecordStanding;
    readonly subjectHash: string;
    readonly authorityProofDigest: string;
    readonly canonicalKeeper: boolean;
    readonly platformReview?: boolean;
  };
}

export interface RecordEvaluation {
  readonly snapshotHash: ContentHash;
  readonly outcome: RecordEvaluationOutcome;
  readonly outcomeHash: ContentHash;
}

function hashDoc(tag: string, schema: { id: string; version: number }, doc: unknown) {
  try {
    return platformCanonicalizer().hashCanonical(tag, schema.id, schema.version, doc);
  } catch (err) {
    if (err instanceof CanonicalError)
      throw recordIntegrity('DOCUMENT_NOT_CANONICAL', `${schema.id}: ${err.code} at ${err.path}`);
    throw err;
  }
}

export function hashMarkCandidate(candidate: unknown): ContentHash {
  return hashDoc(DomainTag.recordMark, SchemaRef.recordMark, candidate).contentHash;
}

/** Natural key: one logical mark per (category, holder, exact value, exact Performance basis). */
export function markIdentityOf(input: {
  readonly categoryId: string;
  readonly holder: { readonly holderType: HolderType; readonly holderId: string };
  readonly value: Mark;
  readonly resultVersionId: string;
  readonly contentHash: string;
  readonly participantId: string;
  readonly performanceOrdinal: number;
}): { readonly identityHash: ContentHash; readonly identity: unknown } {
  const r = hashDoc(DomainTag.recordMarkIdentity, SchemaRef.recordMarkIdentity, {
    categoryId: input.categoryId,
    holder: input.holder,
    value: input.value,
    basis: {
      resultVersionId: input.resultVersionId,
      contentHash: input.contentHash,
      participantId: input.participantId,
      performanceOrdinal: input.performanceOrdinal,
    },
  });
  return { identityHash: r.contentHash, identity: r.normalized };
}

export function hashRecordOutcome(outcome: unknown): ContentHash {
  return hashDoc(DomainTag.recordEvaluationOutcome, SchemaRef.recordEvaluationOutcome, outcome)
    .contentHash;
}

/** Exact Mark equality: metric, canonical value, unit and precision (never floating point). */
export function sameMark(a: Mark, b: Mark): boolean {
  return (
    a.metricId === b.metricId &&
    a.unit === b.unit &&
    a.precision === b.precision &&
    compareDecimal(a.value, b.value) === 0
  );
}

/** -1 worse / 0 equal / 1 better, under the canonical metric comparator (no "higher = better"). */
export function compareUnder(
  order: 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER',
  candidate: string,
  other: string,
): -1 | 0 | 1 {
  const c = compareDecimal(candidate, other);
  return order === 'HIGHER_IS_BETTER' ? c : ((-c || 0) as -1 | 0 | 1);
}

const dedupe = (xs: readonly string[]) => [...new Set(xs)].sort();
const at = (s: string) => new Date(s);
const FAR_HORIZON = new Date('9999-12-31T23:59:59.999Z');

/** Authority facts of the snapshot in the BRT-03 engine vocabulary. */
function toAuthorityFacts(s: RecordEvaluationSnapshot): AuthorityFacts {
  const a = s.authority ?? {};
  const principals: Principal[] = (a.principals ?? []).map((p) => ({
    id: p.principalId as Uuid,
    principalType: p.principalType,
    label: 'snapshot',
    recordedAt: at(p.recordedAt),
  }));
  const keys: KeyFact[] = (s.keys ?? []).map((k) => ({
    id: k.keyId as Uuid,
    principalId: k.principalId as Uuid,
    keyKind: k.keyKind,
    algorithm: k.algorithm,
    verificationMaterial: {},
    effectiveFrom: at(k.effectiveFrom),
    ...(k.effectiveTo === undefined ? {} : { effectiveTo: at(k.effectiveTo) }),
    recordedAt: at(k.recordedAt),
    factHash: k.factHash,
  }));
  const keyStatusChanges: KeyStatusChange[] = (s.keys ?? []).flatMap((k) =>
    (k.statusChanges ?? []).map((c): KeyStatusChange =>
      c.kind === 'COMPROMISED'
        ? {
            id: c.statusChangeId as Uuid,
            keyId: k.keyId as Uuid,
            kind: 'COMPROMISED',
            compromisedSince: at(c.compromisedSince ?? c.effectiveFrom),
            recordedAt: at(c.recordedAt),
            reason: 'snapshot',
          }
        : {
            id: c.statusChangeId as Uuid,
            keyId: k.keyId as Uuid,
            kind: c.kind,
            effectiveFrom: at(c.effectiveFrom),
            recordedAt: at(c.recordedAt),
            reason: 'snapshot',
          },
    ),
  );
  const anchors: AnchorFact[] = (a.anchors ?? []).map((x) => ({
    id: x.anchorId as Uuid,
    principalId: x.principalId as Uuid,
    recognitionScope: x.recognitionScope,
    basisRef: 'snapshot',
    governanceDecisionRef: 'snapshot',
    effectiveFrom: at(x.effectiveFrom),
    ...(x.effectiveTo === undefined ? {} : { effectiveTo: at(x.effectiveTo) }),
    recordedAt: at(x.recordedAt),
    factHash: x.factHash,
  }));
  const anchorStatusChanges: TrustAnchorStatusChange[] = (a.anchorStatusChanges ?? []).map((c) => ({
    id: c.statusChangeId as Uuid,
    anchorId: c.anchorId as Uuid,
    kind: 'REVOKED',
    effectiveFrom: at(c.effectiveFrom),
    recordedAt: at(c.recordedAt),
    reason: 'snapshot',
  }));
  const grants: AuthorityGrant[] = (a.grants ?? []).map((g) => ({
    id: g.grantId as Uuid,
    grantorPrincipalId: g.grantorPrincipalId as Uuid,
    granteePrincipalId: g.granteePrincipalId as Uuid,
    ...(g.parentGrantId === undefined ? {} : { parentGrantId: g.parentGrantId as Uuid }),
    capabilities: g.capabilities,
    scope: g.scope,
    delegation: {
      allowed: g.delegation.allowed,
      maxDepth: g.delegation.maxDepth,
      capabilitiesDelegable: g.delegation.capabilitiesDelegable ?? [],
    },
    constraints: { mustNotBeParticipant: true },
    effectiveFrom: at(g.effectiveFrom),
    ...(g.effectiveTo === undefined ? {} : { effectiveTo: at(g.effectiveTo) }),
    grantHash: g.grantHash,
    recordedAt: at(g.recordedAt),
  }));
  const grantStatusChanges = (a.grantStatusChanges ?? []).map((c) => ({
    id: c.statusChangeId as Uuid,
    grantId: c.grantId as Uuid,
    kind: 'REVOKED',
    compromise: c.compromise,
    effectiveFrom: at(c.effectiveFrom),
    recordedAt: at(c.recordedAt),
    reason: 'snapshot',
  })) as GrantStatusChange[];
  return {
    principals,
    keys,
    keyStatusChanges,
    anchors,
    anchorStatusChanges,
    grants,
    grantStatusChanges,
  };
}

/**
 * The authority request a ratification is evaluated against: RATIFY_RECORD over the category's
 * structural recognition scope — sport, discipline, recognition level, region and (COMPETITION) the
 * performance's competition. The anchor at the root of the chain must cover every dimension.
 */
export function ratificationScope(
  spec: RecordCategorySpec,
  s: Pick<RecordEvaluationSnapshot, 'discipline' | 'performance'>,
): AuthorityScope {
  return {
    ...(s.discipline.sport === undefined ? {} : { sport: [s.discipline.sport] }),
    ...(s.discipline.discipline === undefined ? {} : { discipline: [s.discipline.discipline] }),
    recognitionLevel: [spec.recognition.level],
    ...(spec.recognition.region === undefined ? {} : { region: [...spec.recognition.region] }),
    ...(spec.scope.scopeType === 'COMPETITION'
      ? { competition: [s.performance.competitionId as Uuid] }
      : {}),
  } as AuthorityScope;
}

/** Evaluates one snapshot. Pure and deterministic. */
export function evaluateRecord(input: unknown): RecordEvaluation {
  const { snapshot: s, snapshotHash } = sealRecordSnapshot(input);
  const spec = s.category.spec;
  const perf = s.performance;
  const supported = new Set(s.supportedFactKinds);
  const mode: 'ESTABLISH' | 'RATIFY' = s.pendingMark === undefined ? 'ESTABLISH' : 'RATIFY';

  const failures: { gate: RecordGateName; cls: GateClass; reason: string }[] = [];
  const evaluated = new Set<RecordGateName>();
  const fail = (gate: RecordGateName, cls: GateClass, reason: string) =>
    failures.push({ gate, cls, reason });
  const touch = (...gs: RecordGateName[]) => gs.forEach((g) => evaluated.add(g));

  // ─────────────── integrity: the snapshot must not contradict itself ───────────────
  touch('INTEGRITY');
  const v = validateRecordCategorySpec(spec);
  if (!v.ok || v.specHash !== s.category.specHash)
    fail('INTEGRITY', 'INTEGRITY', 'CATEGORY_HASH_MISMATCH');
  if (spec.universe.disciplineVersionId !== s.discipline.disciplineVersionId)
    fail('INTEGRITY', 'INTEGRITY', 'DISCIPLINE_VERSION_MISMATCH');
  if (
    s.discipline.sport !== undefined &&
    JSON.stringify(spec.recognition.sport) !== JSON.stringify([s.discipline.sport])
  )
    fail('INTEGRITY', 'INTEGRITY', 'RECOGNITION_SPORT_MISMATCH');
  const metric = s.discipline.metrics.find((m) => m.key === spec.universe.metric.key);
  const order =
    metric?.order === 'HIGHER_IS_BETTER' || metric?.order === 'LOWER_IS_BETTER'
      ? metric.order
      : undefined;
  if (metric === undefined) fail('INTEGRITY', 'INTEGRITY', 'METRIC_UNKNOWN');
  else if (order === undefined) fail('INTEGRITY', 'INTEGRITY', 'METRIC_NOT_COMPARABLE');
  if (perf.mark.metricId !== spec.universe.metric.markMetricId)
    fail('INTEGRITY', 'INTEGRITY', 'METRIC_MISMATCH');
  if (perf.participantKind === 'INDIVIDUAL') {
    if (perf.athleteId === undefined) fail('INTEGRITY', 'INTEGRITY', 'HOLDER_UNRESOLVED');
    if (perf.performanceAthleteId !== undefined && perf.performanceAthleteId !== perf.athleteId)
      fail('INTEGRITY', 'INTEGRITY', 'HOLDER_MISMATCH');
    if (perf.teamId !== undefined) fail('INTEGRITY', 'INTEGRITY', 'HOLDER_MISMATCH');
  } else if (perf.teamId === undefined || perf.athleteId !== undefined)
    fail('INTEGRITY', 'INTEGRITY', 'HOLDER_UNRESOLVED');
  for (const m of s.currentMarks)
    if (m.value.metricId !== spec.universe.metric.markMetricId)
      fail('INTEGRITY', 'INTEGRITY', 'STANDING_MARK_METRIC_MISMATCH');
  const first = s.currentMarks[0];
  if (first !== undefined && s.currentMarks.some((m) => !sameMark(m.value, first.value)))
    fail('INTEGRITY', 'INTEGRITY', 'STANDING_MARKS_NOT_EQUAL');
  if (spec.tiePolicy === 'FIRST_ACHIEVED' && s.currentMarks.length > 1)
    fail('INTEGRITY', 'INTEGRITY', 'STANDING_MARKS_VIOLATE_RC1');
  if (s.ratification !== undefined && s.pendingMark === undefined)
    fail('INTEGRITY', 'INTEGRITY', 'RATIFICATION_WITHOUT_PENDING_MARK');

  // ─────────────── holder (the durable public sporting identity) ───────────────
  touch('HOLDER');
  const lineup = supported.has('CREDITED_LINEUP') ? s.creditedLineup : undefined;
  let holder: { holderType: HolderType; holderId: string } | undefined;
  let credits: string[] = [];
  let creditBasis: RecordMarkCandidate['memberCreditBasis'] = 'NOT_APPLICABLE';
  if (spec.universe.holderType === 'ATHLETE') {
    if (perf.participantKind === 'INDIVIDUAL' && perf.athleteId !== undefined)
      holder = { holderType: 'ATHLETE', holderId: perf.athleteId };
    else if (perf.participantKind === 'TEAM' && perf.performanceAthleteId !== undefined) {
      // An athlete's own performance inside a team entry: credited only through the lineup (AC-5).
      if (lineup === undefined) fail('HOLDER', 'PENDING', 'CREDITED_LINEUP_UNAVAILABLE');
      else if (!lineup.athleteIds.includes(perf.performanceAthleteId))
        fail('HOLDER', 'INELIGIBLE', 'PERFORMANCE_ATHLETE_NOT_CREDITED');
      else holder = { holderType: 'ATHLETE', holderId: perf.performanceAthleteId };
    } else fail('HOLDER', 'INELIGIBLE', 'HOLDER_TYPE_NOT_IN_UNIVERSE');
  } else if (perf.participantKind === 'TEAM' && perf.teamId !== undefined) {
    if (perf.performanceAthleteId !== undefined)
      fail('HOLDER', 'INELIGIBLE', 'HOLDER_TYPE_NOT_IN_UNIVERSE');
    else {
      holder = { holderType: 'TEAM', holderId: perf.teamId };
      if (lineup === undefined) {
        creditBasis = 'CREDITED_LINEUP_UNAVAILABLE';
        fail('HOLDER', 'PENDING', 'MEMBER_CREDITS_UNAVAILABLE');
      } else {
        creditBasis = 'CREDITED_LINEUP';
        credits = dedupe(lineup.athleteIds);
      }
    }
  } else fail('HOLDER', 'INELIGIBLE', 'HOLDER_TYPE_NOT_IN_UNIVERSE');

  if (s.pendingMark !== undefined && holder !== undefined) {
    const id = markIdentityOf({
      categoryId: s.category.categoryId,
      holder,
      value: perf.mark,
      resultVersionId: perf.resultVersionId,
      contentHash: perf.contentHash,
      participantId: perf.participantId,
      performanceOrdinal: perf.ordinal,
    });
    if (id.identityHash !== s.pendingMark.identityHash)
      fail('INTEGRITY', 'INTEGRITY', 'PENDING_MARK_BASIS_MISMATCH');
    if (s.currentMarks.some((m) => m.recordMarkId === s.pendingMark?.recordMarkId))
      fail('INTEGRITY', 'INTEGRITY', 'STANDING_INCLUDES_PENDING_MARK');
    if (perf.occurredAt !== undefined && perf.occurredAt !== s.pendingMark.effectiveFrom)
      fail('INTEGRITY', 'INTEGRITY', 'PENDING_MARK_TIME_MISMATCH');
  }

  // ─────────────── category version: only PUBLISHED versions establish records ───────────────
  touch('CATEGORY');
  if (s.category.lifecycle === 'RETIRED')
    fail('CATEGORY', 'INELIGIBLE', 'CATEGORY_VERSION_RETIRED');
  else if (s.category.lifecycle !== 'PUBLISHED')
    fail('CATEGORY', 'INELIGIBLE', 'CATEGORY_VERSION_NOT_PUBLISHED');

  // ─────────────── effective period: the sporting time, never platform time ───────────────
  touch('EFFECTIVE_PERIOD');
  if (!supported.has('CONTEST_OCCURRENCE') || perf.occurredAt === undefined)
    fail('EFFECTIVE_PERIOD', 'PENDING', 'OCCURRENCE_TIME_UNKNOWN');
  else if (at(perf.occurredAt).getTime() < at(spec.effectiveFrom).getTime())
    fail('EFFECTIVE_PERIOD', 'INELIGIBLE', 'PERFORMANCE_BEFORE_CATEGORY_EFFECTIVE_FROM');

  // ─────────────── universe: exact metric semantics ───────────────
  touch('UNIVERSE');
  if (perf.scopeType !== spec.universe.resultScope)
    fail('UNIVERSE', 'INELIGIBLE', 'RESULT_SCOPE_MISMATCH');
  if (metric !== undefined) {
    if (perf.mark.unit !== metric.unit) fail('UNIVERSE', 'INELIGIBLE', 'METRIC_UNIT_MISMATCH');
    if (!precisionFits(metric.valueType, perf.mark.precision))
      fail('UNIVERSE', 'INELIGIBLE', 'METRIC_PRECISION_MISMATCH');
    if (metric.valueType === 'DURATION_MS' && perf.mark.value.startsWith('-'))
      fail('UNIVERSE', 'INELIGIBLE', 'METRIC_VALUE_OUT_OF_DOMAIN');
  }
  if (!perf.valid) fail('UNIVERSE', 'INELIGIBLE', 'PERFORMANCE_INVALID');

  // ─────────────── result lifecycle ───────────────
  touch('RESULT_STATUS');
  if (!supported.has('RESULT_STATUS'))
    fail('RESULT_STATUS', 'PENDING', 'RESULT_STATUS_UNAVAILABLE');
  else if (perf.supersededByVersionId !== undefined || perf.status === 'SUPERSEDED')
    fail('RESULT_STATUS', 'INELIGIBLE', 'RESULT_SUPERSEDED');
  else if (perf.status === 'REVOKED') fail('RESULT_STATUS', 'INELIGIBLE', 'RESULT_REVOKED');
  else if (perf.status === 'REJECTED') fail('RESULT_STATUS', 'INELIGIBLE', 'RESULT_REJECTED');
  else if (!resultStatusSatisfies(perf.status, spec.requirements.minimumResultStatus))
    fail('RESULT_STATUS', 'PENDING', 'RESULT_STATUS_BELOW_REQUIRED');

  // ─────────────── structural scope membership ───────────────
  touch('SCOPE_MEMBERSHIP');
  const ms = s.memberships ?? {};
  switch (spec.scope.scopeType) {
    case 'COMPETITION':
      if (!supported.has('COMPETITION_MEMBERSHIP'))
        fail('SCOPE_MEMBERSHIP', 'PENDING', 'COMPETITION_MEMBERSHIP_UNAVAILABLE');
      else if (!(spec.scope.competitionIds ?? []).includes(perf.competitionId))
        fail('SCOPE_MEMBERSHIP', 'INELIGIBLE', 'OUTSIDE_COMPETITION_SCOPE');
      break;
    case 'VENUE':
      if (!supported.has('VENUE_MEMBERSHIP') || ms.venueOrganizationId === undefined)
        fail('SCOPE_MEMBERSHIP', 'PENDING', 'VENUE_MEMBERSHIP_UNAVAILABLE');
      else if (ms.venueOrganizationId !== spec.scope.venueOrganizationId)
        fail('SCOPE_MEMBERSHIP', 'INELIGIBLE', 'OUTSIDE_VENUE_SCOPE');
      break;
    case 'LEAGUE':
      if (!supported.has('LEAGUE_MEMBERSHIP') || ms.leagueOrganizationId === undefined)
        fail('SCOPE_MEMBERSHIP', 'PENDING', 'LEAGUE_MEMBERSHIP_UNAVAILABLE');
      else if (ms.leagueOrganizationId !== spec.scope.leagueOrganizationId)
        fail('SCOPE_MEMBERSHIP', 'INELIGIBLE', 'OUTSIDE_LEAGUE_SCOPE');
      break;
    case 'NATIONAL':
    case 'CONTINENTAL':
      if (!supported.has('REGION_ELIGIBILITY') || ms.regionEligibility === undefined)
        fail('SCOPE_MEMBERSHIP', 'PENDING', 'REGION_ELIGIBILITY_UNAVAILABLE');
      else if (!ms.regionEligibility.some((r) => (spec.scope.region ?? []).includes(r)))
        fail('SCOPE_MEMBERSHIP', 'INELIGIBLE', 'OUTSIDE_REGION_POPULATION');
      break;
    default:
      break; // PLATFORM / WORLD: every performance of the exact DisciplineVersion + metric.
  }

  // ─────────────── RC-4 population: typed facts only; absence is never a default ───────────────
  touch('POPULATION');
  const popFacts = supported.has('POPULATION')
    ? new Map((s.population ?? []).map((p) => [p.dimension, p.value]))
    : undefined;
  const required: [string, string | undefined][] = [
    ['HANDICAP_MODE', spec.population.handicapMode],
    ['GENDER_CATEGORY', spec.population.genderCategory],
    ['AGE_GROUP', spec.population.ageGroup],
    ['WEIGHT_CLASS', spec.population.weightClass],
    ['EQUIPMENT_CLASS', spec.population.equipmentClass],
  ];
  for (const [dimension, want] of required) {
    if (want === undefined) continue;
    const got = popFacts?.get(dimension as never);
    if (got === undefined) {
      fail('POPULATION', 'PENDING', 'POPULATION_FACT_UNAVAILABLE');
      fail('POPULATION', 'PENDING', `${dimension}_UNKNOWN`);
    } else if (got !== want) {
      fail('POPULATION', 'INELIGIBLE', 'POPULATION_MISMATCH');
      if (dimension === 'HANDICAP_MODE' && want === 'SCRATCH' && got === 'HANDICAP')
        fail('POPULATION', 'INELIGIBLE', 'HANDICAP_VALUE_IN_SCRATCH_CATEGORY');
    }
  }

  // ─────────────── conditions: authority-evaluated facts; unknown fails closed ───────────────
  touch('CONDITIONS');
  const condFacts = supported.has('CONDITIONS')
    ? new Map((s.conditions ?? []).map((c) => [c.aspect, c]))
    : undefined;
  for (const c of spec.conditions) {
    const f = condFacts?.get(c.aspect);
    if (f === undefined) {
      fail('CONDITIONS', 'PENDING', 'CONDITIONS_FACT_UNAVAILABLE');
      continue;
    }
    if (!f.compliant) {
      fail('CONDITIONS', 'INELIGIBLE', 'CONDITION_NOT_MET');
      continue;
    }
    if (c.requirement === 'COMPLIANT') continue;
    if (f.value === undefined || f.unit === undefined)
      fail('CONDITIONS', 'PENDING', 'CONDITION_VALUE_UNKNOWN');
    else if (f.unit !== c.unit) fail('CONDITIONS', 'INELIGIBLE', 'CONDITION_UNIT_MISMATCH');
    else {
      const cmp = compareDecimal(f.value, c.limit ?? '0');
      if (c.requirement === 'MAXIMUM' && cmp > 0)
        fail('CONDITIONS', 'INELIGIBLE', 'CONDITION_LIMIT_EXCEEDED');
      if (c.requirement === 'MINIMUM' && cmp < 0)
        fail('CONDITIONS', 'INELIGIBLE', 'CONDITION_LIMIT_NOT_REACHED');
    }
  }

  // ─────────────── hold: absence of hold facts is never "no hold" ───────────────
  touch('HOLD_STATE');
  if (!supported.has('HOLD_STATE') || s.hold === undefined)
    fail('HOLD_STATE', 'PENDING', 'HOLD_STATE_UNAVAILABLE');
  else if (s.hold.active) fail('HOLD_STATE', 'PENDING', 'HOLD_ACTIVE');

  // ─────────────── verification floor (BRT-01 §7; V4 only after human ratification) ───────────────
  touch('VERIFICATION');
  const vs = s.verification;
  const floor = categoryFloor(spec);
  const v4 = requiresV4(spec);
  const r = s.ratification;
  const platformReview =
    spec.scope.scopeType === 'PLATFORM' && spec.platformReview === true && floor === 'V3';
  // ESTABLISH: a V4 category admits a pending claim at V3 (V4 needs the ratification first); a
  // PLATFORM review category admits V2 (the review is the ratification). RATIFY: the full floor.
  let admissible: VerificationLevel = floor;
  if (mode === 'ESTABLISH' && v4) admissible = 'V3';
  if (platformReview) admissible = 'V2';
  let usedPlatformReview = false;
  if (!supported.has('VERIFICATION')) fail('VERIFICATION', 'PENDING', 'VERIFICATION_UNAVAILABLE');
  else if (vs.state === 'STALE') fail('VERIFICATION', 'PENDING', 'VERIFICATION_STALE');
  else if (vs.state === 'NOT_EVALUATED')
    fail('VERIFICATION', 'PENDING', 'VERIFICATION_NOT_EVALUATED');
  else if (vs.state === 'POLICY_UNAVAILABLE')
    fail('VERIFICATION', 'PENDING', 'VERIFICATION_POLICY_UNAVAILABLE');
  else if (
    vs.runId === undefined ||
    vs.snapshotHash === undefined ||
    vs.outcomeHash === undefined ||
    vs.level === undefined ||
    vs.evidenceBundleHash === undefined ||
    vs.evaluatedAsOf === undefined
  )
    fail('VERIFICATION', 'PENDING', 'VERIFICATION_RUN_INCOMPLETE');
  else if (verificationLevelIndex(vs.level) < verificationLevelIndex(admissible))
    fail('VERIFICATION', 'PENDING', 'VERIFICATION_LEVEL_BELOW_REQUIRED');
  else if (mode === 'RATIFY') {
    if (v4 && !(vs.ratifiedRecordCategoryIds ?? []).includes(s.category.categoryId))
      fail('VERIFICATION', 'PENDING', 'V4_NOT_ESTABLISHED_FOR_CATEGORY');
    if (platformReview && verificationLevelIndex(vs.level) < verificationLevelIndex('V3')) {
      // The PLATFORM "V2 + platform review" alternative: only a REVIEW_COMPLETED ratifies it.
      if (r?.kind !== 'REVIEW_COMPLETED')
        fail('VERIFICATION', 'PENDING', 'PLATFORM_REVIEW_REQUIRED_BELOW_V3');
      else usedPlatformReview = true;
    }
  }

  // ─────────────── comparison against the record standing at the sporting time ───────────────
  touch('COMPARISON');
  let relation: Relation = 'NO_CURRENT_RECORD';
  const displaces: string[] = [];
  const standing: readonly StandingMark[] = s.currentMarks;
  if (order !== undefined && standing[0] !== undefined) {
    const c = compareUnder(order, perf.mark.value, standing[0].value.value);
    if (c > 0) {
      relation = 'BETTER';
      displaces.push(...standing.map((m) => m.recordMarkId));
    } else if (c < 0) {
      relation = 'WORSE';
      fail('COMPARISON', 'COMPARISON', 'NOT_BETTER_THAN_CURRENT_RECORD');
    } else if (spec.tiePolicy === 'SHARED') relation = 'EQUAL_SHARED';
    else {
      relation = 'EQUAL';
      fail('COMPARISON', 'COMPARISON', 'EQUALS_CURRENT_RECORD_FIRST_ACHIEVED');
    }
  }

  // ─────────────── ratification (RATIFY mode): explicit, authorized, bound to the mark hash ───────
  let ratificationOut: RecordEvaluationOutcome['ratification'];
  if (mode === 'RATIFY') {
    touch('RATIFICATION');
    const pm = s.pendingMark;
    const before = failures.length;
    if (!supported.has('RATIFICATION')) fail('RATIFICATION', 'PENDING', 'RATIFICATION_UNAVAILABLE');
    else if (r === undefined) fail('RATIFICATION', 'PENDING', 'RATIFICATION_MISSING');
    else {
      if (pm === undefined || r.subject.subjectId !== pm.recordMarkId)
        fail('RATIFICATION', 'PENDING', 'RATIFICATION_SUBJECT_MISMATCH');
      else if (r.subject.subjectHash !== pm.markHash)
        fail('RATIFICATION', 'PENDING', 'RATIFICATION_SUBJECT_HASH_MISMATCH');
      if (r.polarity !== 'AFFIRM') fail('RATIFICATION', 'PENDING', 'RATIFICATION_DENIED');
      if (r.status !== 'ACTIVE') fail('RATIFICATION', 'PENDING', 'RATIFICATION_NOT_ACTIVE');
      if (r.issuerPrincipalType !== 'PERSON' && r.issuerPrincipalType !== 'ORGANIZATION')
        fail('RATIFICATION', 'PENDING', 'RATIFIER_NOT_HUMAN');
      // BRT-01 V4: every counted signature HOLDER_KEY / DEVICE_KEY — never PLATFORM_WITNESSED.
      if (v4 && r.assurance === 'PLATFORM_WITNESSED')
        fail('RATIFICATION', 'PENDING', 'RATIFICATION_ASSURANCE_INSUFFICIENT');
      if (r.kind === 'REVIEW_COMPLETED' && spec.scope.scopeType === 'PLATFORM' && !platformReview)
        fail('RATIFICATION', 'PENDING', 'PLATFORM_REVIEW_NOT_ADMITTED');
      const checker: ConflictOfInterestChecker = supported.has('PARTICIPATION')
        ? staticParticipationChecker(
            (s.participation?.conflictedPrincipalIds ?? []).map((principalId) => ({
              principalId: principalId as Uuid,
              scope: {},
            })),
            'record-snapshot-participation/1',
          )
        : { id: 'record-participation-unavailable', check: () => 'UNAVAILABLE' };
      const decision = authorize(
        toAuthorityFacts(s),
        {
          principalId: r.issuerPrincipalId as Uuid,
          keyId: r.keyId as Uuid,
          ...(r.signedAt === undefined ? {} : { signedAt: at(r.signedAt) }),
          capability: 'RATIFY_RECORD',
          scope: ratificationScope(spec, s),
          atTime: at(r.issuedAt),
          asOf: FAR_HORIZON,
        },
        { conflictChecker: checker, evaluatedAt: at(r.issuedAt) },
      );
      if (!decision.authorized) {
        fail('RATIFICATION', 'PENDING', 'RATIFICATION_NOT_AUTHORIZED');
        fail('RATIFICATION', 'PENDING', `RATIFY_RECORD_${decision.reason}`);
      }
      if (failures.length === before && pm !== undefined) {
        const keeper =
          spec.canonicalKeeper !== undefined &&
          spec.scope.scopeType !== 'PLATFORM' &&
          r.kind === 'RECORD_RATIFIED' &&
          r.issuerPrincipalId === spec.canonicalKeeper.principalId;
        ratificationOut = {
          ref: r.ref,
          kind: r.kind,
          standing: keeper ? 'CANONICAL' : 'RATIFIED',
          subjectHash: r.subject.subjectHash,
          authorityProofDigest: decision.proofDigest,
          canonicalKeeper: keeper,
          ...(usedPlatformReview ? { platformReview: true } : {}),
        };
      }
    }
  }

  // ─────────────── state ───────────────
  const classes = new Set(failures.map((f) => f.cls));
  const state: RecordEvaluationState = classes.has('INTEGRITY')
    ? 'INTEGRITY_FAILURE'
    : classes.has('INELIGIBLE')
      ? 'INELIGIBLE'
      : classes.has('COMPARISON')
        ? 'DOES_NOT_QUALIFY'
        : classes.has('PENDING')
          ? 'PENDING_REQUIRED_FACTS'
          : 'QUALIFIES';
  const gates: RecordGate[] = [...evaluated].map((gate) => {
    const reasons = dedupe(failures.filter((f) => f.gate === gate).map((f) => f.reason));
    return reasons.length === 0 ? { gate, status: 'PASS' } : { gate, status: 'FAIL', reasons };
  });

  const considered: ConsideredMark[] = standing.map((m) => ({
    recordMarkId: m.recordMarkId,
    markHash: m.markHash,
    value: m.value,
  }));
  let candidate: RecordEvaluationOutcome['candidate'];
  if (
    state === 'QUALIFIES' &&
    mode === 'ESTABLISH' &&
    holder !== undefined &&
    order !== undefined &&
    vs.runId !== undefined &&
    vs.snapshotHash !== undefined &&
    vs.outcomeHash !== undefined &&
    vs.level !== undefined &&
    vs.evidenceBundleHash !== undefined &&
    vs.evaluatedAsOf !== undefined &&
    perf.occurredAt !== undefined
  ) {
    const basis: RecordBasisItem = {
      resultVersionId: perf.resultVersionId,
      contentHash: perf.contentHash,
      resultStatus: perf.status,
      verificationRunId: vs.runId,
      verificationSnapshotHash: vs.snapshotHash,
      verificationOutcomeHash: vs.outcomeHash,
      verificationLevel: vs.level,
      participantId: perf.participantId,
      performanceOrdinal: perf.ordinal,
      evidenceBundleHash: vs.evidenceBundleHash,
      evidenceBundleAsOf: vs.evaluatedAsOf,
    };
    const content: RecordMarkCandidate = {
      provenance: s.provenance,
      engineVersion: RECORD_ENGINE_VERSION,
      category: {
        categoryId: s.category.categoryId,
        code: s.category.code,
        categoryVersionId: s.category.categoryVersionId,
        version: s.category.version,
        specHash: s.category.specHash,
      },
      scopeType: spec.scope.scopeType,
      tiePolicy: spec.tiePolicy,
      comparator: order,
      metric: spec.universe.metric,
      // RecordMark.value is EXACTLY the canonical Performance mark (never caller-supplied).
      value: perf.mark,
      holder,
      memberCreditBasis: creditBasis,
      ...(credits.length === 0
        ? {}
        : {
            memberCredits: credits.map((athleteId) => ({
              athleteId,
              creditRole: 'LINEUP_MEMBER' as const,
            })),
          }),
      basis,
      basisLevel: vs.level,
      evidenceCommitment: evidenceCommitmentOf([
        { ...basis, performanceOrdinal: basis.performanceOrdinal },
      ]),
      ...(vs.governingRecognition === undefined
        ? {}
        : { governingRecognition: vs.governingRecognition }),
      context: {
        competitionId: perf.competitionId,
        ...(perf.eventId === undefined ? {} : { eventId: perf.eventId }),
        ...(perf.contestId === undefined ? {} : { contestId: perf.contestId }),
        disciplineVersionId: s.discipline.disciplineVersionId,
        ...(s.discipline.sport === undefined ? {} : { sport: s.discipline.sport }),
        ...(s.discipline.discipline === undefined ? {} : { discipline: s.discipline.discipline }),
      },
      // The sporting effective time: the performance, never ratification or insertion time.
      effectiveFrom: perf.occurredAt,
      comparison: { relation, currentMarks: considered },
    };
    const h = hashDoc(DomainTag.recordMark, SchemaRef.recordMark, content);
    const normalized = h.normalized as unknown as RecordMarkCandidate;
    candidate = {
      candidateHash: h.contentHash,
      identityHash: markIdentityOf({
        categoryId: s.category.categoryId,
        holder,
        value: perf.mark,
        resultVersionId: perf.resultVersionId,
        contentHash: perf.contentHash,
        participantId: perf.participantId,
        performanceOrdinal: perf.ordinal,
      }).identityHash,
      candidate: normalized,
    };
  }

  const outcome: RecordEvaluationOutcome = {
    engineVersion: RECORD_ENGINE_VERSION,
    snapshotHash,
    provenance: s.provenance,
    categoryVersionId: s.category.categoryVersionId,
    resultVersionId: perf.resultVersionId,
    participantId: perf.participantId,
    performanceOrdinal: perf.ordinal,
    mode,
    state,
    ...(state === 'QUALIFIES'
      ? {
          markStatus:
            mode === 'ESTABLISH'
              ? ('PENDING_RATIFICATION' as const)
              : (ratificationOut?.standing ?? 'RATIFIED'),
        }
      : {}),
    gates,
    ...(order === undefined
      ? {}
      : {
          comparison: {
            comparator: order,
            tiePolicy: spec.tiePolicy,
            candidateValue: perf.mark,
            relation,
            currentMarks: considered,
            displaces,
          },
        }),
    ...(candidate === undefined ? {} : { candidate }),
    ...(state === 'QUALIFIES' && ratificationOut !== undefined
      ? { ratification: ratificationOut }
      : {}),
  };
  const o = hashDoc(DomainTag.recordEvaluationOutcome, SchemaRef.recordEvaluationOutcome, outcome);
  return {
    snapshotHash,
    outcome: o.normalized as unknown as RecordEvaluationOutcome,
    outcomeHash: o.contentHash,
  };
}

/** The blocking reasons of an evaluation, flattened (for audit / public explanations). */
export function recordBlockingReasons(outcome: RecordEvaluationOutcome): string[] {
  return dedupe(outcome.gates.flatMap((g) => (g.status === 'FAIL' ? (g.reasons ?? []) : [])));
}

/** Hash of the ratification document a RATIFIED / CANONICAL status entry (and a RECORD_SET) pins. */
export function ratificationHash(doc: {
  readonly recordMarkId: string;
  readonly markHash: string;
  readonly provenance: 'CANONICAL_ATTESTATION' | 'REFERENCE_FIXTURE';
  readonly kind: 'RECORD_RATIFIED' | 'REVIEW_COMPLETED';
  readonly ref: string;
  readonly subjectHash: string;
  readonly standing: RecordStanding;
  readonly authorityProofDigest: string;
  readonly evaluationSnapshotHash: string;
  readonly evaluationOutcomeHash: string;
  readonly verificationRunId: string;
  readonly verificationLevel: VerificationLevel;
}): ContentHash {
  return hashDoc(DomainTag.recordRatification, SchemaRef.recordRatification, doc).contentHash;
}
