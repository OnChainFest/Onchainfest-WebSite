import type { ContentHash } from '@br/canonical';
import {
  PRODUCTION_SUPPORTED_DERIVATION_FACT_KINDS,
  verificationLevelIndex,
  type HolderType,
  type QualificationBasisKind,
  type VerificationLevel,
} from '@br/domain';
import { DomainTag, SchemaRef } from '@br/schemas';
import {
  evidenceCommitmentOf,
  hashAchievementDocument,
  identityOf,
  integrityFailure,
  type AchievementCandidate,
  type BasisItem,
  type CandidateEntry,
  type Derivation,
  type DerivationOutcome,
  type Gate,
  type GateName,
  type SubjectEvaluation,
} from './engine';
import { effectiveRequirements, type AchievementRuleSpec } from './rule';
import type {
  QualificationDerivationSnapshot,
  SnapshotRankingBasisPin,
  VerificationSummary,
} from './snapshot';

/**
 * BRT-10 QUALIFIED derivation (achievement-engine/3, ADR-0050). Pure and deterministic, like every
 * other criterion; it CONSUMES the canonical published ranking snapshot or FINAL classification —
 * it never re-ranks, never re-classifies and never reinterprets a comparator. Shared ranks are the
 * source's canonical ranks (ADR-0049): every holder whose rank is ≤ N qualifies.
 *
 * Gates (issuance; any FAIL ⇒ BLOCKED, no candidate):
 *   RULE_APPLICABILITY  rule DisciplineVersion / result scope vs the source
 *   QUALIFYING_SOURCE   the rule's exact pinned source; published; not corrected; not stale
 *   RESULT_STATUS       FINAL (classification); ranking bases are FINAL + current via staleness
 *   VERIFICATION        CURRENT run ≥ the rule level (classification); per holder for rankings
 *   HOLD_STATE          known and absent (never inferred)
 *   TARGET_AUTHORITY    the target competition authority's adoption of this exact rule version
 * Subjects (sporting): rank present, rank ≤ N, every pinned basis level ≥ the rule level (rankings).
 * The resulting Achievement causes no side effect: it registers, enters, seeds and awards nothing.
 */
export interface QualificationPin {
  readonly kind: QualificationBasisKind;
  readonly targetCompetitionId: string;
  readonly qualifyingRanks: number;
  readonly ranking?: {
    readonly systemId: string;
    readonly systemVersionId: string;
    readonly snapshotId: string;
    readonly snapshotHash: string;
    readonly rank: number;
    readonly tied: boolean;
  };
  readonly classification?: {
    readonly resultId: string;
    readonly resultVersionId: string;
    readonly contentHash: string;
    readonly scopeType: 'EVENT_CLASSIFICATION' | 'COMPETITION_CLASSIFICATION';
    readonly policyVersionId: string;
    readonly participantId: string;
    readonly rank: number;
    readonly tied: boolean;
  };
  /** H(qualification-basis, br:qualification-basis@1): position + underlying FINAL basis + runs. */
  readonly basisHash: string;
  readonly targetAuthority: { readonly adoptionId: string; readonly adoptionHash: string };
}

/** The `br:qualification-basis@1` document of one candidate (hashed into `basisHash`). */
export function qualificationBasisDocument(
  candidate: Pick<AchievementCandidate, 'holder' | 'basis'>,
  pin: Omit<QualificationPin, 'basisHash' | 'targetAuthority'>,
): unknown {
  return {
    kind: pin.kind,
    targetCompetitionId: pin.targetCompetitionId,
    qualifyingRanks: pin.qualifyingRanks,
    holder: candidate.holder,
    ...(pin.ranking === undefined ? {} : { ranking: pin.ranking }),
    ...(pin.classification === undefined
      ? {}
      : {
          classification: {
            resultId: pin.classification.resultId,
            resultVersionId: pin.classification.resultVersionId,
            contentHash: pin.classification.contentHash,
            scopeType: pin.classification.scopeType,
            status: 'FINAL',
            participantId: pin.classification.participantId,
            rank: pin.classification.rank,
            tied: pin.classification.tied,
          },
        }),
    underlying: candidate.basis.map((b) => ({
      resultVersionId: b.resultVersionId,
      contentHash: b.contentHash,
      resultStatus: b.resultStatus,
      verificationRunId: b.verificationRunId,
      verificationOutcomeHash: b.verificationOutcomeHash,
      verificationLevel: b.verificationLevel,
    })),
  };
}

export function qualificationBasisHash(
  candidate: Pick<AchievementCandidate, 'holder' | 'basis'>,
  pin: Omit<QualificationPin, 'basisHash' | 'targetAuthority'>,
): ContentHash {
  return hashAchievementDocument(
    DomainTag.qualificationBasis,
    SchemaRef.qualificationBasis,
    qualificationBasisDocument(candidate, pin),
  ).contentHash;
}

const dedupe = (xs: readonly string[]) => [...new Set(xs)].sort();
const MAX_BASIS_ITEMS = 16;

function verificationReasons(
  supported: ReadonlySet<string>,
  vs: VerificationSummary,
  level: VerificationLevel,
): string[] {
  if (!supported.has('VERIFICATION')) return ['VERIFICATION_UNAVAILABLE'];
  if (vs.state === 'STALE') return ['VERIFICATION_STALE'];
  if (vs.state === 'NOT_EVALUATED') return ['VERIFICATION_NOT_EVALUATED'];
  if (vs.state === 'POLICY_UNAVAILABLE') return ['VERIFICATION_POLICY_UNAVAILABLE'];
  if (
    vs.runId === undefined ||
    vs.snapshotHash === undefined ||
    vs.outcomeHash === undefined ||
    vs.level === undefined ||
    vs.evidenceBundleHash === undefined ||
    vs.evaluatedAsOf === undefined
  )
    return ['VERIFICATION_RUN_INCOMPLETE'];
  if (verificationLevelIndex(vs.level) < verificationLevelIndex(level))
    return ['VERIFICATION_LEVEL_BELOW_REQUIRED'];
  return [];
}

const minLevel = (levels: readonly VerificationLevel[]): VerificationLevel =>
  levels.reduce((a, b) => (verificationLevelIndex(b) < verificationLevelIndex(a) ? b : a));

/** One basis item per (ResultVersion, participant) of a ranked holder (a pin names the version). */
function rankingBasisItems(pins: readonly SnapshotRankingBasisPin[]): BasisItem[] {
  const out = new Map<string, BasisItem>();
  for (const p of pins) {
    const key = `${p.resultVersionId}/${p.participantId}`;
    const prior = out.get(key);
    if (prior !== undefined && prior.verificationRunId !== p.verificationRunId)
      throw integrityFailure('QUALIFICATION_BASIS_INCOHERENT', 'one version pins two runs');
    out.set(key, {
      resultVersionId: p.resultVersionId,
      contentHash: p.contentHash,
      resultStatus: 'FINAL',
      verificationRunId: p.verificationRunId,
      verificationSnapshotHash: p.verificationSnapshotHash,
      verificationOutcomeHash: p.verificationOutcomeHash,
      verificationLevel: p.verificationLevel,
      participantId: p.participantId,
      evidenceBundleHash: p.evidenceBundleHash,
      evidenceBundleAsOf: p.evidenceBundleAsOf,
    });
  }
  return [...out.values()];
}

/** Derives the QUALIFIED candidates (and the full explanation) of one qualification snapshot. */
export function deriveQualified(
  s: QualificationDerivationSnapshot,
  snapshotHash: ContentHash,
  spec: AchievementRuleSpec,
): Derivation {
  const c = spec.criterion;
  const qc = c.qualification;
  if (c.kind !== 'QUALIFYING_POSITION' || qc === undefined)
    throw integrityFailure(
      'SNAPSHOT_RULE_MISMATCH',
      'a qualification snapshot needs a QUALIFIED rule',
    );
  const engineVersion = spec.targetEngine;
  const q = s.qualification;
  const req = effectiveRequirements(spec);
  // Defence in depth: a canonical snapshot can only declare the kinds today's producers emit.
  const supported = new Set(
    s.provenance === 'CANONICAL_ASSEMBLY'
      ? s.supportedFactKinds.filter((k) => PRODUCTION_SUPPORTED_DERIVATION_FACT_KINDS.includes(k))
      : s.supportedFactKinds,
  );
  const wantsRanking = qc.source.kind === 'RANKING_SNAPSHOT_POSITION';
  const r = wantsRanking ? q.ranking : undefined;
  const cl = wantsRanking ? undefined : q.classification;

  const gates: Gate[] = [];
  const gate = (name: GateName, fail: string[]) =>
    gates.push(
      fail.length === 0
        ? { gate: name, status: 'PASS' }
        : { gate: name, status: 'FAIL', reasons: dedupe(fail) },
    );

  const applicability: string[] = [];
  if (spec.disciplineVersionId !== s.discipline.disciplineVersionId)
    applicability.push('RULE_DISCIPLINE_VERSION_MISMATCH');
  if (cl !== undefined) {
    if (cl.disciplineVersionId !== s.discipline.disciplineVersionId)
      applicability.push('RULE_DISCIPLINE_VERSION_MISMATCH');
    if (cl.scopeType !== c.resultScope) applicability.push('RESULT_SCOPE_MISMATCH');
  }
  gate('RULE_APPLICABILITY', applicability);

  // The rule's EXACT pinned source: never another system version, scope or policy version, never an
  // unpublished run, never a corrected or stale snapshot / classification.
  const source: string[] = [];
  if (wantsRanking) {
    if (r === undefined)
      source.push(
        q.classification !== undefined
          ? 'QUALIFYING_SOURCE_MISMATCH'
          : 'RANKING_SNAPSHOT_NOT_PUBLISHED',
      );
    else {
      if (
        r.systemId !== qc.source.rankingSystemId ||
        r.systemVersionId !== qc.source.rankingSystemVersionId
      )
        source.push('QUALIFYING_SOURCE_MISMATCH');
      if (r.published === undefined) source.push('RANKING_SNAPSHOT_NOT_PUBLISHED');
      if (r.correctedBySnapshotId !== undefined) source.push('RANKING_SNAPSHOT_CORRECTED');
      if (r.staleness.state === 'STALE')
        source.push('RANKING_SNAPSHOT_STALE', ...(r.staleness.reasons ?? []));
    }
  } else if (cl === undefined)
    source.push(
      q.ranking !== undefined
        ? 'QUALIFYING_SOURCE_MISMATCH'
        : 'CLASSIFICATION_PROVENANCE_UNAVAILABLE',
    );
  else {
    if (
      cl.scopeType !== qc.source.scopeType ||
      cl.scopeTargetId !== qc.source.scopeId ||
      cl.policyVersionId !== qc.source.policyVersionId
    )
      source.push('QUALIFYING_SOURCE_MISMATCH');
    if (cl.staleness.state === 'STALE') source.push(...(cl.staleness.reasons ?? []));
  }
  gate('QUALIFYING_SOURCE', source);

  const status: string[] = [];
  if (!supported.has('RESULT_STATUS')) status.push('RESULT_STATUS_UNAVAILABLE');
  else if (cl !== undefined) {
    if (cl.supersededByVersionId !== undefined || cl.status === 'SUPERSEDED')
      status.push('RESULT_SUPERSEDED');
    else if (cl.status === 'REVOKED') status.push('RESULT_REVOKED');
    else if (cl.status === 'REJECTED') status.push('RESULT_REJECTED');
    else if (cl.status !== 'FINAL') status.push('RESULT_STATUS_BELOW_REQUIRED');
  }
  gate('RESULT_STATUS', status);

  // Rankings: every pinned run's currency is the snapshot's staleness; its level is per holder.
  gate(
    'VERIFICATION',
    cl !== undefined
      ? verificationReasons(supported, cl.verification, req.level)
      : supported.has('VERIFICATION')
        ? []
        : ['VERIFICATION_UNAVAILABLE'],
  );

  // BRT-01 §7: hold blocks; absence of hold facts is never "no hold".
  const hold: string[] = [];
  if (!supported.has('HOLD_STATE') || q.hold === undefined) hold.push('HOLD_STATE_UNAVAILABLE');
  else if (q.hold.active) hold.push('HOLD_ACTIVE');
  gate('HOLD_STATE', hold);

  // ADR-0050 §4: the platform never decides another authority's qualification.
  const authority: string[] = [];
  const ta = q.targetAuthority;
  if (!supported.has('TARGET_QUALIFICATION_AUTHORITY') || ta === undefined)
    authority.push('TARGET_QUALIFICATION_AUTHORITY_UNAVAILABLE');
  else {
    if (ta.targetCompetitionId !== qc.targetCompetitionId)
      authority.push('TARGET_QUALIFICATION_AUTHORITY_OUT_OF_SCOPE');
    if (
      ta.status !== 'ADOPTED' ||
      ta.ruleVersionId !== s.rule.ruleVersionId ||
      ta.ruleSpecHash !== s.rule.specHash
    )
      authority.push('TARGET_QUALIFICATION_AUTHORITY_INVALID');
  }
  gate('TARGET_AUTHORITY', authority);

  // ─────────────── sporting evaluation (independent of the gates) ───────────────
  const N = qc.qualifyingRanks;
  const subjects: SubjectEvaluation[] = [];
  interface Qualifying {
    readonly holder: { holderType: HolderType; holderId: string };
    readonly basis: BasisItem[];
    readonly rank: number;
    readonly tied: boolean;
    readonly participantId: string;
  }
  const qualifying: Qualifying[] = [];
  const subject = (participantId: string, key: string, reasons: string[]) => {
    subjects.push({
      subjectKey: key,
      participantId,
      qualifies: reasons.length === 0,
      ...(reasons.length === 0 ? {} : { reasons: dedupe(reasons) }),
    });
    return reasons.length === 0;
  };

  if (r !== undefined)
    for (const e of r.entries) {
      const reasons: string[] = [];
      if (e.rank > N) reasons.push('POSITION_OUTSIDE_QUALIFYING_RANKS');
      if (
        e.basis.some(
          (b) => verificationLevelIndex(b.verificationLevel) < verificationLevelIndex(req.level),
        )
      )
        reasons.push('VERIFICATION_LEVEL_BELOW_REQUIRED');
      const participantId = e.basis[0]?.participantId ?? e.holder.holderId;
      if (subject(participantId, e.holder.holderId, reasons)) {
        const basis = rankingBasisItems(e.basis);
        if (basis.length > MAX_BASIS_ITEMS)
          throw integrityFailure('QUALIFICATION_BASIS_TOO_LARGE', 'too many qualifying bases');
        qualifying.push({ holder: e.holder, basis, rank: e.rank, tied: e.tied, participantId });
      }
    }
  if (cl !== undefined) {
    const participants = new Map(cl.participants.map((p) => [p.participantId, p]));
    const vs = cl.verification;
    for (const e of cl.entries) {
      const reasons: string[] = [];
      if (e.rank === undefined) reasons.push('RANK_MISSING');
      else if (e.rank > N) reasons.push('POSITION_OUTSIDE_QUALIFYING_RANKS');
      const p = participants.get(e.participantId);
      const holder =
        p === undefined
          ? 'PARTICIPANT_UNKNOWN'
          : p.kind === 'INDIVIDUAL'
            ? p.athleteId === undefined
              ? 'HOLDER_UNRESOLVED'
              : { holderType: 'ATHLETE' as const, holderId: p.athleteId }
            : p.teamId === undefined
              ? 'HOLDER_UNRESOLVED'
              : { holderType: 'TEAM' as const, holderId: p.teamId };
      if (typeof holder === 'string') reasons.push(holder);
      if (
        subject(e.participantId, e.participantId, reasons) &&
        typeof holder !== 'string' &&
        e.rank !== undefined &&
        vs.runId !== undefined &&
        vs.snapshotHash !== undefined &&
        vs.outcomeHash !== undefined &&
        vs.level !== undefined &&
        vs.evidenceBundleHash !== undefined &&
        vs.evaluatedAsOf !== undefined
      )
        qualifying.push({
          holder,
          rank: e.rank,
          tied: e.tied,
          participantId: e.participantId,
          basis: [
            {
              resultVersionId: cl.resultVersionId,
              contentHash: cl.contentHash,
              resultStatus: cl.status,
              verificationRunId: vs.runId,
              verificationSnapshotHash: vs.snapshotHash,
              verificationOutcomeHash: vs.outcomeHash,
              verificationLevel: vs.level,
              participantId: e.participantId,
              evidenceBundleHash: vs.evidenceBundleHash,
              evidenceBundleAsOf: vs.evaluatedAsOf,
            },
          ],
        });
    }
  }

  // ─────────────── candidates (only when every gate passes) ───────────────
  const allPass = gates.every((g) => g.status === 'PASS');
  const candidates: CandidateEntry[] = [];
  if (allPass && ta !== undefined)
    for (const x of qualifying) {
      const position: Omit<QualificationPin, 'basisHash' | 'targetAuthority'> = {
        kind: qc.source.kind,
        targetCompetitionId: qc.targetCompetitionId,
        qualifyingRanks: N,
        ...(r?.published === undefined
          ? {}
          : {
              ranking: {
                systemId: r.systemId,
                systemVersionId: r.systemVersionId,
                snapshotId: r.published.snapshotId,
                snapshotHash: r.published.snapshotHash,
                rank: x.rank,
                tied: x.tied,
              },
            }),
        ...(cl === undefined
          ? {}
          : {
              classification: {
                resultId: cl.resultId,
                resultVersionId: cl.resultVersionId,
                contentHash: cl.contentHash,
                scopeType: cl.scopeType,
                policyVersionId: cl.policyVersionId,
                participantId: x.participantId,
                rank: x.rank,
                tied: x.tied,
              },
            }),
      };
      const draft = { holder: x.holder, basis: x.basis };
      const governing = cl?.verification.governingRecognition;
      const candidate: AchievementCandidate = {
        provenance: s.provenance,
        engineVersion,
        achievementType: spec.achievementType,
        rule: {
          ruleId: s.rule.ruleId,
          ruleVersionId: s.rule.ruleVersionId,
          code: s.rule.code,
          version: s.rule.version,
          specHash: s.rule.specHash,
        },
        holder: x.holder,
        memberCreditBasis: 'NOT_APPLICABLE',
        scope: { scopeType: 'COMPETITION', scopeId: qc.targetCompetitionId },
        context: {
          competitionId: qc.targetCompetitionId,
          disciplineVersionId: s.discipline.disciplineVersionId,
          ...(s.discipline.sport === undefined ? {} : { sport: s.discipline.sport }),
          ...(s.discipline.discipline === undefined ? {} : { discipline: s.discipline.discipline }),
        },
        basis: x.basis,
        basisLevel: minLevel(x.basis.map((b) => b.verificationLevel)),
        evidenceCommitment: evidenceCommitmentOf(x.basis),
        ...(governing === undefined ? {} : { governingAuthority: governing }),
        qualification: {
          ...position,
          basisHash: qualificationBasisHash(draft, position),
          targetAuthority: { adoptionId: ta.adoptionId, adoptionHash: ta.adoptionHash },
        },
      };
      const h = hashAchievementDocument(
        DomainTag.achievementCandidate,
        SchemaRef.achievementCandidate,
        candidate,
      );
      const normalized = h.normalized as unknown as AchievementCandidate;
      // The basis hash commits to the normalized (set-ordered) basis: recompute on it.
      if (
        qualificationBasisHash(normalized, position) !== normalized.qualification?.basisHash ||
        evidenceCommitmentOf(normalized.basis) !== normalized.evidenceCommitment
      )
        throw integrityFailure('QUALIFICATION_BASIS_INCOHERENT', 'basis commitments differ');
      candidates.push({
        candidateHash: h.contentHash,
        identityHash: identityOf(normalized).identityHash,
        candidate: normalized,
      });
    }

  const sourceRef =
    r !== undefined
      ? r.published === undefined
        ? { kind: qc.source.kind, sourceId: r.runId, sourceHash: r.runOutcomeHash }
        : {
            kind: qc.source.kind,
            sourceId: r.published.snapshotId,
            sourceHash: r.published.snapshotHash,
          }
      : cl !== undefined
        ? { kind: qc.source.kind, sourceId: cl.resultVersionId, sourceHash: cl.contentHash }
        : undefined;
  const outcome: DerivationOutcome = {
    engineVersion,
    snapshotHash,
    provenance: s.provenance,
    ruleVersionId: s.rule.ruleVersionId,
    ...(cl === undefined ? {} : { resultVersionId: cl.resultVersionId }),
    ...(sourceRef === undefined ? {} : { source: sourceRef }),
    state: !allPass ? 'BLOCKED' : candidates.length > 0 ? 'ISSUABLE' : 'NO_QUALIFYING_FACTS',
    gates,
    subjects,
    candidates,
  };
  const o = hashAchievementDocument(
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
