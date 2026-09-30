import { CanonicalError, type ContentHash } from '@br/canonical';
import {
  DomainError,
  DomainErrorCode,
  resultStatusSatisfies,
  verificationLevelIndex,
  type AchievementType,
  type AuthorityScope,
  type DerivationProvenance,
  type HolderType,
  type Mark,
  type MemberCreditRole,
  type VerificationLevel,
} from '@br/domain';
import { scopeContains, wideningDimensions } from '@br/authority';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';
import { precisionFits, satisfiesThreshold, strictlyBetter } from './marks';
import {
  ACHIEVEMENT_ENGINE_VERSION,
  RECOGNITION_RANK,
  effectiveRequirements,
  validateAchievementRuleSpec,
  type AchievementRuleSpec,
} from './rule';
import {
  creditedLineupHash,
  sealDerivationSnapshot,
  type AchievementDerivationSnapshot,
  type GoverningRecognition,
  type SnapshotComparison,
  type SnapshotPerformance,
} from './snapshot';

/**
 * The pure, deterministic Achievement engine (BRT-08 §33):
 *
 *   deriveAchievements(snapshot) → { snapshotHash, outcome, outcomeHash }
 *
 * No database, network, filesystem, clock, randomness or environment. It never assigns an
 * Achievement id (persistence does) and never re-runs verification: it consumes the BRT-07 summary
 * in the snapshot. Issuance GATES (rule applicability, result status, CURRENT verification at the
 * rule's level, hold state) are evaluated separately from the SPORTING question ("would this subject
 * qualify on the facts?") so a trace can say "the facts match the rule but the verification floor is
 * unmet" — and no candidate is ever produced unless every gate passes.
 *
 * Changing ANY derivation semantics requires a new engine version (achievement-engine/2).
 */
export type GateName =
  | 'RULE_APPLICABILITY'
  | 'RESULT_STATUS'
  | 'VERIFICATION'
  | 'HOLD_STATE'
  | 'OCCURRENCE'
  | 'GOVERNING_RECOGNITION';

export interface Gate {
  readonly gate: GateName;
  readonly status: 'PASS' | 'FAIL';
  readonly reasons?: readonly string[];
}

export interface SubjectEvaluation {
  readonly subjectKey: string;
  readonly participantId: string;
  readonly performanceOrdinal?: number;
  readonly qualifies: boolean;
  readonly reasons?: readonly string[];
}

export interface BasisItem {
  readonly resultVersionId: string;
  readonly contentHash: string;
  readonly resultStatus: string;
  readonly verificationRunId: string;
  readonly verificationSnapshotHash: string;
  readonly verificationOutcomeHash: string;
  readonly verificationLevel: VerificationLevel;
  readonly participantId: string;
  readonly performanceOrdinal?: number;
  readonly creditedLineupHash?: string;
  readonly evidenceBundleHash: string;
  readonly evidenceBundleAsOf: string;
}

export type MemberCreditBasis =
  'NOT_APPLICABLE' | 'CREDITED_LINEUP' | 'CREDITED_LINEUP_UNAVAILABLE';

export interface AchievementCandidate {
  readonly provenance: DerivationProvenance;
  readonly engineVersion: string;
  readonly achievementType: AchievementType;
  readonly rule: {
    readonly ruleId: string;
    readonly ruleVersionId: string;
    readonly code: string;
    readonly version: number;
    readonly specHash: string;
  };
  readonly holder: { readonly holderType: HolderType; readonly holderId: string };
  readonly memberCreditBasis: MemberCreditBasis;
  readonly memberCredits?: readonly {
    readonly athleteId: string;
    readonly creditRole: MemberCreditRole;
  }[];
  readonly scope: {
    readonly scopeType: 'CONTEST' | 'ROUND' | 'EVENT' | 'COMPETITION' | 'CAREER';
    readonly scopeId: string;
  };
  readonly context: {
    readonly competitionId: string;
    readonly eventId?: string;
    readonly contestId?: string;
    readonly disciplineVersionId: string;
    readonly sport?: string;
    readonly discipline?: string;
  };
  readonly basis: readonly BasisItem[];
  readonly basisLevel: VerificationLevel;
  readonly qualifyingValue?: Mark;
  readonly comparisonSetHash?: string;
  /** BRT-01 §8.1 evidenceCommitment (see `evidenceCommitmentOf`). */
  readonly evidenceCommitment: string;
  /** BRT-01 §8.1 governingAuthority, pinned from the basis run's immutable trace. */
  readonly governingAuthority?: GoverningRecognition;
}

export interface CandidateEntry {
  readonly candidateHash: string;
  readonly identityHash: string;
  readonly candidate: AchievementCandidate;
}

export type DerivationState = 'ISSUABLE' | 'BLOCKED' | 'NO_QUALIFYING_FACTS';

export interface DerivationOutcome {
  readonly engineVersion: string;
  readonly snapshotHash: string;
  readonly provenance: DerivationProvenance;
  readonly ruleVersionId: string;
  readonly resultVersionId: string;
  readonly state: DerivationState;
  readonly gates: readonly Gate[];
  readonly subjects?: readonly SubjectEvaluation[];
  readonly candidates?: readonly CandidateEntry[];
}

export interface Derivation {
  readonly snapshotHash: ContentHash;
  readonly outcome: DerivationOutcome;
  readonly outcomeHash: ContentHash;
}

const integrity = (reason: string, message: string) =>
  new DomainError(DomainErrorCode.ACHIEVEMENT_INTEGRITY_FAILURE, message, { reason });

function hashDoc(tag: string, schema: { id: string; version: number }, doc: unknown) {
  try {
    return platformCanonicalizer().hashCanonical(tag, schema.id, schema.version, doc);
  } catch (err) {
    if (err instanceof CanonicalError)
      throw integrity('DOCUMENT_NOT_CANONICAL', `${schema.id}: ${err.code} at ${err.path}`);
    throw err;
  }
}

export function hashCandidate(candidate: unknown): ContentHash {
  return hashDoc(DomainTag.achievementCandidate, SchemaRef.achievementCandidate, candidate)
    .contentHash;
}

/** AC-2: (achievementType, ruleVersion, holder, scope, basis set) → one logical Achievement. */
export function identityOf(candidate: AchievementCandidate): {
  readonly identityHash: ContentHash;
  readonly identity: unknown;
} {
  const identity = {
    achievementType: candidate.achievementType,
    ruleVersionId: candidate.rule.ruleVersionId,
    holder: candidate.holder,
    scope: candidate.scope,
    basis: candidate.basis.map((b) => ({
      resultVersionId: b.resultVersionId,
      contentHash: b.contentHash,
      verificationRunId: b.verificationRunId,
      participantId: b.participantId,
      ...(b.performanceOrdinal === undefined ? {} : { performanceOrdinal: b.performanceOrdinal }),
      ...(b.creditedLineupHash === undefined ? {} : { creditedLineupHash: b.creditedLineupHash }),
    })),
  };
  const r = hashDoc(DomainTag.achievementIdentity, SchemaRef.achievementIdentity, identity);
  return { identityHash: r.contentHash, identity: r.normalized };
}

/**
 * BRT-01 §8.1 evidenceCommitment = H("achievement-evidence-commitment", {basis: [{resultVersionId,
 * contentHash, verificationRunId, evidenceBundleHash, evidenceBundleAsOf}]}): a commitment to the
 * exact evidence / attestation basis (the BRT-06 Evidence Bundle each pinned run evaluated). Any
 * change of evidence or attestations yields another bundle hash, hence another commitment.
 */
export function evidenceCommitmentOf(basis: readonly BasisItem[]): ContentHash {
  return hashDoc(DomainTag.achievementEvidenceCommitment, SchemaRef.achievementEvidenceCommitment, {
    basis: basis.map((b) => ({
      resultVersionId: b.resultVersionId,
      contentHash: b.contentHash,
      verificationRunId: b.verificationRunId,
      evidenceBundleHash: b.evidenceBundleHash,
      evidenceBundleAsOf: b.evidenceBundleAsOf,
    })),
  }).contentHash;
}

export function hashDerivationOutcome(outcome: unknown): ContentHash {
  return hashDoc(
    DomainTag.achievementDerivationOutcome,
    SchemaRef.achievementDerivationOutcome,
    outcome,
  ).contentHash;
}

export function comparisonSetHash(input: {
  athleteId: string;
  disciplineVersionId: string;
  markMetricId: string;
  items: readonly SnapshotComparison[];
}): ContentHash {
  return hashDoc(DomainTag.achievementComparisonSet, SchemaRef.achievementComparisonSet, {
    athleteId: input.athleteId,
    disciplineVersionId: input.disciplineVersionId,
    markMetricId: input.markMetricId,
    items: input.items.map((c) => ({
      resultVersionId: c.resultVersionId,
      contentHash: c.contentHash,
      participantId: c.participantId,
      ordinal: c.ordinal,
      value: c.mark.value,
      precision: c.mark.precision,
      verificationRunId: c.verification.runId ?? '',
    })),
  }).contentHash;
}

const dedupe = (xs: readonly string[]) => [...new Set(xs)].sort();

interface Resolved {
  readonly holderType: HolderType;
  readonly holderId: string;
  readonly memberCreditBasis: MemberCreditBasis;
  readonly memberCredits: readonly string[];
  readonly lineupHash?: string;
}

/** Derives the candidates (and the full explanation) for one snapshot. Pure and deterministic. */
export function deriveAchievements(input: unknown): Derivation {
  const { snapshot: s, snapshotHash } = sealDerivationSnapshot(input);
  // The embedded rule must be exactly the spec its hash names (tamper evidence) and target us.
  const v = validateAchievementRuleSpec(s.rule.spec);
  if (!v.ok || v.specHash !== s.rule.specHash)
    throw integrity('RULE_HASH_MISMATCH', 'rule spec does not match its hash or is invalid');
  if (v.spec.targetEngine !== ACHIEVEMENT_ENGINE_VERSION)
    throw integrity('ENGINE_VERSION_UNSUPPORTED', 'rule targets another engine version');
  const spec: AchievementRuleSpec = v.spec;
  const supported = new Set(s.supportedFactKinds);
  const req = effectiveRequirements(spec);
  const rv = s.resultVersion;

  // ─────────────── issuance gates ───────────────
  const gates: Gate[] = [];
  const gate = (name: GateName, fail: string[]) =>
    gates.push(
      fail.length === 0
        ? { gate: name, status: 'PASS' }
        : { gate: name, status: 'FAIL', reasons: fail },
    );

  const applicability: string[] = [];
  if (spec.disciplineVersionId !== s.discipline.disciplineVersionId)
    applicability.push('RULE_DISCIPLINE_VERSION_MISMATCH');
  if (spec.criterion.resultScope !== rv.scopeType) applicability.push('RESULT_SCOPE_MISMATCH');
  gate('RULE_APPLICABILITY', applicability);

  const status: string[] = [];
  if (!supported.has('RESULT_STATUS')) status.push('RESULT_STATUS_UNAVAILABLE');
  else if (rv.supersededByVersionId !== undefined || rv.status === 'SUPERSEDED')
    status.push('RESULT_SUPERSEDED');
  else if (rv.status === 'REVOKED') status.push('RESULT_REVOKED');
  else if (rv.status === 'REJECTED') status.push('RESULT_REJECTED');
  else if (!resultStatusSatisfies(rv.status, req.status))
    status.push('RESULT_STATUS_BELOW_REQUIRED');
  gate('RESULT_STATUS', status);

  const ver: string[] = [];
  const vs = s.verification;
  if (!supported.has('VERIFICATION')) ver.push('VERIFICATION_UNAVAILABLE');
  else if (vs.state === 'STALE') ver.push('VERIFICATION_STALE');
  else if (vs.state === 'NOT_EVALUATED') ver.push('VERIFICATION_NOT_EVALUATED');
  else if (vs.state === 'POLICY_UNAVAILABLE') ver.push('VERIFICATION_POLICY_UNAVAILABLE');
  else if (
    vs.runId === undefined ||
    vs.snapshotHash === undefined ||
    vs.outcomeHash === undefined ||
    vs.level === undefined ||
    vs.evidenceBundleHash === undefined ||
    vs.evaluatedAsOf === undefined
  )
    ver.push('VERIFICATION_RUN_INCOMPLETE');
  else if (verificationLevelIndex(vs.level) < verificationLevelIndex(req.level))
    ver.push('VERIFICATION_LEVEL_BELOW_REQUIRED');
  gate('VERIFICATION', ver);

  // BRT-01 §7: an admitted hold blocks new issuance. Absence of hold facts is never "no hold".
  const hold: string[] = [];
  if (!supported.has('HOLD_STATE') || s.hold === undefined) hold.push('HOLD_STATE_UNAVAILABLE');
  else if (s.hold.active) hold.push('HOLD_ACTIVE');
  gate('HOLD_STATE', hold);

  // AC-4: a structural recognition claim must be CONTAINED (BRT-03 scope algebra — level, sport,
  // discipline, region) in the recognition scope of the governing anchor pinned from the basis run,
  // and a sanction must be at least the claimed level. Never PLATFORM; unknown scope fails closed.
  const claim = spec.criterion.recognitionClaim;
  if (claim !== undefined) {
    const g = vs.governingRecognition;
    const rec: string[] = [];
    if (g === undefined) rec.push('GOVERNING_RECOGNITION_UNAVAILABLE');
    else if (g.recognitionLevel === 'PLATFORM') rec.push('RECOGNITION_PLATFORM_CANNOT_BACK_CLAIM');
    else if (g.recognitionScope === undefined) rec.push('GOVERNING_RECOGNITION_SCOPE_UNKNOWN');
    else if (s.discipline.sport === undefined || s.discipline.discipline === undefined)
      rec.push('CLAIM_SPORT_SCOPE_UNKNOWN');
    else {
      const requested: AuthorityScope = {
        recognitionLevel: [claim.level],
        sport: [s.discipline.sport],
        discipline: [s.discipline.discipline],
        ...(claim.region === undefined ? {} : { region: [...claim.region] }),
      } as AuthorityScope;
      const allowed = g.recognitionScope as unknown as AuthorityScope;
      if (!scopeContains(allowed, requested))
        for (const d of wideningDimensions(allowed, requested))
          rec.push(
            `RECOGNITION_${d === 'recognitionLevel' ? 'LEVEL' : d.toUpperCase()}_NOT_COVERED`,
          );
      if (
        g.source === 'SANCTION' &&
        (RECOGNITION_RANK[g.recognitionLevel] ?? 0) < (RECOGNITION_RANK[claim.level] ?? 99)
      )
        rec.push('RECOGNITION_BELOW_CLAIMED_SCOPE');
    }
    gate('GOVERNING_RECOGNITION', rec);
  }

  if (spec.criterion.kind === 'PERSONAL_BEST') {
    const occ: string[] = [];
    if (!supported.has('CONTEST_OCCURRENCE') || s.occurrence === undefined)
      occ.push('OCCURRENCE_TIME_UNKNOWN');
    gate('OCCURRENCE', occ);
  }

  // ─────────────── holder resolution ───────────────
  const participants = new Map(s.participants.map((p) => [p.participantId, p]));
  const lineups = supported.has('CREDITED_LINEUP')
    ? new Map((s.creditedLineups ?? []).map((l) => [l.participantId, l.athleteIds]))
    : undefined;
  const teamHolder = (participantId: string, teamId: string): Resolved => {
    const lineup = lineups?.get(participantId);
    if (lineup === undefined)
      return {
        holderType: 'TEAM',
        holderId: teamId,
        memberCreditBasis: 'CREDITED_LINEUP_UNAVAILABLE',
        memberCredits: [],
      };
    const athletes = dedupe(lineup);
    return {
      holderType: 'TEAM',
      holderId: teamId,
      memberCreditBasis: 'CREDITED_LINEUP',
      memberCredits: athletes,
      lineupHash: creditedLineupHash(rv.resultVersionId, participantId, athletes),
    };
  };
  const resolveEntrant = (participantId: string): Resolved | string => {
    const p = participants.get(participantId);
    if (p === undefined) return 'PARTICIPANT_UNKNOWN';
    if (p.kind === 'INDIVIDUAL')
      return p.athleteId === undefined
        ? 'HOLDER_UNRESOLVED'
        : {
            holderType: 'ATHLETE',
            holderId: p.athleteId,
            memberCreditBasis: 'NOT_APPLICABLE',
            memberCredits: [],
          };
    return p.teamId === undefined ? 'HOLDER_UNRESOLVED' : teamHolder(participantId, p.teamId);
  };
  const resolvePerformer = (perf: SnapshotPerformance): Resolved | string => {
    const p = participants.get(perf.participantId);
    if (p === undefined) return 'PARTICIPANT_UNKNOWN';
    if (p.kind === 'INDIVIDUAL') {
      if (p.athleteId === undefined) return 'HOLDER_UNRESOLVED';
      if (perf.athleteId !== undefined && perf.athleteId !== p.athleteId)
        return 'PERFORMANCE_ATHLETE_MISMATCH';
      return {
        holderType: 'ATHLETE',
        holderId: p.athleteId,
        memberCreditBasis: 'NOT_APPLICABLE',
        memberCredits: [],
      };
    }
    if (p.teamId === undefined) return 'HOLDER_UNRESOLVED';
    if (perf.athleteId === undefined) return teamHolder(perf.participantId, p.teamId);
    // An athlete's own performance inside a team entry: credit only through the exact credited lineup.
    const lineup = lineups?.get(perf.participantId);
    if (lineup === undefined) return 'CREDITED_LINEUP_UNAVAILABLE';
    if (!lineup.includes(perf.athleteId)) return 'PERFORMANCE_ATHLETE_NOT_CREDITED';
    return {
      holderType: 'ATHLETE',
      holderId: perf.athleteId,
      memberCreditBasis: 'NOT_APPLICABLE',
      memberCredits: [],
    };
  };

  // ─────────────── sporting evaluation (independent of the gates) ───────────────
  const c = spec.criterion;
  const subjects: SubjectEvaluation[] = [];
  const qualifying: {
    participantId: string;
    perf?: SnapshotPerformance;
    holder: Resolved;
    comparisonSetHash?: string;
  }[] = [];
  const consider = (
    participantId: string,
    perf: SnapshotPerformance | undefined,
    sporting: string[],
    holder: Resolved | string,
    extra: { comparisonSetHash?: string } = {},
  ) => {
    const reasons = [...sporting, ...(typeof holder === 'string' ? [holder] : [])];
    if (typeof holder !== 'string' && holder.memberCreditBasis === 'CREDITED_LINEUP_UNAVAILABLE')
      reasons.push('MEMBER_CREDITS_UNAVAILABLE');
    const qualifies = sporting.length === 0 && typeof holder !== 'string';
    subjects.push({
      subjectKey: perf === undefined ? participantId : `${participantId}#${perf.ordinal}`,
      participantId,
      ...(perf === undefined ? {} : { performanceOrdinal: perf.ordinal }),
      qualifies,
      ...(reasons.length === 0 ? {} : { reasons: dedupe(reasons) }),
    });
    if (qualifies)
      qualifying.push({
        participantId,
        ...(perf === undefined ? {} : { perf }),
        holder: holder as Resolved,
        ...extra,
      });
  };

  const metric =
    c.metric === undefined ? undefined : s.discipline.metrics.find((m) => m.key === c.metric?.key);
  const metricReasons = (perf: SnapshotPerformance): string[] => {
    const r: string[] = [];
    if (metric === undefined) return ['METRIC_UNKNOWN'];
    if (perf.mark.unit !== metric.unit) r.push('METRIC_UNIT_MISMATCH');
    if (!precisionFits(metric.valueType, perf.mark.precision)) r.push('METRIC_PRECISION_MISMATCH');
    if (metric.valueType === 'DURATION_MS' && perf.mark.value.startsWith('-'))
      r.push('METRIC_VALUE_OUT_OF_DOMAIN');
    if (!perf.valid) r.push('PERFORMANCE_INVALID');
    return r;
  };
  const metricPerformances = (s.performances ?? []).filter(
    (p) => c.metric !== undefined && p.mark.metricId === c.metric.markMetricId,
  );

  switch (c.kind) {
    case 'CLASSIFICATION_POSITION':
      for (const e of s.entries) {
        const r: string[] = [];
        if (e.rank === undefined) r.push('RANK_MISSING');
        else if (c.rank === undefined || e.rank < c.rank.min || e.rank > c.rank.max)
          r.push('RANK_NOT_IN_RANGE');
        if (['DNS', 'DNF', 'DQ', 'NO_CONTEST'].includes(e.outcome)) r.push('OUTCOME_EXCLUDED');
        consider(e.participantId, undefined, r, resolveEntrant(e.participantId));
      }
      break;
    case 'CLASSIFICATION_COMPLETION':
      for (const e of s.entries)
        consider(
          e.participantId,
          undefined,
          e.outcome === 'DNS' ? ['OUTCOME_DNS'] : [],
          resolveEntrant(e.participantId),
        );
      break;
    case 'CONTEST_OUTCOME':
      for (const e of s.entries)
        consider(
          e.participantId,
          undefined,
          (c.outcomes ?? []).includes(e.outcome as 'WIN') ? [] : ['OUTCOME_NOT_MET'],
          resolveEntrant(e.participantId),
        );
      break;
    case 'PERFORMANCE_THRESHOLD':
      for (const perf of metricPerformances) {
        const r = metricReasons(perf);
        if (
          r.length === 0 &&
          !satisfiesThreshold(perf.mark.value, c.operator ?? 'EQ', c.threshold ?? '0')
        )
          r.push('THRESHOLD_NOT_MET');
        consider(perf.participantId, perf, r, resolvePerformer(perf));
      }
      break;
    case 'PERSONAL_BEST':
      evaluatePersonalBest();
      break;
  }

  function evaluatePersonalBest() {
    const order = metric?.order;
    // Only the best performance of one athlete within this exact version can be its PB (ties within
    // the version: the lowest ordinal, deterministically).
    const bestByAthlete = new Map<string, SnapshotPerformance>();
    const resolved = new Map<SnapshotPerformance, Resolved | string>();
    for (const perf of metricPerformances) {
      const h = resolvePerformer(perf);
      resolved.set(perf, h);
      if (typeof h === 'string' || h.holderType !== 'ATHLETE' || metricReasons(perf).length > 0)
        continue;
      const cur = bestByAthlete.get(h.holderId);
      if (
        cur === undefined ||
        (order !== undefined && strictlyBetter(perf.mark.value, cur.mark.value, order))
      )
        bestByAthlete.set(h.holderId, perf);
    }
    for (const perf of metricPerformances) {
      const h = resolved.get(perf) ?? 'HOLDER_UNRESOLVED';
      const r = metricReasons(perf);
      if (order === undefined) r.push('PB_METRIC_ORDER_UNDEFINED');
      if (typeof h !== 'string' && h.holderType !== 'ATHLETE') {
        consider(perf.participantId, perf, [...r, 'PB_REQUIRES_ATHLETE_HOLDER'], h);
        continue;
      }
      if (typeof h === 'string' || r.length > 0 || order === undefined) {
        consider(perf.participantId, perf, r, h);
        continue;
      }
      if (bestByAthlete.get(h.holderId) !== perf) {
        consider(perf.participantId, perf, ['PB_NOT_BEST_IN_VERSION'], h);
        continue;
      }
      const startedAt = s.occurrence?.startedAt;
      const eligible = (s.comparisons ?? []).filter(
        (x) =>
          x.athleteId === h.holderId &&
          x.resultVersionId !== rv.resultVersionId &&
          x.disciplineVersionId === s.discipline.disciplineVersionId &&
          x.mark.metricId === c.metric?.markMetricId &&
          x.mark.unit === metric?.unit &&
          x.valid &&
          x.occurredAt !== undefined &&
          startedAt !== undefined &&
          x.occurredAt < startedAt &&
          resultStatusSatisfies(x.status, req.status) &&
          x.verification.state === 'CURRENT' &&
          x.verification.level !== undefined &&
          x.verification.runId !== undefined &&
          verificationLevelIndex(x.verification.level) >= verificationLevelIndex(req.level),
      );
      const setHash = comparisonSetHash({
        athleteId: h.holderId,
        disciplineVersionId: s.discipline.disciplineVersionId,
        markMetricId: c.metric?.markMetricId ?? '',
        items: eligible,
      });
      let best: SnapshotComparison | undefined;
      for (const x of eligible)
        if (best === undefined || strictlyBetter(x.mark.value, best.mark.value, order)) best = x;
      const pb: string[] = [];
      if (startedAt === undefined) pb.push('OCCURRENCE_TIME_UNKNOWN');
      else if (best === undefined) {
        if (c.firstEligibleEstablishesBest !== true) pb.push('PB_FIRST_DOES_NOT_ESTABLISH');
      } else if (!strictlyBetter(perf.mark.value, best.mark.value, order))
        pb.push(
          strictlyBetter(best.mark.value, perf.mark.value, order)
            ? 'PB_NOT_IMPROVED'
            : 'PB_EQUALS_CURRENT_BEST',
        );
      consider(perf.participantId, perf, pb, h, { comparisonSetHash: setHash });
    }
  }

  // ─────────────── candidates (only when every gate passes) ───────────────
  const allPass = gates.every((g) => g.status === 'PASS');
  const scope = scopeOf(s, spec);
  const candidates: CandidateEntry[] = [];
  if (
    allPass &&
    vs.runId !== undefined &&
    vs.snapshotHash !== undefined &&
    vs.outcomeHash !== undefined &&
    vs.level !== undefined &&
    vs.evidenceBundleHash !== undefined &&
    vs.evaluatedAsOf !== undefined
  ) {
    for (const q of qualifying) {
      const basis: BasisItem = {
        resultVersionId: rv.resultVersionId,
        contentHash: rv.contentHash,
        resultStatus: rv.status,
        verificationRunId: vs.runId,
        verificationSnapshotHash: vs.snapshotHash,
        verificationOutcomeHash: vs.outcomeHash,
        verificationLevel: vs.level,
        participantId: q.participantId,
        ...(q.perf === undefined ? {} : { performanceOrdinal: q.perf.ordinal }),
        ...(q.holder.lineupHash === undefined ? {} : { creditedLineupHash: q.holder.lineupHash }),
        evidenceBundleHash: vs.evidenceBundleHash,
        evidenceBundleAsOf: vs.evaluatedAsOf,
      };
      const valueAchievement = c.kind === 'PERFORMANCE_THRESHOLD' || c.kind === 'PERSONAL_BEST';
      const candidate: AchievementCandidate = {
        provenance: s.provenance,
        engineVersion: ACHIEVEMENT_ENGINE_VERSION,
        achievementType: spec.achievementType,
        rule: {
          ruleId: s.rule.ruleId,
          ruleVersionId: s.rule.ruleVersionId,
          code: s.rule.code,
          version: s.rule.version,
          specHash: s.rule.specHash,
        },
        holder: { holderType: q.holder.holderType, holderId: q.holder.holderId },
        memberCreditBasis: q.holder.memberCreditBasis,
        ...(q.holder.memberCredits.length === 0
          ? {}
          : {
              memberCredits: q.holder.memberCredits.map((athleteId) => ({
                athleteId,
                creditRole: 'LINEUP_MEMBER' as const,
              })),
            }),
        scope:
          spec.criterion.kind === 'PERSONAL_BEST'
            ? { scopeType: 'CAREER', scopeId: s.discipline.disciplineVersionId }
            : scope,
        context: {
          competitionId: s.hierarchy.competitionId,
          ...(s.hierarchy.eventId === undefined ? {} : { eventId: s.hierarchy.eventId }),
          ...(s.hierarchy.contestId === undefined ? {} : { contestId: s.hierarchy.contestId }),
          disciplineVersionId: s.discipline.disciplineVersionId,
          ...(s.discipline.sport === undefined ? {} : { sport: s.discipline.sport }),
          ...(s.discipline.discipline === undefined ? {} : { discipline: s.discipline.discipline }),
        },
        basis: [basis],
        basisLevel: vs.level,
        // qualifyingValue only for value achievements, and exactly the referenced Performance mark.
        ...(valueAchievement && q.perf !== undefined ? { qualifyingValue: q.perf.mark } : {}),
        ...(q.comparisonSetHash === undefined ? {} : { comparisonSetHash: q.comparisonSetHash }),
        evidenceCommitment: evidenceCommitmentOf([basis]),
        ...(vs.governingRecognition === undefined
          ? {}
          : { governingAuthority: vs.governingRecognition }),
      };
      const h = hashDoc(DomainTag.achievementCandidate, SchemaRef.achievementCandidate, candidate);
      const normalized = h.normalized as unknown as AchievementCandidate;
      candidates.push({
        candidateHash: h.contentHash,
        identityHash: identityOf(normalized).identityHash,
        candidate: normalized,
      });
    }
  }

  const outcome: DerivationOutcome = {
    engineVersion: ACHIEVEMENT_ENGINE_VERSION,
    snapshotHash,
    provenance: s.provenance,
    ruleVersionId: s.rule.ruleVersionId,
    resultVersionId: rv.resultVersionId,
    state: !allPass ? 'BLOCKED' : candidates.length > 0 ? 'ISSUABLE' : 'NO_QUALIFYING_FACTS',
    gates,
    subjects,
    candidates,
  };
  const o = hashDoc(
    DomainTag.achievementDerivationOutcome,
    SchemaRef.achievementDerivationOutcome,
    outcome,
  );
  return {
    snapshotHash,
    outcome: o.normalized as unknown as DerivationOutcome,
    outcomeHash: o.contentHash,
  };
}

function scopeOf(
  s: AchievementDerivationSnapshot,
  spec: AchievementRuleSpec,
): AchievementCandidate['scope'] {
  const t = s.resultVersion.scopeTargetId;
  switch (spec.criterion.resultScope) {
    case 'CONTEST':
      return { scopeType: 'CONTEST', scopeId: t };
    case 'ROUND_CLASSIFICATION':
      return { scopeType: 'ROUND', scopeId: t };
    case 'EVENT_CLASSIFICATION':
      return { scopeType: 'EVENT', scopeId: t };
    case 'COMPETITION_CLASSIFICATION':
      return { scopeType: 'COMPETITION', scopeId: t };
  }
}

/** The blocking reasons of a derivation, flattened (for audit / public explanations). */
export function blockingReasons(outcome: DerivationOutcome): string[] {
  return dedupe(outcome.gates.flatMap((g) => (g.status === 'FAIL' ? (g.reasons ?? []) : [])));
}
